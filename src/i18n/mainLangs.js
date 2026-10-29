// Main languages (주 언어) a person can speak and read in — the same list as server/lib/mainLang.js.
// The screens stay Korean or English (lang.js); a main language other than Korean gets the English
// screens. Names are each language's own (shown under data-no-i18n).
export const MAIN_LANGS = [
  ['ko', '한국어'], ['en', 'English'], ['ja', '日本語'], ['zh', '中文'], ['es', 'Español'], ['fr', 'Français'],
  ['de', 'Deutsch'], ['pt', 'Português'], ['it', 'Italiano'], ['ru', 'Русский'], ['hi', 'हिन्दी'], ['vi', 'Tiếng Việt'],
  ['id', 'Bahasa Indonesia'], ['th', 'ไทย'], ['ar', 'العربية'], ['tr', 'Türkçe'], ['nl', 'Nederlands'], ['pl', 'Polski'],
]
const NAMES = Object.fromEntries(MAIN_LANGS)
export const langLabel = (code) => NAMES[code] || code || ''
export const uiLangFor = (main) => (main === 'ko' ? 'ko' : 'en')

// a cheap look at a text's letters (server/lib/translate.js guessLang): is it surely in `to`?
// true = surely another language, false = surely `to`, null = cannot tell (ask the server)
const LATIN = new Set(['en', 'es', 'fr', 'de', 'pt', 'it', 'vi', 'id', 'tr', 'nl', 'pl'])
export function maybeOther(text, to) {
  const s = String(text || '')
  const ko = (s.match(/[가-힣]/g) || []).length
  const kana = (s.match(/[぀-ヿ]/g) || []).length
  const han = (s.match(/[一-鿿]/g) || []).length
  const latin = (s.match(/[A-Za-zÀ-ɏ]/g) || []).length
  const all = ko + kana + han + latin + (s.match(/[฀-๿؀-ۿЀ-ӿऀ-ॿ]/g) || []).length
  if (all < 2) return false
  if (ko >= Math.max(2, all * 0.15)) return to !== 'ko'
  if (kana >= Math.max(1, all * 0.05)) return to !== 'ja'
  if (latin >= all * 0.6) return LATIN.has(to) ? null : true
  return null
}
