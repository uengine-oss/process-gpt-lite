// YouTube. Popular and searched videos through the YouTube Data API v3; channel uploads, video
// details and transcripts from public data.
//   API credential, the first that works: the user's vault API key (apikey, site youtube) → the
//   server's PRO_YOUTUBE_API_KEY → the user's Google account from the vault (oauth google, Bearer,
//   youtube.readonly). None of them working: what is missing and where to connect it, with the
//   public results page instead (search as asked; for the chart, the last day's uploads by views,
//   labelled as an approximation) — or as a structured error when that page fails too.
//   Without the API: channel uploads from the channel's RSS feed (no key, no yt-dlp), then yt-dlp,
//   then the channel's videos page. YouTube retired its public Trending page in 2025, so the
//   popular chart (videos?chart=mostPopular) needs the API.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { config } from '../../config.js'
import { getSecret } from '../../lib/vault.js'
import { googleAccessToken, googleEnabled } from '../../lib/mail.js'
import { L } from '../../lib/lang.js'

// Korean metadata instead of YouTube's auto-translated titles
const BASE = ['--extractor-args', 'youtube:lang=ko', '--no-warnings']
const ytdlp = (args, timeout = 120000) => new Promise((resolve, reject) => {
  execFile('yt-dlp', [...BASE, ...args], { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (!err) return resolve(stdout)
    if (err.code === 'ENOENT') return reject(Object.assign(new Error(L('이 서버에 yt-dlp 가 설치되어 있지 않아요(관리자: 서버 이미지에 yt-dlp 설치).', 'yt-dlp is not installed on this server (admin: install yt-dlp in the server image).')), { code: 'ENOENT' }))
    reject(new Error((stderr || err.message).split('\n').filter(Boolean).slice(-2).join(' ')))
  })
})

// what the tools reach the outside with; tests replace these
export const deps = {
  fetch: (...a) => globalThis.fetch(...a),
  ytdlp,
  vaultKey: async (userId) => (await getSecret(userId, 'apikey', 'youtube'))?.key || (await getSecret(userId, 'apikey', 'youtube.com'))?.key || null,
  serverKey: () => config.youtubeApiKey || '',
  // null: not connected; scoped null: an older connection that did not record its scopes
  google: async (userId) => {
    const sec = await getSecret(userId, 'oauth', 'google')
    if (!sec?.refresh_token && !sec?.access_token) return null
    return { scoped: sec.scope ? /youtube/.test(sec.scope) : null, token: () => googleAccessToken(userId) }
  },
  googleEnabled: () => googleEnabled(),
}

const API = 'https://www.googleapis.com/youtube/v3'
const KEY_CONSOLE = 'https://console.cloud.google.com/apis/library/youtube.googleapis.com'
const VIA = { vault_key: () => L('보관함의 YouTube API 키', 'the YouTube API key in the vault'), server_key: () => L('서버의 YouTube API 키(PRO_YOUTUBE_API_KEY)', "the server's YouTube API key (PRO_YOUTUBE_API_KEY)"), google_oauth: () => L('연결한 Google 계정', 'the connected Google account') }

export class YouTubeSetupError extends Error {
  constructor(detail) { super(detail.message); this.detail = detail }
}

async function credentials(userId) {
  const out = []
  const vk = await deps.vaultKey(userId).catch(() => null)
  if (vk) out.push({ via: 'vault_key', key: vk })
  const sk = deps.serverKey()
  if (sk) out.push({ via: 'server_key', key: sk })
  const g = await deps.google(userId).catch(() => null)
  if (g) out.push({ via: 'google_oauth', scoped: g.scoped, token: g.token })
  return out
}

