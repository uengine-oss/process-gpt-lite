// Lite behind the ProcessGPT gateway: <tenant>.process-gpt.io/lite (locally http://localhost:8088/lite).
// The way a person gets there: sign in to ProcessGPT itself, then open /lite — no second sign-in.
// Then the deployment's promises: deep links and reloads under /lite work, everything outside /lite is
// still ProcessGPT, a chat turn comes back and survives a reload, and two accounts in one room hear each
// other in a meeting whose minutes stay in the room.
//   PGPT_ROOT_URL=http://localhost:8088 LITE_A_EMAIL=… LITE_A_PASSWORD=… LITE_B_EMAIL=… LITE_B_PASSWORD=… \
//   OPENAI_API_KEY=… npx playwright test --project deploy
// The two accounts are ProcessGPT accounts of the address's tenant (localhost locally).
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { test, expect, chromium } from '@playwright/test'

const ROOT = (process.env.PGPT_ROOT_URL || 'http://localhost:8088').replace(/\/$/, '')
const LITE = `${ROOT}/lite`
const A = { email: process.env.LITE_A_EMAIL, password: process.env.LITE_A_PASSWORD }
const B = { email: process.env.LITE_B_EMAIL, password: process.env.LITE_B_PASSWORD }
const db = process.env.PGPT_DB_URL ? new pg.Pool({ connectionString: process.env.PGPT_DB_URL, max: 2 }) : null
const q = async (sql, params) => (await db.query(sql, params)).rows

test.describe.configure({ mode: 'serial' })
test.afterAll(async () => { await db?.end() })

// ProcessGPT's own sign-in page (process-gpt-vue3 LoginForm)
async function signIn(page, who) {
  await page.goto(`${ROOT}/auth/login`)
  await page.locator('.cp-id input').fill(who.email)
  await page.locator('.cp-pwd input').fill(who.password)
  const agree = page.locator('input[type=checkbox]').first()
  if (await agree.count()) await agree.check()
  await page.locator('.cp-login').click()
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/login'), { timeout: 30_000 })
  await expect.poll(async () => (await page.context().cookies()).some((c) => c.name === 'refresh_token'), { timeout: 30_000 }).toBe(true)
}
const liteMe = (page) => page.evaluate(async () => {
  const s = JSON.parse(localStorage.getItem('pgpt-pro-session') || 'null')
  const r = await fetch('/lite/api/me', { headers: { Authorization: `Bearer ${s?.session?.access_token || ''}` } })
  return { status: r.status, body: r.ok ? await r.json() : null }
})
const isLite = (page) => page.evaluate(() => [...document.scripts].some((s) => (s.src || '').includes('/lite/assets/')))

test('1·2·3 ProcessGPT 로그인 → /lite 가 그 계정·테넌트로 열림, 직접 주소·새로고침, /lite 밖은 ProcessGPT', async ({ page }) => {
  test.skip(!A.email || !A.password, 'LITE_A_EMAIL / LITE_A_PASSWORD 가 없음')
  await signIn(page, A)
  const outside = page.url()

  await page.goto(`${LITE}/`)
  await page.waitForURL(/\/lite\/chat/, { timeout: 30_000 })
  await expect(page.locator('.composer textarea').first()).toBeVisible({ timeout: 30_000 })
  const me = await liteMe(page)
  expect(me.status).toBe(200)
  expect(me.body.user?.email || me.body.email).toBe(A.email)

  // a deep link opened directly, and a reload of it
  for (const p of ['/chat', '/improve']) {
    const r = await page.goto(`${LITE}${p}`)
    expect(r.status(), p).toBe(200)
    expect(await isLite(page)).toBe(true)
    expect((await page.reload()).status(), `${p} reload`).toBe(200)
    expect(new URL(page.url()).pathname).toBe(`/lite${p}`)
  }

  // outside /lite: ProcessGPT, as before
  for (const p of [new URL(outside).pathname, '/definition-map']) {
    const r = await page.goto(`${ROOT}${p}`)
    expect(r.status(), p).toBe(200)
    expect(await isLite(page), p).toBe(false)
  }
})

