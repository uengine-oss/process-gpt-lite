// Who a person is on the screens — one answer for every place that shows someone (2026-11-25, production: in a room with two
// colleagues the user's own agent's result had a circle with the first letter of their address, the header listed the address's
// local part, while the rest of Lite called them by name, 「…님의 에이전트가 …」 — 「일관성있는 컴포넌트 사용이 되어야」; the names in
// this file and its tests are made up). Two rules had grown apart: the signed-in person's name came from
// Lite's profile, the messenger's from Process GPT's users.username, which there held the e-mail's local part.
//   people(ids) → Map id → {id, email, name, picture} of this request's tenant (cached briefly), person(id), namesOf(ids), everyone()
//   displayName({...}) the name rule, personFrom(row) one row → a person — both without a database (server/test/people.test.js)
// The name, first that is a name: Lite's profile (pro_profile.name, what the person typed in Lite) → Process GPT's users.username →
// the auth record's user_metadata name / full_name (a Google sign-in's own name) → the e-mail's local part. A value that is only the
// e-mail's local part (or an address) is not a name: Process GPT and Lite's own e-mail sign-in both write one before anyone types a
// name. The picture: the rule of profile pictures (routes/profilePicture.js) — users.profile, else the Google account's picture.
// Read only: nothing here writes Process GPT's users table.
import { config } from '../config.js'
import { q } from './supa.js'
import { googlePictureOf, parseAvatarHosts, resolvePicture } from './profilePicture.js'

// what the picture checks need (this install's storage, the avatar hosts) — the routes' too
let hosts = null
export function pictureOpts() {
  if (!hosts || hosts.spec !== config.avatarHosts) hosts = { spec: config.avatarHosts, list: parseAvatarHosts(config.avatarHosts) }
  return { supabaseUrl: config.supabaseUrl, avatarHosts: hosts.list }
}

export const localPart = (email) => String(email || '').split('@')[0].trim()
const text = (s) => (typeof s === 'string' ? s.trim() : '')

// The name a person goes by. A candidate counts only when it is more than the e-mail's local part (any case) or an address.
export function displayName({ profileName, username, email, metaName, metaFullName } = {}) {
  const local = localPart(email).toLowerCase()
  const isName = (s) => !!s && !s.includes('@') && s.toLowerCase() !== local
  for (const c of [profileName, username, metaName, metaFullName].map(text)) if (isName(c)) return c
  return localPart(email) || [profileName, username, metaName, metaFullName].map(text).find(Boolean) || ''
}

// one row of the query below → {id, email, name, picture}
export function personFrom(r, opts = {}) {
  const google = googlePictureOf({ identities: r.google ? [{ provider: 'google', identity_data: r.google }] : [], app_metadata: { google_picture: r.app_google || null } }, opts)
  return {
    id: String(r.id), email: r.email || null,
    name: displayName({ profileName: r.profile_name, username: r.username, email: r.email, metaName: r.meta_name, metaFullName: r.meta_full_name }),
    picture: resolvePicture(r.profile, google, opts),
  }
}

// The rows: Process GPT's users row of the tenant, Lite's profile, and the auth server's record (user_metadata names, the Google
// identity, Lite's own Google sign-in's picture). A database whose auth schema this server may not read still answers, without those.
const FULL = (where) => `select u.id::text as id, u.email, u.username, u.profile, p.name as profile_name,
    a.raw_user_meta_data->>'name' as meta_name, a.raw_user_meta_data->>'full_name' as meta_full_name,
    a.raw_app_meta_data->>'google_picture' as app_google, g.identity_data as google
  from users u
  left join pro_profile p on p.user_id = u.id
  left join auth.users a on a.id = u.id
  left join lateral (select i.identity_data from auth.identities i where i.user_id = u.id and i.provider = 'google'
                     order by i.last_sign_in_at desc nulls last limit 1) g on true
  where ${where}`
