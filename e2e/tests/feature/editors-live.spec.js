// 편집기와 라이브 공동 편집 — 카드를 누르면 그 자리에서 편집기(이음오피스·ArtCraft 5종)가 열리고 "대화와 연결됨",
// 열린 동안 에이전트 도구(MCP)는 열린 화면을 직접 고친다. 저장하면 편집본이 원본 옆에, 카드는 편집본을 가리킨다.
// (spec pgpt-pro_office-editor · pgpt-pro_craft-apps · 영상 youtu.be/39F2rgTL5B0, izcVNcW37J0, QyfrjwhBSsw …)
import { test, expect, api } from '../../lib/fixtures.js'
import { PNG, SVG, DXF, WAV, MP4, XLSX, MIME } from '../../lib/seed.js'

async function seedFiles(db, u) {
  const th = await db.clearMain(u.id)
  const tok = u.token()
  const files = [
    ['예산표.xlsx', MIME.xlsx, await XLSX([['항목', '금액'], ['대관', 300000], ['다과', 120000]])],
    ['썸네일.png', MIME.png, PNG()],
    ['배너.svg', MIME.svg, SVG('회귀 배너')],
    ['평면도.dxf', MIME.dxf, DXF],
    ['알림음.wav', MIME.wav, WAV()],
  ]
  const mp4 = await MP4()
  if (mp4) files.push(['티저.mp4', MIME.mp4, mp4])
  const out = {}
  for (const [name, type, buf] of files) out[name] = { name, url: (await api.upload(tok, name, type, buf)).url }
  const msgs = await db.addMessages(th, Object.values(out).map((c) => ({ role: 'agent', kind: 'file', content: c })))
  for (const m of msgs) out[m.content.name].msg = m
  return { th, files: out }
}
const openCard = async (page, name) => { await page.locator('button.file', { hasText: name }).first().click() }

test.describe('이음오피스 편집기 (spec office-editor)', () => {
  test('F-ED-01 엑셀 카드 → 시트 편집기, 대화와 연결됨, 열린 동안만 office_live 도구', async ({ pageAs, db }) => {
    const page = await pageAs('ed-office')
    const tok = page.user.token()
    await seedFiles(db, page.user)
    await page.goto('/chat')
    // before anything is open: one small idle tool
    const idle = (await api.mcp('/mcp/office', 'tools/list', {}, tok)).body.result.tools.map((t) => t.name)
    expect(idle).toEqual(['office_live_status'])
    await openCard(page, '예산표.xlsx')
    await expect(page.locator('.oef iframe.frm')).toHaveAttribute('src', /^\/office\/sheets\/\?src=/)
    await expect(page.locator('.oef .badge.live')).toContainText('대화와 연결됨', { timeout: 30_000 })
    const tools = (await api.mcp('/mcp/office', 'tools/list', {}, tok)).body.result.tools.map((t) => t.name)
    expect(tools).toEqual(expect.arrayContaining(['office_live_documents', 'office_live_read', 'office_live_apply_ops']))
    const st = JSON.parse(api.toolText(await api.mcp('/mcp/office', 'tools/call', { name: 'office_live_status', arguments: {} }, tok)))
    expect(st).toEqual({ open: true, file: '예산표.xlsx' })
    await page.locator('.oef .tb.ic[title="닫기"]').click()
    await expect.poll(async () => JSON.parse(api.toolText(await api.mcp('/mcp/office', 'tools/call', { name: 'office_live_status', arguments: {} }, tok))).open, { timeout: 10_000 }).toBe(false)
    expect(page.errors).toEqual([])
  })

  test('F-ED-02 열린 엑셀을 도구로 고치면 그 화면의 셀이 바뀐다 (라이브, 저장은 사람)', async ({ pageAs, db }) => {
    const page = await pageAs('ed-office')
    const tok = page.user.token()
    await seedFiles(db, page.user)
    await page.goto('/chat')
    await openCard(page, '예산표.xlsx')
    await expect(page.locator('.oef .badge.live')).toBeVisible({ timeout: 30_000 })
    const call = async (name, args) => { const r = await api.mcp('/mcp/office', 'tools/call', { name, arguments: args }, tok); expect(r.body.result.isError, api.toolText(r)).toBeFalsy(); return api.toolText(r) }
    let doc
    await expect.poll(async () => { doc = JSON.parse(await call('office_live_documents', {})).documents.find((d) => d.file_name === '예산표.xlsx' && d.ready); return !!doc }, { timeout: 30_000 }).toBe(true)
    const ctx = JSON.parse(await call('office_live_read', { session_id: doc.session_id }))
    const ok = await call('office_live_apply_ops', { session_id: doc.session_id, ops: [{ op: 'set_cell', sheetId: ctx.context.sheetId, address: 'B3', value: 135000 }] })
    expect(ok).toContain('"ok": true')
    const back = JSON.parse(await call('office_live_read', { session_id: doc.session_id, addresses: ['B3'] }))
    expect(back.cells.B3.value).toBe(135000)
    // the editor in the page shows it: select B3 there and read the formula bar
    const shown = async () => (await Promise.all(page.frames().map((f) => f.evaluate(() => [document.body?.innerText || '', ...[...document.querySelectorAll('input,textarea')].map((i) => i.value)].join(' ')).catch(() => '')))).join(' ')
    await expect.poll(shown, { timeout: 15_000 }).toMatch(/적용했습니다|135000/)
  })

  test('F-ED-03 편집본 저장: 카드가 편집본을 가리키고 이전 주소는 versions 에, 남의 카드는 못 바꾼다', async ({ as, db }) => {
    const u = await as('ed-office'), other = await as('ed-other')
    const { files } = await seedFiles(db, u)
    const m = files['예산표.xlsx'].msg
    const copy = await api.upload(u.token(), '예산표.xlsx', MIME.xlsx, await XLSX([['항목', '금액'], ['대관', 1]]))
    expect((await other.post(`/messages/${m.id}/file`, { url: copy.url })).status).toBe(404)
    expect((await u.post(`/messages/${m.id}/file`, { url: 'javascript:alert(1)' })).status).toBe(400)
    const r = await u.post(`/messages/${m.id}/file`, { url: copy.url })
    expect(r.status).toBe(200)
    expect(r.body.content).toMatchObject({ url: copy.url, edited: true, versions: [files['예산표.xlsx'].url] })
  })
})

