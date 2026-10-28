// The English demo tenant (i18n/EN-DEMO.md): http://en.localhost:5180 is tenant en-demo on the same dev
// stack, where the English tutorial screenshots and videos are captured. Only English data lives there:
// the English cast (i18n/GLOSSARY.md), their team and roles, and the English seeds. The Korean demo
// (tenant localhost) is never read or written by this script.
//   node scripts/en-demo.mjs                 set up: tenant row and its MCP list, the cast (English names,
//                                            language en, Jinyoung Jang administrator), team, roles,
//                                            mcp-hub servers and bindings
//   node scripts/en-demo.mjs --seed          set up, then every English seed (travel expense, supplier survey,
//                                            SNS, Moonlight Coffee improvement history, mining cases,
//                                            meeting demo). The meeting seed signs in through the server:
//                                            --api http://en.localhost:8787 (default) — the server needs
//                                            PRO_TENANT_HOSTS (server/.env)
//   node scripts/en-demo.mjs --reset         remove everything the tenant holds (processes, instances, mining,
//                                            folders and their repositories, skills, rooms, meetings, chats,
//                                            mail, schedules, vault items, panels) and set up again; the cast
//                                            accounts stay. --accounts: every account of the tenant goes too.
//                                            Add --seed to seed again in the same run.
//   node scripts/en-demo.mjs --clean         remove the test accounts that signed in there (pro-rt-*, pro-en-ui-*,
//                                            pro-en-fix-*: checker, smoke) — run it after a check, before a capture
//   node scripts/en-demo.mjs --status        what a capture sees there: team, roles, processes, mining, folders,
//                                            skills, and any Hangul left in the tenant's names
process.env.DOTENV_CONFIG_QUIET = 'true'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(here, '..')
const { enterSeedTenant, apiFor } = await import('../lib/seedTenant.js')
const T = enterSeedTenant(['--lang', 'en'])
const { config } = await import('../config.js')
const { q, pool, admin, ensureUser } = await import('../lib/supa.js')
const { ensureTenantRow, forgetTenant, DEFAULT_TENANT } = await import('../lib/tenant.js')
if (T === DEFAULT_TENANT) { console.error('the English demo tenant must not be the default tenant'); process.exit(2) }

const has = (k) => process.argv.includes(k)
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] ?? d : d }
const { PGPT_ROOT: PGPT } = await import('../lib/paths.js')

// the English cast (i18n/GLOSSARY.md); yuna only takes part in the meeting demo (outside the room)
const CAST = {
  jinyoung: { email: 'pro-en-jinyoung@uengine.org', name: 'Jinyoung Jang', admin: true },
  minji: { email: 'pro-en-minji@uengine.org', name: 'Minji Kim' },
  seoyeon: { email: 'pro-en-seoyeon@uengine.org', name: 'Seoyeon Park' },
}
// role owners for every process (Settings › Team & roles), the same as the Korean tutorial tenant's
// 제안팀장 · 디자이너 · 재무 담당 · 제품 책임자 — and the one process-specific role the seeds leave open
const ROLES_ALL = { 'Proposal team lead': 'jinyoung', Designer: 'minji', Finance: 'seoyeon', 'Product owner': 'minji' }
const ROLES_DEF = [['pro_expense_claim', 'Approver', 'jinyoung'], ['pro_supplier_survey', 'Buyer', 'seoyeon']]

