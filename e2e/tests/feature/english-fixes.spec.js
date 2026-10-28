// English-mode polish (i18n/HANDOFF.md "Coordination") — what the English tutorial and videos need to work
// end to end, with Korean left as it was. Test accounts pro-en-fix-*@uengine.org only.
//   F-EN-01 server unit tests: Craft triggers by app name, room helper names, panel amounts and the
//           design token cap, browser purchase gate and result line, English test shop (en-fix.test.js)
//   F-EN-02 tutorial ch. 9 in English: the Word proposal's floor-plan picture — the editor's own UI in
//           English, "@ Point" → "Image 1", PhotoCraft over the document, "Put in Word document", ⌘S →
//           the edited .docx has the new picture in the same place (no model: PhotoCraft is driven directly)
//   F-EN-03 the same Word document in Korean mode: editor UI and chip in Korean (unchanged)
//   F-EN-04 panel apps from a description, a plain sheet and a record-keeping one, in Korean and English,
//           and "2,450만 원" / "₩24.5M" under the key the router copies from the field list (model calls)
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { test, expect, api } from '../../lib/fixtures.js'
import { PGPT_URL, SERVER_DIR, hasServerSource } from '../../lib/env.js'
import { removeFolder } from '../../lib/seed.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DOCX = fs.readFileSync(path.join(here, '../../fixtures/Moonlight Coffee Store 2 proposal.docx'))
const NAME = 'Moonlight Coffee Store #2 proposal.docx' // "#" in the name: the card must still open the editor
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const HANGUL = /[가-힣]/

// a pro-en-fix test account in the given language, onboarded
async function account(area, lang) {
  const email = `pro-en-fix-${area}@uengine.org`
  const u = api.client(await api.login(email))
  await u.post('/profile', { name: lang === 'en' ? 'Alex Kim' : '김알렉스', birth: '1990-01-01', onboarded: true })
  expect((await u.put('/me/lang', { lang })).status).toBe(200)
  return u
}
async function seedDoc(db, u) {
  const th = await db.clearMain(u.id)
  const up = await api.upload(u.token(), NAME, DOCX_MIME, DOCX)
  const [card] = await db.addMessages(th, [{ role: 'agent', kind: 'file', content: { name: NAME, url: up.url, ext: 'docx' } }])
  return { th, card, url: up.url }
}
async function pageIn(browser, u, lang) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: lang === 'en' ? 'en-US' : 'ko-KR', baseURL: PGPT_URL })
  await ctx.addInitScript(([s, l]) => { if (window.top === window) { localStorage.setItem('pgpt-pro-session', s); localStorage.setItem('pgl-lang', l) } }, [JSON.stringify(u.s), lang])
  const page = await ctx.newPage()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(String(e?.message || e)))
  return page
}
// open the card and wait for the Word editor joined to the chat
async function openWord(page, live) {
  await page.goto('/chat')
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.locator('button.file', { hasText: NAME }).first().click()
  await expect(page.locator('.oef iframe.frm')).toHaveAttribute('src', /^\/office\/docs\/\?/)
  await expect(page.locator('.oef .badge.live')).toContainText(live, { timeout: 90_000 })
  const frame = page.frames().find((f) => f.url().includes('/office/docs/'))
  await expect.poll(() => frame.evaluate(() => !!document.querySelector('.ProseMirror')?.editor), { timeout: 60_000 }).toBe(true)
  return frame
}
// the editor's own words (ribbon, status bar, buttons, tooltips), the document left out
const editorUi = (frame) => frame.evaluate(() => {
  const words = [...document.querySelectorAll('body *')].filter((e) => !e.closest('.ProseMirror') && !e.children.length && e.getClientRects().length).map((e) => e.textContent.trim()).filter(Boolean)
  const tips = [...document.querySelectorAll('[title],[aria-label]')].filter((e) => !e.closest('.ProseMirror')).map((e) => e.getAttribute('title') || e.getAttribute('aria-label'))
  return [...words, ...tips]
})
const pictureNodes = (frame) => frame.evaluate(() => {
  const out = []
  document.querySelector('.ProseMirror').editor.state.doc.descendants((x, pos) => { if (x.type.name === 'docProtected' && x.attrs.blockType === 'image') out.push({ pos, docxIndex: x.attrs.docxIndex, replaced: !!x.attrs.imageReplace }) })
  return out
})
async function pointAtPicture(page, frame, label) {
  await page.locator('.oef .tb', { hasText: label }).click()
  const img = frame.locator('.ProseMirror img:not(.ProseMirror-separator)').first()
  await img.scrollIntoViewIfNeeded()
  await img.click()
}

