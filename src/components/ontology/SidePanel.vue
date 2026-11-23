<script setup>
// 지도 오른쪽(폰은 화면 아래 시트)에 붙는 패널 틀: 제목 · 닫기 · 내용.
// 폰에서는 body 로 옮긴다 — 지도 카드(.glass)의 backdrop-filter 가 fixed 의 기준을 카드로 바꾸기 때문.
import Icon from '../Icon.vue'
import { narrow } from '../../viewport.js'
defineProps({ title: String, kicker: String })
const emit = defineEmits(['close'])
</script>

<template>
  <Teleport to="body" :disabled="!narrow">
  <aside class="side glass ontomap" :class="{ sheet: narrow }">
    <header>
      <div class="tt"><small v-if="kicker">{{ kicker }}</small><b>{{ title }}</b></div>
      <button class="x press" aria-label="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button>
    </header>
    <div class="body scroll"><slot /></div>
  </aside>
  </Teleport>
</template>

<style scoped>
.side { position: absolute; z-index: 4; top: 10px; right: 10px; bottom: 10px; width: 340px; border-radius: 20px; display: flex; flex-direction: column; box-shadow: var(--shadow-card); background: linear-gradient(var(--regular-solid-bg), var(--regular-solid-bg)), var(--surface-secondary); animation: blur-in .35s var(--spring) both; }
header { display: flex; align-items: flex-start; gap: 10px; padding: 14px 12px 8px 18px; }
.tt { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tt small { font-size: 12px; color: var(--text-tertiary); }
.tt b { font-size: 16.5px; font-weight: 600; line-height: 1.35; letter-spacing: -0.01em; word-break: keep-all; }
.x { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; color: var(--text-secondary); background: var(--button-bg); flex: none; }
.body { flex: 1; overflow-y: auto; padding: 4px 18px 18px; }
.side.sheet { position: fixed; z-index: 60; top: auto; left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 52vh; }
</style>
