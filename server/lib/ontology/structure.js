// 사건 · 프로세스 소속 · 역할(design-v0.3 §2 · §3): from the cases of one state, what the graph adds around the tasks and
// their NEXT edges — events that start work or come out of it (a request mail, a result file), which tasks each event
// sets off (TRIGGERS, with and/xor), which events a task raises (RAISES), which processes hold which tasks (HAS_TASK) and
// start on which events (STARTS_ON), and the roles: who performs each task (PERFORMED_BY), who plays each role (PLAYS),
// and what the role carries (members, load, agent share, handovers, single-person tasks, the kinds of results).
// Events come from rules only (first mail of a case, attachment kinds) so the map does not split on a model's wording.
// Pure: no database, no model — test/ontology-structure.test.js.
import { END, DAY } from './stats.js'

// the kinds of results (the follow-up habits' classes, lib/followups.js CLASSES, plus drawings)
export const CLS_KO = { slides: '슬라이드', doc: '문서', sheet: '표', pdf: 'PDF', audio: '오디오', image: '그림', video: '영상', drawing: '도면', link: '링크 · 파일' }
const EXT = { slides: ['pptx', 'ppt', 'key', 'odp'], doc: ['docx', 'doc', 'hwp', 'hwpx', 'odt'], sheet: ['xlsx', 'xls', 'csv', 'ods'], pdf: ['pdf'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac'], image: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'], video: ['mp4', 'mov', 'webm', 'mkv'], drawing: ['dxf', 'dwg', 'step', 'stp', 'iges', 'igs'] }
export function clsOf(name) {
  const ext = String(name || '').toLowerCase().split('.').pop()
  return Object.keys(EXT).find((k) => EXT[k].includes(ext)) || null
}
export const startEvent = (kind) => (kind === 'mail' ? { key: 'mail', kind: 'mail', cls: '', name: '요청 메일 도착' } : { key: 'message', kind: 'message', cls: '', name: '채팅 요청' })
export const artifactEvent = (task, cls) => ({ key: `artifact:${task || '*'}:${cls}`, kind: 'artifact', cls, name: task ? `${task} 결과물(${CLS_KO[cls] || cls})` : `${CLS_KO[cls] || cls} 결과물` })
const IGNORE_ROLES = new Set(['', '담당자'])
// people outside the company who still show up in the flow (a customer's review, a partner's schedule)
const OUTSIDE = /고객|거래처|협력|외부|customer|client|partner/i

const bump = (m, k, init) => { if (!m.has(k)) m.set(k, init()); return m.get(k) }

