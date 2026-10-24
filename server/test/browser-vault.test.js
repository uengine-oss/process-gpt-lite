// Browser agent ↔ vault, end to end inside the server process: a real Chromium on a local test
// shop, a scripted stand-in for the model (an OpenAI-compatible server that records every request),
// and a simulated user answering the chat cards. Proves that
//   - a password/card request becomes a vault card, and what the user enters lands in the vault,
//   - the agent fills it server-side and the site receives the right value,
//   - not one model request contains a password, card number, CVC or one-time code.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startShop, SHOP } from './fixtures/shop.mjs'

// ---- scripted model: decides from the latest page snapshot, records every request ----
const llmBodies = []
let brain = null
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    llmBodies.push(body)
    let message
    if (body.response_format) {
      message = { role: 'assistant', content: JSON.stringify({ title: '테스트 상점 작업', steps: ['사이트 열기', '로그인 또는 결제', '결과 확인'] }) }
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

// throwaway keyring, as in vault.test.js
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-vault-browser-'))
const k = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(k).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: k.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(dir, 'keyring.json')
delete process.env.PRO_VAULT_KEK

const vault = await import('../lib/vault.js')
const browser = await import('../lib/browser.js')
const { q, pool } = await import('../lib/supa.js')

const CARD_A = { number: '4242424242424242', exp: '12/30', cvv: '7391', name: 'HONG GILDONG' }
const CARD_B = { number: '5555555555554444', exp: '11/29', cvv: '8642', name: 'HONG GILDONG' }
const WRONG = 'Wrong-Pass-0001'
const TYPED = 'Typed-By-User-8'
const SECRETS = [SHOP.password, WRONG, TYPED, SHOP.otp, CARD_A.number, CARD_B.number, CARD_A.cvv, CARD_B.cvv, '4242 4242 4242 4242']

const user = crypto.randomUUID()
let shop, threadId
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const idx = (snap, pred) => snap.els.find(pred)?.i
const pathOf = (snap) => new URL(snap.url).pathname

before(async () => {
  shop = await startShop(0, { cards: [CARD_A, CARD_B] })
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','vault test') returning id`, [user])
})
after(async () => {
  await browser.close(user)
  await shop.close()
  llm.close()
  for (const t of ['pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_threads']) await q(`delete from ${t} where user_id=$1`, [user])
  await pool.end()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.browser-profiles', user), { recursive: true, force: true })
})

// The user in the chat: answers vault/choice cards and plain "needs input" pauses.
function simulateUser({ card, needs }) {
  let stop = false
  const seen = new Set()
  let waiting = false
  const loop = (async () => {
    while (!stop) {
      const msgs = await q('select * from pro_messages where thread_id=$1 order by created_at', [threadId])
      for (const m of msgs) {
        if (['vault', 'choice'].includes(m.kind) && m.content.state === 'pending' && !seen.has(m.id)) { seen.add(m.id); await card(m) }
      }
      const task = msgs.filter((m) => m.kind === 'task').at(-1)
      const open = msgs.some((m) => ['vault', 'choice'].includes(m.kind) && m.content.state === 'pending' && m.content.mode !== 'capture')
      if (task?.content.state === 'needs_input' && !open && !waiting) { waiting = true; await needs?.(task) }
      if (task?.content.state === 'running') waiting = false
      await sleep(200)
    }
  })()
  return async () => { stop = true; await loop }
}
const settle = (m, state) => q(`update pro_messages set content = content || $2::jsonb where id=$1`, [m.id, JSON.stringify({ state })])
const cardsOf = async (kind) => (await q(`select content from pro_messages where thread_id=$1 and kind=$2 order by created_at`, [threadId, kind])).map((r) => r.content)
// every model request, without the screenshots
const modelText = () => JSON.stringify(llmBodies.map((b) => b.messages.map((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type !== 'image_url') : m))))

