// 오늘의 배경 사진(2026-11-24 사용자 요청: 「그 계절과 그 날짜에 해당하는 풍경 사진 … 그날에 추천이 좀 되면서 홈 패널 쪽에 있던 날짜 달력
// 그쪽에서 … 자기의 무드에 따라서 선택」) — Home 의 날짜 · 날씨 패널에 그날의 사진 후보(하늘이 첫 칸), 고르면 배경이 바뀌고 출처가 붙음,
// 새로 고쳐도 · 다른 기기에서도 그대로, 「오늘만」은 다음 날 하늘(가짜 시계), 하늘로 돌아가기, 회사 관리자 스위치, 휴대폰 390px,
// 낮 · 밤 테마의 읽기 쉬움, 사진을 못 불러오면 하늘, 무드, 데스크톱 앱의 끌기 띠, 고른 테마에 맞춘 하늘(F-BG-11).
// 사진 사이트는 이 시험이 띄우는 가짜 Wikimedia Commons(127.0.0.1:59971, RT_BG_SITE_PORT)이고, 서버는 그 주소로 묻게
// PRO_BG_COMMONS_API=http://127.0.0.1:59971/w/api.php 로 띄운다(시험에서만 — 게이트웨이 뒤에서는 무시된다). 공용 인터넷에는 나가지 않는다.
// 서버의 주제 · 라이선스 · 캐시 · 스위치 · 저장은 server/test/background.test.js · background.integration.test.js.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../../lib/fixtures.js'
import { API_URL } from '../../lib/env.js'
// the day's solar term the panel should name (the server's own calendar code)
import { solarTerm } from '../../../server/lib/background/calendar.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../../openspec/specs/daily-background/e2e/results')
const PORT = Number(process.env.RT_BG_SITE_PORT || 59971)
const SITE = `http://127.0.0.1:${PORT}`
const PHONE = { width: 390, height: 844 }
// Playwright's own Chromium (never a person's Chrome)
test.use({ channel: 'chromium' })
// one worker: the fake site's port is this file's, and F-BG-05 turns the company switch off for a moment
test.describe.configure({ mode: 'serial' })

