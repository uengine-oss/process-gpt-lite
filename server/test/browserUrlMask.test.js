// A page whose address carries sign-in tokens (?code=… #access_token=… #refresh_token=…), opened by a browser task: the model, the judge,
// the live view, the task's card and result, lastFrame and the log lines see the address with those values as "…" — in this server's
// browser, and in the browser on the person's PC (the desktop app, Electron), where they are masked before they leave the PC.
// A scripted model and judge, a made-up site; the local database.
//   node --test test/browserUrlMask.test.js
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { startDesktopBrowser, haveElectron } from './fixtures/desktopBrowser.mjs'

const SECRET = /SECRET-(CODE|ACCESS|REFRESH)/
const scripts = {}
const bodies = []
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    bodies.push(raw)
    const body = JSON.parse(raw)
    let message
    if (body.response_format) message = { role: 'assistant', content: JSON.stringify({ title: '주소 가림 작업', steps: ['열기', '정리'] }) }
    else {
      const goal = /Goal: (.*)/.exec(body.messages[0].content)?.[1] || ''
      const s = scripts[goal]
      const [name, args] = s.moves[Math.min(s.i++, s.moves.length - 1)]
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
})
const judged = []
const judge = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    judged.push(raw)
    const keys = JSON.parse(raw).options.map((o) => o.key)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ probabilities: Object.fromEntries(keys.map((k) => [k, ['ok', 'idle'].includes(k) ? 0.96 : 0.01])), model: 'scripted' }))
  })
})
// the site: /start sends the browser on to a page whose address carries the tokens (as a sign-in's callback does)
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/start') { res.writeHead(302, { Location: '/landing?code=SECRET-CODE-1&state=st-1#access_token=SECRET-ACCESS-2&refresh_token=SECRET-REFRESH-3&token_type=bearer' }); return res.end() }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end('<!doctype html><title>도착</title><body><h1>로그인 뒤 도착한 곳</h1><p>여기까지 왔어요</p></body>')
})
for (const s of [llm, judge, site]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-url-mask-'))
Object.assign(process.env, { PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}`, PRO_LLM_API_KEY: 'test', PRO_JUDGE_URL: `http://127.0.0.1:${judge.address().port}/judge`,
  PRO_CONTEXT_ROUTER_URL: '', PRO_BROWSER_PROFILES: tmp })

const browser = await import('../lib/browser.js')
const bus = await import('../lib/bus.js')
const H = await import('../lib/localAgents/hub.js')
const D = await import('../lib/localAgents/devices.js')
const R = await import('../lib/browserRemote.js')
const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')

const SITE = `http://127.0.0.1:${site.address().port}`
const user = crypto.randomUUID()
let threadId, hub, pc
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 20_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(100) } }
const skipPc = haveElectron() ? false : 'desktop/ 에 Electron 이 없다(npm ci)'

before(async () => {
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','url mask test') returning id`, [user])
})
after(async () => {
  await browser.close(user).catch(() => {})
  await pc?.stop()
  hub?.close()
  for (const s of [llm, judge, site]) { s.close(); s.closeAllConnections?.() }
  await q('delete from pro_threads where user_id=$1', [user]).catch(() => {})
  await q('delete from pro_local_devices where user_id=$1', [user]).catch(() => {})
  await pool.end()
  fs.rmSync(tmp, { recursive: true, force: true })
})

