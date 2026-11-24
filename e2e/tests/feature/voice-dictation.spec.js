// 채팅 입력창의 받아쓰기(2026-11-24 사용자: 「채팅 입력 부분의 음성입력 부분이 누른상태면 계속 입력 받는걸로 해.. 목소리 끊겼다고 자동
// 발송하지말고..」). 전에는 첫 쉼에서 인식이 끝났고, 마이크 자리에 보내기(↑)가 들어와 이어 말하려고 다시 누르면 보내졌다. 이제 마이크는
// 늘 맨 끝 자리 그대로이고 보내기는 그 옆에 온다. 켜면 사람이 끌 때까지(쉼 뒤에도) 듣고, 짧게 누르면 켜고 끄기 · 길게 누르면 누르는
// 동안만, 보내기 단추나 Enter 전에는 아무것도 보내지 않는다. 브라우저의 음성 인식은 addInitScript 의 가짜(중간 · 확정 결과, 쉼, 오류)로
// 바꾸고, 보내기는 가로채서 센다. 모델 · 마이크 없음. 순수 규칙(합치기 · 다시 시작 · 누르기 · 오류)은 server/test/dictation.test.js.
// 화면 사진: e2e/reports/voice-dictation/ (RT_SHOTS 로 바꿈)
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../../lib/fixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = process.env.RT_SHOTS || path.resolve(here, '../../reports/voice-dictation')
fs.mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
// Playwright's own Chromium (never a person's Chrome)
test.use({ channel: 'chromium' })

// the browser's speech recognition, replaced: __sr.say(text, final) — a result to the session listening now (a phrase still being
// heard is replaced, like Chrome's list); __sr.pause() — Chrome after a silence (no-speech, then end); __sr.fail(code) — an error, then
// end. stop() ends the session a moment later, abort() at once. Counts: made · starts · stops · aborts.
function fakeSpeech(mode) {
  if (window.top !== window) return
  if (mode === 'none') { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; return }
  const ctl = { made: [], starts: 0, stops: 0, aborts: 0 }
  class FakeRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.results = []; this.running = false; ctl.made.push(this) }
    start() {
      if (this.running) throw new DOMException('already started', 'InvalidStateError')
      this.running = true; ctl.starts++
      setTimeout(() => { if (this.running) this.onstart?.(new Event('start')) }, 20)
    }
    stop() { ctl.stops++; setTimeout(() => this._end(), 40) }
    abort() { ctl.aborts++; if (this.running) { this.running = false; setTimeout(() => this.onend?.(new Event('end')), 0) } }
    _end() { if (!this.running) return; this.running = false; this.onend?.(new Event('end')) }
  }
  const now = () => ctl.made.filter((r) => r.running).at(-1)
  ctl.say = (transcript, final = false) => {
    const r = now()
    if (!r) return false
    const res = Object.assign([{ transcript, confidence: 0.9 }], { isFinal: final })
    const last = r.results.length - 1
    if (last >= 0 && !r.results[last].isFinal) r.results[last] = res
    else r.results.push(res)
    r.onresult?.({ results: r.results, resultIndex: Math.max(0, last) })
    return true
  }
  ctl.pause = () => { const r = now(); if (!r) return false; r.onerror?.({ error: 'no-speech' }); r._end(); return true }
  ctl.fail = (code) => { const r = now(); if (!r) return false; r.onerror?.({ error: code }); r._end(); return true }
  ctl.listening = () => !!now()
  window.__sr = ctl
  window.SpeechRecognition = FakeRecognition
  window.webkitSpeechRecognition = FakeRecognition
}

