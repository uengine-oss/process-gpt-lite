// build_enclosure: a machined aluminium box (mm) and its lid. The closed box fills x 0..width,
// y 0..depth, z 0..height, the same coordinates server/lib/enclosureDrawing.js draws the 2D views in.
// (Inside this file the plan is centred on 0,0, which makes the arithmetic symmetric; input is converted
// on the way in and the finished parts are moved on the way out.) Everything is checked before the
// kernel sees it; afterwards the result is measured against the same arithmetic, because a boolean can
// succeed and still drop a piece.
import { ToolError } from './kernel.mjs'
import { known, number, text } from './args.mjs'

const CLEAR = 0.05 // standoffs may not touch a wall exactly: tangent contact is what booleans fail on
const THROUGH = 0.05 // how far a wall hole's tool reaches past the inner face
const OUT = 1 // and how far it starts outside the outer face
const SIDES = ['front', 'back', 'left', 'right']
const FACES = [...SIDES, 'bottom', 'top']
const circle = (diameter) => (Math.PI * diameter * diameter) / 4
const profile = (w, d, r) => w * d - (4 - Math.PI) * r * r

/** can a circle sit inside a rounded rectangle centred on the origin? */
function circleInRounded(x, y, diameter, width, depth, radius, margin) {
  const r = diameter / 2 + margin
  if (Math.abs(x) + r > width / 2 || Math.abs(y) + r > depth / 2) return false
  if (radius <= 0) return true
  const dx = Math.abs(x) - (width / 2 - radius)
  const dy = Math.abs(y) - (depth / 2 - radius)
  return dx <= 0 || dy <= 0 || Math.hypot(dx, dy) + r <= radius
}
function assertApart(list, label) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const [a, b] = [list[i], list[j]]
    if (Math.hypot(a.x - b.x, a.y - b.y) < (a.diameter + b.diameter) / 2 + CLEAR) throw new ToolError(`${label} ${a.at} and ${b.at} overlap: their centres are ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(2)} mm apart`)
  }
}

export function readEnclosure(args) {
  known(args, 'build_enclosure', ['name', 'width', 'depth', 'height', 'wall', 'corner_radius', 'lid_height', 'standoffs', 'holes', 'mount_ears'])
  const W = number(args.width, 'width', { gt: 0 })
  const D = number(args.depth, 'depth', { gt: 0 })
  const H = number(args.height, 'height', { gt: 0 })
  const t = number(args.wall, 'wall', { gt: 0 })
  const r = number(args.corner_radius, 'corner_radius', { ge: 0, optional: true, fallback: 0 })
  const lid = number(args.lid_height, 'lid_height', { gt: 0, optional: true, fallback: t })
  if (2 * t >= W || 2 * t >= D) throw new ToolError(`wall ${t} leaves no room inside: twice the wall must be less than width ${W} and depth ${D}`)
  if (2 * r >= Math.min(W, D)) throw new ToolError(`corner_radius ${r} is too large: it must be under half the smaller side (${Math.min(W, D) / 2})`)
  const bodyH = H - lid
  if (bodyH <= t) throw new ToolError(`height ${H} with lid_height ${lid} and floor ${t} leaves no cavity in the body: use a height over ${lid + t}`)
  const inner = { width: W - 2 * t, depth: D - 2 * t, radius: r > t ? r - t : 0 }
  if (r > 0 && r <= t) inner.radius = 0

  const cavitySpan = `x ${t} to ${W - t}, y ${t} to ${D - t}`
  const standoffs = (args.standoffs ?? []).map((s, i) => {
    const at = `standoffs[${i}]`
    known(s, at, ['x', 'y', 'diameter', 'height', 'hole_diameter'])
    const [userX, userY] = [number(s.x, `${at}.x`), number(s.y, `${at}.y`)]
    const out = { at, x: userX - W / 2, y: userY - D / 2, diameter: number(s.diameter, `${at}.diameter`, { gt: 0 }), height: number(s.height, `${at}.height`, { gt: 0 }), hole: number(s.hole_diameter, `${at}.hole_diameter`, { ge: 0, optional: true, fallback: 0 }) }
    if (out.hole >= out.diameter) throw new ToolError(`${at}: hole_diameter ${out.hole} must be smaller than its diameter ${out.diameter}`)
    if (!circleInRounded(out.x, out.y, out.diameter, inner.width, inner.depth, inner.radius, CLEAR)) throw new ToolError(`${at} at (${userX}, ${userY}) with diameter ${out.diameter} does not fit inside the cavity (${cavitySpan})`)
    if (out.height > bodyH - t) throw new ToolError(`${at}: height ${out.height} is taller than the cavity (${bodyH - t})`)
    return out
  })
  assertApart(standoffs, 'standoffs')

  const ears = readEars(args.mount_ears, { D, r, t, bodyH })
  const holes = (args.holes ?? []).map((h, i) => readHole(h, i, { W, D, H, t, r, bodyH, lid, inner, standoffs, ears, cavitySpan }))
  for (const face of FACES) assertApart(holes.filter((h) => h.face === face), `${face} holes`)
  return { name: text(args.name, 'name', { optional: true, fallback: 'enclosure' }), W, D, H, t, r, lid, bodyH, inner, standoffs, holes, ears }
}

