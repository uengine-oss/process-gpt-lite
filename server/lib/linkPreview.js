// 링크 미리보기(Open Graph unfurl): 채팅과 팀 메시지의 링크마다 그 페이지의 제목 · 설명 · 그림을 카드로 보여 준다.
// 브라우저는 CORS 때문에 남의 페이지를 읽지 못하므로 서버가 읽는다. 서버가 남의 주소를 대신 여는 일이라 SSRF 와 개인 정보를 먼저 막는다.
//   - http(s) 만. 주소에 아이디 · 비밀번호(user:pass@)가 있으면 열지 않는다. 브라우저도 막는 포트(25 · 22 · 53 …)는 열지 않는다.
//   - 이름을 먼저 풀어(DNS) 사설 · 루프백 · 링크 로컬 · CGNAT · 클러스터 주소면 거절하고, 확인한 그 IP 로 연결한다(DNS 리바인딩).
//     점 없는 이름(k8s 짧은 이름) · localhost · *.local · *.svc · *.cluster.local · *.internal 도 거절. 넘겨주기(3xx)마다 다시, 3번까지.
//     이름은 검색 도메인 없이(끝에 점) 푼다. 사설이 아닌 클러스터 범위는 PRO_LINK_PREVIEW_DENY_CIDRS 로 더 막는다.
//   - 전체 5초, 본문은 512KB 까지만 읽는다(그 뒤는 받지 않고 끊는다). HTML 만 읽는다.
//   - 서명 · 토큰이 붙은 링크(token · sig · signature · key · access_token · X-Amz-* …, Supabase 서명 주소, 우리 /api/git/)는 열지 않는다.
//   - 일반 User-Agent 하나(사람 · 회사 정보 없음), 쿠키 · 로그인 정보는 보내지 않는다.
//   - 그림은 주소만 돌려주고 서버가 가져오지 않는다(화면이 referrer 없이 직접 읽는다). 사설 주소를 가리키는 그림 주소는 버린다.
//   - 회사마다 끌 수 있다(pro_link_preview_settings, 기본 켬). 한 사람이 1분에 서버에 새로 읽게 하는 페이지 수에 한도(이미 읽은 것은 셈하지 않음).
// 결과는 메모리에만(회사 + 정규화한 주소마다, LRU): 읽은 것은 하루, 못 읽은 것은 30분. Lite 서버는 파드 하나라 이걸로 충분하고,
// 대화에 오간 주소의 목록을 데이터베이스에 남기지 않는다.
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import zlib from 'node:zlib'
import { domainToUnicode } from 'node:url'
import { config } from '../config.js'
import { L } from './lang.js'

export const LIMITS = {
  timeoutMs: 5000, maxBytes: 512 * 1024, maxRedirects: 3,
  ttlMs: 24 * 3600_000, negTtlMs: 30 * 60_000, cacheMax: 2000,
  maxActive: 6, settingsTtlMs: 30_000,
}
// one generic agent for every request: no person, company or address of ours in it
export const USER_AGENT = 'Mozilla/5.0 (compatible; ProcessGPT-LinkPreview/1.0; +https://process-gpt.io)'

// why a link gets no card (sent back as `reason`; the screen shows nothing either way)
export class Refused extends Error {
  constructor(reason) { super(reason); this.reason = reason }
}

// ---------- addresses ----------
const V4 = new net.BlockList()
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) V4.addSubnet(a, p, 'ipv4')
const V6 = new net.BlockList()
for (const [a, p] of [['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:db8::', 32], ['2002::', 16]]) V6.addSubnet(a, p, 'ipv6')

// an IPv6 address as 16 bytes (null when it is not one)
function v6bytes(addr) {
  let s = String(addr).toLowerCase()
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (dotted) {
    const p = dotted.slice(1).map(Number)
    if (p.some((x) => x > 255)) return null
    s = s.slice(0, -dotted[0].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null
  const groups = tail ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255] })
}

