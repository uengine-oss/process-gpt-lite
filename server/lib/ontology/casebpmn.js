// 지도에서 바로 도는 건(engine = 'map', mapengine.js)의 흐름도를 BPMN 으로 — 볼 때마다 만들어 화면에만 보이고, 아무것도 남기지 않는다
// (proc_def · form_def 행 · 파일 · Ontological 노드 없음). GET /ontology/cases/:id/flow(mapengine.js flowOf)의 bpmn 이 이것이다.
//
// 1) 계약(contract): 스냅샷이 프로세스 정의를 만드는 규칙(run.js contractOf)과 같다 — 지도를 건의 시작 일부터 펼치고(unfold, 지금 지도 또는
//    건이 고정한 시작한 날의 지도), 일마다 역할 레인(에이전트가 하는 일은 「업무 에이전트」), 나란히 하는 두 일(parallelPair)은 AND 갈림과
//    합류, 갈래가 여럿이면 XOR 갈림(배운 금액 조건 · 글로 쓴 갈림길 조건, 없으면 지난 건의 비율). contractOf 와 다른 것:
//      - 요청 접수(intake) 단계가 없다 — 지도 건은 요청이 건의 행(pro_po_cases.request)에 있다. 시작 이벤트가 바로 시작 일로 간다.
//      - 중간에서 시작한 건이 건너뛴 일(flowGraph 의 before)은 시작 일 앞에 건너뜀으로 그린다.
//      - 지금 지도로는 닿지 않는데 건이 간 일(옮기기 · 되감기 · 그 뒤 바뀐 지도 — flowGraph 의 extra)은 건이 간 길로 잇는다.
//      - 나란히 하는 두 일 중 하나가 다른 길로도 닿으면(시작 일 · 다른 일의 길 · 이 건의 옮기기) 합류 말고 제 길로도 간다 — 지도 엔진이
//        나란히가 아닌 단계를 다루듯(mapengine.js nextOf). 스냅샷은 그런 일도 합류로만 보낸다.
//      - 합류 뒤로 버려진 갈래처럼 시작에서 닿지 않는 섬은 건이 가지 않았으면 뺀다(스냅샷은 그대로 둔다). 합류는 제 갈림을 지나야 닿는다.
//      - 일의 양식(form_def) · 에이전트 사용자 · 스킬은 만들지 않는다 — 그리기만 한다. 갈림 이름은 「금액 기준」만 남긴다(좁은 칸에 군더더기).
// 2) XML: Process GPT 가 생성한 정의를 저장할 때 쓰는 변환(save_generated.py 가 부르는
//    process-gpt/services/bpmn-extractor/src/pdf2bpmn/processgpt/bpmn_xml_generator.py ProcessGPTBPMNXmlGenerator.create_bpmn_xml — 프런트
//    BPMNXmlGenerator.vue#createBpmnXml 의 파이썬 포팅)을 JS 로 옮겼다(저장 부분 없이 변환만): 같은 id 규칙(Participant · Process_1 ·
//    Lane_<n> · SequenceFlow_<from>_<to> · BPMNShape_<id> · Shape_<event> · BPMNEdge_<from>_<to>), 같은 구조(collaboration · participant ·
//    laneSet · flowNodeRef · incoming/outgoing · uengine:properties/uengine:json), _ensure_start_end_connectivity 그대로. 좌표만 다르다 — 원본의
//    Sugiyama 배치(SugiyamaLayout, 500줄) 대신 작은 계층 배치를 쓴다: 화면(BpmnView)이 저장된 정의처럼 Process GPT vue3 의 자동 배치
//    (src/lib/bpmn-auto-layout)로 다시 놓고, 이 좌표는 그 배치가 실패할 때만 보인다.
// 3) 상태: 요소 id → 이 건이 닿은 상태(flowGraph 의 상태 done · running · person · waiting · skipped · next · closed, 시작 · 갈림 · 합류는
//    지나갔으면 done), 연결 id → taken(건이 간 길) · extra(지금 지도에는 없는 길) · rewound(되감은 길) · skipped(시작 앞의 건너뛴 길).
import { flowGraph } from './mapengine.js'
import { unfold, parallelPair, actId } from './run.js'
import { parseDefinition } from './taskdef.js'
import { END } from './stats.js'

