// 로그인 벽에서 보관함 먼저 (2026-11-24 휴대폰 사진: 네이버 예약 → nid.naver.com 로그인 화면에서 「직접 로그인」만 — 「로그인이 왜
// vault 를 이용하여 암호관리를 호출하지 않는것인가」). 실제 Chromium · 실제 DB · 대본대로 움직이는 모델 · 가짜 판정 서버 · 지어낸 로그인
// 사이트(fixtures/loginWall.mjs, 브라우저 안에서 답함 — 밖으로 나가지 않음). 진짜 계정은 쓰지 않는다.
//   - 저장된 로그인(상위 도메인 · 같은 회사의 다른 하위 도메인)이 있으면 사람을 부르지 않고 키를 하나씩 쳐서 넣고 보낸 뒤 이어서 한다
//   - 없으면 카드에 「로그인 정보 저장」(보관함 요청 카드)과 「직접 로그인」, 카드에 저장하면 바로 넣어 이어서 한다
//   - 넣은 뒤 사람 확인 → 사람에게(저장된 로그인으로 해 봤다는 말과 무엇이 막는지), 비밀번호는 다시 넣어 둔다
//   - 비밀번호가 틀리면 보관함의 고침 카드, 고치면 다시 넣어 이어서 한다 · 인증 코드면 코드 카드(need_secret)
//   - 비밀번호 · 아이디는 이벤트 · 서버 로그 · 모델 요청 · 판정 요청 · 실시간 화면(OCR, tesseract 가 있으면)에 없다
//   node --test test/browser-wall-vault.e2e.mjs      (실시간 프레임을 남기려면 WV_FRAMES_DIR=<폴더>)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startJudge } from './fixtures/walls.mjs'
import { routeLoginWall, LW, LW_TITLES, LW_SPOTS } from './fixtures/loginWall.mjs'

// everything the server prints, to look for a secret in it afterwards (it is still printed)
const printed = []
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k].bind(console)
  console[k] = (...a) => { printed.push(a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x) } catch { return String(x) } })())).join(' ')); orig(...a) }
}

// ---- 대본 모델: 계획, 그리고 목표마다 차례대로 한 수. 받은 요청은 모두 남긴다 ----
const scripts = {}
const llmBodies = []
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    llmBodies.push(body)
    let message
    if (body.response_format) message = { role: 'assistant', content: JSON.stringify({ title: '픽스처 예약 확인', steps: ['로그인', '예약 확인', '알려 주기'] }) }
    else {
      const goal = /Goal: (.*)/.exec(body.messages[0].content)?.[1] || ''
      const s = scripts[goal]
      s.asks.push(body)
      const move = s.moves[Math.min(s.i++, s.moves.length - 1)]
      const [name, args] = typeof move === 'function' ? move(body) : move
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))

// 판정 모델 자리: 제목 → 확률(벽 질문의 보기와, 보관함 로그인 뒤 질문의 보기가 한 표에)
const judgeSrv = await startJudge({
  [LW_TITLES.signIn]: { login_needed: 0.95, refused: 0.01, human_check: 0.01, ok: 0.03, pending: 0.9 },
  [LW_TITLES.bad]: { login_needed: 0.93, ok: 0.04, rejected: 0.92 },
  [LW_TITLES.check]: { human_check: 0.9, login_needed: 0.06, ok: 0.02 },
  [LW_TITLES.code]: { login_needed: 0.9, ok: 0.05, code: 0.93 },
  [LW_TITLES.app]: { ok: 0.95, login_needed: 0.02, signed_in: 0.96 },
})

