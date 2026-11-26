// 초대받은 사람만 들어온다 (스펙 openspec/specs/team-membership). 2026-11-25 사용자: 「소셜 로그인 된다고 해서 그냥 바로 가입이 되면 안 돼
// 로그인이 되어서도 안되고」 — 운영(<회사>.process-gpt.io/lite)처럼 게이트웨이 뒤(PRO_TENANT_FROM_HEADER=1)의 회사 하나에서.
// 지어낸 사람: 정하윤(관리자) · 김서연(초대받지 않고 Process GPT 의 Google 로 들어온 사람) · 박도윤(관리자가 초대하는 사람) ·
// 최도현(아무 계정도 없는 새 주소) · 이하준(Process GPT 에 로그인해 둔 채 Lite 를 연 사람, 이 회사에서는 내보낸 사람).
//   F-IO-01 초대받지 않은 사람이 Process GPT 의 Google 로그인으로 돌아옴(/auth/done#access_token…) → 거절 화면(회사 · 주소), 세션이 남지
//           않음(이 페이지 · 인증 서버 둘 다), 누르기 전에는 요청이 없고 「가입 요청 보내기」를 누르면 「가입 요청을 보냈어요」, 새로 고쳐도 ·
//           /chat 으로 가도 밖
//   F-IO-02 Process GPT 의 세션(쿠키)을 가진 채 Lite 를 연 사람 → 거절 화면, Process GPT 의 세션은 그대로지만 Lite 는 다시 쓰지 않음(새로 고쳐도 밖)
//   F-IO-03 이메일 코드: 아무 계정도 없는 새 주소 → 거절 화면(가입 요청 아님), 계정이 생기지 않음
//   F-IO-04 관리자가 「초대」 → 그 사람이 이메일 코드로 들어옴(Process GPT 의 초대 — 가짜 completion 이 받음)
//   F-IO-05 관리자의 「가입 요청」에 김서연 → 승인 → 김서연이 Google 로 다시 오면 들어옴
//   F-IO-06 「내보내기」(나 자신에게는 없음) → 박도윤의 세션이 인증 서버에서 끝나 열어 둔 화면은 다음 요청에서 로그인 화면으로, 다시
//           로그인하면 거절 화면(요청 단추 없음)
//   F-IO-07 휴대폰 390px 밝은 · 밤: 거절 화면 · 팀·역할(초대 · 가입 요청 · 내보내기 확인)이 화면 안, 옆으로 넘치지 않음 · 영어 화면
//   F-IO-08 휴대폰 390px 밝은 · 밤: 「가입 요청 보내기」가 있는 거절 화면, 누르면 단추가 사라지고 「가입 요청을 보냈어요」
// 자기 스택(lib/localStack.js — 회사 invite-ui, BFF 9045 · Vite 5445 부터 빈 포트, 가짜 completion 9046)을 띄우고 지운다. 모델은 부르지 않는다.
//   cd e2e && npx playwright test --project=feature tests/feature/invite-only.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { startStack, REPO, SERVER } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/team-membership/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'invite-ui'
const EMAIL = { admin: `pro-rt-${TENANT}-admin@uengine.org`, walkin: `pro-rt-${TENANT}-walkin@uengine.org`, guest: `pro-rt-${TENANT}-guest@uengine.org`,
  nobody: `pro-rt-${TENANT}-nobody@uengine.org`, host: `pro-rt-${TENANT}-host@uengine.org`, asker: `pro-rt-${TENANT}-asker@uengine.org`, asker2: `pro-rt-${TENANT}-asker2@uengine.org` }
const NAME = { admin: '정하윤', walkin: '김서연', guest: '박도윤', nobody: '최도현', host: '이하준', asker: '한지우', asker2: '서하린' }
const FAKE = Number(process.env.RT_FAKE_PORT) || 9046
let S, supa, fake, AD
const calls = []

