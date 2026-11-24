// 링크 미리보기(lib/linkPreview.js) — Open Graph · Twitter 카드 · <title> 읽기, SSRF 거절, 캐시, 한 사람 한도.
// 페이지는 이 시험이 띄우는 로컬 가짜 서버(127.0.0.1)에서, 이름 풀이(DNS)는 대역으로. 공용 인터넷에는 나가지 않는다.
// 회사 스위치(데이터베이스)는 linkPreview.integration.test.js.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import {
  previewFor, fetchPage, parseHtml, cardFrom, isBlockedAddress, hostRefusal, refusal, normalize, videoOf, allowList, extraDeny, _reset, cacheSize, USER_AGENT,
} from '../lib/linkPreview.js'

const OG = `<!doctype html><html><head><meta charset="utf-8">
<title>문서 제목(대체)</title>
<meta property="og:title" content="Moonlight Coffee &amp; 원두 이야기">
<meta property="og:description" content="새 원두가 들어왔어요. &quot;에티오피아&quot; 예가체프 &#8212; 한정 수량">
<meta property="og:image" content="/img/cover.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:site_name" content="달빛 커피">
<link rel="icon" href="/favicon.ico">
</head><body><p>본문</p></body></html>`

// what the fake site did: requests per path, the headers of the last one, bytes written by streaming pages
const hits = {}
let lastHeaders = null
const written = {}
let server, other, base, port
const page = (res, html, type = 'text/html; charset=utf-8') => { res.writeHead(200, { 'Content-Type': type }); res.end(html) }
// a long page the client should stop reading: 64KB at a time until it hangs up (or 4MB)
function stream(req, res, key, { head = '', tail = '' } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  written[key] = 0
  res.write(head)
  const chunk = `<meta name="filler" content="${'x'.repeat(65_000)}">`
  let closed = false
  res.on('close', () => { closed = true })
  const pump = () => {
    while (!closed && written[key] < 4_000_000) {
      written[key] += chunk.length
      if (!res.write(chunk)) return res.once('drain', pump)
    }
    if (!closed) res.end(tail)
  }
  pump()
}

