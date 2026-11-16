<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer'
import 'bpmn-js/dist/assets/diagram-js.css'
import 'bpmn-js/dist/assets/bpmn-js.css'
import { api } from '../api.js'
import { laidOutBpmn } from '../lib/bpmnLayout.js'

// Renders the process-gpt designer's stored BPMN, painting each node by its live state.
// The stored layout is redone with Process GPT's automatic layout first (src/lib/bpmn-auto-layout): lanes per role,
// no overlapping shapes, flows around them.
// steps: [{id, state: done|active|pending|skipped, mine}]
// Or a diagram made elsewhere (xml — a map case's flow drawn on the fly, server lib/ontology/casebpmn.js), laid out the same way and
// imported again only when the XML changes:
//   markers: {elementId: state} painted as cs-<state> — a step's done · running · person · waiting · skipped · next · closed, a way's
//     taken · extra · rewound · skipped; painted again on every change without importing again
//   attrs: {elementId: {attribute: value, title}} put on the element's drawing (test ids, a hover title), again after each import
//   bigXml: the same diagram for 크게 보기 (left to right where the narrow box shows it top to bottom — the same element ids)
//   wheel: false leaves the wheel to the page (a fitted diagram in a scrolling panel) — 크게 보기 takes it back
//   the box is as tall as the diagram fitted to its width (never zoomed past 1), at most height
//   emits failed (the XML could not be shown) · ready (imported and painted)
const props = defineProps({
  defId: String, steps: { type: Array, default: () => [] }, height: { type: Number, default: 360 },
  xml: { type: String, default: null }, bigXml: { type: String, default: null }, markers: { type: Object, default: null }, attrs: { type: Object, default: null },
  wheel: { type: Boolean, default: true }, emptyText: { type: String, default: '' },
})
const emit = defineEmits(['failed', 'ready'])
const host = ref(null)
const empty = ref(false)
// (a given diagram may be allowed to grow tall: it starts at a usual height until its aspect is known)
const h = ref(props.xml != null ? Math.min(props.height, 320) : props.height)
const big = ref(false)
let viewer
const painted = new Map() // elementId → the cs-* marker put on it from markers

function paint() {
  if (!viewer) return
  const canvas = viewer.get('canvas')
  const reg = viewer.get('elementRegistry')
  for (const s of props.steps) {
    if (!reg.get(s.id)) continue
    for (const m of ['st-done', 'st-active', 'st-mine', 'st-skipped']) canvas.removeMarker(s.id, m)
    const m = s.mine ? 'st-mine' : s.state === 'done' ? 'st-done' : s.state === 'active' ? 'st-active' : s.state === 'skipped' ? 'st-skipped' : null
    if (m) canvas.addMarker(s.id, m)
  }
  const want = new Map(Object.entries(props.markers || {}).filter(([id, st]) => st && reg.get(id)).map(([id, st]) => [id, `cs-${st}`]))
  for (const [id, m] of painted) if (want.get(id) !== m) { if (reg.get(id)) canvas.removeMarker(id, m); painted.delete(id) }
  for (const [id, m] of want) if (!painted.has(id)) { canvas.addMarker(id, m); painted.set(id, m) }
  decorate()
}

// attributes and a hover title on the elements' drawings (the drawing is made again by every import)
function decorate() {
  if (!viewer || !props.attrs) return
  const reg = viewer.get('elementRegistry')
  for (const [id, a] of Object.entries(props.attrs)) {
    const gfx = reg.get(id) && reg.getGraphics(id)
    if (!gfx) continue
    for (const [k, v] of Object.entries(a || {})) {
      if (k !== 'title') { gfx.setAttribute(k, v == null ? '' : String(v)); continue }
      let t = [...gfx.children].find((c) => c.tagName === 'title')
      if (!t) { t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); gfx.insertBefore(t, gfx.firstChild) }
      t.textContent = String(v || '')
    }
  }
}

