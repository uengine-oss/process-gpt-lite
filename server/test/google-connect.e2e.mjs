// Google 연결 (2026-11-22, 설치형 · PRO_TENANT_FROM_HEADER 꺼짐). 실제 서버 · 실제 DB · 실제 Chromium · Vite 화면,
// Google 자리는 가짜(fixtures/fake-google.mjs, 127.0.0.1), 판정 모델 자리는 가짜 판정 서버. 모델 호출 없음.
//   - 회사 OAuth 클라이언트: 관리자만 넣고 지우고(아니면 403), 비밀값은 다시 보여 주지 않고 DB 행에도 평문이 없다. 회사 값 → env 값
//   - 휴대폰에서 연결: 로그인한 사람에게(구글 이메일이 달라도) 토큰을 저장, 상태 쿠키 경로, 다른 브라우저·다른 상태 거부, 한 번만
//   - 서버 브라우저에서 연결: 카드 need login → 직접 제어(휴대폰 화면)로 가짜 동의 → 카드 완료 · 토큰 · 같은 브라우저에 가짜 Google 쿠키
//   - 보관함 먼저(11-22): 저장된 Google 로그인이면 에이전트(대본 모델)가 넣고 허용까지, 없으면 카드로 묻고 저장하면 이어서 — 직접 제어 없이
//   - 거절 화면(판정 refused) → 카드에 「휴대폰에서 연결」 → 그 단추로 이 기기에서 연결
//   - 시간 제한 · 바쁜 브라우저 · 허용 안 함 · 설치형 「Google로 계속하기」 로그인 회귀
//   node test/google-connect.e2e.mjs        (사진: GC_SHOTS 폴더, 기본 $TMPDIR/gc-shots)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { startFakeGoogle, SPOTS, TITLES } from './fixtures/fake-google.mjs'
import { startJudge } from './fixtures/walls.mjs'
// (this test's made-up sites run on this machine: the server's browser may open them — lib/privateNet.js)
process.env.PRO_BROWSER_PRIVATE_ALLOW ??= '127.0.0.1,localhost'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = process.env.GC_SHOTS || path.join(os.tmpdir(), 'gc-shots')
fs.mkdirSync(SHOTS, { recursive: true })
const BFF = Number(process.env.GC_BFF_PORT || 8796), WEB_PORT = Number(process.env.GC_WEB_PORT || 5197)
const web = `http://localhost:${WEB_PORT}`, api = `http://127.0.0.1:${BFF}/api`
const TENANT = 'pro-gc-e2e'
const EMAIL = { admin: 'pro-nb1121-gconnect@uengine.org', member: 'pro-nb1121-gconnect2@uengine.org', fresh: 'pro-nb1121-gconnect3@uengine.org' }
// the Google accounts people pick: not their Lite address
const GOOGLE = { admin: 'admin.google@example.com', member: 'member.other@example.com' }
const ENV_CLIENT = 'env-client.apps.googleusercontent.com', COMPANY_CLIENT = 'company-client.apps.googleusercontent.com'
const SECRET = `company-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}`); await sleep(150) } }

