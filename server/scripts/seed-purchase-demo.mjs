// 「구매 요청」 — the Agentic BPM PoC's purchase scenario (pgpt-pro/docs/agentic-bpm/plan.md §6 scenario 2).
// Safe to run again: the seeded history is replaced, the definition saved over.
//   node scripts/seed-purchase-demo.mjs                 정의(v1.0)·과거 이력(약 3개월, 결정 브리프 없이) 시드
//   node scripts/seed-purchase-demo.mjs --live 3 [--api http://localhost:8792]
//                                                       실제 엔진으로 요청 N건 시작(정하은) — 팀장 승인에서 멈춤(승인함 시연)
//   node scripts/seed-purchase-demo.mjs --reset         깨끗한 시작으로: 시연·E2E 로 실행한 인스턴스와 그 작업 항목·알림·채팅 카드,
//                                                       결정 브리프, 발주서(초안), 이 시나리오의 결정 원장 행을 지움 — 시드 이력(TOC 숫자의 바탕)은 그대로
//   node scripts/seed-purchase-demo.mjs --remove        시드·실행한 인스턴스·브리프·발주서·정의를 모두 지움
// 계정은 이미 있는 테넌트(localhost) 계정: 요청자 정하은 pro-bd-member, 팀장 장진영 pro-team-owner,
// 재무 책임자 이도윤 pro-mine3-admin, 구매 담당 김민지 pro-team-minji (역할은 pro_role_assignments '*').
// 과거 이력은 process-gpt 엔진이 남기는 모양 그대로(lib/improve/shape.js): todolist + todolist_status_history + events.
process.env.DOTENV_CONFIG_QUIET = 'true'
const { q, pool } = await import('../lib/supa.js')
const { saveGenerated } = await import('../lib/generated.js')
const { writeInstance } = await import('../lib/improve/shape.js')
const { DEF_ID, DEF_NAME, VERSION, SEED_MARK, contract, simulate, ACT, ITEMS, SUPPLIERS, NEW_SUPPLIERS } = await import('../lib/scenarios/purchase/process.js')

const T = 'localhost'
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? (process.argv[i + 1] ?? true) : d }
const has = (k) => process.argv.includes(k)
export const PEOPLE = {
  requester: 'pro-bd-member@uengine.org', lead: 'pro-team-owner@uengine.org',
  finance: 'pro-mine3-admin@uengine.org', buyer: 'pro-team-minji@uengine.org',
}

async function accounts() {
  const ids = {}, names = {}
  for (const [k, email] of Object.entries(PEOPLE)) {
    const [u] = await q('select id, username from users where lower(email)=lower($1) and tenant_id=$2', [email, T])
    if (!u) throw new Error(`no account ${email} in tenant ${T}`)
    ids[k] = u.id; names[k] = u.username
  }
  return { ids, names }
}

async function definition(ids) {
  const saved = await saveGenerated(contract(ids))
  const [d] = await q('select bpmn, definition from proc_def where id=$1 and tenant_id=$2', [DEF_ID, T])
  // the branch rules must reach the engine as sequence properties (polling evaluates conditionFunction)
  const rules = (d.definition.sequences || []).filter((s) => String(s.properties || '').includes('conditionFunction'))
  if (rules.length < 5) throw new Error(`the saved definition lost its branch rules (${rules.length} of 5)`)
  await q(`update proc_def set owner=$2 where id=$1 and tenant_id=$3`, [DEF_ID, ids.lead, T])
  const arcv = `${DEF_ID}_${VERSION}`
  await q(`delete from proc_def_version where proc_def_id=$1 and tenant_id=$2`, [DEF_ID, T])
  await q(`insert into proc_def_version (arcv_id, proc_def_id, version, version_tag, "timeStamp", snapshot, definition, message, tenant_id, is_draft, owner)
           values ($1,$2,$3,'major',$4,$5,$6,$7,$8,false,$9)`, [arcv, DEF_ID, VERSION, '2026-07-31T09:00:00Z', d.bpmn, d.definition, '정식 등록 (Agentic BPM 구매 시나리오)', T, ids.lead])
  console.log(`definition ${DEF_ID}: ${saved.proc_def}, forms ${saved.forms_saved?.length ?? saved.forms_saved}, bpmn ${saved.bpmn_bytes} bytes, version ${arcv}, rules ${rules.length}`)
  return { arcv, roles: d.definition.roles }
}

