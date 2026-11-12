<script setup>
// 관계 하나: 건수, 확률과 95% 구간, 평균 대기, 처음 · 마지막으로 본 날, 출처별, 은퇴 후보의 근거.
// 아래 actions 자리에 고정 · 은퇴 단추가 들어간다.
import { computed } from 'vue'
import { pct, dateKo, waitText, SOURCE_KO, END } from './fmt.js'

const props = defineProps({ edge: { type: Object, required: true } })
const e = computed(() => props.edge)
const sources = computed(() => Object.entries(e.value.by_source || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]))
const srcTotal = computed(() => sources.value.reduce((s, [, n]) => s + n, 0) || 1)
const gap = computed(() => Math.round(e.value.gap_days || 0))
const expected = computed(() => { const x = e.value.expected || 0; return x >= 10 ? Math.round(x) : +x.toFixed(1) })
</script>

<template>
  <div class="ep">
    <p v-if="e.stale && e.status !== 'retired'" class="warn">
      <b>은퇴 후보</b> 예전 빈도로는 최근 {{ gap }}일 동안 {{ expected }}건쯤 나왔어야 하는데 0건이에요.
    </p>
    <p v-if="e.status === 'retired'" class="note">은퇴한 길이에요. 지도에는 회색 점선으로 남아요.</p>
    <p v-if="e.cond" class="note">조건 · {{ e.cond }}</p>

    <dl class="kv">
      <dt>건수</dt><dd><b>{{ e.n }}번</b></dd>
      <dt>{{ e.to === END ? '여기서 끝날 확률' : '다음 일로 갈 확률' }}</dt>
      <dd><b>{{ pct(e.p) }}</b> <small>95% 구간 {{ pct(e.ci_low) }}–{{ pct(e.ci_high) }}</small></dd>
      <dt>최근 기준</dt><dd>{{ pct(e.share) }} <small>오래된 기록일수록 가볍게 셌을 때</small></dd>
      <template v-if="e.to !== END"><dt>평균 대기</dt><dd>{{ waitText(e.wait_h) }}</dd></template>
      <dt>처음 본 날</dt><dd>{{ dateKo(e.first_seen) }}</dd>
      <dt>마지막으로 본 날</dt><dd>{{ dateKo(e.last_seen) }}</dd>
    </dl>
    <p v-if="e.thin" class="hint">관찰 적음 — 구간 폭이 30%p 를 넘어 확률이 아직 흔들릴 수 있어요.</p>
    <p v-if="(e.people ?? 2) <= 1" class="hint">한 사람 기준 — 한 사람의 기록에서만 보인 길이에요.</p>

    <template v-if="sources.length">
      <h4>출처별</h4>
      <div class="src">
        <div v-for="[k, n] in sources" :key="k" class="sr">
          <span>{{ SOURCE_KO[k] || k }}</span>
          <span class="st"><i :style="{ width: `${(n / srcTotal) * 100}%` }" /></span>
          <b>{{ n }}</b>
        </div>
      </div>
    </template>

    <div class="actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.ep { display: flex; flex-direction: column; gap: 10px; }
.warn { margin: 0; padding: 10px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.5; background: color-mix(in srgb, #F0883E 16%, transparent); }
.warn b { color: #F0883E; margin-right: 6px; }
.note { margin: 0; padding: 8px 12px; border-radius: 12px; font-size: 13px; background: var(--field-bg); color: var(--text-secondary); }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 7px 14px; margin: 0; font-size: 13.5px; align-items: baseline; }
.kv dt { color: var(--text-secondary); white-space: nowrap; }
.kv dd { margin: 0; font-variant-numeric: tabular-nums; }
.kv dd b { font-size: 17px; font-weight: 600; }
.kv small { font-size: 12px; color: var(--text-tertiary); }
.hint { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
h4 { margin: 6px 0 0; font-size: 12.5px; font-weight: 500; color: var(--text-tertiary); }
.src { display: flex; flex-direction: column; gap: 5px; }
.sr { display: grid; grid-template-columns: 44px 1fr 36px; gap: 8px; align-items: center; font-size: 13px; }
.sr b { text-align: right; font-weight: 500; font-variant-numeric: tabular-nums; }
.st { height: 8px; border-radius: 4px; background: var(--field-bg); overflow: hidden; }
.st i { display: block; height: 100%; background: var(--text-secondary); border-radius: 4px; }
.actions:empty { display: none; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
</style>
