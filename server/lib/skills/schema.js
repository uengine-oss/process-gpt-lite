// A router's arguments checked against a skill's args.schema.json (the JSON Schema subset the action
// skills use). An argument whose values come from the facts (`x-enum-from`) must be one of those ids:
// the model picks the id, the code only checks that it is in the list (design 1.2).
export function checkArgs(schema, input, enums = {}, { only = null } = {}) {
  const props = schema?.properties || {}
  const errors = []
  const args = {}
  const given = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  for (const [k, spec] of Object.entries(props)) {
    if (only && !only.includes(k)) continue
    let v = given[k]
    if (v === undefined || v === null || v === '') continue
    if (spec.type === 'integer') {
      const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v
      if (!Number.isInteger(n)) { errors.push(`${k}: not an integer`); continue }
      if (spec.minimum != null && n < spec.minimum) { errors.push(`${k}: below ${spec.minimum}`); continue }
      v = n
    } else if (spec.type === 'boolean') {
      if (v === 'true' || v === 'false') v = v === 'true'
      if (typeof v !== 'boolean') { errors.push(`${k}: not a boolean`); continue }
    } else if (spec.type === 'object') {
      if (typeof v === 'string') { try { v = JSON.parse(v) } catch { /* below */ } }
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${k}: not an object`); continue }
    } else if (spec.type === 'array') {
      if (!Array.isArray(v)) { errors.push(`${k}: not a list`); continue }
    } else if (spec.type === 'string') {
      if (typeof v === 'number') v = String(v)
      if (typeof v !== 'string') { errors.push(`${k}: not a string`); continue }
      v = v.trim()
      if (spec.format === 'uri' && !/^https?:\/\/\S+$/i.test(v)) { errors.push(`${k}: not an address`); continue }
    }
    const allowed = spec.enum || (spec['x-enum-from'] ? enums[spec['x-enum-from']] || [] : null)
    if (allowed && !allowed.includes(v)) { errors.push(`${k}: '${v}' is not one of the listed ${spec['x-enum-from'] || 'values'}`); continue }
    args[k] = v
  }
  for (const k of schema?.required || []) if ((!only || only.includes(k)) && args[k] === undefined && !errors.some((e) => e.startsWith(`${k}:`))) errors.push(`${k}: missing`)
  return { ok: !errors.length, args, errors }
}

// The parameters a router function shows for a skill: the schema with the fact-backed enums filled in
// (only = the arguments shown at this stage)
export function toolParameters(schema, enums = {}, { only = null, extra = {}, extraRequired = [], describe = (k, d) => d } = {}) {
  const properties = {}
  for (const [k, spec] of Object.entries(schema?.properties || {})) {
    if (only && !only.includes(k)) continue
    const { 'x-enum-from': from, 'x-lang': _lang, ...rest } = spec
    const p = { ...rest, ...(rest.description ? { description: describe(k, rest.description, spec) } : {}) }
    if (from) {
      const list = enums[from] || []
      if (list.length) p.enum = list
    }
    properties[k] = p
  }
  Object.assign(properties, extra)
  const required = [...(schema?.required || []).filter((k) => properties[k] && !(only && !only.includes(k))), ...extraRequired]
  return { type: 'object', properties, required: [...new Set(required)] }
}
