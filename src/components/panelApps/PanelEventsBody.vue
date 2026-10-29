<script setup>
// A record-keeping (event-sourced) panel app: nothing is edited in place. The panel shows the
// projections the server replayed from the log (e.g. 요약: 부여·사용·남은 일수, 신청 현황), offers the
// events this person may add (휴가 신청, 휴가 부여…) and amendments on existing ones (취소), and a
// 기록 view — the whole history. Masked values ('비공개') come masked from the server/database.
import { ref, computed, watch, onMounted } from 'vue'
import Icon from '../Icon.vue'
import { api } from '../../api.js'
import { useApp } from '../../stores/app.js'
import { isEnglish } from '../../i18n/lang.js'

const props = defineProps({ app: Object })
const emit = defineEmits(['sheet'])
const store = useApp()
const data = ref(null)
const err = ref('')
const view = ref('main')      // 'main' | 'history'
const historyOf = ref(null)   // entity id, or null for everyone
const formType = ref(null)    // event type being added
const form = ref({})
const refOf = ref(null)       // the event an amendment points at
const problems = ref('')
const saving = ref(false)
const flash = ref('')
// the action word of an amending event's label: Korean puts it last ("휴가 취소" → 취소, "취소됨"), English
// first ("Cancel leave" → Cancel, "Canceled"); an English label without a known verb first stays whole
const PAST = { cancel: 'Canceled', approve: 'Approved', reject: 'Rejected', correct: 'Corrected', withdraw: 'Withdrawn', revoke: 'Revoked', close: 'Closed', complete: 'Completed', deny: 'Denied', decline: 'Declined', amend: 'Amended' }
const act = (label) => {
  if (!isEnglish) return String(label).replace(/^.*\s/, '')
  const w = String(label).split(/\s+/)[0]
  return PAST[w.toLowerCase()] ? w : label
}
const closedText = (label) => {
  if (!isEnglish) return `${act(label)}됨`
  const k = Object.keys(PAST).find((v) => new RegExp(`\\b${v}`, 'i').test(label))
  return k ? PAST[k] : label
}

const def = computed(() => props.app.def)
// the unit after a number: "days" after 1 reads "day" in English ("1 days")
const unit = (v) => { const u = def.value.views?.valueSuffix || ''; return isEnglish && Number(v) === 1 && /[a-z]s$/i.test(u) ? u.slice(0, -1) : u }
const main = computed(() => def.value.projections.find((p) => p.key === def.value.views.main))
const openProj = computed(() => def.value.projections.find((p) => p.kind === 'open'))
const name = (id) => data.value?.people.find((p) => p.id === id)?.name || id
const fieldOf = (k) => def.value.fields.find((f) => f.key === k)
const typeOf = (t) => def.value.events.find((e) => e.type === t)
const fmt = (v) => (v === null ? '비공개' : typeof v === 'number' ? v.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : v ?? '')
const when = (at) => { const d = new Date(at); return isNaN(d) ? '' : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }

async function load() {
  try { data.value = await api(`/panel-apps/${props.app.id}/rows`); err.value = '' } catch (e) { err.value = e.message }
}
onMounted(load)
watch(() => store.panelAppTick[props.app.id], load)
watch(() => [props.app.people, props.app.def], load) // new members (person choices), changed rules

const addable = computed(() => (data.value?.types || []).filter((t) => !t.ref && (t.self || t.others)))
const entities = computed(() => (main.value ? data.value?.projections[main.value.key] || [] : []))
const openItems = computed(() => (openProj.value ? data.value?.projections[openProj.value.key] || [] : []))
const history = computed(() => [...(data.value?.events || [])].reverse().filter((e) => !historyOf.value || e.entity === historyOf.value))
const amendOf = (e) => (data.value?.events.find((x) => x.id === e.id)?.amend || []).map((t) => typeOf(t))