// cases: toCases(..) whose steps carry arts (Set of classes), actors (Map id → {id, name, agent}) and sources
// g: graphOf(cases) (tasks · edges), processes: [{key, caseIds, tasks}], assigned: Map(userId → role)
export function structureOf(cases, g, processes, { assigned = new Map() } = {}) {
  const events = new Map(), triggers = new Map(), raises = new Map()
  const ev = (e) => bump(events, e.key, () => ({ ...e, n: 0 }))
  const trig = (from, to, caseId) => { const t = bump(triggers, `${from}\u0000${to}`, () => ({ from, to, n: 0, cases: new Set() })); t.n++; t.cases.add(caseId) }
  const caseStart = new Map()
  for (const c of cases) {
    const first = c.steps[0]
    const start = ev(startEvent(first.sources?.has('mail_history') ? 'mail' : 'message'))
    start.n++
    caseStart.set(c.id, start.key)
    trig(start.key, first.task, c.id)
    c.steps.forEach((s, i) => {
      for (const cls of s.arts || []) {
        const e = ev(artifactEvent(s.task, cls))
        e.n++
        const r = bump(raises, `${s.task}\u0000${e.key}`, () => ({ from: s.task, to: e.key, n: 0 }))
        r.n++
        const nx = c.steps[i + 1]
        if (nx) trig(e.key, nx.task, c.id)
      }
    })
  }
  const edge = (a, b) => g.edges.get(`${a}\u0000${b}`)
  const trigRows = [...triggers.values()].map((t) => {
    const e = events.get(t.from)
    const outs = [...triggers.values()].filter((x) => x.from === t.from).map((x) => x.to)
    // and: the targets of one event run side by side — each is taken often enough and the two were seen in both orders,
    // neither order rare (a 95 / 5 split with a stray reversed case is a choice, not work done together)
    const pOf = (to) => (triggers.get(`${t.from}\u0000${to}`)?.n || 0) / e.n
    const and = outs.length > 1 && pOf(t.to) >= 0.15 && outs.some((o) => {
      if (o === t.to || pOf(o) < 0.15) return false
      const ab = edge(t.to, o)?.n || 0, ba = edge(o, t.to)?.n || 0
      return ab > 0 && ba > 0 && Math.min(ab, ba) >= 0.3 * Math.max(ab, ba)
    })
    // the condition the split learned (the raising task's NEXT edge to this target)
    const raiser = e.kind === 'artifact' ? t.from.split(':')[1] : null
    const cond = raiser ? edge(raiser, t.to)?.cond || '' : ''
    return { from: t.from, to: t.to, n: t.n, p: t.n / e.n, split: outs.length > 1 ? (and ? 'and' : 'xor') : '', cond, source: 'mined', scope: 'company', people: 0 }
  })
  const raiseRows = [...raises.values()].map((r) => ({ ...r, p: r.n / Math.max(1, g.tasks.get(r.from)?.n || r.n) }))

  // processes: membership and the events they start on
  const byId = new Map(cases.map((c) => [c.id, c]))
  const hasTask = [], startsOn = []
  for (const p of processes) {
    const pc = (p.caseIds || []).map((id) => byId.get(id)).filter(Boolean)
    if (!pc.length) continue
    const counts = new Map(), firsts = new Map(), starts = new Map()
    for (const c of pc) {
      for (const t of new Set(c.steps.map((s) => s.task))) counts.set(t, (counts.get(t) || 0) + 1)
      firsts.set(c.steps[0].task, (firsts.get(c.steps[0].task) || 0) + 1)
      const se = caseStart.get(c.id)
      starts.set(se, (starts.get(se) || 0) + 1)
    }
    for (const t of p.tasks) hasTask.push({ from: p.key, to: t, n: counts.get(t) || 0, share: (counts.get(t) || 0) / pc.length, entry_share: (firsts.get(t) || 0) / pc.length })
    for (const [e, n] of starts) startsOn.push({ from: p.key, to: e, n, share: n / pc.length })
  }

  // roles
  const roles = new Map(), plays = new Map(), performers = new Map(), performed = new Map(), taskActors = new Map()
  const role = (name) => bump(roles, name, () => ({ key: name, name, n: 0, people: new Set(), agentSteps: 0, tasks: new Map(), arts: new Set(), hin: 0, hout: 0 }))
  let first = Infinity, last = -Infinity
  for (const c of cases) c.steps.forEach((s, i) => {
    first = Math.min(first, s.at); last = Math.max(last, s.end ?? s.at)
    const r = s.role
    for (const a of s.actors?.values() || []) {
      performers.set(a.id, { key: a.id, name: a.name || a.id, is_agent: !!a.agent })
      bump(taskActors, s.task, () => new Set()).add(a.id)
    }
    if (!r || IGNORE_ROLES.has(r)) return
    const R = role(r)
    R.n++
    R.tasks.set(s.task, (R.tasks.get(s.task) || 0) + 1)
    for (const cls of s.arts || []) R.arts.add(cls)
    const pb = bump(performed, `${s.task}\u0000${r}`, () => ({ from: s.task, to: r, n: 0 }))
    pb.n++
    let agent = false
    for (const a of s.actors?.values() || []) {
      R.people.add(a.id)
      if (a.agent) agent = true
      const pl = bump(plays, `${a.id}\u0000${r}`, () => ({ from: a.id, to: r, n: 0 }))
      pl.n++
    }
    if (agent) R.agentSteps++
    const nx = c.steps[i + 1]
    if (nx?.role && nx.role !== r && !IGNORE_ROLES.has(nx.role)) { R.hout++; role(nx.role).hin++ }
  })
  const weeks = Math.max(1, (last - first) / (7 * DAY))
  const taskSteps = new Map()
  for (const p of performed.values()) taskSteps.set(p.from, (taskSteps.get(p.from) || 0) + p.n)
  const perfSteps = new Map()
  for (const p of plays.values()) perfSteps.set(p.from, (perfSteps.get(p.from) || 0) + p.n)
  // the people who hold a role (assignments and role members, design-v0.3 §3.2): members even before they do any work
  const held = (id) => { const a = assigned.get(id); return a == null ? new Set() : typeof a === 'string' ? new Set([a]) : a.roles || new Set() }
  for (const [id, a] of assigned) for (const r of held(id)) {
    if (IGNORE_ROLES.has(r)) continue
    if (a && typeof a === 'object' && !performers.has(id)) performers.set(id, { key: id, name: a.name || id, is_agent: !!a.agent })
    role(r).people.add(id)
    if (!plays.has(`${id}\u0000${r}`)) plays.set(`${id}\u0000${r}`, { from: id, to: r, n: 0 })
  }
  const roleRows = [...roles.values()].map((R) => ({
    key: R.key, name: R.name, outside: OUTSIDE.test(R.name), n: R.n, members: R.people.size, load: R.people.size ? R.n / R.people.size / weeks : 0, agent_share: R.n ? R.agentSteps / R.n : 0,
    handovers_in: R.hin, handovers_out: R.hout, artifacts: [...R.arts].sort(), tasks: [...R.tasks].sort((a, b) => b[1] - a[1]).map(([t]) => t),
    single_tasks: [...R.tasks.keys()].filter((t) => (taskActors.get(t)?.size || 0) === 1),
  }))
  return {
    events: [...events.values()], triggers: trigRows, raises: raiseRows, hasTask, startsOn, roles: roleRows,
    performedBy: [...performed.values()].map((p) => ({ ...p, share: p.n / Math.max(1, taskSteps.get(p.from) || p.n) })),
    performers: [...performers.values()],
    plays: [...plays.values()].map((p) => ({ ...p, share: p.n / Math.max(1, perfSteps.get(p.from) || p.n || 1), assigned: held(p.from).has(p.to) })),
  }
}