let seq = 0
async function load() {
  const my = ++seq
  empty.value = false
  let xml
  const given = props.xml != null
  if (given) xml = big.value && props.bigXml ? props.bigXml : props.xml
  else {
    const r = await api(`/processes/${encodeURIComponent(props.defId)}/bpmn`, { raw: true })
    if (!r.ok) { empty.value = true; return }
    xml = await r.text()
  }
  if (!xml) { empty.value = true; return }
  try {
    const laid = await laidOutBpmn(xml, props.defId || 'xml')
    if (gone || my !== seq) return
    await viewer.importXML(laid)
    if (gone || my !== seq) return
    painted.clear()
    // size the box to the diagram's aspect so wide flows are not shrunk to a sliver (not while 크게 보기: the box left behind keeps its place;
    // a given diagram: as drawn at its fitted scale, which fit-viewport never takes past 1)
    const inner = viewer.get('canvas').viewbox().inner
    const w = host.value.clientWidth || 600
    if (!big.value) h.value = Math.max(180, Math.min(props.height, Math.round(given ? inner.height * Math.min(1, w / inner.width) : w * inner.height / inner.width) + 48))
    paint()
    emit('ready')
    // the box animates to its new height; fit once it has settled
    await new Promise((r) => setTimeout(r, 420))
    if (my === seq) fit()
  } catch (e) {
    console.warn('[bpmn]', e.message)
    if (my !== seq) return
    empty.value = true
    emit('failed', e)
  }
}

onMounted(() => {
  viewer = new NavigatedViewer({ container: host.value, zoomScroll: { enabled: props.wheel } })
  load()
})
let gone = false
onBeforeUnmount(() => { gone = true; viewer?.destroy() })
watch(() => props.steps.map((s) => s.state + s.mine).join(), paint)
watch(() => [props.markers, props.attrs], paint, { deep: true })
watch(() => props.defId, () => { if (props.xml == null) load() })
watch(() => props.xml, (x, was) => { if (x !== was) load() })
watch(() => props.bigXml, (x, was) => { if (x !== was && big.value) load() })
const fit = () => { viewer?.get('canvas').resized(); viewer?.get('canvas').zoom('fit-viewport', 'auto') }
async function toggleBig() {
  big.value = !big.value
  if (!props.wheel) viewer?.get('zoomScroll').toggle(big.value)
  await new Promise((r) => setTimeout(r, 380))
  // a diagram with its own wide drawing for 크게 보기 changes drawing (and back on closing)
  if (props.xml != null && props.bigXml && props.bigXml !== props.xml) await load()
  else fit()
}
defineExpose({ fit })
</script>

<template>
  <div v-if="big" class="spacer" :style="{ height: h + 'px' }" />
  <Teleport to="body" :disabled="!big">
  <div v-if="big" class="scrim" @click="toggleBig" />
  <div class="bpmn" :class="{ big }" :style="{ height: big ? null : h + 'px' }">
    <div ref="host" class="host" />
    <p v-if="empty" class="none">{{ emptyText || '이 프로세스에는 저장된 BPMN 다이어그램이 없어요.' }}</p>
    <div v-else class="tools">
      <button class="press" aria-label="화면에 맞추기" @click="fit">맞춤</button>
      <button class="press" :aria-label="big ? '작게 보기' : '크게 보기'" @click="toggleBig">{{ big ? '닫기' : '크게 보기' }}</button>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.bpmn { position: relative; border-radius: 18px; overflow: hidden; background: var(--field-bg); }
