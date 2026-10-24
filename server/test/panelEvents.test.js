// 이벤트 소싱 패널 앱: replay 결정성, 취소 계산, 시트 왕복(SUMIFS), 기존 기록 고치기 거절,
// 기본 보안(민감도 하한·db 단계 강제·k-익명 합계) — 서버·DB 없이
import test from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import * as E from '../lib/panelApps/events.js'
import * as PV from '../lib/panelApps/privacy.js'
import { normalizeDef } from '../lib/panelApps/sheet.js'

const raw = {
  kind: 'events', title: '휴가 관리', entity: { key: 'member', label: '팀원', type: 'person' },
  fields: [{ key: 'days', label: '일수', type: 'number' }, { key: 'start', label: '시작일', type: 'date' }, { key: 'reason', label: '사유', type: 'longtext', sensitivity: 'public' }],
  events: [
    { type: 'grant', label: '휴가 부여', fields: ['days'], required: ['days'], manager: true },
    { type: 'request', label: '휴가 신청', fields: ['start', 'days', 'reason'], required: ['days'] },
    { type: 'cancel', label: '휴가 취소', fields: [], ref: { types: ['request'], mode: 'cancel', inherit: ['days'] } },
  ],
  projections: [
    { kind: 'balance', key: 'summary', label: '요약', columns: [{ key: 'granted', label: '부여', terms: [{ event: 'grant', field: 'days' }] }, { key: 'used', label: '사용', terms: [{ event: 'request', field: 'days' }, { event: 'cancel', field: 'days', sign: -1 }] }], computed: [{ key: 'left', label: '남은 일수', expr: 'granted - used' }] },
    { kind: 'open', key: 'pending', label: '신청 현황', event: 'request' },
  ],
  views: { main: 'summary', value: 'left', valueSuffix: '일' },
}
const def = E.normalizeEventsDef(raw, { secure: true })
const A = 'aaaaaaaa-0000-0000-0000-000000000001', B = 'bbbbbbbb-0000-0000-0000-000000000002'
const log = [
  { seq: 1, id: 'e1', at: '2026-10-01T00:00:00Z', by: 'm', type: 'grant', entity: A, ref: null, days: 15 },
  { seq: 2, id: 'e2', at: '2026-10-02T00:00:00Z', by: A, type: 'request', entity: A, ref: null, days: 3, start: '2026-11-03', reason: '병원' },
  { seq: 3, id: 'e3', at: '2026-10-03T00:00:00Z', by: A, type: 'request', entity: A, ref: null, days: 1, start: '2026-11-10', reason: '' },
  { seq: 4, id: 'e4', at: '2026-10-04T00:00:00Z', by: A, type: 'cancel', entity: A, ref: 'e2', days: 3 },
  { seq: 5, id: 'e5', at: '2026-10-05T00:00:00Z', by: 'm', type: 'grant', entity: B, ref: null, days: 10 },
]

test('보안 하한: 사유는 모델이 public 이라 해도 민감, db 단계, 쓰기 기본값', () => {
  assert.equal(def.fields.find((f) => f.key === 'reason').sensitivity, 'sensitive')
  assert.equal(def.tier, 'db')
  assert.deepEqual(def.events.find((e) => e.type === 'grant').who, ['role>=editor'])
  assert.deepEqual(def.events.find((e) => e.type === 'request').who, ['subject_is_me', 'role>=editor'])
  assert.deepEqual(def.events.find((e) => e.type === 'cancel').who, ['owner_of_ref', 'role>=owner'])
  const list = normalizeDef({ title: '고객', fields: [{ key: 'name', label: '이름' }, { key: 'phone', label: '연락처', type: 'phone' }, { key: 'pay', label: '연봉', type: 'number' }] }, { secure: true })
  assert.equal(list.fields.find((f) => f.key === 'phone').sensitivity, 'personal')
  assert.equal(list.fields.find((f) => f.key === 'pay').sensitivity, 'sensitive')
  assert.equal(list.tier, 'db')
  const simple = normalizeDef({ title: '할일', fields: [{ key: 'task', label: '할 일' }, { key: 'due', label: '마감', type: 'date' }] }, { secure: true })
  assert.equal(simple.tier, 'sheet')
})

