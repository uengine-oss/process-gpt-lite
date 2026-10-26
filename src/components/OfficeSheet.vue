<script setup>
// A document the agent made, open for editing over the chat (hark opens documents in place, not as
// downloads). Saving in the editor makes the chat card point at the edited copy.
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import OfficeEditorFrame from './OfficeEditorFrame.vue'
import CraftEditorFrame from './CraftEditorFrame.vue'
import CraftLiveOverlay from './CraftLiveOverlay.vue'
import { CRAFT_APPS, officeEditorFor, craftMissing } from '../officeEditor.js'
import { api, uploadAttachment } from '../api.js'
import { useApp } from '../stores/app.js'

const app = useApp()
const maximized = ref(false)
const note = ref(null) // {kind, text} — what happened to a panel app's sheet after saving
// An ArtCraft app — and an editable IeumOffice document — opens beside the chat, not over it: the
// chat and its composer stay usable on the left (what is typed there edits the open app or document
// live, server/lib/craftLive.js · mcp/office.js); maximized, the chat folds into CraftLiveOverlay's dial.
const craft = computed(() => !!app.officeDoc && CRAFT_APPS.has(officeEditorFor(app.officeDoc.name || app.officeDoc.url)))
// a read-only preview stays a plain overlay (nothing to edit)
const office = computed(() => !!app.officeDoc && !craft.value && !app.officeDoc.readOnly)
const craftTitle = computed(() => office.value ? '문서' : ({ cadcraft: 'CADCraft', vectorcraft: 'VectorCraft', photocraft: 'PhotoCraft', soundcraft: 'SoundCraft', filmcraft: 'FilmCraft' })[officeEditorFor(app.officeDoc?.name || app.officeDoc?.url || '')] || '')
const live = ref(false)
const side = computed(() => (craft.value || office.value) && !maximized.value)
const overlay = ref(null)
// The editor's own AI 도우미 (one assistant): its buttons come here. A preset (요약·다듬기…) is sent as
// a chat message about the open document; the 도우미 entry opens the same input — the dial's band
// when maximized, the chat composer beside it otherwise.
function assistant({ prompt, selection }) {
  if (prompt) {
    const sel = selection && !/선택/.test(prompt) ? selection : ''
    app.send(sel ? `${prompt}\n\n(선택한 부분: "${sel.slice(0, 600)}")` : prompt)
    return
  }
  if (maximized.value) return overlay.value?.expand()
  if (selection) app.prefill = `선택한 부분 "${selection.slice(0, 120)}"을 `
  else app.focusTick++
}
// Click to mention: the editor tells what was pointed at; it waits in the input as a chip
function mention(m) {
  app.addMention(m)
  if (maximized.value) overlay.value?.expand()
  else app.focusTick++
}

// One assistant across apps: a request about a 한글 picture that changes the picture itself goes to
// PhotoCraft — the picture is taken out of the open document, opened live in PhotoCraft over the
// document (the agent and the dial edit it there), and "한글 문서에 넣기" (or ⌘S) puts it back in
// place of the same picture. Requests that move or delete the picture stay with the document.
const officeFrame = ref(null)
const picFrame = ref(null)
const pic = ref(null) // { url, name, n, docName, pending }
const picLive = ref(false)
const NOT_IMAGE_EDIT = /(지워|삭제|빼\s*줘|없애|옮겨|위치|캡션|크기를\s*줄|문단|표\b)/
function flash(kind, text, ms = 6000) { note.value = { kind, text }; setTimeout(() => { if (note.value?.text === text) note.value = null }, ms) }
async function openPicture(m, text) {
  const d = app.officeDoc
  flash('ok', `그림 ${m.image || 1}을 포토크래프트로 여는 중…`, 4000)
  const r = await officeFrame.value.picture(m.image || 1)
  const ext = /png/.test(r.media || r.name) ? 'png' : 'jpg'
  const base = String(d.name || '문서').replace(/\.[^.]+$/, '')
  const f = await uploadAttachment(new File([r.bytes], `${base} 그림 ${r.n}.${ext}`, { type: r.media || `image/${ext}` }))
  pic.value = { url: f.url, name: f.name, n: r.n, docName: d.name, label: m.label, pending: text, strokes: await strokeCount(r.bytes).catch(() => 0) }
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
  const m = mentions.find((x) => x.kind === 'image' && x.editor === 'hwp')
  // no PhotoCraft in this install: the request stays with the document
  if (!m || !office.value || pic.value || NOT_IMAGE_EDIT.test(text) || craftMissing('photocraft')) return false
  try { await openPicture(m, text); return true } catch (e) { flash('err', `그림을 꺼내지 못했어요: ${e.message}`); return false }
}
// PhotoCraft joined the chat: now the request goes, about the picture open there
watch(picLive, (on) => {
  const p = pic.value
  if (!on || !p?.pending) return
  const text = p.pending
  p.pending = null
  app.send(`@${p.label} ${text}`, undefined, `(이 요청은 한글 문서 '${p.docName}' 의 그림 ${p.n} 에 대한 것이에요. 그 그림을 지금 포토크래프트에 '${p.name}' 으로 열어 두었으니 열린 포토크래프트에서 고치세요. 다 고치면 사용자가 '한글 문서에 넣기' 로 문서에 다시 넣어요.)`)
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
    flash('ok', `고친 그림을 한글 문서의 그림 ${p.n} 자리에 넣었어요 · ⌘S 로 저장하세요`, 7000)
  } catch (e) { p.putting = false; flash('err', `그림을 문서에 넣지 못했어요: ${e.message}`) }
}
onBeforeUnmount(() => { if (app.beforeSend) app.beforeSend = null })

