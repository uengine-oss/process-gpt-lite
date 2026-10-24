<script setup>
// A panel app on Home (패널 앱): drawn from its definition, not generated code. The data is the
// spreadsheet in a shared folder — this card lists, adds and edits rows through the server, opens
// the sheet in the IeumOffice editor, and shares the app with the folder's membership.
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import ShareSheet from '../folders/ShareSheet.vue'
import PanelRulesSheet from './PanelRulesSheet.vue'
import PanelEventsBody from './PanelEventsBody.vue'
import { api } from '../../api.js'
import { useApp } from '../../stores/app.js'

const props = defineProps({ app: Object })
const store = useApp()
const router = useRouter()
const rows = ref(null)
const err = ref('')
const menu = ref(false)
const editing = ref(null)    // null | 'new' | row
const form = ref({})
const problems = ref('')
const saving = ref(false)
const showAll = ref(false)
const share = ref(null)      // folder detail for ShareSheet
const opening = ref(false)

const def = computed(() => props.app.def)
// tier db: the database guards each row (RLS); the flags here only grey out what it would refuse
const isDb = computed(() => props.app.tier === 'db')
const people = ref([])
const canCreate = ref(false)
const meId = ref(null)
const rulesOpen = ref(false)   // the rule summary under the header
const rulesSheet = ref(false)  // "권한 규칙" sheet
const note = ref('')
const canEdit = computed(() => ['owner', 'editor'].includes(props.app.role))
const canAdd = computed(() => (isDb.value ? canCreate.value : canEdit.value))
const rowEditable = (r) => (r === 'new' ? canAdd.value : isDb.value ? !!r?._can?.update : canEdit.value)
const rowDeletable = (r) => r !== 'new' && (isDb.value ? !!r?._can?.delete : canEdit.value)
const fieldEditable = (k) => rowEditable(editing.value) && (editing.value === 'new' || !isDb.value || editing.value?._can?.fields?.[k] !== false)
const ruleLines = computed(() => (props.app.kind === 'events' ? (props.app.eventRules || []).map((e) => ({ action: e.type, label: e.label, text: e.who })) : props.app.rules || []))
const ruleText = (a) => (props.app.rules || []).find((x) => x.action === a)?.text || ''
const personName = (id) => people.value.find((p) => p.id === id)?.name || id
const fieldOf = (k) => [...def.value.fields, ...def.value.computed].find((f) => f.key === k)
const list = computed(() => def.value.views.list)

const isEvents = computed(() => props.app.kind === 'events')
async function load() {
  if (isEvents.value) return // PanelEventsBody loads the replayed projections itself
  try {
    const r = await api(`/panel-apps/${props.app.id}/rows`)
    rows.value = r.rows
    if (r.people) people.value = r.people
    canCreate.value = !!r.canCreate
    meId.value = r.me || null
    err.value = ''
  } catch (e) { err.value = e.message }
}
onMounted(load)
watch(() => store.panelAppTick[props.app.id], load)
watch(() => props.app.def, load)

const sorted = computed(() => {
  const out = [...(rows.value || [])]
  const s = list.value.sort
  if (s) out.sort((a, b) => {
    const x = a[s.key], y = b[s.key]
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'ko')
    return s.dir === 'desc' ? -c : c
  })
  return out
})
const shown = computed(() => (showAll.value ? sorted.value : sorted.value.slice(0, 6)))

const num = (v) => (typeof v === 'number' ? v : Number(v) || 0)
const fmt = (v, f) => {
  if (v === '' || v === null || v === undefined) return ''
  if (f?.type === 'checkbox') return v ? '예' : '아니오'
  if (f?.type === 'person' && isDb.value) return personName(v)
  if (typeof v === 'number') return v.toLocaleString('ko-KR', { maximumFractionDigits: 2 })
  return String(v)
}
const summary = computed(() => def.value.views.summary.map((s) => {
  const r = rows.value || []
  let v = r.length
  if (s.agg === 'sum') v = r.reduce((a, x) => a + num(x[s.field]), 0)
  else if (s.agg === 'avg') v = r.length ? Math.round(r.reduce((a, x) => a + num(x[s.field]), 0) / r.length * 10) / 10 : 0
  else if (s.agg === 'count_where') v = r.filter((x) => String(x[s.field]) === s.eq).length
  return { label: s.label, value: fmt(v), suffix: s.suffix || '' }
}))
const sub = (r) => list.value.subtitle.map((k) => { const f = fieldOf(k); const v = fmt(r[k], f); return v === '' ? '' : f?.type === 'number' ? `${f.label} ${v}` : v }).filter(Boolean).join(' · ')

