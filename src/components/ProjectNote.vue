<script setup>
// 프로젝트 계획(server lib/projectNote.js, 설계 turnplan §4.3): 이 프로젝트의 목적 · 만들 것 · 쓰는 도구 · 지킬 것 · 정한 것. 이 프로젝트의 모든 대화 —
// 규칙 실행 · 에이전트 · 브라우저 작업 · 하위 대화 — 가 먼저 읽는다(2026-11-27 녹화: 「클로드MD처럼 … 마스터 플랜 같은」). 방 맨 위의 칩이 시트를
// 연다(휴대폰은 아래 시트). 사람이 고치거나 더한 항목은 「고정」되어 AI 가 계획을 고칠 때도 그대로 남는다. 방의 주인만 보고 고친다
// (사용자 결정 11-25) — 다른 사람에게는 GET 이 404 이라 칩이 없다.
// 「바뀐 기록」(2026-11-27 사용자: 「중간중간 방향을 개선하거나 수정한 내용 등이 이 파일에 관리되어야 한다」): 계획이 바뀔 때마다 한 줄 — 언제 · 누가 ·
// 무엇이 · 어느 메시지에서. 줄마다 「되돌리기」(POST /threads/:id/note/revert {noteId}), 되돌린 것도 한 줄로 남는다.
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import Icon from './Icon.vue'

const props = defineProps({ thread: String })
const app = useApp()
const EMPTY = { intent: '', deliverables: [], tools: [], constraints: [], decisions: [] }
const LISTS = [
  { key: 'deliverables', label: '만들 것', hint: '이 방에서 늘 만드는 것', max: 5, n: 80 },
  { key: 'constraints', label: '지킬 것', hint: '일하는 방법 · 조건 · 예외', max: 6, n: 120 },
  { key: 'decisions', label: '정한 것', hint: '이 방에서 정한 것', max: 6, n: 120 },
]
const copy = (n) => JSON.parse(JSON.stringify({ ...EMPTY, ...(n || {}) }))
// what the person can change, for comparing (the server marks what changed as pinned)
const shape = (n) => JSON.stringify({ intent: (n?.intent || '').trim(), deliverables: (n?.deliverables || []).map((x) => x.text.trim()).filter(Boolean),
  tools: (n?.tools || []).map((t) => [t.name.trim(), t.ref || '', (t.how || '').trim()]).filter((t) => t[0]),
  constraints: (n?.constraints || []).map((x) => x.text.trim()).filter(Boolean), decisions: (n?.decisions || []).map((x) => x.text.trim()).filter(Boolean) })

const data = ref(null) // GET /threads/:id/note → {note, id, at, skills: [{name, label}], history: [{id, at, kind, by, text, from, reverted, revertable}]}
const draft = ref(null)
// the plan the draft was taken from (its row id and its content): the save sends it, and the server puts only the person's own changes onto
// a newer plan (review PR #105 #4 — an update, 계획에 넣기 or a revert that came meanwhile is not taken out)
const base = ref({ id: null, note: null })
const take = (got) => { draft.value = copy(got?.note); base.value = { id: got?.id || null, note: got?.note || null } }
const notice = ref('')
const saving = ref(false)
const err = ref('')
const savedAt = ref(0)
const open = computed(() => !!props.thread && app.planOpen === props.thread)
const dirty = computed(() => !!draft.value && shape(draft.value) !== shape(base.value.note))
const note = computed(() => data.value?.note || EMPTY)
const empty = computed(() => !note.value.intent && LISTS.every((l) => !note.value[l.key]?.length) && !note.value.tools?.length)
const skillName = (ref0) => data.value?.skills?.find((s) => s.name === ref0)?.label || ref0

