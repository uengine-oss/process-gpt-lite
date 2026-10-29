// Live interpretation in a meeting (회의 통역): each listener hears every other speaker in the listener's
// main language. The speaker's own browser still sends only its own microphone, cut into spoken pieces
// (capture.js → POST /meetings/:id/audio), so who said it is never in doubt; this module turns a piece into
// the interpreter's voice for each other language in the meeting and sends it to that language's listeners
// over their voice channel (lib/meetings/voice.js, a websocket of 24 kHz PCM16 frames).
//   translate  (default) gpt-realtime-translate: one realtime session per (meeting, speaker, language),
//              opened when needed (or when the speaker starts talking: warm), the piece appended as soon as
//              it arrives, translated audio relayed as it streams back — measured ≈0.6 s from the piece to
//              the first sound; 13 output languages; $0.034 a minute of audio
//   chain      (fallback) the subtitle's text translation (lib/translate.js) spoken by gpt-4o-mini-tts —
//              ≈2.4 s; every language; ≈$0.016 a minute. Used for languages translate does not speak (th,
//              ar, tr …), when a translate session fails (set aside for 2 minutes), or PRO_INTERP_ENGINE=chain
// The key stays here: browsers never talk to OpenAI. Measurements: scripts/interp-bench.mjs, design.md.
// Switches: PRO_INTERP=0 (no interpretation: no subtitle translations, no voice), PRO_INTERP_VOICE=0
// (subtitles only), PRO_INTERP_ENGINE=translate|chain, PRO_INTERP_MAX_PER_MIN (seconds of speech × target
// languages a meeting may interpret per minute, default 180), PRO_INTERP_MAX_MIN (per meeting in all, 240).
import crypto from 'node:crypto'
import WebSocket from 'ws'
import { openaiKey, openaiBase } from '../openai.js'
import * as P from './pcm.js'
import { langName } from '../mainLang.js'

export const enabled = () => process.env.PRO_INTERP !== '0' && !!openaiKey()
export const voiceOn = () => enabled() && process.env.PRO_INTERP_VOICE !== '0'
export const ENGINE = () => (process.env.PRO_INTERP_ENGINE === 'chain' ? 'chain' : 'translate')
const TRANSLATE_MODEL = () => process.env.PRO_INTERP_TRANSLATE_MODEL || 'gpt-realtime-translate'
const TTS_MODEL = () => process.env.PRO_INTERP_TTS_MODEL || 'gpt-4o-mini-tts'
const PER_MIN = () => Number(process.env.PRO_INTERP_MAX_PER_MIN || 180)
const TOTAL_MIN = () => Number(process.env.PRO_INTERP_MAX_MIN || 240)
const IDLE_MS = () => Number(process.env.PRO_INTERP_IDLE_S || 120) * 1000
const END_GAP_MS = 900   // no audio for this long: the interpretation of that piece is over
const TAIL_MS = 1200     // silence after a piece, so the streaming model lets the last words out
const BROKEN_MS = 120000 // a failed translate session sets the engine aside this long (chain meanwhile)

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }
const keep = (a, v) => { a.push(v); if (a.length > 300) a.shift() }
export const stats = { pieces: 0, voiced: 0, limited: 0, errors: 0, fallbacks: 0, frames: 0, bytes: 0,
  translate: { pieces: 0, first: [] }, chain: { pieces: 0, first: [] }, sessions: { opened: 0, closed: 0, connectMs: [] } }

// ---- the listeners' voice channels ----
const channels = new Map() // meetingId -> Map(userId -> Set<ws>)
export function addChannel(meetingId, userId, ws) {
  const m = channels.get(meetingId) || new Map()
  channels.set(meetingId, m)
  const set = m.get(userId) || new Set()
  m.set(userId, set)
  set.add(ws)
}
export function removeChannel(meetingId, userId, ws) {
  const m = channels.get(meetingId)
  const set = m?.get(userId)
  if (!set) return
  set.delete(ws)
  if (!set.size) m.delete(userId)
  if (!m.size) channels.delete(meetingId)
}
export const hasChannel = (meetingId, userId) => !!channels.get(meetingId)?.get(userId)?.size
function sendTo(meetingId, ids, data) {
  const m = channels.get(meetingId)
  if (!m) return 0
  let n = 0
  for (const id of ids) {
    for (const ws of m.get(id) || []) {
      // a listener who cannot keep up loses frames rather than holding the others back
      if (ws.readyState === 1 && ws.bufferedAmount < 2 * 1024 * 1024) { ws.send(data); n++ }
    }
  }
  return n
}
export function tellChannels(meetingId, ids, msg) { return sendTo(meetingId, ids, JSON.stringify(msg)) }

