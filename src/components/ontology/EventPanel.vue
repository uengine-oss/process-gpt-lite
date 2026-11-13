<script setup>
// 사건 하나(design-v0.3 §2): 무슨 사건인지(메일 · 결과물 · 채팅 …), 이 사건이 여는 일(TRIGGERS: 비율 · 함께/하나만 · 조건 ·
// 출처 · 역할 루틴이면 사람 수)과 이 사건을 내는 일(RAISES: 그 일이 끝나면 이 사건이 생긴 비율). 일 이름을 누르면 그 일로.
import { computed, ref } from 'vue'
import { api } from '../../api.js'
import { pct, CLS_KO, EVENT_KO, TRIG_SOURCE_KO, SPLIT_KO, scopeRole, condText } from './fmt.js'

const props = defineProps({
  event: { type: Object, required: true },
  triggers: { type: Array, default: () => [] },
  raises: { type: Array, default: () => [] },
  tasks: { type: Array, default: () => [] }, // map.tasks — a task on the map can be opened
  processes: { type: Array, default: () => [] },
  admin: { type: Boolean, default: false },
})
const emit = defineEmits(['task', 'changed'])
// 메일에서 찾은 정해진 때(design-v0.3 §15): 시계는 아직 없다 — 그 일이 든 프로세스에 같은 주기의 회사 타이머를 건다
const mined = computed(() => e.value.kind === 'timer' && !e.value.schedule && opens.value.some((t) => t.source === 'mined'))
const hostOf = (task) => props.processes.find((p) => p.kind !== 'routine' && (p.tasks || []).includes(task))
const busy = ref(false)
const msg = ref('')
// a timer with a clock (a person's schedule or a company timer): the graph is the record, so it is stopped or started here
async function toggle() {
  const next = e.value.status === 'paused' ? 'active' : 'paused'
  busy.value = true; msg.value = ''
  try { await api(`/ontology/timers/${encodeURIComponent(e.value.key)}`, { method: 'PUT', body: { status: next } }); msg.value = next === 'paused' ? '멈췄어요. 예약도 함께 멈춰요.' : '다시 켰어요.'; emit('changed') } catch (x) { msg.value = x.message } finally { busy.value = false }
}
async function hang(t) {
  const p = hostOf(t.to)
  busy.value = true; msg.value = ''
  try { const r = await api('/ontology/timers', { method: 'POST', body: { proc: p.key, entry: t.to, cron: e.value.cron } }); msg.value = `「${p.name}」에 ${r.when} 타이머를 걸었어요.`; emit('changed') } catch (x) { msg.value = x.message } finally { busy.value = false }
}
const e = computed(() => props.event)
const known = computed(() => new Set(props.tasks.map((t) => t.key)))
const opens = computed(() => props.triggers.filter((t) => t.from === e.value.key).sort((a, b) => (b.p || 0) - (a.p || 0)))
const raisedBy = computed(() => props.raises.filter((r) => r.to === e.value.key).sort((a, b) => (b.n || 0) - (a.n || 0)))
const splits = computed(() => new Set(opens.value.map((t) => t.split).filter(Boolean)))
const note = computed(() => {
  if (splits.value.has('and')) return '이 사건 뒤에는 여러 일이 함께 열려요.'
  if (splits.value.has('xor') && opens.value.length > 1) return opens.value.some((t) => t.cond) ? '이 사건 뒤에는 건마다 조건에 따라 하나만 열려요.' : '이 사건 뒤에는 건마다 하나만 열려요.'
  return ''
})
</script>

