// 온톨로지 셈하기(design-v0.2 §3.4 · §5.3): the facts (handover_events + pro_mail_history) → task names → cases →
// tasks, NEXT edges, processes and their automatic values → Ontological, written in one batch with only what changed.
// The first build of a company also writes the weeks before (each week's graph with that week as its effective date),
// so the map can be looked at as it was on a past day; later builds write today's.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { chatJson } from '../llm.js'
import { resolveLabels, consolidate, nameHabits } from './names.js'
import { cypher, readGraph } from './store.js'
import { timerHabits, writeTimers, minedTimers } from './timers.js'
import { toCases, graphOf, clusterCases, autoValues, bandOf, summaryTheta, staleness, outTimesOf, pickHalfLife, learnThreshold, END, DAY } from './stats.js'
import { structureOf, clsOf, routinesOf, artifactEvent, CLS_KO } from './structure.js'
import crypto from 'node:crypto'

const T = () => config.tenantId
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const iso = (t) => new Date(t).toISOString()
const day = (t) => iso(t).slice(0, 10)

// the role each person holds in this company (Settings › 팀·역할, every process)
async function rolesOfPeople() {
  const rows = await q(`select user_id::text as id, role from pro_role_assignments where tenant_id=$1 and proc_def_id='*'`, [T()])
  const m = new Map()
  for (const r of rows) if (!m.has(r.id)) m.set(r.id, r.role)
  return m
}

// who holds which roles (the per-process owner in pro_role_assignments and the role members, several per role) — with
// names, so a member who has done no work yet is still on the map
export async function membersOf() {
  const rows = await q(`select x.user_id::text as id, x.role, coalesce(u.username, u.email) as name, coalesce(u.is_agent,false) as agent
                          from (select user_id, role from pro_role_assignments where tenant_id=$1 and proc_def_id='*'
                                union select user_id, role from pro_role_members where tenant_id=$1) x
                          left join users u on u.id = x.user_id and u.tenant_id = $1`, [T()]).catch(() => [])
  const m = new Map()
  for (const r of rows) { if (!m.has(r.id)) m.set(r.id, { roles: new Set(), name: r.name, agent: r.agent }); m.get(r.id).roles.add(r.role) }
  return m
}

const rawOf = (r) => clean(r.activity_label) || clean(r.next_activity_label) || clean(r.instruction)

// a review is named after who reviews (Lite's recorder does the same: '<역할> 검토'), not after the words of the message:
// an approval is the reviewer's review, a request to review/approve is the review of whom it goes to
export const reviewOf = (role) => (role ? `${String(role).replace(/\s*(담당자|담당)$/, '').trim()} 검토` : null)
export function taskOf(task, act, { fromRole, toRole, fromAgent = false, toAgent = false, reviewers } = {}) {
  if (!task) return task
  if (act === 'approve' && reviewOf(fromRole) && !fromAgent) return reviewOf(fromRole)
  // a request for a review goes by the reviewer's role only when that role is one that approves (finance, not a colleague
  // asked to take another look)
  if (act === 'request' && /검토|승인/.test(task) && reviewOf(toRole) && !toAgent && (!reviewers || reviewers.has(toRole))) return reviewOf(toRole)
  return task
}

