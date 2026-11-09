// Numbers for the AI-DLC dashboards, all computed from the audit log and the state file.
//   design stages: AI work = started (or revising) → awaiting approval; human wait = awaiting → approved/rejected
//   units:         work = each stage's UNIT_STARTED → UNIT_COMPLETED; wait = last passing checkpoint → approval
import { describeStage, stageBySlug } from './stages.js'

const MIN = 60000
const mins = (ms) => Math.round((ms / MIN) * 10) / 10
const iso = (t) => (t == null ? null : new Date(t).toISOString())

// ---------- design (non-unit) stages ----------
export function stageMetrics(events, now = Date.now()) {
  const unitStages = new Set(events.filter((e) => e.unit && e.stage).map((e) => e.stage))
  const rows = new Map()
  const row = (stage) => {
    if (!rows.has(stage)) rows.set(stage, { stage, ai: 0, human: 0, rejects: 0, approvals: 0, workFrom: null, waitFrom: null, done: false })
    return rows.get(stage)
  }
  for (const e of events) {
    if (!e.stage || e.unit || unitStages.has(e.stage) || !stageBySlug.has(e.stage)) continue
    const r = row(e.stage)
    switch (e.event) {
      case 'STAGE_STARTED':
      case 'STAGE_REVISING':
        if (r.workFrom == null) r.workFrom = e.t
        break
      case 'STAGE_AWAITING_APPROVAL':
        if (r.workFrom != null) { r.ai += e.t - r.workFrom; r.workFrom = null }
        r.waitFrom = e.t
        break
      case 'GATE_APPROVED':
        if (r.waitFrom != null) { r.human += e.t - r.waitFrom; r.waitFrom = null }
        r.approvals++; r.done = true
        break
      case 'GATE_REJECTED':
        if (r.waitFrom != null) { r.human += e.t - r.waitFrom; r.waitFrom = null }
        r.rejects++; r.workFrom = e.t
        break
      case 'STAGE_COMPLETED':
        if (r.workFrom != null) { r.ai += e.t - r.workFrom; r.workFrom = null }
        r.done = true
        break
    }
  }
  return [...rows.values()].map((r) => ({
    ...describeStage(r.stage),
    aiMin: mins(r.ai), humanMin: mins(r.human + (r.waitFrom != null ? now - r.waitFrom : 0)), rejects: r.rejects, approvals: r.approvals,
    state: r.waitFrom != null ? 'waiting' : r.workFrom != null ? 'working' : r.done ? 'done' : 'started',
    waitingSince: iso(r.waitFrom), waitingMin: r.waitFrom != null ? mins(now - r.waitFrom) : null,
  }))
}

// ---------- units (construction runs stage by stage for each unit) ----------
export function unitMetrics(events, declared = [], now = Date.now()) {
  const units = new Map()
  const unit = (name) => {
    if (!units.has(name)) units.set(name, { name, kind: '', dependsOn: [], work: 0, open: {}, stages: {}, ok: 0, failed: 0, lastOk: null, human: 0, approved: false, started: null, finished: null })
    return units.get(name)
  }
  for (const d of declared) Object.assign(unit(d.name), { kind: d.kind, dependsOn: d.dependsOn || [] })
  for (const e of events) {
    // a hook that could not tell the unit writes "(missing marker)": not a unit of the plan
    if (!e.unit || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.unit)) continue
    const u = unit(e.unit)
    switch (e.event) {
      case 'UNIT_STARTED':
        u.open[e.stage] = e.t; u.started ??= e.t; u.stages[e.stage] = 'working'
        break
      case 'UNIT_COMPLETED':
        if (u.open[e.stage] != null) { u.work += e.t - u.open[e.stage]; delete u.open[e.stage] }
        u.stages[e.stage] = 'done'
        break
      case 'UNIT_SKIPPED':
        delete u.open[e.stage]; u.stages[e.stage] = 'skipped'
        break
      case 'CHECKPOINT_VERIFICATION_RECORDED': {
        const code = Number(e.fields['Exit Code'])
        const passed = e.fields.Verified === 'true' || code === 0
        if (passed) { u.ok++; u.lastOk = e.t } else u.failed++
        break
      }
      case 'GATE_APPROVED':
        if (u.lastOk != null) u.human += e.t - u.lastOk
        u.approved = true; u.finished = e.t; u.lastOk = null
        break
    }
  }
  const list = [...units.values()]
  const done = new Set(list.filter((u) => u.approved).map((u) => u.name))
  return list.map((u) => {
    const working = Object.keys(u.open).length > 0
    const waiting = !u.approved && u.lastOk != null
    const status = u.approved ? 'done' : waiting ? 'waiting' : working || u.started ? 'working'
      : u.dependsOn.every((d) => done.has(d)) ? 'ready' : 'blocked'
    return {
      name: u.name, kind: u.kind, dependsOn: u.dependsOn, status, stages: u.stages,
      workMin: mins(u.work), humanMin: mins(u.human + (waiting ? now - u.lastOk : 0)),
      checks: { ok: u.ok, failed: u.failed }, startedAt: iso(u.started), finishedAt: iso(u.finished),
      waitingSince: waiting ? iso(u.lastOk) : null,
    }
  })
}

