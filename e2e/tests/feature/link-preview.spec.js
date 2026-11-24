// 링크 미리보기(2026-11-24 사용자 요청: 「메시지에 URL 이 있으면 페이스북 · Open Graph 처럼 미리보기 카드」) — AI 채팅(내 말 · 에이전트 답),
// 팀 메신저, 휴대폰 너비, 서버의 거절 규칙과 회사 스위치. 페이지는 이 시험이 띄우는 로컬 가짜 사이트(127.0.0.1:59981)이고, 서버는 그 한 곳만
// 읽게 PRO_LINK_PREVIEW_ALLOW_HOSTS=127.0.0.1:59981 로 띄운다(시험에서만 — 운영에서는 비우고, 게이트웨이 뒤에서는 무시된다).
// 서버의 SSRF · 캐시 · 한도는 server/test/linkPreview.test.js, 회사 스위치의 DB 는 linkPreview.integration.test.js.
import http from 'node:http'
import { test, expect, RUN } from '../../lib/fixtures.js'
import { API_URL } from '../../lib/env.js'
// which links of a message get a card (the screen's own rule, a plain function)
import { linksIn } from '../../../src/linkPreview.js'

const PORT = Number(process.env.RT_LP_SITE_PORT || 59981)
const SITE = `http://127.0.0.1:${PORT}`
const PHONE = { width: 390, height: 844 }
// one worker: the fake site's port is this file's
test.describe.configure({ mode: 'serial' })

const svg = (w, h, from, to, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.78}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.18}" fill="#fff" fill-opacity=".28"/>
<text x="${w * 0.07}" y="${h * 0.82}" font-family="Apple SD Gothic Neo, Noto Sans KR, sans-serif" font-size="${Math.round(h * 0.11)}" font-weight="700" fill="#fff">${label}</text></svg>`
const og = ({ title, desc, image, w, h, site, type }) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
${type ? `<meta property="og:type" content="${type}">` : ''}<meta property="og:title" content="${title}"><meta property="og:description" content="${desc}">
${image ? `<meta property="og:image" content="${image}">` : ''}${w ? `<meta property="og:image:width" content="${w}"><meta property="og:image:height" content="${h}">` : ''}
${site ? `<meta property="og:site_name" content="${site}">` : ''}<link rel="icon" href="/favicon.svg"></head><body>본문</body></html>`
const PAGES = {
  '/article': og({ title: '달빛 커피 · 이번 주 원두 이야기', desc: '에티오피아 예가체프와 콜롬비아 수프리모가 새로 들어왔어요. 한정 수량이라 이번 주 안에 주문해 주세요. 원두마다 어울리는 추출법도 함께 정리했어요.', image: '/cover.svg', w: 1200, h: 630, site: '달빛 커피 블로그' }),
  '/small': og({ title: '견적서 양식 안내', desc: '부가세 포함 금액과 납기를 꼭 적어 주세요.', image: '/square.svg', site: '사내 양식 모음' }),
  '/plain': `<!doctype html><html><head><title>회의록 보관 규칙</title><meta name="description" content="회의록은 회의가 끝난 날 안에 공유 폴더에 올립니다."></head></html>`,
  '/video': og({ type: 'video.other', title: '제품 시연 영상 — 3분 둘러보기', desc: '처음 쓰는 분을 위한 짧은 시연입니다.', image: '/video.svg', w: 1280, h: 720, site: '시연 채널' }),
  '/fourth': og({ title: '네 번째 링크', desc: '카드는 세 개까지라 이 링크는 카드가 없어요.' }),
}
const IMAGES = {
  '/cover.svg': svg(1200, 630, '#3b2a1e', '#c8875a', '달빛 커피'),
  '/square.svg': svg(240, 240, '#1f4e79', '#4aa3df', '양식'),
  '/video.svg': svg(1280, 720, '#2d1b4e', '#7a5af5', '시연 영상'),
  '/favicon.svg': svg(32, 32, '#c8875a', '#3b2a1e', ''),
}
const hits = []
let site
test.beforeAll(async () => {
  site = http.createServer(async (req, res) => {
    const path = req.url.split('?')[0]
    hits.push(path)
    if (path === '/slow') { await new Promise((ok) => setTimeout(ok, 2500)); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(og({ title: '늦게 오는 페이지', desc: '읽는 동안 뼈대가 보여요.' })) }
    if (PAGES[path]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGES[path]) }
    if (IMAGES[path]) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(IMAGES[path]) }
    res.writeHead(404); res.end()
  })
  await new Promise((ok, no) => site.once('error', no).listen(PORT, '127.0.0.1', ok))
})
test.afterAll(async () => { site?.closeAllConnections?.(); await new Promise((ok) => site?.close(ok) ?? ok()) })