async function setup() {
  await ensureTenantRow(T)
  const ids = {}
  for (const [k, p] of Object.entries(CAST)) {
    const u = await ensureUser(p.email, p.name)
    ids[k] = u.id
    await q('update users set username=$2 where id=$1 and tenant_id=$3', [u.id, p.name, T])
    await q(`insert into pro_profile (user_id, name, email, birth, onboarded_at, lang) values ($1,$2,$3,'1988-01-01',now(),'en')
             on conflict (user_id) do update set name=$2, lang='en', onboarded_at=coalesce(pro_profile.onboarded_at, now()), birth=coalesce(pro_profile.birth, '1988-01-01')`, [u.id, p.name, p.email])
    await q('delete from pro_team_removed where tenant_id=$1 and user_id=$2', [T, u.id])
    await q('insert into pro_team_members (tenant_id, user_id, added_by) values ($1,$2,$2) on conflict do nothing', [T, u.id])
  }
  // Jinyoung Jang is the administrator (and the tenant's owner); nobody else among the people is
  await q(`update users set is_admin = (id = $2), role = case when id = $2 then 'admin' else 'user' end where tenant_id=$1 and not coalesce(is_agent,false)`, [T, ids.jinyoung])
  await q('update tenants set owner=$2 where id=$1', [T, ids.jinyoung])
  for (const [role, who] of Object.entries(ROLES_ALL)) {
    await q(`insert into pro_role_assignments (tenant_id, proc_def_id, role, user_id, updated_by) values ($1,'*',$2,$3,$4)
             on conflict (tenant_id, proc_def_id, role) do update set user_id=excluded.user_id, updated_at=now()`, [T, role, ids[who], ids.jinyoung])
  }
  for (const [def, role, who] of ROLES_DEF) {
    await q(`insert into pro_role_assignments (tenant_id, proc_def_id, role, user_id, updated_by) values ($1,$2,$3,$4,$5)
             on conflict (tenant_id, proc_def_id, role) do update set user_id=excluded.user_id, updated_at=now()`, [T, def, role, ids[who], ids.jinyoung])
  }
  // the agents' tools: this server's MCP gateways registered for the tenant in mcp-hub, bound to the cast
  const { syncSystemRegistry } = await import('../lib/systems.js')
  const reg = await syncSystemRegistry().catch((e) => [{ error: e.message }])
  const bad = reg.filter((r) => r.error)
  const { ensureHubBinding } = await import('../mcp/connectors.js')
  for (const id of Object.values(ids)) await ensureHubBinding(id, T)
  console.log(`tenant ${T}: cast ${Object.values(CAST).map((p) => p.name).join(', ')}; roles ${Object.keys(ROLES_ALL).join(', ')}; mcp-hub ${reg.length - bad.length}/${reg.length}${bad.length ? ` (${bad.map((b) => b.connector || '').join(' ')}: ${bad[0].error})` : ''}`)
  return ids
}

