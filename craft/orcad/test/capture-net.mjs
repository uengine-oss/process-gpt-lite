// Capture 가 직접 만든 넷리스트(.net + .als)와 dsnToNetlist 결과를 대조한다. 정답은 Capture 쪽이다.
//   findPairs(dir)              → [{ dsn, net, als, view }]  설계와 넷리스트 짝
//   parseAls(text)              → 소자별 핀→넷 표
//   parseNet(text)              → 소자별 줄 (.subckt 안은 뺀다)
//   compare(result, net, als)   → { refs, connectivity, values, ... }
// 넷 이름은 비교하지 않는다. 넷은 핀의 묶음(분할)으로 비교한다.
import fs from 'node:fs'
import path from 'node:path'

export function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    const isDir = e.isDirectory() || (e.isSymbolicLink() && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory())
    if (isDir) walk(p, out)
    else out.push(p)
  }
  return out
}

// <설계>-PSpiceFiles/<회로도>/<회로도>.net, 또는 설계 옆의 <설계>-<회로도>.net
export function findPairs(dir, files = dir ? walk(dir) : []) {
  const dsns = files.filter((f) => /\.dsn$/i.test(f))
  const nets = files.filter((f) => /\.net$/i.test(f))
  const alsOf = (net) => {
    const stem = net.replace(/\.net$/i, '').toLowerCase()
    return files.find((f) => /\.als$/i.test(f) && f.replace(/\.als$/i, '').toLowerCase() === stem) ?? null
  }
  const pairs = []
  for (const dsn of dsns) {
    const base = path.dirname(dsn), stem = path.basename(dsn).replace(/\.dsn$/i, '').toLowerCase()
    for (const net of nets) {
      const rel = path.relative(base, net).split(path.sep)
      if (rel[0] === '..') continue
      let view = null
      if (rel[0].toLowerCase() === `${stem}-pspicefiles`) view = rel.length >= 3 ? rel[1] : rel.at(-1).replace(/\.net$/i, '')
      else if (rel.length === 1 && rel[0].toLowerCase().startsWith(`${stem}-`)) view = rel[0].replace(/\.net$/i, '').slice(stem.length + 1)
      if (view !== null) pairs.push({ dsn, net, als: alsOf(net), view })
    }
  }
  return pairs
}

const CONT = '\u0001'
const logical = (text) => {
  const out = []
  for (const raw of String(text).split(/\r?\n/)) {
    // 이어진 줄의 + 는 표시로 남긴다. 넷 이름 +VCC 의 + 와 섞이면 안 된다.
    if (/^\+/.test(raw) && out.length) out[out.length - 1] += ` ${CONT}${raw.replace(/^\+\s*/, '')}`
    else out.push(raw)
  }
  return out
}

// V_Vphi1  Vphi1(+=PHI1 -=0 ) CN @...      소자
// _        U1(VINM=N02284 VINP=VCM ) CN @… 계층 블록
// _        _(U1.Out=VOUT)                  별칭 (쓰지 않는다)
export function parseAls(text) {
  const elements = new Map(), blocks = new Map()
  const merged = []
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\+/.test(raw) && merged.length) merged[merged.length - 1] += ` ${raw.slice(1)}`
    else merged.push(raw)
  }
  for (const line of merged) {
    const m = /^(\S+)\s+(\S*?)\((.*?)\)\s*(?:CN\b|$)/.exec(line)
    if (!m || /^\./.test(line)) continue
    const [, spice, name, body] = m
    if (name === '_' || name === '') continue
    const pins = []
    for (const t of body.trim().split(/\s+/)) {
      const eq = t.lastIndexOf('=')
      if (eq > 0) pins.push({ pin: t.slice(0, eq), net: t.slice(eq + 1) })
    }
    const entry = { spice, name, pins, line }
    if (spice === '_') blocks.set(name.toUpperCase(), entry)
    else elements.set(spice.toUpperCase(), entry)
  }
  return { elements, blocks }
}

