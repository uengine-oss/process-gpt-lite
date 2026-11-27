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
//   F-CS-08 편집기의 검색 칸에 친 것 · 문서 밖에서 누른 키는 고침이 아니다 — 편집기의 저장이 꺼져 있으면 닫을 때 묻지 않고, ⌘S 도 「저장 실패」를 만들지 않음
//   F-CS-09 패널 앱의 시트(시험용 시트 편집기): 저장하고 닫기 → 패널 반영이 실패하면 닫지 않고 까닭, 다시 닫으면 반영한 뒤 닫히고 다시 열리지 않음
//   F-CS-10 「다른 이름으로 저장」의 새 카드가 만들어지지 않으면: 막대 「저장하지 못했어요 · 다시 시도」, 원래 카드 그대로, 닫으면 묻고, 다시 시도는 같은 편집본으로
//   F-CS-11 (고친 호스트 RT_FIXED_HOST_DIR) 실제로 올리기에 실패한 저장: 편집기는 저장됐다고 여기고 단추가 꺼지지만, 다시 시도(⌘S)로 다시 올라감
//   F-CS-12 PC 의 텍스트 편집기: Shift+→ · Shift+End · Shift+클릭으로 캐럿부터 고르고 그 줄에서도 보임, 치면 바뀜
//   F-CS-13 시트(시험용 편집기 — 칸을 치는 동안 저장 꺼짐)의 칸을 치고 ↓ · 다른 칸 누르기로 마친 뒤 닫으면 묻는다
//   F-CS-14 공유 폴더의 시트: 칸을 치고 ↓ 로 마치면 손을 멈춘 뒤 저절로 편집기의 저장을 누른다
//   F-CS-15 「다른 이름으로 저장」에서 편집기가 답하지 않으면 다시 시도는 같은 이름으로 다시(원래 카드에 쓰지 않음)
//   F-CS-16 (RT_REAL_SHEETS=1) 실제 엑셀 편집기: 칸을 치고 ↓ 로 마친 뒤 닫으면 묻는다
//   F-CS-17 열린 문서의 카드를 다시 눌러도 같은 열기 — 그 뒤 「다른 이름으로 저장」해도 원래 카드는 저장한 판 그대로
//   F-CS-18 손대지 않은 워드 · 파워포인트 · 한글 문서는 열고 바로 닫아도 묻지 않는다
//   (F-CS-09 안에서) 패널 반영 실패는 그 열기의 것만 — 다시 연 시트를 닫아도 옛 사본을 다시 보내지 않고, 고쳤으면 묻는다
// 자기 스택(lib/localStack.js — 회사 chat-save, BFF 8983 · Vite 5383 부터 빈 포트), 실제 이음오피스 편집기: RT_OFFICE_HOST_URL(운영 이미지 컨테이너,
// 스펙 e2e/README) 또는 빌드된 호스트(lib/officeHost.js, 5403 부터). 모델 · deepagents 는 부르지 않는다. 사람은 지어낸 이름(정하윤 · 김서연).
//   cd e2e && RT_OFFICE_HOST_URL=http://127.0.0.1:5403 RT_WORKERS=1 npx playwright test --project=feature tests/feature/chat-doc-save.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { startStack, freePort, REPO } from '../../lib/localStack.js'
import { startOfficeHost, officeHostDir } from '../../lib/officeHost.js'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import ExcelJS from 'exceljs'

