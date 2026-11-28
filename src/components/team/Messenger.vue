<script setup>
// The team messenger sheet: one list of conversations (1:1 and group rooms) and chips over it (2026-11-28 「받은 편지함 = 대화의
// 거르개」 — the 받은 편지함 tab and its own blocks are gone): 전체 · 나에게 온 것 (the rooms' shares, mentions, file links, mail mentions,
// questions and answers from others — each drawn as its room draws it, RoomMessage.vue, with 「어느 방 · 누가」 over it; pressed, the room
// opens at that message) · 안 읽음 · 메일 (my mail cards — another source). One read state: the room's (seen in 나에게 온 것 → read up to it).
// Where it sits (2026-11-24): floating over the page as it always was, or docked — a column at the right or left edge, or in
// the document panel beside an open document — so the conversation goes on while the page is used (src/messengerDock.js,
// ./useMessengerDock.js). The header is dragged onto a drop zone, or the dock button picks the place. A phone keeps the sheet.
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount, provide } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import { useApp } from '../../stores/app.js'
import { useTeam, shareable } from '../../stores/team.js'
import { kindOf, kindLabel, viewMedia, mediaKindOf, sawShare } from '../../artifacts.js'
// my share cards' people (src/shareReceipts.js): which cards to ask for
import { missingReceipts } from '../../shareReceipts.js'
// a picture · sound · video sent in the room: shown or played in place, opened in the viewer (not an editor) — src/openPlan.js
import { openPlan } from '../../openPlan.js'
import { craftMissing } from '../../officeEditor.js'
import { BASE } from '../../base.js'
import { useMeetings } from '../../stores/meetings.js'
// (an agent's reply in a room names sandbox paths too: they read as file names, as in the chat — src/paths.js)
import { hidePaths } from '../../paths.js'
// one message as its room draws it — in the open conversation and in 나에게 온 것 alike (what it does is provided below)
import RoomMessage from './RoomMessage.vue'
// a person's circle, the same everywhere (PersonAvatar.vue) — and the name the server gives every screen (src/people.js)
import PersonAvatar from '../PersonAvatar.vue'
import { tagsFor, labelOf } from '../../people.js'
// the one picker of teammates: a new conversation, inviting into a group room, a group made from a 1:1
import PeoplePicker from './PeoplePicker.vue'
import { uploadTeamFile, api } from '../../api.js'
import { useMessengerDock } from './useMessengerDock.js'
import DockMenu from './DockMenu.vue'
import { narrow } from '../../viewport.js'
import { verbLabel } from '../../mailKind.js'
// files of the app dragged in (src/fileDrag.js): a folder's file, a chat artifact or a received file — a link or a share
import { dragKind, dragging as draggedItems, itemsOf, zoneWords, startDrag, shareItem, same, MAX as MAX_ITEMS } from '../../fileDrag.js'
// "@" near the caret, as in the chat composer (useTeammateMention.js)
import { caretXY } from './useTeammateMention.js'
// a room's settings (its name) and reactions on a teammate's bubble (2026-11-26 사용자 「대화방 설정으로 대화방 명칭 바꿀 수 있게하고 다른
// 사람 말풍선에 좋아요 확인했음 사랑해 웃음 등을 붙힐 수 있게」 — server lib/team/messenger.js rename · lib/team/reactions.js)
import RoomSettings from './RoomSettings.vue'
import ReactionBar from './ReactionBar.vue'
import { canReact } from '../../roomReactions.js'
// 나에게 온 것: when an item counts as seen, how far its room is read then (src/forMeSeen.js)
import { seenEnough, readRun, thresholdFor } from '../../forMeSeen.js'
// what another app shared to Process GPT, meant for a room (components/ShareArrival.vue · src/shareInbox.js)
import { inbox, loadDraft, saveDraft } from '../../shareInbox.js'

const app = useApp()
const team = useTeam()
// meetings in the room (stores/meetings.js): the header's 회의 시작 / 참여, and the meeting's record cards
const mt = useMeetings()
watch(() => team.active, (id) => { if (id) mt.loadRoom(id) }, { immediate: true })
const roomMeeting = computed(() => mt.roomOf(team.active))
const router = useRouter()
const draft = ref('')
const attach = ref([])         // my file cards to send along
const attachOpen = ref(false)
const picking = ref(false)     // new thread: choose teammates
const people = ref(null)
// the open room's 「초대」 (a group: invite teammates in) · 「단체방 만들기」 (a 1:1: a new group with both and the ones picked —
// the 1:1 stays private), 2026-11-25 「기존 단체 메신저 대화창에서 신규인원 초대가 가능해야.」
const inviting = ref(false)
const scroller = ref(null)
const busy = ref('')
const err = ref('')
const { lay, docked, dockable, box, drag, dropZones, dragStart, resizing, resizeStart, resizeKey } = useMessengerDock()
// one column (the list, or one conversation with ‹): a phone, or a docked column too narrow for both
const single = computed(() => narrow.value || lay.value.single)
const close = () => { team.open = false }
// what a drop zone does, said on it while the header is dragged
const zoneWord = { left: '왼쪽에 붙이기', right: '오른쪽에 붙이기', panel: '문서 패널에 넣기', float: '떠 있게 두기' }

