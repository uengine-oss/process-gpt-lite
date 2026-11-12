<script setup>
// 일 하나: 이름 · 다른 이름 · 역할 · 건수 · 시작 비율 · 끝 비율, 앞뒤 일. 아래 actions 자리에 고정 · 은퇴 단추가 들어간다.
import { computed } from 'vue'
import { pct, dateKo, SOURCE_KO, taskName } from './fmt.js'

const props = defineProps({ task: { type: Object, required: true }, edges: { type: Array, default: () => [] } })
const emit = defineEmits(['edge'])
const t = computed(() => props.task)
const next = computed(() => props.edges.filter((e) => e.from === t.value.key).sort((a, b) => b.p - a.p))
const prev = computed(() => props.edges.filter((e) => e.to === t.value.key).sort((a, b) => b.n - a.n))
const sources = computed(() => Object.entries(t.value.sources || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]))
</script>

<template>
  <div class="tp">
    <p v-if="t.candidate" class="note">아직 후보인 일이에요. 이름을 확정하거나 다른 일과 합칠 수 있어요.</p>
    <div v-if="t.aliases?.length" class="al">
      <span class="k">다른 이름</span>
      <span v-for="a in t.aliases" :key="a" class="chip">{{ a }}</span>
    </div>
    <dl class="kv">
      <dt>역할</dt><dd>{{ t.role || '–' }}</dd>
      <dt>건수</dt><dd><b>{{ t.n_cases }}건</b> <small>거친 횟수 {{ t.n }}번</small></dd>
      <dt>시작 비율</dt><dd>{{ pct(t.entry_share) }} <small>회사 전체 건 중 이 일로 시작한 건</small></dd>
      <dt>끝 비율</dt><dd>{{ pct(t.exit_share) }} <small>이 일에서 끝난 건</small></dd>
      <dt>본 기간</dt><dd>{{ dateKo(t.first_seen) }} ~ {{ dateKo(t.last_seen) }}</dd>
      <template v-if="sources.length"><dt>출처</dt><dd><template v-for="([k, n], i) in sources" :key="k"><i v-if="i" class="dot"> · </i><span>{{ SOURCE_KO[k] || k }}</span> {{ n }}</template></dd></template>
    </dl>
    <template v-if="next.length">
      <h4>다음 일</h4>
      <button v-for="e in next" :key="`n-${e.to}`" class="row press" @click="emit('edge', e)">
        <span>{{ taskName(e.to) }}</span><b>{{ pct(e.p) }}</b>
      </button>
    </template>
    <template v-if="prev.length">
      <h4>앞 일</h4>
      <button v-for="e in prev" :key="`p-${e.from}`" class="row press" @click="emit('edge', e)">
        <span>{{ taskName(e.from) }}</span><small>{{ e.n }}번</small>
      </button>
    </template>
    <div class="actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.tp { display: flex; flex-direction: column; gap: 10px; }
.note { margin: 0; padding: 8px 12px; border-radius: 12px; font-size: 13px; background: var(--field-bg); color: var(--text-secondary); }
.al { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.al .k { font-size: 12.5px; color: var(--text-secondary); margin-right: 2px; }
.chip { font-size: 12.5px; padding: 2px 9px; border-radius: 9999px; background: var(--chip-bg); }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 7px 14px; margin: 0; font-size: 13.5px; align-items: baseline; }
.kv dt { color: var(--text-secondary); white-space: nowrap; }
.kv dd { margin: 0; font-variant-numeric: tabular-nums; }
.kv dd b { font-size: 17px; font-weight: 600; }
.kv small { font-size: 12px; color: var(--text-tertiary); }
.dot { font-style: normal; color: var(--text-tertiary); }
h4 { margin: 6px 0 -4px; font-size: 12.5px; font-weight: 500; color: var(--text-tertiary); }
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 10px; border-radius: 10px; background: var(--field-bg); font-size: 13.5px; text-align: left; }
.row b { font-weight: 600; font-variant-numeric: tabular-nums; }
.row small { color: var(--text-secondary); }
.actions:empty { display: none; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
</style>
