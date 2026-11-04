// 브라우저 에이전트의 오래 걸리는 일(spec pgpt-pro_room-rules): 실제 Chromium, 작은 스튜디오 사이트, 대본대로 움직이는 모델.
//   - 생성이 끝날 때까지 동작 수를 쓰지 않고 기다린다 / 끝내 안 끝나면 그렇게 말한다 / 취소하면 바로 멈춘다
//   - 사이트가 내려 주는 파일이 파일 카드로 온다 / 사람이 올린 파일을 사이트에 넣는다 / 진행을 말한다 / 사이트 안내가 모델에게 간다
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startStudio } from './fixtures/studio.mjs'

const scripts = {}
const bodies = []
let slowPlan = null
// the numbered element whose text is this, in the page the model was last shown
const pick = (body, text) => {
  const last = [...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{'))
  const el = JSON.parse(last.content.split('\n')[0]).els.find((e) => e.text === text || e.name === text)
  if (!el) throw new Error(`no element "${text}"`)
  return el.i
}
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    bodies.push(body)
    let message
    if (slowPlan && body.response_format) return void setTimeout(() => {
      res.writeHead(slowPlan.fail ? 500 : 200, { 'Content-Type': 'application/json' })
      res.end(slowPlan.fail ? '{"error":{"message":"down"}}' : JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ title: '느린 계획', steps: ['하나'] }) } }] }))
    }, slowPlan.ms)
    if (body.logprobs) message = { role: 'assistant', content: 'A' } // 확률 없이 답한다: 확률을 주지 않는 모델
    else if (body.response_format) message = { role: 'assistant', content: JSON.stringify({ title: '스튜디오 작업', steps: ['생성', '기다리기', '받기'] }) }
    else {
      const goal = /Goal: (.*)/.exec(body.messages[0].content)?.[1] || ''
      const s = scripts[goal]
      const move = s.moves[Math.min(s.i++, s.moves.length - 1)]
      const [name, args] = typeof move === 'function' ? move(body) : move
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llm.address().port}`
process.env.PRO_LLM_API_KEY = 'test'

const browser = await import('../lib/browser.js')
const { saveAttachment } = await import('../lib/attachments.js')
const { q, pool } = await import('../lib/supa.js')

const user = crypto.randomUUID()
let site, threadId
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = (kind) => q(`select content from pro_messages where thread_id=$1 and kind=$2 order by created_at`, [threadId, kind])
const task = (goal, moves, extra = {}) => {
  scripts[goal] = { i: 0, moves }
  return browser.runBrowserTask({ userId: user, threadId, goal, startUrl: `${site.url}${extra.query || ''}`, files: extra.files || [] })
}

before(async () => {
  browser.WAIT.everyMs = 150
  site = await startStudio()
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','browser long work test') returning id`, [user])
})
after(async () => {
  await browser.close(user)
  await site.close()
  llm.close()
  await q('delete from pro_threads where user_id=$1', [user])
  await pool.end()
  fs.rmSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.browser-profiles', user), { recursive: true, force: true })
})

