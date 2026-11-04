// OrCAD Capture 설계(orcad2json 의 JSON)를 PSpice 넷리스트로 옮긴다.
//   dsnToNetlist(json, opts) → { title, text, parts, elements, nets, warnings, stats, bom() }
//   bom(parts)               → 값·부품으로 묶은 부품 표
//   flatten(json, opts)      → 연결 정보만 (넷리스트 글 없이)
//   expandTemplate(tpl, ctx) → PSpiceTemplate 한 줄을 Capture 처럼 편다
// opts: view(최상위 회로도 이름), mode('ids'|'geometry'), resolve(path, name, doc)(다른 설계 파일의 JSON 을 돌려준다), title
//
// 연결을 구하는 두 가지 길
//   ids      : Capture 가 파일에 적어 둔 값을 그대로 따른다. 핀 → 선(pin.wire), 선 → 넷(wire.net), 넷 → 이름(page.nets).
//   geometry : 좌표만으로 다시 구한다. 선 끝끼리·선 몸통에 닿은 끝, 핀·전원 기호·페이지 연결자의 연결점, 같은 페이지의 같은 이름.
// 기본은 ids 이고, ids 가 없는 JSON 이면 geometry 로 간다. 둘은 서로 다른 자료에서 나오므로 대조에 쓴다(test/dsn.test.mjs).
//
// 넷이 이어지는 범위 (Capture 와 같다)
//   별칭      : 페이지 안
//   페이지 연결자·포트 : 회로도 하나(같은 인스턴스) 안
//   전원 기호, 그려지지 않는 전원 핀 : 설계 전체
//   계층 블록 : 블록의 핀 ↔ 아래 회로도의 같은 이름 포트
// 의존성 없음.

export const GROUND_NAMES = new Set(['0', 'GND', 'GND_0', 'AGND', 'DGND'])

class UnionFind {
  constructor() { this.parent = new Map() }
  find(a) {
    if (!this.parent.has(a)) this.parent.set(a, a)
    let root = a
    while (this.parent.get(root) !== root) root = this.parent.get(root)
    while (this.parent.get(a) !== root) { const next = this.parent.get(a); this.parent.set(a, root); a = next }
    return root
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb) }
}

const upper = (s) => String(s).trim().toUpperCase()

// CAM_D[0..11], CAM_D[11:0], CAM_D[0-11] → CAM_D0 … CAM_D11
export function busMembers(name) {
  const m = /^(.*?)\[\s*(\d+)\s*(?:\.\.|:|-)\s*(\d+)\s*\](.*)$/.exec(String(name).trim())
  if (!m) return null
  const [, head, a, b, tail] = m
  const lo = Math.min(+a, +b), hi = Math.max(+a, +b)
  if (hi - lo > 4096) return null
  const out = []
  for (let i = lo; i <= hi; i++) out.push(`${head}${i}${tail}`)
  return out
}

const onSegment = (w, x, y) => {
  if (w.x1 === w.x2) return x === w.x1 && y >= Math.min(w.y1, w.y2) && y <= Math.max(w.y1, w.y2)
  if (w.y1 === w.y2) return y === w.y1 && x >= Math.min(w.x1, w.x2) && x <= Math.max(w.x1, w.x2)
  // 비스듬한 선은 끝에서만 잇는다
  return (x === w.x1 && y === w.y1) || (x === w.x2 && y === w.y2)
}

const connectorsOf = (page) => [
  ...(page.globals || []).map((c) => ({ ...c, kind: 'global' })),
  ...(page.offPage || []).map((c) => ({ ...c, kind: 'offpage' })),
  ...(page.ports || []).map((c) => ({ ...c, kind: 'port' })),
]

const hasIds = (doc) => (doc.pages || []).some((p) => (p.wires || []).length || (p.instances || []).length)
  && (doc.pages || []).every((p) => (p.wires || []).every((w) => typeof w.net === 'number') && (p.instances || []).every((i) => (i.pins || []).every((q) => typeof q.wire === 'number')))

// 이름의 무게: 위쪽 회로도가 먼저, 같은 높이면 전원 기호 > 페이지 연결자·포트 > 페이지 넷 표 > 별칭
const RANK = { global: 0, hidden: 0, offpage: 1, port: 1, page: 2, alias: 3 }
function addName(names, node, name, kind, path) {
  if (!String(name || '').trim()) return
  if (!names.has(node)) names.set(node, [])
  // 아래 회로도의 지역 넷은 경로를 붙여 부른다 (Capture 의 U2_VTRIP)
  const shown = String(name).trim()
  const everywhere = kind === 'global' || kind === 'hidden'
  names.get(node).push({ name: everywhere || !path.length ? shown : `${path.join('_')}_${shown}`, kind, depth: everywhere ? 0 : path.length })
}

