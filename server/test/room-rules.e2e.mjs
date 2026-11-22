// 방 판정 · 방 규칙 · 바로잡는 말 HTTP E2E: 실제 BFF · 실제 DB · 실제 모델(판정 서버 없이 LLM, 운영과 같음) · 실제 Chromium.
//   BFF:  PRO_BACKGROUND=0 PRO_PORT=8794 PRO_CONTEXT_ROUTER_URL= PRO_JUDGE_URL= node index.js > bff.log 2>&1
//   이것: API_URL=http://localhost:8794 BFF_LOG=bff.log PRO_JUDGE_URL= node test/room-rules.e2e.mjs
// 말의 뜻은 모델이 읽는다 — 여기서는 그 판단이 실제 모델로 맞게 나오는지, 얼마나 걸리는지를 본다.
//   1. 녹화의 첫 문장 → 규칙(브라우저 스킬 함께) / 2. 링크만 → 규칙대로 브라우저 작업(스킬의 시작 주소, skill 전달)
//   3. 규칙이 아닌 말은 규칙이 되지 않는다, 다른 규칙 말은 규칙이 되지만 사이트 일이 아니면 스킬이 없다
//   4. 규칙 없는 방에서 긴 작업 중 바로잡는 말 → 앞 턴 대신 + 브라우저 작업 goal 에 앞서 올린 링크
// 로그인 뒤의 일(사이트 안)은 사람이 있어야 해서 여기 없다. 시험 계정 pro-nb1121-route2@uengine.org(로그인 코드 000000).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { q, pool } from '../lib/supa.js'
import { readRoom, ruleAction, ruleOf } from '../lib/roomRules.js'
import { browserSkill } from '../lib/browserSkills.js'

const API = `${process.env.API_URL || 'http://localhost:8794'}/api`
const CODE = process.env.PGPT_LOGIN_CODE || '000000'
const LOG = process.env.BFF_LOG || ''
// the recording's first sentence (2026-11-21), as dictated
const RULE = '이 방에서 내가 주는 url이 있으면 그거를 받아다가 노트북엘엠으로 슬라이드를 만들고 그 팟캐스트를 하나 만들어 주면 돼'
const LINK = 'https://youtu.be/3jQHMKGcwQs'
const SKILL = 'notebooklm' // the installed browser skill this work is for (skills/notebooklm)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const JSONH = { 'Content-Type': 'application/json' }
const measured = []
let n = 0
async function step(name, fn) {
  n++
  try { await fn(); console.log(`ok ${n} - ${name}`) } catch (e) { console.log(`not ok ${n} - ${name}\n  ${e.message}`); await cleanup().catch(() => {}); await pool.end(); process.exit(1) }
}
async function login(email) {
  const r = await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: JSONH, body: JSON.stringify({ email, code: CODE }) })
  const s = await r.json()
  const H = { Authorization: `Bearer ${s.session.access_token}`, ...JSONH, 'X-PGL-Lang': 'ko' }
  await fetch(`${API}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ name: '회귀-방판정', birth: '1990-01-01', onboarded: true }) })
  return { id: s.user.id, email, H }
}
const call = (u, path, opts = {}) => fetch(`${API}${path}`, { headers: u.H, ...opts }).then((r) => r.json())
// 답은 스트림으로 온다: 끝까지 읽는다
const say = (u, thread, text) => fetch(`${API}/threads/${thread}/messages`, { method: 'POST', headers: u.H, body: JSON.stringify({ text }), signal: AbortSignal.timeout(180000) }).then((r) => r.text())
const rows = (thread, kind) => q(`select role, kind, content from pro_messages where thread_id=$1 ${kind ? 'and kind=$2' : ''} order by created_at`, kind ? [thread, kind] : [thread])
const replies = async (thread) => (await rows(thread, 'text')).filter((m) => m.role === 'agent')
const until = async (fn, what, ms = 60000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}`)
    await sleep(500)
  }
}
// what the BFF said about a thread (its log): [room] … ms, [browser] start … skill=…
const logOf = (thread) => (LOG ? fs.readFileSync(LOG, 'utf8') : '').split('\n').filter((l) => l.includes(`thread=${String(thread).slice(0, 8)}`))
const newRoom = async (u, text) => (await call(u, '/threads', { method: 'POST', body: JSON.stringify({ text }) })).id