test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/folder-edit-save/e2e/results')
const TENANT = 'chat-save'
const NOWHERE = 'http://127.0.0.1:9'
const DESK = { viewport: { width: 1400, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const DRAFT = '김서연 님께\n\n요청하신 일정 확인했습니다.\n\n1. 일정: 12월 3일\n2. 장소: 본사 3층\n\n정하윤 드림\n'
// The panel app (F-CS-09) is made with the server's own service in this process, as panel-apps.spec.js does: its folders and company
// must be the stack's — set before any server module is loaded (run this file in a worker of its own)
const FOLDERS = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-chat-save-folders-'))
process.env.PRO_FOLDERS_ROOT = FOLDERS
process.env.PRO_TENANT_ID = TENANT
// A spreadsheet editor stand-in that keeps a cell's text to itself while the cell is being typed in, as IeumOffice's does (its 저장 is
// `disabled={!canSave}`, canSave counting committed edits only — apps/sheets App.tsx): 저장 stays off while typing, and comes on when
// the cell is left (↓, a click elsewhere, focus leaving the page). 저장 says it saved the copy the test hands it (window.__saveUrl) and
// counts its presses (window.__saveClicks); window.__answer = false: it says nothing.
const SHEETS_STUB = `<!doctype html><html><head><meta charset="utf-8"><title>시트 편집기(시험용)</title></head><body style="margin:0;font:14px sans-serif">
<div id="root"><div class="ribbon-tabs" style="padding:8px"><button class="qa-btn" aria-label="저장 (⌘S)" disabled>저장</button></div>
<div id="cell" contenteditable="true" style="margin:12px;padding:8px;border:1px solid #bbb">사용일수 3</div>
<div id="other" tabindex="0" style="margin:12px;padding:8px;border:1px dashed #bbb">다른 칸</div></div>
<script>const q=new URLSearchParams(location.search);const btn=document.querySelector('.qa-btn');const cell=document.getElementById('cell');
let typing=false;window.__saveClicks=0;
cell.addEventListener('input',()=>{typing=true});
const commit=()=>{if(typing){typing=false;btn.disabled=false}};
cell.addEventListener('keydown',(e)=>{if(e.key==='ArrowDown'||e.key==='Enter'){e.preventDefault();commit();document.getElementById('other').focus()}});
cell.addEventListener('blur',commit);
btn.addEventListener('click',()=>{window.__saveClicks++;if(window.__answer===false)return;const url=window.__saveUrl||q.get('src');btn.disabled=true;
setTimeout(()=>parent.postMessage({source:'ieum-office',type:'saved',name:q.get('name'),url},'*'),300)});
parent.postMessage({source:'ieum-office',type:'ready',editor:'sheets'},'*')</script></body></html>`

// Between Vite and the editor host: a relay that can drop every connection (a host restart, the network) and, given idleMs, drops one that
// carried nothing for that long — what Cloudflare does in production to an idle WebSocket.
function relay(target, { idleMs = 0 } = {}) {
  const socks = new Set()
  const stats = { dropped: 0 }
  let t = new URL(target)
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
      // (new connections go to another host from now on)
      set target(u) { t = new URL(u) },
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
async function XLSX_OF(rows) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('시트1')
  for (const r of rows) ws.addRow(r)
  return Buffer.from(await wb.xlsx.writeBuffer())
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
// the panel's 시트 열기 in Home (a document open beside the chat folds Home; it stays folded after the sheet closes)
async function openPanelSheet(p, panel) {
  if (!(await panel.isVisible())) await p.locator('button.home[aria-label="Home 펼치기"]').click()
  await panel.locator('.foot button', { hasText: '시트 열기' }).click()
  await sheetReady(p)
}
const stubSheets = (p) => p.context().route(/\/office\/sheets\/\?/, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: SHEETS_STUB }))
const sheetFrame = (p) => p.frames().find((fr) => fr.url().includes('/office/sheets/'))
async function sheetReady(p) {
  await expect(oef(p).locator('iframe.frm')).toHaveAttribute('src', /\/office\/sheets\/\?src=/, { timeout: 30_000 })
  await expect(p.locator('[data-testid="oef-opening"]')).toHaveCount(0, { timeout: 30_000 })
  await p.waitForTimeout(1500)
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
    env: { PRO_FOLDERS_ROOT: FOLDERS, PRO_OFFICE_HOST_URL: hostUrl, PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: '', PRO_MEMENTO_URL: NOWHERE,
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
  for (const dir of [`pgpt-pro/${ME.id}/att`, `pgpt-pro/${ME.id}/copies`]) {
    const l = await admin.storage.from('files').list(dir, { limit: 1000 }).catch(() => ({ data: [] }))
    if (l.data?.length) await admin.storage.from('files').remove(l.data.map((o) => `${dir}/${o.name}`)).catch(() => {})
  }
  await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [ME.id]).catch(() => {})
}
test.afterAll(async () => {
  for (const done of panelCleanup.splice(0)) await done().catch(() => {})
  if (S) { await cleanData().catch(() => {}); await S.stop() }
  await R?.close()
  await host?.stop()
  fs.rmSync(FOLDERS, { recursive: true, force: true })
})
const panelCleanup = []

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
  // the save for the copy said nothing of its own (no 「저장했어요 · 채팅의 파일 카드…」 over the sheet's line), and the new file has nothing unsaved
  await expect(p.locator('[data-testid="oef-notice"]')).toHaveCount(0)
  await expect(badge(p)).toHaveCount(0)
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

test('F-CS-08 검색 칸에 친 것 · 문서 밖에서 누른 키는 고침이 아니다 — 편집기 저장이 꺼져 있으면 닫을 때 묻지 않고, ⌘S 도 「저장 실패」가 없다', async ({ browser }) => {
  const c = await draftCard('답장초안_검색_김서연.txt')
  const p = await page(browser)
  await openChat(p)
  await card(p, c.name).click()
  await textReady(p)
  // the editor's own search box: typing there changes nothing
  await ed(p).locator('.qa-btn[aria-label^="찾기"]').click()
  const find = ed(p).locator('.find-panel .find-input').first()
  await expect(find).toBeVisible()
  // (typed, not Enter: the editor's Enter there selects the match in the document, and the next key would replace it)
  await find.pressSequentially('일정', { delay: 40 })
  await p.waitForTimeout(800)
  await expect(ed(p).locator('.qa-btn[aria-label^="저장"]').first()).toBeDisabled()
  await expect(badge(p)).toHaveCount(0)
  await p.keyboard.press('Escape')
  // a key pressed with nothing of the document in focus (the page counts it, the editor changes nothing — its 저장 stays off)
  await ed(p).locator('.status-bar').click()
  await p.keyboard.press('x')
  await expect(ed(p).locator('.qa-btn[aria-label^="저장"]').first()).toBeDisabled()
  // ⌘S with the editor's 저장 off: nothing waits, nothing fails
  await p.keyboard.press('Meta+s')
  await p.waitForTimeout(2500)
  await expect(p.locator('[data-testid="oef-save"][data-state="saving"], [data-testid="oef-save"][data-state="failed"]')).toHaveCount(0)
  // closing: no question (the editor has nothing to save) — closed at once
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(ask(p)).toHaveCount(0)
  await expect(oef(p)).toHaveCount(0, { timeout: 5_000 })
  expect((await cardOf(c.id)).url).toBe(c.url)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-09 패널 앱의 시트: 저장하고 닫기 → 패널 반영이 실패하면 닫지 않고 까닭, 다시 닫으면 반영한 뒤 닫히고 다시 열리지 않음', async ({ browser }) => {
  const { config } = await import(path.join(REPO, 'server/config.js'))
  test.skip(config.defaultTenantId !== TENANT || config.foldersRoot !== FOLDERS, '서버 모듈이 다른 설정으로 이미 불려 있음 — 이 파일만 따로 돌리세요')
  const P = await import(path.join(REPO, 'server/lib/panelApps/service.js'))
  const def = (await import(path.join(REPO, 'server/lib/panelApps/sheet.js'))).normalizeDef({
    title: '시험 휴가 일수', icon: '🏖',
    fields: [{ key: 'name', label: '이름', type: 'text', required: true }, { key: 'granted', label: '부여일수', type: 'number', required: true }, { key: 'used', label: '사용일수', type: 'number', default: 0 }],
    computed: [{ key: 'left', label: '남은 일수', expr: 'granted - used' }],
    views: { list: { title: 'name', value: 'left', valueSuffix: '일' }, summary: [{ label: '인원', agg: 'count', suffix: '명' }] },
  }, { strict: true })
  const who = { id: ME.id, name: '정하윤', email: ME.email, jwt: ME.token }
  const app = await P.createApp(who, { description: '', def, rows: [] })
  panelCleanup.push(async () => { await P.remove(who, app.id).catch(() => {}); await S.q('delete from pro_folders where slug=$1', [app.folder.slug]).catch(() => {}) })
  await S.api(ME.token, `/panel-apps/${app.id}/rows`, { method: 'POST', body: { values: { name: '김서연', granted: 15, used: 3 } } })
  // the sheet's copy as the editor would save it: 사용일수 3 → 6
  const sheet = await S.api(ME.token, `/panel-apps/${app.id}/sheet`, { method: 'POST' })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(await (await fetch(sheet.url)).arrayBuffer()))
  const ws = wb.worksheets[0]
  ws.getRow(2).getCell(ws.getRow(1).values.indexOf('사용일수')).value = 6
  const saved = await rawPost(ME.token, '/attachments', Buffer.from(await wb.xlsx.writeBuffer()), { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': encodeURIComponent('시트.xlsx') })
  const used = async () => (await S.api(ME.token, `/panel-apps/${app.id}/rows`)).rows[0].used

  const p = await page(browser)
  await stubSheets(p)
  await openChat(p)
  const panel = p.locator('.pa').filter({ hasText: app.title }).first()
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await openPanelSheet(p, panel)
  await sheetFrame(p).evaluate((u) => { window.__saveUrl = u }, saved.url)
  await ed(p).locator('#cell').click()
  await p.keyboard.type(' 6', { delay: 30 })
  // the panel's server does not take it (yet)
  let refuse = true
  await p.route('**/api/panel-apps/*/sheet-saved', (r) => (refuse ? r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '패널 서버가 잠시 멈췄어요(시험)' }) }) : r.continue()))
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(ask(p)).toContainText('저장하지 않은 내용이 있어요')
  await ask(p).locator('[data-testid="oef-ask-save"]').click()
  await expect(p.locator('.office-sheet .pnote')).toContainText('패널에 반영하지 못했어요', { timeout: 30_000 })
  await expect(oef(p)).toHaveCount(1)
  await expect(badge(p)).toHaveAttribute('data-state', 'failed')
  await shot(p, 'f-cs-09-panel-not-applied')
  expect(await used()).toBe(3)
  // the server takes it now: closing applies it first, then the sheet closes — and stays closed
  refuse = false
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(oef(p)).toHaveCount(0, { timeout: 30_000 })
  await p.waitForTimeout(3000)
  await expect(oef(p)).toHaveCount(0)
  expect(await used()).toBe(6)

  // a failure is this opening's only: refused again and closed for good (the second close), then the sheet opened anew — its close does
  // not send the old copy again, and it asks about its own edits
  const posted = []
  refuse = true
  await p.unroute('**/api/panel-apps/*/sheet-saved')
  await p.route('**/api/panel-apps/*/sheet-saved', (r) => { posted.push(r.request().postDataJSON()); return refuse ? r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '데이터가 바뀌었어요(시험)' }) }) : r.continue() })
  await openPanelSheet(p, panel)
  await sheetFrame(p).evaluate((u) => { window.__saveUrl = u }, saved.url)
  await ed(p).locator('#cell').click()
  await p.keyboard.type(' 7', { delay: 30 })
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await ask(p).locator('[data-testid="oef-ask-save"]').click()
  await expect(p.locator('.office-sheet .pnote')).toContainText('패널에 반영하지 못했어요', { timeout: 30_000 })
  // (closing again: tried once more, still refused — 「한 번 더 닫으면 저장하지 않고 닫아요」; and once more closes)
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(p.locator('.office-sheet .pnote')).toContainText('한 번 더 닫으면 저장하지 않고 닫아요', { timeout: 30_000 })
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(oef(p)).toHaveCount(0, { timeout: 30_000 })
  // every retry of that opening went with the version it was made from
  expect(new Set(posted.map((b) => b.sha)).size).toBe(1)
  const before = posted.length
  await openPanelSheet(p, panel)
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(oef(p)).toHaveCount(0, { timeout: 30_000 })
  expect(posted.length).toBe(before)
  await openPanelSheet(p, panel)
  await ed(p).locator('#cell').click()
  await p.keyboard.type(' 8', { delay: 30 })
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(ask(p)).toContainText('저장하지 않은 내용이 있어요')
  await ask(p).locator('[data-testid="oef-ask-discard"]').click()
  await expect(oef(p)).toHaveCount(0, { timeout: 30_000 })
  expect(posted.length).toBe(before)
  expect(await used()).toBe(6)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-10 「다른 이름으로 저장」의 새 카드가 만들어지지 않으면 — 막대가 말하고, 원래 카드 그대로, 닫으면 묻고, 다시 시도는 같은 편집본으로', async ({ browser }) => {
  const c = await draftCard('답장초안_사본실패_김서연.txt')
  const p = await page(browser)
  await openChat(p)
  await card(p, c.name).click()
  await textReady(p)
  await typeAtEnd(p, ' 새카드로만')
  const posted = []
  let refuse = true
  await p.route('**/api/messages/*/save-as', (r) => {
    posted.push(r.request().postDataJSON())
    return refuse ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '새 카드를 만들지 못했어요(시험)' }) }) : r.continue()
  })
  await ed(p).locator('.qa-save-as').click()
  await ask(p).locator('[data-testid="oef-ask-name"]').fill('김서연 회신 사본')
  await ask(p).locator('[data-testid="oef-ask-save"]').click()
  await expect(badge(p)).toHaveAttribute('data-state', 'failed', { timeout: 40_000 })
  await expect(badge(p)).toHaveAttribute('title', /새 카드를 만들지 못했어요\(시험\)/)
  await expect(p.locator('[data-testid="oef-notice"]')).toContainText('다른 이름으로 저장하지 못했어요')
  await expect(p.locator('[data-testid="oef-notice"]')).not.toContainText('채팅의 파일 카드에서 이 버전이 열려요')
  await shot(p, 'f-cs-10-save-as-failed')
  // the editor did save (the copy is up), the card did not move, and the edit still counts as not saved here
  expect(posted[0].url).toMatch(/\/edited-[^/]+\.txt$/)
  expect((await cardOf(c.id)).url).toBe(c.url)
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(ask(p)).toContainText('저장하지 않은 내용이 있어요')
  await ask(p).locator('[data-testid="oef-ask-cancel"]').click()
  // 다시 시도: the same copy, now made into the new card
  refuse = false
  await badge(p).click()
  await expect(oef(p).locator('.bar .name')).toHaveText('김서연 회신 사본.txt', { timeout: 30_000 })
  expect(posted.length).toBe(2)
  expect(posted[1]).toEqual(posted[0])
  const [made] = await S.q(`select content from pro_messages where thread_id=$1 and content->>'name'=$2`, [mainId, '김서연 회신 사본.txt'])
  expect(await textAt(made.content.url)).toContain('새카드로만')
  expect((await cardOf(c.id)).url).toBe(c.url)
  expect(await textAt(c.url)).not.toContain('새카드로만')
  expect(p.errors).toEqual([])
  await p.context().close()
})

