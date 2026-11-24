// 오늘의 배경 사진: 사진 사이트에 묻고 답을 후보 사진으로 읽는다. 서버가 여는 곳은 정해진 API 주소뿐이다.
//   - Wikimedia Commons(키 없음): 검색(generator=search, 「Featured pictures of …」 분류 + 낱말)과 그날의 사진(Template:Potd/<날짜>).
//     User-Agent 에 앱 이름과 연락처(사이트 주소)를 단다(Wikimedia 의 User-Agent 정책). 그림은 thumb/upload.wikimedia.org 의
//     표준 너비(330 · 960 · 1280 · 1920 · 3840)로만 — 그 밖의 너비는 Wikimedia 가 400 으로 거절한다.
//   - Unsplash · Pexels(회사 관리자가 키를 넣었을 때만): 검색 API. 그림은 그 사이트의 CDN 주소를 그대로 쓴다(Unsplash 지침: 핫링크).
// 주소 · 너비 · 라이선스를 여기서 다 확인한다. 화면에 내주는 그림 주소는 그 사이트의 CDN 호스트뿐이다(ALLOWED_IMAGE_HOSTS).
import { config } from '../../config.js'
import { commonsCredit, unsplashCredit, pexelsCredit, httpsUrl, utm, plain } from './credit.js'

export const USER_AGENT = 'ProcessGPT-Lite-Background/1.0 (+https://process-gpt.io)'
export const API = {
  commons: 'https://commons.wikimedia.org/w/api.php',
  unsplash: 'https://api.unsplash.com',
  pexels: 'https://api.pexels.com/v1',
}
export const SOURCE = {
  commons: { name: 'Wikimedia Commons', url: 'https://commons.wikimedia.org/' },
  unsplash: { name: 'Unsplash', url: 'https://unsplash.com/?utm_source=process_gpt_lite&utm_medium=referral' },
  pexels: { name: 'Pexels', url: 'https://www.pexels.com/' },
}
export const IMAGE_HOSTS = {
  commons: ['upload.wikimedia.org', 'thumb.wikimedia.org'],
  unsplash: ['images.unsplash.com'],
  pexels: ['images.pexels.com'],
}
// the widths a background is offered in (srcset); Wikimedia serves only its standard steps
export const WIDTHS = [960, 1280, 1920, 3840]
export const THUMB_W = 330
export const PROVIDERS = ['commons', 'unsplash', 'pexels']

// Where each API is: the fixed host, or — tests only, never behind the gateway — PRO_BG_*_API (a fake site on 127.0.0.1).
export function apiBase(provider, cfg = config) {
  const over = cfg.tenantFromHeader ? '' : String(cfg.background?.[`${provider}Api`] || '').trim()
  return (over || API[provider]).replace(/\/$/, '')
}
// the hosts this server may call: each API's own, nothing else
export function apiHosts(cfg = config) {
  return new Set(PROVIDERS.map((p) => { try { return new URL(apiBase(p, cfg)).host } catch { return '' } }).filter(Boolean))
}
// the image hosts a photo of this provider may be shown from: its CDN (and, in tests, the fake site that stands for it)
export function imageHosts(provider, cfg = config) {
  const hosts = new Set(IMAGE_HOSTS[provider] || [])
  const base = apiBase(provider, cfg)
  if (base !== API[provider]) try { hosts.add(new URL(base).host) } catch { /* not a URL */ }
  return hosts
}
// an image address of that provider the screen may load: https on its CDN (http only for a test site), no credentials
export function imageUrlOk(provider, raw, cfg = config) {
  let u
  try { u = new URL(String(raw || '')) } catch { return false }
  if (u.username || u.password || u.href.length > 1500) return false
  const hosts = imageHosts(provider, cfg)
  if (!hosts.has(u.host)) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && !IMAGE_HOSTS[provider]?.includes(u.host)
}

// ---------- fetching (fixed hosts only, short, small) ----------
export class ProviderError extends Error {
  constructor(message, status = 0) { super(message); this.status = status }
}
export async function getJson(url, { headers = {}, timeoutMs = 6000, maxBytes = 3 * 1024 * 1024, cfg = config, fetchImpl = fetch } = {}) {
  const u = new URL(url)
  if (!apiHosts(cfg).has(u.host)) throw new ProviderError(`not a photo API host: ${u.host}`)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !Object.values(API).some((a) => new URL(a).host === u.host))) throw new ProviderError('https only')
  const res = await fetchImpl(u, {
    redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
  })
  if (res.status !== 200) { res.body?.cancel?.().catch?.(() => {}); throw new ProviderError(`status ${res.status}`, res.status) }
  const reader = res.body?.getReader?.()
  if (!reader) return res.json()
  const chunks = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > maxBytes) { reader.cancel().catch(() => {}); throw new ProviderError('too large') }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'))
}

