<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { panelDoc } from './panelRuntime.js'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { useSky } from '../stores/sky.js'

const props = defineProps({ panel: Object })
const app = useApp()
const sky = useSky()
const frame = ref(null)
const height = ref(120)
const menu = ref(false)
const theme = computed(() => (sky.isDay ? 'light' : 'dark'))
// Rebuild only when the panel's code changes; data saves must not reload it.
const doc = computed(() => panelDoc(props.panel, document.documentElement.dataset.theme || 'light'))
const codeKey = computed(() => props.panel.spec?.html + props.panel.spec?.script)

async function onMessage(e) {
  if (e.source !== frame.value?.contentWindow) return
  const m = e.data
  if (!m?.__panel) return
  const reply = (result, error) => frame.value?.contentWindow.postMessage({ __reply: 1, id: m.id, result, error }, '*')
  try {
    if (m.type === 'height') height.value = Math.min(Math.max(m.payload, 40), 640)
    else if (m.type === 'error') console.warn('[panel]', props.panel.title, m.payload)
    else if (m.type === 'save') reply(await api(`/panels/${props.panel.id}/data`, { method: 'PUT', body: m.payload }))
    else if (m.type === 'fetch') reply(await api(`/panel-proxy?url=${encodeURIComponent(m.payload)}`))
    else if (m.type === 'ask') reply((await api('/panel-ask', { method: 'POST', body: { prompt: m.payload } })).text)
    else if (m.type === 'open') { window.open(m.payload, '_blank', 'noopener'); reply(true) }
    else if (m.type === 'chat') { app.send(m.payload, app.mainThread.id); reply(true) }
  } catch (err) { reply(null, err.message) }
}
watch(theme, (t) => frame.value?.contentWindow?.postMessage({ __theme: t }, '*'))
onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))

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
    <iframe :key="codeKey" ref="frame" sandbox="allow-scripts" :srcdoc="doc" @load="frame?.contentWindow?.postMessage({ __theme: theme }, '*')" :style="{ height: height + 'px' }" title="panel" />
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
iframe { width: 100%; border: 0; display: block; background: transparent; transition: height .35s var(--spring); }
</style>
