// 운영 화면(2026-11-24, 데스크톱 앱 · 루틴 › 회사 프로세스 지도): 팀 메시지 대화에서 PDF 칩을 눌러도 아무 일이 없었다(「대화방에서 문서
// 클릭시 반응없음 (이음오피스 열려야)」). 문서 패널(OfficeSheet)이 채팅 화면에만 있어서, 지도 · 폴더 같은 다른 화면에서는 메신저만 닫히고
// 문서는 열리지 않았다. 고친 뒤: 어느 화면에서든 보낸 사람 · 받은 사람 모두 문서 패널(이음오피스)에 그 문서가 열린다.
// 그리고 「대화방 위치를 끌어다가 다른 위치로 docking 할 수 있어야 대화하면서 작업공간을 나눠서 쓸 수 있음. 예를 들어 패널 영역으로」:
// 메신저의 머리를 끌어 오른쪽 · 왼쪽 끝이나 문서 패널에 붙이거나, 머리의 위치 단추로 고른다. 붙여 두면 가림막이 없어 아래 페이지를 그대로
// 쓰고, 메신저에서 연 문서는 메신저 옆에 열리며 메신저는 그대로 있다. 너비 · 자리는 기기에 남는다. 휴대폰 폭은 예전 그대로 전체 화면.
// 스펙 openspec/specs/messenger-dock · 단위 시험 server/test/messengerDock.test.js · openPlan.test.js
// 받은 쪽의 폴더 추천(판정 모델)은 이 파일이 RT_FAKE_LLM_PORT(기본 59998)에 띄운 가짜 모델이 답한다: 같은 포트를 쓰는 F-MD · F-ML · F-MT ·
// F-MW 와 동시에 돌리지 않는다. 지도 화면은 개발 서버의 가짜 응답(?mock=1)으로 띄운다(Vite 개발 서버에 대고 돌린다).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, api } from '../../lib/fixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const PORT = Number(process.env.RT_FAKE_LLM_PORT || 59998)
const SHOTS = path.resolve(here, '../../../openspec/specs/messenger-dock/e2e/results')
const shot = async (page, name) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}
test.describe.configure({ mode: 'serial' })

// a one-page PDF with a line of text
function pdf(text) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>']
  const body = `BT /F1 26 Tf 72 760 Td (${text}) Tj ET`
  objs.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let out = '%PDF-1.4\n'
  const offs = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const PDF = { name: '한빛상사_제안서_v2.pdf', type: 'application/pdf', buf: pdf('Hanbit proposal v2') }
const DOCX = { name: '그린리프_용역계약서.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buf: fs.readFileSync(path.resolve(here, '../../fixtures/Moonlight Coffee Store 2 proposal.docx')) }
const ZIP = { name: '현장사진_묶음.zip', type: 'application/zip', buf: Buffer.from('PK\u0005\u0006' + '\u0000'.repeat(18), 'latin1') }

// the judge behind 폴더에 정리 on a received file: the last option, at 0.9 (a new folder's name otherwise)
let server
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let b = {}
      try { b = JSON.parse(body) } catch { /* not json */ }
      const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (b.logprobs) {
        const letters = [...text.matchAll(/^([A-Z])\) /gm)].map((m) => m[1])
        const hit = letters.at(-1) || 'A'
        return res.end(JSON.stringify({ choices: [{ message: { content: hit }, logprobs: { content: [{ token: hit, logprob: Math.log(0.9), top_logprobs: [{ token: hit, logprob: Math.log(0.9) }] }] } }] }))
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ name: '받은 문서', why: '받은 문서를 모을 곳' }) }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((ok, no) => server.once('error', no).listen(PORT, '127.0.0.1', ok))
})
test.afterAll(async () => { await new Promise((ok) => server?.close(ok)) })

