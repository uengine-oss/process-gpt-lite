// Local CLI agents (lib/localAgents — docs/local-agents/design.md): the activity settings, device tokens (issue · revoke · scope), the
// dispatcher with fake desktop links (online → that person's desktop; offline + wait → queued, sent when it connects; offline + server →
// the server agent; the wait running out → the server agent; never another person's desktop), the steering relay, and the link itself
// over a real WebSocket. The step side (prepare · complete · delegate) is replaced by recorders: no process engine here.
// Run: node --test test/localAgents.test.js  (needs the local database; rows go to the test tenant "localagent-test" and are removed)
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'

process.env.PRO_TENANT_ID = 'localagent-test'
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
const os = await import('node:os')
const fsp = await import('node:fs/promises')
const FROOT = await fsp.mkdtemp((await import('node:path')).join(os.tmpdir(), 'pgl-la-unit-'))
process.env.PRO_FOLDERS_ROOT = FROOT
const A = await import('../lib/localAgents/agents.js')
const { q, pool } = await import('../lib/supa.js')
const D = await import('../lib/localAgents/devices.js')
const H = await import('../lib/localAgents/hub.js')
const J = await import('../lib/localAgents/jobs.js')
const db = await q('select 1 from pro_local_jobs limit 1').then(() => true).catch(() => false)

// ---------- the settings (pure) ----------
test('활동 설정: 로컬 에이전트 · 꺼져 있을 때 · 기다리는 시간', () => {
  assert.equal(A.settingsOf({}), null)
  assert.equal(A.settingsOf({ agent: 'deepagents' }), null)
  assert.deepEqual(A.settingsOf({ agent: 'local:claude-code' }), { agent: 'claude-code', offline: 'server', serverAgent: 'onto', waitMinutes: null })
  assert.deepEqual(A.settingsOf({ agent: 'local:codex', when_offline: 'wait', wait_minutes: '90', server_agent: 'deepagents' }), { agent: 'codex', offline: 'wait', serverAgent: 'deepagents', waitMinutes: 90 })
  // a wait time means nothing when it hands off at once; nonsense is dropped
  assert.equal(A.settingsOf({ agent: 'local:codex', when_offline: 'server', wait_minutes: 90 }).waitMinutes, null)
  assert.equal(A.settingsOf({ agent: 'local:codex', when_offline: 'wait', wait_minutes: 'x' }).waitMinutes, null)
  assert.equal(A.settingsOf({ agent: 'local:rm -rf' }), null)
  assert.deepEqual(A.normalize({ agent: 'claude-code', offline: 'wait', waitMinutes: 5 }), { agent: 'claude-code', offline: 'wait', serverAgent: 'onto', waitMinutes: 5 })
  assert.deepEqual(A.frontOf({ agent: 'local:codex', whenOffline: 'wait', waitMinutes: 30, serverAgent: 'cliagents' }), { agent: 'local:codex', when_offline: 'wait', server_agent: 'cliagents', wait_minutes: 30 })
  assert.deepEqual(A.frontOf({ agent: 'onto' }), { agent: null, when_offline: null, server_agent: null, wait_minutes: null })
  assert.throws(() => A.frontOf({ agent: 'local:bash' }), /agent/)
  assert.deepEqual(A.withFront({ name: 'x', agent: 'local:codex', runner: 'agent' }, { agent: null, when_offline: 'wait' }), { name: 'x', runner: 'agent', when_offline: 'wait' })
})

test('일 정의(front matter)가 에이전트 설정을 지닌다: 읽기 · 쓰기가 맞물린다', async () => {
  const TD = await import('../lib/ontology/taskdef.js')
  const md = TD.toDefinition(A.withFront({ name: '견적서 작성', kind: 'task', runner: 'draft' }, A.frontOf({ agent: 'local:claude-code', whenOffline: 'wait', waitMinutes: 120, serverAgent: 'deepagents' })), '## 하는 일\n1. 견적서를 쓴다')
  assert.match(md, /agent: "local:claude-code"/)
  const d = await TD.taskDefinition('견적서 작성', { definition_md: md })
  assert.equal(d.runner, 'draft', 'front matter 의 runner: draft 도 읽힌다')
  assert.deepEqual(d.local, { agent: 'claude-code', offline: 'wait', serverAgent: 'deepagents', waitMinutes: 120 })
  // back to a server agent: the keys go
  const back = TD.toDefinition(A.withFront(TD.parseDefinition(md).front, A.frontOf({ agent: 'onto' })), '')
  assert.doesNotMatch(back, /agent:|when_offline|wait_minutes|server_agent/)
  assert.equal((await TD.taskDefinition('x', { definition_md: back })).local, null)
})

test('누구의 데스크톱: 담당자 가운데 사람(에이전트가 아닌), 이메일은 그 사람으로', () => {
  const a = '11111111-1111-4111-8111-111111111111', p = '22222222-2222-4222-8222-222222222222'
  assert.equal(A.assigneeOf(`${a},${p}`, { agents: new Set([a]) }), p)
  assert.equal(A.assigneeOf(`${a},kim@x.test`, { agents: new Set([a]), emails: new Map([['kim@x.test', p]]) }), p)
  assert.equal(A.assigneeOf(a, { agents: new Set([a]) }), null)
  assert.equal(A.canRun({ prefs: { enabled: true }, caps: { clis: { codex: { installed: true } } } }, 'codex'), true)
  assert.equal(A.canRun({ prefs: { enabled: false }, caps: { clis: { codex: { installed: true } } } }, 'codex'), false)
  assert.equal(A.canRun({ prefs: {}, caps: { clis: { codex: { installed: true, runnable: false } } } }, 'codex'), false)
  assert.equal(A.canRun({ prefs: {}, caps: { clis: {} } }, 'codex'), false)
  const old = { state: 'queued', offline: 'wait', wait_minutes: 10, created_at: new Date(Date.now() - 11 * 60_000) }
  assert.equal(A.overdue(old), true)
  assert.equal(A.overdue({ ...old, wait_minutes: null }), false)
  assert.equal(A.overdue({ ...old, offline: 'server' }), false)
})

// ---------- with the database ----------
const T = 'localagent-test'
// each test its own two people: a queue left by one test is not another's
let userA, userB
const people = () => { userA = { id: crypto.randomUUID(), name: '김담당', email: 'a@localagent.test' }; userB = { id: crypto.randomUUID(), name: '이동료', email: 'b@localagent.test' } }
const calls = []
const record = (name) => async (...a) => { calls.push([name, ...a]); return name === 'prepare' ? { prompt: 'p', git: { folder: { id: crypto.randomUUID() }, line: 'inst/x', branch: 'pgpt-agent/x' } } : {} }
test.beforeEach(people)
before(async () => {
  people()
  if (!db) return
  J.setHooks({ prepare: record('prepare'), complete: record('complete'), delegate: record('delegate'), fail: record('fail'), note: async () => {}, cancelled: async () => false })
  H.setHandlers({ online: J.onOnline, caps: J.onCaps, message: J.onMessage, offline: J.onOffline })
})
after(async () => {
  if (db) {
    for (const t of ['pro_local_jobs', 'pro_local_devices', 'todolist', 'bpm_proc_inst', 'proc_def', 'pro_team_members', 'pro_folders', 'notifications', 'agent_skills', 'tenant_skills', 'pro_skill_visibility']) await q(`delete from ${t} where tenant_id=$1`, [T]).catch(() => {})
    await q(`delete from users where tenant_id=$1 and is_agent and email like '%@localagent.test'`, [T]).catch(() => {})
  }
  await pool.end()
  await fsp.rm(FROOT, { recursive: true, force: true })
})

// a desktop as the hub sees it: what it is sent is recorded
// (again: the same device — its token — coming back)
async function desktop(user, { clis = { 'claude-code': { installed: true, version: '2.1.330' } }, prefs = { enabled: true }, maxJobs = 2, active = [], again = null } = {}) {
  const { token, device } = again || await D.issue(user, { name: `${user.name}의 맥`, platform: 'darwin' })
  const got = []
  const transport = { send: (t) => got.push(JSON.parse(t)), close: (code) => { got.push({ type: 'closed', code }) } }
  const link = await H.open(transport, { type: 'hello', token, device: { name: `${user.name}의 맥` }, caps: { clis, maxJobs }, prefs, active })
  assert.ok(!link.error, link.error)
  return { link, got, device, token, jobs: () => got.filter((m) => m.type === 'job').map((m) => m.job.id) }
}
const spec = (user, extra = {}) => ({ todoId: crypto.randomUUID(), instId: `inst-${crypto.randomUUID().slice(0, 8)}`, activity: '견적서 작성', userId: user.id, agent: 'claude-code', offline: 'wait', serverAgent: 'onto', ...extra })
const tick = () => new Promise((r) => setTimeout(r, 20))

