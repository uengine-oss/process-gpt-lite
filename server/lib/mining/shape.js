// 필수·옵션 in BPMN terms (2026-11-10). A recommendation's result is the process definition it is
// registered as, so a step's kind is read from that definition, not from how often it was seen:
//   - 필수 (required): every path from the start to the end passes through the task
//   - 옵션 (optional): some path goes around it — an exclusive gateway before it, one flow into the task and
//     one that goes on without it
// What the cases show (4 of 17 went without '재무 검토') is only evidence.
//
// Every flow out of an exclusive split carries a condition (2026-11-11, openspec design 결정 9). BPMN's
// default flow is "when no other condition holds" — a condition in meaning, written without one. Written
// out as the complement, no default flow is needed; one is never kept. A condition comes from the work
// (the cases' requests and earlier documents sort every case onto the flow it took — lib/mining/branch.js)
// or from the admin. The other flow of a two-way split then gets the complement of it, in its own words
// (notHolds). Never a step's name ("이번 일에 '…'이 필요하면") or a setting.
//
// The word per step (pro_mining_suggestions.confirmed), by 'admin' or 'cases' (matched/total: how many
// cases the condition sorted right):
//   'required'                                 no way around the task
//   { kind: 'optional', skip_when }            the flow that goes on without the task carries skip_when
//   { kind: 'choice', when }                   a choice's branch (keyed by its first task) carries when
//   { kind: 'loop', redo_when }                a loop check (keyed by the task before it): the flow back
// A draft from the cases ({ kind, draft: { skip_when | when | redo_when, matched, total } }) is no condition:
// it is shown with the branch still open, and the admin may take it as it is (초안대로).
//
// A way around a task is not always a skip. Two exclusive branches that each do something (견적서 작성 |
// 제안서 작성) are 택일 (choice): one of them is done, neither can be left out. A task is 옵션 only when
// a branch of the gateway before it goes on without doing anything (an empty branch). The admin cannot
// make a choice's task 필수 or 옵션 by a word: that would take away or rewrite the other branch.
//
// Pure functions over the flattened definition (activities · gateways · sequences, as proc_def.definition
// and the miner's /discover keep it).

const clone = (x) => JSON.parse(JSON.stringify(x))
const props = (s) => { try { return typeof s === 'string' ? JSON.parse(s || '{}') : (s || {}) } catch { return {} } }
const isGateway = (def, id) => (def.gateways || []).some((g) => g.id === id && /gateway/i.test(g.type || ''))

const COND = { optional: 'skip_when', choice: 'when', loop: 'redo_when' }
const keepBy = (v) => ({ ...(v.by ? { by: v.by } : {}), ...(Number.isFinite(v.matched) ? { matched: v.matched, total: v.total } : {}), ...(v.opposite ? { opposite: v.opposite } : {}) })
export const ruleOf = (v) => {
  if (v === 'required' || v?.kind === 'required') return { kind: 'required', ...(v?.by ? { by: v.by } : {}) }
  if (!v || typeof v !== 'object' || !COND[v.kind]) return null
  const c = String(v[COND[v.kind]] || '').trim()
  return c ? { kind: v.kind, [COND[v.kind]]: c, ...keepBy(v) } : null
}
// the draft from the cases a step's entry may carry (not a condition)
export const draftOf = (v) => {
  const d = v && typeof v === 'object' && !ruleOf(v) ? v.draft : null
  const c = d && String(d[COND[v.kind]] || '').trim()
  return c ? { text: c, matched: d.matched, total: d.total } : null
}