// Process GPT's POST /invite-user (services/completion/database.py invite_user), without its mail: the account and the tenant's row
function fakeCompletion() {
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const input = JSON.parse(raw || '{}').input || {}
    calls.push({ ...input, host: req.headers['x-forwarded-host'] })
    let [u] = await S.q('select id::text as id from users where email = $1 limit 1', [input.email])
    if (!u) {
      const { data, error } = await supa.auth.admin.createUser({ email: input.email, email_confirm: true })
      if (error) { res.writeHead(500); return res.end(JSON.stringify({ detail: error.message })) }
      u = { id: data.user.id }
    }
    await S.q(`insert into users (id, email, username, role, is_admin, tenant_id) values ($1,$2,$3,'user',$4,$5)`, [u.id, input.email, input.email.split('@')[0], !!input.is_admin, input.tenant_id])
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true, user_id: u.id }))
  })
  return new Promise((ok) => server.listen(FAKE, '127.0.0.1', () => ok(server)))
}
// a session of the auth server for an account — what Process GPT's Supabase hands back after its Google sign-in (no users row made)
async function supabaseSession(email) {
  const { config } = await import(path.join(SERVER, 'config.js'))
  const { data: link, error } = await supa.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) throw error
  const r = await fetch(`${config.supabaseUrl}/auth/v1/verify`, { method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.properties.hashed_token }) })
  return r.json()
}
const accountOf = async (email) => (await S.q('select id::text as id from auth.users where email=$1', [email]))[0]?.id || null
const statusOf = async (email) => (await S.q('select membership_status as s from users where tenant_id=$1 and email=$2', [TENANT, email]))[0]?.s || null
const requestOf = async (email) => (await S.q('select status from pro_join_requests where tenant_id=$1 and email=$2', [TENANT, email]))[0]?.status || null

async function ctxFor(browser, opts, { theme = 'light', session = null, lang = null } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web, extraHTTPHeaders: { 'X-Tenant-Id': TENANT } })
  await ctx.addInitScript(([s, th, lg]) => {
    if (window.top !== window) return
    if (s && !sessionStorage.getItem('io-seeded')) { localStorage.setItem('pgpt-pro-session', s); sessionStorage.setItem('io-seeded', '1') }
    localStorage.setItem('pgpt-pro-theme', th)
    if (lg) localStorage.setItem('pgl-lang', lg)
    try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ }
  }, [session ? JSON.stringify(session) : null, theme, lang])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(600); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const stored = (p) => p.evaluate(() => localStorage.getItem('pgpt-pro-session'))
const refusal = (p) => p.locator('[data-test="invite-only"]')

async function cleanup() {
  const ids = (await S.q('select id::text as id from auth.users where email = any($1)', [Object.values(EMAIL)])).map((r) => r.id)
  for (const id of ids) {
    for (const t of ['pro_threads', 'pro_profile', 'pro_actions', 'pro_mail_accounts']) await S.q(`delete from ${t} where user_id=$1`, [id]).catch(() => {})
    await S.q('delete from users where id=$1', [id]).catch(() => {})
  }
  for (const tb of ['pro_team_members', 'pro_team_removed', 'pro_role_assignments', 'pro_join_requests']) await S.q(`delete from ${tb} where tenant_id=$1`, [TENANT]).catch(() => {})
  await S.q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from tenants where id=$1', [TENANT]).catch(() => {})
  for (const id of ids) await supa.auth.admin.deleteUser(id).catch(() => {})
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 9045, webFrom: Number(process.env.RT_WEB_FROM) || 5445,
    env: { PRO_TENANT_FROM_HEADER: '1', PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: `http://127.0.0.1:${FAKE}`, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_JUDGE_URL: '' } })
  ;({ admin: supa } = await import(path.join(SERVER, 'lib/supa.js')))
  fake = await fakeCompletion()
  await cleanup()
  // the company and its administrator (as Process GPT keeps them); the people who are not members have accounts of the auth server only
  await S.q('insert into tenants (id) values ($1) on conflict do nothing', [TENANT])
  for (const who of ['admin', 'walkin', 'host', 'asker', 'asker2']) {
    const { error } = await supa.auth.admin.createUser({ email: EMAIL[who], email_confirm: true, user_metadata: { name: NAME[who] } })
    if (error) throw error
  }
  const adminId = await accountOf(EMAIL.admin)
  await S.q(`insert into users (id, username, email, tenant_id, role, is_admin, membership_status) values ($1,$2,$3,$4,'admin',true,'approved')`, [adminId, NAME.admin, EMAIL.admin, TENANT])
  await S.q(`insert into users (id, username, email, tenant_id, role, is_admin, membership_status) values ($1,$2,$3,$4,'viewer',false,'rejected')`, [await accountOf(EMAIL.host), NAME.host, EMAIL.host, TENANT])
  const s = await supabaseSession(EMAIL.admin)
  await S.api(s.access_token, '/profile', { method: 'POST', body: { name: NAME.admin, birth: '1990-01-01', onboarded: true } })
  await S.api(s.access_token, '/me')
  AD = { id: adminId, session: { session: s } }
})
test.afterAll(async () => {
  if (S) { await cleanup().catch(() => {}); await S.stop() }
  fake?.close()
})

