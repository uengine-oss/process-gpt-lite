<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer'
import 'bpmn-js/dist/assets/diagram-js.css'
import 'bpmn-js/dist/assets/bpmn-js.css'
import { api } from '../api.js'

// Renders the process-gpt designer's stored BPMN, painting each node by its live state.
// steps: [{id, state: done|active|pending|skipped, mine}]
const props = defineProps({ defId: String, steps: { type: Array, default: () => [] }, height: { type: Number, default: 360 } })
const host = ref(null)
const empty = ref(false)
const h = ref(props.height)
const big = ref(false)
let viewer

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
}

async function load() {
  const r = await api(`/processes/${encodeURIComponent(props.defId)}/bpmn`, { raw: true })
  if (!r.ok) { empty.value = true; return }
  try {
    await viewer.importXML(await r.text())
    // size the box to the diagram's aspect so wide flows are not shrunk to a sliver
    const inner = viewer.get('canvas').viewbox().inner
    const w = host.value.clientWidth || 600
    h.value = Math.max(180, Math.min(props.height, Math.round(w * inner.height / inner.width) + 48))
    paint()
    // the box animates to its new height; fit once it has settled
    await new Promise((r) => setTimeout(r, 420))
    fit()
  } catch (e) {
    console.warn('[bpmn]', e.message)
    empty.value = true
  }
}

onMounted(() => {
  viewer = new NavigatedViewer({ container: host.value })
  load()
})
onBeforeUnmount(() => viewer?.destroy())
watch(() => props.steps.map((s) => s.state + s.mine).join(), paint)
watch(() => props.defId, load)
const fit = () => { viewer?.get('canvas').resized(); viewer?.get('canvas').zoom('fit-viewport', 'auto') }
async function toggleBig() {
  big.value = !big.value
  await new Promise((r) => setTimeout(r, 380))
  fit()
}
defineExpose({ fit })
</script>

<template>
  <div v-if="big" class="spacer" :style="{ height: h + 'px' }" />
  <Teleport to="body" :disabled="!big">
  <div v-if="big" class="scrim" @click="toggleBig" />
  <div class="bpmn" :class="{ big }" :style="{ height: big ? null : h + 'px' }">
    <div ref="host" class="host" />
    <p v-if="empty" class="none">이 프로세스에는 저장된 BPMN 다이어그램이 없어요.</p>
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
</style>
