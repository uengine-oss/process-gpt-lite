<script setup>
// 역할(design-v0.3 §3.2 · §3.3 · §6): 역할은 전문성의 관점이다. roleKey 가 없으면 역할 목록(바깥 역할 — 고객 — 은 흐리게),
// 있으면 그 역할: 정의 · 역량(근거, 확정됨/초안) · 수행자(사람 · 에이전트, 지정 안 됨) · 맡은 일(몫, 한 사람에게만) ·
// 루틴(같은 역할 사람 수) · 지표(사람 · 주당 부하 · 에이전트 몫 · 인계). 관리자는 정의 초안 만들기 → 고치기 → 확정.
// 루틴은 지도와 같은 기준(개인 습관 보이기 설정)으로: 지도에 보이는 TRIGGERS(triggers)만.
// emits pick(key | '') · task(key) · changed
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'
import { pct, TRIG_SOURCE_KO } from './fmt.js'
import { eventLabel } from './mapView.js'

const props = defineProps({
  roleKey: { type: String, default: '' },
  roles: { type: Array, default: () => [] },
  events: { type: Array, default: () => [] },
  triggers: { type: Array, default: () => [] },
  tasks: { type: Array, default: () => [] },
  admin: Boolean,
})
const emit = defineEmits(['pick', 'task', 'changed'])

const list = computed(() => [...props.roles].sort((a, b) => (!!a.outside - !!b.outside) || (b.n || 0) - (a.n || 0)))
const d = ref(null)
const loading = ref(false)
const err = ref('')
const note = ref('')
const busy = ref('')
const mode = ref('view') // view | edit
const defText = ref('')
const comps = ref([])

async function load() {
  d.value = null; err.value = ''; note.value = ''; mode.value = 'view'
  if (!props.roleKey) return
  loading.value = true
  try { d.value = await api(`/ontology/roles/${encodeURIComponent(props.roleKey)}`) } catch (e) { err.value = e.message } finally { loading.value = false }
}
watch(() => props.roleKey, load, { immediate: true })

const r = computed(() => d.value?.role || {})
const competencies = computed(() => (Array.isArray(r.value.competencies) ? r.value.competencies : []))
const known = computed(() => new Set(props.tasks.map((t) => t.key)))
const evName = computed(() => new Map(props.events.map((e) => [e.key, e.name || eventLabel(e)])))
const shownTrig = computed(() => new Set(props.triggers.map((t) => `${t.from}\u0000${t.to}`)))
const routine = computed(() => (d.value?.routineTasks || []).filter((x) => shownTrig.value.has(`${x.event}\u0000${x.task}`)).sort((a, b) => (b.people || 0) - (a.people || 0)))
const hiddenRoutine = computed(() => (d.value?.routineTasks || []).length - routine.value.length)
const load1 = (x) => (x == null ? '–' : `${x < 10 ? Number(x).toFixed(1) : Math.round(x)}건`)

