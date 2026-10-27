// 리드타임 분해 — process-gpt services/analytic/backend/app/leadtime.py 의 순수 함수를 그대로 옮긴 것
// (같은 이름·같은 규칙·같은 불변식) + Lite 확장 네 가지(아래 "확장" 표시).
//
// 원본이 말하는 것: 병목은 에이전트가 만든 결과물을 사람이 검토하는 구간에 있는데, 타임라인은 리드타임을
// 한 막대로만 보여 준다. 이 모듈은 이미 읽어 온 상태 전이 이력과 이벤트만 받아 겹치지 않는 구간으로
// 나눈다. 시간 소스는 todolist_status_history.changed_at 과 events.timestamp 만 믿는다 —
// todolist.end_date 는 naive 이고 규칙이 깨져 있으며, updated_at 은 이후 쓰기에 계속 덮인다.
//
// 확장 (process-gpt 엔진의 실제 기록 모양에 맞춘 것, design.md "계승 매핑"):
//  1. ready — 엔진은 인스턴스를 시작할 때 모든 단계의 작업 항목을 TODO 로 미리 만든다. 그래서 첫 이력
//     행(배정)은 '도달'이 아니라 '인스턴스 시작'이다. 호출자가 앞 단계가 끝난 시각(ready)을 주면 그때를
//     배정으로 본다(앞 단계를 기다린 시간이 이 단계의 큐 대기로 잡히지 않게).
//  2. humanStart — 엔진은 사람 단계에 도달하는 순간 IN_PROGRESS 로 바꾼다. 사람이 실제로 손댄 때는
//     Lite 가 담당자가 작업 항목을 처음 연 순간 남기는 events(human_checked)로 안다. 있으면 그것을 착수로.
//  3. review_wait — 원본이 선언만 하고 만들지 않던 구간. 에이전트 초안이 끝난 뒤 사람이 착수하기까지
//     (같은 단계 안의 에이전트 초안 뒤, 또는 앞 단계가 에이전트였던 사람 단계의 대기).
//  4. rework — 원본이 선언만 하던 구간. 같은 작업 항목의 두 번째 IN_PROGRESS 이후(rework_seq ≥ 1),
//     또는 호출자가 재실행(같은 인스턴스에서 같은 단계를 두 번째 이상)이라고 알려 준 작업 항목의 작업.

export const SESSION_BREAK_SECONDS = 3600

export const QUEUE_WAIT = 'queue_wait'   // 배정 → 착수. 아무도 손대지 않은 시간
export const HUMAN_WORK = 'human_work'   // 사람이 실제로 판단한 시간
export const AGENT_WORK = 'agent_work'   // 에이전트가 실제로 돈 시간
export const REVIEW_WAIT = 'review_wait' // 에이전트 초안 완료 → 사람 착수 (핵심 병목 가설)
export const REWORK = 'rework'           // 2회차 이상 세션
export const IDLE_GAP = 'idle_gap'       // 어디에도 귀속되지 않는 시간

export const ACTOR_HUMAN = 'human'
export const ACTOR_AGENT = 'agent'
export const ACTOR_NONE = 'none'

const ACTOR_BY_SEGMENT = { [QUEUE_WAIT]: ACTOR_NONE, [HUMAN_WORK]: ACTOR_HUMAN, [AGENT_WORK]: ACTOR_AGENT, [REVIEW_WAIT]: ACTOR_NONE, [IDLE_GAP]: ACTOR_NONE }
export const TERMINAL_STATUSES = new Set(['DONE', 'CANCELLED'])

// a timestamp as epoch ms (Date, ISO string or number)
export const ms = (t) => (t == null ? null : typeof t === 'number' ? t : new Date(t).getTime())
const secs = (a, b) => (b - a) / 1000

export const durationSec = (s) => Math.max(Math.floor((s.end - s.start) / 1000), 0)

/** 이벤트 타임스탬프를 실행 세션으로 가른다(간격이 breakSeconds 를 넘으면 새 세션). */
export function splitSessions(timestamps, breakSeconds = SESSION_BREAK_SECONDS) {
  const ordered = [...timestamps].map(ms).filter((t) => t != null).sort((a, b) => a - b)
  if (!ordered.length) return []
  const sessions = []
  let start = ordered[0], prev = ordered[0]
  for (const ts of ordered.slice(1)) {
    if (secs(prev, ts) > breakSeconds) { sessions.push([start, prev]); start = ts }
    prev = ts
  }
  sessions.push([start, prev])
  return sessions
}

