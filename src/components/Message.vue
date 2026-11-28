<script setup>
import { computed, ref, onMounted, markRaw } from 'vue'
import { safeMarkdown } from '../safeMarkdown.js'
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
import MailOutCard from './MailOutCard.vue'
import PcProposalCard from './PcProposalCard.vue'
// 팀원에게 물어 채우기: 「○○님께 메신저로 물어볼까요?」 and what came back (server lib/askTeammate.js)
import AskTeamCard from './AskTeamCard.vue'
import ShareButton from './team/ShareButton.vue'
// 폴더에 정리 (server lib/folders/filing.js): a file card's — offered in its menu, a dot on the card while a suggestion waits
import { useFiling } from './folders/useFiling.js'
import FileCardMenu from './FileCardMenu.vue'
import HoldHint from './HoldHint.vue'
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
import LinkPreviews from './LinkPreviews.vue'
import LocalRunCard from './LocalRunCard.vue'
import MediaPreview from './MediaPreview.vue'
// 대화를 프로젝트로: 「프로젝트로 시작할까요?」 (server lib/chatProject.js)
import ProjectOfferCard from './ProjectOfferCard.vue'
import ConvMoveCard from './ConvMoveCard.vue'
// 답을 공유 · 프로젝트로 시작 · 폴더에 정리 … — in the message's menu: held on a phone, right-clicked or its ⋯ on a computer (2026-11-28 「화면이
// 정신없으니 하단의 공유, 프로젝트로 등록, 폴더 정리 등 모든 것들 콘텍스트 메뉴로. 모바일에선 길게 누를때」 — nothing under an answer or a file
// card but what it did and how)
import { hold } from './holdMenu.js'
import { showsActions, isAnswer } from '../answerActions.js'
import { holdHint, claimHint, closeHint, touchOnly } from '../holdHint.js'
import { useRouter } from 'vue-router'
import { useApp } from '../stores/app.js'
import { useTeam } from '../stores/team.js'
import { topicPath } from '../projectTopics.js'
import { officeEditorFor, craftMissing } from '../officeEditor.js'
import { kindOf, kindLabel, cardKind, openArtifact, openHint, viewHint, mediaKindOf, sawShare } from '../artifacts.js'
import { parseReplies } from '../replies.js'
// a file card is dragged like any file of the app (src/fileDrag.js): a messenger conversation (a link or a share), a folder, the composer
import { startDrag, cardItem } from '../fileDrag.js'
// a mail's attachment this message was about: opened again where it belongs (src/mailAttach.js)
import { openMailAttachment } from '../mailAttach.js'
import { dur } from '../turnView.js'

