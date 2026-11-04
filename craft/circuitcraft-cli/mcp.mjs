// CircuitCraft MCP: 도구 이름에는 앱 접두사를 붙이지 않는다(server/mcp/craft.js 가 circuitcraft_ 를 붙이고 뗀다).
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { read, write, toNgspice, number } from '../pspice/pspice.mjs'
import { simulateText, companionFiles, magnitude } from './sim.mjs'
import { plotSvg, writePng, eng } from './plot.mjs'

const TOOLS = [
  ['open', 'Open a PSpice document (.cir .net .ckt .sp .lib .mod), or an OrCAD Capture design (.dsn, read only). .lib and .inc files beside it are found by name. Returns its parts, analyses and what cannot be simulated.', { path: { type: 'string' }, libraries: { type: 'array', items: { type: 'string' }, description: 'more library files' } }, ['path']],
  ['simulate', 'Run every analysis of the open document (.TRAN .AC .DC .OP, one run per .STEP value). PSpice-only syntax is translated first. Returns each run with its vectors and their ranges. Never reports a value it did not compute: failed runs carry their error.', {}, []],
  ['measure', 'A value from a run: max, min, pp, avg, rms, final, at (y at x=value), or bandwidth (x where magnitude falls 3 dB below its low-frequency value, AC only).', { run: { type: 'string', description: 'run label from simulate, e.g. "AC RF=10k"' }, vector: { type: 'string', description: 'e.g. v(out)' }, what: { type: 'string', enum: ['max', 'min', 'pp', 'avg', 'rms', 'final', 'at', 'bandwidth'] }, at: { type: 'number' } }, ['run', 'vector', 'what']],
  ['plot', 'Draw a PNG graph of vectors. AC runs plot dB against log frequency. With several runs the curves overlay, labelled by their .STEP value.', { path: { type: 'string' }, runs: { type: 'array', items: { type: 'string' } }, vectors: { type: 'array', items: { type: 'string' } }, title: { type: 'string' } }, ['path', 'runs', 'vectors']],
  ['bom', 'The parts of the open document: reference, kind, value or model, how many of each.', {}, []],
  ['edit', 'Change the value of a part, e.g. ref R2 value 22k (or .PARAM with ref RF). Run simulate again to see the effect.', { ref: { type: 'string' }, value: { type: 'string' } }, ['ref', 'value']],
  ['save', 'Write the open document as a PSpice netlist (.cir).', { path: { type: 'string' } }, ['path']],
]
const KIND = { R: '저항', C: '커패시터', L: '인덕터', D: '다이오드', Q: '트랜지스터', M: 'MOSFET', J: 'JFET', X: '서브회로', V: '전압원', I: '전류원', E: '제어 전압원', G: '제어 전류원', F: '제어 전류원', H: '제어 전압원', S: '스위치', W: '스위치', T: '전송선', K: '결합' }