const LITE = (where) => `select u.id::text as id, u.email, u.username, u.profile, p.name as profile_name
  from users u left join pro_profile p on p.user_id = u.id where ${where}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A resolver over a query function (tests give their own); the app's is below.
export function makeResolver({ query = q, ttl = 30_000, now = () => Date.now(), tenant = () => config.tenantId, opts = pictureOpts } = {}) {
  const cache = new Map() // tenant|id → {at, person|null}
  let full = true          // the auth schema answered (false after it refused once)
  async function rows(where, params) {
    if (full) {
      try { return await query(FULL(where), params) } catch (e) {
        if (!/permission denied|does not exist/i.test(String(e?.message))) throw e
        full = false
        console.warn('[people] auth schema not readable, names and pictures without it:', e.message)
      }
    }
    return query(LITE(where), params)
  }
  async function people(ids) {
    const t = tenant()
    const want = [...new Set((ids || []).map((x) => String(x || '')).filter((x) => UUID.test(x)))]
    const out = new Map()
    const miss = []
    for (const id of want) {
      const hit = cache.get(`${t}|${id}`)
      if (hit && now() - hit.at < ttl) { if (hit.person) out.set(id, hit.person) } else miss.push(id)
    }
    if (miss.length) {
      const o = opts()
      const found = new Map((await rows('u.tenant_id = $1 and u.id = any($2::uuid[])', [t, miss])).map((r) => [String(r.id), personFrom(r, o)]))
      for (const id of miss) {
        const p = found.get(id) || null
        cache.set(`${t}|${id}`, { at: now(), person: p })
        if (p) out.set(id, p)
      }
      if (cache.size > 5000) for (const k of [...cache.keys()].slice(0, cache.size - 4000)) cache.delete(k)
    }
    return out
  }
  // everyone of the tenant who is a person (not its agents), for the screens' own lookup (GET /api/people, asked once a minute
  // at most by each page): always read — what Process GPT changed shows at once — and it refreshes the cache above
  async function everyone() {
    const t = tenant()
    const o = opts()
    const list = (await rows('u.tenant_id = $1 and not coalesce(u.is_agent, false) limit 2000', [t])).map((r) => personFrom(r, o))
    for (const p of list) cache.set(`${t}|${p.id}`, { at: now(), person: p })
    return list
  }
  // a name or a picture changed (Lite's profile, the picture routes): asked again next time
  function forget(id) {
    const s = String(id || '')
    for (const k of [...cache.keys()]) if (k.endsWith(`|${s}`)) cache.delete(k)
  }
  return { people, everyone, forget }
}

const R = makeResolver()
export const people = (ids) => R.people(ids)
export const everyone = () => R.everyone()
export const forget = (id) => R.forget(id)
export async function person(id) { return (await R.people([id])).get(String(id || '')) || null }
// {id: name} for the ids found
export async function namesOf(ids) { return Object.fromEntries([...(await R.people(ids))].map(([id, p]) => [id, p.name])) }
// a list of rows with an id → the same rows with the resolved name (rows nobody resolves keep theirs, else the address's local part)
export async function named(rows, { id = 'id', name = 'name' } = {}) {
  const by = await R.people(rows.map((r) => r?.[id]))
  return rows.map((r) => ({ ...r, [name]: by.get(String(r?.[id] || ''))?.name || r?.[name] || localPart(r?.email) || null }))
}

// The signed-in person, on every request (index.js auth, the MCP servers): one query for their profile name, their saved
// language and Process GPT's username in this tenant — the same name rule as everyone else's.
export async function signedIn(authUser, tenantId = config.tenantId) {
  // (to_jsonb(p)->>'lang': still answers on a database the lang migration, sql/019, has not reached)
  const [p] = await q(`select p.user_id is not null as has, p.name, to_jsonb(p)->>'lang' as lang,
                         (select u.username from users u where u.id = $1 and u.tenant_id = $2) as username
                       from (select 1) one left join pro_profile p on p.user_id = $1`, [authUser.id, tenantId])
  const md = authUser.user_metadata || {}
  return {
    name: displayName({ profileName: p?.name, username: p?.username, email: authUser.email, metaName: md.name, metaFullName: md.full_name }),
    lang: p?.lang || null, hasProfile: !!p?.has,
  }
}
