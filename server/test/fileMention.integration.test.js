// 파일 멘션 · 메신저의 @AI — 실제 DB · 실제 git · 로컬 Storage, 팀 · 폴더 경로는 실제 Express 라우트에 대고(로그인만 대역), 판정 모델은 이 시험이
// 띄운 가짜 모델 서버(첫 글자 확률 길 그대로). 사람 이름은 지어낸 것이다.
//   - 끌어 놓은 항목: 폴더 파일 → 링크, 내 산출물 → 공유, 폴더에서 연 카드 → 링크, 읽을 수 없는 폴더 → 403(까닭)
//   - 멘션 보내기 → 받는 사람마다 자기 상태: 열림 · 권한 없음 → 권한 요청(폴더 주인에게 알림) → 요청함 → 구성원이 되면 열림, 바뀜(최신 열기)
//   - @AI 「차은솔 이력서 첨부해」 → AI 가 파일 멘션을 올림, 부탁한 사람이 못 읽는 폴더의 파일은 후보에도 없음, 권한 없는 사람은 이름으로 알림
//   - 폴더에 놓기: 내 산출물 · 다른 폴더의 파일(출처를 커밋 메시지에) → 내 이름의 커밋, 보기 권한이면 403
//   - AI 채팅: 끌어 놓은 폴더 파일은 folder_read 로 읽으라는 말로, 읽을 수 없으면 칩에 까닭
// Run: node --test --test-concurrency=1 test/fileMention.integration.test.js  (needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-mention-test-'))
process.env.PRO_FOLDERS_ROOT = tmp
process.env.PRO_BACKGROUND = '0'
process.env.PRO_TENANT_ID = 'localhost'
delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_DEEPAGENTS_URL = 'http://127.0.0.1:9'
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_MEMENTO_URL = 'http://127.0.0.1:9'
process.env.PRO_JUDGE_URL = ''
// the fake model: first-token odds for the option whose label holds the word the test wants for that question
const fake = { want: { '무엇을 해 달라는': '이미 있는 파일', '가리키는 자료': '차은솔' }, prompts: [], calls: 0 }
const llm = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    fake.calls++
    const b = JSON.parse(body || '{}')
    const text = b.messages?.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n') || ''
    fake.prompts.push(text)
    res.writeHead(200, { 'content-type': 'application/json' })
    if (b.logprobs) {
      const options = [...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
      const word = Object.entries(fake.want).find(([q]) => text.includes(q))?.[1]
      const hit = options.find((o) => word && o.label.includes(word)) || options.at(-1) || { letter: 'A' }
      const other = options.find((o) => o.letter !== hit.letter)?.letter || 'B'
      return res.end(JSON.stringify({ choices: [{ message: { content: hit.letter }, logprobs: { content: [{ token: hit.letter, logprob: Math.log(0.9), top_logprobs: [{ token: hit.letter, logprob: Math.log(0.9) }, { token: other, logprob: Math.log(0.1) }] }] } }] }))
    }
    res.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"네, 무엇이든 말씀해 주세요."}' }, finish_reason: 'stop' }] }))
  })
})
await new Promise((ok) => llm.listen(0, '127.0.0.1', ok))
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llm.address().port}/v1`
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_LLM_MODEL = 'fake-judge'
process.env.PRO_LLM_FAST_MODEL = 'fake-judge'

const { q, pool, admin } = await import('../lib/supa.js')
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const FR = await import('../lib/fileRefs.js')
const db = await q('select 1 from pro_folders limit 1').then(() => true).catch(() => false)

const users = [], folders = [], rooms = [], closers = []
after(async () => {
  for (const c of closers) c()
  for (const f of folders) await q('delete from pro_folders where id=$1', [f]).catch(() => {})
  for (const r of rooms) {
    await q('delete from pro_room_suggestions where room_id=$1', [r]).catch(() => {})
    await q('delete from chats where id=$1', [r]).catch(() => {})
    await q('delete from pro_chat_reads where room_id=$1', [r]).catch(() => {})
    await q('delete from chat_rooms where id=$1', [r]).catch(() => {})
  }
  const objects = []
  for (const u of users) {
    await q('delete from pro_shares where owner_id=$1 or recipient_id=$1', [u.id]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [u.id]).catch(() => {})
    await q('delete from notifications where user_id=$1 or user_id=$2 or from_user_id=$2', [u.id, u.email]).catch(() => {})
    await q('delete from pro_team_members where user_id=$1', [u.id]).catch(() => {})
    await q('delete from pro_profile where user_id=$1', [u.id]).catch(() => {})
    await q('delete from users where id=$1', [u.id]).catch(() => {})
    objects.push(...(await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/${u.id}/`]).catch(() => [])).map((r) => r.name))
  }
  for (const f of folders) objects.push(...(await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/folders/${f}/`]).catch(() => [])).map((r) => r.name))
  if (objects.length) await admin.storage.from('files').remove(objects).catch(() => {})
  await pool.end()
  llm.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function person(name) {
  const id = crypto.randomUUID()
  const u = { id, email: `mention-${id.slice(0, 8)}@example.test`, name }
  users.push(u)
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,'localhost')`, [id, u.email, name])
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [id, name, u.email])
  await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ('localhost',$1,$1) on conflict do nothing`, [id])
  return u
}
async function folderOf(owner, name, files = {}, members = []) {
  const { reindex } = await import('../lib/folders/indexer.js')
  const f = await S.createFolder(owner, { name: `${name} ${crypto.randomUUID().slice(0, 4)}` })
  folders.push(f.id)
  for (const [p, text] of Object.entries(files)) await S.upload(f, owner, p, Buffer.from(text))
  for (const [u, role] of members) await S.setMember(f, owner, { id: u.id, role })
  await reindex(f, { cards: false })
  return S.folderById(f.id)
}

let base = null
async function server() {
  if (base) return base
  const express = (await import('express')).default
  const { teamRoutes } = await import('../routes/team.js')
  const { filingRoutes } = await import('../routes/filing.js')
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  const auth = (req, res, next) => {
    const u = users.find((x) => x.id === req.headers['x-test-user'])
    if (!u) return res.status(401).json({ error: 'unauthorized' })
    req.user = { ...u }; req.session = { access_token: 'test' }; next()
  }
  app.use('/api', teamRoutes(auth))
  app.use('/api', filingRoutes(auth))
  const s = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)) })
  closers.push(() => s.close())
  base = `http://127.0.0.1:${s.address().port}/api`
  return base
}
async function call(u, method, p, body, headers = {}) {
  const raw = Buffer.isBuffer(body)
  const r = await fetch(`${await server()}${p}`, { method, headers: { 'x-test-user': u.id, ...(body != null && !raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: body == null ? undefined : raw ? body : JSON.stringify(body) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, body: json, text }
}
const sendFile = (u, name, buf, type = 'text/markdown') => call(u, 'POST', '/team/uploads', buf, { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), 'x-file-type': type })
const poll = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 200)) } }
const CV = '차은솔 — 백엔드 개발자 · 경력 7년\n주요 경력: 결제 시스템, 사내 메신저\n'