function run(file, args = [], env = {}) {
  console.log(`\n$ node ${path.relative(SERVER, file)} ${args.join(' ')}`)
  const r = spawnSync(process.execPath, [file, ...args], { cwd: SERVER, stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.status !== 0) throw new Error(`${path.basename(file)} exited with ${r.status}`)
}

async function seed() {
  const api = apiFor(T, arg('--api', 'http://localhost:8787'))
  run(path.join(SERVER, 'sql/seed-demo-process.mjs'), ['--lang', 'en'])
  run(path.join(SERVER, 'sql/seed-browser-process.mjs'), ['--lang', 'en'])
  run(path.join(SERVER, 'sql/seed-sns-process.mjs'), ['--lang', 'en'])
  run(path.join(SERVER, 'scripts/seed-improve-demo.mjs'), ['--lang', 'en'])
  run(path.join(SERVER, 'scripts/seed-mining-demo.mjs'), ['--lang', 'en'])
  // the meeting demo's seed lives with the meeting recording (docs/demo/meetings/record, dev tree only)
  const meeting = path.join(SERVER, '../docs/demo/meetings/record/seed.mjs')
  if (fs.existsSync(meeting)) run(meeting, ['--lang', 'en'], { API_URL: `${api}/api` })
  else console.log('(no meeting demo seed here: docs/demo/meetings/record/seed.mjs)')
  // the seeds give agents and processes their own roles: keep the cast's every-process roles on top
  await setup()
}

// every row of the tenant, then the people's own rows, then what lives on disk for the tenant
async function reset() {
  // (an account made on the tenant's host belongs to it even before its users row exists: app_metadata)
  const people = (await q(`select u.id::text as id, u.email from users u where u.tenant_id=$1 and not coalesce(u.is_agent,false)
                           union select a.id::text, a.email from auth.users a where a.raw_app_meta_data->>'tenant_id' = $1`, [T]))
  const ids = people.map((p) => p.id)
  // pg_cron jobs of the people's schedules
  for (const s of await q('select job_name from pro_schedules where user_id::text = any($1)', [ids]).catch(() => [])) {
    for (const j of String(s.job_name || '').split(',').filter(Boolean)) await q('select cron.unschedule($1)', [j]).catch(() => {})
  }
  const perUser = ['pro_actions', 'pro_chat_reads', 'pro_demo_mail', 'pro_draft_jobs', 'pro_mail_accounts', 'pro_mail_seen', 'pro_panel_app_prefs',
    'pro_panels', 'pro_schedules', 'pro_vault_audit', 'pro_vault_items', 'pro_vault_keys', 'pro_meeting_participants', 'pro_meeting_segments']
  await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id::text = any($1))', [ids]).catch((e) => console.warn('pro_messages', e.message))
  await q('delete from pro_threads where user_id::text = any($1)', [ids]).catch((e) => console.warn('pro_threads', e.message))
  for (const t of perUser) await q(`delete from ${t} where user_id::text = any($1)`, [ids]).catch((e) => console.warn(t, e.message))
  // folders: their files, members, variations and apps hang off the folder rows
  const folders = (await q('select id from pro_folders where tenant_id=$1', [T])).map((r) => r.id)
  for (const t of ['pro_folder_files', 'pro_folder_members', 'pro_folder_variations', 'pro_folder_integrations', 'pro_skill_verifications', 'pro_panel_app_audit']) {
    const col = t === 'pro_panel_app_audit' ? 'app_id in (select id from pro_panel_apps where folder_id = any($1))' : 'folder_id = any($1)'
    await q(`delete from ${t} where ${col}`, [folders]).catch((e) => console.warn(t, e.message))
  }
  await q('delete from pro_panel_apps where folder_id = any($1)', [folders]).catch((e) => console.warn('pro_panel_apps', e.message))
  // the instances' own rows (events have no tenant)
  const insts = (await q('select proc_inst_id from bpm_proc_inst where tenant_id=$1', [T])).map((r) => r.proc_inst_id)
  await q('delete from events where proc_inst_id = any($1)', [insts]).catch((e) => console.warn('events', e.message))
  await q('delete from pro_dm_members where thread_id in (select id from pro_dm_threads where tenant_id=$1)', [T]).catch(() => {})
  // every table with a tenant_id column (process-gpt's and ours), a few passes for foreign keys
  const tables = (await q(`select c.table_name as t from information_schema.columns c join information_schema.tables x on x.table_schema=c.table_schema and x.table_name=c.table_name
                           where c.table_schema='public' and c.column_name='tenant_id' and x.table_type='BASE TABLE' and c.table_name not in ('tenants','users')
                             and c.table_name not like 'mcp\\_%'`)).map((r) => r.t)
  // (mcp-hub's own tables stay: the servers registered for the tenant are kept, setup syncs them)
  let left = tables
  for (let pass = 0; pass < 4 && left.length; pass++) {
    const failed = []
    for (const t of left) await q(`delete from "${t}" where tenant_id=$1`, [T]).catch((e) => failed.push([t, e.message]))
    left = failed.map(([t]) => t)
    if (pass === 3) for (const [t, m] of failed) console.warn('not cleared:', t, m)
  }
  // agents of the tenant; the people too with --accounts (their sign-in accounts as well)
  await q('delete from users where tenant_id=$1 and coalesce(is_agent,false)', [T])
  if (has('--accounts')) {
    for (const p of people) {
      await q('delete from pro_profile where user_id::text=$1', [p.id]).catch(() => {})
      await q('delete from users where id::text=$1', [p.id]).catch((e) => console.warn('users', e.message))
      await admin.auth.admin.deleteUser(p.id).catch(() => {})
      forgetTenant(p.id)
    }
  }
  // on disk: the tenant's folder repositories, the agents' workspace and the tenant's skills
  const roots = [path.join(config.foldersRoot || path.join(os.homedir(), 'pgpt-folders'), T),
    path.join(PGPT, 'services/deepagents/workspace', T), path.join(PGPT, 'services/deepagents/skills', T)]
  for (const dir of roots) {
    if (!dir.endsWith(`${path.sep}${T}`) || !fs.existsSync(dir)) continue
    fs.rmSync(dir, { recursive: true, force: true })
    console.log('removed', dir)
  }
  console.log(`reset ${T}: ${people.length} ${has('--accounts') ? 'accounts removed' : 'accounts kept'}, ${insts.length} instances, ${folders.length} folders, ${tables.length} tables cleared`)
}

