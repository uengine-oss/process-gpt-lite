// 다른 앱의 「공유」로 Process GPT 에 넣기 (2026-11-26 사용자 휴대폰 녹화 — 「우리가 파일을 공유할 때 여기 앱으로 process GPT가 들어가면
// 좋겠어.」 · 「현재 열려있는 공간의 첨부를 바로 할 수 있겠지.」 · 「예를 들면 지금 현재 대화창이 열려 있다고 치면 팀 메시지에 여기에 곧바로
// 첨부를 할 수 있을 거야.」 — 스펙 openspec/specs/share-target). 지어낸 사람: 정하윤 · 김서연 · 박도윤, 단체방 「시니어그룹」.
// The real service worker (public/sw.js) runs in Chromium: what Android's share sheet does — a multipart POST to the manifest's
// share_target action, as a navigation — is done with a form the test submits (and once with fetch, following the 303), then:
//   F-ST-01 390px 밝은 · 밤: 단체방을 열어 둔 채 PDF 를 공유 → 그 방의 입력창에 칩(올라감) · 「‘시니어그룹’ 입력창에 넣었어요」 · 보내지 않음
//           → 한마디 쓰고 보내기 → 김서연이 같은 바이트를 받는다
//   F-ST-02 열린 곳이 없음(프로세스 지도) → 「어디에 넣을까요?」(대화 · 내 채팅 · 폴더) → 내 채팅 → 채팅 입력창에 칩과 글 · 보내지 않음
//   F-ST-03 글 · 주소만(fetch 로 POST → 303 을 따라감): 열린 대화 → 입력창에 제목 · 글 · 주소(자르지 않음), 칩 없음
//   F-ST-04 50MB 넘는 파일: 같이 온 작은 파일만 칩, 넘는 것은 이름 · 크기 · 까닭 / 넘는 것만이면 알림만(고르기 없음)
//   F-ST-05 폴더를 열어 둠 → 「‘영업 자료’ 폴더에 넣을까요?」 → 이 폴더에 넣기 → 폴더 main 에 그 파일 / 「다른 곳에」 → 방의 칩이 빠지고 고르기
//   F-ST-06 받지 못한 공유(?share=failed · 없는 id) → 알림 · 설정 › 앱 설치: Android 에만 「다른 앱의 「공유」」 안내
//   F-ST-07 영어 화면: 「어디에 넣을까요?」 · 넣은 뒤의 막대 · 50MB 알림 · 설치 안내에 한글이 남지 않는다(사람이 지은 이름 · 파일 이름은 그대로)
// 자기 스택(lib/localStack.js — 회사 share-target-ui, RT_API_FROM · RT_WEB_FROM 부터 빈 포트, 기본 8974 · 5374)을 띄우고 지운다. 모델은 부르지 않는다.
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/share-target.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/share-target/e2e/results')
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'share-target-ui'
const PDF = Buffer.from('%PDF-1.4\n% 하늘테크 견적서 — 지어낸 문서\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
let S, HY, SY, DY, ROOM, FOLDER

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8974, webFrom: Number(process.env.RT_WEB_FROM) || 5374,
    env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_JUDGE_URL: '' } })
  HY = await S.person(`pro-rt-${TENANT}-a@people-mail.test`, '정하윤')
  SY = await S.person(`pro-rt-${TENANT}-b@people-mail.test`, '김서연')
  DY = await S.person(`pro-rt-${TENANT}-c@people-mail.test`, '박도윤')
  for (const p of [HY, SY, DY]) await S.join(p)
  await cleanRooms()
  ROOM = (await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [SY.id, DY.id], title: '시니어그룹' } })).id
  await S.api(SY.token, `/team/threads/${ROOM}/messages`, { method: 'POST', body: { text: '견적서 받으면 여기 올려 주세요.' } })
  FOLDER = await S.api(HY.token, '/folders', { method: 'POST', body: { name: '영업 자료', description: '견적 · 제안' } })
})
async function cleanRooms() {
  for (const sql of ['delete from pro_chat_reactions where tenant_id=$1', 'delete from chats where tenant_id=$1', 'delete from pro_chat_reads where room_id in (select id from chat_rooms where tenant_id=$1)',
    `delete from notifications where tenant_id=$1 and type in ('team','chat')`, 'delete from chat_rooms where tenant_id=$1']) await S.q(sql, [TENANT]).catch(() => {})
}
test.afterAll(async () => { if (S) { await cleanRooms().catch(() => {}); await S.stop() } })

