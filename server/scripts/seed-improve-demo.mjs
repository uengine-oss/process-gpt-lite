// 「달빛커피 제안」 — 프로세스 개선 튜토리얼(20~22장)의 예제 데이터. 다시 돌려도 되고(이전 시드분을 지우고 다시 씀),
// 통째로 지울 수도 있다.
//   node scripts/seed-improve-demo.mjs                 계정·에이전트·정의(v1.0)·과거 이력(약 3개월) 시드
//   node scripts/seed-improve-demo.mjs --run 3 [--api http://localhost:8788] [--leave 1]
//                                                       실제 엔진으로 인스턴스 N건 실행(마지막 --leave 건은 재무 검토에서 멈춤)
//   node scripts/seed-improve-demo.mjs --remove [--accounts]   시드·실행한 것 모두 지움(--accounts: 계정까지)
//   … --lang en    영문판(English edition): 같은 정의 id·이력·숫자, 이름과 글만 영어(Moonlight Coffee proposal,
//                   Jinyoung Jang · Minji Kim · Seoyeon Park). 계정은 pro-en-srv-d-{jang,minji,seoyeon}@uengine.org 이고
//                   그 계정의 언어(pro_profile.lang)를 en 으로 둔다. 정의 id 가 같으므로 한국어판을 쓰는 데이터베이스에서
//                   돌리면 한국어판 정의·이력을 바꿔 쓴다(한국어판은 --lang 없이 다시 돌리면 돌아옴).
//   … --dry-run   데이터베이스에 쓰지 않고 정의·이력의 이름과 글만 보여 준다(--lang en 과 함께)
// 계정은 튜토리얼용 pro-tut-d-{jang,minji,seoyeon}@uengine.org(장진영·김민지·박서연) 뿐이다.
// 과거 이력은 process-gpt 엔진이 남기는 모양 그대로(lib/improve/shape.js): todolist + todolist_status_history + events.
process.env.DOTENV_CONFIG_QUIET = 'true'
import crypto from 'node:crypto'
const { q, pool, ensureUser } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const { saveGenerated } = await import('../lib/generated.js')
const { DEF_ID, VERSION, agentsIn, contract, simulate } = await import('../lib/improve/demoProcess.js')
const { writeInstance } = await import('../lib/improve/shape.js')
const { withLang } = await import('../lib/lang.js')

const T = config.tenantId
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? (process.argv[i + 1] ?? true) : d }
const has = (k) => process.argv.includes(k)
const LANG = String(process.argv.find((a) => a.startsWith('--lang='))?.slice(7) || arg('--lang', 'ko')).toLowerCase().startsWith('en') ? 'en' : 'ko'
const EN = LANG === 'en'
const AGENTS = agentsIn(LANG)
const PEOPLE = EN
  ? { jang: ['pro-en-srv-d-jang@uengine.org', 'Jinyoung Jang'], minji: ['pro-en-srv-d-minji@uengine.org', 'Minji Kim'], seoyeon: ['pro-en-srv-d-seoyeon@uengine.org', 'Seoyeon Park'] }
  : { jang: ['pro-tut-d-jang@uengine.org', '장진영'], minji: ['pro-tut-d-minji@uengine.org', '김민지'], seoyeon: ['pro-tut-d-seoyeon@uengine.org', '박서연'] }