function open(r) {
  if (!canAdd.value && r === 'new') return
  problems.value = ''
  editing.value = r
  form.value = r === 'new'
    ? Object.fromEntries(def.value.fields.map((f) => [f.key, f.default ?? (f.type === 'checkbox' ? false : f.type === 'person' && isDb.value ? meId.value : '')]))
    : Object.fromEntries(def.value.fields.map((f) => [f.key, r[f.key]]))
}
async function save() {
  saving.value = true; problems.value = ''
  try {
    const r = editing.value === 'new'
      ? await api(`/panel-apps/${props.app.id}/rows`, { method: 'POST', body: { values: form.value } })
      : await api(`/panel-apps/${props.app.id}/rows/${encodeURIComponent(editing.value._id)}`, { method: 'PUT', body: { _v: editing.value._v, values: form.value } })
    rows.value = isDb.value ? (await api(`/panel-apps/${props.app.id}/rows`)).rows : r.rows
    editing.value = null
  } catch (e) {
    problems.value = e.message
    if (/먼저 고쳤|지웠을/.test(e.message)) load()
  } finally { saving.value = false }
}
async function removeRow() {
  if (!confirm('이 행을 지울까요? 시트에서도 지워져요.')) return
  try {
    const r = await api(`/panel-apps/${props.app.id}/rows/${encodeURIComponent(editing.value._id)}?_v=${editing.value._v}`, { method: 'DELETE' })
    rows.value = isDb.value ? (await api(`/panel-apps/${props.app.id}/rows`)).rows : r.rows
    editing.value = null
  } catch (e) { problems.value = e.message }
}

async function openSheet() {
  menu.value = false
  opening.value = true
  try {
    const s = await api(`/panel-apps/${props.app.id}/sheet`, { method: 'POST' })
    store.officeDoc = { url: s.url, name: s.name, panelAppId: props.app.id, sha: s.sha, readOnly: s.readOnly, title: props.app.title }
  } catch (e) { err.value = e.message } finally { opening.value = false }
}
async function ackPrivacy() {
  try { await api(`/panel-apps/${props.app.id}/privacy-ack`, { method: 'POST' }); store.loadPanelApps() } catch (e) { err.value = e.message }
}
async function openShare() {
  menu.value = false
  // secure by default: the owner reviews the privacy defaults before inviting anyone
  if (!props.app.privacyAck && props.app.role === 'owner') { note.value = '먼저 위의 보안·개인정보 기본값을 확인해 주세요.'; setTimeout(() => (note.value = ''), 5000); return }
  try { share.value = await api(`/folders/${props.app.folder.slug}`) } catch (e) { err.value = e.message }
}
async function closeShare() {
  share.value = null
  await api(`/panel-apps/${props.app.id}/announce`, { method: 'POST' }).catch(() => {})
  store.loadPanelApps()
}
async function saveSnapshot() {
  menu.value = false
  try {
    const r = await api(`/panel-apps/${props.app.id}/snapshot`, { method: 'POST' })
    note.value = `폴더에 스냅샷을 남겼어요: ${r.path} · ${r.rows}행${r.hidden ? ` (비공개 ${r.hidden}행 제외)` : ''}`
  } catch (e) { note.value = e.message }
  setTimeout(() => (note.value = ''), 6000)
}
function openRules() { menu.value = false; rulesSheet.value = true }
function toFolder() { menu.value = false; router.push(`/folders/${props.app.folder.slug}`) }
async function hide() { menu.value = false; await api(`/panel-apps/${props.app.id}/hide`, { method: 'POST' }); store.loadPanelApps() }
async function removeApp() {
  menu.value = false
  if (!confirm(`'${props.app.title}' 앱을 지울까요? 폴더의 시트와 정의 파일도 지워져요(폴더 이력에는 남아요).`)) return
  try { await api(`/panel-apps/${props.app.id}`, { method: 'DELETE' }) } catch (e) { err.value = e.message }
}
</script>

