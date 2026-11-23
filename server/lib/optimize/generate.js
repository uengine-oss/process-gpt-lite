// Alternatives for a blocked rollout (plan.md §4 "대안"): the model proposes them from the request, the finding, the
// blocking policies and the objectives (structured fields only — kind, audience, items, delay, rollout, rationale);
// deterministic templates fill the kinds it left out, and stand in when there is no model or it fails. The model
// never decides whether an alternative is allowed: each one is turned into phases here and checked by the PDP.
//
// Kinds:
//   split           ship now only the items without an open finding; the rest once the finding is fixed
//   internal_first  everything to internal users (or a beta group) now; the public once the finding is fixed
//   delay_fix       fix the finding first, then ship everything
//   scope_limit     everything now to a share of the public (canary); the rest once the finding is fixed
import { chatJson } from '../llm.js'
import { L } from '../lang.js'

export const KINDS = ['split', 'internal_first', 'delay_fix', 'scope_limit']
export const KIND_LABEL = {
  split: ['비민감 기능만 분리 출시', 'Release only the non-sensitive features'],
  internal_first: ['내부 사용자 먼저 공개', 'Internal users first'],
  delay_fix: ['고친 뒤 출시', 'Fix first, release later'],
  scope_limit: ['공개 범위 제한 (카나리)', 'Limited rollout (canary)'],
}
const AUDIENCES = ['public', 'beta', 'internal']
const int = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d)

// the open findings on the planned items, and when the fixable ones are fixed (the latest estimate)
export function findingsOn(ctx, items = ctx.planned) {
  return ctx.findings.filter((f) => f.status !== 'fixed' && items.includes(f.feature))
}
const fixDayOf = (fs) => (fs.length && fs.every((f) => f.fix_days != null) ? Math.max(...fs.map((f) => f.fix_days)) : null)

// a later phase does not land on a weekend: Friday + 3 is Monday, Friday + 1 is Monday too
function workday(ctx, day) {
  let d = day
  while (d > 0 && [0, 6].includes((ctx.weekday + d) % 7)) d++
  return d
}

// an alternative's fields → its phases and the findings it plans to fix
export function phasesOf(alt, ctx) {
  const planned = ctx.planned
  const pick = (xs) => (Array.isArray(xs) && xs.length ? planned.filter((p) => xs.includes(p)) : null)
  const day0 = int(alt.delay_days, 0, 0, 30)
  const open = findingsOn(ctx)
  const fixable = open.filter((f) => f.fix_days != null)
  const fixes = fixable.map((f) => f.id)
  const fixDay = fixDayOf(open)
  const later = (from) => (fixDay == null ? null : workday(ctx, Math.max(fixDay, from + 1)))
  const phases = []
  if (alt.kind === 'split') {
    const now = pick(alt.features) || planned.filter((p) => !open.some((f) => f.feature === p))
    const audience = AUDIENCES.includes(alt.audience) ? alt.audience : 'public'
    if (now.length) phases.push({ day: day0, audience, rollout: 100, items: now })
    const rest = planned.filter((p) => !now.includes(p))
    const at = later(day0)
    if (rest.length && at != null) phases.push({ day: at, audience: 'public', rollout: 100, items: rest })
  } else if (alt.kind === 'internal_first') {
    const audience = ['internal', 'beta'].includes(alt.audience) ? alt.audience : 'internal'
    phases.push({ day: day0, audience, rollout: 100, items: pick(alt.features) || planned })
    const at = later(day0)
    if (at != null) phases.push({ day: at, audience: 'public', rollout: 100, items: planned })
  } else if (alt.kind === 'delay_fix') {
    const at = workday(ctx, Math.max(day0, fixDay ?? 0))
    phases.push({ day: at, audience: 'public', rollout: 100, items: planned })
  } else if (alt.kind === 'scope_limit') {
    const rollout = int(alt.rollout_percent, 10, 1, 99)
    phases.push({ day: day0, audience: 'public', rollout, items: pick(alt.features) || planned })
    const at = later(day0)
    if (at != null) phases.push({ day: at, audience: 'public', rollout: 100, items: planned })
  }
  return { phases, fixes }
}

// the template for a kind (used for the kinds the model left out, and without a model)
export function template(kind, ctx) {
  const open = findingsOn(ctx)
  const risky = [...new Set(open.map((f) => f.feature))]
  const safe = ctx.planned.filter((p) => !risky.includes(p))
  const fixDay = fixDayOf(open)
  const names = (xs) => xs.join(', ')
  const t = {
    split: { audience: 'public', features: safe,
      rationale: L(`위험이 열린 ${names(risky)}만 빼고 ${names(safe)}는 예정대로 공개하고, ${names(risky)}는 조치 후 공개합니다.`,
        `Ship ${names(safe)} as planned and hold ${names(risky)}, which has an open finding, until it is fixed.`) },
    internal_first: { audience: 'internal', features: ctx.planned,
      rationale: L('전 기능을 사내 사용자에게 먼저 열어 실제 사용 피드백을 받고, 조치가 끝나면 일반 공개합니다.',
        'Open everything to employees first for real feedback, and to the public once the finding is fixed.') },
    delay_fix: { audience: 'public', features: ctx.planned, delay_days: fixDay ?? 3,
      rationale: L(`발견된 문제를 먼저 고치고${fixDay != null ? ` (QA 추정 ${fixDay}일)` : ''} 전 기능을 한 번에 공개합니다.`,
        `Fix the finding first${fixDay != null ? ` (QA estimate: ${fixDay} days)` : ''}, then release everything at once.`) },
    scope_limit: { audience: 'public', features: ctx.planned, rollout_percent: 10,
      rationale: L('전 기능을 일반 사용자 10%에게만 먼저 내보내 영향 범위를 줄이고, 조치 후 100%로 넓힙니다.',
        'Roll everything out to 10% of the public first to limit the blast radius, then to everyone after the fix.') },
  }[kind]
  return { kind, label: L(...KIND_LABEL[kind]), delay_days: 0, rollout_percent: null, ...t, source: 'template' }
}

