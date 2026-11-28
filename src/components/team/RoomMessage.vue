<script setup>
// One message of a room as the room shows it — the one way a teammate's message is drawn (2026-11-28 「받은 편지함 = 대화의 거르개」):
// in the open conversation and in 대화 › 나에게 온 것 alike, with its files, pictures, mentions, the shared AI answer, the AI's question form,
// 폴더에 정리, my share's people, 「이어서 작업」, its reactions and link cards. What it does — open a file, continue, react — is the
// messenger's (Messenger.vue provides it as 'roomMessage'): the same in both places.
import { computed, inject, ref } from 'vue'
import Icon from '../Icon.vue'
import { useTeam } from '../../stores/team.js'
import { kindLabel, cardKind } from '../../artifacts.js'
import { receiptOf, receiptHint } from '../../shareReceipts.js'
import MediaPreview from '../MediaPreview.vue'
import AssistSuggestion from './AssistSuggestion.vue'
import MeetingRoomCard from '../meetings/MeetingRoomCard.vue'
import { langLabel } from '../../i18n/mainLangs.js'
import { hidePaths } from '../../paths.js'
import ConflictChoice from './ConflictChoice.vue'
import FolderSuggest from '../folders/FolderSuggest.vue'
import PersonAvatar from '../PersonAvatar.vue'
import { tagsFor, labelOf } from '../../people.js'
import LinkPreviews from '../LinkPreviews.vue'
import FileRefCard from './FileRefCard.vue'
import MailRefCard from './MailRefCard.vue'
import AnswerRefCard from './AnswerRefCard.vue'
import MailAttRefCard from './MailAttRefCard.vue'
import ReactionChips from './ReactionChips.vue'
import AskTeamForm from './AskTeamForm.vue'
// (the long press · right-click of the messenger's bubbles — used as it is: components/holdMenu.js)
import { hold } from '../holdMenu.js'
import { canReact } from '../../roomReactions.js'

// m: the message · room: its room ({kind, title, members}, null when not listed) · suggestions: the room's AI 제안 under it (the open room)
// forme: drawn in 대화 › 나에게 온 것 (not the open conversation): its pictures do not move the open room, and 폴더에 정리 asks the
// judge only when pressed (scrolling the list past a file is no reason to ask a model — PR #127 review)
const props = defineProps({ m: { type: Object, required: true }, room: { type: Object, default: null }, suggestions: { type: Array, default: () => [] }, forme: Boolean })
const team = useTeam()
const x = inject('roomMessage')
const vRxHold = hold

// Whose face a message has: a person's own; an agent's — its owner's, with the agent's mark; the room's AI (and an agent no one owns) — ✦
const face = (s) => (s?.ai || (s?.agent && !s?.id) ? { kind: 'ai' }
  : { kind: 'person', id: s?.id || undefined, name: (s?.agent ? s?.owner?.name : s?.name) || s?.name || '', agent: !!s?.agent })
