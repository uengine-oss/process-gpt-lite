// An IeumOffice editor host (process-gpt office-host) of a test's own: started from a built checkout of
// uengine-oss/process-gpt-office-host (host/dist/office-host.mjs and dist/web — that repository's README §9) on a
// free port, against the dev stack's Supabase (the page's token is checked with its JWT secret; documents come from
// its Storage), and stopped with the test. Never the office host someone else runs (:5390).
//   RT_OFFICE_HOST_DIR  the checkout (default: this repository's backends/office-host, then ../ieumoffice-web beside it)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPO, freePort, waitFor } from './localStack.js'
import { PGPT_ROOT } from './env.js'

const built = (dir) => !!dir && fs.existsSync(path.join(dir, 'host/dist/office-host.mjs')) && fs.existsSync(path.join(dir, 'dist/web/docs/index.html'))
export const officeHostDir = () => [process.env.RT_OFFICE_HOST_DIR, path.join(REPO, 'backends/office-host'), path.resolve(REPO, '../ieumoffice-web')].find(built) || null

// the dev stack's Supabase keys, from process-gpt's .env (never printed)
function supabaseEnv() {
  const kv = {}
  try {
    for (const line of fs.readFileSync(path.join(PGPT_ROOT, '.env'), 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (m) kv[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  } catch { /* no .env: the host runs without the token check */ }
  return { SUPABASE_URL: process.env.PRO_SUPABASE_URL || 'http://127.0.0.1:54321', SUPABASE_JWT_SECRET: kv.JWT_SECRET || '', SUPABASE_ANON_KEY: kv.ANON_KEY || '', SUPABASE_SERVICE_ROLE_KEY: kv.SERVICE_ROLE_KEY || '' }
}

// env: more for the host (e.g. CUSTOM_LLM_BASE_URL — where the editor's own AI would go)
export async function startOfficeHost({ from = 5395, env: extra = {} } = {}) {
  const dir = officeHostDir()
  if (!dir) throw new Error('office-host checkout with a build not found (RT_OFFICE_HOST_DIR)')
  const port = freePort(from, 5)
  if (!port) throw new Error(`no free port from ${from}`)
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-office-host-'))
  const logs = []
  // the spreadsheet editor's native engine: where the checkout built it (its build script's own target folder, or the toolchain's) — without
  // it a sheet opens empty with 「xlsx-sidecar ENOENT」
  const sidecar = [process.env.XLSX_SIDECAR_PATH, path.join(dir, 'native/xlsx-engine/target/release/xlsx-sidecar'), path.join(dir, '.toolchain/xlsx-target/release/xlsx-sidecar')].find((f) => f && fs.existsSync(f))
  const child = spawn(process.execPath, ['host/dist/office-host.mjs'], {
    cwd: dir,
    env: { ...process.env, ...supabaseEnv(), IEUM_HOST_PORT: String(port), IEUM_HOST_DATA: data, IEUM_LANG: 'ko', IEUM_PUBLIC_URL: `http://127.0.0.1:${port}`,
      CUSTOM_LLM_BASE_URL: '', LLM_PROXY_URL: '', CUSTOM_LLM_API_KEY: '', LLM_PROXY_API_KEY: '', ...(sidecar ? { XLSX_SIDECAR_PATH: sidecar } : {}), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => logs.push(String(d)))
  const url = `http://127.0.0.1:${port}`
  await waitFor(async () => (await fetch(`${url}/healthz`).catch(() => null))?.ok, 60000, 'office host')
  return {
    dir, port, url, logs,
    async stop() {
      child.kill('SIGTERM')
      await new Promise((r) => { if (child.exitCode != null) r(); else { child.once('exit', r); setTimeout(r, 5000) } })
      fs.rmSync(data, { recursive: true, force: true })
    },
  }
}
