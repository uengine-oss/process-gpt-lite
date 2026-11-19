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
// state: connecting | live | reconnecting | failed (with the reason) | exited
const emit = defineEmits(['state'])
const el = ref(null)
let term, fit, ws, ro, retry = 0, closed = false, timer, exited = false, everLive = false
let fails = 0, connTimer = null, why = ''

// "live" is the server's own {type:'session'}, not the socket opening: a gateway in front accepts
// the socket and closes it (1002) when the server refused, so an open socket proves nothing.
// An attempt that never got there counts; after MAX_FAILS in a row it stops and says why.
const MAX_FAILS = 3
const CONNECT_MS = 10_000
const TIMEOUT_WHY = '서버가 터미널 연결에 응답하지 않아요 — 서버 앞단(게이트웨이)이 웹소켓을 넘겨 주는지 확인이 필요해요'
const TICKET_WHY = { 403: '권한이 없어요 — 이 작업실의 담당자·참여자나 관리자만 열 수 있어요', 404: '작업 폴더가 없어요', 503: '이 서버에서 터미널을 쓰지 않아요' }
function setState(s, reason = '') { emit('state', s, reason) }
function failed(reason, final = false) {
  clearTimeout(connTimer)
  if (closed) return
  why = reason || why || TIMEOUT_WHY
  if (final || ++fails >= MAX_FAILS) return setState('failed', why)
  setState(everLive ? 'reconnecting' : 'connecting')
  timer = setTimeout(connect, Math.min(15000, 800 * 2 ** retry++))
}

function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)) }
// each connection takes a fresh one-time ticket (signed in and allowed in this room); the
// sign-in token itself never goes into the websocket address
async function connect() {
  clearTimeout(timer)
  let ticket
  try { ticket = (await api(`/workroom/${props.kind}/${encodeURIComponent(props.id)}/ticket`, { method: 'POST', body: { mode: props.mode } })).ticket }
  catch (e) {
    // refused for good (no access, no folder, no terminals on this server): no point asking again
    const base = TICKET_WHY[e.status]
    if (base) return failed(e.status === 503 && e.message && e.message !== base ? `${base} — ${e.message}` : base, true)
    return failed(`터미널 연결 표를 받지 못했어요 (${e.status || e.message})`)
  }
  if (closed) return
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}/api/workroom/term?ticket=${encodeURIComponent(ticket)}`)
  ws = sock
  let got = false, denied = ''
  connTimer = setTimeout(() => { if (ws === sock && !got) { ws = null; sock.close(); failed(TIMEOUT_WHY) } }, CONNECT_MS)
  sock.onmessage = (e) => {
    let m
    try { m = JSON.parse(e.data) } catch { return }
    if (m.type === 'session') { got = true; clearTimeout(connTimer); retry = 0; fails = 0; why = ''; everLive = true; setState('live'); fitNow() }
    else if (m.type === 'output') { if (m.replay) term.reset(); term.write(m.data) }
    else if (m.type === 'exit') { exited = true; term.write(`\r\n\x1b[90m[끝남 · 코드 ${m.code}] Enter 를 누르면 새로 엽니다\x1b[0m\r\n`); setState('exited') }
    // refused by the server (4401 ticket, 4403 origin, 4404 folder, 4503 no terminal here), with its reason
    else if (m.type === 'denied') denied = m.reason || `거절됨 (${m.code})`
    else if (m.type === 'error') { denied = m.message || denied; term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`) }
  }
  sock.onclose = (e) => {
    if (closed || ws !== sock) return
    ws = null
    clearTimeout(connTimer)
    if (exited) return
    // only an expired ticket is worth another try at once; the others will refuse again
    if (!got) return failed(denied || (e.code === 1002 || e.code === 1006 ? '서버가 터미널 연결을 받지 않았어요' : `연결이 끊겼어요 (${e.code})`), !!denied && e.code !== 4401)
    // it was live: the link dropped (server restart, network) — connect again
    setState('reconnecting')
    timer = setTimeout(connect, Math.min(15000, 800 * 2 ** retry++))
  }
}
// 「다시 시도」 after a failure (or a fresh start after the program ended)
function reconnect() {
  clearTimeout(timer); clearTimeout(connTimer)
  fails = 0; retry = 0; why = ''
  const old = ws; ws = null; old?.close()
  setState(everLive ? 'reconnecting' : 'connecting')
  connect()
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
defineExpose({ paste, submit, retry: reconnect, focus: () => term?.focus() })

onMounted(() => {
  term = new Terminal({ fontFamily: '"SF Mono", Menlo, "D2Coding", monospace', fontSize: 13, scrollback: 5000, cursorBlink: true,
    theme: { background: '#16181d', foreground: '#e6e6e6', cursor: '#f5a524', selectionBackground: '#3a3f4b' }, minimumContrastRatio: 4.5 })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el.value)
  term.onData((d) => {
    // after the program ended (or the link dropped) Enter starts a fresh one
    if ((exited || ws?.readyState !== 1) && d === '\r') { exited = false; term.reset(); reconnect(); return }
    if (exited) return
    send({ type: 'input', data: d })
  })
  ro = new ResizeObserver(() => fitNow())
  ro.observe(el.value)
  setState('connecting')
  connect()
})
watch(() => props.active, (a) => a && setTimeout(() => { fitNow(); term.focus() }, 30))
onBeforeUnmount(() => { closed = true; clearTimeout(timer); clearTimeout(connTimer); ro?.disconnect(); ws?.close(); term?.dispose() })
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
