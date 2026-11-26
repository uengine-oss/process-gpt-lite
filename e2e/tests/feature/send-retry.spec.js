// 보낸 말이 사라지지 않는다 (2026-11-27 07:03 녹화 「여기 입력 날라가냐」 · 「지금 입력한게 왜 날라갔지」 — 운영 배포가 서버를 다시 켜는 1~4분
// 동안 보낸 메시지가 게이트웨이의 502 를 받았고, 화면은 그것을 빈 응답으로 읽어 입력창을 비운 채 아무 말도 하지 않았다). 스펙 chat-thread-list
// 「서버가 받지 못한 메시지」. 메시지마다 이름(clientId)을 붙여 보내고 서버는 한 이름을 한 번만 받는다. 서버가 잠시 없으면(502 · 503 · 504 ·
// 연결 없음) 입력창 위 줄이 「다시 보내는 중 · N번째」를 말하며 다시 보내고, 받는 순간 줄이 사라진다. 그 밖에는 메시지를 남겨 두고(이 브라우저에도),
// 같은 대화의 빈 입력창이면 말을 돌려준다 — 말이 있는 입력창은 덮지 않는다.
// 화면 쪽 시험은 서버 응답을 page.route 로 대신하고, F-SR-08 만 실제 서버(이름을 한 번만 받는지)에 대고 돈다.
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
const line = (page) => page.locator('[data-test="send-issue"]')
const note = (page) => page.locator('[data-test="send-back-note"]')
const ok = { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' }
const gone = { status: 502, headers: { 'Content-Type': 'text/html' }, body: BAD_GATEWAY }
// POST /threads/:id/messages answered by `answer(n, body)` for the n-th send (0-based); anything else goes on to the server
async function routeSends(page, answer) {
  const sent = []
  await page.route('**/api/threads/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = route.request().postDataJSON()
    sent.push(body)
    const a = await answer(sent.length - 1, body)
    if (a === 'abort') return route.abort('connectionrefused')
    await route.fulfill(a)
  })
  return sent
}
const send = async (page, words) => { await box(page).fill(words); await page.keyboard.press('Enter') }

