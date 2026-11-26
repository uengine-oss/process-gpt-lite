// 템플릿 폴더 v0 — 템플릿에서 프로젝트를 시작하면 그 프로젝트만의 작업 공간(템플릿의 변형)이 생기고, 결과물은 거기에만, 템플릿의 개선은 고른
// 파일만 「원본에 반영 요청」으로 (스펙 openspec/specs/template-folders, 서버 lib/folders/templates.js).
// 사용자(2026-11-27): 「템플릿 폴더가 선택되어 시작되면 해당 프로젝트에 템플릿 폴더가 참조로 연결된 이 프로젝트 전용 폴더가 생기고 결과물은 전용
// 폴더내에만 남게 될 것임. 작업 도중 원본 폴더 자체에 뭔가의 개선이필요한 내용은 PR 처럼 요청될 수 있겠지」 · 「프로젝트 폴더는 별도로 관리될 수
// 있도록 "폴더" 목록에 나와서는 안되고 해당 프로젝트에서만 보이게」.
//   F-TF-01 정하윤이 폴더 화면에서 「템플릿으로 지정」 → 「템플릿」 표시 · TEMPLATE.md 의 설명 · 폴더 목록의 「템플릿」
//   F-TF-02 김서연이 템플릿에서 「템플릿으로 시작」 → 프로젝트의 작업 공간 막대 · 템플릿의 변형 목록과 폴더 목록에는 없음
//   F-TF-03 프로젝트 턴: 에이전트가 참조 자리를 읽고 결과물을 산출물/ 에, 양식도 고침 → 작업 공간에만, 템플릿 main 그대로
//   F-TF-04 「원본에 반영 요청」 시트: 템플릿 파일만 고르고 결과물은 「보내지 않아요」 → 정하윤의 알림 → 그 변형에는 양식만 → 반영
//   F-TF-05 박도윤이 「새 프로젝트」에서 같은 템플릿을 고름(「템플릿으로 시작」) → 고친 main 에서 시작 · 김서연의 작업 공간은 없음(404)
//   F-TF-06 390px 휴대폰 — 작업 공간 막대 · 반영 요청 시트(밝은 · 어두운 테마)
//   F-TF-07 HTTP 로 돌아가는 길이 없음 — 새 변형의 기준(작업 공간 id · 가지 이름 · git 표현) · 판(sha)으로 raw · publish · 반영 요청이 보여 주는 것 ·
//           템플릿 지정 권한(PATCH) · 보기 권한자의 「템플릿으로 시작」
// 자기 스택(lib/localStack.js: 회사 template-folders-web 의 BFF 8981 + Vite 5381 — 쓰이고 있으면 멈춘다; RT_TF_API_PORT · RT_TF_WEB_PORT)을 띄우고
// 지운다. 가짜 모델과 가짜 deepagents 는 이 파일이 59981 한 곳에 띄운다 — 가짜 deepagents 는 메시지의 user_jwt 로 BFF 의 폴더 도구(/mcp/folders)를
// 실제로 불러 템플릿과 참조 자리를 읽고, 작업 폴더(이 컴퓨터의 deepagents 작업 공간)에 쓰고 저장소의 방에 올린다(lib/roomStore.js 와 같은 열쇠).
// 사람 · 회사 · 자료는 지어낸 것이다.
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/template-folders.spec.js
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