// ---------- 페이지 안의 연결 ----------
function pageFromIds(ctx, page, pageKey, path) {
  const { uf, names, warn } = ctx
  const wireById = new Map()
  for (const w of page.wires || []) wireById.set(w.id, w)
  for (const n of page.nets || []) {
    const node = `${pageKey}:net:${n.id}`
    uf.find(node)
    addName(names, node, n.name, 'page', path)
    uf.union(node, `${pageKey}:name:${upper(n.name)}`) // 같은 페이지에서 같은 이름은 한 넷이다
  }
  for (const w of page.wires || []) {
    if (w.bus) continue
    const node = `${pageKey}:net:${w.net}`
    uf.find(node)
    for (const a of w.aliases || []) addName(names, node, a.name, 'alias', path)
  }

  const at = new Map()
  for (const c of connectorsOf(page)) {
    const key = `${c.x},${c.y}`
    if (!at.has(key)) at.set(key, [])
    at.get(key).push(c)
  }
  const pinsAt = new Map()
  for (const inst of page.instances || []) for (const pin of inst.pins || []) {
    const key = `${pin.x},${pin.y}`
    pinsAt.set(key, (pinsAt.get(key) || 0) + 1)
  }

  return (inst, pin) => {
    if (pin.wire > 0) {
      const w = wireById.get(pin.wire)
      if (w) return `${pageKey}:net:${w.net}`
      warn(`${page.name} ${inst.ref} 핀 ${pin.order}: 가리킨 선 ${pin.wire} 이 페이지에 없어요. 좌표로 찾았어요`)
      const hit = (page.wires || []).find((x) => !x.bus && onSegment(x, pin.x, pin.y))
      return hit ? `${pageKey}:net:${hit.net}` : null
    }
    if (pin.wire === 0) return null
    // -1: 선 없이 다른 것에 바로 닿아 있다
    const key = `${pin.x},${pin.y}`
    const node = `${pageKey}:direct:${key}`
    const conn = at.get(key)
    if (conn?.length) {
      for (const c of conn) {
        addName(names, node, c.name, c.kind, path)
        uf.union(node, `${pageKey}:name:${upper(c.name)}`)
      }
      return node
    }
    if ((pinsAt.get(key) || 0) > 1) return node
    warn(`${page.name} ${inst.ref} 핀 ${pin.order}: 선 없이 닿았다고 적혀 있는데 (${pin.x},${pin.y}) 에 아무것도 없어요`)
    return null
  }
}

function pageFromGeometry(ctx, page, pageKey, path, isHidden) {
  const { uf, names } = ctx
  const wires = (page.wires || []).filter((w) => !w.bus)
  const node = (i) => `${pageKey}:wire:${i}`
  wires.forEach((_, i) => uf.find(node(i)))

  // 선 끝이 다른 선에 닿으면 이어진다. 끝이 아닌 데서 십자로 지나가는 것은 잇지 않는다(Capture 와 같다).
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      const a = wires[i], b = wires[j]
      if (onSegment(a, b.x1, b.y1) || onSegment(a, b.x2, b.y2) || onSegment(b, a.x1, a.y1) || onSegment(b, a.x2, a.y2)) uf.union(node(i), node(j))
    }
  }

  // 같은 페이지의 같은 이름은 이어진다
  wires.forEach((w, i) => {
    for (const a of w.aliases || []) {
      addName(names, node(i), a.name, 'alias', path)
      uf.union(node(i), `${pageKey}:name:${upper(a.name)}`)
    }
  })

  const touching = (x, y) => wires.flatMap((w, i) => (onSegment(w, x, y) ? [i] : []))
  for (const c of connectorsOf(page)) {
    const n = `${pageKey}:name:${upper(c.name)}`
    addName(names, n, c.name, c.kind, path)
    uf.find(n)
    for (const i of touching(c.x, c.y)) uf.union(node(i), n)
  }

  const pins = (page.instances || []).flatMap((inst) => (inst.pins || []).filter((pin) => !isHidden(inst, pin)).map((pin) => `${pin.x},${pin.y}`))
  const count = new Map()
  for (const k of pins) count.set(k, (count.get(k) || 0) + 1)
  const conns = connectorsOf(page)
  return (inst, pin) => {
    const key = `${pin.x},${pin.y}`
    const hits = touching(pin.x, pin.y)
    const direct = conns.filter((c) => c.x === pin.x && c.y === pin.y)
    if (!hits.length && !direct.length && (count.get(key) || 0) < 2) return null
    const n = `${pageKey}:point:${key}`
    uf.find(n)
    for (const i of hits) uf.union(n, node(i))
    for (const c of direct) uf.union(n, `${pageKey}:name:${upper(c.name)}`)
    return n
  }
}

// ---------- 설계 전체 ----------
const viewsOf = (doc) => [...new Set((doc.pages || []).map((p) => p.view).filter((v) => v !== undefined))]
const sameName = (a, b) => upper(a) === upper(b)

