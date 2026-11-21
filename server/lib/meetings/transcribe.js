// Speech → text for one spoken piece (말 단위 WAV from the speaker's own browser).
// The same contract as process-gpt's /completion/upload (a recorded Blob in, {transcript} out), but per
// utterance and behind the meeting's member + consent checks. OpenAI's transcription API; the key is
// read from process-gpt's .env like every other key here and never leaves the server.
// A person's main language (lib/mainLang.js) is the language their pieces are transcribed in.
import { lang, L } from '../lang.js'
import { transcribeKey as apiKey } from '../openai.js'
import { normMain } from '../mainLang.js'
import { parseWav } from './pcm.js'

const BASE = () => (process.env.PRO_TRANSCRIBE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const MODEL = () => process.env.PRO_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
// a second model when the first does not answer (2026-11-18 production: gpt-4o-mini-transcribe through LiteLLM
// hung for 30 s on every piece, so a phone meeting had no captions); '' turns it off
const FALLBACK = () => process.env.PRO_TRANSCRIBE_FALLBACK_MODEL ?? 'whisper-1'
const TRY_MS = Number(process.env.PRO_TRANSCRIBE_TIMEOUT_MS || 15000)
// the last failure, for /api/meetings/stats (what the operator checks first)
export const lastError = { at: null, model: null, message: null }
export const transcribeConfigured = () => !!apiKey()

// What transcription models make up from noise or silence (they were trained on subtitled video) is
// caught by signals, never by a list of phrases:
//   1. the sound itself: a 16-bit PCM piece with almost no frame above the voice level is not sent
//   2. whisper (verbose_json): each segment's no_speech_prob and avg_logprob — dropped when both say
//      "no speech" (whisper's own decoding thresholds: no_speech 0.6, logprob -1.0), or when the text
//      repeats itself (compression ratio above 2.4)
//   3. gpt-4o(-mini)-transcribe (json + include[]=logprobs): the mean token log-probability
// A model or proxy that refuses a parameter (400) is remembered and asked without it.
const NO_SPEECH = Number(process.env.PRO_TRANSCRIBE_NO_SPEECH || 0.6)
const LOGPROB_MIN = Number(process.env.PRO_TRANSCRIBE_LOGPROB_MIN || -1.0)
const MEAN_LOGPROB_MIN = Number(process.env.PRO_TRANSCRIBE_MEAN_LOGPROB_MIN || -1.2)
const COMPRESSION_MAX = 2.4
// voice level: a 30 ms frame whose RMS is above -45 dBFS; a piece needs about 0.1 s of such frames
const FRAME_MS = 30, VOICE_RMS = 32768 * 10 ** (-45 / 20), VOICE_FRAMES = 3
export function voiced(buf) {
  const w = parseWav(buf)
  if (!w || !w.samples.length) return null // not a PCM WAV (webm/ogg): no opinion
  const n = Math.max(1, Math.round((w.rate * FRAME_MS) / 1000))
  let frames = 0
  for (let o = 0; o + n <= w.samples.length; o += n) {
    let sum = 0
    for (let i = o; i < o + n; i++) sum += w.samples[i] * w.samples[i]
    if (Math.sqrt(sum / n) > VOICE_RMS && ++frames >= VOICE_FRAMES) return true
  }
  return false
}
// the text of an answer without what the model's own signals call no speech
export function spokenText(j) {
  const segs = Array.isArray(j?.segments) ? j.segments : null
  if (segs) {
    const kept = segs.filter((g) => !((g.no_speech_prob ?? 0) > NO_SPEECH && (g.avg_logprob ?? 0) < LOGPROB_MIN) && !((g.compression_ratio ?? 0) > COMPRESSION_MAX))
    return { text: kept.map((g) => g.text).join(' '), dropped: segs.length - kept.length, signal: 'segments' }
  }
  if (Array.isArray(j?.logprobs) && j.logprobs.length) {
    const mean = j.logprobs.reduce((a, t) => a + (Number(t.logprob) || 0), 0) / j.logprobs.length
    return { text: mean < MEAN_LOGPROB_MIN ? '' : String(j.text || ''), dropped: mean < MEAN_LOGPROB_MIN ? 1 : 0, signal: 'logprobs', mean }
  }
  return { text: String(j?.text || ''), dropped: 0, signal: 'none' }
}
// per model: which answer shape it takes (learned from a 400, as lib/llm.js does for chat)
const shapes = new Map() // model -> 'verbose' | 'logprobs' | 'plain'
const SHAPES = ['verbose', 'logprobs', 'plain']

// the spoken language: the speaker's main language (service.js), else the meeting's
export async function transcribe(buf, { prompt = '', type = 'audio/wav', language = lang() } = {}) {
  if (!apiKey()) throw Object.assign(new Error(L('받아쓰기 키가 설정되지 않았어요.', 'No transcription key is set up.')), { status: 503 })
  const spoken = normMain(language) || 'ko'
  const t0 = Date.now()
  // silence or a breath: not worth a call (and a call is what makes up a sentence)
  if (voiced(buf) === false) return { text: '', ms: Date.now() - t0, model: null, language: spoken, signal: 'silence' }
  const once = async (model, shape) => {
    const form = new FormData()
    form.append('file', new Blob([buf], { type }), type.includes('webm') ? 'speech.webm' : 'speech.wav')
    form.append('model', model)
    form.append('language', spoken)
    form.append('response_format', shape === 'verbose' ? 'verbose_json' : 'json')
    if (shape === 'logprobs') form.append('include[]', 'logprobs')
    if (prompt) form.append('prompt', prompt.slice(0, 600))
    const r = await fetch(`${BASE()}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}` }, body: form, signal: AbortSignal.timeout(TRY_MS) })
    if (!r.ok) throw Object.assign(new Error(`transcription ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 502, http: r.status })
    return r.json()
  }
  const call = async (model) => {
    for (let i = SHAPES.indexOf(shapes.get(model) || 'verbose'); ; i++) {
      try { const j = await once(model, SHAPES[i]); shapes.set(model, SHAPES[i]); return j } catch (e) {
        // a refused parameter: the next plainer shape; anything else is the model not answering
        if (e.http !== 400 || i >= SHAPES.length - 1) throw e
      }
    }
  }
  let j, model = MODEL()
  try { j = await call(model) } catch (e) {
    Object.assign(lastError, { at: new Date().toISOString(), model, message: e.name === 'TimeoutError' ? `no answer in ${TRY_MS / 1000}s` : e.message })
    if (!FALLBACK() || FALLBACK() === model) throw Object.assign(e, { status: 503 })
    model = FALLBACK()
    try { j = await call(model) } catch (e2) {
      Object.assign(lastError, { at: new Date().toISOString(), model, message: e2.name === 'TimeoutError' ? `no answer in ${TRY_MS / 1000}s` : e2.message })
      throw Object.assign(new Error(L('받아쓰기 서버가 응답하지 않아요. 잠시 뒤 다시 말씀하시거나, 말 대신 적어 주세요.', 'The transcription server is not answering. Try again in a moment, or type instead.')), { status: 503 })
    }
  }
  const heard = spokenText(j)
  const text = heard.text.replace(/\s+/g, ' ').trim()
  // the hint itself read back over silence ("회의 참석자: 장진영. 회의에 나올 수 있는 자료: ." became a line of the
  // 2026-11-18 meeting's record): text that is only a piece of the prompt is not speech
  const echo = promptEcho(text, prompt)
  return { text: echo || text.length < 2 ? '' : text, ms: Date.now() - t0, model, language: spoken, signal: heard.signal, dropped: heard.dropped }
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
