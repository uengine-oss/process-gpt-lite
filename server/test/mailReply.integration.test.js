// 메일에서 온 Home 카드의 답장 — 운영(2026-11-23)에서 「Reply」 카드를 누르자 에이전트가 회사 메일 도구
// (send_email)로 30초 만에 보냈다. 원문은 볼 곳이 없었고, 카드의 지시는 받는 사람을 사용자 자신의 주소로
// 잘못 적고 있었다. 고친 뒤: 카드는 원문과 답장 초안을 보여 주고, 보내기를 눌러야 Lite 서버가 보낸다.
// 받는 사람은 모델이 아니라 메일의 머리(Reply-To · From)로 정한다. 실제 DB, Gmail · 모델은 가짜 fetch.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// a throwaway vault keyring (the server's KEK is never touched); behind-the-gateway tenancy, so a
// mailbox's own tenant can be told from the default one
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-mailreply-test-'))
const kek = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: kek.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(dir, 'keyring.json')
delete process.env.PRO_VAULT_KEK
process.env.PRO_TENANT_FROM_HEADER = '1'

const { config } = await import('../config.js')
const { q, pool, admin } = await import('../lib/supa.js')
const vault = await import('../lib/vault.js')
const R = await import('../lib/mailReply.js')
const { pollInTenant, mailTenantOf } = await import('../lib/mail.js')
const { simpleParser } = await import('mailparser')

const users = []
const uploaded = []
const newUser = () => { const u = crypto.randomUUID(); users.push(u); return u }
after(async () => {
  for (const u of users) {
    for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_mail_seen', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_profile']) await q(`delete from ${t} where user_id=$1`, [u]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u])
    await q('delete from pro_threads where user_id=$1', [u])
  }
  if (uploaded.length) await admin.storage.from('files').remove(uploaded).catch(() => {})
  await pool.end()
  fs.rmSync(dir, { recursive: true, force: true })
})

const ME = 'me@lite.example'
// the mail as Gmail keeps it: a reply in a thread, from a colleague, with an attachment of its own
const ORIGINAL = await R.buildReply({
  from: { name: '김하늘', address: 'haneul.kim@northwind.example' }, to: [{ name: '홍길동', address: ME }],
  subject: 'Re: 12월 과정 강사 프로필', body: '네, 이도윤 님 프로필 보내 주시면 확인 후 회신드리겠습니다.\n\n김하늘 드림',
  original: { messageId: '<root-0@mail.example>', references: [] },
  attachments: [{ filename: '일정표.pdf', content: Buffer.from('%PDF-1.4 test') }],
}).then((raw) => raw.toString().replace(/^Message-ID: .*$/m, 'Message-ID: <orig-1@mail.example>'))

// fake Gmail and model; everything else (the local Supabase) goes through
const real = globalThis.fetch
const calls = []
let draftAnswer = { subject: 'Re: 12월 과정 강사 프로필', body: '안녕하세요, 김하늘 님.\n\n이도윤 님 프로필을 첨부해 드립니다.\n\n홍길동 드림' }
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.startsWith(config.google.gmailUrl) || u.startsWith(config.google.gmailUploadUrl)) {
    calls.push({ url: u, init, tenant: config.tenantId })
    if (u.includes('/messages/m-1?format=raw')) return Response.json({ id: 'm-1', threadId: 'thr-1', raw: Buffer.from(ORIGINAL).toString('base64url') })
    if (u.includes('/messages/send')) return Response.json({ id: 'sent-1', threadId: 'thr-1' })
    if (u.includes('/messages?')) return Response.json({ messages: [] })
    return Response.json({ error: { message: 'not found' } }, { status: 404 })
  }
  if (u === `${config.llm.baseUrl}/chat/completions`) {
    calls.push({ url: u, init })
    return Response.json({ choices: [{ message: { content: JSON.stringify(draftAnswer) }, finish_reason: 'stop' }] })
  }
  return real(url, init)
}

