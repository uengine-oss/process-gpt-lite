// 패널 앱 — 시트 단계(공유 폴더 xlsx 원본)·행 등록/수정/동시 수정·시트 왕복·공유·채팅 도구(MCP)·
// db 단계 규칙 어휘·이벤트 소싱(취소·재계산·추가만). (spec pgpt-pro_panel-apps · 영상 youtu.be/sXCp1JerNYQ, YAlt_TRWhaE, 5U4pDgw2kiU)
import ExcelJS from 'exceljs'
import { test, expect, RUN, api } from '../../lib/fixtures.js'
import { makeApp, addMember } from '../../lib/panel.js'
import { MIME } from '../../lib/seed.js'

const LEAVE = {
  title: `회귀 휴가 일수 ${RUN}`, icon: '🏖',
  fields: [
    { key: 'name', label: '이름', type: 'text', required: true },
    { key: 'granted', label: '부여일수', type: 'number', required: true },
    { key: 'used', label: '사용일수', type: 'number', default: 0 },
  ],
  computed: [{ key: 'left', label: '남은 일수', expr: 'granted - used' }],
  views: { list: { title: 'name', value: 'left', valueSuffix: '일' }, summary: [{ label: '인원', agg: 'count', suffix: '명' }] },
}

test.describe('패널 앱 · 시트 단계', () => {
  test('F-PA-01 행 추가·계산 열·필수 누락 거절·동시 수정은 덮어쓰지 않음', async ({ as, lib, db, cleanup }) => {
    const o = await as('pa-owner')
    const { app } = await makeApp(lib, o, { ...LEAVE, title: `${LEAVE.title} A` }).then((x) => { cleanup(() => x.cleanup(db)); return x })
    expect(app.tier).toBe('sheet')
    const add = await o.post(`/panel-apps/${app.id}/rows`, { values: { name: '김민지', granted: 15, used: 3 } })
    expect(add.status, add.text).toBe(200)
    expect(add.body.row.left).toBe(12)
    const miss = await o.post(`/panel-apps/${app.id}/rows`, { values: { used: 1 } })
    expect([400, 422]).toContain(miss.status)
    const row = add.body.row
    const first = await o.put(`/panel-apps/${app.id}/rows/${row._id}`, { _v: row._v, values: { used: 6 } })
    expect(first.status, first.text).toBe(200)
    expect(first.body.row.left).toBe(9)
    const stale = await o.put(`/panel-apps/${app.id}/rows/${row._id}`, { _v: row._v, values: { used: 1 } })
    expect(stale.status, '같은 버전으로 두 번째 수정은 충돌').toBe(409)
    expect((await o.get(`/panel-apps/${app.id}/rows`)).body.rows[0].used).toBe(6)
  })

  test('F-PA-02 원본은 공유 폴더의 xlsx: 폴더에서 보이고, 시트에서 고친 값이 패널에 반영', async ({ as, lib, db, cleanup }) => {
    const o = await as('pa-owner')
    const { app } = await makeApp(lib, o, { ...LEAVE, title: `${LEAVE.title} B` }).then((x) => { cleanup(() => x.cleanup(db)); return x })
    await o.post(`/panel-apps/${app.id}/rows`, { values: { name: '김민지', granted: 15, used: 3 } })
    const tree = JSON.stringify((await o.get(`/folders/${app.folder.slug}/tree`)).body)
    expect(tree).toContain('.xlsx')
    expect(tree).toContain('.panel.json')
    // open the sheet copy (what IeumOffice loads), change 사용일수 3 → 6, save back
    const sheet = await o.post(`/panel-apps/${app.id}/sheet`)
    expect(sheet.status, sheet.text).toBe(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(await (await fetch(sheet.body.url)).arrayBuffer()))
    const ws = wb.worksheets[0]
    const header = ws.getRow(1).values
    const col = header.indexOf('사용일수')
    expect(col).toBeGreaterThan(0)
    ws.getRow(2).getCell(col).value = 6
    const saved = await api.upload(o.token(), 'sheet.xlsx', MIME.xlsx, Buffer.from(await wb.xlsx.writeBuffer()))
    const back = await o.post(`/panel-apps/${app.id}/sheet-saved`, { url: saved.url, sha: sheet.body.sha })
    expect(back.status, back.text).toBe(200)
    const r = (await o.get(`/panel-apps/${app.id}/rows`)).body.rows[0]
    expect(r.used).toBe(6)
    expect(r.left).toBe(9)
  })

  test('F-PA-03 폴더 구성원과 공유: 구성원은 Home 에 보이고 쓰고, 구성원이 아니면 못 본다', async ({ as, lib, db, cleanup }) => {
    const o = await as('pa-owner'), m = await as('pa-m1'), out = await as('pa-out')
    const { app } = await makeApp(lib, o, { ...LEAVE, title: `${LEAVE.title} C` }).then((x) => { cleanup(() => x.cleanup(db)); return x })
    expect((await out.get(`/panel-apps/${app.id}/rows`)).status).toBeGreaterThanOrEqual(403)
    expect((await out.get('/panel-apps')).body.some((a) => a.id === app.id)).toBe(false)
    expect((await addMember(o, app.folder.slug, m, 'editor')).status).toBe(200)
    expect((await m.get('/panel-apps')).body.some((a) => a.id === app.id)).toBe(true)
    expect((await m.post(`/panel-apps/${app.id}/rows`, { values: { name: '박서연', granted: 10 } })).status).toBe(200)
    // MCP (the chat's agent tools) with the member's JWT: same app, same rows
    const r = await api.mcp('/mcp/panelapps', 'tools/call', { name: 'panel_app_add_row', arguments: { app: app.title, values: { 이름: '채팅추가', 부여일수: 5 } } }, m.token())
    expect(r.body.result.isError, api.toolText(r)).toBeFalsy()
    expect((await o.get(`/panel-apps/${app.id}/rows`)).body.rows.map((x) => x.name)).toEqual(expect.arrayContaining(['박서연', '채팅추가']))
    const r2 = await api.mcp('/mcp/panelapps', 'tools/call', { name: 'panel_app_rows', arguments: { app: app.title } }, out.token())
    expect(r2.body.result.isError).toBe(true)
  })
})

