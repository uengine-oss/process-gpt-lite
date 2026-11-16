<script setup>
// 건 지켜보기(server lib/ontology/runmode.js runView): 이 건의 실행 방식 · 멈춤, 단계마다 끝남 · 하는 중 · 사람 차례 · 기다림 · 다음과
// 맡은 이(업무 에이전트, 또는 역할 · 사람), 되돌릴 수 있는지, 사람을 기다리면 그 까닭과 정할 것(진행 · 다른 갈래 · 멈추기).
// 「멈추기」 · 「이어 가기」 · 「이 단계로 되감기」는 건을 맡은 사람이나 관리자. 바꾸면 emit changed(위 패널이 스냅샷을 다시 그린다).
// 「이 단계에 의견」은 누구나: 말을 지도의 고침으로 옮겨 보고(edit/plan, 그 단계 범위) 의견으로 남긴다(opinions, source step) — 건은 그대로.
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { api } from '../../api.js'
import { dateTimeKo, pct } from './fmt.js'
import { RUNMODE_KO, STEP_KO, WAIT_KO, holderText, RO, EUL, EUN, IEYO } from './ontoText.js'
import OntoDocSheet from './OntoDocSheet.vue'
import OntoChangeList from './OntoChangeList.vue'

const props = defineProps({ caseId: { type: String, required: true } })
const emit = defineEmits(['changed'])
const run = ref(null)
const err = ref('')
const busy = ref('')
const note = ref('')
const ask = ref(null) // 되감기 확인: {task, lost, redo}
const showOld = ref(false)

let timer = 0, alive = true
async function load() {
  try { run.value = await api(`/ontology/cases/${encodeURIComponent(props.caseId)}/run`); err.value = '' } catch (e) { err.value = e.message }
  clearTimeout(timer)
  if (alive) timer = setTimeout(load, run.value?.status === 'running' ? 4000 : 15000)
}
watch(() => props.caseId, () => { run.value = null; ask.value = null; note.value = ''; load() }, { immediate: true })
onBeforeUnmount(() => { alive = false; clearTimeout(timer) })

const current = computed(() => (run.value?.steps || []).filter((s) => s.current))
const older = computed(() => (run.value?.steps || []).filter((s) => !s.current))
const waiting = computed(() => current.value.find((s) => s.state === 'waiting') || null)
const rewindOf = (task) => (run.value?.rewind || []).find((x) => x.task === task) || null
const canRewind = (s) => run.value?.controls?.mine && !run.value?.paused && ['done', 'person', 'waiting', 'running', 'skipped'].includes(s.state) && !!rewindOf(s.task)
const outward = computed(() => !!waiting.value?.why?.includes('irreversible'))
// 이 건의 방식: 시작할 때 프로세스의 단계로 정해져 끝까지 가요(modeFrom case) · 그 전에 시작한 건은 프로세스의 지금 단계를 따라요(stage)
const modeTitle = computed(() => (run.value?.modeFrom === 'case' ? '시작할 때 프로세스의 단계로 정한 방식이에요 — 단계를 바꿔도 이 건은 그대로예요' : '프로세스의 지금 단계를 따라요'))
// 시작한 뒤 프로세스의 단계가 바뀌었으면(이 건은 그대로) 한 줄로 알려 줘요 — 관찰로 바꿨어도 돌던 건은 이어 가요
const stageMoved = computed(() => { const r = run.value; return !!(r && r.status === 'running' && r.modeFrom === 'case' && r.stage && r.stageName && r.stage !== r.modeStage) })

