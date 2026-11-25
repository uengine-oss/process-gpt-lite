// 프로필 사진 (스펙 openspec/specs/profile-picture). 2026-11-25 사용자: 「내 프로필 사진 어떻게 바꾸냐? Process GPT 버전과 일관성고려하여」 —
// Lite 의 설정 화면에는 이름 첫 글자 동그라미뿐이었다. 이제 users.profile(Process GPT 의 계정 설정이 쓰는 그 칸) 하나를 두 앱이 같이 쓴다.
// 같은 날 덧붙임: 「프로필 사진은 기본적으로 social login 인 경우는 구글에 설정된 이미지가 나오는게」 — 구글로 로그인한 사람은 구글 사진이 기본.
// 지어낸 사람: 김서연(사진을 바꾸는 사람) · 박도윤(같은 회사의 팀원) · 이하준(구글로 로그인한 사람).
//   F-AV-01 기본 사진을 고르면 위 막대 · 설정 머리에 그 사진, DB 의 users.profile 은 Process GPT 와 같은 경로, 새로 고쳐도 그대로
//   F-AV-02 내 사진 올리기: 가운데 정사각형 256px(WebP), 내 폴더(pgpt-pro/<나>/avatar/)의 주소, 다시 올리면 앞의 것은 저장소에서 지움
//   F-AV-03 사진 지우기: 이름 첫 글자로 돌아가고 DB 는 열의 기본값(/images/defaultUser.png — Process GPT 의 「사진 없음」), 올린 것은 지움
//   F-AV-04 Process GPT 가 쓴 것처럼 DB 를 바로 바꾸면 Lite 가 그 사진을 보여 줌 — 나의 위 막대, 팀원의 팀 목록 · 메신저
//   F-AV-05 깨진 사진(없는 파일 · 지워진 업로드) → 이름 첫 글자, 다른 사이트 주소는 아예 부르지 않음(서버가 보여 줄 사진에서 뺌)
//   F-AV-06 서버 검사: 다른 사이트 · 남의 사진 · 다른 폴더 · 형식이 아닌 바이트 · 1MB 넘는 업로드는 거절, 남의 행은 그대로
//   F-AV-07 휴대폰 390px 밝은 · 밤: 설정 머리 · 프로필 줄 · 사진 고르기 창이 화면 안, 옆으로 넘치지 않음
//   F-AV-08 구글로 로그인한 사람: 구글 사진이 기본(users.profile 에도 채움, 리퍼러 없이 요청), 기본 사진을 고르면 그것이 이기고,
//           「Google 사진으로」는 구글 사진으로 돌아감, 구글 계정이 사진을 바꾸면 따라감, 구글 사진이 깨지면 이름 첫 글자
// 구글 사진의 호스트는 시험만의 가짜 호스트(127.0.0.1 의 빈 포트, PRO_AVATAR_HOSTS 로 허용 — 기본은 https *.googleusercontent.com)이고,
// 구글 로그인은 그 사람의 auth.identities 에 provider 'google' 행을 넣어 흉내 낸다(GoTrue 가 구글 로그인 때 쓰는 그 행).
// 자기 스택(lib/localStack.js: 회사 avatar-ui 의 BFF + Vite, 8990 · 5391 부터 빈 포트 — 5390 은 이 PC 의 이음오피스 호스트 자리)을 띄우고
// 지운다. 모델 · 공용 서비스는 부르지 않는다. 올리는 사진은 ffmpeg 로 만든 진짜 그림.
//   cd e2e && npx playwright test --project=feature tests/feature/profile-picture.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { startStack, REPO, SERVER } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/profile-picture/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'avatar-ui'
const PRESET = '/assets/images/profile/user-3.jpg'
const DIRECT = '/assets/images/profile/5.jpg'
const NO_PICTURE = '/images/defaultUser.png'

let S, SY, DY, HJ, SB, G
const files = []

// the stand-in for Google's picture host: /a/<name>.png from the pictures given to it (404 otherwise); what was asked, with its Referer
function pictureHost() {
  const pics = new Map(), asked = []
  const server = http.createServer((req, res) => {
    asked.push({ path: req.url, referer: req.headers.referer || null })
    const buf = pics.get(req.url)
    if (!buf) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    res.end(buf)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, pics, asked, base: `http://127.0.0.1:${server.address().port}` })))
}

