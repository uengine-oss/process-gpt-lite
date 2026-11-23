// 공유 폴더 문서를 이음오피스에서 고치면 폴더에 저장(2026-11-24 휴대폰 녹화) — 폴더 › 이력서 › 장진영_프로필.docx 를 열어
// 고쳤는데 닫으니 「그냥 바로 사라지고 있습니다」 · 「저장이 되어야죠」. 폴더 미리보기는 이음오피스를 보기 전용으로 열었고
// (휴대폰 폭에서는 그 표시도 숨겨짐), 편집기는 저장 단추 · Ctrl+S 에만 파일을 쓰는데 휴대폰에는 둘 다 없었다.
// 고친 뒤: 폴더의 편집자에게는 편집으로 열리고, 손을 멈추면 · 화면을 떠나면 · 닫을 때 저절로 저장돼 폴더 main 에
// 「이음오피스에서 고침」으로 남는다(한 번 편집은 이력 한 줄). 연 뒤 다른 사람이 먼저 고쳤으면 「… (이름 수정본)」으로 옆에.
// 보기 권한이면 「보기 전용」이 휴대폰에서도 보이고, 입력하면 저장되지 않는다고 알려 준다. 채팅에서 연 폴더 문서(folder_open
// 카드)도 같은 길로 폴더에 저장된다.
// 실제 이음오피스 호스트가 필요하다(개발 서버의 /office → PRO_OFFICE_TARGET, 운영 이미지 ecea940 으로 시험함).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect, uniq } from '../../lib/fixtures.js'
import { removeFolder } from '../../lib/seed.js'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const FILE = '장진영_프로필.docx'
// a small real .docx (python's zipfile, as folder-open.spec.js)
function DOCX(lines) {
  const out = path.join(os.tmpdir(), `rt-folder-edit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.docx`)
  const body = lines.map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('')
  const py = [
    'import sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)',
    `z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')`,
    `z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')`,
    `z.writestr("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + sys.argv[2] + '</w:body></w:document>')`,
    'z.close()',
  ].join('\n')
  execFileSync('python3', ['-c', py, out, body], { stdio: 'pipe' })
  const b = fs.readFileSync(out)
  fs.rmSync(out, { force: true })
  return b
}
// the text of a .docx (its paragraphs, tags dropped)
function docxText(buf) {
  const f = path.join(os.tmpdir(), `rt-folder-edit-read-${process.pid}-${Math.random().toString(36).slice(2, 8)}.docx`)
  fs.writeFileSync(f, buf)
  try {
    return execFileSync('python3', ['-c', 'import sys, zipfile, re; x = zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode("utf-8"); print(re.sub(r"<[^>]+>", "", re.sub(r"</w:p>", "\\n", x)))', f], { encoding: 'utf8' })
  } finally { fs.rmSync(f, { force: true }) }
}
const raw = async (u, slug, p = FILE) => Buffer.from(await (await u.get(`/folders/${slug}/raw?path=${encodeURIComponent(p)}`, { raw: true })).arrayBuffer())
const history = async (u, slug) => (await u.get(`/folders/${slug}`)).body.history || []
const edits = (h) => h.filter((c) => String(c.msg || '').startsWith('이음오피스에서 고침'))