test.describe.configure({ mode: 'serial' })
const SHOTS = path.join(REPO, 'openspec/specs/template-folders/e2e/results')
const DESK = { viewport: { width: 1280, height: 860 }, locale: 'ko-KR' }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR' }
const TENANT = 'template-folders-web'
const API_PORT = Number(process.env.RT_TF_API_PORT || 8981)
const WEB_PORT = Number(process.env.RT_TF_WEB_PORT || 5381)
const FAKE_PORT = Number(process.env.RT_TF_FAKE_PORT || 59981)
const NOWHERE = 'http://127.0.0.1:9'
const busy = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return true } catch { return false } }
const { PGPT_ROOT } = await import(path.join(REPO, 'server/lib/paths.js'))
const WORKSPACE = path.join(PGPT_ROOT, 'services/deepagents/workspace', TENANT)
const OLD = '예시시 가람구 옛길로 5'
const NEW = '예시시 나래구 새길로 7, 3층'
const MD = {
  intro: '# 회사 개요\n\n- 우리 회사는 설비 보전 시스템을 만들어요. 제조 고객사 42곳이 써요.\n',
  record: '# 2026 납품 실적\n\n- 마바기계 — 설비 보전 시스템, 설비 120대 연결\n',
  form: `# 제안서 양식\n\n- 제안사: 우리 회사\n- 주소: ${OLD}\n\n## 1. 회사 소개\n## 2. 비슷한 납품 실적\n## 3. 제안 범위와 일정\n`,
  skill: '---\nname: proposal-writer\ndescription: 제안서 양식과 참조 자료로 제안서 초안을 써요\n---\n1. 참조에서 사실만 가져와요.\n',
  template: '---\ndescription: 제안서를 쓸 때 시작하는 템플릿이에요\noutputs: 산출물/\n---\n# 제안서 템플릿\n',
}
const DRAFT = '산출물/가나정밀 3분기 제안서 초안.md'

// ---- the fake model: the front plan, the router (DELEGATE), odds (the last option), a title ----
function answerLlm(b) {
  const all = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  const sys = String(b.messages?.[0]?.content || '')
  if (b.logprobs) {
    const options = [...all.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => m[1])
    const pick = options.at(-1) || 'A'
    return { choices: [{ message: { content: pick }, logprobs: { content: [{ token: pick, logprob: Math.log(0.9), top_logprobs: [{ token: pick, logprob: Math.log(0.9) }, { token: options[0] || 'B', logprob: Math.log(0.05) }] }] } }] }
  }
  let content = b.response_format ? '{}' : 'OK'
  if (sys.includes('what you understood and how the work will go')) content = JSON.stringify({ understood: '템플릿의 자료를 읽고 작업 공간에 쓸게요.', steps: ['자료 읽기', '작업 공간에 쓰기'], tier: 'light', certainty: 'sure' })
  else if (b.tools) content = 'DELEGATE'
  else if (/제목을|A title for/.test(sys)) content = '다라테크 4분기 제안'
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }
}

