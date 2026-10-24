<script setup>
// 사람은 이름 첫 글자 동그라미, 에이전트는 둥근 사각형 — 한눈에 사람/에이전트가 갈린다.
defineProps({ who: Object, size: { type: Number, default: 26 } })
</script>
<template>
  <span class="av" :class="who?.type" :style="{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * .46) + 'px', background: who?.color }" :title="who?.name + (who?.type === 'agent' ? ' · ' + who.engine : '')">
    <svg v-if="who?.type === 'agent'" :width="size * .6" :height="size * .6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 9h10v8H7zM12 5v4M10 13h.01M14 13h.01" /></svg>
    <template v-else>{{ who?.name?.slice(0, 1) }}</template>
  </span>
</template>
<style scoped>
.av { flex: none; display: inline-grid; place-items: center; border-radius: 9999px; color: #fff; font-weight: 600; box-shadow: 0 0 0 2px var(--regular-solid-bg); }
.av.agent { border-radius: 30%; }
</style>
