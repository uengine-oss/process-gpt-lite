// The chat's agent picker (lib/localAgents/chat.js — design docs/local-agents/design.md §12, spec openspec/specs/local-agents
// 「채팅에서 고르는 에이전트」) with fake desktop links (what a link is sent is recorded) and the database:
//   · what the picker offers from the desktops' caps (none · off · on · local runs off · a desktop before 0.2.2 · a CLI it lacks)
//   · the choice kept per chat (a thread, one conversation of it), per person; nonsense refused
//   · a message → a local job of kind 'chat' for the sender's own desktop only (never another person's), tagged in the chat, its card
//   · the same chat and agent: the next message goes into the open run (a steer) — after it ended, a new run that resumes its session
//   · a turn's reply: an assistant message, once per turn
//   · who: only the sender sees, types, ends, falls back (403); a project folder's member sees, never types
// Run: node --test test/chatAgents.test.js  (needs the local database with sql/055; rows go to the test tenant "chatagent-test")
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_TENANT_ID = 'chatagent-test'
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
process.env.PRO_DESKTOP_LATEST = '0.2.3'
const os = await import('node:os')
const fsp = await import('node:fs/promises')
const FROOT = await fsp.mkdtemp((await import('node:path')).join(os.tmpdir(), 'pgl-ca-unit-'))
process.env.PRO_FOLDERS_ROOT = FROOT
const { q, pool } = await import('../lib/supa.js')
const D = await import('../lib/localAgents/devices.js')
const H = await import('../lib/localAgents/hub.js')
const J = await import('../lib/localAgents/jobs.js')
const ST = await import('../lib/localAgents/steps.js')
const CH = await import('../lib/localAgents/chat.js')
const db = await q(`select kind, thread_id, chat from pro_local_jobs limit 1`).then(() => true).catch(() => false)
const T = 'chatagent-test'

const users = []
async function person(name) {
  const u = { id: crypto.randomUUID(), name, email: `${crypto.randomBytes(3).toString('hex')}@chatagent.test` }
  users.push(u.id)
  await q(`insert into pro_profile (user_id, name, email) values ($1,$2,$3) on conflict (user_id) do update set name=$2`, [u.id, name, u.email]).catch(() => {})
  return u
}
async function thread(user, kind = 'chat', title = '채팅') {
  const [t] = await q(`insert into pro_threads (user_id, kind, title) values ($1,$2,$3) returning *`, [user.id, kind, title])
  return t
}
// a desktop as the hub sees it: what it is sent is recorded (its 'accept' is not sent here — jobs stay 'offered' until a test says so)
async function desktop(user, { clis = { 'claude-code': { installed: true, version: '2.1.330' }, codex: { installed: true, version: '0.162.1' } }, prefs = { enabled: true }, chat = true } = {}) {
  const { token, device } = await D.issue(user, { name: `${user.name}의 맥`, platform: 'darwin' })
  const got = []
  const transport = { send: (t) => got.push(JSON.parse(t)), close: (code) => { got.push({ type: 'closed', code }) } }
  const link = await H.open(transport, { type: 'hello', token, device: { name: `${user.name}의 맥` }, caps: { clis, maxJobs: 2, terminal: true, conversation: true, chat }, prefs, active: [] })
  assert.ok(!link.error, link.error)
  return { link, got, device, token, jobs: () => got.filter((m) => m.type === 'job').map((m) => m.job) }
}
const messagesOf = (t) => q('select * from pro_messages where thread_id=$1 order by created_at', [t.id])
const sendOf = (user, t, text, agent = 'claude-code', extra = {}) => CH.send({ user, thread: t, text, agent, ...extra })
const waitUntil = async (fn, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)) } }

before(async () => {
  if (!db) return
  ST.wire()
  CH.wireChat()
})
after(async () => {
  if (db) {
    for (const t of ['pro_local_jobs', 'pro_local_devices', 'pro_chat_agents', 'pro_folders']) await q(`delete from ${t} where tenant_id=$1`, [T]).catch(() => {})
    for (const u of users) {
      await q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [u]).catch(() => {})
      await q(`delete from pro_thread_folders where user_id=$1`, [u]).catch(() => {})
      await q(`delete from pro_threads where user_id=$1`, [u]).catch(() => {})
      await q(`delete from pro_profile where user_id=$1`, [u]).catch(() => {})
    }
  }
  H.reset()
  await pool.end()
  await fsp.rm(FROOT, { recursive: true, force: true })
})

