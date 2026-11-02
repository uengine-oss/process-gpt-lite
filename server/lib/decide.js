// Typed decisions through process-gpt's context-router (POST /decide): a judge model first,
// then a logprob read of the LLM, then plain JSON. Used for short, frequent yes/no-style calls
// (is this page still loading, are we done) that do not deserve a full agent turn.
import { config } from '../config.js'
import { firstTokenTop } from './llm.js'

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
export async function oddsOf(state, question, options, { timeoutMs = 4000 } = {}) {
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
