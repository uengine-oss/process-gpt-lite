<script setup>
// A step run by a CLI agent on its assignee's own computer (server lib/localAgents): who runs it on which computer, the step, where it is
// (waiting for the PC app · sent · running · steering · done · handed to the server), how long, and the CLI's session — its own terminal
// (LocalTerminal: the person's interactive CLI, the same screen for every viewer), the suggestions stacked at its input, then the input.
// (A run on a desktop without a terminal — headless fallback — and the compact card in a conversation show the CLI's last lines instead.)
//   the worker (the person whose CLI it is) — the input line: their own words, or a participant's suggested prompt from the stack above it
//     (tap it: it loads into the line; edit it; send) → the CLI. They can drop a suggestion.
//   everyone else who sees the instance — the same output and stack, and a line to suggest a prompt; no send into the CLI (the server
//     refuses it too): 「그것을 입력버튼으로 실제 입력시키는 당사자는 해당 cli를 가진 사람만」(2026-11-24).
// The same card everywhere: the instance page (InstanceHeader), the instance's conversation (Message.vue kind local_run, compact), any
// screen — a phone too. It follows the run live (the server pushes the card — 'local_run' events, stores/app.js).
// run: server lib/localAgents/steps.js cardOf
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import Icon from './Icon.vue'
import LocalTerminal from './LocalTerminal.vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'

const props = defineProps({ run: { type: Object, required: true }, compact: Boolean })
const app = useApp()
const r = computed(() => props.run)
const text = ref('')
const picked = ref(null) // the suggestion loaded into the line
const proposal = ref('')
const busy = ref('')
const said = ref('')
const now = ref(Date.now())
const out = ref(null)
const input = ref(null)
let tick = null
onMounted(() => { tick = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => clearInterval(tick))

const live = computed(() => ['offered', 'running'].includes(r.value.state))
const tone = computed(() => ({ queued: 'wait', offered: 'wait', running: 'run', done: 'ok', failed: 'bad', delegated: 'info', cancelled: 'info' }[r.value.state] || 'info'))
const pill = computed(() => (r.value.state === 'running' && r.value.steering ? '방향 전달 중'
  : { queued: r.value.why === 'busy' ? '차례 기다림' : 'PC 앱이 켜지면 시작', offered: '보냄', running: '실행 중', done: '끝남', failed: '멈춤', delegated: '서버에 맡김', cancelled: '멈춤' }[r.value.state]))
const who = computed(() => [r.value.person, r.value.device].filter(Boolean).join(' · ') || '담당자의 컴퓨터')
const lines = computed(() => (r.value.lines || []).filter((l) => l.kind !== 'status' || !props.compact).slice(props.compact ? -4 : -14))
const mark = { tool: '›', text: '', steer: '⏎', error: '!', status: '·' }
const span = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}초` : s < 3600 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분` }
const elapsed = computed(() => {
  const x = r.value
  const t = (d) => (d ? new Date(d).getTime() : null)
  if (x.state === 'queued') return x.createdAt ? `기다린 지 ${span(now.value - t(x.createdAt))}` : ''
  if (x.startedAt && x.finishedAt) return `${span(t(x.finishedAt) - t(x.startedAt))} 걸림`
  if (x.startedAt) return `${span(now.value - t(x.startedAt))}째`
  return ''
})
const ago = (d) => { const m = Math.max(0, Math.round((now.value - new Date(d).getTime()) / 60000)); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : new Date(d).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }) }
// 이 · 가 by the name's last syllable
const ga = (w) => { const c = String(w || '').trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '이' : '가' }
const steerLabel = (s) => ({ pending: '보내는 중', sent: '데스크톱에 보냄', received: '데스크톱이 받음', failed: `못 함 — ${s.reason || ''}` }[s.state]
  || { live: '반영 — 실행을 멈추지 않고', resume: '반영 — 같은 세션을 이어서', restart: '반영 — 다시 시작하며', 'before-start': '반영 — 시작할 때' }[s.applied] || '반영')
const steerWho = (s) => (s.from ? `${s.from} 제안 · ${s.name} 입력` : s.name)
const sugWho = (s) => (s.kind === 'decision' ? `${s.name} 결정${s.option ? ` · ${s.option}` : ''}` : s.name)
const sugState = (s) => (s.state === 'used' ? `${s.usedBy || r.value.person}${ga(s.usedBy || r.value.person)} ${s.edited ? '고쳐서 ' : ''}입력함` : s.state === 'dismissed' ? '버림' : '입력 기다림')
// the terminal follows its output
watch(() => (r.value.lines || []).length, () => nextTick(() => { if (out.value) out.value.scrollTop = out.value.scrollHeight }))

