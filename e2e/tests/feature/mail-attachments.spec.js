// 메일 첨부를 곧바로 열고, 채팅으로 묻고, 동료와 나눈다 (2026-11-25 사용자: 「메일 첨부를 곧바로 이음오피스 등의 도구로 열어보거나 채팅으로 해당
// 메일에 대한 질의/액션을 취할 수 있는 뭔가 흐름이 있어야」 — 메일 시트의 회색 칩 「… 정규직 급여대장.xlsx」가 아무 일도 하지 않았다).
// 스펙 openspec/specs/mail-attachments, 서버 lib/mailAttachments.js · lib/privateStore.js, 화면 src/mailAttach.js.
//   F-MA-01 시트의 xlsx 칩을 누르면 이음오피스가 그 파일을 연다(셀 값이 그대로) — 네트워크에 /object/public/ 주소가 하나도 없다,
//           편집기의 「저장」은 내 채팅의 비공개 파일 카드(「편집본 · 나만 볼 수 있어요」), 그 카드를 누르면 다시 열림
//   F-MA-02 그림 첨부 → 앱의 보기 화면(서명 주소, 토큰 없음) · zip → 차분한 「내려받기」 · 문서도 ⋯ 메뉴의 「내려받기」
//   F-MA-03 칩의 ⋯ → 「이 첨부로 묻기」 → 입력창에 메일 칩 + 첨부 칩 → 「이 급여대장 총액 맞는지 봐줘」 → 가짜 에이전트가 첨부를 읽어 합계를 확인
//   F-MA-04 「이 메일로」 줄의 「이 첨부로 묻기」 → 첨부 셋 모두 칩 · 칩을 AI 입력창에 끌어 놓아도 같은 칩
//   F-MA-05 정리된 메일(「만들고 정리」 → 폴더에서 숫자를 고침) → 칩이 폴더의 사본을 연다(고친 값)
//   F-MA-06 다른 사람 → 404(열기 · 경로 · 끌기)
//   F-MA-07 메신저에 끌어 놓기 → 동료는 이름 · 요약만 → 열기 요청 → 주인이 「파일 공유」 → 동료가 읽기 전용으로 엶 → 공유 그만두기 → 다시 잠김,
//           다시 공유한 것을 메일 시트의 공유 목록 「공유 중 · 서민재 · 끄기」로 끔(검토 11-25 #5)
//   F-MA-08 390px 휴대폰(밝은 · 밤): 칩 · ⋯ 메뉴 · 「내려받기」가 화면 안, 옆으로 넘치지 않음
//   F-MA-09 팩스(TIFF — 운영 11-25 「[KT 스마트메시지 Plus] 팩스 메시지 도착알림」의 arrive_….tif 가 FILE · 「앱 안에서 열지 않는 형식이에요」뿐이던 것):
//           칩은 IMG → 앱의 보기 화면 ‹ 1 / 2 › → 2쪽(그려진 그림), 손상된 TIFF 는 차분한 안내, 「이 첨부로 묻기」 → 가짜 에이전트가 쪽마다 PNG 를 읽음
//   F-MA-10 팩스 · 390px 휴대폰(밝은 · 밤): 칩 · 보기 화면 · 쪽 넘기기가 화면 안, 한 쪽이 통째로 보임
//   F-FD-07 첨부를 연 곳의 「내려받기」(스펙 file-download): 이음오피스 머리 → 첨부 이름 · 메일의 바이트(누를 때 받은 서명 경로, 편집기가 연 10분 주소가
//           아님) · 워드 첨부를 고친 뒤 → 먼저 저장(내 채팅의 비공개 카드) → 그 편집본 · 보기 화면의 그림도 이름 그대로 · 공개 주소 없음
// TIFF 시험 파일은 e2e/fixtures/tiff (만든 방법은 server/fixtures/tiff/make.py).
// 자기 스택(lib/localStack.js — 테넌트 mailatt-ui, BFF 8930~ · Vite 5330~), 실제 이음오피스 편집기(lib/officeHost.js, 5395~), 이 파일이 띄우는
// 가짜 Google(Gmail 원문 · 첨부, 8937~), 가짜 deepagents(8938~ — 받은 첨부를 실제로 읽어 합계를 셈), 가짜 모델(8936~ — 채팅 라우터는 늘
// DELEGATE). 실제 모델 · 공용 deepagents · completion · 허브는 부르지 않는다. BFF 의 에이전트 작업 공간은 임시 폴더(PGPT_ROOT 를 그 옆으로)라 개발 PC 의 작업 공간에 쓰지 않는다.
// 사람 · 회사는 지어낸 것이다(한지우 · 서민재, 세무법인 오가람, 하늘테크).
//   RT_OFFICE_HOST_DIR=/path/to/process-gpt-office-host  cd e2e && npx playwright test --project=feature tests/feature/mail-attachments.spec.js
import { test, expect } from '@playwright/test'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { startStack, freePort, waitFor, REPO, SERVER } from '../../lib/localStack.js'
import { startOfficeHost, officeHostDir } from '../../lib/officeHost.js'
import { XLSX, PNG } from '../../lib/seed.js'

test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/mail-attachments/e2e/results')
const TENANT = 'mailatt-ui'
const DESK = { viewport: { width: 1440, height: 900 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NAMES = ['2026년 11월 하늘테크 정규직 급여대장.xlsx', '현장 사진.png', '증빙 묶음.zip']
const SUBJECT = '2026년 11월 급여대장 확인 부탁드립니다'
const SENDER = '세무법인 오가람 <tax@ogaram-tax.example>'
const CARD_TEXT = '세무법인 오가람 2026년 11월 급여대장 확인 후 확정·발송'
const ROWS = [['이름', '기본급', '공제', '실지급'], ['한지우', 3200000, 320000, 2880000], ['서민재', 2900000, 290000, 2610000], ['합계', 6100000, 610000, 5490000]]
const ASK = '이 급여대장 총액 맞는지 봐줘'
const MAIL_ID = 'g-ma-payroll-1'
// the fax of the report (KT 스마트메시지 Plus, 2026-11-25): a two-page CCITT G4 TIFF, and a damaged one beside it
const FAX_ID = 'g-ma-fax-1'
const FAX_SUBJECT = '[KT 스마트메시지 Plus] 팩스 메시지 도착알림'
const FAX_NAMES = ['arrive_xroshotplus_uengine1_20261125095030049_121017596357694.tif', '팩스_손상.tif']
const tif = (n) => fs.readFileSync(path.join(REPO, 'e2e/fixtures/tiff', n))
const FAX_ASK = '이 팩스 무슨 내용이야?'
let S, host, OW, MATE, keyring, pgptRoot, tmpRoot, google, agent, SHEET, PIC
const req = createRequire(path.join(SERVER, 'package.json'))

// ---------- the fake Google: the mail as Gmail keeps it (RFC 822, with its attachments) ----------
const gmail = { raw: null, calls: 0, mails: {} }
function startGoogle(port) {
  const srv = http.createServer((rq, res) => {
    const u = new URL(rq.url, 'http://x')
    const m = /^\/gmail\/v1\/users\/me\/messages\/([^/?]+)$/.exec(u.pathname)
    // (the size first — the server does not fetch a message larger than it takes)
    const raw = m && (m[1] === MAIL_ID ? gmail.raw : gmail.mails[m[1]])
    if (raw && u.searchParams.get('format') === 'minimal') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: m[1], sizeEstimate: raw.length }))
    }
    if (raw && u.searchParams.get('format') === 'raw') {
      gmail.calls++
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: m[1], threadId: m[1] === MAIL_ID ? 'thr-ma-1' : `thr-${m[1]}`, raw: raw.toString('base64url') }))
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  return new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => ok(srv)))
}