// Which API failure another credential might get past (a wrong or restricted key, a spent quota,
// an expired account) and which it would not (a bad argument, YouTube itself failing).
function failure(status, body) {
  const e = body?.error || {}
  const reasons = [...(e.errors || []).map((x) => x.reason), ...(e.details || []).map((x) => x?.reason)].filter(Boolean).join(' ')
  const text = `${status} ${e.status || ''} ${reasons} ${e.message || ''}`
  if (/quota|dailyLimit|rateLimit/i.test(text)) return { next: true, text: L('YouTube API 하루 할당량을 다 썼어요', 'the daily YouTube API quota is used up') }
  if (/keyInvalid|API key not valid|API_KEY_INVALID/i.test(text)) return { next: true, text: L('API 키가 올바르지 않아요', 'the API key is not valid') }
  if (/accessNotConfigured|SERVICE_DISABLED|ACCESS_DENIED|API_KEY_SERVICE_BLOCKED|has not been used|is disabled/i.test(text) || (status === 403 && /forbidden|PERMISSION_DENIED/i.test(text) && !/insufficient/i.test(text)))
    return { next: true, text: L('이 키의 Google Cloud 프로젝트에서 YouTube Data API v3 를 쓸 수 없어요(API 사용 설정·키 제한 확인)', "this key's Google Cloud project cannot use the YouTube Data API v3 (enable the API, check the key's restrictions)") }
  if (status === 401 || /insufficient|UNAUTHENTICATED|invalid_grant/i.test(text)) return { next: true, text: L('Google 계정의 YouTube 권한이 없거나 만료됐어요', "the Google account's YouTube permission is missing or expired") }
  return { next: false, text: `${status}: ${e.message || reasons || 'error'}` }
}

// What is missing and where to connect it, for a run that has no credential that works.
async function setupDetail(tried, have) {
  const google = await deps.googleEnabled()
  const missing = []
  if (!have.has('vault_key') && !have.has('server_key')) missing.push(L('YouTube API 키(YouTube Data API v3)', 'a YouTube API key (YouTube Data API v3)'))
  if (google && !have.has('google_oauth')) missing.push(L('YouTube 읽기 권한이 있는 Google 계정 연결', 'a connected Google account with YouTube read access'))
  return {
    error: 'youtube_api_unavailable',
    message: tried.length
      ? L('가진 자격 증명으로는 YouTube Data API 를 쓰지 못했어요.', "The YouTube Data API could not be used with the credentials there are.")
      : L('YouTube Data API 를 쓸 자격 증명이 없어요.', 'There is no credential for the YouTube Data API.'),
    missing,
    tried: tried.map((t) => ({ credential: VIA[t.via](), reason: t.reason })),
    how_to_connect: google
      ? L(`설정 › 계정 › 연결 › YouTube 에서 「API 키 넣기」로 YouTube Data API v3 키를 저장하거나, 같은 화면의 Google 「연결」로 Google 계정을 연결하세요(YouTube 읽기 권한 포함). 키는 Google Cloud 콘솔에서 YouTube Data API v3 를 사용 설정한 뒤 「사용자 인증 정보 › API 키」로 만들어요: ${KEY_CONSOLE}`,
        `In Settings › Account › Connections › YouTube, save a YouTube Data API v3 key with "Add API key", or connect a Google account (with YouTube read access) with Google "Connect" on the same screen. Make the key in the Google Cloud console: enable the YouTube Data API v3, then "Credentials › API key": ${KEY_CONSOLE}`)
      : L(`설정 › 계정 › 연결 › YouTube 에서 「API 키 넣기」로 YouTube Data API v3 키를 저장하세요. 키는 Google Cloud 콘솔에서 YouTube Data API v3 를 사용 설정한 뒤 「사용자 인증 정보 › API 키」로 만들어요: ${KEY_CONSOLE}`,
        `In Settings › Account › Connections › YouTube, save a YouTube Data API v3 key with "Add API key". Make the key in the Google Cloud console: enable the YouTube Data API v3, then "Credentials › API key": ${KEY_CONSOLE}`),
    admin: L('관리자는 서버 환경 변수 PRO_YOUTUBE_API_KEY 로 회사 공용 키를 둘 수도 있어요.', 'An administrator can also set a shared key with the server environment variable PRO_YOUTUBE_API_KEY.'),
    // the one line to pass on as it is
    tell_user: google
      ? L('정확한 YouTube 인기 차트는 설정 › 계정 › 연결 › YouTube 에 API 키를 넣거나 Google 계정을 연결하면 볼 수 있어요.', 'For the exact YouTube popular chart, add an API key in Settings › Account › Connections › YouTube or connect a Google account.')
      : L('정확한 YouTube 인기 차트는 설정 › 계정 › 연결 › YouTube 에 API 키를 넣으면 볼 수 있어요.', 'For the exact YouTube popular chart, add an API key in Settings › Account › Connections › YouTube.'),
    without_api: L('키 없이도 youtube_search 는 공개 검색 페이지로, youtube_channel_videos 는 채널 RSS 로 동작해요. 인기 차트(오늘 가장 많이 본 영상)는 YouTube 가 공개 인기 페이지를 없애서 API 로만 볼 수 있어요(브라우저로도 볼 수 없어요).',
      'Without a key, youtube_search reads the public results page and youtube_channel_videos the channel RSS feed. The popular chart (most viewed today) is only in the API: YouTube retired its public Trending page (the browser cannot show it either).'),
  }
}

