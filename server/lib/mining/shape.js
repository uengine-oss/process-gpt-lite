// 필수·옵션 in BPMN terms (2026-11-10). A recommendation's result is the process definition it is
// registered as, so a step's kind is read from that definition, not from how often it was seen:
//   - 필수 (required): every path from the start to the end passes through the task
//   - 옵션 (optional): some path goes around it — an exclusive gateway with a condition on the flow that
//     skips it, and the flow into the task as the default (the engine always takes exactly one)
// What the cases show (4 of 17 went without '재무 검토') is only evidence; when a task is skipped is the
// admin's to say, and until they say it the definition does not change.
//
// The admin's word per step (pro_mining_suggestions.confirmed):
//   'required'                              no way around the task
//   { kind: 'optional', skip_when: '…' }    an exclusive gateway before it; the skip flow carries skip_when
//                                           (a natural-language condition the engine judges on the
//                                           work items' data), the flow into the task is the default
// ('optional' without a condition, left by the first version of this feature, changes nothing.)
//
// Pure functions over the flattened definition (activities · gateways · sequences, as proc_def.definition
// and the miner's /discover keep it).

const clone = (x) => JSON.parse(JSON.stringify(x))
const props = (s) => { try { return typeof s === 'string' ? JSON.parse(s || '{}') : (s || {}) } catch { return {} } }
const isGateway = (def, id) => (def.gateways || []).some((g) => g.id === id && /gateway/i.test(g.type || ''))

export const ruleOf = (v) => (v === 'required' ? { kind: 'required' } : v && typeof v === 'object' && v.kind === 'optional' && String(v.skip_when || '').trim() ? { kind: 'optional', skip_when: String(v.skip_when).trim() } : null)

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

/** every task of the definition → { kind: 'required' | 'optional', skip_when } */
export function stepKinds(def) {
  const out = {}
  for (const a of def?.activities || []) {
    const opt = around(def, a.id)
    const flow = opt ? skipFlow(def, a.id) : null
    out[a.name] = { id: a.id, kind: opt ? 'optional' : 'required', skip_when: flow?.condition || '' }
  }
  return out
}

/** the definition with the admin's word applied, and what could not be applied (notes) */
export function applyStepRules(def0, confirmed = {}) {
  const def = clone(def0 || {})
  def.activities ||= []; def.gateways ||= []; def.sequences ||= []
  const notes = []
  for (const [name, v] of Object.entries(confirmed || {})) {
    const rule = ruleOf(v)
    if (!rule) continue
    const a = def.activities.find((x) => x.name === name)
    if (!a) { notes.push({ step: name, reason: 'not_in_definition' }); continue }
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
        }
      }
      if (around(def, a.id)) notes.push({ step: name, reason: 'still_bypassed' })
      continue
    }
    // optional: an exclusive gateway before the task; skip flow → what follows the task, with the condition
    const existing = def.gateways.find((g) => g.id === gwId)
    if (existing) {
      const skip = def.sequences.find((s) => s.id === `seq_opt_${a.id}_skip`)
      if (skip) { skip.condition = rule.skip_when; skip.name = `건너뜀: ${rule.skip_when}`.slice(0, 80) }
      existing.description = `'${a.name}' 은(는) ${rule.skip_when} 건너뜀`
      continue
    }
    const outs = def.sequences.filter((s) => s.source === a.id)
    if (outs.length !== 1) { notes.push({ step: name, reason: 'many_outgoing' }); continue }
    if (around(def, a.id)) {
      // already bypassed (a mined branch): give that skip flow the admin's condition and make the way in the default
      const flow = skipFlow(def, a.id)
      if (flow) {
        flow.condition = rule.skip_when
        flow.name = `건너뜀: ${rule.skip_when}`.slice(0, 80)
        flow.properties = JSON.stringify({ ...props(flow.properties), default: false, priority: 0 })
        const keep = def.sequences.find((s) => s.source === flow.source && s.target === a.id)
        if (keep) { keep.condition = ''; keep.properties = JSON.stringify({ ...props(keep.properties), default: true, priority: 1 }) }
        continue
      }
    }
    const next = outs[0].target
    for (const s of def.sequences.filter((x) => x.target === a.id)) s.target = gwId
    def.gateways.push({ id: gwId, name: `${a.name} 여부`, type: 'exclusiveGateway', role: a.role, conditionData: [], properties: '{}',
      description: `'${a.name}' 은(는) ${rule.skip_when} 건너뜀` })
    def.sequences.push({ id: `seq_opt_${a.id}_keep`, name: a.name, source: gwId, target: a.id, condition: '', properties: JSON.stringify({ default: true, priority: 1 }) })
    def.sequences.push({ id: `seq_opt_${a.id}_skip`, name: `건너뜀: ${rule.skip_when}`.slice(0, 80), source: gwId, target: next, condition: rule.skip_when, properties: JSON.stringify({ priority: 0 }) })
  }
  return { def, notes }
}

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
