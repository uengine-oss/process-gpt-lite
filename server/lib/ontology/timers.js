// 타이머 사건(design-v0.3 §13): 정해 둔 시각이 일의 시작이 되는 사건. 사람이 걸어 둔 예약(pro_schedules — 스킬 · 프로세스 ·
// 할 일)과 회사가 프로세스에 건 타이머가 모두 그래프의 Event(kind timer)로 남고, 그래프가 기준(source of truth)이다:
// pg_cron(lib/scheduler.js)은 「이 사건이 울렸다」만 알리고, 지금 켜져 있는지 · 울리면 무엇을 시작할지는 그래프를 읽어 정한다.
//   사람의 예약   timer:<schedule id>       —TRIGGERS(source timer, scope role:<역할>)→ 일   그 역할 루틴의 한 단계(습관과 같은 공개 기준)
//   회사의 타이머 timer:proc:<sha>          —TRIGGERS(source told, scope company)→ 시작 일 · 프로세스 —STARTS_ON→ 사건
// 그래프에는 역할 · 일 이름 · 주기 · 사람 수만 쓴다(예약의 이름 · 프롬프트는 그 사람 것이라 pro_schedules 에만).
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { addMessage, mainThread } from '../store.js'
import { cypher, ontologyEnabled } from './store.js'
import { nameHabits } from './names.js'
import { periodOf, cronOfHint } from './mailbody.js'
import { prompt, rules as skillRules } from './discovery.js'
import { chatJson } from '../llm.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const shaOf = (x) => crypto.createHash('sha1').update(String(x)).digest('hex').slice(0, 10)
const TZ = 'Asia/Seoul'
const DOW = ['일', '월', '화', '수', '목', '금', '토']

// 5칸 cron(KST) → 사람이 읽는 주기: 「매일 12시 · 21시」 「평일 9시」 「매주 월 9시 30분」 「매월 1일 9시」 「10분마다」
export function cronKo(cron) {
  const f = String(cron || '').trim().split(/\s+/)
  if (f.length !== 5) return String(cron || '')
  const [mi, ho, dom, mon, dow] = f
  if (/^\*\/\d+$/.test(mi) && ho === '*') return `${mi.slice(2)}분마다`
  if (!/^[\d,]+$/.test(mi) || mon !== '*') return cron
  const at = ho === '*' ? `매시 ${mi}분` : /^[\d,]+$/.test(ho) ? ho.split(',').map((h) => `${Number(h)}시${Number(mi) ? ` ${Number(mi)}분` : ''}`).join(' · ') : null
  if (!at) return cron
  if (dom === '*' && dow === '*') return ho === '*' ? at : `매일 ${at}`
  if (dom === '*' && dow === '1-5') return `평일 ${at}`
  if (dom === '*' && /^[\d,]+$/.test(dow)) return `매주 ${dow.split(',').map((d) => DOW[Number(d) % 7]).join('·')} ${at}`
  if (/^\d+$/.test(dom) && dow === '*') return `매월 ${Number(dom)}일 ${at}`
  return cron
}

// one node or relation by key: update what exists, create what is new (Ontological's MERGE on a temporal keyed type, build.js)
async function putNode(label, key, props, w, created = {}) {
  const [have] = await cypher(`MATCH (x:${label} {key:$key}) RETURN x.key AS key`, { key })
  const names = Object.keys(props)
  if (have) { if (names.length) await cypher(`MATCH (x:${label} {key:$key}) SET ${names.map((k) => `x.${k}=$${k}`).join(', ')} RETURN x.key AS key`, { key, ...props }, w); return false }
  const all = { ...props, ...created }
  await cypher(`CREATE (x:${label} {key:$key${Object.keys(all).map((k) => `, ${k}:$${k}`).join('')}}) RETURN x.key AS key`, { key, ...all }, w)
  return true
}
async function putRel(rel, from, to, props, w) {
  const [a, b] = from, [c, d] = to
  const names = Object.keys(props)
  const [have] = await cypher(`MATCH (a:${a} {key:$from})-[r:${rel}]->(b:${c} {key:$to}) RETURN a.key AS key`, { from: b, to: d })
  if (have) { if (names.length) await cypher(`MATCH (a:${a} {key:$from})-[r:${rel}]->(b:${c} {key:$to}) SET ${names.map((k) => `r.${k}=$${k}`).join(', ')} RETURN a.key AS key`, { from: b, to: d, ...props }, w); return }
  await cypher(`MATCH (a:${a} {key:$from}), (b:${c} {key:$to}) CREATE (a)-[r:${rel} {${names.map((k) => `${k}:$${k}`).join(', ')}}]->(b) RETURN a.key AS key`, { from: b, to: d, ...props }, w)
}

