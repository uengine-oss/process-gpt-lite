// 답 · 파일 아래의 단추를 문맥 메뉴로 (스펙 openspec/specs/answer-share 「답의 행동은 메시지 메뉴에 있다」 · openspec/specs/messenger-drop-folder
// 「채팅의 파일 카드는 정리 제안을 카드의 메뉴에 둔다」, 화면 Message.vue · AnswerShareSheet.vue · FileCardMenu.vue · HoldHint.vue · holdMenu.js ·
// folders/useFiling.js). 2026-11-28 사용자: 「화면이 정신없으니 하단의 공유, 프로젝트로 등록, 폴더 정리 등 모든 것들 콘텍스트 메뉴로. 모바일에선
// 길게 누를때」 — 운영 휴대폰 사진 두 장에서 답마다 「공유」 · 「프로젝트로 시작」 알약, 파일 카드마다 「‘…’에 정리할까요? (확신 65%) [정리] · 다른 폴더
// 고르기」 줄이 화면 대부분을 차지했다.
//   F-CM-01 휴대폰 390(밝은 · 어두운): 답 아래에 알약 없음 · 정보 줄(「계획 2/2」 · 「어떻게 했나요」)은 그대로 · 처음 한 번 「길게 누르면 …」 안내 ·
//           답을 길게 누르면 메뉴(대화방 · 사람에게 보내기 · 문서로 남기기 · 프로젝트로 시작 · 글 선택 · 글 복사) → 보내기는 방 고르기 · 프로젝트로 시작은
//           확인 카드 · 다시 열면 안내 없음
//   F-CM-02 휴대폰 390(어두운 → 밝은): 파일 카드 아래에 정리 줄 없음 · 제안이 기다리는 카드에 점 · 카드를 길게 누르면 메뉴(열기 · 팀원에게 공유 ·
//           「‘견적서’에 정리」 확신도 · 다른 폴더 고르기) → 정리 · 「새 폴더를 만들어 정리: …」 · 다른 폴더 고르기 → 카드 아래 「‘…’에 정리했어요 · 열기」 ·
//           점이 사라짐 · 카드를 누르면 그대로 열림
//   F-CM-03 PC 1280: 마우스를 올리면 「⋯」 · 오른쪽 클릭 · 「⋯」 · 키보드(Tab → Enter → 첫 항목에 초점 → Esc 로 닫히고 「⋯」로 초점이 돌아옴) — 답과
//           파일 카드 모두, 안내 없음, 카드를 누르면 메뉴가 아니라 문서
//   F-CM-04 휴대폰 390(PR #126 검토 · 최종 검토 — 재생기는 제 동작): 「⋯」는 보이지 않아도 접근성 트리에 있고(화면 낭독기 · 스위치 · 태블릿 키보드) Tab 으로 닿으면 보임 → Enter → 메뉴 →
//           Esc 로 「⋯」에 초점 · 안내는 스치듯 보이거나 입력창 밑에 반쯤 깔린 것으로는 「봤다」고 치지 않고, 온전히 1.5 초 보여야 기억
// 자기 스택(lib/localStack.js: 회사 ctx-menu-ui 의 BFF + Vite, 8992 · 5392 — RT_CM_API_PORT · RT_CM_WEB_PORT)을 띄우고 지운다. 가짜 모델(폴더 판정의
// 첫 글자 확률 · 새 폴더 이름 · 프로젝트 카드 초안)은 이 파일이 빈 포트에 띄운다 — 실제 모델 · 에이전트는 부르지 않는다. 사람 · 회사는 지어낸 것이다
// (정하윤 · 김서연, 가나정밀 · 다온디자인).
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/context-menu-actions.spec.js
import { test, expect } from '@playwright/test'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = { share: path.join(REPO, 'openspec/specs/answer-share/e2e/results'), filing: path.join(REPO, 'openspec/specs/messenger-drop-folder/e2e/results') }
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'ctx-menu-ui'
const API_PORT = Number(process.env.RT_CM_API_PORT || 8992)
const WEB_PORT = Number(process.env.RT_CM_WEB_PORT || 5392)
const busy = (port) => { try { execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return true } catch { return false } }

// a plain picture (one colour), built here — no file on disk
// a short silent sound (8 kHz, 16-bit mono): a chat audio card — its player keeps its own controls (PR #126 review)
function wav(ms = 300) {
  const n = Math.round(8 * ms), b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b
}
function png(w, h) {
  const chunk = (type, data) => {
    const b = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(b) >>> 0)
    return Buffer.concat([len, b, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([90, 140, 200]))])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const ANSWER = ['가나정밀 견적과 계약 자료를 정리했어요.', '', '- 견적 합계는 26,070,000원이고 유효기간은 견적일로부터 30일이에요.',
  '- 계약서 초안은 다온디자인과의 매장 리뉴얼 용역이에요.', '- 회의 메모에는 다음 주 화요일 현장 점검 일정이 있어요.'].join('\n')
