// PSpice 텍스트 문서(.cir .net .lib)를 읽고 쓴다. 시뮬레이터는 ngspice(WASM)라서 PSpice 전용 문법은 옮겨 준다.
// 옮기지 못하는 것은 조용히 넘기지 않고 unsupported 로 알린다: 틀린 값을 내는 것이 멈추는 것보다 나쁘다.
//   read(text, { files })  → 문서 구조(elements, models, subckts, analyses, …)
//   toNgspice(text, { files }) → { runs: [{ label, netlist }], warnings, unsupported }
//   write(doc)             → PSpice 넷리스트 글
// 의존성 없음: 브라우저(CircuitCraft)와 Node(MCP)가 같이 쓴다.

const DROPPED = /^\.(PROBE\d*|PLOT|PRINT|WIDTH|STIMLIB|AUTOCONVERGE|EXTERNAL|LOADBIAS|SAVEBIAS|WATCH|VECTOR|ALIASES|ENDALIASES)\b/i
const NOT_SIMULATED = /^\.(MC|WCASE|DISTRIBUTION|SENS)\b/i
const KEPT_OPTIONS = new Set(['RELTOL', 'ABSTOL', 'VNTOL', 'CHGTOL', 'GMIN', 'ITL1', 'ITL2', 'ITL4', 'TNOM', 'TRTOL', 'PIVTOL', 'PIVREL'])
const ANALYSES = /^\.(TRAN|AC|DC|OP|NOISE|TF|FOUR)\b/i