// ---------- 사람의 예약 ----------
// the company's schedules (pro_schedules has no tenant: its owners do); a company timer's own row is not a person's habit
async function schedulesOf(ids) {
  return q(`select s.id::text as id, s.user_id::text as user_id, s.name, s.cron, coalesce(s.paused, false) as paused, s.skill, s.process_id,
                   (select count(*) from pro_mission_runs r where r.schedule_id = s.id)::int as runs
              from pro_schedules s
             where exists (select 1 from users u where u.id::text = s.user_id::text and u.tenant_id = $1)
               and coalesce(s.params->>'onto_event', '') = '' and s.prompt not like '(타이머 사건 %' ${ids ? 'and s.id::text = any($2)' : ''}`, ids ? [T(), ids] : [T()])
}

// the schedules as habit rows for the role routines (build.js habitRoutines): one per schedule, named as the work it does
export async function timerHabits(roleOf) {
  const rows = await schedulesOf().catch(() => [])
  if (!rows.length) return []
  const goals = await nameHabits(rows.map((r) => r.name))
  return rows.map((r) => ({ userId: r.user_id, role: roleOf(r.user_id), cls: 'timer', task: goals.get(clean(r.name)), seen: r.runs, told: true, shared: false, source: 'timer', schedule: r }))
    .filter((h) => h.task)
}

// write the timer events of the schedules (habit rows from timerHabits, with people = how many of the role keep a timer for
// the same work); a schedule that no longer exists leaves the map, kept in the history
export async function writeTimers(habits, peopleOf, w) {
  const live = new Set()
  for (const h of habits) { live.add(`timer:${h.schedule.id}`); await writeTimer(h, peopleOf(h), w) }
  for (const x of await cypher(`MATCH (e:Event)-[t:TRIGGERS]->(x:Task) WHERE t.source = 'timer' RETURN e.key AS from, x.key AS to, t.status AS status`).catch(() => [])) {
    if (live.has(x.from) || x.status === 'gone') continue
    await cypher('MATCH (e:Event {key:$from})-[t:TRIGGERS]->(x:Task {key:$to}) SET t.status=$status RETURN e.key AS key', { from: x.from, to: x.to, status: 'gone' }, w)
    await cypher('MATCH (e:Event {key:$from}) SET e.status=$status RETURN e.key AS key', { from: x.from, status: 'gone' }, { actor: w.actor, reason: w.reason })
  }
  return live.size
}