const fake = await startFakeGoogle({ clients: { [ENV_CLIENT]: 'env-secret', [COMPANY_CLIENT]: SECRET } })
const judge = await startJudge({
  [TITLES.consent]: { login_needed: 0.92, refused: 0.03, human_check: 0.02, ok: 0.03 },
  [TITLES.refused]: { login_needed: 0.05, refused: 0.9, human_check: 0.02, ok: 0.03 },
  [TITLES.error]: { login_needed: 0.04, refused: 0.06, human_check: 0.01, site_error: 0.86, ok: 0.03 },
})
// the model: a script per goal (the agent's moves), and an empty answer for anything else — with nothing
// scripted the connect agent gives up at once and the person takes it on
const scripts = {} // goal prefix → { i, moves }
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch { /* empty */ }
    const goal = /Goal: (.*)/.exec(body.messages?.[0]?.content || '')?.[1] || ''
    const sc = Object.entries(scripts).find(([g]) => goal.startsWith(g))?.[1]
    let message = { role: 'assistant', content: '{}' }
    if (sc) {
      const move = sc.moves[Math.min(sc.i++, sc.moves.length - 1)]
      const [name, args] = typeof move === 'function' ? move(body) : move
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
})
const CONNECT_GOAL = 'Google 계정 연결'
const lastSnap = (body) => JSON.parse([...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{')).content.split('\n')[0])
const elOf = (body, test, what) => { const el = lastSnap(body).els.find(test); if (!el) throw new Error(`no element: ${what}`); return el.i }
// fill the e-mail and password from the vault, then 허용
const SIGN_IN = [
  (b) => ['fill_secret', { i: elOf(b, (e) => e.name === 'email', 'email'), field: 'username' }],
  (b) => ['fill_secret', { i: elOf(b, (e) => e.name === 'password', 'password'), field: 'password' }],
  (b) => ['click', { i: elOf(b, (e) => e.text === '허용', '허용'), done: 2 }],
  ['finish', { summary: '연결했어요' }],
]
await new Promise((r) => llm.listen(0, '127.0.0.1', r))
const profiles = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-gc-profiles-'))
Object.assign(process.env, {
  PRO_PORT: String(BFF), PRO_PUBLIC_URL: web, PRO_BACKGROUND: '0', PRO_CONTEXT_ROUTER_URL: '', PRO_TENANT_ID: TENANT, PRO_TENANT_FROM_HEADER: '0', PRO_TENANT_HOSTS: '',
  GOOGLE_CLIENT_ID: ENV_CLIENT, GOOGLE_CLIENT_SECRET: 'env-secret', ...fake.env,
  PRO_JUDGE_URL: judge.url, PRO_JUDGE_LLM: '0', PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}`, PRO_LLM_API_KEY: 'test',
  PRO_BROWSER_PROFILES: profiles, PRO_MCP_HUB_URL: 'http://127.0.0.1:9', PRO_DEMO_LOGIN: '1',
})
process.chdir(path.resolve(here, '..'))
const { q, pool, admin: supa } = await import('../lib/supa.js')
const { getSecret } = await import('../lib/vault.js')
const { companySubject } = await import('../lib/googleClient.js')

const users = {}
let vite, pw

async function cleanup() {
  const ids = (await q('select id from users where tenant_id=$1', [TENANT]).catch(() => [])).map((r) => r.id)
  const listed = await supa.auth.admin.listUsers({ page: 1, perPage: 1000 }).catch(() => ({ data: { users: [] } }))
  for (const u of listed.data?.users || []) if (Object.values(EMAIL).includes(u.email)) ids.push(u.id)
  for (const id of new Set([...ids, companySubject(TENANT)])) {
    for (const t of ['pro_threads', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_mail_accounts', 'pro_mail_seen', 'pro_profile', 'pro_actions'])
      await q(`delete from ${t} where user_id=$1`, [id]).catch(() => {})
    // (also the row the auth.users trigger makes in another tenant)
    await q('delete from users where id=$1', [id]).catch(() => {})
  }
  await q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
  await q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await q('delete from tenants where id=$1', [TENANT]).catch(() => {})
  for (const u of listed.data?.users || []) if (Object.values(EMAIL).includes(u.email)) await supa.auth.admin.deleteUser(u.id).catch(() => {})
}

const call = (who, p, { method = 'GET', body, headers = {} } = {}) => fetch(`${api}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${users[who].session.access_token}`, ...headers }, body: body ? JSON.stringify(body) : undefined })
const cardOf = async (id) => (await q('select content from pro_messages where id=$1', [id]))[0]?.content
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, name) })
const phone = async (who) => {
  const ctx = await pw.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR', permissions: ['clipboard-read', 'clipboard-write'] })
  if (who) await ctx.addInitScript((s) => { localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(users[who]))
  return ctx
}

before(async () => {
  await cleanup()
  // a tenant of its own (nobody else's administrator, data or Google client), with no administrator yet:
  // the first one in becomes it (lib/team.js claimFirstAdmin)
  await q(`insert into tenants (id, owner, mcp) values ($1, null, '{"mcpServers":{}}') on conflict (id) do update set owner = null, is_deleted = false`, [TENANT])
  await import('../index.js')
  await until(() => fetch(`${api}/config`).then((r) => r.ok), 'BFF')
  for (const who of ['admin', 'member']) {
    const r = await fetch(`${api}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL[who], code: '000000' }) })
    users[who] = await r.json()
    await call(who, '/profile', { method: 'POST', body: { name: `시험-${who}`, birth: '1990-01-01', onboarded: true } })
  }
  vite = spawn(path.resolve(here, '../../node_modules/.bin/vite'), ['--port', String(WEB_PORT), '--strictPort'], { cwd: path.resolve(here, '../..'), env: { ...process.env, PRO_API_TARGET: `http://127.0.0.1:${BFF}` }, stdio: 'ignore' })
  await until(() => fetch(web).then((r) => r.ok), 'Vite', 60000)
  pw = await chromium.launch({ headless: true })
})

