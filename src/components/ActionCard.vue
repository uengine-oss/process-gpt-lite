<script setup>
import { computed, ref } from 'vue'
import { useApp } from '../stores/app.js'
import { useSwipeAway } from '../swipeAway.js'

const props = defineProps({ action: Object })
const app = useApp()
const verbs = { Reply: '답장', Pay: '납부', Release: '처리', Remind: '알림', Add: '추가', Review: '검토', Call: '전화', Book: '예약', Sign: '서명' }
// a sender's logo through the favicon service — never for a demo mailbox (its senders are fictional,
// and a made-up domain can belong to a real company) nor a reserved example domain: a letter tile then
const RESERVED = /(^|\.)(example|test|invalid|localhost)$|(^|\.)example\.(com|net|org)$/i
const icon = computed(() => {
  const d = String(props.action.icon || '').toLowerCase()
  if (!d || app.me?.mail?.provider === 'demo' || RESERVED.test(d)) return null
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64`
})
const tile = computed(() => !!(props.action.icon || props.action.source?.from))
const iconFailed = ref(false)
const letter = computed(() => (props.action.icon || props.action.source?.from || '?').replace(/^www\./, '').charAt(0).toUpperCase())
// the model may return ISO timestamps or free text; show dates the way people say them
const due = computed(() => {
  const d = props.action.due
  if (!d) return ''
  const t = new Date(d)
  return isNaN(t) ? d : t.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })
})
// a card made from a mail opens that mail and its reply (MailReplySheet): nothing runs, nothing is sent
// until 보내기 — the agent once sent a card's reply the moment the card was tapped (2026-11-23)
// Home is notifications: the card is put away with its ✕ or a sideways swipe; a mail's card stays in
// 팀 메시지 › 받은 편지함 (2026-11-23)
const sw = useSwipeAway(() => app.dismissAction(props.action))
const card = sw.el
const { down, move, up } = sw
function tap() {
  if (sw.swiped()) return
  if (props.action.source?.mail_id) app.mailCard = props.action
  else if (props.action.status === 'open') app.runAction(props.action)
}
</script>

<template>
  <button ref="card" class="act glass press" :class="{ running: action.status === 'running', swiping: sw.swiping.value }" :style="sw.style.value" data-test="action-card"
    @click="tap" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
    <span class="verb" :title="verbs[action.verb] || ''">{{ action.verb }}</span>
    <img v-if="icon && !iconFailed" :src="icon" class="ico" alt="" @error="iconFailed = true" />
    <span v-else-if="tile" class="ico letter">{{ letter }}</span>
    <span class="txt" :class="{ 'shimmer-text': action.status === 'running' }">{{ action.text }}</span>
    <span v-if="due" class="due">{{ due }}</span>
    <span class="x" role="button" aria-label="닫기" data-test="action-close" @click.stop="app.dismissAction(action)">×</span>
  </button>
</template>

<style scoped>
.act { position: relative; display: block; width: 100%; text-align: left; border-radius: 24px; padding: 17px 16px 19px 22px; font-size: 16px; line-height: 34px; color: var(--text-primary); }
.verb { display: inline-block; height: 34px; line-height: 34px; padding: 0 8px; border-radius: 8px; background: var(--chip-bg); margin-right: 8px; font-weight: 450; vertical-align: top; }
.ico { width: 24px; height: 24px; border-radius: 9999px; vertical-align: -6px; margin-right: 8px; background: #fff; }
.letter { display: inline-grid; place-items: center; font-size: 12px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #7d8fb8, #4b5d8c); }
.txt { line-height: 1.75; }
.due { display: block; color: var(--text-secondary); line-height: 1.6; }
.x { position: absolute; top: 8px; right: 12px; width: 24px; height: 24px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-tertiary); opacity: 0; transition: opacity .2s; font-size: 18px; line-height: 1; }
.act:hover .x { opacity: 1; }
/* a phone has no hover: the ✕ is always there (and the card swipes away) */
@media (hover: none) { .x { opacity: 1; } }
.act { touch-action: pan-y; }
.act.swiping { user-select: none; }
.act { padding-right: 40px; }
.running { cursor: default; }
</style>
