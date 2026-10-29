<script setup>
// Over a maximized ArtCraft app or IeumOffice document: pgpt-pro's chat folded into a round dial in the corner. Pressed,
// it opens as a thin composer at the bottom (the app's lower part blurs behind it), with the
// status pill above — the same input as the chat. What is sent goes to the chat thread with the
// open app as its context (server/lib/craftLive.js), so the agent's edits land in the app below.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
import { hidePaths } from '../paths.js'
import Composer from './Composer.vue'
import { useApp } from '../stores/app.js'

const props = defineProps({ title: { type: String, default: '' }, live: Boolean })
const app = useApp()
const open = ref(false)
const composer = ref(null)
const status = computed(() => app.status[app.activeId] || (app.active?.status === 'working' ? '작업하는 중' : null))
const draft = computed(() => app.drafts[app.activeId])
const working = computed(() => status.value || (draft.value === '' ? '생각하는 중' : null))
// the agent's answer, shown for a moment over the app
const answer = ref('')
let answerTimer = null
const md = (t) => marked.parse(hidePaths(t || '').replace(/</g, '&lt;'), { breaks: true })
const lastAgent = computed(() => [...(app.thread || [])].reverse().find((m) => m.role === 'agent' && (m.kind === 'text' || m.kind === 'doc')))
watch(() => lastAgent.value?.id, (id, was) => {
  if (!id || !was) return
  answer.value = String(lastAgent.value.content?.text || '').slice(0, 400)
  clearTimeout(answerTimer)
  answerTimer = setTimeout(() => (answer.value = ''), 9000)
})

async function expand() {
  clearTimeout(foldTimer)
  open.value = true
  await nextTick()
  composer.value?.focus()
}
// after sending, the band stays a moment (the pill appears above the composer), then folds
let foldTimer = null
function send(text) {
  answer.value = ''
  app.send(text)
  clearTimeout(foldTimer)
  foldTimer = setTimeout(() => (open.value = false), 1600)
}
defineExpose({ expand })
const onKey = (e) => { if (e.key === 'Escape' && open.value) open.value = false }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); clearTimeout(answerTimer); clearTimeout(foldTimer) })
</script>

<template>
  <div class="clo">
    <Transition name="band">
      <div v-if="open" class="band" @click.self="open = false">
        <div class="col">
          <Transition name="pill"><div v-if="working" :key="working" class="working"><span class="shimmer-text">{{ working }}</span></div></Transition>
          <Composer ref="composer" overlay :placeholder="live ? `${title}에서 고칠 내용을 적어 주세요` : 'process gpt에 메시지 보내기'" @send="send" @escape="open = false" />
          <div class="hint">{{ live ? `보내면 ${title} 화면에 바로 적용돼요 · Esc 로 접기` : 'Esc 로 접기' }}</div>
        </div>
      </div>
    </Transition>
    <!-- folded: the dial, and while the agent works its pill beside it -->
    <Transition name="pill"><div v-if="!open && (working || draft)" class="mini working"><span class="shimmer-text">{{ working || '답하는 중' }}</span></div></Transition>
    <Transition name="pill"><div v-if="!open && !working && answer" class="reply md" v-html="md(answer)" @click="answer = ''" /></Transition>
    <button v-if="!open" class="dial press" :class="{ busy: !!working }" aria-label="process gpt 입력창 열기" title="process gpt에게 말하기" @click="expand">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a8.5 8.5 0 0 1-12.3 7.6L3 21l1.4-5.4A8.5 8.5 0 1 1 21 12z" />
        <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" stroke-width="2.6" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* over the app (dark in every ArtCraft app; IeumOffice is light, the glass reads on both): dark glass, the composer in the page's own theme */
.clo { position: absolute; inset: 44px 0 0; z-index: 5; pointer-events: none; }
.clo > * { pointer-events: auto; }
/* folded above the app's bottom row, where its own actions sit (FilmCraft's Export, a status bar, a
   command line): the corner itself stays the app's */
.dial { position: absolute; right: 22px; bottom: 96px; width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; color: #1d1d1f;
  background: rgba(250, 250, 252, .86); -webkit-backdrop-filter: blur(24px) saturate(1.6); backdrop-filter: blur(24px) saturate(1.6);
  box-shadow: 0 8px 28px rgba(0, 0, 0, .4), inset 0 0 0 1px rgba(255, 255, 255, .6); animation: pop-in .4s var(--spring); }
.dial:hover { background: #fff; }
.dial.busy::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid rgba(160, 140, 255, .9); border-right-color: transparent; animation: spin 1.1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.band { position: absolute; left: 0; right: 0; bottom: 0; height: 240px; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 30px;
  -webkit-backdrop-filter: blur(14px) saturate(1.2); backdrop-filter: blur(14px) saturate(1.2);
  background: linear-gradient(to top, rgba(16, 18, 26, .72), rgba(16, 18, 26, .38) 70%, rgba(16, 18, 26, 0));
  -webkit-mask-image: linear-gradient(to top, #000 70%, transparent); mask-image: linear-gradient(to top, #000 70%, transparent); }
.col { position: relative; width: 560px; max-width: calc(100% - 32px); }
.col :deep(.box) { box-shadow: 0 10px 36px rgba(0, 0, 0, .35); }
.hint { margin-top: 9px; text-align: center; font-size: 12.5px; color: rgba(235, 237, 242, .78); }
.working { height: 38px; padding: 0 18px; border-radius: 19px; display: inline-flex; align-items: center; font-size: 14.5px; white-space: nowrap;
  --text-primary: rgb(245 245 247); --text-tertiary: rgba(245 245 247 / .45);
  border: 1px solid rgba(255, 255, 255, .14); background: rgba(34, 38, 48, .82); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); box-shadow: 0 4px 16px rgba(0, 0, 0, .3); }
.col > .working { position: absolute; left: 4px; bottom: calc(100% + 12px); }
.mini { position: absolute; right: 90px; bottom: 105px; }
.reply { position: absolute; right: 90px; bottom: 96px; max-width: 420px; padding: 12px 16px; border-radius: 20px; font-size: 14px; line-height: 1.55; color: #f5f5f7; cursor: pointer;
  background: rgba(34, 38, 48, .9); border: 1px solid rgba(255, 255, 255, .12); -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px); box-shadow: 0 8px 28px rgba(0, 0, 0, .35); }
.reply :deep(p) { margin: 0 0 .5em; } .reply :deep(p:last-child) { margin: 0; }
.reply :deep(ul) { margin: 0 0 .5em; padding-left: 18px; }
.band-enter-active, .band-leave-active { transition: opacity .3s, transform .35s var(--spring); }
.band-enter-from, .band-leave-to { opacity: 0; transform: translateY(24px); }
.pill-enter-active, .pill-leave-active { transition: opacity .25s, translate .25s; }
.pill-enter-from, .pill-leave-to { opacity: 0; translate: 0 6px; }
</style>