// 최상위 회로도: 지정한 것, 파일에 적힌 것, 다른 회로도가 부르지 않는 것 순서
export function rootViewOf(json, wanted) {
  const views = viewsOf(json)
  if (wanted) return views.find((v) => sameName(v, wanted)) ?? null
  if (views.length <= 1) return views[0] ?? null
  const named = views.find((v) => sameName(v, json.rootSchematic || ''))
  if (named) return named
  const used = new Set()
  for (const p of json.pages) for (const i of p.instances || []) if (i.implementation?.name) used.add(upper(i.implementation.name))
  return views.find((v) => !used.has(upper(v))) ?? views[0]
}

export function flatten(json, opts = {}) {
  const warnings = []
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w) }
  const wantedMode = opts.mode

  const ctx = { uf: new UnionFind(), names: new Map(), warn }
  const { uf, names } = ctx
  const refs = new Map()
  const elements = []
  const netPins = new Map()
  const wiresOfNode = new Map()
  let unconnected = 0, flaggedConnected = 0, hiddenCount = 0, scopeCounter = 0
  const mixedRefs = []

  const indexes = new Map()
  const indexOf = (doc) => {
    if (indexes.has(doc)) return indexes.get(doc)
    const idx = { symbols: new Map(), packages: new Map(), ids: hasIds(doc) }
    for (const s of doc.symbols || []) if (s.kind === 'part' && !idx.symbols.has(s.name)) idx.symbols.set(s.name, s)
    for (const p of doc.parts || []) if (!idx.packages.has(p.name)) idx.packages.set(p.name, p)
    indexes.set(doc, idx)
    return idx
  }

  // 부품이 아래 회로도를 가리키면 그 회로도를 찾는다
  function childOf(doc, inst, symbol) {
    const impl = inst.implementation
    if (!impl?.name) return null
    // 형식 값: 2 구현 없음, 4 회로도, 6 그려진 블록, 22 PSpice 모델(이름이 @MODEL 이 된다)
    const pspiceModel = (impl.type & 0x10) !== 0
    if (pspiceModel) return null
    const schematic = (impl.type & 4) !== 0 || inst.block || /^NO$/i.test(symbol?.properties?.Primitive || '')
    if (!schematic) return null
    const local = viewsOf(doc).find((v) => sameName(v, impl.name))
    if (local) return { doc, view: local }
    const other = opts.resolve?.(impl.path, impl.name, doc)
    if (other) {
      const view = viewsOf(other).find((v) => sameName(v, impl.name))
      if (view) return { doc: other, view }
    }
    return { missing: true, name: impl.name, path: impl.path }
  }

  function visit(doc, view, path, bindings, stack) {
    const idx = indexOf(doc)
    const mode = wantedMode || (idx.ids ? 'ids' : 'geometry')
    const scope = `s${scopeCounter++}`
    const pages = (doc.pages || []).filter((p) => (view === null ? true : p.view === view))
    const isHidden = (inst, pin) => idx.symbols.get(inst.part)?.pins?.[pin.order - 1]?.visible === false

    const resolvers = pages.map((page, pi) => (mode === 'ids' ? pageFromIds(ctx, page, `${scope}p${pi}`, path) : pageFromGeometry(ctx, page, `${scope}p${pi}`, path, isHidden)))

    pages.forEach((page, pi) => {
      const pageKey = `${scope}p${pi}`
      for (const c of connectorsOf(page)) {
        const members = [c.name, ...(busMembers(c.name) || [])]
        for (const name of members) {
          const local = `${pageKey}:name:${upper(name)}`
          // 전원 기호는 설계 전체, 페이지 연결자·포트는 이 회로도 안
          uf.union(local, c.kind === 'global' ? `global:${upper(name)}` : `${scope}:name:${upper(name)}`)
        }
      }
      if (mode === 'ids') {
        for (const w of page.wires || []) {
          const node = `${pageKey}:net:${w.net}`
          if (!wiresOfNode.has(node)) wiresOfNode.set(node, [])
          wiresOfNode.get(node).push(w.id)
        }
      }
    })

    // 부모의 핀과 이 회로도의 포트를 잇는다
    for (const [pin, node] of bindings) uf.union(node, `${scope}:name:${pin}`)

    pages.forEach((page, pi) => {
      for (const inst of page.instances || []) {
        const symbol = idx.symbols.get(inst.part)
        const child = childOf(doc, inst, symbol)
        const refName = inst.ref || `UNNAMED_${page.name}_${inst.x}_${inst.y}`
        if (!inst.ref) warn(`${page.name}: 참조 이름이 없는 부품이 있어요 (${inst.x},${inst.y})`)
        const pinNameOf = (pin) => (inst.block ? inst.blockPins?.[pin.order - 1] : symbol?.pins?.[pin.order - 1]?.name) ?? ''

        if (child?.view !== undefined) {
          const key = [...stack, `${doc.file}:${child.view}`]
          if (stack.includes(`${doc.file}:${child.view}`)) { warn(`${refName}: 회로도 ${child.view} 가 자기 자신을 부르고 있어요. 펼치지 않았어요`); continue }
          const childBindings = []
          for (const pin of inst.pins || []) {
            const node = resolvers[pi](inst, pin)
            const name = upper(pinNameOf(pin))
            if (node !== null && name) childBindings.push([name, node])
            else if (name) childBindings.push([name, `${scope}:floating:${refName}:${name}`])
          }
          visit(child.doc, child.view, [...path, refName], childBindings, key)
          continue
        }
        if (child?.missing) warn(`${[...path, refName].join('.')}: 아래 회로도 ${child.name}${child.path ? ` (${child.path})` : ''} 를 찾지 못해 부품 하나로 두었어요`)

        const fullRef = [...path, refName].join('_')
        const pkg = idx.packages.get(inst.sourcePart)
        if (!pkg && !inst.block) warn(`${inst.ref}: 패키지 ${inst.sourcePart} 를 파일에서 찾지 못해 핀 번호를 몰라요. 핀 순서를 대신 썼어요`)
        if (!symbol && !inst.block) warn(`${inst.ref}: 심볼 ${inst.part} 을 파일에서 찾지 못해 핀 이름을 몰라요`)
        if (symbol && (inst.pins || []).length !== symbol.pins.length) warn(`${inst.ref}: 심볼은 핀이 ${symbol.pins.length}개인데 도면에는 ${(inst.pins || []).length}개만 있어요`)

        const partName = inst.sourcePart || inst.part || inst.implementation?.name || ''
        let part = refs.get(fullRef)
        if (!part) {
          part = { ref: fullRef, path: [...path, refName].join('.'), value: inst.value || '', part: partName, symbol: inst.part || '', footprint: pkg?.footprint || inst.properties?.['PCB Footprint'] || '', properties: { ...(inst.properties || {}) }, pages: [], sections: [], pins: [] }
          refs.set(fullRef, part)
        } else if (part.value !== (inst.value || '') || part.part !== partName) {
          mixedRefs.push(`${fullRef}(${part.value}/${inst.value})`)
        }
        if (!part.pages.includes(page.name)) part.pages.push(page.name)
        part.sections.push(inst.section ?? 0)

        const section = pkg?.sections?.[inst.section ?? 0]
        const element = { part, inst, symbol, pkg, path, view, unit: section?.unit || '', sectionCount: pkg?.sections?.length || 1, section: inst.section ?? 0, pins: [] }
        elements.push(element)

        for (const pin of inst.pins || []) {
          const symPin = symbol?.pins?.[pin.order - 1]
          const pinName = pinNameOf(pin)
          const number = section?.pinNumbers?.[pin.order - 1] || ''
          let node
          // 선이 없는 핀의 PSpiceDefaultNet($G_DPWR), 또는 그려지지 않는 전원 핀의 자기 이름. 설계 전체에서 그 이름의 넷에 붙는다.
          const byName = !(pin.wire > 0) && (symPin?.defaultNet || (symPin?.visible === false ? symPin.name : ''))
          if (byName) {
            node = `global:${upper(byName)}`
            addName(names, node, byName, 'hidden', path)
            uf.find(node)
            hiddenCount++
          } else node = resolvers[pi](inst, pin)
          const row = { number: number || `${inst.section ?? 0}.${pin.order}`, name: pinName, type: symPin?.type || '', section: inst.section ?? 0, order: pin.order, page: page.name, x: pin.x, y: pin.y, noConnect: !!pin.noConnect, node }
          part.pins.push(row)
          element.pins.push(row)
          if (node === null) { unconnected++; continue }
          if (pin.noConnect) flaggedConnected++
          if (!netPins.has(node)) netPins.set(node, [])
          netPins.get(node).push({ ref: fullRef, pin: row })
        }
      }
    })
  }

  const rootView = rootViewOf(json, opts.view)
  if (opts.view && rootView === null) warn(`회로도 ${opts.view} 가 이 파일에 없어요`)
  if (viewsOf(json).length > 1 && !opts.view && !json.rootSchematic) warn(`회로도가 ${viewsOf(json).length}개인데 최상위를 알 수 없어요. ${rootView} 부터 폈어요`)
  visit(json, rootView, [], [], [])
  if (mixedRefs.length) warn(`같은 참조 이름에 값이 다른 부품 ${mixedRefs.length}건을 한 부품으로 합쳤어요. 도면 오류이거나, 계층 설계에서 인스턴스마다 다른 참조 이름(Hierarchy 표)을 쓰는 경우예요: ${mixedRefs.slice(0, 6).join(', ')}`)

  // 노드를 넷으로
  const groups = new Map()
  const groupOf = (root) => {
    if (!groups.has(root)) groups.set(root, { nodes: [], names: [], pins: [] })
    return groups.get(root)
  }
  for (const node of uf.parent.keys()) groupOf(uf.find(node)).nodes.push(node)
  for (const [node, list] of names) groupOf(uf.find(node)).names.push(...list)
  for (const [node, list] of netPins) {
    const g = groupOf(uf.find(node))
    g.pins.push(...list)
    if (!g.nodes.includes(node)) g.nodes.push(node)
  }

  // Capture 가 스스로 남긴 평탄화 넷 이름. 있으면 그 이름을 쓴다.
  const captureNames = new Map()
  const autoNames = new Map() // 선 id → 표에 적힌 자동 이름. N00525 처럼 앞을 0 으로 채우거나, 끝에 수를 하나 더 붙이기도 한다
  for (const h of json.hierarchy || []) {
    for (const n of h.nets || []) {
      captureNames.set(upper(n.name), n.name)
      if (/^N\d+$/.test(n.name)) autoNames.set(String(Number(n.name.slice(1))), n.name)
    }
  }
  const autoNameFor = (id) => {
    const text = String(id)
    if (autoNames.has(text)) return autoNames.get(text)
    for (let digit = 0; digit <= 9; digit++) if (autoNames.has(`${text}${digit}`)) return autoNames.get(`${text}${digit}`)
    return null
  }

  const nets = []
  for (const g of groups.values()) {
    if (!g.pins.length && !g.names.length) continue
    const sorted = [...g.names].sort((a, b) => a.depth - b.depth || RANK[a.kind] - RANK[b.kind]) // 위쪽 회로도의 이름이 먼저
    const allNames = [...new Set(sorted.map((n) => n.name))]
    const preferred = allNames.find((n) => captureNames.has(upper(n)))
    let name = preferred ? captureNames.get(upper(preferred)) : (allNames[0] ?? null)
    if (!name) {
      for (const node of g.nodes) {
        for (const id of wiresOfNode.get(node) || []) { name = autoNameFor(id); if (name) break }
        if (name) break
      }
    }
    nets.push({ name, names: allNames, pins: g.pins, nodes: g.nodes })
  }

  return { mode: wantedMode || (hasIds(json) ? 'ids' : 'geometry'), view: rootView, nets, parts: [...refs.values()], elements, warnings, stats: { unconnectedPins: unconnected, noConnectFlaggedButWired: flaggedConnected, hiddenPowerPins: hiddenCount } }
}

