<script setup>
// 다른 일로 옮기기(누구나 — 건을 맡은 사람): 스냅샷 건은 지금 인스턴스를 닫고 그 일부터 새 스냅샷으로, 지도에서 바로 도는 건은 열린 단계를 닫고 같은
// 인스턴스에서 그 일부터 잇는다(server run.js moveCase · mapengine.js moveMap). 꼭 하는 단계를 지나치면 서버가 먼저 알리고({confirm, required}),
// 까닭을 적고 한 번 더 누르면 옮긴다(결정 기록에 남아요). 지도의 건 패널(OntoCasePanel)과 인스턴스 화면의 「이 건 다루기」(OntoCaseManage)가 같이 쓴다.
// caseData: GET /ontology/cases/:id · tasks: 옮길 수 있는 일(지도 화면이 넘기면 그걸, 없으면 지도에서 이 프로세스의 일을 읽는다) · emits moved(결과)
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'
import { RO, EUL } from './ontoText.js'

const props = defineProps({ caseData: { type: Object, required: true }, tasks: { type: Array, default: null } })
const emit = defineEmits(['moved'])
const c = computed(() => props.caseData)
const isMap = computed(() => c.value?.engine === 'map')
const history = computed(() => c.value?.history || [])
const moves = computed(() => history.value.filter((h) => h.state === 'moved' || h.state === 'rewound'))
const curInst = computed(() => (c.value?.instances || []).at(-1) || null)
const curTodos = computed(() => (c.value?.todos || []).filter((t) => t.proc_inst_id === curInst.value || !t.proc_inst_id))

const open = ref(false)
const moveTo = ref('')
const reason = ref('')
const busy = ref(false)
const moved = ref('')
const err = ref('')
const procTasks = ref(null)
const choices = computed(() => {
  const cur = moves.value.at(-1)?.task || c.value?.entry_task
  const list = props.tasks || procTasks.value || [...new Set([...(c.value?.entry_odds?.options || []).map((o) => o.task), ...history.value.map((h) => h.task), ...curTodos.value.map((t) => t.activity_name)])]
  return list.filter((k) => k && k !== cur && k !== '요청 접수')
})
async function toggle() {
  open.value = !open.value
  moved.value = ''
  if (!open.value || props.tasks || procTasks.value || !c.value?.proc) return
  try {
    const m = await api('/ontology/map')
    const b = (m.processes || []).find((x) => x.key === c.value.proc)
    const retired = new Set((m.tasks || []).filter((t) => t.status === 'retired').map((t) => t.key))
    if (b) procTasks.value = b.tasks.filter((k) => !retired.has(k))
  } catch { /* 아는 일들로 */ }
}
const passing = ref(null)
watch(moveTo, () => { passing.value = null })
watch(() => c.value?.id, () => { open.value = false; moveTo.value = ''; reason.value = ''; passing.value = null; procTasks.value = null })
async function move() {
  if (!moveTo.value) return
  busy.value = true; err.value = ''
  try {
    const r = await api(`/ontology/cases/${encodeURIComponent(c.value.id)}/move`, { method: 'POST', body: { task: moveTo.value, reason: reason.value.trim(), ...(passing.value ? { confirm: true } : {}) } })
    if (r?.confirm) { passing.value = r.required || []; return }
    passing.value = null
    moved.value = `「${moveTo.value}」${RO(moveTo.value)} 옮겼어요. ${isMap.value ? '같은 인스턴스에서 이어서 해요.' : '새 스냅샷에서 이어서 해요.'}`
    open.value = false; moveTo.value = ''; reason.value = ''
    emit('moved', r)
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="mv">
    <button class="mvbtn press" :aria-expanded="open" data-testid="onto-case-move-open" @click="toggle">다른 일로 옮기기</button>
    <div v-if="open" class="mvform">
      <select v-model="moveTo" class="sel" aria-label="옮길 일" data-testid="onto-case-move-task">
        <option value="" disabled>옮길 일을 고르세요</option>
        <option v-for="k in choices" :key="k" :value="k">{{ k }}</option>
      </select>
      <input v-model="reason" class="in" placeholder="옮기는 이유(선택)" maxlength="200" />
      <small class="hint">{{ isMap ? '열린 단계는 닫고, 같은 인스턴스에서 고른 일부터 이어요. 다음에 지도를 셈할 때 배워요.' : '지금 인스턴스는 닫고, 고른 일부터 새 스냅샷으로 이어요. 다음에 지도를 셈할 때 배워요.' }}</small>
      <div v-if="passing" class="pass" data-testid="onto-case-move-pass">
        <b>꼭 하는 단계 「{{ passing.map((x) => x.task).join('」 · 「') }}」{{ EUL(passing.at(-1)?.task || '') }} 지나쳐요.</b>
        <small v-for="x in passing" :key="x.task">{{ x.task }} · {{ x.line }}</small>
        <small>그래도 옮기려면 위에 옮기는 이유를 적고 「그래도 옮기기」를 눌러 주세요.</small>
      </div>
      <div class="btns">
        <button class="ghost press" :disabled="busy" @click="open = false; passing = null">취소</button>
        <button class="go press" :disabled="busy || !moveTo || (!!passing && !reason.trim())" data-testid="onto-case-move-apply" @click="move">{{ busy ? '옮기는 중…' : passing ? '그래도 옮기기' : '옮기기' }}</button>
      </div>
    </div>
    <small v-if="moved" class="ok">{{ moved }}</small>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.mv { min-width: 0; }
.mvbtn { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; font-weight: 500; background: var(--field-bg); }
.mvform { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.sel, .in { width: 100%; min-width: 0; height: 36px; padding: 0 10px; border-radius: 12px; border: 0; outline: 0; background: var(--field-bg); font-size: 14px; }
.sel option { color: #1d1d1f; }
.in::placeholder { color: var(--text-tertiary); }
.hint { font-size: 12px; color: var(--text-tertiary); line-height: 1.45; }
.pass { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, #7a4fd0 10%, var(--field-bg)); }
.pass b { font-size: 13px; font-weight: 600; line-height: 1.45; }
.pass small { font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
.btns { display: flex; justify-content: flex-end; gap: 6px; }
.ghost { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.go:disabled, .ghost:disabled { opacity: .45; cursor: default; }
.ok { display: block; margin-top: 8px; font-size: 12.5px; color: var(--color-success); }
.err { display: block; margin: 6px 0 0; font-size: 13px; color: var(--color-error); }
</style>
