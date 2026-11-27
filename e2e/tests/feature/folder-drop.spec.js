// 폴더 — 컴퓨터의 폴더를 끌어다 놓아 올리기 · 「파일 올리기」 · 「폴더 올리기」 (사용자 녹화 11-27, spec openspec/specs/champion-folders
// 「컴퓨터의 폴더를 끌어다 놓아 올린다」 · 「올리기 메뉴는 시스템의 파일 창을 연다」).
//   F-FD-01 폴더의 파일 칸에 폴더를 놓으면 미리 보기(몇 개 · 크기 · 빠지는 것과 까닭 · git 원격) → 올리기: 경로 그대로 main 에 한 커밋,
//           .git · node_modules · 비밀 · 개인 설정 · git 제어 파일 · 큰 파일 · 열쇠 모양이 든 파일은 없다
//   F-FD-02 폴더 목록에 폴더를 놓으면 그 이름이 들어간 새 폴더 → 만들고 올리기 → 새 폴더에 그 안의 것이 그대로. 「새 폴더」 창에 놓으면
//           적어 둔 이름으로
//   F-FD-03 한도를 넘으면 무엇이 넘는지와 가장 큰 것 — 올리기는 막히고, 「올릴 것」에서 빼면 나머지가 올라간다
//   F-FD-04 「파일 올리기」 · 「폴더 올리기」는 시스템의 파일 창을 연다(폴더 창은 디렉터리를 고름) → 고른 폴더는 같은 미리 보기로
//   F-FD-05 휴대폰 390: 미리 보기는 아래에서 올라오는 시트, 옆으로 넘치지 않음 · 휴대폰에는 「폴더 올리기」가 없다
//   F-FD-06 어두운 테마의 미리 보기(git 원격 · 한도 넘음 · 빠지는 것)
//   F-FD-07 데스크톱 앱: 다리가 있으면 새 폴더에 두 길(「한 번 올리기」 기본 · 「내 PC 폴더로 공유(계속 맞춤)」 → 챔피언 흐름의 시스템 창),
//           다리가 없는 0.2.3 은 한 줄 안내
//   F-FD-08 서버가 다시 본다: 비밀 이름 · git 제어 파일 · 열쇠 모양 · .git 경로 · 폴더를 벗어난 경로는 파일마다 까닭과 함께 거절,
//           보기 권한은 403
//   F-FD-09 작업실: 이 서버(여러 회사 · 터미널 열쇠 없음)가 터미널을 열지 않는 까닭을 보이고, 데스크톱 앱에서는 머리줄이 창의 단추를
//           피하며, 앞 화면 없이 열었어도 폴더로 돌아간다 · 없는 폴더는 폴더의 말로
// 디렉터리 놓기는 webkitGetAsEntry 를 흉내 낸 drop 이벤트로 한다(페이지 안에서 만든 FileSystemEntry 나무 — 브라우저가 주는 모양 그대로).
// 자기 스택(lib/localStack.js: 회사 folder-drop 의 BFF + Vite, 8977 · 5377 부터 빈 곳 — RT_FD_API_PORT · RT_FD_WEB_PORT)을 띄우고 지운다.
// 터미널을 열지 않는 서버(여러 회사 · 열쇠 없음 — 운영과 같은 설정)로 띄운다. 모델은 부르지 않는다.
//   cd e2e && npx playwright test --project=feature tests/feature/folder-drop.spec.js
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/champion-folders/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const TENANT = 'folder-drop'
const NOWHERE = 'http://127.0.0.1:9'
// key-shaped text made here (the repository is public: no key-shaped literal in this file)
const FAKE_GH = `${'gh'}${'p_'}${'Kd83'.repeat(9)}`
const PEM = `-----BEGIN ${'OPENSSH PRIVATE'} KEY-----\nAAAA\n`

