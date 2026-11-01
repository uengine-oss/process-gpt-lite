<script setup>
// hark: while the browser agent works, its live screen sits as a small round thumbnail by the composer, so it
// stays in sight when the task card has scrolled away; a tap grows the thumbnail into the card in the middle
// of the screen (and back into it on close). The card is the chat's own TaskCard — its pill says what the
// agent is doing right now (the live line, server lib/browser.js say), and its plan, expand and stop work as
// there. While it waits on the person it rings orange, and a tap goes to the card that asks (조치 필요).
import { ref, computed, nextTick, watch, onBeforeUnmount } from 'vue'
import TaskCard from './TaskCard.vue'
import { useApp } from '../stores/app.js'

const emit = defineEmits(['pending'])
const app = useApp()
const task = computed(() => [...app.thread].reverse().find((m) => m.kind === 'task' && ['running', 'needs_input'].includes(m.content?.state)))
const frame = computed(() => task.value && (app.frames[task.value.id]?.data || task.value.content.shot))
const needs = computed(() => task.value?.content.state === 'needs_input')
// the task shown stays shown while open, even once it has finished
const openId = ref(null)
const shown = computed(() => openId.value && app.thread.find((m) => m.id === openId.value))
const thumb = ref(null)
const card = ref(null)
const SPRING = 'cubic-bezier(.22, .8, .24, 1.02)'

// the card from the thumbnail's box to its own (FLIP): a 46px circle at the composer → the card
function fromThumb() {
  const a = thumb.value?.getBoundingClientRect(), b = card.value?.getBoundingClientRect()
  if (!a || !b) return null
  return `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(${a.width / b.width}, ${a.height / b.height})`
}
async function show() {
  // waiting on the person (a login, a code, an approval): to the card that asks, as 조치 필요 always did
  if (needs.value) return emit('pending')
  openId.value = task.value.id
  await nextTick()
  const t = fromThumb()
  if (t) card.value.animate([{ transform: t, borderRadius: '50%', opacity: 0.6 }, { transform: 'none', borderRadius: '26px', opacity: 1 }], { duration: 560, easing: SPRING })
}
let closing = false
async function close() {
  if (!openId.value || closing) return
  closing = true
  const t = fromThumb()
  if (t) await card.value.animate([{ transform: 'none', borderRadius: '26px', opacity: 1 }, { transform: t, borderRadius: '50%', opacity: 0 }], { duration: 320, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' }).finished.catch(() => {})
  openId.value = null
  closing = false
}
// 확장 (the full-screen handoff) and 조치 필요 open over the chat: the peek gives way
watch(() => app.handoff, (v) => { if (v) openId.value = null })
const onKey = (e) => { if (e.key === 'Escape') close() }
watch(openId, (v) => (v ? window.addEventListener('keydown', onKey) : window.removeEventListener('keydown', onKey)))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Transition name="dock">
    <button v-if="task" ref="thumb" class="dock press" :class="{ attn: needs, hide: openId }" :aria-label="needs ? '브라우저 작업 · 조치 필요' : '브라우저 작업 보기'" @click="show">
      <img v-if="frame" :src="`data:image/jpeg;base64,${frame}`" alt="" />
      <span v-else class="dots"><i /><i /><i /></span>
    </button>
  </Transition>
  <Teleport to="body">
    <Transition name="peek">
      <div v-if="shown" class="peek" @click.self="close">
        <button class="x press" aria-label="닫기" @click="close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        <div ref="card" class="pcard"><TaskCard :msg="shown" /></div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dock { position: absolute; right: calc(100% + 10px); bottom: 6px; width: 46px; height: 46px; border-radius: 50%; overflow: hidden; padding: 0;
  display: grid; place-items: center; background: rgba(255 255 255 / .94); box-shadow: 0 4px 16px rgba(0 0 0 / .18); transition: opacity .2s, scale .12s ease-out; }
/* the whole page as a small screen inside the circle (a slice of a white page reads as nothing) */
.dock img { width: 74%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top left; border-radius: 3px; box-shadow: 0 0 0 .5px rgba(0 0 0 / .25); display: block; }
/* at work: an arc running round the edge */
.dock::after { content: ''; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 0deg, transparent 0 62%, #1d1d1f 100%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px)); mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));
  animation: spin 1.2s linear infinite; pointer-events: none; }
.dock.attn::after { display: none; }
.dock.attn { box-shadow: 0 0 0 2.5px var(--color-attention), 0 4px 16px rgba(0 0 0 / .18); animation: ring 1.6s ease-in-out infinite; }
.dock.hide { opacity: 0; }
@keyframes ring { 50% { box-shadow: 0 0 0 5px rgba(255 77 0 / .35), 0 4px 16px rgba(0 0 0 / .18); } }
.dots { position: relative; display: block; width: 14px; height: 14px; margin: 16px auto; animation: spin 1.4s linear infinite; }
.dots i { position: absolute; width: 4.5px; height: 4.5px; border-radius: 50%; background: #1d1d1f; }
.dots i:nth-child(1) { left: 5px; top: 0; } .dots i:nth-child(2) { left: 0; bottom: 1px; opacity: .7; } .dots i:nth-child(3) { right: 0; bottom: 1px; opacity: .45; }
@media (max-width: 760px) { .dock { right: auto; left: 0; } }
.dock-enter-active { animation: pop-in .4s var(--spring); }
.dock-leave-active { transition: opacity .25s, scale .25s; }
.dock-leave-to { opacity: 0; scale: .6; }

.peek { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: rgba(5 7 13 / .55); -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px); }
.peek-enter-active { transition: opacity .3s; }
.peek-leave-active { transition: opacity .3s .1s; }
.peek-enter-from, .peek-leave-to { opacity: 0; }
.pcard { width: min(92vw, 880px); border-radius: 26px; transform-origin: center; }
.x { position: absolute; top: 16px; left: 16px; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: rgba(255 255 255 / .92); color: #1d1d1f; }
</style>
