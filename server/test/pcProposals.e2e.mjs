// 「내 PC 의 ○○ 스킬을 등록해 줘」 · 「이 폴더 올려 줘」 end to end (spec openspec/specs/local-agents 「채팅에서 내 PC 의 스킬 · 폴더를 등록
// 제안」 · champion-folders 「채팅으로 폴더 올리기 제안」, design docs/local-agents/design.md §13): a real Lite BFF, a person's desktop (the
// desktop app's own runner — its ToolDesk and champion folders' engine — with the fake interactive `claude` and `codex`, desktop/test/
// fixtures/fake-tui.js, which call the MCP server the runner gave them over its real stdio, as the real CLIs do). Fictional people:
//   정하윤 — her PC has skills in Claude Code's folder and a folder 「영업 키트」; 김서연 — another person of the company
//   1. her chat to 「Claude Code · 내 PC」: its CLI sees the five tools, lists her PC's skills, proposes 「견적-규칙」 → the card in the chat
//      (nothing registered yet); the token route: none · forged → 401, another person's card → 404
//   2. 「등록」 on the card (its confirmation) → her own skill, in her skill list; a second press 409
//   3. a folder: the CLI proposes 「~/영업 키트」 → 「폴더를 올릴까요?」 with the champion preview (.env left out, the skill found) → 「올리기」 →
//      her PC uploads it with the champion folders' engine → a shared folder whose main has the files (never .env), the card 「올렸어요」
//   4. the run ends: its token is refused (403) and its tools close
//   5. Codex gets the same tools (-c mcp_servers.…) and lists her skills on the server
//   node test/pcProposals.e2e.mjs   (port 8999 — PT_PORT, tenant "pctools-e2e", folders and process-gpt's skill folders in a temporary
//   directory; no model, no shared service)
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(here, '..')
const REPO = path.resolve(SERVER, '..')
const DESKTOP = path.join(REPO, 'desktop')
const require = createRequire(import.meta.url)
const { createLocalRunner } = require(path.join(DESKTOP, 'src/runner/index.js'))
const { fakeBin } = require(path.join(DESKTOP, 'test/helpers/fakeBin.js'))
const PORT = Number(process.env.PT_PORT || 8999)
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = fss.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-pctools-e2e-')))
const TENANT = 'pctools-e2e'
const RESULTS = process.env.PT_RESULTS || ''
// process-gpt's folders (where a registered skill is kept) in a temporary place; its secrets read from the real checkout's .env, as config.js would
{
  const real = [path.join(REPO, 'backends', 'process-gpt'), path.join(os.homedir(), 'process-gpt')].find((p) => fss.existsSync(path.join(p, 'services')))
  const env = real && fss.existsSync(path.join(real, '.env')) ? (await import('dotenv')).parse(fss.readFileSync(path.join(real, '.env'))) : {}
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v
}
const uploads = []
const dagents = http.createServer((req, res) => { req.resume(); req.on('end', () => { uploads.push(req.url); res.setHeader('content-type', 'application/json'); res.end('{}') }) })
await new Promise((r) => dagents.listen(0, '127.0.0.1', r))
Object.assign(process.env, { PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '', PRO_FOLDERS_ROOT: path.join(ROOT, 'folders'), PGPT_ROOT: path.join(ROOT, 'pgpt') })
await fs.mkdir(path.join(ROOT, 'pgpt', 'services'), { recursive: true })
const { q, pool } = await import('../lib/supa.js')
const PT = await import('../lib/localAgents/pcTools.js')
const BIN = fakeBin(path.join(ROOT, 'bin'))
process.env.FAKE_CLI_HOME = path.join(ROOT, 'fake-home')
process.env.FAKE_CLI_LOG = path.join(ROOT, 'fake.log')
const PCHOME = path.join(ROOT, 'home')
const CLI_ENV = { CLAUDE_CONFIG_DIR: path.join(PCHOME, '.claude'), CODEX_HOME: path.join(PCHOME, '.codex') }
const SEARCH = [BIN, '/usr/bin', '/bin', '/opt/homebrew/bin'].join(path.delimiter)
const put = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }
// her PC: two skills of Claude Code's, and a folder
await put(path.join(CLI_ENV.CLAUDE_CONFIG_DIR, 'skills', '견적-규칙', 'SKILL.md'), '---\nname: 견적-규칙\ndescription: 견적서를 회사 양식으로 쓰는 법\n---\n# 견적 규칙\n부가세는 따로 적어요.\n')
await put(path.join(CLI_ENV.CLAUDE_CONFIG_DIR, 'skills', '견적-규칙', 'templates', '견적서.md'), '| 품목 | 수량 | 금액 |\n')
await put(path.join(CLI_ENV.CLAUDE_CONFIG_DIR, 'skills', '견적-규칙', '.env'), 'QUOTE_API_KEY=abc\n')
await put(path.join(CLI_ENV.CLAUDE_CONFIG_DIR, 'skills', '회의록', 'SKILL.md'), '---\nname: 회의록\ndescription: 회의록을 정리해요\n---\n')
await put(path.join(PCHOME, '영업 키트', 'README.md'), '# 영업 키트\n제안서 · 견적 양식\n')
await put(path.join(PCHOME, '영업 키트', '양식', '제안서.md'), '# 제안서 양식\n')
await put(path.join(PCHOME, '영업 키트', '.env'), 'CRM_TOKEN=xyz\n')
await put(path.join(PCHOME, '영업 키트', '.claude', 'skills', '제안서', 'SKILL.md'), '---\nname: 제안서\ndescription: 제안서를 써요\n---\n')