// one task through /start, with everything it says and keeps collected
async function runAndCollect(goal) {
  scripts[goal] = { i: 0, moves: [['goto', { url: `${SITE}/start` }], ['note', { text: '도착한 곳을 확인함' }], ['finish', { summary: '도착했어요.' }]] }
  const logs = []
  const keepLog = { log: console.log, warn: console.warn, error: console.error }
  for (const k of Object.keys(keepLog)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); keepLog[k](...a) }
  const events = []
  const off = bus.subscribe(user, { writableLength: 0, write(l) { events.push(l); return true } })
  const from = bodies.length, fromJudge = judged.length
  let r
  try { r = await browser.runBrowserTask({ userId: user, threadId, goal, gates: false }) } finally { off(); Object.assign(console, keepLog) }
  const card = (await q(`select content from pro_messages where thread_id=$1 and kind='task' and content->>'goal'=$2 order by created_at desc limit 1`, [threadId, goal]))[0]
  return { r, logs, events, card, sent: bodies.slice(from), judged: judged.slice(fromJudge) }
}
function assertMasked(got, where) {
  const { r, logs, events, card, sent } = got
  assert.equal(r.state, 'done', JSON.stringify(r).slice(0, 300))
  assert.equal(r.where.kind, where)
  // the address is there, with the values masked
  assert.match(r.url, /\/landing\?code=…&state=st-1#access_token=…&refresh_token=…&token_type=bearer$/)
  assert.match(card.content.url, /\/landing\?code=…&state=st-1#access_token=…/)
  assert.ok(sent.some((b) => b.includes('/landing?code=…&state=st-1#access_token=…')), 'the model reads the page\'s address, masked')
  const frames = events.filter((l) => l.startsWith('event: browser.frame')).map((l) => JSON.parse(l.split('\ndata: ')[1]))
  assert.ok(frames.length >= 1, 'live frames came')
  assert.ok(frames.some((f) => /\/landing\?code=…/.test(f.url)), frames.map((f) => f.url).join(' '))
  // (this server's browser stays on the page; the PC's clears its page when the task lets go — host.js idle)
  if (where === 'server') assert.match(browser.lastFrame(user).url, /\/landing\?code=…/)
  assert.doesNotMatch(browser.lastFrame(user).url, SECRET)
  // never the values themselves
  assert.ok(!sent.some((b) => SECRET.test(b)), 'not to the model')
  assert.ok(!got.judged.some((b) => SECRET.test(b)), 'not to the judge')
  assert.ok(!events.some((l) => SECRET.test(l)), 'not in events (the live view, the card)')
  assert.ok(!logs.some((l) => SECRET.test(l)), 'not in log lines')
  assert.doesNotMatch(JSON.stringify(card.content), SECRET, 'not on the card')
  assert.doesNotMatch(JSON.stringify(r), SECRET, 'not in the result')
}

test('BT-M-01 서버 브라우저: 토큰이 붙은 주소는 모델 · 판정 · 실시간 화면 · 카드 · 결과 · 로그에 값이 가려져 간다', async () => {
  const got = await runAndCollect('서버에서 토큰 주소 열기')
  assertMasked(got, 'server')
  const rows = await q('select content::text as c from pro_messages where thread_id=$1', [threadId])
  assert.ok(!rows.some((x) => SECRET.test(x.c)), 'nowhere in the conversation')
})

test('BT-M-02 내 PC 의 브라우저: PC 가 보내는 주소(답마다의 페이지 · 실시간 화면 · 보기)부터 값이 가려져 있다', { skip: skipPc }, async () => {
  hub = http.createServer()
  H.attach(hub)
  await new Promise((r) => hub.listen(0, '127.0.0.1', r))
  const { token } = await D.issue({ id: user }, { name: '시험 PC', platform: process.platform, appVersion: '0.2.3' })
  // what came from the PC itself, before this server masks anything
  const fromPc = []
  const keep = { at: R.RemoteDriver.prototype.at, onFrame: R.RemoteDriver.prototype.onFrame, look: R.RemoteDriver.prototype.look }
  R.RemoteDriver.prototype.at = function (a = {}) { if (a && typeof a.url === 'string') fromPc.push(a.url); return keep.at.call(this, a) }
  R.RemoteDriver.prototype.onFrame = function (data, url) { fromPc.push(url); return keep.onFrame.call(this, data, url) }
  R.RemoteDriver.prototype.look = async function () { const snap = await keep.look.call(this); fromPc.push(snap?.url || ''); return snap }
  try {
    pc = startDesktopBrowser({ server: `http://127.0.0.1:${hub.address().port}`, token, userData: path.join(tmp, 'pc'), device: '시험 PC' })
    assert.equal(await pc.ready, user)
    await until(() => H.linksOf(config.tenantId, user).find((l) => l.caps?.browser))
    const got = await runAndCollect('PC 에서 토큰 주소 열기')
    assertMasked(got, 'local')
    assert.ok(fromPc.some((u) => /\/landing\?code=…&state=st-1#access_token=…/.test(u)), `the PC sent the address, masked: ${fromPc.slice(-5).join(' ')}`)
    assert.ok(!fromPc.some((u) => SECRET.test(u)), 'the values never left the PC')
  } finally { Object.assign(R.RemoteDriver.prototype, keep) }
})