// the event log: one event per handover and per mail that is work, each as {case, task, at, who, role, source, person}
export async function loadEvents({ until } = {}) {
  const ho = await q(`select case_id, source, occurred_at, from_user_id, from_user_name, from_role, from_is_agent, to_user_id, to_user_name, to_role, to_is_agent,
                             activity_label, next_activity_label, instruction, artifact_refs
                        from handover_events where tenant_id=$1 ${until ? 'and occurred_at <= $2' : ''} order by occurred_at`, until ? [T(), until] : [T()])
  const mh = await q(`select case_id, occurred_at, owner_id::text as owner, from_addr, to_addrs, from_role, to_role, activity_label, act, attrs, artifacts
                        from pro_mail_history where tenant_id=$1 ${until ? 'and occurred_at <= $2' : ''} order by occurred_at`, until ? [T(), until] : [T()])
  const labels = await resolveLabels([...ho.map((r) => ({ raw: rawOf(r) })), ...mh.map((r) => ({ raw: r.activity_label, hint: r.act }))])
  const roles = await rolesOfPeople()
  const known = new Set([...roles.values(), ...(await q(`select distinct role from pro_role_members where tenant_id=$1`, [T()]).catch(() => [])).map((r) => r.role)])
  // the company's people and agents by address (who did a mail step) — outside people are not performers
  const people = new Map((await q(`select id::text as id, lower(email) as email, coalesce(username, email) as name, coalesce(is_agent,false) as agent from users where tenant_id=$1`, [T()]))
    .map((u) => [u.email, { id: u.id, name: u.name, agent: u.agent }]))
  const kinds = (list) => [...new Set((list || []).map((f) => clsOf(f?.name) || (['xlsx', 'docx', 'hwpx', 'pptx', 'pdf', 'dxf'].includes(f?.type) ? clsOf(`x.${f.type}`) : null)).filter(Boolean))]
  // the roles that approve something (their approvals are reviews named after them)
  const reviewers = new Set([...mh.filter((r) => (r.act || labels.get(clean(r.activity_label))?.act) === 'approve').map((r) => r.from_role),
    ...ho.filter((r) => labels.get(rawOf(r))?.act === 'approve').map((r) => r.from_role)].filter(Boolean))
  const events = []
  for (const r of ho) {
    const l = { ...(labels.get(rawOf(r)) || {}) }
    if (!l.task) continue
    l.task = taskOf(l.task, l.act, { fromRole: r.from_role, toRole: r.to_role, fromAgent: r.from_is_agent, toAgent: r.to_is_agent, reviewers })
    const toSide = l.act === 'request'
    const id = toSide ? r.to_user_id : r.from_user_id
    const isAgent = toSide ? r.to_is_agent : r.from_is_agent
    // a role written on the handover that the company does not have (a model's guess, 「영업 담당」) gives way to the person's own
    const said = toSide ? r.to_role : r.from_role
    const role = (said && known.has(said) ? said : roles.get(String(id)) || said) || (isAgent ? '에이전트' : (toSide ? r.to_user_name : r.from_user_name)) || '담당자'
    const name = toSide ? r.to_user_name : r.from_user_name
    events.push({ case: r.case_id, task: l.task, at: r.occurred_at, who: id ? String(id) : null, role, source: r.source, person: String(r.from_user_id || r.to_user_id || ''),
      arts: l.act === 'request' ? [] : kinds(r.artifact_refs), actor: id ? { id: String(id), name: name || String(id), agent: !!isAgent } : null })
  }
  for (const r of mh) {
    const l = { ...(labels.get(clean(r.activity_label)) || {}) }
    if (!l.task) continue
    const act = r.act || l.act
    l.task = taskOf(l.task, act, { fromRole: r.from_role, toRole: r.to_role, reviewers })
    const role = (act === 'request' ? r.to_role : r.from_role) || '담당자'
    const addr = String((act === 'request' ? r.to_addrs?.[0] : r.from_addr) || '').toLowerCase()
    // a result handed over by mail (the sender's work); a request's attachments are what the work starts from, not its result
    events.push({ case: r.case_id, task: l.task, at: r.occurred_at, who: addr || null, role, source: 'mail_history', person: `mail:${r.owner}`, amount: r.attrs?.amount ?? null,
      arts: act === 'request' ? [] : kinds(r.artifacts), actor: people.get(addr) || null })
  }
  return events
}

const NAME = `회사의 업무 흐름 하나에 이름을 붙입니다. JSON {"name","summary"} 로만 답하세요.
- name: 한국어 명사구 14자 이내, 가운뎃점(·)으로 두 일을 잇는 형식. 예: "설계 제안 · 견적", "계약 · 시공 준비"
- summary: 이 흐름이 무엇인지 해요체 한 문장`
async function nameProcess(tasks, entry) {
  try {
    const r = await chatJson(NAME, JSON.stringify({ steps: tasks, starts_with: entry }), { timeoutMs: 30000, temperature: 0 })
    if (r?.name) return { name: String(r.name).slice(0, 30), summary: String(r.summary || '') }
  } catch (e) { console.warn('[ontology] proc name', e.message) }
  return { name: `${entry} 흐름`, summary: '' }
}