// the complement of the conditions already on a split, in their own words
const NOT_KO = '다음에 해당하지 않으면: ', NONE_KO = '다음 어느 것에도 해당하지 않으면: '
const NOT_EN = 'When this does not hold: ', NONE_EN = 'When none of these holds: '
export function notHolds(conds) {
  const ko = conds.some((c) => /[가-힣]/.test(c))
  return conds.length === 1 ? `${ko ? NOT_KO : NOT_EN}${conds[0]}` : `${ko ? NONE_KO : NONE_EN}${conds.join(' / ')}`
}
const isComplement = (c) => [NOT_KO, NONE_KO, NOT_EN, NONE_EN].some((p) => String(c || '').startsWith(p))
// a flow whose condition the system wrote as the opposite of the others' (marked; or the older wrapped form):
// written again whenever the others change
const isComplementFlow = (s) => isComplement(s.condition) || props(s.properties).complement === true
// a condition a word set (the admin's or the work's): no longer the system's opposite
const setCond = (s, c) => { s.condition = c; const p = props(s.properties); if (p.complement) { delete p.complement; s.properties = JSON.stringify(p) } }
// the opposite each rule's condition was written out as, in plain words (branch.js writeOpposite): condition → opposite
export function oppositesOf(confirmed = {}) {
  const out = {}
  for (const v of Object.values(confirmed || {})) {
    const r = ruleOf(v)
    const c = r && r[COND[r.kind]]
    if (c && String(v.opposite || '').trim()) out[c] = String(v.opposite).trim()
  }
  return out
}

// start nodes: never the target of a flow; end nodes: never the source of one
function ends(def) {
  const seq = def.sequences || []
  const src = new Set(seq.map((s) => s.source)), tgt = new Set(seq.map((s) => s.target))
  return { starts: [...src].filter((n) => !tgt.has(n)), finals: [...tgt].filter((n) => !src.has(n)) }
}

// can the end be reached from the start without passing `avoid`?
function around(def, avoid) {
  const { starts, finals } = ends(def)
  const goal = new Set(finals)
  const seen = new Set([avoid])
  const todo = starts.filter((n) => n !== avoid)
  for (const n of todo) seen.add(n)
  while (todo.length) {
    const n = todo.pop()
    if (goal.has(n)) return true
    for (const s of def.sequences || []) if (s.source === n && !seen.has(s.target)) { seen.add(s.target); todo.push(s.target) }
  }
  return false
}

// the condition on the flow that goes around a task (the skip flow of the gateway right before it)
function skipFlow(def, actId) {
  const into = (def.sequences || []).filter((s) => s.target === actId)
  for (const s of into) {
    if (!isGateway(def, s.source)) continue
    const other = (def.sequences || []).find((x) => x.source === s.source && x.target !== actId)
    if (other) return other
  }
  return null
}

const isTask = (def, id) => (def.activities || []).some((a) => a.id === id)
const outsOf = (def, id) => (def.sequences || []).filter((s) => s.source === id)
const insOf = (def, id) => (def.sequences || []).filter((s) => s.target === id)
const nameOf = (def, id) => (def.activities || []).find((a) => a.id === id)?.name || ''

// every node reachable from `from` (itself included)
function reach(def, from) {
  const seen = new Set([from]), todo = [from]
  while (todo.length) for (const s of outsOf(def, todo.pop())) if (!seen.has(s.target)) { seen.add(s.target); todo.push(s.target) }
  return seen
}

// The branch a task is on: walk back over single-entry tasks to the split gateway the branch leaves.
// → { gateway, flow } (flow: the gateway's flow into this branch), or null when the task is on no branch
function branchOf(def, actId) {
  let node = actId
  for (let i = 0; i < 64; i++) {
    const ins = insOf(def, node)
    if (ins.length !== 1) return null
    const s = ins[0]
    if (isGateway(def, s.source) && outsOf(def, s.source).length > 1) return { gateway: s.source, flow: s }
    if (!isTask(def, s.source)) { node = s.source; continue } // a join or a pass-through gateway: keep walking back
    node = s.source
  }
  return null
}

// What one other branch of the gateway does relative to a task: 'skip' when it comes back to what
// follows the task without doing any task of its own (an empty branch); else the task it does first.
function sibling(def, flow, after) {
  const seen = new Set([flow.target]), todo = [flow.target]
  while (todo.length) {
    const n = todo.shift()
    if (after.has(n)) return { skip: true }
    if (isTask(def, n)) return { task: nameOf(def, n) }
    for (const s of outsOf(def, n)) if (!seen.has(s.target)) { seen.add(s.target); todo.push(s.target) }
  }
  return { skip: true } // runs into the end without a task
}

