<script setup>
// 길에서 여는 간선 설정(gallimgil-merge): 관계 패널의 「자세히」로 그 길(X → Y, X → 끝)에 든 간선(X 의 결과물 · 「X 완료」 → Y)을
//   작은 칩으로 보이고, 고른 간선의 설정을 사건 보기와 같은 패널(OntoEdgeRule)로 연다. 저장하는 곳은 간선 하나 — 어느 경로로 열어도 같은 값.
// 칩의 앞 표시는 지도와 같은 꼴(꼭 = 보라 굵게 · 선택 = 파랑 점선 · 사안에 따라 = 파랑 잔 점선, 정하지 않음 = 회색 가는 선).
// edges: edge-conditions 목록 중 이 길의 것 [{event, task, step, name, n, mark, cls}] · pick: 처음 고를 간선(event). emits changed
import { ref, computed, watch } from 'vue'
import OntoEdgeRule from './OntoEdgeRule.vue'

const props = defineProps({ procKey: { type: String, required: true }, edges: { type: Array, default: () => [] }, pick: { type: String, default: '' }, admin: Boolean })
const emit = defineEmits(['changed'])

const MARK_KO = { req: '꼭', opt: '선택', cond: '사안에 따라' }
const CLS_KO = { human: '사람이 꼭', ai: 'AI가 맡음', drop: '걷어냄', skipped: '건너뛰었지만 해야 함' }
// 자주 지나는 간선부터
const list = computed(() => [...props.edges].sort((a, b) => (b.n || 0) - (a.n || 0)))
const cur = ref(props.pick)
watch(() => props.pick, (v) => { if (v) cur.value = v })
watch(() => list.value.map((e) => e.event).join('\u0001'), () => {
  if (!list.value.some((e) => e.event === cur.value)) cur.value = list.value[0]?.event || ''
}, { immediate: true })
const picked = computed(() => list.value.find((e) => e.event === cur.value) || null)
const tipOf = (e) => [e.name, MARK_KO[e.mark] || '정하지 않음', CLS_KO[e.cls]].filter(Boolean).join(' · ')
</script>

<template>
  <section v-if="list.length" class="se" data-testid="onto-step-edges">
    <div class="ins" role="tablist" aria-label="이 길의 간선">
      <button v-for="e in list" :key="e.event" class="in press" role="tab" :aria-selected="cur === e.event" :class="{ on: cur === e.event }" :title="tipOf(e)"
        data-testid="onto-step-edge" :data-event="e.event" :data-mark="e.mark || ''" @click="cur = e.event">
        <svg width="18" height="8" aria-hidden="true"><path d="M1 4h16" class="sw" :class="e.mark || 'none'" /></svg>
        <span class="nm">{{ e.name }}</span>
      </button>
    </div>
    <OntoEdgeRule v-if="picked" :proc-key="procKey" :event="picked.event" :task="picked.task" :admin="admin" @changed="(x) => emit('changed', x)" />
  </section>
</template>

<style scoped>
.se { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ins { display: flex; flex-wrap: wrap; gap: 6px; }
.in { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 30px; padding: 0 12px 0 10px; border-radius: 9999px; font-size: 12.5px; background: var(--field-bg); box-shadow: inset 0 0 0 1px transparent; }
.in.on { box-shadow: inset 0 0 0 2px var(--ink); font-weight: 600; }
.in .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.in svg { flex: none; }
.sw { stroke: var(--text-tertiary); stroke-width: 1.5; }
.sw.req { stroke: #7a4fd0; stroke-width: 3.2; }
.sw.opt { stroke: #2b7fbf; stroke-width: 2; stroke-dasharray: 4 3; }
.sw.cond { stroke: #2b7fbf; stroke-width: 2; stroke-dasharray: 1.5 2.5; stroke-linecap: round; }
</style>