// a signed-in phone (the real service worker on: serviceWorkers 'allow'); last: the place this device had open before (src/shareTarget.js)
async function phone(browser, who, { theme = 'light', ua = ANDROID, lang = 'ko' } = {}) {
  const ctx = await browser.newContext({ ...PHONE, userAgent: ua, baseURL: S.web, serviceWorkers: 'allow' })
  await ctx.addInitScript(([s, th, lg]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', lg)
    try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ }
  }, [JSON.stringify(who.session), theme, lang])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
// the service worker installed and in charge of this page (the app registers it on load — src/browserNotify.js)
async function workerReady(p) {
  await p.waitForFunction(() => navigator.serviceWorker?.controller?.state === 'activated' || !!navigator.serviceWorker?.controller, null, { timeout: 20000 })
}
async function openRoom(p) {
  await p.goto('/chat')
  await workerReady(p)
  await p.locator('.seg button').filter({ hasText: /^홈$/ }).click()
  await p.locator('button.msgs').click()
  await p.locator('.ms').waitFor()
  await p.locator('.ms .tabs button').filter({ hasText: '대화' }).click()
  await p.locator('.ms .th').filter({ has: p.locator('.nm b', { hasText: /^시니어그룹$/ }) }).first().click()
  await p.locator('.ms .cmp textarea').waitFor()
}
// What Android's share sheet does: a POST navigation, multipart, to the manifest's share_target action (title · text · url · files)
async function osShare(p, { files = [], title = '', text = '', url = '' } = {}) {
  const action = await p.evaluate(async () => {
    const m = await (await fetch(document.querySelector('link[rel="manifest"]').href)).json()
    return new URL(m.share_target.action, document.querySelector('link[rel="manifest"]').href).pathname
  })
  await p.evaluate((action) => {
    const f = Object.assign(document.createElement('form'), { method: 'post', enctype: 'multipart/form-data', action, id: 'os-share' })
    for (const n of ['title', 'text', 'url']) f.appendChild(Object.assign(document.createElement('input'), { name: n, id: `os-${n}` }))
    f.appendChild(Object.assign(document.createElement('input'), { type: 'file', name: 'files', multiple: true, id: 'os-files' }))
    f.style.display = 'none'
    document.body.appendChild(f)
  }, action)
  if (files.length) await p.setInputFiles('#os-files', files)
  await Promise.all([
    p.waitForURL((u) => /\/chat/.test(u.pathname) && !u.search.includes('share='), { timeout: 30000 }),
    p.evaluate(({ title, text, url }) => {
      for (const [k, v] of Object.entries({ title, text, url })) document.getElementById(`os-${k}`).value = v
      document.getElementById('os-share').submit()
    }, { title, text, url }),
  ])
}
const upChip = (p, name) => p.locator(`.ms [data-test="msg-upload-chip"][data-file="${name}"]`)
const chatChip = (p, name) => p.locator(`.composer [data-test="chat-attachment"][data-file="${name}"]`)
const roomMessages = async (who) => (await S.api(who.token, `/team/threads/${ROOM}/messages`)).messages