async function instancesOf(where = '', params = []) {
  return (await q(`select proc_inst_id from bpm_proc_inst where proc_def_id=$1 and tenant_id=$2 ${where}`, [DEF_ID, T, ...params])).map((r) => r.proc_inst_id)
}
async function removeInstances(insts) {
  if (!insts.length) return
  const todos = (await q('select id::text as id from todolist where proc_inst_id = any($1)', [insts])).map((r) => r.id)
  await q('delete from events where proc_inst_id = any($1) or todo_id = any($2)', [insts, todos])
  await q('delete from todolist_status_history where proc_inst_id = any($1)', [insts])
  await q('delete from task_execution_properties where proc_inst_id = any($1)', [insts]).catch(() => {})
  await q(`delete from notifications where url = any($1)`, [todos.map((t) => `/todolist/${t}`)])
  // the chat cards that followed them (briefs, work items, the 완료 chip)
  await q(`delete from pro_messages where kind in ('brief','todo','chip') and (content->>'instId' = any($1) or content->>'todoId' = any($2))`, [insts, todos]).catch(() => {})
  await q(`delete from pro_policy_decisions where tenant_id=$1 and ref = any($2)`, [T, insts.map((i) => `purchase:${i}`)])
  await q('delete from pro_decision_briefs where tenant_id=$1 and proc_inst_id = any($2)', [T, insts])
  await q('delete from pro_purchase_orders where tenant_id=$1 and proc_inst_id = any($2)', [T, insts]).catch(() => {})
  await q('delete from todolist where proc_inst_id = any($1)', [insts])
  await q('delete from pro_threads where ref = any($1)', [insts]).catch(() => {})
  await q('delete from bpm_proc_inst where proc_inst_id = any($1)', [insts])
}

async function seedHistory(ids, names, { arcv, roles }) {
  const old = await instancesOf('and variables_data @> $3::jsonb', [JSON.stringify(SEED_MARK)])
  await removeInstances(old)
  const sims = simulate({ people: ids, names, from: Date.UTC(2026, 7, 3), to: Date.now() - 6 * 3600000 })
  let rows = 0
  for (const sim of sims) rows += await writeInstance(q, { tenant: T, defId: DEF_ID, sim, arcv, version: VERSION, roles, mark: SEED_MARK })
  const big = sims.filter((s) => s.steps.some((x) => x.activityId === ACT.finance)).length
  console.log(`history: ${sims.length} instances (${big} through 재무 승인, ${sims.filter((s) => s.rejected).length} rejected), ${rows} work items (replaced ${old.length}) — ${new Date(sims[0].start).toISOString().slice(0, 10)} … ${new Date(sims.at(-1).end).toISOString().slice(0, 10)}`)
}

// back to a clean start for a demo take or an E2E run: what ran is removed, the seeded history stays
async function reset() {
  const insts = await instancesOf("and not coalesce(variables_data @> $3::jsonb, false)", [JSON.stringify(SEED_MARK)])
  await removeInstances(insts)
  // dry runs and actions of this scenario whose instance is already gone, and the brief notifications
  await q(`delete from pro_policy_decisions where tenant_id=$1 and ref like 'purchase:%' and not exists (select 1 from bpm_proc_inst i where 'purchase:' || i.proc_inst_id = ref)`, [T])
  await q(`delete from notifications where tenant_id=$1 and type='brief' and url='/settings/approvals'`, [T])
  // order numbers start again after the last one left (PO-2026-5001 on a clean start)
  await q(`select setval('pro_purchase_order_no', greatest(5000, (select coalesce(max(substring(po_no from 9)::int), 5000) from pro_purchase_orders)))`).catch(() => {})
  const left = await q(`select (select count(*)::int from bpm_proc_inst where proc_def_id=$1 and tenant_id=$2) inst, (select count(*)::int from pro_purchase_orders where tenant_id=$2) po,
    (select count(*)::int from pro_decision_briefs where tenant_id=$2 and brief->>'defId'=$1) briefs`, [DEF_ID, T])
  console.log(`reset: removed ${insts.length} instances that ran; left ${left[0].inst} seeded instances, ${left[0].po} orders, ${left[0].briefs} briefs`)
}

