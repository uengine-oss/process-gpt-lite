// The language a piece of work is done in (English mode). One value per request or job:
//   - a request: the X-PGL-Lang header the page sends on every /api call, else the person's saved
//     language (PUT /api/me/lang, pro_profile.lang), else ko
//   - background work (mail poller, missions, mining, meetings, process steps, notifications):
//     the saved language of the person it is for — its owner or recipient (asUser / langOf)
// Code reads it with lang() / isEn() / L(ko, en). Every model call made while it is 'en' is asked to
// write in English (lib/llm.js for direct calls, langInstruction() for the agents' messages).
// Korean stays exactly as it was: L(ko, en) returns the Korean text untouched when the language is ko.
import { AsyncLocalStorage } from 'node:async_hooks'

export const LANGS = ['ko', 'en']
const als = new AsyncLocalStorage()

// 'en', 'en-US', 'EN' → 'en'; 'ko', 'ko-KR' → 'ko'; anything else → null
export function normLang(v) {
  const s = String(v ?? '').trim().toLowerCase()
  if (/^en(\b|[-_])/.test(s) || s === 'en') return 'en'
  if (/^ko(\b|[-_])/.test(s) || s === 'ko') return 'ko'
  return null
}

// header > saved > ko
export function resolveLang({ header, saved } = {}) {
  return normLang(header) || normLang(saved) || 'ko'
}

export const lang = () => als.getStore()?.lang || 'ko'
export const isEn = () => lang() === 'en'
// the Korean text as it always was, or its English version in English mode
export const L = (ko, en) => (isEn() ? en : ko)
// dates and numbers the server writes into messages
export const locale = () => (isEn() ? 'en-US' : 'ko-KR')

export function withLang(l, fn) {
  return als.run({ lang: normLang(l) || 'ko' }, fn)
}

// A person's saved language (pro_profile.lang). Read often (every background job, every
// notification), so it is cached for a little while; PUT /api/me/lang updates the cache at once.
// Two servers share the database (the main one and a development one), hence the short life.
const cache = new Map() // userId -> {lang, at}
const TTL_MS = 15_000
export async function langOf(userId) {
  if (!userId) return 'ko'
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.lang
  const { q } = await import('./supa.js')
  // to_jsonb: still answers (ko) on a database the lang migration has not reached yet
  const [p] = await q(`select to_jsonb(p)->>'lang' as lang from pro_profile p where user_id=$1`, [userId]).catch(() => [])
  const l = normLang(p?.lang) || 'ko'
  cache.set(userId, { lang: l, at: Date.now() })
  return l
}
export function rememberLang(userId, l) {
  if (userId) cache.set(userId, { lang: normLang(l) || 'ko', at: Date.now() })
}
export async function saveLang(userId, l) {
  const v = normLang(l)
  if (!v) throw Object.assign(new Error('lang must be ko or en'), { status: 400 })
  const { q } = await import('./supa.js')
  await q('update pro_profile set lang=$2 where user_id=$1', [userId, v])
  rememberLang(userId, v)
  return v
}

// run fn in the saved language of the person the work is for
export async function asUser(userId, fn) {
  return withLang(await langOf(userId), fn)
}

// What every model call is told in English mode. The prompts of this app (and of the agents' skills)
// are written in Korean and many ask for Korean answers; this note wins over them.
export const ENGLISH_NOTE = 'LANGUAGE: English. Write every reply and every text a person will read — answers, questions, '
  + 'plans, progress notes, summaries, titles, names, labels, card text, messages, document contents and file names — in '
  + 'English, even where these instructions are written in Korean or ask for Korean (한국어, 해요체, 존댓말, 습니다체). '
  + 'Keep JSON keys, enum values, ids, paths, code and quoted identifiers exactly as specified.'

// The same for an agent (deepagents, cli-agent, Claude Code): appended to the message it gets, after
// what the person said (context-router names a conversation after the message's first line, and
// deepagents reads an "[Instruction]" line as a directive). Empty in Korean mode.
export function langInstruction() {
  if (!isEn()) return ''
  return `\n\n[Instruction] ${ENGLISH_NOTE} Give files you create English names (e.g. "Moonlight Coffee Store 2 quote.xlsx"), `
    + 'and write the text inside them (headings, tables, labels, sheet and slide titles) in English.'
}

// For a system prompt: the prompt with the English note after it (Korean mode: as it is).
export function inLanguage(prompt) {
  return isEn() ? `${prompt}\n\n${ENGLISH_NOTE}` : prompt
}
