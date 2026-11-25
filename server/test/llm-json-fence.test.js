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
    const b = JSON.parse(body)
    seen.push(b)
    // Claude 5.5 through a proxy that does not drop it (LiteLLM without additional_drop_params): the answer as observed 2026-11-25
    if (b.model === 'claude-like' && b.temperature !== undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'litellm.BadRequestError: AnthropicException - {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}', type: 'invalid_request_error' } }))
    }
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

// 설치판(Docker Compose)에서도 확률 모델을 따로 둘 수 있다: .env 의 LLM_ODDS_MODEL → 서버의 PRO_LLM_ODDS_MODEL.
test('JF-U-06 설치 번들: LLM_ODDS_MODEL 이 서버 환경의 PRO_LLM_ODDS_MODEL 로 가고(비면 빈 값 = 주 모델) .env 예시에 있다', async () => {
  const fs = await import('node:fs/promises')
  const root = new URL('../../install/', import.meta.url)
  const compose = await fs.readFile(new URL('docker-compose.yml', root), 'utf8')
  const lines = compose.split('\n').map((l) => l.trim())
  assert.ok(lines.includes('PRO_LLM_ODDS_MODEL: ${LLM_ODDS_MODEL:-}'), 'server env maps LLM_ODDS_MODEL')
  assert.equal(lines.filter((l) => l.startsWith('PRO_LLM_ODDS_MODEL:')).length, 1)
  const env = await fs.readFile(new URL('.env.example', root), 'utf8')
  assert.ok(env.split('\n').some((l) => l.trim() === 'LLM_ODDS_MODEL='), '.env.example lists LLM_ODDS_MODEL (empty)')
})

test('JF-U-07 Claude 처럼 temperature 를 「deprecated」 로 거절하면 빼고 다시 보내고, 다음부터는 처음부터 뺀다', async () => {
  reply = '{"ok": true}'
  seen.length = 0
  const r = await llm.chatJson('s', 'u', { model: 'claude-like', temperature: 0 })
  assert.deepEqual(r, { ok: true })
  assert.equal(seen.length, 2)
  assert.equal(seen[0].temperature, 0)
  assert.equal(seen[1].temperature, undefined)
  seen.length = 0
  await llm.chatJson('s', 'u', { model: 'claude-like', temperature: 0 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].temperature, undefined)
})
