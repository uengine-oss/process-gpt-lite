// Robo-DLC Lite P3, the chat entry, end to end against a running server (docs/robo-dlc/plan-intake.md §12-2):
// work is asked for in the conversation — the request goes to the project's work intake and the plan comes
// back into the conversation as the intake app's card (message kind `app`).
//   · said outright ("작업 접수: …") by someone who may not take in work → the inbox, and they are told who decides
//   · someone in two projects is asked which one; naming it makes the request
//   · said in plain words → the router hands it over (aidlc_work); when it is unsure it asks first
// The estimate is the stand-in file (PRO_AIDLC_COMPOSE_STUB); the last test goes through the router model, so it
// needs the model the server is set up with. Skipped when the server is not up.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pool, q } from '../lib/supa.js'
import { config } from '../config.js'

const API = process.env.PRO_E2E_API || 'http://127.0.0.1:8787/api'
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'aidlc-line')
const STUB = config.aidlcComposeStub
const up = !!STUB && await fetch(`${API}/config`).then((r) => r.ok).catch(() => false)
const login = async (email) => (await (await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })).json())
const call = async (who, method, p, body) => {
  const r = await fetch(`${API}${p}`, { method, headers: { Authorization: `Bearer ${who.session.access_token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(700) }
  throw new Error(`timeout: ${what}`)
}
// one turn in the person's own conversation: the stream is read to its end, then what the turn added
const threadOf = async (who) => (await call(who, 'GET', '/threads')).body[0].id
const messages = async (who) => (await call(who, 'GET', `/threads/${await threadOf(who)}/messages`)).body
async function say(who, text) {
  const before = (await messages(who)).length
  const r = await fetch(`${API}/threads/${await threadOf(who)}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${who.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  assert.equal(r.status, 200)
  await r.text()
  return (await messages(who)).slice(before).filter((m) => m.role === 'agent')
}
const requests = async (slug) => q(`select r.* from pro_aidlc_requests r join pro_folders f on f.id=r.folder_id where f.slug=$1 order by r.created_at`, [slug])
const planned = (slug, id) => until(async () => { const x = (await requests(slug)).find((r) => r.id === id); return x.status !== 'estimating' && x }, 20000, 'the plan')

const S = (n) => ({ score: n, why: '대역' })
const scores = (n) => ({ iae: S(n), csu: S(n), ve: S(n), r: S(n), ua: S(n) })
const STUBS = [
  { match: '문구', estimate: { title: '예약 버튼 문구', kind: 'change', scores: scores(0.1), touches: { units: ['u6-web-ui'], contracts: [], requirements: [], paths: [] }, newUnits: [], conflicts: [], summary: '예약 화면의 버튼 문구를 바꿔요.' } },
  { match: '두 번', estimate: { title: '알림 메일 중복 발송', kind: 'bug', scores: scores(0.2), touches: { units: ['u5-notification-worker'], contracts: ['C6'], requirements: ['FR6.4'], paths: [] }, newUnits: [], conflicts: [], summary: '알림 작업자가 메일을 두 번 보내는 까닭을 찾아 고쳐요.' } },
  { match: '반복 예약', estimate: { title: '반복 예약', kind: 'feature', scores: scores(0.6), touches: { units: ['u2-booking-rules', 'u4-booking', 'u6-web-ui'], contracts: ['C2', 'C3'], requirements: ['FR3.1'], paths: [] }, newUnits: [], conflicts: [], summary: '매주 되풀이되는 예약을 규칙·API·화면에 더해요.' } },
]

let lead, dev, repos = [], room, loan, stamp

test('준비: 팀 리드는 두 프로젝트(회의실 예약 · 비품 대여), 개발자는 회의실 예약만', { skip: !up }, async () => {
  stamp = Date.now()
  ;[lead, dev] = await Promise.all(['lead', 'dev'].map((x) => login(`rdlc-chat-${x}-${stamp}@pgpt.test`)))
  await fs.writeFile(STUB, JSON.stringify(STUBS, null, 2))
  for (const name of [`회의실 예약 ${stamp}`, `비품 대여 ${stamp}`]) {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-chat-'))
    repos.push(repo)
    await fs.cp(FIXTURE, repo, { recursive: true })
    const git = (...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@pgpt.test', ...a], { cwd: repo })
    git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', name)
    const r = await call(lead, 'POST', '/folders/link', { path: repo, name })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    if (!room) room = r.body; else loan = r.body
  }
  assert.equal((await call(lead, 'POST', `/folders/${room.slug}/members`, { type: 'user', id: dev.user.id, role: 'editor' })).status, 200)
  assert.equal((await call(lead, 'PUT', `/aidlc/${room.slug}/roles`, { roleKey: 'team-lead', userIds: [lead.user.id] })).status, 200)
  assert.equal((await call(lead, 'PUT', `/aidlc/${room.slug}/roles`, { roleKey: 'developer', userIds: [dev.user.id] })).status, 200)
})

test('대놓고 말하기: 접수 권한이 없는 개발자의 "작업 접수: …" 는 접수함으로, 대화에는 계획안 카드가 온다', { skip: !up }, async () => {
  const got = await say(dev, '작업 접수: 예약 화면의 "예약하기" 버튼 문구를 "회의실 잡기"로 바꿔 주세요')
  const [text, card] = [got.find((m) => m.kind === 'text'), got.find((m) => m.kind === 'app')]
  assert.match(text.content.text, /작업 요청으로 넣었어요/)
  // who decides is named: the team lead takes in work here
  assert.match(text.content.text, /접수 권한이 있는 .+ 님께 알려요/)
  assert.deepEqual([card.content.app, card.content.folder, card.content.folderName], ['intake', room.slug, room.name])
  const r = await planned(room.slug, card.content.params.r)
  // the words after "작업 접수:" are the request; it waits for someone who may take in work
  assert.equal(r.body, '예약 화면의 "예약하기" 버튼 문구를 "회의실 잡기"로 바꿔 주세요')
  assert.deepEqual([r.status, r.source], ['inbox', 'chat'])
  const cardFor = await until(async () => ((await call(lead, 'GET', '/notifications')).body || []).find((n) => n.type === 'aidlc' && n.url === `/apps/intake/${room.slug}?r=${r.id}`), 15000, 'the card for the team lead')
  assert.match(cardFor.title, /접수를 기다려요/)
})

test('두 프로젝트에 있는 사람에게는 어느 프로젝트인지 묻고, 이름으로 답하면 그 프로젝트의 요청이 된다', { skip: !up }, async () => {
  const before = (await requests(room.slug)).length
  const [ask] = await say(lead, '작업 접수: 예약 알림 메일이 두 번 와요. 같은 예약인데 10분 전 알림이 두 통씩 옵니다.')
  assert.match(ask.content.text, /어느 프로젝트에 접수할까요/)
  // the two projects are offered as answers to tap
  for (const f of [room, loan]) assert.ok(ask.content.text.includes(`- ${f.name}`))
  assert.equal((await requests(room.slug)).length, before)
  const got = await say(lead, room.name)
  const card = got.find((m) => m.kind === 'app')
  assert.match(got.find((m) => m.kind === 'text').content.text, /계획안이 1분쯤 뒤 아래 카드에/)
  assert.equal(card.content.folder, room.slug)
  const r = await planned(room.slug, card.content.params.r)
  // what was asked before the question is the request, not the answer to it
  assert.match(r.body, /^예약 알림 메일이 두 번 와요/)
  assert.deepEqual([r.status, r.source, r.estimate.scope], ['proposed', 'chat', 'bugfix'])
  assert.equal((await requests(loan.slug)).length, 0)
})

test('평소 말로 부탁하기: 라우터가 작업 접수로 넘긴다(확신이 없으면 먼저 묻는다) — 모델을 거침', { skip: !up }, async () => {
  let got = await say(lead, `${room.name} 프로젝트에 반복 예약 기능을 추가해 주세요. 매주 같은 요일 같은 시간에 되풀이되게 하고 싶어요.`)
  if (!got.some((m) => m.kind === 'app')) {
    // unsure: "작업으로 접수할까요?" with the two answers — the first one makes the request
    const ask = got.find((m) => m.kind === 'text')
    assert.match(ask.content.text, /작업으로 접수할까요/)
    assert.ok(ask.content.text.includes('- 네, 작업으로 접수해 줘'))
    got = await say(lead, '네, 작업으로 접수해 줘')
  }
  const card = got.find((m) => m.kind === 'app')
  assert.ok(card, JSON.stringify(got.map((m) => m.content)))
  assert.equal(card.content.folder, room.slug)
  const r = await planned(room.slug, card.content.params.r)
  assert.match(r.body, /반복 예약 기능을 추가해 주세요/)
  assert.deepEqual([r.status, r.source, r.estimate.scope], ['proposed', 'chat', 'feature'])
})

after(async () => {
  if (STUB && up) await fs.writeFile(STUB, '[]').catch(() => {})
  for (const repo of repos) {
    const [f] = await q('select id, slug from pro_folders where repo_path=$1', [path.resolve(repo)]).catch(() => [])
    if (f) {
      for (const t of ['pro_aidlc_roles', 'pro_aidlc_requests', 'pro_aidlc_line']) await q(`delete from ${t} where folder_id=$1`, [f.id]).catch(() => {})
      await q(`update notifications set is_checked=true where type='aidlc' and url like $1`, [`/apps/%/${f.slug}%`]).catch(() => {})
      await q('delete from pro_folder_members where folder_id=$1', [f.id]).catch(() => {})
      await q('delete from pro_folders where id=$1', [f.id]).catch(() => {})
    }
    await fs.rm(repo, { recursive: true, force: true })
  }
  await pool.end().catch(() => {})
})
