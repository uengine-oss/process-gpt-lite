// 지도에서 바로 실행(engine = 'map'): 건을 프로세스 정의 없이 회사 프로세스 지도에서 곧바로 돌리는 두 번째 방식(sql/044).
//   프로세스 정의로(bpm, 기존 — run.js snapshot): 건이 들어오면 지도를 펼쳐 proc_def 를 만들고 completion 엔진이 돌린다. 오래 걸리는 건은
//     시작한 날의 정의에 묶이고, 옮기기 · 되감기는 인스턴스를 닫고 새로 연다(건 하나 = 인스턴스 여럿).
//   지도에서 바로(map): Lite 가 단계마다 todolist 행을 넣고(엔진 호출 · proc_def · bpm_proc_inst 없음), 단계가 끝날 때마다 지도를 읽어
//     다음 단계를 정한다 — unfold 와 같은 거름(θ · 고정 · 다듬기에서 정한 길 · 은퇴 · 꼭), 갈래가 하나면 그쪽, 갈림길이면 배운 금액 조건 →
//     글로 쓴 갈림길 조건(단계 규칙과 같은 읽기, steprule.js readYes) → 가장 흔한 길, 나란히 하는 두 일(parallel)은 둘 다 넣고 둘 다
//     끝나야 그다음(합류), 나갈 길이 없거나 끝이면 건이 끝난다. 건 하나 = 인스턴스 하나(옮기기 · 되감기도 같은 인스턴스 안에서).
// 단계마다 어느 지도로 정했는지(pro_case_steps.map_at)와 어떻게 정했는지(via)가 남는다. 기본은 「끝난 단계는 그대로, 다음 단계는 그때의
// 지도」, 관리자가 건마다 시작한 날의 지도로 고정할 수 있다(map_pin). 꼭 · 선택 · 단계 분류(간선 설정, edgecond.js)는 고정과 상관없이
// 단계가 열릴 때의 설정을 읽는다 — 설정을 바꾸면 이미 실행 중인 건의 다음 단계부터 적용된다(edge-step-condition).
// 관문(runmode.js gateStep) · 실행 방식 · 기다림 · 단계 규칙 · 문서 단계 · 점검 항목은 그대로 쓴다: 스냅샷의 activities 에 있던 것(스킬 ·
// 점검 · 지시 · 맡는 이 · 초안)은 행을 넣을 때 일 정의(taskDefinition)에서 뽑아 pro_case_steps.act 에 둔다.
// 공용 테이블에 쓰는 것: todolist 행(단계마다 하나 — 넣기 · 끝내기 · 옮기며 닫기)과 건마다 bpm_proc_inst 한 행(syncInst — 제목 · 시작한 사람과
// 맡은 사람 · 지금 단계 · 상태 · 역할마다 맡은 사람, 옮기기 · 되감기도 같은 행). proc_def · form_def 는 쓰지 않는다(proc_def_id 는 비워 둔다 —
// 본판 화면은 정의 없는 인스턴스를 칸반으로 연다, completion 은 정의를 인스턴스 id 의 앞부분으로 찾아 이 행을 돌리지 않는다).
// 시각: todolist · bpm_proc_inst 의 날짜 열(timestamp without time zone)은 엔진(completion)처럼 한국 시각으로 쓴다(NOW_KST).
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { cancelSet, statusSql, notCancelledSql } from '../enums.js'
import { mainThread, addMessage, updateMessage } from '../store.js'
import { rules as skillRules } from './discovery.js'
import { ledger } from './review.js'
import { END } from './stats.js'
import { taskDefinition } from './taskdef.js'
import { procGraph, unfold, parallelPair, skippedOf, triggerOf, agentId, actId, getCase, ORCH } from './run.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const iso = (d = new Date()) => new Date(d).toISOString()
const pct = (p) => `${Math.round((p || 0) * 100)}%`
const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
const fin = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0 }
const eul = (w) => (fin(w) ? '을' : '를')
const eun = (w) => (fin(w) ? '은' : '는')
const ro = (w) => { const f = fin(w); return f && f !== 8 ? '으로' : '로' }

// the engine writes Korea's wall clock into these columns (completion: datetime.now(Asia/Seoul)); the database's own clock is UTC, so
// now() there read 9 hours early in 「앞선 진행」(끝남 06:59 for 15:59)
export const NOW_KST = `(now() at time zone 'Asia/Seoul')`
export const ENGINES = ['bpm', 'map']
export const ENGINE_KO = { bpm: '프로세스 정의로(기존)', map: '지도에서 바로' }
export const MAP_PREFIX = 'onto-map.'
// a map case's one instance id (no engine instance behind it)
export const isMapInst = (id) => String(id || '').startsWith(MAP_PREFIX)
const rulesOf = async () => (await skillRules()).mapEngine || {}

// ---------- the engine (회사 설정 — PRO_ONTO_ENGINE 이 이긴다) ----------
const envEngine = () => { const e = String(process.env.PRO_ONTO_ENGINE || '').trim(); return ENGINES.includes(e) ? e : null }
export async function engineOf() {
  if (envEngine()) return { engine: envEngine(), from: 'env' }
  const [r] = await q(`select engine from pro_run_settings where tenant_id=$1`, [T()]).catch(() => [])
  if (ENGINES.includes(r?.engine)) return { engine: r.engine, from: 'tenant' }
  const R = await rulesOf()
  return { engine: ENGINES.includes(R.default) ? R.default : 'bpm', from: 'product' }
}
export async function engineView(me) {
  const e = await engineOf()
  const { isAdmin } = await import('./service.js')
  return { ...e, name: ENGINE_KO[e.engine], names: ENGINE_KO, env: envEngine(), admin: me ? await isAdmin(me).catch(() => false) : false }
}
// engine null: back to the product's default (a row kept only for the engine goes)
export async function setEngine(me, engine) {
  if (engine !== null && !ENGINES.includes(engine)) throw err(400, 'engine 은 bpm · map 이거나 비워 두세요(제품 기본값).')
  const was = (await engineOf()).engine
  if (engine) await q(`insert into pro_run_settings (tenant_id, default_mode, engine, updated_by, updated_at) values ($1, null, $2, $3, now())
                       on conflict (tenant_id) do update set engine=excluded.engine, updated_by=excluded.updated_by, updated_at=now()`, [T(), engine, me.id])
  else {
    await q(`update pro_run_settings set engine=null, updated_at=now() where tenant_id=$1`, [T()])
    await q(`delete from pro_run_settings where tenant_id=$1 and default_mode is null and engine is null`, [T()])
  }
  const now = await engineOf()
  await ledger(me, 'ontology.engine', `실행 방식의 엔진: ${ENGINE_KO[now.engine]}${engine ? '' : '(제품 기본값)'}`, { engine: now.engine, was, set: engine })
  return engineView(me)
}

