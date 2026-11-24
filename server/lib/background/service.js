// 오늘의 배경 사진 — 그날의 후보, 회사 스위치, 회사의 사진 사이트 키.
//   후보: 그날(calendar.js) → 주제의 차례(themes.js, 표는 스킬 daily-background) → 주제마다 사진 사이트에 묻기(providers.js) →
//   쓸 수 있는 사진 가운데 날짜로 정한 차례의 한 장. 하늘은 화면이 첫 칸에 늘 둔다(여기서는 사진만).
//   사이트의 답은 회사 + 날짜 + 물은 말마다 메모리에 하루 둔다(LRU, 실패는 10분). 같은 회사의 같은 날에는 사이트에 다시 묻지 않는다.
//   Lite 서버는 파드 하나라 이것으로 충분하고, 데이터베이스에는 남기지 않는다.
//   회사 스위치: pro_background_settings(sql/054), 행이 없으면 켬. 끄면 아무 사이트에도 묻지 않고 후보도 없다.
//   키: 회사 관리자가 넣은 Unsplash · Pexels 키는 보관함(lib/vault.js)에 회사 몫으로 암호화해 두고, 화면에는 「저장됨」만 보인다.
import { config } from '../../config.js'
import { L } from '../lang.js'
import { skillPack, readSkillDir, bundledDir } from '../skillPack.js'
import { dayOf } from './calendar.js'
import { planDay, seedOf, MOODS } from './themes.js'
import {
  getJson, commonsSearchUrl, commonsPotdUrl, parseCommons, unsplashSearchUrl, unsplashHeaders, parseUnsplash,
  pexelsSearchUrl, pexelsHeaders, parsePexels, unsplashDownloadOk, ProviderError,
} from './providers.js'

export const LIMITS = { ttlMs: 26 * 3600_000, negTtlMs: 10 * 60_000, cacheMax: 3000, settingsTtlMs: 30_000, keysTtlMs: 30_000, deadlineMs: 9000 }

// the theme table: the company's own skill folder or installed skill first, else the bundled one
export async function rulesFor() {
  try { return (await skillPack('daily-background')).rules } catch { return readSkillDir(bundledDir('daily-background'))?.rules || {} }
}

// ---------- the cache ----------
const cache = new Map() // key -> {at, ttl, value}; Map order = LRU
const pending = new Map()
function cacheGet(key, now) {
  const e = cache.get(key)
  if (!e) return undefined
  cache.delete(key)
  if (now - e.at > e.ttl) return undefined
  cache.set(key, e)
  return e.value
}
function cacheSet(key, value, ttl, now) {
  cache.delete(key)
  cache.set(key, { at: now, ttl, value })
  while (cache.size > LIMITS.cacheMax) cache.delete(cache.keys().next().value)
}
export const cacheSize = () => cache.size
// one answer per company · date · question: asked once even when several people ask at the same moment
async function remembered(key, o, fn) {
  const hit = cacheGet(key, o.now())
  if (hit !== undefined) return hit
  if (pending.has(key)) return pending.get(key)
  const p = fn().then((v) => { cacheSet(key, v, LIMITS.ttlMs, o.now()); return v }, (e) => {
    if (!(e instanceof ProviderError) && e?.name !== 'TimeoutError' && e?.name !== 'AbortError') console.warn('[background]', e.message)
    cacheSet(key, [], LIMITS.negTtlMs, o.now())
    return []
  }).finally(() => pending.delete(key))
  pending.set(key, p)
  return p
}

