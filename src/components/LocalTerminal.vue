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
// Its look is Lite's (src/localTermTheme.js): the colours of the light or dark theme, switched live with <html data-theme>, a monospace
// face with a Korean fallback, a card frame. The connection is the run card's (src/localRelay.js — shared with the 「대화」 view).
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { TERM_FONT, MIN_CONTRAST, themeFor, themeMode, watchTheme } from '../localTermTheme.js'

const props = defineProps({ relay: { type: Object, required: true }, agent: String })
const el = ref(null)
const box = ref(null)
const owner = computed(() => !!props.relay.st.owner)
const state = computed(() => props.relay.st.state) // connecting · live · detached · ended · failed
const why = computed(() => props.relay.st.why)
const mode = ref(themeMode())
const notice = ref('')
let term, ro, stopTheme, size = { cols: 80, rows: 28 }
const offs = []

const send = (m) => props.relay.send(m)
// the theme's colours; the cursor only for the owner (nobody else types here)
function paint() {
  const t = themeFor(mode.value)
  term.options.theme = { ...t, ...(owner.value ? {} : { cursor: 'rgba(0,0,0,0)', cursorAccent: 'rgba(0,0,0,0)' }) }
  term.options.disableStdin = !owner.value
  term.options.cursorInactiveStyle = owner.value ? 'outline' : 'none'
}

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
  term = new Terminal({ fontFamily: TERM_FONT, fontSize: 11, lineHeight: 1.12, cols: 80, rows: 28, scrollback: 4000, cursorBlink: false, disableStdin: true,
    theme: themeFor(mode.value), minimumContrastRatio: MIN_CONTRAST, allowProposedApi: false })
  term.open(el.value)
  paint()
  term.onData((d) => { if (owner.value && !guardExitKey(d)) send({ type: 'input', data: d }) })
  touch(el.value)
  ro = new ResizeObserver(() => fitTo())
  ro.observe(box.value)
  stopTheme = watchTheme((m) => { mode.value = m; paint() })
  const r = props.relay
  offs.push(r.on('session', (m) => { fitTo(m.cols, m.rows); paint() }))
  offs.push(r.on('output', (m) => { if (m.replay) term.reset(); term.write(m.data) }))
  offs.push(r.on('size', (m) => fitTo(m.cols, m.rows)))
  if (r.st.cols) fitTo(r.st.cols, r.st.rows)
  // (the screen so far, from the start — this view may come after the card's connection did)
  r.subscribe(['term'], { replay: true })
})
onBeforeUnmount(() => { for (const off of offs) off(); ro?.disconnect(); stopTheme?.(); term?.dispose() })
</script>

<template>
  <div class="lt" :class="[state, mode]" data-test="local-run-terminal" :data-term-state="state" :data-owner="owner ? 'yes' : 'no'" :data-theme-mode="mode">
    <div ref="box" class="box"><div ref="el" class="xt" /></div>
    <div v-if="owner && state === 'live'" class="keys" data-test="local-run-keys">
      <button v-for="(v, k) in KEYS" :key="k" type="button" class="k press" @click="key(k)">{{ k }}</button>
    </div>
    <small v-if="state !== 'live' || notice" class="note" data-test="local-run-term-note">{{ notice || { connecting: '터미널에 연결하는 중…', detached: '데스크톱 연결이 끊겼어요 — 다시 이어지면 계속 보여요', ended: '끝난 화면이에요 — 마지막 턴이 끝났을 때의 화면', failed: why || '터미널을 열지 못했어요' }[state] }}</small>
  </div>
</template>

<style scoped>
.lt { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
/* a Lite card around the terminal: the theme's terminal colour, the hairline, the card radius */
.box { overflow-x: auto; overflow-y: hidden; border-radius: 14px; background: #1d1d1f; border: 1px solid var(--hairline); padding: 8px 6px 6px 10px; min-width: 0;
  -webkit-overflow-scrolling: touch; box-shadow: inset 0 1px 0 rgba(255 255 255 / .04); }
.light .box { background: #fbfbfd; box-shadow: inset 0 1px 0 rgba(0 0 0 / .02); }
.xt { width: max-content; }
.keys { display: none; gap: 6px; overflow-x: auto; }
.k { flex: none; height: 28px; padding: 0 10px; border-radius: 8px; background: var(--button-bg); color: var(--text-primary); font: 12px/28px "SF Mono", Menlo, monospace; }
.note { color: var(--text-secondary); font-size: 11.5px; }
.connecting .note::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; border: 1.5px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; vertical-align: -1px; }
@media (max-width: 760px), (pointer: coarse) { .keys { display: flex; } }
</style>
