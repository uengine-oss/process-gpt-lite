// 로그인 완료 화면(/auth/done)은 그 창에서 시작한 로그인만 받는다 (스펙 google-connect 「로그인 완료 화면은 그 창에서 시작한 로그인만 받는다」,
// src/signInNonce.js) — 웹과 데스크톱 앱 창이 같은 화면이다. Google 과 로그인 서버의 단계는 이 시험의 브라우저가 흉내 낸다: 화면이 보낸
// 시작 주소를 가로채 돌려준다(설치형 /api/auth/google/start?n= → /auth/done?n=…#<세션>, 게이트웨이는 Supabase authorize 의
// redirect_to — 그대로의 /auth/done — 로 #access_token=…). 세션은 데모 로그인으로 받은 실제 세션이다.
import { test, expect } from '../../lib/fixtures.js'
import * as api from '../../lib/api.js'
import { PGPT_URL } from '../../lib/env.js'

const KEY = 'pgpt-pro-session'
const ORIGIN = new URL(PGPT_URL).origin
const sessionOf = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), KEY)
const doneUrl = (n, login) => `${PGPT_URL}/auth/done${n ? `?n=${n}` : ''}#${encodeURIComponent(JSON.stringify(login))}`
// where a signed-in person lands (a test account not yet onboarded goes on to /welcome)
const landed = (page) => page.waitForURL((u) => /\/(chat|welcome)/.test(u.pathname), { timeout: 20_000 })
const supabaseFragment = (s) => `access_token=${s.access_token}&expires_at=${s.expires_at}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer`
// the app's own settings, with the sign-in this test stands in for
async function withConfig(page, over) {
  await page.route('**/api/config', async (r) => {
    const res = await r.fetch()
    await r.fulfill({ response: res, json: { ...(await res.json()), ...over } })
  })
}

test('F-AD-01 시작하지 않은 로그인: 세션이 붙은 /auth/done 링크로는 로그인되지 않고, 로그인 화면이 이유를 말한다', async ({ browser }) => {
  const other = await api.login('authdone-b')
  const ctx = await browser.newContext({ locale: 'ko-KR' })
  try {
    const page = await ctx.newPage()
    for (const u of [
      doneUrl('', other),
      doneUrl('ab'.repeat(24), other),
      `${PGPT_URL}/auth/done?n=${'cd'.repeat(24)}#${supabaseFragment(other.session)}`,
      `${PGPT_URL}/auth/done#error=access_denied&error_description=${encodeURIComponent('아무 말이나 이 화면에')}`,
    ]) {
      await page.goto(u)
      await page.waitForURL(/\/login\?error=/)
      expect(await sessionOf(page), u).toBeNull()
      await expect(page.getByText('이 창에서 시작한 로그인만 완료할 수 있어요. 다시 로그인해 주세요.')).toBeVisible()
      await expect(page.getByText('아무 말이나 이 화면에')).toHaveCount(0)
    }
  } finally { await ctx.close() }
})

test('F-AD-02 설치형 「Google로 계속하기」: 그 창이 보낸 값으로 돌아오면 로그인된다 (값은 한 번만)', async ({ browser }) => {
  const me = await api.login('authdone-a')
  const ctx = await browser.newContext({ locale: 'ko-KR' })
  try {
    const page = await ctx.newPage()
    await withConfig(page, { googleLogin: true, google: true, sso: null })
    let sent = ''
    // (the server's callback after Google: /auth/done?n=<what the page sent>#<the session> — lib/googleConnect.js loginDoneUrlOf)
    await page.route('**/api/auth/google/start*', (r) => {
      sent = new URL(r.request().url()).searchParams.get('n') || ''
      return r.fulfill({ status: 302, headers: { Location: doneUrl(sent, me) } })
    })
    await page.goto(`${PGPT_URL}/login`)
    await page.getByRole('button', { name: 'Google로 계속하기' }).click()
    await landed(page)
    expect(sent).toMatch(/^[0-9a-f]{48}$/)
    expect((await sessionOf(page))?.session?.access_token).toBe(me.session.access_token)
    expect(page.url()).not.toContain(me.session.access_token)
    // the same address once more (the value is spent): nothing changes for the one signed in
    await page.goto(doneUrl(sent, me))
    await landed(page)
    expect((await sessionOf(page))?.session?.access_token).toBe(me.session.access_token)
  } finally { await ctx.close() }
})

test('F-AD-03 게이트웨이(ProcessGPT 의 Supabase 로그인): redirect_to 는 그대로의 /auth/done, 그 창이 시작한 로그인이면 돌아와 로그인된다(한 번만)', async ({ browser }) => {
  const me = await api.login('authdone-a')
  const ctx = await browser.newContext({ locale: 'ko-KR' })
  try {
    const page = await ctx.newPage()
    await withConfig(page, { googleLogin: false, google: false, sso: { google: `${ORIGIN}/__fake-auth/auth/v1/authorize?provider=google` } })
    let redirectTo = ''
    await page.route('**/__fake-auth/**', (r) => {
      redirectTo = new URL(r.request().url()).searchParams.get('redirect_to') || ''
      return r.fulfill({ status: 302, headers: { Location: `${redirectTo}#${supabaseFragment(me.session)}` } })
    })
    await page.goto(`${PGPT_URL}/login`)
    await page.getByRole('button', { name: 'Google로 계속하기' }).click()
    await landed(page)
    expect(redirectTo).toBe(`${PGPT_URL}/auth/done`)
    expect((await sessionOf(page))?.session?.access_token).toBe(me.session.access_token)
    // the same answer once more, in another browser with nobody signed in and no sign-in under way: not taken
    const ctx2 = await browser.newContext({ locale: 'ko-KR' })
    try {
      const other = await ctx2.newPage()
      await other.goto(`${PGPT_URL}/auth/done#${supabaseFragment(me.session)}`)
      await other.waitForURL(/\/login\?error=/)
      expect(await sessionOf(other)).toBeNull()
    } finally { await ctx2.close() }
  } finally { await ctx.close() }
})

test('F-AD-04 이미 로그인한 사람은 다른 사람의 세션으로 바뀌지 않는다(그 창이 시작한 로그인이어도)', async ({ browser }) => {
  const me = await api.login('authdone-a')
  const other = await api.login('authdone-b')
  const ctx = await browser.newContext({ locale: 'ko-KR' })
  try {
    const page = await ctx.newPage()
    await page.goto(`${PGPT_URL}/login`)
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(me)])
    // not started here
    await page.goto(doneUrl('', other))
    await landed(page)
    expect((await sessionOf(page))?.session?.access_token).toBe(me.session.access_token)
    // started here, but another person's session comes back
    const n = 'ef'.repeat(24)
    await page.evaluate((v) => sessionStorage.setItem('pgl-sign-in', JSON.stringify({ n: v, at: Date.now(), via: 'own' })), n)
    await page.goto(doneUrl(n, other))
    await landed(page)
    expect((await sessionOf(page))?.session?.access_token).toBe(me.session.access_token)
    // a ProcessGPT sign-in under way here, and another person's session comes back
    await page.evaluate((v) => sessionStorage.setItem('pgl-sign-in', JSON.stringify({ n: v, at: Date.now(), via: 'sso' })), n)
    await page.goto(`${PGPT_URL}/auth/done#${supabaseFragment(other.session)}`)
    await landed(page)
    expect((await sessionOf(page))?.session?.access_token).toBe(me.session.access_token)
  } finally { await ctx.close() }
})
