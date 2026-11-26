// 메신저에서 컴퓨터의 파일 보내기 · 들어온 문서를 폴더에 정리 (2026-11-24 운영 화면: 「끌어다놓기 첨부가 안되네」, 「첨부한 파일을 폴더에
// 정리하는 기능 … 알아서 적정 폴더를 추천해주는 판정모델」). 실제 DB · 실제 git · 로컬 Storage, 팀 · 폴더 경로는 실제 Express 라우트에
// 대고(로그인만 대역), 판정 모델은 가짜(oddsOf · chatJson 대역, 하나는 가짜 모델 서버로 logprob 길 그대로).
//   - 올리기 → 내 파일 카드(메인 채팅 · 프로젝트 목록 밖) → 대화로 보내기 → 받는 사람이 그 파일을 받음(원본과 같은 바이트)
//   - 후보: 편집 이상 · 관리형만, 연결형 · 보기 권한 · 스킬 폴더는 아님, 일의 작업 폴더는 그 일의 문서일 때만
//   - 판정: 첫 글자 확률 → 폴더 · 하위 폴더, 확률 없으면 JSON, 맞는 폴더 없으면 새 폴더 이름, 카드마다 한 번
//   - 정리: 내 이름의 커밋, 같은 내용은 다시 넣지 않음, 카드에 정리 기록
//   - 권한: 남의 카드 · 공유 · 폴더는 404 / 403
// Run: node --test test/filing.integration.test.js  (needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-filing-test-'))
process.env.PRO_FOLDERS_ROOT = tmp
process.env.PRO_BACKGROUND = '0'
process.env.PRO_TENANT_ID = 'localhost'
delete process.env.PRO_TENANT_FROM_HEADER
// nothing shared is reached: no agents, no router, a fake model on this test's own port
process.env.PRO_DEEPAGENTS_URL = 'http://127.0.0.1:9'
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_MEMENTO_URL = 'http://127.0.0.1:9'
const fakeModel = { pick: null, calls: 0 }
const llm = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    fakeModel.calls++
    const b = JSON.parse(body || '{}')
    const text = b.messages?.map((m) => m.content).join('\n') || ''
    res.writeHead(200, { 'content-type': 'application/json' })
    if (b.logprobs) {
      // the letter of the option the test wants, sure at 0.9
      const letter = fakeModel.pick ? fakeModel.pick(text) : 'A'
      const other = letter === 'A' ? 'B' : 'A'
      return res.end(JSON.stringify({ choices: [{ message: { content: letter }, logprobs: { content: [{ token: letter, logprob: Math.log(0.9), top_logprobs: [{ token: letter, logprob: Math.log(0.9) }, { token: other, logprob: Math.log(0.1) }] }] } }] }))
    }
    res.end(JSON.stringify({ choices: [{ message: { content: '{"name":"기타 문서","why":"맞는 폴더가 없음"}' }, finish_reason: 'stop' }] }))
  })
})
await new Promise((ok) => llm.listen(0, '127.0.0.1', ok))
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llm.address().port}/v1`
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_LLM_MODEL = 'fake-judge'
process.env.PRO_LLM_FAST_MODEL = 'fake-judge'

const F = await import('../lib/folders/filing.js')
const { q, pool, admin } = await import('../lib/supa.js')
const db = await q('select 1 from pro_folders limit 1').then(() => true).catch(() => false)

// ---------- pure ----------
test('이름 · 같은 내용: 경로 문자는 빼고, 겹치면 (2), blob 은 git 이 매기는 값과 같다', () => {
  assert.equal(F.safeName('../견적서:최종?.xlsx'), '견적서 최종 .xlsx')
  assert.equal(F.safeName('   '), 'file')
  assert.equal(F.freePath('견적서.xlsx', new Set(['견적서.xlsx'])), '견적서 (2).xlsx')
  assert.equal(F.freePath('a/b.md', new Set(['a/b.md', 'a/b (2).md'])), 'a/b (3).md')
  const buf = Buffer.from('같은 내용\n')
  const git = execFileSync('git', ['hash-object', '--stdin'], { input: buf }).toString().trim()
  assert.equal(F.blobSha(buf), git)
})

test('작업 폴더는 그 일의 문서만: 인스턴스 · 메일로 알아본다', () => {
  const work = { instId: 'i-1', instances: ['i-1', 'i-2'], mails: [{ mailId: 'm-9' }] }
  assert.equal(F.ofWork(null, {}), true)
  assert.equal(F.ofWork(work, {}), false)
  assert.equal(F.ofWork(work, { instIds: ['i-2'] }), true)
  assert.equal(F.ofWork(work, { mailIds: ['m-9'] }), true)
  assert.equal(F.ofWork(work, { instIds: ['i-3'], mailIds: ['m-1'] }), false)
})

test('판정: 첫 글자 확률이 있으면 그것, 없으면 JSON, 둘 다 없으면 null', async () => {
  const options = [{ key: 'quotes', label: '「견적서」 폴더' }, { key: '__new', label: '새 폴더' }]
  const odds = async (s, qn, opts) => ({ choice: opts[0].key, probabilities: { quotes: 0.83, __new: 0.17 }, confidence: 0.83, model: 'm' })
  assert.deepEqual(await F.choose('state', 'question', options, { odds }), { choice: 'quotes', probabilities: { quotes: 0.83, __new: 0.17 }, confidence: 0.83, strategy: 'logprob', model: 'm' })
  let asked = null
  const json = async (sys, user) => { asked = { sys, user }; return { choice: 'B', confidence: 0.6 } }
  const r = await F.choose('state', 'question', options, { odds: async () => null, json, answerJson: 'JSON 으로' })
  assert.equal(r.choice, '__new')
  assert.equal(r.strategy, 'json')
  assert.equal(r.confidence, 0.6)
  assert.match(asked.sys, /JSON 으로/)
  assert.match(asked.user, /A\) 「견적서」 폴더\nB\) 새 폴더/)
  assert.equal(await F.choose('s', 'q', options, { odds: async () => null, json: async () => ({ choice: 'Q' }) }), null)
  assert.equal(await F.choose('s', 'q', options, { odds: async () => null, json: async () => { throw new Error('down') } }), null)
})

// ---------- on the local database ----------
const users = []
const folders = []
const rooms = []
const objects = []
const closers = []
after(async () => {
  for (const c of closers) c()
  for (const f of folders) await q('delete from pro_folders where id=$1', [f]).catch(() => {})
  for (const r of rooms) {
    await q('delete from chats where id=$1', [r]).catch(() => {})
    await q('delete from pro_chat_reads where room_id=$1', [r]).catch(() => {})
    await q('delete from chat_rooms where id=$1', [r]).catch(() => {})
  }
  for (const u of users) {
    await q('delete from pro_shares where owner_id=$1 or recipient_id=$1', [u.id]).catch(() => {})
    await q("delete from artifact_branches where room_id in (select 'pro:' || id from pro_threads where user_id=$1)", [u.id]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [u.id]).catch(() => {})
    await q('delete from pro_actions where user_id=$1', [u.id]).catch(() => {})
    await q('delete from notifications where user_id=$1 or user_id=$2', [u.id, u.email]).catch(() => {})
    await q('delete from pro_team_members where user_id=$1', [u.id]).catch(() => {})
    await q('delete from pro_profile where user_id=$1', [u.id]).catch(() => {})
    await q('delete from users where id=$1', [u.id]).catch(() => {})
    const keys = (await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/${u.id}/`]).catch(() => [])).map((r) => r.name)
    objects.push(...keys)
  }
  if (objects.length) await admin.storage.from('files').remove(objects).catch(() => {})
  await pool.end()
  llm.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function person(name) {
  const id = crypto.randomUUID()
  const u = { id, email: `filing-${id.slice(0, 8)}@example.test`, name }
  users.push(u)
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,'localhost')`, [id, u.email, name])
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [id, name, u.email])
  await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ('localhost',$1,$1) on conflict do nothing`, [id])
  return u
}

