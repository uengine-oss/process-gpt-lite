// Champion folders P0 over the real wire (spec openspec/specs/champion-folders, folder-git-remote 「에이전트가 올릴 수 있는 것은 자기
// 가지뿐이다」): a real Lite BFF, a stand-in for the desktop app that opens the real link (WebSocket /api/local-agents/link with its
// device token) and speaks the sync messages, and real `git` over the public path /api/local-git. Fictional people: 박챔피언 (owner),
// 김동료 (a teammate).
//   1. 박챔피언 makes a champion folder (its first commit has no file) · binds it from his PC · gets a sync token (1 h, his device, his
//      branch only) · pushes a snapshot of his folder (skills, CLAUDE.md, AGENTS.md, Cursor rules, an OpenSpec spec, documents) ·
//      sync:pushed → main moves to it, the files and the agent assets are on the folder screen, his PC is listed as its source
//   2. refused: main and other branches with that token · a pushed file shaped like a private key (put back at once, main unchanged,
//      the value nowhere — not in the replies, not in the server's log) · no token · a token for another folder · another company's folder
//   3. refused and put back right after the push: a link · a gitlink · .gitmodules · 21 new commits · a file over 50 MB; the folder's own
//      .gitattributes (eol=crlf · union) does not change the server's main; the sync branches are hidden from every other token, and the
//      cluster path takes no desktop token
//   4. 김동료 cannot bind a folder that already has files (not_empty); on an empty one she binds and does not see 박챔피언's branch; made a
//      viewer, her push is refused while her fetch still works · her device revoked → refused
//   4. 박챔피언's source removed on the web → his token and sync:token are refused, his PC hears it at once
//   5. an empty champion folder (an upload that did not happen) is removed again; one with files is not; not by someone else
//   node test/champion-sync.e2e.mjs   (BFF on 8963 — CH_PORT to change; tenant "champion-e2e", folders in a temporary directory; no model)
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(here, '..')
const PORT = Number(process.env.CH_PORT) || 8963
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
if (!portFree(PORT)) { console.log(`not ok - port ${PORT} is in use (CH_PORT=<another> to change)`); process.exit(1) }
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-champion-e2e-'))
const TENANT = 'champion-e2e'
const OTHER = 'champion-e2e-other'
const RESULTS = process.env.CH_RESULTS || ''
Object.assign(process.env, { PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '', PRO_FOLDERS_ROOT: path.join(ROOT, 'folders') })
const { q, pool } = await import('../lib/supa.js')

let server
const serverLog = []
const links = []
const report = []
const people = []
let n = 0
async function cleanup() {
  for (const l of links) try { l.ws.close() } catch { /* gone */ }
  if (server && server.exitCode == null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)) }
  for (const t of ['pro_folder_sources', 'pro_local_devices', 'pro_folders', 'pro_team_members', 'users']) for (const tn of [TENANT, OTHER]) await q(`delete from ${t} where tenant_id=$1`, [tn]).catch(() => {})
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
    console.log('--- server log (last 60 lines)\n' + serverLog.join('').split('\n').slice(-60).join('\n'))
    report.push({ n, name, ok: false, error: e.message })
    await save()
    await cleanup(); process.exit(1)
  }
}
const waitFor = async (fn, ms = 20000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 150)) } }
const api = async (token, p, { method = 'GET', body } = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let j = null
  try { j = JSON.parse(text) } catch { j = text }
  if (!r.ok) throw Object.assign(new Error(`${method} ${p} → ${r.status} ${text.slice(0, 200)}`), { status: r.status })
  return j
}
const status = async (token, p, opts) => { try { await api(token, p, opts); return 200 } catch (e) { return e.status || 0 } }

