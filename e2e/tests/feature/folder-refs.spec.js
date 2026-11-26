// 폴더 참조 P0 — 다른 폴더 · 파일을 가리키는 자리로 폴더를 구성한다 (스펙 openspec/specs/folder-refs, 서버 lib/folders/refs.js).
// 사용자(2026-11-26): 「지금 현재 폴더 개념에서 폴더에서 어떤 다른 폴더를 이렇게 참조하는 방식으로 구성할 수 있어야 될 것 같아. 예를 들어 가지고
// 우리 Git에서 서브 모듈처럼 이렇게 구성을 시켜서 참조만 갖고 있고 원본은 다른 폴더가 원본인 거지. 그렇게 해서 우리가 에이전트한테 일을 줄
// 때에 컨텍스트를 이렇게 자유롭게 구성시킬 수 있게끔」.
// 손그림 그대로: 「제안 준비」에 「폴더1」(영업 자료 전체) · 「폴더2」(규정집의 인사) · 「가격표.xlsx」(영업 자료의 파일 하나)를 참조로 더하고,
// 채팅에 붙여 「세 자료를 보고 제안서 개요를 써 줘」 → 에이전트가 셋을 모두 읽고 답한다. 규정집을 못 보는 동료에게는 「폴더2」가 잠긴 자리다.
//   RF-E-01 ~ 06  HTTP(세 사람: 소유자 · 영업 자료만 읽는 동료 · 원본을 하나도 못 읽는 동료) — 트리 · 파일 · raw · 열기 · 검색 · 도구 · 회사 경계 ·
//                 구성원에서 빠진 직후 · 접근 요청
//   F-RF-01 참조 더하기 시트로 폴더 전체 · 하위 폴더를 더하면 「참조」 자리가 보인다
//   F-RF-02 파일 하나를 더한다
//   F-RF-03 자리의 파일을 열면 「참조된 자료 · 원본 열기」, 편집할 수 없다 · 원본 열기는 원본 폴더의 그 파일로
//   F-RF-04 원본의 구성원이 아닌 동료에게는 잠긴 자리(이름표만)와 「접근 요청」 — 밝은 · 어두운 테마
//   F-RF-05 자리에 올리기는 거절된다
//   F-RF-06 채팅에 붙이면 에이전트가 참조된 파일의 내용으로 답한다 · 못 보는 동료의 에이전트는 그 자리를 읽지 못한다
//   F-RF-07 참조를 빼도 원본은 그대로
//   F-RF-08 390px 자리 줄 · 메뉴 · 더하기 시트 — 밝은 · 어두운 테마
// 자기 스택(lib/localStack.js: 회사 folder-refs-web 의 BFF 8976 + Vite 5376 — 둘 중 하나라도 쓰이고 있으면 멈춘다; RT_RF_API_PORT · RT_RF_WEB_PORT)을
// 띄우고 지운다. 가짜 모델(59976)과 가짜 deepagents(59977)는 이 파일이 띄운다 — 가짜 deepagents 는 채팅 메시지에 든 user_jwt 로 BFF 의 폴더 도구
// (/mcp/folders: folder_files · folder_read)를 실제로 불러 읽은 것을 답에 옮긴다. 실제 모델 · 에이전트는 부르지 않는다. 사람 · 회사 · 자료는 지어낸 것이다.
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/folder-refs.spec.js
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'
import { XLSX } from '../../lib/seed.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/folder-refs/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const TENANT = 'folder-refs-web'
const API_PORT = Number(process.env.RT_RF_API_PORT || 8976)
const WEB_PORT = Number(process.env.RT_RF_WEB_PORT || 5376)
const LLM_PORT = Number(process.env.RT_RF_LLM_PORT || 59976)
const AGENT_PORT = Number(process.env.RT_RF_AGENT_PORT || 59977)
const NOWHERE = 'http://127.0.0.1:9'
const busy = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return true } catch { return false } }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

// ---- the fake model: the front plan, the router (DELEGATE), odds readings (the last option), a title ----
async function answerLlm(b) {
  const all = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const sys = String(b.messages?.[0]?.content || '')
  if (b.logprobs) {
    const options = [...all.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => m[1])
    const pick = options.at(-1) || 'A'
    return { body: { choices: [{ message: { content: pick }, logprobs: { content: [{ token: pick, logprob: Math.log(0.9), top_logprobs: [{ token: pick, logprob: Math.log(0.9) }, { token: options[0] || 'B', logprob: Math.log(0.05) }] }] } }] } }
  }
  if (sys.includes('what you understood and how the work will go')) return { content: JSON.stringify({ understood: '붙인 폴더의 세 자료를 읽고 제안서 개요를 써 드릴게요.', steps: ['참조된 자료 읽기', '개요 쓰기'], tier: 'light', certainty: 'sure' }) }
  if (b.tools) return { content: 'DELEGATE' }
  if (/제목을|A title for/.test(sys)) return { content: '제안서 개요' }
  return { content: b.response_format ? '{}' : 'OK' }
}

