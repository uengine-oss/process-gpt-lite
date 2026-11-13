// E2E S5 「사건 · 승격 · 타이머」 (spec pgpt-pro_process-ontology, design-v0.3 §12 · §13): work is started by events, not by people.
// The admin moves 「요청 접수 · 제안」 down to 제안: a request mail is then offered as that process (「진행할까요?」) instead of
// starting by itself, and so is a new request typed in chat. 이도윤's own schedule (매주 월 9시 실적 정리) is a timer event on the
// map — the graph is the record: stopped there, the schedule does not run. The admin hangs a company timer on the process:
// at 제안 it asks when it rings, at 자동 a case starts by itself. Every promotion is in the decision ledger.
//
//   PRO_API=http://ax.localhost:8790 node test/ontology-triggers.e2e.mjs
// Needs: node scripts/ax-demo.mjs --reset --seed, the map built (S1). Leaves the process at 자동(adopted), as S2 expects.
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import { q, pool } from '../lib/supa.js'
import { config } from '../config.js'

const API = process.env.PRO_API || 'http://ax.localhost:8790'
let failed = 0
const out = {}
const step = async (name, fn) => {
  try { out[name] = await fn(); console.log(`✓ ${name}`, JSON.stringify(out[name]).slice(0, 420)) } catch (e) { failed++; console.log(`✗ ${name}`, e.message) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(2000) }
  throw new Error(`시간 초과: ${what}`)
}
async function signIn(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}`)
  const tok = j.session.access_token
  return { id: j.user.id, email, tok,
    call: async (method, path, body) => { const res = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json().catch(() => ({})) } } }
}
const fire = (id) => fetch(`${API}/api/cron/fire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, secret: config.cronSecret }) })
const card = (userId, since, where = '') => q(`select m.id, m.content from pro_messages m join pro_threads t on t.id=m.thread_id
  where t.user_id=$1 and m.kind='onto-entry' and m.created_at >= $2 ${where} order by m.created_at desc limit 1`, [userId, since]).then((r) => r[0])
const ledger = (since, kind) => q(`select action_kind, subject from pro_policy_decisions where tenant_id='ax-demo' and action_kind=$2 and created_at >= $1 order by created_at desc limit 1`, [since, kind]).then((r) => r[0])

const boss = await signIn('pro-ax-jinyoung@uengine.org')
const doyun = await signIn('pro-ax-doyun@uengine.org')
const t0 = new Date()
const mapNow = async () => (await boss.call('GET', '/ontology/map')).body
const m0 = await mapNow()
const proc = m0.processes.find((p) => p.kind !== 'routine' && (p.tasks || []).includes('요청 메일 접수'))
assert.ok(proc, '메일로 시작하는 프로세스가 지도에 없다(S1 먼저)')
// this scenario's leftovers: 이도윤's schedules and the company timers it hung, the cast's cards
for (const s of await q(`select id::text as id, user_id::text as user_id from pro_schedules where user_id = any($1::uuid[]) and (name like '%실적 정리%' or prompt like '(타이머 사건 %' or prompt like '%정해진 때마다 해 달라고 한 일%')`, [[doyun.id, boss.id]])) {
  await boss.call('PUT', `/ontology/timers/${encodeURIComponent(`timer:${s.id}`)}`, { status: 'gone' }).catch(() => {})
  const { deleteSchedule } = await import('../lib/scheduler.js')
  await deleteSchedule(s.user_id, s.id)
}
for (const e of (m0.events || []).filter((e) => e.kind === 'timer' && e.scope === 'company')) await boss.call('PUT', `/ontology/timers/${encodeURIComponent(e.key)}`, { status: 'gone' })

await step('사다리: 관리자가 프로세스를 「제안」으로 — 결정 원장에 남는다', async () => {
  const r = await boss.call('POST', '/ontology/processes/status', { key: proc.key, status: 'suggested', name: proc.name })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const l = await until(() => ledger(t0, 'ontology.demote'), 10_000, '원장')
  const p = (await mapNow()).processes.find((x) => x.key === proc.key)
  assert.equal(p.status, 'suggested')
  return { proc: proc.name, status: p.status, ledger: l.subject }
})

await step('제안 단계: 요청 메일은 저절로 시작하지 않고 「진행할까요?」로 온다', async () => {
  const since = new Date()
  const mail = { from: '한결건축 이수민 <sumin@hangyeol-demo.example>', subject: '판교 사옥 3층 인테리어 제안 요청',
    text: '안녕하세요. 판교 사옥 3층(약 120평) 사무실 인테리어 제안과 견적을 받고 싶습니다. 다음 주 중 현장 방문 가능하실까요? 이수민 드림' }
  const r = await boss.call('POST', '/mail/demo-arrive', mail)
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200))
  const c = await until(() => card(boss.id, since, `and m.content->>'state'='ask'`), 180_000, '제안 카드')
  assert.equal(c.content.choice.suggest, true, JSON.stringify(c.content.choice).slice(0, 300))
  assert.equal(c.content.choice.proc, proc.key)
  const [started] = await q(`select id from pro_po_cases where tenant_id='ax-demo' and created_at >= $1`, [since])
  assert.ok(!started, '제안 단계인데 건이 저절로 시작했다')
  return { proc: c.content.choice.procName, task: c.content.choice.task, p: Number((c.content.choice.procP || 0).toFixed(3)), started: false }
})

