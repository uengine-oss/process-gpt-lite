// 튜토리얼 결함 수정(2026-10-27) 중 모델·DB 없이 확인되는 것:
//   - 패널 앱 숫자 칸: "3,800만 원" 같은 한국어 금액, 띄어쓰기 없는 머리글("견적금액")
//   - 미션: 결과 줄(MISSION_RESULT)이 없는 정상 실행은 성공(변동 여부 모름), 오류·빈 답은 실패
//   - 에이전트 단계 재시도: 잠깐의 오류(DB 복구 모드·연결 끊김·시간 초과)만 자동 재시도
//   - 패널 설계: 한 번에 설계하는 호출이 시간 초과면 작은 단계(종류 → 그 종류의 모양)로 다시
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// a model that answers the one-call design too slowly, and the smaller steps at once
const seen = []
let slowFirst = true
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    const sys = body.messages[0].content
    const kind = sys.startsWith('패널 앱 요청을 분류한다') ? 'kind' : sys.includes('기록형(이벤트 소싱) 업무 앱을 설계한다') ? 'events' : 'full'
    seen.push({ kind, max_tokens: body.max_tokens })
    const answer = kind === 'kind' ? { kind: 'events' }
      : { kind: 'events', title: '2호점 공사 예산 장부', icon: '💰', description: '예산 배정·지출·지출 취소를 기록으로',
        entity: { key: 'trade', label: '공종', type: 'text' },
        fields: [{ key: 'amount', label: '금액', type: 'number', sensitivity: 'internal' }, { key: 'memo', label: '메모', type: 'text', sensitivity: 'internal' }],
        events: [{ type: 'budget', label: '예산 배정', fields: ['amount', 'memo'], required: ['amount'], manager: true },
          { type: 'spend', label: '지출', fields: ['amount', 'memo'], required: ['amount'] },
          { type: 'cancel', label: '지출 취소', fields: [], ref: { types: ['spend'], mode: 'cancel', inherit: ['amount'] } }],
        projections: [{ kind: 'balance', key: 'summary', label: '요약', columns: [
          { key: 'budget', label: '예산', terms: [{ event: 'budget', field: 'amount', op: 'sum', sign: 1 }] },
          { key: 'spent', label: '지출', terms: [{ event: 'spend', field: 'amount', op: 'sum', sign: 1 }, { event: 'cancel', field: 'amount', op: 'sum', sign: -1 }] }],
        computed: [{ key: 'left', label: '잔액', expr: 'budget - spent' }] }],
        views: { main: 'summary', value: 'left', valueSuffix: '원' } }
    const send = () => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }] })) } }
    if (kind === 'full' && slowFirst) setTimeout(send, 1500)
    else send()
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llm.address().port}`
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_PANEL_DESIGN_MS = '400'
// no database is touched here; the client only needs a key to be made (a checkout without process-gpt/.env)
process.env.SERVICE_ROLE_KEY ||= 'test'

const X = await import('../lib/panelApps/sheet.js')
const M = await import('../lib/missions.js')
const R = await import('../lib/stepRetry.js')
const P = await import('../lib/panelApps/service.js')
const C = await import('../mcp/craft.js')

after(() => llm.close())
before(() => { seen.length = 0 })

test('패널 숫자: 한국어 금액 단위와 쉼표·원', () => {
  const cases = { '3,800만 원': 38000000, '38,000,000원': 38000000, '1억 2천만 원': 120000000, '3천8백만': 38000000, '1.5억': 150000000,
    '약 5천 원': 5000, '1억5000만원': 150000000, '15일': 15, '12%': 12, '-3만': -30000, '2,500': 2500 }
  for (const [k, v] of Object.entries(cases)) assert.equal(X.parseKoNumber(k), v, k)
  for (const bad of ['abc', '3만x', '', '만만한']) assert.ok(Number.isNaN(X.parseKoNumber(bad)), bad)
})

test('패널 검증: "견적금액: 3,800만 원" 이 숫자 칸 "견적 금액" 에 들어감, 숫자가 아니면 거절', () => {
  const def = X.normalizeDef({ title: '견적 현황판', sheet: '견적', fields: [
    { key: 'customer', label: '고객사', type: 'text', required: true }, { key: 'amount', label: '견적 금액', type: 'number', required: true }] })
  assert.deepEqual(X.validate(def, { 고객사: '해솔베이커리', 견적금액: '3,800만 원' }), { customer: '해솔베이커리', amount: 38000000 })
  assert.equal(X.validate(def, { customer: '해솔베이커리', amount: '1억 2천만원' }).amount, 120000000)
  assert.throws(() => X.validate(def, { customer: '해솔', amount: '많이' }), /숫자로 적어 주세요/)
})

test('미션 결과: 결과 줄이 없어도 정상으로 끝나면 성공(요약은 경로가 아닌 마지막 문장), 오류·빈 답은 실패', () => {
  assert.deepEqual(M.parseResult('끝났어요.\nMISSION_RESULT: {"changed": true, "summary": "새 견적 1건"}'), { changed: true, summary: '새 견적 1건' })
  assert.equal(M.parseResult('점검표를 만들었어요.'), null)
  assert.deepEqual(M.outcomeOf('점검표를 만들었어요.\n요약을 저장했어요.\n/workspace/quote-check/summary.md'), { ok: true, summary: '요약을 저장했어요.' })
  assert.equal(M.outcomeOf('(오류: the database system is in recovery mode)').ok, false)
  assert.match(M.outcomeOf('(오류: the database system is in recovery mode)').summary, /recovery mode/)
  assert.equal(M.outcomeOf('').ok, false)
  // a long answer that mentions an error along the way still finished
  assert.equal(M.outcomeOf(`견적서 3건을 확인했어요. 단가 누락 1건을 표시했어요.\n(오류: 한 파일은 열지 못함)\n${'가'.repeat(60)}`).ok, true)
  assert.match(M.RESULT_LINE, /MISSION_RESULT/)
})

test('에이전트 단계 재시도: 잠깐의 오류만 자동으로', () => {
  for (const t of ['OperationalError: the database system is in recovery mode', 'psycopg.OperationalError: connection refused', 'httpx.ReadTimeout: timed out',
    'StreamChunkTimeoutError: No streaming chunk received for 120.0s', 'APIConnectionError: Connection error.', 'Error: 502 Bad Gateway', '', null]) assert.equal(R.isTransient(t), true, String(t))
  for (const t of ['ExecutorReturnedWithoutResult: 실행이 결과 아티팩트나 실패 보고 없이 끝났다', 'ValueError: form field amount missing', 'KeyError: activity_id']) assert.equal(R.isTransient(t), false, t)
})

test('패널 설계: 한 번에 설계가 시간 초과면 작은 단계(종류 → 기록형 모양)로 만든다', async () => {
  slowFirst = true
  seen.length = 0
  const d = await P.design('2호점 공사 예산 장부 패널을 만들어 줘. 예산 배정·지출·지출 취소를 기록으로 쌓고 잔액은 기록에서 계산해 줘.')
  assert.equal(d.kind, 'data')
  assert.equal(d.def.kind, 'events')
  assert.deepEqual(seen.map((x) => x.kind), ['full', 'kind', 'events'])
  assert.ok(seen.every((x) => x.max_tokens > 0), '모든 설계 호출에 토큰 상한')
  assert.equal(d.def.events.length, 3)
})

test('패널 설계: 작은 단계도 시간 초과면 알아듣는 말로(503)', async () => {
  slowFirst = true
  process.env.PRO_PANEL_DESIGN_MS = '50'
  // every call now outlasts the limit: the one-call design and the events step are slow
  const orig = llm.listeners('request')[0]
  llm.removeAllListeners('request')
  llm.on('request', (req, res) => { req.resume(); setTimeout(() => { if (!res.destroyed) { res.writeHead(200); res.end('{"choices":[{"message":{"content":"{\\"kind\\":\\"events\\"}"}}]}') } }, 300) })
  try {
    await assert.rejects(P.design('예산 장부 패널'), (e) => e.status === 503 && /시간 초과/.test(e.message))
  } finally {
    llm.removeAllListeners('request'); llm.on('request', orig)
    process.env.PRO_PANEL_DESIGN_MS = '400'
  }
})

test('도면 글자: CADCraft 웹 글꼴에 없는 ㎡·㎥ 는 m²·m³ 로(경로는 그대로)', () => {
  assert.deepEqual(C.plainUnits({ text: '홀 54㎡', items: ['창고 6.5㎡', '물탱크 2㎥'], at: [1, 2], path: '/workspace/a.dxf' }),
    { text: '홀 54m²', items: ['창고 6.5m²', '물탱크 2m³'], at: [1, 2], path: '/workspace/a.dxf' })
})
