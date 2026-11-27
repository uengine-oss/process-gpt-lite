// 나가는 글에서 경로와 비공개 주소 빼기 (server lib/hidePaths.js — PR #118 검토 M1). 모델 · DB 없이.
//   - 경로: 화면의 src/paths.js 와 같은 답(서버 이미지에는 src/ 가 없고 웹 이미지에는 server/ 가 없어 두 곳에 있다 — 여기서 둘을 같은 사례로 맞춘다)
//   - 주소: 이 앱의 저장소 주소 · 서명이나 토큰이 붙은 주소는 이름만(링크는 글자), 보통 웹 주소는 그대로
// Run: node --test test/hidePaths.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_SUPABASE_URL = 'http://storage.lite.test:54321'
const H = await import('../lib/hidePaths.js')

// the page's own module, read in node: what it needs of a browser at import (src/i18n/lang.js — the screen's language)
globalThis.location = { search: '', origin: 'http://lite.test', href: 'http://lite.test/' }
globalThis.document = { documentElement: {} }
globalThis.window = globalThis
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ko-KR' }, configurable: true })
const P = await import('../../src/paths.js')

// Fake values, built when the test runs — nothing in this public file reads as a real key (a seed repeated to a length, prefixes joined)
const fake = (seed, n) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n)
const F = {
  shaped: fake('Qz7xK2mP9w', 24),                                             // letters and digits, one long run: a secret's look
  b64: `${fake('Ab12Cd34', 16)}+${fake('Ef56Gh78', 10)}/${fake('Ij90', 6)}==`,  // base64 with a raw + and /
  jwt: ['ey' + 'J' + fake('hbGci0iJ', 18), 'ey' + 'J' + fake('zdW1i0iI', 22), fake('Sf1KxwRJ', 32)].join('.'),
  gkey: 'AI' + 'za' + fake('Sy9-k2Lm', 33),
  pat: 'gh' + 'p_' + fake('PaT0kq7Z', 36),
  hex: fake('3f78685e', 40),
}

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
    [`https://maps.example/api/js?key=abc 와 https://x.example/v?api_key=1 와 https://y.example/q?k=${F.gkey}`, 'https://maps.example/api/js?key=abc 와 비공개 주소 와 비공개 주소'],
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

