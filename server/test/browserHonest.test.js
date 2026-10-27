// 브라우저 작업이 아무것도 안 하고 "완료"라 하지 않게, 요약은 실제로 한 일만 (tutorial-findings #28).
// lib/browser.js honest() — 브라우저·모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { honest } from '../lib/browser.js'

const task = (log = [], notes = []) => ({ log, notes, steps: ['상점 열기', '이어폰 담기', '결제 정보 입력', '승인 받기', '결제'] })

test('도구를 한 번도 안 쓰고 끝낸 작업은 "확인 필요", 하지 않은 일을 말하지 않음', () => {
  const r = honest({ state: 'done', summary: '결제 입력 단계(카드 소유자, 카드 번호, 만료일, CVC)까지 진행한 뒤 멈췄습니다' }, task())
  assert.equal(r.state, 'needs_review')
  assert.doesNotMatch(r.summary, /카드 소유자/)
  assert.match(r.summary, /아무 동작도 하지 못한/)
  assert.match(r.summary, /1\. 상점 열기/)
})

test('실제로 한 일은 기록에서: 거절된 입력은 빼고, 승인 요청은 결과와 함께', () => {
  const log = [
    { kind: 'goto', text: 'shop.example 열기', ok: true },
    { kind: 'click', text: "'무선 이어폰' 누르기", ok: true },
    { kind: 'type', text: "'카드 번호'에 입력", ok: false },
    { kind: 'fill_secret', text: '보관함의 카드 번호 입력', ok: true },
    { kind: 'approve', text: '승인 요청: 39,000원 결제 → 승인됨', ok: true },
  ]
  const r = honest({ state: 'done', summary: '주문을 마쳤어요. 주문번호 A-1023.' }, task(log))
  assert.equal(r.state, 'done')
  assert.match(r.summary, /^주문을 마쳤어요/)
  assert.match(r.summary, /실제로 한 일\n• shop\.example 열기\n• '무선 이어폰' 누르기\n• 보관함의 카드 번호 입력\n• 승인 요청/)
  assert.doesNotMatch(r.summary, /'카드 번호'에 입력/)
})

test('페이지를 읽고 사실만 기록한 작업은 완료(요약이 비면 기록한 사실로)', () => {
  const r = honest({ state: 'done', summary: '' }, task([], ['잔액 1,234,000원']))
  assert.equal(r.state, 'done')
  assert.match(r.summary, /잔액 1,234,000원/)
  assert.equal(honest({ state: 'done', summary: '' }, task([]), { moved: true }).state, 'done', '페이지가 바뀌었으면 진행이 있었음')
})

test('취소·실패는 그대로', () => {
  assert.deepEqual(honest({ state: 'cancelled', summary: '작업을 취소했어요.' }, task()), { state: 'cancelled', summary: '작업을 취소했어요.' })
  assert.equal(honest({ state: 'failed', summary: 'x' }, task()).state, 'failed')
})