// ---------- the next step from the map (pure) ----------
// the ways out of `x` as a snapshot unfolded from x would take them (run.js unfold: θ, pinned, decided, retired, 꼭), and the
// parallel pair out of x when there is one (run.js parallelPair, the snapshot's AND split)
export function waysOut(view, x, theta) {
  const { flows } = unfold(view, x, theta)
  const outs = flows.filter((f) => f.from === x).map((f) => ({ to: f.to, p: f.p || 0, cond: f.cond || '', condInfo: f.cond_cases || null, pinned: !!f.pinned, decided: !!f.decided, synthetic: !!f.synthetic,
    ...(f.required ? { required: f.required } : {}) }))
  return { outs, par: parallelPair(view.edges, flows, x) }
}

// the step after two parallel siblings: the most common way out of them that is not one of them (as the snapshot's join)
export function joinNext(view, siblings, theta) {
  const after = siblings.flatMap((s) => waysOut(view, s, theta).outs.map((o) => o.to)).filter((t) => !siblings.includes(t))
  return [...new Set(after)].sort((a, b) => after.filter((y) => y === b).length - after.filter((y) => y === a).length)[0] || END
}

// a split: the learned amount condition (no model) → a text condition read for this case (odds: to → {p, measured}) at or over
// textMatch → the most common way. A way to a step this case already did maxRepeat times is left out while there are others.
// → {to, how: amount | text | common, p, why, cond?, unsure?}
export function pickWay(outs, { amount = null, odds = new Map(), texts = new Map(), textMatch = 0.6, done = new Map(), maxRepeat = 3 } = {}) {
  const live = outs.filter((o) => o.to === END || (done.get(o.to) || 0) < maxRepeat)
  const pool = live.length ? live : outs
  // 꼭 하는 간선(edge settings — edgecond.js edgeRequiredView): the way into a 꼭 step from here is taken first — a sure 꼭 before one a
  // rule may make 꼭 (that one is read when the step opens and may still be skipped there), the most common among them
  const must = pool.filter((o) => o.required === true)
  const maybe = must.length ? must : pool.filter((o) => o.required === 'maybe')
  if (maybe.length) {
    const o = [...maybe].sort((a, b) => b.p - a.p)[0]
    return { to: o.to, how: 'required', p: o.p, why: o.required === true ? `「${o.to}」은(는) 이 길로 오면 꼭 하는 단계예요` : `「${o.to}」은(는) 이 길로 오면 사안에 따라 꼭 하는 단계예요` }
  }
  if (amount != null && Number.isFinite(Number(amount))) {
    for (const o of pool) {
      const c = o.condInfo
      if (c?.attr !== 'amount' || !Number.isFinite(Number(c.threshold))) continue
      const a = Number(amount), v = Number(c.threshold)
      // a threshold a person said carries its comparison (refine.js condOfWhen); a learned one is 이상 on one way, 미만 on the other
      const hit = c.op === '>=' ? a >= v : c.op === '>' ? a > v : c.op === '<=' ? a <= v : c.op === '<' ? a < v : /이상/.test(o.cond) ? a >= v : a < v
      if (hit) return { to: o.to, how: 'amount', p: o.p, cond: o.cond, why: `${o.cond}이라 이쪽으로 가요(이 건 ${new Intl.NumberFormat('ko-KR').format(a)}원)` }
    }
  }
  const read = pool.filter((o) => odds.get(o.to)?.p != null).map((o) => ({ o, r: odds.get(o.to) })).sort((a, b) => b.r.p - a.r.p)
  if (read[0] && read[0].r.p >= textMatch) {
    const { o, r } = read[0]
    return { to: o.to, how: 'text', p: o.p, cond: texts.get(o.to) || '', read: r.p, measured: r.measured !== false,
      why: `이 건은 「${texts.get(o.to) || ''}」에 해당해요(${r.measured === false ? '모델이 고름' : pct(r.p)})` }
  }
  const best = [...pool].sort((a, b) => b.p - a.p)[0]
  return { to: best.to, how: 'common', p: best.p, unsure: read.length > 0 || pool.some((o) => o.condInfo), why: best.to === END ? `지난 건의 ${pct(best.p)}가 여기서 끝났어요` : `지난 건의 ${pct(best.p)}가 이쪽으로 갔어요` }
}

// What comes after the step that just ended (row), read from the map (view). rows: the case's steps so far [{todoId, task, state: done |
// skipped | open | closed, par: {group, siblings}, via}] (row among them) · judge(cond): a text condition read for this case → {p, measured}
// · texts: to → text condition of the ways out of row.task · amount: the case's amount (null: none).
// → {creates: [{task, via, par?}]} | {wait: 'join', pending} | {end: true, how}
export async function nextOf(view, row, { rows = [], theta, amount = null, judge = null, texts = new Map(), R = {} } = {}) {
  const th = Number.isFinite(theta) ? theta : view.proc?.theta ?? 0.05
  const x = row.task
  const ended = (r) => r.state === 'done' || r.state === 'skipped'
  const maxRepeat = R.maxRepeat ?? 3
  const done = new Map()
  for (const r of rows) if (ended(r)) done.set(r.task, (done.get(r.task) || 0) + 1)
  // one of two steps done side by side: the step after them waits for both (a skipped one counts as done)
  if (row.par?.group) {
    const sibs = rows.filter((r) => r.par?.group === row.par.group)
    if (sibs.some((r) => r.state === 'closed')) return { creates: [], how: 'closed' }
    const pending = sibs.filter((r) => !ended(r))
    if (pending.length) return { wait: 'join', pending: pending.map((r) => r.task) }
    if (rows.some((r) => r.via?.how === 'join' && r.via?.group === row.par.group)) return { creates: [], how: 'joined' }
    const siblings = row.par.siblings || sibs.map((r) => r.task)
    const next = joinNext(view, siblings, th)
    if (next === END) return { end: true, how: 'join' }
    return { creates: [{ task: next, via: { how: 'join', from: x, group: row.par.group, after: siblings, why: `「${siblings.join('」 · 「')}」${fin(siblings.at(-1)) ? '이' : '가'} 모두 끝나서 이어 가요` } }] }
  }
  const { outs, par } = waysOut(view, x, th)
  if (par) {
    const group = row.todoId || `${x}@${Date.now()}`
    if (rows.some((r) => r.par?.group === group)) return { creates: [], how: 'parallel' }
    return { creates: par.targets.map((t) => ({ task: t, par: { group, siblings: par.targets }, via: { how: 'parallel', from: x, group, why: `「${par.targets.join('」 · 「')}」${eul(par.targets.at(-1))} 나란히 해요 — 둘 다 끝나야 다음으로 가요` } })) }
  }
  const list = outs.map((o) => ({ to: o.to, p: o.p, cond: o.cond || texts.get(o.to) || '' }))
  if (outs.length <= 1) {
    const to = outs[0]?.to ?? END
    if (to === END) return { end: true, how: 'single' }
    if ((done.get(to) || 0) >= maxRepeat) return { end: true, how: 'loop', why: `「${to}」${eul(to)} 이미 ${done.get(to)}번 했어요` }
    return { creates: [{ task: to, via: { how: 'single', from: x, p: outs[0].p, why: '이 흐름의 다음 단계예요', outs: list } }] }
  }
  const opts = { amount, texts, done, maxRepeat, textMatch: R.textMatch ?? 0.6 }
  let pick = pickWay(outs, opts)
  // text conditions are read only when the amount did not decide it, and only for the ways that have one
  if (pick.how !== 'amount' && pick.how !== 'required' && judge && outs.some((o) => texts.has(o.to))) {
    const odds = new Map()
    for (const o of outs) if (texts.has(o.to)) odds.set(o.to, (await judge(texts.get(o.to), o).catch(() => null)) || { p: null })
    pick = pickWay(outs, { ...opts, odds })
  }
  if (pick.to === END) return { end: true, how: pick.how, why: pick.why }
  return { creates: [{ task: pick.to, via: { how: pick.how, from: x, p: pick.p, cond: pick.cond || '', why: pick.why, ...(pick.unsure ? { unsure: true } : {}), outs: list } }] }
}

