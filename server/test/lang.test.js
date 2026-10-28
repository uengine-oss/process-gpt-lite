// English mode: which language a request or a job runs in, and what model calls are told (lib/lang.js, lib/llm.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normLang, resolveLang, lang, isEn, L, locale, withLang, langInstruction, inLanguage, ENGLISH_NOTE } from '../lib/lang.js'
import { inLanguageMessages } from '../lib/llm.js'
import { craftAppsFor, officeHint } from '../lib/office.js'

test('normLang reads the usual spellings and nothing else', () => {
  for (const v of ['en', 'EN', 'en-US', 'en_GB', ' en ']) assert.equal(normLang(v), 'en', v)
  for (const v of ['ko', 'KO', 'ko-KR', 'ko_KR']) assert.equal(normLang(v), 'ko', v)
  for (const v of ['', null, undefined, 'fr', 'english', 'eng', 'korean', 'x-en']) assert.equal(normLang(v), null, String(v))
})

test('resolveLang: header > saved > ko', () => {
  assert.equal(resolveLang({ header: 'en', saved: 'ko' }), 'en')
  assert.equal(resolveLang({ header: 'ko', saved: 'en' }), 'ko')
  assert.equal(resolveLang({ header: undefined, saved: 'en' }), 'en')
  assert.equal(resolveLang({ header: 'fr', saved: 'en' }), 'en', 'an unknown header falls through to the saved language')
  assert.equal(resolveLang({ header: '', saved: null }), 'ko')
  assert.equal(resolveLang({}), 'ko')
  assert.equal(resolveLang(), 'ko')
})

test('outside any request the language is ko', () => {
  assert.equal(lang(), 'ko')
  assert.equal(isEn(), false)
  assert.equal(L('한국어', 'English'), '한국어')
  assert.equal(locale(), 'ko-KR')
  assert.equal(langInstruction(), '')
  assert.equal(inLanguage('프롬프트'), '프롬프트')
})

test('withLang carries the language through awaits, timers and promise chains', async () => {
  await withLang('en', async () => {
    assert.equal(lang(), 'en')
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(L('가', 'a'), 'a')
    const later = await new Promise((r) => setTimeout(() => r(lang()), 5))
    assert.equal(later, 'en', 'a timer started inside keeps it')
    const inner = await withLang('ko', async () => { await null; return lang() })
    assert.equal(inner, 'ko', 'a nested job runs in its own language')
    assert.equal(lang(), 'en', 'and the outer one is untouched')
    assert.equal(locale(), 'en-US')
  })
  assert.equal(lang(), 'ko')
  assert.equal(withLang('bogus', () => lang()), 'ko')
})

test('Korean mode: model messages go exactly as they were', () => {
  const msgs = [{ role: 'system', content: '한국어로 답해.' }, { role: 'user', content: '안녕' }]
  assert.equal(inLanguageMessages(msgs), msgs)
})

test('English mode: the note joins the first system message (one system message, at the start)', () => {
  withLang('en', () => {
    const msgs = [{ role: 'system', content: '한국어로 답해.' }, { role: 'user', content: '안녕' }]
    const out = inLanguageMessages(msgs)
    assert.equal(out.length, 2)
    assert.equal(out.filter((m) => m.role === 'system').length, 1)
    assert.equal(out[0].role, 'system')
    assert.ok(out[0].content.startsWith('한국어로 답해.'))
    assert.ok(out[0].content.endsWith(ENGLISH_NOTE))
    assert.equal(msgs[0].content, '한국어로 답해.', 'the caller\'s array is not changed')
    // no system message: the note becomes one
    const bare = inLanguageMessages([{ role: 'user', content: 'hi' }])
    assert.equal(bare[0].role, 'system')
    assert.equal(bare[0].content, ENGLISH_NOTE)
    // already there (a loop calling again with the same messages): not added twice
    assert.equal(inLanguageMessages(out), out)
    // a system prompt made of parts
    const parts = inLanguageMessages([{ role: 'system', content: [{ type: 'text', text: '규칙' }] }, { role: 'user', content: 'x' }])
    assert.equal(parts[0].content.at(-1).text, ENGLISH_NOTE)
  })
})

test('English mode: the agents get an [Instruction] line after the message, asking for English files', () => {
  withLang('en', () => {
    const i = langInstruction()
    assert.match(i, /^\n\n\[Instruction\] LANGUAGE: English/)
    assert.match(i, /file/i)
    assert.ok(!/[가-힣]{2,}/.test(i.replace(/\(한국어[^)]*\)/, '')), 'the instruction itself is English')
  })
})

test('ArtCraft asks are found in English as in Korean', () => {
  assert.deepEqual(craftAppsFor('Draw a floor plan for Moonlight Coffee Store #2'), ['cadcraft'])
  assert.deepEqual(craftAppsFor('make a logo for the cafe'), ['vectorcraft'])
  assert.deepEqual(craftAppsFor('trim the first 3 seconds of the video'), ['filmcraft'])
  assert.deepEqual(craftAppsFor('평면도 그려줘'), ['cadcraft'])
  assert.deepEqual(craftAppsFor('summarize this YouTube video'), [])
})

test('office hints: Korean unchanged, English names English example files', () => {
  const ko = officeHint('평면도 그려줘', '')
  assert.match(ko, /<base>\/평면도\.dxf/)
  withLang('en', () => {
    const en = officeHint('Draw a floor plan and write the proposal as a Word document', '')
    assert.match(en, /<base>\/floor-plan\.dxf/)
    assert.match(en, /English file names/)
    assert.ok(!/[가-힣]/.test(en), 'no Hangul in the English hint')
  })
})