// The list's chips (stores/team.js filter): 전체 · 나에게 온 것 · 안 읽음 (the rooms, by their one read state) · 메일. The count is said
// once — on 안 읽음, the rooms' unread messages (it was said twice, on 받은 편지함 and on 대화, for the same items); 나에게 온 것 has a dot.
const CHIPS = [{ id: 'all', label: '전체' }, { id: 'forme', label: '나에게 온 것' }, { id: 'unread', label: '안 읽음' }, { id: 'mail', label: '메일' }]
const forMeUnread = computed(() => team.forMe.some((x) => x.unread))
const shownThreads = computed(() => (team.filter === 'unread' ? team.threads.filter((t) => team.unread.byThread[t.id]) : team.threads))
// 대화 › 메일: the cards made from mail — one put away from Home is still here, and opens the same mail sheet (2026-11-23: Home is
// notifications; the mail is kept here). Another source than the rooms (pro_actions): no read state of its own.
const mails = ref(null)
async function loadMails() { try { mails.value = await app.mailCardList() } catch { mails.value = mails.value || [] } }
watch(() => team.filter, (k) => { if (k === 'mail') loadMails(); if (k === 'forme') team.loadForMe() }, { immediate: true })
watch(() => app.mailCard, (a, was) => { if (!a && was && team.filter === 'mail') loadMails() })
const fromName = (f) => String(f || '').split('<')[0].replace(/"/g, '').trim() || String(f || '').replace(/[<>]/g, '')
const mailState = (a) => (a.source?.sent ? '답장함' : a.source?.event ? (a.source.event.via === 'demo' ? '일정 기록함' : '캘린더에 넣음') : a.status === 'dismissed' ? '홈에서 닫음' : a.status === 'done' ? '처리함' : a.status === 'running' ? '진행 중' : '홈에 있음')
const thread = computed(() => team.threads.find((t) => t.id === team.active) || null)
const list = computed(() => team.msgs[team.active] || [])
const myFiles = computed(() => (app.messages[app.mainThread?.id] || []).filter(shareable).slice(-12).reverse())
const otherOf = (t) => (t.members || []).find((p) => p.id !== app.me?.user?.id) || null
// Same-named people told apart (src/sameNames.js — 2026-11-25: one person's two accounts were two identical 「윤가람」 rows): the 1:1
// rooms' other people across the list, and a room's people within that room. A room named by its people (no title of its own) says
// them with their tags; a room with its own title keeps it.
const othersOf = (t) => (t?.members || []).filter((p) => p.id !== app.me?.user?.id)
const namedByPeople = (t) => !!t && t.title === othersOf(t).map((p) => p.name).join(', ')
const listTags = computed(() => tagsFor(team.threads.filter((t) => t.kind !== 'group' && namedByPeople(t) && othersOf(t).length === 1).map(otherOf)))
function titleOf(t) {
  if (!namedByPeople(t)) return t?.title || ''
  const others = othersOf(t)
  if (t.kind !== 'group' && others.length === 1) return labelOf(listTags.value, others[0])
  const tags = tagsFor(t.members)
  return others.map((p) => labelOf(tags, p)).join(', ')
}
const roomTags = computed(() => tagsFor(thread.value?.members || []))
const memberLabel = (m) => labelOf(roomTags.value, m)
const when = (d) => {
  const t = new Date(d), mins = Math.round((Date.now() - t) / 60000)
  return mins < 1 ? '방금' : mins < 60 ? `${mins}분 전` : t.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
// team assist: the suggestion cards under the message that prompted them (lib/team/assist.js)
const sugOf = (id) => (team.suggestions[team.active] || []).filter((x) => x.messageId === id)

async function toBottom() {
  await nextTick()
  const el = scroller.value
  if (!el) return
  const f = team.focus && el.querySelector(`[data-id="${team.focus}"]`)
  if (f) { f.scrollIntoView({ block: 'center' }); f.classList.add('flash'); team.focus = null } else el.scrollTop = el.scrollHeight
}
watch(() => [team.active, list.value.length, (team.suggestions[team.active] || []).length], toBottom)

async function run(key, fn) {
  busy.value = key; err.value = ''
  try { await fn() } catch (e) { err.value = e.message || '처리하지 못했어요.' } finally { busy.value = '' }
}
// A file opens in the office panel (stores/team.js openShared). When it does not, the reason stays under the file — with the
// link when it is a format the app has no viewer for (the person opens it: a window opened after the wait may be blocked).
const notes = ref({}) // shareId | branch room+path → {reason, url}
// A format with no viewer here is no alarm: a calm line with its link (calm). A failure (the share taken back, the original gone,
// the open document not saved yet) keeps the warning.
async function opening(key, job) {
  busy.value = key; err.value = ''
  let r
  try { r = await job() } catch (e) { r = { opened: false, reason: e.message || '열지 못했어요.' } } finally { busy.value = '' }
  notes.value = { ...notes.value, [key]: r?.opened ? null : { reason: r?.reason || '열지 못했어요.', url: r?.how === 'link' ? r.url : '', calm: r?.how === 'link' } }
}
const openFile = (a) => {
  if (!a.shareId) return
  if (mediaOf(a)) return viewShare(a)
  opening(`f${a.shareId}`, () => team.openShared(a.shareId, router))
}
const noteOf = (a) => notes.value[`f${a.shareId}`]

// A picture, a sound or a video sent in the room shows right here (MediaPreview.vue) from the share's own address: the server
// answers it only to the people it was shared with and its sender, as it does for opening it (GET /team/shares/:id/raw). An <img>
// or an <audio> sends no header, so the address is signed for this person for 15 minutes (a.link, from the room's messages;
// server lib/team/mediaLink.js) — no sign-in token in it, so none in a proxy's log or the browser's history. One that has run out
// (a room left open, a file that did not load) gets a new address (GET …/link). Pressed, it opens the viewer (MediaViewer.vue),
// never an editor by itself; its ArtCraft app only from the viewer's 「… 로 편집」, where this install has it
// (2026-11-25 「포토크래프트등의 편집기는 편집의 의도가 있을따만 시도하는 것이고」).
const links = ref({}) // shareId → a newer signed path than the message's
const mediaOf = (a) => (a?.shareId ? mediaKindOf(a) : '')
const linkOf = (a) => links.value[a.shareId] || a.link || ''
const shareSrc = (a) => (linkOf(a) ? `${BASE}/api${linkOf(a)}` : '')
const expOf = (l) => Number(/[?&]exp=(\d+)/.exec(l || '')?.[1] || 0)
const asked = {} // shareId → when a new address was last asked for (once in 30 s: a file that is really gone does not loop)
async function relink(a) {
  if (!a?.shareId || Date.now() - (asked[a.shareId] || 0) < 30_000) return ''
  asked[a.shareId] = Date.now()
  try {
    const { link } = await api(`/team/shares/${encodeURIComponent(a.shareId)}/link`)
    if (link) links.value = { ...links.value, [a.shareId]: link }
    return link || ''
  } catch { return '' }
}
async function viewShare(a) {
  // (an address about to run out is renewed first: the viewer's 「새 창에서 열기」 uses it too)
  if (!linkOf(a) || expOf(linkOf(a)) - Date.now() / 1000 < 120) await relink(a)
  // open=1: a file sent to me, opened — the server records it for its sender's card (「열어 봄」); the small preview above asks without it
  const url = shareSrc(a) && !a.own ? `${shareSrc(a)}&open=1` : shareSrc(a)
  if (!url) return opening(`f${a.shareId}`, () => team.openShared(a.shareId, router))
  const { editWith } = openPlan({ name: a.name, type: a.type, url }, { craftMissing })
  viewMedia(app, { kind: mediaOf(a), url, name: a.name, editWith, edit: () => team.openShared(a.shareId, router, { edit: true }) })
}
// a picture that has just loaded makes the conversation taller: one being read at its end stays at its end
function grown() { const el = scroller.value; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 320) el.scrollTop = el.scrollHeight }
// on my own share, "이어서 작업" gathers what came back; a conflict is picked here first
const conflictOf = ref({}) // messageId → conflicts
const cont = (m, choices) => run(`c${m.id}`, async () => {
  try { await team.continueWork(m.id, router, choices); delete conflictOf.value[m.id] } catch (e) {
    if (!e.conflicts) throw e
    conflictOf.value = { ...conflictOf.value, [m.id]: e.conflicts }
  }
})
// My shares: for each person a file went to — not opened yet, opened (when), or what their copy (branch) changed since
// (server lib/team/shares.js receipts, one request for the room; a first open comes live: stores/team.js 'opened'). Only I, the
// sender, see it (2026-11-26 사용자: 「아직그대로는 뭔가? 혹시 확인여부 ㅡ 파일을 열어서 봤는지라면 좋은데」).
const ownShares = computed(() => list.value.filter((m) => m.mine && (m.kind === 'share' || m.kind === 'mention') && m.artifacts?.length).map((m) => m.id))
// A room opened: all of its cards once (a copy that changed since has no live event). After that only cards not asked for yet — a
// share just sent, older messages loaded; a first open comes by itself ('opened').
let freshFor = ''
watch(() => team.open, (o) => { if (!o) freshFor = '' })
watch(() => [team.open, team.active, ownShares.value.join()], () => {
  if (!team.open || !team.active || !ownShares.value.length) return
  const ids = freshFor === team.active ? missingReceipts(ownShares.value, team.receipts) : ownShares.value
  freshFor = team.active
  if (ids.length) team.loadReceipts(team.active, ids).catch(() => {})
}, { immediate: true })
const openBranch = (b, path) => opening(`b${b.room}${path}`, () => team.openBranchFile(b.room, path))
// a sound or a video sent to me, played here: opened (its sender's card says so)
const played = (a) => { if (!a.own) sawShare(a.shareId) }

// ---- 대화 › 나에게 온 것: the rooms' messages for me, as their rooms draw them, with 「어느 방 · 누가」 over each ----
const roomOf = (m) => team.threads.find((t) => t.id === m.threadId) || null
const whereOf = (m) => { const t = roomOf(m); return t ? titleOf(t) : '대화' }
// (a 1:1 room is called by its other person: the writer once is enough)
const whoOf = (m) => (m.sender?.name && m.sender.name !== whereOf(m) ? m.sender.name : '')
// pressed: its room opens at it (it was 「답장」) — the room open on the screen is read, as any room opened
const openItem = (m) => team.openThread(m.threadId, m.id)
// Seen: an unread item that stays in view a moment (1.2 s — most of it, or most of the list for an item taller than the list) counts as
// seen. A room is read only up to its newest item of the run of unread items that have all been seen, counted from its oldest unread one
// (server lib/team/messenger.js markRead upTo) — an older item below the fold that was never on screen keeps its unread and its Home card
// (PR #127 review). Seen items are gathered for a moment: one request per room, for its newest such item.
const formeEl = ref(null)
const SEEN_MS = 1200
const seenTimers = new Map() // message id → timer
const seenIds = new Set()    // items seen on this screen
const seenRooms = new Set()  // rooms with a newly seen item, read on the next flush
let flushT = null
function flushSeen() {
  flushT = null
  if (!team.open || document.visibilityState !== 'visible') return
  for (const room of [...seenRooms]) {
    seenRooms.delete(room)
    const run = readRun(team.forMe, room, seenIds)
    if (run) team.markRead(room, { upTo: run.to.id, from: run.from.id }).catch(() => {})
  }
}
function seen(id) {
  seenTimers.delete(id)
  const m = team.forMe.find((x) => x.id === id)
  if (!m?.unread || !team.open || document.visibilityState !== 'visible') return
  seenIds.add(id)
  seenRooms.add(m.threadId)
  clearTimeout(flushT)
  flushT = setTimeout(flushSeen, 250)
}
// one observer per item, with the one threshold that item needs (its own 60 %, or for a tall item the share that fills 60 % of the list)
let seenObs = []
function observeSeen() {
  for (const o of seenObs) o.disconnect()
  seenObs = []
  for (const t of seenTimers.values()) clearTimeout(t)
  seenTimers.clear()
  const root = formeEl.value
  if (!root || team.filter !== 'forme' || typeof IntersectionObserver === 'undefined') return
  const R = root.clientHeight
  const on = (entries) => {
    for (const e of entries) {
      const id = e.target.dataset.forme
      if (seenEnough(e)) { if (!seenTimers.has(id) && !seenIds.has(id)) seenTimers.set(id, setTimeout(() => seen(id), SEEN_MS)) }
      else if (seenTimers.has(id)) { clearTimeout(seenTimers.get(id)); seenTimers.delete(id) }
    }
  }
  for (const el of root.querySelectorAll('[data-test="forme-item"][data-unread="true"]')) {
    const o = new IntersectionObserver(on, { root, threshold: [0, thresholdFor(el.getBoundingClientRect().height, R)] })
    o.observe(el)
    seenObs.push(o)
  }
}
watch(() => [team.filter, team.open, team.forMe.map((x) => `${x.id}${x.unread ? 1 : 0}`).join()], () => nextTick(observeSeen))
// (the messenger closed: what was seen on it is forgotten — a new look counts anew)
watch(() => team.open, (o) => { if (!o) { seenIds.clear(); seenRooms.clear() } })
const onVisible = () => { if (document.visibilityState === 'visible') nextTick(observeSeen) }
async function send() {
  // (the room this is sent to, kept: the person may move to another room while it goes)
  const room = team.active
  let text = draft.value.trim()
  // 「@AI 」 typed out in full (not picked from the list) addresses the AI the same way as its chip
  if (!aiOn.value && /^@AI\s/i.test(`${text} `)) { aiOn.value = true; text = text.replace(/^@AI\s*/i, '') }
  if ((!text && !attach.value.length && !ups.value.length && !refs.value.length && !aiOn.value) || !room) return
  await run('send', async () => {
    // files still going up are waited for; one that could not go stops the send (its chip says why)
    await Promise.allSettled(ups.value.map((u) => u.job).filter(Boolean))
    if (ups.value.some((u) => u.state !== 'ready')) throw new Error('올리지 못한 파일이 있어요. 빼고 다시 보내 주세요.')
    if (refs.value.some((r) => r.wait)) throw new Error('끌어다 놓은 파일을 확인하고 있어요. 잠시 뒤에 보내 주세요.')
    if (refs.value.some((r) => r.error)) throw new Error('보낼 수 없는 파일이 있어요. 빼고 다시 보내 주세요.')
    const ai = aiOn.value
    const named = mentioned.value.filter((p) => text.includes(`@${p.name}`)).map((p) => p.id)
    await team.send(room, ai ? `@AI ${text}`.trim() : text, [...attach.value.map((m) => m.id), ...ups.value.map((u) => u.card.id)],
      { refs: refs.value.map((r) => (r.mail ? { type: 'mail', actionId: r.mail.actionId, body: !!r.body }
        : r.att ? { type: 'mailatt', actionId: r.att.actionId, i: r.att.i, name: r.att.name, share: !!r.share } : r.ref)), ai, mentions: named })
    // sent: that room keeps no words (moving away mid-send kept them as its draft — sent text must not come back to be sent twice) …
    saveDraft(room, '')
    attach.value = []
    // … and the box is emptied only if that room is still the one open (another room's words, chips and @ stay as they are)
    if (team.active !== room) return
    draft.value = ''; ups.value = []; refs.value = []; aiOn.value = false; mentioned.value = []
  })
}

// ---- files of the app dragged in (src/fileDrag.js): a shared folder's file → a link chip, an artifact of mine → a share chip ----
const refs = ref([])           // {key, name, folder, ref, variation, wait, error}: file mentions to send (links, not copies)
async function addItems(items) {
  const room = Math.max(0, MAX_ITEMS - refs.value.length - attach.value.length - ups.value.length)
  const fresh = items.filter((it) => !refs.value.some((r) => r.item && same(r.item, it)) && !(it.src === 'card' && attach.value.some((m) => m.id === it.id)))
  err.value = fresh.length > room ? `파일은 한 번에 ${MAX_ITEMS}개까지 보낼 수 있어요.` : ''
  const list = fresh.slice(0, room)
  if (!list.length) return
  // (chips at once — what each one is comes back from the server, with my own access)
  const temp = list.map((it) => reactive({ key: crypto.randomUUID(), item: it, name: it.name || '파일', folder: it.folder || '', wait: true, error: '' }))
  refs.value.push(...temp)
  let res = []
  try { res = await team.resolveItems(list) } catch (e) { for (const t of temp) { t.wait = false; t.error = e.message || '확인하지 못했어요' } return }
  temp.forEach((t, i) => {
    const r = res[i]
    if (!r?.ok) { t.wait = false; t.error = r?.error || '보낼 수 없는 파일이에요'; return }
    // a mail of mine: a mention — its summary for the others, the body only when 「본문도 공유」 is on (on unless I turn it off —
    // 2026-11-27 사용자 「메일 본문 내용 공유는 기본값임」; a file of it stays off)
    if (r.as === 'mail') { Object.assign(t, { wait: false, name: r.name, mail: r.mail, from: r.mail?.from || '', body: true }); return }
    // an attachment of my mail (server lib/mailAttachments.js): its name and the mail's summary — the file only when 「파일도 공유」 is on
    if (r.as === 'mailatt') { Object.assign(t, { wait: false, name: r.name, att: r.att, share: false }); return }
    if (r.as === 'share') {
      refs.value = refs.value.filter((x) => x.key !== t.key)
      if (!attach.value.some((m) => m.id === r.cardId)) attach.value = [...attach.value, { id: r.cardId, content: { name: r.name }, dropped: true }]
      return
    }
    Object.assign(t, { wait: false, name: r.ref.name, folder: r.ref.folder, ref: r.ref, variation: r.ref.variation })
  })
  nextTick(() => taEl.value?.focus())
}
const dropRef = (r) => { refs.value = refs.value.filter((x) => x.key !== r.key) }

// ---- "@": the people of this conversation and 「AI」 (lib/team/aiHelp.js answers a message addressed to it) ----
const taEl = ref(null)
// 「답장」 on a room's phone notification opened this room (stores/team.js openMessenger reply): the composer is ready to type in — also
// when this sheet (loaded on demand) comes up after the room was asked for
watch(() => team.replyAt, async (at) => {
  if (!at || Date.now() - at > 5000) return
  for (let i = 0; i < 40 && !taEl.value; i++) await new Promise((ok) => setTimeout(ok, 50))
  await nextTick()
  taEl.value?.focus()
}, { immediate: true })
const aiOn = ref(false)
const mentioned = ref([])      // people named with @ in this draft: [{id, name}]
const at = reactive({ open: false, query: '', pos: -1, x: 0, active: 0 })
const atItems = computed(() => {
  const qy = at.query.toLowerCase()
  const ai = { key: 'ai', type: 'ai', name: 'AI', sub: '공유 폴더 · 이 대화의 파일에서 찾아 붙이거나 일을 맡아요' }
  const people = (thread.value?.members || []).filter((p) => p.id !== app.me?.user?.id).map((p) => ({ key: p.id, type: 'person', id: p.id, name: p.name, label: memberLabel(p), sub: '이 대화의 사람' }))
  return [...(aiOn.value ? [] : [ai]), ...people].filter((x) => !qy || x.name.toLowerCase().includes(qy))
})
function atUpdate() {
  const el = taEl.value
  if (!el) return
  const before = draft.value.slice(0, el.selectionStart ?? draft.value.length)
  const m = /(^|\s)@([^\s@]{0,20})$/.exec(before)
  if (!m) { at.open = false; return }
  if (!at.open) at.active = 0
  at.query = m[2]; at.pos = before.length - m[2].length - 1
  at.x = Math.max(0, Math.min(caretXY(el).x - 8, el.clientWidth - 260))
  at.open = true
}
async function atPick(it) {
  if (!it) return
  const pos = at.pos, end = pos + 1 + at.query.length
  const rest = draft.value.slice(end).replace(/^\s*/, '')
  let caret = pos
  if (it.type === 'ai') { aiOn.value = true; draft.value = draft.value.slice(0, pos) + rest }
  else {
    draft.value = `${draft.value.slice(0, pos)}@${it.name} ${rest}`
    caret = pos + it.name.length + 2
    if (!mentioned.value.some((p) => p.id === it.id)) mentioned.value.push({ id: it.id, name: it.name })
  }
  at.open = false
  await nextTick()
  taEl.value?.focus()
  taEl.value?.setSelectionRange(caret, caret)
}
function atKey(e) {
  if (!at.open) {
    // Backspace on an empty box takes the AI chip back
    if (e.key === 'Backspace' && !draft.value && aiOn.value) { aiOn.value = false; return true }
    return false
  }
  const n = atItems.value.length
  if (e.key === 'ArrowDown' && n) { at.active = (at.active + 1) % n; e.preventDefault(); return true }
  if (e.key === 'ArrowUp' && n) { at.active = (at.active - 1 + n) % n; e.preventDefault(); return true }
  if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing && n) { e.preventDefault(); atPick(atItems.value[at.active]); return true }
  if (e.key === 'Escape') { at.open = false; e.preventDefault(); return true }
  return false
}
watch(draft, () => nextTick(atUpdate))
// the box grows with what is in it, up to its max-height (several lines put in at once — a share from another app — show, not only the first)
watch(draft, () => nextTick(() => { const el = taEl.value; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 120)}px` }))
const atBlur = () => setTimeout(() => { at.open = false }, 150)
const aiWait = computed(() => team.aiStatus[team.active] || null)

// files from the computer (2026-11-24 「끌어다놓기 첨부가 안되네」): dropped on the open conversation, pasted, or 「내 컴퓨터에서」 —
// each goes up at once (a chip with how much has gone) and becomes a file card of mine (server lib/team/uploads.js); 보내기 shares
// them like my other cards. 50MB a file, 10 files with the picked ones.
const MAX_FILES = 10, MAX_BYTES = 50 * 1024 * 1024
const ups = ref([])            // {id, name, size, progress, state: uploading|ready|error, card, error, job}
const filePick = ref(null)
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)
// (share: the id of a share from another app — its chips go again if the person puts it somewhere else)
function addFiles(list, share = null) {
  const files = [...list]
  const room = Math.max(0, MAX_FILES - attach.value.length - ups.value.length)
  err.value = files.length > room ? `파일은 한 번에 ${MAX_FILES}개까지 보낼 수 있어요.` : ''
  for (const f of files.slice(0, room)) {
    const u = reactive({ id: crypto.randomUUID(), name: f.name, size: f.size, progress: 0, state: 'uploading', card: null, error: '', job: null, share })
    ups.value.push(u)
    if (f.size > MAX_BYTES) { u.state = 'error'; u.error = '50MB 초과'; continue }
    u.job = uploadTeamFile(f, (p) => { u.progress = p })
    u.job.then((c) => { u.card = c; u.state = 'ready' }).catch((e) => { if (!e.aborted) { u.state = 'error'; u.error = e.message } })
  }
  attachOpen.value = false
}
const dropUp = (u) => { u.job?.abort?.(); ups.value = ups.value.filter((x) => x.id !== u.id) }
function picked(e) { if (e.target.files.length) addFiles(e.target.files); e.target.value = '' }
function onPaste(e) {
  const fs = [...(e.clipboardData?.files || [])]
  if (fs.length) { e.preventDefault(); addFiles(fs) }
}
// The whole sheet is the messenger's (data-own-drop, and the events stop here): a file dragged over it never reaches the chat's
// page-wide drop under it (Composer.vue). Over an open conversation it shows 「여기에 놓으면 보내요」; elsewhere nothing is taken.
// Files of the app (a folder's file, a chat artifact, a received file — src/fileDrag.js) are told apart from the computer's by the drag's
// type: they become a link (「여기에 놓으면 링크로 멘션해요」) or a share chip; files from the computer still go up as before.
const dragging = ref(false)
const dropWords = ref('여기에 놓으면 보내요')
let depth = 0
const kindIn = (e) => dragKind(e.dataTransfer?.types)
const canDrop = () => !!thread.value
function dragEnter(e) {
  const k = kindIn(e)
  if (!k) return
  e.preventDefault(); depth++
  dropWords.value = k === 'pgl' ? zoneWords('messenger', draggedItems()) : '여기에 놓으면 보내요'
  dragging.value = canDrop()
}
function dragOver(e) { const k = kindIn(e); if (!k) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = !canDrop() ? 'none' : k === 'pgl' ? 'link' : 'copy' }
function dragLeave(e) { if (!kindIn(e)) return; if (--depth <= 0) { depth = 0; dragging.value = false } }
function dropped(e) {
  const k = kindIn(e)
  if (!k) return
  e.preventDefault(); depth = 0; dragging.value = false
  if (!canDrop()) return
  if (k === 'pgl') addItems(itemsOf(e))
  else if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
}
watch(() => team.active, () => { for (const u of ups.value) u.job?.abort?.(); ups.value = []; refs.value = []; aiOn.value = false; mentioned.value = [] })
// Each room keeps its own unsent words, for this window and person (src/shareInbox.js — sessionStorage): a share from another app
// reloads the page, and the room's words come back with the shared ones added after them (2026-11-26 review). Sent: gone.
watch(() => team.active, (room, was) => { if (was) saveDraft(was, draft.value); draft.value = room ? loadDraft(room) : '' }, { immediate: true })
watch(draft, (v) => saveDraft(team.active, v))
// 다른 앱의 「공유」로 온 파일 · 글 (2026-11-26 「지금 현재 대화창이 열려 있다고 치면 팀 메시지에 여기에 곧바로 첨부를 할 수 있을 거야.」): once the
// room it was meant for is open here, the files go up as chips (as if picked with 「내 컴퓨터에서」) and the words go in the box — nothing
// is sent until the person presses 보내기. 「다른 곳에」 (ShareArrival) takes them back out.
watch(() => [inbox.forRoom, team.active], () => {
  const s = inbox.forRoom
  if (!s || team.active !== s.room) return
  inbox.forRoom = null
  if (s.files?.length) addFiles(s.files, s.key)
  if (s.text) draft.value = draft.value.trim() ? `${draft.value.trimEnd()}\n${s.text}` : s.text
}, { immediate: true })
watch(() => inbox.takeBack, (t) => {
  if (!t) return
  for (const u of ups.value.filter((x) => x.share === t.key)) dropUp(u)
  if (t.text && draft.value.includes(t.text)) draft.value = draft.value.replace(t.text, '').trim()
})
function onKey(e) {
  if (atKey(e)) return
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
}
// a file shared in a message can be dragged on too (into another conversation, the AI chat, a folder)
const dragShare = (e, a) => { if (a.shareId) startDrag(e, [shareItem(a)]); else e.preventDefault() }
const toggleAttach = (m) => { attach.value = attach.value.some((x) => x.id === m.id) ? attach.value.filter((x) => x.id !== m.id) : [...attach.value, m].slice(0, 5) }

async function loadPeople() {
  people.value = null
  const d = await team.suggest('fast').catch(() => null)
  people.value = d ? [...d.frequent, ...d.rest] : []
}
function newThread() { inviting.value = false; picking.value = true; loadPeople() }
const start = (ids) => run('start', async () => { await team.startThread(ids); picking.value = false })
function openInvite() { picking.value = false; settings.value = false; inviting.value = true; loadPeople() }
const isGroup = computed(() => thread.value?.kind === 'group')
const doInvite = (ids) => run('invite', async () => {
  const t = thread.value
  if (!t) return
  if (t.kind === 'group') await team.invite(t.id, ids)
  else await team.startThread([...t.members.map((m) => m.id).filter((id) => id !== app.me?.user?.id), ...ids])
  inviting.value = false
})
watch(() => team.active, () => { inviting.value = false; settings.value = false; rx.value = null })

// ---- the room's settings: its name (a group room; any of its people — as in Process GPT) ----
const settings = ref(false)
function openSettings() { inviting.value = false; settings.value = !settings.value }
// its own name ('' when it is called by its people) and what it is called without one
const ownName = computed(() => (thread.value && !namedByPeople(thread.value) ? thread.value.title || '' : ''))
const autoName = computed(() => {
  const t = thread.value
  if (!t) return ''
  const tags = tagsFor(t.members)
  return othersOf(t).map((p) => labelOf(tags, p)).join(', ')
})
const saveName = (name) => run('rename', async () => { await team.rename(thread.value.id, name); settings.value = false })

// ---- reactions: a long press (phone), the hover button or a right-click (desktop) on someone else's bubble opens the bar over it ----
// (the bar sits in the sheet, over the list the bubble is in — the open conversation or 나에게 온 것 — and inside it)
const sheet = ref(null)
const rxBar = ref(null)
const rx = ref(null)           // {m, anchor: {top, bottom, left}, x, top, left, ready}
const rxOf = (m) => (list.value.find((x) => x.id === m.id) || team.forMe.find((x) => x.id === m.id) || m).reactions || []
async function openRx(m, el, at = {}) {
  // (no reactions in this database yet — sql/062: the long press still offers 「복사」, a message with no words has nothing then)
  if (!canReact(m) || !el || !sheet.value || ((team.rxOff || !team.rxKnown) && !m.body && !m.answer?.text)) return
  const b = el.getBoundingClientRect()
  rx.value = { m, anchor: { top: b.top, bottom: b.bottom, left: b.left }, x: Number.isFinite(at.x) ? at.x : null, top: 0, left: 0, ready: false }
  await nextTick()
  const box = rxBar.value?.el, pr = sheet.value.getBoundingClientRect(), sc = el.closest('.scroll')?.getBoundingClientRect()
  if (!box || !rx.value) return
  const w = box.offsetWidth, h = box.offsetHeight
  const minTop = (sc ? sc.top : pr.top) - pr.top + 4, maxTop = (sc ? sc.bottom : pr.bottom) - pr.top - h - 4
  // over the bubble when there is room, else under it; from where the right-click was, else the bubble's start — inside the pane
  let top = rx.value.anchor.top - pr.top - h - 8
  if (top < minTop) top = Math.min(rx.value.anchor.bottom - pr.top + 8, Math.max(minTop, maxTop))
  const left = Math.max(8, Math.min((rx.value.x ?? rx.value.anchor.left) - pr.left - (rx.value.x != null ? 24 : 0), pr.width - w - 8))
  rx.value = { ...rx.value, top, left, ready: true }
}
const rxMine = computed(() => (rx.value ? rxOf(rx.value.m).filter((c) => c.mine).map((c) => c.key) : []))
const react = (m, key) => { rx.value = null; team.react(m, key).catch((e) => { err.value = e.message || '반응을 남기지 못했어요.' }) }
async function copyRx() {
  // (an AI answer shared from a chat — lib/answerShare.js: what the bubble shows, the word sent with it and the answer's words)
  const m = rx.value?.m
  const parts = [m?.body ? team.trBody(m) || m.body : '', m?.answer?.text || ''].filter(Boolean)
  const text = parts.length ? hidePaths(parts.join('\n\n')) : ''
  rx.value = null
  if (!text) return
  try { await navigator.clipboard.writeText(text); team.say('복사했어요') } catch { err.value = '복사하지 못했어요.' }
}
// (the long press · right-click — components/holdMenu.js — is on the bubbles that take a reaction only: RoomMessage.vue)
const rxButton = (m, e) => openRx(m, e.currentTarget?.closest('.msg')?.querySelector('.bub'))

// What a message does wherever it shows (RoomMessage.vue): the same in the open conversation and in 나에게 온 것
provide('roomMessage', reactive({
  busy, notes, conflictOf, rxId: computed(() => rx.value?.m.id || null),
  openFile, noteOf, mediaOf, shareSrc, viewShare, relink, played, grown, dragShare, openBranch, cont, openRx, rxButton, react,
}))

// Esc puts the floating sheet away; a docked column stays until its ✕ (Esc there is the page's — an open document's, a dialog's)
const onEsc = (e) => { if (e.key === 'Escape' && !docked.value && !drag.value) team.open = false }
onMounted(() => { window.addEventListener('keydown', onEsc); document.addEventListener('visibilitychange', onVisible); team.loadThreads(); team.loadForMe() })
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEsc); document.removeEventListener('visibilitychange', onVisible)
  for (const o of seenObs) o.disconnect(); for (const t of seenTimers.values()) clearTimeout(t); clearTimeout(flushT)
})
</script>

<template>
  <!-- floating: the sheet over a veil (as always) · docked: a column beside the page, no veil (useMessengerDock.js) -->
  <div :class="docked ? ['msdock', `d-${lay.dock}`, { inpanel: lay.inPanel, resizing, dragging: !!drag }] : ['veil', { dragging: !!drag }]" :style="box"
    data-own-drop data-test="messenger" :data-dock="lay.dock" @click.self="!docked && close()"
    @dragenter.stop="dragEnter" @dragover.stop="dragOver" @dragleave.stop="dragLeave" @drop.stop="dropped">
    <section ref="sheet" class="ms" :class="{ glass: !lay.inPanel, inthread: !!team.active, single, docked }" :role="docked ? 'complementary' : 'dialog'" aria-label="팀 메시지">
      <!-- a docked column's inner edge: drag (or ←/→) to make it wider or narrower -->
      <div v-if="docked" class="rsz" role="separator" aria-orientation="vertical" aria-label="메시지 너비" :aria-valuenow="lay.width" tabindex="0"
        data-test="msg-resize" @pointerdown="resizeStart" @keydown="resizeKey" />
      <aside class="side">
        <header class="hd" :class="{ grab: dockable }" data-test="msg-head" @pointerdown="dragStart">
          <b>메시지</b>
          <button class="tb press" title="새 대화" @click="newThread"><Icon name="plus" :size="16" /> 새 대화</button>
          <DockMenu v-if="dockable" :dock="lay.dock" @pick="team.setDock" />
          <button class="x press" aria-label="닫기" data-test="msg-close" @click="close"><Icon name="close" :size="16" /></button>
        </header>
        <!-- one list of conversations, and what to show of it -->
        <nav class="filt" role="tablist" aria-label="대화 거르기" data-test="msg-chips">
          <button v-for="c in CHIPS" :key="c.id" class="press" role="tab" :aria-selected="team.filter === c.id" :class="{ on: team.filter === c.id }"
            :data-test="`msg-chip-${c.id}`" @click="team.filter = c.id">{{ c.label }}<i v-if="c.id === 'unread' && team.unread.total" class="badge" data-test="msg-unread-count">{{ team.unread.total > 99 ? '99+' : team.unread.total }}</i><i
              v-else-if="c.id === 'forme' && forMeUnread" class="ndot" data-test="msg-forme-dot" aria-label="새로 온 것이 있어요" /></button>
        </nav>

        <PeoplePicker v-if="picking" class="pick" :people="people" title="대화할 팀원 (여럿 고르면 그룹 대화)" confirm="대화 시작" empty="대화할 팀원이 없어요."
          :busy="busy === 'start'" @confirm="start" @cancel="picking = false" />

        <!-- 메일: my mail cards (another source than the rooms) — the same mail sheet as from Home -->
        <div v-else-if="team.filter === 'mail'" class="items scroll" data-test="msg-mail-list">
          <button v-for="a in mails || []" :key="a.id" class="mailcard press" data-test="msg-mail-card" @click="app.mailCardFrom = 'inbox'; app.mailCard = a">
            <span class="mh"><span class="vb">{{ verbLabel(a) }}</span><b>{{ fromName(a.source?.from) }}</b><small>{{ when(a.created_at) }}</small></span>
            <span class="subj">{{ a.source?.subject }}</span>
            <span class="txt">{{ a.text }}</span>
            <span class="st" :class="{ sent: a.source?.sent }">{{ mailState(a) }}</span>
          </button>
          <p v-if="mails && !mails.length" class="empty">메일에서 만든 카드가 아직 없어요.</p>
        </div>

        <!-- 나에게 온 것: the rooms' own messages for me, drawn as their rooms draw them; 「어느 방 · 누가」 opens the room at it -->
        <div v-else-if="team.filter === 'forme'" ref="formeEl" class="items scroll flist" data-test="forme-list" @scroll.passive="rx = null">
          <div v-for="m in team.forMe" :key="m.id" class="fitem" :class="{ unread: m.unread }" data-test="forme-item" :data-forme="m.id" :data-room="m.threadId"
            :data-unread="m.unread ? 'true' : 'false'">
            <button class="where press" data-test="forme-open" title="이 대화에서 보기" @click="openItem(m)">
              <Icon name="chat" :size="13" /><span class="wn"><b>{{ whereOf(m) }}</b><template v-if="whoOf(m)"> · {{ whoOf(m) }}</template></span><i v-if="m.unread" class="ndot" /><span class="go" aria-hidden="true">›</span>
            </button>
            <RoomMessage :m="m" :room="roomOf(m)" forme />
          </div>
          <p v-if="!team.forMe.length" class="empty">아직 나에게 온 공유나 멘션이 없어요.</p>
        </div>

        <!-- 전체 · 안 읽음: the rooms -->
        <div v-else class="items scroll" data-test="msg-room-list">
          <button v-for="t in shownThreads" :key="t.id" class="th press" :class="{ on: t.id === team.active }" @click="team.openThread(t.id)">
            <PersonAvatar v-if="t.kind === 'group'" kind="group">{{ t.members.length }}</PersonAvatar><PersonAvatar v-else :id="otherOf(t)?.id" :name="otherOf(t)?.name || t.title" />
            <span class="nm"><b>{{ titleOf(t) }}</b>
              <small>{{ t.last ? `${t.last.mine && !['invite', 'rename'].includes(t.last.kind) ? '나: ' : ''}${t.last.kind === 'share' ? `산출물 ${t.last.files}개 공유${t.last.body ? ' · ' + t.last.body : ''}` : t.last.body}` : '새 대화' }}</small></span>
            <i v-if="team.unread.byThread[t.id]" class="badge">{{ team.unread.byThread[t.id] }}</i>
          </button>
          <p v-if="!shownThreads.length" class="empty">{{ team.filter === 'unread' ? '안 읽은 대화가 없어요.' : '팀원과 나눈 대화가 여기에 모여요.' }}</p>
        </div>
      </aside>

      <main class="pane">
        <template v-if="thread">
          <header class="thd" :class="{ grab: dockable }" data-test="msg-thread-head" @pointerdown="dragStart">
            <button class="back press" aria-label="목록" @click="team.active = null"><Icon name="back" :size="18" /></button>
            <b>{{ titleOf(thread) }}</b><small data-test="msg-thread-members">{{ thread.members.map(memberLabel).join(', ') }}</small>
            <button class="aitog press" :class="{ on: team.assistOn[thread.id] }" :title="team.assistOn[thread.id] ? '대화 중 에이전트가 도울 일을 찾으면 제안해요 (끄기)' : 'AI 제안이 꺼져 있어요 (켜기)'" @click="team.toggleAssist(thread.id)">AI 제안 {{ team.assistOn[thread.id] ? '켬' : '끔' }}</button>
            <button class="aitog meet press" :class="{ on: !!roomMeeting }" data-test="meeting-start" :disabled="mt.m?.roomId === thread.id" @click="mt.openLobby(thread.id, thread.title)">{{ roomMeeting ? `회의 참여 · ${roomMeeting.count}명` : '회의 시작' }}</button>
            <!-- a group: invite teammates in · a 1:1: a new group with the two of us and the ones picked (the 1:1 stays private) -->
            <button class="aitog grp press" :class="{ on: inviting }" :data-test="isGroup ? 'room-invite' : 'room-make-group'"
              :title="isGroup ? '이 대화방에 팀원 초대' : '이 두 사람과 다른 팀원으로 새 단체방 만들기'" :aria-label="isGroup ? '초대' : '단체방 만들기'" @click="inviting ? (inviting = false) : openInvite()">
              <Icon name="plus" :size="13" /><span class="lbl">{{ isGroup ? '초대' : '단체방 만들기' }}</span></button>
            <!-- 대화방 설정: the room's name (a group room) -->
            <button class="aitog gear press" :class="{ on: settings }" data-test="room-settings-open" title="대화방 설정" aria-label="대화방 설정" @click="openSettings">
              <Icon name="gear" :size="15" /></button>
            <!-- one column with the list hidden: its place and ✕ come along -->
            <template v-if="single && docked">
              <DockMenu :dock="lay.dock" @pick="team.setDock" />
              <button class="x press" aria-label="닫기" @click="close"><Icon name="close" :size="16" /></button>
            </template>
          </header>
          <!-- 「초대」 · 「단체방 만들기」: the people picker over the conversation -->
          <div v-if="inviting" class="invite" data-test="room-invite-sheet">
            <PeoplePicker :people="people" :exclude="thread.members.map((m) => m.id)" :busy="busy === 'invite'"
              :title="isGroup ? '초대할 팀원 (여럿 고를 수 있어요)' : '단체방에 함께할 팀원 (이 대화의 두 사람에 더해요)'" :confirm="isGroup ? '초대하기' : '단체방 만들기'"
              :empty="isGroup ? '초대할 수 있는 팀원이 없어요.' : '대화할 팀원이 없어요.'" @confirm="doInvite" @cancel="inviting = false" />
          </div>
          <!-- 대화방 설정 over the conversation, like the invite sheet -->
          <div v-if="settings" class="invite" data-test="room-settings-sheet">
            <RoomSettings :group="isGroup" :name="ownName" :auto="autoName" :busy="busy === 'rename'" @save="saveName" @cancel="settings = false" />
          </div>
          <div ref="scroller" class="msgs scroll" @scroll.passive="rx = null">
            <RoomMessage v-for="m in list" :key="m.id" :m="m" :room="thread" :suggestions="sugOf(m.id)" />
            <!-- 「@AI …」 being answered (lib/team/aiHelp.js) -->
            <div v-if="aiWait" class="aiwait" data-test="ai-status" role="status"><span class="spark">✦</span><span class="shimmer-text">{{ aiWait.text }}</span></div>
          </div>
          <Transition name="fade"><div v-if="dragging" class="mdrop" data-test="msg-dropzone"><div><Icon name="clip" :size="30" /><p>{{ dropWords }}</p></div></div></Transition>
          <footer class="cmp">
            <div v-if="attach.length || ups.length || refs.length" class="chips">
              <!-- a shared folder's file: a link (링크); an artifact of mine: shared as a copy for each (공유) -->
              <template v-for="r in refs" :key="r.key">
                <!-- a mail of mine: a mention — 「본문도 공유」 (on unless turned off) lets this room read its body -->
                <span v-if="r.mail" class="chip ref mailchip" data-test="msg-ref-chip" data-kind="mail" :data-file="r.name" data-state="ready" :title="`${r.from} · ${r.name}`">
                  <span class="fx env"><Icon name="mail" :size="12" /></span><span class="cn">{{ r.name }}</span><small>{{ r.from }}</small>
                  <label class="sharebody" data-test="msg-mail-body" :title="r.body ? '이 대화방 사람들이 메일 본문을 볼 수 있어요' : '다른 사람에게는 보낸 사람 · 제목 · 날짜 · 첨부 이름만 보여요'">
                    <input v-model="r.body" type="checkbox" /> 본문도 공유</label>
                  <em class="as env">메일</em>
                  <button aria-label="빼기" @click="dropRef(r)">×</button>
                </span>
                <!-- an attachment of my mail: its name for the room — 「파일도 공유」 (off) lets this room open the file -->
                <span v-else-if="r.att" class="chip ref mailchip" data-test="msg-ref-chip" data-kind="mailatt" :data-file="r.name" data-state="ready" :title="`메일 첨부 · ${r.att.subject || ''}`">
                  <span class="fx" :class="kindOf(r.name)">{{ kindLabel[kindOf(r.name)] || 'FILE' }}</span><span class="cn">{{ r.name }}</span><small>{{ r.att.subject }}</small>
                  <label class="sharebody" data-test="msg-att-share" :title="r.share ? '이 대화방 사람들이 이 파일을 열 수 있어요' : '다른 사람에게는 파일 이름과 메일 요약만 보여요'">
                    <input v-model="r.share" type="checkbox" /> 파일도 공유</label>
                  <em class="as env">메일 첨부</em>
                  <button aria-label="빼기" @click="dropRef(r)">×</button>
                </span>
                <span v-else class="chip ref" :class="{ error: !!r.error, wait: r.wait }" data-test="msg-ref-chip" :data-file="r.name" :data-state="r.error ? 'error' : r.wait ? 'wait' : 'ready'" :title="r.error || (r.ref ? `${r.folder} › ${r.ref.path}` : '')">
                  <span class="fx" :class="kindOf(r.name)">{{ kindLabel[kindOf(r.name)] || 'FILE' }}</span><span class="cn">{{ r.name }}</span>
                  <small>{{ r.error || (r.wait ? '확인하는 중…' : r.variation ? `${r.folder} · 반영 전 변형` : r.folder) }}</small>
                  <em v-if="!r.error" class="as">링크</em>
                  <button aria-label="빼기" @click="dropRef(r)">×</button>
                </span>
              </template>
              <span v-for="m in attach" :key="m.id" class="chip" data-test="msg-share-chip" :data-file="m.content.name">{{ m.content.name }}<em class="as share">공유</em><button @click="toggleAttach(m)">×</button></span>
              <span v-for="u in ups" :key="u.id" class="chip up" :class="u.state" data-test="msg-upload-chip" :data-state="u.state" :data-file="u.name">
                <span class="cn">{{ u.name }}</span><small>{{ u.state === 'uploading' ? `${Math.round(u.progress * 100)}%` : u.state === 'error' ? u.error : kb(u.size) }}</small>
                <i v-if="u.state === 'uploading'" class="bar" :style="{ width: `${Math.round(u.progress * 100)}%` }" />
                <button aria-label="빼기" @click="dropUp(u)">×</button>
              </span>
            </div>
            <input ref="filePick" type="file" multiple hidden data-test="msg-file-input" @change="picked" />
            <div v-if="attachOpen" class="amenu glass">
              <button class="row press mine" data-test="msg-from-computer" @click="filePick.click()"><Icon name="clip" :size="16" /><span class="nm"><b>내 컴퓨터에서</b><small>끌어다 놓거나 붙여 넣어도 돼요</small></span></button>
              <p class="cap">내 산출물에서 첨부</p>
              <button v-for="m in myFiles" :key="m.id" class="row press" :class="{ on: attach.some((x) => x.id === m.id) }" @click="toggleAttach(m)">
                <span class="fic" :class="kindOf(m.content.name)">{{ kindLabel[kindOf(m.content.name)] || 'FILE' }}</span><span class="nm"><b>{{ m.content.name }}</b></span>
              </button>
              <p v-if="!myFiles.length" class="empty">첨부할 산출물이 없어요.</p>
            </div>
            <!-- "@": 「AI」 and this conversation's people, near the caret -->
            <Transition name="fade">
              <div v-if="at.open && atItems.length" class="atlist glass" role="listbox" data-test="msg-at-list" :style="{ left: `${12 + at.x}px` }" @mousedown.prevent>
                <button v-for="(it, k) in atItems" :key="it.key" class="row press" role="option" :class="{ on: k === at.active, ai: it.type === 'ai' }" :data-test="it.type === 'ai' ? 'msg-at-ai' : 'msg-at-person'"
                  @click="atPick(it)" @mouseenter="at.active = k">
                  <PersonAvatar :kind="it.type === 'ai' ? 'ai' : 'person'" :id="it.id" :name="it.name" :size="30" />
                  <span class="nm"><b>{{ it.label || it.name }}</b><small>{{ it.sub }}</small></span>
                </button>
              </div>
            </Transition>
            <div class="box">
              <button class="ic press" title="파일 첨부" aria-label="산출물 첨부" data-test="msg-clip" @click="attachOpen = !attachOpen"><Icon name="clip" :size="18" /></button>
              <span v-if="aiOn" class="aichip" data-test="msg-ai-chip" title="AI 에게 보내요 — 대화방에서 AI 가 답해요">✦ AI<button aria-label="AI 빼기" @click="aiOn = false">×</button></span>
              <textarea ref="taEl" v-model="draft" rows="1" :placeholder="aiOn ? 'AI 에게 부탁하기 — 예: 이력서 첨부해 · 견적서 찾아서 올려 줘' : '메시지 보내기 · @ 로 AI 부르기'" @keydown="onKey" @focus="attachOpen = false" @paste="onPaste"
                @click="atUpdate" @blur="atBlur" />
              <button class="send press" aria-label="보내기" data-test="msg-send" :disabled="busy === 'send' || (!draft.trim() && !attach.length && !ups.length && !refs.length && !aiOn)" @click="send"><Icon name="up" :size="18" /></button>
            </div>
          </footer>
        </template>
        <div v-else class="blank">
          <Icon name="team" :size="36" />
          <p>{{ team.filter === 'forme' ? '항목 위의 대화 이름을 누르면 해당 대화에서 메시지를 볼 수 있어요.' : '대화를 고르거나 새 대화를 시작해 주세요.' }}</p>
        </div>
      </main>
      <!-- the reactions bar over the bubble it was opened on — the open conversation's or 나에게 온 것's (its place measured once it is drawn) -->
      <ReactionBar v-if="rx" ref="rxBar" :mine="rxMine" :off="team.rxOff || !team.rxKnown" :text="[rx.m.body, rx.m.answer?.text].filter(Boolean).join('\n\n')" :data-for="rx.m.id"
        :style="{ top: `${rx.top}px`, left: `${rx.left}px`, visibility: rx.ready ? 'visible' : 'hidden' }" @pick="(k) => react(rx.m, k)" @copy="copyRx" @close="rx = null" />
      <!-- (in the section, not the conversation pane: seen over the lists and on a phone too) -->
      <p v-if="err" class="err" role="alert">{{ err }}</p>
    </section>
    <!-- while the header is dragged: where it can go (src/messengerDock.js zones); anywhere else floats it -->
    <div v-if="drag" class="dzs" data-test="dock-zones" aria-hidden="true">
      <div v-for="z in dropZones" :key="z.id" class="dz" :class="{ on: drag.zone === z.id }" :data-zone="z.id" :style="{ left: `${z.x}px`, top: `${z.y}px`, width: `${z.w}px`, height: `${z.h}px` }">
        <span>{{ zoneWord[z.id] }}</span>
      </div>
      <div class="dghost glass" :style="{ left: `${drag.x}px`, top: `${drag.y}px` }"><Icon name="team" :size="16" /> 메시지 · {{ zoneWord[drag.zone] || zoneWord.float }}</div>
    </div>
  </div>
</template>

<style scoped>
/* the list's chips: 전체 · 나에게 온 것 · 안 읽음 · 메일 — the count once, on 안 읽음 */
.filt { display: flex; gap: 6px; padding: 4px 12px 10px; overflow-x: auto; scrollbar-width: none; }
.filt::-webkit-scrollbar { display: none; }
.filt button { flex: none; display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); background: var(--field-bg, rgba(127, 127, 127, .1)); white-space: nowrap; }
.filt button.on { color: var(--text-primary-on, #fff); background: var(--ink, #1d1d1f); font-weight: 500; }
.ndot { display: inline-block; flex: none; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: #e5484d; }
/* 나에게 온 것: each item is its room's own bubble, with where it is over it */
.flist { display: flex; flex-direction: column; gap: 14px; padding-top: 2px; }
.fitem { display: flex; flex-direction: column; gap: 6px; padding: 8px 8px 10px; border-radius: 16px; transition: background .4s; }
.fitem.unread { background: rgba(42, 120, 214, .08); box-shadow: inset 3px 0 0 #2a78d6; }
.where { align-self: flex-start; max-width: 100%; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12.5px;
  color: var(--text-secondary); background: rgba(127, 127, 127, .1); }
.where .wn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.where b { color: var(--text-primary); font-weight: 600; }
.where .ndot { margin-left: 2px; }
.where .go { font-size: 15px; line-height: 1; margin-left: 1px; }
.mailcard { display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left; border-radius: 16px; padding: 12px 14px; margin-bottom: 8px; background: var(--field-bg); color: var(--text-primary); overflow-wrap: anywhere; }
.mailcard .mh { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; }
.mailcard .mh small { margin-left: auto; color: var(--text-tertiary); font-size: 12px; flex: none; }
.mailcard .vb { flex: none; font-size: 12px; padding: 1px 7px; border-radius: 6px; background: var(--chip-bg); }
.mailcard .subj { font-size: 13.5px; font-weight: 500; }
.mailcard .txt { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.mailcard .st { align-self: flex-start; font-size: 11.5px; color: var(--text-tertiary); }
.mailcard .st.sent { color: #2a78d6; }
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .16); display: flex; justify-content: flex-end; padding: 76px 16px 16px; }
.ms { position: relative; width: min(860px, 100%); display: flex; border-radius: 24px; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .22); color: var(--text-primary); animation: pop-in .3s var(--spring); }
.side { width: 330px; flex: none; display: flex; flex-direction: column; border-right: 1px solid rgba(127, 127, 127, .18); min-height: 0; }
.hd { display: flex; align-items: center; gap: 6px; padding: 14px 12px 6px 18px; }
.hd b { flex: 1; font-size: 18px; font-weight: 600; }
.tb { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 10px; border-radius: 15px; font-size: 13px; background: rgba(127, 127, 127, .12); color: var(--text-primary); }
.x { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; color: var(--text-secondary); }
.badge { font-style: normal; display: inline-block; min-width: 18px; height: 18px; line-height: 18px; padding: 0 5px; margin-left: 6px; border-radius: 9px; background: #e5484d; color: #fff; font-size: 11px; text-align: center; }
.items { flex: 1; overflow: auto; padding: 0 10px 12px; }
.empty { font-size: 13px; color: var(--text-secondary); text-align: center; margin: 24px 8px; }
.fic { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-size: 9.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.xls { background: #217346; } .fic.ppt { background: #c43e1c; } .fic.pdf { background: #d93025; } .fic.cad { background: #0b6f88; } .fic.vec { background: #c2570c; } .fic.img { background: #7b3fbf; } .fic.snd { background: #0f8a5f; } .fic.vid { background: #b0223c; }
.th { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 14px; text-align: left; color: var(--text-primary); }
.th.on { background: rgba(127, 127, 127, .14); }
.nm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm b { font-size: 14.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm small { font-size: 12.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick { flex: 1; min-height: 0; padding: 0 10px 12px; }
/* 「초대」 · 「단체방 만들기」: over the conversation, under its header */
.invite { position: absolute; z-index: 6; left: 10px; right: 10px; top: 58px; max-height: min(460px, calc(100% - 140px)); display: flex; flex-direction: column;
  padding: 10px; border-radius: 18px; box-shadow: 0 14px 44px rgba(0, 0, 0, .22); color: var(--text-primary);
  /* (opaque: the conversation under it does not show through) */
  background: linear-gradient(var(--regular-solid-bg), var(--regular-solid-bg)), var(--surface-secondary);
  border: 1px solid rgba(127, 127, 127, .18); }
.invite > .pp { min-height: 0; }
.aitog.grp { margin-left: 6px; display: inline-flex; align-items: center; gap: 3px; }
.aitog.grp.on { color: #2a78d6; background: rgba(42, 120, 214, .14); }
/* 대화방 설정: the gear by 「초대」 */
.aitog.gear { margin-left: 6px; width: 26px; padding: 0; display: grid; place-items: center; }
.aitog.gear.on { color: #2a78d6; background: rgba(42, 120, 214, .14); }
.cap { margin: 6px 6px 6px; font-size: 12px; color: var(--text-secondary); }
.row { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 12px; text-align: left; color: var(--text-primary); }
.row.on { background: rgba(42, 120, 214, .14); }
.pane { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.thd { display: flex; align-items: baseline; gap: 8px; padding: 18px 18px 10px; border-bottom: 1px solid rgba(127, 127, 127, .14); }
.thd b { font-size: 16px; font-weight: 600; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thd small { flex: 1 1 0; min-width: 0; font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.back { display: none; }
/* the headers are what the messenger is dragged by (useMessengerDock.js) */
.hd.grab, .thd.grab { cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }
.dragging .hd.grab, .dragging .thd.grab { cursor: grabbing; }
.msgs { flex: 1; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.aitog { margin-left: auto; flex: none; align-self: center; height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12px; color: var(--text-secondary); background: rgba(127, 127, 127, .12); }
.aitog.on { color: #7a5af5; background: rgba(122, 90, 245, .14); }
.aitog.meet { margin-left: 6px; color: #fff; background: #7a5af5; font-weight: 500; }
.aitog.meet.on { background: #e5484d; color: #fff; }
.aitog.meet:disabled { opacity: .5; }
.cmp { position: relative; padding: 10px 12px 12px; border-top: 1px solid rgba(127, 127, 127, .14); }
.box { display: flex; align-items: flex-end; gap: 6px; border-radius: 22px; background: rgba(127, 127, 127, .1); padding: 4px; }
.box textarea { flex: 1; resize: none; border: 0; outline: 0; background: transparent; padding: 9px 6px; font-size: 14.5px; line-height: 19px; color: var(--text-primary); font-family: inherit; max-height: 120px; }
.ic { width: 36px; height: 36px; border-radius: 18px; display: grid; place-items: center; color: var(--text-secondary); }
.send { width: 36px; height: 36px; border-radius: 18px; display: grid; place-items: center; background: #1d1d1f; color: #fff; }
.send:disabled { opacity: .35; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.chip { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 4px 0 10px; border-radius: 13px; font-size: 12.5px; background: rgba(42, 120, 214, .14); }
.chip button { width: 20px; height: 20px; border-radius: 10px; color: var(--text-secondary); }
.chip.up { position: relative; overflow: hidden; max-width: 100%; }
.chip.up .cn { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.up small { color: var(--text-secondary); font-size: 11.5px; }
.chip.up.error { background: rgba(198, 40, 40, .12); } .chip.up.error small { color: #c62828; }
.chip.up .bar { position: absolute; left: 0; bottom: 0; height: 2px; background: #2a78d6; transition: width .2s; }
.chip.ref, .chip[data-test="msg-share-chip"] { max-width: 100%; }
.chip.ref { gap: 6px; padding-left: 3px; height: 30px; border-radius: 15px; background: rgba(42, 120, 214, .1); border: 1px solid rgba(42, 120, 214, .35); }
.chip.ref .cn { max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.chip.ref small { color: var(--text-secondary); font-size: 11.5px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.ref.wait { opacity: .7; }
.chip.ref.error { background: rgba(198, 40, 40, .1); border-color: rgba(198, 40, 40, .4); } .chip.ref.error small { color: #c62828; max-width: 220px; }
.chip .fx { flex: none; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; font-size: 8.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.chip .fx.hwp { background: #1f6fd1; } .chip .fx.doc { background: #2b579a; } .chip .fx.xls { background: #217346; } .chip .fx.ppt { background: #c43e1c; } .chip .fx.pdf { background: #d93025; } .chip .fx.md { background: #3d4451; }
.chip .as { flex: none; font-style: normal; font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 7px; color: #2a78d6; background: rgba(42, 120, 214, .14); margin-left: 2px; }
.chip .as.share { color: #0f8a5f; background: rgba(15, 138, 95, .14); }
.chip.ref.mailchip { background: rgba(122, 90, 245, .1); border-color: rgba(122, 90, 245, .38); }
/* one line: the subject gives way first, the sender next; the switch, the tag and × keep their size */
.chip.ref.mailchip .cn { flex: 0 1 auto; min-width: 0; max-width: 150px; }
.chip.ref.mailchip small { flex: 0 2 auto; min-width: 0; max-width: 80px; }
.chip.ref.mailchip .fx, .chip.ref.mailchip .sharebody, .chip.ref.mailchip .as, .chip.ref.mailchip button { flex: none; }
.chip .fx.env { background: #7a5af5; }
.chip .as.env { color: #7a5af5; background: rgba(122, 90, 245, .14); }
.chip .sharebody { display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; color: var(--text-secondary); white-space: nowrap; cursor: pointer; }
.chip .sharebody input { margin: 0; width: 13px; height: 13px; accent-color: #7a5af5; }
.aichip { flex: none; align-self: center; display: inline-flex; align-items: center; gap: 2px; height: 28px; padding: 0 2px 0 10px; border-radius: 14px; font-size: 13px; font-weight: 600; color: #fff;
  background: linear-gradient(135deg, #7a5af5, #2a78d6); animation: pop-in .3s var(--spring); }
.aichip button { width: 22px; height: 22px; border-radius: 11px; color: rgba(255, 255, 255, .85); }
.atlist { position: absolute; bottom: calc(100% - 4px); z-index: 8; width: min(280px, calc(100% - 24px)); max-height: 260px; overflow: auto; border-radius: 16px; padding: 6px; box-shadow: 0 12px 40px rgba(0, 0, 0, .2); }
.atlist .row.on { background: rgba(127, 127, 127, .14); }
.atlist .nm small { white-space: normal; }
.aiwait { align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 16px; font-size: 13.5px; color: var(--text-secondary);
  background: rgba(122, 90, 245, .1); border: 1px solid rgba(122, 90, 245, .3); }
.aiwait .spark { color: #7a5af5; font-size: 15px; animation: spin 2.4s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
.amenu .row.mine { border-bottom: 1px solid rgba(127, 127, 127, .16); border-radius: 12px 12px 4px 4px; margin-bottom: 4px; }
.amenu .row.mine small { font-size: 12px; color: var(--text-secondary); }
.mdrop { position: absolute; inset: 8px; z-index: 5; display: grid; place-items: center; border-radius: 18px; background: rgba(42, 120, 214, .12); border: 2.5px dashed rgba(42, 120, 214, .7); pointer-events: none; }
.mdrop div { text-align: center; color: #1a56c4; font-size: 16px; font-weight: 600; background: rgba(255, 255, 255, .92); padding: 18px 28px; border-radius: 18px; }
.mdrop p { margin: 6px 0 0; }
.amenu { position: absolute; left: 12px; bottom: calc(100% + 4px); width: 300px; max-height: 300px; overflow: auto; border-radius: 16px; padding: 6px; box-shadow: 0 12px 40px rgba(0, 0, 0, .2); }
.blank { flex: 1; display: grid; place-content: center; justify-items: center; gap: 10px; color: var(--text-tertiary); text-align: center; padding: 30px; font-size: 14px; }
.err { position: absolute; z-index: 7; left: 16px; right: 16px; bottom: 70px; margin: 0; padding: 8px 12px; border-radius: 10px; background: rgba(198, 40, 40, .12); color: #c62828; font-size: 13px; }
@media (max-width: 760px) {
  .veil { padding: 70px 8px 8px; }
}
/* one column (a phone, or a narrow docked column): the list, or one conversation with ‹ */
.ms.single .side { width: 100%; border-right: 0; }
.ms.single .pane { display: none; }
.ms.single.inthread .side { display: none; }
.ms.single.inthread .pane { display: flex; }
.ms.single .back { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 15px; align-self: center; flex: none; }
.ms.single .blank { display: none; }
.ms.single .thd { align-items: center; padding: 12px 10px 10px 12px; gap: 6px; }
.ms.single .thd b { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms.single .thd small { flex: 1 1 0; min-width: 0; }
/* (a phone's header: the invite button is its + alone) */
.ms.single .aitog.grp .lbl { display: none; }
.ms.single .aitog.grp { width: 26px; padding: 0; justify-content: center; }

/* ---- docked: a column beside the page (no veil; src/messengerDock.js) ---- */
.msdock { position: fixed; z-index: 45; display: flex; transition: top .35s var(--spring), right .35s var(--spring), left .35s var(--spring), width .35s var(--spring), bottom .35s var(--spring); }
.msdock.resizing { transition: none; }
.msdock .ms { width: 100%; height: 100%; border-radius: 22px; box-shadow: 0 10px 40px rgba(0, 0, 0, .16); }
.msdock .ms.docked:not(.single) .side { width: 260px; }
/* in the document panel: the right part of the document's card (OfficeSheet leaves it free) — one card, a line between */
.msdock.inpanel .ms { border-radius: 0 22px 22px 0; box-shadow: none; background: transparent; border-left: 1px solid var(--hairline); }
.dragging .ms { opacity: .55; transition: opacity .15s; }
/* the inner edge: drag (or ←/→ when focused) to resize */
.rsz { position: absolute; z-index: 6; top: 0; bottom: 0; width: 12px; cursor: col-resize; touch-action: none; outline: none; }
.d-right .rsz, .d-panel .rsz { left: 0; }
.d-left .rsz { right: 0; }
.rsz::after { content: ''; position: absolute; top: 50%; left: 4px; width: 4px; height: 44px; translate: 0 -50%; border-radius: 2px; background: var(--text-tertiary); opacity: 0; transition: opacity .15s; }
.rsz:hover::after, .rsz:focus-visible::after, .resizing .rsz::after { opacity: 1; }
.rsz:focus-visible::after { background: #2a78d6; }
/* the drop zones while the header is dragged */
.dzs { position: fixed; inset: 0; z-index: 70; cursor: grabbing; }
.dz { position: absolute; display: grid; place-items: center; border-radius: 20px; border: 2px dashed rgba(42, 120, 214, .55); background: rgba(42, 120, 214, .06); transition: background .15s, border-color .15s; }
.dz span { padding: 7px 14px; border-radius: 12px; font-size: 13.5px; font-weight: 600; color: #1a56c4; background: var(--regular-solid-bg); box-shadow: 0 4px 18px rgba(0, 0, 0, .12); }
.dz.on { background: rgba(42, 120, 214, .2); border-color: #2a78d6; border-style: solid; }
:root:not([data-theme="light"]) .dz span { color: #a1d0ff; }
.dghost { position: absolute; translate: 14px 14px; display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 14px; font-size: 13px; font-weight: 500; color: var(--text-primary); white-space: nowrap; pointer-events: none; box-shadow: 0 8px 26px rgba(0, 0, 0, .2); }
</style>

<style>
/* A docked messenger takes a column from the page (App.vue .page): the page — and what it opens over itself, the document panel
   and its sheets (layout containment: the box of its fixed children) — fits the rest of the window. The page measures its own
   width (cqw) instead of the window's. */
html[data-msgdock] .stage > .page { inset: 0 var(--msgdock-r, 0px) 0 var(--msgdock-l, 0px); contain: layout; container-type: inline-size;
  transition: left .35s var(--spring), right .35s var(--spring); }
html.msgdock-resizing .stage > .page { transition: none; }
</style>
