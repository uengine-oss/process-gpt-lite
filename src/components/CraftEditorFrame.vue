<script setup>
// An ArtCraft web app (CADCraft · VectorCraft · PhotoCraft · SoundCraft · FilmCraft) in an iframe,
// the way OfficeEditorFrame hosts IeumOffice. The self-hosted WebAssembly builds are served at
// /craft/<app>/ on this origin, so this page can reach into the frame:
// - CADCraft has a postMessage bridge (?host=parent): <app>:ready → we send <app>:open{name, bytes};
//   SAVE comes back as <app>:save{name, bytes}; <app>:dirty{dirty}; <app>:failed{error}.
// - The others take the file through their page API (window.vectorcraft.openFile,
//   window.filmcraft.importFiles) or a file dropped on the canvas, and save as browser downloads,
//   which we catch inside the frame (the blob behind the download link) instead of letting them go.
// A save in the app's own formats becomes the card's edited copy; anything else (exports) is
// uploaded and offered as a link.
// Live co-editing (server/lib/craftLive.js, src/liveLink.js): once the file is open, every app's page
// API (window.<app>.request(method, params): PhotoCraft · CADCraft · SoundCraft through local patches
// in artcraft/patches, VectorCraft · FilmCraft built in) is joined to the server over a websocket;
// the agent's tool calls arrive as control requests, run on this window, and the replies go back —
// so the person watches the agent's edits land here.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import ShareButton from './team/ShareButton.vue'
import { uploadAttachment } from '../api.js'
import { openLiveLink } from '../liveLink.js'
import { officeEditorFor } from '../officeEditor.js'
import { BASE } from '../base.js'

const props = defineProps({
  fileUrl: { type: String, default: '' },
  name: { type: String, default: '' },
  maximized: { type: Boolean, default: false },
  // opened from a document to edit one of its pictures (OfficeSheet): a button hands the result back
  returnLabel: { type: String, default: '' },
})
const emit = defineEmits(['saved', 'error', 'update:maximized', 'close', 'live', 'return'])

function drop(w, file) {
  const canvas = w.document.querySelector('canvas')
  const r = canvas.getBoundingClientRect()
  const dt = new w.DataTransfer()
  dt.items.add(file)
  for (const type of ['dragenter', 'dragover', 'drop']) {
    canvas.dispatchEvent(new w.DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.width / 2, clientY: r.height / 2 }))
  }
}
// query: how each app starts (empty, no demo); ready: the frame can take a file; open: hand it over
const APPS = {
  cadcraft: { title: 'CADCraft', query: '?host=parent', bridge: true },
  vectorcraft: {
    title: 'VectorCraft', query: '?lang=ko', ready: (w) => !!w.vectorcraft,
    open: (w, file, bytes) => w.vectorcraft.openFile(file.name, new Uint8Array(bytes)),
  },
  photocraft: { title: 'PhotoCraft', query: '', ready: (w) => !w.document.getElementById('photocraft_loading'), open: (w, file) => drop(w, file) },
  soundcraft: { title: 'SoundCraft', query: '?empty', save: '⌘⌥B 로 내보내기', ready: (w) => !w.document.getElementById('soundcraft_loading'), open: (w, file) => drop(w, file) },
  filmcraft: {
    title: 'FilmCraft', query: '?empty&fresh', ready: (w) => !!w.filmcraft,
    // imported clips only land in the bin: put them on a timeline of their own, ready to cut
    open: async (w, file) => {
      const r = await w.filmcraft.importFiles([file])
      if (r?.items?.length) await w.filmcraft.execute('file.newSequenceFromClip', { items: r.items })
    },
  },
}