// (PR #118 후속 1 · PR #122 검토 3) 온전한 주소가 아닌 서명 · 토큰 조각: 값만 「…」(urlTokens.js 처럼) — 조각 앞뒤의 글 · 코드는 그대로, 자리만 말한 값(…, ..., YOUR_*,
// ${…}, {…}, <…>, xxx, getToken())은 그대로. 띄어 쓴 주소 뒤의 조각은 주소와 함께 파일 이름으로
test('주소: 줄 가운데 서명 · 토큰 조각은 값만 가리고, 자리만 말한 값과 코드는 그대로', () => {
  const hosts = H.storageHosts()
  const cases = [
    [`서명 값 ?token=${F.jwt} 를 붙여요`, '서명 값 ?token=… 를 붙여요'],
    [`뒤에 &sig=${F.hex}&exp=1767225600 을 붙이면 열려요`, '뒤에 &sig=…&exp=1767225600 을 붙이면 열려요'],
    [`\`?X-Amz-Signature=${F.hex}&X-Amz-Credential=${fake('AKQ7', 20)}\` 은 만료돼요`, '`?X-Amz-Signature=…&X-Amz-Credential=…` 은 만료돼요'],
    ['주소가 길어 나눠 적어요: https://files.example/a/견적서.pdf ?token=abc 끝', '주소가 길어 나눠 적어요: 견적서.pdf 끝'],
    ['files.example/a/견적서.pdf?sig=abc&exp=1 를 열어요', 'files.example/a/견적서.pdf?sig=…&exp=1 를 열어요'],
    [`로그인 뒤 #access_token=${F.shaped}&expires_in=3600 이 붙어요`, '로그인 뒤 #access_token=…&expires_in=3600 이 붙어요'],
    ['값:&api_key=1 끝 · 첫 줄\n?token=abc 로 시작하는 줄', '값:&api_key=… 끝 · 첫 줄\n?token=… 로 시작하는 줄'],
    [`?key=intro 와 &key=${F.gkey}`, '?key=intro 와 &key=…'],
    ['`GET /api/raw?path=a.md&token=abc123`', '`GET /api/raw?path=a.md&token=…`'],
    ['x;sig=1 · ?sig=abc(REST) 끝', 'x;sig=… · ?sig=… 끝'],
    // a pair on its own, no ? or & before it (a line, a word apart)
    [`설정 token=${F.shaped} · 둘째 줄\nX-Amz-Signature=beef`, '설정 token=… · 둘째 줄\nX-Amz-Signature=…'],
  ]
  for (const [input, want] of cases) assert.equal(H.dropPrivateUrls(input, hosts), want, input)
  // ordinary pieces, placeholders and code: as they are
  for (const same of ['?page=2 와 &sort=asc · R&D=연구 · Q&A · AT&T=통신 · a&b=c 는 그대로', '주소 끝의 ?token=<값> 은 자리만 말한 것', 'https://www.example.com/guide ?page=2 는 그대로',
    '[지도](https://maps.example/embed?key=seoul-office&zoom=3) 와 # 제목', '`GET /api/raw?path=a.md&token=YOUR_TOKEN`', '`?api_key=YOUR_API_KEY`', 'fetch(`/api/files?token=${t}`)',
    'const s = a;token=getToken()', "url + '?token=' + tok", 'Azure SAS 의 &sig=... 매개변수', '쿼리 ?sig=… 와 ?token=xxx 와 ?secret={secret} 와 ?password=$PASSWORD', '이거?token=값 이에요',
    'v1.2.3?build=4 · 정말요?네=좋아요 · Price?min=10&max=20 · token_type=bearer · session=2']) assert.equal(H.dropPrivateUrls(same, hosts), same, same)
  // with the paths, as a shared answer says it
  assert.equal(H.cleanShared('초안 /workspace/.bpmn/c/a.md · 서명 &sig=abc', hosts), '초안 a.md · 서명 &sig=…')
})