test('login: missing password is requested into the vault, a rejected one is replaced, the OTP is passed through', async () => {
  const st = { started: false, filled: {}, submits: 0, reportedFor: -1, otp: false, guessed: false }
  brain = (snap) => {
    if (!st.started) { st.started = true; return ['goto', { url: `${shop.url}/login` }] }
    const p = pathOf(snap)
    // a model that tries to type a password itself is refused
    if (p === '/login' && !st.guessed) { st.guessed = true; return ['type', { i: idx(snap, (e) => e.name === 'password'), text: 'model-guess-123' }] }
    if (p === '/login') {
      if (/올바르지 않습니다/.test(snap.text) && st.reportedFor !== st.submits) { st.reportedFor = st.submits; st.filled = {}; return ['login_failed', { reason: '비밀번호 오류' }] }
      if (!st.filled.user) { st.filled.user = true; return ['fill_secret', { i: idx(snap, (e) => e.name === 'username'), field: 'username' }] }
      if (!st.filled.pw) { st.filled.pw = true; return ['fill_secret', { i: idx(snap, (e) => e.name === 'password'), field: 'password' }] }
      st.submits++; st.filled = {}
      return ['click', { i: idx(snap, (e) => e.tag === 'button') }]
    }
    if (p === '/otp') {
      if (!st.otp) { st.otp = true; return ['need_secret', { i: idx(snap, (e) => e.name === 'code'), label: '휴대폰 인증 코드' }] }
      return ['click', { i: idx(snap, (e) => e.tag === 'button') }]
    }
    if (p === '/account') return ['finish', { summary: `최근 주문: ${/주문 #[^\n]+/.exec(snap.text)?.[0] || ''}` }]
    return ['finish', { summary: 'unexpected page ' + snap.url }]
  }
  const stop = simulateUser({
    card: async (m) => {
      const c = m.content
      if (c.kind === 'login' && c.mode === 'request') {
        // the user first types a wrong password
        await vault.putItem(user, 'login', c.site, { username: SHOP.username, password: WRONG }, { taskId: c.taskId })
        await settle(m, 'saved'); browser.resume(user, 'saved; use fill_secret')
      } else if (c.kind === 'login' && c.mode === 'update') {
        await vault.updateItem(user, c.itemId, { password: SHOP.password })
        await settle(m, 'saved'); browser.resume(user, 'updated; use fill_secret again')
      } else if (c.kind === 'secret') {
        assert.equal(await browser.provideSecret(user, SHOP.otp), true)
        await settle(m, 'used')
      }
    },
  })
  const result = await browser.runBrowserTask({ userId: user, threadId, goal: '테스트 상점에 로그인해서 최근 주문을 알려줘' })
  await stop()

  assert.equal(result.state, 'done')
  assert.match(result.summary, /A-1001/)
  // what reached the site
  assert.deepEqual(shop.state.logins.map((l) => l.passwordOk), [false, true])
  assert.deepEqual(shop.state.otps.map((o) => o.ok), [true])
  // the chat cards, in order
  const cards = await cardsOf('vault')
  assert.deepEqual(cards.map((c) => `${c.kind}/${c.mode}/${c.state}`), ['login/request/saved', 'login/update/saved', 'secret/request/used'])
  // the vault: one active login, sealed; the OTP was never stored
  const items = await vault.listItems(user)
  assert.equal(items.length, 1)
  assert.equal(items[0].status, null)
  assert.equal(items[0].site, '127.0.0.1')
  const [row] = await q('select secret from pro_vault_items where id=$1', [items[0].id])
  assert.ok(!row.secret.includes(SHOP.password))
  const actions = (await vault.listAudit(user)).map((a) => `${a.action}:${a.actor}${a.detail?.field ? ':' + a.detail.field : ''}`).reverse()
  assert.deepEqual(actions, [
    'create:user', 'fill:browser-agent:username', 'fill:browser-agent:password', 'reject:browser-agent',
    'update:user', 'fill:browser-agent:username', 'fill:browser-agent:password', 'one_time:user',
  ])
  // the model saw secret fields only as {secret:true, filled}, and its own typing into one was refused
  const text = modelText()
  assert.match(text, /refused: this is a secret field/)
  for (const s of SECRETS) assert.ok(!text.includes(s), `model request contained ${s}`)
  assert.ok(text.includes('\\"secret\\":true'))
})

