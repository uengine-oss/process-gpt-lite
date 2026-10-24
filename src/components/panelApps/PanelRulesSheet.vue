<script setup>
// 권한 규칙: who may see / add / change / remove rows of a panel app, in words and as a role preview.
// The folder owner edits them here from a fixed vocabulary (no free text reaches the database: the
// server compiles the choices to RLS policies). A sheet app becomes a database app when rules are
// turned on; removing a field asks first because its column's data goes away.
import { ref, computed, onMounted } from 'vue'
import Icon from '../Icon.vue'
import { api } from '../../api.js'

const props = defineProps({ app: Object })
const emit = defineEmits(['close', 'saved'])
const def = computed(() => props.app.def)
const isDb = computed(() => props.app.tier === 'db')
const owner = computed(() => props.app.role === 'owner')
const isEvents = computed(() => props.app.kind === 'events')
const err = ref('')
const busy = ref(false)
const history = ref([])

const ACTIONS = [['read', '보기'], ['create', '만들기'], ['update', '고치기'], ['delete', '지우기']]
const DEFAULT = { read: ['member'], create: ['member'], update: ['owner_of_row', 'role>=owner'], delete: ['owner_of_row', 'role>=owner'] }
const key = (t) => JSON.stringify(t)
const label = (k) => def.value.fields.find((f) => f.key === k)?.label || k

// the vocabulary offered per action
const options = computed(() => {
  const base = [['member', '구성원 모두'], ['owner_of_row', '만든 사람'], ['role>=editor', '편집 권한 이상'], ['role>=owner', '폴더 소유자']]
  const extra = []
  for (const f of def.value.fields) {
    if (f.type === 'choice') for (const c of f.choices) extra.push([{ field_equals: { field: f.key, value: c } }, `'${f.label}'이(가) '${c}'인 행`])
    if (f.type === 'person') extra.push([{ field_is_me: f.key }, `'${f.label}'이(가) 본인인 행`])
  }
  return [...base, ...extra]
})

const access = ref({})
const fieldRules = ref({})
onMounted(async () => {
  const a = def.value.access || DEFAULT
  access.value = Object.fromEntries(ACTIONS.map(([k]) => [k, new Set((a[k] || DEFAULT[k]).map(key))]))
  fieldRules.value = Object.fromEntries(def.value.fields.map((f) => [f.key, def.value.fieldRules?.[f.key]?.update?.[0] ? key(def.value.fieldRules[f.key].update[0]) : '']))
  if (owner.value && isDb.value) history.value = await api(`/panel-apps/${props.app.id}/migrations`).catch(() => [])
})
function toggle(action, t) {
  const s = new Set(access.value[action])
  s.has(key(t)) ? s.delete(key(t)) : s.add(key(t))
  access.value = { ...access.value, [action]: s }
}

// preview: what a member of each role may do, on their own rows and on others'
const ROLES = [['viewer', '보기 권한', 1], ['editor', '편집 권한', 3], ['owner', '폴더 소유자', 4]]
function cell(action, rank) {
  const list = [...(access.value[action] || [])].map((x) => JSON.parse(x))
  if (!list.length) return { t: '아무도', c: 'no' }
  const always = list.some((t) => t === 'member' || (typeof t === 'string' && t.startsWith('role>=') && { viewer: 1, runner: 2, editor: 3, owner: 4 }[t.slice(6)] <= rank))
  if (always) return { t: action === 'create' ? '가능' : '모든 행', c: 'yes' }
  const parts = []
  if (list.includes('owner_of_row')) parts.push(action === 'create' ? '가능' : '자기 행')
  for (const t of list) {
    if (t.field_equals) parts.push(`${label(t.field_equals.field)}=${t.field_equals.value}`)
    if (t.field_is_me) parts.push(`${label(t.field_is_me)}=본인`)
  }
  return parts.length ? { t: parts.join(' + '), c: 'some' } : { t: '안 됨', c: 'no' }
}

async function saveRules() {
  err.value = ''
  for (const [k, l] of ACTIONS) if (!access.value[k].size) { err.value = `'${l}' 규칙을 하나 이상 골라 주세요.`; return }
  if (!isDb.value && !confirm('행 단위 권한을 켜면 이 앱의 데이터가 시트에서 데이터베이스로 옮겨지고, 이후 시트는 보기용 사본이 돼요. 계속할까요?')) return
  busy.value = true
  try {
    const body = {
      access: Object.fromEntries(ACTIONS.map(([k]) => [k, [...access.value[k]].map((x) => JSON.parse(x))])),
      fieldRules: Object.fromEntries(Object.entries(fieldRules.value).filter(([, v]) => v).map(([k, v]) => [k, { update: [JSON.parse(v)] }])),
    }
    await api(`/panel-apps/${props.app.id}/rules`, { method: 'PUT', body })
    emit('saved')
  } catch (e) { err.value = e.message } finally { busy.value = false }
}