test.describe('누르면 멘션 (click-to-mention · 개발 중 기능)', () => {
  test('F-ED-05 "@ 가리키기" 를 켜고 문서의 범위를 가리키면 입력창에 @멘션 칩, 보내면 메시지 앞에 붙는다', async ({ pageAs, db }) => {
    const page = await pageAs('ed-office')
    await seedFiles(db, page.user)
    await page.goto('/chat')
    await openCard(page, '예산표.xlsx')
    await expect(page.locator('.oef .badge.live')).toBeVisible({ timeout: 60_000 })
    const btn = page.locator('.oef .tb', { hasText: '가리키기' })
    await expect(btn).toBeVisible()
    await btn.click()
    await expect(page.locator('.oef .tb.on')).toContainText('가리키는 중')
    // what office-host's page-live sends for a clicked cell range
    const ed = page.frames().find((f) => f.url().includes('/office/sheets/'))
    await ed.evaluate(() => parent.postMessage({ source: 'ieum-office', type: 'mention', mention: { label: 'B2:B3', kind: 'range', sheet: 'Sheet1', range: 'B2:B3' } }, '*'))
    await expect(page.locator('.composer .mentions .mention').first()).toContainText('B2:B3')
    let sent = null
    await page.route('**/api/threads/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      sent = route.request().postDataJSON()
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' })
    })
    await page.locator('.foot .composer textarea').click()
    await page.keyboard.type('이 범위 합계를 아래에 넣어줘')
    await page.keyboard.press('Enter')
    await expect.poll(() => sent?.text).toBe('@B2:B3 이 범위 합계를 아래에 넣어줘')
    expect(sent.context).toContain('가리킨 대상')
    await expect(page.locator('.composer .mentions .mention')).toHaveCount(0)
  })
})

test.describe('최대화 다이얼 (spec office-editor · craft-apps: 최대화 다이얼)', () => {
  for (const [file, cls] of [['예산표.xlsx', '.oef'], ['배너.svg', '.cef']]) {
    test(`F-ED-04 ${file}: 최대화하면 대화창은 다이얼로 접히고, 누르면 같은 입력창(보내면 이 문서로)`, async ({ pageAs, db }) => {
      const page = await pageAs('ed-office')
      await seedFiles(db, page.user)
      await page.goto('/chat')
      await openCard(page, file)
      await expect(page.locator(`${cls} .badge.live`)).toBeVisible({ timeout: 60_000 })
      if (cls === '.oef') {
        expect(await page.locator('.oef iframe.frm').getAttribute('src')).toContain('assistant=parent') // one assistant: the chat
        // the sheet takes the keyboard focus when it finishes loading: wait for that first
        await expect.poll(async () => JSON.parse(api.toolText(await api.mcp('/mcp/office', 'tools/call', { name: 'office_live_documents', arguments: {} }, page.user.token())) || '{}').documents?.some((d) => d.ready), { timeout: 30_000 }).toBe(true)
        await page.waitForTimeout(1500)
      }
      await page.locator(`${cls} .tb`, { hasText: '최대화' }).click()
      const dial = page.locator('.clo .dial')
      await expect(dial).toBeVisible()
      await dial.click()
      await expect(page.locator('.clo .band textarea')).toBeVisible()
      await expect(page.locator('.clo .band .hint')).toContainText('화면에 바로 적용돼요')
      let sent = null
      await page.route('**/api/threads/*/messages', async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        sent = route.request().postDataJSON()
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' })
      })
      await page.locator('.clo .band textarea').click()
      await page.keyboard.type('제목을 굵게 해줘')
      await page.keyboard.press('Enter')
      await expect.poll(() => sent?.text).toBe('제목을 굵게 해줘')
      await page.keyboard.press('Escape')
      await expect(dial).toBeVisible()
      expect(page.errors).toEqual([])
    })
  }
})

