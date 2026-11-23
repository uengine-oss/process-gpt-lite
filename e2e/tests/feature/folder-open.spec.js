// 공유 폴더 파일 열기(2026-11-23 사진) — 「장진영 이력서를 열어줘」에 에이전트가 폴더의 파일을 찾아도 "DOCX 는 바이너리라
// 열 수 없다"고만 했다(「이음오피스로 바로 열어줬어야」). 고친 뒤: folder_open 도구의 결과가 파일 카드로 오고(open: true),
// 그 말을 보낸 화면은 카드가 오자마자 이음오피스 편집기를 연다. 다른 화면(같은 사람의 다른 기기)은 카드만 받는다.
// 에이전트 없이: 보내기는 가로채고, 카드는 실시간 이벤트(SSE)로 넣는다 — 서버 쪽 도구는 server/test/folderFindOpen.test.js.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect, api } from '../../lib/fixtures.js'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
// a small real .docx (zip of three parts), made with python's zipfile — no python-docx needed
function DOCX(lines) {
  const out = path.join(os.tmpdir(), `rt-folder-open-${process.pid}-${Date.now()}.docx`)
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

// the screen's live events come from here: hello (so it does not fall back to polling), then the
// queued messages once the chat message was sent
async function liveEvents(page) {
  const queue = []
  await page.route(/\/api\/events\?/, async (route) => {
    const body = ['event: hello\ndata: {}\n\n', ...queue.splice(0).map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`)].join('')
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body })
  })
  return (m) => queue.push(m)
}

async function setup(pageAs, db, area) {
  const page = await pageAs(area)
  // a clean main chat each run (the cards of earlier runs would answer the locators)
  const main = await db.clearMain(page.user.id)
  const push = await liveEvents(page)
  let threadId = null
  await page.route('**/api/threads/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    threadId = /\/threads\/([^/]+)\/messages/.exec(route.request().url())[1]
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' })
  })
  const up = await api.upload(page.user.token(), '장진영_프로필.docx', DOCX_MIME, DOCX(['장진영', '경력: 유엔진 솔루션즈 대표', '이력서 · 회귀 시험']))
  const card = (thread, extra = {}) => ({ id: crypto.randomUUID(), thread_id: thread, role: 'agent', kind: 'file', created_at: new Date().toISOString(),
    content: { name: '장진영_프로필.docx', url: up.url, ext: 'docx', ...extra } })
  return { page, push, card, main, thread: () => threadId }
}

test.describe('공유 폴더 파일을 채팅에서 바로 열기', () => {
  test('F-FO-01 「열어 줘」를 보낸 화면은 열기 카드가 오자마자 이음오피스로 연다', async ({ pageAs, db }) => {
    const { page, push, card, thread } = await setup(pageAs, db, 'fo-open')
    await page.goto('/chat')
    await page.locator('.composer textarea').first().fill('장진영 이력서를 열어줘')
    await page.keyboard.press('Enter')
    await expect.poll(thread).not.toBeNull()
    push(card(thread(), { open: true }))
    await expect(page.locator('.sheet.glass')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.sheet.glass')).toContainText('장진영_프로필')
    await page.waitForTimeout(2500)
    await page.screenshot({ path: test.info().outputPath('f-fo-01.png') })
    expect(page.errors).toEqual([])
  })

  test('F-FO-02 말을 보내지 않은 화면(다른 기기)은 카드만 받고 편집기를 열지 않는다', async ({ pageAs, db }) => {
    const { page, push, card, main } = await setup(pageAs, db, 'fo-other')
    await page.goto('/chat')
    push(card(main, { open: true }))
    await expect(page.locator('.file', { hasText: '장진영_프로필.docx' })).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1500)
    await expect(page.locator('.sheet.glass')).toHaveCount(0)
  })

  test('F-FO-03 열어 달라는 표시(open)가 없는 문서 카드는 전처럼 눌러야 열린다', async ({ pageAs, db }) => {
    const { page, push, card, thread } = await setup(pageAs, db, 'fo-plain')
    await page.goto('/chat')
    await page.locator('.composer textarea').first().fill('이력서 양식 만들어 줘')
    await page.keyboard.press('Enter')
    await expect.poll(thread).not.toBeNull()
    push(card(thread()))
    const file = page.locator('.file', { hasText: '장진영_프로필.docx' })
    await expect(file).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1500)
    await expect(page.locator('.sheet.glass')).toHaveCount(0)
    await file.click()
    await expect(page.locator('.sheet.glass')).toBeVisible()
  })
})
