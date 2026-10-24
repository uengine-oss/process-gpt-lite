// 패널 앱 시트 모듈: 정의 보정, 계산 식, xlsx 행 추가·수정·충돌(409)·검증(422)
import test from 'node:test'
import assert from 'node:assert/strict'
import * as X from '../lib/panelApps/sheet.js'

const def = X.normalizeDef({
  title: '휴가 일수 관리', sheet: '휴가',
  fields: [{ key: 'name', label: '이름', type: 'text', required: true }, { key: 'team', label: '팀', type: 'choice', choices: ['영업', '개발'] },
    { key: 'granted', label: '부여 일수', type: 'number', default: 15 }, { key: 'used', label: '사용 일수', type: 'number', default: 0 }],
  computed: [{ key: 'left', label: '남은 일수', expr: 'granted - used' }, { key: 'bad', label: '잘못', expr: 'name * 2' }],
  views: { list: { title: 'name', value: 'left' } },
})

test('정의 보정: 숫자 아닌 필드를 쓰는 계산 열은 버린다', () => {
  assert.deepEqual(def.computed.map((c) => c.key), ['left'])
  assert.equal(def.views.summary[0].agg, 'count')
})

test('행 추가·읽기·수정·충돌', async () => {
  let wb = await X.newBook(def, [X.validate(def, { name: '김민지', team: '영업', used: 3 })])
  X.applyOp(wb, def, { add: X.validate(def, { 이름: '이준호', 팀: '개발', '부여 일수': '20', used: 1 }) })
  wb = await X.readBook(await X.bookBuffer(wb))
  const rows = X.readRows(wb, def)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].left, 12)
  assert.equal(rows[1].left, 19)
  X.applyOp(wb, def, { update: { id: rows[0]._id, v: rows[0]._v, vals: { used: 5 } } })
  assert.equal(X.readRows(wb, def)[0].left, 10)
  assert.throws(() => X.applyOp(wb, def, { update: { id: rows[0]._id, v: rows[0]._v, vals: { used: 6 } } }), (e) => e.status === 409)
})

test('검증: 필수·선택지', () => {
  assert.throws(() => X.validate(def, { team: '마케팅' }), (e) => e.status === 422 && e.problems.length === 2)
})