// ---------- PSpiceTemplate ----------
// ctx: { props: {이름: 값}, pin(이름) → 노드, path: ['U1'] , warn }
// ^ 계층 경로, @id 값, &id 있으면 값, ?id 있으면 글, ~id 없으면 글, #id 있으면 글·없으면 나머지 전부 버림, %핀 노드, \n 줄바꿈
export function expandTemplate(template, ctx) {
  const defined = (id) => {
    const v = lookup(ctx.props, id)
    return v !== undefined && v !== ''
  }
  const hier = () => (ctx.path?.length ? `_${ctx.path.join('_')}_` : '_')
  const identifier = (s, i) => { let j = i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++; return j }
  const pinToken = (s, i) => {
    if (s[i] === '"') { const end = s.indexOf('"', i + 1); return end < 0 ? [s.slice(i + 1), s.length] : [s.slice(i + 1, end), end + 1] }
    let j = i
    while (j < s.length && !/\s/.test(s[j])) j++
    return [s.slice(i, j), j]
  }

  const run = (s) => {
    let out = '', i = 0
    while (i < s.length) {
      const c = s[i]
      if (c === '\\') {
        const n = s[i + 1]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : (n ?? '')
        i += 2
      } else if (c === '^') {
        out += hier(); i++
      } else if (c === '@' || c === '&') {
        const j = identifier(s, i + 1), id = s.slice(i + 1, j)
        // Capture 는 값을 넣은 뒤에 ^ 를 편다. 값 안의 ^ 도 경로가 된다 (x^2 → x_2)
        if (defined(id)) out += String(lookup(ctx.props, id)).replace(/\^/g, hier())
        else if (c === '@') ctx.warn?.(`${ctx.props.REFDES}: 템플릿의 @${id} 값이 없어요`)
        i = j
      } else if (c === '%') {
        const [name, j] = pinToken(s, i + 1)
        out += ctx.pin(name)
        i = j
      } else if (c === '?' || c === '~' || c === '#') {
        const j = identifier(s, i + 1), id = s.slice(i + 1, j)
        const sep = s[j]
        if (!id || sep === undefined) { out += c; i++; continue }
        const end = s.indexOf(sep, j + 1)
        if (end < 0) { out += s.slice(i); break }
        const first = s.slice(j + 1, end)
        let next = end + 1, second = ''
        if (c !== '#' && s[next] === sep) { // ?id/글/글/ 뒤 조각은 조건이 맞지 않을 때 쓴다
          const end2 = s.indexOf(sep, next + 1)
          if (end2 >= 0) { second = s.slice(next + 1, end2); next = end2 + 1 }
        }
        const has = defined(id)
        if (c === '#' && !has) return out // 나머지를 버린다
        if (c === '?') out += run(has ? first : second)
        else if (c === '~') out += run(has ? second : first)
        else out += run(first)
        i = next
      } else {
        out += c; i++
      }
    }
    return out
  }
  return run(template)
}