let server
const serverLog = []
const runners = []
const report = []
let n = 0
const people = []
async function cleanup() {
  for (const r of runners) try { r.stop() } catch { /* gone */ }
  if (server && server.exitCode == null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)) }
  for (const t of ['pro_pc_proposals', 'pro_local_jobs', 'pro_local_devices', 'pro_chat_agents', 'pro_folder_sources', 'pro_folders', 'pro_skill_visibility']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
  for (const u of people) {
    await q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [u]).catch(() => {})
    await q(`delete from pro_threads where user_id=$1 and kind='project'`, [u]).catch(() => {})
  }
  dagents.close()
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
}
async function save() { if (RESULTS) await fs.writeFile(RESULTS, JSON.stringify({ at: new Date().toISOString(), port: PORT, steps: report }, null, 2)) }
async function step(name, fn) {
  n++
  const t = Date.now()
  try {
    const said = await fn()
    console.log(`ok ${n} - ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)${said ? `\n  ${said}` : ''}`)
    report.push({ n, name, ok: true, said: said || '', seconds: (Date.now() - t) / 1000 })
  } catch (e) {
    console.log(`not ok ${n} - ${name}\n  ${e.stack || e.message}`)
    console.log('--- server log (last 80 lines)\n' + serverLog.join('').split('\n').slice(-80).join('\n'))
    report.push({ n, name, ok: false, error: e.message })
    await save()
    await cleanup(); process.exit(1)
  }
}
const waitFor = async (fn, ms = 30000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 200)) } }
const api = async (token, p, { method = 'GET', body, raw = false } = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let j = null
  try { j = JSON.parse(text) } catch { j = text }
  if (raw) return { status: r.status, body: j }
  if (!r.ok) throw Object.assign(new Error(`${method} ${p} → ${r.status} ${text.slice(0, 200)}`), { status: r.status })
  return j
}
async function say(token, threadId, text, extra = {}) {
  const r = await fetch(`${BASE}/api/threads/${threadId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ text, ...extra }) })
  if (!r.ok) throw Object.assign(new Error(`say → ${r.status}`), { status: r.status })
  const out = {}
  for (const block of (await r.text()).split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block)?.[1]
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (ev && data) out[ev] = JSON.parse(data)
  }
  return out
}
const messages = (token, threadId) => api(token, `/threads/${threadId}/messages`)
const cliLog = async () => { try { return (await fs.readFile(process.env.FAKE_CLI_LOG, 'utf8')).trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } }
const cardsIn = async (token, threadId) => (await messages(token, threadId)).filter((m) => m.kind === 'pc_proposal')

await step('BFF 를 띄운다(:8999, PRO_BACKGROUND=0, 시험 회사, 모델 · 공용 서비스 없음)', async () => {
  server = spawn(process.execPath, ['index.js'], { cwd: SERVER, env: { ...process.env, PRO_PORT: String(PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off',
    PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_PUBLIC_URL: BASE,
    PRO_DEEPAGENTS_URL: `http://127.0.0.1:${dagents.address().port}`, PRO_COMPLETION_URL: 'http://127.0.0.1:9', PRO_CONTEXT_ROUTER_URL: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => serverLog.push(String(d)))
  server.stderr.on('data', (d) => serverLog.push(String(d)))
  await waitFor(async () => (await fetch(`${BASE}/api/config`).catch(() => null))?.ok, 60000, 'the BFF')
  return BASE
})
const signIn = async (email, name) => {
  const r = await api(null, '/auth/email/verify', { method: 'POST', body: { email, code: '000000' } })
  await api(r.session.access_token, '/profile', { method: 'POST', body: { name, birth: '1990-01-01', onboarded: true } })
  await api(r.session.access_token, '/me')
  people.push(r.user.id)
  return { id: r.user.id, token: r.session.access_token, name }
}
const HY = await signIn('pro-rt-pctools-hy@uengine.org', '정하윤')
const SY = await signIn('pro-rt-pctools-sy@uengine.org', '김서연')
const [main] = await api(HY.token, '/threads')
await q(`delete from pro_messages where thread_id=$1`, [main.id])
let pc, device
await step('그녀의 PC 를 잇는다 — 데스크톱은 도구가 있다고 알린다(liteTools · liteFolders)', async () => {
  device = await api(HY.token, '/local-agents/devices', { method: 'POST', body: { name: '정하윤의 맥', platform: 'darwin', appVersion: '0.2.8' } })
  pc = createLocalRunner({ server: BASE, token: device.token, dataDir: path.join(ROOT, 'pc', 'data'), device: { name: '정하윤의 맥', platform: 'darwin', appVersion: '0.2.8' },
    prefs: () => ({ enabled: true, ask: false }), searchPath: SEARCH, log: (s) => serverLog.push(`[runner] ${s}\n`), sessionEnv: CLI_ENV, settleMs: 120_000,
    folders: (() => { const m = new Map(); return { get: (id) => m.get(String(id)) || null, put: (e) => m.set(String(e.folderId), e), all: () => [...m.values()], drop: (id) => m.delete(String(id)) } })(),
    userId: HY.id, toolOpts: { home: PCHOME } })
  runners.push(pc)
  await pc.start()
  await waitFor(() => pc.status().connected, 10000, 'linked')
  const [d] = await q('select caps from pro_local_devices where id=$1', [device.device.id])
  assert.equal(d.caps.liteTools, true)
  assert.equal(d.caps.liteFolders, true)
  return '정하윤의 맥 · 도구 있음'
})