test('생성을 기다렸다가 받은 파일이 파일 카드로 온다. 기다림은 동작 하나다', async () => {
  const r = await task('기다렸다 받기', [
    (b) => ['click', { i: pick(b, '생성') }],
    ['tell_user', { text: '생성을 시작했어요. 몇 분 걸려요.' }],
    ['wait_for_page', { minutes: 1, gone_text: '생성 중' }],
    (b) => ['click', { i: pick(b, '다운로드') }],
    ['finish', { summary: '받았어요.' }],
  ], { query: '?ms=1200' })
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.equal(r.stats.turns, 5, '기다리는 동안 모델을 부르지 않는다')
  await sleep(800)
  const files = await rows('file')
  assert.equal(files.length, 1)
  assert.match(files[0].content.name, /보고서\.pdf$/)
  assert.match(files[0].content.url, /^https?:/)
  assert.ok((await rows('text')).some((m) => /몇 분 걸려요/.test(m.content.text)), '진행을 말하지 않았다')
  assert.match(r.summary, /받기/, r.summary)
})
test('모델은 받은 파일을 다음 화면에서 안다', async () => {
  const seen = bodies.flatMap((b) => b.messages || []).some((m) => typeof m.content === 'string' && m.content.includes('Downloaded and shown to the person'))
  assert.ok(seen)
})
test('글자가 나타날 때까지도 기다린다', async () => {
  const r = await task('나타날 때까지', [
    (b) => ['click', { i: pick(b, '생성') }],
    ['wait_for_page', { minutes: 1, until_text: '완료' }],
    ['finish', { summary: '끝났어요.' }],
  ], { query: '?ms=500' })
  assert.equal(r.state, 'done', JSON.stringify(r))
})
test('시간 안에 안 끝나면 그렇다고 알려 준다', async () => {
  let told = ''
  const r = await task('안 끝남', [
    (b) => ['click', { i: pick(b, '생성') }],
    ['wait_for_page', { minutes: 0.01, gone_text: '생성 중' }],
    (b) => { told = String(b.messages.at(-3)?.content || b.messages.map((m) => m.content).join(' ')); return ['finish', { summary: '아직 생성 중이에요.' }] },
  ], { query: '?ms=60000' })
  assert.equal(r.state, 'done')
  assert.ok(bodies.flatMap((b) => b.messages || []).some((m) => m.role === 'tool' && /still waiting after/.test(m.content)), told.slice(0, 200))
})
test('기다리는 동안 취소하면 바로 멈춘다', async () => {
  const t0 = Date.now()
  const run = task('취소', [
    (b) => ['click', { i: pick(b, '생성') }],
    ['wait_for_page', { minutes: 5, gone_text: '생성 중' }],
    ['finish', { summary: '끝.' }],
  ], { query: '?ms=600000' })
  await sleep(1500)
  assert.ok(browser.cancel(user))
  const r = await run
  assert.equal(r.state, 'cancelled')
  assert.ok(Date.now() - t0 < 15000, '취소가 바로 듣지 않는다')
})
test('한 작업이 기다릴 수 있는 시간에는 끝이 있다', async () => {
  const keep = browser.WAIT.taskMaxMinutes
  browser.WAIT.taskMaxMinutes = 0
  try {
    await task('한도', [['wait_for_page', { minutes: 5 }], ['finish', { summary: '끝.' }]])
    assert.ok(bodies.flatMap((b) => b.messages || []).some((m) => m.role === 'tool' && /already waited/.test(m.content)))
  } finally { browser.WAIT.taskMaxMinutes = keep }
})
test('계획을 받기 전에 카드가 먼저 뜨고, 받으면 채워진다', async () => {
  slowPlan = { ms: 1500 }
  const running = task('느린 계획', [['finish', { summary: '끝' }]])
  const card = async () => (await rows('task')).filter((m) => m.content.goal === '느린 계획').at(-1)?.content
  for (let i = 0; i < 40 && !await card(); i++) await sleep(25)
  const early = await card()
  assert.ok(early, '카드가 계획 전에 떠야 한다')
  assert.equal(early.title, '느린 계획')
  assert.deepEqual(early.steps, [])
  await running
  slowPlan = null
  assert.deepEqual((await card()).steps.map((s) => s.text), ['하나'])
})

test('계획이 실패해도 일은 한다', async () => {
  slowPlan = { ms: 10, fail: true }
  const out = await task('계획 없이', [['finish', { summary: '계획 없이 끝냈어요' }]])
  slowPlan = null
  assert.notEqual(out.state, 'failed')
})

test('계획을 기다리는 동안 카드에서 취소하면 시작하지 않는다', async () => {
  slowPlan = { ms: 1500 }
  const running = task('곧 취소', [['finish', { summary: '돌면 안 됨' }]])
  let card
  for (let i = 0; i < 40 && !card; i++) { card = (await q(`select id from pro_messages where thread_id=$1 and kind='task' and content->>'goal'='곧 취소'`, [threadId]))[0]; await sleep(25) }
  assert.equal(browser.cancel(user, card.id), true)
  const out = await running
  slowPlan = null
  assert.equal(out.state, 'cancelled')
})

test('모델이 확률을 주지 못하면 규칙으로 삼지 않는다', async () => {
  const { readRoomRule, ruleOf } = await import('../lib/roomRules.js')
  assert.equal(await readRoomRule({ id: user }, threadId, '앞으로 이 방에 올리는 링크는 곧바로 영어로 번역해 줘'), null)
  assert.equal(await ruleOf(user, threadId), null)
})

test('사람이 올린 파일을 사이트의 파일 칸에 넣는다', async () => {
  const file = await saveAttachment({ id: user }, '회의록.pdf', 'application/pdf', Buffer.from('%PDF-1.4 test'))
  const r = await task('파일 넣기', [
    (b) => ['attach_file', { i: pick(b, '파일 고르기'), name: '회의록.pdf' }],
    ['wait_for_page', { minutes: 0.2, until_text: '소스 1개: 회의록.pdf' }],
    ['finish', { summary: '넣었어요.' }],
  ], { files: [file] })
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.ok(bodies.flatMap((b) => b.messages || []).some((m) => m.role === 'tool' && /done: "소스 1개: 회의록\.pdf"/.test(m.content)), '파일이 사이트에 들어가지 않았다')
})
test('올린 파일이 없으면 넣지 못한다고 답한다', async () => {
  await task('없는 파일', [(b) => ['attach_file', { i: pick(b, '파일 고르기') }], ['finish', { summary: '없어요.' }]])
  assert.ok(bodies.flatMap((b) => b.messages || []).some((m) => m.role === 'tool' && /no file was attached/.test(m.content)))
})
test('NotebookLM 일에는 사이트 안내가 모델에게 간다', async () => {
  await task('노트북 lm으로 슬라이드 만들기', [['finish', { summary: '끝.' }], ['finish', { summary: '끝.' }]])
  const sys = bodies.map((b) => b.messages?.[0]?.content).find((c) => typeof c === 'string' && c.includes('Goal: 노트북 lm'))
  assert.match(sys, /Google NotebookLM/)
  assert.match(sys, /never type a Google password/)
})
