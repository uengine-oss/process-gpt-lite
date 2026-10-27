<script setup>
// 가치 흐름 지도(VSM): 단계를 흐름 순서대로(동시에 하는 단계는 위아래로), 상자마다 담당·작업 시간·첫 통과율,
// 상자 앞 삼각형은 그 단계 앞에서 기다린 시간. 아래 사다리는 주 경로의 대기(위)와 작업(아래), 끝에 합계와 흐름 효율.
import { computed } from 'vue'
import { dur, pct } from './fmt.js'
const props = defineProps({ vsm: Object, path: { type: Array, default: () => [] } })
const cols = computed(() => {
  const by = new Map()
  for (const s of props.vsm?.steps || []) (by.get(s.rank) || by.set(s.rank, []).get(s.rank)).push(s)
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, xs]) => xs)
})
const ladder = computed(() => {
  const steps = (props.vsm?.steps || []).filter((s) => props.path.includes(s.id))
  const tot = steps.reduce((a, s) => a + (s.wait || 0) + (s.work || 0), 0) || 1
  return { steps: steps.map((s) => ({ ...s, ww: Math.max(3, ((s.wait || 0) / tot) * 100), wk: Math.max(3, ((s.work || 0) / tot) * 100) })), wait: steps.reduce((a, s) => a + (s.wait || 0), 0), work: steps.reduce((a, s) => a + (s.work || 0), 0) }
})
const who = (s) => (s.people?.length ? s.people.map((p) => p.name).join(', ') : s.role)
</script>

<template>
  <div class="vsm">
    <div class="flow">
      <template v-for="(col, ci) in cols" :key="ci">
        <div class="col">
          <div v-for="s in col" :key="s.id" class="cell" :class="{ onpath: path.includes(s.id) }">
            <div class="tri" :class="{ big: (s.wait || 0) > 6 * 3600 }" :title="`${s.name} 앞에서 기다린 시간(평균)`">
              <svg width="26" height="22" viewBox="0 0 26 22"><path d="M13 2 24 20H2z" /></svg>
              <span>{{ dur(s.wait) }}</span>
            </div>
            <div class="box" :class="s.kind">
              <b>{{ s.name }}</b>
              <small class="who"><i :class="s.kind">{{ s.kind === 'agent' ? '에이전트' : '사람' }}</i>{{ who(s) }}</small>
              <div class="kv"><span>작업</span><b>{{ dur(s.work) }}</b></div>
              <div class="kv"><span>단계 시간</span><b>{{ dur(s.lead) }}</b></div>
              <div class="kv"><span>첫 통과율</span><b :class="{ warn: (s.fpy ?? 1) < 0.9 }">{{ s.fpy != null ? pct(s.fpy) : '–' }}</b></div>
              <div v-if="s.probability != null && s.probability < 0.995" class="kv"><span>거치는 비율</span><b>{{ pct(s.probability) }}</b></div>
            </div>
          </div>
        </div>
        <span v-if="ci < cols.length - 1" class="arrow">→</span>
      </template>
    </div>

    <div class="ladder">
      <div class="lrow">
        <div class="lsteps" :style="{ gridTemplateColumns: `repeat(${ladder.steps.length}, minmax(0, 1fr))` }">
          <div v-for="s in ladder.steps" :key="s.id" class="lstep">
            <div class="up"><span>{{ dur(s.wait) }}</span></div>
            <div class="dn"><span>{{ dur(s.work) }}</span></div>
            <small class="ln">{{ s.name }}</small>
          </div>
        </div>
        <div class="sum">
          <div><span>대기 합</span><b>{{ dur(ladder.wait) }}</b></div>
          <div><span>작업 합</span><b>{{ dur(ladder.work) }}</b></div>
        </div>
      </div>
      <p class="lcap">주 경로(크리티컬 패스) 단계의 평균 — 단계마다 왼쪽 위는 기다린 시간, 오른쪽 아래는 실제로 일한 시간(길이는 같게 그림)</p>
    </div>

    <div class="tot glass">
      <div><span>건당 리드타임(평균)</span><b>{{ dur(vsm.leadMean) }}</b><small>중앙값 {{ dur(vsm.leadMedian) }} · p80 {{ dur(vsm.leadP80) }}</small></div>
      <div><span>건당 작업 합(평균)</span><b>{{ dur(vsm.workMean) }}</b><small>사람 판단 + 에이전트 수행, 재작업 제외</small></div>
      <div class="fe"><span>흐름 효율</span><b>{{ pct(vsm.flowEfficiency, 1) }}</b><small>작업 합 ÷ 리드타임 · {{ vsm.instances }}건</small></div>
      <div><span>전 단계 첫 통과율 곱</span><b>{{ pct(vsm.rolledYield) }}</b><small>한 번에 끝까지 간 비율의 추정</small></div>
    </div>
  </div>
