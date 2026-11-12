// 계층 배치(그래프 라이브러리 없이): 회사 프로세스 지도의 일 · 관계를 층으로 놓는다.
//   1 되돌아가는 관계(고리)를 시작 일에서 DFS 로 찾아 뺀다(확률 큰 관계부터 따라가므로 주된 길이 앞으로 간다)
//   2 남은 관계로 가장 긴 길 기준 층을 정한다. 「끝」은 맨 마지막 층
//   3 여러 층을 건너는 관계에는 빈 점(더미)을 넣어 그 층들을 지나가게 한다
//   4 층 안의 순서는 이웃 위치의 무게 평균(barycenter)으로 위아래 번갈아 맞추고, 교차가 가장 적은 순서를 남긴다
//   5 층 안의 자리는 이웃 쪽으로 당기되 최소 간격을 지킨다(앞에서 민 값과 뒤에서 민 값의 평균)
//   6 앞으로 가는 관계는 층 방향 곡선, 고리는 지나는 층의 상자들 바깥으로 도는 곡선
// 좌표는 층 축(r)과 순서 축(o)으로 셈하고 끝에 방향(LR: 왼→오, TB: 위→아래)에 맞춰 x · y 로 바꾼다.

const bez = (s, t) => {
  const u = 1 - t
  return { r: u * u * u * s.p0.r + 3 * u * u * t * s.c1.r + 3 * u * t * t * s.c2.r + t * t * t * s.p1.r, o: u * u * u * s.p0.o + 3 * u * u * t * s.c1.o + 3 * u * t * t * s.c2.o + t * t * t * s.p1.o }
}

