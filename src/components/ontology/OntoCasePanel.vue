<script setup>
// 건 하나: 어디서 시작했는지(시작 일과 확률), 건너뛴 일, 옮긴 일, 지금 스냅샷(BPMN, 진행 표시)과 할 일.
// 「다른 일로 옮기기」는 누구나(건을 맡은 사람) — 지금 인스턴스를 닫고 그 일부터 새 스냅샷으로 잇는다.
// props.tasks: 옮길 수 있는 일 목록(지도 화면이 넘기면 그걸, 없으면 지도에서 이 프로세스의 일을 읽는다)
// hideHeader: 지도 화면의 SidePanel 처럼 바깥 틀이 제목을 보일 때 · emits moved(결과) · open-task(key)
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api.js'
import { pct, dateTimeKo } from './fmt.js'
import BpmnView from '../BpmnView.vue'
import { TODO_KO, RO } from './ontoText.js'

const props = defineProps({ caseId: { type: String, required: true }, tasks: { type: Array, default: null }, bpmnHeight: { type: Number, default: 300 }, hideHeader: Boolean })
const emit = defineEmits(['moved', 'open-task'])
const router = useRouter()
const c = ref(null)
const err = ref('')
const loading = ref(true)

async function load() {
  err.value = ''
  try { c.value = await api(`/ontology/cases/${encodeURIComponent(props.caseId)}`) } catch (e) { err.value = e.message } finally { loading.value = false }
}

const trig = computed(() => c.value?.trigger || {})
const odds = computed(() => c.value?.entry_odds || null)
const history = computed(() => c.value?.history || [])
const skipped = computed(() => history.value.filter((h) => h.state === 'skipped'))
const moves = computed(() => history.value.filter((h) => h.state === 'moved'))
const curInst = computed(() => (c.value?.instances || []).at(-1) || null)
const curInfo = computed(() => (c.value?.instancesInfo || []).find((i) => i.proc_inst_id === curInst.value) || null)
const defId = computed(() => curInfo.value?.proc_def_id || (c.value?.snapshots || []).at(-1) || '')
const curTodos = computed(() => (c.value?.todos || []).filter((t) => t.proc_inst_id === curInst.value || !t.proc_inst_id))
const stateOf = (s) => (s === 'DONE' ? 'done' : s === 'CANCELLED' ? 'skipped' : 'active')
const steps = computed(() => curTodos.value.filter((t) => t.activity_id).map((t) => ({ id: t.activity_id, state: stateOf(t.status) })))
const startedHow = computed(() => (trig.value.kind === 'mail' ? '메일로 들어왔어요' : trig.value.kind === 'manual' ? '직접 시작했어요' : ''))
const statusKo = computed(() => ({ running: '진행 중', done: '끝남', COMPLETED: '끝남' }[c.value?.status] || c.value?.status || ''))
const prevCount = computed(() => Math.max(0, (c.value?.instances || []).length - 1))