after(async () => {
  const browser = await import('../lib/browser.js')
  for (const u of Object.values(users)) await browser.close(u.user.id).catch(() => {})
  await pw?.close().catch(() => {})
  vite?.kill()
  await cleanup()
  await fake.close(); await judge.close(); llm.close()
  fs.rmSync(profiles, { recursive: true, force: true })
  await pool.end().catch(() => {})
  setTimeout(() => process.exit(process.exitCode || 0), 300)
})

test('설치형 「Google로 계속하기」 로그인은 그대로: 이 설치의 클라이언트, 신원 범위만, 콜백이 로그인시킨다', async () => {
  const ctx = await phone(null)
  const p = await ctx.newPage()
  await p.goto(`${web}/login`)
  await p.getByRole('button', { name: 'Google로 계속하기' }).click()
  await p.waitForURL(/\/o\/oauth2\/v2\/auth/)
  const asked = new URL(p.url()).searchParams
  assert.deepEqual([asked.get('client_id'), asked.get('scope'), asked.get('redirect_uri'), asked.get('code_challenge_method')], [ENV_CLIENT, 'openid email profile', `${web}/api/auth/google/callback`, 'S256'])
  await p.fill('input[name=email]', EMAIL.fresh)
  await p.getByRole('button', { name: '허용' }).click()
  await p.waitForURL((u) => /\/(welcome|chat)/.test(u.pathname), { timeout: 20000 })
  const s = await p.evaluate(() => JSON.parse(localStorage.getItem('pgpt-pro-session')))
  assert.equal(s.user.email, EMAIL.fresh)
  await ctx.close()
})

test('회사 OAuth 클라이언트: 관리자만(아니면 403), 리디렉션 URI 와 복사, 비밀값은 다시 보여 주지 않음 (휴대폰 390)', async () => {
  for (const [m, body] of [['GET'], ['PUT', { clientId: 'x', clientSecret: 'y' }], ['DELETE']]) {
    const r = await call('member', '/admin/google-client', { method: m, body })
    assert.equal(r.status, 403, `관리자 아닌 사람의 ${m}`)
  }
  const ctx = await phone('admin')
  const p = await ctx.newPage()
  await p.goto(`${web}/settings/system`)
  const box = p.getByTestId('google-client-admin')
  await box.waitFor()
  await p.getByTestId('google-client-using').getByText('설치 기본값(서버 설정)을 쓰고 있어요').waitFor()
  assert.equal(await p.getByTestId('google-redirect').innerText(), `${web}/api/auth/google/callback`)
  await p.getByTestId('google-client-id').fill(COMPANY_CLIENT)
  await p.getByTestId('google-client-secret').fill(SECRET)
  await p.getByTestId('google-client-save').click()
  await p.getByTestId('google-client-using').getByText('회사 값을 쓰고 있어요').waitFor()
  assert.equal(await p.getByTestId('google-client-secret').inputValue(), '', '저장한 비밀값은 칸에 남지 않는다')
  await p.getByTestId('google-redirect-copy').click()
  await p.getByTestId('google-redirect-copy').getByText('복사했어요').waitFor()
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), `${web}/api/auth/google/callback`)
  await box.scrollIntoViewIfNeeded()
  await shot(p, 'gc-admin-390.png')
  assert.ok(!(await p.content()).includes(SECRET), '화면에 비밀값이 없다')
  await ctx.close()
  const info = await (await call('admin', '/admin/google-client')).json()
  assert.deepEqual([info.using, info.company.clientId, info.redirectUri], ['company', COMPANY_CLIENT, `${web}/api/auth/google/callback`])
  assert.ok(!JSON.stringify(info).includes(SECRET), '응답에 비밀값이 없다')
  const rows = await q('select * from pro_vault_items where user_id=$1', [companySubject(TENANT)])
  assert.equal(rows.length, 1)
  assert.ok(!JSON.stringify(rows).includes(SECRET), 'DB 행에 평문이 없다')
  assert.equal((await (await fetch(`${api}/config`)).json()).google, true)
  // a member sees no such section
  const mctx = await phone('member')
  const mp = await mctx.newPage()
  await mp.goto(`${web}/settings/system`)
  await mp.getByText('테마').first().waitFor()
  assert.equal(await mp.getByTestId('google-client-admin').count(), 0)
  await mctx.close()
})

