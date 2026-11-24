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
// Two views of the same session, one toggle: 「대화」 (LocalConversation — the CLI's own records in Lite's components) and 「터미널」
// (LocalTerminal — its screen, in Lite's colours). 「대화」 by default for everyone but the CLI's owner and on a phone; the owner's
// desktop opens 「터미널」; each viewer's choice is remembered (this browser). One connection serves both (src/localRelay.js), opened as
// soon as the run is sent — 「터미널에 연결하는 중…」 until its terminal is open.
// After the CLI's turn the run waits for its people (the desktop's settle.js): its owner sees 「끝내기」 and when it ends by itself; the
// others see that it waits for the owner.
// A chat message's run (run.chat — server lib/localAgents/chat.js cardOf): the same card under the message in the chat, full size; its
// input is the chat's composer (what its owner writes next goes into the same session), so the card has none; when the run cannot answer
// now (the PC app is off, its link dropped, the CLI failed) its owner gets 「기본으로 다시 보내기」.
// run: server lib/localAgents/steps.js cardOf
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import Icon from './Icon.vue'
import LocalTerminal from './LocalTerminal.vue'
import LocalConversation from './LocalConversation.vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { openRelay } from '../localRelay.js'
import { josa } from '../josa.js'

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
onUnmounted(() => { clearInterval(tick); relay.value?.close() })

