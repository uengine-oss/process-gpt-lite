<script setup>
// The IeumOffice editor in an iframe, ported from process-gpt-vue3 OfficeEditorFrame.vue (same
// message protocol, without Vuetify). Documents open in their own format (docx·xlsx·pptx·pdf·hwp…);
// saving inside the editor uploads an `edited-…` copy next to the original and reports its URL.
// in:  ready → saved{url,name} | agent{action,text} | save-failed{error} | error{error}
//      | assistant{label, prompt, selection} — the editor's AI 도우미 buttons (with `assistant`)
//      | selection{selection} — what is selected in the document as it changes (워드; null: nothing) → emit 'selection',
//        the chat composer's chip (src/docSelection.js). The editor's own 「AI 수정 요청」 stays hidden: the chat carries it.
// out: context{context} — the work around the document, which the editor's AI reads.
// One assistant (`assistant` prop): the editor's AI dock stays hidden and its AI buttons come here
// (emit 'assistant'); while the document is open the page tells the server (src/liveLink.js, app
// 'ieumoffice'), so a chat message is about this document and the agent edits it in front of the
// person through office-host's office_live_* tools (server/mcp/office.js).
// autoSave (a shared folder's file, opened by an editor of the folder): the editor writes its file only on
// 저장 / Ctrl+S, which a phone has no way to reach — the frame presses the editor's own 저장 after a
// pause in editing, when the page goes to the background, and on flush() (the sheet closing waits for it),
// so an edit never stays only in the open tab (src/officeAutosave.js). A read-only preview says so the
// moment someone types in it, also on a phone.
// 「내려받기」 (DownloadButton, spec file-download) before 공유: an editable document with edits not saved yet — typed, or written by the
// agent — is saved first (the editor's own 저장: a chat file's 저장 puts its edited copy beside the original) and that copy is what is
// saved; when saving does not work the person is offered the last saved version. `download`: false hides it (a host whose own header has
// one — FileView), a function gives where the newest version is ({last}) → {url, name} (a private card's signed address — OfficeSheet).
// `saveCheck` (OfficeSheet): after the editor's own upload, whether the save also landed where the card keeps it (the folder's commit, my
// private card) → {ok} | {ok: false, why}; when it did not, the download is not called 「방금 저장한 판」 — the last saved version is offered.
// A document the person saves (not autoSave — a chat's document): the bar says how its save went (src/officeSave.js saveBadge) — 「저장 안 됨」,
// 「저장하는 중…」, 「저장했어요 · 10:42」 or 「저장하지 못했어요 · 다시 시도」 (never 「저장 중…」 for good: SAVE_WAIT_MS). The frame sees the
// editor's own 저장 (its button, ⌘S) and the answer (saved, save-failed). 2026-11-27 production: the editor's connection to its host
// (/office/__ipc, one WebSocket) is closed by Cloudflare after ~100 s with nothing on it, and the editor's page then sends its save into
// the closed socket, unanswered — 「저장 중…」 for good. The frame keeps the connection busy (KEEPALIVE_MS: the page's 'context' message,
// which the page passes on to the host), and when it closes anyway (the page says 'closed') a save fails at once and the bar offers
// 다시 열기. `saveAs` (OfficeSheet, a chat's own card): the editor's 「다른 이름으로 저장」 asks the sheet, which names the copy; without
// it the editor's 「다른 이름으로 저장」 is hidden (the web host cancels every file dialog: it did nothing). ask(): the frame's own question
// over the document (askPerson — exposed as ask; the sheet's close asks 「저장하고 닫기 · 저장하지 않고 닫기 · 취소」 with it).
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import ShareButton from './team/ShareButton.vue'
import DownloadButton from './DownloadButton.vue'
import { isOfficeEditorMessage, officeEditorUrl } from '../officeEditor.js'
import { freshToken } from '../api.js'
import { BASE } from '../base.js'
import { kindOf, kindLabel } from '../artifacts.js'
import { openLiveLink } from '../liveLink.js'
import { watchEdits, pressSave, editorClean, saveAsHideCss, saveKindOf } from '../officeAutosave.js'
import { installSheetTouchPan } from '../officeTouchPan.js'
import { KEEPALIVE_MS, SAVE_WAIT_MS, saveBadge } from '../officeSave.js'

const props = defineProps({
  fileUrl: { type: String, default: '' },
  name: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
  context: { type: Object, default: null },
  maximized: { type: Boolean, default: false },
  assistant: { type: Boolean, default: false },
  autoSave: { type: Boolean, default: false },
  // a save said by the page that opened it instead (a mail's attachment: where its edited copy went — OfficeSheet), not 「편집본이 원본 옆에」
  quietSave: { type: Boolean, default: false },
  // 「내려받기」 in the bar: true, false (the host has its own), or ({last}) → {url, name} — where the newest version is
  download: { type: [Boolean, Function], default: true },
  // () → {ok, where?} | {ok: false, why}: the host's own step after a save (see above); where: where the save went, said with 「저장했어요」
  saveCheck: { type: Function, default: null },
  // () → void: the editor's 「다른 이름으로 저장」 (see above); null hides it
  saveAs: { type: Function, default: null },
})
const emit = defineEmits(['ready', 'saved', 'error', 'agent', 'update:maximized', 'close', 'live', 'linkfail', 'assistant', 'mention', 'edited', 'selection', 'gone'])

const root = ref(null)
const frame = ref(null)
const frameSrc = ref('')
const emptyText = ref('문서를 여는 중…')
const notice = ref(null)
const fullscreen = ref(false)
// until the editor draws itself the frame is a blank white page — on a phone's first open that is
// 6–10 s of running the editor's 5 MB bundle (measured 2026-11-24, 4G and a 4x slower CPU): say so.
// (The page's 'ready' comes as soon as its socket opens, long before that: the frame watches for the
// editor's own root to fill — every IeumOffice editor page renders into #root.)
const opening = ref(false)
const openingSlow = ref(false)
let openingTimer = null
let drawnTimer = null
function opened() { opening.value = false; openingSlow.value = false; clearTimeout(openingTimer); clearInterval(drawnTimer) }
function watchDrawn() {
  clearInterval(drawnTimer)
  drawnTimer = setInterval(() => {
    try { if (frame.value?.contentDocument?.getElementById('root')?.childElementCount > 0) opened() } catch { /* another origin: the timeout ends it */ }
  }, 250)
}
let ready = false
let timer = null
// live: the chat is joined to this document; busy: the agent's edits are landing
const live = ref(false)
const busy = ref(false)
// the live link gave up (src/liveLink.js onFail): why — the header and the overlay offer 다시 연결
const linkFail = ref('')
// the link dropped after it was joined (a server restart, the network): it joins again by itself — said, not a failure
const relinking = ref(false)
let link = null
let busyTimer = null
let alive = true
// the parent swapping fileUrl to the copy the editor just saved must not reload it (keeps undo)
const savedUrls = new Set()

