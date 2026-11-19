// 간선 설정(edge-step-condition): 이벤트 → 태스크 간선(TRIGGERS)마다, 프로세스마다 그 간선으로 들어오는 다음 태스크의
//   조건 — 꼭 하는 단계 · 해도 되고 안 해도 되는 단계 · 지도대로, 사안에 따라(금액 · 글로 쓴 조건, 위에서부터 맞는 첫 규칙 — steprule.js 의 읽기 그대로)
//   단계 분류 — 사람이 꼭 · AI가 맡음 · 걷어냄 · 건너뛰었지만 해야 함
// 을 정하고 저장한다(표 sql/047, 이력 — 가장 늦은 줄이 지금 설정). 같은 간선을 쓰는 다른 프로세스에는 걸리지 않는다.
// 간선은 「건이 이 일로 어떻게 들어오는가」다(entryEdgesOf): 시작 사건(요청 메일 · 채팅 · 타이머) → 일, 앞 일의 결과물 → 일, 결과물이 없으면
// 「앞 일 완료」 → 일. 지도 셈이 「완료」 사건을 그래프에 두고(structure.js doneEvent), 다듬기 · 말로 고치기로 새로 이은 길에는 같은 꼴의
// 간선을 이 흐름에서 만들어 보인다(virtual). 실행이 이 설정을 읽는 것은 다음 단계(edge-condition-run)다.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { ledger } from './review.js'
import { END } from './stats.js'
import { raiserOf } from './structure.js'
import { REQS, REQ_KO, normRule, ruleText, settingLines } from './steprule.js'
import { rules as skillRules } from './discovery.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const fin = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0 }
const ro = (w) => (fin(w) && fin(w) !== 8 ? '으로' : '로')

export const EDGE_CLASSES = ['human', 'ai', 'drop', 'skipped']
export const CLASS_KO = { human: '사람이 꼭', ai: 'AI가 맡음', drop: '걷어냄', skipped: '건너뛰었지만 해야 함' }
export const edgeKey = (event, task) => `${event}\u0000${task}`

// ---------- pure ----------
// The ways into the process's tasks as its flow (procGraph view: tasks keyed as the flow names them, `origin` the map's key) runs them:
// [{event, task (map key — kept when 다듬기 renames it), step (the flow's name), kind: start | artifact | done, virtual, n, p}]
//   start: an event no task raises (mail · chat · timer) that sets off one of its tasks
//   a way X → Y of the flow: X's results that set off Y; none → 「X 완료」 → Y (virtual when the map has no such edge yet)
export function entryEdgesOf(view) {
  const g = view?.all || {}
  const mapKey = (k) => view.tasks.get(k)?.origin || k
  const stepOf = new Map()
  for (const [k, t] of view.tasks) { stepOf.set(k, k); if (t.origin) stepOf.set(t.origin, k) }
  const triggers = (g.triggers || []).filter((t) => t.status !== 'gone' && t.status !== 'retired')
  const out = new Map()
  const put = (x) => { const k = edgeKey(x.event, x.task); if (!out.has(k)) out.set(k, x) }
  for (const t of triggers) {
    const step = stepOf.get(t.to)
    if (!step || raiserOf(t.from)) continue
    put({ event: t.from, task: mapKey(step), step, kind: 'start', virtual: false, n: t.n || 0, p: t.p || 0 })
  }
  for (const e of view.edges || []) {
    if (e.to === END || e.status === 'retired' || !view.tasks.has(e.from) || !view.tasks.has(e.to)) continue
    const from = mapKey(e.from), to = mapKey(e.to)
    const arts = triggers.filter((t) => String(t.from).startsWith('artifact:') && raiserOf(t.from) === from && stepOf.get(t.to) === e.to)
    if (arts.length) { for (const t of arts) put({ event: t.from, task: to, step: e.to, kind: 'artifact', virtual: false, n: t.n || 0, p: t.p || 0 }); continue }
    const done = `done:${from}`
    const t = triggers.find((x) => x.from === done && stepOf.get(x.to) === e.to)
    put({ event: done, task: to, step: e.to, kind: 'done', virtual: !t, n: t?.n || 0, p: t?.p || 0 })
  }
  return [...out.values()]
}