test.describe('English mode polish (i18n/HANDOFF.md)', () => {
  test('F-EN-01 server unit: Craft triggers, room helper names, panel amounts and token cap, browser purchase gate, English test shop (en-fix.test.js)', async () => {
    test.skip(!hasServerSource(), 'server 소스 없음')
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_OPTIONS|PW_|PLAYWRIGHT_|TEST_|PRO_|RT_)/.test(k)))
    const r = spawnSync(process.execPath, ['--test', 'test/en-fix.test.js'], { cwd: SERVER_DIR, encoding: 'utf8', timeout: 120_000, env })
    await test.info().attach('node-test-output.txt', { body: `${r.stdout}\n${r.stderr}`, contentType: 'text/plain' })
    expect(r.status, (r.stdout + r.stderr).split('\n').filter((l) => /^not ok|✖|fail \d/.test(l)).join('\n')).toBe(0)
    expect(r.stdout).toMatch(/ℹ fail 0/)
  })

  test('F-EN-02 Word picture ↔ PhotoCraft in English: "Image 1", over the document, back in the same place, saved in the .docx', async ({ browser, db }) => {
    test.setTimeout(300_000)
    test.skip(!(await api.craftHas('photocraft')), api.craftSkip('photocraft'))
    const u = await account('word-en', 'en')
    const { card, url: original } = await seedDoc(db, u)
    const page = await pageIn(browser, u, 'en')
    const frame = await openWord(page, 'Linked to the conversation')
    // the office host answers the editor's language from the page (lang=en): ribbon, status bar, tooltips in English
    expect(await frame.evaluate(() => location.search)).toContain('lang=en')
    const ui = await editorUi(frame)
    expect(ui).toEqual(expect.arrayContaining(['Home', 'Insert', 'Layout', 'Review']))
    expect(ui.filter((t) => HANGUL.test(t)), 'Korean in the editor UI').toEqual([])
    const [before] = await pictureNodes(frame)
    expect(before).toMatchObject({ replaced: false })
    // the real click: "@ Point" on, then the picture → the chip in the chat input
    await pointAtPicture(page, frame, 'Point')
    await expect(page.locator('.composer .mentions .mention').first()).toContainText('Image 1')
    const sent = []
    await page.route('**/api/threads/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      sent.push(route.request().postDataJSON())
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' })
    })
    await page.locator('.foot .composer textarea').click()
    await page.keyboard.type('Recolor the picture in navy tones')
    await page.keyboard.press('Enter')
    // the picture comes out of the Word document into PhotoCraft (over it); once PhotoCraft is live the request goes
    await expect(page.locator('.pic .pic-tag')).toHaveText('Word document · image 1', { timeout: 60_000 })
    await expect(page.locator('.pic .cef iframe.frm')).toHaveAttribute('src', /^\/craft\/photocraft\//)
    await expect.poll(() => sent.at(-1)?.text || '', { timeout: 120_000 }).toBe('@Image 1 Recolor the picture in navy tones')
    expect(sent.at(-1).context).toMatch(/picture 1 of the Word document 'Moonlight Coffee Store #2 proposal\.docx'.*PhotoCraft/)
    expect(sent.at(-1).context).not.toMatch(HANGUL)
    // what the agent would do there, done directly: fill the picture navy in the open PhotoCraft
    const pc = page.frames().find((f) => f.url().includes('/craft/photocraft/'))
    await pc.evaluate(async () => {
      for (const [command, params] of [['select.all', {}], ['edit.fill', { contents: 'color', color: '#1f3a6e' }], ['select.deselect', {}]]) await window.photocraft.request('engine.execute', { command, params })
    })
    await page.locator('.pic .tb', { hasText: 'Put in Word document' }).click()
    await expect(page.locator('.pnote')).toContainText('in place of image 1 in the Word document', { timeout: 60_000 })
    await expect(page.locator('.pic')).toHaveCount(0)
    // the same picture node — same place in the document — now carries the new bytes
    const [after] = await pictureNodes(frame)
    expect(after).toMatchObject({ pos: before.pos, docxIndex: before.docxIndex, replaced: true })
    // ⌘S: an edited copy next to the original; the card points at it
    await frame.locator('.ProseMirror').click({ position: { x: 40, y: 40 } })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    let saved
    await expect.poll(async () => { saved = (await db.q('select content from pro_messages where id=$1', [card.id]))[0].content; return saved.url !== original }, { timeout: 60_000 }).toBe(true)
    const zo = await JSZip.loadAsync(DOCX)
    const ze = await JSZip.loadAsync(Buffer.from(await (await fetch(saved.url)).arrayBuffer()))
    const media = (z) => Object.keys(z.files).filter((f) => f.startsWith('word/media/') && !z.files[f].dir)
    const [mo] = media(zo)
    const me = media(ze)
    expect(me).toHaveLength(1)
    const was = await zo.file(mo).async('nodebuffer')
    const now = await ze.file(me[0]).async('nodebuffer')
    expect(now.equals(was), 'the picture in the saved .docx changed').toBe(false)
    // one picture, still right under "3. Floor Plan"
    const xml = await ze.file('word/document.xml').async('string')
    expect((xml.match(/<w:drawing/g) || []).length).toBe(1)
    const at = xml.indexOf('<w:drawing')
    expect(xml.slice(Math.max(0, at - 1500), at).replace(/<[^>]+>/g, '')).toContain('3. Floor Plan')
    expect(page.errors).toEqual([])
    await page.context().close()
  })

  test('F-EN-03 the same Word document in Korean mode: the editor UI and the chip stay Korean', async ({ browser, db }) => {
    test.setTimeout(180_000)
    const u = await account('word-ko', 'ko')
    await seedDoc(db, u)
    const page = await pageIn(browser, u, 'ko')
    const frame = await openWord(page, '대화와 연결됨')
    expect(await frame.evaluate(() => location.search)).not.toContain('lang=')
    expect(await editorUi(frame)).toEqual(expect.arrayContaining(['홈', '삽입']))
    await pointAtPicture(page, frame, '가리키기')
    await expect(page.locator('.composer .mentions .mention').first()).toContainText('이미지 1')
    expect(page.errors).toEqual([])
    await page.context().close()
  })

  test('F-EN-04 [model] panel apps in Korean and English: a plain sheet and a record-keeping app are designed and made; amounts under the copied field hint', async ({ db }) => {
    test.setTimeout(600_000)
    const made = []
    try {
      for (const lang of ['ko', 'en']) {
        const u = await account(`panel-${lang}`, lang)
        const sheet = lang === 'ko' ? '견적 현황판 패널을 만들어 줘. 고객사, 건명, 견적 금액, 상태(작성 중·발송·수주·실주), 담당자를 관리하는 앱이야.'
          : 'Make a Quote tracker panel: customer, project, quote amount, status (Drafting, Sent, Won, Lost) and owner.'
        const ledger = lang === 'ko' ? '2호점 공사 예산 장부 패널을 만들어 줘. 예산 배정·지출·지출 취소를 기록으로 쌓고 잔액은 기록에서 계산해.'
          : 'Make a Store #2 construction budget ledger panel: record budget allocations, spending and spending cancellations, and calculate the balance from the records.'
        for (const [what, description] of [['sheet', sheet], ['ledger', ledger]]) {
          const r = await u.post('/panel-apps', { description })
          expect(r.status, `${lang} ${what}: ${r.text}`).toBe(200)
          const app = r.body.app
          made.push({ u, app })
          expect(app.def.title).toBeTruthy()
          if (lang === 'en') expect(JSON.stringify([app.def.title, ...(app.def.fields || []).map((f) => f.label)]), 'English labels').not.toMatch(HANGUL)
          if (what === 'ledger') { expect(app.kind).toBe('events'); continue }
          // the router may copy a field as describe() lists it ("견적 금액(숫자)*", "Quote amount (number)*")
          const amount = app.def.fields.find((f) => f.type === 'number')
          expect(amount, 'a number field for the amount').toBeTruthy()
          // a person field takes a folder member: the owner (by id)
          const values = Object.fromEntries(app.def.fields.filter((f) => f.required && f !== amount).map((f) => [f.label, f.type === 'choice' ? f.choices[0] : f.type === 'date' ? '2026-11-03' : f.type === 'number' ? 1 : f.type === 'person' ? u.id : 'x']))
          values[`${amount.label}${lang === 'ko' ? '(숫자)' : ' (number)'}*`] = lang === 'ko' ? '2,450만 원' : '₩24.5M'
          const row = await u.post(`/panel-apps/${app.id}/rows`, { values })
          expect(row.status, row.text).toBe(200)
          expect(row.body.row[amount.key]).toBe(24500000)
        }
      }
    } finally {
      for (const { u, app } of made) { await u.del(`/panel-apps/${app.id}`).catch(() => {}); await removeFolder(db, app.folder?.slug).catch(() => {}) }
    }
  })
})
