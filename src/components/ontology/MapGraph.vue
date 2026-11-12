<script setup>
// 회사 프로세스 지도의 그림(SVG): 일은 둥근 상자(이름 · 역할 · 건수), 시작 일에는 「시작 n%」, 끝은 하나.
// 관계 굵기는 확률(p), 숫자는 p. 고리는 바깥으로 도는 곡선, 은퇴 후보는 주황 점선, 은퇴한 관계는 회색 점선,
// 고정은 핀, 관찰 적음(Wilson 구간 폭 > 0.3)은 흐리게, 후보 일은 흐리게. 배치는 layout.js.
// 넓은 화면은 왼→오, 폰은 위→아래. 끌어서 옮기고 − / 맞춤 / + 로 크기를 바꾼다.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { layoutGraph } from './layout.js'
import { END, pct, taskName } from './fmt.js'
import { edgeId } from './mapView.js'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  edges: { type: Array, default: () => [] },
  entries: { type: Array, default: () => [] },
  selected: { type: Object, default: null }, // {kind: 'edge'|'task', id}
  dir: { type: String, default: 'LR' },
  side: Boolean, // a side panel covers the right: keep room so the map can move out from under it
  scale: { type: Number, default: 1 }, // entry shares are of all cases; × this = of the shown bundle's cases
})
const emit = defineEmits(['select'])

// text width at a font size (Hangul a full em, digits and Latin narrower) — enough to wrap names and size labels
const em = (ch) => (/[가-힣ㄱ-ㆎ一-龥]/.test(ch) ? 1 : /[0-9]/.test(ch) ? 0.6 : ch === ' ' ? 0.3 : ch === '%' ? 0.85 : ch === '·' ? 0.4 : /[A-Z]/.test(ch) ? 0.68 : 0.56)
const textW = (s, size) => [...String(s)].reduce((a, c) => a + em(c) * size, 0)
const NAME = 14, SMALL = 11.5, LABEL = 11.5
function wrap(name, max) {
  const words = String(name).split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (textW(next, NAME) <= max || !cur) cur = next
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  const out = lines.slice(0, 2)
  if (lines.length > 2) out[1] = `${out[1]}…`
  // a single word longer than the box: cut by characters
  return out.map((l) => {
    if (textW(l, NAME) <= max) return l
    let s = ''
    for (const c of l) { if (textW(`${s}${c}…`, NAME) > max) return `${s}…`; s += c }
    return s
  })
}

const W = computed(() => (props.dir === 'LR' ? 126 : 128))
const nodeDefs = computed(() => {
  const list = props.tasks.map((t) => {
    const lines = wrap(t.name || t.key, W.value - 22)
    return { key: t.key, w: W.value, h: lines.length > 1 ? 74 : 58, lines, t }
  })
  if (props.edges.some((e) => e.to === END)) list.push({ key: END, w: 58, h: 36, end: true })
  return list
})
const stale = (e) => e.stale && e.status !== 'retired'
const labelW = (e, short) => Math.ceil(textW(`${pct(e.p)}${stale(e) && !short ? ' · 은퇴 후보' : ''}`, LABEL) + 14 + (e.pinned ? 13 : 0))
const width = (e) => 1.2 + 4.6 * Math.min(1, Math.max(0, e.p || 0))
const tipLen = (e) => 7 + width(e) * 1.4

const L = computed(() => layoutGraph({
  nodes: nodeDefs.value.map(({ key, w, h }) => ({ key, w, h })),
  edges: props.edges.map((e) => ({ id: edgeId(e), from: e.from, to: e.to, p: e.p })),
  entries: props.entries,
  dir: props.dir,
  gapRank: props.dir === 'LR' ? 52 : 46,
  gapOrder: props.dir === 'LR' ? 30 : 22,
  labelSize: (x) => { const e = props.edges.find((y) => edgeId(y) === x.id) || x; return { w: labelW(e), ws: stale(e) ? labelW(e, true) : 0, h: 18 } },
}))
const nodeBy = computed(() => new Map(nodeDefs.value.map((n) => [n.key, n])))
const edgeBy = computed(() => new Map(props.edges.map((e) => [edgeId(e), e])))
const entryShare = computed(() => new Map(props.tasks.filter((t) => props.entries.includes(t.key)).map((t) => [t.key, Math.min(1, (t.entry_share || 0) * props.scale)])))