const stateCookieOf = (setCookie) => /pgpt-oauth-state=([^;]+)/.exec(setCookie || '')?.[1]
const viaWeb = (url, cookie) => fetch(url, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })

test('휴대폰에서 연결: 로그인한 사람에게 붙고(구글 이메일이 달라도), 다른 브라우저·다른 상태는 거부, 한 번만', async () => {
  const start = (who) => fetch(`${web}/api/auth/google/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${users[who].session.access_token}`, Origin: web }, body: JSON.stringify({ mode: 'phone', origin: web }) })
  const r = await start('member')
  assert.equal(r.status, 200)
  const setCookie = r.headers.get('set-cookie')
  assert.match(setCookie, /Path=\/api\/auth\/google(;|$)/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  const mine = stateCookieOf(setCookie)
  const { url } = await r.json()
  const asked = new URL(url).searchParams
  assert.equal(asked.get('client_id'), COMPANY_CLIENT, '회사 값이 env 값보다 먼저')
  assert.equal(asked.get('redirect_uri'), `${web}/api/auth/google/callback`)
  assert.equal(asked.get('login_hint'), EMAIL.member)
  assert.equal(asked.get('state'), mine)
  assert.ok(asked.get('scope').includes('gmail.readonly') && asked.get('access_type') === 'offline')
  // someone else started one too
  const theirs = stateCookieOf((await start('admin')).headers.get('set-cookie'))
  const back = await fake.approve(url, GOOGLE.member)
  assert.ok(back.startsWith(`${web}/api/auth/google/callback?`), back)
  // another browser (no cookie) and another person's state cookie: refused, nothing connected
  for (const cookie of [null, `pgpt-oauth-state=${theirs}`]) {
    const x = await viaWeb(back, cookie)
    assert.equal(x.status, 400)
    assert.match(await x.text(), /이 브라우저에서 시작한 연결 요청이 아니에요/)
  }
  assert.equal(await getSecret(users.member.user.id, 'oauth', 'google'), null)
  const ok = await viaWeb(back, `pgpt-oauth-state=${mine}`)
  assert.equal(ok.status, 302)
  assert.equal(ok.headers.get('location'), `${web}/settings/accounts?google=connected`)
  const sec = await getSecret(users.member.user.id, 'oauth', 'google')
  assert.deepEqual([sec.username, sec.client_id, sec.tenant, !!sec.refresh_token], [GOOGLE.member, COMPANY_CLIENT, TENANT, true])
  const ex = fake.log.token.at(-1)
  assert.deepEqual([ex.client_id, ex.redirect_uri, ex.secretOk, !!ex.code_verifier], [COMPANY_CLIENT, `${web}/api/auth/google/callback`, true, true])
  const me = await (await call('member', '/me')).json()
  assert.deepEqual([me.user.email, me.mail.provider, me.mail.address], [EMAIL.member, 'gmail', GOOGLE.member])
  // used once
  assert.equal((await viaWeb(back, `pgpt-oauth-state=${mine}`)).status, 400)
  assert.equal(await getSecret(users.admin.user.id, 'oauth', 'google'), null, '다른 사람에게는 아무것도 붙지 않았다')
})