// one state of the company's process: graph + processes with their values, as of `now`
const set0 = (b) => b.tasks.length > 0
export function stateAt(events, now, { halfLife, assigned = new Map() } = {}) {
  const evs = events.filter((e) => new Date(e.at).getTime() <= now)
  const cases = toCases(evs)
  if (!cases.length) return null
  const hl = halfLife ? { halfLife, start: false, scores: [] } : pickHalfLife(cases, { now })
  const g = graphOf(cases, { halfLife: hl.halfLife, now })
  const outs = outTimesOf(g)
  for (const e of g.edges.values()) Object.assign(e, staleness(e, outs.get(e.from)))
  // learned conditions: at a split, does the case's stated total tell the branches apart? (design §2.5)
  // the amount at a split is the one the step before it stated (the quote mail's total), not any amount in the case —
  // a customer's budget in the first mail is not the quote
  const stated = new Map() // case → [{task, at, amount}]
  for (const e of evs) if (Number.isFinite(e.amount)) { if (!stated.has(e.case)) stated.set(e.case, []); stated.get(e.case).push({ task: e.task, at: new Date(e.at).getTime(), amount: e.amount }) }
  const splits = new Map()
  for (const c of cases) c.steps.forEach((s, i) => {
    if (!splits.has(s.task)) splits.set(s.task, [])
    const said = (stated.get(c.id) || []).filter((x) => x.task === s.task && x.at >= s.at && x.at <= s.end).at(-1)
    splits.get(s.task).push({ x: said ? said.amount : NaN, y: c.steps[i + 1]?.task || END })
  })
  for (const [from, rows] of splits) {
    const c = learnThreshold(rows)
    if (!c) continue
    const won = new Intl.NumberFormat('ko-KR').format(c.threshold)
    const info = JSON.stringify({ attr: 'amount', threshold: c.threshold, accuracy: c.accuracy, loo: c.loo, baseline: c.baseline, n: c.n })
    const hi = g.edges.get(`${from}\u0000${c.high}`), lo = g.edges.get(`${from}\u0000${c.low}`)
    if (hi) Object.assign(hi, { cond: `견적 합계(amount)가 ${won}원 이상`, condInfo: info })
    if (lo) Object.assign(lo, { cond: `견적 합계(amount)가 ${won}원 미만`, condInfo: info })
  }
  const byId = new Map(cases.map((c) => [c.id, c]))
  const processes = clusterCases(cases).map((b) => {
    const bc = b.caseIds.map((id) => byId.get(id))
    const set = new Set(b.tasks)
    const firsts = new Map()
    for (const c of bc) firsts.set(c.steps[0].task, (firsts.get(c.steps[0].task) || 0) + 1)
    const entries = [...firsts].sort((x, y) => y[1] - x[1]).map(([t]) => t)
    const values = autoValues(bc, { now })
    const sub = graphOf(bc, { halfLife: hl.halfLife, now })
    return { key: `process:${crypto.createHash('sha1').update(b.key).digest('hex').slice(0, 10)}`, core: b.core, tasks: b.tasks, caseIds: b.caseIds, entries, cases: bc.length, values, band: bandOf(values), summaryTheta: summaryTheta(sub) }
  }).filter((b) => b.cases >= 2)
  return { g, cases, processes, halfLife: hl, now, structure: structureOf(cases, g, processes, { assigned }) }
}

// write a state to the graph with `validFrom` as its effective date; names: proc key → {name, summary}
// Writes split into "update what exists" (UNWIND … MATCH … SET) and "create what is new" (UNWIND … CREATE): on a temporal
// type with a key, Ontological's UNWIND … MERGE that updates an existing node collides with that key (measured: a single
// MERGE with parameters works, UNWIND + MERGE does not — reported to Ontological), so MERGE is not used for batches.
const sets = (alias, keys) => keys.map((k) => `${alias}.${k}=r.${k}`).join(', ')
const createMap = (keys, extra = []) => `{${[...keys.map((k) => `${k}:r.${k}`), ...extra].join(', ')}}`
async function upsertNodes(label, rows, keys, extra, w) {
  if (!rows.length) return
  const have = new Set((await cypher(`MATCH (x:${label}) RETURN x.key AS key`)).map((r) => r.key))
  const old = rows.filter((r) => have.has(r.key)), neu = rows.filter((r) => !have.has(r.key))
  for (let i = 0; i < old.length; i += 200) await cypher(`UNWIND $rows AS r MATCH (x:${label} {key:r.key}) SET ${sets('x', keys)}`, { rows: old.slice(i, i + 200) }, w)
  for (let i = 0; i < neu.length; i += 200) await cypher(`UNWIND $rows AS r CREATE (x:${label} ${createMap(['key', ...keys], extra)})`, { rows: neu.slice(i, i + 200) }, w)
}
async function upsertEdges(rows, keys, w) {
  if (!rows.length) return
  const have = new Set((await cypher(`MATCH (a:Task)-[e:NEXT]->(b) RETURN a.key AS from, b.key AS to`)).map((r) => `${r.from}>${r.to}`))
  for (const [target, list] of [['Task', rows.filter((r) => r.to !== END)], ['End', rows.filter((r) => r.to === END)]]) {
    const old = list.filter((r) => have.has(`${r.from}>${target === 'End' ? '__end__' : r.to}`)), neu = list.filter((r) => !have.has(`${r.from}>${target === 'End' ? '__end__' : r.to}`))
    const b = target === 'End' ? `(b:End {key:'__end__'})` : `(b:Task {key:r.to})`
    for (let i = 0; i < old.length; i += 200) await cypher(`UNWIND $rows AS r MATCH (a:Task {key:r.from})-[e:NEXT]->${b} SET ${sets('e', keys)}`, { rows: old.slice(i, i + 200) }, w)
    for (let i = 0; i < neu.length; i += 200) await cypher(`UNWIND $rows AS r MATCH (a:Task {key:r.from}), ${b} CREATE (a)-[e:NEXT ${createMap(keys, ["status:'active'", 'pinned:false'])}]->(b)`, { rows: neu.slice(i, i + 200) }, w)
  }
}