const AGENT_ROLE = '업무 에이전트'
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()
const short = (s, n = 24) => { const a = [...String(s || '')]; return a.length > n ? `${a.slice(0, n - 1).join('')}…` : a.join('') }
// a way's label in a narrow lane: a learned amount condition without its subject (「10,000,000원 이상」 — the two ways differ at the end), a text
// condition cut short (the whole text stays in the way's uengine json)
const condLabel = (c) => short(String(c).replace(/^금액\s*\(amount\)\s*이\s*/, ''))
const pctOf = (p) => `${Math.round((p || 0) * 100)}%`

// the role a step's lane is (run.js contractOf): an agent's step is the agent's, else the role that has done it
export function roleOfTask(t) {
  if (parseDefinition(t?.definition_md || '').front.runner === 'agent') return AGENT_ROLE
  return t?.role || '담당자'
}

// a lane's label: 「역할 · 이름」 when the case bound a person to the role (pro_po_cases.bindings [{role, userId, name, from}])
export function laneLabel(role, bindings) {
  const b = (Array.isArray(bindings) ? bindings : []).filter((x) => x && norm(x.role) === norm(role) && String(x.name || '').trim()).at(-1)
  return b ? `${role} · ${String(b.name).trim()}` : role
}

// ---------- the contract (run.js contractOf, for a case: no intake, the case's own ways) ----------
// → {processDefinition: {processDefinitionId, processDefinitionName, isHorizontal, roles, elements}, states, ids}
export function caseContract(view, { entry, theta, rows = [], before = [], bindings = null, texts = new Map(), graph = null, status = '', startName = '요청 도착', id = 'onto_case', horizontal = false } = {}) {
  const th = Number.isFinite(theta) ? theta : view.proc?.theta ?? 0.05
  const g = graph || flowGraph(view, { entry, theta: th, rows, before })
  const { nodes, flows } = unfold(view, entry, th)
  const pre = g.nodes.filter((n) => n.before).map((n) => n.key)
  const extra = g.nodes.map((n) => n.key).filter((k) => k !== END && !nodes.includes(k) && !pre.includes(k))
  const keys = [...pre, ...nodes, ...extra]
  const node = (k) => (k === END ? 'end' : actId(k))
  const elements = [], byId = new Map()
  const add = (el) => { if (!byId.has(el.id)) { byId.set(el.id, el); elements.push(el) } return byId.get(el.id) }
  const laneOf = (eid) => byId.get(eid)?.role || ''

  add({ elementType: 'Event', id: 'start', name: startName, role: roleOfTask(view.tasks.get(keys[0])), type: 'StartEvent' })
  for (const k of keys) {
    const t = view.tasks.get(k)
    const { front } = parseDefinition(t?.definition_md || '')
    add({ elementType: 'Activity', id: node(k), name: k, role: roleOfTask(t), type: 'UserActivity', inputData: [], outputData: [k],
      checkpoints: Array.isArray(front.checkpoints) ? front.checkpoints.map(String) : [], description: front.description || t?.description || '' })
  }

  // sequences, and the logical way (task → task) each stands for: a way through a split is two or three of them
  const seqs = [], seqKey = new Set(), ways = new Map()
  const sid = (s, t) => `SequenceFlow_${s}_${t}`
  const seq = (source, target, x = {}) => {
    if (!seqKey.has(`${source}>${target}`)) { seqKey.add(`${source}>${target}`); seqs.push({ elementType: 'Sequence', id: `s_${source}_${target}`, source, target, condition: x.condition || '', ...(x.name ? { name: x.name } : {}), ...(x.properties ? { properties: x.properties } : {}) }) }
    return sid(source, target)
  }
  const way = (from, to, ids) => ways.set(`${from}\u0000${to}`, ids)
  const states = {}

  // the head: start → the steps a mid-start passed over → the start step
  let prev = 'start'
  for (const k of pre) { states[seq(prev, node(k))] = 'skipped'; prev = node(k) }
  const head = seq(prev, node(entry))
  if (pre.length) states[head] = 'skipped'
  way('', entry, [head])

  const condOf = (f) => f.cond || texts.get(`${f.from}\u0000${f.to}`) || ''
  // splits: two parallel siblings → AND (their links to each other dropped, a join waits for both), else XOR
  const parallel = new Map(), sibling = new Set()
  for (const x of nodes) {
    const par = parallelPair(view.edges, flows, x)
    if (!par) continue
    parallel.set(x, par)
    par.targets.forEach((t) => sibling.add(t))
  }
  // (a sibling's way to the step after both goes through the join: kept apart from its own ways)
  const joins = new Map()
  const andSplit = (x, par) => {
    const gs = `g_and_${node(x)}`, gj = `j_and_${node(x)}`
    add({ elementType: 'Gateway', id: gs, name: '', role: laneOf(node(x)), type: 'ParallelGateway', gateWayType: 'bpmn:parallelGateway' })
    add({ elementType: 'Gateway', id: gj, name: '', role: laneOf(node(par.next)) || laneOf(node(x)), type: 'ParallelGateway', gateWayType: 'bpmn:parallelGateway' })
    const into = seq(node(x), gs)
    const out = seq(gj, node(par.next))
    for (const a of par.targets) {
      way(x, a, [into, seq(gs, node(a))])
      joins.set(`${a}\u0000${par.next}`, [seq(node(a), gj), out])
    }
  }
  const ownWays = (x) => {
    const outs = flows.filter((f) => f.from === x)
    if (outs.length === 1) { way(x, outs[0].to, [seq(node(x), node(outs[0].to))]); return }
    const gx = `g_${node(x)}`
    const best = [...outs].sort((a, b) => b.p - a.p)[0]
    const conds = outs.filter((f) => condOf(f))
    add({ elementType: 'Gateway', id: gx, name: outs.some((f) => f.cond) ? '금액 기준' : '', role: laneOf(node(x)), type: 'ExclusiveGateway', gateWayType: 'bpmn:exclusiveGateway' })
    const into = seq(node(x), gx)
    // a split with a learned condition uses it; without one, the most common branch is the default flow
    outs.forEach((f, i) => way(x, f.to, [into, seq(gx, node(f.to), {
      condition: conds.length ? condOf(f) : '',
      name: condOf(f) ? condLabel(condOf(f)) : pctOf(f.p),
      properties: { priority: f === best ? 0 : i + 1, ...(f === best ? { default: true } : {}) },
    })]))
  }
  const waysOf = (x) => { const par = parallel.get(x); if (par) andSplit(x, par); else ownWays(x) }
  for (const x of nodes) if (!sibling.has(x)) waysOf(x)
  // a sibling reached some other way (the start step, another step's way, a move or rewind of this case) goes on by its own ways too, as the
  // map engine does for a step that is not one of a parallel pair (mapengine.js nextOf) — the snapshot leaves such a step at the join
  const alone = new Set()
  const byOther = (x) => x === entry || rows.some((r) => r.task === x && r.via?.how !== 'parallel') || seqs.some((s) => s.target === node(x) && !s.source.startsWith('g_and_'))
  for (let grew = true; grew;) {
    grew = false
    for (const x of nodes) if (sibling.has(x) && !alone.has(x) && byOther(x)) { alone.add(x); waysOf(x); grew = true }
  }
  if (seqs.some((s) => s.target === 'end')) add({ elementType: 'Event', id: 'end', name: '끝', role: laneOf('start'), type: 'EndEvent' })

  // the ways this case took (flowGraph: via.from → task); one the map does not have is drawn as the case went
  const taken = (ids) => { for (const s of ids) if (!states[s]) states[s] = 'taken' }
  if (rows.length && !pre.length) taken([head])
  for (const r of rows) {
    const v = r.via || {}
    // a join: the ways from both siblings through the join
    const joined = v.how === 'join' && Array.isArray(v.after) ? v.after.filter((a) => joins.has(`${a}\u0000${r.task}`)) : []
    if (joined.length) { for (const a of joined) taken(joins.get(`${a}\u0000${r.task}`)); continue }
    if (!v.from) continue
    const w = ways.get(`${v.from}\u0000${r.task}`) || joins.get(`${v.from}\u0000${r.task}`)
    if (w) { taken(w); continue }
    if (!byId.has(node(v.from)) || !byId.has(node(r.task))) continue
    const s = seq(node(v.from), node(r.task))
    states[s] = v.how === 'rewound' ? 'rewound' : 'extra'
    way(v.from, r.task, [s])
  }

  // what start cannot reach (a sibling's other ways, dropped as the snapshot drops them) goes, unless the case was there
  // (a join is reached only through its own split: a step that is a sibling of two splits has a way to each join)
  const reach = new Set(['start'])
  const through = (s) => !s.target.startsWith('j_and_') || reach.has(`g_and_${s.target.slice(6)}`)
  for (let grew = true; grew;) {
    grew = false
    for (const s of seqs) if (reach.has(s.source) && !reach.has(s.target) && through(s)) { reach.add(s.target); grew = true }
  }
  const visited = new Set(rows.map((r) => node(r.task)))
  const keep = (eid) => reach.has(eid) || visited.has(eid)
  const els = elements.filter((e) => keep(e.id))
  const kept = new Set(els.map((e) => e.id))
  const sq = seqs.filter((s) => kept.has(s.source) && kept.has(s.target))
  // the end sits with a step that leads to it here (the way this case took, else the first)
  const into = sq.filter((s) => s.target === 'end')
  const endBy = into.find((s) => states[sid(s.source, s.target)]) || into[0]
  if (endBy && byId.has('end')) byId.get('end').role = laneOf(endBy.source) || byId.get('end').role

  // node states: a step's from flowGraph; start, a split or a join once the case went through it
  for (const n of g.nodes) if (n.state && kept.has(node(n.key))) states[node(n.key)] = n.state
  if (rows.length) states.start = 'done'
  if (status === 'done' && kept.has('end')) states.end = 'done'
  for (const e of els) if (e.elementType === 'Gateway' && sq.some((s) => s.source === e.id && states[sid(s.source, s.target)] && states[sid(s.source, s.target)] !== 'skipped')) states[e.id] = 'done'
  for (const k of Object.keys(states)) if (k.startsWith('SequenceFlow_') ? !sq.some((s) => sid(s.source, s.target) === k) : !kept.has(k)) delete states[k]

  // lanes: one per role, in the order the flow first meets them
  const roles = []
  // (no endpoint · resolutionRule: nothing is resolved — the diagram is only looked at)
  for (const e of els) if (e.role && !roles.some((r) => r.name === e.role)) roles.push({ name: e.role, label: laneLabel(e.role, e.role === AGENT_ROLE ? null : bindings) })
  const ids = Object.fromEntries(keys.filter((k) => kept.has(node(k))).map((k) => [k, node(k)]))
  return {
    processDefinition: { processDefinitionId: id, processDefinitionName: `${view.proc?.name || '프로세스'} · ${entry}부터`, isHorizontal: !!horizontal, data: [], roles, elements: [...els, ...sq] },
    states, ids,
  }
}

