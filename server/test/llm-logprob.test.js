// 첫 토큰 확률을 받는 호출(lib/llm.js firstTokenTop): 모델마다 다른 거절을 배운다. 실제 OpenAI 응답(2026-11-04)을 흉내 낸 서버로 — 네트워크·DB 없이.
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

let mode = 'luna', seen = []
const refuse = (res, message) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } })) }
const answer = (res, content) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A' }, logprobs: { content } }] })) }
const A = { token: 'A', logprob: Math.log(0.9) }, B = { token: 'B', logprob: Math.log(0.1) }
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const b = JSON.parse(body); seen.push(b)
    if (mode === 'luna') { // gpt-6-luna, gpt-6.1-terra
      if (b.chat_template_kwargs) return refuse(res, 'Unknown parameter: chat_template_kwargs.')
      if (b.max_tokens) return refuse(res, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")
      if (b.reasoning_effort !== 'none') return refuse(res, "Unsupported parameter: 'logprobs' is not supported with this model.")
      if (b.top_logprobs > 5) return refuse(res, "Invalid value for 'top_logprobs': must be less than or equal to 5.")
      if (b.max_completion_tokens < 4) return refuse(res, 'Could not finish the message because max_tokens or model output limit was reached. Please try again with higher max_tokens.')
      return setTimeout(() => answer(res, [{ ...A, top_logprobs: [A, B] }]), 20)
    }
    if (mode === 'astra') { // always reasons: refuses 'none', then refuses log-probabilities
      if (b.reasoning_effort === 'none') return refuse(res, "Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', 'high'.")
      return refuse(res, "Unsupported parameter: 'logprobs' is not supported with this model.")
    }
    if (mode === 'plain') { // gpt-4.1-mini: no reasoning at all
      if (b.reasoning_effort) return refuse(res, 'Unrecognized request argument supplied: reasoning_effort')
      return answer(res, [{ ...A, top_logprobs: [A, B] }])
    }
    if (mode === 'sure') return answer(res, [{ token: 'A', logprob: 0, top_logprobs: [{ token: 'A', logprob: 0 }] }])
    if (mode === 'sampled') return answer(res, [{ ...A, top_logprobs: [] }])
    if (mode === 'none') return answer(res, null)
    res.writeHead(500); res.end('{}')
  })
})
let llm, decide
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
  process.env.PRO_LLM_API_KEY = 'test'
  llm = await import('../lib/llm.js')
  decide = await import('../lib/decide.js')
})
after(() => server.close())
beforeEach(() => { seen = [] })
const OPTIONS = [{ key: 'a', label: '가' }, { key: 'b', label: '나' }]

test('gpt-6-luna 처럼 거절이 여럿이면 하나씩 배워 끝내 받는다', async () => {
  mode = 'luna'
  const r = await llm.firstTokenTop({ prompt: 'q', model: 'cold-1', timeoutMs: 2000 })
  assert.equal(r.top.length, 2)
  const last = seen.at(-1)
  assert.equal(last.reasoning_effort, 'none')
  assert.equal(last.top_logprobs, 5)
  assert.equal(last.max_tokens, undefined)
  assert.ok(last.max_completion_tokens >= 4)
  assert.equal(last.chat_template_kwargs, undefined)
})
test('한 번 배운 뒤에는 한 번에 간다', async () => {
  mode = 'luna'
  await llm.firstTokenTop({ prompt: 'q', model: 'cold-1', timeoutMs: 2000 })
  assert.equal(seen.length, 1)
})
test('서버를 켠 직후 동시에 불러도 모두 받는다(먼저 배운 호출만 재시도하지 않는다)', async () => {
  mode = 'luna'
  const all = await Promise.all(Array.from({ length: 6 }, () => llm.firstTokenTop({ prompt: 'q', model: 'cold-2', timeoutMs: 2000 })))
  assert.ok(all.every((r) => r.top?.length === 2))
})
test('시간 제한은 재시도마다 새로 잡는다', async () => {
  mode = 'luna'
  // 정답 응답에 20 ms 가 걸리고 거절이 여러 번이어도, 한 번의 제한 안에 다 들어가지 않아도 된다
  const r = await llm.firstTokenTop({ prompt: 'q', model: 'cold-3', timeoutMs: 60 })
  assert.equal(r.top.length, 2)
})
test('추론 없는 모델(gpt-4.1-mini)은 reasoning_effort 를 빼고 후보 20개를 그대로 받는다', async () => {
  mode = 'plain'
  const r = await llm.firstTokenTop({ prompt: 'q', model: 'cold-4', timeoutMs: 2000 })
  assert.equal(r.top.length, 2)
  assert.equal(seen.at(-1).reasoning_effort, undefined)
  assert.equal(seen.at(-1).top_logprobs, 20)
})
test('확신하는 모델의 후보 하나는 확률이다', async () => {
  mode = 'sure'
  const r = await llm.firstTokenTop({ prompt: 'q', model: 'cold-5', timeoutMs: 2000 })
  assert.deepEqual(decide.oddsFromTop(r.top, OPTIONS), { a: 1, b: 0 })
})
test('고른 토큰만 오고 후보가 없으면 확률이 아니다(55% 가 100% 로 읽히지 않게)', async () => {
  mode = 'sampled'
  assert.equal((await llm.firstTokenTop({ prompt: 'q', model: 'cold-6', timeoutMs: 2000 })).top, null)
})
test('확률을 주지 않으면 null', async () => {
  mode = 'none'
  assert.equal((await llm.firstTokenTop({ prompt: 'q', model: 'cold-7', timeoutMs: 2000 })).top, null)
})
test('언제나 추론하는 모델(gpt-6-astra): 장애가 아니라 확률을 주지 않는 모델로 분류한다', async () => {
  mode = 'astra'
  await assert.rejects(llm.firstTokenTop({ prompt: 'q', model: 'cold-8', timeoutMs: 2000 }), /logprobs/)
  const refused = seen.filter((b) => b.reasoning_effort === 'none').length
  assert.equal(refused, 1)
})
