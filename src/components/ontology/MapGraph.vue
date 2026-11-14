<script setup>
// 회사 프로세스 지도의 그림(SVG): 일은 둥근 상자(이름 · 역할 · 건수), 시작 일에는 「시작 n%」, 끝은 하나.
// 관계 굵기는 확률(p), 숫자는 p. 고리는 바깥으로 도는 곡선, 은퇴 후보는 주황 점선, 은퇴한 관계는 회색 점선,
// 고정은 핀, 관찰 적음(Wilson 구간 폭 > 0.3)은 흐리게, 후보 일은 흐리게. 배치는 layout.js.
// 넓은 화면은 왼→오, 폰은 위→아래. 끌어서 옮기고, 휠은 커서 자리를 중심으로, − / 맞춤 / + 로도 크기를 바꾼다.
// 사건 보기(events): 사건은 작은 원(메일 · 결과물 · 채팅)과 그 아래 이름. 일 → 사건(RAISES) · 사건 → 일(TRIGGERS) 관계를
// 그리고, 한 사건 뒤 여러 일이 함께 열리면(split and) 숫자 옆에 「함께」. 사건이나 그 관계를 누르면 select {kind: 'event'}.
// 프로세스 다듬기(OntoRefine): 일 · 관계에 added(다듬으며 더함, 파랑 점선 · 기록이 없으면 「더함」) · removed(다듬으며 뺌, 빨강 점선)가
// 있으면 그렇게 그린다. marks 는 AI 후보(high · mid · human)와 단계 가르기(gate · human · ai · drop · skipped)를 함께 칠한다.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useId } from 'vue'
import { layoutGraph } from './layout.js'
import { END, pct, taskName, SPLIT_KO, condText } from './fmt.js'
import { edgeId, EV } from './mapView.js'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  edges: { type: Array, default: () => [] },
  entries: { type: Array, default: () => [] },
  events: { type: Array, default: () => [] }, // 사건 보기: [{key: EV + event key, ev, label, and}]
  selected: { type: Object, default: null }, // {kind: 'edge'|'task'|'event', id}
  dir: { type: String, default: 'LR' },
  side: Boolean, // a side panel covers the right: keep room so the map can move out from under it
  scale: { type: Number, default: 1 }, // entry shares are of all cases; × this = of the shown proc's cases
  marks: { type: Map, default: () => new Map() }, // 일 → high · mid · human (AI 후보) | gate · human · ai · drop · skipped (단계 가르기) — 칠하고, 나머지는 흐리게
  whole: Boolean, // 전체 화면: the whole map on the screen, also after the map changes (smaller sizes allowed)
})
const emit = defineEmits(['select'])

// text width at a font size (Hangul a full em, digits and Latin narrower) — enough to wrap names and size labels
const em = (ch) => (/[가-힣ㄱ-ㆎ一-龥]/.test(ch) ? 1 : /[0-9]/.test(ch) ? 0.6 : ch === ' ' ? 0.3 : ch === '%' ? 0.85 : ch === '·' ? 0.4 : /[A-Z]/.test(ch) ? 0.68 : 0.56)
const textW = (s, size) => [...String(s)].reduce((a, c) => a + em(c) * size, 0)
const NAME = 14, SMALL = 11.5, LABEL = 11.5, EVS = 11, R = 13
function wrap(name, max, size = NAME) {
  const words = String(name).split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (textW(next, size) <= max || !cur) cur = next
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  const out = lines.slice(0, 2)
  if (lines.length > 2) out[1] = `${out[1]}…`
  // a single word longer than the box: cut by characters
  return out.map((l) => {
    if (textW(l, size) <= max) return l
    let s = ''
    for (const c of l) { if (textW(`${s}${c}…`, size) > max) return `${s}…`; s += c }
    return s
  })
}

