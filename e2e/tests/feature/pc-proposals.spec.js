// 「내 PC 의 ○○ 스킬을 등록해 줘」 · 「이 폴더 올려 줘」 — the confirmation cards in the chat (spec openspec/specs/local-agents 「채팅에서 내 PC 의
// 스킬 · 폴더를 등록 제안」 · champion-folders 「채팅으로 폴더 올리기 제안」; the user's words 2026-11-27: 「그냥 채팅의 대화로 로컬 에이전트를
// 선택하여 내 pc 에 있는 스킬중 어떤 스킬을 등록해줘라고 하면 서버에 스킬을 등록한다」 · 「폴더 등록 또한 채팅으로 시킬 수 있겠지」).
// Fictional person: 정하윤 — her PC (the desktop app's own runner, its tools and champion folders' engine, fake Claude Code —
// desktop/test/fixtures/fake-tui.js — which calls the app's MCP server over its real stdio) has skills in Claude Code's folder and a folder
// 「영업 키트」. She is the company's first person here, so its administrator (회사 스킬 may be chosen).
// F-PP-01 her message to 「Claude Code · 내 PC」 → the card 「스킬을 등록할까요?」: what goes up, what was left out, where (내 스킬 · 회사 스킬),
//         「등록」 → 「스킬을 등록했어요」 → 열기 → the skill's folder; Folders › 스킬 lists it as hers
// F-PP-02 a skill with run settings: the card says so; 「회사 스킬」 needs one more check before 「등록」 → installed for the company (dark theme)
// F-PP-03 a folder: 「폴더를 올릴까요?」 with the champion preview (files, left out, agent assets, name) → 「올리기」 → her PC uploads it →
//         「폴더를 올렸어요」 → 열기 → the folder with its files
// F-PP-04 390px phone: the card inside the screen, no sideways scroll, light and dark; 「그만두기」
// Its own stack (lib/localStack.js: a BFF in tenant pctools-ui on :8999, Vite on :5399), a stand-in deepagents for 회사 스킬's install. No model.
//   cd e2e && npx playwright test --project=feature tests/feature/pc-proposals.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { startStack, SHOTS as LA_SHOTS, waitFor, desktopRequire, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(LA_SHOTS, 'pc-proposals')
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const DESK = { viewport: { width: 1280, height: 900 }, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
let S, HY, pc, main, dagents, home
const uploads = []

async function page(browser, who, opts, { theme = null } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    if (th) localStorage.setItem('pgpt-pro-theme', th)
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, name, el = null) => { await p.waitForTimeout(600); await (el || p).screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const card = (p, kind, state = null) => p.locator(`[data-test=pc-proposal][data-kind=${kind}]${state ? `[data-state=${state}]` : ''}`).last()
// what she says, and the fake CLI's directives on the lines after it (the real CLI picks the tool from its description — fake-tui)
const say = (text, ...directives) => S.api(HY.token, `/threads/${main.id}/messages`, { method: 'POST', body: { text: [text, ...directives].join('\n'), agent: 'claude-code' } }).catch(() => null)
const proposals = () => S.q(`select * from pro_pc_proposals where tenant_id=$1 order by created_at`, [S.tenant])

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  dagents = http.createServer((req, res) => { req.resume(); req.on('end', () => { uploads.push(req.url); res.setHeader('content-type', 'application/json'); res.end('{}') }) })
  await new Promise((r) => dagents.listen(0, '127.0.0.1', r))
  // process-gpt's folders (where a registered skill is kept) in a temporary place; its keys from the real checkout's .env, as config.js reads them
  const pgpt = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-pctools-pgpt-'))
  fs.mkdirSync(path.join(pgpt, 'services'), { recursive: true })
  const real = [path.join(REPO, 'backends', 'process-gpt'), path.join(os.homedir(), 'process-gpt')].find((p) => fs.existsSync(path.join(p, 'services')))
  const parsed = real && fs.existsSync(path.join(real, '.env')) ? Object.fromEntries(fs.readFileSync(path.join(real, '.env'), 'utf8').split('\n').map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')])) : {}
  for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v
  S = await startStack({ tenant: 'pctools-ui', apiFrom: 8999, webFrom: 5399, env: { PGPT_ROOT: pgpt, PRO_DEEPAGENTS_URL: `http://127.0.0.1:${dagents.address().port}`, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE } })
  S.cleanupMore = () => fs.rmSync(pgpt, { recursive: true, force: true })
  HY = await S.person('pro-rt-pctools-ui-h@uengine.org', '정하윤')
  await S.join(HY)
  await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [HY.id])
  await S.q(`delete from pro_chat_agents where user_id=$1`, [HY.id])
  ;[main] = await S.api(HY.token, '/threads')
  await S.api(HY.token, '/local-agents/chat/choice', { method: 'PUT', body: { key: main.id, agent: 'claude-code' } })
  // her PC: Claude Code's skills, a folder; the desktop app's runner with its tools and champion folders' engine
  home = path.join(S.root, 'home')
  const claude = path.join(home, '.claude')
  put(path.join(claude, 'skills', '견적-규칙', 'SKILL.md'), '---\nname: 견적-규칙\ndescription: 견적서를 회사 양식으로 쓰고, 부가세는 따로 적어요\n---\n# 견적 규칙\n')
  put(path.join(claude, 'skills', '견적-규칙', 'templates', '견적서.md'), '| 품목 | 수량 | 금액 |\n')
  put(path.join(claude, 'skills', '견적-규칙', '.env'), 'QUOTE_API_KEY=abc\n')
  put(path.join(claude, 'skills', '회의록-정리', 'SKILL.md'), '---\nname: 회의록-정리\ndescription: 회의록을 안건 · 결정 · 할 일로 정리해요\nallowed-tools: Bash\nhooks:\n  Stop: []\n---\n# 회의록 정리\n')
  put(path.join(home, '영업 키트', 'README.md'), '# 영업 키트\n')
  put(path.join(home, '영업 키트', '양식', '제안서.md'), '# 제안서 양식\n')
  put(path.join(home, '영업 키트', '양식', '견적서.xlsx'), 'x'.repeat(2048))
  put(path.join(home, '영업 키트', '.env'), 'CRM_TOKEN=xyz\n')
  put(path.join(home, '영업 키트', 'node_modules', 'x', 'index.js'), 'x\n')
  put(path.join(home, '영업 키트', '.claude', 'skills', '제안서', 'SKILL.md'), '---\nname: 제안서\ndescription: 제안서를 써요\n---\n')
  put(path.join(home, '영업 키트', '.claude', 'commands', '견적.md'), '# 견적\n')
  const dev = await S.api(HY.token, '/local-agents/devices', { method: 'POST', body: { name: '정하윤의 맥', platform: 'darwin', appVersion: '0.2.8' } })
  Object.assign(process.env, S.fakeEnv)
  const { createLocalRunner } = desktopRequire('./src/runner/index.js')
  const m = new Map()
  pc = createLocalRunner({ server: `http://127.0.0.1:${S.apiPort}`, token: dev.token, dataDir: path.join(S.root, 'pc', 'data'), device: { name: '정하윤의 맥', appVersion: '0.2.8' },
    prefs: () => ({ enabled: true, ask: false }), searchPath: `${S.bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, log: () => {}, sessionEnv: { ...S.cliEnv, CLAUDE_CONFIG_DIR: claude }, settleMs: 600_000,
    folders: { get: (id) => m.get(String(id)) || null, put: (e) => m.set(String(e.folderId), e), all: () => [...m.values()], drop: (id) => m.delete(String(id)) }, userId: HY.id, toolOpts: { home } })
  await pc.start()
  await waitFor(() => pc.status().connected, 15000, 'her PC linked')
})
test.afterAll(async () => {
  try { pc?.stop() } catch { /* gone */ }
  if (S) {
    for (const t of ['pro_pc_proposals', 'pro_chat_agents', 'pro_folder_sources', 'pro_skill_visibility']) await S.q(`delete from ${t} where tenant_id=$1`, [S.tenant]).catch(() => {})
    await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [HY?.id]).catch(() => {})
    await S.stop()
    S.cleanupMore?.()
  }
  dagents?.close()
})

let desk
test('F-PP-01 「내 PC 의 견적-규칙 스킬을 등록해 줘」 → 「스킬을 등록할까요?」(올릴 것 · 뺀 것 · 어디에) → 「등록」 → 「스킬을 등록했어요」 → 열기 · 스킬 목록에 내 것으로', async ({ browser }) => {
  desk = await page(browser, HY, DESK)
  await desk.goto('/chat')
  await expect(desk.locator('[data-test=chat-agent-chip]').first()).toContainText('Claude Code', { timeout: 20000 })
  await say('내 PC 의 견적-규칙 스킬을 등록해 줘', 'MCP process_gpt_lite.lite_propose_skill :: {"path": "~/.claude/skills/견적-규칙"}')
  const c = card(desk, 'skill', 'pending')
  await expect(c).toBeVisible({ timeout: 40000 })
  await expect(c).toContainText('스킬을 등록할까요?')
  await expect(c.locator('[data-test=pc-proposal-gate]')).toHaveText('「등록」을 눌러야 등록돼요')
  await expect(c.locator('[data-test=pc-proposal-total]')).toContainText('파일 2개')
  await expect(c.locator('[data-test=pc-proposal-left]')).toContainText('비밀로 보여 뺐어요 1')
  await expect(c).toContainText('Claude Code 의 내 스킬')
  await expect(c.locator('[data-test=pc-proposal-scope][data-scope=mine] input')).toBeChecked()
  await expect(c.locator('[data-test=pc-proposal-scope][data-scope=company]')).toBeVisible()
  await expect(c.locator('[data-test=pc-proposal-runs]')).toHaveCount(0)
  await c.locator('button:has-text("파일 보기")').click()
  await expect(c.locator('[data-test=pc-proposal-files]')).toContainText('templates/견적서.md')
  await c.scrollIntoViewIfNeeded()
  await shot(desk, 'pp01-skill-card')
  await shot(desk, 'pp01-skill-card-only', c)
  expect((await proposals()).at(-1).state).toBe('pending')
  await c.locator('[data-test=pc-proposal-go]').click()
  const done = card(desk, 'skill', 'done')
  await expect(done.locator('[data-test=pc-proposal-state]')).toHaveText('스킬을 등록했어요', { timeout: 20000 })
  await expect(done).toContainText('내 스킬 — 나와 내 에이전트만 써요')
  await shot(desk, 'pp01-skill-registered')
  await done.locator('[data-test=pc-proposal-open]').click()
  await expect(desk).toHaveURL(/\/folders\/skill-/)
  await desk.goto('/folders?tab=skills')
  await expect(desk.getByText('견적-규칙').first()).toBeVisible({ timeout: 20000 })
  await shot(desk, 'pp01-skill-list')
  expect(desk.errors).toEqual([])
})

test('F-PP-02 실행 설정이 있는 스킬: 카드가 알리고, 「회사 스킬」은 한 번 더 확인해야 「등록」 → 회사에 설치(어두운 화면)', async ({ browser }) => {
  const dark = await page(browser, HY, DESK, { theme: 'dark' })
  await dark.goto('/chat')
  // (the page is up — its live events too — before her message: the card comes within a second of it)
  await expect(dark.locator('[data-test=chat-agent-chip]').first()).toContainText('Claude Code', { timeout: 20000 })
  await say('회의록-정리 스킬도 회사 스킬로 올려 줘', 'MCP process_gpt_lite.lite_propose_skill :: {"path": "~/.claude/skills/회의록-정리", "scope": "company"}')
  const c = card(dark, 'skill', 'pending')
  await expect(c).toContainText('회의록-정리', { timeout: 40000 })
  await expect(c.locator('[data-test=pc-proposal-runs]')).toContainText('allowed-tools')
  await expect(c.locator('[data-test=pc-proposal-runs]')).toContainText('hooks')
  await c.locator('[data-test=pc-proposal-scope][data-scope=company] input').check()
  await expect(c.locator('[data-test=pc-proposal-go]')).toBeDisabled()
  await c.scrollIntoViewIfNeeded()
  await shot(dark, 'pp02-company-runs-dark', c)
  await c.locator('[data-test=pc-proposal-runs-ok] input').check()
  await expect(c.locator('[data-test=pc-proposal-go]')).toBeEnabled()
  const before = uploads.length
  await c.locator('[data-test=pc-proposal-go]').click()
  const done = card(dark, 'skill', 'done')
  await expect(done).toContainText('회사 스킬 — 회사 사람들의 에이전트도 써요', { timeout: 20000 })
  expect(uploads.length).toBe(before + 1)
  await shot(dark, 'pp02-company-registered-dark')
  expect(dark.errors).toEqual([])
  await dark.context().close()
})

test('F-PP-03 「~/영업 키트 올려 줘」 → 「폴더를 올릴까요?」(파일 · 뺀 것 · 에이전트 자산 · 이름) → 「올리기」 → 그 PC 가 올림 → 「폴더를 올렸어요」 → 열기', async () => {
  await desk.goto('/chat')
  await expect(desk.locator('[data-test=chat-agent-chip]').first()).toContainText('Claude Code', { timeout: 20000 })
  await say('~/영업 키트 폴더를 공유 폴더로 올려 줘', 'MCP process_gpt_lite.lite_propose_folder :: {"path": "~/영업 키트"}')
  const c = card(desk, 'folder', 'pending')
  await expect(c).toBeVisible({ timeout: 40000 })
  await expect(c).toContainText('폴더를 올릴까요?')
  await expect(c.locator('[data-test=pc-proposal-gate]')).toHaveText('「올리기」를 눌러야 올라가요')
  await expect(c.locator('[data-test=pc-proposal-total]')).toContainText('파일 5개')
  await expect(c.locator('[data-test=pc-proposal-excluded][data-group=secret]')).toBeVisible()
  await expect(c.locator('[data-test=pc-proposal-excluded][data-group=rebuildable]')).toBeVisible()
  await expect(c.locator('[data-test=pc-proposal-kit]')).toContainText('Claude Code')
  await expect(c.locator('[data-test=pc-proposal-kit]')).toContainText('스킬 1')
  await expect(c.locator('[data-test=pc-proposal-name]')).toHaveValue('영업 키트')
  await expect(c).toContainText('정하윤의 맥')
  await c.scrollIntoViewIfNeeded()
  await shot(desk, 'pp03-folder-card')
  await shot(desk, 'pp03-folder-card-only', c)
  await c.locator('[data-test=pc-proposal-name]').fill('영업 키트 2026')
  await c.locator('[data-test=pc-proposal-go]').click()
  const done = card(desk, 'folder', 'done')
  await expect(done.locator('[data-test=pc-proposal-state]')).toHaveText('폴더를 올렸어요', { timeout: 60000 })
  await expect(done).toContainText('영업 키트 2026')
  await shot(desk, 'pp03-folder-uploaded')
  await done.locator('[data-test=pc-proposal-open]').click()
  await expect(desk).toHaveURL(/\/folders\/[^?]+/)
  await expect(desk.getByText('README.md').first()).toBeVisible({ timeout: 20000 })
  await shot(desk, 'pp03-folder-opened')
  const [f] = await S.q(`select * from pro_folders where tenant_id=$1 and name='영업 키트 2026'`, [S.tenant])
  expect(f.settings.champion).toBeTruthy()
  expect(desk.errors).toEqual([])
})

test('F-PP-04 휴대폰 390: 카드가 화면 안에, 옆으로 밀리지 않음 — 밝은 · 어두운 화면 · 「그만두기」', async ({ browser }) => {
  await say('회의록-정리 스킬을 한 번 더 보여 줘', 'MCP process_gpt_lite.lite_propose_skill :: {"path": "~/.claude/skills/회의록-정리", "name": "회의록-정리-2"}')
  await waitFor(async () => (await proposals()).some((p) => p.name === '회의록-정리-2'), 40000, 'the proposal')
  for (const theme of ['light', 'dark']) {
    const phone = await page(browser, HY, PHONE, { theme })
    await phone.goto('/chat')
    // (a phone opens on Home: the chat is its own tab)
    await phone.locator('.top .seg button[data-tab="chat"]').click()
    const c = card(phone, 'skill', 'pending')
    await expect(c).toBeVisible({ timeout: 20000 })
    await c.scrollIntoViewIfNeeded()
    expect(await noOverflow(phone)).toBe(true)
    const box = await c.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390 + 1)
    await shot(phone, `pp04-phone-${theme}`)
    if (theme === 'dark') {
      await c.locator('[data-test=pc-proposal-drop]').click()
      await expect(phone.locator('[data-test=pc-proposal][data-state=dropped]').last()).toContainText('등록하지 않기로 했어요', { timeout: 15000 })
      await shot(phone, 'pp04-phone-dropped-dark')
    }
    expect(phone.errors).toEqual([])
    await phone.context().close()
  }
})