// (PR #118 후속 2 · PR #122 검토 1 · 5) 이름으로: urlTokens.js 가 숨기는 이름(서명 · 토큰 · API 키 · OAuth 의 code)과 auth · secret · password · passwd · pwd, 그 밖의 흔한 표기
// (accessToken · auth_token · private_token · x-api-key · api-key · subscription-key · q-signature, Markdown 의 access\_token) — 값과 상관없이. 모양으로: key 와
// 비밀스러운 이름(…key · …token · …session · code …)은 값이 비밀처럼 생겼을 때만(날 값으로도 봄 — 「+」 가 든 base64), 이름과 상관없이 JWT · AIza… · gh*_…
test('주소: 알려진 이름은 값과 상관없이, key 와 비밀스러운 이름은 비밀 모양일 때만, 평범한 쿼리는 그대로', () => {
  const hosts = H.storageHosts()
  const keep = [
    'https://maps.example/api/js?key=abc',
    'https://maps.example/embed?key=seoul-office&zoom=3',
    'https://search.example/?key=교육과정&page=2',
    '[안내](https://docs.example.org/view?key=intro-2024-11)',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLGomJKgQCAv0abcdEFGH1234567890ab',
    'https://x.example/cb?code=12345',
    'https://x.example/s?session=2&token_type=bearer',
    'https://docs@x.example/guide/intro',
    'https://x.example/a?token=YOUR_TOKEN',
    // (PR #122 검토 2) an address in a value that the parser writes another way is not a key for that: a search's redirect, an encoded
    // redirect, a path with its own query, a host in capitals, a short dotted id
    'https://www.google.com/url?q=https://example.com?ref=1',
    'https://www.google.com/url?q=https%3A%2F%2FExample.com%2Fpage%3Fid%3D1',
    'https://x.example/a?redirect=https%3A%2F%2Fexample.com%3Fx%3D1',
    'https://x.example/login?next=/검색?q=1',
    'https://Example.COM/A?B=1',
    'https://x.example/a#%7B%7D',
    `https://x.example/a?id=${'ey' + 'J'}hbGciOi.${'ey' + 'J'}zdWIi.x`,
  ]
  for (const s of keep) {
    assert.equal(H.dropPrivateUrls(s, hosts), s, s)
    assert.equal(H.cleanShared(s, hosts), s, s)
  }
  const enc = encodeURIComponent
  const hide = [
    // by name, whatever the value (short, a user:pass, Basic …, no digits, @ and !)
    ...['auth=sso', 'secret=on', 'password=hunter2', 'passwd=pw', 'pwd=1', `auth=${enc('user:pass')}`, `auth=${enc('Basic ' + F.b64)}`, 'secret=correct-horse-battery-staple',
      `secret=${enc('p@ss!w0rd')}`, `auth_token=${F.shaped}`, `accessToken=${F.shaped}`, `private_token=${F.shaped}`, `x-api-key=${F.shaped}`, `api-key=${F.shaped}`,
      `subscription-key=${F.shaped}`, `q-signature=${F.hex}`, 'access\\_token=abc', 'Token=abc', '%74oken=abc', 'api_key=1', 'signature=1']
      .map((q) => [`https://x.example/a?${q}`, '비공개 주소']),
    // by its look: key · secret-ish names · any name
    [`https://maps.example/api/js?key=${F.gkey}`, '비공개 주소'],
    [`https://api.example/v1/data.json?key=${F.hex}`, 'data.json'],
    [`https://x.example/a?key=${F.b64}`, '비공개 주소'],
    [`https://x.example/a?key=${enc(F.b64)}`, '비공개 주소'],
    [`https://x.example/a?session=${F.shaped}`, '비공개 주소'],
    [`https://fn.example/api/Trig?code=${F.shaped}==`, '비공개 주소'],
    [`https://x.example/a?anything=${F.jwt}`, '비공개 주소'],
    // the address's own parts: a password, a token as the user name, an OAuth answer, a session in the fragment, an address inside a value
    ['https://user:pw@x.example/a', '비공개 주소'],
    [`https://${F.pat}@git.example/o/r.git`, 'r.git'],
    ['https://id.example/cb?code=abc&state=xyz', '비공개 주소'],
    ['https://app.example/#access_token=abc&expires_in=3600', '비공개 주소'],
    ['https://app.example/#/cb?access_token=abc', '비공개 주소'],
    [`https://x.example/a#${enc('{"access_token":"abc"}')}`, '비공개 주소'],
    ['https://x.example/go?next=https%3A%2F%2Fy.example%2Fcb%3Ftoken%3Dabc', '비공개 주소'],
    ['https://x.example/go?next=https%253A%252F%252Fy.example%252Fcb%253Ftoken%253Dabc', '비공개 주소'],
    ['https://x.example/a?sig=abc(REST) 끝', '비공개 주소 끝'],
  ]
  for (const [input, want] of hide) assert.equal(H.dropPrivateUrls(input, hosts), want, input)
  assert.equal(H.privateUrl('https://maps.example/api/js?key=abc', hosts), false)
  assert.equal(H.privateUrl(`https://maps.example/api/js?KEY=${F.gkey}`, hosts), true)
  assert.equal(H.secretShape('seoul-office-2024-11-28'), false)
  assert.equal(H.secretShape('0f8fad5b-d9cb-469f-a165-70867728950e'), true)
  assert.equal(H.secretShape(F.b64), true, '날 값의 + 와 / 도 비밀의 글자')
})