// personal habits → role routines (design-v0.3 §3.4 · §4): rows {userId, role, cls, task, seen, told, shared} (one per habit,
// the person's words already named as a task) → per role and result kind: which task follows and how many people do it.
// Names and words stay out; only the role, the task and the count go into the graph.
export function routinesOf(habits) {
  const by = new Map()
  for (const h of habits) {
    if (!h.role || IGNORE_ROLES.has(h.role) || !h.task) continue
    const k = `${h.role}\u0000${h.cls}\u0000${h.task}`
    const r = bump(by, k, () => ({ role: h.role, cls: h.cls, task: h.task, people: new Set(), n: 0, told: 0, shared: 0, source: h.source || 'habit' }))
    r.people.add(h.userId)
    r.n += Math.max(1, h.seen || 0)
    if (h.told) r.told++
    if (h.shared) r.shared++
  }
  return [...by.values()].map((r) => ({ ...r, people: r.people.size }))
}

// what the company map shows of the routines (the setting, design-v0.3 §4): threshold — at least `min` people of the role, or
// someone shared it themselves; all — every routine (counts only); off — none
export function shownRoutine(r, { mode = 'threshold', min = 3 } = {}) {
  if (mode === 'off') return false
  if (mode === 'all') return true
  return (r.people || 0) >= min || (r.shared || 0) > 0
}
