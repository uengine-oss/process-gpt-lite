<script setup>
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { useSky } from '../stores/sky.js'

const sky = useSky()
const sharing = ref(false)
const sunset = computed(() => {
  const s = sky.wx?.sunset
  return s ? new Date(s).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'
})
async function share() {
  sharing.value = true
  try { await sky.sharePrecise() } finally { sharing.value = false }
}
</script>

<template>
  <div class="panel glass">
    <div class="head"><Icon :name="sky.isDay ? 'sun' : 'moon'" :size="20" /> {{ sky.place?.place || '—' }}</div>
    <div class="cells">
      <div class="cell"><span class="k">{{ sky.condition }}</span><span class="v">{{ sky.wx ? sky.wx.temp + '°C' : '—' }}</span></div>
      <div class="cell"><span class="k">체감</span><span class="v">{{ sky.wx ? sky.wx.feels + '°' : '—' }}</span></div>
      <div class="cell"><span class="k">일몰</span><span class="v">{{ sunset }}</span></div>
    </div>
    <template v-if="sky.place?.approx">
      <p class="note">대략적인 위치를 기준으로 합니다.</p>
      <button class="share press" :class="{ pulse: sharing }" @click="share">위치 공유</button>
    </template>
  </div>
</template>

<style scoped>
.panel { border-radius: 24px; padding: 16px; }
.head { display: flex; align-items: center; gap: 10px; font-size: 16px; margin: 2px 6px 14px; }
.cells { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
.cell { background: var(--cell-bg); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; transition: background-color 1s; }
.k { font-size: 14px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v { font-size: 26px; letter-spacing: -0.02em; white-space: nowrap; }
.note { font-size: 13px; color: var(--text-tertiary); margin: 14px 6px 10px; }
.share { width: 100%; height: 32px; border-radius: 8px; background: var(--cell-bg); font-size: 14px; font-weight: 500; }
</style>
