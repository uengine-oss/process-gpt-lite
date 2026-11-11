<script setup>
// An ArtCraft web app (CADCraft · VectorCraft · PhotoCraft · SoundCraft · FilmCraft), the way OfficeEditorFrame hosts
// IeumOffice: this is the toolbar and the page's side; the app runs in the built-in MCP App 'craft'
// (server/lib/apps/builtin/craft) behind the sandbox proxy — an origin of its own (/api/config appsSandbox), where
// the self-hosted WebAssembly build keeps its settings and fonts, and which cannot reach this page. What crosses:
// - the file: we fetch it and hand it to the screen (its tool craft_file);
// - saves and exports: the screen catches them in the app (CADCraft's SAVE, the others' browser downloads) and
//   hands them over as ui/download-file. A save in the app's own formats becomes the card's edited copy; anything
//   else (exports) is uploaded and offered as a link;
// - the state ('craft' notification: open · dirty · failed);
// - live co-editing (server/lib/craftLive.js, src/liveLink.js): once the file is open, the agent's tool calls arrive
//   over a websocket and run on the app through the screen's tool craft_request, so the person watches the agent's
//   edits land here.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import ShareButton from './team/ShareButton.vue'
import AppFrame from '../apps/AppFrame.vue'
import { b64, unb64 } from '../apps/bytes.js'
import { uploadAttachment } from '../api.js'
import { openLiveLink } from '../liveLink.js'
import { officeEditorFor } from '../officeEditor.js'
import { lang } from '../i18n/lang.js'

const props = defineProps({
  // files that travel with this one ({name, url}: a circuit's .lib), handed to a bridge app with it
  companions: { type: Array, default: () => [] },
  fileUrl: { type: String, default: '' },
  name: { type: String, default: '' },
  maximized: { type: Boolean, default: false },
  // opened from a document to edit one of its pictures (OfficeSheet): a button hands the result back
  returnLabel: { type: String, default: '' },
})
const emit = defineEmits(['saved', 'error', 'update:maximized', 'close', 'live', 'return'])

// the toolbar's part of each app: its name, and how the person saves there (the "not saved" badge says it)
const APPS = {
  cadcraft: { title: 'CADCraft' },
  circuitcraft: { title: 'CircuitCraft', save: '⌘S 로 저장' },
  solidcraft: { title: 'SolidCraft', save: '⌘S 로 저장' },
  vectorcraft: { title: 'VectorCraft', save: '⌘S 로 저장' },
  photocraft: { title: 'PhotoCraft', save: '⌘S 로 저장' },
  soundcraft: { title: 'SoundCraft', save: '⌘⌥B 로 내보내기' },
  // the edited copy is the export (⌘M ▸ Export)
  filmcraft: { title: 'FilmCraft', save: '⌘M 로 내보내기' },
}
const CRAFT = { id: 'craft', entry: 'craft_open', origin: true, name: { ko: 'ArtCraft 편집기', en: 'ArtCraft editors' } }

const root = ref(null)
const view = ref(null)
const opened = ref(0)
const notice = ref(null)
const dirty = ref(false)
const fullscreen = ref(false)
let timer = null
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
const params = computed(() => ({ app: appName(), name: props.name || '', lang }))
// a live request can run long (a render, an export): no protocol timeout of its own
const LONG = { timeout: 30 * 60 * 1000 }

function load() {
  stopLive()
  dirty.value = false
  opened.value++
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
// the screen is up: hand it the file (it opens it once the app runs)
async function sendDocument() {
  try {
    const files = await Promise.all((props.companions || []).map(async (c) => ({ name: c.name, base64: b64(await (await fetch(c.url)).arrayBuffer()) })))
    await view.value.callView('craft_file', { name: props.name || 'file', base64: b64(await documentBytes()), files })
  } catch (e) { show('error', `파일을 불러오지 못했어요: ${e.message}`); emit('error', e.message) }
}
function onScreen({ type, data } = {}) {
  if (type !== 'craft' || !data) return
  if (data.state === 'open') { if (data.live) startLive() }
  else if (data.state === 'dirty') dirty.value = !!data.dirty
  else if (data.state === 'failed') { show('error', `편집기를 시작하지 못했어요: ${data.error || ''}`); emit('error', data.error) }
}
function onScreenFailed(e) { show('error', `편집기를 시작하지 못했어요: ${e?.message || ''}`); emit('error', e?.message) }
async function onDownload(contents) {
  for (const c of contents) {
    if (c.type !== 'resource' || !c.resource?.blob) continue
    await onSave({ name: decodeURIComponent(String(c.resource.uri || '').replace(/^file:\/\/\//, '')), bytes: unb64(c.resource.blob) })
  }
}
// a control request on the open app: the agent's (live) or the page's (OfficeSheet's recolour guard)
async function request(method, params = {}) {
  if (!view.value) throw new Error('앱이 아직 열리지 않았어요')
  const r = await view.value.callView('craft_request', { method, params }, LONG)
  if (!READS.test(method) && !READS.test(params?.command || '')) dirty.value = true
  return r
}
function startLive() {
  const name = appName()
  if (!alive || !LIVE.has(name) || link) return
  link = openLiveLink({
    app: name, file: props.name, alive: () => alive && !!view.value,
    onState: (on) => { live.value = on; if (!on) busy.value = 0; emit('live', on) },
    onCall: async (method, params) => {
      busy.value++
      try { return await request(method, params) } finally { busy.value-- }
    },
  })
}
// the open document as PNG (PhotoCraft renders it for ui.screenshot on the web: api.rs)
async function snapshot() {
  if (!view.value) throw new Error('앱이 아직 열리지 않았어요')
  return unb64(await view.value.callView('craft_snapshot', {}, LONG))
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
async function toggleFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.value.requestFullscreen() }
  catch { show('error', '이 브라우저에서는 전체 화면을 쓸 수 없어요.') }
}
const onFs = () => { fullscreen.value = document.fullscreenElement === root.value }
// the app asks before a page with unsaved changes goes away; so do we
const onLeave = (e) => { if (dirty.value) { e.preventDefault(); e.returnValue = '' } }

watch(() => props.fileUrl, (u) => { if (u && !savedUrls.has(u)) load() })
onMounted(() => {
  window.addEventListener('beforeunload', onLeave)
  document.addEventListener('fullscreenchange', onFs)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onLeave)
  document.removeEventListener('fullscreenchange', onFs); clearTimeout(timer)
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
    <AppFrame v-if="app && fileUrl" :key="opened" ref="view" class="frm" :manifest="CRAFT" :params="params"
      @initialized="sendDocument" @event="onScreen" @download="onDownload" @error="onScreenFailed" />
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
.frm { flex: 1 1 0; width: 100%; height: auto; min-height: 0; }
.empty { margin: auto; color: #b8b8b8; font-size: 14px; }
.notice { position: absolute; right: 16px; bottom: 32px; padding: 8px 14px; border-radius: 8px; font-size: 13px; color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .2); }
.notice a { color: #fff; font-weight: 600; text-decoration: underline; margin-left: 6px; }
.notice.success { background: #2e7d32; }
.notice.agent { background: #3949ab; }
.notice.error { background: #c62828; }
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