// a throwaway keyring (as browser-vault.test.js) and a profile folder of its own
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-wall-vault-'))
const k = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(k).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(tmp, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: k.toString('base64') }] }), { mode: 0o600 })
fs.mkdirSync(path.join(tmp, 'profiles'))
Object.assign(process.env, {
  PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}`, PRO_LLM_API_KEY: 'test', PRO_CONTEXT_ROUTER_URL: '', PRO_BROWSER_PROFILES: path.join(tmp, 'profiles'),
  PRO_JUDGE_URL: judgeSrv.url, PRO_JUDGE_LLM: '0', PRO_VAULT_KEYRING: path.join(tmp, 'keyring.json'),
})
delete process.env.PRO_VAULT_KEK

const vault = await import('../lib/vault.js')
const browser = await import('../lib/browser.js')
const { subscribe } = await import('../lib/bus.js')
const { q, pool } = await import('../lib/supa.js')

const user = crypto.randomUUID()
const events = []
subscribe(user, { write: (line) => events.push({ type: /^event: (.*)$/m.exec(line)[1], data: JSON.parse(/^data: (.*)$/m.exec(line)[1]) }) })
const of = (type) => events.filter((e) => e.type === type).map((e) => e.data)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}`); await sleep(100) } }
const START = `https://${LW.login}/?continue=https://${LW.app}/`
const state = { signedIn: false, password: LW.password, after: 'ok' }
let threadId
const card = async (goal) => (await q(`select id, content from pro_messages where thread_id=$1 and kind='task' and content->>'goal'=$2 order by created_at desc limit 1`, [threadId, goal]))[0]
const cardsOf = async (taskId) => (await q(`select id, kind, content from pro_messages where thread_id=$1 and kind in ('vault','choice') and content->>'taskId'=$2 order by created_at`, [threadId, taskId]))
const lastSnap = (body) => JSON.parse([...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{')).content.split('\n')[0])
const run = (goal, moves) => { scripts[goal] = { i: 0, moves, asks: [] }; return browser.runBrowserTask({ userId: user, threadId, goal, startUrl: START }) }
// every state the task card went through, as the live events carried it
const cardStates = (id) => of('message').filter((m) => m.id === id).map((m) => m.content)
const reset = async (after = 'ok') => {
  Object.assign(state, { signedIn: false, password: LW.password, after, logins: [], checks: [], codes: [] })
  for (const t of ['pro_vault_items', 'pro_vault_audit']) await q(`delete from ${t} where user_id=$1`, [user])
}
const save = (site, password = LW.password) => vault.putItem(user, 'login', site, { username: LW.username, password })
const fills = async () => (await vault.listAudit(user, 200)).filter((a) => a.action === 'fill').map((a) => `${a.site}:${a.detail?.field}`).reverse()

before(async () => {
  browser.WAIT.watchMs = 300
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','wall vault e2e') returning id`, [user])
  await routeLoginWall(await browser.contextFor(user), state)
})
after(async () => {
  await browser.close(user).catch(() => {})
  await judgeSrv.close()
  llm.close()
  for (const t of ['pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_threads']) await q(`delete from ${t} where user_id=$1`, [user]).catch(() => {})
  await pool.end().catch(() => {})
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('같은 회사의 로그인: 정확한 호스트 → 상위 · 하위 → 같은 회사의 다른 하위 도메인, 여럿이 쓰는 호스팅 주소는 이웃에게 주지 않는다', async () => {
  assert.equal(vault.ownerDomain('nid.naver.com'), 'naver.com')
  assert.equal(vault.ownerDomain('m.booking.naver.com'), 'naver.com')
  assert.equal(vault.ownerDomain('www.mail.shop.co.kr'), 'shop.co.kr')
  assert.equal(vault.ownerDomain('login.fixture.test'), 'fixture.test')
  assert.equal(vault.ownerDomain('me.github.io'), 'me.github.io')
  assert.equal(vault.ownerDomain('127.0.0.1'), '127.0.0.1')
  assert.equal(vault.ownerDomain('localhost'), 'localhost')
  await reset()
  const sib = await save('app.fixture.test')
  assert.deepEqual((await vault.candidates(user, 'login', LW.login)).map((r) => r.id), [sib.id], 'login.fixture.test 에 app.fixture.test 의 로그인')
  const parent = await save('fixture.test')
  assert.deepEqual((await vault.candidates(user, 'login', LW.login)).map((r) => r.id), [parent.id], '상위 도메인이 있으면 그것(이웃보다 먼저)')
  await vault.putItem(user, 'login', 'me.github.io', { username: 'me', password: 'pw-123456' })
  assert.deepEqual(await vault.candidates(user, 'login', 'evil.github.io'), [], '여럿이 쓰는 호스팅의 이웃 주소에는 주지 않는다')
  assert.deepEqual((await vault.candidates(user, 'card', 'login.fixture.test')).length, 0)
  await reset()
})

test('저장된 로그인(상위 도메인)이 있으면: 로그인 벽에서 사람을 부르지 않고 보관함의 로그인을 키로 쳐 넣고 보내, 로그인한 화면에서 이어서 한다', async () => {
  await reset()
  const item = await save('fixture.test')
  events.length = 0
  const goal = '픽스처에서 내 예약을 알려 줘'
  const r = await run(goal, [['note', { text: '예약 2건: 12월 18일 숙소, 12월 24일 저녁' }], ['finish', { summary: '예약은 2건이에요: 12월 18일 숙소, 12월 24일 저녁.' }]])
  assert.equal(r.state, 'done', JSON.stringify(r))
  const c = await card(goal)
  // nobody was asked: the card never waited, no vault or choice card came up, the model first saw the signed-in page
  assert.ok(!cardStates(c.id).some((x) => x.state === 'needs_input'), '카드가 사람을 기다리지 않았다')
  assert.deepEqual(await cardsOf(c.id), [])
  assert.equal(scripts[goal].i, 2, '모델은 로그인 뒤에만')
  assert.equal(lastSnap(scripts[goal].asks[0]).title, LW_TITLES.app)
  // the site got the right login, typed key by key, and the fields were masked whenever they held a value
  assert.equal(state.logins.length, 1)
  const [sent] = state.logins
  assert.equal(sent.username, LW.username)
  assert.equal(sent.ok, true)
  // a key per character (fill() sends none; clearing the field first and Enter add one each)
  assert.ok(sent.keys.uid >= LW.username.length, `아이디를 키로 쳤다: ${sent.keys.uid}`)
  assert.ok(sent.keys.upw >= LW.password.length, `비밀번호를 키로 쳤다: ${sent.keys.upw}`)
  assert.equal(sent.unmasked, 0, '값이 든 칸이 화면에 가려지지 않은 순간이 없다')
  // the card said which way it was going in, and took it off afterwards
  const signing = cardStates(c.id).map((x) => x.signingIn).filter((x) => x !== undefined)
  assert.deepEqual(signing[0], { via: 'vault', site: 'fixture.test' })
  assert.equal(signing.at(-1), null)
  assert.equal(c.content.signingIn, null)
  assert.ok(of('status').some((x) => x.text === '보관함의 로그인으로 들어가는 중 · fixture.test'))
  assert.deepEqual(await fills(), ['fixture.test:username', 'fixture.test:password'])
  assert.match(r.summary, /보관함의 로그인 입력 · fixture\.test/)
  assert.ok((await vault.listItems(user)).find((x) => x.id === item.id).last_used_at)
  // the live view while it typed: OCR reads the control word in the same type, never the username or the password
  const frames = of('browser.frame').filter((f) => f.url.includes(LW.login))
  assert.ok(frames.length >= 1, '로그인 화면의 실시간 프레임')
  let tesseract = true
  try { execFileSync('tesseract', ['--version'], { stdio: 'ignore' }) } catch { tesseract = false }
  if (!tesseract) { console.log('[wall-vault] tesseract 가 없어 실시간 프레임 OCR 은 건너뜀'); return }
  const read = frames.map((f, n) => {
    const file = path.join(process.env.WV_FRAMES_DIR || tmp, `frame-${n}.jpg`)
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'))
    return execFileSync('tesseract', [file, 'stdout', '--psm', '11'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\s+/g, '')
  })
  if (process.env.WV_OCR_DEBUG) console.log('[wall-vault] OCR', frames.length, JSON.stringify(read))
  assert.ok(read.some((t) => t.includes(LW.control)), `OCR 이 같은 글꼴의 대조 낱말을 읽는다: ${read.join(' | ').slice(0, 300)}`)
  // frames from while it typed: the username field as a run of discs (tesseract reads them as c · e · o)
  assert.ok(read.some((t) => /[ceo•@]{8,}/.test(t)), '입력하는 동안의 프레임(가려진 칸)이 있다')
  for (const t of read) {
    assert.ok(!t.includes(LW.username), '실시간 화면에 아이디가 보였다')
    assert.ok(!t.includes(LW.password), '실시간 화면에 비밀번호가 보였다')
  }
})

test('같은 회사의 다른 하위 도메인(app.fixture.test)에 저장한 로그인으로 login.fixture.test 에 들어간다', async () => {
  await reset()
  await save('app.fixture.test')
  const goal = '픽스처 예약을 다시 확인해 줘'
  const r = await run(goal, [['finish', { summary: '예약은 2건이에요.' }]])
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.deepEqual(state.logins.map((l) => l.ok), [true])
  assert.ok(!cardStates((await card(goal)).id).some((x) => x.state === 'needs_input'))
  assert.ok(of('status').some((x) => x.text === '보관함의 로그인으로 들어가는 중 · fixture.test'))
})

test('저장된 로그인이 없으면: 카드에 보관함 요청 카드와 「직접 로그인」, 카드에 저장하면 바로 넣어 이어서 한다', async () => {
  await reset()
  const goal = '픽스처 예약 목록 보여 줘'
  const running = run(goal, [['finish', { summary: '예약은 2건이에요.' }]])
  const c = await until(async () => { const x = await card(goal); return x?.content.state === 'needs_input' && x }, '로그인 기다림')
  assert.equal(c.content.need, 'login')
  assert.equal(c.content.reason, `이 브라우저에서 ${LW_TITLES.signIn}에 한 번 로그인해야 이어서 진행할 수 있어요. 카드에 로그인 정보를 저장하면 제가 입력해 로그인해요. 「직접 로그인」을 눌러 직접 해도 돼요. 직접 입력한 로그인 정보도 보관함에 저장할 수 있어요. 다음부터는 제가 입력해요.`)
  const [ask] = await until(async () => { const l = await cardsOf(c.id); return l.length && l }, '보관함 요청 카드')
  assert.equal(ask.kind, 'vault')
  assert.deepEqual([ask.content.kind, ask.content.mode, ask.content.site, ask.content.state], ['login', 'request', LW.login, 'pending'])
  assert.equal(scripts[goal].i, 0, '모델을 부르지 않았다')
  // the person saves the login on the card (POST /api/vault with the card: lib/vault.js putItem + resume)
  await save(ask.content.site)
  await q(`update pro_messages set content = content || '{"state":"saved"}'::jsonb where id=$1`, [ask.id])
  browser.resume(user, `the user saved a login for ${LW.login} in the vault; use fill_secret`)
  const r = await running
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.deepEqual(state.logins.map((l) => [l.ok, l.keys.upw >= LW.password.length]), [[true, true]])
  assert.equal(scripts[goal].i, 1)
})

test('넣은 뒤 사람 확인이 나오면: 사람에게 — 저장된 로그인으로 해 봤다는 말과 막는 것, 비밀번호는 다시 넣어 두고, 확인하면 이어서 한다', async () => {
  await reset('check')
  await save(LW.login)
  const goal = '픽스처 예약을 확인해서 알려 줘'
  const running = run(goal, [['finish', { summary: '예약은 2건이에요.' }]])
  const c = await until(async () => { const x = await card(goal); return x?.content.state === 'needs_input' && x }, '사람 확인 기다림')
  assert.equal(c.content.need, 'login')
  assert.equal(c.content.reason, `보관함에 저장된 로그인 정보로 ${LW_TITLES.signIn}에 로그인하려 했는데, ${LW_TITLES.signIn}에서 사람인지 확인하는 절차를 추가로 요구해요. 「직접 로그인」을 눌러 로그인을 마치면 이어서 진행해요.`)
  assert.deepEqual(state.logins.map((l) => l.ok), [true])
  assert.deepEqual(await cardsOf(c.id), [], '보관함 카드는 없다(로그인은 있음)')
  assert.equal(scripts[goal].i, 0)
  // the person confirms on the live view (직접 로그인): the password the vault put back goes with it
  await sleep(700)
  await browser.input(user, { type: 'click', x: LW_SPOTS.checkDone.x / 1280, y: LW_SPOTS.checkDone.y / 800 })
  const r = await running
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.equal(state.checks.length, 1)
  assert.equal(state.checks[0].ok, true, '확인 화면에 비밀번호를 다시 넣어 두었다')
  assert.equal(state.checks[0].unmasked, 0)
  assert.deepEqual(await fills(), [`${LW.login}:username`, `${LW.login}:password`, `${LW.login}:password`])
})

test('비밀번호가 틀리면: 보관함의 고침 카드 — 고쳐 저장하면 다시 넣어 이어서 한다', async () => {
  await reset()
  const item = await save(LW.login, LW.wrong)
  const goal = '픽스처 예약 알려 줘(비밀번호 고침)'
  const running = run(goal, [['finish', { summary: '예약은 2건이에요.' }]])
  const c = await until(async () => { const x = await card(goal); return x?.content.state === 'needs_input' && x }, '고침 기다림')
  assert.equal(c.content.need, 'login')
  assert.match(c.content.reason, /보관함에 저장된 비밀번호로 .*에 로그인하지 못했어요\. .*에서 비밀번호가 맞지 않는다고 해요\. 카드에서 비밀번호를 고쳐 저장하면/)
  const [fix] = await cardsOf(c.id)
  assert.deepEqual([fix.kind, fix.content.kind, fix.content.mode, fix.content.itemId, fix.content.label, fix.content.state], ['vault', 'login', 'update', item.id, LW.username, 'pending'])
  assert.equal((await vault.listItems(user)).find((x) => x.id === item.id).status, 'rejected')
  // the person fixes it on the card (PATCH /api/vault/:id: updateItem + resume)
  await vault.updateItem(user, item.id, { password: LW.password })
  await q(`update pro_messages set content = content || '{"state":"saved"}'::jsonb where id=$1`, [fix.id])
  browser.resume(user, `the user updated the saved login for ${LW.login}; use fill_secret again`)
  const r = await running
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.deepEqual(state.logins.map((l) => l.ok), [false, true])
  const actions = (await vault.listAudit(user, 200)).map((a) => a.action).reverse()
  assert.deepEqual(actions.filter((a) => a !== 'fill'), ['create', 'reject', 'update'])
})

test('인증 코드를 물으면: 에이전트의 코드 카드(need_secret)로 — 사람이 넣은 코드가 들어가 이어서 한다', async () => {
  await reset('code')
  await save(LW.login)
  const goal = '픽스처 예약 알려 줘(인증 코드)'
  let hinted = ''
  const running = run(goal, [
    (b) => { hinted = b.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').at(-1).content; return ['need_secret', { i: lastSnap(b).els.find((e) => e.name === 'code').i, label: '인증 코드' }] },
    (b) => ['click', { i: lastSnap(b).els.find((e) => e.tag === 'button').i }],
    ['finish', { summary: '예약은 2건이에요.' }],
  ])
  const c = await until(async () => { const x = await card(goal); return x?.content.state === 'needs_input' && x }, '코드 카드')
  const [ask] = await cardsOf(c.id)
  assert.deepEqual([ask.content.kind, ask.content.mode], ['secret', 'request'])
  assert.match(hinted, /asks for a one-time code\. Call need_secret/)
  assert.equal(lastSnap(scripts[goal].asks[0]).title, LW_TITLES.code, '모델은 지금 화면(코드 화면)을 본다')
  assert.equal(await browser.provideSecret(user, LW.code), true)
  const r = await running
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.deepEqual(state.codes, [true])
})

test('비밀번호 · 아이디 · 코드는 이벤트 · 서버 로그 · 모델 요청 · 판정 요청 어디에도 없다', async () => {
  const nonFrame = JSON.stringify(events.filter((e) => e.type !== 'browser.frame'))
  const logs = printed.join('\n')
  const model = JSON.stringify(llmBodies.map((b) => b.messages.map((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type !== 'image_url') : m))))
  const judged = judgeSrv.states.join('\n')
  for (const secret of [LW.password, LW.wrong, LW.code]) {
    assert.ok(!nonFrame.includes(secret), `이벤트에 ${secret}`)
    assert.ok(!logs.includes(secret), `서버 로그에 ${secret}`)
    assert.ok(!model.includes(secret), `모델 요청에 ${secret}`)
    assert.ok(!judged.includes(secret), `판정 요청에 ${secret}`)
  }
  // the username is a label on the vault's own cards (the person's), never in what the models read
  assert.ok(!model.includes(LW.username), '모델 요청에 아이디')
  assert.ok(!judged.includes(LW.username), '판정 요청에 아이디')
  assert.ok(llmBodies.length > 5 && judgeSrv.states.length > 5, '살펴본 것이 있다')
})
