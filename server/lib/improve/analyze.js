// 병목·가치 흐름 분석 (순수 함수). 입력은 이미 읽어 온 정의·인스턴스·작업 항목·상태 전이 이력·이벤트.
// 단계 실행마다 리드타임을 분해하고(leadtime.js, process-gpt analytic 의 원본 규칙), 단계별로 모아
// process-gpt BottleneckAnalysis.vue 의 지표(소요시간·실행 횟수·병목 점수·재작업률·대기 시간)와
// DefinitionBottlenecks 의 구간 합(큐 대기·검토 대기·사람 판단·에이전트 수행·재작업)을 만든다.
import { buildGraph, upstreamActivities, decisionGateways, firstActivities } from './graph.js'
import {
  decomposeTask, buildBreakdown, durationSec, ms, TERMINAL_STATUSES,
  QUEUE_WAIT, REVIEW_WAIT, HUMAN_WORK, AGENT_WORK, REWORK, IDLE_GAP,
} from './leadtime.js'

export const SEGMENTS = [QUEUE_WAIT, REVIEW_WAIT, HUMAN_WORK, AGENT_WORK, REWORK, IDLE_GAP]

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const k = (v.length - 1) * p
  const lo = Math.floor(k), hi = Math.ceil(k)
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (k - lo)
}
export const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null)
const round = (x) => (x == null ? null : Math.round(x))

// "45,000,000", "4500만", 45000000 → number
export function numberOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[,\s원₩]/g, '')
  const m = /^(-?\d+(?:\.\d+)?)(억|천만|백만|만)?$/.exec(s)
  if (!m) return null
  const mul = { 억: 1e8, 천만: 1e7, 백만: 1e6, 만: 1e4 }[m[2]] || 1
  return Number(m[1]) * mul
}
// todolist.output {formId: {field: value}} (sometimes flat) → flat values
export function flatOutput(output) {
  const o = output && typeof output === 'object' ? output : {}
  const vals = Object.values(o)
  const grouped = vals.length && vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))
  return grouped ? Object.assign({}, ...vals) : o
}

/**
 * data = { def, instances:[{id,name,status,version}], todos:[{id,instId,activityId,activityName,userId,username,agentOrch,agentMode,status,output}],
 *          history:[{todo_id,to_status,changed_at,rework_seq,is_estimated}], events:[{todo_id,event_type,timestamp}], now }
 */
