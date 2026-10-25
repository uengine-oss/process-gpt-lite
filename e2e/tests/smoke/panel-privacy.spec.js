// 패널 앱 기본 보안 — 데이터베이스가 남의 행을 막고(RLS), 민감 항목은 가리고, 민감 숫자의 팀 합계는 3명 이상일 때만.
// (spec panel-apps: 남의 행은 데이터베이스가 막는다 · 항목마다 민감도 · 민감한 숫자의 팀 합계는 세 명 이상일 때만)
import { test, expect, RUN } from '../../lib/fixtures.js'
import { makeApp, addMember } from '../../lib/panel.js'

test.describe.configure({ mode: 'serial' })

test('S-40 공유 캘린더(db 단계): 남의 행 수정·삭제는 거절, 비공개 행은 본인만', async ({ as, lib, db, cleanup }) => {
  const o = await as('pa-owner'), a = await as('pa-m1'), b = await as('pa-m2')
  const { app } = await makeApp(lib, o, {
    title: `회귀 캘린더 ${RUN}`, tier: 'db',
    fields: [{ key: 'title', label: '제목', type: 'text', required: true }, { key: 'visibility', label: '공개 범위', type: 'choice', choices: ['공개', '비공개'] }],
    access: { read: ['owner_of_row', { field_equals: { field: 'visibility', value: '공개' } }], create: ['member'], update: ['owner_of_row'], delete: ['owner_of_row'] },
  }).then((x) => { cleanup(() => x.cleanup(db)); return x })
  for (const u of [a, b]) expect((await addMember(o, app.folder.slug, u)).status).toBe(200)
  const ra = await a.post(`/panel-apps/${app.id}/rows`, { values: { title: 'A 공개 회의', visibility: '공개' } })
  expect(ra.status, ra.text).toBe(200)
  const rb = await b.post(`/panel-apps/${app.id}/rows`, { values: { title: 'B 병원 진료', visibility: '비공개' } })
  expect(rb.status, rb.text).toBe(200)
  const rowsOf = async (u) => (await u.get(`/panel-apps/${app.id}/rows`)).body.rows
  const aRow = (await rowsOf(a)).find((r) => r.title === 'A 공개 회의')
  const bSees = (await rowsOf(b)).map((r) => r.title)
  expect(bSees).toEqual(expect.arrayContaining(['A 공개 회의', 'B 병원 진료']))
  expect((await rowsOf(a)).map((r) => r.title)).not.toContain('B 병원 진료')
  expect((await rowsOf(o)).map((r) => r.title)).not.toContain('B 병원 진료') // not even the owner
  const upd = await b.put(`/panel-apps/${app.id}/rows/${aRow._id}`, { _v: aRow._v, values: { title: 'B 가 덮어씀' } })
  expect(upd.status).toBe(403)
  const del = await b.del(`/panel-apps/${app.id}/rows/${aRow._id}?_v=${encodeURIComponent(aRow._v)}`)
  expect(del.status).toBe(403)
  expect((await rowsOf(a)).find((r) => r._id === aRow._id).title).toBe('A 공개 회의')
})

test('S-41 휴가(이벤트): 남의 사유는 비공개, 민감 숫자 합계는 3명 이상부터', async ({ as, lib, db, cleanup }) => {
  const o = await as('pa-owner'), m1 = await as('pa-m1'), m2 = await as('pa-m2'), m3 = await as('pa-m3')
  const { app } = await makeApp(lib, o, {
    title: `회귀 성과급 ${RUN}`, entity: { key: 'member', label: '팀원', type: 'person' },
    fields: [{ key: 'amount', label: '금액', type: 'number', sensitivity: 'sensitive' }, { key: 'reason', label: '사유', type: 'longtext', sensitivity: 'sensitive' }],
    events: [{ type: 'grant', label: '지급', fields: ['amount', 'reason'], required: ['amount'], manager: true }],
    projections: [{ kind: 'balance', key: 'summary', label: '요약', columns: [{ key: 'total', label: '합계', terms: [{ event: 'grant', field: 'amount' }] }] }],
  }, { events: true }).then((x) => { cleanup(() => x.cleanup(db)); return x })
  for (const u of [m1, m2, m3]) expect((await addMember(o, app.folder.slug, u, 'runner')).status).toBe(200)
  const grant = (u, amount) => o.post(`/panel-apps/${app.id}/events`, { type: 'grant', entity: u.id, values: { amount, reason: `RT 비밀 사유 ${u.email}` } })
  expect((await grant(m1, 100)).status).toBe(200)
  expect((await grant(m2, 200)).status).toBe(200)
  const view = async (u) => (await u.get(`/panel-apps/${app.id}/rows`)).body
  let v = await view(m1)
  expect(v.totals.summary.total, '2명이면 팀 합계 없음').toBeNull()
  const other = v.events.find((e) => e.entity === m2.id)
  expect(other.reason).toBe('')
  expect(other._hidden).toEqual(expect.arrayContaining(['reason']))
  expect(JSON.stringify(v)).not.toContain(`RT 비밀 사유 ${m2.email}`)
  expect(v.events.find((e) => e.entity === m1.id).reason).toBe(`RT 비밀 사유 ${m1.email}`)
  expect((await grant(m3, 300)).status).toBe(200)
  v = await view(m1)
  expect(v.totals.summary.total, '3명이면 합계가 보인다').toBe(600)
  // a member cannot grant (manager-only event type)
  expect((await m1.post(`/panel-apps/${app.id}/events`, { type: 'grant', entity: m1.id, values: { amount: 999 } })).status).toBeGreaterThanOrEqual(400)
})
