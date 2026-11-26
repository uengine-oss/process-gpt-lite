<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { uploadAttachment } from '../api.js'
import FolderSuggest from './folders/FolderSuggest.vue'
import { cardKind, verbLabel } from '../mailKind.js'
import { isEnglish } from '../i18n/lang.js'
// not only the reply: the row of follow-up actions (server lib/mailFollow.js), and the mail itself as a mention to drag (src/fileDrag.js)
import MailFollowRow from './MailFollowRow.vue'
import MailRoomShare from './MailRoomShare.vue'
import { startDrag, mailItem } from '../fileDrag.js'
// the attachments are things to act on (2026-11-25 「메일 첨부를 곧바로 이음오피스 등의 도구로 열어보거나 채팅으로 해당 메일에 대한 질의/액션을
// 취할 수 있는 뭔가 흐름이 있어야」 — spec mail-attachments): a tap opens one where it belongs, its menu asks about it in the chat
import { api } from '../api.js'
import { officeDocOf } from '../stores/app.js'
import { openMailAttachment, askInChat, attItem, attBadge, sizeText } from '../mailAttach.js'
import { narrow } from '../viewport.js'

// A mail's Home card, opened: the mail as it arrived, and the card's own work as the main action — a reply the person reads,
// changes and sends themselves (lib/mailReply.js), an event they check and add to their calendar (lib/mailCard.js), or the card's
// task handed to the agent. Nothing leaves or is made before its button — a card no longer hands the agent "reply to …"
// (2026-11-23: the agent's mail tool sent it at once, to the wrong address), and a calendar card no longer opens a reply
// (2026-11-24: 「캘린더에 추가를 눌렀더니 왠 답장하기가 열리는...」). Not only the reply (2026-11-24 「메일에 대해서 무조건 답장만 하지는 않는다 …
// 채팅에 멘션해서 뭔가 후속 작업을 할 수 있어야」): every sheet has a row of follow-up actions above its own work (MailFollowRow — 이 회사
// 알아보기 · 채팅에서 이어서 · the judge's picks), and its head's handle drags the mail into the AI chat or the messenger as a mention.
const props = defineProps({ action: Object })
const emit = defineEmits(['close'])
const app = useApp()
const id = props.action.id
const info = ref(null)          // {provider, mode, mail, files, to, reply, sent}
const loadErr = ref('')
const draft = ref(null)         // {to, cc, subject, body}
const drafting = ref(false)
const draftErr = ref('')
const picked = ref([])          // message ids of the documents made for this mail, to attach
const added = ref([])           // files the person adds: {uid, name, key, state, error}
const sending = ref(false)
const sendErr = ref('')
const sent = ref(null)
const whole = ref(false)        // the mail's whole text (a long one is folded)
const fileInput = ref(null)

const mail = computed(() => info.value?.mail)
const who = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '')
const when = computed(() => {
  const d = mail.value?.date && new Date(mail.value.date)
  return d && !isNaN(d) ? d.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
})
const long = computed(() => String(mail.value?.text || '').length > 600)
const uploading = computed(() => added.value.some((f) => f.state === 'up'))
// a file that did not upload is not left out without a word: it is taken off, or uploaded again
const failedUpload = computed(() => added.value.some((f) => f.state === 'err'))
const canSend = computed(() => draft.value && info.value?.mode !== 'none' && draft.value.to.trim() && draft.value.body.trim() && !sending.value && !uploading.value && !failedUpload.value)
// 다시 쓰기 over the person's own changes asks once more first (the way 연결 끊기 does)
const written = ref('')         // the draft as the model last wrote it
const edited = computed(() => !!draft.value && JSON.stringify(draft.value) !== written.value)
const sure = ref(false)
let sureTimer = null
function rewrite() {
  if (edited.value && !sure.value) { sure.value = true; sureTimer = setTimeout(() => { sure.value = false }, 4000); return }
  sure.value = false; clearTimeout(sureTimer); write()
}
onBeforeUnmount(() => clearTimeout(sureTimer))

// ---------- the mail's place in the work (server lib/mailFlow.js) ----------
// The mail may belong to a process instance (started or joined here, started by itself in the 자동 stage, a new mail of its thread): the
// sheet links to it. Otherwise it may be the start of a process of the company map (제안 · 자동 — 「진행할까요?」) or the same work as a
// running instance (its Gmail thread, else the judge): 새로 시작 · 진행 중인 …에 잇기 · 이번엔 안 해요. Either answer opens the instance,
// where the mail is the first thing (2026-11-18: an instance's work happens on its page).
const router = useRouter()
const route = useRoute()
const flow = ref(null)            // {linked} | {matches, joins, declined}
const flowLoading = ref(true)
const flowBusy = ref('')
const flowErr = ref('')
// (a card no longer on Home — done — still changes: its newest row from the page's events)
const live = computed(() => app.actions.find((a) => a.id === id) || app.cardRows[id] || props.action)

// ---------- what this card is for (server lib/mailCard.js) ----------
// reply: the triage's 「Reply」, a card with the documents made for the mail, or one read as a reply — its draft is the sheet;
// calendar: the event form and 「캘린더에 추가」; task: 「에이전트에게 맡기기」. A card made before the triage said its kind is asked
// once (the judge); meanwhile the mail is shown. The reply of a calendar · task card is under 「답장도 쓰기」.
const decided = ref(null)
const kindWait = ref(false)
const kind = computed(() => cardKind(live.value) || decided.value)
const replyCard = computed(() => kind.value === 'reply')
const label = computed(() => verbLabel(live.value, kind.value))
const replyOpen = ref(false)
const showReply = computed(() => replyCard.value || replyOpen.value || !!draft.value)
async function askKind() {
  kindWait.value = true
  try { decided.value = (await app.mailCardKind(id)).kind } catch (e) { decided.value = 'task'; console.warn('[mail kind]', e.message) }
  kindWait.value = false
}
function openReply() { replyOpen.value = true; if (!draft.value && !drafting.value) write() }

