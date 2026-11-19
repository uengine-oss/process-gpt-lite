// 흐름 분석의 셈(설계 docs/auto-ax-onboarding/design-improve-on-map.md §4): 병목 · 회사의 제약 · 흔한 길(크리티컬 패스) · 걸린 시간.
// Pure functions — no database, no model. The loader (flowload.js) hands in what the map and the work items say.
//
// 원천은 프로세스 지도다:
//   - 일(Task)과 넘어감(NEXT, 확률 p): 지도가 마이닝으로 이미 센 것 — 자주 일어난 길(θ 위)이 흐름이다
//   - 지금 쌓인 할 일(WIP): 지도 엔진 · 스냅샷 건이 단계마다 넣는 todolist 행(activity_id = 일 이름의 해시)을 일마다 센다
//   - 걸린 시간: 실행 건(todolist 의 시작 ~ 끝)이 5건 이상이면 그것, 아니면 메일 · 대화 기록에서 잰 응답 시간(추정)
// 병목 = 사람 · 우리 쪽 일 가운데 지금 할 일이 가장 많이 쌓인 일. 회사의 제약 = 그 할 일을 역할로 모아(여러 프로세스에 걸쳐) 한 사람당
// 가장 많이 짊어진 역할. 흔한 길 = 보통 건이 지나는 길(−log p 가 가장 작은 길) 위에서 일마다 걸린 시간 + 그 앞에 쌓인 할 일을 치우는
// 데 드는 시간(리틀의 법칙: 쌓인 양 ÷ 하루 처리량)을 더한 것 — 병목이 그 길 위에 있으면 그 일의 기다림이 리드타임을 정한다.

export const END = '__end__'
export const HOUR = 3_600_000
export const DAY = 86_400_000
export const KST = 9 * HOUR
// 근무 시간(설계 §4.1 · 결정 1 권고): 평일 9~18시, 한국 시각 — 금요일 저녁 메일에 월요일 아침 답한 것은 62시간이 아니라 근무 1시간
export const WORK = { from: 9, to: 18 }
export const WORK_H = WORK.to - WORK.from
export const MIN_RUN = 5 // 실행 건이 이만큼 있으면 실행 기록으로 잰다(stats.js MIN_HOLDOUT 과 같은 수)
export const OPEN = ['NEW', 'TODO', 'IN_PROGRESS', 'PENDING']
export const ENDED = ['DONE', 'SUBMITTED']

const ms = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

// ---------- 근무 시간 ----------
// working milliseconds between a and b (weekdays WORK.from–WORK.to, Korea's clock; no holidays)
export function workMs(a, b, W = WORK) {
  let x = ms(a), y = ms(b)
  if (!(y > x)) return 0
  let out = 0
  // walk day by day in Korea's clock
  let d = Math.floor((x + KST) / DAY) * DAY - KST
  for (let i = 0; d < y && i < 4000; i++, d += DAY) {
    const wd = new Date(d + KST).getUTCDay()
    if (wd === 0 || wd === 6) continue
    const s = Math.max(x, d + W.from * HOUR), e = Math.min(y, d + W.to * HOUR)
    if (e > s) out += e - s
  }
  return out
}
// the instant `hours` working hours after `from` (the seed's clock: work time → a wall timestamp)
export function addWork(from, hours, W = WORK) {
  let left = Math.max(0, hours) * HOUR
  let t = ms(from)
  for (let i = 0; i < 4000; i++) {
    const d = Math.floor((t + KST) / DAY) * DAY - KST
    const wd = new Date(d + KST).getUTCDay()
    const s = d + W.from * HOUR, e = d + W.to * HOUR
    if (wd !== 0 && wd !== 6 && t < e) {
      const start = Math.max(t, s)
      if (start + left <= e) return start + left
      left -= e - start
    }
    t = d + DAY
  }
  return t
}

// ---------- 작은 통계 ----------
export function quantile(xs, p) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i)
  return v[lo] + (v[hi] - v[lo]) * (i - lo)
}
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0)
const round = (v, k = 2) => (Number.isFinite(v) ? +v.toFixed(k) : null)