before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url.split('?')[0]
    hits[path] = (hits[path] || 0) + 1
    lastHeaders = req.headers
    const r = /^\/r\/(\d+)$/.exec(path)
    if (r) { const n = Number(r[1]); res.writeHead(302, { Location: n > 1 ? `/r/${n - 1}` : '/og' }); return res.end() }
    switch (path) {
      case '/og': return page(res, OG)
      case '/twitter': return page(res, '<html><head><meta name="twitter:title" content="트위터 제목"><meta name="twitter:description" content="트위터 설명"><meta name="twitter:image" content="https://cdn.example.com/t.jpg"></head></html>')
      case '/plain': return page(res, '<html><head><title> 그냥   제목 </title><meta name="description" content="메타 설명"></head></html>')
      case '/euckr': res.writeHead(200, { 'Content-Type': 'text/html; charset=euc-kr' }); return res.end(Buffer.concat([Buffer.from('<html><head><title>'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from('</title></head></html>')]))
      case '/metacharset': return page(res, Buffer.concat([Buffer.from('<html><head><meta charset="euc-kr"><title>'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from('</title></head></html>')]), 'text/html')
      case '/video': return page(res, '<html><head><meta property="og:type" content="video.other"><meta property="og:title" content="시연 영상"><meta property="og:image" content="/thumb.jpg"></head></html>')
      case '/private-image': return page(res, '<html><head><meta property="og:title" content="그림은 사내"><meta property="og:image" content="http://192.168.0.10/x.png"><link rel="icon" href="http://localhost/f.ico"></head></html>')
      case '/script-trap': return page(res, '<html><head><script>var s = "<meta property=\\"og:title\\" content=\\"가짜\\">"</script><meta property="og:title" content="진짜"></head></html>')
      case '/empty': return page(res, '<html><head></head><body>no meta</body></html>')
      case '/og-in-body': return page(res, '<html><head><title>머리 제목</title></head><body><meta property="og:title" content="본문에 둔 제목"><meta property="og:image" content="/b.png"></body></html>')
      case '/to-private': res.writeHead(302, { Location: 'http://10.0.0.1/admin' }); return res.end()
      case '/to-other-port': res.writeHead(301, { Location: `http://127.0.0.1:${other.address().port}/` }); return res.end()
      case '/to-signed': res.writeHead(302, { Location: '/og?X-Amz-Signature=abc' }); return res.end()
      case '/to-ftp': res.writeHead(302, { Location: 'ftp://example.com/' }); return res.end()
      case '/image': res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.alloc(100))
      case '/json': res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"title":"x"}')
      case '/notype': res.writeHead(200); return res.end('<title>x</title>')
      case '/missing': res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<title>없음</title>')
      case '/slow': return // never answers
      case '/big-tail': return stream(req, res, 'big-tail', { head: '<html><head>', tail: '<meta property="og:title" content="너무 뒤"></head></html>' })
      case '/big-head': return stream(req, res, 'big-head', { head: '<html><head><meta property="og:title" content="앞에 있는 제목">' })
      case '/gzip-bomb': {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' })
        return res.end(zlib.gzipSync(Buffer.concat([Buffer.from('<html><head>'), Buffer.alloc(30_000_000, 0x20), Buffer.from('<title>폭탄</title></head>')])))
      }
      case '/gzip': res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync(OG))
      default: res.writeHead(404); return res.end()
    }
  })
  other = http.createServer((req, res) => { hits.other = (hits.other || 0) + 1; page(res, OG) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  await new Promise((r) => other.listen(0, '127.0.0.1', r))
  port = server.address().port
  base = `http://127.0.0.1:${port}`
})
after(() => { server.closeAllConnections?.(); server.close(); other.close() })
beforeEach(() => { _reset(); for (const k of Object.keys(hits)) delete hits[k] })

// the fake site is local: only this host:port is let through (PRO_LINK_PREVIEW_ALLOW_HOSTS in the e2e servers)
const allow = () => new Set([`127.0.0.1:${port}`])
const noDns = () => { throw new Error('이 시험에서 실제 이름 풀이는 쓰지 않는다') }
const deps = (extra = {}) => ({ allowHosts: allow(), lookup: noDns, enabled: async () => true, perMinute: 1000, ...extra })
const ask = (url, extra, who = {}) => previewFor({ userId: who.user || 'u1', tenant: who.tenant || 't1', url }, deps(extra))

test('Open Graph: 제목 · 설명 · 그림(상대 주소) · 크기 · 사이트 이름 · 아이콘 · 도메인, 엔티티를 푼다', async () => {
  const { preview } = await ask(`${base}/og#section`)
  assert.equal(preview.title, 'Moonlight Coffee & 원두 이야기')
  assert.equal(preview.description, '새 원두가 들어왔어요. "에티오피아" 예가체프 — 한정 수량')
  assert.equal(preview.image, `${base}/img/cover.png`)
  assert.equal(preview.imageWidth, 1200)
  assert.equal(preview.imageHeight, 630)
  assert.equal(preview.siteName, '달빛 커피')
  assert.equal(preview.favicon, `${base}/favicon.ico`)
  assert.equal(preview.kind, 'link')
  assert.equal(preview.domain, '127.0.0.1')
  assert.equal(preview.url, `${base}/og`, '조각(#…)은 떼고 묻는다')
  // a generic agent, nothing of the person, no cookie or Authorization
  assert.equal(lastHeaders['user-agent'], USER_AGENT)
  assert.equal(lastHeaders.cookie, undefined)
  assert.equal(lastHeaders.authorization, undefined)
})

