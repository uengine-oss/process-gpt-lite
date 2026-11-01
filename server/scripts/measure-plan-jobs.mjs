// Measures what the jobs on the plan screen cost (lib/plans/jobs.json, read by lib/plans/equivalents.js): each
// job is asked in a new project conversation the way a person would (POST /api/threads, then its messages),
// as made-up people of the served tenant (one per run), on the model the server runs, through LiteLLM — so
// every call of the job, the agent's and the title's included, lands on that person's key. The job's cost is
// that key's LiteLLM spend inside the run; the file keeps the average of the runs. A run that ends in an error
// or without the thing asked for is dropped and asked again (its cost is not counted).
//
//   PRO_LLM_KEYS=litellm … node index.js                      (the server, real model)
//   API_URL=http://localhost:8790 node scripts/measure-plan-jobs.mjs [--runs 3] [--only draft,minutes] [--write] [--keep]
//     [--basis "…"]   how the model was priced, kept in jobs.json when the run was not on the model it is priced as
//
// A job is one message or, when the agent first proposes before it makes (a process: a consulting draft, then
// the definition), the messages a person sends to get the thing; a job is counted only when it made it
// (`expect`: the card kind its last answer must carry).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { q, pool } from '../lib/supa.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const API = `${process.env.API_URL || 'http://localhost:8790'}/api`
const RUNS = Number(arg('--runs', 3))
const ONLY = arg('--only', '')
// one made-up person per run (pro-plan-meter-1…): a big job three times can be more than one seat's 5-hour share
const EMAIL = (i) => `pro-plan-meter-${i + 1}@uengine.org`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const meeting = fs.readFileSync(path.join(here, 'fixtures', 'meeting-10min.ko.txt'), 'utf8')
export const JOBS = {
  draft: '다음 주 화요일부터 2박 3일 부산 고객사 방문 출장 품의서 초안을 써줘. KTX 왕복, 숙박 2박, 식비를 넣은 예상 경비를 표로 정리해줘.',
  minutes: `아래 회의 받아쓰기로 회의록을 써줘. 결정 사항, 할 일(담당자·기한), 다음 회의를 나눠서.\n\n${meeting}`,
  process: { say: ['구매 요청부터 견적 비교, 팀장 승인, 발주, 입고 확인, 대금 지급까지 구매 프로세스를 만들어줘.', '좋아요, 그대로 프로세스 정의로 만들어 주세요.', '네, 진행해 주세요. 프로세스 정의로 저장할 수 있게 만들어 주세요.'], expect: 'process_draft' },
  apology: '납품이 사흘 늦어진 고객사 달빛커피에 사과 메일을 써줘. 원인은 포장재 입고 지연이고, 새 납품일은 이번 주 금요일, 다음 주문 배송비는 우리가 부담해.',
}

async function login(email) {
  const r = await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  if (!r.ok) throw new Error(`login: ${r.status} ${await r.text()}`)
  const j = await r.json()
  const me = await (await call(j.session.access_token, 'GET', '/me')).json()
  return { token: j.session.access_token, id: me.user.id }
}
const call = (tok, method, p, body) => fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })

// one job: a new project conversation and its messages, each read to the end of its answer stream
async function run(me, job) {
  const say = typeof job === 'string' ? [job] : job.say
  const t = await call(me.token, 'POST', '/threads', { text: say[0] })
  if (!t.ok) throw new Error(`thread: ${t.status} ${await t.text()}`)
  const th = await t.json()
  for (const text of say) {
    // a later message only once the agent asks for one: a job that already made its card is done
    if (text !== say[0] && job.expect && (await q(`select 1 from pro_messages where thread_id=$1 and kind=$2`, [th.id, job.expect])).length) break
    const r = await call(me.token, 'POST', `/threads/${th.id}/messages`, { text })
    const body = await r.text()
    // a stream that ended in an error is not a job done (the run is dropped and asked again)
    if (/event: error/.test(body)) return { id: th.id, failed: body.match(/event: error\ndata: (.*)/)?.[1] || 'error' }
    // the agent may still be finishing a card after the stream ends; wait for the thread to go quiet
    for (let i = 0; i < 60; i++) {
      const [s] = await q('select status from pro_threads where id=$1', [th.id])
      if (!s?.status) break
      await sleep(2000)
    }
  }
  // what the job left in the conversation: the answer's length and the cards it made (a run that failed shows)
  const msgs = await q(`select kind, content from pro_messages where thread_id=$1 and role='agent' order by created_at`, [th.id])
  return { id: th.id, chars: msgs.reduce((a, m) => a + String(m.content?.text || '').length, 0), kinds: [...new Set(msgs.map((m) => m.kind))] }
}

