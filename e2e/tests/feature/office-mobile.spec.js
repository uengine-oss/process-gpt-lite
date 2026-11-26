// 휴대폰에서 문서 보기 — 리본을 접으면 편집기의 탭 줄(파일·저장·되돌리기·홈·삽입…)도 숨겨 문서가 그 자리를 쓰고,
// 「리본 펴기」로 둘 다 돌아온다. PPT 는 썸네일 줄을 접은 채 슬라이드를 화면 폭에 맞추고 이전/다음 단추로 넘긴다
// (「슬라이드 목록」으로 다시 펼침), 가로 화면에서는 노트를 비킨다. 넓은 화면은 그대로.
// (녹화 회차 2026-11-21 · src/components/OfficeEditorFrame.vue · 실제 이음오피스 편집기 office-host :5390, 모델 없음)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect, api } from '../../lib/fixtures.js'
import { PGPT_URL } from '../../lib/env.js'
import { XLSX, MIME } from '../../lib/seed.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const SLIDES = 6

// a 16:9 deck with a title, a body and speaker notes on every slide (python-pptx), or null
function PPTX() {
  const out = path.join(os.tmpdir(), `rt-office-mobile-${process.pid}-${Date.now()}.pptx`)
  const py = [
    'import sys',
    'from pptx import Presentation',
    'from pptx.util import Inches',
    'p = Presentation()',
    'p.slide_width, p.slide_height = Inches(13.333), Inches(7.5)',
    `for i in range(${SLIDES}):`,
    '    s = p.slides.add_slide(p.slide_layouts[1])',
    '    s.shapes.title.text = f"휴대폰 보기 {i + 1}"',
    '    s.placeholders[1].text = "썸네일 줄 없이 화면 폭에 맞춘 슬라이드\\n이전/다음 단추로 넘겨요"',
    '    s.notes_slide.notes_text_frame.text = f"{i + 1}번 슬라이드 발표 노트"',
    'p.save(sys.argv[1])',
  ].join('\n')
  try {
    execFileSync('python3', ['-c', py, out], { stdio: 'pipe' })
    const b = fs.readFileSync(out)
    fs.rmSync(out, { force: true })
    return b
  } catch { return null }
}

