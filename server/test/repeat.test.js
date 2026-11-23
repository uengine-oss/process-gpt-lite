// 같은 요청 알아보기의 순수 함수(lib/context/repeat.js) — DB·모델 없이: 후보 단위(보이는 깊이만), 좁히기(턴 0.8·맥락 0.6, 같은 문장 하나로),
// 모델 답 → 카드(맥락마다 하나·최대 2·stale 제외), 카드에 나가는 모양(원문 깊이가 아니면 요청 문장 없음), 「언제」 말.
// 실제 임베딩·모델·시드 회사로 도는 것은 test/repeat.e2e.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, contextText, unitsOf, shortlist, pick, hitOut, PARAMS } from '../lib/context/repeat.js'

const ctx = (o) => ({ id: o.id, owner: o.owner || 'u-me', title: o.title, purpose: o.purpose || '', summary: o.summary || '', prompt_types: o.types || [], depth: o.depth, mine: !!o.mine, owner_name: o.owner_name || '나', updated_at: '2026-10-30T00:00:00Z' })
const turn = (id, prompt, answer = '답', at = '2026-10-31T01:00:00Z') => ({ id, ask_id: `a-${id}`, prompt, answer, at })

test('후보 단위: 원문 깊이는 턴마다, 요약·제목 깊이는 맥락 하나(보이는 글만), 내 맥락에 턴이 없으면 단위 없음', () => {
  const cs = [
    ctx({ id: 'c1', title: '경쟁 서비스 동향', depth: 'content', mine: true }),
    ctx({ id: 'c2', owner: 'u-choi', owner_name: '최유나', title: '경쟁사 가격 벤치마크', purpose: '제안서 부록용 비교', summary: '비밀 요약', types: [{ name: '요금 비교', examples: ['비밀 예문'] }], depth: 'title' }),
    ctx({ id: 'c3', owner: 'u-park', owner_name: '박하늘', title: '가격 정책 조사', purpose: '요금 개편', summary: '해외 SaaS 평균', types: [{ name: '가격 조사', examples: ['비밀 예문'] }], depth: 'summary' }),
    ctx({ id: 'c4', title: '빈 맥락', depth: 'content', mine: true }),
  ]
  const turns = new Map([['u-me:c1', [turn('t1', '경쟁 3사 월 요금 표'), turn('t2', '')]]])
  const u = unitsOf(cs, turns)
  assert.deepEqual(u.map((x) => [x.kind, x.conv, x.text]), [
    ['turn', 'c1', '경쟁 3사 월 요금 표'],
    ['context', 'c2', '경쟁사 가격 벤치마크\n제안서 부록용 비교'],
    ['context', 'c3', '가격 정책 조사\n요금 개편\n해외 SaaS 평균\n가격 조사'],
  ])
  assert.ok(!JSON.stringify(u).includes('비밀 예문'), '요청 유형 예문은 원문 깊이에서만')
  assert.ok(!u.find((x) => x.conv === 'c2').text.includes('비밀 요약'), '제목 깊이는 요약을 보지 않는다')
  // 다시 시켜 보기로 뺀 턴
  assert.equal(unitsOf(cs, turns, { skipTurn: (t) => t.id === 't1' }).filter((x) => x.kind === 'turn').length, 0)
  assert.equal(contextText({ title: 'A', purpose: 'B', depth: 'title', summary: 'S' }), 'A\nB')
})

test('좁히기: 턴은 0.8, 맥락은 0.6 이상 — 같은 맥락의 같은 문장은 하나, 턴 4·맥락 2까지', () => {
  const T = (conv, prompt, score) => ({ kind: 'turn', conv, prompt, text: prompt, score })
  const C = (conv, score) => ({ kind: 'context', conv, text: conv, score })
  const s = shortlist([T('c1', '경쟁 3사 월 요금 표', 0.99), T('c1', '경쟁 3사 월 요금 표!', 0.97), T('c1', '다른 요청', 0.79), T('c2', 'x', 0.81), T('c3', 'y', 0.82), T('c4', 'z', 0.83), T('c5', 'w', 0.84),
    C('k1', 0.61), C('k2', 0.7), C('k3', 0.65), C('k4', 0.59)])
  assert.deepEqual(s.map((x) => `${x.kind}:${x.conv}:${x.score}`), ['turn:c1:0.99', 'turn:c5:0.84', 'turn:c4:0.83', 'turn:c3:0.82', 'context:k2:0.7', 'context:k3:0.65'])
  assert.equal(PARAMS.turnBar, 0.8)
  assert.equal(PARAMS.contextBar, 0.6)
})

test('모델 답 → 카드: same 에서 stale 을 빼고, 맥락마다 하나, 내 것을 조금 먼저, 최대 2', () => {
  const cands = [
    { kind: 'turn', conv: 'c1', owner: 'u-me', mine: true, score: 0.95 },
    { kind: 'turn', conv: 'c1', owner: 'u-me', mine: true, score: 0.9 },
    { kind: 'turn', conv: 'c2', owner: 'u-lee', mine: false, score: 0.955 },
    { kind: 'context', conv: 'c3', owner: 'u-choi', mine: false, score: 0.7 },
    { kind: 'turn', conv: 'c4', owner: 'u-me', mine: true, score: 0.99 },
  ]
  assert.deepEqual(pick(cands, { same: [1, 2, 3, 4, 5], stale: [5] }).map((h) => h.conv), ['c1', 'c2'])
  assert.deepEqual(pick(cands, { same: [4] }).map((h) => h.conv), ['c3'])
  assert.deepEqual(pick(cands, { same: [] }), [])
  assert.deepEqual(pick(cands, null), [])
})

test('카드에 나가는 모양: 원문 깊이 턴만 요청 문장·턴 id, 남의 제목·요약 깊이는 요청하기(원문), 답 본문은 나가지 않는다', () => {
  const t = hitOut({ kind: 'turn', conv: 'c1', title: 'A', owner: 'u', owner_name: '이도윤', mine: false, depth: 'content', at: 'x', turn_id: 't1', prompt: '요청', answer: '긴 답', score: 0.9876 })
  assert.deepEqual([t.prompt, t.turn_id, t.can_request, t.score, t.answer], ['요청', 't1', null, 0.988, undefined])
  const c = hitOut({ kind: 'context', conv: 'c2', title: 'B', owner: 'u2', owner_name: '최유나', mine: false, depth: 'title', at: 'y', text: '제목\n목적', score: 0.7 })
  assert.deepEqual([c.prompt, c.turn_id, c.can_request, c.text], [undefined, undefined, 'content', undefined])
  assert.equal(hitOut({ kind: 'turn', conv: 'c3', mine: true, depth: 'content', score: 1 }).can_request, null)
})

test('언제: 방금 · N분 전 · 오늘 오전/오후 · 어제 · N일 전', () => {
  const now = new Date('2026-11-01T15:00:00+09:00')
  assert.equal(ago(new Date(now - 20e3), now), '방금')
  assert.equal(ago(new Date(now - 25 * 6e4), now), '25분 전')
  assert.match(ago(new Date('2026-11-01T10:12:00+09:00'), now), /^오늘 오전 10:12$/)
  assert.equal(ago(new Date('2026-10-31T15:00:00+09:00'), now), '어제')
  assert.equal(ago(new Date('2026-10-27T15:00:00+09:00'), now), '5일 전')
})
