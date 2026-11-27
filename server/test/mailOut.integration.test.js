// 「내 계정으로 보내기」 — 운영(2026-11-27, 녹화)에서 채팅으로 「이렇게 보내」라고 하자 에이전트가 회사 메일 도구(테넌트 MCP send_email)로
// 고객에게 답장을 직접 보냈다: 회사 공용 발송 계정에서, 받은 메일의 스레드가 아닌 새 메일로. 고친 뒤: Lite 의 턴은 그 도구를 받지 않고
// (metadata.hidden_tools · hidden_tool_servers), 에이전트의 메일은 「보낼 메일」 카드가 되며, 사람이 카드에서 보내기를 눌러야 그 사람이
// 연결한 메일함에서 — 답장이면 받은 메일의 스레드 안에서 — 나간다. 나가는 것은 카드에 저장되고 보인 그대로뿐이다(보인 내용의 확인 값).
// 실제 DB · 실제 저장소. Gmail 은 가짜 fetch, 회사 SMTP 는 가짜 SMTP 서버(아무도 닿지 않아야 한다). 사람 · 회사 · 값은 지어낸 것이다.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-mailout-test-'))
const kek = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: kek.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(dir, 'keyring.json')
delete process.env.PRO_VAULT_KEK
// (what an operator adds to the defaults: one more tool, and a default taken out)
process.env.PRO_AGENT_HIDDEN_TOOLS = 'company_mail_send,-gmail_reply'
process.env.PRO_AGENT_HIDDEN_SERVERS = 'other-mailbox'

// the company's shared sending account, as process-gpt configures it for its own mail (polling service, the tenant mail tool):
// a fake SMTP server — nothing in Lite may ever connect to it
const smtpHits = []
const smtp = net.createServer((s) => { smtpHits.push(Date.now()); s.end('554 no\r\n') })
await new Promise((r) => smtp.listen(0, '127.0.0.1', r))
process.env.SMTP_SERVER = '127.0.0.1'
process.env.SMTP_PORT = String(smtp.address().port)
process.env.SMTP_USERNAME = 'shared-sender@company.example'
process.env.SMTP_PASSWORD = 'not-a-real-password'

const { config } = await import('../config.js')
const { q, pool, admin } = await import('../lib/supa.js')
const vault = await import('../lib/vault.js')
const R = await import('../lib/mailReply.js')
const O = await import('../lib/mailOut.js')
const turns = await import('../lib/turns.js')
const meta = await import('../lib/agentMeta.js')
const { pageFiles } = await import('../lib/attachments.js')
const { callMailTool, MAIL_TOOL, conversationOf } = await import('../mcp/mail.js')
const { simpleParser } = await import('mailparser')

const users = []
const uploaded = []
const newUser = () => { const u = crypto.randomUUID(); users.push(u); return u }
const live = []
after(async () => {
  for (const t of live) t.finish()
  for (const u of users) {
    for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_profile']) await q(`delete from ${t} where user_id=$1`, [u]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u])
    await q('delete from pro_threads where user_id=$1', [u])
  }
  if (uploaded.length) await admin.storage.from('files').remove(uploaded).catch(() => {})
  await pool.end()
  smtp.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const ME = 'hayun.jung@lite.example'
const CUSTOMER = { name: '김서연', address: 'seoyeon.kim@customer.example' }
const DESK = 'desk@customer.example'
const SUBJECT = '[견적 요청] 사무용 의자 납품 건'
// the customer's mail as Gmail keeps it, in a thread of its own — replies are asked to go to the customer's purchasing desk
const ORIGINAL = await R.buildReply({
  from: CUSTOMER, to: [{ name: '정하윤', address: ME }], subject: SUBJECT,
  body: '정하윤 대표님, 안녕하세요.\n사무용 의자 12개의 견적을 요청드립니다.\n\n김서연 드림',
  original: { messageId: '<root-0@customer.example>', references: [] },
}).then((raw) => raw.toString().replace(/^Message-ID: .*$/m, 'Message-ID: <cust-1@customer.example>').replace(/^Subject:/m, `Reply-To: ${DESK}\r\nSubject:`))

// the fake Gmail; how its send answers: ok · timeout (no answer in time) · server (504, a gateway gave up) · refuse (4xx) · error (500)
let sendHow = 'ok'
const real = globalThis.fetch
const calls = []
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.startsWith(config.google.gmailUrl) || u.startsWith(config.google.gmailUploadUrl)) {
    calls.push({ url: u, init })
    if (u.includes('/messages/cust-1?format=raw')) return Response.json({ id: 'cust-1', threadId: 'thr-cust', raw: Buffer.from(ORIGINAL).toString('base64url') })
    if (u.includes('/messages?')) {
      const qs = decodeURIComponent(new URL(u).searchParams.get('q') || '')
      return Response.json(qs.includes('사무용 의자') && qs.includes(CUSTOMER.address) ? { messages: [{ id: 'cust-1', threadId: 'thr-cust' }] } : { messages: [] })
    }
    if (u.includes('/messages/send')) {
      if (sendHow === 'timeout') throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
      if (sendHow === 'refuse') return Response.json({ error: { message: 'Invalid To header' } }, { status: 400 })
      if (sendHow === 'server') return Response.json({ error: { message: 'gateway timeout' } }, { status: 504 })
      if (sendHow === 'error') return Response.json({ error: { message: 'backend error' } }, { status: 500 })
      return Response.json({ id: 'sent-1', threadId: 'thr-cust' })
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 })
  }
  return real(url, init)
}
const sends = () => calls.filter((c) => c.url.includes('/messages/send'))