const W = computed(() => (props.dir === 'LR' ? 126 : 128))
const nodeDefs = computed(() => {
  const list = props.tasks.map((t) => {
    const lines = wrap(t.name || t.key, W.value - 22)
    return { key: t.key, w: W.value, h: lines.length > 1 ? 74 : 58, lines, t }
  })
  // an event: a small circle, its name under it (LR) or beside it (TB); edges meet the circle (port), not the box
  for (const e of props.events) {
    const LR = props.dir === 'LR'
    const lines = wrap(e.label, LR ? 100 : 90, EVS)
    const lw = Math.ceil(Math.max(...lines.map((l) => textW(l, EVS))))
    if (LR) list.push({ key: e.key, ev: e, lines, w: Math.max(2 * R + 8, lw + 8), h: 2 * R + 2 * (lines.length * 13 + 5), port: R })
    else list.push({ key: e.key, ev: e, lines, w: 2 * R + 2 * (lw + 10), h: Math.max(2 * R + 6, lines.length * 13 + 6), port: R })
  }
  if (props.edges.some((e) => e.to === END)) list.push({ key: END, w: 58, h: 36, end: true })
  return list
})
const stale = (e) => e.stale && e.status !== 'retired'
const isAnd = (e) => e.kind === 'trigger' && e.split === 'and'
// a role routine's step: how many people of the role do it
const people = (e) => (e.kind === 'trigger' && String(e.scope || '').startsWith('role:') ? `${e.people || 0}명` : '')
// 다듬으며 더한 관계는 아직 지나간 건이 없으면 비율 대신 「더함」
const head = (e) => (e.added && !e.n ? '더함' : pct(e.p))
// one id per map: two maps on a page (프로세스 다듬기 나란히 보기) must not share the clip
const clipId = `pm-node-clip-${useId()}`
const labelW = (e, short) => Math.ceil(textW(`${head(e)}${stale(e) && !short ? ' · 은퇴 후보' : ''}${isAnd(e) ? ` · ${SPLIT_KO.and}` : ''}${people(e) ? ` · ${people(e)}` : ''}`, LABEL) + 14 + (e.pinned ? 13 : 0))
const width = (e) => 1.2 + 4.6 * Math.min(1, Math.max(0, e.p || 0))
const tipLen = (e) => 7 + width(e) * 1.4

