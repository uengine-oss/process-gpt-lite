// Typed decisions through process-gpt's context-router (POST /decide): a judge model first,
// then a logprob read of the LLM, then plain JSON. Used for short, frequent yes/no-style calls
// (is this page still loading, are we done) that do not deserve a full agent turn.
import { config } from '../config.js'

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
