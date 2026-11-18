<script setup>
import ActionCard from './ActionCard.vue'
import NotificationCard from './NotificationCard.vue'
import WeatherPanel from './WeatherPanel.vue'
import PanelFrame from './PanelFrame.vue'
import PanelAppCard from './panelApps/PanelAppCard.vue'
import Icon from './Icon.vue'
import RefreshBanner from './RefreshBanner.vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useApp } from '../stores/app.js'
import { useTeam } from '../stores/team.js'
import { narrow } from '../viewport.js'
import { permission as notifyPermission, ask as askNotify } from '../browserNotify.js'
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
// browser notifications for a background tab: offered until the person answers the browser's question
const notify = ref(notifyPermission())
async function enableNotify() { notify.value = await askNotify() }
const todos = computed(() => app.todos.filter((t) => !app.handled.includes(t.id) && !app.notifications.some((n) => n.todoId === t.id)).slice(0, 3))
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
      <button v-if="notify === 'default'" key="notify" class="notify glass press" @click="enableNotify">
        <Icon name="bell" :size="18" /> 브라우저 알림 켜기 <small>다른 창을 보고 있을 때도 메시지·할 일을 알려 드려요</small>
      </button>
      <NotificationCard v-for="n in app.notifications.slice(0, 6)" :key="'n' + n.id" :n="n" />
      <button v-for="t in todos" :key="'t' + t.id" class="act glass press" @click="openTodo(t)">
        <span class="verb">{{ /결정|승인|검토|심사|판단/.test(t.activity_name) ? 'Review' : 'Submit' }}</span>
        <span class="txt">{{ t.activity_name }}</span>
        <span class="due">{{ t.proc_inst_name || t.def_name }}</span>
      </button>
      <ActionCard v-for="a in app.actions.slice(0, 5)" :key="a.id" :action="a" />
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
.act { display: block; width: 100%; text-align: left; border-radius: 24px; padding: 17px 16px 19px 22px; font-size: 16px; line-height: 34px; color: var(--text-primary); }
.act .verb { display: inline-block; height: 34px; line-height: 34px; padding: 0 8px; border-radius: 8px; background: var(--color-attention); color: #fff; margin-right: 8px; font-weight: 450; vertical-align: top; }
.act .txt { line-height: 1.75; }
.act .due { display: block; color: var(--text-secondary); line-height: 1.6; }
.notify { border-radius: 22px; padding: 14px 18px; text-align: left; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 15px; color: var(--text-primary); }
.notify small { flex-basis: 100%; color: var(--text-secondary); font-size: 12.5px; }
.msgs { height: 56px; border-radius: 22px; display: flex; align-items: center; gap: 8px; padding: 0 20px; font-size: 16px; color: var(--text-primary); }
.msgs i { margin-left: auto; font-style: normal; min-width: 22px; height: 22px; line-height: 22px; padding: 0 6px; border-radius: 11px; background: #e5484d; color: #fff; font-size: 12px; text-align: center; }
.new { height: 64px; border-radius: 24px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 17px; color: var(--text-primary); }
.new.on { color: var(--text-tertiary); }
</style>
