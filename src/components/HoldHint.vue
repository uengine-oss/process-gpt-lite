<script setup>
// 「길게 누르면 …」 — once on a phone, under the newest answer or file card that has a menu (src/holdHint.js): seen once it has been wholly
// on screen — clear of the top bar and of the composer with its 「기본」 pill below (they lie over the chat) — for 1.5 s (a glimpse while the
// chat scrolls by is not reading it, PR #126 review); gone with ✕ or the first long press that opens a menu (Message.vue)
import { ref, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { sawHint, closeHint } from '../holdHint.js'

const DWELL_MS = 1500
const el = ref(null)
let io = null, timer = null
// the part of the screen nothing lies over: under the top bar (≈ 96px on a phone), above the composer and the pill over it
function rootMargin() {
  const composer = document.querySelector('[data-test="chat-composer"]')?.getBoundingClientRect()
  const bottom = composer && composer.top > 0 ? Math.max(0, window.innerHeight - composer.top + 64) : 180
  return `-96px 0px -${Math.round(bottom)}px 0px`
}
onMounted(() => {
  if (!('IntersectionObserver' in window)) return sawHint()
  io = new IntersectionObserver((es) => {
    const whole = es.some((x) => x.isIntersecting && x.intersectionRatio >= 0.99)
    if (!whole) { clearTimeout(timer); timer = null; return }
    if (!timer) timer = setTimeout(() => { io?.disconnect(); io = null; sawHint() }, DWELL_MS)
  }, { threshold: [0, 0.99, 1], rootMargin: rootMargin() })
  if (el.value) io.observe(el.value)
})
onBeforeUnmount(() => { clearTimeout(timer); io?.disconnect() })
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
/* a finger's target (44px) that does not make the pill taller */
.hx { flex: none; width: 44px; height: 44px; margin: -10px -6px -10px -6px; border-radius: 22px; display: grid; place-items: center; color: var(--text-secondary); }
</style>
