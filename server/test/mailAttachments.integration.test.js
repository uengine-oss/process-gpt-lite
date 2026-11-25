// 메일 첨부를 그 자리에서 열고 채팅으로 묻는다 — 실제 DB · 실제 저장소(로컬 Supabase, 비공개 버킷) · 실제 git · 실제 Express 라우트(로그인만 헤더
// 대역), Gmail 은 가짜 fetch. 사람 · 회사 · 메일은 지어낸 것이다(한지우 · 서민재 · 오태윤, 세무법인 오가람).
//   - 문서: 이음오피스용 서명 주소(공개 주소 아님) — 그 주소로 받은 바이트가 첨부 그대로, 같은 열쇠의 공개 주소는 열리지 않음, 두 번째는 메일함을 다시 읽지 않음
//   - 남의 메일 첨부: 열기 · 경로 모두 404
//   - 그림: 이 서버 경로의 서명 주소 → 200 · inline · 그대로, 바꾼 주소 403 · 지난 주소 401 · 로그인 토큰 없이
//   - zip: 내려받기(attachment)
//   - 편집본 저장: 내 채팅의 비공개 파일 카드(주소 없음) · 카드가 그 자리를 앎 · 다음 저장은 같은 카드 · 남의 열쇠 · 다른 폴더의 편집본은 거절
//   - 에이전트: 작업 공간이 이 기계에 있으면 경로, 없으면 30분 서명 주소(받으면 첨부 그대로) · 메일 맥락은 한 번
//   - 정리된 메일: 폴더의 사본을 열고, 저장은 폴더에 커밋
//   - 메신저: 동료는 이름 · 요약만(열기 403) → 열기 요청 → 주인이 그 파일만 공유 → 동료가 읽기 전용으로 엶 · 경로 200, 방 밖 404, 공유를 거두면 403 · 경로 404
//   - 팩스(TIFF): 보기 화면(image · image/tiff 로 그대로), 에이전트에는 쪽마다 PNG — 작업 공간이면 옆에, 아니면 비공개 서명 주소, 손상된 TIFF 는 까닭
//   - 로그에 첨부 이름 · 바이트가 없음
// Run: node --test --test-concurrency=1 test/mailAttachments.integration.test.js  (needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-mailatt-test-'))
const kek = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(tmp, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: kek.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(tmp, 'keyring.json')
delete process.env.PRO_VAULT_KEK
delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_FOLDERS_ROOT = path.join(tmp, 'folders')
process.env.PRO_BACKGROUND = '0'
process.env.PRO_TENANT_ID = 'localhost'
process.env.PRO_ONTOLOGY_BOLT_URL = ''
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_MEMENTO_URL = 'http://127.0.0.1:9'
process.env.PRO_JUDGE_URL = ''
process.env.PRO_LLM_BASE_URL = 'https://llm.fake.example/v1'
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_GOOGLE_GMAIL_URL = 'https://gmail.fake-google.example/gmail/v1'
process.env.PRO_DEEPAGENTS_URL = 'https://deepagents.fake.example'
process.env.PRO_LLM_MODEL = 'fake'
process.env.PRO_LLM_FAST_MODEL = 'fake'
// a process-gpt root of this test's own: the keys (.env) as they are, the agent's workspace in a temporary folder (never the dev PC's)
const realRoot = [process.env.PGPT_ROOT, path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../backends/process-gpt'), path.join(os.homedir(), 'process-gpt')]
  .find((d) => d && fs.existsSync(path.join(d, '.env')))
const PGPT = path.join(tmp, 'pgpt')
const WS = path.join(PGPT, 'services', 'deepagents', 'workspace', 'localhost')
fs.mkdirSync(WS, { recursive: true })
if (realRoot) fs.symlinkSync(path.join(realRoot, '.env'), path.join(PGPT, '.env'))
process.env.PGPT_ROOT = PGPT

const { config } = await import('../config.js')
const { q, pool, admin } = await import('../lib/supa.js')
const db = await q('select 1').then(() => true, () => false)
const vault = await import('../lib/vault.js')
const R = await import('../lib/mailReply.js')
const MA = await import('../lib/mailAttachments.js')
const P = await import('../lib/privateStore.js')
const FR = await import('../lib/fileRefs.js')
const G = await import('../lib/folders/git.js')
const S = await import('../lib/folders/service.js')
const ExcelJS = (await import('exceljs')).default

// ---------- the mail: a payroll sheet, a picture, a zip ----------
async function xlsx(rows) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('급여')
  for (const r of rows) ws.addRow(r)
  return Buffer.from(await wb.xlsx.writeBuffer())
}
const SHEET = await xlsx([['이름', '기본급', '공제', '실지급'], ['한지우', 3200000, 320000, 2880000], ['서민재', 2900000, 290000, 2610000], ['합계', 6100000, 610000, 5490000]])
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201a5f6c5ad0000000049454e44ae426082', 'hex')
const ZIP = Buffer.from('504b0506000000000000000000000000000000000000', 'hex')
const NAMES = ['2026년 11월 테스트솔루션 정규직 급여대장.xlsx', '현장 사진.png', '증빙 묶음.zip']
const RAW = await R.buildReply({
  from: { name: '오가람 세무', address: 'tax@ogaram-tax.example' }, to: [{ name: '한지우', address: 'jiwoo@lite.example' }],
  subject: '2026년 11월 급여대장 확인 부탁드립니다', body: '안녕하세요, 세무법인 오가람입니다.\n11월 급여대장을 보내 드립니다. 확인 후 확정해 주세요.',
  attachments: [{ filename: NAMES[0], content: SHEET, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { filename: NAMES[1], content: PNG, contentType: 'image/png' }, { filename: NAMES[2], content: ZIP, contentType: 'application/zip' }],
})
// names that are hard to match (review 11-25 #4): doubled spaces, NBSP, an ideographic space, a name longer than a chip keeps (200)
const ODD = ['견적서  최종본.xlsx', '계약서\u00a0초안.pdf', `${'2026 하늘테크 연간 계약 갱신 검토 자료 '.repeat(10)}.zip`]
const RAW2 = await R.buildReply({
  from: { name: '오가람 세무', address: 'tax@ogaram-tax.example' }, to: [{ name: '한지우', address: 'jiwoo@lite.example' }],
  subject: '이름이 어려운 첨부', body: '첨부를 확인해 주세요.',
  attachments: ODD.map((n, k) => ({ filename: n, content: Buffer.from(`odd-${k}`), contentType: 'application/octet-stream' })),
})
// a fax as KT 스마트메시지 Plus sends one (2026-11-25): a two-page CCITT G4 TIFF (server/fixtures/tiff), and a damaged one
const FAX = fs.readFileSync(new URL('../fixtures/tiff/fax-2p-g4.tif', import.meta.url))
const FAX_NAMES = ['arrive_xroshotplus_uengine1_20261125095030049_121017596357694.tif', 'arrive_broken.tif']
const RAW3 = await R.buildReply({
  from: { name: 'KT 스마트메시지 Plus', address: 'noreply@fax.kt.example' }, to: [{ name: '한지우', address: 'jiwoo@lite.example' }],
  subject: '[KT 스마트메시지 Plus] 팩스 메시지 도착알림', body: '팩스가 도착했습니다.',
  attachments: [{ filename: FAX_NAMES[0], content: FAX, contentType: 'image/tiff' },
    { filename: FAX_NAMES[1], content: fs.readFileSync(new URL('../fixtures/tiff/broken.tif', import.meta.url)), contentType: 'image/tiff' }],
})
const MAILS = { 'g-att-1': RAW, 'g-att-odd': RAW2, 'g-att-fax': RAW3 }
// the fake Gmail: format=minimal answers the size first (g-att-big says 200 MB and has no raw at all); format=raw the message
const gmail = { calls: 0, raw: 0, minimal: 0, delay: 0 }
const real = globalThis.fetch
// the fake deepagents (review 11-25 #1): it reads the attachment the turn handed over, keeps a copy of it under a new name in its own
// conversation folder, writes a report of its own, and names all of them in its answer
const agent = { bodies: [] }
const enc = new TextEncoder()
async function agentStream(body) {
  agent.bodies.push(body)
  const conv = body.conversation_id || `conv-att-${crypto.randomBytes(3).toString('hex')}`
  const handed = /^- (\/workspace\/uploads\/.+?\.xlsx) \(/m.exec(String(body.message || ''))?.[1]
  const room = `/workspace/.bpmn/${conv}`
  fs.mkdirSync(path.join(WS, '.bpmn', conv), { recursive: true })
  const events = [['metadata', { conversation_id: conv }]]
  if (handed) {
    const bytes = fs.readFileSync(path.join(WS, handed.slice('/workspace/'.length)))
    fs.writeFileSync(path.join(WS, '.bpmn', conv, '급여_사본.xlsx'), bytes)
    fs.writeFileSync(path.join(WS, '.bpmn', conv, '총액_검토.xlsx'), await xlsx([['합계', 5490000], ['검토', '맞음']]))
    events.push(['message', { type: 'file_artifact', path: handed, name: handed.split('/').pop(), ext: 'xlsx' }])
    events.push(['message', { type: 'file_artifact', path: `${room}/급여_사본.xlsx`, name: '급여_사본.xlsx', ext: 'xlsx' }])
    events.push(['message', { type: 'file_artifact', path: `${room}/총액_검토.xlsx`, name: '총액_검토.xlsx', ext: 'xlsx' }])
    events.push(['message', { type: 'token', content: `총액이 맞아요. 원본은 \`${handed}\`, 사본은 \`${room}/급여_사본.xlsx\`, 검토는 \`${room}/총액_검토.xlsx\` 에 있어요.` }])
  } else events.push(['message', { type: 'token', content: '첨부가 없어요.' }])
  return new Response(new ReadableStream({ start(c) { for (const [e, d] of events) c.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)); c.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.startsWith(config.google.gmailUrl)) {
    gmail.calls++
    if (gmail.delay) await new Promise((r) => setTimeout(r, gmail.delay))
    const m = /\/messages\/([^/?]+)\?format=(raw|minimal)/.exec(u)
    if (m && m[2] === 'minimal') {
      gmail.minimal++
      if (m[1] === 'g-att-big') return Response.json({ id: m[1], sizeEstimate: 200 * 1024 * 1024 })
      if (MAILS[m[1]]) return Response.json({ id: m[1], sizeEstimate: MAILS[m[1]].length })
    }
    if (m && m[2] === 'raw' && MAILS[m[1]]) { gmail.raw++; return Response.json({ id: m[1], threadId: `thr-${m[1]}`, raw: Buffer.from(MAILS[m[1]]).toString('base64url') }) }
    if (m && m[2] === 'raw' && m[1] === 'g-att-big') { gmail.raw++; return Response.json({ error: { message: 'must not be fetched' } }, { status: 500 }) }
    return Response.json({ error: { message: 'not found' } }, { status: 404 })
  }
  // the model: the chat's router hands the turn to the agent; anything else gets nothing to go on
  if (u.startsWith(config.llm.baseUrl)) {
    const b = JSON.parse(init.body || '{}')
    return Response.json({ choices: [{ message: { role: 'assistant', content: b.tools ? 'DELEGATE' : '{}' }, finish_reason: 'stop' }] })
  }
  if (u.startsWith(config.deepagentsUrl)) return u.endsWith('/chat/stream') ? agentStream(JSON.parse(init.body || '{}')) : Response.json([])
  if (/\/servers$|\/bindings$/.test(u)) return Response.json([])
  return real(url, init)
}
// what the server logs while these run: no attachment name, no bytes
const logged = []
const keep = { warn: console.warn, log: console.log, error: console.error }
for (const k of ['warn', 'log', 'error']) console[k] = (...a) => { logged.push(a.map(String).join(' ')); keep[k](...a) }

// ---------- people, cards, the routes ----------
const users = [], rooms = [], folders = [], closers = []
after(async () => {
  Object.assign(console, keep)
  for (const c of closers) c()
  for (const r of rooms) {
    await q('delete from chats where id=$1', [r]).catch(() => {})
    await q('delete from pro_chat_reads where room_id=$1', [r]).catch(() => {})
    await q('delete from chat_rooms where id=$1', [r]).catch(() => {})
  }
  const keys = (await q(`select name from storage.objects where bucket_id=$1 and (${users.map((_, k) => `starts_with(name, $${k + 2})`).concat(folders.map((_, k) => `starts_with(name, $${users.length + k + 2})`)).join(' or ') || 'false'})`,
    [P.BUCKET, ...users.map((u) => `mail/localhost/${u.id}/`), ...folders.map((f) => `folders/localhost/${f}/`)]).catch(() => [])).map((x) => x.name)
  if (keys.length) await admin.storage.from(P.BUCKET).remove(keys).catch(() => {})
  // (the turn's own output in the agent test is published as any turn's output is: the files bucket, under the person)
  for (const u of users) {
    const pub = (await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/${u.id}/`]).catch(() => [])).map((x) => x.name)
    if (pub.length) await admin.storage.from('files').remove(pub).catch(() => {})
  }
  await q(`delete from context_threads where user_id = any($1)`, [users.map((u) => u.id)]).catch(() => {})
  for (const f of folders) {
    const pub = (await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/folders/${f}/`]).catch(() => [])).map((x) => x.name)
    if (pub.length) await admin.storage.from('files').remove(pub).catch(() => {})
    await q('delete from pro_folders where id=$1', [f]).catch(() => {})
  }
  for (const u of users) {
    for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_team_members', 'pro_profile']) await q(`delete from ${t} where user_id=$1`, [u.id]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [u.id]).catch(() => {})
    await q('delete from notifications where user_id=$1 or user_id=$2 or from_user_id=$2', [u.id, u.email]).catch(() => {})
    await q('delete from users where id=$1', [u.id]).catch(() => {})
  }
  await pool.end()
  globalThis.fetch = real
  const { closeOntology } = await import('../lib/ontology/store.js')
  await closeOntology().catch(() => {})
  fs.rmSync(tmp, { recursive: true, force: true })
})

const SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly'
async function person(name, { gmail: g = false } = {}) {
  const id = crypto.randomUUID()
  const u = { id, email: `mailatt-${id.slice(0, 8)}@example.test`, name }
  users.push(u)
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,'localhost')`, [id, u.email, name])
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [id, name, u.email])
  await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ('localhost',$1,$1) on conflict do nothing`, [id])
  if (g) {
    await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'gmail',$2)`, [id, u.email])
    await vault.putItem(id, 'oauth', config.google.vaultSite, { username: u.email, access_token: `at-${id.slice(0, 6)}`, refresh_token: 'rt', expires_at: Date.now() + 3600_000, scope: SCOPE, client_id: 'cid' }, { actor: 'mail' })
  }
  return u
}
async function card(u, { mailId = 'g-att-1', subject = '2026년 11월 급여대장 확인 부탁드립니다' } = {}) {
  const [a] = await q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Review',$2,$3,$4) returning *`,
    [u.id, '오가람 세무 2026년 11월 급여대장 확인 후 확정·발송', '급여대장을 확인하고 확정해 주세요.',
      { mail_id: mailId, thread_id: `thr-${mailId}`, from: '오가람 세무 <tax@ogaram-tax.example>', subject, kind: 'task' }])
  return a
}
// the mail sheet opened (GET /actions/:id/mail): the card learns its attachments' names, sizes, types (source.att_meta)
const sheet = (u, a) => R.mailOfCard(u, a.id)
const row = async (id) => (await q('select * from pro_actions where id=$1', [id]))[0]

