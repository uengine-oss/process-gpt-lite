// The guardrail-aware path optimizer (plan.md §1 ③, P3). When the policies block an action, it does not stop there:
//   1. alternatives — the model proposes ways round the block, templates fill the gaps (lib/optimize/generate.js)
//   2. policy check — every phase of every alternative goes through the PDP as a dry run (ledger rows with
//      ref 'optimization:<id>'); a phase a policy denies excludes the alternative, with the policy as the reason
//   3. simulation — days, value delivered per objective, residual risk (lib/optimize/simulate.js)
//   4. strategic score — objective weights from the strategy graph, risk scaled by risk appetite (lib/optimize/score.js)
//   5. decision — the best alternative runs on its own when the policies allow it (allow / allow_audit), it runs now,
//      and it leads the next one by WEIGHTS.autoMargin; otherwise the accountable role chooses on an 'optimize' card.
//      If every alternative is denied, the denying policies' exception role is asked when someone holds it
//      (escalated), else the optimizer stops (stopped).
// Running an alternative is guard() (lib/policy/pep.js) with the alternative's facts: the real decision, not the dry
// run, decides — if it now needs approval and the person choosing is that approver, their choice is the approval.
// Everything lands in pro_optimizations (trigger, alternatives with policy/sim/score, chosen, status, explain).
//
// A scenario plugs in with registerScenario(actionKind, adapter):
//   { executor, accountableRole, context(trigger) → ctx {title, audience, when, planned[], pii{}, findings[], weekday, …},
//     factsOf(phase, ctx, fixes), subjectOf(phase, ctx), sourceOf(item), payloadOf(phase, ctx, opt, alt),
//     recordLater(phase, ctx, opt, alt, userId) — a phase that does not run now (planned / scheduled) }
import { q } from '../supa.js'
import { config } from '../../config.js'
import { decide, evaluate } from '../policy/pdp.js'
import { guard, answer, approversOf, canApprove } from '../policy/pep.js'
import { graphOf } from '../strategy/graph.js'
import { roleMap, roleKey } from '../team.js'
import { addMessage, updateMessage, mainThread } from '../store.js'
import { notifyUser } from '../notify.js'
import { L } from '../lang.js'
import { alternatives as generate, phasesOf, KIND_LABEL } from './generate.js'
import { simulate } from './simulate.js'
import { score, breaksOf, why, WEIGHTS } from './score.js'

const T = () => config.tenantId
const scenarios = new Map()
export function registerScenario(actionKind, adapter) { scenarios.set(actionKind, adapter) }
const adapterOf = (trigger) => {
  const a = scenarios.get(trigger?.action?.kind)
  if (!a) throw Object.assign(new Error(`no optimizer scenario for ${trigger?.action?.kind}`), { status: 400 })
  return a
}
const fail = (status, ko, en) => Object.assign(new Error(L(ko, en)), { status })
const compact = (m) => ({ id: m.id, decision: m.decision, title: m.title, category: m.category, approver: m.approver })
const nameOf = async (id) => (id ? (await q('select username from users where id=$1 and tenant_id=$2', [id, T()]))[0]?.username || null : null)