// ---------- the calendar card's event ----------
// read once from the mail by the model (「일정 정보를 읽는 중…」), the person changes what they like, 「캘린더에 추가」 makes it —
// in their Google Calendar, or recorded only for the demo mailbox; the same event already there is said, not made twice
const ev = ref(null)            // {title, date, start, durationMin, allDay, location, link, description}
const evTz = ref('')
const evMode = ref(null)        // google | demo | none | scope
const evRead = ref(null)        // 'model' | 'failed'
const evFrom = ref(null)        // the time as the mail gave it, in another zone
const evReading = ref(false)
const evErr = ref('')
const evDone = ref(null)
const adding = ref(false)
const hereTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' } })()
async function loadEvent() {
  if (evReading.value || ev.value) return
  evReading.value = true; evErr.value = ''
  try {
    const r = await app.mailEvent(id, hereTz)
    const d = r.draft || {}
    evMode.value = r.mode
    if (r.event) evDone.value = r.event
    evTz.value = d.tz || r.event?.tz || hereTz || 'Asia/Seoul'
    evRead.value = d.read || null
    evFrom.value = d.from || null
    ev.value = { title: d.title || '', date: d.date || '', start: d.start || '', durationMin: d.durationMin || 60, allDay: !!d.allDay,
      location: d.location || '', link: d.link || '', description: d.description || '' }
  } catch (e) { evErr.value = e.message }
  evReading.value = false
}
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, 480]
const durations = computed(() => [...new Set([...DURATIONS, ev.value?.durationMin].filter(Boolean))].sort((a, b) => a - b))
const durLabel = (m) => { const h = Math.floor(m / 60), r = m % 60; return isEnglish ? [h && `${h} hr`, r && `${r} min`].filter(Boolean).join(' ') : [h && `${h}시간`, r && `${r}분`].filter(Boolean).join(' ') }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const hm = (t) => { const h = Number(t.slice(0, 2)), mm = t.slice(3, 5); return isEnglish ? `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}` : `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${mm}` }
// 「11월 25일 (수) 오후 3:00 – 오후 4:00」, in the screen's language
function whenOf(e) {
  if (!e?.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return ''
  const [, m, d] = e.date.split('-').map(Number)
  const wd = new Date(`${e.date}T00:00:00Z`).getUTCDay()
  const day = isEnglish ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd]}, ${MONTHS[m - 1]} ${d}` : `${m}월 ${d}일 (${'일월화수목금토'[wd]})`
  if (e.allDay || !e.start) return e.allDay ? (isEnglish ? `${day} (all day)` : `${day} 종일`) : day
  const end = Number(e.start.slice(0, 2)) * 60 + Number(e.start.slice(3, 5)) + (Number(e.durationMin) || 60)
  const endT = `${String(Math.floor(end / 60) % 24).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
  return `${day} ${hm(e.start)} – ${hm(endT)}${end >= 1440 ? (isEnglish ? ' (next day)' : ' (다음 날)') : ''}`
}
const needsTime = computed(() => !!ev.value?.date && !ev.value.start && !ev.value.allDay)
const evPast = computed(() => {
  const e = ev.value
  if (!e?.date || (!e.start && !e.allDay) || (evTz.value && hereTz && evTz.value !== hereTz)) return false
  return new Date(`${e.date}T${e.allDay ? '23:59' : e.start}:00`).getTime() < Date.now()
})
const canAdd = computed(() => !!ev.value && !!ev.value.title.trim() && !!ev.value.date && (!!ev.value.start || ev.value.allDay)
  && (evMode.value === 'google' || evMode.value === 'demo') && !adding.value && !evDone.value)
async function addEvent() {
  if (!canAdd.value) return
  adding.value = true; evErr.value = ''
  try {
    const e = ev.value
    evDone.value = (await app.addMailEvent(id, { ...e, title: e.title.trim(), start: e.allDay ? null : e.start, tz: evTz.value })).event
  } catch (err) { evErr.value = err.message }
  adding.value = false
}
watch(kind, (k) => {
  if (k === 'calendar') loadEvent()
  // a card read as a reply once the mail is here: its draft, as a Reply card's
  if (k === 'reply' && info.value && !info.value.sent && !draft.value && !drafting.value) write()
}, { immediate: true })
const linkedInst = computed(() => flow.value?.linked || (live.value.source?.inst?.instId ? live.value.source.inst : null))
const matches = computed(() => flow.value?.matches || [])
const joins = computed(() => flow.value?.joins || [])
const top = computed(() => matches.value[0] || null)
const others = computed(() => matches.value.slice(1))
const asks = computed(() => !linkedInst.value && !flow.value?.declined && (!!top.value || joins.value.length > 0))
const STAGE = { adopted: '자동 단계', suggested: '제안 단계' }
const STAGE_HINT = { adopted: '시작하면 저절로 진행하고 사람은 지켜봐요', suggested: '시작하면 단계마다 사람이 정해요' }
const pct = (p) => `${Math.round((p || 0) * 100)}%`
// 받침 있는 말 뒤엔 과/이, 없으면 와/가 (the particle only)
const jo = (w, pair) => {
  const code = String(w || '').trim().slice(-1).charCodeAt(0) - 0xac00
  const [a, b] = pair.split('/')
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? a : b
}
const ro = (w) => { const code = String(w || '').trim().slice(-1).charCodeAt(0) - 0xac00; return code >= 0 && code <= 11171 && code % 28 !== 0 && code % 28 !== 8 ? '으로' : '로' }
// 「Home 카드로」: from a chat chip (or the instance page), back to the card on Home
const homeCard = computed(() => app.mailCardFrom !== 'home' && app.actions.some((a) => a.id === id))
// (on that instance's page already: nothing to open)
const joinQ = computed(() => { const n = joins.value[0]?.name || ''; return `진행 중인 ‘${n}’${jo(n, '과/와')} 같은 일로 보여요 — 이을까요?` })
const instLink = computed(() => (linkedInst.value && String(route.params.instId || '') !== linkedInst.value.instId ? linkedInst.value : null))
// the work's folder (server lib/mailWork.js): this mail and the others of its work, and what the steps made
const workFolder = computed(() => linkedInst.value?.folder || live.value.source?.inst?.folder || null)
function goFolder(slug) { emit('close'); router.push(`/folders/${encodeURIComponent(slug)}`) }