// narrowed: the chat shows one conversation (or a project one sub-topic) — the bar over the list already names it
const props = defineProps({ msg: Object, narrowed: Boolean })
const emit = defineEmits(['connect'])
const openFile = () => openArtifact(app, router, props.msg)
const dragCard = (e) => startDrag(e, [cardItem(props.msg)])
// a mail this message was about (a chip of the composer, a follow-up action of the mail sheet): its sheet
const openMail = (r) => app.openMailCard({ actionId: r.actionId }, app.instance ? 'instance' : 'chat').catch(() => {})
const attNote = ref('')
async function openAtt(r) {
  attNote.value = ''
  try {
    const x = await openMailAttachment(app, { actionId: r.actionId, i: r.i, name: r.name })
    if (x.how === 'download' && x.url) attNote.value = x.url
  } catch (e) { window.alert(e.message || '첨부를 열지 못했어요') }
}
const expanded = ref(false)
const router = useRouter()
const app = useApp()
const team = useTeam()
const instStatus = { RUNNING: '진행 중', COMPLETED: '완료', NEW: '시작 전' }
const c = computed(() => props.msg.content || {})
// a link into the agent's sandbox ("[견적서.xlsx](</workspace/…/견적서.xlsx>)") opens nothing here — its file card does
const SANDBOX_LINK = /\[([^\]\n]+)\]\(<?(?:sandbox:)?\/workspace\/[^)>\n]*>?\)/g
// model output is rendered as markdown, never as raw HTML (it reads as text; only plain document elements reach the page — src/safeMarkdown.js)
// (then any other sandbox or host path reads as its file name: src/paths.js)
const md = (t) => safeMarkdown(hidePaths(String(t || '').replace(SANDBOX_LINK, '$1')), { html: 'text' })
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
const chipIcon = { clock: 'clock', panel: 'panel', check: 'check', bell: 'bell', refresh: 'refresh', folder: 'folder', send: 'up' }
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
// the plan this answer worked to (server lib/turnPlan.js saved): folded to 「계획 3/3 · 2분 14초」, open to what was understood, the steps
// and the interim notes (design turnplan §3.5)
const planOpen = ref(false)
const plan = computed(() => (c.value.plan && typeof c.value.plan === 'object' && c.value.plan.understood ? c.value.plan : null))
const planSteps = computed(() => (Array.isArray(plan.value?.steps) ? plan.value.steps : []))
const planNotes = computed(() => (Array.isArray(c.value.notes) ? c.value.notes : []))
const planLine = computed(() => {
  if (!plan.value || (!planSteps.value.length && !planNotes.value.length && plan.value.source !== 'front')) return ''
  const done = planSteps.value.filter((s) => s.state === 'done').length
  const head = planSteps.value.length ? `계획 ${done}/${planSteps.value.length}` : '진행 기록'
  return [head, dur(plan.value.ms), plan.value.state === 'stopped' ? '멈췄어요' : ''].filter(Boolean).join(' · ')
})
// a browser task's result (server lib/agent.js postBrowserResult): the message is the result in a line or two; what it did step by step
// and its whole account fold under 「자세히 · N단계」 (2026-11-25: 「불필요하게 뭐 아주 길게 … 보고싶으면 볼 수 있겠으나」)
const didOpen = ref(false)
const did = computed(() => (Array.isArray(c.value.did) ? c.value.did : []))
const hasDetail = computed(() => props.msg.kind === 'text' && props.msg.role === 'agent' && (did.value.length > 0 || !!c.value.detail))
// 「규칙을 바꿀까요?」 (server lib/roomRules.js settleRuleConfirm): 「바꾸기」 · 「이번 작업에만 적용」 while it waits for the person
const ruleBusy = ref(false)
const ruleErr = ref('')
async function ruleChoose(choice) {
  ruleBusy.value = true
  ruleErr.value = ''
  try { await api(`/threads/${props.msg.thread_id}/rule/confirm`, { method: 'POST', body: { messageId: props.msg.id, choice } }) } catch (e) { ruleErr.value = e.message } finally { ruleBusy.value = false }
}
// 「되돌리기」 on a change of the project's plan (server lib/projectNote.js undoChange): the plan goes back to the one before it
const planBusy = ref(false)
const planErr = ref('')
async function replacePlan(index) {
  planBusy.value = true
  planErr.value = ''
  try { await api(`/threads/${props.msg.thread_id}/note/replace`, { method: 'POST', body: { messageId: props.msg.id, index } }) } catch (e) { planErr.value = e.message } finally { planBusy.value = false }
}
// a conversation moved in from the chat (server lib/conversationMove.js): 「채팅으로 되돌리기」 — only for the one who moved it, asked once more
const mineMove = computed(() => !!c.value.moved?.note && String(c.value.moved.by || '') === String(app.me?.user?.id || ''))
const backAsk = ref(false)
const backBusy = ref(false)
const backErr = ref('')
async function moveBack() {
  backBusy.value = true
  backErr.value = ''
  try { await app.undoMove(c.value.moved.conv, props.msg.thread_id) } catch (e) { backErr.value = e.message } finally { backBusy.value = false }
}
async function undoPlan() {
  planBusy.value = true
  planErr.value = ''
  try { await api(`/threads/${props.msg.thread_id}/note/undo`, { method: 'POST', body: { chipId: props.msg.id } }) } catch (e) { planErr.value = e.message } finally { planBusy.value = false }
}
const ctx = computed(() => (c.value.context && c.value.context.action !== 'stay' && c.value.context.title ? c.value.context : null))
const byName = { judge: '판단 모델', logprob: 'logprob', json: 'json', pinned: '대화에서 직접', trivial: '', none: '' }
const ctxBy = computed(() => (ctx.value ? (ctx.value.rechecked ? '판단 모델 재확인→logprob' : ctx.value.escalated ? '판단 모델→logprob' : byName[ctx.value.strategy] ?? ctx.value.strategy) : ''))
const ctxWhy = computed(() => (ctx.value ? `${ctx.value.action === 'new' ? '새 대화로 시작' : '이 대화로 이어감'} · ${ctxBy.value} 확신도 ${ctx.value.confidence ?? '-'}` : ''))
// the conversation the label names: one of the main chat's, or a sub-topic of the project the message is in (src/projectTopics.js)
function openCtx() {
  const id = ctx.value?.conversationId
  if (!id) return
  router.push(app.projects.some((p) => p.id === props.msg.thread_id) ? topicPath(props.msg.thread_id, id) : `/chat/c/${encodeURIComponent(id)}`)
}

// a picture, a sound or a video shows under its card (MediaPreview.vue): a thumbnail that opens the viewer, a player in place —
// by the type it was stored with, else by its name (a site's download named only "download" is typed from its bytes: server
// lib/fileSniff.js). Pressing the card opens the viewer too, never an ArtCraft editor (src/openPlan.js 'view'; the viewer's
// 「… 로 편집」 does). One the agent left in its workspace has no address yet: it is published once (POST
// /messages/:id/open-file, as opening it does) so the preview is ready before it is pressed.
const media = computed(() => (props.msg.kind === 'file' ? mediaKindOf(c.value) : ''))
const resolved = ref('')
const mediaErr = ref('')
const mediaUrl = computed(() => c.value.url || resolved.value)
const fk = computed(() => cardKind(c.value))
// what pressing the card does
const hint = computed(() => {
  if (media.value && mediaUrl.value) return viewHint(media.value, c.value)
  const ed = officeEditorFor(c.value.name)
  return ed && c.value.url && !craftMissing(ed) ? (c.value.edited ? '편집본 · 눌러서 이어 편집' : '눌러서 바로 편집') : openHint(c.value)
})
// 답을 공유 · 프로젝트로 시작 (spec answer-share · chat-to-project): an AI answer's message menu (AnswerShareSheet.vue — 대화방 · 사람에게
// 보내기 · 문서로 남기기 · 프로젝트로 시작 · 글 선택 · 글 복사) — held on a phone, right-clicked on a computer (components/holdMenu.js), or its ⋯
// (a computer: shown by the answer under the pointer, and to the keyboard). No buttons under the answer.
// (only an answer takes the hold — the directive reads the binding at each press: an answer that stops being one, or becomes one, follows;
// the others keep the browser's own long press — text selection)
const vHold = hold
const holdable = computed(() => isAnswer(props.msg))
const bubbleEl = ref(null)
const docEl = ref(null)
// the focus goes back where it was when the menu closes (Esc · ✕): the ⋯ it was opened from, what had it before a right-click — none after a
// long press (a phone's keyboard would come up on the composer)
const focusBack = () => { const a = document.activeElement; return a && a !== document.body ? a : null }
// held: the bubble goes along (the menu's 「글 선택」 selects its words for the browser's own handles — a long press no longer does)
const openShare = (step = 'menu', el = null, from = null) => {
  app.answerShare = { msg: props.msg, step, ...(el ? { el: markRaw(el) } : {}), ...(from ? { from: markRaw(from) } : {}) }
}
const onHold = (el, at) => { closeHint(); openShare('menu', el, at?.touch ? null : focusBack()) }
const onMore = (e, el) => openShare('menu', el, e.currentTarget)