// the line stops short of the node so the arrowhead (drawn on its own) has a clean tip
function trimmed(g) {
  const e = edgeBy.value.get(g.id)
  const m = /C([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)$/.exec(g.d)
  if (!m) return { d: g.d, tip: null }
  let [cx, cy, x, y] = [+m[3], +m[4], +m[5], +m[6]]
  let dx = x - cx, dy = y - cy
  if (Math.hypot(dx, dy) < 0.5) { dx = x - +m[1]; dy = y - +m[2] }
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len, uy = dy / len, k = tipLen(e) * 0.8
  const d = g.d.slice(0, m.index) + `C${m[1]},${m[2]} ${(cx - ux * k).toFixed(1)},${(cy - uy * k).toFixed(1)} ${(x - ux * k).toFixed(1)},${(y - uy * k).toFixed(1)}`
  return { d, tip: { x, y, a: (Math.atan2(uy, ux) * 180) / Math.PI } }
}
const drawn = computed(() => L.value.edges.map((g) => {
  const e = edgeBy.value.get(g.id)
  const { d, tip } = trimmed(g)
  const retired = e.status === 'retired'
  const tips = [`${taskName(e.from)} → ${taskName(e.to)} · ${pct(e.p)} · ${e.n}건`]
  if (e.pinned) tips.push('고정')
  if (e.stale) tips.push('은퇴 후보')
  if (retired) tips.push('은퇴함')
  if (e.thin) tips.push('관찰 적음')
  if ((e.people ?? 2) <= 1) tips.push('한 사람 기준')
  return {
    id: g.id, d, tip, e, back: g.back, label: g.label, w: width(e), tl: tipLen(e), title: tips.join(' · '),
    cls: { stale: stale(e), retired, thin: e.thin, back: g.back, sel: props.selected?.kind === 'edge' && props.selected.id === g.id, near: props.selected?.kind === 'task' && (e.from === props.selected.id || e.to === props.selected.id) },
  }
}))
const nodes = computed(() => L.value.nodes.map((n) => {
  const def = nodeBy.value.get(n.key)
  return { ...n, ...def, x0: n.x - n.w / 2, y0: n.y - n.h / 2, share: entryShare.value.get(n.key) }
}))
const entryTag = (n) => {
  const text = `시작 ${pct(n.share)}`
  const w = Math.ceil(textW(text, 10.5) + 22)
  return { text, w, x: props.dir === 'LR' ? n.x0 + 6 : n.x0 - 4, y: n.y0 - 12 }
}

// ---------- zoom · pan ----------
const vp = ref(null)
const zoom = ref(1)
const fitMode = ref('auto') // auto: readable size, scroll if larger · all: the whole map · manual: − / +
function apply() {
  const el = vp.value
  if (!el || !L.value.width) return
  const cw = el.clientWidth - 12 - (props.side && props.dir === 'LR' ? 360 : 0), ch = el.clientHeight - 58
  const all = Math.min(cw / L.value.width, ch / L.value.height, 1.05)
  if (fitMode.value === 'all') zoom.value = Math.max(0.3, all)
  else if (fitMode.value === 'auto') zoom.value = props.dir === 'TB' ? Math.max(0.78, Math.min(1.05, cw / L.value.width)) : Math.max(0.8, all)
}
// start where the work starts: the main entry in view (LR: from the left edge, TB: centred across)
function home() {
  const el = vp.value, svg = el?.querySelector('svg.map')
  if (!el) return
  el.scrollLeft = 0; el.scrollTop = 0
  const n = L.value.nodes.find((x) => x.key === props.entries[0])
  if (!n || !svg) return
  const a = svg.getBoundingClientRect(), b = el.getBoundingClientRect()
  const px = a.left - b.left + n.x * zoom.value, py = a.top - b.top + n.y * zoom.value
  if (props.dir === 'TB') el.scrollLeft = Math.max(0, px - el.clientWidth / 2)
  else el.scrollTop = Math.max(0, py - el.clientHeight / 2)
}
function fit() {
  fitMode.value = 'all'
  apply()
  nextTick(home)
}
const step = (k) => { zoom.value = Math.min(2, Math.max(0.3, +(zoom.value * k).toFixed(3))); fitMode.value = 'manual' }
watch(() => [L.value.width, L.value.height, props.dir], () => {
  fitMode.value = 'auto'
  nextTick(() => { apply(); nextTick(home) })
})
// a selection made elsewhere (the task panel's lists, the labels drawer) or under the side panel: bring it into view
watch(() => props.selected, async (s) => {
  if (!s) return
  await nextTick()
  const el = vp.value, svg = el?.querySelector('svg.map')
  if (!el || !svg) return
  const n = s.kind === 'task' ? L.value.nodes.find((x) => x.key === s.id) : null
  const g = s.kind === 'edge' ? L.value.edges.find((x) => x.id === s.id) : null
  const pt = n ? { x: n.x, y: n.y } : g ? { x: g.label.x, y: g.label.y } : null
  if (!pt) return
  const a = svg.getBoundingClientRect(), b = el.getBoundingClientRect()
  const px = a.left - b.left + el.scrollLeft + pt.x * zoom.value, py = a.top - b.top + el.scrollTop + pt.y * zoom.value
  const visW = props.dir === 'LR' ? el.clientWidth - 370 : el.clientWidth
  const visH = props.dir === 'LR' ? el.clientHeight : el.clientHeight * 0.45
  const left = px < el.scrollLeft + 40 || px > el.scrollLeft + visW - 40 ? px - visW / 2 : el.scrollLeft
  const top = py < el.scrollTop + 40 || py > el.scrollTop + visH - 40 ? py - visH / 2 : el.scrollTop
  el.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: 'smooth' })
  // phone: the panel is a sheet over the lower half — bring the map's top under the bar
  if (props.dir === 'TB') el.scrollIntoView({ block: 'start', behavior: 'smooth' })
})
let ro
onMounted(() => {
  apply()
  nextTick(home)
  ro = new ResizeObserver(() => { if (fitMode.value !== 'manual') apply() })
  if (vp.value) ro.observe(vp.value)
})
onBeforeUnmount(() => ro?.disconnect())