// any other relation, between two labels by their keys (the same split into update and create)
async function upsertRel(rel, fromLabel, toLabel, rows, keys, w, extra = []) {
  if (!rows.length) return
  const have = new Set((await cypher(`MATCH (a:${fromLabel})-[e:${rel}]->(b:${toLabel}) RETURN a.key AS from, b.key AS to`)).map((r) => `${r.from}>${r.to}`))
  const old = rows.filter((r) => have.has(`${r.from}>${r.to}`)), neu = rows.filter((r) => !have.has(`${r.from}>${r.to}`))
  if (keys.length) for (let i = 0; i < old.length; i += 200) await cypher(`UNWIND $rows AS r MATCH (a:${fromLabel} {key:r.from})-[e:${rel}]->(b:${toLabel} {key:r.to}) SET ${sets('e', keys)}`, { rows: old.slice(i, i + 200) }, w)
  const props = keys.length || extra.length ? ` ${createMap(keys, extra)}` : ''
  for (let i = 0; i < neu.length; i += 200) await cypher(`UNWIND $rows AS r MATCH (a:${fromLabel} {key:r.from}), (b:${toLabel} {key:r.to}) CREATE (a)-[e:${rel}${props}]->(b)`, { rows: neu.slice(i, i + 200) }, w)
}

// events, process membership, roles and performers of a state (structure.js) — events and performers have no history
async function writeStructure(S, w) {
  const now = { actor: w.actor, reason: w.reason }
  await upsertNodes('Event', S.events.map((e) => ({ key: e.key, kind: e.kind, cls: e.cls, name: e.name, n: e.n })), ['kind', 'cls', 'name', 'n'], [], now)
  await upsertRel('TRIGGERS', 'Event', 'Task', S.triggers, ['n', 'p', 'split', 'cond', 'source', 'scope', 'people'], w, ["status:'active'", 'pinned:false', 'shared:0'])
  await upsertRel('RAISES', 'Task', 'Event', S.raises, ['n', 'p'], w)
  await upsertRel('HAS_TASK', 'Process', 'Task', S.hasTask, ['n', 'share', 'entry_share'], w)
  await upsertRel('STARTS_ON', 'Process', 'Event', S.startsOn, ['n', 'share'], w)
  await upsertNodes('Role', S.roles, ['name', 'outside', 'n', 'members', 'load', 'agent_share', 'handovers_in', 'handovers_out', 'artifacts', 'tasks', 'single_tasks'], ['confirmed:false'], w)
  await upsertRel('PERFORMED_BY', 'Task', 'Role', S.performedBy, ['n', 'share'], w)
  await upsertNodes('Performer', S.performers, ['name', 'is_agent'], [], now)
  await upsertRel('PLAYS', 'Performer', 'Role', S.plays, ['n', 'share', 'assigned'], w)
}