test('Twitter 카드만 있는 페이지, <title> · meta description 만 있는 페이지, gzip', async () => {
  const t = (await ask(`${base}/twitter`)).preview
  assert.deepEqual([t.title, t.description, t.image], ['트위터 제목', '트위터 설명', 'https://cdn.example.com/t.jpg'])
  const p = (await ask(`${base}/plain`)).preview
  assert.deepEqual([p.title, p.description, p.image, p.siteName], ['그냥 제목', '메타 설명', null, null])
  assert.equal((await ask(`${base}/gzip`)).preview.title, 'Moonlight Coffee & 원두 이야기')
})

test('EUC-KR 페이지(Content-Type 의 charset · <meta charset>)', async () => {
  assert.equal((await ask(`${base}/euckr`)).preview.title, '한글')
  assert.equal((await ask(`${base}/metacharset`)).preview.title, '한글')
})

test('스크립트 안의 글은 메타가 아니다 · 아무것도 없는 페이지는 카드 없음 · 본문에 둔 메타도 읽는다', async () => {
  assert.equal(parseHtml('<head><!-- <meta property="og:title" content="주석"> --><title>t</title></head>').metas['og:title'], undefined)
  assert.equal((await ask(`${base}/script-trap`)).preview.title, '진짜')
  assert.deepEqual(await ask(`${base}/empty`), { preview: null, reason: 'empty' })
  // card tags put in the body (not valid, but seen): the reading goes on past </head>
  const b = (await ask(`${base}/og-in-body`)).preview
  assert.deepEqual([b.title, b.image], ['본문에 둔 제목', `${base}/b.png`])
})

