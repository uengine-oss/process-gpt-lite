// solidcraft-cli end to end: a real MCP client over stdio, and an independent witness for the geometry
// (craft/solidcraft/test/check_geometry.py, cadquery-ocp). Expected numbers below are worked by hand from
// the drawing, not by asking the code under test.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(HERE, '../bin/solidcraft-cli')
const SOLIDCRAFT = path.join(HERE, '../../solidcraft/test')
const PYTHON = path.join(SOLIDCRAFT, '.venv/bin/python')
const CHECK = path.join(SOLIDCRAFT, 'check_geometry.py')
const FIXTURES = path.join(SOLIDCRAFT, 'fixtures')
const OUT = process.env.SOLIDCRAFT_TEST_OUT || path.join(SOLIDCRAFT, 'out')

const PI = Math.PI
// the brief's bar is 1%, but the smallest feature here (a 5 mm hole) is 0.08% of the body: at 1% it could go missing unnoticed
const TIGHT = 1e-4
const circle = (d) => (PI * d * d) / 4
// a plan outline with four corners rounded at r loses (4 - pi) r^2 from its rectangle
const outline = (w, d, r) => w * d - (4 - PI) * r * r

// the drawing: 120 x 80 x 40 aluminium box, 2.5 walls, R6 corners, a flat 2.5 lid
const ENCLOSURE = {
  width: 120, depth: 80, height: 40, wall: 2.5, corner_radius: 6, lid_height: 2.5,
  standoffs: [[20, 20], [100, 20], [20, 60], [100, 60]].map(([x, y]) => ({ x, y, diameter: 6, height: 8, hole_diameter: 2.5 })),
  holes: [
    { face: 'front', x: 30, y: 20, diameter: 12 },
    { face: 'back', x: 80, y: 15, diameter: 8 },
    { face: 'right', x: 40, y: 20, diameter: 10 },
    { face: 'bottom', x: 60, y: 40, diameter: 5 },
    { face: 'top', x: 70, y: 50, diameter: 7 },
  ],
  mount_ears: { hole_diameter: 4.5 }, // defaults: 11.25 long, 13.5 wide, 2.5 thick, 2 per side
}
const OUTER = outline(120, 80, 6) // 9569.097
const CAVITY = outline(115, 75, 3.5) // inner radius = 6 - 2.5; 8614.484
const BODY_VOLUME = OUTER * 2.5 // floor
  + (OUTER - CAVITY) * (37.5 - 2.5) // the ring of wall above the floor; the body is 40 - 2.5 tall
  + 4 * (circle(6) - circle(2.5)) * 8 // standoffs, bored for their full height
  + 4 * (11.25 * 13.5 - circle(4.5)) * 2.5 // ears, each with its hole
  - (circle(12) + circle(8) + circle(10) + circle(5)) * 2.5 // front, back, right and bottom holes through 2.5
const LID_VOLUME = OUTER * 2.5 - circle(7) * 2.5 // the plate with its one hole
// the closed box fills x 0..120, y 0..80, z 0..40; the 11.25 ears stick out of both side walls
const BODY_MIN = [-11.25, 0, 0]
const BODY_MAX = [131.25, 80, 37.5]
const ALL_MAX = [131.25, 80, 40]
const CAP = { x: 60, y: 60, z: 2.5 } // where the capacitor goes: on the floor, 2.5 up