test('F-IO-01 초대받지 않은 사람이 Process GPT 의 Google 로그인으로 오면 거절 화면 · 세션 없음 · 새로 고쳐도 밖', async ({ browser }) => {
  const s = await supabaseSession(EMAIL.walkin)
  const p = await ctxFor(browser, DESK)
  await p.goto(`/auth/done#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_at=${s.expires_at}`)
  await expect(refusal(p)).toBeVisible({ timeout: 15000 })
  await expect(p).toHaveURL(/\/invite-only$/)
  await expect(p.locator('[data-test="refusal-title"]')).toHaveText('초대받은 분만 들어올 수 있어요.')
  await expect(p.locator('[data-test="refusal-detail"]')).toHaveText('이 회사의 관리자에게 초대를 요청해 주세요.')
  await expect(p.locator('[data-test="refusal-company"]')).toHaveText(TENANT)
  await expect(p.locator('[data-test="refusal-email"]')).toHaveText(EMAIL.walkin)
  await shot(p, 'f-io-01a-refused')
  expect(await stored(p)).toBeNull()
  expect((await supa.auth.getUser(s.access_token)).error, '인증 서버에서도 끝난 세션').toBeTruthy()
  expect(await requestOf(EMAIL.walkin), '누르기 전에는 요청이 없음').toBeNull()
  await p.locator('[data-test="refusal-ask"]').click()
  await expect(p.locator('[data-test="refusal-detail"]')).toHaveText('가입 요청을 보냈어요 · 관리자가 승인하면 들어올 수 있어요')
  await expect(p.locator('[data-test="refusal-ask"]')).toHaveCount(0)
  await shot(p, 'f-io-01b-requested')
  expect(await requestOf(EMAIL.walkin)).toBe('pending')
  expect(await statusOf(EMAIL.walkin), '행은 만들지 않음').toBeNull()
  await p.reload()
  await expect(refusal(p)).toBeVisible()
  await expect(p.locator('[data-test="refusal-detail"]')).toHaveText('가입 요청을 보냈어요 · 관리자가 승인하면 들어올 수 있어요')
  expect(await stored(p)).toBeNull()
  await p.goto('/chat')
  await expect(p).toHaveURL(/\/login$/)
  // 「다른 계정으로 로그인」
  await p.goto('/invite-only')
  await p.locator('[data-test="refusal-other"]').click()
  await expect(p).toHaveURL(/\/login$/)
  expect(p.errors).toEqual([])
})