async function load() {
  const thread = props.thread
  if (!thread) return
  let got = null
  try { got = await api(`/threads/${thread}/note`) } catch { got = null }
  // (a late answer for the project on screen before: never shown — nor saved — in this one: review PR #105 #10)
  if (props.thread !== thread) return
  // (the sheet follows a change that came meanwhile — unless the person has edits of their own in it)
  const clean = !dirty.value
  data.value = got
  if (open.value && clean) take(got)
}
// (the server says when the plan changed — an automatic update, 계획에 넣기, an undo: lib/projectNote.js emits projectNote)
watch(() => [props.thread, app.planTick[props.thread] || 0], load, { immediate: true })
// another project on screen: nothing of this one's is kept
watch(() => props.thread, () => { data.value = null; draft.value = null; base.value = { id: null, note: null }; err.value = ''; notice.value = '' })
watch(open, (o) => {
  if (!o) return
  take(data.value)
  err.value = ''
  notice.value = ''
  savedAt.value = 0
  load()
})
function close() { if (app.planOpen === props.thread) app.planOpen = null }
const onKey = (e) => { if (e.key === 'Escape' && open.value) close() }
watch(open, (o) => (o ? window.addEventListener('keydown', onKey) : window.removeEventListener('keydown', onKey)))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const add = (key) => draft.value[key].push({ text: '' })
const addTool = () => draft.value.tools.push({ name: '', kind: 'service', ref: '', how: '' })
const drop = (key, i) => draft.value[key].splice(i, 1)
const when = (at) => new Date(at).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const reverting = ref('')
async function revert(h) {
  if (dirty.value) { err.value = '고친 내용을 먼저 저장하거나 닫은 뒤에 되돌려 주세요'; return }
  reverting.value = h.id
  err.value = ''
  try {
    const r = await api(`/threads/${props.thread}/note/revert`, { method: 'POST', body: { noteId: h.id } })
    data.value = { ...(data.value || {}), note: r.note, id: r.id, history: r.history }
    take(data.value)
  } catch (e) { err.value = e.message || '되돌리지 못했어요' } finally { reverting.value = '' }
}
async function save() {
  const thread = props.thread
  saving.value = true
  err.value = ''
  notice.value = ''
  try {
    const d = draft.value
    const body = { intent: d.intent, deliverables: d.deliverables.filter((x) => x.text.trim()), constraints: d.constraints.filter((x) => x.text.trim()),
      decisions: d.decisions.filter((x) => x.text.trim()), tools: d.tools.filter((t) => t.name.trim()).map((t) => ({ ...t, kind: t.ref ? 'browser_skill' : t.kind === 'browser_skill' ? 'service' : t.kind })) }
    const r = await api(`/threads/${thread}/note`, { method: 'PUT', body: { note: body, baseId: base.value.id } })
    if (props.thread !== thread) return
    data.value = { ...(data.value || {}), note: r.note, id: r.id, at: r.at, ...(r.history ? { history: r.history } : {}) }
    take(data.value)
    savedAt.value = Date.now()
    if (r.merged) notice.value = '그사이 바뀐 계획에 내가 고친 것만 더했어요'
  } catch (e) {
    err.value = e.message || '저장하지 못했어요'
    // (its base left the history: the plan as it is now is loaded — the person makes the edit again on it)
    if (e.status === 409) { data.value = null; base.value = { id: null, note: null }; draft.value = null; await load(); take(data.value) }
  } finally { saving.value = false }
}
</script>

