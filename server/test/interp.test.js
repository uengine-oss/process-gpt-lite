// Multilingual meetings and messages (openspec pgpt-pro-meeting-interpretation): language pairing,
// ducking, the translation cache, language guessing, the interpreter's sound and budget. No network,
// no database (the model call and the cache table are replaced).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as PA from '../lib/meetings/pairing.js'
import * as P from '../lib/meetings/pcm.js'
import * as TR from '../lib/translate.js'
import * as IP from '../lib/meetings/interpret.js'
import { normMain, resolveMain, uiLangFor, translateVoice } from '../lib/mainLang.js'
import * as D from '../../src/components/meetings/duck.js'
import { partsOf } from '../lib/team/roomTranslate.js'

const ko = { id: 'a', lang: 'ko', listen: 'interp', voice: true }
const en = { id: 'b', lang: 'en', listen: 'interp', voice: true }
const en2 = { id: 'c', lang: 'en', listen: 'interp', voice: true }
const ja = { id: 'd', lang: 'ja', listen: 'interp', voice: true }
const th = { id: 'e', lang: 'th', listen: 'interp', voice: true }

test('pairing: each other language gets subtitles and voice; never my own speech; same language untouched', () => {
  const p = PA.plan(ko, [ko, en, en2, ja])
  assert.deepEqual(p.subtitles.sort(), ['en', 'ja'])
  assert.deepEqual(p.voice.map((v) => v.lang).sort(), ['en', 'ja'])
  const toEn = p.voice.find((v) => v.lang === 'en')
  assert.deepEqual(toEn.listeners.sort(), ['b', 'c'])
  assert.ok(!p.voice.some((v) => v.listeners.includes('a')), 'the speaker never hears their own interpretation')
  // two English speakers: nothing between them
  const q = PA.plan(en, [en, en2])
  assert.deepEqual(q, { subtitles: [], voice: [] })
  // English speaker with a Korean and an English listener: only Korean is made, for the Korean listener
  const r = PA.plan(en, [ko, en, en2])
  assert.deepEqual(r.subtitles, ['ko'])
  assert.deepEqual(r.voice, [{ lang: 'ko', listeners: ['a'], engine: 'translate' }])
})

test('pairing: listen = original and a closed voice channel get subtitles but no voice; switch off = no voice', () => {
  const orig = { ...en, listen: 'original' }
  assert.deepEqual(PA.plan(ko, [ko, orig]).voice, [])
  assert.deepEqual(PA.plan(ko, [ko, orig]).subtitles, ['en'])
  assert.deepEqual(PA.plan(ko, [ko, { ...en, voice: false }]).voice, [])
  // one of two English listeners wants the original: the other still gets the voice
  assert.deepEqual(PA.plan(ko, [ko, orig, en2]).voice[0].listeners, ['c'])
  assert.deepEqual(PA.plan(ko, [ko, en], { on: false }), { subtitles: ['en'], voice: [] })
  assert.deepEqual(PA.plan(ko, [ko, en], { voice: false }).voice, [])
})

test('pairing: the engine — translate where it speaks the language, the chain otherwise or when set aside', () => {
  assert.equal(PA.engineFor('ja'), 'translate')
  assert.equal(PA.engineFor('th'), 'chain')
  assert.equal(PA.engineFor('ja', { engine: 'chain' }), 'chain')
  assert.equal(PA.engineFor('ja', { broken: true }), 'chain')
  const p = PA.plan(ko, [ko, th, ja])
  assert.deepEqual(Object.fromEntries(p.voice.map((v) => [v.lang, v.engine])), { th: 'chain', ja: 'translate' })
  assert.equal(translateVoice('ko'), true)
  assert.equal(translateVoice('ar'), false)
})

test('pairing: the 통역 switch is on by itself only when languages differ; a choice wins', () => {
  assert.equal(PA.interpOn(null, [ko, en]), true)
  assert.equal(PA.interpOn(null, [en, en2]), false)
  assert.equal(PA.interpOn(false, [ko, en]), false)
  assert.equal(PA.interpOn(true, [en, en2]), true)
  assert.deepEqual(PA.recordLangs('ko', ['ko', 'en', 'ja', 'en'], 'ko').sort(), ['en', 'ja'])
  assert.deepEqual(PA.recordLangs('ja', ['ko'], 'en').sort(), ['en', 'ko'])
})

test('main language: codes, defaults and the screens it gets', () => {
  assert.equal(normMain('ja-JP'), 'ja')
  assert.equal(normMain('xx'), null)
  assert.equal(resolveMain({ main: null, ui: 'en' }), 'en')
  assert.equal(resolveMain({ main: 'vi', ui: 'ko' }), 'vi')
  assert.equal(resolveMain({}), 'ko')
  assert.equal(uiLangFor('ko'), 'ko')
  assert.equal(uiLangFor('ja'), 'en')
  assert.equal(uiLangFor('en'), 'en')
})