// ---------- Wikimedia Commons ----------
const META = 'LicenseShortName|LicenseUrl|Artist|ObjectName|Restrictions|UsageTerms|AttributionRequired'
const catName = (c, prefix) => `${prefix}${String(c).replace(/ /g, '_')}`
// the search string: words, the Featured-picture categories (any of them), bitmaps only
export function commonsSearch({ q = '', cats = [], prefix = 'Featured_pictures_of_' }) {
  const parts = []
  if (q) parts.push(String(q).replace(/["\\]/g, ' ').trim())
  if (cats.length) parts.push(`incategory:"${cats.map((c) => catName(c, prefix)).join('|')}"`)
  parts.push('filetype:bitmap')
  return parts.filter(Boolean).join(' ')
}
function commonsParams(extra) {
  return new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata|user', iiurlwidth: '1920', iiextmetadatafilter: META, iiextmetadatalanguage: 'en',
    ...extra,
  })
}
// offset: where in the search's ranking to start (the day's "striking landscape" walks through the Featured pictures by date)
export function commonsSearchUrl({ q, cats, limit = 30, offset = 0, prefix }, cfg = config) {
  const p = commonsParams({ generator: 'search', gsrnamespace: '6', gsrsearch: commonsSearch({ q, cats, prefix }), gsrlimit: String(limit), ...(offset > 0 ? { gsroffset: String(offset) } : {}) })
  return `${apiBase('commons', cfg)}?${p}`
}
export function commonsPotdUrl(date, cfg = config) {
  return `${apiBase('commons', cfg)}?${commonsParams({ generator: 'images', titles: `Template:Potd/${date}` })}`
}

const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/tiff'])
// a thumbnail address at another standard width (the last path segment carries "<w>px-"), without Wikimedia's utm query
export function commonsThumbAt(thumburl, w) {
  const u = new URL(thumburl)
  u.search = ''
  const segs = u.pathname.split('/')
  const last = segs.pop()
  if (!/\d+px-/.test(last)) return null
  segs.push(last.replace(/\d+px-/, `${w}px-`))
  u.pathname = segs.join('/')
  return u.href
}
// imageinfo → the sizes the screen gets: a 330px thumbnail and the background widths the original is big enough for
export function commonsSizes(ii) {
  const width = Number(ii.width) || 0, height = Number(ii.height) || 0
  const ratio = height ? width / height : 0
  const thumb = ii.thumburl ? commonsThumbAt(ii.thumburl, THUMB_W) : null
  const src = {}
  for (const w of WIDTHS) {
    if (w >= width) continue
    if (w === 3840 && ratio < 2.2) continue // the largest step only for a panorama that a tall window scales up
    const at = ii.thumburl && commonsThumbAt(ii.thumburl, w)
    if (at) src[w] = at
  }
  // an original narrower than 1920: itself as the largest, unless it is a heavy file (over 4 MB)
  if ((!Object.keys(src).length || width < 1920) && !(Number(ii.size) > 4 * 1024 * 1024)) { const orig = httpsUrl(ii.url); if (orig) src[width] = orig.split('?')[0] }
  return { thumb: thumb || src[Math.min(...Object.keys(src).map(Number))] || null, src, width, height }
}

// A Commons answer (search or POTD) → photos that may be used, in the answer's order.
// opts: minWidth, ratio [lo, hi]
export function parseCommons(json, { minWidth = 1600, ratio = [1.3, 2.6], cfg = config } = {}) {
  const pages = [...(json?.query?.pages || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const out = []
  for (const p of pages) {
    const ii = p?.imageinfo?.[0]
    if (!ii || !MIMES.has(ii.mime)) continue
    const w = Number(ii.width) || 0, h = Number(ii.height) || 0
    if (w < minWidth || !h || w / h < ratio[0] || w / h > ratio[1]) continue
    const credit = commonsCredit({ title: p.title, extmetadata: ii.extmetadata, user: ii.user })
    if (!credit) continue
    const sizes = commonsSizes(ii)
    if (!sizes.thumb || !Object.keys(sizes.src).length) continue
    if (![sizes.thumb, ...Object.values(sizes.src)].every((u) => imageUrlOk('commons', u, cfg))) continue
    out.push({
      id: `commons:${p.pageid}`, provider: 'commons', ...credit,
      sourceUrl: httpsUrl(ii.descriptionurl) || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, '_'))}`,
      sourceName: SOURCE.commons.name, color: null, ...sizes,
    })
  }
  return out
}

// ---------- Unsplash ----------
export function unsplashSearchUrl({ keywords, limit = 30 }, cfg = config) {
  const p = new URLSearchParams({ query: String(keywords || 'landscape'), orientation: 'landscape', per_page: String(Math.min(30, limit)), content_filter: 'high' })
  return `${apiBase('unsplash', cfg)}/search/photos?${p}`
}
export const unsplashHeaders = (key) => ({ Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' })
const withParams = (raw, params) => { const u = new URL(raw); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v)); return u.href }
const HEX = /^#[0-9a-f]{6}$/i
export function parseUnsplash(json, { cfg = config } = {}) {
  const out = []
  for (const p of json?.results || []) {
    const raw = p?.urls?.raw
    const w = Number(p?.width) || 0, h = Number(p?.height) || 0
    if (!raw || !p?.id || !h || w / h < 1.2 || !imageUrlOk('unsplash', raw, cfg)) continue
    const src = {}
    for (const width of [960, 1280, 1920]) src[width] = withParams(raw, { w: width, q: 80, fm: 'jpg', fit: 'max' })
    const download = String(p?.links?.download_location || '')
    out.push({
      id: `unsplash:${String(p.id).replace(/[^\w-]/g, '')}`, provider: 'unsplash', ...unsplashCredit(p),
      sourceUrl: utm(p?.links?.html) || SOURCE.unsplash.url, sourceName: SOURCE.unsplash.name,
      color: HEX.test(p?.color || '') ? p.color : null,
      thumb: withParams(raw, { w: THUMB_W, h: 220, fit: 'crop', q: 70, fm: 'jpg' }), src, width: w, height: h,
      downloadLocation: unsplashDownloadOk(download, cfg) ? download : null,
    })
  }
  return out
}
// the download endpoint Unsplash asks to be called when a photo is used (set as a background): its API host, /photos/<id>/download
export function unsplashDownloadOk(url, cfg = config) {
  try {
    const u = new URL(url)
    const api = new URL(apiBase('unsplash', cfg))
    const rest = u.pathname.startsWith(api.pathname.replace(/\/$/, '')) ? u.pathname.slice(api.pathname.replace(/\/$/, '').length) : ''
    return u.host === api.host && u.protocol === api.protocol && /^\/photos\/[\w-]+\/download$/.test(rest)
  } catch { return false }
}

// ---------- Pexels ----------
export function pexelsSearchUrl({ keywords, limit = 30 }, cfg = config) {
  const p = new URLSearchParams({ query: String(keywords || 'landscape'), orientation: 'landscape', per_page: String(Math.min(40, limit)) })
  return `${apiBase('pexels', cfg)}/search?${p}`
}
export const pexelsHeaders = (key) => ({ Authorization: String(key) })
export function parsePexels(json, { cfg = config } = {}) {
  const out = []
  for (const p of json?.photos || []) {
    const orig = p?.src?.original
    const w = Number(p?.width) || 0, h = Number(p?.height) || 0
    if (!orig || !p?.id || !h || w / h < 1.2 || !imageUrlOk('pexels', orig, cfg)) continue
    const base = orig.split('?')[0]
    const src = {}
    for (const width of [960, 1280, 1920]) src[width] = withParams(base, { auto: 'compress', cs: 'tinysrgb', w: width })
    out.push({
      id: `pexels:${String(p.id).replace(/\D/g, '')}`, provider: 'pexels', ...pexelsCredit(p),
      sourceUrl: httpsUrl(p?.url) || SOURCE.pexels.url, sourceName: SOURCE.pexels.name,
      color: HEX.test(p?.avg_color || '') ? p.avg_color : null,
      thumb: withParams(base, { auto: 'compress', cs: 'tinysrgb', w: THUMB_W, h: 220, fit: 'crop' }), src, width: w, height: h,
    })
  }
  return out
}

// a photo's alt text for the screen (its title, short)
export const altOf = (p) => plain(p?.title, 120)
