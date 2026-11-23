// 흐름 분석(병목 · 회사의 제약 · 흔한 길)의 시연 자료 — ax-demo 테넌트에 지난 6주 동안 「지도에서 바로」(mapengine.js) 돈 건을, 엔진이 쓰는
// 모양 그대로(pro_po_cases · bpm_proc_inst 한 행 · 단계마다 todolist + pro_case_steps) 넣는다. 지도는 손대지 않는다(그래프 · 고친 기록 그대로).
//   node scripts/seed-flow-demo.mjs            지우고 다시 씀(같은 난수 — 다시 돌려도 같은 숫자)
//   node scripts/seed-flow-demo.mjs --remove   이 시드가 넣은 것만 지움(request.seed = 'flow-demo')
//   node scripts/seed-flow-demo.mjs --dry-run  쓰지 않고 시뮬레이션 결과(일마다 열린 할 일 · 처리 수)만
//   node scripts/seed-flow-demo.mjs --plans    개선안(pro_improve_plans)과 그 안이 지도에 넣은 고침 · 역할에 넣은 사람 · 의견도 지우고 다시 씀
//   node scripts/seed-flow-demo.mjs --after <개선안 id> [--weeks 2]   정한 안의 효력일을 그만큼 앞으로 당기고(시험용 — 안의 measure.seededAfter 에
//       적는다) 다시 씀: 「시행 전후」를 볼 수 있게 효력일 뒤 몇 주를 채운다
// 정한 개선안은 늘 효력일부터 시뮬레이션에 든다: 더한 사람은 그날부터 일하고, AI 초안 먼저인 일은 사람 일이 TRUE_SAVE 만큼 줄고(이 시험 세계의
// 값 — 안이 가정한 값과 일부러 다르다), 에이전트가 맡는 일은 에이전트가, 건너뛰기 · 빼기는 그날 뒤에 들어온 건부터.
// 흐름은 지도의 길(프로세스의 θ 위 넘어감과 그 확률)을 따라 건마다 뽑는다. 사람은 역할의 구성원(설정 › 팀 · 역할)이 한 번에 하나씩 하고
// (먼저 온 것부터, 디자이너는 현장 일을 먼저), 요청 메일 접수는 에이전트가 몇 분 안에 한다. 디자이너가 한 사람이라 요청이 늘어난
// 뒤 3주 동안 평면도가 쌓인다 — 할 일 수로 병목이 잡히는지 보려는 자료다. 지금 열려 있는 단계는 그 사람의 할 일 목록에 있다(IN_PROGRESS).
// 단계 작업자(run.js)가 건드리지 않게 agent_orch 는 비워 두고, 열린 단계는 문(gate)을 지난 상태(released)로 둔다.
process.env.DOTENV_CONFIG_QUIET = 'true'
const T = 'ax-demo'
if (!process.argv.includes('--tenant')) process.argv.push('--tenant', T)
const { config } = await import('../config.js')
if (!String(config.tenantHosts || '').split(',').some((s) => s.split('=')[1]?.trim() === T)) config.tenantHosts = [config.tenantHosts, `ax.localhost=${T}`].filter(Boolean).join(',')
const { enterSeedTenant } = await import('../lib/seedTenant.js')
enterSeedTenant(['--tenant', T])
const { q, pool } = await import('../lib/supa.js')
const { procGraph, unfold, actId, agentId } = await import('../lib/ontology/run.js')
const { readGraph, closeOntology } = await import('../lib/ontology/store.js')
const { END } = await import('../lib/ontology/stats.js')
const { addWork, workMs, HOUR, DAY } = await import('../lib/ontology/flowtime.js')

const has = (k) => process.argv.includes(k)
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const TRUE_SAVE = 0.4 // AI 초안이 실제로 덜어 준 사람 일의 몫(이 시험 세계) — 개선안의 가정(flowplan.js SAVE 0.5)과 견줘 보려고 다르게 둔다
const SEED = 'flow-demo'
const kst = (s) => new Date(`${s}+09:00`).getTime()