// what the map would do after the open steps, the most common way each time (the run view's 「다음」 — nothing is made)
export function likelyNext(view, open = [], theta, max = 6) {
  const th = Number.isFinite(theta) ? theta : view?.proc?.theta ?? 0.05
  const out = [], seen = new Set(open), frontier = [...open]
  while (frontier.length && out.length < max) {
    const x = frontier.shift()
    const { outs, par } = waysOut(view, x, th)
    const tos = par ? par.targets : outs.length ? [[...outs].sort((a, b) => b.p - a.p)[0].to] : []
    for (const to of tos) if (to !== END && !seen.has(to)) { seen.add(to); out.push(to); frontier.push(to) }
  }
  return out
}

// the map a case's next step is decided on: the one of its start when pinned (validAt), else the map as it is then (undefined)
export const mapTimeOf = (c) => (c?.engine === 'map' && c?.map_pin ? new Date(c.map_pin).toISOString() : undefined)

// the flowchart of a case (nothing stored): the map unfolded from the case's start as of now (or its pin), each step with the state
// of its latest work item; a step the case went to that this map does not reach is drawn too, joined by the way the case took.
// rows: [{task, show: done | running | person | waiting | skipped | closed | next, via}] · before: the steps a case started in the middle
// passed over (its history's 건너뜀), drawn before its start
export function flowGraph(view, { entry, theta, rows = [], before = [] } = {}) {
  const th = Number.isFinite(theta) ? theta : view.proc?.theta ?? 0.05
  const { nodes, flows } = unfold(view, entry, th)
  const pre = before.filter((k) => k !== entry && !nodes.includes(k))
  const keys = [...pre, ...nodes]
  for (const r of rows) if (!keys.includes(r.task)) keys.push(r.task)
  const latest = new Map()
  for (const r of rows) latest.set(r.task, r)
  const taken = new Set(rows.filter((r) => r.via?.from).map((r) => `${r.via.from}\u0000${r.task}`))
  const out = [...pre.map((k, i) => ({ from: k, to: pre[i + 1] || entry, p: 0, cond: '', taken: false, skipped: true })),
    ...flows.map((f) => ({ from: f.from, to: f.to, p: f.p || 0, cond: f.cond || '', taken: taken.has(`${f.from}\u0000${f.to}`) }))]
  for (const r of rows) {
    if (!r.via?.from || out.some((f) => f.from === r.via.from && f.to === r.task)) continue
    out.push({ from: r.via.from, to: r.task, p: r.via.p || 0, cond: '', taken: true, extra: true })
  }
  // two steps side by side
  for (const x of keys) {
    const par = parallelPair(view.edges, flows, x)
    if (par) for (const f of out) if (f.from === x && par.targets.includes(f.to)) f.and = true
  }
  const open = rows.filter((r) => ['running', 'person', 'waiting', 'next'].includes(r.show)).map((r) => r.task)
  const next = new Set(likelyNext(view, open, th, 3).slice(0, 2))
  const ns = keys.map((k) => {
    const t = view.tasks.get(k)
    const r = latest.get(k)
    const runs = rows.filter((x) => x.task === k && x.show === 'done').length
    return { key: k, role: t?.role || '', state: r ? r.show : pre.includes(k) ? 'skipped' : next.has(k) ? 'next' : '', runs, inMap: nodes.includes(k) || pre.includes(k), entry: k === entry, ...(pre.includes(k) ? { before: true } : {}) }
  })
  if (out.some((f) => f.to === END)) ns.push({ key: END, role: '', state: '', runs: 0, inMap: true })
  return { entry, nodes: ns, flows: out.filter((f) => f.from && keys.includes(f.from) && (f.to === END || keys.includes(f.to))) }
}

// ---------- cases ----------
// one at a time per case on this server: two steps ending together (two parallel siblings) decide the next one in turn
const chains = new Map()
function locked(id, fn) {
  const run = (chains.get(id) || Promise.resolve()).then(fn)
  const tail = run.catch(() => {})
  chains.set(id, tail)
  tail.then(() => { if (chains.get(id) === tail) chains.delete(id) })
  return run
}

// who does a person's step of this role: the case's binding (bindings.js — resolved when the case started, changed on its cards); a role
// the start's flow did not have (the map changed since) is resolved now, the same way, and kept on the case. → {userId, unbound, binding}
async function personOf(c, role, view, task) {
  const B = await import('./bindings.js')
  let b = B.findBinding(c.bindings, role)
  if (!b) {
    ;[b] = await B.resolveBindings(view, null, { starter: c.started_by, roles: [{ role, tasks: [task], agent: false }] })
    c.bindings = [...(Array.isArray(c.bindings) ? c.bindings : []), b]
    await q(`update pro_po_cases set bindings=$2 where id=$1`, [c.id, JSON.stringify(c.bindings)])
  }
  return { userId: b.userId || (c.started_by ? String(c.started_by) : null), unbound: B.unbound(b), binding: b }
}

// the case's steps so far, oldest first, as nextOf reads them
async function caseRows(c) {
  const rows = await q(`select s.id::text as step_id, s.todo_id::text as todo_id, s.kind, s.state as gate, s.via, s.par, s.created_at, ${statusSql('t.')} as status, t.activity_name
                        from pro_case_steps s join todolist t on t.id = s.todo_id where s.case_id=$1 order by s.created_at`, [c.id])
  return rows.map((r) => ({ todoId: r.todo_id, stepId: r.step_id, task: r.activity_name, kind: r.kind, via: r.via, par: r.par, gate: r.gate, at: r.created_at,
    state: r.status === 'CANCELLED' ? 'closed' : r.gate === 'skipped' ? 'skipped' : ['DONE', 'SUBMITTED'].includes(r.status) ? 'done' : 'open' }))
}

