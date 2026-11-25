// A format edit counts as done only when the document shows it (server/lib/officeEdits.js). Production 2026-11-25 12:57: 「@표 1 ·
// 1~3행 1~4열 … 중앙정렬」 — the editor reported 「setTableCellFormat: 10」, the review said 「편집기 확인 … ✓」, and the labels still sat
// at the top of their cells. office-host now reads back what the open document shows after a batch (page-live.mjs formatFacts → the
// result's `check`); here that is compared with what the batch asked for. No browser, no model.
//   cd server && node --test test/officeEdits.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { editOutcome, formatUnmet, notAppliedResult, notAppliedAnswer, forAgent, recordEdit, editsSince, editVerdict } from '../lib/officeEdits.js'

const res = (obj, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] })
const VALIGN = { op: 'setTableCellFormat', target: { nodeType: 'table', blockIndexes: [1] }, range: { row: 0, col: 0, rowEnd: 2, colEnd: 3 }, vAlign: 'center' }
// the label cells of 회의록_템플릿.docx as the document shows them: a 36px cell, a 22px line
const cell = (row, col, text, shown, extra = {}) => ({ row, col, text, vAlign: 'center', fill: text ? 'F2F4F7' : null, borders: null, shown: { verticalAlign: 'middle', background: text ? 'F2F4F7' : null, ...shown }, ...extra })
const labels = (shown) => [cell(0, 0, '회의명', shown), cell(0, 1, '', {}), cell(0, 2, '일시', shown), cell(1, 0, '장소/방식', shown), cell(2, 0, '참석자', shown), cell(2, 1, '', {}, { colEnd: 3 })]
const after = (cells, extra = {}) => res({ summary: 'setTableCellFormat: 10', output: '…', mutated: true, check: [{ op: 0, name: 'setTableCellFormat', table: 1, block: 1, cells }], ...extra })

