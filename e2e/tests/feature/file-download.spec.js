// 파일이 열린 곳마다 머리의 「내려받기」 (스펙 openspec/specs/file-download). 2026-11-26 사용자: 「파일을 열면 바로 열리는 건 좋은데 다운로드 받을
// 방법이 없네. 지금 다운로드 받을 방법을 파일이 열린 상태에서 다운로드 버튼이 어딘가 있든지 뭔가 공통적으로 뭔가 작업이 돼야 될 것 같아가지고
// 이홈오피스가 됐든 각 툴들의 그 헤더 부분에 다운로드 받는 버튼이 있든 뭔가 조치가 있어야 될 것 같네.」
//   F-FD-01 채팅의 문서(docx · xlsx · pdf): 이음오피스 머리의 「내려받기」(공유 앞) → 보이는 한글 이름 그대로 · 바이트 그대로(저장소 주소의 열쇠 이름이 아님)
//   F-FD-02 고친 채팅 문서: 먼저 저장(편집기의 저장 → 편집본) → 그 판을 받음 「방금 저장한 판을 내려받았어요」 · 카드가 편집본을 가리킴;
//           저장이 안 되면 「마지막 저장본 받기」를 묻고 → 앞에 저장된 판(새로 친 글은 없음)
//   F-FD-03 그림 · 팩스(TIFF): 보기 화면 머리의 「내려받기」(✕ 앞) — 팩스 바닥의 따로 있던 「내려받기」는 없음
//   F-FD-04 공유 폴더의 파일: 미리보기 머리의 「내려받기」(「원본 받기」 자리) — 편집기 막대에는 없음(한 화면에 하나), 고치던 것은 먼저 폴더에
//           저장하고 그 판을 받음
//   F-FD-05 ArtCraft(시험용 CADCraft): 머리의 「내려받기」 · 앱에서 저장하지 않은 변경 → 「마지막 저장본 받기」 → 저장된 판
//   F-FD-06 휴대폰 390px 밝은 · 밤: 화살표만(이름은 aria-label · title), 화면 안, 옆으로 넘치지 않음, 눌러서 받음 — 문서 · 그림 · 폴더 미리보기
//   (검토 11-26)
//   F-FD-08 채팅에서 연 폴더 문서: 편집기는 올렸는데 폴더 커밋이 실패하면 「방금 저장한 판」이라 하지 않고 「마지막 저장본 받기」 → 폴더의 앞 판
//   F-FD-09 ArtCraft 에서 저장한 바로 뒤(카드가 아직 옮겨 가기 전)에도 그 저장본을 받음
//   F-FD-10 전체 화면의 문서 패널에서도 말풍선 · 물음이 보이고 누를 수 있음(전체 화면 요소 안)
//   F-FD-11 파일 칩 · 팩스 줄의 「내려받기」: 서버가 거절하면 그 까닭(새 탭을 열지 않음), 브라우저가 새 탭을 막으면 누를 링크
// (메일 첨부의 저장이 내 카드에 닿지 않을 때는 mail-attachments.spec.js 의 F-FD-12)
// (메일 첨부는 mail-attachments.spec.js 의 F-FD-07 — 가짜 Gmail 이 그쪽에 있다)
// 자기 스택(lib/localStack.js — 회사 download-ui, BFF 8967 · Vite 5367 부터 빈 포트), 실제 이음오피스 편집기(lib/officeHost.js, 5402 부터).
// 모델 · deepagents · completion 은 부르지 않는다(아무 데도 아닌 주소). CADCraft 는 시험용 껍데기(PRO_CRAFT_WEB_ROOT). 사람은 지어낸 이름(도하은).
// 엑셀 편집기는 이 개발 PC 의 office-host(ieumoffice-web, 11-26 빌드 · 11-25 빌드 모두)에서 페이지가 멈춰(동기 호출이 답을 받지 못함 — origin/main 의
// 화면에서도 같음) 기본은 시험용 껍데기로 연다: 단추와 받는 길은 편집기 밖(문서 패널)의 것이다. RT_REAL_SHEETS=1 이면 실제 엑셀 편집기.
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/file-download.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startStack, REPO, SERVER } from '../../lib/localStack.js'
import { startOfficeHost, officeHostDir } from '../../lib/officeHost.js'
import { XLSX, PNG, DXF } from '../../lib/seed.js'