// a schedule made, paused or removed: its timer event right away (the next count adds it to the role routine)
export async function syncSchedule(id, { actor = 'system' } = {}) {
  if (!ontologyEnabled()) return null
  const w = { validFrom: new Date().toISOString(), actor, reason: '예약 → 타이머 사건' }
  const [s] = await schedulesOf([String(id)])
  if (!s) {
    await cypher(`MATCH (e:Event {key:$key})-[t:TRIGGERS]->(x:Task) SET t.status='gone' RETURN e.key AS key`, { key: `timer:${id}` }, w).catch(() => [])
    await cypher(`MATCH (e:Event {key:$key}) SET e.status='gone' RETURN e.key AS key`, { key: `timer:${id}` }, { actor, reason: w.reason }).catch(() => [])
    return { key: `timer:${id}`, status: 'gone' }
  }
  const { roleOfUser } = await import('./ways.js')
  const role = await roleOfUser(s.user_id)
  const task = (await nameHabits([s.name])).get(clean(s.name))
  if (!task) return null
  const h = { userId: s.user_id, role, task, schedule: s }
  // people: the role's members who keep a timer for the same work (as counted at the last map count, at least this one)
  const [c] = await cypher(`MATCH (e:Event)-[t:TRIGGERS]->(x:Task {key:$task}) WHERE t.source = 'timer' AND t.scope = $scope AND t.status <> 'gone' RETURN max(t.people) AS people`,
    { task: h.task, scope: role ? `role:${role}` : 'person' }).catch(() => [])
  await writeTimer(h, Math.max(1, c?.people || 0), w)
  // the step joins its role's routine right away (the next count recounts it): the map shows it where the role's routine is
  if (role) await joinRoutine(role, h.task, w).catch((e) => console.warn('[ontology] routine join', e.message))
  return { key: `timer:${s.id}`, task: h.task, status: s.paused ? 'paused' : 'active' }
}
async function writeTimer(h, people, w) {
  const s = h.schedule, key = `timer:${s.id}`, scope = h.role ? `role:${h.role}` : 'person', status = s.paused ? 'paused' : 'active'
  await putNode('Event', key, { kind: 'timer', cls: '', name: cronKo(s.cron), n: s.runs, cron: s.cron, tz: TZ, status, scope, schedule: s.id }, { actor: w.actor, reason: w.reason })
  await putNode('Task', h.task, {}, w, { name: h.task, role: h.role || '', kind: 'habit', n: s.runs, status: 'active', pinned: false, candidate: false })
  await putRel('TRIGGERS', ['Event', key], ['Task', h.task], { n: s.runs, p: 1, split: '', cond: '', source: 'timer', scope, people, shared: 0, status, pinned: false, autonomy: 'auto' }, w)
}

// a role's routine (build.js habitRoutines: routine:<sha(role)>, 「<역할> 루틴」) gets the task — made if the role has none yet
async function joinRoutine(role, task, w) {
  const key = `routine:${shaOf(role)}`
  const [p] = await cypher('MATCH (b:Process {key:$key}) RETURN b.tasks AS tasks, b.status AS status', { key })
  if (!p) {
    await cypher(`CREATE (b:Process {key:$key, name:$name, summary:$summary, kind:'routine', role:$role, tasks:$tasks, entries:$entries, cases:1, band:'open',
                   status:'suggested', autonomy:'draft', theta:0, summary_theta:0, half_life:0}) RETURN b.key AS key`,
      { key, name: `${role} 루틴`, summary: `${role}의 정해 둔 시각에 혼자 하는 일`, role, tasks: [task], entries: [] }, w)
    await putRel('OF_ROLE', ['Process', key], ['Role', role], { n: 1 }, { actor: w.actor, reason: w.reason }).catch(() => {})
  } else {
    const tasks = [...new Set([...(p.tasks || []), task])]
    await cypher('MATCH (b:Process {key:$key}) SET b.tasks=$tasks, b.status=$status RETURN b.key AS key', { key, tasks, status: p.status === 'gone' ? 'suggested' : p.status }, w)
  }
  await putRel('HAS_TASK', ['Process', key], ['Task', task], { n: 1, share: 0, entry_share: 0 }, w)
}

// when pg_cron rings a schedule: does the graph still say it runs? (paused or gone there → the run is skipped, and the
// schedule row follows the graph). No timer event yet (made before the ontology) → it runs as it always did.
export async function timerOn(scheduleId) {
  if (!ontologyEnabled()) return true
  const [e] = await cypher('MATCH (e:Event {key:$key}) RETURN e.status AS status', { key: `timer:${scheduleId}` }).catch(() => [])
  if (!e || !e.status || e.status === 'active') return true
  await q('update pro_schedules set paused=true where id::text=$1', [String(scheduleId)]).catch(() => {})
  return false
}