const lookup = (props, id) => {
  if (Object.prototype.hasOwnProperty.call(props, id)) return props[id]
  const key = Object.keys(props).find((k) => k.toUpperCase() === id.toUpperCase())
  return key === undefined ? undefined : props[key]
}

// ---------- 값 ----------
// 도면의 값을 SPICE 값으로. 쉼표로 나열된 첫 수를 쓴다: "0.1uF,10V" → 0.1uF, "DNI,10K" → 10K, "4K7" → 4.7K.
// 저항의 대문자 M 은 MEG 로 바꾼다: 도면의 1M 은 1 MΩ 인데 SPICE 의 M 은 milli 다. 수가 없으면 null.
// 템플릿이 없는 부품에만 쓴다. 템플릿이 있으면 Capture 처럼 값을 글자 그대로 넣는다.
export function spiceValue(raw, letter) {
  const tokens = String(raw || '').replace(/[µμ]/g, 'u').split(/[,\s/_]+/).filter(Boolean)
  for (const tok of tokens) {
    let m = /^(\d+)([RKMGUNP])(\d+)$/i.exec(tok) // 4K7, 2R2, 1U0
    if (m) {
      const unit = m[2].toUpperCase()
      const body = `${m[1]}.${m[3]}`
      if (unit === 'R') return body
      if (unit === 'M' && m[2] === 'M' && letter === 'R') return `${body}MEG`
      return `${body}${m[2]}`
    }
    m = /^(\d*\.?\d+)(MEG|MIL|[TGKMUNPFRH]|OHMS?)?([FH])?$/i.exec(tok)
    if (!m) continue
    const [, num, suffix = '', unit = ''] = m
    if (/^R$|^OHMS?$/i.test(suffix)) return num // 47R, 0R, 10ohm
    if (suffix === 'M' && letter === 'R') return `${num}MEG`
    return `${num}${suffix}${unit}`
  }
  return null
}