// what a real failed upload looks like: storage refuses the editor's copy once (a stand-in in front of the local storage)
function storageProxy(target = 'http://127.0.0.1:54321') {
  const tu = new URL(target)
  const state = { failNext: false, failed: 0 }
  const server = http.createServer((req, res) => {
    if (state.failNext && req.method === 'POST' && /^\/storage\/v1\/object\/files\/.*edited-/.test(req.url)) {
      state.failNext = false; state.failed++
      req.resume()
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'storage unavailable (test)' }))
      return
    }
    const up = http.request({ host: tu.hostname, port: tu.port, path: req.url, method: req.method, headers: { ...req.headers, host: tu.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
    up.on('error', () => res.destroy())
    req.pipe(up)
  })
  return new Promise((resolve) => {
    const port = freePort(5470)
    server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(r)) }))
  })
}

test('F-CS-11 (고친 호스트) 실제로 올리기에 실패한 저장: 편집기는 저장됐다고 여기고 단추가 꺼지지만, 다시 시도로 다시 올라감', async ({ browser }) => {
  test.skip(!process.env.RT_FIXED_HOST_DIR, '올리지 못한 저장을 다시 올리는 이음오피스 호스트 빌드가 필요(RT_FIXED_HOST_DIR — process-gpt-office-host fix/ipc-keepalive)')
  const proxy = await storageProxy()
  const was = process.env.RT_OFFICE_HOST_DIR
  process.env.RT_OFFICE_HOST_DIR = process.env.RT_FIXED_HOST_DIR
  const fixed = await startOfficeHost({ from: 5406, env: { SUPABASE_URL: proxy.url, IEUM_ALLOWED_SOURCES: 'http://127.0.0.1:54321' } })
  if (was == null) delete process.env.RT_OFFICE_HOST_DIR; else process.env.RT_OFFICE_HOST_DIR = was
  R.target = fixed.url
  try {
    const c = await draftCard('답장초안_재시도_김서연.txt')
    const p = await page(browser)
    await openChat(p)
    await card(p, c.name).click()
    await textReady(p)
    await typeAtEnd(p, ' 다시올림')
    proxy.state.failNext = true
    await pressSave(p)
    await expect(badge(p)).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
    expect(proxy.state.failed).toBe(1)
    await expect(badge(p)).toHaveAttribute('title', /편집기가 문서를 올리지 못했어요/)
    // the editor itself took the save as done: its 저장 is off — 다시 시도 still writes it again (its ⌘S) and it goes up this time
    await expect(ed(p).locator('.qa-btn[aria-label^="저장"]').first()).toBeDisabled()
    await shot(p, 'f-cs-11-real-upload-failed')
    await badge(p).click()
    await expect(badge(p)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
    await expect.poll(async () => textAt((await cardOf(c.id)).url), { timeout: 20_000 }).toContain('다시올림')
    expect(p.errors).toEqual([])
    await p.context().close()
  } finally {
    R.target = hostUrl
    await fixed.stop()
    await proxy.close()
  }
})

// 2026-11-27 사용자: 「PC 에서 shift 누른상태로 커서 이동하면 해당 캐럿에서 선택이 되어야 하는데 안되더군... 이음오피스 텍스트파일」. The selection was made
// (getSelection · typing over it worked, here and on the host alone) but not seen: the text editor paints the caret's line opaque over the
// selection it draws behind the text. So: the line with its selection must look different from the same line without it.
test('F-CS-12 PC 의 텍스트 편집기: Shift+→ ×5 · Shift+End 로 캐럿에서 고르고 그 줄에서 보이며, 치면 고른 것을 바꾼다 · Shift+클릭도 캐럿에서 고른다', async ({ browser }) => {
  const c = await draftCard('답장초안_선택_김서연.txt')
  const p = await page(browser)
  await openChat(p)
  await card(p, c.name).click()
  await textReady(p)
  const editorPage = p.frames().find((fr) => fr.url().includes('/office/markdown/'))
  const picked = () => editorPage.evaluate(() => String(window.getSelection()))
  await ed(p).locator('.cm-line').first().click({ position: { x: 3, y: 6 } })
  await p.keyboard.press('Home')
  for (let i = 0; i < 5; i++) await p.keyboard.press('Shift+ArrowRight')
  expect(await picked()).toBe('김서연 님')
  await p.keyboard.press('Shift+End')
  expect(await picked()).toBe('김서연 님께')
  // seen on the caret's own line: the line with the selection and without it (the caret hidden, so its blinking does not count)
  await editorPage.evaluate(() => { const st = document.createElement('style'); st.id = 'rt-no-caret'; st.textContent = '.cm-cursorLayer { display: none !important; }'; document.head.appendChild(st) })
  const line = ed(p).locator('.cm-line.cm-activeLine')
  const withSel = await line.screenshot()
  await shot(p, 'f-cs-12-shift-selection')
  await p.keyboard.press('End')
  const without = await line.screenshot()
  expect(withSel.equals(without)).toBe(false)
  await p.keyboard.press('Shift+Home')
  expect(await picked()).toBe('김서연 님께')
  await editorPage.evaluate(() => document.getElementById('rt-no-caret')?.remove())
  await p.keyboard.type('X')
  await expect.poll(() => editorText(p)).toMatch(/^X\n/)
  // Shift+click: from the caret to where it is clicked
  await ed(p).locator('.cm-line').nth(2).click({ position: { x: 3, y: 6 } })
  await p.keyboard.press('Home')
  await p.keyboard.down('Shift')
  await ed(p).locator('.cm-line').nth(4).click()
  await p.keyboard.up('Shift')
  expect(await picked()).toMatch(/^요청하신 일정 확인했습니다\.\n\n1\. 일정/)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-13 시트의 칸을 치고 ↓ 나 다른 칸 누르기로 마친 뒤 닫으면 묻는다(칸을 치는 동안 편집기의 저장은 꺼져 있음)', async ({ browser }) => {
  const xlsx = await XLSX_OF([['이름', '사용일수'], ['김서연', 3]])
  const a = await rawPost(ME.token, '/attachments', xlsx, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': encodeURIComponent('휴가_시험.xlsx') })
  await S.q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'agent', 'file', $2)`, [mainId, { name: '휴가_시험.xlsx', url: a.url }])
  const p = await page(browser)
  await stubSheets(p)
  await openChat(p)
  for (const finish of ['ArrowDown', 'click']) {
    await card(p, '휴가_시험.xlsx').click()
    await sheetReady(p)
    await ed(p).locator('#cell').click()
    await p.keyboard.type(' 6', { delay: 30 })
    // a while in the cell: the editor's 저장 is off all along (the edit is still the cell's)
    await p.waitForTimeout(1500)
    await expect(ed(p).locator('.qa-btn')).toBeDisabled()
    if (finish === 'ArrowDown') await p.keyboard.press('ArrowDown')
    else await ed(p).locator('#other').click()
    await expect(ed(p).locator('.qa-btn')).toBeEnabled()
    await oef(p).locator('.tb.ic[title="닫기"]').click()
    await expect(ask(p)).toContainText('저장하지 않은 내용이 있어요')
    await ask(p).locator('[data-testid="oef-ask-discard"]').click()
    await expect(oef(p)).toHaveCount(0, { timeout: 30_000 })
  }
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-14 공유 폴더의 시트: 칸을 치고 ↓ 로 마치면 손을 멈춘 뒤 저절로 편집기의 저장을 누른다', async ({ browser }) => {
  const xlsx = await XLSX_OF([['이름', '사용일수'], ['김서연', 3]])
  const fo = await S.api(ME.token, '/folders', { method: 'POST', body: { name: '시험 시트 폴더', description: '자동 저장' } })
  panelCleanup.push(() => S.q('delete from pro_folders where slug=$1', [fo.slug]))
  await rawPost(ME.token, `/folders/${fo.slug}/files?path=${encodeURIComponent('휴가.xlsx')}`, xlsx, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const p = await page(browser)
  await stubSheets(p)
  await p.goto(`/folders/${fo.slug}`)
  await p.getByText('휴가.xlsx', { exact: true }).first().click()
  await sheetReady(p)
  await sheetFrame(p).evaluate(() => { window.__answer = false })
  await ed(p).locator('#cell').click()
  await p.keyboard.type(' 6', { delay: 30 })
  await p.keyboard.press('ArrowDown')
  // the pause (6 s): the frame presses the editor's own 저장, now on
  await expect.poll(() => sheetFrame(p).evaluate(() => window.__saveClicks), { timeout: 20_000 }).toBeGreaterThan(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-15 「다른 이름으로 저장」에서 편집기가 답하지 않으면 다시 시도는 같은 이름으로 다시 — 원래 카드에 쓰지 않는다', async ({ browser }) => {
  test.setTimeout(240_000)
  const c = await draftCard('답장초안_무응답_김서연.txt')
  const p = await page(browser)
  await openChat(p)
  await card(p, c.name).click()
  await textReady(p)
  await typeAtEnd(p, ' 이름바꿔서')
  // the editor's 저장 does not get the press (its answer never comes)
  const editorPage = p.frames().find((fr) => fr.url().includes('/office/markdown/'))
  await editorPage.evaluate(() => {
    window.__block = true
    document.addEventListener('click', (e) => {
      const b = e.target.closest?.('.qa-btn')
      if (window.__block && b && /^저장/.test(b.getAttribute('aria-label') || '')) { e.stopImmediatePropagation(); e.preventDefault() }
    }, true)
  })
  await ed(p).locator('.qa-save-as').click()
  await ask(p).locator('[data-testid="oef-ask-name"]').fill('김서연 회신 재시도')
  await ask(p).locator('[data-testid="oef-ask-save"]').click()
  await expect(badge(p)).toHaveAttribute('data-state', 'failed', { timeout: 45_000 })
  await expect(badge(p)).toHaveAttribute('title', /다른 이름으로 저장하지 못했어요/)
  // 다시 시도: the 「다른 이름으로 저장」 again, with the same name — not a save of this card
  await editorPage.evaluate(() => { window.__block = false })
  await badge(p).click()
  await expect(oef(p).locator('.bar .name')).toHaveText('김서연 회신 재시도.txt', { timeout: 40_000 })
  expect((await cardOf(c.id)).url).toBe(c.url)
  const [made] = await S.q(`select content from pro_messages where thread_id=$1 and content->>'name'=$2`, [mainId, '김서연 회신 재시도.txt'])
  expect(await textAt(made.content.url)).toContain('이름바꿔서')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CS-16 (실제 엑셀 편집기, RT_REAL_SHEETS=1) 칸을 치고 ↓ 로 마친 뒤 닫으면 묻는다', async ({ browser }) => {
  test.skip(process.env.RT_REAL_SHEETS !== '1', '실제 엑셀 편집기 시험은 RT_REAL_SHEETS=1 일 때만(이 PC 의 빌드된 호스트에서는 시트 화면이 멈출 수 있음 — file-download.spec.js)')
  test.setTimeout(240_000)
  const xlsx = await XLSX_OF([['이름', '사용일수'], ['김서연', 3]])
  const a = await rawPost(ME.token, '/attachments', xlsx, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': encodeURIComponent('휴가_실제.xlsx') })
  await S.q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'agent', 'file', $2)`, [mainId, { name: '휴가_실제.xlsx', url: a.url }])
  const p = await page(browser)
  await openChat(p)
  await card(p, '휴가_실제.xlsx').click()
  await expect(p.locator('[data-testid="oef-opening"]')).toHaveCount(0, { timeout: 120_000 })
  const shown = async () => (await Promise.all(p.frames().filter((f) => f.url().includes('/office/')).map((f) => f.evaluate(() => document.body?.innerText || '').catch(() => '')))).join(' ')
  // (the editor's status line: 「통합 문서를 모두 로드했습니다」, or while it streams rows 「… N행 사용 가능」)
  await expect.poll(shown, { timeout: 120_000 }).toMatch(/통합 문서를 모두 로드했습니다|행 사용 가능/)
  await p.waitForTimeout(2500)
  // a cell of the grid (its own canvas): a click selects it, typing opens the cell editor
  const grid = ed(p).locator('canvas').first()
  const box = await grid.boundingBox()
  await p.mouse.click(box.x + 150, box.y + 45)
  await p.keyboard.type('6', { delay: 60 })
  await p.waitForTimeout(1500)
  await p.keyboard.press('ArrowDown')
  await p.waitForTimeout(800)
  await shot(p, 'f-cs-16-real-sheet-committed')
  await oef(p).locator('.tb.ic[title="닫기"]').click()
  await expect(ask(p)).toContainText('저장하지 않은 내용이 있어요', { timeout: 10_000 })
  await ask(p).locator('[data-testid="oef-ask-discard"]').click()
  await expect(oef(p)).toHaveCount(0, { timeout: 30_000 })
  await p.context().close()
})