// check, simulate and score a set of alternatives against the current graph. dry: 'ledger' (decide with dryRun,
// rows referencing the optimization) or 'none' (evaluate, nothing written — a preview)
async function assess(alts, { ctx, adapter, graph, userId, optId, dry }) {
  const out = []
  for (const a of alts) {
    const phases = []
    for (const p of a.phases) {
      const action = { kind: ctx.kind, subject: `${adapter.subjectOf(p, ctx)} · ${L('대안', 'alternative')} ${a.id}`, facts: adapter.factsOf(p, ctx, a.fixes) }
      const r = dry === 'ledger'
        ? await decide({ userId, action, dryRun: true, ref: `optimization:${optId}` })
        : await evaluate({ userId, action })
      phases.push({ ...p, facts: action.facts, policy: { decision: r.decision, approver: r.approver, decisionId: r.id || null, matched: r.matched.map(compact) } })
    }
    const matched = phases.flatMap((p) => p.policy.matched)
    const denied = [...new Map(matched.filter((m) => m.decision === 'deny').map((m) => [m.id, m])).values()]
    const breaks = breaksOf(graph, matched)
    const sim = simulate(a, { planned: ctx.planned, findings: ctx.findings, graph, sourceOf: adapter.sourceOf })
    const excluded = denied.length > 0
    const s = excluded ? null : score(graph, sim, breaks)
    const must = new Set(breaks.filter((b) => b.level === 'must').map((b) => b.policy))
    const reason = excluded ? denied.map((m) => L(`${must.has(m.id) ? '필수 제약 위반' : '정책 차단'} — ${m.title?.[0] || m.id}`, `${must.has(m.id) ? 'breaks a must constraint' : 'denied'} — ${m.title?.[1] || m.id}`)).join('; ') : null
    const first = phases[0]
    out.push({
      ...a, phases,
      policy: { decision: first.policy.decision, approver: first.policy.approver, decisionId: first.policy.decisionId, matched: first.policy.matched },
      breaks, denied: denied.map(compact), excluded, reason,
      sim, score: s, potential: excluded ? score(graph, sim, []) : null,
      why: s ? why(s) : null,
    })
  }
  const ranked = out.filter((a) => !a.excluded).sort((x, y) => y.score.total - x.score.total)
  ranked.forEach((a, i) => { a.rank = i + 1 })
  out.filter((a) => a.excluded).forEach((a) => { a.rank = null })
  return out.sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99))
}

// what the alternatives' kinds and fields are, without the evaluation (a re-run checks them again)
const fieldsOf = (a) => ({ id: a.id, kind: a.kind, label: a.label, audience: a.audience ?? null, features: a.features ?? null, delay_days: a.delay_days ?? 0, rollout_percent: a.rollout_percent ?? null, rationale: a.rationale || '', source: a.source || 'template' })

// the decision over assessed alternatives: {mode: 'auto'|'ask'|'exception', best, margin, roles?, holders?}
async function choosePath(alts, { unheldRoles = [], ask = false } = {}) {
  const ok = alts.filter((a) => !a.excluded)
  if (!ok.length) {
    // every alternative is denied: which ones could run with an exception, and who holds that authority
    const map = await roleMap('*')
    const holderOf = (role) => (unheldRoles.includes(role) ? null : map[roleKey(role)] || null)
    const cands = alts.map((a) => {
      const roles = [...new Set(a.denied.map((m) => m.approver).filter(Boolean))]
      const holders = roles.map((r) => ({ role: r, userId: holderOf(r) }))
      const possible = a.denied.every((m) => m.approver) && holders.every((h) => h.userId)
      return { a, roles, holders, possible }
    }).sort((x, y) => (y.a.potential?.total ?? -9) - (x.a.potential?.total ?? -9))
    const best = cands.find((c) => c.possible)
    return best ? { mode: 'escalate', best: best.a, holders: best.holders } : { mode: 'stop', best: cands[0]?.a || null, holders: cands[0]?.holders || [] }
  }
  const [best, next] = ok
  const margin = next ? best.score.total - next.score.total : Infinity
  const runsNow = best.phases[0]?.day === 0
  const allowed = ['allow', 'allow_audit'].includes(best.policy.decision)
  return { mode: !ask && allowed && runsNow && margin >= WEIGHTS.autoMargin ? 'auto' : 'ask', best, margin }
}