<template>
  <div class="evp" data-testid="onto-event-panel">
    <div class="meta">
      <span class="tag" :class="e.kind">{{ EVENT_KO[e.kind] || e.kind }}</span>
      <span v-if="e.cls" class="tag">{{ CLS_KO[e.cls] || e.cls }}</span>
      <small>{{ e.n || 0 }}번 {{ e.kind === 'timer' ? '울렸어요' : '생겼어요' }}</small>
    </div>
    <p v-if="e.kind === 'timer'" class="note" data-testid="onto-event-timer">{{ e.name }}<template v-if="e.status === 'paused'"> · 멈춤</template> — {{ e.scope === 'company' ? '회사가 프로세스에 건 타이머예요.' : mined ? '메일 날짜와 메일에 쓴 말에서 찾은 주기예요. 아직 시계는 걸려 있지 않아요.' : '이 역할 사람이 걸어 둔 예약이에요. 울리면 그 사람의 에이전트가 이 일을 해요.' }}</p>
    <div v-if="admin && e.kind === 'timer' && e.schedule" class="mined" data-testid="onto-event-clock">
      <button class="hang press" :disabled="busy" data-testid="onto-event-timer-toggle" @click="toggle">{{ busy ? '바꾸는 중…' : e.status === 'paused' ? '타이머 다시 켜기' : '타이머 멈추기' }}</button>
      <small v-if="msg && !mined" class="muted" data-testid="onto-event-timer-msg">{{ msg }}</small>
    </div>
    <div v-if="mined" class="mined" data-testid="onto-event-mined">
      <template v-for="t in opens.filter((x) => x.source === 'mined')" :key="`m-${t.to}`">
        <small>「{{ t.to }}」 메일 {{ t.n }}번 · 규칙성 {{ pct(t.p) }}<template v-if="t.cond"> · 메일: “{{ t.cond }}”</template></small>
        <button v-if="admin && hostOf(t.to)" class="hang press" :disabled="busy" data-testid="onto-event-hang" @click="hang(t)">{{ busy ? '거는 중…' : `이 주기로 「${hostOf(t.to).name}」 타이머 걸기` }}</button>
        <small v-else-if="admin" class="muted">이 일이 든 프로세스가 없어 회사 타이머로는 걸 수 없어요. 맡은 사람이 예약으로 걸 수 있어요.</small>
      </template>
      <small v-if="msg" class="muted" data-testid="onto-event-hang-msg">{{ msg }}</small>
    </div>
    <p v-if="note" class="note">{{ note }}</p>

    <h4>이 사건이 여는 일</h4>
    <p v-if="!opens.length" class="muted">지도에 보이는 일 가운데 이 사건으로 열리는 일이 없어요.</p>
    <ul v-else class="rows">
      <li v-for="t in opens" :key="`t-${t.to}`" data-testid="onto-event-trigger">
        <div class="top">
          <button class="nm press" :disabled="!known.has(t.to)" @click="emit('task', t.to)">{{ t.to }}</button>
          <b>{{ pct(t.p) }}</b>
        </div>
        <div class="sub">
          <span v-if="t.split" class="tag" :class="t.split">{{ SPLIT_KO[t.split] || t.split }}</span>
          <span class="tag src" :class="t.source">{{ TRIG_SOURCE_KO[t.source] || t.source || '메일 · 인계에서' }}</span>
          <small>{{ t.n || 0 }}번<template v-if="scopeRole(t.scope)"> · {{ scopeRole(t.scope) }} 역할 {{ t.people || 0 }}명</template><template v-if="t.shared"> · 공유 {{ t.shared }}</template></small>
        </div>
        <small v-if="t.cond" class="cond">조건 · {{ condText(t.cond) }}</small>
      </li>
    </ul>

    <template v-if="raisedBy.length">
      <h4>이 사건을 내는 일</h4>
      <ul class="rows">
        <li v-for="r in raisedBy" :key="`r-${r.from}`" data-testid="onto-event-raise">
          <div class="top">
            <button class="nm press" :disabled="!known.has(r.from)" @click="emit('task', r.from)">{{ r.from }}</button>
            <b>{{ pct(r.p) }}</b>
          </div>
          <small>그 일이 끝난 {{ r.n || 0 }}번에 이 사건이 생겼어요</small>
        </li>
      </ul>
    </template>
    <p v-else-if="e.key.startsWith('artifact:@')" class="muted">이 역할의 사람이 이런 결과물을 만들면 생기는 사건이에요.</p>
  </div>
</template>

<style scoped>
.evp { display: flex; flex-direction: column; gap: 10px; word-break: keep-all; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); }
.tag { font-size: 12px; padding: 2px 9px; border-radius: 9999px; background: var(--field-bg); color: var(--text-primary); white-space: nowrap; }
.tag.mail { background: color-mix(in srgb, var(--color-info) 20%, transparent); color: var(--color-info); }
.tag.artifact { background: color-mix(in srgb, var(--color-success) 20%, transparent); color: var(--color-success); }
.tag.message { background: color-mix(in srgb, #a78bfa 24%, transparent); }
.tag.and { background: color-mix(in srgb, var(--color-info) 20%, transparent); color: var(--color-info); font-weight: 600; }
.tag.xor { color: var(--text-secondary); }
.tag.src { background: transparent; box-shadow: inset 0 0 0 1px var(--hairline); color: var(--text-secondary); }
.tag.src.habit, .tag.src.told, .tag.src.rule { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-info) 50%, transparent); color: var(--color-info); }
.note { margin: 0; padding: 8px 12px; border-radius: 12px; font-size: 13px; background: var(--field-bg); color: var(--text-secondary); }
.muted { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
h4 { margin: 6px 0 -2px; font-size: 12.5px; font-weight: 500; color: var(--text-tertiary); }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rows li { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 12px; background: var(--field-bg); }
.top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.nm { font-size: 13.5px; font-weight: 500; text-align: left; text-decoration: underline; text-decoration-color: var(--hairline); text-underline-offset: 3px; }
.nm:disabled { text-decoration: none; cursor: default; }
.top b { font-size: 13.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sub { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.rows small { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.cond { color: var(--text-primary) !important; }
.mined { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 12px; background: var(--field-bg); }
.hang { align-self: flex-start; height: 32px; padding: 0 14px; border: 0; border-radius: 16px; background: var(--ink); color: var(--text-primary-on); font-size: 13px; }
.hang:disabled { opacity: .6; }
</style>