const FILES = {
  quote: { name: '견적서_가나정밀.md', body: '# 견적서 — 가나정밀 교육장 인테리어\n\n| 품목 | 금액 |\n|---|---|\n| 설계비 | 3,000,000 |\n| 시공비 | 23,070,000 |\n' },
  contract: { name: '용역계약서_다온.md', body: '# 용역 계약서\n\n다온디자인(을)은 가나정밀(갑)의 매장 리뉴얼 디자인 용역을 수행한다.\n\n계약 금액 12,000,000원\n' },
  memo: { name: '회의메모_1128.md', body: '# 회의 메모\n\n- 다음 주 화요일 현장 점검\n- 참석: 정하윤, 김서연\n' },
  order: { name: '발주서_가나정밀.md', body: '# 발주서\n\n가나정밀 교육장 집기 발주 · 합계 4,200,000원\n' },
  // a picture: its preview under the card (MediaPreview) is held for the card's menu too (PR #126 review)
  photo: { name: '현장사진_1128.png', body: png(160, 120), type: 'image/png' },
  // a sound: held or right-clicked on its player, the player's own (seek · volume · the browser's menu) — not the card's menu
  voice: { name: '현장녹음_1128.wav', body: wav(), type: 'audio/wav' },
}

// ---- the fake model: the folder judge's first letter (the option naming 「견적서」 for the quote · the memo · the order, the last option —
// 「새 폴더가 필요하다」 — for the contract), a new folder's name, a project card's draft ----
let servers = []
const listen = (srv) => new Promise((ok, no) => srv.once('error', no).listen(0, '127.0.0.1', () => { servers.push(srv); ok(srv.address().port) }))
const bodyOf = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => { try { ok(JSON.parse(raw)) } catch { ok({}) } }) })
const judged = { n: 0 }
function fakeLlm(b) {
  const all = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const sys = String(b.messages?.[0]?.content || '')
  if (b.logprobs) {
    judged.n++
    const options = [...all.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
    const want = [FILES.quote.name, FILES.memo.name, FILES.order.name].some((n) => all.includes(n)) ? ['견적서'] : []
    const pick = (options.find((o) => want.some((w) => o.label.includes(w))) || options.at(-1) || { letter: 'A' }).letter
    const other = options.find((o) => o.letter !== pick)?.letter || 'Z'
    return { choices: [{ message: { content: pick }, logprobs: { content: [{ token: pick, logprob: Math.log(0.9), top_logprobs: [{ token: pick, logprob: Math.log(0.9) }, { token: other, logprob: Math.log(0.1) }] }] } }] }
  }
  let content = JSON.stringify({ name: '거래처 계약서', why: '계약서를 모을 곳' })
  if (sys.startsWith('너는 채팅에서 하던 이야기를')) {
    content = JSON.stringify({ title: '가나정밀 견적 · 계약 정리', intent: '견적과 계약 자료를 한곳에서 마무리한다', background: '채팅에서 정리한 견적 · 계약 자료에서 시작했어요',
      deliverables: ['최종 견적서', '계약서'], templates: [] })
  }
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }
}

