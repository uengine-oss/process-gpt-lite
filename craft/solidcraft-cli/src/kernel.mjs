// The Chili3D WASM kernel (OCCT) in Node, and the shapes we build with it. The release build cannot
// catch C++ exceptions: an OCCT raise aborts the module, so what a tool must do after any kernel
// failure is start a new instance (Model.run does, from its BREP snapshots).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** a mistake the caller can act on; anything else out of the kernel means the instance is gone */
export class ToolError extends Error {}

function findWasmDir(given) {
  const candidates = [given, path.join(HERE, '../vendor/chili-wasm'), path.join(HERE, '../../../../artcraft/chili3d-src/packages/wasm/lib')].filter(Boolean)
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'chili-wasm.wasm')))
  if (!found) throw new Error(`the Chili3D WASM kernel is missing; run craft/solidcraft/build.sh (looked in ${candidates.join(', ')})`)
  return found
}

export class Kernel {
  constructor(wasmDir) { this.dir = findWasmDir(wasmDir) }

  async start() {
    const factory = (await import(pathToFileURL(path.join(this.dir, 'chili-wasm.js')).href)).default
    // the module is built for the web; given the bytes it does not need to fetch them
    this.binary ??= fs.readFileSync(path.join(this.dir, 'chili-wasm.wasm'))
    this.w = await factory({ wasmBinary: this.binary })
    return this
  }
}

const vec = ([x, y, z]) => ({ x, y, z })
const plane = (location) => ({ location: vec(location), direction: vec([0, 0, 1]), xDirection: vec([1, 0, 0]) })
const NEAR = 1e-6

export class Geometry {
  constructor(kernel) { this.kernel = kernel }
  get w() { return this.kernel.w }

  /** result.shape is a reference into the result: copy the handle before the result goes */
  take(result, what) {
    try {
      if (!result.isOk) throw new ToolError(`${what}: ${String(result.error || 'the kernel refused').trim().slice(0, 300)}`)
      return this.own(result.shape)
    } finally { result.delete() }
  }
  own(shape) {
    const { TopoDS, TopAbs_ShapeEnum: T } = this.w
    const cast = new Map([[T.TopAbs_SOLID, 'solid'], [T.TopAbs_COMPOUND, 'compound'], [T.TopAbs_COMPSOLID, 'compsolid'], [T.TopAbs_SHELL, 'shell'], [T.TopAbs_FACE, 'face'], [T.TopAbs_WIRE, 'wire'], [T.TopAbs_EDGE, 'edge'], [T.TopAbs_VERTEX, 'vertex']]).get(shape.shapeType())
    return cast ? TopoDS[cast](shape) : this.w.Shape.clone(shape)
  }

  /** box from its smallest corner */
  box(corner, size) { return this.take(this.w.ShapeFactory.box(plane(corner), size[0], size[1], size[2]), 'box') }
  cylinder(base, axis, diameter, height) { return this.take(this.w.ShapeFactory.cylinder(vec(axis), vec(base), diameter / 2, height), 'cylinder') }

  /** a x b x h block centred on x=y=0 with its vertical edges rounded */
  roundedBlock(width, depth, z0, height, radius) {
    const block = this.box([-width / 2, -depth / 2, z0], [width, depth, height])
    if (radius <= 0) return block
    try { return this.filletEdges(block, this.edgesWhere(block, 'vertical'), radius) } finally { block.delete() }
  }

  /** a - tools (all consumed); one solid comes back as that solid, not a compound of one */
  cut(shape, tools, what = 'cut') { return this.boolean('booleanCut', shape, tools, what) }
  fuse(shape, tools, what = 'fuse') { return this.boolean('booleanFuse', shape, tools, what) }
  boolean(method, shape, tools, what) {
    try { return this.single(this.take(this.w.ShapeFactory[method]([shape], tools), what)) } finally { for (const t of tools) t.delete() }
  }
  single(shape) {
    const solids = this.w.Shape.findSubShapes(shape, this.w.TopAbs_ShapeEnum.TopAbs_SOLID)
    if (solids.length !== 1) { for (const s of solids) s.delete(); return shape }
    shape.delete()
    return solids[0]
  }

  /** merge the coplanar faces a fuse leaves behind, if that changes nothing but the faces */
  unify(shape) {
    const merged = this.take(this.w.ShapeFactory.simplifyShape(shape, true, true, [], 1e-4, 1e-4), 'simplify')
    const before = this.w.Shape.volume(shape)
    if (this.w.Shape.check(merged) && Math.abs(this.w.Shape.volume(merged) - before) <= 1e-6 * Math.abs(before)) return this.single(merged)
    merged.delete()
    return this.own(shape)
  }

  filletEdges(shape, edges, radius) { return this.take(this.w.ShapeFactory.fillet(shape, edges, radius), 'fillet') }

  edges(shape) {
    const list = this.w.Shape.findSubShapes(shape, this.w.TopAbs_ShapeEnum.TopAbs_EDGE)
    const boxes = list.map((edge) => { const b = this.w.Shape.boundingBox(edge, false); edge.delete(); return b })
    return boxes
  }