// ---- the fake deepagents: reads the attached folder through the real folder tools, with the person's JWT ----
const agent = { bodies: [], reads: [] }
async function mcp(jwt, name, args) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/mcp/folders`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const t = await r.text()
  let j
  try { j = JSON.parse(t) } catch { j = JSON.parse(/^data: (.*)$/m.exec(t)[1]) }
  return (j.result?.content || []).map((c) => c.text).join('\n')
}
const firstLine = (s) => String(s || '').split('\n').map((x) => x.replace(/^#+\s*/, '').trim()).filter(Boolean).slice(0, 3).join(' / ')
async function runAgent(body, res) {
  const say = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`) }
  if (body.conversation_id) res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: body.conversation_id })}\n\n`)
  const msg = String(body.message || '')
  const slug = /folder: '([^']+)'/.exec(msg)?.[1]
  const lines = []
  if (slug) {
    say({ type: 'tool_start', tool: 'folder_files', input: { folder: slug } })
    const listing = JSON.parse(await mcp(body.user_jwt, 'folder_files', { folder: slug }))
    say({ type: 'tool_end', tool: 'folder_files', output: `${listing.files.length} files` })
    for (const f of listing.files.filter((x) => x.ref)) {
      say({ type: 'tool_start', tool: 'folder_read', input: { folder: slug, path: f.path } })
      const out = JSON.parse(await mcp(body.user_jwt, 'folder_read', { folder: slug, path: f.path }))
      agent.reads.push({ user: body.user_uid, path: f.path, out })
      say({ type: 'tool_end', tool: 'folder_read', output: String(out.text || '').slice(0, 80) })
      lines.push(`- **${f.path}** (원본 ${out.referenced?.from || '?'}): ${firstLine(out.text)}`)
    }
    for (const r of (listing.refs || []).filter((x) => x.state === 'locked')) lines.push(`- **${r.name}**: 볼 수 없는 참조라 읽지 못했어요`)
  }
  const answer = `제안서 개요예요. 붙인 폴더의 참조 자료를 읽었어요.\n\n${lines.join('\n')}\n\n1. 회사 소개 2. 가격 조건 3. 일하는 방식`
  say({ type: 'token', content: answer })
  say({ type: 'done', content: answer })
  res.end()
}

let servers = []
const listen = (srv, port) => new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => { servers.push(srv); ok() }))
let S, A, B, C, SALES, RULES, COMP, OTHERF
const MD = {
  price: '# 가격 정책\n\n대량 구매는 10% 할인해요.\n연간 계약은 무료 배송이에요.\n',
  intro: '# 회사 소개\n\n달빛 커피는 원두를 직접 볶아요.\n',
  leave: '# 휴가 규정\n\n연차는 15일이고, 입사 첫해는 월 1일씩 생겨요.\n',
  review: '# 평가 기준\n\n분기마다 동료 평가를 해요.\n',
  secret: '# 보안 규정\n\n고객 자료는 외부로 가져가지 않아요.\n',
  draft: '# 제안서 초안\n\n(개요를 채울 자리)\n',
}
const enc = encodeURIComponent
async function upload(who, slug, p, body) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/folders/${slug}/files?path=${enc(p)}`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/octet-stream' }, body })
  if (!r.ok) throw new Error(`upload ${p}: ${r.status} ${await r.text()}`)
}
// a call that never throws on status: {status, body}
async function call(who, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api${p}`, { method, headers: { Authorization: `Bearer ${who.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  let j = t
  try { j = JSON.parse(t) } catch { /* text */ }
  return { status: r.status, body: j, text: t }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  for (const p of [API_PORT, WEB_PORT, LLM_PORT, AGENT_PORT]) if (busy(p)) throw new Error(`port ${p} is in use — this file runs its own stack there`)
  fs.mkdirSync(SHOTS, { recursive: true })
  await listen(http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      let b = {}
      try { b = JSON.parse(raw) } catch { /* not json */ }
      const r = await answerLlm(b)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.body || { choices: [{ message: { role: 'assistant', content: r.content }, finish_reason: 'stop' }] }))
    })
  }), LLM_PORT)
  await listen(http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (!req.url.startsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url.startsWith('/chat/stop') ? '{"stopped":false}' : '[]') }
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      agent.bodies.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      runAgent(body, res).catch((e) => { console.warn('[fake agent]', e.message); res.end() })
    })
  }), AGENT_PORT)
  S = await startStack({ tenant: TENANT, apiFrom: API_PORT, webFrom: WEB_PORT, env: {
    PRO_LLM_BASE_URL: `http://127.0.0.1:${LLM_PORT}/v1`, PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_LLM_MODEL: 'main-fake', PRO_LLM_FAST_MODEL: 'fast-fake', PRO_LLM_FRONT_MODEL: 'front-fake', PRO_LLM_ODDS_MODEL: 'fast-fake',
    PRO_DEEPAGENTS_URL: `http://127.0.0.1:${AGENT_PORT}`, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_EMBED_URL: '' } })
  if (S.apiPort !== API_PORT || S.webPort !== WEB_PORT) throw new Error(`the stack is not on ${API_PORT} · ${WEB_PORT}`)
  A = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '한서연')   // composes 「제안 준비」, owns the sources
  B = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '오지후')   // reads 영업 자료, not 규정집
  C = await S.person(`pro-rt-${TENANT}-c@uengine.org`, '윤도하')   // reads neither source
  for (const p of [A, B, C]) await S.join(p)
  const mk = async (name, description) => S.api(A.token, '/folders', { method: 'POST', body: { name, description } })
  SALES = await mk('영업 자료', '가격 정책 · 가격표 · 회사 소개')
  RULES = await mk('규정집', '인사 · 보안 규정')
  COMP = await mk('제안 준비', '제안서를 쓸 때 에이전트에게 주는 자료 묶음')
  await upload(A, SALES.slug, '가격 정책.md', MD.price)
  await upload(A, SALES.slug, '안내/회사 소개.md', MD.intro)
  await upload(A, SALES.slug, '가격표.xlsx', await XLSX([['메뉴', '가격'], ['아메리카노', 4500], ['라테', 5200]]))
  await upload(A, RULES.slug, '인사/휴가 규정.md', MD.leave)
  await upload(A, RULES.slug, '인사/평가 기준.md', MD.review)
  await upload(A, RULES.slug, '보안/반출 금지.md', MD.secret)
  await upload(A, COMP.slug, '제안서 초안.md', MD.draft)
  const member = (f, who, role) => S.api(A.token, `/folders/${f.slug}/members`, { method: 'POST', body: { type: 'user', id: who.id, role } })
  await member(COMP, B, 'viewer'); await member(COMP, C, 'viewer'); await member(SALES, B, 'viewer')
})
test.afterAll(async () => {
  for (const s of servers) await new Promise((ok) => s.close(ok))
  servers = []
  if (!S) return
  fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
  fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
  await S.q('delete from pro_folder_ref_events where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
  for (const p of [A, B, C].filter(Boolean)) await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [p.id]).catch(() => {})
  if (OTHERF) await S.q('delete from pro_folders where id=$1', [OTHERF.id]).catch(() => {})
  await S.q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await S.stop()
})