test('F-CS-17 열린 문서의 카드를 다시 눌러도 같은 열기 — 그 뒤 「다른 이름으로 저장」해도 원래 카드는 저장한 판 그대로, 막대가 멈추지 않음', async ({ browser }) => {
  const c = await draftCard('답장초안_재클릭_김서연.txt')
  const p = await page(browser)
  await openChat(p)
  await card(p, c.name).click()
  await textReady(p)
  await typeAtEnd(p, ' 첫판')
  await pressSave(p)
  await expect(badge(p)).toHaveAttribute('data-state', 'saved', { timeout: 30_000 })
  await expect.poll(async () => (await cardOf(c.id)).url || '', { timeout: 20_000 }).toMatch(/\/edited-[^/]+\.txt$/)
  const v1 = (await cardOf(c.id)).url
  // the card in the chat follows (its address is the edited copy now), and is pressed again: nothing is asked, nothing reloads
  await p.waitForTimeout(1500)
  await card(p, c.name).click()
  await p.waitForTimeout(1500)
  await expect(ask(p)).toHaveCount(0)
  await expect(badge(p)).toHaveAttribute('data-state', 'saved')
  await expect.poll(() => editorText(p)).toContain('첫판')
  await typeAtEnd(p, ' 둘째판')
  await ed(p).locator('.qa-save-as').click()
  await ask(p).locator('[data-testid="oef-ask-name"]').fill('재클릭 사본')
  await ask(p).locator('[data-testid="oef-ask-save"]').click()
  await expect(oef(p).locator('.bar .name')).toHaveText('재클릭 사본.txt', { timeout: 40_000 })
  await expect(badge(p)).toHaveCount(0)
  // the card I saved from: the version it was saved as (첫판), not the edits that went to the new name
  const orig = await cardOf(c.id)
  const text = await textAt(orig.url)
  expect(text).toContain('첫판')
  expect(text).not.toContain('둘째판')
  expect(orig.url === v1 || (orig.versions || []).length > 0).toBe(true)
  const [made] = await S.q(`select content from pro_messages where thread_id=$1 and content->>'name'=$2`, [mainId, '재클릭 사본.txt'])
  expect(await textAt(made.content.url)).toContain('둘째판')
  expect(p.errors).toEqual([])
  await p.context().close()
})

