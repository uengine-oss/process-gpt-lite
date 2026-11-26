'use strict'
// The page's 「내려받기」 in the desktop app (openspec/specs/file-download): the file lands in Downloads under the page's name — Korean as
// it is — and a name already there gets " (1)", " (2)" … before its extension, as a browser does (no save dialog).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { savePathFor } = require('../src/downloads')

const DIR = path.join('/Users', 'someone', 'Downloads')
const none = () => false

test('FD-D-01 the name the page gave, in Downloads — Korean, spaces and brackets as they are', () => {
  assert.equal(savePathFor(DIR, '견적서 초안 (최종).docx', none), path.join(DIR, '견적서 초안 (최종).docx'))
  // a Mac's decomposed 한글 is joined (NFC), as the page names it
  assert.equal(savePathFor(DIR, '견적서.hwp'.normalize('NFD'), none), path.join(DIR, '견적서.hwp'))
})

test('FD-D-02 a name already there: " (1)", " (2)" before the extension', () => {
  const have = new Set([path.join(DIR, '급여대장.xlsx'), path.join(DIR, '급여대장 (1).xlsx')])
  assert.equal(savePathFor(DIR, '급여대장.xlsx', (p) => have.has(p)), path.join(DIR, '급여대장 (2).xlsx'))
  const noExt = new Set([path.join(DIR, 'README')])
  assert.equal(savePathFor(DIR, 'README', (p) => noExt.has(p)), path.join(DIR, 'README (1)'))
})

test('FD-D-03 never outside Downloads: separators and a leading dot go, an empty name is "download"', () => {
  assert.equal(savePathFor(DIR, '../../etc/passwd', none), path.join(DIR, '_.._etc_passwd'))
  assert.equal(savePathFor(DIR, '.hidden', none), path.join(DIR, 'hidden'))
  assert.equal(savePathFor(DIR, '', none), path.join(DIR, 'download'))
  for (const n of ['a/b.pdf', 'a\\b.pdf', 'a:b.pdf']) assert.equal(path.dirname(savePathFor(DIR, n, none)), DIR)
})