function edit(from) {
  defText.value = from?.definition ?? r.value.definition ?? ''
  comps.value = (from?.competencies ?? competencies.value).map((c) => ({ name: c.name || '', evidence: c.evidence || '' }))
  if (!comps.value.length) comps.value = [{ name: '', evidence: '' }]
  mode.value = 'edit'
}
async function draft() {
  busy.value = 'draft'; err.value = ''; note.value = ''
  try {
    const x = await api(`/ontology/roles/${encodeURIComponent(props.roleKey)}/draft`, { method: 'POST', body: {} })
    edit(x)
    note.value = '맡은 일 · 결과물 · 루틴을 근거로 초안을 썼어요. 고친 뒤 확정해야 반영돼요.'
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function save() {
  busy.value = 'save'; err.value = ''
  try {
    d.value = await api(`/ontology/roles/${encodeURIComponent(props.roleKey)}`, { method: 'PUT', body: { definition: defText.value.trim(), competencies: comps.value.filter((c) => c.name.trim()) } })
    mode.value = 'view'
    note.value = '확정했어요.'
    emit('changed', { kind: 'role', key: props.roleKey })
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const canSave = computed(() => !!defText.value.trim() && comps.value.some((c) => c.name.trim()))
</script>

<template>
  <!-- 목록 -->
  <section v-if="!roleKey" class="rp" data-testid="onto-role-list">
    <p class="muted">역할마다 맡은 일 · 하는 사람 · 필요한 역량을 봐요. 메일과 인계 기록에서 셈했어요.</p>
    <p v-if="!list.length" class="muted">아직 셈한 역할이 없어요.</p>
    <button v-for="x in list" :key="x.key" class="ri press" :class="{ out: x.outside }" data-testid="onto-role-item" :data-role="x.key" @click="emit('pick', x.key)">
      <span class="rn"><b>{{ x.name || x.key }}</b>
        <span v-if="x.outside" class="tag">바깥</span>
        <span v-else-if="x.confirmed" class="tag ok">확정됨</span>
      </span>
      <small>사람 {{ x.members || 0 }}명 · 일 {{ (x.tasks || []).length }}개<template v-if="x.agent_share"> · 에이전트 {{ pct(x.agent_share) }}</template></small>
    </button>
  </section>

  <!-- 역할 하나 -->
  <section v-else class="rp" data-testid="onto-role-panel" :data-role="roleKey">
    <button class="back press" @click="emit('pick', '')">‹ 역할 목록</button>
    <p v-if="loading && !d" class="muted pulse">불러오는 중…</p>
    <p v-else-if="!d && err" class="err">{{ err }}</p>
    <template v-else-if="d">
      <div class="meta">
        <span v-if="r.outside" class="tag">회사 바깥</span>
        <span v-if="r.definition || competencies.length" class="tag" :class="r.confirmed ? 'ok' : 'draft'" data-testid="onto-role-state">{{ r.confirmed ? '확정됨' : '초안' }}</span>
      </div>

      <!-- 정의 · 역량 -->
      <div class="sec">
        <h4>정의 · 역량</h4>
        <template v-if="mode === 'view'">
          <p v-if="r.definition" class="def">{{ r.definition }}</p>
          <p v-else class="muted">아직 정의가 없어요.<template v-if="admin"> 맡은 일과 결과물을 근거로 초안을 만들 수 있어요.</template></p>
          <ul v-if="competencies.length" class="comps">
            <li v-for="c in competencies" :key="c.name"><b>{{ c.name }}</b><small v-if="c.evidence">{{ c.evidence }}</small></li>
          </ul>
          <div v-if="admin" class="btns left">
            <button class="go press" :disabled="!!busy" data-testid="onto-role-draft" @click="draft">{{ busy === 'draft' ? '초안 만드는 중…' : '정의 초안 만들기' }}</button>
            <button v-if="r.definition" class="ghost2 press" :disabled="!!busy" @click="edit()">고치기</button>
          </div>
        </template>
        <template v-else>
          <label class="lab">정의</label>
          <textarea v-model="defText" class="ed" rows="3" placeholder="이 역할이 회사에서 무엇을 책임지는지 한두 문장" data-testid="onto-role-def" />
          <label class="lab">역량</label>
          <div v-for="(c, i) in comps" :key="i" class="crow">
            <input v-model="c.name" class="in" placeholder="역량(예: 견적 원가 판단)" data-testid="onto-role-comp-name">
            <input v-model="c.evidence" class="in ev" placeholder="근거(맡은 일 · 결과물 · 습관)">
            <button class="x press" aria-label="역량 빼기" @click="comps.splice(i, 1)">×</button>
          </div>
          <button class="more press" @click="comps.push({ name: '', evidence: '' })">＋ 역량 더하기</button>
          <div class="btns">
            <button class="ghost press" :disabled="!!busy" @click="mode = 'view'; note = ''">취소</button>
            <button class="go press" :disabled="!!busy || !canSave" data-testid="onto-role-save" @click="save">{{ busy === 'save' ? '확정하는 중…' : '확정' }}</button>
          </div>
        </template>
        <small v-if="note" class="ok" data-testid="onto-role-note">{{ note }}</small>
      </div>

      <!-- 지표 -->
      <dl class="kv">
        <dt>사람</dt><dd><b>{{ r.members || 0 }}명</b></dd>
        <dt>부하</dt><dd>사람마다 한 주에 {{ load1(r.load) }}</dd>
        <dt>에이전트 몫</dt><dd>{{ pct(r.agent_share || 0) }}</dd>
        <dt>인계</dt><dd>받음 {{ r.handovers_in || 0 }} · 넘김 {{ r.handovers_out || 0 }}</dd>
      </dl>

      <!-- 수행자 -->
      <div v-if="d.performers?.length" class="sec">
        <h4>하는 사람 · 에이전트</h4>
        <ul class="rows">
          <li v-for="p in d.performers" :key="p.id" data-testid="onto-role-performer">
            <span class="pn">{{ p.name }}</span>
            <span class="tag" :class="{ agent: p.agent }">{{ p.agent ? '에이전트' : '사람' }}</span>
            <span v-if="!p.assigned && p.n" class="tag warn" title="이 역할에 지정되지 않았는데 이 역할의 일을 했어요">지정 안 됨</span>
            <small>{{ p.n ? `${p.n}건 · 그 사람 일의 ${pct(p.share)}` : '지정됨 · 아직 기록 없음' }}</small>
          </li>
        </ul>
      </div>

      <!-- 맡은 일 -->
      <div v-if="d.tasks?.length" class="sec">
        <h4>맡은 일</h4>
        <ul class="rows">
          <li v-for="t in d.tasks" :key="t.task" data-testid="onto-role-task">
            <button class="pn link press" :disabled="!known.has(t.task)" @click="emit('task', t.task)">{{ t.task }}</button>
            <span v-if="t.single" class="tag warn">한 사람에게만</span>
            <small>{{ t.n }}건 · 이 역할이 {{ pct(t.share) }}<template v-if="t.skills?.length"> · 스킬 {{ t.skills.length }}</template></small>
          </li>
        </ul>
      </div>

      <!-- 루틴 -->
      <div v-if="routine.length || hiddenRoutine" class="sec">
        <h4>루틴 <small>결과물 뒤에 혼자 이어서 하는 일</small></h4>
        <ul v-if="routine.length" class="rows">
          <li v-for="x in routine" :key="`${x.event}>${x.task}`" data-testid="onto-role-routine">
            <span class="pn">{{ evName.get(x.event) || x.event }} → <button class="link press" :disabled="!known.has(x.task)" @click="emit('task', x.task)">{{ x.task }}</button></span>
            <small>같은 역할 {{ x.people || 0 }}명 · {{ TRIG_SOURCE_KO[x.source] || x.source }}</small>
          </li>
        </ul>
        <small v-if="hiddenRoutine" class="muted sm">기준에 못 미쳐 안 보이는 루틴 {{ hiddenRoutine }}개</small>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
    </template>
  </section>
</template>

<style scoped>
.rp { display: flex; flex-direction: column; gap: 10px; word-break: keep-all; overflow-wrap: anywhere; min-width: 0; }
.muted { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.muted.sm { font-size: 12px; display: block; margin-top: 6px; }
.err { margin: 0; font-size: 13px; color: var(--color-error); }
.ok { display: block; margin-top: 8px; font-size: 12.5px; color: var(--color-success); }
.ri { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 12px; border-radius: 14px; background: var(--cell-bg); text-align: left; }
.ri.out { opacity: .5; }
.rn { display: flex; align-items: center; gap: 6px; }
.rn b { font-size: 14.5px; font-weight: 600; }
.ri small { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.back { align-self: flex-start; font-size: 12.5px; color: var(--color-info); }
.meta { display: flex; flex-wrap: wrap; gap: 6px; }
.meta:empty { display: none; }
.tag { font-size: 11.5px; padding: 1px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); white-space: nowrap; }
.tag.ok { background: color-mix(in srgb, var(--color-success) 20%, transparent); color: var(--color-success); font-weight: 600; }
.tag.draft { background: rgba(232, 145, 58, .18); color: #ffb36b; font-weight: 600; }
.tag.warn { background: rgba(232, 145, 58, .16); color: #ffb36b; }
:root[data-theme="light"] .tag.draft, :root[data-theme="light"] .tag.warn { color: #b35c00; }
.tag.agent { background: color-mix(in srgb, #7c3aed 26%, transparent); color: var(--text-primary); }
.sec { padding: 12px; border-radius: 16px; background: var(--cell-bg); min-width: 0; }
h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
h4 small { font-weight: 400; color: var(--text-tertiary); margin-left: 4px; }
.def { margin: 0 0 8px; font-size: 14px; line-height: 1.55; }
.comps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.comps li { display: flex; flex-direction: column; gap: 1px; padding-left: 12px; border-left: 2px solid var(--color-success); }
.comps b { font-size: 13.5px; font-weight: 600; }
.comps small { font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; padding: 0 2px; font-size: 13.5px; align-items: baseline; }
.kv dt { color: var(--text-secondary); white-space: nowrap; }
.kv dd { margin: 0; font-variant-numeric: tabular-nums; }
.kv dd b { font-size: 16px; font-weight: 600; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.rows li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.rows small { flex-basis: 100%; font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.pn { font-size: 13.5px; font-weight: 500; }
.link { text-align: left; text-decoration: underline; text-decoration-color: var(--hairline); text-underline-offset: 3px; }
.link:disabled { text-decoration: none; cursor: default; }
.btns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.btns.left { justify-content: flex-start; }
.lab { display: block; margin: 6px 0 4px; font-size: 12.5px; color: var(--text-secondary); }
.ed { width: 100%; resize: vertical; padding: 8px 10px; border-radius: 12px; border: 0; outline: 0; background: var(--field-bg); font-family: inherit; font-size: 13.5px; line-height: 1.5; color: var(--text-primary); }
.crow { display: grid; grid-template-columns: 1fr auto; gap: 3px 4px; margin-bottom: 8px; }
.crow .ev { grid-column: 1; height: 28px; font-size: 12px; color: var(--text-secondary); }
.crow .x { grid-column: 2; grid-row: 1; }
.in { min-width: 0; height: 32px; padding: 0 8px; border-radius: 10px; border: 0; outline: 0; background: var(--field-bg); font-size: 12.5px; color: var(--text-primary); }
.x { width: 28px; height: 32px; border-radius: 10px; color: var(--text-secondary); font-size: 16px; }
.more { font-size: 12.5px; color: var(--color-info); }
.ghost { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); }
.ghost2 { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13px; font-weight: 500; background: var(--field-bg); }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.go:disabled, .ghost:disabled, .ghost2:disabled { opacity: .45; cursor: default; }
</style>
