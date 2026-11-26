'use strict'
// The page's 「내려받기」 in the desktop app (openspec/specs/file-download): the file lands in Downloads under the page's name — Korean as
// it is — and a name already there gets " (1)", " (2)" … before its extension, as a browser does (no save dialog). Only the app's own
// downloads: anything another page or frame starts keeps Electron's save dialog.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { savePathFor, quietSave } = require('../src/downloads')

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

test('FD-D-04 only the chosen server\'s own downloads skip the dialog — a blob: it made, its routes; anything else keeps the dialog', () => {
  const company = { server: 'https://acme.process-gpt.io/lite', authOrigins: ['https://auth.process-gpt.io'] }
  const local = { server: 'http://localhost:18080', authOrigins: [] }
  assert.equal(quietSave('blob:https://acme.process-gpt.io/5b1c-4d2e', company), true)
  assert.equal(quietSave('https://acme.process-gpt.io/lite/api/folders/f1/raw?path=a.docx&download=1', company), true)
  assert.equal(quietSave('blob:http://localhost:18080/0a1b', local), true)
  // another origin's blob, storage on another host, a sign-in page, a site, nothing
  assert.equal(quietSave('blob:https://evil.example/5b1c', company), false)
  assert.equal(quietSave('https://storage.example.com/storage/v1/object/public/files/a.pdf', company), false)
  assert.equal(quietSave('https://auth.process-gpt.io/file.pdf', company), false)
  assert.equal(quietSave('https://example.org/setup.exe', local), false)
  assert.equal(quietSave('data:application/pdf;base64,JVBER', local), false)
  assert.equal(quietSave('about:blank', local), false)
  assert.equal(quietSave('', local), false)
})
