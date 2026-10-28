// 제약 이론 5단계(찾기 → 최대 활용 → 종속 → 강화 → 반복)를 이 프로세스의 기록으로 채운다.
// 단계마다 할 일과 그 근거 숫자, what-if 로 미리 계산한 효과를 붙인다(결정적 계산, 모델 호출 없음).
import { resources, constraintOf } from './toc.js'
import { whatIf } from './whatif.js'
import { upstreamActivities, ancestorActivities } from './graph.js'
import { fmtNum } from './transform.js'
import { percentile } from './analyze.js'
import { L, isEn } from '../lang.js'

const ROUND = [1e6, 2e6, 3e6, 5e6, 1e7, 2e7, 3e7, 4e7, 5e7, 6e7, 7e7, 8e7, 1e8, 1.5e8, 2e8, 3e8, 5e8]

/** share of the runs of `step` whose instance had field < threshold, and how often those needed 보완 */
export function skipShare(a, step, field, threshold) {
  const f = a.numeric.find((x) => x.field === field)
  if (!f) return { share: 0, n: 0 }
  const runs = new Map()
  for (const x of a.executions) if (x.activityId === step && x.done) runs.set(x.instId, (runs.get(x.instId) || 0) + 1)
  const inst = [...runs.keys()].filter((id) => f.byInstance[id] != null)
  const under = inst.filter((id) => f.byInstance[id] < threshold)
  const reworked = (ids) => ids.filter((id) => runs.get(id) > 1).length
  return {
    share: inst.length ? under.length / inst.length : 0, n: inst.length, under: under.length,
    reworkUnder: under.length ? reworked(under) / under.length : 0,
    reworkOver: inst.length - under.length ? reworked(inst.filter((id) => f.byInstance[id] >= threshold)) / (inst.length - under.length) : 0,
  }
}

// a round threshold that leaves about a third to a half of the runs under it, preferring where 보완 is rare
export function pickThreshold(a, step) {
  const ups = new Set([...ancestorActivities(a.g, step), step])
  // the number decided closest before the step (견적 금액 rather than the customer's 예산): what the reviewer checks
  const cands = a.numeric.filter((f) => ups.has(f.activityId))
  const near = Math.max(-1, ...cands.map((f) => a.g.rank.get(f.activityId) ?? 0))
  const fields = cands.filter((f) => (a.g.rank.get(f.activityId) ?? 0) === near)
  let best = null
  for (const f of fields) {
    const v = Object.values(f.byInstance)
    const lo = percentile(v, 0.2), hi = percentile(v, 0.65)
    for (const t of ROUND) {
      if (t < lo || t > hi) continue
      const s = skipShare(a, step, f.field, t)
      // about 40% under it, and few 보완 among those
      const score = Math.abs(s.share - 0.4) + s.reworkUnder
      if (!best || score < best.score) best = { field: f.field, activityId: f.activityId, threshold: t, ...s, score }
    }
  }
  return best
}

// 받침 있는 말 뒤엔 을/이/은/과, 없으면 를/가/는/와
export function josa(word, pair) {
  const ch = String(word || '').trim().slice(-1)
  const code = ch.charCodeAt(0) - 0xac00
  const has = code >= 0 && code <= 11171 ? code % 28 !== 0 : /[0-9LMNR]$/i.test(ch)
  const [a, b] = pair.split('/')
  return word + (has ? a : b)
}
const pct = (x) => `${Math.round((x || 0) * 100)}%`
export function dur(sec) {
  if (sec == null) return '-'
  const s = Math.abs(sec)
  if (isEn()) {
    if (s >= 86400) return `${(sec / 86400).toFixed(1)} days`
    if (s >= 3600) return `${(sec / 3600).toFixed(1)} h`
    if (s >= 60) return `${Math.round(sec / 60)} min`
    return `${Math.round(sec)} s`
  }
  if (s >= 86400) return `${(sec / 86400).toFixed(1)}일`
  if (s >= 3600) return `${(sec / 3600).toFixed(1)}시간`
  if (s >= 60) return `${Math.round(sec / 60)}분`
  return `${Math.round(sec)}초`
}