let skillCard, job1
await step('「내 PC 의 견적-규칙 스킬을 등록해 줘」 → CLI 가 도구 다섯을 보고 PC 의 스킬을 찾아 제안 → 채팅에 「스킬을 등록할까요?」(아직 등록 안 됨)', async () => {
  const r = await say(HY.token, main.id, ['내 PC 의 견적-규칙 스킬을 등록해 줘',
    'MCP process_gpt_lite.lite_list_pc_skills :: {}',
    'MCP process_gpt_lite.lite_propose_skill :: {"path": "~/.claude/skills/견적-규칙"}'].join('\n'), { agent: 'claude-code' })
  assert.ok(r.done?.started, JSON.stringify(r))
  job1 = r.done.jobId
  skillCard = (await waitFor(async () => (await cardsIn(HY.token, main.id))[0], 40000, 'the card'))
  assert.equal(skillCard.content.text, '스킬을 등록할까요? · 견적-규칙')
  const log = await cliLog()
  const calls = log.filter((l) => l.mcp)
  assert.deepEqual(calls[0].tools, ['lite_list_pc_skills', 'lite_list_my_skills', 'lite_propose_skill', 'lite_list_my_folders', 'lite_propose_folder'])
  const listed = JSON.parse(calls[0].text).skills.map((s) => s.name).sort()
  assert.deepEqual(listed, ['견적-규칙', '회의록'])
  assert.equal(calls[1].isError, false, calls[1].text)
  assert.match(calls[1].text, /「등록」을 눌러야 등록돼요/)
  assert.equal(await (await import('../lib/folders/skills.js')).visibility('견적-규칙'), null, 'not registered yet')
  // the card: hers alone · the tool route needs this run's token
  assert.equal((await api(SY.token, `/pc-proposals/${skillCard.content.pc.id}`, { raw: true })).status, 404)
  assert.equal((await api(null, '/local-agents/tools/skills', { raw: true })).status, 401)
  assert.equal((await api('plt1.forged.token', '/local-agents/tools/skills', { raw: true })).status, 401)
  return `카드 ${skillCard.content.pc.id.slice(0, 8)} · CLI 가 본 스킬 ${listed.join(', ')}`
})

