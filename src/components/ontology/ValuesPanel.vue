<script setup>
// 값 보기: 묶음마다 자동으로 정한 θ · 반감기 · 띠와 그 근거(서버 stats.js 가 잰 숫자).
//   θ      θ 후보마다 떼어 둔 최근 건의 재생 적합도 — 곡선이 가장 크게 꺾이기 직전 값
//   반감기  후보마다 최근 4주 이동의 로그 우도 — 가장 큰 값
//   띠     떼어 둔 최근 건에서 다음 일을 1위로 맞힌 비율이 0.5 이상이면 굳은 길
// 잴 수 없을 만큼 데이터가 적으면 시작값을 쓰고 「시작값」으로 표시한다.
import { computed } from 'vue'
import { pct, BAND } from './fmt.js'

const props = defineProps({ bundle: { type: Object, required: true }, meta: { type: Object, default: null }, compact: Boolean })
const b = computed(() => props.bundle)

// θ별 재생 적합도
const CW = 300, CH = 128, PL = 40, PR = 14, PT = 16, PB = 30
const fit = computed(() => {
  const curve = b.value.curve || []
  if (!curve.length) return null
  const lo = Math.max(0, Math.floor((Math.min(...curve.map((c) => c.fitness)) - 0.02) * 20) / 20)
  const x = (i) => PL + (i * (CW - PL - PR)) / Math.max(1, curve.length - 1)
  const y = (v) => PT + ((1 - v) / Math.max(0.05, 1 - lo)) * (CH - PT - PB)
  const pts = curve.map((c, i) => ({ ...c, x: x(i), y: y(c.fitness), chosen: Math.abs(c.theta - b.value.theta) < 1e-9 }))
  return { lo, pts, line: pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '), y1: y(1), ylo: y(lo) }
})
const chosen = computed(() => fit.value?.pts.find((p) => p.chosen))

// 반감기 후보별 로그 우도
const hl = computed(() => {
  const s = b.value.hl_scores?.length ? b.value.hl_scores : props.meta?.values?.halfLifeScores || []
  if (!s.length) return []
  const min = Math.min(...s.map((x) => x.ll)), max = Math.max(...s.map((x) => x.ll))
  return s.map((x) => ({ ...x, w: max > min ? 12 + ((x.ll - min) / (max - min)) * 88 : 100, chosen: x.halfLife === b.value.half_life }))
})
const tested = computed(() => props.meta?.values?.tested)
const bandText = { paved: '다음 일을 대개 맞혀요. 흐름 그림대로 돌려도 돼요.', open: '다음 일이 자주 달라져요. 사람이 고르게 둬요.', watch: '아직 건이 적어 지켜보는 중이에요.' }
</script>

<template>
  <div class="vals" :class="{ compact }">
    <!-- θ -->
    <section>
      <div class="vh"><span>입도 θ</span><b>{{ pct(b.theta) }}</b><em v-if="b.theta_start" class="start">시작값</em></div>
      <p class="ex">θ보다 드문 길은 지도에서 빼고 봐요.</p>
      <svg v-if="fit && !compact" class="chart" :viewBox="`0 0 ${CW} ${CH}`" role="img" aria-label="θ별 재생 적합도">
        <line class="grid" :x1="PL" :x2="CW - PR" :y1="fit.y1" :y2="fit.y1" />
        <line class="grid" :x1="PL" :x2="CW - PR" :y1="fit.ylo" :y2="fit.ylo" />
        <text class="ax" :x="PL - 6" :y="fit.y1 + 4" text-anchor="end">100%</text>
        <text class="ax" :x="PL - 6" :y="fit.ylo + 4" text-anchor="end">{{ pct(fit.lo) }}</text>
        <path class="ln" :d="fit.line" />
        <g v-for="p in fit.pts" :key="p.theta">
          <title>θ {{ pct(p.theta) }} · 재생 적합도 {{ (p.fitness * 100).toFixed(1) }}%</title>
          <circle v-if="p.chosen" class="ring" :cx="p.x" :cy="p.y" r="8" />
          <circle class="dot" :class="{ on: p.chosen }" :cx="p.x" :cy="p.y" r="4" />
          <circle class="hit" :cx="p.x" :cy="p.y" r="12" />
          <text class="ax" :class="{ on: p.chosen }" :x="p.x" :y="CH - 12" text-anchor="middle">{{ pct(p.theta) }}</text>
        </g>
        <text v-if="chosen" class="tag" :x="Math.min(chosen.x, CW - PR - 30)" :y="chosen.y - 13" text-anchor="middle">{{ b.theta_start ? '시작값' : '고른 값' }} {{ (chosen.fitness * 100).toFixed(1) }}%</text>
      </svg>
      <p class="ev">
        <template v-if="b.theta_start">떼어 둔 최근 건이 {{ b.held || 0 }}건뿐이라 아직 잴 수 없어 시작값을 써요.</template>
        <template v-else>떼어 둔 최근 건 {{ b.held }}건 · 이동 {{ b.held_transitions }}개로 쟀어요. 적합도가 크게 꺾이기 직전 값이에요.</template>
      </p>
      <p class="ev">요약 보기 θ <b>{{ pct(b.summary_theta) }}</b> — 일이 12개 이하로 남는 가장 작은 값</p>
    </section>

    <!-- 반감기 -->
    <section>
      <div class="vh"><span>반감기</span><b>{{ b.half_life }}일</b><em v-if="b.half_life_start" class="start">시작값</em></div>
      <p class="ex">이만큼 지난 기록은 무게가 반으로 줄어요.</p>
      <div v-if="hl.length && !compact" class="bars">
        <div v-for="x in hl" :key="x.halfLife" class="bar" :class="{ on: x.chosen }" :title="`${x.halfLife}일 · 로그 우도 ${x.ll.toFixed(1)}`">
          <span class="bl">{{ x.halfLife }}일</span>
          <span class="bt"><i :style="{ width: `${x.w}%` }" /></span>
          <span class="bv">{{ x.ll.toFixed(1) }}</span>
        </div>
      </div>
      <p class="ev">
        <template v-if="b.half_life_start">최근 4주 이동이 적어 아직 잴 수 없어 시작값을 써요.</template>
        <template v-else-if="!hl.length">지난 시점의 지도라 그때 정한 값으로 셌어요.</template>
        <template v-else-if="tested">최근 4주 이동 {{ tested }}개를 가장 잘 맞힌 값이에요(로그 우도가 클수록 잘 맞힘).</template>
        <template v-else>최근 4주 이동을 가장 잘 맞힌 값이에요(로그 우도가 클수록 잘 맞힘).</template>
      </p>
    </section>

    <!-- 띠 -->
    <section>
      <div class="vh"><span>띠</span><span class="band" :class="b.band">{{ BAND[b.band] || b.bandName }}</span></div>
      <p class="ex">{{ bandText[b.band] }}</p>
      <div class="acc">
        <div class="ar"><span class="al">1위 맞히기</span><span class="at"><i :style="{ width: `${(b.a1 || 0) * 100}%` }" /><u title="기준 50%" /></span><b>{{ pct(b.a1) }}</b></div>
        <div class="ar"><span class="al">3위 맞히기</span><span class="at"><i class="soft" :style="{ width: `${(b.a3 || 0) * 100}%` }" /></span><b>{{ pct(b.a3) }}</b></div>
      </div>
      <p class="ev">떼어 둔 최근 건에서 다음 일을 1위로 맞힌 비율이 기준(50%) 이상이면 굳은 길이에요.<template v-if="b.band === 'watch'"> 떼어 둔 건이 5건이 안 되면 지켜봐요.</template></p>
    </section>
  </div>
</template>

<style scoped>
.vals { display: flex; flex-direction: column; gap: 18px; }
.vals.compact { gap: 10px; }
section { display: flex; flex-direction: column; gap: 5px; }
.vh { display: flex; align-items: baseline; gap: 8px; font-size: 13.5px; color: var(--text-secondary); }
.vh b { font-size: 20px; color: var(--text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.start { font-style: normal; font-size: 11.5px; padding: 1px 8px; border-radius: 8px; background: var(--chip-bg); color: var(--text-secondary); align-self: center; }
.ex { margin: 0; font-size: 13.5px; color: var(--text-primary); }
.ev { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--text-secondary); }
.ev b { color: var(--text-primary); font-weight: 600; }
.chart { width: 100%; max-width: 340px; height: auto; margin: 4px 0 2px; overflow: visible; }
.grid { stroke: var(--hairline); stroke-width: 1; }
.ax { fill: var(--text-tertiary); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.ax.on { fill: var(--text-primary); font-weight: 600; }
.ln { fill: none; stroke: var(--text-secondary); stroke-width: 2; stroke-linejoin: round; }
.dot { fill: var(--regular-solid-bg); stroke: var(--text-secondary); stroke-width: 2; }
.dot.on { fill: var(--color-success); stroke: var(--color-success); }
.ring { fill: none; stroke: var(--color-success); stroke-width: 1.5; opacity: .5; }
.hit { fill: transparent; }
.tag { fill: var(--text-primary); font-size: 11px; font-weight: 600; }
.bars { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 2px; }
.bar { display: grid; grid-template-columns: 44px 1fr 52px; gap: 8px; align-items: center; font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.bt { height: 8px; border-radius: 4px; background: var(--field-bg); overflow: hidden; }
.bt i { display: block; height: 100%; border-radius: 4px; background: var(--text-tertiary); }
.bar.on { color: var(--text-primary); font-weight: 600; }
.bar.on .bt i { background: var(--color-success); }
.bv { text-align: right; }
.band { font-size: 12.5px; font-weight: 600; padding: 2px 10px; border-radius: 9999px; background: var(--chip-bg); color: var(--text-secondary); }
.band.paved { background: color-mix(in srgb, var(--color-success) 22%, transparent); color: var(--color-success); }
.band.open { background: color-mix(in srgb, var(--color-info) 22%, transparent); color: var(--color-info); }
.acc { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 2px; }
.ar { display: grid; grid-template-columns: 70px 1fr 40px; gap: 8px; align-items: center; font-size: 12.5px; color: var(--text-secondary); }
.ar b { text-align: right; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.at { position: relative; height: 10px; border-radius: 5px; background: var(--field-bg); }
.at i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; background: var(--text-secondary); }
.at i.soft { background: var(--text-tertiary); }
.at u { position: absolute; left: 50%; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; background: var(--text-primary); border-radius: 1px; }
</style>