// ---- per meeting: budget and status ----
const meetings = new Map() // id -> {window: [[at, secs]], total, status, brokenUntil, told}
function ms(id) {
  let s = meetings.get(id)
  if (!s) { s = { window: [], total: 0, status: 'ok', brokenUntil: 0, told: {} }; meetings.set(id, s) }
  return s
}
let notify = () => {}
// (meetingId, {status, reason}) → the service tells the people in the meeting
export function onStatus(fn) { notify = fn || (() => {}) }
function setStatus(meetingId, status, extra = {}) {
  const s = ms(meetingId)
  const changed = s.status !== status
  s.status = status
  // the same notice at most once a minute
  if (changed || !s.told[status] || Date.now() - s.told[status] > 60000) { s.told[status] = Date.now(); notify(meetingId, { status, ...extra }) }
}
// out of quota (a translation or TTS call said so): everyone in the meeting hears it
export const quota = (meetingId) => setStatus(meetingId, 'quota')
export function statusOf(meetingId) {
  if (!enabled()) return { status: process.env.PRO_INTERP === '0' ? 'off' : 'no-key' }
  if (!voiceOn()) return { status: 'subtitles' }
  const s = meetings.get(meetingId)
  return { status: s?.status || 'ok', engine: ENGINE(), broken: !!s && s.brokenUntil > Date.now() }
}
export const isBroken = (meetingId) => (meetings.get(meetingId)?.brokenUntil || 0) > Date.now()
// does a piece of `secs` seconds into `langs` languages fit the meeting's budget? (counts it if so)
export function budget(meetingId, secs, langs, now = Date.now()) {
  const s = ms(meetingId)
  s.window = s.window.filter(([at]) => now - at < 60000)
  const cost = secs * langs
  const minute = s.window.reduce((n, [, x]) => n + x, 0)
  if (minute + cost > PER_MIN()) return { ok: false, why: 'minute', used: minute }
  if (s.total + cost > TOTAL_MIN() * 60) return { ok: false, why: 'total', used: s.total }
  s.window.push([now, cost]); s.total += cost
  return { ok: true }
}