test('서버 브라우저에서 연결: 카드가 곧바로 직접 로그인을 기다리고, 휴대폰 화면의 직접 제어로 동의하면 완료 · 같은 브라우저에 Google 쿠키', async () => {
  try { await inBrowser() } catch (e) { console.log('[fail]', e.message.split('\n').slice(0, 6).join(' | ')); throw e }
})
async function inBrowser() {
  const browser = await import('../lib/browser.js')
  browser.WAIT.watchMs = 300
  const ctx = await phone('admin')
  const p = await ctx.newPage()
  await p.goto(`${web}/settings/accounts`)
  // 메일 연결 sheet: Google in the server browser first, 휴대폰에서 연결 beside it
  await p.locator('.li').filter({ hasText: '메일 ·' }).getByRole('button', { name: '연결하기' }).click()
  // (shown once /api/config says Google is on for this company)
  await p.getByTestId('mail-google-phone').waitFor()
  assert.equal(await p.getByTestId('mail-google').isEnabled(), true)
  await sleep(600)
  await shot(p, 'gc-mail-sheet-390.png')
  await p.locator('.sheet .h').getByRole('button', { name: '닫기' }).click()
  const gcard = p.locator('.card').filter({ has: p.getByTestId('connect-google') })
  await gcard.waitFor()
  await gcard.scrollIntoViewIfNeeded()
  await p.getByTestId('connect-google-phone').waitFor()
  await sleep(700)
  await shot(p, 'gc-accounts-google-card-390.png')
  await p.getByTestId('connect-google').click()
  // the card's full view, with 직접 제어 already on
  await p.getByRole('button', { name: '제어 돌려주기' }).waitFor({ timeout: 20000 })
  const [{ id: taskId }] = await q(`select m.id from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='task' order by m.created_at desc limit 1`, [users.admin.user.id])
  const waiting = await until(async () => { const c = await cardOf(taskId); return c.state === 'needs_input' && c }, '카드가 직접 로그인을 기다림')
  assert.deepEqual([waiting.need, waiting.connect, waiting.siteName, waiting.title], ['login', 'google', 'Google', 'Google 연결'])
  assert.match(waiting.reason, /직접 로그인/)
  assert.match(waiting.reason, /NotebookLM/)
  const screen = p.locator('.handoff .screen')
  await screen.locator('img').waitFor({ timeout: 15000 })
  await sleep(500)
  await shot(p, 'gc-connect-takeover-390.png')
  // the live screen is the 1280×800 page drawn 16:10: tap where the field and the button are
  const tap = async (spot) => { const b = await screen.boundingBox(); await p.mouse.click(b.x + (spot.x / 1280) * b.width, b.y + (spot.y / 800) * b.height) }
  await tap(SPOTS.email)
  await p.getByTestId('takeover-kbd').fill(GOOGLE.admin)
  await sleep(600)
  await tap(SPOTS.allow)
  const done = await until(async () => { const c = await cardOf(taskId); return c.state === 'done' && c }, '카드 완료', 30000)
  assert.match(done.summary, new RegExp(`Google에 연결했어요\\(${GOOGLE.admin.replace('.', '\\.')}\\)`))
  assert.match(done.summary, /NotebookLM/)
  const sec = await getSecret(users.admin.user.id, 'oauth', 'google')
  assert.deepEqual([sec.username, sec.client_id, sec.tenant], [GOOGLE.admin, COMPANY_CLIENT, TENANT])
  // the same server browser is now signed in to (fake) Google, and stands on our done page
  const bctx = await browser.contextFor(users.admin.user.id)
  assert.ok((await bctx.cookies(fake.url)).some((c) => c.name === 'SID' && c.value.startsWith('fake-google-session')), '서버 브라우저에 Google 쿠키')
  assert.ok(bctx.pages().some((x) => x.url().startsWith(`${web}/api/auth/google/done`)))
  assert.equal((await bctx.cookies(web)).filter((c) => c.name === 'pgpt-oauth-state').length, 0, '상태 쿠키는 콜백이 지웠다')
  // the result is said in the chat, and the full view steps aside for it
  const said = await until(async () => (await q(`select content from pro_messages where thread_id=$1 and kind='text' and role='agent' order by created_at desc limit 1`, [waiting.threadId || (await q('select thread_id from pro_messages where id=$1', [taskId]))[0].thread_id]))[0]?.content?.text, '결과 메시지')
  assert.match(said, /Google에 연결했어요/)
  await p.locator('.handoff').waitFor({ state: 'detached', timeout: 8000 })
  await p.getByText('Google에 연결했어요(').first().waitFor()
  await sleep(600)
  await shot(p, 'gc-connect-done-390.png')
  await ctx.close()
}