let client
let work
let readRoot
let writeRoot
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'solidcraft-outside-'))

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  return { ...result, text, data: result.isError ? null : JSON.parse(text) }
}
async function ok(name, args) {
  const result = await call(name, args)
  assert.ok(!result.isError, `${name} failed: ${result.text}`)
  return result.data
}
async function refused(name, args, pattern) {
  const result = await call(name, args)
  assert.ok(result.isError, `${name} should have failed: ${result.text}`)
  assert.match(result.text, pattern)
  return result.text
}
const witness = (file) => JSON.parse(execFileSync(PYTHON, [CHECK, file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected}, got ${actual}`)
const within = (actual, expected, share, what) => assert.ok(Math.abs(actual - expected) <= share * Math.abs(expected), `${what}: expected ${expected}, got ${actual} (${((100 * (actual - expected)) / expected).toFixed(3)}%)`)
const nearBox = (actual, min, max, tolerance, what) => { for (let i = 0; i < 3; i++) { near(actual.min[i], min[i], tolerance, `${what} min[${i}]`); near(actual.max[i], max[i], tolerance, `${what} max[${i}]`) } }

function decodePng(file) {
  const bytes = fs.readFileSync(file)
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG', `${file} is not a PNG`)
  const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  const [depth, colorType] = [bytes[24], bytes[25]]
  assert.equal(depth, 8)
  const channels = { 2: 3, 6: 4 }[colorType]
  const idat = []
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at)
    if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y ? pixels[(y - 1) * stride + x] : 0
      const corner = x >= channels && y ? pixels[(y - 1) * stride + x - channels] : 0
      const p = left + up - corner
      const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)]
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner
      pixels[y * stride + x] = (value + [0, left, up, (left + up) >> 1, paeth][filter]) & 255
    }
  }
  return { width, height, channels, pixels }
}
/** brightness variance over a sparse grid: a blank picture has none */
function varianceOf({ width, height, channels, pixels }) {
  const samples = []
  for (let y = 5; y < height; y += 10) for (let x = 5; x < width; x += 10) {
    const at = (y * width + x) * channels
    samples.push((pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3)
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  return samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length
}

before(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'solidcraft-test-'))
  readRoot = path.join(work, 'read')
  writeRoot = path.join(work, 'write')
  fs.mkdirSync(readRoot)
  fs.mkdirSync(writeRoot)
  for (const file of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, file), path.join(readRoot, file))
  fs.writeFileSync(path.join(readRoot, 'broken.step'), 'this is not a STEP file\n')
  fs.writeFileSync(path.join(outside, 'secret.step'), fs.readFileSync(path.join(FIXTURES, 'C_0603_1608Metric.step')))
  fs.symlinkSync(outside, path.join(readRoot, 'link'))
  fs.symlinkSync(outside, path.join(writeRoot, 'link'))
  client = new Client({ name: 'solidcraft-test', version: '1.0.0' })
  // as craft.js starts it with roots: true
  await client.connect(new StdioClientTransport({ command: BIN, args: ['mcp', '--automation-read-root', readRoot, '--automation-write-root', writeRoot], stderr: 'ignore' }))
})
after(async () => {
  await client?.close()
  fs.rmSync(work, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

test('lists the tools under their bare names (craft.js adds solidcraft_)', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['add_box', 'add_cylinder', 'build_enclosure', 'cut_hole', 'export', 'fillet', 'import', 'inspect', 'new', 'render'])
})

test('builds the enclosure and places the 1608 capacitor; inspect reports the drawing', async () => {
  await ok('new', { name: 'controller' })
  const built = await ok('build_enclosure', ENCLOSURE)
  assert.deepEqual(built.parts.map((p) => p.name), ['enclosure_body', 'enclosure_lid'])
  const placed = await ok('import', { path: path.join(readRoot, 'C_0603_1608Metric.step'), at: [CAP.x, CAP.y, CAP.z], name: 'C1' })
  assert.equal(placed.solids, 1)
  const model = await ok('inspect')
  assert.deepEqual(model.parts.map((p) => p.name), ['enclosure_body', 'enclosure_lid', 'C1'], 'the capacitor is a child, not fused')
  const [body, lid, cap] = model.parts
  within(body.volume_mm3, BODY_VOLUME, TIGHT, 'body volume')
  within(lid.volume_mm3, LID_VOLUME, TIGHT, 'lid volume')
  nearBox(body.bbox, BODY_MIN, BODY_MAX, 1e-3, 'body')
  nearBox(lid.bbox, [0, 0, 37.5], [120, 80, 40], 1e-3, 'lid')
  assert.deepEqual([body.solids, lid.solids, cap.solids], [1, 1, 1])
  assert.ok(body.faces > 40 && body.valid && lid.valid)
  near(cap.bbox.size[0], 1.6, 0.01, 'capacitor length')
  near(cap.bbox.size[1], 0.8, 0.01, 'capacitor width')
  nearBox(cap.bbox, [59.2, 59.6, 2.5], [60.8, 60.4, 3.3], 0.01, 'capacitor in place')
  nearBox(model.total.bbox, BODY_MIN, ALL_MAX, 1e-3, 'total')
  within(model.total.volume_mm3, BODY_VOLUME + LID_VOLUME + cap.volume_mm3, 1e-6, 'total volume')
  assert.equal(model.total.solids, 3)
})

test('the exported STEP has the drawing\'s solids, by an independent reader', async () => {
  const file = path.join(writeRoot, 'controller.step')
  await ok('export', { path: file, format: '.step' })
  const seen = witness(file)
  console.log(`  STEP witness: body ${seen.per_solid[0].volume.toFixed(3)} (hand ${BODY_VOLUME.toFixed(3)}), lid ${seen.per_solid[1].volume.toFixed(3)} (hand ${LID_VOLUME.toFixed(3)}), capacitor bbox ${seen.per_solid[2].bbox.size.map((v) => v.toFixed(3)).join(' x ')}`)
  fs.copyFileSync(file, path.join(OUT, 'controller.step'))
  assert.equal(seen.solids, 3)
  within(seen.per_solid[0].volume, BODY_VOLUME, TIGHT, 'witness body volume')
  within(seen.per_solid[1].volume, LID_VOLUME, TIGHT, 'witness lid volume')
  assert.ok(seen.per_solid.every((s) => s.valid), 'every solid valid')
  nearBox(seen.per_solid[0].bbox, BODY_MIN, BODY_MAX, 1e-3, 'witness body')
  nearBox(seen.per_solid[1].bbox, [0, 0, 37.5], [120, 80, 40], 1e-3, 'witness lid')
  nearBox(seen.bbox, BODY_MIN, ALL_MAX, 1e-3, 'witness total')
  // the real part: 1.6 x 0.8 nominal, sitting on the floor where we put it
  const cap = seen.per_solid[2]
  near(cap.bbox.size[0], 1.6, 0.01, 'witness capacitor length')
  near(cap.bbox.size[1], 0.8, 0.01, 'witness capacitor width')
  near(cap.bbox.min[2], 2.5, 1e-3, 'witness capacitor on the floor')
  near((cap.bbox.min[0] + cap.bbox.max[0]) / 2, CAP.x, 1e-3, 'witness capacitor x')
  near((cap.bbox.min[1] + cap.bbox.max[1]) / 2, CAP.y, 1e-3, 'witness capacitor y')
})

test('the exported IGES has surfaces and no solids, by an independent reader', async () => {
  const file = path.join(writeRoot, 'controller.iges')
  await ok('export', { path: file, format: '.iges' })
  const seen = witness(file)
  console.log(`  IGES witness: solids ${seen.solids}, faces ${seen.faces}, bbox ${seen.bbox.size.map((v) => v.toFixed(3)).join(' x ')}`)
  assert.equal(seen.solids, 0, 'IGES carries no solids')
  const { total } = await ok('inspect')
  assert.equal(seen.faces, total.faces, 'every face of the model is there as a surface')
  nearBox(seen.bbox, BODY_MIN, ALL_MAX, 1e-3, 'IGES bbox')
})

test('both exports come back in: STEP as solids, IGES as surfaces', async () => {
  const { total } = await ok('inspect')
  await ok('new', { name: 'again' })
  const step = await ok('import', { path: path.relative(readRoot, path.join(readRoot, 'C_0603_1608Metric.step')), name: 'relative path works' })
  assert.equal(step.solids, 1)
  await ok('new', { name: 'again' })
  // the write root is not the read root, so these reads go through a second server
  const reader = new Client({ name: 'solidcraft-test-2', version: '1.0.0' })
  await reader.connect(new StdioClientTransport({ command: BIN, args: ['mcp', '--automation-read-root', writeRoot, '--automation-write-root', writeRoot], stderr: 'ignore' }))
  const read = async (name, args) => {
    const result = await reader.callTool({ name, arguments: args })
    assert.ok(!result.isError, result.content[0].text)
    return JSON.parse(result.content[0].text)
  }
  try {
    const fromStep = await read('import', { path: path.join(writeRoot, 'controller.step') })
    assert.equal(fromStep.solids, 3)
    within(fromStep.volume_mm3, total.volume_mm3, 1e-4, 're-imported STEP volume')
    const fromIges = await read('import', { path: path.join(writeRoot, 'controller.iges') })
    assert.equal(fromIges.solids, 0)
    assert.equal(fromIges.volume_mm3, null)
    assert.equal(fromIges.faces, total.faces)
    assert.match(fromIges.note, /no solid/)
    nearBox(fromIges.bbox, BODY_MIN, ALL_MAX, 1e-2, 're-imported IGES bbox')
  } finally { await reader.close() }
})

test('primitives, holes and fillets match their formulas', async () => {
  await ok('new', { name: 'blocks' })
  const box = await ok('add_box', { name: 'block', size: [20, 20, 10] })
  near(box.volume_mm3, 4000, 1e-6, 'box')
  const through = await ok('cut_hole', { part: 'block', at: [10, 10, 10], axis: '-z', diameter: 4 })
  within(through.volume_mm3, 4000 - circle(4) * 10, 1e-6, 'through hole')
  const blind = await ok('cut_hole', { part: 'block', at: [5, 5, 10], axis: '-z', diameter: 2, depth: 3 })
  within(blind.volume_mm3, 4000 - circle(4) * 10 - circle(2) * 3, 1e-6, 'blind hole')
  const cylinder = await ok('add_cylinder', { name: 'pin', diameter: 4, height: 30, at: [0, 0, 50], axis: 'x' })
  within(cylinder.volume_mm3, circle(4) * 30, 1e-6, 'cylinder')
  nearBox(cylinder.bbox, [0, -2, 48], [30, 2, 52], 1e-3, 'cylinder along x')
  // four top edges of a 20 x 20 x 10 at R2: (1 - pi/4) R^2 along each straight run, R^3/3 at each corner
  await ok('add_box', { name: 'rounded', size: [20, 20, 10] })
  const rounded = await ok('fillet', { part: 'rounded', radius: 2, edges: 'top' })
  assert.equal(rounded.edges_filleted, 4)
  within(rounded.volume_mm3, 4000 - ((1 - PI / 4) * 4 * 4 * 16 + (4 * 8) / 3), 1e-3, 'top fillet')
  // rotated about Z the 1.6 long side lies along Y
  const turned = await ok('import', { path: path.join(readRoot, 'C_0603_1608Metric.step'), rotate: [0, 0, 90], at: [5, 5, 0] })
  nearBox(turned.bbox, [4.6, 4.2, 0], [5.4, 5.8, 0.8], 0.01, 'rotated then moved')
})

test('a bounding box on free-form surfaces agrees with the independent reader', async () => {
  await ok('new', { name: 'surfaces' })
  const surf = await ok('import', { path: path.join(readRoot, 'surf114.igs') })
  const seen = witness(path.join(readRoot, 'surf114.igs'))
  assert.equal(surf.faces, seen.faces)
  assert.equal(seen.solids, 0)
  for (let i = 0; i < 3; i++) within(surf.bbox.size[i], seen.bbox.size[i], 0.01, `surf114 size[${i}]`)
  await ok('new', { name: 'part' })
  const part = await ok('import', { path: path.join(readRoot, 'sample_part.stp') })
  const partSeen = witness(path.join(readRoot, 'sample_part.stp'))
  within(part.volume_mm3, partSeen.volume, 1e-3, 'sample_part volume')
  assert.equal(part.faces, partSeen.faces)
})

test('a nested assembly from another writer lands where its locations say', async () => {
  // top: a 10 x 20 x 30 box at z 100, and a sub-assembly at x 100 turned 90 degrees about Z, which holds
  // the same box at its origin and at x 50. Turned, a box covers x -20..0, y 0..10 (and y 50..60 for the second).
  await ok('new', { name: 'nested' })
  const part = await ok('import', { path: path.join(readRoot, 'nested_assembly.step') })
  assert.equal(part.solids, 3)
  near(part.volume_mm3, 3 * 10 * 20 * 30, 1e-6, 'three boxes')
  nearBox(part.bbox, [0, 0, 0], [100, 60, 130], 1e-3, 'the whole assembly')
  const file = path.join(writeRoot, 'nested.step')
  await ok('export', { path: file })
  const boxes = witness(file).per_solid.map((s) => s.bbox)
  nearBox(boxes[0], [80, 0, 0], [100, 10, 30], 1e-3, 'first box of the turned sub-assembly')
  nearBox(boxes[1], [80, 50, 0], [100, 60, 30], 1e-3, 'second box of the turned sub-assembly')
  nearBox(boxes[2], [0, 0, 100], [10, 20, 130], 1e-3, 'the box at the top level')
})

test('fillet by edge number, from inspect\'s list', async () => {
  await ok('new', { name: 'edges' })
  await ok('add_box', { name: 'block', size: [20, 20, 10] })
  const { edges } = await ok('inspect', { edges_of: 'block' })
  assert.equal(edges.length, 12)
  const vertical = edges.find((e) => e.min[0] === 0 && e.max[0] === 0 && e.min[1] === 0 && e.max[1] === 0 && e.max[2] === 10)
  const one = await ok('fillet', { part: 'block', radius: 2, edges: [vertical.index] })
  within(one.volume_mm3, 4000 - (1 - PI / 4) * 4 * 10, 1e-3, 'one rounded edge')
  await refused('fillet', { part: 'block', radius: 1, edges: [99] }, /edge 99 does not exist/)
})

test('render draws the model on a light background, one picture per view', async () => {
  await ok('new', { name: 'controller' })
  await ok('build_enclosure', ENCLOSURE)
  await ok('import', { path: path.join(readRoot, 'C_0603_1608Metric.step'), at: [CAP.x, CAP.y, CAP.z], name: 'C1' })
  const pictures = {}
  for (const [name, args] of Object.entries({ iso: { view: 'iso' }, 'iso-open': { view: 'iso', hide: ['enclosure_lid'] }, front: { view: 'front' }, top: { view: 'top', hide: ['enclosure_lid'] }, right: { view: 'right' } })) {
    const file = path.join(writeRoot, `${name}.png`)
    const result = await client.callTool({ name: 'render', arguments: { path: file, ...args } })
    assert.ok(!result.isError, result.content[0].text)
    assert.ok(result.content.some((c) => c.type === 'image' && c.mimeType === 'image/png' && c.data.length > 1000), 'the picture comes back too')
    const png = decodePng(file)
    assert.deepEqual([png.width, png.height], [1600, 1000])
    assert.ok(varianceOf(png) > 200, `${name} is blank: variance ${varianceOf(png)}`)
    const [r, g, b] = png.pixels.subarray(0, 3)
    assert.ok(r > 225 && g > 225 && b > 225, `${name} has a light background, its corner is ${r},${g},${b}`)
    pictures[name] = png.pixels
    fs.copyFileSync(file, path.join(OUT, `${name}.png`))
  }
  assert.ok(!pictures.iso.equals(pictures.top) && !pictures.iso.equals(pictures.front) && !pictures.top.equals(pictures.right) && !pictures.iso.equals(pictures['iso-open']), 'views differ')
  await refused('render', { path: path.join(writeRoot, 'x.png'), view: 'sideways' }, /view must be/)
  await refused('render', { path: path.join(writeRoot, 'x.png'), hide: ['no such part'] }, /no part named/)
  await refused('render', { path: path.join(writeRoot, 'x.jpg') }, /\.png/)
})

test('paths outside the roots are refused and nothing is written there', async () => {
  await ok('new', { name: 'paths' })
  await ok('add_box', { size: [1, 1, 1] })
  const stray = path.join(outside, 'stray')
  await refused('export', { path: `${stray}.step`, format: '.step' }, /outside the allowed write/)
  await refused('export', { path: path.join(writeRoot, '..', 'up.step'), format: '.step' }, /outside the allowed write/)
  await refused('export', { path: '../up-relative.step' }, /outside the allowed write/)
  await refused('export', { path: path.join(writeRoot, 'link', 'through-symlink.step') }, /outside the allowed write/)
  await refused('render', { path: `${stray}.png` }, /outside the allowed write/)
  await refused('import', { path: path.join(outside, 'secret.step') }, /outside the allowed read/)
  await refused('import', { path: path.join(readRoot, '..', 'write', 'x.step') }, /outside the allowed read/)
  await refused('import', { path: path.join(readRoot, 'link', 'secret.step') }, /outside the allowed read/)
  assert.deepEqual(fs.readdirSync(outside), ['secret.step'])
  assert.ok(!fs.existsSync(path.join(work, 'up.step')) && !fs.existsSync(path.join(work, 'up-relative.step')))
  // and inside the root a new subfolder is fine
  await ok('export', { path: path.join(writeRoot, 'sub/folder/box.step') })
  assert.ok(fs.existsSync(path.join(writeRoot, 'sub/folder/box.step')))
  await refused('export', { path: path.join(writeRoot, 'box.step'), format: '.iges' }, /says \.step/)
  await refused('export', { path: path.join(writeRoot, 'box.obj') }, /must be \.step or \.iges/)
})

test('geometry errors say what to change and leave the model as it was', async () => {
  await ok('new', { name: 'errors' })
  await ok('add_box', { name: 'block', size: [10, 10, 10] })
  const before = await ok('inspect')
  const base = { width: 50, depth: 40, height: 30, wall: 2 }
  await refused('build_enclosure', { ...base, wall: 25 }, /wall 25 leaves no room/)
  await refused('build_enclosure', { ...base, corner_radius: 30 }, /corner_radius 30 is too large/)
  await refused('build_enclosure', { ...base, lid_height: 29 }, /leaves no cavity/)
  await refused('build_enclosure', { ...base, standoffs: [{ x: 55, y: 20, diameter: 5, height: 5 }] }, /standoffs\[0\].*does not fit inside the cavity/)
  await refused('build_enclosure', { ...base, standoffs: [{ x: 25, y: 20, diameter: 5, height: 50 }] }, /taller than the cavity/)
  await refused('build_enclosure', { ...base, standoffs: [{ x: 25, y: 20, diameter: 5, height: 5, hole_diameter: 6 }] }, /must be smaller than its diameter/)
  await refused('build_enclosure', { ...base, standoffs: [{ x: 25, y: 20, diameter: 5, height: 5 }, { x: 27, y: 20, diameter: 5, height: 5 }] }, /overlap/)
  await refused('build_enclosure', { ...base, holes: [{ face: 'front', x: 49, y: 15, diameter: 6 }] }, /leaves the flat part/)
  await refused('build_enclosure', { ...base, holes: [{ face: 'front', x: 25, y: 29, diameter: 6 }] }, /does not fit/)
  await refused('build_enclosure', { ...base, holes: [{ face: 'side', x: 25, y: 15, diameter: 6 }] }, /face must be one of/)
  await refused('build_enclosure', { ...base, mount_ears: { hole_diameter: 30 } }, /two mount ears|does not fit/)
  await refused('build_enclosure', { ...base, colour: 'red' }, /unknown argument "colour"/)
  await refused('build_enclosure', { ...base, width: 'wide' }, /width must be a number/)
  await refused('add_box', { size: [1, -1, 1] }, /size must be positive/)
  await refused('cut_hole', { part: 'nothing', at: [0, 0, 0], axis: 'z', diameter: 1 }, /no part named "nothing"/)
  await refused('cut_hole', { part: 'block', at: [100, 100, 100], axis: 'z', diameter: 1 }, /does not touch block/)
  await refused('import', { path: path.join(readRoot, 'broken.step') }, /could not be read as STEP/)
  await refused('import', { path: path.join(readRoot, 'missing.step') }, /no such file/)
  await refused('import', { path: path.join(readRoot, 'broken.txt') }, /only STEP/)
  await refused('no_such_tool', {}, /no tool named/)
  assert.deepEqual(await ok('inspect'), before, 'nothing changed')

  // this one takes the kernel down (an OCCT raise aborts the WASM module): the model must survive it
  await refused('fillet', { part: 'block', radius: 50 }, /nothing was changed/)
  assert.deepEqual(await ok('inspect'), before, 'the abort changed nothing')
  const file = path.join(writeRoot, 'after-abort.step')
  await ok('export', { path: file })
  within(witness(file).volume, 1000, 1e-6, 'the part is really still there after the abort')
  const after = await ok('fillet', { part: 'block', radius: 1, edges: 'vertical' })
  within(after.volume_mm3, 1000 - (1 - PI / 4) * 1 * 4 * 10, 1e-3, 'and the kernel still works')
})

test('the calls server/lib/prototypeDrafts.js makes, with its corner-origin spec, work and land where it means', async () => {
  // normalizeSpec's output for a 90 x 60 x 30 box, wall 2, 4 bosses 6/5/2.5, a 12 front hole; inset = 2 + 3 + 3 = 8
  const [W, D, H, wall, inset] = [90, 60, 30, 2, 8]
  const standoffs = [[inset, inset], [W - inset, inset], [inset, D - inset], [W - inset, D - inset]].map(([x, y]) => ({ x, y, diameter: 6, height: 5, hole_diameter: 2.5 }))
  await ok('new', { name: '시작품 HS-200' })
  const built = await ok('build_enclosure', { width: W, depth: D, height: H, wall, corner_radius: 0, standoffs, holes: [{ face: 'front', x: W / 2, y: H / 2, diameter: 12 }] })
  nearBox(built.parts[0].bbox, [0, 0, 0], [W, D, H - wall], 1e-3, 'body')
  const z = wall + 5 // the top of the bosses
  const part = await ok('import', { path: path.join(readRoot, 'C_0603_1608Metric.step'), at: [W / 2, D / 2, z], name: 'C_0603_1608Metric.step', center_xy: true })
  nearBox(part.bbox, [W / 2 - 0.8, D / 2 - 0.4, z], [W / 2 + 0.8, D / 2 + 0.4, z + 0.8], 0.01, 'seated on the bosses, centred')
  const { parts, total } = await ok('inspect', {})
  assert.ok(parts.find((p) => /enclosure|외함|body|base/i.test(p.name)).volume_mm3 > 0, 'the part the flow takes the mass from')
  const hand = W * D * wall + (W * D - (W - 4) * (D - 4)) * (H - wall - wall) + 4 * (circle(6) - circle(2.5)) * 5 - circle(12) * wall
  within(parts[0].volume_mm3, hand, TIGHT, 'body volume')
  assert.equal(total.solids, 3)
  const step = path.join(writeRoot, '시작품 외함.step')
  const iges = path.join(writeRoot, '시작품 외함.igs')
  const answer = await ok('export', { path: step, format: '.step' })
  assert.equal(answer.path, step, 'answers name the path as asked, which craft.js maps back to /workspace')
  await ok('export', { path: iges, format: '.iges' })
  within(witness(step).per_solid[0].volume, hand, TIGHT, 'witness: body volume')
  assert.equal(witness(iges).solids, 0)
})

test('a lid with a skirt: the cap takes its own holes', async () => {
  await ok('new', { name: 'cap' })
  await ok('build_enclosure', {
    name: 'box', width: 60, depth: 40, height: 30, wall: 2, lid_height: 8,
    holes: [{ face: 'front', x: 40, y: 26, diameter: 4 }, { face: 'left', x: 20, y: 10, diameter: 6 }],
  })
  const file = path.join(writeRoot, 'cap.step')
  await ok('export', { path: file })
  const seen = witness(file)
  assert.equal(seen.solids, 2)
  // body: 22 tall, floor 2, sharp corners; left hole through 2
  within(seen.per_solid[0].volume, 60 * 40 * 2 + (60 * 40 - 56 * 36) * 20 - circle(6) * 2, TIGHT, 'body with a side hole')
  // cap: 8 tall, top 2, skirt 6; the front hole sits at z = 26 in the skirt
  within(seen.per_solid[1].volume, 60 * 40 * 2 + (60 * 40 - 56 * 36) * 6 - circle(4) * 2, TIGHT, 'cap with a skirt hole')
  nearBox(seen.per_solid[1].bbox, [0, 0, 22], [60, 40, 30], 1e-3, 'cap')
})

test('the browser is started on demand, closed when idle, and gone with the server', async () => {
  const transport = new StdioClientTransport({ command: BIN, args: ['mcp', '--automation-write-root', writeRoot], env: { ...process.env, SOLIDCRAFT_RENDER_IDLE_MS: '1500' }, stderr: 'ignore' })
  const second = new Client({ name: 'solidcraft-idle', version: '1.0.0' })
  await second.connect(transport)
  const children = () => { try { return execFileSync('pgrep', ['-P', String(transport.pid)]).toString().trim().split('\n').filter(Boolean) } catch { return [] } }
  const render = async (name) => {
    const result = await second.callTool({ name: 'render', arguments: { path: path.join(writeRoot, name) } })
    assert.ok(!result.isError, result.content[0].text)
  }
  try {
    assert.ok((await second.callTool({ name: 'add_box', arguments: { size: [10, 10, 10] } })).content)
    assert.deepEqual(children(), [], 'no browser before the first render')
    await render('idle-1.png')
    assert.ok(children().length > 0, 'a browser while rendering')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    assert.deepEqual(children(), [], 'closed when idle')
    await render('idle-2.png')
    assert.ok(fs.statSync(path.join(writeRoot, 'idle-2.png')).size > 1000, 'and comes back')
  } finally { await second.close() }
})