let S, HY, SY, MAIN, ANS, QUOTES, MEETINGS
const CARD = {}
async function upload(who, slug, p, body) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/folders/${slug}/files?path=${encodeURIComponent(p)}`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/octet-stream' }, body })
  if (!r.ok) throw new Error(`upload ${p}: ${r.status} ${await r.text()}`)
}
async function attach(who, name, body, type = 'text/markdown') {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) }, body })
  if (!r.ok) throw new Error(`attach ${name}: ${r.status} ${await r.text()}`)
  return r.json()
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  for (const port of [API_PORT, WEB_PORT]) if (busy(port)) throw new Error(`port ${port} is in use — this file runs its own stack there (RT_CM_API_PORT · RT_CM_WEB_PORT)`)
  for (const d of Object.values(SHOTS)) fs.mkdirSync(d, { recursive: true })
  const llmPort = await listen(http.createServer(async (req, res) => {
    const b = await bodyOf(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(fakeLlm(b)))
  }))
  S = await startStack({ tenant: TENANT, apiFrom: API_PORT, webFrom: WEB_PORT, env: {
    PRO_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`, PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_LLM_MODEL: 'main-fake', PRO_LLM_FAST_MODEL: 'fast-fake', PRO_LLM_FRONT_MODEL: 'front-fake', PRO_LLM_ODDS_MODEL: 'fast-fake',
    PRO_DEEPAGENTS_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: '', PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_JUDGE_LLM: '0', PRO_EMBED_URL: '',
    PRO_MEMENTO_URL: NOWHERE, PRO_ONTOLOGY_BOLT_URL: '',
  } })
  if (S.apiPort !== API_PORT || S.webPort !== WEB_PORT) throw new Error(`the stack is not on ${API_PORT} · ${WEB_PORT}`)
  const cfg = await S.api(null, '/config')
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`port ${API_PORT} answers as another server, not this stack's BFF`)
  console.log(`[ctx-menu] stack on BFF ${S.apiPort} · web ${S.webPort}`)
  HY = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '정하윤')
  SY = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '김서연')
  for (const p of [HY, SY]) await S.join(p)
  await S.api(HY.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
  // 정하윤's folders: the quotes (the judge's pick for the quote) and the meetings (picked by hand for the memo)
  QUOTES = await S.api(HY.token, '/folders', { method: 'POST', body: { name: '견적서', description: '고객에게 보낸 견적서' } })
  await upload(HY, QUOTES.slug, '견적서_소망상사.md', '소망상사 견적 합계 1,200,000원')
  MEETINGS = await S.api(HY.token, '/folders', { method: 'POST', body: { name: '회의록', description: '팀 회의록과 회의 메모' } })
  await upload(HY, MEETINGS.slug, '주간회의_1121.md', '주간 회의록')
  // 정하윤's chat: the question, the answer (its plan and its trail — the info lines), the files the agent made
  ;[MAIN] = await S.api(HY.token, '/threads')
  await S.q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,'user','text',$2, now() - interval '6 minutes')`, [MAIN.id, { text: '가나정밀 견적과 계약 자료를 정리해 줘' }])
  ;[ANS] = await S.q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,'agent','text',$2, now() - interval '5 minutes') returning id`, [MAIN.id, {
    text: ANSWER,
    plan: { understood: '가나정밀 견적과 계약 자료를 정리해 달라는 요청으로 이해했어요.', steps: [{ id: 's1', text: '자료 읽기', state: 'done' }, { id: 's2', text: '정리하기', state: 'done' }], ms: 118000, state: 'done', source: 'front' },
    work: [{ phase: '자료 조회', n: 3, hosts: ['gana-precision.example'] }],
  }])
  let at = 4
  for (const [k, f] of Object.entries(FILES)) {
    const up = await attach(HY, f.name, f.body, f.type)
    ;[CARD[k]] = await S.q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,'agent','file',$2, now() - make_interval(secs => $3)) returning id`, [MAIN.id, { name: up.name || f.name, url: up.url, ...(f.type ? { type: f.type } : {}) }, Math.max(0, at * 60 - (k === 'order' ? 30 : 0))])
    at -= 1
  }
})
test.afterAll(async () => {
  for (const s of servers) await new Promise((ok) => s.close(ok))
  servers = []
  if (!S) return
  fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
  fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
  for (const p of [HY, SY].filter(Boolean)) {
    await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [p.id]).catch(() => {})
    await S.q('delete from pro_thread_folders where thread_id in (select id from pro_threads where user_id=$1)', [p.id]).catch(() => {})
    await S.q('delete from pro_threads where user_id=$1', [p.id]).catch(() => {})
    await S.q('delete from pro_followups where user_id=$1', [p.id]).catch(() => {})
    const keys = (await S.q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/${p.id}/`]).catch(() => [])).map((r) => r.name)
    if (keys.length) await S.q(`delete from storage.objects where bucket_id='files' and name = any($1)`, [keys]).catch(() => {})
  }
  for (const r of await S.q(`select id from chat_rooms where tenant_id=$1`, [TENANT]).catch(() => [])) {
    await S.q('delete from chats where id=$1', [r.id]).catch(() => {})
    await S.q('delete from pro_chat_reads where room_id=$1', [r.id]).catch(() => {})
    await S.q('delete from chat_rooms where id=$1', [r.id]).catch(() => {})
  }
  await S.q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await S.stop()
})