test('ducking: the speaker is lowered (not cut) while their interpretation plays, back up after', () => {
  const st = { mode: 'interp', on: true, until: { a: 10_000 } }
  assert.equal(D.target('a', st, 9_000), D.DUCK)
  assert.ok(D.DUCK > 0 && D.DUCK < 1, 'lowered, not cut')
  assert.equal(D.target('a', st, 10_000 + D.HOLD_MS - 1), D.DUCK, 'held a moment after the last sound')
  assert.equal(D.target('a', st, 10_000 + D.HOLD_MS + 1), 1)
  assert.equal(D.target('b', st, 9_000), 1, 'only that speaker')
  assert.equal(D.target('a', { ...st, mode: 'original' }, 9_000), 1, 'hear original: full volume')
  assert.equal(D.target('a', { ...st, on: false }, 9_000), 1, 'switch off: full volume')
  assert.equal(D.interpGain(st), 1)
  assert.equal(D.interpGain({ ...st, mode: 'original' }), 0)
  assert.equal(D.speaking('a', st, 9_000), true)
  assert.equal(D.speaking('a', st, 11_000), false)
  // the fade: a few small steps, no jump
  let v = 1, n = 0
  while (v !== D.DUCK && n < 20) { v = D.ramp(v, D.DUCK); n++ }
  assert.ok(n >= 5 && n <= 8, `fades in ${n} ticks`)
  assert.equal(D.ramp(0.25, 0.2), 0.2)
})

test('guessing a text\'s language from its letters', () => {
  assert.deepEqual(TR.guessLang('견적서 PDF 보냈어요'), { lang: 'ko', sure: true })
  assert.deepEqual(TR.guessLang('見積書を送りました'), { lang: 'ja', sure: true })
  assert.deepEqual(TR.guessLang('我们明天开会'), { lang: 'zh', sure: true })
  assert.deepEqual(TR.guessLang('สวัสดีครับ ทุกคน'), { lang: 'th', sure: true })
  assert.deepEqual(TR.guessLang('Can you send the quote to the owner by Friday?'), { lang: 'en', sure: true })
  assert.equal(TR.guessLang('Hola equipo, mañana revisamos el presupuesto', 'es').lang, 'es')
  assert.equal(TR.guessLang('Hola equipo, mañana revisamos el presupuesto', 'es').sure, false)
  assert.equal(TR.needs('견적서 보냈어요', 'ko'), false)
  assert.equal(TR.needs('견적서 보냈어요', 'en'), true)
  assert.equal(TR.needs('Please check the quote', 'en'), false)
  assert.equal(TR.needs('Bonjour à tous, le devis est prêt', 'fr', 'fr'), null, 'Latin letters for a Latin reader: ask')
  assert.equal(TR.needs('Bonjour à tous, le devis est prêt', 'ja', 'fr'), true)
  assert.equal(TR.needs('👍', 'en'), null)
})

test('translation cache: once per (text, language), the same text at once waits for one call, same language costs nothing', async () => {
  TR.setDb(false)
  TR._cache.clear()
  const prev = process.env.PRO_TRANSLATE
  process.env.PRO_TRANSLATE = '1'
  let calls = 0
  TR.setModelCall(async ({ text, to }) => { calls++; await new Promise((r) => setTimeout(r, 20)); return { text: `[${to}] ${text}`, lang: 'ko', ms: 20, model: 'fake' } })
  try {
    if (!TR.enabled()) return // no OpenAI key on this machine: translate() returns the original (covered below)
    const [a, b] = await Promise.all([TR.translate('견적서 보냈어요', { to: 'en' }), TR.translate('견적서   보냈어요', { to: 'en' })])
    assert.equal(calls, 1, 'two asks at once, one call (and spaces do not make it another text)')
    assert.equal(a.text, '[en] 견적서 보냈어요')
    assert.equal(b.text, a.text)
    const c = await TR.translate('견적서 보냈어요', { to: 'en' })
    assert.equal(c.cached, true)
    assert.equal(calls, 1)
    await TR.translate('견적서 보냈어요', { to: 'ja' })
    assert.equal(calls, 2, 'another language is another translation')
    const d = await TR.translate('견적서 보냈어요', { to: 'ko' })
    assert.equal(d.same, true)
    assert.equal(calls, 2, 'Korean for a Korean reader: no call')
    const e = await TR.translate('견적서 보냈어요', { from: 'ko', to: 'ko', kind: 'speech' })
    assert.equal(e.same, true)
    // a meeting line and a chat message are cached apart (different prompts)
    await TR.translate('견적서 보냈어요', { from: 'ko', to: 'en', kind: 'speech' })
    assert.equal(calls, 3)
    // the model says it was already in the reader's language: remembered as "same"
    TR.setModelCall(async ({ text }) => { calls++; return { text, lang: 'fr', ms: 5, model: 'fake' } })
    const f = await TR.translate('Bonjour à tous', { to: 'fr', hint: 'fr' })
    assert.equal(f.same, true)
    const g = await TR.translate('Bonjour à tous', { to: 'fr', hint: 'fr' })
    assert.equal(g.cached, true)
    assert.equal(calls, 4)
    // a failing model: the original comes back, marked
    TR.setModelCall(async () => { throw Object.assign(new Error('429 quota'), { quota: true }) })
    const h = await TR.translate('새 견적서예요', { to: 'en' })
    assert.equal(h.error, 'quota')
    assert.equal(h.text, '새 견적서예요')
  } finally {
    TR.setModelCall(null); TR.setDb(true); TR._cache.clear()
    if (prev === undefined) delete process.env.PRO_TRANSLATE; else process.env.PRO_TRANSLATE = prev
  }
})