// a class as a person set it: {class, why, by, decided, ai} (null when none — the AI's suggestion, if any, is kept undecided)
export function nextClass(want, prev) {
  const ai = prev?.ai || null
  if (want && EDGE_CLASSES.includes(want)) {
    const same = ai?.class === want
    return { class: want, why: same ? ai.why || '' : `사람이 「${CLASS_KO[want]}」${ro(CLASS_KO[want])} 정했어요.`, by: same ? 'ai' : 'person', decided: true, ai }
  }
  return ai ? { class: ai.class, why: ai.why || '', by: 'ai', decided: false, ai } : null
}
// a setting that is or may be 꼭(its own, or one of its rules)
export const mayRequire = (s) => !!s && (s.requirement === 'required' || (s.rules || []).some((r) => r.then === 'required'))
const stepsOf = (view) => { const m = new Map(); for (const [k, t] of view.tasks) { m.set(k, k); if (t.origin) m.set(t.origin, k) } return m }

// The view a case runs (run.js procGraph) with this process's edge settings laid on: a way X → Y whose way in (X's result or 「X 완료」 → Y)
// is or may be 꼭 is `required` — the snapshot keeps it whatever θ and a split out of X goes through it (run.js unfold), only from X:
// the same step reached another way is not forced. A 꼭 on a start edge needs nothing here (the case starts there).
// `requirements` keys the snapshot (a change makes a new one).
export function edgeRequiredView(view, settings) {
  const list = settings instanceof Map ? [...settings.values()] : settings || []
  if (!list.length) return view
  const steps = stepsOf(view)
  // required: true — 꼭 itself; 'maybe' — only a rule can make it 꼭 (a split takes a sure 꼭 first)
  const ways = new Map()
  const keys = []
  for (const s of list) {
    keys.push(`${s.event}>${s.task}=${s.requirement || '-'}${(s.rules || []).map((x) => `,${x.when.field === 'amount' ? `${x.when.op}${x.when.value}` : x.when.text}>${x.then}`).join('')}`)
    if (!mayRequire(s)) continue
    const from = raiserOf(s.event)
    const a = from && steps.get(from), b = steps.get(s.task)
    if (a && b && ways.get(edgeKey(a, b)) !== true) ways.set(edgeKey(a, b), s.requirement === 'required' ? true : 'maybe')
  }
  const edges = (view.edges || []).map((e) => (ways.has(edgeKey(e.from, e.to)) ? { ...e, required: ways.get(edgeKey(e.from, e.to)) } : e))
  return { ...view, edges, requirements: keys.sort().join('|') }
}

// The ways into `task` this case came by (pure): after `prev` (the step that ended before it — the flow's name) the edges out of prev into
// task (its results or 「prev 완료」); with no prev (the case's first step) the start event's edge (mail · message · timer), and when there is
// none, the edges out of the step the case passed over just before it (skipped). [] when nothing matches (→ 지도대로).
export function caseEntryEdges(view, entries, { task, prev = null, start = null, skipped = null } = {}) {
  const mapKey = (k) => view.tasks.get(k)?.origin || k
  const into = entries.filter((e) => e.step === task || e.task === task)
  if (prev) return into.filter((e) => raiserOf(e.event) === mapKey(prev))
  const s = start ? into.filter((e) => e.event === start) : []
  if (s.length) return s
  return skipped ? into.filter((e) => raiserOf(e.event) === mapKey(skipped)) : []
}
// the start event of a case (run.js triggerOf kinds) — a timer's own event key when it has one
export const startEventOf = (trigger) => (trigger?.event ? trigger.event : trigger?.kind === 'mail' ? 'mail' : trigger?.kind === 'chat' ? 'message' : null)