async function open(browser, who, opts, { theme = 'light' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', 'ko')
    localStorage.setItem('pgl-install', JSON.stringify({ never: true }))
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const calm = (p) => p.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((ok) => setTimeout(ok, 1500))]))
const shot = async (p, dir, name) => { await calm(p); await p.waitForTimeout(200); await p.screenshot({ path: path.join(SHOTS[dir], `${name}.png`) }) }
const noSideScroll = async (p) => expect(await p.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(await p.evaluate(() => window.innerWidth) + 1)
const answerRow = (p) => p.locator(`.row[data-id="${ANS.id}"]`)
const card = (p, k) => p.locator(`[data-test="file-card"][data-file="${FILES[k].name}"]`)
async function toChat(p, phone = false) {
  await p.goto('/chat')
  if (phone) await p.locator('.seg button').filter({ hasText: /^(채팅|Chat)$/ }).click()
}
// a real touch through the browser's input pipeline (Playwright has no long press) — as the messenger's reaction tests do
async function press(p, el, ms = 700) {
  // (where it stays: the chat may still be scrolling to its end as it loads — a touch on a moving answer lands elsewhere)
  let b = await el.boundingBox()
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(120)
    const n = await el.boundingBox()
    if (n && b && Math.abs(n.y - b.y) < 1 && Math.abs(n.x - b.x) < 1) break
    b = n
  }
  const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2
  // (and nothing over it there: on a phone, right after 「채팅」 is pressed, Home's panel still lies over the chat for a moment — a touch
  // then lands on Home, not on the answer)
  await expect.poll(() => el.evaluate((node, [px, py]) => node.contains(document.elementFromPoint(px, py)), [x, y]), { timeout: 5000 }).toBe(true)
  const cdp = await p.context().newCDPSession(p)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await p.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach().catch(() => {})
}
const inView = async (loc, p) => {
  const b = await loc.boundingBox()
  const v = p.viewportSize()
  expect(b, 'on screen').toBeTruthy()
  expect(b.x).toBeGreaterThanOrEqual(-0.5)
  expect(b.x + b.width).toBeLessThanOrEqual(v.width + 0.5)
  return b
}
const focused = (loc) => loc.evaluate((el) => el === document.activeElement)
// a phone's ⋯: no look and no room (1px, clipped) — but there for a screen reader, a switch, a keyboard (getByRole leaves out what is hidden from it)
async function hiddenButReachable(scope, name) {
  const b = scope.getByRole('button', { name, exact: true })
  await expect(b).toHaveCount(1)
  const box = await b.boundingBox()
  expect(box.width).toBeLessThanOrEqual(1)
  return b
}
// Tab from just before `from` until the focus is on `target` (a few steps at most)
async function tabTo(p, from, target, max = 4) {
  await from.evaluate((el) => { el.tabIndex = -1; el.focus() })
  for (let i = 0; i < max; i++) {
    await p.keyboard.press('Tab')
    if (await focused(target)) return
  }
  throw new Error('Tab did not reach it')
}
const center = (loc) => loc.evaluate((el) => el.scrollIntoView({ block: 'center' }))
const darkText = async (sheet) => {
  const [fg, bg] = await sheet.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor])
  const lum = (c) => { const [r, g, b2] = c.match(/[\d.]+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b2 }
  expect(lum(fg)).toBeGreaterThan(lum(bg))
}

for (const theme of ['light', 'dark']) {
  test(`F-CM-01 휴대폰 390(${theme === 'light' ? '밝은' : '어두운'}): 답 아래에 알약 없음 · 정보 줄은 그대로 · 처음 한 번 안내 · 길게 누르면 메뉴 → 보내기 · 프로젝트로 시작`, async ({ browser }) => {
    const p = await open(browser, HY, PHONE, { theme })
    await toChat(p, true)
    const row = answerRow(p)
    const bubble = row.locator('.bubble.agent')
    await expect(bubble).toBeVisible({ timeout: 30000 })
    // nothing to press under the answer: the pills are gone, what it did and how stays
    await expect(p.locator('[data-test="answer-actions"], [data-test="answer-share-btn"], [data-test="answer-project-btn"]')).toHaveCount(0)
    await expect(row.locator('[data-testid="plan-fold"]')).toHaveText(/계획 2\/2 · 1분 58초/)
    await expect(row.locator('[data-test="work-trail"]')).toContainText('어떻게 했나요 · 3단계 · 조회한 곳 gana-precision.example')
    // a phone holds: the ⋯ takes no room and no look — but stays for a screen reader (F-CM-04)
    await hiddenButReachable(row, '이 답의 메뉴 열기')
    // once: 「길게 누르면 …」 under the newest message that has a menu
    const hint = p.locator('[data-test="hold-hint"]')
    await expect(hint).toHaveCount(1)
    await expect(hint).toContainText('길게 누르면 공유 · 프로젝트로 시작 · 폴더 정리')
    await hint.scrollIntoViewIfNeeded()
    await inView(hint, p)
    await noSideScroll(p)
    await shot(p, 'share', `f-cm-01-hint-${theme}`)
    await center(bubble)
    await noSideScroll(p)
    await shot(p, 'share', `f-cm-01-answer-${theme}`)
    // a long press on the answer: its menu, from the bottom (the first long press puts the hint away)
    await press(p, bubble)
    const sheet = p.locator('[data-test="answer-share"]')
    await expect(sheet).toHaveAttribute('data-step', 'menu')
    for (const t of ['대화방 · 사람에게 보내기', '문서로 남기기', '프로젝트로 시작', '글 선택', '글 복사']) await expect(sheet.getByRole('menuitem').filter({ hasText: t })).toHaveCount(1)
    await expect(hint).toHaveCount(0)
    const sb = await inView(sheet, p)
    expect(sb.y + sb.height).toBeGreaterThan(844 - 2)
    if (theme === 'dark') await darkText(sheet)
    await shot(p, 'share', `f-cm-01-menu-${theme}`)
    // 대화방 · 사람에게 보내기: the rooms and the teammates, as the 「공유」 button opened before
    await sheet.locator('[data-test="answer-share-room"]').click()
    await expect(sheet).toHaveAttribute('data-step', 'room')
    await expect(sheet.locator('[data-test="answer-person-option"]').filter({ hasText: '김서연' })).toHaveCount(1)
    await noSideScroll(p)
    await sheet.locator('[data-test="answer-share-close"]').click()
    await expect(sheet).toHaveCount(0)
    // 프로젝트로 시작: the confirm card under the chat, as the 「프로젝트로 시작」 button made it — the item says it works until then, a failure
    // stays in the sheet (PR #126 review)
    await center(bubble)
    await press(p, bubble)
    const proj = p.locator('[data-test="answer-share-project"]')
    if (theme === 'light') {
      await p.route('**/project-offer', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '프로젝트 카드를 만들지 못했어요. 다시 눌러 주세요.' }) }))
      await proj.click()
      await expect(p.locator('[data-test="answer-share-error"]')).toHaveText('프로젝트 카드를 만들지 못했어요. 다시 눌러 주세요.')
      await expect(sheet).toHaveAttribute('data-step', 'menu')
      expect(await focused(proj)).toBe(true)
      await p.unroute('**/project-offer')
      let release
      const gate = new Promise((ok) => { release = ok })
      await p.route('**/project-offer', async (r) => { await gate; await r.continue() })
      await proj.click()
      await expect(proj).toContainText('프로젝트 카드를 준비하고 있어요…')
      await expect(proj).toHaveAttribute('aria-busy', 'true')
      await expect(sheet).toHaveAttribute('data-step', 'menu')
      await shot(p, 'share', 'f-cm-01-project-busy-light')
      release()
      await expect(sheet).toHaveCount(0, { timeout: 30000 })
      await p.unroute('**/project-offer')
    } else await proj.click()
    const offer = p.locator('[data-test="project-offer"]').last()
    await expect(offer).toBeVisible({ timeout: 30000 })
    await expect(offer.locator('[data-test="offer-title"]')).toHaveValue('가나정밀 견적 · 계약 정리')
    await offer.scrollIntoViewIfNeeded()
    await noSideScroll(p)
    await shot(p, 'share', `f-cm-01-project-${theme}`)
    // seen once: not on the next visit
    await toChat(p, true)
    await expect(answerRow(p).locator('.bubble.agent')).toBeVisible({ timeout: 30000 })
    await p.waitForTimeout(1000)
    await expect(p.locator('[data-test="hold-hint"]')).toHaveCount(0)
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}

