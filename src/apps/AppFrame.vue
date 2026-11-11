<script setup>
// One Lite app as an MCP App (contract v2, docs/robo-dlc/plan-mcp-apps.md). This page is the MCP Apps host:
// an MCP client to the app's server (/api/apps/<id>/mcp, as the signed-in person), its entry tool called with
// the folder and the screen's arguments, the tool's ui:// resource shown in a sandboxed iframe, and the
// standard bridge (AppBridge of @modelcontextprotocol/ext-apps) between them — tools/call and resources/read
// pass through to the app's server; ui/open-link opens a Lite screen, another app beside this one, or an
// outside page; ui/message goes to the chat. Lite's extension: live events for this folder are passed in as
// notifications/io.uengine.lite/event.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AppBridge, PostMessageTransport, getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge'
import { BASE } from '../base.js'
import { freshToken } from '../api.js'
import { navAllowed } from './paths.js'
import { useApp } from '../stores/app.js'
import { useApps } from '../stores/apps.js'
import { useSky } from '../stores/sky.js'
import { isEnglish } from '../i18n/lang.js'

const props = defineProps({ manifest: Object, folder: String, params: { type: Object, default: () => ({}) }, inline: Boolean })
const emit = defineEmits(['ready', 'size', 'error'])
const router = useRouter()
const app = useApp()
const apps = useApps()
const sky = useSky()
const frame = ref(null)
const failed = ref('')
const theme = computed(() => (sky.isDay ? 'light' : 'dark'))
const LIVE = 'notifications/io.uengine.lite/event'
let client = null
let bridge = null
let closed = false

const hostContext = () => ({
  theme: theme.value, locale: isEnglish ? 'en-US' : 'ko-KR', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'web',
  containerDimensions: { maxWidth: frame.value?.clientWidth || 1200, maxHeight: frame.value?.clientHeight || 800 },
})

// a link from the screen: a Lite screen (another app beside this one with sheet=1), or an outside page
function openLink(url) {
  const u = String(url || '')
  const m = u.match(/^\/apps\/([a-z][a-z0-9-]{1,30})\/([^?#/]+)(\?[^#]*)?$/)
  if (m) {
    const params = Object.fromEntries(new URLSearchParams(m[3] || ''))
    if (params.sheet) { delete params.sheet; apps.open(m[1], decodeURIComponent(m[2]), params); return true }
  }
  if (u.startsWith('/')) { if (!navAllowed(u)) throw new Error('not a Lite screen an app may open'); router.push(u); return true }
  const ext = new URL(u)
  if (!/^https?:$/.test(ext.protocol)) throw new Error('http(s) only')
  window.open(ext.href, '_blank', 'noopener')
  return true
}

async function start() {
  const id = props.manifest.id
  // the app's MCP server, as this person (a fresh token on every request)
  client = new Client({ name: 'process-gpt-lite', version: '2.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/api/apps/${id}/mcp`, location.origin), {
    // (the transport's headers come as a Headers object: Accept and Content-Type must stay)
    fetch: async (u, init = {}) => {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${await freshToken()}`)
      return fetch(u, { ...init, headers })
    },
  })
  await client.connect(transport)
  // the entry tool: its result is the screen's first data, its ui:// resource the screen
  const args = { folder: props.folder, ...props.params }
  const { tools } = await client.listTools()
  const entry = tools.find((t) => t.name === props.manifest.entry)
  const uri = entry && getToolUiResourceUri(entry)
  if (!uri) throw new Error(`no screen for ${props.manifest.entry}`)
  const [result, res] = await Promise.all([client.callTool({ name: props.manifest.entry, arguments: args }), client.readResource({ uri })])
  const html = res.contents?.[0]?.text || ''
  if (closed) return
  // the bridge first, then the page (the screen says ui/initialize as soon as it runs)
  bridge = new AppBridge(client, { name: 'Process GPT Lite', version: '2.0.0' }, { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} }, { hostContext: hostContext() })
  bridge.onopenlink = async ({ url }) => { openLink(url); return {} }
  bridge.onmessage = async ({ content }) => {
    const text = (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    if (text && app.mainThread) app.send(text, app.mainThread.id)
    return {}
  }
  bridge.onsizechange = (s) => emit('size', s)
  bridge.oninitialized = () => { bridge.sendToolInput({ arguments: args }); bridge.sendToolResult(result) }
  bridge.onloggingmessage = (m) => console.warn(`[app ${id}]`, m.level, m.data)
  await bridge.connect(new PostMessageTransport(frame.value.contentWindow, frame.value.contentWindow))
  // the page's relative addresses (its files, the runtime) are the app's own ui/ on this server
  const base = `<base href="${location.origin}${BASE}/api/apps/${id}/ui/">`
  frame.value.srcdoc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => `${h}${base}`) : base + html
  emit('ready')
}

// live events: this app's, for this folder, and the watcher's "the AI-DLC work moved" to every app
function onEvent(e) {
  const { type, data } = e.detail || {}
  if (type !== 'app' || !data || !bridge) return
  if (data.app !== props.manifest.id && data.app !== '*') return
  if (data.folder && data.folder !== props.folder) return
  bridge.notification({ method: LIVE, params: { type: data.type, data: data.data } }).catch(() => {})
}
watch(theme, () => { if (bridge) bridge.setHostContext(hostContext()) })
watch(() => props.params, (p) => { if (bridge) bridge.sendToolInput({ arguments: { folder: props.folder, ...p } }) }, { deep: true })
onMounted(() => {
  window.addEventListener('pgpt:event', onEvent)
  start().catch((e) => { failed.value = e.message; emit('error', e) })
})
onBeforeUnmount(() => {
  closed = true
  window.removeEventListener('pgpt:event', onEvent)
  if (bridge) bridge.teardownResource({}).catch(() => {}).finally(() => bridge.close().catch(() => {}))
  client?.close().catch(() => {})
})
</script>

<template>
  <div class="app-host" :class="{ inline }">
    <iframe ref="frame" class="app-frame" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" :title="manifest.name?.ko || manifest.id" :data-test="`app-${manifest.id}`" />
    <p v-if="failed" class="failed">{{ failed }}</p>
  </div>
</template>

<style scoped>
.app-host { position: relative; width: 100%; height: 100%; }
.app-frame { width: 100%; height: 100%; border: 0; display: block; background: transparent; }
.failed { position: absolute; inset: 16px; color: var(--text-secondary); font-size: 14px; }
</style>