// 옮기기
const moveOpen = ref(false)
const moveTo = ref('')
const reason = ref('')
const busy = ref(false)
const moved = ref('')
const procTasks = ref(null)
const choices = computed(() => {
  const cur = moves.value.at(-1)?.task || c.value?.entry_task
  const list = props.tasks || procTasks.value || [...new Set([...(odds.value?.options || []).map((o) => o.task), ...history.value.map((h) => h.task), ...curTodos.value.map((t) => t.activity_name)])]
  return list.filter((k) => k && k !== cur && k !== '요청 접수')
})
async function openMove() {
  moveOpen.value = !moveOpen.value
  moved.value = ''
  if (!moveOpen.value || props.tasks || procTasks.value || !c.value?.proc) return
  try {
    const m = await api('/ontology/map')
    const b = (m.processes || []).find((x) => x.key === c.value.proc)
    const retired = new Set((m.tasks || []).filter((t) => t.status === 'retired').map((t) => t.key))
    if (b) procTasks.value = b.tasks.filter((k) => !retired.has(k))
  } catch { /* 아는 일들로 */ }
}
async function move() {
  if (!moveTo.value) return
  busy.value = true; err.value = ''
  try {
    const r = await api(`/ontology/cases/${encodeURIComponent(props.caseId)}/move`, { method: 'POST', body: { task: moveTo.value, reason: reason.value.trim() } })
    moved.value = `「${moveTo.value}」${RO(moveTo.value)} 옮겼어요. 새 스냅샷에서 이어서 해요.`
    moveOpen.value = false; moveTo.value = ''; reason.value = ''
    emit('moved', r)
    await load()
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
const who = (t) => (t.agent_orch ? '에이전트' : String(t.user_id || '').includes('@') ? String(t.user_id).split(/[@,]/)[0] : t.user_id ? '담당자' : '')
watch(() => props.caseId, () => { loading.value = true; c.value = null; moveOpen.value = false; load() }, { immediate: true })
defineExpose({ reload: load })
</script>

<template>
  <section class="cp" data-testid="onto-case-panel">
    <p v-if="loading && !c" class="muted pulse">불러오는 중…</p>
    <p v-else-if="!c && err" class="err">{{ err }}</p>
    <template v-else-if="c">
      <header class="hd">
        <template v-if="!hideHeader"><span class="badge">건 · {{ statusKo }}</span>
        <h3>{{ trig.subject || trig.customer || '이름 없는 건' }}</h3></template>
        <small class="sub"><template v-if="trig.from">{{ trig.from }} · </template>{{ startedHow }}<template v-if="c.created_at"> · {{ dateTimeKo(c.created_at) }}</template></small>
      </header>

      <!-- 시작 결정 -->
      <div class="sec">
        <h4>시작한 일</h4>
        <p class="start" data-testid="onto-case-entry">
          <button class="task press" @click="emit('open-task', c.entry_task)">{{ c.entry_task }}</button><span class="from">부터 시작했어요</span>
          <span v-if="odds?.p != null" class="p">{{ odds.measured === false ? '모델이 고름' : pct(odds.p) }}</span>
        </p>
        <div v-if="odds?.options?.length > 1" class="odds">
          <span v-for="o in odds.options" :key="o.task" :class="{ top: o.task === c.entry_task }">
            <i :style="{ width: `${Math.max(4, Math.round((o.p || 0) * 100))}%` }" />{{ o.task }} <b>{{ pct(o.p) }}</b>
          </span>
        </div>
        <div v-if="skipped.length" class="skipped">
          <span class="cap">건너뜀</span>
          <span v-for="s in skipped" :key="s.task" class="sk">{{ s.task }}</span>
        </div>
      </div>

      <!-- 옮긴 일 -->
      <div v-if="moves.length" class="sec">
        <h4>옮긴 일</h4>
        <ol class="moves">
          <li v-for="(m, i) in moves" :key="i" data-testid="onto-case-move">
            <b>→ {{ m.task }}</b>
            <small>{{ dateTimeKo(m.at) }}<template v-if="m.reason"> · {{ m.reason }}</template></small>
          </li>
        </ol>
      </div>

      <!-- 지금 스냅샷 -->
      <div class="sec snap">
        <div class="sh">
          <h4>지금 스냅샷</h4>
          <button v-if="curInst" class="lnk press" @click="router.push(`/projects/p/${encodeURIComponent(curInst)}`)">인스턴스 열기</button>
        </div>
        <div v-if="defId" class="dg"><BpmnView :key="defId" :def-id="defId" :steps="steps" :height="bpmnHeight" /></div>
        <p v-else class="muted">아직 스냅샷이 없어요.</p>
        <ul v-if="curTodos.length" class="todos">
          <li v-for="t in curTodos" :key="t.id || t.activity_id" :class="stateOf(t.status)">
            <span class="dot" /><span class="an">{{ t.activity_name }}</span>
            <small>{{ TODO_KO[t.status] || t.status }}<template v-if="who(t)"> · {{ who(t) }}</template></small>
          </li>
        </ul>
        <small v-if="prevCount" class="prev">앞선 스냅샷 {{ prevCount }}개는 옮기면서 닫았어요.</small>
      </div>

      <!-- 다른 일로 옮기기 -->
      <div class="sec mv">
        <button class="mvbtn press" :aria-expanded="moveOpen" data-testid="onto-case-move-open" @click="openMove">다른 일로 옮기기</button>
        <div v-if="moveOpen" class="mvform">
          <select v-model="moveTo" class="sel" aria-label="옮길 일" data-testid="onto-case-move-task">
            <option value="" disabled>옮길 일을 고르세요</option>
            <option v-for="k in choices" :key="k" :value="k">{{ k }}</option>
          </select>
          <input v-model="reason" class="in" placeholder="옮기는 이유(선택)" maxlength="200" />
          <small class="hint">지금 인스턴스는 닫고, 고른 일부터 새 스냅샷으로 이어요. 다음에 지도를 셈할 때 배워요.</small>
          <div class="btns">
            <button class="ghost press" :disabled="busy" @click="moveOpen = false">취소</button>
            <button class="go press" :disabled="busy || !moveTo" data-testid="onto-case-move-apply" @click="move">{{ busy ? '옮기는 중…' : '옮기기' }}</button>
          </div>
        </div>
        <small v-if="moved" class="ok">{{ moved }}</small>
        <small v-if="err" class="err">{{ err }}</small>
      </div>
    </template>
  </section>
</template>

<style scoped>
.cp { word-break: keep-all; overflow-wrap: anywhere; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.hd { display: flex; flex-direction: column; gap: 3px; }
.badge { font-size: 12px; color: var(--text-secondary); letter-spacing: .04em; }
h3 { margin: 0; font-size: 19px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; word-break: keep-all; }
.sub { font-size: 12.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.sec { padding: 12px; border-radius: 16px; background: var(--cell-bg); min-width: 0; }
.muted { margin: 0; font-size: 13.5px; color: var(--text-secondary); }
.err { display: block; margin: 6px 0 0; font-size: 13px; color: var(--color-error); }
.ok { display: block; margin-top: 8px; font-size: 12.5px; color: var(--color-success); }
.start { margin: 0 0 8px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 14.5px; }
.from { margin-left: -4px; }
.task { padding: 3px 11px; border-radius: 9999px; background: var(--ink); color: var(--ink-inverse); font-weight: 600; font-size: 14px; }
.p { font-size: 13px; font-weight: 600; color: var(--color-info); }
.odds { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.odds span { position: relative; display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); padding: 3px 8px; border-radius: 8px; overflow: hidden; }
.odds span i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--field-bg); z-index: -1; border-radius: 8px; }
.odds span { isolation: isolate; }
.odds span.top { color: var(--text-primary); }
.odds b { margin-left: auto; font-weight: 600; }
.skipped { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.cap { font-size: 12px; color: var(--text-tertiary); margin-right: 2px; }
.sk { font-size: 12.5px; padding: 2px 9px; border-radius: 9999px; background: var(--field-bg); color: var(--text-tertiary); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--text-tertiary) 60%, transparent); }
.moves { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.moves li { display: flex; flex-direction: column; gap: 1px; }
.moves b { font-size: 14px; font-weight: 600; }
.moves small { font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
.sh { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.lnk { font-size: 12.5px; color: var(--color-info); }
.dg { margin: 0 -4px; }
.todos { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.todos li { display: flex; align-items: center; gap: 8px; font-size: 13.5px; min-width: 0; }
.todos .an { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todos small { flex: none; font-size: 12px; color: var(--text-secondary); }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--text-primary) 15%, transparent); }
.todos li.done .dot { background: var(--color-success); box-shadow: none; }
.todos li.skipped { color: var(--text-tertiary); } .todos li.skipped .dot { background: var(--text-tertiary); box-shadow: none; }
.prev { display: block; margin-top: 8px; font-size: 12px; color: var(--text-tertiary); }
.mvbtn { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; font-weight: 500; background: var(--field-bg); }
.mvform { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.sel, .in { width: 100%; min-width: 0; height: 36px; padding: 0 10px; border-radius: 12px; border: 0; outline: 0; background: var(--field-bg); font-size: 14px; }
.sel option { color: #1d1d1f; }
.in::placeholder { color: var(--text-tertiary); }
.hint { font-size: 12px; color: var(--text-tertiary); line-height: 1.45; }
.btns { display: flex; justify-content: flex-end; gap: 6px; }
.ghost { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.go:disabled, .ghost:disabled { opacity: .45; cursor: default; }
</style>