export async function startMcp({ readRoot, writeRoot } = {}) {
  let doc = null // { file, text, files, parsed, sim }
  const inside = (p, root, verb) => {
    const full = path.resolve(p)
    if (root && !(full === path.resolve(root) || full.startsWith(path.resolve(root) + path.sep))) throw new Error(`${verb}: 허용된 폴더 밖이에요: ${p}`)
    return full
  }
  const need = () => { if (!doc) throw new Error('먼저 open 으로 문서를 여세요'); return doc }
  const runOf = (label) => {
    const r = need().sim?.runs.find((x) => x.label.toLowerCase() === String(label).toLowerCase())
    if (!r) throw new Error(`없는 실행이에요: ${label}. 있는 것: ${doc.sim?.runs.map((x) => x.label).join(', ') || '(simulate 를 먼저)'}`)
    if (!r.ok) throw new Error(`${r.label} 은 실패한 실행이에요: ${r.error}`)
    return r
  }
  const vec = (run, name) => { const v = run.data.find((d) => d.name.toLowerCase() === String(name).toLowerCase()); if (!v) throw new Error(`${run.label} 에 ${name} 이 없어요. 있는 것: ${run.data.map((d) => d.name).slice(0, 20).join(', ')}`); return v }
  const scale = (run) => run.data[0]
  const summary = (r) => {
    if (!r.ok) return { label: r.label, ok: false, error: r.error }
    const vectors = r.data.slice(1).filter((d) => /^v\(/i.test(d.name) && !/\./.test(d.name)).map((d) => { const m = d.values.map(magnitude); return { name: d.name, min: +Math.min(...m).toPrecision(5), max: +Math.max(...m).toPrecision(5) } })
    return { label: r.label, ok: true, points: r.numPoints, scale: scale(r).name, complex: r.dataType === 'complex', vectors, ms: r.ms }
  }
  const handlers = {
    async open({ path: p, libraries = [] }) {
      const file = inside(p, readRoot, '읽기')
      const buf = fs.readFileSync(file)
      let text = buf.toString('latin1'), converted = null
      if (/\.(dsn|dbk)$/i.test(file) || buf.subarray(0, 4).toString('hex') === 'd0cf11e0') {
        const cli = process.env.CIRCUITCRAFT_DSN2CIR || new URL('../orcad/dsn2cir', import.meta.url).pathname
        const out = await new Promise((res, rej) => execFile(cli, [file], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (e, so, se) => (e ? rej(new Error(`OrCAD 파일을 읽지 못했어요: ${String(se || e.message).slice(0, 300)}`)) : res(so))))
        text = out; converted = 'dsn'
      } else if (/[^\x00-\x7F]/.test(text)) {
        const utf = buf.toString('utf8')
        if (!utf.includes('�')) text = utf
      }
      const files = companionFiles(file, libraries.map((l) => inside(l, readRoot, '읽기')))
      const parsed = read(text, { files })
      const t = toNgspice(text, { files })
      doc = { file, text, files, parsed, sim: null, converted }
      return {
        title: parsed.title, library: parsed.isLibrary, parts: parsed.elements.length, subcircuits: parsed.subckts.map((s) => `${s.name}(${s.pins.length} pins)`), models: parsed.models.map((m) => m.name),
        analyses: parsed.analyses, runs: t.runs.map((r) => r.label), warnings: [...parsed.warnings, ...t.warnings], unsupported: t.unsupported, converted_from: converted,
      }
    },
    async simulate() {
      const d = need()
      if (d.parsed.isLibrary) throw new Error('라이브러리 파일이라 돌릴 회로가 없어요')
      const text = currentText(d)
      const r = await simulateText(text, { files: d.files })
      d.sim = r
      return { ok: r.ok, title: r.title, warnings: r.warnings, unsupported: r.unsupported, runs: r.runs.map(summary) }
    },
    async measure({ run, vector, what, at }) {
      const r = runOf(run), x = scale(r).values.map(magnitude), y = vec(r, vector).values.map(magnitude)
      let value
      if (what === 'max') value = Math.max(...y)
      else if (what === 'min') value = Math.min(...y)
      else if (what === 'pp') value = Math.max(...y) - Math.min(...y)
      else if (what === 'final') value = y.at(-1)
      else if (what === 'avg' || what === 'rms') {
        let area = 0, sq = 0, span = 0
        for (let i = 1; i < x.length; i++) { const dx = x[i] - x[i - 1]; area += dx * (y[i] + y[i - 1]) / 2; sq += dx * (y[i] * y[i] + y[i - 1] * y[i - 1]) / 2; span += dx }
        value = what === 'avg' ? area / (span || 1) : Math.sqrt(sq / (span || 1))
      } else if (what === 'at') {
        if (typeof at !== 'number') throw new Error('at 값이 필요해요')
        const i = x.findIndex((v) => v >= at)
        if (i < 0) throw new Error(`${at} 는 범위 밖이에요`)
        value = i === 0 ? y[0] : y[i - 1] + (y[i] - y[i - 1]) * (at - x[i - 1]) / (x[i] - x[i - 1])
      } else if (what === 'bandwidth') {
        if (r.dataType !== 'complex') throw new Error('bandwidth 는 AC 실행에서만 재요')
        const ref = y[0], target = ref * Math.SQRT1_2
        const i = y.findIndex((v) => v < target)
        if (i <= 0) return { value: null, note: `범위 안에서 3 dB 아래로 떨어지지 않았어요(${eng(x.at(-1), 'Hz')}까지)` }
        const t = (y[i - 1] - target) / (y[i - 1] - y[i])
        value = x[i - 1] * (x[i] / x[i - 1]) ** t
        return { value: +value.toPrecision(5), text: eng(value, 'Hz'), low_frequency_gain: +ref.toPrecision(5) }
      }
      return { value: +value.toPrecision(6), text: eng(value) }
    },
    async plot({ path: p, runs, vectors, title }) {
      const file = inside(p, writeRoot, '쓰기')
      const rs = runs.map(runOf)
      const ac = rs[0].dataType === 'complex'
      const series = rs.flatMap((r) => vectors.map((name) => ({
        name: [rs.length > 1 ? r.step || r.label : '', vectors.length > 1 || rs.length === 1 ? name : ''].filter(Boolean).join(' '),
        x: scale(r).values.map(magnitude),
        y: vec(r, name).values.map((v) => (ac ? 20 * Math.log10(Math.max(magnitude(v), 1e-30)) : v)),
      })))
      const unit = /^i\(/i.test(vectors[0]) ? 'A' : 'V'
      writePng(file, plotSvg({ title: title || need().parsed.title, series, xLog: ac, xUnit: ac ? 'Hz' : scale(rs[0]).name === 'time' ? 's' : '', yUnit: ac ? ' dB' : unit, xLabel: ac ? '주파수' : scale(rs[0]).name === 'time' ? '시간' : scale(rs[0]).name, yLabel: ac ? '크기' : '' }))
      return { path: p, series: series.map((s) => s.name), points: series.reduce((a, s) => a + s.x.length, 0) }
    },
    async bom() {
      const d = need(), el = d.parsed.elements.filter((e) => !'VIEGFHK'.includes(e.letter) || e.letter === 'X')
      const rows = new Map()
      // {RF} 는 .PARAM 의 값으로 푼다. .STEP 으로 도는 값이면 값들을 모두 적는다
      const paramValue = (name) => { for (const l of d.parsed.params) { const m = new RegExp(`\\b${name}\\s*=\\s*([^\\s,]+)`, 'i').exec(l); if (m) return m[1] } return null }
      const stepped = (name) => { for (const l of d.parsed.others) { const m = new RegExp(`^\\.STEP\\s+(?:LIN\\s+)?PARAM\\s+${name}\\s+LIST\\s+(.*)$`, 'i').exec(l); if (m) return m[1].split(/[\\s,]+/).join(', ') } return null }
      const plain = (v) => String(v).replace(/^\{(\w+)\}$/, (m, n) => stepped(n) || paramValue(n) || m)
      for (const e of el) {
        const value = e.model || plain(valueOf(e))
        const key = `${e.letter}|${value}`
        if (!rows.has(key)) rows.set(key, { kind: KIND[e.letter] || e.letter, value, refs: [], quantity: 0 })
        const row = rows.get(key); row.refs.push(e.ref); row.quantity++
      }
      return { title: d.parsed.title, parts: el.length, rows: [...rows.values()], excluded_sources: d.parsed.elements.length - el.length }
    },
    async edit({ ref, value }) {
      const d = need()
      if (!/^[\w.+\-{}()*/ ]+$/.test(value)) throw new Error(`값으로 쓸 수 없어요: ${value}`)
      const e = d.parsed.elements.find((x) => x.ref.toLowerCase() === ref.toLowerCase())
      if (e) {
        if (!'RCL'.includes(e.letter)) throw new Error(`${e.ref} 은 값을 바꿀 수 없는 소자예요(R, C, L 만)`)
        const old = valueOf(e)
        e.rest = [value, ...e.rest.slice(1)]; e.raw = [e.ref, ...e.nodes, ...e.rest].join(' ')
        d.sim = null; d.edited = true
        return { ref: e.ref, from: old, to: value }
      }
      const i = d.parsed.params.findIndex((l) => new RegExp(`\\b${ref}\\s*=`, 'i').test(l))
      if (i < 0) throw new Error(`없는 부품이나 파라미터예요: ${ref}`)
      d.parsed.params[i] = d.parsed.params[i].replace(new RegExp(`\\b(${ref})\\s*=\\s*[^\\s,]+`, 'i'), `$1=${value}`)
      d.sim = null; d.edited = true
      return { param: ref, to: value }
    },
    async save({ path: p }) {
      const d = need(), file = inside(p, writeRoot, '쓰기')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const text = d.edited || d.converted ? write(d.parsed) : d.text
      fs.writeFileSync(file, text, /[^\x00-\xFF]/.test(text) ? 'utf8' : 'latin1')
      return { path: p, bytes: fs.statSync(file).size }
    },
  }
  const valueOf = (e) => e.rest[0] ?? ''
  const currentText = (d) => (d.edited ? write(d.parsed) : d.text)

  const server = new Server({ name: 'circuitcraft', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required } })) }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const h = handlers[params.name]
    if (!h) return { isError: true, content: [{ type: 'text', text: `없는 도구예요: ${params.name}` }] }
    try { return { content: [{ type: 'text', text: JSON.stringify(await h(params.arguments || {})) }] } } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] } }
  })
  await server.connect(new StdioServerTransport())
  void number
}