const calm = (page) => page.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 3000)),
]))
// the cards' pictures in view are drawn (a card whose picture is still coming would be photographed blank;
// a lazy picture out of view does not load, so only those in view count)
const pictures = (loc) => expect.poll(() => loc.evaluate((el) => [...el.querySelectorAll('[data-test="link-card"] img')]
  .filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight })
  .filter((i) => !(i.complete && i.naturalWidth > 0)).length), { timeout: 8000 }).toBe(0)
const shot = async (page, name) => { await calm(page); await page.screenshot({ path: test.info().outputPath(name) }) }
const theme = (page, t) => page.context().addInitScript((v) => { try { localStorage.setItem('pgpt-pro-theme', v) } catch { /* opaque */ } }, t)
const rowOf = (page, m) => page.locator(`.row[data-id="${m.id}"]`)
const cardsIn = (loc) => loc.locator('[data-test="link-card"]')

// a teammate on the tenant team (GET /api/team adds the caller). (Another run's teardown on the same database takes every
// pro-rt-* account off the team: asked again right before the messenger is opened.)
const member = async (c) => { await c.get('/team'); return c }
async function room(a, b, db, cleanup) {
  const t = await a.post('/team/threads', { members: [b.id] })
  expect(t.status, t.text).toBe(200)
  cleanup(async () => {
    await db.q('delete from chats where id=$1', [t.body.id])
    await db.q('delete from pro_chat_reads where room_id=$1', [t.body.id])
    await db.q('delete from chat_rooms where id=$1', [t.body.id])
  })
  return t.body
}