// the operator's own ranges (PRO_LINK_PREVIEW_DENY_CIDRS: a cluster's Service · Pod range when it is not a private one),
// always with GKE's default Service range: Autopilot gives Services 34.118.224.0/20, which is not a private range, and no
// public site lives there (a link that names such an address straight would otherwise reach a Service of the cluster)
export const DEFAULT_DENY_CIDRS = ['34.118.224.0/20']
let denyFor = null
let deny = null
export function extraDeny(raw = config.linkPreviewDenyCidrs) {
  if (denyFor === raw) return deny
  denyFor = raw
  deny = new net.BlockList()
  for (const c of [...DEFAULT_DENY_CIDRS, ...String(raw || '').split(',')].map((x) => x.trim()).filter(Boolean)) {
    const [a, p] = c.split('/')
    const fam = net.isIP(a)
    if (!fam) { console.warn('[link-preview] PRO_LINK_PREVIEW_DENY_CIDRS: not a range:', c); continue }
    try { deny.addSubnet(a, p == null ? (fam === 4 ? 32 : 128) : Number(p), fam === 4 ? 'ipv4' : 'ipv6') } catch { console.warn('[link-preview] PRO_LINK_PREVIEW_DENY_CIDRS: not a range:', c) }
  }
  return deny
}

// Whether the server must not connect to this address: private, loopback, link-local, CGNAT, multicast, reserved,
// documentation — and IPv6 that is not global unicast, or that carries one of those IPv4 addresses inside it.
export function isBlockedAddress(ip) {
  const a = String(ip || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const fam = net.isIP(a)
  if (fam && extraDeny().check(a, fam === 4 ? 'ipv4' : 'ipv6')) return true
  if (fam === 4) return V4.check(a, 'ipv4')
  if (fam !== 6) return true
  const b = v6bytes(a)
  if (!b) return true
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0)
  const v4at = (i) => b.slice(i, i + 4).join('.')
  if (zero(0, 10) && b[10] === 255 && b[11] === 255) return V4.check(v4at(12), 'ipv4') // ::ffff:a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return zero(4, 12) ? V4.check(v4at(12), 'ipv4') : true // NAT64
  if ((b[0] & 0xe0) !== 0x20) return true // not 2000::/3: ::, ::1, fc00::/7, fe80::/10, ff00::/8, IPv4-compatible …
  return V6.check(a, 'ipv6')
}

// a host name that only means something inside a network (refused before any lookup)
const LOCAL_SUFFIX = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|corp|home\.arpa|svc|cluster\.local)$/
export function hostRefusal(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h) return 'url'
  if (net.isIP(h)) return isBlockedAddress(h) ? 'private' : null
  if (!h.includes('.') || LOCAL_SUFFIX.test(h)) return 'private'
  return null
}

// ---------- which links are opened at all ----------
// a query key that carries a secret or a signature (a pagination "pageToken" too — such links are API calls anyway)
const SIGNED_KEY = /token|^(sig|signature|key|apikey|api[-_]key|secret|password|passwd|auth|jwt|otp|key-pair-id|x-amz-.+|x-goog-.+)$/i
const SIGNED_PATH = /\/storage\/v1\/(object|render\/image)\/sign\/|\/api\/git\//i
const SIGNED_HASH = /(^#|&|#)(access_token|refresh_token|id_token|token)=/i
export function signedLink(u) {
  for (const k of u.searchParams.keys()) if (SIGNED_KEY.test(k)) return true
  return SIGNED_PATH.test(u.pathname) || SIGNED_HASH.test(u.hash || '')
}

// test-only hosts the server may read although they are local (PRO_LINK_PREVIEW_ALLOW_HOSTS); never behind the gateway
export function allowList(raw = config.linkPreviewAllowHosts, gateway = config.tenantFromHeader) {
  if (gateway) return new Set()
  return new Set(String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
}
const allowedHost = (u, allow) => !!allow?.size && (allow.has(u.host.toLowerCase()) || allow.has(u.hostname.toLowerCase()))

// the ports a browser will not fetch either (the Fetch standard's "bad ports": mail, ssh, dns, ldap, …) — the server is not
// made to speak HTTP to another protocol's service on a public host
const BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113,
  115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
  989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080])