test('기기 토큰: 해시만 남고, 끊으면 거절, 다른 사람의 기기는 끊을 수 없다', { skip: !db }, async () => {
  const { token, device } = await D.issue(userA, { name: '테스트 맥', platform: 'darwin', appVersion: '0.1.0' })
  assert.ok(D.looksLike(token))
  const [row] = await q('select * from pro_local_devices where id=$1', [device.id])
  assert.equal(row.token_hash, D.hashOf(token))
  assert.ok(!JSON.stringify(row).includes(token), '토큰 원문은 남기지 않는다')
  assert.equal((await D.byToken(token)).id, device.id)
  assert.equal(await D.byToken(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`), null)
  assert.equal(await D.byToken('pld1_short'), null)
  assert.equal(await D.revoke(userB, device.id), null, '남의 기기')
  assert.ok((await D.list(userA)).some((d) => d.id === device.id))
  assert.ok(!(await D.list(userB)).some((d) => d.id === device.id))
  assert.equal((await D.revoke(userA, device.id)).revoked, true)
  assert.equal(await D.byToken(token), null)
  // a revoked token cannot open a link
  const r = await H.open({ send() {}, close() {} }, { type: 'hello', token })
  assert.equal(r.code, 4401)
  assert.equal((await H.open({ send() {}, close() {} }, { type: 'nope' })).code, 4400)
})

test('켜져 있으면 그 사람의 데스크톱으로, 다른 사람의 데스크톱으로는 가지 않는다', { skip: !db }, async () => {
  H.reset()
  const a = await desktop(userA)
  const b = await desktop(userB)
  const j = await J.enqueue(spec(userA))
  assert.equal(j.state, 'offered')
  assert.equal(String(j.device_id), a.device.id)
  assert.deepEqual(a.jobs(), [j.id])
  assert.deepEqual(b.jobs(), [])
  // B's desktop speaking about A's job is ignored
  await H.receive(b.link, { type: 'accept', jobId: j.id })
  await H.receive(b.link, { type: 'done', jobId: j.id, branch: 'pgpt-agent/x', pushed: true })
  assert.equal((await J.byId(j.id)).state, 'offered')
  // A's own: accepted, running, progress kept, done → the step's result
  await H.receive(a.link, { type: 'accept', jobId: j.id })
  assert.equal((await J.byId(j.id)).state, 'running')
  await H.receive(a.link, { type: 'progress', jobId: j.id, lines: [{ kind: 'tool', text: 'Write · 견적서.md' }] })
  assert.equal((await J.byId(j.id)).lines.at(-1).text, 'Write · 견적서.md')
  await H.receive(a.link, { type: 'done', jobId: j.id, branch: 'pgpt-agent/x', commit: 'abc', pushed: true, files: ['산출물/01/견적서.md'], summary: '견적서를 만들었어요' })
  const done = await J.byId(j.id)
  assert.equal(done.state, 'done')
  assert.equal(done.result.summary, '견적서를 만들었어요')
  assert.ok(calls.some(([n, job]) => n === 'complete' && job.id === j.id))
  assert.deepEqual(a.got.filter((m) => m.type === 'finished').map((m) => [m.jobId, m.state]), [[j.id, 'done']])
  await H.gone(a.link); await H.gone(b.link)
})

test('꺼져 있고 「기다리기」면 대기, 데스크톱이 켜지면 오래된 것부터 보낸다(동시 실행 한도)', { skip: !db }, async () => {
  H.reset()
  const j1 = await J.enqueue(spec(userA))
  await tick()
  const j2 = await J.enqueue(spec(userA))
  const j3 = await J.enqueue(spec(userA))
  for (const j of [j1, j2, j3]) { const x = await J.byId(j.id); assert.equal(x.state, 'queued'); assert.equal(x.why, 'waiting') }
  assert.ok(!calls.some(([n, job]) => n === 'delegate' && [j1.id, j2.id, j3.id].includes(job.id)))
  // the desktop comes on with room for two
  const a = await desktop(userA, { maxJobs: 2 })
  assert.deepEqual(a.jobs(), [j1.id, j2.id])
  assert.equal((await J.byId(j3.id)).state, 'queued')
  // one finishes: the third goes
  await H.receive(a.link, { type: 'accept', jobId: j1.id })
  await H.receive(a.link, { type: 'failed', jobId: j1.id, error: 'CLI 실패' })
  assert.ok(calls.some(([n, job]) => n === 'fail' && job.id === j1.id))
  await J.sweep()
  assert.deepEqual(a.jobs(), [j1.id, j2.id, j3.id])
  await H.gone(a.link)
})

test('꺼져 있고 「서버에 맡기기」면 바로 서버 에이전트로', { skip: !db }, async () => {
  H.reset()
  const j = await J.enqueue(spec(userA, { offline: 'server', serverAgent: 'onto' }))
  assert.equal(j.state, 'delegated')
  assert.equal(j.why, 'offline')
  assert.ok(calls.some(([n, job]) => n === 'delegate' && job.id === j.id))
  // a desktop of the person is on but has no such CLI: the same
  const a = await desktop(userA, { clis: { codex: { installed: true } } })
  const k = await J.enqueue(spec(userA, { offline: 'server' }))
  assert.equal(k.state, 'delegated')
  assert.equal(k.why, 'unable')
  await H.gone(a.link)
})

test('기다리는 시간이 지나면 서버 에이전트로', { skip: !db }, async () => {
  H.reset()
  const j = await J.enqueue(spec(userA, { offline: 'wait', waitMinutes: 10 }))
  assert.equal(j.state, 'queued')
  await J.sweep(Date.now() + 5 * 60_000)
  assert.equal((await J.byId(j.id)).state, 'queued')
  await J.sweep(Date.now() + 11 * 60_000)
  const x = await J.byId(j.id)
  assert.equal(x.state, 'delegated')
  assert.equal(x.why, 'timeout')
})

test('데스크톱이 거절하면 서버로, 바쁘면 다시 대기, 받지 않은 채 꺼지면 대기로 돌아간다', { skip: !db }, async () => {
  H.reset()
  let a = await desktop(userA)
  const j = await J.enqueue(spec(userA))
  await H.receive(a.link, { type: 'decline', jobId: j.id, reason: 'declined' })
  assert.equal((await J.byId(j.id)).state, 'delegated')
  assert.equal((await J.byId(j.id)).why, 'declined')
  const k = await J.enqueue(spec(userA))
  await H.receive(a.link, { type: 'decline', jobId: k.id, reason: 'busy' })
  assert.equal((await J.byId(k.id)).state, 'queued')
  await J.route(await J.byId(k.id))
  assert.equal((await J.byId(k.id)).state, 'offered')
  // the desktop goes off before taking it: queued again (the wait)
  await H.gone(a.link)
  assert.equal((await J.byId(k.id)).state, 'queued')
  // a desktop that comes back without the run it had taken: offered again
  a = await desktop(userA)
  const offered = await J.byId(k.id)
  assert.equal(offered.state, 'offered')
  await H.receive(a.link, { type: 'accept', jobId: k.id })
  await H.gone(a.link)
  assert.equal((await J.byId(k.id)).state, 'running', '받은 실행은 연결이 끊겨도 그 데스크톱의 것')
  a = await desktop(userA, { active: [k.id], again: a })
  assert.equal((await J.byId(k.id)).state, 'running', '다시 붙으며 실행 중이라고 알렸다')
  await H.gone(a.link)
  a = await desktop(userA, { active: [], again: a })
  assert.equal((await J.byId(k.id)).state, 'offered', '잃어버린 실행은 다시 보낸다')
  await H.gone(a.link)
})

test('조종: 실행 중이면 바로 데스크톱으로, 연결이 끊겨 있으면 다시 붙을 때 보낸다', { skip: !db }, async () => {
  H.reset()
  let a = await desktop(userA)
  const j = await J.enqueue(spec(userA))
  await H.receive(a.link, { type: 'accept', jobId: j.id })
  const r = await J.steer(await J.byId(j.id), userA, '금액은 부가세 포함으로 바꿔 주세요')
  assert.equal(r.delivered, true)
  const s = a.got.filter((m) => m.type === 'steer')
  assert.equal(s.length, 1)
  assert.equal(s[0].text, '금액은 부가세 포함으로 바꿔 주세요')
  await H.receive(a.link, { type: 'steered', jobId: j.id, steerId: s[0].steerId, how: 'live' })
  assert.equal((await J.byId(j.id)).steers[0].applied, 'live')
  // the link drops: the next steer waits for it
  await H.gone(a.link)
  const r2 = await J.steer(await J.byId(j.id), userA, '받는 사람은 총무팀으로')
  assert.equal(r2.delivered, false)
  a = await desktop(userA, { active: [j.id], again: a })
  assert.deepEqual(a.got.filter((m) => m.type === 'steer').map((m) => m.text), ['받는 사람은 총무팀으로'])
  // a finished run cannot be steered
  await H.receive(a.link, { type: 'done', jobId: j.id, branch: 'pgpt-agent/y', pushed: true, summary: 's' })
  await assert.rejects(J.steer(await J.byId(j.id), userA, '늦은 지시'), /끝났어요/)
  await H.gone(a.link)
})

test('조종의 상태: 보냄 → 받음 → 반영, 데스크톱이 못 받으면 까닭, 반영 전에 실행이 끝나면 못 함', { skip: !db }, async () => {
  H.reset()
  const ST = await import('../lib/localAgents/steps.js')
  const a = await desktop(userA)
  const j = await J.enqueue(spec(userA))
  await H.receive(a.link, { type: 'accept', jobId: j.id })
  const s1 = (await J.steer(await J.byId(j.id), userA, '첫 지시')).steer
  assert.equal(ST.steerState((await J.byId(j.id)).steers[0]), 'sent')
  await H.receive(a.link, { type: 'steer-received', jobId: j.id, steerId: s1.id })
  assert.equal(ST.steerState((await J.byId(j.id)).steers[0]), 'received')
  await H.receive(a.link, { type: 'steered', jobId: j.id, steerId: s1.id, how: 'resume' })
  let card = ST.cardOf(await J.byId(j.id))
  assert.equal(card.steers[0].state, 'applied')
  assert.equal(card.steers[0].applied, 'resume')
  const s2 = (await J.steer(await J.byId(j.id), userA, '둘째 지시')).steer
  await H.receive(a.link, { type: 'steer-failed', jobId: j.id, steerId: s2.id, reason: 'finishing' })
  card = ST.cardOf(await J.byId(j.id))
  assert.equal(card.steers[1].state, 'failed')
  assert.match(card.steers[1].reason, /결과를 올리는 중/)
  const s3 = (await J.steer(await J.byId(j.id), userA, '셋째 지시')).steer
  assert.equal(ST.cardOf(await J.byId(j.id)).steering, true, '보냈지만 아직 반영 전')
  await H.receive(a.link, { type: 'done', jobId: j.id, branch: 'pgpt-agent/z', pushed: true, summary: 's' })
  card = ST.cardOf(await J.byId(j.id))
  assert.equal(card.steers.find((x) => x.id === s3.id).state, 'failed')
  assert.match(card.steers.find((x) => x.id === s3.id).reason, /먼저 끝나/)
  assert.equal(card.steering, false)
  await H.gone(a.link)
})

test('턴 뒤 기다림(idle): 실행 중에만 받고 카드에 「끝낼 때」, 끝내기는 그 데스크톱에 · 결과를 받아들이는 중인 실행은 sweep 이 닫지 않는다', { skip: !db }, async () => {
  H.reset()
  const ST = await import('../lib/localAgents/steps.js')
  const a = await desktop(userA)
  const j = await J.enqueue(spec(userA))
  // not running yet: an idle report is not taken
  await H.receive(a.link, { type: 'idle', jobId: j.id, until: new Date(Date.now() + 60_000).toISOString() })
  assert.equal((await J.byId(j.id)).idle_until, null)
  await H.receive(a.link, { type: 'accept', jobId: j.id })
  const until = new Date(Date.now() + 300_000)
  await H.receive(a.link, { type: 'idle', jobId: j.id, until: until.toISOString() })
  const card = ST.cardOf(await J.byId(j.id), { worker: true })
  assert.equal(card.idleUntil, until.toISOString())
  // 「끝내기」 goes to the desktop that runs it
  const before = a.got.length
  assert.equal(J.finish(await J.byId(j.id)), true)
  assert.deepEqual(a.got.slice(before).map((m) => [m.type, m.jobId]), [['finish', j.id]])
  await H.receive(a.link, { type: 'idle', jobId: j.id, until: null })
  assert.equal((await J.byId(j.id)).idle_until, null)
  // the step closes as its result is taken in: a sweep in that moment leaves the run alone (it was cancelled before — M-02)
  J.setHooks({ cancelled: async () => true })
  try {
    await q(`update pro_local_jobs set result=$2 where id=$1`, [j.id, JSON.stringify({ branch: 'pgpt-agent/x', pushed: true })])
    await J.sweep()
    assert.equal((await J.byId(j.id)).state, 'running')
    // a run without a result whose step was closed: it stops
    await q(`update pro_local_jobs set result=null where id=$1`, [j.id])
    await J.sweep()
    assert.equal((await J.byId(j.id)).state, 'cancelled')
    assert.equal((await J.byId(j.id)).idle_until, null)
  } finally { J.setHooks({ cancelled: async () => false }) }
  await assert.rejects(async () => J.finish(await J.byId(j.id)), (e) => e.status === 409)
  await H.gone(a.link)
})

test('기다리는 실행의 카드: 「PC 앱이 켜지면 시작」, 맡길 권한이 있으면 바로 서버에 맡길 수 있다', { skip: !db }, async () => {
  H.reset()
  const ST = await import('../lib/localAgents/steps.js')
  const j = await J.enqueue(spec(userA, { offline: 'wait', waitMinutes: 60 }))
  const card = ST.cardOf(await J.byId(j.id), { canSteer: true, canDelegate: true })
  assert.match(card.text, /^PC 앱이 켜지면 시작/)
  assert.equal(card.canDelegate, true)
  assert.equal(card.canSteer, false, '아직 돌지 않는 실행은 조종하지 않는다')
  assert.equal(ST.cardOf(await J.byId(j.id), { canDelegate: false }).canDelegate, false)
  const d = await ST.delegateNow(userA, await J.byId(j.id))
  assert.equal(d.state, 'delegated')
  assert.equal(d.why, 'manual')
  assert.match(ST.cardOf(d).text, /기다리지 않고 업무 에이전트에게 맡겼어요/)
  await assert.rejects(ST.delegateNow(userA, d), /기다리는 실행만/)
})

test('로컬 실행을 끈 데스크톱에는 보내지 않는다', { skip: !db }, async () => {
  H.reset()
  const a = await desktop(userA, { prefs: { enabled: false } })
  const j = await J.enqueue(spec(userA, { offline: 'wait' }))
  assert.equal(j.state, 'queued')
  assert.deepEqual(a.jobs(), [])
  // turned on again (caps message): sent
  await H.receive(a.link, { type: 'caps', prefs: { enabled: true } })
  assert.deepEqual(a.jobs(), [j.id])
  await H.gone(a.link)
})

test('연결: WebSocket 으로 hello → welcome, 끊은 토큰은 4401, 같은 기기의 새 연결이 옛 연결을 대신한다', { skip: !db }, async () => {
  H.reset()
  const server = http.createServer()
  H.attach(server)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `ws://127.0.0.1:${server.address().port}/api/local-agents/link`
  const { token, device } = await D.issue(userA, { name: '웹소켓 맥' })
  const connect = () => new Promise((resolve) => {
    const ws = new WebSocket(url)
    const got = []
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, caps: { clis: { codex: { installed: true } } }, prefs: { enabled: true } }))
    ws.onmessage = (e) => { got.push(JSON.parse(e.data)); if (got.length === 1) resolve({ ws, got }) }
    ws.onclose = (e) => { got.push({ type: 'closed', code: e.code }); resolve({ ws, got }) }
  })
  const one = await connect()
  assert.equal(one.got[0].type, 'welcome')
  assert.equal(one.got[0].device.id, device.id)
  assert.equal(H.linksOf(T, userA.id).length, 1)
  const closed = new Promise((r) => { one.ws.onclose = (e) => r(e.code) })
  const two = await connect()
  assert.equal(two.got[0].type, 'welcome')
  assert.equal(await closed, 4409)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(H.linksOf(T, userA.id).length, 1)
  assert.equal(H.catalog(T).codex.devices, 1)
  // revoked: the link closes now and the token is refused from then on
  await D.revoke(userA, device.id)
  const gone = new Promise((r) => { two.ws.onclose = (e) => r(e.code) })
  H.closeDevice(T, device.id)
  assert.equal(await gone, 4401)
  const three = await connect()
  assert.equal(three.got[0].type, 'denied')
  assert.equal(three.got.at(-1).code, 4401)
  server.close()
})