// the team and filing routes as the server mounts them, signed in by a header (the real sign-in is not under test)
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

const QUOTE = Buffer.from('# 견적서 — 한빛상사 교육장 인테리어\n\n| 품목 | 금액 |\n|---|---|\n| 설계비 | 3,000,000 |\n| 시공비 | 23,070,000 |\n\n합계 26,070,000원 · 유효기간 30일\n')

test('메신저에서 컴퓨터의 파일 보내기: 올리면 내 파일 카드(메인 채팅 · 프로젝트 밖), 보내면 받는 사람이 같은 파일을 받는다', { skip: !db }, async () => {
  const a = await person('윤태호'), b = await person('서하린')
  // the upload: a card of mine in the messenger files conversation
  const up = await sendFile(a, '견적서_한빛상사.md', QUOTE)
  assert.equal(up.status, 200, up.text)
  assert.match(up.body.id, /^[0-9a-f-]{36}$/)
  assert.equal(up.body.name, '견적서_한빛상사.md')
  assert.equal(up.body.size, QUOTE.length)
  const [card] = await q('select m.*, t.kind as tkind, t.share_ref from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1', [up.body.id])
  assert.equal(card.kind, 'file')
  assert.equal(card.tkind, 'files', '메인 채팅(chat) · 프로젝트(project)가 아닌 대화')
  assert.equal(card.share_ref, 'messenger:uploads')
  assert.equal((await q(`select count(*)::int n from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and t.kind in ('chat','project')`, [a.id]))[0].n, 0, '메인 채팅에 아무것도 붙지 않음')
  // the second upload goes into the same conversation
  const up2 = await sendFile(a, '메모.txt', Buffer.from('두 번째'), 'text/plain')
  assert.equal((await q('select thread_id from pro_messages where id=$1', [up2.body.id]))[0].thread_id, card.thread_id)
  // empty: 400; someone else's card cannot be sent: 404
  assert.equal((await sendFile(a, 'empty.md', Buffer.alloc(0))).status, 400)
  // a .json file goes as bytes (the JSON parser in front does not take it)
  const js = await sendFile(a, 'data.json', Buffer.from('{"a":1}'), 'application/json')
  assert.equal(js.status, 200, js.text)
  // send it in our conversation
  const t = await call(a, 'POST', '/team/threads', { members: [b.id] })
  assert.equal(t.status, 200, t.text)
  rooms.push(t.body.id)
  assert.equal((await call(b, 'POST', `/team/threads/${t.body.id}/messages`, { text: '남의 카드', artifactIds: [up.body.id] })).status, 404, '남의 카드는 보낼 수 없다')
  const sent = await call(a, 'POST', `/team/threads/${t.body.id}/messages`, { text: '견적서 보내드려요', artifactIds: [up.body.id] })
  assert.equal(sent.status, 200, sent.text)
  assert.equal(sent.body.kind, 'share')
  assert.equal(sent.body.artifacts[0].name, '견적서_한빛상사.md')
  // the recipient sees it in the conversation and the inbox, with their own share id, and gets the same bytes
  const seen = await call(b, 'GET', `/team/threads/${t.body.id}/messages`)
  const last = seen.body.messages.at(-1)
  assert.equal(last.body, '견적서 보내드려요')
  assert.equal(last.mine, false)
  const shareId = last.artifacts[0].shareId
  assert.match(shareId, /^[0-9a-f-]{36}$/)
  assert.ok((await call(b, 'GET', '/team/inbox')).body.some((m) => m.artifacts.some((x) => x.shareId === shareId)))
  const raw = await fetch(`${await server()}/team/shares/${shareId}/raw`, { headers: { 'x-test-user': b.id } })
  assert.equal(raw.status, 200)
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), QUOTE)
  // the recipient's copy is a card of theirs (a branch: their work conversation; a copy-style share — a database without the
  // worktree tables — gets it when first read for 폴더에 정리, in a conversation no list shows), never in the main chat
  const doc = await F.docOf(b, { shareId })
  const [card2] = await q('select t.kind, t.share_ref from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1', [doc.messageId])
  assert.notEqual(card2.kind, 'chat')
  assert.equal((await q('select copy_message_id from pro_shares where id=$1', [shareId]))[0].copy_message_id, doc.messageId)
  assert.equal((await q(`select count(*)::int n from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and t.kind='chat'`, [b.id]))[0].n, 0)
  // opening it later is the same card
  const opened = await call(b, 'POST', `/team/shares/${shareId}/open`)
  assert.equal(opened.body.message.id, doc.messageId)
  globalThis.__share = { a, b, shareId, room: t.body.id }
})

