<script setup>
// θ(입도) 고르기: 요약 · 기본 · 전체 = 묶음의 요약 θ · 자동으로 정한 θ · 0, 또는 막대로 0 ~ 20%.
// 보기만 바꾼다(실행에 쓰는 θ 는 그대로). 묶음을 고르지 않았으면(전체) 요약 · 기본은 묶음마다 그 묶음의 값.
import { computed } from 'vue'
import { THETAS, pct } from './fmt.js'
import { thetaOf } from './mapView.js'

const props = defineProps({ mode: { type: [String, Number], default: 'summary' }, bundle: { type: Object, default: null } })
const emit = defineEmits(['update:mode'])
const MODES = [['summary', '요약'], ['auto', '기본'], ['all', '전체']]

const value = computed(() => thetaOf(props.mode, props.bundle))
const nearest = (v) => THETAS.reduce((b, t, i) => (Math.abs(t - v) < Math.abs(THETAS[b] - v) ? i : b), 0)
const index = computed(() => nearest(value.value))
const autoIndex = computed(() => (props.bundle ? THETAS.findIndex((t) => Math.abs(t - props.bundle.theta) < 1e-9) : -1))
const shown = computed(() => (!props.bundle && typeof props.mode === 'string' && props.mode !== 'all' ? '묶음마다' : pct(value.value)))
const slide = (ev) => emit('update:mode', THETAS[Number(ev.target.value)])
const on = (k) => props.mode === k
</script>

<template>
  <div class="theta">
    <span class="lab" title="이보다 드문 길은 지도에서 빼고 봐요(고정한 길은 남아요)">θ <b>{{ shown }}</b></span>
    <div class="seg">
      <button v-for="[k, l] in MODES" :key="k" :class="{ on: on(k) }" @click="emit('update:mode', k)">{{ l }}</button>
    </div>
    <div class="slider">
      <input type="range" min="0" :max="THETAS.length - 1" step="1" :value="index" aria-label="θ" @input="slide">
      <div class="ticks">
        <span v-for="(t, i) in THETAS" :key="t" :class="{ cur: Math.abs(t - value) < 1e-9, auto: i === autoIndex }" :style="{ left: `calc(${(i / (THETAS.length - 1)) * 100}% + ${8 - (i / (THETAS.length - 1)) * 16}px)` }">
          {{ pct(t) }}<i v-if="i === autoIndex">자동</i>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.lab { font-size: 13px; color: var(--text-secondary); white-space: nowrap; min-width: 74px; }
.lab b { color: var(--text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.seg { display: flex; gap: 2px; padding: 2px; border-radius: 9999px; background: var(--field-bg); }
.seg button { height: 30px; padding: 0 13px; border-radius: 9999px; font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
.seg button.on { background: var(--regular-solid-bg); color: var(--text-primary); box-shadow: 0 1px 4px rgba(0 0 0 / .12); }
.slider { position: relative; width: 230px; padding-bottom: 28px; }
input[type=range] { width: 100%; margin: 0; accent-color: var(--text-primary); height: 18px; cursor: pointer; }
.ticks { position: absolute; left: 0; right: 0; bottom: 0; height: 26px; }
.ticks span { position: absolute; top: 0; translate: -50% 0; display: flex; flex-direction: column; align-items: center; line-height: 1.2; font-size: 10.5px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ticks span.cur { color: var(--text-primary); font-weight: 600; }
.ticks span.auto i { font-style: normal; font-size: 10px; line-height: 13px; padding: 0 5px; border-radius: 6px; background: var(--color-success); color: #0b2a17; font-weight: 600; }
@media (max-width: 760px) {
  .slider { flex: 1; min-width: 180px; }
}
</style>