// ---------- 걸린 시간: 기록(마이닝) 등급 ----------
// cases from stats.js toCases: [{id, steps: [{task, at, end, role}]}]. A step's response time runs from when the work reached it (the step
// before ended — the handover) to when it was handed on (its own last record); a case's first step has only its own records. A first step
// with a single record cannot be timed (0 is not a measurement). → [{task, case, workMs, wallMs, from, at}]
export function minedSamples(cases, { tasks = null } = {}) {
  const out = []
  for (const c of cases) {
    c.steps.forEach((s, i) => {
      if (tasks && !tasks.has(s.task)) return
      const prev = c.steps[i - 1]
      const from = prev ? prev.end : s.at
      if (!prev && s.end <= s.at) return
      out.push({ task: s.task, prev: prev?.task || null, case: c.id, from, at: s.end, wallMs: Math.max(0, s.end - from), workMs: workMs(from, s.end), role: s.role || null })
    })
  }
  return out
}

// the stretches between two steps (구간 — what a NEXT edge costs): a task's response times grouped by the step before it (records only)
// → [{from, to, n, medH, p80H}] with at least `min` samples
export function wayTimes(samples, { min = 3 } = {}) {
  const by = new Map()
  for (const s of samples) {
    if (!s.prev) continue
    const k = `${s.prev}\u0000${s.task}`
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(s.workMs / HOUR)
  }
  return [...by].filter(([, xs]) => xs.length >= min).map(([k, xs]) => {
    const [from, to] = k.split('\u0000')
    return { from, to, n: xs.length, medH: round(quantile(xs, 0.5)), p80H: round(quantile(xs, 0.8)) }
  }).sort((a, b) => b.medH - a.medH)
}

// executed work items (todolist rows of map / snapshot cases) → samples of the same shape: created → ended
export function runSamples(rows) {
  return rows.filter((r) => ENDED.includes(r.status) && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start)
    .map((r) => ({ task: r.task, case: r.caseId, from: r.start, at: r.end, wallMs: r.end - r.start, workMs: workMs(r.start, r.end), agent: !!r.agent }))
}

// a task's time: the run records when there are MIN_RUN of them, else the mail · chat records (추정). Medians in working hours.
export function taskTime(mined = [], run = [], { min = MIN_RUN } = {}) {
  const pick = run.length >= min ? run : mined
  const grade = run.length >= min ? 'run' : mined.length ? 'mined' : 'none'
  const h = (xs) => xs.map((x) => x.workMs / HOUR)
  const wall = (xs) => xs.map((x) => x.wallMs / HOUR)
  return {
    grade, estimated: grade !== 'run', n: pick.length, nRun: run.length, nMined: mined.length,
    medH: round(quantile(h(pick), 0.5)), p80H: round(quantile(h(pick), 0.8)), meanH: round(mean(h(pick))),
    wallMedH: round(quantile(wall(pick), 0.5)), wallMeanH: round(mean(wall(pick))),
  }
}

// ---------- 흐름: 기대 방문 · 흔한 길 ----------
// The ways a process's cases take, from its view: edges [{from, to, p}] (END included). Each task's ways out are made to sum to 1.
function outsOf(edges, keys) {
  const outs = new Map()
  for (const e of edges) {
    if (!keys.has(e.from) || !(e.p > 0) || e.status === 'retired') continue
    if (e.to !== END && !keys.has(e.to)) continue
    if (!outs.has(e.from)) outs.set(e.from, [])
    outs.get(e.from).push({ to: e.to, p: e.p })
  }
  for (const list of outs.values()) { const s = list.reduce((a, o) => a + o.p, 0); for (const o of list) o.p /= s || 1 }
  return outs
}

// Expected visits per case (an absorbing Markov chain over the ways; loops back are counted, so no scenario limit is needed):
// v = s + v·P, solved by iteration. starts: {task: share} (normalised). A chain that would loop for ever is cut at `cap` visits.
export function expectedVisits(edges, starts, { cap = 50, iters = 5000, eps = 1e-9 } = {}) {
  const keys = new Set([...Object.keys(starts), ...edges.flatMap((e) => [e.from, e.to]).filter((k) => k !== END)])
  const outs = outsOf(edges, keys)
  const sum = Object.values(starts).reduce((a, b) => a + b, 0) || 1
  const s = new Map([...keys].map((k) => [k, (starts[k] || 0) / sum]))
  let v = new Map(s)
  for (let i = 0; i < iters; i++) {
    const nv = new Map(s)
    for (const [k, list] of outs) {
      const vk = v.get(k) || 0
      if (!vk) continue
      for (const o of list) if (o.to !== END) nv.set(o.to, (nv.get(o.to) || 0) + vk * o.p)
    }
    let diff = 0
    for (const k of keys) { const x = Math.min(cap, nv.get(k) || 0); diff = Math.max(diff, Math.abs(x - (v.get(k) || 0))); nv.set(k, x) }
    v = nv
    if (diff < eps) break
  }
  return v
}