// ---------- collaboration: who steers, opinions, skills, what a run learned ----------
// an instance with a step of `worker`, its participants, and a job for it (as the worker's desktop took it)
async function instanceWith(worker, participants, { owner = null } = {}) {
  await (await import('../lib/tenant.js')).ensureTenantRow(T).catch(() => {})
  const def = `la_unit_${crypto.randomBytes(3).toString('hex')}`
  const inst = `${def}.${crypto.randomUUID()}`
  await q(`insert into proc_def (id, name, definition, tenant_id, owner) values ($1,'시험',$2,$3,$4)`, [def, { activities: [{ id: 'quote', name: '견적서 작성', instruction: '견적서를 쓴다.', skills: ['견적-규칙'] }] }, T, owner])
  await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, tenant_id, participants) values ($1,'시험 건',$2,'RUNNING',$3,$4)`, [inst, def, T, participants.map((p) => p.id)])
  const [t] = await q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, proc_def_id, activity_id, activity_name, status, agent_mode, agent_orch, agent_config)
                       values (gen_random_uuid(), $1, $2, $3, $3, $4, 'quote', '견적서 작성', 'IN_PROGRESS', 'COMPLETE', 'pgpt-pro-local', '{"local":{"agent":"claude-code"}}') returning id::text as id`, [T, worker.id, inst, def])
  const [j] = await q(`insert into pro_local_jobs (tenant_id, user_id, todo_id, proc_inst_id, activity_name, agent, state, person_name) values ($1,$2,$3,$4,'견적서 작성','claude-code','running',$5) returning *`,
    [T, worker.id, t.id, inst, worker.name])
  return { def, inst, todo: t.id, job: j }
}
const person = (name) => ({ id: crypto.randomUUID(), name, email: `${name}@localagent.test` })