// (PR #122 검토 4) 긴 답에서도 빠르게 — 닫히지 않은 링크 · 겹친 「<」 · 큰 쿼리 · 조각이 많은 100 KB 글이 저마다 200 ms 안에(서버는 한 요청 동안 다른 일을 못 한다)
test('주소 · 경로: 100 KB 의 나쁜 모양도 200 ms 안에', () => {
  const hosts = H.storageHosts()
  const K = 100_000
  const shapes = {
    '닫히지 않은 링크 · 주소': '['.repeat(K / 2) + '](https://x.example/' + 'x'.repeat(K / 2),
    '닫히지 않은 링크 · 경로': '['.repeat(K / 2) + '](/workspace/' + 'x'.repeat(K / 2),
    '겹친 <https://': '<https://x'.repeat(K / 10),
    '큰 쿼리': 'https://x.example/a?' + 'a=1&'.repeat(K / 4) + 'token=x',
    '조각이 많음': '?a=1 '.repeat(K / 5),
    'key 조각이 많음': ('?key=' + 'a1'.repeat(20) + ' ').repeat(K / 47),
    '줄이 끊긴 주소': 'https://x.example/a' + '\n?a=1'.repeat(K / 5),
    '띄어 쓴 조각': 'https://x.example/a' + ' ?a=1'.repeat(K / 5),
    '이름만 길게': '?' + 'a'.repeat(K),
    '&만 많음': '&a'.repeat(K / 2),
    '//호스트 많음': '//a.b.c.d.e.f '.repeat(K / 14),
    '한글 글': '가나다라마바사 아자차카타파하 '.repeat(K / 16),
  }
  for (const [label, text] of Object.entries(shapes)) {
    // (the faster of two runs: a busy machine's one slow tick is not the rule's)
    const ms = Math.min(...[0, 1].map(() => { const t = performance.now(); H.cleanShared(text, hosts); return performance.now() - t }))
    assert.ok(ms < 200, `${label}: ${ms.toFixed(0)} ms`)
    const t = performance.now(); P.hidePaths(text)
    assert.ok(performance.now() - t < 200, `화면 ${label}`)
  }
})

// (PR #122 재검토) 자리 표시처럼 생긴 비밀 · 이름의 낱말 · 닫는 괄호
test('주소: 자리 표시 모양을 한 비밀은 가리고, 자리 표시는 그대로 — 이름은 낱말로 읽고, 열지 않은 닫는 괄호는 값이 아니다', () => {
  // (값은 여기서 만든다 — 비밀처럼 생긴 글자를 저장소에 두지 않는다)
  const tok = 'Ab3' + crypto.randomBytes(12).toString('hex')
  const hosts = H.storageHosts()
  const at = (q) => [`주소 https://files.example/a/report.pdf?${q} 를 보세요`, `호출은 GET /api/raw?path=a.md&${q} 로`]
  // 이름만으로 가리는 이름 · 비밀 모양의 값: 자리 표시처럼 시작하거나 괄호에 싸여 있어도
  for (const [q, secret] of [['token=$' + 'ecretValue99', 'ecretValue99'], ['secret=your' + 'mom1234', 'mom1234'], ['api_key=your-key-' + tok, tok],
    ['auth=' + encodeURIComponent('{"token":"' + tok + '"}'), tok], ['sig=%3C' + tok + '%3E', tok]]) {
    for (const text of at(q)) assert.ok(!H.cleanShared(text, hosts).includes(secret), `${q} → ${H.cleanShared(text, hosts)}`)
  }
  // 자리만 말한 값은 그대로
  for (const [q, kept] of [['token=YOUR_TOKEN', 'YOUR_TOKEN'], ['api_key=your-api-key', 'your-api-key'], ['t=${t}', '${t}'], ['token={token}', '{token}'],
    ['token=<값>', '<값>'], ['token=$TOKEN', '$TOKEN'], ['token=getToken()', 'getToken()']]) {
    for (const text of at(q)) assert.ok(H.cleanShared(text, hosts).includes(kept), `${q} → ${H.cleanShared(text, hosts)}`)
  }
  assert.ok(H.cleanShared('fetch(`/api/files?token=${t}`)', hosts).includes('${t}'))
  // 이름은 낱말로: design 에는 sig 라는 글자가 있지만 낱말은 아니다
  const id = crypto.randomUUID()
  assert.ok(H.cleanShared(`https://x.example/v?design=${id}`, hosts).includes(id))
  // 열지 않은 닫는 괄호는 값에 들지 않는다
  assert.equal(H.cleanShared('설정은 {auth=abc} 처럼', hosts), '설정은 {auth=…} 처럼')
})