async function loadFlow() {
  flowLoading.value = true
  // (the sheet works without it: a mail whose place cannot be read shows the mail and the reply as before)
  try { flow.value = await app.mailFlow(id) } catch (e) { flow.value = null; console.warn('[mail flow]', e.message) }
  flowLoading.value = false
}
function goInst(instId) { emit('close'); router.push(`/routines/${encodeURIComponent(instId)}`) }
async function start(m) {
  flowBusy.value = `start:${m.proc}`; flowErr.value = ''
  try { goInst((await app.startMailFlow(id, { proc: m.proc, task: m.task })).instId) } catch (e) { flowErr.value = e.message }
  flowBusy.value = ''
}
async function join(j) {
  flowBusy.value = `join:${j.instId}`; flowErr.value = ''
  try { goInst((await app.joinMailFlow(id, { instId: j.instId })).instId) } catch (e) { flowErr.value = e.message }
  flowBusy.value = ''
}
async function decline(undo = false) {
  flowBusy.value = 'decline'; flowErr.value = ''
  try { await app.declineMailFlow(id, undo); if (undo) await loadFlow(); else flow.value = { ...(flow.value || {}), declined: true } } catch (e) { flowErr.value = e.message }
  flowBusy.value = ''
}
function toHome() {
  emit('close')
  app.dockOpen = true
  if (route.path !== '/chat') router.push('/chat')
  app.flashCard = id
}

onMounted(async () => {
  loadFlow()
  if (!kind.value) askKind()
  try {
    info.value = await app.mailOfCard(id)
    picked.value = info.value.files.map((f) => f.messageId)
    if (info.value.sent) sent.value = info.value.sent
    else if (info.value.reply) { draft.value = pick(info.value.reply); written.value = JSON.stringify(draft.value) }
    else if (replyCard.value) write()
  } catch (e) { loadErr.value = e.message }
})
const pick = (r) => ({ to: r.to || '', cc: r.cc || '', subject: r.subject || '', body: r.body || '' })

async function write() {
  drafting.value = true; draftErr.value = ''
  try { draft.value = pick((await app.draftReply(id)).reply); written.value = JSON.stringify(draft.value) } catch (e) { draftErr.value = e.message }
  drafting.value = false
}

async function addFiles(e) {
  for (const file of [...(e.target.files || [])]) {
    const f = { uid: `${Date.now()}-${Math.random()}`, name: file.name, key: null, state: 'up', error: '' }
    added.value.push(f)
    uploadAttachment(file).then((r) => { const x = added.value.find((y) => y.uid === f.uid); if (x) Object.assign(x, { key: r.key, state: 'ok' }) })
      .catch((err) => { const x = added.value.find((y) => y.uid === f.uid); if (x) Object.assign(x, { state: 'err', error: err.message }) })
  }
  e.target.value = ''
}
function drop(uid) { added.value = added.value.filter((f) => f.uid !== uid) }
function toggle(messageId) {
  picked.value = picked.value.includes(messageId) ? picked.value.filter((x) => x !== messageId) : [...picked.value, messageId]
}

async function send() {
  if (!canSend.value) return
  sending.value = true; sendErr.value = ''
  try {
    const files = [...picked.value.map((messageId) => ({ messageId })), ...added.value.filter((f) => f.key).map((f) => ({ key: f.key, name: f.name }))]
    sent.value = (await app.sendReply(id, { ...draft.value, files })).sent
  } catch (e) { sendErr.value = e.message }
  sending.value = false
}

function toAgent() { app.runAction(props.action); emit('close') }