// ---------- 회사의 타이머: 정해 둔 시각에 프로세스를 시작 ----------
export async function addProcessTimer(me, { proc, entry, cron, name }) {
  const { createSchedule } = await import('../scheduler.js')
  const [p] = await cypher('MATCH (b:Process {key:$proc}) RETURN b.key AS key, b.name AS name, b.kind AS kind, b.tasks AS tasks, b.entries AS entries', { proc })
  if (!p || p.kind === 'routine') throw err(404, '프로세스를 찾지 못했어요.')
  const start = entry || (p.entries || [])[0] || (p.tasks || [])[0]
  if (!start || !(p.tasks || []).includes(start)) throw err(400, '시작할 일을 이 프로세스의 일 중에서 골라 주세요.')
  if (cronKo(cron) === cron && String(cron).trim().split(/\s+/).length !== 5) throw err(400, '주기를 읽지 못했어요(분 시 일 월 요일).')
  const key = `timer:proc:${shaOf(`${proc}|${start}|${cron}`)}`
  const w = { validFrom: new Date().toISOString(), actor: me.email || String(me.id), reason: `프로세스 타이머 — ${p.name}` }
  await putNode('Event', key, { kind: 'timer', cls: '', name: cronKo(cron), n: 0, cron, tz: TZ, status: 'active', scope: 'company', schedule: '' }, { actor: w.actor, reason: w.reason })
  await putRel('TRIGGERS', ['Event', key], ['Task', start], { n: 0, p: 1, split: '', cond: '', source: 'told', scope: 'company', people: 0, shared: 0, status: 'active', pinned: true, autonomy: 'process' }, w)
  await putRel('STARTS_ON', ['Process', proc], ['Event', key], { n: 0, share: 0 }, w)
  // the clock: one pg_cron job that only says which event rang
  const s = await createSchedule({ userId: me.id, name: name || `${p.name} · ${cronKo(cron)}`, cron, prompt: `(타이머 사건 ${key})`, threadId: null })
  await q(`update pro_schedules set params = coalesce(params, '{}'::jsonb) || $2::jsonb, notify='never' where id=$1`, [s.id, JSON.stringify({ onto_event: key, proc, entry: start })])
  await cypher('MATCH (e:Event {key:$key}) SET e.schedule=$id RETURN e.key AS key', { key, id: s.id }, { actor: w.actor, reason: w.reason })
  const { ledger } = await import('./review.js')
  await ledger(me, 'ontology.timer', `타이머: ${p.name} — ${cronKo(cron)}에 「${start}」부터`, { process: proc, entry: start, cron, event: key })
  return { key, proc, entry: start, cron, when: cronKo(cron), scheduleId: s.id }
}

export async function setTimerStatus(me, key, status) {
  if (!['active', 'paused', 'gone'].includes(status)) throw err(400, 'status 는 active · paused · gone 중 하나예요.')
  const [e] = await cypher('MATCH (e:Event {key:$key}) WHERE e.kind = $kind RETURN e.schedule AS schedule, e.name AS name', { key, kind: 'timer' })
  if (!e) throw err(404, '타이머를 찾지 못했어요.')
  const w = { validFrom: new Date().toISOString(), actor: me.email || String(me.id), reason: `타이머 ${status === 'active' ? '켬' : status === 'paused' ? '멈춤' : '지움'}` }
  await cypher('MATCH (e:Event {key:$key}) SET e.status=$status RETURN e.key AS key', { key, status }, { actor: w.actor, reason: w.reason })
  await cypher('MATCH (e:Event {key:$key})-[t:TRIGGERS]->(x:Task) SET t.status=$status RETURN e.key AS key', { key, status }, w).catch(() => [])
  // the clock follows the graph
  if (e.schedule) {
    if (status === 'gone') {
      const [s] = await q('select user_id::text as user_id from pro_schedules where id::text=$1', [e.schedule])
      if (s) await (await import('../scheduler.js')).deleteSchedule(s.user_id, e.schedule)
    } else await q('update pro_schedules set paused=$2 where id::text=$1', [e.schedule, status === 'paused'])
  }
  const { ledger } = await import('./review.js')
  await ledger(me, status === 'active' ? 'ontology.timer_on' : status === 'paused' ? 'ontology.timer_pause' : 'ontology.timer_off', `타이머 ${status === 'active' ? '켬' : status === 'paused' ? '멈춤' : '지움'}: ${e.name}`, { event: key, status })
  return { key, status }
}

