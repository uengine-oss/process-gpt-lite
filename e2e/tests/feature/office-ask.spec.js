// 문서에서 고른 부분을 채팅으로 고치기 (2026-11-25 운영 녹화 「화면 기록 오전 6.57.42」 — 회의록_템플릿.docx 의 표 글씨를 골라 「글씨가 표의
// 윗부분에 붙어있다. 중앙정렬」이라고 채팅에 보냈더니 에이전트는 「세로 정렬을 중앙으로 맞췄습니다」라고 했지만 문서는 그대로였고, 라우터는 그 요청을
// 「새 주제」로 보냈고, 다음 요청 중에 「연결 안 됨」이 떴다. 사용자: 「이 선택을 했을 때 이 멘션이 여기 표시가 되어야 됩니다」 · 「이 버튼(AI 수정 요청)은
// 이제 없어도 될 것 같아요」 · 「MCP 로 이음오피스 쪽에 전달되어야 … 제대로 (세로) 중앙정렬이 될 것 같아요」). 스펙 openspec/specs/office-live-edit.
//   F-OA-01 문서에서 표 칸을 고르면 채팅 입력창에 그 자리 · 고른 글의 칩 → 보내면 메시지 앞에 붙고, 에이전트 턴에 고른 부분(블록 · 표 범위)이 가고,
//           에이전트가 이음오피스 라이브 MCP 로 그 칸만 세로 가운데로 → 열린 편집기의 그 칸이 바로 가운데, 답은 문서의 대화에(새 주제 아님)
//   F-OA-02 칩은 고른 것을 따라간다: 다른 곳을 고르면 바뀌고, 선택을 풀면 사라지고, ✕ 로 치우면 그 선택에는 다시 뜨지 않는다
//   F-OA-03 Lite 안의 편집기에는 「AI 수정 요청」이 없다(편집기 따로 열면 그대로)
//   F-OA-04 편집기가 「바뀐 곳 없음」이라고 한 편집은 했다고 하지 않는다 — 답이 「반영되지 않았어요」로, 에이전트에는 그 사실이 오류로
//   F-OA-05 대화가 없는 카드의 문서: 첫 요청은 라우터가 정한 대화로, 다음 요청부터는 그 대화로(라우터를 다시 거치지 않음)
//   F-OA-06 턴 도중 서버가 잠깐 사라져도(배포의 파드 교체) 「연결 안 됨」이 아니라 「다시 연결하는 중…」, 돌아오면 저절로 「대화와 연결됨」, 편집은 그대로 적용
//   F-OA-07 390px 휴대폰(밝은 · 밤): 문서 위 다이얼을 열면 같은 칩, 화면 밖으로 넘치지 않음
//   F-OA-08 이웃한 길 「@ 가리키기」: 켜고 표를 누르면 「@표 1 …」 칩, 보내면 메시지 앞에 붙고 에이전트 맥락에 「가리킨 대상」(밝은 테마에서도 읽히는 색)
// 실제 이음오피스 편집기(office-host 를 이 시험이 따로 띄움 — RT_OFFICE_HOST_DIR, lib/officeHost.js), 자기 스택(lib/localStack.js: 테넌트 office-ask,
// 8950~ · 5350~), 가짜 deepagents 겸 가짜 맥락 라우터(이 파일, 실제 Lite 의 /mcp/ieumoffice-live-editor 를 사용자 토큰으로 부름). 모델 없음.
// 사람 이름은 지어낸 것이다(한서윤).
//   RT_OFFICE_HOST_DIR=/path/to/process-gpt-office-host  cd e2e && npx playwright test --project=feature tests/feature/office-ask.spec.js
import { test, expect } from '@playwright/test'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStack, freePort, waitFor, REPO } from '../../lib/localStack.js'
import { startOfficeHost, officeHostDir } from '../../lib/officeHost.js'

