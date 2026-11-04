// One model per process: named parts, assembled without fusing. Every part keeps its last good BREP
// text outside the WASM heap, which is what lets a kernel abort leave the model as it was.
import fs from 'node:fs'
import path from 'node:path'
import { Geometry, Kernel, ToolError } from './kernel.mjs'
import { direction, known, number, text, vec3 } from './args.mjs'
import { buildEnclosure, readEnclosure } from './enclosure.mjs'

const ALUMINIUM = '#ccd1d6'
const STEEL = '#9aa5b1'
const IMPORTED = ['#d9a05b', '#6aa6d8', '#8cc084', '#c98bb9', '#e0c35a', '#7fc4c0']
const MAX_IMPORT = 256 * 1024 * 1024
const round = (n, digits = 4) => { const f = 10 ** digits; const r = Math.round(n * f) / f; return Object.is(r, -0) ? 0 : r }
const point = (p) => [round(p.x), round(p.y), round(p.z)]

export function formatOf(value, what) {
  const f = { step: 'step', stp: 'step', iges: 'iges', igs: 'iges' }[String(value || '').toLowerCase().replace(/^\./, '')]
  if (!f) throw new ToolError(`${what} must be .step or .iges, got "${value}"`)
  return f
}

export class Model {
  constructor({ wasmDir } = {}) {
    this.kernel = new Kernel(wasmDir)
    this.geo = new Geometry(this.kernel)
    this.name = 'Model'
    this.parts = []
    this.imported = 0
  }
  async start() { await this.kernel.start(); return this }

  /** run kernel work; a failure that is not a plain ToolError costs the instance, not the model */
  async run(what, work) {
    const before = [...this.parts]
    try {
      return await work()
    } catch (error) {
      this.parts = before
      if (error instanceof ToolError) throw error
      console.error(`[solidcraft] ${what}: the kernel failed, restarting it:`, error?.message || error)
      await this.restore()
      throw new ToolError(`${what} failed inside the geometry kernel, so nothing was changed. ${HINTS[what] || ''}`.trim())
    }
  }
  async restore() {
    await this.kernel.start()
    for (const part of this.parts) part.shape = this.kernel.w.Converter.convertFromBrep(part.brep)
  }

  part(name) {
    const part = this.parts.find((p) => p.name === name)
    if (!part) throw new ToolError(`no part named "${name}"; the model has ${this.parts.map((p) => p.name).join(', ') || 'no parts'}`)
    return part
  }
  uniqueName(base) {
    if (!this.parts.some((p) => p.name === base)) return base
    for (let i = 2; ; i++) if (!this.parts.some((p) => p.name === `${base}-${i}`)) return `${base}-${i}`
  }
  add(name, shape, color, note) {
    const part = { name: this.uniqueName(name), shape, brep: this.kernel.w.Converter.convertToBrep(shape), measured: this.geo.measure(shape), color, note }
    this.parts.push(part)
    return part
  }
  replace(part, shape) {
    const [brep, measured] = [this.kernel.w.Converter.convertToBrep(shape), this.geo.measure(shape)]
    part.shape.delete()
    Object.assign(part, { shape, brep, measured })
  }
  describe(part) {
    const m = part.measured
    const size = [m.max.x - m.min.x, m.max.y - m.min.y, m.max.z - m.min.z]
    const out = {
      name: part.name, bbox: { min: point(m.min), max: point(m.max), size: size.map((v) => round(v)) },
      volume_mm3: m.solids ? round(m.volume, 3) : null, solids: m.solids, faces: m.faces, valid: m.valid,
    }
    if (part.note) out.note = part.note
    return out
  }

  new(args) {
    known(args, 'new', ['name'])
    for (const part of this.parts) part.shape.delete()
    this.parts = []
    this.imported = 0
    this.name = text(args.name, 'name', { optional: true, fallback: 'Model' })
    return { model: this.name, parts: 0 }
  }

