// 제약 이론 — 사람·에이전트 자원별 수요(도착), 처리 능력, 가동률, 대기열(WIP)과 그 추세로 제약을 찾는다.
// 처리 능력은 가정하지 않고 기록에서 읽는다: 일이 쌓여 있던 날(정오에 기다리는 건이 있던 평일)에
// 그 자원이 이 프로세스 일에 실제로 쓴 시간(B) ÷ 건당 작업 시간(S) = 하루 처리 능력 μ.
// 가동률 ρ = 도착 λ / μ. (process-gpt BottleneckAnalysis 의 FTE 부하율 = 필요 FTE / 가용 FTE 를 기록 기반으로 바꾼 것)
import { mean, percentile, resourceOf } from './analyze.js'

const DAY = 86400000
const KST = 9 * 3600000
const kstDay = (t) => Math.floor((t + KST) / DAY)          // day number in KST
const dayStart = (d) => d * DAY - KST
const weekday = (d) => new Date(d * DAY).getUTCDay()       // 0 = Sun
export const isWorkday = (d) => { const w = weekday(d); return w >= 1 && w <= 5 }
export function workdaysBetween(from, to) {
  let n = 0
  for (let d = kstDay(from); d <= kstDay(to); d++) if (isWorkday(d)) n++
  return Math.max(n, 1)
}

export const resourceKey = resourceOf

export function resources(a) {
  const W = a.window
  if (!W) return []
  const completed = a.instances.filter((i) => i.status === 'COMPLETED' && i.leadSec)
  const leadSum = completed.reduce((s, i) => s + i.leadSec, 0) || 1
  const groups = new Map()
  for (const x of a.executions) {
    const k = resourceKey(x)
    ;(groups.get(k) || groups.set(k, []).get(k)).push(x)
  }
  const days = workdaysBetween(W.from, W.to)
  const out = []
  for (const [key, xs] of groups) {
    const done = xs.filter((x) => x.done)
    const human = key.startsWith('person:')
    const S = mean(done.map((x) => x.work + x.rework)) || 0
    const lambda = xs.length / days
    // busy minutes per KST day and backlog at noon
    const busy = new Map()
    for (const x of done) for (const s of x.segs) {
      if (!['human_work', 'agent_work', 'rework'].includes(s.segment_type)) continue
      for (let d = kstDay(s.start); d <= kstDay(s.end); d++) {
        const ov = Math.min(s.end, dayStart(d + 1)) - Math.max(s.start, dayStart(d))
        if (ov > 0) busy.set(d, (busy.get(d) || 0) + ov / 1000)
      }
    }
    // a saturated day: something was already waiting at noon and was still not started at 18:00 — the
    // person did not get through the queue, so what they spent that day is what they can spend
    const backlogDays = []
    for (let d = kstDay(W.from); d <= kstDay(W.to); d++) {
      if (!isWorkday(d)) continue
      const noon = dayStart(d) + 12 * 3600000, eve = dayStart(d) + 18 * 3600000
      if (xs.some((x) => x.ready <= noon && (x.humanStart ?? x.start ?? x.finish ?? a.now) > eve)) backlogDays.push(d)
    }
    const B = backlogDays.length >= 3 ? mean(backlogDays.map((d) => busy.get(d) || 0)) : null
    const mu = B && S ? B / S : null                      // items per working day
    const rho = mu ? lambda / mu : 0
    // waiting count over time (Little): Σ waiting time / window, and the trend (last 14 days vs the 4 weeks before)
    const waitingIn = (lo, hi) => xs.reduce((s, x) => {
      const end = x.humanStart ?? x.start ?? x.finish ?? a.now
      const ov = Math.min(end, hi) - Math.max(x.ready, lo)
      return s + (ov > 0 && x.wait > 60 ? ov : 0)
    }, 0) / Math.max(hi - lo, 1)
    const wip = waitingIn(W.from, W.to)
    const wipRecent = waitingIn(W.to - 14 * DAY, W.to)
    const wipBefore = waitingIn(W.to - 42 * DAY, W.to - 14 * DAY)
    const arrivalsRecent = xs.filter((x) => x.ready > W.to - 28 * DAY).length
    const doneRecent = done.filter((x) => x.finish > W.to - 28 * DAY).length
    const waitSum = done.reduce((s, x) => s + x.wait, 0)
    const behindSum = done.reduce((s, x) => s + (x.behind || 0), 0)
    const names = [...new Set(xs.map((x) => x.name))]
    out.push({
      key, kind: human ? 'human' : 'agent', name: key.split(':').slice(1).join(':'), steps: names,
      stepIds: [...new Set(xs.map((x) => x.activityId))],
      count: xs.length, done: done.length, open: xs.length - done.length,
      lambdaPerDay: lambda, lambdaPerWeek: lambda * 5,
      workPerItem: Math.round(S), workMedian: Math.round(percentile(done.map((x) => x.work + x.rework), 0.5) || 0),
      busyPerDay: B, backlogDays: backlogDays.length, workdays: days,
      muPerDay: mu, muPerWeek: mu ? mu * 5 : null, rho,
      waitMean: Math.round(mean(done.map((x) => x.wait)) || 0), waitMedian: Math.round(percentile(done.map((x) => x.wait), 0.5) || 0),
      waitP80: Math.round(percentile(done.map((x) => x.wait), 0.8) || 0),
      waitShare: waitSum / leadSum, behindShare: waitSum ? behindSum / waitSum : 0,
      wip, wipRecent, wipBefore, arrivalsRecent, doneRecent,
      growing: wipRecent > wipBefore * 1.25 && wipRecent - wipBefore > 0.3,
    })
  }
  return out.sort((p, q) => q.rho - p.rho || q.waitShare - p.waitShare)
}

/** the constraint: highest utilization among people (ρ ≥ .5); else the longest wait in front of a person */
export function constraintOf(res) {
  const people = res.filter((r) => r.kind === 'human')
  if (!people.length) return null
  const byRho = [...people].sort((p, q) => q.rho - p.rho)[0]
  if (byRho.rho >= 0.5) return { ...byRho, capacityBound: true }
  const byWait = [...people].sort((p, q) => q.waitShare - p.waitShare)[0]
  return { ...byWait, capacityBound: false }
}
