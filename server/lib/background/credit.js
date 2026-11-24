// 오늘의 배경 사진: 사진의 라이선스 · 작가 · 출처를 읽는다. 다시 써도 되는 사진만 남기고, 화면에 늘 붙일 출처 표시를 만든다.
//   - Wikimedia Commons: imageinfo 의 extmetadata(LicenseShortName · LicenseUrl · Artist · ObjectName · Restrictions)와 올린 사람.
//     다시 써도 되는 것: CC0 · 퍼블릭 도메인 · CC BY · CC BY-SA(판 무관) · FAL(자유 예술) · KOGL 제1유형(출처 표시) · Attribution ·
//     Copyrighted free use. NC · ND 와 GFDL 만 있는 것, 모르는 것은 쓰지 않는다. 제한 표시(초상권 · 상표 · 휘장 …)가 있으면 쓰지 않는다.
//   - Unsplash(Unsplash License: 출처 표시 권장, 핫링크와 「Photo by … on Unsplash」 링크가 API 지침), Pexels(Pexels License: 출처 표시).
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', ndash: '–', mdash: '—' }
const entities = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ''
  }
  return NAMED[e.toLowerCase()] ?? m
})
// HTML → one line of plain text (no tags, no control characters), at most max characters
export function plain(html, max = 200) {
  const t = entities(String(html ?? '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

// an https address a page may link to (protocol-relative //commons… becomes https), else null
export function httpsUrl(raw) {
  let s = entities(String(raw || '').trim())
  if (s.startsWith('//')) s = `https:${s}`
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' || u.username || u.password || u.href.length > 1000) return null
    return u.href
  } catch { return null }
}

// ---------- licenses ----------
const FREE = [
  /^cc0\b/i,
  /^public domain\b/i, /^pd\b/i,
  /^cc[ -]by(-sa)?([ -]\d(\.\d)?)?(\s*[a-z]{2,3})?$/i, // CC BY 4.0 · CC BY-SA 3.0 de · CC BY-SA 2.0
  /^fal\b/i, /^free art license\b/i,
  /^kogl type 1$/i,
  /^attribution$/i, /^attribution[ -]only$/i,
  /^copyrighted free use$/i,
]
// Whether a Commons photo may be shown as someone's background (with its credit)
export function licenseOk(shortName) {
  const s = plain(shortName, 80)
  if (!s) return false
  if (/\b(nc|nd|non[- ]?commercial|no[- ]?deriv|fair use|non[- ]?free)\b/i.test(s)) return false
  return FREE.some((r) => r.test(s))
}
// a Commons photo that carries a restriction (personality rights, trademark, insignia …) is not used as a background
export const restricted = (meta) => !!plain(meta?.Restrictions?.value, 200)

const metaText = (meta, key, max) => plain(meta?.[key]?.value, max)

// The author of a Commons file: the linked name of its user (Artist often wraps it in a whole table of requests), else the
// Artist text when it is short, else the uploader.
export function commonsAuthor(meta, uploader = '') {
  const html = String(meta?.Artist?.value || '')
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: /href\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] || '', text: plain(m[2], 80) }))
  const user = links.find((l) => /\/wiki\/User:/i.test(l.href) && l.text)
  if (user) return { author: user.text, authorUrl: httpsUrl(user.href) }
  // (an address written out in the text — "Dave ( https://… )" — is the link, not the name)
  const text = plain(html, 400).replace(/\(\s*(https?:\/\/|www\.)[^)]*\)/gi, '').replace(/\s+/g, ' ').trim()
  if (text && text.length <= 80) {
    const link = links.find((l) => l.text && httpsUrl(l.href) && !/upload\.wikimedia\.org|mailto:/i.test(l.href))
    return { author: text, authorUrl: link ? httpsUrl(link.href) : null }
  }
  const up = plain(uploader, 80)
  if (up) return { author: up, authorUrl: `https://commons.wikimedia.org/wiki/User:${encodeURIComponent(up.replace(/ /g, '_'))}` }
  if (text) return { author: `${text.slice(0, 59).trimEnd()}…`, authorUrl: null }
  return { author: 'Wikimedia Commons', authorUrl: null }
}

// A file page title → a readable title ("File:Morning fog in Upper Silesia.jpg" → "Morning fog in Upper Silesia")
export const titleOfFile = (t) => plain(String(t || '').replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' '), 120)

// The credit of a Commons photo: {title, author, authorUrl, license, licenseUrl} — null when it may not be used
export function commonsCredit({ title, extmetadata: meta = {}, user = '' }) {
  const license = metaText(meta, 'LicenseShortName', 60)
  if (!licenseOk(license) || restricted(meta)) return null
  const name = metaText(meta, 'ObjectName', 120) || titleOfFile(title)
  return { title: name, ...commonsAuthor(meta, user), license, licenseUrl: httpsUrl(meta?.LicenseUrl?.value) }
}

// ---------- Unsplash · Pexels ----------
export const UNSPLASH_APP = 'process_gpt_lite'
export const utm = (url) => { const u = httpsUrl(url); if (!u) return null; const x = new URL(u); x.searchParams.set('utm_source', UNSPLASH_APP); x.searchParams.set('utm_medium', 'referral'); return x.href }
export function unsplashCredit(p) {
  return {
    title: plain(p?.description || p?.alt_description, 120) || 'Unsplash',
    author: plain(p?.user?.name, 80) || plain(p?.user?.username, 80) || 'Unsplash',
    authorUrl: utm(p?.user?.links?.html),
    license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license',
  }
}
export function pexelsCredit(p) {
  return {
    title: plain(p?.alt, 120) || 'Pexels',
    author: plain(p?.photographer, 80) || 'Pexels',
    authorUrl: httpsUrl(p?.photographer_url),
    license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/',
  }
}

// The one line the screen shows (title · author · license · source)
export const creditLine = (p) => [p.title, p.author, p.license, p.sourceName].filter(Boolean).join(' · ')
