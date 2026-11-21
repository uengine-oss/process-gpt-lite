// The meeting helper answers what is said to it (2026-11-19 production: a request to open a folder
// document got no reaction at all — folder documents were not candidates, and a request with nothing
// found ended in silence). Since 2026-11-21 nothing here reads words: which line asks for what, and which
// candidate it means, is the judge's pick (a stand-in judge server here); the typed search box filters
// names by what was typed. Without a model or a database.
// Run: node --test test/meetingAnswers.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { startJudge } from './fixtures/judgeStub.mjs'
process.env.SERVICE_ROLE_KEY ||= 'unit-test'
let answer = () => 'none'
const J = await startJudge((body, n) => answer(body, n))
process.env.PRO_JUDGE_URL = J.url
after(() => J.close())
const { withLang } = await import('../lib/lang.js')
const I = await import('../lib/meetings/intent.js')
const MAT = await import('../lib/meetings/materials.js')
const ko = (fn) => withLang('ko', fn)

const LIST = [
  { kind: 'folder', id: 'f1:docs/물류센터_이전_계획.pdf', title: '물류센터_이전_계획.pdf', folderFile: true, where: '운영 폴더', keywords: ['이전', '일정'] },
  { kind: 'folder', id: 'f1:docs/물류센터_이전_계획.pptx', title: '물류센터_이전_계획.pptx', folderFile: true, where: '운영 폴더' },
  { kind: 'file', id: 'm1', title: '공급사_단가표_2026.xlsx' },
  { kind: 'process', id: 'i7', title: '구매 요청 #301' },
]

test('보여 달라는 말: 판단 모델이 고른 후보를 띄우고 바로 연다 — 찾아 달라는 말은 열지 않는다', () => ko(async () => {
  const ctx = { roomId: 'r', speaker: { id: 'u', name: '박' }, prev: [], shown: new Set() }
  // detect reads the candidates from the database; here the pick step gets the list directly
  answer = (body) => (body.question.includes('가리키는') ? 'c0' : 'show')
  const r = await MAT.pick('이전 계획 피디에프 띄워 줄래', ctx, { list: LIST })
  assert.equal(r.pick.title, '물류센터_이전_계획.pdf')
  answer = () => 'none'
  assert.equal((await MAT.pick('작년 감사 보고서', ctx, { list: LIST })).pick, null, '맞는 것이 없으면 없다고')
  // the shortlist the judge reads names each candidate's kind and place
  J.calls.length = 0
  answer = () => 'none'
  await MAT.pick('아무거나', ctx, { list: LIST })
  assert.match(J.calls[0].options[1].label, /^\[폴더 문서\] 물류센터_이전_계획\.pdf · 운영 폴더 · 이전, 일정$/)
  assert.match(J.calls[0].options[4].label, /^\[진행 중인 업무\] 구매 요청 #301$/)
}))

test('도우미에게 한 말인지: 판단 모델의 답(to_assistant), 판단 서버뿐이면 보여 달라는 말만', () => ko(async () => {
  const ctx = { roomId: 'r', speaker: { id: 'u', name: '박' }, prev: [], shown: new Set(), lastMinute: 0 }
  // no candidates in the database for this speaker (no DB here): asked to show → not found, said to the helper
  answer = () => 'show'
  const r = await I.detect({ speaker: '박', text: '그 계획서 화면에 띄워 주세요' }, ctx)
  assert.ok(r.notFound)
  assert.equal(r.addressed, true)
  answer = () => 'find'
  const f = await I.detect({ speaker: '박', text: '그 계획서 나중에 같이 한번 보죠' }, ctx)
  assert.equal(f.addressed, false, '판단 서버는 to_assistant 를 쓰지 않는다: 찾자는 말은 도우미에게 한 말로 치지 않음')
}))

test('찾은 목록: 같은 이름은 한 줄, 그 자리에 폴더 원본을 남긴다', () => {
  const list = [{ key: 'file:1', title: 'ERP_일정.xlsx' }, { key: 'file:2', title: '회의록.docx' }, { key: 'folder:f:ERP_일정.xlsx', title: 'ERP_일정.xlsx', folderFile: true }, { key: 'file:3', title: 'erp_일정.XLSX' }]
  assert.deepEqual(MAT.oncePerName(list).map((x) => x.key), ['folder:f:ERP_일정.xlsx', 'file:2'])
})

test('찾은 것의 모양: 열쇠는 종류:아이디, 폴더 문서는 folderFile', () => ko(() => {
  const v = MAT.pickView({ kind: 'folder', id: 'f1:docs/a.pdf', title: 'a.pdf', folderFile: true, where: '영업 폴더', score: 2 })
  assert.deepEqual(v, { key: 'folder:f1:docs/a.pdf', kind: 'folder', title: 'a.pdf', where: '영업 폴더', folderFile: true, score: 2 })
  assert.equal(MAT.pickView({ kind: 'process', id: 'p1', title: '출장 경비 청구' }).where, '진행 상황')
}))
