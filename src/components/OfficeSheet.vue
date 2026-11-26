<script setup>
// A document the agent made, open for editing over the chat (hark opens documents in place, not as
// downloads). Saving in the editor makes the chat card point at the edited copy. The editor saves by
// itself (a pause in editing, the page going to the background, closing — OfficeEditorFrame autoSave),
// so an edit made on a phone is not lost; a shared folder's file opened from the chat (folder_open)
// is saved back into the folder too (server: POST /api/messages/:id/file).
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import OfficeEditorFrame from './OfficeEditorFrame.vue'
import CraftEditorFrame from './CraftEditorFrame.vue'
import CraftLiveOverlay from './CraftLiveOverlay.vue'
import { CRAFT_APPS, officeEditorFor, craftMissing } from '../officeEditor.js'
import { api, uploadAttachment, freshToken } from '../api.js'
import { useApp, onOfficeLeave } from '../stores/app.js'
import { openMailAttachment } from '../mailAttach.js'
import { rawUrl } from '../foldersApi.js'
import { useTeam } from '../stores/team.js'
import { isEnglish } from '../i18n/lang.js'

const app = useApp()
const team = useTeam()
const route = useRoute()
const router = useRouter()
// Mounted for every page (App.vue), so a document opened from the messenger, a meeting or a card opens wherever one is (it
// opened nothing on the process map before — 2026-11-24). The chat that talks to the open document is on the chat pages
// (views/MainView.vue): elsewhere (the map, folders) the editor's AI buttons take the person to the chat, the document staying
// open beside it and the request waiting in the box; the dial (maximized, phone) is the chat's.
const chatHere = computed(() => !!route.meta.mode && !route.meta.settings)
// a docked messenger (src/messengerDock.js): every document opens beside the page, a read-only one too, so the conversation
// and the page stay usable
const msgDocked = computed(() => team.open && team.dockNow !== 'float')
const maximized = ref(false)
const note = ref(null) // {kind, text} — what happened to a panel app's sheet after saving
// An ArtCraft app — and an editable IeumOffice document — opens beside the chat, not over it: the
// chat and its composer stay usable on the left (what is typed there edits the open app or document
// live, server/lib/craftLive.js · mcp/office.js); maximized, the chat folds into CraftLiveOverlay's dial.
const craft = computed(() => !!app.officeDoc && CRAFT_APPS.has(officeEditorFor(app.officeDoc.name || app.officeDoc.url)))
// a read-only preview stays a plain overlay (nothing to edit)
const office = computed(() => !!app.officeDoc && !craft.value && !app.officeDoc.readOnly)
// saving by itself: a shared folder's file this person may edit (folder_open's card). Not a panel app's
// sheet (its every save is applied as rows) and not other chat documents (each save of a received share
// is a commit on its branch) — those keep the editor's own 저장.
const autoSave = computed(() => office.value && !app.officeDoc.panelAppId && app.officeDoc.folder?.editable === true)
const craftTitle = computed(() => office.value ? '문서' : ({ cadcraft: 'CADCraft', vectorcraft: 'VectorCraft', photocraft: 'PhotoCraft', soundcraft: 'SoundCraft', filmcraft: 'FilmCraft' })[officeEditorFor(app.officeDoc?.name || app.officeDoc?.url || '')] || '')
const live = ref(false)
const linkFail = ref('') // the document's live link gave up (OfficeEditorFrame 'linkfail')
const side = computed(() => (craft.value || office.value || (msgDocked.value && !!app.officeDoc)) && !maximized.value)
const overlay = ref(null)
// a phone: the sheet is the whole screen with the chat behind it (and no 최대화), so the dial is
// the way to talk to the open document, as when maximized
const phoneMq = window.matchMedia?.('(max-width: 760px)')
const phone = ref(!!phoneMq?.matches)
const onPhone = (e) => (phone.value = e.matches)
phoneMq?.addEventListener?.('change', onPhone)
onBeforeUnmount(() => phoneMq?.removeEventListener?.('change', onPhone))
const dial = computed(() => chatHere.value && (craft.value || office.value) && (maximized.value || phone.value))
// The editor's own AI 도우미 (one assistant): its buttons come here. A preset (요약·다듬기…) is sent as
// a chat message about the open document; the 도우미 entry opens the same input — the dial's band
// when maximized, the chat composer beside it otherwise.
function assistant({ prompt, selection }) {
  if (prompt) {
    const sel = selection && !/선택/.test(prompt) ? selection : ''
    const text = sel ? `${prompt}\n\n(선택한 부분: "${sel.slice(0, 600)}")` : prompt
    // no chat on this page: the request waits in the chat's box (the person sends it there)
    if (!chatHere.value) { app.prefill = text; router.push('/chat'); return }
    app.send(text)
    return
  }
  if (dial.value) return overlay.value?.expand()
  if (selection) app.prefill = `선택한 부분 "${selection.slice(0, 120)}"을 `
  else app.focusTick++
  if (!chatHere.value) router.push('/chat')
}
// What is selected in the document, as it changes: a chip in the chat's composer that goes with the next message
// (src/docSelection.js) — the editor's own 「AI 수정 요청」 is hidden in this page, the chat is where the request is made
const selection = (s) => app.setDocSel(s, app.officeDoc?.name)
onBeforeUnmount(() => app.setDocSel(null))
// Click to mention: the editor tells what was pointed at; it waits in the input as a chip
function mention(m) {
  app.addMention(m)
  if (!chatHere.value) return router.push('/chat')
  if (dial.value) overlay.value?.expand()
  else app.focusTick++
}

