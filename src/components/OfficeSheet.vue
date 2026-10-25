<script setup>
// A document the agent made, open for editing over the chat (hark opens documents in place, not as
// downloads). Saving in the editor makes the chat card point at the edited copy.
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import OfficeEditorFrame from './OfficeEditorFrame.vue'
import CraftEditorFrame from './CraftEditorFrame.vue'
import CraftLiveOverlay from './CraftLiveOverlay.vue'
import { CRAFT_APPS, officeEditorFor } from '../officeEditor.js'
import { api } from '../api.js'
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
      <OfficeEditorFrame v-else :file-url="app.officeDoc.url" :name="app.officeDoc.name" :context="app.officeDoc.context" :read-only="!!app.officeDoc.readOnly"
        :assistant="office" v-model:maximized="maximized" @saved="saved" @close="app.officeDoc = null" @live="(v) => (live = v)" @assistant="assistant" />
      <CraftLiveOverlay v-if="(craft || office) && maximized" ref="overlay" :title="craftTitle" :live="live" />
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