export function parseNet(text) {
  const elements = new Map(), subckts = new Map(), dots = []
  let current = null
  for (const line of logical(text)) {
    const t = line.trim()
    if (!t || t[0] === '*' || t[0] === ';') continue
    if (/^\.subckt\b/i.test(t)) { current = { name: t.split(/\s+/)[1].toUpperCase(), header: norm(t), body: [] }; subckts.set(current.name, current); continue }
    if (/^\.ends\b/i.test(t)) { current = null; continue }
    if (current) { current.body.push(norm(t)); continue }
    if (t[0] === '.') { dots.push(norm(t)); continue }
    const tokens = t.split(/\s+/)
    elements.set(tokens[0].toUpperCase(), { ref: tokens[0], tokens, line: t })
  }
  return { elements, subckts, dots }
}

const norm = (t) => t.replaceAll(CONT, '').replace(/\s+/g, ' ').trim().toUpperCase()

// 내 소자 줄 → { 이름, 노드 위치별 넷, 나머지 }
function myElements(result) {
  const out = new Map()
  for (const el of result.elements) {
    if (el.text === null) { out.set(String(el.spiceRef).toUpperCase(), { ref: el.ref, untemplated: true }); continue }
    // 첫 소자 줄과 그 이어짐만 본다. 뒤따르는 .model, .subckt 는 소자가 아니다.
    const first = logical(el.text.split(/\n(?=\.)/)[0])[0]
    const tokens = first.trim().split(/\s+/)
    out.set(tokens[0].toUpperCase(), { ref: el.ref, tokens })
  }
  return out
}

// 두 표가 같은 분할인지: a[i] 와 b[i] 는 같은 핀의 넷 이름. 미연결(null) 은 저마다 혼자인 넷으로 친다.
export function samePartition(pairs) {
  const a2b = new Map(), b2a = new Map()
  const bad = []
  for (const { key, a, b } of pairs) {
    if (a === null || b === null) continue
    if (a2b.has(a) && a2b.get(a) !== b) bad.push({ key, mine: a, capture: b, expectedCapture: a2b.get(a) })
    else a2b.set(a, b)
    if (b2a.has(b) && b2a.get(b) !== a) bad.push({ key, mine: a, capture: b, expectedMine: b2a.get(b) })
    else b2a.set(b, a)
  }
  return bad
}

// 줄 나눔 표시 +, 효과 없는 TC=0,0(최근 Capture 는 생략한다)을 뺀 낱말들
const lineTokens = (tokens) => tokens.join(' ').replaceAll(CONT, '').replace(/\bTC=0,0\b/gi, '').trim().split(/\s+/).filter(Boolean)

// 소자 글자별 노드 수. .als 가 없는 넷리스트에서만 쓴다. X 는 마지막 하나(PARAMS: 앞)를 뺀 전부.
function nodeCountWithoutAls(tokens) {
  const letter = tokens[0][0].toUpperCase()
  const fixed = { R: 2, C: 2, L: 2, D: 2, V: 2, I: 2, Q: 3, J: 3, M: 4, E: 4, G: 4, F: 4, H: 4, S: 4, T: 4 }[letter]
  if (fixed !== undefined) return Math.min(fixed, tokens.length - 1)
  const params = tokens.findIndex((t) => /^PARAMS:?$/i.test(t))
  return (params < 0 ? tokens.length : params) - 2
}