function startEvent(t, refEvent = null) {
  problems.value = ''
  formType.value = t
  refOf.value = refEvent
  const tt = typeOf(t)
  form.value = Object.fromEntries(tt.fields.map((k) => [k, '']))
  form.value.__entity = refEvent ? refEvent.entity : historyOf.value || data.value.me
}
const canOthers = computed(() => data.value?.types.find((t) => t.type === formType.value)?.others)
async function save() {
  saving.value = true; problems.value = ''
  try {
    const { __entity, ...values } = form.value
    const r = await api(`/panel-apps/${props.app.id}/events`, { method: 'POST', body: { type: formType.value, entity: __entity, ref: refOf.value?.id || null, values } })
    data.value = r
    flash.value = `'${typeOf(formType.value).label}' 기록을 더했어요. 이전 기록은 그대로 남아요.`
    setTimeout(() => (flash.value = ''), 4000)
    formType.value = null; refOf.value = null
  } catch (e) { problems.value = e.message } finally { saving.value = false }
}
function showHistory(entity) { historyOf.value = entity; view.value = 'history'; formType.value = null }
const payload = (e) => typeOf(e.type).fields.concat(typeOf(e.type).ref?.inherit || []).filter((k, i, a) => a.indexOf(k) === i)
  .map((k) => ({ label: fieldOf(k)?.label, v: (e._hidden || []).includes(k) ? '비공개' : fmt(e[k]), hidden: (e._hidden || []).includes(k) })).filter((x) => x.v !== '')
</script>