// The ribbon starts folded so the document gets the room (the editor remembers each app's choice
// in localStorage on this origin; the 한글 editor folds its tool box with its own button).
const RIBBON_KEYS = { docs: 'aidocs.ribbonCollapsed', sheets: 'ai-sheets-ribbon-collapsed', slides: 'ai-slides-ribbon-collapsed', pdf: 'genoffice-pdf-ribbon-collapsed' }
const editor = () => (frameSrc.value.match(/\/office\/([a-z]+)\//) || [])[1]
const ribbonOpen = ref(false)
function hwpToggle() {
  const studio = frame.value?.contentDocument?.querySelector('iframe')?.contentDocument
  return studio?.getElementById('toolbox-basic-toggle') || null
}
function foldHwpWhenReady(tries = 40) {
  const t = hwpToggle()
  if (t) { if (t.classList.contains('active')) t.click(); ribbonOpen.value = false; return }
  if (tries > 0) setTimeout(() => foldHwpWhenReady(tries - 1), 250)
}
function toggleRibbon() {
  if (editor() === 'hwp') { hwpToggle()?.click(); ribbonOpen.value = !!hwpToggle()?.classList.contains('active'); return }
  // the editors toggle on their own shortcut (Ctrl+F1); the frame is same-origin, so send it in
  const w = frame.value?.contentWindow
  if (!w) return
  // dispatched on the document it bubbles to window too, wherever the editor listens
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'F1', code: 'F1', ctrlKey: true, bubbles: true }))
  ribbonOpen.value = !ribbonOpen.value
  syncSoon()
}
// the editor marks a folded ribbon .ribbon-collapsed (IeumOffice ribbon-collapse.tsx); pressing its
// selected tab folds it too, so the button follows what the editor shows
function syncRibbon() {
  if (editor() === 'hwp') return
  const r = frame.value?.contentDocument?.querySelector('.ribbon-collapsible')
  if (r) ribbonOpen.value = !r.classList.contains('ribbon-collapsed')
  if (deckTimer) readDeck()
}
const syncSoon = () => setTimeout(syncRibbon, 80)

// A phone (a narrow sheet or a touch screen). A folded ribbon takes the editor's tab row with it
// (파일·저장·홈·삽입… — on a portrait phone the tab names came out one letter per line), so the
// document gets that room; 리본 펴기 brings both back. A deck opens without its thumbnail rail (the
// editor re-fits the slide to the wider stage), with big previous/next buttons over its sides and
// 슬라이드 목록 to bring the rail back; on a short (landscape) screen the notes step aside.
// office-host and the IeumOffice editors stay as they are: this is one style sheet and two classes on
// the editor page's <html>, and the buttons press the editor's own thumbnails and notes button.
const COMPACT_CSS = [
  'html.pgpt-compact .ribbon-collapsible.ribbon-collapsed > .ribbon-tabs { display: none !important; }',
  // unfolded: tab names stay whole and the row wraps (no room kept for desktop window buttons)
  'html.pgpt-compact .ribbon-tabs { flex-wrap: wrap; padding-left: 10px !important; padding-right: 10px !important; }',
  'html.pgpt-compact .ribbon-tab { white-space: nowrap; }',
  // the status bar keeps "슬라이드 3/9" whole
  'html.pgpt-compact .status-bar .zoom-slider { width: 64px; }',
  'html.pgpt-no-thumbs .slide-list, html.pgpt-no-thumbs .thumb-resizer { display: none !important; }',
].join('\n')
// The text editor (a .txt · .json, CodeMirror) paints the line under the caret in an opaque colour above its selection, which it draws
// behind the text: a selection on that line — Shift+→, Shift+End — was there (typing replaced it) but could not be seen (2026-11-27 사용자
// 「shift 누른상태로 커서 이동하면 해당 캐럿에서 선택이 되어야 하는데 안되더군」). The line's colour is made see-through, in either theme.
// (IeumOffice apps/markdown/src/renderer/source/PlainTextEditor.tsx — '.cm-activeLine'; the office host carries the same rule)
const TEXT_SELECTION_CSS = '.cm-editor .cm-line.cm-activeLine { background-color: rgba(127, 127, 127, .08) !important; }'
const coarseMq = window.matchMedia?.('(pointer: coarse)')
const coarse = ref(!!coarseMq?.matches)
const onCoarse = (e) => (coarse.value = e.matches)
const box = ref({ w: 0, h: 0 })
let boxObserver = null
const compact = computed(() => coarse.value || (box.value.w > 0 && box.value.w <= 640))
const short = computed(() => compact.value && box.value.h > 0 && box.value.h < 520)
const deck = computed(() => editor() === 'slides')
const thumbsOpen = ref(false)
const slidePos = ref({ cur: 0, total: 0, mid: 0 })
// (with the rail open, the rail is the way through the deck)
const slideNav = computed(() => compact.value && deck.value && !thumbsOpen.value && slidePos.value.total > 1)
function dressEditor() {
  const doc = frame.value?.contentDocument
  if (!doc?.head || editor() === 'hwp') return
  if (!doc.getElementById('pgpt-compact')) {
    const st = doc.createElement('style')
    st.id = 'pgpt-compact'
    st.textContent = `${COMPACT_CSS}\n${TEXT_SELECTION_CSS}`
    doc.head.appendChild(st)
    for (const ev of ['click', 'dblclick', 'keydown']) doc.addEventListener(ev, syncSoon, true)
  }
  doc.documentElement.classList.toggle('pgpt-compact', compact.value)
  doc.documentElement.classList.toggle('pgpt-no-thumbs', compact.value && deck.value && !thumbsOpen.value)
  // a finger scrolls a spreadsheet (tap selects, double tap edits, hold-then-drag selects a range);
  // the editor's grid would read every drag as a selection (src/officeTouchPan.js)
  if (editor() === 'sheets') installSheetTouchPan(frame.value.contentWindow)
}
watch([compact, thumbsOpen], () => { dressEditor(); syncSoon() })
// where the deck is ("슬라이드 3/9" in its status bar) and the middle of its stage, for the buttons
let deckTimer = null
function readDeck() {
  const doc = frame.value?.contentDocument
  const m = /(\d+)\D+(\d+)/.exec(doc?.querySelector('.status-bar .status-left .status-item')?.textContent || '')
  const stage = doc?.querySelector('.stage-wrap')?.getBoundingClientRect()
  const next = m ? { cur: +m[1], total: +m[2], mid: stage ? Math.round((frame.value.offsetTop || 0) + stage.top + stage.height / 2) : 0 } : { cur: 0, total: 0, mid: 0 }
  const was = slidePos.value
  if (next.cur !== was.cur || next.total !== was.total || next.mid !== was.mid) slidePos.value = next
  fitNotes()
}
function goSlide(step) {
  const doc = frame.value?.contentDocument
  const w = frame.value?.contentWindow
  if (!doc || !w) return
  readDeck()
  const to = slidePos.value.cur + step
  if (to < 1 || to > slidePos.value.total) return
  // the editor's own thumbnail (hidden or not); without the rail, its page keys
  const thumb = doc.querySelector(`.slide-list .thumb[data-index="${to - 1}"]`)
  if (thumb) thumb.click()
  else {
    doc.activeElement?.blur?.()
    doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: step > 0 ? 'PageDown' : 'PageUp', bubbles: true }))
  }
  setTimeout(readDeck, 60)
}
// notes off while the screen is short, back on when it is tall again (only if we turned them off)
let notesFor = null
let notesHidden = false
function fitNotes() {
  if (!deck.value || notesFor === short.value) return
  const btn = frame.value?.contentDocument?.querySelector('.status-notes-btn')
  if (!btn) return
  const on = btn.classList.contains('on')
  if (short.value) { if (on) { btn.click(); notesHidden = true } }
  else if (notesHidden) { if (!on) btn.click(); notesHidden = false }
  notesFor = short.value
}
watch(short, fitNotes)
function stopDeck() { clearInterval(deckTimer); deckTimer = null; slidePos.value = { cur: 0, total: 0, mid: 0 }; notesFor = null; notesHidden = false }

function startLive() {
  if (link || props.readOnly || !props.assistant) return
  link = openLiveLink({ app: 'ieumoffice', file: props.name, editor: editor(), alive: () => alive && !!frameSrc.value,
    onState: (on) => { live.value = on; if (on) { setFail(''); relinking.value = false } emit('live', on) }, onFail: setFail,
    onRetrying: (on) => { relinking.value = on } })
}
function setFail(why) { linkFail.value = why; emit('linkfail', why) }
function stopLive() { link?.close(); link = null; live.value = false; busy.value = false; relinking.value = false; if (linkFail.value) setFail(''); emit('selection', null) }
function reconnect() { setFail(''); if (link) link.retry(); else startLive() }

