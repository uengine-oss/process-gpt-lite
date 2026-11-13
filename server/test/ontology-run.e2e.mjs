// E2E S2 「어디서든 시작」 (spec pgpt-pro_process-ontology): a returning customer asks only for a new quote. The proc is
// adopted; the quote task gets its definition from the quote form found in the mail (checkpoints); the mail arrives in
// the demo mailbox → the start task is chosen with odds (견적서 작성, not 요청 메일 접수) → a snapshot from there runs on
// Process GPT's engine (the earlier steps skipped) → the agent drafts the quote with the xlsx skill and its checkpoints
// are checked → the learned condition sends a quote of 10,000,000원 or more to the finance review (박서연).
//
//   PRO_API=http://ax.localhost:8790 node test/ontology-run.e2e.mjs
//
// Needs S1 first (the map built). Uses the shared completion (:8099) and deepagents (:8888) as they are.
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { q, pool } from '../lib/supa.js'

const API = process.env.PRO_API || 'http://ax.localhost:8790'
let failed = 0
const out = {}
const step = async (name, fn) => {
  try { out[name] = await fn(); console.log(`✓ ${name}`, JSON.stringify(out[name]).slice(0, 400)) } catch (e) { failed++; console.log(`✗ ${name}`, e.message) }
}
async function call(tok, method, path, body) {
  const r = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function signIn(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}`)
  return { id: j.user.id, tok: j.session.access_token, email }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const REQUOTE = {
  from: '달빛커피 한서윤 <seoyun.han@moonlight.example>',
  subject: '2호점 견적만 다시 부탁드려요',
  text: '안녕하세요, 달빛커피 한서윤입니다. 지난번 보내 주신 2호점 설계안은 그대로 진행하려고 합니다. 다만 좌석을 32석에서 40석으로 늘리고 바닥재를 원목으로 바꾸고 싶어서요. 이 조건으로 견적만 다시 뽑아 주실 수 있을까요? 면적은 홀 72㎡, 주방 18㎡, 창고 6㎡ 그대로입니다.',
}

const boss = await signIn('pro-ax-jinyoung@uengine.org')
const m = (await call(boss.tok, 'GET', '/ontology/map')).body
const A = m.processes.find((b) => b.tasks.includes('견적서 작성'))

await step('프로세스를 「자동」으로 승격(관리자)', async () => {
  const r = await call(boss.tok, 'POST', '/ontology/processes/status', { key: A.key, status: 'adopted' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body
})

await step('일 정의: 메일에 붙어 온 견적서 양식에서 점검 항목 초안', async () => {
  const t = (await call(boss.tok, 'GET', `/ontology/tasks/${encodeURIComponent('견적서 작성')}`)).body
  assert.ok(t.templates?.length, '이 일에 쓰인 양식이 없다')
  const d = (await call(boss.tok, 'POST', `/ontology/tasks/${encodeURIComponent('견적서 작성')}/draft`, {})).body
  assert.match(d.definition, /kind: task/)
  assert.match(d.definition, /checkpoints:/)
  // the person confirms: the agent drafts it with the xlsx skill
  const md = d.definition.replace(/runner: \w+/, 'runner: agent').replace(/skills: \[[^\]]*\]/, 'skills: [xlsx]')
  const s = await call(boss.tok, 'PUT', `/ontology/tasks/${encodeURIComponent('견적서 작성')}/definition`, { definition: md })
  assert.equal(s.status, 200, JSON.stringify(s.body))
  assert.equal(s.body.parsed.runner, 'agent')
  assert.ok(s.body.parsed.checkpoints.length >= 3)
  return { template: d.template?.name, checkpoints: s.body.parsed.checkpoints }
})

await step('시작 일: 「견적만 다시」는 견적서 작성부터(확률)', async () => {
  const c = (await call(boss.tok, 'POST', '/ontology/entry', { subject: REQUOTE.subject, text: REQUOTE.text })).body
  assert.equal(c.task, '견적서 작성', JSON.stringify(c))
  return { task: c.task, p: Number(c.p.toFixed(3)), ask: c.ask, measured: c.measured, reads: c.reads.map((r) => `${r.task} 예 ${Math.round(r.yes * 100)}%`) }
})

let caseId, instId
await step('메일이 오면 그 일에서 시작하는 스냅샷이 엔진에서 돈다(앞 일은 건너뜀)', async () => {
  const since = new Date()
  const r = await call(boss.tok, 'POST', '/mail/demo-arrive', REQUOTE)
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200))
  // the start task is read with odds: sure → the case starts by itself; unsure (< 50%) → the card asks and the person picks
  let c, asked = null
  for (let i = 0; i < 90 && !c; i++) {
    ;[c] = await q(`select * from pro_po_cases where tenant_id='ax-demo' and created_at >= $1 order by created_at desc limit 1`, [since])
    if (c) break
    ;[asked] = await q(`select m.id, m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='onto-entry' and m.content->>'state'='ask' and m.created_at >= $2 order by m.created_at desc limit 1`, [boss.id, since])
    if (asked) {
      assert.equal(asked.content.choice.options[0].task, '견적서 작성', JSON.stringify(asked.content.choice))
      const r2 = await call(boss.tok, 'POST', '/ontology/cases', { proc: asked.content.choice.proc, entry: '견적서 작성', subject: REQUOTE.subject, body: REQUOTE.text, from: REQUOTE.from, odds: asked.content.choice, kind: 'mail', messageId: asked.id })
      assert.equal(r2.status, 200, JSON.stringify(r2.body))
      ;[c] = await q(`select * from pro_po_cases where id=$1`, [r2.body.caseId])
      break
    }
    await sleep(2000)
  }
  assert.ok(c, '건이 시작되지 않았다')
  caseId = c.id; instId = c.instances[0]
  assert.equal(c.entry_task, '견적서 작성')
  const skipped = c.history.filter((h) => h.state === 'skipped').map((h) => h.task)
  assert.ok(skipped.length >= 2, `skipped ${skipped}`)
  const [d] = await q(`select definition from proc_def where id=(select proc_def_id from bpm_proc_inst where proc_inst_id=$1)`, [instId])
  const acts = d.definition.activities.map((a) => a.name)
  assert.equal(acts[0], '요청 접수')
  assert.ok(!acts.includes('현장 실측') && !acts.includes('평면도 작성'), acts.join(','))
  return { caseId, instId, entry: c.entry_task, asked: !!asked, skipped, activities: acts, lanes: (d.definition.roles || []).map((x) => x.name) }
})

await step('에이전트가 일 정의대로 견적서를 만들고 점검 항목을 확인한다', async () => {
  let t
  for (let i = 0; i < 150; i++) {
    ;[t] = await q(`select id, status::text s, output from todolist where proc_inst_id=$1 and activity_name='견적서 작성'`, [instId])
    if (t?.s === 'DONE') break
    await sleep(4000)
  }
  assert.equal(t?.s, 'DONE', `quote step ${t?.s}`)
  const v = Object.values(t.output || {})[0] || {}
  assert.ok(v.quote?.url, 'xlsx 없음')
  assert.ok(Number(v.amount) > 0, `amount ${v.amount}`)
  assert.ok(Array.isArray(v.checkpoints) && v.checkpoints.length >= 3, 'checkpoints')
  return { file: v.quote.name, amount: Number(v.amount), checks: v.checkpoints.map((c) => `${c.ok ? '✓' : c.ok === false ? '✗' : '?'} ${c.checkpoint}`) }
})

await step('배운 조건대로: 1천만 원 이상이면 재무 검토(박서연)', async () => {
  const amount = out['에이전트가 일 정의대로 견적서를 만들고 점검 항목을 확인한다']?.amount
  // the engine's own gateway decision (it evaluates the learned condition), and the step it opened — the engine
  // makes later steps' rows ahead as TODO, so the opened one is the IN_PROGRESS row
  let gw, next
  for (let i = 0; i < 60; i++) {
    ;[gw] = await q(`select data from events where proc_inst_id=$1 and event_type::text='gateway_decision' and data->'source'->>'type'='gateway' order by timestamp desc limit 1`, [instId]).catch(() => [])
    ;[next] = await q(`select activity_name, user_id, status::text s from todolist where proc_inst_id=$1 and activity_name in ('재무 검토','고객 회신') and status::text in ('IN_PROGRESS','SUBMITTED','PENDING') order by start_date nulls last limit 1`, [instId])
    if (next) break
    await sleep(3000)
  }
  assert.ok(next, '다음 단계가 열리지 않았다')
  const expect = amount >= 10_000_000 ? '재무 검토' : '고객 회신'
  assert.equal(next.activity_name, expect, `amount ${amount}`)
  const picked = (gw?.data?.selectedTargets || []).map((x) => x.activityName)
  if (gw) assert.deepEqual(picked, [expect], `gateway ${JSON.stringify(picked)}`)
  let to = null
  if (expect === '재무 검토') {
    // (in draft mode the engine puts the agent first in the step's people — the person is the one who is not an agent)
    const [u] = await q(`select email from users where id::text = any(string_to_array($1, ',')) and tenant_id='ax-demo' and not coalesce(is_agent, false) limit 1`, [next.user_id])
    to = u?.email
    assert.equal(to, 'pro-ax-seoyeon@uengine.org')
  }
  return { amount, next: next.activity_name, status: next.s, to, gateway: gw ? { picked, rule: gw.data.selectionRule, why: (gw.data.evaluations || []).find((e) => e.selected)?.reason?.slice(0, 160) || (gw.data.evaluations || []).find((e) => e.selected)?.explanation?.slice(0, 160) || '' } : null }
})

// 자동으로 승격한 프로세스의 사람 단계(design-v0.3 §12): 일이 사람에게 닿을 때 에이전트가 만든 초안이 이미 있다
await step('사람 단계는 초안이 먼저: 박서연에게 닿기 전에 재무 검토 초안', async () => {
  const nx = out['배운 조건대로: 1천만 원 이상이면 재무 검토(박서연)']
  if (nx?.next !== '재무 검토') return { skipped: `다음 단계가 ${nx?.next || '없음'}` }
  let t
  for (let i = 0; i < 90; i++) {
    ;[t] = await q(`select agent_mode, draft, status::text s, user_id from todolist where proc_inst_id=$1 and activity_name='재무 검토' order by start_date desc nulls last limit 1`, [instId])
    if (t?.draft && Object.keys(t.draft).length) break
    await sleep(4000)
  }
  assert.equal(String(t?.agent_mode || '').toUpperCase(), 'DRAFT', `mode ${t?.agent_mode}`)
  assert.ok(t?.draft && Object.keys(t.draft).length, '초안 없음')
  assert.notEqual(t.s, 'DONE', '사람이 내기 전에 끝났다')
  const [m] = await q(`select content->>'text' as text from pro_messages m join pro_threads th on th.id=m.thread_id join users u on u.id::text = th.user_id::text and u.tenant_id='ax-demo'
                       where u.email='pro-ax-seoyeon@uengine.org' and m.content->>'text' like '%초안을 만들어 두었어요%' order by m.created_at desc limit 1`).catch(() => [])
  // the step reaches her Home: the engine lists 'agent,person' on a draft step and the notification copies the list
  const seoyeon = await signIn('pro-ax-seoyeon@uengine.org')
  const home = (await call(seoyeon.tok, 'GET', '/notifications')).body
  const card = (Array.isArray(home) ? home : []).find((n) => n.type === 'workitem' && n.title === '재무 검토')
  assert.ok(card, `박서연의 홈에 재무 검토가 없다: ${JSON.stringify(home).slice(0, 200)}`)
  return { mode: t.agent_mode, status: t.s, draft: Object.keys(t.draft).slice(0, 6), told: m?.text?.slice(0, 80) || null, home: `입력 · ${card.title}` }
})

console.log(failed ? `\n${failed} failed` : '\nall passed')
fs.writeFileSync(new URL('../.scratch/ontology-run.e2e.json', import.meta.url), JSON.stringify({ caseId, instId, ...out }, null, 1))
await pool.end()
process.exit(failed ? 1 : 0)