// One assistant across apps: a request about a picture in a 한글 or Word document that changes the
// picture itself goes to PhotoCraft — the picture is taken out of the open document, opened live in
// PhotoCraft over the document (the agent and the dial edit it there), and "한글/워드 문서에 넣기" (or ⌘S)
// puts it back in place of the same picture. Requests that move or delete the picture stay with the
// document. Word pictures need an office host that answers for them (page-live.mjs 'pictures').
// Screen words stay Korean here (the English mode translates them, src/i18n); what the agent and the
// file names get is written in the screen's language.
const officeFrame = ref(null)
const picFrame = ref(null)
const pic = ref(null) // { url, name, n, docName, editor, pending }
const picLive = ref(false)
const NOT_IMAGE_EDIT = /(지워|삭제|빼\s*줘|없애|옮겨|위치|캡션|크기를\s*줄|문단|표\b)|\b(delete|remove|take (it )?out|move|position|caption|smaller|resize|paragraph|table)\b/i
const PIC_EDITORS = new Set(['hwp', 'docs'])
const docWord = (editor) => (editor === 'docs' ? '워드' : '한글')
function flash(kind, text, ms = 6000) { note.value = { kind, text }; setTimeout(() => { if (note.value?.text === text) note.value = null }, ms) }
async function openPicture(m, text) {
  const d = app.officeDoc
  flash('ok', `그림 ${m.image || 1}을 포토크래프트로 여는 중…`, 4000)
  const r = await officeFrame.value.picture(m.image || 1)
  const ext = /png/.test(r.media || r.name) ? 'png' : /gif/.test(r.media || r.name) ? 'gif' : 'jpg'
  const base = String(d.name || (isEnglish ? 'Document' : '문서')).replace(/\.[^.]+$/, '')
  const f = await uploadAttachment(new File([r.bytes], isEnglish ? `${base} picture ${r.n}.${ext}` : `${base} 그림 ${r.n}.${ext}`, { type: r.media || `image/${ext}` }))
  pic.value = { url: f.url, name: f.name, n: r.n, docName: d.name, editor: m.editor, label: m.label, pending: text, strokes: await strokeCount(r.bytes).catch(() => 0) }
}
// How much of a picture is drawn: pixels away from its background (the corner colour), every
// second pixel. A recolour that maps by brightness can drop strokes as dark as the background
// (a CAD plan's red furniture on its dark ground): fewer than 70% of the strokes left means redo.
async function strokeCount(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]))
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  const g = c.getContext('2d')
  g.drawImage(bmp, 0, 0)
  const { data } = g.getImageData(0, 0, bmp.width, bmp.height)
  const at = (x, y) => (y * bmp.width + x) * 4
  const b0 = at(3, 3)
  let n = 0
  for (let y = 0; y < bmp.height; y += 2) {
    for (let x = 0; x < bmp.width; x += 2) {
      const i = at(x, y)
      if (Math.abs(data[i] - data[b0]) + Math.abs(data[i + 1] - data[b0 + 1]) + Math.abs(data[i + 2] - data[b0 + 2]) > 60) n++
    }
  }
  return n
}
const MASK_RECOLOR = (ground, ink) => [
  ['select.all'], ['edit.fillHistory'], ['select.deselect'],
  ['select.magicWand', { x: 3, y: 3, tolerance: 14, contiguous: false, antiAlias: false }],
  ['edit.fill', { contents: 'color', color: ground }], ['select.inverse'], ['select.modify.expand', { radius: 1 }],
  ['edit.fill', { contents: 'color', color: ink }], ['select.deselect'],
]
let guarding = false
async function guardStrokes() {
  const p = pic.value
  if (!p?.strokes || guarding || !picFrame.value) return true
  guarding = true
  try {
    const now = await strokeCount(await picFrame.value.snapshot())
    const kept = now / p.strokes
    if (kept >= 0.7) return true
    // back to the picture as it came out of the document, then colour by distance from the background
    for (const [command, params] of MASK_RECOLOR('#eef5fc', '#1f3a6e')) await picFrame.value.request('engine.execute', { command, params: params || {} })
    const fixed = await strokeCount(await picFrame.value.snapshot())
    const text = `색을 바꾸면서 그림의 선이 ${Math.round(kept * 100)}%만 남아(바탕과 밝기가 비슷한 테이블 같은 선이 바탕에 묻혔어요) 되돌린 뒤 바탕색 기준으로 다시 칠했어요 — 선은 남색, 바탕은 하늘색이고 선이 원래의 ${Math.round((fixed / p.strokes) * 100)}%로 남았어요.`
    flash('ok', '선이 사라져서 바탕색 기준으로 다시 칠했어요', 6000)
    if (app.activeId) await api(`/threads/${app.activeId}/note`, { method: 'POST', body: { text } }).catch(() => {})
    return true
  } catch (e) { console.warn('[pic guard]', e.message); return true } finally { guarding = false }
}
// after each of the agent's answers while the picture is out, and before it goes back
watch(() => [...(app.thread || [])].reverse().find((m) => m.role === 'agent')?.id, (id, was) => { if (pic.value && id && was && id !== was) setTimeout(guardStrokes, 800) })
app.beforeSend = async (text, mentions) => {
  const m = mentions.find((x) => x.kind === 'image' && PIC_EDITORS.has(x.editor))
  // no PhotoCraft in this install, or an office host that cannot hand out Word pictures: the request stays with the document
  if (!m || !office.value || pic.value || NOT_IMAGE_EDIT.test(text) || craftMissing('photocraft') || !officeFrame.value?.canPictures(m.editor)) return false
  try { await openPicture(m, text); return true } catch (e) { flash('err', `그림을 꺼내지 못했어요: ${e.message}`); return false }
}
// PhotoCraft joined the chat: now the request goes, about the picture open there
watch(picLive, (on) => {
  const p = pic.value
  if (!on || !p?.pending) return
  const text = p.pending
  p.pending = null
  const kind = p.editor === 'docs' ? 'Word' : 'Hangul'
  app.send(`@${p.label} ${text}`, undefined, isEnglish
    ? `(This request is about picture ${p.n} of the ${kind} document '${p.docName}'. That picture is open in PhotoCraft now as '${p.name}': edit it in the open PhotoCraft. When it is done, the user puts it back in the document with 'Put in ${kind} document'.)`
    : `(이 요청은 ${docWord(p.editor)} 문서 '${p.docName}' 의 그림 ${p.n} 에 대한 것이에요. 그 그림을 지금 포토크래프트에 '${p.name}' 으로 열어 두었으니 열린 포토크래프트에서 고치세요. 다 고치면 사용자가 '${docWord(p.editor)} 문서에 넣기' 로 문서에 다시 넣어요.)`)
})
async function putBack() {
  const p = pic.value
  if (!p || p.putting) return
  p.putting = true
  try {
    await guardStrokes()
    const bytes = await picFrame.value.snapshot()
    await officeFrame.value.replacePicture(p.n, bytes, p.docName)
    // 검수 of the round trip, kept for the document's edited-copy card
    const kept = p.strokes ? Math.round(((await strokeCount(bytes).catch(() => 0)) / p.strokes) * 100) : null
    api('/reviews', { method: 'POST', body: { file: p.docName, ok: kept == null || kept >= 70, summary: `검수: 그림 ${p.n}을 포토크래프트에서 고쳐 같은 자리에 넣음${kept != null ? ` · 선 ${kept}% 유지` : ''}${kept == null || kept >= 70 ? ' ✓' : ' ⚠'}` } }).catch(() => {})
    pic.value = null
    flash('ok', `고친 그림을 ${docWord(p.editor)} 문서의 그림 ${p.n} 자리에 넣었어요 · ⌘S 로 저장하세요`, 7000)
  } catch (e) { p.putting = false; flash('err', `그림을 문서에 넣지 못했어요: ${e.message}`) }
}
onBeforeUnmount(() => { if (app.beforeSend) app.beforeSend = null })