export function analyze(data) {
  const now = ms(data.now) ?? Date.now()
  const g = buildGraph(data.def)
  const histBy = groupBy(data.history, (h) => String(h.todo_id))
  const evBy = groupBy(data.events, (e) => String(e.todo_id))
  const insts = new Map(data.instances.map((i) => [i.id, { ...i, todos: [] }]))
  for (const t of data.todos) if (insts.has(t.instId) && g.nodes.has(t.activityId)) insts.get(t.instId).todos.push(t)

  const executions = []
  const instancesOut = []
  for (const inst of insts.values()) {
    const current = new Set(inst.current || [])
    const rows = inst.todos.map((t) => {
      const h = (histBy.get(String(t.id)) || []).map((x) => ({ ...x, at: ms(x.changed_at) })).sort((a, b) => a.at - b.at)
      const evs = evBy.get(String(t.id)) || []
      const start = h.find((x) => x.to_status === 'IN_PROGRESS')?.at ?? null
      const finish = [...h].reverse().find((x) => TERMINAL_STATUSES.has(x.to_status))?.at ?? null
      const checked = evs.filter((e) => e.event_type === 'human_checked').map((e) => ms(e.timestamp)).sort((a, b) => a - b)[0] ?? null
      return { t, h, evs, start, finish, first: h[0]?.at ?? null, checked, cancelled: h.some((x) => x.to_status === 'CANCELLED') && !h.some((x) => x.to_status === 'DONE') }
    })
      // the engine pre-creates every step's work item: one never reached (a later step, a branch not taken,
      // a step skipped by a rule) is not a run of that step
      .filter((r) => r.h.length && !r.cancelled && (r.start != null || r.finish != null || current.has(r.t.activityId)))
    if (!rows.length) continue
    const instStart = Math.min(...rows.map((r) => r.first))
    // order of execution: when the step actually got going (or was finished, for a start form)
    const key = (r) => r.start ?? r.finish ?? r.first
    rows.sort((a, b) => key(a) - key(b))
    const seqOf = new Map()
    const done = inst.status === 'COMPLETED'
    for (const r of rows) {
      const node = g.nodes.get(r.t.activityId)
      const seq = seqOf.get(r.t.activityId) || 0
      seqOf.set(r.t.activityId, seq + 1)
      // 확장 1: ready = the latest finish of an upstream step before this one got going
      const ups = new Set(upstreamActivities(g, r.t.activityId))
      const limit = (r.start ?? r.finish ?? now) + 1000
      let ready = instStart, readyFrom = null
      for (const u of rows) {
        if (u === r || !ups.has(u.t.activityId) || u.finish == null || u.finish > limit) continue
        if (u.finish > ready) { ready = u.finish; readyFrom = u }
      }
      if (r.first > ready && !r.start) ready = Math.max(ready, r.first)
      const human = node.human
      const upAgent = readyFrom ? !g.nodes.get(readyFrom.t.activityId).human || !!readyFrom.t.agentOrch : false
      const waitKind = human && upAgent ? 'review' : 'queue'
      const segs = decomposeTask({ todoId: r.t.id, activityId: r.t.activityId, isHuman: human, history: r.h, events: r.evs, ready, humanStart: r.checked, waitKind, reworkRun: seq >= 1 })
      const by = Object.fromEntries(SEGMENTS.map((k) => [k, 0]))
      for (const s of segs) by[s.segment_type] += durationSec(s)
      const end = r.finish ?? now
      executions.push({
        todoId: r.t.id, instId: inst.id, activityId: r.t.activityId, name: node.name, human, seq,
        who: r.t.userId || null, whoName: r.t.username || null, agent: !human || !!r.t.agentOrch,
        ready, start: r.start, humanStart: r.checked, finish: r.finish, done: r.finish != null,
        waitKind, segs, by,
        wait: by[QUEUE_WAIT] + by[REVIEW_WAIT], work: by[HUMAN_WORK] + by[AGENT_WORK], rework: by[REWORK], idle: by[IDLE_GAP],
        duration: Math.max(0, Math.floor((end - ready) / 1000)),
        values: flatOutput(r.t.output),
      })
    }
    const mine = executions.filter((x) => x.instId === inst.id)
    const end = done ? Math.max(...rows.map((r) => r.finish ?? r.first)) : null
    const b = buildBreakdown(mine.flatMap((x) => x.segs), { instanceStart: instStart, instanceEnd: end ?? now })
    const work = mine.reduce((a, x) => a + x.work, 0)
    instancesOut.push({
      id: inst.id, name: inst.name, status: inst.status, version: inst.version || null, start: instStart, end,
      leadSec: done ? b.lead_time_sec : null, elapsedSec: done ? null : Math.floor((now - instStart) / 1000),
      totals: b.totals, effort: b.effort, workSec: work, reworkSec: mine.reduce((a, x) => a + x.rework, 0),
      flowEff: done && b.lead_time_sec ? work / b.lead_time_sec : null,
      path: mine.map((x) => x.activityId), open: mine.filter((x) => !x.done).map((x) => x.activityId),
    })
  }

  queueSplit(executions)
  const steps = stepStats(g, executions, instancesOut)
  const branches = branchStats(g, executions, instancesOut)
  return { g, now, executions, instances: instancesOut, steps, branches, numeric: numericFields(g, executions), window: windowOf(executions, now) }
}

// 대기 = 차례 기다림(같은 담당이 먼저 받은 다른 건이 끝나기를 기다린 시간) + 담당자 기다림(나머지: 담당자가
// 이 일을 하는 시간대·다른 일). 차례 기다림만 수요·처리 능력에 따라 줄거나 는다(what-if 의 대기열 모형).
export const resourceOf = (x) => (x.human && !x.agent ? `person:${x.whoName || x.who || '담당자'}` : `agent:${x.whoName || x.name}`)
function queueSplit(executions) {
  const byRes = groupBy(executions, resourceOf)
  for (const xs of byRes.values()) {
    const sorted = [...xs].sort((p, q) => p.ready - q.ready)
    sorted.forEach((x, i) => {
      x.behind = 0
      if (x.wait <= 0) return
      const waitEnd = x.humanStart ?? x.start ?? x.finish
      if (waitEnd == null) return
      const spans = []
      for (let j = 0; j < i; j++) {
        const y = sorted[j]
        const yEnd = y.finish ?? Infinity
        if (yEnd > x.ready) spans.push([x.ready, Math.min(yEnd, waitEnd)])
      }
      let total = 0, cur = null
      for (const [s, e] of spans.filter(([s, e]) => e > s).sort((p, q) => p[0] - q[0])) {
        if (!cur || s > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [s, e] } else cur[1] = Math.max(cur[1], e)
      }
      if (cur) total += cur[1] - cur[0]
      x.behind = Math.min(x.wait, Math.round(total / 1000))
    })
  }
}

function windowOf(executions, now) {
  if (!executions.length) return null
  const from = Math.min(...executions.map((x) => x.ready))
  const to = Math.max(...executions.map((x) => x.finish ?? now))
  return { from, to, days: (to - from) / 86400000 }
}