test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/file-download/e2e/results')
const TENANT = 'download-ui'
const NOWHERE = 'http://127.0.0.1:9'
const DESK = { viewport: { width: 1280, height: 800 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// a small real .docx (python's zipfile, as folder-edit-save.spec.js)
function DOCX(lines) {
  const out = path.join(os.tmpdir(), `rt-dl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.docx`)
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
function docxText(file) {
  return execFileSync('python3', ['-c', 'import sys, zipfile, re; x = zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode("utf-8"); print(re.sub(r"<[^>]+>", "", re.sub(r"</w:p>", "\\n", x)))', file], { encoding: 'utf8' })
}
// a one-page PDF with a line of text (offsets counted, so a viewer takes it)
function PDF(text) {
  const stream = `BT /F1 24 Tf 72 760 Td (${text}) Tj ET`
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let out = '%PDF-1.4\n'
  const offs = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// the files of the chat (fictional): what an agent or an attachment leaves there as file cards
const F = {
  docx: { name: '견적서 초안 (최종).docx', type: DOCX_MIME },
  xlsx: { name: '2026년 11월 매출 집계.xlsx', type: XLSX_MIME },
  pdf: { name: '서비스 이용 계약서.pdf', type: 'application/pdf' },
  png: { name: '현장 사진 1.png', type: 'image/png' },
  tif: { name: '팩스 수신 11월 26일.tif', type: 'image/tiff' },
  tifbad: { name: '팩스_손상.tif', type: 'image/tiff' },
  dxf: { name: '2층 배치도.dxf', type: 'image/vnd.dxf' },
}
const FOLDER_FILE = '한소율_프로필.docx'
// the stand-in spreadsheet editor (see above): it says it is ready and draws into #root, as an IeumOffice editor page does
const REAL_SHEETS = process.env.RT_REAL_SHEETS === '1'
const SHEETS_STUB = `<!doctype html><html><head><meta charset="utf-8"><title>시트 편집기(시험용)</title></head><body style="margin:0;font:14px sans-serif">
<div id="root"><p style="margin:16px">시트 편집기(시험용 껍데기) — 통합 문서를 모두 로드했습니다</p></div>
<script>parent.postMessage({ source: 'ieum-office', type: 'ready', editor: 'sheets' }, '*')</script></body></html>`

// the stand-in CADCraft (its postMessage bridge — CraftEditorFrame): says it is ready, keeps the name and size of the file it was handed
const CAD_STUB = `<!doctype html><html><head><meta charset="utf-8"><title>CADCraft (시험용)</title></head>
<body style="margin:0;background:#22282f;color:#fff;font:14px sans-serif"><p style="margin:12px">CADCraft 시험용 껍데기</p><canvas width="400" height="240" style="background:#333;display:block;margin:12px"></canvas>
<script>addEventListener('message',(e)=>{const m=e.data||{};if(m.type==='cadcraft:open'){document.body.dataset.opened=m.name;document.body.dataset.bytes=String(m.bytes?.byteLength||0);document.querySelector('p').textContent='열린 파일: '+m.name}});
parent.postMessage({type:'cadcraft:ready'},location.origin)</script></body></html>`

let S, host, ME, craftRoot, slug
const bytesOf = {}

async function rawPost(token, p, buf, headers) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api${p}`, { method: 'POST', body: buf, headers: { Authorization: `Bearer ${token}`, ...headers } })
  const t = await r.text()
  if (!r.ok) throw new Error(`POST ${p} → ${r.status} ${t.slice(0, 200)}`)
  return JSON.parse(t)
}
async function page(browser, opts = DESK, { theme = 'light' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web, acceptDownloads: true })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ }
  }, [JSON.stringify(ME.session), theme])
  if (!REAL_SHEETS) await ctx.route(/\/office\/sheets\/\?/, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: SHEETS_STUB }))
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  p.urls = []
  p.on('request', (r) => p.urls.push(r.url()))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const card = (p, f) => p.locator(`[data-test="file-card"][data-file="${f.name}"] button.file`).last()
const oef = (p) => p.locator('.oef')
const note = (p) => p.locator('[data-test="download-note"]')
async function openChat(p, { phone = false } = {}) {
  await p.goto('/chat')
  if (phone) await p.locator('header.top .seg button', { hasText: '채팅' }).click()
}
// a press on the button and the browser's download it starts → {name, file, buf}
async function download(p, button, { tap = false } = {}) {
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60_000 }), tap ? button.tap() : button.click()])
  const file = await dl.path()
  return { name: dl.suggestedFilename(), file, buf: fs.readFileSync(file), url: dl.url() }
}
// the editor drawn (the frame's 「문서를 여는 중…」 gone): the editor page runs on this page's thread, so a press before that waits on it;
// a workbook is loaded when the editor says so
const shownText = async (p) => (await Promise.all(p.frames().filter((f) => f.url().includes('/office/')).map((f) => f.evaluate(() => document.body?.innerText || '').catch(() => '')))).join(' ')
async function editorOpen(p, editor) {
  await expect(p.locator('[data-testid="oef-opening"]')).toHaveCount(0, { timeout: 90_000 })
  if (editor === 'sheets') await expect.poll(() => shownText(p), { timeout: 60_000 }).toContain('통합 문서를 모두 로드했습니다')
  await p.waitForTimeout(1500)
}
// the docs editor ready to type in (its frame watches for edits once the editor says it is ready)
async function docsReady(p, scope = p) {
  const ed = scope.frameLocator('.oef iframe.frm')
  await expect(ed.locator('.ProseMirror')).toBeVisible({ timeout: 90_000 })
  await p.waitForTimeout(2500)
  return ed
}
async function typeAtEnd(p, ed, text) {
  await ed.locator('.ProseMirror p').last().click()
  await p.keyboard.press('End')
  await p.keyboard.type(text, { delay: 25 })
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  test.skip(!officeHostDir(), '빌드된 office-host 가 없음 (RT_OFFICE_HOST_DIR — 그 저장소 README §9)')
  fs.mkdirSync(SHOTS, { recursive: true })
  craftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-dl-craft-'))
  fs.mkdirSync(path.join(craftRoot, 'cadcraft'))
  fs.writeFileSync(path.join(craftRoot, 'cadcraft', 'index.html'), CAD_STUB)
  host = await startOfficeHost({ from: Number(process.env.RT_OFFICE_FROM) || 5402 })
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8967, webFrom: Number(process.env.RT_WEB_FROM) || 5367, officeTarget: host.url,
    env: { PRO_OFFICE_HOST_URL: host.url, PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: '', PRO_MEMENTO_URL: NOWHERE,
      PRO_MCP_HUB_URL: NOWHERE, PRO_JUDGE_URL: '', PRO_ONTOLOGY_BOLT_URL: '', PRO_CRAFT_WEB_ROOT: craftRoot } })
  ME = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '도하은')
  await S.join(ME)
  await cleanData()
  bytesOf.docx = DOCX(['견적서 초안', '1. 납품 품목: 사무용 의자 40개'])
  bytesOf.xlsx = await XLSX([['월', '매출'], ['10월', 1200000], ['11월', 1530000]])
  bytesOf.pdf = PDF('Service agreement - test')
  bytesOf.png = PNG(320, 180, [40, 120, 200])
  bytesOf.tif = fs.readFileSync(path.join(REPO, 'e2e/fixtures/tiff/fax-2p-g4.tif'))
  bytesOf.dxf = DXF
  bytesOf.tifbad = fs.readFileSync(path.join(REPO, 'e2e/fixtures/tiff/broken.tif'))
  const [main] = await S.api(ME.token, '/threads')
  for (const k of ['docx', 'xlsx', 'pdf', 'png', 'tif', 'dxf', 'tifbad']) {
    const a = await rawPost(ME.token, '/attachments', bytesOf[k], { 'Content-Type': F[k].type, 'X-File-Name': encodeURIComponent(F[k].name) })
    await S.q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'agent', 'file', $2)`, [main.id, { name: a.name, url: a.url, type: F[k].type }])
    F[k].url = a.url
  }
  // a shared folder of hers with one document (a run stopped half-way may have left this company's folder behind)
  await S.q('delete from pro_folders where tenant_id=$1', [TENANT])
  const f = await S.api(ME.token, '/folders', { method: 'POST', body: { name: '인사 자료', description: '내려받기 시험' } })
  slug = f.slug
  await rawPost(ME.token, `/folders/${slug}/files?path=${encodeURIComponent(FOLDER_FILE)}`, DOCX(['한소율', '경력: 하늘테크 3년']), { 'Content-Type': DOCX_MIME })
})