await step('카드의 「등록」 → 그녀의 스킬(내 스킬 목록에) · .env 는 없음 · 두 번 누르면 409', async () => {
  const id = skillCard.content.pc.id
  const v = await api(HY.token, `/pc-proposals/${id}`)
  assert.equal(v.state, 'pending')
  assert.equal(v.files, 2)
  assert.ok(v.excluded.some((g) => g.group === 'secret' && g.count === 1), '.env left out on her PC')
  // (「회사 스킬」 by the skill folder's own rule — she is the author of what she registers)
  assert.equal(v.options.company, true)
  assert.equal((await api(HY.token, `/pc-proposals/${id}/register`, { method: 'POST', body: { scope: 'mine', confirm: 'x.y' }, raw: true })).status, 409, 'without what was shown')
  const done = await api(HY.token, `/pc-proposals/${id}/register`, { method: 'POST', body: { scope: 'mine', confirm: v.confirm } })
  assert.equal(done.state, 'done')
  const skills = await api(HY.token, '/folders/skills')
  const mine = skills.find((s) => s.name === '견적-규칙')
  assert.ok(mine?.mine && mine.visibility === 'private', JSON.stringify(mine))
  assert.ok(!(await api(SY.token, '/folders/skills')).some((s) => s.name === '견적-규칙'), 'not hers to see')
  const [f] = await q(`select * from pro_folders where tenant_id=$1 and kind='skill' and settings->>'skill_name'='견적-규칙'`, [TENANT])
  assert.match(execFileSync('git', ['-C', f.repo_path, 'show', 'main:templates/견적서.md'], { encoding: 'utf8' }), /품목/)
  assert.throws(() => execFileSync('git', ['-C', f.repo_path, 'show', 'main:.env'], { stdio: 'pipe' }))
  assert.equal((await api(HY.token, `/pc-proposals/${id}/register`, { method: 'POST', body: { confirm: v.confirm }, raw: true })).status, 409)
  const card = (await cardsIn(HY.token, main.id)).find((m) => m.content.pc.id === id)
  assert.equal(card.content.pc.state, 'done')
  return `스킬 폴더 ${f.slug} · 내 스킬`
})

