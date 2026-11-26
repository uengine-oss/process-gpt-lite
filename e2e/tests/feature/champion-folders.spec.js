// 챔피언 폴더 P0 — 화면 (스펙 openspec/specs/champion-folders). 사용자(2026-11-26): 「에이전트를 잘 쓰는 그런 에이전트 챔피언들의 노하우를
// 공유하기 위한 기능을 좀 만들면 좋을 것 같아요 그래서 이 사람이 폴더를 선택을 하면 그 폴더가 Git의 우리 폴더 서버에 있는 폴더로 동기화 될 수
// 있는 기능을 만들어주고 이 사람이 가고 있는 스킬이라든지 폴더 안에 .claude … 그 각 플랫폼별 스킬이 포함된 폴더가 있다면 이런 것들이 같이
// 동반해서」.
//   F-CH-04 웹(데스크톱 앱이 아님)에서는 「내 PC 폴더 올리기」 단추 대신 「데스크톱 앱에서 내 PC 폴더를 올릴 수 있어요」만 보이고, 폴더 화면에 PC 연결 줄이 없다
//   F-CH-05 390px 「에이전트 자산」 탭 — 밝은 · 어두운 테마: 플랫폼별 묶음(Claude Code · Codex · Cursor · 스펙), 실행되는 설정 표시, 옆으로 넘치지 않음
//   F-CH-06 넓은 화면의 「에이전트 자산」 탭: 머리말의 이름 · 설명, 누르면 그 파일이 열림, 이 폴더를 올리는 PC(이름표 · 사람 · 기기 · 멈추기)
//   F-CH-07 올리기 시트(데스크톱 다리를 흉내 낸 페이지): 미리 보기 → 빼기 · 확인할 파일 → 이름 → 폴더를 만들고 bind, 이 컴퓨터에서 「아니오」면 만든
//           빈 폴더는 다시 지워지고, 「예」면 그 폴더 화면으로 가서 「이 PC 의 … 폴더와 연결됨 · 지금 올리기」가 보인다
// F-CH-01 ~ 03(실제 데스크톱 앱이 폴더를 훑고 올리는 것)은 데스크톱 시험(e2e/tests/desktop/champion*.spec.js)의 몫.
// 자기 스택(lib/localStack.js: 회사 champion-web 의 BFF + Vite, 8963 · 5363 — 둘 중 하나라도 쓰이고 있으면 멈춘다)을 띄우고 지운다. 모델은 부르지 않는다.
//   cd e2e && npx playwright test --project=feature tests/feature/champion-folders.spec.js
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/champion-folders/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const TENANT = 'champion-web'
const API_PORT = 8963
const WEB_PORT = 5363
const NOWHERE = 'http://127.0.0.1:9'
const busy = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return true } catch { return false } }

const SEED = {
  '.claude/skills/x/SKILL.md': '---\nname: 견적 규칙\ndescription: 견적서를 만들 때 지킬 것 — 할인율 · 납기 · 서명\n---\n\n# 견적 규칙\n',
  '.claude/commands/opsx/apply.md': '---\ndescription: 진행 중인 변경을 적용한다\n---\n$ARGUMENTS\n',
  '.claude/settings.json': JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }] } }, null, 2),
  'CLAUDE.md': '# 영업 제안 키트\n\n- 견적은 `견적/` 아래에\n',
  'AGENTS.md': '# Codex 에게 — 이 폴더의 규칙\n',
  '.cursor/rules/a.mdc': '---\ndescription: 문서는 한국어 해요체로\nglobs: "*.md"\n---\n',
  'openspec/specs/y/spec.md': '# 견적 스펙\n',
  '견적/양식.md': '# 견적 양식\n',
}