const dockWas = app.dockOpen
watch([side, craft], ([on, isCraft]) => {
  document.body.classList.toggle('craft-side', on)
  document.body.classList.toggle('doc-side', on && !isCraft)
  app.docSide = on && !phone.value
  if (on) app.dockOpen = false
}, { immediate: true })
watch(phone, (p) => { app.docSide = side.value && !p })
onBeforeUnmount(() => { document.body.classList.remove('craft-side', 'doc-side'); app.docSide = false; if (craft.value || office.value) app.dockOpen = dockWas })

// a panel app's spreadsheet (lib/panelApps): the saved copy becomes the folder's file
async function savedPanelSheet(url) {
  const d = app.officeDoc
  try {
    const r = await api(`/panel-apps/${d.panelAppId}/sheet-saved`, { method: 'POST', body: { url, sha: d.sha } })
    app.officeDoc = { ...d, url, sha: r.sha }
    // a db/event app applies what this person may change and says what it refused
    const no = r.rejected || []
    const head = r.changed || !no.length ? `'${d.title}' 패널에 반영했어요${r.changed ? ` · ${r.changed}건` : ''}` : `'${d.title}'에 반영할 새 기록이 없어요`
    note.value = { kind: no.length ? 'err' : 'ok', text: `${head}${no.length ? ` · 거절 ${no.length}건: ${no[0].row} — ${no[0].reason}` : ''}` }
  } catch (e) { note.value = { kind: 'err', text: e.message } }
  setTimeout(() => (note.value = null), 6000)
}