// ---- gpt-realtime-translate: one session per (meeting, speaker, language) ----
const sessions = new Map() // key -> Session
const keyOf = (meetingId, speakerId, lang) => `${meetingId}:${speakerId}:${lang}`
class Session {
  constructor(meetingId, speakerId, lang) {
    Object.assign(this, { meetingId, speakerId, lang, key: keyOf(meetingId, speakerId, lang), used: Date.now(), piece: null, listeners: [], seq: 0, running: false, endTimer: null, text: '' })
  }
  open() {
    if (this.ready) return this.ready
    const t0 = Date.now()
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(`${openaiBase().replace(/^http/, 'ws')}/realtime/translations?model=${encodeURIComponent(TRANSLATE_MODEL())}`, {
        headers: { Authorization: `Bearer ${openaiKey()}`, 'OpenAI-Safety-Identifier': crypto.createHash('sha256').update(String(this.speakerId)).digest('hex').slice(0, 32) },
      })
      this.ws = ws
      const fail = (e) => { reject(e); this.close() }
      const timer = setTimeout(() => fail(new Error('translate session: no answer')), 8000)
      ws.on('open', () => ws.send(JSON.stringify({ type: 'session.update', session: { audio: { output: { language: this.lang } } } })))
      ws.on('message', (raw) => {
        let e
        try { e = JSON.parse(raw.toString()) } catch { return }
        if (e.type === 'session.updated') { clearTimeout(timer); stats.sessions.opened++; keep(stats.sessions.connectMs, Date.now() - t0); resolve(this) }
        else if (e.type === 'session.output_audio.delta') this.audio(Buffer.from(e.delta, 'base64'))
        else if (e.type === 'session.output_transcript.delta') this.text = (this.text + e.delta).slice(-2000)
        else if (e.type === 'error') {
          const code = String(e.error?.code || e.error?.type || '')
          const quota = /quota|billing|insufficient/i.test(`${code} ${e.error?.message || ''}`)
          console.warn(`[interpret] translate ${this.lang} error ${code}: ${String(e.error?.message || '').slice(0, 160)}`)
          stats.errors++
          if (quota) setStatus(this.meetingId, 'quota')
          clearTimeout(timer)
          fail(Object.assign(new Error(`translate: ${code}`), { quota }))
        }
      })
      ws.on('error', (e) => { clearTimeout(timer); fail(e) })
      ws.on('close', () => { clearTimeout(timer); reject(new Error('translate session closed')); this.close() })
    })
    this.ready.catch(() => {})
    return this.ready
  }
  // one piece in: its sound now, then a little silence so the model lets the end of it out
  push(pcm, piece) {
    this.used = Date.now()
    this.piece = piece
    this.listeners = piece.listeners
    for (const c of P.chunks(pcm, 200)) this.ws.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: c.toString('base64') }))
    this.ws.send(JSON.stringify({ type: 'session.input_audio_buffer.append', audio: P.silence(TAIL_MS).toString('base64') }))
  }
  audio(pcm) {
    const piece = this.piece
    if (!piece) return
    this.used = Date.now()
    if (!this.running) {
      this.running = true
      stats.voiced++
      if (!piece.voiced) { piece.voiced = true; keep(stats.translate.first, Date.now() - piece.receivedAt) }
      tellChannels(this.meetingId, this.listeners, { type: 'start', speakerId: this.speakerId, lang: this.lang, engine: 'translate', pieceId: piece.id, lineId: piece.lineId?.() ?? null, firstMs: Date.now() - piece.receivedAt })
    }
    const n = sendTo(this.meetingId, this.listeners, P.frame({ s: this.speakerId, l: this.lang, p: piece.id, q: ++this.seq }, pcm))
    stats.frames += n; stats.bytes += pcm.length * n
    clearTimeout(this.endTimer)
    this.endTimer = setTimeout(() => {
      this.running = false
      tellChannels(this.meetingId, this.listeners, { type: 'end', speakerId: this.speakerId, lang: this.lang, pieceId: piece.id })
    }, END_GAP_MS)
  }
  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.endTimer)
    if (this.running) tellChannels(this.meetingId, this.listeners, { type: 'end', speakerId: this.speakerId, lang: this.lang, pieceId: this.piece?.id })
    try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'session.close' })) } catch { /* gone */ }
    setTimeout(() => { try { this.ws?.close() } catch { /* gone */ } }, 1500).unref?.()
    if (sessions.get(this.key) === this) sessions.delete(this.key)
    stats.sessions.closed++
  }
}
function session(meetingId, speakerId, lang) {
  const k = keyOf(meetingId, speakerId, lang)
  let s = sessions.get(k)
  if (!s || s.closed) { s = new Session(meetingId, speakerId, lang); sessions.set(k, s) }
  return s
}

// the speaker began talking (capture.js, before the piece is cut): open the sessions their piece will need
export function warm(meetingId, speakerId, langs) {
  if (!voiceOn() || ENGINE() !== 'translate' || isBroken(meetingId)) return
  for (const lang of langs) session(meetingId, speakerId, lang).open().catch(() => {})
}

// ---- chain: the subtitle's translation, spoken ----
const VOICES = ['alloy', 'coral', 'echo', 'sage', 'ash', 'shimmer', 'verse', 'marin', 'cedar', 'ballad']
const voiceFor = (speakerId) => VOICES[parseInt(crypto.createHash('md5').update(String(speakerId)).digest('hex').slice(0, 6), 16) % VOICES.length]
async function chain(meetingId, speakerId, lang, text, piece) {
  if (!text) return
  const t0 = Date.now()
  const r = await fetch(`${openaiBase()}/audio/speech`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${openaiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL(), voice: voiceFor(speakerId), input: text.slice(0, 1200), response_format: 'pcm',
      instructions: `You are a meeting interpreter speaking ${langName(lang)}. Say it naturally and a little quickly, in the first person, like the speaker would.` }),
  })
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200)
    if (r.status === 429 && /quota|billing/i.test(body)) setStatus(meetingId, 'quota')
    throw new Error(`tts ${r.status}: ${body}`)
  }
  const reader = r.body.getReader()
  let buf = Buffer.alloc(0), seq = 0, started = false
  const FRAME = 9600 // 200 ms
  const out = (pcm) => {
    if (!started) {
      started = true; stats.voiced++
      keep(stats.chain.first, Date.now() - piece.receivedAt)
      tellChannels(meetingId, piece.listeners, { type: 'start', speakerId, lang, engine: 'chain', pieceId: piece.id, lineId: piece.lineId?.() ?? null, firstMs: Date.now() - piece.receivedAt, ttsMs: Date.now() - t0 })
    }
    const n = sendTo(meetingId, piece.listeners, P.frame({ s: speakerId, l: lang, p: piece.id, q: ++seq }, pcm))
    stats.frames += n; stats.bytes += pcm.length * n
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf = Buffer.concat([buf, Buffer.from(value)])
    while (buf.length >= FRAME) { out(buf.subarray(0, FRAME)); buf = buf.subarray(FRAME) }
  }
  if (buf.length >= 2) out(buf.subarray(0, buf.length - (buf.length % 2)))
  if (started) tellChannels(meetingId, piece.listeners, { type: 'end', speakerId, lang, pieceId: piece.id })
}

