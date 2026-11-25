// The composer's dictation through the server's transcription (POST /api/dictation → lib/meetings/transcribe.js, the meetings'
// model) where the browser has no speech service of its own: the desktop app (its Chromium has none), the Android app's WebView
// and Firefox. Before, the mic there only said it could not (the desktop app) or that the browser does not support it.
// 2026-11-25 사용자: 「지금 서버에 위스퍼모델이 없는 것 같아 위스퍼 모델이 있어야 바다쓰기 이런게 되는데 그것도 반영을 좀 해줘」.
//
// It looks like the browser's SpeechRecognition to src/useDictation.js (start · stop · abort, onstart · onresult · onerror ·
// onend, a growing list of final results), so tap / hold, appending and never sending stay exactly as they are:
//   - start: the microphone (getUserMedia) → onstart; the meeting capture (components/meetings/capture.js) cuts it into spoken
//     pieces (0.8 s of quiet ends one, 12 s at most) and each goes to the server at once.
//   - each piece's words come back as one final result, in the order the pieces were spoken (a later piece answering first
//     waits); a piece with no words (silence, or what the model makes up from it) adds nothing.
//   - stop: what was said since the last pause is a piece too (flushed), and onend comes after the last words are back —
//     useDictation waits graceMs for it (a piece takes a second or two; the server's own try limit is 15 s).
//   - abort: the microphone off at once; words still on their way are dropped.
//   - errors: microphone refused → 'not-allowed', none → 'audio-capture', the server could not write a piece down →
//     'server' with the server's reason (useDictation shows it and stops).
// No Vue and no browser globals here: server/test/dictation.test.js drives it with a fake microphone, capture and server.

export const SERVER_GRACE_MS = 20000

// a page that can record: a microphone API and Web Audio (the capture resamples to 16 kHz WAV)
export const canRecord = (w) => !!(w?.navigator?.mediaDevices?.getUserMedia && (w.AudioContext || w.webkitAudioContext))

/**
 * @param {object} o
 * @param {() => Promise<MediaStream>} o.media   the microphone
 * @param {(stream, {onPiece}) => (opts?: {flush?: boolean}) => void} o.capture   components/meetings/capture.js startCapture
 * @param {(blob) => Promise<{text: string}>} o.post   one piece to POST /api/dictation (rejects with the reason)
 * @returns a SpeechRecognition-like class
 */
export function serverRecognition({ media, capture, post }) {
  return class ServerRecognition {
    constructor() {
      Object.assign(this, { lang: 'ko-KR', continuous: true, interimResults: true, maxAlternatives: 1, graceMs: SERVER_GRACE_MS })
      this.results = []
      this.phase = 'idle'          // idle · starting · listening · stopping · ended
      this.stream = null
      this.stopCap = null
      this.chain = Promise.resolve()
    }

    start() {
      if (this.phase !== 'idle') throw Object.assign(new Error('already started'), { name: 'InvalidStateError' })
      this.phase = 'starting'
      Promise.resolve().then(media).then((stream) => {
        this.stream = stream
        if (this.phase !== 'starting') return this.release()
        this.phase = 'listening'
        this.onstart?.({})
        this.stopCap = capture(stream, { onPiece: (blob) => this.piece(blob) })
      }, (e) => {
        if (this.phase !== 'starting') return
        this.onerror?.({ error: e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'not-allowed' : 'audio-capture' })
        this.end()
      })
    }

    // one spoken piece: sent now, its words written in turn
    piece(blob) {
      if (this.phase !== 'listening' && this.phase !== 'stopping') return
      const asked = Promise.resolve().then(() => post(blob))
      this.chain = this.chain.then(() => asked.then((j) => {
        if (this.phase === 'ended') return
        const text = String(j?.text || '').trim()
        if (!text) return
        this.results.push(Object.assign([{ transcript: text, confidence: 1 }], { isFinal: true }))
        this.onresult?.({ results: this.results, resultIndex: this.results.length - 1 })
      }, (e) => {
        if (this.phase === 'ended') return
        this.onerror?.({ error: 'server', message: e?.message || '' })
        this.end()
      }))
    }

    // the person turned it off: the words said so far still come, then the end
    stop() {
      if (this.phase === 'starting') { this.phase = 'stopping'; return this.chain.then(() => this.end()) }
      if (this.phase !== 'listening') return
      this.phase = 'stopping'
      const stopCap = this.stopCap
      this.stopCap = null
      try { stopCap?.({ flush: true }) } catch { /* already stopped */ }
      this.release()
      this.chain.then(() => this.end())
    }

    abort() {
      if (this.phase === 'ended') return
      this.end()
    }

    release() {
      const stopCap = this.stopCap
      this.stopCap = null
      try { stopCap?.() } catch { /* already stopped */ }
      for (const t of this.stream?.getTracks?.() || []) { try { t.stop() } catch { /* ended */ } }
      this.stream = null
    }

    end() {
      if (this.phase === 'ended') return
      this.phase = 'ended'
      this.release()
      this.onend?.({})
    }
  }
}

// POST one piece; a token about to run out is renewed first, and a 401 once more after a refresh (like the meeting's pieces)
export async function postPiece(blob, { base = '', token, refresh, fetchImpl = fetch } = {}) {
  const go = async () => fetchImpl(`${base}/api/dictation`, { method: 'POST', body: blob, headers: { 'Content-Type': 'audio/wav', Authorization: `Bearer ${await token()}` } })
  let r = await go()
  if (r.status === 401 && await refresh().catch(() => null)) r = await go()
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || '받아 적지 못했어요.'), { status: r.status })
  return r.json()
}
