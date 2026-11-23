<script setup>
// 역할마다 맡을 사람(server lib/ontology/bindings.js): 이 건의 흐름에서 사람이 하는 단계가 있는 역할마다 누가 맡는지와 어디서 왔는지(설정의 팀 · 역할
// 담당자 · 시작한 사람 · 이 건에서 바꿈 · 여러 명 · 없음) — 잘못 맡겨진 사람을 시작할 때 잡으려고.
//   시작 전(caseId 없음 — 묻는 카드): proc · entry 로 서버에 물어 보이고, 바꾼 것은 picks 로 올린다(진행할 때 함께 보냄). 여러 명 · 없음인 역할은
//     골라야 진행할 수 있다(ready).
//   진행 중인 건(caseId — 시작했어요 카드 · 건 보기): 「바꾸기」가 그 역할의 끝나지 않은 단계만 그 사람에게 보낸다. 회사 설정은 그대로다.
// 고를 사람: 이 회사 사람(GET /ontology/people — 팀원 먼저). 에이전트가 하는 단계는 「업무 에이전트」로만 보인다.
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'
import { EUL } from './ontoText.js'

const props = defineProps({
  bindings: { type: Array, default: null }, caseId: { type: String, default: '' }, proc: { type: String, default: '' }, entry: { type: String, default: '' },
  only: { type: String, default: '' }, editable: { type: Boolean, default: true }, compact: Boolean,
})
const emit = defineEmits(['picks', 'ready', 'changed'])
const list = ref(props.bindings ? [...props.bindings] : null)
const err = ref('')
const busy = ref('')
const note = ref('')
const people = ref(null)
const open = ref('') // the role whose picker is open
const picks = ref({}) // role → userId (before the start)

async function fetchStart() {
  if (props.bindings || props.caseId || !props.proc || !props.entry) return
  try { list.value = (await api(`/ontology/start-bindings?proc=${encodeURIComponent(props.proc)}&entry=${encodeURIComponent(props.entry)}`)).bindings } catch (e) { err.value = e.message }
}
watch(() => [props.proc, props.entry], () => { picks.value = {}; fetchStart() }, { immediate: true })
watch(() => props.bindings, (b) => { if (b) list.value = [...b] })
async function loadPeople() { if (!people.value) people.value = await api('/ontology/people').catch(() => []) }

const rows = computed(() => (list.value || []).filter((b) => !props.only || b.role === props.only).map((b) => {
  const pick = picks.value[b.role]
  const p = pick ? (people.value || []).find((x) => x.id === pick) : null
  return { ...b, ...(p ? { userId: p.id, name: p.name, from: 'picked', fromKo: '이 건에서 바꿈', unbound: false } : {}) }
}).sort((a, b) => (a.from === 'agent') - (b.from === 'agent'))) // people first, the agent's steps last
const missing = computed(() => rows.value.filter((b) => b.unbound))
watch(missing, (m) => emit('ready', !m.length), { immediate: true })
const choicesOf = (b) => {
  const all = people.value || []
  // several people hold it: they come first
  const ids = new Set((b.candidates || []).map((x) => x.id))
  return [...all.filter((x) => ids.has(x.id)), ...all.filter((x) => !ids.has(x.id))]
}
async function toggle(b) { if (open.value === b.role) { open.value = ''; return } await loadPeople(); open.value = b.role }
watch(missing, async (m) => { if (m.length && props.editable) await loadPeople() }, { immediate: true })