const when = (d) => {
  const t = new Date(d), mins = Math.round((Date.now() - t) / 60000)
  return mins < 1 ? '방금' : mins < 60 ? `${mins}분 전` : t.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
const kindWord = { share: '공유', mention: '멘션', text: '메시지', agent: '에이전트 결과', fileref: '파일 링크', mailref: '메일 멘션', askteam: 'AI 가 대신 묻는 중', answer: 'AI 답 공유' }
// same-named people of the room told apart (src/sameNames.js)
const roomTags = computed(() => tagsFor(props.room?.members || []))
const senderLabel = (m) => (m.sender?.id && roomTags.value.get(String(m.sender.id)) ? labelOf(roomTags.value, m.sender, m.sender.name) : m.sender?.name)
// my share: each person it went to — 「안 열어 봄」 · 「열어 봄 · 언제」 · what their copy changed (only I see this — src/shareReceipts.js)
const sentTo = computed(() => (props.m.mine ? team.receipts[props.m.id] || [] : []))
const receipt = (r) => receiptOf(r, when)
const sentLabel = (r) => labelOf(tagsFor([...(props.room?.members || []), ...sentTo.value]), r)
const changedFiles = (b) => (b ? [...b.modified, ...b.added] : [])
// 「이어서 작업」, one rule wherever the message shows: a share · mention sent to me, and my own share once someone's copy changed
const continues = computed(() => (!props.m.mine && (props.m.kind === 'share' || props.m.kind === 'mention')) || (props.m.mine && sentTo.value.some((r) => r.branch?.at)))
const sys = computed(() => ['invite', 'rename'].includes(props.m.kind) || String(props.m.kind).startsWith('meeting'))
// reactions are offered once this database is known to keep them (stores/team.js rxKnown · rxOff)
const rxOn = computed(() => team.rxKnown && !team.rxOff)
const filing = ref(false)
const grownHere = () => { if (!props.forme) x.grown() }
</script>

<template>
  <!-- someone was invited (server lib/team/messenger.js invite): a line of the room's own -->
  <p v-if="m.kind === 'invite'" class="sysline" data-test="msg-invite" :data-id="m.id">{{ m.body }}</p>
  <!-- the room was named, or its name taken off (server lib/team/messenger.js rename) -->
  <p v-else-if="m.kind === 'rename'" class="sysline" data-test="msg-rename" :data-id="m.id">{{ m.body }}</p>
  <MeetingRoomCard v-else-if="String(m.kind).startsWith('meeting')" :m="m" :title="room?.title || ''" />
  <div v-else :data-id="m.id" class="msg" :class="{ mine: m.mine, card: m.kind !== 'text', agent: m.kind === 'agent', rxable: canReact(m), rxopen: x.rxId === m.id }">
    <PersonAvatar v-if="!m.mine" v-bind="face(m.sender)" size="sm" />
    <div v-rx-hold="canReact(m) ? (el, at) => x.openRx(m, el, at) : null" class="bub" data-test="msg-bubble">
      <p v-if="m.kind === 'text' && !m.mine && room?.kind === 'group'" class="kind">{{ senderLabel(m) }}</p>
      <p v-if="m.kind === 'agent'" class="kind">✦ {{ m.sender.name }}<template v-if="m.context?.title"> · {{ m.context.title }}</template></p>
      <!-- (a mail its owner's rule posted as it arrived — server lib/mailRooms.js: said as such) -->
      <p v-else-if="m.kind !== 'text'" class="kind">{{ m.mine ? '보냄' : senderLabel(m) }} · <span :data-test="m.auto ? 'msg-auto' : null">{{ m.auto ? '메일 자동 공유' : kindWord[m.kind] }}</span><template v-if="m.context?.title"> · {{ m.context.title }}</template></p>
      <p v-if="m.body" class="txt" :data-no-i18n="team.tr[m.id]?.body ? '' : null" data-test="msg-text">{{ hidePaths(team.trBody(m) || m.body) }}</p>
      <!-- auto-translation (another language than mine): AI 번역 · 원문 보기 / Show original -->
      <p v-if="team.tr[m.id]?.body" class="trl" data-test="msg-tr"><span>AI 번역<template v-if="team.tr[m.id].from"> · <b data-no-i18n>{{ langLabel(team.tr[m.id].from) }}</b></template></span><button class="press" data-test="show-original" @click="team.toggleOriginal(m.id)">{{ team.original[m.id] ? '번역 보기' : '원문 보기' }}</button></p>
      <details v-if="m.context?.excerpt?.length" class="ex"><summary>대화 발췌</summary><p v-for="(l, i) in m.context.excerpt" :key="i">{{ l }}</p></details>
      <div v-if="m.artifacts?.length" class="arts">
        <button v-for="a in m.artifacts" :key="a.name + a.shareId" class="art press" :class="{ off: !a.shareId, busy: x.busy === `f${a.shareId}` }" :disabled="!a.shareId"
          :title="a.shareId ? '' : '나에게 공유되지 않은 파일이라 열 수 없어요'" data-test="msg-file" :data-file="a.name" :draggable="!!a.shareId" @dragstart="x.dragShare($event, a)" @click="x.openFile(a)">
          <span class="fic" :class="cardKind(a)">{{ kindLabel[cardKind(a)] || 'FILE' }}</span><span class="an">{{ a.name }}</span>
        </button>
      </div>
      <!-- a picture to look at, a sound or a video that plays right here -->
      <div v-if="m.artifacts?.some((a) => x.mediaOf(a))" class="media">
        <MediaPreview v-for="a in m.artifacts.filter((y) => x.mediaOf(y))" :key="'mp' + a.name + a.shareId" :kind="x.mediaOf(a)" :src="x.shareSrc(a)" :name="a.name" compact
          @open="x.viewShare(a)" @failed="x.relink(a)" @loaded="grownHere" @play="x.played(a)" />
      </div>
      <template v-for="a in m.artifacts || []" :key="'n' + a.name + a.shareId">
        <p v-if="x.noteOf(a)" class="onote" :class="{ calm: x.noteOf(a).calm }" role="status" data-test="open-note" :data-file="a.name">
          <Icon v-if="!x.noteOf(a).calm" name="alert" :size="14" /><span>{{ x.noteOf(a).reason }}</span><a v-if="x.noteOf(a).url" :href="x.noteOf(a).url" target="_blank" rel="noopener" download>새 창에서 열기</a>
        </p>
      </template>
      <!-- file mentions: links to shared folders' files, in my own state (server lib/fileRefs.js) -->
      <template v-for="(r, i) in m.refs || []" :key="'r' + i + (r.path || r.actionId)">
        <MailRefCard v-if="r.type === 'mail'" :m="m" :r="r" :i="i" />
        <MailAttRefCard v-else-if="r.type === 'mailatt'" :m="m" :r="r" :i="i" />
        <FileRefCard v-else :m="m" :r="r" :i="i" />
      </template>
      <!-- an AI answer shared from someone's chat (server lib/answerShare.js) -->
      <AnswerRefCard v-if="m.kind === 'answer' && m.answer" :answer="m.answer" />
      <!-- a request the AI sent for someone (server lib/askTeammate.js): the form for the one asked, the answer for both -->
      <AskTeamForm v-if="m.kind === 'askteam' && m.ask" :m="m" />
      <!-- 폴더에 정리: a file a teammate sent me (lib/folders/filing.js) -->
      <template v-if="!m.mine && m.kind === 'share' && m.artifacts.some((y) => y.shareId)">
        <button v-if="forme && !filing" class="fsgo press" data-test="forme-filing" @click="filing = true"><Icon name="folder" :size="13" />폴더에 정리</button>
        <template v-else><FolderSuggest v-for="a in m.artifacts.filter((y) => y.shareId)" :key="'fs' + a.shareId" :share-id="a.shareId" :data-file="a.name" :label="m.artifacts.length > 1 ? a.name : ''" compact /></template>
      </template>
      <!-- my share: each person it went to — 「안 열어 봄」 · 「열어 봄 · 언제」 · what their copy changed (only I see this) -->
      <div v-if="sentTo.length" class="brs" data-test="share-receipts">
        <div v-for="r in sentTo" :key="r.id" class="br" :data-room="r.branch?.room || null" data-test="share-receipt" :data-person="r.id" :data-state="receipt(r).state">
          <PersonAvatar :id="r.id" :name="r.name" size="xs" :agent="receipt(r).state === 'changed' && r.branch?.by === 'agent'" :title="receipt(r).state === 'changed' && r.branch?.by === 'agent' ? '에이전트가 고침' : ''" />
          <span class="bl" :title="receiptHint(r, when) || null"><b data-test="receipt-name">{{ sentLabel(r) }}</b> <span class="rs" :class="receipt(r).state" data-test="receipt-state"><Icon v-if="receipt(r).state === 'opened'" name="check" :size="12" />{{ receipt(r).text }}</span></span>
          <button v-for="f in changedFiles(r.branch)" :key="f" class="art press sm" :title="`${f} (읽기 전용)`" data-test="branch-file" @click="x.openBranch(r.branch, f)">
            <Icon name="eye" :size="13" />{{ f.split('/').pop() }}
          </button>
          <p v-for="f in changedFiles(r.branch).filter((y) => x.notes[`b${r.branch.room}${y}`])" :key="'n' + f" class="onote" :class="{ calm: x.notes[`b${r.branch.room}${f}`].calm }" role="status" data-test="open-note">
            <Icon v-if="!x.notes[`b${r.branch.room}${f}`].calm" name="alert" :size="14" /><span>{{ x.notes[`b${r.branch.room}${f}`].reason }}</span>
            <a v-if="x.notes[`b${r.branch.room}${f}`].url" :href="x.notes[`b${r.branch.room}${f}`].url" target="_blank" rel="noopener" download>새 창에서 열기</a>
          </p>
        </div>
      </div>
      <ConflictChoice v-if="x.conflictOf[m.id]" :conflicts="x.conflictOf[m.id]" :busy="x.busy === `c${m.id}`" @pick="(c) => x.cont(m, c)" @cancel="delete x.conflictOf[m.id]" />
      <button v-if="continues" class="b main press cont" data-test="msg-continue" :disabled="!!x.busy" @click="x.cont(m)">{{ x.busy === `c${m.id}` ? '넘기는 중…' : '이어서 작업' }}</button>
      <small class="t">{{ when(m.at) }}</small>
    </div>
    <!-- a desktop's way in: the button by a teammate's bubble while the pointer is over it (or it has the focus) -->
    <button v-if="canReact(m) && rxOn" class="rxbtn press" data-test="rx-open" title="반응 남기기" aria-label="반응 남기기" @click="x.rxButton(m, $event)"><Icon name="smile" :size="16" /></button>
  </div>
  <!-- the reactions under it: emoji · count, mine marked; who reacted on a long press · the pointer resting on one -->
  <ReactionChips v-if="m.reactions?.length && !sys" :chips="m.reactions" :can="canReact(m) && rxOn" :mine="m.mine" :data-for="m.id" @toggle="(k) => x.react(m, k)" />
  <LinkPreviews v-if="m.body && !sys" :text="m.body" class="mlp" :class="{ mine: m.mine }" />
  <AssistSuggestion v-for="sg in suggestions" :key="sg.id" :s="sg" />
</template>

<style scoped>
.msg { display: flex; align-items: flex-end; gap: 8px; max-width: 86%; }
.msg.mine { align-self: flex-end; flex-direction: row-reverse; }
.bub { border-radius: 18px; padding: 9px 13px; background: rgba(127, 127, 127, .12); font-size: 14.5px; line-height: 1.5; min-width: 0; }
.mine .bub { background: #2a78d6; color: #fff; }
.card .bub { background: var(--bubble-agent-bg, rgba(255, 255, 255, .7)); color: var(--text-primary); border: 1px solid rgba(127, 127, 127, .2); }
.msg.flash .bub { animation: flash 1.6s; }
@keyframes flash { 0%, 60% { box-shadow: 0 0 0 3px rgba(42, 120, 214, .55); } 100% { box-shadow: none; } }
.msg.agent .bub { border-color: rgba(122, 90, 245, .45); }
.kind { margin: 0 0 4px; font-size: 12px; color: var(--text-secondary); }
.txt { margin: 0; white-space: pre-wrap; word-break: break-word; }
.trl { display: flex; align-items: center; gap: 8px; margin: 4px 0 0; font-size: 11.5px; color: var(--text-secondary); }
.trl span { opacity: .8; }
.trl button { font-size: 11.5px; padding: 1px 8px; border-radius: 8px; background: rgba(127, 127, 127, .14); color: inherit; }
.ex { margin-top: 6px; font-size: 12.5px; color: var(--text-secondary); }
.ex summary { cursor: pointer; } .ex p { margin: 4px 0 0; }
.arts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.art { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; height: 36px; padding: 0 12px 0 4px; border-radius: 12px; background: #1d1d1f; color: #f5f5f7; font-size: 13px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.art .an { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* a file that is not shared with me looks it (it was a dead button that looked like the others) */
.art.off, .art:disabled { opacity: .5; cursor: not-allowed; }
.art.busy { opacity: .7; cursor: progress; }
.art[draggable="true"] { cursor: grab; }
.art.sm { height: 26px; padding: 0 9px; font-size: 12px; gap: 4px; }
.fic { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-size: 9.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; }
/* pictures · sounds · videos of a message, under its file chips */
.media { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-top: 8px; max-width: 100%; }
/* why a file did not open, under it (with the link when the app has no viewer for it) */
.onote { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 4px 6px; margin: 6px 0 0; padding: 6px 10px; border-radius: 10px; font-size: 12.5px; line-height: 1.45;
  color: #b42318; background: rgba(198, 40, 40, .1); }
.onote svg { flex: none; margin-top: 2px; }
.onote span { flex: 1 1 160px; min-width: 0; }
.onote a { color: #1a56c4; font-weight: 500; text-decoration: underline; }
:root:not([data-theme="light"]) .onote { color: #ffb4ab; background: rgba(255, 100, 100, .14); }
:root:not([data-theme="light"]) .onote a { color: #a1d0ff; }
/* no viewer here for this format: said calmly, with its link — not a warning */
.onote.calm { color: var(--text-secondary); background: rgba(127, 127, 127, .1); }
.onote.calm a { color: inherit; }
:root:not([data-theme="light"]) .onote.calm { color: var(--text-secondary); background: rgba(127, 127, 127, .14); }
:root:not([data-theme="light"]) .onote.calm a { color: inherit; }
.b { height: 32px; padding: 0 13px; border-radius: 16px; font-size: 13.5px; background: rgba(127, 127, 127, .14); color: var(--text-primary); }
.b.main { background: #2a78d6; color: #fff; }
.b:disabled { opacity: .55; }
.cont { margin-top: 8px; }
.t { display: block; margin-top: 4px; font-size: 11px; opacity: .6; }
/* link cards sit under the bubble, on its side (past the avatar for a teammate's) */
.mlp { align-self: flex-start; width: min(360px, calc(86% - 36px)); margin: -4px 0 0 36px; }
.mlp.mine { align-self: flex-end; margin-left: 0; }
/* reactions: the hover button by a teammate's bubble (a pointer that hovers; a phone long-presses the bubble instead) */
.rxbtn { flex: none; align-self: center; width: 28px; height: 28px; border-radius: 14px; display: grid; place-items: center; color: var(--text-secondary);
  background: var(--regular-solid-bg); border: 1px solid rgba(127, 127, 127, .2); opacity: 0; transition: opacity .12s; }
.msg:hover .rxbtn, .rxbtn:focus-visible, .msg.rxopen .rxbtn { opacity: 1; }
@media (hover: none) { .rxbtn { display: none; } }
.msg.rxopen .bub { box-shadow: 0 0 0 2px rgba(42, 120, 214, .45); }
/* a phone's long press opens the bar, not the text selection (「복사」 is in the bar) */
@media (pointer: coarse) { .msg.rxable .bub { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; } }
/* 나에게 온 것: 폴더에 정리 waits to be pressed (then the judge is asked, as in the room) */
.fsgo { display: flex; width: fit-content; align-items: center; gap: 5px; height: 26px; margin-top: 6px; padding: 0 10px; border-radius: 13px; font-size: 12.5px;
  color: var(--text-secondary); background: rgba(127, 127, 127, .1); }
/* a line of the room's own: who invited whom */
.sysline { align-self: center; max-width: 90%; margin: 2px 0; padding: 4px 12px; border-radius: 12px; font-size: 12.5px; color: var(--text-secondary);
  background: rgba(127, 127, 127, .1); text-align: center; overflow-wrap: anywhere; }
.brs { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.br { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 12.5px; }
.br .bl { color: var(--text-secondary); } .br .bl b { color: var(--text-primary); font-weight: 600; }
/* opened: a small check in the colour of done; not opened yet: plain secondary text */
.br .rs { display: inline-flex; align-items: center; gap: 3px; }
.br .rs.opened { color: #0f7a52; }
:root:not([data-theme="light"]) .br .rs.opened { color: #5fd3a2; }
</style>