// a real picture (ffmpeg): a test card of the given size, as PNG or JPEG
function picture(w, h, ext) {
  const out = path.join(os.tmpdir(), `rt-av-${process.pid}-${Date.now()}-${w}x${h}.${ext}`)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}`, '-frames:v', '1', out])
  files.push(out)
  return out
}

async function page(browser, who, opts, { theme = null } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    if (th) localStorage.setItem('pgpt-pro-theme', th)
    try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ }
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.asked = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  p.on('request', (r) => p.asked.push(r.url()))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const TOP = '[data-test="topbar-avatar"]'
const HEAD = '[data-test="settings-avatar"]'
const sheet = (p) => p.locator('[data-test="picture-sheet"]')
// (the top bar is hidden while Settings is open: back to the chat to see it)
const toChat = async (p) => { await p.goto('/chat'); await p.locator(TOP).waitFor() }
// a circle showing this picture, loaded
async function shows(p, sel, src) {
  const img = p.locator(`${sel} img[data-test="face"]`)
  await expect(img).toHaveAttribute('src', src, { timeout: 15000 })
  await expect.poll(() => img.evaluate((i) => (i.complete ? i.naturalWidth : 0)), { timeout: 15000 }).toBeGreaterThan(0)
  return img
}
// a circle showing the initial (no picture, or one that did not load)
async function showsInitial(p, sel, letter) {
  await expect(p.locator(`${sel} img`)).toHaveCount(0, { timeout: 15000 })
  await expect(p.locator(sel)).toHaveText(letter)
}
const stored = async (who) => (await S.q('select profile from users where id=$1 and tenant_id=$2', [who.id, TENANT]))[0]?.profile
const mineBase = (who) => `${SB}/storage/v1/object/public/files/pgpt-pro/${who.id}/avatar/`
const status = async (url) => (await fetch(url).catch(() => ({ status: 0 }))).status
const api = (who, p, init = {}) => fetch(`http://127.0.0.1:${S.apiPort}/api${p}`, { ...init, headers: { Authorization: `Bearer ${who.token}`, ...(init.headers || {}) } })
const put = (who, picture) => api(who, '/me/picture', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ picture }) })

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  G = await pictureHost()
  for (const n of [1, 2]) G.pics.set(`/a/hajun-${n}.png`, fs.readFileSync(picture(160 + n * 20, 160 + n * 20, 'png')))
  S = await startStack({ tenant: TENANT, apiFrom: 8990, webFrom: 5391, env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_AVATAR_HOSTS: G.base } })
  SY = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '김서연')
  DY = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '박도윤')
  HJ = await S.person(`pro-rt-${TENANT}-c@uengine.org`, '이하준')
  for (const p of [SY, DY]) await S.join(p)
  const { config } = await import(path.join(SERVER, 'config.js'))
  SB = config.supabaseUrl.replace(/\/+$/, '')
  await cleanData()
})

// what this file made: the people's uploaded pictures and their picture (back to the column default), the room
async function cleanData() {
  const { admin } = await import(path.join(SERVER, 'lib/supa.js'))
  if (HJ) await S.q(`delete from auth.identities where user_id=$1 and provider='google'`, [HJ.id]).catch(() => {})
  for (const p of [SY, DY, HJ].filter(Boolean)) {
    const prefix = `pgpt-pro/${p.id}/avatar`
    const { data } = await admin.storage.from('files').list(prefix, { limit: 1000 }).catch(() => ({ data: [] }))
    if (data?.length) await admin.storage.from('files').remove(data.map((o) => `${prefix}/${o.name}`)).catch(() => {})
    await S.q('update users set profile=default where id=$1 and tenant_id=$2', [p.id, TENANT]).catch(() => {})
  }
  for (const sql of ['delete from chats where tenant_id=$1', 'delete from pro_chat_reads where room_id in (select id from chat_rooms where tenant_id=$1)', 'delete from chat_rooms where tenant_id=$1']) await S.q(sql, [TENANT]).catch(() => {})
}
test.afterAll(async () => {
  if (S) { await cleanData().catch(() => {}); await S.stop() }
  for (const f of files) fs.rmSync(f, { force: true })
  G?.server.close()
})