// one cast for the file: 윤태호 owns 「이력서」, 서하린 reads it (viewer), 한도윤 is not in it; 한도윤 owns 「인사 평가」 that nobody else reads
let cast = null
async function setup() {
  if (cast) return cast
  const a = await person('윤태호'), b = await person('서하린'), c = await person('한도윤')
  const cv = await folderOf(a, '이력서', { '차은솔_이력서.docx': CV, '민도현_이력서.pptx': '민도현 — 디자이너' }, [[b, 'viewer']])
  const hr = await folderOf(c, '인사 평가', { '차은솔_평가.docx': '차은솔 평가 — 비공개' })
  const t = await call(a, 'POST', '/team/threads', { members: [b.id, c.id], title: '채용 회의' })
  assert.equal(t.status, 200, t.text)
  rooms.push(t.body.id)
  cast = { a, b, c, cv, hr, room: t.body.id }
  return cast
}
const last = async (u, room) => (await call(u, 'GET', `/team/threads/${room}/messages`)).body.messages.at(-1)

test('끌어 놓은 항목: 폴더 파일은 링크, 내 산출물은 공유, 폴더에서 연 카드는 링크, 읽을 수 없는 폴더는 까닭과 함께 거절', { skip: !db }, async () => {
  const { a, c, cv } = await setup()
  const head = await G.head(cv.repo_path, 'main')
  const up = await sendFile(a, '면접_일정.md', Buffer.from('# 면접 일정\n- 차은솔 화 14:00\n'))
  const r = await call(a, 'POST', '/files/resolve', { items: [{ src: 'folder', slug: cv.slug, path: '차은솔_이력서.docx', commit: head, name: '차은솔_이력서.docx' }, { src: 'card', id: up.body.id }] })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.items[0].as, 'link')
  assert.deepEqual({ ...r.body.items[0].ref, blob: undefined }, { slug: cv.slug, folder: cv.name, path: '차은솔_이력서.docx', name: '차은솔_이력서.docx', commit: head, blob: undefined, variation: null })
  assert.match(r.body.items[0].ref.blob, /^[0-9a-f]{40}$/)
  assert.ok(!JSON.stringify(r.body).includes(cv.repo_path), '저장소 경로는 보내지 않는다')
  assert.deepEqual(r.body.items[1], { ok: true, as: 'share', name: '면접_일정.md', cardId: up.body.id })
  // a folder's file opened in the chat (folder_open's card) is a link to it, not a copy
  const [card] = await q(`insert into pro_messages(thread_id,role,kind,content) select thread_id,'agent','file',$2 from pro_messages where id=$1 returning id`,
    [up.body.id, { name: '차은솔_이력서.docx', url: 'http://127.0.0.1:54321/storage/v1/object/public/files/x.docx', folder: { slug: cv.slug, name: cv.name, path: '차은솔_이력서.docx', sha: r.body.items[0].ref.blob, editable: true } }])
  assert.equal((await call(a, 'POST', '/files/resolve', { items: [{ src: 'card', id: card.id }] })).body.items[0].as, 'link')
  // 한도윤 cannot read 「이력서」: refused, with why; someone else's card is not found
  const no = (await call(c, 'POST', '/files/resolve', { items: [{ src: 'folder', slug: cv.slug, path: '차은솔_이력서.docx', name: '차은솔_이력서.docx' }, { src: 'card', id: up.body.id, name: '면접_일정.md' }] })).body.items
  assert.deepEqual(no.map((x) => [x.ok, x.status]), [[false, 403], [false, 404]])
  assert.match(no[0].error, /구성원이 아니에요/)
  assert.equal(no[0].name, '차은솔_이력서.docx')
})

