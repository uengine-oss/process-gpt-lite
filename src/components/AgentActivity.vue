<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

// What an agent did on one step, from process-gpt's events log: shell commands with their output,
// files it read or wrote, pages it opened, notices. Refreshes while the step is still running.
const props = defineProps({ step: Object })
defineEmits(['close'])
const events = ref([])
const open = ref(new Set())
let timer

async function load() {
  if (!props.step?.todoId) return
  events.value = await api(`/todos/${props.step.todoId}/events`)
}
onMounted(() => {
  load()
  timer = setInterval(() => props.step?.state === 'active' && load(), 3000)
})
onBeforeUnmount(() => clearInterval(timer))

const parse = (d) => (typeof d === 'string' ? (() => { try { return JSON.parse(d) } catch { return { text: d } } })() : d || {})
const short = (v, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > n ? s.slice(0, n) + '…' : s }
const time = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

// One row per tool call: a started event carries the arguments, its finished event the result.
// They are paired in order per tool; a call still running shows with a spinner.
const rows = computed(() => {
  const out = []
  const pending = new Map()
  for (const e of events.value) {
    const d = parse(e.data)
    const tool = d.tool_name || d.tool || ''
    if (e.event_type === 'tool_usage_started') {
      const row = { t: e.timestamp, kind: 'tool', tool, args: d.args || d.input || {}, result: null, running: true }
      out.push(row)
      if (!pending.has(tool)) pending.set(tool, [])
      pending.get(tool).push(row)
    } else if (e.event_type === 'tool_usage_finished') {
      const row = pending.get(tool)?.shift()
      const args = d.args || d.input
      if (row) Object.assign(row, { result: d.result ?? d.output ?? '', error: d.is_error, running: false, args: Object.keys(row.args || {}).length ? row.args : args || {} })
      else out.push({ t: e.timestamp, kind: 'tool', tool, args: args || {}, result: d.result ?? d.output, error: d.is_error })
    } else if (e.event_type === 'task_started') {
      out.push({ t: e.timestamp, kind: 'mark', text: `시작${d.agent ? ` · ${d.agent}` : d.name ? ` · ${d.name}` : ''}` })
    } else if (e.event_type === 'task_working' && d && !d.tool) {
      out.push({ t: e.timestamp, kind: 'note', text: d.text || d.content || short(d, 300) })
    } else if (e.event_type === 'task_completed') {
      out.push({ t: e.timestamp, kind: 'mark', text: '완료' })
    } else if (e.event_type === 'error') {
      out.push({ t: e.timestamp, kind: 'error', text: d.message || d.error || short(d, 300) })
    } else if (e.event_type === 'human_asked') {
      out.push({ t: e.timestamp, kind: 'note', text: `사람 확인 요청: ${d.text || short(d, 300)}` })
    }
  }
  return out
})

function head(r) {
  const a = r.args || {}
  if (r.tool === 'Bash' || r.tool === 'shell' || a.command) return { shell: true, text: a.command || a.cmd || '' }
  const path = a.file_path || a.path || a.notebook_path
  if (path) return { text: `${r.tool} ${String(path).replace(/^.*\/cli-agent-ws\/[^/]+\/[^/]+\//, '')}` }
  if (a.url) return { text: `${r.tool} ${a.url}` }
  if (a.pattern) return { text: `${r.tool} ${a.pattern}` }
  if (a.note || a.text) return { text: `${r.tool} · ${short(a.note || a.text, 200)}` }
  return { text: `${r.tool} ${Object.keys(a).length ? short(a, 140) : ''}` }
}
const toggle = (i) => { const s = new Set(open.value); s.has(i) ? s.delete(i) : s.add(i); open.value = s }
const counts = computed(() => {
  const tools = rows.value.filter((r) => r.kind === 'tool')
  return { all: tools.length, shell: tools.filter((r) => head(r).shell).length }
})
</script>

