// Checks an evaluation set (JSON Lines) against the rules of design 7.1 without printing its items:
// shape, labels, states and ids, the composition per skill, and closeness to the forbidden sentences.
//   node server/eval/check-sets.mjs server/eval/sets/dev.jsonl [--quiet]
// --quiet prints counts and the line numbers of problems only (for the holdout set, whose items the
// person improving the skills does not read).
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
export const ACTIONS = ['schedule-create', 'schedule-run-now', 'telegram-delivery', 'panel-create', 'panel-record', 'folder-change', 'process-work', 'process-improve-explain', 'browser-task', 'teammate-notify', 'home-action-add']
export const ROUTES = [...ACTIONS, 'delegate', 'ask']
const fixtures = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures.json'), 'utf8')).states
export function stateOf(name) {
  const s = fixtures[name]
  if (!s) return null
  const { extends: base, ...own } = s
  return base ? { ...stateOf(base), ...own } : own
}

// closeness to a forbidden sentence: normalized (case, spaces, punctuation) edit-distance ratio, or
// containing one of 8+ characters
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
function ratio(a, b) {
  if (!a.length || !b.length) return 0
  const m = a.length, n = b.length
  if (Math.abs(m - n) / Math.max(m, n) > 0.4) return 0
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return 1 - prev[n] / Math.max(m, n)
}
const forbidden = fs.readFileSync(path.join(HERE, 'forbidden.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map(norm).filter((x) => x.length >= 6)
export function nearForbidden(text) {
  const t = norm(text)
  for (const f of forbidden) {
    if (f.length >= 8 && (t.includes(f) || (t.length >= 8 && f.includes(t)))) return f
    if (ratio(t, f) >= 0.75) return f
  }
  return null
}

export function readSet(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((l, i) => ({ l, i: i + 1 })).filter((x) => x.l.trim()).map(({ l, i }) => {
    try { return { ...JSON.parse(l), _line: i } } catch (e) { return { _line: i, _bad: e.message } }
  })
}

function idsOf(state) {
  return {
    schedule: new Set(state.schedules.map((s) => s.id)),
    app: new Set(state.apps.map((a) => a.id)),
    folder: new Set([...state.folders.map((f) => f.slug), ...(state.attachedFolder ? ['attached'] : [])]),
    process: new Set([...state.processes.map((p) => p.id), ...state.improvable.map((p) => p.id)]),
    member: new Set(state.team.flatMap((m) => [m.name, m.email, ...m.roles])),
  }
}

export function check(items) {
  const problems = []
  const seen = new Set()
  for (const it of items) {
    const p = (why) => problems.push({ line: it._line, id: it.id, why })
    if (it._bad) { p(`not JSON: ${it._bad}`); continue }
    if (!it.id || seen.has(it.id)) p('missing or duplicate id')
    seen.add(it.id)
    if (!it.text || typeof it.text !== 'string') p('no text')
    const state = stateOf(it.state)
    if (!state) { p(`unknown state ${it.state}`); continue }
    if (!ROUTES.includes(it.expect?.route)) p(`unknown route ${it.expect?.route}`)
    if (!['positive', 'boundary', 'delegate', 'ask'].includes(it.category)) p(`unknown category ${it.category}`)
    if (it.category === 'positive' && it.expect?.route !== it.skill) p('positive item whose route is not its skill')
    if (it.category === 'boundary' && (!ACTIONS.includes(it.skill) || it.expect?.route === it.skill)) p('boundary item must name a neighbouring skill and expect another route')
    const ids = idsOf(state)
    for (const [k, v] of Object.entries(it.expect?.args || {})) {
      if (ids[k] && v != null && !ids[k].has(v)) p(`arg ${k}=${v} not in state ${it.state}`)
    }
    const near = nearForbidden(it.text)
    if (near) p(`too close to a forbidden sentence`)
  }
  return problems
}

export function composition(items) {
  const c = {}
  for (const it of items) {
    const k = it.category === 'positive' || it.category === 'boundary' ? `${it.skill}:${it.category}` : it.category
    c[k] = (c[k] || 0) + 1
  }
  return c
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const file = process.argv[2]
  const quiet = process.argv.includes('--quiet')
  const items = readSet(file)
  const problems = check(items)
  const comp = composition(items)
  const short = [...ACTIONS.flatMap((s) => [[`${s}:positive`, 15], [`${s}:boundary`, 15]]), ['delegate', 100], ['ask', 30]].filter(([k, n]) => (comp[k] || 0) < n).map(([k, n]) => `${k} ${comp[k] || 0}/${n}`)
  const langs = {}
  for (const it of items) langs[it.axis?.lang || '?'] = (langs[it.axis?.lang || '?'] || 0) + 1
  console.log(JSON.stringify({ items: items.length, problems: problems.length, short, langs }, null, 1))
  for (const x of problems) console.log(quiet ? `line ${x.line}: ${x.why}` : `line ${x.line} ${x.id}: ${x.why}`)
  if (!quiet) console.log(JSON.stringify(comp))
  process.exitCode = problems.length || short.length ? 1 : 0
}
