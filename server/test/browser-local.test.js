// 브라우저 작업이 사람 PC 의 브라우저에서 돈다(데스크톱 앱 0.2.3 — lib/browserRemote.js, desktop/src/browser): 서버의 에이전트 루프(모델 ·
// 판정 · 보관함 · 카드)는 그대로, 페이지만 링크 너머 데스크톱의 브라우저다. 진짜 데스크톱 앱 코드(Electron — 로컬 러너 + 브라우저)가 이 시험의
// 서버 링크에 기기 토큰으로 붙고, 모델 · 판정은 대본대로 답하는 시험 서버, 사이트는 fixtures/drivers.mjs(지어낸 가게). 인터넷 없음.
//   - 작업이 PC 에서 돌고 끝난다: 카드에 어디서 도는지, 실시간 화면은 그 카드로
//   - 멈추면 「기다리는 중」 → 「다시 시도」 · 「그만두기」는 2초 안에
//   - 보관함 값은 그 사람의 PC 로만, 한 번 — 로그 · 이벤트 · 모델 · 대화에는 없고, 모델의 그림에서는 칠해져 있다
//   - PC 가 꺼지면 카드가 멈추고(「PC 연결 끊김」) 사람이 고른다: 「PC가 다시 켜지면」 → 그 PC 에서 이어서 · 「서버에서 이어서」 → 서버 브라우저가
//     같은 페이지에서 이어서. 저절로 옮기지 않는다
//   - 설정을 끄면 PC 가 켜져 있어도 서버에서
// Run: node --test test/browser-local.test.js  (로컬 DB, desktop/ 의 npm ci)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { startDriverSite, PASSWORD } from './fixtures/drivers.mjs'
import { startDesktopBrowser, haveElectron } from './fixtures/desktopBrowser.mjs'
// (this test's made-up sites run on this machine: the server's browser may open them — lib/privateNet.js)
process.env.PRO_BROWSER_PRIVATE_ALLOW ??= '127.0.0.1,localhost'

const { jpegjs } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle')
const skip = haveElectron() ? false : 'desktop/ 에 Electron 이 없다(npm ci)'

// ---- the scripted model: per goal a list of moves — a tool call, a function of the request (may be async), or 'hang' ----
const scripts = {}
const bodies = []
const lastSnap = (body) => JSON.parse([...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{')).content.split('\n')[0])
const pick = (body, pred) => {
  const e = lastSnap(body).els.find(typeof pred === 'function' ? pred : (x) => x.text === pred)
  if (!e) throw new Error(`no element ${pred}`)
  return e.i
}
// a plan held until the test lets it go (a task cancelled while it plans)
const planHold = { goal: null, wait: null }
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    const body = JSON.parse(raw)
    bodies.push(body)
    let message
    if (body.response_format && planHold.goal && JSON.stringify(body.messages).includes(planHold.goal)) await planHold.wait
    if (body.response_format) message = { role: 'assistant', content: JSON.stringify({ title: 'PC 브라우저 작업', steps: ['열기', '하기', '정리'] }) }
    else {
      const goal = /Goal: (.*)/.exec(body.messages[0].content)?.[1] || ''
      const s = scripts[goal]
      const step = s.moves[Math.min(s.i++, s.moves.length - 1)]
      let move
      try { move = typeof step === 'function' ? await step(body) : step } catch (e) { move = ['text', `script error: ${e.message}`] }
      if (move === 'hang') { res.on('close', () => { s.dropped = (s.dropped || 0) + 1 }); return }
      const [name, args] = move
      message = name === 'text' ? { role: 'assistant', content: args }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
})
const walls = { login: false }
const judgeServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const { options, state = '' } = JSON.parse(raw)
    const keys = options.map((o) => o.key)
    // a sign-in form on the made-up shop is a login wall (when walls.login is on); after the vault's login, the welcome page is signed in
    const wall = walls.login && keys.includes('login_needed') && /Has a password field: yes/.test(state)
    const probabilities = keys.includes('idle') ? { idle: 0.05, busy: 0.95 }
      : keys.includes('signed_in') ? Object.fromEntries(keys.map((k) => [k, k === (/환영합니다/.test(state) ? 'signed_in' : 'pending') ? 0.95 : 0.01]))
        : Object.fromEntries(keys.map((k) => [k, k === (wall ? 'login_needed' : 'ok') ? 0.96 : 0.01]))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ probabilities, model: 'scripted' }))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
