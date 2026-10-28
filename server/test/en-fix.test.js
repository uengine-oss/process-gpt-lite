// English-mode polish (i18n/HANDOFF.md "Coordination"): the fixes found while capturing the English
// tutorial, each with Korean left as it was — no database, no real model (a scripted one for llm.js).
//   - Craft tools turn on by naming the app (CADCraft / PhotoCraft / SoundCraft / FilmCraft), as VectorCraft did
//   - the room helper finds a named teammate by English given name, family name or full name in any case
//   - panel numbers: "2,450만 원" even when the model's key carries the field hint, "₩24.5M", "24,500,000"
//   - panel design: a reasoning model's thinking no longer eats the token cap ("Unexpected end of JSON input")
//   - browser agent: no unasked-for purchase clicks, and the summary always starts with a result sentence
//   - the test shop has an English version (?lang=en, startShop({lang:'en'}), SHOP_LANG=en)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// a scripted OpenAI-compatible server for llm.js (set before config.js reads the environment)
const seen = []
let answer = () => ({ choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] })
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    seen.push(body)
    const out = answer(body)
    res.writeHead(out.status || 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out.body || out))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llm.address().port}`
process.env.PRO_LLM_API_KEY = 'test'

const { withLang } = await import('../lib/lang.js')
const { craftAppsFor } = await import('../lib/office.js')
const { namedIn } = await import('../lib/team/assist.js')
const X = await import('../lib/panelApps/sheet.js')
const llmMod = await import('../lib/llm.js')
const P = await import('../lib/panelApps/service.js')
const B = await import('../lib/browser.js')
const { startShop } = await import('./fixtures/shop.mjs')
after(() => llm.close())

const hangul = (v) => /[가-힣]/.test(v)

test('Craft tools: naming the app turns it on, in English and Korean; a video summary does not', () => {
  const cases = {
    'Open the floor plan in CADCraft': ['cadcraft'],
    'Recolor it in PhotoCraft': ['photocraft'],
    'Use SoundCraft for a short jingle': ['soundcraft'],
    'Put the clips together in FilmCraft': ['filmcraft'],
    'Make a logo in VectorCraft': ['vectorcraft'],
    '포토크래프트로 열어 줘': ['photocraft'],
    'CADCraft로 평면도 그려 줘': ['cadcraft'],
  }
  for (const [t, want] of Object.entries(cases)) assert.deepEqual(craftAppsFor(t), want, t)
  for (const t of ['Summarise this YouTube video', '유튜브 영상 요약해 줘', 'Where is the craft fair?']) assert.deepEqual(craftAppsFor(t), [], t)
})

test('room helper: a teammate named by English given name, family name or full name (any case); Korean as before', () => {
  const M = [{ id: 1, name: 'Minji Kim' }, { id: 2, name: 'Jiho Kim' }, { id: 3, name: '김서연' }, { id: 4, name: 'Daniel Park' }]
  const who = (b) => namedIn(M, b).map((m) => m.id)
  assert.deepEqual(who('Minji, could you draft the quote?'), [1])
  assert.deepEqual(who('minji kim, please summarize this'), [1], 'a full name does not also name Jiho Kim by "Kim"')
  assert.deepEqual(who('MINJI please'), [1])
  assert.deepEqual(who('Kim, can you help?'), [1, 2], 'a family name names everyone who has it')
  assert.deepEqual(who('Park이 해 줘'), [4], 'an English name followed by a Korean particle')
  assert.deepEqual(who('Minjiho is not anyone'), [], 'a part of a longer word is not a name')
  assert.deepEqual(who('서연님 견적 부탁해요'), [3], 'Korean given name, as before')
  assert.deepEqual(who('김서연 씨'), [3])
  assert.deepEqual(who('Could someone look at this?'), [])
})

test('panel numbers: Korean and English amounts; the model\'s key with the field hint; the request text as a fallback', () => {
  const n = { '2,450만 원': 24500000, '3,800만 원': 38000000, '1억 2천만 원': 120000000, '₩24.5M': 24500000, '24,500,000': 24500000,
    'KRW 24,500,000': 24500000, '24.5 million won': 24500000, '₩30,000': 30000, '30K': 30000, 'about 1.2 bn': 1200000000, '15 days': 15 }
  for (const [raw, want] of Object.entries(n)) assert.equal(X.parseKoNumber(raw), want, raw)
  const def = { fields: [{ key: 'customer', label: '고객사', type: 'text', required: true }, { key: 'amount', label: '견적 금액', type: 'number', required: true }, { key: 'sent', label: '발송일', type: 'date' }] }
  // describe() lists the field as "견적 금액(숫자)*": a router model may copy that as the key
  assert.deepEqual(X.validate(def, { 고객사: '한빛제과', '견적 금액(숫자)*': '2,450만 원' }), { customer: '한빛제과', amount: 24500000, sent: '' })
  assert.deepEqual(X.validate(def, { 고객사: '해솔베이커리', 견적금액: '3,800만 원' }), { customer: '해솔베이커리', amount: 38000000, sent: '' }, 'as before')
  assert.deepEqual(X.valuesFromText(def, '견적 현황판에 추가해 줘: 고객사 한빛제과, 건명 분당점 리뉴얼, 견적 금액 2,450만 원, 상태 수주, 담당자 김민지.'), { amount: 24500000 })
  const en = { fields: [{ key: 'customer', label: 'Customer', type: 'text' }, { key: 'amount', label: 'Quote amount', type: 'number', required: true }, { key: 'sent', label: 'Sent on', type: 'date' }] }
  assert.deepEqual(X.validate(en, { Customer: 'Hanbit Bakery', 'Quote Amount (number)*': '₩24.5M' }), { customer: 'Hanbit Bakery', amount: 24500000, sent: '' })
  assert.deepEqual(X.valuesFromText(en, 'Add to the Quote tracker: customer Hanbit Bakery, quote amount ₩24.5M, status Won, sent on Nov 3, 2026.'), { amount: 24500000, sent: '2026-11-03' })
  assert.deepEqual(X.valuesFromText(en, 'Add: Customer Solgil Bakery, Quote amount 24,500,000, owner Minji Kim'), { amount: 24500000 })
})

test('model JSON: an answer cut off at the token limit says so (not "Unexpected end of JSON input")', async () => {
  answer = () => ({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] })
  await assert.rejects(llmMod.chatJson('s', 'u'), /token limit/)
  answer = () => ({ choices: [{ message: { role: 'assistant', content: '{"a": [1, 2' }, finish_reason: 'length' }] })
  await assert.rejects(llmMod.chatJson('s', 'u'), /cut off/)
})

test('panel design: low reasoning effort and room for the thinking on top of the JSON, in both languages', async () => {
  for (const lang of ['ko', 'en']) {
    seen.length = 0
    answer = () => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ kind: 'list', title: lang === 'en' ? 'Lead tracker' : '리드 관리', fields: [{ key: 'company', label: lang === 'en' ? 'Company' : '회사', type: 'text' }], rows: [] }) }, finish_reason: 'stop' }] })
    const r = await withLang(lang, () => P.design(lang === 'en' ? 'Make a lead tracker' : '리드 관리 앱 만들어 줘'))
    assert.equal(r.kind, 'data')
    assert.equal(r.def.title, lang === 'en' ? 'Lead tracker' : '리드 관리')
    const body = seen.at(-1)
    assert.ok(body.max_tokens >= 10000, `max_tokens ${body.max_tokens}: thinking + answer`)
    assert.equal(body.reasoning_effort, 'low')
  }
  // the smaller steps after a first answer that was cut off: the kind call has room to think too
  seen.length = 0
  answer = (body) => (seen.length === 1 ? { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] }
    : /kind":"live\|events\|data/.test(JSON.stringify(body.messages[0])) ? { choices: [{ message: { role: 'assistant', content: '{"kind":"data"}' }, finish_reason: 'stop' }] }
      : { choices: [{ message: { role: 'assistant', content: JSON.stringify({ title: '견적 현황판', fields: [{ key: 'amount', label: '견적 금액', type: 'number' }] }) }, finish_reason: 'stop' }] })
  const r = await withLang('ko', () => P.design('견적 현황판 패널을 만들어 줘'))
  assert.equal(r.def.title, '견적 현황판')
  assert.ok(seen[1].max_tokens >= 1000, 'the kind call is not capped at 60 tokens')
})

test('browser: purchase controls and buying goals; "주문 내역" / "My orders" only show orders', () => {
  for (const t of ['다시 주문하기', 'Order again', 'Reorder', 'Buy again', 'Add to cart', '89,000원 결제하기', 'Pay ₩89,000', 'Place order', 'Checkout']) assert.equal(B.isPurchaseControl(t), true, t)
  for (const t of ['주문 내역', 'My orders', 'Order history', '결제 내역', '로그인', 'Sign in', '확인', 'Verify']) assert.equal(B.isPurchaseControl(t), false, t)
  for (const t of ['89,000원 결제하기', 'Pay ₩89,000', 'Place order']) assert.equal(B.isPaymentControl(t), true, t)
  assert.equal(B.isPaymentControl('Order again'), false)
  for (const g of ['테스트 상점에서 무선 이어폰을 결제해줘', '테스트 상점에서 한 번 더 결제해줘', '이어폰 주문해 줘', 'Buy the wireless earbuds', 'Reorder my last order', 'Pay for the earbuds']) assert.equal(B.asksToBuy(g), true, g)
  for (const g of ['테스트 상점에 로그인해서 최근 주문을 알려줘', 'Sign in to the test shop and tell me my latest order', 'Check my order status']) assert.equal(B.asksToBuy(g), false, g)
})

test('browser summary: always a result first — a refused purchase is listed apart, an empty account gets a plain sentence', () => {
  const task = (log, notes = []) => ({ log, notes, steps: ['open', 'read'] })
  const log = [{ kind: 'goto', text: 'Open 127.0.0.1', ok: true }, { kind: 'click', text: "Click 'Order again'", ok: false, refusedPurchase: true }]
  const r = withLang('en', () => B.honest({ state: 'done', summary: '' }, task(log)))
  assert.match(r.summary, /^I finished, but I didn't record a result/)
  assert.match(r.summary, /What I actually did\n• Open 127\.0\.0\.1/)
  assert.match(r.summary, /Not pressed — a purchase you didn't ask for\n• Click 'Order again'/)
  const k = withLang('ko', () => B.honest({ state: 'done', summary: '최근 주문은 #A-1001 이에요.' }, task(log)))
  assert.match(k.summary, /^최근 주문은 #A-1001 이에요\.\n\n실제로 한 일\n• Open 127\.0\.0\.1/)
})

test('test shop: English pages with ?lang=en (kept across the login redirects) or {lang:"en"}; Korean by default', async () => {
  const get = async (url, cookie = '') => { const r = await fetch(url, { headers: cookie ? { cookie } : {}, redirect: 'manual' }); return { r, text: await r.text() } }
  const ko = await startShop(0, {})
  const en = await startShop(0, { lang: 'en' })
  try {
    assert.match((await get(`${ko.url}/login`)).text, /테스트 상점 로그인/)
    const a = await get(`${ko.url}/login?lang=en`)
    assert.match(a.text, /Sign in to Test Shop/)
    assert.ok(!hangul(a.text), 'no Korean on the English login page')
    const cookie = a.r.headers.get('set-cookie').split(';')[0]
    // a wrong password: the error in English, then the code page after the redirect
    const wrong = await fetch(`${ko.url}/login`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=x&password=y' })
    assert.match(await wrong.text(), /The email or password is incorrect\./)
    assert.match((await get(`${ko.url}/otp`, cookie)).text, /Enter the 6-digit verification code/)
    for (const p of ['/login', '/otp', '/checkout']) {
      const { text } = await get(`${en.url}${p}`)
      assert.ok(!hangul(text), `${p} has no Korean`)
      assert.match(text, /<html lang="en">/)
    }
    assert.match((await get(`${en.url}/checkout`)).text, /Pay ₩89,000/)
    assert.match((await get(`${en.url}/checkout?lang=ko`)).text, /89,000원 결제하기/, '?lang=ko wins over the shop language')
  } finally { await ko.close(); await en.close() }
})

// last: the refusal is remembered for the rest of this process
test('model call: reasoning_effort is sent when asked, and dropped once for a server that refuses it', async () => {
  seen.length = 0
  let refuse = true
  answer = (body) => (refuse && body.reasoning_effort
    ? { status: 400, body: { error: { message: 'Unrecognized request argument supplied: reasoning_effort' } } }
    : { choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] })
  assert.deepEqual(await llmMod.chatJson('s', 'u', { effort: 'low' }), { ok: true })
  assert.equal(seen[0].reasoning_effort, 'low')
  assert.equal(seen[1].reasoning_effort, undefined, 'asked again without it')
  // remembered: no more refused calls
  refuse = false
  await llmMod.chatJson('s', 'u', { effort: 'low' })
  assert.equal(seen.length, 3)
  assert.equal(seen[2].reasoning_effort, undefined)
})