// a file card's menu (FileCardMenu.vue): 열기 · 팀원에게 공유 · 폴더에 정리 — pressing the card still opens the file; held (a phone) or
// right-clicked · its ⋯ (a computer) it opens the menu. A document that came in (attached, made by the agent, sent by a teammate — not one
// opened from a folder) is offered a folder: the judge is asked once the card is on screen, the card shows a dot while it waits.
const fileRow = ref(null)
const canFile = computed(() => props.msg.kind === 'file' && !!(c.value.url || c.value.path) && !c.value.folder)
const filing = props.msg.kind === 'file' ? useFiling(() => (canFile.value ? { messageId: props.msg.id } : null), () => c.value.filing, () => fileRow.value) : null
const fileMenu = ref(null)
const openFileMenu = (from = null) => { closeHint(); fileMenu.value = { from: from ? markRaw(from) : null } }
const onFileHold = (el, at) => openFileMenu(at?.touch ? null : focusBack())
// (dragging a card is a computer's — on a phone a long press is the card's menu, never a drag)
const draggable = !touchOnly()

// 「길게 누르면 …」 once on a phone (src/holdHint.js): under the newest answer worth acting on or file card drawn
const menuHere = computed(() => (holdable.value && showsActions(props.msg)) || props.msg.kind === 'file')
const hintHere = computed(() => holdHint.host === props.msg.id && !holdHint.closed)
// where this answer went (server lib/answerShare.js keeps it on the answer): 「「…」에 공유했어요」 — the newest
const sharedTo = computed(() => {
  const s = c.value.answerShares || {}
  const [room, x] = Object.entries(s).sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || '')))[0] || []
  return room ? { room, title: x?.title || '', n: Object.keys(s).length } : null
})
// (one line, the room's name inside — the English screen's patterns translate it whole and keep the name)
const sharedLine = computed(() => {
  const x = sharedTo.value
  if (!x) return ''
  if (!x.title) return x.n > 1 ? `대화방 ${x.n}곳에 공유했어요` : '대화방에 공유했어요'
  return x.n > 1 ? `「${x.title}」 외 ${x.n - 1}곳에 공유했어요` : `「${x.title}」에 공유했어요`
})
const openRoom = (id) => team.openMessenger(id)
onMounted(async () => {
  if (menuHere.value) claimHint(props.msg.id)
  if (!media.value || c.value.url || !c.value.path) return
  try { resolved.value = (await api(`/messages/${encodeURIComponent(props.msg.id)}/open-file`, { method: 'POST' }))?.url || '' } catch (e) { mediaErr.value = `${media.value === 'image' ? '미리 볼' : '재생할'} 파일을 가져오지 못했어요 · ${e.message}` }
})
</script>

