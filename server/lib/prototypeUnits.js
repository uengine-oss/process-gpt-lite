// 값을 사람이 읽는 단위로
const ENG = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']]
export function eng(v, unit = '') {
  if (!Number.isFinite(v)) return '-'
  if (v === 0) return `0 ${unit}`.trim()
  const [k, s] = ENG.find(([x]) => Math.abs(v) >= x * 0.9995) || ENG.at(-1)
  return `${+(v / k).toPrecision(3)} ${s}${unit}`
}