async function gmailCard({ scope = 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose', tenant = 'acme' } = {}) {
  const userId = newUser()
  await q('insert into pro_profile(user_id, email, name) values ($1,$2,$3)', [userId, ME, '홍길동'])
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'gmail',$2)`, [userId, ME])
  await vault.putItem(userId, 'oauth', 'google', { username: ME, access_token: 'at-test', refresh_token: 'rt-test', expires_at: Date.now() + 3600_000, scope, client_id: 'cid', tenant }, { actor: 'mail' })
  // the card the triage made — its instruction even names the wrong address, as on 2026-11-23
  const [a] = await q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Reply',$2,$3,$4) returning *`,
    [userId, '김하늘 님에게 프로필을 보내고 확인 후 회신하겠다고 답장', `${ME}에게 '네, 보내 주세요'라고 회신해 주세요.`, { mail_id: 'm-1', from: '"김하늘" <haneul.kim@northwind.example>', subject: 'Re: 12월 과정 강사 프로필' }])
  return { user: { id: userId, email: ME, name: '홍길동' }, action: a }
}

test('받는 사람은 메일 머리로: Reply-To 가 있으면 그쪽, 없으면 보낸 사람, 내가 보낸 메일이면 받은 사람들', () => {
  const from = { name: '김하늘', address: 'haneul@x.example' }
  assert.deepEqual(R.recipients({ from, to: [{ address: ME }], replyTo: [] }, [ME]).to, [from])
  assert.deepEqual(R.recipients({ from, to: [], replyTo: [{ name: '', address: 'desk@x.example' }] }, [ME]).to, [{ name: '', address: 'desk@x.example' }])
  const mine = R.recipients({ from: { name: '', address: ME.toUpperCase() }, to: [{ name: '', address: ME }, { name: 'A', address: 'a@y.example' }], replyTo: [] }, [ME])
  assert.deepEqual(mine.to, [{ name: 'A', address: 'a@y.example' }])
  assert.deepEqual(R.addresses('"김하늘" <haneul@x.example>, b@y.example'), [{ name: '김하늘', address: 'haneul@x.example' }, { name: '', address: 'b@y.example' }])
})

test('답장이 일인 메일 카드: 「Reply」, 또는 메일을 위해 만든 초안을 들고 온 카드 — 에이전트에게 넘기지 않는다(POST /run 거절)', () => {
  assert.equal(R.isReplyCard({ verb: 'Reply', source: { mail_id: 'm' } }), true)
  assert.equal(R.isReplyCard({ verb: 'Review', source: { mail_id: 'm', drafts: ['a.xlsx'] } }), true)
  assert.equal(R.isReplyCard({ verb: 'Review', source: { mail_id: 'm' } }), false)
  assert.equal(R.isReplyCard({ verb: 'Reply', source: null }), false, '메일에서 오지 않은 카드는 예전처럼')
})

test('카드를 열면 원문(보낸 사람 · 제목 · 본문 · 첨부 이름)이 오고, 받는 사람은 카드 지시가 아니라 원문의 보낸 사람', async () => {
  const { user, action } = await gmailCard()
  const m = await R.mailOfCard(user, action.id)
  assert.equal(m.provider, 'gmail')
  assert.equal(m.mode, 'send')
  assert.equal(m.mail.from.address, 'haneul.kim@northwind.example')
  assert.equal(m.mail.subject, 'Re: 12월 과정 강사 프로필')
  assert.match(m.mail.text, /프로필 보내 주시면 확인 후 회신/)
  assert.deepEqual(m.mail.attachments.map((x) => x.name), ['일정표.pdf'])
  assert.equal(m.to, '김하늘 <haneul.kim@northwind.example>')
  assert.equal(m.sent, null)
  // opening a card sends nothing and runs nothing
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0)
  const [row] = await q('select status from pro_actions where id=$1', [action.id])
  assert.equal(row.status, 'open')
})