function readEars(ears, { D, r, t, bodyH }) {
  if (ears === undefined || ears === null) return null
  known(ears, 'mount_ears', ['hole_diameter', 'length', 'width', 'thickness', 'per_side'])
  const hole = number(ears.hole_diameter, 'mount_ears.hole_diameter', { gt: 0 })
  const length = number(ears.length, 'mount_ears.length', { gt: 0, optional: true, fallback: hole * 2.5 })
  const width = number(ears.width, 'mount_ears.width', { gt: 0, optional: true, fallback: hole * 3 })
  const thickness = number(ears.thickness, 'mount_ears.thickness', { gt: 0, optional: true, fallback: t })
  const perSide = number(ears.per_side, 'mount_ears.per_side', { optional: true, fallback: 2 })
  if (perSide !== 1 && perSide !== 2) throw new ToolError(`mount_ears.per_side must be 1 or 2, got ${perSide}`)
  if (hole >= Math.min(length, width)) throw new ToolError(`mount_ears.hole_diameter ${hole} does not fit an ear of ${length} x ${width}`)
  if (thickness > bodyH) throw new ToolError(`mount_ears.thickness ${thickness} is taller than the body (${bodyH})`)
  const flat = D / 2 - r // the side wall is flat up to here; an ear on the rounded corner would not seat
  const ys = perSide === 1 ? [0] : [-(flat - width / 2), flat - width / 2]
  if (Math.abs(ys[0]) + width / 2 > flat + 1e-9) throw new ToolError(`mount_ears.width ${width} does not fit the flat part of the side wall (${2 * flat} long)`)
  if (perSide === 2 && 2 * (flat - width / 2) < width) throw new ToolError(`two mount ears ${width} wide do not fit on a side wall with ${2 * flat} of flat length; use per_side: 1 or a smaller width`)
  return { hole, length, width, thickness, ys }
}