await step('폴더: 「~/영업 키트 올려 줘」 → 「폴더를 올릴까요?」(챔피언 미리 보기) → 「올리기」 → 그녀의 PC 가 챔피언 엔진으로 올림 → 공유 폴더 · 카드 「올렸어요」', async () => {
  await say(HY.token, main.id, ['~/영업 키트 폴더를 올려 줘', 'MCP process_gpt_lite.lite_propose_folder :: {"path": "~/영업 키트"}'].join('\n'), { agent: 'claude-code' })
  const card = await waitFor(async () => (await cardsIn(HY.token, main.id)).find((m) => m.content.pc.kind === 'folder'), 40000, 'the folder card')
  assert.equal(card.content.text, '폴더를 올릴까요? · 영업 키트')
  const id = card.content.pc.id
  let v = await api(HY.token, `/pc-proposals/${id}`)
  assert.equal(v.preview.files, 3)
  assert.ok(v.preview.excluded.some((g) => g.group === 'secret'))
  assert.ok(v.preview.kit.some((k) => k.type === 'skill' && k.name === '제안서'))
  assert.equal(v.pcOnline, true)
  assert.equal(v.device, '정하윤의 맥')
  assert.ok(!JSON.stringify(v).includes(PCHOME), 'no path of her PC')
  v = await api(HY.token, `/pc-proposals/${id}/upload`, { method: 'POST', body: { confirm: v.confirm } })
  assert.equal(v.state, 'working')
  v = await waitFor(async () => { const x = await api(HY.token, `/pc-proposals/${id}`); return x.state === 'done' ? x : null }, 60000, 'uploaded')
  const [f] = await q(`select * from pro_folders where tenant_id=$1 and slug=$2`, [TENANT, v.result.slug])
  assert.ok(f.settings.champion)
  const files = execFileSync('git', ['-C', f.repo_path, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim().split('\n').sort()
  assert.deepEqual(files, ['.claude/skills/제안서/SKILL.md', 'README.md', '양식/제안서.md'])
  const [src] = await q('select * from pro_folder_sources where folder_id=$1', [f.id])
  assert.equal(String(src.device_id), device.device.id, 'kept from her PC like any champion folder')
  assert.ok((await api(HY.token, '/folders')).some((x) => x.slug === f.slug))
  assert.equal(pc.folders.list().length, 1)
  return `폴더 ${f.slug} · main ${files.length}개`
})

await step('실행이 끝나면 그 토큰은 403 · 도구도 닫힌다', async () => {
  const token = PT.mintToken({ tenant: TENANT, user: HY.id, device: device.device.id, job: job1 })
  assert.equal((await api(token, '/local-agents/tools/folders', { raw: true })).status, 200, 'while it is on')
  await api(HY.token, `/local-agents/jobs/${job1}/finish`, { method: 'POST' })
  await waitFor(async () => (await q('select state from pro_local_jobs where id=$1', [job1]))[0].state === 'done', 30000, 'done')
  const after = await api(token, '/local-agents/tools/folders', { raw: true })
  assert.equal(after.status, 403)
  assert.equal(after.body.code, 'job_over')
  await waitFor(() => pc.tools.runs.size === 0, 10000, 'its key closed')
  return '403 job_over'
})

await step('Codex 도 같은 도구(-c mcp_servers.…) — 서버의 내 스킬을 본다', async () => {
  // (a chat's runs share its folder on the PC: the Claude Code run ended first — the step before)
  const r = await say(HY.token, main.id, 'MCP process_gpt_lite.lite_list_my_skills :: {}', { agent: 'codex' })
  assert.ok(r.done?.started, JSON.stringify(r))
  const call = await waitFor(async () => (await cliLog()).find((l) => l.kind === 'codex' && l.mcp === 'lite_list_my_skills'), 40000, 'codex call')
  assert.equal(call.isError, false, call.text)
  assert.ok(JSON.parse(call.text).skills.some((s) => s.name === '견적-규칙' && s.mine))
  return 'codex: 견적-규칙(내 스킬)'
})

await save()
await cleanup()
console.log(`# ${report.filter((r) => r.ok).length}/${report.length} passed`)
process.exit(0)
