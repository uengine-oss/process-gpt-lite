<script setup>
// 관계 패널의 「이 길로 가면」(gallimgil-merge): 고른 프로세스에서 이 길(X → Y, X → 끝)에 든 간선(X 의 결과물 · 「X 완료」 → Y)의 설정을 한 줄씩 —
//   꼭 · 선택 · 사안에 따라 규칙 · 분류 · AI 제안 수. 「자세히」는 그 간선의 간선 패널(OntoEdgeRule)을 연다. 갈림길 조건은 간선의
//   「사안에 따라」라서 정하는 곳은 간선 패널 하나다. edges: edge-conditions 목록 중 이 길의 간선 · emits open(event)
import { ref, watch } from 'vue'
import { api } from '../../api.js'

const props = defineProps({ procKey: { type: String, required: true }, edges: { type: Array, default: () => [] }, end: Boolean })
const emit = defineEmits(['open'])
const REQ = { required: '꼭', optional: '선택' }
const CLS = { human: '사람이 꼭', ai: 'AI가 맡음', drop: '걷어냄', skipped: '건너뛰었지만 해야 함' }
const views = ref(new Map())
async function load() {
  const out = new Map()
  await Promise.all(props.edges.map(async (e) => {
    try { out.set(e.event, await api(`/ontology/processes/${encodeURIComponent(props.procKey)}/edge-condition?event=${encodeURIComponent(e.event)}&task=${encodeURIComponent(e.task)}`)) } catch { /* the list's line stays */ }
  }))
  views.value = out
}
watch(() => [props.procKey, props.edges.map((e) => `${e.event}>${e.task}>${e.mark}>${e.cls}`).join('|')], load, { immediate: true })
function parts(e) {
  const v = views.value.get(e.event), s = v || e.setting || {}
  const rules = s.rules || []
  const out = []
  if (!props.end) out.push(REQ[s.requirement] || '지도대로')
  if (rules.length) out.push(rules.map((r) => r.text?.replace(/ → (꼭|선택)$/, (m, t) => (props.end ? ' → 끝' : ` → ${t}`)) || '').join(' · '))
  const c = v ? (v.class?.decided ? v.class.class : null) : e.cls
  if (c) out.push(CLS[c])
  return out
}
const suggN = (e) => views.value.get(e.event)?.suggestions?.length || 0
</script>

<template>
  <div class="ws" data-testid="onto-way-summary">
    <h4>{{ end ? '이 길로 끝나는 경우' : '이 길로 가면' }}</h4>
    <div v-for="e in edges" :key="e.event" class="row" data-testid="onto-way-edge" :data-event="e.event" :data-mark="e.mark || ''">
      <svg width="18" height="8" aria-hidden="true"><path d="M1 4h16" class="sw" :class="e.mark || 'none'" /></svg>
      <span class="t"><b>{{ e.name }}</b><small>{{ parts(e).join(' · ') || '정하지 않음' }}<template v-if="suggN(e)"> · AI 제안 {{ suggN(e) }}</template></small></span>
      <button class="more press" data-testid="onto-way-open" @click="emit('open', e.event)">자세히</button>
    </div>
  </div>
</template>

<style scoped>
.ws { padding: 12px; border-radius: 16px; background: var(--cell-bg); display: flex; flex-direction: column; gap: 6px; word-break: keep-all; min-width: 0; }
h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.row svg { flex: none; }
.t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.t b { font-size: 13.5px; font-weight: 600; }
.t small { font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
.more { flex: none; height: 28px; padding: 0 12px; border-radius: 9999px; font-size: 12.5px; font-weight: 500; background: var(--field-bg); box-shadow: inset 0 0 0 1px var(--hairline); }
.sw { stroke: var(--text-tertiary); stroke-width: 1.5; }
.sw.req { stroke: #7a4fd0; stroke-width: 3.2; }
.sw.opt { stroke: #2b7fbf; stroke-width: 2; stroke-dasharray: 4 3; }
.sw.cond { stroke: #2b7fbf; stroke-width: 2; stroke-dasharray: 1.5 2.5; stroke-linecap: round; }
</style>