test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })
const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(REPO, 'openspec/specs/office-live-edit/e2e/results')
const DOCX = fs.readFileSync(path.resolve(here, '../../fixtures/meeting-minutes-template.docx'))
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const FILE = '회의록_템플릿.docx'
const CELL_TEXT = '대표, 개발팀, 운영팀, 영업팀'
const ASK = '글씨가 표의 윗부분에 붙어 있어요. 세로 가운데로 맞춰 주세요'
const DESK = { viewport: { width: 1440, height: 900 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
let S, host, P, fake, SY

// ---- a proxy between Vite and the server: "the server goes away" (a deploy replacing its pod) and comes back ----
function cutProxy() {
  const socks = new Set()
  let target = 0
  let down = false
  const srv = net.createServer((c) => {
    if (down || !target) return c.destroy()
    const u = net.connect(target, '127.0.0.1')
    socks.add(c); socks.add(u)
    const bye = () => { c.destroy(); u.destroy(); socks.delete(c); socks.delete(u) }
    c.on('error', bye); u.on('error', bye); c.on('close', bye); u.on('close', bye)
    c.pipe(u); u.pipe(c)
  })
  return {
    srv, set: (p) => { target = p },
    down() { down = true; for (const s of socks) s.destroy(); socks.clear() },
    up() { down = false },
  }
}

// ---- the fake deepagents and context router (one server: a request with metadata.auto_route is the router's) ----
const agent = { bodies: [], routed: [], calls: [], mode: 'edit', gate: null }
const textOf = (r) => (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
async function mcp(jwt, name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/mcp/ieumoffice-live-editor`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const t = await r.text()
  let b
  try { b = JSON.parse(t) } catch { b = JSON.parse(/^data: (.*)$/m.exec(t)[1]) }
  const result = b.result || { isError: true, content: [{ type: 'text', text: JSON.stringify(b.error) }] }
  agent.calls.push({ name, args, result })
  return result
}
// what the chat sent about the selection (src/docSelection.js mentionContext): the JSON after the chip's label
const selectionIn = (message) => {
  const line = String(message).split('\n').find((l) => l.includes('골라 둔 부분이에요'))
  return line ? JSON.parse(line.slice(line.indexOf('= {') + 2, line.lastIndexOf('})') + 1)) : null
}
const sse = (res, obj, ev) => res.write(`${ev ? `event: ${ev}\n` : ''}data: ${JSON.stringify(obj)}\n\n`)
async function agentTurn(body, res) {
  const conv = body.conversation_id || `conv-${Date.now()}`
  sse(res, { conversation_id: conv }, 'metadata')
  const jwt = body.user_jwt
  const keep = setInterval(() => res.write(': waiting\n\n'), 2000)
  try {
    if (agent.gate) await agent.gate
    const sel = selectionIn(body.message)
    // (a message without a selection — @ 가리키기's mention: read only)
    if (!sel) { sse(res, { type: 'token', content: '가리키신 표를 확인했어요.' }); return }
    // as an agent does it: the open document's session, its content, then the edit at the selection's place
    let doc = null
    await waitFor(async () => { doc = JSON.parse(textOf(await mcp(jwt, 'office_live_documents')) || '{}').documents?.find((d) => d.file_name === FILE && d.ready); return !!doc }, 30000, 'open document')
    sse(res, { type: 'tool_start', tool: 'office_live_read', input: { session_id: doc.session_id } })
    await mcp(jwt, 'office_live_read', { session_id: doc.session_id })
    sse(res, { type: 'tool_end', tool: 'office_live_read' })
    const target = agent.mode === 'miss' ? { nodeType: 'table', blockIndexes: [0] } : { nodeType: 'table', blockIndexes: [sel.blockIndex] }
    const ops = [{ op: 'setTableCellFormat', target, range: sel.range, vAlign: 'center' }]
    sse(res, { type: 'tool_start', tool: 'office_live_apply_ops', input: { session_id: doc.session_id, ops } })
    await mcp(jwt, 'office_live_apply_ops', { session_id: doc.session_id, ops })
    sse(res, { type: 'tool_end', tool: 'office_live_apply_ops' })
    // (a stubborn agent: it says done whatever the tool said — the chat must not repeat that)
    sse(res, { type: 'token', content: `표 ${sel.table} · ${sel.range.row + 1}행 ${sel.range.col + 1}열 칸의 글씨를 세로 가운데로 맞췄어요.` })
  } catch (e) {
    sse(res, { type: 'token', content: `(가짜 에이전트 오류: ${e.message})` })
  } finally { clearInterval(keep); res.end() }
}
function startFake(port) {
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      if (!req.url.endsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}') }
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (body.metadata?.auto_route) {
        // the router files every request under a new topic (as production did with 「글씨가 표의 윗부분에 붙어있다. 중앙정렬」)
        agent.routed.push(body)
        const conv = `conv-new-${agent.routed.length}`
        sse(res, { conversation_id: conv, routing: { action: 'new', conversation_id: conv, context: { title: '새 주제 · 가짜 라우터' }, decision: { confidence: 0.75, strategy: 'logprob' } } }, 'metadata')
        return agentTurn({ ...body, conversation_id: conv }, res)
      }
      agent.bodies.push(body)
      return agentTurn(body, res)
    })
  })
  return new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => ok(srv)))
}

// ---- the page ----
async function page(browser, who, opts = DESK, { theme = 'light' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.touch = !!opts.hasTouch
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const editor = (p) => p.frameLocator('.oef iframe.frm')
const cell = (p, text = CELL_TEXT) => editor(p).locator('.ProseMirror td', { hasText: text }).first()
const chip = (p) => p.locator('[data-test=doc-selection-chip]').first()
const badge = (p) => p.locator('.oef .bar .badge')
const box = (p) => p.locator('.center .composer textarea').first()
// select a cell's words the way a person does: press at the first letter and drag to the last (mouse, or a finger's tap then drag)
async function selectCell(p, text = CELL_TEXT, frameSel = '.oef iframe.frm') {
  const loc = frameSel ? cell(p, text) : p.locator('.ProseMirror td', { hasText: text }).first()
  await loc.scrollIntoViewIfNeeded()
  // (the cell's words may be split over several text nodes — runs, marks): from its first letter to its last
  const r = await loc.evaluate((td) => {
    const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) })
    const nodes = []
    for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n)
    const first = nodes[0], last = nodes[nodes.length - 1]
    const rg = document.createRange()
    rg.setStart(first, first.data.search(/\S/)); rg.setEnd(last, last.data.trimEnd().length)
    const rs = [...rg.getClientRects()].filter((x) => x.width > 0)
    const a = rs[0], b = rs[rs.length - 1]
    return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 }
  })
  const off = frameSel ? await p.locator(frameSel).boundingBox() : { x: 0, y: 0 }
  // a phone: a tap at the end of the cell's words, then the selection grown letter by letter back to the first (a long press's
  // handles are the phone's own)
  if (p.touch) {
    await p.touchscreen.tap(off.x + r.x2 + 2, off.y + r.y2)
    for (let i = 0; i < text.length; i++) await p.keyboard.press('Shift+ArrowLeft')
    return
  }
  await p.mouse.move(off.x + r.x1, off.y + r.y1)
  await p.mouse.down()
  await p.mouse.move(off.x + (r.x1 + r.x2) / 2, off.y + r.y2, { steps: 4 })
  await p.mouse.move(off.x + r.x2, off.y + r.y2, { steps: 4 })
  await p.mouse.up()
}
const vAlignOf = (p, text = CELL_TEXT) => cell(p, text).evaluate((td) => getComputedStyle(td).verticalAlign)
// the person's main chat: a request, an answer the router put in 「회의록 템플릿」, the document's card (in that conversation)
async function seed(who, { conv = 'conv-minutes' } = {}) {
  const main = (await S.api(who.token, '/threads'))[0]
  await S.q('delete from pro_messages where thread_id=$1', [main.id])
  await S.q('update pro_threads set conversation_id=null, status=null where id=$1', [main.id])
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': DOCX_MIME, 'X-File-Name': encodeURIComponent(FILE) }, body: DOCX })
  expect(r.status).toBe(200)
  const up = await r.json()
  let t = Date.now() - 10_000
  const add = (role, kind, content) => S.q(`insert into pro_messages(thread_id, role, kind, content, created_at) values ($1,$2,$3,$4, to_timestamp($5/1000.0)) returning id`, [main.id, role, kind, content, t += 1000])
  if (conv) {
    await add('user', 'text', { text: '주간 회의록 양식을 만들어 줘' })
    await add('agent', 'text', { text: '회의록 양식을 만들었어요.', context: { title: '회의록 템플릿', action: 'new', conversationId: conv } })
  }
  const [card] = await add('agent', 'file', { name: FILE, url: up.url })
  return { main, card: card.id, url: up.url }
}
async function openDoc(p) {
  await p.goto('/chat')
  await p.locator('button.file', { hasText: FILE }).first().click()
  await expect(p.locator('.oef iframe.frm')).toHaveAttribute('src', /\/office\/docs\/\?src=.*assistant=parent/)
  await expect(badge(p).filter({ hasText: '대화와 연결됨' })).toBeVisible({ timeout: 60_000 })
  await expect(cell(p)).toBeVisible({ timeout: 60_000 })
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  test.skip(!officeHostDir(), '빌드된 office-host 가 없음 (RT_OFFICE_HOST_DIR — 그 저장소 README §9)')
  fs.mkdirSync(SHOTS, { recursive: true })
  host = await startOfficeHost({ from: 5395 })
  P = cutProxy()
  const pp = freePort(8955, 3)
  await new Promise((ok) => P.srv.listen(pp, '127.0.0.1', ok))
  const fp = freePort(8958, 2)
  fake = await startFake(fp)
  S = await startStack({ tenant: 'office-ask', apiFrom: 8950, webFrom: 5350, apiTarget: `http://127.0.0.1:${pp}`, officeTarget: host.url,
    env: { PRO_OFFICE_HOST_URL: host.url, PRO_DEEPAGENTS_URL: `http://127.0.0.1:${fp}`, PRO_CONTEXT_ROUTER_URL: `http://127.0.0.1:${fp}`, PRO_COMPLETION_URL: 'http://127.0.0.1:9', PRO_STREAM_IDLE_MS: '120000' } })
  P.set(S.apiPort)
  SY = await S.person('pro-rt-office-ask-sy@uengine.org', '한서윤')
  await S.join(SY)
})
test.afterAll(async () => {
  if (S) {
    await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [SY?.id]).catch(() => {})
    await S.q(`delete from context_threads where user_id=$1`, [SY?.id]).catch(() => {})
    await S.stop()
  }
  await new Promise((ok) => (fake ? fake.close(ok) : ok()))
  await new Promise((ok) => (P ? P.srv.close(ok) : ok()))
  await host?.stop()
})