<template>
  <div class="pa glass">
    <div class="head">
      <span class="ico">{{ app.icon }}</span>
      <span class="title">{{ app.title }}</span>
      <button v-if="isDb" class="lock press" :class="{ on: rulesOpen }" title="행 단위 권한 — 데이터베이스가 지켜요" @click="rulesOpen = !rulesOpen"><Icon name="lock" :size="12" /> 행 권한</button>
      <span v-if="app.people > 1" class="shared" :title="`${app.folder.name} 폴더 구성원 ${app.people}명`"><Icon name="team" :size="13" /> {{ app.people }}</span>
      <button class="more" aria-label="패널 메뉴" @click="menu = !menu"><Icon name="more" :size="18" /></button>
      <Transition name="fade">
        <div v-if="menu" class="menu glass" @mouseleave="menu = false">
          <button @click="openSheet">시트 열기</button>
          <button @click="openShare">공유하기</button>
          <button @click="openRules">권한 규칙{{ app.role === 'owner' ? '' : ' 보기' }}</button>
          <button v-if="isDb && canEdit" @click="saveSnapshot">스냅샷 저장(폴더에 xlsx)</button>
          <button @click="toFolder">폴더에서 보기 · {{ app.folder.name }}</button>
          <button @click="hide">Home에서 숨기기</button>
          <button v-if="app.role === 'owner'" class="danger" @click="removeApp">앱 지우기</button>
        </div>
      </Transition>
    </div>

    <Transition name="fade">
      <div v-if="isDb && rulesOpen" class="rules">
        <div v-for="l in ruleLines" :key="l.action"><span>{{ l.label }}</span>{{ l.text }}</div>
        <div v-for="l in (app.privacy || []).filter((x) => ['personal', 'sensitive'].includes(x.kind))" :key="l.text" class="pl"><Icon name="lock" :size="11" /> {{ l.text }}</div>
        <small>데이터베이스(행 단위 보안)가 지키는 규칙이에요. 폴더 구성원이 아니면 아무것도 보이지 않아요.</small>
      </div>
    </Transition>
    <!-- secure by default: what the app does with people's data, before it is shared -->
    <div v-if="!app.privacyAck && app.role === 'owner'" class="privacy">
      <div class="ph"><Icon name="lock" :size="14" /><b>보안·개인정보 기본값</b></div>
      <ul><li v-for="l in app.privacy" :key="l.text" :class="`k-${l.kind}`">{{ l.text }}</li></ul>
      <div class="pa-acts"><button class="mini press" @click="rulesSheet = true">조정</button><button class="ok press" @click="ackPrivacy">확인했어요</button></div>
    </div>
    <p v-if="note" class="note">{{ note }}</p>
    <PanelEventsBody v-if="isEvents" :app="app" @sheet="openSheet" />
    <p v-else-if="err" class="err">{{ err }}</p>
    <template v-else-if="rows">
      <div class="sum">
        <div v-for="s in summary" :key="s.label" class="cell"><span class="k">{{ s.label }}</span><span class="v">{{ s.value }}<small>{{ s.suffix }}</small></span></div>
      </div>

      <div class="list">
        <template v-for="r in shown" :key="r._id">
          <button class="item press" :class="{ on: editing === r }" @click="open(r)">
            <span class="txt">
              <b>{{ fmt(r[list.title], fieldOf(list.title)) || '(이름 없음)' }}</b>
              <small v-if="sub(r)">{{ sub(r) }}</small>
            </span>
            <span v-if="list.badge && r[list.badge] !== ''" class="badge">{{ r[list.badge] }}</span>
            <span v-if="list.value" class="val">{{ fmt(r[list.value], fieldOf(list.value)) }}<small>{{ list.valueSuffix }}</small></span>
          </button>
        </template>
        <p v-if="!rows.length && editing !== 'new'" class="empty">아직 등록된 항목이 없어요.</p>
        <button v-if="sorted.length > 6" class="all" @click="showAll = !showAll">{{ showAll ? '접기' : `모두 보기 (${sorted.length})` }}</button>
      </div>

      <!-- the form: a new row, or the row being edited -->
      <div v-if="editing" class="form">
        <div class="fh"><b>{{ editing === 'new' ? '새 항목' : fmt(editing[list.title]) }}</b><span v-if="!rowEditable(editing)" class="ro"><Icon name="lock" :size="12" /> 보기 전용</span></div>
        <p v-if="isDb && editing !== 'new' && !rowEditable(editing)" class="deny">이 행은 {{ ruleText('update') }}만 고칠 수 있어요.</p>
        <label v-for="k in def.form" :key="k" class="fld" :class="{ wide: ['longtext'].includes(fieldOf(k).type) }">
          <span>{{ fieldOf(k).label }}<i v-if="fieldOf(k).required">*</i></span>
          <textarea v-if="fieldOf(k).type === 'longtext'" v-model="form[k]" rows="2" :disabled="!fieldEditable(k)" />
          <select v-else-if="fieldOf(k).type === 'person' && isDb" v-model="form[k]" :disabled="!fieldEditable(k)">
            <option value="">선택</option>
            <option v-for="p in people" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <select v-else-if="fieldOf(k).type === 'choice'" v-model="form[k]" :disabled="!fieldEditable(k)">
            <option value="">선택</option>
            <option v-for="c in fieldOf(k).choices" :key="c" :value="c">{{ c }}</option>
          </select>
          <input v-else-if="fieldOf(k).type === 'checkbox'" v-model="form[k]" type="checkbox" :disabled="!fieldEditable(k)">
          <input v-else v-model="form[k]" :type="{ number: 'number', date: 'date', time: 'time', email: 'email', phone: 'tel' }[fieldOf(k).type] || 'text'" :disabled="!fieldEditable(k)" :inputmode="fieldOf(k).type === 'number' ? 'decimal' : undefined">
        </label>
        <div v-if="def.computed.length && editing !== 'new'" class="calc">
          <span v-for="c in def.computed" :key="c.key">{{ c.label }} <b>{{ fmt(editing[c.key]) }}</b></span>
        </div>
        <p v-if="problems" class="err">{{ problems }}</p>
        <div class="acts">
          <button v-if="rowDeletable(editing)" class="ghost danger" @click="removeRow"><Icon name="trash" :size="16" /></button>
          <span class="sp" />
          <button class="ghost" @click="editing = null">닫기</button>
          <button v-if="rowEditable(editing)" class="save" :disabled="saving" @click="save">{{ saving ? '저장 중…' : '저장' }}</button>
        </div>
      </div>

      <div class="foot">
        <button v-if="canAdd && !editing" class="btn press" @click="open('new')"><Icon name="plus" :size="16" /> 추가</button>
        <button class="btn press" :disabled="opening" @click="openSheet">{{ opening ? '여는 중…' : '시트 열기' }}</button>
      </div>
    </template>
    <p v-else-if="!isEvents" class="loading">불러오는 중…</p>

    <Teleport to="body"><PanelRulesSheet v-if="rulesSheet" :app="app" @close="rulesSheet = false" @saved="rulesSheet = false; store.loadPanelApps(); load()" /></Teleport>
    <Teleport to="body"><ShareSheet v-if="share" :folder="share" default-role="editor" @close="closeShare" /></Teleport>
  </div>