let drag = null, moved = false
function down(ev) {
  if (ev.pointerType !== 'mouse' || ev.button !== 0) return
  drag = { x: ev.clientX, y: ev.clientY, l: vp.value.scrollLeft, t: vp.value.scrollTop }
  moved = false
}
function move(ev) {
  if (!drag) return
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 4) moved = true
  if (moved) { vp.value.scrollLeft = drag.l - dx; vp.value.scrollTop = drag.t - dy }
}
const up = () => { drag = null }
function pick(kind, id) {
  if (moved) { moved = false; return }
  emit('select', kind ? { kind, id } : null)
}
</script>

<template>
  <div class="mg">
  <div ref="vp" class="vp" :class="{ dragging: moved, side: side && dir === 'LR' }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointerleave="up" @click.self="pick(null)">
    <svg v-if="L.width" class="map" :width="L.width * zoom" :height="L.height * zoom" :viewBox="`0 0 ${L.width} ${L.height}`" role="img" aria-label="회사 프로세스 지도" @click.self="pick(null)">
      <defs><clipPath id="pm-node-clip"><rect x="4" y="0" :width="W - 8" height="90" /></clipPath></defs>
      <g class="edges">
        <g v-for="x in drawn" :key="x.id" class="edge" :class="x.cls" @click.stop="pick('edge', x.id)">
          <title>{{ x.title }}</title>
          <path class="hit" :d="x.d" />
          <path class="line" :d="x.d" :stroke-width="x.w" />
          <path v-if="x.tip" class="tip" :d="`M0,0 L${-x.tl},${-x.tl * 0.55} L${-x.tl * 0.78},0 L${-x.tl},${x.tl * 0.55} Z`" :transform="`translate(${x.tip.x},${x.tip.y}) rotate(${x.tip.a})`" />
        </g>
      </g>
      <g class="nodes">
        <g v-for="n in nodes" :key="n.key" class="node" :class="{ end: n.end, cand: n.t?.candidate, sel: selected?.kind === 'task' && selected.id === n.key, entry: n.share }"
          :transform="`translate(${n.x0},${n.y0})`" :tabindex="n.end ? -1 : 0" :role="n.end ? null : 'button'"
          @click.stop="!n.end && pick('task', n.key)" @keydown.enter.prevent="!n.end && pick('task', n.key)">
          <title v-if="!n.end">{{ n.t.name }}{{ n.t.role ? ` · ${n.t.role}` : '' }} · {{ n.t.n_cases }}건{{ n.t.candidate ? ' · 후보' : '' }}</title>
          <template v-if="n.end">
            <rect :width="n.w" :height="n.h" :rx="n.h / 2" />
            <text class="endt" :x="n.w / 2" :y="n.h / 2 + 5" text-anchor="middle">끝</text>
          </template>
          <template v-else>
            <rect :width="n.w" :height="n.h" rx="13" />
            <text class="nm" clip-path="url(#pm-node-clip)"><tspan v-for="(l, i) in n.lines" :key="i" x="11" :y="22 + i * 17">{{ l }}</tspan></text>
            <text class="sm" x="11" :y="n.h - 11" clip-path="url(#pm-node-clip)">{{ n.t.role }}</text>
            <text class="sm ct" :x="n.w - 11" :y="n.h - 11" text-anchor="end">{{ n.t.n_cases }}건</text>
          </template>
        </g>
        <g v-for="n in nodes.filter((x) => x.share)" :key="`s-${n.key}`" class="etag" :transform="`translate(${entryTag(n).x},${entryTag(n).y})`">
          <rect :width="entryTag(n).w" height="18" rx="9" />
          <path d="M8,5 L13,9 L8,13 Z" />
          <text x="16" y="13">{{ entryTag(n).text }}</text>
        </g>
      </g>
      <g class="labels">
        <g v-for="x in drawn" :key="`l-${x.id}`" class="lbl" :class="x.cls" :transform="`translate(${x.label.x},${x.label.y})`" tabindex="0" role="button"
          @click.stop="pick('edge', x.id)" @keydown.enter.prevent="pick('edge', x.id)">
          <title>{{ x.title }}</title>
          <rect :x="-x.label.w / 2" y="-9" :width="x.label.w" height="18" rx="9" />
          <g v-if="x.e.pinned" class="pin" :transform="`translate(${-x.label.w / 2 + 6},-6)`">
            <path d="M3.2,0.6 H8.8 L8,4.6 L10.2,6.8 H1.8 L4,4.6 Z M6,6.8 V11.6" />
          </g>
          <text :x="x.e.pinned ? 6.5 : 0" y="4" text-anchor="middle">{{ pct(x.e.p) }}<tspan v-if="x.cls.stale && !x.label.short" class="hint"> · 은퇴 후보</tspan></text>
        </g>
      </g>
    </svg>
  </div>
  <div class="zoom glass-thin">
    <button aria-label="작게" @click="step(1 / 1.2)">−</button>
    <button class="fit" :class="{ on: fitMode === 'all' }" title="지도 전체를 한 화면에" @click="fit">맞춤</button>
    <button aria-label="크게" @click="step(1.2)">+</button>
  </div>
  </div>
