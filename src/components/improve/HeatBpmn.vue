<script setup>
// The process's BPMN with the analysis on it.
//  mode 'heat' — process-gpt BottleneckAnalysis 의 열지도: 단계마다 값(0~1 강도)에 따라 초록→노랑→주황→빨강 빛과 값 배지
//  mode 'path' — 크리티컬 패스: 크리티컬 단계·연결선은 주황 굵게, 나머지는 흐리게, 여유 시간 배지
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer'
import 'bpmn-js/dist/assets/diagram-js.css'
import 'bpmn-js/dist/assets/bpmn-js.css'
import { api } from '../../api.js'

const props = defineProps({
  defId: String, version: { type: String, default: '' }, height: { type: Number, default: 340 },
  mode: { type: String, default: 'heat' },
  heat: { type: Object, default: () => ({}) },      // {activityId: {v: 0..1, label}}
  critical: { type: Object, default: () => ({ nodes: [], edges: [] }) },
  badges: { type: Object, default: () => ({}) },    // {activityId: text} (path mode: 여유 시간)
})
const emit = defineEmits(['select'])
const host = ref(null)
const empty = ref(false)
let viewer

function gradient(i) {
  const red = 'rgba(234,67,53,.85)', orange = 'rgba(251,140,0,.75)', yellow = 'rgba(251,188,4,.65)', lime = 'rgba(156,204,101,.55)', green = 'rgba(76,175,80,.45)', t = 'rgba(76,175,80,0)'
  if (i >= 0.8) return `radial-gradient(ellipse at center, ${red} 0%, ${orange} 25%, ${yellow} 45%, ${lime} 65%, ${green} 80%, ${t} 100%)`
  if (i >= 0.6) return `radial-gradient(ellipse at center, ${orange} 0%, ${yellow} 30%, ${lime} 55%, ${green} 75%, ${t} 100%)`
  if (i >= 0.4) return `radial-gradient(ellipse at center, ${yellow} 0%, ${lime} 40%, ${green} 70%, ${t} 100%)`
  if (i >= 0.2) return `radial-gradient(ellipse at center, ${lime} 0%, ${green} 50%, ${t} 100%)`
  return `radial-gradient(ellipse at center, ${green} 0%, ${t} 100%)`
}

function paint() {
  if (!viewer) return
  const canvas = viewer.get('canvas'), reg = viewer.get('elementRegistry'), overlays = viewer.get('overlays')
  overlays.remove({ type: 'imp' })
  for (const el of reg.getAll()) for (const m of ['crit', 'dim', 'crit-edge']) canvas.removeMarker(el.id, m)
  if (props.mode === 'heat') {
    for (const [id, h] of Object.entries(props.heat)) {
      const el = reg.get(id)
      if (!el) continue
      const g = 18 + h.v * 30
      const glow = document.createElement('div')
      glow.className = 'imp-glow'
      glow.style.cssText = `width:${el.width + g * 2}px;height:${el.height + g * 2}px;left:${-g}px;top:${-g}px;border-radius:${12 + g}px;background:${gradient(h.v)};filter:blur(${8 + h.v * 8}px)`
      overlays.add(id, 'imp', { position: { top: 0, left: 0 }, html: glow })
      const b = document.createElement('div')
      b.className = 'imp-badge' + (h.v >= 0.8 ? ' hot' : '')
      b.textContent = h.label
      b.onclick = () => emit('select', id)
      overlays.add(id, 'imp', { position: { top: -14, right: 6 }, html: b })
    }
  } else {
    const crit = new Set([...(props.critical.nodes || []), ...(props.critical.edges || [])])
    for (const el of reg.getAll()) {
      if (!el.businessObject || el.type === 'label' || /Participant|Lane|Process|Collaboration/.test(el.type)) continue
      // flows are matched by their ends (the generator names them itself)
      const key = el.waypoints ? `${el.businessObject.sourceRef?.id}>${el.businessObject.targetRef?.id}` : el.id
      if (crit.has(key)) canvas.addMarker(el.id, el.waypoints ? 'crit-edge' : 'crit')
      else canvas.addMarker(el.id, 'dim')
    }
    for (const [id, t] of Object.entries(props.badges)) {
      if (!reg.get(id) || !t) continue
      const b = document.createElement('div')
      b.className = 'imp-badge' + (crit.has(id) ? ' hot' : ' slack')
      b.textContent = t
      overlays.add(id, 'imp', { position: { bottom: -6, left: 6 }, html: b })
    }
  }
}