// the folder dropped from Finder: {name: text | {__size: bytes} | {…folder}}
const KIT = {
  'README.md': '# 견적 키트\n견적 · 제안서를 만드는 폴더\n',
  '견적': { '양식.md': '# 견적 양식\n', '단가표.csv': '품목,단가\n도면 검토,300000\n' },
  'docs': { '쓰는 법.md': '# 제안서 쓰는 법\n고객의 말로 시작한다.\n' },
  'src': { 'app.js': 'console.log(1)\n', 'deploy.js': `const token = '${FAKE_GH}'\n` },
  '.git': { 'config': '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://jung:s3cret-tok@github.com/acme/quote-kit.git\n', 'HEAD': 'ref: refs/heads/main\n' },
  'node_modules': { 'pkg': { 'index.js': 'module.exports = 1\n' } },
  '.env': 'API_KEY=1234\n',
  '.env.example': 'API_KEY=\n',
  '.claude': { 'settings.local.json': '{}\n', 'skills': { '견적-정리': { 'SKILL.md': '---\nname: 견적-정리\n---\n부가세 포함\n' } } },
  '.gitmodules': '[submodule "x"]\n',
  'deploy_key.pem': PEM,
  '녹화.mov': { __size: 60 * 1024 * 1024 },
}
const UP_KIT = ['README.md', '견적/양식.md', '견적/단가표.csv', 'docs/쓰는 법.md', 'src/app.js', '.env.example', '.claude/skills/견적-정리/SKILL.md']
const NOT_UP = ['.git/config', '.git/HEAD', 'node_modules/pkg/index.js', '.env', '.claude/settings.local.json', '.gitmodules', 'deploy_key.pem', '녹화.mov', 'src/deploy.js']

// in the page: a FileSystemEntry tree as the browser hands a dropped folder over, and the drag events a drop of it makes
const FAKE_DROP = `(() => {
  const entryOf = (name, spec, parent) => {
    const fullPath = parent + '/' + name
    if (typeof spec === 'string' || (spec && spec.__size != null)) {
      const f = new File([typeof spec === 'string' ? spec : 'x'], name)
      if (typeof spec !== 'string') Object.defineProperty(f, 'size', { value: spec.__size })
      return { isFile: true, isDirectory: false, name, fullPath, file: (ok) => setTimeout(() => ok(f)) }
    }
    const kids = Object.entries(spec).map(([n, s]) => entryOf(n, s, fullPath))
    const find = (p) => { let cur = { kids }; for (const s of p.split('/')) { cur = (cur.kids || []).find((k) => k.name === s); if (!cur) return null } return cur }
    return { isFile: false, isDirectory: true, name, fullPath, kids,
      createReader() { let i = 0; return { readEntries(ok) { const b = kids.slice(i, i + 100); i += 100; setTimeout(() => ok(b)) } } },
      getDirectory(p, _o, ok, no) { const e = find(p); e && e.isDirectory ? ok(e) : no(new DOMException('not found', 'NotFoundError')) },
      getFile(p, _o, ok, no) { const e = find(p); e && e.isFile ? ok(e) : no(new DOMException('not found', 'NotFoundError')) } }
  }
  // selector: where it is dropped · name/spec: the folder · steps: which of dragenter · dragover · drop
  window.__dropFolder = (selector, name, spec, steps = ['dragenter', 'dragover', 'drop']) => {
    const root = entryOf(name, spec, '')
    const dt = { types: ['Files'], dropEffect: 'none', effectAllowed: 'all', files: [new File([''], name)],
      items: [{ kind: 'file', type: '', webkitGetAsEntry: () => root, getAsFile: () => null }] }
    const el = document.querySelector(selector)
    for (const t of steps) { const ev = new Event(t, { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: dt }); el.dispatchEvent(ev) }
    return true
  }
})()`