// 보안·개인정보: per-field sensitivity (lowering personal/sensitive asks first and is audited)
const LV = [['public', '공개'], ['internal', '팀 내부'], ['personal', '개인정보'], ['sensitive', '민감 정보']]
async function setLevel(f, level, confirmed = false) {
  err.value = ''
  try {
    await api(`/panel-apps/${props.app.id}/sensitivity`, { method: 'PUT', body: { field: f.key, level, confirm: confirmed } })
    emit('saved')
  } catch (e) {
    if (/확인 후/.test(e.message) && !confirmed && confirm(`${e.message}\n\n그래도 낮출까요? 이 변경은 감사 기록에 남아요.`)) return setLevel(f, level, true)
    err.value = e.message
  }
}

// event apps: who may add each kind of record
const EV_OPTS = (t) => [['subject_is_me', '본인 기록만'], ...(t.ref ? [['owner_of_ref', '원래 기록을 한 사람']] : []), ['member', '구성원 모두'], ['role>=editor', '편집 권한 이상'], ['role>=owner', '폴더 소유자']]
const evWho = ref(Object.fromEntries((def.value.events || []).map((e) => [e.type, new Set(e.who.map((x) => JSON.stringify(x)))])))
function toggleEv(t, o) {
  const s2 = new Set(evWho.value[t]); const k = JSON.stringify(o)
  s2.has(k) ? s2.delete(k) : s2.add(k)
  evWho.value = { ...evWho.value, [t]: s2 }
}
async function saveEventRules() {
  err.value = ''; busy.value = true
  try {
    for (const e of def.value.events) if (!evWho.value[e.type].size) throw new Error(`'${e.label}' 규칙을 하나 이상 골라 주세요.`)
    await api(`/panel-apps/${props.app.id}/event-rules`, { method: 'PUT', body: { events: Object.fromEntries(Object.entries(evWho.value).map(([t, v]) => [t, [...v].map((x) => JSON.parse(x))])) } })
    emit('saved')
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
async function ack() { await api(`/panel-apps/${props.app.id}/privacy-ack`, { method: 'POST' }).catch(() => {}); emit('saved') }

// fields of a db app: add, or remove (asks first)
const fields = ref(def.value.fields.map((f) => ({ ...f })))
const newField = ref({ label: '', type: 'text' })
const TYPES = [['text', '글'], ['longtext', '긴 글'], ['number', '숫자'], ['date', '날짜'], ['time', '시각'], ['checkbox', '체크'], ['person', '사람']]
function addField() {
  const l = newField.value.label.trim()
  if (!l) return
  const k = `f_${Date.now().toString(36)}`
  fields.value.push({ key: k, label: l, type: newField.value.type })
  newField.value = { label: '', type: 'text' }
}
const changedFields = computed(() => JSON.stringify(fields.value.map((f) => [f.key, f.label, f.type])) !== JSON.stringify(def.value.fields.map((f) => [f.key, f.label, f.type])))
async function saveFields(confirmDrop = false) {
  err.value = ''; busy.value = true
  try {
    await api(`/panel-apps/${props.app.id}/fields`, { method: 'PUT', body: { fields: fields.value, confirmDrop } })
    emit('saved')
  } catch (e) {
    if (/데이터가 사라져요/.test(e.message) && !confirmDrop) {
      busy.value = false
      if (confirm(`${e.message}\n\n정말 지울까요? 이 작업은 되돌릴 수 없어요.`)) return saveFields(true)
      return
    }
    err.value = e.message
  } finally { busy.value = false }
}
</script>

<template>
  <div class="veil" @click.self="emit('close')">
    <div class="box glass">
      <header class="hd">
        <Icon name="lock" :size="17" /><b>권한 규칙 — {{ app.title }}</b><span class="sp" />
        <span class="tier" :class="{ db: isDb }">{{ isDb ? '데이터베이스 · 행 단위 권한' : '시트 · 폴더 권한 그대로' }}</span>
        <button class="ic press" title="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="body scroll">
        <p class="fine">
          {{ isDb ? '데이터베이스의 행 단위 보안(RLS)이 이 규칙을 지켜요. 화면을 거치지 않고 데이터베이스에 바로 접근해도 똑같이 적용돼요. 모든 규칙은 폴더 구성원에게만 적용되고, 구성원이 아니면 아무것도 보이지 않아요.'
            : '지금은 폴더 권한이 그대로 적용돼요: 구성원은 모두 보고, 편집 권한 이상은 모든 행을 고칠 수 있어요. 아래에서 행 단위 규칙을 켜면 데이터가 데이터베이스로 옮겨져요.' }}
        </p>

        <div class="sec">보안·개인정보 기본값</div>
        <ul class="pv-lines"><li v-for="l in app.privacy" :key="l.text" :class="`k-${l.kind}`">{{ l.text }}</li></ul>
        <div v-if="owner && isDb" class="frs">
          <label v-for="f in def.fields" :key="f.key" class="fr">
            <span>{{ f.label }}</span>
            <select class="sel" :value="f.sensitivity || 'internal'" @change="setLevel(f, $event.target.value)">
              <option v-for="[k, l] in LV" :key="k" :value="k">{{ l }}</option>
            </select>
          </label>
        </div>
        <div v-if="owner && !app.privacyAck" class="row-end"><button class="dark-btn" @click="ack">기본값 확인했어요</button></div>

        <template v-if="isEvents">
          <div class="sec">기록을 더할 수 있는 사람 {{ owner ? '' : '(소유자만 바꿀 수 있어요)' }}</div>
          <p class="fine">기록은 고치거나 지울 수 없어요(데이터베이스가 막아요). 바로잡을 때는 취소·정정 기록을 더해요.</p>
          <div v-for="e in def.events" :key="e.type" class="act">
            <b>{{ e.label }}</b>
            <div class="chips">
              <button v-for="[t, tl] in EV_OPTS(e)" :key="t" class="chip" :class="{ on: evWho[e.type].has(JSON.stringify(t)) }" :disabled="!owner" @click="toggleEv(e.type, t)">{{ tl }}</button>
            </div>
          </div>
          <p v-if="err" class="bad">{{ err }}</p>
          <div v-if="owner" class="row-end"><button class="dark-btn" :disabled="busy" @click="saveEventRules">규칙 저장</button></div>
        </template>
        <template v-else>
        <div class="sec">역할별로 할 수 있는 일</div>
        <table class="pv">
          <thead><tr><th></th><th v-for="[k, l] in ACTIONS" :key="k">{{ l }}</th></tr></thead>
          <tbody>
            <tr v-for="[r, rl, rank] in ROLES" :key="r">
              <th>{{ rl }}</th>
              <td v-for="[k] in ACTIONS" :key="k" :class="cell(k, rank).c">{{ cell(k, rank).t }}</td>
            </tr>
          </tbody>
        </table>

        <div class="sec">규칙 {{ owner ? '' : '(소유자만 바꿀 수 있어요)' }}</div>
        <div v-for="[k, l] in ACTIONS" :key="k" class="act">
          <b>{{ l }}</b>
          <div class="chips">
            <button v-for="[t, tl] in options.filter(([t]) => k === 'read' || !t.field_equals || true)" :key="key(t)" class="chip" :class="{ on: access[k]?.has(key(t)) }" :disabled="!owner" @click="toggle(k, t)">{{ tl }}</button>
          </div>
        </div>
        <div class="sec">항목별로 바꿀 수 있는 사람</div>
        <div class="frs">
          <label v-for="f in def.fields" :key="f.key" class="fr">
            <span>{{ f.label }}</span>
            <select v-model="fieldRules[f.key]" class="sel" :disabled="!owner">
              <option value="">행을 고칠 수 있는 사람</option>
              <option :value="key('role>=editor')">편집 권한 이상만</option>
              <option :value="key('role>=owner')">폴더 소유자만</option>
              <option :value="key('owner_of_row')">만든 사람만</option>
            </select>
          </label>
        </div>
        <p v-if="err" class="bad">{{ err }}</p>
        <div v-if="owner" class="row-end">
          <button class="dark-btn" :disabled="busy" @click="saveRules">{{ busy ? '적용 중…' : isDb ? '규칙 저장' : '행 단위 권한 켜기' }}</button>
        </div>

        </template>
        <template v-if="isDb && owner && !isEvents">
          <div class="sec">항목 (열)</div>
          <div v-for="(f, i) in fields" :key="f.key" class="fd">
            <span class="fl">{{ f.label }}</span><small>{{ TYPES.find((t) => t[0] === f.type)?.[1] || f.type }}</small>
            <button class="ic press" title="항목 지우기" @click="fields.splice(i, 1)"><Icon name="close" :size="13" /></button>
          </div>
          <div class="inv">
            <input v-model="newField.label" class="sel grow" placeholder="새 항목 이름" @keydown.enter="addField">
            <select v-model="newField.type" class="sel"><option v-for="[t, tl] in TYPES" :key="t" :value="t">{{ tl }}</option></select>
            <button class="ic press" title="추가" @click="addField"><Icon name="plus" :size="15" /></button>
          </div>
          <div v-if="changedFields" class="row-end"><button class="dark-btn" :disabled="busy" @click="saveFields()">항목 변경 적용</button></div>
          <details v-if="history.length" class="hist">
            <summary>변경 기록 {{ history.length }}건</summary>
            <div v-for="h in history" :key="h.version">v{{ h.version }} · {{ { create: '만들기', rules: '규칙', alter: '항목 변경', upgrade: '시트→데이터베이스', drop: '지우기' }[h.kind] || h.kind }}{{ h.destructive ? ' · 열 삭제' : '' }} · {{ new Date(h.applied_at).toLocaleString('ko-KR') }}{{ h.note ? ` · ${h.note}` : '' }}</div>
          </details>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .3); display: grid; place-items: center; padding: 24px; animation: fade-in .2s both; }