test('제안은 인스턴스를 보는 누구나, 입력은 그 CLI 를 가진 사람만: 제안을 골라 고쳐 입력하면 「<제안한 사람> 제안 · <입력한 사람> 입력」', { skip: !db }, async () => {
  H.reset()
  const ST = await import('../lib/localAgents/steps.js')
  const worker = person('윤태호'), mate = person('서하린')
  let { job, inst } = await instanceWith(worker, [worker, mate])
  // a suggestion stacks; it does not go to the CLI
  const { suggestion } = await ST.suggestOn(mate, job, 'WRITE_OUT 의견.md :: 할인 줄을 따로')
  job = await J.byId(job.id)
  assert.equal(job.steers.length, 0, '제안은 CLI 로 가지 않는다')
  assert.deepEqual(ST.cardOf(job).suggestions.map((x) => [x.name, x.state]), [['서하린', 'waiting']])
  // the worker hears of it (a Home card)
  const [n] = await q(`select title, url from notifications where user_id=$1 and type='local_suggestion'`, [worker.id])
  assert.match(n.title, /서하린의 제안 · 견적서 작성/)
  assert.match(n.url, new RegExp(inst.replace(/[.]/g, '\\.')))
  // nobody but the worker puts words in, drops a suggestion
  await assert.rejects(ST.steerAs(mate, job, '직접 입력'), (e) => e.status === 403)
  await assert.rejects(ST.steerAs(mate, job, '제안을 입력', suggestion.id), (e) => e.status === 403)
  await assert.rejects(ST.dismissSuggestion(mate, job, suggestion.id), (e) => e.status === 403)
  // the worker loads it, edits it, puts it in
  const out = await ST.steerAs(worker, job, 'WRITE_OUT 의견.md :: 할인 줄을 따로 — 윤태호가 고침', suggestion.id)
  assert.equal(out.steer.name, '윤태호')
  assert.equal(out.steer.from.name, '서하린')
  const card = ST.cardOf(out.job)
  assert.equal(card.steers[0].from, '서하린')
  const used = card.suggestions[0]
  assert.equal(used.state, 'used')
  assert.equal(used.edited, true)
  assert.equal(used.usedText, 'WRITE_OUT 의견.md :: 할인 줄을 따로 — 윤태호가 고침')
  assert.equal(used.usedBy, '윤태호')
  const [m] = await q(`select title from notifications where user_id=$1 and type='local_suggestion_used'`, [mate.id])
  assert.match(m.title, /제안이 입력됐어요/)
  await assert.rejects(ST.steerAs(worker, out.job, 'x', suggestion.id), (e) => e.status === 409)
  // the worker drops another
  const two = await ST.suggestOn(mate, out.job, '목차를 맨 앞에')
  const dropped = await ST.dismissSuggestion(worker, two.job, two.suggestion.id)
  assert.equal(ST.cardOf(dropped).suggestions[1].state, 'dismissed')
  // the worker's own suggestion makes no notice for them
  await ST.suggestOn(worker, dropped, '내 메모')
  assert.equal((await q(`select count(*)::int as n from notifications where user_id=$1 and type='local_suggestion'`, [worker.id]))[0].n, 2)
})

test('스킬 고르기: 활동의 스킬 + 활동이 부르는 에이전트의 스킬 + 담당자 자신의 비공개 스킬, 남의 비공개 스킬은 빼고 읽기 전용 토큰으로', { skip: !db }, async () => {
  const ST = await import('../lib/localAgents/steps.js')
  const H2 = await import('../lib/folders/gitHttp.js')
  const S = await import('../lib/folders/service.js')
  const worker = person('윤태호'), other = person('남궁민')
  const agent = crypto.randomUUID()
  await (await import('../lib/tenant.js')).ensureTenantRow(T).catch(() => {})
  await q(`insert into users (id, username, email, tenant_id, is_agent) values ($1,'시험 에이전트',$2,$3,true)`, [agent, `agent-${agent.slice(0, 8)}@localagent.test`, T])
  await q(`insert into tenant_skills (tenant_id, skill_name, owner_id) values ($1,'에이전트-스킬',$2) on conflict do nothing`, [T, agent])
  await q(`insert into agent_skills (user_id, skill_name, tenant_id) values ($1,'에이전트-스킬',$2)`, [agent, T])
  await q(`insert into pro_skill_visibility (tenant_id, skill_name, visibility, author_id) values ($1,'내-비공개',$2,$3),($1,'남의-비공개',$2,$4) on conflict do nothing`, [T, 'private', worker.id, other.id])
  const names = await ST.skillNames({ skills: ['견적-규칙'], agent }, worker.id)
  assert.deepEqual(names.shared.sort(), ['견적-규칙', '에이전트-스킬'].sort())
  assert.deepEqual(names.own, ['내-비공개'])
  // the ones with a folder go, each with a token that only reads; another person's private one never
  const mk = async (name) => {
    const f = await S.createFolder(worker, { name: `스킬 ${name} ${Date.now()}` })
    await q(`update pro_folders set kind='skill', settings = settings || $2 where id=$1`, [f.id, { skill_name: name }])
    return f
  }
  await mk('견적-규칙'); await mk('내-비공개'); await mk('남의-비공개')
  const list = await ST.skillsFor({ user_id: worker.id }, { skills: ['견적-규칙', '남의-비공개'] })
  assert.deepEqual(list.map((k) => k.name).sort(), ['견적-규칙', '내-비공개'].sort())
  const c = H2.verifyToken(list[0].token)
  assert.equal(c.push, '', '읽기만 하는 토큰')
  assert.deepEqual(H2.refusals([{ old: '0'.repeat(40), new: 'a'.repeat(40), ref: 'refs/heads/pgpt-agent/x' }], c.push).map((r) => r.why), ['this token may only read'])
})