test.describe('링크 미리보기 — 메시지의 링크를 카드로', () => {
  test('F-LP-01 AI 채팅: 내 말 · 에이전트 답의 링크에 카드(그림 · 제목 · 두 줄 설명 · 사이트 · 도메인), 코드 안 · 서명 링크는 없음, 누르면 새 탭(opener 없음)', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('lp-chat')
    const u = page.user
    const th = await db.clearMain(u.id)
    cleanup(() => db.clearMain(u.id))
    const [mine, answer, quiet, slow] = await db.addMessages(th, [
      { role: 'user', kind: 'text', content: { text: `오늘 회의 자료예요 ${SITE}/article 그리고 예시 코드는 \`${SITE}/in-code\` 입니다` } },
      { role: 'agent', kind: 'text', content: { text: `시연 영상은 [여기](${SITE}/video)에 있어요.\n\n\`\`\`\ncurl ${SITE}/in-block\n\`\`\`\n\n서명된 주소 ${SITE}/private-doc?token=abc123 는 열지 않아요.` } },
      { role: 'user', kind: 'text', content: { text: '링크 없는 메시지는 그대로예요.' } },
      { role: 'user', kind: 'text', content: { text: `느린 페이지 ${SITE}/slow?run=${RUN}` } },
    ])
    await theme(page, 'dark')
    await page.goto('/chat')
    // my message: the article's card under the bubble
    const card = cardsIn(rowOf(page, mine))
    await expect(card).toHaveCount(1)
    await expect(card.locator('[data-test="link-title"]')).toHaveText('달빛 커피 · 이번 주 원두 이야기')
    await expect(card.locator('[data-test="link-desc"]')).toContainText('에티오피아 예가체프와 콜롬비아 수프리모')
    await expect(card.locator('[data-test="link-site"]')).toHaveText('달빛 커피 블로그 · 127.0.0.1')
    await expect(card).toHaveAttribute('href', `${SITE}/article`)
    await expect(card).toHaveAttribute('target', '_blank')
    await expect(card).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(card).toHaveClass(/\btop\b/) // a wide picture (1200×630) goes on top
    // the description is held to two lines
    const lines = await card.locator('[data-test="link-desc"]').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))
    expect(lines).toBeLessThanOrEqual(2)
    // the agent's answer: only the video (the link in code and the signed link get none), with a play mark
    const video = cardsIn(rowOf(page, answer))
    await expect(video).toHaveCount(1)
    await expect(video).toHaveAttribute('data-kind', 'video')
    await expect(video.locator('[data-test="link-play"]')).toBeVisible()
    await expect(video.locator('[data-test="link-title"]')).toHaveText('제품 시연 영상 — 3분 둘러보기')
    // a message without a link is as it was
    await expect(rowOf(page, quiet).locator('[data-test="link-previews"]')).toHaveCount(0)
    await expect(rowOf(page, quiet).locator('.bubble.user')).toHaveText('링크 없는 메시지는 그대로예요.')
    // a slow page: the card's skeleton while it is read, then the card
    await expect(rowOf(page, slow).locator('[data-test="link-skeleton"]')).toBeVisible()
    await expect(cardsIn(rowOf(page, slow)).locator('[data-test="link-title"]')).toHaveText('늦게 오는 페이지', { timeout: 10_000 })
    expect(hits).not.toContain('/in-code')
    expect(hits).not.toContain('/in-block')
    expect(hits).not.toContain('/private-doc')
    await rowOf(page, mine).scrollIntoViewIfNeeded()
    await pictures(page.locator('body'))
    await shot(page, 'f-lp-01a-dark.png')
    // the video card: thumbnail on top with a play mark
    await video.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await pictures(page.locator('body'))
    await shot(page, 'f-lp-01c-video.png')
    // opens in a new tab, which cannot reach back to this one
    const [tab] = await Promise.all([page.context().waitForEvent('page'), card.click()])
    await tab.waitForLoadState()
    expect(tab.url()).toBe(`${SITE}/article`)
    expect(await tab.evaluate(() => window.opener)).toBeNull()
    await tab.close()
    // the light theme
    await page.evaluate(() => localStorage.setItem('pgpt-pro-theme', 'light'))
    await page.context().addInitScript(() => { try { localStorage.setItem('pgpt-pro-theme', 'light') } catch { /* opaque */ } })
    await page.reload()
    await expect(cardsIn(rowOf(page, mine))).toHaveCount(1)
    await rowOf(page, mine).scrollIntoViewIfNeeded()
    await pictures(page.locator('body'))
    await shot(page, 'f-lp-01b-light.png')
    expect(page.errors).toEqual([])
  })

  test('F-LP-02 팀 메신저: 동료의 메시지와 내 메시지의 링크에 카드 — 동료 것은 왼쪽, 내 것은 오른쪽', async ({ pageAs, as, db, cleanup }) => {
    const page = await pageAs('lp-me')
    const me = await member(page.user)
    const mate = await member(await as('lp-mate'))
    const t = await room(mate, me, db, cleanup)
    const theirs = (await mate.post(`/team/threads/${t.id}/messages`, { text: `견적 참고 자료예요 ${SITE}/article` })).body
    const mineMsg = (await me.post(`/team/threads/${t.id}/messages`, { text: `영상은 이거요 ${SITE}/video` })).body
    const plain = (await mate.post(`/team/threads/${t.id}/messages`, { text: '링크 없는 말은 그대로' })).body
    await theme(page, 'light')
    await page.goto('/chat')
    await member(me); await member(mate)
    await page.locator('button.msg-btn').click()
    await page.locator('.ms .tabs button', { hasText: '대화' }).click()
    await page.locator('.ms button.th').filter({ hasText: '회귀-lp-mate' }).first().click()
    const pane = page.locator('.ms .msgs')
    const cards = pane.locator('[data-test="link-card"]')
    await expect(cards).toHaveCount(2)
    const theirsCard = cards.filter({ hasText: '달빛 커피 · 이번 주 원두 이야기' })
    const mineCard = cards.filter({ hasText: '제품 시연 영상' })
    await expect(theirsCard).toHaveAttribute('href', `${SITE}/article`)
    await expect(mineCard).toHaveAttribute('data-kind', 'video')
    // sides follow the bubbles: the teammate's card starts past their avatar, mine ends at the right edge
    const paneBox = await pane.boundingBox()
    const tb = await theirsCard.boundingBox(), mb = await mineCard.boundingBox()
    const theirBubble = await pane.locator(`.msg[data-id="${theirs.id}"] .bub`).boundingBox()
    const myBubble = await pane.locator(`.msg[data-id="${mineMsg.id}"] .bub`).boundingBox()
    expect(Math.abs(tb.x - theirBubble.x)).toBeLessThan(4)
    expect(Math.abs((mb.x + mb.width) - (myBubble.x + myBubble.width))).toBeLessThan(4)
    expect(mb.x + mb.width).toBeLessThanOrEqual(paneBox.x + paneBox.width)
    await expect(pane.locator(`.msg[data-id="${plain.id}"]`)).toHaveText(/링크 없는 말은 그대로/)
    await pictures(pane)
    await shot(page, 'f-lp-02-messenger.png')
    expect(page.errors).toEqual([])
  })

  test('F-LP-03 휴대폰(390px): 카드는 세 개까지, 화면 너비 안 — 채팅 탭과 팀 메시지', async ({ pageAs, as, db, cleanup }) => {
    const page = await pageAs('lp-phone', { viewport: PHONE, touch: true })
    const u = await member(page.user)
    const th = await db.clearMain(u.id)
    cleanup(() => db.clearMain(u.id))
    const [m] = await db.addMessages(th, [
      { role: 'user', kind: 'text', content: { text: `자료 네 개요\n${SITE}/article\n${SITE}/small\n${SITE}/plain\n${SITE}/fourth` } },
    ])
    await theme(page, 'dark')
    await page.goto('/chat')
    await page.locator('.seg button').filter({ hasText: '채팅' }).click()
    const cards = cardsIn(rowOf(page, m))
    await expect(cards).toHaveCount(3)
    await expect(cards.nth(1)).not.toHaveClass(/\btop\b/) // a small square picture sits on the left
    await expect(cards.nth(2)).toHaveClass(/\bnoimg\b/)
    expect(hits).not.toContain('/fourth')
    for (let i = 0; i < 3; i++) {
      const b = await cards.nth(i).boundingBox()
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width)
    }
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
    await pictures(page.locator('body'))
    await shot(page, 'f-lp-03a-phone-chat.png')
    // the team messenger on the phone
    const mate = await member(await as('lp-phone-mate'))
    const t = await room(mate, u, db, cleanup)
    await mate.post(`/team/threads/${t.id}/messages`, { text: `이번 주 원두 ${SITE}/article` })
    await page.locator('.seg button').filter({ hasText: '홈' }).click()
    await member(u); await member(mate)
    await page.locator('button.msgs').click()
    await page.locator('.ms .tabs button', { hasText: '대화' }).click()
    await page.locator('.ms button.th').filter({ hasText: '회귀-lp-phone-mate' }).first().click()
    const card = page.locator('.ms .msgs [data-test="link-card"]')
    await expect(card).toHaveCount(1)
    const b = await card.boundingBox()
    expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width)
    await pictures(page.locator('.ms .msgs'))
    await shot(page, 'f-lp-03b-phone-messenger.png')
    expect(page.errors).toEqual([])
  })

  test('F-LP-04 서버: 서명 · 사내 주소는 열지 않고, 로그인해야 묻고, 회사 관리자가 끄면 카드가 없다(설정 › 시스템 설정의 스위치)', async ({ pageAs, as, db, cleanup }) => {
    const ask = (c, url) => c.get(`/link-preview?url=${encodeURIComponent(url)}`)
    const u = await as('lp-api')
    const ok = await ask(u, `${SITE}/small`)
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body.preview).toMatchObject({ title: '견적서 양식 안내', image: `${SITE}/square.svg`, siteName: '사내 양식 모음', domain: '127.0.0.1', kind: 'link' })
    const before = hits.length
    expect((await ask(u, `${SITE}/small?token=abc`)).body).toEqual({ preview: null, reason: 'signed' })
    expect((await ask(u, `${SITE}/small?X-Amz-Signature=abc`)).body).toEqual({ preview: null, reason: 'signed' })
    expect((await ask(u, 'http://10.0.0.1/admin')).body).toEqual({ preview: null, reason: 'private' })
    expect((await ask(u, 'http://169.254.169.254/latest/meta-data/')).body).toEqual({ preview: null, reason: 'private' })
    expect((await ask(u, 'http://deepagents:8888/')).body).toEqual({ preview: null, reason: 'private' })
    // the test allowance is one host:port — another port on the same address is not let through
    expect((await ask(u, `http://127.0.0.1:${PORT + 1}/article`)).body.preview).toBeNull()
    expect((await ask(u, 'ftp://example.com/x')).body).toEqual({ preview: null, reason: 'scheme' })
    expect(hits.length, '가짜 사이트에 요청이 가지 않았다').toBe(before)
    expect((await u.get('/link-preview')).status).toBe(400)
    const anon = await fetch(`${API_URL}/api/link-preview?url=${encodeURIComponent(`${SITE}/small`)}`)
    expect(anon.status).toBe(401)

    // the company switch: administrators only
    expect((await u.put('/admin/link-preview', { enabled: false })).status).toBe(403)
    const page = await pageAs('lp-admin')
    const admin = page.user
    await db.q('update users set is_admin=true where id=$1 and tenant_id=$2', [admin.id, db.tenant])
    // (back on through the server, so its remembered setting is on too; then the row goes — no row is the default, on)
    cleanup(async () => {
      await admin.put('/admin/link-preview', { enabled: true }).catch(() => {})
      await db.q('delete from pro_link_preview_settings where tenant_id=$1', [db.tenant])
      await db.q('update users set is_admin=false where id=$1 and tenant_id=$2', [admin.id, db.tenant])
    })
    expect((await admin.put('/admin/link-preview', { enabled: 'no' })).status).toBe(400)
    const off = await admin.put('/admin/link-preview', { enabled: false })
    expect(off.status, off.text).toBe(200)
    expect(off.body).toEqual({ enabled: false })
    expect((await u.get('/me')).body.features.linkPreview).toBe(false)
    expect((await ask(u, `${SITE}/article`)).body).toEqual({ preview: null, reason: 'off' })
    // off: no card on anyone's screen
    const th = await db.clearMain(admin.id)
    cleanup(() => db.clearMain(admin.id))
    const [m] = await db.addMessages(th, [{ role: 'user', kind: 'text', content: { text: `꺼 두면 카드 없음 ${SITE}/article` } }])
    await theme(page, 'light')
    await page.goto('/chat')
    await expect(rowOf(page, m).locator('.bubble.user')).toBeVisible()
    await page.waitForTimeout(800)
    await expect(rowOf(page, m).locator('[data-test="link-previews"]')).toHaveCount(0)
    // Settings › 시스템 설정: the switch turns it back on
    await page.goto('/settings/system')
    const sw = page.locator('[data-test="link-preview-switch"]')
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.scrollIntoViewIfNeeded()
    await shot(page, 'f-lp-04a-switch-off.png')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    expect((await admin.get('/me')).body.features.linkPreview).toBe(true)
    expect((await ask(u, `${SITE}/article`)).body.preview.title).toBe('달빛 커피 · 이번 주 원두 이야기')
    await shot(page, 'f-lp-04b-switch-on.png')
    await page.goto('/chat')
    await expect(cardsIn(rowOf(page, m))).toHaveCount(1)
    expect(page.errors).toEqual([])
  })
  test('F-LP-05 카드를 다는 링크(화면의 규칙): 처음 세 개 · 같은 링크는 하나 · 코드 안 · 이 앱 · 파일은 빼고, 주소 뒤에 붙여 쓴 한국어는 떼어 낸다', () => {
    const here = { hostname: 'acme.process-gpt.io' }
    expect(linksIn('자료 https://a.example.com/x?b=1 확인', { here })).toEqual(['https://a.example.com/x?b=1'])
    expect(linksIn('https://a.example.com에서 보세요 · https://b.example.co.kr을 참고', { here })).toEqual(['https://a.example.com', 'https://b.example.co.kr'])
    expect(linksIn('나무위키 https://namu.wiki/w/서울', { here })).toEqual(['https://namu.wiki/w/서울'])
    expect(linksIn('```\nhttps://code.example.com\n```\n`https://inline.example.com` 그리고 https://real.example.com', { here })).toEqual(['https://real.example.com'])
    expect(linksIn('[문서](https://md.example.com/p) <https://angle.example.com> www.bare.example.com', { here })).toEqual(['https://md.example.com/p', 'https://angle.example.com', 'http://www.bare.example.com'])
    expect(linksIn('https://a.example.com https://a.example.com#top https://b.example.com https://c.example.com https://d.example.com', { here })).toEqual(['https://a.example.com', 'https://b.example.com', 'https://c.example.com'])
    expect(linksIn('https://acme.process-gpt.io/lite/chat https://x.supabase.co/storage/v1/object/public/f/a.png https://files.example.com/견적서.xlsx https://files.example.com/report.pdf', { here })).toEqual([])
    expect(linksIn('링크 없는 말', { here })).toEqual([])
    expect(linksIn('ftp://files.example.com/a', { here })).toEqual([])
  })
})
