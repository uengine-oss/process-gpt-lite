// 지도 건의 앞 단계 값(run.js mapPrev): 사람 단계마다 같은 칸(result)에 써도 단계별로 남는다 — 데이터베이스 없이.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DOTENV_CONFIG_QUIET = 'true'
const { mapPrev } = await import('../lib/ontology/run.js')

test('사람 단계 둘의 결과가 서로 덮어쓰지 않고 단계별로 넘어간다', () => {
  const done = { result: '재무 검토: 한도 안' } // worker.earlier 가 합친 값 — 앞 단계 글은 이미 덮였다
  const earlier = [{ task: '영수증 제출', text: 'KTX 120,000 / 숙박 980,000 / 식대 400,000 — 합계 1,500,000' }, { task: '재무 검토', text: '재무 검토: 한도 안' }]
  const p = mapPrev({ subject: '부산 출장비 정산' }, done, earlier)
  assert.deepEqual(p.steps.map((s) => s.step), ['영수증 제출', '재무 검토'])
  assert.match(p.steps[0].text, /1,500,000/)
  assert.equal(p.result, undefined)
  assert.equal(p.subject, '부산 출장비 정산')
  assert.equal(Object.keys(p)[0], 'steps') // 2000자로 자를 때 먼저 남도록
})

test('이름 있는 값(파일 등)은 그대로 두고, 글 없는 단계·오래된 단계는 뺀다', () => {
  const earlier = [...Array(8)].map((_, i) => ({ task: `단계${i}`, text: i === 7 ? '' : `글${i}` }))
  const p = mapPrev(null, { document: { name: '정산서.docx' }, result: 'x' }, earlier)
  assert.deepEqual(p.document, { name: '정산서.docx' })
  assert.deepEqual(p.steps.map((s) => s.step), ['단계1', '단계2', '단계3', '단계4', '단계5', '단계6'])
  assert.deepEqual(mapPrev({ a: 1 }, {}, []), { a: 1 })
})
