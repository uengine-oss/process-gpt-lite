// The process-ontology demo tenant (ax-demo, Korean): a small interior design & build firm (설계 · 시공) whose
// processes are learned from 장진영's mailbox (scripts/fixtures/ax-demo-mailbox.json, made by
// scripts/gen-ax-demo-mailbox.mjs) and from the handovers its people made in chat (handover_events).
// Only this tenant's rows are written; the cast signs in with the app's code login.
//   node scripts/ax-demo.mjs                 set up: tenant row (and its MCP list), the cast (장진영 제안팀장 ·
//                                            administrator · owner, 이도윤 영업, 김민지 디자이너, 박서연 재무 담당,
//                                            language ko), the team, every-process roles, mcp-hub bindings
//   node scripts/ax-demo.mjs --clean-runs    remove what a scenario run left (cases, practice mails, their handovers, cards,
//                                            the engine's snapshot instances, case threads, home action cards)
//   node scripts/ax-demo.mjs --seed          set up, then the chat handovers of the fixture (chat_handovers →
//                                            handover_events, case ids chat:ax-demo:NNNN); generates the fixture
//                                            first when it is missing. Run again: the same rows again.
//   node scripts/ax-demo.mjs --reset         remove the tenant's demo rows: handover_events, the cast's conversations, and — when those
//                                            tables exist — pro_mail_history, pro_onto_jobs, pro_onto_labels,
//                                            pro_po_cases; then lib/ontology/reset.js resetTenant('ax-demo') when
//                                            it exists. The cast accounts stay (--accounts: they go too).
//                                            Add --seed to set up and seed again in the same run.
//   node scripts/ax-demo.mjs --status        tenant, cast and ids, roles, handover counts, the ontology tables
// The server serves the tenant on its own host when server/.env lists it: PRO_TENANT_HOSTS=…,ax.localhost=ax-demo
// (http://ax.localhost:5180). Without that this script still runs (it adds the host for itself only).
process.env.DOTENV_CONFIG_QUIET = 'true'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(here, '..')
const FIXTURE = path.join(here, 'fixtures/ax-demo-mailbox.json')
const T = 'ax-demo'
const HOST = process.env.PRO_AX_DEMO_HOST || 'ax.localhost'

// the tenant must be one this process serves (lib/tenant.js reads the host list once, when it loads)
const { config } = await import('../config.js')
const listed = String(config.tenantHosts || '').split(',').some((s) => s.split('=')[1]?.trim() === T)
if (!listed && !config.tenantFromHeader) {
  config.tenantHosts = [config.tenantHosts, `${HOST}=${T}`].filter(Boolean).join(',')
  console.log(`(PRO_TENANT_HOSTS has no ${T}: added ${HOST}=${T} for this run only — the server needs it in server/.env to serve the tenant)`)
}
const { enterSeedTenant } = await import('../lib/seedTenant.js')
enterSeedTenant(['--tenant', T])
const { q, pool, admin, ensureUser } = await import('../lib/supa.js')
const { ensureTenantRow, forgetTenant, DEFAULT_TENANT } = await import('../lib/tenant.js')
if (T === DEFAULT_TENANT) { console.error('the ontology demo tenant must not be the default tenant'); process.exit(2) }

const has = (k) => process.argv.includes(k)