// ---------- the mail as a mention (src/fileDrag.js mailItem) ----------
// the head's handle is dragged onto the AI chat's composer or a messenger conversation: while it is, the sheet steps aside (the veil lets the
// pointer through, the sheet fades) so what is under it takes the drop
const passing = ref(false)
function dragMail(e) {
  startDrag(e, [mailItem(live.value)])
  // (after the drag has started: changing the source in dragstart itself can cancel the drag)
  setTimeout(() => { passing.value = true }, 0)
}
function dragDone() { passing.value = false }
onBeforeUnmount(dragDone)
// ---------- the attachments (src/mailAttach.js, server lib/mailAttachments.js) ----------
// A tap opens one: a document in IeumOffice (the folder's copy when the mail was filed — its saves go into the folder — else the mail's
// private copy), a picture · sound · video in the viewer (over this sheet), anything else a calm 「내려받기」 here. Its ⋯ menu: 열기 · 이 첨부로
// 묻기 (the chat with the mail and this file as chips) · 내려받기. A chip is dragged like any file of the app (the AI chat, a conversation).
const attBusy = ref(-1)
const attMenu = ref(-1)
const attDl = ref({})            // i → a 「내려받기」 address
const attErr = ref({})           // i → why it did not open
const edits = computed(() => live.value?.source?.att_edits || {})
const attKind = (a) => attBadge(a.name)
async function openAtt(a, i, { download = false } = {}) {
  attMenu.value = -1; attBusy.value = i; attErr.value = { ...attErr.value, [i]: '' }
  try {
    const r = await openMailAttachment(app, { actionId: id, i, name: a.name }, { download })
    if (r.how === 'download') attDl.value = { ...attDl.value, [i]: r.url }
    // a document opens in the panel beside the page: the sheet steps away (the viewer lies over it — the sheet stays)
    else if (r.how === 'office' && r.opened) emit('close')
    else if (r.opened === false && r.reason) attErr.value = { ...attErr.value, [i]: r.reason }
  } catch (e) { attErr.value = { ...attErr.value, [i]: e.message || '첨부를 열지 못했어요' } }
  attBusy.value = -1
}
async function askAtt(list) {
  attMenu.value = -1
  emit('close')
  if (narrow.value) app.dockOpen = false
  if (route.path !== '/chat') await router.push('/chat')
  await askInChat(app, live.value, list)
}
// the edited copy of an attachment (saved as my own private file card — server lib/mailAttachments.js saved): opened again
async function openEdit(i) {
  const e = edits.value[String(i)]
  if (!e?.msgId) return
  try {
    const c = await api(`/messages/${encodeURIComponent(e.msgId)}/open-file`, { method: 'POST' })
    if (await app.setOfficeDoc(officeDocOf(e.msgId, c))) emit('close')
  } catch (err) { attErr.value = { ...attErr.value, [i]: err.message } }
}
// the rooms an attachment is shared with (server lib/mailAttachments.js sharesOf) and 「끄기」 — also a room the owner has left: the share
// stays on the card until its owner takes it back here (review 11-25 #5)
const shares = ref([])           // [{i, name, room, title, at}]
const shareBusy = ref('')
const sharedRooms = computed(() => JSON.stringify(live.value?.source?.att_share || {}))
async function loadShares() {
  const any = Object.values(live.value?.source?.att_share || {}).some((x) => x && Object.keys(x).length)
  if (!any) { shares.value = []; return }
  try { shares.value = (await api(`/mail/attachments/${encodeURIComponent(id)}/shares`)).shares || [] } catch (e) { console.warn('[mail att] shares', e.message) }
}
watch(sharedRooms, loadShares, { immediate: true })
const sharesOfAtt = (i) => shares.value.filter((x) => x.i === i)
async function unshare(x) {
  shareBusy.value = `${x.i}:${x.room}`
  try { shares.value = (await api(`/mail/attachments/${encodeURIComponent(id)}/${x.i}/unshare`, { method: 'POST', body: { room: x.room } })).shares || [] }
  catch (e) { attErr.value = { ...attErr.value, [x.i]: e.message } }
  shareBusy.value = ''
}
function dragAtt(e, a, i) {
  startDrag(e, [attItem(live.value, a, i)])
  setTimeout(() => { passing.value = true }, 0)
}
// 폴더에 정리: the attachments' folder suggestions come into view
const origEl = ref(null)
// 대화방에 공유 (MailRoomShare.vue): the room picker under the row
const roomsOpen = ref(false)
const filesLit = ref(false)
function showFiles() {
  origEl.value?.querySelector('.atts')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  filesLit.value = true
  setTimeout(() => { filesLit.value = false }, 2200)
}
</script>