test('채팅 열쇠: 대화, 그 안의 맥락 갈래 — 이상한 갈래 id 는 버린다', () => {
  assert.equal(CH.keyOf('t1'), 't1')
  assert.equal(CH.keyOf('t1', 'c-9'), 't1:c-9')
  assert.equal(CH.convOf({ id: 'abc_1', title: 'x' }), 'abc_1')
  assert.equal(CH.convOf('a b'), null)
  assert.equal(CH.convOf(null), null)
  assert.deepEqual(CH.cardable(['회의록.md', '.claude/settings.json', 'a/.pgl-run/x', 'CLAUDE.md', 'docs/안내.md', '회의록.md']), ['회의록.md', 'docs/안내.md'])
})

test('고르기에 보이는 것: 데스크톱이 알린 CLI 로 — 없음 · 꺼짐 · 켜짐 · 실행 끔 · 0.2.2 전 · 없는 CLI', { skip: !db }, async () => {
  const a = await person('윤태호')
  const ids = (r) => r.agents.map((x) => x.id)
  // never linked: both, off, with why
  let r = await CH.availability(a)
  assert.deepEqual(ids(r), ['default', 'claude-code', 'codex'])
  assert.ok(r.agents.slice(1).every((x) => !x.available && /PC 앱을 설치/.test(x.why)))
  assert.equal(r.desktop.linked, 0)
  assert.match(r.download, /#desktop$/)
  // a desktop with only Claude Code, on
  const d = await desktop(a, { clis: { 'claude-code': { installed: true }, codex: { installed: false } } })
  r = await CH.availability(a)
  assert.deepEqual(ids(r), ['default', 'claude-code'], 'only the CLIs it reports')
  assert.equal(r.agents[1].available, true)
  assert.deepEqual(r.agents[1].devices, ['윤태호의 맥'])
  // it goes off: what it said last, off with why
  await H.gone(d.link)
  r = await CH.availability(a)
  assert.deepEqual(ids(r), ['default', 'claude-code'])
  assert.equal(r.agents[1].available, false)
  assert.equal(r.agents[1].why, 'PC 앱이 꺼져 있어요')
  // on, with local runs turned off · a desktop before 0.2.2 (no chat)
  const off = await desktop(a, { prefs: { enabled: false } })
  r = await CH.availability(a)
  assert.equal(r.agents.find((x) => x.id === 'claude-code').available, false)
  assert.match(r.agents.find((x) => x.id === 'claude-code').why, /실행이 꺼져/)
  await H.gone(off.link)
  const old = await desktop(a, { chat: false })
  r = await CH.availability(a)
  assert.match(r.agents.find((x) => x.id === 'codex').why, /0\.2\.2/)
  await H.gone(old.link)
})

test('막 짝지은 데스크톱(아직 CLI 를 알리지 않음): CLI 를 숨기지 않고 꺼진 채 보인다 · 가장 새 데스크톱 판', { skip: !db }, async () => {
  const a = await person('한서윤')
  // paired a moment ago (a device token issued), its first link not up yet: no CLIs reported
  await D.issue(a, { name: '한서윤의 맥', platform: 'darwin', appVersion: '0.2.2' })
  const r = await CH.availability(a)
  assert.deepEqual(r.agents.map((x) => x.id), ['default', 'claude-code', 'codex'], 'both stay in the list')
  assert.ok(r.agents.slice(1).every((x) => !x.available && x.why === 'PC 앱이 꺼져 있어요'))
  assert.equal(r.desktop.linked, 1)
  assert.equal(r.desktop.online, 0)
  assert.equal(r.desktop.latest, '0.2.3', 'PRO_DESKTOP_LATEST')
})

test('고른 것은 대화마다 · 사람마다 남는다, 고를 수 없는 것은 400', { skip: !db }, async () => {
  const a = await person('윤태호')
  const b = await person('서하린')
  const t = await thread(a)
  await CH.choose(a, t.id, 'claude-code')
  await CH.choose(a, `${t.id}:conv-1`, 'codex')
  assert.equal(await CH.choiceOf(a, t.id), 'claude-code')
  assert.equal(await CH.choiceOf(a, `${t.id}:conv-1`), 'codex')
  assert.equal(await CH.choiceOf(a, `${t.id}:conv-2`), 'default')
  assert.equal(await CH.choiceOf(b, t.id), 'default')
  await CH.choose(a, t.id, 'default')
  assert.equal(await CH.choiceOf(a, t.id), 'default')
  assert.equal((await q('select count(*)::int as n from pro_chat_agents where user_id=$1 and chat_key=$2', [a.id, t.id]))[0].n, 0, '기본 is no row')
  await assert.rejects(CH.choose(a, t.id, 'bash'), (e) => e.status === 400)
})

test('메시지 → 보낸 사람 자신의 데스크톱에만 가는 chat 일 · 메시지에 붙는 표시 · 대화 속 실행 카드', { skip: !db }, async () => {
  const a = await person('윤태호')
  const b = await person('서하린')
  const t = await thread(a)
  const hers = await desktop(b)
  const r0 = await sendOf(a, t, '회의록 만들어 줘')
  let job = await J.byId(r0.jobId)
  assert.equal(job.kind, 'chat')
  assert.equal(String(job.thread_id), t.id)
  assert.equal(job.chat.key, t.id)
  assert.equal(job.state, 'queued', 'his desktop is off: it waits')
  assert.equal(job.why, 'waiting')
  assert.equal(hers.jobs().length, 0, 'never another person\'s desktop')
  // his desktop comes on: it gets it
  const mine = await desktop(a)
  job = await J.byId(job.id)
  assert.equal(job.state, 'offered')
  const sent = mine.jobs().find((x) => x.id === job.id)
  assert.equal(sent.kind, 'chat')
  assert.equal(sent.chat.key, t.id)
  assert.match(sent.prompt, /회의록 만들어 줘/)
  assert.equal(sent.message, '회의록 만들어 줘')
  assert.ok(sent.git.token && sent.git.branch.startsWith(`pgpt-agent/local-${job.id.slice(0, 8)}-`))
  assert.equal(sent.git.base, 'main')
  assert.equal(sent.resume, undefined)
  // his folder: made now, his alone
  const f = (await q(`select * from pro_folders where id=$1`, [sent.git.folder.id]))[0]
  assert.equal(f.settings.local_chat.owner, a.id)
  // in the chat: his message with its agent, then the run's card
  const ms = await messagesOf(t)
  assert.deepEqual(ms.map((m) => m.kind), ['text', 'local_run'])
  assert.deepEqual(ms[0].content.agent, { id: 'claude-code', label: 'Claude Code', where: '내 PC' })
  assert.equal(ms[1].content.chat, true)
  assert.equal(ms[1].content.jobId, job.id)
  await H.gone(mine.link); await H.gone(hers.link)
})

test('같은 대화 · 같은 에이전트: 열린 실행에는 이어서(입력), 끝난 뒤에는 그 세션을 잇는 새 실행', { skip: !db }, async () => {
  const a = await person('윤태호')
  const t = await thread(a)
  const mine = await desktop(a)
  const r1 = await sendOf(a, t, '첫 말')
  await J.onMessage(mine.link, { type: 'accept', jobId: r1.jobId })
  await J.onMessage(mine.link, { type: 'session', jobId: r1.jobId, sessionId: 'sess-1' })
  // the next message: into the same run (a steer to its desktop), no new job
  const r2 = await sendOf(a, t, '둘째 말')
  assert.equal(r2.jobId, r1.jobId)
  assert.equal(r2.steered, true)
  assert.ok(mine.got.some((m) => m.type === 'steer' && m.jobId === r1.jobId && m.text === '둘째 말'))
  // (the CLI took it: its desktop says so)
  const s2 = mine.got.find((m) => m.type === 'steer' && m.text === '둘째 말')
  await J.onMessage(mine.link, { type: 'steered', jobId: r1.jobId, steerId: s2.steerId, how: 'live' })
  // another agent of the same chat: a run of its own
  const r3 = await sendOf(a, t, '코덱스에게', 'codex')
  assert.notEqual(r3.jobId, r1.jobId)
  // the run ends (its wait ran out): the next message starts a run that resumes its session
  await J.onMessage(mine.link, { type: 'done', jobId: r1.jobId, branch: '', pushed: false, files: [], summary: '', sessionId: 'sess-1' })
  assert.equal((await J.byId(r1.jobId)).state, 'done')
  const r4 = await sendOf(a, t, '셋째 말')
  assert.notEqual(r4.jobId, r1.jobId)
  const j4 = await J.byId(r4.jobId)
  assert.equal(j4.chat.resumeOf, 'sess-1')
  const sent = mine.jobs().find((x) => x.id === r4.jobId)
  assert.deepEqual(sent.resume, { sessionId: 'sess-1' })
  assert.equal(sent.message, '셋째 말')
  // (the recap is in its prompt for a desktop that no longer has the session)
  assert.match(sent.prompt, /이 대화의 앞부분/)
  assert.match(sent.prompt, /첫 말/)
  // a message that reached the run as it was closing (never taken): the chat's next run starts with it, in the same session
  await J.onMessage(mine.link, { type: 'accept', jobId: r4.jobId })
  await J.onMessage(mine.link, { type: 'session', jobId: r4.jobId, sessionId: 'sess-1' })
  await sendOf(a, t, '넷째 말')
  const s4 = mine.got.find((m) => m.type === 'steer' && m.text === '넷째 말')
  await J.onMessage(mine.link, { type: 'steer-failed', jobId: r4.jobId, steerId: s4.steerId, reason: 'finishing' })
  await J.onMessage(mine.link, { type: 'done', jobId: r4.jobId, branch: '', pushed: false, files: [], summary: '', sessionId: 'sess-1' })
  const carried = await waitUntil(async () => (await q(`select * from pro_local_jobs where thread_id=$1 and kind='chat' and agent='claude-code' and state in ('queued','offered') order by created_at desc limit 1`, [t.id]))[0])
  assert.equal(carried.chat.message, '넷째 말')
  assert.equal(carried.chat.resumeOf, 'sess-1')
  await H.gone(mine.link)
})

test('턴의 답: 보통의 답 메시지로 한 번 — 같은 턴을 다시 말해도 두 번 올리지 않는다', { skip: !db }, async () => {
  const a = await person('윤태호')
  const t = await thread(a)
  const mine = await desktop(a)
  const r = await sendOf(a, t, '요약해 줘')
  await J.onMessage(mine.link, { type: 'accept', jobId: r.jobId })
  await J.onMessage(mine.link, { type: 'reply', jobId: r.jobId, turn: 1, text: '요약했어요', pushed: false, files: [] })
  await J.onMessage(mine.link, { type: 'reply', jobId: r.jobId, turn: 1, text: '요약했어요', pushed: false, files: [] })
  const answers = (await messagesOf(t)).filter((m) => m.role === 'agent' && m.kind === 'text')
  assert.equal(answers.length, 1)
  assert.equal(answers[0].content.text, '요약했어요')
  assert.equal(answers[0].content.localAgent.jobId, r.jobId)
  assert.equal(mine.got.filter((m) => m.type === 'replied' && m.jobId === r.jobId).length, 2, 'each said again is acknowledged')
  await H.gone(mine.link)
})

test('누가: 보낸 사람만 보고 · 입력하고 · 끝내고 · 다시 보낸다(그 밖 403) — 프로젝트 폴더의 구성원은 보기만', { skip: !db }, async () => {
  const a = await person('윤태호')
  const b = await person('서하린')
  const t = await thread(a)
  const mine = await desktop(a)
  const r = await sendOf(a, t, '견적서 써 줘')
  await J.onMessage(mine.link, { type: 'accept', jobId: r.jobId })
  const job = await J.byId(r.jobId)
  assert.equal(await CH.canSee(a, job), true)
  assert.equal(await CH.canSee(b, job), false)
  await assert.rejects(ST.steerAs(b, job, '내 말'), (e) => e.status === 403)
  await assert.rejects(ST.finishNow(b, job), (e) => e.status === 403)
  await assert.rejects(ST.answerAsk(b, job, 'a1', 1), (e) => e.status === 403)
  await assert.rejects(CH.fallback(b, job), (e) => e.status === 403)
  assert.equal((await ST.cardFor(b, job)).worker, false)
  // the sender falls back: the run stops, the words without an answer come back
  const back = await CH.fallback(a, job)
  assert.equal(back.text, '견적서 써 줘')
  assert.equal((await J.byId(job.id)).state, 'cancelled')
  assert.ok(mine.got.some((m) => m.type === 'cancel' && m.jobId === job.id))
  // a project in a shared folder: its members watch (never type); one who may only run it cannot send to their PC (edit rights)
  const S = await import('../lib/folders/service.js')
  const TF = await import('../lib/folders/threadFolders.js')
  const folder = await S.createFolder(a, { name: `세미나 폴더 ${crypto.randomBytes(2).toString('hex')}` })
  const p = await thread(a, 'project', '세미나')
  await TF.linkProject(a, p, folder)
  const rp = await sendOf(a, p, '좌석 배치 정리해 줘')
  const pj = await J.byId(rp.jobId)
  assert.equal(pj.chat.mode, 'project')
  assert.match(pj.chat.line, /^var\/p\//)
  assert.equal(await CH.canSee(b, pj), false)
  await S.setMember(folder, a, { id: b.id, role: 'runner' })
  assert.equal(await CH.canSee(b, pj), true)
  await assert.rejects(ST.steerAs(b, pj, '내 말'), (e) => e.status === 403)
  const hp = await thread(b, 'project', '세미나 보조')
  await TF.linkProject(b, hp, folder)
  await assert.rejects(sendOf(b, hp, '내 PC 로'), (e) => e.status === 403 && /편집자/.test(e.message))
  await H.gone(mine.link)
})