// what the request answered is the card as it is now: shown at once (the push follows with the same)
function show(card) { if (card?.jobId) app.patchLocalRun(card) }
function load(s) { picked.value = s; text.value = s.text; nextTick(() => input.value?.focus()) }
function unload() { picked.value = null; text.value = '' }
async function send() {
  const t = text.value.trim()
  if (!t || busy.value) return
  busy.value = 'steer'; said.value = ''
  try {
    const res = await api(`/local-agents/jobs/${encodeURIComponent(r.value.jobId)}/steer`, { method: 'POST', body: { text: t, ...(picked.value ? { suggestionId: picked.value.id } : {}) } })
    text.value = ''
    picked.value = null
    show(res.job)
    said.value = res.delivered ? `${r.value.label}에 입력했어요` : '데스크톱이 이어지면 입력해요'
  } catch (e) { said.value = e.message } finally { busy.value = '' }
}
async function dismiss(s) {
  busy.value = `d-${s.id}`; said.value = ''
  try { show(await api(`/local-agents/jobs/${encodeURIComponent(r.value.jobId)}/suggestions/${encodeURIComponent(s.id)}/dismiss`, { method: 'POST' })); if (picked.value?.id === s.id) unload() }
  catch (e) { said.value = e.message } finally { busy.value = '' }
}
async function suggest() {
  const t = proposal.value.trim()
  if (!t || busy.value) return
  busy.value = 'suggest'; said.value = ''
  try { const res = await api(`/local-agents/jobs/${encodeURIComponent(r.value.jobId)}/suggestions`, { method: 'POST', body: { text: t } }); proposal.value = ''; show(res.job); said.value = `${r.value.person || '실행하는 사람'}님의 입력란에 올렸어요` }
  catch (e) { said.value = e.message } finally { busy.value = '' }
}
// what the run learned: apply (into the activity, or a proposal to the skill) or drop
async function decide(k, action) {
  busy.value = `k-${k.id}`; said.value = ''
  try { show(await api(`/local-agents/jobs/${encodeURIComponent(r.value.jobId)}/knowhow/${encodeURIComponent(k.id)}`, { method: 'POST', body: { action } })) } catch (e) { said.value = e.message } finally { busy.value = '' }
}
const kLabel = (k) => (k.kind === 'skill' ? `스킬 「${k.skill?.name}」 고침` : k.source === 'memory' ? '에이전트가 적은 기억 → 이 일의 방식' : '실행 중 조종 → 이 일의 방식')
const kState = (k) => (k.state === 'applied' ? (k.kind === 'skill' ? '스킬에 반영 요청함' : '이 일의 정의에 반영함') : k.state === 'dismissed' ? '버림' : k.unjudged ? '판정 못 함 — 사람이 정해요' : `판정 ${Math.round((k.p || 0) * 100)}%`)
async function delegate() {
  busy.value = 'delegate'; said.value = ''
  try { show(await api(`/local-agents/jobs/${encodeURIComponent(r.value.jobId)}/delegate`, { method: 'POST' })) } catch (e) { said.value = e.message } finally { busy.value = '' }
}
</script>