function readHole(h, i, { W, D, H, t, r, bodyH, lid, inner, standoffs, ears, cavitySpan }) {
  const at = `holes[${i}]`
  known(h, at, ['face', 'x', 'y', 'diameter'])
  const face = text(h.face, `${at}.face`)
  if (!FACES.includes(face)) throw new ToolError(`${at}.face must be one of ${FACES.join(', ')}, got "${face}"`)
  const userX = number(h.x, `${at}.x`)
  const userY = number(h.y, `${at}.y`)
  const diameter = number(h.diameter, `${at}.diameter`, { gt: 0 })
  const radius = diameter / 2
  if (face === 'top' || face === 'bottom') {
    const [x, y] = [userX - W / 2, userY - D / 2]
    if (!circleInRounded(x, y, diameter, inner.width, inner.depth, inner.radius, 0)) throw new ToolError(`${at} on the ${face} at (${userX}, ${userY}) with diameter ${diameter} is not inside the cavity's outline (${cavitySpan}): a hole there would run into a wall`)
    if (face === 'bottom') {
      for (const s of standoffs) if (Math.hypot(s.x - x, s.y - y) < (s.diameter + diameter) / 2 + CLEAR) throw new ToolError(`${at} on the bottom overlaps ${s.at}`)
    }
    return { at, face, x, y, diameter, part: face === 'top' ? 'lid' : 'body' }
  }
  // side walls: x along the wall from its low end (0..width or 0..depth), y up from the bottom (world z)
  const along = face === 'front' || face === 'back' ? W : D
  const x = userX - along / 2
  if (userX - radius < r || userX + radius > along - r) throw new ToolError(`${at} on the ${face} at x=${userX} with diameter ${diameter} leaves the flat part of the wall (x from ${r} to ${along - r})`)
  const z = userY
  const inBody = z - radius >= t && z + radius <= bodyH
  const inLid = lid > t && z - radius >= bodyH && z + radius <= H - t
  if (!inBody && !inLid) {
    const reach = lid > t ? `the body wall (y from ${t + radius} to ${bodyH - radius}) or the lid's skirt (y from ${bodyH + radius} to ${H - t - radius})` : `the wall above the floor and below the lid (y from ${t + radius} to ${bodyH - radius})`
    throw new ToolError(`${at} on the ${face} at y=${z} with diameter ${diameter} does not fit ${reach}`)
  }
  if (ears && (face === 'left' || face === 'right') && inBody && z - radius < ears.thickness) {
    for (const yc of ears.ys) if (Math.abs(x - yc) < radius + ears.width / 2) throw new ToolError(`${at} on the ${face} runs into a mounting ear: move it above z=${ears.thickness} or along the wall`)
  }
  return { at, face, x, y: z, z, diameter, part: inBody ? 'body' : 'lid' }
}

const AXIS = { front: [0, 1, 0], back: [0, -1, 0], left: [1, 0, 0], right: [-1, 0, 0] }

/** a wall hole's tool: from just outside the face, through the wall, just past the inner face */
function wallTool(geo, hole, e) {
  const start = {
    front: [hole.x, -e.D / 2 - OUT, hole.z],
    back: [hole.x, e.D / 2 + OUT, hole.z],
    left: [-e.W / 2 - OUT, hole.x, hole.z],
    right: [e.W / 2 + OUT, hole.x, hole.z],
  }[hole.face]
  return geo.cylinder(start, AXIS[hole.face], hole.diameter, OUT + e.t + THROUGH)
}

function buildBody(geo, e) {
  const { W, D, t, r, bodyH, inner } = e
  const outer = geo.roundedBlock(W, D, 0, bodyH, r)
  const cavity = geo.roundedBlock(inner.width, inner.depth, t, bodyH - t + OUT, inner.radius)
  let body = geo.cut(outer, [cavity], 'hollowing the body')
  outer.delete()
  const step = (next) => { const old = body; body = next(old); old.delete() }
  if (e.standoffs.length) {
    // rooted half a wall into the floor, so the fuse has no coplanar faces to reason about
    const posts = e.standoffs.map((s) => geo.cylinder([s.x, s.y, t / 2], [0, 0, 1], s.diameter, t / 2 + s.height))
    step((b) => geo.fuse(b, posts, 'adding the standoffs'))
    const bores = e.standoffs.filter((s) => s.hole > 0).map((s) => geo.cylinder([s.x, s.y, t], [0, 0, 1], s.hole, s.height + OUT))
    if (bores.length) step((b) => geo.cut(b, bores, 'boring the standoffs'))
  }
  if (e.ears) {
    const { length, width, thickness, ys, hole } = e.ears
    const plates = []
    const bores = []
    for (const y of ys) for (const side of [-1, 1]) {
      // half a wall inside the wall, for the same reason
      const x0 = side > 0 ? W / 2 - t / 2 : -W / 2 - length
      plates.push(geo.box([x0, y - width / 2, 0], [length + t / 2, width, thickness]))
      bores.push(geo.cylinder([side * (W / 2 + length / 2), y, -OUT], [0, 0, 1], hole, thickness + 2 * OUT))
    }
    step((b) => geo.fuse(b, plates, 'adding the mounting ears'))
    step((b) => geo.cut(b, bores, 'drilling the mounting ears'))
  }
  const tools = e.holes.filter((h) => h.part === 'body').map((h) => (h.face === 'bottom' ? geo.cylinder([h.x, h.y, -OUT], [0, 0, 1], h.diameter, OUT + t + THROUGH) : wallTool(geo, h, e)))
  if (tools.length) step((b) => geo.cut(b, tools, 'cutting the holes'))
  step((b) => geo.unify(b))
  return body
}

