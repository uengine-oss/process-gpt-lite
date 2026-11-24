<script setup>
// 이 일을 할 에이전트(활동의 에이전트 설정 — server lib/localAgents, docs/local-agents/design.md §2): a server agent as before, or a CLI agent
// on the assignee's own computer (Claude Code · Codex · OpenHands) — then what happens when that computer is off: hand it to a server agent,
// or wait for it (at most so long, then the server agent). Kept in the task's definition (front matter agent · when_offline · server_agent ·
// wait_minutes; runner agent = 끝까지 · draft = 초안만). A local agent no desktop has reported yet is shown, not offered.
import { ref, computed, watch, onMounted } from 'vue'
import { api } from '../../api.js'

const props = defineProps({ taskKey: { type: String, required: true }, parsed: { type: Object, default: () => ({}) }, admin: Boolean })
const emit = defineEmits(['saved'])
const cat = ref({ local: [], server: [] })
const edit = ref(false)
const busy = ref(false)
const err = ref('')
const note = ref('')
const f = ref({})
// the activity's own agent: the business agent or a local CLI; deepagents · Claude Code (서버) only as the server agent a local step is
// handed to when the desktop is off (server lib/localAgents/agents.js frontOf)
const AGENT_KO = { onto: '업무 에이전트' }
const SERVER_KO = { onto: '업무 에이전트', deepagents: 'deepagents', cliagents: 'Claude Code (서버)' }
const cur = computed(() => {
  const p = props.parsed || {}
  if (p.local) return { agent: `local:${p.local.agent}`, whenOffline: p.local.offline, serverAgent: p.local.serverAgent, waitMinutes: p.local.waitMinutes || '', runner: p.runner === 'agent' ? 'agent' : 'draft' }
  return { agent: 'onto', whenOffline: 'server', serverAgent: 'onto', waitMinutes: '', runner: p.runner === 'agent' ? 'agent' : 'draft' }
})
const isLocal = (a) => String(a || '').startsWith('local:')
const labelOf = (a) => (isLocal(a) ? `${cat.value.local.find((x) => x.id === a)?.label || a.slice(6)} · 담당자의 컴퓨터` : SERVER_KO[a] || a)
const summary = computed(() => {
  const c = cur.value
  if (!isLocal(c.agent)) return labelOf(c.agent)
  const off = c.whenOffline === 'wait' ? `켜질 때까지 기다리기${c.waitMinutes ? ` (${c.waitMinutes}분 뒤 ${SERVER_KO[c.serverAgent]})` : ''}` : `${SERVER_KO[c.serverAgent]}에게 맡기기`
  return `${labelOf(c.agent)} · ${c.runner === 'agent' ? '끝까지' : '초안만'} · 꺼져 있으면 ${off}`
})
onMounted(async () => { cat.value = await api('/local-agents/catalog').catch(() => ({ local: [], server: [] })) })
watch(cur, (c) => { if (!edit.value) f.value = { ...c } }, { immediate: true })
const avail = (x) => x.devices > 0 || f.value.agent === x.id || cur.value.agent === x.id

async function save() {
  busy.value = true; err.value = ''; note.value = ''
  try {
    const body = { agent: f.value.agent, whenOffline: f.value.whenOffline, serverAgent: f.value.serverAgent, waitMinutes: f.value.whenOffline === 'wait' && f.value.waitMinutes ? Number(f.value.waitMinutes) : null,
      ...(isLocal(f.value.agent) ? { runner: f.value.runner } : {}) }
    await api(`/ontology/tasks/${encodeURIComponent(props.taskKey)}/agent`, { method: 'PUT', body })
    edit.value = false
    note.value = '저장했어요. 다음에 열리는 단계부터 이 에이전트로 실행해요.'
    emit('saved')
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="ag" data-testid="onto-task-agent">
    <div v-if="!edit" class="row">
      <span class="v" data-testid="onto-agent-summary">{{ summary }}</span>
      <button v-if="admin" class="lnk press" data-testid="onto-agent-edit" @click="f = { ...cur }; edit = true">바꾸기</button>
    </div>
    <form v-else class="ed" @submit.prevent="save">
      <label class="fl">에이전트
        <select v-model="f.agent" data-testid="onto-agent-select">
          <optgroup label="서버">
            <option v-for="(t, k) in AGENT_KO" :key="k" :value="k">{{ t }}</option>
          </optgroup>
          <optgroup label="담당자의 컴퓨터 (데스크톱 앱)">
            <option v-for="x in cat.local" :key="x.id" :value="x.id" :disabled="!avail(x)">{{ x.label }}{{ x.devices ? ` — 지금 ${x.devices}대 연결됨` : ' — 아직 알린 데스크톱이 없어요' }}</option>
          </optgroup>
        </select>
      </label>
      <template v-if="isLocal(f.agent)">
        <div class="fl">하는 만큼
          <label><input v-model="f.runner" type="radio" value="draft" /> 초안만 — 담당자가 확인하고 내요</label>
          <label><input v-model="f.runner" type="radio" value="agent" /> 끝까지 — 결과로 단계를 끝내요</label>
        </div>
        <div class="fl">담당자의 데스크톱이 꺼져 있으면
          <label><input v-model="f.whenOffline" type="radio" value="server" data-testid="onto-agent-offline-server" /> 서버에 맡기기</label>
          <label><input v-model="f.whenOffline" type="radio" value="wait" data-testid="onto-agent-offline-wait" /> 켜질 때까지 기다리기</label>
        </div>
        <label v-if="f.whenOffline === 'wait'" class="fl inl">기다리는 시간(분, 비우면 계속)
          <input v-model="f.waitMinutes" type="number" min="1" max="20160" placeholder="예: 120" data-testid="onto-agent-wait" />
        </label>
        <label class="fl inl">{{ f.whenOffline === 'wait' ? '기다린 뒤 맡길' : '맡길' }} 서버 에이전트
          <select v-model="f.serverAgent"><option v-for="(t, k) in SERVER_KO" :key="k" :value="k">{{ t }}</option></select>
        </label>
      </template>
      <div class="acts">
        <button type="button" class="lnk press" @click="edit = false">취소</button>
        <button class="go press" :disabled="busy" data-testid="onto-agent-save">{{ busy ? '저장 중…' : '저장' }}</button>
      </div>
    </form>
    <p v-if="note" class="ok">{{ note }}</p>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.ag { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lnk { font-size: 12.5px; color: var(--text-secondary); text-decoration: underline; }
.ed { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 14px; background: var(--field-bg); }
.fl { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text-secondary); }
.fl label { color: var(--text-primary); font-size: 13px; display: flex; gap: 6px; align-items: center; }
.fl select, .fl input[type=number] { height: 32px; border-radius: 10px; padding: 0 10px; background: var(--cell-bg); border: 0; color: var(--text-primary); font-size: 13px; }
.acts { display: flex; justify-content: flex-end; gap: 10px; align-items: center; }
.go { height: 32px; padding: 0 16px; border-radius: 16px; background: var(--ink); color: var(--ink-inverse); font-size: 13px; }
.ok { margin: 0; font-size: 12.5px; color: var(--text-secondary); }
.err { margin: 0; font-size: 12.5px; color: var(--color-error); }
</style>
