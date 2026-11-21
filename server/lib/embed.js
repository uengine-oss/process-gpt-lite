// Text embeddings (an OpenAI-compatible /embeddings endpoint) for ranking candidates by meaning:
//   - the team assist's and the meeting helper's first gate: a message far from every offer in the
//     catalog (lib/offers.js — skill descriptions) is not judged (decision 2, 2026-11-21)
//   - a shortlist of material names and registered processes before the judge picks one
// Nothing reads words here: the model's vectors and a cosine. When the endpoint is missing or fails
// (the development gateway serves chat only), embed() returns null and the callers go without it.
//   PRO_EMBED_BASE_URL  default PRO_LLM_BASE_URL     PRO_EMBED_API_KEY  default PRO_LLM_API_KEY
//   PRO_EMBED_MODEL     default text-embedding-3-small (production LiteLLM)   PRO_EMBED=0 off
import crypto from 'node:crypto'
import { config } from '../config.js'

const BASE = () => (process.env.PRO_EMBED_BASE_URL || config.llm?.baseUrl || '').replace(/\/$/, '')
const KEY = () => process.env.PRO_EMBED_API_KEY || config.llm?.apiKey || ''
export const MODEL = () => process.env.PRO_EMBED_MODEL || 'text-embedding-3-small'
const TIMEOUT_MS = Number(process.env.PRO_EMBED_TIMEOUT_MS || 6000)
const DOWN_MS = 5 * 60_000
const CAP = 20_000
let downUntil = 0
export const stats = { calls: 0, texts: 0, cached: 0, tokens: 0, errors: 0, ms: [], lastError: null }
const cache = new Map() // model:sha1(text) → Float32Array

export const embedConfigured = () => process.env.PRO_EMBED !== '0' && !!BASE() && !!KEY()
export const embedAvailable = () => embedConfigured() && Date.now() > downUntil
const keyOf = (t) => `${MODEL()}:${crypto.createHash('sha1').update(t).digest('hex')}`
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 2000)

// texts → vectors (same order), or null when embeddings are off or failed
export async function embed(texts) {
  if (!embedAvailable()) return null
  const list = texts.map(clean)
  const missing = [...new Set(list.filter((t) => t && !cache.has(keyOf(t))))]
  stats.cached += list.length - missing.length
  for (let i = 0; i < missing.length; i += 256) {
    const part = missing.slice(i, i + 256)
    const t0 = Date.now()
    try {
      const r = await fetch(`${BASE()}/embeddings`, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL(), input: part }) })
      if (!r.ok) throw new Error(`embeddings ${r.status}: ${(await r.text()).slice(0, 160)}`)
      const j = await r.json()
      stats.calls++; stats.texts += part.length; stats.tokens += j.usage?.total_tokens || 0
      stats.ms.push(Date.now() - t0); if (stats.ms.length > 300) stats.ms.shift()
      for (const d of j.data || []) {
        if (cache.size >= CAP) cache.delete(cache.keys().next().value)
        cache.set(keyOf(part[d.index]), Float32Array.from(d.embedding))
      }
    } catch (e) {
      stats.errors++; stats.lastError = e.message
      downUntil = Date.now() + DOWN_MS
      return null
    }
  }
  return list.map((t) => (t ? cache.get(keyOf(t)) || null : null))
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

// items [{key, text}] by similarity to the query, best first: [{key, sim}] — null without embeddings
export async function rank(query, items, k = items.length) {
  if (!items.length) return []
  const v = await embed([query, ...items.map((x) => x.text)])
  if (!v || !v[0]) return null
  return items.map((x, i) => ({ key: x.key, sim: cosine(v[0], v[i + 1]) })).sort((a, b) => b.sim - a.sim).slice(0, k)
}
// the best similarity between the query and any of the texts (the first gate), or null
export async function nearest(query, texts) {
  const r = await rank(query, texts.map((text, i) => ({ key: i, text })), 1)
  return r ? (r[0]?.sim ?? 0) : null
}
export const _reset = () => { cache.clear(); downUntil = 0 }