// GET /ontology/cases/:id/flow's bpmn: the diagram top to bottom (the map's side panel) and left to right (a wide place), the same ids
// → {xml, xmlWide, states, ids}
export function caseBpmn(view, opts = {}) {
  const { processDefinition, states, ids } = caseContract(view, { ...opts, horizontal: false })
  return { xml: createBpmnXml(processDefinition, false), xmlWide: createBpmnXml(processDefinition, true), states, ids }
}

// ---------- the XML (bpmn_xml_generator.py ProcessGPTBPMNXmlGenerator.create_bpmn_xml, ported; no saving) ----------
const NS = { bpmn: 'http://www.omg.org/spec/BPMN/20100524/MODEL', bpmndi: 'http://www.omg.org/spec/BPMN/20100524/DI', dc: 'http://www.omg.org/spec/DD/20100524/DC',
  di: 'http://www.omg.org/spec/DD/20100524/DI', uengine: 'http://uengine', xsi: 'http://www.w3.org/2001/XMLSchema-instance' }
// (characters XML 1.0 cannot carry are dropped: a mailbox's task names can hold them)
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
const escAttr = (s) => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const escText = (s) => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const num = (v) => String(Math.round(Number(v) * 100) / 100)

class El {
  constructor(tag, attrs = {}) { this.tag = tag; this.attrs = attrs; this.kids = []; this.text = null }
  sub(tag, attrs = {}) { const k = new El(tag, attrs); this.kids.push(k); return k }
  append(k) { this.kids.push(k); return k }
  set(k, v) { this.attrs[k] = v; return this }
  toString() {
    const a = Object.entries(this.attrs).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')
    if (!this.kids.length && this.text == null) return `<${this.tag}${a}/>`
    return `<${this.tag}${a}>${this.text != null ? escText(this.text) : ''}${this.kids.join('')}</${this.tag}>`
  }
}

