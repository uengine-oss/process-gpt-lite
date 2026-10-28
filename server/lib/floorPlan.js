// A floor plan a customer mail asks for (lib/mail.js design drafts): the model lays the rooms out
// from the mail (sizes, rooms, door), and the plan is drawn in CADCraft through its own MCP tools —
// the user's CADCraft session, step by step (new drawing, layers, walls, rooms, door, windows,
// tables, names and areas, dimensions), then saved as a .dxf in the workspace.
import { chatJson } from './llm.js'
import { callCraft } from '../mcp/craft.js'
import { L, isEn } from './lang.js'

const LAYOUT = `You lay out a small commercial interior (a cafe, office, shop) from a customer's mail.
Return JSON {"width","depth","rooms":[{"name","use","x","y","w","h"}],"door":{"x","w"},"windows":[{"wall":"N"|"E"|"S"|"W","from","to"}],"seats"}.
Meters; origin bottom-left; y up; the south wall is y=0. Rooms tile the whole width×depth rectangle exactly
(no gaps, no overlaps; the main hall is the largest). Room names and uses in Korean. The door sits on
the wall the mail says (default south): x is its left edge from the west wall, w about 1.2. 2-3 windows
on outside walls, not across the door. seats = the number the mail asks for (else 0).`

// English mode: the same layout with English room names and uses (they are drawn on the plan)
const layoutPrompt = () => (isEn() ? LAYOUT.replace('Room names and uses in Korean.', 'Room names and uses in English (short, e.g. "Hall", "Bar", "Storage").') : LAYOUT)

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

/** the rooms the mail asks for, laid out; a plain fallback when the model's does not add up */
export async function layoutFromMail(mail) {
  try {
    const l = await chatJson(layoutPrompt(), `${mail.subject}\n${mail.text}`)
    if (validLayout(l)) return l
    console.warn('[floor-plan] layout did not add up, using the fallback')
  } catch (e) { console.warn('[floor-plan] layout', e.message) }
  const m = /(\d+(?:\.\d+)?)\s*m?\s*[×x*]\s*(\d+(?:\.\d+)?)/.exec(mail.text || '') || []
  const W = Number(m[1]) || 12, D = Number(m[2]) || 8
  const side = Math.min(4, W / 3)
  return {
    width: W, depth: D, seats: Number((/(\d+)\s*석/.exec(mail.text || '') || /(\d+)\s*seats/i.exec(mail.text || '') || [])[1]) || 0,
    rooms: isEn() ? [
      { name: 'Hall', use: 'Seating & waiting', x: 0, y: 0, w: W - side, h: D },
      { name: 'Bar & kitchen', use: 'Drink making', x: W - side, y: D / 2, w: side, h: D / 2 },
      { name: 'Storage', use: 'Stock', x: W - side, y: D / 4, w: side, h: D / 4 },
      { name: 'Restroom', use: '1', x: W - side, y: 0, w: side, h: D / 4 },
    ] : [
      { name: '홀', use: '좌석·대기', x: 0, y: 0, w: W - side, h: D },
      { name: '바·주방', use: '음료 제조', x: W - side, y: D / 2, w: side, h: D / 2 },
      { name: '창고', use: '재고 보관', x: W - side, y: D / 4, w: side, h: D / 4 },
      { name: '화장실', use: '1개', x: W - side, y: 0, w: side, h: D / 4 },
    ],
    door: { x: (W - side) / 2 - 0.6, w: 1.2 },
    windows: [{ wall: 'S', from: 1, to: (W - side) / 2 - 1.2 }, { wall: 'W', from: 2, to: D - 2 }],
  }
}

/** draw it; returns the sandbox path of the saved .dxf and the room schedule */
export async function drawFloorPlan(userId, layout, fileName, onStep = () => {}) {
  const run = (command, params) => callCraft(userId, 'cadcraft', 'cadcraft_execute', { command, params })
  const W = r2(layout.width), D = r2(layout.depth), t = 0.15
  onStep(L('새 도면', 'New drawing'))
  await callCraft(userId, 'cadcraft', 'cadcraft_new_drawing', { metric: true })
  // the house style for metre drawings (lib/office.js CRAFT_HINTS): small dimension text
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