<template>
  <Teleport to="body">
    <div class="veil" :class="{ passing }" @click.self="emit('close')">
      <div class="sheet glass blur-in" role="dialog" :aria-label="action.text" data-test="mail-sheet">
        <header>
          <div>
            <!-- the mail as a mention: dragged onto the AI chat or a messenger conversation -->
            <span class="grip" draggable="true" role="button" tabindex="-1" aria-label="이 메일을 끌어서 AI 채팅이나 메신저에 놓기" title="끌어서 AI 채팅이나 메신저에 놓으면 멘션돼요"
              data-test="mail-drag" @dragstart="dragMail" @dragend="dragDone"><Icon name="grip" :size="16" /></span>
            <span class="verb" data-test="mail-verb">{{ label }}</span>
            <h2>{{ action.text }}</h2>
          </div>
          <button class="x press" aria-label="닫기" @click="emit('close')"><Icon name="close" :size="18" /></button>
        </header>
        <!-- where this mail's work is: its instance, the card on Home (from a chat chip) -->
        <nav v-if="instLink || homeCard || workFolder" class="links">
          <button v-if="instLink" class="lk press" data-test="mail-inst" @click="goInst(instLink.instId)">
            <Icon name="refresh" :size="14" /> <span>루틴 · {{ instLink.name || '진행 중인 일' }} 열기</span> <Icon name="chevron" :size="12" />
          </button>
          <button v-if="workFolder" class="lk press" data-test="mail-folder" @click="goFolder(workFolder.slug)">
            <Icon name="folder" :size="14" /> <span>작업 폴더 · {{ workFolder.name }}</span> <Icon name="chevron" :size="12" />
          </button>
          <button v-if="homeCard" class="lk press" data-test="mail-home" @click="toHome"><Icon name="home" :size="14" /> <span>Home 카드로</span></button>
        </nav>

        <div class="body scroll">
          <!-- what the mail may start or join (the company's process map, the running work) -->
          <p v-if="!linkedInst && flowLoading" class="flowwait shimmer-text" data-test="mail-flow-wait">회사 프로세스 지도와 견주는 중…</p>
          <section v-else-if="asks" class="flow" data-test="mail-flow">
            <p v-if="top" class="q" data-test="flow-question">이 메일은 ‘{{ top.name }}’의 시작으로 보여요 — 진행할까요?</p>
            <p v-else class="q" data-test="flow-question">{{ joinQ }}</p>
            <small v-if="top" class="why"><span>「{{ top.task }}」부터</span> · <span>{{ STAGE[top.stage] }}</span> · <span>{{ STAGE_HINT[top.stage] }}</span><template v-if="top.p != null"> · <span>확신 {{ pct(top.p) }}</span></template></small>
            <div class="acts">
              <button v-if="top" class="dark-btn sm" data-test="flow-start" :disabled="!!flowBusy" @click="start(top)">{{ flowBusy === `start:${top.proc}` ? '시작하는 중…' : '새로 시작' }}</button>
              <button v-for="j in joins" :key="j.instId" class="pill-btn sm join" data-test="flow-join" :disabled="!!flowBusy" @click="join(j)">
                <span>{{ flowBusy === `join:${j.instId}` ? '잇는 중…' : `진행 중인 ‘${j.name}’에 잇기` }}</span>
                <small>{{ j.by === 'thread' ? '같은 메일 스레드' : `같은 일 ${pct(j.p)}` }}</small>
              </button>
            </div>
            <div v-if="others.length" class="others">
              <span>다른 프로세스</span>
              <button v-for="m in others" :key="m.proc" class="chip press" data-test="flow-other" :disabled="!!flowBusy" @click="start(m)">‘{{ m.name }}’{{ ro(m.name) }} 시작</button>
            </div>
            <button class="nope press" data-test="flow-decline" :disabled="!!flowBusy" @click="decline()">이번엔 안 해요</button>
            <p v-if="flowErr" class="err" data-test="flow-error">{{ flowErr }}</p>
          </section>
          <p v-else-if="!linkedInst && flow?.declined" class="flowoff" data-test="flow-declined">
            <span>이 메일로는 프로세스를 시작하지 않기로 했어요.</span> <button class="nope press" data-test="flow-undo" @click="decline(true)">다시 묻기</button>
          </p>

          <p v-if="loadErr" class="err" data-test="mail-load-error">{{ loadErr }}</p>
          <p v-else-if="!info" class="wait shimmer-text">메일을 불러오는 중…</p>

          <section v-if="mail" ref="origEl" class="orig" :class="{ lit: filesLit }" data-test="mail-original">
            <p class="cap">받은 메일</p>
            <div class="meta">
              <b>{{ who(mail.from) }}</b>
              <small v-if="when">{{ when }}</small>
            </div>
            <p class="subj">{{ mail.subject }}</p>
            <div class="text" :class="{ folded: long && !whole }" data-test="mail-text">{{ mail.text }}</div>
            <button v-if="long" class="more press" @click="whole = !whole">{{ whole ? '접기' : '전체 보기' }}</button>
            <div v-if="mail.attachments?.length" class="chips atts">
              <!-- 폴더에 정리: each attachment with the folder the judge suggests (lib/folders/filing.js) -->
              <div v-for="(a, i) in mail.attachments" :key="i + a.name" class="att" data-test="mail-attachment" :data-file="a.name">
                <div class="arow">
                  <!-- a tap opens it where it belongs; dragged, it is asked about in the chat or mentioned in a conversation -->
                  <button class="chip achip press" draggable="true" data-test="mail-attachment-open" :data-file="a.name" :aria-busy="attBusy === i"
                    :title="`${a.name} 열기 · 끌어서 AI 채팅이나 메신저에 놓을 수 있어요`" @click="openAtt(a, i)" @dragstart="dragAtt($event, a, i)" @dragend="dragDone">
                    <span class="fx" :class="attKind(a)">{{ attKind(a) }}</span><span class="an">{{ a.name }}</span>
                    <small v-if="attBusy === i" class="shimmer-text">여는 중…</small><small v-else-if="a.size">{{ sizeText(a.size) }}</small>
                  </button>
                  <button class="chip amore press" :aria-expanded="attMenu === i" aria-haspopup="menu" aria-label="이 첨부로 할 일" data-test="mail-attachment-more" @click="attMenu = attMenu === i ? -1 : i">
                    <Icon name="more" :size="14" />
                  </button>
                </div>
                <div v-if="attMenu === i" class="amenu" role="menu" data-test="mail-attachment-menu">
                  <button role="menuitem" class="press" data-test="att-open" @click="openAtt(a, i)"><Icon name="eye" :size="14" /> 열기</button>
                  <button role="menuitem" class="press" data-test="att-ask" @click="askAtt([{ a, i }])"><Icon name="chat" :size="14" /> 이 첨부로 묻기</button>
                  <button role="menuitem" class="press" data-test="att-download" @click="openAtt(a, i, { download: true })"><Icon name="down" :size="14" /> 내려받기</button>
                </div>
                <p v-if="attDl[i]" class="adl" data-test="mail-attachment-download">
                  <span>{{ attKind(a) === 'FILE' || attKind(a) === 'ZIP' ? '앱 안에서 열지 않는 형식이에요' : '이 파일을 내려받아요' }}</span>
                  <a class="dl press" :href="attDl[i]" download><Icon name="down" :size="13" /> 내려받기</a>
                </p>
                <p v-if="attErr[i]" class="err" data-test="mail-attachment-error">{{ attErr[i] }}</p>
                <!-- who can open it: the rooms it is shared with, each with 「끄기」 -->
                <p v-for="x in sharesOfAtt(i)" :key="x.room" class="ashare" data-test="mail-attachment-share" :data-room="x.room">
                  <Icon name="team" :size="13" /><span>공유 중 · {{ x.title || '대화방' }}</span>
                  <button class="off press" data-test="mail-attachment-unshare" :disabled="shareBusy === `${x.i}:${x.room}`" @click="unshare(x)">{{ shareBusy === `${x.i}:${x.room}` ? '끄는 중…' : '끄기' }}</button>
                </p>
                <button v-if="edits[String(i)]" class="aedit press" data-test="mail-attachment-edited" @click="openEdit(i)">
                  <Icon name="check" :size="13" /> <span>편집본 · 내 채팅의 파일 · 나만 볼 수 있어요</span> <Icon name="chevron" :size="12" />
                </button>
                <FolderSuggest :action-id="id" :attachment="a.name" :filing="live?.source?.filing?.[a.name]" compact />
              </div>
            </div>
          </section>

          <!-- not only the reply: what else to do with this mail (each says what it does; nothing runs before its button) -->
          <MailFollowRow v-if="info || loadErr" :action="live" :atts="mail?.attachments || []" @close="emit('close')" @flow="start" @files="showFiles" @ask="askAtt" @share="roomsOpen = !roomsOpen" />
          <!-- 대화방에 공유: the room picker, and where the mail is shared now (server lib/mailRooms.js) -->
          <MailRoomShare :action="live" :open="roomsOpen" @close="emit('close')" @picked="roomsOpen = false" />

          <!-- the card's own work: what it is for decides the main action -->
          <p v-if="kindWait && !kind" class="wait shimmer-text" data-test="mail-kind-wait">무슨 일인지 살펴보는 중…</p>

          <section v-if="kind === 'calendar'" class="event" data-test="mail-event">
            <p class="cap">캘린더에 넣을 일정</p>
            <p v-if="evReading" class="wait shimmer-text" data-test="ev-reading">일정 정보를 읽는 중…</p>
            <div v-if="evDone" class="done" data-test="ev-done">
              <Icon name="check" :size="18" />
              <div>
                <p class="line"><b>{{ evDone.via === 'demo' ? '기록했어요' : evDone.existing ? '이미 캘린더에 있어요' : '캘린더에 추가했어요' }}</b> · <span data-test="ev-done-when">{{ whenOf(evDone) }}</span></p>
                <small data-test="ev-done-title">{{ evDone.title }}</small>
                <small v-if="evDone.via === 'demo'">데모 메일함이라 실제 캘린더에는 넣지 않았어요.</small>
                <a v-if="evDone.htmlLink" class="calink" :href="evDone.htmlLink" target="_blank" rel="noopener noreferrer" data-test="ev-open">캘린더에서 보기 <Icon name="chevron" :size="12" /></a>
              </div>
            </div>
            <template v-else-if="ev">
              <p v-if="evRead === 'failed'" class="note" data-test="ev-unread">메일에서 일정 정보를 읽지 못했어요. 직접 넣어 주세요.</p>
              <label class="field"><span>제목</span><input v-model="ev.title" data-test="ev-title" autocomplete="off" /></label>
              <div class="whenrow">
                <label class="field"><span>날짜</span><input v-model="ev.date" type="date" data-test="ev-date" /></label>
                <label class="field"><span>시작</span><input v-model="ev.start" type="time" :disabled="ev.allDay" data-test="ev-start" /></label>
                <label class="field"><span>길이</span>
                  <select v-model.number="ev.durationMin" :disabled="ev.allDay" data-test="ev-duration">
                    <option v-for="m in durations" :key="m" :value="m">{{ durLabel(m) }}</option>
                  </select>
                </label>
                <label class="allday"><input v-model="ev.allDay" type="checkbox" data-test="ev-allday" /> <span>종일</span></label>
              </div>
              <label class="field"><span>장소</span><input v-model="ev.location" data-test="ev-location" autocomplete="off" /></label>
              <label class="field"><span>링크</span><input v-model="ev.link" type="url" data-test="ev-link" autocomplete="off" /></label>
              <textarea v-model="ev.description" class="text-in desc" rows="3" data-test="ev-desc" />
              <p class="summary" data-test="ev-when"><Icon name="clock" :size="14" /> <span>{{ whenOf(ev) || '날짜를 넣어 주세요' }}</span> <small v-if="evTz">{{ evTz }}</small></p>
              <small v-if="evFrom" class="note" data-test="ev-from">메일에 적힌 때 · {{ whenOf({ ...evFrom, durationMin: ev.durationMin }) }} ({{ evFrom.tz }})</small>
              <p v-if="needsTime" class="note" data-test="ev-ask-time">메일에 시각이 없어요. 시각을 넣거나 종일로 두세요.</p>
              <p v-if="evPast" class="note" data-test="ev-past">이미 지난 때예요. 날짜와 시각을 확인해 주세요.</p>
              <p v-if="evMode === 'none'" class="err" data-test="ev-mode">Google 캘린더가 연결되어 있지 않아요. 설정에서 Google을 연결하면 여기서 일정을 넣을 수 있어요.</p>
              <p v-if="evMode === 'scope'" class="err" data-test="ev-mode">Google 캘린더에 일정을 넣을 권한이 없어요. 설정에서 Google을 다시 연결하면 여기서 넣을 수 있어요.</p>
              <div class="row">
                <button class="dark-btn sm" :disabled="!canAdd" data-test="ev-add" @click="addEvent">{{ adding ? '넣는 중…' : '캘린더에 추가' }}</button>
              </div>
              <p class="hint">캘린더에 추가를 누르기 전에는 아무것도 만들지 않아요.</p>
            </template>
            <p v-if="evErr" class="err" data-test="ev-error">{{ evErr }}</p>
          </section>

          <button v-if="kind === 'task' && (info || loadErr) && !sent && live.status === 'open'" class="agent main press" data-test="mail-agent" @click="toAgent">
            <span class="go"><Icon name="hand" :size="16" /> 에이전트에게 맡기기</span> <small>{{ action.prompt }}</small>
          </button>

          <button v-if="info && kind && !replyCard && !showReply && !sent" class="pill-btn sm write" data-test="mail-write" @click="openReply">답장도 쓰기</button>

          <section v-if="sent" class="done" data-test="mail-sent">
            <Icon name="check" :size="18" />
            <div>
              <b>{{ sent.via === 'drafts' ? '임시 보관함에 넣었어요' : sent.via === 'demo' ? '기록했어요' : '답장을 보냈어요' }}</b>
              <small>{{ sent.to }} · {{ sent.subject }}</small>
              <small v-if="sent.via === 'drafts'">메일 앱의 임시 보관함에서 보내 주세요.</small>
              <small v-if="sent.via === 'demo'">데모 메일함이라 실제로 보내지 않았어요.</small>
              <small v-if="linkedInst" data-test="mail-sent-inst">루틴 · {{ linkedInst.name || '진행 중인 일' }}에 기록했어요.</small>
            </div>
          </section>

          <section v-else-if="info && showReply" class="reply" data-test="mail-reply">
            <p class="cap">답장</p>
            <p v-if="drafting" class="wait shimmer-text" data-test="mail-drafting">답장 초안을 쓰는 중…</p>
            <p v-if="draftErr" class="err">{{ draftErr }}</p>
            <button v-if="!draft && !drafting" class="pill-btn sm write" data-test="mail-write" @click="write">답장 초안 쓰기</button>
            <template v-if="draft">
              <label class="field"><span>받는 사람</span><input v-model="draft.to" data-test="mail-to" autocomplete="off" /></label>
              <label class="field"><span>참조</span><input v-model="draft.cc" data-test="mail-cc" autocomplete="off" /></label>
              <label class="field"><span>제목</span><input v-model="draft.subject" data-test="mail-subject" /></label>
              <textarea v-model="draft.body" class="text-in" rows="11" data-test="mail-body" />
              <div class="chips">
                <button v-for="f in info.files" :key="f.messageId" class="chip pick press" :class="{ on: picked.includes(f.messageId) }"
                  data-test="mail-file" :aria-pressed="picked.includes(f.messageId)" @click="toggle(f.messageId)">
                  <Icon :name="picked.includes(f.messageId) ? 'check' : 'clip'" :size="13" /> {{ f.name }}
                </button>
                <span v-for="f in added" :key="f.uid" class="chip on" :class="{ bad: f.state === 'err' }" :title="f.error" data-test="mail-added">
                  <Icon name="clip" :size="13" /> {{ f.name }}<i v-if="f.state === 'up'"> · 올리는 중</i><i v-if="f.state === 'err'"> · 올리지 못함</i>
                  <button class="drop press" aria-label="빼기" data-test="mail-added-drop" @click="drop(f.uid)"><Icon name="close" :size="11" /></button>
                </span>
                <button class="chip add press" @click="fileInput.click()"><Icon name="plus" :size="13" /> 파일 첨부</button>
                <input ref="fileInput" type="file" multiple hidden @change="addFiles" />
              </div>
              <p v-if="info.mode === 'none'" class="err">Gmail에서 메일 보내기를 허락받지 않았어요. 설정에서 메일을 다시 연결하면 여기서 보낼 수 있어요.</p>
              <p v-if="failedUpload" class="err" data-test="mail-upload-failed">올리지 못한 파일은 빼고 보내거나 다시 올려 주세요.</p>
              <p v-if="sendErr" class="err" data-test="mail-send-error">{{ sendErr }}</p>
              <div class="row">
                <button class="pill-btn sm" :class="{ warn: sure }" :disabled="drafting || sending" data-test="mail-rewrite" @click="rewrite">{{ sure ? '한 번 더 누르면 새로 써요' : '다시 쓰기' }}</button>
                <button class="dark-btn sm" :disabled="!canSend" data-test="mail-send" @click="send">
                  {{ sending ? '보내는 중…' : info.mode === 'drafts' ? '임시 보관함에 넣기' : '보내기' }}
                </button>
              </div>
              <p class="hint">보내기를 누르기 전에는 아무것도 보내지 않아요.</p>
            </template>
          </section>

        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .28); display: grid; place-items: center; padding: 16px; }
