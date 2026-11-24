// Typed decisions through process-gpt's context-router (POST /decide): a judge model first,
// then a logprob read of the LLM, then plain JSON. Used for short, frequent yes/no-style calls
// (is this page still loading, are we done) that do not deserve a full agent turn.
import { config } from '../config.js'
import { firstTokenTop, chatJson } from './llm.js'

const TIMEOUT_MS = 8000

// options: [{key, label, hint?}] → {choice, confidence, calibrated, strategy, latency_ms} or null
// when no router is configured or it did not answer (callers then simply skip the shortcut).
export async function decide(state, question, options) {
  if (!config.contextRouterUrl) return null
  try {
    const res = await fetch(`${config.contextRouterUrl}/decide`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, question, options }),
    })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

// A decision is acted on only when it is measured (token/judge probabilities) and sure.
export function sure(d, key, min = 0.85) {
  return !!d && d.choice === key && d.calibrated !== false && (d.confidence ?? 0) >= min
}

// ── The reading a policy takes as an input: the agent model's own next-token probabilities, called directly (no router).
// The router's chain asks the judge model first, which was wrong at probability 1.0 on sensitive text (spec pgpt-pro_guardrail-reading),
// and an install has no router by default; this needs only the LLM the server already talks to.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const MIN_MASS = 0.5
const RETRY_DOWN_MS = 30000, RETRY_NO_ODDS_MS = 600000
let unusableUntil = 0
const status = { state: 'unknown', model: null, at: null, reason: null }
export const readingStatus = () => ({ ...status })
function mark(state, model = status.model, reason = null) { Object.assign(status, { state, model, reason, at: new Date().toISOString() }) }

export const optionPrompt = (state, question, options) => [String(state).trim(), '', String(question).trim(), '',
  ...options.map((o, i) => `${LETTERS[i]}) ${o.label}`), '', 'Answer with the single option letter only.'].join('\n')

// first-token candidates → {key: probability}; null when the option letters hold too little of the token to mean anything
export function oddsFromTop(top, options) {
  if (!top?.length) return null
  const keyOf = Object.fromEntries(options.map((o, i) => [LETTERS[i], o.key]))
  const mass = {}
  for (const { token, logprob } of top) {
    const k = keyOf[String(token).trim().toUpperCase()]
    if (k) mass[k] = (mass[k] || 0) + Math.exp(logprob)
  }
  const total = Object.values(mass).reduce((s, v) => s + v, 0)
  if (total < MIN_MASS) return null
  return Object.fromEntries(options.map((o) => [o.key, (mass[o.key] || 0) / total]))
}

// options: [{key, label}] → {choice, probabilities, confidence, strategy: 'logprob', model, latency_ms}, or null when it
// cannot be measured (the model is down, or gives no log-probabilities): the caller then uses its fallback rule, marked as such
// (8 s: gpt-6-luna's median is 0.8 s, but about 3 in 100 reads take over 4 s and a timeout counts as an outage for 30 s)
export async function oddsOf(state, question, options, { timeoutMs = 8000 } = {}) {
  if (Date.now() < unusableUntil) return null
  const t = Date.now()
  try {
    const { model, top } = await firstTokenTop({ prompt: optionPrompt(state, question, options), timeoutMs })
    const probabilities = oddsFromTop(top, options)
    if (!probabilities) {
      unusableUntil = Date.now() + RETRY_NO_ODDS_MS
      mark('no_odds', model, 'the model gives no usable log-probabilities')
      return null
    }
    mark('ok', model)
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
    return { choice, probabilities, confidence: probabilities[choice], strategy: 'logprob', model, latency_ms: Date.now() - t }
  } catch (e) {
    // a refusal of the argument will not change soon; anything else (timeout, gateway down) may
    const refused = /logprob/i.test(e.message) && /LLM 4\d\d/.test(e.message)
    unusableUntil = Date.now() + (refused ? RETRY_NO_ODDS_MS : RETRY_DOWN_MS)
    mark(refused ? 'no_odds' : 'down', status.model, e.message.slice(0, 160))
    console.warn('[decide] reading', e.message.slice(0, 160))
    return null
  }
}

