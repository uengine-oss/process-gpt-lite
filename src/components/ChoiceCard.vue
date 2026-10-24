<script setup>
import { ref, computed } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

// A pick-one question from the browser agent (e.g. which account to sign in with), answered in place.
const props = defineProps({ msg: Object })
const c = computed(() => props.msg.content)
const pick = ref(null)
const busy = ref(false)
const site = computed(() => (c.value.site || '').replace(/^www\./, ''))
async function send(value = pick.value) {
  busy.value = true
  try { await api(`/choices/${props.msg.id}`, { method: 'POST', body: { value } }) } finally { busy.value = false }
}
</script>

<template>
  <div v-if="c.state === 'answered'" class="done blur-in"><Icon name="check" :size="16" /> {{ c.value }}</div>
  <div v-else class="choice glass">
    <div class="h">
      <img v-if="site" :src="`https://www.google.com/s2/favicons?domain=${site}&sz=64`" alt="" />
      <span>{{ site || '확인 필요' }}</span>
    </div>
    <p>{{ c.question }}</p>
    <!-- an approval (payment, sending) is a yes/no, answered with one tap -->
    <div v-if="c.approval" class="foot two">
      <button type="button" class="ghost-btn" :disabled="busy" @click="send('취소')">취소</button>
      <button type="button" class="dark-btn" :disabled="busy" @click="send('승인')">승인</button>
    </div>
    <template v-else>
      <button v-for="o in c.options" :key="o" type="button" class="opt press" :class="{ on: pick === o }" @click="pick = o">
        <span class="radio" />{{ o }}
      </button>
      <div class="foot"><button class="dark-btn" :disabled="!pick || busy" @click="send()">확인</button></div>
    </template>
    <div class="by">보안 제공: <span class="serif">process gpt</span></div>
  </div>
</template>

<style scoped>
.choice { width: 424px; max-width: 100%; border-radius: 24px; padding: 18px 18px 12px; display: flex; flex-direction: column; gap: 10px; --regular-bg: var(--bubble-agent-bg); }
.h { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 500; }
.h img { width: 20px; height: 20px; border-radius: 5px; }
p { margin: 0; font-size: 15px; line-height: 1.5; white-space: pre-line; }
.two { gap: 8px; }
.ghost-btn { height: 44px; padding: 0 18px; border-radius: 9999px; background: var(--field-bg); font-size: 15px; }
.opt { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; background: var(--field-bg); font-size: 15px; text-align: left; border: 1.5px solid transparent; }
.opt.on { border-color: var(--text-primary); }
.radio { width: 16px; height: 16px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--text-secondary); flex: none; }
.opt.on .radio { box-shadow: inset 0 0 0 5px var(--text-primary); }
.foot { display: flex; justify-content: flex-end; }
.by { text-align: center; font-size: 13px; color: var(--text-secondary); border-top: 1px solid var(--hairline); padding-top: 10px; }
.done { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px; border-radius: 9999px; background: var(--bubble-user-bg); font-size: 14px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
</style>
