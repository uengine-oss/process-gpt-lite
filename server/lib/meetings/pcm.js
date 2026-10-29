// Sound as the interpreter needs it: the browser sends a spoken piece as 16 kHz mono 16-bit WAV
// (src/components/meetings/capture.js); gpt-realtime-translate and gpt-4o-mini-tts speak 24 kHz mono
// PCM16. Pure functions (test/interp.test.js).
export const RATE = 24000

// a PCM WAV → {rate, channels, samples: Int16Array (mono)}; null if it is not one
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let o = 12, fmt = null
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(o + 8), channels: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) }
    if (id === 'data' && fmt) {
      if (fmt.format !== 1 || fmt.bits !== 16) return null
      const end = Math.min(buf.length, o + 8 + size)
      const n = Math.floor((end - o - 8) / 2 / fmt.channels)
      const out = new Int16Array(n)
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(o + 8 + i * 2 * fmt.channels)
      return { rate: fmt.rate, channels: fmt.channels, samples: out }
    }
    o += 8 + size + (size % 2)
  }
  return null
}

// linear resampling (speech: good enough, and cheap)
export function resample(samples, from, to = RATE) {
  if (from === to) return samples
  const n = Math.max(0, Math.floor((samples.length * to) / from))
  const out = new Int16Array(n)
  const step = from / to
  for (let i = 0; i < n; i++) {
    const x = i * step, j = Math.floor(x), f = x - j
    const a = samples[j] ?? 0, b = samples[j + 1] ?? a
    out[i] = Math.round(a + (b - a) * f)
  }
  return out
}

// the piece as 24 kHz PCM16 bytes, or null
export function wavToPcm24(buf) {
  const w = parseWav(buf)
  if (!w) return null
  const s = resample(w.samples, w.rate, RATE)
  return Buffer.from(s.buffer, s.byteOffset, s.byteLength)
}
export const msOf = (pcm, rate = RATE) => Math.round((pcm.length / 2 / rate) * 1000)
export const silence = (ms, rate = RATE) => Buffer.alloc(Math.round((rate * ms) / 1000) * 2)
// pcm cut into pieces of `ms` (the last one shorter)
export function chunks(pcm, ms = 100, rate = RATE) {
  const size = Math.max(2, Math.round((rate * ms) / 1000) * 2)
  const out = []
  for (let o = 0; o < pcm.length; o += size) out.push(pcm.subarray(o, Math.min(pcm.length, o + size)))
  return out
}

// one voice frame to a listener: [header length][header JSON][PCM16 24 kHz]
export function frame(header, pcm) {
  const h = Buffer.from(JSON.stringify(header))
  if (h.length > 255) throw new Error('voice frame header too long')
  return Buffer.concat([Buffer.from([h.length]), h, pcm])
}
export function unframe(buf) {
  const n = buf[0]
  return { header: JSON.parse(Buffer.from(buf.subarray(1, 1 + n)).toString()), pcm: buf.subarray(1 + n) }
}