const member = async (c) => { await c.get('/team'); return c }
const upload = async (c, f) => {
  const r = await api.call(c.token(), 'POST', '/team/uploads', f.buf, { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name), 'X-File-Type': f.type } })
  expect(r.status, r.text).toBe(200)
  return r.body.id
}
// a 1:1 conversation a → b with a message carrying these files (the way the messenger sends them: uploads, then the message)
async function share(a, b, db, cleanup, files, text = '참고하세요') {
  const t = await a.post('/team/threads', { members: [b.id] })
  expect(t.status, t.text).toBe(200)
  cleanup(() => db.q('delete from chat_rooms where id=$1', [t.body.id]))
  const ids = []
  for (const f of files) ids.push(await upload(a, f))
  const m = await a.post(`/team/threads/${t.body.id}/messages`, { text, artifactIds: ids })
  expect(m.status, m.text).toBe(200)
  return t.body.id
}
const settled = (loc) => loc.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished))).catch(() => {})
// the page and the column have moved to their places (their CSS transitions are over)
const calm = (page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))))
const messenger = (page) => page.locator('[data-test="messenger"]')
const sheet = (page) => page.locator('[data-test="office-sheet"]')
async function openMessenger(page, { phone = false } = {}) {
  if (phone) {
    await page.locator('.seg button').filter({ hasText: '홈' }).click()
    await page.locator('button.msgs').click()
  } else await page.locator('button.msg-btn').click()
  await page.locator('.ms').waitFor()
}
async function openThread(page, title, opts) {
  if (!(await page.locator('.ms').count())) await openMessenger(page, opts)
  await page.locator('.ms .tabs button').filter({ hasText: '대화' }).click()
  await page.locator('.ms .th').filter({ hasText: title }).first().click()
  await page.locator('.ms .cmp textarea').waitFor()
}
const fileChip = (page, f) => page.locator(`.ms .msg [data-test="msg-file"][data-file="${f.name}"]`).last()
// the document panel shows this file in the IeumOffice editor of its kind
async function expectDoc(page, f, editor) {
  await expect(sheet(page).locator('.oef .name')).toHaveText(f.name)
  await expect(sheet(page).locator('iframe')).toHaveAttribute('src', new RegExp(`/office/${editor}/\\?src=`))
}
// the editor's page has drawn (the office host answers; a test stack without one shows its error page — the panel is still there)
const editorDrawn = async (page) => { await sheet(page).locator('iframe').evaluate((f) => new Promise((ok) => (f.contentDocument?.readyState === 'complete' ? ok() : f.addEventListener('load', ok, { once: true })))).catch(() => {}); await page.waitForTimeout(1500) }
const box = (loc) => loc.boundingBox()
// drag a header from its title to (x, y) with the mouse, the zone under the pointer lit
async function dragHeader(page, x, y, zone, shotName) {
  const head = page.locator('[data-test="msg-head"] b:visible, [data-test="msg-thread-head"] b:visible').first()
  const h = await box(head)
  await page.mouse.move(h.x + 8, h.y + h.height / 2)
  await page.mouse.down()
  await page.mouse.move(h.x + 30, h.y + 30, { steps: 3 })
  await page.mouse.move(x, y, { steps: 12 })
  await expect(page.locator('[data-test="dock-zones"]')).toBeVisible()
  if (zone) await expect(page.locator('[data-test="dock-zones"] .dz.on')).toHaveAttribute('data-zone', zone)
  else await expect(page.locator('[data-test="dock-zones"] .dz.on')).toHaveCount(0)
  if (shotName) await shot(page, shotName)
  await page.mouse.up()
  await expect(page.locator('[data-test="dock-zones"]')).toHaveCount(0)
  await calm(page)
}
async function pickDock(page, dock) {
  await page.locator('[data-test="dock-button"]:visible').first().click()
  await expect(page.locator('[data-test="dock-menu"]')).toBeVisible()
  await page.locator(`[data-test="dock-menu"] [data-dock="${dock}"]`).click()
  await expect(messenger(page)).toHaveAttribute('data-dock', dock)
  await calm(page)
}
const pageBox = (page) => box(page.locator('.stage > .page'))
// a fresh device: no remembered place
const fresh = (page) => page.evaluate(() => { try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ } })

test.describe('메신저의 문서 열기 · 메신저 붙이기 (spec messenger-dock)', () => {
  test('F-MO-01 지도 · 폴더 화면에서도 PDF · 워드 칩을 누르면 문서 패널에 열린다 — 보낸 사람(원본) · 받은 사람(사본) · 받은 편지함의 「편집기에서 열기」', async ({ pageAs, as, db, cleanup }) => {
    const pa = await pageAs('mo-sender', { viewport: WIDE })
    const a = await member(pa.user)
    const b = await member(await as('mo-mate'))
    await share(a, b, db, cleanup, [PDF, DOCX])
    // the sender on the company process map (where the click did nothing — the panel lived on the chat pages only)
    await pa.goto('/process-map?mock=1')
    await fresh(pa)
    await expect(pa.locator('h1').filter({ hasText: '회사 프로세스 지도' })).toBeVisible()
    await openThread(pa, '회귀-mo-mate')
    await fileChip(pa, PDF).click()
    await expectDoc(pa, PDF, 'pdf')
    // the floating sheet puts itself away for the document; the map is still the page
    await expect(pa.locator('.ms')).toHaveCount(0)
    await expect(pa).toHaveURL(/\/process-map/)
    await expect(pa.locator('h1').filter({ hasText: '회사 프로세스 지도' })).toBeVisible()
    await editorDrawn(pa)
    await shot(pa, 'f-mo-01a-map-pdf')
    // the Word file from the same message replaces it
    await openThread(pa, '회귀-mo-mate')
    await fileChip(pa, DOCX).click()
    await expectDoc(pa, DOCX, 'docs')
    // the recipient on the folders page: each file opens as their own copy
    const pb = await pageAs('mo-mate', { viewport: WIDE })
    await pb.goto('/folders')
    await fresh(pb)
    await openThread(pb, '회귀-mo-sender')
    await fileChip(pb, PDF).click()
    await expectDoc(pb, PDF, 'pdf')
    await expect(pb).toHaveURL(/\/folders/)
    const copy = decodeURIComponent(await sheet(pb).locator('iframe').getAttribute('src'))
    expect(copy, '받은 사람의 사본이지 보낸 사람의 원본이 아니다').not.toContain(a.id)
    await editorDrawn(pb)
    await shot(pb, 'f-mo-01b-folders-recipient-pdf')
    await openThread(pb, '회귀-mo-sender')
    await fileChip(pb, DOCX).click()
    await expectDoc(pb, DOCX, 'docs')
    // 받은 편지함: the chip and 「편집기에서 열기」 open the same way
    await openMessenger(pb)
    await pb.locator('.ms .tabs button').filter({ hasText: '받은 편지함' }).click()
    const item = pb.locator('.ms article.mail').filter({ hasText: '참고하세요' }).first()
    await item.locator('.acts .b').filter({ hasText: '편집기에서 열기' }).click()
    await expectDoc(pb, PDF, 'pdf')
    await expect(pb.locator('.ms')).toHaveCount(0)
    expect(pa.errors).toEqual([])
    expect(pb.errors).toEqual([])
  })

  test('F-MO-02 머리를 오른쪽 끝으로 끌어 붙이면 가림막 없이 페이지를 쓰고, 메신저에서 연 문서는 메신저 옆에 열린다', async ({ pageAs, as, db, cleanup }) => {
    const page = await pageAs('mo-sender', { viewport: WIDE })
    const a = await member(page.user)
    const b = await member(await as('mo-mate'))
    await share(a, b, db, cleanup, [PDF])
    await page.goto('/folders')
    await fresh(page)
    await openThread(page, '회귀-mo-mate')
    await settled(page.locator('.ms'))
    await shot(page, 'f-mo-02a-float')
    // dropped in the middle: stays floating
    await dragHeader(page, 600, 500, null)
    await expect(messenger(page)).toHaveAttribute('data-dock', 'float')
    // onto the right edge
    await dragHeader(page, WIDE.width - 70, 450, 'right', 'f-mo-02b-drag-zones')
    await expect(messenger(page)).toHaveAttribute('data-dock', 'right')
    await expect(page.locator('.veil .ms')).toHaveCount(0)
    const ms = await box(messenger(page))
    expect(ms.x + ms.width).toBeLessThanOrEqual(WIDE.width)
    const pg = await pageBox(page)
    expect(pg.x + pg.width, '페이지는 메신저가 시작하는 곳에서 끝난다').toBeLessThanOrEqual(ms.x)
    await settled(messenger(page))
    await shot(page, 'f-mo-02c-docked-right')
    // the page under it answers: the top bar takes us to the chat, the messenger stays where it is
    await page.locator('header.top .seg button').filter({ hasText: '채팅' }).click()
    await expect(page).toHaveURL(/\/chat/)
    const composer = page.locator('.composer textarea').first()
    await composer.fill('메신저 옆에서 쓰는 채팅')
    await expect(composer).toHaveValue('메신저 옆에서 쓰는 채팅')
    await expect(messenger(page)).toHaveAttribute('data-dock', 'right')
    // a document from the messenger opens beside it; the messenger stays
    await fileChip(page, PDF).click()
    await expectDoc(page, PDF, 'pdf')
    await expect(messenger(page)).toBeVisible()
    await calm(page)
    const sb = await box(sheet(page).locator('.sheet'))
    const ms2 = await box(messenger(page))
    expect(sb.x + sb.width, '문서는 메신저 왼쪽에').toBeLessThanOrEqual(ms2.x)
    expect(sb.width).toBeGreaterThan(400)
    // the chat beside the document still takes typing
    await composer.fill('문서를 보면서 채팅')
    await expect(composer).toHaveValue('문서를 보면서 채팅')
    await editorDrawn(page)
    await shot(page, 'f-mo-02d-right-with-doc')
    // the messenger is in front of the page's own Esc: it stays until its ✕
    await page.keyboard.press('Escape')
    await expect(messenger(page)).toBeVisible()
    await page.locator('[data-test="msg-close"]:visible, .thd .x[aria-label="닫기"]:visible').first().click()
    await expect(messenger(page)).toHaveCount(0)
    await expect.poll(async () => (await pageBox(page)).width, { message: '닫으면 페이지가 창 전체로' }).toBe(WIDE.width)
    expect(page.errors).toEqual([])
  })

  test('F-MO-03 문서 패널에 넣으면 연 문서와 한 패널에 나란히 — 문서가 없으면 오른쪽 열, 닫으면 다시 열로', async ({ pageAs, as, db, cleanup }) => {
    const page = await pageAs('mo-sender', { viewport: WIDE })
    const a = await member(page.user)
    const b = await member(await as('mo-mate'))
    await share(a, b, db, cleanup, [DOCX])
    await page.goto('/chat')
    await fresh(page)
    await openThread(page, '회귀-mo-mate')
    await pickDock(page, 'panel')
    // no document yet: a column at the right
    await expect(messenger(page)).not.toHaveClass(/inpanel/)
    expect((await pageBox(page)).width).toBeLessThan(WIDE.width)
    await fileChip(page, DOCX).click()
    await expectDoc(page, DOCX, 'docs')
    // in the panel: the right part of the document's card, the document left of it, the page as wide as with a document alone
    await expect(messenger(page)).toHaveClass(/inpanel/)
    await calm(page)
    const sh = await box(sheet(page).locator('.sheet'))
    const ms = await box(messenger(page))
    const ed = await box(sheet(page).locator('.oef'))
    expect(ms.x).toBeGreaterThan(sh.x)
    expect(Math.abs(ms.x + ms.width - (sh.x + sh.width))).toBeLessThanOrEqual(2)
    expect(ed.x + ed.width, '문서는 메신저 왼쪽').toBeLessThanOrEqual(ms.x + 1)
    expect((await pageBox(page)).width).toBe(WIDE.width)
    // the chat beside the panel still answers
    const composer = page.locator('.composer textarea').first()
    await composer.fill('패널 옆 채팅')
    await expect(composer).toHaveValue('패널 옆 채팅')
    await editorDrawn(page)
    await settled(messenger(page))
    await shot(page, 'f-mo-03a-panel-with-doc')
    // the document closed: back to a column at the right
    await sheet(page).locator('.oef .tb.ic[title="닫기"]').click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(messenger(page)).not.toHaveClass(/inpanel/)
    await expect(messenger(page)).toHaveAttribute('data-dock', 'panel')
    await calm(page)
    expect((await pageBox(page)).width).toBeLessThan(WIDE.width)
    expect(page.errors).toEqual([])
  })

  test('F-MO-04 다시 열어도(새로 고침) 붙인 자리 · 너비가 그대로 — 기기에 남는다', async ({ pageAs, as, db, cleanup }) => {
    const page = await pageAs('mo-sender', { viewport: WIDE })
    const a = await member(page.user)
    const b = await member(await as('mo-mate'))
    await share(a, b, db, cleanup, [PDF])
    await page.goto('/chat')
    await fresh(page)
    await openThread(page, '회귀-mo-mate')
    await pickDock(page, 'left')
    // the inner edge, by keyboard: 3 × 16px wider
    const before = (await box(messenger(page))).width
    await page.locator('[data-test="msg-resize"]').focus()
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
    await expect.poll(async () => Math.round((await box(messenger(page))).width)).toBe(Math.round(before + 48))
    // and by the pointer: to 520px
    const rz = await box(page.locator('[data-test="msg-resize"]'))
    await page.mouse.move(rz.x + rz.width / 2, rz.y + rz.height / 2)
    await page.mouse.down()
    await page.mouse.move(12 + 520, rz.y + rz.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => Math.round((await box(messenger(page))).width)).toBe(520)
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('pgl-messenger-dock')))).toEqual({ dock: 'left', width: 520 })
    await page.reload()
    await openMessenger(page)
    await expect(messenger(page)).toHaveAttribute('data-dock', 'left')
    await calm(page)
    await expect.poll(async () => Math.round((await box(messenger(page))).width)).toBe(520)
    const pg = await pageBox(page)
    expect(pg.x, '페이지는 메신저 오른쪽에서 시작').toBeGreaterThanOrEqual(520)
    await settled(messenger(page))
    await shot(page, 'f-mo-04-left-restored')
    // a window too narrow for a column floats it; the choice is kept for a wider one
    await page.setViewportSize({ width: 900, height: 800 })
    await expect(messenger(page)).toHaveAttribute('data-dock', 'float')
    await expect(page.locator('[data-test="dock-button"]')).toHaveCount(0)
    await page.setViewportSize(WIDE)
    await expect(messenger(page)).toHaveAttribute('data-dock', 'left')
    expect(page.errors).toEqual([])
  })

  test('F-MO-05 휴대폰 폭(390px): 붙이기 단추 · 끄는 자리가 없고 예전 그대로 전체 화면, 문서도 열린다', async ({ pageAs, as, db, cleanup }) => {
    const page = await pageAs('mo-phone', { viewport: PHONE, touch: true })
    const a = await member(page.user)
    const b = await member(await as('mo-mate'))
    await share(a, b, db, cleanup, [PDF])
    await page.goto('/chat')
    // even with a docked place remembered from a wider window
    await page.evaluate(() => localStorage.setItem('pgl-messenger-dock', JSON.stringify({ dock: 'right', width: 420 })))
    await page.reload()
    await openThread(page, '회귀-mo-mate', { phone: true })
    await expect(messenger(page)).toHaveAttribute('data-dock', 'float')
    await expect(page.locator('[data-test="dock-button"]')).toHaveCount(0)
    await expect(page.locator('[data-test="msg-resize"]')).toHaveCount(0)
    await expect(page.locator('.ms')).toHaveClass(/single/)
    const ms = await box(page.locator('.ms'))
    expect(ms.width).toBeGreaterThan(PHONE.width - 20)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await settled(page.locator('.ms'))
    await shot(page, 'f-mo-05a-phone')
    await fileChip(page, PDF).click()
    await expectDoc(page, PDF, 'pdf')
    await expect(page.locator('.ms')).toHaveCount(0)
    await editorDrawn(page)
    await shot(page, 'f-mo-05b-phone-pdf')
    expect(page.errors).toEqual([])
  })

  test('F-MO-06 붙여 둔 메신저에도 파일을 끌어다 놓으면 보낸다 — 옆 페이지(채팅)에 놓은 파일은 채팅으로', async ({ pageAs, as, db, cleanup }) => {
    const page = await pageAs('mo-sender', { viewport: WIDE })
    const a = await member(page.user)
    const b = await member(await as('mo-mate'))
    const t = await share(a, b, db, cleanup, [PDF])
    await db.clearMain(a.id)
    await page.goto('/chat')
    await fresh(page)
    await openThread(page, '회귀-mo-mate')
    await pickDock(page, 'right')
    const drag = async (target, files) => {
      const dt = await page.evaluateHandle((fs) => {
        const d = new DataTransfer()
        for (const f of fs) d.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }))
        return d
      }, files.map((f) => ({ name: f.name, type: f.type, bytes: [...f.buf] })))
      await target.dispatchEvent('dragenter', { dataTransfer: dt })
      await target.dispatchEvent('dragover', { dataTransfer: dt })
      return () => target.dispatchEvent('drop', { dataTransfer: dt })
    }
    const name = `견적서_도킹-${Date.now().toString(36)}.md`
    const drop = await drag(page.locator('.ms .pane .msgs'), [{ name, type: 'text/markdown', buf: Buffer.from('# 견적서\n합계 1,200,000원\n') }])
    await expect(page.locator('[data-test="msg-dropzone"]')).toContainText('여기에 놓으면 보내요')
    await expect(page.locator('.dropzone'), '채팅의 화면 전체 놓기는 메신저 위에서 안 뜬다').toHaveCount(0)
    // (the zone fades in from the next frame: wait for it before the picture)
    await page.waitForTimeout(600)
    await shot(page, 'f-mo-06a-docked-dropzone')
    await drop()
    const chip = page.locator('[data-test="msg-upload-chip"]').filter({ hasText: name })
    await expect(chip).toHaveAttribute('data-state', 'ready')
    await expect(page.locator('.composer .atts .att')).toHaveCount(0)
    await page.locator('[data-test="msg-send"]').click()
    await expect(page.locator('.ms .msg.mine').filter({ hasText: name })).toBeVisible()
    await expect.poll(async () => (await b.get(`/team/threads/${t}/messages`)).body.messages.at(-1)?.artifacts?.[0]?.name).toBe(name)
    // the page beside the column: a file dropped on the chat goes to the chat composer, as without the messenger
    const other = `메모-${Date.now().toString(36)}.txt`
    const drop2 = await drag(page.locator('.composer textarea').first(), [{ name: other, type: 'text/plain', buf: Buffer.from('메모') }])
    await expect(page.locator('.dropzone')).toContainText('여기에 놓으면 첨부돼요')
    await drop2()
    await expect(page.locator('.composer .atts .att').filter({ hasText: other })).toBeVisible()
    await expect(page.locator('[data-test="msg-upload-chip"]').filter({ hasText: other })).toHaveCount(0)
    expect(page.errors).toEqual([])
  })

  test('F-MO-07 앱 안에서 볼 수 없는 파일은 이유와 링크가 그 파일 아래에 — 메신저는 그대로', async ({ pageAs, as, db, cleanup }) => {
    const page = await pageAs('mo-sender', { viewport: WIDE })
    const a = await member(page.user)
    const b = await member(await as('mo-mate'))
    await share(a, b, db, cleanup, [ZIP], '현장 사진 묶음이에요')
    await page.goto('/chat')
    await fresh(page)
    await openThread(page, '회귀-mo-mate')
    await fileChip(page, ZIP).click()
    const note = page.locator(`.ms [data-test="open-note"][data-file="${ZIP.name}"]`)
    await expect(note).toContainText('앱 안에서 열 수 없는 형식이에요.')
    await expect(note.locator('a')).toHaveAttribute('href', /\/storage\/v1\/object\/public\//)
    await expect(note.locator('a')).toHaveAttribute('target', '_blank')
    await expect(page.locator('.ms')).toBeVisible()
    await expect(sheet(page)).toHaveCount(0)
    await shot(page, 'f-mo-07-no-viewer')
    expect(page.errors).toEqual([])
  })

  test('F-MO-08 밤 테마: 문서 패널에 넣은 메신저와 끄는 자리', async ({ pageAs, as, db, cleanup }) => {
    const page = await pageAs('mo-sender', { viewport: WIDE })
    const a = await member(page.user)
    const b = await member(await as('mo-mate'))
    await share(a, b, db, cleanup, [PDF])
    // the sky's hour (stores/sky.js ?hour=): night
    await page.goto('/chat?hour=22')
    await fresh(page)
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await openThread(page, '회귀-mo-mate')
    await dragHeader(page, 1000, 500, 'panel', 'f-mo-08a-dark-drag')
    await expect(messenger(page)).toHaveAttribute('data-dock', 'panel')
    await fileChip(page, PDF).click()
    await expectDoc(page, PDF, 'pdf')
    await expect(messenger(page)).toHaveClass(/inpanel/)
    await calm(page)
    await editorDrawn(page)
    await settled(messenger(page))
    await shot(page, 'f-mo-08b-dark-panel')
    expect(page.errors).toEqual([])
  })
})