async function person({ provider = 'gmail', scope = 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose' } = {}) {
  const userId = newUser()
  await q('insert into pro_profile(user_id, email, name) values ($1,$2,$3)', [userId, ME, '정하윤'])
  if (provider) await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,$2,$3)`, [userId, provider, ME])
  if (provider === 'gmail') await vault.putItem(userId, 'oauth', 'google', { username: ME, access_token: 'at-test', refresh_token: 'rt-test', expires_at: Date.now() + 3600_000, scope, client_id: 'cid' }, { actor: 'mail' })
  const [t] = await q(`insert into pro_threads(user_id, kind, title) values ($1,'chat','채팅') returning id`, [userId])
  return { user: { id: userId, email: ME, name: '정하윤' }, threadId: t.id }
}
// the agent turn under way that calls the tool (lib/agent.js delegate), in its own conversation
function agentTurn(userId, threadId, conv = `conv-${crypto.randomBytes(4).toString('hex')}`) {
  const t = turns.enqueue({ userId, threadId, conv })
  t.agent = true; t.started = true
  live.push(t)
  return t
}
// the tool as deepagents calls it: the person's token, the agent's conversation in X-Conversation-Id
const tool = async (user, args, t) => JSON.parse((await callMailTool(user, MAIL_TOOL, args, { conv: t?.conv || null })).content[0].text)
// 보내기 as the card does it: what was shown, with its confirmation
const press = async (user, id) => O.sendOut(user, id, { confirm: (await O.cardView(user, id)).confirm })
const cardRow = async (id) => (await q(`select * from pro_messages where id=$1`, [id]))[0]
const DRAFT = { to: [`${CUSTOMER.name} <${CUSTOMER.address}>`], subject: `Re: ${SUBJECT}`, body: '김서연 팀장님, 안녕하세요.\n견적을 보내 드립니다.\n- 사무용 의자 품번 900101 · 12개\n\n정하윤 드림' }
// a file the person uploaded into this chat (POST /api/attachments: their own folder), as its card
async function upload(user, threadId, name, bytes) {
  const key = `pgpt-pro/${user.id}/att/${crypto.randomUUID()}.pdf`
  const { error } = await admin.storage.from('files').upload(key, Buffer.from(bytes), { contentType: 'application/pdf' })
  assert.ifError(error)
  uploaded.push(key)
  const [m] = await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'user','file',$2) returning id`,
    [threadId, { name, url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}`, attached: true }])
  return { key, id: m.id }
}

test('보낸 사람은 그 사람이 연결한 메일함: 없으면 연결하기, Gmail 보내기 권한이 없으면 none, IMAP 은 임시 보관함', async () => {
  assert.equal((await O.senderOf((await person({ provider: null })).user)).mode, 'connect')
  const g = await O.senderOf((await person()).user)
  assert.deepEqual([g.mode, g.address, g.provider], ['send', ME, 'gmail'])
  assert.equal((await O.senderOf((await person({ scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' })).user)).mode, 'none')
  assert.equal((await O.senderOf((await person({ provider: 'imap' })).user)).mode, 'drafts')
  assert.equal(O.baseSubject('RE: Re:  Fwd: 납품 견적'), '납품 견적')
})

test('에이전트의 도구는 보내지 않는다: 부른 대화의 채팅에 「보낼 메일」 카드 — 보낸 사람은 내 주소, 받은 메일의 스레드를 찾아 둔다', async () => {
  const { user, threadId } = await person()
  const t = agentTurn(user.id, threadId)
  const told = await tool(user, DRAFT, t)
  assert.equal(told.sent, false)
  assert.equal(told.mode, 'send')
  assert.equal(told.from, `정하윤 <${ME}>`)
  assert.equal(told.thread.continues, true)
  assert.match(told.note, /아직 보내지 않았어요/)
  assert.equal(sends().length, 0, '카드를 띄워도 아무것도 나가지 않는다')
  const card = await cardRow(told.card)
  assert.equal(card.thread_id, threadId)
  assert.equal(card.kind, 'mail_out')
  assert.equal(card.content.owner, user.id)
  assert.equal(card.content.mail_out.reply.mailId, 'cust-1')
  assert.equal(card.content.mail_out.reply.by, 'subject', '제목과 받는 사람으로 찾았다')
  assert.equal(card.content.mail_out.reply.replyTo, DESK, 'Reply-To 가 보낸 사람과 다르다고 카드에 남는다')
  assert.deepEqual(card.content.context, { conversationId: t.conv, action: 'aside' }, '그 턴의 대화에 붙는다')
  const v = await O.cardView(user, card.id)
  assert.equal(v.from, `정하윤 <${ME}>`)
  assert.ok(v.confirm, '보인 내용의 확인 값')
})

test('카드는 부른 에이전트의 대화로 찾는다 — 두 대화가 함께 돌아도, 대화 id 가 없고 둘이면 띄우지 않는다', async () => {
  const { user, threadId } = await person()
  const other = await q(`insert into pro_threads(user_id, kind, title) values ($1,'project','다른 방') returning id`, [user.id])
  const background = agentTurn(user.id, other[0].id, 'conv-background')
  const asked = agentTurn(user.id, threadId, 'conv-asked')
  const told = await tool(user, DRAFT, asked)
  assert.equal((await cardRow(told.card)).thread_id, threadId, '조용히 도는 다른 턴의 방이 아니라 부른 대화의 방')
  await assert.rejects(O.propose(user, DRAFT, { conv: 'conv-nobody' }), (e) => e.code === 'no_turn', '모르는 대화면 띄우지 않는다')
  await assert.rejects(O.propose(user, DRAFT), (e) => e.code === 'ambiguous_turn', '대화 id 없이 둘이면 고르지 않는다')
  background.finish()
  assert.equal(conversationOf('{{conversation_id}}'), null, '채워지지 않은 자리표시자는 없는 것')
  assert.equal(conversationOf('conv-1'), 'conv-1')
})

test('받는 사람 · 스레드는 짐작하지 않는다: 받는 사람도 메일 id 도 없으면 스레드 없이 받는 사람 빈 카드 — 보내기 거절', async () => {
  const { user, threadId } = await person()
  const t = agentTurn(user.id, threadId)
  const told = await tool(user, { subject: `Re: ${SUBJECT}`, body: DRAFT.body }, t)
  assert.equal(told.thread.continues, false, '제목만으로 받은 메일을 고르지 않는다')
  assert.equal(told.needs_recipient, true)
  const v = await O.cardView(user, told.card)
  assert.equal(v.to, '')
  await assert.rejects(O.sendOut(user, told.card, { confirm: v.confirm }), (e) => e.status === 400 && e.code === 'no_recipient')
  // with the mail named by its id, an empty recipient is the mail's own Reply-To
  const byId = await tool(user, { subject: `Re: ${SUBJECT}`, body: DRAFT.body, reply_to: { mail_id: 'cust-1' } }, t)
  const c = await cardRow(byId.card)
  assert.equal(c.content.mail_out.to, DESK)
  assert.equal(c.content.mail_out.reply.by, 'id')
  // a recipient who was not in that conversation is said on the card
  const outsider = await tool(user, { to: ['박도윤 <doyun.park@else.example>'], subject: `Re: ${SUBJECT}`, body: DRAFT.body, reply_to: { mail_id: 'cust-1' } }, t)
  assert.equal((await cardRow(outsider.card)).content.mail_out.reply.outsider, true)
  // an id that is not in this mailbox: no thread, and the card says so
  const gone = await tool(user, { ...DRAFT, reply_to: { mail_id: 'no-such-mail' } }, t)
  assert.equal(gone.thread.continues, false)
  assert.equal(gone.thread.mail_not_found, true)
})

test('보내기: 저장된 카드 그대로, 내 Gmail 에서, 받은 메일의 스레드 안에(threadId · In-Reply-To · References), 한 번만 — Home 카드도 답한 것으로', async () => {
  const { user, threadId } = await person()
  const t = agentTurn(user.id, threadId)
  const [home] = await q(`insert into pro_actions(user_id, verb, text, source) values ($1,'Reply','김서연 팀장님께 견적 회신',$2) returning id`, [user.id, { mail_id: 'cust-1', from: `${CUSTOMER.name} <${CUSTOMER.address}>`, subject: SUBJECT }])
  const told = await tool(user, { ...DRAFT, reply_to: { mail_id: home.id } }, t)
  const before = sends().length
  // what the request carries besides the confirmation is not read: only the saved card leaves
  const v = await O.cardView(user, told.card)
  const r = await O.sendOut(user, told.card, { confirm: v.confirm, to: 'attacker@else.example', body: 'other words' })
  assert.equal(r.ok, true)
  assert.equal(sends().length, before + 1)
  const body = Buffer.from(sends().at(-1).init.body)
  const metaPart = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/s.exec(body.toString())[1])
  assert.equal(metaPart.threadId, 'thr-cust', '받은 메일의 스레드로')
  const mail = await simpleParser(body.subarray(body.indexOf('message/rfc822') + 'message/rfc822\r\n\r\n'.length))
  assert.equal(mail.from.value[0].address, ME, '보낸 사람은 연결한 내 주소')
  assert.equal(mail.to.value[0].address, CUSTOMER.address, '요청에 실린 받는 사람이 아니라 카드의 받는 사람')
  assert.equal(mail.inReplyTo, '<cust-1@customer.example>')
  assert.match(String(mail.references), /cust-1@customer\.example/)
  assert.equal(mail.subject, `Re: ${SUBJECT}`)
  assert.match(mail.text, /900101/)
  assert.doesNotMatch(mail.text, /other words/)
  const card = await cardRow(told.card)
  assert.equal(card.content.mail_out.state, 'sent')
  assert.equal(card.content.mail_out.sent.from, `정하윤 <${ME}>`)
  const [h] = await q(`select status, source from pro_actions where id=$1`, [home.id])
  assert.equal(h.status, 'done')
  assert.ok(h.source.sent, '메일 시트가 같은 답장을 다시 권하지 않는다')
  await assert.rejects(press(user, told.card), (e) => e.status === 409)
  assert.equal(sends().length, before + 1, '두 번 눌러도 한 번')
})

test('보인 뒤 카드가 바뀌었거나 확인 값이 없으면 보내지 않는다(stale) — 사람의 고침은 카드에 먼저 저장되고 새 확인 값', async () => {
  const { user, threadId } = await person()
  const t = agentTurn(user.id, threadId)
  const told = await tool(user, DRAFT, t)
  const shown = await O.cardView(user, told.card)
  const before = sends().length
  await assert.rejects(O.sendOut(user, told.card, {}), (e) => e.code === 'stale', '확인 값 없이')
  // the card changed after it was shown (another edit): the old confirmation no longer holds
  const edited = await O.editOut(user, told.card, { body: `${DRAFT.body}\n(수량 확인 부탁드립니다)` })
  await assert.rejects(O.sendOut(user, told.card, { confirm: shown.confirm }), (e) => e.code === 'stale')
  assert.match(edited.body, /수량 확인/)
  assert.equal(edited.edited, true)
  const now = await cardRow(told.card)
  const sender = await O.senderOf(user), files = await O.filesNow(user, now)
  assert.ok(O.confirmOk(user.id, told.card, now.content.mail_out, sender, files, edited.confirm))
  assert.equal(O.confirmOk(user.id, told.card, now.content.mail_out, sender, files, edited.confirm, Date.now() + 16 * 60_000), false, '15분이 지나면 다시 보고')
  await O.sendOut(user, told.card, { confirm: edited.confirm })
  assert.equal(sends().length, before + 1)
})

test('보인 뒤 다른 메일함을 연결했거나 첨부 파일이 바뀌었으면 보내지 않는다(stale)', async () => {
  const { user, threadId } = await person()
  const t = agentTurn(user.id, threadId)
  // another mailbox connected after the card was shown
  const a = await tool(user, DRAFT, t)
  const shownA = await O.cardView(user, a.card)
  await q(`update pro_mail_accounts set address=$2 where user_id=$1`, [user.id, 'other.box@lite.example'])
  const before = sends().length
  await assert.rejects(O.sendOut(user, a.card, { confirm: shownA.confirm }), (e) => e.code === 'stale')
  const again = await O.cardView(user, a.card)
  assert.equal(again.from, '정하윤 <other.box@lite.example>', '다시 보면 지금 연결된 주소')
  await q(`update pro_mail_accounts set address=$2 where user_id=$1`, [user.id, ME])
  // a file swapped under its card after it was shown (same name, another object)
  const f = await upload(user, threadId, '단가표.pdf', '%PDF-1.4 price list')
  const b = await tool(user, { ...DRAFT, subject: `Re: ${SUBJECT} (단가표)`, attachments: ['단가표.pdf'] }, t)
  const shownB = await O.cardView(user, b.card)
  assert.deepEqual(shownB.files.map((x) => [x.name, x.size]), [['단가표.pdf', 19]])
  const other = await upload(user, threadId, '임시.pdf', '%PDF-1.4 another, longer file')
  const [o] = await q(`select content from pro_messages where id=$1`, [other.id])
  await q(`update pro_messages set content = content || jsonb_build_object('url', $2::text) where id=$1`, [f.id, o.content.url])
  await assert.rejects(O.sendOut(user, b.card, { confirm: shownB.confirm }), (e) => e.code === 'stale')
  assert.equal(sends().length, before)
  const shownB2 = await O.cardView(user, b.card)
  assert.equal(shownB2.files[0].size, 29, '다시 보면 지금의 파일')
  await O.sendOut(user, b.card, { confirm: shownB2.confirm })
  assert.equal(sends().length, before + 1)
})

test('보내기 전에 실패한 것(토큰을 받지 못함 · 연결 거부)은 「확인하지 못했어요」가 아니라 그냥 실패 — 카드는 다시 보낼 수 있다', async () => {
  const { user, threadId } = await person()
  const told = await tool(user, DRAFT, agentTurn(user.id, threadId))
  // the Google token ran out and cannot be refreshed (its client is gone): nothing was sent
  await vault.putItem(user.id, 'oauth', 'google', { username: ME, access_token: 'at-old', refresh_token: 'rt-test', expires_at: Date.now() - 60_000,
    scope: 'openid email https://www.googleapis.com/auth/gmail.compose', client_id: 'no-such-client' }, { actor: 'mail' })
  const before = sends().length
  await assert.rejects(press(user, told.card), (e) => e.code !== 'send_unknown')
  assert.equal((await cardRow(told.card)).content.mail_out.state, 'pending')
  assert.equal(sends().length, before)
  assert.equal(R.sendUncertain(Object.assign(new Error('no token'), { beforeSend: true })), false)
  assert.equal(R.sendUncertain(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), false)
  assert.equal(R.sendUncertain(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true, '보낸 뒤 끊긴 연결은 모른다')
})

test('두 번 동시에 눌러도 한 번만 나간다', async () => {
  const { user, threadId } = await person()
  const told = await tool(user, DRAFT, agentTurn(user.id, threadId))
  const before = sends().length
  const { confirm } = await O.cardView(user, told.card)
  const got = await Promise.allSettled([O.sendOut(user, told.card, { confirm }), O.sendOut(user, told.card, { confirm })])
  assert.equal(got.filter((x) => x.status === 'fulfilled').length, 1)
  assert.equal(sends().length, before + 1)
})

test('제때 답이 없거나 게이트웨이가 기다리다 끊으면(504) 「확인하지 못했어요」 — 다시 보내기를 막고, 사람이 보낸 편지함을 보고 정한다 · 거절이면 다시 보낼 수 있다', async () => {
  const { user, threadId } = await person()
  const t = agentTurn(user.id, threadId)
  for (const how of ['timeout', 'server']) {
    const told = await tool(user, { ...DRAFT, subject: `Re: ${SUBJECT} (${how})` }, t)
    sendHow = how
    await assert.rejects(press(user, told.card), (e) => e.code === 'send_unknown' && e.status === 504)
    sendHow = 'ok'
    assert.equal((await cardRow(told.card)).content.mail_out.state, 'unknown')
    const n = sends().length
    await assert.rejects(press(user, told.card), (e) => e.code === 'send_unknown', '확인 전에는 다시 보내지 않는다')
    assert.equal(sends().length, n)
    if (how === 'timeout') {
      await O.resolveOut(user, told.card, { sent: true })
      assert.equal((await cardRow(told.card)).content.mail_out.state, 'sent')
      assert.equal((await cardRow(told.card)).content.mail_out.sent.checked, true)
    } else {
      await O.resolveOut(user, told.card, { sent: false })
      assert.equal((await cardRow(told.card)).content.mail_out.state, 'pending')
    }
  }
  for (const how of ['refuse', 'error']) {
    const told = await tool(user, { ...DRAFT, subject: `Re: ${SUBJECT} (${how})` }, t)
    sendHow = how
    await assert.rejects(press(user, told.card), (e) => e.code === 'gmail_error')
    sendHow = 'ok'
    assert.equal((await cardRow(told.card)).content.mail_out.state, 'pending', 'Gmail 이 받지 않았다고 답한 것은 나가지 않았다')
  }
  assert.equal(R.sendUncertain({ code: 'mail_timeout' }, 'drafts'), true)
  assert.equal(R.sendUncertain(new TypeError('fetch failed')), true, '연결이 끊긴 것도 모른다')
  assert.equal(R.sendUncertain({ code: 'gmail_error', upstream: 403, status: 502 }), false)
  assert.equal(R.sendUncertain({ code: 'gmail_error', upstream: 500, status: 502 }), false)
})

test('이미 답한 메일은 다시 보내지 않는다 — 카드가 미리 말하고, 그 사이에 답했으면 보내기에서 거절', async () => {
  const { user, threadId } = await person()
  const t = agentTurn(user.id, threadId)
  const [home] = await q(`insert into pro_actions(user_id, verb, text, source) values ($1,'Reply','견적 회신',$2) returning id`, [user.id, { mail_id: 'cust-1', subject: SUBJECT }])
  const told = await tool(user, { ...DRAFT, reply_to: { mail_id: home.id } }, t)
  assert.equal((await O.cardView(user, told.card)).answered, null)
  await q(`update pro_actions set source = source || '{"sent": {"at": "2026-12-01T01:00:00Z", "to": "x"}}'::jsonb where id=$1`, [home.id])
  const before = sends().length
  await assert.rejects(press(user, told.card), (e) => e.code === 'already_answered')
  assert.equal(sends().length, before)
  const again = await tool(user, { ...DRAFT, body: `${DRAFT.body}\n다시`, reply_to: { mail_id: home.id } }, t)
  assert.equal(again.already_answered, true)
  assert.ok((await O.cardView(user, again.card)).answered)
})

test('연결한 메일이 없으면 보내지 않는다: 카드는 연결하기 · 초안으로 두기, 보내기는 409', async () => {
  const { user, threadId } = await person({ provider: null })
  const told = await tool(user, DRAFT, agentTurn(user.id, threadId))
  assert.equal(told.mode, 'connect')
  assert.equal(told.from, null)
  assert.match(told.note, /연결되어 있지 않아/)
  const before = sends().length
  await assert.rejects(press(user, told.card), (e) => e.status === 409 && e.code === 'mail_not_connected')
  await O.keepOut(user, told.card)
  assert.equal((await cardRow(told.card)).content.mail_out.state, 'kept')
  await O.reopenOut(user, told.card)
  await O.cancelOut(user, told.card)
  assert.equal((await cardRow(told.card)).content.mail_out.state, 'cancelled')
  await assert.rejects(press(user, told.card), (e) => e.status === 409)
  assert.equal(sends().length, before)
})

test('Gmail 이 보내기를 허락하지 않았으면 403', async () => {
  const ro = await person({ scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' })
  const told = await tool(ro.user, DRAFT, agentTurn(ro.user.id, ro.threadId))
  assert.equal(told.mode, 'none')
  const before = sends().length
  await assert.rejects(press(ro.user, told.card), (e) => e.status === 403 && e.code === 'gmail_scope')
  assert.equal(sends().length, before)
})

test('첨부는 내가 올린 파일 · 그 메일의 초안만, 크기와 어디서 왔는지 보이고, 같은 이름이 둘이면 고르지 않는다', async () => {
  const { user, threadId } = await person()
  const t = agentTurn(user.id, threadId)
  await upload(user, threadId, '견적서.pdf', '%PDF-1.4 quote')
  await upload(user, threadId, '사양.pdf', '%PDF-1.4 spec one')
  await upload(user, threadId, '사양.pdf', '%PDF-1.4 spec two')
  // a card that names an object outside the person's own folder (an old page, a forged address)
  await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'user','file',$2)`, [threadId, { name: '남의 파일.pdf', url: `${config.supabaseUrl}/storage/v1/object/public/files/pgpt-pro/${crypto.randomUUID()}/att/${crypto.randomUUID()}.pdf` }])
  const told = await tool(user, { ...DRAFT, attachments: ['견적서.pdf', '사양.pdf', '남의 파일.pdf', '없는 파일.pdf'] }, t)
  const v = await O.cardView(user, told.card)
  assert.deepEqual(v.files.map((f) => [f.name, f.origin, f.size]), [['견적서.pdf', 'upload', 14]])
  assert.deepEqual(v.missing.map((m) => [m.name, m.why]), [['사양.pdf', 'ambiguous'], ['남의 파일.pdf', 'not_allowed'], ['없는 파일.pdf', 'not_found']])
  assert.ok(v.missing.every((m) => m.reason))
  await O.sendOut(user, told.card, { confirm: v.confirm })
  const body = Buffer.from(sends().at(-1).init.body)
  const mail = await simpleParser(body.subarray(body.indexOf('message/rfc822') + 'message/rfc822\r\n\r\n'.length))
  assert.deepEqual(mail.attachments.map((a) => a.filename), ['견적서.pdf'])
})