test('50MB 를 넘는 파일은 413', { skip: !db }, async () => {
  const a = await person('큰파일')
  const r = await fetch(`${await server()}/team/uploads`, { method: 'POST', headers: { 'x-test-user': a.id, 'content-type': 'application/octet-stream', 'x-file-name': 'big.bin' }, body: Buffer.alloc(50 * 1024 * 1024 + 1) })
  assert.equal(r.status, 413)
})

// a folder of one person, with files (and sub-folders) and members
async function folderOf(owner, name, files = {}, { description = '', members = [] } = {}) {
  const S = await import('../lib/folders/service.js')
  const { reindex } = await import('../lib/folders/indexer.js')
  const f = await S.createFolder(owner, { name: `${name} ${crypto.randomUUID().slice(0, 4)}`, description })
  folders.push(f.id)
  for (const [p, text] of Object.entries(files)) await S.upload(f, owner, p, Buffer.from(text))
  for (const [u, role] of members) await S.setMember(f, owner, { id: u.id, role })
  await reindex(f, { cards: false })
  return S.folderById(f.id)
}

test('후보: 편집 이상인 관리형 폴더만 — 보기 권한 · 연결형 · 일의 작업 폴더(그 일의 문서가 아니면)는 아니다', { skip: !db }, async () => {
  const S = await import('../lib/folders/service.js')
  const me = await person('서하린'), other = await person('다른 사람')
  const quotes = await folderOf(me, '견적서', { '2026/견적서_대한상사.md': '대한상사 견적' })
  const shared = await folderOf(other, '공유 편집', {}, { members: [[me, 'editor']] })
  const viewOnly = await folderOf(other, '보기만', {}, { members: [[me, 'viewer']] })
  const runner = await folderOf(other, '실행만', {}, { members: [[me, 'runner']] })
  const work = await folderOf(me, '작업', {})
  await q(`update pro_folders set settings = settings || jsonb_build_object('work', $2::jsonb) where id=$1`, [work.id, JSON.stringify({ instId: 'inst-77', instances: ['inst-77'], mails: [{ mailId: 'mail-5' }] })])
  const repo = path.join(tmp, `linked-${crypto.randomUUID().slice(0, 6)}`)
  fs.mkdirSync(repo); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo })
  const linked = await S.registerLinked(me, repo, { name: `연결 ${crypto.randomUUID().slice(0, 4)}` })
  folders.push(linked.id)
  const slugs = (await F.candidates(me, {})).map((f) => f.slug)
  assert.ok(slugs.includes(quotes.slug))
  assert.ok(slugs.includes(shared.slug), '편집 권한')
  for (const f of [viewOnly, runner, linked, work]) assert.ok(!slugs.includes(f.slug), f.name)
  assert.ok((await F.candidates(me, { instIds: ['inst-77'] })).some((f) => f.slug === work.slug), '그 일의 문서면 작업 폴더도')
  assert.ok((await F.candidates(me, { mailIds: ['mail-5'] })).some((f) => f.slug === work.slug))
})