// Why this link is not opened (null: it may be): the rules that need no network.
export function refusal(u, { own = [], allow = new Set() } = {}) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'scheme'
  if (u.username || u.password) return 'credentials'
  if (signedLink(u)) return 'signed'
  if (u.port && BAD_PORTS.has(Number(u.port))) return 'port'
  if (allowedHost(u, allow)) return null
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (own.includes(h)) return 'own'
  return hostRefusal(h)
}

const TRACKING = /^(utm_.+|fbclid|gclid|igshid|mc_eid)$/i
// the address the cache and the fetch use: no fragment, no tracking parameters (the rest of the query untouched)
export function normalize(raw) {
  let u
  try { u = new URL(String(raw || '').trim()) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  u.hash = ''
  if ([...u.searchParams.keys()].some((k) => TRACKING.test(k))) {
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k)
  }
  return u.href
}

// ---------- video links ----------
const VIDEO_HOSTS = ['vimeo.com', 'tv.naver.com', 'chzzk.naver.com', 'tv.kakao.com', 'tiktok.com', 'dailymotion.com', 'twitch.tv']
export function videoOf(url) {
  let u
  try { u = new URL(url) } catch { return null }
  const h = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
  let id = null
  if (h === 'youtu.be') id = u.pathname.split('/')[1]
  else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
    id = u.pathname === '/watch' ? u.searchParams.get('v') : /^\/(shorts|embed|live|v)\/([^/]+)/.exec(u.pathname)?.[2]
  }
  if (id && /^[\w-]{11}$/.test(id)) return { provider: 'youtube', id, site: 'YouTube', thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }
  if (VIDEO_HOSTS.some((v) => h === v || h.endsWith(`.${v}`))) return { provider: h, id: null, site: null, thumb: null }
  return null
}

// ---------- reading the page ----------
const withDeadline = (p, deadline) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Refused('timeout')), Math.max(1, deadline - Date.now()))
  p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
})
// the name as it is, never with the resolver's search domains: "deepagents.default" must not become the cluster's
// deepagents.default.svc.cluster.local (an absolute name — a trailing dot — is not searched)
const systemLookup = (host) => dns.promises.lookup(host.endsWith('.') ? host : `${host}.`, { all: true })

// the one address this hop connects to — checked before, and the only one the socket may use
async function pinned(u, o) {
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const allowed = allowedHost(u, o.allowHosts)
  const fam = net.isIP(host)
  if (fam) {
    if (!allowed && isBlockedAddress(host)) throw new Refused('private')
    return { address: host, family: fam }
  }
  if (!allowed && hostRefusal(host)) throw new Refused('private')
  let addrs
  try { addrs = await withDeadline(Promise.resolve(o.lookup(host)), o.deadline) } catch (e) { throw e instanceof Refused ? e : new Refused('dns') }
  addrs = (addrs || []).filter((a) => a && net.isIP(a.address))
  if (!addrs.length) throw new Refused('dns')
  // every address the name has must be public: one private answer among public ones is how rebinding starts
  if (!allowed && addrs.some((a) => isBlockedAddress(a.address))) throw new Refused('private')
  const a = addrs.find((x) => net.isIP(x.address) === 4) || addrs[0]
  return { address: a.address, family: net.isIP(a.address) }
}

