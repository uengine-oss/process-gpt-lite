// Telegram notifications (lib/telegram.js, routes/telegram.js) against the mock Bot API
// (scripts/mock-telegram.mjs, started here on a free port).
// The pure parts — markdown → plain text, splitting long text, finding the /start, cleaning a pasted
// token — need nothing. connect → link → send → status → bad token → disconnect use the vault and so
// the dev database; they are skipped when it is not up. As in vault.test.js a throwaway keyring keeps
// the server's KEK untouched; the test user (pro-rt-telegram@uengine.org, a fixed id derived from it)
// is removed from the vault tables at the end.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-telegram-test-'))
const keyringFile = path.join(dir, 'keyring.json')
const kek = crypto.randomBytes(32)
const kekId = crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
fs.writeFileSync(keyringFile, JSON.stringify({ current: kekId, keys: [{ id: kekId, key: kek.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = keyringFile
delete process.env.PRO_VAULT_KEK

const { startMockTelegram } = await import('../../scripts/mock-telegram.mjs')
const mock = await startMockTelegram({ port: 0 })
process.env.PRO_TELEGRAM_API = mock.url

const T = await import('../lib/telegram.js')
const { q, pool } = await import('../lib/supa.js')
const express = (await import('express')).default
const { telegramRoutes } = await import('../routes/telegram.js')

const EMAIL = 'pro-rt-telegram@uengine.org'
const USER = (() => {
  const h = crypto.createHash('sha1').update(`pgpt-lite-test:${EMAIL}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
})()
const TOKEN = '700000001:AAtestTokenForLiteTelegram_01234567' // 35 characters after the colon, as BotFather's
const SECRET_PART = TOKEN.split(':')[1]

const dbUp = await Promise.race([
  q('select 1 from pro_vault_items limit 1').then(() => true, () => false),
  new Promise((ok) => setTimeout(() => ok(false), 4000).unref()),
])
const needsDb = { skip: !dbUp && 'dev database (127.0.0.1:54322) is not up' }
const wipe = () => Promise.all(['pro_vault_items', 'pro_vault_keys', 'pro_vault_audit'].map((t) => q(`delete from ${t} where user_id=$1`, [USER])))

const mockApi = async (p, body) => (await fetch(mock.url + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json()
const sent = async () => (await mockApi(`/_sent?token=${encodeURIComponent(TOKEN)}`)).result

after(async () => {
  if (dbUp) await wipe().catch(() => {})
  await pool.end().catch(() => {})
  await mock.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- pure ----------

test('markdown the agents write becomes plain text', () => {
  const md = [
    '# 급등락 알림',
    '',
    '**코스피** 5일 누적 *+5.2%* · __테슬라__ ~~보합~~',
    '',
    '| 종목 | 5일 변동 |',
    '|---|---:|',
    '| AST 모바일 | **-6.1%** |',
    '',
    '- [자세히 보기](https://finance.example/ast)',
    '* `snake_case_name` 은 그대로, 2*3*4 도 그대로',
    '- [x] 확인함',
    '---',
    '> 투자 권유가 아니에요',
    '```json',
    '{"a": 1}',
    '```',
  ].join('\n')
  const out = T.toPlain(md)
  assert.equal(out.split('\n')[0], '급등락 알림')
  assert.ok(out.includes('코스피 5일 누적 +5.2% · 테슬라 보합'), out)
  assert.ok(out.includes('종목 · 5일 변동\nAST 모바일 · -6.1%'), out)
  assert.ok(out.includes('• 자세히 보기 (https://finance.example/ast)'))
  assert.ok(out.includes('• snake_case_name 은 그대로, 2*3*4 도 그대로'))
  assert.ok(out.includes('☑ 확인함'))
  assert.ok(out.includes('투자 권유가 아니에요') && !out.includes('> '))
  assert.ok(out.includes('{"a": 1}') && !out.includes('```'))
  for (const mark of ['**', '__', '~~', '`', '|---', '# ']) assert.ok(!out.includes(mark), `${mark} left in:\n${out}`)
})

test('long text goes in numbered pieces of at most 4096 characters, nothing lost', () => {
  assert.deepEqual(T.splitMessage('짧은 알림'), ['짧은 알림'])
  assert.deepEqual(T.splitMessage('   '), [])
  const paras = Array.from({ length: 40 }, (_, i) => `${i + 1}번째 문단 ` + '가나다라마바사 '.repeat(30).trim())
  const pieces = T.splitMessage(paras.join('\n\n'))
  assert.ok(pieces.length >= 3, `${pieces.length} pieces`)
  pieces.forEach((p, i) => {
    assert.ok(p.length <= T.TG_LIMIT, `piece ${i + 1} is ${p.length}`)
    assert.ok(p.endsWith(`\n(${i + 1}/${pieces.length})`))
  })
  const back = pieces.map((p) => p.replace(/\n\(\d+\/\d+\)$/, '')).join('\n\n')
  assert.equal(back, paras.join('\n\n'), 'cut only at paragraph breaks')
  // no break anywhere: a hard cut, never between the halves of an emoji
  const emoji = '📈'.repeat(3000)
  const hard = T.splitMessage(emoji)
  assert.ok(hard.every((p) => p.length <= T.TG_LIMIT))
  assert.equal(hard.map((p) => p.replace(/\n\(\d+\/\d+\)$/, '')).join(''), emoji)
  assert.ok(hard.every((p) => !/[\ud800-\udbff](?![\udc00-\udfff])/.test(p)), 'no lone surrogate')
})

test('the chat is only the one that sent /start <nonce> — a plain /start (anyone who knows the bot) is not linked', () => {
  const now = 1_800_000_000
  const msg = (id, chat, text, date = now, type = 'private') => ({ update_id: id, message: { chat: { id: chat, type, first_name: `사람${chat}` }, from: { id: chat, first_name: `사람${chat}` }, text, date } })
  const ups = [msg(1, 11, '/start abc123'), msg(2, 22, '/start'), msg(3, 33, '/start', now, 'group'), msg(4, 44, '안녕하세요')]
  assert.deepEqual(T.findStartChat(ups, 'abc123', { since: now }), { chatId: 11, chatName: '사람11' })
  assert.equal(T.findStartChat(ups, 'other', { since: now }), null, 'a plain /start is never linked')
  assert.equal(T.plainStartSeen(ups, { since: now }), true, 'but the card is told to use the link')
  assert.equal(T.plainStartSeen([msg(5, 55, '/start', now - 3600)], { since: now }), false, 'a /start from before connecting does not count')
  assert.equal(T.findStartChat([msg(6, 66, '/start', now, 'group'), msg(7, 77, 'hi')], 'x', { since: now }), null)
  assert.equal(T.findStartChat([], 'x'), null)
  const named = { message: { chat: { id: 9, type: 'private', first_name: '지윤', last_name: '김' }, text: '/start@my_lite_alert_bot n1', date: now } }
  assert.deepEqual(T.findStartChat([named], 'n1'), { chatId: 9, chatName: '지윤 김' })
})

test('a pasted token is cleaned; anything that could leave the request path is refused', () => {
  const botfather = 'Done! Congratulations on your new bot.\nUse this token to access the HTTP API:\n' + TOKEN + '\nKeep your token secure'
  assert.equal(T.cleanToken(botfather), TOKEN)
  assert.equal(T.cleanToken(botfather.replace(/\n/g, '')), TOKEN, 'pasted into an input (line breaks dropped)')
  assert.equal(T.cleanToken(`  bot${TOKEN} `), TOKEN)
  assert.equal(T.cleanToken('bad123:wrong'), 'bad123:wrong')
  assert.equal(T.cleanToken('bad123456:AAwrongTokenWrongTokenWrong'), 'bad123456:AAwrongTokenWrongTokenWrong', 'no token cut out of a longer word')
  for (const bad of ['', '   ', 'no-colon', '123:abc/../getMe', '123:abc?x=1', '123 456:abc']) assert.equal(T.cleanToken(bad), '', bad)
})

// ---------- with the vault (dev database) ----------

test('connect → link → send → status, and the token never comes back', needsDb, async () => {
  await wipe()
  await mockApi('/_reset', {})
  const c = await T.connectBot(USER, `토큰: ${TOKEN}`)
  assert.equal(c.bot, 'my_lite_alert_bot')
  assert.match(c.link, /^https:\/\/t\.me\/my_lite_alert_bot\?start=[A-Za-z0-9_-]{8,64}$/)
  assert.equal(c.linked, false)
  const nonce = new URL(c.link).searchParams.get('start')

  let s = await T.telegramStatus(USER)
  assert.deepEqual({ ...s, link: undefined }, { connected: true, bot: 'my_lite_alert_bot', linked: false, chatName: null, link: undefined })
  assert.equal(s.link, c.link)
  await assert.rejects(T.sendTelegram(USER, '아직'), { code: 'telegram_not_linked', status: 409 })
  assert.deepEqual(await T.linkChat(USER), { linked: false }, 'nobody pressed Start yet')

  // the person opens the link and presses Start; someone else sends a bare /start later
  await mockApi('/_press', { token: TOKEN, text: `/start ${nonce}`, chat: { id: 4242, first_name: '지윤' } })
  await mockApi('/_press', { token: TOKEN, text: '/start', chat: { id: 9999, first_name: '다른 사람' } })
  assert.deepEqual(await T.linkChat(USER), { linked: true, chatName: '지윤' })
  const welcome = await sent()
  assert.equal(welcome.length, 1)
  assert.equal(welcome[0].chat_id, 4242)
  assert.ok(welcome[0].text.includes('연결됐어요'))
  assert.deepEqual(await T.linkChat(USER), { linked: true, chatName: '지윤' }, 'asking again changes nothing')
  assert.equal((await mockApi('/_state')).bots[0].updates, 0, 'the updates read were acknowledged')

  // a long markdown report: several plain pieces to the linked chat
  const body = Array.from({ length: 24 }, (_, i) => `## ${i + 1}회차 확인\n\n**코스피** 5일 누적 *+${i}.0%* — ` + '변동 폭이 커요 '.repeat(40)).join('\n\n')
  const r = await T.sendTelegram(USER, body, { title: '급등락 감시' })
  assert.ok(r.sent >= 2, `${r.sent} pieces`)
  assert.equal(r.chatName, '지윤')
  const msgs = (await sent()).slice(1)
  assert.equal(msgs.length, r.sent)
  assert.ok(msgs[0].text.startsWith('급등락 감시\n\n1회차 확인'), msgs[0].text.slice(0, 40))
  for (const m of msgs) {
    assert.equal(m.chat_id, 4242)
    assert.equal(m.parse_mode, null, 'plain text, no parse_mode')
    assert.ok(m.text.length <= 4096)
    assert.ok(!m.text.includes('**') && !/^#/m.test(m.text), 'markdown marks taken out')
  }
  assert.equal(msgs.map((m) => m.text.replace(/\n\(\d+\/\d+\)$/, '')).join('\n\n').split('회차 확인').length - 1, 24, 'every section arrived')

  // nothing the page or a log could see holds the token
  s = await T.telegramStatus(USER)
  assert.deepEqual(s, { connected: true, bot: 'my_lite_alert_bot', linked: true, chatName: '지윤' })
  const [item] = (await (await import('../lib/vault.js')).listItems(USER)).filter((i) => i.site === 'telegram')
  const [row] = await q('select * from pro_vault_items where id=$1', [item.id])
  for (const text of [JSON.stringify(s), JSON.stringify(item), JSON.stringify(row), JSON.stringify(c)]) {
    assert.ok(!text.includes(SECRET_PART) && !text.includes(TOKEN), 'token leaked')
  }
  assert.equal(item.kind, 'apikey')
})

test('a wrong token is refused in plain words and the saved bot stays', needsDb, async () => {
  const before = await T.telegramStatus(USER)
  const bad = 'bad123456:AAwrongTokenWrongTokenWrong'
  await assert.rejects(T.connectBot(USER, bad), (e) => {
    assert.equal(e.status, 400)
    assert.equal(e.code, 'telegram_bad_token')
    assert.match(e.message, /토큰/)
    assert.ok(!e.message.includes(bad) && !e.message.includes('AAwrong'))
    return true
  })
  await assert.rejects(T.connectBot(USER, '그냥 글자'), { code: 'telegram_bad_token', status: 400 })
  assert.deepEqual(await T.telegramStatus(USER), before)
  // the same bot again keeps the chat it sends to
  const again = await T.connectBot(USER, TOKEN)
  assert.equal(again.linked, true)
  assert.equal(again.chatName, '지윤')
})

test('a blocked bot says so', needsDb, async () => {
  await mockApi('/_block', { token: TOKEN, chat_id: 4242 })
  await assert.rejects(T.sendTelegram(USER, '알림'), { code: 'telegram_blocked', status: 409 })
  const quiet = await T.sendTelegramIfLinked(USER, '알림')
  assert.equal(quiet.code, 'telegram_blocked')
  assert.match(quiet.error, /차단/)
  await mockApi('/_press', { token: TOKEN, text: '/start', chat: { id: 4242, first_name: '지윤' } }) // started again
  assert.equal((await T.sendTelegram(USER, '다시 와요')).sent, 1)
})

test('HTTP routes: status, test message, wrong token, disconnect', needsDb, async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', telegramRoutes((req, res, next) => { req.user = { id: USER }; next() }))
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  const base = `http://127.0.0.1:${server.address().port}/api`
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const text = await r.text()
    assert.ok(!text.includes(SECRET_PART), `${method} ${p} leaked the token`)
    return { status: r.status, body: JSON.parse(text) }
  }
  try {
    let r = await call('GET', '/telegram')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { connected: true, bot: 'my_lite_alert_bot', linked: true, chatName: '지윤' })
    const n = (await sent()).length
    r = await call('POST', '/telegram/test')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    const last = (await sent()).at(-1)
    assert.equal((await sent()).length, n + 1)
    assert.match(last.text, /Process GPT Lite 연결 시험 메시지예요/)
    r = await call('POST', '/telegram/connect', { token: 'bad999:AAnopeNopeNopeNopeNopeNope' })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'telegram_bad_token')
    assert.match(r.body.error, /토큰/)
    r = await call('POST', '/telegram/link')
    assert.deepEqual(r.body, { linked: true, chatName: '지윤' })
    r = await call('DELETE', '/telegram')
    assert.deepEqual(r.body, { ok: true, removed: 1 })
    r = await call('GET', '/telegram')
    assert.deepEqual(r.body, { connected: false, bot: null, linked: false, chatName: null })
    r = await call('POST', '/telegram/test')
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'telegram_not_connected')
    r = await call('POST', '/telegram/connect', { token: TOKEN })
    assert.equal(r.status, 200)
    assert.equal(r.body.linked, false, 'after disconnecting, the chat is asked for again')
    assert.match(r.body.link, /\?start=/)
  } finally { server.close() }
})

test('disconnect removes the bot; deliveries then skip Telegram quietly', needsDb, async () => {
  assert.deepEqual(await T.disconnect(USER), { ok: true, removed: 1 })
  assert.deepEqual(await T.telegramStatus(USER), { connected: false, bot: null, linked: false, chatName: null })
  await assert.rejects(T.sendTelegram(USER, '알림'), { code: 'telegram_not_connected', status: 409 })
  await assert.rejects(T.linkChat(USER), { code: 'telegram_not_connected' })
  assert.equal(await T.sendTelegramIfLinked(USER, '알림'), null)
  assert.deepEqual(await T.disconnect(USER), { ok: true, removed: 0 })
  const rows = await q(`select count(*)::int n from pro_vault_items where user_id=$1 and site='telegram'`, [USER])
  assert.equal(rows[0].n, 0)
})
