// OpenAI-compatible chat client (works against OpenAI or the LiteLLM proxy).
import fs from 'node:fs'
import { config } from '../config.js'
import { isEn, ENGLISH_NOTE } from './lang.js'

// A model call that never answers would hold its caller forever (the browser worker runs one job
// at a time), so every non-streaming call gives up after a few minutes.
const CALL_TIMEOUT_MS = 180000

// PRO_LLM_TRACE=<file>: append the text of every model request (images dropped), to check what the
// model was shown. Off unless set.
function trace(messages) {
  if (!config.llmTrace) return
  const text = messages.map((m) => ({ role: m.role, content: Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text') : m.content, tool_calls: m.tool_calls }))
  fs.appendFileSync(config.llmTrace, JSON.stringify({ at: new Date().toISOString(), messages: text }) + '\n')
}

// Reasoning models refuse some chat/completions parameters (temperature other than 1, max_tokens,
// tools while reasoning). What a model refused is learned from its 400 and left out from then on.
const quirks = new Map() // model → { noTemperature, completionTokens, noReasoning, noEffort }
function adapt(payload) {
  const q = quirks.get(payload.model) || {}
  const b = { ...payload }
  if (q.noTemperature) delete b.temperature
  if (q.completionTokens && b.max_tokens) { b.max_completion_tokens = b.max_tokens; delete b.max_tokens }
  if (q.noReasoning && b.tools) b.reasoning_effort = 'none'
  if (q.noEffort) delete b.reasoning_effort
  return b
}
function learn(model, status, text) {
  if (status !== 400) return false
  const q = { ...(quirks.get(model) || {}) }
  const before = JSON.stringify(q)
  if (/temperature/.test(text) && /unsupported|not support/i.test(text)) q.noTemperature = true
  if (/max_tokens/.test(text) && /max_completion_tokens/.test(text)) q.completionTokens = true
  if (/reasoning_effort/.test(text) && /tools/i.test(text)) q.noReasoning = true
  // non-reasoning models (gpt-4.1) reject the argument itself
  if (/Unrecognized request argument supplied: reasoning_effort/.test(text)) q.noEffort = true
  quirks.set(model, q)
  return JSON.stringify(q) !== before
}
async function post(payload, signal) {
  for (let tries = 0; ; tries++) {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${config.llm.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(adapt(payload)),
    })
    if (res.ok) return res
    const text = await res.text()
    if (tries < 3 && learn(payload.model, res.status, text)) continue
    throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`)
  }
}

// English mode (lib/lang.js): the prompts are written in Korean and many ask for Korean answers, so
// every call made for an English-mode person carries the English note at the end of its system
// prompt, where it wins over it. Some endpoints take one system message only, at the very start: the
// note joins the first one (or becomes it). Korean mode: the messages go exactly as they are.
export function inLanguageMessages(messages) {
  if (!isEn() || !Array.isArray(messages) || !messages.length) return messages
  const first = messages[0]
  const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '')
  if (first.role === 'system' && text(first.content).includes('LANGUAGE: English')) return messages
  if (first.role !== 'system') return [{ role: 'system', content: ENGLISH_NOTE }, ...messages]
  const content = typeof first.content === 'string' ? `${first.content}\n\n${ENGLISH_NOTE}`
    : Array.isArray(first.content) ? [...first.content, { type: 'text', text: ENGLISH_NOTE }] : ENGLISH_NOTE
  return [{ ...first, content }, ...messages.slice(1)]
}

// timeoutMs: a shorter limit for a call that has a smaller fallback; maxTokens: caps a runaway answer;
// effort: reasoning_effort for models that reason (dropped for those that don't)
export async function chat({ messages, tools, toolChoice, model, json, temperature = 0.4, signal, timeoutMs = CALL_TIMEOUT_MS, maxTokens, effort }) {
  messages = inLanguageMessages(messages)
  trace(messages)
  const res = await post({
    model: model || config.llm.model,
    messages, temperature,
    ...(tools?.length ? { tools, tool_choice: toolChoice || 'auto', parallel_tool_calls: false } : {}),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
  }, signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs))
  const data = await res.json()
  return data.choices[0].message
}

export async function chatJson(system, user, opts = {}) {
  const msg = await chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], json: true, ...opts })
  return JSON.parse(msg.content)
}

// Streams text deltas; resolves with {content, tool_calls}.
export async function chatStream({ messages, tools, model, onDelta, signal }) {
  messages = inLanguageMessages(messages)
  trace(messages)
  const res = await post({
    model: model || config.llm.model, messages, stream: true, temperature: 0.5,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
  }, signal)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', content = ''
  const calls = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      const delta = JSON.parse(payload).choices?.[0]?.delta
      if (!delta) continue
      if (delta.content) { content += delta.content; onDelta?.(delta.content) }
      for (const tc of delta.tool_calls || []) {
        const c = (calls[tc.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } })
        if (tc.id) c.id = tc.id
        if (tc.function?.name) c.function.name += tc.function.name
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments
      }
    }
  }
  return { content, tool_calls: calls.filter(Boolean) }
}