// ---- the fake deepagents: reads the template through the real folder tools, writes in the project's working folder ----
const agent = { bodies: [], reads: [] }
async function mcp(jwt, name, args) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/mcp/folders`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const t = await r.text()
  let j
  try { j = JSON.parse(t) } catch { j = JSON.parse(/^data: (.*)$/m.exec(t)[1]) }
  return (j.result?.content || []).map((c) => c.text).join('\n')
}
// the room in storage, as deepagents leaves it after a turn (lib/roomStore.js keys): the pull after the turn finds it at once
const SAFE = /^[A-Za-z0-9_/!\-.*'() &$@=;:+,?]*$/
const seg = (s) => (SAFE.test(s) && !s.startsWith('__u8__') ? s : `__u8__${Buffer.from(s, 'utf8').toString('base64url')}`)
const seedKey = (rel) => (rel.includes('/') ? `__u8__${Buffer.from(rel, 'utf8').toString('base64url')}` : seg(rel))
const walk = (root, sub = '') => fs.readdirSync(path.join(root, sub), { withFileTypes: true }).flatMap((e) => (e.name === '.git' ? [] : e.isDirectory() ? walk(root, sub ? `${sub}/${e.name}` : e.name) : [sub ? `${sub}/${e.name}` : e.name]))
let admin
async function uploadRoom(container, local) {
  admin ||= (await import(path.join(REPO, 'server/lib/supa.js'))).admin
  const m = /^\/workspace\/\.bpmn\/([^/]+)\/(.*)$/.exec(container)
  const prefix = `skills/${TENANT}/${m[1]}/${m[2].split('/').map(seg).join('/')}`
  for (const rel of walk(local)) await admin.storage.from('files').upload(`${prefix}/${seedKey(rel)}`, fs.readFileSync(path.join(local, rel)), { upsert: true, contentType: 'application/octet-stream' })
}
async function runAgent(body, res) {
  const say = (o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`) }
  const conv = body.conversation_id || `tf-${Date.now().toString(36)}`
  res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: conv })}\n\n`)
  const msg = String(body.message || '')
  const container = /(\/workspace\/\.bpmn\/[^\s'"]+\/folders\/[^\s'")]+)/.exec(msg)?.[1]
  const local = container && path.join(WORKSPACE, container.slice('/workspace/'.length))
  const slug = container?.split('/').pop()
  let answer = '알겠어요.'
  if (local && /초안/.test(msg.split('\n')[0])) {
    const listing = JSON.parse(await mcp(body.user_jwt, 'folder_files', { folder: slug }))
    const facts = []
    for (const f of listing.files.filter((x) => x.ref)) {
      const out = JSON.parse(await mcp(body.user_jwt, 'folder_read', { folder: slug, path: f.path }))
      agent.reads.push({ user: body.user_uid, path: f.path, from: out.referenced?.from })
      facts.push(`- ${String(out.text || '').split('\n').find((l) => l.startsWith('- '))?.slice(2)} (${f.path})`)
    }
    const form = fs.readFileSync(path.join(local, '제안서 양식.md'), 'utf8')
    fs.mkdirSync(path.join(local, '산출물'), { recursive: true })
    fs.writeFileSync(path.join(local, DRAFT), `# 가나정밀 3분기 제안서 (초안)\n\n${form.split('\n').filter((l) => l.startsWith('- ')).join('\n')}\n\n${facts.join('\n')}\n`)
    answer = `제안서 초안을 「${DRAFT}」에 썼어요. 참조 자리 ${facts.length}개 파일을 읽었어요.`
  } else if (local && /주소/.test(msg.split('\n')[0])) {
    for (const rel of ['제안서 양식.md', DRAFT]) { const p = path.join(local, rel); if (fs.existsSync(p)) fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(OLD, NEW)) }
    answer = '양식의 회사 주소를 새 주소로 고쳤어요.'
  }
  if (local) await uploadRoom(container, local)
  say({ type: 'token', content: answer })
  say({ type: 'done', content: answer })
  res.end()
}

