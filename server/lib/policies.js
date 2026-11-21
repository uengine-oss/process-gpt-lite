// Safety policy data (decision 1, 2026-11-21 — docs/mobile-review-1121/skill-routing-design.md §9).
// A safety floor's word lists live in policies/<name>.json (per language), never in the code: the
// browser's purchase gate (policies/purchase.json) and the panel apps' sensitivity floor
// (policies/privacy.json). Each floor's final level is the strictest of the policy words, the model's
// proposal and a structural floor that reads no words. These lists are the one stated exception to
// "no word rules in code": they are data and only ever raise a level.
// A company adds words (pro_policy_changes, sql/029); taking a default word out is an administrator's
// explicit act, recorded with who did it — the floor is never lowered any other way.
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './paths.js'

export const POLICY_DIR = () => process.env.PRO_POLICY_DIR || path.join(REPO_ROOT, 'policies')
const files = new Map() // name -> { mtime, data }
export function load(name) {
  const file = path.join(POLICY_DIR(), `${name}.json`)
  let st
  try { st = fs.statSync(file) } catch { throw new Error(`policy ${name}: ${file} is missing`) }
  const was = files.get(name)
  if (was && was.mtime === st.mtimeMs) return was.data
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  files.set(name, { mtime: st.mtimeMs, data })
  return data
}

// ---- matching (format: case, width, spacing, script; never what a word means) ----
const LATIN = /[A-Za-zÀ-ɏ]/
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const squeeze = (s) => s.replace(/\s+/g, '')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const termRe = new Map()
// one policy entry against a normalized text: '=word' is the whole text, a Latin word is a whole
// word ('word*' a word that starts so), anything else (Hangul, Han, kana, Thai) a part of the text
// with the spaces taken out
export function termIn(text, term) {
  const t = norm(term)
  if (!t) return false
  if (t.startsWith('=')) return squeeze(text) === squeeze(t.slice(1))
  if (!LATIN.test(t)) return squeeze(text).includes(squeeze(t))
  let re = termRe.get(t)
  if (!re) {
    const stem = t.endsWith('*')
    const body = esc(stem ? t.slice(0, -1) : t).replace(/ /g, '\\s*')
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}${stem ? '' : '(?![\\p{L}\\p{N}])'}`, 'u')
    termRe.set(t, re)
  }
  return re.test(text)
}
const langs = (byLang) => Object.values(byLang || {}).flat()

// ---- a company's additions and an administrator's removals (cached; no table → defaults only) ----
const overlays = new Map() // tenant -> { at, words: {list: {level: {add:Set, remove:Set}}} }
const OVERLAY_MS = 60_000
let db = null
async function dbq() { if (!db) db = (await import('./supa.js')).q; return db }
export function setDb(fn) { db = fn; overlays.clear() }
export async function refresh(tenant) {
  if (!tenant) return null
  try {
    const q = await dbq()
    const rows = await q('select policy, list, level, add_words, remove_words from pro_policy_changes where tenant_id=$1 order by id', [tenant])
    const words = {}
    for (const r of rows) {
      const slot = ((words[`${r.policy}:${r.list}`] ||= {})[r.level] ||= { add: new Set(), remove: new Set() })
      for (const w of r.add_words || []) { slot.add.add(norm(w)); slot.remove.delete(norm(w)) }
      for (const w of r.remove_words || []) { slot.remove.add(norm(w)); slot.add.delete(norm(w)) }
    }
    overlays.set(tenant, { at: Date.now(), words })
  } catch { overlays.set(tenant, { at: Date.now(), words: {} }) }
  return overlays.get(tenant)
}
function overlayOf(tenant) {
  const o = tenant && overlays.get(tenant)
  if (tenant && (!o || Date.now() - o.at > OVERLAY_MS)) refresh(tenant).catch(() => {})
  return o?.words || {}
}

// the words of one list at one level: the defaults (every language), plus what the company added,
// minus what an administrator took out
export function wordsOf(name, list, level, { tenant } = {}) {
  const base = load(name)[list]?.[level]
  const own = overlayOf(tenant)[`${name}:${list}`]?.[level]
  const out = new Set(langs(base).map(norm))
  for (const w of own?.add || []) out.add(w)
  for (const w of own?.remove || []) out.delete(w)
  return [...out]
}
// the highest level whose words appear in the text (levels in the policy's order), with the word
export function levelByWords(name, list, text, { tenant, levels } = {}) {
  const p = load(name)
  const order = levels || p.levels
  const t = norm(text)
  if (!t) return { level: order[0], word: null }
  for (const level of [...order].reverse()) {
    const word = wordsOf(name, list, level, { tenant }).find((w) => termIn(t, w))
    if (word) return { level, word }
  }
  return { level: order[0], word: null }
}
export const anyWord = (name, list, level, text, opts) => {
  const t = norm(text)
  return !!t && wordsOf(name, list, level, opts).some((w) => termIn(t, w))
}
// the strictest of several levels (unknown values count as the lowest)
export function strictest(name, ...levels) {
  const order = load(name).levels
  return levels.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), order[0])
}

// ---- changing a company's policy (recorded) ----
// add: anyone the route lets in (raising a floor is always allowed). remove: an administrator only,
// and only as that explicit act — the row keeps who and why.
export async function change({ tenant, policy, list = 'words', level, add = [], remove = [], by, admin = false, note = '' }) {
  const p = load(policy)
  if (!p.levels.includes(level)) throw Object.assign(new Error(`unknown level ${level}`), { status: 400 })
  if (remove.length && !admin) throw Object.assign(new Error('only an administrator can take words out of a safety policy'), { status: 403, code: 'POLICY_LOWER_ADMIN_ONLY' })
  if (!by) throw Object.assign(new Error('a policy change names who made it'), { status: 400 })
  const q = await dbq()
  const clean = (xs) => [...new Set(xs.map((w) => String(w || '').trim()).filter(Boolean))].slice(0, 200)
  const [row] = await q(`insert into pro_policy_changes(tenant_id, policy, list, level, add_words, remove_words, by_user, by_admin, note)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`, [tenant, policy, list, level, clean(add), clean(remove), by, !!admin, String(note || '').slice(0, 500)])
  await refresh(tenant)
  return row
}
export async function history(tenant, policy) {
  const q = await dbq()
  return q('select * from pro_policy_changes where tenant_id=$1 and policy=$2 order by id', [tenant, policy]).catch(() => [])
}