// Test accounts (pro-rt-*, pro-en-ui-*, pro-en-fix-*: the English checker and smoke, e2e) that signed in on
// the tenant: they join the team on sight (and the smoke names itself "Jinyoung Jang"), so after a check run
// they leave again — every row of theirs, the folders they made, their sign-in accounts.
const TEST = '^pro-(rt|en-ui|en-fix)-[a-z0-9-]+@uengine\\.org$'
async function cleanTests() {
  const people = await q(`select u.id::text as id, u.email from users u where u.tenant_id=$1 and u.email ~ $2
                          union select a.id::text, a.email from auth.users a where a.raw_app_meta_data->>'tenant_id' = $1 and a.email ~ $2`, [T, TEST])
  const ids = people.map((p) => p.id)
  if (!ids.length) return console.log(`clean ${T}: no test accounts`)
  for (const s of await q('select job_name from pro_schedules where user_id::text = any($1)', [ids]).catch(() => [])) {
    for (const j of String(s.job_name || '').split(',').filter(Boolean)) await q('select cron.unschedule($1)', [j]).catch(() => {})
  }
  await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id::text = any($1))', [ids]).catch((e) => console.warn('pro_messages', e.message))
  for (const t of ['pro_threads', 'pro_actions', 'pro_chat_reads', 'pro_demo_mail', 'pro_draft_jobs', 'pro_mail_accounts', 'pro_mail_seen', 'pro_panel_app_prefs',
    'pro_panels', 'pro_schedules', 'pro_vault_audit', 'pro_vault_items', 'pro_vault_keys', 'pro_meeting_participants', 'pro_role_assignments', 'pro_team_members', 'pro_team_removed'])
    await q(`delete from ${t} where user_id::text = any($1)`, [ids]).catch((e) => console.warn(t, e.message))
  await q('delete from context_threads where tenant_id=$1 and user_id::text = any($2)', [T, ids]).catch(() => {})
  await q('delete from notifications where tenant_id=$1 and user_id = any($2)', [T, ids]).catch(() => {})
  await q('delete from pro_folder_members where principal_id = any($1)', [ids]).catch(() => {})
  // folders only they made (the checker's): rows and repositories
  const { foldersRoot } = await import('../lib/folders/service.js')
  for (const f of await q('select id, slug from pro_folders where tenant_id=$1 and created_by::text = any($2)', [T, ids])) {
    for (const t of ['pro_folder_files', 'pro_folder_members', 'pro_folder_variations', 'pro_folder_integrations', 'pro_skill_verifications']) await q(`delete from ${t} where folder_id=$1`, [f.id]).catch(() => {})
    await q('delete from pro_panel_apps where folder_id=$1', [f.id]).catch(() => {})
    await q('delete from pro_folders where id=$1', [f.id]).catch((e) => console.warn('folder', f.slug, e.message))
    fs.rmSync(path.join(foldersRoot(), f.slug), { recursive: true, force: true })
  }
  for (const p of people) {
    await q('delete from pro_profile where user_id::text=$1', [p.id]).catch(() => {})
    await q('delete from users where id::text=$1', [p.id]).catch((e) => console.warn('users', p.email, e.message))
    await admin.auth.admin.deleteUser(p.id).catch(() => {})
    forgetTenant(p.id)
  }
  console.log(`clean ${T}: removed ${people.length} test accounts (${people.map((p) => p.email).join(', ')})`)
}