const DEFAULT = { MEGA_PROCESS_ID: '미분류', MAJOR_PROCESS_ID: '미분류', DEFAULT_PROCESS_NAME: 'Unknown', FORM_ACTIVITY_TYPE: 'org.uengine.kernel.FormActivity', EVALUATE_TYPE: 'org.uengine.kernel.Evaluate' }
const taskMapping = (t) => ({ ScriptActivity: 'bpmn:scriptTask', EmailActivity: 'bpmn:sendTask', CallActivity: 'bpmn:callActivity', ManualActivity: 'bpmn:manualTask' }[t] || 'bpmn:userTask')
const checkForm = (vars, v) => Array.isArray(vars) && vars.some((d) => d?.type === 'Form' && d.name === v)
function buildExtension(obj) {
  const ext = new El('bpmn:extensionElements')
  ext.sub('uengine:properties').sub('uengine:json').text = JSON.stringify(obj || {})
  return ext
}
const sizeOf = (e) => (e.elementType === 'Activity' || e.elementType === 'CallActivity' ? [100, 80] : e.elementType === 'Event' ? [34, 34] : [50, 50])

// _ensure_start_end_connectivity: an end event nothing leads to gets the last step that leads nowhere
function ensureStartEnd(elems) {
  const seqs = elems.filter((e) => e.elementType === 'Sequence')
  const events = elems.filter((e) => e.elementType === 'Event')
  const nodes = elems.filter((e) => e.elementType !== 'Sequence')
  const starts = new Set(events.filter((e) => e.type === 'StartEvent').map((e) => String(e.id)))
  const ends = new Set(events.filter((e) => e.type === 'EndEvent').map((e) => String(e.id)))
  for (const end of ends) {
    if (seqs.some((s) => String(s.target) === end)) continue
    const cands = nodes.map((n) => String(n.id)).filter((id) => !ends.has(id) && !starts.has(id) && !seqs.some((s) => String(s.source) === id)).sort()
    if (!cands.length) continue
    const s = { id: `seq_${cands.at(-1)}_${end}`, name: '', source: cands.at(-1), target: end, condition: '', elementType: 'Sequence' }
    elems.push(s); seqs.push(s)
  }
  return elems
}