</template>

<style scoped>
.pa { border-radius: 24px; padding: 16px; position: relative; color: var(--text-primary); }
.head { display: flex; align-items: center; gap: 10px; margin: 2px 2px 12px 4px; font-size: 16px; position: relative; }
.ico { width: 28px; height: 28px; border-radius: 9999px; display: grid; place-items: center; background: var(--cell-bg); font-size: 15px; }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lock { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; padding: 2px 8px; border-radius: 99px; background: rgba(150 200 255 / .16); color: var(--color-info); }
.lock.on { background: rgba(150 200 255 / .3); }
.rules { background: var(--cell-bg); border-radius: 12px; padding: 10px 12px; margin: -4px 0 10px; font-size: 13px; display: flex; flex-direction: column; gap: 4px; }
.rules span { display: inline-block; min-width: 64px; color: var(--text-secondary); }
.rules .pl { color: var(--color-info); font-size: 12.5px; }
.rules small { color: var(--text-tertiary); font-size: 12px; margin-top: 2px; }
.privacy { background: rgba(150 200 255 / .1); border: 1px solid rgba(150 200 255 / .3); border-radius: 14px; padding: 10px 12px; margin-bottom: 10px; font-size: 13px; }
.privacy .ph { display: flex; align-items: center; gap: 6px; color: var(--color-info); margin-bottom: 4px; }
.privacy ul { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; color: var(--text-primary); }
.privacy li.k-sensitive, .privacy li.k-personal { color: var(--color-info); }
.pa-acts { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.mini { height: 30px; padding: 0 12px; border-radius: 9px; background: var(--button-bg); font-size: 13px; }
.ok { height: 30px; padding: 0 14px; border-radius: 9px; background: var(--ink); color: var(--ink-inverse); font-size: 13px; font-weight: 500; }
.note { font-size: 13px; color: var(--color-success); margin: 0 2px 8px; }
.deny { grid-column: 1 / -1; margin: 0; font-size: 13px; color: var(--color-info); display: flex; gap: 6px; align-items: center; }
.ro { display: inline-flex; align-items: center; gap: 3px; }
.shared { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--text-secondary); padding: 2px 8px; border-radius: 99px; background: var(--cell-bg); }
.more { width: 28px; height: 28px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-secondary); opacity: 0; transition: opacity .2s; }
.pa:hover .more, .more:focus-visible { opacity: 1; }
.menu { position: absolute; right: 0; top: 34px; z-index: 5; border-radius: 16px; padding: 6px; display: flex; flex-direction: column; min-width: 200px; box-shadow: var(--shadow-card); --regular-bg: var(--regular-solid-bg); }
.menu button { text-align: left; padding: 10px 12px; border-radius: 10px; font-size: 14px; }
.menu button:hover { background: var(--cell-bg); }
.danger { color: var(--color-error); }

