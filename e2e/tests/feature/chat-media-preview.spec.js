// 대화 속 그림 · 소리 · 영상 (스펙 openspec/specs/chat-media-preview). 운영 메신저(2026-11-25, 휴대폰 폭 시트 · 밤 테마)에서 받은
// download.m4a 는 회색 FILE 칩과 빨간 「⚠ 앱 안에서 열 수 없는 형식이에요. 새 창에서 열기」뿐이었고, 공유된 image.png 는 보라 IMG 칩과
// 「⚠ 이 설치에는 PhotoCraft 앱이 없어 앱 안에서 열 수 없어요. 새 창에서 열기」뿐이었다. 사용자: 「대화창안에서 기본적인 음성 / 이미지가
// 미리보기 등의 출력이 안되다니.. 포토크래프트등의 편집기는 편집의 의도가 있을따만 시도하는 것이고.」
// 지어낸 사람: 윤태호(보내는 사람) · 한지민(받는 사람) · 서민재(그 대화방에 없는 동료).
//   F-MP-01 메신저: 그림 미리보기가 불러와지고(naturalWidth), 소리 · 영상 플레이어가 길이를 읽고, 칩은 IMG · AUD · VID, 경고 상자 없음, 구간 요청 206
//   F-MP-02 미리보기를 누르면 앱의 보기 화면(편집기 · 문서 패널이 아님) — Esc · 바깥 누르기로 닫히고 메신저는 그대로
//   F-MP-03 「PhotoCraft 로 편집」(이 설치에 PhotoCraft 가 있을 때만) → 문서 패널에 PhotoCraft, 받은 그림이 그 안으로
//   F-MP-04 PhotoCraft 가 없는 설치(/api/config): 보기 화면에 편집 단추 · 경고가 없음 · 소리와 영상도 편집 단추 없음, 볼 수 없는 zip 은 차분한 안내
//   F-MP-05 AI 채팅의 파일 카드: 미리보기 · 플레이어 · 「눌러서 크게 보기」 → 보기 화면 → 「PhotoCraft 로 편집」 → PhotoCraft
//   F-MP-06 미디어 주소: 받은 사람 · 보낸 사람만(대화방 밖 404 · 로그인 없이 401), 그림 · 소리 · 영상은 새 창에서 그 자리에서(inline), zip 은 내려받기;
//           화면이 쓰는 주소는 15분짜리 서명 주소(로그인 토큰 없음) — 200 · 206, 바꾼 주소 403, 만료 401, 남의 사람으로 서명해도 404
//   F-MP-07 휴대폰 390px 밝은 · 밤: 메시지 안에 들어가고 옆으로 넘치지 않음, 보기 화면의 단추가 화면 안
//   F-MP-08 서명이 맞아도 권한은 다시: 팀에서 빠지면 403, 공유를 거두면 404 — 화면의 미리보기는 차분한 「미리 볼 수 없어요」
//   F-MP-09 팩스(TIFF — 2026-11-25 「tif 파일을 웹에서 못 열어보나?」): 메신저 미리보기는 첫 쪽 · 「2쪽」, 보기 화면 ‹ 1 / 2 › → 2쪽, 캔버스가 빈
//           그림이 아님(검은 점), 누르면 확대, ← 로 앞쪽 · 손상된 · 거대한 TIFF 는 차분한 「이 TIFF 는 열 수 없어요 · 내려받기」 · 해독기는 TIFF 가
//           화면에 나올 때만 받는다
//   F-MP-10 AI 채팅에 붙인 팩스: 파일 카드 IMG · 「눌러서 크게 보기」 · 첫 쪽 미리보기 → 보기 화면 2쪽까지 · 서버는 쪽마다 PNG 를 비공개로(서명 주소 ·
//           작업 공간의 같은 폴더) — 에이전트가 읽을 그림
//   F-MP-11 휴대폰 390px 밝은 · 밤: 팩스 미리보기 · 보기 화면(한 쪽이 화면 폭에 맞아 통째로 보임) · 쪽 넘기기 단추가 화면 안, 옆으로 넘치지 않음
// TIFF 시험 파일은 e2e/fixtures/tiff (server/fixtures/tiff 와 같은 파일 — 만든 방법은 server/fixtures/tiff/make.py).
// 모든 화면 단계에서 그림 · 소리 · 영상의 주소와 「새 창에서 열기」에 로그인 토큰(token= · eyJ…)이 없는지 본다.
// 자기 스택(lib/localStack.js: 회사 chatmedia-ui 의 BFF + Vite, 8900 · 5300 부터 빈 포트)을 띄우고 지운다. 모델 · 공용 서비스는 부르지 않는다
// (deepagents · completion · 맥락 라우터는 아무 데도 아닌 주소). PhotoCraft 는 시험용 껍데기(PRO_CRAFT_WEB_ROOT: 캔버스 하나, 놓인 파일 이름을
// 적어 둠) — 진짜 앱은 F-CR-* 가 본다. 소리 · 영상 · 그림은 ffmpeg 로 만든 진짜 파일.
//   cd e2e && npx playwright test --project=feature tests/feature/chat-media-preview.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startStack, REPO, SERVER } from '../../lib/localStack.js'
import { linkKey, signLink, linkPath } from '../../../server/lib/team/mediaLink.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/chat-media-preview/e2e/results')
const DESK = { viewport: { width: 1280, height: 900 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'chatmedia-ui'

// real files (ffmpeg): a test-card picture, two seconds of tone as AAC in M4A, two seconds of video with sound
function media(kind) {
  const out = path.join(os.tmpdir(), `rt-mp-${process.pid}-${Date.now()}.${kind}`)
  const args = {
    png: ['-f', 'lavfi', '-i', 'testsrc2=size=640x400', '-frames:v', '1', out],
    m4a: ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', '-b:a', '64k', out],
    mp4: ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out],
  }[kind]
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args])
  const b = fs.readFileSync(out); fs.rmSync(out, { force: true }); return b
}
// the fax of the report (KT 스마트메시지 Plus, 2026-11-25): two CCITT G4 pages at 204 × 98 dpi; a damaged TIFF; one that claims 50000 × 50000
const tif = (n) => fs.readFileSync(path.join(REPO, 'e2e/fixtures/tiff', n))
const FAX = { name: 'arrive_xroshotplus_uengine1_20261125095030049_121017596357694.tif', type: 'image/tiff', buf: tif('fax-2p-g4.tif') }
const BAD = { name: '팩스_손상.tif', type: 'image/tiff', buf: tif('broken.tif') }
const BIG = { name: '거대한_스캔.tif', type: '', buf: tif('giant.tif') }
// what the recording showed: image.png (typed), download.m4a (stored without a type — the name decides), a video; and a zip
const IMG = { name: 'image.png', type: 'image/png' }
const M4A = { name: 'download.m4a', type: '' }
const MP4 = { name: '영상 개요.mp4', type: 'video/mp4' }
const ZIP = { name: '현장사진_묶음.zip', type: 'application/zip', buf: Buffer.from('PK\u0005\u0006' + '\u0000'.repeat(18), 'latin1') }