// the case's way into `task` with its settings: [{edge, setting}] (settings read now, or asOf for a bpm case's snapshot)
export async function caseStepSettings(c, view, task, { prev = null, asOf } = {}) {
  const settings = await edgeConditionsOf(c.proc || c.bundle, { asOf })
  const entries = entryEdgesOf(view)
  const skippedHist = (c.history || []).filter((h) => h.state === 'skipped' && !h.step).map((h) => h.task)
  const edges = caseEntryEdges(view, entries, { task, prev, start: startEventOf(c.trigger), skipped: skippedHist.at(-1) || null })
  return edges.map((e) => ({ edge: e, setting: settings.get(edgeKey(e.event, e.task)) || null }))
}
// the class a case's way in gives the step: a decided 사람이 꼭 on any of them wins, else the first decided one, else an AI suggestion
export function classOfEdges(list) {
  const cs = list.map((x) => x.setting?.class).filter(Boolean)
  return cs.find((c) => c.decided && c.class === 'human') || cs.find((c) => c.decided) || cs[0] || null
}

// 말로 고치기(editmap.js set_requirement): 「꼭 하게」 said of a step sets 꼭 · 선택 · 지도대로 on every way into it in this process, each
// way keeping its own rules and class. → was: [{event, task, requirement}] (what each way had, for undo)
export async function setStepRequirement(me, procKey, task, requirement, { reason = '' } = {}) {
  const want = REQS.includes(requirement) ? requirement : null
  const view = await viewOf(procKey)
  const ways = entryEdgesOf(view).filter((e) => e.step === task || e.task === task)
  if (!ways.length) throw err(404, '이 프로세스에 그 단계로 들어오는 간선이 없어요.')
  const set = await edgeConditionsOf(procKey)
  const was = []
  for (const e of ways) {
    const s = set.get(edgeKey(e.event, e.task)) || null
    was.push({ event: e.event, task: e.task, requirement: s?.requirement || null })
    await writeRow(me, procKey, e, { requirement: want, rules: s?.rules || [], class: s?.class || null, reason })
  }
  await ledger(me, 'ontology.edgecond', `「${view.proc.name}」 「${task}」로 들어오는 간선 ${ways.length}개: ${want ? REQ_KO[want] : '지도대로'}`, { process: procKey, task, requirement: want, ways: ways.length, reason: reason || null })
  return was
}
// its undo: each way back to what it had — only where nobody changed it since (else 409)
export async function restoreStepRequirement(me, procKey, { task, requirement, was = [] }, { reason = '' } = {}) {
  const set = await edgeConditionsOf(procKey)
  const want = REQS.includes(requirement) ? requirement : null
  if (was.some((w) => (set.get(edgeKey(w.event, w.task))?.requirement || null) !== want)) throw err(409, '그 뒤에 이 단계로 들어오는 간선의 꼭 · 선택이 다시 바뀌어서 되돌리지 않았어요.')
  for (const w of was) {
    const s = set.get(edgeKey(w.event, w.task)) || null
    await writeRow(me, procKey, w, { requirement: w.requirement || null, rules: s?.rules || [], class: s?.class || null, reason })
  }
  await ledger(me, 'ontology.edgecond', `「${task}」로 들어오는 간선의 꼭 · 선택을 되돌림`, { process: procKey, task, was })
}
async function writeRow(me, procKey, e, { requirement, rules, class: c, reason }) {
  const cleared = !requirement && !(rules || []).length && !c
  await q(`insert into pro_edge_conditions (tenant_id, proc_key, event, task, requirement, rules, class, cleared, reason, by_user) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [T(), procKey, e.event, e.task, requirement, JSON.stringify(rules || []), c ? JSON.stringify(c) : null, cleared, clean(reason).slice(0, 300) || null, me.email || String(me.id)])
}
// 다듬기의 AI 분류(refine.js runReview → classifySteps): the model's class for each step goes onto every way into it in this process as a
// suggestion (class.ai) — a person's decided class stays, 꼭 · 선택 and rules stay. A 관문 suggestion is kept as the AI's (the panel offers
// 꼭 하는 단계 for it); 「그대로」 is not kept. classes: {step: {class, why}} → how many ways got a new suggestion
export async function putAiClasses(procKey, view, classes = {}) {
  const set = await edgeConditionsOf(procKey)
  let n = 0
  for (const e of entryEdgesOf(view)) {
    const c = classes[e.step]
    if (!c?.class || c.class === 'none') continue
    const ai = { class: c.class, why: c.why || '' }
    const s = set.get(edgeKey(e.event, e.task)) || null
    if (s?.class?.ai?.class === ai.class && s.class.ai.why === ai.why) continue
    const cls = s?.class?.decided ? { ...s.class, ai } : EDGE_CLASSES.includes(ai.class) ? { class: ai.class, why: ai.why, by: 'ai', decided: false, ai } : { class: null, why: '', by: 'ai', decided: false, ai }
    await writeRow({ email: 'AI 분류' }, procKey, e, { requirement: s?.requirement || null, rules: s?.rules || [], class: cls, reason: '다듬기의 AI 분류' })
    n++
  }
  return n
}

// 지도를 다시 셀 때 같은 일의 두 이름이 하나로 합쳐지면(names.js consolidate → [{from, to}]) 간선 설정의 키도 옮긴다: 일(task)과, 그 일이
// 낸 사건(artifact:<일>:<종류> · done:<일>). 이력 전체를 옮기므로 가장 늦은 줄이 그대로 지금 설정이다. (pure part: renamedEvent)
export const renamedEvent = (event, from, to) => {
  const e = String(event || '')
  if (e === `done:${from}`) return `done:${to}`
  if (e.startsWith(`artifact:${from}:`)) return `artifact:${to}:${e.slice(`artifact:${from}:`.length)}`
  return e
}
export async function renameTaskKeys(merged = []) {
  let n = 0
  for (const { from, to } of merged) {
    if (!from || !to || from === to) continue
    const r1 = await q(`update pro_edge_conditions set task=$3 where tenant_id=$1 and task=$2 returning id`, [T(), from, to])
    const r2 = await q(`update pro_edge_conditions set event = case when event = $2 then $3 else $5 || substr(event, length($4) + 1) end
                        where tenant_id=$1 and (event = $2 or event like $4 || '%') returning id`, [T(), `done:${from}`, `done:${to}`, `artifact:${from}:`, `artifact:${to}:`])
    n += r1.length + r2.length
  }
  return n
}

// a step's 꼭 · 선택 in a process as the model reads it (말로 고치기): 꼭 when any way in is or may be 꼭, else 선택 when any way is
export async function stepRequirementsOf(procKey, view) {
  const set = await edgeConditionsOf(procKey)
  const out = new Map()
  for (const e of entryEdgesOf(view)) {
    const s = set.get(edgeKey(e.event, e.task))
    if (!s) continue
    const cur = out.get(e.step)
    const r = mayRequire(s) ? 'required' : s.requirement === 'optional' ? 'optional' : null
    if (r && cur?.requirement !== 'required') out.set(e.step, { requirement: r })
  }
  return out
}

// 이전(scripts/migrate-edge-conditions.mjs): a process's old settings onto its ways in. entries: entryEdgesOf(view) · reqs: Map(task →
// {requirement, rules}) from pro_step_requirements · classes: pro_refine_reviews.classes · existing: Set of edgeKey already set (left alone).
// A step's setting goes onto every way into it; a decided 관문 becomes 꼭 unless 단계 규칙 says otherwise for the step (then 단계 규칙 wins and
// the 관문 is listed as dropped); the other classes keep their AI suggestion and decision. → {rows, dropped: [{task, why}], unpin: [task]}
export function migrationRows({ entries = [], reqs = new Map(), classes = {}, existing = new Set() } = {}) {
  const rows = [], dropped = new Map(), unpin = new Set()
  for (const e of entries) {
    const req = reqs.get(e.step) || reqs.get(e.task) || null
    const c = classes[e.step] ?? classes[e.task] ?? null
    if (c?.pinned_here) unpin.add(e.task)
    const gate = c?.class === 'gate' && c.decided
    if (gate && req) dropped.set(e.task, { task: e.task, why: `단계 규칙(${req.requirement ? REQ_KO[req.requirement] : '사안에 따라'})이 있어 관문 대신 단계 규칙을 옮겼어요` })
    if (existing.has(edgeKey(e.event, e.task))) continue
    const requirement = req ? req.requirement || null : gate ? 'required' : null
    const rules = req?.rules || []
    const cls = c && EDGE_CLASSES.includes(c.class) ? { class: c.class, why: c.why || '', by: c.by === 'person' ? 'person' : 'ai', decided: !!c.decided, ai: c.ai || null } : null
    if (!requirement && !rules.length && !cls) continue
    rows.push({ event: e.event, task: e.task, requirement, rules, class: cls, reason: [req && '단계 규칙에서 옮김', gate && !req && '단계 가르기의 관문에서 옮김', cls && '단계 가르기의 분류에서 옮김'].filter(Boolean).join(' · ') })
  }
  return { rows, dropped: [...dropped.values()], unpin: [...unpin] }
}

// the map's mark for an edge: 꼭 · 선택 · 사안에 따라(규칙만)
export const markOf = (s) => (!s ? null : s.requirement === 'required' ? 'req' : s.requirement === 'optional' ? 'opt' : s.rules?.length ? 'cond' : null)

// ---------- reading ----------
// asOf: as a bpm case's snapshot reads them (the settings made by then); without it, now
export async function edgeConditionsOf(procKey, { asOf } = {}) {
  const rows = await q(`select distinct on (event, task) event, task, requirement, rules, class, cleared, reason, by_user, at from pro_edge_conditions
                        where tenant_id=$1 and proc_key=$2 and ($3::timestamptz is null or at <= $3) order by event, task, at desc, id desc`, [T(), procKey, asOf || null])
  const out = new Map()
  for (const r of rows) {
    if (r.cleared) continue
    out.set(edgeKey(r.event, r.task), { event: r.event, task: r.task, requirement: r.requirement || null, rules: (r.rules || []).map(normRule).filter(Boolean),
      class: r.class || null, reason: r.reason || '', by: r.by_user || '', at: r.at })
  }
  return out
}

async function isAdmin(me) { return (await import('./service.js')).isAdmin(me) }
async function viewOf(procKey) {
  const { procGraph } = await import('./run.js')
  return procGraph(procKey)
}
// an event's name; a 「완료」 the map has no node for yet is named after the step it comes out of, as the flow names it
function eventName(view, e) {
  const node = (view.all?.events || []).find((x) => x.key === e.event)
  if (node?.name && e.kind !== 'done') return node.name
  const from = raiserOf(e.event)
  if (e.kind !== 'done' || !from) return node?.name || e.event
  const step = [...view.tasks.values()].find((t) => t.origin === from)?.key || from
  return `${step} 완료`
}
const shown = (s) => (s ? { requirement: s.requirement, rules: s.rules.map((r) => ({ ...r, text: ruleText(r) })), class: s.class, reason: s.reason, by: s.by, at: s.at } : null)

// every way into the process's tasks with what is set on it — the events view paints these
export async function edgeList(me, procKey) {
  const view = await viewOf(procKey)
  const set = await edgeConditionsOf(procKey)
  const edges = entryEdgesOf(view).map((e) => { const s = set.get(edgeKey(e.event, e.task)) || null; return { ...e, name: eventName(view, e), setting: shown(s), mark: markOf(s), cls: s?.class?.decided ? s.class.class : null } })
  // settings on ways the flow no longer has (a way cut, a step renamed on the map) are kept and listed apart
  const live = new Set(edges.map((e) => edgeKey(e.event, e.task)))
  const stray = [...set.values()].filter((s) => !live.has(edgeKey(s.event, s.task))).map((s) => ({ event: s.event, task: s.task, setting: shown(s) }))
  return { proc: { key: view.proc.key, name: view.proc.name }, edges, stray, admin: await isAdmin(me).catch(() => false) }
}

function findEdge(view, event, task) {
  const all = entryEdgesOf(view)
  const e = all.find((x) => x.event === event && (x.task === task || x.step === task))
  if (!e) throw err(404, '이 프로세스에 그 간선이 없어요.')
  return { e, all }
}

// one edge's panel: its setting, what it means, and the other ways into the same task (to copy the setting to)
export async function edgeView(me, procKey, { event, task } = {}) {
  const view = await viewOf(procKey)
  const { e, all } = findEdge(view, String(event || ''), String(task || ''))
  const set = await edgeConditionsOf(procKey)
  const s = set.get(edgeKey(e.event, e.task)) || null
  const siblings = all.filter((x) => x.task === e.task && x.event !== e.event).map((x) => { const t = set.get(edgeKey(x.event, x.task)) || null; return { event: x.event, name: eventName(view, x), kind: x.kind, setting: shown(t), mark: markOf(t), cls: t?.class?.decided ? t.class.class : null } })
  return {
    proc: { key: view.proc.key, name: view.proc.name }, event: e.event, task: e.task, step: e.step, kind: e.kind, virtual: e.virtual, name: eventName(view, e), n: e.n, p: e.p,
    requirement: s?.requirement || null, rules: (s?.rules || []).map((r) => ({ ...r, text: ruleText(r) })), class: s?.class || null, reason: s?.reason || '', by: s?.by || '', at: s?.at || null,
    lines: settingLines(s || {}).map((l) => l.replace('이 프로세스의 건은 늘 이 단계를 지나고', `이 간선으로 들어오면 이 프로세스의 건은 늘 이 단계를 하고`)),
    siblings, admin: await isAdmin(me).catch(() => false),
  }
}

// body: {event, task, requirement (required | optional | null = 지도대로), rules, class (human | ai | drop | skipped | null), reason, also: [event…] — the
// other ways into the same task to give the same setting}. Every save is a row (the table is the history); an empty setting clears it.
export async function setEdgeCondition(me, procKey, body = {}) {
  const want = body.requirement == null || body.requirement === '' || body.requirement === 'auto' ? null : String(body.requirement)
  if (want !== null && !REQS.includes(want)) throw err(400, 'requirement 는 required · optional 이거나 비워 두세요(지도대로).')
  const cls = body.class == null || body.class === '' || body.class === 'none' ? null : String(body.class)
  if (cls !== null && !EDGE_CLASSES.includes(cls)) throw err(400, `class 는 ${EDGE_CLASSES.join(' · ')} 이거나 비워 두세요.`)
  const R = (await skillRules()).stepRules || {}
  const raw = Array.isArray(body.rules) ? body.rules : []
  if (raw.length > (R.maxRules || 8)) throw err(400, `사안에 따른 규칙은 ${R.maxRules || 8}개까지예요.`)
  const rules = raw.map((x, i) => { const r = normRule(x); if (!r) throw err(400, `${i + 1}번째 규칙을 읽지 못했어요 — 금액(이상 · 초과 · 이하 · 미만과 값)이나 글로 쓴 조건, 그리고 꼭 · 선택이 있어야 해요.`); return r })
  const view = await viewOf(procKey)
  const { e, all } = findEdge(view, String(body.event || ''), String(body.task || ''))
  const also = [...new Set((Array.isArray(body.also) ? body.also : []).map(String))].filter((ev) => ev !== e.event)
  const targets = [e, ...also.map((ev) => { const x = all.find((y) => y.event === ev && y.task === e.task); if (!x) throw err(404, `같은 단계로 들어오는 간선이 아니에요: ${ev}`); return x })]
  const set = await edgeConditionsOf(procKey)
  const why = clean(body.reason).slice(0, 300) || null
  const by = me.email || String(me.id)
  for (const x of targets) {
    const was = set.get(edgeKey(x.event, x.task)) || null
    const c = nextClass(cls, was?.class)
    const cleared = !want && !rules.length && !c
    await q(`insert into pro_edge_conditions (tenant_id, proc_key, event, task, requirement, rules, class, cleared, reason, by_user) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [T(), procKey, x.event, x.task, want, JSON.stringify(rules), c ? JSON.stringify(c) : null, cleared, why, by])
    await ledger(me, 'ontology.edgecond',
      `「${view.proc.name}」 「${eventName(view, x)} → ${x.step}」: ${want ? REQ_KO[want] : '지도대로'}${rules.length ? ` · 사안에 따라 ${rules.length}가지(${rules.map(ruleText).join(' · ')})` : ''}${c?.decided ? ` · ${CLASS_KO[c.class]}` : ''}`,
      { process: procKey, event: x.event, task: x.task, requirement: want, rules, class: c?.decided ? c.class : null, reason: why,
        was: was ? { requirement: was.requirement, rules: was.rules, class: was.class?.decided ? was.class.class : null } : null })
  }
  return edgeView(me, procKey, { event: e.event, task: e.task })
}
