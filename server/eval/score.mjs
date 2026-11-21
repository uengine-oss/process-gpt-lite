// Scores router results (eval/run.mjs output) against their sets (design 7.2–7.4).
//   cd server && node eval/score.mjs results/new-dev-….jsonl [results/new-holdout-….jsonl …] [--failures]
// Prints, per set: macro F1 over the 13 routes, per-route precision/recall/F1, argument match, the
// cost-weighted misroute rate, wrong executions, the ask rate, the three overfitting measures (dev vs
// holdout, Korean plain vs other styles and languages, decisions flipping between runs), latency and
// tokens. --failures lists the failing items of the development set only: the holdout set's items are
// never printed (its score is read per skill and variation axis).
import fs from 'node:fs'
import path from 'node:path'
import { readSet, ROUTES, ACTIONS, stateOf } from './check-sets.mjs'
import { loadSkills } from '../lib/skills/registry.js'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const showFailures = process.argv.includes('--failures')
const COST = Object.fromEntries(loadSkills().map((s) => [s.name, s.metadata.misroute_cost]))
const W = { high: 3, medium: 2, low: 1 }
const HIGH = ACTIONS.filter((a) => COST[a] === 'high')

const pct = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 1000) / 10)
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }

// a teammate may be named by name, e-mail or the role they hold (the handler resolves all three): compared
// as the person, in the item's state
function argsMatch(expect, got, state) {
  const person = (v) => state?.team?.find((m) => m.name === v || m.email === v || (m.roles || []).includes(v))?.name ?? v
  for (const [k, v] of Object.entries(expect?.args || {})) {
    const g = got?.[k] ?? null
    if (v != null && (k === 'member' ? person(g) !== person(v) : g !== v)) return false
  }
  return true
}

