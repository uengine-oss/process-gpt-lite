// A drawing a pack skill asks for (business pack "store-design", skill cadcraft-floor-plan — runner
// 'floor-plan', lib/mining/runners.js): the model lays the rooms out from the request by the skill's own
// rules (references/layout.md), and the plan is drawn in CADCraft through its own MCP tools — the user's
// CADCraft session, step by step (new drawing, layers, walls, rooms, door, windows, tables, names and
// areas, dimensions), then saved as a .dxf in the workspace. Only the drawing's input shape and the
// coordinate system are here; how to lay a space out is the skill's.
import { chatJson } from './llm.js'
import { callCraft } from '../mcp/craft.js'
import { L, isEn } from './lang.js'
import { referenceText, referenceJson } from './skillInstallCatalog.js'

// the drawing's input (drawFloorPlan below) and its coordinate system
const SHAPE = `Return JSON {"width","depth","rooms":[{"name","use","x","y","w","h"}],"door":{"x","w"},"windows":[{"wall":"N"|"E"|"S"|"W","from","to"}],"seats"}.
Meters; origin bottom-left; y up; the south wall is y=0. door.x is the door's left edge measured from the west wall.`

const r2 = (n) => Math.round(Number(n) * 100) / 100

function validLayout(l) {
  const W = Number(l?.width), D = Number(l?.depth)
  if (!(W > 2 && D > 2 && Array.isArray(l.rooms) && l.rooms.length)) return false
  let area = 0
  for (const r of l.rooms) {
    if (!(r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= W + 0.01 && r.y + r.h <= D + 0.01)) return false
    area += r.w * r.h
  }
  return Math.abs(area - W * D) < 0.5
}

// The skill's fallback (references/fallback-layout.json): one main room and a column of side rooms.
// Only the overall size is read from the request — "W × D" is a dimension (a number format).
export function fallbackLayout(brief, plan) {
  const lg = isEn() ? 'en' : 'ko'
  const m = /(\d+(?:\.\d+)?)\s*m?\s*[×x*]\s*(\d+(?:\.\d+)?)/.exec(brief?.text || '') || []
  const W = Number(m[1]) || plan?.default_size_m?.width || 12, D = Number(m[2]) || plan?.default_size_m?.depth || 8
  const side = Math.min(plan?.side_width?.max_m || 4, W * (plan?.side_width?.share_of_width || 1 / 3))
  const rooms = [{ name: plan?.main?.name?.[lg] || L('실 1', 'Room 1'), use: plan?.main?.use?.[lg] || '', x: 0, y: 0, w: W - side, h: D }]
  let top = D
  for (const s of plan?.side || []) {
    const h = D * (Number(s.share_of_depth) || 0)
    rooms.push({ name: s.name?.[lg] || '', use: s.use?.[lg] || '', x: W - side, y: top - h, w: side, h })
    top -= h
  }
  if (!plan?.side?.length) rooms[0].w = W
  return {
    width: W, depth: D, seats: 0, rooms,
    door: { x: (W - side) / 2 - 0.6, w: 1.2 },
    windows: [{ wall: 'S', from: 1, to: (W - side) / 2 - 1.2 }, { wall: 'W', from: 2, to: D - 2 }],
  }
}

/** the rooms the request asks for, laid out by the skill's rules; its fallback when the model's does not add up */
export async function layoutFromBrief(brief, skill) {
  const rules = referenceText(skill, 'references/layout.md')
  if (!rules) throw new Error(`${skill?.name || 'skill'}: references/layout.md is missing`)
  try {
    const l = await chatJson(`${rules}\n\n${SHAPE}\nRoom names and uses in ${isEn() ? 'English' : 'Korean'}.`, `${brief.subject || ''}\n${brief.text || ''}`)
    if (validLayout(l)) return l
    console.warn('[floor-plan] layout did not add up, using the fallback')
  } catch (e) { console.warn('[floor-plan] layout', e.message) }
  return fallbackLayout(brief, referenceJson(skill, 'references/fallback-layout.json'))
}