let S, OWNER, VIEWER, workDir
test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true })
  // as uengine.process-gpt.io runs: a server for several companies, no terminal key (server lib/workroom.js terminalStatus)
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_FD_API_PORT || 8977), webFrom: Number(process.env.RT_FD_WEB_PORT || 5377), env: {
    PRO_DEEPAGENTS_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_EMBED_URL: '',
    PRO_TENANT_HOSTS: 'en.localhost=en-demo', PRO_TERMINAL_KEY: '' } })
  OWNER = await S.person(`pro-rt-fd-owner@uengine.org`, '정하윤')
  VIEWER = await S.person(`pro-rt-fd-viewer@uengine.org`, '김서연')
  await S.join(OWNER); await S.join(VIEWER)
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-fd-pick-'))
})
test.afterAll(async () => {
  if (!S) return
  await S.q('delete from pro_folders where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await S.stop()
  fs.rmSync(workDir, { recursive: true, force: true })
})

async function open(browser, opts, { theme = 'light', who = OWNER, init = null } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', 'ko')
  }, [JSON.stringify(who.session), theme])
  await ctx.addInitScript(FAKE_DROP)
  if (init) await ctx.addInitScript(init)
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  const go = p.goto.bind(p)
  p.goto = async (u, o) => { const r = await go(u, o); await expect(p.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 20_000 }); return r }
  return p
}
const calm = (p) => p.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 2000)),
]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(200); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noSideways = async (p) => expect(await p.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)).toBeLessThanOrEqual(1)
// drop a folder on what `selector` names, once the page shows it
const dropOn = async (p, selector, name, spec, steps) => {
  await p.locator(selector).first().waitFor()
  return p.evaluate(([sel, n, sp, st]) => window.__dropFolder(sel, n, sp, st), [selector, name, spec, steps])
}
const folder = async (name) => S.api(OWNER.token, '/folders', { method: 'POST', body: { name: `${name}-${Date.now().toString(36)}` } })
const mainFiles = async (slug) => {
  const [f] = await S.q('select repo_path from pro_folders where tenant_id=$1 and slug=$2', [TENANT, slug])
  return execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'main'], { cwd: f.repo_path }).toString().split('\0').filter(Boolean)
}
const lastCommit = async (slug) => {
  const [f] = await S.q('select repo_path from pro_folders where tenant_id=$1 and slug=$2', [TENANT, slug])
  return execFileSync('git', ['log', '-1', '--format=%an|%s', 'main'], { cwd: f.repo_path }).toString().trim()
}

