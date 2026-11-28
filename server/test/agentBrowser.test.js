// 에이전트가 부르는 내장 브라우저(lib/agentBrowser.js · mcp/connectors/browser.js) — 판단만, 브라우저 없이:
//   · 어느 채팅인가: 에이전트의 대화(X-Conversation-Id)가 이 사람의 것일 때만 — 진행 중인 이 사람의 턴, 그다음 이 사람의 방. 다른 사람의
//     대화는 거절, 대화가 없으면 예전처럼(일하는 중인 방, 없으면 메인 채팅). 다른 사람의 대화 id 로 그 사람의 방에 닿지 않는다
//   · 사람이 있는가: 사람의 메시지에 답하는 턴만(자동 · 예약 · 서버가 지은 턴 · 멈춘 턴은 아님) — 그때 작업은 그 사람의 것(own, 사람 말,
//     계획), 아니면 읽기만
//   · 에이전트가 받는 모양: running · waiting_for_person · queued(작업 id, 마지막 몇 단계, 질문) 또는 끝난 결과(요약 · 메모 · 주소 · 페이지 글 ·
//     받은 파일), 기다림은 새 질문이 오면 바로 돌아온다
//   · 이어 하기(handback): 에이전트 턴이 끝난 뒤 끝난 작업의 결과를 한 번만 — 사람이 그 뒤에 썼으면(작업에 답한 말은 빼고) · 멈춘 턴 ·
//     이미 받은 결과 · 이어 하기에서 시작한 작업은 아님
//   · 도구 설명은 이 서버의 브라우저 스킬을 데이터로 싣는다
// 데이터베이스가 없으면 DB 시험은 건너뜀. 시험 사용자는 무작위 id(로그인 계정 아님), 끝나면 지움.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-skills-'))
fs.mkdirSync(path.join(skillsDir, 'fake-studio'))
fs.writeFileSync(path.join(skillsDir, 'fake-studio', 'SKILL.md'), `---
name: fake-studio
description: 시험용 스튜디오 사이트에서 소스로 보고서를 만들고 파일로 받아 온다.
metadata:
  runs_in: browser
  label: 스튜디오
  start_url: https://studio.example/
---
본문.
`)
process.env.PRO_BROWSER_SKILLS_DIR = skillsDir
process.env.SERVICE_ROLE_KEY ||= 'test-service-key'
process.env.ANON_KEY ||= 'test-anon-key'

const { q, pool } = await import('../lib/supa.js')
const turns = await import('../lib/turns.js')
const TP = await import('../lib/turnPlan.js')
// (loaded the way the server loads it: lib/agent.js first — mcp/connectors.js sits in an import cycle through it)
await import('../lib/agent.js')
const AB = await import('../lib/agentBrowser.js')
const B = await import('../mcp/connectors/browser.js')
const { browserSkills, _resetBrowserSkills } = await import('../lib/browserSkills.js')
_resetBrowserSkills()

const up = await q('select 1').then(() => true, () => false)
const A = crypto.randomUUID(), OTHER = crypto.randomUUID()
const made = []
async function thread(userId, kind = 'chat', conv = null, status = null) {
  const [t] = await q(`insert into pro_threads(user_id,kind,title,conversation_id,status) values ($1,$2,'시험',$3,$4) returning id`, [userId, kind, conv, status])
  made.push(t.id)
  return t.id
}
const live = []
after(async () => {
  for (const t of live) { TP.end(t); t.finish() }
  fs.rmSync(skillsDir, { recursive: true, force: true })
  if (up) {
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id = any($1))', [[A, OTHER]])
    await q('delete from pro_threads where user_id = any($1)', [[A, OTHER]])
  }
  await pool.end()
})
// an agent turn of this person, as lib/agent.js delegate leaves it: under way, answering their message, its plan card up
function liveTurn(userId, threadId, conv, more = {}) {
  const t = turns.enqueue({ userId, threadId, conv })
  Object.assign(t, { agent: true, fromUser: true, started: true, said: '이 링크를 노트북엘엠에 넣고 슬라이드와 오디오 오버뷰를 만들어 줘', ...more })
  live.push(t)
  return t
}