const dockWas = app.dockOpen
watch([side, office], ([on, doc]) => {
  document.body.classList.toggle('craft-side', on)
  document.body.classList.toggle('doc-side', on && doc)
  if (on) app.dockOpen = false
}, { immediate: true })
onBeforeUnmount(() => { document.body.classList.remove('craft-side', 'doc-side'); if (craft.value || office.value) app.dockOpen = dockWas })

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

async function saved({ url, name }) {
  if (url && app.officeDoc?.panelAppId) return savedPanelSheet(url)
  if (!url || !app.officeDoc?.msgId) return
  await api(`/messages/${app.officeDoc.msgId}/file`, { method: 'POST', body: { url, name } }).catch(() => {})
  app.officeDoc = { ...app.officeDoc, url, name: name || app.officeDoc.name }
}
</script>

<template>
  <div class="veil" :class="{ max: maximized, side }" @click.self="!side && !maximized && (app.officeDoc = null)">
    <div class="sheet glass" :class="{ max: maximized }">
      <CraftEditorFrame v-if="CRAFT_APPS.has(officeEditorFor(app.officeDoc.name || app.officeDoc.url))" :file-url="app.officeDoc.url" :name="app.officeDoc.name"
        v-model:maximized="maximized" @saved="saved" @close="app.officeDoc = null" @live="(v) => (live = v)" />
      <OfficeEditorFrame v-else ref="officeFrame" :file-url="app.officeDoc.url" :name="app.officeDoc.name" :context="app.officeDoc.context" :read-only="!!app.officeDoc.readOnly"
        :assistant="office" v-model:maximized="maximized" @saved="saved" @close="app.officeDoc = null" @live="(v) => (live = v)" @assistant="assistant" @mention="mention" />
      <!-- a picture of the document, out for editing in PhotoCraft (over the document, which stays open below) -->
      <Transition name="pic">
        <div v-if="pic" class="pic">
          <div class="pic-tag">한글 문서 · 그림 {{ pic.n }}</div>
          <CraftEditorFrame ref="picFrame" :file-url="pic.url" :name="pic.name" return-label="한글 문서에 넣기"
            @return="putBack" @saved="putBack" @close="pic = null" @live="(v) => (picLive = v)" />
        </div>
      </Transition>
      <CraftLiveOverlay v-if="(craft || office) && maximized" ref="overlay" :title="pic ? 'PhotoCraft' : craftTitle" :live="pic ? picLive : live" />
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
.pnote { z-index: 6; }
/* PhotoCraft over the 한글 document: the document's left edge stays in sight, dimmed */
.pic { position: absolute; inset: 44px 0 0 16%; z-index: 4; display: flex; border-radius: 16px 0 0 0; overflow: hidden; box-shadow: -18px 0 50px rgba(0, 0, 0, .35); }
.pic::before { content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none; }
.pic-tag { position: absolute; left: 12px; bottom: 12px; z-index: 3; padding: 4px 10px; border-radius: 10px; font-size: 12px; color: #fff; background: rgba(110, 90, 230, .85); pointer-events: none; }
.pic-enter-active, .pic-leave-active { transition: transform .45s var(--spring), opacity .3s; }
.pic-enter-from, .pic-leave-to { transform: translateX(40%); opacity: 0; }
.sheet.max { width: 100%; border-radius: 0; box-shadow: none; }
/* an ArtCraft app beside the chat: clicks reach the chat column; the chat dims a little */
.veil.side { pointer-events: none; background: linear-gradient(to right, rgba(20, 24, 32, .07), rgba(20, 24, 32, .07) calc(100% - var(--craft-side-w)), transparent 0); }
.veil.side .sheet { pointer-events: auto; width: calc(var(--craft-side-w) - 32px); }
@media (max-width: 760px) { .veil { padding: 60px 0 0; } .sheet { width: 100%; border-radius: 18px 18px 0 0; } }
</style>

<style>
/* the chat column shares the window with an ArtCraft app open beside it (OfficeSheet .side) */
:root { --craft-side-w: min(840px, 64vw); }
/* a page of a document wants a little more width than an app's canvas */
body.doc-side { --craft-side-w: min(960px, 70vw); }
body.craft-side .main .center { right: var(--craft-side-w); left: 0; transition: right .4s var(--spring), left .4s var(--spring); }
body.craft-side .main .clock { display: none; }
@media (max-width: 760px) { body.craft-side .main .center { right: 0; } }
</style>