test('F-FD-01 폴더 칸에 폴더를 놓으면 미리 보기 → 올리기: 경로 그대로, 빠지는 것은 없다', async ({ browser }) => {
  const f = await folder('유엔진플랫폼')
  const p = await open(browser, DESK)
  await p.goto(`/folders/${f.slug}`)
  await expect(p.locator('[data-test="folder-drop-hint"]')).toContainText('파일이나 폴더를 여기로 끌어다 놓으면')
  await dropOn(p, '[data-test="folder-detail"] .files', '견적 키트', KIT)
  const sheet = p.locator('[data-test="drop-sheet"][data-mode="into"]')
  await expect(sheet).toBeVisible()
  await expect(p.locator('[data-test="drop-total"]')).toHaveAttribute('data-files', String(UP_KIT.length))
  // the repository's remote — the address only, never the name or token in it
  await expect(p.locator('[data-test="drop-git"]')).toContainText('git 저장소예요(원격 github.com/acme/quote-kit)')
  await expect(p.locator('[data-test="drop-dest"]')).toContainText('main 에 견적 키트/ 그대로 올라가요')
  for (const g of ['git', 'secret', 'personal', 'rebuildable', 'structure', 'large', 'shape']) await expect(p.locator(`[data-test="drop-left"][data-group="${g}"]`), g).toBeVisible()
  await p.locator('[data-test="drop-left"][data-group="shape"] button').click()
  await expect(p.locator('[data-test="drop-left"][data-group="shape"]')).toContainText('견적 키트/src/deploy.js')
  await expect(p.locator('[data-test="drop-left"][data-group="shape"]')).toContainText('1째 줄 · GitHub 토큰')
  const html = await p.content()
  expect(html).not.toContain(FAKE_GH)
  expect(html).not.toContain('s3cret-tok')
  await shot(p, 'f-fd-01-drop-sheet')
  await p.locator('[data-test="drop-go"]').click()
  await expect(sheet).toHaveCount(0, { timeout: 30_000 })
  await expect(p.locator('[data-test="folder-toast"]')).toContainText(`올렸어요 — 파일 ${UP_KIT.length}개`)
  await expect(p.locator('[data-test="folder-file"][data-file="견적 키트/README.md"]')).toBeVisible({ timeout: 20_000 })
  const main = await mainFiles(f.slug)
  for (const x of UP_KIT) expect(main, x).toContain(`견적 키트/${x}`)
  for (const x of NOT_UP) expect(main, x).not.toContain(`견적 키트/${x}`)
  // one commit for the whole folder, in her name
  expect(await lastCommit(f.slug)).toBe(`정하윤|폴더 올리기: 견적 키트 · 파일 ${UP_KIT.length}개`)
  await shot(p, 'f-fd-01-uploaded')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-FD-02 폴더 목록에 놓으면 그 이름으로 새 폴더 — 그 안의 것이 그대로, 「새 폴더」 창에 놓으면 적어 둔 이름으로', async ({ browser }) => {
  const p = await open(browser, DESK)
  await p.goto('/folders')
  const name = `고객 세미나 자료 ${Date.now().toString(36)}`
  // while it is over the list: where it goes
  await dropOn(p, '[data-test="folder-list"]', name, { 'README.md': '# 세미나\n' }, ['dragenter', 'dragover'])
  await expect(p.locator('[data-test="folder-list-dropzone"]')).toContainText('같은 이름으로 새 폴더를 만들어요')
  await shot(p, 'f-fd-02-list-dropzone')
  await dropOn(p, '[data-test="folder-list"]', name, { 'README.md': '# 세미나\n', '안내문': { '1차.md': '# 1차 안내\n' }, '.DS_Store': 'x', 'node_modules': { 'a.js': '1' } }, ['drop'])
  const sheet = p.locator('[data-test="drop-sheet"][data-mode="new"]')
  await expect(sheet).toBeVisible()
  await expect(p.locator('[data-test="drop-name"]')).toHaveValue(name)
  await expect(p.locator('[data-test="drop-total"]')).toHaveAttribute('data-files', '2')
  // a browser: no desktop line
  await expect(p.locator('[data-test="drop-ways"]')).toHaveCount(0)
  await expect(p.locator('[data-test="drop-pc-old"]')).toHaveCount(0)
  await shot(p, 'f-fd-02-new-sheet')
  await p.locator('[data-test="drop-go"]').click()
  await p.waitForURL(/\/folders\/[^/?#]+$/, { timeout: 30_000 })
  const slug = decodeURIComponent(new URL(p.url()).pathname.split('/').pop())
  await expect(p.locator('[data-test="folder-file"][data-file="README.md"]')).toBeVisible({ timeout: 20_000 })
  await expect(p.locator('h1 .hn')).toHaveText(name)
  expect((await mainFiles(slug)).filter((x) => x !== '.gitattributes').sort()).toEqual(['README.md', '안내문/1차.md'])
  // 「새 폴더」 창: what is typed there names it
  await p.goto('/folders')
  await p.getByRole('button', { name: '새 폴더' }).first().click()
  await expect(p.locator('[data-test="folder-new-drop-hint"]')).toBeVisible()
  const typed = `세미나 2차 ${Date.now().toString(36)}`
  await p.locator('.box input.fld').first().fill(typed)
  await dropOn(p, '.box', '다른 이름', { 'a.md': 'a' })
  await expect(p.locator('[data-test="drop-name"]')).toHaveValue(typed)
  await p.locator('[data-test="drop-sheet"] .ic').click()
  // plain files on the list: said where they go
  await p.evaluate(() => {
    const f = new File(['x'], 'a.txt')
    const dt = { types: ['Files'], files: [f], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isFile: true, isDirectory: false, name: 'a.txt', fullPath: '/a.txt', file: (ok) => ok(f) }), getAsFile: () => f }] }
    const ev = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: dt })
    document.querySelector('[data-test="folder-list"]').dispatchEvent(ev)
  })
  await expect(p.locator('[data-test="folder-filed"]')).toContainText('폴더를 놓으면 같은 이름으로 새 폴더를 만들어요')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-FD-03 한도를 넘으면 무엇이 넘는지와 가장 큰 것 — 빼면 나머지가 올라간다', async ({ browser }) => {
  const f = await folder('큰 폴더')
  const p = await open(browser, DESK)
  await p.goto(`/folders/${f.slug}`)
  const big = { 'README.md': '# 큰 폴더\n', '자료': { 'a.md': 'a\n' }, '녹화': Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i + 1}.mp4`, { __size: 45 * 1024 * 1024 }])) }
  await dropOn(p, '[data-test="folder-detail"] .files', 'uengine-platform', big)
  await expect(p.locator('[data-test="drop-over"]')).toContainText('한 번에 올릴 수 있는 크기(200 MB)를 넘어요')
  await expect(p.locator('[data-test="drop-over"]')).toContainText('가장 큰 것: 녹화/ 225 MB · 파일 5개')
  await expect(p.locator('[data-test="drop-go"]')).toBeDisabled()
  await shot(p, 'f-fd-03-over')
  await p.locator('[data-test="drop-top"][data-top="녹화/"] input').uncheck()
  await expect(p.locator('[data-test="drop-over"]')).toHaveCount(0)
  await expect(p.locator('[data-test="drop-total"]')).toHaveAttribute('data-files', '2')
  await expect(p.locator('[data-test="drop-go"]')).toBeEnabled()
  await p.locator('[data-test="drop-go"]').click()
  await expect(p.locator('[data-test="folder-toast"]')).toContainText('올렸어요 — 파일 2개')
  expect((await mainFiles(f.slug)).filter((x) => x !== '.gitattributes').sort()).toEqual(['uengine-platform/README.md', 'uengine-platform/자료/a.md'])
  await p.context().close()
})

test('F-FD-04 「파일 올리기」 · 「폴더 올리기」는 시스템의 파일 창을 연다 — 고른 폴더는 같은 미리 보기로', async ({ browser }) => {
  const f = await folder('파일 창')
  const p = await open(browser, DESK)
  await p.goto(`/folders/${f.slug}`)
  // 파일 올리기: several files
  fs.writeFileSync(path.join(workDir, '회의록.md'), '# 회의록\n')
  await p.locator('[data-test="folder-add-menu"]').click()
  await expect(p.getByRole('menuitem')).toHaveText([/파일 올리기/, /폴더 올리기/, /참조 더하기/])
  await shot(p, 'f-fd-04-menu')
  let chooser = p.waitForEvent('filechooser')
  await p.locator('[data-test="folder-upload-files"]').click()
  let fc = await chooser
  expect(fc.isMultiple()).toBe(true)
  await fc.setFiles(path.join(workDir, '회의록.md'))
  await expect(p.locator('[data-test="folder-file"][data-file="회의록.md"]')).toBeVisible({ timeout: 20_000 })
  // 폴더 올리기: a directory of this computer
  const dir = path.join(workDir, '제안 키트')
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), '# 제안 키트\n')
  fs.writeFileSync(path.join(dir, '.env'), 'A=1\n')
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '1\n')
  await p.locator('[data-test="folder-add-menu"]').click()
  chooser = p.waitForEvent('filechooser')
  await p.locator('[data-test="folder-upload-dir"]').click()
  fc = await chooser
  expect(await fc.element().evaluate((el) => el.webkitdirectory)).toBe(true)
  await fc.setFiles(dir)
  await expect(p.locator('[data-test="drop-sheet"]')).toBeVisible()
  await expect(p.locator('[data-test="drop-total"]')).toHaveAttribute('data-files', '1')
  await expect(p.locator('[data-test="drop-left"][data-group="secret"]')).toBeVisible()
  await expect(p.locator('[data-test="drop-left"][data-group="rebuildable"]')).toBeVisible()
  await p.locator('[data-test="drop-go"]').click()
  await expect(p.locator('[data-test="folder-file"][data-file="제안 키트/README.md"]')).toBeVisible({ timeout: 20_000 })
  expect(await mainFiles(f.slug)).not.toContain('제안 키트/.env')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-FD-05 휴대폰 390: 미리 보기는 아래에서 올라오는 시트 · 옆으로 넘치지 않음 · 「폴더 올리기」는 없다', async ({ browser }) => {
  const f = await folder('휴대폰')
  const p = await open(browser, PHONE)
  await p.goto(`/folders/${f.slug}`)
  await p.locator('[data-test="folder-add-menu"]').click()
  await expect(p.locator('[data-test="folder-upload-files"]')).toBeVisible()
  await expect(p.locator('[data-test="folder-upload-dir"]')).toHaveCount(0)
  await p.locator('.mveil').click({ position: { x: 10, y: 10 } })
  await dropOn(p, '[data-test="folder-detail"] .files', '견적 키트', KIT)
  const box = p.locator('[data-test="drop-sheet"] .box')
  await expect(box).toBeVisible()
  await calm(p)
  const b = await box.boundingBox()
  expect(b.x).toBeLessThanOrEqual(1)
  expect(Math.round(b.x + b.width)).toBeGreaterThanOrEqual(389)
  expect(Math.round(b.y + b.height)).toBeGreaterThanOrEqual(843)
  await noSideways(p)
  await shot(p, 'f-fd-05-sheet-390')
  await p.context().close()
})

test('F-FD-06 어두운 테마의 미리 보기 — git 원격 · 한도 넘음 · 빠지는 것', async ({ browser }) => {
  const f = await folder('어두운')
  const p = await open(browser, DESK, { theme: 'dark' })
  await p.goto(`/folders/${f.slug}`)
  await dropOn(p, '[data-test="folder-detail"] .files', '견적 키트', { ...KIT, '녹화': Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i}.mp4`, { __size: 45 * 1024 * 1024 }])) })
  await expect(p.locator('[data-test="drop-over"]')).toBeVisible()
  await expect(p.locator('[data-test="drop-git"]')).toBeVisible()
  // light words on the dark sheet
  const fg = await p.locator('[data-test="drop-total"] b').evaluate((el) => getComputedStyle(el).color)
  const lum = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 }
  expect(lum(fg)).toBeGreaterThan(0.7)
  await shot(p, 'f-fd-06-dark')
  await p.context().close()
})