await step('채팅으로 들어온 새 요청도 그 프로세스로 진행할지 묻는다(한 대화에 한 번)', async () => {
  const since = new Date()
  const { mainThread } = await import('../lib/store.js')
  const t = await mainThread(doyun.id)
  await q(`update pro_threads set conversation_id=null where id=$1`, [t.id])
  const res = await fetch(`${API}/api/threads/${t.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${doyun.tok}` },
    body: JSON.stringify({ text: '방금 대림상사 최 과장님한테 전화 왔는데, 본사 2층 회의실 리모델링 제안이랑 견적을 이번 주 안에 받아 보고 싶대요. 어떻게 진행할까요?', fresh: true }) })
  assert.equal(res.status, 200)
  await res.text()
  const c = await until(() => card(doyun.id, since, `and m.content->>'source'='chat'`), 120_000, '채팅 제안 카드')
  assert.equal(c.content.choice.suggest, true)
  assert.equal(c.content.choice.proc, proc.key)
  return { proc: c.content.choice.procName, task: c.content.choice.task, p: Number((c.content.choice.procP || 0).toFixed(3)) }
})

let sched
await step('이도윤의 예약(매주 월 9시)은 지도의 타이머 사건 — 영업 역할 루틴의 한 단계', async () => {
  const r = await doyun.call('POST', '/missions', { name: '주간 영업 실적 정리', cron: '0 9 * * 1', skill: 'weekly-sales-summary', params: {} })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  sched = r.body
  // the graph has it at once; the company map shows it only when the habit setting lets the routine step through
  const { withTenant } = await import('../lib/tenant.js')
  const e = await until(() => withTenant('ax-demo', async () => {
    const { cypher } = await import('../lib/ontology/store.js')
    const [x] = await cypher('MATCH (e:Event {key:$k})-[t:TRIGGERS]->(x:Task) RETURN e.cron AS cron, e.name AS name, e.status AS status, x.key AS to, t.scope AS scope, t.source AS source, t.people AS people', { k: `timer:${sched.id}` })
    return x && { ev: { cron: x.cron, name: x.name, status: x.status }, trig: { to: x.to, scope: x.scope, source: x.source, people: x.people } }
  }), 60_000, '타이머 사건')
  assert.equal(e.ev.cron, '0 9 * * 1')
  assert.equal(e.ev.name, '매주 월 9시')
  assert.equal(e.trig.source, 'timer')
  assert.equal(e.trig.scope, 'role:영업')
  assert.ok(!JSON.stringify(e).includes('weekly-sales-summary'), '예약의 스킬 이름이 회사 지도에 보인다')
  // one person's timer stays off the company map at the default setting (같은 역할 3명 이상)
  const m = await mapNow()
  const shown = (m.events || []).some((x) => x.key === `timer:${sched.id}`)
  if ((e.trig.people || 1) < 3) assert.equal(shown, false, '한 사람의 예약이 회사 지도에 보인다')
  return { event: e.ev.name, task: e.trig.to, scope: e.trig.scope, people: e.trig.people, shownOnMap: shown }
})

