<script setup>
import ActionCard from './ActionCard.vue'
import HomeTodoCard from './HomeTodoCard.vue'
import NotificationCard from './NotificationCard.vue'
import WeatherPanel from './WeatherPanel.vue'
import PanelFrame from './PanelFrame.vue'
import PanelAppCard from './panelApps/PanelAppCard.vue'
import Icon from './Icon.vue'
import RefreshBanner from './RefreshBanner.vue'
import InstallNudge from './InstallNudge.vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useApp } from '../stores/app.js'
import { useTeam } from '../stores/team.js'
import { narrow } from '../viewport.js'
import NotifyCard from './NotifyCard.vue'
import { permission as notifyPermission, iosNeedsHomeScreen } from '../browserNotify.js'
import { nudgeHere } from '../install.js'
import { usePullRefresh, refreshHome, homeBanner, mailBusy, PULL_THRESHOLD } from '../pullRefresh.js'

const app = useApp()
const team = useTeam()
const router = useRouter()
// pull to refresh (touch): the lists again, and new mail when a mailbox is connected (src/pullRefresh.js)
const dockEl = ref(null)
const { pull, state: pullState, dragging } = usePullRefresh(dockEl, () => refreshHome(app), { enabled: () => !mailBusy.value })
// the arrow points down and turns up as the pull reaches the point where letting go refreshes
const arrowTurn = computed(() => 180 + Math.min(1, pull.value / PULL_THRESHOLD) * 180)
// a work item that already has a notification card is not listed twice
// notifications on this device (components/NotifyCard.vue): offered until the person answers the browser's question; right after they
// turn it on, 「시험 알림 보내기」 until the card is closed; on an iPhone outside a Home Screen web app, how it works there (until closed)
const notify = ref(notifyPermission())
const justOn = ref(false)
const IOS_SEEN = 'pgl-notify-ios-seen'
const iosSeen = ref((() => { try { return localStorage.getItem(IOS_SEEN) === '1' } catch { return false } })())
const notifyMode = computed(() => {
  if (iosNeedsHomeScreen() && notify.value !== 'granted') return iosSeen.value ? '' : 'ios'
  if (notify.value === 'default') return 'ask'
  return notify.value === 'granted' && justOn.value ? 'on' : ''
})
function notifyChanged(p) { notify.value = p; justOn.value = p === 'granted' }
function notifyClose() {
  if (notifyMode.value === 'ios') { iosSeen.value = true; try { localStorage.setItem(IOS_SEEN, '1') } catch { /* asked again next visit */ } }
  justOn.value = false
}
// 앱 설치 안내 (src/install.js): until installed, 「나중에」 or 「다시 보지 않기」
const installCard = computed(() => nudgeHere('home'))
// (a work item put away from Home — its card or its notice — stays in 루틴, not here)
const todos = computed(() => app.todos.filter((t) => !t.home_hidden && !app.handled.includes(t.id) && !app.notifications.some((n) => n.todoId === t.id)).slice(0, 3))
// a mail's card whose instance already has its own Home card (a mail that started a process by itself, a new mail of its thread:
// server lib/mailFlow.js) is not listed twice; the card the mail sheet's 「Home 카드로」 asks for is listed even past the first five
const actions = computed(() => {
  const noticed = (id) => app.notifications.some((n) => n.url === `/routines/${id}` || n.instId === id)
  const list = app.actions.filter((a) => !(a.source?.inst?.instId && noticed(a.source.inst.instId)) || a.id === app.flashCard)
  const top = list.slice(0, 5)
  const asked = app.flashCard && list.find((a) => a.id === app.flashCard)
  return asked && !top.includes(asked) ? [...top, asked] : top
})
// a to-do opens its instance page, where its form is (not a card in the chat)
async function openTodo(t) {
  const instId = t.proc_inst_id || (await app.openTodo(t).catch(() => null))?.instId
  if (instId) router.push(`/routines/${encodeURIComponent(instId)}`)
}
</script>