// the desktop app's preload as a page sees it: 0.2.3 (no folder bridge) · 0.2.5 (the bridge, paired for her)
const OLD_APP = `window.pglDesktop = { app: 'process-gpt-lite', version: '0.2.3' }`
const NEW_APP = (uid) => `(() => {
  const calls = window.__calls = []
  window.pglDesktop = { app: 'process-gpt-lite', version: '0.2.5',
    folders: { available: async () => true, pick: async () => { calls.push(['pick']); return { pickId: 'pick-1', label: '견적 키트', preview: { files: 7, bytes: 2048, top: [{ path: 'README.md', files: 1, bytes: 30 }], excluded: [], flagged: [], kit: [], warnings: ['own_git'] } } },
      preview: async () => ({ files: 7, bytes: 2048, top: [], excluded: [], flagged: [], kit: [], warnings: [] }), bind: async () => ({ ok: false, why: 'cancelled' }), list: async () => [], onState: () => {} },
    localRunner: { status: async () => ({ paired: true, userId: ${JSON.stringify(uid)}, deviceId: 'dev-e2e', deviceName: '정하윤의 맥', connected: true, refused: null, prefs: { enabled: true }, clis: {}, running: [] }),
      mayPair: async () => true, pair: async () => ({ ok: true }), forget: async () => ({ ok: true }), setPrefs: async () => {}, detect: async () => ({}), onState: () => () => {} } }
})()`

