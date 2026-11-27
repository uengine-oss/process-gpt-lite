<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { safeMarkdown } from '../safeMarkdown.js'
import { hidePaths } from '../paths.js'
import Message from './Message.vue'
import Composer from './Composer.vue'
import EdgeBlur from './EdgeBlur.vue'
import Icon from './Icon.vue'
import RoomRuleBar from './RoomRuleBar.vue'
import BrowserDock from './BrowserDock.vue'
import TurnPlanCard from './TurnPlanCard.vue'
import TurnProgress from './TurnProgress.vue'
import { useApp } from '../stores/app.js'
import { dur, elapsed } from '../turnView.js'

const props = defineProps({ placeholder: String, emptyText: String, keepTop: Boolean })
const emit = defineEmits(['send', 'connect'])
const app = useApp()
const scroller = ref(null)
// (a project's plan is a row of its room, never a chat message — server lib/projectNote.js; the plan chip opens it)
const list = computed(() => (app.thread || []).filter((m) => m.kind !== 'note'))
const draft = computed(() => app.drafts[app.activeId])
const status = computed(() => app.status[app.activeId] || (app.active?.status === 'working' ? '작업하는 중' : null))
// (raw HTML in it reads as text; only plain document elements reach the page — src/safeMarkdown.js)
const md = (t) => safeMarkdown(hidePaths(t || ''), { html: 'text' })
// hark: a quiet date line where the day changes, and "읽음" under the last thing the user said
const dayOf = (m) => new Date(m.created_at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })
const newDay = (i) => i > 0 && dayOf(list.value[i]) !== dayOf(list.value[i - 1])
const lastUser = computed(() => [...list.value].reverse().find((m) => m.role === 'user')?.id)
// (not under a message the server has not saved yet: 새 프로젝트's first message while its room is made)
const seen = (m) => m.id === lastUser.value && !m.content?.local && (status.value || draft.value != null || list.value[list.value.length - 1]?.id !== m.id)
const needsInput = computed(() => app.active?.status === 'needs_input')
// a browser task at work: its thumbnail takes the place left of the composer (BrowserDock), 조치 필요 included
const browsing = computed(() => list.value.some((m) => m.kind === 'task' && ['running', 'needs_input'].includes(m.content?.state)))
// the turns running in this view (server lib/turnPlan.js): a plan card under each one's message, the pill and its panel for the newest
const turnsHere = computed(() => app.viewTurns)
const liveTurn = computed(() => turnsHere.value[turnsHere.value.length - 1] || null)
const listed = computed(() => new Set(list.value.map((m) => m.id)))
const cardsUnder = (id) => turnsHere.value.filter((t) => t.msgId === id)
// (a turn whose message is not on screen yet — it is being saved — goes above the draft)
const loose = computed(() => turnsHere.value.filter((t) => !t.msgId || !listed.value.has(t.msgId)))
// one clock for the cards, the panel and the pill while something runs
const now = ref(Date.now())
let tick = null
watch(() => !!liveTurn.value, (on) => {
  clearInterval(tick)
  if (on) { now.value = Date.now(); tick = setInterval(() => { now.value = Date.now() }, 1000) }
}, { immediate: true })
onBeforeUnmount(() => clearInterval(tick))
const working = computed(() => (liveTurn.value?.stage?.text) || status.value || (draft.value === '' ? '생각하는 중' : null))
const panelTurn = computed(() => turnsHere.value.find((t) => t.turnId === app.turnPanel) || null)
function togglePanel() {
  if (!liveTurn.value) return
  app.turnPanel = app.turnPanel === liveTurn.value.turnId ? null : liveTurn.value.turnId
}
// 멈추기: an answer is being written (streaming here, or the thread is working) — not while it only waits for input
// (nothing to stop yet while 새 프로젝트's room is still being made); a turn still reading its message can be stopped too
const stoppable = computed(() => !needsInput.value && app.activeId !== app.draftProject?.tmp && (draft.value != null || app.active?.status === 'working' || !!liveTurn.value))
const stopping = ref(false)
async function stop() {
  stopping.value = true
  try { await app.stopTurn(app.activeId) } finally { setTimeout(() => { stopping.value = false }, 1500) }
}
// task: the browser task that waits (BrowserDock's orange ring) — its card says what to do
function toPending(task) {
  const el = (task === true && scroller.value?.querySelector('.k-task.needs')) || scroller.value?.querySelector('.k-vault, .k-choice, .needs')
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
// a notice over the composer goes by itself after a while (its height is measured: an open progress panel and the files' pile keep clear)
let noticeTimer
watch(() => app.notice, (v) => {
  clearTimeout(noticeTimer)
  if (v) noticeTimer = setTimeout(() => { if (app.notice === v) app.notice = null }, 9000)
  nextTick(measureFoot)
})

let stick = !props.keepTop
// kept at the bottom until the person scrolls up: the list growing under it (it moves the bottom away, not the scroll) does not let go
let lastTop = 0
function onScroll() {
  const el = scroller.value
  // (a scroll can land after the column is gone — leaving the chat for another tab mid-scroll)
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) stick = true
  else if (el.scrollTop < lastTop - 2) stick = false
  lastTop = el.scrollTop
}
// A draft bubble turning into its message shrinks and regrows the list in the middle of a smooth scroll, which then stops
// short of the bottom: once it has run, finish it.
let settle
let smoothAt = 0
async function toBottom(force) {
  await nextTick()
  const el = scroller.value
  if (!el || !(stick || force)) return
  if (force) stick = true
  if (!force) smoothAt = Date.now()
  el.scrollTo({ top: el.scrollHeight, behavior: force ? 'instant' : 'smooth' })
  clearTimeout(settle)
  settle = setTimeout(() => { if (stick && el.scrollHeight - el.scrollTop - el.clientHeight > 2) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) }, 500)
}
// Cards that fill in after they are drawn (a start card, a case, a file) grow the list once the conversation is open: kept at the
// bottom at once, not chased by a smooth scroll that shakes the screen and stops short — unless a new message is scrolling there now
const inner = ref(null)
let grown
onMounted(() => {
  grown = new ResizeObserver(() => {
    const el = scroller.value
    if (!el || !stick || Date.now() - smoothAt < 600) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight
  })
  if (inner.value) grown.observe(inner.value)
})
onBeforeUnmount(() => grown?.disconnect())
// Where the composer is (the files' pile in the #aside slot keeps clear of it — src/artifactScope.js pilePlace): how far its top is
// from the column's bottom (it grows with what is typed, and with the row over its box), how far its box's top is (without that row),
// how much room is right of it, and how tall a notice over it is (0 when there is none)
const colEl = ref(null)
const footEl = ref(null)
const noticeEl = ref(null)
const foot = ref({ top: 84, box: 84, gutter: 0, notice: 0 })
let footObs
let colH = 0
function measureFoot() {
  const c = colEl.value?.getBoundingClientRect(), f = footEl.value?.getBoundingClientRect()
  if (!c || !f || !c.width) return
  const b = footEl.value.querySelector('.composer > .box')?.getBoundingClientRect()
  const next = { top: Math.round(c.bottom - f.top), box: Math.round(c.bottom - (b?.top ?? f.top)), gutter: Math.round(c.right - f.right),
    notice: app.notice && noticeEl.value ? noticeEl.value.offsetHeight : 0 }
  const resized = colH && Math.round(c.height) !== colH
  colH = Math.round(c.height)
  const moved = next.top !== foot.value.top
  if (moved || ['box', 'gutter', 'notice'].some((k) => next[k] !== foot.value[k])) foot.value = next
  // the list ends above the composer (its padding follows the foot — --foot-top): a list kept at the bottom stays there when the row over
  // the box comes, goes or folds for typing, and when a phone's keyboard makes the page shorter
  if (moved || resized) nextTick(() => { const el = scroller.value; if (el && stick && Date.now() - smoothAt >= 600) el.scrollTop = el.scrollHeight })
}
onMounted(() => {
  footObs = new ResizeObserver(measureFoot)
  if (footEl.value) footObs.observe(footEl.value)
  if (colEl.value) footObs.observe(colEl.value)
  measureFoot()
})
onBeforeUnmount(() => footObs?.disconnect())
// a conversation's messages arriving (none before) go straight to the bottom; a new message after that scrolls there
watch(() => [list.value.length, draft.value], ([n], old) => toBottom(!props.keepTop && !old?.[0] && n > 0))
// a task card that starts waiting or ends grows by its reason and the button that answers it: on a phone that part fell
// under the composer while the card above it said 「로그인 필요」 (2026-11-21) — keep it in sight (again once the frame loads)
const settled = computed(() => list.value.filter((m) => m.kind === 'task' && ['needs_input', 'failed', 'needs_review', 'done'].includes(m.content?.state))
  .map((m) => `${m.id}:${m.content.state}:${m.content.need || ''}`).join(','))
