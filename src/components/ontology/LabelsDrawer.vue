<script setup>
// 이름 맞춘 기록: 인계 글 · 메일이 어떤 일 이름으로 맞춰졌는지(GET /ontology/labels)
import Icon from '../Icon.vue'
import { HOW_KO } from './fmt.js'
defineProps({ labels: { type: Array, default: () => [] }, loading: Boolean, error: String })
const emit = defineEmits(['close', 'task'])
const ACT = { request: '맡김', deliver: '건넴', approve: '승인', notify: '알림' }
</script>

<template>
  <div class="scrim" @click.self="emit('close')">
    <aside class="drawer glass">
      <header>
        <div class="tt"><b>이름 맞춘 기록</b><small>인계 글과 메일이 어떤 일로 맞춰졌는지예요. 같은 일을 다르게 쓴 글은 한 일로 셉니다.</small></div>
        <button class="x press" aria-label="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>
      <div class="list scroll">
        <p v-if="loading" class="muted pulse">불러오는 중…</p>
        <p v-else-if="error" class="err">{{ error }}</p>
        <p v-else-if="!labels.length" class="muted">아직 맞춘 기록이 없어요.</p>
        <div v-for="(l, i) in labels" :key="i" class="row">
          <p class="raw" :title="l.raw">{{ l.raw }}</p>
          <div class="to">
            <span class="arr">→</span>
            <button class="chip press" @click="emit('task', l.task)">{{ l.task }}</button>
            <small v-if="ACT[l.act]">{{ ACT[l.act] }}</small><small v-if="HOW_KO[l.how]">· {{ HOW_KO[l.how] }}</small>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: 70; background: rgba(5 7 13 / .28); animation: fade-in .25s both; }
.drawer { position: absolute; top: 76px; right: 12px; bottom: 12px; width: min(400px, calc(100vw - 24px)); border-radius: 22px; display: flex; flex-direction: column; background: linear-gradient(var(--regular-solid-bg), var(--regular-solid-bg)), var(--surface-secondary); box-shadow: var(--shadow-card); animation: blur-in .35s var(--spring) both; }
header { display: flex; gap: 10px; align-items: flex-start; padding: 16px 12px 10px 20px; }
.tt { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.tt b { font-size: 17px; font-weight: 600; }
.tt small { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.x { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; color: var(--text-secondary); background: var(--button-bg); flex: none; }
.list { flex: 1; overflow-y: auto; padding: 0 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.row { padding: 10px 12px; border-radius: 14px; background: var(--field-bg); display: flex; flex-direction: column; gap: 6px; }
.raw { margin: 0; font-size: 13px; line-height: 1.45; color: var(--text-primary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.to { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.arr { color: var(--text-tertiary); }
.chip { font-size: 12.5px; font-weight: 600; padding: 3px 10px; border-radius: 9999px; background: var(--chip-bg); color: var(--text-primary); }
.to small { font-size: 11.5px; color: var(--text-tertiary); }
.muted { color: var(--text-secondary); font-size: 13.5px; }
.err { color: var(--color-error); font-size: 13.5px; }
@media (max-width: 760px) {
  .drawer { top: auto; left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 72vh; }
}
</style>