test('멘션 보내기 → 받는 사람마다 자기 상태: 열림 · 권한 없음 → 권한 요청 → 요청함 → 구성원이 되면 열림 · 바뀌면 최신 열기', { skip: !db }, async () => {
  const { a, b, c, cv, room } = await setup()
  const ref = (await call(a, 'POST', '/files/resolve', { items: [{ src: 'folder', slug: cv.slug, path: '차은솔_이력서.docx' }] })).body.items[0].ref
  // a sender who cannot read the folder cannot mention its file
  assert.equal((await call(c, 'POST', `/team/threads/${room}/messages`, { text: '이거요', refs: [ref] })).status, 403)
  const sent = await call(a, 'POST', `/team/threads/${room}/messages`, { text: '차은솔 님 이력서예요', refs: [ref] })
  assert.equal(sent.status, 200, sent.text)
  assert.equal(sent.body.kind, 'fileref')
  assert.equal(sent.body.refs[0].state.card, 'open')
  // the row keeps the reference only — no copy, no share grant
  const [row] = await q('select messages from chats where uuid=$1', [sent.body.id])
  assert.equal(row.messages.pgpt.refs[0].path, '차은솔_이력서.docx')
  assert.equal((row.messages.pgpt.artifacts || []).length, 0)
  assert.equal((await q('select count(*)::int n from pro_shares where chat_uuid=$1', [sent.body.id]))[0].n, 0)
  // 서하린 (viewer) opens it; 한도윤 (not a member) sees 「폴더 권한이 없어요」
  const mb = await last(b, room)
  assert.deepEqual([mb.refs[0].state.card, mb.refs[0].state.access], ['open', 'read'])
  const mc = await last(c, room)
  assert.equal(mc.refs[0].state.card, 'noaccess')
  assert.equal(mc.refs[0].state.changed, undefined, '권한 없는 사람에게는 바뀜 여부도 알리지 않는다')
  assert.equal((await call(c, 'POST', '/team/refs/open', { messageId: mc.id, index: 0 })).status, 403)
  // and it is in their 대화 › 나에게 온 것 (GET /team/inbox) like a share
  assert.ok((await call(b, 'GET', '/team/inbox')).body.some((m) => m.id === sent.body.id && m.kind === 'fileref'))
  const opened = await call(b, 'POST', '/team/refs/open', { messageId: mb.id, index: 0 })
  assert.equal(opened.status, 200, opened.text)
  assert.equal(opened.body.ref, 'main')
  assert.equal(opened.body.message.content.folder.editable, false, '보기 권한은 읽기 전용으로')
  assert.match(opened.body.message.content.url, /\/storage\/v1\/object\/public\/files\/pgpt-pro\/folders\//)
  // 권한 요청: the owner gets a notice that opens the folder's 공유 with the requester picked; the card says it was asked
  const asked = await call(c, 'POST', '/team/refs/request', { messageId: mc.id, index: 0 })
  assert.equal(asked.status, 200, asked.text)
  assert.deepEqual(asked.body.to, ['윤태호'])
  const [n] = await q(`select * from notifications where user_id=$1 and type='folder_access'`, [a.id])
  assert.equal(n.url, `/folders/${cv.slug}?share=${c.id}`)
  assert.match(n.title, /한도윤님이 「이력서 .{4}」 폴더 권한을 요청했어요/)
  assert.equal((await last(c, room)).refs[0].state.card, 'requested')
  await call(c, 'POST', '/team/refs/request', { messageId: mc.id, index: 0 })
  assert.equal((await q(`select count(*)::int n from notifications where user_id=$1 and type='folder_access'`, [a.id]))[0].n, 1, '같은 요청은 한 번만 알린다')
  await S.setMember(cv, a, { id: c.id, role: 'viewer' })
  assert.equal((await last(c, room)).refs[0].state.card, 'open', '구성원이 되면 열린다')
  // the file changes after the mention: 「최신 열기」 — the mention opens the version it named, latest the newest
  await S.upload(cv, a, '차은솔_이력서.docx', Buffer.from(`${CV}2026-11 갱신: 팀장 경력 추가\n`))
  const m2 = await last(b, room)
  assert.equal(m2.refs[0].state.card, 'changed')
  const then = await call(b, 'POST', '/team/refs/open', { messageId: m2.id, index: 0 })
  assert.equal(then.body.ref, ref.commit)
  assert.equal(then.body.latest, false)
  assert.equal(then.body.message.content.folder.sha, ref.blob)
  const now = await call(a, 'POST', '/team/refs/open', { messageId: m2.id, index: 0, latest: true })
  assert.equal(now.body.ref, 'main')
  assert.notEqual(now.body.message.content.folder.sha, ref.blob)
  assert.equal(now.body.message.content.folder.editable, true, '폴더 편집자가 최신을 열면 그 자리에서 고친다')
  // (the card for the office panel is in a conversation no list shows — not the main chat)
  const [th] = await q('select t.kind, t.share_ref from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1', [now.body.message.id])
  assert.deepEqual([th.kind, th.share_ref], ['files', 'messenger:links'])
  await S.removeMember(cv, { id: c.id })
})

test('@AI 「차은솔 이력서 첨부해」 → AI 가 파일 멘션을 올린다 · 부탁한 사람이 못 읽는 폴더의 파일은 후보에도 없다 · 권한 없는 사람은 알린다', { skip: !db }, async () => {
  const { a, c, room } = await setup()
  fake.prompts = []
  const sent = await call(a, 'POST', `/team/threads/${room}/messages`, { text: '@AI 차은솔 이력서 첨부해', ai: true })
  assert.equal(sent.status, 200, sent.text)
  assert.equal(sent.body.toAi, true)
  const ai = await poll(async () => { const m = await last(c, room); return m?.sender?.ai ? m : null })
  assert.ok(ai, 'AI 가 대화방에 답했다')
  assert.equal(ai.sender.name, 'AI')
  assert.equal(ai.kind, 'agent')
  assert.deepEqual(ai.refs.map((r) => r.name), ['차은솔_이력서.docx'])
  assert.match(ai.body, /「차은솔_이력서\.docx」을\(를\) 링크로 멘션했어요/)
  assert.match(ai.body, /한도윤님은 「이력서 .{4}」 폴더 권한이 없어/)
  // (한도윤 asked for this folder in the test before, and was taken out again: the card says it was asked — per folder, not per message)
  assert.equal(ai.refs[0].state.card, 'requested', '권한 없는 사람의 카드')
  // the judge was asked what the request wants, then which file — and the private folder's file was never a candidate
  const asked = fake.prompts.join('\n')
  assert.match(asked, /무엇을 해 달라는/)
  assert.match(asked, /가리키는 자료는/)
  assert.ok(!asked.includes('차은솔_평가'), '부탁한 사람이 읽을 수 없는 폴더의 파일')
  assert.ok(!JSON.stringify(ai).includes('차은솔_평가'))
  // the room's general AI 제안 did not make a second card for it
  assert.equal((await q(`select count(*)::int n from pro_room_suggestions where chat_uuid=$1`, [sent.body.id]))[0].n, 0)
  // nothing to find: said so, nothing attached
  fake.want['가리키는 자료'] = '어느 것도 아니다'
  await call(a, 'POST', `/team/threads/${room}/messages`, { text: '@AI 달빛커피 계약서 첨부해', ai: true })
  const none = await poll(async () => { const m = await last(a, room); return m?.sender?.ai && m.body.includes('달빛커피') ? m : null })
  assert.ok(none)
  assert.match(none.body, /찾지 못했어요/)
  assert.equal((none.refs || []).length, 0)
  fake.want['가리키는 자료'] = '차은솔'
})

test('폴더에 놓기: 내 산출물 · 다른 폴더의 파일(출처를 커밋 메시지에) → 내 이름의 커밋, 같은 내용은 다시 넣지 않음, 편집 권한이 없으면 403', { skip: !db }, async () => {
  const { a, b, cv } = await setup()
  const target = await folderOf(a, '채용 2026', {})
  const up = await sendFile(a, '면접_질문.md', Buffer.from('# 면접 질문\n1. 결제 장애 경험\n'))
  const head = await G.head(cv.repo_path, 'main')
  const r = await call(a, 'POST', `/folders/${target.slug}/drop`, { items: [{ src: 'card', id: up.body.id }, { src: 'folder', slug: cv.slug, path: '민도현_이력서.pptx', commit: head }] })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.body.items.map((x) => [x.ok, x.filed?.path]), [[true, '면접_질문.md'], [true, '민도현_이력서.pptx']])
  const log = await G.log(target.repo_path, 'main', 3)
  assert.equal(log[0].name, '윤태호')
  const [{ body: msg }] = [{ body: await G.git(target.repo_path, ['log', '-1', '--format=%B']) }]
  assert.match(msg, /출처: 공유 폴더 「이력서 .{4}」 민도현_이력서\.pptx @ [0-9a-f]{12}/)
  assert.equal((await G.show(target.repo_path, 'main', '민도현_이력서.pptx')).toString(), '민도현 — 디자이너')
  // the same content again: no second commit
  const again = await call(a, 'POST', `/folders/${target.slug}/drop`, { items: [{ src: 'card', id: up.body.id }] })
  assert.equal(again.body.items[0].filed.already, true)
  assert.equal((await G.log(target.repo_path, 'main', 10)).length, log.length)
  // 서하린 only reads 「이력서」: nothing goes in, said once
  const no = await call(b, 'POST', `/folders/${cv.slug}/drop`, { items: [{ src: 'folder', slug: target.slug, path: '면접_질문.md' }] })
  assert.equal(no.status, 403)
  assert.match(no.body.error, /편집 권한이 필요해요/)
})