test('F-FD-07 데스크톱 앱: 다리가 있으면 두 길(「한 번 올리기」 기본), 다리가 없는 0.2.3 은 한 줄 안내', async ({ browser }) => {
  const old = await open(browser, DESK, { init: OLD_APP })
  await old.goto('/folders')
  await dropOn(old, '[data-test="folder-list"]', '견적 키트', { 'README.md': '# 견적\n' })
  await expect(old.locator('[data-test="drop-sheet"][data-mode="new"]')).toBeVisible()
  await expect(old.locator('[data-test="drop-pc-old"]')).toHaveText('데스크톱 앱을 새 판으로 바꾸면 내 PC 폴더를 그대로 공유할 수 있어요')
  await expect(old.locator('[data-test="drop-ways"]')).toHaveCount(0)
  await shot(old, 'f-fd-07-desktop-old')
  await old.context().close()

  const p = await open(browser, DESK, { init: NEW_APP(OWNER.id) })
  await p.goto('/folders')
  await expect(p.locator('[data-test="folder-pc-upload"]')).toBeVisible({ timeout: 20_000 })
  await dropOn(p, '[data-test="folder-list"]', '견적 키트', { 'README.md': '# 견적\n' })
  const ways = p.locator('[data-test="drop-ways"]')
  await expect(ways).toBeVisible()
  await expect(p.locator('[data-test="drop-way-once"] input')).toBeChecked()
  await expect(p.locator('[data-test="drop-go"]')).toHaveText('만들고 올리기')
  await p.locator('[data-test="drop-way-pc"]').click()
  await expect(p.locator('[data-test="drop-go"]')).toHaveText('시스템 창에서 고르기')
  await shot(p, 'f-fd-07-desktop-ways')
  await p.locator('[data-test="drop-go"]').click()
  // the champion folders' own flow: the app's system dialog, then its preview
  await expect(p.locator('[data-test="source-sheet"]')).toBeVisible()
  expect(await p.evaluate(() => window.__calls.map((c) => c[0]))).toContain('pick')
  await p.context().close()
})