async function api(userId, endpoint, params) {
  const creds = await credentials(userId)
  const tried = []
  for (const c of creds) {
    if (c.scoped === false) { tried.push({ via: c.via, reason: L('YouTube 읽기 권한(youtube.readonly) 없이 연결돼 있어요 — Google 「다시 연결(권한 넓히기)」', 'connected without YouTube read access (youtube.readonly) — Google "Reconnect (widen permissions)"') }); continue }
    const p = new URLSearchParams(params)
    const headers = { Accept: 'application/json' }
    if (c.key) p.set('key', c.key)
    else {
      try { headers.Authorization = `Bearer ${await c.token()}` } catch (e) { tried.push({ via: c.via, reason: e.message }); continue }
    }
    const res = await deps.fetch(`${API}/${endpoint}?${p}`, { headers })
    const body = await res.json().catch(() => ({}))
    if (res.ok) return { body, via: c.via }
    const f = failure(res.status, body)
    if (!f.next) throw new Error(`YouTube API ${f.text}`)
    tried.push({ via: c.via, reason: f.text })
  }
  throw new YouTubeSetupError(await setupDetail(tried, new Set(creds.map((c) => c.via))))
}

const num = (v) => (v == null || v === '' ? null : Number(v))
const bestThumb = (t) => (t ? (t.maxres || t.standard || t.high || t.medium || t.default)?.url || null : null)
const watch = (id) => `https://www.youtube.com/watch?v=${id}`
// a Data API video resource → what the agent reads
export const shapeVideo = (v, i) => ({
  rank: i + 1, id: v.id, title: v.snippet?.title ?? null, channel: v.snippet?.channelTitle ?? null, channel_id: v.snippet?.channelId ?? null,
  views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount),
  published_at: v.snippet?.publishedAt ?? null, duration: v.contentDetails?.duration ?? null, url: watch(v.id), thumbnail: bestThumb(v.snippet?.thumbnails),
})

// category names people use → YouTube's video category ids (they are the same in every region)
const CATEGORIES = [
  [/^(1|영화|애니|film|animation|movie)/i, '1'], [/^(2|자동차|autos?|cars?|vehicles?)/i, '2'], [/^(10|음악|music)/i, '10'], [/^(15|동물|반려|pets?|animals?)/i, '15'],
  [/^(17|스포츠|sports?)/i, '17'], [/^(19|여행|travel)/i, '19'], [/^(20|게임|gaming|games?)/i, '20'], [/^(22|인물|블로그|people|blogs?|vlog)/i, '22'],
  [/^(23|코미디|comedy)/i, '23'], [/^(24|엔터|예능|entertainment)/i, '24'], [/^(25|뉴스|정치|news|politics)/i, '25'], [/^(26|노하우|스타일|howto|style)/i, '26'],
  [/^(27|교육|education)/i, '27'], [/^(28|과학|기술|science|tech)/i, '28'],
]
export const categoryId = (c) => (c == null || c === '' ? null : /^\d+$/.test(String(c)) ? String(c) : CATEGORIES.find(([re]) => re.test(String(c).trim()))?.[1] ?? null)

