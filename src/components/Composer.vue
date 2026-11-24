<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import ComposerTeam from './team/ComposerTeam.vue'
import { useTeammateMention } from './team/useTeammateMention.js'
import ComposerClip from './ComposerClip.vue'
import FolderAttach from './folders/FolderAttach.vue'
import ComposerAgent from './ComposerAgent.vue'
import { keyOf, agentFor } from '../chatAgent.js'
import { narrow } from '../viewport.js'
import { createDictation, recognizerOf, MESSAGES } from '../useDictation.js'

// overlay: a second composer over an open app (CraftLiveOverlay) — no page-wide drop target, no 새 패널 button
const props = defineProps({ placeholder: { type: String, default: 'process gpt에 메시지 보내기' }, overlay: Boolean })
const emit = defineEmits(['send', 'escape'])
const app = useApp()
const text = ref('')
const ta = ref(null)
// voice dictation (src/useDictation.js): on from a tap (or while the mic is held) until the person turns it off — pauses do not end
// it, and it never sends. dict: { on, phase: off | starting | listening, error }
const SR = recognizerOf(window)
const dict = reactive({ on: false, phase: 'off', error: '' })
const dictation = SR && createDictation({
  Recognition: SR, read: () => text.value, write: (v) => { text.value = v }, onChange: (s) => Object.assign(dict, s),
  desktop: () => document.documentElement.classList.contains('pgl-desktop'),
})
// "@" → teammates (team/useTeammateMention.js); a message with person chips goes to them, not the agent
const tm = useTeammateMention(text, ta, !props.overlay)

const suggestions = [
  { t: '내 주식을 추적해 줘', icons: ['📈', '💹'] },
  { t: '내 할 일 목록을 만들어 줘', icons: ['✅', '🗂️'] },
  { t: '오늘 환율을 보여 줘', icons: ['💱', '🏦'] },
  { t: '진행 중인 영업 리드를 정리해 줘', icons: ['🤝', '📇'] },
  { t: '내 운동을 추적해 줘', icons: ['🏃', '⌚'] },
]
const si = ref(0)
let rot
onMounted(() => { rot = setInterval(() => { si.value = (si.value + 1) % suggestions.length }, 3200) })
onBeforeUnmount(() => { clearInterval(rot); dictation?.cancel() })

const ph = computed(() => (dict.on ? '듣는 중… 말하면 여기에 적혀요' : app.panelMode ? suggestions[si.value].t : props.placeholder))
// something to send: the send button (beside the mic, never in its place — see the template)
const sendable = computed(() => !!(text.value || app.panelMode || app.attachments.length))
// who answers (ComposerAgent): the main chat, one of its conversations, a project — not 새 프로젝트 (no room yet), an instance's page or a
// panel being made; the chat's key is what the choice is kept under (src/chatAgent.js)
const agentKey = computed(() => {
  if (props.overlay || app.panelMode || !app.activeId) return null
  if (app.mode === 'chat' && app.activeId === app.mainThread?.id) return keyOf(app.activeId, app.convFilter)
  if (app.mode === 'project' && app.projects.some((p) => p.id === app.activeId)) return keyOf(app.activeId)
  return null
})
// (immediate: a request left before this composer was there — an open document's AI button on another page, OfficeSheet)
watch(() => app.prefill, async (v) => {
  if (!v) return
  text.value = v
  app.prefill = ''
  await nextTick()
  ta.value?.focus()
}, { immediate: true })
// an open document's own AI 도우미 button lands here (OfficeSheet): the chat composer, not the overlay's
watch(() => app.focusTick, () => { if (!props.overlay) ta.value?.focus() })
watch(text, async () => {
  await nextTick()
  if (!ta.value) return
  ta.value.style.height = '48px'
  ta.value.style.height = Math.min(ta.value.scrollHeight, 200) + 'px'
})