const SYSTEM = `너는 릴리스 계획 에이전트다. 정책(가드레일)에 막힌 출시 요청을 보고, 정책을 지키면서 전략 목표를 최대한 살리는
대안 실행 경로를 kind 마다 하나씩, 모두 4개 제안한다. 정책 위반 여부는 네가 정하지 않는다 — 각 대안은 정책 엔진이 따로 검사한다.
사실을 지어내지 말고 요청에 있는 기능 이름만 쓴다. 필드의 뜻은 kind 마다 정해져 있다:
- split: features = 지금 일반 공개(public)할 기능. 빠진 기능은 문제를 고친 뒤 공개된다.
- internal_first: audience = internal(사내) 또는 beta, features = 지금 그 대상에게 먼저 열 기능(보통 전부). 고친 뒤 전부 일반 공개된다.
- delay_fix: delay_days = 고치는 데 드는 날 이상. 그날 전부 일반 공개된다.
- scope_limit: rollout_percent = 일반 사용자 중 지금 받을 비율(1~99), features = 그 비율에게 지금 내보낼 기능. 고친 뒤 100%로 넓힌다.
JSON 으로만 답한다: {"alternatives":[{"kind":"split|internal_first|delay_fix|scope_limit","label":"짧은 이름(한국어, 16자 이내)",
"audience":"public|beta|internal","features":["기능 이름"],"delay_days":0,"rollout_percent":null,"rationale":"전략 목표에 비춘 근거 한두 문장(한국어)"}]}`

// the model's alternatives, normalised (unknown kinds and items dropped); [] when it fails
export async function fromModel(ctx, { timeoutMs = 30000 } = {}) {
  const user = JSON.stringify({
    request: { title: ctx.title, audience: ctx.audience, when: ctx.when, features: ctx.planned.map((n) => ({ name: n, pii: !!ctx.pii[n],
      serves: ctx.graph.links.filter((l) => l.source === `feature:${n}` && l.relation === 'contributes').map((l) => ({ objective: ctx.graph.objectives.find((o) => o.id === l.objective)?.name, weight: l.weight })) })) },
    findings: findingsOn(ctx).map((f) => ({ feature: f.feature, category: f.category, severity: f.severity, title: f.title, fix_days: f.fix_days })),
    security_scan: ctx.security_scan,
    blocked_by: ctx.blockedBy.map((m) => ({ id: m.id, decision: m.decision, title: m.title?.[0], explain: m.explain?.[0] })),
    objectives: ctx.graph.objectives.map((o) => ({ name: o.name, priority: o.priority, risk_appetite: o.risk_appetite, must: (o.constraints || []).filter((c) => c.level === 'must').map((c) => c.policy) })),
  })
  try {
    const r = await chatJson(SYSTEM, user, { temperature: 0, timeoutMs, maxTokens: 1600 })
    return (Array.isArray(r?.alternatives) ? r.alternatives : []).filter((a) => KINDS.includes(a?.kind)).slice(0, 5).map((a) => ({
      kind: a.kind,
      label: String(a.label || L(...KIND_LABEL[a.kind])).slice(0, 40),
      audience: AUDIENCES.includes(a.audience) ? a.audience : null,
      features: (Array.isArray(a.features) ? a.features : []).map(String).filter((n) => ctx.planned.includes(n)),
      delay_days: int(a.delay_days, 0, 0, 30),
      rollout_percent: a.rollout_percent == null ? null : int(a.rollout_percent, 10, 1, 99),
      rationale: String(a.rationale || '').slice(0, 300),
      source: 'model',
    }))
  } catch (e) {
    console.warn('[optimize] model alternatives:', e.message)
    return []
  }
}

// the alternatives to evaluate: the model's, then a template for every kind it left out; the same plan twice
// (same phases) is kept once. useModel false: the templates only (a reproducible demo).
export async function alternatives(ctx, { useModel = true } = {}) {
  const fromM = useModel ? await fromModel(ctx) : []
  const list = [...fromM]
  for (const k of KINDS) if (!list.some((a) => a.kind === k)) list.push(template(k, ctx))
  const seen = new Set()
  const out = []
  for (const a of list) {
    const p = phasesOf(a, ctx)
    const key = JSON.stringify(p.phases)
    if (!p.phases.length || seen.has(key)) continue
    seen.add(key)
    out.push({ ...a, ...p })
  }
  return out.map((a, i) => ({ id: `a${i + 1}`, ...a }))
}