// The way a usual case goes: from `start`, the way the map engine itself takes when nothing else decides (mapengine.js pickWay 'common'):
// the most common way out each time, a task once, until the end is the most common way on (or nothing new is left). The product of the
// ways' shares is kept as `p` — the most probable whole path (−log p) is not used: it favours a short way (날인 → 회신) over the one most
// cases actually go. Two steps done side by side (parallel) count as one stretch in pathTime. → {path, p}
export function commonPath(edges, start, { keys = null, maxLen = 30 } = {}) {
  const K = keys || new Set(edges.flatMap((e) => [e.from, e.to]).filter((k) => k !== END))
  K.add(start)
  const outs = outsOf(edges, K)
  const path = [start], seen = new Set([start])
  let p = 1
  for (let x = start, i = 0; i < maxLen; i++) {
    const next = (outs.get(x) || []).filter((o) => o.to === END || !seen.has(o.to)).sort((a, b) => b.p - a.p || String(a.to).localeCompare(String(b.to)))[0]
    if (!next) break
    p *= next.p
    if (next.to === END) break
    path.push(next.to); seen.add(next.to); x = next.to
  }
  return { path, p: round(p, 4) }
}

// ---------- 할 일(WIP) · 처리량 ----------
// rows: the work items of map / snapshot cases [{task, status, start, end, caseId, agent, userId}] (times in ms) · now · days: the window
// for arrivals and throughput. → task → {wip, oldestH, ageH: [hours], arrived, done, perDay, workDays}
export function loadOf(rows, { now = Date.now(), days = 14 } = {}) {
  const from = now - days * DAY
  const workDays = workMs(from, now) / (WORK_H * HOUR) || 1
  const by = new Map()
  const get = (k) => { if (!by.has(k)) by.set(k, { wip: 0, ages: [], arrived: 0, done: 0, agentRows: 0, rows: 0, open: [] }); return by.get(k) }
  for (const r of rows) {
    const x = get(r.task)
    x.rows++
    if (r.agent) x.agentRows++
    if (OPEN.includes(r.status)) {
      x.wip++
      const age = Number.isFinite(r.start) ? workMs(r.start, now) / HOUR : 0
      x.ages.push(age)
      x.open.push({ ...r, ageH: age })
    }
    if (Number.isFinite(r.start) && r.start >= from) x.arrived++
    if (ENDED.includes(r.status) && Number.isFinite(r.end) && r.end >= from) x.done++
  }
  for (const x of by.values()) {
    x.oldestH = x.ages.length ? round(Math.max(...x.ages)) : 0
    x.perDay = round(x.done / workDays, 3) // handed on per working day
    x.inPerDay = round(x.arrived / workDays, 3)
    x.growing = x.arrived > x.done
    // 리틀의 법칙: 지금 쌓인 양을 지금 처리하는 빠르기로 치우는 데 드는 근무 시간
    x.clearH = x.wip ? (x.perDay > 0 ? round((x.wip / x.perDay) * WORK_H) : null) : 0
    x.open.sort((a, b) => b.ageH - a.ageH)
    delete x.ages
  }
  return { by, workDays: round(workDays, 1), from, now, days }
}

// a task's usual backlog from the records alone (no run yet): arrivals per working day × response time (리틀의 법칙 L = λW, 추정)
export function minedBacklog(mined, { from, to } = {}) {
  if (!mined.length) return null
  const a = from ?? Math.min(...mined.map((s) => s.from)), b = to ?? Math.max(...mined.map((s) => s.at))
  const wd = workMs(a, b) / (WORK_H * HOUR)
  if (!(wd > 0)) return null
  const lam = mined.length / wd, W = mean(mined.map((s) => s.workMs / HOUR)) / WORK_H
  return round(lam * W, 1)
}

