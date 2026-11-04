// 실제 PSpice 프로젝트 묶음을 일괄로 돌려 결과를 센다: 파일을 저장소에 넣지 않으므로 시험이 아니라 측정이다.
//   node craft/pspice/test/corpus.mjs <폴더> [--json 결과.json] [--limit N]
// .cir 마다 프로젝트 폴더 안에서 .lib .net .inc .als 를 이름으로 찾아 준다(가까운 것 먼저).
// PSpice 가 함께 남긴 .out 에 바이어스 표가 있으면 진짜 PSpice 값과 노드 전압을 비교한다.
import fs from 'node:fs'
import path from 'node:path'
import { toNgspice, read, write } from '../pspice.mjs'
import { runNetlist, simulateText } from '../../circuitcraft-cli/sim.mjs'

const [root, ...rest] = process.argv.slice(2)
const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null }
const LIMIT = Number(opt('--limit') || 1e9), JOBS = Number(opt('--jobs') || 6)
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(p) } return out }
const all = walk(root)
const projectOf = (f) => { let d = path.dirname(f); while (d !== root && d.length > root.length) { if (fs.readdirSync(d).some((n) => /\.opj$/i.test(n))) return d; d = path.dirname(d) } return path.dirname(f) }
const COMPANION = /\.(lib|net|inc|als|mod|stl|sub|cir)$/i
function filesFor(cir) {
  const files = {}
  const project = projectOf(cir)
  for (let d = path.dirname(cir); ; d = path.dirname(d)) {
    for (const n of fs.readdirSync(d)) { const k = n.toLowerCase(); if (COMPANION.test(n) && !(k in files) && fs.statSync(path.join(d, n)).isFile()) files[k] = fs.readFileSync(path.join(d, n), 'latin1') }
    if (d === project || d.length <= root.length) break
  }
  for (const f of all) { const k = path.basename(f).toLowerCase(); if (f.startsWith(project) && COMPANION.test(f) && !(k in files)) files[k] = fs.readFileSync(f, 'latin1') }
  return files
}
// PSpice 의 바이어스 표: (N123)    5.0000  (OUT)   1.2340
function psOut(cir) {
  for (const n of [cir.replace(/\.cir$/i, '.out'), ...fs.readdirSync(path.dirname(cir)).filter((x) => /\.out$/i.test(x)).map((x) => path.join(path.dirname(cir), x))]) {
    if (!fs.existsSync(n)) continue
    const text = fs.readFileSync(n, 'latin1')
    const i = text.search(/SMALL SIGNAL BIAS SOLUTION/)
    if (i < 0) continue
    const table = {}
    for (const m of text.slice(i, i + 20000).split(/VOLTAGE SOURCE CURRENTS|TOTAL POWER/)[0].matchAll(/\(\s*([^\s)]+)\s*\)\s+(-?[\d.]+(?:E[+-]?\d+)?)/gi)) table[m[1].toLowerCase()] = Number(m[2])
    if (Object.keys(table).length) return table
  }
  return null
}
// DC 전압원이 땅에 바로 물린 노드
function sourceNodes(net) {
  const out = new Set()
  for (const l of net.split('\n')) { const m = /^V\S*\s+(\S+)\s+(\S+)\s/i.exec(l); if (m) { if (m[2] === '0') out.add(m[1].toLowerCase()); if (m[1] === '0') out.add(m[2].toLowerCase()) } }
  return out
}
const results = []
const cirs = all.filter((f) => /\.cir$/i.test(f)).slice(0, LIMIT)
let next = 0
async function one(cir) {
  const rel = path.relative(root, cir)
  const row = { file: rel }
  try {
    const text = fs.readFileSync(cir, 'latin1')
    const files = filesFor(cir)
    const t = toNgspice(text, { files })
    row.warnings = t.warnings; row.unsupported = t.unsupported; row.runs = t.runs.length
    row.parts = read(text, { files }).elements.length
    row.missing = t.missing
    if (t.unsupported.length) { row.status = t.unsupported.some((u) => /암호화/.test(u)) ? 'sealed' : t.missing?.length ? 'needs-library' : t.unsupported.some((u) => /파일이 없어서|돌릴 회로/.test(u) || /\.net/.test(u)) ? 'no-circuit' : 'unsupported'; return row }
    // PSpice 의 바이어스와 비교: 같은 회로를 동작점으로 한 번
    const pspice = psOut(cir)
    if (pspice && t.runs[0]) {
      const op = t.runs[0].netlist.replace(/^\.(TRAN|AC|DC|NOISE|TF|FOUR|OP)\b.*$/gim, '').replace(/^\.END\s*$/im, '.OP\n.END')
      const r = await runNetlist(op, { timeoutMs: 30000 })
      if (r.ok) {
        const pairs = []
        for (const d of r.data) { const m = /^v\((.*)\)$/i.exec(d.name); if (m && !m[1].includes('.') && m[1].toLowerCase() in pspice) pairs.push([m[1], pspice[m[1].toLowerCase()], d.values[0]]) }
        const bad = pairs.filter(([, a, b]) => Math.abs(a - b) > Math.max(0.02, Math.abs(a) * 0.02))
        // 소스에 바로 물린 노드는 맞을 수밖에 없다: 그것을 뺀 내부 노드를 따로 센다
        const interior = pairs.filter(([n, a]) => !sourceNodes(op).has(n.toLowerCase()) && Math.abs(a) > 1e-3)
        const badInterior = interior.filter(([, a, b]) => Math.abs(a - b) > Math.max(0.02, Math.abs(a) * 0.02))
        row.bias = { nodes: pairs.length, off: bad.length, interior: interior.length, interiorOff: badInterior.length, sample: interior.slice(0, 4).map(([n, a, b]) => [n, a, +b.toPrecision(5)]), worst: bad.slice(0, 3).map(([n, a, b]) => `${n}: PSpice ${a}, 우리 ${+b.toPrecision(5)}`) }
      } else row.bias = { nodes: 0, error: r.error?.slice(0, 160) }
    }
    const sim = await simulateText(text, { files })
    const runs = sim.runs.map((r) => ({ label: r.label, ok: r.ok, error: r.error?.slice(0, 200), points: r.numPoints }))
    row.results = runs
    row.status = runs.length && runs.every((r) => r.ok) ? 'ok' : 'failed'
    // 왕복: 쓰고 다시 옮겨도 같은 실행
    const again = toNgspice(write(read(text)), { files })
    row.roundTrip = again.runs.length === t.runs.length
  } catch (e) { row.status = 'crash'; row.error = e.message.slice(0, 200) }
  return row
}
await Promise.all(Array.from({ length: JOBS }, async () => { while (next < cirs.length) { const i = next++; results[i] = await one(cirs[i]) } }))
const count = (s) => results.filter((r) => r.status === s).length
const reasons = new Map()
for (const r of results) for (const x of r.status === 'failed' ? r.results.filter((y) => !y.ok).map((y) => y.error || '?') : r.status === 'unsupported' ? r.unsupported : r.status === 'crash' ? [r.error] : []) {
  const k = String(x).replace(/\b[A-Za-z_]*\d[\w.]*\b/g, '#').slice(0, 90); reasons.set(k, (reasons.get(k) || 0) + 1)
}
const biased = results.filter((r) => r.bias?.nodes), nodes = biased.reduce((a, r) => a + r.bias.nodes, 0), off = biased.reduce((a, r) => a + r.bias.off, 0)
console.log(`회로 ${results.length}: 성공 ${count('ok')}, 실패 ${count('failed')}, 못 옮김 ${count('unsupported')}, 부품 모델 없음 ${count('needs-library')}, 암호화 ${count('sealed')}, 회로 파일 없음 ${count('no-circuit')}, 오류 ${count('crash')}`)
const inner = biased.reduce((a, r) => a + (r.bias.interior || 0), 0), innerOff = biased.reduce((a, r) => a + (r.bias.interiorOff || 0), 0)
console.log(`PSpice 바이어스 대조: 회로 ${biased.length}, 노드 ${nodes}(소스에 안 물리고 값이 있는 내부 ${inner}), 2% 넘게 다름 ${off}(내부 ${innerOff}, 회로 ${biased.filter((r) => r.bias.off).length})`)
for (const r of biased.filter((x) => x.bias.off).slice(0, 8)) console.log(`  다름 ${r.file.slice(-50)}: ${r.bias.worst.join(' / ')}`)
console.log(`왕복: ${results.filter((r) => r.roundTrip).length}/${count('ok') + count('failed')}`)
for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${n}× ${k}`)
if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(results, null, 1))
process.exit(0)
