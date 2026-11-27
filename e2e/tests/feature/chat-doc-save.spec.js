// 채팅의 문서를 이음오피스에서 고쳐 저장하기 (스펙 openspec/specs/folder-edit-save 「채팅의 문서」). 2026-11-27 운영 녹화: 메일 답장 초안
// TXT 를 채팅에서 열어 고치고 💾 를 눌렀더니 편집기 상태 줄이 10초 넘게 「저장 중…」 그대로였다 — 「저장되었다는 표시가 좀 나든지 해야 될
// 것 같은데 · 다른 이름으로 저장이 그것도 안되고 있고 · 이게 지금 아마 닫으면 날아가지 싶은데」.
// 원인: 편집기와 호스트를 잇는 웹소켓(/lite/office/__ipc)을 운영의 Cloudflare 가 아무것도 오가지 않은 지 ~100초 만에 끊는다(재 보니 125초에
// 1006). 그 뒤 편집기 페이지의 저장 요청은 닫힌 소켓에 버려져 답이 오지 않는다. 시험은 편집기와 Vite 사이에 끊을 수 있는 중계(이 파일의
// relay)를 두고 그 조건을 만든다.
//   F-CS-01 채팅 TXT 열기 → 고치기 → 💾 → 막대 「저장했어요 · 시각」 · 어디에 남았는지 · 카드가 편집본 · 다시 열면 고친 내용
//   F-CS-02 연결이 끊긴 뒤 💾 → 곧바로 「저장하지 못했어요」(「저장 중…」에 머물지 않음) · 「연결 끊김 · 다시 열기」 → 다시 열면 저장이 된다
//   F-CS-03 손대지 않고 둔 편집기(중계가 40초 동안 아무것도 오가지 않으면 끊음 — 운영의 Cloudflare 처럼)도 연결이 살아 있어 저장된다
//   F-CS-04 「다른 이름으로 저장」 → 이름 묻기 → 같은 대화의 새 파일 카드로 저장되고 열림 · 원래 카드는 마지막으로 저장한 판 그대로
//   F-CS-05 고친 채 닫기(×) → 「저장하고 닫기 · 저장하지 않고 닫기 · 취소」 — 취소는 그대로, 저장하고 닫기는 저장, 저장하지 않고 닫기는 버림 ·
//           다른 카드를 눌러도 먼저 묻는다
//   F-CS-06 편집기가 올리기에 실패하면 「저장하지 못했어요 · 다시 시도」와 까닭, 다시 시도하면 저장
//   F-CS-07 휴대폰 390px · 밤 테마: 짧은 표시(저장 안 됨 → 저장됨 시각)가 화면 안, 닫을 때 묻기도 화면 안 · 옆으로 넘치지 않음
// 자기 스택(lib/localStack.js — 회사 chat-save, BFF 8983 · Vite 5383 부터 빈 포트), 실제 이음오피스 편집기: RT_OFFICE_HOST_URL(운영 이미지 컨테이너,
// 스펙 e2e/README) 또는 빌드된 호스트(lib/officeHost.js, 5403 부터). 모델 · deepagents 는 부르지 않는다. 사람은 지어낸 이름(정하윤 · 김서연).
//   cd e2e && RT_OFFICE_HOST_URL=http://127.0.0.1:5403 RT_WORKERS=1 npx playwright test --project=feature tests/feature/chat-doc-save.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { startStack, freePort, REPO } from '../../lib/localStack.js'
import { startOfficeHost, officeHostDir } from '../../lib/officeHost.js'

