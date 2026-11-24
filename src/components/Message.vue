<script setup>
import { computed, ref, onMounted } from 'vue'
import { marked } from 'marked'
import { api } from '../api.js'
// (sandbox and host paths in an answer read as file names: src/paths.js)
import { hidePaths } from '../paths.js'
import SkillShareCard from './SkillShareCard.vue'
import Icon from './Icon.vue'
import TaskCard from './TaskCard.vue'
import VaultCard from './VaultCard.vue'
import PolicyCard from './PolicyCard.vue'
import BriefCard from './BriefCard.vue'
import OptimizeCard from './OptimizeCard.vue'
import TelegramConnect from './TelegramConnect.vue'
import ProcessCard from './ProcessCard.vue'
import TodoCard from './TodoCard.vue'
import ProcessDraftCard from './ProcessDraftCard.vue'
import SkillDraftCard from './SkillDraftCard.vue'
import ChoiceCard from './ChoiceCard.vue'
import ShareButton from './team/ShareButton.vue'
import FolderSuggest from './folders/FolderSuggest.vue'
import ImproveCard from './improve/ImproveCard.vue'
import ReferChips from './context/ReferChips.vue'
import RepeatCard from './context/RepeatCard.vue'
import FollowupCard from './FollowupCard.vue'
import OntoSummaryCard from './ontology/OntoSummaryCard.vue'
import OntoEntryCard from './ontology/OntoEntryCard.vue'
import OntoHabitCard from './ontology/OntoHabitCard.vue'
import OntoStepCard from './ontology/OntoStepCard.vue'
import OntoHabitShareCard from './ontology/OntoHabitShareCard.vue'
import OntoTimerAskCard from './ontology/OntoTimerAskCard.vue'
import OntoEditCard from './ontology/OntoEditCard.vue'
import MailChips from './MailChips.vue'
import { useRouter } from 'vue-router'
import { useApp } from '../stores/app.js'
import { officeEditorFor, craftMissing } from '../officeEditor.js'
import { kindOf, kindLabel, openArtifact, openHint } from '../artifacts.js'
import { parseReplies } from '../replies.js'

