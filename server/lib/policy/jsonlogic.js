// The JSONLogic subset the policy DSL uses (jsonlogic.com): deterministic, no model. A rule is a value or
// {op: [args]}; {var: "a.b"} reads the facts. Unknown operators throw, so a typo in a policy is an error at
// load time (lib/policy/dsl.js validates every rule against a sample), not a silent "never matches".
const truthy = (v) => (Array.isArray(v) ? v.length > 0 : !!v)

function get(data, path, dflt) {
  if (path === '' || path == null) return data
  let cur = data
  for (const k of String(path).split('.')) {
    if (cur == null) return dflt
    cur = cur[k]
  }
  return cur === undefined ? dflt : cur
}

const OPS = {
  var: (data, [path, dflt]) => get(data, path, dflt),
  '==': (d, [a, b]) => a == b, // eslint-disable-line eqeqeq
  '===': (d, [a, b]) => a === b,
  '!=': (d, [a, b]) => a != b, // eslint-disable-line eqeqeq
  '!==': (d, [a, b]) => a !== b,
  '>': (d, [a, b]) => Number(a) > Number(b),
  '>=': (d, [a, b]) => Number(a) >= Number(b),
  '<': (d, [a, b, c]) => (c === undefined ? Number(a) < Number(b) : Number(a) < Number(b) && Number(b) < Number(c)),
  '<=': (d, [a, b, c]) => (c === undefined ? Number(a) <= Number(b) : Number(a) <= Number(b) && Number(b) <= Number(c)),
  '!': (d, [a]) => !truthy(a),
  '!!': (d, [a]) => truthy(a),
  in: (d, [a, b]) => (Array.isArray(b) ? b.includes(a) : String(b ?? '').includes(String(a))),
  '+': (d, args) => args.reduce((s, x) => s + Number(x), 0),
  '-': (d, [a, b]) => (b === undefined ? -Number(a) : Number(a) - Number(b)),
  '*': (d, args) => args.reduce((s, x) => s * Number(x), 1),
  '/': (d, [a, b]) => Number(a) / Number(b),
  max: (d, args) => Math.max(...args.map(Number)),
  min: (d, args) => Math.min(...args.map(Number)),
  count: (d, [a]) => (Array.isArray(a) ? a.length : 0),
}
// and / or / if / some / all / none evaluate their arguments lazily
const LAZY = {
  and(rule, data) { let v = true; for (const r of rule) { v = apply(r, data); if (!truthy(v)) return v } return v },
  or(rule, data) { let v = false; for (const r of rule) { v = apply(r, data); if (truthy(v)) return v } return v },
  if(rule, data) {
    let i = 0
    for (; i + 1 < rule.length; i += 2) if (truthy(apply(rule[i], data))) return apply(rule[i + 1], data)
    return i < rule.length ? apply(rule[i], data) : null
  },
  some(rule, data) { const list = apply(rule[0], data) || []; return list.some((x) => truthy(apply(rule[1], x))) },
  all(rule, data) { const list = apply(rule[0], data) || []; return list.length > 0 && list.every((x) => truthy(apply(rule[1], x))) },
  none(rule, data) { const list = apply(rule[0], data) || []; return !list.some((x) => truthy(apply(rule[1], x))) },
}

export function apply(rule, data = {}) {
  if (Array.isArray(rule)) return rule.map((r) => apply(r, data))
  if (rule === null || typeof rule !== 'object') return rule
  const keys = Object.keys(rule)
  if (keys.length !== 1) throw new Error(`a rule has one operator: ${JSON.stringify(rule).slice(0, 80)}`)
  const op = keys[0]
  const args = Array.isArray(rule[op]) ? rule[op] : [rule[op]]
  if (LAZY[op]) return LAZY[op](args, data)
  if (!OPS[op]) throw new Error(`unknown operator "${op}"`)
  return OPS[op](data, op === 'var' ? args : args.map((a) => apply(a, data)))
}

// every operator a rule uses, to validate a policy without running it
export function operators(rule, out = new Set()) {
  if (Array.isArray(rule)) { rule.forEach((r) => operators(r, out)); return out }
  if (rule && typeof rule === 'object') {
    for (const [op, args] of Object.entries(rule)) { out.add(op); if (op !== 'var') operators(args, out) }
  }
  return out
}
export const KNOWN = new Set([...Object.keys(OPS), ...Object.keys(LAZY)])
export { truthy }