function buildLid(geo, e) {
  const { W, D, H, t, r, lid, bodyH, inner } = e
  const top = lid > t ? t : lid
  let part = geo.roundedBlock(W, D, bodyH, lid, r)
  const step = (next) => { const old = part; part = next(old); old.delete() }
  if (lid > t) step((p) => geo.cut(p, [geo.roundedBlock(inner.width, inner.depth, bodyH - OUT, lid - t + OUT, inner.radius)], 'hollowing the lid'))
  const tools = e.holes.filter((h) => h.part === 'lid').map((h) => (h.face === 'top' ? geo.cylinder([h.x, h.y, H - top - THROUGH], [0, 0, 1], h.diameter, top + THROUGH + OUT) : wallTool(geo, h, e)))
  if (tools.length) step((p) => geo.cut(p, tools, 'cutting the lid holes'))
  step((p) => geo.unify(p))
  return part
}

function expectedVolumes(e) {
  const { W, D, H, t, r, lid, bodyH, inner } = e
  const outerArea = profile(W, D, r)
  const innerArea = profile(inner.width, inner.depth, inner.radius)
  let body = outerArea * t + (outerArea - innerArea) * (bodyH - t)
  for (const s of e.standoffs) body += (circle(s.diameter) - circle(s.hole)) * s.height
  if (e.ears) body += e.ears.ys.length * 2 * (e.ears.length * e.ears.width - circle(e.ears.hole)) * e.ears.thickness
  let lidVolume = lid > t ? outerArea * t + (outerArea - innerArea) * (lid - t) : outerArea * lid
  for (const h of e.holes) {
    const through = h.face === 'top' ? Math.min(lid, t) : t
    if (h.part === 'body') body -= circle(h.diameter) * through
    else lidVolume -= circle(h.diameter) * through
  }
  return { body, lid: lidVolume }
}

/** the two finished shapes, each checked to be one valid solid of the size it should be */
export function buildEnclosure(geo, e) {
  const expected = expectedVolumes(e)
  const built = []
  try {
    for (const [role, build] of [['body', buildBody], ['lid', buildLid]]) {
      const shape = build(geo, e)
      built.push(shape)
      const m = geo.stats(shape)
      if (m.solids !== 1 || !m.valid) throw new ToolError(`the ${role} did not come out as one valid solid (${m.solids} solids); try other corner_radius or hole positions`)
      if (Math.abs(m.volume - expected[role]) > 1e-3 * expected[role]) throw new ToolError(`the ${role} came out at ${m.volume.toFixed(1)} mm³ where ${expected[role].toFixed(1)} was expected, so a feature was lost; check for features that overlap`)
    }
    const moved = built.map((shape) => geo.placed(shape, [e.W / 2, e.D / 2, 0]))
    for (const shape of built) shape.delete()
    return { body: moved[0], lid: moved[1] }
  } catch (error) {
    for (const shape of built) shape.delete()
    throw error
  }
}
