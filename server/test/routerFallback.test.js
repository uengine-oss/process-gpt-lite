// 메인 채팅의 턴은 대화 맥락 라우터를 거친다. 라우터가 없거나(연결 거절) 답을 시작하기 전에 실패하면(5xx)
// 그 턴은 에이전트로 바로 간다 — 라우터 때문에 채팅이 멈추지 않는다. 에이전트가 거절한 것(4xx)은 다시 보내지 않는다.
// (lib/agent.js openTurn; 모델 · DB 없이)
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.PRO_CONTEXT_ROUTER_URL = 'http://router.test'
const { openTurn } = await import('../lib/agent.js')

const ok = (body = 'data: {}\n\n') => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
const status = (n, body = '') => new Response(body, { status: n })
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

// request(viaRouter) as streamTurn builds it: each attempt is recorded with where it went
function agents({ router, direct = () => ok('direct') }) {
  const calls = []
  const request = async (viaRouter) => () => { calls.push(viaRouter ? 'router' : 'direct'); return (viaRouter ? router : direct)() }
  return { calls, request }
}

test('라우터가 답하면 그 스트림을 쓰고, 에이전트를 따로 부르지 않는다', async () => {
  const a = agents({ router: async () => ok('routed') })
  const { res, routed } = await openTurn({ routed: true, request: a.request })
  assert.equal(routed, true)
  assert.equal(await res.text(), 'routed')
  assert.deepEqual(a.calls, ['router'])
})

test('라우터에 연결하지 못하면 에이전트로 바로 간다(라우팅 없이)', async () => {
  const a = agents({ router: async () => { throw refused() } })
  const { res, routed } = await openTurn({ routed: true, request: a.request })
  assert.equal(routed, false)
  assert.equal(await res.text(), 'direct')
  assert.deepEqual(a.calls, ['router', 'direct'])
})

test('라우터가 답을 시작하기 전에 5xx 면 에이전트로 바로 간다', async () => {
  for (const n of [500, 502, 503]) {
    const a = agents({ router: async () => status(n, JSON.stringify({ error: 'no decision strategy could answer' })) })
    const { res, routed } = await openTurn({ routed: true, request: a.request })
    assert.equal(routed, false, `${n}`)
    assert.equal(await res.text(), 'direct')
    assert.deepEqual(a.calls, ['router', 'direct'])
  }
})

test('에이전트가 거절한 것(4xx)은 라우터가 넘긴 그대로 돌려주고, 다시 보내지 않는다', async () => {
  const a = agents({ router: async () => status(401, JSON.stringify({ detail: 'invalid token' })) })
  const { res, routed } = await openTurn({ routed: true, request: a.request })
  assert.equal(res.status, 401)
  assert.equal(routed, true)
  assert.deepEqual(a.calls, ['router'])
})

test('멈춘 턴(사용자 멈추기 · 응답 없음)은 에이전트로 다시 보내지 않는다', async () => {
  const a = agents({ router: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) } })
  await assert.rejects(openTurn({ routed: true, request: a.request, stopped: () => true }), /aborted/)
  assert.deepEqual(a.calls, ['router'])
})

test('라우팅하지 않는 턴은 처음부터 에이전트로, 잠깐 안 되면 다시 시도한다', async () => {
  let n = 0
  const a = agents({ router: async () => ok('routed'), direct: async () => (++n === 1 ? status(503) : ok('direct')) })
  const { res, routed } = await openTurn({ routed: false, request: a.request, waits: [0] })
  assert.equal(routed, false)
  assert.equal(await res.text(), 'direct')
  assert.deepEqual(a.calls, ['direct', 'direct'])
})

test('라우터도 에이전트도 연결되지 않으면 에이전트의 연결 오류로 끝난다', async () => {
  const a = agents({ router: async () => { throw refused() }, direct: async () => { throw refused() } })
  await assert.rejects(openTurn({ routed: true, request: a.request, waits: [0] }), /fetch failed/)
  assert.deepEqual(a.calls, ['router', 'direct', 'direct'])
})
