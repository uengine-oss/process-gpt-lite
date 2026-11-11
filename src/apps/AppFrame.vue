<script setup>
// One Lite app in a sandboxed iframe (contract v1, docs/robo-dlc/plan-review.md §2): its page comes from
// /api/apps/<id>/ui/, its calls go through the bridge with the capabilities its manifest lists, and the
// live 'app' events for it (and for this folder) are passed in.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { BASE } from '../base.js'
import { bridge } from './bridge.js'
import { useApp } from '../stores/app.js'
import { useApps } from '../stores/apps.js'
import { useSky } from '../stores/sky.js'
import { isEnglish } from '../i18n/lang.js'

const props = defineProps({ manifest: Object, folder: String, params: { type: Object, default: () => ({}) } })
const emit = defineEmits(['ready'])
const router = useRouter()
const app = useApp()
const apps = useApps()
const sky = useSky()
const frame = ref(null)
const theme = computed(() => (sky.isDay ? 'light' : 'dark'))
// the page address carries what the app needs to start; later changes go by message (no reload)
const src = ref('')
const make = () => `${BASE}/api/apps/${props.manifest.id}/ui/index.html?${new URLSearchParams({ folder: props.folder, lang: isEnglish ? 'en' : 'ko', theme: theme.value, ...props.params })}`
src.value = make()
watch(() => props.params, (p) => frame.value?.contentWindow?.postMessage({ __params: p }, '*'), { deep: true })
watch(theme, (t) => frame.value?.contentWindow?.postMessage({ __theme: t }, '*'))

const onMessage = bridge(() => frame.value, props.manifest.capabilities, {
  app, router, appId: props.manifest.id,
  openApp: (id, params) => apps.open(id, props.folder, params),
})
// live events: this app's, for this folder, and the watcher's "the AI-DLC work moved" to every app
function onEvent(e) {
  const { type, data } = e.detail || {}
  if (type !== 'app' || !data) return
  if (data.app !== props.manifest.id && data.app !== '*') return
  if (data.folder && data.folder !== props.folder) return
  frame.value?.contentWindow?.postMessage({ __event: 1, type: data.type, data: data.data }, '*')
}
onMounted(() => { window.addEventListener('message', onMessage); window.addEventListener('pgpt:event', onEvent) })
onBeforeUnmount(() => { window.removeEventListener('message', onMessage); window.removeEventListener('pgpt:event', onEvent) })
</script>

<template>
  <iframe ref="frame" class="app-frame" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" :src="src" :title="manifest.name?.ko || manifest.id"
    :data-test="`app-${manifest.id}`" @load="emit('ready')" />
</template>

<style scoped>
.app-frame { width: 100%; height: 100%; border: 0; display: block; background: transparent; }
</style>
