// A typed choice among a few options — the meeting assistant (meetings/intent.js), the team assist
// (team/assist.js), an action item's kind of work (meetings/minutes.js) and the browser's purchase gate
// (browser.js) ask it.
//   1. the judge server (context-router's POST /judge: a small model's softmax over the option letters)
//      when one is configured and answers
//   2. otherwise the LLM (the fast model) picks one and says how sure it is
// Production behind the ProcessGPT gateway has no judge server (it needs a GPU), and the old default
// (127.0.0.1:8896) failed every call there: a meeting heard "자료 좀 찾아줄래?" and did nothing, and team
// rooms never got a suggestion (2026-11-18). PRO_JUDGE_URL='' turns the server off; PRO_JUDGE_LLM=0 the LLM.
// The answer has the server's shape: {probabilities: {key: p}, model, ms, via}. `also` asks the LLM for a
// few short fields beside its pick (a card title in the reader's language): {also: {title: 'what it is'}}
// → answer.extra.title. The judge server picks only (extra is {}): callers keep a fallback.
import { config } from '../config.js'
import { chatJson } from './llm.js'

export const JUDGE_URL = process.env.PRO_JUDGE_URL ?? 'http://127.0.0.1:8896/judge'
const SERVER_MS = Number(process.env.PRO_ASSIST_JUDGE_TIMEOUT_MS || 5000)
const LLM_ON = process.env.PRO_JUDGE_LLM !== '0'
const LLM_MS = Number(process.env.PRO_JUDGE_LLM_TIMEOUT_MS || 12000)
// a server that refused or timed out is not asked again for a minute (each call would wait for it)
let downUntil = 0

export const judgeAvailable = () => !!JUDGE_URL || (LLM_ON && !!config.llm?.apiKey)
// the LLM can stand in when the judge server is missing (tests skip the judged steps without either)
export const judgeLlm = () => LLM_ON && !!config.llm?.apiKey

async function viaServer({ state, question, options }) {
  const r = await fetch(JUDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(SERVER_MS),
    body: JSON.stringify({ state, question, options }) })
  if (!r.ok) throw new Error(`judge ${r.status}`)
  return { ...(await r.json()), via: 'server' }
}

// the LLM's pick as probabilities: the chosen key gets its confidence, the rest share what is left
export function spread(options, key, confidence) {
  const keys = options.map((o) => o.key)
  if (!keys.includes(key)) return Object.fromEntries(keys.map((k) => [k, 1 / keys.length]))
  const c = Math.max(0, Math.min(1, Number(confidence) || 0))
  const rest = keys.length > 1 ? (1 - c) / (keys.length - 1) : 0
  return Object.fromEntries(keys.map((k) => [k, k === key ? c : rest]))
}

async function viaLlm({ state, question, options, also }) {
  const list = options.map((o) => `- ${o.key}: ${o.label}`).join('\n')
  const more = also && Object.keys(also).length ? Object.entries(also).map(([k, v]) => `, "${k}": <${v}>`).join('') : ''
  const system = 'You classify one remark for an assistant. Read the situation, then pick exactly one option key. '
    + `Answer JSON only: {"key": "<one option key>", "confidence": <0..1, how sure you are>${more}}. `
    + 'Be strict: pick an option only when the remark clearly is that; when unsure, give a low confidence.'
  const j = await chatJson(system, `${state}\n\nQuestion: ${question}\nOptions:\n${list}`,
    { model: config.llm.fastModel, temperature: 0, timeoutMs: LLM_MS, maxTokens: 2048, effort: 'low' })
  const extra = Object.fromEntries(Object.keys(also || {}).filter((k) => typeof j[k] === 'string' && j[k].trim()).map((k) => [k, j[k].replace(/\s+/g, ' ').trim().slice(0, 120)]))
  return { probabilities: spread(options, String(j.key || ''), j.confidence), model: config.llm.fastModel, via: 'llm', extra }
}

export async function judge({ state, question, options, also }) {
  const t0 = Date.now()
  if (JUDGE_URL && Date.now() > downUntil) {
    try { return { extra: {}, ...(await viaServer({ state, question, options })), ms: Date.now() - t0 } } catch (e) {
      downUntil = Date.now() + 60_000
      if (!LLM_ON) throw e
    }
  }
  if (!LLM_ON) throw new Error('no judge')
  return { ...(await viaLlm({ state, question, options, also })), ms: Date.now() - t0 }
}