let base = null, origin = null
async function call(u, method, p, body) {
  if (!base) {
    const express = (await import('express')).default
    const { mailAttachmentRoutes } = await import('../routes/mailAttachments.js')
    const { teamRoutes } = await import('../routes/team.js')
    const { filingRoutes } = await import('../routes/filing.js')
    const app = express()
    app.use(express.json({ limit: '2mb' }))
    const auth = (req, res, next) => {
      const me = users.find((x) => x.id === req.headers['x-test-user'])
      if (!me) return res.status(401).json({ error: 'unauthorized' })
      req.user = { ...me }; req.session = { access_token: 'test-token' }; next()
    }
    app.use('/api', mailAttachmentRoutes(auth))
    app.use('/api', teamRoutes(auth))
    app.use('/api', filingRoutes(auth))
    const s = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)) })
    closers.push(() => s.close())
    origin = `http://127.0.0.1:${s.address().port}`
    base = `${origin}/api`
  }
  const r = await real(`${base}${p}`, { method, headers: { ...(u ? { 'x-test-user': u.id } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const buf = Buffer.from(await r.arrayBuffer())
  let json = null
  try { json = JSON.parse(buf.toString()) } catch { /* not json */ }
  return { status: r.status, body: json, text: buf.toString(), buf, headers: r.headers }
}
const get = async (url) => { const r = await real(url); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers } }

test('문서: 이음오피스에는 서명 주소(공개 주소 아님) — 받은 바이트가 첨부 그대로, 같은 열쇠의 공개 주소는 열리지 않음, 두 번째는 메일함을 다시 읽지 않음 · 남의 것 404', { skip: !db }, async () => {
  const u = await person('한지우', { gmail: true })
  const other = await person('서민재', { gmail: true })
  const a = await card(u)
  const before = gmail.raw
  const r = await call(u, 'POST', `/mail/attachments/${a.id}/0/open`, { name: NAMES[0] })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.how, 'office')
  assert.equal(r.body.editor, 'sheets')
  assert.equal(r.body.from, 'mail')
  assert.equal(r.body.name, NAMES[0])
  assert.ok(P.isSignedUrl(r.body.url), r.body.url)
  assert.ok(!P.isPublicUrl(r.body.url))
  assert.doesNotMatch(r.text, /object\/public/)
  assert.equal(gmail.raw, before + 1)
  const got = await get(r.body.url)
  assert.equal(got.status, 200)
  assert.ok(got.buf.equals(SHEET), '서명 주소로 받은 것이 첨부 그대로')
  // the copy: in the private bucket, under this person's card, never readable by its public address
  const kept = (await row(a.id)).source.att_copies['0']
  assert.equal(kept.name, NAMES[0])
  assert.equal(kept.size, SHEET.length)
  assert.ok(kept.key.startsWith(`mail/localhost/${u.id}/${a.id}/0-`), kept.key)
  const pub = await get(`${config.supabaseUrl}/storage/v1/object/public/${P.BUCKET}/${kept.key}`)
  assert.ok(pub.status >= 400, `공개 주소는 열리지 않는다 (${pub.status})`)
  const { data: bucket } = await admin.storage.getBucket(P.BUCKET)
  assert.equal(bucket.public, false)
  // again: the copy is there, the mailbox is not read again
  const r2 = await call(u, 'POST', `/mail/attachments/${a.id}/0/open`, { name: NAMES[0] })
  assert.equal(r2.status, 200)
  assert.equal(gmail.raw, before + 1, '두 번째는 메일함을 다시 읽지 않는다')
  // someone else: not found, nothing said
  for (const p of [`/mail/attachments/${a.id}/0/open`, `/mail/attachments/${a.id}/1/open`]) assert.equal((await call(other, 'POST', p, { name: NAMES[0] })).status, 404)
  assert.equal((await call(other, 'GET', `/mail/attachments/${a.id}/0/raw`)).status, 404)
  // a name that is not the mail's: not found
  const b = await card(u)
  assert.equal((await call(u, 'POST', `/mail/attachments/${b.id}/0/open`, { name: '다른 파일.xlsx' })).status, 404)
  assert.equal((await call(u, 'POST', `/mail/attachments/${a.id}/7/open`, { name: 'x.xlsx' })).status, 404)
})

test('그림 · zip: 이 서버 경로의 서명 주소(로그인 토큰 없음) → 200 · inline · 그대로, 바꾼 주소 403 · 지난 주소 401 · zip 은 내려받기', { skip: !db }, async () => {
  const u = await person('한지우', { gmail: true })
  const a = await card(u)
  const r = await call(u, 'POST', `/mail/attachments/${a.id}/1/open`, { name: NAMES[1] })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.how, 'view')
  assert.equal(r.body.media, 'image')
  assert.match(r.body.url, new RegExp(`^/mail/attachments/${a.id}/1/raw\\?u=${u.id}&exp=\\d+&inline=1&sig=`))
  assert.doesNotMatch(r.body.url, /token=|eyJ|object\/public/)
  const img = await get(`${base}${r.body.url}`)
  assert.equal(img.status, 200)
  assert.ok(img.buf.equals(PNG))
  assert.equal(img.headers.get('content-type'), 'image/png')
  assert.match(img.headers.get('content-disposition'), /^inline; filename\*=UTF-8''/)
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff')
  assert.match(img.headers.get('content-security-policy'), /sandbox/)
  // altered: 403; expired: 401
  assert.equal((await get(`${base}${r.body.url.replace(/u=[^&]+/, `u=${crypto.randomUUID()}`)}`)).status, 403)
  assert.equal((await get(`${base}${r.body.url.replace('/1/raw', '/0/raw')}`)).status, 403)
  const old = MA.signAtt({ key: MA.linkKeyOf(config.serviceKey), tenant: config.tenantId, actionId: a.id, i: 1, userId: u.id, inline: true, exp: Math.floor(Date.now() / 1000) - 5 })
  assert.equal((await get(`${base}${MA.attPath(a.id, 1, old)}`)).status, 401)
  // a zip: a download, not shown
  const z = await call(u, 'POST', `/mail/attachments/${a.id}/2/open`, { name: NAMES[2] })
  assert.equal(z.body.how, 'download')
  assert.doesNotMatch(z.body.url, /inline=1/)
  const zg = await get(`${base}${z.body.url}`)
  assert.equal(zg.status, 200)
  assert.ok(zg.buf.equals(ZIP))
  assert.match(zg.headers.get('content-disposition'), /^attachment;/)
  // 「내려받기」 of a document: a download address too
  const d = await call(u, 'POST', `/mail/attachments/${a.id}/0/open`, { name: NAMES[0], download: true })
  assert.equal(d.body.how, 'download')
  assert.match((await get(`${base}${d.body.url}`)).headers.get('content-disposition'), /^attachment;/)
})

