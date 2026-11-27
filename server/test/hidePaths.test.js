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
  // (PR #118 검토 2) Windows · 콜론 뒤 · file://localhost
  ['C:\\Users\\me\\Downloads\\견적.xlsx 에 있어요', '견적.xlsx 에 있어요'],
  ['D:/projects/run/out/요약.md.', '요약.md.'],
  ['\\\\fileserver\\share\\팀\\보고서.docx 를 봐요', '보고서.docx 를 봐요'],
  ['`C:\\Users\\me\\My Docs\\제안서.pptx` 와 `\\\\nas\\공유\\폴더\\`', '`제안서.pptx` 와 산출물 폴더'],
  ['[견적](C:\\Users\\me\\견적.pdf) · [초안](<C:\\Users\\me\\초안 (1).docx>)', '견적 · 초안'],
  ['경로:/workspace/.bpmn/c/a.md · 위치:/Users/me/x/b.csv', '경로:a.md · 위치:b.csv'],
  ['file://localhost/Users/me/c.txt 와 file:///C:/Users/me/d.txt', 'c.txt 와 d.txt'],
  ['주소 http://host.example/Users/me 와 https://x.example:8080/tmp/a 는 주소의 일부라 그대로', '주소 http://host.example/Users/me 와 https://x.example:8080/tmp/a 는 주소의 일부라 그대로'],
  // (PR #118 후속) macOS 의 임시 폴더(os.tmpdir() — /var/folders/…, 그 실제 자리 /private/var/folders/…)와 /var/tmp 도 서버의 자리
  ['임시: /var/folders/xy/abc123/T/pgl-run/결과.csv 와 `/private/var/folders/xy/abc123/T/out/`', '임시: 결과.csv 와 산출물 폴더'],
  ['[로그](/var/tmp/run/로그.txt) · 경로:/var/folders/xy/T/a.md · https://x.example/var/folders/a 는 주소', '로그 · 경로:a.md · https://x.example/var/folders/a 는 주소'],
  ['/var/log 나 /variable 은 임시 폴더가 아니라 그대로', '/var/log 나 /variable 은 임시 폴더가 아니라 그대로'],
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
  // (PR #118 검토 2) 대문자 scheme · //host · 줄이 끊긴 주소 · <…> 안의 빈칸 · 괄호 · key 와 AIza…
  const more = [
    ['HTTPS://STORAGE.LITE.TEST:54321/STORAGE/V1/OBJECT/public/files/a/표.xlsx', '표.xlsx'],
    ['//cdn.example/a/file.pdf?token=x 와 //cdn.example/b/공개.pdf', 'file.pdf 와 //cdn.example/b/공개.pdf'],
    ['첨부: https://x.example/a/report.pdf\n?token=abc\n&exp=1 끝', '첨부: report.pdf 끝'],
    ['참고: https://www.example.com/guide\n/workspace/.bpmn/c/a.md', '참고: https://www.example.com/guide\n/workspace/.bpmn/c/a.md'],
    ['[보고서](<https://x.example/a b (1).pdf?token=q>) · [r](https://x.example/a_(1).pdf?sig=z "t")', '보고서 · r'],
    // (PR #118 후속) 평범한 key=abc 는 지도 · 검색 주소의 쿼리 — 그대로, 알려진 이름(api_key) · 비밀 모양의 값(AIza…)만
    ['https://maps.example/api/js?key=abc 와 https://x.example/v?api_key=1 와 https://y.example/q?k=AIzaSyA-1234567890abcdefghijk', 'https://maps.example/api/js?key=abc 와 비공개 주소 와 비공개 주소'],
    ['보통: https://www.youtube.com/watch?v=abc&list=x', '보통: https://www.youtube.com/watch?v=abc&list=x'],
  ]
  for (const [input, want] of more) assert.equal(H.dropPrivateUrls(input, hosts), want, input)
  // the broken address's next line is not left behind as a path either (addresses first, then paths)
  assert.equal(H.cleanShared('참고: https://www.example.com/guide\n/workspace/.bpmn/c/a.md', hosts), '참고: https://www.example.com/guide\na.md')
  assert.equal(H.privateUrl('https://www.youtube.com/watch?v=abc', hosts), false)
  assert.equal(H.privateUrl('https://x.example/a?signature=1', hosts), true)
  assert.equal(H.privateUrl('ftp://storage.lite.test:54321/a', hosts), false)
  // both at once: what a shared answer may say
  assert.equal(H.cleanShared('`/workspace/.bpmn/c/a.md` · http://storage.lite.test:54321/storage/v1/object/public/files/a/표.xlsx', hosts), '`a.md` · 표.xlsx')
})

