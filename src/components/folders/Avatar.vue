<script setup>
// 사람은 동그라미(PersonAvatar — 앱 어디서나 같은 얼굴: 프로필 사진, 없으면 이름 첫 글자), 에이전트는 둥근 사각형 — 한눈에 사람/에이전트가 갈린다.
import PersonAvatar from '../PersonAvatar.vue'
defineProps({ who: Object, size: { type: Number, default: 26 } })
</script>
<template>
  <span v-if="who?.type === 'agent'" class="av agent" :style="{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * .46) + 'px', background: who?.color }" :title="who?.name + ' · ' + who.engine">
    <svg :width="size * .6" :height="size * .6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 9h10v8H7zM12 5v4M10 13h.01M14 13h.01" /></svg>
  </span>
  <PersonAvatar v-else class="ring" :id="who?.id" :name="who?.name" :size="size" :color="who?.color" :title="who?.name" />
</template>
<style scoped>
.av { flex: none; display: inline-grid; place-items: center; overflow: hidden; border-radius: 30%; color: #fff; font-weight: 600; box-shadow: 0 0 0 2px var(--regular-solid-bg); }
/* (stacked circles stand apart: the surface's ring) */
.ring { border-radius: 9999px; box-shadow: 0 0 0 2px var(--regular-solid-bg); }
</style>