test('replay: 취소는 원래 신청의 일수를 되돌린다, 순서와 무관하게 같은 결과', () => {
  const r1 = E.replay(def, log)
  const a = r1.projections.summary.find((x) => x.entity === A)
  assert.deepEqual([a.granted, a.used, a.left], [15, 1, 14])
  assert.deepEqual(r1.projections.pending.map((e) => e.id), ['e3'])
  assert.equal(r1.closedBy.e2.type, 'cancel')
  const shuffled = [log[3], log[0], log[4], log[2], log[1]]
  assert.deepEqual(E.replay(def, shuffled).projections, r1.projections)
  // the same cancel twice counts once in closedBy (the database refuses the second one)
  assert.equal(E.replay(def, [...log, { ...log[3], seq: 6, id: 'e6' }]).closedBy.e2.id, 'e4')
})

test('시트: 이벤트 탭 + 요약 탭(SUMIFS) 왕복, 다시 읽어도 같은 기록', async () => {
  const names = (id) => ({ [A]: '김민지', [B]: '이준호', m: '박지수' }[id] || id)
  const wb = await E.eventsBook(def, log, { names })
  const sum = wb.getWorksheet('요약')
  assert.equal(String(sum.getCell('C2').value.formula), `SUMIFS('이벤트'!$G:$G,'이벤트'!$D:$D,"휴가 신청",'이벤트'!$E:$E,$A2)-SUMIFS('이벤트'!$G:$G,'이벤트'!$D:$D,"휴가 취소",'이벤트'!$E:$E,$A2)`)
  assert.equal(sum.getCell('D2').value.result, 14)
  const back = new ExcelJS.Workbook(); await back.xlsx.load(await wb.xlsx.writeBuffer())
  const ids = (n) => ({ 김민지: A, 이준호: B, 박지수: 'm' }[n] || n)
  const read = E.readLog(back, def, { ids })
  assert.deepEqual(read.map((e) => [e.id, e.type, e.entity, e.ref || null, e.days]), log.map((e) => [e.id, e.type, e.entity, e.ref, e.days]))
})

test('기존 기록 고치기·지우기는 거절, 맨 아래 새 줄만 추가', () => {
  const saved = [{ ...log[0], days: 30 }, log[1], log[2], log[3], { id: '', type: 'request', entity: B, ref: null, days: 2 }]
  const { added, rejected } = E.diffLog(def, log, saved)
  assert.equal(added.length, 1)
  assert.equal(rejected.length, 2) // e1 changed, e5 removed
  assert.match(rejected.find((r) => r.id === 'e1').reason, /고칠 수 없어요/)
  assert.match(rejected.find((r) => r.id === 'e5').reason, /지울 수 없어요/)
})

test('기록 검증: 종류별 항목만, 취소는 대상의 일수를 물려받음', () => {
  assert.throws(() => E.validateEvent(def, { type: 'request', entity: A, values: {} }), /일수/)
  const c = E.validateEvent(def, { type: 'cancel', ref: 'e2' }, { refEvent: log[1] })
  assert.equal(c.entity, A); assert.equal(c.values.days, 3)
  assert.throws(() => E.validateEvent(def, { type: 'cancel', ref: 'e1' }, { refEvent: log[0] }), /기록에만/)
  const g = E.validateEvent(def, { type: 'grant', entity: A, values: { days: 5, reason: '몰래 넣기' } })
  assert.equal(g.values.reason, undefined)
})

