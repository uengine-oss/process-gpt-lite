<script setup>
// 채팅 카드에서 여는 패널 시트(건 · 일): 넓은 화면은 가운데, 휴대폰은 아래에서 올라온다.
import { onMounted, onBeforeUnmount } from 'vue'
import Icon from '../Icon.vue'

defineProps({ title: String })
const emit = defineEmits(['close'])
const onKey = (e) => { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="veil" @click.self="emit('close')">
      <div class="sheet glass blur-in" role="dialog" :aria-label="title" data-testid="onto-sheet">
        <div class="bar">
          <span class="t" aria-hidden="true"><slot name="title" /></span>
          <button class="x press" aria-label="닫기" @click="emit('close')"><Icon name="close" :size="18" /></button>
        </div>
        <div class="body scroll"><slot /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .32); display: grid; place-items: center; padding: 16px; }
.sheet { width: min(560px, 100%); max-height: min(88vh, 940px); border-radius: 28px; padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 6px; background: var(--bubble-agent-bg); box-shadow: var(--shadow-card); min-width: 0; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 2px; }
.t { font-size: 12.5px; color: var(--text-secondary); letter-spacing: .04em; }
.x { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--field-bg); flex: none; }
.body { min-height: 0; overflow-y: auto; padding: 2px; }
@media (max-width: 760px) {
  .veil { place-items: end stretch; padding: 0; }
  .sheet { width: 100%; max-height: 90vh; border-radius: 28px 28px 0 0; padding: 12px 14px 26px; }
}
</style>