test('배운 것: 판정이 「일의 방식」이라 한 조종 · 기억만 후보, 스킬 수정은 스킬 후보 — 반영은 프로세스 담당자만, 출처와 함께 활동 정의에', { skip: !db }, async () => {
  const KH = await import('../lib/localAgents/knowhow.js')
  const worker = person('윤태호'), owner = person('강대표'), mate = person('서하린')
  const { job, def } = await instanceWith(worker, [worker, mate, owner], { owner: owner.id })
  const asked = []
  KH.judge.fn = async (state, question, options) => { asked.push(state); const rule = /부가세/.test(state) && !/이번만/.test(state); return { probabilities: { rule: rule ? 0.9 : 0.1, once: rule ? 0.1 : 0.9 } } }
  const fid = crypto.randomUUID()
  const list = await KH.learn({ ...job, sent_skills: [{ name: '견적-규칙', folderId: fid }] }, {
    steers: [{ steerId: 's1', text: '금액은 늘 부가세 포함으로', by: '윤태호', from: '서하린', how: 'live', after: ['Write · 견적서.md'] }, { steerId: 's2', text: '이번만 3월 5일로', by: '윤태호', how: 'live', after: [] }],
    memory: [{ file: 'CLAUDE.md', text: '부가세 포함 금액을 쓴다' }, { file: '../x', text: '무시' }],
    skills: [{ name: '견적-규칙', folderId: fid, files: [{ path: 'SKILL.md', text: '새 규칙' }, { path: '../../etc/passwd', text: 'x' }] }],
  })
  assert.equal(asked.length, 3, '조종 둘 + 기억 하나를 판정에 물었다(이상한 파일 이름은 버림)')
  assert.match(asked[0], /견적서 작성/)
  assert.match(asked[0], /서하린 제안 · 윤태호 입력: 금액은 늘 부가세 포함으로/, '제안한 사람과 입력한 사람 둘 다')
  assert.deepEqual(list.map((k) => [k.kind, k.source]), [['activity', 'steer'], ['activity', 'memory'], ['skill', 'skill']])
  assert.deepEqual(list[2].skill.files.map((f) => f.path), ['SKILL.md'])
  const j = await J.byId(job.id)
  const c = KH.view(j.knowhow[0])
  assert.equal(c.suggestedBy, '서하린')
  assert.equal(c.by, '윤태호')
  assert.match(c.provenance, /^윤태호의 로컬 실행에서 배움 \(\d{4}-\d\d-\d\d\)$/)
  // the owner is told (a Home card that opens the instance)
  const [n] = await q(`select title, url from notifications where user_id=$1 and type='local_knowhow'`, [owner.id]).catch(() => [])
  assert.match(n?.title || '', /배운 것 3개/)
  // only the process's owner (or an admin) applies an activity's know-how; the worker may not
  await assert.rejects(KH.decide(worker, j, j.knowhow[0].id, 'apply'), (e) => e.status === 403)
  await assert.rejects(KH.decide(mate, j, j.knowhow[0].id, 'apply'), (e) => e.status === 403)
  const done = await KH.decide(owner, j, j.knowhow[0].id, 'apply')
  assert.equal(done.knowhow[0].state, 'applied')
  const [d] = await q('select definition from proc_def where id=$1', [def])
  const ins = d.definition.activities[0].instruction
  assert.match(ins, /견적서를 쓴다\.\n\n## 배운 것\n- 금액은 늘 부가세 포함으로 — 윤태호의 로컬 실행에서 배움/)
  await assert.rejects(KH.decide(owner, done, j.knowhow[0].id, 'apply'), (e) => e.status === 409)
  const dropped = await KH.decide(owner, done, j.knowhow[1].id, 'dismiss')
  assert.equal(dropped.knowhow[1].state, 'dismissed')
  // the next run of the activity reads it (its definition is what a step gets)
  const { actOf } = await import('../lib/ontology/run.js')
  const [row] = await q('select * from todolist where id::text=$1', [String(job.todo_id)])
  assert.match((await actOf(row)).instruction, /부가세 포함으로 — 윤태호의 로컬 실행에서 배움/)
  // nothing to judge, no candidates
  assert.deepEqual(await KH.learn(job, {}), [])
  // the judge cannot read (model down): still proposed, marked as unjudged — never applied by itself
  KH.judge.fn = async () => null
  const un = await KH.learn(job, { steers: [{ text: '목차를 맨 앞에', by: '서하린' }] })
  assert.equal(un.at(-1).unjudged, true)
  assert.equal(un.at(-1).state, 'proposed')
})

test('스킬 수정 후보 → 「스킬에 반영 요청」: 그 스킬 폴더의 변형에 고친 파일, 원본(main)은 그대로', { skip: !db }, async () => {
  const KH = await import('../lib/localAgents/knowhow.js')
  const S = await import('../lib/folders/service.js')
  const G = await import('../lib/folders/git.js')
  const worker = person('윤태호'), mate = person('서하린')
  const f = await S.createFolder(worker, { name: `견적-규칙 스킬 ${Date.now()}` })
  await S.upload(f, worker, 'SKILL.md', Buffer.from('---\nname: 견적-규칙\n---\n금액은 부가세 포함.\n'))
  await q(`update pro_folders set kind='skill', settings = settings || $2 where id=$1`, [f.id, { skill_name: '견적-규칙' }])
  const { job } = await instanceWith(worker, [worker, mate])
  KH.judge.fn = async () => null
  // (the skills this job was given — recorded when the desktop got the job; a skill folder it was not given is never a candidate)
  const other = await S.createFolder(mate, { name: `서하린의 비공개 스킬 ${Date.now()}` })
  await q(`update pro_folders set kind='skill', settings = settings || $2 where id=$1`, [other.id, { skill_name: '비공개-규칙' }])
  await q('update pro_local_jobs set sent_skills=$2 where id=$1', [job.id, JSON.stringify([{ name: '견적-규칙', folderId: f.id }])])
  await KH.learn({ ...job, sent_skills: [{ name: '견적-규칙', folderId: f.id }] }, { skills: [
    { name: '견적-규칙', folderId: f.id, files: [{ path: 'SKILL.md', text: '---\nname: 견적-규칙\n---\n금액은 부가세 포함.\n할인은 따로 적는다.\n' }] },
    { name: '비공개-규칙', folderId: other.id, files: [{ path: 'SKILL.md', text: '남의 비공개 스킬을 고침\n' }] },
    { name: '견적-규칙', folderId: other.id, files: [{ path: 'SKILL.md', text: '이름만 같은 다른 폴더\n' }] }] })
  const j = await J.byId(job.id)
  assert.deepEqual(j.knowhow.filter((k) => k.kind === 'skill').map((k) => k.skill.folderId), [f.id], '보낸 스킬 폴더만 후보가 된다')
  const c = j.knowhow.find((k) => k.kind === 'skill')
  await assert.rejects(KH.decide(mate, j, c.id, 'apply'), (e) => e.status === 403, '담당자가 아닌 사람')
  const done = await KH.decide(worker, j, c.id, 'apply')
  const t = done.knowhow.find((k) => k.id === c.id).target
  assert.equal(t.where, 'skill')
  assert.ok(t.variation)
  const [v] = await q('select branch from pro_folder_variations where id=$1', [t.variation])
  assert.match((await G.show(f.repo_path, v.branch, 'SKILL.md')).toString(), /할인은 따로 적는다/)
  assert.doesNotMatch((await G.show(f.repo_path, 'main', 'SKILL.md')).toString(), /할인은 따로/, '반영 전까지 원본은 그대로')
})

// ---------- relayed terminals (relay.js) ----------
test('터미널 중계: 자기 일의 터미널만 열고, 보는 사람은 같은 화면, 입력은 주인 것만, 화면 모델 · 훅 · 지켜보는 파일', { skip: !db }, async () => {
  H.reset()
  const R = await import('../lib/localAgents/relay.js')
  R.reset()
  R.registerKind('step', {
    open: async (link, ref) => { const j = await J.byId(ref); return !!j && String(j.user_id) === link.userId && String(j.device_id) === link.id },
    view: async () => true,
  })
  const a = await desktop(userA)
  const b = await desktop(userB)
  const j = await J.enqueue(spec(userA))
  assert.equal(j.state, 'offered')
  const sid = crypto.randomUUID()
  // B's desktop may not open a terminal for A's job; A's may
  await H.receive(b.link, { type: 'term-open', sid, kind: 'step', ref: j.id, agent: 'claude-code', cols: 40, rows: 6 })
  assert.equal(R.get(T, sid), null)
  await H.receive(a.link, { type: 'term-open', sid, kind: 'step', ref: j.id, agent: 'claude-code', cols: 40, rows: 6 })
  const S = R.get(T, sid)
  assert.ok(S)
  assert.equal(R.find(T, 'step', j.id), S)
  // the bytes, as they came (and B's desktop cannot write into A's terminal)
  await H.receive(a.link, { type: 'pty', sid, data: '\x1b[1m✻ Claude Code\x1b[0m\r\n❯ ' })
  await H.receive(b.link, { type: 'pty', sid, data: 'B 가 끼워 넣음' })
  assert.equal(S.buf, '\x1b[1m✻ Claude Code\x1b[0m\r\n❯ ')
  // a viewer: "what is on the screen now" from the screen model
  await R.flushed(S)
  const scr = R.screenOf(S)
  assert.deepEqual([scr.cols, scr.rows], [40, 6])
  assert.equal(scr.lines[0], '✻ Claude Code')
  assert.equal(scr.lines[1].trim(), '❯')
  // input: only A's goes to A's desktop
  const before = a.got.length
  assert.equal(R.input(S, userB.id, 'x'), false)
  assert.equal(R.input(S, userA.id, '/help'), true)
  assert.deepEqual(a.got.slice(before).map((m) => [m.type, m.data]), [['pty-input', '/help']])
  assert.deepEqual([R.stats(S).inputs, R.stats(S).dropped], [1, 1])
  assert.equal(R.resize(S, userB.id, 100, 30), false)
  // hook events and watched files reach listeners (a watcher of a later kind uses these)
  const seen = []
  const onHook = (e) => seen.push(['hook', e.event, e.ref])
  const onFiles = (e) => seen.push(['files', e.paths.join(',')])
  R.events.on('hook', onHook); R.events.on('files', onFiles)
  await H.receive(a.link, { type: 'hook', sid, event: 'Notification', data: { message: '허락을 기다려요' } })
  await H.receive(a.link, { type: 'files', sid, files: [{ path: 'aidlc/질문.md', content: '어느 쪽?', size: 9 }, { path: '../밖', content: 'x' }] })
  R.events.off('hook', onHook); R.events.off('files', onFiles)
  assert.deepEqual(seen, [['hook', 'Notification', j.id], ['files', 'aidlc/질문.md']])
  assert.equal(R.filesOf(S)['aidlc/질문.md'].content, '어느 쪽?')
  assert.equal(R.hooksOf(S)[0].data.message, '허락을 기다려요')
  // the desktop goes away: the screen stays, detached; it comes back with its screen (a restarted server builds its copy from that)
  await H.gone(a.link)
  assert.equal(R.stats(S).detached, true)
  R.reset()
  const a2 = await desktop(userA, { again: { token: a.token, device: a.device } })
  await H.receive(a2.link, { type: 'term-open', sid, kind: 'step', ref: j.id, agent: 'claude-code', cols: 40, rows: 6, replay: '다시 붙은 화면\r\n' })
  assert.equal(R.get(T, sid).buf, '다시 붙은 화면\r\n')
  await R.flushed(R.get(T, sid))
  assert.equal(R.screenOf(R.get(T, sid)).lines[0], '다시 붙은 화면')
  R.reset()
})

test('대화 중계: 항목은 모양 · 크기를 보고 한도 안에서(오래된 것부터 버림), 다시 붙어도 겹치지 않고, CLI 의 물음은 작업자만 · 열린 것만 답한다', { skip: !db }, async () => {
  H.reset()
  const R = await import('../lib/localAgents/relay.js')
  R.reset()
  R.registerKind('step', { open: async (link, ref) => { const j = await J.byId(ref); return !!j && String(j.user_id) === link.userId && String(j.device_id) === link.id }, view: async () => true })
  const a = await desktop(userA)
  const j = await J.enqueue(spec(userA))
  const sid = crypto.randomUUID()
  await H.receive(a.link, { type: 'term-open', sid, kind: 'step', ref: j.id, agent: 'claude-code', cols: 40, rows: 6 })
  const S = R.get(T, sid)
  // shape and size: an unknown kind, an item without an id, one over 64 KB are not taken
  await H.receive(a.link, { type: 'tx', sid, items: [
    { id: 'u1', t: 'user', text: '「견적서 작성」 단계', first: true }, { id: 'x1', t: 'script', text: 'x' }, { t: 'text', text: 'no id' },
    { id: 'big', t: 'text', text: 'ㄱ'.repeat(70_000) }, { id: 't1', t: 'tool', call: 'c1', name: 'Write', input: { path: '산출물/견적서.md' } }] })
  assert.deepEqual(R.txOf(S).map((x) => x.id), ['u1', 't1'])
  // another person's desktop cannot add to it
  const b = await desktop(userB)
  await H.receive(b.link, { type: 'tx', sid, items: [{ id: 'b1', t: 'text', text: '끼워 넣음' }] })
  assert.equal(R.txOf(S).length, 2)
  // the bounds: items, then bytes — the oldest go first
  const was = R.setLimits({ txItems: 5 })
  await H.receive(a.link, { type: 'tx', sid, items: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, t: 'text', text: `말 ${i}` })) })
  assert.deepEqual(R.txOf(S).map((x) => x.id), ['n1', 'n2', 'n3', 'n4', 'n5'])
  R.setLimits({ txBytes: 400 })
  await H.receive(a.link, { type: 'tx', sid, items: [{ id: 'm1', t: 'text', text: 'ㄴ'.repeat(60) }] })
  assert.ok(R.stats(S).itemBytes <= 400, JSON.stringify(R.stats(S)))
  assert.equal(R.txOf(S).at(-1).id, 'm1')
  R.setLimits(was)
  // a desktop that announces its session again sends all it has: only what is new is taken
  const before = R.txOf(S).length
  await H.receive(a.link, { type: 'tx', sid, replay: true, items: [...R.txOf(S), { id: 'r1', t: 'note', kind: 'interrupted', text: '멈춤' }] })
  assert.equal(R.txOf(S).length, before + 1)
  // what the CLI asks: open until its ask-done; only the worker answers (the desktop gets the press), only an open one
  await H.receive(a.link, { type: 'tx', sid, items: [{ id: 'k1', t: 'ask', ask: { id: 'k1', kind: 'permission', tool: 'Bash', brief: 'python3 -c "print(42)"', choices: ['yes', 'always', 'no'] } }] })
  assert.equal(R.asksOf(S).length, 1)
  const sentBefore = a.got.length
  assert.equal(R.answer(S, userB.id, 'k1', 'yes'), 'forbidden')
  assert.equal(R.answer(S, userA.id, 'nope', 'yes'), 'closed')
  assert.equal(R.answer(S, userA.id, 'k1', 'no', { by: userA.name }), true)
  assert.deepEqual(a.got.slice(sentBefore).map((m) => [m.type, m.ask, m.answer, m.byId]), [['pty-answer', 'k1', 'no', userA.id]])
  await H.receive(a.link, { type: 'tx', sid, items: [{ id: 'k1:done', t: 'ask-done', ask: 'k1', answer: 'no' }] })
  assert.equal(R.asksOf(S).length, 0)
  assert.equal(R.answer(S, userA.id, 'k1', 'yes'), 'closed')
  assert.ok(R.stats(S).dropped >= 1, 'someone else\'s press counted as dropped')
  R.reset()
})