// (PR #118 후속 1) 온전한 주소가 아닌 서명 · 토큰 조각 — 혼자 있으면 「비공개 주소」, 낱말 · 주소 조각에 붙었으면 조각만 빠짐, 띄어 쓴 주소 뒤의 조각은 주소와 함께
test('주소: 줄 가운데 홀로 있는 서명 · 토큰 조각도 남지 않는다', () => {
  const hosts = H.storageHosts()
  const cases = [
    ['서명 값 ?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln 를 붙여요', '서명 값 비공개 주소 를 붙여요'],
    ['뒤에 &sig=9f86d081884c7d659a2feaa0c55ad015&exp=1767225600 을 붙이면 열려요', '뒤에 비공개 주소 을 붙이면 열려요'],
    ['`?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIAEXAMPLE` 은 만료돼요', '`비공개 주소` 은 만료돼요'],
    ['주소가 길어 나눠 적어요: https://files.example/a/견적서.pdf ?token=abc 끝', '주소가 길어 나눠 적어요: 견적서.pdf 끝'],
    ['files.example/a/견적서.pdf?sig=abc&exp=1 를 열어요', 'files.example/a/견적서.pdf 를 열어요'],
    ['로그인 뒤 #access_token=ya29.a0AfH6SMB&expires_in=3600 이 붙어요', '로그인 뒤 비공개 주소 이 붙어요'],
    ['값:&api_key=1 끝 · 첫 줄\n?token=abc 로 시작하는 줄', '값:비공개 주소 끝 · 첫 줄\n비공개 주소 로 시작하는 줄'],
    ['?key=intro 와 &key=AIzaSyA-1234567890abcdefghijk', '?key=intro 와 비공개 주소'],
  ]
  for (const [input, want] of cases) assert.equal(H.dropPrivateUrls(input, hosts), want, input)
  // ordinary pieces, a placeholder with no value, an address broken by a space whose query is ordinary: as they are
  for (const same of ['?page=2 와 &sort=asc · R&D=연구 · Q&A 는 그대로', '주소 끝의 ?token=<값> 은 자리만 말한 것', 'https://www.example.com/guide ?page=2 는 그대로',
    '[지도](https://maps.example/embed?key=seoul-office&zoom=3) 와 # 제목']) assert.equal(H.dropPrivateUrls(same, hosts), same, same)
  // with the paths, as a shared answer says it
  assert.equal(H.cleanShared('초안 /workspace/.bpmn/c/a.md · 서명 &sig=abc', hosts), '초안 a.md · 서명 비공개 주소')
})

// (PR #118 후속 2) key 는 값이 비밀 모양일 때만 — urlTokens.js 가 숨기는 이름(서명 · 토큰 · API 키 · OAuth 의 code · 주소 안의 주소 · 사용자 이름과 암호)은 값과 상관없이
test('주소: 평범한 key · auth · secret 쿼리는 그대로, 알려진 서명 이름과 비밀 모양의 값만 가린다', () => {
  const hosts = H.storageHosts()
  const keep = [
    'https://maps.example/api/js?key=abc',
    'https://maps.example/embed?key=seoul-office&zoom=3',
    'https://search.example/?key=교육과정&page=2',
    '[안내](https://docs.example.org/view?key=intro-2024-11)',
    'https://x.example/a?auth=sso 와 https://x.example/b?secret=on',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLGomJKgQCAv0abcdEFGH1234567890ab',
    'https://x.example/cb?code=12345',
    'https://docs@x.example/guide/intro',
  ]
  for (const s of keep) {
    assert.equal(H.dropPrivateUrls(s, hosts), s, s)
    assert.equal(H.cleanShared(s, hosts), s, s)
  }
  const hide = [
    ['https://maps.example/api/js?key=AIzaSyA-1234567890abcdefghijk', '비공개 주소'],
    ['https://api.example/v1/data.json?key=3f786850e387550fdab836ed7e6dc881de23001b', 'data.json'],
    ['https://x.example/a?auth=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', '비공개 주소'],
    ['https://x.example/a?secret=sk9Xq2LmN4pR7tV1wY3zB6', '비공개 주소'],
    ['https://x.example/v?api_key=1 · https://x.example/r.pdf?token=a', '비공개 주소 · r.pdf'],
    ['https://id.example/cb?code=abc&state=xyz', '비공개 주소'],
    ['https://app.example/#access_token=abc&expires_in=3600', '비공개 주소'],
    ['https://user:pw@x.example/a', '비공개 주소'],
    ['https://x.example/go?next=https%3A%2F%2Fy.example%2Fcb%3Ftoken%3Dabc', '비공개 주소'],
  ]
  for (const [input, want] of hide) assert.equal(H.dropPrivateUrls(input, hosts), want, input)
  assert.equal(H.privateUrl('https://maps.example/api/js?key=abc', hosts), false)
  assert.equal(H.privateUrl('https://maps.example/api/js?KEY=AIzaSyA-1234567890abcdefghijk', hosts), true)
  assert.equal(H.secretShape('seoul-office-2024-11-28'), false)
  assert.equal(H.secretShape('0f8fad5b-d9cb-469f-a165-70867728950e'), true)
})