// (only a card already in the chat that changed state — not the first load, whose own scroll and a tap on the
// waiting ring must not be pulled back down)
watch(settled, (now, before) => {
  const was = new Map((before || '').split(',').filter(Boolean).map((x) => [x.split(':')[0], x]))
  const changed = (now || '').split(',').filter(Boolean).some((x) => was.has(x.split(':')[0]) ? was.get(x.split(':')[0]) !== x : false)
  const shownBefore = (now || '').split(',').filter(Boolean).some((x) => !was.has(x.split(':')[0]) && runningSeen.has(x.split(':')[0]))
  if (changed || shownBefore) { toBottom(false); setTimeout(() => toBottom(false), 450) }
})
// cards seen while still running: their first settled state is a change the person is watching
const runningSeen = new Set()
watch(() => list.value.filter((m) => m.kind === 'task' && m.content?.state === 'running').map((m) => m.id).join(','), (ids) => { for (const id of ids.split(',').filter(Boolean)) runningSeen.add(id) }, { immediate: true })
watch(() => app.activeId, () => toBottom(!props.keepTop), { immediate: true })
</script>

<template>
  <section ref="colEl" class="col" :style="{ '--foot-top': `${foot.top}px`, '--notice-room': `${foot.notice ? foot.notice + 12 : 0}px` }">
    <EdgeBlur side="top" />
    <div ref="scroller" class="scroll msgs" :class="{ dim: app.panelMode }" @scroll="onScroll">
      <div ref="inner" class="inner">
        <slot name="header" />
        <RoomRuleBar v-if="app.active?.kind === 'project' && app.activeId" :thread="app.activeId" />
        <p v-if="!list.length && emptyText" class="empty serif">{{ emptyText }}</p>
        <template v-for="(m, i) in list" :key="m.id">
          <div v-if="newDay(i)" class="day">{{ dayOf(m) }}</div>
          <Message :msg="m" @connect="emit('connect')" />
          <div v-if="seen(m)" class="seen">··· 읽음</div>
          <TurnPlanCard v-for="t in cardsUnder(m.id)" :key="t.turnId" :turn="t" :now="now" @details="app.turnPanel = $event" />
        </template>
        <TurnPlanCard v-for="t in loose" :key="t.turnId" :turn="t" :now="now" @details="app.turnPanel = $event" />
        <div v-if="draft" class="row"><div class="bubble md" v-html="md(draft)" /></div>
      </div>
    </div>
    <EdgeBlur side="bottom" :height="120" />
    <!-- beside the composer: the files this view made (MainView's ArtifactStack), placed by the composer's box -->
    <slot name="aside" :foot="foot" />
    <div ref="footEl" class="foot">
      <!-- a notice over the composer (it stands in for the progress pill while it shows) -->
      <Transition name="pill">
        <div v-if="app.notice" ref="noticeEl" key="notice" class="notice" role="alert" data-testid="chat-notice">{{ app.notice.text }}</div>
      </Transition>
      <TurnProgress v-if="panelTurn" :turn="panelTurn" :now="now" :stopping="stopping" @close="app.turnPanel = null" @stop="stop" />
      <button v-if="needsInput && !browsing" class="attn press" aria-label="조치 필요" @click="toPending"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3z" /></svg></button>
      <BrowserDock @pending="toPending(true)" />
      <!-- 2026-11-27 recording (「이 공간 지금 여기 너무 많이 잡아먹고 있어요」): what the agent is doing right now is one row with a phone's
           「기본」 chip over the box, and 멈추기 is the box's own ■ — two rows less than the pill, 멈추기 and the chip each on a row of
           their own; while typing on a phone the row folds (Composer.vue) -->
      <Composer :placeholder="placeholder" :status="!!working && !app.notice" :stoppable="stoppable" :stopping="stopping" @stop="stop" @send="(t, o) => emit('send', t, o)">
        <template #status>
          <!-- the pill opens the progress panel of the turn running here (TurnProgress) -->
          <button v-if="liveTurn" class="working press" data-testid="chat-working" :aria-expanded="!!panelTurn" aria-haspopup="dialog" @click="togglePanel">
            <span class="shimmer-text wt" data-testid="turn-pill">{{ working }}</span><span class="el">{{ dur(elapsed(liveTurn, now)) }}</span><Icon name="chevron" :size="12" class="chev" :class="{ open: !!panelTurn }" />
          </button>
          <div v-else class="working" data-testid="chat-working"><span class="shimmer-text wt">{{ working }}</span></div>
        </template>
      </Composer>
    </div>
  </section>
</template>

<style scoped>
.col { position: absolute; inset: 0; }
/* (the bottom: clear of the composer and the row over its box — a plan card's last line hid under the old pill row on a phone) */
.msgs { position: absolute; inset: 0; padding: 96px 0 max(130px, calc(var(--foot-top, 84px) + 18px)); transition: filter .5s, opacity .5s; }
.msgs.dim { filter: blur(14px); opacity: .55; pointer-events: none; }
.inner { width: 512px; max-width: calc(100% - 32px); margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.empty { text-align: center; color: var(--text-secondary); font-size: 22px; margin-top: 30vh; line-height: 1.4; }
.row { animation: blur-in .4s var(--spring) both; }
.bubble { max-width: 424px; border-radius: 24px; padding: 13px 18px; line-height: 1.6; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); }
.md :deep(p) { margin: 0 0 .6em; } .md :deep(p:last-child) { margin: 0; }
.status { font-size: 15px; padding: 4px 6px; color: var(--text-tertiary); }
.day { text-align: center; font-size: 12.5px; color: var(--text-tertiary); margin: 6px 0 -4px; }
.seen { align-self: flex-end; font-size: 12px; color: var(--text-tertiary); margin: -8px 6px 0; }
.attn { position: absolute; right: calc(100% + 10px); bottom: 6px; width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; background: var(--color-attention); color: #fff; box-shadow: 0 4px 16px rgba(0 0 0 / .18); animation: pop-in .4s var(--spring); }
@media (max-width: 760px) { .foot:has(.attn), .foot:has(.dock) { padding-left: 56px; } .attn { right: auto; left: 0; } }
/* the progress pill: on the row over the composer's box (Composer #status), as tall as a phone's 「기본」 chip beside it; its words shorten
   before the chip moves (design turnplan §3.3) */
.working { height: 30px; max-width: 100%; min-width: 0; padding: 0 14px; border-radius: 15px; display: inline-flex; align-items: center; gap: 7px;
  border: 1px solid var(--hairline, rgba(127, 127, 127, .3)); background: var(--thin-bg, rgba(127, 127, 127, .06)); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
  font-size: 13.5px; color: var(--text-tertiary); white-space: nowrap; animation: pop-in .3s var(--spring); }
/* (a button: its words a step darker than a plain line, which read faintly over a light sky in the dark theme) */
button.working { padding: 0 10px 0 14px; cursor: pointer; color: var(--text-secondary); }
.working .wt { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.working .el { flex: none; font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.working .chev { flex: none; rotate: -90deg; transition: rotate .2s; }
.working .chev.open { rotate: 90deg; }
.notice { position: absolute; left: 4px; right: 4px; bottom: calc(100% + 12px); padding: 10px 16px; border-radius: 18px; font-size: 14px; line-height: 1.45; color: #fff;
  background: var(--color-attention); box-shadow: 0 4px 16px rgba(0 0 0 / .14); word-break: keep-all; overflow-wrap: anywhere; }
.pill-enter-active, .pill-leave-active { transition: opacity .25s, translate .25s; }
.pill-enter-from, .pill-leave-to { opacity: 0; translate: 0 6px; }
.foot { position: absolute; z-index: 6; left: 50%; bottom: 32px; translate: -50% 0; width: 512px; max-width: calc(100% - 32px); }
</style>