async function seed(o, db, cleanup, lines = ['장진영', '경력: 유엔진 솔루션즈 대표']) {
  const f = await o.post('/folders', { name: uniq('회귀 이력서'), description: '이음오피스 편집 저장' })
  expect(f.status, f.text).toBe(200)
  cleanup(() => removeFolder(db, f.body.slug))
  const up = await o.post(`/folders/${f.body.slug}/files?path=${encodeURIComponent(FILE)}`, DOCX(lines), { headers: { 'Content-Type': DOCX_MIME } })
  expect(up.status, up.text).toBe(200)
  return f.body.slug
}
// the folder screen → the file → the editor; returns the editor's frame
async function openInFolder(page, slug) {
  await page.goto(`/folders/${slug}`)
  await page.getByText(FILE, { exact: true }).first().click()
  const sheet = page.locator('.sheet.glass')
  await expect(sheet).toBeVisible()
  const ed = page.frameLocator('.sheet.glass iframe.frm')
  await expect(ed.locator('.ProseMirror')).toBeVisible({ timeout: 90_000 })
  // (the frame starts watching for edits once the editor says it is ready)
  await page.waitForTimeout(2500)
  return { sheet, ed }
}
async function typeAtEnd(page, ed, text) {
  await ed.locator('.ProseMirror p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.type(text, { delay: 30 })
}

test.describe('공유 폴더 문서를 이음오피스에서 고치면 폴더에 저장', () => {
  test.describe.configure({ timeout: 300_000 })

  test('F-FE-01 편집자가 연 문서는 편집으로 열리고, 손을 멈추면 폴더 main 에 저장된다', async ({ as, pageAs, db, cleanup }) => {
    const o = await as('fe-owner')
    const slug = await seed(o, db, cleanup)
    const page = await pageAs('fe-owner')
    const { sheet, ed } = await openInFolder(page, slug)
    await expect(sheet.locator('.badge.auto')).toBeVisible()
    await expect(sheet.locator('.badge.ro')).toHaveCount(0)
    await typeAtEnd(page, ed, ' 자동저장확인')
    await expect(sheet.locator('.sv.ok')).toContainText('폴더에 저장했어요', { timeout: 60_000 })
    expect(docxText(await raw(o, slug))).toContain('자동저장확인')
    const h = edits(await history(o, slug))
    expect(h.length).toBe(1)
    await page.screenshot({ path: test.info().outputPath('f-fe-01.png') })
    expect(page.errors).toEqual([])
  })

  test('F-FE-02 고치고 바로 닫아도 닫기 전에 저장한다(녹화의 그 순서)', async ({ as, pageAs, db, cleanup }) => {
    const o = await as('fe-owner')
    const slug = await seed(o, db, cleanup)
    const page = await pageAs('fe-owner')
    const { sheet, ed } = await openInFolder(page, slug)
    await typeAtEnd(page, ed, ' 닫기전저장')
    await sheet.locator('header.hd button[title="닫기"]').click()
    await expect(page.locator('.sheet.glass')).toHaveCount(0, { timeout: 60_000 })
    expect(docxText(await raw(o, slug))).toContain('닫기전저장')
    expect(edits(await history(o, slug)).length).toBe(1)
    // opened again, the edit is there
    const again = await openInFolder(page, slug)
    await expect(again.ed.locator('.ProseMirror')).toContainText('닫기전저장', { timeout: 30_000 })
    expect(page.errors).toEqual([])
  })

  test('F-FE-03 한 번 연 편집은 여러 번 저장돼도 이력 한 줄', async ({ as, pageAs, db, cleanup }) => {
    const o = await as('fe-owner')
    const slug = await seed(o, db, cleanup)
    const page = await pageAs('fe-owner')
    const { sheet, ed } = await openInFolder(page, slug)
    await typeAtEnd(page, ed, ' 첫번째')
    await expect(sheet.locator('.sv.ok')).toBeVisible({ timeout: 60_000 })
    const before = await history(o, slug)
    await typeAtEnd(page, ed, ' 두번째')
    await expect.poll(async () => docxText(await raw(o, slug)), { timeout: 60_000 }).toContain('두번째')
    const h = await history(o, slug)
    // the second save folded into the first one's entry: same number of entries, a new newest commit
    expect(edits(h).length).toBe(1)
    expect(h.length).toBe(before.length)
    expect(h[0].sha).not.toBe(before[0].sha)
    expect(docxText(await raw(o, slug))).toContain('첫번째')
  })

  test('F-FE-04 연 뒤에 다른 사람이 먼저 고쳤으면 덮어쓰지 않고 「(이름 수정본)」으로 옆에 둔다', async ({ as, pageAs, db, cleanup }) => {
    const o = await as('fe-owner'), other = await as('fe-editor2')
    const slug = await seed(o, db, cleanup)
    expect((await o.post(`/folders/${slug}/members`, { type: 'user', id: other.id, role: 'editor' })).status).toBe(200)
    const page = await pageAs('fe-owner')
    const { sheet, ed } = await openInFolder(page, slug)
    // meanwhile the other editor uploads their version
    const up = await other.post(`/folders/${slug}/files?path=${encodeURIComponent(FILE)}`, DOCX(['장진영', '다른 사람이 먼저 고침']), { headers: { 'Content-Type': DOCX_MIME } })
    expect(up.status, up.text).toBe(200)
    await typeAtEnd(page, ed, ' 내수정')
    await expect(sheet.locator('.sv.copy')).toContainText('수정본', { timeout: 60_000 })
    expect(docxText(await raw(o, slug))).toContain('다른 사람이 먼저 고침')
    expect(docxText(await raw(o, slug))).not.toContain('내수정')
    const tree = (await o.get(`/folders/${slug}/tree`)).body
    const copy = tree.find((f) => f.path !== FILE && f.path.includes('수정본'))
    expect(copy, JSON.stringify(tree.map((f) => f.path))).toBeTruthy()
    expect(docxText(await raw(o, slug, copy.path))).toContain('내수정')
    await page.screenshot({ path: test.info().outputPath('f-fe-04.png') })
  })

  test('F-FE-05 보기 권한이면 「보기 전용」이 보이고, 입력해도 폴더는 그대로', async ({ as, pageAs, db, cleanup }) => {
    const o = await as('fe-owner'), viewer = await as('fe-viewer')
    const slug = await seed(o, db, cleanup)
    expect((await o.post(`/folders/${slug}/members`, { type: 'user', id: viewer.id, role: 'viewer' })).status).toBe(200)
    const page = await pageAs('fe-viewer', { viewport: { width: 390, height: 844 }, touch: true })
    const { sheet, ed } = await openInFolder(page, slug)
    await expect(sheet.locator('.badge.ro')).toBeVisible()
    await typeAtEnd(page, ed, ' 보기전용입력')
    await expect(sheet.locator('.notice.info')).toContainText('보기 전용', { timeout: 10_000 })
    await page.waitForTimeout(9000)
    expect(edits(await history(o, slug)).length).toBe(0)
    expect(docxText(await raw(o, slug))).not.toContain('보기전용입력')
    await page.screenshot({ path: test.info().outputPath('f-fe-05.png') })
  })

  test('F-FE-06 휴대폰 폭: 자동 저장 표시가 보이고, 고친 뒤 닫으면 저장된다', async ({ as, pageAs, db, cleanup }) => {
    const o = await as('fe-owner')
    const slug = await seed(o, db, cleanup)
    const page = await pageAs('fe-owner', { viewport: { width: 390, height: 844 }, touch: true })
    const { sheet, ed } = await openInFolder(page, slug)
    await expect(sheet.locator('.badge.auto')).toBeVisible()
    await typeAtEnd(page, ed, ' 휴대폰저장')
    await expect(sheet.locator('.badge.auto')).toContainText(/고치는 중|저장하는 중/)
    await page.screenshot({ path: test.info().outputPath('f-fe-06-editing.png') })
    await sheet.locator('header.hd button[title="닫기"]').click()
    await expect(page.locator('.sheet.glass')).toHaveCount(0, { timeout: 60_000 })
    expect(docxText(await raw(o, slug))).toContain('휴대폰저장')
    await page.screenshot({ path: test.info().outputPath('f-fe-06-closed.png') })
  })

  test('F-FE-08 편집기가 준비될 때까지 「문서를 여는 중…」(빈 흰 화면이 아니라), 늦으면 까닭을 말한다', async ({ as, pageAs, db, cleanup }) => {
    const o = await as('fe-owner')
    const slug = await seed(o, db, cleanup)
    const page = await pageAs('fe-owner', { viewport: { width: 390, height: 844 }, touch: true })
    // a phone's first open: a cold editor and a 4x slower CPU (2026-11-24: 6–10 s)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 60, downloadThroughput: 9e6 / 8, uploadThroughput: 3e6 / 8 })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.goto(`/folders/${slug}`)
    await page.getByText(FILE, { exact: true }).first().click()
    const opening = page.locator('.sheet.glass [data-testid=oef-opening]')
    await expect(opening).toBeVisible({ timeout: 15_000 })
    await expect(opening).toContainText('문서를 여는 중')
    await expect(opening).toContainText('처음 열 때는', { timeout: 10_000 })
    await page.screenshot({ path: test.info().outputPath('f-fe-08-opening.png') })
    await expect(page.frameLocator('.sheet.glass iframe.frm').locator('.ProseMirror')).toBeVisible({ timeout: 120_000 })
    await expect(opening).toHaveCount(0, { timeout: 15_000 })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  })

  test('F-FE-07 채팅에서 연 폴더 문서(folder_open 카드)도 고치면 폴더에 저장된다', async ({ as, pageAs, db, cleanup }) => {
    const o = await as('fe-owner')
    const slug = await seed(o, db, cleanup)
    const pub = (await o.post(`/folders/${slug}/publish`, { path: FILE })).body
    expect(pub.editable).toBe(true)
    const page = await pageAs('fe-owner')
    const th = await db.clearMain(page.user.id)
    const [card] = await db.addMessages(th, [{ role: 'agent', kind: 'file', content: { name: FILE, url: pub.url, ext: 'docx', folder: { slug, name: '이력서', path: FILE, sha: pub.sha, editable: true } } }])
    await page.goto('/chat')
    await page.locator('.file', { hasText: FILE }).first().click()
    const ed = page.frameLocator('.sheet.glass iframe.frm')
    await expect(ed.locator('.ProseMirror')).toBeVisible({ timeout: 90_000 })
    await page.waitForTimeout(2500)
    await typeAtEnd(page, ed, ' 채팅에서고침')
    await expect.poll(async () => docxText(await raw(o, slug)), { timeout: 60_000 }).toContain('채팅에서고침')
    await expect(page.locator('.pnote.ok')).toContainText('폴더에 저장했어요', { timeout: 15_000 })
    const [m] = await db.q('select content from pro_messages where id=$1', [card.id])
    expect(m.content.folder_save?.ok).toBe(true)
    expect(m.content.folder.sha).not.toBe(pub.sha)
    expect(edits(await history(o, slug)).length).toBe(1)
    await page.screenshot({ path: test.info().outputPath('f-fe-07.png') })
  })

  test('F-FE-09 보기 권한인 사람이 채팅에서 연 폴더 문서는 보기 전용(저장 오류가 되풀이되지 않음)', async ({ as, pageAs, db, cleanup }) => {
    const o = await as('fe-owner'), viewer = await as('fe-viewer')
    const slug = await seed(o, db, cleanup)
    expect((await o.post(`/folders/${slug}/members`, { type: 'user', id: viewer.id, role: 'viewer' })).status).toBe(200)
    const pub = (await o.post(`/folders/${slug}/publish`, { path: FILE })).body
    const page = await pageAs('fe-viewer')
    const th = await db.clearMain(page.user.id)
    await db.addMessages(th, [{ role: 'agent', kind: 'file', content: { name: FILE, url: pub.url, ext: 'docx', folder: { slug, name: '이력서', path: FILE, sha: pub.sha, editable: false } } }])
    await page.goto('/chat')
    await page.locator('.file', { hasText: FILE }).first().click()
    const ed = page.frameLocator('.sheet.glass iframe.frm')
    await expect(ed.locator('.ProseMirror')).toBeVisible({ timeout: 90_000 })
    await expect(page.locator('.sheet.glass .badge.ro')).toBeVisible()
    await page.waitForTimeout(2500)
    await typeAtEnd(page, ed, ' 보는사람입력')
    await expect(page.locator('.sheet.glass .notice.info')).toContainText('보기 전용', { timeout: 10_000 })
    await page.waitForTimeout(9000)
    await expect(page.locator('.pnote.err')).toHaveCount(0)
    expect(edits(await history(o, slug)).length).toBe(0)
  })

  test('F-FE-10 고치는 중에 다른 카드를 열어도 먼저 폴더에 저장한다', async ({ as, pageAs, db, cleanup }) => {
    const o = await as('fe-owner')
    const slug = await seed(o, db, cleanup)
    const pub = (await o.post(`/folders/${slug}/publish`, { path: FILE })).body
    const page = await pageAs('fe-owner')
    const th = await db.clearMain(page.user.id)
    const other = await o.post(`/folders/${slug}/files?path=${encodeURIComponent('다른문서.docx')}`, DOCX(['다른 문서']), { headers: { 'Content-Type': DOCX_MIME } })
    expect(other.status, other.text).toBe(200)
    const pub2 = (await o.post(`/folders/${slug}/publish`, { path: '다른문서.docx' })).body
    await db.addMessages(th, [
      { role: 'agent', kind: 'file', content: { name: FILE, url: pub.url, ext: 'docx', folder: { slug, name: '이력서', path: FILE, sha: pub.sha, editable: true } } },
      { role: 'agent', kind: 'file', content: { name: '다른문서.docx', url: pub2.url, ext: 'docx', folder: { slug, name: '이력서', path: '다른문서.docx', sha: pub2.sha, editable: true } } },
    ])
    await page.goto('/chat')
    await page.locator('.file', { hasText: FILE }).first().click()
    const ed = page.frameLocator('.sheet.glass iframe.frm')
    await expect(ed.locator('.ProseMirror')).toBeVisible({ timeout: 90_000 })
    await page.waitForTimeout(2500)
    await typeAtEnd(page, ed, ' 바꾸기전저장')
    // straight away (before the pause that saves by itself): the other card
    await page.locator('.file', { hasText: '다른문서.docx' }).first().click()
    await expect(page.locator('.sheet.glass')).toContainText('다른문서', { timeout: 60_000 })
    expect(docxText(await raw(o, slug))).toContain('바꾸기전저장')
    expect(page.errors).toEqual([])
  })
})