async function status() {
  const one = async (sql) => (await q(sql, [T]).catch((e) => [{ error: e.message }]))
  const out = {
    url: (await import('../lib/tenant.js')).urlOf(T),
    team: (await one(`select u.username as name, u.email, u.is_admin as admin, p.lang from pro_team_members m join users u on u.id=m.user_id and u.tenant_id=m.tenant_id
                      left join pro_profile p on p.user_id=u.id where m.tenant_id=$1 order by m.created_at`)),
    roles: (await one(`select a.proc_def_id as process, a.role, u.username as name from pro_role_assignments a left join users u on u.id=a.user_id and u.tenant_id=a.tenant_id where a.tenant_id=$1 order by 1,2`)),
    processes: (await one(`select id, name, (select count(*)::int from bpm_proc_inst i where i.proc_def_id=d.id and i.tenant_id=d.tenant_id) as instances from proc_def d where tenant_id=$1 and not coalesce(isdeleted,false) order by id`)),
    mining: (await one(`select (select count(*)::int from pro_mining_cases where tenant_id=$1) as cases, (select count(*)::int from handover_events where tenant_id=$1) as steps,
                        (select count(*)::int from pro_mining_suggestions where tenant_id=$1) as suggestions`))[0],
    folders: (await one('select slug, name from pro_folders where tenant_id=$1 order by created_at')),
    rooms: (await one('select name from chat_rooms where tenant_id=$1 and name is not null')).map((r) => r.name),
    agents: (await one('select username from users where tenant_id=$1 and coalesce(is_agent,false) order by 1')).map((r) => r.username),
  }
  // Hangul in what the tenant's screens show as names
  const korean = (await one(`select 'process' as kind, name as text from proc_def where tenant_id=$1 and name ~ '[가-힣]'
     union all select 'step', a->>'name' from proc_def d, jsonb_array_elements(coalesce(d.definition->'activities','[]'::jsonb)) a where d.tenant_id=$1 and a->>'name' ~ '[가-힣]'
     union all select 'role', r->>'name' from proc_def d, jsonb_array_elements(coalesce(d.definition->'roles','[]'::jsonb)) r where d.tenant_id=$1 and r->>'name' ~ '[가-힣]'
     union all select 'person/agent', username from users where tenant_id=$1 and username ~ '[가-힣]'
     union all select 'role owner', role from pro_role_assignments where tenant_id=$1 and role ~ '[가-힣]'
     union all select 'mining step', norm_activity_label from handover_events where tenant_id=$1 and norm_activity_label ~ '[가-힣]'
     union all select 'folder', name from pro_folders where tenant_id=$1 and name ~ '[가-힣]'
     union all select 'room', name from chat_rooms where tenant_id=$1 and name ~ '[가-힣]'
     union all select 'instance', proc_inst_name from bpm_proc_inst where tenant_id=$1 and proc_inst_name ~ '[가-힣]'
     union all select 'work item', activity_name from todolist where tenant_id=$1 and activity_name ~ '[가-힣]'
     union all select 'notification', concat_ws(' · ', title, description) from notifications where tenant_id=$1 and concat(title, description) ~ '[가-힣]'
     union all select 'room message', left(messages->>'content', 80) from chats where tenant_id=$1 and messages->>'content' ~ '[가-힣]'
     union all select 'chat', left(m.content->>'text', 80) from pro_messages m join pro_threads t on t.id=m.thread_id
       join users u on u.id=t.user_id and u.tenant_id=$1 where m.content->>'text' ~ '[가-힣]'`))
  out.korean = [...new Set(korean.map((r) => `${r.kind}: ${r.text}`))]
  console.log(JSON.stringify(out, null, 1))
}

try {
  if (has('--status')) await status()
  else if (has('--clean')) await cleanTests()
  else {
    if (has('--reset')) await reset()
    await setup()
    if (has('--seed')) await seed()
  }
} finally { await pool.end() }