test('페이지가 보낸 파일은 그 사람이 올린 것만 받는다(남의 저장소 주소는 대화에 들어가지 않는다)', () => {
  const me = crypto.randomUUID()
  const mine = { name: 'a.pdf', url: `${config.supabaseUrl}/storage/v1/object/public/files/pgpt-pro/${me}/att/${crypto.randomUUID()}.pdf` }
  const theirs = { name: 'b.pdf', url: `${config.supabaseUrl}/storage/v1/object/public/files/pgpt-pro/${crypto.randomUUID()}/att/${crypto.randomUUID()}.pdf` }
  const other = { name: 'c.pdf', url: 'https://else.example/c.pdf' }
  const sneaky = { name: 'd.pdf', url: `${config.supabaseUrl}/storage/v1/object/public/files/pgpt-pro/${me}/att/../../x/y.pdf` }
  assert.deepEqual(pageFiles(me, [mine, theirs, other, sneaky, null]), [mine])
  assert.deepEqual(pageFiles(me, 'nope'), [])
})

test('같은 메일을 고쳐 다시 쓰면(제목 · 받는 사람 · 답하는 메일이 같음) 앞의 카드는 「고친 초안이 아래에」 — 다른 메일 · 빈 제목은 그대로', async () => {
  const { user, threadId } = await person()
  const t = agentTurn(user.id, threadId)
  const first = await tool(user, DRAFT, t)
  const otherPerson = await tool(user, { ...DRAFT, to: ['박도윤 <doyun.park@else.example>'] }, t)
  const noSubject1 = await tool(user, { to: DRAFT.to, subject: '', body: '첫째' }, t)
  const noSubject2 = await tool(user, { to: DRAFT.to, subject: '', body: '둘째' }, t)
  const second = await tool(user, { ...DRAFT, body: `${DRAFT.body}\n(고친 판)` }, t)
  const state = async (id) => (await cardRow(id)).content.mail_out.state
  assert.equal(await state(first.card), 'replaced')
  assert.equal(await state(second.card), 'pending')
  assert.equal(await state(otherPerson.card), 'pending', '받는 사람이 다르면 다른 메일')
  assert.equal(await state(noSubject1.card), 'pending', '빈 제목끼리는 같은 메일로 보지 않는다')
  assert.equal(await state(noSubject2.card), 'pending')
})