test('F-OA-01 표 칸을 고르면 입력창에 그 칩 → 보내면 에이전트가 라이브 MCP 로 그 칸만 세로 가운데로, 열린 편집기에 바로 · 답은 문서의 대화에', async ({ browser }) => {
  agent.mode = 'edit'; agent.bodies.length = 0; agent.routed.length = 0; agent.calls.length = 0
  await seed(SY)
  const p = await page(browser, SY)
  await openDoc(p)
  const before = await vAlignOf(p)
  expect(before).not.toBe('middle')
  await expect(chip(p)).toHaveCount(0)

  await selectCell(p)
  await expect(chip(p)).toBeVisible({ timeout: 10_000 })
  await expect(chip(p)).toHaveAttribute('data-kind', 'table')
  await expect(chip(p)).toContainText(`@표 1 · 3행 2열 "${CELL_TEXT}"`)
  await shot(p, 'oa01-1-selection-chip')

  await box(p).fill(ASK)
  await box(p).press('Enter')
  // the person sees what was asked about which part, and the chip has gone with the message
  const mine = p.locator('.row.r-user .bubble.user').last()
  await expect(mine).toHaveText(`@표 1 · 3행 2열 "${CELL_TEXT}" ${ASK}`)
  await expect(chip(p)).toHaveCount(0)

  // the agent's turn: the request, the selection's place, the open document — in the document's conversation, not routed
  await expect.poll(() => agent.bodies.length, { timeout: 30_000 }).toBe(1)
  const b = agent.bodies[0]
  expect(b.message).toContain(ASK)
  const sel = selectionIn(b.message)
  expect(sel).toMatchObject({ editor: 'docs', where: 'table', text: CELL_TEXT, file: FILE, blockIndex: 2, table: 1, range: { row: 2, col: 1, rowEnd: 2, colEnd: 1 } })
  expect(b.message).toContain(`'${FILE}' 을 열어 두었어요`)
  expect(b.conversation_id).toBe('conv-minutes')
  expect(agent.routed).toHaveLength(0)

  // the edit through the live editor MCP, applied by IeumOffice — and on screen in the open editor
  await expect.poll(() => agent.calls.find((c) => c.name === 'office_live_apply_ops')?.result, { timeout: 30_000 }).toBeTruthy()
  const applied = agent.calls.find((c) => c.name === 'office_live_apply_ops')
  expect(applied.args.ops[0]).toMatchObject({ op: 'setTableCellFormat', target: { blockIndexes: [2] }, range: { row: 2, col: 1 }, vAlign: 'center' })
  expect(applied.result.isError, textOf(applied.result)).toBeFalsy()
  expect(JSON.parse(textOf(applied.result)).mutated).toBe(true)
  await expect.poll(() => vAlignOf(p), { timeout: 15_000 }).toBe('middle')
  // only that cell: its neighbour (참석자) stays as it was
  expect(await vAlignOf(p, '참석자')).toBe(before)

  // the answer in the chat, filed under the document's conversation (the router never asked)
  const answer = p.locator('.row.r-agent .bubble.agent').filter({ hasText: '세로 가운데로 맞췄어요' })
  await expect(answer).toBeVisible({ timeout: 30_000 })
  const ctx = p.locator('.row.r-agent', { has: p.locator('.bubble.agent', { hasText: '세로 가운데로 맞췄어요' }) }).locator('.ctx')
  await expect(ctx).toHaveClass(/continue/)
  await expect(ctx).toContainText('회의록 템플릿')
  await expect(ctx).not.toContainText('새 주제')
  // the review after it trusts what the editor confirmed (a format change is not in the text it compares)
  await expect(p.locator('.row.r-agent .bubble.agent', { hasText: '검수' }).last()).toContainText('편집기 확인', { timeout: 30_000 })
  await expect(p.locator('.row.r-agent .bubble.agent', { hasText: '검수' }).last()).not.toContainText('⚠')
  await shot(p, 'oa01-2-applied-in-editor')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-OA-02 칩은 고른 것을 따라간다 — 다른 칸, 선택 풀기, ✕ (같은 선택에는 다시 뜨지 않음)', async ({ browser }) => {
  await seed(SY)
  const p = await page(browser, SY, DESK, { theme: 'dark' })
  await openDoc(p)
  await selectCell(p)
  await expect(chip(p)).toContainText('3행 2열')
  // another cell: the chip follows
  await selectCell(p, '3층 소회의실')
  await expect(chip(p)).toContainText('@표 1 · 2행 2열 "3층 소회의실"')
  // dark theme: light violet on the dark composer (light theme: deep violet — F-OA-07)
  expect(await chip(p).evaluate((el) => getComputedStyle(el).color)).toBe('rgb(217, 210, 255)')
  await shot(p, 'oa02-1-chip-dark')
  // the selection let go (a click in the cell, no range): no chip
  await cell(p, '3층 소회의실').click()
  await expect(chip(p)).toHaveCount(0)
  // ✕: away for that selection…
  await selectCell(p, '3층 소회의실')
  await expect(chip(p)).toBeVisible()
  await p.locator('[data-test=doc-selection-remove]').click()
  await expect(chip(p)).toHaveCount(0)
  await p.waitForTimeout(800)
  await expect(chip(p)).toHaveCount(0)
  // …back for a new one
  await selectCell(p)
  await expect(chip(p)).toContainText('3행 2열')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-OA-03 Lite 안의 편집기에는 「AI 수정 요청」이 없다 — 편집기를 따로 열면 그대로', async ({ browser }) => {
  const { url } = await seed(SY)
  const p = await page(browser, SY)
  await openDoc(p)
  await selectCell(p)
  await expect(chip(p)).toBeVisible()
  await expect(editor(p).locator('.ai-ask-trigger')).toBeHidden()
  await shot(p, 'oa03-1-no-ai-ask-in-lite')
  // the same editor on its own (no ?assistant=parent): its 「AI 수정 요청」 is there
  const alone = await p.context().newPage()
  await alone.goto(`${host.url}/office/docs/?src=${encodeURIComponent(url)}&name=${encodeURIComponent(FILE)}&token=${encodeURIComponent(SY.token)}`)
  const td = alone.locator('.ProseMirror td', { hasText: CELL_TEXT }).first()
  await expect(td).toBeVisible({ timeout: 60_000 })
  await selectCell(alone, CELL_TEXT, null)
  await expect(alone.locator('.ai-ask-trigger')).toBeVisible({ timeout: 10_000 })
  await alone.screenshot({ path: path.join(SHOTS, 'oa03-2-standalone-keeps-ai-ask.png') })
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-OA-04 편집기가 「바뀐 곳 없음」이라고 한 편집은 했다고 하지 않는다', async ({ browser }) => {
  agent.mode = 'miss'; agent.bodies.length = 0; agent.calls.length = 0
  await seed(SY)
  const p = await page(browser, SY)
  await openDoc(p)
  const before = await vAlignOf(p)
  await selectCell(p)
  await expect(chip(p)).toBeVisible()
  await box(p).fill(ASK)
  await box(p).press('Enter')
  // the agent was told by the tool that nothing changed
  await expect.poll(() => agent.calls.find((c) => c.name === 'office_live_apply_ops')?.result, { timeout: 30_000 }).toBeTruthy()
  const r = agent.calls.find((c) => c.name === 'office_live_apply_ops').result
  expect(r.isError).toBe(true)
  expect(textOf(r)).toContain('적용되지 않았어요 — 바뀐 곳이 없어요')
  // …and the chat says so plainly, not the agent's 「맞췄어요」
  const answer = p.locator('.row.r-agent .bubble.agent').last()
  await expect(answer).toContainText(`요청한 수정이 '${FILE}' 문서에 반영되지 않았어요`, { timeout: 30_000 })
  await expect(p.locator('.row.r-agent .bubble.agent', { hasText: '맞췄어요' })).toHaveCount(0)
  expect(await vAlignOf(p)).toBe(before)
  await shot(p, 'oa04-1-not-applied-said-plainly')
  agent.mode = 'edit'
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-OA-05 대화가 없는 카드의 문서: 첫 요청은 라우터가 고른 대화로, 그다음부터는 그 대화로(새 주제로 다시 가지 않음)', async ({ browser }) => {
  agent.mode = 'edit'; agent.bodies.length = 0; agent.routed.length = 0; agent.calls.length = 0
  await seed(SY, { conv: null })
  const p = await page(browser, SY)
  await openDoc(p)
  await selectCell(p)
  await expect(chip(p)).toContainText('3행 2열')
  await box(p).fill(ASK)
  await box(p).press('Enter')
  await expect.poll(() => agent.routed.length, { timeout: 30_000 }).toBe(1)
  await expect(p.locator('.row.r-agent .bubble.agent', { hasText: '세로 가운데로 맞췄어요' })).toBeVisible({ timeout: 30_000 })
  // the next request about the same document: straight to its conversation (the one the first went to)
  await selectCell(p, '3층 소회의실')
  await expect(chip(p)).toContainText('2행 2열')
  await box(p).fill('이 칸도 세로 가운데로 맞춰 주세요')
  await box(p).press('Enter')
  await expect.poll(() => agent.bodies.length, { timeout: 30_000 }).toBe(1)
  expect(agent.bodies[0].conversation_id).toBe('conv-new-1')
  expect(agent.routed).toHaveLength(1)
  await expect.poll(() => vAlignOf(p, '3층 소회의실'), { timeout: 15_000 }).toBe('middle')
  const last = p.locator('.row.r-agent', { has: p.locator('.bubble.agent', { hasText: '2행 2열 칸의 글씨를' }) }).locator('.ctx')
  await expect(last).toHaveClass(/continue/, { timeout: 30_000 })
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-OA-06 턴 도중 서버가 잠깐 사라져도 「다시 연결하는 중…」, 돌아오면 저절로 「대화와 연결됨」 — 편집은 그대로 적용', async ({ browser }) => {
  test.setTimeout(240_000)
  agent.mode = 'edit'; agent.bodies.length = 0; agent.calls.length = 0
  let release
  agent.gate = new Promise((r) => { release = r })
  await seed(SY)
  const p = await page(browser, SY)
  await openDoc(p)
  await selectCell(p)
  await expect(chip(p)).toContainText('3행 2열')
  await box(p).fill(ASK)
  await box(p).press('Enter')
  await expect.poll(() => agent.bodies.length, { timeout: 30_000 }).toBe(1)
  // the server goes away for 20 s (a deploy replacing the pod — production 2026-11-25 06:58)
  P.down()
  await expect(p.getByTestId('oef-relinking')).toBeVisible({ timeout: 15_000 })
  await shot(p, 'oa06-1-relinking')
  const t0 = Date.now()
  while (Date.now() - t0 < 20_000) {
    await expect(p.locator('.oef .bar .badge.off')).toHaveCount(0)
    await p.waitForTimeout(1000)
  }
  P.up()
  release()
  await expect(badge(p).filter({ hasText: '대화와 연결됨' })).toBeVisible({ timeout: 20_000 })
  agent.gate = null
  await expect.poll(() => vAlignOf(p), { timeout: 30_000 }).toBe('middle')
  await shot(p, 'oa06-2-joined-again')
  await p.context().close()
})