test('F-ST-01 휴대폰: 단체방을 열어 둔 채 PDF 를 공유하면 그 방 입력창에 칩으로 — 보내기를 눌러야 김서연이 받는다', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const before = (await roomMessages(HY)).length
    const p = await phone(browser, HY, { theme })
    await openRoom(p)
    await expect(p.locator('[data-test="msg-thread-head"] > b')).toHaveText('시니어그룹')
    // (the place is kept as its kind and id only)
    expect(await p.evaluate(() => JSON.parse(localStorage.getItem('pgl-last-place')))).toEqual({ kind: 'room', id: ROOM })
    await osShare(p, { files: [{ name: '하늘테크 견적서.pdf', mimeType: 'application/pdf', buffer: PDF }] })
    // the room opens again by itself, with the file going up as a chip there
    await expect(p.locator('[data-test="msg-thread-head"] > b')).toHaveText('시니어그룹')
    await expect(upChip(p, '하늘테크 견적서.pdf')).toHaveAttribute('data-state', 'ready', { timeout: 20000 })
    const bar = p.locator('[data-test="share-placed"]')
    await expect(bar).toContainText('공유한 파일 1개를 ‘시니어그룹’ 입력창에 넣었어요.')
    await expect(bar).toContainText('보내기를 눌러야 보내져요.')
    await expect(bar).toHaveAttribute('data-kind', 'room')
    expect(await noOverflow(p)).toBe(true)
    const b = await bar.boundingBox()
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(390)
    await shot(p, `f-st-01-room-${theme}`)
    // nothing was sent by itself
    expect((await roomMessages(HY)).length).toBe(before)
    // the address no longer says ?share= (a reload does not put it in again)
    expect(new URL(p.url()).search).toBe('')
    if (theme === 'light') {
      await p.locator('.ms .cmp textarea').fill('견적서 올려요. 확인 부탁드려요.')
      await p.locator('[data-test="msg-send"]').click()
      await expect(upChip(p, '하늘테크 견적서.pdf')).toHaveCount(0)
      // 김서연 gets it: the same bytes
      await expect.poll(async () => (await roomMessages(SY)).some((m) => (m.artifacts || []).some((a) => a.name === '하늘테크 견적서.pdf')), { timeout: 20000 }).toBe(true)
      const m = (await roomMessages(SY)).find((x) => (x.artifacts || []).some((a) => a.name === '하늘테크 견적서.pdf'))
      expect(m.body).toContain('견적서 올려요')
      const a = m.artifacts.find((x) => x.name === '하늘테크 견적서.pdf')
      const raw = await fetch(`http://127.0.0.1:${S.apiPort}/api/team/shares/${encodeURIComponent(a.shareId)}/raw`, { headers: { Authorization: `Bearer ${SY.token}` } })
      expect(raw.ok).toBe(true)
      expect(Buffer.from(await raw.arrayBuffer()).equals(PDF)).toBe(true)
      // the share's entries are gone from the phone's cache once taken
      expect(await p.evaluate(async () => (await (await caches.open('pgl-share-v1')).keys()).length)).toBe(0)
    }
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-ST-02 열린 곳이 없으면 「어디에 넣을까요?」 — 대화 · 내 채팅 · 폴더, 내 채팅을 고르면 채팅 입력창에 칩과 글', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const p = await phone(browser, HY, { theme })
    await p.goto('/process-map')
    await workerReady(p)
    await expect.poll(() => p.evaluate(() => localStorage.getItem('pgl-last-place'))).toBe(null)
    await osShare(p, { files: [{ name: '현장 사진.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-bytes') }], text: '오늘 현장 사진이에요' })
    const sheet = p.locator('[data-test="share-chooser"]')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText('어디에 넣을까요?')
    await expect(sheet.locator('[data-test="share-what"]')).toHaveText('현장 사진.jpg · 글')
    await expect(sheet.locator('[data-test="share-pick"][data-kind="room"]').first()).toContainText('시니어그룹')
    await expect(sheet.locator('[data-test="share-pick"][data-kind="chat"]')).toContainText('Process GPT 채팅')
    await expect(sheet.locator('[data-test="share-pick"][data-kind="folder"]').first()).toContainText('영업 자료')
    await expect(sheet).toContainText('넣기만 하고 보내지는 않아요.')
    const sb = await sheet.boundingBox()
    expect(sb.x).toBeGreaterThanOrEqual(0)
    expect(sb.x + sb.width).toBeLessThanOrEqual(390)
    expect(sb.y + sb.height).toBeLessThanOrEqual(844)
    await shot(p, `f-st-02-chooser-${theme}`)
    if (theme === 'dark') { await sheet.locator('[data-test="share-cancel"]').click(); await expect(sheet).toHaveCount(0); expect(p.errors).toEqual([]); await p.context().close(); continue }
    const mainBefore = await S.api(HY.token, '/threads').then(([t]) => S.api(HY.token, `/threads/${t.id}/messages`)).then((ms) => ms.length)
    await sheet.locator('[data-test="share-pick"][data-kind="chat"]').click()
    await expect(sheet).toHaveCount(0)
    await expect(p).toHaveURL(/\/chat$/)
    await expect(chatChip(p, '현장 사진.jpg')).toHaveAttribute('data-state', 'ready', { timeout: 20000 })
    await expect(p.locator('.composer textarea')).toHaveValue('오늘 현장 사진이에요')
    await expect(p.locator('[data-test="share-placed"]')).toContainText('공유한 파일 1개와 글을 ‘Process GPT 채팅’ 입력창에 넣었어요.')
    expect(await noOverflow(p)).toBe(true)
    await shot(p, 'f-st-02-chat-light')
    // nothing sent to the agent
    const mainAfter = await S.api(HY.token, '/threads').then(([t]) => S.api(HY.token, `/threads/${t.id}/messages`)).then((ms) => ms.length)
    expect(mainAfter).toBe(mainBefore)
    // and the chat is now the open place
    expect(await p.evaluate(() => JSON.parse(localStorage.getItem('pgl-last-place')))).toEqual({ kind: 'chat', id: '' })
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-ST-03 글 · 주소만 공유(fetch 로 POST → 303) — 열린 단체방의 입력창에 제목 · 글 · 주소, 주소는 자르지 않는다', async ({ browser }) => {
  const p = await phone(browser, HY)
  await openRoom(p)
  const url = `https://news.example.test/2026/11/26/haneul-tech-quarterly?ref=share&q=${'%ED%95%9C'.repeat(20)}`
  // fetch the share action like the OS would, follow the 303 — then open where it led
  const led = await p.evaluate(async (url) => {
    const m = await (await fetch(document.querySelector('link[rel="manifest"]').href)).json()
    const fd = new FormData()
    fd.append('title', '하늘테크 3분기 실적')
    fd.append('text', '이 기사 같이 봐요')
    fd.append('url', url)
    const r = await fetch(new URL(m.share_target.action, document.querySelector('link[rel="manifest"]').href), { method: 'POST', body: fd })
    return { redirected: r.redirected, url: r.url }
  }, url)
  expect(led.redirected).toBe(true)
  expect(new URL(led.url).pathname).toBe('/chat')
  expect(new URL(led.url).searchParams.get('share')).toMatch(/^[0-9a-z]{6,12}-[0-9a-z]{4,16}$/)
  await p.goto(led.url)
  await expect(p.locator('[data-test="msg-thread-head"] > b')).toHaveText('시니어그룹')
  await expect(p.locator('.ms .cmp textarea')).toHaveValue(`하늘테크 3분기 실적\n이 기사 같이 봐요\n${url}`)
  await expect(p.locator('.ms [data-test="msg-upload-chip"]')).toHaveCount(0)
  await expect(p.locator('[data-test="share-placed"]')).toContainText('공유한 글을 ‘시니어그룹’ 입력창에 넣었어요.')
  await shot(p, 'f-st-03-text-room-light')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-ST-04 50MB 넘는 파일 — 같이 온 작은 파일만 칩, 넘는 것은 이름 · 크기 · 까닭 / 넘는 것만이면 알림만', async ({ browser }) => {
  // (Playwright passes a buffer up to 50MB only: the big one is a file on disk, its name the one shared)
  const big = path.join(test.info().outputPath(), '현장 영상.mp4')
  fs.mkdirSync(path.dirname(big), { recursive: true })
  fs.writeFileSync(big, Buffer.alloc(51 * 1024 * 1024, 1))
  const p = await phone(browser, HY)
  await openRoom(p)
  const memo = path.join(path.dirname(big), '메모.txt')
  fs.writeFileSync(memo, '현장 메모')
  await osShare(p, { files: [big, memo] })
  await expect(upChip(p, '메모.txt')).toHaveAttribute('data-state', 'ready', { timeout: 20000 })
  await expect(upChip(p, '현장 영상.mp4')).toHaveCount(0)
  const bar = p.locator('[data-test="share-placed"]')
  await expect(bar).toContainText('공유한 파일 1개를 ‘시니어그룹’ 입력창에 넣었어요.')
  await expect(bar).toContainText('‘현장 영상.mp4’(51MB)는 50MB가 넘어서 넣지 못했어요.')
  await shot(p, 'f-st-04-oversize-light')
  // only the big one: a line that says why — no chooser, nothing in the box
  await p.locator('.ms .cmp [data-test="msg-upload-chip"] button').click()
  await osShare(p, { files: [big] })
  const note = p.locator('[data-test="share-notice"]')
  await expect(note).toContainText('‘현장 영상.mp4’(51MB)는 50MB가 넘어서 넣지 못했어요.')
  await expect(p.locator('[data-test="share-chooser"]')).toHaveCount(0)
  await expect(p.locator('[data-test="share-placed"]')).toHaveCount(0)
  await shot(p, 'f-st-04-oversize-only-light')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-ST-05 폴더를 열어 둠 → 「이 폴더에 넣기」 → main 에 그 파일 / 방에 넣은 것을 「다른 곳에」 → 칩이 빠지고 고르기 → 내 채팅', async ({ browser }) => {
  const p = await phone(browser, HY)
  await p.goto(`/folders/${FOLDER.slug}`)
  await workerReady(p)
  await expect(p.locator('[data-test="folder-detail"]')).toBeVisible()
  await osShare(p, { files: [{ name: '제안서 초안.pdf', mimeType: 'application/pdf', buffer: PDF }], text: '폴더에 넣어 둘게요' })
  const ask = p.locator('[data-test="share-folder-ask"]')
  await expect(ask).toContainText('‘영업 자료’ 폴더에 넣을까요?')
  await expect(ask).toContainText('제안서 초안.pdf')
  await expect(ask).toContainText('함께 온 글은 폴더에 넣지 않아요.')
  await expect(p).toHaveURL(new RegExp(`/folders/${FOLDER.slug}$`))
  await shot(p, 'f-st-05-folder-ask-light')
  // not in the folder until the person says so
  expect((await S.api(HY.token, `/folders/${FOLDER.slug}/tree`)).some((f) => f.path === '제안서 초안.pdf')).toBe(false)
  await ask.locator('[data-test="share-into-folder"]').click()
  await expect.poll(async () => (await S.api(HY.token, `/folders/${FOLDER.slug}/tree`)).some((f) => f.path === '제안서 초안.pdf'), { timeout: 20000 }).toBe(true)
  await expect(p.locator('[data-test="folder-detail"]')).toContainText('제안서 초안.pdf')
  await shot(p, 'f-st-05-folder-done-light')
  // the room: put there, then 「다른 곳에」 — its chip goes, the chooser asks, my chat takes it
  await openRoom(p)
  await osShare(p, { files: [{ name: '회의 메모.txt', mimeType: 'text/plain', buffer: Buffer.from('다음 주 화요일') }], text: '회의 메모예요' })
  await expect(upChip(p, '회의 메모.txt')).toHaveAttribute('data-state', 'ready', { timeout: 20000 })
  await expect(p.locator('.ms .cmp textarea')).toHaveValue('회의 메모예요')
  await p.locator('[data-test="share-elsewhere"]').click()
  await expect(upChip(p, '회의 메모.txt')).toHaveCount(0)
  await expect(p.locator('.ms .cmp textarea')).toHaveValue('')
  const sheet = p.locator('[data-test="share-chooser"]')
  await expect(sheet).toBeVisible()
  await sheet.locator('[data-test="share-pick"][data-kind="chat"]').click()
  await expect(p.locator('.ms')).toHaveCount(0)
  await expect(chatChip(p, '회의 메모.txt')).toHaveAttribute('data-state', 'ready', { timeout: 20000 })
  await expect(p.locator('.composer textarea')).toHaveValue('회의 메모예요')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-ST-06 받지 못한 공유는 그렇다고 알린다 · 설정 › 앱 설치에는 Android 에만 「공유」 안내', async ({ browser }) => {
  const p = await phone(browser, HY)
  await p.goto('/chat?share=failed')
  await expect(p.locator('[data-test="share-notice"]')).toContainText('공유한 내용을 받지 못했어요. 다시 공유해 주세요.')
  expect(new URL(p.url()).search).toBe('')
  await p.goto('/chat?share=mfx0abcd-zzzz9999')
  await expect(p.locator('[data-test="share-notice"]')).toContainText('공유한 내용을 찾지 못했어요. 다시 공유해 주세요.')
  // (a folder's own ?share= — its 「권한 요청」 — is not taken for a share)
  await p.goto(`/folders/${FOLDER.slug}?share=${SY.id}`)
  await expect(p.locator('[data-test="folder-detail"]')).toBeVisible()
  await expect(p.locator('[data-test="share-notice"]')).toHaveCount(0)
  // settings › 앱 설치 on Android Chrome: the install, and that the app then shows in other apps' 「공유」
  for (const theme of ['light', 'dark']) {
    const a = await phone(browser, HY, { theme })
    await a.goto('/settings')
    await a.locator('[data-test="install-app"]').click()
    const sheet = a.locator('.veil [data-test="install-nudge"]')
    await expect(sheet.locator('[data-test="install-share-hint"]')).toHaveText('휴대폰 홈 화면에 추가하면 다른 앱의 「공유」에 Process GPT 가 나타나요.')
    await shot(a, `f-st-06-install-hint-${theme}`)
    await a.context().close()
  }
  // iPhone: Safari has no Web Share Target — no such line
  const i = await phone(browser, HY, { ua: IPHONE })
  await i.goto('/settings')
  await i.locator('[data-test="install-app"]').click()
  await expect(i.locator('.veil [data-test="install-nudge"]')).toBeVisible()
  await expect(i.locator('[data-test="install-share-hint"]')).toHaveCount(0)
  for (const x of [p, i]) { expect(x.errors).toEqual([]); await x.context().close() }
})