await new Promise((r) => judgeServer.listen(0, '127.0.0.1', r))
Object.assign(process.env, { PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}`, PRO_LLM_API_KEY: 'test', PRO_JUDGE_URL: `http://127.0.0.1:${judgeServer.address().port}/judge`, PRO_CONTEXT_ROUTER_URL: '' })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-local-browser-'))
const kek = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(tmp, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: kek.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(tmp, 'keyring.json')
delete process.env.PRO_VAULT_KEK

const browser = await import('../lib/browser.js')
const bus = await import('../lib/bus.js')
const vault = await import('../lib/vault.js')
const H = await import('../lib/localAgents/hub.js')
const D = await import('../lib/localAgents/devices.js')
const R = await import('../lib/browserRemote.js')
const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')

const T = config.tenantId
const user = crypto.randomUUID(), other = crypto.randomUUID()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(100) } }
let site, hub, hubUrl, token, pc, threadId
const card = async (goal) => (await q(`select id, content from pro_messages where thread_id=$1 and kind='task' and content->>'goal'=$2 order by created_at desc limit 1`, [threadId, goal]))[0]
const run = (goal, moves, extra = {}) => { scripts[goal] = { i: 0, moves }; return browser.runBrowserTask({ userId: user, threadId, goal, startUrl: `${site.url}/shop`, gates: false, ...extra }) }
const pcLink = () => H.linksOf(T, user).find((l) => l.caps.browser) || null
const keep = { ...browser.STEP }
// every message the server sends to each desktop link (wrapped again when a link comes anew)
const sentTo = new Map() // userId → [msg]
function tap(link) {
  if (link.__tapped) return
  link.__tapped = true
  const send = link.send.bind(link)
  link.send = (m) => { if (!sentTo.has(link.userId)) sentTo.set(link.userId, []); sentTo.get(link.userId).push(JSON.stringify(m)); return send(m) }
}
const startPc = async () => {
  pc = startDesktopBrowser({ server: hubUrl, token, userData: path.join(tmp, 'pc'), device: '시험 PC' })
  assert.equal(await pc.ready, user)
  await until(() => pcLink())
  tap(pcLink())
}

