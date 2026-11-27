// 나가는 글에서 경로와 비공개 주소 빼기 (server lib/hidePaths.js — PR #118 검토 M1). 모델 · DB 없이.
//   - 경로: 화면의 src/paths.js 와 같은 답(서버 이미지에는 src/ 가 없고 웹 이미지에는 server/ 가 없어 두 곳에 있다 — 여기서 둘을 같은 사례로 맞춘다)
//   - 주소: 이 앱의 저장소 주소 · 서명이나 토큰이 붙은 주소는 이름만(링크는 글자), 보통 웹 주소는 그대로
// Run: node --test test/hidePaths.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.PRO_SUPABASE_URL = 'http://storage.lite.test:54321'
const H = await import('../lib/hidePaths.js')

// the page's own module, read in node: what it needs of a browser at import (src/i18n/lang.js — the screen's language)
globalThis.location = { search: '', origin: 'http://lite.test', href: 'http://lite.test/' }
globalThis.document = { documentElement: {} }
globalThis.window = globalThis
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ko-KR' }, configurable: true })
const P = await import('../../src/paths.js')

const CASES = [
  ['파일: `/workspace/.bpmn/a/견적서.xlsx` 와 /Users/me/x/폴더/', '파일: `견적서.xlsx` 와 산출물 폴더'],
  ['[초안](</workspace/.bpmn/c/초안 1.docx>) 을 봐 주세요', '초안 을 봐 주세요'],
  ['[초안]( /workspace/.bpmn/c/초안.docx ) 띄어 쓴 주소', '초안 띄어 쓴 주소'],
  ['[로컬](file:///Users/me/a.md) 과 file:///home/me/b.txt.', '로컬 과 b.txt.'],
  ['sandbox:/workspace/.bpmn/c/out.pdf 에 있어요', 'out.pdf 에 있어요'],
  ['/private/tmp/run/로그.txt: 끝', '로그.txt: 끝'],
  ['경로 없는 글은 그대로예요 · 3/4 분기', '경로 없는 글은 그대로예요 · 3/4 분기'],
]

test('경로: 서버와 화면이 같은 답', () => {
  for (const [input, want] of CASES) {
    assert.equal(H.hidePaths(input), want, `server: ${input}`)
    assert.equal(P.hidePaths(input), want, `page: ${input}`)
  }
})

test('주소: 저장소 · 서명 · 토큰은 이름만(링크는 글자), 보통 웹 주소는 그대로', () => {
  const hosts = H.storageHosts()
  assert.deepEqual(hosts, ['storage.lite.test:54321'])
  const cases = [
    ['http://storage.lite.test:54321/storage/v1/object/public/files/pgpt-pro/u/0f8fad5b-d9cb-469f-a165-70867728950e.md 를 열어요', '비공개 주소 를 열어요'],
    ['https://other.example/storage/v1/object/sign/private/a/견적서.pdf?token=x.y.z.', '견적서.pdf.'],
    ['[보고서](https://bucket.s3.amazonaws.com/r/report.pdf?X-Amz-Signature=ab&X-Amz-Credential=c "제목")', '보고서'],
    ['<https://lite.example/api/team/shares/1/raw?sig=a&u=b&exp=1>', '비공개 주소'],
    ['https://lite.example/api/folders/x/raw?path=a.md&token=abc 와 https://lite.example/doc.pdf?access_token=q', '비공개 주소 와 doc.pdf'],
    ['보통 주소 https://www.example.com/guide?page=2 와 [안내](https://docs.example.org/a) 는 그대로', '보통 주소 https://www.example.com/guide?page=2 와 [안내](https://docs.example.org/a) 는 그대로'],
  ]
  for (const [input, want] of cases) assert.equal(H.dropPrivateUrls(input, hosts), want, input)
  assert.equal(H.privateUrl('https://www.youtube.com/watch?v=abc', hosts), false)
  assert.equal(H.privateUrl('https://x.example/a?signature=1', hosts), true)
  assert.equal(H.privateUrl('ftp://storage.lite.test:54321/a', hosts), false)
  // both at once: what a shared answer may say
  assert.equal(H.cleanShared('`/workspace/.bpmn/c/a.md` · http://storage.lite.test:54321/storage/v1/object/public/files/a/표.xlsx', hosts), '`a.md` · 표.xlsx')
})