/** every task of the definition → { kind: 'required' | 'optional' | 'choice', skip_when, when, alternatives } */
export function stepKinds(def) {
  const out = {}
  for (const a of def?.activities || []) {
    if (!around(def, a.id)) { out[a.name] = { id: a.id, kind: 'required', skip_when: '' }; continue }
    const b = branchOf(def, a.id)
    if (!b) { out[a.name] = { id: a.id, kind: 'optional', skip_when: skipFlow(def, a.id)?.condition || '' }; continue }
    const after = reach(def, a.id)
    after.delete(a.id)
    const others = outsOf(def, b.gateway).filter((s) => s !== b.flow).map((s) => ({ flow: s, ...sibling(def, s, after) }))
    const skip = others.find((o) => o.skip)
    if (skip) out[a.name] = { id: a.id, kind: 'optional', skip_when: skip.flow.condition || '' }
    else out[a.name] = { id: a.id, kind: 'choice', skip_when: '', when: b.flow.condition || '', alternatives: others.map((o) => o.task).filter(Boolean) }
  }
  return out
}

/**
 * The definition as the admin reads it, in order: a list of
 *   { step: name }                                       a task
 *   { choice: gatewayId, branches: [{ when, items }] }   an exclusive split whose branches do different
 *                                                        tasks (items: this same list, nested); an empty
 *                                                        branch is { when, items: [] } (the work goes on
 *                                                        without it)
 * A split with one non-empty branch and an empty one is not a choice: its task is listed in place (옵션).
 * Loops (a flow back to where the walk has been) are not followed.
 */
export function flowOf(def) {
  if (!def?.activities?.length) return []
  const { starts } = ends(def)
  const visited = new Set()
  const walk = (from, stop) => {
    const items = []
    let n = from
    for (let guard = 0; n && n !== stop && guard < 256; guard++) {
      if (visited.has(n)) break
      visited.add(n)
      if (isTask(def, n)) items.push({ step: nameOf(def, n) })
      const outs = outsOf(def, n).filter((s) => !visited.has(s.target) || s.target === stop)
      if (outs.length <= 1) { n = outs[0]?.target; continue }
      // a split: where its branches meet again (the first node, nearest first, every branch reaches)
      const reaches = outs.map((s) => reach(def, s.target))
      const order = [...reaches[0]]
      const join = order.find((x) => reaches.every((r) => r.has(x)) && !visited.has(x)) || null
      const branches = outs.map((s) => ({ when: s.condition || '', items: s.target === join ? [] : walk(s.target, join) }))
      const full = branches.filter((b) => b.items.length)
      if (full.length <= 1 && isGateway(def, n)) items.push(...(full[0]?.items || []))
      else items.push({ choice: n, branches })
      n = join
    }
    return items
  }
  return walk(starts[0], null)
}

const isSplit = (def, g) => /exclusive/i.test(g.type || '') && outsOf(def, g.id).length > 1
const prio = (s) => { const p = Number(props(s.properties).priority); return Number.isFinite(p) ? p : 0 }
const withoutDefault = (s) => { const p = props(s.properties); if (!('default' in p)) return false; delete p.default; s.properties = JSON.stringify(p); return true }

// The miner draws the structure only. Conditions on a drawn (not yet registered) definition are not the
// work's or the admin's: an older miner wrote a step's name ("이번 일에 '…'이 필요하면") and a default flow.
// They go; the admin's and the cases' words are put back by applyStepRules.
export function clearMined(def0) {
  const def = clone(def0 || {})
  for (const g of def.gateways || []) {
    if (!isSplit(def, g)) continue
    for (const s of outsOf(def, g.id)) { s.condition = ''; withoutDefault(s) }
  }
  return def
}

// the first task on the way from a node (gateways passed through), '' when it runs into `stop` or the end
function firstTask(def, from, stop) {
  const seen = new Set([from]), todo = [from]
  while (todo.length) {
    const n = todo.shift()
    if (n === stop) continue
    if (isTask(def, n)) return nameOf(def, n)
    for (const s of outsOf(def, n)) if (!seen.has(s.target)) { seen.add(s.target); todo.push(s.target) }
  }
  return ''
}
// the task right before a node (walking back over gateways)
function taskBefore(def, id) {
  const seen = new Set([id]), todo = [id]
  while (todo.length) {
    const n = todo.shift()
    for (const s of insOf(def, n)) {
      if (seen.has(s.source)) continue
      if (isTask(def, s.source)) return nameOf(def, s.source)
      seen.add(s.source); todo.push(s.source)
    }
  }
  return ''
}

