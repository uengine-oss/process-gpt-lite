// 서버 브라우저가 멈춘 것처럼 보이지 않는다(2026-11-24 「계룡대 인근 숙소 검색 … 브라우저가 먹통이 된」) — 진짜 Chromium,
// 이 폴더의 시험 사이트(fixtures/heavy.mjs, 지어낸 숙소), 대본대로 움직이는 모델, 대본대로 답하는 판정 서버. 인터넷 없음.
//   - 무거운 페이지(카드 1500장, 끝나지 않는 그림, 0.1초마다 새 요청)에서 짧은 작업이 시간 안에 끝난다
//   - 칸에 쓴 값·자리 표시 글자를 기다리면 바로 끝나고, 스스로 하는 일이 없는 페이지에서는 기다리지 않는다
//   - 모델이 답하지 않으면 카드가 「기다리는 중 · AI 모델의 답」 → 「다시 시도」로 그 걸음만 다시
//   - 멈춘 채 「그만두기」: 바로 끝나고, 브라우저는 다음 작업으로 넘어간다
//   - 페이지의 스크립트가 끝나지 않아 렌더러가 답하지 않아도, 다음 작업은 새 탭(또는 새 브라우저)에서 한다
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { startHeavy, STAYS, CAFES } from './fixtures/heavy.mjs'
// (this test's made-up sites run on this machine: the server's browser may open them — lib/privateNet.js)
process.env.PRO_BROWSER_PRIVATE_ALLOW ??= '127.0.0.1,localhost,*.localhost'

// ---- scripted model: the plan, then per goal a list of moves: a tool call, a function of the request, or 'hang' ----
const scripts = {}
const hung = []
const pick = (body, text) => {
  const last = [...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{'))
  const el = JSON.parse(last.content.split('\n')[0]).els.find((e) => e.text === text)
  if (!el) throw new Error(`no element "${text}"`)
  return el.i
}
const lastPage = (body) => JSON.parse([...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{')).content.split('\n')[0])
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    let message
    if (body.response_format) message = { role: 'assistant', content: JSON.stringify({ title: '가상 숙소 찾기', steps: ['검색', '비교', '정리'] }) }
    else {
      const goal = /Goal: (.*)/.exec(body.messages[0].content)?.[1] || ''
      const s = scripts[goal]
      const step = s.moves[Math.min(s.i++, s.moves.length - 1)]
      const move = typeof step === 'function' ? step(body) : step
      // a model that never answers: the request stays open until the browser agent gives up on it
      if (move === 'hang') { hung.push(goal); res.on('close', () => { s.dropped = (s.dropped || 0) + 1 }); return }
      const [name, args] = move
      message = name === 'text' ? { role: 'assistant', content: args }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
})
// ---- scripted judge: pages are fine; whether the page is busy is what busy.idle says ----
const busy = { idle: 0.05 }
const judgeServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const { options } = JSON.parse(raw)
    const keys = options.map((o) => o.key)
    const probabilities = keys.includes('idle') ? { idle: busy.idle, busy: 1 - busy.idle } : Object.fromEntries(keys.map((k) => [k, k === 'ok' ? 0.96 : 0.01]))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ probabilities, model: 'scripted' }))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
await new Promise((r) => judgeServer.listen(0, '127.0.0.1', r))
Object.assign(process.env, { PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}`, PRO_LLM_API_KEY: 'test', PRO_JUDGE_URL: `http://127.0.0.1:${judgeServer.address().port}/judge`, PRO_CONTEXT_ROUTER_URL: '' })

const browser = await import('../lib/browser.js')
const bus = await import('../lib/bus.js')
const { q, pool } = await import('../lib/supa.js')

const user = crypto.randomUUID()
let site, threadId
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const card = async (goal) => (await q(`select id, content from pro_messages where thread_id=$1 and kind='task' and content->>'goal'=$2 order by created_at desc limit 1`, [threadId, goal]))[0]
const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(100) } }
const run = (goal, moves, startUrl = `${site.url}/stay`) => { scripts[goal] = { i: 0, moves }; return browser.runBrowserTask({ userId: user, threadId, goal, startUrl, gates: false }) }
const keep = { ...browser.STEP }

before(async () => {
  site = await startHeavy()
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','browser stall test') returning id`, [user])
})
after(async () => {
  Object.assign(browser.STEP, keep)
  await browser.close(user)
  await site.close()
  llm.close(); llm.closeAllConnections?.()
  judgeServer.close()
  await q('delete from pro_threads where user_id=$1', [user])
  await pool.end()
  fs.rmSync(path.join(browser.PROFILES, user), { recursive: true, force: true })
})