<template>
  <div class="row" :data-id="msg.id" :class="[`r-${msg.role}`, `k-${msg.kind}`, { pinned: msg.kind === 'task' && c.state === 'running', needs: c.state === 'needs_input' || c.state === 'pending' }]">
    <span v-if="msg.kind !== 'divider'" class="ts">{{ time }}</span>

    <!-- which context this answer belongs to, as the context-router decided (hark-style threads) — in the whole chat only: inside one
         conversation every answer is that one, and the bar over the list says so (2026-11-28: 「필터링해서 들어왔기 때문에 … 필요 없지」) -->
    <div v-if="msg.role === 'agent' && ctx && !narrowed" role="link" tabindex="0" @click="openCtx" class="ctx" :class="ctx.action" :title="ctxWhy">
      <span class="arrow">↳</span><span class="tt">{{ ctx.action === 'new' ? '새 주제 · ' : '' }}{{ ctx.title }}</span>
      <small v-if="ctxBy" class="by" :class="ctx.escalated || ctx.rechecked ? 'escalated' : ctx.strategy">{{ ctxBy }} {{ ctx.confidence != null ? ctx.confidence.toFixed(2) : '' }}</small>
    </div>
    <!-- a scheduled run's output is introduced by its task, tappable to manage it (hark) -->
    <button v-if="msg.kind === 'divider' && c.scheduleId" class="sched press" @click="router.push(`/settings/schedules?open=${c.scheduleId}`)"><Icon name="clock" :size="15" /> {{ c.text }} 관리</button>
    <div v-else-if="msg.kind === 'divider'" class="divider">{{ c.text }}</div>

    <template v-else-if="msg.kind === 'text' && msg.role === 'user'">
      <span v-if="panelReq" class="req">새 패널 만들기</span>
      <div class="bubble user">{{ panelReq ?? c.text }}</div>
      <!-- sent to a CLI on the sender's own PC from the composer's picker (server lib/localAgents/chat.js) -->
      <small v-if="c.agent?.label" class="to-agent" data-test="msg-agent-tag">→ {{ c.agent.label }} · {{ c.agent.where || '내 PC' }}</small>
      <!-- the files dragged in with this message (server lib/fileRefs.js turnRefs): what it is about -->
      <div v-if="c.refs?.length" class="urefs" data-test="sent-refs">
        <template v-for="(r, i) in c.refs" :key="i + r.name">
          <!-- a mail (server lib/mailMention.js): opens its sheet again -->
          <button v-if="r.as === 'mail' && !r.error" class="uref mail press" data-test="sent-ref" data-kind="mail" :data-file="r.name" :title="`${r.from} · ${r.name}`" @click="openMail(r)">
            <span class="fx mail"><Icon name="mail" :size="13" /></span><b>{{ r.name }}</b><small>{{ r.from || '메일' }}</small>
          </button>
          <!-- a mail's attachment (server lib/mailAttachments.js): opens it again, as from the mail sheet -->
          <button v-else-if="r.as === 'mailatt' && !r.error" class="uref matt press" data-test="sent-ref" data-kind="mailatt" :data-file="r.name" :title="`메일 첨부 · ${r.subject || ''}`" @click="openAtt(r)">
            <span class="fx" :class="kindOf(r.name)">{{ kindLabel[kindOf(r.name)] || 'FILE' }}</span><b>{{ r.name }}</b><small>메일 첨부</small>
          </button>
          <span v-else class="uref" :class="{ error: !!r.error }" data-test="sent-ref" :data-file="r.name" :title="r.error || (r.path ? `${r.folder} › ${r.path}` : '')">
            <span class="fx" :class="kindOf(r.name)">{{ kindLabel[kindOf(r.name)] || 'FILE' }}</span><b>{{ r.name }}</b>
            <small>{{ r.error ? '쓰지 못함' : r.folder ? `${r.folder}${r.variation ? ' · 반영 전 변형' : ''}` : '내 파일' }}</small>
          </span>
        </template>
        <a v-if="attNote" class="uref dl" :href="attNote" download data-test="sent-ref-download"><Icon name="down" :size="13" /><b>내려받기</b></a>
      </div>
      <!-- 링크 미리보기: 글 속 처음 세 링크의 카드(server lib/linkPreview.js) -->
      <LinkPreviews :text="c.text" />
      <!-- sent while an answer of the same conversation was still coming: it waits its turn (lib/turns.js) -->
      <small v-if="c.fresh" class="queue">새로 하기 · 이전 답 대신 새로 만들어요</small>
      <small v-if="c.fromHabit" class="queue" data-testid="from-habit">습관 · 제안을 수락했어요</small>
      <small v-if="c.queued" class="queue">대기 · 앞 답이 끝나면 이어서 답해요</small>
      <small v-else-if="c.dropped" class="queue">서버가 다시 시작되어 이 요청은 답하지 못했어요 · 다시 보내 주세요</small>
      <!-- 팀 맥락 공유: 이 요청에 붙인 다른 대화 맥락(답 위 칩) -->
      <ReferChips v-if="c.refer" part="used" :refer="c.refer" :thread="msg.thread_id" :key="c.refer.refer_id || 'off'" />
    </template>
    <template v-else-if="msg.kind === 'text'">
      <!-- the answer of a CLI on my PC (its last words at the end of a turn) -->
      <small v-if="c.localAgent?.label" class="via" data-test="msg-local-answer">{{ c.localAgent.label }} · {{ c.localAgent.where || '내 PC' }}</small>
      <div class="hbox">
        <div ref="bubbleEl" v-hold="holdable ? onHold : null" class="bubble agent md" :class="{ holdable }" v-html="md(replies ? replies.body : c.text)" />
        <button v-if="holdable" class="mbtn press" data-test="msg-more" aria-haspopup="dialog" aria-label="이 답의 메뉴 열기" title="공유 · 프로젝트로 시작 · 복사" @click="onMore($event, bubbleEl)"><Icon name="more" :size="16" /></button>
      </div>
      <LinkPreviews :text="replies ? replies.body : c.text" />
      <MailChips v-if="mailRefs.length" :refs="mailRefs" :event="c.mailEvent || ''" />
      <!-- 회사 프로세스 지도의 업무 에이전트: 일 정의의 점검 항목마다 지켰는지(근거는 마우스를 올리면) -->
      <ul v-if="c.checks?.length" class="checks" data-testid="onto-checks">
        <li v-for="(x, i) in c.checks" :key="i" :class="x.ok === true ? 'ok' : x.ok === false ? 'no' : 'na'" :title="x.note"><b>{{ x.ok === true ? '✓' : x.ok === false ? '✗' : '?' }}</b><span>{{ x.checkpoint }}</span></li>
      </ul>
      <div v-if="planLine" class="work plan" :class="{ open: planOpen }" data-test="plan-fold">
        <button class="wl press" :aria-expanded="planOpen" data-testid="plan-fold" @click="planOpen = !planOpen">{{ planLine }} <span class="car">{{ planOpen ? '▴' : '▾' }}</span></button>
        <div v-if="planOpen" class="pbody" data-testid="plan-body">
          <p class="pu" data-no-i18n>{{ plan.understood }}</p>
          <ol v-if="planSteps.length"><li v-for="(s, i) in planSteps" :key="s.id || i" :class="s.state"><span class="pm">{{ s.state === 'done' ? '✓' : i + 1 }}</span><span data-no-i18n>{{ s.text }}</span></li></ol>
          <template v-if="planNotes.length"><small class="pn">메모</small><ul><li v-for="(n, i) in planNotes" :key="i" data-no-i18n>{{ n }}</li></ul></template>
        </div>
      </div>
      <div v-if="workLine" class="work" :class="{ open: workOpen }" data-test="work-trail">
        <button class="wl press" :aria-expanded="workOpen" @click="workOpen = !workOpen">{{ workLine }} <span class="car">{{ workOpen ? '▴' : '▾' }}</span></button>
        <ol v-if="workOpen">
          <li v-for="(w, i) in work" :key="i"><b>{{ w.phase || w.tool }}</b><template v-if="w.n > 1"> ×{{ w.n }}</template><small v-if="workWhere(w)">{{ workWhere(w) }}</small></li>
        </ol>
      </div>
      <div v-if="hasDetail" class="work taskdetail" :class="{ open: didOpen }" data-testid="task-detail">
        <button class="wl press" :aria-expanded="didOpen" data-testid="task-detail-toggle" @click="didOpen = !didOpen">자세히 · {{ did.length }}단계 <span class="car">{{ didOpen ? '▴' : '▾' }}</span></button>
        <div v-if="didOpen" class="tdbody" data-testid="task-detail-body">
          <p v-if="c.detail" class="tdtext" data-no-i18n>{{ c.detail }}</p>
          <b v-if="did.length" class="tdh">실제로 한 일</b>
          <ol v-if="did.length"><li v-for="(d, i) in did" :key="i" data-no-i18n>{{ d.text }}</li></ol>
          <template v-if="c.refused?.length"><b class="tdh">요청하지 않은 구매라 누르지 않은 것</b><ol><li v-for="(d, i) in c.refused" :key="i" data-no-i18n>{{ d }}</li></ol></template>
        </div>
      </div>
      <div v-if="c.ruleConfirm" class="ruleask" data-testid="rule-confirm">
        <template v-if="c.ruleConfirm.state === 'pending'">
          <button class="press go" :disabled="ruleBusy" data-testid="rule-confirm-replace" @click="ruleChoose('replace')">바꾸기</button>
          <button class="press sub" :disabled="ruleBusy" data-testid="rule-confirm-once" @click="ruleChoose('once')">이번 작업에만 적용</button>
        </template>
        <small v-else data-testid="rule-confirm-done">{{ c.ruleConfirm.state === 'replaced' ? '규칙을 바꿨어요' : '이번 작업에만 적용했어요' }}</small>
        <p v-if="ruleErr" class="aerr">{{ ruleErr }}</p>
      </div>
      <!-- 「계획의 … 이 가득 찼어요」 (server lib/projectNote.js addFromMessage full): the item the person said replaces the one they pick -->
      <div v-if="c.planFull" class="planfull" data-testid="plan-full">
        <template v-if="c.planFull.state === 'pending'">
          <button v-for="(it, i) in c.planFull.items" :key="i" class="press pf" :disabled="planBusy" data-testid="plan-full-replace" @click="replacePlan(i)">
            <small>이 항목과 바꾸기</small><span data-no-i18n>{{ it }}</span>
          </button>
          <button class="press pf sub" data-testid="plan-full-open" @click="app.planOpen = msg.thread_id">계획 보기</button>
        </template>
        <small v-else data-testid="plan-full-done">바꿔 넣었어요</small>
        <p v-if="planErr" class="aerr">{{ planErr }}</p>
      </div>
      <div v-if="replies" class="replies">
        <button v-for="o in replies.options" :key="o.label" class="reply press" :title="o.hint" @click="app.send(o.label, msg.thread_id)">{{ o.label }}</button>
      </div>
      <!-- what it did (no buttons — they are in its menu): 「「…」에 공유했어요 · 방 열기」 -->
      <p v-if="sharedTo" class="ashared" data-test="answer-shared"><Icon name="check" :size="12" /><span>{{ sharedLine }}</span>
        <button class="alink press" data-test="answer-shared-open" @click="openRoom(sharedTo.room)">방 열기</button></p>
    </template>

    <div v-else-if="doc" class="hbox">
      <div ref="docEl" v-hold="holdable ? onHold : null" class="doc" :class="{ open: expanded, holdable }">
        <h3 class="serif">{{ doc.title }}</h3>
        <div class="inner md" v-html="doc.body" />
        <button class="more press" :aria-label="expanded ? '접기' : '펼치기'" @click="expanded = !expanded">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :style="{ rotate: expanded ? '180deg' : '0deg' }"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </div>
      <button v-if="holdable" class="mbtn press" data-test="msg-more" aria-haspopup="dialog" aria-label="이 답의 메뉴 열기" title="공유 · 프로젝트로 시작 · 복사" @click="onMore($event, docEl)"><Icon name="more" :size="16" /></button>
    </div>

    <!-- 대화를 프로젝트로: the confirm card (name · the template folders that fit · 만들기) -->
    <ProjectOfferCard v-else-if="msg.kind === 'project_offer'" :msg="msg" />
    <!-- 「이 대화 프로젝트로 옮겨 줘」 (server lib/conversationMove.js offerByWords): the same picker and notice as the bar's 「프로젝트로 옮기기」 -->
    <ConvMoveCard v-else-if="msg.kind === 'conv_move'" :msg="msg" />
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
    <!-- a mail the agent wrote for the person: it leaves from their own mailbox only when they press 보내기 (server lib/mailOut.js) -->
    <MailOutCard v-else-if="msg.kind === 'mail_out'" :msg="msg" @connect="emit('connect')" />
    <!-- a skill or a folder of the person's PC their own CLI proposed: registered · uploaded only when they press it (server lib/localAgents/pcTools.js) -->
    <PcProposalCard v-else-if="msg.kind === 'pc_proposal'" :msg="msg" />
    <!-- a value only a teammate knows: ask them on the messenger? — and their answer filling the draft (server lib/askTeammate.js) -->
    <AskTeamCard v-else-if="msg.kind === 'ask_team' || msg.kind === 'ask_team_reply'" :msg="msg" />
    <!-- a step run by a CLI agent on its assignee's computer (server lib/localAgents): the card follows the run -->
    <!-- (a chat message's run — its 「대화 / 터미널」 in full; a step's card in its instance conversation is the compact one) -->
    <LocalRunCard v-else-if="msg.kind === 'local_run'" :run="c" :compact="!c.chat" />
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

    <div v-else-if="msg.kind === 'file'" class="filecol" :class="media ? `m-${media}` : ''">
      <div ref="fileRow" class="filerow" :draggable="draggable" data-test="file-card" :data-file="c.name" :data-filing="filing?.pending ? 'suggested' : filing?.filed ? 'filed' : null" @dragstart="dragCard">
        <!-- pressed: opens the file; held · right-clicked: its menu (data-hold-tap — components/holdMenu.js) -->
        <button v-hold="onFileHold" data-hold-tap class="file press" @click="openFile">
          <span class="fic" :class="fk">{{ kindLabel[fk] || 'FILE' }}</span>
          <span class="fmeta"><b>{{ c.name }}</b><small><span v-if="c.review" class="reviewed" :class="{ warn: !c.review.ok }" :title="c.review.summary">{{ c.review.ok ? '검수됨' : '검수 확인 필요' }}</span><template v-if="c.shared">{{ c.shared.by }}님이 공유 · </template>{{ hint }}</small></span>
          <!-- a folder suggestion waits in the menu -->
          <span v-if="filing?.pending" class="fdot" data-test="filing-dot" role="img" aria-label="폴더 정리 제안이 있어요" title="폴더 정리 제안이 있어요" />
        </button>
        <!-- 팀원에게 공유 (components/team) — not a private card (a mail's attachment, its edit: mine only) -->
        <ShareButton v-if="!c.private" :msg="msg" compact />
        <button class="mbtn press" data-test="file-more" aria-haspopup="dialog" :aria-label="`${c.name} 메뉴 열기`" title="파일 메뉴" @click="openFileMenu($event.currentTarget)"><Icon name="more" :size="16" /></button>
      </div>
      <!-- a picture to look at, a sound or a video that plays right here (on the phone too) -->
      <!-- (held · right-clicked, the preview is the card too: its menu — never the phone's own callout on the picture) -->
      <MediaPreview v-if="media && mediaUrl" v-hold="onFileHold" hold-tap :kind="media" :src="mediaUrl" :name="c.name" @open="openFile" @play="sawShare(c.shared?.shareId)" />
      <small v-else-if="media && mediaErr" class="playerr">{{ mediaErr }}</small>
      <!-- 폴더에 정리 — what it did (the suggestion itself is in the card's menu): 「‘견적서’에 정리했어요 · 열기」 -->
      <p v-if="filing?.filed" class="ashared filed" data-test="filing-line"><Icon name="check" :size="12" />
        <span data-test="filing-done">{{ filing.filed.already ? `이미 ‘${filing.filed.name}’에 있어요` : `‘${filing.filed.name}’에 정리했어요` }}</span>
        <button class="alink press" data-test="filing-open" @click="filing.openFolder()">열기</button></p>
      <FileCardMenu v-if="fileMenu" :msg="msg" :filing="canFile ? filing : null" :hint="hint" :from="fileMenu.from" @close="fileMenu = null" @open="openFile" />
      <HoldHint v-if="hintHere" />
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
    <!-- 대화를 프로젝트로 (server lib/chatProject.js): in the chat 「프로젝트로 옮겼어요 · 열기」, in the project 「채팅에서 이어 온 프로젝트예요 · 원래 대화 열기」 -->
    <button v-else-if="msg.kind === 'chip' && c.project?.id" class="chip link press" data-test="moved-to-project" :data-project="c.project.id" @click="router.push(`/projects/${c.project.id}`)">
      <Icon name="folder" :size="16" /> <span class="ct" data-no-i18n>{{ c.text }}</span> <span class="cgo">열기</span> <Icon name="chevron" :size="14" />
    </button>
    <button v-else-if="msg.kind === 'chip' && c.fromChat" class="chip link press" data-test="from-chat" @click="router.push(c.fromChat.conversationId ? `/chat/c/${encodeURIComponent(c.fromChat.conversationId)}` : '/chat')">
      <Icon name="chat" :size="16" /> <span class="ct">{{ c.text }}</span> <span class="cgo">원래 대화 열기</span> <Icon name="chevron" :size="14" />
    </button>
    <!-- a conversation moved in from the chat (server lib/conversationMove.js): where it came from, and 「채팅으로 되돌리기」 (its mover only) -->
    <div v-else-if="msg.kind === 'chip' && c.moved?.note" class="chip planchg movednote" data-test="moved-note" :data-conv="c.moved.conv">
      <Icon name="chat" :size="16" /> <span class="ct" data-test="moved-note-text">{{ c.text }}</span>
      <span class="pacts">
        <template v-if="backAsk">
          <small class="bq" data-test="moved-back-ask">채팅으로 되돌릴까요? 프로젝트에서 이어서 나눈 이야기도 함께 옮겨요</small>
          <button class="pbtn press" :disabled="backBusy" data-test="moved-back-yes" @click="moveBack">{{ backBusy ? '되돌리는 중…' : '되돌리기' }}</button>
          <button class="pbtn press" :disabled="backBusy" data-test="moved-back-no" @click="backAsk = false">아니요</button>
        </template>
        <button v-else-if="mineMove" class="pbtn press" data-test="moved-back" @click="backAsk = true">채팅으로 되돌리기</button>
      </span>
      <small v-if="backErr" class="aerr" role="alert">{{ backErr }}</small>
    </div>
    <!-- a change of the project's plan (server lib/projectNote.js): what changed, 「되돌리기」 (back to the plan before it) and 「계획 보기」 -->
    <div v-else-if="msg.kind === 'chip' && c.planChange" class="chip planchg" data-testid="plan-change">
      <Icon name="plan" :size="16" /> <span class="ct" data-testid="plan-change-text">{{ c.text }}</span>
      <span class="pacts">
        <small v-if="c.planChange.undone" class="pdone" data-testid="plan-change-undone">되돌렸어요</small>
        <!-- (a change whose row left the plan's history — more than 20 changes since — cannot be taken back: no button, not a 404) -->
        <button v-else-if="!c.planChange.backfill && !c.planChange.gone" class="pbtn press" :disabled="planBusy" data-testid="plan-change-undo" @click="undoPlan">되돌리기</button>
        <button class="pbtn press" data-testid="plan-change-open" @click="app.planOpen = msg.thread_id">계획 보기</button>
      </span>
      <small v-if="planErr" class="aerr">{{ planErr }}</small>
    </div>
    <div v-else-if="msg.kind === 'chip'" class="chip"><Icon :name="chipIcon[c.icon] || 'check'" :size="16" /> {{ c.text }}</div>
    <!-- 팀 맥락 공유: 관계있지만 아직 볼 수 없는 팀원의 맥락(답 아래 요청 후보) -->
    <ReferChips v-if="msg.role === 'agent' && c.refer_id" part="requestable" :refer-id="c.refer_id" :thread="msg.thread_id" />
    <!-- a document answer's plan and trail too (its card is above; the text answer has them under its bubble) -->
    <template v-if="msg.kind === 'doc'">
    <div v-if="planLine" class="work plan" :class="{ open: planOpen }" data-test="plan-fold">
      <button class="wl press" :aria-expanded="planOpen" data-testid="plan-fold" @click="planOpen = !planOpen">{{ planLine }} <span class="car">{{ planOpen ? '▴' : '▾' }}</span></button>
      <div v-if="planOpen" class="pbody" data-testid="plan-body">
        <p class="pu" data-no-i18n>{{ plan.understood }}</p>
        <ol v-if="planSteps.length"><li v-for="(s, i) in planSteps" :key="s.id || i" :class="s.state"><span class="pm">{{ s.state === 'done' ? '✓' : i + 1 }}</span><span data-no-i18n>{{ s.text }}</span></li></ol>
        <template v-if="planNotes.length"><small class="pn">메모</small><ul><li v-for="(n, i) in planNotes" :key="i" data-no-i18n>{{ n }}</li></ul></template>
      </div>
    </div>
    </template>
    <div v-if="workLine && msg.kind === 'doc'" class="work" :class="{ open: workOpen }" data-test="work-trail">
      <button class="wl press" :aria-expanded="workOpen" @click="workOpen = !workOpen">{{ workLine }} <span class="car">{{ workOpen ? '▴' : '▾' }}</span></button>
      <ol v-if="workOpen">
        <li v-for="(w, i) in work" :key="i"><b>{{ w.phase || w.tool }}</b><template v-if="w.n > 1"> ×{{ w.n }}</template><small v-if="workWhere(w)">{{ workWhere(w) }}</small></li>
      </ol>
    </div>
    <p v-if="msg.kind === 'doc' && sharedTo" class="ashared" data-test="answer-shared"><Icon name="check" :size="12" /><span>{{ sharedLine }}</span>
      <button class="alink press" data-test="answer-shared-open" @click="openRoom(sharedTo.room)">방 열기</button></p>
    <!-- 「길게 누르면 …」 — once, on a phone (src/holdHint.js) -->
    <HoldHint v-if="hintHere && msg.kind !== 'file'" />
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
.to-agent { display: block; text-align: right; font-size: 12px; color: var(--text-secondary); margin: 4px 8px 0 0; }
.via { display: block; font-size: 12px; color: var(--text-secondary); margin: 0 0 4px 6px; }
.work { max-width: min(424px, 100%); margin-top: 4px; font-size: 12.5px; color: var(--text-secondary); }
.work .wl { text-align: left; padding: 4px 8px; border-radius: 10px; color: var(--text-secondary); font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
.work .car { font-size: 10px; }
.work ol { margin: 4px 0 0; padding: 8px 12px 8px 28px; border-radius: 14px; background: var(--bubble-agent-bg); }
.work li { margin: 2px 0; line-height: 1.45; overflow-wrap: anywhere; }
.work li b { font-weight: 500; color: var(--text-primary); }
.work li small { display: block; color: var(--text-tertiary); }
.plan .pbody { margin: 4px 0 0; padding: 10px 12px; border-radius: 14px; background: var(--bubble-agent-bg); }
.plan .pu { margin: 0 0 6px; color: var(--text-primary); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
.plan .pbody ol, .plan .pbody ul { margin: 0; padding: 0; list-style: none; background: none; border-radius: 0; }
.plan .pbody li { display: grid; grid-template-columns: 18px 1fr; gap: 6px; margin: 3px 0; }
.plan .pbody ul li { display: block; color: var(--text-tertiary); }
.plan .pm { color: var(--text-tertiary); }
.plan li.done .pm { color: var(--color-success); }
.plan .pn { display: block; margin: 8px 0 2px; color: var(--text-tertiary); }
.taskdetail .tdbody { margin-top: 4px; padding: 10px 14px; border-radius: 14px; background: var(--bubble-agent-bg); color: var(--text-primary); }
.taskdetail .tdtext { margin: 0 0 8px; white-space: pre-line; line-height: 1.5; font-size: 13px; overflow-wrap: anywhere; word-break: keep-all; }
.taskdetail .tdh { display: block; margin: 6px 0 2px; font-weight: 600; font-size: 12.5px; color: var(--text-secondary); }
.taskdetail ol { margin: 0; padding: 0 0 0 18px; background: none; }
.ruleask { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; max-width: min(424px, 100%); }
.ruleask button { height: 40px; padding: 0 16px; border-radius: 9999px; font-size: 14.5px; font-weight: 600; }
.ruleask .go { background: var(--color-attention); color: #fff; }
.ruleask .sub { background: rgba(127 127 127 / .13); color: var(--text-primary); font-weight: 500; }
.ruleask small { font-size: 13px; color: var(--text-secondary); }
.ruleask .aerr { flex-basis: 100%; margin: 0; font-size: 13px; color: var(--color-error); }
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
.filerow[draggable="true"] { cursor: grab; }
/* files dragged in with a message (sent refs) */
.urefs { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-top: 6px; max-width: 512px; }
.uref { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 30px; padding: 0 10px 0 3px; border-radius: 15px; font-size: 12.5px; color: var(--text-primary);
  background: var(--bubble-user-bg); border: 1px solid rgba(122, 90, 245, .4); }
.uref .fx { flex: none; width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; font-size: 8.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.uref .fx.doc { background: #2b579a; } .uref .fx.xls { background: #217346; } .uref .fx.ppt { background: #c43e1c; } .uref .fx.pdf { background: #d93025; } .uref .fx.hwp { background: #1f6fd1; } .uref .fx.md { background: #3d4451; }
.uref b { font-weight: 500; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uref small { color: var(--text-secondary); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uref.error { border-color: rgba(198, 40, 40, .45); opacity: .75; }
.uref .fx.mail { background: #7a5af5; }
.uref.matt { border-color: rgba(122, 90, 245, .45); }
.uref.dl { text-decoration: none; color: var(--text-primary); }
button.uref { text-align: left; }
.filerow .file { min-width: 0; }
.filecol { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; max-width: 100%; }
.filecol.m-audio, .filecol.m-video { width: 424px; }
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
.chip.planchg { flex-wrap: wrap; max-width: 100%; border-radius: 18px; padding: 7px 8px 7px 14px; gap: 6px 8px; color: var(--text-primary); }
.chip.planchg > :deep(svg) { flex: none; }
.chip.planchg .ct { flex: 1 1 180px; min-width: 0; word-break: keep-all; overflow-wrap: anywhere; line-height: 1.4; }
.chip.planchg .pacts { display: inline-flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.chip.planchg .pbtn { height: 28px; padding: 0 11px; border-radius: 14px; background: var(--cell-bg); color: var(--text-primary); font-size: 12.5px; white-space: nowrap; }
.chip.planchg .pbtn:disabled { opacity: .5; }
.chip.planchg .pdone { align-self: center; color: var(--text-tertiary); font-size: 12.5px; }
.chip.planchg .aerr { flex-basis: 100%; margin: 0; font-size: 12.5px; color: var(--color-error); }
.chip.movednote .bq { flex-basis: 100%; font-size: 12.5px; color: var(--text-secondary); line-height: 1.4; word-break: keep-all; overflow-wrap: anywhere; }
.planfull { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-width: 424px; }
.planfull .pf { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; padding: 8px 12px; border-radius: 14px; background: var(--cell-bg); color: var(--text-primary); font-size: 13.5px; line-height: 1.4; overflow-wrap: anywhere; }
.planfull .pf small { color: var(--text-tertiary); font-size: 11.5px; }
.planfull .pf.sub { align-self: flex-start; padding: 6px 12px; }
.planfull .pf:disabled { opacity: .5; }
.planfull > small { color: var(--text-tertiary); font-size: 12.5px; }
.planfull .aerr { margin: 0; font-size: 12.5px; color: var(--color-error); }
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
.ashared { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; max-width: min(424px, 100%); min-width: 0; margin: 6px 0 0 8px; font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
.ashared.filed { margin-top: 0; }
/* an answer (its bubble · its document card) and the ⋯ beside it */
.hbox { display: flex; align-items: flex-start; gap: 6px; max-width: 100%; min-width: 0; }
.hbox > .bubble, .hbox > .doc { min-width: 0; }
/* what follows a document answer clears its ⌄ (it hangs 14px below the card — a long 「「…」에 공유했어요 · 방 열기」 ran under it) */
.row.k-doc > .hbox + * { margin-top: 20px; }
/* ⋯ — the message's menu on a computer: shown by the message under the pointer, and to the keyboard */
.mbtn { flex: none; align-self: center; width: 28px; height: 28px; border-radius: 14px; display: grid; place-items: center; color: var(--text-secondary);
  background: var(--regular-solid-bg); border: 1px solid rgba(127, 127, 127, .2); opacity: 0; transition: opacity .12s; }
.row:hover .mbtn, .mbtn:focus-visible { opacity: 1; }
.mbtn:hover { color: var(--text-primary); }
/* a phone: a long press — the ⋯ takes no room and no look, but stays for a screen reader, a switch, a tablet's keyboard (PR #126 review);
   with the keyboard's focus it shows over the answer's · card's corner */
@media (hover: none) {
  .hbox, .filerow { position: relative; }
  .mbtn:not(:focus-visible) { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; pointer-events: none; }
  .mbtn:focus-visible { position: absolute; top: 6px; right: 6px; z-index: 2; width: 36px; height: 36px; border-radius: 18px; box-shadow: var(--shadow-card); }
  /* (a card's: in its row after 👥 — over the card's corner it would cover 👥) */
  .filerow .mbtn:focus-visible { position: static; }
}
/* a folder suggestion waits in the card's menu */
.file { position: relative; }
.fdot { position: absolute; top: 9px; right: 9px; width: 9px; height: 9px; border-radius: 50%; background: #3b8cf0; box-shadow: 0 0 0 2px #1d1d1f; }
.ashared > :deep(svg) { color: var(--color-success); flex: none; }
.alink { margin-left: 4px; font-size: 12px; font-weight: 600; color: var(--text-primary); text-decoration: underline; text-underline-offset: 2px; }
.chip.link .cgo { flex: none; font-size: 12.5px; font-weight: 600; color: var(--text-secondary); }
/* a phone's long press opens the answer's menu, not the text selection (as the messenger's bubbles — its 「글 선택」 gives the selection back);
   a file card's opens its menu, never the system's own callout */
@media (pointer: coarse) { .holdable:not([data-selecting]), .file, .filecol :deep(.mp img), .filecol :deep(.mp video) { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; } }
</style>