// write a state to the graph with `validFrom` as its effective date; names: proc key → {name, summary}
async function writeState(st, validFrom, names, meta) {
  const { g, processes } = st
  // a task shown in several processes (a shared step like 고객 회신) is coloured by the one with the most cases
  // (a task's processes are read from the processes' task lists — a shared step like 고객 회신 is in several)
  const tasks = [...g.tasks.values()].map((t) => ({
    key: t.key, name: t.key, role: t.role || '', kind: 'flow', n: t.n, n_cases: t.cases.size, entry_share: t.entryShare, exit_share: t.exitShare,
    first_seen: iso(t.first), last_seen: iso(t.last), sources: JSON.stringify(Object.fromEntries(t.sources)), people: t.people.size,
  }))
  const w = { validFrom, actor: meta.actor, reason: meta.reason }
  const [end] = await cypher(`MATCH (e:End {key:'__end__'}) RETURN e.key AS key`)
  if (!end) await cypher(`CREATE (e:End {key:'__end__'})`)
  await upsertNodes('Task', tasks, ['name', 'role', 'kind', 'n', 'n_cases', 'entry_share', 'exit_share', 'first_seen', 'last_seen', 'sources', 'people'],
    ["status:'active'", 'pinned:false', 'candidate:false'], w)
  const edges = [...g.edges.values()].map((e) => ({
    from: e.from, to: e.to, n: e.n, p: e.p, share: e.share, dependency: e.dependency, w: e.w, wait_h: e.avgWaitH, ci_low: e.ci.low, ci_high: e.ci.high, thin: e.thin,
    first_seen: iso(e.firstSeen), last_seen: iso(e.lastSeen), stale: !!e.stale, expected: e.expected || 0, p_value: e.pValue ?? 1, gap_days: e.gapDays || 0,
    by_source: JSON.stringify(Object.fromEntries(e.sources)), people: e.people.size, cond: e.cond || '', cond_cases: e.condInfo || '',
    parallel: e.to !== END && Math.abs(e.dependency) < 0.34 && (g.edges.get(`${e.to}\u0000${e.from}`)?.n || 0) > 0,
  }))
  await upsertEdges(edges, ['n', 'p', 'share', 'dependency', 'w', 'wait_h', 'ci_low', 'ci_high', 'thin', 'first_seen', 'last_seen', 'stale', 'expected', 'p_value',
    'gap_days', 'by_source', 'people', 'parallel', 'cond', 'cond_cases'], w)
  const rows = processes.map((b) => ({
    key: b.key, name: names.get(b.key)?.name || b.entries[0] || b.tasks[0], summary: names.get(b.key)?.summary || '', band: b.band, theta: b.values.theta, theta_start: b.values.thetaStart,
    half_life: st.halfLife.halfLife, half_life_start: !!st.halfLife.start, a1: b.values.accuracy.top1, a3: b.values.accuracy.top3, held: b.values.heldCases,
    held_transitions: b.values.heldTransitions, curve: JSON.stringify(b.values.curve), hl_scores: JSON.stringify(st.halfLife.scores || []), tasks: b.tasks, entries: b.entries,
    cases: b.cases, summary_theta: b.summaryTheta, kind: 'flow', role: '',
  }))
  await upsertNodes('Process', rows, ['name', 'summary', 'band', 'theta', 'theta_start', 'half_life', 'half_life_start', 'a1', 'a3', 'held', 'held_transitions', 'curve',
    'hl_scores', 'tasks', 'entries', 'cases', 'summary_theta', 'kind', 'role'], ["status:'suggested'", "autonomy:'draft'"], w)
  await writeStructure(st.structure, w)
}

