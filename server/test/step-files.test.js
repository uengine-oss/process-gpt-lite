// 사람 단계의 결과 파일(lib/ontology/stepfiles.js): 일 정의가 파일 칸을 정하고, 입력 폼 · 채팅으로 낸 파일이 같은 칸에 남고, 채팅의 말이
// 단계 이름을 대면 그 단계를 고르며, 뒤 단계(run.js mapPrev)는 그 단계의 파일 글을 받는다 — 데이터베이스 없이.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DOTENV_CONFIG_QUIET = 'true'
const SF = await import('../lib/ontology/stepfiles.js')
const { mapPrev } = await import('../lib/ontology/run.js')

test('파일 형식의 outputs 만 파일 칸이 된다(글 · 메일은 칸이 아님)', () => {
  const outs = [{ name: '영수증', format: 'pdf' }, { name: '검토 의견', format: '글' }, { name: '카드 내역', format: '.xlsx' }, { name: '회신', format: 'mail' }, { name: '증빙', format: '파일' }]
  assert.deepEqual(SF.fileOutputs(outs).map((o) => o.name), ['영수증', '카드 내역', '증빙'])
  assert.deepEqual(SF.fileOutputs([]), [])
  assert.deepEqual(SF.fileOutputs(undefined), [])
  const f = SF.fileFields(SF.fileOutputs(outs))
  assert.deepEqual(f.map((x) => x.key), ['files', 'files_2', 'files_3'])
  assert.ok(f.every((x) => x.type === 'file' && x.multiple && x.upload === 'attachment'))
  assert.equal(f[0].text, '영수증')
})

test('단계 결과의 파일 칸에서만 파일을 꺼낸다(에이전트 문서 · 글은 아님)', () => {
  const up = (n) => ({ name: n, url: `http://s/${n}`, path: `/workspace/uploads/u/${n}`, type: 'text/csv', size: 10 })
  const v = { result: '영수증 올려요', files: [up('ktx.csv'), up('hotel.docx')], files_2: up('card.xlsx'), document: up('정산서.docx'), via: 'chat' }
  assert.deepEqual(SF.filesOf(v).map((f) => f.name), ['ktx.csv', 'hotel.docx', 'card.xlsx'])
  assert.deepEqual(SF.filesOf({ result: 'x' }), [])
  assert.deepEqual(SF.filesOf({ files: [{ name: 'no-url' }] }), [])
})

test('채팅의 말이 단계 이름을 대면 그 단계, 같은 이름이 여러 건이면 건 제목의 말로 좁힌다', () => {
  const steps = [
    { todoId: 'a', task: '영수증 제출', subject: '부산 출장비 정산 요청' },
    { todoId: 'b', task: '영수증 제출', subject: '대전 교육 출장비 정산 요청' },
    { todoId: 'c', task: '재무 검토', subject: '부산 출장비 정산 요청' },
  ]
  assert.deepEqual(SF.namedSteps('재무검토 단계 자료예요', steps).map((x) => x.todoId), ['c'])
  assert.deepEqual(SF.namedSteps('영수증 제출 단계 증빙입니다', steps).map((x) => x.todoId), ['a', 'b'])
  assert.deepEqual(SF.namedSteps('대전 건 영수증 제출 증빙입니다', steps).map((x) => x.todoId), ['b'])
  assert.deepEqual(SF.namedSteps('영수증이에요', steps), [])
  assert.deepEqual(SF.namedSteps('', steps), [])
})

test('뒤 단계는 파일을 그 단계와 함께, 파일의 글까지 받는다(평평한 files 칸은 넘기지 않음)', () => {
  const earlier = [
    { task: '정산서 작성', text: '정산서를 만들었어요' },
    { task: '영수증 제출', text: '', files: [{ name: 'ktx.csv', path: '/workspace/uploads/u/ktx.csv', text: '부산 KTX,120000' }, { name: 'scan.pdf', path: '/workspace/uploads/u/scan.pdf', text: '' }] },
  ]
  const p = mapPrev({ subject: '부산 출장비 정산' }, { result: 'x', files: [{ name: 'ktx.csv' }], via: 'chat', document: { name: '정산서.docx' } }, earlier)
  assert.deepEqual(p.steps.map((s) => s.step), ['정산서 작성', '영수증 제출'])
  assert.equal(p.steps[1].files[0].text, '부산 KTX,120000')
  assert.match(p.steps[1].files[1].text, /읽지 못한/)
  assert.equal(p.steps[1].files[1].path, '/workspace/uploads/u/scan.pdf')
  assert.equal(p.files, undefined)
  assert.equal(p.via, undefined)
  assert.deepEqual(p.document, { name: '정산서.docx' })
})