test('F-IO-02 Process GPT 에 로그인해 둔 채 Lite 를 연 내보낸 사람: 거절 화면, Process GPT 의 세션은 두고 Lite 는 다시 쓰지 않음', async ({ browser }) => {
  const s = await supabaseSession(EMAIL.host)
  const p = await ctxFor(browser, DESK)
  // ProcessGPT keeps its tokens in access_token/refresh_token cookies (on .process-gpt.io; here the stack's host)
  await p.context().addCookies(['access_token', 'refresh_token'].map((name) => ({ name, value: s[name], url: S.web })))
  await p.goto('/chat')
  await expect(refusal(p)).toBeVisible({ timeout: 15000 })
  await expect(p.locator('[data-test="refusal-detail"]')).toHaveText('이 회사의 관리자에게 초대를 요청해 주세요.')
  expect(await stored(p)).toBeNull()
  expect((await supa.auth.getUser(s.access_token)).error, 'Process GPT 의 세션은 살아 있음').toBeFalsy()
  await p.goto('/chat')
  await expect(p).toHaveURL(/\/login$/, { timeout: 15000 })
  expect(await stored(p)).toBeNull()
  expect(await statusOf(EMAIL.host)).toBe('rejected')
})

test('F-IO-03 이메일 코드: 계정이 없는 새 주소는 거절 화면, 계정이 생기지 않음', async ({ browser }) => {
  const p = await ctxFor(browser, DESK)
  await p.goto('/login')
  await p.getByPlaceholder('이메일 주소').fill(EMAIL.nobody)
  await p.getByRole('button', { name: '계속', exact: true }).click()
  await p.locator('.code input').first().fill('000000')
  await expect(refusal(p)).toBeVisible({ timeout: 15000 })
  await expect(p.locator('[data-test="refusal-detail"]')).toHaveText('이 회사의 관리자에게 초대를 요청해 주세요.')
  await expect(p.locator('[data-test="refusal-email"]')).toHaveText(EMAIL.nobody)
  await shot(p, 'f-io-03-refused-email')
  expect(await stored(p)).toBeNull()
  expect(await accountOf(EMAIL.nobody)).toBeNull()
})

test('F-IO-04 관리자가 「초대」하면 그 사람이 이메일 코드로 들어온다', async ({ browser }) => {
  const a = await ctxFor(browser, DESK, { session: AD.session })
  await a.goto('/settings/team')
  const form = a.locator('[data-test="invite-form"]')
  await expect(form).toBeVisible({ timeout: 20000 })
  await form.locator('textarea').fill(`${EMAIL.guest}, not-an-address`)
  await form.getByRole('button', { name: '초대 보내기' }).click()
  const results = a.locator('[data-test="invite-results"]')
  await expect(results.locator('li[data-result="invited"]')).toContainText(EMAIL.guest)
  await expect(results.locator('li[data-result="invited"]')).toContainText('초대했어요')
  await expect(results.locator('li[data-result="invalid"]')).toContainText('주소를 확인해 주세요')
  await expect(a.locator(`[data-test="team-members"] [data-member="${EMAIL.guest}"]`)).toBeVisible()
  await shot(a, 'f-io-04a-invited')
  expect(calls.map((c) => [c.email, c.tenant_id, c.host])).toEqual([[EMAIL.guest, TENANT, `${TENANT}.process-gpt.local`]])
  expect(await statusOf(EMAIL.guest)).toBe('approved')
  const g = await ctxFor(browser, DESK)
  await g.goto('/login')
  await g.getByPlaceholder('이메일 주소').fill(EMAIL.guest)
  await g.getByRole('button', { name: '계속', exact: true }).click()
  await g.locator('.code input').first().fill('000000')
  await expect(g).toHaveURL(/\/welcome\/age$/, { timeout: 20000 })
  expect(await stored(g)).not.toBeNull()
  expect([...a.errors, ...g.errors]).toEqual([])
})