// pg_cron rang a company timer: what to do is read from the graph — the process its event starts and how far the process is
// promoted (자동 → a case starts and its person steps arrive as drafts; 제안 → the owner is asked; 관찰 → nothing)
export async function fireTimer(s) {
  const key = s.params?.onto_event
  const [e] = await cypher('MATCH (e:Event {key:$key}) RETURN e.status AS status, e.name AS name', { key })
  if (!e || e.status !== 'active') return { ok: true, changed: false, summary: `타이머가 ${e ? '멈춰' : '지워져'} 있어 시작하지 않았어요.` }
  const [t] = await cypher('MATCH (b:Process)-[:STARTS_ON]->(e:Event {key:$key})-[r:TRIGGERS]->(x:Task) WHERE r.status = $active RETURN b.key AS proc, b.name AS name, b.status AS status, x.key AS entry',
    { key, active: 'active' })
  if (!t) return { ok: true, changed: false, summary: '타이머가 시작할 프로세스가 없어요.' }
  await cypher('MATCH (e:Event {key:$key}) SET e.n = e.n + 1 RETURN e.key AS key', { key }, { actor: 'timer', reason: '타이머 울림' }).catch(() => [])
  const [p] = await q('select email, name from pro_profile where user_id=$1', [s.user_id])
  const thread = await mainThread(s.user_id)
  const subject = `${t.name} · ${e.name}`
  const choice = { proc: t.proc, task: t.entry, p: 1, measured: false, procName: t.name, options: [{ task: t.entry, p: 1 }] }
  if (t.status === 'adopted') {
    const { startCase } = await import('./run.js')
    const r = await startCase({ id: s.user_id, email: p?.email }, { procKey: t.proc, entry: t.entry, subject, body: `정해 둔 시각(${e.name})에 시작한 건`, from: '', customer: '', odds: choice, kind: 'timer' })
    await addMessage(s.user_id, thread.id, 'agent', 'onto-entry', { state: 'started', source: 'timer', when: e.name, mail: { from: '', subject }, customer: '', choice, caseId: r.caseId, instId: r.instId,
      skipped: r.snapshot.skipped, nodes: r.snapshot.nodes, procDefId: r.snapshot.procDefId })
    return { ok: true, changed: true, summary: `「${t.name}」을 「${t.entry}」부터 시작했어요.`, caseId: r.caseId }
  }
  if (t.status === 'suggested') {
    await addMessage(s.user_id, thread.id, 'agent', 'onto-entry', { state: 'ask', source: 'timer', when: e.name, suggest: true, mail: { from: '', subject, text: '' }, customer: '', choice: { ...choice, suggest: true, ask: true } })
    return { ok: true, changed: true, summary: `「${t.name}」을 시작할지 물었어요(제안 단계).` }
  }
  return { ok: true, changed: false, summary: `「${t.name}」은 관찰 단계라 시작하지 않았어요.` }
}