test('F-AV-01 기본 사진을 고르면 위 막대 · 설정 머리에 그 사진 — users.profile 은 Process GPT 와 같은 경로', async ({ browser }) => {
  const p = await page(browser, SY, DESK, { theme: 'light' })
  // a new account: Process GPT's column default is "no picture" → the initial
  expect(await stored(SY)).toBe(NO_PICTURE)
  await toChat(p)
  await showsInitial(p, TOP, '김')
  await p.locator(TOP).click()
  await expect(p).toHaveURL(/\/settings$/)
  await showsInitial(p, HEAD, '김')
  await shot(p, 'f-av-01a-initial')
  await p.locator(HEAD).click()
  await expect(sheet(p)).toBeVisible()
  // the 18 presets of Process GPT's account settings, in its order, each loaded
  const presets = sheet(p).locator('[data-preset]')
  await expect(presets).toHaveCount(18)
  await expect(presets.first()).toHaveAttribute('data-preset', '/assets/images/profile/1.jpg')
  await expect(presets.last()).toHaveAttribute('data-preset', '/assets/images/profile/user-10.jpg')
  await expect.poll(() => sheet(p).locator('[data-preset] img').evaluateAll((l) => l.filter((i) => i.complete && i.naturalWidth > 0).length), { timeout: 15000 }).toBe(18)
  await expect(sheet(p).locator('[data-test="picture-remove"]')).toHaveCount(0)
  await shot(p, 'f-av-01b-sheet')
  await sheet(p).locator(`[data-preset="${PRESET}"]`).click()
  await expect(sheet(p)).toHaveCount(0)
  await shows(p, HEAD, PRESET)
  expect(await stored(SY)).toBe(PRESET)
  expect((await S.api(SY.token, '/me')).user.picture).toBe(PRESET)
  await shot(p, 'f-av-01c-preset')
  // Settings closed: the top bar has it at once (no reload)
  await p.locator('.settings > .x').click()
  await shows(p, TOP, PRESET)
  await shot(p, 'f-av-01d-topbar')
  // again later: the same picture, and the sheet marks it
  await p.reload()
  await shows(p, TOP, PRESET)
  await p.goto('/settings')
  await p.locator(HEAD).click()
  await expect(sheet(p).locator(`[data-preset="${PRESET}"]`)).toHaveAttribute('aria-pressed', 'true')
  await sheet(p).locator('[data-test="picture-close"]').click()
  // the 프로필 page says so too
  await p.goto('/settings/profile')
  await shows(p, '[data-test="profile-avatar"]', PRESET)
  await expect(p.locator('.li.pic small')).toHaveText('Process GPT에도 같은 사진이 보여요')
  expect(p.errors).toEqual([])
  await p.context().close()
})