test('4 채팅으로 일을 맡기면 에이전트 답이 화면에 오고 새로고침해도 남는다', async ({ page }) => {
  test.skip(!A.email || !A.password, 'LITE_A_EMAIL / LITE_A_PASSWORD 가 없음')
  test.setTimeout(10 * 60_000)
  await signIn(page, A)
  await page.goto(`${LITE}/chat`)
  // work for the agent itself — nothing that reads as a message for a teammate (that is routed to them)
  const ask = `신입 사원 온보딩 첫 주에 할 일을 세 가지 항목으로 정리해 줘. 참고번호 ${Date.now().toString(36)}`
  await page.locator('.foot .composer textarea').click()
  await page.keyboard.type(ask)
  await page.keyboard.press('Enter')
  await expect(page.getByText(ask).first()).toBeVisible({ timeout: 30_000 })

  // the turn ends with the agent's own answer — the three items — stored after the question, and it
  // was not handed to a teammate instead (a 'chip' such as "…님께 알림 보냄")
  let answer = '', rows = []
  await expect.poll(async () => {
    rows = await q(`select m.role, m.kind, m.content->>'text' as text from pro_messages m join pro_threads t on t.id = m.thread_id
                    join auth.users u on u.id = t.user_id
                    where u.email = $1 and m.created_at > (select max(m2.created_at) from pro_messages m2 where m2.thread_id = m.thread_id and m2.content->>'text' = $2)
                    order by m.created_at`, [A.email, ask])
    answer = rows.find((r) => r.role === 'agent' && ['text', 'doc'].includes(r.kind) && (r.text || '').split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length >= 3)?.text || ''
    return answer.length
  }, { timeout: 8 * 60_000, intervals: [5000] }).toBeGreaterThan(0)
  expect(rows.filter((r) => r.kind === 'chip'), '팀원에게 넘기지 않고 에이전트가 답함').toEqual([])
  const snippet = answer.replace(/[#*`>\-\d.]/g, ' ').split(/\s+/).filter((w) => w.length >= 3).slice(0, 3).join(' ')
  await expect(page.locator('body')).toContainText(snippet.split(' ')[0], { timeout: 60_000 })

  await page.reload()
  await expect(page.getByText(ask).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('body')).toContainText(snippet.split(' ')[0])
})

// Lite keeps its own sign-in page: not signed in to ProcessGPT, /lite stays on it (no trip to ProcessGPT's
// main page). The tenant's accounts sign in with a mailed code; any other email gets no code and no account.
const MAILPIT = (process.env.MAILPIT_URL || '').replace(/\/$/, '')
async function mailedCode(addr, since) {
  for (let i = 0; i < 30; i++) {
    const list = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${addr}`)}`).then((r) => r.json()).catch(() => null)
    const m = (list?.messages || []).find((x) => new Date(x.Created).getTime() >= since - 2000)
    if (m) {
      const msg = await fetch(`${MAILPIT}/api/v1/message/${m.ID}`).then((r) => r.json())
      const code = /\b(\d{6})\b/.exec(`${msg.Subject} ${msg.Text}`)?.[1]
      if (code) return code
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}
async function codeSignIn(page, addr) {
  await page.locator('input.field[type=email]').fill(addr)
  const since = Date.now()
  await page.locator('input.field[type=email] + button.dark-btn').click()
  await page.locator('.code input').first().waitFor()
  return since
}

test('0 ProcessGPT 로그인 없이 /lite → Lite 로그인 화면, 테넌트 계정은 메일 코드로 로그인, 다른 이메일은 계정이 안 생김', async ({ page }) => {
  test.skip(!B.email || !MAILPIT || !db, 'LITE_B_EMAIL / MAILPIT_URL / PGPT_DB_URL 이 없음')
  await page.goto(`${LITE}/chat`)
  await page.waitForURL(/\/lite\/login/, { timeout: 30_000 })
  await page.waitForTimeout(2000)
  expect(new URL(page.url()).pathname, 'ProcessGPT 메인으로 가지 않음').toBe('/lite/login')

  // someone outside the tenant: same answer, no code, no account
  const stranger = `lite-path-stranger-${Date.now().toString(36)}@pgpt.test`
  const s0 = await codeSignIn(page, stranger)
  await page.waitForTimeout(3000)
  expect(await mailedCode(stranger, s0).catch(() => null)).toBeNull()
  expect((await q('select count(*)::int n from auth.users where email = $1', [stranger]))[0].n).toBe(0)
  await page.locator('button.pill-btn', { hasText: '다른 이메일 사용' }).click()

  // a member of the tenant: the mailed code signs in
  const since = await codeSignIn(page, B.email)
  const code = await mailedCode(B.email, since)
  expect(code, '메일로 온 코드').toBeTruthy()
  await page.locator('.code input').first().fill(code)
  await page.waitForURL(/\/lite\/(welcome|chat)/, { timeout: 30_000 })
  const me = await liteMe(page)
  expect(me.status).toBe(200)
  expect(me.body.user.email).toBe(B.email)
})

// --- 5: a meeting between two accounts in their 1:1 room ---
const RATE = 24000
async function speech(text, voice) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm' }),
  })
  if (!r.ok) throw new Error(`tts ${r.status}`)
  return new Int16Array(await r.arrayBuffer().then((b) => b.slice(0, b.byteLength - (b.byteLength % 2))))
}
// a microphone that says its line every few seconds (looped by Chromium)
function micWav(file, samples, every) {
  const pcm = new Int16Array(Math.ceil(every * RATE))
  pcm.set(samples.subarray(0, pcm.length))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length * 2, 40)
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(pcm.buffer)]))
}
// the loudest moment of the other person's sound as this page plays it
const heard = (page) => page.evaluate(async () => {
  const v = [...document.querySelectorAll('[data-test=meeting-view] .tile:not(.me) video')].find((x) => x.srcObject?.getAudioTracks().length)
  if (!v) return 0
  const ac = new AudioContext()
  const an = ac.createAnalyser()
  ac.createMediaStreamSource(v.srcObject).connect(an)
  const buf = new Float32Array(an.fftSize)
  let peak = 0
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    an.getFloatTimeDomainData(buf)
    peak = Math.max(peak, Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length))
  }
  ac.close()
  return peak
})