await step('그래프가 기준: 지도에서 멈추면 예약도 멈추고, 울려도 돌지 않는다', async () => {
  const r = await boss.call('PUT', `/ontology/timers/${encodeURIComponent(`timer:${sched.id}`)}`, { status: 'paused' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const [s] = await q('select paused from pro_schedules where id=$1', [sched.id])
  assert.equal(s.paused, true)
  // the clock still rings by mistake (an old job): the graph says paused, nothing runs
  await q('update pro_schedules set paused=false where id=$1', [sched.id])
  const before = (await q('select count(*)::int n from pro_mission_runs where schedule_id=$1', [sched.id]))[0].n
  await fire(sched.id)
  await sleep(4000)
  const after = (await q('select count(*)::int n from pro_mission_runs where schedule_id=$1', [sched.id]))[0].n
  const [s2] = await q('select paused from pro_schedules where id=$1', [sched.id])
  assert.equal(after, before, '그래프에서 멈췄는데 실행됐다')
  assert.equal(s2.paused, true, '예약이 그래프를 따라 멈추지 않았다')
  return { runs: after - before, paused: s2.paused }
})

await step('들어온 메일이 정해진 때마다 하는 일이면 「예약 걸까요?」 — 걸면 그 사람의 예약이자 타이머 사건', async () => {
  const since = new Date()
  const mail = { from: '남궁현 <hyun.ng@moa-office.example>', subject: '3층 공사도 주간 보고 부탁드립니다',
    text: '장진영 팀장님, 3층 공사도 2층처럼 준공 때까지 매주 금요일 오후 5시까지 주간 공정 보고서를 메일로 보내 주세요. 양식은 지난번과 같으면 됩니다.' }
  const r = await boss.call('POST', '/mail/demo-arrive', mail)
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200))
  const [c] = await until(() => q(`select m.id, m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='onto-timer' and m.created_at >= $2 order by m.created_at desc limit 1`, [boss.id, since]).then((x) => x.length && x), 120_000, '예약 카드')
  assert.equal(c.content.cron, '0 17 * * 5', JSON.stringify(c.content))
  const a = await boss.call('POST', '/ontology/timers/from-mail', { messageId: c.id })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  assert.equal(a.body.state, 'scheduled')
  const [s] = await q('select id::text as id, cron from pro_schedules where id::text=$1', [a.body.scheduleId])
  assert.equal(s.cron, '0 17 * * 5')
  const { withTenant } = await import('../lib/tenant.js')
  const ev = await until(() => withTenant('ax-demo', async () => {
    const { cypher } = await import('../lib/ontology/store.js')
    const [x] = await cypher('MATCH (e:Event {key:$k})-[t:TRIGGERS]->(x:Task) RETURN e.name AS name, x.key AS task, t.source AS source', { k: `timer:${s.id}` })
    return x
  }), 60_000, '타이머 사건')
  assert.equal(ev.name, '매주 금 17시')
  await boss.call('PUT', `/ontology/timers/${encodeURIComponent(`timer:${s.id}`)}`, { status: 'gone' })
  return { card: `${c.content.when} · ${c.content.task}`, says: c.content.says, event: `${ev.name} → ${ev.task}` }
})

let timerKey, timerSched
await step('회사 타이머(평일 9시)를 프로세스에 건다 — 제안 단계면 울릴 때 묻는다', async () => {
  const r = await boss.call('POST', '/ontology/timers', { proc: proc.key, cron: '0 9 * * 1-5' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  timerKey = r.body.key; timerSched = r.body.scheduleId
  assert.equal(r.body.when, '평일 9시')
  const m = await mapNow()
  assert.ok(m.startsOn.some((s) => s.from === proc.key && s.to === timerKey), 'STARTS_ON 없음')
  const since = new Date()
  await fire(timerSched)
  const c = await until(() => card(boss.id, since, `and m.content->>'source'='timer'`), 30_000, '타이머 제안 카드')
  assert.equal(c.content.state, 'ask')
  assert.equal(c.content.choice.suggest, true)
  const [run] = await until(() => q(`select status, summary from pro_mission_runs where schedule_id=$1 and finished_at is not null order by started_at desc limit 1`, [timerSched]).then((x) => x.length && x), 15_000, '실행 기록')
  return { when: r.body.when, entry: r.body.entry, card: c.content.state, run: run.summary, ledger: (await ledger(t0, 'ontology.timer'))?.subject }
})

await step('「자동」으로 승격하면 타이머가 울릴 때 건이 저절로 시작한다', async () => {
  const r = await boss.call('POST', '/ontology/processes/status', { key: proc.key, status: 'adopted', name: proc.name })
  assert.equal(r.status, 200)
  const l = await until(() => ledger(t0, 'ontology.promote'), 10_000, '승격 원장')
  const since = new Date()
  await fire(timerSched)
  const [c] = await until(() => q(`select id, entry_task, trigger from pro_po_cases where tenant_id='ax-demo' and created_at >= $1 order by created_at desc limit 1`, [since]).then((x) => x.length && x), 60_000, '타이머 건')
  assert.equal(c.trigger.kind, 'timer')
  const cardRow = await until(() => card(boss.id, since, `and m.content->>'source'='timer' and m.content->>'state'='started'`), 15_000, '시작 카드')
  return { ledger: l.subject, caseId: c.id, entry: c.entry_task, card: cardRow.content.state }
})

await step('정리: 타이머 지우기 — 예약도 지워지고 지도에서 사라진다', async () => {
  const r = await boss.call('PUT', `/ontology/timers/${encodeURIComponent(timerKey)}`, { status: 'gone' })
  assert.equal(r.status, 200)
  const [s] = await q('select id from pro_schedules where id=$1', [timerSched])
  assert.ok(!s, '예약이 남았다')
  const m = await mapNow()
  assert.ok(!(m.events || []).some((e) => e.key === timerKey), '지도에 남았다')
  await boss.call('PUT', `/ontology/timers/${encodeURIComponent(`timer:${sched.id}`)}`, { status: 'gone' })
  return { gone: true, process: m.processes.find((p) => p.key === proc.key).status }
})

console.log(failed ? `\n${failed} step(s) failed` : '\nall steps passed')
await pool.end()
process.exit(failed ? 1 : 0)