const SEED_MARK = { seed: 'improve-demo' }
// the words the seed itself writes (the definition's own are in lib/improve/demoProcess.js)
const TX = EN ? {
  versionMessage: 'Registered (process mining)', roles: ['Sales', 'Designer', 'Finance'],
  stores: ['Seoul Forest Store #52', 'Gwanghwamun Store #53', 'Songnidan-gil Store #54', 'Ikseon-dong Store #55'], customer: 'Moonlight Coffee',
  body: (store, area) => `Please send us a design proposal and a quote for Moonlight Coffee ${store} (${area} ㎡).`,
  rooms: (area) => `Hall | ${Math.round(area * 0.55)} ㎡\nBar & kitchen | ${Math.round(area * 0.22)} ㎡\nStorage | ${Math.round(area * 0.08)} ㎡\nRestroom | ${Math.round(area * 0.07)} ㎡\nStaff room | ${Math.round(area * 0.08)} ㎡`,
  planNote: 'Entrance on the south side, window seats first', approve: { decision: 'Approve', comment: 'Unit prices look right. Approved.' },
  reply: (store) => `Hello. Please find attached the design proposal and the quote for Moonlight Coffee ${store}.`,
} : {
  versionMessage: '정식 등록 (프로세스 마이닝)', roles: ['영업 담당', '디자이너', '재무 담당'],
  stores: ['서울숲 52호점', '광화문 53호점', '송리단길 54호점', '익선동 55호점'], customer: '달빛커피',
  body: (store, area) => `달빛커피 ${store} 매장(${area}㎡) 설계 제안과 견적을 부탁드립니다.`,
  rooms: (area) => `홀 | ${Math.round(area * 0.55)}㎡\n바·주방 | ${Math.round(area * 0.22)}㎡\n창고 | ${Math.round(area * 0.08)}㎡\n화장실 | ${Math.round(area * 0.07)}㎡\n직원실 | ${Math.round(area * 0.08)}㎡`,
  planNote: '출입구 남측, 창가 좌석 우선', approve: { decision: '승인', comment: '단가 적정, 승인합니다.' },
  reply: (store) => `안녕하세요. 달빛커피 ${store} 설계 제안서와 견적서를 보내 드립니다.`,
}