// "24h", "7d", "2026-11-18" (a Seoul day) or an ISO time → Date
export function sinceOf(v, now = new Date()) {
  if (!v) return null
  const s = String(v).trim()
  const rel = /^(\d+)\s*(h|d|시간|일)$/i.exec(s)
  if (rel) return new Date(now.getTime() - Number(rel[1]) * (/^(h|시간)$/i.test(rel[2]) ? 3600e3 : 86400e3))
  if (/^(today|오늘)$/i.test(s)) return new Date(new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10) + 'T00:00:00+09:00')
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00+09:00`)
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

// The results page's own filter (the `sp` parameter: a small protobuf): sort order, upload date, videos only
export function searchFilter(order, since, now = new Date()) {
  const sort = { relevance: 0, rating: 1, date: 2, viewCount: 3 }[order] ?? 0
  const age = since ? now.getTime() - since.getTime() : null
  const upload = age == null ? 0 : age <= 3600e3 ? 1 : age <= 86400e3 * 1.05 ? 2 : age <= 7 * 86400e3 ? 3 : age <= 31 * 86400e3 ? 4 : age <= 366 * 86400e3 ? 5 : 0
  const f = [...(upload ? [0x08, upload] : []), 0x10, 0x01]
  return Buffer.from([...(sort ? [0x08, sort] : []), 0x12, f.length, ...f]).toString('base64')
}

// ---------- public pages ----------
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.6',
  // past the EU consent page
  Cookie: 'CONSENT=YES+1; SOCS=CAI',
}
async function page(url) {
  const res = await deps.fetch(url, { headers: PAGE_HEADERS })
  if (!res.ok) throw new Error(`${new URL(url).pathname} ${res.status}`)
  return res.text()
}

// the JSON object a page script assigns after marker (string-aware brace matching)
export function jsonAfter(html, marker) {
  const i = html.indexOf(marker)
  const s = i < 0 ? -1 : html.indexOf('{', i + marker.length)
  if (s < 0) return null
  let depth = 0, str = false, esc = false
  for (let k = s; k < html.length; k++) {
    const ch = html[k]
    if (str) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') str = false; continue }
    if (ch === '"') str = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) { try { return JSON.parse(html.slice(s, k + 1)) } catch { return null } }
  }
  return null
}
const initialData = (html) => jsonAfter(html, 'var ytInitialData = ') || jsonAfter(html, 'window["ytInitialData"] = ') || jsonAfter(html, 'ytInitialData = ')

const text = (x) => (x == null ? null : typeof x === 'string' ? x : x.simpleText ?? x.content ?? (x.runs ? x.runs.map((r) => r.text).join('') : null))
// "조회수 1,103,049회", "조회수 1.2만회", "1.2M views", "조회수 없음" → a number
export function countOf(t) {
  const s = String(t || '')
  if (!s) return null
  if (/없음|no views/i.test(s)) return 0
  const m = /(\d[\d,.]*)\s*(천|만|억|[KMB](?![a-z]))?/i.exec(s)
  if (!m) return null
  const mul = { 천: 1e3, 만: 1e4, 억: 1e8, k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1
  return Math.round(Number(m[1].replace(/,/g, '')) * mul)
}

function fromRenderer(r) {
  const owner = r.ownerText || r.longBylineText || r.shortBylineText
  const viewsText = text(r.viewCountText) || text(r.shortViewCountText)
  return {
    id: r.videoId, title: text(r.title), channel: text(owner)?.trim() || null,
    channel_id: owner?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null,
    views: countOf(viewsText), views_text: viewsText, likes: null, published: text(r.publishedTimeText), duration: text(r.lengthText),
    url: watch(r.videoId), thumbnail: r.thumbnail?.thumbnails?.at(-1)?.url || null,
  }
}
// (the newer layout: the byline part links to the channel, the views part says "193만" with
// "조회수 193만회" as its label, the duration is a badge on the thumbnail)
const VIEWS = /조회수|views?\b|시청/i
const channelLink = (p) => p?.text?.commandRuns?.map((c) => c.onTap?.innertubeCommand?.browseEndpoint?.browseId).find((id) => /^UC/.test(id || ''))
function fromLockup(l) {
  const md = l.metadata?.lockupMetadataViewModel
  const parts = (md?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap((r) => r.metadataParts || [])
  const said = (p) => [p.accessibilityLabel, text(p.text)].filter(Boolean)
  const viewsText = parts.flatMap(said).find((s) => VIEWS.test(s)) || null
  const by = parts.find(channelLink)
  return {
    id: l.contentId, title: text(md?.title), channel: by ? text(by.text) : null,
    channel_id: channelLink(by) || md?.image?.decoratedAvatarViewModel?.rendererContext?.commandContext?.onTap?.innertubeCommand?.browseEndpoint?.browseId || null,
    views: countOf(viewsText), views_text: viewsText, likes: null, published: parts.map((p) => text(p.text)).find((s) => /전$|ago$/i.test(s || '')) || null,
    duration: /"text":"(\d+(?::\d\d)+)"/.exec(JSON.stringify(l.contentImage || {}))?.[1] || null,
    url: watch(l.contentId), thumbnail: l.contentImage?.thumbnailViewModel?.image?.sources?.at(-1)?.url || null,
  }
}
// every video on a page (search results: videoRenderer; channel tabs: lockupViewModel), once each
export function pageVideos(data) {
  const out = []
  const seen = new Set()
  const walk = (o) => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) { for (const v of o) walk(v); return }
    const v = o.videoRenderer?.videoId ? fromRenderer(o.videoRenderer)
      : o.lockupViewModel?.contentId && /VIDEO/.test(o.lockupViewModel.contentType || 'VIDEO') ? fromLockup(o.lockupViewModel) : null
    if (v) { if (!seen.has(v.id)) { seen.add(v.id); out.push(v) } return }
    for (const x of Object.values(o)) walk(x)
  }
  walk(data)
  return out
}

const byViews = (a, b) => (b.views ?? -1) - (a.views ?? -1)
async function publicSearch({ query, order, since, max, region = 'KR' }) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=${encodeURIComponent(searchFilter(order, since))}&hl=${region === 'KR' ? 'ko' : 'en'}&gl=${region}`
  const data = initialData(await page(url))
  if (!data) throw new Error(L('검색 결과 페이지를 읽지 못했어요', "couldn't read the results page"))
  let videos = pageVideos(data)
  if (order === 'viewCount') videos = videos.sort(byViews)
  return videos.slice(0, max).map((v, i) => ({ rank: i + 1, ...v }))
}