test.describe('패널 앱 · db 단계와 기록(이벤트)', () => {
  test('F-PA-04 규칙은 정해진 어휘만: 이름·값 주입 시도는 거절', async ({ as, lib, db, cleanup }) => {
    const o = await as('pa-owner')
    const { app } = await makeApp(lib, o, {
      title: `회귀 규칙 ${RUN}`, tier: 'db',
      fields: [{ key: 'title', label: '제목', type: 'text', required: true }, { key: 'state', label: '상태', type: 'choice', choices: ['열림', '닫힘'] }],
      access: { read: ['member'], create: ['member'], update: ['owner_of_row'], delete: ['owner_of_row'] },
    }).then((x) => { cleanup(() => x.cleanup(db)); return x })
    for (const bad of [
      { access: { read: ["member; drop table pro_folders; --"] } },
      { access: { read: [{ field_equals: { field: 'title\"); drop table x; --', value: 'a' } }] } },
      { access: { read: [{ raw_sql: 'true' }] } },
    ]) {
      const r = await o.put(`/panel-apps/${app.id}/rules`, bad)
      expect(r.status, JSON.stringify(bad)).toBe(400)
    }
    expect((await db.q(`select to_regclass('public.pro_folders') as t`))[0].t).toBe('pro_folders')
    const ok = await o.put(`/panel-apps/${app.id}/rules`, { access: { read: ['member'], create: ['member'], update: ['owner_of_row', 'role>=owner'], delete: ['owner_of_row'] } })
    expect(ok.status, ok.text).toBe(200)
    expect((await o.get(`/panel-apps/${app.id}/migrations`)).body.length).toBeGreaterThan(0)
  })

  test('F-PA-05 db 단계: 본인 행 삭제 — 화면과 같은 주소(_v 를 인코딩하지 않음)로도 지워진다', async ({ as, lib, db, cleanup }) => {
    const o = await as('pa-owner')
    const { app } = await makeApp(lib, o, {
      title: `회귀 삭제 ${RUN}`, tier: 'db', fields: [{ key: 'title', label: '제목', type: 'text', required: true }],
      access: { read: ['member'], create: ['member'], update: ['owner_of_row'], delete: ['owner_of_row'] },
    }).then((x) => { cleanup(() => x.cleanup(db)); return x })
    const r = await o.post(`/panel-apps/${app.id}/rows`, { values: { title: '지울 행' } })
    const row = (await o.get(`/panel-apps/${app.id}/rows`)).body.rows.find((x) => x.title === '지울 행')
    expect(r.status).toBe(200)
    // PanelAppCard.vue sends `?_v=${editing._v}` as is
    const del = await o.del(`/panel-apps/${app.id}/rows/${encodeURIComponent(row._id)}?_v=${row._v}`)
    expect(del.status, `_v=${row._v} → ${del.text}`).toBe(200)
  })

  test('F-PA-06 휴가 부여·신청·취소: 요약은 기록을 다시 계산, 기록은 고칠 수 없고 취소는 한 번만', async ({ as, lib, db, cleanup }) => {
    const o = await as('pa-owner'), m = await as('pa-m1'), m2 = await as('pa-m2')
    const { app } = await makeApp(lib, o, {
      title: `회귀 휴가 기록 ${RUN}`, entity: { key: 'member', label: '팀원', type: 'person' },
      fields: [{ key: 'days', label: '일수', type: 'number' }, { key: 'reason', label: '사유', type: 'longtext' }],
      events: [
        { type: 'grant', label: '휴가 부여', fields: ['days'], required: ['days'], manager: true },
        { type: 'request', label: '휴가 신청', fields: ['days', 'reason'], required: ['days'] },
        { type: 'cancel', label: '휴가 취소', fields: [], ref: { types: ['request'], mode: 'cancel', inherit: ['days'] } },
      ],
      projections: [{ kind: 'balance', key: 'summary', label: '요약', columns: [
        { key: 'granted', label: '부여', terms: [{ event: 'grant', field: 'days' }] },
        { key: 'used', label: '사용', terms: [{ event: 'request', field: 'days' }, { event: 'cancel', field: 'days', sign: -1 }] }],
      computed: [{ key: 'left', label: '남은', expr: 'granted - used' }] }],
    }, { events: true }).then((x) => { cleanup(() => x.cleanup(db)); return x })
    for (const u of [m, m2]) await addMember(o, app.folder.slug, u, 'runner')
    expect((await m.post(`/panel-apps/${app.id}/events`, { type: 'grant', entity: m.id, values: { days: 30 } })).status, '스스로 부여는 불가').toBeGreaterThanOrEqual(403)
    expect((await o.post(`/panel-apps/${app.id}/events`, { type: 'grant', entity: m.id, values: { days: 15 } })).status).toBe(200)
    const r1 = await m.post(`/panel-apps/${app.id}/events`, { type: 'request', entity: m.id, values: { days: 1, reason: '병원' } })
    const r3 = await m.post(`/panel-apps/${app.id}/events`, { type: 'request', entity: m.id, values: { days: 3, reason: '여행' } })
    expect(r1.status).toBe(200); expect(r3.status).toBe(200)
    expect((await m2.post(`/panel-apps/${app.id}/events`, { type: 'cancel', ref: r3.body.event.id })).status, '남의 신청 취소 불가').toBeGreaterThanOrEqual(403)
    const c = await m.post(`/panel-apps/${app.id}/events`, { type: 'cancel', ref: r3.body.event.id })
    expect(c.status, c.text).toBe(200)
    expect((await m.post(`/panel-apps/${app.id}/events`, { type: 'cancel', ref: r3.body.event.id })).status, '취소는 한 번만').toBe(409)
    const v = (await m.get(`/panel-apps/${app.id}/rows`)).body
    const mine = v.projections.summary.find((x) => x.entity === m.id)
    expect(mine).toMatchObject({ granted: 15, used: 1, left: 14 })
    expect(v.events.find((e) => e.id === r3.body.event.id).closedBy).toBeTruthy()
    // rows API refuses edits on an events app
    expect((await m.post(`/panel-apps/${app.id}/rows`, { values: { days: 1 } })).status).toBe(400)
  })
})

