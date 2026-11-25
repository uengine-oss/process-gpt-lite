// JSON 답(response_format json_object)이 ```json 울타리에 싸여 와도 읽는다(lib/jsonReply.js · lib/llm.js chat).
// Claude 5.5 는 스키마 없는 json_object 에 대응하는 것이 없어 프롬프트에 따라 울타리로 감싼다(운영 측정 2026-11-25:
// "Answer as JSON {…}" 5/5). 실제 응답 모양을 흉내 낸 서버로 — 네트워크 · DB 없이.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import cases from './json-fence-cases.json' with { type: 'json' }

let reply = ''
const seen = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    seen.push(JSON.parse(body))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }))
  })
})
let llm, J
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
  process.env.PRO_LLM_API_KEY = 'test'
  llm = await import('../lib/llm.js')
  J = await import('../lib/jsonReply.js')
})
after(() => server.close())

test('JF-U-01 사례표: 울타리 하나뿐이고 안이 JSON 일 때만 벗긴다', () => {
  assert.ok(cases.length >= 10)
  for (const c of cases) assert.equal(J.unfenceJson(c.text), c.json, c.why)
})

test('JF-U-02 chatJson: Claude 처럼 울타리로 답해도 객체를 돌려준다', async () => {
  reply = '```json\n{"topic": "견적서 요청", "urgent": true}\n```'
  const r = await llm.chatJson('Classify. Answer as JSON {"topic": string, "urgent": boolean}.', '내일까지 견적서 보내 주세요.')
  assert.deepEqual(r, { topic: '견적서 요청', urgent: true })
  assert.deepEqual(seen.at(-1).response_format, { type: 'json_object' })
})

test('JF-U-03 chat({json:true}) 를 직접 JSON.parse 하는 호출(폴더 색인 · 브라우저 계획 등)도 읽힌다', async () => {
  reply = '```\n{"cases": [1, 2]}\n```'
  const m = await llm.chat({ messages: [{ role: 'user', content: 'q' }], json: true })
  assert.deepEqual(JSON.parse(m.content), { cases: [1, 2] })
  assert.equal(m.finish, 'stop')
})

test('JF-U-04 JSON 을 청하지 않은 답의 울타리는 그대로 둔다(코드를 보여 달라는 대화)', async () => {
  reply = '```json\n{"a": 1}\n```'
  const m = await llm.chat({ messages: [{ role: 'user', content: '예시 JSON 을 코드 블록으로' }] })
  assert.equal(m.content, reply)
})

test('JF-U-05 울타리 안이 깨졌으면 지금처럼 「JSON 이 아니다」로 실패한다', async () => {
  reply = '```json\n{"topic": \n```'
  await assert.rejects(llm.chatJson('s', 'u'), /not JSON/)
})