test('k-익명: 민감 숫자 합계는 3명 미만이면 숨김, 다른 사람 값은 가림', () => {
  const d2 = E.normalizeEventsDef({ ...raw, fields: [...raw.fields, { key: 'pay', label: '성과급', type: 'number' }], events: [...raw.events, { type: 'bonus', label: '성과급 지급', fields: ['pay'], manager: true }],
    projections: [{ kind: 'balance', key: 'money', label: '보상', columns: [{ key: 'paid', label: '성과급', terms: [{ event: 'bonus', field: 'pay' }] }, { key: 'days', label: '부여', terms: [{ event: 'grant', field: 'days' }] }] }], views: { main: 'money' } }, { secure: true })
  assert.equal(d2.fields.find((f) => f.key === 'pay').sensitivity, 'sensitive')
  const ev = [{ seq: 1, id: 'b1', type: 'bonus', entity: A, pay: 100 }, { seq: 2, id: 'b2', type: 'bonus', entity: B, pay: 200 }, { seq: 3, id: 'g', type: 'grant', entity: A, days: 5 }]
  const mine = E.replay(d2, ev).projections, full = E.replay(d2, ev).projections
  const t = E.maskBalances(d2, mine, full, { id: A, rank: 2 })
  assert.equal(t.money.paid, null, '2명뿐이라 팀 합계 숨김')
  assert.equal(t.money.days, 5)
  assert.equal(mine.money.find((r) => r.entity === A).paid, 100, '내 값은 보임')
  assert.equal(mine.money.find((r) => r.entity === B).paid, null, '남의 값은 가림')
  const ev3 = [...ev, { seq: 4, id: 'b3', type: 'bonus', entity: 'c', pay: 300 }]
  const t3 = E.maskBalances(d2, E.replay(d2, ev3).projections, E.replay(d2, ev3).projections, { id: A, rank: 2 })
  assert.equal(t3.money.paid, 600, '3명이면 팀 합계만 보임')
})

test('개인정보 카드: 숨겨지는 항목과 이유', () => {
  const lines = PV.describePrivacy(def)
  assert.ok(lines.some((l) => l.field === 'reason' && /민감 정보.*본인.*폴더 소유자/.test(l.text)))
  assert.ok(lines.some((l) => l.kind === 'history'))
  assert.ok(lines.some((l) => l.kind === 'tier'))
})

test('DB 컴파일: 기록 표는 추가만(수정·삭제 정책·권한 없음), 민감 열은 표에서 select 권한 없음', () => {
  const sql = E.createEventsSql(def, '11111111-2222-3333-4444-555555555555', '99999999-8888-7777-6666-555555555555').join('\n')
  assert.match(sql, /raise exception using errcode = '42501', message = 'panel_append_only'/)
  assert.doesNotMatch(sql, /for update|for delete|grant update|grant delete/)
  assert.match(sql, /grant insert on panel_data/)
  const sel = sql.match(/grant select \(([^)]*)\) on panel_data\."app_[0-9a-f]+" to authenticated/)[1]
  assert.ok(!sel.includes('c_reason') && sel.includes('c_days'))
  assert.match(sql, /case when .*then e\."c_reason" end as "c_reason"/)
})

test('목록 앱 → 기록 앱 전환: 행마다 부여·신청 기록을 만들고(0 은 건너뜀), replay 결과가 같음', async () => {
  const { migrateRows } = await import('../lib/panelApps/service.js')
  const rows = [{ name: A, granted: 15, used: 3, _created_by: 'm' }, { name: B, granted: 10, used: 0 }]
  const evs = migrateRows(def, rows, { entity: 'name', events: [{ type: 'grant', from: { days: 'granted' } }, { type: 'request', from: { days: 'used' } }] }, { owner: 'owner' })
  assert.deepEqual(evs.map((e) => [e.type, e.entity, e.days, e.by]), [['grant', A, 15, 'm'], ['request', A, 3, 'm'], ['grant', B, 10, 'owner']])
  assert.ok(evs.every((e) => e._migrated))
  const s = E.replay(def, evs).projections.summary
  assert.deepEqual(s.map((x) => [x.entity, x.left]), [[A, 12], [B, 10]])
})