test('다른 사람의 카드는 보이지도 보내지지도 않는다(404), Lite 에이전트 턴이 아니면 카드를 띄우지 않는다', async () => {
  const a = await person()
  const told = await tool(a.user, DRAFT, agentTurn(a.user.id, a.threadId))
  const b = await person()
  await assert.rejects(O.cardView(b.user, told.card), (e) => e.status === 404)
  await assert.rejects(O.sendOut(b.user, told.card, { confirm: (await O.cardView(a.user, told.card)).confirm }), (e) => e.status === 404)
  await assert.rejects(O.editOut(b.user, told.card, { body: 'x' }), (e) => e.status === 404)
  const lonely = await person()
  await assert.rejects(O.propose(lonely.user, DRAFT), (e) => e.status === 409 && e.code === 'no_turn')
})

test('예약된 스킬 실행(채팅 턴이 아님)도 그 실행의 대화로 찾아 그 작업이 알리는 채팅에 카드를 띄우고, 실행이 끝나면 띄우지 않는다', async () => {
  const { user, threadId } = await person()
  const told = await O.asAgentRun({ userId: user.id, threadId, conv: 'sched-conv-1', agentConv: 'agent-conv-1' }, () => tool(user, DRAFT, { conv: 'agent-conv-1' }))
  const card = await cardRow(told.card)
  assert.equal(card.thread_id, threadId)
  assert.deepEqual(card.content.context, { conversationId: 'sched-conv-1', action: 'aside' })
  await assert.rejects(O.propose(user, DRAFT, { conv: 'agent-conv-1' }), (e) => e.code === 'no_turn')
})