let firstUpload
test('F-AV-02 내 사진 올리기 — 가운데 정사각형 256px, 내 폴더의 주소, 다시 올리면 앞의 것은 지움', async ({ browser }) => {
  const p = await page(browser, SY, DESK, { theme: 'light' })
  await p.goto('/settings/profile')
  await p.locator('[data-test="profile-picture-change"]').click()
  await expect(sheet(p)).toBeVisible()
  await sheet(p).locator('[data-test="picture-file"]').setInputFiles(picture(640, 400, 'png'))
  await expect(sheet(p)).toHaveCount(0, { timeout: 20000 })
  const url = await stored(SY)
  expect(url.startsWith(mineBase(SY))).toBe(true)
  expect(url.slice(mineBase(SY).length)).toMatch(/^[0-9a-f-]{36}\.(webp|jpg)$/)
  const img = await shows(p, '[data-test="profile-avatar"]', url)
  expect(await img.evaluate((i) => [i.naturalWidth, i.naturalHeight])).toEqual([256, 256])
  const r = await fetch(url)
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toBe('image/webp')
  firstUpload = url
  await toChat(p)
  await shows(p, TOP, url)
  await p.goto('/settings')
  await shows(p, HEAD, url)
  await shot(p, 'f-av-02a-uploaded')
  // another photo (portrait JPEG): the new one shows, the one it replaced leaves storage
  await p.locator(HEAD).click()
  await expect(sheet(p).locator('[data-test="picture-remove"]')).toBeVisible()
  await sheet(p).locator('[data-test="picture-file"]').setInputFiles(picture(300, 500, 'jpg'))
  await expect(sheet(p)).toHaveCount(0, { timeout: 20000 })
  const second = await stored(SY)
  expect(second).not.toBe(firstUpload)
  expect(second.startsWith(mineBase(SY))).toBe(true)
  const img2 = await shows(p, HEAD, second)
  expect(await img2.evaluate((i) => [i.naturalWidth, i.naturalHeight])).toEqual([256, 256])
  await expect.poll(() => status(firstUpload), { timeout: 15000 }).not.toBe(200)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-AV-03 사진 지우기 — 이름 첫 글자로, DB 는 열의 기본값, 올린 사진은 저장소에서 지움', async ({ browser }) => {
  const p = await page(browser, SY, DESK, { theme: 'light' })
  const before = await stored(SY)
  expect(before.startsWith(mineBase(SY))).toBe(true)
  await toChat(p)
  await shows(p, TOP, before)
  await p.goto('/settings')
  await shows(p, HEAD, before)
  await p.locator(HEAD).click()
  await sheet(p).locator('[data-test="picture-remove"]').click()
  await expect(sheet(p)).toHaveCount(0)
  await showsInitial(p, HEAD, '김')
  expect(await stored(SY)).toBe(NO_PICTURE)
  expect((await S.api(SY.token, '/me')).user.picture).toBe(null)
  await expect.poll(() => status(before), { timeout: 15000 }).not.toBe(200)
  await shot(p, 'f-av-03-removed')
  await toChat(p)
  await showsInitial(p, TOP, '김')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-AV-04 Process GPT 가 DB 에 쓴 사진을 Lite 가 보여 준다 — 나의 위 막대, 팀원의 팀 목록 · 메신저', async ({ browser }) => {
  // what Process GPT's account settings write (backend.updateUserInfo → users.profile)
  await S.q('update users set profile=$1 where id=$2 and tenant_id=$3', [DIRECT, SY.id, TENANT])
  const p = await page(browser, SY, DESK, { theme: 'light' })
  await toChat(p)
  await shows(p, TOP, DIRECT)
  await p.context().close()
  // 박도윤 sees 김서연's picture where 김서연 appears
  await S.api(DY.token, '/team/threads', { method: 'POST', body: { members: [SY.id] } })
  const d = await page(browser, DY, DESK, { theme: 'light' })
  await d.goto('/settings/team')
  const row = d.locator('.tr .li').filter({ hasText: '김서연' })
  await shows(d, `.tr .li:has-text("김서연") .av`, DIRECT)
  await expect(d.locator('.tr .li').filter({ hasText: '박도윤' }).locator('img')).toHaveCount(0)
  await expect(row.locator('.av')).toBeVisible()
  await shot(d, 'f-av-04a-team-list')
  await d.goto('/chat')
  await d.locator('button.msg-btn').click()
  await d.locator('.ms').waitFor()
  await d.locator('.ms .tabs button').filter({ hasText: '대화' }).click()
  const th = d.locator('.ms .th').filter({ hasText: '김서연' }).first()
  await shows(d, `.ms .th:has-text("김서연") .av`, DIRECT)
  await expect(th).toBeVisible()
  await shot(d, 'f-av-04b-messenger')
  expect(d.errors).toEqual([])
  await d.context().close()
})

test('F-AV-05 깨진 사진은 이름 첫 글자 — 다른 사이트 주소는 부르지도 않는다', async ({ browser }) => {
  const p = await page(browser, SY, DESK, { theme: 'dark' })
  // a file that is not there (Process GPT's path form) and an upload that was deleted: tried, then the initial
  for (const v of ['/assets/images/profile/gone.jpg', `${mineBase(SY)}00000000-0000-4000-8000-000000000000.webp`]) {
    await S.q('update users set profile=$1 where id=$2 and tenant_id=$3', [v, SY.id, TENANT])
    expect((await S.api(SY.token, '/me')).user.picture).toBe(v)
    await toChat(p)
    await showsInitial(p, TOP, '김')
    await p.goto('/settings')
    await showsInitial(p, HEAD, '김')
    expect(p.asked.some((u) => u.startsWith(v) || u.endsWith(v))).toBe(true)
  }
  await shot(p, 'f-av-05a-broken-dark')
  // another site's address (written by something else): the server does not hand it to the screens — no request goes there
  await S.q('update users set profile=$1 where id=$2 and tenant_id=$3', ['https://tracker.example.com/pixel.gif?u=1', SY.id, TENANT])
  p.asked.length = 0
  await p.goto('/settings')
  await showsInitial(p, HEAD, '김')
  await toChat(p)
  await showsInitial(p, TOP, '김')
  expect((await S.api(SY.token, '/me')).user.picture).toBe(null)
  expect(p.asked.filter((u) => u.includes('tracker.example.com'))).toEqual([])
  expect(p.errors).toEqual([])
  await S.q('update users set profile=default where id=$1 and tenant_id=$2', [SY.id, TENANT])
  await p.context().close()
})

