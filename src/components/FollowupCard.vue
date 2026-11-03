<script setup>
// 후행 습관: 결과물이 나온 뒤 평소 하던 다음 일을 먼저 묻는 카드(server lib/followups.js). 눌러야 실행한다. 말로 답해도 된다.
import { computed, ref } from 'vue'
import { api } from '../api.js'

const props = defineProps({ msg: Object })
const c = computed(() => props.msg.content || {})
const busy = ref('')
const err = ref('')
const DONE = { accepted: '네, 하는 중이에요', declined: '이번에는 하지 않았어요', muted: '다시 묻지 않을게요', passed: '' }
const seenText = computed(() => (c.value.origin === 'told' ? '직접 말씀하신 습관' : `지금까지 ${c.value.seen}번 하셨어요`))
async function answer(choice) {
  err.value = ''; busy.value = choice
  try { await api(`/followups/answer/${props.msg.id}`, { method: 'POST', body: { choice } }) } catch (e) { err.value = e.message } finally { busy.value = '' }
}
</script>

<template>
  <div class="fu" data-testid="followup-card" :data-state="c.state">
    <div class="q">{{ c.text }}</div>
    <template v-if="c.state === 'pending'">
      <div class="btns">
        <button class="pill yes press" :disabled="!!busy" data-testid="followup-accept" @click="answer('accept')">네, 해 주세요</button>
        <button class="pill press" :disabled="!!busy" data-testid="followup-decline" @click="answer('decline')">아니요</button>
        <button class="pill press" :disabled="!!busy" data-testid="followup-mute" @click="answer('mute')">다시 묻지 않기</button>
      </div>
      <small class="why">{{ seenText }}</small>
    </template>
    <small v-else-if="DONE[c.state]" class="why" data-testid="followup-done">{{ DONE[c.state] }}</small>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.fu { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; max-width: 424px; }
.q { border-radius: 24px; padding: 13px 18px; font-size: 16px; line-height: 1.6; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); word-break: keep-all; overflow-wrap: anywhere; }
.btns { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { height: 36px; padding: 0 16px; border-radius: 9999px; background: var(--regular-solid-bg); color: var(--text-primary); font-size: 14px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .06); animation: pop-in .4s var(--spring) both; }
.pill.yes { background: var(--ink); color: var(--ink-inverse); }
.pill:disabled { opacity: .55; }
.why { margin-left: 8px; font-size: 12.5px; color: var(--text-tertiary); }
.err { margin-left: 8px; font-size: 12.5px; color: var(--color-error); }
</style>