// ---------- 메일에서 찾은 정해진 때 (design-v0.3 §15) ----------
// 같은 일을 같은 역할이 같은 상대에게 보낸 메일의 날짜가 규칙적이거나(periodOf), 메일이 그 일을 정해진 때마다 한다고 말하면
// (지난 메일 읽기의 recur) 그 일의 타이머 사건이다. 시계는 없다(schedule '') — 관리자가 「이 주기로 타이머 걸기」로 건다.
const mode = (xs) => { const n = new Map(); for (const x of xs) n.set(x, (n.get(x) || 0) + 1); return [...n].sort((a, b) => b[1] - a[1])[0] || [null, 0] }
export async function minedTimers(w, { tasks } = {}) {
  const rows = await q(`select activity_label as raw, coalesce(from_role,'') as from_role, coalesce(to_role,'') as to_role, act, occurred_at, from_addr, to_addrs[1] as to_addr, attrs->'recur' as recur
                          from pro_mail_history where tenant_id=$1 and activity_label <> '' and act in ('deliver','notify','request')`, [T()])
  const names = new Map((await q(`select raw, task from pro_onto_labels where tenant_id=$1 and task <> ''`, [T()])).map((r) => [r.raw, r.task]))
  const known = tasks || new Set((await cypher('MATCH (t:Task) RETURN t.key AS key')).map((r) => r.key))
  // a mail's recurrence belongs to the work that repeats, which may not be the mail's own work (「매주 공정 보고를 보내 주세요」 is a
  // request mail about the weekly report): the reader names it (recur.task), matched to the map's task names
  const flat = (s) => String(s || '').replace(/\s+/g, '')
  const taskOf = (raw) => { const n = names.get(raw) || raw; if (known.has(n)) return n; const f = flat(n); return [...known].find((k) => f && (flat(k) === f || f.includes(flat(k)) || flat(k).includes(f))) || null }
  const hintsOf = new Map()
  for (const r of rows) {
    if (!r.recur?.every) continue
    const own = names.get(r.raw) || r.raw
    const target = r.recur.task ? taskOf(r.recur.task) : own
    if (!target) continue
    if (!hintsOf.has(target)) hintsOf.set(target, [])
    hintsOf.get(target).push(r.recur)
  }
  const series = new Map()
  for (const r of rows) {
    const task = names.get(r.raw) || r.raw
    // who does it: the sender of a result or a notice; for a request, the one asked
    const role = r.act === 'request' ? r.to_role : r.from_role
    if (!known.has(task) || !role || role === '고객' || role === '담당자') continue
    // the counterpart: someone outside by their (masked) address — a report to one customer is a series, replies to many are cases
    const other = r.act === 'request' ? (r.from_role === '고객' ? r.from_addr : r.from_role) : (r.to_role === '고객' ? r.to_addr : r.to_role)
    const k = `${task}\u0000${role}\u0000${other}`
    if (!series.has(k)) series.set(k, { task, role, dates: [], hints: [], people: new Set() })
    const s = series.get(k)
    s.dates.push(r.occurred_at); s.people.add(r.act === 'request' ? r.to_role : r.from_addr)
  }
  for (const s of series.values()) s.hints = hintsOf.get(s.task) || []
  const { period } = await skillRules()
  const found = new Map()
  for (const s of series.values()) {
    const p = periodOf(s.dates, period)
    const [hint] = mode(s.hints.map(cronOfHint).filter(Boolean))
    const cron = p?.cron || hint
    if (!cron) continue
    const key = `timer:mined:${shaOf(`${s.task}|${s.role}|${cron}`)}`
    // the phrase that says when (「매주 월요일 오전 9시 반까지」) rather than one that only names the work
    const phrases = s.hints.map((h) => String(h.says || '').slice(0, 40)).filter(Boolean)
    const says = phrases.find((x) => /매\s?(일|주|월)|요일|\d+\s*(시|일)|마다/.test(x)) || phrases[0] || ''
    const x = found.get(key) || { key, task: s.task, role: s.role, cron, n: 0, regular: 0, people: 0, says, agree: false }
    x.n += s.dates.length; x.regular = Math.max(x.regular, p?.regular || (hint ? 1 : 0)); x.people = Math.max(x.people, s.people.size); x.agree ||= !!(p && hint && p.cron === hint)
    found.set(key, x)
  }
  for (const x of found.values()) {
    await putNode('Event', x.key, { kind: 'timer', cls: '', name: cronKo(x.cron), n: x.n, cron: x.cron, tz: TZ, status: 'active', scope: `role:${x.role}`, schedule: '' }, { actor: w.actor, reason: w.reason })
    await putRel('TRIGGERS', ['Event', x.key], ['Task', x.task], { n: x.n, p: Math.round(x.regular * 100) / 100, split: '', cond: x.says, source: 'mined', scope: `role:${x.role}`, people: x.people, shared: 0, status: 'active', pinned: false, autonomy: 'suggest' }, w)
  }
  for (const r of await cypher(`MATCH (e:Event)-[t:TRIGGERS]->(x:Task) WHERE t.source = 'mined' AND e.kind = 'timer' RETURN e.key AS key, t.status AS status`).catch(() => [])) {
    if (found.has(r.key) || r.status === 'gone') continue
    await cypher(`MATCH (e:Event {key:$key})-[t:TRIGGERS]->(x:Task) SET t.status='gone' RETURN e.key AS key`, { key: r.key }, w)
    await cypher(`MATCH (e:Event {key:$key}) SET e.status='gone' RETURN e.key AS key`, { key: r.key }, { actor: w.actor, reason: w.reason })
  }
  return [...found.values()]
}