/**
 * Every exclusive split of the definition, as the admin decides it:
 *   { gateway, kind: 'optional' | 'choice' | 'loop', step, flows: [{ seq, target, first, tasks, redo, empty }] }
 * loop: a flow goes back to where it came from (a loop check); step is the task before the check.
 * optional: one branch does tasks and the other goes on without any; step is the branch's first task.
 * choice: the branches do different tasks; each branch is keyed by its first task.
 * tasks: the tasks a case does on that flow before the branches meet again (what tells which way it went).
 */
export function splitsOf(def) {
  const out = []
  for (const g of def?.gateways || []) {
    if (!isSplit(def, g)) continue
    const outs = outsOf(def, g.id)
    const back = outs.filter((s) => reach(def, s.target).has(g.id))
    if (back.length && back.length < outs.length) {
      out.push({ gateway: g.id, kind: 'loop', step: taskBefore(def, g.id),
        flows: outs.map((s) => ({ seq: s.id, target: s.target, first: back.includes(s) ? taskBefore(def, g.id) : firstTask(def, s.target), tasks: [], redo: back.includes(s), empty: false })) })
      continue
    }
    const reaches = outs.map((s) => reach(def, s.target))
    const join = [...reaches[0]].find((x) => reaches.every((r) => r.has(x))) || null
    const after = join ? reach(def, join) : new Set()
    const flows = outs.map((s, i) => {
      const tasks = (s.target === join ? [] : [...reaches[i]].filter((n) => !after.has(n) && isTask(def, n))).map((n) => nameOf(def, n))
      return { seq: s.id, target: s.target, first: s.target === join ? '' : firstTask(def, s.target, join), tasks, redo: false, empty: !tasks.length }
    })
    const full = flows.filter((f) => !f.empty)
    if (full.length === 1) out.push({ gateway: g.id, kind: 'optional', step: full[0].first, flows })
    else out.push({ gateway: g.id, kind: 'choice', step: full[0]?.first || '', flows })
  }
  return out
}

/**
 * Every flow of every split gets its condition where the others' decide it: the one flow left without a
 * condition gets the opposite of the rest (a complement written before is written again from them), and
 * a split whose flows all have one keeps no default flow. → { def, changed }
 * opposites: { condition: the same condition's opposite in plain words } — "견적 합계가 5천만 원 미만이면" →
 * "견적 합계가 5천만 원 이상이면". Without one, the opposite is the condition wrapped (notHolds).
 */
export function completeSplits(def0, opposites = {}) {
  const def = clone(def0 || {})
  for (const g of def.gateways || []) {
    if (!isSplit(def, g)) continue
    const outs = outsOf(def, g.id)
    for (const s of outs) if (isComplementFlow(s)) s.condition = ''
    const known = outs.filter((s) => String(s.condition || '').trim())
    const open = outs.filter((s) => !String(s.condition || '').trim())
    if (open.length === 1 && known.length) {
      const conds = known.map((s) => String(s.condition).trim())
      open[0].condition = (conds.length === 1 && opposites[conds[0]]) || notHolds(conds)
      open[0].properties = JSON.stringify({ ...props(open[0].properties), complement: true })
    }
    if (outs.every((s) => String(s.condition || '').trim())) for (const s of outs) withoutDefault(s)
  }
  return { def, changed: JSON.stringify(def) !== JSON.stringify(def0 || {}) }
}

/**
 * The splits nobody has decided (정식 등록 waits for them; a registered process shows them). A split is
 * decided when at most its complement is missing. Asked per split:
 *   { step, need: 'skip', gateway, draft }    optional: when the work goes on without the step (or 필수)
 *   { step, need: 'when', gateway, draft, alternatives }   a choice's branch: when it is taken — every open
 *                                             branch but one (the most seen: it takes the complement)
 *   { step, need: 'redo', gateway, draft }    a loop check: when the step is done again
 * draft: the cases' draft for that step ('' none), with matched/total when there is one.
 */