// task_started/task_completed 쌍을 우선 쓰고, 짝이 맞지 않으면 전체 이벤트를 세션으로 갈라 폴백
function agentSessions(events) {
  const evs = events.filter((e) => e.event_type !== 'human_checked')
  const starts = evs.filter((e) => e.event_type === 'task_started').map((e) => ms(e.timestamp)).sort((a, b) => a - b)
  const ends = evs.filter((e) => e.event_type === 'task_completed').map((e) => ms(e.timestamp)).sort((a, b) => a - b)
  if (starts.length && starts.length === ends.length && starts.every((s, i) => ends[i] - s >= 0)) return starts.map((s, i) => [s, ends[i]])
  return splitSessions(evs.map((e) => e.timestamp))
}

function clip(windows, lo, hi) {
  const out = []
  for (const [s, e] of windows) {
    const s2 = Math.max(s, lo), e2 = Math.min(e, hi)
    if (e2 - s2 > 0) out.push([s2, e2])
  }
  return out
}

function subtract(lo, hi, busy) {
  const gaps = []
  let cursor = lo
  for (const [s, e] of [...busy].sort((a, b) => a[0] - b[0])) {
    if (s - cursor > 0) gaps.push([cursor, s])
    cursor = Math.max(cursor, e)
  }
  if (hi - cursor > 0) gaps.push([cursor, hi])
  return gaps
}

function mk(parts, todoId, activityId, estimated, isHuman) {
  return parts
    .filter(([, s, e]) => e - s > 0)
    .map(([kind, s, e]) => ({
      segment_type: kind, start: s, end: e,
      actor_kind: kind === REWORK ? (isHuman ? ACTOR_HUMAN : ACTOR_AGENT) : (ACTOR_BY_SEGMENT[kind] || ACTOR_NONE),
      rework_seq: kind === REWORK ? 1 : 0, is_estimated: estimated, todo_id: todoId, activity_id: activityId,
    }))
    .sort((a, b) => a.start - b.start)
}

/**
 * 태스크 1건을 겹치지 않는 구간들로 분해한다. 반환 구간의 합은 배정~완료를 빠짐없이 덮는다.
 * history: todolist_status_history 행(to_status, changed_at, rework_seq, is_estimated), events: event_type/timestamp.
 * 확장 옵션: ready(도달 시각), humanStart(사람 착수 시각), waitKind('review'|'queue'), reworkRun(재실행 작업 항목).
 */
export function decomposeTask({ todoId, activityId, isHuman, history, events = [], ready = null, humanStart = null, waitKind = 'queue', reworkRun = false }) {
  const hist = [...history].map((h) => ({ ...h, at: ms(h.changed_at) })).sort((a, b) => a.at - b.at)
  if (!hist.length) return []
  const estimated = hist.some((h) => h.is_estimated)

  let assigned = hist[0].at
  const r = ms(ready)
  if (r != null && r > assigned) assigned = r // 확장 1
  const inProgress = hist.filter((h) => h.to_status === 'IN_PROGRESS')
  let started = inProgress[0]?.at ?? null
  const finished = [...hist].reverse().find((h) => TERMINAL_STATUSES.has(h.to_status))?.at ?? null
  if (started != null && started < assigned) started = assigned
  const hs = ms(humanStart)
  if (isHuman && started != null && hs != null && hs > started && (finished == null || hs < finished)) started = hs // 확장 2

  if (started == null) return mk([[waitKind === 'review' ? REVIEW_WAIT : QUEUE_WAIT, assigned, finished ?? hist.at(-1).at]], todoId, activityId, estimated, isHuman)
  // 완료 근거가 없으면 작업 구간을 지어내지 않는다
  if (finished == null) return mk([[waitKind === 'review' ? REVIEW_WAIT : QUEUE_WAIT, assigned, started]], todoId, activityId, estimated, isHuman)

  const sessions = agentSessions(events)
  const parts = []
  // 대기 창 [assigned, started]: 그 안에서 돈 에이전트(초안)는 에이전트 작업, 초안이 끝난 뒤는 검토 대기 (확장 3)
  const pre = clip(sessions, assigned, started)
  const firstDraftEnd = pre.length ? Math.min(...pre.map(([, e]) => e)) : null
  for (const [s, e] of pre) parts.push([AGENT_WORK, s, e])
  for (const [s, e] of subtract(assigned, started, pre)) {
    const review = waitKind === 'review' || (isHuman && firstDraftEnd != null && s >= firstDraftEnd)
    parts.push([review ? REVIEW_WAIT : QUEUE_WAIT, s, e])
  }

  const busy = clip(sessions, started, finished)
  // 같은 작업 항목의 두 번째 세션(rework_seq ≥ 1) 이후는 재작업 (확장 4)
  const second = inProgress.find((h, i) => i > 0 && (h.rework_seq ?? i) >= 1 && h.at > started)?.at ?? null
  const workKind = (s) => (reworkRun || (second != null && s >= second) ? REWORK : null)
  const push = (kind, s, e) => {
    if (second != null && s < second && e > second) { push(kind, s, second); push(kind, second, e); return }
    parts.push([kind === IDLE_GAP ? kind : workKind(s) || kind, s, e])
  }
  for (const [s, e] of busy) push(AGENT_WORK, s, e)
  // 사람 태스크: 착수~완료에서 에이전트가 돈 구간을 뺀 나머지가 판단시간. 에이전트 태스크: 실행 사이 빈 시간은 대기
  for (const [s, e] of subtract(started, finished, busy)) push(isHuman ? HUMAN_WORK : IDLE_GAP, s, e)
  return mk(parts, todoId, activityId, estimated, isHuman)
}