// the stand-in PhotoCraft: a canvas that keeps the name of the file dropped on it (CraftEditorFrame drops the file there)
const CRAFT_STUB = `<!doctype html><html><head><meta charset="utf-8"><title>PhotoCraft (시험용)</title></head>
<body style="margin:0;background:#22282f;color:#fff;font:14px sans-serif"><p style="margin:12px">PhotoCraft 시험용 껍데기</p>
<canvas width="400" height="240" style="background:#333;display:block;margin:12px"></canvas>
<script>const c=document.querySelector('canvas');for(const t of ['dragenter','dragover'])c.addEventListener(t,(e)=>e.preventDefault());
c.addEventListener('drop',(e)=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f){document.body.dataset.dropped=f.name;document.querySelector('p').textContent='열린 파일: '+f.name}})</script></body></html>`

let S, TH, JM, MJ, room, craftRoot
const keys = []

async function rawPost(token, p, buf, headers) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api${p}`, { method: 'POST', body: buf, headers: { Authorization: `Bearer ${token}`, ...headers } })
  const t = await r.text()
  if (!r.ok) throw new Error(`POST ${p} → ${r.status} ${t.slice(0, 200)}`)
  return JSON.parse(t)
}
const raw = (p, token, headers = {}) => fetch(`http://127.0.0.1:${S.apiPort}/api${p}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } })

async function page(browser, who, opts, { theme = null, noCraft = false } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    if (th) localStorage.setItem('pgpt-pro-theme', th)
    try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ }
  }, [JSON.stringify(who.session), theme])
  // an install without the ArtCraft web apps (the Docker lite profile): what /api/config says there
  if (noCraft) {
    await ctx.route('**/api/config', async (r) => {
      const res = await r.fetch()
      const j = await res.json()
      for (const k of Object.keys(j.craft || {})) j.craft[k] = { ...j.craft[k], web: false }
      await r.fulfill({ response: res, json: j })
    })
  }
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const viewer = (p) => p.locator('[data-test="media-viewer"]')
const chip = (p, f) => p.locator(`.ms [data-test="msg-file"][data-file="${f.name}"]`).last()
const preview = (p, f) => p.locator(`.ms [data-test="media-preview"][data-file="${f.name}"]`).last()
async function openThread(p, title, { phone = false } = {}) {
  if (phone) {
    await p.locator('.seg button').filter({ hasText: '홈' }).click()
    await p.locator('button.msgs').click()
  } else await p.locator('button.msg-btn').click()
  await p.locator('.ms').waitFor()
  await p.locator('.ms .tabs button').filter({ hasText: '대화' }).click()
  await p.locator('.ms .th').filter({ hasText: title }).first().click()
  await p.locator('.ms .cmp textarea').waitFor()
}
// a picture that has loaded (lazy: once it is near the screen)
const loaded = (img) => expect.poll(() => img.evaluate((i) => (i.complete ? i.naturalWidth : 0)), { timeout: 15000 }).toBeGreaterThan(0)
// a sound or a video whose length the browser read: its metadata asked for (the sound's player waits to be pressed otherwise)
const duration = (el) => el.evaluate((a) => new Promise((ok) => {
  if (a.readyState >= 1 && a.duration) return ok({ duration: a.duration })
  const t = setTimeout(() => ok({ err: `timeout ${a.networkState}/${a.readyState} ${a.error?.code || ''}` }), 15000)
  a.addEventListener('loadedmetadata', () => { clearTimeout(t); ok({ duration: a.duration }) }, { once: true })
  a.addEventListener('error', () => { clearTimeout(t); ok({ err: `error ${a.error?.code || ''}` }) }, { once: true })
  a.preload = 'metadata'
  a.load()
}))
// (for a picture: the message from its file chips down)
const top = (loc, block = 'start') => loc.evaluate((el, b) => el.scrollIntoView({ block: b }), block)
// no sign-in token in any address of a picture · sound · video or a link on the page (it would land in proxy logs and history)
async function noToken(p) {
  const addrs = await p.evaluate(() => [...document.querySelectorAll('img[src], audio[src], video[src], source[src], a[href]')].map((e) => e.getAttribute('src') || e.getAttribute('href')))
  const media = addrs.filter((a) => /\/team\/shares\//.test(a))
  for (const a of addrs) { expect(a).not.toMatch(/[?&]token=/); expect(a).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/) }
  return media
}
const inScreen = async (loc, width) => { const b = await loc.boundingBox(); expect(b.x).toBeGreaterThanOrEqual(-0.5); expect(b.x + b.width).toBeLessThanOrEqual(width + 0.5) }

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  for (const f of [IMG, M4A, MP4]) f.buf = media(f.name.split('.').pop())
  craftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-craftweb-'))
  fs.mkdirSync(path.join(craftRoot, 'photocraft'))
  fs.writeFileSync(path.join(craftRoot, 'photocraft', 'index.html'), CRAFT_STUB)
  // (RT_API_FROM · RT_WEB_FROM: where to look for free ports when other stacks run on this machine)
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8900, webFrom: Number(process.env.RT_WEB_FROM) || 5300, env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_CRAFT_WEB_ROOT: craftRoot } })
  TH = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '윤태호')
  JM = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '한지민')
  MJ = await S.person(`pro-rt-${TENANT}-c@uengine.org`, '서민재')
  for (const p of [TH, JM, MJ]) { await S.join(p); await S.api(p.token, '/team') }
  await cleanData()
  // 윤태호 → 한지민: the three files of the recording in one message (sent from the computer, the way the messenger sends them), a zip in another
  room = (await S.api(TH.token, '/team/threads', { method: 'POST', body: { members: [JM.id] } })).id
  const up = async (f) => (await rawPost(TH.token, '/team/uploads', f.buf, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name), 'X-File-Type': f.type })).id
  const ids = []
  for (const f of [IMG, M4A, MP4]) ids.push(await up(f))
  await S.api(TH.token, `/team/threads/${room}/messages`, { method: 'POST', body: { text: '현장 사진 · 녹음 · 영상이에요', artifactIds: ids } })
  await S.api(TH.token, `/team/threads/${room}/messages`, { method: 'POST', body: { text: '나머지는 묶어서 보내요', artifactIds: [await up(ZIP)] } })
  // 한지민's own AI chat: the same three as file cards (what an agent or an attachment leaves there)
  const [main] = await S.api(JM.token, '/threads')
  for (const f of [IMG, M4A, MP4]) {
    const a = await rawPost(JM.token, '/attachments', f.buf, { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) })
    await S.q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'agent', 'file', $2)`, [main.id, { name: a.name, url: a.url, ...(f.type ? { type: f.type } : {}) }])
  }
})

// everything this file made: the room, its messages and shares, the people's chats, the stored files, the stand-in app
async function cleanData() {
  const people = [TH, JM, MJ].filter(Boolean).map((p) => p.id)
  const { admin } = await import(path.join(SERVER, 'lib/supa.js'))
  const urls = await S.q(`select content->>'url' as url from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id = any($1::uuid[]) and m.kind='file'`, [people]).catch(() => [])
  for (const { url } of urls) { const k = /\/object\/public\/files\/(.+)$/.exec(url || '')?.[1]; if (k) keys.push(decodeURIComponent(k)) }
  if (keys.length) await admin.storage.from('files').remove([...new Set(keys)]).catch(() => {})
  keys.length = 0
  // a chat-attached TIFF's page pictures (private: chat/<tenant>/…)
  const priv = (await S.q(`select name from storage.objects where bucket_id='lite-private' and starts_with(name, $1)`, [`chat/${TENANT}/`]).catch(() => [])).map((x) => x.name)
  if (priv.length) await admin.storage.from('lite-private').remove(priv).catch(() => {})
  const objs = await admin.storage.from('files').list(`artifacts/${TENANT}/objects`, { limit: 1000 }).catch(() => ({ data: [] }))
  if (objs.data?.length) await admin.storage.from('files').remove(objs.data.map((o) => `artifacts/${TENANT}/objects/${o.name}`)).catch(() => {})
  for (const sql of [
    'delete from pro_shares where tenant_id=$1',
    'delete from chats where tenant_id=$1',
    'delete from pro_chat_reads where room_id in (select id from chat_rooms where tenant_id=$1)',
    'delete from chat_rooms where tenant_id=$1',
  ]) await S.q(sql, [TENANT]).catch(() => {})
  await S.q('delete from notifications where user_id::text = any($1::text[])', [people]).catch(() => {})
  await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id = any($1::uuid[]))', [people]).catch(() => {})
  await S.q(`delete from pro_threads where user_id = any($1::uuid[]) and kind <> 'chat'`, [people]).catch(() => {})
}
test.afterAll(async () => {
  if (S) {
    await cleanData().catch(() => {})
    // (a chat attachment is put in the agent's workspace too, under this company's folder: only this test's company)
    const { PGPT_ROOT } = await import(path.join(SERVER, 'lib/paths.js'))
    fs.rmSync(path.join(PGPT_ROOT, 'services', 'deepagents', 'workspace', TENANT), { recursive: true, force: true })
    await S.stop()
  }
  if (craftRoot) fs.rmSync(craftRoot, { recursive: true, force: true })
})

let desk
test('F-MP-01 메신저: 그림은 미리보기로, 소리 · 영상은 그 자리 플레이어로 — 칩은 IMG · AUD · VID, 경고 상자 없음, 구간 요청은 206', async ({ browser }) => {
  desk = await page(browser, JM, DESK)
  await desk.goto('/chat')
  await openThread(desk, '윤태호')
  await expect(chip(desk, IMG).locator('.fic')).toHaveText('IMG')
  await expect(chip(desk, M4A).locator('.fic')).toHaveText('AUD')
  await expect(chip(desk, MP4).locator('.fic')).toHaveText('VID')
  // the picture: a bounded thumbnail that keeps its shape (640×400), loaded
  const img = preview(desk, IMG).locator('img')
  await expect(img).toBeVisible({ timeout: 15000 })
  await loaded(img)
  const b = await img.boundingBox()
  expect(b.width).toBeLessThanOrEqual(240.5)
  expect(Math.abs(b.width / b.height - 640 / 400)).toBeLessThan(0.05)
  // the frame is the picture (no empty band beside it)
  expect(Math.abs((await preview(desk, IMG).locator('button').boundingBox()).width - b.width)).toBeLessThan(2)
  await expect(img).toHaveAttribute('loading', 'lazy')
  // the sound: the browser's player, its length read; the video: its player, playing in place
  const audio = preview(desk, M4A).locator('audio')
  await expect(audio).toBeVisible()
  await expect(audio).toHaveAttribute('controls', '')
  const a = await duration(audio)
  expect(a.err).toBeUndefined()
  expect(a.duration).toBeGreaterThan(1)
  const video = preview(desk, MP4).locator('video')
  await expect(video).toHaveAttribute('playsinline', '')
  const v = await duration(video)
  expect(v.err).toBeUndefined()
  expect(v.duration).toBeGreaterThan(1)
  // a seek asks for a part: the share's address answers 206 with the part
  const src = await audio.getAttribute('src')
  // signed for her, 15 minutes — no sign-in token in it
  expect(src).toMatch(new RegExp(`/api/team/shares/[0-9a-f-]{36}/raw\\?u=${JM.id}&exp=\\d+&inline=1&sig=[A-Za-z0-9_-]{43}$`))
  expect((await noToken(desk)).length).toBeGreaterThanOrEqual(3)
  const part = await desk.request.get(src, { headers: { Range: 'bytes=0-99' } })
  expect(part.status()).toBe(206)
  expect(part.headers()['content-range']).toMatch(/^bytes 0-99\//)
  expect(part.headers()['content-type']).toBe('audio/mp4')
  expect((await part.body()).length).toBe(100)
  // no warning anywhere in the room
  await expect(desk.locator('.ms [data-test="open-note"]')).toHaveCount(0)
  await expect(desk.locator('.ms').getByText('앱 안에서 열 수 없')).toHaveCount(0)
  await top(chip(desk, IMG))
  await shot(desk, 'mp01-messenger-media')
  expect(desk.errors).toEqual([])
})

test('F-MP-02 미리보기 · 칩을 누르면 앱의 보기 화면(편집기가 아님) — Esc · 바깥을 누르면 닫히고 메신저는 그대로', async () => {
  await preview(desk, IMG).locator('button').click()
  await expect(viewer(desk)).toBeVisible()
  await expect(viewer(desk)).toHaveAttribute('data-kind', 'image')
  await expect(viewer(desk).locator('.nm')).toHaveText(IMG.name)
  await loaded(viewer(desk).locator('[data-test="media-full"]'))
  // looking, not editing: no ArtCraft frame, no document panel
  await expect(desk.locator('.cef')).toHaveCount(0)
  await expect(desk.locator('[data-test="office-sheet"]')).toHaveCount(0)
  await expect(viewer(desk).locator('[data-test="media-open"]')).toHaveAttribute('target', '_blank')
  await expect(viewer(desk).locator('[data-test="media-open"]')).toHaveAttribute('href', /\/raw\?u=.*&sig=/)
  await noToken(desk)
  await shot(desk, 'mp02-viewer')
  // the picture pressed: its own size (scrolls), pressed again: fits
  await viewer(desk).locator('[data-test="media-full"]').click()
  await expect(viewer(desk).locator('.stage')).toHaveClass(/zoom/)
  await viewer(desk).locator('[data-test="media-full"]').click()
  await expect(viewer(desk).locator('.stage')).not.toHaveClass(/zoom/)
  await desk.keyboard.press('Escape')
  await expect(viewer(desk)).toHaveCount(0)
  // the floating messenger is still open (Esc closed only the viewer)
  await expect(desk.locator('.ms')).toBeVisible()
  // the chip opens it too; a press outside the picture closes it
  await chip(desk, IMG).click()
  await expect(viewer(desk)).toBeVisible()
  await desk.mouse.click(6, 450)
  await expect(viewer(desk)).toHaveCount(0)
  await expect(desk.locator('.ms')).toBeVisible()
  // the sound and the video: the viewer plays them; no editor for m4a, and this install has no FilmCraft
  for (const [f, kind] of [[M4A, 'audio'], [MP4, 'video']]) {
    await chip(desk, f).click()
    await expect(viewer(desk)).toHaveAttribute('data-kind', kind)
    const d = await duration(viewer(desk).locator('[data-test="media-full"]'))
    expect(d.err).toBeUndefined()
    await expect(viewer(desk).locator('[data-test="media-edit"]')).toHaveCount(0)
    await viewer(desk).locator('[data-test="media-close"]').click()
    await expect(viewer(desk)).toHaveCount(0)
  }
  await expect(desk.locator('.ms [data-test="open-note"]')).toHaveCount(0)
  expect(desk.errors).toEqual([])
})

test('F-MP-03 PhotoCraft 가 있는 설치: 보기 화면의 「PhotoCraft 로 편집」을 눌러야 문서 패널에 PhotoCraft — 받은 그림이 그 안으로', async () => {
  await preview(desk, IMG).locator('button').click()
  const edit = viewer(desk).locator('[data-test="media-edit"]')
  await expect(edit).toHaveText('PhotoCraft 로 편집')
  await expect(edit).toHaveAttribute('data-editor', 'photocraft')
  await edit.click()
  await expect(viewer(desk)).toHaveCount(0)
  const frame = desk.locator('.cef iframe.frm')
  await expect(frame).toHaveAttribute('src', /\/craft\/photocraft\//, { timeout: 20000 })
  // her own copy of the picture was handed to the app
  await expect(desk.frameLocator('.cef iframe.frm').locator('body')).toHaveAttribute('data-dropped', IMG.name, { timeout: 30000 })
  await shot(desk, 'mp03-photocraft-on-edit')
  await desk.locator('.cef .tb.ic[title="닫기"]').click()
  await expect(desk.locator('.cef')).toHaveCount(0)
  expect(desk.errors).toEqual([])
  await desk.context().close()
})

test('F-MP-04 PhotoCraft 가 없는 설치: 그림은 그대로 보이고 「편집」 단추 · 경고가 없다, 볼 수 없는 zip 은 차분한 안내와 링크', async ({ browser }) => {
  const p = await page(browser, JM, DESK, { noCraft: true })
  await p.goto('/chat')
  await openThread(p, '윤태호')
  await loaded(preview(p, IMG).locator('img'))
  await chip(p, IMG).click()
  await expect(viewer(p)).toBeVisible()
  await loaded(viewer(p).locator('[data-test="media-full"]'))
  await expect(viewer(p).locator('[data-test="media-edit"]')).toHaveCount(0)
  await expect(p.getByText('PhotoCraft 앱이 없어')).toHaveCount(0)
  await shot(p, 'mp04-no-photocraft-viewer')
  await p.keyboard.press('Escape')
  for (const f of [M4A, MP4]) {
    await chip(p, f).click()
    await expect(viewer(p)).toBeVisible()
    await expect(viewer(p).locator('[data-test="media-edit"]')).toHaveCount(0)
    await p.keyboard.press('Escape')
  }
  await expect(p.locator('.ms [data-test="open-note"]')).toHaveCount(0)
  // a format with no viewer: a calm line with its link under the chip — no warning colour, no alert mark
  await chip(p, ZIP).click()
  const note = p.locator(`.ms [data-test="open-note"][data-file="${ZIP.name}"]`)
  await expect(note).toContainText('앱 안에서 열 수 없는 형식이에요.')
  await expect(note).toHaveClass(/calm/)
  await expect(note.locator('svg')).toHaveCount(0)
  await expect(note.locator('a')).toHaveAttribute('target', '_blank')
  const red = await note.evaluate((el) => { const [r, g, b] = getComputedStyle(el).color.match(/\d+/g).map(Number); return r > 150 && g < 90 && b < 90 })
  expect(red).toBe(false)
  await expect(p.locator('.ms')).toBeVisible()
  await note.scrollIntoViewIfNeeded()
  await shot(p, 'mp04-zip-calm')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MP-05 AI 채팅의 파일 카드: 미리보기 · 플레이어 · 「눌러서 크게 보기」 → 보기 화면 → 「PhotoCraft 로 편집」을 눌러야 PhotoCraft', async ({ browser }) => {
  const p = await page(browser, JM, DESK)
  await p.goto('/chat')
  const card = (f) => p.locator('.row.k-file').filter({ has: p.locator(`[data-test="file-card"][data-file="${f.name}"]`) }).last()
  await expect(card(IMG)).toBeVisible({ timeout: 20000 })
  await expect(card(IMG).locator('.fic')).toHaveText('IMG')
  await expect(card(M4A).locator('.fic')).toHaveText('AUD')
  await expect(card(IMG).locator('.file')).toContainText('눌러서 크게 보기')
  await expect(card(MP4).locator('.file')).toContainText('눌러서 크게 보기')
  await expect(card(M4A).locator('.file')).toContainText('눌러서 열기')
  const img = card(IMG).getByTestId('file-image')
  await img.scrollIntoViewIfNeeded()
  await loaded(img)
  const audio = card(M4A).getByTestId('file-audio')
  await expect(audio).toHaveAttribute('preload', 'none')
  const a = await duration(audio)
  expect(a.err).toBeUndefined()
  expect(a.duration).toBeGreaterThan(1)
  const v = await duration(card(MP4).getByTestId('file-video'))
  expect(v.err).toBeUndefined()
  await top(card(IMG), 'center')
  await shot(p, 'mp05-chat-cards')
  // the card pressed: the viewer, not PhotoCraft
  await card(IMG).locator('.file').click()
  await expect(viewer(p)).toBeVisible()
  await expect(p.locator('.cef')).toHaveCount(0)
  await p.keyboard.press('Escape')
  await expect(viewer(p)).toHaveCount(0)
  await card(IMG).getByTestId('file-image').click()
  await expect(viewer(p)).toBeVisible()
  await shot(p, 'mp05-chat-viewer')
  await viewer(p).locator('[data-test="media-edit"]').click()
  await expect(p.locator('.cef iframe.frm')).toHaveAttribute('src', /\/craft\/photocraft\//, { timeout: 20000 })
  await expect(p.frameLocator('.cef iframe.frm').locator('body')).toHaveAttribute('data-dropped', IMG.name, { timeout: 30000 })
  await shot(p, 'mp05-chat-photocraft')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MP-06 미디어 주소는 받은 사람 · 보낸 사람만, 화면의 주소는 토큰 없는 15분 서명 주소 — 200 · 206, 바꾸면 403, 만료 401, 남의 서명 404, 대화방 밖 404, zip 은 내려받기', async () => {
  const mine = await S.api(JM.token, `/team/threads/${room}/messages`)
  const theirs = await S.api(TH.token, `/team/threads/${room}/messages`)
  const art = (list, f) => list.messages.flatMap((m) => m.artifacts || []).find((x) => x.name === f.name)
  const jm = art(mine, IMG), th = art(theirs, IMG)
  expect(jm.shareId).toBeTruthy()
  expect(th.shareId).toBeTruthy()
  // no storage key in what the room sees
  expect(JSON.stringify(mine)).not.toMatch(/storage\/v1|object_key|pgpt-pro\//)
  for (const [who, id] of [[JM, jm.shareId], [TH, th.shareId]]) {
    const r = await raw(`/team/shares/${id}/raw?inline=1`, who.token)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(r.headers.get('content-security-policy')).toContain('sandbox')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await r.arrayBuffer())).toEqual(IMG.buf)
  }
  // the token may ride in the address (an <img> sends no header)
  expect((await raw(`/team/shares/${jm.shareId}/raw?token=${encodeURIComponent(JM.token)}`)).status).toBe(200)
  // someone outside the room, and no sign-in
  expect((await raw(`/team/shares/${jm.shareId}/raw`, MJ.token)).status).toBe(404)
  expect((await raw(`/team/shares/${jm.shareId}/raw`)).status).toBe(401)
  // a zip asked inline still downloads; a plain request is a download as before
  const zip = art(mine, ZIP)
  expect((await raw(`/team/shares/${zip.shareId}/raw?inline=1`, JM.token)).headers.get('content-disposition')).toMatch(/^attachment;/)
  expect((await raw(`/team/shares/${jm.shareId}/raw`, JM.token)).headers.get('content-disposition')).toMatch(/^attachment;/)
  // a sound stored without its type plays as what its name says
  const m4a = await raw(`/team/shares/${art(mine, M4A).shareId}/raw?inline=1`, JM.token, { Range: 'bytes=0-15' })
  expect(m4a.status).toBe(206)
  expect(m4a.headers.get('content-type')).toBe('audio/mp4')

  // what the page uses: the signed address of each picture · sound · video (not of the zip), one per person, no token in it
  for (const f of [IMG, M4A, MP4]) expect(art(mine, f).link).toMatch(new RegExp(`^/team/shares/${art(mine, f).shareId}/raw\\?u=${JM.id}&exp=\\d+&inline=1&sig=`))
  expect(art(mine, ZIP).link).toBeUndefined()
  expect(th.link).toContain(`u=${TH.id}`)
  expect(JSON.stringify(mine)).not.toMatch(/token=|eyJ[A-Za-z0-9_-]{8,}/)
  // no header, no token: 200 · inline · the same bytes, and a part on a Range (206)
  const signed = await raw(jm.link)
  expect(signed.status).toBe(200)
  expect(signed.headers.get('content-disposition')).toMatch(/^inline;/)
  expect(Buffer.from(await signed.arrayBuffer())).toEqual(IMG.buf)
  const sp = await raw(art(mine, M4A).link, null, { Range: 'bytes=0-99' })
  expect(sp.status).toBe(206)
  expect(sp.headers.get('content-range')).toMatch(/^bytes 0-99\//)
  expect((await raw(th.link)).status).toBe(200)
  // a new address on request (the page asks when one has run out): signed-in only, and only for her own share
  const fresh = await S.api(JM.token, `/team/shares/${jm.shareId}/link`)
  expect(fresh.link).toMatch(new RegExp(`u=${JM.id}&exp=\\d+&inline=1&sig=`))
  expect((await raw(`/team/shares/${jm.shareId}/link`)).status).toBe(401)
  expect((await raw(`/team/shares/${jm.shareId}/link`, MJ.token)).status).toBe(404)
  // altered: another signature, the inline flag dropped, another person's id on her signature → 403
  const sig = /sig=([^&]+)/.exec(jm.link)[1]
  expect((await raw(jm.link.replace(`sig=${sig}`, `sig=${sig.slice(0, 10)}${sig[10] === 'A' ? 'B' : 'A'}${sig.slice(11)}`))).status).toBe(403)
  expect((await raw(jm.link.replace('&inline=1', ''))).status).toBe(403)
  expect((await raw(jm.link.replace(`u=${JM.id}`, `u=${MJ.id}`))).status).toBe(403)
  // run out: 401 (the page asks for a new one)
  const key = linkKey((await import(path.join(SERVER, 'config.js'))).config.serviceKey)
  const old = linkPath(jm.shareId, signLink({ key, tenant: TENANT, id: jm.shareId, userId: JM.id, inline: true, exp: Math.floor(Date.now() / 1000) - 5 }))
  expect((await raw(old)).status).toBe(401)
  // a signature that is right but for someone the share is not for: the access check still says no (404)
  const forged = linkPath(jm.shareId, signLink({ key, tenant: TENANT, id: jm.shareId, userId: MJ.id, inline: true }))
  expect((await raw(forged)).status).toBe(404)
  // and for another company: 403
  expect((await raw(linkPath(jm.shareId, signLink({ key, tenant: 'other-co', id: jm.shareId, userId: JM.id, inline: true })))).status).toBe(403)
})

test('F-MP-07 휴대폰(390px) 밝은 · 밤 테마: 미리보기 · 플레이어가 메시지 안에, 옆으로 넘치지 않음, 보기 화면의 단추가 화면 안', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const p = await page(browser, JM, PHONE, { theme })
    await p.goto('/chat')
    await expect.poll(() => p.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
    await openThread(p, '윤태호', { phone: true })
    const img = preview(p, IMG).locator('img')
    await img.scrollIntoViewIfNeeded()
    await loaded(img)
    for (const f of [IMG, M4A, MP4]) await inScreen(preview(p, f), 390)
    expect(await noOverflow(p)).toBe(true)
    expect(await p.locator('.ms .msgs').evaluate((m) => m.scrollWidth - m.clientWidth)).toBeLessThanOrEqual(0)
    await expect(p.locator('.ms [data-test="open-note"]')).toHaveCount(0)
    await noToken(p)
    await top(chip(p, IMG))
    await shot(p, `mp07-phone-${theme}-thread`)
    await preview(p, IMG).locator('button').tap()
    await expect(viewer(p)).toBeVisible()
    await loaded(viewer(p).locator('[data-test="media-full"]'))
    for (const t of ['media-close', 'media-open', 'media-edit', 'media-full']) await inScreen(viewer(p).locator(`[data-test="${t}"]`), 390)
    await noToken(p)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `mp07-phone-${theme}-viewer`)
    await viewer(p).locator('[data-test="media-close"]').tap()
    await expect(viewer(p)).toHaveCount(0)
    await expect(p.locator('.ms')).toBeVisible()
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-MP-08 서명이 맞아도 권한은 다시 본다 — 팀에서 빠지면 403, 공유를 거두면 404, 화면의 미리보기는 차분히 「미리 볼 수 없어요」', async ({ browser }) => {
  const mine = await S.api(JM.token, `/team/threads/${room}/messages`)
  const jm = mine.messages.flatMap((m) => m.artifacts || []).find((x) => x.name === IMG.name)
  const th = (await S.api(TH.token, `/team/threads/${room}/messages`)).messages.flatMap((m) => m.artifacts || []).find((x) => x.name === IMG.name)
  expect((await raw(jm.link)).status).toBe(200)
  // out of the team: her still-valid address no longer reads (back in: it reads again)
  await S.q('delete from pro_team_members where tenant_id=$1 and user_id=$2', [TENANT, JM.id])
  expect((await raw(jm.link)).status).toBe(403)
  await S.join(JM)
  await S.api(JM.token, '/team')
  expect((await raw(jm.link)).status).toBe(200)
  // the sender takes the share back: both their valid addresses are 404
  const p = await page(browser, JM, DESK)
  const del = await fetch(`http://127.0.0.1:${S.apiPort}/api/team/shares/${th.shareId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TH.token}` } })
  expect(del.status).toBe(200)
  expect((await raw(jm.link)).status).toBe(404)
  expect((await raw(th.link)).status).toBe(404)
  // on her screen: no picture, a calm line in its place (no warning box); a new address is refused too
  await p.goto('/chat')
  await openThread(p, '윤태호')
  const fb = preview(p, IMG).locator('[data-test="media-fallback"]')
  await expect(fb).toBeVisible({ timeout: 15000 })
  await expect(fb).toContainText('미리 볼 수 없어요')
  await expect(p.locator('.ms [data-test="open-note"]')).toHaveCount(0)
  await noToken(p)
  await top(chip(p, IMG))
  await shot(p, 'mp08-revoked-fallback')
  expect(p.errors).toEqual([])
  await p.context().close()
})