// One step's work item (todolist) and its row (pro_case_steps, planned): who does it (an agent's step: the agent; a person's step of an
// adopted process: the person, with the agent's draft first; else the person the case bound to the role — bindings.js), what the task's
// definition says it does (act). An agent's item opens now (the step worker takes it); a person's opens when its gate lets it (openPerson
// — HITL keeps it off their list until the owner says 진행). A person's step whose role has nobody yet (several people hold it, or none)
// waits for the case's owner to choose (holdUnbound) — its item stays TODO (off every list, nobody notified) until then.
export async function createItem(c, task, { via = {}, par = null, mapAt = new Date(), view }) {
  const t = view.tasks.get(task) || [...view.tasks.values()].find((x) => x.origin === task)
  if (!t) throw err(400, `「${task}」${fin(task) ? '은' : '는'} 이 프로세스에 없어요.`)
  const d = await taskDefinition(t.key, t)
  const runner = d.runner === 'agent'
  // a person's step with the agent's draft first: the step's own say (set_runner draft — AI 초안 먼저), or every person's step of an adopted process
  const draft = !runner && (d.runner === 'draft' || view.proc?.status === 'adopted')
  const kind = runner ? 'agent' : draft ? 'draft' : 'person'
  const agent = runner || draft ? await agentId() : null
  const { roleOfTask } = await import('./bindings.js')
  const role = roleOfTask(t, d.runner)
  const who = runner ? { userId: null, unbound: false } : await personOf(c, role, view, t.key)
  const person = who.userId
  const aid = actId(t.key), formId = `${MAP_PREFIX.replace(/\.$/, '')}_${aid}_form`
  const act = { id: aid, name: t.key, role, tool: `formHandler:${formId}`, skills: d.skills, checkpoints: d.checkpoints, outputs: d.outputs, description: d.description || '',
    instruction: d.instruction || '', runner: d.runner, ...(agent ? { agent, agentMode: runner ? 'complete' : 'draft', orchestration: ORCH } : { agentMode: 'none' }) }
  const ids = (kind === 'agent' ? [agent] : kind === 'draft' ? [agent, person] : [person]).filter(Boolean)
  const names = new Map((await q(`select id::text as id, username from users where tenant_id=$1 and id::text = any($2)`, [T(), ids])).map((u) => [u.id, u.username]))
  const assignees = [{ name: role, endpoint: ids, default: [person || agent].filter(Boolean), origin: 'created', resolutionRule: `프로세스 지도: ${who.binding ? (await import('./bindings.js')).FROM_KO[who.binding.from] || '' : '에이전트가 해요'}` }]
  const inst = c.instances[0]
  // a person's step opens when its gate lets it; a draft waits as TODO while its role has nobody (the agent would draft for nobody)
  const status = kind === 'person' || who.unbound ? 'TODO' : 'IN_PROGRESS'
  const [row] = await q(`insert into todolist (id, tenant_id, user_id, username, proc_inst_id, root_proc_inst_id, execution_scope, proc_def_id, activity_id, activity_name,
                           status, tool, description, start_date, due_date, duration, assignees, reference_ids, agent_mode, agent_orch, adhoc)
                         values (gen_random_uuid(), $1, $2, $3, $4, $4, '', null, $5, $6, $7::todo_status, $8, $9, ${NOW_KST}, ${NOW_KST} + interval '1 day', 1, $10, $11, $12::agent_mode, $13, false)
                         returning *`,
  [T(), ids.join(','), ids.map((i) => names.get(i) || '').join(','), inst, aid, t.key, status, act.tool, act.description,
    JSON.stringify(assignees), via.from ? [actId(via.from)] : [], kind === 'agent' ? 'COMPLETE' : kind === 'draft' ? 'DRAFT' : null, agent ? ORCH : null])
  // the case's mode is the one its process's stage gave it at the start (runmode.js caseMode — 제안: hitl, 자동: hotl)
  const { caseMode } = await import('./runmode.js')
  const { mode } = await caseMode(c, view)
  await q(`insert into pro_case_steps (tenant_id, case_id, proc_inst_id, todo_id, task, kind, mode, state, why, reversible, hold_item, map_at, via, act, par)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13,$14)`,
  [T(), c.id, inst, row.id, t.key, kind, mode, who.unbound ? 'waiting' : 'planned', who.unbound ? ['unbound'] : [], kind === 'person' || who.unbound, mapAt, via, act, par])
  await q(`update pro_po_cases set updated_at=now() where id=$1`, [c.id])
  console.log(`[map] ${c.trigger?.subject || c.id} · 「${t.key}」(${kind}${who.unbound ? ' · 맡을 사람 정하기 기다림' : ''}) — ${via.how || ''}${via.why ? `: ${via.why}` : ''}`)
  if (c.started_by) { emit(c.started_by, 'ontology', { caseId: c.id, made: t.key }); emit(c.started_by, 'process', { instId: inst, type: 'changed' }) }
  return { todoId: row.id, kind, row, unbound: who.unbound, role }
}

// a step whose role has nobody yet: the owner is asked to choose (the step card shows the role's people — bindings.js); the step waits
async function holdUnbound(c, made) {
  const [s] = await q(`select * from pro_case_steps where todo_id=$1`, [made.todoId])
  if (!s || !c.started_by) return
  const B = await import('./bindings.js')
  const [now] = await q(`select bindings from pro_po_cases where id=$1`, [c.id])
  const b = B.findBinding(now?.bindings, made.role)
  const RM = await import('./runmode.js')
  await RM.askOwnerFor(c, { ...s, role: made.role, binding: b ? B.bindingsView([b])[0] : null })
  console.log(`[map] 「${s.task}」: 「${made.role}」${eul(made.role)} 맡을 사람을 정할 때까지 기다려요(${b?.from || '?'})`)
}
// what comes of a step just made: a person's step goes through its gate, one whose role has nobody asks the owner
async function afterMade(c, m) {
  if (m.unbound) return holdUnbound(c, m)
  if (m.kind === 'person') return openPerson(m.row)
}

// a person's step: its gate first (it may wait for the owner, or skip an optional step); when it is theirs, it opens on their list
async function openPerson(row) {
  const RM = await import('./runmode.js')
  // (the gate failing lets the step go, as the step worker does)
  const g = await RM.gateStep(row).catch((e) => { console.warn('[map] gate', row.activity_name, e.message); return { act: 'person' } })
  if (g.act === 'person') await toPerson(row.id)
  return g
}
// the work item opens (TODO → IN_PROGRESS): Process GPT's todolist trigger tells the assignee; the case's owner gets the card when it is theirs
export async function toPerson(todoId) {
  const [t] = await q(`update todolist set status='IN_PROGRESS' where id=$1 and status::text='TODO' returning id::text as id, user_id, activity_name, proc_inst_id`, [todoId])
  if (!t) return null
  const [c] = await q(`select started_by from pro_po_cases where $1 = any(instances) limit 1`, [t.proc_inst_id])
  const ids = String(t.user_id || '').split(',').map((x) => x.trim()).filter(Boolean)
  for (const id of ids) emit(id, 'notifications', {})
  if (c?.started_by && ids.includes(String(c.started_by))) {
    const th = await mainThread(c.started_by)
    await addMessage(c.started_by, th.id, 'agent', 'todo', { todoId: t.id, name: t.activity_name })
  }
  if (c?.started_by) emit(c.started_by, 'process', { instId: t.proc_inst_id, type: 'changed' })
  return t
}

export async function stillOpen(todoId) {
  const [t] = await q(`select status::text as status from todolist where id=$1`, [todoId])
  return !!t && !['DONE', 'CANCELLED'].includes(t.status)
}