function stepStats(g, executions, instances) {
  const completed = instances.filter((i) => i.status === 'COMPLETED')
  const out = []
  for (const id of g.activities) {
    const n = g.nodes.get(id)
    const xs = executions.filter((x) => x.activityId === id)
    const done = xs.filter((x) => x.done)
    const inst = new Set(done.map((x) => x.instId))
    const dur = done.map((x) => x.duration), wait = done.map((x) => x.wait), work = done.map((x) => x.work)
    const sums = Object.fromEntries(SEGMENTS.map((k) => [k, done.reduce((a, x) => a + x.by[k], 0)]))
    const humanWork = done.map((x) => x.by[HUMAN_WORK]).filter((v) => v > 0)
    const people = countBy(done.filter((x) => x.whoName), (x) => x.whoName)
    const perInst = groupBy(done, (x) => x.instId)
    const ranOnce = [...perInst.values()].filter((v) => v.length === 1).length
    const ranIn = completed.filter((i) => i.path.includes(id)).length
    out.push({
      id, name: n.name, role: n.role, kind: n.human ? 'human' : 'agent', draft: n.draft,
      people: Object.entries(people).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      frequency: done.length, instances: inst.size, open: xs.length - done.length,
      probability: completed.length ? ranIn / completed.length : null,
      perInstance: inst.size ? done.length / inst.size : null,
      avgDuration: round(mean(dur)), medianDuration: round(percentile(dur, 0.5)), p80Duration: round(percentile(dur, 0.8)), p90Duration: round(percentile(dur, 0.9)),
      minDuration: dur.length ? Math.min(...dur) : null, maxDuration: dur.length ? Math.max(...dur) : null,
      avgWait: round(mean(wait)), medianWait: round(percentile(wait, 0.5)), p80Wait: round(percentile(wait, 0.8)),
      avgWork: round(mean(work)), medianWork: round(percentile(work, 0.5)), p80Work: round(percentile(work, 0.8)),
      avgRework: round(mean(done.map((x) => x.rework))),
      avgBehind: round(mean(done.map((x) => x.behind || 0))), behindShare: done.reduce((a, x) => a + x.wait, 0) ? done.reduce((a, x) => a + (x.behind || 0), 0) / done.reduce((a, x) => a + x.wait, 0) : 0,
      firstPassWork: round(mean(done.filter((x) => x.seq === 0).map((x) => x.work))),
      sums, humanWorkP50: round(percentile(humanWork, 0.5)), humanWorkP90: round(percentile(humanWork, 0.9)),
      waitShareReview: sums[REVIEW_WAIT] + sums[QUEUE_WAIT] ? sums[REVIEW_WAIT] / (sums[REVIEW_WAIT] + sums[QUEUE_WAIT]) : 0,
      // process-gpt BottleneckAnalysis: 재작업률 = (반복 건수 / 전체 건수) × 100, 병목 점수 = 실행 횟수 × 평균 소요시간
      reworkRate: done.length ? ((done.length - inst.size) / done.length) * 100 : 0,
      fpy: perInst.size ? ranOnce / perInst.size : null,
      bottleneckScore: done.length * (mean(dur) || 0),
    })
  }
  const total = out.reduce((a, s) => a + s.bottleneckScore, 0) || 1
  for (const s of out) s.normalizedBottleneck = (s.bottleneckScore / total) * 100
  return out
}

// how often each branch of an exclusive split was taken: after a run of the step before the gateway,
// the next step that ran (or the end of a finished instance) tells the branch
function branchStats(g, executions, instances) {
  const byInst = groupBy(executions, (x) => x.instId)
  const status = new Map(instances.map((i) => [i.id, i.status]))
  const out = {}
  for (const gw of decisionGateways(g)) {
    const edges = g.out.get(gw.id)
    const targets = edges.map((e) => ({ e, acts: firstActivities(g, e) }))
    const all = new Set(targets.flatMap((t) => [...t.acts]))
    const ups = new Set(upstreamActivities(g, gw.id, { withLoops: false }))
    const counts = Object.fromEntries(edges.map((e) => [e.id, 0]))
    for (const [instId, xs] of byInst) {
      const ordered = [...xs].sort((a, b) => a.ready - b.ready)
      for (const x of ordered) {
        if (!ups.has(x.activityId) || !x.done) continue
        const next = ordered.filter((y) => y !== x && all.has(y.activityId) && y.ready >= x.finish - 1000).sort((a, b) => a.ready - b.ready)[0]
        let hit = next ? targets.find((t) => t.acts.has(next.activityId)) : null
        if (!next && status.get(instId) === 'COMPLETED') hit = targets.find((t) => t.acts.has('END'))
        if (hit) counts[hit.e.id]++
      }
    }
    const n = Object.values(counts).reduce((a, b) => a + b, 0)
    out[gw.id] = {
      gateway: gw.id, name: gw.name, total: n,
      edges: edges.map((e) => ({ id: e.id, target: e.target, back: g.back.has(e.id), label: e.condition || '', count: counts[e.id], p: n ? counts[e.id] / n : 1 / edges.length })),
    }
  }
  return out
}

