<script setup>
// θ(입도) 고르기: 요약 · 기본 · 전체 = 프로세스의 요약 θ · 자동으로 정한 θ · 0. 한 컨트롤이다:
// 평소엔 세 단추와 지금 θ 값만 보이고, 값을 누르면(또는 직접 고른 값이 있으면) 그 뒤에 막대(0 ~ 20%)가 펼쳐진다.
// 보기만 바꾼다(실행에 쓰는 θ 는 그대로). 프로세스를 고르지 않았으면(전체) 요약 · 기본은 프로세스마다 그 프로세스의 값.
import { computed, ref } from 'vue'
import { THETAS, pct } from './fmt.js'
import { thetaOf } from './mapView.js'
import { local } from './ontoText.js'

const props = defineProps({ mode: { type: [String, Number], default: 'summary' }, proc: { type: Object, default: null } })
const emit = defineEmits(['update:mode'])
const MODES = [
  ['summary', '요약', '큰 줄기만: 일이 8개 이하로 남을 때까지 드문 길을 빼요(그래서 θ 가 20%를 넘기도 해요)'],
  ['auto', '기본', '자동으로 정한 θ: 지난 건 일부를 떼어 두고, 지도가 그 건들의 흐름을 가장 알뜰하게 설명하는 값'],
  ['all', '전체', 'θ 0: 한 번이라도 지나간 길을 모두'],
]

const value = computed(() => thetaOf(props.mode, props.proc))
const nearest = (v) => THETAS.reduce((b, t, i) => (Math.abs(t - v) < Math.abs(THETAS[b] - v) ? i : b), 0)
const index = computed(() => nearest(value.value))
const autoIndex = computed(() => (props.proc ? THETAS.findIndex((t) => Math.abs(t - props.proc.theta) < 1e-9) : -1))
const shown = computed(() => (!props.proc && typeof props.mode === 'string' && props.mode !== 'all' ? '프로세스마다' : pct(value.value)))
const slide = (ev) => emit('update:mode', THETAS[Number(ev.target.value)])
const on = (k) => props.mode === k
// 막대: 직접 고른 값(숫자)이면 늘 보이고, 아니면 값을 눌러 펼친 동안만(이 기기에서 기억)
const custom = computed(() => typeof props.mode === 'number')
const opened = ref(!!local.get('thetaFine'))
const fine = computed(() => custom.value || opened.value)
function toggle() {
  const next = !fine.value
  opened.value = next
  local.set('thetaFine', next)
  // 직접 고른 값을 접으면 가장 가까운 단추로 돌아간다: 0 은 전체, 그 밖은 기본
  if (!next && custom.value) emit('update:mode', value.value === 0 ? 'all' : 'auto')
}
</script>

<template>
  <div class="theta">
    <div class="seg">
      <button v-for="[k, l, tip] in MODES" :key="k" :class="{ on: on(k) }" :title="tip" @click="emit('update:mode', k)">{{ l }}</button>
      <button class="val" :class="{ on: custom, open: fine }" data-testid="theta-fine" :aria-expanded="fine" title="θ(입도): 이보다 드문 길은 지도에서 빼고 봐요(고정한 길은 남아요). 누르면 막대로 직접 골라요" @click="toggle">
        θ <b>{{ shown }}</b><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
    </div>
    <div v-if="fine" class="slider">
      <input type="range" min="0" :max="THETAS.length - 1" step="1" :value="index" aria-label="θ" @input="slide">
      <div class="ticks">
        <span v-for="(t, i) in THETAS" :key="t" :class="{ cur: Math.abs(t - value) < 1e-9 || (i === THETAS.length - 1 && value > t), auto: i === autoIndex }" :style="{ left: `calc(${(i / (THETAS.length - 1)) * 100}% + ${8 - (i / (THETAS.length - 1)) * 16}px)` }">
          {{ i === THETAS.length - 1 && value > t ? pct(value) : pct(t) }}<i v-if="i === autoIndex">자동</i>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.seg { display: flex; gap: 2px; padding: 2px; border-radius: 9999px; background: var(--field-bg); }
.seg button { height: 30px; padding: 0 13px; border-radius: 9999px; font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
.seg button.on { background: var(--regular-solid-bg); color: var(--text-primary); box-shadow: 0 1px 4px rgba(0 0 0 / .12); }
.seg .val { display: inline-flex; align-items: center; gap: 4px; margin-left: 2px; padding: 0 9px 0 11px; border-left: 1px solid var(--border-subtle, rgba(128 128 128 / .25)); border-radius: 0 9999px 9999px 0; font-variant-numeric: tabular-nums; }
.seg .val.on { border-left-color: transparent; border-radius: 9999px; }
.seg .val b { color: var(--text-primary); font-weight: 600; }
.seg .val svg { width: 10px; height: 10px; transition: rotate .15s; }
.seg .val.open svg { rotate: 180deg; }
.slider { position: relative; width: 230px; padding-bottom: 28px; margin-top: 10px; }
input[type=range] { width: 100%; margin: 0; accent-color: var(--text-primary); height: 18px; cursor: pointer; }
.ticks { position: absolute; left: 0; right: 0; bottom: 0; height: 26px; }
.ticks span { position: absolute; top: 0; translate: -50% 0; display: flex; flex-direction: column; align-items: center; line-height: 1.2; font-size: 10.5px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ticks span.cur { color: var(--text-primary); font-weight: 600; }
.ticks span.auto i { font-style: normal; font-size: 10px; line-height: 13px; padding: 0 5px; border-radius: 6px; background: var(--color-success); color: #0b2a17; font-weight: 600; }
@media (max-width: 760px) {
  .slider { flex: 1; min-width: 180px; }
}
</style>