.host { position: absolute; inset: 0; }
.none { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--text-secondary); font-size: 14px; }
.bpmn { transition: height .35s var(--spring); }
.spacer { border-radius: 18px; background: var(--field-bg); }
.scrim { position: fixed; inset: 0; z-index: 59; background: rgba(5 7 13 / .45); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); animation: fade-in .3s both; }
.bpmn.big { position: fixed; inset: 40px; z-index: 60; height: auto; background: var(--regular-solid-bg); box-shadow: 0 30px 80px rgba(0 0 0 / .35); animation: pop-in .4s var(--spring) both; }
.tools { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 6px; }
.tools button { height: 30px; padding: 0 12px; border-radius: 9999px; background: var(--regular-solid-bg); font-size: 12px; box-shadow: 0 2px 8px rgba(0 0 0 / .1); }
/* diagram ink follows the theme; bpmn-js draws with inline styles, so override strokes/fills here */
.host :deep(.bjs-powered-by) { display: none; }
.host :deep(.djs-container) { --ink: var(--text-primary); }
.host :deep(.djs-visual > :is(rect, circle, polygon, path)) { stroke: var(--text-secondary) !important; fill: var(--regular-solid-bg) !important; }
.host :deep(.djs-connection .djs-visual > path) { stroke: var(--text-tertiary) !important; fill: none !important; }
.host :deep(.djs-visual text) { fill: var(--text-primary) !important; font-family: var(--font-sans) !important; }
.host :deep(.djs-element[data-element-id^="Participant"] .djs-visual > rect),
.host :deep(.djs-element[data-element-id^="Lane"] .djs-visual > rect) { fill: transparent !important; stroke: var(--hairline) !important; }
.host :deep(.st-done .djs-visual > :is(rect, circle, polygon)) { fill: color-mix(in srgb, #0F9D58 22%, var(--regular-solid-bg)) !important; stroke: #0F9D58 !important; stroke-width: 2px !important; }
.host :deep(.st-active .djs-visual > :is(rect, circle, polygon)) { stroke: var(--text-primary) !important; stroke-width: 2.5px !important; animation: pulse 1.6s ease-in-out infinite; }
.host :deep(.st-mine .djs-visual > :is(rect, circle, polygon)) { fill: color-mix(in srgb, #FF4D00 18%, var(--regular-solid-bg)) !important; stroke: #FF4D00 !important; stroke-width: 2.5px !important; }
.host :deep(.st-skipped .djs-visual) { opacity: .35; }
/* a map case's states (markers): the same colours as its flowchart's legend (ontology/OntoCaseFlow.vue) */
.host :deep(.djs-shape.cs-done .djs-visual > :is(rect, circle, polygon)) { fill: color-mix(in srgb, var(--color-success) 20%, var(--regular-solid-bg)) !important; stroke: color-mix(in srgb, var(--color-success) 70%, transparent) !important; stroke-width: 1.8px !important; }
.host :deep(.djs-shape.cs-running .djs-visual > :is(rect, circle, polygon)) { fill: color-mix(in srgb, var(--color-info) 22%, var(--regular-solid-bg)) !important; stroke: var(--color-info) !important; stroke-width: 2.5px !important; animation: pulse 1.6s ease-in-out infinite; }
.host :deep(.djs-shape.cs-person .djs-visual > :is(rect, circle, polygon)) { fill: color-mix(in srgb, var(--color-info) 14%, var(--regular-solid-bg)) !important; stroke: var(--color-info) !important; stroke-width: 2.5px !important; }
.host :deep(.djs-shape.cs-waiting .djs-visual > :is(rect, circle, polygon)) { fill: color-mix(in srgb, var(--color-warning, #b26a00) 20%, var(--regular-solid-bg)) !important; stroke: var(--color-warning, #b26a00) !important; stroke-width: 2.5px !important; }
.host :deep(.djs-shape.cs-skipped .djs-visual > :is(rect, circle, polygon)) { fill: transparent !important; stroke: var(--text-tertiary) !important; stroke-dasharray: 4 3; }
.host :deep(.djs-shape.cs-skipped .djs-visual text) { fill: var(--text-secondary) !important; text-decoration: line-through; }
.host :deep(.djs-shape.cs-next .djs-visual > :is(rect, circle, polygon)) { fill: transparent !important; stroke: var(--color-info) !important; stroke-width: 1.8px !important; stroke-dasharray: 4 3; }
.host :deep(.djs-shape.cs-closed .djs-visual) { opacity: .5; }
.host :deep(.djs-connection.cs-taken .djs-visual > path) { stroke: var(--text-primary) !important; stroke-width: 2.6px !important; }
.host :deep(.djs-connection.cs-extra .djs-visual > path) { stroke: var(--text-primary) !important; stroke-width: 2.2px !important; stroke-dasharray: 5 3; }
.host :deep(.djs-connection.cs-rewound .djs-visual > path) { stroke: var(--color-warning, #b26a00) !important; stroke-width: 2.2px !important; stroke-dasharray: 5 3; }
.host :deep(.djs-connection.cs-skipped .djs-visual > path) { stroke-dasharray: 2 4; opacity: .45; }
</style>
