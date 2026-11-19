// The meeting helper answers what is said to it (2026-11-19 production: "폴더에 있는 내용 중에 셉 ERP 관련
// PDF 좀 열어볼래?" got no reaction at all — folder documents were not candidates, "셉" never matched SAP,
// and a request with nothing found ended in silence). Without a model or a database.
// Run: node --test test/meetingAnswers.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
process.env.SERVICE_ROLE_KEY ||= 'unit-test'
const { withLang } = await import('../lib/lang.js')
const I = await import('../lib/meetings/intent.js')
const MAT = await import('../lib/meetings/materials.js')
const ko = (fn) => withLang('ko', fn)
const SAID = '그리고 폴더에 있는 내용 중에 셉 ERP 관련 PDF 좀 열어볼래?'

test('받아쓴 영어 낱말: 셉 → SAP, 피디에프 → PDF 를 이름과 맞춰 본다', () => ko(() => {
  assert.match(MAT.heard(SAID), /\bsap\b/)
  assert.match(MAT.heard('피디에프 열어 줘'), /\bpdf\b/)
  assert.equal(MAT.heard('견적서 보여 줘'), '견적서 보여 줘', '영어 낱말이 없으면 그대로')
  // 이름 낱말(SAP·ERP) + 말한 파일 종류(PDF): 같은 이름의 PPTX 보다 PDF 가 앞선다
  const names = ['SAP_ERP_소개서.pdf', 'SAP_ERP_소개서.pptx', 'ERP 견적서.xlsx', '회의록.docx']
  const ranked = names.map((n) => [n, MAT.score(SAID, n)]).sort((x, y) => y[1] - x[1])
  assert.equal(ranked[0][0], 'SAP_ERP_소개서.pdf')
  assert.ok(ranked[0][1] > ranked[1][1])
  assert.equal(MAT.score(SAID, '회의록.docx'), 0)
  // 대소문자는 가리지 않는다("erp 자료")
  assert.ok(MAT.score('erp 자료 보여 줘', 'SAP_ERP_소개서.pdf') > 0)
  // 영어 낱말 뒤에 붙은 조사는 떼어 본다(운영 파일 이름 「SAP Cloud ERP에 대한 5가지 오해와 진실_261008.pdf」)
  assert.deepEqual(MAT.nameTokens('SAP Cloud ERP에 대한 5가지 오해와 진실_261008.pdf'), ['SAP', 'Cloud', 'ERP', '대한', '가지', '오해와', '진실', '261008'])
  assert.ok(MAT.score(SAID, 'SAP Cloud ERP에 대한 5가지 오해와 진실_261008.pdf') > MAT.score(SAID, 'SAP Cloud 소개.pptx'))
}))

test('문서 카드 키워드로도 찾는다(이름보다 조금 낮게)', () => ko(() => {
  const c = { title: '2026_제안_v3.pdf', keywords: ['SAP', 'ERP', '도입 제안'] }
  assert.equal(MAT.score('ERP 관련 자료 열어 줘', c.title), 0)
  const s = MAT.scoreOf('ERP 관련 자료 열어 줘', c)
  assert.ok(s > 0 && s < MAT.scoreOf('ERP 관련 자료 열어 줘', { title: 'ERP_자료.pdf' }) + 1)
  assert.equal(MAT.scoreOf('점심 뭐 먹지', c), 0)
}))

test('도우미에게 한 말인지 · 열어 달라는지 · 파일 이야기인지', () => ko(() => {
  assert.equal(I.addressed(SAID), true)
  assert.equal(I.wantsOpen(SAID), true)
  assert.equal(I.namesFile(SAID), true)
  assert.equal(I.addressed('그 견적서 좀 띄워 줘'), true)
  assert.equal(I.addressed('관련 자료 좀 찾아 주세요'), true)
  assert.equal(I.wantsOpen('관련 자료 좀 찾아 주세요'), false, '찾아 달라는 말은 열지 않고 자료 칸에만')
  // 사람에게 하는 말(파일 낱말 없음) — 도우미는 끼어들지 않는다
  assert.equal(I.namesFile('민지님 화면 좀 보여 줘'), false)
  assert.equal(I.addressed('다들 주말 잘 보냈어요?'), false)
  assert.equal(I.cue(SAID).material, true)
}))

test('찾은 목록: 같은 이름은 한 줄, 그 자리에 폴더 원본을 남긴다', () => {
  const list = [{ key: 'file:1', title: 'ERP_일정.xlsx' }, { key: 'file:2', title: '회의록.docx' }, { key: 'folder:f:ERP_일정.xlsx', title: 'ERP_일정.xlsx', folderFile: true }, { key: 'file:3', title: 'erp_일정.XLSX' }]
  assert.deepEqual(MAT.oncePerName(list).map((x) => x.key), ['folder:f:ERP_일정.xlsx', 'file:2'])
})

test('찾은 것의 모양: 열쇠는 종류:아이디, 폴더 문서는 folderFile', () => ko(() => {
  const v = MAT.pickView({ kind: 'folder', id: 'f1:docs/a.pdf', title: 'a.pdf', folderFile: true, where: '영업 폴더', score: 2 })
  assert.deepEqual(v, { key: 'folder:f1:docs/a.pdf', kind: 'folder', title: 'a.pdf', where: '영업 폴더', folderFile: true, score: 2 })
  assert.equal(MAT.pickView({ kind: 'process', id: 'p1', title: '출장비 정산' }).where, '진행 상황')
}))