test('OE-U-01 세로 가운데: 칸의 vAlign 이 center 라도 글이 칸 위에 붙어 있으면 적용되지 않음 — 에이전트에 칸과 화면의 자리를 말한다', () => {
  // production: each label paragraph's space after filled its cell — nothing moved (0px above the text, 13px below)
  const out = editOutcome('office_live_apply_ops', { ops: [VALIGN] }, after(labels({ above: -0.3, below: 13.3, lines: 22 })))
  assert.equal(out.applied, false)
  assert.equal(out.unmet.length, 1)
  assert.deepEqual([out.unmet[0].key, out.unmet[0].want, out.unmet[0].cells, out.unmet[0].of, out.unmet[0].first.text], ['vAlign', 'center', 4, 6, '회의명'])
  assert.match(out.why, /^표 1 · 1행 1열 「회의명」 등 4칸: 세로 가운데 정렬이 문서에 보이지 않아요\(글 위 0px · 아래 13px/)
  const back = notAppliedResult(out)
  assert.equal(back.isError, true)
  assert.match(back.content[0].text, /^편집기는 이 편집을 받아들였지만 요청한 서식이 문서에 나타나지 않았어요 — 표 1/)
  assert.match(back.content[0].text, /했다고 답하지 마세요/)
  // the ops may come as a JSON string (an untyped schema)
  assert.equal(editOutcome('office_live_apply_ops', { ops: JSON.stringify([VALIGN]) }, after(labels({ above: -0.3, below: 13.3, lines: 22 }))).applied, false)
})

test('OE-U-02 세로 가운데가 문서에 보이면 적용 — 확인한 서식 수, 에이전트에는 긴 check 대신 「문서에서 확인함」', () => {
  // after office-host moved half the space after above the line: 4.4px above, 7.6px below a 22px line (a font's ascent and
  // descent differ — within a third of the line)
  const r = after(labels({ above: 4.4, below: 7.6, lines: 22 }), { aligned: { cells: 10, paragraphs: 10, summary: '블록 10개의 단락 서식을 업데이트했습니다' } })
  const out = editOutcome('office_live_apply_ops', { ops: [VALIGN] }, r)
  assert.deepEqual(out, { applied: true, summary: 'setTableCellFormat: 10 · 칸 10개의 글 자리 맞춤', verified: true, checked: 1 })
  const seen = JSON.parse(forAgent(r, out).content[0].text)
  assert.equal(seen.check, undefined)
  assert.equal(seen.verified, '문서에서 확인함(서식 1건)')
  assert.equal(seen.mutated, true)
  // empty cells (no text to place) are judged by their value only; top and bottom by the room on that side
  assert.equal(formatUnmet([{ ...VALIGN, vAlign: 'top' }], [{ op: 0, name: 'setTableCellFormat', cells: [cell(0, 0, '회의명', { above: 0.2, below: 13, lines: 22 }, { vAlign: null })] }]).unmet.length, 0)
  assert.equal(formatUnmet([{ ...VALIGN, vAlign: 'bottom' }], [{ op: 0, name: 'setTableCellFormat', cells: [cell(0, 0, '회의명', { above: 0.2, below: 13, lines: 22 }, { vAlign: 'bottom' })] }]).unmet[0].key, 'vAlign')
})

test('OE-U-03 다른 서식도 문서로: 칸 색(값과 화면) · 테두리 · 문단 가로 정렬(값과 화면) · 대상이 없음', () => {
  const fill = { op: 'setTableCellFormat', target: { blockIndexes: [1] }, range: { row: 0, col: 0 }, fill: '#FFF2CC' }
  // the cell has it and shows it / has it but shows another colour (a style painted over) / does not have it
  assert.equal(formatUnmet([fill], [{ op: 0, name: 'setTableCellFormat', table: 1, cells: [cell(0, 0, '회의명', { background: 'FFF2CC' }, { fill: 'FFF2CC' })] }]).unmet.length, 0)
  const painted = formatUnmet([fill], [{ op: 0, name: 'setTableCellFormat', table: 1, cells: [cell(0, 0, '회의명', { background: 'D9E2F3' }, { fill: 'FFF2CC' })] }]).unmet[0]
  assert.deepEqual([painted.key, painted.got, painted.shown], ['fill', 'D9E2F3', true])
  assert.equal(formatUnmet([fill], [{ op: 0, name: 'setTableCellFormat', table: 1, cells: [cell(0, 0, '회의명', {}, { fill: 'F2F4F7' })] }]).unmet[0].got, 'F2F4F7')
  // borders: all sides single red / one side off
  const borders = { ...fill, fill: undefined, borders: { all: { style: 'single', color: '#FF0000' } } }
  const red = { style: 'single', szEighths: 4, color: 'FF0000' }
  assert.equal(formatUnmet([borders], [{ op: 0, name: 'setTableCellFormat', cells: [cell(0, 0, 'a', {}, { borders: { top: red, left: red, bottom: red, right: red } })] }]).unmet.length, 0)
  assert.deepEqual(formatUnmet([borders], [{ op: 0, name: 'setTableCellFormat', cells: [cell(0, 0, 'a', {}, { borders: { top: red, left: red, bottom: { style: 'none' }, right: red } })] }]).unmet[0].side, 'bottom')
  assert.equal(formatUnmet([{ ...borders, borders: null }], [{ op: 0, name: 'setTableCellFormat', cells: [cell(0, 0, 'a', {}, { borders: { top: { style: 'none' } } })] }]).unmet.length, 0)
  // paragraph alignment: the value and what is laid out
  const align = { op: 'setParagraphFormat', target: { blockIndexes: [1], range: { from: 5, to: 40 } }, align: 'center' }
  const p = (attrs, textAlign) => ({ text: '회의명', attrs, shown: { textAlign, spaceBefore: 0, spaceAfter: 0 } })
  assert.equal(formatUnmet([align], [{ op: 0, name: 'setParagraphFormat', paragraphs: [p({ align: 'center' }, 'center')] }]).unmet.length, 0)
  assert.deepEqual(formatUnmet([align], [{ op: 0, name: 'setParagraphFormat', paragraphs: [p({ align: 'center' }, 'left')] }]).unmet[0].got, 'left')
  assert.equal(formatUnmet([{ ...align, align: 'left' }], [{ op: 0, name: 'setParagraphFormat', paragraphs: [p({ align: 'left' }, 'start')] }]).unmet.length, 0)
  assert.deepEqual(formatUnmet([{ ...align, align: undefined, spaceAfter: 0 }], [{ op: 0, name: 'setParagraphFormat', paragraphs: [p({ spaceAfter: 200 }, 'left')] }]).unmet[0].got, 200)
  // the target named no table / reached no paragraph
  const none = editOutcome('office_live_apply_ops', { ops: [VALIGN] }, after([]))
  assert.equal(none.applied, false)
  assert.match(none.why, /대상\(표\)을 문서에서 찾지 못했어요/)
})

test('OE-U-04 확인할 것이 없으면(편집기만 보고, check 없음 — 이전 office-host) 적용으로 세되 「문서에서 확인」은 아님', () => {
  const out = editOutcome('office_live_apply_ops', { ops: [VALIGN] }, res({ summary: 'setTableCellFormat: 10', mutated: true }))
  assert.deepEqual(out, { applied: true, summary: 'setTableCellFormat: 10' })
  assert.equal(forAgent(res({ summary: 'x', mutated: true }), out).content[0].text, JSON.stringify({ summary: 'x', mutated: true }))
  // a batch of ops the check does not cover (findReplace): applied, nothing compared
  assert.deepEqual(editOutcome('office_live_apply_ops', { ops: [{ op: 'findReplace', find: 'a', replace: 'b' }] }, res({ summary: '1곳', mutated: true, check: [] })), { applied: true, summary: '1곳', verified: false, checked: 0 })
  // nothing changed still wins over the facts
  assert.equal(editOutcome('office_live_apply_ops', { ops: [VALIGN] }, res({ summary: '바뀐 곳 없음', mutated: false, check: [] })).nothing, true)
})

test('OE-U-05 한 턴의 편집이 모두 문서에 나타나지 않으면 답은 「반영되지 않았어요」 — 이유는 문서가 보여 준 것', () => {
  const u = `oe-${Date.now()}`
  const t0 = Date.now()
  recordEdit(u, 'office_live_apply_ops', editOutcome('office_live_apply_ops', { ops: [VALIGN] }, after(labels({ above: -0.3, below: 13.3, lines: 22 }))))
  assert.equal(editVerdict(editsSince(u, t0)), 'none')
  const said = notAppliedAnswer(editsSince(u, t0), '회의록_템플릿.docx')
  assert.match(said, /^요청한 수정이 '회의록_템플릿\.docx' 문서에 반영되지 않았어요\. 편집기는 받아들였지만 문서에서 확인되지 않았어요 \(표 1 · 1행 1열 「회의명」 등 4칸: 세로 가운데 정렬이 문서에 보이지 않아요/)
  // the agent fixes it and the document shows it: applied
  recordEdit(u, 'office_live_apply_ops', editOutcome('office_live_apply_ops', { ops: [VALIGN] }, after(labels({ above: 6, below: 7, lines: 22 }))))
  assert.equal(editVerdict(editsSince(u, t0)), 'applied')
})