// one opening of a card is one editing session (its saves are one line in the folder's 이력)
const newSession = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
let session = newSession()
let savedChain = Promise.resolve()
let lastFail = null // a folder save that did not go through: tried again before the sheet closes
let lastFailWhy = ''
// a save of a private card that did not reach my card (a mail's attachment: its first save makes the card, later ones keep it on the newest
// copy) — {job, why, mail, key}: 「내려받기」 tries it again and, if it still fails, offers the version the card stands on
let cardFail = null
// which document a save was for: its card, else the mail's attachment it opened from
const docKey = (d) => d?.msgId || (d?.mailAtt ? `${d.mailAtt.actionId}:${d.mailAtt.i}` : '')
let closeArmed = false
watch(() => app.officeDoc?.msgId, () => { session = newSession(); lastFail = null; cardFail = null; closeArmed = false })
// A mail's attachment opened from its own private copy (src/mailAttach.js — not a folder's: that one is the folder's file above): its first
// save becomes my own private file card in my chat (server lib/mailAttachments.js saved), later saves keep that card on the newest copy.
// No address is ever put on it — the sheet keeps the signed one it opened with.
// (the editor's own 「저장했어요. 편집본이 원본 옆에」 is not said: this sheet says where it went)
const quietSave = computed(() => !!app.officeDoc?.private && !app.officeDoc.folder)
async function savedMailAtt(job) {
  const d = app.officeDoc
  const att = d?.mailAtt
  try {
    const r = await api(`/mail/attachments/${encodeURIComponent(att.actionId)}/${att.i}/saved`, { method: 'POST', body: { session: job.sid } })
    cardFail = null
    if (app.officeDoc === d) app.officeDoc = { ...d, msgId: r.message.id }
    flash('ok', '편집본을 내 채팅에 파일로 저장했어요 · 나만 볼 수 있어요', 6000)
  } catch (e) { cardFail = { job, why: e.message, mail: true, key: docKey(d) }; flash('err', `편집본을 저장하지 못했어요: ${e.message}`, 8000) }
}
function saved({ url, name }) {
  if (url && app.officeDoc?.panelAppId) return savedPanelSheet(url)
  if (url && app.officeDoc?.mailAtt && !app.officeDoc.msgId) {
    const job = { url, name, sid: session }
    savedChain = savedChain.then(() => savedMailAtt(job))
    return savedChain
  }
  if (!url || !app.officeDoc?.msgId) return
  const job = { id: app.officeDoc.msgId, url, name, sid: session }
  savedChain = savedChain.then(() => postSave(job))
  return savedChain
}
async function postSave(job) {
  const m = await api(`/messages/${job.id}/file`, { method: 'POST', body: { url: job.url, name: job.name, session: job.sid } }).catch((e) => ({ error: e.message }))
  const fs = m?.content?.folder_save
  const failed = m?.error != null ? m.error : fs && !fs.ok ? fs.error || '' : null
  const here = app.officeDoc?.msgId === job.id
  lastFail = failed != null && (here ? app.officeDoc.folder : true) ? job : null
  lastFailWhy = lastFail ? failed || '' : ''
  if (here && app.officeDoc.private && !app.officeDoc.folder) cardFail = failed != null ? { job, why: failed || '', key: job.id } : null
  if (!here) return
  // (a private card keeps the signed address it opened with: an editor's saved address is never one to load from — server lib/mailAttachments.js)
  if (m?.error == null) app.officeDoc = { ...app.officeDoc, url: app.officeDoc.private ? app.officeDoc.url : job.url, name: job.name || app.officeDoc.name, ...(m?.content?.folder ? { folder: m.content.folder } : {}) }
  // a mail's attachment edited outside a folder: where the save went
  if (app.officeDoc.private && !app.officeDoc.folder) {
    if (failed != null) flash('err', `편집본을 저장하지 못했어요: ${failed}`, 8000)
    else flash('ok', '편집본을 내 채팅의 파일에 저장했어요 · 나만 볼 수 있어요', 3500)
    return
  }
  // a shared folder's file: say where the save went
  if (!app.officeDoc.folder) return
  if (failed != null) flash('err', `폴더에 저장하지 못했어요: ${failed}`, 8000)
  else if (fs?.copied) flash('warn', `다른 사람이 먼저 고쳐서, 내 수정은 「${String(fs.path).split('/').pop()}」로 따로 저장했어요.`, 9000)
  else if (fs) flash('ok', `「${m.content.folder?.name || '공유'}」 폴더에 저장했어요 · 이력에 남았어요`, 3500)
}
// Before the document is closed or replaced (closing, another card, the meeting's back — app.setOfficeDoc):
// what is left is saved and a folder save that failed is tried again. When that does not work the sheet
// stays open once and says so; a second close leaves anyway.
async function leave() {
  if (closeArmed) return true
  const f = officeFrame.value
  let r = { clean: true }
  if (autoSave.value && !pic.value && f?.flush && (f.edited || f.saving)) {
    flash('info', '닫기 전에 저장하는 중…', 25000)
    r = await f.flush(20000)
  }
  await savedChain
  if (lastFail) { const job = lastFail; savedChain = savedChain.then(() => postSave(job)); await savedChain }
  if (r.timeout || r.error || lastFail) {
    closeArmed = true
    flash('err', `${lastFail ? '폴더에 저장하지 못했어요' : '저장을 마치지 못했어요'}. 한 번 더 닫으면 저장하지 않고 닫아요.`, 8000)
    return false
  }
  return true
}
async function closeDoc() { if (await leave()) app.officeDoc = null }
// 「내려받기」 (spec file-download): after the editor's own upload, did the save also land where the card keeps it — the folder's commit, my
// private card? A save that did not is tried once more; still failing, it is not called 「방금 저장한 판」: the last saved version is offered.
async function saveLanded() {
  await savedChain
  // (only this document's: a save of a document closed meanwhile is the close's business)
  const mine = () => lastFail && lastFail.id === app.officeDoc?.msgId
  const card = () => (cardFail && cardFail.key === docKey(app.officeDoc) ? cardFail : null)
  if (mine()) { const job = lastFail; savedChain = savedChain.then(() => postSave(job)); await savedChain }
  if (card()) { const f = cardFail; savedChain = savedChain.then(() => (f.mail ? savedMailAtt(f.job) : postSave(f.job))); await savedChain }
  if (mine()) return { ok: false, why: lastFailWhy || '폴더에 저장하지 못했어요' }
  if (card()) return { ok: false, why: card().why || '편집본을 저장하지 못했어요' }
  return { ok: true }
}
// what 「내려받기」 saves, once the saves in flight are through: a folder's document from the folder's main (a save commits to it; a failed
// one does not — that is then the last saved version); a private card (a mail's attachment, its edit) never by the
// address the sheet opened with (a signed address of the copy as it arrived, ten minutes long) nor the editor's own saved address — a fresh
// signed one of the card (its edited copy, once a save made one) or of the mail's attachment itself. Anything else: the frame's own (null).
async function docDownload() {
  await savedChain
  const d = app.officeDoc
  if (!d) return null
  if (d.folder?.slug && d.folder.path) {
    await freshToken()
    // (main's file: the card's sha is the version's blob, not a commit — a save that did not reach the folder left main as it was)
    return { url: rawUrl(d.folder.slug, d.folder.path, 'main', true), name: d.folder.path.split('/').pop() }
  }
  if (!d.private) return null
  if (d.msgId) {
    const c = await api(`/messages/${encodeURIComponent(d.msgId)}/open-file`, { method: 'POST' })
    return { url: c.url, name: d.name || c.name }
  }
  if (d.mailAtt) {
    const r = await openMailAttachment(app, d.mailAtt, { download: true })
    return { url: r.url, name: d.name || r.name }
  }
  return { url: d.url, name: d.name }
}
onOfficeLeave(leave)
onBeforeUnmount(() => onOfficeLeave(null))
</script>