// ---------- 이름 ----------
// Capture 는 +VCC, -VEE, A/B 같은 이름을 그대로 쓴다. 빈칸과 괄호처럼 한 낱말을 깨는 글자만 바꾼다.
const safeToken = (name) => String(name).replace(/[^A-Za-z0-9_.#!:$+\-/]/g, '_')

const naturalKey = (s) => String(s).split(/(\d+)/).map((t, i) => (i % 2 ? t.padStart(12, '0') : t.toUpperCase())).join('')
const byNatural = (a, b) => (naturalKey(a) < naturalKey(b) ? -1 : naturalKey(a) > naturalKey(b) ? 1 : 0)

// ---------- 부품 표 ----------
export function bom(parts) {
  const rows = new Map()
  for (const p of parts) {
    const key = `${p.value}\u0000${p.part}\u0000${p.footprint}`
    if (!rows.has(key)) rows.set(key, { value: p.value, part: p.part, footprint: p.footprint, refs: [] })
    rows.get(key).refs.push(p.ref)
  }
  const out = [...rows.values()]
  for (const r of out) { r.refs.sort(byNatural); r.count = r.refs.length }
  return out.sort((a, b) => byNatural(a.refs[0], b.refs[0]))
}

// ---------- 넷리스트 ----------
const wrapLine = (s, width = 120) => {
  if (s.length <= width || s.includes('\n')) return s
  const rows = []
  let cur = ''
  for (const tok of s.split(' ')) {
    if (cur && cur.length + tok.length + 1 > width) { rows.push(cur); cur = `+ ${tok}` } else cur = cur ? `${cur} ${tok}` : tok
  }
  rows.push(cur)
  return rows.join('\n')
}

export function dsnToNetlist(json, opts = {}) {
  if (!json || !Array.isArray(json.pages)) throw new Error('orcad2json 의 JSON 이 아니에요: pages 가 없어요')
  if (json.kind && json.kind !== 'dsn') throw new Error(`도면(.DSN)이 아니라 ${json.kind} 파일이에요. 넷리스트를 만들 페이지가 없어요`)

  const flat = flatten(json, opts)
  const warnings = [...(json.warnings || []).map((w) => `파서: ${w}`), ...flat.warnings]
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w) }

  // 넷 이름을 노드 이름으로. 접지 묶기, 겹치는 이름 풀기.
  const groundMerged = new Set()
  const used = new Set(['0'])
  const nodeOf = new Map()
  const nets = []
  let auto = 0
  const ordered = [...flat.nets].sort((a, b) => byNatural(a.name ?? '~', b.name ?? '~'))
  // 설계에 0 이라는 넷이 따로 있으면 Capture 처럼 그것만 접지다. GND 는 이름 그대로 남는다.
  const hasZero = flat.nets.some((net) => net.names.some((n) => upper(n) === '0'))
  const groundName = (n) => (hasZero ? upper(n) === '0' : GROUND_NAMES.has(upper(n)))
  for (const net of ordered) {
    const isGround = net.names.some(groundName)
    let node
    if (isGround) {
      node = '0'
      for (const n of net.names) if (groundName(n)) groundMerged.add(upper(n))
    } else {
      let base = net.name ? safeToken(net.name) : `N${String(++auto).padStart(5, '0')}`
      if (base === '0') base = 'N0'
      node = base
      for (let i = 2; used.has(upper(node)); i++) node = `${base}_${i}`
      used.add(upper(node))
    }
    for (const n of net.nodes) nodeOf.set(n, node)
    nets.push({ node, name: net.name, names: net.names, pins: net.pins.map((p) => ({ ref: p.ref, number: p.pin.number, name: p.pin.name, page: p.pin.page })) })
  }

  // 접지는 한 넷으로 합친다
  const groundNets = nets.filter((n) => n.node === '0')
  const finalNets = nets.filter((n) => n.node !== '0')
  if (groundNets.length) {
    finalNets.unshift({ node: '0', name: '0', names: [...new Set(groundNets.flatMap((n) => n.names))], pins: groundNets.flatMap((n) => n.pins) })
  }
  if (groundMerged.size > 1) warn(`접지 이름 ${[...groundMerged].sort().join(', ')} 을 노드 0 하나로 합쳤어요. 도면에서는 따로일 수 있어요`)
  const otherGround = [...new Set(finalNets.filter((n) => n.node !== '0' && /^(A|D|P|S)?G(ND|ROUND)|^VSS$|^EARTH$|^CHASSIS/i.test(n.name || '')).map((n) => n.name))]
  if (hasZero && otherGround.length) warn(`0 넷이 있어서 ${otherGround.join(', ')} 은 접지로 치지 않았어요. Capture 넷리스트도 따로 둬요`)
  else
  if (otherGround.length) warn(`접지처럼 보이지만 0 으로 합치지 않은 넷: ${otherGround.join(', ')}`)

  const title = opts.title || String(json.file || 'orcad design').replace(/\.[^.]+$/, '')
  const lines = [`* ${title}`]
  const bodyStart = lines.length

  const nodeForPin = (ref, row) => {
    if (row.node === null) return `NC_${safeToken(ref)}_${safeToken(row.number)}`
    const n = nodeOf.get(row.node)
    if (n === undefined) throw new Error(`${ref} 핀 ${row.number} 의 넷을 찾지 못했어요`)
    return n
  }

  const seenModels = new Map()
  const unreadableValues = []
  const outElements = []
  let templated = 0

  // 템플릿이 있는 조각은 Capture 처럼 조각마다 한 줄. 없는 부품은 참조 하나에 한 줄(핀 번호 순서).
  const untemplated = new Map()
  for (const el of [...flat.elements].sort((a, b) => byNatural(a.part.ref, b.part.ref) || a.section - b.section)) {
    const template = el.inst.properties?.PSpiceTemplate || el.symbol?.properties?.PSpiceTemplate
    if (!template || opts.templates === false) {
      if (!untemplated.has(el.part.ref)) { untemplated.set(el.part.ref, el.part); outElements.push({ untemplated: el.part }) }
      continue
    }
    templated++
    const refName = el.inst.ref + (el.sectionCount > 1 ? (el.unit || sectionLabel(el.section)) : '')
    const props = { ...(el.symbol?.properties || {}), ...(el.inst.properties || {}), REFDES: refName, VALUE: el.inst.value ?? '' }
    if (el.inst.implementation?.name) props.MODEL = el.inst.implementation.name
    const byName = new Map(el.pins.map((p) => [upper(p.name), p]))
    const pin = (name) => {
      const row = byName.get(upper(name))
      if (!row) { warn(`${el.part.ref}: 템플릿의 핀 %${name} 이 심볼에 없어요`); return `NC_${safeToken(el.part.ref)}_${safeToken(name)}` }
      return nodeForPin(el.part.ref, row)
    }
    const clean = (t) => t.replace(/[ \t]+$/gm, '').replace(/^[ \t]+/gm, '')
    const expanded = clean(expandTemplate(template, { props, pin, path: el.path, warn }))
    // 소자 줄이 둘 이상 나오는 템플릿(스위치 S, POT)은 Capture 처럼 .subckt 로 싼다
    const elementLines = expanded.split('\n').filter((l) => l.trim() && !/^[.+*]/.test(l))
    if (elementLines.length > 1) {
      const name = safeToken([el.view, ...el.path, refName].join('_'))
      const pinNames = [...el.pins].sort((a, b) => byNatural(a.name, b.name))
      const inner = clean(expandTemplate(template, { props, pin: (n) => byName.get(upper(n))?.name ?? n, path: el.path, warn: () => {} }))
      const head = `X${el.path.length ? `_${el.path.join('_')}_` : '_'}${refName}`
      const text = [`${head} ${pinNames.map((p) => nodeForPin(el.part.ref, p)).join(' ')} ${name}`, `.subckt ${name} ${pinNames.map((p) => p.name).join(' ')}`, inner, `.ends ${name}`].join('\n')
      outElements.push({ text, spiceRef: head, element: el, line: text.split('\n')[0], subckt: name })
      continue
    }
    const head = expanded.split('\n')[0].split(/\s+/)[0] || ''
    outElements.push({ text: expanded, spiceRef: head, element: el })
  }

  for (const item of outElements) {
    if (item.text !== undefined) { lines.push(item.text); continue }
    const part = item.untemplated
    const bad = safeToken(part.ref)
    const pins = [...part.pins].sort((a, b) => byNatural(a.number, b.number))
    const nodeNames = pins.map((p) => nodeForPin(part.ref, p))
    const letter = /^[A-Za-z]/.test(part.ref) ? part.ref[0].toUpperCase() : 'X'
    const prefix = /^[A-Z]+/i.exec(part.ref)?.[0].toUpperCase() || ''
    const model = safeToken(part.part || part.symbol || 'UNKNOWN') || 'UNKNOWN'
    const twoPin = pins.length === 2
    let line
    if (twoPin && (prefix === 'R' || prefix === 'C' || prefix === 'L')) {
      const v = spiceValue(part.value, letter)
      if (v === null) unreadableValues.push(`${part.ref}=${part.value}`)
      line = `${letter}_${bad} ${nodeNames.join(' ')} ${v ?? (safeToken(part.value) || model)}`
    } else if (twoPin && prefix === 'D' && diodeOrder(pins)) {
      const order = diodeOrder(pins)
      line = `D_${bad} ${nodeNames[order[0]]} ${nodeNames[order[1]]} ${model}`
    } else {
      line = `X_${bad} ${nodeNames.join(' ')} ${model}`
    }
    if (model !== part.part && part.part) seenModels.set(model, part.part)
    lines.push(wrapLine(line))
    item.spiceRef = line.split(' ')[0]
  }
  lines.splice(bodyStart, 0, `* orcad2json + dsn2cir: ${flat.parts.length} parts, ${finalNets.length} nets, ${json.pages.length} pages.${templated ? ` ${templated} elements from PSpiceTemplate.` : ' Connectivity and BOM, not a simulation deck.'}`)
  if (unreadableValues.length) warn(`값을 수로 읽지 못해 글자 그대로 적은 부품 ${unreadableValues.length}개: ${unreadableValues.join(', ')}`)
  if (seenModels.size) warn(`공백·괄호가 든 부품 이름 ${seenModels.size}개는 글자를 바꿔 적었어요 (예: ${[...seenModels.entries()][0].join(' ← ')})`)
  if (flat.stats.noConnectFlaggedButWired) warn(`no-connect 표시가 있는데 선이 달린 핀이 ${flat.stats.noConnectFlaggedButWired}개 있어요. 선을 따랐어요`)

  lines.push('.END', '')
  const text = lines.join('\n')

  const parts = [...flat.parts].sort((a, b) => byNatural(a.ref, b.ref)).map((part) => {
    const pins = [...part.pins].sort((a, b) => byNatural(a.number, b.number))
    return { ref: part.ref, path: part.path, value: part.value, part: part.part, symbol: part.symbol, footprint: part.footprint, pages: part.pages, sections: part.sections.length, properties: part.properties, pins: pins.map((p) => ({ number: p.number, name: p.name, type: p.type, section: p.section, page: p.page, net: p.node === null ? null : nodeOf.get(p.node) ?? null, noConnect: p.noConnect })) }
  })

  const elements = outElements.map((item) => ({ spiceRef: item.spiceRef, text: item.text ?? null, ref: item.element?.part.ref ?? item.untemplated.ref }))

  return {
    title,
    text,
    parts,
    elements,
    nets: finalNets,
    warnings,
    view: flat.view,
    stats: { pages: json.pages.length, parts: parts.length, instances: flat.elements.length, nets: finalNets.length, unconnectedPins: flat.stats.unconnectedPins, hiddenPowerPins: flat.stats.hiddenPowerPins, templated, mode: flat.mode },
    bom: () => bom(parts),
  }
}

// 여러 조각 부품의 표시: 0→A, 1→B … 26→AA
function sectionLabel(index) {
  let n = index, out = ''
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return out
}

// 다이오드의 애노드·캐소드를 핀 이름으로 안다면 그 순서를 돌려준다
function diodeOrder(pins) {
  const a = pins.findIndex((p) => /^(A|AN|ANODE|\+)$/i.test(p.name))
  const k = pins.findIndex((p) => /^(K|C|CA|CATHODE|-)$/i.test(p.name))
  return a >= 0 && k >= 0 && a !== k ? [a, k] : null
}