test('5 두 계정이 같은 대화방 회의에서 서로 들리고, 마치면 대화방에 회의록이 남는다', async ({}, info) => {
  test.skip(!A.email || !B.email || !process.env.OPENAI_API_KEY, '두 계정 또는 OPENAI_API_KEY 가 없음')
  test.setTimeout(15 * 60_000)
  const dir = info.outputPath('mics'); fs.mkdirSync(dir, { recursive: true })
  micWav(path.join(dir, 'a.wav'), await speech('다음 주 고객 방문 일정을 화요일 오후로 잡을게요.', 'onyx'), 9)
  micWav(path.join(dir, 'b.wav'), await speech('좋아요. 방문 전에 견적서를 한 번 더 확인할게요.', 'nova'), 9)

  const open = async (who, mic) => {
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`, '--autoplay-policy=no-user-gesture-required'] })
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ko-KR', permissions: ['camera', 'microphone'] })
    const page = await ctx.newPage()
    await signIn(page, who)
    await page.goto(`${LITE}/chat`)
    // a first visit to Lite asks the birth date first (OnboardAge → OnboardIntro → chat)
    if (await page.waitForURL(/\/lite\/welcome\/age/, { timeout: 5000 }).then(() => true, () => false)) {
      const sel = page.locator('select.sel')
      for (const [i, v] of [[0, 1], [1, 1], [2, 1]]) await sel.nth(i).selectOption({ index: v })
      await page.locator('input.field[type=email] + button.dark-btn').click()
      await page.waitForURL(/\/lite\/chat/, { timeout: 30_000 })
    }
    await expect(page.locator('.composer textarea').first()).toBeVisible({ timeout: 30_000 })
    return { browser, page }
  }
  const a = await open(A, path.join(dir, 'a.wav'))
  const b = await open(B, path.join(dir, 'b.wav'))
  try {
    const ids = await Promise.all([a, b].map(async (x) => (await liteMe(x.page)).body))
    const name = (m) => m.profile?.name || m.user?.name || m.name
    // A (an administrator) has B on the Lite team (설정 → 팀·역할), then the 1:1 room between them
    // (what 대화 → a teammate opens)
    const room = await a.page.evaluate(async ({ bid, email, name }) => {
      const s = JSON.parse(localStorage.getItem('pgpt-pro-session'))
      const call = (p, body) => fetch(`/lite/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.session.access_token}` }, body: JSON.stringify(body) }).then((r) => r.json())
      await call('/team', { email, name })
      return call('/team/threads', { members: [bid] })
    }, { bid: ids[1].user.id, email: B.email, name: name(ids[1]) })
    expect(room.id).toBeTruthy()
    const enter = async (x, other) => {
      await x.page.reload()
      await x.page.locator('button.msg-btn').click()
      await x.page.locator('.tabs button', { hasText: '대화' }).click()
      await x.page.locator('button.th', { hasText: other }).first().click()
    }
    // rooms are listed under the other person's name as the team list has it
    const teamName = (x, id) => x.page.evaluate(async (uid) => {
      const s = JSON.parse(localStorage.getItem('pgpt-pro-session'))
      const t = await fetch('/lite/api/team', { headers: { Authorization: `Bearer ${s.session.access_token}` } }).then((r) => r.json())
      return t.find((m) => m.id === uid)?.name
    }, id)
    await enter(a, await teamName(a, ids[1].user.id))
    await enter(b, await teamName(b, ids[0].user.id))
    await Promise.all([a, b].map((x) => x.page.locator('[data-test=meeting-start]').click()))
    for (const x of [a, b]) await x.page.locator('[data-test=consent]').check()
    for (const x of [a, b]) { await x.page.locator('[data-test=join]').click(); await x.page.locator('[data-test=meeting-view]').waitFor() }

    // each plays the other's sound
    for (const x of [a, b]) await expect.poll(() => x.page.evaluate(() => [...document.querySelectorAll('[data-test=meeting-view] .tile:not(.me) video')].filter((v) => v.readyState >= 2).length), { timeout: 45_000 }).toBeGreaterThanOrEqual(1)
    const levels = await Promise.all([heard(a.page), heard(b.page)])
    console.log('heard levels (A hears B, B hears A):', levels)
    expect(levels[0], 'A 가 B 의 소리를 받는다').toBeGreaterThan(0.01)
    expect(levels[1], 'B 가 A 의 소리를 받는다').toBeGreaterThan(0.01)
    // and what was said reaches the transcript under the speaker's name
    await expect(a.page.locator('[data-test=lines] .ln', { hasText: '견적서' }).first()).toBeVisible({ timeout: 60_000 })

    await a.page.locator('[data-test=end]').click()
    await expect(a.page.locator('[data-test=meeting-minutes]').first()).toBeVisible({ timeout: 180_000 })
    await expect(b.page.locator('[data-test=meeting-minutes]').first()).toBeVisible({ timeout: 60_000 })
    if (db) {
      const rows = await q(`select count(*)::int n from chats where id = $1 and messages->'pgpt'->>'kind' = 'meeting-minutes'`, [room.id])
      expect(rows[0].n).toBeGreaterThanOrEqual(1)
    }
  } finally {
    // what each person saw last (kept with the report)
    for (const [k, x] of [['a', a], ['b', b]]) await x.page.screenshot({ path: info.outputPath(`${k}.png`) }).catch(() => {})
    await a.browser.close(); await b.browser.close()
  }
})
