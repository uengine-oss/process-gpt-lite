// 보낸 말이 사라지지 않는다 (2026-11-27 07:03 녹화 「여기 입력 날라가냐」 · 「지금 입력한게 왜 날라갔지」 — 운영 배포가 서버를 다시 켜는 1~4분
// 동안 보낸 메시지가 게이트웨이의 502 를 받았고, 화면은 그것을 빈 응답으로 읽어 입력창을 비운 채 아무 말도 하지 않았다). 스펙 chat-thread-list
// 「서버가 받지 못한 메시지」. 서버가 받지 못한 메시지(502 · 503 · 504 · 연결 없음)는 입력창 위에 「다시 보내는 중」을 보이며 몇 분 동안 다시
// 보내고, 그 밖의 거절은 까닭과 함께 말을 입력창에 돌려준다. 「그만두기」는 말을 돌려받고 더 보내지 않는다.
// 서버는 이 시험의 page.route 로 대신한다(실제 서버에는 요청이 가지 않는다). 시험 계정의 메인 채팅만 쓴다.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../../lib/fixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../../openspec/specs/chat-thread-list/e2e/results')
const PHONE = { width: 390, height: 844 }
const BAD_GATEWAY = '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>502</body></html>'
const shot = async (page, name) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}
const box = (page) => page.locator('.composer textarea').first()
const issue = (page) => page.locator('[data-test="send-issue"]')
// POST /threads/:id/messages answered by `answer(n)` for the n-th send (0-based); anything else goes on to the server
async function routeSends(page, answer) {
  const sent = []
  await page.route('**/api/threads/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const n = sent.length
    sent.push(route.request().postDataJSON())
    await route.fulfill(answer(n))
  })
  return sent
}
const ok = { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' }

test.describe('보낸 말이 사라지지 않는다 — 서버가 받지 못하면 다시 보내거나 입력창에 돌려준다 (spec chat-thread-list)', () => {
  test('F-SR-01 서버가 다시 켜지는 동안(502 두 번): 「다시 보내는 중 · N번째」가 보이고, 켜지면 한 번 보내진다', async ({ pageAs, db }) => {
    const page = await pageAs('sr-retry', { viewport: PHONE, touch: true })
    await db.clearMain(page.user.id)
    const sent = await routeSends(page, (n) => (n < 2 ? { status: 502, headers: { 'Content-Type': 'text/html' }, body: BAD_GATEWAY } : ok))
    await page.goto('/chat')
    await box(page).fill('여기에 내가 url 을 붙이면 노트북 lm 으로 팟캐스트를 만들어 줘')
    await page.keyboard.press('Enter')
    await expect(issue(page)).toHaveAttribute('data-state', 'retrying')
    await expect(issue(page)).toContainText('서버가 잠시 응답하지 않아 다시 보내는 중이에요')
    await expect(issue(page)).toContainText('「여기에 내가 url 을 붙이면 노트북 lm 으로 팟캐스트를 만들어 줘」')
    await shot(page, 'f-sr-01a-retrying-phone')
    await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(3)
    await expect(issue(page)).toHaveCount(0)
    expect(new Set(sent.map((x) => x.text))).toEqual(new Set(['여기에 내가 url 을 붙이면 노트북 lm 으로 팟캐스트를 만들어 줘']))
    expect(await noOverflow(page)).toBe(true)
    expect(page.errors).toEqual([])
  })

  test('F-SR-02 그 밖의 거절(400): 까닭과 함께 말이 입력창에 돌아온다 — 다시 보내지 않는다', async ({ pageAs, db }) => {
    const page = await pageAs('sr-refused')
    await db.clearMain(page.user.id)
    const sent = await routeSends(page, () => ({ status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '보낼 말이나 파일이 없어요.' }) }))
    await page.goto('/chat')
    await box(page).fill('이 링크로 슬라이드 만들어 줘')
    await page.keyboard.press('Enter')
    await expect(issue(page)).toHaveAttribute('data-state', 'failed')
    await expect(issue(page)).toContainText('보내지 못했어요 — 보낼 말이나 파일이 없어요.')
    await expect(issue(page)).toContainText('입력창에 다시 넣어 두었어요')
    await expect(box(page)).toHaveValue('이 링크로 슬라이드 만들어 줘')
    await shot(page, 'f-sr-02-refused-text-back')
    await page.waitForTimeout(3000)
    expect(sent.length).toBe(1)
    await issue(page).locator('[data-test="send-issue-close"]').click()
    await expect(issue(page)).toHaveCount(0)
    expect(page.errors).toEqual([])
  })

  test('F-SR-03 다시 보내는 중에 「그만두기」: 말이 입력창에 돌아오고 더 보내지 않는다', async ({ pageAs, db }) => {
    const page = await pageAs('sr-takeback')
    await db.clearMain(page.user.id)
    const sent = await routeSends(page, () => ({ status: 503, headers: { 'Content-Type': 'text/html' }, body: '' }))
    await page.goto('/chat')
    await box(page).fill('회의록 정리해 줘')
    await page.keyboard.press('Enter')
    await expect(issue(page)).toHaveAttribute('data-state', 'retrying')
    await issue(page).locator('[data-test="send-issue-close"]').click()
    await expect(box(page)).toHaveValue('회의록 정리해 줘')
    await expect(issue(page)).toHaveCount(0)
    const n = sent.length
    await page.waitForTimeout(6000)
    expect(sent.length).toBe(n)
    expect(page.errors).toEqual([])
  })

  test('F-SR-04 연결이 끊긴 채(요청이 서버에 닿지 않음)도 다시 보낸다 — 그 사이 서버에 이미 들어간 같은 말이면 보내지 않는다', async ({ pageAs, db }) => {
    const page = await pageAs('sr-offline')
    const main = await db.clearMain(page.user.id)
    let first = true
    const sent = []
    await page.route('**/api/threads/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      sent.push(route.request().postDataJSON())
      // the line breaks, but the message reached the server: it is in the room
      if (first) {
        first = false
        await db.q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'user','text',$2)`, [main, { text: '견적서 초안 만들어 줘' }])
        return route.abort('connectionreset')
      }
      return route.fulfill(ok)
    })
    await page.goto('/chat')
    await box(page).fill('견적서 초안 만들어 줘')
    await page.keyboard.press('Enter')
    await expect(issue(page)).toHaveAttribute('data-state', 'retrying')
    await expect(issue(page)).toHaveCount(0, { timeout: 20_000 })
    expect(sent.length).toBe(1)
    expect(page.errors).toEqual([])
  })
})

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
