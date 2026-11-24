// 받침에 맞는 조사 — a word's last sound decides 이/가 · 은/는 · 을/를 · 과/와 · 으로/로 (grammar, not meaning). A Hangul syllable by its
// final consonant; otherwise the way the word is read: digits (영·일·삼·육·칠·팔 end in a consonant), Latin letters l · r · m · n. Closing
// brackets and punctuation after the word are skipped (「견적서 작성」을). The same rules as the server's lib/josa.js (tested there).
const tail = (word) => {
  const s = String(word ?? '').replace(/[\s\p{P}\p{S}]+$/u, '')
  const ch = s.slice(-1)
  if (!ch) return { has: false, rieul: false }
  const c = ch.charCodeAt(0)
  if (c >= 0xac00 && c <= 0xd7a3) { const j = (c - 0xac00) % 28; return { has: j > 0, rieul: j === 8 } }
  if (/[0-9]/.test(ch)) return { has: '0136781'.includes(ch), rieul: '178'.includes(ch) }
  if (/[lr]/i.test(ch)) return { has: true, rieul: true }
  if (/[mn]/i.test(ch)) return { has: true, rieul: false }
  return { has: false, rieul: false }
}
// the particle alone: josa('윤태호') → '가', josa('서하린') → '이', josa('견적서 작성', '을', '를') → '을'
export function josa(word, withFinal = '이', without = '가') { return tail(word).has ? withFinal : without }
// 으로 · 로 (ㄹ 받침도 「로」)
export function ro(word) { const t = tail(word); return t.has && !t.rieul ? '으로' : '로' }
// the word with its particle: iga('윤태호') → '윤태호가'
export const iga = (w) => `${w}${josa(w)}`
export const eunNeun = (w) => `${w}${josa(w, '은', '는')}`
export const eulReul = (w) => `${w}${josa(w, '을', '를')}`