// ---------- asking the sites ----------
async function commonsPhotos(t, ctx) {
  const c = ctx.rules.commons || {}
  const opts = { minWidth: c.minWidth || 1600, ratio: c.ratio || [1.3, 2.6] }
  const limit = c.limit || 30
  const ask = (q, cats = t.cats, offset = 0) => remembered(`${ctx.tenant}\n${ctx.date}\ncommons\n${q}\n${cats.join('|')}\n${offset}`, ctx.o,
    async () => parseCommons(await ctx.o.getJson(commonsSearchUrl({ q, cats, limit, offset, prefix: c.categoryPrefix }), {}), opts))
  const more = (list, extra) => [...list, ...extra.filter((p) => !list.some((x) => x.id === p.id))]
  // "a striking landscape": a page of the Featured pictures chosen by the date (the first page when that one is empty)
  if (t.random) {
    const page = seedOf(`${ctx.date}|${t.key}`) % Math.max(1, c.randomPages || 12)
    const list = page ? await ask(t.q, t.cats, page * limit) : []
    return list.length ? list : ask(t.q)
  }
  let list = await ask(t.q)
  // too few with the words: the same words over the broad landscape categories, then the theme's categories alone
  // (the words narrow the Featured pictures down; the categories keep them on the theme)
  const broad = c.broadCats || ['landscapes', 'forests', 'mountains', 'lakes']
  if (t.q && list.length < 3 && broad.join('|') !== t.cats.join('|')) list = more(list, await ask(t.q, broad))
  if (t.q && list.length < 3) list = more(list, await ask(''))
  return list
}
async function keyedPhotos(provider, t, ctx) {
  const key = ctx.keys[provider]
  if (!key) return []
  const url = provider === 'unsplash' ? unsplashSearchUrl({ keywords: t.keywords }) : pexelsSearchUrl({ keywords: t.keywords })
  const headers = provider === 'unsplash' ? unsplashHeaders(key) : pexelsHeaders(key)
  return remembered(`${ctx.tenant}\n${ctx.date}\n${provider}\n${t.keywords}`, ctx.o,
    async () => (provider === 'unsplash' ? parseUnsplash : parsePexels)(await ctx.o.getJson(url, { headers }), {}))
}
// the day's picture (Wikimedia Commons POTD): today's, else the most recent of the days before that is wide enough
async function potd(ctx) {
  const c = ctx.rules.commons || {}
  const back = Math.max(0, Math.min(7, c.potdLookback ?? 3))
  for (let i = 0; i <= back; i++) {
    const d = addDays(ctx.date, -i)
    const list = await remembered(`${ctx.tenant}\n${ctx.date}\npotd\n${d}`, ctx.o,
      async () => parseCommons(await ctx.o.getJson(commonsPotdUrl(d), {}), { minWidth: c.minWidth || 1600, ratio: c.potdRatio || [1.25, 3.6] }))
    if (list.length) return { photo: list[0], today: i === 0 }
  }
  return null
}
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10) }

// which site a theme asks: Commons, or — when the company has a key — every other themed slot goes to Unsplash · Pexels
function providerFor(t, i, keys) {
  if (t.kind === 'potd' || t.kind === 'landscape') return 'commons'
  const keyed = ['unsplash', 'pexels'].filter((p) => keys[p])
  if (!keyed.length || i % 2 === 0) return 'commons'
  return keyed[Math.floor(i / 2) % keyed.length]
}

// The day's candidates for one person's moment: {day, photos: [{…photo, label, theme, moods}]} — 6 to 10 photos when the sites answer.
// date: the person's date ('YYYY-MM-DD'); hour · alt (the sun's altitude) · wx (WMO code): their moment and weather; mood: calm|warm|cool|lively
export async function candidatesFor({ tenant = config.tenantId, date, hour = 12, alt = null, wx = null, mood = null, en = false }, deps = {}) {
  const o = { now: Date.now, getJson, keys: providerKeys, rules: rulesFor, ...deps }
  const rules = typeof o.rules === 'function' ? await o.rules() : o.rules
  const day = dayOf({ date, hour, alt, wx })
  const keys = await Promise.resolve(o.keys(tenant)).catch(() => ({}))
  const ctx = { tenant: String(tenant), date, rules, keys: keys || {}, o }
  const themes = planDay(day, rules, { mood: MOODS.includes(mood) ? mood : null, en })
  const counts = { min: 6, max: 10, ...(rules.counts || {}) }
  // every theme's photos at once, within a deadline (a slow site leaves its themes out of this answer, not the others)
  const deadline = new Promise((ok) => setTimeout(() => ok(null), LIMITS.deadlineMs).unref?.())
  const lists = await Promise.all(themes.map(async (t, i) => {
    const work = (async () => {
      if (t.kind === 'potd') return potd(ctx)
      const provider = providerFor(t, i, ctx.keys)
      let list = provider === 'commons' ? [] : await keyedPhotos(provider, t, ctx)
      if (!list.length) list = await commonsPhotos(t, ctx)
      return list
    })()
    return Promise.race([work, deadline]).catch(() => null)
  }))
  const used = new Set()
  const photos = []
  const take = (t, list, n = 0) => {
    const free = (list || []).filter((p) => !used.has(p.id))
    if (!free.length) return false
    const p = t.random ? free[0] : free[(seedOf(`${date}|${t.key}`) + n) % free.length]
    used.add(p.id)
    photos.push({ ...p, label: t.label, theme: t.kind, moods: t.moods || [] })
    return true
  }
  themes.forEach((t, i) => {
    const r = lists[i]
    if (t.kind === 'potd') { if (r?.photo && !used.has(r.photo.id)) { used.add(r.photo.id); photos.push({ ...r.photo, label: r.today ? t.label : t.olderLabel || t.label, theme: 'potd', moods: [] }) } return }
    take(t, r)
  })
  // fewer than the minimum: a second photo from the day's own themes (term, part of day, season), before the extras at the end
  for (let round = 1; photos.length < counts.min && round <= 2; round++) {
    themes.forEach((t, i) => { if (photos.length < counts.min && ['term', 'part', 'season', 'mood', 'weather'].includes(t.kind)) take(t, lists[i], round) })
  }
  return { day, photos: photos.slice(0, counts.max) }
}