const CAST = {
  jinyoung: { email: 'pro-ax-jinyoung@uengine.org', name: '장진영', role: '제안팀장', admin: true },
  doyun: { email: 'pro-ax-doyun@uengine.org', name: '이도윤', role: '영업' },
  minji: { email: 'pro-ax-minji@uengine.org', name: '김민지', role: '디자이너' },
  seoyeon: { email: 'pro-ax-seoyeon@uengine.org', name: '박서연', role: '재무 담당' },
  // 영업 is several people (design-v0.3: the same goal reached in different ways); 정하나 joined lately and has no habit yet
  yuna: { email: 'pro-ax-yuna@uengine.org', name: '최유나', role: '영업' },
  jiho: { email: 'pro-ax-jiho@uengine.org', name: '한지호', role: '영업' },
  hana: { email: 'pro-ax-hana@uengine.org', name: '정하나', role: '영업' },
}
// the practice habits (후행 습관, pro_followups): after a quote sheet three of 영업 put the company seal on it, each in their own
// words; one-person habits elsewhere stay off the company map at the default setting (같은 역할 3명)
const HABITS = [
  { who: 'doyun', cls: 'sheet', action: '견적서 마지막 장 오른쪽 아래에 회사 직인 이미지 넣어 줘', ask: '견적서에 회사 직인을 넣어 드릴까요?', seen: 3, accepted: 2 },
  { who: 'yuna', cls: 'sheet', action: '견적서 공급자 칸 옆에 대표 직인 넣어 줘', ask: '견적서 공급자 칸에 직인을 넣어 드릴까요?', seen: 2, accepted: 1 },
  { who: 'jiho', cls: 'sheet', action: '견적서 합계 아래에 회사 직인 이미지 넣어 줘', ask: '견적서 합계 아래에 회사 직인을 넣어 드릴까요?', seen: 4, accepted: 3, declined: 1 },
  { who: 'doyun', cls: 'sheet', action: '견적서를 PDF로도 저장해 줘', ask: '견적서를 PDF로도 저장해 드릴까요?', seen: 2, accepted: 1 },
  { who: 'minji', cls: 'doc', action: '제안서 표지에 대외비 넣어 줘', ask: '제안서 표지에 대외비를 넣어 드릴까요?', seen: 2, accepted: 1 },
  { who: 'seoyeon', cls: 'sheet', action: '검토한 견적서 맨 아래에 재무 검토 날짜 적어 줘', ask: '견적서 맨 아래에 재무 검토 날짜를 적어 드릴까요?', seen: 2, accepted: 1 },
]
// role owners for every process (Settings › Team & roles)
const ROLES_ALL = { 제안팀장: 'jinyoung', 영업: 'doyun', 디자이너: 'minji', '재무 담당': 'seoyeon' }
// tables of the process-ontology feature that may not exist yet; children first
const ONTO_TABLES = ['pro_onto_labels', 'pro_onto_jobs', 'pro_po_cases', 'pro_mail_history', 'pro_mail_archive', 'pro_mail_reads', 'pro_case_links']
const SEED_REASON = 'ax-demo seed'
const CASE_PREFIX = `chat:${T}:`

async function setup() {
  await ensureTenantRow(T)
  const ids = {}
  for (const [k, p] of Object.entries(CAST)) {
    const u = await ensureUser(p.email, p.name)
    ids[k] = u.id
    await q('update users set username=$2 where id=$1 and tenant_id=$3', [u.id, p.name, T])
    await q(`insert into pro_profile (user_id, name, email, birth, onboarded_at, lang) values ($1,$2,$3,'1988-01-01',now(),'ko')
             on conflict (user_id) do update set name=$2, lang='ko', onboarded_at=coalesce(pro_profile.onboarded_at, now()), birth=coalesce(pro_profile.birth, '1988-01-01')`, [u.id, p.name, p.email])
    await q('delete from pro_team_removed where tenant_id=$1 and user_id=$2', [T, u.id])
    await q('insert into pro_team_members (tenant_id, user_id, added_by) values ($1,$2,$2) on conflict do nothing', [T, u.id])
  }
  // 장진영 is the administrator and the tenant's owner; nobody else among the people is
  await q(`update users set is_admin = (id = $2), role = case when id = $2 then 'admin' else 'user' end where tenant_id=$1 and not coalesce(is_agent,false)`, [T, ids.jinyoung])
  await q('update tenants set owner=$2 where id=$1', [T, ids.jinyoung])
  for (const [role, who] of Object.entries(ROLES_ALL)) {
    await q(`insert into pro_role_assignments (tenant_id, proc_def_id, role, user_id, updated_by) values ($1,'*',$2,$3,$4)
             on conflict (tenant_id, proc_def_id, role) do update set user_id=excluded.user_id, updated_at=now()`, [T, role, ids[who], ids.jinyoung])
  }
  // role members (several per role): what the company map counts habits by
  for (const [k, p] of Object.entries(CAST)) {
    await q(`insert into pro_role_members (tenant_id, role, user_id, added_by) values ($1,$2,$3,$4) on conflict do nothing`, [T, p.role, ids[k], ids.jinyoung]).catch((e) => console.warn('members', e.message))
  }
  // the agents' tools: this server's MCP gateways registered in mcp-hub, bound to the cast (best effort)
  let hub = 'skipped'
  try {
    const { syncSystemRegistry } = await import('../lib/systems.js')
    const reg = await syncSystemRegistry().catch((e) => [{ error: e.message }])
    const bad = reg.filter((r) => r.error)
    const { ensureHubBinding } = await import('../mcp/connectors.js')
    for (const id of Object.values(ids)) await ensureHubBinding(id, T)
    hub = `${reg.length - bad.length}/${reg.length}${bad.length ? ` (${bad.map((b) => b.connector || '').join(' ').trim()}: ${bad[0].error})` : ''}`
  } catch (e) { hub = `not bound (${e.message})` }
  console.log(`tenant ${T}: cast ${Object.values(CAST).map((p) => `${p.name}(${p.role})`).join(', ')}; roles ${Object.keys(ROLES_ALL).join(', ')}; mcp-hub ${hub}`)
  for (const [k, p] of Object.entries(CAST)) console.log(`  ${p.name}  ${p.email}  ${ids[k]}`)
  return ids
}