test.describe('ArtCraft 편집기와 라이브 (spec craft-apps)', () => {
  const APPS = [
    ['썸네일.png', 'photocraft', 'photocraft_doc_inspect', {}],
    ['배너.svg', 'vectorcraft', 'vectorcraft_doc_inspect', {}],
    ['평면도.dxf', 'cadcraft', 'cadcraft_inspect_drawing', {}],
    ['알림음.wav', 'soundcraft', 'soundcraft_inspect_session', {}],
    ['티저.mp4', 'filmcraft', 'filmcraft_project_inspect', {}],
  ]
  for (const [file, app, inspect, args] of APPS) {
    test(`F-CR-${app} 카드 → 웹 ${app} 가 같은 출처에서 열리고, 대화와 연결된 동안 도구가 열린 화면을 읽는다`, async ({ pageAs, db }) => {
      const page = await pageAs(`cr-${app}`)
      const tok = page.user.token()
      const { files } = await seedFiles(db, page.user)
      test.skip(!files[file], `${file} 를 만들 수 없음 (ffmpeg)`)
      await page.goto('/chat')
      await openCard(page, file)
      await expect(page.locator('.cef iframe.frm')).toHaveAttribute('src', new RegExp(`^/craft/${app}/`))
      await expect(page.locator('.cef .badge.live')).toContainText('대화와 연결됨', { timeout: 90_000 })
      await api.mcp(`/mcp/${app}`, 'tools/call', { name: `${app}_start`, arguments: {} }, tok)
      const tools = (await api.mcp(`/mcp/${app}`, 'tools/list', {}, tok)).body.result.tools.map((t) => t.name)
      expect(tools).toContain(inspect)
      let txt = ''
      await expect.poll(async () => {
        const r = await api.mcp(`/mcp/${app}`, 'tools/call', { name: inspect, arguments: args }, tok)
        txt = api.toolText(r)
        return !r.body.result.isError
      }, { timeout: 60_000, intervals: [2000] }).toBe(true)
      expect(txt.length).toBeGreaterThan(10)
      expect(page.errors).toEqual([])
    })
  }

  test('F-CR-10 PhotoCraft 라이브: 도구로 레이어를 더하면 열린 문서의 레이어가 는다', async ({ pageAs, db }) => {
    const page = await pageAs('cr-photocraft')
    const tok = page.user.token()
    await seedFiles(db, page.user)
    await page.goto('/chat')
    await openCard(page, '썸네일.png')
    await expect(page.locator('.cef .badge.live')).toBeVisible({ timeout: 90_000 })
    await api.mcp('/mcp/photocraft', 'tools/call', { name: 'photocraft_start', arguments: {} }, tok)
    const layers = async () => {
      const r = await api.mcp('/mcp/photocraft', 'tools/call', { name: 'photocraft_doc_inspect', arguments: {} }, tok)
      if (r.body.result.isError) return -1
      const j = JSON.parse(api.toolText(r))
      return (j.layers || j.document?.layers || []).length
    }
    await expect.poll(layers, { timeout: 60_000, intervals: [2000] }).toBeGreaterThan(0)
    const n = await layers()
    const run = await api.mcp('/mcp/photocraft', 'tools/call', { name: 'photocraft_command_run', arguments: { id: 'layer.new.layer' } }, tok)
    expect(run.body.result.isError, api.toolText(run)).toBeFalsy()
    await expect.poll(layers, { timeout: 20_000 }).toBe(n + 1)
    // the page shows the agent working on it (busy badge) at most briefly, and the doc is now dirty
    await expect(page.locator('.cef .badge.warn')).toBeVisible({ timeout: 15_000 })
  })

  test('F-CR-11 앱이 저장하면 편집본이 올라가고 채팅 카드가 편집본을 가리킨다', async ({ pageAs, db }) => {
    const page = await pageAs('cr-photocraft')
    const { th, files } = await seedFiles(db, page.user)
    await page.goto('/chat')
    await openCard(page, '썸네일.png')
    await expect(page.locator('.cef .badge.live')).toBeVisible({ timeout: 90_000 })
    // PhotoCraft saves as a browser download (blob URL + <a download>.click()), which the page catches
    // inside the frame; do exactly that from the app's window
    const frame = page.frames().find((f) => f.url().includes('/craft/photocraft/'))
    await frame.evaluate((png) => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: 'image/png' }))
      const a = document.createElement('a'); a.href = url; a.download = '썸네일.png'; a.click()
    }, [...PNG(160, 90, [200, 40, 40])])
    await expect(page.locator('.cef .notice')).toContainText('저장했어요', { timeout: 30_000 })
    await expect.poll(async () => (await page.user.get(`/threads/${th}/messages`)).body.find((m) => m.id === files['썸네일.png'].msg.id).content.edited, { timeout: 15_000 }).toBe(true)
    await page.locator('.cef .tb.ic[title="닫기"]').click()
    await expect(page.locator('button.file', { hasText: '썸네일.png' })).toContainText('편집본')
  })
})