function checkoutBrain(st) {
  return (snap) => {
    if (!st.started) { st.started = true; return ['goto', { url: `${shop.url}/checkout` }] }
    if (pathOf(snap) !== '/checkout' && pathOf(snap) !== '/pay') return ['finish', { summary: 'unexpected ' + snap.url }]
    if (/결제 완료/.test(snap.text)) return ['finish', { summary: /카드 [^\n]+/.exec(snap.text)?.[0] || '' }]
    for (const [name, field] of [['ccname', 'card_name'], ['cardnumber', 'card_number'], ['ccexp', 'card_exp'], ['cvc', 'card_cvv']]) {
      if (!st[field]) { st[field] = true; return ['fill_secret', { i: idx(snap, (e) => e.name === name), field }] }
    }
    if (!st.approved) { st.approved = true; return ['approve', { summary: '무선 이어폰 89,000원을 결제할까요?' }] }
    return ['click', { i: idx(snap, (e) => e.tag === 'button') }]
  }
}

test('card: no card saved → card request into the vault → filled server-side after approval', async () => {
  brain = checkoutBrain({})
  let approvals = 0
  const stop = simulateUser({
    card: async (m) => {
      if (m.content.kind === 'card' && m.content.mode === 'request') {
        await vault.putItem(user, 'card', 'wallet', CARD_A, { taskId: m.content.taskId })
        await settle(m, 'saved'); browser.resume(user, 'card saved; use fill_secret')
      }
      if (m.kind === 'choice' && m.content.approval) {
        // the approval names the card about to be charged, by label only
        assert.match(m.content.question, /89,000원[\s\S]*Visa •••• 4242/)
        approvals++
        await settle(m, 'answered'); browser.resume(user, 'The user chose: 승인. Continue with that choice.')
      }
    },
  })
  const result = await browser.runBrowserTask({ userId: user, threadId, goal: '테스트 상점에서 무선 이어폰을 결제해줘' })
  await stop()
  assert.equal(result.state, 'done')
  assert.equal(approvals, 1)
  assert.deepEqual(shop.state.payments.map((p) => [p.last4, p.ok]), [['4242', true]])
  const cards = (await cardsOf('vault')).filter((c) => c.kind === 'card')
  assert.deepEqual(cards.map((c) => `${c.mode}/${c.state}`), ['request/saved'])
  const fills = (await vault.listAudit(user)).filter((a) => a.action === 'fill' && a.kind === 'card').map((a) => a.detail.field).reverse()
  assert.deepEqual(fills, ['card_name', 'card_number', 'card_exp', 'card_cvv'])
  const text = modelText()
  for (const s of SECRETS) assert.ok(!text.includes(s), `model request contained ${s}`)
})

test('card: with two cards saved the user picks one in chat', async () => {
  await vault.putItem(user, 'card', 'wallet', CARD_B)
  brain = checkoutBrain({})
  const stop = simulateUser({
    card: async (m) => {
      if (m.kind === 'choice' && m.content.vault) {
        assert.deepEqual([...m.content.options].sort(), ['Mastercard •••• 4444', 'Visa •••• 4242'])
        await q(`update pro_messages set content = content || $2::jsonb where id=$1`, [m.id, JSON.stringify({ state: 'answered', value: 'Mastercard •••• 4444' })])
        browser.resume(user, 'The user chose: Mastercard •••• 4444. Continue with that choice.')
      }
      if (m.kind === 'choice' && m.content.approval) { await settle(m, 'answered'); browser.resume(user, 'The user chose: 승인. Continue with that choice.') }
    },
  })
  const result = await browser.runBrowserTask({ userId: user, threadId, goal: '테스트 상점에서 한 번 더 결제해줘' })
  await stop()
  assert.equal(result.state, 'done')
  assert.deepEqual(shop.state.payments.at(-1), { ...shop.state.payments.at(-1), last4: '4444', ok: true })
  assert.ok(!modelText().includes(CARD_B.number))
})