// Click to mention (office-host page-live.mjs): with "@ 가리키기" on (or ⌥ held), a click on a table,
// an image, a paragraph or a cell range comes back as a mention for the chat input.
const MENTIONS = new Set(['docs', 'sheets', 'hwp'])
const canMention = computed(() => props.assistant && !props.readOnly && MENTIONS.has(editor()))
const mentionMode = ref(false)
function post(msg) {
  const w = frame.value?.contentWindow
  if (w) w.postMessage({ source: 'process-gpt', ...msg }, new URL(frameSrc.value, location.href).origin)
}
watch(mentionMode, (on) => post({ type: 'mention-mode', on }))
// requests the page answers ({type:'reply', requestId}): a picture's bytes, or new ones for it.
// 한글 pictures: every office host since the round trip ('hwp-*'); Word pictures: a host whose page
// says so at load ({type:'page-live', pictures:true}, office-host page-live.mjs)
const waiting = new Map()
const pagePictures = ref(false)
function ask(type, data = {}, timeoutMs = 60000) {
  const requestId = Math.random().toString(36).slice(2)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiting.delete(requestId); reject(new Error('편집기가 답하지 않았어요')) }, timeoutMs)
    waiting.set(requestId, { resolve, reject, t })
    post({ type, requestId, ...data })
  })
}
// ---- saving without 저장 (autoSave) ----
const IDLE_MS = 6000
const edited = ref(false)   // an edit not saved yet
const saving = ref(false)
let editSeq = 0
let idleTimer = null
let unwatch = null
let hinted = false
let settle = null           // the save in flight: answered by the editor's saved / save-failed
let inFlight = null
function onEdit() {
  if (props.readOnly) {
    if (!hinted) { hinted = true; show('info', '보기 전용으로 열었어요 — 여기서 고친 내용은 저장되지 않아요.', 6000) }
    return
  }
  // (every editable document knows it has unsaved edits — 「내려받기」 saves them first; only autoSave saves by itself)
  editSeq++
  if (!edited.value) emit('edited', true)
  edited.value = true
  // (a 「다른 이름으로 저장」 that did not become a card is not tried again with older content: the bar goes back to 「저장 안 됨」)
  if (retryFn) { retryFn = null; if (saveState.value.kind === 'failed') saveState.value = { kind: 'idle' } }
  if (!props.autoSave) return
  clearTimeout(idleTimer)
  idleTimer = setTimeout(idleSave, IDLE_MS)
}
function idleSave() {
  // a slide's text box still being typed in: wait for the person to leave it (or for flush)
  const doc = frame.value?.contentDocument
  if (editor() === 'slides' && doc?.activeElement?.isContentEditable) { idleTimer = setTimeout(idleSave, IDLE_MS); return }
  saveNow()
}
// press 저장 and wait for the editor's answer: {saved, url?, clean?} | {saved:false, error|timeout}
// (any: a document that does not save by itself — 「내려받기」, closing, 다시 시도 and 「다른 이름으로 저장」 ask for its edits to be saved;
// force: also when the editor's 저장 says there is nothing new — a retry after its upload failed;
// copy: 「다른 이름으로 저장」's — what the editor saves goes to the sheet as a copy: the card does not move, the bar and the edits stay)
// (waits SAVE_WAIT_MS by default: longer than the office host gives an upload, so 「failed」 here is the host's word — the upload stopped)
function saveNow(timeoutMs = SAVE_WAIT_MS, { any = false, force = false, copy = false } = {}) {
  if ((!props.autoSave && !any) || props.readOnly || !frame.value) return Promise.resolve({ saved: false })
  // (the editor's connection is gone: its save would never be answered)
  if (gone.value) { if (!copy) failSave(GONE); return Promise.resolve({ saved: false, error: GONE }) }
  if (inFlight) return inFlight.then(() => (dirty() ? saveNow(timeoutMs, { any, force, copy }) : { saved: true, clean: true }))
  // the editor has nothing new since its save for 「다른 이름으로 저장」, which is up (the new card was not made): that copy is this card's save
  if (unsavedCopy && lastSaved && editorClean(frame.value?.contentDocument) === true) return copy ? Promise.resolve({ saved: true, url: lastSaved }) : saveFromCopy()
  // (nothing to save — the editor would write nothing and say nothing)
  if (!force && !dirty()) return Promise.resolve({ saved: true, clean: true })
  clearTimeout(idleTimer)
  const seq = editSeq
  const aseq = agentSeq
  const tseq = touchSeq
  // (an answer that comes after this save gave up is still this save's: it covers what was there when it was pressed)
  if (!copy) pressMark = { edit: seq, agent: aseq, touch: tseq }
  saving.value = true
  if (!props.autoSave && !copy) { clearTimeout(pressTimer); pressTimer = null; retryFn = null; saveState.value = { kind: 'saving' } }
  inFlight = new Promise((resolve) => {
    const t = setTimeout(() => done({ saved: false, timeout: true }), timeoutMs)
    function done(r) {
      clearTimeout(t); settle = null; inFlight = null; saving.value = false
      const wasCopy = copySave
      copySave = false
      // (a copy whose answer comes after all is still the copy's — not a save of the card)
      if (wasCopy && r.timeout) copyLate = true
      // a save that failed or got no answer: what the editor holds is not saved, whatever its own 저장 says now (it is off after an
      // upload that failed — review #111: closing did not ask, and 「다른 이름으로 저장」's 다시 시도 made the new card from the older file)
      if (!r.saved && !r.reloaded) unlanded = true
      if (r.saved) unlanded = false
      if (!wasCopy) {
        if (r.saved) pressMark = null
        if (r.saved && editSeq === seq) { edited.value = false; emit('edited', false) }
        if (r.saved && agentSeq === aseq) agentEdits.value = false
        if (r.saved && touchSeq === tseq) touched = false
        if (!r.saved && !r.reloaded) failSave(r.timeout ? `편집기가 ${Math.round(timeoutMs / 1000)}초 안에 저장을 마치지 못했어요` : r.error || '')
      }
      resolve(r)
    }
    settle = done
    copySave = copy
    // (this press is the frame's own: not the person's 저장 — pressed() leaves it alone)
    selfPress = true
    const republish = canRepublish ? () => frame.value?.contentWindow?.postMessage({ source: 'process-gpt', type: 'republish' }, '*') : null
    pressSave(frame.value, { republish, editor: editor() })
      .then((how) => { if (!how) done({ saved: false, error: '편집기가 열려 있지 않아요' }) }, () => done({ saved: false, error: '편집기가 열려 있지 않아요' }))
      .finally(() => { selfPress = false })
  })
  return inFlight
}
// Is there something to save? Our own count of edits, the agent's, or the editor's own 저장 switched on (every IeumOffice editor turns
// it off while it has nothing new). The editor's word that it is clean is taken over our count only where its flag follows every edit
// as it is made (the text · html editors); a spreadsheet's cell being typed in, a slide's text box being written in, hold
// their text until they are left — their 저장 is off meanwhile (review #107: a cell typed and left by ↓ was lost).
// The mind map's 저장 is off only while it loads (on for good after), so it says nothing either way: our own count, the agent's, and
// any press in the map (its edits are mostly made with the mouse — a topic dragged, a tool of its bar; `touched`, below; a press that
// only moved the view asks too, which is the safer way to be wrong). Once the editor's fork turns its 저장 off while nothing is new
// (apps/mindmap Toolbar `disabled={p.disabled || !(p.dirty || p.typing)}` — on while a title is still being typed) and that build is the
// office host's, the mind map goes to LIVE_DIRTY and `touched` goes; until then a 저장 that says off is already taken as clean (no press
// of an off button that would never be answered).
// Asked where it matters (closing, flush, 내려받기, 다른 이름으로 저장, 저장) — never on a timer.
const LIVE_DIRTY = new Set(['markdown', 'html'])
const BUTTON_SAYS_NOTHING = new Set(['mindmap'])
function dirty() {
  const doc = frame.value?.contentDocument
  // (a save of this opening failed or got no answer, and none has landed since: the editor's 저장 being off says nothing then)
  if (unlanded) return true
  if (BUTTON_SAYS_NOTHING.has(editor())) return edited.value || agentEdits.value || unsavedCopy || (touched && editorClean(doc) !== true)
  const clean = editorClean(doc)
  if (clean === false || agentEdits.value) return true
  if (!edited.value) return false
  if (clean !== true || unsavedCopy || inFlight || pressTimer || !LIVE_DIRTY.has(editor())) return true
  edited.value = false
  emit('edited', false)
  return false
}
// this card takes the copy saved for 「다른 이름으로 저장」 (its content is the editor's now): as a save of the editor's own
function saveFromCopy() {
  const url = lastSaved
  unsavedCopy = false
  unlanded = false
  if (edited.value) { edited.value = false; emit('edited', false) }
  agentEdits.value = false
  touched = false
  emit('saved', { url, name: props.name })
  afterSave(url)
  return Promise.resolve({ saved: true, url })
}
// no save waiting for its answer (a 「다른 이름으로 저장」 starts after the one in flight — 💾, 내려받기)
async function whenIdle(ms = SAVE_WAIT_MS + 2000) {
  const t0 = Date.now()
  while ((inFlight || pressTimer) && Date.now() - t0 < ms) await (inFlight || new Promise((r) => setTimeout(r, 200)))
}

