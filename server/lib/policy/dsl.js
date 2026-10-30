// The guardrail policy DSL (plan.md §4) and its validator. A policy, as JSON:
//
//   { id, category, title: [ko, en], explain: [ko, en], sources: [..],
//     scope: { action: ['mail.send', 'browser.*'] },                 // which actions it looks at
//     when: <JSONLogic over the action's facts>,                     // matches when truthy (absent = always)
//     decide: 'allow' | 'allow_audit' | 'require_approval' | 'deny',
//     approver: { role: '개인정보 책임자' },                          // who may approve / grant an exception
//     tolerance: { field: 'amount', limit: 100000, over: 0.1 },      // within limit × (1 + over): only recorded
//     window: { span: '1d', count: 20, then: 'require_approval' } }  // more than count in span: stricter
//
// Several policies match one action: the strictest decision wins (deny > require_approval > allow_audit > allow).
// The decision is deterministic: facts such as "how many personal data items" are inputs the caller fills
// (rules, or a classifier); no model decides whether something needs approval.
import { operators, KNOWN } from './jsonlogic.js'

export const DECISIONS = ['allow', 'allow_audit', 'require_approval', 'deny']
export const rank = (d) => DECISIONS.indexOf(d)
export const strictest = (list) => list.reduce((a, d) => (rank(d) > rank(a) ? d : a), 'allow')
export const CATEGORIES = ['security', 'privacy', 'legal', 'ethics', 'authority', 'audit', 'cost', 'quality']

const SPAN = /^(\d+)(m|h|d)$/
export const spanMs = (s) => { const m = String(s).match(SPAN); return m ? Number(m[1]) * { m: 6e4, h: 36e5, d: 864e5 }[m[2]] : null }

// does a policy's scope cover an action kind ('mail.*' covers 'mail.send')
export function inScope(spec, kind) {
  return (spec.scope?.action || []).some((p) => p === '*' || p === kind || (p.endsWith('.*') && kind.startsWith(p.slice(0, -1))))
}

// a list of problems (empty: valid)
export function validate(spec) {
  const errs = []
  const need = (ok, msg) => { if (!ok) errs.push(msg) }
  need(/^[a-z0-9][a-z0-9-]{1,63}$/.test(spec?.id || ''), 'id: lower-case words joined by -')
  need(CATEGORIES.includes(spec?.category), `category: one of ${CATEGORIES.join(', ')}`)
  need(Array.isArray(spec?.scope?.action) && spec.scope.action.length > 0, 'scope.action: at least one action kind')
  need(DECISIONS.includes(spec?.decide), `decide: one of ${DECISIONS.join(', ')}`)
  need(Array.isArray(spec?.title) && spec.title.length === 2, 'title: [Korean, English]')
  if (spec?.when !== undefined) {
    const bad = [...operators(spec.when)].filter((op) => !KNOWN.has(op))
    need(!bad.length, `when: unknown operators ${bad.join(', ')}`)
  }
  if (spec?.decide === 'require_approval') need(!!spec?.approver?.role, 'approver.role: who approves')
  if (spec?.tolerance) {
    need(typeof spec.tolerance.field === 'string' && Number(spec.tolerance.limit) > 0 && Number(spec.tolerance.over) >= 0, 'tolerance: {field, limit > 0, over ≥ 0}')
  }
  if (spec?.window) {
    need(spanMs(spec.window.span) != null, 'window.span: like 30m, 12h, 1d')
    need(Number(spec.window.count) > 0, 'window.count > 0')
    need(DECISIONS.includes(spec.window.then), 'window.then: a decision')
  }
  return errs
}