// ---------- remove ----------
async function remove() {
  const cs = await q(`select id::text as id, instances from pro_po_cases where tenant_id=$1 and request->>'seed'=$2`, [T, SEED])
  if (!cs.length) return 0
  const insts = cs.flatMap((c) => c.instances || [])
  const todos = (await q(`select id::text as id from todolist where tenant_id=$1 and proc_inst_id = any($2)`, [T, insts])).map((r) => r.id)
  await q(`delete from pro_case_steps where tenant_id=$1 and case_id = any($2::uuid[])`, [T, cs.map((c) => c.id)])
  if (todos.length) {
    await q(`delete from notifications where tenant_id=$1 and url = any($2)`, [T, todos.map((id) => `/todolist/${id}`)]).catch(() => {})
    // the work-item cards a hand-in opened in someone's chat (POST /todos/:id/open) — their item is gone
    await q(`delete from pro_messages where kind='todo' and content->>'todoId' = any($1)`, [todos]).catch(() => {})
    await q(`delete from task_execution_properties where tenant_id=$1 and todo_id = any($2::uuid[])`, [T, todos]).catch(() => {})
    await q(`delete from todolist_status_history where tenant_id=$1 and todo_id = any($2::uuid[])`, [T, todos]).catch(() => {})
    await q(`delete from todolist where tenant_id=$1 and id = any($2::uuid[])`, [T, todos])
  }
  await q(`delete from bpm_proc_inst where tenant_id=$1 and proc_inst_id = any($2)`, [T, insts])
  await q(`delete from pro_po_cases where tenant_id=$1 and id = any($2::uuid[])`, [T, cs.map((c) => c.id)])
  return cs.length
}

// ---------- 개선안 지우기(--plans) ----------
async function removePlans(boss) {
  const ps = await q(`select id::text as id, proc_key, batch::text as batch, members_added, opinion_id::text as opinion_id, created_at from pro_improve_plans where tenant_id=$1`, [T])
  if (!ps.length) return 0
  const { SIDE_OPS } = await import('../lib/ontology/refine.js')
  for (const p of ps) {
    if (p.batch) {
      for (const c of await q(`select id::text as id, op, args from pro_corrections where tenant_id=$1 and batch=$2`, [T, p.batch])) {
        if (SIDE_OPS.includes(c.op)) await (await import('../lib/ontology/editmap.js')).undoSide(boss, p.proc_key, c).catch(() => {})
        await q(`delete from pro_corrections where tenant_id=$1 and id=$2`, [T, c.id])
      }
    }
    for (const m of p.members_added || []) await q(`delete from pro_role_members where tenant_id=$1 and role=$2 and user_id::text=$3`, [T, m.role, m.userId])
  }
  // the opinions the plans and the people answering them left in those processes (since the first plan)
  const since = ps.map((p) => new Date(p.created_at).getTime()).sort((a, b) => a - b)[0]
  await q(`delete from pro_map_opinions where tenant_id=$1 and proc_key = any($2) and created_at >= to_timestamp($3)`, [T, [...new Set(ps.map((p) => p.proc_key))], since / 1000 - 60])
  await q(`delete from pro_improve_plans where tenant_id=$1`, [T])
  return ps.length
}

// ---------- the simulation ----------
// a seeded random (mulberry32) — the same numbers every run
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const R = rng(20261119)
const expo = (mean) => -Math.log(1 - R()) * mean
// a step's working time: around its mean, never under a fifth of it
const serve = (mean) => Math.max(mean * 0.2, mean * (0.55 + 0.9 * R()))

// working hours a step takes on average (설계 · 시공 회사의 감)
const WORK = { '요청 메일 접수': 0.08, '현장 실측': 2.5, '현장 방문': 2, '평면도 작성': 5.5, '평면도 검토': 1, '제안서 작성': 3.5, '견적서 작성': 2.5,
  '재무 검토': 1.5, '제안팀장 검토': 1, '고객 회신': 0.8, '계약 확정': 1, '일정 조율': 1.5, '자재 발주': 1.5, '타일 교체': 3, '실리콘 교체': 2 }
// who goes first in a person's queue (lower first): a designer does the site work first, the drawings wait
const PRIORITY = { '현장 실측': 0, '현장 방문': 0 }