before(async () => {
  if (skip) return
  site = await startDriverSite()
  hub = http.createServer()
  H.attach(hub)
  await new Promise((r) => hub.listen(0, '127.0.0.1', r))
  hubUrl = `http://127.0.0.1:${hub.address().port}`
  ;({ token } = await D.issue({ id: user }, { name: '시험 PC', platform: process.platform, appVersion: '0.2.3' }))
  await startPc()
  // another person's desktop is on too (a fake link): nothing of this person's may ever go there
  const t2 = (await D.issue({ id: other }, { name: '남의 PC' })).token
  const otherLink = await H.open({ send: () => {}, close: () => {} }, { type: 'hello', token: t2, caps: { browser: true, browserGuard: true }, prefs: {} })
  tap(otherLink)
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','local browser test') returning id`, [user])
})
after(async () => {
  Object.assign(browser.STEP, keep)
  await browser.close(user).catch(() => {})
  await pc?.stop()
  hub?.close()
  await site?.close()
  llm.close(); llm.closeAllConnections?.()
  judgeServer.close()
  for (const t of ['pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_threads']) await q(`delete from ${t} where user_id=$1`, [user]).catch(() => {})
  await q('delete from pro_local_devices where user_id = any($1)', [[user, other]]).catch(() => {})
  await q('delete from pro_profile where user_id=$1', [user]).catch(() => {})
  await pool.end()
  fs.rmSync(path.join(browser.PROFILES, user), { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('PC 에서 돈다: 카드에 「내 PC · 시험 PC」, 실시간 화면이 이 카드로 오고, 작업이 끝난다', { skip }, async () => {
  const frames = []
  const off = bus.subscribe(user, { writableLength: 0, write(l) { if (l.startsWith('event: browser.frame')) frames.push(JSON.parse(l.split('\ndata: ')[1])); return true } })
  const t0 = Date.now()
  const r = await run('PC 에서 찾기', [
    (b) => ['type', { i: pick(b, (x) => x.name === 'q'), text: '가상 사과', enter: true }],
    (b) => ['note', { text: lastSnap(b).text.split('\n').find((l) => l.startsWith('찾은 것')) || '없음' }],
    ['finish', { summary: '가상 사과를 찾았어요.' }],
  ])
  off()
  assert.equal(r.state, 'done', JSON.stringify(r).slice(0, 300))
  assert.deepEqual(r.where, { kind: 'local', device: '시험 PC', deviceId: pcLink().id })
  assert.deepEqual(r.notes, ['찾은 것: 가상 사과'])
  const c = await card('PC 에서 찾기')
  assert.equal(c.content.where.kind, 'local')
  assert.equal(c.content.where.device, '시험 PC')
  assert.ok(c.content.shot, '끝난 카드에 마지막 화면')
  assert.ok(frames.length >= 2 && frames.every((f) => f.taskId === c.id && f.data.length > 1000), `프레임 ${frames.length}`)
  assert.ok(Date.now() - t0 < 15_000, `${Date.now() - t0}ms`)
  assert.equal(r.stats.step_timeouts, 0)
})

test('멈추면 카드에 「기다리는 중 · AI 모델의 답」, 「다시 시도」는 그 걸음만 · 「그만두기」는 2초 안에', { skip }, async () => {
  browser.STEP.stallMs = 1500
  try {
    const p = run('PC 에서 멈춤', ['hang', (b) => ['note', { text: lastSnap(b).title }], ['finish', { summary: '이어서 끝냈어요.' }]])
    const stalled = await until(async () => (await card('PC 에서 멈춤'))?.content?.stall?.what, 10_000)
    assert.match(stalled, /AI 모델의 답/)
    assert.equal(browser.retryStep(user, (await card('PC 에서 멈춤')).id), true)
    const r = await p
    assert.equal(r.state, 'done')
    assert.equal(r.stats.retries, 1)
    assert.ok(r.stats.stalls >= 1)
    assert.equal((await card('PC 에서 멈춤')).content.stall, null)
    // stop while the model does not answer
    const p2 = run('PC 에서 그만두기', ['hang'])
    await until(async () => (await card('PC 에서 그만두기'))?.content?.state === 'running' && browser.lastFrame(user)?.running)
    await sleep(800)
    const t0 = Date.now()
    assert.equal(browser.cancel(user, (await card('PC 에서 그만두기')).id), true)
    const r2 = await p2
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0}ms`)
    assert.equal(r2.state, 'cancelled')
    assert.equal((await card('PC 에서 그만두기')).content.state, 'cancelled')
  } finally { browser.STEP.stallMs = keep.stallMs }
})

test('보관함 로그인: 값은 그 사람의 PC 로 한 번만 가고 로그 · 이벤트 · 모델 · 대화에는 없다 — 모델의 그림에서는 칠해져 있다', { skip }, async () => {
  await vault.putItem(user, 'login', vault.normSite('127.0.0.1'), { username: 'hong-gildong', password: PASSWORD }, { actor: 'test' })
  sentTo.clear()
  const logs = []
  const keepLog = { log: console.log, warn: console.warn, error: console.error }
  for (const k of Object.keys(keepLog)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); keepLog[k](...a) }
  const events = []
  const off = bus.subscribe(user, { writableLength: 0, write(l) { events.push(l); return true } })
  let picture = null
  let afterFill = null
  try {
    const r = await run('PC 에서 로그인', [
      (b) => ['fill_secret', { i: pick(b, '아이디'), field: 'username' }],
      (b) => ['fill_secret', { i: pick(b, '비밀번호'), field: 'password' }],
      (b) => {
        afterFill = lastSnap(b)
        const img = [...b.messages].reverse().find((m) => Array.isArray(m.content))?.content?.[0]?.image_url?.url
        picture = img ? Buffer.from(img.split(',')[1], 'base64') : null
        return ['click', { i: pick(b, '로그인') }]
      },
      (b) => ['note', { text: lastSnap(b).text }],
      ['finish', { summary: '로그인했어요.' }],
    ], { startUrl: `${site.url}/login` })
    assert.equal(r.state, 'done', JSON.stringify(r).slice(0, 300))
    // (the username is a vault value too: blanked out of what the model reads, as on the server)
    assert.match(r.notes.join(' '), /환영합니다, \[vault\]/)
  } finally {
    off()
    Object.assign(console, keepLog)
  }
  // to this person's PC, once, as the fill itself — and to nobody else
  const mine = (sentTo.get(user) || []).filter((m) => m.includes(PASSWORD))
  assert.equal(mine.length, 1)
  assert.equal(JSON.parse(mine[0]).op, 'fillSecret')
  assert.ok(!(sentTo.get(other) || []).some((m) => m.includes(PASSWORD) || m.includes('hong-gildong')), '남의 PC 에는 아무것도')
  // nowhere else
  assert.ok(!logs.some((l) => l.includes(PASSWORD)), '로그에 없다')
  assert.ok(!events.some((l) => l.includes(PASSWORD)), '이벤트에 없다')
  assert.ok(!bodies.some((b) => JSON.stringify(b).includes(PASSWORD)), '모델에 없다')
  const rows = await q('select content::text as c from pro_messages where thread_id=$1', [threadId])
  assert.ok(!rows.some((x) => x.c.includes(PASSWORD)), '대화에 없다')
  // masked in what the PC sent back: the look says only that it is filled; the model's picture has it painted over
  const pw = afterFill.els.find((x) => x.type === 'password')
  assert.deepEqual([pw.secret, pw.filled], [true, true])
  const img = jpegjs.decode(picture, { useTArray: true })
  let dark = 0
  for (let y = 0; y < Math.min(img.height, 120); y++) for (let x = 0; x < img.width; x++) { const o = (y * img.width + x) * 4; if (Math.abs(img.data[o] - 29) < 8 && Math.abs(img.data[o + 1] - 29) < 8 && Math.abs(img.data[o + 2] - 31) < 8) dark++ }
  assert.ok(dark > 1000, `칠한 칸 ${dark}px`)
  // a login typed on the PC is not taken into the vault (none is reported from there)
  assert.equal((await q(`select count(*)::int as n from pro_vault_items where user_id=$1 and status='captured'`, [user]))[0].n, 0)
})

test('로그인 벽에서 보관함 먼저(PR #48): PC 의 브라우저가 저장된 로그인을 키 하나씩 쳐서 들어가고, 사람에게 묻지 않는다', { skip }, async () => {
  walls.login = true
  sentTo.clear()
  try {
    const r = await run('PC 에서 로그인 벽', [
      (b) => ['note', { text: lastSnap(b).text }],
      ['finish', { summary: '로그인한 뒤 환영 화면을 봤어요.' }],
    ], { startUrl: `${site.url}/login` })
    assert.equal(r.state, 'done', JSON.stringify(r).slice(0, 300))
    assert.match(r.notes.join(' '), /환영합니다/)
    assert.equal(r.where.kind, 'local')
    // the model never filled anything: the vault did, before it was asked anything (its first look is the welcome page)
    assert.ok(!bodies.some((b) => /Goal: PC 에서 로그인 벽/.test(b.messages?.[0]?.content || '') && JSON.stringify(b.messages).includes('"fill_secret"')))
    const fills = (sentTo.get(user) || []).map((m) => JSON.parse(m)).filter((m) => m.op === 'fillSecret')
    assert.equal(fills.length, 2, '아이디 · 비밀번호')
    assert.ok(fills.every((m) => m.args.keys === true), '키 하나씩')
    assert.equal(fills.filter((m) => m.args.value === PASSWORD).length, 1)
    assert.ok((sentTo.get(user) || []).some((m) => JSON.parse(m).op === 'press'), 'Enter 로 보냄')
    assert.ok(!(sentTo.get(other) || []).some((m) => m.includes(PASSWORD)))
    const c = await card('PC 에서 로그인 벽')
    assert.equal(c.content.need ?? null, null, '사람에게 묻지 않았다')
  } finally { walls.login = false }
})

test('PC 가 꺼지면 카드가 멈춘다(「PC 연결 끊김」) — 저절로 옮기지 않고, 「PC가 다시 켜지면」 그 PC 에서 이어서 끝낸다', { skip }, async () => {
  const goal = 'PC 꺼짐 후 PC'
  const p = run(goal, [
    (b) => ['type', { i: pick(b, (x) => x.name === 'q'), text: '가상 배', enter: true }],
    async () => { await pc.kill(); return ['note', { text: 'PC 를 껐다' }] },
    (b) => ['note', { text: `${lastSnap(b).url} ${lastSnap(b).text.split('\n').find((l) => l.startsWith('찾은 것')) || ''}` }],
    ['finish', { summary: '이어서 끝냈어요.' }],
  ])
  const c = await until(async () => { const x = await card(goal); return x?.content?.need === 'offline' ? x : null }, 15_000)
  assert.ok(c, '「PC 연결 끊김」 카드')
  assert.equal(c.content.state, 'needs_input')
  assert.equal(c.content.offline.device, '시험 PC')
  assert.match(c.content.reason, /서버에서 이어서/)
  // nothing moves by itself
  await sleep(2500)
  const still = await card(goal)
  assert.deepEqual([still.content.state, still.content.need, still.content.where.kind], ['needs_input', 'offline', 'local'])
  // 「PC가 다시 켜지면」 → the card says it waits for the PC; the PC comes back → the task goes on there
  assert.equal(await browser.routeTo(user, c.id, 'wait'), true)
  assert.equal((await card(goal)).content.offline.waiting, true)
  await startPc()
  const r = await p
  assert.equal(r.state, 'done', JSON.stringify(r).slice(0, 300))
  assert.equal(r.where.kind, 'local')
  assert.equal(r.stats.offline, 1)
  assert.match(r.notes.at(-1), /\/shop/)
  const done = await card(goal)
  assert.equal(done.content.offline, null)
  assert.equal(done.content.need, null)
})

test('PC 가 꺼진 채 「서버에서 이어서」: 서버 브라우저가 같은 페이지를 열어 이어서 끝낸다(모델도 그 사실을 듣는다)', { skip }, async () => {
  const goal = 'PC 꺼짐 후 서버'
  let told = ''
  const p = run(goal, [
    async () => { await pc.kill(); return ['note', { text: 'PC 를 껐다' }] },
    (b) => { told = b.messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes("The person's PC went offline")).map((m) => m.content).join(' '); return ['note', { text: lastSnap(b).url }] },
    ['finish', { summary: '서버에서 이어서 끝냈어요.' }],
  ], { startUrl: `${site.url}/shop?from=pc` })
  const c = await until(async () => { const x = await card(goal); return x?.content?.need === 'offline' ? x : null }, 15_000)
  assert.ok(c)
  assert.equal(await browser.routeTo(user, c.id, 'server'), true)
  const r = await p
  assert.equal(r.state, 'done', JSON.stringify(r).slice(0, 300))
  assert.deepEqual(r.where, { kind: 'server', from: 'local', device: '시험 PC' })
  assert.equal(r.notes.at(-1), `${site.url}/shop?from=pc`)
  assert.match(told, /server's browser, which opened .*\/shop\?from=pc/)
  const done = await card(goal)
  assert.deepEqual(done.content.where, { kind: 'server', from: 'local', device: '시험 PC' })
  await startPc()
})

// this PC's own setting, as the desktop app reports it with its runner settings (caps.prefs — desktop/src/settings.js runnerPrefs)
const setPc = (prefs) => H.receive(pcLink(), { type: 'caps', prefs: { enabled: true, ...prefs } })

test('그 PC 의 설정 「브라우저 작업」: 쓰지 않음이면 PC 가 켜져 있어도 서버에서, 내가 시킨 작업만이면 다시 PC 에서 — 설정 화면이 보는 그대로', { skip }, async () => {
  if (!pcLink()) await startPc()
  await setPc({ browser: 'off' })
  let w = await R.whereFor({ id: user })
  assert.deepEqual(w.own, { where: 'server', why: 'off', device: null })
  assert.deepEqual(w.devices.find((x) => x.id === pcLink().id), { id: pcLink().id, name: '시험 PC', browser: true, pref: 'off', enabled: true })
  let r = await run('설정 끔', [['note', { text: '서버' }], ['finish', { summary: '서버에서 했어요.' }]])
  assert.deepEqual(r.where, { kind: 'server', why: 'off' })
  await setPc({ browser: 'own' })
  w = await R.whereFor({ id: user })
  assert.deepEqual(w.own, { where: 'local', why: null, device: { id: pcLink().id, name: '시험 PC' } })
  assert.deepEqual(w.unattended, { where: 'server', why: 'not-own', device: null })
  r = await run('설정 켬', [['note', { text: 'PC' }], ['finish', { summary: 'PC 에서 했어요.' }]])
  assert.equal(r.where.kind, 'local')
})

test('「이 컴퓨터에서 단계 실행」을 끈 PC 로는 브라우저 작업도 가지 않는다(브라우저 설정이 「모두」여도)', { skip }, async () => {
  await H.receive(pcLink(), { type: 'caps', prefs: { enabled: false, browser: 'all' } })
  try {
    assert.equal((await R.whereFor({ id: user })).own.why, 'off')
    const r = await run('단계 실행 끔', [['note', { text: '서버' }], ['finish', { summary: '서버에서 했어요.' }]])
    assert.deepEqual(r.where, { kind: 'server', why: 'off' })
  } finally { await setPc({ browser: 'own' }) }
})

test('사람이 없는 작업(단계 · 예약)은 기본으로 서버에서 — PC 의 설정이 「모두」일 때만 PC 에서, 그때도 PC 의 내부망 주소는 열지 않는다', { skip }, async () => {
  // the default ('own'): a task the person did not start here stays on this server
  let r = await run('사람 없는 작업 기본', [['note', { text: '서버' }], ['finish', { summary: '서버에서 했어요.' }]], { unattended: true })
  assert.deepEqual(r.where, { kind: 'server', why: 'not-own' })
  // started by someone else for this person (own: false) — the same
  r = await run('남이 시킨 작업', [['note', { text: '서버' }], ['finish', { summary: '서버에서 했어요.' }]], { own: false })
  assert.deepEqual(r.where, { kind: 'server', why: 'not-own' })
  // the person said so on that PC: 'all'
  await setPc({ browser: 'all' })
  try {
    sentTo.clear()
    const goal = '사람 없는 작업 PC'
    r = await run(goal, [
      ['goto', { url: `${site.url}/shop?inside=1` }],
      ['goto', { url: 'http://192.168.0.1/admin' }],
      (b) => ['note', { text: b.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join(' | ') }],
      ['finish', { summary: 'PC 에서 했어요.' }],
    ], { unattended: true })
    assert.equal(r.where.kind, 'local', JSON.stringify(r.where))
    assert.match(r.notes.join(' '), /내부망 주소는 열지 않음/, '시작 페이지(127.0.0.1)는 열지 않았다')
    assert.equal((r.notes.at(-1).match(/refused: this task runs with nobody watching/g) || []).length, 2, r.notes.at(-1))
    const ops = (sentTo.get(user) || []).map((m) => JSON.parse(m)).filter((m) => m.type === 'browser')
    assert.deepEqual(ops.filter((m) => m.op === 'begin').map((m) => m.args.noPrivate), [true], 'PC 에도 「내부망 금지」로 시작')
    assert.ok(!ops.some((m) => m.op === 'navigate' && /127\.0\.0\.1|192\.168/.test(m.args.url)), '내부망 주소로 가라는 말이 PC 로 가지 않았다')
  } finally { await setPc({ browser: 'own' }) }
})

test('브라우저가 열리지 않으면 카드는 「실패」로 끝나고 줄 선 다음 작업이 이어서 시작한다 — 「진행 중」으로 남거나 줄이 멈추지 않는다', { skip }, async () => {
  const third = crypto.randomUUID()
  const [{ id: th }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','launch failure') returning id`, [third])
  const { ServerDriver } = await import('../lib/browserServer.js')
  const keepOpen = ServerDriver.open, keepRelaunch = ServerDriver.prototype.relaunch
  const made = []
  ServerDriver.open = async (...a) => { const d = await keepOpen.apply(ServerDriver, a); made.push(d); return d }
  let release
  const gate = new Promise((r) => { release = r })
  const go = (goal, moves) => { scripts[goal] = { i: 0, moves }; return browser.runBrowserTask({ userId: third, threadId: th, goal, startUrl: `${site.url}/shop`, gates: false }) }
  const cardOf = async (goal) => (await q(`select content from pro_messages where thread_id=$1 and kind='task' and content->>'goal'=$2 order by created_at desc limit 1`, [th, goal]))[0]?.content
  try {
    const a = go('열리지 않음 A', [
      async () => { await gate; return ['note', { text: 'A' }] },
      async () => {
        // this server's browser goes, and cannot be launched again
        const fail = async () => { throw new Error("browserType.launchPersistentContext: Executable doesn't exist (test)") }
        ServerDriver.open = fail
        ServerDriver.prototype.relaunch = fail
        await made.at(-1).ctx.close()
        return ['finish', { summary: 'A 끝' }]
      },
    ])
    assert.ok(await until(async () => (await cardOf('열리지 않음 A'))?.where?.kind === 'server'), 'A 가 브라우저를 잡았다')
    const b = go('열리지 않음 B', [['finish', { summary: 'B' }]])
    const c = go('열리지 않음 C', [['finish', { summary: 'C' }]])
    assert.ok(await until(async () => (await cardOf('열리지 않음 B'))?.state === 'queued' && (await cardOf('열리지 않음 C'))?.state === 'queued'), 'B · C 가 줄 섰다')
    release()
    const ra = await a.catch((e) => ({ state: 'threw', error: e.message }))
    assert.notEqual(ra.state, 'threw', ra.error)
    const t0 = Date.now()
    const [rb, rc] = await Promise.all([b, c])
    assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0}ms`)
    for (const [goal, r] of [['열리지 않음 B', rb], ['열리지 않음 C', rc]]) {
      assert.equal(r.state, 'failed', goal)
      const k = await cardOf(goal)
      assert.equal(k.state, 'failed', `${goal} 카드`)
      assert.match(k.reason, /브라우저를 열지 못해/)
    }
  } finally {
    ServerDriver.open = keepOpen
    ServerDriver.prototype.relaunch = keepRelaunch
    release()
    await browser.close(third).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [third]).catch(() => {})
    fs.rmSync(path.join(browser.PROFILES, third), { recursive: true, force: true })
  }
})

test('이어진 PC 의 브라우저가 거듭 열리지 않으면 3번까지만 다시 열고 카드가 멈춘다 — 끝없이 다시 열지 않는다', { skip }, async () => {
  const fourth = crypto.randomUUID()
  const [{ id: th }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','reopen cap') returning id`, [fourth])
  const tok = (await D.issue({ id: fourth }, { name: '고장 난 PC', platform: 'test', appVersion: '0.2.3' })).token
  // a desktop whose browser opens and then says, at every look, that it is not open
  const ops = []
  let link
  const answer = (m) => {
    if (m.type !== 'browser') return
    ops.push(m.op)
    const at = { url: `${site.url}/shop`, title: '가상 상점', vp: { width: 1280, height: 800 }, tab: 1, tabs: 1 }
    const reply = m.op === 'look' ? { type: 'browser-reply', id: m.id, ok: false, error: 'the browser is not open on this PC', code: 'closed', at: null }
      : { type: 'browser-reply', id: m.id, ok: true, value: m.op === 'navigate' ? { ok: true, partial: false, ms: 5 } : m.op === 'open' ? { shown: false } : null, at }
    setImmediate(() => H.receive(link, reply))
  }
  link = await H.open({ send: (text) => answer(JSON.parse(text)), close: () => {} }, { type: 'hello', token: tok, caps: { browser: true, browserGuard: true }, prefs: { enabled: true, browser: 'own' } })
  const goal = '고장 난 PC 에서'
  scripts[goal] = { i: 0, moves: [['note', { text: '아무거나' }]] }
  const cardOf = async () => (await q(`select id, content from pro_messages where thread_id=$1 and kind='task' and content->>'goal'=$2 order by created_at desc limit 1`, [th, goal]))[0]
  try {
    const p = browser.runBrowserTask({ userId: fourth, threadId: th, goal, startUrl: 'https://example.com/', gates: false })
    const c = await until(async () => { const x = await cardOf(); return x?.content?.need === 'offline' ? x : null }, 20_000)
    assert.ok(c, '멈춘 카드')
    assert.match(c.content.reason, /거듭 열리지 않아/)
    assert.equal(c.content.where.kind, 'local')
    assert.equal(ops.filter((o) => o === 'open').length, 1 + browser.MAX_REOPENS, ops.join(','))
    await sleep(1500)
    assert.equal(ops.filter((o) => o === 'open').length, 1 + browser.MAX_REOPENS, '멈춘 뒤에는 다시 열지 않는다')
    assert.equal(browser.cancel(fourth, c.id), true)
    assert.equal((await p).state, 'cancelled')
  } finally {
    await H.gone(link).catch(() => {})
    await browser.close(fourth).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [fourth]).catch(() => {})
    await q('delete from pro_local_devices where user_id=$1', [fourth]).catch(() => {})
  }
})

// ---- 2026-11-25 re-review ----
const opsSent = () => (sentTo.get(user) || []).map((m) => JSON.parse(m)).filter((m) => m.type === 'browser')

test('계획하는 동안 취소한 작업: 그동안 쥔 PC 의 브라우저를 놓는다(begin 뒤에 idle)', { skip }, async () => {
  if (!pcLink()) await startPc()
  sentTo.clear()
  const goal = 'PC 계획 중 취소'
  let release
  planHold.goal = goal
  planHold.wait = new Promise((r) => { release = r })
  try {
    const p = run(goal, [['finish', { summary: '안 해요.' }]])
    const c = await until(() => card(goal))
    assert.ok(await until(() => opsSent().some((m) => m.op === 'begin')), '계획하는 동안 브라우저를 쥐었다')
    assert.equal(browser.cancel(user, c.id), true)
    release()
    const r = await p
    assert.equal(r.state, 'cancelled')
    const ops = opsSent().map((m) => m.op)
    assert.ok(ops.lastIndexOf('idle') > ops.indexOf('begin'), ops.join(','))
  } finally { release?.(); planHold.goal = null }
})

test('PC 에서 사람이 필요한 채로 끝난 작업: 페이지는 그 PC 에 남고(idle keep) 「이 PC에서 보기」가 된다 — 이유도 「직접 제어」가 아니라 그렇게 말한다', { skip }, async () => {
  sentTo.clear()
  const goal = 'PC 에서 아무것도 안 함'
  const r = await run(goal, [['finish', { summary: '끝났어요.' }]])
  assert.equal(r.state, 'needs_review', JSON.stringify(r).slice(0, 300))
  assert.equal(r.where.kind, 'local')
  assert.match(r.reason, /「이 PC에서 보기」/)
  assert.doesNotMatch(r.reason, /직접 제어/)
  const c = await card(goal)
  assert.equal(c.content.pcKept, true)
  assert.deepEqual(opsSent().filter((m) => m.op === 'idle').map((m) => m.args.keep), [true], '페이지를 남긴다')
  // after the task: shown on the PC from the card, and hidden again
  assert.equal(await browser.showOnPc(user, c.id), true)
  assert.equal(await browser.showOnPc(user, c.id, false), true)
  // another task takes that browser: the kept page goes, and the old card says so
  const r2 = await run('다음 PC 작업', [['note', { text: '다음' }], ['finish', { summary: '했어요.' }]])
  assert.equal(r2.state, 'done')
  assert.equal(await until(async () => (await card(goal)).content.pcKept === false), true)
  assert.equal(await browser.showOnPc(user, c.id), false)
  assert.equal((await card('다음 PC 작업')).content.pcKept, false, '제대로 끝난 작업은 남기지 않는다')
})

test('사람이 시키지 않은 작업(own: false — 회사 루틴의 자동 실행)은 PC 가 「모두」여도 그 PC 의 내부망을 열지 않는다', { skip }, async () => {
  await setPc({ browser: 'all' })
  try {
    sentTo.clear()
    const goal = '자동 루틴 PC'
    const r = await run(goal, [
      ['goto', { url: `${site.url}/shop?auto=1` }],
      (b) => ['note', { text: b.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join(' | ') }],
      ['finish', { summary: 'PC 에서 했어요.' }],
    ], { own: false })
    assert.equal(r.where.kind, 'local', JSON.stringify(r.where))
    assert.deepEqual(opsSent().filter((m) => m.op === 'begin').map((m) => m.args.noPrivate), [true])
    assert.match(r.notes.at(-1), /refused: this task runs with nobody watching/)
    assert.ok(!opsSent().some((m) => m.op === 'navigate' && /127\.0\.0\.1/.test(m.args.url)))
  } finally { await setPc({ browser: 'own' }) }
})

test('PC 의 브라우저는 그 데스크톱이 연결한 Lite 서버의 주소를 열지 않는다 — 이 PC 의 다른 이름으로도, 에이전트는 까닭을 받는다 (데스크톱 0.2.6)', { skip }, async () => {
  const goal = 'PC 에서 Lite 열기'
  const r = await run(goal, [
    ['goto', { url: `${hubUrl}/login` }],
    ['goto', { url: `${hubUrl.replace('127.0.0.1', 'localhost')}/chat` }],
    (b) => ['note', { text: `${lastSnap(b).url} | ${b.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join(' | ')}` }],
    ['finish', { summary: '열지 않았어요.' }],
  ])
  assert.equal(r.state, 'done', JSON.stringify(r).slice(0, 300))
  assert.equal(r.where.kind, 'local')
  const [where, ...told] = r.notes.at(-1).split(' | ')
  assert.equal(where, `${site.url}/shop`, '페이지는 시작한 사이트 그대로')
  assert.equal(told.length, 2)
  for (const t of told) assert.match(t, /^error: could not open .*this browser does not open the Process GPT Lite app/)
})