// ---------- 어느 채팅인가 ----------
test('대화 → 방: 진행 중인 이 사람의 턴 · 그 대화에 선 이 사람의 방 · 다른 사람의 대화는 거절 · 없으면 예전처럼', { skip: !up }, async () => {
  const main = await thread(A, 'chat')
  const room = await thread(A, 'project', `conv-room-${A}`)
  const theirs = await thread(OTHER, 'chat', `conv-other-${A}`)
  const t = liveTurn(A, room, `conv-live-${A}`)
  // the live turn (lib/mailOut.js callingTurn: this person's turns only)
  let r = await AB.resolveCaller(A, `conv-live-${A}`)
  assert.equal(r.how, 'turn')
  assert.equal(r.threadId, room)
  assert.equal(r.turn, t)
  // no live turn there: the thread standing in it
  r = await AB.resolveCaller(A, `conv-room-${A}`)
  assert.deepEqual({ how: r.how, threadId: r.threadId, turn: r.turn }, { how: 'thread', threadId: room, turn: null })
  // someone else's conversation: refused — never their thread
  r = await AB.resolveCaller(A, `conv-other-${A}`)
  assert.deepEqual(r, { refused: true })
  // the other person naming this one's live conversation: not this one's turn, not this one's thread
  r = await AB.resolveCaller(OTHER, `conv-live-${A}`)
  assert.notEqual(r.threadId, room)
  assert.equal(r.turn, null)
  assert.equal(r.threadId, theirs)
  r = await AB.resolveCaller(OTHER, `conv-room-${A}`)
  assert.deepEqual(r, { refused: true })
  // no conversation: today's guess — the newest working thread, else the main chat
  r = await AB.resolveCaller(A, null)
  assert.deepEqual({ how: r.how, threadId: r.threadId }, { how: 'main', threadId: main })
  await q(`update pro_threads set status='working' where id=$1`, [room])
  r = await AB.resolveCaller(A, null)
  assert.deepEqual({ how: r.how, threadId: r.threadId }, { how: 'working', threadId: room })
  await q(`update pro_threads set status=null where id=$1`, [room])
  // an unknown conversation (a scheduled run's own) is today's guess too
  r = await AB.resolveCaller(A, `conv-nowhere-${A}`)
  assert.equal(r.how, 'main')
})

// ---------- 사람이 있는가 ----------
test('사람이 있는 턴: 사람 메시지에 답하는 진행 중인 턴만 — 자동 · 서버가 지은 턴 · 이어 하기 · 멈춘 턴 · 끝난 턴 · 계획 카드 없는 턴은 아님', () => {
  const view = {}
  const base = { agent: true, fromUser: true, finished: false, stopped: false }
  assert.equal(AB.attendedBy(base, view), true)
  for (const [why, more] of [['routine', { auto: true }], ['composed', { composed: true }], ['handback', { handback: { taskId: 'x' } }], ['stopped', { stopped: true }],
    ['finished', { finished: true }], ['not the person\'s message (a schedule)', { fromUser: false }], ['not an agent turn', { agent: false }]]) {
    assert.equal(AB.attendedBy({ ...base, ...more }, view), false, why)
  }
  assert.equal(AB.attendedBy(base, null), false, '계획 카드가 없다')
  assert.equal(AB.attendedBy(null, view), false)
})