// a page signed in as `who`, in a theme
async function open(browser, who, opts, { theme = 'light' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const calm = (p) => p.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((ok) => setTimeout(ok, 1500))]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(150); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const toFolder = async (p, f) => { await p.goto(`/folders/${f.slug}`); await p.locator('[data-test="folder-detail"] .files').waitFor() }
const slot = (p, name) => p.locator(`[data-test="folder-slot"][data-slot="${name}"]`)
const noSideScroll = async (p) => expect(await p.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(await p.evaluate(() => window.innerWidth) + 1)
// the reference sheet: a folder, then what in it, then the slot's name
async function addRef(p, src, { dir = null, file = null, name, shots = null }) {
  await p.locator('[data-test="folder-add-menu"]').click()
  await p.locator('[data-test="folder-add-ref"]').click()
  const sheet = p.locator('[data-test="ref-sheet"]')
  await sheet.locator(`[data-test="ref-source"][data-slug="${src.slug}"]`).waitFor()
  if (shots) await shot(p, `${shots}-1`)
  await sheet.locator(`[data-test="ref-source"][data-slug="${src.slug}"]`).click()
  if (dir) await sheet.locator(`[data-test="ref-dir"][data-path="${dir}"]`).click()
  if (file) { await sheet.locator(`[data-test="ref-file"][data-path="${file}"]`).click() } else await sheet.locator('[data-test="ref-whole"]').waitFor()
  if (shots) await shot(p, `${shots}-2`)
  await sheet.locator('[data-test="ref-next"]').click()
  await sheet.locator('[data-test="ref-name"]').fill(name)
  if (shots) await shot(p, `${shots}-3`)
  await sheet.locator('[data-test="ref-add"]').click()
  await expect(sheet).toHaveCount(0)
}

// ---------- the sketch, made on the screen ----------
test('F-RF-01 참조 더하기 시트로 폴더 전체 · 하위 폴더를 더하면 「참조」 자리가 보인다', async ({ browser }) => {
  const p = await open(browser, A, DESK)
  await toFolder(p, COMP)
  await addRef(p, SALES, { name: '폴더1', shots: 'f-rf-01-sheet' })
  await expect(slot(p, '폴더1')).toBeVisible()
  await expect(slot(p, '폴더1').locator('[data-test="slot-pill"]')).toHaveText('참조')
  await expect(slot(p, '폴더1')).toContainText('영업 자료 · main 따라감')
  await expect(p.locator('[data-test="folder-file"][data-file="폴더1/가격 정책.md"]')).toBeVisible()
  // a sub-folder of 규정집
  await addRef(p, RULES, { dir: '인사', name: '폴더2' })
  await expect(slot(p, '폴더2')).toContainText('규정집 / 인사 · main 따라감')
  await expect(p.locator('[data-test="folder-file"][data-file="폴더2/휴가 규정.md"]')).toBeVisible()
  await expect(p.locator('[data-test="folder-file"][data-file^="폴더2/반출"]')).toHaveCount(0)
  // nothing went into the folder's own files (its repository has no submodule or link of them)
  const own = (await call(A, 'GET', `/folders/${COMP.slug}/tree?ref=main`)).body.filter((f) => !f.ref).map((f) => f.path)
  expect(own).toEqual(['제안서 초안.md'])
  expect(p.errors).toEqual([])
})

test('F-RF-02 파일 하나를 참조로 더한다 — 손그림의 세 자리', async ({ browser }) => {
  const p = await open(browser, A, DESK)
  await toFolder(p, COMP)
  await addRef(p, SALES, { file: '가격표.xlsx', name: '가격표' })
  const s = slot(p, '가격표.xlsx')
  await expect(s).toBeVisible()
  await expect(s.locator('[data-test="slot-pill"]')).toHaveText('참조')
  await expect(s).toContainText('영업 자료 / 가격표.xlsx')
  await shot(p, 'f-rf-02-three-slots-light')
  const refs = (await call(A, 'GET', `/folders/${COMP.slug}/refs`)).body
  expect(refs.map((r) => [r.slot, r.type, r.state, r.track]).sort()).toEqual([['가격표.xlsx', 'file', 'ok', 'main'], ['폴더1', 'folder', 'ok', 'main'], ['폴더2', 'dir', 'ok', 'main']])
  const dark = await open(browser, A, DESK, { theme: 'dark' })
  await toFolder(dark, COMP)
  await expect(slot(dark, '폴더2')).toBeVisible()
  await shot(dark, 'f-rf-02-three-slots-dark')
})

// ---------- HTTP: three readers of the same folder ----------
test('RF-E-01 트리 · 파일 · raw · 열기: 원본을 읽는 사람만 내용, 못 읽으면 잠긴 자리(원본 정보 없음)', async () => {
  const names = (rows) => rows.map((f) => f.path).sort()
  const tA = names((await call(A, 'GET', `/folders/${COMP.slug}/tree?ref=main`)).body)
  expect(tA).toEqual(expect.arrayContaining(['폴더1/가격 정책.md', '폴더1/안내/회사 소개.md', '폴더2/휴가 규정.md', '폴더2/평가 기준.md', '가격표.xlsx', '제안서 초안.md']))
  const tB = names((await call(B, 'GET', `/folders/${COMP.slug}/tree?ref=main`)).body)
  expect(tB).toContain('폴더1/가격 정책.md')
  expect(tB.some((x) => x.startsWith('폴더2/'))).toBe(false)
  const tC = names((await call(C, 'GET', `/folders/${COMP.slug}/tree?ref=main`)).body)
  expect(tC).toEqual(['제안서 초안.md'])
  // raw: the original's bytes for a reader of it; 403 ref_locked otherwise, with nothing of it
  expect((await call(A, 'GET', `/folders/${COMP.slug}/raw?path=${enc('폴더2/휴가 규정.md')}`)).text).toBe(MD.leave)
  expect((await call(B, 'GET', `/folders/${COMP.slug}/raw?path=${enc('폴더1/가격 정책.md')}`)).text).toBe(MD.price)
  for (const [who, p] of [[B, '폴더2/휴가 규정.md'], [C, '폴더1/가격 정책.md'], [C, '가격표.xlsx']]) {
    for (const r of [await call(who, 'GET', `/folders/${COMP.slug}/raw?path=${enc(p)}`), await call(who, 'GET', `/folders/${COMP.slug}/file?path=${enc(p)}`), await call(who, 'POST', `/folders/${COMP.slug}/publish`, { path: p })]) {
      expect(r.status, `${p} ${r.text}`).toBe(403)
      expect(r.body.code).toBe('ref_locked')
      expect(r.text).not.toContain('연차'); expect(r.text).not.toContain(RULES.slug); expect(r.text).not.toContain(SALES.slug)
    }
  }
  // the preview's row names the original (for a reader of it); opening gives the original's copy, never editable here
  const row = (await call(A, 'GET', `/folders/${COMP.slug}/file?path=${enc('폴더1/가격 정책.md')}`)).body
  expect(row.ref.from).toEqual({ slug: SALES.slug, name: '영업 자료', path: '가격 정책.md' })
  const pub = (await call(A, 'POST', `/folders/${COMP.slug}/publish`, { path: '가격표.xlsx' })).body
  expect(pub.editable).toBe(false)
  expect(pub.origin).toEqual({ slug: SALES.slug, name: '영업 자료', path: '가격표.xlsx' })
  // the slots as each sees them: a locked one carries its label, state, who added it and whether they asked — nothing of the original
  const lB = (await call(B, 'GET', `/folders/${COMP.slug}/refs`)).body
  const two = lB.find((r) => r.slot === '폴더2')
  expect(Object.keys(two).sort()).toEqual(['by', 'id', 'label', 'requested', 'slot', 'state'])
  expect(two.state).toBe('locked')
  const lC = (await call(C, 'GET', `/folders/${COMP.slug}/refs`)).text
  for (const x of [SALES.slug, RULES.slug, '영업 자료', '규정집', '인사', SALES.id, RULES.id]) expect(lC).not.toContain(x)
})

test('RF-E-02 검색 · 폴더 도구: 참조된 내용은 구성하는 폴더의 색인에 없고, 못 읽는 사람의 도구에는 이름만', async () => {
  // search finds a file under its own folder, for its members only
  const sB = (await call(B, 'GET', `/folders/search?q=${enc('가격')}`)).body
  expect(sB.some((h) => h.type === 'file' && h.folder.slug === SALES.slug)).toBe(true)
  expect(sB.some((h) => h.folder?.slug === COMP.slug && h.type === 'file' && h.file.path.startsWith('폴더1'))).toBe(false)
  expect((await call(B, 'GET', `/folders/search?q=${enc('휴가')}`)).body).toEqual([])
  expect((await call(C, 'GET', `/folders/search?q=${enc('가격 휴가')}`)).body.filter((h) => h.type === 'file')).toEqual([])
  // the tools with each person's JWT
  const files = async (who) => JSON.parse(await mcp(who.token, 'folder_files', { folder: COMP.slug }))
  const fA = await files(A), fB = await files(B), fC = await files(C)
  expect(fA.files.map((f) => f.path)).toEqual(expect.arrayContaining(['폴더1/가격 정책.md', '폴더2/휴가 규정.md', '가격표.xlsx']))
  expect(fB.files.some((f) => f.path.startsWith('폴더2/'))).toBe(false)
  expect(fB.refs.find((r) => r.slot === '폴더2')).toEqual({ name: '폴더2', slot: '폴더2', state: 'locked' })
  expect(fC.files.map((f) => f.path)).toEqual(['제안서 초안.md'])
  expect(JSON.stringify(fC)).not.toContain('영업 자료')
  const rB = JSON.parse(await mcp(B.token, 'folder_read', { folder: COMP.slug, path: '폴더2/휴가 규정.md' }))
  expect(rB.locked).toBe(true); expect(rB.text).toBeUndefined()
  const rA = JSON.parse(await mcp(A.token, 'folder_read', { folder: COMP.slug, path: '가격표.xlsx' }))
  expect(rA.text).toContain('아메리카노'); expect(rA.referenced).toEqual({ slot: '가격표.xlsx', from: '영업 자료', path: '가격표.xlsx', readOnly: true })
  const cat = JSON.parse(await mcp(C.token, 'folder_catalog', {}))
  const mine = (Array.isArray(cat) ? cat : cat.folders).find((f) => f.slug === COMP.slug)
  expect(mine.refs.every((r) => r.state === 'locked' && !r.from)).toBe(true)
  // folder_open of a slot's file: the original's card (a reader of it), nothing for a locked one
  const oA = JSON.parse(await mcp(A.token, 'folder_open', { folder: COMP.slug, path: '폴더1/가격 정책.md' }))
  expect(oA.folder_ref?.slug || oA.url).toBeTruthy()
  const oB = JSON.parse(await mcp(B.token, 'folder_open', { folder: COMP.slug, path: '폴더2/휴가 규정.md' }))
  expect(oB.locked).toBe(true); expect(oB.url).toBeUndefined()
})

test('RF-E-03 회사 경계: 다른 회사의 폴더는 id 로도 더할 수 없고(서비스), DB 도 그 행을 거절한다(트리거)', async () => {
  const dir = path.join(S.root, 'folders', 'folder-refs-elsewhere', 'their')
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  fs.writeFileSync(path.join(dir, '남의 자료.md'), '# 다른 회사\n')
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.test', 'add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.test', 'commit', '-qm', 'x'], { cwd: dir })
  ;[OTHERF] = await S.q(`insert into pro_folders (tenant_id, slug, name, kind, repo_path) values ('folder-refs-elsewhere',$1,'다른 회사 자료','managed',$2) returning *`, [`their-${Date.now().toString(36)}`, dir])
  await S.q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,'owner')`, [OTHERF.id, A.id])
  for (const source of [OTHERF.id, OTHERF.slug]) {
    const r = await call(A, 'POST', `/folders/${COMP.slug}/refs`, { source, slot: '남의' })
    expect(r.status, r.text).toBe(404)
  }
  let refused = null
  await S.q(`insert into pro_folder_refs (tenant_id, folder_id, slot, label, source_folder_id, source_type) values ($1,$2,'남의','남의',$3,'folder')`, [TENANT, COMP.id, OTHERF.id]).catch((e) => { refused = e.code })
  expect(refused).toBe('23514')
  expect((await call(A, 'GET', `/folders/${COMP.slug}/refs`)).body.some((r) => r.slot === '남의')).toBe(false)
})

test('RF-E-04 원본 구성원에서 빠지면 다음 요청부터 잠긴 자리, 다시 넣으면 열린다', async () => {
  const p = `/folders/${COMP.slug}/raw?path=${enc('폴더1/가격 정책.md')}`
  expect((await call(B, 'GET', p)).status).toBe(200)
  expect((await call(A, 'DELETE', `/folders/${SALES.slug}/members/user/${B.id}`)).status).toBe(200)
  const r = await call(B, 'GET', p)
  expect(r.status).toBe(403); expect(r.body.code).toBe('ref_locked')
  expect((await call(B, 'GET', `/folders/${COMP.slug}/refs`)).body.find((x) => x.slot === '폴더1').state).toBe('locked')
  await S.api(A.token, `/folders/${SALES.slug}/members`, { method: 'POST', body: { type: 'user', id: B.id, role: 'viewer' } })
  expect((await call(B, 'GET', p)).status).toBe(200)
})

// ---------- opening, locked, writing ----------
test('F-RF-03 자리의 파일을 열면 「참조된 자료 · 원본 열기」, 편집 단추 없이 원본의 내용 · 원본 열기는 원본 폴더의 그 파일로', async ({ browser }) => {
  const p = await open(browser, A, DESK)
  await toFolder(p, COMP)
  await p.locator('[data-test="folder-file"][data-file="폴더1/가격 정책.md"] .fn').click()
  const band = p.locator('[data-test="ref-band"]')
  await expect(band).toBeVisible()
  await expect(band).toContainText('참조된 자료')
  await expect(band).toContainText('원본: 영업 자료/가격 정책.md')
  await expect(p.locator('.sheet.glass')).toContainText('대량 구매는 10% 할인해요')
  await shot(p, 'f-rf-03-preview-light')
  await p.locator('[data-test="ref-open-source"]').click()
  await expect(p).toHaveURL(new RegExp(`/folders/${SALES.slug}\\?file=`))
  await expect(p.locator('.sheet.glass .ttl small')).toContainText('영업 자료')
  await expect(p.locator('[data-test="ref-band"]')).toHaveCount(0)
  await shot(p, 'f-rf-03-original-light')
  // a slot's menu: 원본 열기 · 이름 바꾸기 · 참조 빼기
  await toFolder(p, COMP)
  await slot(p, '폴더2').locator('[data-test="slot-more"]').click()
  await expect(p.locator('[data-test="slot-menu"]')).toContainText('원본 열기')
  await expect(p.locator('[data-test="slot-menu"]')).toContainText('참조 빼기')
  await shot(p, 'f-rf-03-menu-light')
  expect(p.errors).toEqual([])
})

test('F-RF-04 원본의 구성원이 아닌 동료: 잠긴 자리(이름표만)와 「접근 요청」 — 요청은 원본 주인에게 알림으로', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const p = await open(browser, B, DESK, { theme })
    await toFolder(p, COMP)
    const two = slot(p, '폴더2')
    await expect(two).toHaveAttribute('data-state', 'locked')
    await expect(two).toContainText('볼 수 없는 자료')
    await expect(slot(p, '폴더1')).toHaveAttribute('data-state', 'ok')
    const html = await p.content()
    for (const x of ['규정집', RULES.slug, '휴가 규정', '평가 기준', '인사 · 보안']) expect(html, x).not.toContain(x)
    if (theme === 'light') {
      await expect(two.locator('[data-test="slot-request"]')).toBeVisible()
      await shot(p, 'f-rf-04-locked-light')
      await two.locator('[data-test="slot-request"]').click()
      await expect(two.locator('[data-test="slot-requested"]')).toHaveText('요청했어요')
    } else {
      await expect(two.locator('[data-test="slot-requested"]')).toBeVisible()
      await shot(p, 'f-rf-04-locked-dark')
    }
    expect(p.errors).toEqual([])
  }
  // the original's owner was told (the folder access notice — it opens the original's 공유 sheet with that person picked)
  const [n] = await S.q(`select title, url from notifications where tenant_id=$1 and user_id=$2 and type='folder_access'`, [TENANT, A.id])
  expect(n.url).toBe(`/folders/${RULES.slug}?share=${B.id}`)
  expect(n.title).toContain('오지후')
  // and nobody told the person who asked anything about the original
  expect((await S.q(`select 1 from notifications where tenant_id=$1 and user_id=$2 and type='folder_access'`, [TENANT, B.id])).length).toBe(0)
  // the owner's screen: the original's share sheet with 오지후 picked
  const o = await open(browser, A, DESK)
  await o.goto(n.url)
  await expect(o.locator('.box.glass')).toContainText('공유 — 규정집')
})

test('F-RF-05 자리에 올리기는 거절된다 — 같은 이름의 파일 · 자리 아래 경로 · 지우기', async ({ browser }) => {
  const p = await open(browser, A, DESK)
  await toFolder(p, COMP)
  await p.locator('input[type=file]').setInputFiles({ name: '가격표.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK 덮어쓰려는 표') })
  await expect(p.locator('.toast')).toContainText('참조된 자료예요. 원본 폴더에서 고쳐 주세요.')
  await shot(p, 'f-rf-05-refused-light')
  for (const [method, q] of [['POST', `/folders/${COMP.slug}/files?path=${enc('폴더1/새 파일.md')}`], ['DELETE', `/folders/${COMP.slug}/files?path=${enc('폴더2/휴가 규정.md')}`]]) {
    const r = await call(A, method, q, method === 'POST' ? { x: 1 } : null)
    expect(r.status, r.text).toBe(409)
  }
  const ws = await call(A, 'PUT', `/workroom/folder/${COMP.slug}/file`, { path: '폴더1/메모.md', content: 'x' })
  expect(ws.status, ws.text).toBe(409)
  // the folder and the original are as they were
  expect((await call(A, 'GET', `/folders/${COMP.slug}/tree?ref=main`)).body.filter((f) => !f.ref).map((f) => f.path)).toEqual(['제안서 초안.md'])
  expect((await call(A, 'GET', `/folders/${SALES.slug}/raw?path=${enc('가격표.xlsx')}`)).text).not.toContain('덮어쓰려는')
})

// ---------- the agent reads through the slots ----------
async function chatTurn(browser, who, text, name) {
  const [main] = await S.api(who.token, '/threads')
  await S.q('delete from pro_messages where thread_id=$1', [main.id])
  await S.q('update pro_threads set conversation_id=null, status=null where id=$1', [main.id])
  await S.api(who.token, `/threads/${main.id}/folder`, { method: 'POST', body: { folder: COMP.slug } })
  const p = await open(browser, who, DESK)
  await p.goto('/chat')
  const ta = p.locator('[data-test="chat-composer"] textarea').last()
  await ta.waitFor()
  await ta.fill(text)
  await ta.press('Enter')
  const [done] = await (async () => { for (let i = 0; i < 90; i++) { const r = await S.q(`select content from pro_messages where thread_id=$1 and role='agent' and kind='text' order by created_at desc limit 1`, [main.id]); if (r.length && r[0].content?.text?.includes('제안서 개요예요')) return r; await sleep(1000) } return [] })()
  expect(done, 'the agent answered').toBeTruthy()
  await expect(p.locator('.row.r-agent.k-text').last()).toContainText('제안서 개요예요', { timeout: 20_000 })
  await shot(p, name)
  return { p, answer: done.content.text, body: agent.bodies.filter((b) => b.user_uid === who.id).at(-1) }
}
test('F-RF-06 채팅에 붙이면 에이전트가 참조된 세 자료를 읽고 답한다 · 규정집을 못 보는 동료의 에이전트는 그 자리를 읽지 못한다', async ({ browser }) => {
  test.setTimeout(180_000)
  const a = await chatTurn(browser, A, '세 자료를 보고 제안서 개요를 써 줘', 'f-rf-06-agent-reads-light')
  // what the agent was told: the folder, its slots and where they point
  expect(a.body.message).toContain(`folder: '${COMP.slug}'`)
  for (const x of ['폴더1/ — 원본: 「영업 자료」 폴더 전체', '폴더2/ — 원본: 「규정집」 폴더의 하위 폴더', '가격표.xlsx — 원본: 「영업 자료」 폴더의 파일', '참조된 자료는 읽기만 해요']) expect(a.body.message).toContain(x)
  // what it read, through the slots, and answered from
  for (const x of ['대량 구매는 10% 할인해요', '연차는 15일', '아메리카노', '달빛 커피']) expect(a.answer).toContain(x)
  expect(agent.reads.filter((r) => r.user === A.id).map((r) => r.path)).toEqual(expect.arrayContaining(['폴더1/가격 정책.md', '폴더2/휴가 규정.md', '가격표.xlsx']))
  expect(a.p.errors).toEqual([])
  // 오지후: 영업 자료 yes, 규정집 no — the same folder, the same request
  const b = await chatTurn(browser, B, '세 자료를 보고 제안서 개요를 써 줘', 'f-rf-06-agent-locked-light')
  expect(b.body.message).toContain('폴더2 — 이 사용자가 볼 수 없는 참조예요(내용 없음)')
  expect(b.body.message).not.toContain('규정집')
  expect(b.answer).toContain('대량 구매는 10% 할인해요')
  expect(b.answer).toContain('폴더2**: 볼 수 없는 참조라 읽지 못했어요')
  expect(b.answer).not.toContain('연차는 15일')
  expect(agent.reads.filter((r) => r.user === B.id).some((r) => r.path.startsWith('폴더2/'))).toBe(false)
})

test('F-RF-07 참조를 빼도 원본은 그대로', async ({ browser }) => {
  const p = await open(browser, A, DESK)
  await toFolder(p, COMP)
  // a slot added to be removed: 영업 자료's 안내 as 「소개」
  await addRef(p, SALES, { dir: '안내', name: '소개' })
  await expect(slot(p, '소개')).toBeVisible()
  p.once('dialog', (d) => d.accept())
  await slot(p, '소개').locator('[data-test="slot-more"]').click()
  await p.locator('[data-test="slot-remove"]').click()
  await expect(slot(p, '소개')).toHaveCount(0)
  await expect(p.locator('.toast')).toContainText('원본은 그대로예요')
  await shot(p, 'f-rf-07-removed-light')
  expect((await call(A, 'GET', `/folders/${SALES.slug}/raw?path=${enc('안내/회사 소개.md')}`)).text).toBe(MD.intro)
  expect((await call(A, 'GET', `/folders/${SALES.slug}/tree?ref=main`)).body.map((f) => f.path)).toEqual(expect.arrayContaining(['가격 정책.md', '가격표.xlsx', '안내/회사 소개.md']))
  expect(p.errors).toEqual([])
})

test('F-RF-08 390px: 자리 줄은 두 줄(이름 + ↗, 「참조 · 원본」), ⋯ 는 아래 시트, 더하기 시트는 전체 높이 — 밝은 · 어두운 테마, 옆으로 넘치지 않음', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const p = await open(browser, A, PHONE, { theme })
    await toFolder(p, COMP)
    const one = slot(p, '폴더1')
    await expect(one).toBeVisible()
    await expect(one.locator('.sm-meta')).toBeVisible()
    await expect(one.locator('.sm-meta')).toContainText('참조 · 영업 자료')
    await expect(one.locator('[data-test="slot-pill"]')).toBeHidden()
    await noSideScroll(p)
    await shot(p, `f-rf-08-folder-390-${theme}`)
    await one.locator('[data-test="slot-more"]').click()
    const menu = p.locator('[data-test="slot-menu"]')
    await expect(menu).toBeVisible()
    const box = await menu.boundingBox()
    expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(843)
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(388)
    await shot(p, `f-rf-08-menu-390-${theme}`)
    await p.mouse.click(195, 60)
    await expect(menu).toHaveCount(0)
    // the sheet: one step a screen, full height
    await p.locator('[data-test="folder-add-menu"]').click()
    await p.locator('[data-test="folder-add-ref"]').click()
    const sheet = p.locator('[data-test="ref-sheet"] .box')
    await expect(sheet).toBeVisible()
    const sb = await sheet.boundingBox()
    expect(sb.height).toBeGreaterThan(780)
    await shot(p, `f-rf-08-sheet-390-${theme}`)
    await p.locator(`[data-test="ref-source"][data-slug="${RULES.slug}"]`).click()
    await expect(p.locator('[data-test="ref-back"]')).toBeVisible()
    await shot(p, `f-rf-08-sheet2-390-${theme}`)
    await noSideScroll(p)
    expect(p.errors).toEqual([])
  }
  // the locked slot on a phone (오지후)
  const b = await open(browser, B, PHONE, { theme: 'dark' })
  await toFolder(b, COMP)
  await expect(slot(b, '폴더2')).toHaveAttribute('data-state', 'locked')
  await expect(slot(b, '폴더2').locator('.sm-meta')).toContainText('볼 수 없는 자료')
  await noSideScroll(b)
  await shot(b, 'f-rf-08-locked-390-dark')
})