// ---------- 병목 · 제약 · 흔한 길 ----------
// tasks: [{key, role, outside, agent, inProc}] · load: loadOf(...).by · times: task → taskTime(...)
// The bottleneck: among our people's steps (an outside role's step is waiting outside; an agent's step is not a person's capacity), the
// most work items open; ties by the oldest, then by the time to clear. No run yet → the records' usual backlog (추정).
export function bottleneckOf(tasks, load, times = new Map(), mined = new Map()) {
  const rows = tasks.map((t) => {
    const l = load.get(t.key) || { wip: 0, oldestH: 0, clearH: 0, perDay: 0, inPerDay: 0 }
    return { key: t.key, role: t.role, outside: !!t.outside, agent: !!t.agent, wip: l.wip || 0, oldestH: l.oldestH || 0, clearH: l.clearH ?? null,
      perDay: l.perDay || 0, inPerDay: l.inPerDay || 0, growing: !!l.growing, usual: mined.get(t.key) ?? null, time: times.get(t.key) || null }
  })
  const ours = rows.filter((r) => !r.outside && !r.agent)
  const byWip = [...ours].sort((a, b) => b.wip - a.wip || b.oldestH - a.oldestH || (b.clearH ?? 0) - (a.clearH ?? 0))
  if (byWip[0]?.wip > 0) return { key: byWip[0].key, by: 'wip', rows, second: byWip[1]?.wip > 0 ? byWip[1].key : null }
  const byUsual = [...ours].filter((r) => r.usual != null).sort((a, b) => b.usual - a.usual)
  if (byUsual[0]?.usual > 0) return { key: byUsual[0].key, by: 'mined', rows, second: byUsual[1]?.key || null }
  return { key: null, by: 'none', rows, second: null }
}

// The company's constraint: the open work items of every process gathered by role (a role carries its steps in every flow), per person.
// roles: [{key, members, outside}] · items: [{task, role, wip, proc, inPerDay, perDay}] → [{role, members, wip, perPerson, procs:{proc: wip}, tasks,
// growing}] sorted, with the constraint first (outside roles and agents left out).
export function constraintOf(roles, items) {
  const R = new Map()
  for (const r of roles) if (!r.outside && !r.agent) R.set(r.key, { role: r.key, members: Math.max(1, r.members || 0), wip: 0, inPerDay: 0, perDay: 0, procs: {}, tasks: {} })
  for (const it of items) {
    const x = R.get(it.role)
    if (!x) continue
    x.wip += it.wip || 0
    x.inPerDay += it.inPerDay || 0
    x.perDay += it.perDay || 0
    if (it.wip) { x.procs[it.proc] = (x.procs[it.proc] || 0) + it.wip; x.tasks[it.task] = (x.tasks[it.task] || 0) + it.wip }
  }
  const list = [...R.values()].map((x) => ({ ...x, perPerson: round(x.wip / x.members, 2), inPerDay: round(x.inPerDay, 2), perDay: round(x.perDay, 2), growing: x.inPerDay > x.perDay + 1e-9 }))
    .sort((a, b) => b.perPerson - a.perPerson || b.wip - a.wip)
  return { key: list[0]?.wip > 0 ? list[0].role : null, roles: list }
}

// The usual case's way and how long it takes (흔한 길 · 크리티컬 패스). A step's measured time (from when the work reached it to when it was
// handed on) already holds the waiting cases met there, so the clearing time is not added to it: it is the other estimate of the same
// time, from now (리틀의 법칙 — 쌓인 할 일 ÷ 하루 처리량). Where a real queue stands now (QUEUE or more open items), a case arriving now meets
// that instead when it is longer: nowH = max(pastH, clearH), extraH = what that adds. The step longest for a case arriving now sets the
// lead time — when that is the bottleneck, the bottleneck's queue is the critical chain. Steps side by side: the shorter does not add.
export const QUEUE = 2
export function pathTime(path, times = new Map(), load = new Map(), { parallel = [] } = {}) {
  const steps = path.map((k) => {
    const t = times.get(k), l = load.get(k)
    const pastH = t?.medH ?? null
    const queued = (l?.wip || 0) >= QUEUE
    const clearH = queued ? l.clearH : null
    const nowH = queued ? Math.max(pastH || 0, clearH ?? 0) : pastH || 0
    return { key: k, pastH, nowH: round(nowH), extraH: round(Math.max(0, nowH - (pastH || 0))), queued, wip: l?.wip || 0, clearH, stuck: queued && clearH == null, estimated: t ? t.estimated : true }
  })
  for (const [a, b] of parallel) {
    const sa = steps.find((s) => s.key === a), sb = steps.find((s) => s.key === b)
    if (sa && sb) (sa.nowH >= sb.nowH ? sb : sa).beside = true
  }
  const on = steps.filter((s) => !s.beside)
  const past = on.reduce((s, x) => s + (x.pastH || 0), 0)
  const now = on.reduce((s, x) => s + x.nowH, 0)
  const longest = [...on].sort((a, b) => b.nowH - a.nowH)[0]?.key || null
  return { steps, pastH: round(past, 1), nowH: round(now, 1), extraH: round(now - past, 1), longest }
}