function explainOf(path, adapter, names = {}) {
  const b = path.best
  const m = Number.isFinite(path.margin) ? path.margin.toFixed(2) : '∞'
  // labels come from the model: "「…」 대안" keeps the Korean particles right whatever the label ends with
  if (path.mode === 'auto') {
    const d = b.policy.decision === 'allow_audit' ? L('기록·감사를 남기고 허용해', 'allow it with an audit record') : L('허용해', 'allow it')
    return L(`「${b.label}」 대안이 전략 점수 ${b.score.total}로 2위보다 ${m} 앞서고 정책이 ${d} 바로 실행했어요.`,
      `"${b.label}" scores ${b.score.total}, ${m} ahead of the next, and the policies ${d}: it ran on its own.`)
  }
  if (path.mode === 'ask') {
    const why = b.policy.decision === 'require_approval' ? L(`정책상 ${b.policy.approver || '승인자'} 승인이 필요해서`, `the policies need the ${b.policy.approver || 'approver'}'s approval`)
      : b.phases[0]?.day > 0 ? L('지금 실행하는 대안이 아니어서', 'it does not run now')
        : L(`2위와 차이가 ${m}로 자동 실행 기준(${WEIGHTS.autoMargin})보다 작아서`, `it leads the next by only ${m} (auto-run needs ${WEIGHTS.autoMargin})`)
    // the approval the policies want is the accountable person's own: choosing is approving
    const same = b.policy.decision === 'require_approval' && b.policy.approver === adapter.accountableRole
    return same
      ? L(`1위는 「${b.label}」 대안(전략 점수 ${b.score.total})이에요. 정책상 ${b.policy.approver} 승인이 필요해서, 승인을 겸해 ${adapter.accountableRole}에게 고르도록 했어요.`,
        `The best is "${b.label}" (score ${b.score.total}). It needs the ${b.policy.approver}'s approval, so the ${adapter.accountableRole} chooses — the choice is the approval.`)
      : L(`1위는 「${b.label}」 대안(전략 점수 ${b.score.total})이에요. ${why} ${adapter.accountableRole}에게 고르도록 했어요.`,
        `The best is "${b.label}" (score ${b.score.total}). As ${why}, the ${adapter.accountableRole} chooses.`)
  }
  const roles = path.holders.map((h) => (names[h.role] ? `${h.role}(${names[h.role]})` : h.role)).join(', ')
  if (path.mode === 'escalate') return L(`모든 대안이 정책에 막혀요(필수 제약). 예외 권한자 ${roles}에게 넘겼어요 — 가장 가까운 대안: 「${b.label}」`,
    `Every alternative is denied (must constraints). Escalated to the exception holder ${roles} — the closest alternative: "${b.label}".`)
  return L(`모든 대안이 정책에 막히고, 예외 권한(${roles || '없음'})을 가진 사람이 없어 멈췄어요.`,
    `Every alternative is denied and nobody holds the exception authority (${roles || 'none'}): stopped.`)
}

// ── cards: one 'optimize' card per person (the requester, the accountable people, exception holders)
export async function cardOf(opt) {
  const t = opt.trigger || {}
  return {
    optimizationId: opt.id, status: opt.status, chosen: opt.chosen, explain: opt.explain,
    subject: t.action?.subject, request: t.request || null, finding: t.finding || null,
    blockedBy: (t.matched || []).filter((m) => m.decision === 'deny' || m.decision === 'require_approval'),
    role: t.accountableRole, exception: t.exception || null, previous: t.previous || null, next: t.next || null,
    decidedBy: opt.decided_by ? await nameOf(opt.decided_by) : null, auto: !!t.auto,
    alternatives: (opt.alternatives || []).map((a) => ({
      id: a.id, kind: a.kind, label: a.label, rationale: a.rationale, source: a.source, rank: a.rank,
      decision: a.policy?.decision, approver: a.policy?.approver,
      phases: a.phases.map((p) => ({ day: p.day, audience: p.audience, rollout: p.rollout, items: p.items, decision: p.policy?.decision })),
      days: a.sim?.daysToFull, delivered: a.sim?.delivered, risk: a.sim?.risk, contribution: a.sim?.contribution,
      score: a.score?.total ?? null, share: a.score?.share ?? null, why: a.why, excluded: a.excluded, reason: a.reason,
      breaks: a.breaks, execution: a.execution || null,
    })),
  }
}
async function postCard(opt, userId, chooser) {
  const thread = await mainThread(userId)
  const m = await addMessage(userId, thread.id, 'agent', 'optimize', { ...(await cardOf(opt)), chooser })
  await q(`insert into pro_optimization_cards(optimization_id, user_id, message_id, chooser) values ($1,$2,$3,$4)
    on conflict (optimization_id, user_id) do update set message_id=$3, chooser=pro_optimization_cards.chooser or $4`, [opt.id, userId, m.id, chooser])
  return m.id
}
async function refreshCards(opt) {
  const cards = await q('select user_id, message_id, chooser from pro_optimization_cards where optimization_id=$1', [opt.id])
  const content = await cardOf(opt)
  for (const c of cards) await updateMessage(c.user_id, c.message_id, { ...content, chooser: c.chooser })
}

export async function load(id) {
  const [o] = await q('select * from pro_optimizations where id=$1 and tenant_id=$2', [id, T()])
  if (!o) throw fail(404, '그런 최적화가 없어요.', 'No such optimization.')
  return o
}
async function save(opt, fields) {
  const cols = Object.keys(fields)
  const [o] = await q(`update pro_optimizations set ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')} where id=$1 returning *`,
    [opt.id, ...cols.map((c) => (['trigger', 'alternatives'].includes(c) ? JSON.stringify(fields[c]) : fields[c]))])
  return o
}

