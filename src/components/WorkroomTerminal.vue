<script setup>
// One terminal of the workroom: xterm.js over the server's PTY websocket (agent-share's protocol:
// input / resize out, session / output / exit in; the scrollback is replayed on attach, so a page
// reload or a second viewer sees the same screen).
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api.js'
import { BASE } from '../base.js'

const props = defineProps({ kind: String, id: String, mode: String, active: Boolean })
const emit = defineEmits(['state'])
const el = ref(null)
let term, fit, ws, ro, retry = 0, closed = false, timer, exited = false, everLive = false

function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)) }
// each connection takes a fresh one-time ticket (signed in and allowed in this room); the
// sign-in token itself never goes into the websocket address
async function connect() {
  let ticket
  try { ticket = (await api(`/workroom/${props.kind}/${encodeURIComponent(props.id)}/ticket`, { method: 'POST', body: { mode: props.mode } })).ticket }
  catch { emit('state', everLive ? 'closed' : 'denied'); if (!closed) timer = setTimeout(connect, Math.min(15000, 800 * 2 ** retry++)); return }
  if (closed) return
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}/api/workroom/term?ticket=${encodeURIComponent(ticket)}`)
  ws.onopen = () => { retry = 0; everLive = true; emit('state', 'live'); fitNow() }
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.type === 'output') { if (m.replay) term.reset(); term.write(m.data) }
    else if (m.type === 'session') fitNow()
    else if (m.type === 'exit') { exited = true; term.write(`\r\n\x1b[90m[끝남 · 코드 ${m.code}] Enter 를 누르면 새로 엽니다\x1b[0m\r\n`); emit('state', 'exited') }
    else if (m.type === 'error') term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`)
  }
  const self = ws
  ws.onclose = (e) => {
    if (closed || ws !== self) return
    // refused at the door (no access to this room) only if it never got in at all
    emit('state', e.code === 1006 && !everLive ? 'denied' : 'closed')
    timer = setTimeout(connect, Math.min(15000, 800 * 2 ** retry++))
  }
}
function fitNow() {
  if (!props.active || !el.value?.offsetWidth) return
  try { fit.fit(); send({ type: 'resize', cols: term.cols, rows: term.rows }) } catch { /* not laid out yet */ }
}

// keys a phone keyboard does not have (agent-share's key bar)
const KEYS = { esc: '\x1b', tab: '\t', '↑': '\x1b[A', '↓': '\x1b[B', 'ctrl-c': '\x03', enter: '\r' }
function key(k) { send({ type: 'input', data: KEYS[k] }); term.focus() }
// a paste the agent reads as one block (bracketed paste when the program asked for it)
function paste(text) {
  send({ type: 'input', data: term.modes?.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text })
  term.focus()
}
// a whole instruction: pasted as one block, then Enter on its own so the program submits it
function submit(text) {
  if (ws?.readyState !== 1) return false
  paste(text)
  setTimeout(() => send({ type: 'input', data: '\r' }), 350)
  return true
}
defineExpose({ paste, submit, focus: () => term?.focus() })

onMounted(() => {
  term = new Terminal({ fontFamily: '"SF Mono", Menlo, "D2Coding", monospace', fontSize: 13, scrollback: 5000, cursorBlink: true,
    theme: { background: '#16181d', foreground: '#e6e6e6', cursor: '#f5a524', selectionBackground: '#3a3f4b' }, minimumContrastRatio: 4.5 })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el.value)
  term.onData((d) => {
    // after the program ended (or the link dropped) Enter starts a fresh one
    if ((exited || ws?.readyState !== 1) && d === '\r') { exited = false; clearTimeout(timer); const old = ws; ws = null; old?.close(); term.reset(); connect(); return }
    if (exited) return
    send({ type: 'input', data: d })
  })
  ro = new ResizeObserver(() => fitNow())
  ro.observe(el.value)
  connect()
})
watch(() => props.active, (a) => a && setTimeout(() => { fitNow(); term.focus() }, 30))
onBeforeUnmount(() => { closed = true; clearTimeout(timer); ro?.disconnect(); ws?.close(); term?.dispose() })
</script>

<template>
  <div class="wt">
    <div ref="el" class="xt" />
    <div class="keys">
      <button v-for="(v, k) in KEYS" :key="k" class="k press" @click="key(k)">{{ k }}</button>
    </div>
  </div>
</template>

<style scoped>
.wt { display: flex; flex-direction: column; height: 100%; min-height: 0; background: #16181d; }
.xt { flex: 1; min-height: 0; padding: 6px 4px 0 8px; }
.keys { display: none; gap: 6px; padding: 6px 8px; background: #1d2027; overflow-x: auto; }
.k { flex: none; height: 30px; padding: 0 10px; border-radius: 8px; background: #2a2e37; color: #d6d6d6; font: 12px/30px "SF Mono", Menlo, monospace; }
@media (max-width: 760px) { .keys { display: flex; } }
</style>