<template>
  <p v-if="err" class="err">{{ err }}</p>
  <p v-else-if="!data" class="loading">불러오는 중…</p>
  <template v-else>
    <p v-if="flash" class="note">{{ flash }}</p>

    <!-- main: replayed projections -->
    <template v-if="view === 'main'">
      <div v-if="main" class="sum">
        <div v-for="c in [...main.columns, ...main.computed]" :key="c.key" class="cell" :title="data.totals[main.key][c.key] === null ? '3명 이상일 때만 팀 합계를 보여요' : '기록을 다시 계산한 팀 합계'">
          <span class="k">{{ c.label }} 합계</span><span class="v">{{ fmt(data.totals[main.key][c.key]) }}<small v-if="data.totals[main.key][c.key] !== null">{{ unit(data.totals[main.key][c.key]) }}</small></span>
        </div>
      </div>
      <div class="list">
        <button v-for="r in entities" :key="r.entity" class="item press" @click="showHistory(r.entity)">
          <span class="txt">
            <b>{{ name(r.entity) }}{{ r.entity === data.me ? ' (나)' : '' }}</b>
            <small>{{ main.columns.map((c) => `${c.label} ${fmt(r[c.key])}`).join(' · ') }}</small>
          </span>
          <span class="val">{{ fmt(r[def.views.value]) }}<small v-if="r[def.views.value] !== null">{{ unit(r[def.views.value]) }}</small></span>
        </button>
        <p v-if="!entities.length" class="empty">아직 기록이 없어요.</p>
      </div>
      <template v-if="openProj && openItems.length">
        <div class="sec">{{ openProj.label }}</div>
        <div class="list">
          <div v-for="e in openItems" :key="e.id" class="item">
            <span class="txt"><b>{{ name(e.entity) }}</b><small>{{ payload(e).map((x) => x.v).join(' · ') }}</small></span>
            <button v-for="t in amendOf(e)" :key="t.type" class="mini press" @click="startEvent(t.type, e)">{{ act(t.label) }}</button>
          </div>
        </div>
      </template>
    </template>

    <!-- 기록: the history (append-only) -->
    <template v-else>
      <div class="hhead">
        <button class="mini press" @click="view = 'main'; historyOf = null"><Icon name="back" :size="13" /> 돌아가기</button>
        <b>{{ historyOf ? `${name(historyOf)}의 기록` : '모든 기록' }}</b><small>{{ history.length }}개 · 고치지 않고 쌓여요</small>
      </div>
      <div class="hist scroll">
        <div v-for="e in history" :key="e.id" class="ev" :class="{ off: e.closedBy }">
          <div class="evh">
            <span class="tag" :class="typeOf(e.type).ref ? 'amend' : ''">{{ typeOf(e.type).label }}</span>
            <b>{{ name(e.entity) }}</b>
            <span v-if="e.closedBy" class="closed">{{ closedText(e.closedBy.label) }}</span>
          </div>
          <small class="meta">{{ when(e.at) }} · {{ name(e.by) }} 기록</small>
          <div class="evb">
            <span v-for="x in payload(e)" :key="x.label" :class="{ masked: x.hidden }"><i>{{ x.label }}</i> {{ x.v }}<Icon v-if="x.hidden" name="lock" :size="11" /></span>
            <button v-for="t in amendOf(e)" :key="t.type" class="mini press" @click="startEvent(t.type, e)">{{ t.label }}</button>
          </div>
        </div>
        <p v-if="!history.length" class="empty">기록이 없어요.</p>
      </div>
    </template>

    <!-- the form of one event -->
    <div v-if="formType" class="form">
      <div class="fh"><b>{{ typeOf(formType).label }}</b><small v-if="refOf">대상: {{ typeOf(refOf.type).label }} · {{ name(refOf.entity) }} · {{ when(refOf.at) }}</small></div>
      <label v-if="!refOf" class="fld">
        <span>{{ def.entity.label }}<i>*</i></span>
        <select v-model="form.__entity" :disabled="!canOthers">
          <option v-for="p in data.people" :key="p.id" :value="p.id">{{ p.name }}{{ p.id === data.me ? ' (나)' : '' }}</option>
        </select>
      </label>
      <label v-for="k in typeOf(formType).fields" :key="k" class="fld" :class="{ wide: fieldOf(k).type === 'longtext' }">
        <span>{{ fieldOf(k).label }}<i v-if="typeOf(formType).required.includes(k)">*</i><Icon v-if="['personal', 'sensitive'].includes(fieldOf(k).sensitivity)" name="lock" :size="11" /></span>
        <textarea v-if="fieldOf(k).type === 'longtext'" v-model="form[k]" rows="2" />
        <select v-else-if="fieldOf(k).type === 'choice'" v-model="form[k]"><option value="">선택</option><option v-for="c in fieldOf(k).choices" :key="c" :value="c">{{ c }}</option></select>
        <input v-else v-model="form[k]" :type="{ number: 'number', date: 'date', time: 'time' }[fieldOf(k).type] || 'text'">
      </label>
      <p v-if="refOf" class="hint">원래 기록은 지워지지 않고, 이 기록이 그것을 {{ typeOf(formType).ref?.mode === 'close' ? '처리' : '취소' }}해요.</p>
      <p v-if="problems" class="err">{{ problems }}</p>
      <div class="acts"><span class="sp" /><button class="ghost" @click="formType = null; refOf = null">닫기</button><button class="save" :disabled="saving" @click="save">{{ saving ? '기록 중…' : '기록하기' }}</button></div>
    </div>

    <div class="foot">
      <button v-for="t in addable" v-show="!formType" :key="t.type" class="btn press" @click="startEvent(t.type)"><Icon name="plus" :size="15" /> {{ t.label }}</button>
    </div>
    <div class="foot">
      <button class="btn press" @click="showHistory(null)">기록</button>
      <button class="btn press" @click="emit('sheet')">시트 열기</button>
    </div>
  </template>
</template>