test('사람이 있으면 그 사람의 작업으로(own · 사람 말 · 계획), 없으면 읽기만 — 다른 사람의 대화는 시작조차 하지 않는다', { skip: !up }, async () => {
  const room = await thread(A, 'project')
  const conv = `conv-start-${A}`
  const t = liveTurn(A, room, conv)
  TP.begin({ turn: t, userId: A, threadId: room, msgId: null, text: t.said, plan: false })
  const v = TP.viewOf(t)
  v.plan = { understood: '노트북엘엠으로 만들게요', steps: [{ text: 'NotebookLM에 새 노트북 만들기' }, { text: '링크를 소스로 추가하기' }] }
  TP.handler(t, { kind: 'agent', label: '에이전트' })
  const runs = []
  const run = (args) => { const id = crypto.randomUUID(); runs.push({ ...args, id }); args.onCard(id); return new Promise((done) => { runs.at(-1).done = done }) }
  const user = { id: A, email: 'a@example.test', name: '시험' }
  const rec = await AB.startTask({ user, conv, goal: 'NotebookLM 에 이 링크로 노트북을 만들고 슬라이드와 오디오 오버뷰를 만든다', startUrl: 'https://studio.example/', skill: 'fake-studio' }, { run })
  const a = runs.at(-1)
  assert.equal(rec.attended, true)
  assert.equal(rec.id, a.id)
  assert.equal(a.threadId, room)
  assert.deepEqual({ own: a.own, unattended: a.unattended, skill: a.skill }, { own: true, unattended: false, skill: 'fake-studio' })
  assert.deepEqual(a.said, [t.said], '사람의 말 — 에이전트가 쓴 goal 이 아니다')
  assert.deepEqual(a.queue, { asked: t.said, default: 'after' })
  assert.doesNotMatch(a.goal, /읽기만/)
  assert.match(a.background, /1\. NotebookLM에 새 노트북 만들기\n2\. 링크를 소스로 추가하기/)
  // the plan card says the browser does part of the agent's work
  assert.equal(TP.viewOf(t).handler.label, '에이전트 · 브라우저 · 스튜디오')
  a.done({ state: 'done', summary: '만들었어요.', notes: [], taskId: a.id })

  // the same conversation once the turn is over: nobody is there — read only
  TP.end(t); t.finish()
  await AB.startTask({ user, conv, goal: '목록 읽기', startUrl: '' }, { run })
  const b = runs.at(-1)
  assert.equal(b.unattended, true)
  assert.equal(b.own, undefined)
  assert.equal(b.said, undefined)
  assert.match(b.goal, /^목록 읽기\n\n\(읽기만 하세요/)
  b.done({ state: 'done', summary: '', notes: [], taskId: b.id })

  // a composed turn (a teammate's words, a Home card, a handback) is not the person asking: read only
  const c = liveTurn(A, room, `conv-composed-${A}`, { composed: true })
  TP.begin({ turn: c, userId: A, threadId: room, msgId: null, text: 'x', plan: false })
  await AB.startTask({ user, conv: `conv-composed-${A}`, goal: '읽기' }, { run })
  assert.equal(runs.at(-1).unattended, true)
  runs.at(-1).done({ state: 'done', summary: '', notes: [], taskId: runs.at(-1).id })

  // someone else's conversation: refused before anything starts
  await thread(OTHER, 'chat', `conv-not-mine-${A}`)
  const n = runs.length
  await assert.rejects(AB.startTask({ user, conv: `conv-not-mine-${A}`, goal: 'x' }, { run }), (e) => e.refused === true && e.status === 403)
  assert.equal(runs.length, n)
  // a skill this server does not have: said so, with the ones it has
  await assert.rejects(AB.startTask({ user, conv, goal: 'x', skill: 'no-such' }, { run }), /no browser skill named "no-such" — use one of: .*fake-studio/)
})

// ---------- 에이전트가 받는 모양 ----------
test('기다림: 끝나면 결과(요약 · 메모 · 주소 · 페이지 글 ≤4000 · 받은 파일), 새 질문이면 바로 waiting_for_person, 아니면 시간이 되면 지금 모양', async () => {
  const running = { state: 'running', title: '오디오 만들기', progress: ['생성 누르기', '기다리는 중'], step: '기다리기', doing: 'studio.example에서 기다리는 중' }
  let now = running // what the task is doing, as lib/browser.js taskState would say
  const state = () => now
  const rec = { id: 'task-1', userId: A, attended: true, turn: null, run: new Promise(() => {}), result: null, delivered: false, seenSeq: 0, label: '브라우저' }
  // the time runs out: how it stands
  let r = await AB.follow(rec, 50, { state })
  assert.equal(r.state, 'running')
  assert.equal(r.task_id, 'task-1')
  assert.deepEqual(r.progress, ['생성 누르기', '기다리는 중'])
  assert.match(r.note, /browser_task_wait/)
  // a question to the person: back at once, with it — and only once for that question
  now = { state: 'waiting_for_person', title: '오디오 만들기', seq: 1, question: '어느 목소리로 할까요?', options: ['남자', '여자'], locked: false, progress: [] }
  const t0 = Date.now()
  r = await AB.follow(rec, 20000, { state })
  assert.ok(Date.now() - t0 < 5000, '바로 돌아온다')
  assert.deepEqual({ state: r.state, question: r.question, options: r.options }, { state: 'waiting_for_person', question: '어느 목소리로 할까요?', options: ['남자', '여자'] })
  assert.match(r.note, /Do not ask them the same thing/)
  const t1 = Date.now()
  r = await AB.follow(rec, 600, { state })
  assert.equal(r.state, 'waiting_for_person')
  assert.ok(Date.now() - t1 >= 550, '같은 질문이면 시간이 될 때까지 기다린다')
  // in line
  now = { state: 'queued', title: 'x', progress: [] }
  r = await AB.follow(rec, 10, { state })
  assert.equal(r.state, 'queued')
  // over: the result, page text capped, files with where they are
  rec.result = { state: 'done', summary: '오디오 보고서를 받았어요.', notes: ['노트북: 시험'], url: 'https://studio.example/', pageText: 'x'.repeat(5000),
    files: [{ name: '오디오 보고서.m4a', url: 'https://files.example/a.m4a', path: '/workspace/uploads/u/1/오디오 보고서.m4a' }, { name: 'b.pdf', url: 'https://files.example/b.pdf' }] }
  r = await AB.follow(rec, 10, { state })
  assert.equal(r.state, 'done')
  assert.equal(r.summary, '오디오 보고서를 받았어요.')
  assert.deepEqual(r.notes, ['노트북: 시험'])
  assert.equal(r.page_text.length, 4000)
  assert.deepEqual(r.files, [{ name: '오디오 보고서.m4a', url: 'https://files.example/a.m4a', path: '/workspace/uploads/u/1/오디오 보고서.m4a' }, { name: 'b.pdf', url: 'https://files.example/b.pdf' }])
  assert.match(r.files_note, /already in the chat as file cards/)
  assert.equal(rec.delivered, true, '에이전트가 결과를 받았다')
  // nobody watching: said so
  assert.match(AB.liveShape({ id: 'x', attended: false }, null).note, /only reads/)
  assert.match(AB.resultShape({ id: 'x', attended: false, result: { state: 'done', notes: [] } }).note, /only reads/)
})

test('말 전하기: 브라우저를 잡고 있지 않은 작업에는 아무것도 전하지 않는다', async () => {
  const r = await AB.say({ id: crypto.randomUUID(), userId: A, result: null }, '이름은 「시험」으로')
  assert.equal(r.ok, false)
  assert.match(r.note, /nothing was passed on/)
})

test('작업 찾기: 이 사람의 것만 — 다른 사람의 작업 id 는 없는 것과 같다', { skip: !up }, async () => {
  const tid = await thread(A, 'chat')
  const [card] = await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','task',$2) returning id`, [tid, { title: '읽기', state: 'done', summary: '읽었어요.', notes: ['하나'], url: 'https://a.example/' }])
  assert.equal(await AB.ownTask(OTHER, card.id), null)
  const rec = await AB.ownTask(A, card.id)
  assert.equal(rec.threadId, tid)
  const r = await AB.follow(rec, 50, { state: () => null })
  assert.deepEqual({ state: r.state, summary: r.summary, notes: r.notes, url: r.url }, { state: 'done', summary: '읽었어요.', notes: ['하나'], url: 'https://a.example/' })
  assert.equal(await AB.ownTask(A, 'not-an-id'), null)
})

// ---------- 이어 하기 ----------
test('이어 하기: 턴이 끝난 뒤 끝난 작업은 한 번만 이어서 — 사람이 그 뒤에 썼으면 · 멈춘 턴 · 이미 받은 결과 · 이어 하기의 작업은 아님', { skip: !up }, async () => {
  const tid = await thread(A, 'project', `conv-hb-${A}`)
  const ran = []
  const deps = { runTurn: (a) => { ran.push(a); return Promise.resolve(null) }, sessionOf: async (id) => ({ user: { id }, session: { access_token: 'fresh' } }), asUser: (id, fn) => fn() }
  const rec = (more = {}) => ({ id: crypto.randomUUID(), userId: A, user: { id: A, email: 'a@example.test', name: '시험' }, threadId: tid, conv: `conv-hb-${A}`, attended: true,
    turn: { finished: true, stopped: false }, turnEndedAt: Date.now() - 2000, delivered: false, goal: '노트북 만들기', title: '노트북 만들기', steps: ['노트북 만들기', '슬라이드 만들기'],
    result: { state: 'done', summary: '노트북과 슬라이드를 만들었어요.', notes: ['슬라이드 12장'], url: 'https://nb.example/1', pageText: '페이지', files: [{ name: '오디오.m4a', url: 'https://files.example/o.m4a' }] }, ...more })
  const r1 = rec()
  let out = await AB.handback(r1, deps)
  assert.equal(out.started, true)
  const a = ran.at(-1)
  assert.deepEqual({ threadId: a.threadId, composed: a.composed, conv: a.conversation?.id, session: a.session.access_token }, { threadId: tid, composed: true, conv: `conv-hb-${A}`, session: 'fresh' })
  assert.deepEqual(a.handback, { taskId: r1.id, conv: `conv-hb-${A}`, title: '노트북 만들기' })
  assert.equal(a.text, '브라우저 작업 「노트북 만들기」이(가) 끝났어요. 결과를 보고 남은 일을 이어서 해 주세요.')
  for (const s of ['사람이 쓴 말이 아니에요', '1. 노트북 만들기\n2. 슬라이드 만들기', `[browser_task ${r1.id}] state: done`, 'summary: 노트북과 슬라이드를 만들었어요.', '- 슬라이드 12장', 'url: https://nb.example/1', '- 오디오.m4a: https://files.example/o.m4a', 'page_text:\n페이지']) {
    assert.ok(a.context.includes(s), s)
  }
  // once only
  out = await AB.handback(r1, deps)
  assert.equal(out.started, false)
  assert.equal(ran.length, 1)
  // the person wrote since the turn ended: no
  const r2 = rec()
  await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'user','text','{"text":"다른 거 해 줘"}')`, [tid])
  assert.deepEqual(await AB.handback(r2, deps), { started: false, why: 'wrote' })
  // …but words that went to that task as its answer do not count (its acknowledgement carries the task's id)
  await new Promise((ok) => setTimeout(ok, 60))
  const r3 = rec({ turnEndedAt: Date.now() })
  await new Promise((ok) => setTimeout(ok, 60))
  await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'user','text','{"text":"여자 목소리"}'), ($1,'agent','text',$2)`, [tid, { text: '답으로 전했어요.', answered: r3.id }])
  assert.equal((await AB.handback(r3, deps)).started, true)
  // a stopped turn, a result the agent read, a task a handback started: no
  for (const more of [{ turn: { finished: true, stopped: true } }, { delivered: true }, { fromHandback: true }]) {
    const n = ran.length
    assert.equal((await AB.handback(rec({ turnEndedAt: Date.now(), ...more }), deps)).started, false, JSON.stringify(more))
    assert.equal(ran.length, n)
  }
  // a turn under way in that thread: no
  const t = liveTurn(A, tid, 'conv-busy')
  assert.deepEqual(await AB.handback(rec({ turnEndedAt: Date.now() }), deps), { started: false, why: 'busy' })
  TP.end(t); t.finish()
  // switched off
  process.env.PRO_BROWSER_HANDBACK = '0'
  assert.equal(AB.handbackOn(), false)
  delete process.env.PRO_BROWSER_HANDBACK
  assert.equal(AB.handbackOn(), true)
})

