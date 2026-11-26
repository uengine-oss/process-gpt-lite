<script setup>
// The reactions a teammate's bubble can take (2026-11-26 사용자 「다른 사람 말풍선에 좋아요 확인했음 사랑해 웃음 등을 붙힐 수 있게」, 스펙
// room-reactions): opened by a long press (phone), the hover button or a right-click (desktop) — Messenger.vue places it over the bubble.
// One tap puts the reaction on or, when it is already mine, takes it off. 「복사」 too: on a phone the long press no longer selects text.
//   mine: keys already mine on this message · text: what 「복사」 copies ('' → no 「복사」)
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { REACTIONS } from '../../roomReactions.js'
import Icon from '../Icon.vue'

// off: this database has no reactions yet (sql/062) — only 「복사」
const props = defineProps({ mine: { type: Array, default: () => [] }, text: { type: String, default: '' }, off: Boolean })
const emit = defineEmits(['pick', 'copy', 'close'])
const el = ref(null)
// a press anywhere else, Esc, or the conversation scrolling puts it away
const away = (e) => { if (el.value && !el.value.contains(e.target)) emit('close') }
const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); emit('close') } }
onMounted(() => {
  // (after the press that opened it has ended)
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0)
  window.addEventListener('keydown', esc, true)
  el.value?.querySelector('button')?.focus({ preventScroll: true })
})
onBeforeUnmount(() => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc, true) })
defineExpose({ el })
</script>

<template>
  <div ref="el" class="rxpop" role="dialog" aria-label="반응 남기기" data-test="rx-bar">
    <div v-if="!off" class="bar glass" role="group">
      <button v-for="r in REACTIONS" :key="r.key" class="rx press" :class="{ on: props.mine.includes(r.key) }" :data-key="r.key" data-test="rx-pick"
        :aria-pressed="props.mine.includes(r.key)" @click="emit('pick', r.key)">
        <span class="em" aria-hidden="true"><Icon :name="r.icon" :size="23" /></span><small>{{ r.label }}</small>
      </button>
    </div>
    <button v-if="text" class="copy glass press" data-test="rx-copy" @click="emit('copy')">복사</button>
  </div>
</template>

<style scoped>
/* (a narrow docked messenger: the six give way a little rather than leave the pane) */
.rxpop { position: absolute; z-index: 9; max-width: calc(100% - 16px); display: flex; flex-direction: column; align-items: flex-start; gap: 6px; animation: pop-in .22s var(--spring); }
.bar { max-width: 100%; display: flex; gap: 2px; padding: 5px; border-radius: 20px; box-shadow: 0 10px 34px rgba(0, 0, 0, .22); border: 1px solid rgba(127, 127, 127, .18);
  /* (opaque: the bubble under it does not show through) */
  background: linear-gradient(var(--regular-solid-bg), var(--regular-solid-bg)), var(--surface-secondary); }
.rx { flex: 0 1 48px; min-width: 38px; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 5px 0 4px; border-radius: 14px; color: var(--text-secondary); }
/* the app's own line icon, in the words' colour (the device's colour emoji did not sit with the rest — 2026-11-26) */
.rx .em { display: grid; place-items: center; height: 28px; color: var(--text-primary); transition: transform .15s var(--spring); }
.rx small { max-width: 100%; overflow: hidden; text-overflow: ellipsis; font-size: 10.5px; line-height: 13px; white-space: nowrap; }
.rx:hover .em, .rx:focus-visible .em { transform: scale(1.18); }
.rx.on { background: rgba(42, 120, 214, .16); color: #1a56c4; }
:root:not([data-theme="light"]) .rx.on { color: #a1d0ff; background: rgba(42, 120, 214, .3); }
.copy { height: 32px; padding: 0 14px; border-radius: 16px; font-size: 13.5px; color: var(--text-primary); box-shadow: 0 8px 26px rgba(0, 0, 0, .18);
  border: 1px solid rgba(127, 127, 127, .18); background: linear-gradient(var(--regular-solid-bg), var(--regular-solid-bg)), var(--surface-secondary); }
</style>