const live = computed(() => ['offered', 'running'].includes(r.value.state))
// ---------- the session's two views ----------
const VIEW_KEY = 'pgl.localRun.view'
const phone = () => { try { return window.matchMedia('(max-width: 760px)').matches } catch { return false } }
const remembered = () => { try { const v = localStorage.getItem(VIEW_KEY); return v === 'chat' || v === 'term' ? v : null } catch { return null } }
const chosen = ref(remembered() || (!r.value.worker || phone() ? 'chat' : 'term'))
// (a run whose desktop relays no conversation — before 0.2.1 — has the terminal only)
const views = computed(() => (r.value.conversation ? [['chat', '대화'], ['term', '터미널']] : [['term', '터미널']]))
const view = computed(() => (views.value.some((v) => v[0] === chosen.value) ? chosen.value : 'term'))
const shown = ref({ [view.value]: true })  // (a view once shown stays mounted: switching back is instant)
watch(view, (v) => { shown.value = { ...shown.value, [v]: true } })
function setView(v) { chosen.value = v; try { localStorage.setItem(VIEW_KEY, v) } catch { /* private mode */ } }
// the session: a terminal open now, about to open (sent to a desktop that runs steps in a terminal), or a finished run's kept one
const session = computed(() => !props.compact && !!(r.value.terminal || r.value.terminalSoon || r.value.conversation))
const relay = ref(null)
watch(() => [session.value, r.value.jobId], ([on, id], old) => {
  if (old && old[1] !== id) { relay.value?.close(); relay.value = null }
  if (on && !relay.value) relay.value = openRelay(id, { streams: [view.value === 'term' ? 'term' : 'tx'] })
}, { immediate: true })
// ---------- waiting for its people after the turn ----------
const idleLeft = computed(() => (r.value.idleUntil && r.value.state === 'running' ? Math.max(0, new Date(r.value.idleUntil).getTime() - now.value) : null))
const idleWords = computed(() => { const ms = idleLeft.value; if (ms == null) return ''; const m = Math.ceil(ms / 60000); return ms >= 60000 ? `${m}분` : `${Math.max(1, Math.ceil(ms / 1000))}초` })
const tone = computed(() => ({ queued: 'wait', offered: 'wait', running: 'run', done: 'ok', failed: 'bad', delegated: 'info', cancelled: 'info' }[r.value.state] || 'info'))
const pill = computed(() => (r.value.state === 'running' && r.value.steering ? '방향 전달 중' : r.value.state === 'running' && idleLeft.value != null ? '끝내기 기다림'
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
// 이 · 가 by the name's last syllable (src/josa.js)
const ga = (w) => josa(w)
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
// 「끝내기」: the owner ends the run now (it waits after the turn for the people on the instance)
async function finish() {
  busy.value = 'finish'; said.value = ''
  try { show(await api(`/local-agents/jobs/${encodeURIComponent(r.value.jobId)}/finish`, { method: 'POST' })); said.value = '끝내는 중이에요 — 결과를 올려요' } catch (e) { said.value = e.message } finally { busy.value = '' }
}
// 「기본으로 다시 보내기」: the run stops; the words that got no answer go to the server's agent in the same chat
async function fallback() {
  busy.value = 'fallback'; said.value = ''
  try {
    const res = await api(`/local-agents/jobs/${encodeURIComponent(r.value.jobId)}/fallback`, { method: 'POST' })
    if (res.text && res.threadId) app.send(res.text, res.threadId, undefined, undefined, { agent: 'default' })
    said.value = '기본 에이전트에게 다시 보냈어요'
  } catch (e) { said.value = e.message } finally { busy.value = '' }
}
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
        <small v-if="r.chat" data-test="local-run-where"><template v-if="r.folder">{{ r.folder.mode === 'project' ? '프로젝트 폴더' : '내 폴더' }} 「{{ r.folder.name }}」</template><template v-else>이 대화</template><template v-if="elapsed"> · <span data-test="local-run-elapsed">{{ elapsed }}</span></template></small>
        <small v-else>「{{ r.activity }}」 단계<template v-if="r.mode === 'draft'"> · 초안</template><template v-if="elapsed"> · <span data-test="local-run-elapsed">{{ elapsed }}</span></template></small>
      </div>
      <span class="pill" data-test="local-run-state">{{ pill }}</span>
    </div>
    <p class="st" data-test="local-run-text">{{ r.text }}</p>

    <!-- the CLI's session: its conversation or its terminal (or its last lines), the steers that went in, the suggestions waiting at its
         input, the input -->
    <div v-if="lines.length || r.steers?.length || live || session" class="term" data-test="local-run-term">
      <template v-if="session && relay">
        <div class="views" role="tablist" data-test="local-run-views">
          <button v-for="v in views" :key="v[0]" type="button" role="tab" class="vt press" :class="{ on: view === v[0] }" :aria-selected="view === v[0]"
            :data-view="v[0]" data-test="local-run-view" @click="setView(v[0])">{{ v[1] }}</button>
        </div>
        <LocalConversation v-if="shown.chat" v-show="view === 'chat'" :key="`c-${r.jobId}`" :relay="relay" :run="r" />
        <LocalTerminal v-if="shown.term" v-show="view === 'term'" :key="`t-${r.jobId}`" :relay="relay" :agent="r.agent" />
      </template>
      <ol v-else-if="lines.length" ref="out" class="lines" data-test="local-run-lines">
        <li v-for="(l, i) in lines" :key="i" :class="l.kind"><span class="mk">{{ mark[l.kind] ?? '' }}</span><span>{{ l.text }}</span></li>
      </ol>
      <!-- (a chat's run: what its owner sent is in the chat itself) -->
      <ul v-if="r.steers?.length && !r.chat" class="steers" data-test="local-run-steers">
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
      <!-- after the CLI's turn: the run waits for its people — the owner ends it, or it ends by itself -->
      <div v-if="idleLeft != null" class="idle" data-test="local-run-idle">
        <template v-if="r.worker">
          <small data-test="local-run-idle-text">{{ idleWords }} 동안 새 입력이 없으면 저절로 끝나요</small>
          <button type="button" class="fin press" :disabled="!!busy" data-test="local-run-finish" @click="finish">끝내기</button>
        </template>
        <small v-else data-test="local-run-idle-text">{{ r.person || '실행하는 사람' }}님이 끝내기를 기다려요 — 지금 제안하면 이어서 입력할 수 있어요 · {{ idleWords }} 뒤 저절로 끝나요</small>
      </div>
      <!-- a chat's run: its input is the chat's composer -->
      <small v-if="live && r.worker && r.chat" class="loaded" data-test="local-run-chat-hint">이어서 말하려면 아래 입력창에 쓰세요 — 같은 세션에 들어가요</small>
      <!-- the worker: the CLI's input -->
      <form v-else-if="live && r.worker" class="input" @submit.prevent="send">
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
    <button v-if="r.chat && r.canFallback" class="handoff press" :disabled="!!busy" data-test="local-run-fallback" @click="fallback">기본으로 다시 보내기</button>
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
/* the session: the two views, then what went in, the suggestions, the input — in Lite's tokens (light and dark) */
.term { border-radius: 16px; background: var(--cell-bg); color: var(--text-primary); font-size: 13px; padding: 8px; border: 1px solid var(--hairline);
  display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.term ol, .term ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.views { display: inline-flex; align-self: flex-start; gap: 2px; padding: 2px; border-radius: 12px; background: var(--button-bg); }
.vt { height: 28px; padding: 0 14px; border-radius: 10px; font-size: 13px; color: var(--text-secondary); }
.vt.on { background: var(--regular-solid-bg); color: var(--text-primary); font-weight: 600; box-shadow: 0 1px 3px rgba(0 0 0 / .12); }
.lines { max-height: 220px; overflow-y: auto; font-family: "SF Mono", Menlo, monospace; font-size: 12.5px; }
.compact .lines { max-height: 90px; }
.lines li { display: flex; gap: 6px; min-width: 0; }
.lines li span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.lines li.tool { color: var(--text-secondary); }
.lines li.steer { color: var(--color-info); }
.lines li.error { color: var(--color-error); }
.lines li.status { color: var(--text-tertiary); }
.mk { flex: none; width: 10px; color: var(--text-tertiary); }
.steers { border-top: 1px dashed var(--hairline); padding-top: 6px !important; }
.steers li { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; min-width: 0; }
.steers .mk { color: var(--color-info); }
.steers .tx { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
.steers small { color: var(--text-secondary); flex: none; }
.steers li.applied small { color: var(--color-success); }
.steers li.failed small { color: var(--color-error); flex: 1 1 100%; }
.who { font-weight: 600; margin-right: 4px; }
.sugs { border-top: 1px dashed var(--hairline); padding-top: 6px !important; gap: 4px !important; }
.sugs li { display: flex; align-items: flex-start; gap: 4px; min-width: 0; }
.chip { flex: 1; min-width: 0; text-align: left; display: flex; flex-wrap: wrap; gap: 2px 6px; align-items: baseline; padding: 7px 10px; border-radius: 12px; background: var(--chip-bg); color: var(--text-primary);
  font: inherit; border: 1px solid var(--hairline); }
.chip.on { border-color: var(--color-info); box-shadow: 0 0 0 1px var(--color-info); }
.chip .tx { flex: 1 1 140px; min-width: 0; overflow-wrap: anywhere; }
.chip small { color: var(--text-secondary); flex: none; }
.chip.static { opacity: .9; }
.sugs li.used .chip small { color: var(--color-success); }
.sugs li.dismissed .chip { opacity: .5; text-decoration: line-through; }
.sugs li.decision .chip { border-color: color-mix(in srgb, var(--color-info) 60%, transparent); }
.x { width: 26px; height: 26px; border-radius: 13px; color: var(--text-secondary); font-size: 18px; flex: none; }
.idle { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 10px; border-radius: 12px; background: color-mix(in srgb, var(--color-info) 12%, transparent); min-width: 0; }
.idle small { flex: 1 1 180px; min-width: 0; color: var(--text-primary); font-size: 12.5px; overflow-wrap: anywhere; }
.fin { height: 32px; padding: 0 16px; border-radius: 16px; background: var(--ink); color: var(--ink-inverse); font-size: 13px; font-weight: 600; flex: none; }
.fin:disabled { opacity: .4; }
.input { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--hairline); padding-top: 8px; min-width: 0; }
.input .row { display: flex; gap: 6px; align-items: center; min-width: 0; }
.prompt { color: var(--color-success); flex: none; font-family: "SF Mono", Menlo, monospace; }
.input input { flex: 1; min-width: 0; width: 100%; height: 36px; border-radius: 12px; padding: 0 12px; background: var(--field-bg); border: 1px solid var(--hairline); color: var(--text-primary); font: inherit; font-size: 16px; }
.input .row button { width: 36px; height: 36px; border-radius: 18px; background: var(--ink); color: var(--ink-inverse); display: grid; place-items: center; flex: none; }
.input .row button:disabled { opacity: .35; }
.loaded { color: var(--text-secondary); font-size: 11.5px; overflow-wrap: anywhere; }
.lnk { color: var(--color-info); text-decoration: underline; background: none; padding: 0; font: inherit; }
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