export function scoreSet(items, results) {
  const byId = new Map(items.map((it) => [it.id, it]))
  const runs = new Map()
  for (const r of results) { if (!byId.has(r.id)) continue; if (!runs.has(r.id)) runs.set(r.id, []); runs.get(r.id).push(r) }
  const first = [...runs.entries()].map(([id, rs]) => ({ it: byId.get(id), r: rs.sort((a, b) => a.run - b.run)[0], all: rs }))
  const n = first.length
  const per = Object.fromEntries(ROUTES.map((l) => [l, { tp: 0, fp: 0, fn: 0 }]))
  let correct = 0, argN = 0, argOk = 0, cost = 0, highWrong = 0, delN = 0, delExec = 0, asked = 0, errors = 0, flips = 0, multi = 0
  const fails = []
  const groups = {}
  const cells = {}
  for (const { it, r, all } of first) {
    const want = it.expect.route
    const got = ROUTES.includes(r.route) ? r.route : 'delegate'
    if (r.route === 'error') errors += 1
    const routeOk = got === want
    const hasArgs = Object.keys(it.expect.args || {}).length > 0
    const aOk = !hasArgs || argsMatch(it.expect, r.args, stateOf(it.state))
    if (routeOk && hasArgs) { argN += 1; if (aOk) argOk += 1 }
    const ok = routeOk && aOk
    if (ok) correct += 1
    if (routeOk) per[want].tp += 1
    else { per[got].fp += 1; per[want].fn += 1 }
    // what a wrong decision costs (7.3): running the wrong action costs its grade; handing an action to the
    // agent (or asking needlessly) is slower or a detour, not a wrong act
    if (!ok) cost += ACTIONS.includes(got) ? W[COST[got]] || 1 : got === 'ask' ? 0.5 : 1
    if (HIGH.includes(got) && !ok) highWrong += 1
    if (want === 'delegate') { delN += 1; if (ACTIONS.includes(got)) delExec += 1 }
    if (got === 'ask') asked += 1
    if (all.length > 1) { multi += 1; if (new Set(all.map((x) => `${x.route}|${JSON.stringify(Object.fromEntries(Object.keys(it.expect.args || {}).map((k) => [k, x.args?.[k] ?? null])))}`)).size > 1) flips += 1 }
    if (!ok) fails.push({ id: it.id, text: it.text, state: it.state, want: it.expect, got: { route: r.route, args: r.args, via: r.via } })
    const lang = it.axis?.lang || '?'
    const style = it.axis?.style || '?'
    const g = lang === 'ko' && style === 'plain' ? 'ko-plain' : 'other'
    for (const key of [`group:${g}`, `lang:${lang}`, `style:${style}`, `quality:${it.axis?.quality || '?'}`, `mode:${it.mode || 'ko'}`]) {
      groups[key] ||= { n: 0, ok: 0 }; groups[key].n += 1; if (ok) groups[key].ok += 1
    }
    const cell = it.category === 'positive' || it.category === 'boundary' ? `${it.skill}·${it.category}` : it.category
    cells[cell] ||= { n: 0, ok: 0 }; cells[cell].n += 1; if (ok) cells[cell].ok += 1
  }
  const f1 = {}
  for (const [l, c] of Object.entries(per)) {
    const p = c.tp + c.fp ? c.tp / (c.tp + c.fp) : (c.fn ? 0 : null)
    const rcl = c.tp + c.fn ? c.tp / (c.tp + c.fn) : null
    f1[l] = { precision: pct(p), recall: pct(rcl), f1: p != null && rcl != null ? pct(p + rcl ? (2 * p * rcl) / (p + rcl) : 0) : null, support: c.tp + c.fn }
  }
  const present = Object.entries(f1).filter(([, v]) => v.support > 0 && v.f1 != null)
  const macro = present.reduce((s, [, v]) => s + v.f1, 0) / Math.max(1, present.length)
  const acc = (k) => (groups[k] ? groups[k].ok / groups[k].n : null)
  const firstMs = first.map((x) => x.r.first_ms).filter((x) => x != null)
  const totalMs = first.map((x) => x.r.total_ms).filter((x) => x != null)
  return {
    items: n, accuracy: pct(correct / n), macro_f1: Math.round(macro * 10) / 10, per_route: f1,
    arg_match: pct(argN ? argOk / argN : null), cost_weighted_misroute: Math.round((cost / n) * 1000) / 1000,
    high_grade_wrong_execution: pct(highWrong / n), delegate_wrong_execution: pct(delN ? delExec / delN : null),
    ask_rate: pct(asked / n), errors,
    overfit: {
      ko_plain_accuracy: pct(acc('group:ko-plain')), other_accuracy: pct(acc('group:other')),
      ko_plain_minus_other: pct((acc('group:ko-plain') ?? 0) - (acc('group:other') ?? 0)),
      flip_rate: multi ? pct(flips / multi) : null, runs_compared: multi,
    },
    groups: Object.fromEntries(Object.entries(groups).sort().map(([k, v]) => [k, { n: v.n, accuracy: pct(v.ok / v.n) }])),
    cells: Object.fromEntries(Object.entries(cells).sort().map(([k, v]) => [k, { n: v.n, accuracy: pct(v.ok / v.n) }])),
    latency_ms: { first_p50: q(firstMs, 0.5), first_p95: q(firstMs, 0.95), total_p50: q(totalMs, 0.5), total_p95: q(totalMs, 0.95) },
    stage2_rate: pct(first.filter((x) => x.r.stage2).length / n),
    tokens: { in_avg: Math.round(first.reduce((s, x) => s + (x.r.tokens?.in || 0), 0) / n), out_avg: Math.round(first.reduce((s, x) => s + (x.r.tokens?.out || 0), 0) / n) },
    calls_avg: Math.round((first.reduce((s, x) => s + (x.r.calls || 0), 0) / n) * 100) / 100,
    _fails: fails,
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const results = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  const bySet = {}
  for (const r of results) (bySet[`${r.impl}:${r.set}`] ||= []).push(r)
  const out = {}
  for (const [key, rs] of Object.entries(bySet)) {
    const setName = key.split(':')[1]
    const items = readSet(path.join(HERE, 'sets', `${setName}.jsonl`))
    const s = scoreSet(items, rs)
    const fails = s._fails
    delete s._fails
    out[key] = s
    console.log(`\n== ${key}`)
    console.log(JSON.stringify({ items: s.items, accuracy: s.accuracy, macro_f1: s.macro_f1, arg_match: s.arg_match, cost_weighted_misroute: s.cost_weighted_misroute, high_grade_wrong_execution: s.high_grade_wrong_execution, delegate_wrong_execution: s.delegate_wrong_execution, ask_rate: s.ask_rate, errors: s.errors, overfit: s.overfit, latency_ms: s.latency_ms, stage2_rate: s.stage2_rate, tokens: s.tokens, calls_avg: s.calls_avg }))
    console.log('per route F1:', Object.entries(s.per_route).map(([l, v]) => `${l} ${v.f1}(P${v.precision}/R${v.recall}, n${v.support})`).join(' | '))
    console.log('cells:', Object.entries(s.cells).map(([k, v]) => `${k} ${v.accuracy}%/${v.n}`).join(' | '))
    console.log('groups:', Object.entries(s.groups).map(([k, v]) => `${k} ${v.accuracy}%/${v.n}`).join(' | '))
    if (showFailures && setName !== 'holdout') for (const f of fails) console.log(`FAIL ${f.id} [${f.state}] ${f.text} — want ${JSON.stringify(f.want)} got ${JSON.stringify(f.got)}`)
  }
  // overfitting 1: development vs holdout, per implementation
  for (const impl of new Set(Object.keys(out).map((k) => k.split(':')[0]))) {
    const d = out[`${impl}:dev`], h = out[`${impl}:holdout`]
    if (d && h) console.log(`\n${impl}: dev−holdout macro F1 gap ${Math.round((d.macro_f1 - h.macro_f1) * 10) / 10} (dev ${d.macro_f1}, holdout ${h.macro_f1})`)
  }
  const target = files.length === 1 ? files[0].replace(/\.jsonl$/, '.score.json') : path.join(path.dirname(files[0]), `score-${Date.now()}.json`)
  fs.writeFileSync(target, JSON.stringify(out, null, 1))
  console.log(`\n${target}`)
}