  async import(args, file) {
    known(args, 'import', ['path', 'at', 'center_xy', 'rotate', 'name'])
    const ext = path.extname(file).toLowerCase()
    const format = { '.step': 'step', '.stp': 'step', '.iges': 'iges', '.igs': 'iges' }[ext]
    if (!format) throw new ToolError(`${path.basename(file)}: only STEP (.step .stp) and IGES (.iges .igs) can be imported`)
    const at = vec3(args.at, 'at', [0, 0, 0])
    const rotate = vec3(args.rotate, 'rotate', [0, 0, 0])
    const stat = fs.statSync(file, { throwIfNoEntry: false })
    if (!stat?.isFile()) throw new ToolError(`no such file: ${path.basename(file)}`)
    if (stat.size > MAX_IMPORT) throw new ToolError(`${path.basename(file)} is ${Math.round(stat.size / 1048576)} MB; the limit is ${MAX_IMPORT / 1048576} MB`)
    const bytes = new Uint8Array(fs.readFileSync(file))
    const name = text(args.name, 'name', { optional: true, fallback: path.basename(file, path.extname(file)) })
    return this.run('import', () => {
      const { Converter } = this.kernel.w
      const node = format === 'step' ? Converter.convertFromStep(bytes) : Converter.convertFromIges(bytes)
      if (!node) throw new ToolError(`${path.basename(file)} could not be read as ${format.toUpperCase()}`)
      const { shapes, color } = this.geo.shapesIn(node)
      node.delete()
      if (!shapes.length) throw new ToolError(`${path.basename(file)} holds no geometry`)
      const whole = this.geo.combine(shapes)
      const placed = args.center_xy ? this.geo.seated(whole, at, rotate) : this.geo.placed(whole, at, rotate)
      whole.delete()
      const part = this.add(name, placed, color || IMPORTED[this.imported++ % IMPORTED.length], undefined)
      const described = this.describe(part)
      if (!described.solids) part.note = described.note = 'no solid in this file, only surfaces or curves (usual for IGES): it has no volume and cannot be cut'
      return described
    })
  }

  addBox(args) {
    known(args, 'add_box', ['name', 'size', 'at', 'center'])
    const size = vec3(args.size, 'size')
    if (size.some((v) => v <= 0)) throw new ToolError(`size must be positive, got ${JSON.stringify(size)}`)
    const at = vec3(args.at, 'at', [0, 0, 0])
    const corner = args.center ? at.map((v, i) => v - size[i] / 2) : at
    return this.run('add_box', () => this.describe(this.add(text(args.name, 'name', { optional: true, fallback: 'box' }), this.geo.box(corner, size), STEEL)))
  }

  addCylinder(args) {
    known(args, 'add_cylinder', ['name', 'diameter', 'height', 'at', 'axis'])
    const diameter = number(args.diameter, 'diameter', { gt: 0 })
    const height = number(args.height, 'height', { gt: 0 })
    const at = vec3(args.at, 'at', [0, 0, 0])
    const axis = direction(args.axis, 'axis', [0, 0, 1])
    return this.run('add_cylinder', () => this.describe(this.add(text(args.name, 'name', { optional: true, fallback: 'cylinder' }), this.geo.cylinder(at, axis, diameter, height), STEEL)))
  }

  cutHole(args) {
    known(args, 'cut_hole', ['part', 'at', 'axis', 'diameter', 'depth'])
    const part = this.part(text(args.part, 'part'))
    const at = vec3(args.at, 'at')
    const axis = direction(args.axis, 'axis')
    const diameter = number(args.diameter, 'diameter', { gt: 0 })
    const depth = number(args.depth, 'depth', { gt: 0, optional: true })
    return this.run('cut_hole', () => {
      const before = this.geo.stats(part.shape)
      if (!before.solids) throw new ToolError(`${part.name} is surfaces only (no solid), so a hole cannot be cut in it`)
      // through-all reaches past the far side of the part whichever way it runs
      const span = Math.hypot(before.max.x - before.min.x, before.max.y - before.min.y, before.max.z - before.min.z)
      const farthest = Math.hypot(...['x', 'y', 'z'].map((k, i) => Math.max(Math.abs(before.max[k] - at[i]), Math.abs(before.min[k] - at[i]))))
      const lead = 1 + 1e-3 * span
      const start = at.map((v, i) => v - axis[i] * lead)
      const tool = this.geo.cylinder(start, axis, diameter, lead + (depth ?? farthest + 1))
      const cut = this.geo.cut(part.shape, [tool], `the hole in ${part.name}`)
      const after = this.geo.stats(cut)
      const removed = before.volume - after.volume
      if (!after.valid || after.solids < 1 || removed <= 1e-9 * before.volume) {
        cut.delete()
        throw new ToolError(removed <= 1e-9 * before.volume ? `the hole at ${JSON.stringify(at)} along ${JSON.stringify(axis)} does not touch ${part.name}; its bounding box is ${JSON.stringify(point(before.min))} to ${JSON.stringify(point(before.max))}` : `cutting that hole left ${part.name} broken, so it was not applied`)
      }
      this.replace(part, cut)
      return { ...this.describe(part), removed_mm3: round(removed, 3) }
    })
  }

