// 메일로 온 인증 코드, end to end inside the server process (as browser-vault.test.js): a real Chromium on the test
// shop in its e-mail mode (a new sign-in code mailed with each sign-in), the shop's mail landing in the person's demo
// mailbox, a scripted stand-in for the model that records every request, and a simulated person in the chat. Proves that
//   - while the code card asks, the code the site mailed is found in the mailbox and goes into the page by itself,
//   - a person who types it first wins, and the mail is not used after,
//   - another site's mail is not used, and nothing is looked at when the setting is off,
//   - an unattended task signs in with the mailed code,
//   - not one model request contains the code, and the audit log says where it came from (never the code).
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startShop, SHOP } from './fixtures/shop.mjs'

// ---- scripted model: signs in with the vault, asks for the one-time code, reads the account page ----
const llmBodies = []
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    llmBodies.push(body)
    let message
    if (body.response_format) {
      message = { role: 'assistant', content: JSON.stringify({ title: '테스트 상점 주문 확인', steps: ['로그인', '인증 코드', '주문 확인'] }) }
    } else {
      const snap = JSON.parse([...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{')).content)
      const [name, args] = brain(snap)
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llm.address().port}`
process.env.PRO_LLM_API_KEY = 'test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-mail-otp-'))
const k = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(k).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: k.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(dir, 'keyring.json')
delete process.env.PRO_VAULT_KEK

const vault = await import('../lib/vault.js')
const browser = await import('../lib/browser.js')
const mail = await import('../lib/mail.js')
const { q, pool } = await import('../lib/supa.js')

const user = crypto.randomUUID()
const ADDRESS = `mail-otp-${user.slice(0, 8)}@uengine.test`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const idx = (snap, pred) => snap.els.find(pred)?.i
let shop, threadId, mailDelay = 0, mailOn = true

// the model: vault login (two fills, then the button) → need_secret on the code page → read the account page
let askedCode = false, fills = 0
function brain(snap) {
  if (!/127\.0\.0\.1/.test(snap.url)) return ['goto', { url: `${shop.url}/login` }]
  const p = new URL(snap.url).pathname
  if (p === '/login') {
    fills++
    if (fills === 1) return ['fill_secret', { i: idx(snap, (e) => e.name === 'username'), field: 'username' }]
    if (fills === 2) return ['fill_secret', { i: idx(snap, (e) => e.name === 'password'), field: 'password' }]
    return ['click', { i: idx(snap, (e) => e.tag === 'button') }]
  }
  if (p === '/otp') {
    if (!askedCode) { askedCode = true; return ['need_secret', { i: idx(snap, (e) => e.name === 'code'), label: '이메일 인증 코드' }] }
    return ['click', { i: idx(snap, (e) => e.tag === 'button') }]
  }
  if (p === '/account') return ['finish', { summary: `최근 주문: ${/주문 #[^\n]+/.exec(snap.text)?.[0] || ''}` }]
  return ['finish', { summary: 'unexpected page ' + snap.url }]
}

before(async () => {
  shop = await startShop(0, {
    otpBy: 'mail', mailTo: ADDRESS,
    mail: async (m) => { if (!mailOn) return; setTimeout(() => mail.demoInbound(m).catch(() => {}), mailDelay) },
  })
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','mail otp test') returning id`, [user])
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2)`, [user, ADDRESS])
  await vault.putItem(user, 'login', '127.0.0.1', { username: SHOP.username, password: SHOP.password })
})
after(async () => {
  await browser.close(user)
  await shop.close()
  llm.close()
  for (const t of ['pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_threads', 'pro_mail_accounts', 'pro_demo_mail', 'pro_profile']) await q(`delete from ${t} where user_id=$1`, [user])
  await pool.end()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.browser-profiles', user), { recursive: true, force: true })
})

// each test signs in afresh: a new browser session, a new code, a new card
async function signIn({ unattended = false, person } = {}) {
  askedCode = false; fills = 0
  await browser.close(user)
  let stop = false
  const seen = new Set()
  const loop = (async () => {
    while (!stop && person) {
      for (const m of await q(`select * from pro_messages where thread_id=$1 and kind='vault' and content->>'state'='pending'`, [threadId])) {
        if (!seen.has(m.id)) { seen.add(m.id); await person(m) }
      }
      await sleep(200)
    }
  })()
  const t0 = Date.now()
  const result = await browser.runBrowserTask({ userId: user, threadId, goal: '테스트 상점에 로그인해서 최근 주문을 알려줘', unattended })
  stop = true; await loop
  const card = (await q(`select content from pro_messages where thread_id=$1 and kind='vault' and created_at >= $2 order by created_at desc limit 1`, [threadId, new Date(t0)]))[0]?.content
  const audit = (await vault.listAudit(user)).filter((a) => a.action === 'one_time' && Date.parse(a.created_at) >= t0)
  return { result, card, audit, t0 }
}
const modelText = () => JSON.stringify(llmBodies.map((b) => b.messages.map((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type !== 'image_url') : m))))
const codesSent = () => shop.state.mailed.map((m) => m.code)

test('the code the site mailed is found in the mailbox and goes in by itself, while the card asks', async () => {
  mailDelay = 1500
  const { result, card, audit } = await signIn({ person: async () => {} })   // the person never answers
  assert.equal(result.state, 'done', result.summary)
  assert.match(result.summary, /A-1001/)
  assert.deepEqual(shop.state.otps.map((o) => o.ok), [true])
  assert.equal(card.kind, 'secret'); assert.equal(card.mailWatch, true)
  assert.equal(card.state, 'mail'); assert.equal(card.mailFrom, 'shop.example')
  assert.deepEqual(audit.map((a) => `${a.actor}:${a.detail.from}`), ['mail:shop.example'])
  for (const code of codesSent()) assert.ok(!modelText().includes(code), 'a mailed code reached the model')
  assert.ok(!JSON.stringify(card).includes(codesSent().at(-1)))
})

test('a person who types the code first wins, and the late mail is not used', async () => {
  mailDelay = 12000
  const before = shop.state.otps.length
  const { result, card, audit } = await signIn({
    // the person reads it off another device (here: what the shop sent) and types it into the card
    person: async (m) => { await sleep(1500); assert.equal(await browser.provideSecret(user, shop.state.mailed.at(-1).code), true); await q(`update pro_messages set content=content||'{"state":"used"}' where id=$1`, [m.id]) },
  })
  assert.equal(result.state, 'done', result.summary)
  assert.deepEqual(shop.state.otps.slice(before).map((o) => o.ok), [true])
  assert.equal(card.state, 'used')
  assert.deepEqual(audit.map((a) => a.actor), ['user'])
  await sleep(12000)   // the mail arrives after all; nothing more happens with it
  assert.equal(shop.state.otps.length, before + 1)
})

test("another site's code is not used: the card stays with the person", async () => {
  mailOn = false; mailDelay = 0
  const before = shop.state.otps.length
  const { result, card, audit } = await signIn({
    person: async (m) => {
      await mail.demoInbound({ to: ADDRESS, from: '은행 <no-reply@bank.example>', subject: '[은행] 인증 코드', text: '인증 코드는 777777 입니다' })
      await sleep(7000)   // the watcher has looked more than once by now
      assert.equal((await q('select content from pro_messages where id=$1', [m.id]))[0].content.state, 'pending')
      assert.equal(await browser.provideSecret(user, shop.state.mailed.at(-1).code), true)
      await q(`update pro_messages set content=content||'{"state":"used"}' where id=$1`, [m.id])
    },
  })
  mailOn = true
  assert.equal(result.state, 'done', result.summary)
  assert.deepEqual(shop.state.otps.slice(before).map((o) => o.ok), [true])
  assert.equal(card.state, 'used')
  assert.deepEqual(audit.map((a) => a.actor), ['user'])
})

test('turned off: the card does not watch the mailbox', async () => {
  await q(`insert into pro_profile(user_id, email, mail_codes) values ($1,$2,false) on conflict (user_id) do update set mail_codes=false`, [user, ADDRESS])
  mailDelay = 500
  const { result, card, audit } = await signIn({
    person: async (m) => {
      await sleep(5000)
      assert.equal((await q('select content from pro_messages where id=$1', [m.id]))[0].content.state, 'pending')
      assert.equal(await browser.provideSecret(user, shop.state.mailed.at(-1).code), true)
      await q(`update pro_messages set content=content||'{"state":"used"}' where id=$1`, [m.id])
    },
  })
  await q('update pro_profile set mail_codes=true where user_id=$1', [user])
  assert.equal(result.state, 'done', result.summary)
  assert.equal(card.mailWatch, undefined)
  assert.equal(card.state, 'used')
  assert.deepEqual(audit.map((a) => a.actor), ['user'])
})

test('an unattended task signs in with the mailed code (no card)', async () => {
  mailDelay = 1000
  const before = shop.state.otps.length
  const { result, card, audit } = await signIn({ unattended: true })
  assert.equal(result.state, 'done', result.summary)
  assert.match(result.summary, /A-1001/)
  assert.deepEqual(shop.state.otps.slice(before).map((o) => o.ok), [true])
  assert.equal(card, undefined)
  assert.deepEqual(audit.map((a) => a.actor), ['mail'])
  for (const code of codesSent()) assert.ok(!modelText().includes(code), 'a mailed code reached the model')
})