// No API for the chart: the closest public view — the last day's uploads by view count over a few broad
// topics (or the one category asked for), merged. Labelled as an approximation, never as the chart.
const BROAD = { KR: ['뉴스', '음악', '게임', '예능', '스포츠'], other: ['news', 'music', 'gaming', 'entertainment', 'sports'] }
async function publicPopular({ region, category, max }) {
  const words = category ? [String(category)] : BROAD[region] || BROAD.other
  const since = new Date(Date.now() - 86400e3)
  const lists = await Promise.allSettled(words.map((w) => publicSearch({ query: w, order: 'viewCount', since, max: 20, region })))
  const ok = lists.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value)
  if (!ok.length) throw new Error(lists.find((r) => r.status === 'rejected')?.reason?.message || L('공개 검색 결과가 없어요', 'no public results'))
  const seen = new Set()
  return { words, videos: ok.filter((v) => !seen.has(v.id) && seen.add(v.id)).sort(byViews).slice(0, max).map(({ rank, ...v }, i) => ({ rank: i + 1, ...v })) }
}

// ---------- channels ----------
const unxml = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
const tagOf = (s, t) => unxml(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`).exec(s)?.[1] ?? '').trim()
const attrOf = (s, t, a) => new RegExp(`<${t}\\s[^>]*?\\b${a}="([^"]*)"`).exec(s)?.[1] ?? null
const seoulDay = (iso) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '') : null)

// a channel's RSS feed (its 15 newest uploads, with views and likes)
export function parseFeed(xml) {
  const head = xml.split('<entry>')[0]
  return {
    channel: tagOf(head, 'title') || null,
    videos: [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
      const id = tagOf(e, 'yt:videoId')
      const published = tagOf(e, 'published') || null
      return {
        id, title: tagOf(e, 'title'), url: watch(id), published_at: published, upload_date: seoulDay(published),
        views: num(attrOf(e, 'media:statistics', 'views')), likes: num(attrOf(e, 'media:starRating', 'count')),
        thumbnail: attrOf(e, 'media:thumbnail', 'url'), description: tagOf(e, 'media:description').slice(0, 300),
      }
    }),
  }
}

