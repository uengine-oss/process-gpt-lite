<script setup>
import ActionCard from './ActionCard.vue'
import NotificationCard from './NotificationCard.vue'
import WeatherPanel from './WeatherPanel.vue'
import PanelFrame from './PanelFrame.vue'
import PanelAppCard from './panelApps/PanelAppCard.vue'
import Icon from './Icon.vue'
import { computed } from 'vue'
import { useApp } from '../stores/app.js'

const app = useApp()
// a work item that already has a notification card is not listed twice
const todos = computed(() => app.todos.filter((t) => !app.handled.includes(t.id) && !app.notifications.some((n) => n.todoId === t.id)).slice(0, 3))
</script>

<template>
  <aside class="dock scroll">
    <TransitionGroup name="arc" tag="div" class="stack">
      <NotificationCard v-for="n in app.notifications.slice(0, 6)" :key="'n' + n.id" :n="n" />
      <button v-for="t in todos" :key="'t' + t.id" class="act glass press" @click="app.openTodo(t)">
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
.stack { display: flex; flex-direction: column; gap: 10px; position: relative; }
.act { display: block; width: 100%; text-align: left; border-radius: 24px; padding: 17px 16px 19px 22px; font-size: 16px; line-height: 34px; color: var(--text-primary); }
.act .verb { display: inline-block; height: 34px; line-height: 34px; padding: 0 8px; border-radius: 8px; background: var(--color-attention); color: #fff; margin-right: 8px; font-weight: 450; vertical-align: top; }
.act .txt { line-height: 1.75; }
.act .due { display: block; color: var(--text-secondary); line-height: 1.6; }
.new { height: 64px; border-radius: 24px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 17px; color: var(--text-primary); }
.new.on { color: var(--text-tertiary); }
</style>