// ---- the person's own 저장 (a document that does not save by itself): what the bar says ----
const GONE = '편집기와 연결이 끊겼어요 — 고친 내용을 복사해 두고 「다시 열기」를 눌러 주세요'
// the editor's connection to its host closed (the page said 'closed'): nothing it does is saved any more
const gone = ref(false)
const saveState = ref({ kind: 'idle' }) // {kind: 'idle'|'saving'|'saved'|'failed', at?, why?, where?}
let pressTimer = null
// the save in flight is a copy (saveNow copy) · a copy gave up waiting: the next answer nobody waits for is that copy's
let copySave = false
let copyLate = false
// the frame is pressing 저장 itself (saveNow): not the person's press
let selfPress = false
// a copy for 「다른 이름으로 저장」 went up and this card has not taken it (the editor is clean; the edits are unsaved here)
let unsavedCopy = false
// the mind map was pressed since its last save: it may have been edited (dirty()). Anywhere — its map, its tools, its 실행 취소 · 다시 실행
// (on the ribbon's top row: review #111) — but its 저장, 다른 이름으로 저장 and 자동 저장 switch
let touched = false
let touchSeq = 0
function onPointer(e) {
  if (props.readOnly || !BUTTON_SAYS_NOTHING.has(editor())) return
  const el = e?.target?.closest?.('button, [role="button"], [role="menuitem"], [data-cmd], label')
  if (el && (saveKindOf(el) || el.closest('.autosave-toggle'))) return
  touched = true
  touchSeq++
}
// a save failed or was not answered, and no save has landed since (dirty() says so whatever the editor's 저장 says)
let unlanded = false
// what the save awaited now covered when it was pressed: its answer clears only that ({edit, agent, touch} counts; null: none)
let pressMark = null
// the office host sends the editor's last write up again when asked (its 'ready' says so — host/documents.mjs republish)
let canRepublish = false
// the sheet's own 다시 시도 for a failure it reported (markFailed — 「다른 이름으로 저장」 posts its copy again)
let retryFn = null
const badge = computed(() => {
  if (props.readOnly) return null
  if (gone.value) return saveBadge({}, { gone: true })
  return props.autoSave ? null : saveBadge(saveState.value, { edited: edited.value || agentEdits.value })
})
// the person pressed the editor's 저장 (its button or ⌘S): the answer is awaited (the frame's own saves wait in saveNow)
function pressed() {
  if (props.readOnly || props.autoSave || inFlight || selfPress) return
  if (gone.value) return failSave(GONE)
  if (unsavedCopy && lastSaved && editorClean(frame.value?.contentDocument) === true) { saveFromCopy(); return }
  // nothing new: the editor writes nothing and says nothing
  if (!dirty()) return
  retryFn = null
  pressMark = { edit: editSeq, agent: agentSeq, touch: touchSeq }
  saveState.value = { kind: 'saving' }
  clearTimeout(pressTimer)
  pressTimer = setTimeout(() => { unlanded = true; failSave(`편집기가 ${Math.round(SAVE_WAIT_MS / 1000)}초 안에 저장을 마치지 못했어요`) }, SAVE_WAIT_MS)
}
function failSave(why) {
  clearTimeout(pressTimer); pressTimer = null
  if (props.autoSave || props.readOnly) return
  saveState.value = { kind: 'failed', why: String(why || '') }
  show('error', `저장하지 못했어요${why ? ` — ${why}` : ''}`, 10000)
}
// a failure the sheet found in its own step (「다른 이름으로 저장」's copy did not become a card): said on the bar; 다시 시도 runs retry
function markFailed(why, { retry = null } = {}) {
  failSave(why)
  retryFn = retry
}
// the editor saved: the host's own step (the chat card, the folder's commit) decides whether it is saved
async function afterSave(url) {
  clearTimeout(pressTimer); pressTimer = null
  if (props.autoSave || props.readOnly) return
  saveState.value = { kind: 'saving' }
  const limit = new Promise((r) => setTimeout(() => r({ ok: false, why: '저장한 곳을 확인하지 못했어요' }), SAVE_WAIT_MS))
  const c = props.saveCheck ? await Promise.race([props.saveCheck().catch((e) => ({ ok: false, why: e?.message || '' })), limit]) : { ok: true }
  if (!c?.ok) return failSave(c?.why || '')
  retryFn = null
  saveState.value = { kind: 'saved', at: Date.now(), where: c.where || '' }
  if (!props.quietSave) show('success', c.where ? `저장했어요 · ${c.where}` : url ? '저장했어요. 편집본이 원본 옆에 올라갔어요.' : '저장했어요.', 4000)
}
// 「저장하지 못했어요 · 다시 시도」 · 「연결 끊김 · 다시 열기」
async function badgeAction() {
  const a = badge.value?.action
  if (a === 'reopen') return reopen()
  if (a !== 'retry') return
  if (retryFn) {
    const again = retryFn
    retryFn = null
    saveState.value = { kind: 'saving' }
    await again()
    // (a retry that did nothing — the document changed meanwhile — leaves no 「저장하는 중…」 behind)
    if (saveState.value.kind === 'saving' && !inFlight && !pressTimer) saveState.value = { kind: 'idle' }
    return
  }
  // the editor's copy went up, the host's own step did not: that step again (not when the upload itself failed — unlanded)
  if (!unlanded && !edited.value && !agentEdits.value && lastSaved) return afterSave(lastSaved)
  await saveNow(SAVE_WAIT_MS, { any: true, force: true })
}
// a new connection: the editor opens the version saved last (edits not saved in this one are lost — asked first)
async function reopen() {
  if (edited.value || agentEdits.value) {
    const a = await askPerson({ title: '편집기를 다시 열까요?', text: '편집기와 연결이 끊겨 이 문서는 지금 저장할 수 없어요. 다시 열면 마지막으로 저장한 버전이 열리고, 저장하지 않은 내용은 사라져요. 필요한 부분은 먼저 복사해 두세요.',
      buttons: [{ id: 'reopen', label: '다시 열기', kind: 'danger' }, { id: 'cancel', label: '취소' }], cancel: 'cancel' })
    if (a.id !== 'reopen') return
  }
  // (a new frame: the same address would not load the page again)
  frameSrc.value = ''
  await nextTick()
  load()
}
// the connection kept busy: the page passes 'context' on to the host — the same context again (nothing changes there)
let keepTimer = null
function keepAlive() {
  clearInterval(keepTimer)
  keepTimer = setInterval(() => { if (ready && !gone.value) post({ type: 'context', context: props.context ? JSON.parse(JSON.stringify(props.context)) : null }) }, KEEPALIVE_MS)
}
const stopKeepAlive = () => { clearInterval(keepTimer); keepTimer = null }

