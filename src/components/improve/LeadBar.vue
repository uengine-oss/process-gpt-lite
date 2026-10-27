<script setup>
// 리드타임 분해 막대 (process-gpt LeadTimeBreakdownBar 를 옮긴 것: 같은 순서·같은 색)
import { computed } from 'vue'
import { SEG, dur } from './fmt.js'
const props = defineProps({ totals: { type: Object, default: () => ({}) }, height: { type: Number, default: 10 }, legend: Boolean, total: Number })
const sum = computed(() => props.total || Object.values(props.totals || {}).reduce((a, b) => a + (b || 0), 0))
const parts = computed(() => SEG.filter((s) => (props.totals?.[s.key] || 0) > 0).map((s) => ({ ...s, sec: props.totals[s.key], pct: sum.value ? (props.totals[s.key] / sum.value) * 100 : 0 })))
</script>

<template>
  <div class="lb">
    <div class="bar" :style="{ height: height + 'px' }">
      <span v-for="p in parts" :key="p.key" :style="{ width: p.pct + '%', background: p.color }" :title="`${p.label} ${dur(p.sec)} (${p.pct.toFixed(1)}%)`" />
    </div>
    <div v-if="legend" class="lg">
      <span v-for="p in parts" :key="p.key"><i :style="{ background: p.color }" />{{ p.label }} <b>{{ dur(p.sec) }}</b> {{ p.pct.toFixed(1) }}%</span>
    </div>
  </div>
</template>

<style scoped>
.bar { display: flex; border-radius: 4px; overflow: hidden; background: var(--field-bg); min-width: 40px; }
.bar span { height: 100%; min-width: 2px; }
.lg { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 12.5px; color: var(--text-secondary); }
.lg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
.lg b { color: var(--text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
</style>