test('AI 채팅에 놓은 파일: 폴더 파일은 folder_read 로 읽으라는 말, 내 산출물은 그 사본, 읽을 수 없으면 칩에 까닭', { skip: !db }, async () => {
  const { a, c, cv } = await setup()
  const up = await sendFile(a, '면접_일정.md', Buffer.from('# 면접 일정\n'))
  const r = await FR.turnRefs(a, [{ src: 'folder', slug: cv.slug, path: '민도현_이력서.pptx' }, { src: 'card', id: up.body.id }])
  assert.match(r.context, new RegExp(`folder_read 도구\\(folder: '${cv.slug}', path: '민도현_이력서\\.pptx'\\)`))
  assert.match(r.context, /면접_일정\.md/)
  assert.deepEqual(r.shown.map((x) => [x.as, x.name]), [['link', '민도현_이력서.pptx'], ['file', '면접_일정.md']])
  // a CLI on the person's own PC (the composer's agent picker) has no folder tools: every file by its address
  const pc = await FR.turnRefs(a, [{ src: 'folder', slug: cv.slug, path: '민도현_이력서.pptx' }, { src: 'card', id: up.body.id }], { copies: true })
  assert.doesNotMatch(pc.context, /folder_read/)
  assert.match(pc.context, /민도현_이력서\.pptx.*이 사본을 읽으세요: http/)
  assert.match(pc.context, /면접_일정\.md — http/)
  // an older version than main's: its published copy, said as the mentioned version
  const ref = (await FR.resolve(a, [{ src: 'folder', slug: cv.slug, path: '차은솔_이력서.docx' }]))[0].ref
  await S.upload(cv, a, '차은솔_이력서.docx', Buffer.from(`${CV}또 갱신\n`))
  const old = await FR.turnRefs(a, [{ src: 'folder', slug: cv.slug, path: '차은솔_이력서.docx', commit: ref.commit }])
  assert.match(old.context, /멘션한 때의 판.*이 사본을 읽으세요: http/)
  const no = await FR.turnRefs(c, [{ src: 'folder', slug: cv.slug, path: '민도현_이력서.pptx', name: '민도현_이력서.pptx' }])
  assert.equal(no.context, '')
  assert.deepEqual(no.shown, [{ name: '민도현_이력서.pptx', error: '이 폴더의 구성원이 아니에요.' }])
})