// ---- the frame's own question over the document: askPerson({title, text, input?, buttons: [{id, label, kind}], cancel}) → {id, value} ----
const askBox = ref(null)
const askInput = ref(null)
function askPerson({ title, text = '', input = null, buttons, cancel = 'cancel' }) {
  answer(askBox.value?.cancel)
  return new Promise((resolve) => {
    askBox.value = { title, text, input, value: input ?? '', buttons, cancel, resolve }
    nextTick(() => {
      const el = askInput.value
      if (el) { el.focus(); const dot = el.value.lastIndexOf('.'); el.setSelectionRange(0, dot > 0 ? dot : el.value.length) }
      else root.value?.querySelector('.ask-b button')?.focus()
    })
  })
}
function answer(id) {
  const b = askBox.value
  if (!b) return
  askBox.value = null
  b.resolve({ id: id ?? b.cancel, value: b.value })
}
// the editor's 「다른 이름으로 저장」: the sheet names the copy; elsewhere it is not offered (hidden — this is a press that got through)
function onSaveAs() {
  if (props.readOnly) return
  if (props.saveAs) return props.saveAs()
  show('info', '이 문서는 여기서 다른 이름으로 저장할 수 없어요 — 「내려받기」로 받아 두세요.', 6000)
}
// before the sheet closes: save what is left; {clean:true} when there was nothing to save
async function flush(timeoutMs) {
  clearTimeout(idleTimer)
  if (!inFlight && !dirty()) return { saved: false, clean: true }
  return saveNow(timeoutMs)
}
// ---- 「내려받기」 ----
// the agent's edits (office_live_* — no key pressed in the page) are unsaved edits too, until a save
const agentEdits = ref(false)
let agentSeq = 0
// the copy the editor saved last in this opening (a chat file's edited copy; the parent may not have swapped fileUrl to it yet)
let lastSaved = ''
async function prepareDownload() {
  if (props.readOnly) return { ok: true, version: 'current' }
  let version = 'current'
  if (inFlight || dirty()) {
    const r = await saveNow(SAVE_WAIT_MS, { any: true })
    if (!r.saved) return { ok: false, why: r.timeout ? '편집기가 답하지 않았어요' : r.error || '' }
    if (!r.clean) version = 'saved'
  }
  // (also with nothing new: an earlier save that never reached the folder or my card is said, not passed off as the newest)
  const c = props.saveCheck ? await props.saveCheck() : { ok: true }
  // (the editor's own copy is up; the host tries its step again at the next press — the editor has nothing new to save)
  if (!c?.ok) return { ok: false, why: c?.why || '' }
  return { ok: true, version }
}
async function downloadSource({ last = false } = {}) {
  const own = typeof props.download === 'function' ? await props.download({ last }) : null
  if (own?.url) return { name: props.name, ...own }
  return { url: lastSaved || props.fileUrl, name: props.name }
}
const onHide = () => { if (document.visibilityState === 'hidden' && edited.value && !inFlight) saveNow() }
// leaving the page with edits not saved (any editable document — a chat's one is saved only by 저장): the browser asks first
const onLeave = (e) => { if (!props.readOnly && (inFlight || dirty())) { e.preventDefault(); e.returnValue = '' } }
function startWatching() {
  unwatch?.()
  unwatch = watchEdits(frame.value, onEdit, { onSave: pressed, onSaveAs, onDoc: dressSaving, onPointer })
}
// each page of the editor (the 한글 studio's comes later, in a frame of its own)
function dressSaving(doc) {
  if (!doc?.head || doc.getElementById('pgpt-autosave')) return
  const rules = []
  // the editor's own 자동 저장 switch (off on the web host) would contradict the bar's 자동 저장
  if (props.autoSave) rules.push('.autosave-toggle { display: none !important; }')
  // 다른 이름으로 저장 only where the sheet can name the copy (the web host cancels the editor's own file dialog); never another format
  rules.push(saveAsHideCss({ saveAs: !!props.saveAs }))
  const st = doc.createElement('style')
  st.id = 'pgpt-autosave'
  st.textContent = rules.join('\n')
  doc.head.appendChild(st)
}

defineExpose({
  flush,
  edited,
  saving,
  agentEdits,
  gone,
  saveNow,
  dirty,
  whenIdle,
  // the editor's copy saved last in this opening ('' when none) — 「다른 이름으로 저장」 copies it when the card did not take it
  lastSaved: () => lastSaved,
  markFailed,
  ask: askPerson,
  editor,
  reconnect,
  canPictures: (ed = editor()) => ed === 'hwp' || (ed === 'docs' && editor() === 'docs' && pagePictures.value),
  picture: (n) => (editor() === 'docs' ? ask('picture', { n }, 20000) : ask('hwp-picture', { n })),
  replacePicture: (n, bytes, name) => ask(editor() === 'docs' ? 'replace-picture' : 'hwp-replace-picture', { n, bytes, name: name || props.name }, 120000),
})

