// A stack of its own for the local CLI agent tests (spec openspec/specs/local-agents): a Lite BFF (PRO_BACKGROUND=0, its own tenant,
// folders in a temporary directory, no model) and Vite in front of it, on free ports; people signed in through the API; one process
// instance whose steps name local agents, made directly in the database (as the engine would); the fake `claude` · `codex`
// (desktop/test/fixtures/fake-cli.js) in a folder of their own. Everything it made goes in stop().
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(here, '../..')
export const DESKTOP = path.join(REPO, 'desktop')
export const SERVER = path.join(REPO, 'server')
export const SHOTS = path.join(REPO, 'openspec/specs/local-agents/e2e/results')
export const desktopRequire = createRequire(path.join(DESKTOP, 'package.json'))
const pg = createRequire(path.join(SERVER, 'package.json'))('pg')
// ports other work on this machine uses
const AVOID = new Set([5199, 5195, 8795, 8777, 8794, 8796, 8797, 27790, 8088, 8787, 8798, 5180])
const portFree = (p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return false } catch { return true } }
export const freePort = (from, n = 30) => Array.from({ length: n }, (_, i) => from + i).find((p) => !AVOID.has(p) && portFree(p))
export const waitFor = async (fn, ms = 40000, what = '') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 250)) } }

export async function startStack({ tenant, apiFrom = 8831, webFrom = 5231 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pgl-${tenant}-`))
  const apiPort = freePort(apiFrom)
  const webPort = freePort(webFrom)
  const logs = []
  const env = { ...process.env, PRO_PORT: String(apiPort), PRO_BACKGROUND: '0', PRO_ONTOLOGY_WORKER: '0', PRO_SCENARIOS: 'off', PRO_TENANT_ID: tenant, PRO_TENANT_HOSTS: '',
    PRO_FOLDERS_ROOT: path.join(root, 'folders'), PRO_LOCAL_AGENT_TICK_MS: '500', PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_PUBLIC_URL: `http://127.0.0.1:${webPort}` }
  const bff = spawn(process.execPath, ['index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [bff.stdout, bff.stderr]) s.on('data', (d) => logs.push(`[bff] ${d}`))
  const vite = spawn(process.execPath, [path.join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(webPort), '--strictPort', '--host', '127.0.0.1'],
    { cwd: REPO, env: { ...process.env, PRO_API_TARGET: `http://127.0.0.1:${apiPort}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const s of [vite.stdout, vite.stderr]) s.on('data', (d) => logs.push(`[vite] ${d}`))
  const api = async (token, p, { method = 'GET', body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${apiPort}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const t = await r.text()
    if (!r.ok) throw Object.assign(new Error(`${method} ${p} → ${r.status} ${t.slice(0, 200)}`), { status: r.status })
    return JSON.parse(t)
  }
  await waitFor(async () => (await fetch(`http://127.0.0.1:${apiPort}/api/config`).catch(() => null))?.ok, 60000, 'BFF')
  await waitFor(async () => (await fetch(`http://127.0.0.1:${webPort}/chat`).catch(() => null))?.ok, 60000, 'Vite')
  const { config } = await import(path.join(SERVER, 'config.js'))
  const db = new pg.Pool({ ...config.db, max: 3 })
  const q = async (sql, params = []) => (await db.query(sql, params)).rows
  const { fakeBin } = desktopRequire('./test/helpers/fakeBin.js')
  const bin = fakeBin(path.join(root, 'bin'))
  const fakeEnv = { FAKE_CLI_HOME: path.join(root, 'fake-home'), FAKE_CLI_LOG: path.join(root, 'fake.log') }
  // the CLIs' own config folders for the test (the runner marks its folders trusted there — never in the person's ~/.claude.json)
  const cliEnv = { CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'), CODEX_HOME: path.join(root, 'codex-home') }
  fs.mkdirSync(cliEnv.CLAUDE_CONFIG_DIR, { recursive: true })
  const stack = {
    tenant, root, apiPort, webPort, web: `http://127.0.0.1:${webPort}`, api, q, logs, bin, fakeEnv, cliEnv,
    // a person: signed in (the demo login code), onboarded; session is what the page keeps in localStorage
    async person(email, name) {
      const r = await api(null, '/auth/email/verify', { method: 'POST', body: { email, code: '000000' } })
      await api(r.session.access_token, '/profile', { method: 'POST', body: { name, birth: '1990-01-01', onboarded: true } })
      return { id: r.user.id, email, name, token: r.session.access_token, session: r }
    },
    // one instance (its definition's activities carry the fake CLI's directives) → {def, inst, step(act, person, local)}
    async instance(name, acts, participants, { owner = null } = {}) {
      const def = `la_${tenant.replace(/[^a-z]/g, '')}_${crypto.randomBytes(3).toString('hex')}`
      const inst = `${def}.${crypto.randomUUID()}`
      await q(`insert into proc_def (id, name, definition, tenant_id, owner) values ($1,$2,$3,$4,$5)`, [def, name, { activities: acts }, tenant, owner])
      await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, tenant_id, participants) values ($1,$2,$3,'RUNNING',$4,$5)`, [inst, name, def, tenant, participants.map((p) => p.id)])
      return {
        def, inst,
        async step(act, who, local) {
          const [t] = await q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, proc_def_id, activity_id, activity_name, status, agent_mode, agent_orch, agent_config, start_date)
                               values (gen_random_uuid(), $1, $2, $3, $3, $4, $5, $6, 'IN_PROGRESS', 'COMPLETE', 'pgpt-pro-local', $7, now()) returning id::text as id`,
          [tenant, who.id, inst, def, act.id, act.name, { local }])
          return t.id
        },
      }
    },
    // a company skill as the server keeps it: its folder (kind skill, a git repository under the BFF's folders) with SKILL.md on main
    async skill(name, md) {
      const slug = `skill-${crypto.randomBytes(4).toString('hex')}`
      const dir = path.join(root, 'folders', tenant, slug)
      fs.mkdirSync(dir, { recursive: true })
      const g = (...a) => execFileSync('git', ['-c', 'user.name=skill', '-c', 'user.email=skill@example.test', ...a], { cwd: dir, stdio: 'pipe' })
      g('init', '-q', '-b', 'main')
      fs.writeFileSync(path.join(dir, 'SKILL.md'), md)
      g('add', '-A'); g('commit', '-qm', name)
      const [f] = await q(`insert into pro_folders (tenant_id, slug, name, description, kind, repo_path, settings) values ($1,$2,$3,'','skill',$4,$5) returning *`,
        [tenant, slug, `${name} 스킬`, dir, { skill_name: name }])
      return f
    },
    // who signs in to Lite joins its team (GET /api/me)
    join: (who) => api(who.token, '/me'),
    jobOf: async (todo) => (await q('select * from pro_local_jobs where todo_id=$1', [todo]))[0],
    settled: (todo, ms = 60000) => waitFor(async () => { const j = (await q('select * from pro_local_jobs where todo_id=$1', [todo]))[0]; return j && ['done', 'failed', 'delegated'].includes(j.state) ? j : null }, ms, `job of ${todo}`),
    // a person's PC: the desktop app's own runner (the fake CLIs first on its path), paired with a device token of theirs
    async pc(who, { name, log = [] } = {}) {
      const dev = await api(who.token, '/local-agents/devices', { method: 'POST', body: { name, platform: 'darwin', appVersion: 'e2e' } })
      Object.assign(process.env, fakeEnv)
      const { createLocalRunner } = desktopRequire('./src/runner/index.js')
      const r = createLocalRunner({ server: `http://127.0.0.1:${apiPort}`, token: dev.token, dataDir: path.join(root, `pc-${who.id.slice(0, 8)}`), device: { name },
        prefs: () => ({ enabled: true, ask: false }), searchPath: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, log: (s) => log.push(s), sessionEnv: cliEnv, settleMs: 800 })
      await r.start()
      await waitFor(() => r.status().connected, 15000, `${name} linked`)
      r.log = log
      return r
    },
    async stop() {
      bff.kill('SIGTERM'); vite.kill('SIGTERM')
      for (const t of ['todolist', 'bpm_proc_inst', 'proc_def', 'pro_local_jobs', 'pro_local_devices', 'pro_folders']) await q(`delete from ${t} where tenant_id=$1`, [tenant]).catch(() => {})
      await db.end().catch(() => {})
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
  return stack
}