test('편집본 저장: 내 채팅의 비공개 파일 카드(주소 없음) · 카드가 그 자리를 앎 · 다음 저장은 같은 카드 · 남의 열쇠는 거절', { skip: !db }, async () => {
  const u = await person('한지우', { gmail: true })
  const other = await person('서민재', { gmail: true })
  const a = await card(u)
  assert.equal((await call(u, 'POST', `/mail/attachments/${a.id}/0/saved`, {})).status, 404, '열지 않은 첨부는 저장할 편집본이 없다')
  await call(u, 'POST', `/mail/attachments/${a.id}/0/open`, { name: NAMES[0] })
  const kept = (await row(a.id)).source.att_copies['0']
  const dir = P.dirOf(kept.key)
  assert.equal((await call(u, 'POST', `/mail/attachments/${a.id}/0/saved`, {})).status, 404, '편집기가 아직 저장하지 않았다')
  // what the office host does on 저장: the edited copy beside the original (office-host editedObjectPath), with the service key
  const edited1 = await xlsx([['이름', '기본급'], ['한지우', 3300000]])
  await P.put(`${dir}/edited-attachment_20261125093000.xlsx`, edited1)
  const s = await call(u, 'POST', `/mail/attachments/${a.id}/0/saved`, { session: 'sess-1' })
  assert.equal(s.status, 200, s.text)
  assert.equal(s.body.where, 'chat')
  const m = s.body.message
  assert.equal(m.kind, 'file')
  assert.equal(m.content.name, NAMES[0])
  assert.equal(m.content.url, undefined, '비공개 카드에는 주소가 없다')
  assert.equal(m.content.private.key, `${dir}/edited-attachment_20261125093000.xlsx`)
  assert.deepEqual([m.content.mailAtt.actionId, m.content.mailAtt.i], [a.id, 0])
  const [th] = await q('select * from pro_threads where id=$1', [m.thread_id])
  assert.equal(th.user_id, u.id)
  assert.equal((await row(a.id)).source.att_edits['0'].msgId, m.id)
  // opening the card: a signed address for this opening, never stored
  const { openFileCard } = await import('../lib/fileCards.js')
  const c = await openFileCard(u, m.id)
  assert.ok(P.isSignedUrl(c.url))
  assert.ok((await get(c.url)).buf.equals(edited1))
  assert.equal((await q('select content from pro_messages where id=$1', [m.id]))[0].content.url, undefined)
  // a later save of the same session (the editor saves under another time stamp): the same card follows
  await P.put(`${dir}/edited-attachment_20261125093500.xlsx`, edited1)
  const pubForm = `${config.supabaseUrl}/storage/v1/object/public/${P.BUCKET}/${dir}/edited-attachment_20261125093500.xlsx`
  const m2 = await MA.savePrivateCard(u, (await q('select * from pro_messages where id=$1', [m.id]))[0], { url: pubForm })
  assert.equal(m2.content.private.key, `${dir}/edited-attachment_20261125093500.xlsx`)
  assert.equal(m2.content.url, undefined)
  // not one of its copies: refused
  const otherDir = P.mailDir({ tenant: 'localhost', userId: other.id, actionId: a.id, i: 0, sha: '0'.repeat(64) })
  await assert.rejects(MA.savePrivateCard(u, m2, { url: `${config.supabaseUrl}/storage/v1/object/public/${P.BUCKET}/${otherDir}/edited-x_20261125093500.xlsx` }), (e) => e.status === 400)
  await assert.rejects(MA.savePrivateCard(u, m2, { url: `${config.supabaseUrl}/storage/v1/object/public/files/${dir}/edited-x_20261125093500.xlsx` }), (e) => e.status === 400)
  await assert.rejects(MA.savePrivateCard(u, m2, { url: `${config.supabaseUrl}/storage/v1/object/public/${P.BUCKET}/${dir}/attachment.xlsx` }), (e) => e.status === 400)
  // someone else's card: not found
  assert.equal((await call(other, 'POST', `/mail/attachments/${a.id}/0/saved`, {})).status, 404)
})

