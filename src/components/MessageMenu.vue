<script setup>
// hark: a long press lifts the bubble over a blurred chat, with 👍 👎 · 복사 · 텍스트 선택 · 답장 under it. A right-click opens
// the same menu at the pointer, over the chat as it is. (spec pgpt-pro_message-actions, lib/messageActions.js)
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'

const GAP = 8
const EDGE = 12
const app = useApp()
const open = computed(() => app.messageMenu)
const msg = computed(() => open.value?.msg)
const touch = computed(() => !!open.value?.at?.touch)
const canRate = computed(() => msg.value?.role === 'agent')
// the list has the row as it is now (a rating replaces it); the menu opened with the row as it was
const rating = computed(() => {
  const m = msg.value
  return ((app.messages[m?.thread_id] || []).find((r) => r.id === m?.id) || m)?.content?.feedback || null
})
const lift = ref(null)
const menu = ref(null)
const words = ref(null)
const liftStyle = ref({})
const menuStyle = ref({ visibility: 'hidden' })
const text = ref('')
const copied = ref(false)
const selecting = ref(false)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)))
let closing

function close() {
  clearTimeout(closing)
  app.messageMenu = null
  selecting.value = false
  copied.value = false
}
function place() {
  const { el, at } = open.value
  const vw = window.innerWidth, vh = window.innerHeight
  const mw = menu.value.offsetWidth, mh = menu.value.offsetHeight
  if (!at.touch) { menuStyle.value = { left: `${clamp(at.x, EDGE, vw - mw - EDGE)}px`, top: `${clamp(at.y, EDGE, vh - mh - EDGE)}px` }; return }
  const r = el.getBoundingClientRect()
  const bubbleH = Math.min(lift.value.scrollHeight, vh * 0.45)
  const top = clamp(r.top, EDGE, vh - bubbleH - GAP - mh - EDGE)
  const left = clamp(r.left, EDGE, vw - r.width - EDGE)
  liftStyle.value = { top: `${top}px`, left: `${left}px`, width: `${r.width}px`, maxHeight: `${bubbleH}px` }
  const mine = msg.value.role === 'user'
  menuStyle.value = { top: `${top + bubbleH + GAP}px`, left: `${clamp(mine ? left + r.width - mw : left, EDGE, vw - mw - EDGE)}px` }
}
watch(open, async (v) => {
  clearTimeout(closing)
  copied.value = false; selecting.value = false
  if (!v) return
  menuStyle.value = { visibility: 'hidden' }
  text.value = v.el.innerText.trim()
  await nextTick()
  if (touch.value) lift.value.replaceChildren(v.el.cloneNode(true))
  place()
  menu.value.querySelector('button')?.focus({ preventScroll: true })
})
function onKey(e) { if (e.key === 'Escape' && open.value) { e.stopPropagation(); close() } }
window.addEventListener('keydown', onKey, true)
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey, true); clearTimeout(closing) })