// A step ends (an agent's result, a person's hand-in, a skip, a send recorded): its work item is done with its result, and the map says
// what comes next. Nothing when it was already closed (a move closed it while the agent worked).
export async function finishItem(todoId, payload) {
  const [t] = await q(`update todolist set output=$2, status='DONE', consumer=null, end_date=${NOW_KST},
                         draft_status = case when agent_orch is not null then 'COMPLETED'::draft_status else draft_status end
                       where id=$1 and status::text not in ('DONE','CANCELLED') returning id::text as id, proc_inst_id, activity_name`, [todoId, payload || {}])
  if (!t) return null
  const [c] = await q(`select id::text as id from pro_po_cases where tenant_id=$1 and $2 = any(instances) and engine='map' limit 1`, [T(), t.proc_inst_id])
  if (c) await advance(c.id, t.id).catch((e) => console.warn('[map] next step', t.activity_name, e.message))
  return t
}

// a person hands in their step (Lite's 할 일: engine.js submitTodo)
export async function submitPerson({ me, todo, payload }) {
  const s = String(todo.status || '')
  if (['DONE', 'CANCELLED', 'SUBMITTED'].includes(s)) throw err(409, '이미 닫힌 단계예요.')
  if (s === 'TODO') throw err(409, '아직 이 단계를 할 차례가 아니에요 — 건의 주인이 정할 때까지 기다려요.')
  const t = await finishItem(todo.id, payload)
  if (!t) throw err(409, '이미 닫힌 단계예요.')
  console.log(`[map] 「${todo.activity_name}」: ${me?.email || me?.id} 냈어요`)
  return t
}

export async function advance(caseId, todoId) {
  const made = await locked(String(caseId), () => advanceIn(String(caseId), String(todoId)))
  const [c] = await q(`select *, bundle as proc from pro_po_cases where id=$1`, [String(caseId)])
  for (const m of made || []) await afterMade(c, m).catch((e) => console.warn('[map] person step', e.message))
  if (c) await syncInst(c).catch((e) => console.warn('[map] instance row', e.message))
  return made
}
async function advanceIn(caseId, todoId) {
  const [c] = await q(`select *, bundle as proc from pro_po_cases where id=$1`, [caseId])
  if (!c || c.engine !== 'map' || c.status !== 'running') return []
  const rows = await caseRows(c)
  const row = rows.find((r) => r.todoId === todoId)
  if (!row || !['done', 'skipped'].includes(row.state)) return []
  // decided once per ended step (a hand-in seen twice makes nothing twice)
  if (rows.some((r) => r.via?.fromTodo === row.todoId)) return []
  const validAt = mapTimeOf(c)
  const view = await procGraph(c.bundle, { validAt })
  const R = await rulesOf()
  const SR = await import('./steprule.js')
  const texts = new Map([...(await (await import('./conditions.js')).textConditions([row.task]))].map(([k, v]) => [k.split('\u0000')[1], v]))
  // the case's amount only when a way out of this step has a learned amount condition
  const amount = view.edges.some((e) => e.from === row.task && e.cond_cases?.attr === 'amount') ? (await SR.caseAmount(c).catch(() => ({ amount: null }))).amount : null
  const SRR = (await skillRules()).stepRules || {}
  let state = null
  const judge = async (cond) => SR.readYes(state ??= await SR.caseState(c, SRR.textChars || 1500), fill(R.question || SRR.questions?.rule || '이 건은 다음 경우에 해당하나? 「{text}」', { text: cond }), SRR)
  const dec = await nextOf(view, row, { rows, amount, judge, texts, R })
  if (dec.wait) { console.log(`[map] 「${row.task}」 끝 — 「${dec.pending.join('」 · 「')}」${eul(dec.pending.at(-1))} 기다려요(합류)`); return [] }
  if (dec.end) {
    if (rows.some((r) => r.state === 'open' && r.todoId !== row.todoId)) return []
    await completeCase(c, row, dec)
    return []
  }
  const mapAt = validAt ? new Date(validAt) : new Date()
  const made = []
  for (const x of dec.creates) made.push(await createItem(c, x.task, { via: { ...x.via, fromTodo: row.todoId }, par: x.par || null, mapAt, view }))
  return made
}

// the case is done (as an engine instance completing): the owner hears it, and the habit question is asked as after a snapshot (run.js)
async function completeCase(c, row, dec) {
  const [d] = await q(`update pro_po_cases set status='done', updated_at=now() where id=$1 and status='running' returning id`, [c.id])
  if (!d) return
  console.log(`[map] ${c.trigger?.subject || c.id}: 끝(${dec.how}) — 「${row.task}」 다음이 없어요`)
  if (!c.started_by) return
  const th = await mainThread(c.started_by)
  await addMessage(c.started_by, th.id, 'agent', 'chip', { icon: 'check', text: `완료 · ${c.trigger?.subject || '건'}`, instId: c.instances[0], caseId: c.id })
  emit(c.started_by, 'ontology', { caseId: c.id, done: true })
  emit(c.started_by, 'process', { instId: c.instances[0], type: 'changed', status: 'COMPLETED' })
  const { habitFor } = await import('./run.js')
  const h = await habitFor(c.id).catch(() => null)
  if (h) {
    await addMessage(c.started_by, th.id, 'agent', 'onto-habit', { caseId: c.id, ...h, state: h.ask ? 'ask' : 'quiet' })
    emit(c.started_by, 'ontology', { caseId: c.id, habit: h })
  }
}

// the instance's name, as the engine names one: 「<process> · <the request's subject>」
export const instNameOf = (procName, subject) => String(subject ? `${procName} · ${subject}` : procName || '').slice(0, 120)

// The case's one row in bpm_proc_inst, kept current (start · each step made or ended · move · rewind · end · a binding changed): its open
// steps (current_activity_ids — a step waiting for the owner is where the case is too: the 할 일 list leaves out held ones, runmode.js
// heldTodos), its people (the starter, the people bound to its roles and everyone who got a step — not the agent), its roles in the
// engine's shape, RUNNING · COMPLETED and when it ended. A paused case stays RUNNING (the BPM path does not mark a pause either).
export async function syncInst(was) {
  const inst = was?.instances?.[0]
  if (!isMapInst(inst)) return null
  // (read again: a step made a moment ago may have bound a new role, a rewind reopened the case)
  const [c] = await q(`select started_by, status, bindings from pro_po_cases where id=$1`, [was.id])
  if (!c) return null
  const open = await q(`select activity_id from todolist where proc_inst_id=$1 and status::text not in ('DONE','CANCELLED','SUBMITTED') order by start_date nulls last`, [inst])
  const got = await q(`select distinct unnest(string_to_array(coalesce(user_id,''), ',')) as id from todolist where proc_inst_id=$1`, [inst])
  const B = await import('./bindings.js')
  const bound = (Array.isArray(c.bindings) ? c.bindings : []).map((b) => b.userId).filter(Boolean)
  const ids = [...new Set([String(c.started_by || ''), ...bound, ...got.map((r) => String(r.id || '').trim())].filter(Boolean))]
  const people = ids.length ? new Set((await q(`select id::text as id from users where tenant_id=$1 and id::text = any($2) and not coalesce(is_agent,false)`, [T(), ids])).map((u) => u.id)) : new Set()
  const done = c.status === 'done'
  const agent = (c.bindings || []).some((b) => b.from === 'agent') ? await agentId() : null
  const [r] = await q(`update bpm_proc_inst set current_activity_ids=$2, participants=$3, role_bindings=$4, status=$5,
                         end_date = case when $6 then coalesce(end_date, ${NOW_KST}) else null end, updated_at=now()
                       where proc_inst_id=$1 returning proc_inst_id`,
  [inst, [...new Set(open.map((o) => o.activity_id))], ids.filter((i) => people.has(i)), JSON.stringify(B.roleBindingsOf(c.bindings || [], agent)), done ? 'COMPLETED' : 'RUNNING', done])
  return r || null
}

