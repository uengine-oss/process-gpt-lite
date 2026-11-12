<script setup>
// 검토할 것(학습 순환의 사람 몫): 은퇴 후보 · 고정을 건너뛴 건 · 굳어진 길 · 은퇴한 길, 그리고 최근 결정.
// 은퇴 · 되살림은 관리자만. emits changed(결정 뒤) · open-edge({from,to}) · open-task(key) — 지도 화면이 그쪽으로 옮겨 간다.
import { ref, computed, onMounted } from 'vue'
import { api } from '../../api.js'
import { pct, dateTimeKo } from './fmt.js'
import OntoEdgeActions from './OntoEdgeActions.vue'
import { KIND_KO, DECISION_KO } from './ontoText.js'

const props = defineProps({ admin: Boolean })
const emit = defineEmits(['changed', 'open-edge', 'open-task'])
const agenda = ref(null)
const decisions = ref([])
const err = ref('')
const loading = ref(true)
const items = computed(() => agenda.value?.items || [])
const counts = computed(() => items.value.reduce((m, x) => ({ ...m, [x.kind]: (m[x.kind] || 0) + 1 }), {}))

async function load() {
  err.value = ''
  try {
    const [a, d] = await Promise.all([api('/ontology/review'), api('/ontology/decisions').catch(() => [])])
    agenda.value = a; decisions.value = d || []
  } catch (e) { err.value = e.message } finally { loading.value = false }
}
onMounted(load)
async function changed(r) { emit('changed', r); await load() }
const keyOf = (x) => `${x.kind}:${x.from || ''}>${x.to || ''}:${x.task || ''}`
defineExpose({ reload: load })
</script>

<template>
  <section class="rv" data-testid="onto-review-panel">
    <header class="hd">
      <h3>검토할 것</h3>
      <small v-if="items.length" class="sum">
        <template v-if="counts.retire">은퇴 후보 {{ counts.retire }}</template>
        <template v-if="counts['pin-skipped']"> · 고정 건너뜀 {{ counts['pin-skipped'] }}</template>
        <template v-if="counts.firmed"> · 굳어짐 {{ counts.firmed }}</template>
        <template v-if="counts.retired"> · 은퇴함 {{ counts.retired }}</template>
      </small>
    </header>

    <p v-if="loading" class="muted pulse">불러오는 중…</p>
    <p v-else-if="err" class="err">{{ err }}</p>
    <p v-else-if="!items.length" class="muted">지금은 검토할 것이 없어요. 지도가 다시 셈해지면 여기에 모여요.</p>

    <ul v-else class="items">
      <li v-for="x in items" :key="keyOf(x)" class="it" :class="x.kind" data-testid="onto-review-item" :data-kind="x.kind">
        <div class="top">
          <span class="kind">{{ KIND_KO[x.kind] || x.kind }}</span>
          <button v-if="x.from" class="path press" :title="`${x.from} → ${x.to}`" @click="emit('open-edge', { from: x.from, to: x.to })">{{ x.from }} → {{ x.to }}</button>
          <button v-else-if="x.task" class="path press" @click="emit('open-task', x.task)">{{ x.task }}</button>
        </div>
        <p class="txt">{{ x.text }}</p>
        <div v-if="x.kind === 'firmed'" class="bar" :title="`${pct(x.was)} → ${pct(x.p)}`">
          <span class="was" :style="{ width: `${Math.round((x.was || 0) * 100)}%` }" /><span class="now" :style="{ width: `${Math.round((x.p || 0) * 100)}%` }" />
        </div>
        <small v-if="x.kind === 'retire' && x.n" class="meta">지금까지 {{ x.n }}번 · 다음으로 갈 확률 {{ pct(x.p) }}</small>
        <OntoEdgeActions v-if="x.kind === 'retire' || x.kind === 'retired'" :edge="{ from: x.from, to: x.to, status: x.kind === 'retired' ? 'retired' : 'active', stale: x.kind === 'retire' }" :admin="admin" compact @changed="changed" />
      </li>
    </ul>

    <div class="dec">
      <h4>최근 결정</h4>
      <p v-if="!decisions.length && !loading" class="muted">아직 결정이 없어요.</p>
      <ol v-else class="dl">
        <li v-for="d in decisions.slice(0, 12)" :key="d.id || d.created_at + d.subject" data-testid="onto-decision">
          <span class="dk" :class="(d.action_kind || '').split('.')[1]">{{ DECISION_KO[d.action_kind] || d.action_kind }}</span>
          <span class="ds">{{ String(d.subject || '').replace(/^[^:]+:\s*/, '') }}</span>
          <small class="dt">{{ dateTimeKo(d.created_at) }}<template v-if="d.facts?.reason"> · {{ d.facts.reason }}</template></small>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.rv { word-break: keep-all; overflow-wrap: anywhere; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.hd { display: flex; flex-direction: column; gap: 2px; }
h3 { margin: 0; font-size: 17px; font-weight: 600; }
h4 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.sum { font-size: 12.5px; color: var(--text-secondary); }
.muted { margin: 0; font-size: 13.5px; color: var(--text-secondary); line-height: 1.5; }
.err { margin: 0; font-size: 13.5px; color: var(--color-error); }
.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.it { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: 16px; background: var(--cell-bg); border-left: 3px solid var(--hairline); min-width: 0; }
.it.retire { border-left-color: #e8913a; }
.it.firmed { border-left-color: var(--color-success); } .it.retired { border-left-color: var(--text-tertiary); }
.top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kind { flex: none; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.retire .kind { background: rgba(232, 145, 58, .18); color: #ffb36b; }
.firmed .kind { background: color-mix(in srgb, var(--color-success) 18%, transparent); color: var(--color-success); }
.it[data-kind="pin-skipped"] { border-left-color: #d64545; }
.it[data-kind="pin-skipped"] .kind { background: rgba(214, 69, 69, .16); color: #ff8a8a; }
:root[data-theme="light"] .retire .kind { color: #b35c00; }
:root[data-theme="light"] .it[data-kind="pin-skipped"] .kind { color: #b42318; }
.path { min-width: 0; font-size: 13px; font-weight: 500; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: underline; text-decoration-color: var(--hairline); text-underline-offset: 3px; }
.txt { margin: 0; font-size: 13.5px; line-height: 1.5; word-break: keep-all; overflow-wrap: anywhere; }
.meta { font-size: 12px; color: var(--text-tertiary); }
.bar { position: relative; height: 6px; border-radius: 3px; background: var(--field-bg); overflow: hidden; }
.bar span { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; }
.bar .now { background: var(--color-success); opacity: .75; }
.bar .was { background: var(--text-secondary); z-index: 1; height: 2px; top: 2px; }
.dec { border-top: 1px solid var(--hairline); padding-top: 12px; }
.dl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dl li { display: grid; grid-template-columns: 58px 1fr; column-gap: 8px; row-gap: 1px; align-items: baseline; min-width: 0; }
.dk { justify-self: start; font-size: 11.5px; font-weight: 600; padding: 1px 7px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.dk.retire { color: #ffb36b; } .dk.revive { color: var(--color-success); } .dk.pin { color: var(--color-info); }
:root[data-theme="light"] .dk.retire { color: #b35c00; }
.ds { font-size: 13.5px; min-width: 0; overflow-wrap: anywhere; }
.dt { grid-column: 2; font-size: 12px; color: var(--text-tertiary); overflow-wrap: anywhere; }
</style>
