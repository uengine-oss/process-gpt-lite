// The browser task's closing call carries the facts recorded with note (lib/browser.js closingNotes): the page text they
// came from is no longer in the history, and a model without them may disown its own notes.
//   node --test test/browserClosingNotes.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
const { closingNotes } = await import('../lib/browser.js')

test('기록한 사실을 마무리 요청에 그대로 담는다', () => {
  const s = closingNotes({ notes: ['한빛호텔 디럭스 1박 128,000원', '  ', '조식 포함 · 무료 취소'] })
  assert.match(s, /Facts you recorded from the pages/)
  assert.match(s, /- 한빛호텔 디럭스 1박 128,000원/)
  assert.match(s, /- 조식 포함 · 무료 취소/)
  assert.equal((s.match(/^- /gm) || []).length, 2, 'blank notes are left out')
})

test('기록이 없으면 아무것도 덧붙이지 않는다', () => {
  assert.equal(closingNotes({ notes: [] }), '')
  assert.equal(closingNotes({}), '')
  assert.equal(closingNotes(null), '')
})