// 한 순간에 여러 태스크가 동시에 진행될 때 그 순간을 무엇으로 셀지(앞일수록 우선)
export const PRECEDENCE = [HUMAN_WORK, AGENT_WORK, REWORK, REVIEW_WAIT, QUEUE_WAIT, IDLE_GAP]

/** 겹치는 구간을 합친다. */
export function mergeWindows(windows) {
  const ordered = [...windows].filter(([s, e]) => e - s > 0).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (!ordered.length) return []
  const merged = [[...ordered[0]]]
  for (const [s, e] of ordered.slice(1)) {
    const last = merged.at(-1)
    if (last[1] - s >= 0) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  return merged
}

/**
 * 태스크별 구간을 인스턴스 1건으로 합친다. totals 는 벽시계 기준(겹침 제거)이라 합이 정확히 리드타임,
 * effort 는 겹침을 그대로 둔 합(병렬 태스크가 있으면 리드타임보다 클 수 있음).
 * 불변식: sum(totals) == lead_time_sec.
 */
export function buildBreakdown(taskSegments, { instanceStart = null, instanceEnd = null } = {}) {
  const empty = { lead_time_sec: 0, totals: {}, effort: {}, segments: [], work_windows: [], has_estimated: false }
  if (!taskSegments.length) return empty
  const lo = ms(instanceStart) ?? Math.min(...taskSegments.map((s) => s.start))
  const hi = ms(instanceEnd) ?? Math.max(...taskSegments.map((s) => s.end))
  if (hi - lo <= 0) return empty
  const segs = [...taskSegments].sort((a, b) => a.start - b.start)
  const effort = {}
  for (const s of segs) effort[s.segment_type] = (effort[s.segment_type] || 0) + durationSec(s)
  const byKind = Object.fromEntries(PRECEDENCE.map((k) => [k, mergeWindows(segs.filter((s) => s.segment_type === k).map((s) => [s.start, s.end]))]))
  // 모든 경계점으로 벽시계를 쪼갠 뒤 각 조각을 우선순위가 가장 높은 종류에 통째로 배정
  const bounds = new Set([lo, hi])
  for (const ws of Object.values(byKind)) for (const [s, e] of ws) { if (lo < s && s < hi) bounds.add(s); if (lo < e && e < hi) bounds.add(e) }
  const marks = [...bounds].sort((a, b) => a - b)
  const totals = {}
  for (let i = 0; i + 1 < marks.length; i++) {
    const a = marks[i], b = marks[i + 1]
    const width = Math.floor((b - a) / 1000)
    if (width <= 0) continue
    let kind = IDLE_GAP
    for (const c of PRECEDENCE) if (byKind[c].some(([s, e]) => s <= a && b <= e)) { kind = c; break }
    totals[kind] = (totals[kind] || 0) + width
  }
  // 정수 절삭으로 남는 잔여분은 가장 큰 항목이 흡수
  const lead = Math.floor((hi - lo) / 1000)
  const drift = lead - Object.values(totals).reduce((x, y) => x + y, 0)
  const keys = Object.keys(totals)
  if (drift && keys.length) { const big = keys.reduce((m, k) => (totals[k] > totals[m] ? k : m), keys[0]); totals[big] += drift }
  const work = mergeWindows(segs.filter((s) => s.segment_type === HUMAN_WORK || s.segment_type === AGENT_WORK).map((s) => [s.start, s.end]))
  return { lead_time_sec: lead, totals, effort, segments: segs, work_windows: work, has_estimated: segs.some((s) => s.is_estimated) }
}

export const ratio = (b, kind) => (b.lead_time_sec ? (b.totals[kind] || 0) / b.lead_time_sec : 0)