test('F-IO-05 관리자의 「가입 요청」에 그 사람이 보이고, 승인하면 들어온다', async ({ browser }) => {
  const a = await ctxFor(browser, DESK, { session: AD.session })
  await a.goto('/settings/team')
  const req = a.locator(`[data-test="join-requests"] [data-request="${EMAIL.walkin}"]`)
  await expect(req).toBeVisible({ timeout: 20000 })
  await expect(req).toContainText(NAME.walkin)
  await shot(a, 'f-io-05a-request')
  await req.locator('[data-test="request-approve"]').click()
  await expect(req).toHaveCount(0)
  await expect(a.locator('[data-test="join-requests"]')).toContainText('기다리는 요청이 없어요.')
  await expect(a.locator(`[data-test="team-members"] [data-member="${EMAIL.walkin}"]`)).toBeVisible()
  expect(await statusOf(EMAIL.walkin)).toBe('approved')
  expect(await requestOf(EMAIL.walkin)).toBe('approved')
  const s = await supabaseSession(EMAIL.walkin)
  const p = await ctxFor(browser, DESK)
  await p.goto(`/auth/done#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_at=${s.expires_at}`)
  await expect(p).toHaveURL(/\/welcome\/age$/, { timeout: 20000 })
  expect(await stored(p)).not.toBeNull()
  expect([...a.errors, ...p.errors]).toEqual([])
})

test('F-IO-06 「내보내기」 하면 세션이 끝나 열어 둔 화면은 로그인 화면으로, 다시 로그인하면 거절 화면(요청 단추 없음) — 나 자신에게는 없음', async ({ browser }) => {
  // the guest, signed in with the page open
  const r = await S.api(null, '/auth/email/verify', { method: 'POST', body: { email: EMAIL.guest, code: '000000' } })
  await S.api(r.session.access_token, '/profile', { method: 'POST', body: { name: NAME.guest, birth: '1991-02-03', onboarded: true } })
  const g = await ctxFor(browser, DESK, { session: r })
  await g.goto('/chat')
  await expect(g.locator('[data-test="topbar-avatar"]')).toBeVisible({ timeout: 20000 })
  const a = await ctxFor(browser, DESK, { session: AD.session })
  await a.goto('/settings/team')
  const me = a.locator(`[data-test="team-members"] [data-member="${EMAIL.admin}"]`)
  await expect(me).toBeVisible({ timeout: 20000 })
  await expect(me.locator('[data-test="member-remove"]')).toHaveCount(0)
  const row = a.locator(`[data-test="team-members"] [data-member="${EMAIL.guest}"]`)
  await row.locator('[data-test="member-remove"]').click()
  const confirm = a.locator('[data-test="member-remove-confirm"]')
  await expect(confirm).toContainText('내보내면 이 회사에 들어올 수 없어요.')
  await shot(a, 'f-io-06a-remove-confirm')
  await confirm.getByRole('button', { name: '내보내기' }).click()
  await expect(row).toHaveCount(0)
  expect(await statusOf(EMAIL.guest)).toBe('rejected')
  // the guest's session ended at the auth server: the open page's next request lands on the sign-in screen
  await g.reload()
  await expect(g).toHaveURL(/\/login$/, { timeout: 20000 })
  expect(await stored(g)).toBeNull()
  // signing in again: refused, and no button to ask (let go)
  await g.getByPlaceholder('이메일 주소').fill(EMAIL.guest)
  await g.getByRole('button', { name: '계속', exact: true }).click()
  await g.locator('.code input').first().fill('000000')
  await expect(refusal(g)).toBeVisible({ timeout: 15000 })
  await expect(g.locator('[data-test="refusal-detail"]')).toHaveText('이 회사의 관리자에게 초대를 요청해 주세요.')
  await expect(g.locator('[data-test="refusal-ask"]')).toHaveCount(0)
  await shot(g, 'f-io-06b-removed')
  expect(a.errors).toEqual([])
})

