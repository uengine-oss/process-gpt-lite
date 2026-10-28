// Where the stack under test lives. Defaults are the dev stack (Vite :5180 → BFF :8787).
// Against the install/ Docker Compose bundle: PGPT_URL=http://localhost:18080 (nginx serves the
// SPA and proxies /api, /office, /craft), API_URL defaults to the same origin there.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const env = process.env

export const PGPT_URL = (env.PGPT_URL || 'http://localhost:5180').replace(/\/$/, '')
export const API_URL = (env.API_URL || (env.PGPT_URL ? PGPT_URL : 'http://localhost:8787')).replace(/\/$/, '')
// MCP endpoints (/mcp/*) live on the BFF itself; nginx/vite do not proxy them
export const MCP_URL = (env.MCP_URL || API_URL).replace(/\/$/, '')
export const TENANT = env.PGPT_TENANT || 'localhost'
// one id per test run (set once in playwright.config.js, inherited by the workers)
export const RUN = env.RT_RUN || Date.now().toString(36)
export const isLocal = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/.test(u)
export const LOCAL_API = isLocal(API_URL)
// demo login code (PRO_DEMO_LOGIN on the server); with it off, codes are read from mailpit
export const LOGIN_CODE = env.PGPT_LOGIN_CODE || '000000'
export const MAILPIT_URL = env.MAILPIT_URL || ''

// the pgpt-pro source tree next to this folder (feature tests that build fixed data in-process)
export const SERVER_DIR = env.PGPT_SERVER_DIR || path.resolve(here, '../../server')
export const hasServerSource = () => fs.existsSync(path.join(SERVER_DIR, 'lib/panelApps/service.js')) && fs.existsSync(path.join(SERVER_DIR, 'node_modules'))

// the process-gpt checkout whose .env holds the keys (like server/config.js): $PGPT_ROOT, this
// repository's backends/process-gpt, or ~/process-gpt
const PGPT_ROOT_DIR = env.PGPT_ROOT || [path.resolve(here, '../../backends/process-gpt'), path.join(os.homedir(), 'process-gpt')].find((d) => fs.existsSync(path.join(d, '.env'))) || path.join(os.homedir(), 'process-gpt')

// database (seeding and cleanup). PGPT_DB_URL wins; otherwise the dev stack's supabase-db from
// process-gpt/.env (POSTGRES_PASSWORD), the same way server/config.js finds it.
function dbUrlFromProcessGpt() {
  const root = PGPT_ROOT_DIR
  try {
    const txt = fs.readFileSync(path.join(root, '.env'), 'utf8')
    const pw = /^POSTGRES_PASSWORD=(.*)$/m.exec(txt)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
    if (!pw) return ''
    return `postgres://postgres:${encodeURIComponent(pw)}@127.0.0.1:${env.PRO_DB_PORT || 54322}/postgres`
  } catch { return '' }
}
export const DB_URL = env.PGPT_DB_URL || (LOCAL_API ? dbUrlFromProcessGpt() : '')

// test accounts: always pro-rt-<area>@uengine.org (never a real person's account)
export const email = (area) => `pro-rt-${area}@uengine.org`
// pro-en-ui-*: the English-mode checks (tests/smoke/english.spec.js, scripts/i18n-check.mjs);
// pro-en-fix-*: the English-mode polish checks (tests/feature/english-fixes.spec.js)
export const isTestEmail = (e) => /^pro-(rt|en-ui|en-fix)-[a-z0-9-]+@uengine\.org$/.test(e)

// deepagents' workspace on the host (where skill-creator leaves drafts): /workspace/... maps here
export const PGPT_ROOT = PGPT_ROOT_DIR
export const WORKSPACE = env.PGPT_WORKSPACE || path.join(PGPT_ROOT, 'services/deepagents/workspace', TENANT)
export const SKILLS_DIR = env.PGPT_SKILLS_DIR || path.join(PGPT_ROOT, 'services/deepagents/skills', TENANT, 'local')