export function undecided(def, confirmed = {}) {
  if (!def?.activities?.length) return []
  const out = []
  const ask = (step, need, gateway, extra = {}) => {
    const d = draftOf(confirmed?.[step])
    out.push({ step, need, gateway, draft: d?.text || '', ...(d ? { matched: d.matched, total: d.total } : {}), ...extra })
  }
  for (const sp of splitsOf(def)) {
    const byId = Object.fromEntries((def.sequences || []).map((s) => [s.id, s]))
    const open = sp.flows.filter((f) => !String(byId[f.seq].condition || '').trim() || isComplementFlow(byId[f.seq]))
    const known = sp.flows.length - open.length
    if (!open.length || (open.length === 1 && known)) continue
    if (sp.kind === 'loop') { ask(sp.step, 'redo', sp.gateway); continue }
    if (sp.kind === 'optional') { ask(sp.step, 'skip', sp.gateway); continue }
    // the most seen open branch is left: it takes the complement once the others are decided
    const rest = [...open].sort((x, y) => prio(byId[x.seq]) - prio(byId[y.seq])).slice(1)
    for (const f of rest.filter((x) => x.first)) ask(f.first, 'when', sp.gateway, { alternatives: sp.flows.filter((x) => x !== f && x.first).map((x) => x.first) })
  }
  // in the order of the steps in the definition
  const at = Object.fromEntries((def.activities || []).map((a, i) => [a.name, i]))
  return out.sort((x, y) => (at[x.step] ?? 1e9) - (at[y.step] ?? 1e9))
}

/** the definition with the words applied (every split completed: completeSplits), and what could not be applied (notes) */
// opposites: the plain-words opposites of conditions already in the definition (the other rules' — a word
// applied alone must not turn their flows back into the wrapped form)
export function applyStepRules(def0, confirmed = {}, opposites = {}) {
  const def = clone(def0 || {})
  def.activities ||= []; def.gateways ||= []; def.sequences ||= []
  const notes = []
  for (const [name, v] of Object.entries(confirmed || {})) {
    const rule = ruleOf(v)
    if (!rule) continue
    const a = def.activities.find((x) => x.name === name)
    if (!a) { notes.push({ step: name, reason: 'not_in_definition' }); continue }
    if (rule.kind === 'loop') {
      const sp = splitsOf(def).find((x) => x.kind === 'loop' && x.step === name)
      if (!sp) { notes.push({ step: name, reason: 'not_loop' }); continue }
      for (const f of sp.flows) { const s = def.sequences.find((x) => x.id === f.seq); if (f.redo) setCond(s, rule.redo_when); else if (isComplementFlow(s)) s.condition = '' }
      continue
    }
    const kind = stepKinds(def)[name]
    // a choice's branch condition: on the flow into the branch
    if (rule.kind === 'choice') {
      if (kind?.kind !== 'choice') { notes.push({ step: name, reason: 'not_choice' }); continue }
      const b = branchOf(def, a.id)
      setCond(b.flow, rule.when)
      b.flow.name = rule.when.slice(0, 80)
      continue
    }
    // a branch of a choice: making it 필수 or 옵션 would take away or rewrite the other branch
    if (kind?.kind === 'choice') { notes.push({ step: name, reason: 'in_choice' }); continue }
    const gwId = `gw_opt_${a.id}`
    if (rule.kind === 'required') {
      // take away every way around it: the skip flow of the gateway right before it, and that gateway
      // when it is left with one way in and one way out
      for (;;) {
        const flow = skipFlow(def, a.id)
        if (!flow) break
        const g = flow.source
        def.sequences = def.sequences.filter((s) => s !== flow)
        const ins = def.sequences.filter((s) => s.target === g), outs = def.sequences.filter((s) => s.source === g)
        if (outs.length === 1) {
          for (const s of ins) s.target = outs[0].target
          def.sequences = def.sequences.filter((s) => s !== outs[0])
          def.gateways = def.gateways.filter((x) => x.id !== g)
        } else for (const s of outs) if (isComplementFlow(s)) s.condition = ''
      }
      // (a task on a branch of a choice is passed by the other branch: that is the choice, not a skip)
      if (stepKinds(def)[name]?.kind === 'optional') notes.push({ step: name, reason: 'still_bypassed' })
      continue
    }
    // optional: an exclusive gateway before the task; the flow going on without it carries the condition,
    // the flow into it the complement (completeSplits)
    const skipName = L2(rule.skip_when)
    const existing = def.gateways.find((g) => g.id === gwId)
    if (existing) {
      const skip = def.sequences.find((s) => s.id === `seq_opt_${a.id}_skip`)
      if (skip) { setCond(skip, rule.skip_when); skip.name = skipName }
      const keep = def.sequences.find((s) => s.id === `seq_opt_${a.id}_keep`)
      if (keep) keep.condition = ''
      existing.description = desc(a.name, rule.skip_when)
      continue
    }
    const outs = def.sequences.filter((s) => s.source === a.id)
    if (outs.length !== 1) { notes.push({ step: name, reason: 'many_outgoing' }); continue }
    if (around(def, a.id)) {
      // already bypassed (a mined branch): that skip flow takes the condition, the way in its complement
      const flow = skipFlow(def, a.id)
      if (flow) {
        setCond(flow, rule.skip_when)
        flow.name = skipName
        const keep = def.sequences.find((s) => s.source === flow.source && s.target === a.id)
        if (keep) keep.condition = ''
        continue
      }
    }
    const next = outs[0].target
    for (const s of def.sequences.filter((x) => x.target === a.id)) s.target = gwId
    def.gateways.push({ id: gwId, name: `${a.name} 여부`, type: 'exclusiveGateway', role: a.role, conditionData: [], properties: '{}', description: desc(a.name, rule.skip_when) })
    def.sequences.push({ id: `seq_opt_${a.id}_keep`, name: a.name, source: gwId, target: a.id, condition: '', properties: JSON.stringify({ priority: 1 }) })
    def.sequences.push({ id: `seq_opt_${a.id}_skip`, name: skipName, source: gwId, target: next, condition: rule.skip_when, properties: JSON.stringify({ priority: 0 }) })
  }
  return { def: completeSplits(def, { ...opposites, ...oppositesOf(confirmed) }).def, notes }
}
const L2 = (c) => `${/[가-힣]/.test(c) ? '건너뜀' : 'Skip'}: ${c}`.slice(0, 80)
const desc = (name, c) => (/[가-힣]/.test(c) ? `'${name}' 은(는) ${c} 건너뜀` : `'${name}' is skipped ${c}`)