test('무거운 숙소 페이지(끝나지 않는 그림 · 0.1초마다 요청 · 카드 1500장)에서 검색 → 결과 정리가 시간 안에 끝난다', async () => {
  const frames = []
  const off = bus.subscribe(user, { writableLength: 0, write(l) { if (l.startsWith('event: browser.frame')) frames.push(Date.now()); return true } })
  const t0 = Date.now()
  const r = await run('가상시 숙소 비교', [
    (b) => ['type', { i: pick(b, '어디로 떠나시나요?'), text: '가상시', enter: true }],
    // the field's own placeholder and the value typed into it count as on the page: the wait ends at once
    ['wait_for_page', { minutes: 1, until_text: '가상시' }],
    (b) => ['note', { text: lastPage(b).text.split('\n').filter((l) => l.includes('가상시')).slice(0, 4).join(' / ') }],
    ['finish', { summary: `${STAYS[2].name}이 ${STAYS[2].price}로 가장 싸요.` }],
  ])
  const ms = Date.now() - t0
  off()
  assert.equal(r.state, 'done', JSON.stringify(r).slice(0, 400))
  assert.ok(ms < 25_000, `${ms}ms`)
  assert.equal(r.stats.step_timeouts, 0)
  for (const t of r.stats.turn_ms) assert.ok(t.snap < 2500, `읽기 ${t.snap}ms`)
  const waited = r.stats.turn_ms.find((t) => t.tool === 'wait_for_page')
  assert.ok(waited.act < 3000, `칸에 쓴 값을 기다리는 데 ${waited.act}ms`)
  assert.ok(r.notes.join(' ').includes(STAYS[0].name), r.notes.join(' '))
  // the live view: at most LIVE.minMs apart (the screenshot a turn takes for the model is the one extra frame)
  const perSec = frames.length / (ms / 1000)
  assert.ok(perSec <= 1000 / browser.LIVE.minMs + 1.5, `초당 ${perSec.toFixed(1)}장`)
})

test('끝나지 않는 페이지로 이동: load·networkidle 을 기다리지 않고 짧게 정리한 뒤 진행한다', async () => {
  const r = await run('끝나지 않는 페이지', [['goto', { url: `${site.url}/never-idle` }], ['note', { text: '열림' }], ['finish', { summary: '열었어요.' }]])
  assert.equal(r.state, 'done')
  const go = r.stats.turn_ms.find((t) => t.tool === 'goto')
  assert.ok(go.act < browser.STEP.settleMs + 2500, `이동 ${go.act}ms`)
})

