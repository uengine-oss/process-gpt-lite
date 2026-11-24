<script setup>
// The terminal of a step run by the person's own CLI on their computer (server lib/localAgents/relay.js): xterm.js over agent-share's
// protocol, as WorkroomTerminal.vue — input · resize out; session · output · exit in; the screen so far replayed on attach, so every
// viewer (another person's browser, a phone, the owner's own window) sees the same screen.
//   the owner (whose CLI it is): types into it (the server passes only theirs on); keys a phone has not (Esc, Tab, ↑↓, Ctrl-C, Enter);
//     a second Ctrl+C / Ctrl+D right after the first is held back (it would quit the CLI and end the run — agent-share's guard); on a
//     phone, a tap on an item of Claude Code's 「/」 list picks it (agent-share).
//   everyone else: read only — no cursor, no keyboard; their input would be dropped by the server anyway.
// On a touch screen the terminal scrolls with inertia (agent-share's touch handling). The screen keeps the CLI's own width: on a narrow
// screen the letters get smaller and the box scrolls sideways inside itself (never the page).
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api.js'
import { BASE } from '../base.js'

const props = defineProps({ jobId: { type: String, required: true }, agent: String })
const emit = defineEmits(['state'])
const el = ref(null)
const box = ref(null)
const owner = ref(false)
const state = ref('connecting') // connecting · live · detached · ended · failed
const why = ref('')
const notice = ref('')
let term, ws, ro, timer, closed = false, retry = 0, size = { cols: 80, rows: 28 }

