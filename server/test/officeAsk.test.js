// Asking about a selection of the open IeumOffice document from the chat (2026-11-25 — the user selected a table's text, asked for it
// to be centred vertically, the agent said 「맞췄습니다」 and the document had not changed; spec openspec/specs/pgpt-pro_office-editor
// 「문서에서 고른 부분을 채팅에서 고친다」). No browser, no database, no model.
//   - the selection the editor page tells (office-host page-live.mjs 'selection') → the composer's chip and the next message's mention,
//     with the place the live tools need (src/docSelection.js); a chip put away stays away until the selection changes
//   - a message about the open document stays in the document's conversation (no new topic from the context router)
//   - an edit call the editor reports as changing nothing goes back to the agent as an error, and a turn whose edits changed nothing
//     ends with that said plainly (server/lib/officeEdits.js)
//   - the agent's hint names the selection's place and forbids saying 「done」 for an edit that was not applied (lib/craftLive.js)
//   cd server && node --test test/officeAsk.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { docSelectionOf, docSelectionKey, selectionMention, mentionContext, docConversation } from '../../src/docSelection.js'
import { editOutcome, notAppliedResult, recordEdit, editsSince, editVerdict, notAppliedAnswer } from '../lib/officeEdits.js'

const CELL = { editor: 'docs', kind: 'table', label: '표 1 · 3행 2열', text: '대표, 개발팀, 운영팀, 영업팀', blockIndex: 2, table: 1, range: { row: 2, col: 1, rowEnd: 2, colEnd: 1 }, from: 120, to: 135, cells: 1 }

test('OA-U-01 고른 부분 → 칩: 어디(표 · 행 · 열)와 고른 글, 라이브 도구가 쓸 자리(블록 · 표 범위 · 위치)', () => {
  const s = docSelectionOf(CELL, '회의록_템플릿.docx')
  assert.deepEqual(s, { editor: 'docs', kind: 'table', label: '표 1 · 3행 2열', text: '대표, 개발팀, 운영팀, 영업팀', file: '회의록_템플릿.docx', blockIndex: 2, table: 1, range: { row: 2, col: 1, rowEnd: 2, colEnd: 1 }, from: 120, to: 135 })
  const chip = selectionMention(s)
  assert.equal(chip.kind, 'selection')
  assert.equal(chip.where, 'table')
  assert.equal(chip.label, '표 1 · 3행 2열 "대표, 개발팀, 운영팀, 영업팀"')
  // a long selection is clipped in the chip, whole in the mention
  const long = selectionMention(docSelectionOf({ ...CELL, kind: 'text', label: '문단', text: '가'.repeat(100) }, 'a.docx'))
  assert.equal(long.label, `문단 "${'가'.repeat(24)}…"`)
  assert.equal(long.text.length, 100)
  // nothing selected, or something the page did not describe: no chip
  for (const x of [null, undefined, {}, { label: '문단', text: '' }, 'x']) assert.equal(docSelectionOf(x, 'a.docx'), null)
  // junk in the numbers does not reach the agent
  const odd = docSelectionOf({ ...CELL, blockIndex: -1, range: { row: 'x' }, from: 1.5 }, 'a.docx')
  assert.equal(odd.blockIndex, undefined)
  assert.equal(odd.range, undefined)
  assert.equal(odd.from, undefined)
})

test('OA-U-02 칩을 ✕ 로 치우거나 보내면 같은 선택에는 다시 뜨지 않고, 선택이 바뀌면 다시 뜬다', () => {
  const a = docSelectionOf(CELL, 'a.docx')
  const b = docSelectionOf({ ...CELL, from: 140, to: 150, text: '3층 소회의실' }, 'a.docx')
  assert.equal(docSelectionKey(a), docSelectionKey(docSelectionOf(CELL, 'a.docx')))
  assert.notEqual(docSelectionKey(a), docSelectionKey(b))
  assert.notEqual(docSelectionKey(a), docSelectionKey(docSelectionOf(CELL, 'b.docx')))
  assert.equal(docSelectionKey(null), '')
})

