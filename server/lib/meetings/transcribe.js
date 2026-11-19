// Speech → text for one spoken piece (말 단위 WAV from the speaker's own browser).
// The same contract as process-gpt's /completion/upload (a recorded Blob in, {transcript} out), but per
// utterance and behind the meeting's member + consent checks. OpenAI's transcription API; the key is
// read from process-gpt's .env like every other key here and never leaves the server.
// A person's main language (lib/mainLang.js) is the language their pieces are transcribed in.
import { lang, L } from '../lang.js'
import { transcribeKey as apiKey } from '../openai.js'
import { normMain } from '../mainLang.js'

const BASE = () => (process.env.PRO_TRANSCRIBE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const MODEL = () => process.env.PRO_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
// a second model when the first does not answer (2026-11-18 production: gpt-4o-mini-transcribe through LiteLLM
// hung for 30 s on every piece, so a phone meeting had no captions); '' turns it off
const FALLBACK = () => process.env.PRO_TRANSCRIBE_FALLBACK_MODEL ?? 'whisper-1'
const TRY_MS = Number(process.env.PRO_TRANSCRIBE_TIMEOUT_MS || 15000)
// the last failure, for /api/meetings/stats (what the operator checks first)
export const lastError = { at: null, model: null, message: null }
export const transcribeConfigured = () => !!apiKey()

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
  const call = async (model) => {
    const form = new FormData()
    form.append('file', new Blob([buf], { type }), type.includes('webm') ? 'speech.webm' : 'speech.wav')
    form.append('model', model)
    form.append('language', spoken)
    form.append('response_format', 'json')
    if (prompt) form.append('prompt', prompt.slice(0, 600))
    const r = await fetch(`${BASE()}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}` }, body: form, signal: AbortSignal.timeout(TRY_MS) })
    if (!r.ok) throw Object.assign(new Error(`transcription ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 502 })
    return r.json()
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