<template>
  <div class="lr" :class="[tone, { compact }]" data-test="local-run" :data-state="r.state" :data-job="r.jobId" :data-worker="r.worker ? 'yes' : 'no'">
    <div class="hd">
      <span class="ic"><Icon name="panel" :size="15" /></span>
      <div class="ttl">
        <b>{{ r.label }} <small data-test="local-run-who">· {{ who }}</small></b>
        <small>「{{ r.activity }}」 단계<template v-if="r.mode === 'draft'"> · 초안</template><template v-if="elapsed"> · <span data-test="local-run-elapsed">{{ elapsed }}</span></template></small>
      </div>
      <span class="pill" data-test="local-run-state">{{ pill }}</span>
    </div>
    <p class="st" data-test="local-run-text">{{ r.text }}</p>

    <!-- the CLI's session: its terminal (or its last lines), the steers that went in, the suggestions waiting at its input, the input -->
    <div v-if="lines.length || r.steers?.length || live || (r.terminal && !compact)" class="term" data-test="local-run-term">
      <LocalTerminal v-if="r.terminal && !compact" :key="r.jobId" :job-id="r.jobId" :agent="r.agent" />
      <ol v-else-if="lines.length" ref="out" class="lines" data-test="local-run-lines">
        <li v-for="(l, i) in lines" :key="i" :class="l.kind"><span class="mk">{{ mark[l.kind] ?? '' }}</span><span>{{ l.text }}</span></li>
      </ol>
      <ul v-if="r.steers?.length" class="steers" data-test="local-run-steers">
        <li v-for="s in r.steers" :key="s.id" :class="s.state" :data-steer-state="s.state"><span class="mk">⏎</span><span class="tx"><b class="who">{{ steerWho(s) }}</b> {{ s.text }}</span> <small>{{ steerLabel(s) }}</small></li>
      </ul>
      <ul v-if="r.suggestions?.length" class="sugs" data-test="local-run-suggestions">
        <li v-for="s in r.suggestions" :key="s.id" :class="[s.state, s.kind]" :data-suggestion="s.id" :data-suggestion-state="s.state" :data-suggestion-kind="s.kind || 'opinion'">
          <button v-if="r.worker && live && s.state === 'waiting'" class="chip press" :class="{ on: picked?.id === s.id }" :disabled="!!busy" data-test="local-run-suggestion-load" @click="load(s)">
            <b class="who">{{ sugWho(s) }}</b><span class="tx">{{ s.text }}</span><small>{{ ago(s.at) }}</small>
          </button>
          <div v-else class="chip static"><b class="who">{{ sugWho(s) }}</b><span class="tx">{{ s.edited ? s.usedText : s.text }}</span><small>{{ ago(s.at) }} · {{ sugState(s) }}</small></div>
          <button v-if="r.worker && live && s.state === 'waiting'" class="x press" :disabled="!!busy" aria-label="제안 버리기" data-test="local-run-suggestion-dismiss" @click="dismiss(s)">×</button>
        </li>
      </ul>
      <!-- the worker: the CLI's input -->
      <form v-if="live && r.worker" class="input" @submit.prevent="send">
        <small v-if="picked" class="loaded" data-test="local-run-loaded">{{ picked.name }}의 제안을 입력란에 넣었어요 — 고쳐서 보낼 수 있어요 <button type="button" class="lnk" @click="unload">취소</button></small>
        <div class="row">
          <span class="prompt">❯</span>
          <input ref="input" v-model="text" maxlength="4000" enterkeyhint="send" placeholder="입력 — 실행 중에 방향 바꾸기" aria-label="입력" data-test="local-run-steer" />
          <button class="press" :disabled="!text.trim() || !!busy" aria-label="입력" data-test="local-run-steer-send"><Icon name="up" :size="15" /></button>
        </div>
      </form>
      <!-- everyone else: a prompt they suggest stacks at the worker's input -->
      <form v-else-if="live" class="input suggest" @submit.prevent="suggest">
        <small class="loaded" data-test="local-run-no-steer">입력은 {{ r.person || '실행하는 사람' }}님만 해요 — 제안하면 {{ r.person || '그 사람' }}님의 입력란에 쌓여요</small>
        <div class="row">
          <input v-model="proposal" maxlength="2000" enterkeyhint="send" placeholder="프롬프트 제안하기" aria-label="프롬프트 제안하기" data-test="local-run-suggest" />
          <button class="press" :disabled="!proposal.trim() || !!busy" aria-label="제안 올리기" data-test="local-run-suggest-send"><Icon name="up" :size="15" /></button>
        </div>
      </form>
    </div>
    <p v-if="r.state === 'done' && r.files?.length && !compact" class="files">{{ r.files.length }}개 파일 · {{ r.files.slice(0, 3).join(', ') }}<template v-if="r.files.length > 3"> …</template></p>
    <!-- what the run learned: candidates a person applies or drops (never by themselves) -->
    <ul v-if="r.knowhow?.length" class="knowhow" data-test="local-run-knowhow">
      <li v-for="k in r.knowhow" :key="k.id" :data-kind="k.kind" :data-k-state="k.state">
        <b>{{ kLabel(k) }}</b>
        <span class="tx">{{ k.text }}<template v-if="k.suggestedBy"> <small>({{ k.suggestedBy }} 제안 · {{ k.by }} 입력)</small></template></span>
        <small>{{ k.provenance }} · {{ kState(k) }}</small>
        <span v-if="k.canDecide" class="kb">
          <button class="mini press" :disabled="!!busy" data-test="local-run-knowhow-apply" @click="decide(k, 'apply')">{{ k.kind === 'skill' ? '스킬에 반영 요청' : '이 일에 반영' }}</button>
          <button class="mini ghost press" :disabled="!!busy" data-test="local-run-knowhow-dismiss" @click="decide(k, 'dismiss')">버리기</button>
        </span>
      </li>
    </ul>
    <button v-if="r.state === 'queued' && r.canDelegate" class="handoff press" :disabled="!!busy" data-test="local-run-delegate" @click="delegate">
      기다리지 않고 {{ r.serverLabel || '서버 에이전트' }}에게 맡기기
    </button>
    <p v-if="said" class="said" data-test="local-run-said">{{ said }}</p>
  </div>
</template>

<style scoped>
.lr { border-radius: 20px; padding: 12px 14px; background: var(--bubble-agent-bg); box-shadow: var(--shadow-card); font-size: 13.5px; display: flex; flex-direction: column; gap: 6px;
  width: 100%; max-width: 560px; min-width: 0; box-sizing: border-box; overflow: hidden; }