const root = ref(null)
const frame = ref(null)
const frameSrc = ref('')
const notice = ref(null)
const dirty = ref(false)
const fullscreen = ref(false)
let timer = null
let wait = null
const savedUrls = new Set()
// live co-editing
const LIVE = new Set(['photocraft', 'vectorcraft', 'filmcraft', 'cadcraft', 'soundcraft'])
const READS = /^(ui\.inspect|ui\.elements|ui\.render|engine\.commands|ui\.screenshot|jobs\.list|ui\.menu\.list|cmdline\.state|control\.methods|ping)$|inspect|render|find_text|query/i
const live = ref(false)
const busy = ref(0)
let link = null
let alive = true
const appName = () => officeEditorFor(props.name || props.fileUrl)
const app = computed(() => APPS[appName()] || null)

function load() {
  stopLive()
  dirty.value = false
  clearTimeout(wait)
  frameSrc.value = app.value ? `${BASE}/craft/${appName()}/${app.value.query}` : ''
}
function show(kind, text, link) {
  clearTimeout(timer)
  notice.value = { kind, text, link }
  timer = setTimeout(() => (notice.value = null), kind === 'error' || link ? 9000 : 2500)
}
async function documentBytes() {
  const r = await fetch(props.fileUrl)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.arrayBuffer()
}
// CADCraft: the app asked for the drawing
async function sendDocument() {
  try {
    const bytes = await documentBytes()
    frame.value?.contentWindow?.postMessage({ type: `${appName()}:open`, name: props.name || 'Drawing.dxf', bytes }, location.origin, [bytes])
  } catch (e) { show('error', `파일을 불러오지 못했어요: ${e.message}`); emit('error', e.message) }
}
// the others: wait until the app runs, then hand the file over and catch its downloads
function onFrameLoad() {
  const a = app.value
  if (!a || a.bridge) return
  const w = frame.value?.contentWindow
  let tries = 0
  const poll = async () => {
    try {
      if (w?.document.querySelector('canvas') && a.ready(w)) {
        catchDownloads(w)
        // a moment for the first frames, or a dropped file lands before the canvas listens
        await new Promise((r) => setTimeout(r, 1500))
        const bytes = await documentBytes()
        await a.open(w, new w.File([bytes], props.name || 'file'), bytes)
        startLive()
        return
      }
    } catch (e) { show('error', `파일을 열지 못했어요: ${e.message}`); emit('error', e.message); return }
    if (++tries < 240) wait = setTimeout(poll, 500)
    else show('error', '편집기가 시작되지 않았어요.')
  }
  poll()
}
function catchDownloads(w) {
  const blobs = new Map()
  const create = w.URL.createObjectURL.bind(w.URL)
  w.URL.createObjectURL = (obj) => { const url = create(obj); if (obj instanceof w.Blob) blobs.set(url, obj); return url }
  const click = w.HTMLAnchorElement.prototype.click
  w.HTMLAnchorElement.prototype.click = function () {
    const blob = blobs.get(this.href)
    if (!this.download || !blob) return click.call(this)
    blob.arrayBuffer().then((bytes) => onSave({ name: this.download, bytes }))
  }
}
function startLive() {
  const name = appName()
  const w = frame.value?.contentWindow
  if (!alive || !LIVE.has(name) || link || !w?.[name]?.request) return
  link = openLiveLink({
    app: name, file: props.name, alive: () => alive && !!frame.value,
    onState: (on) => { live.value = on; if (!on) busy.value = 0; emit('live', on) },
    onCall: async (method, params) => {
      busy.value++
      try {
        const fw = frame.value?.contentWindow
        if (!fw?.[name]?.request) throw new Error('the app is not running in the page')
        const result = await fw[name].request(method, params)
        if (!READS.test(method) && !READS.test(params?.command || '')) dirty.value = true
        return result
      } finally { busy.value-- }
    },
  })
}
// the open document as PNG (PhotoCraft renders it for ui.screenshot on the web: api.rs)
async function snapshot() {
  const w = frame.value?.contentWindow
  const name = appName()
  if (!w?.[name]?.request) throw new Error('앱이 아직 열리지 않았어요')
  const r = await w[name].request('ui.screenshot', {})
  const b64 = r?.base64 || r?.png_base64 || r?.pngBase64
  if (!b64) throw new Error('이미지를 받지 못했어요')
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}
// a control request on the open app (OfficeSheet's recolour guard)
async function request(method, params = {}) {
  const w = frame.value?.contentWindow
  const name = appName()
  if (!w?.[name]?.request) throw new Error('앱이 아직 열리지 않았어요')
  const r = await w[name].request(method, params)
  if (!READS.test(method) && !READS.test(params?.command || '')) dirty.value = true
  return r
}
defineExpose({ snapshot, request })
function stopLive() {
  link?.close()
  link = null
  live.value = false
}
async function onSave({ name, bytes }) {
  // FilmCraft's export adds the extension to a name that already has it ("a.mp4.mp4")
  name = String(name || '').replace(/(\.[a-z0-9]+)\1$/i, '$1')
  // SoundCraft bounces a session it opened from a dropped file as "Untitled Bounce.wav": keep the card's name
  if (/^Untitled\b/i.test(name) && props.name && name.includes('.')) name = props.name.replace(/\.[^.]+$/, '') + name.slice(name.lastIndexOf('.'))
  const own = officeEditorFor(name) === appName()
  show('agent', own ? '저장하는 중…' : `${name} 내보내는 중…`)
  try {
    const f = await uploadAttachment(new File([bytes], name || props.name))
    if (own) { savedUrls.add(f.url); dirty.value = false; link?.rename(f.name); show('success', '저장했어요. 편집본이 원본 옆에 올라갔어요.'); emit('saved', { url: f.url, name: f.name }) }
    else show('success', `${f.name} 을(를) 만들었어요.`, f.url)
  } catch (e) { show('error', `저장하지 못했어요: ${e.message}`); emit('error', e.message) }
}
function onMessage(event) {
  if (!app.value?.bridge || event.origin !== location.origin || event.source !== frame.value?.contentWindow) return
  const m = event.data || {}
  const kind = String(m.type || '').split(':')[1]
  if (!kind || m.type !== `${appName()}:${kind}`) return
  if (kind === 'ready') sendDocument().then(startLive)
  else if (kind === 'save') onSave(m)
  else if (kind === 'dirty') dirty.value = !!m.dirty
  else if (kind === 'failed') { show('error', `편집기를 시작하지 못했어요: ${m.error || ''}`); emit('error', m.error) }
}
async function toggleFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.value.requestFullscreen() }
  catch { show('error', '이 브라우저에서는 전체 화면을 쓸 수 없어요.') }
}
const onFs = () => { fullscreen.value = document.fullscreenElement === root.value }
// the app asks before a page with unsaved changes goes away; so do we
const onLeave = (e) => { if (dirty.value) { e.preventDefault(); e.returnValue = '' } }