test.describe('패널 앱 · 보안 기본값 확인', () => {
  test('F-PA-08 만든 사람이 보안 기본값을 확인하고, 민감도를 낮추려면 한 번 더 확인(감사 기록)', async ({ as, lib, db, cleanup }) => {
    const o = await as('pa-owner'), m = await as('pa-m1')
    const { app } = await makeApp(lib, o, {
      title: `회귀 사유 ${RUN}`, entity: { key: 'member', label: '팀원', type: 'person' },
      fields: [{ key: 'days', label: '일수', type: 'number' }, { key: 'reason', label: '사유', type: 'longtext' }],
      events: [{ type: 'request', label: '휴가 신청', fields: ['days', 'reason'], required: ['days'] }],
      projections: [{ kind: 'balance', key: 'summary', label: '요약', columns: [{ key: 'used', label: '사용', terms: [{ event: 'request', field: 'days' }] }] }],
    }, { events: true }).then((x) => { cleanup(() => x.cleanup(db)); return x })
    expect(app.privacyAck).toBe(false)
    expect(app.privacy.map((l) => l.text).join(' ')).toMatch(/사유/)
    await addMember(o, app.folder.slug, m, 'runner')
    expect((await m.post(`/panel-apps/${app.id}/privacy-ack`)).status, '소유자만').toBe(403)
    expect((await o.post(`/panel-apps/${app.id}/privacy-ack`)).status).toBe(200)
    expect((await o.get('/panel-apps')).body.find((a) => a.id === app.id).privacyAck).toBe(true)
    const low = await o.put(`/panel-apps/${app.id}/sensitivity`, { field: 'reason', level: 'internal' })
    expect(low.status).toBe(409)
    expect(low.body.needConfirm).toBe(true)
    expect((await o.put(`/panel-apps/${app.id}/sensitivity`, { field: 'reason', level: 'internal', confirm: true })).status).toBe(200)
    const [a] = await db.q(`select count(*)::int as n from pro_panel_app_audit where app_id=$1 and action='loosen'`, [app.id])
    expect(a.n).toBe(1)
  })
})