</template>

<style scoped>
.mg { position: absolute; inset: 0; }
.vp { position: absolute; inset: 0; overflow: auto; display: flex; padding: 6px 6px 52px; cursor: grab; scrollbar-width: thin; touch-action: pan-x pan-y; }
.vp.dragging { cursor: grabbing; }
.vp.side { padding-right: 366px; }
.map { margin: auto; flex: none; display: block; user-select: none; -webkit-user-select: none; }
.map { --edge: color-mix(in srgb, var(--text-primary) 52%, transparent); --stale: #F0883E; --sel: #e0613f; }

.edge { cursor: pointer; }
.edge .hit { fill: none; stroke: transparent; stroke-width: 14; }
.edge .line { fill: none; stroke: var(--edge); stroke-linecap: round; transition: stroke .2s, opacity .2s; }
.edge .tip { fill: var(--edge); transition: fill .2s; }
.edge.thin .line, .edge.thin .tip { opacity: .45; }
.edge.stale .line { stroke: var(--stale); stroke-dasharray: 7 5; stroke-linecap: butt; }
.edge.stale .tip { fill: var(--stale); }
.edge.retired .line { stroke: var(--text-tertiary); stroke-dasharray: 3 5; stroke-linecap: butt; }
.edge.retired .tip { fill: var(--text-tertiary); }
.edge:hover .line, .edge.near .line { stroke: var(--text-primary); opacity: 1; }
.edge:hover .tip, .edge.near .tip { fill: var(--text-primary); opacity: 1; }
.edge.sel .line { stroke: var(--sel); opacity: 1; }
.edge.sel .tip { fill: var(--sel); opacity: 1; }

.node { cursor: pointer; outline: none; }
.node:focus-visible rect { stroke: var(--sel); stroke-width: 2; }
.node rect { fill: var(--regular-solid-bg); stroke: var(--hairline); stroke-width: 1; transition: stroke .2s; }
.node.entry rect { stroke: color-mix(in srgb, var(--text-primary) 28%, transparent); }
.node:hover rect { stroke: var(--text-secondary); }
.node.sel rect { stroke: var(--sel); stroke-width: 2; }
.node.cand { opacity: .5; }
.node.cand rect { stroke-dasharray: 4 3; stroke: var(--text-secondary); }
.node.end { cursor: default; }
.node.end rect { fill: var(--ink); stroke: none; }
.endt { fill: var(--text-primary-on); font-size: 13.5px; font-weight: 600; }
.nm { fill: var(--text-primary); font-size: 14px; font-weight: 600; letter-spacing: -0.02em; }
.sm { fill: var(--text-secondary); font-size: 11.5px; }
.ct { font-variant-numeric: tabular-nums; }
.etag { pointer-events: none; }
.etag rect { fill: var(--color-success); }
.etag path { fill: #0b2a17; }
.etag text { fill: #0b2a17; font-size: 10.5px; font-weight: 600; }

.lbl { cursor: pointer; outline: none; }
.lbl:focus-visible rect { stroke: var(--sel); stroke-width: 1.5; }
.lbl rect { fill: var(--regular-solid-bg); stroke: var(--hairline); }
.lbl text { fill: var(--text-primary); font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums; }
.lbl.thin text { fill: var(--text-secondary); }
.lbl.stale rect { stroke: var(--stale); }
.lbl .hint, .lbl.stale text { fill: var(--stale); }
.lbl.retired text { fill: var(--text-tertiary); }
.lbl.sel rect { stroke: var(--sel); stroke-width: 1.5; }
.pin path { fill: none; stroke: var(--text-primary); stroke-width: 1.4; stroke-linejoin: round; }

.zoom { position: absolute; z-index: 2; right: 12px; bottom: 12px; display: flex; gap: 2px; padding: 3px; border-radius: 9999px; }
.zoom button { min-width: 34px; height: 32px; border-radius: 9999px; font-size: 17px; color: var(--text-secondary); }
.zoom button.fit { font-size: 13px; padding: 0 10px; }
.zoom button:hover, .zoom button.on { color: var(--text-primary); background: var(--button-bg); }
</style>