test('F-OA-07 390px 휴대폰(밝은 · 밤): 문서 위 다이얼을 열면 고른 부분의 칩, 화면 밖으로 넘치지 않음', async ({ browser }) => {
  await seed(SY)
  for (const theme of ['light', 'dark']) {
    const p = await page(browser, SY, PHONE, { theme })
    await p.goto('/chat')
    // a phone-wide screen opens on 홈: the chat is its own tab
    await p.locator('header.top .seg button', { hasText: '채팅' }).click()
    await p.locator('button.file', { hasText: FILE }).first().click()
    await expect(cell(p)).toBeVisible({ timeout: 60_000 })
    await selectCell(p)
    await p.locator('.clo .dial').click()
    await expect(p.locator('.clo .band [data-test=doc-selection-chip]')).toContainText('3행 2열', { timeout: 10_000 })
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    const c = p.locator('.clo .band [data-test=doc-selection-chip]')
    const bb = await c.boundingBox()
    expect(bb.x).toBeGreaterThanOrEqual(0)
    expect(bb.x + bb.width).toBeLessThanOrEqual(390.5)
    expect(await c.evaluate((el) => getComputedStyle(el).color)).toBe(theme === 'dark' ? 'rgb(217, 210, 255)' : 'rgb(74, 54, 201)')
    await shot(p, `oa07-${theme}-phone-dial-chip`)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-OA-08 이웃한 길 「@ 가리키기」: 표를 누르면 칩, 보내면 메시지 앞에 붙고 에이전트 맥락에 가리킨 대상', async ({ browser }) => {
  agent.mode = 'edit'; agent.bodies.length = 0; agent.calls.length = 0
  await seed(SY)
  const p = await page(browser, SY)
  await openDoc(p)
  await p.locator('.oef .tb', { hasText: '가리키기' }).click()
  await expect(p.locator('.oef .tb.on', { hasText: '가리키는 중' })).toBeVisible()
  await cell(p).click()
  const pointed = p.locator('.center .composer .mention:not(.sel)').first()
  await expect(pointed).toContainText('@표 1', { timeout: 10_000 })
  // light theme: deep violet on the light composer (it was light lilac, nearly invisible)
  expect(await pointed.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(74, 54, 201)')
  await shot(p, 'oa08-1-pointed-mention-light')
  await box(p).fill('이 표의 참석자를 확인해 주세요')
  await box(p).press('Enter')
  await expect(p.locator('.row.r-user .bubble.user').last()).toContainText('@표 1')
  await expect.poll(() => agent.bodies.length, { timeout: 30_000 }).toBe(1)
  expect(agent.bodies[0].message).toContain('(사용자가 열린 문서에서 가리킨 대상: @표 1')
  expect(agent.bodies[0].conversation_id).toBe('conv-minutes')
  await expect(p.locator('.row.r-agent .bubble.agent', { hasText: '가리키신 표를 확인했어요' })).toBeVisible({ timeout: 30_000 })
  expect(p.errors).toEqual([])
  await p.context().close()
})