.sum { display: flex; gap: 6px; margin-bottom: 10px; }
.cell { flex: 1; min-width: 0; background: var(--cell-bg); border-radius: 12px; padding: 9px 12px; display: flex; flex-direction: column; }
.cell .k { font-size: 13px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cell .v { font-size: 22px; letter-spacing: -.02em; }
.cell small, .val small { font-size: 13px; color: var(--text-secondary); margin-left: 2px; }

.list { display: flex; flex-direction: column; gap: 6px; }
.item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: var(--cell-bg); border-radius: 14px; padding: 10px 14px; min-height: 52px; }
.item:hover, .item.on { background: var(--button-bg); }
.txt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.txt b { font-weight: 500; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.txt small { font-size: 13px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { flex: none; font-size: 12px; padding: 2px 8px; border-radius: 8px; background: var(--chip-bg); color: var(--text-primary); }
.val { flex: none; font-size: 20px; letter-spacing: -.02em; }
.empty, .loading { color: var(--text-secondary); font-size: 14px; padding: 8px 4px; margin: 0; }
.all { align-self: center; font-size: 13px; color: var(--text-secondary); padding: 4px 10px; }

.form { margin-top: 8px; background: var(--cell-bg); border-radius: 16px; padding: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
.fh { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; font-size: 15px; }
.ro { font-size: 12px; color: var(--text-secondary); }
.fld { display: flex; flex-direction: column; gap: 3px; min-width: 0; font-size: 12px; color: var(--text-secondary); }
.fld.wide { grid-column: 1 / -1; }
.fld i { color: var(--color-attention); font-style: normal; margin-left: 2px; }
.fld input:not([type=checkbox]), .fld select, .fld textarea { font: inherit; font-size: 15px; color: var(--text-primary); background: var(--field-bg); border: 0; outline: 0; border-radius: 10px; min-height: 36px; padding: 0 10px; width: 100%; }
.fld textarea { padding: 8px 10px; resize: vertical; }
.fld input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--text-primary); }
.fld select option { color: #1d1d1f; }
.calc { grid-column: 1 / -1; display: flex; gap: 12px; font-size: 13px; color: var(--text-secondary); }
.calc b { color: var(--text-primary); font-weight: 600; }
.err { grid-column: 1 / -1; color: var(--color-error); font-size: 13px; margin: 4px 2px; }
.acts { grid-column: 1 / -1; display: flex; gap: 6px; align-items: center; }
.sp { flex: 1; }
.ghost { height: 34px; padding: 0 12px; border-radius: 10px; color: var(--text-secondary); font-size: 14px; display: inline-flex; align-items: center; }
.ghost:hover { background: var(--button-bg); }
.save { height: 34px; padding: 0 16px; border-radius: 10px; background: var(--ink); color: var(--ink-inverse); font-size: 14px; font-weight: 500; }
.save:disabled { opacity: .5; }

.foot { display: flex; gap: 6px; margin-top: 10px; }
.btn { flex: 1; height: 40px; border-radius: 12px; background: var(--button-bg); font-weight: 500; font-size: 15px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.btn:disabled { opacity: .5; }
</style>