// numeric form values (견적 금액 …) per activity: what a threshold rule would split on
function numericFields(g, executions) {
  const out = []
  for (const id of g.activities) {
    const xs = executions.filter((x) => x.activityId === id && x.done && x.seq === 0)
    const keys = new Set(xs.flatMap((x) => Object.keys(x.values || {})))
    for (const k of keys) {
      const vals = xs.map((x) => ({ instId: x.instId, v: numberOf(x.values[k]) })).filter((x) => x.v != null)
      if (vals.length < Math.max(3, xs.length * 0.6)) continue
      const v = vals.map((x) => x.v)
      out.push({ activityId: id, field: k, n: v.length, min: Math.min(...v), max: Math.max(...v), median: percentile(v, 0.5), byInstance: Object.fromEntries(vals.map((x) => [x.instId, x.v])) })
    }
  }
  return out
}

/** VSM: steps in flow order with work vs wait, lead time, first-pass yield, who; flow efficiency = Σ work / lead time. */
export function valueStream(a) {
  const completed = a.instances.filter((i) => i.status === 'COMPLETED' && i.leadSec)
  const leads = completed.map((i) => i.leadSec)
  const steps = a.steps.filter((s) => s.frequency).map((s) => {
    const xs = a.executions.filter((x) => x.activityId === s.id && x.done)
    const first = xs.filter((x) => x.seq === 0)
    return {
      id: s.id, name: s.name, role: s.role, kind: s.kind, people: s.people, rank: a.g.rank.get(s.id),
      work: round(mean(first.map((x) => x.work))), wait: round(mean(first.map((x) => x.wait))), lead: round(mean(first.map((x) => x.duration))),
      reviewWait: round(mean(first.map((x) => x.by[REVIEW_WAIT]))), queueWait: round(mean(first.map((x) => x.by[QUEUE_WAIT]))),
      behind: round(mean(first.map((x) => x.behind || 0))),
      rework: round(mean(xs.filter((x) => x.seq > 0).map((x) => x.duration))) || 0,
      probability: s.probability, perInstance: s.perInstance, fpy: s.fpy, reworkRate: s.reworkRate, n: first.length,
    }
  })
  // 흐름 효율 = Σ 작업 / 리드타임 — 건당 평균 작업(사람 판단 + 에이전트 수행, 재작업 제외) ÷ 건당 평균 리드타임
  const workPer = completed.length ? mean(completed.map((i) => i.workSec)) : null
  const leadMean = mean(leads)
  const rty = steps.reduce((p, s) => p * (s.fpy ?? 1), 1)
  return {
    steps,
    instances: completed.length,
    leadMean: round(leadMean), leadMedian: round(percentile(leads, 0.5)), leadP80: round(percentile(leads, 0.8)),
    workMean: round(workPer), waitMean: leadMean != null && workPer != null ? round(leadMean - workPer) : null,
    reworkMean: round(mean(completed.map((i) => i.reworkSec))),
    flowEfficiency: leadMean ? workPer / leadMean : null,
    flowEfficiencyMedian: percentile(completed.map((i) => i.flowEff).filter((x) => x != null), 0.5),
    rolledYield: rty,
  }
}

/** One instance: lead-time breakdown + per-step segments (the profiler's waterfall). */
export function instanceProfile(a, instId) {
  const i = a.instances.find((x) => x.id === instId)
  if (!i) return null
  const xs = a.executions.filter((x) => x.instId === instId).sort((p, q) => p.ready - q.ready)
  return {
    ...i,
    steps: xs.map((x) => ({ todoId: x.todoId, activityId: x.activityId, name: x.name, human: x.human, seq: x.seq, who: x.whoName, ready: x.ready, start: x.start, humanStart: x.humanStart, finish: x.finish, done: x.done, by: x.by, duration: x.duration,
      segments: x.segs.map((s) => ({ type: s.segment_type, start: s.start, end: s.end })) })),
  }
}

export function groupBy(list, key) {
  const m = new Map()
  for (const x of list || []) { const k = key(x); (m.get(k) || m.set(k, []).get(k)).push(x) }
  return m
}
const countBy = (list, key) => list.reduce((o, x) => { const k = key(x); o[k] = (o[k] || 0) + 1; return o }, {})