const HEAD_END = /<\/head\s*>/i
const OG_SEEN = /og:(title|image)|twitter:title/i
// One request to one checked address. Resolves {redirect} for a 3xx, {body, type} for an HTML page (at most maxBytes of it).
function requestOnce(u, pin, o) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http
    const host = u.hostname.replace(/^\[|\]$/g, '')
    let settled = false
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v) }
    const req = lib.request({
      protocol: u.protocol, hostname: host, port: u.port || undefined, path: `${u.pathname}${u.search}`, method: 'GET',
      // no shared agent: a kept-alive socket to another address is never reused; no cookies, no Authorization
      agent: false,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [pin]) : cb(null, pin.address, pin.family)),
      ...(net.isIP(host) ? {} : { servername: host }),
    })
    const timer = setTimeout(() => { req.destroy(); done(reject, new Refused('timeout')) }, Math.max(1, o.deadline - Date.now()))
    req.on('error', (e) => done(reject, e instanceof Refused ? e : new Refused('error')))
    req.on('response', (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); req.destroy(); return done(resolve, { redirect: String(res.headers.location) }) }
      if (status < 200 || status >= 300) { req.destroy(); return done(reject, new Refused('status')) }
      const type = String(res.headers['content-type'] || '').toLowerCase()
      if (!/^\s*(text\/html|application\/xhtml\+xml)\b/.test(type)) { req.destroy(); return done(reject, new Refused('type')) }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase().trim()
      const unzip = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[enc]
      if (enc && enc !== 'identity' && !unzip) { req.destroy(); return done(reject, new Refused('type')) }
      const stream = unzip ? res.pipe(unzip()) : res
      const chunks = []
      let n = 0
      let tail = ''
      let seen = false
      // the cap is on what is read after decompressing (a small gzip cannot grow past it either); the page's head is enough
      const finish = (truncated) => { req.destroy(); done(resolve, { body: Buffer.concat(chunks, n), type, truncated }) }
      stream.on('data', (c) => {
        if (settled) return
        const take = Math.min(c.length, o.maxBytes - n)
        chunks.push(take < c.length ? c.subarray(0, take) : c)
        n += take
        if (n >= o.maxBytes) return finish(true)
        // (stop at </head> once the page's card tags were there — a page that puts them in its body is read on, up to the cap)
        const s = tail + c.toString('latin1')
        seen = seen || OG_SEEN.test(s)
        if (seen && HEAD_END.test(s)) return finish(false)
        tail = s.slice(-24)
      })
      stream.on('end', () => finish(false))
      stream.on('error', () => { req.destroy(); done(reject, new Refused('error')) })
    })
    req.end()
  })
}

function decode(buf, type) {
  let cs = /charset\s*=\s*["']?([\w.:-]+)/i.exec(type)?.[1]
  if (!cs) cs = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1]
  try { return new TextDecoder(cs || 'utf-8').decode(buf) } catch { return new TextDecoder('utf-8').decode(buf) }
}

// The page behind a link: every hop checked again (scheme, signed, own, private), at most maxRedirects of them.
export async function fetchPage(url, opts = {}) {
  const o = { ...LIMITS, lookup: systemLookup, allowHosts: new Set(), own: [], ...opts }
  o.deadline = Date.now() + o.timeoutMs
  let u = new URL(url)
  for (let hop = 0; ; hop++) {
    const why = refusal(u, { own: o.own, allow: o.allowHosts })
    if (why) throw new Refused(why)
    const pin = await pinned(u, o)
    const r = await requestOnce(u, pin, o)
    if (!r.redirect) return { url: u.href, html: decode(r.body, r.type), truncated: r.truncated }
    if (hop >= o.maxRedirects) throw new Refused('redirects')
    try { u = new URL(r.redirect, u) } catch { throw new Refused('url') }
  }
}

