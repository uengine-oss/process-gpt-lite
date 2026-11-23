<script>
// shared with ProcessDraftCard: who may 적용 (one status call for every card on the page) and a plan's Flow drawn for MapGraph
import { flowView } from './mapView.js'
import { api } from '../../api.js'

let adminP = null
// true · false, or null when not known (the plan's canApply decides then)
export function adminOnce() {
  adminP ||= api('/ontology/status').then((s) => !!s?.admin).catch(() => { adminP = null; return null })
  return adminP
}

// a plan's before / after as MapGraph draws it (no map here: counts are the Flow's own)
export const planGraph = (flow) => flowView(flow)
</script>

<script setup>
// 말로 프로세스 지도 고치기(채팅 «○○ 프로세스에서 … 바꿔 줘»): 서버가 남긴 카드. 서버가 내용을 고쳐 'message' 이벤트로 다시 보내므로
// 내용대로 그린다 — ask(어느 프로세스인지 고르기) · preview(고친 뒤 그림 · 바뀌는 것 · 되묻는 것 · 적용 / 의견으로 남기기) ·
// applied · voiced · stopped · failed. 적용은 관리자만, 의견은 누구나(plan.canVoice).
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { narrow } from '../../viewport.js'
import MapGraph from './MapGraph.vue'
import OntoChangeList from './OntoChangeList.vue'

const props = defineProps({ msg: Object })
const router = useRouter()
// what a POST answered with, until the message itself comes back changed
const over = ref(null)
watch(() => props.msg.content, () => { over.value = null })
const c = computed(() => over.value || props.msg.content || {})
const plan = computed(() => c.value.plan || null)
const state = computed(() => c.value.state || (plan.value ? 'preview' : 'ask'))
const busy = ref('')
const err = ref('')
const answer = ref('')
const admin = ref(null)
adminOnce().then((a) => { admin.value = a })

// a new process from words (an applied one without its plan: the server made a said process and none was asked for)
const isNew = computed(() => plan.value?.scope === 'new' || (!plan.value && !c.value.proc && !!c.value.applied?.said))
const proc = computed(() => c.value.applied?.proc || plan.value?.proc || c.value.proc || null)
const title = computed(() => (isNew.value ? plan.value?.name || c.value.applied?.proc?.name || '' : proc.value?.name || ''))
const ops = computed(() => plan.value?.ops || [])
const canApply = computed(() => !!plan.value && plan.value.canApply !== false && admin.value !== false && ops.value.length > 0)
const whyNot = computed(() => {
  if (canApply.value || !plan.value) return ''
  if (plan.value.whyNot) return plan.value.whyNot
  if (admin.value === false) return '적용은 관리자만 할 수 있어요 — 의견으로 남길 수 있어요'
  return ops.value.length ? '' : '지도에서 바꿀 것이 없어요.'
})
const range = computed(() => (plan.value?.scope === 'range' ? plan.value.range?.tasks || [] : []))
const agree = computed(() => Number(c.value.agree ?? c.value.opinion?.agree ?? c.value.voiced?.agree ?? 0))
const appliedList = computed(() => c.value.applied?.applied || [])
const appliedRefused = computed(() => c.value.applied?.refused || [])

// 고치기 전 · 고친 뒤
const side = ref('after')
watch(plan, (p) => { if (!p?.before) side.value = 'after' })
const graph = computed(() => planGraph(side.value === 'before' ? plan.value?.before : plan.value?.after))
// MapGraph fits the drawing (whole) once it is on the page
const fit = ref(false)
const fitSoon = () => nextTick(() => { fit.value = true })
// a wheel over the small map scrolls the chat (a pinch still zooms it)
const passWheel = (e) => { if (!e.ctrlKey) e.stopPropagation() }

// the server answers a chat step with the card's new content
const contentOf = (r) => (r?.content?.state ? r.content : r?.state ? r : null)
async function chat(body, key) {
  busy.value = key; err.value = ''
  try {
    const r = await api(`/ontology/edit/chat/${encodeURIComponent(props.msg.id)}`, { method: 'POST', body })
    const v = contentOf(r)
    if (v) over.value = v
    else if (body.action === 'stop') over.value = { ...c.value, state: 'stopped' }
    return true
  } catch (e) { err.value = e.message; return false } finally { busy.value = '' }
}
const pick = (k) => chat({ proc: k }, `proc:${k}`)
async function reply() {
  const a = answer.value.trim()
  if (!a) return
  if (await chat({ answer: a }, 'answer')) answer.value = ''
}
const stop = () => chat({ action: 'stop' }, 'stop')

