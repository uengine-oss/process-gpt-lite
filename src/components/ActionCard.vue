<script setup>
import { computed, ref, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useApp } from '../stores/app.js'
import { useSwipeAway } from '../swipeAway.js'
import Icon from './Icon.vue'
import { verbLabel } from '../mailKind.js'

const props = defineProps({ action: Object })
const app = useApp()
// the button word in the person's language — 「일정 추가」 for a card that puts an event on the calendar (src/mailKind.js)
const verb = computed(() => verbLabel(props.action))
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
// a mail that belongs to a process instance (server lib/mailFlow.js — started or joined from its sheet, by itself in the 자동 stage, or a
// new mail of its thread) opens that instance: its work happens on its page (2026-11-18); the mail is the first thing there
const router = useRouter()
const inst = computed(() => (props.action.source?.inst?.instId ? props.action.source.inst : null))
// what the company's process map read the mail as (kept on the card): the sheet asks 「진행할까요?」, the card says it in a line
const offer = computed(() => {
  const f = props.action.source?.flow
  if (inst.value || !f || f.declined) return null
  return (f.matches || []).find((m) => m.stage === 'adopted' || m.stage === 'suggested') || null
})
function tap() {
  if (sw.swiped()) return
  if (inst.value) return router.push(`/routines/${encodeURIComponent(inst.value.instId)}`)
  if (props.action.source?.mail_id) { app.mailCardFrom = 'home'; app.mailCard = props.action }
  else if (props.action.status === 'open') app.runAction(props.action)
}
// the mail sheet's 「Home 카드로」: this card comes into view and lights up once
const flash = ref(false)
watch(() => app.flashCard, async (id) => {
  if (id !== props.action.id) return
  await nextTick()
  card.value?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  flash.value = true
  setTimeout(() => { flash.value = false; if (app.flashCard === props.action.id) app.flashCard = null }, 2200)
}, { immediate: true })
</script>

<template>
  <button ref="card" class="act glass press" :class="{ running: action.status === 'running', swiping: sw.swiping.value, flash }" :style="sw.style.value" data-test="action-card"
    :data-action-id="action.id" @click="tap" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
    <span class="verb" data-test="action-verb">{{ verb }}</span>
    <img v-if="icon && !iconFailed" :src="icon" class="ico" alt="" @error="iconFailed = true" />
    <span v-else-if="tile" class="ico letter">{{ letter }}</span>
    <span class="txt" :class="{ 'shimmer-text': action.status === 'running' }">{{ action.text }}</span>
    <span v-if="due" class="due">{{ due }}</span>
    <span v-if="inst" class="link" data-test="action-inst"><Icon name="refresh" :size="14" /> <span>루틴 · {{ inst.name || '진행 중인 일' }}</span></span>
    <span v-else-if="offer" class="link offer" data-test="action-offer"><Icon name="refresh" :size="14" /> <span>‘{{ offer.name }}’의 시작으로 보여요</span></span>
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
.link { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: var(--text-secondary); font-size: 13.5px; line-height: 1.5; overflow-wrap: anywhere; }
.link > :deep(svg) { flex: none; }
.link.offer { color: var(--text-tertiary); }
/* the mail sheet's 「Home 카드로」: a ring that holds, then fades */
.act.flash { animation: card-flash 2.2s ease-out both; }
@keyframes card-flash {
  0%, 65% { box-shadow: 0 0 0 3px rgba(60 110 240 / .85), 0 8px 30px rgba(60 110 240 / .25); }
  100% { box-shadow: 0 0 0 0 rgba(60 110 240 / 0), 0 8px 30px rgba(60 110 240 / 0); }
}
@media (prefers-reduced-motion: reduce) { .act.flash { animation: none; box-shadow: 0 0 0 3px rgba(60 110 240 / .85); } }
</style>