test.describe('보낸 말이 사라지지 않는다 — 서버가 받지 못한 메시지 (spec chat-thread-list)', () => {
  test('F-SR-01 서버가 다시 켜지는 동안(502 두 번 · 연결 없음 한 번): 「다시 보내는 중 · N번째」 → 켜지면 받고 줄이 사라진다, 같은 이름으로만 보낸다', async ({ pageAs, db }) => {
    const page = await pageAs('sr-retry', { viewport: PHONE, touch: true })
    await db.clearMain(page.user.id)
    const sent = await routeSends(page, (n) => (n < 2 ? gone : n === 2 ? 'abort' : ok))
    await page.goto('/chat')
    await send(page, '여기에 내가 url 을 붙이면 노트북 lm 으로 팟캐스트를 만들어 줘')
    await expect(line(page)).toHaveAttribute('data-state', 'retrying')
    await expect(line(page)).toContainText('서버가 잠시 응답하지 않아 다시 보내는 중이에요')
    await expect(line(page)).toContainText('「여기에 내가 url 을 붙이면 노트북 lm 으로 팟캐스트를 만들어 줘」')
    await shot(page, 'f-sr-01a-retrying-phone')
    await expect.poll(() => sent.length, { timeout: 40_000 }).toBe(4)
    await expect(line(page)).toHaveCount(0)
    expect(new Set(sent.map((x) => x.clientId)).size).toBe(1)
    expect(sent[0].clientId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    expect(page.errors).toEqual([])
  })

  test('F-SR-02 그 밖의 거절(400) · 빈 입력창: 까닭과 함께 말이 돌아온다 — 다시 보내지 않는다', async ({ pageAs, db }) => {
    const page = await pageAs('sr-refused')
    await db.clearMain(page.user.id)
    const sent = await routeSends(page, () => ({ status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '보낼 말이나 파일이 없어요.' }) }))
    await page.goto('/chat')
    await send(page, '이 링크로 슬라이드 만들어 줘')
    await expect(note(page)).toContainText('보낼 말이나 파일이 없어요. · 입력창에 다시 넣어 두었어요')
    await expect(box(page)).toHaveValue('이 링크로 슬라이드 만들어 줘')
    await expect(line(page)).toHaveCount(0)
    await shot(page, 'f-sr-02-refused-text-back')
    await page.waitForTimeout(3000)
    expect(sent.length).toBe(1)
    expect(page.errors).toEqual([])
  })

  test('F-SR-03 다시 보내는 중에 「그만두기」: 말이 입력창에 돌아오고 더 보내지 않는다', async ({ pageAs, db }) => {
    const page = await pageAs('sr-takeback')
    await db.clearMain(page.user.id)
    const sent = await routeSends(page, () => ({ status: 503, headers: { 'Content-Type': 'text/html' }, body: '' }))
    await page.goto('/chat')
    await send(page, '회의록 정리해 줘')
    await expect(line(page)).toHaveAttribute('data-state', 'retrying')
    await line(page).locator('[data-test="send-issue-close"]').click()
    await expect(box(page)).toHaveValue('회의록 정리해 줘')
    await expect(line(page)).toHaveCount(0)
    const n = sent.length
    await page.waitForTimeout(6000)
    expect(sent.length).toBe(n)
    // sent again unchanged, the words keep their name (the server may have the first one already)
    await page.keyboard.press('Enter')
    await expect.poll(() => sent.length).toBe(n + 1)
    expect(sent.at(-1).clientId).toBe(sent[0].clientId)
    expect(page.errors).toEqual([])
  })

  test('F-SR-04 말이 있는 입력창은 덮지 않는다: 거절된 메시지는 줄에 남고(다시 보내기 · 입력창에 넣기 · 지우기), 넣으면 뒤에 붙는다', async ({ pageAs, db }) => {
    const page = await pageAs('sr-busybox')
    await db.clearMain(page.user.id)
    let refuse = true
    const sent = await routeSends(page, () => (refuse ? { status: 409, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '잠시 뒤에 다시 보내 주세요.' }) } : ok))
    // (the answer is held until the box has new words: the refusal lands on a box being written in)
    let release = () => {}
    let held = Promise.resolve()
    const hold = () => { held = new Promise((r) => { release = r }) }
    await page.route('**/api/threads/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      await held
      return route.fallback()
    })
    hold()
    await page.goto('/chat')
    await send(page, '첫 번째 부탁')
    await box(page).fill('쓰는 중인 다음 말')
    release()
    const l = line(page)
    await expect(l).toHaveAttribute('data-state', 'failed')
    await expect(l).toContainText('보내지 못했어요 — 잠시 뒤에 다시 보내 주세요.')
    await expect(l).toContainText('「첫 번째 부탁」')
    await expect(box(page)).toHaveValue('쓰는 중인 다음 말')
    await shot(page, 'f-sr-04a-kept-line')
    await l.locator('[data-test="send-issue-take"]').click()
    await expect(box(page)).toHaveValue('쓰는 중인 다음 말\n첫 번째 부탁')
    await expect(line(page)).toHaveCount(0)
    // 다시 보내기: the same name again
    await box(page).fill('')
    refuse = true
    hold()
    await send(page, '두 번째 부탁')
    await box(page).fill('또 쓰는 말')
    release()
    await expect(line(page)).toHaveAttribute('data-state', 'failed')
    refuse = false
    await line(page).locator('[data-test="send-issue-retry"]').click()
    await expect(line(page)).toHaveCount(0)
    const second = sent.filter((x) => x.text === '두 번째 부탁')
    expect(second.length).toBe(2)
    expect(second[0].clientId).toBe(second[1].clientId)
    expect(page.errors).toEqual([])
  })

  test('F-SR-05 서버가 받은 뒤 끊긴 답은 다시 보내지 않는다(받는 순간 줄도 없음)', async ({ pageAs, db }) => {
    const page = await pageAs('sr-accepted')
    await db.clearMain(page.user.id)
    // taken (an event stream began), then the line breaks before any event
    const sent = await routeSends(page, () => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: ': ok\n\n' }))
    await page.goto('/chat')
    await send(page, '보고서 요약해 줘')
    await page.waitForTimeout(5000)
    expect(sent.length).toBe(1)
    await expect(line(page)).toHaveCount(0)
    await expect(box(page)).toHaveValue('')
    expect(page.errors).toEqual([])
  })

  test('F-SR-06 다시 고침(새로 고침)해도 남는다: 이 브라우저에 남은 메시지를 이어서 보낸다 — 같은 이름', async ({ pageAs, db }) => {
    const page = await pageAs('sr-reload')
    await db.clearMain(page.user.id)
    let up = false
    const sent = await routeSends(page, () => (up ? ok : gone))
    await page.goto('/chat')
    await send(page, '새 버전이 떠도 사라지면 안 되는 말')
    await expect(line(page)).toHaveAttribute('data-state', 'retrying')
    await page.reload()
    await expect(line(page)).toContainText('「새 버전이 떠도 사라지면 안 되는 말」')
    up = true
    await expect(line(page)).toHaveCount(0, { timeout: 30_000 })
    expect(new Set(sent.map((x) => x.clientId)).size).toBe(1)
    expect(sent.at(-1).text).toBe('새 버전이 떠도 사라지면 안 되는 말')
    expect(page.errors).toEqual([])
  })

  test('F-SR-07 정한 시간(시험에선 4초)이 지나도 서버가 없으면 멈추고 말을 돌려준다 · 순서대로 하나씩(뒤의 말은 「앞의 메시지를 보낸 뒤」)', async ({ pageAs, db }) => {
    const page = await pageAs('sr-window')
    await page.addInitScript(() => { window.__PGL_SEND_RETRY_MS__ = 4000 })
    await db.clearMain(page.user.id)
    const sent = await routeSends(page, () => gone)
    await page.goto('/chat')
    await send(page, '첫 말')
    await expect(line(page)).toHaveAttribute('data-state', 'retrying')
    await send(page, '둘째 말')
    await expect(page.locator('[data-test="send-issue"][data-state="waiting"]')).toContainText('앞의 메시지를 보낸 뒤 보내요')
    await shot(page, 'f-sr-07a-in-order')
    // both give up after the window: the first comes back into the empty box, the second stays on its line
    await expect(note(page)).toContainText('입력창에 다시 넣어 두었어요', { timeout: 30_000 })
    await expect(box(page)).toHaveValue('첫 말')
    await expect(page.locator('[data-test="send-issue"][data-state="failed"]')).toContainText('「둘째 말」', { timeout: 30_000 })
    // never out of order: no try of the second before the first stopped
    const firstLast = sent.map((x) => x.text).lastIndexOf('첫 말')
    expect(sent.slice(0, firstLast).some((x) => x.text === '둘째 말')).toBe(false)
    expect(page.errors).toEqual([])
  })

  test('F-SR-09 첫 시도가 걸려 있는 동안 새로 고쳐도 남는다 — 다음 시작에 같은 이름으로 보낸다', async ({ pageAs, db }) => {
    const page = await pageAs('sr-firsttry')
    await db.clearMain(page.user.id)
    let hold = true
    const sent = []
    await page.route('**/api/threads/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      sent.push(route.request().postDataJSON())
      // the first try hangs (a gateway that has not given up yet): no answer at all
      if (hold) return
      await route.fulfill(ok)
    })
    await page.goto('/chat')
    await send(page, '걸린 채 새로 고친 말')
    await expect.poll(() => sent.length).toBe(1)
    await expect(line(page)).toHaveCount(0)
    hold = false
    await page.reload()
    await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(2)
    await expect(line(page)).toHaveCount(0, { timeout: 30_000 })
    expect(sent[1].clientId).toBe(sent[0].clientId)
    expect(sent[1].text).toBe('걸린 채 새로 고친 말')
    expect(page.errors).toEqual([])
  })

  test('F-SR-08 실제 서버: 같은 이름으로 두 번(이어서 · 동시에) 보내도 메시지는 하나', async ({ as, db }) => {
    const u = await as('sr-server')
    const main = await db.clearMain(u.id)
    const id = `sr${Date.now().toString(36)}abcd`
    const body = { text: '한 번만 들어가야 하는 말', clientId: id }
    await u.post(`/threads/${main}/messages`, body)
    await u.post(`/threads/${main}/messages`, body)
    const id2 = `sr${Date.now().toString(36)}efgh`
    await Promise.all([u.post(`/threads/${main}/messages`, { ...body, clientId: id2 }), u.post(`/threads/${main}/messages`, { ...body, clientId: id2 })])
    const rows = await db.q(`select content->>'clientId' as c from pro_messages where thread_id=$1 and role='user' and content->>'text'=$2`, [main, body.text])
    expect(rows.map((r) => r.c).sort()).toEqual([id, id2].sort())
  })
})