test('F-AV-06 서버 검사 — 기본 사진 · 내 폴더의 사진 · 빈 값만, 내 행만', async () => {
  const before = await stored(DY)
  const bad = [
    'https://tracker.example.com/pixel.gif', `//tracker.example.com/a.jpg`, 'data:image/png;base64,iVBORw0KGgo=', 'javascript:alert(1)',
    `${mineBase(DY)}a.webp`,                                                    // 박도윤's folder, asked by 김서연
    `${SB}/storage/v1/object/public/files/pgpt-pro/${SY.id}/att/a.webp`,        // my files, not my pictures
    `${SB}/storage/v1/object/public/chat-images/pgpt-pro/${SY.id}/avatar/a.webp`,
    `${mineBase(SY)}a.webp?x=1`, `${mineBase(SY)}../a.webp`, '/assets/images/profile/99.jpg', NO_PICTURE,
  ]
  for (const v of bad) {
    const r = await put(SY, v)
    expect(r.status, v).toBe(400)
    expect((await r.json()).error).toBeTruthy()
  }
  for (const v of [42, { url: 'x' }]) expect((await put(SY, v)).status).toBe(400)
  // what may be saved
  for (const [v, want] of [[PRESET, PRESET], [`${mineBase(SY)}a.webp`, `${mineBase(SY)}a.webp`], ['', null], [null, null]]) {
    const r = await put(SY, v)
    expect(r.status, String(v)).toBe(200)
    expect((await r.json()).picture).toBe(want)
  }
  expect(await stored(SY)).toBe(NO_PICTURE)
  // uploads: only picture bytes (by their first bytes), at most 1 MB
  const up = (body, type) => api(SY, '/me/picture/upload', { method: 'POST', headers: { 'Content-Type': type }, body })
  expect((await up(Buffer.from('<!doctype html><script>alert(1)</script>'), 'image/png')).status).toBe(400)
  expect((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).status).toBe(400)
  expect((await up(JSON.stringify({ picture: PRESET }), 'application/json')).status).toBe(400)
  expect((await up(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1100 * 1024)]), 'image/jpeg')).status).toBe(413)
  // no sign-in: 401; and 박도윤's row was never touched
  expect((await fetch(`http://127.0.0.1:${S.apiPort}/api/me/picture`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ picture: PRESET }) })).status).toBe(401)
  expect(await stored(DY)).toBe(before)
  // only the people who have a picture, never an agent's
  await put(SY, PRESET)
  const all = await (await api(DY, '/people/pictures')).json()
  expect(all[SY.id]).toBe(PRESET)
  expect(DY.id in all).toBe(false)
  await put(SY, null)
})

test('F-AV-07 휴대폰 390px 밝은 · 밤 — 설정 머리 · 프로필 줄 · 사진 고르기 창이 화면 안', async ({ browser }) => {
  await put(SY, PRESET)
  for (const theme of ['light', 'dark']) {
    const p = await page(browser, SY, PHONE, { theme })
    await toChat(p)
    await shows(p, TOP, PRESET)
    await shot(p, `f-av-07${theme === 'light' ? 'a' : 'b'}-chat-${theme}`)
    await p.goto('/settings')
    await shows(p, HEAD, PRESET)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-av-07${theme === 'light' ? 'c' : 'd'}-settings-${theme}`)
    await p.locator(HEAD).click()
    const box = await sheet(p).boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    for (const b of await sheet(p).locator('button').all()) {
      const bb = await b.boundingBox()
      expect(bb.x + bb.width).toBeLessThanOrEqual(390.5)
    }
    await expect(sheet(p).locator(`[data-preset="${PRESET}"]`)).toHaveAttribute('aria-pressed', 'true')
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-av-07${theme === 'light' ? 'e' : 'f'}-sheet-${theme}`)
    await sheet(p).locator('[data-test="picture-close"]').click()
    await p.goto('/settings/profile')
    await shows(p, '[data-test="profile-avatar"]', PRESET)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-av-07${theme === 'light' ? 'g' : 'h'}-profile-${theme}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
  await put(SY, null)
})