<template>
  <div v-if="data" class="plan-row">
    <button class="plan-chip glass-thin press" data-testid="project-plan-chip" :aria-expanded="open" aria-haspopup="dialog" @click="app.planOpen = open ? null : thread">
      <Icon name="plan" :size="15" /><b>프로젝트 계획</b>
      <span v-if="note.intent" class="pi" data-no-i18n>{{ note.intent }}</span>
      <span v-else-if="empty" class="pi muted">아직 비어 있어요</span>
    </button>
  </div>
  <Teleport to="body">
    <div v-if="open && draft" class="veil" data-testid="project-plan-veil" @click.self="close">
      <div class="sheet glass blur-in" role="dialog" aria-label="프로젝트 계획" data-testid="project-plan-sheet">
        <header>
          <div>
            <h2 class="serif">프로젝트 계획</h2>
            <p class="lead">이 프로젝트의 모든 대화가 먼저 읽어요</p>
          </div>
          <button class="x press" aria-label="닫기" data-testid="plan-close" @click="close"><Icon name="close" :size="18" /></button>
        </header>
        <div class="body scroll">
          <section>
            <h4>목적 <small v-if="draft.intentPinned" class="pin" data-testid="plan-pinned">고정</small></h4>
            <textarea v-model="draft.intent" data-testid="plan-intent" rows="3" maxlength="200" placeholder="이 프로젝트에서 하는 일" data-no-i18n />
          </section>
          <section data-testid="plan-tools">
            <h4>쓰는 도구 <small class="hint">서비스 · 사이트 · 앱과 쓰는 방법</small></h4>
            <div v-for="(t, i) in draft.tools" :key="'t' + i" class="tool" data-testid="plan-tool">
              <div class="trow">
                <input v-model="t.name" class="tname" maxlength="60" placeholder="이름" data-testid="plan-tool-name" data-no-i18n>
                <select v-model="t.ref" class="tref" data-testid="plan-tool-skill" aria-label="서버 브라우저 스킬">
                  <option value="">스킬 없음</option>
                  <option v-for="s in data.skills" :key="s.name" :value="s.name">서버 브라우저: {{ s.label }}</option>
                </select>
                <small v-if="t.pinned" class="pin" data-testid="plan-pinned">고정</small>
                <button class="rm press" aria-label="빼기" data-testid="plan-remove" @click="drop('tools', i)"><Icon name="close" :size="14" /></button>
              </div>
              <input v-model="t.how" maxlength="120" placeholder="이 방에서 쓰는 방법" data-testid="plan-tool-how" data-no-i18n>
            </div>
            <button v-if="draft.tools.length < 8" class="add press" data-testid="plan-add-tools" @click="addTool"><Icon name="plus" :size="14" /> 추가</button>
          </section>
          <section v-for="l in LISTS" :key="l.key" :data-testid="`plan-${l.key}`">
            <h4>{{ l.label }} <small class="hint">{{ l.hint }}</small></h4>
            <div v-for="(x, i) in draft[l.key]" :key="l.key + i" class="item" data-testid="plan-item">
              <input v-model="x.text" :maxlength="l.n" data-testid="plan-item-text" data-no-i18n>
              <small v-if="x.pinned" class="pin" data-testid="plan-pinned">고정</small>
              <button class="rm press" aria-label="빼기" data-testid="plan-remove" @click="drop(l.key, i)"><Icon name="close" :size="14" /></button>
            </div>
            <button v-if="draft[l.key].length < l.max" class="add press" :data-testid="`plan-add-${l.key}`" @click="add(l.key)"><Icon name="plus" :size="14" /> 추가</button>
          </section>
          <p class="foot-note">고친 항목은 고정돼요. AI가 대화를 읽고 계획을 고쳐도 그대로 남아요.</p>
          <section v-if="data.history?.length" data-testid="plan-history">
            <h4>바뀐 기록 <small class="hint">언제 · 무엇이 · 어느 메시지에서 바뀌었는지</small></h4>
            <ol class="hist">
              <li v-for="h in data.history" :key="h.id" data-testid="plan-history-item" :data-kind="h.kind" :class="{ reverted: h.reverted }">
                <div class="hh"><span class="who" :class="h.by">{{ h.by === 'person' ? '나' : 'AI' }}</span><time :datetime="h.at">{{ when(h.at) }}</time>
                  <button v-if="h.revertable" class="hrev press" :disabled="!!reverting" data-testid="plan-history-revert" @click="revert(h)">되돌리기</button>
                  <small v-else-if="h.reverted" class="hdone" data-testid="plan-history-reverted">되돌렸어요</small>
                </div>
                <p class="ht" data-testid="plan-history-text" data-no-i18n>{{ h.text }}</p>
                <p v-if="h.from?.text" class="hf" data-testid="plan-history-from"><span>보낸 메시지</span> <q data-no-i18n>{{ h.from.text }}</q></p>
              </li>
            </ol>
          </section>
        </div>
        <footer>
          <small v-if="err" class="err" role="alert" data-testid="plan-error">{{ err }}</small>
          <small v-else-if="notice" class="ok" data-testid="plan-merged">{{ notice }}</small>
          <small v-else-if="savedAt && !dirty" class="ok" data-testid="plan-saved">저장했어요</small>
          <button class="save press" :disabled="saving || !dirty" data-testid="plan-save" @click="save">{{ saving ? '저장 중이에요' : '저장' }}</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.plan-row { display: flex; margin: -2px 0 4px; min-width: 0; }