test('F-IO-07 휴대폰 390px 밝은 · 밤 — 거절 화면과 팀·역할이 화면 안, 영어 화면', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const s = await supabaseSession(EMAIL.host)
    const p = await ctxFor(browser, PHONE, { theme })
    await p.goto(`/auth/done#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_at=${s.expires_at}`)
    await expect(refusal(p)).toBeVisible({ timeout: 15000 })
    await expect(p.locator('[data-test="refusal-other"]')).toBeInViewport()
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-io-07-refused-390-${theme}`)
    // the administrator's screen with a request waiting
    if (!(await statusOf(EMAIL.nobody))) {
      const n = await supa.auth.admin.createUser({ email: EMAIL.nobody, email_confirm: true, user_metadata: { name: NAME.nobody } })
      await S.q(`insert into users (id, username, email, tenant_id, role, membership_status) values ($1,$2,$3,$4,'viewer','pending')`, [n.data.user.id, NAME.nobody, EMAIL.nobody, TENANT])
    }
    const a = await ctxFor(browser, PHONE, { theme, session: AD.session })
    await a.goto('/settings/team')
    await expect(a.locator('[data-test="invite-form"]')).toBeVisible({ timeout: 20000 })
    await a.locator('[data-test="invite-form"] textarea').fill(EMAIL.walkin)
    await a.locator('[data-test="invite-form"]').getByRole('button', { name: '초대 보내기' }).click()
    await expect(a.locator('[data-test="invite-results"] li[data-result="member"]')).toContainText('이미 구성원이에요')
    await expect(a.locator(`[data-test="join-requests"] [data-request="${EMAIL.nobody}"]`)).toBeVisible()
    await a.locator(`[data-test="team-members"] [data-member="${EMAIL.walkin}"] [data-test="member-remove"]`).click()
    await expect(a.locator('[data-test="member-remove-confirm"]')).toBeVisible()
    expect(await noOverflow(a)).toBe(true)
    await a.locator('[data-test="invite-form"]').scrollIntoViewIfNeeded()
    await shot(a, `f-io-07-team-390-${theme}`)
    await a.locator('[data-test="join-requests"]').scrollIntoViewIfNeeded()
    await shot(a, `f-io-07-requests-390-${theme}`)
    expect([...p.errors, ...a.errors]).toEqual([])
  }
  // English: the server's words in the screen's language
  const s = await supabaseSession(EMAIL.host)
  const e = await ctxFor(browser, PHONE, { lang: 'en' })
  await e.goto(`/auth/done#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_at=${s.expires_at}`)
  await expect(e.locator('[data-test="refusal-title"]')).toHaveText('Only invited people can come in.', { timeout: 15000 })
  await expect(e.locator('[data-test="refusal-other"]')).toHaveText('Sign in with another account')
  await shot(e, 'f-io-07-refused-390-en')
})

test('F-IO-08 휴대폰 390px 밝은 · 밤 — 「가입 요청 보내기」를 누르면 단추가 사라지고 「가입 요청을 보냈어요」', async ({ browser }) => {
  for (const [theme, who] of [['light', 'asker'], ['dark', 'asker2']]) {
    const s = await supabaseSession(EMAIL[who])
    const p = await ctxFor(browser, PHONE, { theme })
    await p.goto(`/auth/done#access_token=${s.access_token}&refresh_token=${s.refresh_token}&expires_at=${s.expires_at}`)
    const ask = p.locator('[data-test="refusal-ask"]')
    await expect(ask).toBeVisible({ timeout: 15000 })
    await expect(ask).toBeInViewport()
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-io-08a-ask-390-${theme}`)
    await ask.click()
    await expect(p.locator('[data-test="refusal-detail"]')).toHaveText('가입 요청을 보냈어요 · 관리자가 승인하면 들어올 수 있어요')
    await expect(ask).toHaveCount(0)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-io-08b-asked-390-${theme}`)
    expect(await requestOf(EMAIL[who])).toBe('pending')
    expect(p.errors).toEqual([])
  }
})