.hd { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ic { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; background: var(--cell-bg); flex: none; }
.ttl { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.ttl b, .ttl small { overflow-wrap: anywhere; }
.ttl small { color: var(--text-secondary); font-weight: 400; font-size: 12px; }
.pill { height: 22px; padding: 0 9px; border-radius: 11px; font-size: 12px; display: inline-flex; align-items: center; background: var(--cell-bg); flex: none; white-space: nowrap; }
.run .pill { background: color-mix(in srgb, var(--color-info) 28%, transparent); }
.run .ic { animation: pulse 1.6s ease-in-out infinite; }
.ok .pill { background: color-mix(in srgb, var(--color-success) 30%, transparent); }
.bad .pill { background: var(--color-error); color: #fff; }
.wait .pill { background: color-mix(in srgb, var(--color-attention) 26%, transparent); }
.st { margin: 0; color: var(--text-primary); line-height: 1.45; overflow-wrap: anywhere; }
/* the terminal */
.term { border-radius: 14px; background: #15171c; color: #d7dae0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.term ol, .term ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lines { max-height: 220px; overflow-y: auto; }
.compact .lines { max-height: 90px; }
.lines li { display: flex; gap: 6px; min-width: 0; }
.lines li span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lines li.tool { color: #9aa3b2; }
.lines li.steer { color: #f2c94c; }
.lines li.error { color: #ff7b72; }
.lines li.status { color: #6b7280; }
.mk { flex: none; width: 10px; color: #6b7280; }
.steers { border-top: 1px dashed #343844; padding-top: 6px !important; }
.steers li { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; color: #f2c94c; min-width: 0; }
.steers .tx { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
.steers small { color: #8b93a3; flex: none; }
.steers li.applied small { color: #56d364; }
.steers li.failed small { color: #ff7b72; flex: 1 1 100%; }
.who { font-weight: 600; margin-right: 4px; }
.sugs { border-top: 1px dashed #343844; padding-top: 6px !important; gap: 4px !important; }
.sugs li { display: flex; align-items: flex-start; gap: 4px; min-width: 0; }
.chip { flex: 1; min-width: 0; text-align: left; display: flex; flex-wrap: wrap; gap: 2px 6px; align-items: baseline; padding: 6px 8px; border-radius: 10px; background: #232733; color: #e6e8ee;
  font: inherit; border: 1px solid transparent; }
.chip.on { border-color: #f2c94c; }
.chip .tx { flex: 1 1 140px; min-width: 0; overflow-wrap: anywhere; }
.chip small { color: #8b93a3; flex: none; }
.chip.static { opacity: .9; }
.sugs li.used .chip small { color: #56d364; }
.sugs li.dismissed .chip { opacity: .5; text-decoration: line-through; }
.sugs li.decision .chip { border-color: #3d6fb6; }
.x { width: 26px; height: 26px; border-radius: 13px; color: #8b93a3; font-size: 18px; flex: none; }
.input { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid #343844; padding-top: 6px; min-width: 0; }
.input .row { display: flex; gap: 6px; align-items: center; min-width: 0; }
.prompt { color: #56d364; flex: none; }
.input input { flex: 1; min-width: 0; width: 100%; height: 34px; border-radius: 8px; padding: 0 10px; background: #0d0f13; border: 1px solid #343844; color: #e6e8ee; font: inherit; font-size: 16px; }
.input .row button { width: 34px; height: 34px; border-radius: 17px; background: #e6e8ee; color: #15171c; display: grid; place-items: center; flex: none; }
.input .row button:disabled { opacity: .35; }
.loaded { color: #8b93a3; font-size: 11.5px; overflow-wrap: anywhere; }
.lnk { color: #f2c94c; text-decoration: underline; background: none; padding: 0; font: inherit; }
.files, .said { margin: 0; font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
.knowhow { list-style: none; margin: 0; padding: 8px 10px; border-radius: 12px; background: var(--field-bg); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.knowhow .tx { min-width: 0; overflow-wrap: anywhere; }
.knowhow li { display: flex; flex-direction: column; gap: 3px; font-size: 12.5px; padding-bottom: 6px; border-bottom: 1px solid var(--hairline); }
.knowhow li:last-child { border-bottom: 0; padding-bottom: 0; }
.knowhow small { color: var(--text-secondary); }
.knowhow .kb { display: flex; gap: 6px; flex-wrap: wrap; }
.mini { height: 28px; padding: 0 12px; border-radius: 14px; background: var(--ink); color: var(--ink-inverse); font-size: 12px; flex: none; }
.mini.ghost { background: var(--cell-bg); color: var(--text-primary); }
.handoff { align-self: flex-start; max-width: 100%; height: 34px; padding: 0 14px; border-radius: 17px; background: var(--cell-bg); color: var(--text-primary); font-size: 13px; }
</style>