// ---------- 글자 ----------
export function logicalLines(text) {
  const out = []
  let last = null
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (/^\s*\*/.test(line) || !line.trim()) { out.push({ comment: true, text: line }); continue }
    // ; starts a comment in PSpice (not inside a quoted file name)
    const clean = line.replace(/;(?=(?:[^"]*"[^"]*")*[^"]*$).*$/, '').replace(/\s+$/, '')
    if (!clean.trim()) continue
    if (/^\s*\+/.test(clean) && last) { last.text += ' ' + clean.replace(/^\s*\+\s*/, ''); continue }
    last = { text: clean.trim() }
    out.push(last)
  }
  return out
}

function splitArgs(s) {
  const args = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(' || ch === '{') depth++
    if (ch === ')' || ch === '}') depth--
    if (ch === ',' && depth === 0) { args.push(cur); cur = '' } else cur += ch
  }
  args.push(cur)
  return args.map((a) => a.trim())
}
// finds NAME( … ) calls, innermost handled through recursion on the arguments
function mapCalls(expr, names, fn) {
  const re = new RegExp(`\\b(${names.join('|')})\\s*\\(`, 'i')
  let out = '', rest = expr
  for (;;) {
    const m = re.exec(rest)
    if (!m) return out + rest
    out += rest.slice(0, m.index)
    let i = m.index + m[0].length, depth = 1
    while (i < rest.length && depth) { if (rest[i] === '(') depth++; if (rest[i] === ')') depth--; i++ }
    const inner = rest.slice(m.index + m[0].length, i - 1)
    out += fn(m[1].toUpperCase(), splitArgs(inner).map((a) => mapCalls(a, names, fn)))
    rest = rest.slice(i)
  }
}
const SAFE_NODE = /^[A-Za-z0-9_.#!:]+$/
export const safeNode = (n) => (SAFE_NODE.test(n) ? n : n.replace(/\+/g, '_P').replace(/-/g, '_N').replace(/[^A-Za-z0-9_.#!:]/g, '_'))

// PSpice 식 → ngspice 식
export function rewriteExpr(expr, warn = () => {}, { behavioral = false } = {}) {
  let e = mapCalls(expr, ['IF', 'LIMIT', 'PWRS', 'PWR', 'STP', 'TABLE'], (name, a) => {
    if (name === 'IF' && a.length === 3) return `((${a[0]}) ? (${a[1]}) : (${a[2]}))`
    if (name === 'LIMIT' && a.length === 3) {
      if (!behavioral) return `min(max(${a[0]},${a[1]}),${a[2]})`
      // a hard clamp on a source inside a feedback loop leaves the operating point without a solution here (measured on an op-amp macro model)
      warn('소스 안의 LIMIT 은 tanh 로 부드럽게 옮겼어요. 한계에 아주 가까운 값은 조금 낮게 나와요')
      const mid = `((${a[2]})+(${a[1]}))/2`, half = `((${a[2]})-(${a[1]}))/2`
      return `(${mid}+${half}*tanh(((${a[0]})-${mid})/(${half})))`
    }
    if (name === 'PWR' && a.length === 2) return `pow(abs(${a[0]}),${a[1]})`
    if (name === 'PWRS' && a.length === 2) return `(sgn(${a[0]})*pow(abs(${a[0]}),${a[1]}))`
    if (name === 'STP' && a.length === 1) return `u(${a[0]})`
    if (name === 'TABLE' && a.length >= 3) return tablePwl(a[0], a.slice(1))
    warn(`${name} 인자 수가 맞지 않아요: ${name}(${a.join(', ')})`)
    return `${name}(${a.join(',')})`
  })
  // PSpice 의 논리곱·논리합은 한 글자
  e = e.replace(/&&?/g, '&&').replace(/\|\|?/g, '||')
  // V(IN+,IN-) 같은 노드 이름
  e = e.replace(/\bV\(\s*([^(),]+?)\s*(?:,\s*([^(),]+?)\s*)?\)/gi, (_, a, b) => (b ? `V(${safeNode(a)},${safeNode(b)})` : `V(${safeNode(a)})`))
  if (/\b(ABSDELAY|DELAY|DDT|SDT)\s*\(/i.test(e) && /\b(ABSDELAY|DELAY)\s*\(/i.test(e)) warn(`옮기지 못한 PSpice 함수가 있어요: ${e.slice(0, 80)}`)
  return e
}
// PSpice's TABLE stays flat outside its range; ngspice's pwl keeps the slope, so pin both ends
function tablePwl(x, flat) {
  const pts = []
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]])
  const [x0, y0] = pts[0], [xn, yn] = pts[pts.length - 1]
  // (the points must be plain numbers there)
  const all = [[number(x0) - 1e12, y0], ...pts.map(([a, b]) => [number(a), b]), [number(xn) + 1e12, yn]]
  return `pwl(${x}, ${all.map(([a, b]) => `${a},${number(b)}`).join(', ')})`
}
const rewriteBraces = (line, warn) => {
  let out = '', i = 0
  while (i < line.length) {
    const open = line.indexOf('{', i)
    if (open < 0) return out + line.slice(i)
    let j = open + 1, depth = 1
    while (j < line.length && depth) { if (line[j] === '{') depth++; if (line[j] === '}') depth--; j++ }
    out += line.slice(i, open) + '{' + rewriteExpr(line.slice(open + 1, j - 1), warn) + '}'
    i = j
  }
  return out
}

// ---------- 소자 ----------
const tokensOf = (line) => {
  const toks = []
  let cur = '', depth = 0
  for (const ch of line) {
    if (ch === '{' || ch === '(') depth++
    if (ch === '}' || ch === ')') depth--
    if (/\s/.test(ch) && depth <= 0) { if (cur) toks.push(cur); cur = '' } else cur += ch
  }
  if (cur) toks.push(cur)
  return toks
}
// how many leading tokens after the name are nodes (X: everything up to the subcircuit name)
function nodeCount(letter, toks) {
  switch (letter) {
    case 'R': case 'C': case 'L': case 'D': case 'V': case 'I': case 'B': case 'F': case 'H': case 'W': return 2 // F, H, W: then the controlling source
    case 'J': case 'Z': return 3
    case 'M': return 4
    case 'T': case 'S': return 4
    case 'E': case 'G': return /^(VALUE|TABLE|LAPLACE|FREQ|CHEBYSHEV)\b/i.test(toks[3] || '') ? 2 : /^POLY\(/i.test(toks[3] || '') ? 2 : 4
    // collector base emitter [substrate] model [area]: a name right after the fourth token means the fourth was a node
    case 'Q': return toks[5] && /^[A-Za-z_]/.test(toks[5]) && !toks[5].includes('=') && !/^OFF$/i.test(toks[5]) ? 4 : 3
    case 'X': {
      const p = toks.findIndex((t, i) => i > 0 && (/^PARAMS:?$/i.test(t) || t.includes('=')))
      return (p < 0 ? toks.length : p) - 2
    }
    default: return 0
  }
}
function parseElement(line) {
  const toks = tokensOf(line)
  const ref = toks[0], letter = ref[0].toUpperCase()
  const n = Math.max(0, nodeCount(letter, toks))
  const nodes = toks.slice(1, 1 + n)
  const rest = toks.slice(1 + n)
  const el = { ref, letter, nodes, rest, raw: line }
  if (letter === 'X') { el.model = rest[0]; el.value = rest[0] }
  else if ('DQMJZ'.includes(letter)) el.model = rest[0]
  else if ('SW'.includes(letter)) el.model = rest.at(-1)
  else el.value = rest.join(' ')
  return el
}
function renderElement(el) {
  return [el.ref, ...el.nodes.map(safeNode), ...el.rest].join(' ')
}
let extraLines = []
function translateElement(line, warn, stop) {
  const el = parseElement(line)
  if (el.letter === 'U') { stop(`${el.ref}: PSpice 디지털 소자는 이 시뮬레이터에 없어요`); return `* ${line}` }
  if (el.letter === 'Z') { stop(`${el.ref}: PSpice 의 IGBT(Z) 소자는 이 시뮬레이터에 없어요`); return `* ${line}` }
  if ('EG'.includes(el.letter)) {
    const kind = el.letter === 'E' ? 'V' : 'I'
    const after = el.rest.join(' ')
    const name = `B${el.ref}`
    const [a, b] = el.nodes.map(safeNode)
    let m
    if ((m = /^VALUE\s*=?\s*\{([\s\S]*)\}\s*$/i.exec(after))) return `${name} ${a} ${b} ${kind} = ${rewriteExpr(m[1], warn, { behavioral: true })}`
    if ((m = /^TABLE\s*\{([\s\S]*?)\}\s*=?\s*([\s\S]*)$/i.exec(after))) {
      const flat = []
      for (const p of m[2].matchAll(/\(\s*([^,\s()]+)\s*,?\s*([^,\s()]+)\s*\)/g)) flat.push(p[1], p[2])
      if (flat.length < 4) { stop(`${el.ref} 의 TABLE 을 읽지 못했어요`); return `* ${line}` }
      return `${name} ${a} ${b} ${kind} = ${tablePwl(rewriteExpr(m[1], warn, { behavioral: true }), flat)}`
    }
    if (/^(LAPLACE|FREQ|CHEBYSHEV)\b/i.test(after)) { stop(`${el.ref}: ${after.split(/[\s{]/)[0].toUpperCase()} 는 이 시뮬레이터에 없어요`); return `* ${line}` }
  }
  // breakout parts: C_C1 a b Cbreak 10p. The value is what counts; a model's tolerances and temperature terms are not simulated
  if ('RCL'.includes(el.letter) && /^[A-Za-z_]/.test(el.rest[0] || '') && /^[\d.{+-]/.test(el.rest[1] || '')) {
    warn(`${el.ref} 의 모델 ${el.rest[0]} 은 빼고 값만 썼어요(공차·온도 특성은 돌리지 않아요)`)
    el.rest = el.rest.slice(1)
  }
  // lossy line: T_T1 a 0 b 0 LEN=50 R=5000 L=0 G=0 C=20f
  if (el.letter === 'T' && /\bLEN\s*=/i.test(el.rest.join(' '))) {
    const name = `${el.ref}_LTRA`
    extraLines.push(`.MODEL ${name} LTRA(${el.rest.join(' ')})`)
    return `O${el.ref} ${el.nodes.map(safeNode).join(' ')} ${name}`
  }
  // PSpice TC=a,b; ngspice tc1= tc2=
  if ('RCL'.includes(el.letter)) el.rest = el.rest.flatMap((t) => {
    const m = /^TC=([^,]+)(?:,(.+))?$/i.exec(t)
    if (!m) return [t]
    return Number(m[1]) === 0 && Number(m[2] || 0) === 0 ? [] : [`tc1=${m[1]}`, ...(m[2] ? [`tc2=${m[2]}`] : [])]
  })
  return rewriteBraces(renderElement(el), warn)
}
function translateModel(line, stop, models) {
  // .MODEL name [AKO:base] kind(params)
  const m = /^\.MODEL\s+(\S+)\s+(?:AKO:(\S+)\s+)?([A-Za-z_]+)\s*\(?([\s\S]*?)\)?\s*$/i.exec(line)
  if (!m) return line
  const [, name, base, kindRaw, paramsRaw] = m
  const kind = kindRaw.toUpperCase()
  let params = paramsRaw
  if (base) {
    const parent = models.get(base.toUpperCase())
    if (parent) params = `${parent.params} ${params}`
    else stop(`${name}: AKO 로 가리킨 모델 ${base} 가 없어요`)
  }
  models.set(name.toUpperCase(), { kind, params })
  // BSIM4 cards from PSpice: LEVEL=8 with VERSION 4.x is level 14 here
  if (/^[NP]MOS$/.test(kind) && /\bLEVEL\s*=\s*8\b/i.test(params) && /\bVERSION\s*=\s*4/i.test(params)) params = params.replace(/\bLEVEL\s*=\s*8\b/i, 'LEVEL=14')
  if (kind === 'VSWITCH' || kind === 'ISWITCH') {
    const get = (k, d) => number(new RegExp(`\\b${k}\\s*=\\s*([^\\s,)]+)`, 'i').exec(params)?.[1] ?? d)
    const on = kind === 'VSWITCH' ? get('VON', 1) : get('ION', 1e-3), off = kind === 'VSWITCH' ? get('VOFF', 0) : get('IOFF', 0)
    const th = (on + off) / 2, hy = Math.abs(on - off) / 2
    return kind === 'VSWITCH'
      ? `.MODEL ${name} SW(VT=${th} VH=${hy} RON=${get('RON', 1)} ROFF=${get('ROFF', 1e6)})`
      : `.MODEL ${name} CSW(IT=${th} IH=${hy} RON=${get('RON', 1)} ROFF=${get('ROFF', 1e6)})`
  }
  return `.MODEL ${name} ${kind}(${params.replace(/,/g, ' ').trim()})`
}
function translateTran(line, warn) {
  const toks = line.split(/\s+/)
  const clean = toks.filter((t) => !/^\/OP$|^SKIPBP$/i.test(t))
  if (toks.some((t) => /^SKIPBP$/i.test(t))) warn('.TRAN 의 SKIPBP 는 UIC 로 옮겼어요')
  const args = clean.slice(1).filter((t) => !/^UIC$/i.test(t))
  const uic = toks.some((t) => /^(UIC|SKIPBP)$/i.test(t)) ? ' UIC' : ''
  let [tstep, tstop, tstart, tmax] = args
  if (tstop === undefined) return line
  if (Number.parseFloat(tstep) === 0) tstep = scaleTime(tstop, 1 / 1000)
  return `.TRAN ${[tstep, tstop, tstart, tmax].filter((x) => x !== undefined).join(' ')}${uic}`
}
const SUFFIX = { T: 1e12, G: 1e9, MEG: 1e6, K: 1e3, M: 1e-3, U: 1e-6, N: 1e-9, P: 1e-12, F: 1e-15, MIL: 25.4e-6 }
export function number(s) {
  const m = /^\s*([+-]?[\d.]+(?:E[+-]?\d+)?)\s*(MEG|MIL|[TGKMUNPF])?/i.exec(String(s))
  if (!m) return NaN
  return Number(m[1]) * (m[2] ? SUFFIX[m[2].toUpperCase()] : 1)
}
const scaleTime = (s, k) => String(number(s) * k)

// ---------- 라이브러리 ----------
const baseName = (p) => String(p).replace(/^"|"$/g, '').split(/[\\/]/).pop().toLowerCase()
function libUnits(text) {
  const units = { subckts: new Map(), models: new Map() }
  let cur = null
  for (const l of logicalLines(text)) {
    if (l.comment) continue
    const t = l.text
    if (/^\.SUBCKT\b/i.test(t)) { cur = { name: t.split(/\s+/)[1], lines: [t] }; continue }
    if (cur) {
      cur.lines.push(t)
      if (/^\.ENDS\b/i.test(t)) { units.subckts.set(cur.name.toUpperCase(), cur); cur = null }
      continue
    }
    if (/^\.MODEL\b/i.test(t)) units.models.set(t.split(/\s+/)[1].toUpperCase(), t)
  }
  return units
}
const wordsOf = (lines) => new Set(lines.join(' ').toUpperCase().split(/[\s(){},=]+/).filter(Boolean))
// only what the circuit uses: a vendor library holds thousands of parts, and one the simulator cannot read must not stop this circuit
function resolveIncludes(lines, files, warn, seen = new Set()) {
  const body = [], libs = []
  for (const l of lines) {
    const m = !l.comment && /^\.(INC|INCLUDE|LIB)\b\s*(.*)$/i.exec(l.text)
    if (!m) { body.push(l); continue }
    const kind = m[1].toUpperCase(), target = /^"([^"]*)"/.exec(m[2].trim())?.[1] ?? m[2].trim().split(/\s+/)[0] ?? ''
    if (!target || /^nom(d|_\w+)?\.lib$/i.test(baseName(target))) continue // PSpice's own part library: what it would have given shows up as missing parts
    const key = baseName(target)
    if (seen.has(key)) continue
    seen.add(key)
    const text = files?.[key] ?? Object.entries(files || {}).find(([k]) => baseName(k) === key)?.[1]
    if (text === undefined) { warn(`${target} 파일이 없어서 넣지 못했어요`); continue }
    if (kind === 'INC' || kind === 'INCLUDE') body.push(...resolveIncludes(logicalLines(text), files, warn, seen).body)
    else {
      libs.push(libUnits(text))
      // a library that pulls in other libraries
      const nested = resolveIncludes(logicalLines(text).filter((l) => !l.comment && /^\.(INC|INCLUDE|LIB)\b/i.test(l.text)), files, warn, seen)
      libs.push(...nested.libs, ...(nested.body.length ? [libUnits(nested.body.filter((l) => !l.comment).map((l) => l.text).join('\n'))] : []))
    }
  }
  return { body, libs }
}
function pickFromLibs(body, libs) {
  const picked = [], have = new Set()
  const local = body.filter((l) => !l.comment).map((l) => l.text)
  for (const t of local) { const m = /^\.(SUBCKT|MODEL)\s+(\S+)/i.exec(t); if (m) have.add(m[2].toUpperCase()) }
  let words = wordsOf(local), grew = true
  while (grew) {
    grew = false
    for (const lib of libs) {
      for (const [name, u] of lib.subckts) if (words.has(name) && !have.has(name)) { have.add(name); picked.push(...u.lines); words = new Set([...words, ...wordsOf(u.lines)]); grew = true }
      for (const [name, t] of lib.models) if (words.has(name) && !have.has(name)) { have.add(name); picked.push(t); words = new Set([...words, ...wordsOf([t])]); grew = true }
    }
  }
  return picked
}

// ---------- 읽기 ----------
export function read(text, { files } = {}) {
  const lines = logicalLines(text)
  const firstReal = lines.findIndex((l) => !l.comment)
  const isLibrary = firstReal >= 0 && /^\.(SUBCKT|MODEL)\b/i.test(lines[firstReal].text) && !lines.some((l) => !l.comment && ANALYSES.test(l.text))
  const title = lines[0]?.text?.replace(/^\*+\s*/, '') || ''
  const doc = { title, isLibrary, elements: [], models: [], subckts: [], params: [], analyses: [], options: [], includes: [], probes: [], others: [], warnings: [] }
  let sub = null
  const usable = isLibrary ? lines : lines.slice(lines[0]?.comment ? 1 : 1)
  for (const l of usable) {
    if (l.comment) continue
    const t = l.text
    if (/^\.END\b/i.test(t)) continue
    if (/^\.SUBCKT\b/i.test(t)) {
      const toks = tokensOf(t)
      const p = toks.findIndex((x) => /^PARAMS:?$/i.test(x))
      sub = { name: toks[1], pins: toks.slice(2, p < 0 ? undefined : p), params: p < 0 ? [] : toks.slice(p + 1), lines: [] }
      continue
    }
    if (sub) {
      if (/^\.ENDS\b/i.test(t)) { doc.subckts.push(sub); sub = null } else sub.lines.push(t)
      continue
    }
    if (/^\.MODEL\b/i.test(t)) { const m = /^\.MODEL\s+(\S+)\s+(?:AKO:\S+\s+)?([A-Za-z_]+)/i.exec(t); doc.models.push({ name: m?.[1], kind: m?.[2]?.toUpperCase(), raw: t }); continue }
    if (/^\.PARAM\b/i.test(t)) { doc.params.push(t); continue }
    if (ANALYSES.test(t)) { doc.analyses.push(t); continue }
    if (/^\.OPTIONS?\b/i.test(t)) { doc.options.push(t); continue }
    if (/^\.(INC|INCLUDE|LIB)\b/i.test(t)) { doc.includes.push(t); continue }
    if (/^\.PROBE/i.test(t)) { doc.probes.push(t); continue }
    if (t[0] === '.') { doc.others.push(t); continue }
    doc.elements.push(parseElement(t))
  }
  if (sub) doc.warnings.push(`.SUBCKT ${sub.name} 의 .ENDS 가 없어요`)
  if (files) { const r = resolveIncludes(lines.filter((l) => !l.comment && /^\.(INC|INCLUDE|LIB)\b/i.test(l.text)), files, (w) => doc.warnings.push(w)); doc.libraries = r.libs.length }
  return doc
}

// ---------- 시뮬레이터용으로 옮기기 ----------
export function toNgspice(text, { files } = {}) {
  const warnings = [], unsupported = []
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w) }
  const stop = (w) => { if (!unsupported.includes(w)) unsupported.push(w) }
  const all = logicalLines(text)
  const first = all.findIndex((l) => !l.comment || all[0].comment)
  const title = all[first >= 0 ? first : 0]?.text?.replace(/^\*+\s*/, '') || 'circuit'
  const rest = all.slice((first >= 0 ? first : 0) + 1)
  const { body: whole, libs } = resolveIncludes(rest, files, warn)
  const end = whole.findIndex((l) => !l.comment && /^\.END\b/i.test(l.text) && !/^\.ENDS\b/i.test(l.text))
  const body = end < 0 ? whole : whole.slice(0, end)
  if (end >= 0 && whole.slice(end + 1).some((l) => !l.comment)) warn('.END 뒤의 내용은 돌리지 않았어요(파일 하나에 회로 하나만 돌려요)')
  const lines = [...body.filter((l) => !l.comment).map((l) => l.text), ...pickFromLibs(body, libs)]

  const out = [], analyses = [], steps = [], models = new Map()
  const body0 = out, fours = []
  extraLines = []
  let temps = null
  for (const t of lines) {
    if (/^\.END\b/i.test(t)) continue
    if (DROPPED.test(t)) continue
    if (NOT_SIMULATED.test(t)) { warn(`${t.split(/\s+/)[0].toUpperCase()} 은 돌리지 않았어요(몬테카를로·최악 조건·민감도는 아직 없어요)`); continue }
    if (/^\.STEP\b/i.test(t)) { const s = parseStep(t, stop); if (s) steps.push(s); continue }
    if (/^\.TEMP\b/i.test(t)) { temps = t.split(/\s+/).slice(1); continue }
    if (/^\.OPTIONS?\b/i.test(t)) {
      const kept = t.split(/\s+/).slice(1).filter((o) => KEPT_OPTIONS.has(o.split('=')[0].toUpperCase()))
      if (kept.length) out.push(`.OPTIONS ${kept.join(' ')}`)
      continue
    }
    if (/^\.FOUR\b/i.test(t)) { fours.push(plainNodes(t)); continue }
    if (ANALYSES.test(t)) { const a = plainNodes(t); analyses.push(/^\.TRAN\b/i.test(a) ? translateTran(a, warn) : /^\.DC\b/i.test(a) ? translateDc(a, stop) : a); continue }
    if (/^\.MODEL\b/i.test(t)) { out.push(translateModel(t, stop, models)); continue }
    if (/^\.SUBCKT\b/i.test(t)) {
      const toks = tokensOf(t)
      const p = toks.findIndex((x) => /^(PARAMS:?|OPTIONAL:?)$/i.test(x))
      if (toks.some((x) => /^OPTIONAL:?$/i.test(x))) stop(`.SUBCKT ${toks[1]} 의 OPTIONAL: 노드는 이 시뮬레이터에 없어요`)
      out.push(rewriteBraces(['.SUBCKT', toks[1], ...toks.slice(2, p < 0 ? undefined : p).map(safeNode), ...(p < 0 ? [] : toks.slice(p))].join(' '), warn))
      continue
    }
    if (/^\.(IC|NODESET)\b/i.test(t)) { out.push(t.replace(/\bV\(\s*([^()]+?)\s*\)/gi, (_, n) => `V(${safeNode(n)})`)); continue }
    if (/^\.(PARAM|FUNC)\b/i.test(t)) { out.push(rewriteBraces(rewriteParamLine(t, warn), warn)); continue }
    if (t[0] === '.') { out.push(t); continue }
    out.push(translateElement(t, warn, stop))
  }
  // Capture's part reference VDS is the element V_VDS in its netlist
  const refs = new Set(out.filter((l) => /^[VIR]/i.test(l)).map((l) => l.split(/\s+/)[0].toUpperCase()))
  const element = (n) => (refs.has(n.toUpperCase()) ? n : ['V_', 'I_', 'R_'].map((x) => x + n).find((x) => refs.has(x.toUpperCase())) || n)
  for (const [i, a] of analyses.entries()) {
    if (/^\.TF\b/i.test(a)) { const k = a.split(/\s+/); k[2] = element(k[2] || ''); analyses[i] = k.join(' ') }
    if (/^\.NOISE\b/i.test(a)) { const k = a.split(/\s+/); k[2] = element(k[2] || ''); analyses[i] = k.join(' ') }
    if (/^\.DC\b/i.test(a) && !/\bPARAM\b/i.test(a)) { const k = a.split(/\s+/); k[1] = element(k[1]); if (k[5]) k[5] = element(k[5]); analyses[i] = k.join(' ') }
  }
  for (const [i, a] of analyses.entries()) {
    if (!/^\.NOISE\b/i.test(a)) continue
    const ac = analyses.find((x) => /^\.AC\b/i.test(x))
    if (!ac) { stop('.NOISE 에는 .AC 가 함께 있어야 해요'); continue }
    const [, nv, src] = a.split(/\s+/), sweep = ac.split(/\s+/).slice(1)
    analyses[i] = `.NOISE ${nv} ${src} ${sweep.join(' ')}`
    // PSpice takes the input source as it is; ngspice wants an AC value on it
    const j = body0.findIndex((l) => l.split(/\s+/)[0].toUpperCase() === src.toUpperCase())
    if (j >= 0 && !/\bAC\b/i.test(body0[j])) body0[j] += ' AC 1'
  }
  out.push(...extraLines)
  // .INC 한 넷리스트가 없으면 소자가 하나도 없다: "결과 없음"보다 이유를 말한다
  let depth = 0, top = 0
  for (const l of out) { if (/^\.SUBCKT\b/i.test(l)) depth++; else if (/^\.ENDS\b/i.test(l)) depth--; else if (!depth && l[0] !== '.' && l[0] !== '*') top++ }
  if (!top) stop(warnings.find((w) => /파일이 없어서/.test(w)) || (out.some((l) => /^\.SUBCKT\b/i.test(l)) ? '부품 정의만 있고 돌릴 회로가 없어요(라이브러리 파일이에요)' : '회로에 소자가 없어요'))
  // Cadence 로 암호화한 벤더 모델: PSpice 만 풀 수 있다
  const sealed = lines.findIndex((l) => /^\$CDNENC/i.test(l))
  if (sealed >= 0) {
    let name = ''
    for (let i = sealed; i >= 0 && !name; i--) name = /^\.SUBCKT\s+(\S+)/i.exec(lines[i])?.[1] || ''
    stop(`${name || '이 부품'} 모델은 Cadence 로 암호화되어 있어 PSpice 밖에서는 돌릴 수 없어요. 암호화하지 않은 모델을 구해 주세요`)
  }
  if (fours.length && !analyses.some((a) => /^\.TRAN\b/i.test(a))) warn('.FOUR 는 .TRAN 이 있어야 돌아요')
  const missing = missingParts(lines)
  // 보드 하나면 수십 개다: 한 줄로 묶는다
  if (missing.length > 3) stop(`부품 모델 ${missing.length}개가 없어요: ${missing.slice(0, 4).map((m) => m.name).join(', ')} 외 ${missing.length - 4}개. 정의가 든 라이브러리 파일을 함께 주세요`)
  else for (const m of missing) stop(`${m.name} 모델이 없어요(${m.refs.slice(0, 3).join(', ')}). ${m.kind} 정의가 든 라이브러리 파일을 함께 주세요`)
  if (!analyses.length) warn('해석 명령(.TRAN .AC .DC .OP)이 없어서 동작점만 구해요')
  const runs = []
  // 값을 바꾼 .PARAM 줄들: 한 줄에 여러 값이 있을 수 있다
  const overrides = (params) => {
    let depth = 0
    return out.map((l) => {
      if (/^\.SUBCKT\b/i.test(l)) depth++
      else if (/^\.ENDS\b/i.test(l)) depth--
      if (depth || !/^\.PARAM\b/i.test(l)) return l
      for (const [name, value] of Object.entries(params)) l = l.replace(new RegExp(`\\b${name}\\s*=\\s*[^\\s,]+`, 'i'), `${name}=${value}`)
      return l
    })
  }
  for (const combo of stepCombos(steps, temps)) {
    for (const a of analyses.length ? analyses : ['.OP']) {
      if (/^\.DC\b.*\bPARAM\b/i.test(a)) {
        const sweep = parseDcParam(a, stop)
        if (!sweep) continue
        for (const outerValue of sweep.outer ? sweep.outer.values : [null]) {
          for (const v of sweep.inner.values) {
            const params = { ...combo.params, [sweep.inner.name]: v, ...(sweep.outer ? { [sweep.outer.name]: outerValue } : {}) }
            const extra = Object.keys(params).filter((n) => !out.some((l) => new RegExp(`^\\.PARAM\\b.*\\b${n}\\s*=`, 'i').test(l))).map((n) => `.PARAM ${n}=${params[n]}`)
            const step = [combo.label, sweep.outer ? `${sweep.outer.name}=${outerValue}` : ''].filter(Boolean).join(' ')
            runs.push({ label: `DC ${sweep.inner.name}${step ? ` ${step}` : ''}`, analysis: a, step: step || null, sweep: { name: sweep.inner.name, value: number(v) },
              netlist: [`* ${title}`, ...extra, ...overrides(params), '.OP', '.END', ''].join('\n') })
          }
        }
        continue
      }
      const label = [a.split(/\s+/)[0].slice(1).toUpperCase(), combo.label].filter(Boolean).join(' ')
      const body2 = overrides(combo.params)
      const extra = Object.entries(combo.params).filter(([n]) => !out.some((l) => new RegExp(`^\\.PARAM\\b.*\\b${n}\\s*=`, 'i').test(l))).map(([n, v]) => `.PARAM ${n}=${v}`)
      runs.push({ label, analysis: a, step: combo.label || null, netlist: [`* ${title}`, ...extra, ...(combo.temp !== undefined ? [`.TEMP ${combo.temp}`] : []), ...body2, a, ...(/^\.TRAN\b/i.test(a) ? fours : []), '.END', ''].join('\n') })
    }
  }
  return { title, runs, warnings, unsupported, missing }
}
// 회로가 부르는데 어디에도 정의가 없는 부품: 시뮬레이터가 알아듣기 어렵게 멈추기 전에 이름으로 알린다
function missingParts(lines) {
  const subckts = new Set(), models = new Set(), used = new Map()
  for (const t of lines) {
    const m = /^\.(SUBCKT|MODEL)\s+(\S+)/i.exec(t)
    if (m) (m[1].toUpperCase() === 'SUBCKT' ? subckts : models).add(m[2].toUpperCase())
  }
  for (const t of lines) {
    if (t[0] === '.' || !/^[A-Za-z]/.test(t)) continue
    const el = parseElement(t)
    if (!el.model) continue
    const isSub = el.letter === 'X'
    const name = el.model.toUpperCase()
    if (isSub ? subckts.has(name) : models.has(name)) continue
    if (!isSub && /[={]/.test(el.model)) continue
    if (!used.has(name)) used.set(name, { name: el.model, kind: isSub ? '서브회로' : '모델', refs: [] })
    used.get(name).refs.push(el.ref)
  }
  return [...used.values()]
}
// Capture writes nodes in brackets: V([OUT])
const plainNodes = (t) => t.replace(/\[([^\]\s]+)\]/g, '$1').replace(/\bV\(\s*([^(),]+?)\s*(?:,\s*([^(),]+?)\s*)?\)/gi, (_, a, b) => (b && b !== '0' ? `V(${safeNode(a)},${safeNode(b)})` : `V(${safeNode(a)})`))
const rewriteParamLine = (t, warn) => t.replace(/=\s*([^{}\s,][^\s,]*\([^\s]*\))/g, (m, e) => `= {${rewriteExpr(e, warn)}}`)
function translateDc(t, stop) {
  const toks = t.split(/\s+/)
  if (toks.some((x) => /^PARAM$/i.test(x))) return t // sweeps a parameter: toNgspice expands it into runs
  if (/^(DEC|OCT)$/i.test(toks[1])) stop(`로그 스윕 .DC 는 아직 옮기지 못해요: ${t}`)
  return `.DC ${toks.slice(1).filter((x) => !/^LIN$/i.test(x)).join(' ')}`
}
// .DC [LIN] PARAM name start stop step [[LIN] PARAM name start stop step]: the first sweeps, the second steps
function parseDcParam(a, stop) {
  const groups = []
  const toks = a.split(/\s+/).slice(1).filter((x) => !/^LIN$/i.test(x))
  for (let i = 0; i < toks.length;) {
    if (!/^PARAM$/i.test(toks[i])) { stop(`소스와 파라미터를 섞은 .DC 는 아직 옮기지 못해요: ${a}`); return null }
    const name = toks[i + 1], [from, to, by] = toks.slice(i + 2, i + 5).map(number)
    const values = []
    if (!(by > 0) && !(by < 0)) { stop(`.DC 의 간격을 읽지 못했어요: ${a}`); return null }
    for (let v = from; by > 0 ? v <= to * (1 + 1e-9) + 1e-12 : v >= to * (1 + 1e-9) - 1e-12; v += by) values.push(String(+v.toPrecision(12)))
    groups.push({ name, values })
    i += 5
  }
  const total = groups.reduce((n, g) => n * g.values.length, 1)
  if (!groups.length || total > 400) { stop(`.DC PARAM 점이 너무 많아요(${total}개): ${a}`); return null }
  return { inner: groups[0], outer: groups[1] }
}
// .OP 를 한 점씩 돌린 DC 파라미터 스윕을 곡선 하나로 묶는다. 실패한 점이 있으면 그 곡선은 실패다
export function mergeSweeps(results) {
  const out = [], groups = new Map()
  for (const r of results) {
    if (!r.sweep) { out.push(r); continue }
    let g = groups.get(r.label)
    if (!g) { g = { label: r.label, analysis: r.analysis, step: r.step, points: [], ok: true }; groups.set(r.label, g); out.push(g) }
    g.points.push(r)
    if (!r.ok) { g.ok = false; g.error = r.error }
  }
  for (const g of groups.values()) {
    const pts = g.points
    delete g.points
    g.ms = pts.reduce((a, p) => a + (p.ms || 0), 0)
    if (!g.ok) continue
    const names = pts[0].data.map((d) => d.name)
    g.dataType = 'real'; g.numPoints = pts.length
    g.data = [{ name: pts[0].sweep.name, type: 'notype', values: pts.map((p) => p.sweep.value) }, ...names.map((n, i) => ({ name: n, type: pts[0].data[i].type, values: pts.map((p) => p.data[i]?.values[0]) }))]
  }
  return out
}
function parseStep(t, stop) {
  const toks = t.split(/\s+/).slice(1)
  let i = 0
  const mode = /^(LIN|DEC|OCT)$/i.test(toks[0]) ? toks[i++].toUpperCase() : 'LIN'
  let kind = 'PARAM', name
  if (/^PARAM$/i.test(toks[i])) { i++; name = toks[i++] }
  else if (/^TEMP$/i.test(toks[i])) { i++; kind = 'TEMP'; name = 'TEMP' }
  else { stop(`.STEP 은 PARAM 과 TEMP 만 옮겨요: ${t}`); return null }
  let values
  if (/^LIST$/i.test(toks[i])) values = toks.slice(i + 1)
  else {
    const [a, b, c] = toks.slice(i).map(number)
    if (mode !== 'LIN') { stop(`로그 .STEP 은 아직 옮기지 못해요: ${t}`); return null }
    values = []
    for (let v = a; c > 0 ? v <= b * (1 + 1e-9) : v >= b * (1 + 1e-9); v += c) values.push(String(+v.toPrecision(12)))
    if (values.length > 50) { stop(`.STEP 값이 너무 많아요(${values.length}개): ${t}`); return null }
  }
  return { kind, name, values }
}
function stepCombos(steps, temps) {
  let combos = [{ params: {}, label: '' }]
  const add = (fn, values, labelOf) => { const next = []; for (const c of combos) for (const v of values) next.push(fn({ ...c, params: { ...c.params } }, v, labelOf)); combos = next }
  for (const s of steps) add((c, v) => { if (s.kind === 'TEMP') c.temp = v; else c.params[s.name] = v; c.label = [c.label, `${s.name}=${v}`].filter(Boolean).join(' '); return c }, s.values)
  if (temps?.length) add((c, v) => { c.temp = v; if (temps.length > 1) c.label = [c.label, `TEMP=${v}`].filter(Boolean).join(' '); return c }, temps)
  return combos
}

// ---------- 쓰기 ----------
// 읽은 문서를 PSpice 넷리스트로: 소자는 받은 글 그대로, 옮기기 전 문법 그대로 쓴다. 다시 읽으면 같은 회로다.
export function write(doc) {
  const line = []
  line.push(`* ${doc.title || 'circuit'}`)
  for (const i of doc.includes || []) line.push(i)
  for (const p of doc.params || []) line.push(p)
  for (const o of doc.options || []) line.push(o)
  for (const e of doc.elements || []) line.push(wrap(e.raw || [e.ref, ...e.nodes, ...(e.rest || [e.value])].filter(Boolean).join(' ')))
  for (const m of doc.models || []) line.push(wrap(m.raw))
  for (const s of doc.subckts || []) {
    line.push([`.SUBCKT ${s.name}`, ...s.pins, ...(s.params?.length ? ['PARAMS:', ...s.params] : [])].join(' '))
    for (const l of s.lines) line.push(wrap(l))
    line.push(`.ENDS ${s.name}`)
  }
  for (const o of doc.others || []) line.push(o)
  for (const a of doc.analyses || []) line.push(a)
  for (const p of doc.probes?.length ? doc.probes : (doc.isLibrary ? [] : ['.PROBE'])) line.push(p)
  if (!doc.isLibrary) line.push('.END')
  return line.join('\n') + '\n'
}
function wrap(s, width = 120) {
  if (!s || s.length <= width) return s
  const parts = tokensOf(s), rows = []
  let cur = ''
  for (const p of parts) {
    if (cur && cur.length + p.length + 1 > width) { rows.push(cur); cur = `+ ${p}` } else cur = cur ? `${cur} ${p}` : p
  }
  rows.push(cur)
  return rows.join('\n')
}