// personal habits (후행 습관 pro_followups · 방 규칙 pro_room_rules) → role routines (design-v0.3 §3.4): every habit is
// counted — the setting only decides what the map shows (service.js) — and the graph gets the role, the task and how many
// people, never a name or the words. A role's routine is a process of its own (kind routine) hung on the role.
// 이/가 after a Korean word (받침)
const iGa = (w) => { const c = String(w).charCodeAt(String(w).length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '이' : '가' }
const shaOf = (x) => crypto.createHash('sha1').update(String(x)).digest('hex').slice(0, 10)
const roleEvent = (role, cls) => (cls === 'link' ? { key: `link:@${role}`, kind: 'link', cls: 'link', name: `${CLS_KO.link} 올림(${role})` }
  : { key: `artifact:@${role}:${cls}`, kind: 'artifact', cls, name: `${CLS_KO[cls] || cls} 결과물(${role})` })
async function habitRoutines(final, meta, assigned) {
  const rows = await q(`select id::text as id, user_id::text as user_id, event_cls as cls, action, seen, origin from pro_followups
                          where tenant_id=$1 and (seen >= 2 or origin = 'told')`, [T()]).catch(() => [])
  const rules = await q(`select id::text as id, user_id::text as user_id, action from pro_room_rules where tenant_id=$1`, [T()]).catch(() => [])
  const shared = new Set((await q(`select followup_id::text as id from pro_habit_shares where tenant_id=$1 and answer='shared' and status <> 'withdrawn'`, [T()]).catch(() => [])).map((r) => r.id))
  // each person's role: the assignment, else the role they performed most in the cases
  const played = new Map()
  for (const p of final.structure.plays) if (!played.has(p.from) || played.get(p.from).n < p.n) played.set(p.from, { role: p.to, n: p.n })
  const roleOf = (id) => [...(assigned.get(id)?.roles || [])][0] || played.get(id)?.role || null
  // the schedules people keep (예약) are habits on a clock: timer events (timers.js, design-v0.3 §13)
  const timers = await timerHabits(roleOf)
  if (!rows.length && !rules.length && !timers.length) return { keys: [], routines: 0 }
  const goals = await nameHabits([...rows, ...rules].map((r) => r.action))
  const habits = [
    ...rows.map((r) => ({ userId: r.user_id, role: roleOf(r.user_id), cls: r.cls, task: goals.get(clean(r.action)), seen: r.seen, told: r.origin === 'told', shared: shared.has(r.id), source: r.origin === 'told' ? 'told' : 'habit' })),
    ...rules.map((r) => ({ userId: r.user_id, role: roleOf(r.user_id), cls: 'link', task: goals.get(clean(r.action)), seen: 1, told: true, shared: false, source: 'rule' })),
    ...timers,
  ]
  const routines = routinesOf(habits)
  if (!routines.length) return { keys: [], routines: 0 }
  const w = { validFrom: iso(final.now), actor: meta.actor, reason: `${meta.reason}(역할 루틴)` }
  const plain = { actor: meta.actor, reason: w.reason }
  const evs = new Map()
  for (const r of routines) { if (r.cls === 'timer') continue; const e = roleEvent(r.role, r.cls); evs.set(e.key, { ...e, n: (evs.get(e.key)?.n || 0) + r.n }); r.event = e.key }
  await upsertNodes('Event', [...evs.values()], ['kind', 'cls', 'name', 'n'], [], plain)
  const flowTasks = new Set(final.g.tasks.keys())
  const habitTasks = new Map()
  for (const r of routines) if (!flowTasks.has(r.task)) habitTasks.set(r.task, { key: r.task, name: r.task, role: r.role, kind: 'habit', n: (habitTasks.get(r.task)?.n || 0) + r.n })
  await upsertNodes('Task', [...habitTasks.values()], ['name', 'role', 'kind', 'n'], ["status:'active'", 'pinned:false', 'candidate:false'], w)
  // members of a role: who performed it in the cases, else who holds it in the assignments
  const members = new Map(final.structure.roles.map((x) => [x.key, x.members]))
  const held = new Map()
  for (const a of assigned.values()) for (const role of a.roles || []) held.set(role, (held.get(role) || 0) + 1)
  const size = (role) => Math.max(members.get(role) || 0, held.get(role) || 0)
  const byEvent = routines.filter((r) => r.cls !== 'timer')
  await upsertRel('TRIGGERS', 'Event', 'Task', byEvent.map((r) => ({ from: r.event, to: r.task, n: r.n, p: r.people / Math.max(r.people, size(r.role), 1), split: '', cond: '',
    source: r.source, scope: `role:${r.role}`, people: r.people, shared: r.shared, status: 'active' })), ['n', 'p', 'split', 'cond', 'source', 'scope', 'people', 'shared', 'status'], w, ['pinned:false'])
  // a routine step nobody does any more (or one named differently now) leaves the map, kept in the history
  const liveTrig = new Set(byEvent.map((r) => `${r.event}>${r.task}`))
  const before = await cypher(`MATCH (e:Event)-[t:TRIGGERS]->(x:Task) WHERE t.source IN $sources RETURN e.key AS from, x.key AS to, t.status AS status, t.scope AS scope`, { sources: ['habit', 'told', 'rule'] }).catch(() => [])
  // (a company's own trigger — a process timer, scope company — is not a habit and stays)
  for (const x of before) if (String(x.scope || '').startsWith('role:') && !liveTrig.has(`${x.from}>${x.to}`) && x.status !== 'gone') await cypher('MATCH (e:Event {key:$from})-[t:TRIGGERS]->(x:Task {key:$to}) SET t.status=$status RETURN e.key AS key', { from: x.from, to: x.to, status: 'gone' }, w)
  const peopleOf = (h) => routines.find((r) => r.role === h.role && r.cls === 'timer' && r.task === h.task)?.people || 1
  await writeTimers(timers.filter((h) => h.role), peopleOf, w)
  const byRole = new Map()
  for (const r of routines) { if (!byRole.has(r.role)) byRole.set(r.role, []); byRole.get(r.role).push(r) }
  const procs = [...byRole].map(([role, rs]) => ({ key: `routine:${shaOf(role)}`, name: `${role} 루틴`, summary: rs.some((r) => r.cls === 'timer') ? `${role}${iGa(role)} 결과물 뒤에 · 정해 둔 시각에 혼자 하는 일` : `${role}${iGa(role)} 결과물 뒤에 혼자 이어서 하는 일`, kind: 'routine', role,
    tasks: [...new Set(rs.map((r) => r.task))], entries: [], cases: Math.max(...rs.map((r) => r.people)), band: 'open' }))
  await upsertNodes('Process', procs, ['name', 'summary', 'kind', 'role', 'tasks', 'entries', 'cases', 'band'], ["status:'suggested'", "autonomy:'draft'", 'theta:0', 'summary_theta:0', 'half_life:0'], w)
  await upsertRel('HAS_TASK', 'Process', 'Task', procs.flatMap((p) => byRole.get(p.role).map((r) => ({ from: p.key, to: r.task, n: r.people, share: r.people / Math.max(size(p.role), r.people, 1), entry_share: 0 }))),
    ['n', 'share', 'entry_share'], w)
  // a task that left a routine (renamed, or nobody does it now) leaves its membership too
  const liveHas = new Set(procs.flatMap((p) => p.tasks.map((t) => `${p.key}>${t}`)))
  for (const x of await cypher(`MATCH (p:Process)-[h:HAS_TASK]->(t:Task) WHERE p.kind = 'routine' RETURN p.key AS p, t.key AS t`).catch(() => []))
    if (!liveHas.has(`${x.p}>${x.t}`)) await cypher('MATCH (p:Process {key:$p})-[h:HAS_TASK]->(t:Task {key:$t}) DELETE h', x, w).catch((e) => console.warn('[ontology] routine membership', e.message))
  await upsertNodes('Role', [...byRole.keys()].filter((r) => !members.has(r)).map((r) => ({ key: r, name: r })), ['name'], ['confirmed:false'], w)
  await upsertRel('OF_ROLE', 'Process', 'Role', procs.map((p) => ({ from: p.key, to: p.role, n: p.cases })), ['n'], plain)
  return { keys: procs.map((p) => p.key), routines: routines.length, roles: byRole.size }
}

// one sentence per task that has none yet (who does what) — the start-task questions name the work this way
const DESCRIBE = `회사 업무 흐름의 「일」마다 무엇을 하는 일인지 짧게 씁니다. JSON {"items":[{"name","description"}]} 로만 답하세요.
- description: 「<역할>가 … 한다」 형식의 한 문장, 20자 안팎. 앞뒤 일과 역할에서 알 수 있는 것만 쓴다.`
async function describeTasks(st, meta) {
  const have = new Map((await cypher('MATCH (t:Task) RETURN t.key AS key, t.description AS d')).map((r) => [r.key, r.d]))
  const want = [...st.g.tasks.values()].filter((t) => !have.get(t.key))
  if (!want.length) return
  const ctx = want.map((t) => ({ name: t.key, role: t.role, before: [...st.g.edges.values()].filter((e) => e.to === t.key).sort((a, b) => b.n - a.n)[0]?.from || null,
    after: [...st.g.edges.values()].filter((e) => e.from === t.key && e.to !== END).sort((a, b) => b.n - a.n)[0]?.to || null }))
  const r = await chatJson(DESCRIBE, JSON.stringify(ctx), { temperature: 0, timeoutMs: 90000 })
  const rows = (r?.items || []).filter((x) => want.some((t) => t.key === x.name) && x.description).map((x) => ({ key: x.name, description: String(x.description).slice(0, 80) }))
  if (rows.length) await cypher('UNWIND $rows AS r MATCH (t:Task {key:r.key}) SET t.description=r.description', { rows }, { actor: meta.actor, reason: '일 설명' })
}

let running = null
export function rebuild(opts = {}) { return (running ||= doBuild(opts).finally(() => { running = null })) }

async function doBuild({ actor = 'system', reason = '온톨로지 다시 셈하기', job } = {}) {
  // names first: every text gets a name, then names that mean the same work are joined
  const first = graphOf(toCases(await loadEvents()))
  const top2 = (xs) => [...xs].sort((a, b) => b.n - a.n).slice(0, 2).map((e) => e.name)
  const merged = await consolidate([...first.tasks.values()].map((t) => ({ name: t.key, count: t.n,
    before: top2([...first.edges.values()].filter((e) => e.to === t.key).map((e) => ({ name: e.from, n: e.n }))),
    after: top2([...first.edges.values()].filter((e) => e.from === t.key && e.to !== END).map((e) => ({ name: e.to, n: e.n }))) })))
  const events = await loadEvents()
  if (!events.length) return { empty: true, events: 0 }
  const now = Date.now()
  const assigned = await membersOf()
  const final = stateAt(events, now, { assigned })
  // proc names: kept when the proc is already named in the graph
  const have = new Map((await cypher('MATCH (b:Process) RETURN b.key AS key, b.name AS name, b.summary AS summary')).map((r) => [r.key, r]))
  // names are given once a proc's key is settled (and kept when the graph already has one)
  const names = new Map()
  const nameAll = async (st) => {
    for (const b of st.processes) if (!names.has(b.key)) names.set(b.key, have.get(b.key)?.name && have.get(b.key).name !== b.entries[0] ? have.get(b.key) : await nameProcess(b.tasks, b.entries[0]))
  }
  // a proc keeps its key from week to week: a cluster takes the key of the known proc it overlaps most (Jaccard ≥ 0.5)
  const known = new Map((await cypher('MATCH (b:Process) WHERE b.status <> \'gone\' RETURN b.key AS key, b.tasks AS tasks')).map((r) => [r.key, r.tasks || []]))
  const stable = (st) => {
    for (const b of st.processes) {
      let best = null, score = 0
      for (const [k, tasks] of known) {
        const inter = b.tasks.filter((t) => tasks.includes(t)).length
        const j = inter / new Set([...b.tasks, ...tasks]).size
        if (j > score) { score = j; best = k }
      }
      if (best && score >= 0.5 && !st.processes.some((x) => x !== b && x.key === best)) b.key = best
      known.set(b.key, b.tasks)
    }
  }
  const [m] = await cypher(`MATCH (m:Meta {key:'meta'}) RETURN m.backfilled AS backfilled`)
  const meta = { actor, reason }
  let weeks = 0
  if (!m?.backfilled) {
    // the weeks before: what the graph would have said at the end of each week (effective date = that day)
    const start = final.g.first
    for (let t = start + 14 * DAY; t < now - DAY; t += 7 * DAY) {
      const st = stateAt(events, t, { halfLife: final.halfLife.halfLife, assigned })
      if (!st) continue
      stable(st)
      await nameAll(st)
      await writeState(st, day(t), names, { ...meta, reason: `${reason}(지난 기록 ${day(t)})` })
      weeks++
      if (job) await q('update pro_onto_jobs set detail = detail || $2 where id=$1', [job, { weeks }]).catch(() => {})
    }
  }
  stable(final)
  await nameAll(final)
  await writeState(final, iso(now), names, meta)
  await describeTasks(final, meta).catch((e) => console.warn('[ontology] describe', e.message))
  const habits = await habitRoutines(final, meta, assigned).catch((e) => { console.warn('[ontology] routines', e.message); return { keys: [], routines: 0 } })
  // work the mail does at set times (a weekly report, a month-end statement): timer events with no clock yet (timers.js)
  await minedTimers({ validFrom: iso(now), actor: meta.actor, reason: `${meta.reason}(메일의 정해진 때)` }, { tasks: new Set(final.g.tasks.keys()) })
    .catch((e) => console.warn('[ontology] mined timers', e.message))
  // processes of earlier weeks that are not in today's picture are gone (kept in the history, hidden on the map)
  const live = [...final.processes.map((b) => b.key), ...habits.keys]
  await cypher(`MATCH (b:Process) WHERE NOT b.key IN $live AND b.status <> 'gone' SET b.status='gone'`, { live }, { ...meta, validFrom: iso(now) })
  const sources = {}
  for (const e of events) sources[e.source] = (sources[e.source] || 0) + 1
  await cypher(`MERGE (m:Meta {key:'meta'}) SET m.built_at=$at, m.events=$events, m.cases=$cases, m.data_start=$ds, m.data_end=$de, m.sources=$sources,
                m.values=$values, m.backfilled=true`, {
    at: iso(now), events: events.length, cases: final.cases.length, ds: iso(final.g.first), de: iso(final.g.last), sources: JSON.stringify(sources),
    values: JSON.stringify({ halfLife: final.halfLife.halfLife, halfLifeStart: !!final.halfLife.start, halfLifeScores: final.halfLife.scores, tested: final.halfLife.tested }),
  })
  return { events: events.length, cases: final.cases.length, tasks: final.g.tasks.size, edges: final.g.edges.size, processes: final.processes.length, weeks, sources, merged,
    happenings: final.structure.events.length, roles: final.structure.roles.length, routines: habits.routines }
}

export { readGraph }