// fake judges: the folder (or sub-folder) whose name the test says, sure at p
const judge = (want, p = 0.87, log = []) => ({
  odds: async (state, question, options) => {
    log.push({ state, question, options })
    const o = options.find((x) => want(x)) || options.at(-1)
    const probabilities = Object.fromEntries(options.map((x) => [x.key, x === o ? p : (1 - p) / (options.length - 1)]))
    return { choice: o.key, probabilities, confidence: p, model: 'fake' }
  },
  json: async () => ({ name: '거래처 계약서', why: '계약서를 모을 곳' }),
})

test('판정 → 정리: 견적서 폴더 · 2026 하위 폴더, 카드마다 한 번, 내 이름의 커밋, 같은 내용은 다시 넣지 않는다', { skip: !db }, async () => {
  const { a, b, shareId } = globalThis.__share || {}
  assert.ok(shareId, '앞 시험(보내기)이 먼저')
  const G = await import('../lib/folders/git.js')
  const quotes = await folderOf(b, '견적서', { '2025/견적서_소망.md': '소망상사 견적 합계 1,200,000원', '2026/견적서_대한상사.md': '대한상사 교육장 견적 합계 8,000,000원', '양식/견적서_양식.md': '견적서 양식' },
    { description: '고객에게 보낸 견적서' })
  const minutes = await folderOf(b, '회의록', { '주간회의_1117.md': '주간 회의록' })
  const log = []
  const J = judge((o) => o.label.includes(quotes.name) || o.key === '2026', 0.87, log)
  const s1 = await F.suggest(b, { shareId }, { deps: { judges: J } })
  assert.equal(s1.suggestion.folder.slug, quotes.slug)
  assert.equal(s1.suggestion.sub, '2026')
  assert.equal(s1.suggestion.confidence, 0.87)
  assert.equal(s1.suggestion.strategy, 'logprob')
  assert.equal(F.sayOf(s1.suggestion), `‘${quotes.name}/2026’에 정리할까요? (확신 87%)`)
  // what the judge read: the document's name and text, who sent it with what words, each folder with its files
  const st = log[0].state
  assert.match(st, /견적서_한빛상사\.md/)
  assert.match(st, /합계 26,070,000원/)
  assert.match(st, /윤태호님이 메신저로 보낸 파일: "견적서 보내드려요"/)
  assert.match(st, new RegExp(`「${quotes.name}」 — 고객에게 보낸 견적서`))
  assert.match(st, /하위 폴더: .*2026\(1\)/)
  assert.ok(log[0].options.some((o) => o.key === minutes.slug))
  assert.equal(log[0].options.at(-1).key, '__new')
  assert.equal(log[1].options.at(-1).label, '폴더 맨 위')
  // kept on the card: asked again, the judge is not called
  const n = log.length
  const s2 = await F.suggest(b, { shareId }, { deps: { judges: J } })
  assert.equal(log.length, n, '같은 카드는 다시 판정하지 않는다')
  assert.deepEqual(s2.suggestion, s1.suggestion)
  const [{ copy_message_id: cardId }] = await q('select copy_message_id from pro_shares where id=$1', [shareId])
  assert.equal((await F.suggest(b, { messageId: cardId }, { deps: { judges: J } })).suggestion.folder.slug, quotes.slug, '같은 카드 — 메신저에서도 대화에서도')
  assert.equal(log.length, n)
  // file it: in 2026/, committed as 서하린
  const done = await F.file(b, { shareId }, { slug: quotes.slug, sub: '2026' })
  assert.equal(done.filed.path, '2026/견적서_한빛상사.md')
  assert.equal(done.filed.already, false)
  const head = await G.log(quotes.repo_path, 'main', 1)
  assert.equal(head[0].name, '서하린')
  assert.match(head[0].msg, /정리: 2026\/견적서_한빛상사\.md/)
  assert.deepEqual(await G.show(quotes.repo_path, 'main', '2026/견적서_한빛상사.md'), QUOTE)
  const [{ content }] = await q('select content from pro_messages where id=$1', [cardId])
  assert.equal(content.filing.filed.slug, quotes.slug)
  assert.equal(content.filing.suggestion.folder.slug, quotes.slug, '추천도 남는다')
  // filed: a suggest says so without judging
  assert.equal((await F.suggest(b, { shareId }, { deps: { judges: J } })).filed.path, '2026/견적서_한빛상사.md')
  assert.equal(log.length, n)
  // the same content from another card: not written again, where it is is said
  const S = await import('../lib/folders/service.js')
  const main = await (await import('../lib/store.js')).mainThread(b.id)
  const up = await (await import('../lib/attachments.js')).saveAttachment(b, '견적서 사본.md', 'text/markdown', QUOTE)
  const [again] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'user','file',$2) returning id`, [main.id, { name: up.name, url: up.url, attached: true }])
  const before = (await G.log(quotes.repo_path, 'main', 5)).length
  const dup = await F.file(b, { messageId: again.id }, { slug: quotes.slug })
  assert.equal(dup.filed.already, true)
  assert.equal(dup.filed.path, '2026/견적서_한빛상사.md')
  assert.equal((await G.log(quotes.repo_path, 'main', 5)).length, before, '커밋 없음')
  // a different file of the same name: beside it, (2)
  await S.upload(quotes, b, '메모.md', Buffer.from('하나'))
  const up3 = await (await import('../lib/attachments.js')).saveAttachment(b, '메모.md', 'text/markdown', Buffer.from('둘'))
  const [m3] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'user','file',$2) returning id`, [main.id, { name: up3.name, url: up3.url, attached: true }])
  assert.equal((await F.file(b, { messageId: m3.id }, { slug: quotes.slug })).filed.path, '메모 (2).md')
  // permissions: the sender cannot judge or file the recipient's card or share; a folder I only view, or am not in
  await assert.rejects(F.suggest(a, { shareId }, { deps: { judges: J } }), (e) => e.status === 404)
  await assert.rejects(F.suggest(a, { messageId: cardId }, { deps: { judges: J } }), (e) => e.status === 404)
  const theirs = await folderOf(a, '윤태호 폴더', {}, { members: [[b, 'viewer']] })
  await assert.rejects(F.file(b, { messageId: m3.id }, { slug: theirs.slug }), (e) => e.status === 403)
  const none = await folderOf(a, '모르는 폴더', {})
  await assert.rejects(F.file(b, { messageId: m3.id }, { slug: none.slug }), (e) => e.status === 403)
  await assert.rejects(F.file(b, { messageId: m3.id }, { slug: 'no-such-folder-x' }), (e) => e.status === 404)
})

