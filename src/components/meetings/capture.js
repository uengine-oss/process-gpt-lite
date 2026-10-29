// My own microphone, cut into spoken pieces (말 단위) for the meeting assistant's transcription.
// Speech/silence by loudness (RMS against a running noise floor): a piece starts ~0.4 s before the voice
// (pre-roll), ends after 0.8 s of silence or at 12 s, and is sent as a 16 kHz mono 16-bit WAV.
// Nothing is captured while muted (the track is disabled → silence) or without consent (not started).
const PRE_MS = 400, END_MS = 800, MAX_MS = 12000, MIN_MS = 450
const OUT_RATE = 16000

function wav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, OUT_RATE, true)
  v.setUint32(28, OUT_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true) }
  return new Blob([buf], { type: 'audio/wav' })
}
function downsample(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const ratio = rate / OUT_RATE
  const out = new Float32Array(Math.floor(total / ratio))
  let pos = 0, acc = 0, cnt = 0, oi = 0, next = ratio
  for (const c of chunks) for (let i = 0; i < c.length; i++) {
    acc += c[i]; cnt++; pos++
    if (pos >= next) { out[oi++] = acc / cnt; acc = 0; cnt = 0; next += ratio; if (oi >= out.length) break }
  }
  return out.subarray(0, oi)
}

// onPiece(blob, ms), onLevel(0..1), onStart() (a voice began: the interpreter gets ready) — returns stop()
export function startCapture(stream, { onPiece, onLevel = () => {}, onStart = () => {} }) {
  const track = stream.getAudioTracks()[0]
  if (!track) return () => {}
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  ctx.resume?.().catch(() => {})
  // a context the browser suspends (autoplay rules, the tab in the background) would stop the pieces silently
  ctx.onstatechange = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}) }
  const src = ctx.createMediaStreamSource(new MediaStream([track]))
  const node = ctx.createScriptProcessor(4096, 1, 1)
  const mute = ctx.createGain(); mute.gain.value = 0
  src.connect(node); node.connect(mute); mute.connect(ctx.destination)
  const bufMs = (4096 / ctx.sampleRate) * 1000
  let floor = 0.004, speaking = false, silent = 0, piece = [], pre = []
  node.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0))
    let sum = 0
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i]
    const rms = Math.sqrt(sum / d.length)
    onLevel(Math.min(1, rms * 8))
    const loud = rms > Math.max(0.012, floor * 3)
    if (!loud) floor = floor * 0.95 + rms * 0.05
    if (!speaking) {
      pre.push(d); if (pre.length * bufMs > PRE_MS) pre.shift()
      if (loud) { speaking = true; silent = 0; piece = [...pre]; pre = []; try { onStart() } catch { /* not ours */ } }
      return
    }
    piece.push(d)
    silent = loud ? 0 : silent + bufMs
    const len = piece.length * bufMs
    if (silent >= END_MS || len >= MAX_MS) {
      const voiced = len - silent
      const chunks = piece
      speaking = false; piece = []; silent = 0
      if (voiced >= MIN_MS) onPiece(wav(downsample(chunks, ctx.sampleRate)), Math.round(len))
    }
  }
  return () => { try { node.disconnect(); src.disconnect(); mute.disconnect(); ctx.close() } catch { /* closed */ } }
}