function channelUrl(channel) {
  const c = String(channel).trim()
  if (/^https?:\/\//.test(c)) return c.replace(/\/$/, '') + (/\/(videos|streams|shorts)$/.test(c) ? '' : '/videos')
  if (c.startsWith('@')) return `https://www.youtube.com/@${encodeURIComponent(c.slice(1))}/videos`
  if (/^UC[\w-]{22}$/.test(c)) return `https://www.youtube.com/channel/${c}/videos`
  return `https://www.youtube.com/@${encodeURIComponent(c)}/videos`
}

// @handle, a channel URL or a name → the channel id (read from the channel page)
async function channelOf(channel) {
  const id = /(UC[\w-]{22})/.exec(String(channel))?.[1]
  if (id) return { id }
  const html = await page(channelUrl(channel).replace(/\/(videos|streams|shorts)$/, ''))
  const found = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)?.[1]
    || /"externalId":"(UC[\w-]{22})"/.exec(html)?.[1] || /"channelId":"(UC[\w-]{22})"/.exec(html)?.[1]
  if (!found) throw new Error(L(`채널 id 를 찾지 못했어요: ${channel}`, `couldn't find the channel id of ${channel}`))
  return { id: found, title: unxml(/<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] || '') || null }
}

const viaRss = async (channel, limit) => {
  const ch = await channelOf(channel)
  const feed = parseFeed(await page(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`))
  return { channel: feed.channel || ch.title || null, channel_id: ch.id, source: 'rss', videos: feed.videos.slice(0, limit) }
}
const viaYtdlp = async (channel, limit) => {
  const j = JSON.parse(await deps.ytdlp(['--flat-playlist', '-J', '--playlist-end', String(limit), channelUrl(channel)]))
  return {
    channel: j.channel || j.uploader || j.title, channel_id: j.channel_id, source: 'yt-dlp',
    videos: (j.entries || []).map((e) => ({ id: e.id, title: e.title, url: watch(e.id), duration: e.duration, upload_date: e.upload_date || null, views: e.view_count ?? null })),
  }
}
const viaPage = async (channel, limit) => {
  const data = initialData(await page(channelUrl(channel)))
  const videos = data ? pageVideos(data) : []
  if (!videos.length) throw new Error(L('채널 페이지에서 영상을 찾지 못했어요', 'no videos on the channel page'))
  return { channel: String(channel), channel_id: null, source: 'channel_page', videos: videos.slice(0, limit) }
}

// Is there an API credential (settings card, the agent's hints)
export async function youtubeAccess(userId) {
  const g = await deps.google(userId).catch(() => null)
  return { key: (await deps.vaultKey(userId).catch(() => null)) ? 'vault' : deps.serverKey() ? 'server' : null, google: !!g && g.scoped !== false }
}

// a key pasted in the settings card, tried once before it is saved (1 quota unit): null when it works
export async function verifyKey(key) {
  const res = await deps.fetch(`${API}/videos?${new URLSearchParams({ part: 'id', chart: 'mostPopular', regionCode: 'KR', maxResults: '1', key })}`, { headers: { Accept: 'application/json' } }).catch(() => null)
  if (!res) return L('YouTube API 에 연결하지 못했어요. 잠시 후 다시 해 주세요.', "Couldn't reach the YouTube API. Please try again in a moment.")
  if (res.ok) return null
  const why = failure(res.status, await res.json().catch(() => ({}))).text
  return L(`이 키로는 YouTube 를 볼 수 없어요: ${why}`, `This key cannot read YouTube: ${why}`)
}

export const youtube = {
  name: 'youtube',
  title: 'YouTube',
  connected: async () => true, // public data; the API tools explain what is missing themselves
  status: youtubeAccess,
  verify: verifyKey,
  tools: [
    {
      name: 'youtube_trending',
      description: 'Most popular YouTube videos right now in a region (YouTube Data API chart=mostPopular): "오늘 인기 영상", "조회수 1위". region is a 2-letter code (default KR); category optional (e.g. 음악, 게임, 뉴스, 스포츠 or a category id). Returns rank, title, channel, views, likes, published time, url, thumbnail. Without an API key or Google account it returns the closest public approximation (exact_chart: false) together with what is missing and where to connect it — tell the user both; there is nothing more to find in the browser.',
      input: { region: z.string().optional(), category: z.string().optional(), max: z.number().int().min(1).max(50).optional() },
      run: async (u, { region = 'KR', category, max = 10 }) => {
        const cat = categoryId(category)
        if (category && !cat) throw new Error(L(`모르는 카테고리예요: ${category} (음악, 게임, 뉴스, 스포츠, 엔터, 코미디, 교육, 과학 … 또는 숫자 id)`, `Unknown category: ${category} (music, gaming, news, sports, entertainment, comedy, education, science … or a numeric id)`))
        const regionCode = String(region).trim().toUpperCase().slice(0, 2)
        try {
          const { body, via } = await api(u, 'videos', { part: 'snippet,statistics,contentDetails', chart: 'mostPopular', regionCode, maxResults: String(max), hl: 'ko', ...(cat ? { videoCategoryId: cat } : {}) })
          return { source: 'youtube_data_api', exact_chart: true, credential: via, region: regionCode, category: cat, fetched_at: new Date().toISOString(), videos: (body.items || []).map(shapeVideo) }
        } catch (e) {
          if (!(e instanceof YouTubeSetupError)) throw e
          let found
          try { found = await publicPopular({ region: regionCode, category: category && !/^\d+$/.test(String(category)) ? category : null, max }) } catch (pe) {
            throw new YouTubeSetupError({ ...e.detail, public_page_error: pe.message })
          }
          return {
            source: 'public_search_page', exact_chart: false, region: regionCode, category: cat, fetched_at: new Date().toISOString(),
            basis: L(`정식 인기 차트가 아니에요: API 자격 증명이 없어 공개 검색에서 최근 24시간 안에 올라온 영상(${found.words.join('·')})을 조회수 순으로 모은 근삿값이에요.`,
              `Not the official popular chart: with no API credential, these are the last 24 hours' uploads (${found.words.join(', ')}) from public search, by view count.`),
            api_missing: e.detail.missing, tried: e.detail.tried, how_to_connect: e.detail.how_to_connect, admin: e.detail.admin,
            tell_user: L(`정식 인기 차트가 아니라 최근 24시간 안에 올라온 영상을 조회수 순으로 모은 결과예요. ${e.detail.tell_user}`, `This is not the official popular chart but the last 24 hours' uploads by view count. ${e.detail.tell_user}`),
            videos: found.videos,
          }
        }
      },
    },
    {
      name: 'youtube_search',
      description: 'Search YouTube videos. order: viewCount (most viewed first, default), date (newest first), relevance. publishedAfter: "24h", "7d", "today", a date (YYYY-MM-DD, Seoul) or an ISO time. Uses the YouTube Data API; without a key it reads the public results page (views as shown there, no likes) and says what is missing for the API.',
      input: { query: z.string(), order: z.enum(['viewCount', 'date', 'relevance']).optional(), publishedAfter: z.string().optional(), region: z.string().optional(), max: z.number().int().min(1).max(50).optional() },
      run: async (u, { query, order = 'viewCount', publishedAfter, region = 'KR', max = 10 }) => {
        const since = sinceOf(publishedAfter)
        const regionCode = String(region).trim().toUpperCase().slice(0, 2)
        try {
          const found = await api(u, 'search', { part: 'snippet', type: 'video', q: query, order, maxResults: String(max), regionCode, relevanceLanguage: 'ko', ...(since ? { publishedAfter: since.toISOString() } : {}) })
          const ids = (found.body.items || []).map((x) => x.id?.videoId).filter(Boolean)
          if (!ids.length) return { source: 'youtube_data_api', credential: found.via, query, order, videos: [] }
          const { body } = await api(u, 'videos', { part: 'snippet,statistics,contentDetails', id: ids.join(',') })
          const byId = new Map((body.items || []).map((v) => [v.id, v]))
          return { source: 'youtube_data_api', credential: found.via, query, order, published_after: since?.toISOString() ?? null, videos: ids.map((id) => byId.get(id)).filter(Boolean).map(shapeVideo) }
        } catch (e) {
          if (!(e instanceof YouTubeSetupError)) throw e
          // no API: the public results page, filtered and sorted by YouTube itself
          try {
            const videos = await publicSearch({ query, order, since, max })
            return {
              source: 'public_search_page', query, order, published_after: since?.toISOString() ?? null,
              note: L('API 자격 증명이 없어 공개 검색 결과 페이지에서 읽었어요. 조회수는 페이지에 보이는 값이고 좋아요 수는 없어요.', 'No API credential, so this was read from the public results page: views are as shown there, and there are no like counts.'),
              api_missing: e.detail.missing, how_to_connect: e.detail.how_to_connect, videos,
            }
          } catch (pe) {
            throw new YouTubeSetupError({ ...e.detail, public_page_error: pe.message })
          }
        }
      },
    },
    {
      name: 'youtube_channel_videos',
      description: 'List the most recent uploads of a YouTube channel (handle like @name, channel id, or URL). Returns id, title, url, published time, views and likes when known. Works without an API key (channel RSS feed).',
      input: { channel: z.string(), limit: z.number().int().min(1).max(30).optional() },
      run: async (_u, { channel, limit = 10 }) => {
        // the feed holds the 15 newest; more than that is yt-dlp's
        const order = limit > 15 ? [viaYtdlp, viaRss, viaPage] : [viaRss, viaYtdlp, viaPage]
        const errors = []
        for (const way of order) {
          try { return await way(channel, limit) } catch (e) { errors.push(`${way === viaRss ? 'RSS' : way === viaYtdlp ? 'yt-dlp' : L('채널 페이지', 'channel page')}: ${e.message}`) }
        }
        throw new Error(L(`채널 영상을 가져오지 못했어요 — ${errors.join(' / ')}`, `Couldn't get the channel's videos — ${errors.join(' / ')}`))
      },
    },
    {
      name: 'youtube_video_info',
      description: 'Title, upload date, duration, views and description of one video.',
      input: { videoId: z.string() },
      run: async (_u, { videoId }) => {
        try {
          const j = JSON.parse(await deps.ytdlp(['-J', '--skip-download', watch(videoId)]))
          return { id: j.id, title: j.title, upload_date: j.upload_date, duration: j.duration, channel: j.channel, views: j.view_count ?? null, likes: j.like_count ?? null, description: (j.description || '').slice(0, 4000) }
        } catch (e) {
          // the watch page carries the same details (a server without yt-dlp, a yt-dlp YouTube broke)
          const p = jsonAfter(await page(`${watch(videoId)}&hl=ko&gl=KR`), 'var ytInitialPlayerResponse = ')
          const d = p?.videoDetails
          if (!d) throw e
          const mf = p.microformat?.playerMicroformatRenderer
          return { id: d.videoId, title: d.title, upload_date: (mf?.publishDate || '').slice(0, 10).replace(/-/g, '') || null, duration: num(d.lengthSeconds), channel: d.author, views: num(d.viewCount), likes: null, description: (d.shortDescription || '').slice(0, 4000), source: 'watch_page' }
        }
      },
    },
    {
      name: 'youtube_transcript',
      description: 'Transcript text of a video from its captions (manual or auto-generated). lang defaults to ko, falls back to en.',
      input: { videoId: z.string(), lang: z.string().optional() },
      run: async (_u, { videoId, lang = 'ko' }) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-yt-'))
        try {
          // one language per request: asking for several at once trips YouTube's 429 on the extra tracks
          for (const l of [`${lang}-orig`, lang, 'en']) {
            try {
              await deps.ytdlp(['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', l, '--sub-format', 'vtt',
                '-o', path.join(dir, '%(id)s.%(ext)s'), watch(videoId)])
            } catch (e) { if (e.code === 'ENOENT') throw e; continue }
            if ((await fs.readdir(dir)).some((f) => f.endsWith('.vtt'))) break
          }
          const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.vtt'))
          const pick = files.find((f) => f.includes(`.${lang}.`)) || files.find((f) => f.includes(`.${lang}`)) || files[0]
          if (!pick) return { videoId, transcript: null, note: 'no captions available' }
          const text = vttToText(await fs.readFile(path.join(dir, pick), 'utf8'))
          return { videoId, lang: pick.split('.').slice(-2, -1)[0], chars: text.length, transcript: text.slice(0, 60000) }
        } finally { await fs.rm(dir, { recursive: true, force: true }) }
      },
    },
  ],
}

// WebVTT auto-captions repeat each line as it scrolls; keep each sentence once.
function vttToText(vtt) {
  const out = []
  let last = ''
  for (const raw of vtt.split('\n')) {
    const line = raw.replace(/<[^>]+>/g, '').trim()
    if (!line || line === 'WEBVTT' || /^(Kind|Language):/.test(line) || /-->/.test(line) || /^\d+$/.test(line)) continue
    if (line === last || last.endsWith(line)) continue
    out.push(line)
    last = line
  }
  return out.join(' ').replace(/\s+/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
}