test('터미널 · 대화를 보는 사람: 고른 흐름만 받고(대화 · 터미널), 실행이 보내졌지만 아직 터미널이 없으면 기다렸다 받는다 — 끝난 화면은 마지막 턴의 화면', { skip: !db }, async () => {
  H.reset()
  const R = await import('../lib/localAgents/relay.js')
  R.reset()
  const { WebSocket: WS } = await import('ws')
  R.registerKind('step', { open: async () => true, view: async () => true, pending: async () => true })
  const server = http.createServer()
  R.attach(server)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const open = []
  const viewer = (ref, user, streams) => new Promise((resolve) => {
    const ws = new WS(`ws://127.0.0.1:${port}/api/local-agents/term?ticket=${R.issueTicket(user, { kind: 'step', ref, tenant: T })}&streams=${streams}`, { headers: { Origin: `http://127.0.0.1:${port}` } })
    const got = []
    open.push(ws)
    ws.on('message', (d) => got.push(JSON.parse(String(d))))
    ws.on('open', () => resolve({ ws, got }))
  })
  try {
  const a = await desktop(userA)
  const j = await J.enqueue(spec(userA))
  // a viewer of the conversation comes before the terminal is open: it waits, then it is served
  const early = await viewer(j.id, userB, 'tx')
  await waitUntil(() => early.got.some((m) => m.type === 'waiting'))
  const sid = crypto.randomUUID()
  await H.receive(a.link, { type: 'term-open', sid, kind: 'step', ref: j.id, agent: 'claude-code', cols: 40, rows: 6 })
  await waitUntil(() => early.got.some((m) => m.type === 'session'))
  assert.equal(early.got.find((m) => m.type === 'session').owner, false)
  // the conversation reaches it; the terminal's bytes do not (it follows 'tx' only) — until it subscribes
  await H.receive(a.link, { type: 'pty', sid, data: '첫 화면 — 견적서를 만들었어요\r\n❯ ' })
  await H.receive(a.link, { type: 'tx', sid, items: [{ id: 'x1', t: 'text', text: '견적서를 만들었어요' }] })
  await waitUntil(() => early.got.some((m) => m.type === 'tx' && m.items?.[0]?.id === 'x1'))
  assert.ok(!early.got.some((m) => m.type === 'output'))
  early.ws.send(JSON.stringify({ type: 'subscribe', streams: ['term'] }))
  await waitUntil(() => early.got.some((m) => m.type === 'output' && m.replay))
  // a viewer that follows both: the conversation so far, from the start
  const both = await viewer(j.id, userA, 'term,tx')
  await waitUntil(() => both.got.some((m) => m.type === 'tx' && m.replay))
  assert.deepEqual(both.got.find((m) => m.type === 'tx' && m.replay).items.map((x) => x.id), ['x1'])
  assert.equal(both.got.find((m) => m.type === 'session').owner, true)
  // the turn ended (the desktop marks the screen to keep), then the CLI clears its screen on its way out: what is kept is the turn's
  await H.receive(a.link, { type: 'term-keep', sid })
  await H.receive(a.link, { type: 'pty', sid, data: '\x1b[2J\x1b[HResume this session with: claude --resume x\r\n' })
  await H.receive(a.link, { type: 'term-exit', sid, code: 0 })
  const S = R.get(T, sid)
  assert.match(S.buf, /첫 화면 — 견적서를 만들었어요/)
  assert.doesNotMatch(S.buf, /Resume this session/)
  await R.flushed(S)
  assert.equal(R.screenOf(S).lines[0], '첫 화면 — 견적서를 만들었어요')
  await waitUntil(() => both.got.filter((m) => m.type === 'output' && m.replay).length >= 2)
  assert.match(both.got.filter((m) => m.type === 'output' && m.replay).at(-1).data, /첫 화면/)
  // a run that is not on its way to a terminal: no waiting
  R.registerKind('step', { open: async () => true, view: async () => true, pending: async () => false })
  const j2 = await J.enqueue(spec(userB))
  const closed = await new Promise((resolve) => {
    const ws = new WS(`ws://127.0.0.1:${port}/api/local-agents/term?ticket=${R.issueTicket(userB, { kind: 'step', ref: j2.id, tenant: T })}`, { headers: { Origin: `http://127.0.0.1:${port}` } })
    ws.on('close', (code) => resolve(code))
    ws.on('error', () => {})
  })
  assert.equal(closed, 4404)
  } finally {
    for (const ws of open) try { ws.terminate() } catch { /* gone */ }
    R.reset()
    server.close()
  }
})
const waitUntil = async (fn, ms = 5000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }

test('제안의 종류: 의견 · 역할자의 결정(고른 항목) — 둘 다 작업자의 입력란에 쌓이고, 넣는 것은 작업자만', { skip: !db }, async () => {
  H.reset()
  const ST = await import('../lib/localAgents/steps.js')
  await desktop(userA)
  const j = await J.enqueue(spec(userA))
  const o = await J.suggest(j, userB, '목차를 맨 앞에')
  const d = await J.suggest(o.job, userB, '2', { kind: 'decision', option: '2. 부가세 포함' })
  assert.deepEqual([o.suggestion.kind, d.suggestion.kind, d.suggestion.option], ['opinion', 'decision', '2. 부가세 포함'])
  const card = ST.cardOf(d.job, { worker: true })
  assert.deepEqual(card.suggestions.map((s) => [s.kind, s.option, s.state]), [['opinion', null, 'waiting'], ['decision', '2. 부가세 포함', 'waiting']])
  await assert.rejects(ST.steerAs(userB, d.job, '2', d.suggestion.id), (e) => e.status === 403)
})


// ---------- review fixes (2026-11-24) ----------
const capsMsg = (prefs = { enabled: true, ask: true }, extra = {}) => ({ type: 'caps', caps: { clis: { 'claude-code': { installed: true, version: '2.1.330' } }, maxJobs: 2 }, prefs, ...extra })

test('기기 설정을 바꿔도(caps) 실행 중인 일은 그 데스크톱의 것으로 남는다 — 다시 보내지도, 서버에 맡기지도 않는다', { skip: !db }, async () => {
  H.reset()
  const a = await desktop(userA)
  const j = await J.enqueue(spec(userA))
  assert.equal(j.state, 'offered')
  await H.receive(a.link, { type: 'accept', jobId: j.id })
  assert.equal((await J.byId(j.id)).state, 'running')
  // 「실행 전에 묻기」를 켬: the desktop says so mid-run (with what it runs now) …
  await H.receive(a.link, capsMsg({ enabled: true, ask: true }, { active: [j.id] }))
  // … and an older desktop that says nothing of what it runs
  await H.receive(a.link, capsMsg({ enabled: true, ask: false }))
  const after = await J.byId(j.id)
  assert.equal(after.state, 'running')
  assert.equal(String(after.device_id), a.link.id)
  assert.equal(a.jobs().filter((id) => id === j.id).length, 1, '다시 보내지 않았다')
})

test('「다시 시도」: 서버에 맡겼던(또는 끝난) 단계를 다시 집으면 새로 배정한다', { skip: !db }, async () => {
  H.reset()
  calls.length = 0
  const s = spec(userA, { offline: 'server' })
  const j1 = await J.enqueue(s)
  assert.equal(j1.state, 'delegated')
  await q('update pro_local_jobs set session_id=$2, started_at=now() where id=$1', [j1.id, 'old-session'])
  const a = await desktop(userA)
  const j2 = await J.enqueue(s)
  assert.equal(j2.id, j1.id)
  assert.equal(j2.state, 'offered', '다시 큐에 들어가 켜진 데스크톱으로')
  assert.equal(String(j2.device_id), a.link.id)
  assert.equal(j2.session_id, null, '앞 실행의 세션은 잇지 않는다')
  assert.equal(j2.why, null)
  await H.receive(a.link, { type: 'accept', jobId: j2.id })
  await H.receive(a.link, { type: 'done', jobId: j2.id, branch: 'pgpt-agent/x', files: [] })
  assert.equal((await J.byId(j2.id)).state, 'done')
  // a done step picked up again (it was reopened): a new run, not a silent no-op
  const j3 = await J.enqueue(s)
  assert.equal(j3.state, 'offered')
})

test('설정이 없어진 활동의 단계도 관문(gateStep)을 지나서 서버 에이전트로 간다', { skip: !db }, async () => {
  const ST = await import('../lib/localAgents/steps.js')
  const ran = []
  const was = { run: ST.runOnServer.fn, gate: ST.deps.gate }
  ST.runOnServer.fn = async (row, gate) => { ran.push(gate) }
  try {
    const row = { id: crypto.randomUUID(), activity_name: '관문 시험', agent_config: {}, user_id: userA.id }
    ST.deps.gate = async () => ({ act: 'wait', why: ['hitl'] })
    assert.equal(await ST.take(row), null)
    assert.equal(ran.length, 0, '기다리라는 관문이면 서버 에이전트도 돌지 않는다')
    ST.deps.gate = async () => ({ act: 'skip' })
    await ST.take(row)
    assert.equal(ran.length, 0)
    ST.deps.gate = async () => ({ act: 'run', draftFirst: true, stepId: 's1', why: ['draft'] })
    await ST.take(row)
    assert.equal(ran.length, 1)
    assert.equal(ran[0].draftFirst, true, '관문이 정한 초안 먼저가 서버 에이전트에 간다')
  } finally { ST.runOnServer.fn = was.run; ST.deps.gate = was.gate }
})

