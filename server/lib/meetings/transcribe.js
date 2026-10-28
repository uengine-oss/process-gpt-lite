// Speech → text for one spoken piece (말 단위 WAV from the speaker's own browser).
// The same contract as process-gpt's /completion/upload (a recorded Blob in, {transcript} out), but per
// utterance and behind the meeting's member + consent checks. OpenAI's transcription API; the key is
// read from process-gpt's .env like every other key here and never leaves the server.
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { PGPT_ROOT } from '../paths.js'
import { lang, L } from '../lang.js'

let key = null
function apiKey() {
  if (key !== null) return key
  key = process.env.PRO_TRANSCRIBE_API_KEY || process.env.OPENAI_API_KEY || ''
  if (!key) {
    try { key = dotenv.parse(fs.readFileSync(path.join(PGPT_ROOT, '.env'))).OPENAI_API_KEY || '' } catch { key = '' }
  }
  return key
}
const BASE = () => (process.env.PRO_TRANSCRIBE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const MODEL = () => process.env.PRO_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
export const transcribeConfigured = () => !!apiKey()

// what transcription models make up from noise or silence (they were trained on subtitled video)
const HALLUCINATED = /^(감사합니다|고맙습니다|시청해\s*주셔서\s*감사합니다|구독과\s*좋아요|좋아요와\s*구독|MBC\s*뉴스|자막\s*제공|다음\s*영상에서\s*만나요|안녕하세요)[.!\s]*$/
// the same in an English meeting
const HALLUCINATED_EN = /^(thank\s*you|thanks|thanks\s*for\s*watching|thank\s*you\s*for\s*watching|please\s*subscribe|like\s*and\s*subscribe|see\s*you\s*(next\s*time|in\s*the\s*next\s*video)|subtitles\s*by.*|you|bye|hello)[.!\s]*$/i

// the spoken language: the meeting's (lib/meetings/service.js runs a meeting's work in its language)
export async function transcribe(buf, { prompt = '', type = 'audio/wav', language = lang() } = {}) {
  if (!apiKey()) throw Object.assign(new Error(L('받아쓰기 키가 설정되지 않았어요.', 'No transcription key is set up.')), { status: 503 })
  const en = language === 'en'
  const t0 = Date.now()
  const form = new FormData()
  form.append('file', new Blob([buf], { type }), type.includes('webm') ? 'speech.webm' : 'speech.wav')
  form.append('model', MODEL())
  form.append('language', en ? 'en' : 'ko')
  form.append('response_format', 'json')
  if (prompt) form.append('prompt', prompt.slice(0, 600))
  const r = await fetch(`${BASE()}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}` }, body: form, signal: AbortSignal.timeout(30000) })
  // 503, not 502: a proxy in front (Cloudflare) replaces a 502 with its own page and the reason is lost
  if (!r.ok) throw Object.assign(new Error(`transcription ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 503 })
  const j = await r.json()
  const text = String(j.text || '').replace(/\s+/g, ' ').trim()
  return { text: (en ? HALLUCINATED_EN : HALLUCINATED).test(text) || text.length < 2 ? '' : text, ms: Date.now() - t0, model: MODEL(), language: en ? 'en' : 'ko' }
}

// length of a PCM WAV in ms (the browser sends 16-bit mono); 0 if it is not one
export function wavMs(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0
  const rate = buf.readUInt32LE(24), bytesPerSec = buf.readUInt32LE(28)
  return rate && bytesPerSec ? Math.round(((buf.length - 44) / bytesPerSec) * 1000) : 0
}