.plan-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; height: 34px; padding: 0 14px 0 11px; border-radius: 17px; font-size: 13px; color: var(--text-primary); }
.plan-chip b { font-weight: 600; flex: none; }
.plan-chip .pi { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.plan-chip .pi::before { content: '·'; margin-right: 6px; color: var(--text-tertiary); }
.plan-chip .muted { color: var(--text-tertiary); }
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .28); display: grid; place-items: center; padding: 16px; }
.sheet { width: min(600px, 100%); min-width: 0; box-sizing: border-box; max-height: min(86vh, 860px); max-height: min(86dvh, 860px); border-radius: 28px; padding: 20px 22px 16px; display: flex; flex-direction: column; gap: 8px;
  background: var(--regular-solid-bg, var(--bubble-agent-bg)); box-shadow: var(--shadow-card); color: var(--text-primary); }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
header > div { min-width: 0; }
h2 { margin: 0; font-size: 24px; font-weight: 400; }
.lead { margin: 4px 0 0; font-size: 13.5px; color: var(--text-secondary); }
.x { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--field-bg); flex: none; color: var(--text-primary); }
.body { overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 2px; border-top: 1px solid var(--hairline); }
section { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; }
h4 { margin: 0; font-size: 12.5px; font-weight: 600; color: var(--text-secondary); display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.hint { font-weight: 400; color: var(--text-tertiary); }
textarea, input, select { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--hairline); border-radius: 12px; background: var(--field-bg); color: var(--text-primary);
  font: inherit; font-size: 14px; padding: 8px 11px; }
textarea { resize: vertical; line-height: 1.45; }
select { height: 36px; padding: 0 8px; }
.item, .trow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.item input { flex: 1; }
.tool { display: flex; flex-direction: column; gap: 5px; padding: 8px; border-radius: 14px; background: var(--cell-bg); }
.tname { flex: 1 1 40%; }
.tref { flex: 1 1 45%; }
.pin { flex: none; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 9999px; background: var(--chip-bg, var(--field-bg)); color: var(--text-secondary); }
.rm { flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; color: var(--text-secondary); }
.add { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 12px; border-radius: 15px; background: var(--button-bg, var(--field-bg)); color: var(--text-primary); font-size: 13px; }
.foot-note { margin: 2px 0 0; font-size: 12px; color: var(--text-tertiary); line-height: 1.45; }
.hist { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.hist li { padding: 8px 10px; border-radius: 12px; background: var(--cell-bg); display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.hist li.reverted .ht { text-decoration: line-through; color: var(--text-tertiary); }
.hh { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-tertiary); }
.who { font-weight: 600; color: var(--text-secondary); }
.who.person { color: var(--text-primary); }
.hrev { margin-left: auto; height: 26px; padding: 0 10px; border-radius: 13px; background: var(--button-bg, var(--field-bg)); color: var(--text-primary); font-size: 12px; }
.hrev:disabled { opacity: .5; }
.hdone { margin-left: auto; }
.ht { margin: 0; font-size: 13.5px; line-height: 1.4; overflow-wrap: anywhere; }
.hf { margin: 0; font-size: 12px; color: var(--text-tertiary); line-height: 1.4; overflow-wrap: anywhere; }
.hf q { color: var(--text-secondary); }
footer { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding-top: 8px; border-top: 1px solid var(--hairline); }
.save { height: 38px; padding: 0 20px; border-radius: 19px; background: var(--text-primary); color: var(--ink-inverse, #fff); font-size: 14px; font-weight: 600; }
.save:disabled { opacity: .4; }
.ok { color: var(--color-success); font-size: 12.5px; }
.err { color: var(--color-error); font-size: 12.5px; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .veil { place-items: end stretch; padding: 0; }
  .sheet { width: 100%; max-height: 88vh; max-height: 88dvh; border-radius: 26px 26px 0 0; padding: 18px 16px calc(14px + env(safe-area-inset-bottom, 0px)); }
  h2 { font-size: 21px; }
}
</style>
