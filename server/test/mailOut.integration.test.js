// 「내 계정으로 보내기」 — 운영(2026-11-27, 녹화)에서 채팅으로 「이렇게 보내」라고 하자 에이전트가 회사 메일 도구(테넌트 MCP send_email)로
// 고객에게 답장을 직접 보냈다: 회사 공용 발송 계정에서, 받은 메일의 스레드가 아닌 새 메일로. 고친 뒤: Lite 의 턴은 그 도구를 받지 않고
// (metadata.hidden_tools), 에이전트의 메일은 「보낼 메일」 카드가 되며, 사람이 카드에서 보내기를 눌러야 그 사람이 연결한 메일함에서
// — 답장이면 받은 메일의 스레드 안에서 — 나간다. 연결한 메일이 없거나 보내기 권한이 없으면 보내지 않는다.
// 실제 DB · 실제 저장소. Gmail · 모델은 가짜 fetch, 회사 SMTP 는 가짜 SMTP 서버(아무도 닿지 않아야 한다). 사람 · 회사는 지어낸 것이다.
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
const { q, pool } = await import('../lib/supa.js')
const vault = await import('../lib/vault.js')
const R = await import('../lib/mailReply.js')
const O = await import('../lib/mailOut.js')
const turns = await import('../lib/turns.js')
const { callMailTool, MAIL_TOOL } = await import('../mcp/mail.js')
const { simpleParser } = await import('mailparser')