test('에이전트 설정: 로컬로 바꿀 때 「초안만」을 저절로 넣었다면, 서버로 되돌리면 원래(사람의 일)로 돌아간다', () => {
  let front = { name: '견적서 작성', kind: 'task' }
  front = A.withFront(front, A.agentPatch(front, { agent: 'local:claude-code', whenOffline: 'wait', waitMinutes: 120 }))
  assert.equal(front.runner, 'draft')
  assert.equal(front.runner_before_local, 'person')
  front = A.withFront(front, A.agentPatch(front, { agent: 'local:codex', runner: 'agent' }))
  assert.equal(front.runner, 'agent')
  assert.equal(front.runner_before_local, 'person', '로컬끼리 바꿔도 처음의 것을 기억한다')
  front = A.withFront(front, A.agentPatch(front, { agent: 'onto' }))
  assert.equal(front.runner, undefined, '사람의 일로 돌아간다')
  assert.equal(front.runner_before_local, undefined)
  assert.equal(front.agent, undefined)
  // an agent's step stays an agent's step
  let ag = { name: '보관', runner: 'agent' }
  ag = A.withFront(ag, A.agentPatch(ag, { agent: 'local:claude-code', runner: 'draft' }))
  ag = A.withFront(ag, A.agentPatch(ag, { agent: 'onto' }))
  assert.equal(ag.runner, 'agent')
  // a definition saved before this (runner: draft, no memory of what it was): left as it is
  let old = { name: '검토', runner: 'draft', agent: 'local:claude-code' }
  old = A.withFront(old, A.agentPatch(old, { agent: 'onto' }))
  assert.equal(old.runner, 'draft')
})

test('활동의 에이전트로는 업무 에이전트나 담당자의 CLI 만 — deepagents · Claude Code(서버)는 맡길 서버 에이전트로만', () => {
  assert.throws(() => A.frontOf({ agent: 'deepagents' }), (e) => e.status === 400)
  assert.throws(() => A.frontOf({ agent: 'cliagents' }), (e) => e.status === 400)
  assert.deepEqual(A.frontOf({ agent: 'onto' }), { agent: null, when_offline: null, server_agent: null, wait_minutes: null })
  assert.equal(A.frontOf({ agent: 'local:claude-code', whenOffline: 'server', serverAgent: 'deepagents' }).server_agent, 'deepagents')
})

test('받겠다는 말(accept)에 서버가 답한다: 내 것이면 accepted, 더 이상 내 것이 아니면 cancel — 거둔 제안도 cancel', { skip: !db }, async () => {
  H.reset()
  const a = await desktop(userA)
  const j = await J.enqueue(spec(userA))
  await H.receive(a.link, { type: 'accept', jobId: j.id })
  assert.ok(a.got.some((m) => m.type === 'accepted' && m.jobId === j.id))
  // an offer taken back while the desktop was asking (handed to the server): the desktop is told to drop it
  const k = await J.enqueue(spec(userA, { activity: '보관' }))
  assert.equal(k.state, 'offered')
  await J.delegate(k, 'timeout')
  assert.ok(a.got.some((m) => m.type === 'cancel' && m.jobId === k.id), '거둔 제안은 그 데스크톱에 cancel')
  // its late accept: cancel again, and the job stays with the server
  const before = a.got.filter((m) => m.type === 'cancel' && m.jobId === k.id).length
  await H.receive(a.link, { type: 'accept', jobId: k.id })
  assert.equal(a.got.filter((m) => m.type === 'cancel' && m.jobId === k.id).length, before + 1)
  assert.ok(!a.got.some((m) => m.type === 'accepted' && m.jobId === k.id))
  assert.equal((await J.byId(k.id)).state, 'delegated')
  // an offer nobody answered goes back to the queue (and is offered again): the old offer is cancelled first
  const o = await J.enqueue(spec(userA, { activity: '발송' }))
  await J.sweep(Date.now() + J.OFFER_MS + 1000)
  const msgs = a.got.filter((m) => (m.type === 'job' ? m.job.id : m.jobId) === o.id).map((m) => m.type)
  assert.deepEqual(msgs.slice(0, 3), ['job', 'cancel', 'job'])
})

test('터미널 중계: 끝난 세션 · 돌아오지 않는 세션은 잠시 뒤 메모리에서 지운다(끝난 화면은 일에서)', { skip: !db }, async () => {
  H.reset()
  const R = await import('../lib/localAgents/relay.js')
  R.reset()
  const was = R.setLimits({ keepMs: 40, detachMs: 40 })
  try {
    R.registerKind('step', { open: async () => true, view: async () => true })
    const a = await desktop(userA)
    const j = await J.enqueue(spec(userA))
    const s1 = crypto.randomUUID(), s2 = crypto.randomUUID()
    await H.receive(a.link, { type: 'term-open', sid: s1, kind: 'step', ref: j.id, cols: 40, rows: 6 })
    await H.receive(a.link, { type: 'term-exit', sid: s1, code: 0 })
    assert.ok(R.get(T, s1), '끝난 직후에는 아직 있다')
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(R.get(T, s1), null)
    await H.receive(a.link, { type: 'term-open', sid: s2, kind: 'step', ref: j.id, cols: 40, rows: 6 })
    await H.gone(a.link)
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(R.get(T, s2), null, '링크가 돌아오지 않으면 지운다')
  } finally { R.setLimits(was); R.reset() }
})

test('공개 git 경로(/api/local-git): 링크된 데스크톱의 그 일 토큰만 — 클러스터 토큰 · 끊은 기기 · 남의 일 · 끝난 일의 push 는 거절', { skip: !db }, async () => {
  H.reset()
  const GH = await import('../lib/folders/gitHttp.js')
  const a = await desktop(userA)
  const b = await desktop(userB)
  const j = await J.enqueue(spec(userA))
  const F = crypto.randomUUID(), SF = crypto.randomUUID()
  await q('update pro_local_jobs set folder_id=$2, sent_skills=$3 where id=$1', [j.id, F, JSON.stringify([{ name: '견적-규칙', folderId: SF }])])
  const claims = (folder, device = a.link.id, job = j.id) => ({ tenant: T, folder, device, job, scope: 'device' })
  assert.equal(await D.gitAccess(claims(F)), null)
  assert.equal(await D.gitAccess(claims(F), { push: true }), null, '보낸 일 · 실행 중: 그 일의 가지로 올리기')
  assert.equal(await D.gitAccess(claims(SF)), null, '보낸 스킬 폴더는 읽기')
  assert.match(await D.gitAccess(claims(SF), { push: true }), /not running/)
  assert.match(await D.gitAccess(claims(crypto.randomUUID())), /does not use/)
  assert.match(await D.gitAccess(claims(F, b.link.id)), /not this desktop/)
  assert.match(await D.gitAccess(claims(F, a.link.id, crypto.randomUUID())), /not this desktop/)
  await H.receive(a.link, { type: 'accept', jobId: j.id })
  await H.receive(a.link, { type: 'done', jobId: j.id, branch: 'pgpt-agent/x', files: [] })
  assert.equal(await D.gitAccess(claims(F)), null, '끝난 뒤에도 라인을 따라가는 읽기는')
  assert.match(await D.gitAccess(claims(F), { push: true }), /not running/)
  await D.revoke(userA, a.link.id)
  assert.match(await D.gitAccess(claims(F)), /not linked/)
  // the route: no token 401, an in-cluster folder token (no device scope) 403 — before anything else is looked at
  const handler = GH.gitRoutes({ device: true, check: (c, o) => D.gitAccess(c, o) })
  const call = async (token) => {
    const res = { headersSent: false, code: 0, status(c) { this.code = c; return this }, set() { return this }, end() { this.headersSent = true } }
    await handler({ path: `/${F}.git/info/refs`, query: { service: 'git-upload-pack' }, method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} }, res)
    return res.code
  }
  assert.equal(await call(null), 401)
  assert.equal(await call(GH.mintToken({ tenant: T, folderId: F })), 403, '클러스터 안의 폴더 토큰은 공개 경로에서 받지 않는다')
  assert.equal(await call(GH.mintToken({ tenant: T, folderId: F, scope: 'device', device: a.link.id, job: j.id })), 403, '끊은 기기')
  assert.equal(GH.verifyToken(GH.mintToken({ tenant: T, folderId: F, scope: 'device', device: a.link.id, job: j.id, push: 'pgpt-agent/local-ab-' })).push, 'pgpt-agent/local-ab-')
})
