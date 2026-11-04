// Tool arguments come from a model: checked here, with messages that say what to change.
import { ToolError } from './kernel.mjs'

export function known(args, tool, names) {
  for (const key of Object.keys(args)) if (!names.includes(key)) throw new ToolError(`${tool}: unknown argument "${key}" (it takes ${names.join(', ')})`)
}
export function number(value, name, { gt, ge, lt, optional, fallback } = {}) {
  if (value === undefined || value === null) {
    if (optional) return fallback
    throw new ToolError(`${name} is required`)
  }
  const n = Number(value)
  if (typeof value === 'boolean' || !Number.isFinite(n)) throw new ToolError(`${name} must be a number, got ${JSON.stringify(value)}`)
  if (gt !== undefined && !(n > gt)) throw new ToolError(`${name} must be greater than ${gt}, got ${n}`)
  if (ge !== undefined && !(n >= ge)) throw new ToolError(`${name} must be ${ge} or more, got ${n}`)
  if (lt !== undefined && !(n < lt)) throw new ToolError(`${name} must be less than ${lt}, got ${n}`)
  return n
}
export function vec3(value, name, fallback) {
  if (value === undefined || value === null) {
    if (fallback) return fallback
    throw new ToolError(`${name} is required`)
  }
  const list = Array.isArray(value) ? value : [value.x, value.y, value.z]
  if (list.length !== 3 || list.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new ToolError(`${name} must be [x, y, z] in numbers, got ${JSON.stringify(value)}`)
  return list
}
/** a drilling or cylinder direction: x, -x, y, -y, z, -z, or [dx, dy, dz] */
export function direction(value, name, fallback) {
  if (value === undefined || value === null) {
    if (fallback) return fallback
    throw new ToolError(`${name} is required`)
  }
  if (typeof value === 'string') {
    const m = /^([+-]?)([xyz])$/i.exec(value.trim())
    if (!m) throw new ToolError(`${name} must be x, -x, y, -y, z, -z or [dx, dy, dz], got "${value}"`)
    const sign = m[1] === '-' ? -1 : 1
    return ['x', 'y', 'z'].map((axis) => (axis === m[2].toLowerCase() ? sign : 0))
  }
  const list = vec3(value, name)
  const length = Math.hypot(...list)
  if (length < 1e-9) throw new ToolError(`${name} must not be a zero vector`)
  return list.map((v) => v / length)
}
export function text(value, name, { optional, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback
    throw new ToolError(`${name} is required`)
  }
  if (typeof value !== 'string') throw new ToolError(`${name} must be text, got ${JSON.stringify(value)}`)
  return value
}