test('에이전트: 작업 공간이 이 기계에 있으면 경로, 없으면 30분 서명 주소(받으면 첨부 그대로) · 칩 둘(메일 · 첨부)이어도 메일 맥락은 한 번', { skip: !db }, async () => {
  const u = await person('한지우', { gmail: true })
  const a = await card(u)
  await sheet(u, a)
  // no workspace here (the agent's pods): a signed address
  const f = await MA.agentFile(u, a.id, 0, NAMES[0], {}, { workspace: async () => null })
  const url = /(https?:\/\/\S+)$/.exec(f.line)?.[1]
  assert.ok(url && P.isSignedUrl(url), f.line)
  assert.match(f.line, /비공개 주소예요\. 30분 안에 받아 읽으세요/)
  assert.ok((await get(url)).buf.equals(SHEET))
  assert.deepEqual(f.shown, { as: 'mailatt', name: NAMES[0], actionId: a.id, i: 0, subject: '2026년 11월 급여대장 확인 부탁드립니다' })
  // a workspace on this machine: the file in it, no address at all
  const ws = fs.mkdtempSync(path.join(tmp, 'ws-'))
  const g = await MA.agentFile(u, a.id, 0, NAMES[0], {}, { workspace: async () => ws })
  const rel = /^- (\/workspace\/uploads\/\S+\/[^(]+?) \(/.exec(g.line)?.[1]
  assert.match(rel, new RegExp(`^/workspace/uploads/${u.id}/mail/[0-9a-f-]{36}/`), '쓸 때마다 무작위 폴더')
  assert.match(g.handed?.sha256 || '', /^[0-9a-f]{64}$/)
  assert.ok(rel, g.line)
  assert.doesNotMatch(g.line, /https?:/)
  assert.ok(fs.readFileSync(path.join(ws, rel.slice('/workspace'.length))).equals(SHEET))
  // the chat turn (lib/fileRefs.js turnRefs): the mail and its attachment — the mail's words once, the file as a readable one
  const t = await FR.turnRefs(u, [{ src: 'mail', id: a.id }, { src: 'mailatt', id: a.id, i: 0, name: NAMES[0] }],
    { deps: { agentFile: (...x) => MA.agentFile(x[0], x[1], x[2], x[3], x[4], { workspace: async () => null }) } })
  assert.equal(t.context.split('- 제목: 2026년 11월 급여대장 확인 부탁드립니다').length - 1, 1, '메일 맥락은 한 번')
  assert.match(t.context, /사용자가 끌어다 놓아 가리킨 파일/)
  assert.match(t.context, new RegExp(`- ${NAMES[0].replace(/[.()]/g, '\\$&')} \\(메일 「2026년 11월 급여대장 확인 부탁드립니다」의 첨부\\) — 비공개 주소예요`))
  assert.doesNotMatch(t.context, /object\/public/)
  assert.deepEqual(t.shown.map((x) => x.as), ['mail', 'mailatt'])
  // the attachment alone: its mail comes along
  const t2 = await FR.turnRefs(u, [{ src: 'mailatt', id: a.id, i: 0, name: NAMES[0] }], { deps: { agentFile: (...x) => MA.agentFile(x[0], x[1], x[2], x[3], x[4], { workspace: async () => null }) } })
  assert.match(t2.context, /- 보낸 사람: 오가람 세무 <tax@ogaram-tax\.example>/)
  // someone else's attachment: a chip with why, nothing read
  const other = await person('서민재')
  const t3 = await FR.turnRefs(other, [{ src: 'mailatt', id: a.id, i: 0, name: NAMES[0] }])
  assert.equal(t3.context, '')
  assert.match(t3.shown[0].error, /메일을 찾지 못했어요/)
})

test('정리된 메일: 폴더의 사본을 열고(비공개 서명 주소) · 저장은 폴더에 커밋 · 폴더 권한이 없어지면 메일의 사본', { skip: !db }, async () => {
  const u = await person('한지우', { gmail: true })
  const a = await card(u)
  // 「만들고 정리」: a new folder 급여대장 with the attachment in it
  const filed = await call(u, 'POST', '/filing/file', { actionId: a.id, attachment: NAMES[0], newFolder: '급여대장' })
  assert.equal(filed.status, 200, filed.text)
  const f = await S.folderBySlug(filed.body.filed.slug)
  folders.push(f.id)
  // the folder's copy is changed after it was filed (someone fixed a number): opening shows THAT one
  const fixed = await xlsx([['이름', '기본급', '공제', '실지급'], ['합계', 6100000, 610000, 5490001]])
  fs.writeFileSync(path.join(f.repo_path, filed.body.filed.path), fixed)
  await S.commitMainNow(f, { name: '한지우', email: u.email }, '숫자 고침')
  const o = await call(u, 'POST', `/mail/attachments/${a.id}/0/open`, { name: NAMES[0] })
  assert.equal(o.status, 200, o.text)
  assert.equal(o.body.from, 'folder')
  assert.equal(o.body.folder.slug, f.slug)
  assert.equal(o.body.folder.editable, true)
  assert.ok(P.isSignedUrl(o.body.url))
  assert.ok((await get(o.body.url)).buf.equals(fixed), '폴더의 지금 판')
  const [m] = await q('select * from pro_messages where id=$1', [o.body.message.id])
  assert.equal(m.content.url, undefined)
  assert.ok(m.content.private.key.startsWith(`folders/localhost/${f.id}/`))
  // the editor saves beside it (the private folder copy) → a commit in the folder
  const edited = await xlsx([['이름', '기본급'], ['합계', 7000000]])
  const ek = `${P.dirOf(m.content.private.key)}/edited-${m.content.folder.sha}_20261125094000.xlsx`
  await P.put(ek, edited)
  const sv = await MA.savePrivateCard(u, m, { url: `${config.supabaseUrl}/storage/v1/object/public/${P.BUCKET}/${ek}`, session: 's1' })
  assert.equal(sv.content.folder_save.ok, true, JSON.stringify(sv.content.folder_save))
  assert.equal(sv.content.url, undefined)
  assert.ok(Buffer.from(await G.git(f.repo_path, ['show', `${f.default_branch}:${filed.body.filed.path}`], { buffer: true })).equals(edited), '저장이 폴더의 main 에')
  // no access to the folder any more: the mail's own copy
  await q(`delete from pro_folder_members where folder_id=$1 and principal_id=$2`, [f.id, u.id])
  const o2 = await call(u, 'POST', `/mail/attachments/${a.id}/0/open`, { name: NAMES[0] })
  assert.equal(o2.body.from, 'mail')
  assert.ok((await get(o2.body.url)).buf.equals(SHEET))
})

test('메신저: 동료는 이름 · 요약만(열기 403) → 열기 요청 → 주인이 그 파일만 공유 → 동료가 읽기 전용으로 · 경로 200, 방 밖 404, 거두면 403 · 404', { skip: !db }, async () => {
  const owner = await person('한지우', { gmail: true })
  const mate = await person('서민재')
  const out = await person('오태윤')
  const a = await card(owner)
  await sheet(owner, a)
  const t = await call(owner, 'POST', '/team/threads', { members: [mate.id], title: '11월 급여' })
  assert.equal(t.status, 200, t.text)
  rooms.push(t.body.id)
  // the owner drops the picture and the sheet (「파일도 공유」 off)
  const s = await call(owner, 'POST', `/team/threads/${t.body.id}/messages`, { text: '이번 달 급여대장이에요', refs: [{ type: 'mailatt', actionId: a.id, i: 0, name: NAMES[0], share: false }, { type: 'mailatt', actionId: a.id, i: 1, name: NAMES[1] }] })
  assert.equal(s.status, 200, s.text)
  assert.equal(s.body.kind, 'mailref')
  assert.deepEqual(s.body.refs.map((r) => r.state.card), ['mine', 'mine'])
  const [stored] = await q('select messages from chats where uuid=$1', [s.body.id])
  const keptRef = stored.messages.pgpt.refs[0]
  assert.deepEqual([keptRef.type, keptRef.name, keptRef.subject, keptRef.share], ['mailatt', NAMES[0], '2026년 11월 급여대장 확인 부탁드립니다', null])
  assert.doesNotMatch(JSON.stringify(stored), /storage\/v1|lite-private|attachment\.xlsx|\/raw\?/, '방에 남는 것에 주소 · 열쇠가 없다')
  // the colleague: the name and the summary only
  const seen = (await call(mate, 'GET', `/team/threads/${t.body.id}/messages`)).body.messages.at(-1)
  assert.deepEqual(seen.refs.map((r) => r.state.card), ['summary', 'summary'])
  const no = await call(mate, 'POST', '/team/refs/open', { messageId: seen.id, index: 0 })
  assert.equal(no.status, 403)
  assert.match(no.body.error, /메일 주인이 이 첨부를 공유하지 않았어요/)
  // nor through the AI chat
  const drag = await call(mate, 'POST', '/files/resolve', { items: [{ src: 'ref', messageId: seen.id, index: 0 }, { src: 'mailatt', id: a.id, i: 0, name: NAMES[0] }] })
  assert.deepEqual(drag.body.items.map((x) => [x.ok, x.status]), [[false, 403], [false, 404]])
  // a colleague's signed address for a room the file was not shared with: 404
  const guess = MA.signAtt({ key: MA.linkKeyOf(config.serviceKey), tenant: config.tenantId, actionId: a.id, i: 1, userId: mate.id, room: t.body.id, inline: true })
  assert.equal((await get(`${base}${MA.attPath(a.id, 1, guess)}`)).status, 404)
  // 열기 요청 → the owner is told once
  assert.equal((await call(mate, 'POST', '/team/refs/request', { messageId: seen.id, index: 0 })).body.requested, true)
  await call(mate, 'POST', '/team/refs/request', { messageId: seen.id, index: 0 })
  const notes = await q(`select title from notifications where user_id=$1 and type='mail_access'`, [owner.id])
  assert.equal(notes.length, 1)
  assert.match(notes[0].title, /메일 첨부 열기를 요청했어요/)
  // only the owner shares — that file only
  assert.equal((await call(mate, 'POST', '/team/refs/share', { messageId: seen.id, index: 1, on: true })).status, 403)
  const sh = await call(owner, 'POST', '/team/refs/share', { messageId: seen.id, index: 1, on: true })
  assert.equal(sh.status, 200, sh.text)
  const seen2 = (await call(mate, 'GET', `/team/threads/${t.body.id}/messages`)).body.messages.at(-1)
  assert.deepEqual(seen2.refs.map((r) => r.state.card), ['requested', 'shared'])
  const op = await call(mate, 'POST', '/team/refs/open', { messageId: seen.id, index: 1 })
  assert.equal(op.status, 200, op.text)
  assert.equal(op.body.mine, false)
  assert.equal(op.body.plan.how, 'view')
  assert.match(op.body.plan.url, new RegExp(`&r=${t.body.id}&inline=1&sig=`))
  const pic = await get(`${base}${op.body.plan.url}`)
  assert.equal(pic.status, 200)
  assert.ok(pic.buf.equals(PNG))
  assert.equal((await call(mate, 'POST', '/team/refs/open', { messageId: seen.id, index: 0 })).status, 403, '다른 첨부는 그대로 잠김')
  assert.equal((await call(out, 'POST', '/team/refs/open', { messageId: seen.id, index: 1 })).status, 404, '방 밖')
  // the sheet shared too: read only in the editor, a signed storage address
  await call(owner, 'POST', '/team/refs/share', { messageId: seen.id, index: 0, on: true })
  const doc = await call(mate, 'POST', '/team/refs/open', { messageId: seen.id, index: 0 })
  assert.equal(doc.body.plan.how, 'office')
  assert.equal(doc.body.plan.readOnly, true)
  assert.ok(P.isSignedUrl(doc.body.plan.url))
  assert.ok((await get(doc.body.plan.url)).buf.equals(SHEET))
  // the owner takes the picture back: 403 to open, the address it had is 404
  await call(owner, 'POST', '/team/refs/share', { messageId: seen.id, index: 1, on: false })
  assert.equal((await call(mate, 'POST', '/team/refs/open', { messageId: seen.id, index: 1 })).status, 403)
  assert.equal((await get(`${base}${op.body.plan.url}`)).status, 404)
  const seen3 = (await call(mate, 'GET', `/team/threads/${t.body.id}/messages`)).body.messages.at(-1)
  assert.deepEqual(seen3.refs.map((r) => r.state.card), ['shared', 'summary'])
  // the notice to the room says a mail attachment
  const tn = await q(`select title from notifications where user_id=$1 and type='team'`, [mate.id])
  assert.ok(tn.some((n) => /한지우님이 메일 첨부 「2026년 11월 테스트솔루션 정규직 급여대장\.xlsx」 외 1개를 멘션했어요/.test(n.title)), JSON.stringify(tn))
})

// ---------- review 11-25 ----------
test('MA-R1 턴의 끝: 넘겨받은 첨부를 에이전트가 이름 · 자리를 바꿔 남기거나 답에 적어도 카드(공개 사본)가 되지 않는다 — 그 턴의 진짜 산출물은 그대로 · 로그에 이름 없음', { skip: !db }, async () => {
  const u = await person('한지우', { gmail: true })
  const a = await card(u)
  await sheet(u, a)
  const { runTurn } = await import('../lib/agent.js')
  const { mainThread } = await import('../lib/store.js')
  const t = await mainThread(u.id)
  agent.bodies = []
  const n0 = logged.length
  await runTurn({ user: u, session: { access_token: 'test-token' }, threadId: t.id, text: '이 급여대장 총액 맞는지 봐줘', refs: [{ src: 'mail', id: a.id }, { src: 'mailatt', id: a.id, i: 0, name: NAMES[0] }] })
  assert.equal(agent.bodies.length, 1)
  assert.match(agent.bodies[0].message, new RegExp(`- /workspace/uploads/${u.id}/mail/[0-9a-f-]{36}/`))
  const cards = (await q(`select content from pro_messages where thread_id=$1 and kind='file' and role='agent' order by created_at`, [t.id])).map((m) => m.content)
  assert.deepEqual(cards.map((c) => c.name), ['총액_검토.xlsx'], JSON.stringify(cards))
  // no copy of the attachment went to the public bucket under this person
  const pub = (await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/${u.id}/`])).map((x) => x.name)
  assert.equal(pub.length, 1, '이번 턴의 산출물 하나만')
  for (const k of pub) {
    const { data } = await admin.storage.from('files').download(k)
    assert.ok(!Buffer.from(await data.arrayBuffer()).equals(SHEET), '첨부와 같은 바이트의 공개 사본이 없다')
  }
  const lines = logged.slice(n0).join('\n')
  assert.ok(!lines.includes(NAMES[0]), lines)
  assert.match(lines, /not attached \(an upload\)/)
  assert.match(lines, /not attached \(a mail attachment handed over this turn\)/)
})

test('MA-R2 같은 폴더 파일을 메일 시트와 메신저 링크로 — 어느 순서로 열어도 카드가 따로(비공개 카드에 주소 없음 · 링크 카드에 비공개 열쇠 없음)이고, 둘 다 폴더에 저장된다', { skip: !db }, async () => {
  const u = await person('한지우', { gmail: true })
  const mate = await person('서민재')
  const a = await card(u)
  await sheet(u, a)
  const filed = await call(u, 'POST', '/filing/file', { actionId: a.id, attachment: NAMES[0], newFolder: `급여대장 R2 ${u.id.slice(0, 4)}` })
  assert.equal(filed.status, 200, filed.text)
  const f = await S.folderBySlug(filed.body.filed.slug)
  folders.push(f.id)
  const fpath = filed.body.filed.path
  const t = await call(u, 'POST', '/team/threads', { members: [mate.id], title: '급여 폴더' })
  rooms.push(t.body.id)
  const sent = await call(u, 'POST', `/team/threads/${t.body.id}/messages`, { text: '폴더의 급여대장이에요', refs: [{ slug: f.slug, path: fpath }] })
  assert.equal(sent.status, 200, sent.text)
  const msgOf = async (id) => (await q('select * from pro_messages where id=$1', [id]))[0]
  const saveBoth = async (privId, linkId, tag) => {
    // the private card: the editor saved beside the private folder copy
    const pm = await msgOf(privId)
    const pk = `${P.dirOf(pm.content.private.key)}/edited-${pm.content.folder.sha}_2026112509${tag}00.xlsx`
    const v1 = await xlsx([['합계', Number(`61${tag}000`)]])
    await P.put(pk, v1)
    const pkUrl = `${config.supabaseUrl}/storage/v1/object/public/${P.BUCKET}/${pk}`
    assert.equal(MA.saveKindOf(pm, pkUrl), 'private')
    const sp = await MA.savePrivateCard(u, pm, { url: pkUrl, session: `s-${tag}` })
    assert.equal(sp.content.folder_save?.ok, true, JSON.stringify(sp.content.folder_save))
    assert.ok(Buffer.from(await G.git(f.repo_path, ['show', `${f.default_branch}:${fpath}`], { buffer: true })).equals(v1), '비공개 카드의 저장이 폴더에')
    // the link card: the editor saved beside its public copy — the way it always went (never the private branch)
    const lm = await msgOf(linkId)
    const sha = lm.content.folder.sha
    const lk = `pgpt-pro/folders/${f.id}/edited-${sha}_2026112509${tag}30.xlsx`
    const v2 = await xlsx([['합계', Number(`62${tag}000`)]])
    const { error } = await admin.storage.from('files').upload(lk, v2, { upsert: true })
    assert.equal(error, null)
    const lkUrl = `${config.supabaseUrl}/storage/v1/object/public/files/${lk}`
    assert.equal(MA.saveKindOf(lm, lkUrl), 'public', '링크 카드는 예전 길')
    assert.equal(MA.saveKindOf(pm, lkUrl), 'refuse', '비공개 카드에 공개 주소는 붙이지 않는다')
    // (the version the link card opened was changed meanwhile by the private card's save: kept beside it, as any folder edit — service.js)
    const r = await S.saveOfficeEdit(f, { name: u.name, email: u.email, id: u.id }, { path: fpath, base: sha, url: lkUrl, session: `l-${tag}` })
    assert.ok(r.commit)
    assert.ok(Buffer.from(await G.git(f.repo_path, ['show', `${f.default_branch}:${r.path}`], { buffer: true })).equals(v2), '링크 카드의 저장이 폴더에')
  }
  const apart = async (privId, linkId) => {
    assert.notEqual(privId, linkId, '카드가 따로')
    const [pm, lm] = [await msgOf(privId), await msgOf(linkId)]
    assert.equal(pm.content.url, undefined)
    assert.ok(pm.content.private?.key)
    assert.ok(lm.content.url)
    assert.equal(lm.content.private, undefined)
  }
  // the mail sheet first, then the link
  const o1 = await MA.open(u, a.id, 0, { name: NAMES[0] })
  const l1 = await FR.open(u, sent.body.id, 0, { latest: true })
  await apart(o1.message.id, l1.message.id)
  await saveBoth(o1.message.id, l1.message.id, '1')
  // the link first, then the mail sheet (the version both saves made)
  const l2 = await FR.open(u, sent.body.id, 0, { latest: true })
  const o2 = await MA.open(u, a.id, 0, { name: NAMES[0] })
  await apart(o2.message.id, l2.message.id)
  await saveBoth(o2.message.id, l2.message.id, '2')
})

test('MA-R3 큰 메일은 크기부터 보고 받지 않음(413 — 몇 분 기억) · 동시에 둘이 열어도 한 번 받음 · 메신저 멘션은 메일함을 읽지 않음', { skip: !db }, async () => {
  MA.forgetFailures()
  const u = await person('한지우', { gmail: true })
  const big = await card(u, { mailId: 'g-att-big', subject: '큰 도면 묶음' })
  await q(`update pro_actions set source = source || jsonb_build_object('att_meta', $2::jsonb) where id=$1`, [big.id, JSON.stringify([{ name: '큰 도면.zip', size: 150 * 1024 * 1024, type: 'application/zip' }])])
  const c0 = { raw: gmail.raw, minimal: gmail.minimal }
  const r1 = await call(u, 'POST', `/mail/attachments/${big.id}/0/open`, { name: '큰 도면.zip' })
  assert.equal(r1.status, 413, r1.text)
  assert.equal(gmail.raw, c0.raw, '원문은 받지 않는다')
  assert.equal(gmail.minimal, c0.minimal + 1, '크기만 물었다')
  const r2 = await call(u, 'POST', `/mail/attachments/${big.id}/0/open`, { name: '큰 도면.zip' })
  assert.equal(r2.status, 413)
  assert.equal(gmail.minimal, c0.minimal + 1, '기억해 두고 다시 묻지 않는다')
  // two opens at the same moment: one fetch
  const a = await card(u)
  await sheet(u, a)
  const before = gmail.raw
  gmail.delay = 200
  const [x, y] = await Promise.all([0, 1].map(() => call(u, 'POST', `/mail/attachments/${a.id}/0/open`, { name: NAMES[0] })))
  gmail.delay = 0
  assert.deepEqual([x.status, y.status], [200, 200])
  assert.equal(gmail.raw, before + 1, '한 번만 받는다')
  // a messenger mention (both files, one shared): the mailbox is not read for it
  const mate = await person('서민재')
  const t = await call(u, 'POST', '/team/threads', { members: [mate.id], title: '큰 메일 R3' })
  rooms.push(t.body.id)
  const calls = gmail.calls
  const s = await call(u, 'POST', `/team/threads/${t.body.id}/messages`, { text: '첨부 둘', refs: [{ type: 'mailatt', actionId: a.id, i: 1, name: NAMES[1], share: true }, { type: 'mailatt', actionId: a.id, i: 2, name: NAMES[2] }] })
  assert.equal(s.status, 200, s.text)
  assert.equal((await call(u, 'POST', '/files/resolve', { items: [{ src: 'mailatt', id: a.id, i: 2, name: NAMES[2] }] })).body.items[0].ok, true)
  assert.equal(gmail.calls, calls, '멘션 · 칩은 메일함을 읽지 않는다')
  // a card that knows nothing of its attachments yet (its sheet never opened): pick it again from the sheet
  const fresh = await card(u)
  const n = await call(u, 'POST', '/files/resolve', { items: [{ src: 'mailatt', id: fresh.id, i: 0, name: NAMES[0] }] })
  assert.deepEqual([n.body.items[0].ok, n.body.items[0].status], [false, 404])
  assert.equal(gmail.calls, calls)
})

test('MA-R4 이름이 어려운 첨부(겹친 빈칸 · NBSP · 200자 넘는 이름)도 번호로 찾고, 이름은 같은 식으로 견준다 — 열기 · 정리된 폴더 · 메신저', { skip: !db }, async () => {
  const u = await person('한지우', { gmail: true })
  const a = await card(u, { mailId: 'g-att-odd', subject: '이름이 어려운 첨부' })
  const m = await sheet(u, a)
  const names = m.mail.attachments.map((x) => x.name)
  assert.equal(names.length, 3)
  // what a chip sends: trimmed and cut to 200 (src/fileDrag.js), white space as the page had it, or collapsed
  const sent = [names[0].replace(/\s+/g, ' '), names[1].replace(/ /g, ' '), names[2].trim().slice(0, 200)]
  for (const [k, nm] of sent.entries()) {
    const r = await call(u, 'POST', `/mail/attachments/${a.id}/${k}/open`, { name: nm })
    assert.equal(r.status, 200, `${k}: ${r.text}`)
    assert.equal(r.body.name, names[k], '이름은 카드의 것')
  }
  assert.equal((await call(u, 'POST', `/mail/attachments/${a.id}/0/open`, { name: '전혀 다른 파일.xlsx' })).status, 404)
  // filed under the name the sheet sent; opened with the collapsed one: the folder's copy
  const filed = await call(u, 'POST', '/filing/file', { actionId: a.id, attachment: names[0], newFolder: `견적 R4 ${u.id.slice(0, 4)}` })
  assert.equal(filed.status, 200, filed.text)
  folders.push((await S.folderBySlug(filed.body.filed.slug)).id)
  const o = await call(u, 'POST', `/mail/attachments/${a.id}/0/open`, { name: sent[0] })
  assert.equal(o.body.from, 'folder')
  // a messenger mention with the cut long name
  const mate = await person('서민재')
  const t = await call(u, 'POST', '/team/threads', { members: [mate.id], title: '이름 R4' })
  rooms.push(t.body.id)
  const s = await call(u, 'POST', `/team/threads/${t.body.id}/messages`, { text: '', refs: [{ type: 'mailatt', actionId: a.id, i: 2, name: sent[2] }] })
  assert.equal(s.status, 200, s.text)
  assert.equal(s.body.refs[0].name, names[2])
})

test('MA-R5 방을 나간 주인도 그 방의 공유를 끈다 — 메일 시트의 공유 목록 · 메시지의 「공유 그만두기」, 다시 공유는 방에 있어야', { skip: !db }, async () => {
  const owner = await person('한지우', { gmail: true })
  const mate = await person('서민재')
  const a = await card(owner)
  await sheet(owner, a)
  const t = await call(owner, 'POST', '/team/threads', { members: [mate.id], title: '11월 급여 R5' })
  rooms.push(t.body.id)
  const s = await call(owner, 'POST', `/team/threads/${t.body.id}/messages`, { text: '급여대장 · 사진', refs: [{ type: 'mailatt', actionId: a.id, i: 0, name: NAMES[0], share: true }, { type: 'mailatt', actionId: a.id, i: 1, name: NAMES[1], share: true }] })
  assert.equal(s.status, 200, s.text)
  assert.equal((await call(mate, 'POST', '/team/refs/open', { messageId: s.body.id, index: 0 })).status, 200)
  const list = await call(owner, 'GET', `/mail/attachments/${a.id}/shares`)
  // (a room of two is named after the other person, as the messenger shows it)
  assert.deepEqual(list.body.shares.map((x) => [x.i, x.room, x.title, x.name]), [[0, t.body.id, '서민재', NAMES[0]], [1, t.body.id, '서민재', NAMES[1]]])
  assert.equal((await call(mate, 'GET', `/mail/attachments/${a.id}/shares`)).status, 404, '남의 메일의 공유 목록은 없음')
  // the owner leaves the room
  await q(`update chat_rooms set participants = (select coalesce(jsonb_agg(p), '[]'::jsonb) from jsonb_array_elements(participants) p where p->>'id' <> $2) where id=$1`, [t.body.id, owner.id])
  // sharing anew needs the room; stopping does not
  assert.equal((await call(owner, 'POST', '/team/refs/share', { messageId: s.body.id, index: 0, on: true })).status, 404)
  const off1 = await call(owner, 'POST', '/team/refs/share', { messageId: s.body.id, index: 1, on: false })
  assert.equal(off1.status, 200, off1.text)
  assert.equal((await call(mate, 'POST', '/team/refs/open', { messageId: s.body.id, index: 1 })).status, 403)
  // the mail sheet's list: 「끄기」
  const off0 = await call(owner, 'POST', `/mail/attachments/${a.id}/0/unshare`, { room: t.body.id })
  assert.equal(off0.status, 200, off0.text)
  assert.deepEqual(off0.body.shares, [])
  const [kept] = await q('select messages from chats where uuid=$1', [s.body.id])
  assert.deepEqual(kept.messages.pgpt.refs.map((r) => r.share), [null, null], '방의 메시지도 곧바로 「공유 안 함」')
  assert.equal((await call(mate, 'POST', '/team/refs/open', { messageId: s.body.id, index: 0 })).status, 403)
  assert.equal((await call(mate, 'POST', `/mail/attachments/${a.id}/0/unshare`, { room: t.body.id })).status, 404, '남은 끌 수 없음')
  // someone else (not the owner) who is not in the room cannot stop it either
  const out = await person('오태윤')
  assert.equal((await call(out, 'POST', '/team/refs/share', { messageId: s.body.id, index: 0, on: false })).status, 404)
})

test('팩스(TIFF): 보기 화면(image/tiff 그대로) · 에이전트에는 쪽마다 PNG — 작업 공간이면 옆에, 아니면 비공개 서명 주소 · 손상된 TIFF 는 까닭', { skip: !db }, async () => {
  const u = await person('한지우', { gmail: true })
  const a = await card(u, { mailId: 'g-att-fax', subject: '[KT 스마트메시지 Plus] 팩스 메시지 도착알림' })
  await sheet(u, a)
  // the sheet's chip opens the viewer (not 「앱 안에서 열지 않는 형식」): this server's signed route, the fax as it came
  const r = await call(u, 'POST', `/mail/attachments/${a.id}/0/open`, { name: FAX_NAMES[0] })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual([r.body.how, r.body.media], ['view', 'image'])
  assert.match(r.body.url, /&inline=1&sig=/)
  const img = await get(`${base}${r.body.url}`)
  assert.equal(img.status, 200)
  assert.ok(img.buf.equals(FAX))
  assert.equal(img.headers.get('content-type'), 'image/tiff')
  // the agent's pods (no workspace here): the fax and each page as a PNG, by private signed addresses only
  const f = await MA.agentFile(u, a.id, 0, FAX_NAMES[0], {}, { workspace: async () => null })
  assert.match(f.line, /팩스·TIFF 라서 쪽마다 그림\(PNG\)으로 바꿔 두었어요/)
  const pages = [...f.line.matchAll(/(\d)쪽 (https?:\/\/\S+?)(?:,|$)/gm)].map((m) => m[2])
  assert.equal(pages.length, 2, f.line)
  for (const [n, url] of pages.entries()) {
    assert.ok(P.isSignedUrl(url), url)
    assert.match(url, new RegExp(`/sign/${P.BUCKET}/mail/localhost/${u.id}/${a.id}/0-[0-9a-f]{16}/page-${n + 1}\\.png\\?token=`))
    const png = await get(url)
    assert.equal(png.status, 200)
    assert.ok(png.buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG')
    assert.equal(png.buf.readUInt32BE(16), 1728); assert.equal(png.buf.readUInt32BE(20), 2290)
  }
  assert.doesNotMatch(f.line, /object\/public/)
  assert.equal(f.pages.length, 2)
  assert.ok(f.pages.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)))
  // a workspace on this machine: the pictures beside the fax, no address at all
  const ws = fs.mkdtempSync(path.join(tmp, 'ws-fax-'))
  const g = await MA.agentFile(u, a.id, 0, FAX_NAMES[0], {}, { workspace: async () => ws })
  assert.doesNotMatch(g.line, /https?:/)
  const rels = g.pages.map((x) => x.path)
  assert.equal(rels.length, 2)
  for (const rel of rels) {
    assert.match(rel, new RegExp(`^/workspace/uploads/${u.id}/mail/[0-9a-f-]{36}/arrive_xroshotplus_uengine1_20261125095030049_121017596357694-page[12]\\.png$`))
    assert.ok(g.line.includes(rel))
    assert.ok(fs.readFileSync(path.join(ws, rel.slice('/workspace'.length))).subarray(1, 4).equals(Buffer.from('PNG')))
  }
  // the chat turn: the pictures are handed over too (the turn's end never makes a public card of them)
  const t = await FR.turnRefs(u, [{ src: 'mailatt', id: a.id, i: 0, name: FAX_NAMES[0] }], { deps: { agentFile: (...x) => MA.agentFile(x[0], x[1], x[2], x[3], x[4], { workspace: async () => ws }) } })
  assert.equal(t.handed.length, 3, '팩스 + 쪽 그림 둘')
  // a damaged TIFF: the file still goes, with why there are no pictures
  const b = await MA.agentFile(u, a.id, 1, FAX_NAMES[1], {}, { workspace: async () => null })
  assert.match(b.line, /이 TIFF 는 파일이 손상되어 쪽 그림으로 바꾸지 못했어요/)
  assert.deepEqual(b.pages, [])
})

test('로그에 첨부 이름 · 바이트가 없다', { skip: !db }, () => {
  const all = logged.join('\n')
  for (const n of [...NAMES, ...ODD]) assert.ok(!all.includes(n), `로그에 「${n}」`)
  assert.ok(!all.includes('급여대장.xlsx'))
  assert.ok(!all.includes(SHEET.subarray(0, 32).toString('base64')))
})
