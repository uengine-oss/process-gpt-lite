<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import ComposerTeam from './team/ComposerTeam.vue'
import { useTeammateMention } from './team/useTeammateMention.js'

// overlay: a second composer over an open app (CraftLiveOverlay) — no page-wide drop target, no 새 패널 button
const props = defineProps({ placeholder: { type: String, default: 'process gpt에 메시지 보내기' }, overlay: Boolean })
const emit = defineEmits(['send', 'escape'])
const app = useApp()
const text = ref('')
const ta = ref(null)
const listening = ref(false)
let rec
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
onBeforeUnmount(() => { clearInterval(rot); rec?.stop() })

const ph = computed(() => (app.panelMode ? suggestions[si.value].t : props.placeholder))
watch(() => app.prefill, async (v) => {
  if (!v) return
  text.value = v
  app.prefill = ''
  await nextTick()
  ta.value?.focus()
})
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
const onEnter = (e) => { if (hasFiles(e)) { depth++; dragging.value = true; e.preventDefault() } }
const onOver = (e) => { if (hasFiles(e)) e.preventDefault() }
const onLeave = (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; dragging.value = false } }
const onDrop = (e) => {
  if (!hasFiles(e)) return
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
  if (tm.chips.value.length) { if (v) tm.send(v).then((ok) => { if (!ok) text.value = v }); text.value = v ? '' : text.value; return }
  emit('send', v)
  text.value = ''
}
function onKey(e) {
  if (tm.onKey(e)) return
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
  if (e.key === 'Escape' && app.panelMode) app.panelMode = false
  if (e.key === 'Escape') emit('escape')
}
function dictate() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return alert('이 브라우저는 받아쓰기를 지원하지 않아요.')
  if (listening.value) { rec.stop(); return }
  rec = new SR()
  rec.lang = 'ko-KR'
  rec.interimResults = true
  const base = text.value
  rec.onresult = (e) => { text.value = base + [...e.results].map((r) => r[0].transcript).join('') }
  rec.onend = () => { listening.value = false }
  listening.value = true
  rec.start()
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
    <div v-if="app.attachments.length" class="atts">
      <span v-for="a in app.attachments" :key="a.id" class="att glass-thin" :class="a.state">
        <Icon name="doc" :size="14" /> <b>{{ a.name }}</b>
        <small>{{ a.state === 'uploading' ? '올리는 중…' : a.state === 'error' ? a.error : kb(a.size) }}</small>
        <button class="x" aria-label="빼기" @click="app.removeAttachment(a.id)">×</button>
      </span>
    </div>
    <Teleport to="body">
      <Transition name="fade"><div v-if="dragging" class="dropzone"><div><Icon name="clip" :size="34" /><p>여기에 놓으면 첨부돼요</p></div></div></Transition>
    </Teleport>
    <div class="box glass-thin">
      <input ref="picker" type="file" multiple hidden @change="picked" />
      <span v-if="app.panelMode && !text" :key="si" class="icons blur-in"><i v-for="(ic, k) in suggestions[si].icons" :key="k">{{ ic }}</i></span>
      <textarea ref="ta" v-model="text" rows="1" :placeholder="ph" @keydown="onKey" @paste="onPaste" />
      <button v-if="!app.panelMode" class="ic press" aria-label="파일 첨부" title="파일 첨부 (끌어다 놓기·붙여넣기도 돼요)" @click="picker.click()"><Icon name="clip" :size="19" /></button>
      <button v-if="text || app.panelMode || app.attachments.length" class="send press" aria-label="보내기" @click="submit"><Icon name="up" :size="20" /></button>
      <template v-else>
        <button v-if="!overlay" class="ic press" aria-label="새 패널 만들기" @click="app.panelMode = true"><Icon name="plus" :size="22" /></button>
        <button class="ic press" :class="{ rec: listening }" aria-label="받아쓰기 시작" @click="dictate"><Icon name="mic" :size="20" /></button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.composer { position: relative; width: 100%; }
.box { display: flex; align-items: flex-end; min-height: 48px; border-radius: 24px; padding-right: 6px; --thin-bg: var(--composer-bg); transition: background-color 1s, margin .4s var(--spring); }
.panel .box { margin-left: 60px; }
textarea { flex: 1; resize: none; border: 0; outline: 0; background: transparent; height: 48px; padding: 14.5px 8px 14.5px 16px; font-size: 15px; line-height: 19px; color: var(--text-primary); }
textarea::placeholder { color: var(--text-secondary); transition: opacity .3s; }
.ic { width: 36px; height: 36px; margin: 6px 2px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-secondary); }
.ic:hover { color: var(--text-primary); }
.ic.rec { color: var(--color-attention); animation: pulse 1.2s infinite; }
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