// the chat, its composer, and every message send counted (answered with an empty stream — no agent)
async function open(page, { mode = 'fake', theme, phone = false } = {}) {
  await page.context().addInitScript(fakeSpeech, mode)
  if (theme) await page.context().addInitScript((t) => { try { localStorage.setItem('pgpt-pro-theme', t) } catch { /* ignore */ } }, theme)
  const sent = []
  await page.route('**/api/threads/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    sent.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' })
  })
  // (?hour=13: the daytime sky, the same in every picture)
  await page.goto('/chat?hour=13')
  // a phone opens on Home: 채팅
  if (phone) await page.locator('.seg button[data-tab="chat"]').tap()
  const c = page.locator('.col .foot .composer').first()
  await expect(c.locator('textarea')).toBeVisible({ timeout: 30_000 })
  return {
    sent, c,
    ta: c.locator('textarea'),
    mic: c.getByTestId('composer-mic'),
    send: c.getByRole('button', { name: '보내기', exact: true }),
    status: c.getByTestId('dictation-status'),
    sr: (expr) => page.evaluate(expr),
  }
}
const say = (page, t, final = false) => page.evaluate(([t, f]) => window.__sr.say(t, f), [t, final])
const box = async (l) => { const b = await l.boundingBox(); return b && { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
// where a button is: its centre (a pressed button is scaled to .96 around it — .press:active, which a touch leaves on for a while)
const spot = async (l) => { const b = await l.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
const samePlace = (a, b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const settled = (page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
async function shot(page, name) { await settled(page); await page.screenshot({ path: path.join(SHOTS, name) }) }
// a finger on the screen (Chrome's own touch events → pointer events with pointerType touch)
async function touchHold(page, loc, ms) {
  const b = await loc.boundingBox()
  const cdp = await page.context().newCDPSession(page)
  const pt = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
  await page.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

test.describe('채팅 입력창 받아쓰기 — 누른 상태면 계속 듣고, 저절로 보내지 않는다', () => {
  test('F-VD-01 누르면 켜짐: 「듣는 중…」, 말이 들어와도 마이크는 그 자리 그대로(보내기는 옆에), 「받아쓰기 멈추기」', async ({ pageAs }) => {
    const page = await pageAs('vd-user')
    const { sent, ta, mic, send, status, c } = await open(page, { theme: 'light' })
    await expect(mic).toBeVisible()
    await expect(send).toHaveCount(0)
    const before = await box(mic)
    const at = await spot(mic)
    await mic.click()
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await expect(mic).toHaveAttribute('aria-label', '받아쓰기 멈추기')
    await expect(status).toHaveText('듣는 중…')
    await expect(ta).toHaveAttribute('placeholder', '듣는 중… 말하면 여기에 적혀요')
    const lit = await page.evaluate(() => ({ cont: window.__sr.made[0].continuous, interim: window.__sr.made[0].interimResults, lang: window.__sr.made[0].lang }))
    expect(lit).toEqual({ cont: true, interim: true, lang: 'ko-KR' })
    // the first words: the send button comes in beside the mic — the mic does not move, nothing is sent
    await say(page, '회의록 정리')
    await expect(ta).toHaveValue('회의록 정리')
    await expect(send).toBeVisible()
    await expect(mic).toBeVisible()
    expect(samePlace(await spot(mic), at)).toBe(true)
    const s = await box(send)
    expect(overlaps(s, await box(mic))).toBe(false)
    expect(s.x + s.w).toBeLessThanOrEqual(before.x)
    // who answers (PR #41 — in the box on a wide screen) stays clear of both
    const chip = c.locator('.box [data-test="chat-agent"]')
    if (await chip.count()) {
      const cb = await box(chip)
      expect(overlaps(cb, s)).toBe(false)
      expect(overlaps(cb, await box(mic))).toBe(false)
    }
    await say(page, '회의록 정리해 줘', true)
    await say(page, ' 그리고 메일로')
    await expect(ta).toHaveValue('회의록 정리해 줘 그리고 메일로')
    expect(samePlace(await spot(mic), at)).toBe(true)
    await shot(page, 'vd01-listening-desk.png')
    await page.waitForTimeout(600)
    expect(sent).toEqual([])
    expect(page.errors).toEqual([])
  })

  test('F-VD-02 말이 끊겨도(쉼 · 세션 끝) 꺼지지 않고 보내지 않는다 — 다음 세션이 이어서 받아 적는다', async ({ pageAs }) => {
    const page = await pageAs('vd-user')
    const { sent, ta, mic, status } = await open(page)
    await mic.click()
    await expect(status).toHaveText('듣는 중…')
    await say(page, '내일 회의는', true)
    // Chrome after a silence: no-speech, then the session ends — the old code turned off here
    await page.evaluate(() => window.__sr.pause())
    await expect.poll(() => page.evaluate(() => window.__sr.starts)).toBe(2)
    await expect.poll(() => page.evaluate(() => window.__sr.listening())).toBe(true)
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await expect(status).toHaveText('듣는 중…')
    await expect(ta).toHaveValue('내일 회의는')
    await say(page, ' 열 시에 3층에서', true)
    await expect(ta).toHaveValue('내일 회의는 열 시에 3층에서')
    // another pause with a phrase still being heard: it stays, the next session goes on after it
    await say(page, ' 해요')
    await page.evaluate(() => window.__sr.pause())
    await expect.poll(() => page.evaluate(() => window.__sr.starts)).toBe(3)
    await expect.poll(() => page.evaluate(() => window.__sr.listening())).toBe(true)
    await say(page, ' 자료는 제가 준비할게요', true)
    await expect(ta).toHaveValue('내일 회의는 열 시에 3층에서 해요 자료는 제가 준비할게요')
    await page.waitForTimeout(800)
    expect(sent).toEqual([])
    await shot(page, 'vd02-after-pauses.png')
    expect(page.errors).toEqual([])
  })

  test('F-VD-03 마이크를 다시 누르면 멈춤, 다시 켜지지 않음 — 보내기 단추를 눌러야 그때 한 번 보낸다', async ({ pageAs }) => {
    const page = await pageAs('vd-user')
    const { sent, ta, mic, send, status } = await open(page)
    const place = await spot(mic)
    await mic.click()
    await say(page, '오늘 일정 알려 줘', true)
    await expect(send).toBeVisible()
    // the tap that used to send: it stops dictation
    await mic.click()
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await expect(mic).toHaveAttribute('aria-label', '받아쓰기 시작')
    await expect(status).toHaveCount(0)
    expect(await page.evaluate(() => window.__sr.stops)).toBe(1)
    await page.waitForTimeout(1200)
    expect(await page.evaluate(() => [window.__sr.starts, window.__sr.listening()])).toEqual([1, false])
    expect(sent).toEqual([])
    await expect(ta).toHaveValue('오늘 일정 알려 줘')
    // after a stop the mic is still there, in the same place (to go on dictating), send beside it
    expect(samePlace(await spot(mic), place)).toBe(true)
    await expect(send).toBeVisible()
    await shot(page, 'vd03-stopped-with-text.png')
    // a tap again goes on after what is there
    await mic.click()
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.evaluate(() => window.__sr.listening())).toBe(true)
    await say(page, '그리고 날씨도', true)
    await expect(ta).toHaveValue('오늘 일정 알려 줘 그리고 날씨도')
    expect(sent).toEqual([])
    // the send button: sends once, dictation off, the box empties and stays empty
    await send.click()
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0].text).toBe('오늘 일정 알려 줘 그리고 날씨도')
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await expect(ta).toHaveValue('')
    expect(await page.evaluate(() => window.__sr.say('늦게 온 말', true))).toBe(false)
    await page.waitForTimeout(500)
    await expect(ta).toHaveValue('')
    expect(sent.length).toBe(1)
    expect(page.errors).toEqual([])
  })

  test('F-VD-04 듣는 중에 Enter: 받아쓰기를 먼저 끄고 보낸다 — 그 뒤에 들린 말은 비운 입력창에 돌아오지 않는다', async ({ pageAs }) => {
    const page = await pageAs('vd-user')
    const { sent, ta, mic } = await open(page)
    await mic.click()
    await say(page, '견적서 검토해 줘', true)
    await say(page, '단가')
    await ta.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0].text).toBe('견적서 검토해 줘 단가')
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    expect(await page.evaluate(() => window.__sr.aborts)).toBeGreaterThanOrEqual(1)
    await expect(ta).toHaveValue('')
    await page.waitForTimeout(600)
    expect(await page.evaluate(() => [window.__sr.starts, window.__sr.listening()])).toEqual([1, false])
    await expect(ta).toHaveValue('')
    expect(sent.length).toBe(1)
    expect(page.errors).toEqual([])
  })

  test('F-VD-05 길게 누르면 누르는 동안만 듣고 떼면 멈춤 · 짧게 누르면 켜진 채 · 키보드(Enter · Space)로 켜고 끄기 — 어느 것도 보내지 않음', async ({ pageAs }) => {
    const page = await pageAs('vd-user')
    const { sent, ta, mic, status } = await open(page)
    const b = await mic.boundingBox()
    // push to talk (mouse)
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down()
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await expect(status).toHaveText('듣는 중…')
    await say(page, '잠깐 메모해 둘게', true)
    await page.waitForTimeout(700)
    await shot(page, 'vd05-holding.png')
    await page.mouse.up()
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await expect(status).toHaveCount(0)
    await expect(ta).toHaveValue('잠깐 메모해 둘게')
    expect(await page.evaluate(() => window.__sr.stops)).toBe(1)
    // a short press: on, and it stays on after letting go
    await page.mouse.down()
    await page.waitForTimeout(80)
    await page.mouse.up()
    await page.waitForTimeout(400)
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await say(page, '고마워', true)
    await expect(ta).toHaveValue('잠깐 메모해 둘게 고마워')
    await mic.click()
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    // keyboard
    await mic.focus()
    await page.keyboard.press('Enter')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Space')
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await page.waitForTimeout(500)
    expect(sent).toEqual([])
    expect(page.errors).toEqual([])
  })

  test('F-VD-06 휴대폰 390px(밝게 · 어둡게): 듣는 중 · 긴 글에도 클립 · 보내기 · 마이크 · 상태가 겹치지 않고 화면 안, 손가락으로 길게 누르면 떼는 순간 멈춤', async ({ pageAs }) => {
    for (const theme of ['light', 'dark']) {
      const page = await pageAs('vd-phone', { viewport: PHONE, dpr: 2, touch: true })
      const { sent, ta, mic, send, status, c } = await open(page, { theme, phone: true })
      const place = await spot(mic)
      await mic.tap()
      await expect(mic).toHaveAttribute('aria-pressed', 'true')
      await expect(status).toHaveText('듣는 중…')
      await say(page, '다음 주 화요일 오후 세 시에 가온상사 김 부장님과 견적 미팅을 잡아 주고 회의 자료도 준비해 줘', true)
      await say(page, ' 참석자는 세 명')
      await expect(send).toBeVisible()
      // two lines of words: the box grows upward, the mic stays at its bottom right
      expect(samePlace(await spot(mic), place)).toBe(true)
      const parts = { clip: await box(c.locator('.box .clip').first()), send: await box(send), mic: await box(mic), ta: await box(ta) }
      const frame = await box(c.locator('.box'))
      const pill = await box(status)
      for (const [k, v] of Object.entries(parts)) {
        expect(v, k).toBeTruthy()
        expect(v.x, `${k} in the box`).toBeGreaterThanOrEqual(frame.x - 1)
        expect(v.x + v.w, `${k} in the box`).toBeLessThanOrEqual(frame.x + frame.w + 1)
        expect(v.x + v.w, `${k} on screen`).toBeLessThanOrEqual(PHONE.width)
      }
      expect(overlaps(parts.clip, parts.send)).toBe(false)
      expect(overlaps(parts.send, parts.mic)).toBe(false)
      expect(overlaps(parts.clip, parts.mic)).toBe(false)
      expect(parts.ta.x + parts.ta.w).toBeLessThanOrEqual(parts.clip.x + 1)
      // the status sits over the box, on screen — beside a phone's who-answers chip (PR #41), not on it
      expect(pill.y + pill.h).toBeLessThanOrEqual(frame.y)
      expect(pill.x).toBeGreaterThanOrEqual(0)
      expect(pill.x + pill.w).toBeLessThanOrEqual(PHONE.width)
      const chip = c.locator('.agentrow [data-test="chat-agent"]')
      if (await chip.count()) {
        const cb = await box(chip)
        expect(overlaps(cb, pill)).toBe(false)
        expect(overlaps(cb, frame)).toBe(false)
        expect(cb.x + cb.w).toBeLessThanOrEqual(PHONE.width)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
      await shot(page, `vd06-phone-${theme}.png`)
      // a tap on the mic: off, still in its place
      await mic.tap()
      await expect(mic).toHaveAttribute('aria-pressed', 'false')
      // a finger held on the mic: listens while held, off when lifted
      const t0 = await page.evaluate(() => window.__sr.starts)
      const held = touchHold(page, mic, 900)
      await expect.poll(() => page.evaluate(() => window.__sr.starts)).toBe(t0 + 1)
      await expect(mic).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(() => page.evaluate(() => window.__sr.listening())).toBe(true)
      await say(page, ' 끝', true)
      await held
      await expect(mic).toHaveAttribute('aria-pressed', 'false')
      await expect(ta).toHaveValue(/참석자는 세 명 끝$/)
      // a long reason (no microphone permission) takes its own line over the chip — still on screen, nothing on top of another
      if (theme === 'light') {
        await mic.tap()
        await expect.poll(() => page.evaluate(() => window.__sr.listening())).toBe(true)
        await page.evaluate(() => window.__sr.fail('not-allowed'))
        await expect(status).toContainText('마이크를 쓸 수 없어요')
        const ep = await box(status), fr = await box(c.locator('.box'))
        expect(ep.y + ep.h).toBeLessThanOrEqual(fr.y)
        expect(ep.x).toBeGreaterThanOrEqual(0)
        expect(ep.x + ep.w).toBeLessThanOrEqual(PHONE.width)
        const chip = c.locator('.agentrow [data-test="chat-agent"]')
        if (await chip.count()) expect(overlaps(await box(chip), ep)).toBe(false)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width)
        await shot(page, 'vd06-phone-error.png')
      }
      await page.waitForTimeout(500)
      expect(sent).toEqual([])
      expect(page.errors).toEqual([])
    }
  })

  test('F-VD-07 오류: 마이크 권한 · 데스크톱 앱의 음성 인식 서비스 없음 — 꺼지고 까닭을 보여 줌, 지원하지 않는 브라우저는 예전 안내', async ({ pageAs }) => {
    const page = await pageAs('vd-user')
    const { sent, mic, status } = await open(page)
    await mic.click()
    await expect(status).toHaveText('듣는 중…')
    await page.evaluate(() => window.__sr.fail('not-allowed'))
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await expect(status).toHaveText('마이크를 쓸 수 없어요. 브라우저에서 이 사이트의 마이크 사용을 허용한 뒤 다시 눌러 주세요.')
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.__sr.starts)).toBe(1)
    await shot(page, 'vd07-permission.png')
    // no-speech · aborted keep going
    await mic.click()
    await expect(status).toHaveText('듣는 중…')
    await page.evaluate(() => window.__sr.fail('aborted'))
    await expect.poll(() => page.evaluate(() => window.__sr.starts)).toBe(3)
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await mic.click()
    // the desktop app (html.pgl-desktop): its Chromium's speech service does not answer — say so, not look stuck
    await page.evaluate(() => document.documentElement.classList.add('pgl-desktop'))
    await mic.click()
    await page.evaluate(() => window.__sr.fail('network'))
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await expect(status).toHaveText('데스크톱 앱에서는 음성 인식 서비스에 닿지 못했어요. 브라우저에서 열거나 운영체제의 받아쓰기를 써 주세요.')
    await shot(page, 'vd07-desktop.png')
    expect(sent).toEqual([])
    expect(page.errors).toEqual([])

    // a browser without speech recognition: today's message, and with text the send button takes the place as before
    const p2 = await pageAs('vd-user')
    const u = await open(p2, { mode: 'none' })
    await expect(u.mic).toBeVisible()
    await expect(u.mic).not.toHaveAttribute('aria-pressed', /.*/)
    const said = new Promise((resolve) => p2.once('dialog', async (d) => { resolve(d.message()); await d.dismiss() }))
    await u.mic.click()
    expect(await said).toBe('이 브라우저는 받아쓰기를 지원하지 않아요.')
    await u.ta.fill('직접 적은 글')
    await expect(u.send).toBeVisible()
    await expect(u.mic).toHaveCount(0)
    expect(u.sent).toEqual([])
    expect(p2.errors).toEqual([])
  })
})
