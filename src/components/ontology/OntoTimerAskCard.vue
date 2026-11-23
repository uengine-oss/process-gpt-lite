<script setup>
// 들어온 메일이 정해진 때마다 하는 일일 때(design-v0.3 §15, server lib/ontology/timers.js recurFromMail): 「매주 월 9시 ·
// 주간 공정 보고 — 예약을 걸까요?」. 걸면 받은 사람의 예약이 되고, 그 예약은 회사 지도의 타이머 사건이다.
import { computed, ref } from 'vue'
import { api } from '../../api.js'

const props = defineProps({ msg: Object })
const c = computed(() => props.msg.content || {})
const busy = ref(false)
const err = ref('')
const mine = ref('') // the answer right after it is given, until the card's own update arrives
const state = computed(() => (c.value.state !== 'ask' ? c.value.state : mine.value || 'ask'))

async function schedule() {
  err.value = ''; busy.value = true
  try { await api('/ontology/timers/from-mail', { method: 'POST', body: { messageId: props.msg.id } }); mine.value = 'scheduled' } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="otc" data-testid="onto-timer-card" :data-state="state">
    <span class="badge">메일 · 정해진 때</span>
    <p class="txt">{{ c.mail?.subject ? `「${c.mail.subject}」 메일은` : '이 메일은' }} <b>{{ c.when }}</b>마다 하는 일을 부탁하고 있어요.</p>
    <div class="what">
      <span class="when">{{ c.when }}</span>
      <span class="act">{{ c.task }}</span>
      <small v-if="c.says" class="says">메일: “{{ c.says }}”</small>
    </div>
    <div v-if="state === 'ask'" class="btns">
      <button class="pill yes press" :disabled="busy" data-testid="onto-timer-schedule" @click="schedule">{{ busy ? '거는 중…' : '예약 걸기' }}</button>
      <button class="pill press" :disabled="busy" data-testid="onto-timer-skip" @click="mine = 'skipped'">아니요</button>
    </div>
    <p v-else-if="state === 'scheduled'" class="done" data-testid="onto-timer-done">{{ c.when }}에 「{{ c.task }}」 예약을 걸었어요. 회사 지도에는 타이머 사건으로 남아요.</p>
    <p v-else class="done">예약하지 않았어요.</p>
    <small v-if="err" class="why">{{ err }}</small>
  </div>
</template>

<style scoped>
.otc { word-break: keep-all; overflow-wrap: anywhere; width: 424px; max-width: 100%; display: flex; flex-direction: column; gap: 10px; padding: 16px 16px 14px; border-radius: 24px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); }
.badge { font-size: 12px; color: var(--text-secondary); letter-spacing: .04em; }
.txt { margin: 0; font-size: 15.5px; line-height: 1.6; }
.what { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px; border-radius: 14px; background: var(--field-bg); }
.when { font-size: 12.5px; color: var(--text-secondary); }
.act { font-size: 14.5px; font-weight: 500; line-height: 1.5; }
.says { font-size: 12.5px; color: var(--text-tertiary); }
.btns { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { height: 36px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); color: var(--text-primary); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); }
.pill.yes { background: var(--ink); color: var(--ink-inverse); }
.pill:disabled { opacity: .55; }
.why { font-size: 12px; color: var(--text-tertiary); line-height: 1.45; }
.done { margin: 0; font-size: 13px; color: var(--text-secondary); }
</style>