/** draw it; returns the sandbox path of the saved .dxf and the room schedule */
export async function drawFloorPlan(userId, layout, fileName, onStep = () => {}) {
  const run = (command, params) => callCraft(userId, 'cadcraft', 'cadcraft_execute', { command, params })
  const W = r2(layout.width), D = r2(layout.depth), t = 0.15
  onStep(L('새 도면', 'New drawing'))
  await callCraft(userId, 'cadcraft', 'cadcraft_new_drawing', { metric: true })
  // dimension text small enough for a metre drawing
  await run('dimstyle', { name: 'M', current: true, DIMTXT: 0.25, DIMASZ: 0.15, DIMEXO: 0.1, DIMEXE: 0.1, DIMGAP: 0.05, DIMSCALE: 1, DIMDEC: 1 })
  for (const [name, color] of [['WALL', 7], ['ROOM', 8], ['DOOR', 3], ['WINDOW', 4], ['FURN', 6], ['TEXT', 2], ['DIM', 1]]) await run('layer.new', { name, color })
  onStep(L('벽', 'Walls'))
  await run('layer.current', { name: 'WALL' })
  await run('rectang', { p1: [0, 0], p2: [W, D] })
  await run('rectang', { p1: [t, t], p2: [W - t, D - t] })
  onStep(L('실 구획', 'Rooms'))
  await run('layer.current', { name: 'ROOM' })
  for (const r of layout.rooms) {
    if (r.w * r.h >= W * D * 0.45) continue // the hall is what the walls already enclose
    await run('rectang', { p1: [r2(r.x), r2(r.y)], p2: [r2(r.x + r.w), r2(r.y + r.h)] })
  }
  onStep(L('문·창', 'Door & windows'))
  const door = layout.door || { x: 1, w: 1.2 }
  await run('layer.current', { name: 'DOOR' })
  await run('line', { points: [[r2(door.x), 0], [r2(door.x), r2(door.w)]] })
  await run('arc', { center: [r2(door.x), 0], radius: r2(door.w), start: 0, end: 90 })
  await run('layer.current', { name: 'WINDOW' })
  for (const w of layout.windows || []) {
    const a = r2(w.from), b = r2(w.to)
    if (!(b > a)) continue
    const seg = { S: [[a, t / 2], [b, t / 2]], N: [[a, D - t / 2], [b, D - t / 2]], W: [[t / 2, a], [t / 2, b]], E: [[W - t / 2, a], [W - t / 2, b]] }[w.wall]
    if (seg) await run('line', { points: seg })
  }
  // tables in the largest room, four seats each
  const hall = [...layout.rooms].sort((a, b) => b.w * b.h - a.w * a.h)[0]
  const tables = Math.ceil((Number(layout.seats) || 0) / 4)
  if (tables) {
    onStep(L('좌석', 'Seats'))
    await run('layer.current', { name: 'FURN' })
    // rows that fit between the door's swing (bottom) and the room's name (top), 1.7m apart
    const doorIn = hall.y < 0.5 && door.x + door.w > hall.x && door.x < hall.x + hall.w
    const bottom = hall.y + (doorIn ? 2.4 : 1.5), top = hall.y + hall.h - 1.7
    const rows = Math.max(1, Math.min(tables, Math.floor((top - bottom) / 1.7) + 1)), cols = Math.ceil(tables / rows)
    for (let i = 0; i < tables; i++) {
      const c = i % cols, r = Math.floor(i / cols)
      const cx = hall.x + (hall.w * (c + 0.5)) / cols, cy = rows === 1 ? (bottom + top) / 2 : bottom + ((top - bottom) * r) / (rows - 1)
      await run('circle', { center: [r2(cx), r2(cy)], radius: 0.38 })
      for (const [dx, dy] of [[0.62, 0], [-0.62, 0], [0, 0.62], [0, -0.62]]) await run('circle', { center: [r2(cx + dx), r2(cy + dy)], radius: 0.16 })
    }
  }
  onStep(L('실 이름·면적', 'Room names & areas'))
  await run('layer.current', { name: 'TEXT' })
  for (const r of layout.rooms) {
    const cx = r2(r.x + r.w / 2), cy = r2(r.y + r.h / 2)
    const big = r.w * r.h >= W * D * 0.45
    await run('text', { at: [cx, big ? r2(r.y + r.h - 0.8) : cy + 0.2], text: r.name, height: big ? 0.45 : 0.32, justify: 'MC' })
    await run('text', { at: [cx, big ? r2(r.y + r.h - 1.4) : cy - 0.35], text: `${r2(r.w * r.h)}m²`, height: 0.24, justify: 'MC' })
  }
  await run('text', { at: [r2(door.x + door.w / 2), -0.45], text: L('출입문', 'Entrance'), height: 0.25, justify: 'MC' })
  onStep(L('치수', 'Dimensions'))
  await run('layer.current', { name: 'DIM' })
  await run('dimlinear', { p1: [0, 0], p2: [W, 0], at: [W / 2, -1.1] })
  await run('dimlinear', { p1: [W, 0], p2: [W, D], at: [W + 1.1, D / 2] })
  onStep(L('저장', 'Saving'))
  const path = `/workspace/${fileName.replace(/[\\/]/g, '_')}`
  await callCraft(userId, 'cadcraft', 'cadcraft_save', { path })
  const rooms = layout.rooms.map((r) => ({ name: r.name, area: r2(r.w * r.h), use: r.use || '' }))
  return { path, rooms, width: W, depth: D }
}