// files: the 📎 button, pasting, or dropping anywhere on the page while a composer is shown
const picker = ref(null)
const dragging = ref(false)
let depth = 0
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
// a sheet over the chat that takes files itself (the messenger: data-own-drop) keeps them — dropping a file on a conversation
// there attached it to this composer too (2026-11-24). Such a sheet also stops the events; this is for one that does not.
const own = (e) => !!e.target?.closest?.('[data-own-drop]')
const onEnter = (e) => { if (hasFiles(e) && !own(e)) { depth++; dragging.value = true; e.preventDefault() } }
const onOver = (e) => { if (hasFiles(e) && !own(e)) e.preventDefault() }
const onLeave = (e) => { if (hasFiles(e) && !own(e) && --depth <= 0) { depth = 0; dragging.value = false } }
const onDrop = (e) => {
  if (!hasFiles(e) || own(e)) return
  e.preventDefault(); depth = 0; dragging.value = false
  if (e.dataTransfer.files.length) { app.addAttachments(e.dataTransfer.files); ta.value?.focus() }
}
onMounted(() => {
  if (props.overlay) return
  window.addEventListener('dragenter', onEnter); window.addEventListener('dragover', onOver)
  window.addEventListener('dragleave', onLeave); window.addEventListener('drop', onDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onEnter); window.removeEventListener('dragover', onOver)
  window.removeEventListener('dragleave', onLeave); window.removeEventListener('drop', onDrop)
})
function onPaste(e) {
  const fs = [...(e.clipboardData?.files || [])]
  if (fs.length) { e.preventDefault(); app.addAttachments(fs) }
}
function picked(e) { if (e.target.files.length) app.addAttachments(e.target.files); e.target.value = '' }
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`)

function submit() {
  const v = text.value.trim() || (app.panelMode ? suggestions[si.value].t : '')
  if (!v && !app.attachments.length) return
  // sending ends dictation first: nothing heard afterwards comes back into the emptied box
  dictation?.cancel()
  if (tm.chips.value.length) { if (v) tm.send(v).then((ok) => { if (!ok) text.value = v }); text.value = v ? '' : text.value; return }
  // (the store's send takes the agent of the chat this was written in — stores/app.js send)
  app.nextAgent = agentKey.value ? { key: agentKey.value, agent: agentFor(agentKey.value) } : null
  emit('send', v)
  text.value = ''
}
function onKey(e) {
  if (tm.onKey(e)) return
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
  if (e.key === 'Escape' && app.panelMode) app.panelMode = false
  if (e.key === 'Escape') emit('escape')
}
// the mic: a tap turns it on and off, holding it down (over HOLD_MS) listens until let go — pointer events, so mouse and touch alike.
// Keyboard (Enter · Space) and assistive clicks come without a pointer press (a click's detail is 0): they toggle.
function micDown(e) {
  if (!dictation || e.button > 0) return
  // (letting go off the button still counts as letting go)
  try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* a pointer the browser does not track */ }
  dictation.press()
}
function micUp() { dictation?.release() }
function micClick(e) {
  if (!dictation) return alert(MESSAGES.unsupported)
  if (e.detail === 0) dictation.toggle()
}
defineExpose({ focus: () => ta.value?.focus() })
</script>

<template>
  <div class="composer" :class="{ panel: app.panelMode }">
    <Transition name="fade"><div v-if="app.panelMode" class="label">새 패널 만들기</div></Transition>
    <Transition name="fade">
      <button v-if="app.panelMode" class="undo press" aria-label="취소" @click="app.panelMode = false"><Icon name="undo" :size="20" /></button>
    </Transition>
    <ComposerTeam v-if="!overlay" :tm="tm" />
    <div v-if="app.mentions.length" class="mentions">
      <span v-for="(m, i) in app.mentions" :key="i + m.label" class="mention" :title="m.file || ''">
        <b>@{{ m.label }}</b>
        <button class="x" aria-label="빼기" @click="app.removeMention(i)">×</button>
      </span>
    </div>
    <div v-if="app.attachments.length" class="atts">
      <span v-for="a in app.attachments" :key="a.id" class="att glass-thin" :class="a.state">
        <Icon name="doc" :size="14" /> <b>{{ a.name }}</b>
        <small>{{ a.state === 'uploading' ? '올리는 중…' : a.state === 'error' ? a.error : kb(a.size) }}</small>
        <button class="x" aria-label="빼기" @click="app.removeAttachment(a.id)">×</button>
      </span>
    </div>
    <FolderAttach v-if="!overlay && !app.panelMode" />
    <Teleport to="body">
      <Transition name="fade"><div v-if="dragging" class="dropzone"><div><Icon name="clip" :size="34" /><p>여기에 놓으면 첨부돼요</p></div></div></Transition>
    </Teleport>
    <!-- over the box: dictation — listening (the mic again, or letting go of a held mic, stops it) or why it stopped — on the left;
         a phone's who-answers on the right (the box keeps its width for the words). A long reason takes a line of its own. -->
    <div v-if="dict.on || dict.error || (agentKey && narrow)" class="agentrow">
      <span v-if="dict.on || dict.error" class="dictbar" role="status" aria-live="polite" data-testid="dictation-status">
        <span v-if="dict.on" class="dpill glass-thin"><i class="dot" />{{ dict.phase === 'starting' ? '마이크 켜는 중…' : '듣는 중…' }}</span>
        <span v-else class="dpill glass-thin err">{{ dict.error }}</span>
      </span>
      <ComposerAgent v-if="agentKey && narrow" :chat-key="agentKey" row />
    </div>
    <div class="box glass-thin">
      <input ref="picker" type="file" multiple hidden @change="picked" />
      <span v-if="app.panelMode && !text" :key="si" class="icons blur-in"><i v-for="(ic, k) in suggestions[si].icons" :key="k">{{ ic }}</i></span>
      <textarea ref="ta" v-model="text" rows="1" :placeholder="ph" @keydown="onKey" @paste="onPaste" />
      <ComposerClip v-if="!app.panelMode" :folders="!overlay" @files="picker.click()" />
      <ComposerAgent v-if="agentKey && !narrow" :chat-key="agentKey" />
      <button v-if="sendable" class="send press" aria-label="보내기" @click="submit"><Icon name="up" :size="20" /></button>
      <!-- panels are made from 채팅 only, not from a project, 새 프로젝트 or an instance page -->
      <button v-else-if="!overlay && app.mode === 'chat'" class="ic press" aria-label="새 패널 만들기" @click="app.panelMode = true"><Icon name="plus" :size="22" /></button>
      <!-- the mic is always the last button: the send button comes in beside it, never under the finger that taps the mic again
           (2026-11-24: the mic used to turn into ↑ with the first words, and the tap meant to keep talking sent). Without speech
           recognition it is there only while the box is empty, and says so. -->
      <button v-if="dictation || !sendable" class="ic mic press" :class="{ rec: dict.on }" :aria-pressed="dictation ? String(dict.on) : undefined"
        :aria-label="dict.on ? '받아쓰기 멈추기' : '받아쓰기 시작'" :title="dict.on ? '받아쓰기 멈추기' : '받아쓰기 — 누르면 켜지고 다시 누르면 꺼져요. 길게 누르면 누르는 동안만 들어요.'"
        data-testid="composer-mic" @pointerdown="micDown" @pointerup="micUp" @pointercancel="micUp" @click="micClick" @contextmenu.prevent>
        <Icon name="mic" :size="20" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* objects pointed at in an open document (OfficeEditorFrame "@ 가리키기") */
.mentions { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 0; }
.mention { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 4px 0 10px; border-radius: 13px; font-size: 13px;
  background: rgba(124, 104, 255, .2); color: #d9d2ff; border: 1px solid rgba(160, 140, 255, .45); animation: pop-in .3s var(--spring); }
.mention b { font-weight: 600; }
.mention .x { width: 20px; height: 20px; border-radius: 10px; color: inherit; opacity: .7; }
.mention .x:hover { opacity: 1; background: rgba(255, 255, 255, .12); }
.composer { position: relative; width: 100%; }
.agentrow { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; margin: 0 6px 6px; }
.box { display: flex; align-items: flex-end; min-height: 48px; border-radius: 24px; padding-right: 6px; --thin-bg: var(--composer-bg); transition: background-color 1s, margin .4s var(--spring); }
.panel .box { margin-left: 60px; }
textarea { flex: 1; resize: none; border: 0; outline: 0; background: transparent; height: 48px; padding: 14.5px 8px 14.5px 16px; font-size: 15px; line-height: 19px; color: var(--text-primary); }
textarea::placeholder { color: var(--text-secondary); transition: opacity .3s; }
.ic { width: 36px; height: 36px; margin: 6px 2px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-secondary); }
.ic:hover { color: var(--text-primary); }
/* the mic: held down on a phone without the page's long-press menu or text selection; on — a filled button with a ring */
.mic { touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.mic.rec { color: #fff; background: var(--color-attention); opacity: 1; animation: mic-ring 1.4s infinite; }
@keyframes mic-ring { 0% { box-shadow: 0 0 0 0 rgba(255, 77, 0, .45); } 100% { box-shadow: 0 0 0 7px rgba(255, 77, 0, 0); } }
@media (prefers-reduced-motion: reduce) { .mic.rec, .dpill .dot { animation: none; } }
.dictbar { display: flex; min-width: 0; max-width: 100%; margin-right: auto; }
.dpill { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; min-height: 30px; padding: 5px 14px 5px 12px; border-radius: 15px;
  font-size: 13px; line-height: 1.4; color: var(--text-primary); animation: pop-in .3s var(--spring); }
.dpill .dot { flex: none; width: 8px; height: 8px; border-radius: 4px; background: var(--color-attention); animation: pulse 1.2s infinite; }
.dpill.err { color: #c62828; }
:root[data-theme="dark"] .dpill.err { color: #ff8a80; }
.send { width: 36px; height: 36px; margin: 6px 0; border-radius: 9999px; display: grid; place-items: center; background: #1d1d1f; color: #fff; animation: pop-in .3s var(--spring); }
:root[data-theme="dark"] .send { background: #f5f5f7; color: #1d1d1f; }
.undo { position: absolute; left: 0; bottom: 0; width: 48px; height: 48px; border-radius: 9999px; display: grid; place-items: center; background: var(--composer-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); }
.label { position: absolute; bottom: 62px; left: 0; right: 0; text-align: center; font-size: 17px; color: var(--text-secondary); }
.icons { display: flex; padding: 12px 0 12px 12px; }
.atts { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
.att { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 32px; padding: 0 6px 0 12px; border-radius: 16px; font-size: 13px; color: var(--text-primary); }
.att b { font-weight: 500; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att small { color: var(--text-secondary); }
.att.uploading small { color: #2a78d6; } .att.error small { color: #c62828; }
.att .x { width: 22px; height: 22px; border-radius: 11px; color: var(--text-secondary); font-size: 16px; line-height: 20px; }
.dropzone { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: rgba(42, 120, 214, .14); border: 3px dashed rgba(42, 120, 214, .7); pointer-events: none; }
.dropzone div { text-align: center; color: #1a56c4; font-size: 18px; font-weight: 600; background: rgba(255, 255, 255, .9); padding: 22px 34px; border-radius: 20px; }
.icons i { font-style: normal; width: 24px; height: 24px; border-radius: 9999px; display: grid; place-items: center; background: var(--regular-solid-bg); font-size: 13px; margin-right: -6px; box-shadow: 0 0 0 2px var(--composer-bg); }
</style>