const me = await login('pro-nb1121-route2@uengine.org')
async function cleanup() {
  await call(me, '/browser/cancel', { method: 'POST', body: '{}' }).catch(() => {})
  await q(`delete from pro_threads where user_id=$1 and kind='project'`, [me.id])
}
await cleanup()
const start = browserSkill(SKILL)?.startUrl
assert.ok(start, `브라우저 스킬 ${SKILL} 이 설치되어 있어야 한다`)

let room
await step('녹화의 첫 문장 → 규칙: 판정 set_rule(0.7 이상), 받아 적은 할 일과 스킬(notebooklm), 에이전트 없이', async () => {
  let t0 = Date.now()
  room = await newRoom(me, RULE)
  const made = Date.now() - t0
  t0 = Date.now()
  await say(me, room, RULE)
  const total = Date.now() - t0
  const rule = await ruleOf(me.id, room)
  assert.ok(rule, '규칙이 저장되어야 한다')
  assert.equal(rule.said, RULE)
  assert.equal(rule.skill, SKILL)
  const said = (await replies(room)).at(-1).content
  assert.ok(said.text.includes(rule.action), `답에 할 일이 보여야 한다: ${said.text}`)
  assert.equal((await rows(room, 'task')).length, 0, '규칙을 정하는 말로는 아직 일을 시작하지 않는다')
  const judged = logOf(room).find((l) => l.startsWith('[room]'))
  console.log(`  # 새 프로젝트 ${made} ms · 보내고 답까지 ${total} ms · ${judged}`)
  console.log(`  # 할 일: ${rule.action} · 스킬: ${rule.skill}`)
  measured.push({ what: '규칙 말(판정+받아 적기)', total, judged })
})

await step('링크만 붙이면 판정 run_rule → 브라우저 작업: 시작 주소는 스킬의 start_url, skill 을 넘기고, goal 에 링크가 그대로', async () => {
  const t0 = Date.now()
  await say(me, room, LINK)
  const total = Date.now() - t0
  assert.equal((await replies(room)).at(-1).content.text, '이 방의 규칙대로 시작할게요.')
  const task = await until(async () => (await rows(room, 'task')).at(-1)?.content, '작업 카드')
  assert.equal(task.url, start)
  assert.ok(task.goal.includes(LINK), task.goal)
  const started = logOf(room).find((l) => l.startsWith('[browser] start'))
  assert.match(started || '', new RegExp(`skill=${SKILL} url=${start.replace(/[.?/]/g, '\\$&')}`), started)
  assert.equal((await ruleOf(me.id, room)).runs, 1)
  const judged = logOf(room).filter((l) => l.startsWith('[room]')).at(-1)
  console.log(`  # 보내고 답까지 ${total} ms · ${judged}`)
  console.log(`  # ${started}`)
  measured.push({ what: '링크(판정→브라우저)', total, judged })
  await call(me, '/browser/cancel', { method: 'POST', body: '{}' })
  await until(async () => ['cancelled', 'done', 'failed', 'needs_input'].includes((await rows(room, 'task')).at(-1)?.content.state), '취소됨', 30000)
})

await step('규칙이 아닌 말은 규칙이 되지 않는다(실제 모델) — 규칙 없는 방에서도, 규칙이 있는 방에서도', async () => {
  const rule = await ruleOf(me.id, room)
  for (const [ctx, r] of [['규칙 없음', null], ['규칙 있음', rule]]) {
    for (const text of ['앞으로 답은 짧게 해 줘', `이 링크 요약해 줘 ${LINK}`]) {
      const out = await readRoom({ rule: r, text })
      console.log(`  # [${ctx}] ${text} → ${out.pick} ${JSON.stringify(out.probabilities)} ${out.ms} ms`)
      measured.push({ what: `[${ctx}] ${text}`, total: out.ms, judged: `${out.pick} ${JSON.stringify(out.probabilities)}` })
      assert.notEqual(out.pick, 'set_rule', text)
    }
  }
})