function setState(s, reason = '') { state.value = s; why.value = reason; emit('state', s, reason) }
function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)) }
async function connect() {
  clearTimeout(timer)
  let t
  try { t = await api(`/local-agents/jobs/${encodeURIComponent(props.jobId)}/term`, { method: 'POST' }) } catch (e) {
    if (e.status === 403 || e.status === 404) return setState('failed', e.message)
    return again()
  }
  if (closed) return
  owner.value = !!t.owner
  term.options.disableStdin = !owner.value
  term.options.cursorInactiveStyle = owner.value ? 'outline' : 'none'
  term.options.theme = { ...term.options.theme, cursor: owner.value ? '#f5a524' : 'rgba(0,0,0,0)', cursorAccent: owner.value ? '#16181d' : 'rgba(0,0,0,0)' }
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}/api/local-agents/term?ticket=${encodeURIComponent(t.ticket)}`)
  ws = sock
  let denied = ''
  sock.onmessage = (e) => {
    let m
    try { m = JSON.parse(e.data) } catch { return }
    if (m.type === 'session') { retry = 0; fitTo(m.cols, m.rows); setState(m.live === false ? 'ended' : m.detached ? 'detached' : 'live') }
    else if (m.type === 'output') { if (m.replay) term.reset(); term.write(m.data) }
    else if (m.type === 'size') fitTo(m.cols, m.rows)
    else if (m.type === 'exit') setState('ended')
    else if (m.type === 'detached') setState('detached')
    else if (m.type === 'attached') { if (state.value === 'detached') setState('live') }
    else if (m.type === 'denied') denied = m.reason || ''
  }
  sock.onclose = () => {
    if (closed || ws !== sock) return
    ws = null
    if (denied) return setState('failed', denied)
    if (state.value !== 'ended') again()
  }
}
function again() { if (closed) return; setState('connecting'); timer = setTimeout(connect, Math.min(15000, 800 * 2 ** retry++)) }

// the CLI's own size; the letters as large as the box allows (between 8 and 12.5 px)
function fitTo(cols, rows) {
  size = { cols: cols || size.cols, rows: rows || size.rows }
  const w = box.value?.clientWidth || 600
  const fs = Math.max(8, Math.min(12.5, Math.floor((w - 12) / (size.cols * 0.61) * 2) / 2))
  if (term.options.fontSize !== fs) term.options.fontSize = fs
  if (term.cols !== size.cols || term.rows !== size.rows) term.resize(size.cols, size.rows)
}

// ---------- the owner's keys ----------
const KEYS = { esc: '\x1b', tab: '\t', '↑': '\x1b[A', '↓': '\x1b[B', 'ctrl-c': '\x03', enter: '\r' }
const EXIT_GUARD_MS = 3000
let exitKey = { data: '', at: -Infinity }
function guardExitKey(data) {
  if (data !== '\x03' && data !== '\x04') return false
  const now = performance.now(), twice = exitKey.data === data && now - exitKey.at < EXIT_GUARD_MS
  exitKey = { data, at: now }
  if (twice) { notice.value = `${data === '\x03' ? 'Ctrl+C' : 'Ctrl+D'}를 잇달아 누르면 CLI가 꺼져 실행이 끝나서 두 번째는 막았어요. 멈추려면 Esc 를 누르세요.`; setTimeout(() => { notice.value = '' }, 5000) }
  return twice
}
function key(k) { if (!owner.value) return; if (!guardExitKey(KEYS[k])) send({ type: 'input', data: KEYS[k] }); term.focus() }

// ---------- touch: inertia scroll, and a tap on Claude Code's 「/」 list (agent-share static/index.html) ----------
function touch(host) {
  const ours = () => term.modes.mouseTrackingMode === 'none' && term.buffer.active.type === 'normal'
  const cellH = () => { const s = term.element?.querySelector('.xterm-screen'); return s ? s.getBoundingClientRect().height / term.rows : 16 }
  let t = null, fling = 0, acc = 0
  const stop = () => { cancelAnimationFrame(fling); fling = 0 }
  const scrollPx = (px) => { acc += px / cellH(); const n = Math.trunc(acc); if (n) { term.scrollLines(n); acc -= n } }
  host.addEventListener('touchstart', (e) => {
    stop(); t = null
    if (e.touches.length !== 1 || !ours()) return
    const p = e.touches[0], now = performance.now()
    t = { x0: p.clientX, y0: p.clientY, y: p.clientY, t0: now, moved: false, samples: [[now, p.clientY]] }
    acc = 0
  }, { capture: true, passive: true })
  host.addEventListener('touchmove', (e) => {
    if (!t || e.touches.length !== 1) return
    const p = e.touches[0], now = performance.now()
    // (sideways: the box scrolls itself — a terminal wider than a phone)
    if (!t.moved && Math.abs(p.clientX - t.x0) > Math.abs(p.clientY - t.y0)) { t = null; return }
    e.preventDefault(); e.stopPropagation()
    if (!t.moved && Math.hypot(p.clientX - t.x0, p.clientY - t.y0) < 8) return
    t.moved = true
    scrollPx(t.y - p.clientY); t.y = p.clientY
    t.samples.push([now, p.clientY])
    while (t.samples.length > 2 && now - t.samples[0][0] > 100) t.samples.shift()
  }, { capture: true, passive: false })
  host.addEventListener('touchend', () => {
    const x = t; t = null
    if (!x) return
    if (!x.moved) { if (performance.now() - x.t0 < 400) pickFromSlashMenu(x.y0); return }
    const [t1, y1] = x.samples[0], [t2, y2] = x.samples[x.samples.length - 1]
    let v = t2 > t1 ? (y1 - y2) / (t2 - t1) : 0
    if (Math.abs(v) < 0.3) return
    let last = performance.now()
    const step = (now) => {
      const dt = Math.min(now - last, 50); last = now
      scrollPx(v * dt)
      v *= Math.pow(0.95, dt / 16)
      const b = term.buffer.active, edge = (v < 0 && b.viewportY <= 0) || (v > 0 && b.viewportY >= b.baseY)
      fling = Math.abs(v) > 0.03 && !edge ? requestAnimationFrame(step) : 0
    }
    fling = requestAnimationFrame(step)
  }, { capture: true, passive: true })
  host.addEventListener('touchcancel', () => { t = null }, { capture: true, passive: true })
}
const ITEM = /^\s*(?:❯\s*)?[/…]\S/, RULE = /^\s*─{3}/
function pickFromSlashMenu(clientY) {
  if (!owner.value || props.agent !== 'claude-code') return
  const screen = term.element?.querySelector('.xterm-screen')
  if (!screen) return
  const r = screen.getBoundingClientRect(), b = term.buffer.active
  const row = b.viewportY + Math.floor((clientY - r.top) / (r.height / term.rows))
  const text = (y) => b.getLine(y)?.translateToString(true) ?? ''
  if (!text(row).trim() || RULE.test(text(row))) return
  let top = row, end = row
  while (top > 0 && text(top - 1).trim() && !RULE.test(text(top - 1))) top--
  while (end + 1 < b.length && text(end + 1).trim() && !RULE.test(text(end + 1))) end++
  const items = []
  for (let y = top; y <= end; y++) if (ITEM.test(text(y))) items.push(y)
  const selected = items.findIndex((y) => /^\s*❯/.test(text(y)))
  const target = items.findLastIndex((y) => y <= row)
  if (items.length < 2 || selected < 0 || target < 0 || items[0] <= b.baseY + b.cursorY) return
  const diff = target - selected
  const keys = [...Array(Math.abs(diff)).fill(diff > 0 ? KEYS['↓'] : KEYS['↑']), KEYS.tab]
  keys.forEach((k, i) => setTimeout(() => send({ type: 'input', data: k }), i * 40))
}

defineExpose({ text: () => { const b = term.buffer.active; const out = []; for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? ''); return out.join('\n') } })

onMounted(() => {
  term = new Terminal({ fontFamily: '"SF Mono", Menlo, "D2Coding", monospace', fontSize: 11, cols: 80, rows: 28, scrollback: 4000, cursorBlink: false, disableStdin: true,
    theme: { background: '#16181d', foreground: '#e6e6e6', cursor: 'rgba(0,0,0,0)', selectionBackground: '#3a3f4b' }, minimumContrastRatio: 4.5 })
  term.open(el.value)
  term.onData((d) => { if (owner.value && !guardExitKey(d)) send({ type: 'input', data: d }) })
  touch(el.value)
  ro = new ResizeObserver(() => fitTo())
  ro.observe(box.value)
  connect()
})
onBeforeUnmount(() => { closed = true; clearTimeout(timer); ro?.disconnect(); ws?.close(); term?.dispose() })
</script>

<template>
  <div class="lt" :class="state" data-test="local-run-terminal" :data-term-state="state" :data-owner="owner ? 'yes' : 'no'">
    <div ref="box" class="box"><div ref="el" class="xt" /></div>
    <div v-if="owner && state === 'live'" class="keys" data-test="local-run-keys">
      <button v-for="(v, k) in KEYS" :key="k" type="button" class="k press" @click="key(k)">{{ k }}</button>
    </div>
    <small v-if="state !== 'live' || notice" class="note" data-test="local-run-term-note">{{ notice || { connecting: '터미널에 잇는 중…', detached: '데스크톱 연결이 끊겼어요 — 다시 이어지면 계속 보여요', ended: '끝난 화면이에요', failed: why || '터미널을 열지 못했어요' }[state] }}</small>
  </div>
</template>

<style scoped>
.lt { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.box { overflow-x: auto; overflow-y: hidden; border-radius: 10px; background: #16181d; padding: 6px 4px 4px 6px; min-width: 0; -webkit-overflow-scrolling: touch; }
.xt { width: max-content; }
.keys { display: none; gap: 6px; overflow-x: auto; }
.k { flex: none; height: 28px; padding: 0 10px; border-radius: 8px; background: #2a2e37; color: #d6d6d6; font: 12px/28px "SF Mono", Menlo, monospace; }
.note { color: #8b93a3; font-size: 11.5px; }
@media (max-width: 760px), (pointer: coarse) { .keys { display: flex; } }
</style>