async function load() {
  stopLive()
  unwatch?.(); unwatch = null; clearTimeout(idleTimer); edited.value = false; hinted = false; agentEdits.value = false; lastSaved = ''
  ready = false
  // (a save of the page being replaced is not this one's: it ends quietly, before the new page's state is set)
  settle?.({ saved: false, error: '문서를 다시 열었어요', reloaded: true })
  stopKeepAlive(); gone.value = false; clearTimeout(pressTimer); pressTimer = null; saveState.value = { kind: 'idle' }; answer()
  copySave = false; copyLate = false; retryFn = null; unsavedCopy = false; touched = false; unlanded = false; pressMark = null; canRepublish = false
  pagePictures.value = false
  // with an expired token the host refuses every editor call — the UI language too, so its menus
  // fall back to the editor's built-in default (Chinese)
  const token = await freshToken()
  opened(); opening.value = true; watchDrawn()
  openingTimer = setTimeout(() => { openingSlow.value = true; openingTimer = setTimeout(opened, 60000) }, 3000)
  frameSrc.value = officeEditorUrl({ fileUrl: props.fileUrl, name: props.name, readOnly: props.readOnly, assistant: props.assistant ? 'parent' : '', token })
  if (!frameSrc.value) { opened(); emptyText.value = '이 문서는 편집기로 열 수 없어요.'; return }
  const key = RIBBON_KEYS[editor()]
  if (key) try { localStorage.setItem(key, '1') } catch { /* private mode: the editor opens unfolded */ }
  ribbonOpen.value = false
  stopDeck()
  thumbsOpen.value = false
}
function show(kind, text, ms) {
  clearTimeout(timer)
  notice.value = { kind, text }
  timer = setTimeout(() => (notice.value = null), ms || (kind === 'error' ? 8000 : kind === 'agent' ? 6000 : 2500))
}
function sendContext() {
  const w = frame.value?.contentWindow
  if (!ready || !w || !props.context) return
  w.postMessage({ source: 'process-gpt', type: 'context', context: JSON.parse(JSON.stringify(props.context)) }, new URL(frameSrc.value, location.href).origin)
}
// a read-only preview (shared-folder files) is for looking: the editor's AI dock stays out of the way
// (the chat sheet edits, so it keeps the dock)
function hideAiDock(tries = 20) {
  const doc = frame.value?.contentDocument
  if (!doc?.head) { if (tries > 0) setTimeout(() => hideAiDock(tries - 1), 250); return }
  if (doc.getElementById('pgpt-hide-ai')) return
  const st = doc.createElement('style')
  st.id = 'pgpt-hide-ai'
  st.textContent = '.ai-dock, .copilot, .ai-panel-resizer { display: none !important; }'
  doc.head.appendChild(st)
}
function onMessage(event) {
  if (!isOfficeEditorMessage(event, frame.value?.contentWindow)) return
  // (and from the editor's own origin — the page this frame loaded)
  if (!frameSrc.value || event.origin !== new URL(frameSrc.value, location.href).origin) return
  const m = event.data
  if (m.type === 'ready') {
    if (m.republish) canRepublish = true
    ready = true; gone.value = false; sendContext(); emit('ready'); if (editor() === 'hwp') foldHwpWhenReady(); if (props.readOnly || props.autoSave) hideAiDock(); startLive(); startWatching()
    dressEditor(); syncSoon(); keepAlive()
    if (deck.value && !deckTimer) deckTimer = setInterval(readDeck, 600)
  }
  // the editor's connection to its host closed (production: Cloudflare ends one idle for ~100 s; a host restart, the network):
  // whatever the page sends now is dropped unanswered — a save waiting fails at once, and the bar says so (그 앞의 'closed' of a
  // page being replaced is not this page's: ready is false until the new page's 'ready')
  else if (m.type === 'closed') {
    if (!ready || gone.value) return
    gone.value = true; stopKeepAlive()
    const waiting = !!settle || !!pressTimer
    if (pressTimer) unlanded = true
    if (settle) settle({ saved: false, error: GONE })
    else if (pressTimer) failSave(GONE)
    if (!props.readOnly && (props.autoSave || !waiting)) show('error', edited.value || agentEdits.value ? '편집기와 연결이 끊겨 지금은 저장할 수 없어요 — 고친 내용을 복사해 두고 「다시 열기」를 눌러 주세요.' : '편집기와 연결이 끊겼어요 — 「다시 열기」로 다시 열어 주세요.', 12000)
    emit('gone')
  }
  else if (m.type === 'assistant') emit('assistant', { label: m.label || '', prompt: m.prompt || null, selection: m.selection || '' })
  else if (m.type === 'mention' && m.mention) emit('mention', { ...m.mention, file: props.name })
  // (an editable document joined to the chat only: a read-only preview has nothing to ask about)
  else if (m.type === 'selection') { if (props.assistant && !props.readOnly) emit('selection', m.selection || null) }
  else if (m.type === 'page-live') pagePictures.value = !!m.pictures
  else if (m.type === 'reply') {
    const w = waiting.get(m.requestId)
    if (!w) return
    waiting.delete(m.requestId); clearTimeout(w.t)
    m.ok ? w.resolve(m.result) : w.reject(new Error(m.error || '편집기가 거절했어요'))
  }
  else if (m.type === 'saved') {
    // (a host that says so when the same bytes were saved again — an edit undone before 저장: only an answer to a save waiting for it)
    if (m.unchanged && !settle && !pressTimer) return
    if (m.url) { savedUrls.add(m.url); lastSaved = m.url }
    if (m.name) link?.rename(m.name)
    // 「다른 이름으로 저장」's save — or its late answer, unless the person pressed 저장 since: a copy for the sheet; the card and the bar stay
    let copy = !!settle && copySave
    if (!settle && copyLate && !pressTimer) copy = true
    if (!settle || !copySave) copyLate = false
    if (settle) settle({ saved: true, url: m.url || '', ...(m.unchanged && !m.url ? { clean: true } : {}) })
    else if (!copy) {
      // the editor's own save (the person's 저장 · ⌘S, a late answer to one that gave up, the agent's): the editor's last write is up. It
      // covers what there was when it was pressed — an edit or a press after that is not in it (review #111). A save nobody pressed here
      // (the editor's own 자동 저장) leaves the marks: asked once more on closing, never an edit taken as saved.
      unlanded = false
      const mark = pressMark
      pressMark = null
      // (the agent's own save may answer before the frame hears of it: a save nobody pressed here clears the agent's edits, as before)
      if (!mark || agentSeq === mark.agent) agentEdits.value = false
      if (mark && touchSeq === mark.touch) touched = false
      if (mark && editSeq === mark.edit && edited.value) { edited.value = false; emit('edited', false) }
    }
    unsavedCopy = copy
    emit('saved', { url: m.url || '', name: m.name || props.name, ...(copy ? { copy: true } : {}) })
    // (after the host heard it: its own step — the card, the folder — is part of 「저장했어요」)
    if (!copy) afterSave(m.url || '')
  } else if (m.type === 'agent') {
    const label = { write: '내용을 쓰는 중', replace: '내용을 바꾸는 중', ops: '서식·구조를 고치는 중', save: '저장했어요' }[m.action]
    show('agent', `에이전트가 ${label || '작업하는 중'}${m.text ? ` · ${m.text}` : ''}`)
    busy.value = m.action !== 'save'
    if (busy.value && !props.readOnly) { agentSeq++; agentEdits.value = true }
    // (the agent saves the document as it is: its 「saved」 covers everything up to now)
    if (m.action === 'save' && !settle && !pressTimer) pressMark = { edit: editSeq, agent: agentSeq, touch: touchSeq }
    clearTimeout(busyTimer)
    busyTimer = setTimeout(() => (busy.value = false), 4000)
    emit('agent', m)
  } else if (m.type === 'save-failed') {
    const why = `편집기가 문서를 올리지 못했어요${m.error ? ` (${m.error})` : ''}`
    // (the editor took its save as done — its 저장 goes off — but nothing reached storage: the opening stays unsaved until a save lands)
    unlanded = true
    if (props.autoSave || props.readOnly) show('error', `저장한 문서를 올리지 못했어요: ${m.error || ''}`)
    // (a save the frame asked for — 「내려받기」, closing — says the editor's own words in its own sentence)
    if (settle) settle({ saved: false, error: m.error || '' })
    else failSave(why)
    emit('error', m.error)
  }
  else if (m.type === 'error') { opened(); show('error', `문서를 열지 못했어요: ${m.error || ''}`); emit('error', m.error) }
}
async function toggleFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.value.requestFullscreen() }
  catch { show('error', '이 브라우저에서는 전체 화면을 쓸 수 없어요.') }
}
const onFs = () => { fullscreen.value = document.fullscreenElement === root.value }

watch(() => props.fileUrl, (u) => { if (u && !savedUrls.has(u)) load() })
watch(() => props.readOnly, load)
watch(() => props.context, sendContext, { deep: true })
onMounted(() => {
  window.addEventListener('message', onMessage); document.addEventListener('fullscreenchange', onFs); load()
  document.addEventListener('visibilitychange', onHide); window.addEventListener('beforeunload', onLeave)
  coarseMq?.addEventListener?.('change', onCoarse)
  boxObserver = new ResizeObserver(([e]) => { box.value = { w: e.contentRect.width, h: e.contentRect.height } })
  boxObserver.observe(root.value)
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage); document.removeEventListener('fullscreenchange', onFs); clearTimeout(timer); clearTimeout(busyTimer); alive = false; stopLive()
  document.removeEventListener('visibilitychange', onHide); window.removeEventListener('beforeunload', onLeave); unwatch?.(); clearTimeout(idleTimer); opened()
  coarseMq?.removeEventListener?.('change', onCoarse); boxObserver?.disconnect(); stopDeck()
  stopKeepAlive(); clearTimeout(pressTimer); answer()
})
</script>