test('OA-U-03 보낼 때 에이전트가 읽는 맥락: 고른 부분은 그 파일 · 고른 글 · 자리(blockIndex · range · from/to)', () => {
  const chip = selectionMention(docSelectionOf(CELL, '회의록_템플릿.docx'))
  const ko = mentionContext([chip])
  assert.match(ko, /^\(사용자가 열린 문서 '회의록_템플릿\.docx' 에서 골라 둔 부분이에요 — 요청은 바로 이 부분에 대한 것이에요: @표 1 · 3행 2열 "대표, 개발팀, 운영팀, 영업팀" = /)
  const json = JSON.parse(ko.slice(ko.indexOf('= ') + 2, -1))
  assert.deepEqual([json.text, json.blockIndex, json.range, json.from, json.to, json.where], ['대표, 개발팀, 운영팀, 영업팀', 2, { row: 2, col: 1, rowEnd: 2, colEnd: 1 }, 120, 135, 'table'])
  // a pointed-at object (@ 가리키기) keeps its line as before, beside a selection
  const both = mentionContext([{ editor: 'docs', kind: 'table', table: 2, label: '표 2' }, chip])
  assert.match(both, /^\(사용자가 열린 문서에서 가리킨 대상: @표 2 = \{/)
  assert.equal(both.split('\n').length, 2)
  assert.match(mentionContext([chip], true), /^\(The person selected this in the open document '회의록_템플릿\.docx'/)
})

test('OA-U-04 열린 문서에 대한 메시지는 그 문서의 대화로 — 라우터가 새 주제로 보내지 않는다', () => {
  const doc = { msgId: 'm-card', name: '회의록_템플릿.docx', url: 'http://x/a.docx' }
  const base = { doc, threadId: 'main', mainId: 'main', convOf: { 'm-card': 'conv-minutes' }, convList: [{ id: 'conv-minutes', title: '회의록 템플릿' }] }
  assert.deepEqual(docConversation(base), { id: 'conv-minutes', title: '회의록 템플릿' })
  // the conversation its first message went to (a card in no conversation)
  assert.deepEqual(docConversation({ ...base, doc: { ...doc, msgId: 'm-x', conv: 'conv-later' } }), { id: 'conv-later', title: '' })
  // not when the person chose a conversation, not in a project, not for a preview, not when nothing is known
  assert.equal(docConversation({ ...base, chosen: { id: 'conv-other' } }), null)
  assert.equal(docConversation({ ...base, threadId: 'project-1' }), null)
  assert.equal(docConversation({ ...base, doc: { ...doc, readOnly: true } }), null)
  assert.equal(docConversation({ ...base, convOf: {} }), null)
  assert.equal(docConversation({ ...base, doc: null }), null)
})

const res = (obj, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] })

test('OA-U-05 편집 도구의 결과: 편집기가 「바뀐 곳 없음」(mutated:false)·오류·ok:false 면 적용되지 않음 — 읽기 도구는 세지 않음', () => {
  assert.deepEqual(editOutcome('office_live_apply_ops', {}, res({ summary: '표 칸 서식 1건', output: '…', mutated: true })), { applied: true, summary: '표 칸 서식 1건' })
  assert.deepEqual(editOutcome('office_live_apply_ops', {}, res({ summary: '바뀐 곳 없음', output: '…', mutated: false })), { applied: false, nothing: true, why: '바뀐 곳 없음' })
  assert.deepEqual(editOutcome('office_live_apply_ops', {}, res('op #0: target requires at least one condition', true)), { applied: false, why: 'op #0: target requires at least one condition' })
  assert.equal(editOutcome('office_live_apply_ops', {}, res({ ok: false, error: 'bad' })).applied, false)
  assert.equal(editOutcome('office_live_write', {}, res({ summary: '문단 1개', mutated: true })).applied, true)
  assert.equal(editOutcome('office_live_hwp_table', { action: 'fill' }, res({ filled: 2 })).applied, true)
  for (const [name, args] of [['office_live_read', {}], ['office_live_documents', {}], ['office_live_hwp_table', { action: 'read' }], ['office_guide', {}], ['office_live_save', {}]]) {
    assert.equal(editOutcome(name, args, res({ mutated: false })), null, name)
  }
  // what the agent gets back for "nothing changed": an error that says so and asks not to claim it
  const back = notAppliedResult({ applied: false, nothing: true, why: '바뀐 곳 없음' })
  assert.equal(back.isError, true)
  assert.match(back.content[0].text, /적용되지 않았어요 — 바뀐 곳이 없어요\. 편집기의 답: 바뀐 곳 없음/)
  assert.match(back.content[0].text, /했다고 답하지 마세요/)
})

test('OA-U-06 한 턴의 편집: 하나라도 바뀌면 applied, 모두 실패·무변화면 none(답을 그대로 바꿔 말함), 편집이 없으면 null', () => {
  const u = `u-${Date.now()}`
  const t0 = Date.now()
  assert.equal(editVerdict(editsSince(u, t0)), null)
  recordEdit(u, 'office_live_apply_ops', { applied: false, nothing: true, why: '바뀐 곳 없음' })
  assert.equal(editVerdict(editsSince(u, t0)), 'none')
  const said = notAppliedAnswer(editsSince(u, t0), '회의록_템플릿.docx')
  assert.equal(said, "요청한 수정이 '회의록_템플릿.docx' 문서에 반영되지 않았어요. 편집기가 바뀐 곳이 없다고 알려 왔어요 (바뀐 곳 없음). 고칠 부분을 문서에서 다시 골라 보내 주세요.")
  assert.doesNotMatch(said, /맞췄|했어요/)
  recordEdit(u, 'office_live_apply_ops', { applied: true, summary: '표 칸 서식 1건' })
  assert.equal(editVerdict(editsSince(u, t0)), 'applied')
  // another person's calls and earlier turns do not count
  assert.equal(editVerdict(editsSince(`${u}-other`, t0)), null)
  assert.equal(editVerdict(editsSince(u, Date.now() + 1000)), null)
})
