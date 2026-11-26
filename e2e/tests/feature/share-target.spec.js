// 다른 앱의 「공유」로 Process GPT 에 넣기 (2026-11-26 사용자 휴대폰 녹화 — 「우리가 파일을 공유할 때 여기 앱으로 process GPT가 들어가면
// 좋겠어.」 · 「현재 열려있는 공간의 첨부를 바로 할 수 있겠지.」 · 「예를 들면 지금 현재 대화창이 열려 있다고 치면 팀 메시지에 여기에 곧바로
// 첨부를 할 수 있을 거야.」 — 스펙 openspec/specs/share-target). 지어낸 사람: 정하윤 · 김서연 · 박도윤, 단체방 「시니어그룹」.
// The real service worker (public/sw.js) runs in Chromium: what Android's share sheet does — a multipart POST to the manifest's
// share_target action, as a navigation — is done with a form the test submits (and once with fetch, following the 303), then:
//   F-ST-01 390px 밝은 · 밤: 단체방을 열어 둔 채 PDF 를 공유 → 「공유한 파일 1개를 ‘시니어그룹’에 넣을까요?」(파일 이름) · 아무것도 올라가지
//           않음 → 「넣기」 → 그 방의 입력창에 칩 · 「… 입력창에 넣었어요」 · 보내지 않음 → 한마디 쓰고 보내기 → 김서연이 같은 바이트를 받는다
//   F-ST-02 열린 곳이 없음(프로세스 지도) → 「어디에 넣을까요?」(대화 · 내 채팅 · 폴더) → 내 채팅 → 채팅 입력창에 칩과 글 · 보내지 않음
//   F-ST-03 글 · 주소만(fetch 로 POST → 303 을 따라감): 쓰던 말이 있는 대화방 → 묻는 창에 첫 줄 → 「넣기」 → 쓰던 말 뒤에 제목 · 글 · 주소
//   F-ST-04 50MB 넘는 파일: 묻는 창에 까닭, 같이 온 작은 파일만 칩 / 넘는 것만이면 알림만 / 200MB 넘는 본문은 「너무 커요」
//   F-ST-05 폴더를 열어 둠 → 「공유한 파일 1개를 ‘영업 자료’ 폴더에 넣을까요?」 → 넣기 → 폴더 main 에 그 파일 / 넣은 뒤 「다른 곳에」 →
//           올라가던 것이 멈추고(채팅 · 메신저) 칩이 빠지고 고르기
//   F-ST-06 받지 못한 공유(?share=failed · 없는 id) → 알림 · 설정 › 앱 설치: Android 에만 「다른 앱의 「공유」」 안내
//   F-ST-07 영어 화면: 묻는 창 · 「어디에 넣을까요?」 · 넣은 뒤의 막대 · 50MB 알림 · 설치 안내에 한글이 남지 않는다(사람이 지은 이름 · 파일 이름은 그대로)
//   F-ST-08 다른 사이트가 같은 폼을 보낸다(교차 사이트 POST, 「photo.jpg」가 text/html) → 묻는 창에 그 이름과 글 · 아무것도 올라가지 않음 · ✕ 면 끝
//           / 「넣기」를 누르면 종류는 확장자로(image/jpeg)
//   F-ST-09 30분 넘게 비운 곳 → 묻지 않고 「어디에 넣을까요?」에 「마지막으로 연 곳」으로 먼저
//   F-ST-10 다른 사람의 자리: 같은 휴대폰에 김서연이 로그인 → 정하윤의 방을 묻지 않음 · 로그아웃하면 자리 · 쓰던 말을 잊는다
// 자기 스택(lib/localStack.js — 회사 share-target-ui, RT_API_FROM · RT_WEB_FROM 부터 빈 포트, 기본 8974 · 5374)을 띄우고 지운다. 모델은 부르지 않는다.
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/share-target.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
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
// once: the session is put in on the first page only (a test that changes who is signed in, or signs out)
async function phone(browser, who, { theme = 'light', ua = ANDROID, lang = 'ko', once = false } = {}) {
  const ctx = await browser.newContext({ ...PHONE, userAgent: ua, baseURL: S.web, serviceWorkers: 'allow' })
  await ctx.addInitScript(([s, th, lg, one]) => {
    if (window.top !== window || !/^http:\/\/127\.0\.0\.1:/.test(location.href)) return
    if (!one || !sessionStorage.getItem('rt-seeded')) { localStorage.setItem('pgpt-pro-session', s); sessionStorage.setItem('rt-seeded', '1') }
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', lg)
    try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ }
  }, [JSON.stringify(who.session), theme, lang, once])
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
// (action: where to post when the page is not the app's — no manifest link to read it from)
async function osShare(p, { files = [], title = '', text = '', url = '', action: to = null } = {}) {
  const action = to || await p.evaluate(async () => {
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

// the uploads a page starts (the messenger's, the chat's): none may start before 「넣기」
function uploads(p) {
  const seen = []
  p.on('request', (r) => { if (/\/api\/(team\/uploads|attachments)$/.test(new URL(r.url()).pathname)) seen.push({ path: new URL(r.url()).pathname, type: r.headers()['x-file-type'] || r.headers()['content-type'] || '' }) })
  return seen
}
const asking = (p) => p.locator('[data-test="share-ask"]')
const putIt = (p) => p.locator('[data-test="share-put"]').click()
const lastPlace = (p) => p.evaluate(() => { const v = JSON.parse(localStorage.getItem('pgl-last-place') || 'null'); return v && { kind: v.kind, id: v.id } })

test('F-ST-01 휴대폰: 단체방을 열어 둔 채 PDF 를 공유하면 한 번 묻고(「넣기」) 그 방 입력창에 칩으로 — 보내기를 눌러야 김서연이 받는다', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const before = (await roomMessages(HY)).length
    const p = await phone(browser, HY, { theme })
    const up = uploads(p)
    await openRoom(p)
    await expect(p.locator('[data-test="msg-thread-head"] > b')).toHaveText('시니어그룹')
    // (the place is kept as its kind and id, whose and when)
    expect(await lastPlace(p)).toEqual({ kind: 'room', id: ROOM })
    expect(await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('pgl-last-place'))).sort())).toEqual(['at', 'id', 'kind', 't', 'uid'])
    await osShare(p, { files: [{ name: '하늘테크 견적서.pdf', mimeType: 'application/pdf', buffer: PDF }] })
    // one question first: what came, where it would go — nothing in the room, nothing going up
    const ask = asking(p)
    await expect(ask).toBeVisible()
    await expect(ask.locator('[data-test="share-ask-title"]')).toHaveText('공유한 파일 1개를 ‘시니어그룹’에 넣을까요?')
    await expect(ask.locator('[data-test="share-files"] li').first()).toContainText('하늘테크 견적서.pdf')
    await expect(ask).toHaveAttribute('data-kind', 'room')
    const ab = await ask.boundingBox()
    expect(ab.x).toBeGreaterThanOrEqual(0)
    expect(ab.x + ab.width).toBeLessThanOrEqual(390)
    expect(ab.y + ab.height).toBeLessThanOrEqual(844)
    await shot(p, `f-st-01a-ask-${theme}`)
    expect(up).toEqual([])
    await expect(p.locator('[data-test="msg-upload-chip"]')).toHaveCount(0)
    await putIt(p)
    await expect(ask).toHaveCount(0)
    // the room opens, with the file going up as a chip there
    await expect(p.locator('[data-test="msg-thread-head"] > b')).toHaveText('시니어그룹')
    await expect(upChip(p, '하늘테크 견적서.pdf')).toHaveAttribute('data-state', 'ready', { timeout: 20000 })
    expect(up.map((u) => [u.path, u.type])).toEqual([['/api/team/uploads', 'application/pdf']])
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
    const up = uploads(p)
    await p.goto('/process-map')
    await workerReady(p)
    await expect.poll(() => p.evaluate(() => localStorage.getItem('pgl-last-place'))).toBe(null)
    await osShare(p, { files: [{ name: '현장 사진.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-bytes') }], text: '오늘 현장 사진이에요' })
    const sheet = p.locator('[data-test="share-chooser"]')
    await expect(sheet).toBeVisible()
    await expect(asking(p)).toHaveCount(0)
    await expect(sheet).toContainText('어디에 넣을까요?')
    await expect(sheet.locator('[data-test="share-what"]')).toHaveText('현장 사진.jpg · 글')
    await expect(sheet.locator('[data-test="share-text"]')).toHaveText('오늘 현장 사진이에요')
    await expect(sheet.locator('[data-test="share-pick"][data-kind="room"]').first()).toContainText('시니어그룹')
    await expect(sheet.locator('[data-test="share-pick"][data-kind="chat"]')).toContainText('Process GPT 채팅')
    await expect(sheet.locator('[data-test="share-pick"][data-kind="folder"]').first()).toContainText('영업 자료')
    await expect(sheet.locator('[data-first]')).toHaveCount(0)
    await expect(sheet).toContainText('넣기만 하고 보내지는 않아요.')
    const sb = await sheet.boundingBox()
    expect(sb.x).toBeGreaterThanOrEqual(0)
    expect(sb.x + sb.width).toBeLessThanOrEqual(390)
    expect(sb.y + sb.height).toBeLessThanOrEqual(844)
    await shot(p, `f-st-02-chooser-${theme}`)
    expect(up).toEqual([])
    if (theme === 'dark') { await sheet.locator('[data-test="share-cancel"]').click(); await expect(sheet).toHaveCount(0); expect(up).toEqual([]); expect(p.errors).toEqual([]); await p.context().close(); continue }
    const mainBefore = await S.api(HY.token, '/threads').then(([t]) => S.api(HY.token, `/threads/${t.id}/messages`)).then((ms) => ms.length)
    // (a place picked here is the person's choice: it goes in at once)
    await sheet.locator('[data-test="share-pick"][data-kind="chat"]').click()
    await expect(sheet).toHaveCount(0)
    await expect(p).toHaveURL(/\/chat$/)
    await expect(chatChip(p, '현장 사진.jpg')).toHaveAttribute('data-state', 'ready', { timeout: 20000 })
    await expect(p.locator('.composer textarea')).toHaveValue('오늘 현장 사진이에요')
    await expect(p.locator('[data-test="share-placed"]')).toContainText('공유한 파일 1개와 글을 ‘Process GPT 채팅’ 입력창에 넣었어요.')
    expect(up.map((u) => u.path)).toEqual(['/api/attachments'])
    expect(await noOverflow(p)).toBe(true)
    await shot(p, 'f-st-02-chat-light')
    // nothing sent to the agent
    const mainAfter = await S.api(HY.token, '/threads').then(([t]) => S.api(HY.token, `/threads/${t.id}/messages`)).then((ms) => ms.length)
    expect(mainAfter).toBe(mainBefore)
    // and the chat is now the open place
    expect(await lastPlace(p)).toEqual({ kind: 'chat', id: '' })
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-ST-03 글 · 주소만 공유(fetch 로 POST → 303) — 쓰던 말이 있는 단체방: 묻는 창에 첫 줄, 넣으면 쓰던 말 뒤에 제목 · 글 · 주소', async ({ browser }) => {
  const p = await phone(browser, HY)
  await openRoom(p)
  // words being written in the room when the share comes (a share reloads the window: they come back — sessionStorage)
  await p.locator('.ms .cmp textarea').fill('회의 전에 같이 볼 것:')
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
  const ask = asking(p)
  await expect(ask.locator('[data-test="share-ask-title"]')).toHaveText('공유한 글을 ‘시니어그룹’에 넣을까요?')
  await expect(ask.locator('[data-test="share-text"]')).toHaveText('하늘테크 3분기 실적\n이 기사 같이 봐요')
  await expect(ask.locator('[data-test="share-files"]')).toHaveCount(0)
  await shot(p, 'f-st-03a-ask-text-light')
  await putIt(p)
  await expect(p.locator('[data-test="msg-thread-head"] > b')).toHaveText('시니어그룹')
  await expect(p.locator('.ms .cmp textarea')).toHaveValue(`회의 전에 같이 볼 것:\n하늘테크 3분기 실적\n이 기사 같이 봐요\n${url}`)
  await expect(p.locator('.ms [data-test="msg-upload-chip"]')).toHaveCount(0)
  await expect(p.locator('[data-test="share-placed"]')).toContainText('공유한 글을 ‘시니어그룹’ 입력창에 넣었어요.')
  await shot(p, 'f-st-03-text-room-light')
  // sent: the room's kept words go too
  await p.locator('[data-test="msg-send"]').click()
  await expect(p.locator('.ms .cmp textarea')).toHaveValue('')
  expect(await p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('pgl-msg-draft:')))).toEqual([])
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-ST-04 50MB 넘는 파일 — 묻는 창에 까닭, 같이 온 작은 파일만 칩 / 넘는 것만이면 알림만 / 200MB 넘는 본문은 「너무 커요」', async ({ browser }) => {
  // (Playwright passes a buffer up to 50MB only: the big one is a file on disk, its name the one shared)
  const big = path.join(test.info().outputPath(), '현장 영상.mp4')
  fs.mkdirSync(path.dirname(big), { recursive: true })
  fs.writeFileSync(big, Buffer.alloc(51 * 1024 * 1024, 1))
  const p = await phone(browser, HY)
  await openRoom(p)
  const memo = path.join(path.dirname(big), '메모.txt')
  fs.writeFileSync(memo, '현장 메모')
  await osShare(p, { files: [big, memo] })
  const ask = asking(p)
  await expect(ask.locator('[data-test="share-ask-title"]')).toHaveText('공유한 파일 1개를 ‘시니어그룹’에 넣을까요?')
  await expect(ask.locator('[data-test="share-skipped"]')).toHaveText('‘현장 영상.mp4’(51MB)는 50MB가 넘어서 넣지 못했어요.')
  await shot(p, 'f-st-04a-ask-oversize-light')
  await putIt(p)
  await expect(upChip(p, '메모.txt')).toHaveAttribute('data-state', 'ready', { timeout: 20000 })
  await expect(upChip(p, '현장 영상.mp4')).toHaveCount(0)
  const bar = p.locator('[data-test="share-placed"]')
  await expect(bar).toContainText('공유한 파일 1개를 ‘시니어그룹’ 입력창에 넣었어요.')
  await expect(bar).toContainText('‘현장 영상.mp4’(51MB)는 50MB가 넘어서 넣지 못했어요.')
  await shot(p, 'f-st-04-oversize-light')
  // only the big one: a line that says why — no question, no chooser, nothing in the box
  await p.locator('.ms .cmp [data-test="msg-upload-chip"] button').click()
  await osShare(p, { files: [big] })
  const note = p.locator('[data-test="share-notice"]')
  await expect(note).toContainText('‘현장 영상.mp4’(51MB)는 50MB가 넘어서 넣지 못했어요.')
  await expect(asking(p)).toHaveCount(0)
  await expect(p.locator('[data-test="share-chooser"]')).toHaveCount(0)
  await expect(p.locator('[data-test="share-placed"]')).toHaveCount(0)
  await shot(p, 'f-st-04-oversize-only-light')
  // a body over 200MB in all: the worker does not read it — 「너무 커요」, nothing kept
  const parts = []
  for (let i = 0; i < 5; i++) { const f = path.join(path.dirname(big), `영상 ${i}.mp4`); fs.writeFileSync(f, Buffer.alloc(41 * 1024 * 1024, 2)); parts.push(f) }
  await osShare(p, { files: parts })
  await expect(note).toContainText('공유한 파일이 너무 커요. 한 번에 200MB까지 받을 수 있어요.')
  expect(await p.evaluate(async () => (await (await caches.open('pgl-share-v1')).keys()).length)).toBe(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-ST-05 폴더를 열어 둠 → 「넣기」 → main 에 그 파일 / 넣은 뒤 「다른 곳에」 → 올라가던 것이 멈추고 칩이 빠지고 고르기', async ({ browser }) => {
  const p = await phone(browser, HY)
  await p.goto(`/folders/${FOLDER.slug}`)
  await workerReady(p)
  await expect(p.locator('[data-test="folder-detail"]')).toBeVisible()
  await osShare(p, { files: [{ name: '제안서 초안.pdf', mimeType: 'application/pdf', buffer: PDF }], text: '폴더에 넣어 둘게요' })
  const ask = asking(p)
  await expect(ask.locator('[data-test="share-ask-title"]')).toHaveText('공유한 파일 1개를 ‘영업 자료’ 폴더에 넣을까요?')
  await expect(ask).toContainText('제안서 초안.pdf')
  await expect(ask).toContainText('함께 온 글은 폴더에 넣지 않아요.')
  await expect(ask).toHaveAttribute('data-kind', 'folder')
  await shot(p, 'f-st-05-folder-ask-light')
  // not in the folder until the person says so
  expect((await S.api(HY.token, `/folders/${FOLDER.slug}/tree`)).some((f) => f.path === '제안서 초안.pdf')).toBe(false)
  await putIt(p)
  await expect(p).toHaveURL(new RegExp(`/folders/${FOLDER.slug}$`))
  await expect.poll(async () => (await S.api(HY.token, `/folders/${FOLDER.slug}/tree`)).some((f) => f.path === '제안서 초안.pdf'), { timeout: 20000 }).toBe(true)
  await expect(p.locator('[data-test="folder-detail"]')).toContainText('제안서 초안.pdf')
  await shot(p, 'f-st-05-folder-done-light')
  // the room: 「넣기」, the upload held on the way (a slow line) — 「다른 곳에」 stops it, its chip and words go, the chooser asks, my chat takes it
  await openRoom(p)
  const failed = []
  p.on('requestfailed', (r) => failed.push(new URL(r.url()).pathname))
  await p.route('**/api/team/uploads', () => { /* held: never answered */ })
  await osShare(p, { files: [{ name: '회의 메모.txt', mimeType: 'text/plain', buffer: Buffer.from('다음 주 화요일') }], text: '회의 메모예요' })
  await putIt(p)
  await expect(upChip(p, '회의 메모.txt')).toHaveAttribute('data-state', 'uploading')
  await expect(p.locator('.ms .cmp textarea')).toHaveValue('회의 메모예요')
  await p.locator('[data-test="share-elsewhere"]').click()
  await expect(upChip(p, '회의 메모.txt')).toHaveCount(0)
  await expect(p.locator('.ms .cmp textarea')).toHaveValue('')
  await expect.poll(() => failed.includes('/api/team/uploads')).toBe(true)
  const sheet = p.locator('[data-test="share-chooser"]')
  await expect(sheet).toBeVisible()
  // the chat's upload held too: 「다른 곳에」 from the chat stops it as well
  await p.route('**/api/attachments', () => { /* held */ })
  await sheet.locator('[data-test="share-pick"][data-kind="chat"]').click()
  await expect(p.locator('.ms')).toHaveCount(0)
  await expect(chatChip(p, '회의 메모.txt')).toHaveAttribute('data-state', 'uploading')
  await expect(p.locator('.composer textarea')).toHaveValue('회의 메모예요')
  await p.locator('[data-test="share-elsewhere"]').click()
  await expect(chatChip(p, '회의 메모.txt')).toHaveCount(0)
  await expect(p.locator('.composer textarea')).toHaveValue('')
  await expect.poll(() => failed.includes('/api/attachments')).toBe(true)
  await p.locator('[data-test="share-chooser"] [data-test="share-cancel"]').click()
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-ST-06 받지 못한 공유는 그렇다고 알린다 · 설정 › 앱 설치에는 Android 에만 「공유」 안내', async ({ browser }) => {
  const p = await phone(browser, HY)
  await p.goto('/chat?share=failed')
  await expect(p.locator('[data-test="share-notice"]')).toContainText('공유한 내용을 받지 못했어요. 다시 공유해 주세요.')
  expect(new URL(p.url()).search).toBe('')
  await p.goto('/chat?share=failed:big')
  await expect(p.locator('[data-test="share-notice"]')).toContainText('공유한 파일이 너무 커요. 한 번에 200MB까지 받을 수 있어요.')
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

test('F-ST-07 영어 화면 — 묻는 창 · 고르기 · 넣은 뒤의 막대 · 넘친 파일 알림 · 설치 안내가 영어로', async ({ browser }) => {
  // (what people named — the room, the folder, the files — stays as written)
  const mine = /시니어그룹|영업 자료|현장 사진\.jpg|정하윤|김서연|박도윤/g
  const hangul = async (loc) => ((await loc.innerText()).replace(mine, '').match(/[가-힣]+/g) || [])
  const p = await phone(browser, HY, { lang: 'en' })
  await openRoomEn(p)
  await osShare(p, { files: [{ name: '현장 사진.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-bytes') }], text: 'site photo' })
  const ask = asking(p)
  await expect(ask.locator('[data-test="share-ask-title"]')).toHaveText('Add 1 shared file(s) and text to ‘시니어그룹’?')
  expect(await hangul(ask)).toEqual([])
  await shot(p, 'f-st-07a-ask-en')
  await p.locator('[data-test="share-ask-elsewhere"]').click()
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
async function openRoomEn(p) {
  await p.goto('/chat')
  await workerReady(p)
  await p.locator('.seg button').filter({ hasText: /^Home$/ }).click()
  await p.locator('button.msgs').click()
  await p.locator('.ms').waitFor()
  await p.locator('.ms .tabs button').nth(1).click()
  await p.locator('.ms .th').filter({ has: p.locator('.nm b', { hasText: /^시니어그룹$/ }) }).first().click()
  await p.locator('.ms .cmp textarea').waitFor()
}

test('F-ST-08 다른 사이트가 같은 폼을 보낸다 — 묻는 창에 그 이름과 글, 아무것도 올라가지 않음, ✕ 면 끝 / 넣으면 종류는 확장자로', async ({ browser }) => {
  // another site (another origin: localhost vs the app's 127.0.0.1) with the share form, as the reviewer's probe: a page's bytes named photo.jpg
  const evil = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset=utf-8><meta name=referrer content=no-referrer><body>
<form id=f method=post enctype=multipart/form-data action="${S.web}/share-target"><input name=title value="Invoice"><input name=text value="please pay https://evil.example/x"><input type=file name=files id=i></form>
<script>window.go = () => { const dt = new DataTransfer(); dt.items.add(new File(['<script>alert(1)<\\/script>'], 'photo.jpg', { type: 'text/html' })); i.files = dt.files; f.submit() }</script>`)
  })
  await new Promise((r) => evil.listen(0, '127.0.0.1', r))
  try {
    const before = (await roomMessages(HY)).length
    const p = await phone(browser, HY)
    const up = uploads(p)
    await openRoom(p)
    for (const attempt of ['close', 'put']) {
      if (attempt === 'put') await openRoom(p)
      await p.goto(`http://localhost:${evil.address().port}/`)
      await Promise.all([p.waitForURL((u) => u.origin === S.web && /\/chat$/.test(u.pathname), { timeout: 30000 }), p.evaluate(() => window.go())])
      const ask = asking(p)
      await expect(ask.locator('[data-test="share-ask-title"]')).toHaveText('공유한 파일 1개와 글을 ‘시니어그룹’에 넣을까요?')
      await expect(ask.locator('[data-test="share-files"]')).toContainText('photo.jpg')
      // (the words' first lines, as they came — the address in them too)
      await expect(ask.locator('[data-test="share-text"]')).toHaveText('Invoice\nplease pay https://evil.example/x')
      // nothing in the room's box, nothing going up, the messenger not even opened
      await expect(p.locator('.ms')).toHaveCount(0)
      expect(up).toEqual([])
      if (attempt === 'close') {
        await shot(p, 'f-st-08-cross-site-ask-light')
        await ask.locator('[data-test="share-cancel"]').click()
        await expect(ask).toHaveCount(0)
        await p.waitForTimeout(800)
        expect(up).toEqual([])
        expect(await p.evaluate(async () => (await (await caches.open('pgl-share-v1')).keys()).length)).toBe(0)
        continue
      }
      // one who does press 「넣기」: the file goes up as a picture by its name — never as the page it claimed to be
      await putIt(p)
      await expect(upChip(p, 'photo.jpg')).toHaveAttribute('data-state', 'ready', { timeout: 20000 })
      expect(up.map((u) => [u.path, u.type])).toEqual([['/api/team/uploads', 'image/jpeg']])
      await expect(p.locator('.ms .cmp textarea')).toHaveValue('Invoice\nplease pay https://evil.example/x')
    }
    expect((await roomMessages(HY)).length).toBe(before)
    expect(p.errors).toEqual([])
    await p.context().close()
  } finally { evil.close() }
})