async function load() {
  empty.value = false
  const r = await api(`/improve/${encodeURIComponent(props.defId)}/bpmn${props.version && props.version !== 'all' ? `?version=${encodeURIComponent(props.version)}` : ''}`, { raw: true })
  if (!r.ok) { empty.value = true; return }
  try {
    await viewer.importXML(await r.text())
    fit()
    paint()
  } catch (e) { console.warn('[bpmn]', e.message); empty.value = true }
}
const fit = () => { viewer?.get('canvas').resized(); viewer?.get('canvas').zoom('fit-viewport', 'auto') }
onMounted(() => { viewer = new NavigatedViewer({ container: host.value }); load() })
onBeforeUnmount(() => viewer?.destroy())
watch(() => [props.defId, props.version], load)
watch(() => [props.mode, JSON.stringify(props.heat), JSON.stringify(props.critical), JSON.stringify(props.badges)], paint)
defineExpose({ fit })
</script>

<template>
  <div class="hb" :style="{ height: height + 'px' }">
    <div ref="host" class="host" />
    <p v-if="empty" class="none">이 프로세스에는 저장된 BPMN 다이어그램이 없어요.</p>
    <button v-else class="fitb press" aria-label="화면에 맞추기" @click="fit">맞춤</button>
  </div>
</template>

<style scoped>
.hb { position: relative; border-radius: 18px; overflow: hidden; background: var(--field-bg); }
.host { position: absolute; inset: 0; }
.none { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--text-secondary); font-size: 14px; }
.fitb { position: absolute; right: 10px; bottom: 10px; height: 30px; padding: 0 12px; border-radius: 9999px; background: var(--regular-solid-bg); font-size: 12px; box-shadow: 0 2px 8px rgba(0 0 0 / .1); }
.host :deep(.bjs-powered-by) { display: none; }
.host :deep(.djs-visual > :is(rect, circle, polygon, path)) { stroke: var(--text-secondary) !important; fill: var(--regular-solid-bg) !important; }
.host :deep(.djs-connection .djs-visual > path) { stroke: var(--text-tertiary) !important; fill: none !important; }
.host :deep(.djs-visual text) { fill: var(--text-primary) !important; font-family: var(--font-sans) !important; }
.host :deep(.djs-element[data-element-id^="Participant"] .djs-visual > rect),
.host :deep(.djs-element[data-element-id^="Lane"] .djs-visual > rect) { fill: transparent !important; stroke: var(--hairline) !important; }
.host :deep(.imp-glow) { position: absolute; pointer-events: none; z-index: -1; }
.host :deep(.djs-overlay-container) { z-index: 2; }
.host :deep(.imp-badge) { white-space: nowrap; font: 600 11.5px/1 var(--font-sans); padding: 4px 8px; border-radius: 9999px; background: var(--regular-solid-bg); color: var(--text-primary); box-shadow: 0 2px 8px rgba(0 0 0 / .18); cursor: pointer; }
.host :deep(.imp-badge.hot) { background: #e0613f; color: #fff; }
.host :deep(.imp-badge.slack) { background: var(--chip-bg); color: var(--text-secondary); font-weight: 500; }
.host :deep(.crit .djs-visual > :is(rect, circle, polygon)) { stroke: #e0613f !important; stroke-width: 3px !important; fill: color-mix(in srgb, #e0613f 14%, var(--regular-solid-bg)) !important; }
.host :deep(.crit-edge .djs-visual > path) { stroke: #e0613f !important; stroke-width: 3px !important; }
.host :deep(.dim .djs-visual) { opacity: .45; }
</style>