// run the optimizer for a blocked action. trigger: {kind: 'policy_block', decision_id, action{kind, subject, facts},
// matched[], request, finding, …}. options: {useModel, ask (never run on its own), unheldRoles (treat these roles
// as unheld — a what-if for the demo), reuse (alternatives' fields to check again instead of generating)}
export async function optimize({ me, trigger, options = {} }) {
  const adapter = adapterOf(trigger)
  const graph = await graphOf()
  const ctx = { ...(await adapter.context(trigger)), kind: trigger.action.kind, graph, blockedBy: (trigger.matched || []).filter((m) => m.decision !== 'allow') }
  const trig = { ...trigger, accountableRole: adapter.accountableRole, options: { useModel: options.useModel !== false, ask: !!options.ask, unheldRoles: options.unheldRoles || [] } }
  const [row] = await q('insert into pro_optimizations(tenant_id, user_id, trigger, status) values ($1,$2,$3,\'proposed\') returning *', [T(), me.id, JSON.stringify(trig)])
  const fields = options.reuse ? options.reuse.map(fieldsOf) : await generate(ctx, { useModel: options.useModel !== false })
  const alts = fields.map((a) => ({ ...fieldsOf(a), ...phasesOf(a, ctx) })).filter((a) => a.phases.length)
  const assessed = await assess(alts, { ctx, adapter, graph, userId: me.id, optId: row.id, dry: 'ledger' })
  const path = await choosePath(assessed, trig.options)
  let opt = await save(row, { alternatives: assessed, explain: explainOf(path, adapter) })

  if (path.mode === 'auto') {
    opt = await save(opt, { trigger: { ...opt.trigger, auto: true }, chosen: path.best.id, status: 'chosen' })
    await postCard(opt, me.id, false)
    // on the loop: the accountable people see what ran without them, and can take it back from the ledger
    const holders = (await approversOf(adapter.accountableRole)).filter((u) => String(u) !== String(me.id))
    for (const uid of holders) await postCard(opt, uid, false)
    opt = await execute(opt, path.best.id, { chooser: null, adapter, ctx })
    for (const uid of holders) {
      await notifyUser(uid, {
        type: 'policy', url: '/chat',
        title: L(`자동 실행 — ${trigger.action.subject}`, `Ran on its own — ${trigger.action.subject}`),
        text: opt.explain,
      }).catch(() => {})
    }
  } else if (path.mode === 'ask') {
    const holders = await approversOf(adapter.accountableRole)
    await postCard(opt, me.id, holders.map(String).includes(String(me.id)))
    for (const uid of holders.filter((u) => String(u) !== String(me.id))) {
      await postCard(opt, uid, true)
      await notifyUser(uid, {
        type: 'policy', url: '/chat',
        title: L(`대안 선택 요청 — ${trigger.action.subject}`, `Choose an alternative — ${trigger.action.subject}`),
        text: L(`${me.name || '팀원'}님의 요청이 정책에 막혀 대안 ${assessed.length}개를 만들었어요. ${adapter.accountableRole}로서 골라 주세요.`,
          `${me.name || 'A teammate'}'s request was blocked; ${assessed.length} alternatives are ready for you, as the ${adapter.accountableRole}, to choose from.`),
      }).catch(() => {})
    }
  } else {
    const holders = path.holders.filter((h) => h.userId)
    const named = await Promise.all(holders.map(async (h) => ({ role: h.role, name: await nameOf(h.userId) })))
    opt = await save(opt, { status: path.mode === 'escalate' ? 'escalated' : 'stopped', explain: explainOf(path, adapter, Object.fromEntries(named.map((h) => [h.role, h.name]))),
      trigger: { ...opt.trigger, exception: { roles: path.holders.map((h) => h.role), holders: named, alternative: path.best?.id || null } } })
    await postCard(opt, me.id, false)
    if (path.mode === 'escalate') {
      for (const h of holders.filter((x) => String(x.userId) !== String(me.id))) {
        await postCard(opt, h.userId, false)
        await notifyUser(h.userId, {
          type: 'policy', url: '/chat',
          title: L(`예외 판단 요청 — ${trigger.action.subject}`, `Exception needed — ${trigger.action.subject}`),
          text: L(`모든 대안이 「${path.best.denied.map((m) => m.title?.[0]).join('」, 「')}」에 막혀요. ${h.role}로서 예외를 허용할지 판단해 주세요.`,
            `Every alternative is denied by "${path.best.denied.map((m) => m.title?.[1]).join('", "')}". As the ${h.role}, decide whether to grant an exception.`),
        }).catch(() => {})
      }
    }
  }
  return opt
}

