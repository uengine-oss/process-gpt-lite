// Who gets what of one person's speech in a meeting that mixes languages (pure; test/interp.test.js).
//   subtitles  every main language in the meeting other than the speaker's own (each listener reads
//              the line in theirs, under the original)
//   voice      the same languages, but only where at least one listener of that language wants to hear
//              the interpretation (listen = 'interp') and has the voice channel open — nobody hears a
//              translation of their own speech, and two people with the same language hear each other
//              untouched (no translation between them at all)
//   engine     gpt-realtime-translate where it speaks the language (13 of them), the text → TTS chain
//              otherwise, or when translate is set aside (PRO_INTERP_ENGINE=chain, or it failed lately)
import { translateVoice } from '../mainLang.js'

const uniq = (xs) => [...new Set(xs.filter(Boolean))]

// the meeting's 통역 switch: set by someone (true/false), else on as soon as two languages meet
export function interpOn(setting, people) {
  if (setting === true || setting === false) return setting
  return uniq(people.map((p) => p.lang)).length > 1
}

// people: [{id, lang, listen: 'interp'|'original', voice: bool (channel open)}]
export function plan(speaker, people, { on = true, voice = true, engine = 'translate', broken = false } = {}) {
  const others = people.filter((p) => p.id !== speaker.id)
  const subtitles = uniq(others.map((p) => p.lang)).filter((l) => l !== speaker.lang)
  if (!on) return { subtitles, voice: [] }
  const out = []
  if (voice) {
    for (const lang of subtitles) {
      const listeners = others.filter((p) => p.lang === lang && p.listen !== 'original' && p.voice !== false).map((p) => p.id)
      if (listeners.length) out.push({ lang, listeners, engine: engineFor(lang, { engine, broken }) })
    }
  }
  return { subtitles, voice: out }
}

export function engineFor(lang, { engine = 'translate', broken = false } = {}) {
  return engine === 'translate' && !broken && translateVoice(lang) ? 'translate' : 'chain'
}

// the languages a line must be written in for the room's record: the readers' (the room's people) and
// the meeting's own (its cards and minutes), minus the line's
export function recordLangs(lineLang, readerLangs, meetingLang) {
  return uniq([...readerLangs, meetingLang]).filter((l) => l !== lineLang)
}