async function removeAll() {
  await removeInstances(await instancesOf())
  await q(`delete from form_def where proc_def_id=$1 and tenant_id=$2`, [DEF_ID, T])
  await q(`delete from proc_def_version where proc_def_id=$1 and tenant_id=$2`, [DEF_ID, T])
  await q(`delete from pro_improve_state where proc_def_id=$1 and tenant_id=$2`, [DEF_ID, T]).catch(() => {})
  await q(`delete from proc_def where id=$1 and tenant_id=$2`, [DEF_ID, T])
  const [cfg] = await q(`select value from configuration where key='proc_map' and tenant_id=$1`, [T])
  if (cfg?.value?.mega_proc_list) {
    for (const mg of cfg.value.mega_proc_list) for (const mj of mg.major_proc_list || []) mj.sub_proc_list = (mj.sub_proc_list || []).filter((x) => x.id !== DEF_ID)
    await q(`update configuration set value=$2 where key='proc_map' and tenant_id=$1`, [T, cfg.value])
  }
  console.log(`removed the definition ${DEF_ID} and its instances`)
}

// --live N: real requests through the BFF (as 정하은), left at 팀장 승인 for the approval inbox
async function live(api, n) {
  const r = await fetch(`${api}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: PEOPLE.requester, code: '000000' }) })
  if (!r.ok) throw new Error(`login: ${r.status}`)
  const tok = (await r.json()).session.access_token
  const demo = [
    { item: ITEMS[1].item, quantity: 6, unitPrice: ITEMS[1].unit, supplier: SUPPLIERS[0], supplierNew: false, reason: '신규 입사자 자리 세팅' },
    { item: ITEMS[7].item, quantity: 1, unitPrice: ITEMS[7].unit, supplier: SUPPLIERS[2], supplierNew: false, reason: '모델 학습용 워크스테이션' },
    { item: ITEMS[4].item, quantity: 2, unitPrice: ITEMS[4].unit, supplier: NEW_SUPPLIERS[1], supplierNew: true, reason: '3층 회의실 화상회의 장비' },
  ]
  for (const body of demo.slice(0, n)) {
    const s = await fetch(`${api}/api/purchase/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) })
    const t = await s.text()
    if (!s.ok) throw new Error(`start: ${s.status} ${t.slice(0, 200)}`)
    console.log('started', JSON.parse(t).instId, body.item)
  }
}

try {
  if (has('--remove')) await removeAll()
  else if (has('--reset')) await reset()
  else if (has('--live')) await live(arg('--api', 'http://localhost:8792'), Number(arg('--live', 3)))
  else {
    const { ids, names } = await accounts()
    const def = await definition(ids)
    await seedHistory(ids, names, def)
    const { load } = await import('../lib/improve/service.js')
    const { a } = await load(DEF_ID)
    const h = (s) => (s == null ? '-' : `${(s / 3600).toFixed(1)}h`)
    for (const s of a.steps) console.log(`  ${s.name}: ${s.frequency} runs, median ${h(s.medianDuration)} (wait ${h(s.medianWait)}, work ${h(s.medianWork)})`)
    console.log(`${DEF_NAME}: ${a.instances.length} instances`)
  }
} finally { await pool.end() }