async function apply() {
  const p = plan.value
  busy.value = 'apply'; err.value = ''
  try {
    const r = await api('/ontology/edit/apply', { method: 'POST', body: { proc: p.proc?.key || undefined, scope: p.range || undefined, words: p.words ?? c.value.words, ops: p.ops, messageId: props.msg.id } })
    over.value = { ...c.value, state: 'applied', applied: r }
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function voice() {
  const p = plan.value
  busy.value = 'voice'; err.value = ''
  try {
    const r = await api('/ontology/opinions', { method: 'POST', body: { proc: p.proc?.key || c.value.proc?.key, scope: p.range || undefined, words: p.words ?? c.value.words, ops: p.ops || [], source: 'chat', messageId: props.msg.id } })
    over.value = { ...c.value, state: 'voiced', opinion: r?.opinion || null, agree: r?.agree ?? r?.opinion?.agree ?? 0 }
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const openMap = () => { if (proc.value?.key) router.push(`/process-map?proc=${encodeURIComponent(proc.value.key)}`) }
const planning = computed(() => busy.value === 'answer' || busy.value.startsWith('proc:') || ['planning', 'pending'].includes(state.value))
</script>

<template>
  <div class="oec" data-testid="onto-edit-card" :data-state="state" :data-proc="proc?.key || ''">
    <div class="hd">
      <span class="badge">{{ isNew ? '말로 새 프로세스' : '말로 고치기' }}</span>
      <b v-if="title" class="nm">{{ title }}</b>
    </div>

    <p v-if="planning" class="pend pulse" data-testid="onto-edit-pending">말을 지도로 옮기는 중…</p>

    <!-- 어느 프로세스인지 -->
    <template v-else-if="state === 'ask'">
      <p class="q">어느 프로세스를 고칠까요?</p>
      <div class="opts">
        <button v-for="o in c.choices || []" :key="o.key" class="opt press" :disabled="!!busy" data-testid="onto-edit-choice" :data-proc="o.key" @click="pick(o.key)">{{ o.name || o.key }}</button>
      </div>
      <div class="btns"><button class="ghost press" :disabled="!!busy" data-testid="onto-edit-stop" @click="stop">그만두기</button></div>
    </template>

    <!-- 고친 뒤 그림 -->
    <template v-else-if="state === 'preview' && plan">
      <small v-if="range.length" class="rg">고른 범위 안에서만 고쳐요 · {{ range.join(' · ') }}</small>
      <div v-if="plan.before" class="seg" role="group" aria-label="고치기 전 · 고친 뒤">
        <button :class="{ on: side === 'before' }" data-testid="onto-edit-before" @click="side = 'before'">고치기 전</button>
        <button :class="{ on: side === 'after' }" data-testid="onto-edit-after" @click="side = 'after'">고친 뒤</button>
      </div>
      <div v-if="graph.tasks.length" class="mini" data-testid="onto-edit-map" :data-side="side" @wheel.capture="passWheel">
        <MapGraph :tasks="graph.tasks" :edges="graph.edges" :entries="graph.entries" :dir="narrow ? 'TB' : 'LR'" :whole="fit" @vue:mounted="fitSoon" @vue:unmounted="fit = false" />
      </div>
      <OntoChangeList :plan="plan" />
      <form v-if="plan.question" class="ans" @submit.prevent="reply">
        <input v-model="answer" class="in" maxlength="300" placeholder="답을 적어 주세요" data-testid="onto-edit-answer" />
        <button class="ghost press" type="submit" :disabled="!!busy || !answer.trim()" data-testid="onto-edit-answer-send">답하기</button>
      </form>
      <div class="btns">
        <button class="go press" :disabled="!!busy || !canApply" :title="whyNot" data-testid="onto-edit-apply" @click="apply">{{ busy === 'apply' ? '적용하는 중…' : '적용' }}</button>
        <button v-if="plan.canVoice" class="pill press" :disabled="!!busy" data-testid="onto-edit-voice" @click="voice">{{ busy === 'voice' ? '남기는 중…' : '의견으로 남기기' }}</button>
        <button v-if="proc?.key" class="lk press" data-testid="onto-edit-open" @click="openMap">지도에서 보기</button>
        <span class="sp" />
        <button class="ghost press" :disabled="!!busy" data-testid="onto-edit-stop" @click="stop">그만두기</button>
      </div>
      <small v-if="whyNot" class="why" data-testid="onto-edit-whynot">{{ whyNot }}</small>
    </template>

    <template v-else-if="state === 'applied'">
      <p class="ok" data-testid="onto-edit-applied">{{ isNew ? '지도에 넣었어요 · 제안 단계로 시작해요' : '지도에 고쳐 넣었어요' }}</p>
      <ul v-if="appliedList.length" class="done"><li v-for="a in appliedList" :key="a.id || a.label">{{ a.label }}</li></ul>
      <small v-if="appliedRefused.length" class="why">하지 않은 것 · {{ appliedRefused.map((r) => r.why ? `${r.label}(${r.why})` : r.label).join(' · ') }}</small>
      <div class="btns"><button v-if="proc?.key" class="lk press" data-testid="onto-edit-open" @click="openMap">지도에서 보기</button></div>
    </template>

    <template v-else-if="state === 'voiced'">
      <p class="ok" data-testid="onto-edit-voiced">의견으로 남겼어요 — 관리자가 정하면 알려 드려요</p>
      <small v-if="agree > 1" class="agree" data-testid="onto-edit-agree">같은 의견 {{ agree }}명</small>
      <div class="btns"><button v-if="proc?.key" class="lk press" data-testid="onto-edit-open" @click="openMap">지도에서 보기</button></div>
    </template>

    <p v-else-if="state === 'stopped'" class="res" data-testid="onto-edit-stopped">그만뒀어요. 지도는 그대로예요.</p>

    <template v-else-if="state === 'failed'">
      <p class="res" data-testid="onto-edit-failed">말을 지도로 옮기지 못했어요.</p>
      <small v-if="c.error" class="err">{{ c.error }}</small>
    </template>

    <small v-if="err" class="err" data-testid="onto-edit-error">{{ err }}</small>
  </div>
</template>

<style scoped>
.oec { word-break: keep-all; overflow-wrap: anywhere; width: 424px; max-width: 100%; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: 24px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); min-width: 0; }
.hd { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.badge { flex: none; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.nm { font-size: 16px; font-weight: 600; line-height: 1.4; min-width: 0; }
.q { margin: 0; font-size: 15.5px; line-height: 1.55; }
.pend { margin: 0; padding: 10px 12px; border-radius: 14px; background: var(--field-bg); font-size: 13.5px; color: var(--text-secondary); }
.opts { display: flex; flex-direction: column; gap: 6px; }
.opt { min-height: 40px; padding: 0 14px; border-radius: 14px; background: var(--field-bg); text-align: left; font-size: 14.5px; font-weight: 500; }
.opt:disabled { opacity: .55; }
.rg { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.seg { align-self: flex-start; display: inline-flex; padding: 2px; border-radius: 9999px; background: var(--field-bg); }
.seg button { height: 26px; padding: 0 12px; border-radius: 9999px; font-size: 12px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.mini { position: relative; height: 220px; border-radius: 16px; background: var(--field-bg); overflow: hidden; }
.ans { display: flex; gap: 6px; }
.in { flex: 1; min-width: 0; height: 34px; padding: 0 12px; border-radius: 12px; border: 0; outline: 0; background: var(--field-bg); font-size: 13.5px; color: var(--text-primary); }
.in::placeholder { color: var(--text-tertiary); }
.btns { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sp { flex: 1; }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); white-space: nowrap; }
.pill { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; font-weight: 500; background: var(--field-bg); color: var(--text-primary); white-space: nowrap; }
.ghost { height: 34px; padding: 0 12px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); white-space: nowrap; }
.go:disabled, .pill:disabled, .ghost:disabled { opacity: .45; cursor: default; }
.lk { font-size: 13px; font-weight: 500; color: var(--color-info); }
.why { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.ok { margin: 0; font-size: 14.5px; line-height: 1.5; color: var(--text-primary); }
.done { list-style: none; margin: 0; padding: 0 0 0 10px; border-left: 2px solid var(--hairline); display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.agree { font-size: 12.5px; color: var(--color-info); font-weight: 600; }
.res { margin: 0; font-size: 13.5px; color: var(--text-secondary); }
.err { font-size: 12.5px; color: var(--color-error); }
</style>
