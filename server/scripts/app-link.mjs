// A demo address for trying a Lite app in another MCP Apps host (lib/apps/links.js, docs/robo-dlc/plan-mcp-apps.md §6):
//   node scripts/app-link.mjs --app review --email <member> --folder <slug> [--hours 4] --base https://<host> --out <file>
// The address is a credential for that person and folder: it goes to --out (owner-only), never to the terminal.
import fs from 'node:fs'
import { config } from '../config.js'
import { q, pool } from '../lib/supa.js'
import { makeLink } from '../lib/apps/links.js'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const app = arg('app'), email = arg('email'), folder = arg('folder'), out = arg('out')
const hours = Number(arg('hours', 4)), base = String(arg('base', `http://127.0.0.1:${config.port}`)).replace(/\/$/, '')
if (!app || !email || !folder || !out) { console.error('usage: --app <id> --email <member> --folder <slug> --base <url> --out <file> [--hours 4]'); process.exit(2) }
try {
  const [u] = await q(`select u.id::text as id, coalesce(p.name, split_part(u.email, '@', 1)) as name
                       from auth.users u left join pro_profile p on p.user_id = u.id where lower(u.email) = lower($1)`, [email])
  if (!u) throw new Error(`no account ${email}`)
  const [m] = await q(`select 1 from pro_folder_members fm join pro_folders f on f.id = fm.folder_id
                       where f.slug = $1 and fm.principal_type = 'user' and fm.principal_id = $2`, [folder, u.id])
  if (!m) throw new Error(`${email} is not a member of ${folder}`)
  const url = `${base}/api/apps/${app}/mcp/link/${makeLink(config.appsLinkSecret, { app, user: u, folder, hours })}`
  fs.writeFileSync(out, url + '\n', { mode: 0o600 })
  console.log(`written to ${out} — ${app} · ${folder} · ${u.name}, for ${hours} h`)
} catch (e) { console.error(e.message); process.exitCode = 1 } finally { await pool.end().catch(() => {}) }