// 한 설계 대조. Capture 줄과 내 줄을 낱말 단위로 맞춘다.
//   Capture 쪽 낱말이 그 소자의 넷이면(.als) 넷 짝으로 모아 분할을 비교하고, 아니면 글자가 같아야 한다(값, 모델 이름, 매개변수).
export function compare(result, netText, alsText) {
  const cap = parseNet(netText)
  const als = alsText ? parseAls(alsText) : { elements: new Map(), blocks: new Map() }
  const mine = myElements(result)

  const capRefs = [...cap.elements.keys()], myRefs = [...mine.keys()]
  const missing = capRefs.filter((r) => !mine.has(r))
  // PSpiceTemplate 가 없는 부품(커넥터 등)은 Capture 가 시뮬레이션 넷리스트에 쓰지 않는다. 내 쪽에는 남긴다.
  const extra = myRefs.filter((r) => !cap.elements.has(r) && !mine.get(r).untemplated)
  const extraUntemplated = myRefs.filter((r) => !cap.elements.has(r) && mine.get(r).untemplated)

  const pairs = [], nodeTrouble = [], valueDiffs = []
  let compared = 0, valuesCompared = 0, pinsCompared = 0

  // 넷마다 Capture 에서 몇 개의 핀이 붙는가. 내가 미연결로 읽은 핀이 실제로 여럿 붙는 넷에 있으면 틀린 것이다.
  const pinsOnNet = new Map()
  for (const entry of als.elements.values()) for (const p of entry.pins) pinsOnNet.set(p.net, (pinsOnNet.get(p.net) || 0) + 1)
  for (const [ref, c] of cap.elements) {
    const m = mine.get(ref)
    if (!m) continue
    if (!m.tokens) { nodeTrouble.push(`${ref}: Capture 는 템플릿으로 썼는데 내 쪽엔 템플릿이 없어요`); continue }
    compared++
    const ct = lineTokens(c.tokens)
    // Capture 는 미연결 핀의 노드를 아예 쓰지 않는다(혼자인 넷 이름을 줄 때도 있다). 나는 NC_ 로 쓴다.
    const hadNc = m.tokens.some((t) => /^NC_/.test(t))
    const mt = lineTokens(m.tokens)
    const entry = als.elements.get(ref)
    const nets = entry ? new Set(entry.pins.map((p) => p.net)) : null
    const nodeLimit = entry ? Infinity : nodeCountWithoutAls(ct)

    let i = 1, j = 1
    let differ = false
    while (i < ct.length || j < mt.length) {
      const a = mt[j], b = ct[i]
      if (a !== undefined && /^NC_/.test(a)) {
        // 내 NC 와 Capture 의 혼자인 넷이 같은 자리면 둘 다 넘긴다. 혼자가 아니면 내가 틀렸다.
        if (b !== undefined && (nets ? nets.has(b) : i <= nodeLimit)) {
          if ((pinsOnNet.get(b) || 0) > 1) nodeTrouble.push(`${ref}: 미연결로 읽었는데 Capture 는 ${b} 에 있어요`)
          i++
        }
        j++
        continue
      }
      if (b === undefined || a === undefined) { differ = true; break }
      const isNet = nets ? nets.has(b) : i <= nodeLimit
      if (isNet) { pairs.push({ key: `${ref}.${i}`, a, b }); pinsCompared++ }
      else if (a.toUpperCase() !== b.toUpperCase()) differ = true
      i++; j++
    }
    valuesCompared++
    if (differ) valueDiffs.push({ ref, capture: ct.slice(1).join(' '), mine: mt.slice(1).join(' ') })
  }
  const partitionBad = samePartition(pairs)

  // 템플릿이 만든 .subckt 와 .model: 스위치의 Ron·Roff, 소자별 모델의 값이 여기 있다
  const myText = parseNet(result.text)
  for (const [name, c] of cap.subckts) {
    const m = myText.subckts.get(name)
    if (!m) { valueDiffs.push({ ref: `.subckt ${name}`, capture: c.header, mine: '(없음)' }); continue }
    valuesCompared++
    if (m.header !== c.header || [...m.body].sort().join('|') !== [...c.body].sort().join('|')) valueDiffs.push({ ref: `.subckt ${name}`, capture: [c.header, ...c.body].join(' | '), mine: [m.header, ...m.body].join(' | ') })
  }
  const dotKey = (t) => /^\.(MODEL|PARAM)\b/.test(t)
  const capDots = cap.dots.filter(dotKey).sort(), myDots = myText.dots.filter(dotKey).sort()
  if (capDots.join('|') !== myDots.join('|')) valueDiffs.push({ ref: '.model/.param', capture: capDots.filter((d) => !myDots.includes(d)).join(' | '), mine: myDots.filter((d) => !capDots.includes(d)).join(' | ') })

  return {
    capture: capRefs.length,
    mine: myRefs.length,
    missing,
    extra,
    extraUntemplated,
    compared,
    pinsCompared,
    refsOk: missing.length === 0 && extra.length === 0,
    connectivityOk: partitionBad.length === 0 && nodeTrouble.length === 0 && compared > 0,
    partitionBad,
    nodeTrouble,
    valuesOk: valueDiffs.length === 0,
    valueDiffs,
    valuesCompared,
    get ok() { return this.refsOk && this.connectivityOk && this.valuesOk },
  }
}
