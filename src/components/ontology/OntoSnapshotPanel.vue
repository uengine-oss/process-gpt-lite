<script setup>
// 스냅샷 보기(spec pgpt-pro_process-ontology): pick where a case would start and, with the map's point in time, see the
// snapshot the engine would run — the same definition a real case gets (reused by its key), lanes per role.
import { ref, watch } from 'vue'
import BpmnView from '../BpmnView.vue'
import { api } from '../../api.js'
import { dateKo } from './fmt.js'

const props = defineProps({ bundle: { type: Object, required: true }, at: { type: String, default: '' } })
const entry = ref(props.bundle.entries?.[0] || props.bundle.tasks?.[0] || '')
const snap = ref(null)
const busy = ref(false)
const err = ref('')

async function load() {
  if (!entry.value) return
  busy.value = true
  err.value = ''
  try {
    const qs = new URLSearchParams({ bundle: props.bundle.key, entry: entry.value })
    if (props.at) qs.set('at', `${props.at}T12:00:00Z`)
    snap.value = await api(`/ontology/snapshot?${qs}`)
  } catch (e) { err.value = e.message; snap.value = null } finally { busy.value = false }
}
watch(() => [props.bundle.key, props.at, entry.value], load, { immediate: true })
</script>

<template>
  <div class="snap">
    <label class="row">
      <span>시작 일</span>
      <select v-model="entry">
        <option v-for="t in bundle.tasks" :key="t" :value="t">{{ t }}</option>
      </select>
    </label>
    <p class="meta">
      {{ at ? `${dateKo(`${at}T12:00:00`)} 기준` : '지금 기준' }}<template v-if="snap"> · θ {{ snap.theta }} · 일 {{ snap.nodes.length }}개{{ snap.reused ? ' · 같은 스냅샷 다시 씀' : '' }}</template>
    </p>
    <p v-if="err" class="err">{{ err }}</p>
    <p v-else-if="busy && !snap" class="loading pulse">스냅샷 뽑는 중…</p>
    <template v-if="snap">
      <div v-if="snap.skipped?.length" class="skipped">
        <span class="k">건너뜀</span>
        <span v-for="t in snap.skipped" :key="t" class="chip off">{{ t }}</span>
      </div>
      <BpmnView :key="snap.procDefId" :def-id="snap.procDefId" :height="300" />
      <p class="hint">요청 접수 → {{ snap.nodes.join(' → ') }}</p>
    </template>
  </div>
</template>

<style scoped>
.snap { display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.row span { color: var(--text-secondary); min-width: 52px; }
.row select { flex: 1; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--hairline); background: var(--field-bg); color: var(--text-primary); font: inherit; }
.meta { margin: 0; font-size: 12.5px; color: var(--text-secondary); }
.skipped { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.skipped .k { font-size: 12px; color: var(--text-secondary); }
.chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--hairline); }
.chip.off { text-decoration: line-through; opacity: .6; }
.hint { margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.err { color: var(--color-danger, #d1242f); font-size: 13px; margin: 0; }
.loading { font-size: 13px; color: var(--text-secondary); margin: 0; }
</style>