// The coordinates (in place of the original's SugiyamaLayout): layers by the longest way from the start (ways back left out), one lane per
// role side by side (top to bottom: lanes are columns; left to right: rows), steps of one layer in one lane next to each other. Sets each
// node's centre x · y and size, each sequence's waypoints and each role's boundary, as updateJsonModelWithGraphPositions does.
// along: the way the flow runs (a layer per step), across: the lanes (a slot per step of one layer in one lane); LABEL: the pool's and the
// lane's label bands before the first layer
const GAP = { v: { along: 120, across: 150 }, h: { along: 150, across: 110 }, label: 30 }
function layoutModel(model) {
  const horizontal = !!model.isHorizontal
  const nodes = model.elements.filter((e) => e.elementType !== 'Sequence')
  const seqs = model.elements.filter((e) => e.elementType === 'Sequence')
  const at = new Map(nodes.map((n, i) => [String(n.id), i]))
  const outOf = (id) => seqs.filter((s) => String(s.source) === id && at.has(String(s.target)))
  // ways back: a DFS from the start (then from whatever it did not reach), an edge to a node on the stack
  const back = new Set(), seen = new Set(), onStack = new Set()
  const dfs = (id) => {
    seen.add(id); onStack.add(id)
    for (const s of outOf(id)) { const t = String(s.target); if (onStack.has(t)) back.add(s); else if (!seen.has(t)) dfs(t) }
    onStack.delete(id)
  }
  for (const n of [...nodes].sort((a, b) => (a.type === 'StartEvent' ? -1 : 0) - (b.type === 'StartEvent' ? -1 : 0))) if (!seen.has(String(n.id))) dfs(String(n.id))
  const fwd = seqs.filter((s) => !back.has(s) && at.has(String(s.source)) && at.has(String(s.target)))
  const layer = new Map(nodes.map((n) => [String(n.id), 0]))
  const indeg = new Map(nodes.map((n) => [String(n.id), 0]))
  for (const s of fwd) indeg.set(String(s.target), indeg.get(String(s.target)) + 1)
  const queue = nodes.map((n) => String(n.id)).filter((id) => !indeg.get(id))
  while (queue.length) {
    const x = queue.shift()
    for (const s of fwd.filter((y) => String(y.source) === x)) {
      const t = String(s.target)
      layer.set(t, Math.max(layer.get(t), layer.get(x) + 1))
      indeg.set(t, indeg.get(t) - 1)
      if (!indeg.get(t)) queue.push(t)
    }
  }
  const roles = (model.roles || []).map((r) => r.name)
  const laneIx = (n) => { const i = roles.indexOf(n.role || ''); return i < 0 ? 0 : i }
  const slot = new Map(), slots = roles.map(() => 1)
  const used = new Map()
  for (const n of nodes) {
    const k = `${laneIx(n)}:${layer.get(String(n.id))}`
    const i = used.get(k) || 0
    used.set(k, i + 1); slot.set(String(n.id), i)
    slots[laneIx(n)] = Math.max(slots[laneIx(n)] || 1, i + 1)
  }
  const layers = Math.max(1, ...[...layer.values()].map((v) => v + 1))
  const G = horizontal ? GAP.h : GAP.v
  // along: the pool's label band, the lane's, then the layers; across: the lanes one after another
  const first = GAP.label * 2 + 10
  const last = first + layers * G.along + 10
  const laneFrom = []
  let acc = 0
  for (let i = 0; i < Math.max(1, roles.length); i++) { laneFrom.push(acc); acc += (slots[i] || 1) * G.across }
  const pos = new Map()
  for (const n of nodes) {
    const id = String(n.id), li = laneIx(n)
    const a = first + layer.get(id) * G.along + G.along / 2
    const c = laneFrom[li] + (slot.get(id) + 0.5) * G.across
    const [w, h] = sizeOf(n)
    // (left to right the layers run along x, as the original swaps x and y for a horizontal model)
    const x = horizontal ? a : c, y = horizontal ? c : a
    pos.set(id, { x, y, w, h })
    Object.assign(n, { x, y, width: w, height: h, layer: layer.get(id), order: slot.get(id) })
  }
  for (const s of seqs) {
    const a = pos.get(String(s.source)), b = pos.get(String(s.target))
    if (!a || !b) continue
    if (back.has(s)) {
      // a way back goes round the side
      if (horizontal) { const y = Math.max(a.y + a.h / 2, b.y + b.h / 2) + 20; s.waypoints = [{ x: a.x, y: a.y + a.h / 2 }, { x: a.x, y }, { x: b.x, y }, { x: b.x, y: b.y + b.h / 2 }] }
      else { const x = Math.max(a.x + a.w / 2, b.x + b.w / 2) + 20; s.waypoints = [{ x: a.x + a.w / 2, y: a.y }, { x, y: a.y }, { x, y: b.y }, { x: b.x + b.w / 2, y: b.y }] }
      continue
    }
    if (horizontal) {
      const p = { x: a.x + a.w / 2, y: a.y }, q = { x: b.x - b.w / 2, y: b.y }
      const m = (p.x + q.x) / 2
      s.waypoints = Math.abs(p.y - q.y) < 1 ? [p, q] : [p, { x: m, y: p.y }, { x: m, y: q.y }, q]
    } else {
      const p = { x: a.x, y: a.y + a.h / 2 }, q = { x: b.x, y: b.y - b.h / 2 }
      const m = (p.y + q.y) / 2
      s.waypoints = Math.abs(p.x - q.x) < 1 ? [p, q] : [p, { x: p.x, y: m }, { x: q.x, y: m }, q]
    }
  }
  ;(model.roles || []).forEach((r, i) => {
    const from = laneFrom[i] ?? 0, to = from + (slots[i] || 1) * G.across
    r.boundary = horizontal ? { minX: GAP.label, maxX: last, minY: from, maxY: to } : { minX: from, maxX: to, minY: GAP.label, maxY: last }
    r.boundary.width = r.boundary.maxX - r.boundary.minX
    r.boundary.height = r.boundary.maxY - r.boundary.minY
  })
  return model
}