const L = computed(() => layoutGraph({
  nodes: nodeDefs.value.map(({ key, w, h, port }) => ({ key, w, h, port })),
  edges: props.edges.map((e) => ({ id: edgeId(e), from: e.from, to: e.to, p: e.p })),
  entries: props.entries,
  dir: props.dir,
  gapRank: props.dir === 'LR' ? 52 : 46,
  gapOrder: props.dir === 'LR' ? 30 : 22,
  labelSize: (x) => { const e = props.edges.find((y) => edgeId(y) === x.id) || x; return { w: labelW(e), ws: stale(e) ? labelW(e, true) : 0, h: 18 } },
}))
const nodeBy = computed(() => new Map(nodeDefs.value.map((n) => [n.key, n])))
const nameOf = (key) => nodeBy.value.get(key)?.ev?.ev?.name || taskName(key)
const selKey = computed(() => (props.selected?.kind === 'event' ? EV + props.selected.id : props.selected?.kind === 'task' ? props.selected.id : null))
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
  const tips = [`${nameOf(e.from)} → ${nameOf(e.to)} · ${pct(e.p)} · ${e.n}건`]
  if (isAnd(e)) tips.push('여러 일이 함께 열려요')
  if (people(e)) tips.push(`같은 역할 ${people(e)}`)
  if (e.cond) tips.push(`조건: ${condText(e.cond)}`)
  if (e.pinned) tips.push('고정')
  if (e.stale) tips.push('은퇴 후보')
  if (retired) tips.push('은퇴함')
  if (e.thin) tips.push('관찰 적음')
  if (!e.kind && (e.people ?? 2) <= 1) tips.push('한 사람 기준')
  if (e.added) tips.push('다듬으며 더함')
  if (e.removed) tips.push('다듬으며 뺌')
  return {
    id: g.id, d, tip, e, back: g.back, label: g.label, w: width(e), tl: tipLen(e), title: tips.join(' · '),
    cls: { stale: stale(e), retired, thin: e.thin, back: g.back, and: isAnd(e), evt: e.kind === 'raise' || e.kind === 'trigger', added: !!e.added, removed: !!e.removed,
      sel: props.selected?.kind === 'edge' && props.selected.id === g.id, near: !!selKey.value && (e.from === selKey.value || e.to === selKey.value) },
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
const minZoom = () => (props.whole ? 0.08 : 0.3)
function apply() {
  const el = vp.value
  if (!el || !L.value.width) return
  const cw = el.clientWidth - 12 - (props.side && props.dir === 'LR' ? 360 : 0), ch = el.clientHeight - 58
  const all = Math.min(cw / L.value.width, ch / L.value.height, 1.05)
  if (fitMode.value === 'all') zoom.value = Math.max(minZoom(), all)
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
// back to the readable size (leaving 전체 화면)
function reset() { fitMode.value = 'auto'; apply(); nextTick(home) }
watch(() => props.whole, (w) => nextTick(w ? fit : reset))
const step = (k) => { zoom.value = Math.min(2, Math.max(minZoom(), +(zoom.value * k).toFixed(3))); fitMode.value = 'manual' }
watch(() => [L.value.width, L.value.height, props.dir], () => {
  fitMode.value = props.whole ? 'all' : 'auto'
  nextTick(() => { apply(); nextTick(home) })
})
// a selection made elsewhere (the task panel's lists, the labels drawer) or under the side panel: bring it into view
watch(() => props.selected, async (s) => {
  if (!s) return
  await nextTick()
  const el = vp.value, svg = el?.querySelector('svg.map')
  if (!el || !svg) return
  const n = s.kind === 'task' || s.kind === 'event' ? L.value.nodes.find((x) => x.key === (s.kind === 'event' ? EV + s.id : s.id)) : null
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

// 휠 · 트랙패드: 커서 자리를 중심으로 키우고 줄인다 — 커서 밑의 일이 그 자리에 그대로 있다. 옆으로 미는 두 손가락은 옆으로 옮기기.
// 폰 모양(TB)에서는 페이지가 스크롤돼야 해서 Ctrl(트랙패드 핀치)만 크기를 바꾼다. 여러 이벤트는 한 프레임에 모아 한 번에.
let wheelK = 1, wheelAt = null, wheelRaf = 0
function onWheel(ev) {
  const el = vp.value
  if (!el || !L.value.width) return
  if (!ev.ctrlKey && Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) { ev.preventDefault(); el.scrollLeft += ev.deltaX; return }
  if (props.dir === 'TB' && !ev.ctrlKey) return
  ev.preventDefault()
  const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1
  wheelK *= Math.exp(-ev.deltaY * unit * (ev.ctrlKey ? 0.01 : 0.0015))
  wheelAt = { x: ev.clientX, y: ev.clientY }
  if (!wheelRaf) wheelRaf = requestAnimationFrame(zoomAtCursor)
}
async function zoomAtCursor() {
  wheelRaf = 0
  const k = wheelK
  wheelK = 1
  const el = vp.value, svg = el?.querySelector('svg.map')
  if (!el || !svg || !wheelAt) return
  const z0 = zoom.value, z1 = Math.min(2, Math.max(minZoom(), +(z0 * k).toFixed(4)))
  if (z1 === z0) return
  const at = wheelAt, a = svg.getBoundingClientRect()
  const ux = (at.x - a.left) / z0, uy = (at.y - a.top) / z0 // the map point under the cursor
  zoom.value = z1
  fitMode.value = 'manual'
  await nextTick()
  const b = svg.getBoundingClientRect()
  el.scrollLeft += b.left + ux * z1 - at.x
  el.scrollTop += b.top + uy * z1 - at.y
}
onBeforeUnmount(() => cancelAnimationFrame(wheelRaf))

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
// in the events view a line into or out of an event opens that event (its panel lists what it opens and what raises it)
const pickEdge = (x) => (x.e.event ? pick('event', x.e.event) : pick('edge', x.id))
const evTitle = (n) => `${n.ev.ev.name} · ${n.ev.ev.n || 0}번${n.ev.and ? ' · 여러 일이 함께 열려요' : ''}`
</script>

<template>
  <div class="mg">
  <div ref="vp" class="vp" :class="{ dragging: moved, side: side && dir === 'LR' }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointerleave="up" @wheel="onWheel" @click.self="pick(null)">
    <svg v-if="L.width" class="map" :width="L.width * zoom" :height="L.height * zoom" :viewBox="`0 0 ${L.width} ${L.height}`" role="img" aria-label="회사 프로세스 지도" @click.self="pick(null)">
      <defs><clipPath :id="clipId"><rect x="4" y="0" :width="W - 8" height="90" /></clipPath></defs>
      <g class="edges">
        <g v-for="x in drawn" :key="x.id" class="edge" :class="x.cls" @click.stop="pickEdge(x)">
          <title>{{ x.title }}</title>
          <path class="hit" :d="x.d" />
          <path class="line" :d="x.d" :stroke-width="x.w" />
          <path v-if="x.tip" class="tip" :d="`M0,0 L${-x.tl},${-x.tl * 0.55} L${-x.tl * 0.78},0 L${-x.tl},${x.tl * 0.55} Z`" :transform="`translate(${x.tip.x},${x.tip.y}) rotate(${x.tip.a})`" />
        </g>
      </g>
      <g class="nodes">
        <g v-for="n in nodes.filter((x) => x.ev)" :key="n.key" class="node ev" :class="[n.ev.ev.kind, { sel: selKey === n.key, and: n.ev.and }]"
          :transform="`translate(${n.x0},${n.y0})`" tabindex="0" role="button" data-testid="onto-event-node" :data-event="n.ev.ev.key"
          @click.stop="pick('event', n.ev.ev.key)" @keydown.enter.prevent="pick('event', n.ev.ev.key)">
          <title>{{ evTitle(n) }}</title>
          <g :transform="`translate(${n.w / 2},${n.h / 2})`">
            <circle class="hit" :r="R + 6" />
            <circle class="disc" :r="R" />
            <path v-if="n.ev.ev.kind === 'mail'" class="glyph" d="M-6,-4.5 H6 V4.5 H-6 Z M-6,-4.5 L0,0.8 L6,-4.5" />
            <path v-else-if="n.ev.ev.kind === 'message'" class="glyph" d="M-6,-5 H6 V3 H-1 L-4.5,6 V3 H-6 Z" />
            <path v-else-if="n.ev.ev.kind === 'link'" class="glyph" d="M-1.5,1.5 L1.5,-1.5 M-1,-3.5 L1,-5.5 A2.8,2.8 0 0 1 5,-1.5 L3,0.5 M1,3.5 L-1,5.5 A2.8,2.8 0 0 1 -5,1.5 L-3,-0.5" />
            <path v-else-if="n.ev.ev.kind === 'time' || n.ev.ev.kind === 'timer'" class="glyph" d="M0,-5.5 A5.5,5.5 0 1 1 -0.01,-5.5 M0,-3 V0 L2.5,1.5" />
            <path v-else-if="n.ev.ev.kind === 'done'" class="glyph" d="M-4.5,0 L-1.2,3.2 L4.8,-3.4" />
            <path v-else class="glyph" d="M-4.5,-6 H1.5 L4.5,-3 V6 H-4.5 Z M1.5,-6 V-3 H4.5" />
          </g>
          <text v-if="dir === 'LR'" class="evl" text-anchor="middle"><tspan v-for="(l, i) in n.lines" :key="i" :x="n.w / 2" :y="n.h / 2 + R + 13 + i * 13">{{ l }}</tspan></text>
          <text v-else class="evl"><tspan v-for="(l, i) in n.lines" :key="i" :x="n.w / 2 + R + 7" :y="n.h / 2 + 4 - ((n.lines.length - 1) * 13) / 2 + i * 13">{{ l }}</tspan></text>
        </g>
        <g v-for="n in nodes.filter((x) => !x.ev)" :key="n.key" class="node" :class="{ [`mk-${marks.get(n.key)}`]: marks.has(n.key), dim: marks.size && !n.end && !marks.has(n.key), end: n.end, cand: n.t?.candidate, sel: selected?.kind === 'task' && selected.id === n.key, entry: n.share, habit: n.t?.kind === 'habit', added: n.t?.added, removed: n.t?.removed }"
          :transform="`translate(${n.x0},${n.y0})`" :tabindex="n.end ? -1 : 0" :role="n.end ? null : 'button'"
          @click.stop="!n.end && pick('task', n.key)" @keydown.enter.prevent="!n.end && pick('task', n.key)">
          <title v-if="!n.end">{{ n.t.name }}{{ n.t.role ? ` · ${n.t.role}` : '' }} · {{ n.t.n_cases }}건{{ n.t.candidate ? ' · 후보' : '' }}{{ n.t.added ? ' · 다듬으며 더함' : '' }}{{ n.t.removed ? ' · 다듬으며 뺌' : '' }}</title>
          <template v-if="n.end">
            <rect :width="n.w" :height="n.h" :rx="n.h / 2" />
            <text class="endt" :x="n.w / 2" :y="n.h / 2 + 5" text-anchor="middle">끝</text>
          </template>
          <template v-else>
            <rect :width="n.w" :height="n.h" rx="13" />
            <text class="nm" :clip-path="`url(#${clipId})`"><tspan v-for="(l, i) in n.lines" :key="i" x="11" :y="22 + i * 17">{{ l }}</tspan></text>
            <!-- 걷어냄(단계 가르기): 이름에 줄 -->
            <template v-if="marks.get(n.key) === 'drop' || n.t.removed"><line v-for="(l, i) in n.lines" :key="`x${i}`" class="strike" x1="10" :x2="Math.min(n.w - 10, 12 + textW(l, NAME))" :y1="17 + i * 17" :y2="17 + i * 17" /></template>
            <text class="sm" x="11" :y="n.h - 11" :clip-path="`url(#${clipId})`">{{ n.t.role }}</text>
            <text class="sm ct" :x="n.w - 11" :y="n.h - 11" text-anchor="end">{{ n.t.kind === 'habit' && !n.t.n_cases ? '루틴' : n.t.added && !n.t.n_cases ? '더함' : `${n.t.n_cases}건` }}</text>
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
          @click.stop="pickEdge(x)" @keydown.enter.prevent="pickEdge(x)">
          <title>{{ x.title }}</title>
          <rect :x="-x.label.w / 2" y="-9" :width="x.label.w" height="18" rx="9" />
          <g v-if="x.e.pinned" class="pin" :transform="`translate(${-x.label.w / 2 + 6},-6)`">
            <path d="M3.2,0.6 H8.8 L8,4.6 L10.2,6.8 H1.8 L4,4.6 Z M6,6.8 V11.6" />
          </g>
          <text :x="x.e.pinned ? 6.5 : 0" y="4" text-anchor="middle">{{ head(x.e) }}<tspan v-if="x.cls.stale && !x.label.short" class="hint"> · 은퇴 후보</tspan><tspan v-if="x.cls.and" class="and"> · {{ SPLIT_KO.and }}</tspan><tspan v-if="people(x.e)" class="ppl"> · {{ people(x.e) }}</tspan></text>
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
.node.dim { opacity: .28; }
.node.mk-high rect { fill: color-mix(in srgb, #2f9e6e 34%, var(--regular-solid-bg)); stroke: #2f9e6e; stroke-width: 2.5; }
.node.mk-mid rect { fill: color-mix(in srgb, #2f9e6e 14%, var(--regular-solid-bg)); stroke: #2f9e6e; stroke-width: 1.5; stroke-dasharray: 5 3; }
.node.mk-human rect { fill: color-mix(in srgb, #d9822b 26%, var(--regular-solid-bg)); stroke: #d9822b; stroke-width: 2.5; }
.node.cand rect { stroke-dasharray: 4 3; stroke: var(--text-secondary); }
/* 단계 가르기(프로세스 다듬기 ②): 꼭 하는 관문 = 주황 굵게 · 사람이 꼭 = 주황(mk-human) · AI가 맡음 = 초록 · 걷어냄 = 회색 줄 · 건너뛰었지만 해야 함 = 주황 점선 */
.node.mk-gate rect { fill: color-mix(in srgb, #d9822b 40%, var(--regular-solid-bg)); stroke: #d9822b; stroke-width: 4.5; }
.node.mk-gate .nm { font-weight: 800; }
.node.mk-ai rect { fill: color-mix(in srgb, #2f9e6e 30%, var(--regular-solid-bg)); stroke: #2f9e6e; stroke-width: 2.5; }
.node.mk-drop rect { fill: color-mix(in srgb, var(--text-primary) 5%, var(--regular-solid-bg)); stroke: var(--text-tertiary); stroke-width: 1.5; }
.node.mk-drop .nm, .node.mk-drop .sm { fill: var(--text-tertiary); }
.node.mk-skipped rect { fill: color-mix(in srgb, #d9822b 10%, var(--regular-solid-bg)); stroke: #d9822b; stroke-width: 2.2; stroke-dasharray: 6 4; }
.node .strike { stroke: var(--text-secondary); stroke-width: 1.6; stroke-linecap: round; pointer-events: none; }
/* 프로세스 다듬기 ①: 더한 일 · 관계는 파랑 점선, 뺀 것(찾은 대로 쪽)은 빨강 점선 */
.node.added rect { stroke: var(--color-info); stroke-width: 2.2; stroke-dasharray: 6 3; }
.node.added .ct { fill: var(--color-info); font-weight: 600; }
.node.removed { opacity: .62; }
.node.removed rect { stroke: var(--color-error); stroke-width: 1.6; stroke-dasharray: 3 3; }
.node.removed .strike { stroke: var(--color-error); }
.edge.added .line { stroke: var(--color-info); stroke-dasharray: 7 4; stroke-linecap: butt; }
.edge.added .tip { fill: var(--color-info); }
.edge.removed .line { stroke: var(--color-error); stroke-dasharray: 3 4; stroke-linecap: butt; opacity: .75; }
.edge.removed .tip { fill: var(--color-error); opacity: .75; }
/* a coloured node keeps its colour when picked: a glow shows the pick */
.node.sel[class*='mk-'] rect, .node.sel.added rect, .node.sel.removed rect { filter: drop-shadow(0 0 3px var(--sel)) drop-shadow(0 0 1px var(--sel)); }
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

.node.habit rect { stroke-dasharray: 5 3; stroke: color-mix(in srgb, var(--color-info) 60%, transparent); }
.node.ev { --evc: var(--text-secondary); }
.node.ev.mail { --evc: var(--color-info); }
.node.ev.artifact { --evc: var(--color-success); }
.node.ev.message { --evc: #a78bfa; }
.node.ev .hit { fill: transparent; }
.node.ev .disc { fill: var(--regular-solid-bg); stroke: var(--evc); stroke-width: 1.6; transition: stroke .2s; }
.node.ev .glyph { fill: none; stroke: var(--evc); stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
.node.ev:hover .disc { stroke: var(--text-primary); }
.node.ev:focus-visible .disc, .node.ev.sel .disc { stroke: var(--sel); stroke-width: 2.4; }
.node.ev .evl { fill: var(--text-secondary); font-size: 11px; font-weight: 500; letter-spacing: -0.01em; }
.node.ev.sel .evl { fill: var(--text-primary); }
.lbl .and { fill: var(--color-info); font-weight: 600; }
.lbl .ppl { fill: var(--text-secondary); }

.lbl { cursor: pointer; outline: none; }
.lbl:focus-visible rect { stroke: var(--sel); stroke-width: 1.5; }
.lbl rect { fill: var(--regular-solid-bg); stroke: var(--hairline); }
.lbl text { fill: var(--text-primary); font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums; }
.lbl.thin text { fill: var(--text-secondary); }
.lbl.stale rect { stroke: var(--stale); }
.lbl .hint, .lbl.stale text { fill: var(--stale); }
.lbl.retired text { fill: var(--text-tertiary); }
.lbl.sel rect { stroke: var(--sel); stroke-width: 1.5; }
.lbl.added rect { stroke: var(--color-info); }
.lbl.added text { fill: var(--color-info); }
.lbl.removed rect { stroke: var(--color-error); }
.lbl.removed text { fill: var(--color-error); text-decoration: line-through; }
.pin path { fill: none; stroke: var(--text-primary); stroke-width: 1.4; stroke-linejoin: round; }

.zoom { position: absolute; z-index: 2; right: 12px; bottom: 12px; display: flex; gap: 2px; padding: 3px; border-radius: 9999px; }
.zoom button { min-width: 34px; height: 32px; border-radius: 9999px; font-size: 17px; color: var(--text-secondary); }
.zoom button.fit { font-size: 13px; padding: 0 10px; }
.zoom button:hover, .zoom button.on { color: var(--text-primary); background: var(--button-bg); }
</style>
