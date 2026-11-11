<script setup>
// MCP Apps of other MCP servers (server/lib/apps/external.js): the tenant's registered servers, each one's tools that
// have a screen, a small form for a tool's arguments, and the screen in Lite's MCP Apps host (AppFrame). Their code
// is someone else's: it runs in a frame that cannot reach Lite (behind the sandbox proxy, or with no origin at all).
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge'
import TopBar from '../components/TopBar.vue'
import AppFrame from '../apps/AppFrame.vue'
import { authedFetch } from '../apps/mcpFetch.js'
import { api } from '../api.js'
import { BASE } from '../base.js'

const router = useRouter()
const servers = ref(null) // [{ name, tools, error }]
const picked = ref(null) // { server, tool }
const form = ref({})
const opened = ref(null) // { manifest, params }
const height = ref(560)
const run = ref(null)
// servers with screens first; the ones that did not answer (or have no screens) only by name
const withApps = computed(() => (servers.value || []).filter((s) => s.tools.length))
const silent = computed(() => (servers.value || []).filter((s) => s.error).map((s) => s.name))

// the tools of one server that a person can open: a ui:// screen, not kept for the screen alone
async function toolsOf(name) {
  const client = new Client({ name: 'process-gpt-lite', version: '2.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/apps/x/${encodeURIComponent(name)}/mcp`, location.origin), { fetch: authedFetch }))
  try {
    const { tools } = await client.listTools()
    return tools.filter((t) => getToolUiResourceUri(t) && (!t._meta?.ui?.visibility || t._meta.ui.visibility.includes('model')))
  } finally { await client.close().catch(() => {}) }
}
onMounted(async () => {
  const list = await api('/apps/external').catch(() => [])
  servers.value = await Promise.all(list.map(async ({ name }) => {
    try { return { name, tools: await toolsOf(name) } } catch (e) { return { name, tools: [], error: e.message } }
  }))
})

// the arguments a form can ask for: plain values (choices, numbers, yes/no, text); the rest keep the tool's defaults
const fields = computed(() => Object.entries(picked.value?.tool.inputSchema?.properties || {})
  .filter(([, p]) => p.enum || ['number', 'integer', 'boolean', 'string'].includes(p.type))
  .map(([key, p]) => ({ key, p, kind: p.enum ? 'choice' : p.type === 'integer' ? 'number' : p.type })))
function pick(server, tool) {
  picked.value = { server, tool }
  opened.value = null
  form.value = Object.fromEntries(fields.value.filter(({ p }) => p.default !== undefined).map(({ key, p }) => [key, p.default]))
}
async function open() {
  const { server, tool } = picked.value
  const params = Object.fromEntries(Object.entries(form.value).filter(([, v]) => v !== '' && v != null))
  opened.value = { manifest: { id: `x-${server}`, external: server, entry: tool.name, name: { ko: tool.title || tool.name, en: tool.title || tool.name } }, params }
  height.value = 560
  await nextTick()
  run.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
const onSize = (s) => { if (s?.height) height.value = Math.min(Math.max(s.height, 240), 1400) }
</script>

<template>
  <div class="page">
    <TopBar />
    <div class="body">
      <div class="head">
        <button class="back press" aria-label="뒤로" @click="router.back()">‹</button>
        <h1>다른 MCP 서버의 앱</h1>
        <span class="sub">이 회사에 등록된 MCP 서버가 화면과 함께 내놓은 도구(MCP Apps)</span>
      </div>
      <p v-if="servers && !withApps.length" class="none glass">화면을 가진 MCP 서버가 등록되어 있지 않아요.</p>
      <div v-for="s in withApps" :key="s.name" class="server" data-test="ext-server">
        <h2>{{ s.name }}</h2>
        <div class="tools">
          <button v-for="t in s.tools" :key="t.name" class="tool glass press" :class="{ on: picked?.tool.name === t.name && picked?.server === s.name }"
            data-test="ext-tool" :data-tool="t.name" @click="pick(s.name, t)">
            <b>{{ t.title || t.name }}</b><span>{{ t.description }}</span>
          </button>
        </div>
      </div>
      <details v-if="silent.length" class="muted silent"><summary>응답하지 않은 MCP 서버 {{ silent.length }}개</summary>{{ silent.join(', ') }}</details>
      <div v-if="picked" ref="run" class="run glass">
        <div class="form">
          <label v-for="f in fields" :key="f.key">
            <span>{{ f.p.title || f.key }}</span>
            <select v-if="f.kind === 'choice'" v-model="form[f.key]"><option v-for="o in f.p.enum" :key="o" :value="o">{{ o }}</option></select>
            <input v-else-if="f.kind === 'number'" v-model.number="form[f.key]" type="number" :min="f.p.minimum" :max="f.p.maximum" />
            <input v-else-if="f.kind === 'boolean'" v-model="form[f.key]" type="checkbox" />
            <input v-else v-model="form[f.key]" type="text" />
          </label>
          <button class="go press" data-test="ext-open" @click="open">열기</button>
        </div>
        <div v-if="opened" class="frame" :style="{ height: height + 'px' }">
          <AppFrame :key="opened.manifest.id + opened.manifest.entry + JSON.stringify(opened.params)" :manifest="opened.manifest" :params="opened.params" inline @size="onSize" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { position: absolute; inset: 0; display: flex; flex-direction: column; }
.body { flex: 1; min-height: 0; overflow: auto; padding: 0 20px 24px; max-width: 1480px; width: 100%; margin: 0 auto; }
.head { display: flex; align-items: center; gap: 10px; margin: 6px 0 14px; }
.head h1 { font-size: 22px; margin: 0; letter-spacing: -.02em; }
.head .sub { color: var(--text-secondary); font-size: 14px; }
.back { width: 32px; height: 32px; border-radius: 99px; background: var(--cell-bg); font-size: 20px; line-height: 1; }
.server h2 { font-size: 15px; margin: 14px 0 8px; color: var(--text-secondary); font-weight: 600; }
.tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.tool { text-align: left; border-radius: 16px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
.tool span { font-size: 13px; color: var(--text-secondary); }
.tool.on { box-shadow: inset 0 0 0 2px var(--accent, #6e5ae6); }
.run { margin-top: 16px; border-radius: 20px; padding: 14px; }
.form { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-bottom: 12px; }
.form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-secondary); }
.form input, .form select { height: 32px; border-radius: 10px; padding: 0 8px; background: var(--cell-bg); color: inherit; border: 0; }
.go { height: 34px; padding: 0 16px; border-radius: 17px; background: #6e5ae6; color: #fff; font-weight: 600; }
.frame { border-radius: 14px; overflow: hidden; transition: height .3s; }
.none { border-radius: 18px; padding: 20px; }
.silent { margin-top: 14px; }
.muted { color: var(--text-secondary); font-size: 13px; }
</style>