test('F-FD-08 서버가 다시 본다 — 파일마다 까닭과 함께 거절, 보기 권한은 403', async () => {
  const f = await folder('서버 확인')
  await S.api(OWNER.token, `/folders/${f.slug}/members`, { method: 'POST', body: { type: 'user', id: VIEWER.id, role: 'viewer' } })
  const send = async (who, files) => {
    const fd = new FormData()
    fd.append('meta', JSON.stringify({ paths: Object.keys(files), label: '키트', part: 1, parts: 1, final: true }))
    for (const t of Object.values(files)) fd.append('file', new Blob([t]), 'file')
    const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/folders/${f.slug}/files/batch`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${who.token}` } })
    return { status: r.status, body: await r.json() }
  }
  const r = await send(OWNER, { '키트/README.md': '# 키트\n', '키트/.env': 'A=1\n', '키트/.gitmodules': '[x]\n', '키트/키.txt': `메모\n${PEM}`, '키트/.git/config': '[core]\n', '../밖.txt': 'x', '키트/토큰.js': `t='${FAKE_GH}'\n` })
  expect(r.status).toBe(200)
  expect(r.body.written).toEqual(['키트/README.md'])
  const why = Object.fromEntries(r.body.refused.map((x) => [x.path, `${x.reason}${x.line ? `:${x.line}` : ''}`]))
  expect(why).toEqual({ '키트/.env': 'name', '키트/.gitmodules': 'gitmodules', '키트/키.txt': 'private_key:2', '키트/.git/config': 'path', '../밖.txt': 'path', '키트/토큰.js': 'github_token:1' })
  expect(JSON.stringify(r.body)).not.toContain(FAKE_GH)
  expect(await mainFiles(f.slug)).toEqual(expect.arrayContaining(['키트/README.md']))
  expect(await mainFiles(f.slug)).not.toContain('키트/.env')
  // a file where a folder is: that one is said, the rest goes in
  const r2 = await send(OWNER, { '키트/README.md/x.md': 'x', '키트/b.md': 'b' })
  expect(r2.body.written).toEqual(['키트/b.md'])
  expect(r2.body.refused).toEqual([{ path: '키트/README.md/x.md', reason: 'conflict', line: null }])
  // the rules the page reads
  const rules = await S.api(OWNER.token, '/folders/upload-rules')
  expect(rules.limits).toEqual({ largeFileBytes: 52428800, pushMaxBytes: 209715200, headMaxFiles: 20000, textMaxBytes: 1048576 })
  expect(rules.groups.secret.names).toContain('.env')
  // a viewer may not
  expect((await send(VIEWER, { 'a.md': 'a' })).status).toBe(403)
})

test('F-FD-09 작업실: 이 서버가 터미널을 열지 않는 까닭을 보이고, 데스크톱 앱에서는 머리줄이 창의 단추를 피하고, 폴더로 돌아간다', async ({ browser }) => {
  const f = await folder('작업실')
  // the desktop app's page (its preload marks <html> and the room the traffic lights take)
  const desk = `new MutationObserver((_m, o) => { if (document.documentElement) { document.documentElement.classList.add('pgl-desktop', 'pgl-os-darwin'); document.documentElement.style.setProperty('--pgl-tb-left', '80px'); o.disconnect() } }).observe(document, { childList: true, subtree: true })`
  const p = await open(browser, DESK, { init: `${OLD_APP};\n${desk}` })
  // opened straight (a link, a reload): this server opens no terminal — said, the files still there
  await p.goto(`/workroom/folder/${f.slug}`)
  await expect(p.locator('[data-test="workroom-deny"]')).toContainText('여러 회사가 함께 쓰는 이 서버에서는 터미널을 열지 않아요')
  await expect(p.locator('[data-test="workroom-deny"]')).toContainText('파일은 오른쪽 「파일」에서 그대로 보고 고칠 수 있어요')
  const back = await p.locator('[data-test="workroom-back"]').boundingBox()
  expect(back.x).toBeGreaterThanOrEqual(80)
  await shot(p, 'f-fd-09-workroom')
  // no page before it: back goes to the folder
  await p.locator('[data-test="workroom-back"]').click()
  await p.waitForURL(new RegExp(`/folders/${f.slug}$`))
  // a folder that is not there: its own words, not a run's
  await p.goto('/workroom/folder/no-such-folder')
  await expect(p.locator('[data-test="workroom-error"]')).toHaveText('이 폴더(또는 변형)의 작업실을 찾지 못했어요 — 지워졌거나 아직 작업 사본이 없어요.')
  expect(p.errors).toEqual([])
  await p.context().close()
})