<template>
  <Teleport to="body">
    <div class="veil" @click.self="$emit('close')">
      <div class="sheet blur-in" role="dialog" :aria-label="`${step.name} 동작`">
        <header>
          <div>
            <span class="badge">에이전트 동작 · {{ step.orchestration || step.role }}</span>
            <h2>{{ step.name }}</h2>
            <small>도구 호출 {{ counts.all }}회 · 셸 명령 {{ counts.shell }}회<span v-if="step.state === 'active'" class="live"> · 실행 중</span></small>
          </div>
          <button class="wroom press" @click="$router.push(`/workroom/todo/${step.todoId}`)">작업실 열기</button>
          <button class="x press" aria-label="닫기" @click="$emit('close')"><Icon name="close" :size="18" /></button>
        </header>
        <div class="term scroll">
          <div v-for="(r, i) in rows" :key="i" class="row" :class="[r.kind, { err: r.error, run: r.running }]">
            <span class="ts">{{ time(r.t) }}</span>
            <div class="main">
              <template v-if="r.kind === 'tool'">
                <button class="cmd" @click="r.result != null && toggle(i)">
                  <span v-if="head(r).shell" class="prompt">$</span><span v-else class="tool">›</span>
                  <span class="txt">{{ head(r).text }}</span>
                  <span v-if="r.running" class="spin" />
                </button>
                <pre v-if="r.result != null && (open.has(i) || head(r).shell)" class="out" :class="{ clip: !open.has(i) }">{{ typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 1) }}</pre>
              </template>
              <span v-else class="txt">{{ r.text }}</span>
            </div>
          </div>
          <p v-if="!rows.length" class="empty">아직 기록된 동작이 없어요.</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .3); display: grid; place-items: center; padding: 16px; }
.sheet { width: min(900px, 100%); max-height: min(88vh, 900px); border-radius: 24px; background: #0d1117; color: #e6edf3; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0, 0, 0, .45); overflow: hidden; }
header { display: flex; justify-content: space-between; gap: 12px; padding: 18px 20px 12px; border-bottom: 1px solid #21262d; }
.badge { font-size: 12px; color: #8b949e; }
h2 { margin: 2px 0 2px; font-size: 20px; font-weight: 500; }
header small { color: #8b949e; font-size: 12.5px; }
.live { color: #3fb950; }
.x { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: #21262d; color: #e6edf3; flex: none; }
.term { overflow: auto; padding: 10px 0 16px; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
.row { display: grid; grid-template-columns: 74px 1fr; gap: 8px; padding: 3px 20px; }
.row:hover { background: #161b22; }
.ts { color: #6e7681; }
.main { min-width: 0; }
.cmd { display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: left; color: inherit; font: inherit; }
.prompt { color: #3fb950; font-weight: 700; } .tool { color: #79c0ff; }
.txt { white-space: pre-wrap; word-break: break-all; }
.row.mark .txt { color: #d2a8ff; } .row.note .txt { color: #e3b341; } .row.error .txt, .row.err .txt { color: #ff7b72; }
.out { margin: 4px 0 6px 14px; padding: 8px 10px; background: #161b22; border-radius: 8px; color: #c9d1d9; white-space: pre-wrap; word-break: break-all; max-height: 360px; overflow: auto; }
.out.clip { max-height: 96px; overflow: hidden; -webkit-mask-image: linear-gradient(#000 60%, transparent); mask-image: linear-gradient(#000 60%, transparent); }
.spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid #3fb950; border-right-color: transparent; animation: spin .8s linear infinite; }
.empty { color: #8b949e; padding: 0 20px; }
@media (max-width: 760px) { .veil { place-items: end stretch; padding: 0; } .sheet { border-radius: 24px 24px 0 0; } .row { grid-template-columns: 1fr; } .ts { display: none; } }
.wroom { margin-left: auto; margin-right: 8px; height: 32px; padding: 0 14px; border-radius: 16px; background: #f5a524; color: #1d1d1b; font-size: 13px; font-weight: 600; }
</style>