// ---------- TIFF (a fax) ----------
// what a canvas holds, read in the page: its size, how much of it is ink (dark pixels — 0 is a blank page) and a fingerprint of its pixels
const ink = (canvas) => canvas.evaluate((c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let n = 0, h = 0
  for (let i = 0; i < d.length; i += 4) { if (d[i] < 100) n++; if (i % 64 === 0) h = (h * 31 + d[i]) % 1000000007 }
  return { w: c.width, h: c.height, share: n / (c.width * c.height), hash: h }
})
const tiffOf = (loc) => loc.locator('[data-test="tiff-view"]')
let faxCard = null

test('F-MP-09 팩스(TIFF): 메신저 미리보기는 첫 쪽 · 「2쪽」, 보기 화면 ‹ 1 / 2 › → 2쪽, 그림이 그려짐, 누르면 확대 · 손상된 · 거대한 TIFF 는 차분한 안내 · 해독기는 TIFF 가 나올 때만', async ({ browser }) => {
  // 윤태호 forwards the fax that came from KT, with a damaged one and one too large
  const up = async (f) => (await rawPost(TH.token, '/team/uploads', f.buf, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name), 'X-File-Type': f.type })).id
  await S.api(TH.token, `/team/threads/${room}/messages`, { method: 'POST', body: { text: 'KT 에서 온 팩스예요', artifactIds: [await up(FAX), await up(BAD), await up(BIG)] } })
  const p = await page(browser, JM, DESK)
  const asked = []
  p.on('request', (r) => asked.push(r.url()))
  await p.goto('/chat')
  await expect(p.locator('[data-test="file-card"]').first()).toBeVisible({ timeout: 20000 })
  await p.waitForTimeout(1000)
  expect(asked.filter((u) => /tiff/i.test(u)), '화면에 TIFF 가 없으면 해독기를 받지 않는다').toEqual([])
  await openThread(p, '윤태호')
  await expect(chip(p, FAX).locator('.fic')).toHaveText('IMG')
  // the thumbnail: the first page, small, tall like the page, with 「2쪽」 on it
  const th = tiffOf(preview(p, FAX))
  await th.scrollIntoViewIfNeeded()
  await expect(th).toHaveAttribute('data-state', 'ok', { timeout: 20000 })
  await expect(th.locator('[data-test="tiff-count"]')).toHaveText('2쪽')
  const tk = await ink(th.locator('canvas'))
  expect(tk.w).toBe(480)
  expect(tk.share).toBeGreaterThan(0.01)
  const tb = await th.locator('canvas').boundingBox()
  expect(Math.abs(tb.height / tb.width - 2290 / 1728)).toBeLessThan(0.03)
  expect(tb.height).toBeLessThanOrEqual(200.5)
  expect(asked.some((u) => /tiffWorker/.test(u)), '해독기는 이제 받았다').toBe(true)
  // a damaged one and a giant one: a calm line with 「내려받기」 — no warning box, nothing decoded
  for (const f of [BAD, BIG]) {
    const e = preview(p, f).locator('[data-test="tiff-error"]')
    await expect(e).toContainText('이 TIFF 는 열 수 없어요 · 내려받기', { timeout: 20000 })
    await expect(e.locator('a')).toHaveAttribute('download', '')
  }
  await expect(p.locator('.ms').getByText('앱 안에서 열 수 없')).toHaveCount(0)
  await expect(p.locator('.ms [data-test="open-note"]')).toHaveCount(0)
  await top(chip(p, FAX))
  await shot(p, 'mp09-1-messenger-fax')
  // the viewer: page 1 of 2, fitted to a page's reading width
  await preview(p, FAX).locator('button').click()
  await expect(viewer(p)).toHaveAttribute('data-kind', 'image')
  const v = tiffOf(viewer(p))
  await expect(v).toHaveAttribute('data-state', 'ok', { timeout: 20000 })
  await expect(v.locator('[data-test="tiff-pos"]')).toHaveText('1 / 2')
  const pg = v.locator('[data-test="tiff-page"]')
  const c1 = await ink(pg)
  expect([c1.w, c1.h], '204 × 98 dpi 는 두 배 높이로').toEqual([1728, 2290])
  expect(c1.share).toBeGreaterThan(0.03)
  const b1 = await pg.boundingBox()
  expect(b1.width).toBeGreaterThan(700)
  expect(b1.width).toBeLessThanOrEqual(860.5)
  await expect(viewer(p).locator('[data-test="media-download"]')).toHaveAttribute('download', '')
  await expect(viewer(p).locator('[data-test="media-open"]')).toHaveCount(0)
  await expect(viewer(p).locator('[data-test="tiff-prev"]')).toBeDisabled()
  await noToken(p)
  await shot(p, 'mp09-2-viewer-page1')
  // page 2 — another picture
  await v.locator('[data-test="tiff-next"]').click()
  await expect(v.locator('[data-test="tiff-pos"]')).toHaveText('2 / 2')
  await expect(v).toHaveAttribute('data-page', '2')
  await expect(v.locator('[data-test="tiff-next"]')).toBeDisabled()
  const c2 = await ink(pg)
  expect(c2.share).toBeGreaterThan(0.03)
  expect(c2.hash).not.toBe(c1.hash)
  await shot(p, 'mp09-3-viewer-page2')
  // ← goes back; a press zooms in where it was pressed (scrolls), pressed again fits
  await p.keyboard.press('ArrowLeft')
  await expect(v.locator('[data-test="tiff-pos"]')).toHaveText('1 / 2')
  await pg.click({ position: { x: 150, y: 120 } })
  await expect(v).toHaveClass(/zoom/)
  expect((await pg.boundingBox()).width).toBeGreaterThan(b1.width * 1.9)
  await shot(p, 'mp09-4-viewer-zoomed')
  await pg.click({ position: { x: 300, y: 300 } })
  await expect(v).not.toHaveClass(/zoom/)
  await p.keyboard.press('Escape')
  await expect(viewer(p)).toHaveCount(0)
  await expect(p.locator('.ms')).toBeVisible()
  // the damaged one opened from its chip: the viewer says so calmly; the giant one says why
  await chip(p, BAD).click()
  await expect(tiffOf(viewer(p)).locator('[data-test="tiff-error"]')).toContainText('이 TIFF 는 열 수 없어요')
  await expect(tiffOf(viewer(p)).locator('[data-test="tiff-download"]')).toHaveAttribute('download', '')
  await shot(p, 'mp09-5-viewer-damaged')
  await p.keyboard.press('Escape')
  await chip(p, BIG).click()
  await expect(tiffOf(viewer(p)).locator('[data-test="tiff-error"]')).toContainText('너무 큰 TIFF 예요')
  await p.keyboard.press('Escape')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MP-10 AI 채팅에 붙인 팩스: 파일 카드 IMG · 첫 쪽 미리보기 → 보기 화면 2쪽까지 · 서버는 쪽마다 PNG 를 비공개로(서명 주소 · 작업 공간의 같은 폴더)', async ({ browser }) => {
  // attached in the chat (POST /attachments, as the composer does): the pages for the agent come back private
  const a = await rawPost(JM.token, '/attachments', FAX.buf, { 'Content-Type': FAX.type, 'X-File-Name': encodeURIComponent(FAX.name) })
  expect(a.pages.length).toBe(2)
  expect(a.pageTotal).toBe(2)
  for (const [n, pgx] of a.pages.entries()) {
    expect(pgx.url).toMatch(new RegExp(`/storage/v1/object/sign/lite-private/chat/${TENANT}/${JM.id}/[0-9a-f-]{36}/page-${n + 1}\\.png\\?token=`))
    expect(pgx.url).not.toMatch(/object\/public/)
    const r = await fetch(pgx.url)
    expect(r.status).toBe(200)
    const b = Buffer.from(await r.arrayBuffer())
    expect(b.subarray(1, 4).toString()).toBe('PNG')
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([1728, 2290])
    if (a.path) expect(pgx.path).toBe(`${path.posix.dirname(a.path)}/arrive_xroshotplus_uengine1_20261125095030049_121017596357694-page${n + 1}.png`)
  }
  // a damaged one: the upload still goes, with why there are no pictures
  const bad = await rawPost(JM.token, '/attachments', BAD.buf, { 'Content-Type': BAD.type, 'X-File-Name': encodeURIComponent(BAD.name) })
  expect([bad.pages, bad.pagesError]).toEqual([undefined, 'broken'])
  // the file card in her chat (what the attachment leaves there)
  const [main] = await S.api(JM.token, '/threads')
  await S.q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'user', 'file', $2)`, [main.id, { name: a.name, url: a.url, attached: true }])
  const p = await page(browser, JM, DESK)
  await p.goto('/chat')
  faxCard = p.locator('.row.k-file').filter({ has: p.locator(`[data-test="file-card"][data-file="${FAX.name}"]`) }).last()
  await expect(faxCard).toBeVisible({ timeout: 20000 })
  await expect(faxCard.locator('.fic')).toHaveText('IMG')
  await expect(faxCard.locator('.file')).toContainText('눌러서 크게 보기')
  const th = tiffOf(faxCard)
  await th.scrollIntoViewIfNeeded()
  await expect(th).toHaveAttribute('data-state', 'ok', { timeout: 20000 })
  expect((await ink(th.locator('canvas'))).share).toBeGreaterThan(0.01)
  await top(faxCard, 'center')
  await shot(p, 'mp10-1-chat-fax-card')
  await faxCard.locator('.file').click()
  const v = tiffOf(viewer(p))
  await expect(v).toHaveAttribute('data-state', 'ok', { timeout: 20000 })
  await v.locator('[data-test="tiff-next"]').click()
  await expect(v.locator('[data-test="tiff-pos"]')).toHaveText('2 / 2')
  expect((await ink(v.locator('[data-test="tiff-page"]'))).share).toBeGreaterThan(0.03)
  await shot(p, 'mp10-2-chat-fax-viewer-page2')
  // no editor for a TIFF: looking only
  await expect(viewer(p).locator('[data-test="media-edit"]')).toHaveCount(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MP-11 휴대폰(390px) 밝은 · 밤: 팩스 미리보기 · 보기 화면(한 쪽이 화면 폭에 맞아 통째로) · 쪽 넘기기가 화면 안, 옆으로 넘치지 않음', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const p = await page(browser, JM, PHONE, { theme })
    await p.goto('/chat')
    await expect.poll(() => p.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
    await openThread(p, '윤태호', { phone: true })
    const th = tiffOf(preview(p, FAX))
    await th.scrollIntoViewIfNeeded()
    await expect(th).toHaveAttribute('data-state', 'ok', { timeout: 20000 })
    for (const f of [FAX, BAD]) await inScreen(preview(p, f), 390)
    expect(await noOverflow(p)).toBe(true)
    expect(await p.locator('.ms .msgs').evaluate((m) => m.scrollWidth - m.clientWidth)).toBeLessThanOrEqual(0)
    await top(chip(p, FAX))
    await shot(p, `mp11-phone-${theme}-thread`)
    await preview(p, FAX).locator('button').tap()
    const v = tiffOf(viewer(p))
    await expect(v).toHaveAttribute('data-state', 'ok', { timeout: 20000 })
    const pg = v.locator('[data-test="tiff-page"]')
    const b = await pg.boundingBox()
    expect(b.width).toBeGreaterThan(330)
    expect(b.width).toBeLessThanOrEqual(390 - 31)
    // the whole page shows above the page buttons (no scrolling to see a fax page on a phone)
    const nav = await v.locator('[data-test="tiff-next"]').boundingBox()
    expect(b.y + b.height).toBeLessThanOrEqual(nav.y + 1)
    for (const t of ['media-close', 'media-download']) await inScreen(viewer(p).locator(`[data-test="${t}"]`), 390)
    for (const t of ['tiff-prev', 'tiff-next', 'tiff-pos']) await inScreen(v.locator(`[data-test="${t}"]`), 390)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `mp11-phone-${theme}-viewer`)
    await v.locator('[data-test="tiff-next"]').tap()
    await expect(v.locator('[data-test="tiff-pos"]')).toHaveText('2 / 2')
    expect((await ink(pg)).share).toBeGreaterThan(0.03)
    await shot(p, `mp11-phone-${theme}-viewer-page2`)
    await viewer(p).locator('[data-test="media-close"]').tap()
    await expect(viewer(p)).toHaveCount(0)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})