<template>
  <div class="veil office-sheet" :class="{ max: maximized, side }" data-test="office-sheet" @click.self="!side && !maximized && closeDoc()">
    <div class="sheet glass" :class="{ max: maximized }">
      <CraftEditorFrame v-if="CRAFT_APPS.has(officeEditorFor(app.officeDoc.name || app.officeDoc.url))" :file-url="app.officeDoc.url" :name="app.officeDoc.name"
        v-model:maximized="maximized" @saved="saved" @close="app.officeDoc = null" @live="(v) => (live = v)" />
      <OfficeEditorFrame v-else ref="officeFrame" :file-url="app.officeDoc.url" :name="app.officeDoc.name" :context="app.officeDoc.context" :read-only="!!app.officeDoc.readOnly"
        :assistant="office" :auto-save="autoSave" :quiet-save="quietSave" :download="docDownload" :save-check="saveLanded" v-model:maximized="maximized"
        @saved="saved" @close="closeDoc" @live="(v) => (live = v)" @linkfail="(w) => (linkFail = w)" @assistant="assistant" @mention="mention" @selection="selection" />
      <!-- a picture of the document, out for editing in PhotoCraft (over the document, which stays open below) -->
      <Transition name="pic">
        <div v-if="pic" class="pic">
          <div class="pic-tag">{{ docWord(pic.editor) }} 문서 · 그림 {{ pic.n }}</div>
          <CraftEditorFrame ref="picFrame" :file-url="pic.url" :name="pic.name" :return-label="`${docWord(pic.editor)} 문서에 넣기`" :download="false"
            @return="putBack" @saved="putBack" @close="pic = null" @live="(v) => (picLive = v)" />
        </div>
      </Transition>
      <CraftLiveOverlay v-if="dial" ref="overlay" :title="pic ? 'PhotoCraft' : craftTitle" :live="pic ? picLive : live"
        :doc="office && !pic" :link-fail="linkFail" @reconnect="officeFrame?.reconnect()" />
      <Transition name="fade"><div v-if="note" class="pnote" :class="note.kind">{{ note.text }}</div></Transition>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 40; background: rgba(20, 24, 32, .18); display: flex; justify-content: flex-end; align-items: stretch; padding: 76px 16px 16px; }