.box { width: min(680px, 100%); max-height: calc(100vh - 48px); border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .3); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); color: var(--text-primary); }
.hd { display: flex; align-items: center; gap: 10px; height: 58px; padding: 0 14px 0 20px; border-bottom: 1px solid var(--hairline); font-size: 16px; flex: none; }
.sp { flex: 1; }
.tier { font-size: 12px; padding: 3px 10px; border-radius: 99px; background: var(--cell-bg); color: var(--text-secondary); }
.tier.db { background: rgba(150 200 255 / .16); color: var(--color-info); }
.ic { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; background: var(--button-bg); flex: none; }
.body { padding: 6px 20px 20px; overflow-y: auto; }
.fine { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin: 10px 0 0; }
.sec { font-size: 12.5px; color: var(--text-tertiary); margin: 18px 0 8px; }
.pv { width: 100%; border-collapse: separate; border-spacing: 4px; font-size: 13px; }
.pv th { font-weight: 500; text-align: left; color: var(--text-secondary); font-size: 12.5px; }
.pv td { background: var(--cell-bg); border-radius: 8px; padding: 6px 8px; }
.pv td.yes { color: var(--color-success); } .pv td.no { color: var(--text-tertiary); } .pv td.some { color: var(--color-info); }
.pv-lines { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; display: flex; flex-direction: column; gap: 2px; }
.pv-lines li.k-sensitive, .pv-lines li.k-personal { color: var(--color-info); }
.act { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; }
.act b { flex: none; width: 72px; font-weight: 500; font-size: 14px; padding-top: 5px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 13px; padding: 5px 10px; border-radius: 99px; background: var(--cell-bg); color: var(--text-secondary); border: 1px solid transparent; }
.chip.on { background: rgba(150 200 255 / .18); color: var(--text-primary); border-color: rgba(150 200 255 / .5); }
.chip:disabled { cursor: default; }
.frs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; }
.fr { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.fr span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sel { height: 34px; border-radius: 10px; border: 1px solid var(--hairline); background: var(--field-bg); color: var(--text-primary); padding: 0 8px; font-size: 13px; }
.sel option { color: #1d1d1f; }
.sel.grow { flex: 1; }
.row-end { display: flex; justify-content: flex-end; margin-top: 12px; }
.dark-btn { height: 40px; padding: 0 18px; background: var(--ink); color: var(--ink-inverse); }
.bad { font-size: 13px; color: var(--color-error); margin: 10px 0 0; }
.fd { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--hairline); font-size: 14px; }
.fd .fl { flex: 1; } .fd small { color: var(--text-secondary); font-size: 12px; }
.fd .ic { width: 26px; height: 26px; }
.inv { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
.hist { margin-top: 14px; font-size: 12.5px; color: var(--text-secondary); }
.hist div { padding: 3px 0; }
</style>