</template>

<style scoped>
.flow { display: flex; align-items: center; gap: 6px; overflow-x: auto; padding: 4px 2px 10px; }
.col { display: flex; flex-direction: column; gap: 10px; }
.arrow { color: var(--text-tertiary); font-size: 20px; }
.cell { display: flex; align-items: center; gap: 6px; }
.tri { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 50px; font-size: 11.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.tri svg path { fill: color-mix(in srgb, #B08900 30%, transparent); stroke: #B08900; stroke-width: 1.5; }
.tri.big svg path { fill: color-mix(in srgb, #e0613f 45%, transparent); stroke: #e0613f; }
.tri.big span { color: #e0613f; font-weight: 600; }
.box { width: 128px; border-radius: 14px; padding: 10px 12px; background: var(--regular-solid-bg); border: 1px solid var(--hairline); display: flex; flex-direction: column; gap: 4px; }
.onpath .box { border-color: #e0613f; box-shadow: 0 0 0 1px #e0613f inset; }
.box b { font-size: 13.5px; }
.who { font-size: 11.5px; color: var(--text-secondary); display: flex; gap: 5px; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.who i { flex: none; font-style: normal; font-size: 10.5px; padding: 0 5px; border-radius: 6px; background: var(--chip-bg); }
.who i.agent { background: rgba(161 208 255 / .25); color: var(--color-info); }
.kv { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--text-secondary); }
.kv b { font-size: 12.5px; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.kv b.warn { color: #e0613f; }
.ladder { margin-top: 14px; }
.lrow { display: flex; gap: 12px; align-items: stretch; }
.lsteps { flex: 1; display: grid; }
.lstep { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 26px 26px auto; min-width: 0; }
.ln { grid-column: 1 / 3; font-size: 11px; color: var(--text-tertiary); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.up, .dn { display: flex; min-width: 0; font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.up { grid-row: 1; grid-column: 1; align-items: flex-start; border-top: 3px solid #B08900; padding-top: 4px; justify-content: center; }
.dn { grid-row: 2; grid-column: 2; align-items: flex-end; border-bottom: 3px solid #C2410C; padding-bottom: 4px; justify-content: center; }
.up span, .dn span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 2px; }
.sum { width: 120px; display: flex; flex-direction: column; justify-content: space-between; font-size: 12px; color: var(--text-secondary); }
.sum div { display: flex; justify-content: space-between; }
.sum b { color: var(--text-primary); }
.lcap { margin: 6px 0 0; font-size: 12px; color: var(--text-tertiary); }
.tot { margin-top: 14px; border-radius: 18px; padding: 14px 18px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.tot div { display: flex; flex-direction: column; gap: 2px; }
.tot span { font-size: 12.5px; color: var(--text-secondary); }
.tot b { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tot small { font-size: 11.5px; color: var(--text-tertiary); }
.tot .fe b { color: #e0613f; }
@media (max-width: 760px) { .tot { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
