// 외함 2D 도면: 3D 와 같은 치수로 CADCraft 에서 삼면도를 그린다(lib/floorPlan.js 와 같은 길: 모델 없음, 치수에서 그대로).
import { callCraft } from '../mcp/craft.js'
import { L } from './lang.js'

const r2 = (n) => Math.round(Number(n) * 100) / 100
const GAP = 34 // 면 사이 간격(mm)

/** @returns the sandbox path of the saved .dxf */
export async function drawEnclosure(userId, spec, filePath, onStep = () => {}) {
  const run = (command, params) => callCraft(userId, 'cadcraft', 'cadcraft_execute', { command, params })
  const { width: W, depth: D, height: H, wall: T, corner_radius: R = 0 } = spec.enclosure
  const bosses = spec.standoffs || [], holes = spec.holes || []
  onStep(L('새 도면', 'New drawing'))
  await callCraft(userId, 'cadcraft', 'cadcraft_new_drawing', { metric: true })
  // mm 도면의 치수 글자 크기: 안 정하면 글자가 도면보다 커진다
  await run('dimstyle', { name: 'MM', current: true, DIMTXT: 2.5, DIMASZ: 2, DIMEXO: 1, DIMEXE: 1.5, DIMGAP: 0.8, DIMSCALE: 1, DIMDEC: 1 })
  for (const [name, color] of [['OUTLINE', 7], ['HIDDEN', 8], ['CENTER', 3], ['TEXT', 2], ['DIM', 1]]) await run('layer.new', { name, color })

  // 윗면(원점), 앞면(그 아래), 오른쪽면(앞면의 오른쪽)
  const topY = H + GAP, rightX = W + GAP
  onStep(L('윗면', 'Top view'))
  await run('layer.current', { name: 'OUTLINE' })
  await run('rectang', { p1: [0, topY], p2: [W, topY + D] })
  await run('layer.current', { name: 'HIDDEN' })
  await run('rectang', { p1: [T, topY + T], p2: [W - T, topY + D - T] })
  await run('layer.current', { name: 'OUTLINE' })
  for (const b of bosses) {
    await run('circle', { center: [r2(b.x), r2(topY + b.y)], radius: r2(b.diameter / 2) })
    if (b.hole_diameter) await run('circle', { center: [r2(b.x), r2(topY + b.y)], radius: r2(b.hole_diameter / 2) })
  }
  onStep(L('앞면', 'Front view'))
  await run('rectang', { p1: [0, 0], p2: [W, H] })
  await run('layer.current', { name: 'HIDDEN' })
  await run('rectang', { p1: [T, T], p2: [W - T, H - T] })
  for (const b of bosses.filter((x, i, a) => a.findIndex((y) => y.x === x.x) === i)) await run('rectang', { p1: [r2(b.x - b.diameter / 2), T], p2: [r2(b.x + b.diameter / 2), r2(T + b.height)] })
  await run('layer.current', { name: 'OUTLINE' })
  for (const h of holes.filter((x) => x.face === 'front')) await run('circle', { center: [r2(h.x), r2(h.y)], radius: r2(h.diameter / 2) })
  onStep(L('오른쪽면', 'Right view'))
  await run('rectang', { p1: [rightX, 0], p2: [rightX + D, H] })
  await run('layer.current', { name: 'HIDDEN' })
  await run('rectang', { p1: [rightX + T, T], p2: [rightX + D - T, H - T] })
  await run('layer.current', { name: 'OUTLINE' })
  for (const h of holes.filter((x) => x.face === 'right')) await run('circle', { center: [r2(rightX + h.x), r2(h.y)], radius: r2(h.diameter / 2) })

  onStep(L('치수', 'Dimensions'))
  await run('layer.current', { name: 'DIM' })
  await run('dimlinear', { p1: [0, 0], p2: [W, 0], at: [W / 2, -14] })
  await run('dimlinear', { p1: [W, 0], p2: [W, H], at: [W + 12, H / 2] })
  await run('dimlinear', { p1: [W, topY], p2: [W, topY + D], at: [W + 12, topY + D / 2] })
  await run('dimlinear', { p1: [rightX, 0], p2: [rightX + D, 0], at: [rightX + D / 2, -14] })
  await run('dimlinear', { p1: [W - T, H], p2: [W, H], at: [W - T / 2, H + 11] })
  if (bosses.length > 1) {
    const xs = [...new Set(bosses.map((b) => b.x))].sort((a, b) => a - b), ys = [...new Set(bosses.map((b) => b.y))].sort((a, b) => a - b)
    if (xs.length > 1) await run('dimlinear', { p1: [xs[0], topY + ys.at(-1)], p2: [xs.at(-1), topY + ys.at(-1)], at: [(xs[0] + xs.at(-1)) / 2, topY + D + 11] })
    if (ys.length > 1) await run('dimlinear', { p1: [xs[0], topY + ys[0]], p2: [xs[0], topY + ys.at(-1)], at: [-12, topY + (ys[0] + ys.at(-1)) / 2] })
  }
  const front = holes.find((h) => h.face === 'front')
  if (front) {
    await run('dimlinear', { p1: [0, front.y], p2: [front.x, front.y], at: [front.x / 2, -7] })
    await run('dimlinear', { p1: [0, 0], p2: [0, front.y], at: [-10, front.y / 2] })
  }
  onStep(L('표제란', 'Title block'))
  await run('layer.current', { name: 'TEXT' })
  const t = (x, y, text, height = 4) => run('text', { at: [r2(x), r2(y)], text, height, justify: 'ML' })
  // 표제란은 오른쪽면 아래: 오른쪽 위는 화면에서 뷰큐브가 가린다
  const rows = [
    L(`재질: ${spec.material || '알루미늄'}`, `Material: ${spec.material || 'Aluminum'}`),
    L(`크기: ${W} × ${D} × ${H} mm, 벽 ${T} mm`, `Size: ${W} × ${D} × ${H} mm, wall ${T} mm`),
    R ? L(`모서리: R${R}`, `Corners: R${R}`) : '',
    bosses.length ? L(`보스 ${bosses.length}개: Ø${bosses[0].diameter} × ${bosses[0].height}, 구멍 Ø${bosses[0].hole_diameter}`, `${bosses.length} bosses: Ø${bosses[0].diameter} × ${bosses[0].height}, hole Ø${bosses[0].hole_diameter}`) : '',
    front ? L(`앞면 구멍: Ø${front.diameter}`, `Front hole: Ø${front.diameter}`) : '',
  ].filter(Boolean)
  const bx = rightX, top = -30, tall = 16 + rows.length * 8
  await run('rectang', { p1: [bx - 2, top - tall], p2: [bx + 108, top] })
  await t(bx + 2, top - 8, spec.product || L('외함', 'Enclosure'), 5.5)
  for (const [i, row] of rows.entries()) await t(bx + 2, top - 18 - i * 8, row)
  await run('text', { at: [W / 2, topY - 7], text: L('윗면', 'Top'), height: 3, justify: 'MC' })
  await run('text', { at: [W / 2, -21], text: L('앞면', 'Front'), height: 3, justify: 'MC' })
  await run('text', { at: [rightX + D / 2, -21], text: L('오른쪽면', 'Right'), height: 3, justify: 'MC' })
  onStep(L('저장', 'Saving'))
  await callCraft(userId, 'cadcraft', 'cadcraft_save', { path: filePath })
  return filePath
}