<style scoped>
.sum { display: flex; gap: 6px; margin-bottom: 10px; }
.cell { flex: 1; min-width: 0; background: var(--cell-bg); border-radius: 12px; padding: 9px 12px; display: flex; flex-direction: column; container-type: inline-size; }
.cell .k { font-size: 13px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* a big amount (105,756,000원) shrinks with its tile and wraps rather than running into the next one */
.cell .v { font-size: clamp(13px, 12.5cqi, 22px); line-height: 1.2; letter-spacing: -.02em; overflow-wrap: anywhere; min-width: 0; }
.cell small, .val small { font-size: 13px; color: var(--text-secondary); margin-left: 2px; }
.list { display: flex; flex-direction: column; gap: 6px; }
.item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: var(--cell-bg); border-radius: 14px; padding: 10px 14px; min-height: 52px; }
button.item:hover { background: var(--button-bg); }
.txt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.txt b { font-weight: 500; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.txt small { font-size: 13px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.val { flex: none; font-size: 20px; letter-spacing: -.02em; }
.sec { font-size: 13px; color: var(--text-secondary); margin: 12px 4px 6px; }
.mini { flex: none; height: 28px; padding: 0 10px; border-radius: 9px; background: var(--button-bg); font-size: 13px; display: inline-flex; align-items: center; gap: 4px; }
.empty, .loading { color: var(--text-secondary); font-size: 14px; padding: 8px 4px; margin: 0; }
.note { font-size: 13px; color: var(--color-success); margin: 0 2px 8px; }
.err { color: var(--color-error); font-size: 13px; margin: 4px 2px; grid-column: 1 / -1; }
.hhead { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 15px; }
.hhead small { color: var(--text-secondary); font-size: 12px; }
.hist { display: flex; flex-direction: column; gap: 6px; max-height: 360px; overflow-y: auto; }
.ev { background: var(--cell-bg); border-radius: 12px; padding: 8px 12px; font-size: 13px; }
.ev.off { opacity: .55; }
.evh { display: flex; align-items: center; gap: 6px; }
.evh b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.meta { display: block; color: var(--text-tertiary); font-size: 11.5px; margin-top: 2px; }
.tag { white-space: nowrap; flex: none; font-size: 12px; padding: 1px 7px; border-radius: 7px; background: var(--chip-bg); }
.tag.amend { background: rgba(255 160 120 / .2); }
.closed { white-space: nowrap; flex: none; font-size: 11.5px; color: var(--color-attention); }
.evb { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; color: var(--text-secondary); align-items: center; }
.evb i { font-style: normal; color: var(--text-tertiary); }
.evb .masked { color: var(--color-info); display: inline-flex; gap: 3px; align-items: center; }
.sp { flex: 1; }
.form { margin-top: 8px; background: var(--cell-bg); border-radius: 16px; padding: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
.fh { grid-column: 1 / -1; display: flex; flex-direction: column; font-size: 15px; }
.fh small { font-size: 12px; color: var(--text-secondary); }
.fld { display: flex; flex-direction: column; gap: 3px; min-width: 0; font-size: 12px; color: var(--text-secondary); }
.fld span { display: inline-flex; align-items: center; gap: 3px; }
.fld.wide { grid-column: 1 / -1; }
.fld i { color: var(--color-attention); font-style: normal; }
.fld input, .fld select, .fld textarea { font: inherit; font-size: 15px; color: var(--text-primary); background: var(--field-bg); border: 0; outline: 0; border-radius: 10px; min-height: 36px; padding: 0 10px; width: 100%; }
.fld textarea { padding: 8px 10px; resize: vertical; }
.fld select option { color: #1d1d1f; }
.hint { grid-column: 1 / -1; font-size: 12px; color: var(--text-secondary); margin: 0; }
.acts { grid-column: 1 / -1; display: flex; gap: 6px; align-items: center; }
.ghost { height: 34px; padding: 0 12px; border-radius: 10px; color: var(--text-secondary); font-size: 14px; }
.save { height: 34px; padding: 0 16px; border-radius: 10px; background: var(--ink); color: var(--ink-inverse); font-size: 14px; font-weight: 500; }
.foot { display: flex; gap: 6px; margin-top: 8px; }
.btn { flex: 1; height: 40px; border-radius: 12px; background: var(--button-bg); font-weight: 500; font-size: 14.5px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; white-space: nowrap; }
</style>
