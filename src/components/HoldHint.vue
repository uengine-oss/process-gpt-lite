<script setup>
// 「길게 누르면 …」 — once on a phone, under the newest answer or file card that has a menu (src/holdHint.js): seen the moment it is on screen,
// gone with ✕ or the first long press that opens a menu (Message.vue)
import { ref, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { sawHint, closeHint } from '../holdHint.js'

const el = ref(null)
let io = null
onMounted(() => {
  if (!('IntersectionObserver' in window)) return sawHint()
  io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io?.disconnect(); io = null; sawHint() } })
  if (el.value) io.observe(el.value)
})
onBeforeUnmount(() => io?.disconnect())
</script>

<template>
  <p ref="el" class="hhint" role="note" data-test="hold-hint">
    <Icon name="hand" :size="14" /><span>답이나 파일을 길게 누르면 공유 · 프로젝트로 시작 · 폴더 정리를 할 수 있어요</span>
    <button class="hx press" aria-label="안내 닫기" data-test="hold-hint-close" @click="closeHint"><Icon name="close" :size="12" /></button>
  </p>
</template>

<style scoped>
.hhint { display: flex; align-items: center; gap: 6px; max-width: min(424px, 100%); box-sizing: border-box; margin: 8px 0 0; padding: 6px 6px 6px 11px; border-radius: 14px;
  font-size: 12.5px; line-height: 1.4; color: var(--text-primary); background: var(--bubble-user-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px);
  animation: blur-in .4s var(--spring) both; }
.hhint > :deep(svg) { flex: none; color: var(--color-info); }
.hhint span { flex: 1; min-width: 0; word-break: keep-all; overflow-wrap: anywhere; }
.hx { flex: none; width: 24px; height: 24px; border-radius: 12px; display: grid; place-items: center; color: var(--text-secondary); }
</style>