// ---------- the fake Commons: ten made-up photos (SVG landscapes), any search answers them in a shifted order ----------
const PHOTOS = [
  { name: 'Frosted_meadow_at_dawn', title: 'Frosted meadow at dawn', sky: ['#cfe0f2', '#f4f7fb'], hills: ['#e9eef4', '#c9d4e0'], sun: '#ffffff', license: 'CC BY-SA 4.0', author: 'Haneul Park' },
  { name: 'Snowy_ridge_in_November', title: 'Snowy ridge in November', sky: ['#7e9cc0', '#dbe6f2'], hills: ['#f5f8fb', '#9fb0c4'], sun: '#fff7e0', license: 'CC BY 4.0', author: 'Minseo Yoon' },
  { name: 'Night_sky_over_the_pass', title: 'Night sky over the pass', sky: ['#060a1c', '#1d2a55'], hills: ['#0b1024', '#151c38'], sun: '#dfe6ff', stars: true, license: 'CC0', author: 'Jiho Kang' },
  { name: 'Sunset_on_a_frozen_lake', title: 'Sunset on a frozen lake', sky: ['#3a2a6a', '#f39a5b'], hills: ['#2a2140', '#4a3560'], sun: '#ffd27a', license: 'CC BY-SA 4.0', author: 'Seoyeon Lim' },
  { name: 'Misty_pine_forest', title: 'Misty pine forest', sky: ['#9aa7a6', '#d9dfdc'], hills: ['#5f7268', '#3d4f45'], sun: '#eef2ef', license: 'Public domain', author: 'Dohyun Cha' },
  { name: 'Autumn_valley_road', title: 'Autumn valley road', sky: ['#87a9d6', '#e8d9c0'], hills: ['#c56a2d', '#8a3f1c'], sun: '#fff3cf', license: 'CC BY-SA 3.0', author: 'Yuna Seo' },
  { name: 'Blue_coast_cliffs', title: 'Blue coast cliffs', sky: ['#2d7fc1', '#a9d8f2'], hills: ['#1c5e7d', '#0f3d55'], sun: '#ffffff', license: 'CC BY 4.0', author: 'Taeyang Moon' },
  { name: 'Garden_in_bloom', title: 'Garden in bloom', sky: ['#9cc7ea', '#f1e4f0'], hills: ['#d77fa1', '#5d8f4e'], sun: '#fffbe6', license: 'FAL', author: 'Bora Han' },
  { name: 'Harbour_lights', title: 'Harbour lights', sky: ['#0d1430', '#3b2f5e'], hills: ['#141a33', '#2b2244'], sun: '#ffcf6b', stars: true, license: 'CC BY-SA 4.0', author: 'Eunji Song' },
  { name: 'Wheat_field_after_rain', title: 'Wheat field after rain', sky: ['#6f8fb0', '#cfd8de'], hills: ['#c9a85a', '#8f7a3e'], sun: '#f7f1dc', license: 'KOGL Type 1', author: 'Siwoo Baek' },
]
const PANORAMA = { name: 'Old_town_panorama', title: 'Old town panorama', sky: ['#5d86c2', '#f2d9b8'], hills: ['#b07a55', '#6b4a33'], sun: '#fff2d8', license: 'CC BY-SA 4.0', author: 'Nari Jung', w: 9600, h: 3000 }
const ALL = [...PHOTOS, PANORAMA]
const LICENSE_URL = { 'CC BY-SA 4.0': 'https://creativecommons.org/licenses/by-sa/4.0', 'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0', 'CC BY-SA 3.0': 'https://creativecommons.org/licenses/by-sa/3.0', CC0: 'https://creativecommons.org/publicdomain/zero/1.0/' }
const svg = (p, w, h) => {
  const stars = p.stars ? Array.from({ length: 60 }, (_, i) => `<circle cx="${(i * 97) % w}" cy="${(i * 53) % (h * 0.55)}" r="${1 + (i % 3) * 0.6}" fill="#fff" fill-opacity="${0.4 + (i % 5) / 10}"/>`).join('') : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#s)"/>${stars}<circle cx="${w * 0.72}" cy="${h * 0.3}" r="${h * 0.07}" fill="${p.sun}" fill-opacity=".85"/>
<path d="M0 ${h * 0.62} L${w * 0.18} ${h * 0.46} L${w * 0.34} ${h * 0.58} L${w * 0.52} ${h * 0.4} L${w * 0.7} ${h * 0.56} L${w * 0.86} ${h * 0.44} L${w} ${h * 0.55} L${w} ${h} L0 ${h}Z" fill="${p.hills[1]}"/>
<path d="M0 ${h * 0.78} Q${w * 0.25} ${h * 0.66} ${w * 0.5} ${h * 0.76} T${w} ${h * 0.72} L${w} ${h} L0 ${h}Z" fill="${p.hills[0]}"/></svg>`
}
const page = (p, i) => {
  const w = p.w || 6000, h = p.h || 4000
  return {
    pageid: 910000 + ALL.indexOf(p), ns: 6, title: `File:${p.name}.jpg`, index: i + 1,
    imageinfo: [{
      width: w, height: h, size: 3_000_000, mime: 'image/jpeg', user: p.author.replace(/ /g, ''),
      url: `${SITE}/orig/${p.name}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${p.name}.jpg`,
      thumburl: `${SITE}/thumb/a/ab/${p.name}.jpg/1920px-${p.name}.jpg?utm_source=commons.wikimedia.org`,
      extmetadata: {
        ObjectName: { value: p.title }, LicenseShortName: { value: p.license }, ...(LICENSE_URL[p.license] ? { LicenseUrl: { value: LICENSE_URL[p.license] } } : {}),
        Artist: { value: `<a href="//commons.wikimedia.org/wiki/User:${p.author.replace(/ /g, '_')}" title="User:${p.author.replace(/ /g, '_')}">${p.author}</a>` },
      },
    }],
  }
}
const seed = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
const api = []
const images = []
const broken = new Set()
let site
test.beforeAll(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url, SITE)
    if (u.pathname === '/w/api.php') {
      api.push(u.search)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (u.searchParams.get('generator') === 'images') return res.end(JSON.stringify({ query: { pages: [page(PANORAMA, 0)] } }))
      const k = seed(`${u.searchParams.get('gsrsearch')}${u.searchParams.get('gsroffset') || ''}`) % PHOTOS.length
      return res.end(JSON.stringify({ query: { pages: PHOTOS.map((p, i) => page(p, (i + k) % PHOTOS.length)) } }))
    }
    const m = /^\/(?:thumb\/a\/ab\/[^/]+\/(\d+)px-|orig\/)([\w]+)\.jpg$/.exec(u.pathname)
    const p = m && ALL.find((x) => x.name === m[2])
    if (p && !broken.has(p.name)) {
      images.push(u.pathname)
      const w = Number(m[1] || p.w || 6000)
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' })
      return res.end(svg(p, w, Math.round(w * ((p.h || 4000) / (p.w || 6000)))))
    }
    res.writeHead(404); res.end()
  })
  await new Promise((ok, no) => site.once('error', no).listen(PORT, '127.0.0.1', ok))
  fs.mkdirSync(SHOTS, { recursive: true })
})
test.afterAll(async () => { site?.closeAllConnections?.(); await new Promise((ok) => site?.close(ok) ?? ok()) })

// ---------- helpers ----------
const calm = (pg) => pg.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 3000)),
]))
const shot = async (pg, name) => {
  await calm(pg)
  await pg.waitForTimeout(400)
  await pg.screenshot({ path: path.join(SHOTS, name) })
}
const theme = (pg, t) => pg.context().addInitScript((v) => { try { localStorage.setItem('pgpt-pro-theme', v) } catch { /* opaque */ } }, t)
const tiles = (pg) => pg.locator('[data-test="bg-tile"]')
const photoTiles = (pg) => pg.locator('[data-test="bg-tile"]:not([data-id="sky"])')
const shown = (pg) => pg.locator('[data-test="photo-backdrop"]')
// the backdrop shows this photo (its layer has loaded and faded in)
const showing = (pg, id) => expect(shown(pg)).toHaveAttribute('data-photo', id, { timeout: 15_000 })
const clean = (db, id) => db.q('update pro_profile set background=null where user_id=$1', [id]).catch(() => {})
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
async function home(pg) {
  await pg.goto('/chat')
  await expect(pg.locator('[data-test="bg-picker"]')).toBeVisible({ timeout: 20_000 })
  await expect(photoTiles(pg).first()).toBeVisible({ timeout: 20_000 })
}

test.describe('오늘의 배경 사진 — Home 의 날짜 · 날씨 패널에서 그날의 사진을 골라 배경으로', () => {
  test('F-BG-01 날짜 · 절기와 그날의 후보: 하늘이 첫 칸, 사진 6~10장에 주제 이름(절기 · 시간대 · 오늘의 사진 …), 출처는 그 사이트의 CDN', async ({ pageAs, db, cleanup }) => {
    const pg = await pageAs('bg-home')
    await clean(db, pg.user.id)
    cleanup(() => clean(db, pg.user.id))
    await theme(pg, 'dark')
    await home(pg)
    // the date row: today's date and its solar term
    const term = solarTerm(localDate(new Date()))
    await expect(pg.locator('[data-test="wx-term"]')).toHaveText(term.ko)
    await expect(pg.locator('[data-test="wx-date"]')).toContainText(`${new Date().getMonth() + 1}월 ${new Date().getDate()}일`)
    // the strip: the sky first (chosen — the default), then 6 to 10 photos, each with its theme
    await expect(tiles(pg).first()).toHaveAttribute('data-id', 'sky')
    await expect(tiles(pg).first()).toHaveAttribute('aria-pressed', 'true')
    const n = await photoTiles(pg).count()
    expect(n).toBeGreaterThanOrEqual(6)
    expect(n).toBeLessThanOrEqual(10)
    const labels = await photoTiles(pg).locator('.lbl').allTextContents()
    expect(labels.every((l) => l.trim().length > 0)).toBe(true)
    expect(labels.filter((l) => l.startsWith(`${term.ko} · `)).length).toBeGreaterThanOrEqual(1)
    expect(labels).toContain('오늘의 사진')
    expect(labels).toContain('멋진 풍경 한 장')
    // the thumbnails come from the photo site (here: the fake one) at its 330px width, with no referrer
    const srcs = await photoTiles(pg).locator('img').evaluateAll((els) => els.map((e) => [e.getAttribute('src'), e.referrerPolicy]))
    expect(srcs.every(([s, r]) => s.startsWith(`${SITE}/thumb/`) && s.includes('/330px-') && r === 'no-referrer')).toBe(true)
    // nothing chosen yet: the sky, no credit
    await expect(shown(pg)).toHaveAttribute('data-photo', '')
    await expect(pg.locator('[data-test="bg-credit"]')).toHaveCount(0)
    await shot(pg, 'f-bg-01-strip-dark.png')
    expect(pg.errors).toEqual([])
  })

  test('F-BG-02 고르면 바로 배경이 바뀌고 출처(제목 · 작가 · 라이선스 · 출처)가 붙는다 · 새로 고쳐도 · 다른 기기(휴대폰)에서도 그대로', async ({ pageAs, db, cleanup }) => {
    const pg = await pageAs('bg-pick')
    await clean(db, pg.user.id)
    cleanup(() => clean(db, pg.user.id))
    await theme(pg, 'dark')
    await home(pg)
    const tile = photoTiles(pg).nth(1)
    const id = await tile.getAttribute('data-id')
    const label = (await tile.locator('.lbl').textContent()).trim()
    await tile.click()
    await expect(tile).toHaveAttribute('aria-pressed', 'true')
    await showing(pg, id)
    // the credit under the strip and in the corner
    const credit = pg.locator('[data-test="bg-credit"]')
    await expect(credit).toBeVisible()
    const p = ALL.find((x) => id === `commons:${910000 + ALL.indexOf(x)}`)
    await expect(credit).toContainText(p.title)
    await expect(credit).toContainText(p.author)
    await expect(credit).toContainText(p.license)
    await expect(credit).toContainText('Wikimedia Commons')
    await expect(pg.locator('[data-test="bg-credit-title"]')).toHaveAttribute('href', `https://commons.wikimedia.org/wiki/File:${p.name}.jpg`)
    await expect(pg.locator('[data-test="bg-corner-credit"]')).toContainText(`${p.title} · ${p.author} · ${p.license} · Wikimedia Commons`)
    // the picture is the photo site's own, a background width (srcset), never through this app
    const img = pg.locator(`[data-test="photo-backdrop"] img[data-id="${id}"]`)
    expect(await img.getAttribute('srcset')).toMatch(new RegExp(`^${SITE.replace(/[.:/]/g, '\\$&')}/thumb/a/ab/${p.name}\\.jpg/960px-${p.name}\\.jpg 960w, .+ 1280w, .+ 1920w$`))
    expect(await img.getAttribute('referrerpolicy')).toBe('no-referrer')
    // saved on the server for this person: today only by default
    const [row] = await db.q('select background from pro_profile where user_id=$1', [pg.user.id])
    expect(row.background).toMatchObject({ keep: 'today', day: localDate(new Date()), photo: { id, label, provider: 'commons', license: p.license, author: p.author } })
    await shot(pg, 'f-bg-02a-picked-dark.png')
    // reload: the same photo
    await pg.reload()
    await showing(pg, id)
    await expect(pg.locator(`[data-test="bg-tile"][data-id="${id}"]`)).toHaveAttribute('aria-pressed', 'true')
    // another device of the same person (a phone): the same photo
    const phone = await pageAs('bg-pick', { viewport: PHONE, touch: true })
    await phone.goto('/chat')
    await showing(phone, id)
    expect(pg.errors).toEqual([])
  })

  test('F-BG-03 「오늘만」은 다음 날 하늘로(가짜 시계) · 「계속 두기」는 다음 날에도 남는다', async ({ pageAs, db, cleanup }) => {
    const pg = await pageAs('bg-today')
    await clean(db, pg.user.id)
    cleanup(() => clean(db, pg.user.id))
    await home(pg)
    const tile = photoTiles(pg).nth(2)
    const id = await tile.getAttribute('data-id')
    await tile.click()
    await showing(pg, id)
    await expect(pg.locator('[data-test="bg-keep-today"]')).toHaveAttribute('aria-pressed', 'true')
    // tomorrow, 9 in the morning: today's choice has gone — the sky, and the sky tile chosen
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0)
    const next = await pageAs('bg-today')
    await next.clock.install({ time: tomorrow })
    await next.goto('/chat')
    await expect(next.locator('[data-test="bg-picker"]')).toBeVisible({ timeout: 20_000 })
    await expect(photoTiles(next).first()).toBeVisible({ timeout: 20_000 })
    await expect(shown(next)).toHaveAttribute('data-photo', '')
    await expect(next.locator('[data-test="bg-tile"][data-id="sky"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(next.locator('[data-test="wx-term"]')).toHaveText(solarTerm(localDate(tomorrow)).ko)
    // 「계속 두기」 today: still there tomorrow
    await pg.locator('[data-test="bg-keep-always"]').click()
    await expect(pg.locator('[data-test="bg-keep-always"]')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await db.q('select background from pro_profile where user_id=$1', [pg.user.id]))[0].background.keep).toBe('always')
    await shot(pg, 'f-bg-03a-keep.png')
    const later = await pageAs('bg-today')
    await later.clock.install({ time: tomorrow })
    await later.goto('/chat')
    await showing(later, id)
    await shot(later, 'f-bg-03b-tomorrow-keep.png')
    expect(pg.errors).toEqual([])
  })

  test('F-BG-04 하늘로 돌아가기: 하늘 칸을 누르면 사진이 사라지고(출처도), 저장된 선택도 없다 · 무드 칩은 그 무드의 사진을 앞에', async ({ pageAs, db, cleanup }) => {
    const pg = await pageAs('bg-sky')
    await clean(db, pg.user.id)
    cleanup(() => clean(db, pg.user.id))
    await theme(pg, 'light')
    await home(pg)
    const id = await photoTiles(pg).first().getAttribute('data-id')
    await photoTiles(pg).first().click()
    await showing(pg, id)
    await pg.locator('[data-test="bg-tile"][data-id="sky"]').click()
    await expect(shown(pg)).toHaveAttribute('data-photo', '', { timeout: 10_000 })
    await expect(pg.locator('[data-test="bg-tile"][data-id="sky"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(pg.locator('[data-test="bg-credit"]')).toHaveCount(0)
    await expect(pg.locator('[data-test="bg-corner-credit"]')).toHaveCount(0)
    await expect.poll(async () => (await db.q('select background from pro_profile where user_id=$1', [pg.user.id]))[0].background).toBeNull()
    await pg.reload()
    await expect(photoTiles(pg).first()).toBeVisible({ timeout: 20_000 })
    await expect(shown(pg)).toHaveAttribute('data-photo', '')
    // a mood: its own themes come first
    await pg.locator('[data-test="bg-mood-warm"]').click()
    await expect(pg.locator('[data-test="bg-mood-warm"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(photoTiles(pg).nth(0).locator('.lbl')).toHaveText('노을빛')
    await expect(photoTiles(pg).nth(1).locator('.lbl')).toHaveText('햇살 드는 숲')
    await shot(pg, 'f-bg-04-mood-light.png')
    await pg.locator('[data-test="bg-mood-warm"]').click()
    await expect(pg.locator('[data-test="bg-mood-warm"]')).toHaveAttribute('aria-pressed', 'false')
    expect(pg.errors).toEqual([])
  })

  test('F-BG-05 회사 관리자 스위치(설정 › 시스템 설정): 끄면 띠가 사라지고 모두 하늘, 관리자가 아니면 403, 다시 켜면 돌아온다', async ({ pageAs, as, db, cleanup }) => {
    const u = await as('bg-member')
    expect((await u.put('/admin/background', { enabled: false })).status).toBe(403)
    expect((await u.get('/admin/background')).status).toBe(403)
    const pg = await pageAs('bg-admin')
    const admin = pg.user
    await db.q('update users set is_admin=true where id=$1 and tenant_id=$2', [admin.id, db.tenant])
    await clean(db, admin.id)
    cleanup(async () => {
      await admin.put('/admin/background', { enabled: true }).catch(() => {})
      await db.q('delete from pro_background_settings where tenant_id=$1', [db.tenant])
      await db.q('update users set is_admin=false where id=$1 and tenant_id=$2', [admin.id, db.tenant])
      await clean(db, admin.id)
    })
    // a saved photo, then the company turns the photos off
    await home(pg)
    const id = await photoTiles(pg).nth(1).getAttribute('data-id')
    await photoTiles(pg).nth(1).click()
    await showing(pg, id)
    await pg.goto('/settings/system')
    const sw = pg.locator('[data-test="bg-photo-switch"]')
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    // the keys are write-only: only whether one is saved
    const info = await admin.get('/admin/background')
    expect(info.body).toEqual({ enabled: true, keys: { unsplash: { saved: false }, pexels: { saved: false } } })
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await pg.locator('[data-test="bg-admin"]').evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await shot(pg, 'f-bg-05a-switch-off.png')
    expect((await u.get('/me')).body.features.background).toBe(false)
    const off = await u.get(`/background/today?date=${localDate(new Date())}&hour=9`)
    expect(off.body.enabled).toBe(false)
    expect(off.body.candidates).toEqual([])
    // Home: no strip, the sky (the saved choice is kept for when it comes back)
    await pg.goto('/chat')
    await expect(pg.locator('[data-test="weather-panel"]')).toBeVisible({ timeout: 20_000 })
    await expect(pg.locator('[data-test="wx-term"]')).toBeVisible()
    await expect(pg.locator('[data-test="bg-picker"]')).toHaveCount(0)
    await expect(shown(pg)).toHaveAttribute('data-photo', '')
    await shot(pg, 'f-bg-05b-home-off.png')
    // another person's screen too
    const other = await pageAs('bg-member')
    await other.goto('/chat')
    await expect(other.locator('[data-test="weather-panel"]')).toBeVisible({ timeout: 20_000 })
    await expect(other.locator('[data-test="bg-picker"]')).toHaveCount(0)
    // back on
    await pg.goto('/settings/system')
    await pg.locator('[data-test="bg-photo-switch"]').click()
    await expect(pg.locator('[data-test="bg-photo-switch"]')).toHaveAttribute('aria-checked', 'true')
    await pg.goto('/chat')
    await expect(pg.locator('[data-test="bg-picker"]')).toBeVisible({ timeout: 20_000 })
    await showing(pg, id)
    expect(pg.errors).toEqual([])
  })

  test('F-BG-06 휴대폰 390px: 띠는 패널 안에서 옆으로 넘기고 화면은 밀리지 않는다, 출처는 패널에(구석 출처 없음), 데이터 절약이면 가장 작은 그림만', async ({ pageAs, db, cleanup }) => {
    const pg = await pageAs('bg-phone', { viewport: PHONE, touch: true })
    await clean(db, pg.user.id)
    cleanup(() => clean(db, pg.user.id))
    await theme(pg, 'dark')
    // a phone saving data (Save-Data)
    await pg.context().addInitScript(() => { try { Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' }, configurable: true }) } catch { /* fine */ } })
    await home(pg)
    const strip = pg.locator('[data-test="bg-strip"]')
    const m = await strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, overflowX: getComputedStyle(el).overflowX }))
    expect(m.sw).toBeGreaterThan(m.cw)
    expect(m.overflowX).toBe('auto')
    await strip.evaluate((el) => el.scrollBy({ left: 400 }))
    await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100)
    // the page itself does not move sideways, and the panel stays within the screen
    const page = await pg.evaluate(() => ({ doc: document.scrollingElement.scrollWidth, w: innerWidth, dock: (() => { const d = document.querySelector('aside.dock'); return d ? d.scrollWidth - d.clientWidth : 0 })(), panel: document.querySelector('[data-test="weather-panel"]').getBoundingClientRect().right }))
    expect(page.doc).toBeLessThanOrEqual(page.w)
    expect(page.dock).toBeLessThanOrEqual(0)
    expect(page.panel).toBeLessThanOrEqual(390)
    const tile = photoTiles(pg).nth(3)
    await tile.scrollIntoViewIfNeeded()
    const id = await tile.getAttribute('data-id')
    await tile.tap()
    await showing(pg, id)
    await expect(pg.locator('[data-test="bg-credit"]')).toBeVisible()
    await expect(pg.locator('[data-test="bg-corner-credit"]')).toHaveCount(0)
    // data saving: one (the smallest) width in the srcset
    expect(await pg.locator(`[data-test="photo-backdrop"] img[data-id="${id}"]`).getAttribute('srcset')).toMatch(/^\S+ 960w$/)
    await shot(pg, 'f-bg-06-phone.png')
    expect(pg.errors).toEqual([])
  })

  test('F-BG-07 읽기 쉬움: 밝은 사진 · 어두운 사진, 낮 · 밤 테마 모두 가림막(scrim)이 깔리고 패널과 글이 읽힌다', async ({ pageAs, db, cleanup }) => {
    const ensure = async (pg, name) => {
      const id = `commons:${910000 + ALL.findIndex((x) => x.name === name)}`
      // the photo the test wants, saved directly as this person's choice (the strip's order is the server's)
      const p = ALL.find((x) => x.name === name)
      const photo = { id, provider: 'commons', title: p.title, author: p.author, license: p.license, sourceName: 'Wikimedia Commons', sourceUrl: `https://commons.wikimedia.org/wiki/File:${p.name}.jpg`,
        thumb: `${SITE}/thumb/a/ab/${p.name}.jpg/330px-${p.name}.jpg`, src: { 960: `${SITE}/thumb/a/ab/${p.name}.jpg/960px-${p.name}.jpg`, 1280: `${SITE}/thumb/a/ab/${p.name}.jpg/1280px-${p.name}.jpg`, 1920: `${SITE}/thumb/a/ab/${p.name}.jpg/1920px-${p.name}.jpg` }, width: 6000, height: 4000 }
      const r = await pg.user.put('/background', { photo, keep: 'today', date: localDate(new Date()) })
      expect(r.status, r.text).toBe(200)
      return id
    }
    const scrim = (pg) => pg.locator('[data-test="photo-backdrop"] .scrim').evaluate((el) => ({ o: getComputedStyle(el).opacity, bg: getComputedStyle(el).backgroundImage }))
    for (const [t, name, file] of [['light', 'Frosted_meadow_at_dawn', 'f-bg-07a-light-bright.png'], ['dark', 'Frosted_meadow_at_dawn', 'f-bg-07b-dark-bright.png'], ['dark', 'Night_sky_over_the_pass', 'f-bg-07c-dark-night.png'], ['light', 'Autumn_valley_road', 'f-bg-07d-light-autumn.png']]) {
      const pg = await pageAs('bg-look')
      cleanup(() => clean(db, pg.user.id))
      await theme(pg, t)
      const id = await ensure(pg, name)
      await home(pg)
      await showing(pg, id)
      // (the scrim fades in with the photo)
      await expect.poll(async () => (await scrim(pg)).o, { timeout: 5000 }).toBe('1')
      const s = await scrim(pg)
      expect(s.bg).toContain(t === 'light' ? 'rgba(248, 249, 252' : 'rgba(6, 8, 18')
      await shot(pg, file)
      expect(pg.errors).toEqual([])
    }
  })

  test('F-BG-08 사진을 불러오지 못하면 하늘이 그대로(패널에 한 줄), 다시 되면 사진 · 움직임 줄이기에서는 바로 바뀐다', async ({ pageAs, db, cleanup }) => {
    const pg = await pageAs('bg-broken')
    await clean(db, pg.user.id)
    cleanup(() => { broken.clear(); return clean(db, pg.user.id) })
    await home(pg)
    const tile = photoTiles(pg).nth(4)
    const id = await tile.getAttribute('data-id')
    await tile.click()
    await showing(pg, id)
    const p = ALL.find((x) => id === `commons:${910000 + ALL.indexOf(x)}`)
    // the site stops serving it: a fresh page (no cache) shows the sky and says why
    broken.add(p.name)
    const next = await pageAs('bg-broken')
    await next.emulateMedia({ reducedMotion: 'reduce' })
    await next.goto('/chat')
    await expect(next.locator('[data-test="bg-failed"]')).toBeVisible({ timeout: 20_000 })
    await expect(shown(next)).toHaveAttribute('data-photo', '')
    await expect(next.locator('canvas.sky')).toBeVisible()
    await shot(next, 'f-bg-08-failed-sky.png')
    // it comes back, and tapping it again shows it — at once (reduced motion: no fade)
    broken.clear()
    await next.locator(`[data-test="bg-tile"][data-id="${id}"]`).click()
    await showing(next, id)
    expect(await next.locator(`[data-test="photo-backdrop"] img[data-id="${id}"]`).evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s/)
    await expect(next.locator('[data-test="bg-failed"]')).toHaveCount(0)
    expect(next.errors).toEqual([])
  })

  test('F-BG-09 데스크톱 앱: 사진은 창의 끌기 띠를 가리지 않는다(누름이 지나가고 app-region 이 없음), 구석 출처 링크는 눌린다', async ({ pageAs, db, cleanup }) => {
    const pg = await pageAs('bg-desktop')
    await clean(db, pg.user.id)
    cleanup(() => clean(db, pg.user.id))
    // the desktop app's preload marks the page (desktop/src/preload.js); src/styles/desktop.css makes the top strip the drag region
    // (<html> may not exist yet when the script runs: marked the moment it is inserted, as install-nudge.spec.js does)
    await pg.addInitScript(() => {
      const mark = () => { const el = document.documentElement; if (!el) return false; el.classList.add('pgl-desktop', 'pgl-os-darwin'); return true }
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect() }).observe(document, { childList: true })
    })
    await home(pg)
    const id = await photoTiles(pg).first().getAttribute('data-id')
    await photoTiles(pg).first().click()
    await showing(pg, id)
    const r = await pg.evaluate(() => {
      const b = document.querySelector('[data-test="photo-backdrop"]')
      const cs = getComputedStyle(b)
      const strip = getComputedStyle(document.body, '::before')
      // what is under the pointer in the empty part of the top strip (between the tabs and the buttons)
      const hit = document.elementFromPoint(innerWidth * 0.72, 20)
      const credit = document.querySelector('[data-test="bg-corner-credit"] a')
      const region = (st) => st.getPropertyValue('app-region') || st.getPropertyValue('-webkit-app-region') || 'none'
      return { pe: cs.pointerEvents, region: region(cs), stripRegion: region(strip), stripH: strip.height,
        hitIsPhoto: !!hit?.closest('[data-test="photo-backdrop"]'), creditRegion: credit ? region(getComputedStyle(credit)) : null }
    })
    expect(r.pe).toBe('none')
    expect(r.region).not.toBe('drag')
    expect(r.stripRegion).toBe('drag')
    expect(r.hitIsPhoto).toBe(false)
    expect(r.creditRegion).toBe('no-drag')
    expect(pg.errors).toEqual([])
  })
  // 11-27, found recording the feature videos at 2 a.m.: with a light theme chosen at night the page's titles (「계정」, a folder's name)
  // were dark ink on the night sky. A theme the person chose now brings its own sky; 「자동」 stays the real one.
  test('F-BG-11 고른 테마와 시각이 어긋나면 하늘도 그 테마에 맞춘다: 밤의 낮 테마는 낮 하늘, 낮의 밤 테마는 밤하늘 · 자동은 실제 하늘', async ({ pageAs, db, cleanup }) => {
    const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d }
    for (const [t, hour, sky, html, file] of [
      ['light', 2, 'day', 'light', 'f-bg-11a-light-at-2am.png'],
      ['dark', 13, 'night', 'dark', 'f-bg-11b-dark-at-1pm.png'],
      ['auto', 2, 'night', 'dark', null],
      ['auto', 13, 'day', 'light', null],
    ]) {
      const pg = await pageAs('bg-theme-sky')
      await clean(db, pg.user.id)
      cleanup(() => clean(db, pg.user.id))
      await theme(pg, t)
      await pg.clock.install({ time: at(hour) })
      await pg.goto('/settings/accounts')
      const title = pg.getByRole('heading', { level: 1, name: '계정' })
      await expect(title).toBeVisible({ timeout: 20_000 })
      await expect(pg.locator('[data-test="sky"]'), `${t} at ${hour}:00`).toHaveAttribute('data-sky', sky, { timeout: 20_000 })
      await expect(pg.locator('html')).toHaveAttribute('data-theme', html)
      // the title's ink suits the sky drawn behind it: dark on the day sky, light on the night sky
      const lum = await title.evaluate((el) => { const [r, g, b] = getComputedStyle(el).color.match(/\d+(\.\d+)?/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 })
      if (sky === 'day') expect(lum, `${t} at ${hour}:00 — title ink ${lum}`).toBeLessThan(0.35)
      else expect(lum, `${t} at ${hour}:00 — title ink ${lum}`).toBeGreaterThan(0.65)
      if (file) await shot(pg, file)
      expect(pg.errors).toEqual([])
    }
  })

})

test('F-BG-10 서버: 로그인해야 묻고(401), 이상한 날짜는 한국 날짜로, 다른 호스트의 사진 · 모르는 「얼마나」는 400', async ({ as }) => {
  const anon = await fetch(`${API_URL}/api/background/today`)
  expect(anon.status).toBe(401)
  const u = await as('bg-api')
  const r = await u.get('/background/today?date=1999-01-01&hour=30&wx=999&mood=angry')
  expect(r.status).toBe(200)
  expect(r.body.day.date).not.toBe('1999-01-01')
  expect(r.body.mood).toBe(null)
  const c = r.body.candidates[0]
  expect((await u.put('/background', { photo: { ...c, src: { 1920: 'https://evil.example.com/x.jpg' } }, keep: 'today' })).status).toBe(400)
  expect((await u.put('/background', { photo: c, keep: 'forever' })).status).toBe(400)
  expect((await u.put('/background', { photo: { ...c, license: 'CC BY-NC 4.0' } })).status).toBe(400)
  expect((await u.del('/background')).status).toBe(200)
})