export function focusingSteps(a, { basis = 'median', labels = {}, agentFor } = {}) {
  const res = resources(a)
  const c = constraintOf(res)
  if (!c) return { resources: res, constraint: null, steps: [] }
  const stepId = c.stepIds.map((id) => [id, a.executions.filter((x) => x.activityId === id).length]).sort((p, q) => q[1] - p[1])[0][0]
  const st = a.steps.find((s) => s.id === stepId)
  const run = (changes, share) => {
    const r = whatIf(a, res, changes, { basis, share, agentFor })
    return { changes: r.changes, before: pick(r.before, c.key), after: pick(r.after, c.key), nextConstraint: r.after.constraint }
  }
  const out = []
  const trend = c.growing ? L(`이 단계 앞에서 기다리는 건이 최근 2주 평균 ${c.wipRecent.toFixed(1)}건으로 그 전(${c.wipBefore.toFixed(1)}건)보다 늘고 있어요`, `The items waiting in front of this step are growing: ${c.wipRecent.toFixed(1)} on average over the last 2 weeks, up from ${c.wipBefore.toFixed(1)} before`)
    : L(`이 단계 앞에서 평균 ${c.wip.toFixed(1)}건이 기다려요`, `On average ${c.wip.toFixed(1)} items wait in front of this step`)
  out.push({
    stage: 'identify', title: L('1. 찾기 — 제약은 어디인가', '1. Identify — where is the constraint?'),
    text: c.capacityBound
      ? L(`${st.name}(${c.name}) 단계가 제약이에요. 하루 ${c.lambdaPerDay.toFixed(1)}건이 들어오는데 처리할 수 있는 양은 하루 ${c.muPerDay.toFixed(1)}건(일이 쌓인 날 실제로 쓴 ${dur(c.busyPerDay)} ÷ 건당 ${dur(c.workPerItem)})이라 가동률이 ${pct(c.rho)}예요. ${trend}. 이 단계 앞 대기가 전체 리드타임의 ${pct(c.waitShare)}를 차지해요.`,
        `The ${st.name} step (${c.name}) is the constraint. ${c.lambdaPerDay.toFixed(1)} items arrive a day, but it can handle ${c.muPerDay.toFixed(1)} a day (the ${dur(c.busyPerDay)} actually spent on days with work waiting ÷ ${dur(c.workPerItem)} per item), so its utilization is ${pct(c.rho)}. ${trend}. Waiting in front of this step takes ${pct(c.waitShare)} of the whole lead time.`)
      : L(`처리 능력이 모자란 자원은 없지만, ${st.name}(${c.name}) 앞 대기가 전체 리드타임의 ${pct(c.waitShare)}로 가장 길어요. ${trend}.`,
        `No resource is short of capacity, but the wait in front of ${st.name} (${c.name}) is the longest, at ${pct(c.waitShare)} of the whole lead time. ${trend}.`),
    facts: { resource: c.name, step: st.name, lambdaPerDay: c.lambdaPerDay, muPerDay: c.muPerDay, rho: c.rho, wip: c.wip, wipRecent: c.wipRecent, wipBefore: c.wipBefore, waitShare: c.waitShare, waitMedian: c.waitMedian, workPerItem: c.workPerItem },
  })
  // 2. 최대 활용: the constraint's time only on what needs it
  const exploit = []
  if (st.kind === 'human') {
    const r = run([{ type: 'predraft', step: stepId, saving: 0.5 }])
    exploit.push({ title: L('에이전트가 먼저 검토 초안을 만들고 담당자는 확인만', 'An agent drafts the review first; the reviewer only checks'),
      text: L(`${c.name}님이 건당 ${dur(c.workPerItem)} 쓰는 확인 작업 중 절반을 에이전트 사전 초안(점검표·계산 확인)으로 넘기면 ${c.muPerDay ? `처리 능력이 하루 ${c.muPerDay.toFixed(1)}건 → ${(c.muPerDay * 2).toFixed(1)}건이 돼요` : '확인에 드는 시간이 절반으로 줄어요'}.`,
        `Handing half of the checking that takes ${c.name} ${dur(c.workPerItem)} per item to an agent pre-draft (checklist, calculation check) ${c.muPerDay ? `raises capacity from ${c.muPerDay.toFixed(1)} to ${(c.muPerDay * 2).toFixed(1)} a day` : 'halves the time the check takes'}.`), ...r })
  }
  const loop = a.g.edges.find((e) => a.g.back.has(e.id) && (e.target === stepId || upstreamActivities(a.g, e.source, { withLoops: false }).includes(stepId)))
  const loopP = loop ? Object.values(a.branches).flatMap((b) => b.edges).find((e) => e.id === loop.id)?.p || 0 : 0
  if (loop && loopP >= 0.05) {
    const again = a.executions.filter((x) => x.activityId === stepId && x.seq > 0 && x.done)
    const shareOfTime = again.reduce((s, x) => s + x.work + x.rework, 0) / Math.max(1, a.executions.filter((x) => x.activityId === stepId && x.done).reduce((s, x) => s + x.work + x.rework, 0))
    const r = run([{ type: 'rework', step: stepId, factor: 0.5 }])
    exploit.push({ title: L('보완 요청을 줄여 다시 검토하는 일을 없애기', 'Cut change requests so nothing is reviewed twice'),
      text: L(`${pct(loopP)}가 보완 요청으로 되돌아가 ${josa(st.name, '을/를')} 한 번 더 거쳐요(다시 검토가 ${c.name}님 시간의 ${pct(shareOfTime)}). 자주 나온 보완 사유를 앞 단계 점검표로 넣어 절반으로 줄이면:`,
        `${pct(loopP)} go back with a change request and pass through ${st.name} again (re-reviews take ${pct(shareOfTime)} of ${c.name}'s time). Putting the most frequent reasons into the earlier step's checklist to halve them gives:`), ...r })
  }
  out.push({ stage: 'exploit', title: L('2. 최대 활용 — 제약의 시간을 낭비하지 않기', "2. Exploit — don't waste the constraint's time"), actions: exploit })
  // 3. 종속: everything else follows the constraint's pace
  const limit = Math.max(2, Math.round((c.muPerDay || 1) * 1.5))
  // the rope: new work is released at the first person's step, at the constraint's pace
  const entry = ancestorActivities(a.g, stepId).map((id) => a.steps.find((s) => s.id === id)).filter((s) => s && s.kind === 'human' && (s.medianWork || 0) > 60)
  const ups = (entry.length ? entry : [a.steps.find((s) => s.id === upstreamActivities(a.g, stepId, { withLoops: false })[0])]).filter(Boolean).map((s) => s.name)
  out.push({
    stage: 'subordinate', title: L('3. 종속 — 나머지를 제약의 속도에 맞추기', '3. Subordinate — pace everything else to the constraint'),
    actions: [{
      title: L(`${st.name} 앞 대기 ${limit}건 상한(WIP 제한)`, `At most ${limit} waiting in front of ${st.name} (WIP limit)`),
      text: L(`${st.name} 앞에 ${limit}건(처리 능력 약 1.5일 치)이 쌓여 있으면 새 요청의 ${ups.join(', ')}은(는) 급한 건부터 순서를 정해 시작해요(로프). 앞에서 서둘러도 ${st.name} 앞에서 기다릴 뿐이라 리드타임은 줄지 않고, 기다리는 사이 요청이 바뀌어 다시 만드는 일만 늘어요. 지금은 평균 ${c.wip.toFixed(1)}건, 최근 2주 ${c.wipRecent.toFixed(1)}건이 기다려요.`,
        `When ${limit} items (about 1.5 days of capacity) are already waiting in front of ${st.name}, new requests start ${ups.join(', ')} in order of urgency (the rope). Hurrying the earlier steps only makes work wait in front of ${st.name}: the lead time does not drop, and requests change while they wait, so more gets redone. Right now ${c.wip.toFixed(1)} wait on average, ${c.wipRecent.toFixed(1)} over the last 2 weeks.`),
      changes: [], wipLimit: limit,
    }],
  })
  // 4. 강화: more capacity or less demand at the constraint
  const elevate = []
  const th = st.kind === 'human' ? pickThreshold(a, stepId) : null
  if (th) {
    const label = labels[th.field] || th.field
    const r = run([{ type: 'skip', step: stepId, field: th.field, label, threshold: th.threshold }], { [stepId]: th.share })
    elevate.push({ title: L(`${label} ${fmtNum(th.threshold)} 미만은 ${st.name} 없이 진행`, `${label} under ${fmtNum(th.threshold)} goes ahead without ${st.name}`),
      text: L(`지난 ${th.n}건 중 ${pct(th.share)}가 ${fmtNum(th.threshold)} 미만이었고, 그중 보완 요청은 ${pct(th.reworkUnder)}뿐이었어요(이상인 건은 ${pct(th.reworkOver)}). 기준 미만을 건너뛰면 ${c.name}님에게 오는 일이 그만큼 줄어요.`,
        `Of the last ${th.n}, ${pct(th.share)} were under ${fmtNum(th.threshold)}, and only ${pct(th.reworkUnder)} of those got a change request (${pct(th.reworkOver)} of the rest). Skipping the ones under the threshold takes that much work off ${c.name}.`), threshold: th, ...r })
  }
  {
    const r = run([{ type: 'capacity', step: stepId, add: 1 }])
    elevate.push({ title: L(`${st.name} 담당 1명 추가`, `One more person on ${st.name}`), text: L(`같은 일을 할 수 있는 사람을 한 명 더 배정하면(설정 → 팀·역할) 처리 능력이 두 배가 돼요.`, 'Assigning one more person who can do the same work (Settings › Team & roles) doubles the capacity.'), ...r })
  }
  out.push({ stage: 'elevate', title: L('4. 강화 — 제약의 능력을 늘리거나 일을 덜어 주기', '4. Elevate — add capacity at the constraint or take work off it'), actions: elevate })
  // 5. 반복: after the best of these, where does the constraint go?
  const all = [...exploit, ...elevate].filter((x) => x.after)
  const best = all.sort((p, q) => p.after.leadSec - q.after.leadSec)[0]
  const nx = best?.nextConstraint
  out.push({
    stage: 'repeat', title: L('5. 반복 — 제약이 옮겨 가면 다시 1단계로', '5. Repeat — when the constraint moves, start again at step 1'),
    text: best && nx && nx.key === c.key ? L(`가장 효과가 큰 '${best.title}'(으)로 바꾸면 리드타임이 ${dur(best.before.leadSec)} → ${dur(best.after.leadSec)}이 되지만, 제약은 여전히 ${c.name}님(가동률 ${pct(nx.rho)})이에요. 2~4단계의 방법을 함께 써 보고, 바꾼 뒤 새 인스턴스가 쌓이면 다시 찾기부터 해요.`,
      `The most effective change, '${best.title}', takes the lead time from ${dur(best.before.leadSec)} to ${dur(best.after.leadSec)}, but the constraint is still ${c.name} (utilization ${pct(nx.rho)}). Try the methods of steps 2–4 together, and once new instances pile up after the change, start again from Identify.`)
      : best ? L(`가장 효과가 큰 '${best.title}'(으)로 바꾸면 리드타임이 ${dur(best.before.leadSec)} → ${dur(best.after.leadSec)}이 되고, ${nx && nx.rho >= 0.5 ? `다음 제약 후보는 ${nx.name}(가동률 ${pct(nx.rho)})이에요` : '처리 능력이 모자란 사람은 더 없어요'}. 바꾼 뒤 새 인스턴스가 쌓이면 이 화면에서 다시 찾기부터 해요.`,
        `The most effective change, '${best.title}', takes the lead time from ${dur(best.before.leadSec)} to ${dur(best.after.leadSec)}, and ${nx && nx.rho >= 0.5 ? `the next constraint candidate is ${nx.name} (utilization ${pct(nx.rho)})` : 'no one else is short of capacity'}. Once new instances pile up after the change, start again from Identify on this screen.`) : '',
    best: best ? { title: best.title, changes: best.changes } : null, next: nx || null,
  })
  return { resources: res, constraint: c, step: stepId, steps: out }
}

const pick = (e, key) => ({ leadSec: e.leadSec, workSec: e.workSec, flowEfficiency: e.flowEfficiency, path: e.path, rho: e.util.find((u) => u.key === key)?.rho ?? null })