test('보관함 먼저: 저장된 Google 로그인이면 에이전트가 이메일 · 비밀번호를 넣고 허용까지 — 직접 제어 없이', async () => {
  const uid = users.member.user.id
  const saved = await (await call('member', '/vault', { method: 'POST', body: { kind: 'login', site: '127.0.0.1', data: { username: GOOGLE.member, password: `pw-${Date.now()}` } } })).json()
  assert.ok(saved.id, '보관함에 저장')
  scripts[CONNECT_GOAL] = { i: 0, moves: SIGN_IN }
  const approved = fake.log.approve.length
  try {
    const r = await call('member', '/auth/google/connect', { method: 'POST', body: { mode: 'browser', origin: web } })
    assert.equal(r.status, 200)
    const { taskId } = await r.json()
    const end = await until(async () => { const c = await cardOf(taskId); return c.state === 'done' && c }, '저절로 연결', 30000)
    assert.ok(end.summary.includes(GOOGLE.member), end.summary)
    assert.deepEqual(fake.log.approve.slice(approved), [{ email: GOOGLE.member, password: 'given' }], '보관함의 이메일 · 비밀번호로 허용까지')
    const used = await q(`select action, detail from pro_vault_audit where user_id=$1 and item_id=$2 and action='fill'`, [uid, saved.id])
    assert.deepEqual(used.map((u) => u.detail.field).sort(), ['password', 'username'], '보관함에서 두 칸을 채웠다(감사 기록)')
    assert.ok(scripts[CONNECT_GOAL].i >= 3, '에이전트가 넣고 눌렀다')
    assert.equal((await getSecret(uid, 'oauth', 'google'))?.username, GOOGLE.member)
  } finally {
    delete scripts[CONNECT_GOAL]
    await call('member', `/vault/${saved.id}`, { method: 'DELETE' })
  }
})

test('보관함 먼저: 저장된 로그인이 없으면 카드로 묻고(직접 제어가 아니라), 카드에 저장하면 이어서 연결 (휴대폰 390)', async () => {
  const uid = users.member.user.id
  scripts[CONNECT_GOAL] = { i: 0, moves: SIGN_IN }
  let itemId = null
  try {
    const r = await call('member', '/auth/google/connect', { method: 'POST', body: { mode: 'browser', origin: web } })
    const { taskId, threadId } = await r.json()
    const ask = await until(async () => (await q(`select id, content from pro_messages where thread_id=$1 and kind='vault' and content->>'mode'='request' and content->>'state'='pending' order by created_at desc limit 1`, [threadId]))[0], '로그인 요청 카드')
    assert.equal(ask.content.kind, 'login')
    const waiting = await cardOf(taskId)
    assert.equal(waiting.need, 'login')
    assert.match(waiting.reason, /로그인 정보를 저장/)
    const ctx = await phone('member')
    const p = await ctx.newPage()
    await p.goto(`${web}/chat`)
    await p.locator('[data-tab="chat"]').click()
    const form = p.locator('form.vault').last()
    await form.waitFor({ timeout: 15000 })
    await form.scrollIntoViewIfNeeded()
    await sleep(300)
    await shot(p, 'gc-vault-request-390.png')
    await ctx.close()
    const saved = await (await call('member', '/vault', { method: 'POST', body: { kind: 'login', site: ask.content.site, data: { username: GOOGLE.member, password: 'pw-card' }, messageId: ask.id } })).json()
    itemId = saved.id
    const end = await until(async () => { const c = await cardOf(taskId); return c.state === 'done' && c }, '카드에 저장한 뒤 연결', 30000)
    assert.ok(end.summary.includes(GOOGLE.member))
    assert.equal((await q(`select count(*)::int n from pro_vault_audit where user_id=$1 and item_id=$2 and action='fill'`, [uid, itemId]))[0].n, 2)
  } finally {
    delete scripts[CONNECT_GOAL]
    if (itemId) await call('member', `/vault/${itemId}`, { method: 'DELETE' })
  }
})