const props = defineProps({ msg: Object })
const emit = defineEmits(['connect'])
const openFile = () => openArtifact(app, router, props.msg)
const expanded = ref(false)
const router = useRouter()
const app = useApp()
const instStatus = { RUNNING: '진행 중', COMPLETED: '완료', NEW: '시작 전' }
const c = computed(() => props.msg.content || {})
// a link into the agent's sandbox ("[견적서.xlsx](</workspace/…/견적서.xlsx>)") opens nothing here — its file card does
const SANDBOX_LINK = /\[([^\]\n]+)\]\(<?(?:sandbox:)?\/workspace\/[^)>\n]*>?\)/g
// model output is rendered as markdown, never as raw HTML
// (then any other sandbox or host path reads as its file name: src/paths.js)
const md = (t) => marked.parse(hidePaths(String(t || '').replace(SANDBOX_LINK, '$1')).replace(/&/g, '&amp;').replace(/</g, '&lt;'), { breaks: true })
const doc = computed(() => {
  if (props.msg.kind !== 'doc') return null
  const [first, ...rest] = c.value.text.split('\n')
  return { title: first.replace(/^#\s*/, ''), body: md(rest.join('\n')) }
})
const time = computed(() => new Date(props.msg.created_at).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
const panelReq = computed(() => (/^새 패널 만들기:\s*/.test(c.value.text || '') ? c.value.text.replace(/^새 패널 만들기:\s*/, '') : null))
// "- 네, 이대로 진행 (설명)" style options closing an agent question become tappable replies
// (src/replies.js: only a real choice list — a report's bullet lines stay text)
const replies = computed(() => (props.msg.role === 'agent' && props.msg.kind === 'text' && !c.value.stopped ? parseReplies(c.value.text) : null))
const chipIcon = { clock: 'clock', panel: 'panel', check: 'check', bell: 'bell', refresh: 'refresh', folder: 'folder' }
// the mails a message is about (모닝 브리프: its Home cards; a line about one mail): chips that open them (MailChips, server lib/mailFlow.js)
const mailRefs = computed(() => (Array.isArray(c.value.mails) ? c.value.mails : c.value.mail && (c.value.mail.actionId || c.value.mail.mailId) ? [c.value.mail] : []))
// what the answer did on the way (server lib/workTrail.js): folded to one line of the sites it read
const workOpen = ref(false)
const work = computed(() => (Array.isArray(c.value.work) ? c.value.work : []))
const workHosts = computed(() => [...new Set(work.value.flatMap((w) => w.hosts || []))])
const workLine = computed(() => {
  if (!work.value.length) return ''
  const steps = work.value.reduce((n, w) => n + (w.n || 1), 0)
  const where = workHosts.value.length ? ` · 조회한 곳 ${workHosts.value.slice(0, 2).join(', ')}${workHosts.value.length > 2 ? ` 외 ${workHosts.value.length - 2}곳` : ''}` : ''
  return `어떻게 했나요 · ${steps}단계${where}`
})
const workWhere = (w) => [w.hosts?.join(', '), w.query && `「${w.query}」`, w.file].filter(Boolean).join(' · ')
const ctx = computed(() => (c.value.context && c.value.context.action !== 'stay' && c.value.context.title ? c.value.context : null))
const byName = { judge: '판단 모델', logprob: 'logprob', json: 'json', pinned: '대화에서 직접', trivial: '', none: '' }
const ctxBy = computed(() => (ctx.value ? (ctx.value.rechecked ? '판단 모델 재확인→logprob' : ctx.value.escalated ? '판단 모델→logprob' : byName[ctx.value.strategy] ?? ctx.value.strategy) : ''))
const ctxWhy = computed(() => (ctx.value ? `${ctx.value.action === 'new' ? '새 대화로 시작' : '이 대화로 이어감'} · ${ctxBy.value} 확신도 ${ctx.value.confidence ?? '-'}` : ''))

// a sound or video file gets a player under its card, by its name or by the type it was stored with (a site's
// download named only "download" is typed from its bytes: server lib/fileSniff.js). One the agent left in its
// workspace has no address yet: it is published once (POST /messages/:id/open-file, as opening it does) so the
// player is ready before it is pressed.
const SOUND = /\.(mp3|m4a|wav|ogg|oga|opus|aac|flac)$/i
const VIDEO = /\.(mp4|m4v|webm|mov)$/i
const fileName = computed(() => String(c.value.name || c.value.url || '').split('?')[0])
const sound = computed(() => props.msg.kind === 'file' && (SOUND.test(fileName.value) || String(c.value.type || '').startsWith('audio/')))
const video = computed(() => props.msg.kind === 'file' && !sound.value && (VIDEO.test(fileName.value) || String(c.value.type || '').startsWith('video/')))
const resolved = ref('')
const soundErr = ref('')
const soundUrl = computed(() => c.value.url || resolved.value)
onMounted(async () => {
  if (!(sound.value || video.value) || c.value.url || !c.value.path) return
  try { resolved.value = (await api(`/messages/${encodeURIComponent(props.msg.id)}/open-file`, { method: 'POST' }))?.url || '' } catch (e) { soundErr.value = `재생할 파일을 가져오지 못했어요 · ${e.message}` }
})
</script>

<template>
  <div class="row" :data-id="msg.id" :class="[`r-${msg.role}`, `k-${msg.kind}`, { pinned: msg.kind === 'task' && c.state === 'running', needs: c.state === 'needs_input' || c.state === 'pending' }]">
    <span v-if="msg.kind !== 'divider'" class="ts">{{ time }}</span>

    <!-- which context this answer belongs to, as the context-router decided (hark-style threads) -->
    <div v-if="msg.role === 'agent' && ctx" role="link" tabindex="0" @click="ctx.conversationId && router.push(`/chat/c/${encodeURIComponent(ctx.conversationId)}`)" class="ctx" :class="ctx.action" :title="ctxWhy">
      <span class="arrow">↳</span><span class="tt">{{ ctx.action === 'new' ? '새 주제 · ' : '' }}{{ ctx.title }}</span>
      <small v-if="ctxBy" class="by" :class="ctx.escalated || ctx.rechecked ? 'escalated' : ctx.strategy">{{ ctxBy }} {{ ctx.confidence != null ? ctx.confidence.toFixed(2) : '' }}</small>
    </div>
    <!-- a scheduled run's output is introduced by its task, tappable to manage it (hark) -->
    <button v-if="msg.kind === 'divider' && c.scheduleId" class="sched press" @click="router.push(`/settings/schedules?open=${c.scheduleId}`)"><Icon name="clock" :size="15" /> {{ c.text }} 관리</button>
    <div v-else-if="msg.kind === 'divider'" class="divider">{{ c.text }}</div>

    <template v-else-if="msg.kind === 'text' && msg.role === 'user'">
      <span v-if="panelReq" class="req">새 패널 만들기</span>
      <div class="bubble user">{{ panelReq ?? c.text }}</div>
      <!-- sent while an answer of the same conversation was still coming: it waits its turn (lib/turns.js) -->
      <small v-if="c.fresh" class="queue">새로 하기 · 이전 답 대신 새로 만들어요</small>
      <small v-if="c.fromHabit" class="queue" data-testid="from-habit">습관 · 제안을 수락했어요</small>
      <small v-if="c.queued" class="queue">대기 · 앞 답이 끝나면 이어서 답해요</small>
      <small v-else-if="c.dropped" class="queue">서버가 다시 시작되어 이 요청은 답하지 못했어요 · 다시 보내 주세요</small>
      <!-- 팀 맥락 공유: 이 요청에 붙인 다른 대화 맥락(답 위 칩) -->
      <ReferChips v-if="c.refer" part="used" :refer="c.refer" :thread="msg.thread_id" :key="c.refer.refer_id || 'off'" />
    </template>
    <template v-else-if="msg.kind === 'text'">
      <div class="bubble agent md" v-html="md(replies ? replies.body : c.text)" />
      <MailChips v-if="mailRefs.length" :refs="mailRefs" :event="c.mailEvent || ''" />
      <!-- 회사 프로세스 지도의 업무 에이전트: 일 정의의 점검 항목마다 지켰는지(근거는 마우스를 올리면) -->
      <ul v-if="c.checks?.length" class="checks" data-testid="onto-checks">
        <li v-for="(x, i) in c.checks" :key="i" :class="x.ok === true ? 'ok' : x.ok === false ? 'no' : 'na'" :title="x.note"><b>{{ x.ok === true ? '✓' : x.ok === false ? '✗' : '?' }}</b><span>{{ x.checkpoint }}</span></li>
      </ul>
      <div v-if="workLine" class="work" :class="{ open: workOpen }" data-test="work-trail">
        <button class="wl press" :aria-expanded="workOpen" @click="workOpen = !workOpen">{{ workLine }} <span class="car">{{ workOpen ? '▴' : '▾' }}</span></button>
        <ol v-if="workOpen">
          <li v-for="(w, i) in work" :key="i"><b>{{ w.phase || w.tool }}</b><template v-if="w.n > 1"> ×{{ w.n }}</template><small v-if="workWhere(w)">{{ workWhere(w) }}</small></li>
        </ol>
      </div>
      <div v-if="replies" class="replies">
        <button v-for="o in replies.options" :key="o.label" class="reply press" :title="o.hint" @click="app.send(o.label, msg.thread_id)">{{ o.label }}</button>
      </div>
    </template>

    <div v-else-if="doc" class="doc" :class="{ open: expanded }">
      <h3 class="serif">{{ doc.title }}</h3>
      <div class="inner md" v-html="doc.body" />
      <button class="more press" :aria-label="expanded ? '접기' : '펼치기'" @click="expanded = !expanded">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :style="{ rotate: expanded ? '180deg' : '0deg' }"><path d="M6 9l6 6 6-6" /></svg>
      </button>
    </div>

    <TaskCard v-else-if="msg.kind === 'task'" :msg="msg" />
    <VaultCard v-else-if="msg.kind === 'vault'" :msg="msg" />
    <!-- Agentic BPM (docs/agentic-bpm): a policy decision, a decision brief, the alternatives of a blocked action -->
    <PolicyCard v-else-if="msg.kind === 'policy'" :msg="msg" />
    <!-- 같은 요청 알아보기: 이미 한 요청이면 에이전트 대신 이 카드 -->
    <RepeatCard v-else-if="msg.kind === 'repeat'" :msg="msg" />
    <!-- 후행 습관: 결과물 뒤에 평소 하던 다음 일을 먼저 묻는다 -->
    <FollowupCard v-else-if="msg.kind === 'followup'" :msg="msg" />
    <!-- 회사 프로세스 지도: 지도 요약 · 들어온 메일의 시작 일 · 열린 일의 다음 걸음 -->
    <OntoSummaryCard v-else-if="msg.kind === 'onto-summary'" :msg="msg" />
    <OntoEntryCard v-else-if="msg.kind === 'onto-entry'" :msg="msg" />
    <OntoHabitCard v-else-if="msg.kind === 'onto-habit'" :msg="msg" />
    <OntoStepCard v-else-if="msg.kind === 'onto-step'" :msg="msg" />
    <OntoHabitShareCard v-else-if="msg.kind === 'habit-share'" :msg="msg" />
    <OntoTimerAskCard v-else-if="msg.kind === 'onto-timer'" :msg="msg" />
    <!-- 말로 프로세스 지도 고치기: 고친 뒤 그림 · 적용 · 의견으로 남기기 -->
    <OntoEditCard v-else-if="msg.kind === 'onto-edit'" :msg="msg" />
    <BriefCard v-else-if="msg.kind === 'brief'" :msg="msg" />
    <OptimizeCard v-else-if="msg.kind === 'optimize'" :msg="msg" />
    <!-- 「텔레그램으로 알려줘」 before a bot is connected: connect it right here (server lib/agent.js telegramTurn) -->
    <div v-else-if="msg.kind === 'telegram_connect'" class="tgc"><TelegramConnect :schedule-name="c.scheduleName || ''" /></div>
    <ChoiceCard v-else-if="msg.kind === 'choice'" :msg="msg" />
    <ProcessCard v-else-if="msg.kind === 'process'" :msg="msg" />
    <ProcessDraftCard v-else-if="msg.kind === 'process_draft'" :msg="msg" />
    <SkillDraftCard v-else-if="msg.kind === 'skill_draft'" :msg="msg" />
    <TodoCard v-else-if="msg.kind === 'todo'" :todo-id="c.todoId" :msg-id="msg.id" :done="c.state === 'submitted'" />

    <div v-else-if="msg.kind === 'catalog'" class="list glass">
      <div class="lh">시작할 수 있는 프로세스 {{ c.items.length }}개</div>
      <button v-for="d in c.items" :key="d.id" class="li press" @click="app.send(`'${d.name}' 프로세스 보여줘`)">
        <b>{{ d.name }}</b><small v-if="d.description">{{ d.description }}</small>
      </button>
    </div>
    <div v-else-if="msg.kind === 'instances'" class="list glass">
      <div class="lh">{{ c.title || `진행 중인 프로세스 ${c.items.length}건` }}</div>
      <button v-for="it in c.items" :key="it.proc_inst_id + (it.activity || '')" class="li press" @click="router.push(`/routines/${encodeURIComponent(it.proc_inst_id)}`)">
        <b>{{ it.activity || it.proc_inst_name || it.def_name }}</b>
        <small><template v-if="it.activity">{{ it.proc_inst_name || it.def_name }}</template><template v-else>{{ it.def_name }} · {{ instStatus[it.status] || it.status }}</template><span v-if="it.needs_me" class="me"> · 입력 필요</span></small>
      </button>
      <p v-if="!c.items.length" class="empty">진행 중인 프로세스가 없어요.</p>
    </div>

    <div v-else-if="msg.kind === 'file'" class="filecol" :class="{ sound, video }">
      <div class="filerow">
        <button class="file press" @click="openFile">
          <span class="fic" :class="sound ? 'snd' : kindOf(c.name)">{{ sound ? kindLabel.snd : kindLabel[kindOf(c.name)] || 'FILE' }}</span>
          <span class="fmeta"><b>{{ c.name }}</b><small><span v-if="c.review" class="reviewed" :class="{ warn: !c.review.ok }" :title="c.review.summary">{{ c.review.ok ? '검수됨' : '검수 확인 필요' }}</span><template v-if="c.shared">{{ c.shared.by }}님이 공유 · </template>{{ officeEditorFor(c.name) && c.url && !craftMissing(officeEditorFor(c.name)) ? (c.edited ? '편집본 · 눌러서 이어 편집' : '눌러서 바로 편집') : openHint(c) }}</small></span>
        </button>
        <!-- 팀원에게 공유 (components/team) -->
        <ShareButton :msg="msg" compact />
      </div>
      <!-- hark: a sound the work made plays right here, on the phone too (recording 2026-11-21) -->
      <audio v-if="sound && soundUrl" class="player" controls preload="none" :src="soundUrl" data-testid="file-audio" />
      <video v-else-if="video && soundUrl" class="vplayer" controls playsinline preload="metadata" :src="soundUrl" data-testid="file-video" />
      <small v-else-if="(sound || video) && soundErr" class="playerr">{{ soundErr }}</small>
      <!-- 폴더에 정리: a document that came in (attached, or made by the agent, or sent by a teammate) — not one opened from a folder -->
      <FolderSuggest v-if="(c.url || c.path) && !c.folder" :message-id="msg.id" :filing="c.filing" />
    </div>

    <!-- an agent's change in a shared folder: a variation to review and merge (lib/folders/work.js) -->
    <button v-else-if="msg.kind === 'folder_variation'" class="fvar press" @click="router.push(c.url)">
      <span class="fvh"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 4v10M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 10c0 4-6 3-12 6" /></svg>
        {{ c.skill ? `스킬 ${c.skill}` : c.folderName }} · 새 변형</span>
      <b>{{ c.title }}</b>
      <small v-if="c.summary">{{ c.summary }}</small>
      <span class="fvf">{{ (c.files || []).map((f) => f.name || f.path?.split('/').pop()).join(', ') }}</span>
      <span class="fvgo">{{ c.requested ? `반영 요청을 보냈어요 · ${c.requested.to} 님 검토 대기 →` : '검토하고 반영하기 →' }}</span>
    </button>
    <!-- process improvement numbers the assistant explained (lib/agent.js improveTurn) -->
    <ImproveCard v-else-if="msg.kind === 'improve'" :c="c" />
    <SkillShareCard v-else-if="msg.kind === 'skill_share'" class="sharecard" :skill="c.skill" :folder="c.folder" :after="c.after" />

    <button v-else-if="msg.kind === 'connect'" class="connect press" :class="{ done: c.state === 'done' }" :disabled="c.state === 'done'" @click="emit('connect')">
      <Icon v-if="c.state === 'done'" name="check" :size="16" />
      <svg v-else width="16" height="16" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      {{ c.state === 'done' ? (c.doneText || '메일 연결됨') : c.text }}
    </button>

    <!-- a chip about an instance (a step waiting for me, a finished run) opens its page (server lib/engine.js) -->
    <!-- a chip about a folder (the work folder of an instance started from a mail — server lib/mailWork.js) opens it -->
    <button v-else-if="msg.kind === 'chip' && c.folder" class="chip link press" data-test="folder-chip" @click="router.push(`/folders/${encodeURIComponent(c.folder)}`)">
      <Icon :name="chipIcon[c.icon] || 'folder'" :size="16" /> <span class="ct">{{ c.text }}</span> <Icon name="chevron" :size="14" />
    </button>
    <button v-else-if="msg.kind === 'chip' && c.instId" class="chip link press" @click="router.push(`/routines/${encodeURIComponent(c.instId)}`)">
      <Icon :name="chipIcon[c.icon] || 'check'" :size="16" /> <span class="ct">{{ c.text }}</span> <Icon name="chevron" :size="14" />
    </button>
    <div v-else-if="msg.kind === 'chip'" class="chip"><Icon :name="chipIcon[c.icon] || 'check'" :size="16" /> {{ c.text }}</div>
    <!-- 팀 맥락 공유: 관계있지만 아직 볼 수 없는 팀원의 맥락(답 아래 요청 후보) -->
    <ReferChips v-if="msg.role === 'agent' && c.refer_id" part="requestable" :refer-id="c.refer_id" :thread="msg.thread_id" />
    <!-- a document answer's trail too (its card is above; the text answer has it under its bubble) -->
    <div v-if="workLine && msg.kind === 'doc'" class="work" :class="{ open: workOpen }" data-test="work-trail">
      <button class="wl press" :aria-expanded="workOpen" @click="workOpen = !workOpen">{{ workLine }} <span class="car">{{ workOpen ? '▴' : '▾' }}</span></button>
      <ol v-if="workOpen">
        <li v-for="(w, i) in work" :key="i"><b>{{ w.phase || w.tool }}</b><template v-if="w.n > 1"> ×{{ w.n }}</template><small v-if="workWhere(w)">{{ workWhere(w) }}</small></li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.checks { list-style: none; margin: 6px 0 0; padding: 10px 14px; border-radius: 14px; border: 1px solid var(--hairline); display: flex; flex-direction: column; gap: 5px; font-size: 13px; max-width: 560px; }
.checks li { display: flex; gap: 8px; line-height: 1.45; color: var(--text-secondary); }
.checks b { flex: none; width: 14px; text-align: center; }
.checks .ok b { color: var(--color-success, #1a7f37); }
.checks .no b { color: var(--color-danger, #d1242f); }
.checks .no span { color: var(--text-primary); }
/* the last 검수 of an edited copy (lib/review.js) */
.reviewed { display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 8px; font-size: 11px; font-weight: 600; background: rgba(60, 190, 120, .22); color: #8fe0a8; }
.reviewed.warn { background: rgba(240, 160, 40, .22); color: #ffc46b; }
.row { position: relative; display: flex; flex-direction: column; align-items: flex-start; min-width: 0; max-width: 100%; animation: blur-in .5s var(--spring) both; }
.row.r-user { align-items: flex-end; }
/* a running browser task stays in view while the conversation scrolls under it */
.row.pinned { position: sticky; top: 0; z-index: 4; }
.row.k-task { align-self: stretch; }
.ts { position: absolute; right: calc(100% + 24px); top: 50%; translate: 0 -50%; white-space: nowrap; font-size: 14px; color: var(--text-secondary); opacity: 0; transition: opacity .2s; pointer-events: none; text-align: right; }
.row.r-user .ts { right: auto; left: -160px; }
.row:hover .ts { opacity: 1; }
.req { font-size: 14px; color: var(--text-secondary); margin: 0 6px 6px 0; }
.queue { display: block; text-align: right; font-size: 12.5px; color: var(--text-tertiary); margin: 4px 8px 0 0; }
.work { max-width: min(424px, 100%); margin-top: 4px; font-size: 12.5px; color: var(--text-secondary); }
.work .wl { text-align: left; padding: 4px 8px; border-radius: 10px; color: var(--text-secondary); font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
.work .car { font-size: 10px; }
.work ol { margin: 4px 0 0; padding: 8px 12px 8px 28px; border-radius: 14px; background: var(--bubble-agent-bg); }
.work li { margin: 2px 0; line-height: 1.45; overflow-wrap: anywhere; }
.work li b { font-weight: 500; color: var(--text-primary); }
.work li small { display: block; color: var(--text-tertiary); }
.tgc { width: min(424px, 100%); }
/* never wider than the column: a phone's column is narrower than 424px, and a wide table inside used to push
   the bubble past the screen's right edge (2026-11-21 recording) */
.bubble { max-width: min(424px, 100%); min-width: 0; border-radius: 24px; padding: 13px 18px; font-size: 16px; line-height: 1.6; word-break: keep-all; overflow-wrap: anywhere; transition: background-color 1s; }
.bubble.agent { background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); }
.bubble.user { background: var(--bubble-user-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); max-width: 512px; white-space: pre-wrap; }
.md :deep(p) { margin: 0 0 .6em; } .md :deep(p:last-child) { margin: 0; }
.md :deep(ul), .md :deep(ol) { margin: .2em 0 .6em; padding-left: 1.2em; }
.md :deep(strong) { font-weight: 600; }
.md :deep(code) { font-size: .9em; background: var(--cell-bg); padding: 1px 5px; border-radius: 6px; }
.md :deep(h1), .md :deep(h2), .md :deep(h3) { font-size: 16px; font-weight: 600; margin: .6em 0 .3em; }
/* a wide table or a long code block scrolls sideways inside the bubble; a cell breaks between words, never
   inside a short one (the bubble's overflow-wrap:anywhere let the table squeeze "Chime" into "Chim/e") */
.md :deep(table) { border-collapse: collapse; font-size: 14px; display: block; max-width: 100%; overflow-x: auto; } .md :deep(td), .md :deep(th) { padding: 4px 8px; border-bottom: 1px solid var(--hairline); overflow-wrap: normal; }
.md :deep(pre) { max-width: 100%; overflow-x: auto; margin: .2em 0 .6em; padding: 10px 12px; border-radius: 12px; background: var(--cell-bg); font-size: 13.5px; line-height: 1.5; }
.md :deep(pre code) { padding: 0; background: none; white-space: pre; overflow-wrap: normal; word-break: normal; }
.doc { position: relative; width: 424px; max-width: 100%; border-radius: 24px; padding: 8px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); }
.doc h3 { font-size: 24px; font-weight: 400; letter-spacing: .02em; margin: 14px 14px 16px; line-height: 1.3; }
.doc .inner { background: var(--cell-bg); border-radius: 16px; padding: 14px 16px; font-size: 15px; line-height: 1.55; max-height: 150px; overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 60%, transparent); mask-image: linear-gradient(#000 60%, transparent); transition: max-height .5s var(--spring); }
.doc.open .inner { max-height: 4000px; -webkit-mask-image: none; mask-image: none; }
.doc .more { position: absolute; left: 50%; bottom: -14px; translate: -50% 0; width: 32px; height: 32px; border-radius: 9999px; display: grid; place-items: center; background: var(--regular-solid-bg); box-shadow: 0 2px 10px rgba(0 0 0 / .1); }
.doc .more svg { transition: rotate .3s; }
.file { display: inline-flex; align-items: center; gap: 12px; height: 64px; padding: 0 22px; border-radius: 22px; background: #1d1d1f; color: #f5f5f7; font-size: 16px; font-weight: 500; }
.file { text-align: left; }
.filerow { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; }
.filerow .file { min-width: 0; }
.filecol { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; max-width: 100%; }
.filecol.sound, .filecol.video { width: 424px; }
/* the browser's own controls (play, seek, volume, download) — big enough for a thumb */
.player { display: block; width: 100%; height: 54px; border-radius: 27px; }
.vplayer { display: block; width: 100%; max-height: 320px; border-radius: 16px; background: #000; }
.playerr { font-size: 12.5px; color: var(--text-tertiary); margin-left: 6px; }
.fvar { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 424px; max-width: 100%; padding: 14px 18px; border-radius: 22px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); text-align: left; }
.fvh { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); }
.fvar b { font-size: 16px; font-weight: 500; line-height: 1.35; }
.fvar small { font-size: 13.5px; color: var(--text-secondary); line-height: 1.5; }
.sharecard { width: 424px; max-width: 100%; }
.fvf { font-size: 12.5px; color: var(--text-tertiary); }
.fvgo { margin-top: 6px; font-size: 13.5px; font-weight: 500; color: var(--color-info); }
.fic { flex: none; width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.md { background: #3d4451; } .fic.txt { background: #5f6670; } .fic.web { background: #e44d26; } .fic.map { background: #b8860b; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; }
.fmeta { display: flex; flex-direction: column; min-width: 0; }
.fmeta b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fmeta small { color: rgba(245, 245, 247, .62); font-size: 12.5px; }
.connect { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); font-size: 14px; font-weight: 500; box-shadow: 0 2px 12px rgba(0 0 0 / .06); }
.connect.done { background: var(--bubble-user-bg); color: var(--text-primary); }
.chip { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 14px; border-radius: 9999px; background: var(--bubble-user-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); font-size: 14px; }
.chip.link { max-width: 100%; text-align: left; color: var(--text-primary); }
.chip.link .ct { min-width: 0; word-break: keep-all; overflow-wrap: anywhere; }
.chip.link > :deep(svg) { flex: none; }
.replies { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.reply { height: 36px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); animation: pop-in .4s var(--spring) both; }
.list { width: 424px; max-width: 100%; border-radius: 24px; padding: 8px; display: flex; flex-direction: column; --regular-bg: var(--bubble-agent-bg); }
.lh { font-size: 13px; color: var(--text-secondary); margin: 10px 12px 6px; }
.li { text-align: left; padding: 12px; border-radius: 16px; display: flex; flex-direction: column; gap: 3px; }
.li:hover { background: var(--cell-bg); }
.li b { font-weight: 500; font-size: 15px; line-height: 1.35; }
.li small { color: var(--text-secondary); font-size: 13px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.me { color: var(--color-attention); font-weight: 500; }
.empty { margin: 4px 12px 10px; font-size: 14px; color: var(--text-secondary); }
.ctx { cursor: pointer; display: inline-flex; align-items: center; gap: 7px; max-width: min(424px, 100%); min-height: 28px; padding: 3px 5px 3px 11px; border-radius: 9999px; background: var(--bubble-user-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); font-size: 13px; color: var(--text-primary); margin: 0 0 6px 2px; animation: blur-in .4s var(--spring) both; }
.ctx .arrow { color: var(--text-secondary); }
.ctx .tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ctx .by { flex: none; font-size: 11.5px; padding: 2px 8px; border-radius: 9999px; color: #fff; background: #64748b; font-family: ui-monospace, Menlo, monospace; }
.ctx .by.judge { background: #0284c7; } .ctx .by.logprob { background: #7c3aed; } .ctx .by.escalated { background: linear-gradient(90deg, #0284c7, #7c3aed); }
.sched { display: inline-flex; align-items: center; gap: 7px; height: 36px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); color: var(--text-primary); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); margin-top: 6px; }
.row.k-divider { align-items: center; }
.divider { align-self: stretch; text-align: center; font-size: 14px; color: var(--text-tertiary); padding-top: 18px; border-top: 1px solid var(--hairline); margin-top: 10px; }
</style>