test('takeover: a login the user types is captured into the vault and kept only after confirmation', async () => {
  const st = { started: false, asked: false }
  brain = (snap) => {
    if (!st.started) { st.started = true; return ['goto', { url: `${shop.url}/login` }] }
    if (!st.asked) { st.asked = true; return ['need_user', { reason: '다른 계정으로 직접 로그인해 주세요' }] }
    return ['finish', { summary: '사용자가 직접 로그인했어요.' }]
  }
  let captured = null
  const stop = simulateUser({
    needs: async () => {
      // the user types into the live view: Tab to the e-mail field, type, Tab, type the password, Enter
      for (const ev of [{ type: 'key', key: 'Tab' }, { type: 'text', text: 'typed@shop.test' }, { type: 'key', key: 'Tab' }, { type: 'text', text: TYPED }, { type: 'key', key: 'Enter' }]) {
        await browser.input(user, ev)
      }
    },
    card: async (m) => {
      if (m.content.mode === 'capture') {
        captured = m.content
        await vault.confirmItem(user, m.content.itemId)
        await settle(m, 'saved')
        browser.resume(user, 'The user took over and finished the manual part.')
      }
    },
  })
  const result = await browser.runBrowserTask({ userId: user, threadId, goal: '테스트 상점에 다른 계정으로 로그인' })
  await stop()
  assert.equal(result.state, 'done')
  assert.ok(captured, 'a capture card was posted')
  assert.equal(captured.kind, 'login')
  assert.equal(captured.label, 'typed@shop.test')
  const logins = await vault.candidates(user, 'login', '127.0.0.1')
  assert.deepEqual(logins.map((l) => l.label).sort(), [SHOP.username, 'typed@shop.test'])
  assert.equal((await vault.useItem(user, captured.itemId, { actor: 'test' })).password, TYPED)
  const actions = (await vault.listAudit(user)).map((a) => a.action)
  assert.ok(actions.includes('capture') && actions.includes('confirm'))
  assert.ok(!modelText().includes(TYPED))
})

test('a closed request is not asked again in the same task', async () => {
  const st = { n: 0 }
  brain = (snap) => {
    st.n++
    if (st.n === 1) return ['goto', { url: `${shop.url}/login` }]
    // the model keeps trying the login field
    if (st.n <= 4) return ['fill_secret', { i: idx(snap, (e) => e.name === 'username'), field: 'username' }]
    return ['finish', { summary: '로그인 정보가 없어 끝냈어요.' }]
  }
  // a fresh site key: no login saved for "localhost"
  const goto = shop.url.replace('127.0.0.1', 'localhost')
  brain = ((inner) => (snap) => { const r = inner(snap); if (r[0] === 'goto') r[1].url = `${goto}/login`; return r })(brain)
  let asked = 0
  const stop = simulateUser({
    card: async (m) => {
      if (m.kind === 'vault' && m.content.mode === 'request') {
        asked++
        await settle(m, 'dismissed')
        browser.resume(user, 'The user closed the request without providing it. Do not ask again; continue without it or finish and say what is missing.')
      }
    },
  })
  const result = await browser.runBrowserTask({ userId: user, threadId, goal: '다른 테스트 상점에 로그인' })
  await stop()
  assert.equal(result.state, 'done')
  assert.equal(asked, 1)
  assert.ok(modelText().includes('no credential saved for localhost'))
})