// (dark first: it looks and puts the menu away — light then files the cards)
for (const theme of ['dark', 'light']) {
  test(`F-CM-02 휴대폰 390(${theme === 'light' ? '밝은' : '어두운'}): 파일 카드 아래에 정리 줄 없음 · 제안이 있으면 점 · 길게 누르면 열기 · 공유 · 정리 · 다른 폴더`, async ({ browser }) => {
    test.setTimeout(180_000)
    const p = await open(browser, HY, PHONE, { theme })
    await toChat(p, true)
    const quote = card(p, 'quote')
    await expect(quote).toBeVisible({ timeout: 30000 })
    await center(quote)
    // the judge is asked once the card is on screen: a dot on the card, no line under it
    await expect(quote.locator('[data-test="filing-dot"]')).toBeVisible({ timeout: 30000 })
    await expect(p.locator('.row.k-file [data-test="folder-suggest"], .row.k-file [data-test="filing-say"], .row.k-file [data-test="filing-go"]')).toHaveCount(0)
    await hiddenButReachable(quote, `${FILES.quote.name} 메뉴 열기`)
    await expect(quote.locator('[data-test="filing-dot"]')).toHaveAttribute('aria-label', '폴더 정리 제안이 있어요')
    await noSideScroll(p)
    await shot(p, 'filing', `f-cm-02-cards-${theme}`)
    // a long press on the card: its menu (not the file)
    await press(p, quote.locator('button.file'))
    const menu = p.locator('[data-test="file-menu"]')
    await expect(menu).toBeVisible()
    // (and not the file as well: the finger coming up is no tap — given time to open, nothing opened)
    await p.waitForTimeout(800)
    await expect(p.locator('[data-test="office-sheet"], [data-test="media-viewer"]')).toHaveCount(0)
    // the filing items are a named group of the menu (role="menu" holds menu items alone)
    await expect(menu.getByRole('group', { name: '폴더에 정리' }).getByRole('menuitem')).toHaveCount(2)
    await expect(menu.locator('[data-test="file-menu-open"]')).toBeVisible()
    await expect(menu.locator('[data-test="file-menu-share"]')).toContainText('팀원에게 공유')
    await expect(menu.locator('[data-test="file-menu-file-label"]')).toHaveText('‘견적서’에 정리')
    await expect(menu.locator('[data-test="file-menu-file"]')).toContainText('추천 · 확신도 90%')
    await expect(menu.locator('[data-test="file-menu-other"]')).toContainText('다른 폴더 고르기')
    for (const it of await menu.getByRole('menuitem').all()) await inView(it, p)
    const mb = await inView(menu, p)
    expect(mb.y + mb.height).toBeGreaterThan(844 - 2)
    await noSideScroll(p)
    if (theme === 'dark') await darkText(menu)
    await shot(p, 'filing', `f-cm-02-menu-${theme}`)
    if (theme === 'dark') {
      // 팀원에게 공유: the team's share picker, as the card's 👥 opens it
      await menu.locator('[data-test="file-menu-share"]').click()
      await expect(menu).toHaveCount(0)
      await expect(p.getByRole('dialog', { name: '팀원에게 공유' })).toBeVisible()
      expect(p.errors).toEqual([])
      await p.context().close()
      return
    }
    // 「‘견적서’에 정리」: filed — the line under the card says where, the dot goes
    await menu.locator('[data-test="file-menu-file"]').click()
    await expect(menu).toHaveCount(0)
    await expect(quote.locator('xpath=..').locator('[data-test="filing-done"]')).toHaveText('‘견적서’에 정리했어요')
    await expect(quote.locator('[data-test="filing-dot"]')).toHaveCount(0)
    // (the folder's file list is its index — brought up to date right after the commit, not waited for: lib/folders/filing.js reindex)
    await expect.poll(async () => (await S.api(HY.token, `/folders/${QUOTES.slug}/tree`)).map((f) => f.path)).toContain(FILES.quote.name)
    // the contract fits no folder: 「새 폴더를 만들어 정리: 거래처 계약서」
    const contract = card(p, 'contract')
    await center(contract)
    await expect(contract.locator('[data-test="filing-dot"]')).toBeVisible({ timeout: 30000 })
    await press(p, contract.locator('button.file'))
    await expect(menu.locator('[data-test="file-menu-new-label"]')).toHaveText('새 폴더를 만들어 정리: 거래처 계약서')
    await shot(p, 'filing', `f-cm-02-new-folder-${theme}`)
    await menu.locator('[data-test="file-menu-new"]').click()
    await expect(menu).toHaveCount(0)
    await expect(contract.locator('xpath=..').locator('[data-test="filing-done"]')).toHaveText('‘거래처 계약서’에 정리했어요')
    const [made] = await S.q(`select f.slug, m.role from pro_folders f join pro_folder_members m on m.folder_id=f.id and m.principal_id=$2 where f.tenant_id=$1 and f.name='거래처 계약서'`, [TENANT, HY.id])
    expect(made.role).toBe('owner')
    await expect.poll(async () => (await S.api(HY.token, `/folders/${made.slug}/tree`)).map((f) => f.path)).toContain(FILES.contract.name)
    // the memo: suggested 「견적서」 — 「다른 폴더 고르기」 → 「회의록」
    const memo = card(p, 'memo')
    await center(memo)
    await expect(memo.locator('[data-test="filing-dot"]')).toBeVisible({ timeout: 30000 })
    await press(p, memo.locator('button.file'))
    await menu.locator('[data-test="file-menu-other"]').click()
    await expect(menu).toHaveAttribute('data-step', 'pick')
    const pickMeetings = menu.locator(`[data-test="file-menu-folder"][data-slug="${MEETINGS.slug}"]`)
    await expect(pickMeetings).toContainText('회의록')
    await expect(menu.locator('[data-test="file-menu-new-name"]')).toBeVisible()
    await noSideScroll(p)
    await shot(p, 'filing', `f-cm-02-pick-${theme}`)
    await pickMeetings.click()
    await expect(menu).toHaveCount(0)
    await expect(memo.locator('xpath=..').locator('[data-test="filing-done"]')).toHaveText('‘회의록’에 정리했어요')
    await expect.poll(async () => (await S.api(HY.token, `/folders/${MEETINGS.slug}/tree`)).map((f) => f.path)).toContain(FILES.memo.name)
    // a filed card's menu says where it went
    await center(quote)
    await press(p, quote.locator('button.file'))
    await expect(menu.locator('[data-test="file-menu-filed"]')).toContainText('‘견적서’에 정리했어요')
    await expect(menu.locator('[data-test="file-menu-file"], [data-test="file-menu-other"]')).toHaveCount(0)
    await menu.locator('[data-test="file-menu-close"]').click()
    await center(memo)
    await noSideScroll(p)
    await shot(p, 'filing', `f-cm-02-filed-${theme}`)
    // a tap on the card still opens the file (the office panel), never the menu
    await quote.locator('button.file').tap()
    await expect(p.locator('[data-test="office-sheet"]')).toBeVisible({ timeout: 15000 })
    await expect(menu).toHaveCount(0)
    expect(p.errors).toEqual([])
    await p.context().close()
    // the filed lines in the dark theme too
    const d = await open(browser, HY, PHONE, { theme: 'dark' })
    await toChat(d, true)
    await center(card(d, 'memo'))
    await expect(card(d, 'memo').locator('xpath=..').locator('[data-test="filing-done"]')).toBeVisible({ timeout: 30000 })
    await noSideScroll(d)
    await shot(d, 'filing', 'f-cm-02-filed-dark')
    expect(d.errors).toEqual([])
    await d.context().close()
  })
}