  fillet(args) {
    known(args, 'fillet', ['part', 'radius', 'edges'])
    const part = this.part(text(args.part, 'part'))
    const radius = number(args.radius, 'radius', { gt: 0 })
    return this.run('fillet', () => {
      const before = this.geo.stats(part.shape)
      if (!before.solids) throw new ToolError(`${part.name} is surfaces only (no solid), so it cannot be filleted`)
      const edges = Array.isArray(args.edges) ? args.edges : this.geo.edgesWhere(part.shape, args.edges ?? 'all')
      const count = this.geo.edges(part.shape).length
      if (!edges.length) throw new ToolError(`no edges of ${part.name} match "${args.edges}"`)
      for (const e of edges) if (!Number.isInteger(e) || e < 0 || e >= count) throw new ToolError(`edge ${JSON.stringify(e)} does not exist: ${part.name} has edges 0 to ${count - 1}`)
      const rounded = this.geo.filletEdges(part.shape, edges, radius)
      const after = this.geo.stats(rounded)
      if (!after.valid || after.solids !== before.solids) {
        rounded.delete()
        throw new ToolError(`a fillet of ${radius} mm left ${part.name} broken, so it was not applied; try a smaller radius`)
      }
      this.replace(part, rounded)
      return { ...this.describe(part), edges_filleted: edges.length }
    })
  }

  buildEnclosure(args) {
    const e = readEnclosure(args)
    return this.run('build_enclosure', () => {
      const { body, lid } = buildEnclosure(this.geo, e)
      const parts = [this.add(`${e.name}_body`, body, ALUMINIUM), this.add(`${e.name}_lid`, lid, ALUMINIUM)]
      return { units: 'mm', origin: 'the closed box fills x 0..width, y 0..depth, z 0..height', parts: parts.map((p) => this.describe(p)) }
    })
  }

  async inspect(args = {}) {
    known(args, 'inspect', ['edges_of'])
    if (!this.parts.length) return { model: this.name, parts: [], total: null }
    const edges = args.edges_of === undefined ? undefined : await this.run('inspect', () => this.geo.edges(this.part(text(args.edges_of, 'edges_of')).shape).map((box, index) => ({ index, min: point(box.min), max: point(box.max) })))
    const parts = this.parts.map((p) => this.describe(p))
    const min = [0, 1, 2].map((i) => Math.min(...parts.map((p) => p.bbox.min[i])))
    const max = [0, 1, 2].map((i) => Math.max(...parts.map((p) => p.bbox.max[i])))
    const sum = (key) => parts.reduce((total, p) => total + (p[key] || 0), 0)
    return {
      model: this.name, units: 'mm', parts,
      total: { bbox: { min, max, size: max.map((v, i) => round(v - min[i])) }, volume_mm3: round(sum('volume_mm3'), 3), solids: sum('solids'), faces: sum('faces') },
      ...(edges ? { edges } : {}),
    }
  }

  export(format) {
    if (!this.parts.length) throw new ToolError('the model is empty: nothing to export')
    return this.run('export', () => {
      const { Converter } = this.kernel.w
      const shapes = this.parts.map((p) => p.shape)
      return format === 'step' ? Converter.convertToStep(shapes) : Converter.convertToIges(shapes)
    })
  }
}

const HINTS = {
  fillet: 'This usually means the radius is too large for the faces next to those edges; try a smaller radius or fewer edges.',
  cut_hole: 'Check the hole\'s size and position.',
  import: 'The file may be damaged or use an entity the reader does not support.',
  build_enclosure: 'Try a smaller corner_radius, or move features away from walls and each other.',
}
