// The multilingual team for interpretation.spec.js (feature and agent tiers): pro-intl-<key>@uengine.org
// accounts with a name and a main language each (lib/mainLang.js), on the team. Korean speakers get the
// Korean screens, everyone else the English ones (the screens exist in Korean and English only).
import fs from 'node:fs'
import path from 'node:path'
import * as api from './api.js'
import { PGPT_ROOT } from './env.js'

export const CAST = {
  ko: { email: 'pro-intl-ko@uengine.org', name: '한지수', lang: 'ko', ui: 'ko', locale: 'ko-KR', voice: 'onyx' },
  en: { email: 'pro-intl-en@uengine.org', name: 'Emily Carter', lang: 'en', ui: 'en', locale: 'en-US', voice: 'nova' },
  ja: { email: 'pro-intl-ja@uengine.org', name: '佐藤ゆき', lang: 'ja', ui: 'en', locale: 'ja-JP', voice: 'shimmer' },
  ko2: { email: 'pro-intl-ko2@uengine.org', name: '오세훈', lang: 'ko', ui: 'ko', locale: 'ko-KR', voice: 'echo' },
}

export async function person(key) {
  const p = CAST[key]
  const c = await api.as(p.email)
  await c.post('/profile', { name: p.name, birth: '1990-01-01', onboarded: true })
  await c.put('/me/lang', { lang: p.ui })
  const r = await c.put('/me/main-lang', { lang: p.lang })
  if (r.status !== 200) throw new Error(`main language for ${p.email}: ${r.status} ${r.text}`)
  await c.get('/team')
  return Object.assign(c, { key, ...p })
}

export function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  try { return /^OPENAI_API_KEY=(.*)$/m.exec(fs.readFileSync(path.join(PGPT_ROOT, '.env'), 'utf8'))?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '' } catch { return '' }
}

const RATE = 24000
// a spoken line, made with gpt-4o-mini-tts (cached next to the test's output)
export async function speech(text, voice, dir) {
  const f = dir && path.join(dir, `${Buffer.from(text).toString('base64url').slice(0, 36)}.pcm`)
  if (f && fs.existsSync(f)) return new Int16Array(fs.readFileSync(f).buffer.slice(0))
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${openaiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm' }),
  })
  if (!r.ok) throw new Error(`tts ${r.status}`)
  const b = await r.arrayBuffer()
  const pcm = new Int16Array(b.slice(0, b.byteLength - (b.byteLength % 2)))
  if (f) fs.writeFileSync(f, Buffer.from(pcm.buffer))
  return pcm
}
// one person's microphone: their lines at their times on a shared timeline, silence elsewhere
export function timelineWav(file, parts, total) {
  const pcm = new Int16Array(Math.ceil(total * RATE))
  for (const { at, samples } of parts) pcm.set(samples.subarray(0, Math.max(0, pcm.length - Math.floor(at * RATE))), Math.floor(at * RATE))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length * 2, 40)
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(pcm.buffer)]))
}
export const secs = (samples) => samples.length / RATE
export const HANGUL = /[가-힣]/
export const KANA = /[぀-ヿ]/