test('스스로 하는 일이 없는 페이지에서는 기다리지 않는다(판정) — 모델에게 직접 하라고 돌려준다', async () => {
  busy.idle = 0.92
  let told = ''
  const t0 = Date.now()
  const r = await run('일 없는 기다림', [
    ['wait_for_page', { minutes: 3, until_text: '가상시, 대한민국' }],
    (b) => { told = b.messages.filter((m) => m.role === 'tool').at(-1).content; return ['finish', { summary: '기다리지 않았어요.' }] },
  ])
  busy.idle = 0.05
  assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0}ms`)
  assert.match(told, /^refused: nothing on this page is working by itself/)
  assert.equal(r.stats.waits_refused, 1)
})

test('모델이 답하지 않으면: 카드에 「기다리는 중 · AI 모델의 답」 → 다시 시도로 그 걸음만 다시 묻고 끝까지 간다', async () => {
  Object.assign(browser.STEP, { stallMs: 1200 })
  const goal = '답 없는 모델 다시 시도'
  const running = run(goal, ['hang', ['note', { text: '두 번째에 답함' }], ['finish', { summary: '다시 물어 끝냈어요.' }]])
  const stalled = await until(async () => (await card(goal))?.content.stall)
  assert.ok(stalled, '카드에 멈춤이 오지 않았다')
  assert.equal(stalled.what, 'AI 모델의 답')
  assert.equal(stalled.after, 1)
  const { id } = await card(goal)
  assert.equal(browser.retryStep(user, id), true)
  const r = await running
  Object.assign(browser.STEP, { stallMs: keep.stallMs })
  assert.equal(r.state, 'done', r.summary)
  assert.equal(r.stats.retries, 1)
  assert.ok(r.stats.stalls >= 1)
  assert.equal(scripts[goal].dropped, 1, '답하지 않던 요청은 끊는다')
  const end = (await card(goal)).content
  assert.equal(end.stall, null)
  assert.equal(end.state, 'done')
})

test('멈춘 채 그만두기: 2초 안에 끝나고, 브라우저는 바로 다음 작업이 쓴다', async () => {
  Object.assign(browser.STEP, { stallMs: 1000 })
  const goal = '답 없는 모델 그만두기'
  const running = run(goal, ['hang'])
  await until(async () => (await card(goal))?.content.stall)
  const { id } = await card(goal)
  const t0 = Date.now()
  assert.equal(browser.cancel(user, id), true)
  const r = await running
  const took = Date.now() - t0
  Object.assign(browser.STEP, { stallMs: keep.stallMs })
  assert.equal(r.state, 'cancelled')
  assert.ok(took < 2000, `취소가 ${took}ms 걸렸다`)
  const c = (await card(goal)).content
  assert.equal(c.state, 'cancelled')
  assert.equal(c.stall, null)
  assert.equal(browser.browserBusy(user), '', '브라우저가 비었다')
  const next = await run('그만둔 뒤 다음 작업', [['note', { text: '다음 작업' }], ['finish', { summary: '이어서 했어요.' }]])
  assert.equal(next.state, 'done')
})

test('렌더러가 답하지 않는 페이지(끝나지 않는 스크립트): 읽기는 한도에서 끝나고, 그만둔 뒤 다음 작업은 새 탭이나 새 브라우저에서 한다', async () => {
  Object.assign(browser.STEP, { snapMs: 1500, shotMs: 1500 })
  const goal = '멈추는 페이지'
  let saw = null
  const running = run(goal, [
    (b) => ['click', { i: pick(b, '멈추기 시험') }],
    (b) => { saw = lastPage(b); return 'hang' },
  ], `${site.url}/stuck`)
  await until(() => saw, 20_000)
  assert.ok(saw.more?.unread, '답하지 않는 페이지는 읽지 못했다고 말한다')
  const { id } = await card(goal)
  browser.cancel(user, id)
  const r = await running
  assert.equal(r.state, 'cancelled')
  const t0 = Date.now()
  const next = await run('멈춘 뒤 다음 작업', [(b) => ['note', { text: lastPage(b).title }], ['finish', { summary: '새 탭에서 했어요.' }]])
  Object.assign(browser.STEP, { snapMs: keep.snapMs, shotMs: keep.shotMs })
  assert.equal(next.state, 'done', next.summary)
  assert.ok(Date.now() - t0 < 20_000, `${Date.now() - t0}ms`)
  assert.ok(next.notes.includes('가상 숙소 찾기'), JSON.stringify(next.notes))
})

test('결과가 다른 출처의 iframe 안에 있는 지도 같은 페이지: 에이전트가 그 안의 단추를 누르고 결과를 읽는다', async () => {
  const r = await run('지도 프레임', [
    (b) => ['click', { i: pick(b, '더 보기') }],
    (b) => ['note', { text: lastPage(b).text.split('\n').filter((l) => l.includes('가상동')).join(' / ') }],
    ['finish', { summary: '카페 네 곳을 찾았어요.' }],
  ], `${site.url}/framed`)
  assert.equal(r.state, 'done', r.summary)
  assert.match(r.notes.join(' '), /가상동 달빛 카페.*가상동 넷째 카페/)
  assert.equal(r.stats.turn_ms.find((t) => t.tool === 'click').act < 3000, true)
})

test('같은 화면으로 돌아와 같은 동작을 세 번 되풀이하면(날짜 18 · 20 · 검색을 계속) 사람에게 넘긴다', async () => {
  const goal = '되풀이'
  const cycle = ['18', '20', '검색'].map((t) => (b) => ['click', { i: pick(b, t) }])
  const running = run(goal, Array.from({ length: 30 }, (_, k) => cycle[k % 3]), `${site.url}/picker`)
  const c = await until(async () => { const x = (await card(goal))?.content; return x?.state === 'needs_input' && x })
  assert.equal(c.need, 'stuck')
  assert.match(c.reason, /같은 화면으로 돌아와 같은 동작을 세 번 되풀이해 멈췄어요/)
  assert.ok(scripts[goal].i <= 9, `${scripts[goal].i}번 움직이고서야 멈췄다`)
  browser.cancel(user, (await card(goal)).id)
  const r = await running
  assert.equal(r.state, 'cancelled')
  assert.equal(r.stats.loops, 1)
})

test('프레임 안의 목록은 그 안의 요소를 주고 내린다(마우스 휠이 그 목록 위에서)', async () => {
  const r = await run('프레임 목록 내리기', [
    (b) => ['scroll', { dy: 3000, i: pick(b, CAFES[0]) }],
    (b) => ['note', { text: lastPage(b).text.includes('가상동 끝집 카페') ? '맨 아래까지 봄' : '못 봄' }],
    ['finish', { summary: '끝.' }],
  ], `${site.url}/framed`)
  assert.equal(r.state, 'done', r.summary)
  assert.deepEqual(r.notes, ['맨 아래까지 봄'])
})

test('사람의 승인을 기다리는 동안은 동작 하나의 한도(15초)에 들지 않는다 — 결제 단추 → 승인 카드 → 늦게 승인해도 누른다', async () => {
  Object.assign(browser.STEP, { actMs: 800 })
  const goal = '가상 상품을 결제해 줘'
  const running = run(goal, [
    (b) => ['click', { i: pick(b, '결제하기') }],
    (b) => ['note', { text: lastPage(b).text.includes('결제 완료') ? '결제 완료' : '안 됨' }],
    ['finish', { summary: '결제했어요.' }],
  ], `${site.url}/pay`)
  const asked = await until(async () => (await card(goal))?.content.need === 'approve')
  assert.ok(asked, '승인을 묻지 않았다')
  await sleep(2500) // longer than the action's limit
  browser.resume(user, 'The user chose: 승인. Continue with that choice.')
  const r = await running
  Object.assign(browser.STEP, { actMs: keep.actMs })
  assert.equal(r.state, 'done', r.summary)
  assert.deepEqual(r.notes, ['결제 완료'])
  assert.equal(r.stats.step_timeouts, 0)
})