// where the pictures go (RT_SHOTS, else this test's output folder)
const shot = async (page, testInfo, name) => {
  const dir = process.env.RT_SHOTS || testInfo.outputPath()
  fs.mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${name}.png`) })
}

async function seed(db, u, files) {
  const th = await db.clearMain(u.id)
  const cards = []
  for (const [name, type, buf] of files) cards.push({ name, url: (await api.upload(u.token(), name, type, buf)).url })
  await db.addMessages(th, cards.map((c) => ({ role: 'agent', kind: 'file', content: c })))
}

// a signed-in page. A phone is the recording's Android: the editor reads navigator.platform (a Mac
// hides its 파일 tab, anything else keeps room for window buttons) — and, with touch, a coarse pointer
async function phone(browser, as, area, viewport, { touch = false, android = viewport.width < 1000 } = {}) {
  const c = await as(area)
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'ko-KR', hasTouch: touch, isMobile: touch, baseURL: new URL(PGPT_URL).origin })
  await ctx.addInitScript((s) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(c.s))
  if (android) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Linux armv8l' }))
  const page = await ctx.newPage()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(String(e?.message || e)))
  page.user = c
  page.ctx = ctx
  return page
}

const BASE = new URL(PGPT_URL).pathname.replace(/\/+$/, '')
async function openDeck(page, name, editor = 'slides') {
  await page.goto(`${BASE}/chat`)
  // a phone-wide screen opens on 홈: the chat is its own tab
  if (page.viewportSize().width <= 760) await page.locator('header.top .seg button', { hasText: '채팅' }).click()
  await page.locator('button.file', { hasText: name }).first().click()
  await expect(page.locator('.oef iframe.frm')).toHaveAttribute('src', new RegExp(`/office/${editor}/\\?src=`))
  return page.frameLocator('.oef iframe.frm')
}
const ribbon = (ed) => ed.locator('.ribbon-collapsible')
// the slide's box on screen, against the editor frame's width
async function slideFill(page) {
  const frame = await page.locator('.oef iframe.frm').boundingBox()
  const s = await page.frameLocator('.oef iframe.frm').locator('.stage-rel').boundingBox()
  return { ratio: s.width / frame.width, slide: s, frame }
}

test.describe('휴대폰 문서 보기 (녹화 회차 2026-11-21)', () => {
  test('F-OM-01 휴대폰 세로: 접힌 리본은 탭 줄도 숨기고, PPT 는 썸네일 없이 폭에 맞춰 단추로 넘긴다', async ({ browser, as, db, cleanup }, testInfo) => {
    const deck = PPTX()
    test.skip(!deck, 'python-pptx 가 없어 PPT 를 만들 수 없음')
    const page = await phone(browser, as, 'nb1121-office', { width: 390, height: 844 })
    cleanup(() => page.ctx.close())
    await seed(db, page.user, [['휴대폰 보기.pptx', PPTX_MIME, deck]])
    const ed = await openDeck(page, '휴대폰 보기.pptx')
    await expect(ed.locator('.status-bar .status-left .status-item')).toHaveText(`슬라이드 1/${SLIDES}`, { timeout: 60_000 })

    // folded ribbon: no tab row (파일·저장·홈·삽입…), no thumbnail rail; the slide spans the width
    await expect(ribbon(ed)).toHaveClass(/ribbon-collapsed/)
    await expect(ed.locator('.ribbon-tabs')).toBeHidden()
    await expect(ed.locator('.slide-list')).toBeHidden()
    await expect.poll(async () => (await slideFill(page)).ratio, { timeout: 10_000 }).toBeGreaterThan(0.8)
    await expect(page.getByTestId('oef-prev')).toBeDisabled()
    await shot(page, testInfo, 'om-portrait-1-folded-fit')

    // next / previous: the editor's own current slide moves
    await page.getByTestId('oef-next').click()
    await expect(ed.locator('.status-bar .status-left .status-item')).toHaveText(`슬라이드 2/${SLIDES}`)
    await page.getByTestId('oef-next').click()
    await expect(ed.locator('.status-bar .status-left .status-item')).toHaveText(`슬라이드 3/${SLIDES}`)
    await page.getByTestId('oef-prev').click()
    await expect(ed.locator('.status-bar .status-left .status-item')).toHaveText(`슬라이드 2/${SLIDES}`)
    await expect(page.getByTestId('oef-prev')).toBeEnabled()
    await shot(page, testInfo, 'om-portrait-2-next')

    // 슬라이드 목록: the rail comes back (and goes again)
    await page.getByTestId('oef-thumbs').click()
    await expect(ed.locator('.slide-list')).toBeVisible()
    await expect(ed.locator('.slide-list .thumb.active')).toHaveAttribute('data-index', '1')
    await expect(page.getByTestId('oef-next')).toHaveCount(0) // the rail is the way through now
    await ed.locator('.slide-list .thumb[data-index="3"]').click()
    await expect(ed.locator('.status-bar .status-left .status-item')).toHaveText(`슬라이드 4/${SLIDES}`)
    await shot(page, testInfo, 'om-portrait-3-thumbs-open')
    await page.getByTestId('oef-thumbs').click()
    await expect(ed.locator('.slide-list')).toBeHidden()
    await expect.poll(async () => (await slideFill(page)).ratio).toBeGreaterThan(0.8)

    // 리본 펴기: tab row and band together; tab names stay on one line
    await page.getByTestId('oef-ribbon').click()
    await expect(ribbon(ed)).not.toHaveClass(/ribbon-collapsed/)
    await expect(ed.locator('.ribbon-tabs')).toBeVisible()
    await expect(ed.locator('[data-ribbon-body]')).toBeVisible()
    const tallest = await ed.locator('.ribbon-tabs .ribbon-tab').evaluateAll((els) => Math.max(...els.filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().height)))
    expect(tallest).toBeLessThan(40)
    await expect(page.getByTestId('oef-ribbon')).toHaveAttribute('title', /리본 접기/)
    await shot(page, testInfo, 'om-portrait-4-ribbon-open')
    // folded again from inside the editor (its selected tab, as on a desktop): both go, and the
    // header button follows
    await ed.locator('.ribbon-tabs .ribbon-tab.active').click()
    await expect(ribbon(ed)).toHaveClass(/ribbon-collapsed/)
    await expect(ed.locator('.ribbon-tabs')).toBeHidden()
    await expect(page.getByTestId('oef-ribbon')).toHaveAttribute('title', /리본 펴기/)
    // and the header button brings both back again
    await page.getByTestId('oef-ribbon').click()
    await expect(ed.locator('.ribbon-tabs')).toBeVisible()
    await page.getByTestId('oef-ribbon').click()
    await expect(ed.locator('.ribbon-tabs')).toBeHidden()
    expect(page.errors).toEqual([])
  })

  test('F-OM-02 휴대폰 가로(터치): 탭 줄 없음, 노트는 비키고 슬라이드가 높이에 맞는다', async ({ browser, as, db, cleanup }, testInfo) => {
    const deck = PPTX()
    test.skip(!deck, 'python-pptx 가 없어 PPT 를 만들 수 없음')
    const page = await phone(browser, as, 'nb1121-office', { width: 844, height: 390 }, { touch: true })
    cleanup(() => page.ctx.close())
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    await seed(db, page.user, [['휴대폰 보기.pptx', PPTX_MIME, deck]])
    const ed = await openDeck(page, '휴대폰 보기.pptx')
    await expect(ed.locator('.status-bar .status-left .status-item')).toHaveText(`슬라이드 1/${SLIDES}`, { timeout: 60_000 })
    await expect(ed.locator('.ribbon-tabs')).toBeHidden()
    await expect(ed.locator('.slide-list')).toBeHidden()
    // notes step aside on a short screen (the editor's own 노트 button)
    await expect(ed.locator('.status-notes-btn')).not.toHaveClass(/\bon\b/)
    // the slide takes the height left (a 16:9 slide in this frame is height-bound)
    await expect.poll(async () => { const f = await slideFill(page); return f.slide.height / f.frame.height }, { timeout: 10_000 }).toBeGreaterThan(0.45)
    await shot(page, testInfo, 'om-landscape-1-folded-fit')
    await page.getByTestId('oef-next').tap()
    await expect(ed.locator('.status-bar .status-left .status-item')).toHaveText(`슬라이드 2/${SLIDES}`)
    await page.getByTestId('oef-thumbs').tap()
    await expect(ed.locator('.slide-list')).toBeVisible()
    await shot(page, testInfo, 'om-landscape-2-thumbs-open')
    await page.getByTestId('oef-thumbs').tap()
    await page.getByTestId('oef-ribbon').tap()
    await expect(ed.locator('.ribbon-tabs')).toBeVisible()
    await shot(page, testInfo, 'om-landscape-3-ribbon-open')
    await page.getByTestId('oef-ribbon').tap()
    await expect(ed.locator('.ribbon-tabs')).toBeHidden()
    // the close button stays in sight in the sheet beside the chat
    await expect(page.locator('.oef .tb.ic[title="닫기"]')).toBeInViewport({ ratio: 1 })
    // 전체 화면 (as in the recording): the slide gets the whole screen
    await page.locator('.oef .tb.opt', { hasText: '전체 화면' }).tap()
    await expect(page.locator('.oef.fs')).toBeVisible()
    await expect.poll(async () => { const f = await slideFill(page); return f.slide.height / f.frame.height }, { timeout: 10_000 }).toBeGreaterThan(0.45)
    await shot(page, testInfo, 'om-landscape-4-fullscreen')
    await page.locator('.oef .tb.opt', { hasText: '전체 화면 끝내기' }).tap()
    await expect(page.locator('.oef.fs')).toHaveCount(0)
    expect(page.errors).toEqual([])
  })

  test('F-OM-03 넓은 화면은 그대로: 접어도 탭 줄과 썸네일 줄이 있고 넘김 단추는 없다', async ({ browser, as, db, cleanup }, testInfo) => {
    const deck = PPTX()
    test.skip(!deck, 'python-pptx 가 없어 PPT 를 만들 수 없음')
    const page = await phone(browser, as, 'nb1121-office', { width: 1440, height: 900 })
    cleanup(() => page.ctx.close())
    await seed(db, page.user, [['휴대폰 보기.pptx', PPTX_MIME, deck]])
    const ed = await openDeck(page, '휴대폰 보기.pptx')
    await expect(ed.locator('.status-bar .status-left .status-item')).toHaveText(`슬라이드 1/${SLIDES}`, { timeout: 60_000 })
    await expect(ribbon(ed)).toHaveClass(/ribbon-collapsed/)
    await expect(ed.locator('.ribbon-tabs')).toBeVisible()
    await expect(ed.locator('.slide-list')).toBeVisible()
    await expect(ed.locator('.status-notes-btn')).toHaveClass(/\bon\b/)
    await expect(page.getByTestId('oef-prev')).toHaveCount(0)
    await expect(page.getByTestId('oef-thumbs')).toHaveCount(0)
    await shot(page, testInfo, 'om-desktop-1440')
    expect(page.errors).toEqual([])
  })

  test('F-OM-04 휴대폰에서 엑셀·워드도 접힌 리본은 탭 줄 없이 열린다 (깨지지 않음)', async ({ browser, as, db, cleanup }, testInfo) => {
    const page = await phone(browser, as, 'nb1121-office', { width: 390, height: 844 })
    cleanup(() => page.ctx.close())
    const docx = fs.readFileSync(path.join(here, '../../fixtures/Moonlight Coffee Store 2 proposal.docx'))
    await seed(db, page.user, [['예산표.xlsx', MIME.xlsx, await XLSX([['항목', '금액'], ['대관', 300000], ['다과', 120000]])], ['제안서.docx', DOCX_MIME, docx]])
    for (const [name, editor] of [['예산표.xlsx', 'sheets'], ['제안서.docx', 'docs']]) {
      const ed = await openDeck(page, name, editor)
      await expect(ribbon(ed)).toHaveClass(/ribbon-collapsed/, { timeout: 60_000 })
      await expect(ed.locator('.ribbon-tabs')).toBeHidden()
      await expect(page.getByTestId('oef-thumbs')).toHaveCount(0)
      await page.waitForTimeout(1500)
      await shot(page, testInfo, `om-portrait-${editor}-folded`)
      await page.getByTestId('oef-ribbon').click()
      await expect(ed.locator('.ribbon-tabs')).toBeVisible()
      await shot(page, testInfo, `om-portrait-${editor}-ribbon-open`)
      await page.locator('.oef .tb.ic[title="닫기"]').click()
      await expect(page.locator('.oef')).toHaveCount(0)
    }
    expect(page.errors).toEqual([])
  })

  // 2026-11-26 사용자: 「엑셀 이음오피스를 모바일에서 열었을때 쓰기모드라서 스크롤 할 수 없는문제」 — 편집기의 표는 손가락을
  // 마우스처럼 읽어 끌면 칸이 골라졌다. 이제 끌면 스크롤, 탭은 칸, 두 번 탭은 편집, 길게 누른 뒤 끌면 범위 (src/officeTouchPan.js)
  test('F-OM-05 휴대폰 엑셀: 손가락으로 끌면 표가 스크롤되고, 탭은 칸 · 길게 눌러 끌면 범위 · 두 번 탭은 편집', async ({ browser, as, db, cleanup }, testInfo) => {
    const page = await phone(browser, as, 'nb1121-office', { width: 390, height: 844 }, { touch: true })
    cleanup(() => page.ctx.close())
    const rows = [['번호', '고객', '금액', '지역', '메모']]
    for (let i = 1; i <= 200; i++) rows.push([i, `고객${i}`, i * 1000, ['서울', '부산', '대구'][i % 3], `메모 ${i}`])
    await seed(db, page.user, [['주문 목록.xlsx', MIME.xlsx, await XLSX(rows)]])
    const ed = await openDeck(page, '주문 목록.xlsx', 'sheets')
    const grid = ed.locator('#univer-container canvas[id^="univer-sheet-main-canvas"]')
    await expect(grid).toBeVisible({ timeout: 60_000 })
    // the editor's name box (A1, C12, B7:D17 …)
    const nameBox = () => ed.locator('input').evaluateAll((els) => els.map((e) => e.value).find((v) => /^[A-Z]+\d+(:[A-Z]+\d+)?$/.test(v)) || '')
    const rowOf = (ref) => Number(/(\d+)$/.exec(ref)?.[1] || 0)
    await expect.poll(nameBox, { timeout: 30_000 }).toBe('A1')
    await page.waitForTimeout(1500)
    // the grid canvas runs past the screen's right edge: aim inside what is on screen
    const c = await grid.boundingBox()
    const f = await page.locator('.oef iframe.frm').boundingBox()
    const right = Math.min(c.x + c.width, f.x + f.width, page.viewportSize().width)
    const g = { x: c.x, y: c.y, width: right - c.x, height: c.height }
    const cdp = await page.ctx.newCDPSession(page)
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })
    const tap = async (x, y) => { await touch('touchStart', [{ x, y }]); await page.waitForTimeout(60); await touch('touchEnd', []) }
    const drag = async (x0, y0, x1, y1, steps = 14) => {
      await touch('touchStart', [{ x: x0, y: y0 }])
      for (let i = 1; i <= steps; i++) { await touch('touchMove', [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps }]); await page.waitForTimeout(30) }
      await page.waitForTimeout(250) // the finger rests before it lifts: no flick, the sheet stays where it was taken
      await touch('touchEnd', [])
    }
    const x = g.x + g.width * 0.55
    const top = g.y + 90
    const bottom = Math.min(g.y + g.height, page.viewportSize().height) - 40

    // a tap picks the cell under the finger
    await tap(x, top)
    await expect.poll(nameBox).toMatch(/^[A-Z]+\d+$/)
    const before = await nameBox()
    await shot(page, testInfo, 'om-sheet-1-tap')

    // a drag up scrolls the rows (before: it selected a range and the sheet stayed)
    await drag(x, bottom, x, top)
    await page.waitForTimeout(400)
    expect(await nameBox()).toBe(before)
    await tap(x, top)
    await expect.poll(async () => rowOf(await nameBox())).toBeGreaterThan(rowOf(before) + 5)
    const scrolled = await nameBox()
    await shot(page, testInfo, 'om-sheet-2-scrolled')

    // a drag left scrolls the columns
    await drag(g.x + g.width * 0.85, top + 60, g.x + g.width * 0.2, top + 60)
    await page.waitForTimeout(400)
    await tap(x, top)
    await expect.poll(async () => (await nameBox()).replace(/\d+$/, '')).not.toBe(scrolled.replace(/\d+$/, ''))
    await shot(page, testInfo, 'om-sheet-3-sideways')

    // press and hold, then drag: a range
    await touch('touchStart', [{ x, y: top + 40 }])
    await page.waitForTimeout(700)
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: x - i * 12, y: top + 40 + i * 25 }]); await page.waitForTimeout(30) }
    await touch('touchEnd', [])
    await expect.poll(nameBox).toMatch(/^[A-Z]+\d+:[A-Z]+\d+$/)
    await shot(page, testInfo, 'om-sheet-4-hold-range')

    // a double tap opens the cell for editing (the cell editor comes on screen)
    const cellEditor = ed.locator('[id="__editor___INTERNAL_EDITOR__DOCS_NORMAL"]')
    expect((await cellEditor.boundingBox())?.x ?? -1).toBeLessThan(0)
    await tap(x, top + 120)
    await page.waitForTimeout(120)
    await tap(x, top + 120)
    await expect.poll(async () => (await cellEditor.boundingBox())?.x ?? -1).toBeGreaterThan(0)
    await shot(page, testInfo, 'om-sheet-5-double-tap-edit')
    expect(page.errors).toEqual([])
  })
})
