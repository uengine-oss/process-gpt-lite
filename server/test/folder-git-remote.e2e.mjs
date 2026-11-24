// The real flow across the two services: a Lite BFF serves a shared folder over git smart HTTP, and
// cli-agent's own code (core/worktree.py: prepare, commit) clones it, edits, commits and pushes its branch.
// spec openspec/specs/folder-git-remote
//   node test/folder-git-remote.e2e.mjs
//     CLI_AGENT_DIR     the process-gpt-cli-agent checkout (default: ../../cli-agent-gitremote next to this repo)
//     CLI_AGENT_PYTHON  a Python with nothing but the standard library needed (default: python3)
// It starts its own BFF (PRO_BACKGROUND=0, a free port in 8790–8799, PRO_GIT_URL pointing at itself) in the
// test tenant "gitremote-test" with folders in a temporary directory, and removes what it made. No model.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(here, '..')
const CLI_AGENT = path.resolve(process.env.CLI_AGENT_DIR || path.join(SERVER, '..', '..', 'cli-agent-gitremote'))
const PYTHON = process.env.CLI_AGENT_PYTHON || 'python3'
const AVOID = new Set([8794, 8795, 8796, 8797, 8777, 8787, 8088])
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
const PORT = [8790, 8791, 8792, 8793, 8798, 8799].find((p) => !AVOID.has(p) && portFree(p))
if (!PORT) { console.log('no free port in 8790–8799'); process.exit(1) }
const URL_BASE = `http://127.0.0.1:${PORT}`
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-cross-'))
const ENV = {
  PRO_PORT: String(PORT), PRO_BACKGROUND: '0', PRO_GIT_URL: URL_BASE,
  PRO_TENANT_ID: 'gitremote-test', PRO_TENANT_HOSTS: '', PRO_FOLDERS_ROOT: path.join(ROOT, 'folders'),
  // nothing else of this server may pick up work on the shared database
  PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off',
}
Object.assign(process.env, ENV)
const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const H = await import('../lib/folders/gitHttp.js')

let n = 0
let server
const serverLog = []
const made = []
async function cleanup() {
  for (const f of made) await q('delete from pro_folders where id=$1', [f.id]).catch(() => {})
  if (server && server.exitCode == null) { server.kill('SIGTERM'); await new Promise((r) => server.once('exit', r)) }
  await fs.rm(ROOT, { recursive: true, force: true })
  await pool.end()
}
async function step(name, fn) {
  n++
  try { const said = await fn(); console.log(`ok ${n} - ${name}${said ? `\n  ${said}` : ''}`) } catch (e) {
    console.log(`not ok ${n} - ${name}\n  ${e.message}`)
    console.log('--- server log\n' + serverLog.join(''))
    await cleanup(); process.exit(1)
  }
}
// cli-agent's module, run by its Python, fed JSON on stdin; prints JSON (never the token)
const DRIVER = `
import json, sys
from pathlib import Path
from core import worktree
a = json.load(sys.stdin)
out = {}
s = worktree.settings_from(a["agent_config"])
try:
    tree = worktree.prepare(s, Path(a["workspace"]), a["run_id"])
except worktree.WorktreeError as e:
    print(json.dumps({"prepare_error": str(e)}, ensure_ascii=False)); sys.exit(0)
out["clone"] = str(tree.path); out["branch"] = tree.branch; out["base"] = tree.base; out["remote"] = tree.remote
out["config_has_token"] = s.token in (tree.path / ".git" / "config").read_text()
p = tree.path / a["edit"]["path"]
p.write_text(a["edit"]["text"], encoding="utf-8")
out["commit"] = tree.commit("안내문 다듬기 (" + a["run_id"][:12] + ")")
if a.get("try_main"):
    try:
        worktree._git(tree.path, "push", "--porcelain", "origin", "HEAD:refs/heads/main", env=tree.auth)
        out["main_push"] = "accepted"
    except worktree.WorktreeError as e:
        out["main_push"] = str(e)
print(json.dumps(out, ensure_ascii=False))
`
const runAgent = (input) => new Promise((resolve, reject) => {
  const child = execFile(PYTHON, ['-c', DRIVER], { cwd: CLI_AGENT, env: { ...process.env, PYTHONPATH: CLI_AGENT } }, (err, stdout, stderr) => {
    if (err) return reject(new Error(`${err.message}\n${stderr}`))
    try { resolve(JSON.parse(stdout.trim().split('\n').at(-1))) } catch { reject(new Error(`no JSON from the agent: ${stdout}\n${stderr}`)) }
  })
  child.stdin.end(JSON.stringify(input))
})
const redact = (s, tok) => String(s).split(tok).join('<token>')

console.log(`# folder-git-remote cross test — ${new Date().toISOString()}`)
console.log(`# BFF :${PORT} (PRO_BACKGROUND=0, PRO_GIT_URL=${URL_BASE}), cli-agent ${path.basename(CLI_AGENT)} with ${PYTHON}`)
console.log(`# git ${execFileSync('git', ['--version']).toString().trim().replace('git version ', '')}, node ${process.version}`)