// ---------- the company switch ----------
const settings = new Map() // tenant -> {at, on}
const settingsGen = new Map() // tenant -> n: a read begun before a change does not put the old value back
export async function enabledFor(tenant = config.tenantId) {
  const k = String(tenant)
  const hit = settings.get(k)
  if (hit && Date.now() - hit.at < LIMITS.settingsTtlMs) return hit.on
  const gen = settingsGen.get(k) || 0
  const { q } = await import('../supa.js')
  const [r] = await q('select enabled from pro_background_settings where tenant_id=$1', [k]).catch(() => [])
  const on = r ? r.enabled !== false : true
  if (gen === (settingsGen.get(k) || 0)) settings.set(k, { at: Date.now(), on })
  return on
}
export async function setEnabled(tenant, on, by) {
  const { q } = await import('../supa.js')
  try {
    await q(`insert into pro_background_settings (tenant_id, enabled, updated_by, updated_at) values ($1,$2,$3,now())
             on conflict (tenant_id) do update set enabled=excluded.enabled, updated_by=excluded.updated_by, updated_at=now()`, [String(tenant), !!on, by || null])
  } catch (e) {
    if (e.code === '42P01') throw Object.assign(new Error(L('배경 사진 설정 테이블이 없어요 — server/sql/054_daily_background.sql 을 먼저 실행해 주세요.', 'The background photo settings table is missing — run server/sql/054_daily_background.sql first.')), { status: 503 })
    throw e
  }
  settings.delete(String(tenant))
  settingsGen.set(String(tenant), (settingsGen.get(String(tenant)) || 0) + 1)
  if (!on) for (const k of [...cache.keys()]) if (k.startsWith(`${tenant}\n`)) cache.delete(k)
  return { enabled: !!on }
}

// ---------- the company's keys for Unsplash · Pexels (the vault, a company subject — never sent to a screen) ----------
const KIND = 'apikey'
const SITE = { unsplash: 'unsplash.com', pexels: 'pexels.com' }
export const KEYED = Object.keys(SITE)
const keyCache = new Map() // tenant -> {at, value}
export async function providerKeys(tenant = config.tenantId) {
  const hit = keyCache.get(String(tenant))
  if (hit && Date.now() - hit.at < LIMITS.keysTtlMs) return hit.value
  const { getSecret } = await import('../vault.js')
  const { companySubject } = await import('../googleClient.js')
  const value = {}
  for (const p of KEYED) value[p] = (await getSecret(companySubject(tenant), KIND, SITE[p]).catch(() => null))?.key || null
  keyCache.set(String(tenant), { at: Date.now(), value })
  return value
}
// what the admin screen sees: whether each key is saved and when — never the key
export async function keyInfo(tenant = config.tenantId) {
  const { candidates } = await import('../vault.js')
  const { companySubject } = await import('../googleClient.js')
  const out = {}
  for (const p of KEYED) {
    const [row] = await candidates(companySubject(tenant), KIND, SITE[p]).catch(() => [])
    out[p] = { saved: !!row }
  }
  return out
}
export async function saveKey(tenant, provider, key, by) {
  if (!KEYED.includes(provider)) throw Object.assign(new Error(L('Unsplash 또는 Pexels 키만 넣을 수 있어요.', 'Only an Unsplash or Pexels key can be saved.')), { status: 400 })
  const v = String(key ?? '').trim()
  const { putItem, candidates, deleteItem } = await import('../vault.js')
  const { companySubject } = await import('../googleClient.js')
  const subject = companySubject(tenant)
  if (!v) {
    for (const row of await candidates(subject, KIND, SITE[provider])) await deleteItem(subject, row.id, { actor: 'admin', detail: { tenant: String(tenant), by } })
  } else {
    if (v.length > 200 || /\s/.test(v)) throw Object.assign(new Error(L('키를 확인해 주세요.', 'Please check the key.')), { status: 400 })
    await putItem(subject, KIND, SITE[provider], { key: v, saved_at: new Date().toISOString() }, { actor: 'admin', detail: { tenant: String(tenant), by } })
  }
  keyCache.delete(String(tenant))
  // photos found with the old key (or none) are asked again
  for (const k of [...cache.keys()]) if (k.startsWith(`${tenant}\n`) && k.includes(`\n${provider}\n`)) cache.delete(k)
  return keyInfo(tenant)
}

// Unsplash asks for its download endpoint to be called when a photo is used (here: set as someone's background)
export async function pingDownload(tenant, photo, deps = {}) {
  if (photo?.provider !== 'unsplash' || !photo.downloadLocation || !unsplashDownloadOk(photo.downloadLocation)) return false
  const o = { getJson, keys: providerKeys, ...deps }
  const key = (await o.keys(tenant).catch(() => ({})))?.unsplash
  if (!key) return false
  await o.getJson(photo.downloadLocation, { headers: unsplashHeaders(key) }).catch(() => null)
  return true
}

// (tests)
export function _reset() { cache.clear(); pending.clear(); settings.clear(); keyCache.clear() }