// ---------- the fake deepagents: it reads the attachment the turn names (a workspace path or a private address) and adds it up ----------
const sse = (res, obj, ev) => res.write(`${ev ? `event: ${ev}\n` : ''}data: ${JSON.stringify(obj)}\n\n`)
const workspaceOf = () => path.join(pgptRoot, 'services', 'deepagents', 'workspace', TENANT)
async function readSheet(buf) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets[0]
  const cell = (a) => Number(ws.getCell(a).value)
  return { D2: cell('D2'), D3: cell('D3'), D4: cell('D4') }
}
function startAgent(port) {
  agent = { bodies: [], read: null, how: null }
  const srv = http.createServer((rq, res) => {
    let raw = ''
    rq.on('data', (c) => { raw += c })
    rq.on('end', async () => {
      if (!rq.url.endsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}') }
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      agent.bodies.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(res, { conversation_id: body.conversation_id || `conv-${Date.now()}` }, 'metadata')
      try {
        const msg = String(body.message || '')
        // a fax (lib/tiff.js): each page handed over as a PNG picture beside it — the stand-in model "reads" the pictures (opens each, checks
        // it is a PNG of a fax page); a real model that reads pictures would read the words on them
        const pics = [...msg.matchAll(/\d+쪽 (\/workspace\/uploads\/\S+?-page\d+\.png)/g)].map((x) => x[1])
        if (pics.length) {
          agent.pics = pics.map((pth) => {
            const b = fs.readFileSync(path.join(workspaceOf(), pth.slice('/workspace'.length)))
            return { png: b.subarray(1, 4).toString() === 'PNG', w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
          })
          sse(res, { type: 'token', content: `팩스 ${pics.length}쪽을 그림으로 받아 읽었어요(${agent.pics.map((x) => `${x.w}×${x.h}`).join(', ')}).` })
          return res.end()
        }
        // the file line of lib/fileRefs.js turnRefs: a path in the agent's workspace, or a signed private address
        const p = /^- (\/workspace\/uploads\/.+?\.xlsx) \(/m.exec(msg)?.[1]
        const u = /(https?:\/\/\S+\/storage\/v1\/object\/sign\/\S+)/.exec(msg)?.[1]
        let buf = null
        if (p) { buf = fs.readFileSync(path.join(workspaceOf(), p.slice('/workspace'.length))); agent.how = 'path' }
        else if (u) { buf = Buffer.from(await (await fetch(u)).arrayBuffer()); agent.how = 'signed' }
        if (!buf) { sse(res, { type: 'token', content: '첨부를 찾지 못했어요.' }); return res.end() }
        agent.read = await readSheet(buf)
        const { D2, D3, D4 } = agent.read
        const fmt = (n) => n.toLocaleString('ko-KR')
        sse(res, { type: 'token', content: D2 + D3 === D4 ? `실지급 합계 ${fmt(D4)}원이 두 사람의 실지급(${fmt(D2)} + ${fmt(D3)})을 더한 값과 맞아요.` : `합계가 맞지 않아요: ${fmt(D2 + D3)} ≠ ${fmt(D4)}` })
      } catch (e) { sse(res, { type: 'token', content: `(가짜 에이전트 오류: ${e.message})` }) }
      res.end()
    })
  })
  return new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => ok(srv)))
}

// ---------- the fake model: the chat's router hands every message to the agent (DELEGATE); anything else gets nothing to go on ----------
const llm = { calls: 0 }
function startModel(port) {
  const srv = http.createServer((rq, res) => {
    let raw = ''
    rq.on('data', (c) => { raw += c })
    rq.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      llm.calls++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: body.tools ? 'DELEGATE' : '{}' }, finish_reason: 'stop' }] }))
    })
  })
  return new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => ok(srv)))
}