let S, PC, slug, folderId
test.beforeAll(async () => {
  if (busy(API_PORT) || busy(WEB_PORT)) throw new Error(`port ${API_PORT} or ${WEB_PORT} is in use — this file runs its own stack there`)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: TENANT, apiFrom: API_PORT, webFrom: WEB_PORT, env: {
    PRO_DEEPAGENTS_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_EMBED_URL: '' } })
  PC = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '박챔피언')
  await S.join(PC)
  // a champion folder whose main has a folder's agent assets (uploaded through the folder API — each one a commit, then the index and the assets)
  const f = await S.api(PC.token, '/folders', { method: 'POST', body: { name: '영업 제안 키트', description: '견적 · 제안서를 쓸 때 쓰는 스킬과 양식', champion: true } })
  slug = f.slug; folderId = f.id
  for (const [p, body] of Object.entries(SEED)) {
    const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/folders/${slug}/files?path=${encodeURIComponent(p)}`, { method: 'POST', headers: { Authorization: `Bearer ${PC.token}`, 'Content-Type': 'application/octet-stream' }, body })
    if (!r.ok) throw new Error(`upload ${p}: ${r.status} ${await r.text()}`)
  }
  // the computer that uploads it (as the desktop's sync:bind leaves it — a device of his and its source row)
  const [d] = await S.q(`insert into pro_local_devices (tenant_id, user_id, name, token_hash) values ($1,$2,'박챔피언의 맥',$3) returning id`, [TENANT, PC.id, `ui-${Date.now()}`])
  await S.q(`insert into pro_folder_sources (tenant_id, folder_id, user_id, device_id, label, branch, last_pushed_at, report) values ($1,$2,$3,$4,'영업 제안 키트',$5, now() - interval '3 minutes', $6)`,
    [TENANT, folderId, PC.id, d.id, `pgpt-agent/sync-${String(d.id).slice(0, 8)}/main`, { files: 8, bytes: 2048, excluded: { secret: 1 }, flagged: 0 }])
})
test.afterAll(async () => {
  if (!S) return
  await S.q('delete from pro_folder_sources where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await S.stop()
})

// a page signed in as him, in a theme; desktopBridge: a stand-in for the desktop app's preload (window.pglDesktop.folders)
async function open(browser, opts, { theme = 'light', bridge = null } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', 'ko')
  }, [JSON.stringify(PC.session), theme])
  if (bridge) await ctx.addInitScript(bridge)
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  // (the page starts dark and takes its theme once the sky has its place — wait for it after each goto)
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

test('F-CH-04 웹(데스크톱 앱이 아님)에서는 올리기 단추 없이 안내만, 폴더 화면에 PC 연결 줄이 없다', async ({ browser }) => {
  const p = await open(browser, DESK)
  await p.goto('/folders')
  await expect(p.locator('[data-test="folder-pc-hint"]')).toHaveText(/데스크톱 앱에서 내 PC 폴더를 올릴 수 있어요/)
  await expect(p.locator('[data-test="folder-pc-upload"]')).toHaveCount(0)
  // the folder's card: 「내 PC 에서 올림」 and its assets
  const row = p.locator(`[data-test="folder-row"][data-slug="${slug}"]`)
  await expect(row.locator('[data-test="folder-pc-badge"]')).toHaveText('내 PC 에서 올림')
  await expect(row.locator('[data-test="folder-kit-line"]')).toHaveText('스킬 1 · 명령 1 · 규칙 1 · 지침 2 · 실행 설정 1 · 스펙 1')
  await shot(p, 'f-ch-04-web-hint')
  await p.goto(`/folders/${slug}`)
  await expect(p.locator('[data-test="folder-kit-tab"]')).toBeVisible()
  await expect(p.locator('[data-test="folder-pc-sync"]')).toHaveCount(0)
  expect(p.errors).toEqual([])
  // the phone too
  const m = await open(browser, PHONE)
  await m.goto('/folders')
  await expect(m.locator('[data-test="folder-pc-hint"]')).toBeVisible()
  await noSideways(m)
  await shot(m, 'f-ch-04-web-hint-390')
  await p.context().close(); await m.context().close()
})

for (const theme of ['light', 'dark']) {
  test(`F-CH-05 390px 「에이전트 자산」 탭 — ${theme === 'light' ? '밝은' : '어두운'} 테마`, async ({ browser }) => {
    const p = await open(browser, PHONE, { theme })
    await p.goto(`/folders/${slug}`)
    await p.locator('[data-test="folder-kit-tab"]').click()
    const tab = p.locator('[data-test="kit-tab"]')
    await expect(tab).toBeVisible()
    await expect(p.locator('[data-test="kit-group"]')).toHaveCount(4)
    expect(await p.locator('[data-test="kit-group"]').evaluateAll((els) => els.map((e) => e.dataset.platform))).toEqual(['claude', 'codex', 'cursor', 'spec'])
    await expect(p.locator('[data-test="kit-item"]')).toHaveCount(7)
    await expect(p.locator('[data-test="kit-runs"]')).toContainText('.claude/settings.json')
    await expect(p.locator('[data-test="kit-item"][data-path=".claude/skills/x/SKILL.md"]')).toContainText('견적 규칙')
    await expect(p.locator('[data-test="kit-source"]')).toContainText('영업 제안 키트')
    expect(await p.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
    await noSideways(p)
    // every item's box inside the screen's width
    for (const b of await p.locator('[data-test="kit-item"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) expect(b).toBeLessThanOrEqual(391)
    await tab.evaluate((el) => { el.scrollTop = 0 })
    await shot(p, `f-ch-05-kit-390-${theme}`)
    await p.locator('[data-test="kit-group"][data-platform="claude"]').scrollIntoViewIfNeeded()
    await p.locator('[data-test="kit-item"]').nth(3).scrollIntoViewIfNeeded()
    await shot(p, `f-ch-05-kit-390-${theme}-2`)
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}

test('F-CH-06 넓은 화면의 「에이전트 자산」: 머리말의 이름 · 설명, 누르면 그 파일, 올리는 PC 와 멈추기', async ({ browser }) => {
  const p = await open(browser, DESK)
  await p.goto(`/folders/${slug}`)
  await expect(p.locator('[data-test="folder-kit-tab"]')).toContainText('에이전트 자산7')
  await p.locator('[data-test="folder-kit-tab"]').click()
  const skill = p.locator('[data-test="kit-item"][data-path=".claude/skills/x/SKILL.md"]')
  await expect(skill).toContainText('견적 규칙')
  await expect(skill).toContainText('견적서를 만들 때 지킬 것 — 할인율 · 납기 · 서명')
  await expect(p.locator('[data-test="kit-item"][data-path=".claude/commands/opsx/apply.md"]')).toContainText('opsx:apply')
  await expect(p.locator('[data-test="kit-item"][data-path=".claude/settings.json"]')).toContainText('실행되는 설정')
  await expect(p.locator('[data-test="kit-group"][data-platform="claude"]')).toContainText('이 폴더에서 일하면 Claude Code 가 저절로 읽어요')
  const src = p.locator('[data-test="kit-source"]')
  await expect(src).toContainText('박챔피언')
  await expect(src).toContainText('박챔피언의 맥')
  await expect(src).toContainText('파일 8개')
  await shot(p, 'f-ch-06-kit-desktop')
  // pause from the web, back on
  await src.getByRole('button', { name: '멈추기' }).click()
  await expect(src).toContainText('멈춤')
  expect((await S.q('select state from pro_folder_sources where folder_id=$1', [folderId]))[0].state).toBe('paused')
  await src.getByRole('button', { name: '다시 켜기' }).click()
  await expect(src).toContainText('올려 둠')
  // an item opens the file
  await skill.click()
  await expect(p.locator('.sheet.glass')).toBeVisible()
  await expect(p.locator('.sheet.glass')).toContainText('SKILL.md')
  await shot(p, 'f-ch-06-kit-open')
  expect(p.errors).toEqual([])
  await p.context().close()
})

// the desktop app's preload, as far as the page sees it: pick() hands a preview of a folder of this computer; bind() asks the person
// (here: the answer the test sets) and uploads; list() says what this computer uploads. Calls are recorded on window.__calls.
const BRIDGE = (answer) => `(() => {
  const preview = { files: 214, bytes: 3250585, top: [{ path: '.claude', files: 12, bytes: 40960 }, { path: '견적', files: 180, bytes: 3000000 }, { path: '녹화', files: 20, bytes: 200000 }, { path: 'CLAUDE.md', files: 1, bytes: 800 }],
    excluded: [{ group: 'secret', count: 2, samples: ['.env', 'deploy/id_ed25519'] }, { group: 'personal', count: 1, samples: ['.claude/settings.local.json'] }, { group: 'rebuildable', count: 1840, samples: ['node_modules/'] }],
    flagged: [{ path: '견적/메모.md', line: 12, reason: 'env_assignment', level: 'check' }],
    kit: [{ platform: 'claude', type: 'skill', path: '.claude/skills/x/SKILL.md', name: '견적 규칙' }, { platform: 'claude', type: 'instructions', path: 'CLAUDE.md', name: 'CLAUDE.md' }, { platform: 'codex', type: 'instructions', path: 'AGENTS.md', name: 'AGENTS.md' }],
    warnings: ['own_git'] }
  const calls = window.__calls = []
  let bound = null
  window.pglDesktop = { app: 'process-gpt-lite', version: 'e2e', folders: {
    available: async () => true,
    pick: async () => { calls.push(['pick']); return { pickId: 'pick-1', label: '영업 제안 키트 PC', preview } },
    preview: async (id, o) => { calls.push(['preview', id, o]); const out = JSON.parse(JSON.stringify(preview)); out.top = out.top.filter((t) => !(o.exclude || []).includes(t.path)); out.files = out.top.reduce((a, t) => a + t.files, 0); out.flagged = out.flagged.filter((f) => !(o.exclude || []).includes(f.path)); return out },
    bind: async (o) => { calls.push(['bind', o]); if (${JSON.stringify(answer)} === 'yes') { bound = { folderId: o.folderId, label: '영업 제안 키트 PC', state: 'synced', lastPushedAt: new Date().toISOString(), why: null }; return { ok: true, folderId: o.folderId, pushed: { files: 193, bytes: 3040000 } } } return { ok: false, why: 'cancelled' } },
    list: async () => (bound ? [bound] : []),
    onState: () => {},
    syncNow: async (id) => { calls.push(['syncNow', id]); return { ok: true, pushed: { files: 193 } } },
    reveal: async (id) => { calls.push(['reveal', id]) },
  } }
})()`

test('F-CH-07 올리기 시트: 미리 보기 → 빼기 · 확인할 파일 → 이름 → 이 컴퓨터가 「아니오」면 빈 폴더는 지워지고, 「예」면 그 폴더로', async ({ browser }) => {
  // the person says no in the system dialog
  const p = await open(browser, DESK, { bridge: BRIDGE('no') })
  await p.goto('/folders')
  await expect(p.locator('[data-test="folder-pc-hint"]')).toHaveCount(0)
  await p.locator('[data-test="folder-pc-upload"]').click()
  const sheet = p.locator('[data-test="source-sheet"]')
  await expect(sheet).toBeVisible()
  await expect(p.locator('[data-test="source-total"]')).toContainText('파일 214개')
  await expect(p.locator('[data-test="source-warning"]')).toContainText('git 이력은 올리지 않아요')
  await expect(p.locator('[data-test="source-flagged"]')).toContainText('견적/메모.md')
  await expect(p.locator('[data-test="source-flagged"]')).toContainText('12째 줄 · 길고 무작위인 값')
  await expect(p.locator('[data-test="source-excluded"][data-group="secret"]')).toContainText('비밀로 보여 뺐어요')
  await expect(p.locator('[data-test="source-kit"]')).toContainText('Claude Code')
  await expect(p.locator('[data-test="source-name"]')).toHaveValue('영업 제안 키트 PC')
  // leave a folder out: the app looks again without it
  await p.locator('[data-test="source-top"]', { hasText: '녹화' }).locator('input').uncheck()
  await expect(p.locator('[data-test="source-total"]')).toContainText('파일 193개')
  await p.locator('[data-test="source-excluded"][data-group="secret"] button').first().click()
  await expect(p.locator('[data-test="source-excluded"][data-group="secret"]')).toContainText('deploy/id_ed25519')
  await expect(p.locator('[data-test="source-excluded"][data-group="secret"]').getByRole('button', { name: '넣기' })).toHaveCount(0)
  await shot(p, 'f-ch-07-sheet')
  await p.locator('[data-test="source-name"]').fill('취소할 키트')
  await p.locator('[data-test="source-upload"]').click()
  await expect(p.locator('[data-test="source-note"]')).toHaveText('올리지 않았어요 — 폴더도 만들지 않았어요.')
  const calls = await p.evaluate(() => window.__calls)
  const bind = calls.find((c) => c[0] === 'bind')[1]
  expect(bind.pickId).toBe('pick-1')
  expect(bind.folderName).toBe('취소할 키트')
  expect(bind.exclude.sort()).toEqual(['견적/메모.md', '녹화'])
  expect(JSON.stringify(calls)).not.toMatch(/\/Users\/|C:\\\\/)
  expect((await S.q('select 1 from pro_folders where tenant_id=$1 and name=$2', [TENANT, '취소할 키트'])).length).toBe(0)
  expect(p.errors).toEqual([])
  await p.context().close()

  // the person says yes: the folder's screen, with this PC's line
  const y = await open(browser, DESK, { bridge: BRIDGE('yes') })
  await y.goto('/folders')
  await y.locator('[data-test="folder-pc-upload"]').click()
  await y.locator('[data-test="source-name"]').fill('올린 키트')
  await y.locator('[data-test="source-upload"]').click()
  await y.waitForURL(/\/folders\/[^/]+$/)
  const made = (await S.q('select id, slug, settings from pro_folders where tenant_id=$1 and name=$2', [TENANT, '올린 키트']))[0]
  expect(made.settings.champion).toBeTruthy()
  expect(y.url()).toContain(`/folders/${made.slug}`)
  const bar = y.locator('[data-test="folder-pc-sync"]')
  await expect(bar).toContainText('이 PC 의 「영업 제안 키트 PC」 폴더와 연결됨')
  await expect(bar).toContainText('올려 둠')
  await y.locator('[data-test="folder-pc-sync-now"]').click()
  await expect.poll(async () => (await y.evaluate(() => window.__calls)).some((c) => c[0] === 'syncNow' && c[1] === made.id)).toBe(true)
  await shot(y, 'f-ch-07-bound')
  expect(y.errors).toEqual([])
  await y.context().close()
})