// LiteLLM writes its spend log in batches a few seconds behind the calls
async function spendOf(userId, from, to) {
  const [r] = await q(`select count(*)::int calls, coalesce(sum(s.spend), 0)::float8 usd, coalesce(sum(s.prompt_tokens), 0)::int pt, coalesce(sum(s.completion_tokens), 0)::int ct,
      string_agg(distinct coalesce(s.model_group, s.model), ',') models
    from litellm."LiteLLM_SpendLogs" s join litellm."LiteLLM_VerificationToken" k on k.token = s.api_key
    where k.metadata->>'user' = $1 and s."startTime" at time zone 'utc' between $2::timestamptz and $3::timestamptz`, [userId, from, to])
  return r
}

const people = []
for (let i = 0; i < RUNS; i++) {
  const me = await login(EMAIL(i))
  // a run cut short earlier may have left its conversations (these people are only ever the measurers)
  const left = (await q(`select id from pro_threads where user_id=$1 and kind='project'`, [me.id])).map((r) => r.id)
  if (left.length) { await q('delete from pro_messages where thread_id = any($1::uuid[])', [left]); await q('delete from pro_threads where id = any($1::uuid[])', [left]) }
  people.push(me)
}
const threads = []
// a job's runs: their spend (LiteLLM writes it a few seconds behind), averaged — saved at once with --write, so
// a run cut short keeps the jobs already measured (--only the rest to go on)
async function measure(key, runs) {
  await sleep(20000)
  const each = []
  for (const r of runs) each.push(await spendOf(r.userId, new Date(r.from - 1000).toISOString(), new Date(+r.to + 1000).toISOString()))
  const avg = (f) => each.reduce((a, x) => a + f(x), 0) / each.length
  const result = {
    usd: Math.round(avg((x) => x.usd) * 1e6) / 1e6, runs: each.length, calls: Math.round(avg((x) => x.calls)),
    tokens: Math.round(avg((x) => x.pt + x.ct)), models: [...new Set(each.flatMap((x) => (x.models || '').split(',')).filter(Boolean))],
    spread: [Math.min(...each.map((x) => x.usd)), Math.max(...each.map((x) => x.usd))].map((v) => Math.round(v * 1e6) / 1e6),
    answer: Math.round(runs.reduce((a, x) => a + x.chars, 0) / runs.length), kinds: [...new Set(runs.flatMap((x) => x.kinds))],
  }
  console.log(key, JSON.stringify(result))
  if (!each.every((x) => x.calls > 0)) throw new Error(`${key}: a run has no recorded calls — LiteLLM did not log its spend`)
  if (process.argv.includes('--write')) {
    const file = path.join(here, '..', 'lib', 'plans', 'jobs.json')
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { jobs: {} }
    const doc = { measured: new Date().toISOString().slice(0, 10), how: 'scripts/measure-plan-jobs.mjs', basis: arg('--basis', prev.basis || null), jobs: { ...prev.jobs, [key]: result } }
    fs.writeFileSync(file, JSON.stringify(doc, null, 1) + '\n')
    console.log(`wrote ${key} to ${file}`)
  }
}
try {
  for (const [key, text] of Object.entries(JOBS)) {
    if (ONLY && !ONLY.split(',').includes(key)) continue
    const runs = []
    for (let i = 0, tries = 0; i < RUNS; i++) {
      const from = new Date()
      // a call that fails on the way (the shared database restarting, LiteLLM reconnecting) drops the run too
      const me = people[i]
      const r = await run(me, text).catch((e) => ({ failed: e.message.slice(0, 160) }))
      if (r.id) threads.push(r.id)
      // the model sometimes talks instead of making the thing: not a job done either (its cost is not counted)
      if (!r.failed && text.expect && !r.kinds.includes(text.expect)) r.failed = `made no ${text.expect} (${r.kinds.join('/')})`
      if (r.failed) {
        console.log(`  ${key} #${i + 1}: dropped — ${r.failed}`)
        if (++tries > 3) throw new Error(`${key}: four runs were dropped`)
        await sleep(20000)
        i--; continue
      }
      const to = new Date()
      runs.push({ from, to, chars: r.chars, kinds: r.kinds, userId: me.id })
      console.log(`  ${key} #${i + 1}: ${Math.round((to - from) / 1000)} s, answer ${r.chars} chars, ${r.kinds.join('/')}`)
    }
    await measure(key, runs)
  }
} finally {
  // the measuring person's conversations are not kept (--keep: to read what the jobs made)
  if (threads.length && !process.argv.includes('--keep')) {
    await q('delete from pro_messages where thread_id = any($1::uuid[])', [threads])
    await q('delete from pro_threads where id = any($1::uuid[])', [threads])
  }
  await pool.end()
}
