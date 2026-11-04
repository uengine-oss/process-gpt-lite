// 시뮬레이션 결과 그래프(PNG): 제안서에 들어가는 그림. 축은 값 범위에서 정하고, 여러 벡터·여러 스텝을 한 그림에 겹친다.
import fs from 'node:fs'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { fileURLToPath } from 'node:url'

const FONT = process.env.CIRCUITCRAFT_FONT || fileURLToPath(new URL('../../../artcraft/craft-fonts-ko/NanumGothic-Regular.ttf', import.meta.url))
const COLORS = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4b5563']
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const ENG = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']]
export const eng = (v, unit = '') => {
  if (!Number.isFinite(v)) return '-'
  if (v === 0) return `0${unit}`
  const a = Math.abs(v)
  const [k, s] = ENG.find(([x]) => a >= x * 0.9995) || ENG.at(-1)
  return `${+(v / k).toPrecision(3)}${s}${unit}`
}
const niceTicks = (lo, hi, n = 6) => {
  if (!(hi > lo)) { hi = lo + 1 }
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toPrecision(10))
  return out
}
// series: [{ name, x: number[], y: number[] }]; xLog: frequency axes
export function plotSvg({ title, series, xLabel, yLabel, xUnit = '', yUnit = '', xLog = false, width = 1400, height = 800 }) {
  const m = { l: 110, r: 40, t: 74, b: 92 }
  const W = width - m.l - m.r, H = height - m.t - m.b
  const xs = series.flatMap((s) => s.x).filter(Number.isFinite), ys = series.flatMap((s) => s.y).filter(Number.isFinite)
  const fx = xLog ? (v) => Math.log10(Math.max(v, 1e-30)) : (v) => v
  const x0 = fx(Math.min(...xs)), x1 = fx(Math.max(...xs))
  let y0 = Math.min(...ys), y1 = Math.max(...ys)
  if (y1 - y0 < 1e-12) { y0 -= Math.abs(y0) * 0.1 + 1e-9; y1 += Math.abs(y1) * 0.1 + 1e-9 }
  const pad = (y1 - y0) * 0.08
  y0 -= pad; y1 += pad
  const px = (v) => m.l + ((fx(v) - x0) / (x1 - x0 || 1)) * W
  const py = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * H
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/>`]
  parts.push(`<text x="${m.l}" y="44" font-size="30" font-weight="700" fill="#111827">${esc(title || '')}</text>`)
  const label = (x, y, t, anchor = 'middle', size = 20, fill = '#4b5563') => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" fill="${fill}">${esc(t)}</text>`
  const xt = xLog ? Array.from({ length: Math.ceil(x1) - Math.floor(x0) + 1 }, (_, i) => 10 ** (Math.floor(x0) + i)).filter((v) => fx(v) >= x0 - 1e-9 && fx(v) <= x1 + 1e-9) : niceTicks(x0, x1)
  for (const t of xt) { const X = px(t); parts.push(`<line x1="${X}" y1="${m.t}" x2="${X}" y2="${m.t + H}" stroke="#e5e7eb"/>`, label(X, m.t + H + 30, eng(t, xUnit))) }
  for (const t of niceTicks(y0, y1)) { const Y = py(t); parts.push(`<line x1="${m.l}" y1="${Y}" x2="${m.l + W}" y2="${Y}" stroke="#e5e7eb"/>`, label(m.l - 14, Y + 7, eng(t, yUnit), 'end')) }
  parts.push(`<rect x="${m.l}" y="${m.t}" width="${W}" height="${H}" fill="none" stroke="#9ca3af"/>`)
  parts.push(`<clipPath id="c"><rect x="${m.l}" y="${m.t}" width="${W}" height="${H}"/></clipPath>`)
  series.forEach((s, i) => {
    // no more than a pixel's worth of points: min and max in each column, so a peak stays visible
    const cols = new Map()
    s.x.forEach((v, k) => { const c = Math.round(px(v)); const e = cols.get(c); const y = s.y[k]; if (!Number.isFinite(y)) return; if (!e) cols.set(c, { lo: y, hi: y }); else { e.lo = Math.min(e.lo, y); e.hi = Math.max(e.hi, y) } })
    const pts = [...cols.entries()].sort((a, b) => a[0] - b[0]).flatMap(([c, e]) => (e.lo === e.hi ? [[c, py(e.lo)]] : [[c, py(e.lo)], [c, py(e.hi)]]))
    parts.push(`<polyline clip-path="url(#c)" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="2.6" points="${pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')}"/>`)
  })
  if (series.length > 1 || series[0]?.name) {
    let lx = m.l
    series.forEach((s, i) => {
      parts.push(`<rect x="${lx}" y="${height - 32}" width="26" height="6" fill="${COLORS[i % COLORS.length]}"/>`, label(lx + 34, height - 22, s.name, 'start', 20, '#111827'))
      lx += 60 + String(s.name).length * 12
    })
  }
  if (xLabel) parts.push(label(m.l + W, m.t + H + 62, xLabel, 'end'))
  if (yLabel) parts.push(`<text transform="translate(26 ${m.t + H / 2}) rotate(-90)" text-anchor="middle" font-size="20" fill="#4b5563">${esc(yLabel)}</text>`)
  parts.push('</svg>')
  return parts.join('')
}
export function writePng(file, svg) {
  const fonts = fs.existsSync(FONT) ? { fontFiles: [FONT], loadSystemFonts: true, defaultFontFamily: 'NanumGothic' } : { loadSystemFonts: true }
  const png = new Resvg(svg, { font: fonts, background: '#ffffff' }).render().asPng()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, png)
  return png.length
}
