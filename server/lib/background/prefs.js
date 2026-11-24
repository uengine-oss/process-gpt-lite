// 오늘의 배경 사진: 한 사람의 선택(pro_profile.background, sql/054). 휴대폰 · 데스크톱 · 웹이 같은 값을 읽는다.
//   { photo: <고른 사진 — 화면이 그릴 주소와 출처>, keep: 'today' | 'always', day: 'YYYY-MM-DD'(고른 날, 그 사람의 날짜), at }
//   - keep 'today'(기본): 그 사람의 날짜가 day 인 동안만. 다음 날이면 하늘로 돌아가고, 새 추천을 본다.
//   - keep 'always': 바꿀 때까지.
//   - 하늘로: 행의 값을 null 로.
// 화면이 보낸 사진은 그대로 믿지 않는다: 사이트 · 주소(그 사이트의 CDN) · 너비 · 라이선스 · 글자 길이를 다시 본다.
import { q } from '../supa.js'
import { L } from '../lang.js'
import { PROVIDERS, SOURCE, imageUrlOk, unsplashDownloadOk } from './providers.js'
import { licenseOk, httpsUrl, plain } from './credit.js'
import { parseDate } from './calendar.js'

export const KEEP = ['today', 'always']

// The photo a saved choice shows on this date (the person's own date), or null for the sky.
export function activePhoto(pref, today) {
  if (!pref?.photo) return null
  if (pref.keep === 'always') return pref.photo
  return pref.day && pref.day === today ? pref.photo : null
}

export class PrefError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}
const bad = () => new PrefError(L('이 사진은 배경으로 쓸 수 없어요. 추천을 다시 불러와 주세요.', "This photo can't be used as a background. Please reload the suggestions."))

// A photo the screen sent back → the clean copy that is saved (throws PrefError when it is not one of ours)
export function cleanPhoto(p) {
  if (!p || typeof p !== 'object') throw bad()
  const provider = String(p.provider || '')
  if (!PROVIDERS.includes(provider)) throw bad()
  const id = String(p.id || '')
  if (!/^(commons|unsplash|pexels):[\w-]{1,80}$/.test(id) || !id.startsWith(`${provider}:`)) throw bad()
  const src = {}
  for (const [w, url] of Object.entries(p.src || {})) {
    const n = Number(w)
    if (!Number.isInteger(n) || n < 200 || n > 8000) throw bad()
    if (!imageUrlOk(provider, url)) throw bad()
    src[n] = String(url)
  }
  if (!Object.keys(src).length || Object.keys(src).length > 6) throw bad()
  if (p.thumb && !imageUrlOk(provider, p.thumb)) throw bad()
  const license = plain(p.license, 60)
  const okLicense = provider === 'commons' ? licenseOk(license) : license === (provider === 'unsplash' ? 'Unsplash License' : 'Pexels License')
  if (!okLicense) throw bad()
  const int = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 100000 ? Number(v) : null)
  const out = {
    id, provider, src, thumb: p.thumb ? String(p.thumb) : null,
    title: plain(p.title, 120), author: plain(p.author, 80) || SOURCE[provider].name, authorUrl: httpsUrl(p.authorUrl),
    license, licenseUrl: httpsUrl(p.licenseUrl), sourceUrl: httpsUrl(p.sourceUrl) || SOURCE[provider].url, sourceName: SOURCE[provider].name,
    label: plain(p.label, 40) || null, color: /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : null,
    width: int(p.width), height: int(p.height),
  }
  if (provider === 'unsplash' && p.downloadLocation && unsplashDownloadOk(p.downloadLocation)) out.downloadLocation = String(p.downloadLocation)
  return out
}

// What is saved for a choice (validated): {photo, keep, day, at}
export function prefOf({ photo, keep = 'today', day }) {
  if (!KEEP.includes(keep)) throw new PrefError(L('「오늘만」 또는 「계속」 가운데 하나를 골라 주세요.', 'Choose "today only" or "keep".'))
  if (!parseDate(day)) throw new PrefError(L('날짜가 필요해요.', 'A date is needed.'))
  return { photo: cleanPhoto(photo), keep, day, at: new Date().toISOString() }
}

const missing = (e) => e?.code === '42703' || e?.code === '42P01'
const needSql = () => new PrefError(L('배경 설정을 저장할 곳이 없어요 — server/sql/054_daily_background.sql 을 먼저 실행해 주세요.', 'There is nowhere to save the background — run server/sql/054_daily_background.sql first.'), 503)

export async function loadPref(userId) {
  const [r] = await q('select background from pro_profile where user_id=$1', [userId]).catch((e) => { if (missing(e)) return []; throw e })
  return r?.background || null
}
export async function savePref(user, pref) {
  try {
    await q('insert into pro_profile(user_id, email) values ($1,$2) on conflict (user_id) do nothing', [user.id, user.email || null])
    await q('update pro_profile set background=$2 where user_id=$1', [user.id, pref])
  } catch (e) { if (missing(e)) throw needSql(); throw e }
  return pref
}