// nodes [{key, w, h}] · edges [{id, from, to, p}] · entries [key] · labelSize(edge) → {w, h, ws?} in screen units (ws: the short form's width)
export function layoutGraph({ nodes, edges, entries = [], endKey = '__end__', dir = 'LR', gapRank = 64, gapOrder = 30, margin = 20, labelSize = () => ({ w: 36, h: 18 }) }) {
  if (!nodes.length) return { width: 0, height: 0, nodes: [], edges: [] }
  const LR = dir === 'LR'
  const N = new Map(nodes.map((n) => [n.key, n]))
  const E = edges.filter((e) => N.has(e.from) && N.has(e.to))
  const rs = (n) => (n.dummy ? 0 : LR ? n.w : n.h)
  const os = (n) => (n.dummy ? 6 : LR ? n.h : n.w)

  // 1 back edges by DFS, heavier edges first
  const outs = new Map()
  for (const e of E) (outs.get(e.from) || outs.set(e.from, []).get(e.from)).push(e)
  for (const l of outs.values()) l.sort((a, b) => b.p - a.p)
  const state = new Map(), disc = new Map(), back = new Set()
  let tick = 0
  const visit = (k) => {
    state.set(k, 1); disc.set(k, tick++)
    for (const e of outs.get(k) || []) { const s = state.get(e.to); if (s === 1) back.add(e.id); else if (!s) visit(e.to) }
    state.set(k, 2)
  }
  const hasPred = new Set(E.filter((e) => e.from !== e.to).map((e) => e.to))
  for (const k of entries) if (N.has(k) && !state.get(k)) visit(k)
  for (const n of nodes) if (!state.get(n.key) && !hasPred.has(n.key)) visit(n.key)
  for (const n of nodes) if (!state.get(n.key)) visit(n.key)

  // 2 longest-path layers over the acyclic rest
  const dag = E.filter((e) => !back.has(e.id) && e.from !== e.to)
  const indeg = new Map(nodes.map((n) => [n.key, 0]))
  const dagOut = new Map()
  for (const e of dag) { indeg.set(e.to, indeg.get(e.to) + 1); (dagOut.get(e.from) || dagOut.set(e.from, []).get(e.from)).push(e) }
  const layer = new Map(nodes.map((n) => [n.key, 0]))
  const queue = nodes.filter((n) => !indeg.get(n.key)).map((n) => n.key).sort((a, b) => disc.get(a) - disc.get(b))
  while (queue.length) {
    const k = queue.shift()
    for (const e of dagOut.get(k) || []) {
      layer.set(e.to, Math.max(layer.get(e.to), layer.get(k) + 1))
      indeg.set(e.to, indeg.get(e.to) - 1)
      if (!indeg.get(e.to)) queue.push(e.to)
    }
  }
  if (N.has(endKey)) layer.set(endKey, Math.max(0, ...nodes.filter((n) => n.key !== endKey).map((n) => layer.get(n.key))) + 1)
  const maxL = Math.max(...layer.values())

  // 3 dummies along edges that cross several layers
  const items = new Map(nodes.map((n) => [n.key, { ...n, layer: layer.get(n.key), disc: disc.get(n.key) ?? 0 }]))
  const segs = [], chains = new Map()
  for (const e of dag) {
    const chain = [e.from]
    for (let l = layer.get(e.from) + 1; l < layer.get(e.to); l++) {
      const k = `\u0001${e.id}\u0001${l}`
      items.set(k, { key: k, dummy: true, layer: l, disc: (disc.get(e.from) ?? 0) + 0.5 })
      chain.push(k)
    }
    chain.push(e.to)
    chains.set(e.id, chain)
    for (let i = 0; i < chain.length - 1; i++) segs.push({ a: chain[i], b: chain[i + 1], w: 0.3 + (e.p || 0) })
  }
  let layers = Array.from({ length: maxL + 1 }, () => [])
  for (const it of [...items.values()].sort((a, b) => a.disc - b.disc)) layers[it.layer].push(it.key)

  // 4 order within layers: barycenter sweeps, keep the fewest crossings
  const pos = new Map()
  const reindex = () => layers.forEach((L) => L.forEach((k, i) => pos.set(k, i)))
  const up = new Map(), down = new Map()
  for (const s of segs) { (down.get(s.a) || down.set(s.a, []).get(s.a)).push(s); (up.get(s.b) || up.set(s.b, []).get(s.b)).push(s) }
  const segsAt = Array.from({ length: maxL + 1 }, () => [])
  for (const s of segs) segsAt[items.get(s.a).layer].push(s)
  const crossings = () => {
    let c = 0
    for (const L of segsAt) for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const x = pos.get(L[i].a) - pos.get(L[j].a), y = pos.get(L[i].b) - pos.get(L[j].b)
      if (x * y < 0) c += L[i].w * L[j].w
    }
    return c
  }
  const bary = (k, ns, side) => {
    if (!ns?.length) return pos.get(k)
    let s = 0, w = 0
    for (const n of ns) { s += n.w * pos.get(n[side]); w += n.w }
    return s / w
  }
  reindex()
  let best = layers.map((L) => [...L]), bestC = crossings()
  for (let it = 0; it < 16; it++) {
    const range = it % 2 === 0 ? [...Array(maxL).keys()].map((i) => i + 1) : [...Array(maxL).keys()].reverse()
    for (const i of range) {
      const key = new Map(layers[i].map((k) => [k, it % 2 === 0 ? bary(k, up.get(k), 'a') : bary(k, down.get(k), 'b')]))
      layers[i].sort((a, b) => key.get(a) - key.get(b) || pos.get(a) - pos.get(b))
      layers[i].forEach((k, j) => pos.set(k, j))
    }
    const c = crossings()
    if (c < bestC) { bestC = c; best = layers.map((L) => [...L]) }
  }
  layers = best
  reindex()

  // 5 coordinates: r by layer, o pulled toward neighbours with a minimum gap
  const lr = [], lsize = layers.map((L) => Math.max(0, ...L.map((k) => rs(items.get(k)))))
  layers.forEach((L, i) => { lr[i] = i ? lr[i - 1] + lsize[i - 1] / 2 + gapRank + lsize[i] / 2 : lsize[0] / 2 })
  const sep = (a, b) => (os(a) + os(b)) / 2 + (a.dummy || b.dummy ? gapOrder * 0.45 : gapOrder)
  const o = new Map()
  for (const L of layers) {
    let acc = 0
    L.forEach((k, i) => { if (i) acc += sep(items.get(L[i - 1]), items.get(k)); o.set(k, acc) })
    const mid = acc / 2
    for (const k of L) o.set(k, o.get(k) - mid)
  }
  const nb = (k) => [...(up.get(k) || []).map((s) => [s.a, s.w]), ...(down.get(k) || []).map((s) => [s.b, s.w])]
  for (let it = 0; it < 30; it++) {
    const order = it % 2 === 0 ? layers : [...layers].reverse()
    for (const L of order) {
      const want = L.map((k) => {
        const ns = nb(k)
        if (!ns.length) return o.get(k)
        let s = 0, w = 0
        for (const [n, wt] of ns) { s += wt * o.get(n); w += wt }
        return s / w
      })
      const F = [...want], B = [...want]
      for (let i = 1; i < L.length; i++) F[i] = Math.max(F[i], F[i - 1] + sep(items.get(L[i - 1]), items.get(L[i])))
      for (let i = L.length - 2; i >= 0; i--) B[i] = Math.min(B[i], B[i + 1] - sep(items.get(L[i]), items.get(L[i + 1])))
      L.forEach((k, i) => o.set(k, (F[i] + B[i]) / 2))
    }
  }
  const P = (k) => ({ r: lr[items.get(k).layer], o: o.get(k) })
  const oLo = Math.min(...nodes.map((n) => o.get(n.key) - os(n) / 2)), oHi = Math.max(...nodes.map((n) => o.get(n.key) + os(n) / 2))

  // 6 edge curves
  const geo = []
  for (const e of dag) {
    const ch = chains.get(e.id)
    const pts = ch.map((k, i) => {
      const p = P(k), it = items.get(k)
      if (i === 0) return { r: p.r + rs(it) / 2, o: p.o }
      if (i === ch.length - 1) return { r: p.r - rs(it) / 2, o: p.o }
      return p
    })
    const sg = []
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], dr = (b.r - a.r) / 2
      sg.push({ p0: a, c1: { r: a.r + dr, o: a.o }, c2: { r: b.r - dr, o: b.o }, p1: b })
    }
    geo.push({ e, segs: sg, back: false })
  }
  const arcs = { neg: [], pos: [] }
  const backs = E.filter((e) => back.has(e.id) || e.from === e.to)
    .map((e) => ({ e, lo: Math.min(layer.get(e.from), layer.get(e.to)), hi: Math.max(layer.get(e.from), layer.get(e.to)) }))
    .sort((a, b) => a.hi - a.lo - (b.hi - b.lo))
  for (const { e, lo, hi } of backs) {
    const u = items.get(e.from), v = items.get(e.to)
    const side = (o.get(e.from) + o.get(e.to)) / 2 <= (oLo + oHi) / 2 ? 'neg' : 'pos'
    const sg = side === 'neg' ? -1 : 1
    const between = layers.slice(lo, hi + 1).flat().map((k) => items.get(k)).filter((it) => !it.dummy)
    const edgeO = sg < 0 ? Math.min(...between.map((it) => o.get(it.key) - os(it) / 2)) : Math.max(...between.map((it) => o.get(it.key) + os(it) / 2))
    const stack = arcs[side].filter((a) => a.lo <= hi && a.hi >= lo).length
    arcs[side].push({ lo, hi })
    const S = { r: P(e.from).r - Math.min(14, rs(u) / 4), o: o.get(e.from) + sg * os(u) / 2 }
    const T = { r: P(e.to).r + Math.min(18, rs(v) / 4), o: o.get(e.to) + sg * os(v) / 2 }
    const peak = edgeO + sg * (22 + 16 * stack)
    const oc = (8 * peak - S.o - T.o) / 6
    geo.push({ e, segs: [{ p0: S, c1: { r: S.r, o: oc }, c2: { r: T.r, o: oc }, p1: T }], back: true })
  }

  // to screen: LR x=r y=o, TB x=o y=r
  const xy = (p) => (LR ? { x: p.r, y: p.o } : { x: p.o, y: p.r })
  const outNodes = nodes.map((n) => ({ ...n, ...xy(P(n.key)), layer: layer.get(n.key) }))
  const rects = outNodes.map((n) => ({ x0: n.x - n.w / 2, y0: n.y - n.h / 2, x1: n.x + n.w / 2, y1: n.y + n.h / 2 }))
  const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
  const placed = []
  const outEdges = geo.sort((a, b) => b.e.p - a.e.p).map((g) => {
    const size = labelSize(g.e)
    const ts = g.back ? [[0, 0.5], [0, 0.42], [0, 0.58], [0, 0.34], [0, 0.66]]
      : [[0, 0.5], [0, 0.36], [0, 0.64], [0, 0.24], [0, 0.76], [0, 0.15], [0, 0.85], ...g.segs.slice(1).map((_, i) => [i + 1, 0.5])]
    // a long label (「35% · 은퇴 후보」) that fits nowhere falls back to its short form (「35%」)
    const widths = size.ws && size.ws < size.w ? [[size.w, false], [size.ws, true]] : [[size.w, false]]
    let label = null
    search: for (const [w, short] of widths) {
      for (const [si, t] of ts) {
        const c = xy(bez(g.segs[si], t))
        const box = { x0: c.x - w / 2 - 2, y0: c.y - size.h / 2 - 2, x1: c.x + w / 2 + 2, y1: c.y + size.h / 2 + 2 }
        if (!rects.some((r) => hit(r, box)) && !placed.some((r) => hit(r, box))) { label = { ...c, box, w, short }; break search }
      }
    }
    if (!label) {
      const [w, short] = widths.at(-1), c = xy(bez(g.segs[0], 0.5))
      label = { ...c, w, short, box: { x0: c.x - w / 2 - 2, y0: c.y - size.h / 2 - 2, x1: c.x + w / 2 + 2, y1: c.y + size.h / 2 + 2 } }
    }
    placed.push(label.box)
    const seg = g.segs.map((s) => ({ p0: xy(s.p0), c1: xy(s.c1), c2: xy(s.c2), p1: xy(s.p1) }))
    return { id: g.e.id, back: g.back, segs: seg, label: { x: label.x, y: label.y, w: label.w, h: size.h, short: label.short } }
  })

  // bounds (curves sampled, labels, a little room above nodes for the entry tag) → shift to the margin
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  for (const r of rects) { grow(r.x0, r.y0 - 12); grow(r.x1, r.y1) }
  for (const e of outEdges) {
    for (const s of e.segs) for (let t = 0; t <= 1; t += 0.1) { const p = bez({ p0: { r: s.p0.x, o: s.p0.y }, c1: { r: s.c1.x, o: s.c1.y }, c2: { r: s.c2.x, o: s.c2.y }, p1: { r: s.p1.x, o: s.p1.y } }, t); grow(p.r, p.o) }
    grow(e.label.x - e.label.w / 2, e.label.y - e.label.h / 2); grow(e.label.x + e.label.w / 2, e.label.y + e.label.h / 2)
  }
  const dx = margin - x0, dy = margin - y0
  const mv = (p) => ({ x: p.x + dx, y: p.y + dy })
  const f = (n) => Math.round(n * 10) / 10
  return {
    width: Math.ceil(x1 - x0 + 2 * margin), height: Math.ceil(y1 - y0 + 2 * margin),
    nodes: outNodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })),
    edges: outEdges.map((e) => {
      const s = e.segs.map((g) => ({ p0: mv(g.p0), c1: mv(g.c1), c2: mv(g.c2), p1: mv(g.p1) }))
      const d = `M${f(s[0].p0.x)},${f(s[0].p0.y)}` + s.map((g) => ` C${f(g.c1.x)},${f(g.c1.y)} ${f(g.c2.x)},${f(g.c2.y)} ${f(g.p1.x)},${f(g.p1.y)}`).join('')
      return { id: e.id, back: e.back, d, label: { ...e.label, x: e.label.x + dx, y: e.label.y + dy } }
    }),
  }
}