watch(() => props.fileUrl, (u) => { if (u && !savedUrls.has(u)) load() })
onMounted(() => {
  window.addEventListener('message', onMessage); window.addEventListener('beforeunload', onLeave)
  document.addEventListener('fullscreenchange', onFs); load()
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage); window.removeEventListener('beforeunload', onLeave)
  document.removeEventListener('fullscreenchange', onFs); clearTimeout(timer); clearTimeout(wait)
  alive = false; stopLive()
})
</script>

<template>
  <div ref="root" class="cef" :class="{ fs: fullscreen }">
    <div class="bar">
      <Icon name="doc" :size="16" />
      <span class="name">{{ name || '파일' }}</span>
      <span v-if="app" class="badge">{{ app.title }}</span>
      <span v-if="live" class="badge live" :class="{ busy }" title="대화창에 적은 수정안이 이 화면에 바로 적용돼요"><i />{{ busy ? 'AI가 고치는 중' : '대화와 연결됨' }}</span>
      <span v-if="dirty" class="badge warn">저장 안 됨 · {{ app?.save || 'SAVE 로 저장' }}</span>
      <span class="sp" />
      <ShareButton v-if="!returnLabel" :for-name="name" plain class="tb" />
      <button v-if="returnLabel" class="tb press primary" :disabled="!live" @click="emit('return')">{{ returnLabel }}</button>
      <button v-if="!fullscreen && !returnLabel" class="tb press" @click="emit('update:maximized', !maximized)">
        <Icon :name="maximized ? 'shrink' : 'expand'" :size="15" /> {{ maximized ? '원래 크기' : '최대화' }}
      </button>
      <button class="tb press" @click="toggleFullscreen">{{ fullscreen ? '전체 화면 끝내기' : '전체 화면' }}</button>
      <button class="tb ic press" title="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button>
    </div>
    <div v-if="busy" class="glow" />
    <iframe v-if="frameSrc" ref="frame" :src="frameSrc" :title="name || '편집기'" class="frm" allow="clipboard-read; clipboard-write; fullscreen; autoplay" @load="onFrameLoad" />
    <div v-else class="empty">이 파일은 편집기로 열 수 없어요.</div>
    <Transition name="fade">
      <div v-if="notice" class="notice" :class="notice.kind">
        {{ notice.text }} <a v-if="notice.link" :href="notice.link" target="_blank" rel="noopener">열기</a>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.cef { position: relative; display: flex; flex-direction: column; flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; background: #22282f; border-radius: inherit; overflow: hidden; }
.cef.fs { min-height: 100vh; border-radius: 0; }
/* dark like the apps below it (the page's text colours follow the pgpt theme, not this strip) */
.bar { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; height: 44px; padding: 0 8px 0 14px; background: #2b323a; border-bottom: 1px solid rgba(255, 255, 255, .06); color: #e8eaed; }
.name { overflow: hidden; font-size: 14px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.badge { padding: 1px 8px; border-radius: 10px; background: rgba(90, 170, 255, .16); color: #8cc4ff; font-size: 11px; white-space: nowrap; }
.badge.warn { background: rgba(240, 160, 40, .18); color: #ffc46b; }
.badge.live { display: inline-flex; align-items: center; gap: 6px; background: rgba(80, 200, 120, .16); color: #8fe0a8; }
.badge.live i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.badge.live.busy { background: rgba(140, 120, 255, .22); color: #c7bcff; }
.badge.live.busy i { animation: livepulse 1s ease-in-out infinite; }
@keyframes livepulse { 50% { opacity: .25; transform: scale(.7); } }
/* while the agent's edits land: a soft rim around the app */
.glow { position: absolute; inset: 44px 0 0; z-index: 2; pointer-events: none; box-shadow: inset 0 0 0 2px rgba(150, 130, 255, .75), inset 0 0 28px rgba(150, 130, 255, .35); animation: glowin .3s ease both; }
@keyframes glowin { from { opacity: 0; } }
.sp { flex: 1; }
.tb { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 10px; border-radius: 15px; font-size: 13px; color: #c3c8cf; white-space: nowrap; flex: 0 0 auto; }
.badge { flex: 0 0 auto; }
.name { min-width: 40px; }
.tb:hover { background: rgba(255, 255, 255, .08); }
.tb.ic { width: 30px; padding: 0; justify-content: center; }
.tb.primary { background: #6e5ae6; color: #fff; font-weight: 600; }
.tb.primary:hover { background: #7d6af0; }
.tb.primary:disabled { opacity: .5; }
.frm { flex: 1 1 auto; width: 100%; min-height: 0; border: 0; }
.empty { margin: auto; color: #b8b8b8; font-size: 14px; }
.notice { position: absolute; right: 16px; bottom: 32px; padding: 8px 14px; border-radius: 8px; font-size: 13px; color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .2); }
.notice a { color: #fff; font-weight: 600; text-decoration: underline; margin-left: 6px; }
.notice.success { background: #2e7d32; }
.notice.agent { background: #3949ab; }
.notice.error { background: #c62828; }
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