// Before saving: the stored definition keeps the start and end events among `gateways` (several times
// over), and the BPMN generator reads a flattened definition's events only from `events` — anything in
// `gateways` is drawn as an exclusive gateway. Events go to `events`, each id once.
export function forSave(def0) {
  const def = clone(def0 || {})
  const seen = new Set()
  const once = (x) => x?.id && !seen.has(x.id) && seen.add(x.id)
  const isEvent = (x) => /event/i.test(x?.type || '') && !/gateway/i.test(x?.type || '')
  def.events = [...(def.events || []), ...(def.gateways || []).filter(isEvent)].filter(once)
  def.gateways = (def.gateways || []).filter((x) => !isEvent(x)).filter(once)
  const lanes = gatewayLanes(def)
  for (const g of def.gateways) if (!g.role && lanes[g.id]) g.role = lanes[g.id]
  return def
}

// The lane each gateway is drawn in. process-gpt's BPMN generator lays out by role (one lane per role):
// a gateway with no role is in no lane and is left at one default spot — the miner's gateways, all
// drawn on top of each other in the corner. A gateway goes in the lane of the step just before it
// (through other gateways), else — right after the start — of the step just after it.
// roleOf: an activity's lane (default: its role in the definition).
export function gatewayLanes(def, roleOf = (a) => a.role) {
  const acts = Object.fromEntries((def.activities || []).map((a) => [a.id, a]))
  const seqs = def.sequences || []
  const near = (id, dir, seen = new Set()) => {
    for (const x of seqs.filter((q) => (dir < 0 ? q.target : q.source) === id)) {
      const next = dir < 0 ? x.source : x.target
      if (seen.has(next)) continue
      seen.add(next)
      if (acts[next]) { const r = roleOf(acts[next]); if (r) return r }
      const r = near(next, dir, seen)
      if (r) return r
    }
    return ''
  }
  return Object.fromEntries((def.gateways || []).map((g) => [g.id, near(g.id, -1) || near(g.id, 1)]))
}