// ---------- the page's own words ----------
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™' }
const entities = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ''
  }
  return NAMED[e.toLowerCase()] ?? m
})
const clean = (s, max) => {
  const t = entities(String(s || '')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null
}
const attrsOf = (s) => {
  const out = {}
  for (const m of String(s).matchAll(/([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const k = m[1].toLowerCase()
    if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return out
}

// What a page says about itself: Open Graph, Twitter card, <title>, the meta description, its icon.
export function parseHtml(html) {
  const doc = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const metas = {}
  for (const m of doc.matchAll(/<meta\b([^>]*)>/gi)) {
    const a = attrsOf(m[1])
    const key = (a.property || a.name || a.itemprop || '').toLowerCase().trim()
    if (key && a.content != null && !(key in metas)) metas[key] = a.content
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(doc)?.[1] ?? null
  let icon = null
  for (const m of doc.matchAll(/<link\b([^>]*)>/gi)) {
    const a = attrsOf(m[1])
    if (/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(a.rel || '') && a.href) { icon = a.href; break }
  }
  return { metas, title, icon }
}

// an image or icon address a viewer's browser may load: http(s), not credentials, not a local or private host
function safeAsset(raw, base, allow) {
  if (!raw) return null
  let u
  try { u = new URL(entities(String(raw).trim()), base) } catch { return null }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.href.length > 2048) return null
  if (!allowedHost(u, allow) && hostRefusal(u.hostname)) return null
  return u.href
}
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 && n < 100000 ? n : null }

// The card for a page (null when it says nothing worth a card).
export function cardFrom(meta, { url, finalUrl = url, allow = new Set() } = {}) {
  const m = meta.metas
  const pick = (...ks) => ks.map((k) => m[k]).find((v) => v && String(v).trim())
  const video = videoOf(url) || videoOf(finalUrl)
  const title = clean(pick('og:title', 'twitter:title') || meta.title, 300)
  const description = clean(pick('og:description', 'twitter:description', 'description'), 500)
  const image = safeAsset(pick('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'), finalUrl, allow) || video?.thumb || null
  if (!title && !description && !image) return null
  const fin = new URL(finalUrl)
  const isVideo = !!video || /^video\b/i.test(m['og:type'] || '') || !!pick('og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player')
  return {
    url, title, description, image,
    imageWidth: num(m['og:image:width']), imageHeight: num(m['og:image:height']),
    siteName: clean(pick('og:site_name', 'application-name'), 80) || video?.site || null,
    favicon: safeAsset(meta.icon, finalUrl, allow),
    kind: isVideo ? 'video' : 'link',
    domain: domainToUnicode(fin.hostname).replace(/^www\./, '') || fin.hostname,
  }
}

// ---------- the cache, the per-person limit, the company switch ----------
const cache = new Map() // `${tenant}\n${url}` -> { at, ttl, value } — Map order is the LRU order
const pending = new Map()
function cacheGet(key, now) {
  const e = cache.get(key)
  if (!e) return null
  cache.delete(key)
  if (now - e.at > e.ttl) return null
  cache.set(key, e)
  return e.value
}
function cacheSet(key, value, ttl, now, max) {
  cache.delete(key)
  cache.set(key, { at: now, ttl, value })
  while (cache.size > max) cache.delete(cache.keys().next().value)
}
export const cacheSize = () => cache.size

const windows = new Map() // `${tenant}:${user}` -> timestamps of the pages read for them in the last minute
function take(key, perMinute, now) {
  const recent = (windows.get(key) || []).filter((t) => now - t < 60_000)
  if (recent.length >= perMinute) { windows.set(key, recent); return false }
  recent.push(now)
  windows.set(key, recent)
  if (windows.size > 5000) for (const [k, v] of windows) if (!v.some((t) => now - t < 60_000)) windows.delete(k)
  return true
}

let active = 0
const waiting = []
async function slot(fn) {
  if (active >= LIMITS.maxActive) await new Promise((r) => waiting.push(r))
  active++
  try { return await fn() } finally { active--; waiting.shift()?.() }
}

const settings = new Map() // tenant -> { at, on }
// Whether the company shows link cards: on unless an administrator turned it off. A database without the table (sql/051) is on.
export async function enabledFor(tenant = config.tenantId) {
  const hit = settings.get(String(tenant))
  if (hit && Date.now() - hit.at < LIMITS.settingsTtlMs) return hit.on
  const { q } = await import('./supa.js')
  const [r] = await q('select enabled from pro_link_preview_settings where tenant_id=$1', [String(tenant)]).catch(() => [])
  const on = r ? r.enabled !== false : true
  settings.set(String(tenant), { at: Date.now(), on })
  return on
}
export async function setEnabled(tenant, on, by) {
  const { q } = await import('./supa.js')
  try {
    await q(`insert into pro_link_preview_settings (tenant_id, enabled, updated_by, updated_at) values ($1,$2,$3,now())
             on conflict (tenant_id) do update set enabled=excluded.enabled, updated_by=excluded.updated_by, updated_at=now()`, [String(tenant), !!on, by || null])
  } catch (e) {
    if (e.code === '42P01') throw Object.assign(new Error(L('링크 미리보기 설정 테이블이 없어요 — server/sql/051_link_preview.sql 을 먼저 실행해 주세요.', 'The link preview settings table is missing — run server/sql/051_link_preview.sql first.')), { status: 503 })
    throw e
  }
  settings.delete(String(tenant))
  // a company that turns cards off sees none at once, not when the remembered pages expire
  if (!on) for (const k of [...cache.keys()]) if (k.startsWith(`${tenant}\n`)) cache.delete(k)
  return { enabled: !!on }
}

// (tests)
export function _reset() { cache.clear(); pending.clear(); windows.clear(); settings.clear() }

// A video link whose page could not be read still gets its thumbnail (YouTube's is at a known address).
function fallback(url, reason) {
  const v = videoOf(url)
  if (!v?.thumb) return { preview: null, reason }
  const u = new URL(url)
  return { preview: { url, title: null, description: null, image: v.thumb, imageWidth: 480, imageHeight: 360, siteName: v.site, favicon: null, kind: 'video', domain: u.hostname.replace(/^(www|m)\./, '') }, reason }
}
async function build(url, o) {
  try {
    const page = await fetchPage(url, o)
    const card = cardFrom(parseHtml(page.html), { url, finalUrl: page.url, allow: o.allowHosts })
    return card ? { preview: card } : fallback(url, 'empty')
  } catch (e) {
    if (!(e instanceof Refused)) console.warn('[link-preview]', e.message)
    return fallback(url, e instanceof Refused ? e.reason : 'error')
  }
}

// The card for a link someone sees in a conversation: {preview} or {preview: null, reason}. Throws 429 when this person
// has had too many pages read in the last minute (a link read before, for anyone in the company, does not count).
export async function previewFor({ userId, tenant = config.tenantId, url, own = [] }, deps = {}) {
  const o = { ...LIMITS, lookup: systemLookup, allowHosts: allowList(), perMinute: config.linkPreviewPerMinute, now: Date.now, enabled: enabledFor, ...deps }
  if (!(await o.enabled(tenant))) return { preview: null, reason: 'off' }
  let u
  try { u = new URL(String(url || '').trim()) } catch { return { preview: null, reason: 'url' } }
  const why = refusal(u, { own, allow: o.allowHosts })
  if (why) return { preview: null, reason: why }
  const norm = normalize(u.href)
  const key = `${tenant}\n${norm}`
  const hit = cacheGet(key, o.now())
  if (hit) return hit
  if (pending.has(key)) return pending.get(key)
  if (!take(`${tenant}:${userId}`, o.perMinute, o.now())) throw Object.assign(new Error('too many link previews'), { status: 429 })
  const p = slot(() => build(norm, { ...o, own }))
    .then((r) => { cacheSet(key, r, r.preview ? o.ttlMs : o.negTtlMs, o.now(), o.cacheMax); return r })
    .finally(() => pending.delete(key))
  pending.set(key, p)
  return p
}