// createBpmnXml(jsonModel, horizontal) — the elements[] form (a contract's processDefinition) → BPMN 2.0 XML with DI
export function createBpmnXml(jsonModel, horizontal = null) {
  const model = JSON.parse(JSON.stringify(jsonModel || {}))
  model.elements = Array.isArray(model.elements) ? model.elements.filter((e) => e && typeof e === 'object') : Object.values(model.elements || {})
  ensureStartEnd(model.elements)
  model.isAutoLayout = true
  if (horizontal != null) model.isHorizontal = !!horizontal
  const isHorizontal = !!model.isHorizontal
  if (!(model.roles || []).length) model.roles = [{ name: '', endpoint: '' }]
  layoutModel(model)

  // initializeXmlDocument · createCollaborationAndProcess
  const root = new El('bpmn:definitions', { ...Object.fromEntries(Object.entries(NS).map(([k, v]) => [`xmlns:${k}`, v])),
    id: `Definitions_${model.processDefinitionId || 'default'}`, targetNamespace: 'http://bpmn.io/schema/bpmn', exporter: 'Custom BPMN Modeler', exporterVersion: '1.0' })
  const name = String(model.processDefinitionName || DEFAULT.DEFAULT_PROCESS_NAME)
  root.sub('bpmn:collaboration', { id: 'Collaboration_1' }).sub('bpmn:participant', { id: 'Participant', name, processRef: 'Process_1' })
  const proc = root.sub('bpmn:process', { id: 'Process_1', name, isExecutable: 'true', megaProcessId: model.megaProcessId || DEFAULT.MEGA_PROCESS_ID, majorProcessId: model.majorProcessId || DEFAULT.MAJOR_PROCESS_ID })
  // createDataElements
  const data = (model.data || []).filter((d) => d?.name)
  if (data.length) {
    const props = proc.sub('bpmn:extensionElements').sub('uengine:properties')
    for (const d of data) props.sub('uengine:variable', { name: d.name, type: String(d.type || 'string').toLowerCase() }).sub('uengine:json').text = JSON.stringify({ value: d.defaultValue || '', options: d.description ? { description: d.description } : {} })
  }
  // createSequenceFlows
  const inComing = new Map(), outGoing = new Map()
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v) }
  const sequences = model.elements.filter((e) => e.elementType === 'Sequence' && e.source && e.target)
  for (const s of sequences) {
    const id = `SequenceFlow_${s.source}_${s.target}`
    const sf = proc.sub('bpmn:sequenceFlow', { id, ...(s.name && !s.condition ? { name: s.name } : {}), sourceRef: String(s.source), targetRef: String(s.target) })
    if (s.condition) {
      const cond = s.condition
      const payload = typeof cond === 'string' ? { condition: cond } : { condition: { _type: cond._type || DEFAULT.EVALUATE_TYPE, key: cond.key || '', value: cond.value || '', condition: cond.condition || '==' } }
      // (the original names a flow by its condition text; the narrow diagram shows it shortened — the whole text stays in the json)
      if (typeof cond === 'string') sf.set('name', s.name || cond)
      sf.append(buildExtension({ ...payload, ...(s.properties || {}) }))
    } else if (s.properties) sf.append(buildExtension(s.properties))
    push(inComing, String(s.target), id); push(outGoing, String(s.source), id)
  }
  // createProcessElements
  const lanes = new Map()
  const io = (el, id) => { for (const x of inComing.get(id) || []) el.sub('bpmn:incoming').text = x; for (const x of outGoing.get(id) || []) el.sub('bpmn:outgoing').text = x }
  for (const e of model.elements.filter((x) => x.elementType && x.elementType !== 'Sequence')) {
    const id = String(e.id)
    push(lanes, String(e.role || ''), id)
    if (e.elementType === 'Activity' || e.elementType === 'CallActivity') {
      const task = proc.sub(taskMapping(e.elementType === 'CallActivity' ? 'CallActivity' : e.type), { id, name: e.name || '' })
      if (e.elementType === 'CallActivity') continue
      io(task, id)
      const p = {}
      if (e.description) p.description = e.description
      if (e.role) p.role = e.role
      const map = (list, dir) => list.map((item) => ({ dataFieldId: item, [dir]: '변수명', type: checkForm(model.data, item) ? DEFAULT.FORM_ACTIVITY_TYPE : DEFAULT.EVALUATE_TYPE }))
      if (e.inputData?.length) p.inputMapping = map(e.inputData, 'to')
      if (e.outputData?.length) p.outputMapping = map(e.outputData, 'from')
      if (e.checkpoints?.length) p.checkpoints = e.checkpoints
      if (e.properties && typeof e.properties === 'object') Object.assign(p, e.properties)
      if (Object.keys(p).length) task.append(buildExtension(p))
    } else if (e.elementType === 'Gateway') {
      const gw = proc.sub(String(e.gateWayType || 'bpmn:exclusiveGateway'), { id, name: e.name || '' })
      io(gw, id)
      const p = {}
      if (e.description) p.description = e.description
      if (e.conditionData?.length) p.conditionData = e.conditionData
      if (e.properties && typeof e.properties === 'object') Object.assign(p, e.properties)
      if (Object.keys(p).length) gw.append(buildExtension(p))
    } else if (e.elementType === 'Event') {
      const evt = proc.sub(e.type === 'StartEvent' ? 'bpmn:startEvent' : e.type === 'EndEvent' ? 'bpmn:endEvent' : 'bpmn:intermediateThrowEvent', { id, name: e.name || '' })
      if (e.eventType === 'Timer') evt.sub('bpmn:timerEventDefinition')
      else if (e.eventType === 'Message') evt.sub('bpmn:messageEventDefinition')
      const p = {}
      if (e.description) p.description = e.description
      if (e.expression) p.expression = e.expression
      if (Object.keys(p).length) evt.append(buildExtension(p))
      io(evt, id)
    }
  }
  // createLaneSet (Lite: a role may carry a label for its lane — 「역할 · 이름」)
  const laneSet = proc.sub('bpmn:laneSet', { id: 'LaneSet_1' })
  model.roles.forEach((r, i) => {
    const lane = laneSet.sub('bpmn:lane', { id: `Lane_${i}`, name: r.label || r.name || '', ...(r.resolutionRule != null ? { resolutionRule: r.resolutionRule } : {}) })
    if (r.endpoint != null && r.endpoint !== '') lane.append(buildExtension({ roleResolutionContext: { endpoint: r.endpoint, ...(r.endpoint === 'external_customer' ? { _type: 'org.uengine.kernel.ExternalCustomerRoleResolutionContext' } : {}) } }))
    for (const id of lanes.get(String(r.name || '')) || []) lane.sub('bpmn:flowNodeRef').text = id
  })
  // createDiagram · createShapes · participant and lane shapes · createSequenceEdges
  const plane = root.sub('bpmndi:BPMNDiagram', { id: 'BPMNDiagram_1' }).sub('bpmndi:BPMNPlane', { id: 'BPMNPlane_1', bpmnElement: 'Collaboration_1' })
  const at = new Map()
  for (const e of model.elements.filter((x) => x.elementType && x.elementType !== 'Sequence')) {
    const [w, h] = sizeOf(e)
    const x0 = Number(e.x) - w / 2, y0 = Number(e.y) - h / 2
    const shape = plane.sub('bpmndi:BPMNShape', { id: e.elementType === 'Event' ? `Shape_${e.id}` : `BPMNShape_${e.id}`, bpmnElement: String(e.id), ...(e.elementType === 'Gateway' ? { isMarkerVisible: 'true' } : {}) })
    shape.sub('dc:Bounds', { x: num(x0), y: num(y0), width: String(w), height: String(h) })
    if (e.name) shape.sub('bpmndi:BPMNLabel').sub('dc:Bounds', { x: num(x0), y: num(y0 + h + 5), width: String(w), height: '14' })
    at.set(String(e.id), { x: Number(e.x), y: Number(e.y), w, h })
  }
  const bs = model.roles.map((r) => r.boundary).filter(Boolean)
  const pad = { x: isHorizontal ? 30 : 0, y: isHorizontal ? 0 : 30 }
  const pb = bs.length ? { x: Math.min(...bs.map((b) => b.minX)) - pad.x, y: Math.min(...bs.map((b) => b.minY)) - pad.y, w: Math.max(...bs.map((b) => b.maxX)) - Math.min(...bs.map((b) => b.minX)) + pad.x, h: Math.max(...bs.map((b) => b.maxY)) - Math.min(...bs.map((b) => b.minY)) + pad.y } : { x: 0, y: 0, w: 800, h: 600 }
  plane.sub('bpmndi:BPMNShape', { id: 'Participant_1', bpmnElement: 'Participant', isHorizontal: String(isHorizontal) }).sub('dc:Bounds', { x: num(pb.x), y: num(pb.y), width: num(pb.w), height: num(pb.h) })
  model.roles.forEach((r, i) => {
    const b = r.boundary
    if (!b) return
    const shape = plane.sub('bpmndi:BPMNShape', { id: `BPMNShape_${i}`, bpmnElement: `Lane_${i}`, isHorizontal: String(isHorizontal) })
    shape.sub('dc:Bounds', { x: num(b.minX), y: num(b.minY), width: num(b.width), height: num(b.height) })
    shape.sub('bpmndi:BPMNLabel').sub('dc:Bounds', { x: num(b.minX + 10), y: num(b.minY + 5), width: '100', height: '14' })
  })
  for (const s of sequences) {
    if ((!at.has(String(s.source)) || !at.has(String(s.target))) && !s.waypoints) continue
    const edge = plane.sub('bpmndi:BPMNEdge', { id: `BPMNEdge_${s.source}_${s.target}`, bpmnElement: `SequenceFlow_${s.source}_${s.target}` })
    for (const p of s.waypoints || []) edge.sub('di:waypoint', { x: num(p.x), y: num(p.y) })
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${root}`
}
