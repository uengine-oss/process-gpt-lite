<script setup>
// The IeumOffice editor in an iframe, ported from process-gpt-vue3 OfficeEditorFrame.vue (same
// message protocol, without Vuetify). Documents open in their own format (docx·xlsx·pptx·pdf·hwp…);
// saving inside the editor uploads an `edited-…` copy next to the original and reports its URL.
// in:  ready → saved{url,name} | agent{action,text} | save-failed{error} | error{error}
//      | assistant{label, prompt, selection} — the editor's AI 도우미 buttons (with `assistant`)
// out: context{context} — the work around the document, which the editor's AI reads.
// One assistant (`assistant` prop): the editor's AI dock stays hidden and its AI buttons come here
// (emit 'assistant'); while the document is open the page tells the server (src/liveLink.js, app
// 'ieumoffice'), so a chat message is about this document and the agent edits it in front of the
// person through office-host's office_live_* tools (server/mcp/office.js).
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { isOfficeEditorMessage, officeEditorUrl } from '../officeEditor.js'
import { freshToken } from '../api.js'
import { openLiveLink } from '../liveLink.js'

const props = defineProps({
  fileUrl: { type: String, default: '' },
  name: { type: String, default: '' },
  readOnly: { type: Boolean, default: false },
  context: { type: Object, default: null },
  maximized: { type: Boolean, default: false },
  assistant: { type: Boolean, default: false },
})
const emit = defineEmits(['ready', 'saved', 'error', 'agent', 'update:maximized', 'close', 'live', 'assistant'])

const root = ref(null)
const frame = ref(null)
const frameSrc = ref('')
const emptyText = ref('문서를 여는 중…')
const notice = ref(null)
const fullscreen = ref(false)
let ready = false
let timer = null
// live: the chat is joined to this document; busy: the agent's edits are landing
const live = ref(false)
const busy = ref(false)
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
}

function startLive() {
  if (link || props.readOnly || !props.assistant) return
  link = openLiveLink({ app: 'ieumoffice', file: props.name, editor: editor(), alive: () => alive && !!frameSrc.value, onState: (on) => { live.value = on; emit('live', on) } })
}
function stopLive() { link?.close(); link = null; live.value = false; busy.value = false }

async function load() {
  stopLive()
  ready = false
  // with an expired token the host refuses every editor call — the UI language too, so its menus
  // fall back to the editor's built-in default (Chinese)
  const token = await freshToken()
  frameSrc.value = officeEditorUrl({ fileUrl: props.fileUrl, name: props.name, readOnly: props.readOnly, assistant: props.assistant ? 'parent' : '', token })
  if (!frameSrc.value) { emptyText.value = '이 문서는 편집기로 열 수 없어요.'; return }
  const key = RIBBON_KEYS[editor()]
  if (key) try { localStorage.setItem(key, '1') } catch { /* private mode: the editor opens unfolded */ }
  ribbonOpen.value = false
}
function show(kind, text) {
  clearTimeout(timer)
  notice.value = { kind, text }
  timer = setTimeout(() => (notice.value = null), kind === 'error' ? 8000 : kind === 'agent' ? 6000 : 2500)
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
  const m = event.data
  if (m.type === 'ready') { ready = true; sendContext(); emit('ready'); if (editor() === 'hwp') foldHwpWhenReady(); if (props.readOnly) hideAiDock(); startLive() }
  else if (m.type === 'assistant') emit('assistant', { label: m.label || '', prompt: m.prompt || null, selection: m.selection || '' })
  else if (m.type === 'saved') {
    if (m.url) savedUrls.add(m.url)
    if (m.name) link?.rename(m.name)
    show('success', m.url ? '저장했어요. 편집본이 원본 옆에 올라갔어요.' : '저장했어요.')
    emit('saved', { url: m.url || '', name: m.name || props.name })
  } else if (m.type === 'agent') {
    const label = { write: '내용을 쓰는 중', replace: '내용을 바꾸는 중', ops: '서식·구조를 고치는 중', save: '저장했어요' }[m.action]
    show('agent', `에이전트가 ${label || '작업하는 중'}${m.text ? ` · ${m.text}` : ''}`)
    busy.value = m.action !== 'save'
    clearTimeout(busyTimer)
    busyTimer = setTimeout(() => (busy.value = false), 4000)
    emit('agent', m)
  } else if (m.type === 'save-failed') { show('error', `저장한 문서를 올리지 못했어요: ${m.error || ''}`); emit('error', m.error) }
  else if (m.type === 'error') { show('error', `문서를 열지 못했어요: ${m.error || ''}`); emit('error', m.error) }
}
async function toggleFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.value.requestFullscreen() }
  catch { show('error', '이 브라우저에서는 전체 화면을 쓸 수 없어요.') }
}
const onFs = () => { fullscreen.value = document.fullscreenElement === root.value }