test('translation budget: a key may call a set number of times a minute', () => {
  for (let i = 0; i < 3; i++) assert.equal(TR.allow('t-budget', 3, 1000 + i), true)
  assert.equal(TR.allow('t-budget', 3, 1010), false)
  assert.equal(TR.allow('t-budget', 3, 1000 + 61000), true, 'a minute later')
  TR._cache.clear()
})

test('turning off: PRO_TRANSLATE=0 returns the original without calling anything', async () => {
  const prev = process.env.PRO_TRANSLATE
  process.env.PRO_TRANSLATE = '0'
  let called = false
  TR.setModelCall(async () => { called = true; return { text: 'x', lang: 'ko' } })
  try {
    const r = await TR.translate('견적서 보냈어요', { to: 'en' })
    assert.equal(r.off, true)
    assert.equal(r.text, '견적서 보냈어요')
    assert.equal(called, false)
  } finally { TR.setModelCall(null); if (prev === undefined) delete process.env.PRO_TRANSLATE; else process.env.PRO_TRANSLATE = prev }
})

test('messenger: what a reader needs translated', () => {
  const msg = (o) => ({ kind: 'text', mine: false, body: '견적서 보냈어요', ...o })
  assert.deepEqual(partsOf(msg(), 'en').map((p) => p.key), ['body'])
  assert.deepEqual(partsOf(msg(), 'ko'), [], 'same language: nothing')
  assert.deepEqual(partsOf(msg({ mine: true }), 'en'), [], 'never my own')
  assert.deepEqual(partsOf(msg({ kind: 'meeting' }), 'en'), [], 'meeting cards are drawn by the page')
  const block = { kind: 'meeting-transcript', meeting: { lines: [{ text: 'Hello all', lang: 'en', tr: { ko: '안녕하세요' } }, { text: '見積書です', lang: 'ja', tr: {} }, { text: '네', lang: 'ko' }] } }
  assert.deepEqual(partsOf(block, 'ko').map((p) => p.key), ['l1'], 'only the line without a Korean translation')
  const minutes = { kind: 'meeting-minutes', meeting: { lang: 'ko', summary: '요약', decisions: ['결정'], actions: [{ title: '할 일' }], tr: { en: {} } } }
  assert.deepEqual(partsOf(minutes, 'en'), [], 'already translated for English')
  assert.deepEqual(partsOf(minutes, 'ja').map((p) => p.key), ['summary', 'd0', 'a0'])
  assert.deepEqual(partsOf(minutes, 'ko'), [])
})

test('sound: WAV in, 24 kHz PCM out, frames that come apart again', () => {
  const n = 1600 // 100 ms at 16 kHz
  const wav = Buffer.alloc(44 + n * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), 44 + i * 2)
  const w = P.parseWav(wav)
  assert.equal(w.rate, 16000)
  assert.equal(w.samples.length, n)
  const pcm = P.wavToPcm24(wav)
  assert.equal(pcm.length, 2400 * 2, '100 ms at 24 kHz')
  assert.equal(P.msOf(pcm), 100)
  assert.equal(P.parseWav(Buffer.from('not a wav at all, not at all, really not a wav file')), null)
  assert.deepEqual(P.chunks(Buffer.alloc(4800 * 2 + 10), 200).map((c) => c.length), [9600, 10])
  const f = P.frame({ s: 'speaker', l: 'en', q: 3 }, Buffer.from([1, 2, 3, 4]))
  const back = P.unframe(f)
  assert.deepEqual(back.header, { s: 'speaker', l: 'en', q: 3 })
  assert.deepEqual([...back.pcm], [1, 2, 3, 4])
})

test('interpreter budget: seconds of speech × languages a minute per meeting', () => {
  const prev = process.env.PRO_INTERP_MAX_PER_MIN
  process.env.PRO_INTERP_MAX_PER_MIN = '30'
  try {
    assert.equal(IP.budget('m-budget', 10, 2, 0).ok, true) // 20 s
    assert.equal(IP.budget('m-budget', 6, 2, 1000).ok, false) // 32 s > 30
    assert.equal(IP.budget('m-budget', 5, 2, 2000).ok, true) // 30 s
    assert.equal(IP.budget('m-budget', 5, 1, 61_000).ok, true, 'the minute has passed')
  } finally { if (prev === undefined) delete process.env.PRO_INTERP_MAX_PER_MIN; else process.env.PRO_INTERP_MAX_PER_MIN = prev; IP.closeMeeting('m-budget') }
})