function fixture() {
  if (!fs.existsSync(FIXTURE)) {
    const r = spawnSync(process.execPath, [path.join(here, 'gen-ax-demo-mailbox.mjs')], { cwd: SERVER, stdio: 'inherit' })
    if (r.status !== 0) throw new Error('gen-ax-demo-mailbox.mjs failed')
  }
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
}

// the chat handovers of the fixture as handover_events rows: the people's raw words in activity_label,
// nothing normalized (norm_activity_label stays NULL for the reader to fill)
async function seedHabits(ids) {
  const people = Object.values(ids)
  await q('delete from pro_habit_shares where tenant_id=$1 and user_id = any($2::uuid[])', [T, people]).catch(() => {})
  await q('delete from pro_followups where tenant_id=$1 and user_id = any($2::uuid[])', [T, people])
  for (const h of HABITS) {
    await q(`insert into pro_followups (tenant_id, user_id, event_cls, action, ask, origin, seen, accepted, declined, last_seen_at) values ($1,$2,$3,$4,$5,'observed',$6,$7,$8, now() - interval '3 days')`,
      [T, ids[h.who], h.cls, h.action, h.ask, h.seen, h.accepted || 0, h.declined || 0])
  }
  return HABITS.length
}

async function seed(ids) {
  const fx = fixture()
  const byEmail = Object.fromEntries(Object.entries(CAST).map(([k, p]) => [p.email, { id: ids[k], name: p.name, role: p.role }]))
  const agents = Object.fromEntries((fx.truth?.agents || []).map((a) => [a.id, a]))
  const short = (who) => (byEmail[who] ? who.replace(/^pro-ax-|@.*$/g, '') : who)
  const rows = fx.chat_handovers || []
  // a chat handover about a mail's work is recorded under that mail's case, as Lite's recorder does (mining/recorder.js
  // caseOf: one case per customer mail) — here the mail thread, the case id the mail-history reader gives it
  const threadOf = Object.fromEntries((fx.truth?.chat_cases || []).filter((c) => c.thread).map((c) => [c.case_id, c.thread]))
  const caseOf = (r) => (threadOf[r.case_id] ? `mail:${T}:${threadOf[r.case_id]}` : r.case_id)
  const client = await pool.connect()
  try {
    await client.query('begin')
    const del = await client.query('delete from handover_events where tenant_id=$1 and (case_id like $2 or reason=$3)', [T, `${CASE_PREFIX}%`, SEED_REASON])
    for (const r of rows) {
      const from = byEmail[r.from]
      const to = r.to_is_agent ? { id: r.to, name: agents[r.to]?.name || r.to_name || r.to, role: null } : byEmail[r.to]
      if (!from || !to) throw new Error(`${r.case_id}#${r.seq}: unknown person ${!from ? r.from : r.to}`)
      const room = `dm:${T}:${[short(r.from), short(r.to)].sort().join('-')}`
      await client.query(`insert into handover_events (tenant_id, case_id, origin_room_id, source, is_explicit, from_room_id, to_room_id,
          from_user_id, from_user_name, from_role, from_is_agent, to_user_id, to_user_name, to_role, to_is_agent, agent_orch,
          activity_label, next_activity_label, norm_activity_label, instruction, reason, artifact_refs, participant_agents,
          occurred_at, returned_at, handover_latency_sec)
        values ($1,$2,$2,$3,$4,$5,$5,$6,$7,$8,false,$9,$10,$11,$12,$13,$14,null,null,null,$15,$16,$17,$18,$19,$20)`, [
        T, caseOf(r), r.source, r.is_explicit, room, String(from.id), from.name, from.role, String(to.id), to.name, to.role, !!r.to_is_agent,
        r.to_is_agent ? 'deepagents' : null, r.text, SEED_REASON,
        JSON.stringify((r.artifacts || []).map((name) => ({ type: 'file', name }))), JSON.stringify(r.to_is_agent ? [r.to] : []),
        r.at, r.returned_at || null, r.latency_sec])
    }
    await client.query('commit')
    const cases = new Set(rows.map((r) => caseOf(r))).size
    console.log(`seeded ${rows.length} chat handovers in ${cases} cases (${del.rowCount} earlier rows replaced); mailbox fixture: ${fx.mails.length} mails, ${fx.truth.cases.length} cases`)
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally { client.release() }
}

async function tableInfo(t) {
  const [r] = await q(`select to_regclass('public.' || $1) is not null as present,
                              exists (select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='tenant_id') as tenanted`, [t])
  return r
}

async function reset() {
  const out = {}
  out.handover_events = (await q('delete from handover_events where tenant_id=$1 returning 1', [T])).length
  // v0.3: the habit setting, role members and shared ways of this demo tenant
  for (const t of ['pro_onto_settings', 'pro_role_members', 'pro_habit_shares']) await q(`delete from ${t} where tenant_id=$1`, [T]).catch(() => {})
  // the cast's conversations: an earlier run's cards (map summaries, start cards, the mail triage of a connect) and its
  // case threads would show in the next run's chat, and a kept agent conversation remembers the last run's files
  const castIds = (await q('select id::text as id from users where tenant_id=$1 and email = any($2)', [T, Object.values(CAST).map((p) => p.email)])).map((r) => r.id)
  if (castIds.length) {
    out.messages = (await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id::text = any($1)) returning 1', [castIds])).length
    await q(`delete from pro_threads where user_id::text = any($1) and kind <> 'chat'`, [castIds]).catch((e) => console.warn('threads', e.message))
    await q('update pro_threads set conversation_id=null where user_id::text = any($1)', [castIds]).catch((e) => console.warn('threads', e.message))
    await q('delete from pro_actions where user_id::text = any($1)', [castIds]).catch((e) => console.warn('actions', e.message))
    // the practice mails an earlier run sent (they would arrive again, and land in the mail archive, on the next connect)
    out.demo_mails = (await q('delete from pro_demo_mail where user_id::text = any($1) returning 1', [castIds]).catch(() => [])).length
    await q('delete from pro_mail_seen where user_id::text = any($1)', [castIds]).catch(() => {})
  }
  // a few passes in case the feature's tables refer to each other
  let left = [...ONTO_TABLES]
  for (let pass = 0; pass < 3 && left.length; pass++) {
    const failed = []
    for (const t of left) {
      const info = await tableInfo(t)
      if (!info.present) { out[t] = 'absent'; continue }
      if (!info.tenanted) { out[t] = 'no tenant_id column (left as is)'; continue }
      try { out[t] = (await q(`delete from "${t}" where tenant_id=$1 returning 1`, [T])).length } catch (e) { failed.push(t); out[t] = `not cleared: ${e.message}` }
    }
    left = failed
  }
  if (has('--accounts')) {
    const people = await q(`select id::text as id, email from users where tenant_id=$1 and email = any($2)
                            union select id::text, email from auth.users where email = any($2)`, [T, Object.values(CAST).map((p) => p.email)])
    for (const p of people) {
      for (const sql of ['delete from pro_role_assignments where tenant_id=$2 and user_id::text=$1', 'delete from pro_team_members where tenant_id=$2 and user_id::text=$1',
        'delete from pro_team_removed where tenant_id=$2 and user_id::text=$1']) await q(sql, [p.id, T]).catch((e) => console.warn(sql.split(' ')[2], e.message))
      await q('delete from pro_profile where user_id::text=$1', [p.id]).catch(() => {})
      await q('delete from users where id::text=$1', [p.id]).catch((e) => console.warn('users', p.email, e.message))
      await admin.auth.admin.deleteUser(p.id).catch(() => {})
      forgetTenant(p.id)
    }
    out.accounts = `${new Set(people.map((p) => p.email)).size} removed`
  } else out.accounts = 'kept'
  const ontoReset = path.join(SERVER, 'lib/ontology/reset.js')
  if (fs.existsSync(ontoReset)) {
    try { out.ontology = (await (await import('../lib/ontology/reset.js')).resetTenant(T)) ?? 'reset' } catch (e) { out.ontology = `reset failed: ${e.message}` }
  } else out.ontology = 'no lib/ontology/reset.js'
  console.log(`reset ${T}: ${JSON.stringify(out)}`)
}

async function status() {
  const one = async (sql, p = [T]) => q(sql, p).catch((e) => [{ error: e.message }])
  const [tenant] = await one(`select t.id, u.username as owner from tenants t left join users u on u.id::text = t.owner::text and u.tenant_id = t.id where t.id=$1`)
  const out = {
    tenant: tenant || null,
    team: await one(`select u.username as name, u.email, u.id, u.is_admin as admin, p.lang from pro_team_members m join users u on u.id=m.user_id and u.tenant_id=m.tenant_id
                     left join pro_profile p on p.user_id=u.id where m.tenant_id=$1 order by u.is_admin desc, u.email`),
    roles: await one(`select a.proc_def_id as process, a.role, u.username as name from pro_role_assignments a left join users u on u.id=a.user_id and u.tenant_id=a.tenant_id where a.tenant_id=$1 order by 1,2`),
    handovers: await one(`select source, count(*)::int as rows, count(distinct case_id)::int as cases, count(norm_activity_label)::int as labeled,
                          min(occurred_at) as first, max(occurred_at) as last from handover_events where tenant_id=$1 group by source order by source`),
    tables: {},
  }
  for (const t of ONTO_TABLES) {
    const info = await tableInfo(t)
    out.tables[t] = !info.present ? 'absent' : !info.tenanted ? 'present (no tenant_id)' : (await one(`select count(*)::int as n from "${t}" where tenant_id=$1`))[0]?.n
  }
  if (fs.existsSync(FIXTURE)) {
    const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
    const by = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m }, {})
    out.fixture = { mails: fx.mails.length, kinds: by(fx.mails, (m) => m.kind), cases: by(fx.truth.cases, (c) => c.proc), chat_cases: fx.truth.chat_cases.length, chat_rows: fx.chat_handovers.length }
  } else out.fixture = 'missing (node scripts/gen-ax-demo-mailbox.mjs)'
  console.log(JSON.stringify(out, null, 1))
}