// One choice among options by the first token's probability (oddsOf); a model without log-probabilities answers the same question in
// JSON (answerJson says how). → {choice, probabilities, confidence, strategy: 'logprob'|'json', model} or null when nothing could be read.
// (folder filing — lib/folders/filing.js; what a mail card is for — lib/mailCard.js)
export async function choose(state, question, options, { odds = oddsOf, json = chatJson, answerJson, timeoutMs = 8000 } = {}) {
  const r = await odds(state, question, options, { timeoutMs }).catch(() => null)
  if (r?.probabilities) return { choice: r.choice, probabilities: r.probabilities, confidence: r.confidence, strategy: 'logprob', model: r.model || null }
  try {
    const j = await json(`${question}\n${answerJson || 'JSON {"choice": "<letter>", "confidence": 0-1} only.'}`,
      `${state}\n\n${options.map((o, i) => `${LETTERS[i]}) ${o.label}`).join('\n')}`, { timeoutMs: 30000, temperature: 0 })
    const i = LETTERS.indexOf(String(j?.choice || '').trim().toUpperCase().slice(0, 1))
    if (i < 0 || i >= options.length) return null
    const p = Math.max(0, Math.min(1, Number(j.confidence)))
    const confidence = Number.isFinite(p) ? p : 0.5
    return { choice: options[i].key, probabilities: { [options[i].key]: confidence }, confidence, strategy: 'json', model: null }
  } catch { return null }
}

// A few choices among options: the ones the first token's probability puts at `min` or above, the likeliest first, at most `max` (the
// options of one question are told apart by the same letters as choose). A model without log-probabilities answers in JSON — answerJson
// says how ({"choices": [{"choice": "<letter>", "confidence": 0-1}]}). → {picks: [{key, p}], probabilities, strategy: 'logprob'|'json',
// model} or null when nothing could be read. (a mail's follow-up actions — lib/mailFollow.js)
export async function chooseSome(state, question, options, { odds = oddsOf, json = chatJson, answerJson, timeoutMs = 8000, max = 3, min = 0.15 } = {}) {
  const r = await odds(state, question, options, { timeoutMs }).catch(() => null)
  if (r?.probabilities) {
    const picks = Object.entries(r.probabilities).filter(([, p]) => p >= min).sort((a, b) => b[1] - a[1]).slice(0, max).map(([key, p]) => ({ key, p }))
    return { picks, probabilities: r.probabilities, strategy: 'logprob', model: r.model || null }
  }
  try {
    const j = await json(`${question}\n${answerJson || 'JSON {"choices": [{"choice": "<letter>", "confidence": 0-1}]} only, the best first.'}`,
      `${state}\n\n${options.map((o, i) => `${LETTERS[i]}) ${o.label}`).join('\n')}`, { timeoutMs: 30000, temperature: 0 })
    const list = Array.isArray(j?.choices) ? j.choices : j?.choice ? [j] : null
    if (!list) return null
    const picks = []
    for (const c of list) {
      const i = LETTERS.indexOf(String(c?.choice || '').trim().toUpperCase().slice(0, 1))
      if (i < 0 || i >= options.length || picks.some((x) => x.key === options[i].key)) continue
      const p = Math.max(0, Math.min(1, Number(c.confidence)))
      const conf = Number.isFinite(p) ? p : 0.5
      if (conf >= min) picks.push({ key: options[i].key, p: conf })
    }
    picks.sort((a, b) => b.p - a.p)
    return { picks: picks.slice(0, max), probabilities: Object.fromEntries(picks.map((x) => [x.key, x.p])), strategy: 'json', model: null }
  } catch { return null }
}