await step('Lite BFF 가 PRO_BACKGROUND=0 으로 뜬다', async () => {
  server = spawn(process.execPath, ['index.js'], { cwd: SERVER, env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => serverLog.push(String(d)))
  server.stderr.on('data', (d) => serverLog.push(String(d)))
  const t0 = Date.now()
  for (;;) {
    const ok = await fetch(`${URL_BASE}/api/config`).then((r) => r.ok).catch(() => false)
    if (ok) break
    if (server.exitCode != null || Date.now() - t0 > 60_000) throw new Error('the BFF did not start')
    await new Promise((r) => setTimeout(r, 500))
  }
  return `ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`
})

const user = { id: crypto.randomUUID(), name: '교차 시험', email: `cross-${Date.now()}@example.test` }
let folder
await step('시험 회사(gitremote-test)에 파일 하나 든 공유 폴더를 만든다', async () => {
  folder = await S.createFolder(user, { name: `세미나 안내 ${Date.now()}` })
  made.push(folder)
  await S.upload(folder, user, '안내문.md', Buffer.from('# 11월 세미나 안내\n초안입니다.\n'))
  return `${folder.slug} (${folder.id}) at ${path.relative(ROOT, folder.repo_path)}`
})

let given
await step('단계가 받는 저장소: stepOne 이 쓰는 그대로(projectRepoFor) — 주소와 토큰', async () => {
  assert.equal(config.gitUrl, URL_BASE)
  given = { ...H.projectRepoFor(folder), base_ref: 'main' }
  assert.equal(given.project_repo, `${URL_BASE}/api/git/${folder.id}.git`)
  const c = H.verifyToken(given.project_repo_token)
  assert.equal(c.folder, folder.id); assert.equal(c.tenant, 'gitremote-test'); assert.equal(c.push, 'pgpt-agent/')
  return `project_repo=${given.project_repo} base_ref=main token=<${given.project_repo_token.length} chars, expires ${new Date(c.exp * 1000).toISOString()}>`
})

let result
const runId = `todo-${crypto.randomUUID()}`
await step('cli-agent 의 prepare()/commit(): 받아서 고치고, 커밋하고, pgpt-agent/… 를 올린다', async () => {
  result = await runAgent({ agent_config: given, workspace: path.join(ROOT, 'cli-agent-ws', 'gitremote-test', runId), run_id: runId,
    edit: { path: '안내문.md', text: '# 11월 세미나 안내\n에이전트가 다듬은 문장입니다.\n' }, try_main: true })
  assert.ok(!result.prepare_error, result.prepare_error)
  assert.equal(result.remote, true)
  assert.equal(result.base, 'origin/main')
  assert.equal(result.config_has_token, false, '토큰이 .git/config 에 남지 않는다')
  assert.equal(result.commit.pushed, true)
  assert.deepEqual(result.commit.files, ['안내문.md'])
  return `branch=${result.branch} commit=${result.commit.commit} (${result.commit.stat}) pushed=${result.commit.pushed}`
})

await step('그 가지가 Lite 폴더 저장소에 있다, main 은 그대로', async () => {
  assert.ok(await G.branchExists(folder.repo_path, result.branch))
  assert.equal((await G.show(folder.repo_path, result.branch, '안내문.md')).toString(), '# 11월 세미나 안내\n에이전트가 다듬은 문장입니다.\n')
  assert.equal((await G.show(folder.repo_path, 'main', '안내문.md')).toString(), '# 11월 세미나 안내\n초안입니다.\n')
  const changes = await G.changes(folder.repo_path, 'main', result.branch)
  assert.deepEqual(changes.map((c) => `${c.change} ${c.path}`), ['M 안내문.md'])
  const mb = await G.mergeBase(folder.repo_path, 'main', result.branch)
  assert.equal(mb, await G.head(folder.repo_path, 'refs/heads/main'))
  return `${result.branch}: ${changes.map((c) => `${c.change} ${c.path} +${c.add}/-${c.del}`).join(', ')}; merge-base = main`
})

await step('같은 토큰으로 main 에 올리면 거절된다(remote rejected)', async () => {
  assert.match(result.main_push, /\[remote rejected\] \(only refs\/heads\/pgpt-agent\/\* may be pushed here\)/)
  return redact(result.main_push.split('\n').find((l) => l.includes('rejected')), given.project_repo_token).trim()
})

await step('기한이 지난 토큰은 401, cli-agent 의 clone 도 실패로 끝난다', async () => {
  const expired = H.mintToken({ folderId: folder.id, hours: -1 })
  const r = await fetch(`${URL_BASE}/api/git/${folder.id}.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${expired}` } })
  assert.equal(r.status, 401)
  assert.match(r.headers.get('www-authenticate') || '', /^Basic realm=/)
  const out = await runAgent({ agent_config: { ...given, project_repo_token: expired }, workspace: path.join(ROOT, 'cli-agent-ws', 'gitremote-test', 'expired-run'), run_id: 'expired-run',
    edit: { path: 'x.md', text: 'x' } })
  assert.match(out.prepare_error || '', /could not clone .*the server refused the token \(HTTP 401/)
  assert.ok(!(out.prepare_error || '').includes(expired), '오류에 토큰이 없다')
  return `HTTP ${r.status} WWW-Authenticate: ${r.headers.get('www-authenticate')}; agent: ${out.prepare_error.split(' — ')[0]}`
})

await step('서버 기록: 올린 가지와 거절한 가지', async () => {
  const lines = serverLog.join('').split('\n').filter((l) => l.startsWith('[folders git]'))
  assert.ok(lines.some((l) => l.includes(`pushed ${result.branch}`)), lines.join('\n'))
  assert.ok(lines.some((l) => l.includes('push refused: refs/heads/main')), lines.join('\n'))
  return lines.join('\n  ')
})

await cleanup()
console.log(`1..${n}`)
