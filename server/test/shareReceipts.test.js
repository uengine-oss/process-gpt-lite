// 내가 보낸 공유 카드의 받은 사람별 줄(2026-11-26 사용자 휴대폰 화면: 「… 아직 그대로」 — 「아직그대로는 뭔가? 혹시 확인여부 ㅡ 파일을
// 열어서 봤는지라면 좋은데 ○○○께서 열어보셨다는데 아직그대로로 표시된」). src/shareReceipts.js: 사본이 바뀌었으면 무엇을 고쳤는지, 아니면 열어
// 봤는지(처음 연 때), 아니면 「안 열어 봄」 — 「아직 그대로」는 더 없다. 화면 없이. 사람 이름은 지어낸 것이다.
//   SR-U-01 안 열어 봄 · SR-U-02 열어 봄 · 처음 연 때 · SR-U-03 파일 몇 개 중 몇 개 · SR-U-04 사본이 바뀌면 고친 내용이 먼저
//   SR-U-05 갈래가 있어도 바뀌지 않았으면 열어 봤는지로 · SR-U-06 마지막으로 연 때 힌트 · SR-U-07 「아직 그대로」라는 말은 나오지 않는다
import test from 'node:test'
import assert from 'node:assert/strict'
import { receiptOf, receiptHint } from '../../src/shareReceipts.js'

const when = (d) => `@${new Date(d).toISOString().slice(11, 16)}`
const T1 = '2026-11-26T05:20:00.000Z', T2 = '2026-11-26T06:45:00.000Z'
const branch = (b = {}) => ({ room: 'pro:x', added: [], modified: [], removed: [], at: null, by: null, ...b })

test('SR-U-01 아직 열지 않은 사람: 「안 열어 봄」', () => {
  assert.deepEqual(receiptOf({ id: 'a', name: '한서윤', files: 1, opened: 0, openedAt: null }, when), { state: 'unopened', text: '안 열어 봄' })
  assert.deepEqual(receiptOf({}, when), { state: 'unopened', text: '안 열어 봄' })
  assert.deepEqual(receiptOf(null, when), { state: 'unopened', text: '안 열어 봄' })
})

test('SR-U-02 연 사람: 「열어 봄 · 처음 연 때」', () => {
  assert.deepEqual(receiptOf({ files: 1, opened: 1, openedAt: T1, lastOpenedAt: T2 }, when), { state: 'opened', text: '열어 봄 · @05:20' })
  // a count without a time is not an open (a row being written)
  assert.equal(receiptOf({ files: 1, opened: 1, openedAt: null }, when).state, 'unopened')
})

test('SR-U-03 파일이 여럿이면: 모두 열었으면 「열어 봄」, 일부만 열었으면 「파일 3개 중 1개 열어 봄」', () => {
  assert.equal(receiptOf({ files: 3, opened: 3, openedAt: T1 }, when).text, '열어 봄 · @05:20')
  assert.equal(receiptOf({ files: 3, opened: 1, openedAt: T1 }, when).text, '파일 3개 중 1개 열어 봄 · @05:20')
})

test('SR-U-04 사본을 고쳤으면 고친 내용과 그때가 먼저(전에 보이던 그대로)', () => {
  const r = { files: 2, opened: 1, openedAt: T1, branch: branch({ modified: ['견적.xlsx', '표지.docx'], added: ['메모.md'], at: T2, by: 'person' }) }
  assert.deepEqual(receiptOf(r, when), { state: 'changed', text: '2개 고침 · 1개 추가 · @06:45' })
  assert.equal(receiptOf({ branch: branch({ removed: ['옛 초안.docx'], at: T2 }) }, when).text, '1개 지움 · @06:45')
})

test('SR-U-05 갈래가 있어도 아직 바뀌지 않았으면 열어 봤는지로 말한다', () => {
  assert.deepEqual(receiptOf({ files: 1, opened: 0, branch: branch() }, when), { state: 'unopened', text: '안 열어 봄' })
  assert.deepEqual(receiptOf({ files: 1, opened: 1, openedAt: T1, branch: branch() }, when), { state: 'opened', text: '열어 봄 · @05:20' })
})

test('SR-U-06 힌트: 처음 뒤에 다시 열었으면 마지막으로 연 때', () => {
  assert.equal(receiptHint({ openedAt: T1, lastOpenedAt: T2 }, when), '마지막으로 연 때 @06:45')
  assert.equal(receiptHint({ openedAt: T1, lastOpenedAt: T1 }, when), '')
  assert.equal(receiptHint({ openedAt: null, lastOpenedAt: null }, when), '')
})

test('SR-U-07 「아직 그대로」라는 말은 어떤 경우에도 나오지 않는다', () => {
  const cases = [{}, { files: 1, opened: 0 }, { files: 1, opened: 0, branch: branch() }, { files: 2, opened: 1, openedAt: T1, branch: branch({ at: T2 }) }]
  for (const r of cases) assert.doesNotMatch(receiptOf(r, when).text, /그대로/)
})