await step('다른 말로 정한 규칙도 규칙이 되고, 사이트에서 할 일이 아니면 스킬이 없다(실제 모델)', async () => {
  const text = '이 방에 올리는 파일은 앞으로 전부 영어로 번역해 줘'
  const out = await readRoom({ text })
  console.log(`  # ${text} → ${out.pick} ${JSON.stringify(out.probabilities)} ${out.ms} ms`)
  assert.equal(out.pick, 'set_rule')
  const t0 = Date.now()
  const a = await ruleAction(text)
  console.log(`  # 받아 적기 ${Date.now() - t0} ms: ${JSON.stringify(a)}`)
  assert.equal(a.skill, '')
})

await step('규칙 없는 방에서 긴 작업 중 바로잡는 말 → 앞 턴은 멈추고 이유로 끝나며, 브라우저 작업은 스킬의 시작 주소에서, goal 에 앞서 올린 링크', async () => {
  const first = `${LINK} 이 영상으로 슬라이드와 팟캐스트 만들어 줘`
  const blank = await newRoom(me, first)
  // the agent's turn: left running in the background
  fetch(`${API}/threads/${blank}/messages`, { method: 'POST', headers: me.H, body: JSON.stringify({ text: first }) }).then((r) => r.text()).catch(() => {})
  await until(async () => (await q('select status from pro_threads where id=$1', [blank]))[0]?.status === 'working', '앞의 에이전트 턴이 돈다', 60000)
  const t0 = Date.now()
  await say(me, blank, '노트북엘엠 사이트에 들어가서 생성해야')
  const total = Date.now() - t0
  const task = await until(async () => (await rows(blank, 'task')).at(-1)?.content, '작업 카드')
  console.log(`  # 바로잡는 말 보내고 답까지 ${total} ms · 답: ${(await replies(blank)).at(-1).content.text}`)
  console.log(`  # 작업 카드 url=${task.url} goal=${task.goal}`)
  const started = logOf(blank).find((l) => l.startsWith('[browser] start'))
  console.log(`  # ${started}`)
  for (const l of logOf(blank).filter((x) => x.startsWith('[room]'))) console.log(`  # ${l}`)
  measured.push({ what: '바로잡는 말(판정+라우터)', total, judged: logOf(blank).filter((l) => l.startsWith('[room]')).at(-1) })
  assert.equal(task.url, start, '스킬의 시작 주소')
  assert.match(started || '', new RegExp(`skill=${SKILL} `), '라우터가 고른 스킬이 브라우저 작업에 간다')
  assert.ok(task.goal.includes('3jQHMKGcwQs'), `goal 에 앞서 올린 링크: ${task.goal}`)
  const replaced = await until(async () => (await replies(blank)).find((m) => m.content.replaced)?.content, '앞의 턴이 대신됨', 60000)
  console.log(`  # 앞 턴의 답: ${replaced.text}`)
  assert.equal(replaced.stopped, true)
  await call(me, '/browser/cancel', { method: 'POST', body: '{}' })
  await call(me, `/threads/${blank}/stop`, { method: 'POST', body: '{}' }).catch(() => {})
})

console.log('# 지연(실제 모델)')
for (const m of measured) console.log(`#   ${m.what}: ${m.total} ms · ${m.judged || ''}`)
if (process.env.KEEP !== '1') {
  await cleanup()
  fs.rmSync(fileURLToPath(new URL(`../.browser-profiles/${me.id}`, import.meta.url)), { recursive: true, force: true })
}
console.log(`1..${n}`)
await pool.end()
process.exit(0)