test('Google 이 오류 화면(400)으로 답하면(판정 site_error) 거절과 같이 끝나고 「휴대폰에서 연결」', async () => {
  fake.state.error = true
  try {
    const r = await call('member', '/auth/google/connect', { method: 'POST', body: { mode: 'browser', origin: web } })
    assert.equal(r.status, 200)
    const { taskId } = await r.json()
    const end = await until(async () => { const c = await cardOf(taskId); return c.state === 'failed' && c }, '오류 화면으로 끝남', 20000)
    assert.deepEqual([end.need, end.connect], ['blocked', 'google'])
    assert.match(end.reason, /받아 주지 않았어요/)
    assert.match(end.reason, /휴대폰에서 연결/)
    assert.ok(judge.calls[TITLES.error] >= 1, '오류 화면은 판정으로 알아봤다')
  } finally { fake.state.error = false }
})

test('Google 이 서버 브라우저를 거절하면(판정 refused) 카드에 「휴대폰에서 연결」, 그 단추로 이 기기에서 연결', async () => {
  fake.state.refuse = true
  const r = await call('member', '/auth/google/connect', { method: 'POST', body: { mode: 'browser', origin: web } })
  assert.equal(r.status, 200)
  const { taskId, threadId } = await r.json()
  const end = await until(async () => { const c = await cardOf(taskId); return c.state === 'failed' && c }, '거절로 끝남', 20000)
  assert.deepEqual([end.need, end.connect], ['blocked', 'google'])
  assert.match(end.reason, /받아 주지 않았어요/)
  assert.match(end.reason, /휴대폰에서 연결/)
  assert.ok(judge.calls[TITLES.refused] >= 1, '거절 화면은 판정으로 알아봤다')
  fake.state.refuse = false
  const ctx = await phone('member')
  const p = await ctx.newPage()
  await p.goto(`${web}/chat`)
  const card = p.locator('.task').filter({ has: p.getByTestId('task-phone') }).first()
  // (휴대폰은 홈 탭이 먼저: 채팅 탭으로)
  await p.locator('[data-tab="chat"]').click()
  await card.waitFor({ timeout: 15000 })
  await card.scrollIntoViewIfNeeded()
  await sleep(400)
  await shot(p, 'gc-refused-card-390.png')
  assert.ok(threadId)
  await card.getByTestId('task-phone').click()
  await p.waitForURL(/\/o\/oauth2\/v2\/auth/)
  await p.fill('input[name=email]', GOOGLE.member)
  await p.getByRole('button', { name: '허용' }).click()
  await p.waitForURL(`${web}/settings/accounts?google=connected`)
  await p.getByTestId('google-back').getByText('Google을 연결했어요').waitFor()
  await sleep(1500)
  await shot(p, 'gc-phone-back-390.png')
  await ctx.close()
})