test('F-ST-09 30분 넘게 비운 곳 → 묻지 않고 「어디에 넣을까요?」에 「마지막으로 연 곳」으로 먼저', async ({ browser }) => {
  const p = await phone(browser, HY)
  await openRoom(p)
  // the app goes to the background (its visibilitychange keeps the room as open now) … and the room was left 31 minutes ago: the share comes
  // into a window with no app in it (as when the app's window, hidden for a while, is navigated by the share)
  await p.goto(`${S.web}/manifest.webmanifest`)
  expect(await lastPlace(p)).toEqual({ kind: 'room', id: ROOM })
  await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('pgl-last-place')); v.at = Date.now() - 31 * 60_000; localStorage.setItem('pgl-last-place', JSON.stringify(v)) })
  await osShare(p, { action: '/share-target', files: [{ name: '견적 비교.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK fake') }] })
  await expect(asking(p)).toHaveCount(0)
  const sheet = p.locator('[data-test="share-chooser"]')
  await expect(sheet).toBeVisible()
  const first = sheet.locator('[data-test="share-pick"]').first()
  await expect(first).toHaveAttribute('data-first', '1')
  await expect(first).toHaveAttribute('data-kind', 'room')
  await expect(first).toContainText('시니어그룹')
  await expect(first).toContainText('단체방 · 3명')
  await expect(sheet.locator('.sec').first()).toHaveText('마지막으로 연 곳')
  await expect(sheet.locator('[data-test="share-pick"][data-kind="room"]')).toHaveCount(1)
  await shot(p, 'f-st-09-idle-chooser-light')
  await first.click()
  await expect(upChip(p, '견적 비교.xlsx')).toHaveAttribute('data-state', 'ready', { timeout: 20000 })
  await p.locator('.ms .cmp [data-test="msg-upload-chip"] button').click()
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-ST-10 다른 사람의 자리 — 같은 휴대폰에 김서연이 로그인하면 정하윤의 방을 묻지 않고, 로그아웃하면 자리 · 쓰던 말을 잊는다', async ({ browser }) => {
  const p = await phone(browser, HY, { once: true })
  await openRoom(p)
  await p.locator('.ms .cmp textarea').fill('정하윤이 쓰던 말')
  await expect.poll(() => p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('pgl-msg-draft:')).length)).toBe(1)
  // 김서연 signs in on the same phone (the session replaced, the kept place left as it was)
  await p.evaluate((s) => localStorage.setItem('pgpt-pro-session', s), JSON.stringify(SY.session))
  await osShare(p, { files: [{ name: '사진.png', mimeType: 'image/png', buffer: Buffer.from('png') }] })
  await expect(asking(p)).toHaveCount(0)
  const sheet = p.locator('[data-test="share-chooser"]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('[data-first]')).toHaveCount(0)
  await sheet.locator('[data-test="share-cancel"]').click()
  // back to 정하윤, who signs out: the places, a waiting share and the unsent words are forgotten on this device
  await p.evaluate((s) => localStorage.setItem('pgpt-pro-session', s), JSON.stringify(HY.session))
  await openRoom(p)
  await expect(p.locator('.ms .cmp textarea')).toHaveValue('정하윤이 쓰던 말')
  await p.goto('/settings')
  await Promise.all([p.waitForURL(/\/login/), p.locator('.danger').filter({ hasText: '로그아웃' }).click()])
  expect(await p.evaluate(() => ['pgl-last-place', 'pgl-recent-folders', 'pgl-share-pending'].map((k) => localStorage.getItem(k)))).toEqual([null, null, null])
  expect(await p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('pgl-msg-draft:')))).toEqual([])
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-ST-11 ProcessGPT 의 다른 사람 세션을 넘겨받으면(게이트웨이) 앞 사람의 자리 · 기다리는 공유 · 쓰던 말을 잊는다', async ({ browser }) => {
  const p = await phone(browser, HY, { once: true })
  await openRoom(p)
  await p.locator('.ms .cmp textarea').fill('정하윤의 초안')
  await expect.poll(() => p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('pgl-msg-draft:')).length)).toBe(1)
  expect(await lastPlace(p)).toEqual({ kind: 'room', id: ROOM })
  // ProcessGPT (the gateway) hands over 김서연's session in its cookies: Lite takes it (src/api.js adoptHostSession)
  const host = new URL(S.web).hostname
  await p.context().addCookies([{ name: 'access_token', value: SY.session.session.access_token, domain: host, path: '/' }, { name: 'refresh_token', value: SY.session.session.refresh_token, domain: host, path: '/' }])
  await p.goto('/folders')
  await expect.poll(() => p.evaluate(() => JSON.parse(localStorage.getItem('pgpt-pro-session'))?.host === true)).toBe(true)
  expect(await p.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('pgl-msg-draft:')))).toEqual([])
  const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('pgl-last-place') || 'null'))
  expect(kept?.uid).not.toBe(HY.id)
  expect(p.errors).toEqual([])
  await p.context().close()
})