test('프로젝트가 폴더에서 만든 파일: 반영 전이면 그 변형을 가리키는 링크(구성원만), 반영 뒤에는 main', { skip: !db }, async () => {
  const { a, b, c, room } = await setup()
  const TF = await import('../lib/folders/threadFolders.js')
  const proj = await folderOf(a, '클라우드 강의', { '개요.md': '# 개요\n' }, [[b, 'viewer']])
  const [th] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','강의 준비') returning *`, [a.id])
  await TF.linkProject(a, th, proj)
  const { folder, v } = await TF.ensureProjectVariation(a, th, await TF.linkOf(th.id))
  const dir = path.join(tmp, `co-${v.id.slice(0, 6)}`)
  await S.checkout(folder, v, dir)
  fs.writeFileSync(path.join(dir, '강의준비안.md'), '# 강의 준비안\n1주차: 서비스 소개\n')
  await S.commitVariation(folder, await S.variationById(v.id), { name: a.name, email: a.email }, '프로젝트 작업')
  await S.release(folder, await S.variationById(v.id))
  // the agent's card in the project: its sandbox path in the project's checkout
  const [card] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2) returning id`,
    [th.id, { name: '강의준비안.md', path: `/workspace/.bpmn/conv1/folders/${proj.slug}/강의준비안.md` }])
  const r = (await call(a, 'POST', '/files/resolve', { items: [{ src: 'card', id: card.id }] })).body.items[0]
  assert.equal(r.as, 'link')
  assert.equal(r.ref.variation.id, v.id)
  assert.equal(r.ref.path, '강의준비안.md')
  const sent = await call(a, 'POST', `/team/threads/${room}/messages`, { text: '강의 준비안 초안', refs: [r.ref] })
  assert.equal(sent.status, 200, sent.text)
  const mb = await last(b, room)
  assert.equal(mb.refs[0].variation.title, '강의 준비')
  assert.equal(mb.refs[0].state.card, 'open', '폴더 구성원은 변형의 파일을 연다')
  assert.equal((await last(c, room)).refs[0].state.card, 'noaccess', '구성원이 아니면 못 본다')
  const opened = await call(b, 'POST', '/team/refs/open', { messageId: mb.id, index: 0 })
  assert.equal(opened.body.ref, v.id, '변형의 그 파일')
  assert.equal(opened.body.message.content.folder.editable, false)
  // its own folder takes no copy of it (a variation is merged with 「반영」)
  const self = await call(a, 'POST', `/folders/${proj.slug}/drop`, { items: [{ src: 'card', id: card.id }] })
  assert.equal(self.body.items[0].status, 409)
  // merged: main has it — a new drop of the card is a link to main
  await G.git(proj.repo_path, ['merge', '--ff-only', v.branch])
  await S.setStatus(await S.variationById(v.id), 'merged')
  const after = (await call(a, 'POST', '/files/resolve', { items: [{ src: 'card', id: card.id }] })).body.items[0]
  assert.equal(after.ref.variation, null)
  assert.equal(after.ref.commit, await G.head(proj.repo_path, 'main'))
})

test('받은 파일을 끌면: 받은 사람은 자기 사본(목록에 없는 대화에, 메인 채팅이 아님) · 보낸 사람은 원본 카드 — 둘 다 공유로', { skip: !db }, async () => {
  const { a, b, room } = await setup()
  const up = await sendFile(a, '면접_후기.md', Buffer.from('# 면접 후기\n'))
  const sent = await call(a, 'POST', `/team/threads/${room}/messages`, { text: '후기예요', artifactIds: [up.body.id] })
  assert.equal(sent.status, 200, sent.text)
  const mine = sent.body.artifacts[0].shareId
  const got = (await last(b, room)).artifacts[0].shareId
  const mainCards = async (u) => (await q(`select count(*)::int n from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and t.kind='chat' and m.kind='file'`, [u.id]))[0].n
  const before = await mainCards(b)
  const rb = (await call(b, 'POST', '/files/resolve', { items: [{ src: 'share', shareId: got }] })).body.items[0]
  assert.equal(rb.as, 'share')
  assert.notEqual(rb.cardId, up.body.id, '받은 사람은 자기 사본')
  assert.equal(await mainCards(b), before, '메인 채팅에는 아무것도 생기지 않는다')
  const ra = (await call(a, 'POST', '/files/resolve', { items: [{ src: 'share', shareId: mine }] })).body.items[0]
  assert.deepEqual([ra.as, ra.cardId], ['share', up.body.id])
  // someone else's share id: not found
  const { c } = await setup()
  assert.equal((await call(c, 'POST', '/files/resolve', { items: [{ src: 'share', shareId: got }] })).body.items[0].status, 404)
})

// ---------- code review of PR #45 ----------
test('리뷰 2: 내가 보낸 공유(내 메시지의 칩)를 폴더에 끌어 놓으면 내 원본이 들어간다 — 404 가 아니다', { skip: !db }, async () => {
  const { a, room } = await setup()
  const target = await folderOf(a, '보낸 자료', {})
  const up = await sendFile(a, '채용_일정표.md', Buffer.from('# 채용 일정표\n'))
  const sent = await call(a, 'POST', `/team/threads/${room}/messages`, { text: '일정표', artifactIds: [up.body.id] })
  const mine = sent.body.artifacts[0].shareId
  const r = await call(a, 'POST', `/folders/${target.slug}/drop`, { items: [{ src: 'share', shareId: mine, name: '채용_일정표.md' }] })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual([r.body.items[0].ok, r.body.items[0].filed?.path], [true, '채용_일정표.md'], JSON.stringify(r.body))
})

test('리뷰 4: @AI 가 다른 사람이 공유한 파일을 다시 붙이면 — 원래 주인은 자기 원본, 받은 사람마다 자기 사본(부탁한 사람이 남의 공유를 갖지 않는다)', { skip: !db }, async () => {
  const { a, b, c, room } = await setup()
  const up = await sendFile(a, '평가표_양식.md', Buffer.from('# 평가표 양식\n'))
  const orig = await call(a, 'POST', `/team/threads/${room}/messages`, { text: '평가표 양식이에요', artifactIds: [up.body.id] })
  assert.equal(orig.status, 200, orig.text)
  const ofB = (await last(b, room)).artifacts[0].shareId
  const ofC = (await last(c, room)).artifacts[0].shareId
  fake.want['가리키는 자료'] = '평가표_양식'
  try {
    await call(b, 'POST', `/team/threads/${room}/messages`, { text: '@AI 평가표 양식 첨부해', ai: true })
    const aiB = await poll(async () => { const m = await last(b, room); return m?.sender?.ai && m.artifacts?.length ? m : null })
    assert.ok(aiB, 'AI 가 공유를 다시 붙였다')
    assert.deepEqual([aiB.artifacts[0].name, aiB.artifacts[0].shareId, aiB.artifacts[0].own], ['평가표_양식.md', ofB, false], '부탁한 서하린은 자기 사본')
    const aiA = (await last(a, room)).artifacts[0]
    assert.equal(aiA.own, true, '원래 주인 윤태호는 자기 원본')
    assert.ok(aiA.shareId)
    assert.equal((await last(c, room)).artifacts[0].shareId, ofC, '한도윤은 자기 사본')
    // the owner opens it as their own card
    const opened = await call(a, 'POST', `/team/shares/${aiA.shareId}/open`)
    assert.equal(opened.body.message.id, up.body.id)
  } finally { fake.want['가리키는 자료'] = '차은솔' }
})

test('리뷰 6: 페이지가 보낸 blob 은 그 경로의 판일 때만 — 다른 파일의 blob 으로 이름만 빌려 열 수 없다', { skip: !db }, async () => {
  const { a, cv, room } = await setup()
  const other = await S.blobAt(cv, 'main', '민도현_이력서.pptx')
  const own = await S.blobAt(cv, 'main', '차은솔_이력서.docx')
  assert.notEqual(other, own)
  // resolve: the other file's blob under this path is not honoured
  const r = (await call(a, 'POST', '/files/resolve', { items: [{ src: 'folder', slug: cv.slug, path: '차은솔_이력서.docx', blob: other }] })).body.items[0]
  assert.equal(r.ok, true)
  assert.equal(r.ref.blob, own, '경로의 지금 판')
  // a send with a hand-made ref (no commit, another file's blob): the message keeps this path's own blob
  const sent = await call(a, 'POST', `/team/threads/${room}/messages`, { text: '이력서', refs: [{ slug: cv.slug, path: '차은솔_이력서.docx', name: '차은솔_이력서.docx', blob: other }] })
  assert.equal(sent.status, 200, sent.text)
  const [row] = await q('select messages from chats where uuid=$1', [sent.body.id])
  assert.equal(row.messages.pgpt.refs[0].blob, own)
  // and opening it is this file's bytes, not the other's
  const opened = await call(a, 'POST', '/team/refs/open', { messageId: sent.body.id, index: 0 })
  assert.equal(opened.body.message.content.folder.sha, own)
  // an earlier version of the same path is still a version of it (a folder_open card made before an edit)
  const before = (await G.git(cv.repo_path, ['log', '--format=%H', '-n', '2', 'main', '--', '차은솔_이력서.docx'])).trim().split('\n')[1]
  const old = await S.blobAt(cv, before, '차은솔_이력서.docx')
  const ro = (await call(a, 'POST', '/files/resolve', { items: [{ src: 'folder', slug: cv.slug, path: '차은솔_이력서.docx', blob: old }] })).body.items[0]
  assert.equal(ro.ref.blob, old)
  assert.equal(await S.blobAt(cv, ro.ref.commit, '차은솔_이력서.docx'), old, '그 판이 있던 커밋')
})

test('리뷰 7: AI 채팅의 파일 하나가 실패해도 나머지는 간다 — 그 파일만 칩에 까닭', { skip: !db }, async () => {
  const { a, cv } = await setup()
  const up = await sendFile(a, '면접_메모.md', Buffer.from('# 면접 메모\n'))
  const r = await FR.turnRefs(a, [{ src: 'folder', slug: cv.slug, path: '민도현_이력서.pptx', name: '민도현_이력서.pptx' }, { src: 'card', id: up.body.id, name: '면접_메모.md' }],
    { copies: true, deps: { publishBlob: async () => { throw new Error('storage down') } } })
  assert.equal(r.shown.length, 2)
  assert.equal(r.shown[0].name, '민도현_이력서.pptx')
  assert.ok(r.shown[0].error, '실패한 그 파일만 까닭')
  assert.deepEqual([r.shown[1].as, r.shown[1].name, r.shown[1].error], ['file', '면접_메모.md', undefined])
  assert.match(r.context, /면접_메모\.md/)
  assert.doesNotMatch(r.context, /민도현_이력서/)
})

test('리뷰 8: 사람이 쓴 「@AI …」 메시지의 멘션에 권한을 요청하면 그 사람(멘션한 사람)에게도 알린다', { skip: !db }, async () => {
  const { b, c, cv, room } = await setup()
  const ref = (await call(b, 'POST', '/files/resolve', { items: [{ src: 'folder', slug: cv.slug, path: '민도현_이력서.pptx' }] })).body.items[0].ref
  const sent = await call(b, 'POST', `/team/threads/${room}/messages`, { text: '@AI 이 파일 요약해 줘', ai: true, refs: [ref] })
  assert.equal(sent.status, 200, sent.text)
  await q(`delete from notifications where type='folder_access' and user_id = any($1)`, [[b.id, b.email]])
  const asked = await call(c, 'POST', '/team/refs/request', { messageId: sent.body.id, index: 0 })
  assert.equal(asked.status, 200, asked.text)
  assert.ok(asked.body.to.includes('서하린'), JSON.stringify(asked.body))
  assert.equal((await q(`select count(*)::int n from notifications where user_id=$1 and type='folder_access'`, [b.id]))[0].n, 1)
})