async function rate(value) {
  const m = msg.value
  await app.rateMessage(m, rating.value === value ? null : value)
  closing = setTimeout(close, 250)
}
async function copy() {
  await copyText(text.value)
  copied.value = true
  closing = setTimeout(close, 700)
}
// plain http has no navigator.clipboard
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return } catch { /* below */ }
  const a = document.createElement('textarea')
  a.value = t; a.style.position = 'fixed'; a.style.opacity = '0'
  document.body.append(a); a.select()
  document.execCommand('copy')
  a.remove()
}
async function selectText() {
  selecting.value = true
  await nextTick()
  const range = document.createRange()
  range.selectNodeContents(words.value)
  const s = window.getSelection()
  s.removeAllRanges(); s.addRange(range)
}
function reply() {
  const m = msg.value, t = text.value
  close()
  app.startReply(m, t)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mm-scrim" :class="{ blur: touch || selecting }" data-testid="message-menu-scrim" @click.self="close" @contextmenu.prevent.self="close" @wheel.passive="!touch && close()">
      <template v-if="selecting">
        <div class="sheet" data-testid="message-select" role="dialog" aria-label="텍스트 선택">
          <div ref="words" class="words">{{ text }}</div>
          <div class="acts">
            <button class="act press" @click="copy">{{ copied ? '복사했어요' : '전체 복사' }}</button>
            <button class="act press" @click="close">닫기</button>
          </div>
        </div>
      </template>
      <template v-else>
        <div v-if="touch" ref="lift" class="lift" :style="liftStyle" data-testid="message-lift" @click="close" />
        <div ref="menu" class="menu" role="menu" :style="menuStyle" data-testid="message-menu" @contextmenu.prevent>
          <div v-if="canRate" class="rate">
            <button class="r press" :class="{ on: rating === 'up' }" role="menuitemradio" :aria-checked="rating === 'up'" aria-label="좋아요" title="좋아요" data-testid="rate-up" @click="rate('up')"><Icon name="thumb" :size="20" /></button>
            <button class="r press down" :class="{ on: rating === 'down' }" role="menuitemradio" :aria-checked="rating === 'down'" aria-label="별로예요" title="별로예요" data-testid="rate-down" @click="rate('down')"><Icon name="thumb" :size="20" /></button>
          </div>
          <button class="it press" role="menuitem" data-testid="menu-copy" @click="copy"><Icon :name="copied ? 'check' : 'copy'" :size="18" />{{ copied ? '복사했어요' : '복사' }}</button>
          <button class="it press" role="menuitem" data-testid="menu-select" @click="selectText"><Icon name="select" :size="18" />텍스트 선택</button>
          <button class="it press" role="menuitem" data-testid="menu-reply" @click="reply"><Icon name="reply" :size="18" />답장</button>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.mm-scrim { position: fixed; inset: 0; z-index: 70; }
.mm-scrim.blur { background: rgba(0 0 0 / .18); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); animation: fade-in .2s both; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.lift { position: fixed; overflow: hidden; border-radius: 24px; box-shadow: var(--shadow-card); animation: pop-in .28s var(--spring) both; }
.lift :deep(.bubble), .lift :deep(.doc) { max-width: none; width: 100%; }
.menu { position: fixed; width: 216px; padding: 6px; border-radius: 18px; background: var(--regular-solid-bg); color: var(--text-primary); box-shadow: var(--shadow-card); animation: pop-in .28s var(--spring) both; }
.rate { display: flex; justify-content: space-around; padding: 2px 0 8px; margin-bottom: 4px; border-bottom: 1px solid var(--hairline); }
.r { width: 44px; height: 40px; border-radius: 12px; display: grid; place-items: center; color: var(--text-primary); }
.r:hover { background: var(--cell-bg); }
.r.down :deep(svg) { rotate: 180deg; }
.r.on { background: var(--text-primary); color: var(--regular-solid-bg); }
.it { display: flex; align-items: center; gap: 12px; width: 100%; height: 42px; padding: 0 12px; border-radius: 12px; font-size: 15px; text-align: left; color: var(--text-primary); }
.it:hover, .it:focus-visible { background: var(--cell-bg); }
.sheet { position: fixed; left: 50%; top: 50%; translate: -50% -50%; width: min(560px, calc(100vw - 32px)); max-height: 76vh; display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 24px; background: var(--regular-solid-bg); color: var(--text-primary); box-shadow: var(--shadow-card); animation: pop-in .28s var(--spring) both; }
.words { flex: 1; min-height: 0; overflow-y: auto; white-space: pre-wrap; font-size: 16px; line-height: 1.6; -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
.acts { display: flex; justify-content: flex-end; gap: 8px; }
.act { height: 38px; padding: 0 16px; border-radius: 19px; background: var(--cell-bg); color: var(--text-primary); font-size: 14px; font-weight: 500; }
</style>