test('동영상: og:type video.* 는 kind video, YouTube 주소는 페이지를 못 읽어도 썸네일 카드', async () => {
  const v = (await ask(`${base}/video`)).preview
  assert.equal(v.kind, 'video')
  assert.equal(v.image, `${base}/thumb.jpg`)
  // (no network: the name does not resolve here — the card still has YouTube's thumbnail at its known address)
  const lookup = async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }) }
  const y = await previewFor({ userId: 'u1', tenant: 't1', url: 'https://youtu.be/dQw4w9WgXcQ?t=42' }, { ...deps(), lookup })
  assert.equal(y.preview.kind, 'video')
  assert.equal(y.preview.image, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
  assert.equal(y.preview.siteName, 'YouTube')
  assert.equal(y.reason, 'dns')
  assert.equal(videoOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x').id, 'dQw4w9WgXcQ')
  assert.equal(videoOf('https://youtube.com/shorts/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ')
  assert.equal(videoOf('https://vimeo.com/76979871').provider, 'vimeo.com')
  assert.equal(videoOf('https://example.com/watch?v=dQw4w9WgXcQ'), null)
})

test('카드의 그림 · 아이콘이 사내 주소를 가리키면 버린다(보는 사람의 브라우저가 사내로 요청하지 않게)', async () => {
  const p = (await ask(`${base}/private-image`)).preview
  assert.equal(p.title, '그림은 사내')
  assert.equal(p.image, null)
  assert.equal(p.favicon, null)
})

// ---------- SSRF ----------
test('사설 · 루프백 · 링크 로컬 · CGNAT · 클러스터 주소는 연결하지 않는다', async () => {
  for (const ip of ['127.0.0.1', '127.8.9.1', '10.0.0.5', '172.16.3.4', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0',
    '::1', '::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '2002:c0a8:1::', 'ff02::1']) {
    assert.equal(isBlockedAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isBlockedAddress(ip), false, ip)
  for (const h of ['localhost', 'app.localhost', 'deepagents', 'process-gpt-lite-server.default.svc', 'kong.default.svc.cluster.local', 'printer.local', 'metadata.google.internal']) {
    assert.equal(hostRefusal(h), 'private', h)
  }
  assert.equal(hostRefusal('example.com'), null)
  // without the test allowance the fake site is just 127.0.0.1: refused before any connection
  const before = hits['/og'] || 0
  for (const u of [`${base}/og`, `http://[::1]:${port}/og`, 'http://169.254.169.254/latest/meta-data/', 'http://2130706433/', 'http://0x7f.1/', 'http://localhost:8787/api/me', 'http://deepagents:8888/']) {
    const r = await previewFor({ userId: 'u1', tenant: 't1', url: u }, { ...deps(), allowHosts: new Set() })
    assert.deepEqual(r, { preview: null, reason: 'private' }, u)
  }
  assert.equal(hits['/og'] || 0, before, '가짜 사이트에 요청이 가지 않았다')
})

test('이름이 사설 IP 로 풀리면 거절 — 공개 IP 와 섞여 있어도, 그리고 연결은 확인한 그 IP 로(DNS 리바인딩)', async () => {
  let calls = 0
  const lookup = async (h) => { calls++; return h === 'intranet.example.com' ? [{ address: '10.0.0.7', family: 4 }] : [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] }
  assert.deepEqual(await ask('http://intranet.example.com/', { lookup }), { preview: null, reason: 'private' })
  assert.deepEqual(await ask('http://mixed.example.com/', { lookup }), { preview: null, reason: 'private' })
  assert.equal(calls, 2)
  // a name let through (test allowance) connects to the address the lookup gave, once per hop — the page sees the name as Host
  calls = 0
  const pinned = async () => { calls++; return [{ address: '127.0.0.1', family: 4 }] }
  const r = await ask(`http://pages.test:${port}/og`, { lookup: pinned, allowHosts: new Set([`pages.test:${port}`]) })
  assert.equal(r.preview.title, 'Moonlight Coffee & 원두 이야기')
  assert.equal(lastHeaders.host, `pages.test:${port}`)
  assert.equal(calls, 1)
})

test('넘겨주기: 사설 주소로 가면 거절, 매번 다시 검사(다른 포트 · 서명 주소 · ftp), 3번까지', async () => {
  assert.deepEqual(await ask(`${base}/to-private`), { preview: null, reason: 'private' })
  assert.deepEqual(await ask(`${base}/to-other-port`), { preview: null, reason: 'private' })
  assert.equal(hits.other || 0, 0, '허락한 host:port 가 아닌 곳으로는 연결하지 않았다')
  assert.deepEqual(await ask(`${base}/to-signed`), { preview: null, reason: 'signed' })
  assert.deepEqual(await ask(`${base}/to-ftp`), { preview: null, reason: 'scheme' })
  assert.equal((await ask(`${base}/r/3`)).preview.title, 'Moonlight Coffee & 원두 이야기', '세 번은 따라간다')
  assert.deepEqual(await ask(`${base}/r/4`), { preview: null, reason: 'redirects' })
  assert.equal(hits['/og'], 1, '네 번째 넘겨주기는 따라가지 않았다')
})

test('본문은 512KB 까지만 읽는다 — 그 뒤의 메타는 없는 것, 긴 페이지는 끊는다 · gzip 폭탄도', async () => {
  assert.deepEqual(await ask(`${base}/big-tail`), { preview: null, reason: 'empty' })
  // the client hung up long before the 4MB the site would have sent (what sits in socket buffers aside)
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(written['big-tail'] < 2_000_000, `보낸 바이트 ${written['big-tail']}`)
  const t0 = Date.now()
  assert.deepEqual(await ask(`${base}/gzip-bomb`), { preview: null, reason: 'empty' })
  assert.ok(Date.now() - t0 < 3000)
  // a page that keeps going after its title: read up to the cap and the card is still there
  assert.equal((await ask(`${base}/big-head`)).preview.title, '앞에 있는 제목')
  const page = await fetchPage(`${base}/big-tail`, { allowHosts: allow(), lookup: noDns, maxBytes: 100_000 })
  assert.equal(page.truncated, true)
  assert.ok(page.html.length <= 100_000)
})

test('HTML 이 아니면 읽지 않는다 · 404 · 5초(여기서는 0.3초) 넘으면 그만', async () => {
  assert.deepEqual(await ask(`${base}/image`), { preview: null, reason: 'type' })
  assert.deepEqual(await ask(`${base}/json`), { preview: null, reason: 'type' })
  assert.deepEqual(await ask(`${base}/notype`), { preview: null, reason: 'type' })
  assert.deepEqual(await ask(`${base}/missing`), { preview: null, reason: 'status' })
  const t0 = Date.now()
  assert.deepEqual(await ask(`${base}/slow`, { timeoutMs: 300 }), { preview: null, reason: 'timeout' })
  assert.ok(Date.now() - t0 < 2000)
})

test('서명 · 토큰이 붙은 링크는 열지 않는다 — 요청 자체가 없다', async () => {
  const urls = [
    `${base}/og?token=abc`, `${base}/og?access_token=abc`, `${base}/og?sig=abc`, `${base}/og?Signature=abc`, `${base}/og?key=abc`,
    `${base}/og?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=x`, `${base}/og?X-Goog-Signature=1`, `${base}/og?resetToken=1`,
    `${base}/storage/v1/object/sign/files/a.pdf?x=1`, `${base}/api/git/f1.git/info/refs`, `${base}/og#access_token=abc&type=magiclink`,
  ]
  for (const u of urls) assert.deepEqual(await ask(u), { preview: null, reason: 'signed' }, u)
  assert.equal(Object.keys(hits).length, 0)
  // what is not a secret: a stock code, a news section
  assert.equal(refusal(new URL('https://finance.naver.com/item/main.naver?code=005930')), null)
  assert.equal(refusal(new URL('https://n.news.naver.com/mnews/article/001/0000001?sid=105')), null)
})

test('http(s) 만 · 주소 안의 비밀번호 · 이 앱 자신의 주소 · 브라우저도 막는 포트', async () => {
  assert.deepEqual(await ask('ftp://example.com/x'), { preview: null, reason: 'scheme' })
  assert.deepEqual(await ask('javascript:alert(1)'), { preview: null, reason: 'scheme' })
  assert.deepEqual(await ask(`http://me:secret@127.0.0.1:${port}/og`), { preview: null, reason: 'credentials' })
  assert.deepEqual(await ask('not a url'), { preview: null, reason: 'url' })
  assert.equal(refusal(new URL('https://acme.process-gpt.io/lite/chat'), { own: ['acme.process-gpt.io'] }), 'own')
  // ports a browser refuses too (smtp, ssh): no HTTP request to another protocol's service
  assert.deepEqual(await ask('http://mail.example.com:25/'), { preview: null, reason: 'port' })
  assert.deepEqual(await ask('http://example.com:22/'), { preview: null, reason: 'port' })
  assert.equal(refusal(new URL('https://example.com:8443/page')), null)
})

test('운영자가 더 막는 범위(PRO_LINK_PREVIEW_DENY_CIDRS) — 사설이 아닌 클러스터 Service 범위', () => {
  const d = extraDeny('34.118.224.0/20, 2600:1900::/28, 203.0.114.7, 잘못된값')
  assert.equal(d.check('34.118.230.5', 'ipv4'), true)
  assert.equal(d.check('34.118.240.1', 'ipv4'), false)
  assert.equal(d.check('2600:1900::1', 'ipv6'), true)
  assert.equal(d.check('203.0.114.7', 'ipv4'), true)
  extraDeny('')
})

test('시험용 허락(PRO_LINK_PREVIEW_ALLOW_HOSTS)은 게이트웨이 뒤(운영)에서는 무시', () => {
  assert.deepEqual([...allowList('127.0.0.1:59981, pages.test', false)], ['127.0.0.1:59981', 'pages.test'])
  assert.equal(allowList('127.0.0.1:59981', true).size, 0)
  assert.equal(allowList('', false).size, 0)
})

// ---------- cache, limit ----------
test('캐시: 같은 주소(조각 · utm 만 다른 것도)는 한 번만 읽고, 하루 뒤 다시 · 못 읽은 것은 30분 · 회사마다 따로', async () => {
  let t = 1_000_000
  const now = () => t
  await ask(`${base}/og`, { now })
  await ask(`${base}/og#x`, { now })
  await ask(`${base}/og?utm_source=chat`, { now })
  assert.equal(hits['/og'], 1)
  assert.equal(normalize(`${base}/og?utm_source=chat&a=1#x`), `${base}/og?a=1`)
  t += 23 * 3600_000
  await ask(`${base}/og`, { now })
  assert.equal(hits['/og'], 1, '하루가 안 됨')
  t += 2 * 3600_000
  await ask(`${base}/og`, { now })
  assert.equal(hits['/og'], 2, '하루가 지나 다시 읽음')
  await ask(`${base}/og`, { now }, { tenant: 't2' })
  assert.equal(hits['/og'], 3, '다른 회사는 따로')
  // a page that said nothing: remembered for 30 minutes
  await ask(`${base}/empty`, { now })
  await ask(`${base}/empty`, { now })
  assert.equal(hits['/empty'], 1)
  t += 31 * 60_000
  await ask(`${base}/empty`, { now })
  assert.equal(hits['/empty'], 2)
  // the same link asked twice at once: one request
  await Promise.all([ask(`${base}/plain`, { now }), ask(`${base}/plain`, { now })])
  assert.equal(hits['/plain'], 1)
  assert.ok(cacheSize() > 0)
  // refused links are not remembered (no network either way)
  const n = cacheSize()
  await ask(`${base}/og?token=1`, { now })
  assert.equal(cacheSize(), n)
})

test('한 사람 한도: 1분에 새로 읽게 하는 페이지 수 — 이미 읽은 페이지는 셈하지 않고, 다른 사람은 따로, 1분 뒤 다시', async () => {
  let t = 5_000_000
  const now = () => t
  const lim = { now, perMinute: 2 }
  await ask(`${base}/og`, lim)
  await ask(`${base}/plain`, lim)
  await assert.rejects(ask(`${base}/twitter`, lim), (e) => e.status === 429)
  assert.equal(hits['/twitter'] || 0, 0)
  assert.equal((await ask(`${base}/og`, lim)).preview.title, 'Moonlight Coffee & 원두 이야기', '읽어 둔 것은 됨')
  assert.equal((await ask(`${base}/twitter`, lim, { user: 'u2' })).preview.title, '트위터 제목', '다른 사람')
  t += 61_000
  assert.equal((await ask(`${base}/video`, lim)).preview.title, '시연 영상')
})

test('회사가 끄면 아무것도 읽지 않는다', async () => {
  assert.deepEqual(await ask(`${base}/og`, { enabled: async () => false }), { preview: null, reason: 'off' })
  assert.equal(hits['/og'] || 0, 0)
})

test('cardFrom: 아무 말도 없는 페이지는 null, 그림만 있어도 카드', () => {
  assert.equal(cardFrom(parseHtml('<head></head>'), { url: 'https://a.example/' }), null)
  const c = cardFrom(parseHtml('<meta property="og:image" content="https://a.example/i.png">'), { url: 'https://www.a.example/' })
  assert.equal(c.image, 'https://a.example/i.png')
  assert.equal(c.domain, 'a.example')
})

test('GKE 기본 Service 범위(34.118.224.0/20)는 설정 없이도 막는다', async () => {
  const { extraDeny } = await import('../lib/linkPreview.js')
  const d = extraDeny('')
  assert.equal(d.check('34.118.230.7', 'ipv4'), true)
  assert.equal(d.check('34.117.1.1', 'ipv4'), false)
})