// everything this file made: her chat, its stored files (and the editor's edited copies beside them), the folder's published copies
async function cleanData() {
  if (!ME) return
  const { admin } = await import(path.join(SERVER, 'lib/supa.js'))
  for (const dir of [`pgpt-pro/${ME.id}/att`, `pgpt-pro/${ME.id}/ws`, `artifacts/${TENANT}/objects`]) {
    const l = await admin.storage.from('files').list(dir, { limit: 1000 }).catch(() => ({ data: [] }))
    if (l.data?.length) await admin.storage.from('files').remove(l.data.map((o) => `${dir}/${o.name}`)).catch(() => {})
  }
  await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [ME.id]).catch(() => {})
  await S.q(`delete from pro_threads where user_id=$1 and kind <> 'chat'`, [ME.id]).catch(() => {})
}
test.afterAll(async () => {
  if (S) {
    await cleanData().catch(() => {})
    const { PGPT_ROOT } = await import(path.join(SERVER, 'lib/paths.js'))
    fs.rmSync(path.join(PGPT_ROOT, 'services', 'deepagents', 'workspace', TENANT), { recursive: true, force: true })
    await S.stop()
  }
  await host?.stop()
  if (craftRoot) fs.rmSync(craftRoot, { recursive: true, force: true })
})