// a .pptx of one slide (python-pptx), written for the test
function PPTX() {
  const out = path.join(os.tmpdir(), `rt-cs-${process.pid}-${Date.now()}.pptx`)
  execFileSync('python3', ['-c', 'import sys\nfrom pptx import Presentation\np=Presentation()\ns=p.slides.add_slide(p.slide_layouts[1])\ns.shapes.title.text="12월 일정"\ns.placeholders[1].text="본사 3층 · 정하윤"\np.save(sys.argv[1])', out])
  const b = fs.readFileSync(out)
  fs.rmSync(out, { force: true })
  return b
}
test('F-CS-18 손대지 않은 워드 · 파워포인트 · 한글 문서는 열고 바로 닫아도 묻지 않는다(편집기가 열자마자 「고친 것 있음」이라 하지 않음)', async ({ browser }) => {
  test.setTimeout(300_000)
  const files = [
    { name: '회의록_시험.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: fs.readFileSync(path.join(REPO, 'e2e/fixtures/meeting-minutes-template.docx')), ready: (p) => expect(ed(p).locator('.ProseMirror').first()).toBeVisible({ timeout: 90_000 }) },
    { name: '일정_시험.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes: PPTX(), ready: (p) => expect(ed(p).locator('.stage-wrap, .slide-list').first()).toBeVisible({ timeout: 90_000 }) },
    { name: '제안서_시험.hwpx', type: 'application/hwp+zip', bytes: fs.readFileSync(path.join(REPO, 'server/fixtures/interior-proposal-template.hwpx')), ready: (p) => expect(ed(p).locator('iframe').first()).toBeVisible({ timeout: 90_000 }) },
  ]
  for (const f of files) {
    const a = await rawPost(ME.token, '/attachments', f.bytes, { 'Content-Type': f.type, 'X-File-Name': encodeURIComponent(f.name) })
    await S.q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'agent', 'file', $2)`, [mainId, { name: f.name, url: a.url, type: f.type }])
  }
  const p = await page(browser)
  await openChat(p)
  for (const f of files) {
    await card(p, f.name).click()
    await expect(p.locator('[data-testid="oef-opening"]')).toHaveCount(0, { timeout: 120_000 })
    await f.ready(p)
    // (the editor settles: fonts, layout, the 한글 studio's own page)
    await p.waitForTimeout(6000)
    await expect(badge(p)).toHaveCount(0)
    await oef(p).locator('.tb.ic[title="닫기"]').click()
    await expect(ask(p)).toHaveCount(0)
    await expect(oef(p)).toHaveCount(0, { timeout: 30_000 })
  }
  expect(p.errors).toEqual([])
  await p.context().close()
})