// ---------- the page ----------
async function page(browser, who, opts = DESK, { theme = 'light', dock = false } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th, d]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    if (d) localStorage.setItem('pgl-messenger-dock', JSON.stringify({ dock: 'left', width: 420 }))
  }, [JSON.stringify(who.session), theme, dock])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  // every address the page and its frames asked for, and what the server's JSON answers said
  p.urls = []
  p.bodies = []
  p.on('request', (r) => p.urls.push(r.url()))
  p.on('response', async (r) => { if (/\/api\//.test(r.url()) && /json/.test(r.headers()['content-type'] || '')) p.bodies.push(await r.text().catch(() => '')) })
  return p
}
const noPublic = (p) => {
  const bad = [...p.urls, ...p.bodies].filter((x) => /\/storage\/v1\/object\/public\//.test(x))
  expect(bad, '네트워크에 /object/public/ 주소가 없다').toEqual([])
}
const shot = async (p, name) => { await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const sheetOf = (p) => p.locator('[data-test="mail-sheet"]')
const chipOf = (p, i) => sheetOf(p).locator('[data-test="mail-attachment"]').nth(i)
const box = (p) => p.locator('[data-test="chat-composer"] textarea').last()
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function drag(p, source, target, { drop = true } = {}) {
  const dt = await p.evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer: dt })
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  if (!drop) return dt
  await target.dispatchEvent('drop', { dataTransfer: dt })
  await source.dispatchEvent('dragend', { dataTransfer: dt }).catch(() => {})
  return dt
}
// the live editor's MCP (the open document), as the person
async function mcp(who, name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/mcp/office`, {
    method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const t = await r.text()
  let b
  try { b = JSON.parse(t) } catch { b = JSON.parse(/^data: (.*)$/m.exec(t)[1]) }
  return (b.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}
async function cellsOf(who, file, addresses) {
  let doc = null
  await waitFor(async () => { doc = JSON.parse((await mcp(who, 'office_live_documents')) || '{}').documents?.find((d) => d.file_name === file && d.ready); return !!doc }, 60_000, 'open document')
  return JSON.parse(await mcp(who, 'office_live_read', { session_id: doc.session_id, addresses })).cells
}
const srcOf = async (p) => new URL(await p.locator('.oef iframe.frm').getAttribute('src'), S.web).searchParams.get('src')
// the editor says it has loaded the workbook (its cells are drawn on a canvas a moment later — then a picture shows them)
const shownText = async (p) => (await Promise.all(p.frames().filter((f) => f.url().includes('/office/')).map((f) => f.evaluate(() => document.body?.innerText || '').catch(() => '')))).join(' ')
async function loaded(p) {
  await expect.poll(() => shownText(p), { timeout: 30_000 }).toContain('통합 문서를 모두 로드했습니다')
  await p.waitForTimeout(2500)
}

// ---------- the mail card ----------
async function freshCard(who = OW, { mailId = MAIL_ID, subject = SUBJECT, text = CARD_TEXT } = {}) {
  await S.q('delete from pro_actions where user_id=$1', [who.id])
  const main = (await S.api(who.token, '/threads'))[0]
  await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [who.id])
  await S.q('update pro_threads set conversation_id=null, status=null where id=$1', [main.id])
  const [a] = await S.q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Review',$2,$3,$4) returning *`,
    [who.id, text, mailId === MAIL_ID ? '급여대장을 확인하고 확정해 주세요.' : '팩스를 확인해 주세요.', { mail_id: mailId, thread_id: mailId === MAIL_ID ? 'thr-ma-1' : `thr-${mailId}`, from: mailId === MAIL_ID ? SENDER : 'KT 스마트메시지 Plus <noreply@fax.kt.example>', subject, kind: 'task' }])
  return a
}
async function openSheet(p, a, { phone = false } = {}) {
  await p.goto('/chat')
  if (phone) await p.locator('.seg button').filter({ hasText: '홈' }).click()
  await p.locator(`[data-test="action-card"][data-action-id="${a.id}"]`).click()
  await expect(sheetOf(p).locator('[data-test="mail-original"]')).toContainText(a.source.mail_id === MAIL_ID ? 'tax@ogaram-tax.example' : 'noreply@fax.kt.example', { timeout: 30_000 })
  await expect(sheetOf(p).locator('[data-test="mail-attachment-open"]')).toHaveCount(a.source.mail_id === MAIL_ID ? 3 : FAX_NAMES.length)
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  test.skip(!officeHostDir(), '빌드된 office-host 가 없음 (RT_OFFICE_HOST_DIR — 그 저장소 README §9)')
  fs.mkdirSync(SHOTS, { recursive: true })
  const root = tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-mailatt-'))
  // the vault's keyring of this test (the server and this process seal and open the same Google connection)
  keyring = path.join(root, 'keyring.json')
  const kek = crypto.randomBytes(32)
  fs.writeFileSync(keyring, JSON.stringify({ current: 'k1', keys: [{ id: 'k1', key: kek.toString('base64') }] }), { mode: 0o600 })
  process.env.PRO_VAULT_KEYRING = keyring
  // a process-gpt root of its own: the keys (.env) as they are, an agent workspace in a temporary folder
  const { PGPT_ROOT } = await import('../../lib/env.js')
  pgptRoot = path.join(root, 'pgpt')
  fs.mkdirSync(path.join(pgptRoot, 'services', 'deepagents', 'workspace'), { recursive: true })
  const realRoot = PGPT_ROOT || path.join(os.homedir(), 'process-gpt')
  fs.symlinkSync(path.join(realRoot, '.env'), path.join(pgptRoot, '.env'))
  // the mail: a payroll sheet, a picture, a zip
  SHEET = await XLSX(ROWS)
  PIC = PNG(320, 180, [40, 120, 200])
  const MailComposer = req('nodemailer/lib/mail-composer')
  gmail.raw = await new MailComposer({ from: SENDER, to: '한지우 <jiwoo@lite.example>', subject: SUBJECT, text: '안녕하세요, 세무법인 오가람입니다.\n11월 급여대장을 보내 드립니다. 확인 후 확정해 주세요.\n\n오가람 드림',
    attachments: [{ filename: NAMES[0], content: SHEET, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { filename: NAMES[1], content: PIC, contentType: 'image/png' }, { filename: NAMES[2], content: Buffer.from('504b0506000000000000000000000000000000000000', 'hex'), contentType: 'application/zip' }] }).compile().build()
  gmail.mails[FAX_ID] = await new MailComposer({ from: 'KT 스마트메시지 Plus <noreply@fax.kt.example>', to: '한지우 <jiwoo@lite.example>', subject: FAX_SUBJECT,
    text: '고객님께 팩스 메시지가 도착했습니다. 첨부 파일을 확인해 주세요.',
    attachments: [{ filename: FAX_NAMES[0], content: tif('fax-2p-g4.tif'), contentType: 'image/tiff' }, { filename: FAX_NAMES[1], content: tif('broken.tif'), contentType: 'image/tiff' }] }).compile().build()
  host = await startOfficeHost({ from: Number(process.env.RT_OFFICE_FROM) || 5395 })
  const F = Number(process.env.RT_FAKE_FROM) || 0
  const gp = F ? freePort(F, 6) : freePort(8937, 1) || freePort(59991, 5)
  google = await startGoogle(gp)
  const ap = F ? freePort(gp + 1, 6) : freePort(8938, 2)
  const fakeAgent = await startAgent(ap)
  google.agent = fakeAgent
  const lp = F ? freePort(ap + 1, 6) : freePort(8936, 1) || freePort(59995, 5)
  google.model = await startModel(lp)
  // (RT_API_FROM · RT_WEB_FROM · RT_FAKE_FROM: where to look for free ports when other stacks run on this machine)
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8930, webFrom: Number(process.env.RT_WEB_FROM) || 5330, officeTarget: host.url,
    env: { PGPT_ROOT: pgptRoot, PRO_VAULT_KEYRING: keyring, PRO_OFFICE_HOST_URL: host.url, PRO_GOOGLE_GMAIL_URL: `http://127.0.0.1:${gp}/gmail/v1`,
      PRO_DEEPAGENTS_URL: `http://127.0.0.1:${ap}`, PRO_CONTEXT_ROUTER_URL: '', PRO_LLM_BASE_URL: `http://127.0.0.1:${lp}/v1`, PRO_LLM_API_KEY: 'test',
      PRO_LLM_MODEL: 'fake', PRO_LLM_FAST_MODEL: 'fake', PRO_COMPLETION_URL: 'http://127.0.0.1:9', PRO_MEMENTO_URL: 'http://127.0.0.1:9',
      PRO_MCP_HUB_URL: 'http://127.0.0.1:9', PRO_JUDGE_URL: '', PRO_ONTOLOGY_BOLT_URL: '', PRO_STREAM_IDLE_MS: '120000' } })
  OW = await S.person('pro-rt-mailatt-owner@uengine.org', '한지우')
  MATE = await S.person('pro-rt-mailatt-mate@uengine.org', '서민재')
  await S.join(OW); await S.join(MATE)
  // 한지우's Gmail mailbox (this server's Google is the fake above)
  const vault = await import(path.join(SERVER, 'lib/vault.js'))
  const { config } = await import(path.join(SERVER, 'config.js'))
  await S.q('delete from pro_vault_items where user_id=$1', [OW.id]); await S.q('delete from pro_vault_keys where user_id=$1', [OW.id])
  await vault.putItem(OW.id, 'oauth', config.google.vaultSite, { username: OW.email, access_token: 'at-e2e', refresh_token: 'rt-e2e', expires_at: Date.now() + 6 * 3600_000,
    scope: 'openid email https://www.googleapis.com/auth/gmail.readonly', client_id: 'cid-e2e' }, { actor: 'mail' })
  await S.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'gmail',$2) on conflict (user_id) do update set provider='gmail', address=$2`, [OW.id, OW.email])
})
test.afterAll(async () => {
  if (S) {
    for (const u of [OW, MATE].filter(Boolean)) {
      for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit']) await S.q(`delete from ${t} where user_id=$1`, [u.id]).catch(() => {})
      await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
      await S.q(`delete from notifications where user_id=$1 or user_id=$2`, [u.id, u.email]).catch(() => {})
      const keys = (await S.q(`select name from storage.objects where bucket_id='lite-private' and starts_with(name, $1)`, [`mail/${TENANT}/${u.id}/`]).catch(() => [])).map((x) => x.name)
      if (keys.length) await (await import(path.join(SERVER, 'lib/supa.js'))).admin.storage.from('lite-private').remove(keys).catch(() => {})
    }
    for (const r of await S.q(`select id from chat_rooms where tenant_id=$1`, [TENANT]).catch(() => [])) {
      await S.q('delete from chats where id=$1', [r.id]).catch(() => {}); await S.q('delete from chat_rooms where id=$1', [r.id]).catch(() => {})
    }
    const fk = (await S.q(`select name from storage.objects where bucket_id='lite-private' and starts_with(name, $1)`, [`folders/${TENANT}/`]).catch(() => [])).map((x) => x.name)
    if (fk.length) await (await import(path.join(SERVER, 'lib/supa.js'))).admin.storage.from('lite-private').remove(fk).catch(() => {})
    await S.stop()
  }
  for (const s of [google, google?.agent, google?.model].filter(Boolean)) await new Promise((ok) => s.close(ok))
  await host?.stop()
  // (the keyring, and the agent workspace the BFF wrote the attachment into)
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('F-MA-01 시트의 xlsx 칩을 누르면 이음오피스가 그 파일을 연다 — 셀 값 그대로, /object/public/ 주소 없음 · 저장하면 내 채팅의 비공개 파일 카드', async ({ browser }) => {
  test.setTimeout(240_000)
  const a = await freshCard()
  const p = await page(browser, OW)
  await openSheet(p, a)
  const chip = chipOf(p, 0)
  await expect(chip.locator('[data-test="mail-attachment-open"]')).toContainText(NAMES[0])
  await expect(sheetOf(p).locator('[data-test="follow-askatt"]')).toBeVisible()
  await shot(p, 'ma01-1-sheet-chips')
  await chip.locator('[data-test="mail-attachment-open"]').click()
  // the panel opens the private copy by a signed address (the sheet steps away)
  await expect(p.locator('.oef iframe.frm')).toHaveAttribute('src', /\/office\/sheets\/\?src=/, { timeout: 30_000 })
  await expect(sheetOf(p)).toHaveCount(0)
  const src = await srcOf(p)
  expect(src).toMatch(new RegExp(`/storage/v1/object/sign/lite-private/mail/${TENANT}/${OW.id}/${a.id}/0-[0-9a-f]{16}/attachment\\.xlsx\\?token=`))
  const cells = await cellsOf(OW, NAMES[0], ['A1', 'B2', 'D3', 'D4'])
  expect([cells.A1.value, cells.B2.value, cells.D3.value, cells.D4.value]).toEqual(['이름', 3200000, 2610000, 5490000])
  await expect(p.locator('.oef .badge.live')).toContainText('대화와 연결됨', { timeout: 30_000 })
  await shot(p, 'ma01-2-office-open')

  // 저장 in the editor: the edited copy becomes my own private file card in my chat, said where
  let doc = null
  await waitFor(async () => { doc = JSON.parse(await mcp(OW, 'office_live_documents')).documents?.find((d) => d.file_name === NAMES[0] && d.ready); return !!doc }, 30_000, 'doc')
  const ctx = JSON.parse(await mcp(OW, 'office_live_read', { session_id: doc.session_id }))
  await mcp(OW, 'office_live_apply_ops', { session_id: doc.session_id, ops: [{ op: 'set_cell', sheetId: ctx.context.sheetId, address: 'B2', value: 3300000 }] })
  await p.frameLocator('.oef iframe.frm').locator('.qa-btn[aria-label^="저장"], .qa-btn[title^="저장"]').first().click()
  await expect(p.locator('.pnote')).toContainText('편집본을 내 채팅에 파일로 저장했어요 · 나만 볼 수 있어요', { timeout: 30_000 })
  const [card] = await waitFor(async () => { const r = await S.q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='file' and m.content ? 'mailAtt'`, [OW.id]); return r.length ? r : null }, 20_000, 'private card')
  expect(card.content.url).toBeUndefined()
  expect(card.content.private.key).toMatch(new RegExp(`^mail/${TENANT}/${OW.id}/${a.id}/0-[0-9a-f]{16}/edited-attachment_\\d{14}\\.xlsx$`))
  expect((await S.q('select source from pro_actions where id=$1', [a.id]))[0].source.att_edits['0'].msgId).toBe(card.id)
  await shot(p, 'ma01-3-saved-private-card')
  // the card in the chat says it is mine only, and opens again (a new signed address)
  await p.locator('.oef .tb.ic[title="닫기"]').click().catch(() => {})
  await expect(p.locator('.oef')).toHaveCount(0, { timeout: 15_000 })
  const fc = p.locator('[data-test="file-card"]', { hasText: NAMES[0] }).last()
  await expect(fc).toContainText('편집본 · 나만 볼 수 있어요')
  await fc.locator('button.file').click()
  await expect(p.locator('.oef iframe.frm')).toHaveAttribute('src', /object%2Fsign%2Flite-private|object\/sign\/lite-private/, { timeout: 30_000 })
  expect((await cellsOf(OW, NAMES[0], ['B2'])).B2.value).toBe(3300000)
  await shot(p, 'ma01-4-private-card-reopened')
  noPublic(p)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MA-02 그림 첨부 → 앱의 보기 화면(서명 주소, 토큰 없음) · zip → 차분한 「내려받기」 · 문서도 ⋯ 메뉴의 「내려받기」', async ({ browser }) => {
  const a = await freshCard()
  const p = await page(browser, OW)
  await openSheet(p, a)
  await chipOf(p, 1).locator('[data-test="mail-attachment-open"]').click()
  const v = p.locator('[data-test="media-viewer"]')
  await expect(v).toHaveAttribute('data-kind', 'image')
  const img = v.locator('[data-test="media-full"]')
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(320)
  const isrc = await img.getAttribute('src')
  expect(isrc).toMatch(new RegExp(`^/api/mail/attachments/${a.id}/1/raw\\?u=${OW.id}&exp=\\d+&inline=1&sig=`))
  expect(isrc).not.toMatch(/token=|eyJ|object\/public/)
  await shot(p, 'ma02-1-image-viewer')
  await p.keyboard.press('Escape')
  await expect(v).toHaveCount(0)
  await expect(sheetOf(p)).toBeVisible()
  // a zip: nothing opens by itself — a calm line and 「내려받기」
  await chipOf(p, 2).locator('[data-test="mail-attachment-open"]').click()
  const dl = chipOf(p, 2).locator('[data-test="mail-attachment-download"]')
  await expect(dl).toContainText('앱 안에서 열지 않는 형식이에요')
  const href = await dl.locator('a').getAttribute('href')
  expect(href).toMatch(new RegExp(`^/api/mail/attachments/${a.id}/2/raw\\?u=`))
  expect(href).not.toMatch(/inline=1/)
  const got = await p.request.get(`${S.web}${href}`)
  expect(got.status()).toBe(200)
  expect(got.headers()['content-disposition']).toMatch(/^attachment;/)
  await expect(chipOf(p, 2).locator('.adl')).not.toHaveCSS('color', 'rgb(194, 65, 12)')
  // the sheet: its ⋯ menu — 열기 · 이 첨부로 묻기 · 내려받기
  await chipOf(p, 0).locator('[data-test="mail-attachment-more"]').click()
  const menu = chipOf(p, 0).locator('[data-test="mail-attachment-menu"]')
  await expect(menu.locator('button')).toHaveText(['열기', '이 첨부로 묻기', '내려받기'])
  await shot(p, 'ma02-2-zip-download-and-menu')
  await menu.locator('[data-test="att-download"]').click()
  const dh = await chipOf(p, 0).locator('[data-test="mail-attachment-download"] a').getAttribute('href')
  const d = await p.request.get(`${S.web}${dh}`)
  expect(Buffer.from(await d.body()).equals(SHEET)).toBe(true)
  noPublic(p)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MA-03 칩의 ⋯ → 「이 첨부로 묻기」 → 입력창에 메일 칩과 첨부 칩 → 가짜 에이전트가 첨부를 읽어 합계를 확인', async ({ browser }) => {
  const a = await freshCard()
  const p = await page(browser, OW)
  await openSheet(p, a)
  await chipOf(p, 0).locator('[data-test="mail-attachment-more"]').click()
  await chipOf(p, 0).locator('[data-test="att-ask"]').click()
  await expect(sheetOf(p)).toHaveCount(0)
  const chips = p.locator('[data-test="chat-ref-chip"]')
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toHaveAttribute('data-kind', 'mail')
  await expect(chips.nth(0)).toContainText(SUBJECT)
  await expect(chips.nth(1)).toHaveAttribute('data-kind', 'mailatt')
  await expect(chips.nth(1)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
  await expect(chips.nth(1)).toContainText(NAMES[0])
  await expect(chips.nth(1)).toContainText('메일 첨부')
  await shot(p, 'ma03-1-composer-chips')
  agent.bodies.length = 0; agent.read = null
  await box(p).fill(ASK)
  await box(p).press('Enter')
  await expect.poll(() => agent.bodies.length, { timeout: 30_000 }).toBe(1)
  const msg = agent.bodies[0].message
  expect(msg).toContain(ASK)
  // the mail's words once (the sender, the subject, the body as data) and the attachment as a readable file — never a public address
  expect(msg.split(`- 제목: ${SUBJECT}`).length - 1).toBe(1)
  expect(msg).toContain('- 보낸 사람: 세무법인 오가람 <tax@ogaram-tax.example>')
  // (a folder of its own for this one write — review 11-25 #6)
  expect(msg).toMatch(new RegExp(`- /workspace/uploads/${OW.id}/mail/[0-9a-f-]{36}/${NAMES[0].replace(/[.]/g, '\\.')} \\(${NAMES[0].replace(/[.]/g, '\\.')} · 메일 「${SUBJECT}」의 첨부\\)`))
  expect(msg).not.toMatch(/object\/public/)
  await expect.poll(() => agent.read, { timeout: 15_000 }).toEqual({ D2: 2880000, D3: 2610000, D4: 5490000 })
  expect(agent.how).toBe('path')
  const answer = p.locator('.row.r-agent .bubble.agent').filter({ hasText: '실지급 합계 5,490,000원' })
  await expect(answer).toBeVisible({ timeout: 30_000 })
  // the sent message keeps both chips; the attachment's chip opens it again
  const sent = p.locator('[data-test="sent-ref"][data-kind="mailatt"]').last()
  await expect(sent).toContainText(NAMES[0])
  await shot(p, 'ma03-2-agent-answer')
  await sent.click()
  await expect(p.locator('.oef iframe.frm')).toHaveAttribute('src', /\/office\/sheets\//, { timeout: 30_000 })
  noPublic(p)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MA-04 「이 메일로」 줄의 「이 첨부로 묻기」 → 첨부 셋 모두 칩 · 첨부 칩을 AI 입력창에 끌어 놓아도 같은 칩', async ({ browser }) => {
  const a = await freshCard()
  const p = await page(browser, OW)
  await openSheet(p, a)
  await sheetOf(p).locator('[data-test="follow-askatt"]').click()
  await expect(sheetOf(p).locator('[data-test="follow-say"]')).toContainText(`첨부 3개(${NAMES.join(', ')})를 칩으로`)
  await sheetOf(p).locator('[data-test="follow-go"]').click()
  const chips = p.locator('[data-test="chat-ref-chip"]')
  await expect(chips).toHaveCount(4)
  expect(await chips.evaluateAll((els) => els.map((e) => e.dataset.kind))).toEqual(['mail', 'mailatt', 'mailatt', 'mailatt'])
  await expect(p.locator('[data-test="chat-ref-chip"][data-state="ready"]')).toHaveCount(4, { timeout: 15_000 })
  await shot(p, 'ma04-1-row-ask-all')
  // a chip dragged from the sheet onto the AI composer (a fresh page: no chips): the same chip; while it is dragged the sheet steps aside
  await openSheet(p, a)
  await expect(p.locator('[data-test="chat-ref-chip"]')).toHaveCount(0)
  const ta = p.locator('[data-test="chat-composer"]').last().locator('textarea')
  await drag(p, chipOf(p, 1).locator('[data-test="mail-attachment-open"]'), ta, { drop: false })
  await expect(p.locator('[data-test="chat-dropzone"]').last()).toContainText('AI에게 이 첨부로 묻기')
  await expect(p.locator('.veil.passing')).toHaveCount(1)
  await shot(p, 'ma04-2-chip-over-chat')
  await drag(p, chipOf(p, 1).locator('[data-test="mail-attachment-open"]'), ta)
  await expect(p.locator('[data-test="chat-ref-chip"][data-kind="mailatt"]')).toHaveCount(1)
  await expect(p.locator('[data-test="chat-ref-chip"][data-kind="mailatt"]')).toContainText(NAMES[1])
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MA-05 정리된 메일: 「만들고 정리」 뒤 폴더에서 숫자를 고치면, 칩은 폴더의 사본(고친 값)을 연다 — 비공개 서명 주소', async ({ browser }) => {
  test.setTimeout(240_000)
  const a = await freshCard()
  const filed = await S.api(OW.token, '/filing/file', { method: 'POST', body: { actionId: a.id, attachment: NAMES[0], newFolder: '급여대장' } })
  expect(filed.filed.path).toBeTruthy()
  const fixed = await XLSX([['이름', '기본급', '공제', '실지급'], ['한지우', 3250000, 325000, 2925000], ['서민재', 2900000, 290000, 2610000], ['합계', 6150000, 615000, 5535000]])
  const up = await fetch(`http://127.0.0.1:${S.apiPort}/api/folders/${encodeURIComponent(filed.filed.slug)}/files?path=${encodeURIComponent(filed.filed.path)}`, { method: 'POST', headers: { Authorization: `Bearer ${OW.token}`, 'Content-Type': 'application/octet-stream' }, body: fixed })
  expect(up.status).toBe(200)
  const p = await page(browser, OW)
  await openSheet(p, a)
  await expect(chipOf(p, 0)).toContainText('급여대장')
  await chipOf(p, 0).locator('[data-test="mail-attachment-open"]').click()
  await expect(p.locator('.oef iframe.frm')).toHaveAttribute('src', /\/office\/sheets\//, { timeout: 30_000 })
  const [f] = await S.q('select id from pro_folders where slug=$1', [filed.filed.slug])
  expect(await srcOf(p)).toMatch(new RegExp(`/storage/v1/object/sign/lite-private/folders/${TENANT}/${f.id}/[0-9a-f]{40}\\.xlsx\\?token=`))
  const cells = await cellsOf(OW, path.posix.basename(filed.filed.path), ['B2', 'D4'])
  expect([cells.B2.value, cells.D4.value]).toEqual([3250000, 5535000])
  await shot(p, 'ma05-1-folder-copy')
  noPublic(p)
  expect(p.errors).toEqual([])
  await p.context().close()
  await S.q('delete from pro_folders where id=$1', [f.id]).catch(() => {})
})

test('F-MA-06 다른 사람: 열기 · 경로 · 끌기 모두 404 (그 메일이 있다는 말도 없이)', async () => {
  const a = await freshCard()
  const open = await fetch(`http://127.0.0.1:${S.apiPort}/api/mail/attachments/${a.id}/0/open`, { method: 'POST', headers: { Authorization: `Bearer ${MATE.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: NAMES[0] }) })
  expect(open.status).toBe(404)
  expect(await open.text()).not.toContain(NAMES[0])
  const raw = await fetch(`http://127.0.0.1:${S.apiPort}/api/mail/attachments/${a.id}/0/raw`, { headers: { Authorization: `Bearer ${MATE.token}` } })
  expect(raw.status).toBe(404)
  const r = await S.api(MATE.token, '/files/resolve', { method: 'POST', body: { items: [{ src: 'mailatt', id: a.id, i: 0, name: NAMES[0] }] } })
  expect([r.items[0].ok, r.items[0].status]).toEqual([false, 404])
  // the owner's own signed address does not work for someone else
  const mine = await S.api(OW.token, `/mail/attachments/${a.id}/1/open`, { method: 'POST', body: { name: NAMES[1] } })
  const other = await fetch(`http://127.0.0.1:${S.apiPort}/api${mine.url.replace(OW.id, MATE.id)}`)
  expect(other.status).toBe(403)
})

test('F-MA-07 메신저에 끌어 놓기 → 동료는 이름 · 요약만 → 열기 요청 → 주인이 「파일 공유」 → 동료가 읽기 전용으로 → 공유 그만두기 → 다시 잠김', async ({ browser }) => {
  test.setTimeout(240_000)
  const a = await freshCard()
  const t = await S.api(OW.token, '/team/threads', { method: 'POST', body: { members: [MATE.id], title: '11월 급여' } })
  const titleFor = async (who) => (await S.api(who.token, '/team/threads')).find((x) => x.id === t.id)?.title
  const [mine, mates] = [await titleFor(OW), await titleFor(MATE)]
  const p = await page(browser, OW, DESK, { dock: true })
  await p.goto('/chat')
  await p.locator('button.msg-btn').click()
  await p.locator('.ms .tabs button').filter({ hasText: '대화' }).click()
  await p.locator('.ms .th').filter({ hasText: mine }).first().click()
  await p.locator('.ms .cmp textarea').waitFor()
  await p.locator(`[data-test="action-card"][data-action-id="${a.id}"]`).click()
  await expect(sheetOf(p).locator('[data-test="mail-attachment-open"]')).toHaveCount(3, { timeout: 30_000 })
  const conv = p.locator('.ms .pane .msgs')
  await drag(p, chipOf(p, 0).locator('[data-test="mail-attachment-open"]'), conv, { drop: false })
  await expect(p.locator('[data-test="msg-dropzone"]')).toContainText('여기에 놓으면 첨부를 멘션해요 · 동료에게는 이름만 보여요')
  await drag(p, chipOf(p, 0).locator('[data-test="mail-attachment-open"]'), conv)
  await p.locator('[data-test="mail-sheet"] header .x').click()
  const chip = p.locator('[data-test="msg-ref-chip"][data-kind="mailatt"]')
  await expect(chip).toContainText(NAMES[0])
  await expect(chip.locator('[data-test="msg-att-share"] input')).not.toBeChecked()
  await p.locator('.ms .cmp textarea').fill('이번 달 급여대장이에요')
  await shot(p, 'ma07-1-messenger-chip')
  await p.locator('[data-test="msg-send"]').click()
  const ownerCard = p.locator('.ms .msg.mine [data-test="mail-att-ref"]').last()
  await expect(ownerCard).toHaveAttribute('data-state', 'mine')
  await expect(ownerCard).toContainText('다른 사람에게는 이름만 보여요')
  // what the room keeps: the name and the mail's summary — no key, no address
  const [stored] = await S.q(`select messages from chats where id=$1 and messages->'pgpt'->>'kind'='mailref' limit 1`, [t.id])
  expect(stored.messages.pgpt.refs[0]).toMatchObject({ type: 'mailatt', name: NAMES[0], subject: SUBJECT, share: null })
  expect(JSON.stringify(stored)).not.toMatch(/storage\/v1|lite-private|attachment\.xlsx|\/raw\?/)
  // 서민재: the name only
  const q2 = await page(browser, MATE, DESK, { dock: true })
  await q2.goto('/chat')
  await q2.locator('button.msg-btn').click()
  await q2.locator('.ms .tabs button').filter({ hasText: '대화' }).click()
  await q2.locator('.ms .th').filter({ hasText: mates }).first().click()
  const card = q2.locator('.ms .msg [data-test="mail-att-ref"]').last()
  await expect(card).toHaveAttribute('data-state', 'summary')
  await expect(card.locator('[data-test="mail-att-ref-name"]')).toHaveText(NAMES[0])
  await expect(card).toContainText('이름만 보여요 · 파일은 한지우님이 공유해야 열 수 있어요')
  await expect(card.locator('[data-test="mail-att-ref-open"]')).toHaveCount(0)
  const blocked = await S.api(MATE.token, '/team/refs/open', { method: 'POST', body: { messageId: (await S.q(`select uuid from chats where id=$1 and messages->'pgpt'->>'kind'='mailref' limit 1`, [t.id]))[0].uuid, index: 0 } }).catch((e) => e)
  expect(blocked.status).toBe(403)
  await shot(q2, 'ma07-2-colleague-summary')
  await card.locator('[data-test="mail-att-ref-request"]').click()
  await expect(card).toHaveAttribute('data-state', 'requested')
  await expect.poll(async () => (await S.q(`select count(*)::int as n from notifications where user_id=$1 and type='mail_access'`, [OW.id]))[0].n).toBe(1)
  // the owner shares that file with the room
  await ownerCard.locator('[data-test="mail-att-ref-share"]').click()
  await expect(ownerCard).toContainText('이 대화방이 이 파일을 열 수 있어요')
  await expect(card).toHaveAttribute('data-state', 'shared', { timeout: 15_000 })
  await card.locator('[data-test="mail-att-ref-open"]').click()
  await expect(q2.locator('.oef iframe.frm')).toHaveAttribute('src', /readonly=1/, { timeout: 30_000 })
  await expect(q2.locator('.oef .badge.ro')).toHaveText('보기 전용')
  expect(await srcOf(q2)).toMatch(/\/storage\/v1\/object\/sign\/lite-private\//)
  // the colleague's editor got the sheet itself (read only): what its signed address serves is the attachment
  await loaded(q2)
  expect(await readSheet(Buffer.from(await (await fetch(await srcOf(q2))).arrayBuffer()))).toEqual({ D2: 2880000, D3: 2610000, D4: 5490000 })
  await shot(q2, 'ma07-3-colleague-read-only')
  // the owner stops sharing: locked again
  await ownerCard.locator('[data-test="mail-att-ref-share"]').click()
  await expect(ownerCard).toContainText('다른 사람에게는 이름만 보여요')
  await expect(card).toHaveAttribute('data-state', 'summary', { timeout: 15_000 })
  // shared again — and stopped from the mail sheet this time: its list says where each file is shared, each with 「끄기」 (also a room the
  // owner has left — review 11-25 #5)
  await ownerCard.locator('[data-test="mail-att-ref-share"]').click()
  await expect(card).toHaveAttribute('data-state', 'shared', { timeout: 15_000 })
  await p.locator(`[data-test="action-card"][data-action-id="${a.id}"]`).click()
  const shareLine = chipOf(p, 0).locator('[data-test="mail-attachment-share"]')
  await expect(shareLine).toHaveCount(1, { timeout: 15_000 })
  await expect(shareLine).toContainText('공유 중 · 서민재')
  await expect(chipOf(p, 1).locator('[data-test="mail-attachment-share"]')).toHaveCount(0)
  await shot(p, 'ma07-4-sheet-shares')
  await shareLine.locator('[data-test="mail-attachment-unshare"]').click()
  await expect(shareLine).toHaveCount(0)
  await expect(card).toHaveAttribute('data-state', 'summary', { timeout: 15_000 })
  noPublic(p); noPublic(q2)
  expect(p.errors).toEqual([])
  expect(q2.errors).toEqual([])
  await p.context().close(); await q2.context().close()
})

for (const theme of ['light', 'dark']) {
  test(`F-MA-08 휴대폰 390px(${theme === 'light' ? '밝은' : '밤'} 테마): 첨부 칩 · ⋯ 메뉴 · 「내려받기」가 화면 안, 옆으로 넘치지 않음`, async ({ browser }) => {
    const a = await freshCard()
    const p = await page(browser, OW, PHONE, { theme })
    await openSheet(p, a, { phone: true })
    for (let i = 0; i < 3; i++) {
      const b = await chipOf(p, i).locator('[data-test="mail-attachment-more"]').boundingBox()
      expect(b.x + b.width).toBeLessThanOrEqual(390)
    }
    await chipOf(p, 0).locator('[data-test="mail-attachment-more"]').click()
    const menu = chipOf(p, 0).locator('[data-test="mail-attachment-menu"]')
    await expect(menu).toBeVisible()
    const mb = await menu.boundingBox()
    expect(mb.x).toBeGreaterThanOrEqual(0)
    expect(mb.x + mb.width).toBeLessThanOrEqual(390)
    await chipOf(p, 2).locator('[data-test="mail-attachment-open"]').click()
    await expect(chipOf(p, 2).locator('[data-test="mail-attachment-download"]')).toBeVisible()
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `ma08-phone-${theme}`)
    // a tap on the sheet opens the panel over the whole phone
    await chipOf(p, 0).locator('[data-test="mail-attachment-open"]').click()
    await expect(p.locator('.oef iframe.frm')).toHaveAttribute('src', /\/office\/sheets\//, { timeout: 30_000 })
    await loaded(p)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `ma08-phone-${theme}-office`)
    noPublic(p)
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}

// ---------- a fax (TIFF) ----------
// what a canvas holds, read in the page: its size, how much of it is ink (dark pixels — 0 is a blank page) and a fingerprint
const ink = (canvas) => canvas.evaluate((c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let n = 0, h = 0
  for (let i = 0; i < d.length; i += 4) { if (d[i] < 100) n++; if (i % 64 === 0) h = (h * 31 + d[i]) % 1000000007 }
  return { w: c.width, h: c.height, share: n / (c.width * c.height), hash: h }
})
const faxCard = () => freshCard(OW, { mailId: FAX_ID, subject: FAX_SUBJECT, text: 'KT 스마트메시지 Plus 팩스 도착 — 내용 확인' })
const tiffView = (p) => p.locator('[data-test="media-viewer"] [data-test="tiff-view"]')

test('F-MA-09 팩스(TIFF) 첨부: 칩은 IMG → 보기 화면 ‹ 1 / 2 › → 2쪽까지 그려짐 · 손상된 TIFF 는 차분한 안내 · 「이 첨부로 묻기」 → 에이전트가 쪽마다 PNG 를 읽음', async ({ browser }) => {
  const a = await faxCard()
  const p = await page(browser, OW)
  await openSheet(p, a)
  // the chip of the report: a picture now, not FILE
  await expect(chipOf(p, 0).locator('.fx')).toHaveText('IMG')
  await expect(chipOf(p, 0).locator('[data-test="mail-attachment-open"]')).toContainText(FAX_NAMES[0])
  await shot(p, 'ma09-1-sheet-fax-chip')
  await chipOf(p, 0).locator('[data-test="mail-attachment-open"]').click()
  const v = tiffView(p)
  await expect(v).toHaveAttribute('data-state', 'ok', { timeout: 30_000 })
  await expect(p.locator('[data-test="media-viewer"]')).toHaveAttribute('data-kind', 'image')
  await expect(v.locator('[data-test="tiff-pos"]')).toHaveText('1 / 2')
  const pg = v.locator('[data-test="tiff-page"]')
  const c1 = await ink(pg)
  expect([c1.w, c1.h]).toEqual([1728, 2290])
  expect(c1.share).toBeGreaterThan(0.03)
  await expect(chipOf(p, 0).locator('[data-test="mail-attachment-download"]')).toHaveCount(0)
  await expect(p.getByText('앱 안에서 열지 않는 형식이에요')).toHaveCount(0)
  // read through this server's signed route (no sign-in token in it) — the header's 「내려받기」 too, under the fax's own name (spec file-download)
  const [fd] = await Promise.all([p.waitForEvent('download'), p.locator('[data-test="media-viewer"] header [data-test="download"]').click()])
  expect(fd.suggestedFilename()).toBe(FAX_NAMES[0])
  const dl = p.urls.filter((u) => new RegExp(`/api/mail/attachments/${a.id}/0/raw\\?`).test(u)).pop()
  expect(dl).toMatch(new RegExp(`/api/mail/attachments/${a.id}/0/raw\\?u=${OW.id}&exp=\\d+&inline=1&sig=`))
  expect(dl).not.toMatch(/token=|eyJ/)
  await expect(p.locator('[data-test="media-download"]')).toHaveCount(0)
  await shot(p, 'ma09-2-fax-viewer-page1')
  await v.locator('[data-test="tiff-next"]').click()
  await expect(v.locator('[data-test="tiff-pos"]')).toHaveText('2 / 2')
  const c2 = await ink(pg)
  expect(c2.share).toBeGreaterThan(0.03)
  expect(c2.hash).not.toBe(c1.hash)
  await shot(p, 'ma09-3-fax-viewer-page2')
  await p.keyboard.press('Escape')
  await expect(p.locator('[data-test="media-viewer"]')).toHaveCount(0)
  // the damaged one: the viewer says so calmly, with 「내려받기」
  await chipOf(p, 1).locator('[data-test="mail-attachment-open"]').click()
  await expect(tiffView(p).locator('[data-test="tiff-error"]')).toContainText('이 TIFF 는 열 수 없어요', { timeout: 30_000 })
  await expect(tiffView(p).locator('[data-test="tiff-download"]')).toHaveAttribute('download', '')
  await shot(p, 'ma09-4-damaged-tiff')
  await p.keyboard.press('Escape')
  // 「이 첨부로 묻기」: the agent gets the fax and each page as a PNG picture beside it
  await chipOf(p, 0).locator('[data-test="mail-attachment-more"]').click()
  await chipOf(p, 0).locator('[data-test="att-ask"]').click()
  const chips = p.locator('[data-test="chat-ref-chip"]')
  await expect(chips.nth(1)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 })
  agent.bodies.length = 0; agent.pics = null
  await box(p).fill(FAX_ASK)
  await box(p).press('Enter')
  await expect.poll(() => agent.bodies.length, { timeout: 30_000 }).toBe(1)
  const msg = agent.bodies[0].message
  expect(msg).toContain('팩스·TIFF 라서 쪽마다 그림(PNG)으로도 두었어요')
  expect(msg).toMatch(new RegExp(`1쪽 /workspace/uploads/${OW.id}/mail/[0-9a-f-]{36}/arrive_xroshotplus_uengine1_20261125095030049_121017596357694-page1\\.png, 2쪽 /workspace/uploads/`))
  expect(msg).not.toMatch(/object\/public/)
  await expect.poll(() => agent.pics, { timeout: 15_000 }).toEqual([{ png: true, w: 1728, h: 2290 }, { png: true, w: 1728, h: 2290 }])
  await expect(p.locator('.row.r-agent .bubble.agent').filter({ hasText: '팩스 2쪽을 그림으로 받아 읽었어요' })).toBeVisible({ timeout: 30_000 })
  await shot(p, 'ma09-5-agent-read-fax')
  noPublic(p)
  expect(p.errors).toEqual([])
  await p.context().close()
})

for (const theme of ['light', 'dark']) {
  test(`F-MA-10 팩스 · 휴대폰 390px(${theme === 'light' ? '밝은' : '밤'} 테마): 칩 · 보기 화면 · 쪽 넘기기가 화면 안, 한 쪽이 통째로 보임`, async ({ browser }) => {
    const a = await faxCard()
    const p = await page(browser, OW, PHONE, { theme })
    await openSheet(p, a, { phone: true })
    const b0 = await chipOf(p, 0).locator('[data-test="mail-attachment-more"]').boundingBox()
    expect(b0.x + b0.width).toBeLessThanOrEqual(390)
    await chipOf(p, 0).locator('[data-test="mail-attachment-open"]').click()
    const v = tiffView(p)
    await expect(v).toHaveAttribute('data-state', 'ok', { timeout: 30_000 })
    const b = await v.locator('[data-test="tiff-page"]').boundingBox()
    expect(b.width).toBeGreaterThan(330)
    expect(b.width).toBeLessThanOrEqual(390 - 31)
    expect(b.y + b.height).toBeLessThanOrEqual((await v.locator('[data-test="tiff-next"]').boundingBox()).y + 1)
    for (const t of ['tiff-prev', 'tiff-next', 'tiff-pos']) {
      const x = await v.locator(`[data-test="${t}"]`).boundingBox()
      expect(x.x).toBeGreaterThanOrEqual(0)
      expect(x.x + x.width).toBeLessThanOrEqual(390)
    }
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `ma10-phone-${theme}-fax-viewer`)
    await v.locator('[data-test="tiff-next"]').click()
    await expect(v.locator('[data-test="tiff-pos"]')).toHaveText('2 / 2')
    expect((await ink(v.locator('[data-test="tiff-page"]'))).share).toBeGreaterThan(0.03)
    await shot(p, `ma10-phone-${theme}-fax-page2`)
    noPublic(p)
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}

// ---------- 「내려받기」 where an attachment opened (spec file-download) ----------
// a mail with a Word contract and a picture (the docs editor: typing in it is what a person does)
const DOC_ID = 'g-ma-docx-1'
const DOC_SUBJECT = '하늘테크 용역 계약서 수정본 보내 드립니다'
const DOC_NAMES = ['하늘테크 용역 계약서 (수정본).docx', '현장 사진.png']
function DOCX(lines) {
  const out = path.join(os.tmpdir(), `rt-ma-dl-${process.pid}-${Date.now()}.docx`)
  const body = lines.map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('')
  const py = ['import sys, zipfile', 'z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)',
    `z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')`,
    `z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')`,
    `z.writestr("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + sys.argv[2] + '</w:body></w:document>')`, 'z.close()'].join('\n')
  execFileSync('python3', ['-c', py, out, body], { stdio: 'pipe' })
  const b = fs.readFileSync(out); fs.rmSync(out, { force: true }); return b
}
const docxText = (file) => execFileSync('python3', ['-c', 'import sys, zipfile, re; x = zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode("utf-8"); print(re.sub(r"<[^>]+>", "", re.sub(r"</w:p>", "\\n", x)))', file], { encoding: 'utf8' })

test('F-FD-07 첨부를 연 곳의 「내려받기」: 이음오피스 → 첨부 이름 · 메일의 바이트 · 고친 뒤에는 먼저 저장한 편집본 · 보기 화면의 그림 — 공개 주소 없음', async ({ browser }) => {
  test.setTimeout(240_000)
  const DOC = DOCX(['하늘테크 용역 계약서', '제1조 계약 기간: 2026년 12월 1일부터'])
  const MailComposer = req('nodemailer/lib/mail-composer')
  gmail.mails[DOC_ID] = await new MailComposer({ from: SENDER, to: '한지우 <jiwoo@lite.example>', subject: DOC_SUBJECT, text: '수정한 계약서와 현장 사진을 보내 드립니다.',
    attachments: [{ filename: DOC_NAMES[0], content: DOC, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, { filename: DOC_NAMES[1], content: PIC, contentType: 'image/png' }] }).compile().build()
  const a = await freshCard(OW, { mailId: DOC_ID, subject: DOC_SUBJECT, text: '하늘테크 용역 계약서 수정본 확인' })
  const p = await page(browser, OW)
  const sheet = async () => {
    await p.goto('/chat')
    await p.locator(`[data-test="action-card"][data-action-id="${a.id}"]`).click()
    await expect(sheetOf(p).locator('[data-test="mail-original"]')).toContainText('tax@ogaram-tax.example', { timeout: 30_000 })
    await expect(sheetOf(p).locator('[data-test="mail-attachment-open"]')).toHaveCount(2)
  }
  await sheet()
  await chipOf(p, 0).locator('[data-test="mail-attachment-open"]').click()
  await expect(p.locator('.oef iframe.frm')).toHaveAttribute('src', /\/office\/docs\/\?src=/, { timeout: 30_000 })
  const ed = p.frameLocator('.oef iframe.frm')
  await expect(ed.locator('.ProseMirror')).toBeVisible({ timeout: 90_000 })
  await p.waitForTimeout(2500)
  const btn = p.locator('.oef [data-testid="oef-download"]')
  await expect(btn).toBeVisible()
  // as it arrived: under the attachment's name, the mail's bytes — fetched from the signed route asked for at the press (not the storage
  // address the editor opened with, which lasts ten minutes and never names the file)
  const [d1] = await Promise.all([p.waitForEvent('download'), btn.click()])
  expect(d1.suggestedFilename()).toBe(DOC_NAMES[0])
  expect(fs.readFileSync(await d1.path()).equals(DOC)).toBe(true)
  expect(p.urls.some((u) => new RegExp(`/api/mail/attachments/${a.id}/0/raw\\?u=${OW.id}&exp=\\d+&sig=`).test(u))).toBe(true)
  await expect(p.locator('[data-test="download-note"]')).toHaveText(`내려받았어요 · ${DOC_NAMES[0]}`)
  await shot(p, 'fd07-1-office-download')
  // an edit not saved yet: 「내려받기」 saves first (my own private file card, no address on it) and downloads that edited copy
  await ed.locator('.ProseMirror p').last().click()
  await p.keyboard.press('End')
  await p.keyboard.type(' 첨부수정후받기', { delay: 25 })
  const [d2] = await Promise.all([p.waitForEvent('download', { timeout: 60_000 }), btn.click()])
  expect(d2.suggestedFilename()).toBe(DOC_NAMES[0])
  expect(docxText(await d2.path())).toContain('첨부수정후받기')
  await expect(p.locator('[data-test="download-note"]')).toHaveText(`방금 저장한 판을 내려받았어요 · ${DOC_NAMES[0]}`)
  const [card] = await waitFor(async () => { const r = await S.q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='file' and m.content ? 'mailAtt'`, [OW.id]); return r.length ? r : null }, 20_000, 'private card')
  expect(card.content.url).toBeUndefined()
  await shot(p, 'fd07-2-saved-then-downloaded')
  await p.locator('.oef .tb.ic[title="닫기"]').click()
  await expect(p.locator('.oef')).toHaveCount(0)
  // the picture, in the viewer: its header's 「내려받기」
  await sheet()
  await chipOf(p, 1).locator('[data-test="mail-attachment-open"]').click()
  const v = p.locator('[data-test="media-viewer"]')
  await expect(v).toBeVisible()
  const [d3] = await Promise.all([p.waitForEvent('download'), v.locator('header [data-test="download"]').click()])
  expect(d3.suggestedFilename()).toBe(DOC_NAMES[1])
  expect(fs.readFileSync(await d3.path()).equals(PIC)).toBe(true)
  await shot(p, 'fd07-3-viewer-download')
  noPublic(p)
  expect(p.errors).toEqual([])
  await p.context().close()
})