// a case starts on the map: its row (the request on it, no 요청 접수 step), its one instance (one bpm_proc_inst row — no definition behind
// it), the mode its process's stage gives it, who does each role (bindings — picks: what the person changed on the ask card), its
// conversation, and its first step
export async function startMapCase(me, { procKey, entry, subject = '', body = '', from = '', customer = '', odds = null, kind = 'manual', file = null, picks = [] }) {
  const view = await procGraph(procKey)
  if (!view.tasks.has(entry)) throw err(400, '그 일은 이 프로세스에 없어요.')
  // (a case is no longer pinned to the map of its start because its process has a 꼭 step: the edge settings are read as each step opens —
  // edge-step-condition; an admin can still pin a case's map by hand)
  const now = new Date()
  const pin = null
  const skipped = await skippedOf(view, entry)
  const instId = `${MAP_PREFIX}${crypto.randomUUID()}`
  const request = { subject, body: String(body).slice(0, 3000), customer, sender: from }
  const B = await import('./bindings.js')
  const bindings = await B.resolveBindings(view, entry, { starter: me.id, picks })
  const { modeOfStage } = await import('./runmode.js')
  const [c] = await q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, entry_odds, instances, snapshots, history, engine, map_pin, request, run_mode, bindings)
                       values ($1,$2,$3,$4,$5,$6,$7,'{}',$8,'map',$9,$10,$11,$12) returning *, bundle as proc`,
  [T(), procKey, entry, me.id, triggerOf({ kind, subject, from, customer, file }), odds, [instId], JSON.stringify(skipped.map((t) => ({ task: t, state: 'skipped', at: iso() }))), pin, request,
    modeOfStage(view.proc.status), JSON.stringify(bindings)])
  const instName = instNameOf(view.proc.name, subject)
  // the request as process variables, in the engine's shape ([{key, name, value}] — 본판 reads them as the instance's variables and
  // searches them); proc_def_id stays empty: no definition behind this instance
  const vars = [['subject', '제목', subject], ['sender', '보낸 사람', from], ['customer', '고객', customer]].filter(([, , v]) => v).map(([key, name, value]) => ({ key, name, value: String(value).slice(0, 300) }))
  await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, tenant_id, status, start_date, actual_start_date, participants, role_bindings, current_activity_ids, variables_data, updated_at)
           values ($1,$2,null,$3,'RUNNING',${NOW_KST},now(),$4,$5,'{}',$6,now())`, [instId, instName, T(), [String(me.id)], JSON.stringify(B.roleBindingsOf(bindings)), JSON.stringify(vars)])
  await q(`insert into pro_threads(user_id,kind,title,ref) values ($1,'process',$2,$3)`, [me.id, subject || view.proc.name, instId])
  const made = await locked(c.id, () => createItem(c, entry, { via: { how: 'entry', from: null, p: odds?.p ?? null,
    why: odds?.p != null ? `이 요청은 「${entry}」부터 하면 돼요(${odds.measured === false ? '모델이 고름' : pct(odds.p)})` : `「${entry}」부터 시작해요` }, mapAt: pin || now, view }))
  await afterMade(c, made)
  await syncInst(c)
  emit(me.id, 'process', { instId, type: 'started' })
  const th = view.proc.theta ?? 0.05
  return { caseId: c.id, instId, instName, engine: 'map', bindings: B.bindingsView(c.bindings), runMode: c.run_mode,
    snapshot: { skipped, nodes: unfold(view, entry, th).nodes, procDefId: null, engine: 'map', mapPin: pin } }
}

// 옮기기 · 되감기 on the map: the case's open work items close (CANCELLED) and the target step's item opens in the same instance; the move
// is in the case's history, a move (not a rewind) is a fact the next build learns from (a todolist handover), as run.js moveCase
export async function moveMap(me, c, { task, reason = '', state = 'moved', learn = true }) {
  const validAt = mapTimeOf(c)
  const view = await procGraph(c.proc, { validAt })
  if (!view.tasks.has(task)) throw err(400, '그 일은 이 프로세스에 없어요.')
  const inst = c.instances[0]
  const made = await locked(String(c.id), async () => {
    // (a database whose todo_status has no CANCELLED: DONE with Lite's cancel mark, read back as CANCELLED — lib/enums.js)
    const open = await q(`update todolist set ${await cancelSet()} where proc_inst_id=$1 and status::text not in ('DONE','CANCELLED') returning id::text as id, activity_name`, [inst])
    if (open.length) await q(`update pro_case_steps set state='moved', hold_item=false, updated_at=now() where todo_id::text = any($1) and state not in ('skipped','moved')`, [open.map((o) => o.id)])
    const [last] = await q(`select t.activity_name from pro_case_steps s join todolist t on t.id=s.todo_id where s.case_id=$1 and t.status::text='DONE' and ${notCancelledSql('t.')} order by s.created_at desc limit 1`, [c.id])
    await q(`update pro_po_cases set status='running', history = history || $2::jsonb, updated_at=now() where id=$1`, [c.id, JSON.stringify([{ task, state, at: iso(), reason }])])
    return createItem({ ...c, status: 'running' }, task, { via: { how: state === 'rewound' ? 'rewound' : 'moved', from: open[0]?.activity_name || last?.activity_name || null,
      why: reason || (state === 'rewound' ? '이 단계로 되감았어요' : '사람이 이 단계로 옮겼어요') }, mapAt: validAt ? new Date(validAt) : new Date(), view })
  })
  if (learn) await q(`insert into handover_events (tenant_id, case_id, source, is_explicit, from_user_id, from_user_name, to_user_id, activity_label, next_activity_label, reason, occurred_at)
           values ($1,$2,'todolist',true,$3,$4,$3,$5,$5,$6,now())`, [T(), `onto:${c.id}`, String(me.id), me.email || '', task, reason || '옮기기']).catch((e) => console.warn('[map] move event', e.message))
  await afterMade({ ...c, status: 'running' }, made)
  // the same row as before: back to RUNNING when a rewind reopens an ended case, its open step now the target
  await syncInst(c).catch((e) => console.warn('[map] instance row', e.message))
  if (c.started_by) emit(c.started_by, 'ontology', { caseId: c.id, moved: task })
  return { caseId: c.id, instId: inst, instName: c.trigger?.subject || view.proc.name, engine: 'map', snapshot: { skipped: [], nodes: unfold(view, task, view.proc.theta ?? 0.05).nodes, procDefId: null, engine: 'map' } }
}