test('F-CM-03 PC 1280: 마우스를 올리면 「⋯」 · 오른쪽 클릭 · 「⋯」 · 키보드로 같은 메뉴, Esc 로 닫히고 초점이 돌아옴 — 답과 파일 카드, 안내 없음', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await open(browser, HY, DESK)
  await p.goto('/chat')
  const row = answerRow(p)
  const bubble = row.locator('.bubble.agent')
  await expect(bubble).toBeVisible({ timeout: 30000 })
  await expect(p.locator('[data-test="answer-actions"], [data-test="answer-share-btn"]')).toHaveCount(0)
  // a computer has no hint (the ⋯ shows instead)
  await expect(p.locator('[data-test="hold-hint"]')).toHaveCount(0)
  const more = row.locator('[data-test="msg-more"]')
  await center(bubble)
  await p.mouse.move(5, 5)
  await expect.poll(() => more.evaluate((el) => getComputedStyle(el).opacity)).toBe('0')
  await bubble.hover()
  await expect.poll(() => more.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  await shot(p, 'share', 'f-cm-03-answer-hover')
  // right-click: the menu (with 「글 선택」 — the answer went along)
  const sheet = p.locator('[data-test="answer-share"]')
  await bubble.click({ button: 'right' })
  await expect(sheet).toHaveAttribute('data-step', 'menu')
  await expect(sheet.locator('[data-test="answer-share-select"]')).toBeVisible()
  await shot(p, 'share', 'f-cm-03-answer-menu')
  await p.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  // the ⋯: the same menu; Esc gives the focus back to it
  await bubble.hover()
  await more.click()
  await expect(sheet).toHaveAttribute('data-step', 'menu')
  await expect(sheet.getByRole('menuitem').filter({ hasText: '프로젝트로 시작' })).toHaveCount(1)
  await p.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  expect(await focused(more)).toBe(true)
  // the keyboard alone: Tab onto the ⋯ (it shows), Enter, the first item has the focus, Esc → back on the ⋯
  await p.mouse.move(5, 5)
  await bubble.evaluate((el) => { el.tabIndex = -1; el.focus() })
  await p.keyboard.press('Tab')
  expect(await focused(more)).toBe(true)
  await expect.poll(() => more.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  await p.keyboard.press('Enter')
  await expect(sheet).toHaveAttribute('data-step', 'menu')
  await expect.poll(() => p.evaluate(() => document.activeElement?.getAttribute('data-test'))).toBe('answer-share-room')
  // ↓ walks the items
  await p.keyboard.press('ArrowDown')
  expect(await p.evaluate(() => [document.activeElement?.getAttribute('role'), document.activeElement?.getAttribute('data-test')])).toEqual(['menuitem', expect.not.stringMatching(/^answer-share-room$/)])
  await p.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  expect(await focused(more)).toBe(true)

  // a file card: the order (its suggestion still waits — a dot)
  const order = card(p, 'order')
  await center(order)
  await expect(order.locator('[data-test="filing-dot"]')).toBeVisible({ timeout: 30000 })
  const fmore = order.locator('[data-test="file-more"]')
  await p.mouse.move(5, 5)
  await expect.poll(() => fmore.evaluate((el) => getComputedStyle(el).opacity)).toBe('0')
  await order.locator('button.file').hover()
  await expect.poll(() => fmore.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  await shot(p, 'filing', 'f-cm-03-card-hover')
  const menu = p.locator('[data-test="file-menu"]')
  // right-click on the card: its menu, not the browser's
  await order.locator('button.file').click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-test="file-menu-file-label"]')).toHaveText('‘견적서’에 정리')
  await expect(menu.getByRole('menu')).toHaveCount(1)
  await shot(p, 'filing', 'f-cm-03-card-menu')
  await p.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // the ⋯ by keyboard: Enter → the first item focused → Esc → back on the ⋯
  await fmore.focus()
  await p.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await expect.poll(() => p.evaluate(() => document.activeElement?.getAttribute('data-test'))).toBe('file-menu-open')
  await p.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  expect(await focused(fmore)).toBe(true)
  // a right-click on a sound's player is the browser's own (its menu — speed · loop · save), not the card's
  const player = p.locator(`[data-test="media-preview"][data-file="${FILES.voice.name}"] audio`)
  await center(player)
  const kept = await player.evaluate((el) => new Promise((ok) => {
    window.addEventListener('contextmenu', (e) => ok(!e.defaultPrevented), { once: true })
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + r.height / 2, button: 2 }))
  }))
  expect(kept, "the browser's own menu on the player").toBe(true)
  await p.waitForTimeout(300)
  await expect(menu).toHaveCount(0)
  // a click on the card still opens the file
  await order.locator('button.file').click()
  await expect(p.locator('[data-test="office-sheet"]')).toBeVisible({ timeout: 15000 })
  await expect(menu).toHaveCount(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-CM-04 휴대폰 390: 「⋯」는 보이지 않아도 화면 낭독기 · 키보드로 닿음(Tab → 보임 → Enter → 메뉴 → Esc 로 돌아옴) · 안내는 온전히 1.5 초 보여야 기억', async ({ browser }) => {
  test.setTimeout(180_000)
  const p = await open(browser, HY, PHONE)
  await toChat(p, true)
  const hint = p.locator('[data-test="hold-hint"]')
  await expect(hint).toHaveCount(1, { timeout: 30000 })
  const seen = () => p.evaluate(() => localStorage.getItem('pgl-hold-hint'))
  // half under the composer: not read — however long it lies there
  // (the chat's own list — the one holding the hint: right after 「채팅」 the Home list is still in the page)
  const under = async () => {
    const comp = await p.locator('[data-test="chat-composer"]').boundingBox()
    const hb = await hint.boundingBox()
    await hint.evaluate((el, d) => { el.closest('.msgs').scrollTop -= d }, comp.y - 12 - hb.y)
  }
  await under()
  await p.waitForTimeout(300)
  await under()
  const hb = await hint.boundingBox()
  const comp = await p.locator('[data-test="chat-composer"]').boundingBox()
  expect(hb.y + hb.height, 'the hint runs under the composer').toBeGreaterThan(comp.y)
  await p.waitForTimeout(2200)
  expect(await seen(), 'half under the composer is not seen').toBeNull()
  // wholly on screen for 1.5 s: seen — never again
  await center(hint)
  await expect.poll(seen, { timeout: 6000 }).toBe('1')
  // the hint's ✕ is a finger's target
  const x = await p.locator('[data-test="hold-hint-close"]').boundingBox()
  expect(Math.min(x.width, x.height)).toBeGreaterThanOrEqual(44)

  // the answer's ⋯: in the accessibility tree, reached with Tab, shown with the focus
  const row = answerRow(p)
  const bubble = row.locator('.bubble.agent')
  await center(bubble)
  const more = await hiddenButReachable(row, '이 답의 메뉴 열기')
  await tabTo(p, bubble, more)
  await expect.poll(async () => (await more.boundingBox()).width).toBeGreaterThanOrEqual(28)
  await noSideScroll(p)
  await shot(p, 'share', 'f-cm-04-phone-keyboard')
  await p.keyboard.press('Enter')
  const sheet = p.locator('[data-test="answer-share"]')
  await expect(sheet).toHaveAttribute('data-step', 'menu')
  await expect.poll(() => p.evaluate(() => document.activeElement?.getAttribute('data-test'))).toBe('answer-share-room')
  // a step that takes the focused item away keeps the focus in the sheet (Esc still closes it — PR #126 review)
  await p.keyboard.press('Enter')
  await expect(sheet).toHaveAttribute('data-step', 'room')
  await expect.poll(() => sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  await p.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  expect(await focused(more)).toBe(true)

  // a file card's ⋯ the same way — and the dot of a waiting suggestion is something it can act on
  const order = card(p, 'order')
  await center(order)
  const fmore = await hiddenButReachable(order, `${FILES.order.name} 메뉴 열기`)
  await tabTo(p, order.locator('button.file'), fmore)
  await expect.poll(async () => (await fmore.boundingBox()).width).toBeGreaterThanOrEqual(28)
  await shot(p, 'filing', 'f-cm-04-phone-keyboard-card')
  await p.keyboard.press('Enter')
  const menu = p.locator('[data-test="file-menu"]')
  await expect(menu).toBeVisible()
  await expect.poll(() => p.evaluate(() => document.activeElement?.getAttribute('data-test'))).toBe('file-menu-open')
  await p.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  expect(await focused(fmore)).toBe(true)
  // a long press on a picture's preview is the card's menu too (not the phone's callout on the picture) — a tap still opens the viewer
  const thumb = p.locator(`[data-test="media-preview"][data-file="${FILES.photo.name}"] [data-test="media-thumb"]`)
  await center(thumb)
  await press(p, thumb)
  await expect(menu).toBeVisible()
  await expect(menu.locator('.sub')).toHaveText(FILES.photo.name)
  await p.waitForTimeout(800)
  await expect(p.locator('[data-test="media-viewer"]')).toHaveCount(0)
  await shot(p, 'filing', 'f-cm-04-phone-picture-menu')
  await menu.locator('[data-test="file-menu-close"]').click()
  await expect(menu).toHaveCount(0)
  await thumb.tap()
  await expect(p.locator('[data-test="media-viewer"]')).toBeVisible()
  // a long press on a sound's player (dragging its seek bar) is the player's — not the card's menu
  await p.keyboard.press('Escape')
  await expect(p.locator('[data-test="media-viewer"]')).toHaveCount(0)
  const player = p.locator(`[data-test="media-preview"][data-file="${FILES.voice.name}"] audio`)
  await center(player)
  await press(p, player)
  await p.waitForTimeout(400)
  await expect(menu).toHaveCount(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})