test('초안은 모델이 쓰지만 받는 사람은 원문 머리로 정하고, 카드에 남겨 다시 열어도 같은 초안', async () => {
  const { user, action } = await gmailCard()
  const { reply } = await R.draftReply(user, action.id)
  assert.equal(reply.to, '김하늘 <haneul.kim@northwind.example>', '카드 지시의 잘못된 주소(사용자 자신)가 아니다')
  assert.match(reply.body, /프로필을 첨부해 드립니다/)
  const llm = calls.filter((c) => c.url.endsWith('/chat/completions')).pop()
  const sentToModel = JSON.parse(JSON.parse(llm.init.body).messages[1].content)
  assert.match(sentToModel.mail.text, /프로필 보내 주시면/, '모델은 원문을 본다')
  const again = await R.mailOfCard(user, action.id)
  assert.equal(again.reply.body, reply.body)
  assert.equal(calls.filter((c) => c.url.includes('/messages/send')).length, 0, '초안을 써도 보내지 않는다')
})

test('보내기: 같은 스레드에 In-Reply-To · References 를 달아 보내고, 초안 파일을 첨부하고, 카드를 닫고, 대화에 남긴다', async () => {
  const { user, action } = await gmailCard()
  // a document made for this mail: in storage, and its draft card in the chat (the card's address names
  // the object on another host spelling — the object is read from this server's own storage by its key)
  const key = `pgpt-pro/${user.id}/drafts/${crypto.randomUUID()}.docx`
  const { error } = await admin.storage.from('files').upload(key, Buffer.from('PK docx bytes'), { contentType: 'application/octet-stream' })
  assert.ifError(error)
  uploaded.push(key)
  const [t] = await q(`insert into pro_threads(user_id, kind, title) values ($1,'chat','채팅') returning id`, [user.id])
  const [card] = await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','file',$2) returning id`,
    [t.id, { name: '이도윤 프로필.docx', url: `https://storage.other-spelling.example/storage/v1/object/public/files/${key}`, mail_id: 'm-1', draft: true }])
  const before = calls.length
  const r = await R.sendReply(user, action.id, { to: '김하늘 <haneul.kim@northwind.example>', cc: '', subject: 'Re: 12월 과정 강사 프로필', body: '프로필을 보내 드립니다.\n\n홍길동 드림', files: [{ messageId: card.id }] })
  assert.equal(r.ok, true)
  assert.equal(r.sent.via, 'gmail')
  assert.deepEqual(r.sent.files, ['이도윤 프로필.docx'])
  assert.equal(calls.slice(before).filter((c) => c.url.includes('other-spelling')).length, 0, '카드 주소의 호스트로는 가지 않는다')
  const send = calls.slice(before).find((c) => c.url.includes('/messages/send'))
  assert.ok(send, 'Gmail 로 보냈다')
  assert.ok(send.url.startsWith(config.google.gmailUploadUrl) && send.url.includes('uploadType=multipart'))
  const body = Buffer.from(send.init.body).toString()
  assert.match(body, /"threadId":"thr-1"/)
  const raw = body.slice(body.indexOf('message/rfc822') + 'message/rfc822'.length).replace(/^\r\n\r\n/, '')
  const p = await simpleParser(raw.slice(0, raw.lastIndexOf('\r\n--')))
  assert.equal(p.inReplyTo, '<orig-1@mail.example>')
  assert.deepEqual([].concat(p.references), ['<root-0@mail.example>', '<orig-1@mail.example>'])
  assert.equal(p.to.value[0].address, 'haneul.kim@northwind.example')
  assert.equal(p.subject, 'Re: 12월 과정 강사 프로필')
  assert.match(p.text, /프로필을 보내 드립니다/)
  assert.deepEqual(p.attachments.map((a) => a.filename), ['이도윤 프로필.docx'])
  assert.equal(p.attachments[0].content.toString(), 'PK docx bytes')
  const [row] = await q('select status, source from pro_actions where id=$1', [action.id])
  assert.equal(row.status, 'done')
  assert.equal(row.source.sent.to, '김하늘 <haneul.kim@northwind.example>')
  const [msg] = await q(`select m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.content ? 'sent_mail'`, [user.id])
  assert.match(msg.content.text, /김하늘에게 답장 「Re: 12월 과정 강사 프로필」을 보냈어요/)
  // a second press does not send it twice
  await assert.rejects(R.sendReply(user, action.id, { to: 'haneul.kim@northwind.example', body: 'x' }), (e) => e.status === 409)
})

