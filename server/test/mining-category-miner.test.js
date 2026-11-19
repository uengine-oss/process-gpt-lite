// 업무 범주 판단은 process-miner 한 곳의 규칙이다 (2026-11-12, general-intent-grouping).
// Lite 는 사례 정보(메일 제목·고객·문서·단계)를 만들어 POST /categories 로 보내고, 답을 저장만 한다.
// 자기 프롬프트로 모델을 부르지 않는다 — 규칙을 한 곳에서 고치면 ProcessGPT 식별 화면과 함께 바뀐다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { categoriesOf } from '../lib/mining/service.js'
import { withLang } from '../lib/lang.js'

function stubFetch(answer) {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    if (typeof answer === 'function') return answer(url, init)
    return new Response(JSON.stringify(answer), { status: 200 })
  }
  return { calls, restore: () => { globalThis.fetch = orig } }
}

const CASES = [
  { id: 'c1', subject: '송년회 견적 요청', customer: '가나상사', documents: ['견적서'], steps: ['요청 메일 접수', '견적서 작성', '고객 회신'] },
  { id: 'c2', subject: '워크숍 견적 부탁', customer: '다라전자', documents: [], steps: ['요청 메일 접수', '견적서 작성', '고객 회신'] },
]

test('범주 판단은 마이너의 POST /categories 로 한다 (모델을 직접 부르지 않는다)', async () => {
  const f = stubFetch({ categories: { c1: '행사 견적', c2: '행사 견적' } })
  try {
    const got = await withLang('ko', () => categoriesOf(CASES, ['매장 설계'], 'ko', [{ subject: '북토크 견적', category: '행사 견적' }]))
    assert.deepEqual(got, { c1: '행사 견적', c2: '행사 견적' })
    assert.equal(f.calls.length, 1, '한 번에 함께 판단한다')
    assert.match(f.calls[0].url, /\/categories$/)
    const body = f.calls[0].body
    assert.ok(body.tenant_id, '테넌트를 싣는다')
    assert.equal(body.lang, 'ko')
    assert.deepEqual(body.known, ['매장 설계'])
    assert.deepEqual(body.examples, [{ request: '북토크 견적', category: '행사 견적' }])
    assert.deepEqual(body.cases.map((c) => [c.id, c.request, c.customer]), [['c1', '송년회 견적 요청', '가나상사'], ['c2', '워크숍 견적 부탁', '다라전자']])
    assert.deepEqual(body.cases[0].steps, CASES[0].steps)
  } finally { f.restore() }
})

test('새 메일의 요청 본문도 함께 보낸다 (다음 메일 범주)', async () => {
  const f = stubFetch({ categories: { mail: '행사 견적' } })
  try {
    await withLang('ko', () => categoriesOf([{ id: 'mail', subject: '견적 요청', request: '창립 기념식 견적 부탁드립니다', steps: [] }], [], 'ko'))
    assert.equal(f.calls[0].body.cases[0].request, '견적 요청\n창립 기념식 견적 부탁드립니다')
  } finally { f.restore() }
})

test('마이너가 실패하면 범주 없이 돌아온다 (사례는 확인 필요로 남는다)', async () => {
  const f = stubFetch(() => new Response('boom', { status: 500 }))
  try {
    assert.deepEqual(await withLang('ko', () => categoriesOf(CASES, [], 'ko')), {})
  } finally { f.restore() }
})

test('영어 사용자는 영어 범주를 요청한다', async () => {
  const f = stubFetch({ categories: { c1: 'Event quote' } })
  try {
    await withLang('en', () => categoriesOf(CASES.slice(0, 1), [], 'en'))
    assert.equal(f.calls[0].body.lang, 'en')
  } finally { f.restore() }
})

// 추천 이름은 업무 범주다 (2026-11-12). 단계에서 지으면 하는 일이 전혀 다른 두 추천이
// '요청 메일·견적서 작성'(교육 일정표) · '요청 접수·견적 회신'(사무실 이전 견적)처럼 비슷해졌다.
import { nameFor } from '../lib/mining/service.js'

test('추천 이름은 업무 범주이고, 단계 이름에서 짓지 않는다', () => {
  const steps = ['요청 메일 접수', '견적서 작성', '고객 회신']
  const a = withLang('ko', () => nameFor({ category: '교육 일정표', main_variant: steps }))
  const b = withLang('ko', () => nameFor({ category: '사무실 이전 견적', main_variant: steps }))
  assert.equal(a, '교육 일정표')
  assert.equal(b, '사무실 이전 견적')
  assert.notEqual(a, b, '단계가 같아도 하는 일이 다르면 이름이 다르다')
})

test('범주가 없던 예전 묶음만 첫 단계로 이름을 짓는다', () => {
  assert.equal(withLang('ko', () => nameFor({ main_variant: ['요청 메일 접수', '견적서 작성'] })), '요청 메일 접수 이후 반복 흐름')
})