async function accounts() {
  const ids = {}, names = {}
  for (const [k, [email, name]] of Object.entries(PEOPLE)) {
    const u = await ensureUser(email, name)
    ids[k] = u.id; names[k] = name
    await q(`update users set username=$2 where id=$1 and tenant_id=$3`, [u.id, name, T])
    await q(`insert into pro_profile(user_id,name,email,birth,onboarded_at) values ($1,$2,$3,'1988-01-01',now())
             on conflict (user_id) do update set name=$2, onboarded_at=coalesce(pro_profile.onboarded_at, now()), birth=coalesce(pro_profile.birth, '1988-01-01')`, [u.id, name, email])
    await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$3) on conflict do nothing`, [T, u.id, u.id])
    // the English edition's accounts work in English (lib/lang.js; needs sql/019_lang.sql)
    if (EN) await q(`update pro_profile set lang='en' where user_id=$1`, [u.id]).catch((e) => console.warn('lang', e.message))
  }
  for (const a of Object.values(AGENTS)) {
    await q(`insert into users (id, username, email, tenant_id, is_agent, is_admin, is_draft, agent_type, alias, goal, persona, permission_ids)
             values ($1,$2,$3,$4,true,false,false,'agent',$5,$6,$7,'{}') on conflict (id, tenant_id) do update set username=$2, alias=$5, goal=$6, persona=$7`,
    [a.id, a.name, `${a.alias}@${T}`, T, a.alias, a.goal, a.persona])
  }
  return { ids, names }
}

async function definition(ids) {
  const c = contract(ids, { lang: LANG })
  const saved = await saveGenerated(c)
  await q(`update proc_def set owner=$2 where id=$1 and tenant_id=$3`, [DEF_ID, ids.jang, T])
  const [d] = await q('select bpmn, definition from proc_def where id=$1 and tenant_id=$2', [DEF_ID, T])
  const arcv = `${DEF_ID}_${VERSION}`
  await q(`delete from proc_def_version where proc_def_id=$1 and tenant_id=$2 and arcv_id=$3`, [DEF_ID, T, arcv])
  await q(`insert into proc_def_version (arcv_id, proc_def_id, version, version_tag, "timeStamp", snapshot, definition, message, tenant_id, is_draft, owner)
           values ($1,$2,$3,'major',$4,$5,$6,$7,$8,false,$9)`, [arcv, DEF_ID, VERSION, '2026-07-31T09:00:00Z', d.bpmn, d.definition, TX.versionMessage, T, ids.jang])
  // (the other language's role names of this definition are cleared, so one set of roles holds)
  await q(`delete from pro_role_assignments where tenant_id=$1 and proc_def_id=$2 and role = any($3)`, [T, DEF_ID, EN ? ['영업 담당', '디자이너', '재무 담당'] : ['Sales', 'Designer', 'Finance']])
  for (const [role, who] of [[TX.roles[0], ids.jang], [TX.roles[1], ids.minji], [TX.roles[2], ids.seoyeon]]) {
    await q(`insert into pro_role_assignments(tenant_id,proc_def_id,role,user_id,updated_by) values ($1,$2,$3,$4,$4)
             on conflict (tenant_id,proc_def_id,role) do update set user_id=excluded.user_id, updated_at=now()`, [T, DEF_ID, role, who])
  }
  console.log(`definition ${DEF_ID}: ${saved.proc_def}, forms ${saved.forms_saved?.length ?? saved.forms_saved}, bpmn ${saved.bpmn_bytes} bytes, version ${arcv}`)
  return { arcv, roles: d.definition.roles }
}

async function removeSeeded() {
  const insts = (await q(`select proc_inst_id from bpm_proc_inst where proc_def_id=$1 and tenant_id=$2 and variables_data @> $3::jsonb`, [DEF_ID, T, JSON.stringify(SEED_MARK)])).map((r) => r.proc_inst_id)
  await removeInstances(insts)
  return insts.length
}
async function removeInstances(insts) {
  if (!insts.length) return
  const todos = (await q('select id::text as id from todolist where proc_inst_id = any($1)', [insts])).map((r) => r.id)
  await q('delete from events where proc_inst_id = any($1) or todo_id = any($2)', [insts, todos])
  await q('delete from todolist_status_history where proc_inst_id = any($1)', [insts])
  await q('delete from task_execution_properties where proc_inst_id = any($1)', [insts]).catch(() => {})
  await q(`delete from notifications where url = any($1)`, [todos.map((t) => `/todolist/${t}`)])
  await q('delete from todolist where proc_inst_id = any($1)', [insts])
  await q('delete from pro_threads where ref = any($1)', [insts]).catch(() => {})
  await q('delete from bpm_proc_inst where proc_inst_id = any($1)', [insts])
}

async function seedHistory(ids, names, { arcv, roles }) {
  const removed = await removeSeeded()
  const now = Date.now()
  const sims = simulate({ people: ids, names, from: Date.UTC(2026, 7, 3), to: now - 2 * 3600000, lang: LANG })
  let rows = 0
  for (const sim of sims) rows += await writeInstance(q, { tenant: T, defId: DEF_ID, sim, arcv, version: VERSION, roles, mark: SEED_MARK })
  console.log(`history: ${sims.length} instances, ${rows} work items (replaced ${removed} seeded before) — ${new Date(sims[0].start).toISOString().slice(0, 10)} … ${new Date(sims.at(-1).end).toISOString().slice(0, 10)}`)
}

// ---------- real runs through the engine (BFF API, as the tutorial accounts) ----------
async function login(api, email) {
  const r = await fetch(`${api}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`)
  return (await r.json()).session.access_token
}
const call = async (api, tok, method, path, body) => {
  const r = await fetch(`${api}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(EN ? { 'X-PGL-Lang': 'en' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t.slice(0, 200)}`)
  return t ? JSON.parse(t) : null
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, what, ms = 45 * 60000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(4000)
  }
}

export async function runReal({ api, n, leave, pause = 30000, stores, areas, cont }) {
  const tok = {}
  for (const [k, [email]] of Object.entries(PEOPLE)) tok[k] = await login(api, email)
  // (the page sends X-PGL-Lang on every call; so does this script)
  const out = []
  for (let i = 0; i < n; i++) {
    const store = stores?.[i] || TX.stores[i % 4]
    const area = areas?.[i] || [72, 118, 64, 96][i % 4]
    let instId = cont
    if (!instId) {
      const values = { customer: TX.customer, store, area: String(area), budget: String(area * 500000), body: TX.body(store, area) }
      instId = (await call(api, tok.jang, 'POST', `/processes/${DEF_ID}/start`, { values })).instId
      console.log(`started ${instId} (${store})`)
    }
    await drive({ api, tok, instId, area, store, pause, leave: i >= n - leave })
    out.push({ instId, store, left: i >= n - leave })
  }
  return out
}

// the people's steps of one instance, as the tutorial accounts (the agents run in deepagents)
async function drive({ api, tok, instId, area, store, pause, leave }) {
  const done = async (act) => (await q(`select 1 from todolist where proc_inst_id=$1 and activity_id=$2 and status::text='DONE' limit 1`, [instId, act])).length > 0
  const step = async (who, act, vals, opts = {}) => {
    if (await done(act) && !opts.again) return 'done'
    const todo = await waitFor(async () => {
      const [i] = await q('select current_activity_ids, status::text as status from bpm_proc_inst where proc_inst_id=$1', [instId])
      const cur = i?.current_activity_ids || []
      // a rule may skip this step (v2: 기준 미만은 재무 검토 없이) — the next step comes up instead
      if (opts.skipTo && (cur.includes(opts.skipTo) || i?.status === 'COMPLETED')) return { skipped: true }
      if (!cur.includes(act)) return null
      const [t] = await q(`select id::text as id, agent_mode::text as mode, draft_status::text as draft from todolist where proc_inst_id=$1 and activity_id=$2 and status::text in ('IN_PROGRESS','TODO','NEW') order by start_date desc nulls last limit 1`, [instId, act])
      // an agent pre-draft (agentMode draft): the person opens it once the draft is there
      if (t?.mode === 'DRAFT' && !['COMPLETED', 'FAILED'].includes(t.draft || '')) return null
      return t || null
    }, `${act} on ${instId}`)
    if (todo.skipped) { console.log(`  ${act} skipped (rule) on ${instId}`); return 'skipped' }
    await call(api, tok[who], 'GET', `/todos/${todo.id}`) // the assignee opens it (human_checked)
    if (opts.stop) { console.log(`  ${act} left open (opened by ${who})`); return null }
    await sleep(opts.pause ?? pause)
    await call(api, tok[who], 'POST', `/todos/${todo.id}/submit`, { values: vals })
    console.log(`  ${act} submitted by ${who}`)
    return todo.id
  }
  await step('minji', 'floor_plan', { rooms: TX.rooms(area), plan_note: TX.planNote })
  // the agents (견적 초안, 제안서 작성) run in deepagents; 재무 검토 comes up when the proposal is done
  const fin = await step('seoyeon', 'finance_review', TX.approve, { stop: leave, skipTo: 'reply' })
  if (fin) await step('jang', 'reply', { reply: TX.reply(store) })
}

async function removeAll() {
  const insts = (await q(`select proc_inst_id from bpm_proc_inst where proc_def_id=$1 and tenant_id=$2`, [DEF_ID, T])).map((r) => r.proc_inst_id)
  await removeInstances(insts)
  await q(`delete from form_def where proc_def_id=$1 and tenant_id=$2`, [DEF_ID, T])
  await q(`delete from proc_def_version where proc_def_id=$1 and tenant_id=$2`, [DEF_ID, T])
  await q(`delete from pro_role_assignments where proc_def_id=$1 and tenant_id=$2`, [DEF_ID, T])
  await q(`delete from pro_improve_state where proc_def_id=$1 and tenant_id=$2`, [DEF_ID, T]).catch(() => {})
  await q(`delete from pro_improve_runs where proc_def_id=$1 and tenant_id=$2`, [DEF_ID, T]).catch(() => {})
  await q(`delete from notifications where tenant_id=$1 and url=$2`, [T, `/improve/${DEF_ID}`])
  await q(`delete from proc_def where id=$1 and tenant_id=$2`, [DEF_ID, T])
  const [cfg] = await q(`select value from configuration where key='proc_map' and tenant_id=$1`, [T])
  if (cfg?.value?.mega_proc_list) {
    for (const mg of cfg.value.mega_proc_list) for (const mj of mg.major_proc_list || []) mj.sub_proc_list = (mj.sub_proc_list || []).filter((x) => x.id !== DEF_ID)
    await q(`update configuration set value=$2 where key='proc_map' and tenant_id=$1`, [T, cfg.value])
  }
  await q(`delete from users where tenant_id=$1 and is_agent and (alias like 'pro-tut-d-%' or alias like $2)`, [T, `pro-improve-${DEF_ID}-%`])
  console.log(`removed ${insts.length} instances and the definition ${DEF_ID}`)
  if (has('--accounts')) {
    const { admin } = await import('../lib/supa.js')
    for (const [email] of Object.values(PEOPLE)) {
      const [u] = await q('select id from users where email=$1 and tenant_id=$2', [email, T])
      if (!u) continue
      await q('delete from pro_team_members where user_id=$1', [u.id])
      await q('delete from pro_profile where user_id=$1', [u.id])
      await q('delete from notifications where user_id=$1', [String(u.id)])
      await q('delete from users where id=$1', [u.id])
      await admin.auth.admin.deleteUser(u.id).catch(() => {})
      console.log(`removed account ${email}`)
    }
  }
}

// --dry-run: the names and texts this would write, nothing written
async function dryRun() {
  const ids = { jang: 'jang', minji: 'minji', seoyeon: 'seoyeon' }
  const names = Object.fromEntries(Object.entries(PEOPLE).map(([k, [, n]]) => [k, n]))
  const c = contract(ids, { lang: LANG })
  const sims = simulate({ people: ids, names, from: Date.UTC(2026, 7, 3), to: Date.now() - 2 * 3600000, lang: LANG })
  const els = c.processDefinition.elements.filter((e) => e.elementType !== 'Sequence')
  console.log(JSON.stringify({ lang: LANG, accounts: PEOPLE, agents: Object.values(AGENTS).map((a) => a.name), process: c.processDefinition.processDefinitionName,
    description: c.processDefinition.description, roles: c.processDefinition.roles.map((r) => r.name), steps: els.map((e) => `${e.id}: ${e.name}`),
    conditions: c.processDefinition.elements.filter((e) => e.condition).map((e) => e.condition), instances: sims.length, first: sims[0] && { name: sims[0].name, steps: sims[0].steps.map((x) => ({ step: x.activityName, who: x.username, output: x.output })) } }, null, 1))
}

try {
  if (has('--dry-run')) await dryRun()
  else if (has('--remove')) await removeAll()
  else if (has('--run')) {
    const res = await runReal({ api: arg('--api', 'http://localhost:8788'), n: Number(arg('--run', 3)), leave: Number(arg('--leave', 1)), pause: Number(arg('--pause', 30000)), cont: arg('--continue', null),
      stores: arg('--stores', null)?.split(','), areas: arg('--areas', null)?.split(',').map(Number) })
    console.log(JSON.stringify(res, null, 1))
  } else {
    await withLang(LANG, async () => {
      const { ids, names } = await accounts()
      const def = await definition(ids)
      await seedHistory(ids, names, def)
      const { checkConstraint } = await import('../lib/improve/service.js')
      console.log('constraint notice:', JSON.stringify(await checkConstraint(DEF_ID)))
    })
  }
} finally { await pool.end() }