test('「보내기」가 거의 동시에 두 번 와도 한 번만 보낸다', async () => {
  const { user, action } = await gmailCard()
  const before = calls.length
  const input = { to: 'haneul.kim@northwind.example', subject: 'Re: x', body: '한 번만' }
  const results = await Promise.allSettled([R.sendReply(user, action.id, input), R.sendReply(user, action.id, input)])
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409)
  assert.equal(calls.slice(before).filter((c) => c.url.includes('/messages/send')).length, 1)
})

test('보내다 실패하면(Gmail 오류) 카드는 열린 채로 남고 다시 보낼 수 있다', async () => {
  const { user, action } = await gmailCard()
  const ok = globalThis.fetch
  globalThis.fetch = async (url, init) => String(url).includes('/messages/send') ? Response.json({ error: { message: 'backend error' } }, { status: 500 }) : ok(url, init)
  try {
    await assert.rejects(R.sendReply(user, action.id, { to: 'haneul.kim@northwind.example', body: '본문' }), (e) => e.status === 502 && /backend error/.test(e.message))
  } finally { globalThis.fetch = ok }
  const [row] = await q('select status, source from pro_actions where id=$1', [action.id])
  assert.equal(row.status, 'open')
  assert.equal(row.source.sending, undefined)
  const r = await R.sendReply(user, action.id, { to: 'haneul.kim@northwind.example', body: '본문' })
  assert.equal(r.ok, true)
})

test('보내기 권한이 없는 Gmail 연결(읽기만)은 보내지 않고 다시 연결하라고 한다', async () => {
  const { user, action } = await gmailCard({ scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' })
  const m = await R.mailOfCard(user, action.id)
  assert.equal(m.mode, 'none')
  const before = calls.length
  await assert.rejects(R.sendReply(user, action.id, { to: 'haneul.kim@northwind.example', body: '본문' }), (e) => e.status === 403 && e.code === 'gmail_scope')
  assert.equal(calls.slice(before).filter((c) => c.url.includes('/messages/send')).length, 0)
})

test('남의 파일이나 다른 메일의 파일은 첨부하지 않는다', async () => {
  const { user, action } = await gmailCard()
  await assert.rejects(R.sendReply(user, action.id, { to: 'haneul.kim@northwind.example', body: '본문', files: [{ key: `pgpt-pro/${crypto.randomUUID()}/att/x.pdf`, name: 'x.pdf' }] }), (e) => e.status === 400)
  await assert.rejects(R.sendReply(user, action.id, { to: 'haneul.kim@northwind.example', body: '본문', files: [{ messageId: crypto.randomUUID() }] }), (e) => e.status === 400)
  const [row] = await q('select status from pro_actions where id=$1', [action.id])
  assert.equal(row.status, 'open')
})

test('메일함 확인은 그 메일함을 연결한 회사에서 돈다(여러 회사에 속한 사람도) — 초안을 만드는 에이전트가 거절하지 않게', async () => {
  const { user } = await gmailCard({ tenant: 'acme' })
  assert.equal(await mailTenantOf(user.id, 'gmail'), 'acme')
  const before = calls.length
  await pollInTenant(user.id, 'gmail')
  const gmailCalls = calls.slice(before).filter((c) => c.url.startsWith(config.google.gmailUrl))
  assert.ok(gmailCalls.length, '메일함을 읽었다')
  assert.deepEqual([...new Set(gmailCalls.map((c) => c.tenant))], ['acme'], `기본 회사(${config.defaultTenantId})가 아니라 연결한 회사에서`)
})
