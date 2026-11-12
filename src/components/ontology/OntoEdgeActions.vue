<script setup>
// 관계 하나의 은퇴 · 되살림(관리자). 지도 화면의 관계 패널과 검토 패널이 같이 쓴다.
// props.edge: {from, to, status, stale} · emits changed({from, to, status, validFrom})
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'
import OntoWhenReason from './OntoWhenReason.vue'
import { validFromOf, dayKo } from './ontoText.js'

const props = defineProps({ edge: { type: Object, required: true }, admin: Boolean, compact: Boolean })
const emit = defineEmits(['changed'])
const open = ref(false)
const reason = ref('')
const date = ref('')
const busy = ref(false)
const err = ref('')
const done = ref(null)
const retired = computed(() => props.edge.status === 'retired')
const isEnd = computed(() => props.edge.to === '__end__')
watch(() => `${props.edge.from}>${props.edge.to}:${props.edge.status}`, () => { open.value = false; err.value = ''; done.value = null; reason.value = ''; date.value = '' })

async function apply() {
  busy.value = true; err.value = ''
  const status = retired.value ? 'active' : 'retired'
  const validFrom = validFromOf(date.value)
  try {
    const r = await api('/ontology/edges', { method: 'POST', body: { from: props.edge.from, to: props.edge.to, status, ...(validFrom ? { validFrom } : {}), reason: reason.value.trim() } })
    done.value = { status, later: !!validFrom, date: date.value }
    open.value = false
    emit('changed', r)
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div v-if="!isEnd" class="ea" :class="{ compact }" data-testid="onto-edge-actions">
    <p v-if="done" class="ok" data-testid="onto-edge-done">
      {{ done.status === 'retired' ? '은퇴시켰어요' : '되살렸어요' }}<template v-if="done.later"> · {{ dayKo(done.date) }}부터</template>
    </p>
    <template v-else-if="admin">
      <div v-if="!open" class="row">
        <button class="act press" :class="retired ? 'revive' : 'retire'" :data-testid="retired ? 'onto-edge-revive' : 'onto-edge-retire'" @click="open = true">
          {{ retired ? '되살리기' : '은퇴시키기' }}
        </button>
        <small v-if="!compact" class="why">{{ retired ? '다시 지도와 실행에 넣어요.' : edge.stale ? '요즘 안 쓰이는 길이에요. 은퇴하면 스냅샷에서 빠져요.' : '은퇴하면 다음 스냅샷부터 이 길로 가지 않아요.' }}</small>
      </div>
      <div v-else class="form">
        <OntoWhenReason v-model:reason="reason" v-model:date="date" :placeholder="retired ? '되살리는 이유(선택)' : '은퇴시키는 이유(선택)'" />
        <div class="btns">
          <button class="ghost press" :disabled="busy" @click="open = false">취소</button>
          <button class="go press" :class="retired ? 'revive' : 'retire'" :disabled="busy" data-testid="onto-edge-apply" @click="apply">{{ busy ? '적용하는 중…' : retired ? '되살리기' : '은퇴시키기' }}</button>
        </div>
      </div>
    </template>
    <small v-else class="why">은퇴 · 되살림은 관리자가 해요.</small>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.ea { word-break: keep-all; overflow-wrap: anywhere; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.act { height: 32px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; font-weight: 500; background: var(--field-bg); flex: none; }
.act.retire { color: #ffb36b; } .act.revive { color: var(--color-success); }
:root[data-theme="light"] .act.retire { color: #b35c00; }
.why { font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; min-width: 0; }
.form { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 14px; background: var(--cell-bg); }
.btns { display: flex; justify-content: flex-end; gap: 6px; }
.ghost { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.go.retire { background: #c2570c; color: #fff; }
.go:disabled, .ghost:disabled { opacity: .5; }
.ok { margin: 0; font-size: 13.5px; color: var(--color-success); }
.err { font-size: 12.5px; color: var(--color-error); }
.compact .form { padding: 8px; }
</style>
