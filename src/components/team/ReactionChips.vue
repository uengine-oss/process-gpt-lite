<script setup>
// The reactions under a bubble (스펙 room-reactions): one chip per kind with its count, mine marked. On someone else's bubble a tap puts mine
// on or takes it off; on my own bubble (I do not react to my own message) a tap says who reacted. Who reacted: a long press on a phone, the
// pointer resting on a chip on a desktop.
//   chips: [{key, count, mine, people: [{id, name}]}] · can: my reactions may change here · mine: the bubble is mine (the row sits right)
import { ref, watch, onBeforeUnmount } from 'vue'
import { reactionOf, whoLine } from '../../roomReactions.js'

const props = defineProps({ chips: { type: Array, default: () => [] }, can: Boolean, mine: Boolean })
const emit = defineEmits(['toggle'])
const who = ref(null) // {key, below}: the chip whose people are shown
let timer = null, held = false, x0 = 0, y0 = 0
const clear = () => { clearTimeout(timer); timer = null }
// (below the chip when the conversation has no room above it)
function show(el, key) {
  const sc = el?.closest?.('.msgs')
  const below = !!sc && el.getBoundingClientRect().top - sc.getBoundingClientRect().top < 64
  who.value = { key, below }
}
// a finger held on a chip: who reacted (a mouse has the hover below)
function down(e, key) {
  held = false
  if (e.pointerType === 'mouse') return
  x0 = e.clientX; y0 = e.clientY
  const el = e.currentTarget
  clear()
  timer = setTimeout(() => { timer = null; held = true; navigator.vibrate?.(10); show(el, key) }, 450)
}
// (a finger that moves is scrolling; a mouse's moves are its hover's)
const move = (e) => { if (e.pointerType !== 'mouse' && timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) clear() }
// the pointer resting on a chip
function enter(e, key) {
  if (e.pointerType !== 'mouse') return
  const el = e.currentTarget
  clear()
  timer = setTimeout(() => { timer = null; show(el, key) }, 350)
}
function leave(e) { if (e.pointerType !== 'mouse') return; clear(); who.value = null }
function tap(e, key) {
  // the end of a long press is not a tap
  if (held) { held = false; e.preventDefault(); return }
  if (props.can) { who.value = null; emit('toggle', key); return }
  if (who.value?.key === key) who.value = null
  else show(e.currentTarget, key)
}
// the list goes away with the next press anywhere else
const root = ref(null)
const away = (e) => { if (!root.value?.contains(e.target)) who.value = null }
watch(who, (w) => { if (w) document.addEventListener('pointerdown', away, true); else document.removeEventListener('pointerdown', away, true) })
onBeforeUnmount(() => { clear(); document.removeEventListener('pointerdown', away, true) })
const chipOf = (key) => props.chips.find((c) => c.key === key)
</script>

<template>
  <div ref="root" class="rxs" :class="{ mine }" data-test="rx-chips">
    <button v-for="c in chips" :key="c.key" class="rxc press" :class="{ on: c.mine, ro: !can }" :data-key="c.key" :data-count="c.count" data-test="rx-chip"
      :aria-pressed="can ? c.mine : undefined" :aria-label="`반응 ${reactionOf(c.key)?.label || c.key} ${c.count}개`"
      @pointerdown="down($event, c.key)" @pointermove="move" @pointerup="(e) => e.pointerType !== 'mouse' && clear()" @pointercancel="clear" @pointerenter="enter($event, c.key)" @pointerleave="leave"
      @click="tap($event, c.key)" @contextmenu.prevent>
      <span class="em" aria-hidden="true">{{ reactionOf(c.key)?.emoji }}</span><b>{{ c.count }}</b>
    </button>
    <div v-if="who && chipOf(who.key)" class="who" :class="{ below: who.below }" role="tooltip" data-test="rx-who">
      <b><span class="em" aria-hidden="true">{{ reactionOf(who.key)?.emoji }}</span> <span>{{ reactionOf(who.key)?.label }}</span></b><span data-no-i18n>{{ whoLine(chipOf(who.key)) }}</span>
    </div>
  </div>
</template>

<style scoped>
.rxs { position: relative; align-self: flex-start; display: flex; flex-wrap: wrap; gap: 4px; max-width: min(360px, calc(86% - 36px)); margin: -5px 0 0 36px; }
.rxs.mine { align-self: flex-end; justify-content: flex-end; margin-left: 0; }
.rxc { display: inline-flex; align-items: center; gap: 3px; height: 26px; padding: 0 9px 0 7px; border-radius: 13px; font-size: 12.5px; color: var(--text-secondary);
  background: var(--regular-solid-bg); border: 1px solid rgba(127, 127, 127, .22); box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
/* (an emoji takes its text colour's alpha: drawn with an opaque one) */
.rxc .em, .who .em { font-size: 14px; line-height: 1; color: var(--text-primary); }
.rxc b { font-weight: 600; font-variant-numeric: tabular-nums; }
.rxc.on { color: #1a56c4; background: rgba(42, 120, 214, .12); border-color: rgba(42, 120, 214, .55); }
:root:not([data-theme="light"]) .rxc.on { color: #a1d0ff; background: rgba(42, 120, 214, .26); border-color: rgba(120, 180, 255, .55); }
.rxc.ro { cursor: default; }
.who { position: absolute; z-index: 4; left: 0; bottom: calc(100% + 6px); width: max-content; max-width: min(280px, 72vw); padding: 7px 11px; border-radius: 12px; font-size: 12.5px; line-height: 1.45;
  color: var(--text-primary); background: var(--regular-solid-bg); border: 1px solid rgba(127, 127, 127, .22); box-shadow: 0 8px 26px rgba(0, 0, 0, .2);
  display: flex; flex-direction: column; gap: 1px; overflow-wrap: anywhere; animation: pop-in .18s var(--spring); }
.who.below { bottom: auto; top: calc(100% + 6px); }
.rxs.mine .who { left: auto; right: 0; }
.who b { font-weight: 600; font-size: 12px; color: var(--text-secondary); }
</style>
