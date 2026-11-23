// 휴대폰 화면(2026-11-23, 운영) — 텔레그램 카드에 토큰을 넣고 「연결」을 누르면 카드에 Cloudflare 오류 화면의 HTML 이
// 그대로 찍혔다. 운영 서버가 텔레그램 Bot API 에 닿지 못해 502 를 돌려주고, Cloudflare 가 그 502 를 자기 HTML 쪽으로
// 바꿔 끼웠기 때문이다. 고친 뒤: 서버는 503 + 이유(오류 코드 · 호스트), 화면은 HTML 대신 읽을 수 있는 문장.
// 이 묶음의 서버는 PRO_TELEGRAM_API 를 아무도 듣지 않는 포트(예: http://127.0.0.1:59999)로 띄운다 — F-TG-02 가 그 길을 본다.
// (9 같은 포트는 fetch 가 스스로 막아 「bad port」가 된다)
import { test, expect } from '../../lib/fixtures.js'

const PHONE = { width: 390, height: 844 }
const TOKEN = '700000002:AAtestTokenForLiteTelegram_unreach1' // 35 characters after the colon, as BotFather's
// the page Cloudflare put in place of the server's 502 (the start of it, as the card showed)
const CF_502 = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->
<!--[if IE 8]>    <html class="no-js ie8 oldie" lang="en-US"> <![endif]-->
<!--[if gt IE 8]><!--> <html class="no-js" lang="en-US"> <!--<![endif]-->
<head><title>process-gpt.io | 502: Bad gateway</title></head><body>Bad gateway Error code 502</body></html>`

async function cardIn(pageAs, db, area) {
  const page = await pageAs(area, { viewport: PHONE })
  const main = await db.clearMain(page.user.id)
  await db.addMessages(main, [
    { role: 'user', kind: 'text', content: { text: '주식 급등락 상황에서 텔레그램으로 노티를 주더록 설정' } },
    { role: 'agent', kind: 'text', content: { text: '내 텔레그램 봇을 연결해 볼게요. 아래 카드 순서대로 하면 1분이면 돼요.' } },
    { role: 'agent', kind: 'telegram_connect', content: { scheduleId: null, scheduleName: '' } },
  ])
  await page.goto('/chat')
  await page.locator('.seg button').filter({ hasText: '채팅' }).click()
  const card = page.locator('[data-test="tg-card"]').last()
  await expect(card).toBeVisible()
  await card.locator('[data-test="tg-token"]').fill(TOKEN)
  return { page, card }
}

test.describe('텔레그램 연결 — 서버가 텔레그램에 닿지 못할 때', () => {
  test('F-TG-01 앞단(Cloudflare)이 HTML 오류 쪽을 돌려줘도 카드에는 HTML 이 아니라 읽을 수 있는 문장', async ({ pageAs, db }) => {
    const { page, card } = await cardIn(pageAs, db, 'tg-cf502')
    await page.route('**/api/telegram/connect', (r) => r.fulfill({ status: 502, contentType: 'text/html; charset=UTF-8', body: CF_502 }))
    await card.locator('[data-test="tg-connect"]').click()
    const err = card.locator('.err')
    await expect(err).toHaveText('서버가 응답하지 못했어요 (502). 잠시 후 다시 시도해 주세요.')
    await expect(card).not.toContainText('DOCTYPE')
    await expect(card).not.toContainText('<html')
    await page.screenshot({ path: test.info().outputPath('f-tg-01.png') })
  })

  test('F-TG-02 서버가 텔레그램에 닿지 못하면 503 과 이유(오류 코드)를 받고, 카드가 그 이유를 보여 준다 · 토큰은 어디에도 없다', async ({ pageAs, db }) => {
    const { page, card } = await cardIn(pageAs, db, 'tg-unreach')
    const answer = page.waitForResponse((r) => r.url().includes('/api/telegram/connect'))
    await card.locator('[data-test="tg-connect"]').click()
    const res = await answer
    expect(res.status(), '502 면 Cloudflare 가 자기 HTML 로 바꾼다').toBe(503)
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.code).toBe('telegram_unreachable')
    expect(body.detail).toMatch(/^ECONNREFUSED 127\.0\.0\.1:\d+$/) // 오류 코드와 호스트뿐
    expect(text).not.toContain(TOKEN.split(':')[1])
    const err = card.locator('.err')
    await expect(err).toContainText('이 서버에서 텔레그램에 연결하지 못했어요')
    await expect(err).toContainText(body.detail)
    await expect(card).not.toContainText('DOCTYPE')
    // the card stays where it was: the token can be sent again once the server can reach Telegram
    await expect(card.locator('[data-test="tg-connect"]')).toBeEnabled()
    await page.screenshot({ path: test.info().outputPath('f-tg-02.png') })
  })
})