  /** indices of the edges a word picks (fillet's "edges"): all, vertical, top, bottom */
  edgesWhere(shape, selector) {
    const boxes = this.edges(shape)
    const whole = this.w.Shape.boundingBox(shape, false)
    const flat = (b) => Math.abs(b.max.z - b.min.z) < NEAR
    const tests = {
      all: () => true,
      vertical: (b) => Math.abs(b.max.x - b.min.x) < NEAR && Math.abs(b.max.y - b.min.y) < NEAR && !flat(b),
      top: (b) => flat(b) && Math.abs(b.max.z - whole.max.z) < NEAR,
      bottom: (b) => flat(b) && Math.abs(b.min.z - whole.min.z) < NEAR,
    }
    const test = tests[selector]
    if (!test) throw new ToolError(`unknown edge selector "${selector}": use ${Object.keys(tests).join(', ')} or a list of edge numbers`)
    return boxes.flatMap((b, i) => (test(b) ? [i] : []))
  }

  /** rotate about the origin by degrees around X, then Y, then Z, then move */
  placed(shape, at = [0, 0, 0], rotate = [0, 0, 0]) {
    const [ax, ay, az] = rotate.map((deg) => (deg * Math.PI) / 180)
    const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)]
    const trsf = new this.w.gp_Trsf()
    try {
      trsf.setValues(
        cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, at[0],
        sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, at[1],
        -sy, cy * sx, cy * cx, at[2],
      )
      return this.w.Shape.transformed(shape, trsf)
    } finally { trsf.delete() }
  }

  /** rotated as in placed, then moved so the bounding box's underside is centred on "at" */
  seated(shape, at, rotate) {
    const turned = this.placed(shape, [0, 0, 0], rotate)
    try {
      const { min, max } = this.tightBox(turned)
      return this.placed(turned, [at[0] - (min.x + max.x) / 2, at[1] - (min.y + max.y) / 2, at[2] - min.z])
    } finally { turned.delete() }
  }

  /** every shape in a STEP/IGES node tree, with the first colour found */
  shapesIn(node) {
    const shapes = []
    let color = ''
    const visit = (n) => {
      const shape = n.shape
      if (shape && !shape.isNull()) { shapes.push(this.own(shape)); color ||= n.color || '' }
      const children = n.getChildren()
      for (const child of children) { visit(child); child.delete() }
    }
    visit(node)
    return { shapes, color }
  }

  combine(shapes) {
    if (shapes.length === 1) return shapes[0]
    try { return this.take(this.w.ShapeFactory.combine(shapes), 'combine') } finally { for (const s of shapes) s.delete() }
  }

  /** counts, volume and validity. A volume only where there are solids: surfaces enclose nothing */
  stats(shape) {
    const { Shape, TopAbs_ShapeEnum: T } = this.w
    const solids = Shape.findSubShapes(shape, T.TopAbs_SOLID)
    let volume = 0
    for (const solid of solids) { volume += Shape.volume(solid); solid.delete() }
    const faces = Shape.findSubShapes(shape, T.TopAbs_FACE)
    for (const face of faces) face.delete()
    const { min, max } = Shape.boundingBox(shape, false)
    return { min, max, volume, solids: solids.length, faces: faces.length, valid: Shape.check(shape) }
  }

  /** stats with a true bounding box (it meshes the shape, so take any BREP text first) */
  measure(shape) {
    return { ...this.stats(shape), ...this.tightBox(shape) }
  }

  /**
   * The kernel's box is exact on planes, cylinders and the like, but on a NURBS surface it is the hull
   * of the control points (3 mm too wide per side on surf114.igs). Mesh vertices lie on the surface.
   * So each side takes the kernel's value when the mesh reaches it, and the mesh's when it does not.
   */
  tightBox(shape) {
    const outer = this.w.Shape.boundingBox(shape, false)
    const axes = ['x', 'y', 'z']
    const deflection = Math.max(1e-4, 2e-4 * Math.hypot(...axes.map((k) => outer.max[k] - outer.min[k])))
    const mesher = new this.w.Mesher(shape, deflection, false)
    const data = mesher.mesh()
    const faces = data.faceMeshData
    const edges = data.edgeMeshData
    const low = { x: Infinity, y: Infinity, z: Infinity }
    const high = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (const position of [faces.position, edges.position]) {
      for (let i = 0; i + 2 < position.length; i += 3) {
        axes.forEach((k, a) => { const v = position[i + a]; if (v < low[k]) low[k] = v; if (v > high[k]) high[k] = v })
      }
    }
    for (const handle of [faces, edges, data, mesher]) handle.delete()
    if (low.x === Infinity) return { min: outer.min, max: outer.max }
    const pick = (kernel, mesh) => (Math.abs(kernel - mesh) <= 2 * deflection ? kernel : mesh)
    return {
      min: Object.fromEntries(axes.map((k) => [k, pick(outer.min[k], low[k])])),
      max: Object.fromEntries(axes.map((k) => [k, pick(outer.max[k], high[k])])),
    }
  }
}