// each step's share of a case's expected time: visits × time ÷ Σ (where a case's time goes)
export function timeShares(visits, times) {
  const parts = [...visits].map(([k, v]) => [k, v * (times.get(k)?.medH || 0)])
  const sum = parts.reduce((s, [, x]) => s + x, 0)
  return { leadH: round(sum, 1), shares: new Map(parts.map(([k, x]) => [k, sum ? round(x / sum, 3) : 0])) }
}

// what to do about the bottleneck, in the five focusing steps' order (찾기 → 최대 활용 → 종속 → 강화 → 반복), with the map's own means
export function suggestionsOf({ bott, task = {}, role = null, cand = null, cls = null, optional = false, onPath = false, constraint = null }) {
  if (!bott) return []
  const out = []
  out.push({ step: 'find', text: `「${bott.key}」에 할 일이 ${bott.wip}건 쌓였어요${bott.oldestH ? ` — 가장 오래 기다린 것은 근무 ${fmtH(bott.oldestH)}` : ''}.${onPath ? ' 보통 건이 지나는 길 위에 있어서 이 기다림이 리드타임이 돼요.' : ''}` })
  if (cand && ['high', 'mid'].includes(cand.fit)) out.push({ step: 'exploit', act: 'agent', text: `AI 후보예요(${cand.fit === 'high' ? 'AI가 맡을 수 있음' : 'AI가 초안 · 사람이 확인'}). 「${bott.key}」의 초안을 에이전트가 먼저 쓰면 사람 시간이 줄어요.` })
  else if (cls === 'ai') out.push({ step: 'exploit', act: 'agent', text: `단계 가르기에서 「AI가 맡음」으로 나눈 일이에요. 에이전트에 맡기면 이 역할의 짐이 줄어요.` })
  else if (!cand) out.push({ step: 'exploit', act: 'candidates', text: `아직 AI 후보를 보지 않은 일이에요. 「AI 후보」로 이 일을 AI가 도울 수 있는지 먼저 봐요.` })
  if (optional) out.push({ step: 'exploit', act: 'rule', text: `해도 되고 안 해도 되는 단계로 정해 두면(단계 규칙) 작은 건은 건너뛰어요.` })
  out.push({ step: 'subordinate', act: 'pace', text: `앞 단계는 「${bott.key}」가 처리하는 빠르기(근무일마다 ${bott.perDay || 0}건)에 맞춰 넘겨요. 더 빨리 넘겨도 이 앞에 쌓이기만 해요.` })
  if (role) out.push({ step: 'elevate', act: 'members', text: `「${role.role}」 역할은 ${role.members}명이 할 일 ${role.wip}건을 맡고 있어요(한 사람당 ${role.perPerson}건). 사람을 더하면 이 일의 처리량이 늘어요.` })
  if (constraint && role && constraint !== role.role) out.push({ step: 'elevate', text: `회사 전체로는 「${constraint}」 역할이 더 무거워요. 그 역할도 함께 보세요.` })
  out.push({ step: 'repeat', text: '고친 뒤 할 일이 줄면 병목은 다른 일로 옮겨 가요. 이 화면이 그때의 병목을 다시 보여 줘요.' })
  return out
}
export const STEP_KO = { find: '찾기', exploit: '최대 활용', subordinate: '맞추기', elevate: '늘리기', repeat: '다시 보기' }

// 근무 시간을 사람이 읽는 말로: 9시간 = 근무 하루
export function fmtH(h) {
  if (h == null || !Number.isFinite(h)) return '—'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}분`
  if (h < WORK_H) return `${Math.round(h * 10) / 10}시간`
  return `${Math.round((h / WORK_H) * 10) / 10}일`
}