<template>
  <div ref="root" class="oef" :class="{ fs: fullscreen }">
    <div class="bar">
      <span class="fmt" :class="kindOf(name)">{{ kindLabel[kindOf(name)] || 'DOC' }}</span>
      <span class="name">{{ name || '문서' }}</span>
      <span v-if="readOnly" class="badge ro">보기 전용</span>
      <!-- how the person's save went (src/officeSave.js saveBadge): 저장 안 됨 · 저장하는 중… · 저장했어요 · 10:42 · 저장하지 못했어요 · 다시 시도 · 연결 끊김 -->
      <button v-else-if="badge" class="badge sv press" :class="badge.kind" data-testid="oef-save" :data-state="badge.kind" :title="badge.title" :aria-label="badge.title"
        :aria-disabled="badge.action ? 'false' : 'true'" aria-live="polite" @click="badgeAction"><i /><span class="t-long">{{ badge.text }}</span><span class="t-short">{{ badge.short }}</span></button>
      <span v-else-if="autoSave" class="badge auto" :class="{ on: saving || edited }" :title="saving ? '저장하는 중' : edited ? '잠시 뒤 저장해요' : '고친 내용은 저절로 저장돼요'">{{ saving ? '저장하는 중…' : edited ? '고치는 중' : '자동 저장' }}</span>
      <span v-if="live" class="badge live" :class="{ busy }" title="대화창에 적은 수정안이 이 문서에 바로 적용돼요"><i /><span class="t">{{ busy ? 'AI가 고치는 중' : '대화와 연결됨' }}</span></span>
      <button v-else-if="relinking" class="badge relink press" data-testid="oef-relinking" title="대화와의 연결이 잠깐 끊겨 다시 잇는 중이에요 — 저절로 이어져요 · 눌러서 지금 다시 연결" @click="reconnect"><i /><span class="t">다시 연결하는 중…</span></button>
      <button v-else-if="linkFail" class="badge off press" :title="`대화와 연결되지 않았어요 — ${linkFail} · 눌러서 다시 연결`" @click="reconnect"><i /><span class="t">연결 안 됨 · 다시 연결</span></button>
      <span class="sp" />
      <!-- the editor is IeumOffice (Apache-2.0); its lockup marks whose editor this is -->
      <img class="ieum" :src="`${BASE}/brand/ieumoffice-logo.svg`" alt="IeumOffice" title="이음오피스 편집기" width="66" height="15" />
      <DownloadButton v-if="download !== false" class="tb" data-testid="oef-download" :source="downloadSource" :prepare="readOnly ? null : prepareDownload" />
      <ShareButton v-if="!readOnly" :for-name="name" plain class="tb" />
      <button v-if="canMention" class="tb press" :class="{ on: mentionMode }" title="켜고 문서의 표·그림·문단(엑셀은 셀 범위)을 누르면 대화 입력창에 @멘션으로 들어가요 (⌥ 누른 채 클릭도 돼요)" @click="mentionMode = !mentionMode">
        @<span class="lb"> {{ mentionMode ? '가리키는 중' : '가리키기' }}</span>
      </button>
      <button v-if="compact && deck" class="tb press" :class="{ on: thumbsOpen }" data-testid="oef-thumbs" :title="thumbsOpen ? '슬라이드 목록 닫기' : '슬라이드 목록 열기'" @click="thumbsOpen = !thumbsOpen">
        <Icon name="plan" :size="15" /><span class="lb"> 슬라이드 목록</span>
      </button>
      <button class="tb press" data-testid="oef-ribbon" :title="ribbonOpen ? '리본 접기 (Ctrl+F1)' : '리본 펴기 (Ctrl+F1)'" @click="toggleRibbon">
        <Icon :name="ribbonOpen ? 'up' : 'chevron'" :size="14" /><span class="lb"> {{ ribbonOpen ? '리본 접기' : '리본 펴기' }}</span>
      </button>
      <button v-if="!fullscreen" class="tb opt press" @click="emit('update:maximized', !maximized)">
        <Icon :name="maximized ? 'shrink' : 'expand'" :size="15" /> {{ maximized ? '원래 크기' : '최대화' }}
      </button>
      <button class="tb opt press" @click="toggleFullscreen">{{ fullscreen ? '전체 화면 끝내기' : '전체 화면' }}</button>
      <button class="tb ic press" title="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button>
    </div>
    <div v-if="busy" class="glow" />
    <iframe v-if="frameSrc" ref="frame" :src="frameSrc" :title="name || '문서 편집기'" class="frm" allow="clipboard-read; clipboard-write; fullscreen" @load="dressEditor" />
    <div v-else class="empty">{{ emptyText }}</div>
    <div v-if="frameSrc && opening" class="opening" data-testid="oef-opening">
      <span class="spin" /><b>문서를 여는 중…</b>
      <small v-if="openingSlow">처음 열 때는 편집기를 받느라 10초쯤 걸릴 수 있어요.</small>
    </div>
    <template v-if="slideNav">
      <button class="snav prev press" data-testid="oef-prev" title="이전 슬라이드" aria-label="이전 슬라이드" :style="slidePos.mid ? { top: `${slidePos.mid}px` } : null"
        :disabled="slidePos.cur <= 1" @click="goSlide(-1)"><Icon name="back" :size="22" /></button>
      <button class="snav next press" data-testid="oef-next" title="다음 슬라이드" aria-label="다음 슬라이드" :style="slidePos.mid ? { top: `${slidePos.mid}px` } : null"
        :disabled="slidePos.cur >= slidePos.total" @click="goSlide(1)"><Icon name="chevron" :size="22" /></button>
    </template>
    <Transition name="fade">
      <div v-if="notice" class="notice" :class="notice.kind" data-testid="oef-notice" role="status">{{ notice.text }}</div>
    </Transition>
    <!-- the frame's own question over the document (closing with edits not saved, 다른 이름으로 저장, 다시 열기) -->
    <div v-if="askBox" class="ask-veil" data-testid="oef-ask" @click.self="answer(askBox.cancel)" @keydown.esc.prevent="answer(askBox.cancel)">
      <div class="ask" role="alertdialog" aria-modal="true" :aria-label="askBox.title">
        <b class="ask-t">{{ askBox.title }}</b>
        <p v-if="askBox.text" class="ask-p">{{ askBox.text }}</p>
        <input v-if="askBox.input != null" ref="askInput" v-model="askBox.value" class="ask-in" data-testid="oef-ask-name" :aria-label="askBox.title" spellcheck="false"
          @keydown.enter.prevent="answer(askBox.buttons[0].id)" />
        <div class="ask-b">
          <button v-for="b in askBox.buttons" :key="b.id" class="press" :class="b.kind" :data-testid="`oef-ask-${b.id}`" @click="answer(b.id)">{{ b.label }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* the iframe takes the height left in the column (an explicit 100% falls back to 150px when the
   parent height is not definite) */
.oef { container-type: inline-size; position: relative; display: flex; flex-direction: column; flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; background: #fff; border-radius: inherit; overflow: hidden; }
.oef.fs { min-height: 100vh; border-radius: 0; }
.bar { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; height: 44px; padding: 0 8px 0 14px; border-bottom: 1px solid rgba(0, 0, 0, .08); color: #1d1d1f; }
.name { min-width: 0; flex: 0 1 auto; overflow: hidden; font-size: 14px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
/* the file's format tile (same colours as the chat card) and the IeumOffice lockup */
.fmt { flex: none; min-width: 26px; height: 22px; padding: 0 5px; border-radius: 6px; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff; background: #6b6b66; }
.fmt.hwp { background: #1f6fd1; } .fmt.doc { background: #2b579a; } .fmt.xls { background: #217346; } .fmt.ppt { background: #c43e1c; } .fmt.pdf { background: #d93025; }
.ieum { flex: none; height: 15px; width: auto; margin: 0 6px; opacity: .72; }
/* a narrow side sheet keeps the buttons on one line; the logo goes first */
@container (max-width: 640px) { .ieum { display: none; } }
/* a phone on its side (the sheet beside the chat): button labels fold to icons so 닫기 stays in sight */
@container (max-width: 640px) { .bar .lb { display: none; } }
@media (max-width: 700px) { .ieum { display: none; } }
/* a phone-wide sheet: the close button must stay in sight — size buttons go (the sheet is already the whole width), labels fold to icons */
/* (the live state stays, as its dot alone) */
@container (max-width: 520px) { .bar .opt, .bar .lb, .bar .badge:not(.live):not(.off):not(.relink):not(.ro):not(.auto):not(.sv), .bar .badge .t { display: none; } .bar .badge.live, .bar .badge.off, .bar .badge.relink { padding: 0; width: 22px; height: 22px; justify-content: center; } .bar { gap: 2px; padding: 0 4px 0 10px; } .bar .tb { padding: 0 8px; } .bar .tb.ic { padding: 0; } }
.badge { padding: 1px 8px; border-radius: 10px; background: rgba(42, 120, 214, .12); color: #2a78d6; font-size: 11px; white-space: nowrap; flex: 0 0 auto; }
.badge.live { display: inline-flex; align-items: center; gap: 6px; background: rgba(40, 160, 90, .12); color: #1e8a4c; }
.badge.live i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.badge.live.busy { background: rgba(110, 90, 230, .13); color: #5b47d6; }
.badge.live.busy i { animation: livepulse 1s ease-in-out infinite; }
.badge.off { display: inline-flex; align-items: center; gap: 6px; background: rgba(200, 60, 50, .1); color: #b3261e; cursor: pointer; }
.badge.off i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
/* joining again by itself after a drop (a server restart): amber, its dot breathing — not the red of a link that never joined */
.badge.relink { display: inline-flex; align-items: center; gap: 6px; background: rgba(230, 150, 20, .14); color: #8a5300; cursor: pointer; }
.badge.relink i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: livepulse 1.2s ease-in-out infinite; }
@keyframes livepulse { 50% { opacity: .25; transform: scale(.7); } }
/* while the agent's edits land: a soft rim around the document */
.glow { position: absolute; inset: 44px 0 0; z-index: 2; pointer-events: none; box-shadow: inset 0 0 0 2px rgba(120, 100, 240, .7), inset 0 0 26px rgba(120, 100, 240, .28); animation: glowin .3s ease both; }
@keyframes glowin { from { opacity: 0; } }
.sp { flex: 1; }
.tb { flex: none; display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 10px; border-radius: 15px; font-size: 13px; color: #5f6368; white-space: nowrap; }
.tb:hover { background: rgba(0, 0, 0, .05); }
.tb.ic { width: 30px; padding: 0; justify-content: center; }
.tb.on { background: rgba(110, 90, 230, .14); color: #5b47d6; font-weight: 600; }
.frm { flex: 1 1 auto; width: 100%; min-height: 0; border: 0; }
/* a deck on a phone: previous / next over the sides of the slide */
.snav { position: absolute; top: 50%; z-index: 3; width: 42px; height: 42px; margin-top: -21px; border-radius: 50%; display: grid; place-items: center; color: #1d1d1f; background: rgba(255, 255, 255, .9); box-shadow: 0 2px 10px rgba(0, 0, 0, .2); }
.snav.prev { left: 6px; }
.snav.next { right: 6px; }
.snav:disabled { opacity: .35; }
.empty { margin: auto; color: var(--text-secondary); font-size: 14px; }
.notice { position: absolute; right: 16px; bottom: 32px; padding: 8px 14px; border-radius: 8px; font-size: 13px; color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .2); }
.notice.success { background: #2e7d32; }
.notice.agent { max-width: 60%; background: #3949ab; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.notice.error { background: #c62828; }
.notice.info { max-width: 80%; background: #455a64; }
.opening { position: absolute; left: 0; right: 0; top: 44px; bottom: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: #fff; color: #1d1d1f; font-size: 14px; text-align: center; padding: 0 24px; z-index: 2; }
.opening small { color: #5f6368; font-size: 12.5px; line-height: 1.5; }
.opening .spin { width: 26px; height: 26px; border-radius: 50%; border: 3px solid rgba(0, 0, 0, .1); border-top-color: #2a78d6; animation: oefspin .8s linear infinite; }
@keyframes oefspin { to { transform: rotate(360deg); } }
/* (the bar stays light in the dark theme too: fixed colours) */
.badge.ro { background: #eceff1; color: #455a64; font-weight: 600; }
.badge.auto { background: rgba(40, 160, 90, .1); color: #1e8a4c; }
.badge.auto.on { background: rgba(230, 150, 20, .14); color: #a86400; }
/* the person's save (src/officeSave.js): its dot and words; a failure and a lost connection are buttons */
.badge.sv { display: inline-flex; align-items: center; gap: 5px; height: 20px; border: 0; font: inherit; font-size: 11px; line-height: 1; cursor: default; }
.badge.sv i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.badge.sv .t-short { display: none; }
.badge.sv.edited { background: rgba(230, 150, 20, .14); color: #8a5300; }
.badge.sv.saving { background: rgba(42, 120, 214, .12); color: #1f63b5; }
.badge.sv.saving i { animation: livepulse 1s ease-in-out infinite; }
.badge.sv.saved { background: rgba(40, 160, 90, .12); color: #1e7a45; }
.badge.sv.failed, .badge.sv.gone { background: rgba(200, 60, 50, .12); color: #b3261e; cursor: pointer; font-weight: 600; }
.badge.sv[aria-disabled="true"] { cursor: default; }
/* the bar beside the chat (~860–960px on a laptop) holds the name, the badges and eight buttons: there the badge says it short, and the
   pointing · ribbon buttons keep their icons only, so the name keeps its room and 닫기 stays in sight (their titles say what they are) */
@container (max-width: 1000px) { .badge.sv .t-long { display: none; } .badge.sv .t-short { display: inline; } }
@container (max-width: 960px) { .bar:has(.badge.sv) .lb { display: none; } }
@container (max-width: 800px) { .bar:has(.badge.sv) .ieum { display: none; } }
/* the frame's question: over the document, the bar stays (fixed light colours, as the bar) */
.ask-veil { position: absolute; left: 0; right: 0; top: 44px; bottom: 0; z-index: 7; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(20, 24, 32, .3); }
.ask { width: min(440px, 100%); display: flex; flex-direction: column; gap: 10px; padding: 18px 18px 14px; border-radius: 16px; background: #fff; color: #1d1d1f; box-shadow: 0 18px 50px rgba(0, 0, 0, .3); }
.ask-t { font-size: 15px; }
.ask-p { margin: 0; font-size: 13.5px; line-height: 1.55; color: #3c4043; }
.ask-in { height: 38px; padding: 0 10px; border: 1px solid rgba(0, 0, 0, .22); border-radius: 9px; font: inherit; font-size: 14px; color: #1d1d1f; background: #fff; }
.ask-in:focus { outline: 2px solid #2a78d6; outline-offset: 0; }
.ask-b { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.ask-b button { height: 34px; padding: 0 14px; border: 0; border-radius: 17px; font: inherit; font-size: 13.5px; color: #1d1d1f; background: rgba(0, 0, 0, .07); cursor: pointer; }
.ask-b button.primary { background: #2a78d6; color: #fff; font-weight: 600; }
.ask-b button.danger { background: rgba(200, 60, 50, .12); color: #b3261e; font-weight: 600; }
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