// real git, the token only in a request header (GIT_CONFIG_* — never on the command line)
const git = (cwd, args, token = null) => new Promise((resolve) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: ROOT }
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k]
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` })
  execFile('git', ['-c', 'user.name=박챔피언', '-c', 'user.email=champion@example.test', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args],
    { cwd, env }, (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, out: String(stdout).trim(), err: String(stderr) }))
})
const remote = (folderId) => `${BASE}/api/local-git/${folderId}.git`
async function write(dir, files) {
  for (const [p, body] of Object.entries(files)) {
    const f = path.join(dir, ...p.split('/'))
    if (body == null) { await fs.rm(f, { force: true }); continue }
    await fs.mkdir(path.dirname(f), { recursive: true })
    await fs.writeFile(f, body)
  }
}

// ---------- a stand-in for the desktop app's link (the app's main process speaks the same) ----------
function openLink(deviceToken, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/local-agents/link`)
    const L = { ws, got: [], closed: null,
      send: (m) => ws.send(JSON.stringify(m)),
      // the next message of one of these types (after `since` — its index in got)
      next(types, since = L.got.length, ms = 20000) { const want = [].concat(types); return waitFor(() => L.got.slice(since).find((m) => want.includes(m.type)), ms, `${want.join('|')} on ${name}`) },
      async ask(msg, types) { const at = L.got.length; L.send(msg); return L.next(types, at) } }
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: deviceToken, device: { name, appVersion: 'e2e' }, caps: { clis: {} }, prefs: { enabled: false }, active: [] })))
    ws.on('message', (d) => {
      const m = JSON.parse(String(d))
      if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }))
      L.got.push(m)
      if (m.type === 'welcome') resolve(L)
      if (m.type === 'denied') reject(new Error(m.reason))
    })
    ws.on('close', (code) => { L.closed = code })
    ws.on('error', reject)
    links.push(L)
  })
}