.sheet { width: min(720px, 100%); min-width: 0; box-sizing: border-box; max-height: min(90vh, 940px); border-radius: 28px; padding: 20px 22px 16px;
  display: flex; flex-direction: column; gap: 10px; background: var(--bubble-agent-bg); box-shadow: var(--shadow-card); }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
header > div { min-width: 0; }
.verb { display: inline-block; height: 28px; line-height: 28px; padding: 0 8px; border-radius: 8px; background: var(--chip-bg); font-size: 14px; }
h2 { margin: 6px 0 0; font-size: 18px; font-weight: 500; line-height: 1.45; overflow-wrap: anywhere; }
.x { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--field-bg); flex: none; }
.body { overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 14px; }
section { display: flex; flex-direction: column; gap: 6px; }
.cap { margin: 0; font-size: 12.5px; color: var(--text-secondary); letter-spacing: .02em; }
.orig { border-radius: 18px; padding: 12px 14px; background: var(--field-bg); }
.meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; font-size: 14px; overflow-wrap: anywhere; }
.meta small { color: var(--text-secondary); font-size: 12.5px; }
.subj { margin: 0; font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14.5px; line-height: 1.6; }
.text.folded { max-height: 15em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
.more { align-self: flex-start; font-size: 13px; color: var(--text-secondary); padding: 2px 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; font-size: 12.5px; padding: 4px 10px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); overflow-wrap: anywhere; }
.chip.pick { border: 1px solid var(--hairline); }
.chip.on { color: var(--text-primary); background: var(--chip-bg); }
.chip.bad { color: #c2410c; }
.chip i { font-style: normal; color: var(--text-tertiary); }
.chip .drop { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; margin-left: 2px; color: var(--text-secondary); }
.pill-btn.warn { color: #c2410c; }
.field { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--hairline); padding: 4px 0; }
.field span { flex: none; width: 64px; font-size: 13px; color: var(--text-secondary); }
.field input { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; font-size: 14.5px; color: var(--text-primary); padding: 6px 0; outline: none; }
.text-in { width: 100%; box-sizing: border-box; border: 1px solid var(--hairline); border-radius: 14px; padding: 10px 12px; font: inherit; font-size: 14.5px; line-height: 1.6;
  background: var(--field-bg); color: var(--text-primary); resize: vertical; min-height: 180px; }
.row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.sm { height: 42px; }
.write { align-self: flex-start; color: var(--text-primary); }
.pill-btn:disabled { opacity: .5; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.hint { margin: 0; text-align: right; font-size: 12px; color: var(--text-tertiary); }
.wait { margin: 0; font-size: 14px; color: var(--text-secondary); }
.err { margin: 0; font-size: 13.5px; color: #c2410c; overflow-wrap: anywhere; }
.done { flex-direction: row; align-items: flex-start; gap: 10px; border-radius: 18px; padding: 12px 14px; background: var(--chip-bg); }
.done div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.done small { color: var(--text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: -2px; }
.lk { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; height: 32px; padding: 0 12px; border-radius: 9999px; background: var(--field-bg); font-size: 13px; color: var(--text-primary); overflow-wrap: anywhere; }
.lk > :deep(svg) { flex: none; color: var(--text-secondary); }
.flowwait { margin: 0; font-size: 13px; color: var(--text-secondary); }
.flow { border-radius: 18px; padding: 12px 14px; background: var(--chip-bg); gap: 8px; }
.flow .q { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; word-break: keep-all; }
.flow .why { color: var(--text-secondary); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
.flow .acts { display: flex; flex-wrap: wrap; gap: 8px; }
.flow .join { display: inline-flex; flex-direction: column; align-items: flex-start; justify-content: center; height: auto; min-height: 42px; padding: 6px 14px; max-width: 100%; text-align: left; color: var(--text-primary);
  background: var(--bubble-agent-bg); border: 1px solid var(--hairline); }
.flow .join span { overflow-wrap: anywhere; }
.flow .join small { font-size: 11.5px; color: var(--text-secondary); }
.flow .others { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); }
.nope { align-self: flex-start; font-size: 13px; color: var(--text-secondary); padding: 2px 0; text-decoration: underline; text-underline-offset: 3px; }
.flowoff { margin: 0; font-size: 13px; color: var(--text-secondary); display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.agent { text-align: left; border-radius: 18px; padding: 12px 14px; background: var(--field-bg); font-size: 15px; color: var(--text-primary); display: flex; flex-direction: column; gap: 4px; }
.agent small { color: var(--text-secondary); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
/* the card's task as the sheet's main action */
.agent.main { background: #1d1d1f; color: #fff; }
.agent.main small { color: rgba(255 255 255 / .72); }
.agent .go { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
:root[data-theme="dark"] .agent.main { background: #f5f5f7; color: #1d1d1f; }
:root[data-theme="dark"] .agent.main small { color: rgba(29 29 31 / .72); }
.event { border-radius: 18px; padding: 12px 14px; background: var(--chip-bg); gap: 4px; }
.event .done { display: flex; padding: 4px 0; background: transparent; }
.event .done > :deep(svg) { flex: none; margin-top: 3px; }
.event .line { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
.event .field input, .event .field select { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; font-size: 14.5px; color: var(--text-primary); padding: 6px 0; outline: none; }
.event .field input:disabled, .event .field select:disabled { opacity: .45; }
.whenrow { display: flex; flex-wrap: wrap; column-gap: 14px; }
.whenrow .field { flex: 1 1 200px; min-width: 0; }
.allday { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; padding: 6px 0; }
.desc { min-height: 0; margin-top: 6px; }
.summary { margin: 6px 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 14.5px; font-weight: 600; overflow-wrap: anywhere; }
.summary small { font-weight: 400; color: var(--text-tertiary); font-size: 12px; }
.note { margin: 0; font-size: 13px; color: var(--text-secondary); overflow-wrap: anywhere; }
.calink { display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 13.5px; color: var(--color-info, #2a78d6); text-decoration: none; }
@media (max-width: 520px) {
  .veil { padding: 8px; align-items: end; }
  .sheet { max-height: 94vh; border-radius: 24px; padding: 16px 16px 12px; }
}
.atts { flex-direction: column; align-items: flex-start; }
/* the head's handle: the mail dragged as a mention */
.grip { display: inline-grid; place-items: center; width: 22px; height: 28px; margin-right: 4px; vertical-align: top; border-radius: 7px; color: var(--text-tertiary); cursor: grab; }
.grip:hover { background: var(--chip-bg); color: var(--text-secondary); }
.grip:active { cursor: grabbing; }
/* while the mail is dragged: what is under the sheet takes the drop */
.veil.passing { pointer-events: none; background: transparent; }
.veil.passing .sheet { animation: none; opacity: .28; transition: opacity .15s; }
/* 폴더에 정리: the attachments light up once */
.orig.lit .atts { animation: atts-lit 2.2s ease-out both; border-radius: 12px; }
@keyframes atts-lit { 0%, 60% { box-shadow: 0 0 0 3px rgba(60 110 240 / .7); } 100% { box-shadow: 0 0 0 3px rgba(60 110 240 / 0); } }
.atts .att { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; max-width: 100%; gap: 4px; }
/* an attachment: a chip that opens it, its ⋯ menu */
.arow { display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; }
.achip { min-width: 0; gap: 7px; padding: 3px 12px 3px 4px; color: var(--text-primary); background: var(--bubble-agent-bg); border: 1px solid var(--hairline); text-align: left; }
.achip .fx { flex: none; width: 26px; height: 22px; border-radius: 7px; display: grid; place-items: center; font-size: 9px; font-weight: 700; color: #fff; background: #6b6b66; }
.achip .fx.XLS { background: #217346; } .achip .fx.DOC { background: #2b579a; } .achip .fx.PPT { background: #c43e1c; } .achip .fx.PDF { background: #d93025; }
.achip .fx.한글 { background: #1f6fd1; } .achip .fx.IMG { background: #7b3fbf; } .achip .fx.AUD { background: #0e7c86; } .achip .fx.VID { background: #b0306a; } .achip .fx.MD, .achip .fx.TXT { background: #3d4451; }
.achip .an { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.achip small { flex: none; color: var(--text-tertiary); font-size: 11.5px; }
.achip[aria-busy="true"] { opacity: .75; }
.achip { cursor: pointer; }
.amore { flex: none; width: 30px; height: 30px; padding: 0; justify-content: center; border: 1px solid var(--hairline); background: var(--bubble-agent-bg); color: var(--text-secondary); }
.amenu { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px; border-radius: 14px; background: var(--bubble-agent-bg); border: 1px solid var(--hairline); box-shadow: 0 6px 20px rgba(0 0 0 / .08); }
.amenu button { display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 12px; border-radius: 9999px; font-size: 13px; color: var(--text-primary); background: var(--field-bg); }
.amenu button > :deep(svg) { color: var(--text-secondary); }
.adl { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12.5px; color: var(--text-secondary); }
.adl .dl { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 11px; border-radius: 9999px; font-size: 12.5px; color: var(--text-primary); background: var(--chip-bg); text-decoration: none; }
.aedit { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; height: 28px; padding: 0 11px; border-radius: 9999px; font-size: 12.5px; color: var(--text-primary); background: var(--chip-bg); text-align: left; }
.aedit span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ashare { margin: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; max-width: 100%; font-size: 12.5px; color: var(--text-secondary); }
.ashare span { min-width: 0; overflow-wrap: anywhere; }
.ashare .off { height: 26px; padding: 0 11px; border-radius: 9999px; font-size: 12px; color: var(--text-primary); background: var(--chip-bg); border: 1px solid var(--hairline); }
</style>
