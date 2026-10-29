// The listener's side of live interpretation (회의 통역): the voice channel from the server
// (server/lib/meetings/voice.js — 24 kHz PCM16 frames of the other speakers in my main language) played
// in order per speaker, and the speakers' own voices ducked while their interpretation plays (duck.js).
// The browser never talks to OpenAI and holds no key: it only plays what the server sends.
import { target, ramp, interpGain } from './duck.js'

const RATE = 24000
const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/$/, '')

export class Interpreter {
  constructor({ ticket, onNote = () => {} }) {
    this.ticket = ticket       // () => Promise<string> (POST /meetings/:id/voice/ticket)
    this.onNote = onNote       // ({type: start|end|status|hello, …})
    this.state = { mode: 'interp', on: true, until: {} }
    this.next = {}             // speakerId -> AudioContext time the queued interpretation ends
    this.els = new Map()       // speakerId -> <video> playing their own voice
    this.vol = {}
    this.stats = { frames: 0, bytes: 0, pieces: 0, dropped: 0, first: [], bySpeaker: {}, minVolume: {} }
    this.closed = false
    // (the page's own checks and the e2e read the counters here — no key or audio is kept)
    window.__pglVoice = this
  }
  async open() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE })
    } catch { this.ctx = new (window.AudioContext || window.webkitAudioContext)() }
    this.ctx.resume?.().catch(() => {})
    this.ctx.onstatechange = () => { if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}) }
    this.out = this.ctx.createGain()
    this.out.connect(this.ctx.destination)
    this.timer = setInterval(() => this.tick(), 30)
    await this.connect()
  }
  async connect() {
    if (this.closed) return
    let t
    try { t = await this.ticket() } catch { return this.retry() }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}${BASE}/api/meetings/voice?ticket=${encodeURIComponent(t)}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onmessage = (e) => (typeof e.data === 'string' ? this.note(JSON.parse(e.data)) : this.frame(e.data))
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.onNote({ type: 'closed' }); this.retry() } }
  }
  retry() { if (!this.closed) setTimeout(() => this.connect(), 2500) }
  get connected() { return this.ws?.readyState === 1 }

  note(m) {
    if (m.type === 'start') { this.stats.pieces++; if (m.firstMs != null) this.stats.first.push(m.firstMs) }
    this.onNote(m)
  }
  frame(buf) {
    const b = new Uint8Array(buf)
    const n = b[0]
    let h
    try { h = JSON.parse(new TextDecoder().decode(b.subarray(1, 1 + n))) } catch { return }
    const pcm = new Int16Array(buf.slice(1 + n, buf.byteLength - ((buf.byteLength - 1 - n) % 2)))
    this.stats.frames++; this.stats.bytes += pcm.byteLength
    this.stats.bySpeaker[h.s] = (this.stats.bySpeaker[h.s] || 0) + 1
    if (!interpGain(this.state) || !this.ctx || !pcm.length) { this.stats.dropped++; return }
    const audio = this.ctx.createBuffer(1, pcm.length, RATE)
    const ch = audio.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768
    const src = this.ctx.createBufferSource()
    src.buffer = audio
    src.connect(this.out)
    const now = this.ctx.currentTime
    const at = Math.max(now + 0.05, this.next[h.s] || 0)
    src.start(at)
    this.next[h.s] = at + audio.duration
    // until when this speaker is being interpreted (performance clock, for the ducking)
    this.state.until[h.s] = performance.now() + (this.next[h.s] - now) * 1000
  }
  // a speaker's own voice (their tile's video element) — lowered while their interpretation plays
  register(speakerId, el) {
    if (el) this.els.set(speakerId, el); else this.els.delete(speakerId)
  }
  tick() {
    const now = performance.now()
    for (const [id, el] of this.els) {
      const v = ramp(this.vol[id] ?? 1, target(id, this.state, now))
      if (v !== this.vol[id]) {
        this.vol[id] = v
        try { el.volume = v } catch { /* gone */ }
        this.stats.minVolume[id] = Math.min(this.stats.minVolume[id] ?? 1, v)
      }
    }
  }
  playing(speakerId) { return performance.now() < (this.state.until[speakerId] || 0) }
  setMode(mode) {
    this.state.mode = mode === 'original' ? 'original' : 'interp'
    // switched to the original: what is queued stops at once
    if (this.state.mode === 'original') this.silence()
  }
  setOn(on) { this.state.on = !!on; if (!on) this.silence() }
  silence() {
    if (!this.ctx) return
    try { this.out.disconnect() } catch { /* fine */ }
    this.out = this.ctx.createGain()
    this.out.connect(this.ctx.destination)
    this.next = {}; this.state.until = {}
  }
  close() {
    this.closed = true
    if (window.__pglVoice === this) window.__pglLastVoice = { stats: this.stats }
    clearInterval(this.timer)
    try { this.ws?.close() } catch { /* gone */ }
    for (const el of this.els.values()) { try { el.volume = 1 } catch { /* gone */ } }
    this.els.clear()
    try { this.ctx?.close() } catch { /* closed */ }
  }
}
