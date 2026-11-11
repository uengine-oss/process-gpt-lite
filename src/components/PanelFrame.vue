<script setup>
// A Home panel: the built-in panels app (server/lib/apps/builtin/panels) shown by the MCP Apps host — its
// entry tool panel_view hands the screen this panel's html, script and data; what the panel may do are
// that app's tools, as the panel's owner.
import { ref, computed } from 'vue'
import Icon from './Icon.vue'
import AppFrame from '../apps/AppFrame.vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'

const PANELS = { id: 'panels', entry: 'panel_view', name: { ko: '홈 패널', en: 'Home panels' } }
const props = defineProps({ panel: Object })
const app = useApp()
const height = ref(120)
const menu = ref(false)
const params = computed(() => ({ id: props.panel.id }))
// Rebuild only when the panel's code changes; data saves must not reload it.
const codeKey = computed(() => props.panel.spec?.html + props.panel.spec?.script)
const onSize = (s) => { if (s?.height) height.value = Math.min(Math.max(s.height, 40), 640) }

function ask() {
  menu.value = false
  app.dockOpen = true
  app.prefill = `'${props.panel.title}' 패널에 대해: `
}
async function revise() {
  menu.value = false
  const t = prompt('어떻게 바꿀까요?')
  if (t) await api(`/panels/${props.panel.id}/revise`, { method: 'POST', body: { instruction: t } })
}
async function remove() {
  menu.value = false
  await api(`/panels/${props.panel.id}`, { method: 'DELETE' })
}
</script>

<template>
  <div class="panel glass">
    <div class="head">
      <span class="ico">{{ panel.icon }}</span>
      <span class="title">{{ panel.title }}</span>
      <button class="more" aria-label="패널 메뉴" @click="menu = !menu"><Icon name="more" :size="18" /></button>
      <Transition name="fade">
        <div v-if="menu" class="menu glass" @mouseleave="menu = false">
          <button @click="ask">패널에 질문하기</button>
          <button @click="revise">패널 수정하기</button>
          <button class="danger" @click="remove">삭제</button>
        </div>
      </Transition>
    </div>
    <div class="body" :style="{ height: height + 'px' }">
      <AppFrame :key="codeKey" :manifest="PANELS" :params="params" inline @size="onSize" />
    </div>
  </div>
</template>

<style scoped>
.panel { border-radius: 24px; padding: 16px; position: relative; }
.head { display: flex; align-items: center; gap: 10px; margin: 2px 2px 12px 4px; font-size: 16px; position: relative; }
.ico { width: 28px; height: 28px; border-radius: 9999px; display: grid; place-items: center; background: var(--cell-bg); font-size: 15px; }
.title { flex: 1; }
.more { width: 28px; height: 28px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-secondary); opacity: 0; transition: opacity .2s; }
.panel:hover .more { opacity: 1; }
.menu { position: absolute; right: 0; top: 34px; z-index: 5; border-radius: 16px; padding: 6px; display: flex; flex-direction: column; min-width: 160px; box-shadow: var(--shadow-card); --regular-bg: var(--regular-solid-bg); }
.menu button { text-align: left; padding: 10px 12px; border-radius: 10px; font-size: 14px; }
.menu button:hover { background: var(--cell-bg); }
.danger { color: var(--color-error); }
.body { width: 100%; transition: height .35s var(--spring); }
</style>