// ---------- 도구 설명 ----------
test('도구 설명: 이 서버의 브라우저 스킬을 이름 · 이름표 · 설명으로 싣고, skill 은 그 이름 중 하나 — 사람이 기다리는 동안의 일도 말한다', () => {
  const d = B.TASK_DESCRIPTION()
  for (const s of browserSkills()) assert.ok(d.includes(`- ${s.name}${s.label ? ` (${s.label})` : ''}: `), s.name)
  assert.ok(d.includes('- fake-studio (스튜디오): 시험용 스튜디오 사이트에서'))
  assert.match(d, /no API tool here \(NotebookLM, for instance\), or when the person named the site/)
  assert.match(d, /nobody watches .* only reads/)
  const task = B.browserConnector.tools.find((t) => t.name === 'browser_task')
  const skill = task.input().skill
  assert.deepEqual([...skill.unwrap().options].sort(), browserSkills().map((s) => s.name).sort())
  assert.match(B.WAIT_DESCRIPTION(), /waiting_for_person the person is being asked on the browser card in the chat/)
  assert.match(B.WAIT_DESCRIPTION(), /do not ask them the same thing again/)
  assert.match(B.SAY_DESCRIPTION(), /never approve a payment/)
  assert.deepEqual(B.browserConnector.tools.map((t) => t.name), ['browser_task', 'browser_task_wait', 'browser_task_say'])
})

test('시작 주소: 공개 주소, 또는 회사가 허락한 내부 주소만', async () => {
  assert.equal(B.publicAddress('https://notebook.google.com/'), true)
  for (const u of ['http://localhost:8787/', 'http://10.0.0.2/', 'http://svc.default.svc/', 'ftp://a.example/', 'not a url']) assert.equal(B.publicAddress(u), false, u)
  const { allowedHere } = await import('../lib/privateNet.js')
  assert.equal(allowedHere('http://127.0.0.1:9/x', []), false)
  assert.equal(allowedHere('http://127.0.0.1:9/x', [{ host: '127.0.0.1' }]), true)
  assert.equal(allowedHere('http://mailpit:8025/', [{ host: 'mailpit' }]), false, '메일함은 허락해도 열지 않는다')
})
