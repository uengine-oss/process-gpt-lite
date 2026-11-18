<script setup>
// The line on top of the Home list after a pull to refresh (src/pullRefresh.js): 「메일을 가져오는 중…」
// while a connected mailbox is read, then what came of it for a moment.
import Icon from './Icon.vue'

defineProps({ banner: { type: Object, required: true } }) // { text, kind: busy | done | info | error }
const ICON = { done: 'check', info: 'clock', error: 'alert' }
</script>

<template>
  <div class="ptr-banner glass" :class="banner.kind" role="status" aria-live="polite">
    <span v-if="banner.kind === 'busy'" class="ring" aria-hidden="true" />
    <Icon v-else :name="ICON[banner.kind] || 'check'" :size="18" />
    <span class="txt">{{ banner.text }}</span>
  </div>
</template>

<style scoped>
.ptr-banner { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 10px 18px; border-radius: 22px; font-size: 15px; color: var(--text-primary); }
.ptr-banner .txt { line-height: 1.4; }
.ptr-banner.done :deep(svg) { color: var(--color-success); }
.ptr-banner.error :deep(svg) { color: var(--color-error); }
.ptr-banner.info :deep(svg) { color: var(--text-secondary); }
.ring { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--text-tertiary); border-top-color: var(--text-primary); animation: spin .8s linear infinite; }
@media (prefers-reduced-motion: reduce) { .ring { animation-duration: 2.4s; } }
</style>