test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/folder-edit-save/e2e/results')
const TENANT = 'chat-save'
const NOWHERE = 'http://127.0.0.1:9'
const DESK = { viewport: { width: 1400, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const DRAFT = '김서연 님께\n\n요청하신 일정 확인했습니다.\n\n1. 일정: 12월 3일\n2. 장소: 본사 3층\n\n정하윤 드림\n'

// Between Vite and the editor host: a relay that can drop every connection (a host restart, the network) and, given idleMs, drops one that
// carried nothing for that long — what Cloudflare does in production to an idle WebSocket.
function relay(target, { idleMs = 0 } = {}) {
  const socks = new Set()
  const stats = { dropped: 0 }
  const t = new URL(target)
  const server = net.createServer((c) => {
    const s = net.connect(Number(t.port), t.hostname)
    const pair = { c, s, timer: null, ws: null }
    socks.add(pair)
    const end = () => { clearTimeout(pair.timer); c.destroy(); s.destroy(); socks.delete(pair) }
    const arm = () => { if (!idleMs) return; clearTimeout(pair.timer); pair.timer = setTimeout(() => { if (pair.ws) stats.dropped++; end() }, idleMs) }
    arm()
    // (an editor's connection: the page's WebSocket to the host — the one whose drop the editor feels)
    c.on('data', (d) => { if (pair.ws == null) pair.ws = /^GET [^\r\n]*__ipc/.test(String(d.subarray(0, 200))); arm(); s.write(d) })
    s.on('data', (d) => { arm(); c.write(d) })
    for (const x of [c, s]) { x.on('error', end); x.on('close', end) }
  })
  return new Promise((resolve) => {
    const port = freePort(5404)
    server.listen(port, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${port}`,
      set idle(ms) { idleMs = ms },
      get dropped() { return stats.dropped },
      dropAll() { for (const p of [...socks]) { p.c.destroy(); p.s.destroy() } },
      close: () => new Promise((r) => { for (const p of [...socks]) { p.c.destroy(); p.s.destroy() } server.close(r) }),
    }))
  })
}

let S, host, hostUrl, R, ME, mainId
async function rawPost(token, p, buf, headers) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api${p}`, { method: 'POST', body: buf, headers: { Authorization: `Bearer ${token}`, ...headers } })
  const t = await r.text()
  if (!r.ok) throw new Error(`POST ${p} → ${r.status} ${t.slice(0, 200)}`)
  return JSON.parse(t)
}
// a chat file card the agent left: a TXT in storage (as an attachment), in my main chat → {id, name, url}
async function draftCard(name, text = DRAFT, content = {}) {
  const a = await rawPost(ME.token, '/attachments', Buffer.from(text), { 'Content-Type': 'text/plain; charset=utf-8', 'X-File-Name': encodeURIComponent(name) })
  const [m] = await S.q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'agent', 'file', $2) returning id`, [mainId, { name, url: a.url, type: 'text/plain', ...content }])
  return { id: m.id, name, url: a.url }
}
const cardOf = async (id) => (await S.q('select content from pro_messages where id=$1', [id]))[0]?.content || {}
const textAt = async (u) => (await fetch(u)).text()
async function page(browser, opts = DESK, { theme = 'light' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    try { localStorage.removeItem('pgl-messenger-dock') } catch { /* none */ }
  }, [JSON.stringify(ME.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  p.on('dialog', (d) => d.dismiss().catch(() => {}))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const oef = (p) => p.locator('.oef')
const badge = (p) => p.locator('[data-testid="oef-save"]')
const ask = (p) => p.locator('[data-testid="oef-ask"]')
const ed = (p) => p.frameLocator('.oef iframe.frm')
async function openChat(p, { phone = false } = {}) {
  await p.goto('/chat')
  if (phone) await p.locator('header.top .seg button', { hasText: '채팅' }).click()
}
const card = (p, name) => p.locator(`[data-test="file-card"][data-file="${name}"] button.file`).last()
// the text editor drawn and listening (the frame watches for edits once the editor says it is ready)
async function textReady(p) {
  await expect(p.locator('[data-testid="oef-opening"]')).toHaveCount(0, { timeout: 90_000 })
  await expect(ed(p).locator('.cm-content')).toBeVisible({ timeout: 90_000 })
  await p.waitForTimeout(2500)
}
async function typeAtEnd(p, text) {
  await ed(p).locator('.cm-line').last().click()
  await p.keyboard.press('End')
  await p.keyboard.type(text, { delay: 25 })
}
const editorText = (p) => ed(p).locator('.cm-content').innerText()
const pressSave = (p) => ed(p).locator('.qa-btn[aria-label^="저장"]').first().click()
const statusBar = (p) => ed(p).locator('.status-bar').innerText()
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const inView = async (p, loc) => { const b = await loc.boundingBox(); const w = p.viewportSize().width; return !!b && b.x >= 0 && b.x + b.width <= w + 1 }

test.beforeAll(async () => {
  test.setTimeout(300_000)
  hostUrl = process.env.RT_OFFICE_HOST_URL || ''
  if (!hostUrl) {
    test.skip(!officeHostDir(), '이음오피스 호스트가 없음 (RT_OFFICE_HOST_URL — 운영 이미지 컨테이너, 또는 빌드된 office-host)')
    host = await startOfficeHost({ from: Number(process.env.RT_OFFICE_FROM) || 5403 })
    hostUrl = host.url
  }
  fs.mkdirSync(SHOTS, { recursive: true })
  R = await relay(hostUrl)
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8983, webFrom: Number(process.env.RT_WEB_FROM) || 5383, officeTarget: R.url,
    env: { PRO_OFFICE_HOST_URL: hostUrl, PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: '', PRO_MEMENTO_URL: NOWHERE,
      PRO_MCP_HUB_URL: NOWHERE, PRO_JUDGE_URL: '', PRO_ONTOLOGY_BOLT_URL: '' } })
  ME = await S.person(`pro-rt-cs-${TENANT}@uengine.org`, '정하윤')
  await S.join(ME)
  const [main] = await S.api(ME.token, '/threads')
  mainId = main.id
  await cleanData()
})
// everything this file made: my chat's cards and the stored files (and the editor's edited copies beside them)
async function cleanData() {
  if (!ME) return
  const { admin } = await import(path.join(REPO, 'server/lib/supa.js'))
  for (const dir of [`pgpt-pro/${ME.id}/att`]) {
    const l = await admin.storage.from('files').list(dir, { limit: 1000 }).catch(() => ({ data: [] }))
    if (l.data?.length) await admin.storage.from('files').remove(l.data.map((o) => `${dir}/${o.name}`)).catch(() => {})
  }
  await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [ME.id]).catch(() => {})
}
test.afterAll(async () => {
  if (S) { await cleanData().catch(() => {}); await S.stop() }
  await R?.close()
  await host?.stop()
})

test('F-CS-01 채팅 TXT: 고치고 💾 → 막대 「저장했어요 · 시각」, 카드가 고친 판을 열고 다시 열면 고친 내용', async ({ browser }) => {
  const c = await draftCard('답장초안_시험_김서연.txt')
  const p = await page(browser)
  await openChat(p)
  await card(p, c.name).click()
  await textReady(p)
  await expect(badge(p)).toHaveCount(0)
  await typeAtEnd(p, ' 회신확인')
  await expect(badge(p)).toHaveAttribute('data-state', 'edited')
  await expect(badge(p)).toContainText('저장 안 됨')
  await pressSave(p)
  await expect(badge(p)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
  await expect(badge(p)).toHaveText(/저장했어요 · \d\d:\d\d/)
  await expect(p.locator('[data-testid="oef-notice"]')).toContainText('저장했어요 · 채팅의 파일 카드에서 이 버전이 열려요')
  // the editor's own status bar finished too (never 「저장 중…」 for good)
  await expect.poll(() => statusBar(p), { timeout: 10_000 }).not.toContain('저장 중')
  await shot(p, 'f-cs-01-saved')
  // a laptop's narrower sheet (1280px window): the name keeps its room and 닫기 stays in sight beside the badge
  for (const width of [1280, 1100]) {
    await p.setViewportSize({ width, height: 800 })
    await p.waitForTimeout(300)
    expect(await inView(p, oef(p).locator('.tb.ic[title="닫기"]'))).toBe(true)
    expect(await inView(p, badge(p))).toBe(true)
    expect((await oef(p).locator('.bar .name').boundingBox()).width).toBeGreaterThan(60)
  }
  await shot(p, 'f-cs-01-saved-1100')
  await p.setViewportSize(DESK.viewport)
  // the card now stands on the edited copy beside the original
  await expect.poll(async () => (await cardOf(c.id)).url || '', { timeout: 20_000 }).toMatch(/\/edited-[^/]+\.txt$/)
  expect(await textAt((await cardOf(c.id)).url)).toContain('회신확인')
  // closed (nothing left unsaved: no question) and opened again: the edit is there
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(ask(p)).toHaveCount(0)
  await expect(oef(p)).toHaveCount(0)
  await card(p, c.name).click()
  await textReady(p)
  await expect.poll(() => editorText(p)).toContain('회신확인')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-02 편집기 연결이 끊긴 뒤 💾 → 곧바로 「저장하지 못했어요」 · 「연결 끊김 · 다시 열기」 → 다시 열면 저장된다', async ({ browser }) => {
  const c = await draftCard('답장초안_끊김_김서연.txt')
  const p = await page(browser)
  await openChat(p)
  await card(p, c.name).click()
  await textReady(p)
  await typeAtEnd(p, ' 끊긴뒤고침')
  // the connection goes (as Cloudflare ends an idle one): the bar says so at once
  R.dropAll()
  await expect(badge(p)).toHaveAttribute('data-state', 'gone', { timeout: 10_000 })
  await expect(badge(p)).toContainText('연결 끊김 · 다시 열기')
  await expect(p.locator('[data-testid="oef-notice"]')).toContainText('편집기와 연결이 끊겨 지금은 저장할 수 없어요')
  const t0 = Date.now()
  await pressSave(p)
  await expect(p.locator('[data-testid="oef-notice"]')).toContainText('저장하지 못했어요 — 편집기와 연결이 끊겼어요', { timeout: 5_000 })
  expect(Date.now() - t0).toBeLessThan(5_000)
  await expect(badge(p)).toHaveAttribute('data-state', 'gone')
  // an office host with the page's heartbeat and refusal (process-gpt-office-host fix/ipc-keepalive): the editor's own status bar says so too
  if (process.env.RT_HOST_HEARTBEAT === '1') await expect.poll(() => statusBar(p), { timeout: 5_000 }).toContain('저장 실패')
  await shot(p, 'f-cs-02-gone')
  // the card was not moved (nothing reached storage)
  expect((await cardOf(c.id)).url).toBe(c.url)
  // 다시 열기: asked first (the edit cannot be saved), then the last saved version opens and saving works again
  await badge(p).click()
  await expect(ask(p)).toContainText('편집기를 다시 열까요?')
  await shot(p, 'f-cs-02-reopen-ask')
  await ask(p).locator('[data-testid="oef-ask-reopen"]').click()
  await textReady(p)
  await expect.poll(() => editorText(p)).not.toContain('끊긴뒤고침')
  await typeAtEnd(p, ' 다시연뒤고침')
  await pressSave(p)
  await expect(badge(p)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
  await expect.poll(async () => textAt((await cardOf(c.id)).url), { timeout: 20_000 }).toContain('다시연뒤고침')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-03 손대지 않고 둔 편집기도(40초 동안 조용하면 끊는 중계 — 운영의 Cloudflare 처럼) 연결이 살아 있어 저장된다', async ({ browser }) => {
  test.setTimeout(240_000)
  const c = await draftCard('답장초안_대기_김서연.txt')
  const p = await page(browser)
  R.idle = 40_000
  try {
    await openChat(p)
    await card(p, c.name).click()
    await textReady(p)
    const dropped = R.dropped
    // read for a while, type nothing (the recording: the draft open, edits, a pause)
    await p.waitForTimeout(75_000)
    expect(R.dropped - dropped).toBe(0)
    await expect(badge(p)).toHaveCount(0)
    await typeAtEnd(p, ' 오래둔뒤고침')
    await pressSave(p)
    await expect(badge(p)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
    await expect.poll(async () => textAt((await cardOf(c.id)).url), { timeout: 20_000 }).toContain('오래둔뒤고침')
  } finally { R.idle = 0 }
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-04 「다른 이름으로 저장」 → 이름을 묻고 같은 대화의 새 파일로 저장해 연다 · 원래 카드는 마지막으로 저장한 판 그대로', async ({ browser }) => {
  const c = await draftCard('답장초안_사본_김서연.txt')
  const p = await page(browser)
  await openChat(p)
  await card(p, c.name).click()
  await textReady(p)
  // a save first (the card stands on this opening's copy), then more edits that go only to the new name
  await typeAtEnd(p, ' 첫저장')
  await pressSave(p)
  await expect(badge(p)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
  await typeAtEnd(p, ' 새이름에만')
  await ed(p).locator('.qa-save-as').click()
  await expect(ask(p)).toContainText('다른 이름으로 저장')
  const input = ask(p).locator('[data-testid="oef-ask-name"]')
  await expect(input).toHaveValue('답장초안_사본_김서연 사본.txt')
  await shot(p, 'f-cs-04-ask-name')
  await input.fill('김서연 회신 최종')
  await ask(p).locator('[data-testid="oef-ask-save"]').click()
  // the new card in the chat, open in the sheet
  await expect(p.locator('[data-test="file-card"][data-file="김서연 회신 최종.txt"]')).toHaveCount(1, { timeout: 30_000 })
  await expect(oef(p).locator('.bar .name')).toHaveText('김서연 회신 최종.txt', { timeout: 30_000 })
  await textReady(p)
  await expect.poll(() => editorText(p)).toContain('새이름에만')
  await expect(p.locator('.office-sheet .pnote')).toContainText('「김서연 회신 최종.txt」 이름으로 저장했어요')
  await shot(p, 'f-cs-04-saved-as')
  const [made] = await S.q(`select id, content from pro_messages where thread_id=$1 and content->>'name'=$2`, [mainId, '김서연 회신 최종.txt'])
  expect(made.content.savedAs.from).toBe(c.id)
  const copy = await textAt(made.content.url)
  expect(copy).toContain('첫저장')
  expect(copy).toContain('새이름에만')
  // the card I saved from: its last saved version (the first save), not the edits that went to the new name
  const orig = await textAt((await cardOf(c.id)).url)
  expect(orig).toContain('첫저장')
  expect(orig).not.toContain('새이름에만')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-05 고친 채 닫기 · 다른 카드 → 「저장하고 닫기 · 저장하지 않고 닫기 · 취소」', async ({ browser }) => {
  const c = await draftCard('답장초안_닫기_김서연.txt')
  const c2 = await draftCard('답장초안_다른카드_김서연.txt')
  const p = await page(browser)
  await openChat(p)
  await card(p, c.name).click()
  await textReady(p)
  await typeAtEnd(p, ' 닫기전고침')
  const close = oef(p).locator('.tb.ic[title="닫기"]')
  await close.click()
  await expect(ask(p)).toContainText('저장하지 않은 내용이 있어요')
  await expect(ask(p).locator('button')).toHaveText(['저장하고 닫기', '저장하지 않고 닫기', '취소'])
  await shot(p, 'f-cs-05-ask-close')
  // 취소: stays open with the edit
  await ask(p).locator('[data-testid="oef-ask-cancel"]').click()
  await expect(ask(p)).toHaveCount(0)
  await expect(oef(p)).toHaveCount(1)
  await expect.poll(() => editorText(p)).toContain('닫기전고침')
  // another card: asked too — 저장하고 닫기 saves, then the other opens
  await card(p, c2.name).click()
  await expect(ask(p)).toContainText('저장하지 않은 내용이 있어요')
  await ask(p).locator('[data-testid="oef-ask-save"]').click()
  await expect(oef(p).locator('.bar .name')).toHaveText(c2.name, { timeout: 40_000 })
  await expect.poll(async () => textAt((await cardOf(c.id)).url), { timeout: 20_000 }).toContain('닫기전고침')
  // 저장하지 않고 닫기: closes, the edit is gone
  await textReady(p)
  await typeAtEnd(p, ' 버릴고침')
  await close.click()
  await ask(p).locator('[data-testid="oef-ask-discard"]').click()
  await expect(oef(p)).toHaveCount(0)
  expect((await cardOf(c2.id)).url).toBe(c2.url)
  await card(p, c2.name).click()
  await textReady(p)
  await expect.poll(() => editorText(p)).not.toContain('버릴고침')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-06 편집기가 올리기에 실패하면 「저장하지 못했어요 · 다시 시도」와 까닭, 다시 시도하면 저장', async ({ browser }) => {
  const c = await draftCard('답장초안_실패_김서연.txt')
  const p = await page(browser)
  await openChat(p)
  await card(p, c.name).click()
  await textReady(p)
  await typeAtEnd(p, ' 실패뒤다시')
  // the editor's 저장 stopped before the editor sees it, and the editor's page says its upload failed (as it does when storage refuses)
  const editorPage = p.frames().find((f) => f.url().includes('/office/markdown/'))
  await editorPage.evaluate(() => {
    const stop = (e) => {
      const b = e.target.closest?.('.qa-btn')
      if (!b || !/^저장/.test(b.getAttribute('aria-label') || '') || window.__failOnce === false) return
      window.__failOnce = false
      e.stopImmediatePropagation(); e.preventDefault()
      parent.postMessage({ source: 'ieum-office', type: 'save-failed', error: 'storage upload 503 (시험)' }, '*')
    }
    document.addEventListener('click', stop, true)
  })
  await pressSave(p)
  await expect(badge(p)).toHaveAttribute('data-state', 'failed', { timeout: 10_000 })
  await expect(badge(p)).toContainText('저장하지 못했어요 · 다시 시도')
  await expect(badge(p)).toHaveAttribute('title', /storage upload 503 \(시험\)/)
  await expect(p.locator('[data-testid="oef-notice"]')).toContainText('저장하지 못했어요 — 편집기가 문서를 올리지 못했어요 (storage upload 503 (시험))')
  await shot(p, 'f-cs-06-failed')
  await badge(p).click()
  await expect(badge(p)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
  await expect.poll(async () => textAt((await cardOf(c.id)).url), { timeout: 20_000 }).toContain('실패뒤다시')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-07 휴대폰 390px · 밤 테마: 짧은 표시가 화면 안, 닫을 때 묻기도 화면 안 · 옆으로 넘치지 않음', async ({ browser }) => {
  const c = await draftCard('답장초안_휴대폰_김서연.txt')
  const p = await page(browser, PHONE, { theme: 'dark' })
  await openChat(p, { phone: true })
  await card(p, c.name).click()
  await textReady(p)
  await typeAtEnd(p, ' 휴대폰고침')
  await expect(badge(p)).toHaveAttribute('data-state', 'edited')
  await expect(badge(p).locator('.t-short')).toBeVisible()
  await expect(badge(p).locator('.t-short')).toHaveText('저장 안 됨')
  expect(await inView(p, badge(p))).toBe(true)
  expect(await inView(p, oef(p).locator('.tb.ic[title="닫기"]'))).toBe(true)
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'f-cs-07-phone-dark-edited')
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(ask(p)).toBeVisible()
  for (const b of await ask(p).locator('button').all()) expect(await inView(p, b)).toBe(true)
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'f-cs-07-phone-dark-ask')
  await ask(p).locator('[data-testid="oef-ask-save"]').click()
  await expect(oef(p)).toHaveCount(0, { timeout: 40_000 })
  await expect.poll(async () => textAt((await cardOf(c.id)).url), { timeout: 20_000 }).toContain('휴대폰고침')
  // opened again on the phone and saved with 💾: the short 「저장됨 시각」
  await card(p, c.name).click()
  await textReady(p)
  await typeAtEnd(p, ' 두번째')
  await pressSave(p)
  await expect(badge(p)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
  await expect(badge(p).locator('.t-short')).toHaveText(/저장됨 \d\d:\d\d/)
  expect(await inView(p, badge(p))).toBe(true)
  await shot(p, 'f-cs-07-phone-dark-saved')
  expect(p.errors).toEqual([])
  await p.context().close()
})