test('허용하지 않으면 카드가 그 이유와 다른 방법을 말한다 · 바쁜 브라우저는 409 · 15분(시험은 짧게) 안에 끝나지 않으면 끝낸다', async () => {
  const browser = await import('../lib/browser.js')
  fake.state.deny = true
  const r = await call('admin', '/auth/google/connect', { method: 'POST', body: { mode: 'browser', origin: web } })
  const { taskId } = await r.json()
  await until(async () => (await cardOf(taskId)).state === 'needs_input', '기다림')
  // the waiting card in the chat, as a phone shows it: 직접 로그인 · 휴대폰에서 연결 · 멈추기
  const ctx = await phone('admin')
  const p = await ctx.newPage()
  await p.goto(`${web}/chat`)
  await p.waitForLoadState('networkidle').catch(() => {})
  await p.locator('[data-tab="chat"]').click()
  const waitingCard = p.locator('.task').filter({ has: p.getByTestId('task-login') }).last()
  await waitingCard.waitFor({ timeout: 15000 })
  assert.equal(await waitingCard.getByTestId('task-phone').count(), 1)
  await waitingCard.scrollIntoViewIfNeeded()
  await sleep(500)
  await shot(p, 'gc-connect-card-waiting-390.png')
  await ctx.close()
  // busy: a second one is refused, with what holds the browser
  const busy = await call('admin', '/auth/google/connect', { method: 'POST', body: { mode: 'browser', origin: web } })
  assert.equal(busy.status, 409)
  assert.match((await busy.json()).error, /Google 연결/)
  await browser.input(users.admin.user.id, { type: 'click', x: SPOTS.allow.x / 1280, y: SPOTS.allow.y / 800 })
  const denied = await until(async () => { const c = await cardOf(taskId); return c.state === 'failed' && c }, '허용 안 함으로 끝남')
  assert.match(denied.reason, /허용하지 않았어요/)
  assert.match(denied.reason, /휴대폰에서 연결/)
  fake.state.deny = false
  const keep = browser.CONNECT.ms
  browser.CONNECT.ms = 1500
  try {
    const t = await (await call('admin', '/auth/google/connect', { method: 'POST', body: { mode: 'browser', origin: web } })).json()
    const late = await until(async () => { const c = await cardOf(t.taskId); return c.state === 'failed' && c }, '시간 제한', 15000)
    assert.equal(late.need, 'other')
    assert.match(late.reason, /끝나지 않아 멈췄어요/)
  } finally { browser.CONNECT.ms = keep }
})

test('영어 화면: 관리 화면 · 연결 카드 · 작업 카드의 새 문구가 영어로 (ko-en.json)', async () => {
  // (the reporter's failure details do not outlive the process.exit in after(): said here)
  try { await english() } catch (e) { console.log('[fail]', e.message.split('\n').slice(0, 6).join(' | ')); throw e }
})
async function english() {
  const hangul = /[가-힣]/
  const ctx = await phone('admin')
  const p = await ctx.newPage()
  await p.goto(`${web}/settings/system?lang=en`)
  const box = p.getByTestId('google-client-admin')
  await box.waitFor()
  await sleep(800)
  const adminText = await box.innerText()
  assert.ok(!hangul.test(adminText), adminText)
  assert.match(adminText, /Company Google connection|OAuth client/)
  assert.ok(!hangul.test(await box.locator('input').nth(1).getAttribute('placeholder')))
  await box.scrollIntoViewIfNeeded()
  await shot(p, 'gc-admin-390-en.png')
  await p.goto(`${web}/settings/accounts?lang=en`)
  // (connected by now: the card shows 연결됨 · 다시 연결 instead of 연결)
  const card = p.locator('.card').filter({ has: p.getByTestId('connect-google-phone') })
  await card.waitFor()
  await sleep(800)
  const cardText = await card.innerText()
  assert.ok(!hangul.test(cardText), cardText)
  assert.match(cardText, /Connect on phone · mail only/)
  await ctx.close()
  // a stopped 「Google 연결」 card's buttons
  const m = await phone('member')
  const mp = await m.newPage()
  await mp.goto(`${web}/chat?lang=en`)
  await mp.waitForLoadState('networkidle').catch(() => {})
  await sleep(1200)
  await mp.locator('[data-tab="chat"]').click()
  const acts = mp.getByTestId('task-phone').first()
  await acts.waitFor({ timeout: 15000 })
  await sleep(600)
  assert.equal((await acts.innerText()).trim(), 'Connect on phone')
  assert.equal((await mp.getByTestId('task-again').first().innerText()).trim(), 'Reconnect')
  await m.close()
}
