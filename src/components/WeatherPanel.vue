<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import Icon from './Icon.vue'
import BackgroundPicker from './BackgroundPicker.vue'
import { useSky } from '../stores/sky.js'
import { useBackground } from '../stores/background.js'
import { isEnglish } from '../i18n/lang.js'

const sky = useSky()
const bg = useBackground()
const sharing = ref(false)
const sunset = computed(() => {
  const s = sky.wx?.sunset
  return s ? new Date(s).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'
})
// the date (the person's own) and the solar term the server read for it (lib/background/calendar.js)
const dateLabel = computed(() => sky.now.toLocaleDateString(isEnglish ? 'en-US' : 'ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }))
const term = computed(() => (bg.day?.date === bg.today ? bg.day.term : null))
const termTitle = computed(() => {
  const t = term.value
  if (!t) return ''
  const md = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(isEnglish ? 'en-US' : 'ko-KR', { month: 'long', day: 'numeric' })
  return isEnglish ? `Solar term since ${md(t.start)} · next: ${t.next.name} on ${md(t.next.start)}` : `24절기 · ${md(t.start)}부터 · 다음 ${t.next.name}(${md(t.next.start)})`
})
// the day (its solar term) and the day's background photos: when the panel shows, and again when the weather arrives or changes,
// the hour turns or the date changes (the server keeps the day's answers; the same question is not asked twice)
onMounted(() => bg.load())
watch(() => [sky.wx?.code, bg.today, sky.now.getHours()], () => bg.load())
async function share() {
  sharing.value = true
  try { await sky.sharePrecise() } finally { sharing.value = false }
}
</script>

<template>
  <div class="panel glass" data-test="weather-panel">
    <div class="head">
      <Icon :name="sky.isDay ? 'sun' : 'moon'" :size="20" />
      <span class="date" data-test="wx-date" data-no-i18n>{{ dateLabel }}</span>
      <span v-if="term" class="term" data-test="wx-term" :title="termTitle" data-no-i18n>{{ term.name }}</span>
      <span class="place">{{ sky.place?.place || '—' }}</span>
    </div>
    <div class="cells">
      <div class="cell"><span class="k">{{ sky.condition }}</span><span class="v">{{ sky.wx ? sky.wx.temp + '°C' : '—' }}</span></div>
      <div class="cell"><span class="k">체감</span><span class="v">{{ sky.wx ? sky.wx.feels + '°' : '—' }}</span></div>
      <div class="cell"><span class="k">일몰</span><span class="v">{{ sunset }}</span></div>
    </div>
    <template v-if="sky.place?.approx">
      <p class="note">대략적인 위치를 기준으로 합니다.</p>
      <button class="share press" :class="{ pulse: sharing }" @click="share">위치 공유</button>
    </template>
    <!-- the day's background photos (the company may turn them off: Settings › 시스템 설정) -->
    <BackgroundPicker v-if="bg.enabled" />
  </div>
</template>

<style scoped>
.panel { border-radius: 24px; padding: 16px; }
.head { display: flex; align-items: center; gap: 8px; font-size: 16px; margin: 2px 6px 14px; min-width: 0; }
.head .date { white-space: nowrap; }
.head .term { flex: none; height: 22px; line-height: 22px; padding: 0 8px; border-radius: 11px; background: var(--cell-bg); font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; }
.head .place { margin-left: auto; min-width: 0; font-size: 13.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cells { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
.cell { background: var(--cell-bg); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; transition: background-color 1s; }
.k { font-size: 14px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v { font-size: 26px; letter-spacing: -0.02em; white-space: nowrap; }
.note { font-size: 13px; color: var(--text-tertiary); margin: 14px 6px 10px; }
.share { width: 100%; height: 32px; border-radius: 8px; background: var(--cell-bg); font-size: 14px; font-weight: 500; }
</style>