// 지도 따라가기: off — every next step is decided on the map as it is then; on — on the map of the case's start (an admin's choice per case)
export async function setPin(me, caseId, pin) {
  const c = await getCase(caseId)
  if (c.engine !== 'map') throw err(400, '지도에서 바로 도는 건만 지도를 고정할 수 있어요.')
  const at = pin ? c.map_pin || c.created_at : null
  await q(`update pro_po_cases set map_pin=$2, updated_at=now() where id=$1`, [c.id, at])
  await ledger(me, 'ontology.case.pin', `${c.trigger?.subject || '건'} · 다음 단계를 ${pin ? '시작한 날의 지도로' : '그때의 지도로'} 정해요`, { case: c.id, pin: !!pin, at: at ? iso(at) : null })
  if (c.started_by) emit(c.started_by, 'ontology', { caseId: c.id, pin: !!pin })
  return { caseId: c.id, mapPin: at ? iso(at) : null }
}

// 맡는 사람 바꾸기 (bindings.js): a role of a running case goes to another of the company's people — its steps not done yet go to them (an
// open item's assignee changes and they are told — the database moves its notification; a step that waited for someone to be chosen
// opens now), the steps made later take them too. A ledger line; no handover event (nobody had worked on it). The company's role
// settings stay as they are. Both engines: a snapshot case's open items of that role and its instance's role binding change too.
export async function setBinding(me, caseId, { role, userId } = {}) {
  const c = await getCase(caseId)
  const { isAdmin } = await import('./service.js')
  if (String(c.started_by) !== String(me.id) && !(await isAdmin(me).catch(() => false))) throw err(403, '이 건을 맡은 사람이나 관리자만 바꿀 수 있어요.')
  if (c.status !== 'running') throw err(409, '진행 중인 건만 맡는 사람을 바꿀 수 있어요.')
  const B = await import('./bindings.js')
  const { roleKey } = await import('../team.js')
  const list = Array.isArray(c.bindings) ? c.bindings.map((b) => ({ ...b })) : []
  const i = list.findIndex((b) => roleKey(b.role) === roleKey(role))
  if (i < 0) throw err(404, '이 건에 그 역할이 없어요.')
  if (list[i].from === 'agent') throw err(400, '에이전트가 하는 단계는 맡는 사람을 정하지 않아요.')
  const [u] = await q(`select id::text as id, coalesce(nullif(username,''), email) as name from users where tenant_id=$1 and id::text=$2 and not coalesce(is_agent,false)`, [T(), String(userId || '')])
  if (!u) throw err(400, '이 회사 사람 중에서 골라 주세요.')
  const old = list[i]
  if (old.userId === u.id) return { caseId: c.id, bindings: B.bindingsView(list), reassigned: 0 }
  list[i] = { role: old.role, userId: u.id, name: u.name, from: 'picked', was: old.from, tasks: old.tasks || [], changedBy: me.email || String(me.id), changedAt: iso() }
  await q(`update pro_po_cases set bindings=$2, updated_at=now() where id=$1`, [c.id, JSON.stringify(list)])
  c.bindings = list
  // the role's steps not done yet: a map case's from their own row (act.role), a snapshot case's from its definition's activity
  const inst = c.instances.at(-1)
  const open = await q(`select t.id::text as id, t.activity_id, t.activity_name, t.status::text as status, t.user_id, t.agent_orch, t.agent_mode::text as agent_mode, t.proc_inst_id,
                               s.id::text as step_id, s.kind, s.state, s.why, s.act, s.message_id
                        from todolist t left join pro_case_steps s on s.todo_id = t.id where t.proc_inst_id=$1 and t.status::text in ('NEW','TODO','IN_PROGRESS','PENDING')`, [inst])
  let roleOf = (r) => r.act?.role || ''
  if (c.engine !== 'map') {
    const def = c.instancesInfo.find((x) => x.proc_inst_id === inst)?.proc_def_id
    const [d] = def ? await q(`select definition from proc_def where id=$1 and tenant_id=$2`, [def, T()]) : []
    const roles = new Map((d?.definition?.activities || []).map((a) => [a.id, a.role || '']))
    roleOf = (r) => roles.get(r.activity_id) || ''
  }
  let reassigned = 0
  for (const r of open.filter((x) => roleKey(roleOf(x)) === roleKey(old.role))) {
    const agentOn = r.agent_orch && String(r.agent_mode || '').toUpperCase() === 'COMPLETE'
    if (agentOn) continue
    const draftAgent = r.agent_orch ? String(r.user_id || '').split(',').map((x) => x.trim()).find((x) => x && x !== old.userId && x !== String(c.started_by)) || r.act?.agent || null : null
    const ids = [draftAgent, u.id].filter(Boolean)
    const names = new Map((await q(`select id::text as id, username from users where tenant_id=$1 and id::text = any($2)`, [T(), ids])).map((x) => [x.id, x.username]))
    await q(`update todolist set user_id=$2, username=$3 where id=$1`, [r.id, ids.join(','), ids.map((x) => names.get(x) || '').join(',')])
    reassigned++
    const was = String(r.user_id || '').split(',').map((x) => x.trim()).filter((x) => x && x !== draftAgent)
    for (const id of [...was, u.id]) emit(id, 'notifications', {})
    if ((r.why || []).includes('unbound') && r.state === 'waiting') {
      // the step waited for someone to be chosen: it goes on now (a person's through its gate, a draft to the agent)
      await q(`update pro_case_steps set state='released', why='{}', hold_item=false, updated_at=now() where id=$1`, [r.step_id])
      if (r.message_id && c.started_by) await updateMessage(c.started_by, r.message_id, { state: 'released', note: `「${old.role}」${eun(old.role)} ${u.name}님이 맡아요` }).catch(() => {})
      const [row] = await q(`select * from todolist where id=$1`, [r.id])
      if (r.kind === 'person') await openPerson(row).catch((e) => console.warn('[map] person step', e.message))
      else await q(`update todolist set status='IN_PROGRESS' where id=$1 and status::text='TODO'`, [r.id])
    } else if (r.status === 'IN_PROGRESS' && c.started_by && String(c.started_by) === u.id) {
      const th = await mainThread(c.started_by)
      await addMessage(c.started_by, th.id, 'agent', 'todo', { todoId: r.id, name: r.activity_name })
    }
  }
  if (c.engine === 'map') await syncInst(c)
  else if (inst) {
    // the snapshot's instance: the role's binding there too, so its next steps of the role go to the person
    const [i0] = await q(`select role_bindings from bpm_proc_inst where proc_inst_id=$1`, [inst])
    const rb = (Array.isArray(i0?.role_bindings) ? i0.role_bindings : []).map((x) => (roleKey(x.name) === roleKey(old.role) ? { ...x, endpoint: [u.id], default: [u.id] } : x))
    if (rb.length) await q(`update bpm_proc_inst set role_bindings=$2, participants = (select array_agg(distinct p) from unnest(coalesce(participants,'{}') || array[$3::text]) p) where proc_inst_id=$1`, [inst, JSON.stringify(rb), u.id])
  }
  await ledger(me, 'ontology.case.binding', `${c.trigger?.subject || '건'} · 「${old.role}」 맡는 사람: ${old.name || B.FROM_KO[old.from] || '없음'} → ${u.name}`,
    { case: c.id, role: old.role, from: old.userId || null, fromHow: old.from, to: u.id, reassigned })
  if (c.started_by) { emit(c.started_by, 'ontology', { caseId: c.id, binding: old.role }); emit(c.started_by, 'process', { instId: inst, type: 'changed' }) }
  console.log(`[map] ${c.trigger?.subject || c.id}: 「${old.role}」 → ${u.name} (열린 단계 ${reassigned}개)`)
  return { caseId: c.id, bindings: B.bindingsView(list), reassigned, note: '회사 설정은 그대로예요' }
}