test('F-ST-07 영어 화면 — 고르기 · 넣은 뒤의 막대 · 넘친 파일 알림 · 설치 안내가 영어로', async ({ browser }) => {
  // (what people named — the room, the folder, the files — stays as written)
  const mine = /시니어그룹|영업 자료|현장 사진\.jpg|정하윤|김서연|박도윤/g
  const hangul = async (loc) => ((await loc.innerText()).replace(mine, '').match(/[\uac00-\ud7a3]+/g) || [])
  const p = await phone(browser, HY, { lang: 'en' })
  await p.goto('/process-map')
  await workerReady(p)
  await osShare(p, { files: [{ name: '현장 사진.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-bytes') }], text: 'site photo' })
  const sheet = p.locator('[data-test="share-chooser"]')
  await expect(sheet).toContainText('Where should this go?')
  await expect(sheet.locator('[data-test="share-pick"][data-kind="room"]').first()).toContainText('Group · 3 people')
  expect(await hangul(sheet)).toEqual([])
  await shot(p, 'f-st-07-chooser-en')
  await sheet.locator('[data-test="share-pick"][data-kind="room"]').first().click()
  const bar = p.locator('[data-test="share-placed"]')
  await expect(bar).toContainText("Added 1 shared file(s) and text to the ‘시니어그룹’ message box.")
  await expect(bar).toContainText("It's not sent until you tap Send.")
  expect(await hangul(bar)).toEqual([])
  await p.locator('.ms .cmp [data-test="msg-upload-chip"] button').click()
  const memo = path.join(test.info().outputPath(), 'big.mp4')
  fs.mkdirSync(path.dirname(memo), { recursive: true })
  fs.writeFileSync(memo, Buffer.alloc(51 * 1024 * 1024, 1))
  await osShare(p, { files: [memo] })
  await expect(p.locator('[data-test="share-notice"]')).toContainText('‘big.mp4’ (51MB) is over 50MB and was not added.')
  await p.goto('/settings')
  await p.locator('[data-test="install-app"]').click()
  await expect(p.locator('[data-test="install-share-hint"]')).toHaveText("Add it to your phone's home screen and Process GPT appears in other apps' Share menu.")
  expect(p.errors).toEqual([])
  await p.context().close()
})