// ---- one spoken piece ----
// targets: [{lang, listeners, engine}] (pairing.plan); textFor(lang) → Promise<string|null> (the line's
// translation, for the chain); lineId() → the subtitle line, once there is one
export async function piece({ meetingId, speakerId, wav, receivedAt = Date.now(), targets, textFor, lineId }) {
  if (!voiceOn() || !targets?.length) return { voiced: 0 }
  stats.pieces++
  const pcm = P.wavToPcm24(wav)
  if (!pcm) return { voiced: 0 }
  const secs = P.msOf(pcm) / 1000
  const b = budget(meetingId, secs, targets.length)
  if (!b.ok) { stats.limited++; setStatus(meetingId, 'limit', { why: b.why }); return { limited: true } }
  if (ms(meetingId).status === 'limit') setStatus(meetingId, 'ok')
  const id = crypto.randomUUID().slice(0, 8)
  const viaChain = async (t) => {
    stats.chain.pieces++
    const text = await textFor(t.lang).catch(() => null)
    await chain(meetingId, speakerId, t.lang, text, { id, receivedAt, listeners: t.listeners, lineId })
  }
  await Promise.all(targets.map(async (t) => {
    try {
      if (t.engine === 'translate' && !isBroken(meetingId)) {
        const s = session(meetingId, speakerId, t.lang)
        try {
          await s.open()
        } catch (e) {
          // set translate aside for a while (the chain carries on), unless the account is out of quota
          if (!e.quota) { ms(meetingId).brokenUntil = Date.now() + BROKEN_MS; stats.fallbacks++; return await viaChain(t) }
          throw e
        }
        if (s.ws?.readyState !== 1) { stats.fallbacks++; return await viaChain(t) }
        stats.translate.pieces++
        s.push(pcm, { id, receivedAt, listeners: t.listeners, lineId })
      } else await viaChain(t)
    } catch (e) {
      stats.errors++
      console.warn(`[interpret] ${t.lang}: ${e.message}`)
    }
  }))
  return { voiced: targets.length }
}

export function closeSpeaker(meetingId, speakerId) {
  for (const s of [...sessions.values()]) if (s.meetingId === meetingId && s.speakerId === speakerId) s.close()
}
// the meeting's 통역 switch went off: its sessions close (the listeners' channels stay open)
export function closeSessions(meetingId) {
  for (const s of [...sessions.values()]) if (s.meetingId === meetingId) s.close()
}
export function closeMeeting(meetingId) {
  closeSessions(meetingId)
  const m = channels.get(meetingId)
  if (m) for (const set of m.values()) for (const ws of set) { try { ws.send(JSON.stringify({ type: 'ended' })); ws.close() } catch { /* gone */ } }
  channels.delete(meetingId)
  meetings.delete(meetingId)
}
// sessions nobody spoke into for a while are closed (a new piece opens one again)
setInterval(() => { for (const s of [...sessions.values()]) if (Date.now() - s.used > IDLE_MS()) s.close() }, 30000).unref?.()

export function report() {
  return { enabled: enabled(), voice: voiceOn(), engine: ENGINE(), models: { translate: TRANSLATE_MODEL(), tts: TTS_MODEL() },
    ...stats, translate: { pieces: stats.translate.pieces, firstP50: pct(stats.translate.first, 0.5), firstP90: pct(stats.translate.first, 0.9), n: stats.translate.first.length },
    chain: { pieces: stats.chain.pieces, firstP50: pct(stats.chain.first, 0.5), firstP90: pct(stats.chain.first, 0.9), n: stats.chain.first.length },
    sessions: { open: sessions.size, opened: stats.sessions.opened, closed: stats.sessions.closed, connectP50: pct(stats.sessions.connectMs, 0.5) },
    channels: [...channels.values()].reduce((n, m) => n + m.size, 0) }
}