// 이하준 signed in with Google: the row GoTrue writes for a Google sign-in (ProcessGPT's Supabase Google provider), its picture on the stand-in host
async function googlePicture(name) {
  const pic = `${G.base}/a/${name}`
  const sub = HJ.googleSub ||= String(crypto.randomInt(1e9, 9e9)) + String(crypto.randomInt(1e9, 9e9))
  const data = { sub, iss: 'https://accounts.google.com', email: HJ.email, email_verified: true, name: '이하준', full_name: '이하준', picture: pic, avatar_url: pic, provider_id: sub }
  const [had] = await S.q(`select 1 from auth.identities where user_id=$1 and provider='google'`, [HJ.id])
  if (had) await S.q(`update auth.identities set identity_data=$2 where user_id=$1 and provider='google'`, [HJ.id, data])
  else await S.q(`insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at) values ($1,$2,$3,'google',now(),now(),now())`, [sub, HJ.id, data])
  return pic
}

test('F-AV-08 구글로 로그인한 사람은 구글 사진이 기본 — 고른 사진이 이기고, 「Google 사진으로」는 구글 사진으로', async ({ browser }) => {
  const g1 = await googlePicture('hajun-1.png')
  expect(await stored(HJ)).toBe(NO_PICTURE)
  // first visit: the Google picture shows, and fills users.profile so Process GPT shows it too
  const me = (await S.api(HJ.token, '/me')).user
  expect(me.picture).toBe(g1)
  expect(me.pictureDefault).toBe(g1)
  expect(await stored(HJ)).toBe(g1)
  const p = await page(browser, HJ, DESK, { theme: 'light' })
  await toChat(p)
  const img = await shows(p, TOP, g1)
  expect(await img.getAttribute('referrerpolicy')).toBe('no-referrer')
  // (asked without a Referer: Google serves its pictures only so)
  const asks = G.asked.filter((a) => a.path === '/a/hajun-1.png')
  expect(asks.length).toBeGreaterThan(0)
  expect(asks.every((a) => a.referer === null)).toBe(true)
  await p.goto('/settings/profile')
  await shows(p, '[data-test="profile-avatar"]', g1)
  await expect(p.locator('.li.pic small')).toHaveText('Google 계정의 사진이에요')
  await shot(p, 'f-av-08a-google-default')
  // the sheet: nothing to clear while the Google picture is the one shown
  await p.locator('[data-test="profile-picture-change"]').click()
  await expect(sheet(p)).toBeVisible()
  await expect(sheet(p).locator('[data-test="picture-remove"]')).toHaveCount(0)
  // a choice wins over the Google picture, and stays (no filling over a choice)
  await sheet(p).locator(`[data-preset="${DIRECT}"]`).click()
  await expect(sheet(p)).toHaveCount(0)
  await shows(p, '[data-test="profile-avatar"]', DIRECT)
  expect(await stored(HJ)).toBe(DIRECT)
  await p.reload()
  await shows(p, '[data-test="profile-avatar"]', DIRECT)
  expect(await stored(HJ)).toBe(DIRECT)
  expect((await S.api(HJ.token, '/me')).user.picture).toBe(DIRECT)
  // a Google address is never a choice the page may save
  expect((await put(HJ, g1)).status).toBe(400)
  // 「Google 사진으로」: back to the default — the Google picture, in both apps
  await p.locator('[data-test="profile-picture-change"]').click()
  const back = sheet(p).locator('[data-test="picture-remove"]')
  await expect(back).toHaveText('Google 사진으로')
  await shot(p, 'f-av-08b-google-sheet')
  await back.click()
  await expect(sheet(p)).toHaveCount(0)
  await shows(p, '[data-test="profile-avatar"]', g1)
  expect(await stored(HJ)).toBe(g1)
  await toChat(p)
  await shows(p, TOP, g1)
  // teammates see it too
  expect((await (await api(SY, '/people/pictures')).json())[HJ.id]).toBe(g1)
  // the Google account changes its picture: the default follows (the field held the Google picture, not a choice)
  const g2 = await googlePicture('hajun-2.png')
  await p.reload()
  await shows(p, TOP, g2)
  expect(await stored(HJ)).toBe(g2)
  await shot(p, 'f-av-08c-google-followed')
  // a Google picture that no longer loads (expired, offline): the initial
  const gone = await googlePicture('gone.png')
  await p.reload()
  await showsInitial(p, TOP, '이')
  expect(G.asked.some((a) => a.path === '/a/gone.png')).toBe(true)
  expect(await stored(HJ)).toBe(gone)
  expect(p.errors).toEqual([])
  await p.context().close()
})