test('맞는 폴더가 없으면 새 폴더 이름을 짓고, 「만들고 정리」는 내가 주인인 폴더를 만든다 · 확률이 없는 모델은 JSON', { skip: !db }, async () => {
  const me = await person('한새봄')
  await folderOf(me, '회의록', { '주간회의.md': '주간 회의록' })
  const main = await (await import('../lib/store.js')).mainThread(me.id)
  const up = await (await import('../lib/attachments.js')).saveAttachment(me, '용역계약서_그린리프.md', 'text/markdown', Buffer.from('용역 계약서 — 그린리프공방과 유엔진 사이의 계약'))
  const [card] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2) returning id`, [main.id, { name: up.name, url: up.url }])
  const J = judge((o) => o.key === '__new', 0.71)
  const s = await F.suggest(me, { messageId: card.id }, { deps: { judges: J } })
  assert.equal(s.suggestion.folder, null)
  assert.equal(s.suggestion.newFolder.name, '거래처 계약서')
  assert.equal(F.sayOf(s.suggestion), '새 폴더 만들기: 거래처 계약서')
  const done = await F.file(me, { messageId: card.id }, { newFolder: s.suggestion.newFolder.name })
  folders.push((await q('select id from pro_folders where slug=$1', [done.filed.slug]))[0].id)
  assert.equal(done.filed.made, true)
  assert.equal(done.filed.path, '용역계약서_그린리프.md')
  const [m] = await q(`select m.role from pro_folder_members m join pro_folders f on f.id=m.folder_id where f.slug=$1 and m.principal_id=$2`, [done.filed.slug, me.id])
  assert.equal(m.role, 'owner')
  // a model with no log-probabilities: the JSON answer
  const up2 = await (await import('../lib/attachments.js')).saveAttachment(me, '회의록_1124.md', 'text/markdown', Buffer.from('11월 24일 주간 회의록'))
  const [c2] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2) returning id`, [main.id, { name: up2.name, url: up2.url }])
  const s2 = await F.suggest(me, { messageId: c2.id }, { deps: { judges: { odds: async () => null, json: async (sys) => (/JSON \{"choice"/.test(sys) ? { choice: 'A', confidence: 0.66 } : { name: 'x' }) } } })
  assert.equal(s2.suggestion.strategy, 'json')
  assert.equal(s2.suggestion.confidence, 0.66)
  assert.ok(s2.suggestion.folder)
})