// run the chosen alternative: its first phase through guard() when it runs now, the later ones recorded as planned
async function execute(opt, altId, { chooser, adapter = adapterOf(opt.trigger), ctx = null }) {
  ctx ||= { ...(await adapter.context(opt.trigger)), kind: opt.trigger.action.kind }
  const alts = opt.alternatives.map((a) => ({ ...a }))
  const alt = alts.find((a) => a.id === altId)
  const [requester] = await q('select id, username as name from users where id=$1 and tenant_id=$2', [opt.user_id, T()])
  const me = requester || { id: opt.user_id }
  let status = 'chosen'
  const execution = { phases: [] }
  for (const [i, p] of alt.phases.entries()) {
    if (i === 0 && p.day === 0) {
      const g = await guard({ me, kind: ctx.kind, subject: adapter.subjectOf(p, ctx), facts: adapter.factsOf(p, ctx, alt.fixes), executor: adapter.executor,
        payload: adapter.payloadOf(p, ctx, opt, alt), card: { userId: me.id } })
      let st = g.status
      // the dry run said "needs approval" and the person choosing is that approver: the choice is the approval
      // (not when the chooser is the requester — their own request waits for someone else, lib/policy/pep.js answer)
      if (st === 'pending' && chooser && String(chooser.id) !== String(me.id) && await canApprove(chooser, g.approver)) {
        const r = await answer(chooser, g.decisionId, true, L('대안을 고르며 승인했어요 (경로 최적화)', 'Approved by choosing this alternative (path optimizer)'))
        st = r.status
      }
      execution.phases.push({ day: p.day, decisionId: g.decisionId, decision: g.decision, status: st })
      status = st === 'executed' ? 'executed' : st === 'blocked' || st === 'failed' ? 'stopped' : 'chosen'
    } else {
      const rec = await adapter.recordLater(p, ctx, opt, alt, me.id)
      execution.phases.push({ day: p.day, status: rec.status, id: rec.id })
    }
  }
  alt.execution = execution
  for (const a of alts) a.chosen = a.id === altId
  const why = status === 'stopped'
    ? L(' 실행 시점의 정책 판단이 달라 멈췄어요.', ' The policies decided otherwise when it ran: stopped.')
    : status === 'chosen' && alt.phases[0].day > 0 ? L(` 첫 단계는 ${alt.phases[0].day}일 뒤라 예약만 해 두었어요.`, ` Its first step is in ${alt.phases[0].day} days: only scheduled.`)
      : status === 'chosen' ? L(' 승인을 기다려요.', ' Waiting for approval.') : ''
  opt = await save(opt, {
    alternatives: alts, chosen: altId, status, decided_by: chooser?.id || null, decided_at: new Date(),
    explain: (chooser ? L(`${chooser.name || ''}님이 「${alt.label}」 대안을 골랐어요.`, `${chooser.name || ''} chose "${alt.label}".`) : opt.explain) + why,
  })
  await refreshCards(opt)
  return opt
}

// the accountable person picks an alternative from the card
export async function choose(me, id, altId) {
  const opt = await load(id)
  const adapter = adapterOf(opt.trigger)
  if (opt.status !== 'proposed') throw fail(409, '이미 결정된 최적화예요.', 'This optimization is already decided.')
  if (!(await canApprove(me, adapter.accountableRole))) throw fail(403, `${adapter.accountableRole}만 고를 수 있어요.`, `Only the ${adapter.accountableRole} can choose.`)
  const alt = opt.alternatives.find((a) => a.id === altId)
  if (!alt) throw fail(404, '그런 대안이 없어요.', 'No such alternative.')
  if (alt.excluded) throw fail(409, `이 대안은 정책에 막혀요: ${alt.reason}`, `This alternative is denied: ${alt.reason}`)
  return execute(opt, altId, { chooser: me, adapter })
}

