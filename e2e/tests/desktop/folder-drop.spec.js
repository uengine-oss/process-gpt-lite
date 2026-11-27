// 폴더 — 데스크톱 앱(desktop/, Electron)에서 「파일 올리기」 · 「폴더 올리기」 · 폴더 끌어다 놓기 · 작업실 (사용자 녹화 11-27,
// spec openspec/specs/champion-folders 「올리기 메뉴는 시스템의 파일 창을 연다」 · 「컴퓨터의 폴더를 끌어다 놓아 올린다」).
// The real app from desktop/ with a user data folder of its own (never the person's installed app or its settings), against a stack of
// its own (lib/localStack.js: a BFF for several companies without a terminal key — as uengine.process-gpt.io runs — and Vite).
//   F-DR-10 「파일 올리기」 · 「폴더 올리기」가 시스템의 파일 창을 연다(Playwright 가 받아 파일을 고름) · 고른 폴더는 미리 보기를 거쳐 올라간다 ·
//           macOS 에서는 실제 파일 창(시트)이 앱 창 위에 뜬다(창 서버의 창 목록에 하나 더)
//   F-DR-11 앱 안에서 폴더를 놓으면(webkitGetAsEntry 를 흉내 낸 drop) 같은 미리 보기 → 올리기 · 작업실은 까닭을 보이고 머리줄은 창의 단추를 피한다
//   cd e2e && npx playwright test --project=desktop tests/desktop/folder-drop.spec.js
import { test, expect, _electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startStack, REPO, DESKTOP, desktopRequire } from '../../lib/localStack.js'

const SHOTS = path.join(REPO, 'openspec/specs/champion-folders/e2e/results')
const MAC = process.platform === 'darwin'
let ELECTRON = ''
try { ELECTRON = desktopRequire('electron') } catch { /* not installed */ }
const TENANT = 'folder-drop-ui'
const NOWHERE = 'http://127.0.0.1:9'

test.describe.configure({ mode: 'serial' })
test.skip(!ELECTRON || !fs.existsSync(ELECTRON), 'desktop/ 에 Electron 이 없음 (cd desktop && npm install)')

// the macOS windows of a process, from the window server (no accessibility permission needed): an open panel is one more
const windowsOf = (pid) => {
  if (!MAC) return null
  const js = `ObjC.import('CoreGraphics'); function run(a) { const l = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)); const o = [];
    for (let i = 0; i < l.count; i++) { const w = l.objectAtIndex(i); if (ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')) !== Number(a[0])) continue; const b = w.objectForKey('kCGWindowBounds');
      o.push({ w: ObjC.unwrap(b.objectForKey('Width')), h: ObjC.unwrap(b.objectForKey('Height')) }) } return JSON.stringify(o) }`
  try { return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', js, String(pid)]).toString()) } catch { return null }
}

let S, ME, app, page, root, slug, repo
test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_FD_API_PORT || 8981), webFrom: Number(process.env.RT_FD_WEB_PORT || 5381), env: {
    PRO_DEEPAGENTS_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_EMBED_URL: '',
    PRO_TENANT_HOSTS: 'en.localhost=en-demo', PRO_TERMINAL_KEY: '' } })
  ME = await S.person('pro-rt-fd-desk@uengine.org', '정하윤')
  await S.join(ME)
  const f = await S.api(ME.token, '/folders', { method: 'POST', body: { name: '유엔진플랫폼' } })
  slug = f.slug
  ;[{ repo_path: repo }] = await S.q('select repo_path from pro_folders where tenant_id=$1 and slug=$2', [TENANT, slug])
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-fd-desk-')))
  const env = { ...process.env, PGL_DESKTOP_USER_DATA: path.join(root, 'app'), PGL_DESKTOP_EXTERNAL: 'log', PGL_RUNNER_PATH: path.join(root, 'no-bin') }
  delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ executablePath: ELECTRON, args: [DESKTOP], env, timeout: 60_000 })
  page = await app.firstWindow()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(String(e?.message || e)))
  await page.locator('[data-test=server-url]').fill(`127.0.0.1:${S.webPort}`)
  await page.click('[data-test=setup-connect]')
  await page.waitForURL(/\/login/)
  await page.fill('input[type=email]', ME.email)
  await page.getByRole('button', { name: '계속', exact: true }).click()
  await page.locator('.code input').first().fill('000000')
  await page.waitForURL(/\/chat/)
})
test.afterAll(async () => {
  await app?.close().catch(() => {})
  if (S) {
    await S.q('delete from pro_local_devices where tenant_id=$1', [TENANT]).catch(() => {})
    await S.q('delete from pro_folders where tenant_id=$1', [TENANT]).catch(() => {})
    await S.q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
    await S.q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
    await S.stop()
  }
  if (root) fs.rmSync(root, { recursive: true, force: true })
})
// (the sheet's own animations finished before a picture is taken)
const calm = () => page.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 2000)),
])).then(() => page.waitForTimeout(200))
const mainFiles = () => execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'main'], { cwd: repo }).toString().split('\0').filter(Boolean)