test('메일의 첨부: 메일 카드에 판정과 정리를 남긴다 · 일의 작업 폴더는 그 메일의 첨부면 후보', { skip: !db }, async () => {
  const me = await person('오세린')
  const work = await folderOf(me, '견적 요청 작업', {})
  await q(`update pro_folders set settings = settings || jsonb_build_object('work', $2::jsonb) where id=$1`, [work.id, JSON.stringify({ instId: 'inst-m1', instances: ['inst-m1'], mails: [{ mailId: 'mail-att-1' }] })])
  const [a] = await q(`insert into pro_actions(user_id, verb, text, source) values ($1,'Review','견적 요청 확인',$2) returning *`, [me.id, { mail_id: 'mail-att-1', from: '이수민 <soomin@hanbit.example>', subject: '교육장 견적 요청' }])
  const mailSource = async () => ({ subject: '교육장 견적 요청', text: '도면을 첨부합니다.', attachments: [{ name: '평면도.md', type: 'text/markdown', content: Buffer.from('2층 교육장 평면도 30석') }] })
  const J = judge((o) => o.label.includes(work.name), 0.92)
  const s = await F.suggest(me, { actionId: a.id, attachment: '평면도.md' }, { deps: { judges: J, mailSource } })
  assert.equal(s.suggestion.folder.slug, work.slug, '그 메일의 작업 폴더')
  const done = await F.file(me, { actionId: a.id, attachment: '평면도.md' }, { slug: work.slug, deps: { mailSource } })
  assert.equal(done.filed.path, '평면도.md')
  const [row] = await q('select source from pro_actions where id=$1', [a.id])
  assert.equal(row.source.filing['평면도.md'].filed.slug, work.slug)
  await assert.rejects(F.suggest(me, { actionId: a.id, attachment: '없는.pdf' }, { deps: { judges: J, mailSource } }), (e) => e.status === 404)
  const other = await person('남')
  await assert.rejects(F.suggest(other, { actionId: a.id, attachment: '평면도.md' }, { deps: { judges: J, mailSource } }), (e) => e.status === 404)
  // a document of another work cannot go into this work folder, even by hand
  const main = await (await import('../lib/store.js')).mainThread(me.id)
  const up = await (await import('../lib/attachments.js')).saveAttachment(me, '다른 일.md', 'text/markdown', Buffer.from('다른 일'))
  const [c] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'user','file',$2) returning id`, [main.id, { name: up.name, url: up.url }])
  await assert.rejects(F.file(me, { messageId: c.id }, { slug: work.slug }), (e) => e.status === 400)
})

test('HTTP: 판정은 실제 모델 길(첫 글자 확률)로, 남의 카드는 404, 보기 권한 폴더는 403, 고를 폴더 목록', { skip: !db }, async () => {
  const me = await person('김하늘'), other = await person('이도윤')
  const quotes = await folderOf(me, '견적서', { '견적서_대한.md': '대한상사 견적' })
  const minutes = await folderOf(me, '회의록', { '회의록_1117.md': '회의록' })
  const viewer = await folderOf(other, '이도윤 폴더', {}, { members: [[me, 'viewer']] })
  const main = await (await import('../lib/store.js')).mainThread(me.id)
  const up = await (await import('../lib/attachments.js')).saveAttachment(me, '견적서_한빛.md', 'text/markdown', QUOTE)
  const [card] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'user','file',$2) returning id`, [main.id, { name: up.name, url: up.url, attached: true }])
  // the fake model answers the letter of 「견적서」 (the options are listed A) B) … after the question)
  fakeModel.pick = (text) => { const m = new RegExp(`([A-Z])\\) 「${quotes.name}」`).exec(text); return m ? m[1] : 'A' }
  const before = fakeModel.calls
  const s = await call(me, 'POST', '/filing/suggest', { messageId: card.id })
  assert.equal(s.status, 200, s.text)
  assert.equal(s.body.suggestion.folder.slug, quotes.slug)
  assert.equal(s.body.suggestion.strategy, 'logprob')
  assert.ok(s.body.suggestion.confidence >= 0.89 && s.body.suggestion.confidence <= 0.91)
  assert.ok(fakeModel.calls > before)
  const calls = fakeModel.calls
  assert.equal((await call(me, 'POST', '/filing/suggest', { messageId: card.id })).body.suggestion.folder.slug, quotes.slug)
  assert.equal(fakeModel.calls, calls, '두 번째는 카드에 남은 것')
  assert.equal((await call(other, 'POST', '/filing/suggest', { messageId: card.id })).status, 404)
  assert.equal((await call(me, 'POST', '/filing/suggest', {})).status, 400)
  const list = await call(me, 'GET', `/filing/folders?messageId=${card.id}`)
  assert.deepEqual(list.body.map((f) => f.slug).filter((x) => [quotes.slug, minutes.slug, viewer.slug].includes(x)).sort(), [quotes.slug, minutes.slug].sort())
  assert.equal((await call(me, 'POST', '/filing/file', { messageId: card.id, slug: viewer.slug })).status, 403)
  assert.equal((await call(other, 'POST', '/filing/file', { messageId: card.id, slug: quotes.slug })).status, 404)
  const f = await call(me, 'POST', '/filing/file', { messageId: card.id, slug: minutes.slug })
  assert.equal(f.status, 200, f.text)
  assert.equal(f.body.filed.slug, minutes.slug, '사람이 고른 폴더로')
  assert.equal(f.body.filed.name, minutes.name)
})
