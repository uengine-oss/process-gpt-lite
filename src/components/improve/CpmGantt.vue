<script setup>
// 크리티컬 패스 간트: 단계마다 가장 이른 시작(ES)~끝(EF) 막대(대기는 빗금, 작업은 진하게), 크리티컬 단계는 주황,
// 여유 시간은 EF~LF 가는 선. 시간축은 인스턴스 시작부터의 일 수.
import { computed } from 'vue'
import { dur, pct } from './fmt.js'
const props = defineProps({ rows: { type: Array, default: () => [] }, total: Number, compareTotal: Number })
const W = 1100, L = 150, R = 16, H = 28
const span = computed(() => Math.max(props.total || 0, props.compareTotal || 0, ...props.rows.map((r) => r.lf || r.ef || 0), 1))
const x = (t) => L + ((W - L - R) * t) / span.value
const ticks = computed(() => {
  const days = span.value / 86400
  const step = days > 10 ? 2 : days > 4 ? 1 : days > 1.5 ? 0.5 : 0.25
  const out = []
  for (let d = 0; d <= days + 1e-9; d += step) out.push(d)
  return out
})
const height = computed(() => 34 + props.rows.length * H)
// where a bar's label fits: after it, before it, or inside it
const place = (r) => (x(r.ef) + 150 <= W ? 'right' : x(r.es) - L > 110 ? 'left' : 'inside')
</script>

<template>
  <svg class="gantt" :viewBox="`0 0 ${W} ${height}`" role="img" aria-label="크리티컬 패스 간트 차트">
    <defs>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="currentColor" opacity=".18" /><line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="2.4" opacity=".35" /></pattern>
      <pattern id="hatch-c" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#e0613f" opacity=".25" /><line x1="0" y1="0" x2="0" y2="6" stroke="#e0613f" stroke-width="2.4" opacity=".55" /></pattern>
    </defs>
    <g class="axis">
      <template v-for="d in ticks" :key="d">
        <line :x1="x(d * 86400)" :x2="x(d * 86400)" y1="22" :y2="height" />
        <text :x="x(d * 86400)" y="14" text-anchor="middle">{{ d === 0 ? '시작' : `${d}일` }}</text>
      </template>
    </g>
    <line v-if="compareTotal" class="cmp" :x1="x(compareTotal)" :x2="x(compareTotal)" y1="22" :y2="height" />
    <g v-for="(r, i) in rows" :key="r.id + i" :transform="`translate(0 ${30 + i * H})`" :class="{ crit: r.critical, loop: r.loop }">
      <text class="nm" x="0" y="15">{{ r.name.length > 11 ? r.name.slice(0, 11) + '…' : r.name }}</text>
      <rect class="lane" :x="L" y="2" :width="W - L - R" height="20" rx="4" />
      <rect :x="x(r.es)" y="4" :width="Math.max(2, x(r.es + (r.wait || 0)) - x(r.es))" height="16" rx="3" :fill="r.critical ? 'url(#hatch-c)' : 'url(#hatch)'" />
      <rect class="work" :x="x(r.es + (r.wait || 0))" y="4" :width="Math.max(2, x(r.ef) - x(r.es + (r.wait || 0)))" height="16" rx="3" />
      <line v-if="!r.critical && r.slack > 60" class="slk" :x1="x(r.ef)" :x2="x(r.lf)" y1="21" y2="21" />
      <text class="lab" :class="place(r)" :x="place(r) === 'right' ? x(r.ef) + 6 : place(r) === 'left' ? x(r.es) - 6 : x(r.es) + 8" y="16" :text-anchor="place(r) === 'left' ? 'end' : 'start'">{{ dur(r.d, { short: true }) }}{{ !r.critical && r.slack > 60 ? ` · 여유 ${dur(r.slack, { short: true })}` : '' }}{{ r.p < 0.995 && !r.loop ? ` · ${pct(r.p)}` : '' }}</text>
    </g>
  </svg>
</template>

<style scoped>
.gantt { width: 100%; height: auto; color: var(--text-secondary); font-family: var(--font-sans); }
.axis line { stroke: var(--hairline); }
.axis text { font-size: 11px; fill: var(--text-tertiary); }
.nm { font-size: 12.5px; fill: var(--text-primary); }
.crit .nm { font-weight: 600; }
.lane { fill: var(--field-bg); opacity: .5; }
.work { fill: var(--text-tertiary); }
.crit .work { fill: #e0613f; }
.loop .work { fill: #7C3AED; opacity: .7; }
.slk { stroke: var(--text-tertiary); stroke-width: 2; stroke-dasharray: 3 3; }
.lab { font-size: 11px; fill: var(--text-secondary); }
.crit .lab { fill: var(--text-primary); }
.lab.inside { fill: #fff; font-weight: 600; }
.cmp { stroke: var(--color-success); stroke-width: 2; stroke-dasharray: 5 4; }
</style>