watch(() => props.fileUrl, (u) => { if (u && !savedUrls.has(u)) load() })
watch(() => props.readOnly, load)
watch(() => props.context, sendContext, { deep: true })
onMounted(() => { window.addEventListener('message', onMessage); document.addEventListener('fullscreenchange', onFs); load() })
onBeforeUnmount(() => { window.removeEventListener('message', onMessage); document.removeEventListener('fullscreenchange', onFs); clearTimeout(timer); clearTimeout(busyTimer); alive = false; stopLive() })
</script>

<template>
  <div ref="root" class="oef" :class="{ fs: fullscreen }">
    <div class="bar">
      <Icon name="doc" :size="16" />
      <span class="name">{{ name || '문서' }}</span>
      <span v-if="readOnly" class="badge">미리보기</span>
      <span v-if="live" class="badge live" :class="{ busy }" title="대화창에 적은 수정안이 이 문서에 바로 적용돼요"><i />{{ busy ? 'AI가 고치는 중' : '대화와 연결됨' }}</span>
      <span class="sp" />
      <button class="tb press" :title="ribbonOpen ? '리본 접기 (Ctrl+F1)' : '리본 펴기 (Ctrl+F1)'" @click="toggleRibbon">
        <Icon :name="ribbonOpen ? 'up' : 'chevron'" :size="14" /> {{ ribbonOpen ? '리본 접기' : '리본 펴기' }}
      </button>
      <button v-if="!fullscreen" class="tb press" @click="emit('update:maximized', !maximized)">
        <Icon :name="maximized ? 'shrink' : 'expand'" :size="15" /> {{ maximized ? '원래 크기' : '최대화' }}
      </button>
      <button class="tb press" @click="toggleFullscreen">{{ fullscreen ? '전체 화면 끝내기' : '전체 화면' }}</button>
      <button class="tb ic press" title="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button>
    </div>
    <div v-if="busy" class="glow" />
    <iframe v-if="frameSrc" ref="frame" :src="frameSrc" :title="name || '문서 편집기'" class="frm" allow="clipboard-read; clipboard-write; fullscreen" />
    <div v-else class="empty">{{ emptyText }}</div>
    <Transition name="fade">
      <div v-if="notice" class="notice" :class="notice.kind">{{ notice.text }}</div>
    </Transition>
  </div>
</template>

<style scoped>
/* the iframe takes the height left in the column (an explicit 100% falls back to 150px when the
   parent height is not definite) */
.oef { position: relative; display: flex; flex-direction: column; flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; background: #fff; border-radius: inherit; overflow: hidden; }
.oef.fs { min-height: 100vh; border-radius: 0; }
.bar { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; height: 44px; padding: 0 8px 0 14px; border-bottom: 1px solid rgba(0, 0, 0, .08); color: #1d1d1f; }
.name { overflow: hidden; font-size: 14px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.badge { padding: 1px 8px; border-radius: 10px; background: rgba(42, 120, 214, .12); color: #2a78d6; font-size: 11px; white-space: nowrap; flex: 0 0 auto; }
.badge.live { display: inline-flex; align-items: center; gap: 6px; background: rgba(40, 160, 90, .12); color: #1e8a4c; }
.badge.live i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.badge.live.busy { background: rgba(110, 90, 230, .13); color: #5b47d6; }
.badge.live.busy i { animation: livepulse 1s ease-in-out infinite; }
@keyframes livepulse { 50% { opacity: .25; transform: scale(.7); } }
/* while the agent's edits land: a soft rim around the document */
.glow { position: absolute; inset: 44px 0 0; z-index: 2; pointer-events: none; box-shadow: inset 0 0 0 2px rgba(120, 100, 240, .7), inset 0 0 26px rgba(120, 100, 240, .28); animation: glowin .3s ease both; }
@keyframes glowin { from { opacity: 0; } }
.sp { flex: 1; }
.tb { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 10px; border-radius: 15px; font-size: 13px; color: #5f6368; }
.tb:hover { background: rgba(0, 0, 0, .05); }
.tb.ic { width: 30px; padding: 0; justify-content: center; }
.frm { flex: 1 1 auto; width: 100%; min-height: 0; border: 0; }
.empty { margin: auto; color: var(--text-secondary); font-size: 14px; }
.notice { position: absolute; right: 16px; bottom: 32px; padding: 8px 14px; border-radius: 8px; font-size: 13px; color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .2); }
.notice.success { background: #2e7d32; }
.notice.agent { max-width: 60%; background: #3949ab; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.notice.error { background: #c62828; }
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
