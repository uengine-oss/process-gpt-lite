// Browser tasks, end to end inside the server process (a real Chromium on the local test shop, a
// scripted stand-in for the model — like browser-vault.test.js):
//   - a second task while one holds the browser waits in line (card 대기) and starts when the first
//     ends; a waiting one can be cancelled by its own card; the person is told (tutorial-findings #29)
//   - a task that ends without a single browser action is 확인 필요, not 완료, and its summary does
//     not repeat what the model claimed; a real run's summary lists the actions taken (#28)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startShop } from './fixtures/shop.mjs'

// ---- scripted model: the plan, then per goal a list of moves (a tool call, or plain text) ----
const scripts = {}
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    let message
    if (body.response_format) {
      message = { role: 'assistant', content: JSON.stringify({ title: '테스트 상점 작업', steps: ['상점 열기', '상품 담기', '결제 정보 입력', '결제'] }) }
    } else {
      const goal = /Goal: (.*)/.exec(body.messages[0].content)?.[1] || ''
      const s = scripts[goal]
      const move = s.moves[Math.min(s.i++, s.moves.length - 1)]
      const [name, args] = typeof move === 'function' ? move() : move
      message = name === 'text' ? { role: 'assistant', content: args }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llm.address().port}`
process.env.PRO_LLM_API_KEY = 'test'

const browser = await import('../lib/browser.js')
const { q, pool } = await import('../lib/supa.js')

const user = crypto.randomUUID()
let shop, threadId
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tasks = async () => (await q(`select id, content from pro_messages where thread_id=$1 and kind='task' order by created_at`, [threadId]))
const texts = async () => (await q(`select content->>'text' t from pro_messages where thread_id=$1 and kind='text' order by created_at`, [threadId])).map((r) => r.t)
const until = async (fn, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(150) } }

before(async () => {
  shop = await startShop(0, {})
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','browser tasks test') returning id`, [user])
})
after(async () => {
  await browser.close(user)
  await shop.close()
  llm.close()
  await q('delete from pro_threads where user_id=$1', [user])
  await pool.end()
  fs.rmSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.browser-profiles', user), { recursive: true, force: true })
})

test('도구를 하나도 쓰지 않고 끝내려는 작업: 한 번 되돌려 보내고, 그래도 안 하면 "확인 필요"', async () => {
  const goal = '아무것도 안 하는 작업'
  scripts[goal] = { i: 0, moves: [['text', '결제 입력 단계(카드 소유자, 카드 번호, 만료일, CVC)까지 진행한 뒤 멈췄습니다.'], ['finish', { summary: '결제까지 마쳤습니다.' }]] }
  const r = await browser.runBrowserTask({ userId: user, threadId, goal, gates: false })
  assert.equal(scripts[goal].i, 2, '첫 답(도구 없음)은 한 번 되돌려 보냄')
  assert.equal(r.state, 'needs_review')
  assert.doesNotMatch(r.summary, /카드 소유자|결제까지 마쳤/)
  assert.match(r.summary, /아무 동작도 하지 못한/)
  const [card] = (await tasks()).slice(-1)
  assert.equal(card.content.state, 'needs_review')
})

test('실제로 한 작업의 요약은 기록한 동작 목록', async () => {
  const goal = '상점 열고 끝내기'
  scripts[goal] = { i: 0, moves: [['goto', { url: `${shop.url}/login` }], ['note', { text: '로그인 화면이 보임' }], ['finish', { summary: '상점 로그인 화면까지 열었어요.' }]] }
  const r = await browser.runBrowserTask({ userId: user, threadId, goal, gates: false })
  assert.equal(r.state, 'done')
  assert.match(r.summary, /^상점 로그인 화면까지 열었어요\./)
  assert.match(r.summary, /실제로 한 일\n• 127\.0\.0\.1 열기/)
})

test('앞 작업이 사람을 기다리는 동안 새 작업은 대기 — 대기 작업은 따로 취소, 앞 작업이 끝나면 다음이 시작', async () => {
  const A = '로그인하고 사람을 기다리는 작업', B = '기다리다 취소될 작업', C = '이어서 시작될 작업'
  scripts[A] = { i: 0, moves: [['goto', { url: `${shop.url}/login` }], ['need_user', { reason: '캡차를 풀어 주세요' }], ['finish', { summary: '앞 작업 끝' }]] }
  scripts[B] = { i: 0, moves: [['finish', { summary: 'B 는 시작되면 안 됨' }]] }
  scripts[C] = { i: 0, moves: [['goto', { url: `${shop.url}/login` }], ['finish', { summary: '이어서 한 작업 끝' }]] }
  const pa = browser.runBrowserTask({ userId: user, threadId, goal: A, gates: false })
  await until(async () => (await tasks()).some((t) => t.content.goal === A && t.content.state === 'needs_input'))
  const pb = browser.runBrowserTask({ userId: user, threadId, goal: B, gates: false })
  const pc = browser.runBrowserTask({ userId: user, threadId, goal: C, gates: false })
  const queued = await until(async () => { const l = (await tasks()).filter((t) => [B, C].includes(t.content.goal) && t.content.state === 'queued'); return l.length === 2 && l })
  assert.ok(queued, 'B·C 카드는 대기')
  assert.ok((await texts()).some((t) => /한 번에 한 작업만/.test(t) && /입력을 기다리고/.test(t)), '사용자에게 알림')
  assert.equal(scripts[B].i, 0)
  // B cancelled by its own card; A is untouched
  const bCard = queued.find((t) => t.content.goal === B)
  assert.equal(browser.cancel(user, bCard.id), true)
  const rb = await pb
  assert.equal(rb.state, 'cancelled')
  assert.equal(scripts[B].i, 0, 'B 는 브라우저를 쓰지 않음')
  assert.equal((await tasks()).find((t) => t.content.goal === A).content.state, 'needs_input')
  // the person answers A (takeover done): A finishes, then C gets the browser
  browser.resume(user, 'The user took over and finished the manual part. Re-check the page and continue.')
  const ra = await pa
  assert.equal(ra.state, 'done')
  const rc = await pc
  assert.equal(rc.state, 'done')
  assert.match(rc.summary, /이어서 한 작업 끝/)
  const states = Object.fromEntries((await tasks()).filter((t) => [A, B, C].includes(t.content.goal)).map((t) => [t.content.goal, t.content.state]))
  assert.deepEqual(states, { [A]: 'done', [B]: 'cancelled', [C]: 'done' })
})
