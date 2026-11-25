// The English dictionary (src/i18n/ko-en.json) the runtime translator reads: every exact entry is Korean → English text,
// every pattern a [Korean, English] pair with the same placeholders — a merge that flattens pairs into one array
// (11-25: six patterns fell into one 12-item entry and stopped translating) fails here.
//   node --test test/i18n-dictionary.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const dict = JSON.parse(fs.readFileSync(new URL('../../src/i18n/ko-en.json', import.meta.url), 'utf8'))
const holes = (s) => [...String(s).matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',')

test('exact: 한국어 → 영어 글자', () => {
  assert.equal(typeof dict.exact, 'object')
  for (const [ko, en] of Object.entries(dict.exact)) {
    // (an empty English is deliberate for a Korean particle: 「님이」 · 「건」 · 「명」)
    assert.equal(typeof en, 'string', `exact 「${ko}」`)
  }
})

test('patterns: 모두 [한국어, 영어] 한 쌍이고, 영어는 한국어에 없는 자리표시를 쓰지 않는다', () => {
  assert.ok(Array.isArray(dict.patterns))
  const seen = new Set()
  dict.patterns.forEach((p, i) => {
    assert.ok(Array.isArray(p) && p.length === 2, `patterns[${i}] is not a pair: ${JSON.stringify(p).slice(0, 120)}`)
    assert.ok(typeof p[0] === 'string' && typeof p[1] === 'string', `patterns[${i}] holds a non-string`)
    // (English may leave a value out or move it — 「{2}만원」 — but never use one the Korean does not have)
    const ko = new Set(holes(p[0]).split(',').filter(Boolean))
    for (const h of holes(p[1]).split(',').filter(Boolean)) assert.ok(ko.has(h), `patterns[${i}] 「${p[0]}」 English uses {${h}}`)
    assert.ok(!seen.has(p[0]), `patterns[${i}] 「${p[0]}」 appears twice`)
    seen.add(p[0])
  })
})

test('context: [선택자, 한국어, 영어] 세 개씩', () => {
  for (const [i, c] of (dict.context || []).entries()) assert.ok(Array.isArray(c) && c.length === 3, `context[${i}]`)
})