.sheet { width: min(1080px, 72vw); border-radius: 22px; overflow: hidden; display: flex; box-shadow: 0 18px 60px rgba(0, 0, 0, .22); transition: width .25s, margin .25s; }
/* maximized: the whole window, edge to edge, so the document gets every pixel of height */
.veil.max { padding: 0; }
.sheet { position: relative; }
.pnote { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 9px 16px; border-radius: 10px; font-size: 14px; color: #fff; background: #1d1d1f; box-shadow: 0 4px 16px rgba(0, 0, 0, .25); white-space: nowrap; }
.pnote.err { background: #c62828; }
.pnote.ok { background: #2e7d32; }
.pnote.warn { background: #a86400; white-space: normal; max-width: 86%; }
.pnote.info { background: #455a64; }
.pnote { z-index: 6; }
/* PhotoCraft over the 한글/Word document: the document's left edge stays in sight, dimmed */
.pic { position: absolute; inset: 44px 0 0 16%; z-index: 4; display: flex; border-radius: 16px 0 0 0; overflow: hidden; box-shadow: -18px 0 50px rgba(0, 0, 0, .35); }
.pic::before { content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none; }
.pic-tag { position: absolute; left: 12px; bottom: 12px; z-index: 3; padding: 4px 10px; border-radius: 10px; font-size: 12px; color: #fff; background: rgba(110, 90, 230, .85); pointer-events: none; }
.pic-enter-active, .pic-leave-active { transition: transform .45s var(--spring), opacity .3s; }
.pic-enter-from, .pic-leave-to { transform: translateX(40%); opacity: 0; }
.sheet.max { width: 100%; border-radius: 0; box-shadow: none; }
/* an ArtCraft app beside the chat: clicks reach the chat column; the chat dims a little */
.veil.side { pointer-events: none; background: linear-gradient(to right, rgba(20, 24, 32, .07), rgba(20, 24, 32, .07) calc(100% - var(--craft-side-w)), transparent 0); }
.veil.side .sheet { pointer-events: auto; width: calc(var(--craft-side-w) - 32px); }
/* a phone: the sheet is the whole width even beside the chat (the .side width rule above would win otherwise and push the bar's close button off screen) */
@media (max-width: 760px) { .veil { padding: 60px 0 0; } .sheet, .veil.side .sheet { width: 100%; border-radius: 18px 18px 0 0; } .veil.side { pointer-events: auto; background: rgba(20, 24, 32, .18); } }
</style>

<style>
/* the chat column shares the window with an ArtCraft app open beside it (OfficeSheet .side): the panel's width. The chat pages
   (views/MainView.vue) put the chat left of it, and the left column beside the chat or folded to its rail (src/leftColumn.js) —
   this rule used to set the chat's left edge to the window's, on top of a project · routine list (2026-11-24) */
:root { --craft-side-w: min(840px, 64vw); }
/* a page of a document wants a little more width than an app's canvas */
body.doc-side { --craft-side-w: min(960px, 70vw); }
/* A docked team messenger (src/messengerDock.js) takes a column from the page (App.vue .page): the panel's width follows the
   page, not the window. In the panel dock the messenger sits in this panel beside the document — the panel grows by its width
   and the document leaves it the panel's right part. */
html[data-msgdock] body { --craft-side-w: min(840px, 64cqw); }
html[data-msgdock] body.doc-side { --craft-side-w: min(960px, 70cqw); }
html[data-msgdock-panel] body.craft-side { --craft-side-w: min(calc(840px + var(--msgdock-w)), 72cqw); }
html[data-msgdock-panel] body.doc-side { --craft-side-w: min(calc(960px + var(--msgdock-w)), 72cqw); }
html[data-msgdock-panel] .office-sheet.side .sheet { padding-right: var(--msgdock-w); transition: padding .35s var(--spring), width .25s; }
html[data-msgdock-panel] .office-sheet.side .pic { right: var(--msgdock-w); }
</style>
