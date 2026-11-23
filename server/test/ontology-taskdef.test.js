// 일 정의가 읽는 엑셀 칸(spec pgpt-pro_process-ontology, 「에이전트가 만든 견적서와 배운 조건」): 점검 항목은 사람이 보는 글자로
// 판단해야 한다 — LibreOffice 가 글꼴이 섞인 칸을 rich text 로 저장하면 빈칸으로 읽혀 점검이 모두 ✗ 가 됐다(2026-11-13).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { cellText, sheetText, formNameChoice, ruleFormName } from '../lib/ontology/taskdef.js'

test('칸 하나: rich text · 수식 결과 · 날짜 · 빈칸', () => {
  assert.equal(cellText({ richText: [{ text: '달빛커피 ' }, { font: { name: '맑은 고딕' }, text: '2' }, { text: '호점' }] }), '달빛커피 2호점')
  assert.equal(cellText({ formula: 'D13*F13', result: 34000000 }), '34000000')
  assert.equal(cellText({ formula: 'F2+30' }), '=F2+30')
  assert.equal(cellText({ text: { richText: [{ text: '링크' }] }, hyperlink: 'https://x' }), '링크')
  assert.equal(cellText(new Date('2026-11-12T00:00:00Z')), '2026-11-12')
  assert.equal(cellText(null), '')
  assert.equal(cellText(0), '0')
})

test('시트: 병합 칸은 한 번, 값이 같은 이웃 칸은 그대로', async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('견적서')
  ws.getCell('A1').value = '수 신'
  ws.getCell('B1').value = { richText: [{ text: '달빛커피 ' }, { text: '한서윤' }] }
  ws.mergeCells('B1:D1')
  ws.getRow(2).values = ['설계비', 1, '식', 3500000, { formula: 'B2*D2', result: 3500000 }]
  const back = new ExcelJS.Workbook()
  await back.xlsx.load(await wb.xlsx.writeBuffer())
  assert.equal(sheetText(back), '수 신 | 달빛커피 한서윤\n설계비 | 1 | 식 | 3500000 | 3500000')
})

// 「다른 일의 양식에서 고르기」(GET /ontology/forms/company)는 모델을 부르지 않고 읽기만 한다 — 붙여 둔 이름이 있으면 그 이름,
// 없으면 규칙 이름(파일 이름에서 문서 종류를 말하는 부분, 없으면 파일 이름 앞부분)에 아직 이름 붙이기 전(unnamed) 표시(2026-11-16).
test('양식 이름 고르기: 붙여 둔 이름 → 규칙 이름(임시)', () => {
  const names = ['바이켐_AI 도입_제안서.docx', '고모텍_AI 도입_제안서.docx']
  // the same files named before (the same key) — or most of them
  assert.deepEqual(formNameChoice({ names, known: [{ names_key: names.slice().sort().join('|'), names, name: 'AI 도입 제안서' }], stem: '바이켐' }), { name: 'AI 도입 제안서', unnamed: false })
  assert.deepEqual(formNameChoice({ names: [...names, '윈텍_AI 도입_제안서.docx'], known: [{ names_key: 'x', names, name: 'AI 도입 제안서' }], stem: '바이켐' }), { name: 'AI 도입 제안서', unnamed: false })
  // none kept: the part that says a kind of document, marked unnamed
  assert.deepEqual(formNameChoice({ names, known: [{ names_key: 'y', names: ['딴_파일.xlsx'], name: '견적서' }], stem: '바이켐' }), { name: '제안서', unnamed: true })
  assert.equal(ruleFormName(['바이켐_AI 도입 제안서.docx'], '바이켐'), 'AI 도입 제안서')
  // no part says one: the file's first part
  assert.deepEqual(formNameChoice({ names: ['고모텍.docx'], known: [], stem: '고모텍' }), { name: '고모텍', unnamed: true })
  assert.equal(ruleFormName(['디케이(2차)_과제 정의서.docx', '윈텍_과제 정의서.docx', '윈텍_진행 보고.docx']), '과제 정의서')
  assert.equal(ruleFormName(['ACME_quote_v2.xlsx'], 'ACME'), 'quote')
  assert.equal(ruleFormName([], ''), '')
})