// ---------- the stage rail from aidlc-state.md ----------
// marks: [x] done · [?] awaiting approval · [-] in progress · [R] revising · [S] skipped · [ ] not yet
const MARK = { x: 'done', '?': 'waiting', '-': 'working', R: 'revising', S: 'skipped' }
export function rail(state) {
  return (state.stages || []).map((s) => ({
    ...describeStage(s.slug), mark: s.mark,
    status: MARK[s.mark] || (/^SKIP/i.test(s.decision) ? 'skipped' : s.slug === state.currentStage ? 'working' : 'pending'),
  }))
}

// ---------- counts ----------
export function counts(events) {
  const n = (name) => events.filter((e) => e.event === name).length
  const checks = events.filter((e) => e.event === 'CHECKPOINT_VERIFICATION_RECORDED')
  const ok = checks.filter((e) => e.fields.Verified === 'true' || Number(e.fields['Exit Code']) === 0).length
  return {
    events: events.length, kinds: new Set(events.map((e) => e.event)).size,
    humanTurns: n('HUMAN_TURN'), questionsReplied: n('QUESTION_REPLIED'), questionsAnswered: n('QUESTION_ANSWERED'),
    approvals: n('GATE_APPROVED'), rejections: n('GATE_REJECTED'), reviews: n('REVIEW_REQUESTED'),
    sensorsFired: n('SENSOR_FIRED'), sensorsFailed: n('SENSOR_FAILED'),
    checkpoints: { ok, failed: checks.length - ok },
    firstAt: iso(events[0]?.t), lastAt: iso(events.at(-1)?.t),
  }
}

// ---------- timeline ----------
// what a person reads in a feed: the stage in words, and the one field that says what happened
const DETAIL = ['Reply', 'Person Reply', 'Feedback', 'User Input', 'Decision', 'Sensor ID', 'Exit Code', 'Request', 'Next Stage']
export function timeline(events, { limit = 50, kinds } = {}) {
  const pick = kinds ? events.filter((e) => kinds.includes(e.event)) : events
  return pick.slice(-limit).reverse().map((e) => {
    const key = DETAIL.find((k) => e.fields[k])
    // the audit log keeps line breaks of a reply as a literal \n
    const text = key ? String(e.fields[key]).replace(/\\n|\s+/g, ' ').trim() : ''
    return { ts: e.ts, event: e.event, title: e.title, stage: e.stage ? describeStage(e.stage).name : '', unit: e.unit, detail: key ? `${key}: ${text.slice(0, 160)}` : '' }
  })
}

// ---------- reviews ----------
// the latest review of each stage (and unit): its verdict and the Major findings still open
export function reviewSummary(reviews) {
  const latest = new Map()
  for (const r of reviews) {
    const key = `${r.unit}|${r.stage}`
    const prev = latest.get(key)
    if (!prev || r.path > prev.path) latest.set(key, r)
  }
  return [...latest.values()].map((r) => ({
    stage: describeStage(r.stage).name, slug: r.stage, unit: r.unit, verdict: r.verdict, rounds: reviews.filter((x) => x.stage === r.stage && x.unit === r.unit).length,
    major: r.major, minor: r.minor,
    openMajor: r.findings.filter((f) => /major/i.test(f.severity) && !/resolved|fixed|closed|해결/i.test(f.status)).length,
    path: r.path,
  }))
}
