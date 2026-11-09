// The AI-DLC team demo (docs/robo-dlc/plan-team.md): a repository with AI-DLC installed linked as a shared
// folder by the team lead, the team as its members, and each person in an AI-DLC role.
//
//   node scripts/aidlc-team-demo.mjs --repo <path> [--api http://127.0.0.1:8798/api] --seed
//   node scripts/aidlc-team-demo.mjs --repo <path> --reset      (unlink, forget roles/waits/decisions, stop the session)
//   node scripts/aidlc-team-demo.mjs --repo <path> --status
//
// Accounts are pro-rdlc-*@uengine.org (demo sign-in code). --reset never touches the repository itself.
import path from 'node:path'
import { q, pool } from '../lib/supa.js'
import { config } from '../config.js'
import * as AS from '../lib/aidlc/session.js'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const API = arg('--api', 'http://127.0.0.1:8798/api')
const REPO = path.resolve(arg('--repo', ''))
const NAME = arg('--name', '팀 할 일 앱')
if (!arg('--repo')) throw new Error('--repo <path> is required')

export const TEAM = [
  { key: 'lead', email: 'pro-rdlc-lead@uengine.org', name: '한지수', role: 'team-lead' },
  { key: 'po', email: 'pro-rdlc-po@uengine.org', name: '오세린', role: 'product' },
  { key: 'arch', email: 'pro-rdlc-arch@uengine.org', name: '최민준', role: 'architect' },
  { key: 'dev', email: 'pro-rdlc-dev@uengine.org', name: '강다은', role: 'developer' },
  { key: 'qa', email: 'pro-rdlc-qa@uengine.org', name: '윤서준', role: 'quality' },
]

async function call(token, method, p, body) {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text(); let j = t; try { j = JSON.parse(t) } catch { /* text */ }
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${String(t).slice(0, 200)}`)
  return j
}
async function signIn(p) {
  const s = await call(null, 'POST', '/auth/email/verify', { email: p.email, code: '000000' })
  await call(s.session.access_token, 'POST', '/profile', { name: p.name, birth: '1990-04-02', onboarded: true }).catch(() => {})
  // the first visit admits the account to the team (lib/team.js ensureMember): rooms and meetings need it
  await call(s.session.access_token, 'GET', '/me').catch(() => {})
  return { ...p, id: s.user.id, token: s.session.access_token }
}

async function folderRow() {
  const [f] = await q('select * from pro_folders where tenant_id=$1 and repo_path=$2', [config.tenantId, REPO])
  return f
}

async function reset() {
  const f = await folderRow()
  if (f) {
    for (const t of ['pro_aidlc_roles', 'pro_aidlc_decisions', 'pro_aidlc_waits', 'pro_aidlc_proposals', 'pro_aidlc_mobs']) await q(`delete from ${t} where tenant_id=$1 and folder_id=$2`, [config.tenantId, f.id])
    await q(`update notifications set is_checked=true where tenant_id=$1 and type='aidlc' and url like $2`, [config.tenantId, `/aidlc/${f.slug}/decide%`])
    await AS.stop(AS.sessionName(config.tenantId, f.slug))
    await q('delete from pro_folder_members where folder_id=$1', [f.id])
    await q('delete from pro_folders where id=$1', [f.id])
  }
  console.log('reset', f ? f.slug : '(not linked)')
}

async function seed() {
  const team = []
  for (const p of TEAM) team.push(await signIn(p))
  const lead = team[0]
  const f = await call(lead.token, 'POST', '/folders/link', { path: REPO, name: NAME })
  for (const p of team.slice(1)) await call(lead.token, 'POST', `/folders/${f.slug}/members`, { type: 'user', id: p.id, role: 'editor' })
  for (const p of team) await call(lead.token, 'PUT', `/aidlc/${f.slug}/roles`, { roleKey: p.role, userIds: [p.id] })
  console.log(JSON.stringify({ folder: f.slug, team: team.map(({ key, name, id, role }) => ({ key, name, id, role })) }))
  return { folder: f, team }
}

async function status() {
  const f = await folderRow()
  if (!f) return console.log('not linked')
  const roles = await q('select role_key, user_id from pro_aidlc_roles where tenant_id=$1 and folder_id=$2', [config.tenantId, f.id])
  const waits = await q('select wait_key, kind, stage, role_key, closed_at from pro_aidlc_waits where tenant_id=$1 and folder_id=$2 order by opened_at', [config.tenantId, f.id])
  const name = AS.sessionName(config.tenantId, f.slug)
  console.log(JSON.stringify({ folder: f.slug, roles: roles.length, waits, session: await AS.has(name), choice: (await AS.has(name)) ? AS.parseChoice(await AS.screen(name)) : null }, null, 1))
}

try {
  if (process.argv.includes('--reset')) await reset()
  if (process.argv.includes('--seed')) await seed()
  if (process.argv.includes('--status')) await status()
} finally { await pool.end().catch(() => {}) }
