<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
import TaskCard from './TaskCard.vue'
import VaultCard from './VaultCard.vue'
import { useApp } from '../stores/app.js'

const app = useApp()
const all = computed(() => Object.values(app.messages).flat())
const msg = computed(() => all.value.find((m) => m.id === app.handoff))
// a pending credential request for this task is surfaced right here
const vaultReq = computed(() => all.value.find((m) => m.kind === 'vault' && m.content.taskId === app.handoff && m.content.state === 'pending'))
</script>

<template>
  <div v-if="msg" class="handoff" @keydown.esc="app.handoff = null">
    <button class="x press" aria-label="닫기" @click="app.handoff = null"><Icon name="close" :size="20" /></button>
    <div class="wrap">
      <TaskCard :msg="msg" full />
      <p v-if="msg.content.reason" class="reason">{{ msg.content.reason }}</p>
    </div>
    <Transition name="fade"><div v-if="vaultReq" class="vault"><VaultCard :msg="vaultReq" /></div></Transition>
  </div>
</template>

<style scoped>
.handoff { position: absolute; inset: 0; z-index: 50; background: rgba(5 7 13 / .82); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); display: grid; place-items: center; animation: fade-in .35s both; }
.wrap { animation: pop-in .45s var(--spring) both; }
.x { position: absolute; top: 16px; left: 16px; width: 48px; height: 48px; border-radius: 9999px; display: grid; place-items: center; background: rgba(255 255 255 / .92); color: #1d1d1f; }
.reason { text-align: center; color: rgba(245 245 247 / .7); font-size: 15px; margin-top: 14px; }
.vault { position: absolute; right: 32px; bottom: 32px; width: 360px; animation: pop-in .45s var(--spring) both; }
</style>