export async function stop(me, id, note = '') {
  const opt = await load(id)
  const adapter = adapterOf(opt.trigger)
  const roles = [adapter.accountableRole, ...(opt.trigger.exception?.roles || [])]
  let may = String(me.id) === String(opt.user_id)
  for (const r of roles) if (!may) may = await canApprove(me, r)
  if (!may) throw fail(403, '요청한 사람이나 책임자만 멈출 수 있어요.', 'Only the requester or the accountable people can stop it.')
  if (['executed', 'stopped'].includes(opt.status)) throw fail(409, '이미 끝난 최적화예요.', 'This optimization is already over.')
  const o = await save(opt, { status: 'stopped', decided_by: me.id, decided_at: new Date(), explain: `${opt.explain || ''} ${L(`${me.name || ''}님이 멈췄어요.`, `Stopped by ${me.name || ''}.`)}${note ? ` (${note})` : ''}` })
  await refreshCards(o)
  return o
}

// check the same alternatives again against today's graph and policies. preview: nothing written — the new
// ranking next to the old (Strategy › 다시 계산); otherwise a new optimization replaces an undecided one.
export async function rerun(me, id, { preview = false, ask, unheldRoles } = {}) {
  const opt = await load(id)
  const adapter = adapterOf(opt.trigger)
  const options = { ...(opt.trigger.options || {}), ...(ask != null ? { ask } : {}), ...(unheldRoles ? { unheldRoles } : {}), reuse: opt.alternatives }
  if (preview) {
    const graph = await graphOf()
    const ctx = { ...(await adapter.context(opt.trigger)), kind: opt.trigger.action.kind, graph, blockedBy: [] }
    const alts = opt.alternatives.map((a) => ({ ...fieldsOf(a), ...phasesOf(a, ctx) })).filter((a) => a.phases.length)
    const assessed = await assess(alts, { ctx, adapter, graph, userId: opt.user_id, dry: 'none' })
    const path = await choosePath(assessed, options)
    const before = Object.fromEntries(opt.alternatives.map((a) => [a.id, a]))
    return {
      id: opt.id, preview: true, mode: path.mode, best: path.best?.id || null, explain: explainOf(path, adapter),
      alternatives: assessed.map((a) => ({ id: a.id, label: a.label, kind: a.kind, decision: a.policy.decision, excluded: a.excluded, reason: a.reason,
        score: a.score?.total ?? null, share: a.score?.share ?? null, rank: a.rank, days: a.sim.daysToFull, delivered: a.sim.delivered, risk: a.sim.risk,
        before: { score: before[a.id]?.score?.total ?? null, rank: before[a.id]?.rank ?? null }, why: a.why, parts: a.score?.parts || [] })),
    }
  }
  if (['executed', 'chosen'].includes(opt.status)) throw fail(409, '이미 실행했거나 고른 최적화예요. 새로 요청해 주세요.', 'Already run or chosen: make a new request.')
  if (String(me.id) !== String(opt.user_id) && !(await canApprove(me, adapter.accountableRole))) throw fail(403, '요청한 사람이나 책임자만 다시 계산할 수 있어요.', 'Only the requester or the accountable people can re-run it.')
  const [requester] = await q('select id, username as name from users where id=$1 and tenant_id=$2', [opt.user_id, T()])
  const trigger = { ...opt.trigger, previous: opt.id, auto: false, exception: null, next: null }
  delete trigger.options
  const fresh = await optimize({ me: requester || { id: opt.user_id }, trigger, options })
  const old = await save(opt, { status: 'stopped', trigger: { ...opt.trigger, next: fresh.id }, explain: `${opt.explain || ''} ${L(`${me.name || ''}님이 다시 계산해 새 최적화로 바뀌었어요.`, `Re-run by ${me.name || ''}: replaced by a new optimization.`)}` })
  await refreshCards(old)
  return fresh
}

// a short list for the screens
export async function list({ limit = 20, kind = null } = {}) {
  const rows = await q(`select o.*, u.username as requester from pro_optimizations o left join users u on u.id=o.user_id and u.tenant_id=o.tenant_id
    where o.tenant_id=$1 and ($2::text is null or o.trigger->'action'->>'kind'=$2) order by o.created_at desc limit $3`, [T(), kind, limit])
  return rows
}

export { KIND_LABEL }