const PROCS = [
  // 요청이 늘었다: 처음 3주는 근무일마다 1건, 다음 3주는 1.65건
  { name: '요청 접수 · 견적 제안', entry: '요청 메일 접수', rate: (wk) => (wk < 3 ? 1 : 1.65), subjects: ['카페 인테리어 견적 문의', '사무실 리모델링 제안 요청', '매장 설계 · 시공 견적', '병원 대기실 리뉴얼 문의', '학원 인테리어 견적 부탁드립니다', '오피스 이전 공사 견적', '쇼룸 디자인 제안 요청'] },
  { name: '계약서 제출 · 일정 조율', entry: '계약 확정', rate: () => 0.5, subjects: ['공사 계약 확정 · 일정 협의', '착공 일정 조율 요청', '계약서 회신 및 일정 문의'] },
]
const CUSTOMERS = ['소담카페', '한빛치과', '이음학원', '온누리약국', '바른한의원', '모래알베이커리', '그린오피스', '라온스튜디오', '해든병원', '다올공방']

async function main() {
  if (has('--remove')) { console.log(`flow-demo: ${await remove()}건 지움`); return }
  const g = await readGraph({})
  const procs = PROCS.map((p) => ({ ...p, view: null, key: g.processes.find((x) => x.name === p.name)?.key })).filter((p) => p.key)
  if (procs.length < PROCS.length) throw new Error(`지도에 프로세스가 없어요: ${PROCS.filter((p) => !procs.some((x) => x.name === p.name)).map((p) => p.name).join(', ')} — node scripts/ax-demo.mjs --reset --seed 뒤 지도를 셈하세요`)
  for (const p of procs) p.view = await procGraph(p.key)
  const outside = new Set(g.roles.filter((r) => r.outside).map((r) => r.key))
  // the plans go first: the people they put in roles must not be read as members from the start
  if (has('--plans') && !has('--dry-run')) {
    const [b0] = await q(`select id::text as id, email from users where tenant_id=$1 and email='pro-ax-jinyoung@uengine.org'`, [T])
    console.log(`flow-demo: 개선안 ${await removePlans(b0)}개와 그 고침을 지웠어요`)
  }
  // the people of each role (Settings › 팀 · 역할 — the company's members)
  const members = await q(`select x.role, x.user_id::text as id, coalesce(u.username, u.email) as name from (
                             select user_id, role from pro_role_assignments where tenant_id=$1 and proc_def_id='*'
                             union select user_id, role from pro_role_members where tenant_id=$1) x
                             join users u on u.id = x.user_id and u.tenant_id=$1 and not coalesce(u.is_agent,false) order by u.email`, [T])
  const pool_ = new Map()
  for (const m of members) { if (!pool_.has(m.role)) pool_.set(m.role, []); if (!pool_.get(m.role).some((x) => x.id === m.id)) pool_.get(m.role).push({ id: m.id, name: m.name, free: 0 }) }
  const [boss] = await q(`select id::text as id, email from users where tenant_id=$1 and email='pro-ax-jinyoung@uengine.org'`, [T])
  const agent = await agentId()

  // the clock: working hours from the Monday six weeks ago, 9:00
  const now = Date.now()
  const day0 = new Date(now + 9 * HOUR); day0.setUTCHours(0, 0, 0, 0)
  const monday = day0.getTime() - 9 * HOUR - (((new Date(day0).getUTCDay() + 6) % 7) + 35) * DAY
  const start = monday + 9 * HOUR
  const horizon = workMs(start, now) / HOUR
  const at = (h) => addWork(start, h) // working hour → instant
  const hourOf = (t) => workMs(start, t) / HOUR // instant → working hour

  // --after: the plan's effective day moved back (a test of 시행 전후 — written on the plan)
  if (arg('--after') && !has('--dry-run')) {
    const weeks = Number(arg('--weeks') || 2)
    const E = at(Math.max(0, horizon - weeks * 45))
    const [p] = await q(`update pro_improve_plans set effective_at=to_timestamp($3), decided_at=to_timestamp($3), measure=coalesce(measure,'{}'::jsonb) || $4::jsonb, updated_at=now()
                         where tenant_id=$1 and id::text=$2 and status='decided' returning id::text as id, batch::text as batch`, [T, arg('--after'), E / 1000, JSON.stringify({ seededAfter: { weeks, at: new Date(now).toISOString() } })])
    if (!p) throw new Error('--after: 정한 개선안을 찾지 못했어요')
    if (p.batch) await q(`update pro_corrections set at=to_timestamp($3) where tenant_id=$1 and batch=$2`, [T, p.batch, E / 1000])
    console.log(`flow-demo: 개선안 효력일을 ${new Date(E).toISOString()}(근무 ${weeks}주 전)로 당겼어요`)
  }
  // decided plans: from their effective day (working hour E) the simulated company works as the plan said
  const { normLever } = await import('../lib/ontology/flowplan.js')
  const decided = (await q(`select id::text as id, proc_key, levers, effective_at, members_added from pro_improve_plans where tenant_id=$1 and status='decided' and effective_at is not null`, [T]).catch(() => []))
    .map((p) => ({ ...p, E: hourOf(new Date(p.effective_at).getTime()), lv: (p.levers || []).map(normLever).filter(Boolean) })).filter((p) => p.E < horizon)
  const active = (procKey, h) => decided.filter((p) => (!procKey || p.proc_key === procKey) && h >= p.E).flatMap((p) => p.lv)
  // a person in two roles is one person (the plan's new people keep their old role too)
  const person = new Map()
  for (const list of pool_.values()) for (const x of list) if (!person.has(x.id)) person.set(x.id, x)
  for (const p of decided) for (const m of p.members_added || []) {
    const x = person.get(m.userId) || { id: m.userId, name: m.name, free: 0 }
    person.set(m.userId, x)
    const list = pool_.get(m.role) || []
    const i = list.findIndex((y) => y.id === m.userId)
    if (i >= 0) list.splice(i, 1)
    list.push(Object.assign(x, { from: Math.max(x.from || 0, p.E) }))
    pool_.set(m.role, list)
  }
  for (const list of pool_.values()) for (let i = 0; i < list.length; i++) list[i] = person.get(list[i].id) || list[i]
  const workOf = (c, k, h) => (WORK[k] || 1.5) * active(c.p.key, h).filter((l) => l.type === 'draft' && l.task === k).reduce((f) => f * (1 - TRUE_SAVE), 1)
  if (decided.length) console.log(`flow-demo: 정한 개선안 ${decided.length}개 — ${decided.map((p) => `근무 ${Math.round(p.E)}시간부터 ${p.lv.map((l) => l.type).join('+')}`).join(' · ')}`)

  // the way of a case: the map's ways out (θ — as a case would run), by their probability; an outside role's step passes (its wait is
  // the customer's); at most twice the same step
  const walk = (p) => {
    const th = p.view.proc.theta ?? 0.05
    const { flows } = unfold(p.view, p.entry, th)
    const path = [p.entry]
    const seen = new Map([[p.entry, 1]])
    let x = p.entry
    for (let i = 0; i < 14; i++) {
      const outs = flows.filter((f) => f.from === x && (f.to === END || (seen.get(f.to) || 0) < 2))
      if (!outs.length) break
      const sum = outs.reduce((s, f) => s + (f.p || 0), 0)
      let r = R() * sum, to = outs.at(-1).to
      for (const f of outs) { r -= f.p || 0; if (r <= 0) { to = f.to; break } }
      if (to === END) break
      seen.set(to, (seen.get(to) || 0) + 1)
      path.push(to); x = to
    }
    return path.filter((k) => !outside.has(p.view.tasks.get(k)?.role || ''))
  }
  // a case that arrives after a plan: the steps it removes or skips (건너뛰기: that share of cases)
  const planned = (p, path, h) => {
    const lv = active(p.key, h)
    return path.filter((k) => !lv.some((l) => (l.type === 'remove' && l.task === k) || (l.type === 'skip' && l.task === k && R() < l.share)))
  }

  // arrivals (working hours), then a discrete-event run: a step waits in its role's queue until one of its people is free
  const cases = []
  for (const p of procs) {
    let h = 0.5
    for (;;) {
      const wk = Math.floor(h / 45)
      h += expo(9 / p.rate(wk))
      if (h >= horizon - 0.3) break
      const n = cases.length
      cases.push({ p, arrive: h, path: planned(p, walk(p), h), steps: [], subject: `${CUSTOMERS[n % CUSTOMERS.length]} ${p.subjects[n % p.subjects.length]}`, customer: CUSTOMERS[n % CUSTOMERS.length] })
    }
  }
  const queue = [] // {c, i, ready}
  const events = cases.map((c) => ({ t: c.arrive, c, i: 0, kind: 'reach' }))
  const roleOf = (c, k) => c.p.view.tasks.get(k)?.role || ''
  const isAgent = (k, c, h) => k === '요청 메일 접수' || (c && active(c.p.key, h).some((l) => l.type === 'agent' && l.task === k))
  const isDraft = (k, c, h) => !!c && active(c.p.key, h).some((l) => l.type === 'draft' && l.task === k)
  // a plan's new person starts on its effective day: their role looks at its queue then
  for (const p of decided) for (const m of p.members_added || []) events.push({ t: p.E, kind: 'pick', role: m.role })
  const pushEv = (e) => { events.push(e) }
  // run
  for (let guard = 0; guard < 200000; guard++) {
    events.sort((a, b) => a.t - b.t)
    const e = events.shift()
    if (!e || e.t > horizon) break
    if (e.kind === 'reach') {
      const k = e.c.path[e.i]
      if (!k) { e.c.doneAt = e.t; continue }
      const step = { task: k, role: roleOf(e.c, k), made: e.t }
      e.c.steps.push(step)
      if (isAgent(k, e.c, e.t)) { step.agent = true; step.began = e.t; step.end = e.t + serve(k === '요청 메일 접수' ? WORK[k] : 0.15); pushEv({ t: step.end, c: e.c, i: e.i + 1, kind: 'reach' }); continue }
      if (isDraft(k, e.c, e.t)) step.draft = true
      queue.push({ c: e.c, i: e.i, step })
      pushEv({ t: e.t, kind: 'pick', role: step.role })
    } else if (e.kind === 'pick' || e.kind === 'free') {
      const people = pool_.get(e.role) || []
      for (const person of people) {
        if (person.free > e.t + 1e-9 || (person.from || 0) > e.t + 1e-9) continue
        const mine = queue.filter((x) => x.step.role === e.role).sort((a, b) => (PRIORITY[a.step.task] ?? 1) - (PRIORITY[b.step.task] ?? 1) || a.step.made - b.step.made)[0]
        if (!mine) break
        queue.splice(queue.indexOf(mine), 1)
        const s = mine.step
        s.who = person; s.began = e.t; s.end = e.t + serve(workOf(mine.c, s.task, e.t))
        person.free = s.end
        pushEv({ t: s.end, kind: 'free', role: e.role })
        pushEv({ t: s.end, c: mine.c, i: mine.i + 1, kind: 'reach' })
      }
    }
  }
  // a role nobody holds (the map's own role name with no member): its steps go to the boss, as bindings would ask
  for (const x of queue) if (!(pool_.get(x.step.role) || []).length) x.step.orphan = true

  // what it made, per task: open now · handed on in the last two weeks
  const sum = new Map()
  for (const c of cases) for (const s of c.steps) {
    const k = s.task
    if (!sum.has(k)) sum.set(k, { open: 0, done: 0, role: s.role })
    const x = sum.get(k)
    if (s.end != null && s.end <= horizon) { if (horizon - s.end < 10 * 9) x.done++ } else x.open++
  }
  console.log(`flow-demo: 건 ${cases.length}개(${procs.map((p) => `${p.name} ${cases.filter((c) => c.p === p).length}`).join(' · ')}), 근무 ${Math.round(horizon)}시간`)
  for (const [k, x] of [...sum].sort((a, b) => b[1].open - a[1].open)) console.log(`  ${k.padEnd(10)} ${x.role.padEnd(6)} 열림 ${String(x.open).padStart(2)} · 2주 처리 ${x.done}`)
  if (has('--dry-run')) return

  const removed = await remove()
  if (removed) console.log(`(지난 시드 ${removed}건 지움)`)
  const ms = (h) => at(h)
  const tsK = (t) => `to_timestamp(${(t / 1000).toFixed(3)}) at time zone 'Asia/Seoul'` // a KST wall-clock column
  let nItems = 0
  for (const c of cases) {
    const running = c.doneAt == null || c.doneAt > horizon
    const instId = `onto-map.${crypto.randomUUID()}`
    const t0 = ms(c.arrive)
    const request = { subject: c.subject, body: `${c.customer}입니다. ${c.subject} 드립니다.`, customer: c.customer, sender: `${c.customer} 담당자 <contact@${c.customer.length}.example.com>`, seed: SEED }
    const trigger = { kind: 'mail', subject: c.subject, from: request.sender, customer: c.customer, seed: SEED }
    const mode = c.p.view.proc.status === 'adopted' ? 'hotl' : 'hitl'
    const [pc] = await q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, snapshots, history, engine, request, run_mode, bindings, status, created_at, updated_at)
                          values ($1,$2,$3,$4,$5,$6,'{}','[]','map',$7,$8,'[]',$9, to_timestamp($10), to_timestamp($11)) returning id::text as id`,
    [T, c.p.key, c.p.entry, boss.id, trigger, [instId], request, mode, running ? 'running' : 'done', t0 / 1000, (running ? now : ms(c.doneAt)) / 1000])
    const people = [...new Set([boss.id, ...c.steps.map((s) => s.who?.id).filter(Boolean)])]
    const open = c.steps.filter((s) => s.end == null || s.end > horizon)
    const vars = [{ key: 'subject', name: '제목', value: c.subject }, { key: 'customer', name: '고객', value: c.customer }, { key: 'seed', name: '시험 자료', value: SEED }]
    await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, tenant_id, status, start_date, actual_start_date, end_date, participants, role_bindings, current_activity_ids, variables_data, updated_at)
             values ($1,$2,null,$3,$4, ${tsK(t0)}, to_timestamp(${t0 / 1000}), ${running ? 'null' : tsK(ms(c.doneAt))}, $5,'[]',$6,$7, now())`,
    [instId, `${c.p.name} · ${c.subject}`.slice(0, 120), T, running ? 'RUNNING' : 'COMPLETED', people, open.map((s) => actId(s.task)), JSON.stringify(vars)])
    let prev = null
    for (const s of c.steps) {
      const done = s.end != null && s.end <= horizon
      const who = s.agent ? { id: agent, name: '업무 에이전트' } : s.who || (s.orphan ? { id: boss.id, name: '장진영' } : null)
      // still in a queue at the end: it waits on one person of the role (the first) — on their list, not begun
      const holder = who || (pool_.get(s.role) || [])[0] || { id: boss.id, name: '장진영' }
      const made = ms(s.made), end = done ? ms(s.end) : null
      const aid = actId(s.task)
      const assignees = [{ name: s.role, endpoint: [holder.id], default: [holder.id], origin: 'created', resolutionRule: s.agent ? '프로세스 지도: 에이전트가 해요' : '프로세스 지도: 역할의 사람' }]
      const [row] = await q(`insert into todolist (id, tenant_id, user_id, username, proc_inst_id, root_proc_inst_id, execution_scope, proc_def_id, activity_id, activity_name,
                               status, tool, description, start_date, due_date, end_date, duration, assignees, reference_ids, adhoc, output)
                             values (gen_random_uuid(), $1, $2, $3, $4, $4, '', null, $5, $6, $7::todo_status, $8, '', ${tsK(made)}, ${tsK(made + DAY)}, ${end ? tsK(end) : 'null'}, 1, $9, $10, false, $11)
                             returning id::text as id`,
      [T, holder.id, holder.name, instId, aid, s.task, done ? 'DONE' : 'IN_PROGRESS', `formHandler:onto-map_${aid}_form`, JSON.stringify(assignees), prev ? [actId(prev.task)] : [],
        done ? { [`onto-map_${aid}_form`]: { result: `${s.task} 끝(시연 자료)` } } : null])
      const via = prev ? { how: 'single', from: prev.task, why: '이 흐름의 다음 단계예요' } : { how: 'entry', from: null, why: `「${s.task}」부터 시작해요` }
      await q(`insert into pro_case_steps (tenant_id, case_id, proc_inst_id, todo_id, task, kind, mode, state, why, reversible, hold_item, map_at, via, act, created_at, updated_at)
               values ($1,$2,$3,$4,$5,$6,$7,'released','{}',true,false, to_timestamp($8), $9, $10, to_timestamp($8), to_timestamp($11))`,
      [T, pc.id, instId, row.id, s.task, s.agent ? 'agent' : s.draft ? 'draft' : 'person', mode, made / 1000, via,
        { id: aid, name: s.task, role: s.role, runner: s.agent ? 'agent' : s.draft ? 'draft' : 'person', agentMode: s.agent ? 'complete' : s.draft ? 'draft' : 'none' }, (end || now) / 1000])
      if (!done) await q(`update notifications set is_checked=true where tenant_id=$1 and url=$2`, [T, `/todolist/${row.id}`]).catch(() => {})
      prev = s
      nItems++
    }
  }
  console.log(`flow-demo: 건 ${cases.length}개 · 단계 ${nItems}개를 넣었어요(열린 단계는 그 사람의 할 일에)`)
}

import crypto from 'node:crypto'
try { await main() } finally { await closeOntology().catch(() => {}); await pool.end() }