// --clean-runs: what a scenario run left (keeps the mail history and the map): the cases a snapshot ran, the practice
// mails that arrived, the handovers the mail pipeline recorded for them, the habit answers, the ontology's chat cards —
// so the run-from-anywhere scenario (and its video) can be played again on the same map
async function cleanRuns() {
  const [boss] = await q(`select id from users where tenant_id=$1 and email=$2`, [T, 'pro-ax-jinyoung@uengine.org'])
  const out = {}
  out.cases = (await q(`delete from pro_po_cases where tenant_id=$1 returning id`, [T])).length
  out.answers = (await q(`delete from pro_onto_answers where tenant_id=$1 returning id`, [T])).length
  out.handovers = (await q(`delete from handover_events where tenant_id=$1 and coalesce(reason,'') <> $2 returning id`, [T, SEED_REASON])).length
  if (boss) {
    out.mails = (await q(`delete from pro_demo_mail where user_id=$1 returning mail_id`, [boss.id])).length
    await q(`delete from pro_mail_seen where user_id=$1`, [boss.id]).catch(() => {})
    out.cards = (await q(`delete from pro_messages m using pro_threads t where t.id=m.thread_id and t.user_id=$1 and m.kind in ('onto-entry','onto-habit','process') returning m.id`, [boss.id])).length
  }
  // the engine's instances of the snapshots (onto_…) with their work items and events, the cast's case threads (the
  // agent's messages, a kept agent conversation) and the home action cards the mails made
  const insts = (await q(`select proc_inst_id from bpm_proc_inst where tenant_id=$1 and proc_def_id like 'onto\\_%'`, [T])).map((r) => r.proc_inst_id)
  if (insts.length) {
    await q('delete from events where proc_inst_id = any($1)', [insts]).catch((e) => console.warn('events', e.message))
    await q('delete from todolist where proc_inst_id = any($1)', [insts])
    out.instances = (await q('delete from bpm_proc_inst where proc_inst_id = any($1) returning 1', [insts])).length
  }
  const castIds = (await q('select id::text as id from users where tenant_id=$1 and email = any($2)', [T, Object.values(CAST).map((p) => p.email)])).map((r) => r.id)
  if (castIds.length) {
    await q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id::text = any($1) and kind='process')`, [castIds])
    out.threads = (await q(`delete from pro_threads where user_id::text = any($1) and kind='process' returning id`, [castIds])).length
    out.actions = (await q('delete from pro_actions where user_id::text = any($1) returning id', [castIds])).length
  }
  console.log('clean-runs', JSON.stringify(out))
}

try {
  if (has('--status')) await status()
  else if (has('--clean-runs')) await cleanRuns()
  else {
    if (has('--reset')) await reset()
    if (!has('--reset') || has('--seed')) {
      const ids = await setup()
      if (has('--seed')) { await seed(ids); console.log(`habits ${await seedHabits(ids)} (pro_followups)`) }
    }
  }
} finally { await pool.end() }