// ---------- 들어온 메일이 정해진 때마다 하는 일일 때 ----------
// 「앞으로 매주 월요일 오전에 공정 보고 부탁드립니다」: 규칙으로 먼저 거르고(모델 없음), 걸린 메일만 모델이 읽어 그 일과 때를
// 정한다. 받은 사람에게 「예약을 걸까요?」를 묻고, 걸면 그 사람의 예약 = 타이머 사건(위)이 된다.
// prompt: the process-discovery skill's prompts/incoming-recurrence.md
export async function recurFromMail(userId, mail) {
  const R = await skillRules()
  if (!ontologyEnabled() || !new RegExp(R.incoming.prefilter, 'i').test(`${mail.subject || ''}\n${mail.text || ''}`)) return null
  const r = await chatJson(await prompt('incoming-recurrence'), JSON.stringify({ from: mail.from, subject: mail.subject, text: String(mail.text || '').slice(0, 2500) }), { temperature: 0, timeoutMs: 60000 }).catch(() => null)
  const cron = r?.recurring ? cronOfHint(r) : null
  if (!cron || !String(r.task || '').trim()) return null
  const t = await mainThread(userId)
  return addMessage(userId, t.id, 'agent', 'onto-timer', { state: 'ask', task: String(r.task).trim().slice(0, 30), cron, when: cronKo(cron), says: String(r.says || '').slice(0, 60),
    mail: { from: mail.from, subject: mail.subject, id: mail.id } })
}
export async function acceptMailTimer(me, messageId) {
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2 and m.kind='onto-timer'`, [messageId, me.id])
  if (!m) throw err(404, '카드를 찾지 못했어요.')
  if (m.content.state !== 'ask') return m.content
  const c = m.content
  const { createSchedule } = await import('../scheduler.js')
  const s = await createSchedule({ userId: me.id, name: c.task, cron: c.cron, prompt: `${c.task} — 메일 「${c.mail?.subject || ''}」에서 정해진 때마다 해 달라고 한 일이에요(${c.says}). 지난번에 한 것을 바탕으로 이번 것을 만들어 주세요.`, threadId: m.thread_id })
  const { updateMessage } = await import('../store.js')
  const next = { ...c, state: 'scheduled', scheduleId: s.id }
  await updateMessage(me.id, m.id, next)
  return next
}