async function act(path, body, msg) {
  busy.value = path; err.value = ''; note.value = ''
  try {
    const r = await api(`/ontology/${path}`, { method: 'POST', body })
    if (r?.run) run.value = r.run
    else if (r?.steps) run.value = r
    if (msg) note.value = typeof msg === 'function' ? msg(r) : msg
    emit('changed', r)
    return r
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const pause = () => act(`cases/${props.caseId}/pause`, {}, '멈췄어요. 에이전트가 다음 단계를 잡지 않아요(사람은 자기 단계를 할 수 있어요).')
const resume = () => act(`cases/${props.caseId}/resume`, {}, '이어 가요. 멈춘 동안 기다리던 단계를 다시 봐요.')
// 꼭 하는 단계를 건너뛰거나 다른 갈래로 지나치려 하면 서버가 먼저 알린다({confirm}) — 까닭을 받아 다시 보낸다(결정 기록에 남아요)
const pass = ref(null) // {action, to, task, line, reason}
async function decide(action, to = '', extra = {}, stepId = waiting.value?.stepId) {
  const task = waiting.value?.task || pass.value?.task || ''
  const r = await act(`steps/${stepId}`, { action, to, ...extra }, (x) => x?.confirm ? ''
    : action === 'stop' ? '멈췄어요. 「이어 가기」를 누르면 다시 물어요.' : x?.sent ? '보낸 것으로 기록했어요. 이 판에서는 실제로 보내지 않아요.'
      : action === 'skip' ? `「${task}」${EUL(task)} 건너뛰었어요. 다음 단계로 가요.` : action === 'other' ? `「${to}」${RO(to)} 옮겨 이어 가요.` : '진행해요.')
  if (r?.confirm) pass.value = { action, to, task: r.task || task, line: r.line || '', reason: '', stepId }
  else if (r) pass.value = null
}
const passGo = () => decide(pass.value.action, pass.value.to || '', { confirm: true, reason: pass.value.reason.trim() }, pass.value.stepId)
const REQ_TAG = { required: '꼭 하는 단계', optional: '해도 되는 단계' }
async function rewind(task, confirm = false) {
  const r = await act(`cases/${props.caseId}/rewind`, { task, confirm }, null)
  if (!r) return
  if (r.confirm) { ask.value = { task, lost: r.lost, redo: r.redo }; return }
  ask.value = null
  note.value = `「${task}」${RO(task)} 되감았어요. ${run.value?.engine === 'map' ? '같은 인스턴스에서 그 단계부터 다시 해요' : '그 단계부터 새 스냅샷으로 다시 해요'} — 앞에서 한 것은 기록으로 남아요.`
}
// 지도에서 바로 도는 건(server mapengine.js): 단계마다 지도가 그 단계를 고른 까닭(한 갈래 · 금액 조건 · 글 조건 · 가장 흔한 길 · 나란히 · 합류 · 옮김)
const VIA_KO = { entry: '시작', single: '한 갈래', amount: '금액 조건', text: '갈림길 조건', common: '가장 흔한 길', parallel: '나란히', join: '합류', moved: '옮김', rewound: '되감음' }
const viaText = (s) => (s.via ? `지도로 정함 · ${VIA_KO[s.via.how] || s.via.how}${s.via.why ? ` — ${s.via.why}` : ''}` : '')
const stateText = (s) => (s.state === 'person' ? `${(s.holder?.names || []).join(', ') || s.holder?.role || '사람'} 차례` : STEP_KO[s.state] || s.state)
// 단계가 만든 파일(server stepdoc.js stepFiles, 할 일마다): 파일 · 쓴 양식(정해 둔 · 자동) · 양식에서 바꾼 것 · 형식 규칙 점검 — 이음오피스로 열어 보기
const files = ref({})
const doc = ref(null)
watch(run, async () => { try { files.value = (await api(`/ontology/cases/${encodeURIComponent(props.caseId)}/files`)).steps || {} } catch { /* 파일 없이 글만 */ } })
const fileOf = (s) => (s?.todoId ? files.value[s.todoId] || null : null)
const failedRules = (f) => (f?.formatRules || []).filter((x) => x.ok === false)
const passedRules = (f) => (f?.formatRules || []).filter((x) => x.ok === true).length

// ---------- 이 단계에 의견 ----------
// one step's box at a time; kept apart from run (it reloads every few seconds)
const rootEl = ref(null)
const voice = ref(null) // {key, task, todoId, words, plan, busy, failed, err, done, agree}
const stepKey = (s) => `${s.inst}:${s.task}`
function openVoice(s) {
  if (voice.value?.key === stepKey(s)) { voice.value = null; return }
  voice.value = { key: stepKey(s), task: s.task, todoId: s.todoId || null, words: '', plan: null, busy: '', failed: '', err: '', done: false, agree: 0 }
  nextTick(() => rootEl.value?.querySelector('[data-testid="onto-case-voice-words"]')?.focus())
}
async function planVoice() {
  const v = voice.value
  const words = v.words.trim()
  if (!words || !run.value?.proc) return
  v.busy = 'plan'; v.failed = ''; v.err = ''; v.plan = null
  try { v.plan = await api('/ontology/edit/plan', { method: 'POST', body: { proc: run.value.proc, scope: { tasks: [v.task], ways: [] }, words } }) } catch (e) { v.failed = e.message } finally { v.busy = '' }
}
// an opinion the model could not turn into changes is left as words (ops [])
async function sendVoice() {
  const v = voice.value
  v.busy = 'voice'; v.err = ''
  try {
    const r = await api('/ontology/opinions', { method: 'POST', body: {
      proc: run.value.proc, scope: v.plan?.range || { tasks: [v.task], ways: [] }, words: v.plan?.words || v.words.trim(), ops: v.plan?.ops || [],
      source: 'step', caseId: run.value.caseId || props.caseId, todoId: v.todoId || undefined, task: v.task,
    } })
    v.done = true; v.agree = Number(r?.agree ?? r?.opinion?.agree ?? 0)
  } catch (e) { v.err = e.message } finally { v.busy = '' }
}
function resay() {
  voice.value.plan = null
  nextTick(() => rootEl.value?.querySelector('[data-testid="onto-case-voice-words"]')?.focus())
}
</script>

<template>
  <div ref="rootEl" class="cr" data-testid="onto-case-run" :data-mode="run?.mode" :data-paused="run?.paused ? '1' : '0'" :data-status="run?.status">
    <p v-if="!run && !err" class="muted pulse">진행을 불러오는 중…</p>
    <template v-if="run">
      <div class="top">
        <span class="mode" data-testid="onto-case-mode" :data-from="run.modeFrom" :title="modeTitle">{{ RUNMODE_KO[run.mode] || run.mode }}</span>
        <span v-if="run.paused" class="pz" data-testid="onto-case-paused">멈춤</span>
        <span v-if="run.engine === 'map'" class="eng" data-testid="onto-case-engine" :title="run.mapPin ? '시작한 날의 지도로 다음 단계를 정해요' : '단계가 끝날 때마다 그때의 지도로 다음 단계를 정해요'">지도에서 바로{{ run.mapPin ? ' · 지도 고정' : '' }}</span>
        <span class="sp" />
        <button v-if="run.controls.pause" class="pill press" :disabled="!!busy" data-testid="onto-case-pause" @click="pause">멈추기</button>
        <button v-if="run.controls.resume" class="pill go press" :disabled="!!busy" data-testid="onto-case-resume" @click="resume">이어 가기</button>
      </div>
      <small class="hint">{{ run.mode === 'hitl' ? '단계마다 「다음은 ○○예요 — 진행할까요?」라고 물어요.' : '저절로 진행해요. 사람이 책임지는 단계와 되돌릴 수 없는 단계에서만 멈춰 물어요.' }}<template v-if="stageMoved"> 프로세스는 지금 「{{ run.stageName }}」 단계예요 — 새 건부터 그렇게 가고, 이 건은 시작할 때 방식 그대로예요.</template></small>

      <!-- 사람을 기다리는 단계 -->
      <div v-if="waiting" class="wait" data-testid="onto-case-waiting" :data-task="waiting.task" :data-why="waiting.why.join(',')">
        <b v-if="outward">「{{ waiting.task }}」 초안을 만들었어요 — 회사 밖으로 나가요. 보낼까요?</b>
        <b v-else-if="waiting.why.includes('paused')">「{{ waiting.task }}」 차례인데 건이 멈춰 있어요.</b>
        <b v-else-if="waiting.why.includes('hitl')">다음은 「{{ waiting.task }}」{{ IEYO(waiting.task) }} — 진행할까요?</b>
        <b v-else-if="waiting.why.includes('optional')">「{{ waiting.task }}」, 이 건에도 할까요? 건너뛸 수 있는 단계예요.</b>
        <b v-else>「{{ waiting.task }}」{{ EUL(waiting.task) }} 하기 전에 사람이 정해야 해요.</b>
        <ul class="why"><li v-for="(w, i) in waiting.whyText" :key="i">{{ w }}</li></ul>
        <small v-if="waiting.reqLine" class="rq" data-testid="onto-case-waiting-req">{{ waiting.reqLine }}</small>
        <p v-if="waiting.proposal?.why && !outward" class="prop" data-testid="onto-case-proposal">
          <span v-if="waiting.proposal.from" class="cap">{{ waiting.proposal.from }}에서</span> {{ waiting.proposal.why }}<template v-if="waiting.proposal.p != null && waiting.proposal.split"> · {{ pct(waiting.proposal.p) }}</template>
        </p>
        <div v-if="waiting.preview" class="pv" data-testid="onto-case-preview">
          <small v-if="waiting.preview.to">받는 사람 · {{ waiting.preview.to }}</small>
          <small v-if="waiting.preview.subject">제목 · {{ waiting.preview.subject }}</small>
          <p>{{ waiting.preview.text }}</p>
          <button v-if="waiting.preview.file?.url" class="lnk press" data-testid="onto-case-preview-file" @click="doc = waiting.preview.file">함께 갈 파일 · {{ waiting.preview.file.name }} 열어 보기</button>
        </div>
        <small v-if="waiting.holder && !waiting.holder.agent" class="hold">넘어갈 사람 · {{ holderText(waiting.holder) }}</small>
        <!-- the step's role has nobody yet (server mapengine.js): chosen in 「맡는 사람」 of the case, then it goes on -->
        <small v-if="waiting.why.includes('unbound')" class="hold" data-testid="onto-case-waiting-unbound">이 건의 「맡는 사람」에서 고르면 이어서 해요.</small>
        <div v-else-if="run.controls.mine && !waiting.why.includes('paused')" class="btns">
          <button class="pill go press" :disabled="!!busy || run.paused" data-testid="onto-case-step-go" @click="decide('go')">{{ outward ? '보내기' : '진행' }}</button>
          <button v-for="o in waiting.proposal?.others || []" :key="o.to" class="chip press" :disabled="!!busy || run.paused" data-testid="onto-case-step-other" :title="o.cond || ''" @click="decide('other', o.to)">{{ o.to }}<small v-if="o.p != null"> {{ pct(o.p) }}</small></button>
          <button v-if="waiting.requirement === 'optional'" class="pill press" :disabled="!!busy || run.paused" data-testid="onto-case-step-skip" @click="decide('skip')">건너뛰기</button>
          <button class="pill press" :disabled="!!busy || run.paused" data-testid="onto-case-step-stop" @click="decide('stop')">멈추기</button>
          <button v-if="waiting.requirement === 'required' && !pass" class="lnk press" :disabled="!!busy || run.paused" data-testid="onto-case-step-pass" @click="decide('skip')">그래도 건너뛰기…</button>
        </div>
        <!-- 꼭 하는 단계를 지나치려 할 때: 알리고 까닭을 받는다 -->
        <div v-if="pass" class="ask" data-testid="onto-case-pass">
          <b>「{{ pass.task }}」{{ EUN(pass.task) }} 꼭 하는 단계예요. {{ pass.action === 'skip' ? '그래도 건너뛸까요?' : `그래도 「${pass.to}」${RO(pass.to)} 갈까요?` }}</b>
          <small v-if="pass.line">{{ pass.line }}</small>
          <input v-model="pass.reason" class="in" maxlength="300" placeholder="지나치는 까닭(꼭 적어 주세요 — 결정 기록에 남아요)" data-testid="onto-case-pass-reason" />
          <div class="btns">
            <button class="pill press" :disabled="!!busy" @click="pass = null">그만두기</button>
            <button class="pill go press" :disabled="!!busy || !pass.reason.trim()" data-testid="onto-case-pass-confirm" @click="passGo">{{ pass.action === 'skip' ? '그래도 건너뛰기' : '그래도 이 갈래로' }}</button>
          </div>
        </div>
        <small v-if="outward" class="stub">이 판에서는 실제 메일이 나가지 않아요 — 보낼 내용만 건에 남겨요.</small>
      </div>

      <!-- 단계 -->
      <ol class="steps">
        <li v-for="s in current" :key="`${s.inst}:${s.task}`" :class="s.state" data-testid="onto-case-step" :data-task="s.task" :data-state="s.state" :data-kind="s.kind">
          <span class="dot" />
          <div class="main">
            <div class="row1">
              <b class="tn">{{ s.task }}</b>
              <span class="st">{{ stateText(s) }}</span>
              <button v-if="run.proc" class="lnk quiet press" :aria-expanded="voice?.key === stepKey(s)" data-testid="onto-case-voice-open" @click="openVoice(s)">이 단계에 의견</button>
            </div>
            <div class="row2">
              <span class="who" data-testid="onto-case-holder">{{ holderText(s.holder) }}</span>
              <span class="tag" :class="s.reversible ? 'rv' : 'irv'" data-testid="onto-case-reversible" :data-reversible="s.reversible ? '1' : '0'" :title="s.reversibleWhy">{{ s.reversible ? '되돌릴 수 있음' : '되돌릴 수 없음' }}</span>
              <span v-if="s.responsible" class="tag resp" data-testid="onto-case-responsible" :title="s.responsibleWhy.join(' · ')">책임 단계</span>
              <span v-if="s.policy === 'auto'" class="tag" title="되돌릴 수 없어도 묻지 않고 진행하기로 정했어요">묻지 않고 진행</span>
              <span v-if="s.state === 'waiting'" class="tag wt">{{ s.why.map((w) => WAIT_KO[w] || w).join(' · ') }}</span>
              <span v-if="s.requirement" class="tag" :class="`rq-${s.requirement}`" data-testid="onto-case-requirement" :data-requirement="s.requirement" :title="s.reqLine">{{ REQ_TAG[s.requirement] }}</span>
            </div>
            <small v-if="s.skipped" class="skp" data-testid="onto-case-skipped">건너뜀 — {{ s.skipped.reason || '까닭 없음' }}</small>
            <small v-if="s.via && s.via.how !== 'entry'" class="via" data-testid="onto-case-via" :data-how="s.via.how">{{ viaText(s) }}</small>
            <small v-if="s.matched && s.reqLine" class="rq" data-testid="onto-case-matched">{{ s.reqLine }}</small>
            <small v-if="s.result && !s.skipped" class="res">{{ s.result }}</small>
            <div v-if="fileOf(s)" class="made" data-testid="onto-case-file" :data-file="fileOf(s).file?.name || ''" :data-form="fileOf(s).form?.name || ''">
              <div v-if="fileOf(s).file" class="fl">
                <b>{{ fileOf(s).file.name }}</b><small v-if="fileOf(s).draft"> · 초안</small>
                <button class="lnk press" data-testid="onto-case-file-open" @click="doc = fileOf(s).file">열어 보기</button>
              </div>
              <small v-if="fileOf(s).form?.name" class="fm" data-testid="onto-case-form" :data-by="fileOf(s).form.chosenBy || ''">양식: {{ fileOf(s).form.name }}<template v-if="fileOf(s).form.label"> · {{ fileOf(s).form.label }}</template></small>
              <small v-if="fileOf(s).changed" class="fm" data-testid="onto-case-changed">{{ fileOf(s).form?.name && !fileOf(s).form.failed ? '양식에서 바꾼 것 · ' : '양식 없음 · ' }}{{ fileOf(s).changed }}</small>
              <small v-if="fileOf(s).formatRules.length" class="fr" :class="{ bad: failedRules(fileOf(s)).length }" data-testid="onto-case-format" :data-pass="passedRules(fileOf(s))" :data-total="fileOf(s).formatRules.length">
                형식 규칙 {{ passedRules(fileOf(s)) }}/{{ fileOf(s).formatRules.length }}<template v-if="failedRules(fileOf(s)).length"> · 못 지킨 것: {{ failedRules(fileOf(s)).map((x) => `${x.item}(${x.note})`).join(' · ') }}</template>
              </small>
            </div>
            <small v-if="s.sent" class="sent" data-testid="onto-case-sent">보낸 것으로 기록 · {{ s.sent.to || '받는 사람' }} · {{ s.sent.subject }} (실제로는 보내지 않았어요)</small>
            <!-- 이 단계에 의견: 말 → 지도로 옮겨 보기 → 의견으로 남기기 -->
            <div v-if="voice?.key === stepKey(s)" class="vo" data-testid="onto-case-voice" :data-task="s.task" :data-done="voice.done ? '1' : '0'">
              <template v-if="voice.done">
                <small class="ok" data-testid="onto-case-voice-done">의견으로 남겼어요. 진행 중인 건은 그대로예요.</small>
                <small v-if="voice.agree > 1" class="agree" data-testid="onto-case-voice-agree">같은 의견 {{ voice.agree }}명</small>
              </template>
              <template v-else>
                <textarea v-if="!voice.plan" v-model="voice.words" class="ta" rows="2" maxlength="600" :disabled="voice.busy === 'plan'"
                  :placeholder="`「${s.task}」${EUL(s.task)} 어떻게 바꾸면 좋을까요?`" data-testid="onto-case-voice-words" />
                <p v-else class="said">“{{ voice.words.trim() }}”</p>
                <p v-if="voice.busy === 'plan'" class="muted pulse" data-testid="onto-case-voice-pending">말을 지도로 옮기는 중…</p>
                <OntoChangeList v-if="voice.plan" :plan="voice.plan" />
                <small v-if="voice.plan && !(voice.plan.ops || []).length" class="hint">지도의 고침으로 옮기지 못했어요 — 말 그대로 의견으로 남길 수 있어요.</small>
                <small v-if="voice.failed" class="err">지도로 옮기지 못했어요({{ voice.failed }}) — 말 그대로 의견으로 남길 수 있어요.</small>
                <div class="btns">
                  <button v-if="!voice.plan" class="pill go press" :disabled="!!voice.busy || !voice.words.trim()" data-testid="onto-case-voice-plan" @click="planVoice">지도로 옮겨 보기</button>
                  <button v-if="voice.plan || voice.failed" class="pill press" :class="{ go: voice.plan }" :disabled="!!voice.busy || !voice.words.trim()" data-testid="onto-case-voice-send" @click="sendVoice">{{ voice.busy === 'voice' ? '남기는 중…' : '의견으로 남기기' }}</button>
                  <button v-if="voice.plan" class="pill press" :disabled="!!voice.busy" data-testid="onto-case-voice-resay" @click="resay">고쳐 말하기</button>
                  <button class="pill press" :disabled="voice.busy === 'voice'" @click="voice = null">그만두기</button>
                </div>
                <small v-if="voice.err" class="err">{{ voice.err }}</small>
              </template>
            </div>
          </div>
          <button v-if="canRewind(s)" class="lnk press" :disabled="!!busy" data-testid="onto-case-rewind" @click="rewind(s.task)">이 단계로 되감기</button>
        </li>
      </ol>
      <div v-if="ask" class="ask" data-testid="onto-case-rewind-ask">
        <b>「{{ ask.task }}」{{ RO(ask.task) }} 되감을까요?</b>
        <small>이미 회사 밖으로 보낸 「{{ ask.lost.join('」 · 「') }}」{{ EUL(ask.lost.at(-1)) }} 되돌아오지 않아요. 다시 그 단계를 지나면 한 번 더 보내게 돼요.</small>
        <small v-if="ask.redo.length">다시 하는 일 · {{ ask.redo.join(' · ') }}</small>
        <div class="btns">
          <button class="pill press" :disabled="!!busy" @click="ask = null">그만두기</button>
          <button class="pill go press" :disabled="!!busy" data-testid="onto-case-rewind-confirm" @click="rewind(ask.task, true)">그래도 되감기</button>
        </div>
      </div>
      <div v-if="older.length" class="old">
        <button class="lnk press" :aria-expanded="showOld" data-testid="onto-case-older" @click="showOld = !showOld">앞선 진행 {{ older.length }}단계 {{ showOld ? '접기' : '보기' }}</button>
        <ol v-if="showOld" class="steps dim">
          <li v-for="(s, i) in older" :key="`${s.inst}:${s.task}:${i}`" :class="s.state">
            <span class="dot" />
            <div class="main">
              <div class="row1"><b class="tn">{{ s.task }}</b><span class="st">{{ STEP_KO[s.state] || s.state }}<template v-if="s.at"> · {{ dateTimeKo(s.at) }}</template></span></div>
              <small v-if="s.sent" class="sent">보낸 것으로 기록 · {{ s.sent.to }} (실제로는 보내지 않았어요)</small>
              <small v-if="s.skipped" class="skp">건너뜀 — {{ s.skipped.reason || '까닭 없음' }}</small>
              <small v-if="fileOf(s)?.file" class="fm" data-testid="onto-case-old-file">{{ fileOf(s).file.name }} <button class="lnk press" @click="doc = fileOf(s).file">열어 보기</button></small>
            </div>
          </li>
        </ol>
      </div>
      <small v-if="note" class="ok" data-testid="onto-case-note">{{ note }}</small>
    </template>
    <small v-if="err" class="err">{{ err }}</small>
    <OntoDocSheet v-if="doc" :name="doc.name" :url="doc.url" note="건의 단계가 만든 파일이에요(읽기만)." @close="doc = null" />
  </div>
</template>

<style scoped>
.cr { display: flex; flex-direction: column; gap: 8px; min-width: 0; word-break: keep-all; overflow-wrap: anywhere; }
.muted { margin: 0; font-size: 13.5px; color: var(--text-secondary); }
.top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sp { flex: 1; }
.mode { padding: 3px 11px; border-radius: 9999px; background: var(--ink); color: var(--ink-inverse); font-size: 13px; font-weight: 600; }
.eng { padding: 3px 10px; border-radius: 9999px; background: color-mix(in srgb, var(--color-info) 16%, transparent); color: var(--text-primary); font-size: 12.5px; font-weight: 600; }
.via { font-size: 12px; color: var(--text-tertiary); line-height: 1.45; }
.pz { padding: 3px 10px; border-radius: 9999px; background: color-mix(in srgb, var(--color-warning, #b26a00) 18%, transparent); color: var(--text-primary); font-size: 12.5px; font-weight: 600; }
.hint { font-size: 12px; color: var(--text-tertiary); line-height: 1.45; }
.pill { height: 32px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; font-weight: 500; background: var(--field-bg); color: var(--text-primary); }
.pill.go { background: var(--ink); color: var(--ink-inverse); font-weight: 600; }
.pill:disabled, .chip:disabled { opacity: .5; cursor: default; }
.chip { height: 30px; padding: 0 12px; border-radius: 9999px; background: var(--field-bg); font-size: 13px; box-shadow: inset 0 0 0 1px var(--hairline); }
.chip small { color: var(--text-secondary); }
.wait { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: 14px; background: var(--bubble-agent-bg); box-shadow: inset 0 0 0 1px var(--hairline); }
.wait b { font-size: 14.5px; font-weight: 600; line-height: 1.45; }
.why { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.prop { margin: 0; font-size: 13px; line-height: 1.5; }
.cap { color: var(--text-tertiary); font-size: 12px; margin-right: 2px; }
.pv { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 10px; background: var(--field-bg); }
.pv small { font-size: 12px; color: var(--text-secondary); }
.pv p { margin: 4px 0 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; max-height: 9.5em; overflow: auto; }
.hold { font-size: 12.5px; color: var(--text-secondary); }
.btns { display: flex; flex-wrap: wrap; gap: 6px; }
.stub { font-size: 12px; color: var(--text-tertiary); }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.steps li { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.row1 { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.tn { font-size: 14px; font-weight: 600; }
.st { font-size: 12.5px; color: var(--text-secondary); }
.row2 { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.who { font-size: 12.5px; color: var(--text-secondary); margin-right: 2px; }
.tag { font-size: 11.5px; padding: 1px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.tag.irv { background: color-mix(in srgb, var(--color-error) 14%, transparent); color: var(--text-primary); }
.tag.resp { background: color-mix(in srgb, var(--color-info) 16%, transparent); color: var(--text-primary); }
.tag.wt { background: color-mix(in srgb, var(--color-warning, #b26a00) 18%, transparent); color: var(--text-primary); }
.res { font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; }
.made { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; padding: 6px 9px; border-radius: 10px; background: var(--field-bg); }
.made .fl { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 13px; }
.made .fl b { font-weight: 600; overflow-wrap: anywhere; }
.made .fl small { color: var(--text-tertiary); }
.made .fm, .fm { font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
.made .fr { font-size: 12px; color: var(--color-success); line-height: 1.45; }
.made .fr.bad { color: var(--color-warning, #b26a00); }
.sent { font-size: 12px; color: var(--text-tertiary); }
.dot { flex: none; margin-top: 5px; width: 9px; height: 9px; border-radius: 50%; background: var(--text-tertiary); }
li.done .dot { background: var(--color-success); }
li.running .dot { background: var(--color-info); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-info) 22%, transparent); }
li.person .dot { background: var(--text-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--text-primary) 15%, transparent); }
li.waiting .dot { background: var(--color-warning, #b26a00); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-warning, #b26a00) 22%, transparent); }
li.next .tn, li.closed .tn { color: var(--text-tertiary); font-weight: 500; }
/* 단계의 꼭 · 선택(steprule): 건너뜀 · 맞은 규칙 · 꼭 하는 단계를 지나치기 전 확인 */
li.skipped .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--text-tertiary); }
li.skipped .tn { color: var(--text-secondary); }
.skp { font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; }
.rq { font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
.tag.rq-required { background: color-mix(in srgb, #7a4fd0 18%, transparent); color: var(--text-primary); }
.tag.rq-optional { background: color-mix(in srgb, #2b7fbf 16%, transparent); color: var(--text-primary); }
.in { height: 32px; padding: 0 10px; border-radius: 10px; border: 0; outline: 0; background: var(--regular-solid-bg, var(--field-bg)); font-size: 13px; color: var(--text-primary); min-width: 0; }
.lnk { flex: none; font-size: 12.5px; color: var(--color-info); }
.lnk:disabled { opacity: .5; }
.ask { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 12px; background: var(--field-bg); }
.ask b { font-size: 14px; }
.ask small { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.old { display: flex; flex-direction: column; gap: 6px; }
.old .lnk { align-self: flex-start; }
.dim { opacity: .75; }
.ok { font-size: 12.5px; color: var(--color-success); }
.err { font-size: 12.5px; color: var(--color-error); }
/* 이 단계에 의견 */
.lnk.quiet { margin-left: auto; font-size: 12px; color: var(--text-tertiary); }
.lnk.quiet:hover, .lnk.quiet[aria-expanded='true'] { color: var(--color-info); }
.vo { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; padding: 10px 12px; border-radius: 12px; background: var(--field-bg); }
.ta { width: 100%; min-width: 0; padding: 7px 10px; border-radius: 10px; border: 0; outline: 0; resize: vertical; background: var(--regular-solid-bg, var(--cell-bg)); font: inherit; font-size: 13px; line-height: 1.5; color: var(--text-primary); }
.ta::placeholder { color: var(--text-tertiary); }
.said { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
.agree { font-size: 12.5px; font-weight: 600; color: var(--color-info); }
</style>