const users = []
const newUser = () => { const u = crypto.randomUUID(); users.push(u); return u }
const live = []
after(async () => {
  for (const t of live) t.finish()
  for (const u of users) {
    for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_profile']) await q(`delete from ${t} where user_id=$1`, [u]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u])
    await q('delete from pro_threads where user_id=$1', [u])
  }
  await pool.end()
  smtp.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const ME = 'hayun.jung@lite.example'
const CUSTOMER = { name: '김서연', address: 'seoyeon.kim@customer.example' }
const SUBJECT = '[교육 요청] 12월 바이브 코딩 실습 출강 요청의 건'
// the customer's mail as Gmail keeps it, in a thread of its own
const ORIGINAL = await R.buildReply({
  from: CUSTOMER, to: [{ name: '정하윤', address: ME }], subject: SUBJECT,
  body: '정하윤 대표님, 안녕하세요.\n12월 실습 출강을 요청드립니다. 출입 정보를 보내 주세요.\n\n김서연 드림',
  original: { messageId: '<root-0@customer.example>', references: [] },
}).then((raw) => raw.toString().replace(/^Message-ID: .*$/m, 'Message-ID: <cust-1@customer.example>'))

const real = globalThis.fetch
const calls = []
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.startsWith(config.google.gmailUrl) || u.startsWith(config.google.gmailUploadUrl)) {
    calls.push({ url: u, init })
    if (u.includes('/messages/cust-1?format=raw')) return Response.json({ id: 'cust-1', threadId: 'thr-cust', raw: Buffer.from(ORIGINAL).toString('base64url') })
    if (u.includes('/messages?')) {
      const qs = decodeURIComponent(new URL(u).searchParams.get('q') || '')
      return Response.json(qs.includes('바이브 코딩') && qs.includes(CUSTOMER.address) ? { messages: [{ id: 'cust-1', threadId: 'thr-cust' }] } : { messages: [] })
    }
    if (u.includes('/messages/send')) return Response.json({ id: 'sent-1', threadId: 'thr-cust' })
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
// the agent turn under way that calls the tool (lib/agent.js delegate)
function agentTurn(userId, threadId, conv = `conv-${crypto.randomBytes(4).toString('hex')}`) {
  const t = turns.enqueue({ userId, threadId, conv })
  t.agent = true; t.started = true
  live.push(t)
  return t
}
const DRAFT = { to: [`${CUSTOMER.name} <${CUSTOMER.address}>`], subject: `Re: ${SUBJECT}`, body: '김서연 팀장님, 안녕하세요.\n출입 정보를 보내 드립니다.\n- 박도윤: 생년월일 730210\n\n정하윤 드림' }

test('보낸 사람은 그 사람이 연결한 메일함: 없으면 연결하기, Gmail 보내기 권한이 없으면 none, IMAP 은 임시 보관함', async () => {
  assert.equal((await O.senderOf((await person({ provider: null })).user)).mode, 'connect')
  const g = await O.senderOf((await person()).user)
  assert.deepEqual([g.mode, g.address, g.provider], ['send', ME, 'gmail'])
  assert.equal((await O.senderOf((await person({ scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' })).user)).mode, 'none')
  assert.equal((await O.senderOf((await person({ provider: 'imap' })).user)).mode, 'drafts')
  assert.equal(O.baseSubject('RE: Re:  Fwd: 출강 요청'), '출강 요청')
})

test('에이전트의 도구는 보내지 않는다: 부른 턴의 채팅에 「보낼 메일」 카드 — 보낸 사람은 내 주소, 받은 메일의 스레드를 찾아 둔다', async () => {
  const { user, threadId } = await person()
  const t = agentTurn(user.id, threadId)
  const r = await callMailTool(user, MAIL_TOOL, DRAFT)
  const told = JSON.parse(r.content[0].text)
  assert.equal(told.sent, false)
  assert.equal(told.mode, 'send')
  assert.equal(told.from, `정하윤 <${ME}>`)
  assert.equal(told.thread.continues, true)
  assert.match(told.note, /아직 보내지 않았어요/)
  assert.equal(sends().length, 0, '카드를 띄워도 아무것도 나가지 않는다')
  const [card] = await q(`select * from pro_messages where id=$1`, [told.card])
  assert.equal(card.thread_id, threadId)
  assert.equal(card.kind, 'mail_out')
  assert.equal(card.content.owner, user.id)
  assert.equal(card.content.mail_out.state, 'pending')
  assert.equal(card.content.mail_out.reply.mailId, 'cust-1')
  assert.equal(card.content.mail_out.reply.threadId, 'thr-cust')
  assert.deepEqual(card.content.context, { conversationId: t.conv, action: 'aside' }, '그 턴의 대화에 붙는다')
  const v = await O.cardView(user, card.id)
  assert.equal(v.from, `정하윤 <${ME}>`)
})

test('보내기: 내 Gmail 에서, 받은 메일의 스레드 안에(threadId · In-Reply-To · References), 한 번만 — Home 카드도 답한 것으로', async () => {
  const { user, threadId } = await person()
  agentTurn(user.id, threadId)
  const [home] = await q(`insert into pro_actions(user_id, verb, text, source) values ($1,'Reply','김서연 팀장님께 출입 정보 회신',$2) returning id`, [user.id, { mail_id: 'cust-1', from: `${CUSTOMER.name} <${CUSTOMER.address}>`, subject: SUBJECT }])
  const told = JSON.parse((await callMailTool(user, MAIL_TOOL, { ...DRAFT, reply_to: { mail_id: home.id } })).content[0].text)
  const before = sends().length
  const r = await O.sendOut(user, told.card, {})
  assert.equal(r.ok, true)
  assert.equal(sends().length, before + 1)
  const req = sends().at(-1)
  const body = Buffer.from(req.init.body)
  const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/s.exec(body.toString())[1])
  assert.equal(meta.threadId, 'thr-cust', '받은 메일의 스레드로')
  const mail = await simpleParser(body.subarray(body.indexOf('message/rfc822') + 'message/rfc822\r\n\r\n'.length))
  assert.equal(mail.from.value[0].address, ME, '보낸 사람은 연결한 내 주소')
  assert.equal(mail.to.value[0].address, CUSTOMER.address)
  assert.equal(mail.inReplyTo, '<cust-1@customer.example>')
  assert.match(String(mail.references), /cust-1@customer\.example/)
  assert.equal(mail.subject, `Re: ${SUBJECT}`)
  assert.match(mail.text, /730210/)
  const [card] = await q(`select content from pro_messages where id=$1`, [told.card])
  assert.equal(card.content.mail_out.state, 'sent')
  assert.equal(card.content.mail_out.sent.from, `정하윤 <${ME}>`)
  assert.equal(card.content.mail_out.sent.thread, true)
  const [h] = await q(`select status, source from pro_actions where id=$1`, [home.id])
  assert.equal(h.status, 'done')
  assert.ok(h.source.sent, '메일 시트가 같은 답장을 다시 권하지 않는다')
  await assert.rejects(O.sendOut(user, told.card, {}), (e) => e.status === 409 && e.code === 'already')
  assert.equal(sends().length, before + 1, '두 번 눌러도 한 번')
})

test('두 번 동시에 눌러도 한 번만 나간다', async () => {
  const { user, threadId } = await person()
  agentTurn(user.id, threadId)
  const told = JSON.parse((await callMailTool(user, MAIL_TOOL, DRAFT)).content[0].text)
  const before = sends().length
  const got = await Promise.allSettled([O.sendOut(user, told.card, {}), O.sendOut(user, told.card, {})])
  assert.equal(got.filter((x) => x.status === 'fulfilled').length, 1)
  assert.equal(sends().length, before + 1)
})

test('연결한 메일이 없으면 보내지 않는다: 카드는 연결하기 · 초안으로 두기, 보내기는 409', async () => {
  const { user, threadId } = await person({ provider: null })
  agentTurn(user.id, threadId)
  const told = JSON.parse((await callMailTool(user, MAIL_TOOL, DRAFT)).content[0].text)
  assert.equal(told.mode, 'connect')
  assert.equal(told.from, null)
  assert.match(told.note, /연결되어 있지 않아/)
  const before = sends().length
  await assert.rejects(O.sendOut(user, told.card, {}), (e) => e.status === 409 && e.code === 'mail_not_connected')
  await O.keepOut(user, told.card)
  let [c] = await q(`select content from pro_messages where id=$1`, [told.card])
  assert.equal(c.content.mail_out.state, 'kept')
  await O.reopenOut(user, told.card)
  await O.cancelOut(user, told.card)
  ;[c] = await q(`select content from pro_messages where id=$1`, [told.card])
  assert.equal(c.content.mail_out.state, 'cancelled')
  await assert.rejects(O.sendOut(user, told.card, {}), (e) => e.status === 409)
  assert.equal(sends().length, before)
})

test('Gmail 이 보내기를 허락하지 않았으면 403, IMAP 은 임시 보관함에만', async () => {
  const ro = await person({ scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' })
  agentTurn(ro.user.id, ro.threadId)
  const told = JSON.parse((await callMailTool(ro.user, MAIL_TOOL, DRAFT)).content[0].text)
  assert.equal(told.mode, 'none')
  const before = sends().length
  await assert.rejects(O.sendOut(ro.user, told.card, {}), (e) => e.status === 403 && e.code === 'gmail_scope')
  assert.equal(sends().length, before)
})

test('다른 사람의 카드는 보이지도 보내지지도 않는다(404), Lite 에이전트 턴이 아니면 카드를 띄우지 않는다', async () => {
  const a = await person()
  agentTurn(a.user.id, a.threadId)
  const told = JSON.parse((await callMailTool(a.user, MAIL_TOOL, DRAFT)).content[0].text)
  const b = await person()
  await assert.rejects(O.cardView(b.user, told.card), (e) => e.status === 404)
  await assert.rejects(O.sendOut(b.user, told.card, {}), (e) => e.status === 404)
  const lonely = await person()
  await assert.rejects(O.propose(lonely.user, DRAFT), (e) => e.status === 409 && e.code === 'no_turn')
})

test('같은 메일을 고쳐 다시 쓰면 앞의 카드는 「고친 초안이 아래에」 — 누를 카드는 하나', async () => {
  const { user, threadId } = await person()
  agentTurn(user.id, threadId)
  const first = JSON.parse((await callMailTool(user, MAIL_TOOL, DRAFT)).content[0].text)
  agentTurn(user.id, threadId)
  const second = JSON.parse((await callMailTool(user, MAIL_TOOL, { ...DRAFT, body: `${DRAFT.body}\n(고친 판)` })).content[0].text)
  const rows = await q(`select id, content->'mail_out'->>'state' as state from pro_messages where thread_id=$1 and kind='mail_out' order by created_at`, [threadId])
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [[first.card, 'replaced'], [second.card, 'pending']])
})

test('받은 메일을 찾지 못하면 새 메일로 — 카드가 그렇게 말한다', async () => {
  const { user, threadId } = await person()
  agentTurn(user.id, threadId)
  const told = JSON.parse((await callMailTool(user, MAIL_TOOL, { to: ['박도윤 <doyun.park@else.example>'], subject: '처음 보내는 안내', body: '안녕하세요.' })).content[0].text)
  assert.equal(told.thread.continues, false)
})

test('회사 공용 발송 계정(SMTP)에는 아무것도 닿지 않았다', () => {
  assert.equal(smtpHits.length, 0)
})

test('Lite 의 턴은 회사 메일 도구를 숨기라고 deepagents 에 말한다(config.hiddenTools → metadata.hidden_tools)', async () => {
  assert.ok(config.hiddenTools.includes('send_email'))
  const src = await fs.promises.readFile(new URL('../lib/agent.js', import.meta.url), 'utf8')
  assert.match(src, /hidden_tools: config\.hiddenTools/)
})

test('예약된 스킬 실행(채팅 턴이 아님)도 그 작업이 알리는 채팅에 카드를 띄우고, 실행이 끝나면 띄우지 않는다', async () => {
  const { user, threadId } = await person()
  const told = await O.asAgentRun({ userId: user.id, threadId, conv: 'sched-conv-1' }, async () => JSON.parse((await callMailTool(user, MAIL_TOOL, DRAFT)).content[0].text))
  const [card] = await q(`select thread_id, content from pro_messages where id=$1`, [told.card])
  assert.equal(card.thread_id, threadId)
  assert.deepEqual(card.content.context, { conversationId: 'sched-conv-1', action: 'aside' })
  await assert.rejects(O.propose(user, DRAFT), (e) => e.code === 'no_turn')
})