test('F-FD-01 채팅의 문서(docx · xlsx · pdf): 이음오피스 머리의 「내려받기」 → 보이는 한글 이름 그대로 · 바이트 그대로', async ({ browser }) => {
  test.setTimeout(240_000)
  const p = await page(browser)
  await openChat(p)
  for (const [k, editor] of [['docx', 'docs'], ['xlsx', 'sheets'], ['pdf', 'pdf']]) {
    await card(p, F[k]).click()
    await expect(oef(p).locator('iframe.frm')).toHaveAttribute('src', new RegExp(`/office/${editor}/\\?src=`), { timeout: 30_000 })
    const btn = oef(p).locator('[data-testid="oef-download"]')
    await expect(btn).toBeVisible()
    await expect(btn).toHaveAttribute('aria-label', '내려받기')
    await expect(btn).toContainText('내려받기')
    // its place: the first of the bar's actions, before 공유 (and the size and close buttons after it)
    const order = await oef(p).locator('.bar').evaluate((bar) => [...bar.querySelectorAll(':scope > button, :scope > img')].map((b) => b.getAttribute('data-testid') || b.getAttribute('alt') || b.getAttribute('title') || b.textContent.trim()))
    const share = order.findIndex((t) => /공유/.test(t))
    if (share >= 0) expect(order.indexOf('oef-download')).toBe(share - 1)
    expect(order.indexOf('oef-download')).toBe(order.indexOf('IeumOffice') + 1)
    expect(order.indexOf('oef-download')).toBeLessThan(order.indexOf('닫기'))
    if (k === 'docx') await docsReady(p)
    else await editorOpen(p, editor)
    if (k === 'docx') await shot(p, 'fd01-docx-bar')
    const got = await download(p, btn)
    // the name shown, not the storage key (…/att/<uuid>.docx)
    expect(got.name).toBe(F[k].name)
    expect(got.buf.equals(bytesOf[k])).toBe(true)
    await expect(note(p)).toHaveAttribute('data-kind', 'ok')
    await expect(note(p)).toHaveText(`내려받았어요 · ${F[k].name}`)
    if (k === 'xlsx') await shot(p, 'fd01-xlsx-downloaded')
    await oef(p).locator('.tb.ic[title="닫기"]').click()
    await expect(oef(p)).toHaveCount(0)
  }
  // the bytes came from the address the card already had (no new public address, no token in it)
  expect(p.urls.filter((u) => /\/storage\/v1\/object\/public\/files\//.test(u) && /[?&]download=/.test(u))).toEqual([])
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-FD-02 고친 채팅 문서: 먼저 저장하고 그 판을 받음 · 저장이 안 되면 「마지막 저장본 받기」 → 앞의 판', async ({ browser }) => {
  test.setTimeout(300_000)
  const p = await page(browser)
  await openChat(p)
  await card(p, F.docx).click()
  const ed = await docsReady(p)
  await typeAtEnd(p, ed, ' 내려받기전저장')
  const btn = oef(p).locator('[data-testid="oef-download"]')
  const got = await download(p, btn)
  expect(got.name).toBe(F.docx.name)
  expect(docxText(got.file)).toContain('내려받기전저장')
  await expect(note(p)).toHaveText(`방금 저장한 판을 내려받았어요 · ${F.docx.name}`)
  await shot(p, 'fd02-1-saved-first')
  // the card now stands on the edited copy (the editor's own save: edited-… beside the original)
  await expect.poll(async () => (await S.q(`select content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.content->>'name'=$2`, [ME.id, F.docx.name]))[0]?.content?.url || '', { timeout: 20_000 }).toMatch(/\/edited-[^/]+\.docx$/)

  // a save that does not go through: the editor's 「saved」 answer is turned into 「save-failed」 (as the editor says when its upload fails)
  await typeAtEnd(p, ed, ' 저장안된두번째')
  // (the editor's 저장 is stopped before the editor sees it — nothing is uploaded — and the editor's page says the save failed, as the
  // editor does when its upload fails: from its own window)
  const editorPage = p.frames().find((f) => f.url().includes('/office/docs/'))
  await editorPage.evaluate(() => {
    for (const b of document.querySelectorAll('.qa-btn')) {
      b.addEventListener('click', (e) => {
        e.stopImmediatePropagation(); e.preventDefault()
        parent.postMessage({ source: 'ieum-office', type: 'save-failed', error: '저장소에 닿지 않아요(시험)' }, '*')
      }, true)
    }
  })
  await btn.click()
  await expect(note(p)).toHaveAttribute('data-kind', 'offer', { timeout: 10_000 })
  await expect(note(p)).toContainText('저장하지 못했어요 (저장소에 닿지 않아요(시험)). 마지막으로 저장된 판을 내려받을까요? 방금 고친 내용은 들어 있지 않아요.')
  await expect(note(p)).toHaveAttribute('role', 'alertdialog')
  await shot(p, 'fd02-2-offer-last-saved')
  const last = await download(p, note(p).locator('[data-test="download-last"]'))
  expect(last.name).toBe(F.docx.name)
  const text = docxText(last.file)
  expect(text).toContain('내려받기전저장')
  expect(text).not.toContain('저장안된두번째')
  await expect(note(p)).toHaveText(`마지막으로 저장된 판을 내려받았어요 — 방금 고친 내용은 들어 있지 않아요 · ${F.docx.name}`)
  await shot(p, 'fd02-3-last-saved')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-FD-03 그림 · 팩스(TIFF): 보기 화면 머리의 「내려받기」(✕ 앞) — 이름 그대로', async ({ browser }) => {
  const p = await page(browser)
  await openChat(p)
  const v = p.locator('[data-test="media-viewer"]')
  for (const k of ['png', 'tif']) {
    await card(p, F[k]).click()
    await expect(v).toBeVisible()
    const btn = v.locator('header [data-test="download"]')
    await expect(btn).toBeVisible()
    // before ✕
    const xs = await v.locator('header').evaluate((h) => [...h.querySelectorAll('button')].map((b) => b.getAttribute('data-test')))
    expect(xs).toEqual(['download', 'media-close'])
    if (k === 'tif') {
      await expect(v.locator('[data-test="tiff-view"]')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 })
      await expect(v.locator('[data-test="media-download"]')).toHaveCount(0)
    }
    const got = await download(p, btn)
    expect(got.name).toBe(F[k].name)
    expect(got.buf.equals(bytesOf[k])).toBe(true)
    await shot(p, `fd03-${k}-viewer`)
    await p.keyboard.press('Escape')
    await expect(v).toHaveCount(0)
  }
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-FD-04 공유 폴더의 파일: 미리보기 머리의 「내려받기」 — 편집기 막대에는 없음, 고치던 것은 먼저 폴더에 저장하고 그 판을 받음', async ({ browser }) => {
  test.setTimeout(300_000)
  const p = await page(browser)
  await p.goto(`/folders/${slug}`)
  await p.getByText(FOLDER_FILE, { exact: true }).first().click()
  const sheet = p.locator('.sheet.glass')
  await expect(sheet).toBeVisible()
  const btn = sheet.locator('header.hd [data-test="download"]')
  await expect(btn).toBeVisible()
  await expect(btn).toContainText('내려받기')
  // one on the screen: the editor's own bar has none here
  await expect(sheet.locator('[data-test="download"]')).toHaveCount(1)
  await expect(sheet.getByText('원본 받기')).toHaveCount(0)
  const ed = await docsReady(p, sheet)
  await expect(sheet.locator('.oef [data-testid="oef-download"]')).toHaveCount(0)
  await shot(p, 'fd04-1-folder-preview')
  const plain = await download(p, btn)
  expect(plain.name).toBe(FOLDER_FILE)
  expect(docxText(plain.file)).toContain('하늘테크 3년')
  // an edit not saved yet: into the folder first, then that version
  await typeAtEnd(p, ed, ' 폴더저장후받기')
  const got = await download(p, btn)
  expect(got.name).toBe(FOLDER_FILE)
  expect(docxText(got.file)).toContain('폴더저장후받기')
  await expect(note(p)).toHaveText(`방금 저장한 판을 내려받았어요 · ${FOLDER_FILE}`)
  await expect(sheet.locator('.sv.ok')).toContainText('폴더에 저장했어요')
  await shot(p, 'fd04-2-folder-saved-first')
  // and the folder's main has it
  const raw = await fetch(`http://127.0.0.1:${S.apiPort}/api/folders/${slug}/raw?path=${encodeURIComponent(FOLDER_FILE)}`, { headers: { Authorization: `Bearer ${ME.token}` } })
  const tmp = path.join(os.tmpdir(), `rt-dl-main-${Date.now()}.docx`)
  fs.writeFileSync(tmp, Buffer.from(await raw.arrayBuffer()))
  expect(docxText(tmp)).toContain('폴더저장후받기')
  fs.rmSync(tmp, { force: true })
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-FD-05 ArtCraft(시험용 CADCraft): 머리의 「내려받기」 · 앱에서 저장하지 않은 변경 → 「마지막 저장본 받기」', async ({ browser }) => {
  const p = await page(browser)
  await openChat(p)
  await card(p, F.dxf).click()
  const cef = p.locator('.cef')
  await expect(cef.locator('iframe.frm')).toHaveAttribute('src', /\/craft\/cadcraft\//)
  const app = p.frameLocator('.cef iframe.frm')
  await expect(app.locator('body')).toHaveAttribute('data-opened', F.dxf.name, { timeout: 30_000 })
  const btn = cef.locator('[data-testid="cef-download"]')
  await expect(btn).toBeVisible()
  const order = await cef.locator('.bar').evaluate((bar) => [...bar.querySelectorAll(':scope > button')].map((b) => b.getAttribute('data-testid') || b.getAttribute('title') || b.textContent.trim()))
  expect(order[0]).toBe('cef-download')
  const got = await download(p, btn)
  expect(got.name).toBe(F.dxf.name)
  expect(got.buf.equals(bytesOf.dxf)).toBe(true)
  // a change the app has not saved (the app says so through its bridge): said, and the last saved file offered
  await p.frames().find((f) => f.url().includes('/craft/cadcraft/')).evaluate(() => parent.postMessage({ type: 'cadcraft:dirty', dirty: true }, location.origin))
  await expect(cef.locator('.badge.warn')).toContainText('저장 안 됨')
  await btn.click()
  await expect(note(p)).toHaveAttribute('data-kind', 'offer')
  await expect(note(p)).toContainText('앱에서 고친 내용이 아직 저장되지 않았어요(SAVE 로 저장). 마지막으로 저장된 판을 내려받을까요?')
  await shot(p, 'fd05-craft-offer')
  const last = await download(p, note(p).locator('[data-test="download-last"]'))
  expect(last.name).toBe(F.dxf.name)
  expect(last.buf.equals(bytesOf.dxf)).toBe(true)
  // 취소 puts it away without a download
  await btn.click()
  await note(p).locator('[data-test="download-cancel"]').click()
  await expect(note(p)).toHaveCount(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

for (const theme of ['light', 'dark']) {
  test(`F-FD-06 휴대폰 390px(${theme === 'light' ? '밝은' : '밤'} 테마): 화살표만 · 화면 안 · 눌러서 받음 — 문서 · 그림 · 폴더 미리보기`, async ({ browser }) => {
    test.setTimeout(240_000)
    const p = await page(browser, PHONE, { theme })
    const arrowOnly = async (btn) => {
      await expect(btn).toBeVisible()
      await expect(btn).toHaveAttribute('aria-label', '내려받기')
      await expect(btn).toHaveAttribute('title', '내려받기')
      await expect(btn.locator('.t')).toBeHidden()
      const b = await btn.boundingBox()
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(390)
      expect(b.width).toBeLessThanOrEqual(44)
    }
    // the document panel (the whole phone)
    await openChat(p, { phone: true })
    await card(p, F.docx).click()
    await expect(oef(p).locator('iframe.frm')).toHaveAttribute('src', /\/office\/docs\//, { timeout: 30_000 })
    const dbtn = oef(p).locator('[data-testid="oef-download"]')
    await arrowOnly(dbtn)
    await expect(oef(p).locator('.tb.ic[title="닫기"]')).toBeInViewport()
    await docsReady(p)
    expect(await noOverflow(p)).toBe(true)
    const d = await download(p, dbtn, { tap: true })
    expect(d.name).toBe(F.docx.name)
    await expect(note(p)).toBeVisible()
    const nb = await note(p).boundingBox()
    expect(nb.x).toBeGreaterThanOrEqual(0)
    expect(nb.x + nb.width).toBeLessThanOrEqual(390)
    await shot(p, `fd06-${theme}-1-docx`)
    await oef(p).locator('.tb.ic[title="닫기"]').tap()
    await expect(oef(p)).toHaveCount(0)
    // the viewer
    await card(p, F.png).click()
    const v = p.locator('[data-test="media-viewer"]')
    await expect(v).toBeVisible()
    const vbtn = v.locator('header [data-test="download"]')
    await arrowOnly(vbtn)
    const g = await download(p, vbtn, { tap: true })
    expect(g.name).toBe(F.png.name)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `fd06-${theme}-2-image`)
    await v.locator('[data-test="media-close"]').tap()
    // a folder's file
    await p.goto(`/folders/${slug}`)
    await p.getByText(FOLDER_FILE, { exact: true }).first().click()
    const sheet = p.locator('.sheet.glass')
    const fbtn = sheet.locator('header.hd [data-test="download"]')
    await arrowOnly(fbtn)
    await expect(sheet.locator('header.hd [title="닫기"]')).toBeInViewport()
    await docsReady(p, sheet)
    expect(await noOverflow(p)).toBe(true)
    const f = await download(p, fbtn, { tap: true })
    expect(f.name).toBe(FOLDER_FILE)
    await shot(p, `fd06-${theme}-3-folder`)
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}

// ---------- review 11-26 ----------
test('F-FD-08 채팅에서 연 폴더 문서: 편집기는 올렸는데 폴더 커밋이 실패하면 「마지막 저장본 받기」 → 폴더의 앞 판', async ({ browser }) => {
  test.setTimeout(240_000)
  // a folder_open card for the folder's document (as the agent's folder_open leaves it), editable: its saves are commits in the folder
  const pub = await S.api(ME.token, `/folders/${slug}/publish`, { method: 'POST', body: { path: FOLDER_FILE } })
  const before = await (await fetch(`http://127.0.0.1:${S.apiPort}/api/folders/${slug}/raw?path=${encodeURIComponent(FOLDER_FILE)}`, { headers: { Authorization: `Bearer ${ME.token}` } })).arrayBuffer()
  const [main] = await S.api(ME.token, '/threads')
  const NAME = FOLDER_FILE
  await S.q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'agent', 'file', $2)`,
    [main.id, { name: NAME, url: pub.url, ext: 'docx', folder: { slug, name: '인사 자료', path: FOLDER_FILE, sha: pub.sha, editable: true } }])
  const p = await page(browser)
  // the folder's commit fails (the server answers the card's save with an error); the editor's own upload goes through
  await p.route('**/api/messages/*/file', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '폴더 저장소에 닿지 않아요(시험)' }) }))
  await openChat(p)
  await card(p, { name: NAME }).click()
  const ed = await docsReady(p)
  await expect(oef(p).locator('.badge.auto')).toBeVisible()
  await typeAtEnd(p, ed, ' 커밋실패시험')
  const btn = oef(p).locator('[data-testid="oef-download"]')
  await btn.click()
  await expect(note(p)).toHaveAttribute('data-kind', 'offer', { timeout: 40_000 })
  await expect(note(p)).toContainText('저장하지 못했어요 (폴더 저장소에 닿지 않아요(시험)). 마지막으로 저장된 판을 내려받을까요? 방금 고친 내용은 들어 있지 않아요.')
  await shot(p, 'fd08-folder-commit-failed-offer')
  const last = await download(p, note(p).locator('[data-test="download-last"]'))
  expect(last.name).toBe(FOLDER_FILE)
  // the folder's version the card stands on: the bytes of main before (nothing of the new text)
  expect(last.buf.equals(Buffer.from(before))).toBe(true)
  expect(docxText(last.file)).not.toContain('커밋실패시험')
  await expect(note(p)).toHaveText(`마지막으로 저장된 판을 내려받았어요 — 방금 고친 내용은 들어 있지 않아요 · ${FOLDER_FILE}`)
  // and once the folder takes it again, the same press says 「방금 저장한 판」 and gives the commit
  await p.unroute('**/api/messages/*/file')
  const got = await download(p, btn)
  expect(docxText(got.file)).toContain('커밋실패시험')
  await expect(note(p)).toHaveText(new RegExp(`^(방금 저장한 판을 내려받았어요|내려받았어요) · ${FOLDER_FILE.replace('.', '\\.')}$`))
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-FD-09 ArtCraft 에서 저장한 바로 뒤(카드가 아직 옮겨 가기 전)에도 그 저장본을 받음', async ({ browser }) => {
  const p = await page(browser)
  // the page that opened it moves the card to the saved copy only after its own call: held back here
  let release
  const held = new Promise((ok) => { release = ok })
  await p.route('**/api/messages/*/file', async (r) => { await held; await r.continue() })
  await openChat(p)
  await card(p, F.dxf).click()
  const cef = p.locator('.cef')
  const app = p.frameLocator('.cef iframe.frm')
  await expect(app.locator('body')).toHaveAttribute('data-opened', F.dxf.name, { timeout: 30_000 })
  // SAVE in the app (its bridge hands over the new drawing)
  const NEW = Buffer.from(['0', 'SECTION', '2', 'ENTITIES', '0', 'CIRCLE', '8', '0', '10', '50', '20', '50', '30', '0', '40', '25', '0', 'ENDSEC', '0', 'EOF', ''].join('\n'))
  await p.frames().find((f) => f.url().includes('/craft/cadcraft/')).evaluate((b) => parent.postMessage({ type: 'cadcraft:save', name: '2층 배치도.dxf', bytes: new Uint8Array(b).buffer }, location.origin), [...NEW])
  await expect(cef.locator('.notice.success')).toContainText('저장했어요', { timeout: 20_000 })
  const got = await download(p, cef.locator('[data-testid="cef-download"]'))
  expect(got.name).toBe(F.dxf.name)
  expect(got.buf.equals(NEW)).toBe(true)
  release()
  await shot(p, 'fd09-craft-saved-then-downloaded')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-FD-10 전체 화면의 문서 패널에서도 말풍선 · 물음이 보이고 누를 수 있음', async ({ browser }) => {
  const p = await page(browser)
  await openChat(p)
  await card(p, F.docx).click()
  const ed = await docsReady(p)
  await oef(p).locator('.tb', { hasText: '전체 화면' }).click()
  await expect.poll(() => p.evaluate(() => document.fullscreenElement?.classList.contains('oef') || false)).toBe(true)
  const btn = oef(p).locator('[data-testid="oef-download"]')
  const shown = () => p.evaluate(() => {
    const n = document.querySelector('[data-test="download-note"]')
    if (!n) return 'none'
    const r = n.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return `${document.fullscreenElement?.contains(n) ? 'inside' : 'outside'} ${hit && n.contains(hit) ? 'hit' : 'covered'}`
  })
  const got = await download(p, btn)
  expect(got.name).toBe(F.docx.name)
  await expect(note(p)).toHaveAttribute('data-kind', 'ok')
  expect(await shown()).toBe('inside hit')
  await shot(p, 'fd10-fullscreen-note')
  // the offer too, and its button is pressed there (the editor's save is stopped, as in F-FD-02)
  await typeAtEnd(p, ed, ' 전체화면')
  const editorPage = p.frames().find((f) => f.url().includes('/office/docs/'))
  await editorPage.evaluate(() => {
    for (const b of document.querySelectorAll('.qa-btn')) {
      b.addEventListener('click', (e) => { e.stopImmediatePropagation(); e.preventDefault(); parent.postMessage({ source: 'ieum-office', type: 'save-failed', error: '저장소에 닿지 않아요(시험)' }, '*') }, true)
    }
  })
  await btn.click()
  await expect(note(p)).toHaveAttribute('data-kind', 'offer', { timeout: 10_000 })
  expect(await shown()).toBe('inside hit')
  await shot(p, 'fd10-fullscreen-offer')
  const last = await download(p, note(p).locator('[data-test="download-last"]'))
  expect(last.name).toBe(F.docx.name)
  await p.evaluate(() => document.exitFullscreen())
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-FD-11 파일 칩 · 팩스 줄의 「내려받기」: 서버가 거절하면 그 까닭(새 탭 없음), 브라우저가 새 탭을 막으면 누를 링크', async ({ browser }) => {
  const p = await page(browser)
  const tabs = []
  p.context().on('page', (x) => tabs.push(x.url()))
  await openChat(p)
  // the damaged fax in the chat: 「이 TIFF 는 열 수 없어요 · 내려받기」
  const line = p.locator(`[data-test="media-preview"][data-file="${F.tifbad.name}"] [data-test="tiff-error"]`)
  await expect(line).toBeVisible({ timeout: 30_000 })
  const dl = line.locator('[data-test="tiff-download"]')
  // as it is: the file, under its name
  const ok = await download(p, dl)
  expect(ok.name).toBe(F.tifbad.name)
  expect(ok.buf.equals(bytesOf.tifbad)).toBe(true)
  // refused (the stored file is gone): said, no tab opened
  await p.route(`${F.tifbad.url}`, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found', message: 'Object not found' }) }))
  await dl.click()
  await expect(note(p)).toHaveAttribute('data-kind', 'err')
  await expect(note(p)).toHaveText('내려받지 못했어요 · 파일을 찾지 못했어요.')
  await shot(p, 'fd11-refused')
  expect(tabs).toEqual([])
  // not reachable from the page and the browser blocks the new tab: a link to press
  await p.unroute(`${F.tifbad.url}`)
  await p.route(`${F.tifbad.url}`, (r) => r.abort('failed'))
  await p.evaluate(() => { window.open = () => null })
  await dl.click()
  await expect(note(p)).toHaveAttribute('data-kind', 'link')
  await expect(note(p)).toContainText('브라우저가 새 창을 막았어요 · 눌러서 여세요')
  const href = await note(p).locator('a.go').getAttribute('href')
  expect(new URL(href).searchParams.get('download')).toBe(F.tifbad.name)
  expect(href.startsWith(F.tifbad.url)).toBe(true)
  await shot(p, 'fd11-blocked-link')
  expect(p.errors).toEqual([])
  await p.context().close()
})