// ---------- the BFF ----------
await step(`CH-E-01 BFF 를 띄운다(${PORT}, PRO_BACKGROUND=0, 시험 회사, 모델 없음)`, async () => {
  server = spawn(process.execPath, ['index.js'], { cwd: SERVER, env: { ...process.env, PRO_PORT: String(PORT), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off',
    PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_PUBLIC_URL: BASE, PRO_GIT_PUBLIC_URL: '',
    PRO_DEEPAGENTS_URL: 'http://127.0.0.1:9', PRO_COMPLETION_URL: 'http://127.0.0.1:9', PRO_CONTEXT_ROUTER_URL: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'] })
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
const PC = await signIn('pro-rt-champion-a@uengine.org', '박챔피언')
const KIM = await signIn('pro-rt-champion-b@uengine.org', '김동료')
const KIT = {
  '.claude/skills/견적-규칙/SKILL.md': '---\nname: 견적 규칙\ndescription: 견적서를 만들 때 지킬 것 — 할인율 · 납기 · 서명\n---\n\n# 견적 규칙\n',
  '.claude/commands/opsx/apply.md': '---\ndescription: 진행 중인 변경을 적용한다\n---\n$ARGUMENTS\n',
  'CLAUDE.md': '# 영업 제안 키트\n\n- 견적은 `견적/` 아래에\n',
  'AGENTS.md': '# Codex 에게\n',
  '.cursor/rules/a.mdc': '---\ndescription: 문서는 한국어 해요체로\nglobs: "*.md"\n---\n',
  'openspec/specs/y/spec.md': '# 견적 스펙\n',
  '견적/양식.md': '# 견적 양식\n\n| 품목 | 수량 | 단가 |\n',
  '제안서/개요.md': '# 제안서 개요\n',
}
let folder, pcLink, pcDevice, tok, work, first
await step('CH-E-02 챔피언 폴더 → 내 PC 에서 묶기 → 동기화 토큰(1시간 · 이 기기 · 이 가지만) → 실제 git push → sync:pushed → main 과 파일 · 에이전트 자산 · 원본 PC', async () => {
  folder = await api(PC.token, '/folders', { method: 'POST', body: { name: '영업 제안 키트', description: '박챔피언의 맥에서 올림', champion: true } })
  assert.ok(folder.settings?.champion?.at, 'champion')
  assert.deepEqual(await api(PC.token, `/folders/${folder.slug}/tree`), [], '첫 커밋에 파일이 없다')
  pcDevice = await api(PC.token, '/local-agents/devices', { method: 'POST', body: { name: '박챔피언의 맥', platform: 'darwin', appVersion: 'e2e' } })
  pcLink = await openLink(pcDevice.token, '박챔피언의 맥')
  const bound = await pcLink.ask({ type: 'sync:bind', folderId: folder.id, label: '영업 제안 키트' }, ['sync:bound', 'sync:refused'])
  assert.equal(bound.type, 'sync:bound', JSON.stringify(bound))
  assert.equal(bound.branch, `pgpt-agent/sync-${pcDevice.device.id.slice(0, 8)}/main`)
  tok = await pcLink.ask({ type: 'sync:token', folderId: folder.id }, ['sync:token', 'sync:refused'])
  assert.equal(tok.type, 'sync:token', JSON.stringify(tok))
  assert.equal(tok.path, `/api/local-git/${folder.id}.git`)
  assert.equal(tok.url, null, 'PRO_GIT_PUBLIC_URL 없음 → 서버 주소 + path')
  const claims = JSON.parse(Buffer.from(tok.token.split('.')[1], 'base64url').toString())
  assert.deepEqual([claims.scope, claims.device, claims.push, claims.tenant], ['sync', pcDevice.device.id, `pgpt-agent/sync-${pcDevice.device.id.slice(0, 8)}/`, TENANT])
  assert.ok(Math.abs(claims.exp - Date.now() / 1000 - 3600) < 30, '1시간')
  // his folder's snapshot on top of the server's main (the desktop fetches main; a clone here)
  work = path.join(ROOT, 'pc')
  const cl = await git(ROOT, ['clone', '-q', remote(folder.id), work], tok.token)
  assert.equal(cl.code, 0, cl.err)
  assert.equal((await git(work, ['rev-parse', 'HEAD'])).out, tok.main)
  await write(work, KIT)
  await git(work, ['add', '-A'])
  await git(work, ['commit', '-q', '-m', '동기화 · 박챔피언의 맥'])
  first = (await git(work, ['rev-parse', 'HEAD'])).out
  const push = await git(work, ['push', '-q', 'origin', `HEAD:refs/heads/${tok.branch}`], tok.token)
  assert.equal(push.code, 0, push.err)
  const taken = await pcLink.ask({ type: 'sync:pushed', folderId: folder.id, head: first, report: { files: 8, bytes: 640, excluded: { secret: 1, personal: 2, rebuildable: 40 }, flagged: 0 } }, ['sync:taken', 'sync:behind', 'sync:refused'])
  assert.equal(taken.type, 'sync:taken', JSON.stringify(taken))
  assert.equal(taken.main, first, '앞감기')
  const d = await api(PC.token, `/folders/${folder.slug}`)
  assert.equal(d.history[0].sha, first)
  const tree = (await api(PC.token, `/folders/${folder.slug}/tree`)).map((f) => f.path).sort()
  assert.deepEqual(tree, Object.keys(KIT).sort())
  const kit = await api(PC.token, `/folders/${folder.slug}/kit`)
  assert.deepEqual(kit.map((k) => `${k.platform}:${k.type}:${k.name}`), ['claude:skill:견적 규칙', 'claude:command:opsx:apply', 'claude:instructions:CLAUDE.md', 'codex:instructions:AGENTS.md',
    'cursor:rules:a.mdc', 'spec:spec:y'])
  assert.equal(kit[0].description, '견적서를 만들 때 지킬 것 — 할인율 · 납기 · 서명')
  const [src] = await api(PC.token, `/folders/${folder.slug}/sources`)
  assert.deepEqual([src.label, src.userName, src.deviceName, src.state, src.mine], ['영업 제안 키트', '박챔피언', '박챔피언의 맥', 'active', true])
  assert.deepEqual(src.report.excluded, { gitignore: 0, secret: 1, personal: 2, rebuildable: 40, large: 0, structure: 0 })
  assert.equal(JSON.stringify(src).includes('/Users/'), false, '경로가 없다')
  return `main ${first.slice(0, 8)} · 파일 ${tree.length} · 자산 ${kit.length} (${[...new Set(kit.map((k) => k.platform))].join(' · ')})`
})

await step('CH-E-03 막힘: 그 토큰으로 main · 다른 가지 · 지우기 / 토큰 없이 / 다른 폴더의 주소 / 다른 회사의 폴더 묶기', async () => {
  // (a commit main has not got: a push of the same head would be "up to date")
  await write(work, { '제안서/개요.md': '# 제안서 개요 2판\n' })
  await git(work, ['commit', '-qam', '고침'])
  const toMain = await git(work, ['push', 'origin', 'HEAD:refs/heads/main'], tok.token)
  assert.notEqual(toMain.code, 0)
  assert.match(toMain.err, /remote rejected.*only refs\/heads\/pgpt-agent\/sync-[0-9a-f]{8}\/\*/s)
  const other = await git(work, ['push', 'origin', 'HEAD:refs/heads/pgpt-agent/local-x'], tok.token)
  assert.match(other.err, /remote rejected/)
  const del = await git(work, ['push', 'origin', `:refs/heads/${tok.branch}`], tok.token)
  assert.match(del.err, /remote rejected/)
  await git(work, ['reset', '-q', '--hard', first])
  const none = await git(ROOT, ['ls-remote', remote(folder.id)])
  assert.match(none.err, /401|Authentication failed|could not read Username/i)
  // another folder of his: this token is for one folder only
  const second = await api(PC.token, '/folders', { method: 'POST', body: { name: '두 번째 키트', champion: true } })
  const wrong = await git(ROOT, ['ls-remote', remote(second.id)], tok.token)
  assert.match(wrong.err, /403/)
  // another company's folder (the same server and database, another tenant): not found from this link
  const otherRepo = path.join(ROOT, 'other-co')
  await fs.mkdir(otherRepo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', otherRepo])
  const [of] = await q(`insert into pro_folders (tenant_id, slug, name, kind, repo_path, settings) values ($1,'other-kit','다른 회사 키트','managed',$2,$3) returning id`, [OTHER, otherRepo, { champion: { by: PC.id } }])
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,'owner')`, [of.id, PC.id])
  const no = await pcLink.ask({ type: 'sync:bind', folderId: of.id, label: 'x' }, ['sync:bound', 'sync:refused'])
  assert.deepEqual([no.type, no.why], ['sync:refused', 'no_folder'])
  const noTok = await pcLink.ask({ type: 'sync:token', folderId: of.id }, ['sync:token', 'sync:refused'])
  assert.deepEqual([noTok.type, noTok.why], ['sync:refused', 'no_folder'])
  assert.equal((await git(ROOT, ['ls-remote', remote(of.id)], tok.token)).code !== 0, true)
  // an ordinary folder cannot be bound (only a folder made for an upload)
  const plain = await api(PC.token, '/folders', { method: 'POST', body: { name: '보통 폴더' } })
  const np = await pcLink.ask({ type: 'sync:bind', folderId: plain.id, label: 'x' }, ['sync:bound', 'sync:refused'])
  assert.deepEqual([np.type, np.why], ['sync:refused', 'not_managed'])
  return 'main · 남의 가지 · 지우기 → remote rejected · 토큰 없음 401 · 다른 폴더 403 · 다른 회사 no_folder · 보통 폴더 not_managed'
})

await step('CH-E-04 열쇠처럼 생긴 파일이 든 올리기: 가지는 바로 되돌아가고, sync:refused(경로 · 줄 · 까닭만), main 그대로, 값은 어디에도 없다', async () => {
  const key = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
  const body = key.split('\n')[1]
  await write(work, { 'deploy/서버 열쇠.txt': `운영 서버 접속용\n${key}`, '견적/양식.md': '# 견적 양식 2판\n' })
  await git(work, ['add', '-A'])
  await git(work, ['commit', '-q', '-m', '동기화 · 박챔피언의 맥'])
  const bad = (await git(work, ['rev-parse', 'HEAD'])).out
  const push = await git(work, ['push', '-q', 'origin', `HEAD:refs/heads/${tok.branch}`], tok.token)
  assert.equal(push.code, 0, `git 의 push 자체는 받아들여진다: ${push.err}`)
  const ls = await git(ROOT, ['ls-remote', remote(folder.id), `refs/heads/${tok.branch}`], tok.token)
  assert.equal(ls.out.split(/\s+/)[0], first, '가지는 직전 머리로 되돌아가 있다')
  const no = await pcLink.ask({ type: 'sync:pushed', folderId: folder.id, head: bad, report: { files: 9 } }, ['sync:taken', 'sync:behind', 'sync:refused'])
  assert.deepEqual([no.type, no.why], ['sync:refused', 'secret'])
  assert.deepEqual(no.paths, [{ path: 'deploy/서버 열쇠.txt', line: 2, reason: 'private_key' }])
  assert.equal((await api(PC.token, `/folders/${folder.slug}`)).history[0].sha, first, 'main 그대로')
  assert.ok(!(await api(PC.token, `/folders/${folder.slug}/tree`)).some((f) => f.path.startsWith('deploy/')))
  assert.ok(!JSON.stringify(pcLink.got).includes(body), '답에 값이 없다')
  assert.ok(!serverLog.join('').includes(body), '서버 기록에 값이 없다')
  const [src] = await api(PC.token, `/folders/${folder.slug}/sources`)
  assert.equal(src.why, 'secret')
  // the person leaves it out and uploads again: it goes in
  await git(work, ['rm', '-q', '--cached', 'deploy/서버 열쇠.txt'])
  await git(work, ['commit', '-q', '--amend', '-m', '동기화 · 박챔피언의 맥'])
  const good = (await git(work, ['rev-parse', 'HEAD'])).out
  assert.equal((await git(work, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${tok.branch}`], tok.token)).code, 0)
  const ok = await pcLink.ask({ type: 'sync:pushed', folderId: folder.id, head: good, report: { files: 8 } }, ['sync:taken', 'sync:behind', 'sync:refused'])
  assert.deepEqual([ok.type, ok.main], ['sync:taken', good])
  first = good
  return `거절 경로 deploy/서버 열쇠.txt:2 private_key · 다시 올리니 main ${good.slice(0, 8)}`
})

await step('CH-E-05 구조 · 한도 · 속성: 링크 · gitlink · .gitmodules · 새 커밋 21개 · 50 MB 넘는 파일은 push 직후 되돌아가고 거절, 폴더 자신의 .gitattributes(eol=crlf · union)는 서버의 main 을 바꾸지 못한다', async () => {
  const [{ repo_path: repo }] = await q('select repo_path from pro_folders where id=$1', [folder.id])
  const said = []
  // one round as the desktop makes it (commits on top of the last taken head) → pushed → put back → refused, the clone back where it was
  async function refused(make, why, reason) {
    await git(work, ['reset', '-q', '--hard', first])
    await make()
    const head = (await git(work, ['rev-parse', 'HEAD'])).out
    const push = await git(work, ['push', '-q', '-f', 'origin', `HEAD:refs/heads/${tok.branch}`], tok.token)
    assert.equal(push.code, 0, `${why}: git 의 push 자체는 받아들여진다 — ${push.err}`)
    assert.equal((await git(ROOT, ['ls-remote', remote(folder.id), `refs/heads/${tok.branch}`], tok.token)).out.split(/\s+/)[0], first, `${why}: 가지는 push 직후 되돌아가 있다`)
    const no = await pcLink.ask({ type: 'sync:pushed', folderId: folder.id, head, report: {} }, ['sync:taken', 'sync:behind', 'sync:refused'])
    assert.deepEqual([no.type, no.why], ['sync:refused', why], JSON.stringify(no))
    if (reason) assert.equal(no.paths?.[0]?.reason, reason, JSON.stringify(no))
    assert.equal((await api(PC.token, `/folders/${folder.slug}`)).history[0].sha, first, `${why}: main 그대로`)
    said.push(reason || no.limit?.kind)
    await git(work, ['reset', '-q', '--hard', first])
    return no
  }
  const commit = async (m = '동기화 · 박챔피언의 맥') => { await git(work, ['add', '-A']); await git(work, ['commit', '-q', '-m', m]) }
  await refused(async () => { await fs.mkdir(path.join(work, 'docs'), { recursive: true }); await fs.symlink('/etc/passwd', path.join(work, 'docs', '링크')); await commit() }, 'structure', 'symlink')
  await refused(async () => { await git(work, ['update-index', '--add', '--cacheinfo', `160000,${first},vendor/lib`]); await git(work, ['commit', '-q', '-m', 'gitlink']) }, 'structure', 'submodule')
  await refused(async () => { await write(work, { '.gitmodules': '[submodule "x"]\n\tpath = x\n\turl = https://example.test/x.git\n' }); await commit() }, 'structure', 'gitmodules')
  const many = await refused(async () => { for (let i = 0; i < 21; i++) { await write(work, { [`라운드/${i}.md`]: `${i}\n` }); await commit(`동기화 ${i}`) } }, 'too_big')
  assert.deepEqual(many.limit, { kind: 'commits', value: 21, max: 20 })
  const big = await refused(async () => { await fs.writeFile(path.join(work, '녹화.bin'), Buffer.alloc(50 * 1024 * 1024 + 1)); await commit() }, 'too_big', 'large')
  assert.equal(big.limit.kind, 'file')
  // the folder's own .gitattributes: taken as a file, but the server's checkout of main keeps the pushed bytes (no CRLF)
  await git(work, ['reset', '-q', '--hard', first])
  await write(work, { '.gitattributes': '* text eol=crlf\n*.md merge=union\n', '메모.md': '첫 줄\n둘째 줄\n' })
  await commit()
  const head = (await git(work, ['rev-parse', 'HEAD'])).out
  assert.equal((await git(work, ['push', '-q', 'origin', `HEAD:refs/heads/${tok.branch}`], tok.token)).code, 0)
  const ok = await pcLink.ask({ type: 'sync:pushed', folderId: folder.id, head, report: {} }, ['sync:taken', 'sync:behind', 'sync:refused'])
  assert.deepEqual([ok.type, ok.main], ['sync:taken', head])
  const onDisk = await fs.readFile(path.join(repo, '메모.md'))
  assert.equal(onDisk.includes(13), false, '서버의 main 작업 파일에 CR 이 생기지 않는다')
  assert.match(await fs.readFile(path.join(repo, '.git', 'info', 'attributes'), 'utf8'), /^\* -text -filter -ident -working-tree-encoding !eol !merge$/m)
  first = head
  return `거절: ${said.join(' · ')} · .gitattributes(eol=crlf) 올림 → main ${head.slice(0, 8)}, 작업 파일은 LF 그대로`
})

await step('CH-E-06 동기화 가지는 다른 토큰에 보이지 않고 닿지 않는다 · 클러스터 경로(/api/git)는 데스크톱 토큰을 받지 않는다', async () => {
  const { mintToken } = await import('../lib/folders/gitHttp.js')
  const cluster = mintToken({ tenant: TENANT, folderId: folder.id })
  const clusterUrl = `${BASE}/api/git/${folder.id}.git`
  const seen = await git(ROOT, ['ls-remote', clusterUrl], cluster)
  assert.equal(seen.code, 0, seen.err)
  assert.match(seen.out, /refs\/heads\/main/)
  assert.doesNotMatch(seen.out, /pgpt-agent\/sync-/, '클러스터 토큰에는 동기화 가지가 없다')
  assert.match((await git(ROOT, ['ls-remote', remote(folder.id)], tok.token)).out, new RegExp(tok.branch), '자기 기기의 가지는 보인다')
  // a commit only on the device's (hidden) branch is not handed out by id either — also when the client asks for protocol v2
  await fs.writeFile(path.join(work, 'hidden-only.md'), '가지에만 있는 글\n')
  await git(work, ['add', '-A'])
  await git(work, ['commit', '-q', '-m', '가지에만'])
  const onlyHere = (await git(work, ['rev-parse', 'HEAD'])).out.trim()
  assert.equal((await git(work, ['push', '-q', 'origin', `HEAD:refs/heads/${tok.branch}`], tok.token)).code, 0)
  const probe = path.join(ROOT, 'v2-probe')
  await fs.mkdir(probe, { recursive: true })
  await git(probe, ['init', '-q'])
  for (const v of ['2', '0']) {
    const byId = await git(probe, ['-c', `protocol.version=${v}`, 'fetch', '-q', clusterUrl, onlyHere], cluster)
    assert.notEqual(byId.code, 0, `protocol v${v}: a hidden commit fetched by id`)
  }
  const desk = await git(ROOT, ['ls-remote', clusterUrl], tok.token)
  assert.notEqual(desk.code, 0)
  assert.match(desk.err, /403/)
  const onto = await git(work, ['push', clusterUrl, `HEAD:refs/heads/${tok.branch.replace(/main$/, 'x')}`], cluster)
  assert.notEqual(onto.code, 0)
  assert.match(onto.err, /remote rejected|sync branch/)
  return '클러스터 토큰: main 만 보이고 동기화 가지 없음 · 동기화 가지로 push 거절 · 데스크톱 토큰은 /api/git 에서 403'
})

let kimLink, kimDevice, kimTok
await step('CH-E-07 김동료: 파일이 있는 폴더는 묶지 못하고(not_empty) · 빈 폴더에서는 다른 기기의 가지가 안 보이며 · 그 가지에만 있는 것과 같은 파일도 올라가고 · 보기 권한이 되면 올리기만 막히고 · 기기를 끊으면 다 막힌다', async () => {
  await api(PC.token, `/folders/${folder.slug}/members`, { method: 'POST', body: { type: 'user', id: KIM.id, role: 'editor' } })
  kimDevice = await api(KIM.token, '/local-agents/devices', { method: 'POST', body: { name: '김동료의 PC', platform: 'win32', appVersion: 'e2e' } })
  kimLink = await openLink(kimDevice.token, '김동료의 PC')
  // (until a second computer can join: a folder that already has files is bound only by the computer that first uploaded it)
  const full = await kimLink.ask({ type: 'sync:bind', folderId: folder.id, label: '영업 키트' }, ['sync:bound', 'sync:refused'])
  assert.deepEqual([full.type, full.why], ['sync:refused', 'not_empty'])
  // an empty champion folder both of them bind; 박챔피언's PC pushes to its branch first — her token does not see it
  const two = await api(PC.token, '/folders', { method: 'POST', body: { name: '둘이 쓰는 키트', champion: true } })
  await api(PC.token, `/folders/${two.slug}/members`, { method: 'POST', body: { type: 'user', id: KIM.id, role: 'editor' } })
  assert.equal((await kimLink.ask({ type: 'sync:bind', folderId: two.id, label: '영업 키트' }, ['sync:bound', 'sync:refused'])).type, 'sync:bound')
  assert.equal((await pcLink.ask({ type: 'sync:bind', folderId: two.id, label: '둘이 쓰는 키트' }, ['sync:bound', 'sync:refused'])).type, 'sync:bound')
  const pcTwo = await pcLink.ask({ type: 'sync:token', folderId: two.id }, ['sync:token', 'sync:refused'])
  const pw = path.join(ROOT, 'pc-two')
  assert.equal((await git(ROOT, ['clone', '-q', remote(two.id), pw], pcTwo.token)).code, 0)
  // (a file the two PCs both have — the team's logo: the same bytes, the same object)
  const logo = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${crypto.randomUUID()} --><circle r="4"/></svg>\n`
  await write(pw, { '박챔피언.md': '# 아직 main 이 아님\n', '공용/로고.svg': logo })
  await git(pw, ['add', '-A'])
  await git(pw, ['commit', '-q', '-m', '동기화 · 박챔피언의 맥'])
  assert.equal((await git(pw, ['push', '-q', 'origin', `HEAD:refs/heads/${pcTwo.branch}`], pcTwo.token)).code, 0)
  kimTok = await kimLink.ask({ type: 'sync:token', folderId: two.id }, ['sync:token', 'sync:refused'])
  assert.equal(kimTok.type, 'sync:token')
  const herView = await git(ROOT, ['ls-remote', remote(two.id)], kimTok.token)
  assert.equal(herView.code, 0, herView.err)
  assert.doesNotMatch(herView.out, new RegExp(pcTwo.branch), '다른 기기의 동기화 가지는 보이지 않는다')
  const kw = path.join(ROOT, 'kim')
  assert.equal((await git(ROOT, ['clone', '-q', remote(two.id), kw], kimTok.token)).code, 0)
  // her upload has the same logo as his branch (which she cannot see, not yet in main): she sent it whole — it goes up
  await write(kw, { '공용/로고.svg': logo })
  await git(kw, ['add', '-A'])
  await git(kw, ['commit', '-q', '-m', '동기화 · 김동료의 PC'])
  const same = await git(kw, ['push', '-q', 'origin', `HEAD:refs/heads/${kimTok.branch}`], kimTok.token)
  assert.equal(same.code, 0, `같은 바이트의 파일: ${same.err}`)
  const mine = (await git(kw, ['rev-parse', 'HEAD'])).out
  assert.equal((await git(ROOT, ['ls-remote', remote(two.id), `refs/heads/${kimTok.branch}`], kimTok.token)).out.split(/\s+/)[0], mine, '그녀의 가지에 섰다')
  await write(kw, { '견적/김동료 메모.md': '# 메모\n' })
  await git(kw, ['add', '-A'])
  await git(kw, ['commit', '-q', '-m', '동기화 · 김동료의 PC'])
  await api(PC.token, `/folders/${two.slug}/members`, { method: 'POST', body: { type: 'user', id: KIM.id, role: 'viewer' } })
  const push = await git(kw, ['push', 'origin', `HEAD:refs/heads/${kimTok.branch}`], kimTok.token)
  assert.notEqual(push.code, 0)
  assert.match(push.err, /403|editor/)
  assert.equal((await git(ROOT, ['ls-remote', remote(two.id), 'refs/heads/main'], kimTok.token)).code, 0, '보기 권한으로 받기')
  const t2 = await kimLink.ask({ type: 'sync:token', folderId: two.id }, ['sync:token', 'sync:refused'])
  assert.deepEqual([t2.type, t2.why], ['sync:refused', 'not_editor'])
  // her device revoked on the web: the link goes, the token stops at once
  await api(KIM.token, `/local-agents/devices/${kimDevice.device.id}`, { method: 'DELETE' })
  await waitFor(() => kimLink.closed, 10000, 'her link closed')
  const after = await git(ROOT, ['ls-remote', remote(two.id)], kimTok.token)
  assert.notEqual(after.code, 0)
  assert.match(after.err, /403/)
  return `파일 있는 폴더 → not_empty · 다른 기기의 가지 안 보임 · 그 가지와 같은 파일 push → 0 · 보기 권한 push → 403 · ls-remote 0 · 끊은 기기 → 링크 닫힘(${kimLink.closed}) · 403`
})

await step('CH-E-08 웹에서 원본 PC 를 빼면: 그 PC 가 바로 듣고, 토큰 · sync:token 이 막힌다 · 다시 묶을 수 있다', async () => {
  const [mine] = (await api(PC.token, `/folders/${folder.slug}/sources`)).filter((s) => s.mine)
  assert.equal(await status(KIM.token, `/folders/${folder.slug}/sources/${mine.id}`, { method: 'DELETE' }), 403, '남의 PC 는 못 뺀다')
  const at = pcLink.got.length
  await api(PC.token, `/folders/${folder.slug}/sources/${mine.id}`, { method: 'PATCH', body: { state: 'paused' } })
  assert.equal((await pcLink.next('sync:refused', at)).why, 'paused')
  assert.match((await git(ROOT, ['ls-remote', remote(folder.id)], tok.token)).err, /403/)
  await api(PC.token, `/folders/${folder.slug}/sources/${mine.id}`, { method: 'PATCH', body: { state: 'active' } })
  assert.equal((await git(ROOT, ['ls-remote', remote(folder.id)], tok.token)).code, 0)
  const at2 = pcLink.got.length
  await api(PC.token, `/folders/${folder.slug}/sources/${mine.id}`, { method: 'DELETE' })
  assert.equal((await pcLink.next('sync:refused', at2)).why, 'source_removed')
  assert.match((await git(ROOT, ['ls-remote', remote(folder.id)], tok.token)).err, /403/)
  const t = await pcLink.ask({ type: 'sync:token', folderId: folder.id }, ['sync:token', 'sync:refused'])
  assert.deepEqual([t.type, t.why], ['sync:refused', 'source_removed'])
  assert.deepEqual((await api(PC.token, `/folders/${folder.slug}/sources`)).filter((s) => s.mine), [])
  assert.equal((await pcLink.ask({ type: 'sync:bind', folderId: folder.id, label: '영업 제안 키트' }, ['sync:bound', 'sync:refused'])).type, 'sync:bound')
  const u = await pcLink.ask({ type: 'sync:unbind', folderId: folder.id }, ['sync:unbound'])
  assert.equal(u.folderId, folder.id)
  return '멈춤 → refused paused · 403 · 다시 켬 → 0 · 뺌 → refused source_removed · 403 · 다시 묶기 · 풀기'
})

await step('CH-E-09 올리지 못한 빈 챔피언 폴더는 다시 지워지고, 파일이 있으면 · 남이면 안 지워진다', async () => {
  const empty = await api(PC.token, '/folders', { method: 'POST', body: { name: '취소한 올리기', champion: true } })
  await api(PC.token, `/folders/${empty.slug}/members`, { method: 'POST', body: { type: 'user', id: KIM.id, role: 'editor' } })
  assert.equal(await status(KIM.token, `/folders/${empty.slug}`, { method: 'DELETE' }), 403)
  assert.equal(await status(PC.token, `/folders/${folder.slug}`, { method: 'DELETE' }), 409)
  const plain = (await api(PC.token, '/folders')).find((f) => f.name === '보통 폴더')
  assert.equal(await status(PC.token, `/folders/${plain.slug}`, { method: 'DELETE' }), 400)
  assert.deepEqual(await api(PC.token, `/folders/${empty.slug}`, { method: 'DELETE' }), { ok: true })
  assert.equal(await status(PC.token, `/folders/${empty.slug}`), 404)
  // the folder list carries the asset counts (a card's 「스킬 1 · 명령 1 …」)
  const listed = (await api(PC.token, '/folders')).find((f) => f.slug === folder.slug)
  assert.deepEqual(listed.kit, { skill: 1, command: 1, instructions: 2, rules: 1, spec: 1 })
  return '빈 폴더 지움 · 파일 있음 409 · 보통 폴더 400 · 남 403'
})

await save()
await cleanup()
console.log(`# ${report.length} steps passed`)