async function choose(b, userId) {
  if (!userId) return
  err.value = ''; note.value = ''
  if (!props.caseId) {
    picks.value = { ...picks.value, [b.role]: userId }
    emit('picks', Object.entries(picks.value).map(([role, id]) => ({ role, userId: id })))
    open.value = ''
    return
  }
  busy.value = b.role
  try {
    const r = await api(`/ontology/cases/${encodeURIComponent(props.caseId)}/bindings`, { method: 'PUT', body: { role: b.role, userId } })
    list.value = r.bindings
    note.value = `${r.reassigned ? `끝나지 않은 단계 ${r.reassigned}개를 넘겼어요. ` : ''}회사 설정은 그대로예요.`
    open.value = ''
    emit('changed', r.bindings)
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const label = (b) => (b.from === 'agent' ? '에이전트가 해요' : b.unbound ? (b.from === 'several' ? '여러 명 · 정해야 해요' : '맡을 사람 없음') : b.name || '이름 없음')
</script>

<template>
  <div v-if="rows.length" class="ob" :class="{ compact }" data-testid="onto-bindings" :data-ready="missing.length ? '0' : '1'">
    <small v-if="!only" class="cap">맡는 사람</small>
    <div v-for="b in rows" :key="b.role" class="row" data-testid="onto-binding" :data-role="b.role" :data-from="b.from" :data-user="b.userId || ''">
      <span class="role">{{ b.role }}</span>
      <span class="who" :class="{ need: b.unbound, agent: b.from === 'agent' }">{{ label(b) }}</span>
      <small v-if="b.fromKo && b.from !== 'agent' && !b.unbound" class="from">{{ b.fromKo }}</small>
      <button v-if="editable && b.from !== 'agent'" class="lk press" :disabled="!!busy" data-testid="onto-binding-change" @click="toggle(b)">{{ busy === b.role ? '…' : b.unbound ? '고르기' : '바꾸기' }}</button>
      <select v-if="open === b.role || (editable && b.unbound && people)" class="pick" :value="''" data-testid="onto-binding-pick" :aria-label="`${b.role}${EUL(b.role)} 맡을 사람`" @change="choose(b, $event.target.value)">
        <option value="">{{ b.unbound ? '누가 맡을까요?' : '다른 사람 고르기' }}</option>
        <option v-for="p in choicesOf(b)" :key="p.id" :value="p.id" :disabled="p.id === b.userId">{{ p.name }}{{ p.team ? '' : ' (팀원 아님)' }}</option>
      </select>
    </div>
    <small v-if="missing.length && !caseId" class="hint" data-testid="onto-bindings-missing">「{{ missing.map((b) => b.role).join('」 · 「') }}」{{ EUL(missing.at(-1).role) }} 맡을 사람을 골라야 시작할 수 있어요.</small>
    <small v-else-if="missing.length" class="hint" data-testid="onto-bindings-missing">「{{ missing.map((b) => b.role).join('」 · 「') }}」의 첫 단계는 맡을 사람을 고를 때까지 기다려요.</small>
    <small v-if="note" class="ok" data-testid="onto-bindings-note">{{ note }}</small>
    <small v-else-if="Object.keys(picks).length" class="ok">이 건에만 적용해요 — 회사 설정은 그대로예요.</small>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.ob { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 14px; background: var(--cell-bg); min-width: 0; }
.cap { font-size: 11.5px; color: var(--text-tertiary); letter-spacing: .02em; }
.row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; font-size: 13.5px; line-height: 1.45; min-width: 0; }
.role { color: var(--text-secondary); }
.role::after { content: '→'; margin-left: 8px; color: var(--text-tertiary); }
.who { font-weight: 600; }
.who.agent { font-weight: 500; color: var(--text-secondary); }
.who.need { color: var(--color-attention, #e0613f); }
.from { font-size: 11.5px; color: var(--text-tertiary); }
.lk { font-size: 12.5px; color: var(--color-info); }
.lk:disabled { opacity: .5; }
.pick { flex-basis: 100%; height: 32px; padding: 0 8px; border-radius: 10px; border: 0; background: var(--field-bg); color: var(--text-primary); font-size: 13px; }
.hint { font-size: 12px; color: var(--color-attention, #e0613f); line-height: 1.45; }
.ok { font-size: 12px; color: var(--text-secondary); }
.err { font-size: 12px; color: var(--color-error); }
.compact .row { font-size: 13px; }
</style>
