<script setup>
// 약속 알림 in 설정 › 계정 › 연결, under this device's notifications (server routes/agenda.js · lib/agenda/store.js savePrefs): on or off for
// me, and how long before a plan's start the second reminder comes (the first is the morning of the day, 08:00). Changing it moves my
// reminders not sent yet; off takes them back.
import { onMounted, ref } from 'vue'
import { api } from '../api.js'

const on = ref(true)
const lead = ref(60)
const choices = ref([15, 30, 60, 120, 180])
const busy = ref(false)
const err = ref('')
const ready = ref(false)
// (「시작 …」: a bare 「15분 전」 reads as 「15 minutes ago」 to the English dictionary)
const LEAD = { 15: '시작 15분 전', 30: '시작 30분 전', 60: '시작 1시간 전', 120: '시작 2시간 전', 180: '시작 3시간 전' }
const label = (n) => LEAD[n] || `시작 ${n}분 전`

onMounted(async () => {
  try {
    const p = await api('/agenda/prefs')
    on.value = p.on !== false
    lead.value = p.leadMin || 60
    if (Array.isArray(p.choices) && p.choices.length) choices.value = p.choices
    ready.value = true
  } catch { /* a server without 약속 알림: the row stays hidden */ }
})
async function save(body) {
  busy.value = true
  err.value = ''
  try {
    const p = await api('/agenda/prefs', { method: 'PUT', body })
    on.value = p.on !== false
    lead.value = p.leadMin
  } catch (e) { err.value = e.message || '바꾸지 못했어요.' } finally { busy.value = false }
}
</script>

<template>
  <div v-if="ready" class="arow" data-test="agenda-settings" :data-on="on ? '1' : '0'">
    <div class="line">
      <div class="main">
        <b>{{ on ? '약속 알림 · 켜짐' : '약속 알림 · 꺼짐' }}</b>
        <small>메일과 팀 대화방에서 정한 약속을 그날 아침 8시와 시작 전에 알려 드려요</small>
      </div>
      <button class="switch" :class="{ on }" role="switch" :aria-checked="on" aria-label="약속 알림" :disabled="busy" data-test="agenda-switch" @click="save({ on: !on })"><i /></button>
    </div>
    <div v-if="on" class="line lead">
      <span>시작 전 알림</span>
      <select :value="lead" class="sel" aria-label="시작 전 알림" :disabled="busy" data-test="agenda-lead" @change="save({ leadMin: Number($event.target.value) })">
        <option v-for="n in choices" :key="n" :value="n">{{ label(n) }}</option>
      </select>
    </div>
    <small v-if="err" class="err" role="status">{{ err }}</small>
  </div>
</template>

<style scoped>
.arow { display: flex; flex-direction: column; gap: 10px; padding: 18px 0; border-top: 1px solid var(--hairline); color: var(--text-primary); min-width: 0; }
.line { display: flex; align-items: center; gap: 14px; min-width: 0; }
.main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.main b { font-weight: 450; font-size: 16px; overflow-wrap: anywhere; }
.main small { color: var(--text-secondary); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.lead span { flex: 1; color: var(--text-secondary); font-size: 14px; }
.sel { height: 36px; border-radius: 10px; padding: 0 10px; font-size: 14px; border: 1px solid var(--hairline); background: var(--cell-bg, transparent); color: var(--text-primary); }
.switch { width: 52px; height: 30px; border-radius: 9999px; background: var(--field-bg); position: relative; transition: background-color .25s; flex: none; }
.switch i { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0 0 0 / .25); transition: left .25s var(--spring); }
.switch.on { background: var(--ink); }
.switch.on i { left: 25px; }
.err { color: var(--color-error); font-size: 13px; }
</style>