<template>
  <aside ref="dockEl" class="dock scroll">
    <!-- pull to refresh: the indicator in the space the list is pulled away from -->
    <div class="ptr" :class="{ live: dragging }"
      :style="{ height: pull + 'px', opacity: Math.min(1, pull / 40) }" aria-hidden="true">
      <span v-if="pullState === 'running'" class="knob glass"><span class="ring" /></span>
      <template v-else>
        <span class="knob glass"><span class="arrow" :style="{ transform: `rotate(${arrowTurn}deg)` }"><Icon name="up" :size="18" /></span></span>
        <small v-if="pull > 44">{{ pullState === 'armed' ? '놓으면 새로고침' : '당겨서 새로고침' }}</small>
      </template>
    </div>
    <TransitionGroup name="arc" tag="div" class="stack" :class="{ live: dragging }"
      :style="pull ? { transform: `translateY(${pull}px)` } : null">
      <RefreshBanner v-if="homeBanner" key="ptr-banner" :banner="homeBanner" />
      <!-- phone: the team messenger's entry (the top bar has no room for it) -->
      <button v-if="narrow" key="team" class="msgs glass press" @click="team.openMessenger()">
        <Icon name="team" :size="20" /> 팀 메시지<i v-if="team.unread.total">{{ team.unread.total }}</i>
      </button>
      <NotifyCard v-if="notifyMode" key="notify" place="home" :mode="notifyMode" @changed="notifyChanged" @close="notifyClose" />
      <InstallNudge v-if="installCard" key="install" place="home" />
      <NotificationCard v-for="n in app.notifications.slice(0, 6)" :key="'n' + n.id" :n="n" />
      <HomeTodoCard v-for="t in todos" :key="'t' + t.id" :todo="t" @open="openTodo" />
      <ActionCard v-for="a in actions" :key="a.id" :action="a" />
      <WeatherPanel key="weather" />
      <PanelAppCard v-for="a in app.panelApps" :key="'pa' + a.id" :app="a" />
      <PanelFrame v-for="p in app.panels" :key="p.id" :panel="p" />
      <button key="new" class="new glass press" :class="{ on: app.panelMode }" @click="app.panelMode = !app.panelMode">
        <Icon name="plus" :size="22" /> 새 패널 만들기
      </button>
    </TransitionGroup>
  </aside>
</template>

<style scoped>
.dock { position: absolute; z-index: 5; top: 0; bottom: 0; left: 0; width: 420px; padding: 84px 16px 114px;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 76px, #000 calc(100% - 60px), transparent);
  mask-image: linear-gradient(to bottom, transparent 0, #000 76px, #000 calc(100% - 60px), transparent); }
.dock.mobile { width: auto; right: 0; padding: 84px 16px 112px; }
/* the pull belongs to this list: a drag past its top does not reach the page (a browser tab's own
   pull-to-refresh would reload everything) */
.dock { overscroll-behavior-y: contain; }
/* never sideways: one card wider than the phone (a notice carrying a long id) made the whole Home
   slide left under a finger and hid that card's ✕ off screen (2026-11-21 phone review) */
.dock { overflow-x: hidden; }
.stack > * { min-width: 0; max-width: 100%; }
/* a card going away keeps its width while it fades (position: absolute alone shrinks it to its text),
   and the cards under it slide up into the gap (arc-move) */
.stack > .arc-leave-active { left: 0; right: 0; }
.stack { display: flex; flex-direction: column; gap: 10px; position: relative; }
.stack:not(.live) { transition: transform .32s var(--spring); }
.ptr { position: absolute; top: 84px; left: 0; right: 0; display: flex; align-items: flex-end; justify-content: center; gap: 10px;
  padding-bottom: 8px; overflow: hidden; pointer-events: none; transition: height .32s var(--spring), opacity .2s; }
.ptr.live { transition: none; }
.ptr .knob { flex: none; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; color: var(--text-primary); }
.ptr .arrow { display: grid; place-items: center; transition: transform .12s ease-out; }
.ptr small { height: 36px; line-height: 36px; font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
.ptr .ring { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--text-tertiary); border-top-color: var(--text-primary); animation: spin .8s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .stack:not(.live), .ptr, .ptr .arrow { transition: none; }
  .ptr .ring { animation-duration: 2.4s; }
}
.msgs { height: 56px; border-radius: 22px; display: flex; align-items: center; gap: 8px; padding: 0 20px; font-size: 16px; color: var(--text-primary); }
.msgs i { margin-left: auto; font-style: normal; min-width: 22px; height: 22px; line-height: 22px; padding: 0 6px; border-radius: 11px; background: #e5484d; color: #fff; font-size: 12px; text-align: center; }
.new { height: 64px; border-radius: 24px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 17px; color: var(--text-primary); }
.new.on { color: var(--text-tertiary); }
</style>