test('숨길 도구 · 서버: 기본값에 운영자가 더하고 「-이름」은 빼며, 서버 이름이 앞에 붙은 이름도 같은 도구 — 모든 에이전트 요청에 실린다', async () => {
  assert.ok(config.hiddenTools.includes('send_email'), '기본값은 그대로')
  assert.ok(config.hiddenTools.includes('company_mail_send'), '더한 것')
  assert.ok(!config.hiddenTools.includes('gmail_reply'), '「-gmail_reply」로 뺀 것')
  assert.deepEqual(config.hiddenServers.sort(), ['gmail-mcp', 'other-mailbox'])
  for (const n of ['send_email', 'gmail-mcp_send_email', 'srv__send_email', 'srv.send_email']) assert.equal(meta.isHiddenTool(n), true, n)
  for (const n of ['send_mail_as_me', 'gmail_draft', 'send_emails_digest']) assert.equal(meta.isHiddenTool(n), false, n)
  const m = meta.agentMetadata({ client: 'x', hidden_tools: [] })
  assert.ok(m.hidden_tools.includes('send_email'), '부르는 쪽이 비워도 숨길 목록이 이긴다')
  assert.deepEqual(m.hidden_tool_servers.sort(), ['gmail-mcp', 'other-mailbox'])
  for (const f of ['../lib/agent.js', '../lib/missions.js', '../lib/folders/runner.js']) {
    const src = await fs.promises.readFile(new URL(f, import.meta.url), 'utf8')
    assert.match(src, /metadata: agentMetadata\(/, `${f} 의 /chat/stream 요청은 agentMetadata 로`)
  }
})

test('회사 공용 발송 계정(SMTP)에는 아무것도 닿지 않았다', () => {
  assert.equal(smtpHits.length, 0)
})
