// Speech → text for one spoken piece (말 단위 WAV from the speaker's own browser).
// The same contract as process-gpt's /completion/upload (a recorded Blob in, {transcript} out), but per
// utterance and behind the meeting's member + consent checks (meetings), or the person's own composer (routes/dictation.js).
// An OpenAI-compatible /audio/transcriptions: OpenAI itself by default; in production litellm-proxy (PRO_TRANSCRIBE_BASE_URL)
// with its key (PRO_TRANSCRIBE_API_KEY), which must be allowed the models named here — a LiteLLM virtual key refuses any
// other model with 401 (2026-11-25: the services' key had gpt-4o-mini-transcribe but not whisper-1, so the second model
// could never answer). The key is read like every other key here and never leaves the server.
// A person's main language (lib/mainLang.js) is the language their pieces are transcribed in.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lang, L } from '../lang.js'
import { transcribeKey as apiKey } from '../openai.js'
import { normMain } from '../mainLang.js'

const BASE = () => (process.env.PRO_TRANSCRIBE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const MODEL = () => process.env.PRO_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
// a second model when the first does not answer (2026-11-18 production: gpt-4o-mini-transcribe through LiteLLM
// hung for 30 s on every piece, so a phone meeting had no captions); '' turns it off
const FALLBACK = () => process.env.PRO_TRANSCRIBE_FALLBACK_MODEL ?? 'whisper-1'
const TRY_MS = () => Number(process.env.PRO_TRANSCRIBE_TIMEOUT_MS || 15000)
// the last failure, for /api/meetings/stats (what the operator checks first); first: the first model's reason when the
// second one failed too (else the second's refusal — e.g. a key without whisper-1 — would hide why the first failed)
export const lastError = { at: null, model: null, message: null, first: null }
export const transcribeConfigured = () => !!apiKey()
const NOT_ANSWERING = () => L('받아쓰기 서버가 응답하지 않아요. 잠시 뒤 다시 말씀하시거나, 말 대신 적어 주세요.', 'The transcription server is not answering. Try again in a moment, or type instead.')

// one try with one model (an error carries http: the status the server answered with, if it answered)
async function ask(model, buf, { type = 'audio/wav', language = 'ko', prompt = '' } = {}) {
  const form = new FormData()
  form.append('file', new Blob([buf], { type }), type.includes('webm') ? 'speech.webm' : 'speech.wav')
  form.append('model', model)
  form.append('language', language)
  form.append('response_format', 'json')
  if (prompt) form.append('prompt', prompt.slice(0, 600))
  const r = await fetch(`${BASE()}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}` }, body: form, signal: AbortSignal.timeout(TRY_MS()) })
  if (!r.ok) throw Object.assign(new Error(`transcription ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 502, http: r.status })
  return r.json()
}
const said = (e) => (e.name === 'TimeoutError' ? `no answer in ${TRY_MS() / 1000}s` : e.message)

// what transcription models make up from noise or silence (they were trained on subtitled video)
const HALLUCINATED = /^(감사합니다|고맙습니다|시청해\s*주셔서\s*감사합니다|구독과\s*좋아요|좋아요와\s*구독|MBC\s*뉴스|자막\s*제공|다음\s*영상에서\s*만나요|안녕하세요)[.!\s]*$/
// the same in an English meeting
const HALLUCINATED_EN = /^(thank\s*you|thanks|thanks\s*for\s*watching|thank\s*you\s*for\s*watching|please\s*subscribe|like\s*and\s*subscribe|see\s*you\s*(next\s*time|in\s*the\s*next\s*video)|subtitles\s*by.*|you|bye|hello)[.!\s]*$/i
// … and in the other main languages (the subtitle-trained phrases they come up with most)
const HALLUCINATED_ANY = /^(ご視聴ありがとうございました|ありがとうございました|チャンネル登録.*|谢谢观看|谢谢大家|请不吝点赞.*|字幕由.*提供|gracias por ver(el video)?|merci d'avoir regardé|danke fürs zuschauen|untertitel.*|cảm ơn các bạn đã xem|terima kasih telah menonton|ขอบคุณที่รับชม)[.!。！\s]*$/i
const filters = { ko: HALLUCINATED, en: HALLUCINATED_EN }

// the spoken language: the speaker's main language (service.js), else the meeting's
export async function transcribe(buf, { prompt = '', type = 'audio/wav', language = lang() } = {}) {
  if (!apiKey()) throw Object.assign(new Error(L('받아쓰기 키가 설정되지 않았어요.', 'No transcription key is set up.')), { status: 503 })
  const spoken = normMain(language) || 'ko'
  const t0 = Date.now()
  let j, model = MODEL()
  try { j = await ask(model, buf, { type, language: spoken, prompt }) } catch (e) {
    Object.assign(lastError, { at: new Date().toISOString(), model, message: said(e), first: null })
    // (the reason in words the person can read — not the upstream's answer, which may name its address)
    if (!FALLBACK() || FALLBACK() === model) throw Object.assign(new Error(NOT_ANSWERING()), { status: 503 })
    model = FALLBACK()
    const first = { model: lastError.model, message: lastError.message }
    try { j = await ask(model, buf, { type, language: spoken, prompt }) } catch (e2) {
      Object.assign(lastError, { at: new Date().toISOString(), model, message: said(e2), first })
      throw Object.assign(new Error(NOT_ANSWERING()), { status: 503 })
    }
  }
  const text = String(j.text || '').replace(/\s+/g, ' ').trim()
  const made = (filters[spoken] || HALLUCINATED_ANY).test(text) || HALLUCINATED_ANY.test(text) || (spoken !== 'ko' && HALLUCINATED_EN.test(text))
  // the hint itself read back over silence ("회의 참석자: 장진영. 회의에 나올 수 있는 자료: ." became a line of the
  // 2026-11-18 meeting's record): text that is only a piece of the prompt is not speech
  const echo = promptEcho(text, prompt)
  return { text: made || echo || text.length < 2 ? '' : text, ms: Date.now() - t0, model, language: spoken }
}

// text that is only a piece of the transcription hint (the model reading its prompt back over silence)
const bare = (x) => String(x || '').replace(/[\s.,·:;!?'"()\-–—]/g, '').toLowerCase()
export function promptEcho(text, prompt) {
  return !!prompt && bare(text).length >= 6 && bare(prompt).includes(bare(text))
}

// length of a PCM WAV in ms (the browser sends 16-bit mono); 0 if it is not one
export function wavMs(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0
  const rate = buf.readUInt32LE(24), bytesPerSec = buf.readUInt32LE(28)
  return rate && bytesPerSec ? Math.round(((buf.length - 44) / bytesPerSec) * 1000) : 0
}

// ---- self-test: is there a transcription model behind PRO_TRANSCRIBE_*? ----
// 2026-11-25 사용자: 「지금 서버에 위스퍼모델이 없는 것 같아 위스퍼 모델이 있어야 받아쓰기 이런게 되는데」 — whether speech-to-text
// works in production could only be learned by speaking in a meeting (and reading /api/meetings/stats, signed in). Now the server
// transcribes a bundled clip (「회의를 시작합니다」, macOS say -v Yuna, 16 kHz mono 16-bit, 1.3 s) through the same base, key and
// models a meeting uses — at start and every PRO_TRANSCRIBE_SELFTEST_MIN minutes (default 10; a minute after a failure;
// 0 = never) — and /api/config tells what came of it: booleans and short strings only (no address, no key, no upstream
// message). A key that is not allowed the model shows as http-401. The deploy check D-STT-* reads it.
const here = path.dirname(fileURLToPath(import.meta.url))
export const SELFTEST_CLIP = path.join(here, '../../fixtures/stt/selftest-ko.wav')
export const SELFTEST_TEXT = '회의를 시작합니다'
// ok: null before the first test; model: the one that answered (else the first tried); error: a short code —
// no-key · timeout · unreachable · http-<status> · bad-answer · empty · mismatch; fallback: only the second model answered
export const health = { ok: null, model: null, ms: null, at: null, error: null, fallback: false }
export const transcribeHealth = () => ({ ...health })

// letters and digits only (spacing and punctuation are a model's style), and how far apart two strings are
const letters = (s) => [...String(s || '').normalize('NFC').toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('')
export function charErrorRate(ref, hyp) {
  const a = [...letters(ref)], b = [...letters(hyp)]
  if (!a.length) return b.length ? 1 : 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length] / a.length
}
// what went wrong, as a code that names no address
function codeOf(e) {
  if (e?.http) return `http-${e.http}`
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout'
  if (e instanceof SyntaxError) return 'bad-answer'
  return 'unreachable'
}

let clip = null
async function tryModel(model) {
  const t0 = Date.now()
  try {
    clip ||= fs.readFileSync(SELFTEST_CLIP)
    const j = await ask(model, clip, { type: 'audio/wav', language: 'ko' })
    const text = String(j?.text || '').trim()
    // (a model that hears the clip at all gets nearly every letter; another language or noise does not)
    const error = !text ? 'empty' : charErrorRate(SELFTEST_TEXT, text) > 0.5 ? 'mismatch' : null
    return { ok: !error, error, ms: Date.now() - t0 }
  } catch (e) { return { ok: false, error: codeOf(e), ms: Date.now() - t0 } }
}

let running = null
export function selfTest() {
  running ||= (async () => {
    const at = () => new Date().toISOString()
    if (!apiKey()) return Object.assign(health, { ok: false, model: MODEL(), ms: null, at: at(), error: 'no-key', fallback: false })
    const first = await tryModel(MODEL())
    if (first.ok || !FALLBACK() || FALLBACK() === MODEL()) return Object.assign(health, { ok: first.ok, model: MODEL(), ms: first.ms, at: at(), error: first.error, fallback: false })
    const second = await tryModel(FALLBACK())
    // the first model's reason stays: a meeting still waits for it on every piece before the second is asked
    return Object.assign(health, second.ok
      ? { ok: true, model: FALLBACK(), ms: second.ms, at: at(), error: first.error, fallback: true }
      : { ok: false, model: MODEL(), ms: first.ms, at: at(), error: first.error, fallback: false })
  })().finally(() => { running = null })
  return running
}

// at start (after firstMs) and then every PRO_TRANSCRIBE_SELFTEST_MIN minutes; once only when repeat is false
let timer = null
export function startSelfTest({ firstMs = 3000, repeat = true } = {}) {
  const every = Number(process.env.PRO_TRANSCRIBE_SELFTEST_MIN ?? 10)
  if (timer || !(every > 0)) return
  const run = async () => {
    await selfTest().catch(() => {})
    timer = repeat ? setTimeout(run, (health.ok ? every : Math.min(every, 1)) * 60_000) : null
    timer?.unref?.()
  }
  timer = setTimeout(run, firstMs)
  timer.unref?.()
}
export function stopSelfTest() { clearTimeout(timer); timer = null }