test.describe('패널 앱 · 화면', () => {
  test('F-PA-07 Home 패널 카드: 앱 제목·행·계산 값이 보인다', async ({ pageAs, lib, db, cleanup }) => {
    const page = await pageAs('pa-owner')
    const o = page.user
    const { app } = await makeApp(lib, o, { ...LEAVE, title: `${LEAVE.title} UI` }).then((x) => { cleanup(() => x.cleanup(db)); return x })
    await o.post(`/panel-apps/${app.id}/rows`, { values: { name: '화면확인', granted: 15, used: 4 } })
    await page.goto('/chat')
    const card = page.locator('.dock').getByText(app.title).first()
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.dock')).toContainText('화면확인')
    await expect(page.locator('.dock')).toContainText('11')
    expect(page.errors).toEqual([])
  })

  test('F-PA-09 Home 패널 카드(db 단계)에서 내 행을 지운다', async ({ pageAs, lib, db, cleanup }) => {
    const page = await pageAs('pa-owner')
    const o = page.user
    const { app } = await makeApp(lib, o, {
      title: `회귀 화면 삭제 ${RUN}`, tier: 'db', fields: [{ key: 'title', label: '제목', type: 'text', required: true }],
      access: { read: ['member'], create: ['member'], update: ['owner_of_row'], delete: ['owner_of_row'] },
    }).then((x) => { cleanup(() => x.cleanup(db)); return x })
    await o.post(`/panel-apps/${app.id}/rows`, { values: { title: '화면에서 지울 행' } })
    await page.goto('/chat')
    const card = page.locator('.dock .pa, .dock [class*="panel"]').filter({ hasText: app.title }).first()
    await card.getByText('화면에서 지울 행').click()
    page.once('dialog', (d) => d.accept())
    await page.locator('.form .acts .danger').click()
    await expect(page.locator('.form .err')).toHaveCount(0, { timeout: 5000 })
    await expect(page.locator('.dock').getByText('화면에서 지울 행')).toHaveCount(0)
  })
})