// a map case's work item as Lite's 할 일 opens it (processes.js getTodo): its activity and form from the task (the snapshot's per-step form)
export async function todoView(t) {
  const [s] = await q(`select s.act, c.trigger from pro_case_steps s left join pro_po_cases c on c.id = s.case_id where s.todo_id=$1`, [t.id])
  const act = s?.act || {}
  const formId = String(act.tool || '').startsWith('formHandler:') ? act.tool.slice(12) : `${t.activity_id}_form`
  const form = { id: formId, fields: [{ key: 'result', text: `${t.activity_name} 결과`, type: 'textarea' }] }
  const step = { id: t.activity_id, name: t.activity_name, role: act.role || '', kind: act.agentMode === 'complete' ? 'agent' : 'human', description: act.description || '', formId,
    agentMode: act.agentMode || null, orchestration: act.orchestration || null, skills: act.skills || [] }
  const vals = t.draft || t.output || {}
  return { todo: t, step, form, instName: s?.trigger?.subject || t.activity_name, values: vals[formId] || vals }
}

// GET /ontology/cases/:id/flow — the case's flowchart, drawn from the map as of now (or its pin), each step's state from its work items
export async function flowOf(caseId) {
  const c = await getCase(caseId)
  const validAt = mapTimeOf(c)
  const view = await procGraph(c.proc, { validAt })
  const RM = await import('./runmode.js')
  const gates = new Map((await q(`select * from pro_case_steps where case_id=$1 order by created_at`, [c.id])).map((g) => [String(g.todo_id), g]))
  const todos = c.instances.length ? await q(`select id::text as id, activity_id, activity_name, ${statusSql()} as status, agent_orch::text as agent_orch, agent_mode::text as agent_mode,
      draft_status::text as draft_status, start_date from todolist where proc_inst_id = any($1) and activity_id <> 'intake' order by start_date nulls last`, [c.instances]) : []
  const made = c.engine === 'map' ? [...todos].sort((a, b) => new Date(gates.get(a.id)?.created_at || 0) - new Date(gates.get(b.id)?.created_at || 0)) : todos
  const rows = made.map((t) => ({ task: t.activity_name, show: RM.stepState(t, gates.get(t.id)), via: gates.get(t.id)?.via || null }))
  const before = (c.history || []).filter((h) => h.state === 'skipped' && !h.step).map((h) => h.task)
  const g = flowGraph(view, { entry: c.entry_task, theta: view.proc.theta ?? 0.05, rows, before })
  // a map case's flowchart as a BPMN diagram made now (casebpmn.js — nothing stored): lanes per role with the person the case bound to each
  // (bindings), the same splits and joins as a snapshot's, the text conditions of its splits (read only); without it the screen draws g
  let bpmn = null
  if (c.engine === 'map') {
    try {
      const splits = [...new Set(g.flows.map((f) => f.from))].filter((x) => g.flows.filter((f) => f.from === x).length > 1)
      const texts = await (await import('./conditions.js')).textConditions(splits).catch(() => new Map())
      const startName = { mail: '메일 도착', chat: '채팅 요청', file: '파일 도착', timer: '정한 때', manual: '직접 시작' }[c.trigger?.kind] || '요청 도착'
      bpmn = (await import('./casebpmn.js')).caseBpmn(view, { entry: c.entry_task, theta: view.proc.theta ?? 0.05, rows, before, graph: g, texts,
        bindings: Array.isArray(c.bindings) ? c.bindings : null, status: c.status, startName, id: `case_${String(c.id).slice(0, 8)}` })
    } catch (e) { console.warn('[map] case bpmn', e.message) }
  }
  return { caseId: c.id, engine: c.engine || 'bpm', proc: c.proc, procName: view.proc.name, status: c.status, pinned: !!validAt, mapAt: validAt || iso(), instances: c.instances.length, ...g, ...(bpmn ? { bpmn } : {}) }
}

// ---------- the sweep (run.js sweepCases, every 5 s) ----------
export async function sweepMap() {
  // a map step handed in on Process GPT's own screen (completion marks it SUBMITTED and has no definition to go on with): it ends here
  const sub = await q(`update todolist set consumer='pgpt-pro-map' where tenant_id=$1 and proc_inst_id like 'onto-map.%' and status::text='SUBMITTED' and consumer is null
                       returning id::text as id, output`, [T()])
  for (const r of sub) await finishItem(r.id, r.output || {}).catch((e) => console.warn('[map] handed in elsewhere', e.message))
  // a person's step whose gate has not looked yet (the server stopped between making it and its gate)
  const planned = await q(`select t.* from pro_case_steps s join todolist t on t.id=s.todo_id where s.tenant_id=$1 and s.state='planned' and s.kind='person'
                           and t.status::text='TODO' and s.created_at < now() - interval '20 seconds' limit 5`, [T()])
  for (const r of planned) await openPerson(r).catch((e) => console.warn('[map] person step', e.message))
  // a running case whose steps all ended with nothing after the last (the map could not be read then): decide it again
  const stalled = await q(`select c.id::text as case_id, l.todo_id::text as todo_id from pro_po_cases c
                           join lateral (select s.todo_id from pro_case_steps s join todolist t on t.id=s.todo_id where s.case_id=c.id and t.status::text='DONE' and ${notCancelledSql('t.')}
                                         order by s.created_at desc limit 1) l on true
                           where c.tenant_id=$1 and c.engine='map' and c.status='running' and c.updated_at < now() - interval '30 seconds' and c.updated_at > now() - interval '2 days'
                             and not exists (select 1 from todolist o where o.proc_inst_id = c.instances[1] and o.status::text not in ('DONE','CANCELLED')) limit 3`, [T()])
  for (const r of stalled) {
    await q(`update pro_po_cases set updated_at=now() where id=$1`, [r.case_id])
    await advance(r.case_id, r.todo_id).catch((e) => console.warn('[map] stalled case', e.message))
  }
}

export { ro }
