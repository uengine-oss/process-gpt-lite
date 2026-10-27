// 리드타임 분해 — process-gpt services/analytic/backend/tests/test_leadtime.py 를 그대로 옮긴 시험 +
// Lite 확장(도달 시각·사람 착수·검토 대기·재작업) 시험. 원본의 핵심 회귀 지표: 사람 태스크가 0초로 찍히지 않는가.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_WORK, HUMAN_WORK, IDLE_GAP, QUEUE_WAIT, REVIEW_WAIT, REWORK, ACTOR_HUMAN,
  buildBreakdown, decomposeTask, mergeWindows, splitSessions, ratio, durationSec,
} from '../lib/improve/leadtime.js'

const T0 = Date.UTC(2026, 8, 1, 0, 0, 0)
const at = ({ days = 0, hours = 0, minutes = 0, seconds = 0 } = {}) => T0 + (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
const hist = (rows) => { let prev = null; return rows.map(([to, when]) => { const r = { from_status: prev, to_status: to, changed_at: when, rework_seq: 0, is_estimated: false }; prev = to; return r }) }
const evt = (event_type, timestamp) => ({ event_type, timestamp })
const sum = (segs, k) => segs.filter((s) => s.segment_type === k).reduce((x, s) => x + durationSec(s), 0)

// ---------- 원본 시험 ----------
test('split_sessions separates reruns', () => {
  const s = splitSessions([at(), at({ seconds: 10 }), at({ seconds: 20 }), at({ days: 4 }), at({ days: 4, seconds: 5 })])
  assert.equal(s.length, 2)
  assert.deepEqual(s[0], [at(), at({ seconds: 20 })])
  assert.deepEqual(s[1], [at({ days: 4 }), at({ days: 4, seconds: 5 })])
})
test('split_sessions keeps contiguous run whole', () => assert.equal(splitSessions([0, 1, 2, 3, 4].map((i) => at({ seconds: i * 30 }))).length, 1))
test('split_sessions empty', () => assert.deepEqual(splitSessions([]), []))

test('human task work time is not zero', () => {
  const segs = decomposeTask({ todoId: 't1', activityId: 'review', isHuman: true, history: hist([['TODO', at()], ['IN_PROGRESS', at({ hours: 3 })], ['DONE', at({ hours: 3, minutes: 25 })]]), events: [] })
  const human = segs.filter((s) => s.segment_type === HUMAN_WORK)
  assert.ok(human.length, '사람 판단시간 구간이 없다 — 계측 이전 상태로 회귀')
  assert.equal(sum(segs, HUMAN_WORK), 25 * 60)
  assert.equal(human[0].actor_kind, ACTOR_HUMAN)
})
test('human queue wait separated from work', () => {
  const segs = decomposeTask({ todoId: 't1', activityId: 'review', isHuman: true, history: hist([['TODO', at()], ['IN_PROGRESS', at({ hours: 3 })], ['DONE', at({ hours: 3, minutes: 25 })]]) })
  assert.equal(sum(segs, QUEUE_WAIT), 3 * 3600)
  assert.equal(sum(segs, HUMAN_WORK), 25 * 60)
})
test('agent work inside human task is attributed to agent', () => {
  const segs = decomposeTask({ todoId: 't1', activityId: 'review', isHuman: true, history: hist([['TODO', at()], ['IN_PROGRESS', at({ minutes: 10 })], ['DONE', at({ minutes: 40 })]]),
    events: [evt('task_started', at({ minutes: 10 })), evt('task_completed', at({ minutes: 20 }))] })
  assert.equal(sum(segs, AGENT_WORK), 10 * 60)
  assert.equal(sum(segs, HUMAN_WORK), 20 * 60)
})
test('agent task uses event pairs', () => {
  const segs = decomposeTask({ todoId: 't2', activityId: 'draft', isHuman: false, history: hist([['TODO', at()], ['IN_PROGRESS', at({ minutes: 1 })], ['DONE', at({ minutes: 5 })]]),
    events: [evt('task_started', at({ minutes: 1 })), evt('task_completed', at({ minutes: 2 }))] })
  assert.equal(sum(segs, AGENT_WORK), 60)
  assert.equal(sum(segs, IDLE_GAP), 3 * 60)
  assert.ok(!segs.some((s) => s.segment_type === HUMAN_WORK))
})
test('no completion evidence means no work segment', () => {
  const segs = decomposeTask({ todoId: 't3', activityId: 'a', isHuman: true, history: hist([['TODO', at()], ['IN_PROGRESS', at({ hours: 1 })]]) })
  assert.deepEqual(segs.map((s) => s.segment_type), [QUEUE_WAIT])
})
test('not started is all queue wait', () => {
  const segs = decomposeTask({ todoId: 't4', activityId: 'a', isHuman: true, history: hist([['TODO', at()]]) })
  assert.ok(segs.every((s) => s.segment_type === QUEUE_WAIT))
})
test('estimated flag propagates', () => {
  const h = hist([['TODO', at()], ['IN_PROGRESS', at({ hours: 1 })], ['DONE', at({ hours: 2 })]]).map((r) => ({ ...r, is_estimated: true }))
  const segs = decomposeTask({ todoId: 't5', activityId: 'a', isHuman: true, history: h })
  assert.ok(segs.length && segs.every((s) => s.is_estimated))
})
test('breakdown sums to lead time', () => {
  const segs = [
    ...decomposeTask({ todoId: 't1', activityId: 'a1', isHuman: false, history: hist([['TODO', at()], ['IN_PROGRESS', at({ minutes: 1 })], ['DONE', at({ minutes: 6 })]]), events: [evt('task_started', at({ minutes: 1 })), evt('task_completed', at({ minutes: 4 }))] }),
    ...decomposeTask({ todoId: 't2', activityId: 'a2', isHuman: true, history: hist([['TODO', at({ hours: 2 })], ['IN_PROGRESS', at({ hours: 3 })], ['DONE', at({ hours: 3, minutes: 30 })]]) }),
  ]
  const b = buildBreakdown(segs)
  assert.equal(Object.values(b.totals).reduce((x, y) => x + y, 0), b.lead_time_sec, '시간이 사라졌다')
  assert.equal(b.lead_time_sec, 3.5 * 3600)
})
test('gap between tasks becomes idle not lost', () => {
  const segs = [
    ...decomposeTask({ todoId: 't1', activityId: 'a1', isHuman: false, history: hist([['TODO', at()], ['IN_PROGRESS', at()], ['DONE', at({ minutes: 1 })]]), events: [evt('task_started', at()), evt('task_completed', at({ minutes: 1 }))] }),
    ...decomposeTask({ todoId: 't2', activityId: 'a2', isHuman: false, history: hist([['TODO', at({ days: 2 })], ['IN_PROGRESS', at({ days: 2 })], ['DONE', at({ days: 2, minutes: 1 })]]), events: [evt('task_started', at({ days: 2 })), evt('task_completed', at({ days: 2, minutes: 1 }))] }),
  ]
  const b = buildBreakdown(segs)
  assert.ok((b.totals[IDLE_GAP] || 0) > 0)
  assert.equal(Object.values(b.totals).reduce((x, y) => x + y, 0), b.lead_time_sec)
})
test('segments do not overlap', () => {
  const segs = decomposeTask({ todoId: 't1', activityId: 'a', isHuman: true, history: hist([['TODO', at()], ['IN_PROGRESS', at({ minutes: 5 })], ['DONE', at({ minutes: 45 })]]), events: [evt('task_started', at({ minutes: 10 })), evt('task_completed', at({ minutes: 20 }))] })
  const o = buildBreakdown(segs).segments
  for (let i = 0; i + 1 < o.length; i++) assert.ok(o[i].end <= o[i + 1].start, `${o[i].segment_type} 와 ${o[i + 1].segment_type} 겹침`)
})
test('merge windows collapses overlaps', () => {
  assert.deepEqual(mergeWindows([[at(), at({ minutes: 10 })], [at({ minutes: 5 }), at({ minutes: 20 })], [at({ hours: 1 }), at({ hours: 1, minutes: 5 })]]),
    [[at(), at({ minutes: 20 })], [at({ hours: 1 }), at({ hours: 1, minutes: 5 })]])
})
test('work windows exclude waiting', () => {
  const b = buildBreakdown(decomposeTask({ todoId: 't1', activityId: 'a', isHuman: true, history: hist([['TODO', at()], ['IN_PROGRESS', at({ hours: 5 })], ['DONE', at({ hours: 5, minutes: 10 })]]) }))
  assert.deepEqual(b.work_windows, [[at({ hours: 5 }), at({ hours: 5, minutes: 10 })]])
  assert.ok(ratio(b, QUEUE_WAIT) > 0.9)
})
test('parallel tasks do not double count', () => {
  const segs = ['t1', 't2', 't3'].flatMap((id) => decomposeTask({ todoId: id, activityId: id, isHuman: false, history: hist([['TODO', at()], ['IN_PROGRESS', at()], ['DONE', at({ minutes: 10 })]]), events: [evt('task_started', at()), evt('task_completed', at({ minutes: 10 }))] }))
  const b = buildBreakdown(segs)
  assert.equal(b.lead_time_sec, 600)
  assert.equal(Object.values(b.totals).reduce((x, y) => x + y, 0), 600, '겹침을 중복으로 셌다')
  assert.equal(b.effort[AGENT_WORK], 1800)
})
test('human wins precedence over concurrent agent', () => {
  const segs = [
    ...decomposeTask({ todoId: 'h', activityId: 'a', isHuman: true, history: hist([['TODO', at()], ['IN_PROGRESS', at()], ['DONE', at({ minutes: 10 })]]) }),
    ...decomposeTask({ todoId: 'a', activityId: 'b', isHuman: false, history: hist([['TODO', at()], ['IN_PROGRESS', at()], ['DONE', at({ minutes: 10 })]]), events: [evt('task_started', at()), evt('task_completed', at({ minutes: 10 }))] }),
  ]
  const b = buildBreakdown(segs)
  assert.equal(b.totals[HUMAN_WORK], 600)
  assert.equal(b.totals[AGENT_WORK] || 0, 0)
})

// ---------- Lite 확장 ----------
test('ext: ready replaces the pre-created TODO time (waiting for earlier steps is not this step’s queue)', () => {
  // 엔진은 인스턴스 시작 때 TODO 를 만든다; 앞 단계는 5시간 뒤에 끝났다
  const segs = decomposeTask({ todoId: 't', activityId: 'b', isHuman: true, history: hist([['TODO', at()], ['IN_PROGRESS', at({ hours: 6 })], ['DONE', at({ hours: 6, minutes: 30 })]]), ready: at({ hours: 5 }) })
  assert.equal(sum(segs, QUEUE_WAIT), 3600)
  assert.equal(sum(segs, HUMAN_WORK), 1800)
})
test('ext: the engine sets IN_PROGRESS on reach; the first human_checked (opened) is when the person started', () => {
  const segs = decomposeTask({ todoId: 't', activityId: 'review', isHuman: true, waitKind: 'review',
    history: hist([['TODO', at()], ['IN_PROGRESS', at({ hours: 1 })], ['SUBMITTED', at({ hours: 30 })], ['DONE', at({ hours: 30, seconds: 4 })]]),
    ready: at({ hours: 1 }), humanStart: at({ hours: 29 }) })
  assert.equal(sum(segs, REVIEW_WAIT), 28 * 3600, '에이전트 산출물을 기다린 시간은 검토 대기')
  assert.equal(sum(segs, HUMAN_WORK), 3600 + 4)
})
test('ext: inside one human step, time after the agent draft finished is review wait', () => {
  const segs = decomposeTask({ todoId: 't', activityId: 'review', isHuman: true,
    history: hist([['TODO', at()], ['IN_PROGRESS', at()], ['DONE', at({ hours: 5 })]]),
    events: [evt('task_started', at({ minutes: 1 })), evt('task_completed', at({ minutes: 11 })), evt('human_checked', at({ hours: 4 }))],
    humanStart: at({ hours: 4 }) })
  assert.equal(sum(segs, QUEUE_WAIT), 60)
  assert.equal(sum(segs, AGENT_WORK), 600)
  assert.equal(sum(segs, REVIEW_WAIT), 4 * 3600 - 11 * 60)
  assert.equal(sum(segs, HUMAN_WORK), 3600)
})
test('ext: a second IN_PROGRESS session of the same work item is rework', () => {
  const h = [
    { to_status: 'TODO', changed_at: at(), rework_seq: 0 },
    { to_status: 'IN_PROGRESS', changed_at: at({ hours: 1 }), rework_seq: 0 },
    { to_status: 'SUBMITTED', changed_at: at({ hours: 2 }), rework_seq: 0 },
    { to_status: 'IN_PROGRESS', changed_at: at({ hours: 5 }), rework_seq: 1 },
    { to_status: 'DONE', changed_at: at({ hours: 5, minutes: 30 }), rework_seq: 1 },
  ]
  const segs = decomposeTask({ todoId: 't', activityId: 'a', isHuman: true, history: h })
  assert.equal(sum(segs, REWORK), 1800)
  assert.equal(sum(segs, HUMAN_WORK), 4 * 3600)
  const b = buildBreakdown(segs)
  assert.equal(Object.values(b.totals).reduce((x, y) => x + y, 0), b.lead_time_sec)
})
test('ext: a re-run of the step in the same instance counts its work as rework, waits stay waits', () => {
  const segs = decomposeTask({ todoId: 't', activityId: 'p', isHuman: false, reworkRun: true,
    history: hist([['TODO', at()], ['IN_PROGRESS', at({ minutes: 1 })], ['DONE', at({ minutes: 9 })]]),
    events: [evt('task_started', at({ minutes: 2 })), evt('task_completed', at({ minutes: 8 }))] })
  assert.equal(sum(segs, REWORK), 360)
  assert.equal(sum(segs, AGENT_WORK), 0)
  assert.equal(sum(segs, QUEUE_WAIT), 60)
})
