// 운영 전 막힌 곳(검토 지적): 파이썬 없는 서버의 문서 읽기 · 없는 enum 값 · 오래 걸리는 JSON 답(524) · 임베딩 없음 · 시나리오 정책 — DB · 모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

process.env.PRO_EMBED_URL = ''

test('문서 읽기: 파이썬이 없으면 글 문서만 Node 로, 다른 형식은 깔끔한 오류(서버는 살아 있다)', async () => {
  const D = await import('../lib/ontology/documents.js')
  assert.equal(D.readerFor('pdf', { python: true }), 'python')
  assert.equal(D.readerFor('txt', { python: false }), 'node')
  assert.equal(D.readerFor('md', { python: false }), 'node')
  assert.equal(D.readerFor('csv', { python: false }), 'node')
  assert.equal(D.readerFor('pdf', { python: false }), null)
  assert.equal(D.readerFor('hwpx', { python: false }), null)
  const e = D.readerUnavailable('pdf')
  assert.equal(e.code, 'DOC_READER_UNAVAILABLE')
  assert.match(e.message, /이 서버에서는 이 형식의 문서를 읽을 수 없어요/)
  // a python that is not there: rejected as unavailable, no unhandled 'error' event
  await assert.rejects(D.readWithPdf2bpmn(['가'.repeat(100000)], {}, null, { python: '/nonexistent/venv/bin/python' }), (x) => x.code === 'DOC_READER_UNAVAILABLE')
})

test('Node 문서 읽기: PDF2BPMN 의 앞 내용 틀(기존 프로세스 · 역할 · 일)', async () => {
  const R = await import('../lib/ontology/docreader.js')
  assert.equal(R.contextOf(), '')
  const c = R.contextOf(['견적 업무'], ['영업'], [{ name: '견적서 작성', role: '영업', process: '견적 업무' }])
  assert.match(c, /기존 프로세스 목록[\s\S]*- 견적 업무/)
  assert.match(c, /- 견적서 작성 \(담당: 영업\) \[프로세스: 견적 업무\]/)
  assert.ok(R.EXTRACTION_PROMPT.includes('{existing_context}') && R.EXTRACTION_PROMPT.includes('TEXT TO ANALYZE:'))
  assert.ok(!/\{\{|\}\}/.test(R.EXTRACTION_PROMPT))
})

test('CANCELLED 없는 todo_status: 취소 표시가 있는 DONE 을 CANCELLED 로 읽는다', async () => {
  const E = await import('../lib/enums.js')
  assert.equal(E.statusOf({ status: 'DONE', output: { lite_cancelled: true } }), 'CANCELLED')
  assert.equal(E.statusOf({ status: 'DONE', output: { form: { result: 'x' } } }), 'DONE')
  assert.equal(E.statusOf({ status: 'IN_PROGRESS', output: null }), 'IN_PROGRESS')
  assert.match(E.statusSql('t.'), /t\.status::text = 'DONE' and coalesce\(t\.output \? 'lite_cancelled', false\) then 'CANCELLED'/)
  assert.equal(E.notCancelledSql(), "not coalesce(output ? 'lite_cancelled', false)")
  await assert.rejects(E.enumHas('todo_status; drop table x', 'A'))
})

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      // the bits of Express a route's answer uses
      res.status = (c) => { res.statusCode = c; return res }
      res.json = (b) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)) }
      res.set = (k, v) => { res.setHeader(k, v); return res }
      handler(req, res)
    }).listen(0, () => resolve(s))
  })
}
const get = (s) => fetch(`http://127.0.0.1:${s.address().port}/`)

test('오래 걸리는 JSON 답: 빨리 끝나면 그대로, 늦으면 200 을 먼저 보내고 공백 · 본문(오류는 {error, status})', async () => {
  const { longJson, LONG_HEADER } = await import('../lib/longJson.js')
  const wait = (ms, v, fail) => new Promise((ok, no) => setTimeout(() => (fail ? no(Object.assign(new Error(v), { status: 409 })) : ok(v)), ms))
  let s = await serve((req, res) => longJson(res, () => wait(5, { a: 1 }), { quiet: 200 }))
  let r = await get(s)
  assert.equal(r.status, 200); assert.equal(r.headers.get(LONG_HEADER), null); assert.deepEqual(await r.json(), { a: 1 })
  s.close()
  s = await serve((req, res) => longJson(res, () => wait(5, '안 돼요', true), { quiet: 200 }))
  r = await get(s)
  assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: '안 돼요' })
  s.close()
  s = await serve((req, res) => longJson(res, () => wait(350, { plan: [1, 2] }), { quiet: 50, every: 100 }))
  r = await get(s)
  assert.equal(r.status, 200); assert.equal(r.headers.get(LONG_HEADER), '1')
  const t = await r.text()
  assert.match(t, /^ +\{/)
  assert.deepEqual(JSON.parse(t), { plan: [1, 2] })
  s.close()
  s = await serve((req, res) => longJson(res, () => wait(150, '관리자만 할 수 있어요.', true), { quiet: 50 }))
  r = await get(s)
  assert.equal(r.status, 200)
  assert.deepEqual(JSON.parse(await r.text()), { error: '관리자만 할 수 있어요.', status: 409 })
  s.close()
})

test("임베딩 없음(PRO_EMBED_URL=''): 자동 참고 · 같은 요청 알아보기는 기다리지 않고 행도 남기지 않는다", async () => {
  const E = await import('../lib/context/embed.js')
  assert.equal(E.EMBED_URL, '')
  assert.equal(E.embeddingsOn(), false)
  await assert.rejects(E.vectors(['a']), (e) => e.code === 'EMBED_UNAVAILABLE')
  const R = await import('../lib/context/refer.js')
  const t0 = Date.now()
  const r = await R.refer({ id: '00000000-0000-0000-0000-000000000000' }, { message: '견적서 보내 줘' })
  assert.equal(r.refer_id, null); assert.equal(r.skipped, 'no-embeddings'); assert.equal(r.context, '')
  const P = await import('../lib/context/repeat.js')
  assert.equal(await P.findRepeat({ id: 'x' }, { threadId: null, message: '견적서 보내 줘' }), null)
  assert.ok(Date.now() - t0 < 200)
})

test('시나리오 정책: 팀 맥락 참고(context.access)만 시나리오와 상관없다', async () => {
  const { isScenarioPolicy } = await import('../lib/policy/pdp.js')
  const { CATALOG } = await import('../lib/policy/catalog.js')
  const kept = CATALOG.filter((s) => !isScenarioPolicy(s)).map((s) => s.id)
  assert.ok(kept.length >= 3 && kept.every((id) => id.startsWith('context-')))
  assert.ok(isScenarioPolicy(CATALOG.find((s) => s.id === 'mail-external')))
})