test('F-DR-10 「파일 올리기」 · 「폴더 올리기」가 시스템의 파일 창을 연다', async () => {
  await page.goto(`http://127.0.0.1:${S.webPort}/folders/${slug}`)
  await expect(page.locator('html')).toHaveClass(/pgl-desktop/)
  // 파일 올리기 → the file window (taken by Playwright: a file is picked in it)
  fs.writeFileSync(path.join(root, '회의록.md'), '# 회의록\n')
  await page.locator('[data-test="folder-add-menu"]').click()
  let chooser = page.waitForEvent('filechooser')
  await page.locator('[data-test="folder-upload-files"]').click()
  let fc = await chooser
  expect(fc.isMultiple()).toBe(true)
  await fc.setFiles(path.join(root, '회의록.md'))
  await expect(page.locator('[data-test="folder-file"][data-file="회의록.md"]')).toBeVisible({ timeout: 20_000 })
  // 폴더 올리기 → a directory, through the same preview
  const dir = path.join(root, '제안 키트')
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), '# 제안 키트\n')
  fs.writeFileSync(path.join(dir, '.env'), 'A=1\n')
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '1\n')
  await page.locator('[data-test="folder-add-menu"]').click()
  chooser = page.waitForEvent('filechooser')
  await page.locator('[data-test="folder-upload-dir"]').click()
  fc = await chooser
  expect(await fc.element().evaluate((el) => el.webkitdirectory)).toBe(true)
  await fc.setFiles(dir)
  await expect(page.locator('[data-test="drop-sheet"]')).toBeVisible()
  await expect(page.locator('[data-test="drop-total"]')).toHaveAttribute('data-files', '1')
  await calm()
  await page.screenshot({ path: path.join(SHOTS, 'f-dr-10-desktop-dir-sheet.png') })
  await page.locator('[data-test="drop-go"]').click()
  await expect(page.locator('[data-test="folder-file"][data-file="제안 키트/README.md"]')).toBeVisible({ timeout: 20_000 })
  expect(mainFiles()).not.toContain('제안 키트/.env')
  expect(page.errors).toEqual([])
})

test('F-DR-11 앱 안에서 폴더를 놓으면 미리 보기 → 올리기 · 작업실은 까닭을 보이고 머리줄은 창의 단추를 피한다', async () => {
  await page.goto(`http://127.0.0.1:${S.webPort}/folders/${slug}`)
  await expect(page.locator('[data-test="folder-drop-hint"]')).toBeVisible()
  // a folder as Finder hands it over (webkitGetAsEntry), dropped on the files
  await page.evaluate(() => {
    const entryOf = (name, spec, parent) => {
      const fullPath = `${parent}/${name}`
      if (typeof spec === 'string') { const f = new File([spec], name); return { isFile: true, isDirectory: false, name, fullPath, file: (ok) => ok(f) } }
      const kids = Object.entries(spec).map(([n, s]) => entryOf(n, s, fullPath))
      return { isFile: false, isDirectory: true, name, fullPath, createReader() { let i = 0; return { readEntries(ok) { const b = kids.slice(i, i + 100); i += 100; setTimeout(() => ok(b)) } } },
        getDirectory: (_p, _o, _ok, no) => no(new Error('none')), getFile: (_p, _o, _ok, no) => no(new Error('none')) }
    }
    const rootEntry = entryOf('uengine-platform', { 'README.md': '# 플랫폼\n', 'docs': { 'a.md': 'a\n' }, 'node_modules': { 'x.js': '1' }, '.DS_Store': 'x' }, '')
    const dt = { types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => rootEntry, getAsFile: () => null }] }
    for (const t of ['dragenter', 'dragover', 'drop']) { const ev = new Event(t, { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: dt }); document.querySelector('[data-test="folder-detail"] .files').dispatchEvent(ev) }
  })
  await expect(page.locator('[data-test="drop-sheet"]')).toBeVisible()
  await expect(page.locator('[data-test="drop-total"]')).toHaveAttribute('data-files', '2')
  await page.locator('[data-test="drop-go"]').click()
  await expect(page.locator('[data-test="folder-toast"]')).toContainText('올렸어요 — 파일 2개')
  expect(mainFiles()).toEqual(expect.arrayContaining(['uengine-platform/README.md', 'uengine-platform/docs/a.md']))
  // 작업실: this server opens no terminal — said; the header clear of the window's own buttons; back to the folder. (In the app the
  // header's 「작업실」 asks where first — spec variation-seats: the owner opens main in the server workroom from that sheet)
  await page.getByRole('button', { name: '작업실' }).click()
  await page.locator('[data-test="seat-sheet-main"]').click()
  await expect(page.locator('[data-test="workroom-deny"]')).toContainText('여러 회사가 함께 쓰는 이 서버에서는 터미널을 열지 않아요')
  const back = await page.locator('[data-test="workroom-back"]').boundingBox()
  if (MAC) expect(back.x).toBeGreaterThanOrEqual(80)
  await calm()
  await page.screenshot({ path: path.join(SHOTS, 'f-dr-11-desktop-workroom.png') })
  await page.locator('[data-test="workroom-back"]').click()
  await page.waitForURL(new RegExp(`/folders/${slug}$`))
  expect(page.errors).toEqual([])
})

test('F-DR-10 macOS: 실제 파일 창이 앱 창 위에 뜬다', async () => {
  test.skip(!MAC, 'macOS 의 창 목록으로 본다')
  await page.goto(`http://127.0.0.1:${S.webPort}/folders/${slug}`)
  await expect(page.locator('[data-test="folder-add-menu"]')).toBeVisible()
  const pid = app.process().pid
  const before = windowsOf(pid)
  test.skip(before == null, '창 목록을 읽지 못함')
  await page.locator('[data-test="folder-add-menu"]').click()
  await page.locator('[data-test="folder-upload-dir"]').click()
  await expect.poll(() => windowsOf(pid).length, { timeout: 10_000 }).toBe(before.length + 1)
  // (the panel — 「폴더 올리기」's: a folder is picked in it — stays until the app closes in afterAll)
})