let servers = []
let S, A, B, C, INTRO, RECORD, TPL, PROJ_B, WS_B
const enc = encodeURIComponent
async function upload(who, slug, p, body) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/folders/${slug}/files?path=${enc(p)}`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/octet-stream' }, body })
  if (!r.ok) throw new Error(`upload ${p}: ${r.status} ${await r.text()}`)
}
async function call(who, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${S.apiPort}/api${p}`, { method, headers: { Authorization: `Bearer ${who.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  let j = t
  try { j = JSON.parse(t) } catch { /* text */ }
  return { status: r.status, body: j, text: t }
}
const raw = async (who, slug, p, ref = 'main') => (await call(who, 'GET', `/folders/${slug}/raw?ref=${enc(ref)}&path=${enc(p)}`)).text

test.beforeAll(async () => {
  test.setTimeout(240_000)
  for (const p of [API_PORT, WEB_PORT, FAKE_PORT]) if (busy(p)) throw new Error(`port ${p} is in use — this file runs its own stack there`)
  fs.mkdirSync(SHOTS, { recursive: true })
  await new Promise((ok, no) => {
    const srv = http.createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        let body = {}
        try { body = JSON.parse(b) } catch { /* not json */ }
        if (/\/chat\/completions$/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(answerLlm(body))) }
        if (!req.url.startsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url.startsWith('/chat/stop') ? '{"stopped":false}' : '[]') }
        agent.bodies.push(body)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        runAgent(body, res).catch((e) => { console.warn('[fake agent]', e.message); res.end() })
      })
    })
    srv.once('error', no).listen(FAKE_PORT, '127.0.0.1', () => { servers.push(srv); ok() })
  })
  S = await startStack({ tenant: TENANT, apiFrom: API_PORT, webFrom: WEB_PORT, env: {
    PRO_LLM_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`, PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_LLM_MODEL: 'main-fake', PRO_LLM_FAST_MODEL: 'fast-fake', PRO_LLM_FRONT_MODEL: 'front-fake', PRO_LLM_ODDS_MODEL: 'fast-fake',
    PRO_DEEPAGENTS_URL: `http://127.0.0.1:${FAKE_PORT}`, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_EMBED_URL: '' } })
  if (S.apiPort !== API_PORT || S.webPort !== WEB_PORT) throw new Error(`the stack is not on ${API_PORT} · ${WEB_PORT}`)
  A = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '정하윤')   // owns the template and its two sources
  B = await S.person(`pro-rt-${TENANT}-b@uengine.org`, '김서연')   // starts 「가나정밀 3분기 제안」
  C = await S.person(`pro-rt-${TENANT}-c@uengine.org`, '박도윤')   // the next project
  for (const p of [A, B, C]) await S.join(p)
  const mk = async (name, description) => S.api(A.token, '/folders', { method: 'POST', body: { name, description } })
  INTRO = await mk('회사 소개 자료', '회사 개요')
  RECORD = await mk('납품 실적', '해마다 납품한 곳')
  TPL = await mk('제안서 템플릿', '제안서를 쓸 때 시작하는 폴더')
  await upload(A, INTRO.slug, '회사 개요.md', MD.intro)
  await upload(A, RECORD.slug, '2026 납품 실적.md', MD.record)
  await upload(A, TPL.slug, '제안서 양식.md', MD.form)
  await upload(A, TPL.slug, '.claude/skills/proposal-writer/SKILL.md', MD.skill)
  await upload(A, TPL.slug, 'TEMPLATE.md', MD.template)
  await S.api(A.token, `/folders/${TPL.slug}/refs`, { method: 'POST', body: { source: INTRO.slug, label: '회사 소개 자료' } })
  await S.api(A.token, `/folders/${TPL.slug}/refs`, { method: 'POST', body: { source: RECORD.slug, label: '납품 실적' } })
  const member = (f, who, role) => S.api(A.token, `/folders/${f.slug}/members`, { method: 'POST', body: { type: 'user', id: who.id, role } })
  for (const who of [B, C]) { await member(TPL, who, 'runner'); await member(INTRO, who, 'viewer'); await member(RECORD, who, 'viewer') }
})
test.afterAll(async () => {
  for (const s of servers) await new Promise((ok) => s.close(ok))
  servers = []
  if (!S) return
  fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
  fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
  await S.q('delete from pro_folder_ref_events where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
  for (const p of [A, B, C, { id: (await S.q(`select id::text from users where tenant_id=$1 and email=$2`, [TENANT, `pro-rt-${TENANT}-d@uengine.org`]).catch(() => []))[0]?.id }].filter((x) => x?.id)) {
    await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [p.id]).catch(() => {})
    await S.q('delete from pro_thread_folders where thread_id in (select id from pro_threads where user_id=$1)', [p.id]).catch(() => {})
    await S.q(`delete from pro_threads where user_id=$1 and kind <> 'chat'`, [p.id]).catch(() => {})
  }
  await S.q(`delete from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`skills/${TENANT}/`]).catch(() => {})
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
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
    localStorage.setItem('pgl-install', JSON.stringify({ never: true }))
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const calm = (p) => p.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((ok) => setTimeout(ok, 1500))]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(150); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const toFolder = async (p, f) => { await p.goto(`/folders/${f.slug}`); await p.locator('[data-test="folder-detail"] .files').waitFor() }
const box = (p) => p.locator('.composer textarea').first()
const noSideScroll = async (p) => expect(await p.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(await p.evaluate(() => window.innerWidth) + 1)

test('F-TF-01 「템플릿으로 지정」 — 「템플릿」 표시 · TEMPLATE.md 의 설명 · 폴더 목록의 「템플릿」', async ({ browser }) => {
  const p = await open(browser, A, DESK)
  await toFolder(p, TPL)
  await expect(p.locator('[data-test="folder-template"]')).toHaveCount(0)
  await p.locator('[data-test="folder-template-on"]').click()
  const bar = p.locator('[data-test="folder-template"]')
  await expect(bar).toContainText('제안서를 쓸 때 시작하는 템플릿이에요')
  await expect(bar).toContainText('「산출물/」에만 남아요')
  await expect(p.locator('h1 [data-test="folder-template-badge"]')).toHaveText('템플릿')
  await shot(p, 'f-tf-01-template')
  await p.goto('/folders')
  await expect(p.locator(`[data-test="folder-row"][data-slug="${TPL.slug}"] [data-test="folder-template-badge"]`)).toHaveText('템플릿')
  await expect(p.locator(`[data-test="folder-row"][data-slug="${INTRO.slug}"] [data-test="folder-template-badge"]`)).toHaveCount(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TF-02 「템플릿으로 시작」 — 프로젝트의 작업 공간 막대, 템플릿의 변형 목록 · 폴더 목록에는 없음', async ({ browser }) => {
  const p = await open(browser, B, DESK)
  await toFolder(p, TPL)
  await expect(p.locator('[data-test="folder-template-off"]')).toHaveCount(0, { timeout: 5000 })
  await p.locator('[data-test="folder-template-start"]').click()
  await p.locator('[data-test="folder-template-name"] input').fill('가나정밀 3분기 제안')
  await p.locator('[data-test="folder-template-go"]').click()
  await expect(p).toHaveURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 20000 })
  PROJ_B = p.url().split('/').pop()
  const bar = p.locator('[data-test="project-workspace-bar"]')
  await expect(bar).toContainText('템플릿')
  await expect(bar).toContainText('제안서 템플릿')
  await expect(bar).toContainText('전용 작업 공간 · 바뀐 것 없음')
  await expect(bar.locator('[data-test="project-propose"]')).toHaveText(/원본에 반영 요청/)
  await shot(p, 'f-tf-02-project')
  const f = (await call(B, 'GET', `/threads/${PROJ_B}/folder`)).body.folder
  WS_B = f.variation
  expect(WS_B.branch).toMatch(/^var\/t\//)
  // nowhere else: not the template's 변형 list (for anyone, its person included), not a folder of the list
  for (const who of [A, B, C]) expect((await call(who, 'GET', `/folders/${TPL.slug}`)).body.variations.map((v) => v.id)).not.toContain(WS_B.id)
  expect((await call(B, 'GET', '/folders')).body.map((x) => x.name)).not.toContain('가나정밀 3분기 제안')
  expect((await call(A, 'GET', `/folders/${TPL.slug}/variations/${WS_B.id}`)).status).toBe(404)
  await toFolder(p, TPL)
  await expect(p.locator('.vars')).not.toContainText('가나정밀')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TF-03 프로젝트 턴 — 참조 자리를 읽고 결과물은 산출물/ 에, 양식 고침도 작업 공간에만 · 템플릿 main 그대로', async ({ browser }) => {
  test.setTimeout(240_000)
  const p = await open(browser, B, DESK)
  await p.goto(`/projects/${PROJ_B}`)
  await box(p).waitFor({ timeout: 20000 })
  await box(p).fill('템플릿의 참조 자료를 읽고 가나정밀 3분기 제안서 초안을 써 줘')
  await box(p).press('Enter')
  await expect(p.locator('.row.r-agent').filter({ hasText: '이 프로젝트 작업 공간에 담았어요' }).first()).toBeVisible({ timeout: 90000 })
  await box(p).fill('양식의 회사 주소가 옛 주소예요. 새 주소로 고쳐 줘')
  await box(p).press('Enter')
  await expect(p.locator('.row.r-agent').filter({ hasText: '양식의 회사 주소를 새 주소로 고쳤어요' })).toBeVisible({ timeout: 90000 })
  await expect(p.locator('[data-test="project-workspace-bar"]')).toContainText(/전용 작업 공간 · 바뀐 것 \d+건/, { timeout: 30000 })
  // the agent was told about the workspace and the slots, and read the slots with 김서연's own role
  const told = agent.bodies.find((b) => /초안/.test(String(b.message).split('\n')[0])).message
  expect(told).toContain("템플릿 '제안서 템플릿' 에서 시작했어요")
  expect(told).toContain("'산출물/' 아래에 새 파일로")
  expect(told).toContain('회사 소개 자료/ — 원본: 「회사 소개 자료」 폴더 전체')
  expect(agent.reads.filter((r) => r.user === B.id).map((r) => r.from).sort()).toEqual(['납품 실적', '회사 소개 자료'])
  // outputs and the fix are in the workspace only; the template's main is as it was
  expect(await raw(B, TPL.slug, DRAFT, WS_B.id)).toContain(NEW)
  expect(await raw(B, TPL.slug, '제안서 양식.md', WS_B.id)).toContain(NEW)
  expect(await raw(A, TPL.slug, '제안서 양식.md')).toContain(OLD)
  expect((await call(A, 'GET', `/folders/${TPL.slug}/file?path=${enc(DRAFT)}`)).body.sha).toBeUndefined()
  // the workspace's files: the template's slots too (read with 김서연's role), refused to anyone else
  const tree = (await call(B, 'GET', `/folders/${TPL.slug}/tree?ref=${WS_B.id}`)).body
  expect(tree.some((f) => f.path === DRAFT)).toBe(true)
  expect(tree.filter((f) => f.ref).map((f) => f.path).sort()).toEqual(['납품 실적/2026 납품 실적.md', '회사 소개 자료/회사 개요.md'])
  expect((await call(C, 'GET', `/folders/${TPL.slug}/tree?ref=${WS_B.id}`)).status).toBe(404)
  expect((await call(C, 'GET', `/folders/${TPL.slug}/raw?ref=${WS_B.id}&path=${enc(DRAFT)}`)).status).toBe(404)
  await shot(p, 'f-tf-03-turn')
  // never merged whole — the template's owner neither
  expect((await call(A, 'POST', `/folders/${TPL.slug}/merge`, { ids: [WS_B.id] })).status).toBe(404)
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TF-04 「원본에 반영 요청」 — 템플릿 파일만 · 결과물은 「보내지 않아요」 → 정하윤의 알림 → 양식만 담긴 변형 → 반영', async ({ browser }) => {
  const p = await open(browser, B, DESK)
  await p.goto(`/projects/${PROJ_B}`)
  await p.locator('[data-test="project-propose"]').click()
  const sheet = p.locator('[data-test="propose-sheet"]')
  await expect(sheet.locator('[data-test="propose-file"]')).toHaveCount(1)
  await expect(sheet.locator('[data-test="propose-file"]')).toHaveAttribute('data-file', '제안서 양식.md')
  await expect(sheet.locator('[data-test="propose-output"]')).toHaveAttribute('data-file', DRAFT)
  await expect(sheet).toContainText('보내지 않아요')
  await sheet.locator('textarea').fill('회사 주소가 옛 주소라 새 주소로 바꿨어요')
  await shot(p, 'f-tf-04-sheet')
  await sheet.locator('[data-test="propose-send"]').click()
  await expect(sheet).toHaveCount(0)
  await expect(p.getByText(/주인에게 반영 요청을 보냈어요/)).toBeVisible()
  // an output can't be sent, whatever the page sends
  const bad = await call(B, 'POST', `/folders/${TPL.slug}/variations/${WS_B.id}/propose`, { paths: [DRAFT] })
  expect(bad.status).toBe(400)
  await p.context().close()
  // 정하윤: the notice, the variation with the form only, 「이 변형 반영」
  const [n] = await S.q(`select url, title from notifications where tenant_id=$1 and user_id=$2 and type='folder_request'`, [TENANT, A.id])
  expect(n.title).toContain('김서연님이 템플릿 「제안서 템플릿」에 반영을 요청했어요')
  const a = await open(browser, A, DESK)
  await a.goto(n.url)
  await expect(a.locator('.side .ci')).toHaveCount(1)
  await expect(a.locator('.side .ci')).toContainText('제안서 양식.md')
  await shot(a, 'f-tf-04-owner')
  await a.getByRole('button', { name: /이 변형 반영/ }).click()
  await a.getByRole('button', { name: '반영 시작' }).click()
  await expect.poll(async () => raw(A, TPL.slug, '제안서 양식.md'), { timeout: 30000 }).toContain(NEW)
  const files = (await call(A, 'GET', `/folders/${TPL.slug}/tree`)).body.map((f) => f.path)
  expect(files.some((x) => x.startsWith('산출물/'))).toBe(false)
  expect(a.errors).toEqual([])
  await a.context().close()
})

test('F-TF-05 「새 프로젝트」에서 같은 템플릿 — 고친 main 에서 시작, 앞 프로젝트는 보이지 않음', async ({ browser }) => {
  const p = await open(browser, C, DESK)
  await p.goto('/projects')
  await p.locator('[data-testid="project-folder-pick"]').click()
  const row = p.locator('[data-testid="folder-picker"] .row').filter({ hasText: '제안서 템플릿' })
  await expect(row.locator('[data-test="picker-template"]')).toHaveText('템플릿')
  await row.click()
  await expect(p.locator('[data-testid="project-folder-chip"]')).toContainText('템플릿으로 시작')
  await shot(p, 'f-tf-05-new-project')
  await box(p).fill('다라테크 4분기 제안 준비')
  await box(p).press('Enter')
  await expect(p).toHaveURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 30000 })
  await expect(p.locator('[data-test="project-workspace-bar"]')).toBeVisible({ timeout: 30000 })
  const id = p.url().split('/').pop()
  const ws = (await call(C, 'GET', `/threads/${id}/folder`)).body.folder.variation
  expect(await raw(C, TPL.slug, '제안서 양식.md', ws.id)).toContain(NEW)
  expect((await call(C, 'GET', `/folders/${TPL.slug}/tree?ref=${ws.id}`)).body.some((f) => f.path.startsWith('산출물/'))).toBe(false)
  expect((await call(C, 'GET', `/folders/${TPL.slug}/variations/${WS_B.id}`)).status).toBe(404)
  await shot(p, 'f-tf-05-next')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-TF-06 390px — 작업 공간 막대와 반영 요청 시트가 화면 안(밝은 · 어두운 테마)', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const p = await open(browser, B, PHONE, { theme })
    await p.goto(`/projects/${PROJ_B}`)
    const bar = p.locator('[data-test="project-workspace-bar"]')
    await expect(bar).toBeVisible({ timeout: 20000 })
    await noSideScroll(p)
    const bb = await bar.boundingBox()
    expect(bb.x + bb.width).toBeLessThanOrEqual(390 + 0.5)
    await shot(p, `f-tf-06-phone-bar-${theme}`)
    await bar.locator('[data-test="project-propose"]').click()
    const sheet = p.locator('[data-test="propose-sheet"] .box')
    await expect(sheet).toBeVisible()
    const sb = await sheet.boundingBox()
    expect(sb.x).toBeGreaterThanOrEqual(0)
    expect(sb.x + sb.width).toBeLessThanOrEqual(390 + 0.5)
    await shot(p, `f-tf-06-phone-sheet-${theme}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
})

test('F-TF-07 HTTP 로 돌아가는 길이 없음 — 새 변형의 기준 · 판으로 읽기 · 반영 요청의 출처 · 템플릿 지정과 시작 권한', async () => {
  const ws = (await S.q('select branch, head_commit from pro_folder_variations where id=$1', [WS_B.id]))[0]
  // POST …/variations {base}: a workspace (someone else's → 404, one's own → 409), a branch name or a git expression (400), main (200)
  const mkVar = (who, base) => call(who, 'POST', `/folders/${TPL.slug}/variations`, { title: `기준 시험 ${Math.random().toString(36).slice(2, 6)}`, base })
  expect((await mkVar(C, WS_B.id)).status).toBe(404)
  expect((await mkVar(B, WS_B.id)).status).toBe(409)
  for (const b of [ws.branch, `refs/heads/${ws.branch}`, ':/제안서', 'main~1', 'HEAD']) expect((await mkVar(C, b)).status, b).toBe(400)
  expect((await mkVar(C, ws.head_commit)).status).toBe(404)
  const ok = await mkVar(C, 'main')
  expect(ok.status).toBe(200)
  await call(C, 'POST', `/folders/${TPL.slug}/variations/${ok.body.id}/discard`)
  // reading by the workspace's commit: its person only (raw · publish · tree)
  expect((await call(C, 'GET', `/folders/${TPL.slug}/raw?ref=${ws.head_commit}&path=${enc(DRAFT)}`)).status).toBe(404)
  expect((await call(A, 'GET', `/folders/${TPL.slug}/raw?ref=${ws.head_commit}&path=${enc(DRAFT)}`)).status).toBe(404)
  expect((await call(C, 'POST', `/folders/${TPL.slug}/publish`, { path: DRAFT, ref: ws.head_commit })).status).toBe(404)
  expect((await call(C, 'GET', `/folders/${TPL.slug}/tree?ref=${ws.head_commit}`)).status).toBe(404)
  expect((await call(B, 'GET', `/folders/${TPL.slug}/raw?ref=${ws.head_commit}&path=${enc(DRAFT)}`)).status).toBe(200)
  // the request the template's members see: its files and note — no workspace id, no thread
  const req = (await call(A, 'GET', `/folders/${TPL.slug}`)).body.variations.find((v) => v.source?.request)
  expect(Object.keys(req.source.request).sort()).toEqual(['note', 'paths'])
  expect(JSON.stringify(req)).not.toContain(WS_B.id)
  expect(JSON.stringify(req)).not.toContain(PROJ_B)
  // importing branches: a linked folder's agent branches only — never a managed folder's (a workspace's, a desktop run's)
  expect((await call(A, 'POST', `/folders/${TPL.slug}/import`, { branches: [ws.branch, 'pgpt-agent/x'] })).status).toBe(400)
  // PATCH template: the owner only; never a work folder
  expect((await call(B, 'PATCH', `/folders/${TPL.slug}`, { template: false })).status).toBe(403)
  await S.q(`update pro_folders set settings = settings || '{"work": {"instId": "tf"}}'::jsonb where id=$1`, [INTRO.id])
  expect((await call(A, 'PATCH', `/folders/${INTRO.slug}`, { template: true })).status).toBe(400)
  await S.q(`update pro_folders set settings = settings - 'work' where id=$1`, [INTRO.id])
  // 「템플릿으로 시작」: a viewer of the template is refused, and nothing is made
  const D = await S.person(`pro-rt-${TENANT}-d@uengine.org`, '윤도하')
  await S.api(A.token, `/folders/${TPL.slug}/members`, { method: 'POST', body: { type: 'user', id: D.id, role: 'viewer' } })
  expect((await call(D, 'POST', `/folders/${TPL.slug}/start-project`, { title: '보기 권한으로' })).status).toBe(403)
  expect((await S.q(`select count(*)::int n from pro_threads where user_id=$1 and kind='project'`, [D.id]))[0].n).toBe(0)
})
