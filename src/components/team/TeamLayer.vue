<script setup>
// The team layer over every page: the "메시지" button with its unread badge (in the top bar), the
// messenger sheet, the share picker and a short toast when something arrives.
import { onMounted } from 'vue'
import Icon from '../Icon.vue'
import Messenger from './Messenger.vue'
import SharePicker from './SharePicker.vue'
import { useTeam } from '../../stores/team.js'

// button: the top-bar entry (on a phone the entry is a Home card instead — the bar has no room)
defineProps({ narrow: Boolean, button: { type: Boolean, default: true } })
const team = useTeam()
onMounted(() => team.boot())
function go() {
  const g = team.toast?.go
  team.toast = null
  if (g?.threadId) team.openMessenger(g.threadId, g.messageId)
}
</script>

<template>
  <button v-if="button" class="msg-btn press" :class="{ narrow }" :aria-label="`팀 메시지${team.unread.total ? ` · 읽지 않음 ${team.unread.total}` : ''}`" @click="team.open ? (team.open = false) : team.openMessenger()">
    <Icon name="team" :size="19" /><span v-if="!narrow">메시지</span>
    <i v-if="team.unread.total" class="dot">{{ team.unread.total > 99 ? '99+' : team.unread.total }}</i>
  </button>
  <Teleport to="body">
    <Transition name="fade"><Messenger v-if="team.open" /></Transition>
    <SharePicker v-if="team.sharing" />
    <Transition name="toast">
      <button v-if="team.toast" class="team-toast glass press" @click="go">
        <Icon name="team" :size="16" /> {{ team.toast.text }}<span v-if="team.toast.go?.threadId" class="go">열기 →</span>
      </button>
    </Transition>
  </Teleport>
</template>

<style scoped>
.msg-btn { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 48px; padding: 0 16px; border-radius: 24px; font-size: 15px; font-weight: 500;
  color: var(--text-primary); background: var(--button-bg); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.msg-btn.narrow { width: 48px; padding: 0; justify-content: center; }
.dot { position: absolute; top: -2px; right: -2px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: #e5484d; color: #fff; font-style: normal; font-size: 11.5px; line-height: 20px; text-align: center; box-shadow: 0 0 0 2px var(--composer-bg, #fff); animation: pop-in .35s var(--spring); }
.team-toast { position: fixed; z-index: 80; top: 78px; left: 50%; translate: -50% 0; max-width: min(520px, calc(100vw - 32px)); display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 18px;
  font-size: 14px; color: var(--text-primary); box-shadow: 0 10px 34px rgba(0, 0, 0, .18); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.team-toast .go { margin-left: 6px; color: #2a78d6; font-weight: 500; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-8px); }
.toast-enter-active, .toast-leave-active { transition: opacity .2s, transform .25s var(--spring); }
</style>
