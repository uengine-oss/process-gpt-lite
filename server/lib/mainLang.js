// A person's main language (주 언어): the language they speak in meetings and read messages in. It is
// separate from the screen language (lib/lang.js, ko|en): the screens exist in Korean and English only,
// so a main language other than those two gets the English screens. Unset = the screen language.
//   meetings   speech is transcribed in the speaker's main language; each listener gets subtitles and
//              the interpreter's voice in theirs (lib/meetings/interpret.js)
//   messenger  a message in another language than the reader's main language reads translated
//              (lib/translate.js), with the original one click away
// The list is what the whole chain can do: gpt-4o-mini-transcribe hears it, the text model writes it,
// and either gpt-realtime-translate (voice: true) or gpt-4o-mini-tts speaks it.
import { normLang } from './lang.js'

// code → [native name, English name, translate-model voice]
// voice: gpt-realtime-translate's 13 output languages; the others are spoken by the TTS chain
export const MAIN_LANGS = {
  ko: ['한국어', 'Korean', true],
  en: ['English', 'English', true],
  ja: ['日本語', 'Japanese', true],
  zh: ['中文', 'Chinese', true],
  es: ['Español', 'Spanish', true],
  fr: ['Français', 'French', true],
  de: ['Deutsch', 'German', true],
  pt: ['Português', 'Portuguese', true],
  it: ['Italiano', 'Italian', true],
  ru: ['Русский', 'Russian', true],
  hi: ['हिन्दी', 'Hindi', true],
  vi: ['Tiếng Việt', 'Vietnamese', true],
  id: ['Bahasa Indonesia', 'Indonesian', true],
  th: ['ไทย', 'Thai', false],
  ar: ['العربية', 'Arabic', false],
  tr: ['Türkçe', 'Turkish', false],
  nl: ['Nederlands', 'Dutch', false],
  pl: ['Polski', 'Polish', false],
}
export const isMainLang = (v) => Object.hasOwn(MAIN_LANGS, String(v || ''))
export const langName = (code) => MAIN_LANGS[code]?.[1] || code
export const nativeName = (code) => MAIN_LANGS[code]?.[0] || code
export const translateVoice = (code) => !!MAIN_LANGS[code]?.[2]
export const mainLangList = () => Object.entries(MAIN_LANGS).map(([code, [native, english, voice]]) => ({ code, native, english, voice }))

// 'ja', 'ja-JP', 'JA' → 'ja'; 'zh-Hant' → 'zh'; unknown → null
export function normMain(v) {
  const s = String(v ?? '').trim().toLowerCase().slice(0, 2)
  return isMainLang(s) ? s : null
}
// the screens for a main language: Korean for ko, English for everything else
export const uiLangFor = (main) => (main === 'ko' ? 'ko' : 'en')
// main language from the saved values: main_lang, else the screen language, else ko
export const resolveMain = ({ main, ui } = {}) => normMain(main) || normLang(ui) || 'ko'

// cached like lib/lang.js langOf (two servers share the database: a short life)
const cache = new Map() // userId -> {main, at}
const TTL_MS = 15_000
export async function mainLangOf(userId) {
  if (!userId) return 'ko'
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.main
  const { q } = await import('./supa.js')
  const [p] = await q(`select to_jsonb(p)->>'main_lang' as main, to_jsonb(p)->>'lang' as ui from pro_profile p where user_id=$1`, [userId]).catch(() => [])
  const main = resolveMain(p || {})
  cache.set(userId, { main, at: Date.now() })
  return main
}
export async function mainLangsOf(ids) {
  const out = {}
  for (const id of [...new Set(ids.filter(Boolean))]) out[id] = await mainLangOf(id)
  return out
}
export function rememberMain(userId, main) { if (userId) cache.set(userId, { main, at: Date.now() }) }
export const forgetMain = (userId) => cache.delete(userId)

export async function saveMainLang(userId, v) {
  const main = normMain(v)
  if (!main) throw Object.assign(new Error(`main language must be one of ${Object.keys(MAIN_LANGS).join(', ')}`), { status: 400 })
  const { q } = await import('./supa.js')
  await q('update pro_profile set main_lang=$2 where user_id=$1', [userId, main])
  rememberMain(userId, main)
  return main
}
