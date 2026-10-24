// OpenAI-compatible chat client (works against OpenAI or the LiteLLM proxy).
import fs from 'node:fs'
import { config } from '../config.js'

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

export async function chat({ messages, tools, toolChoice, model, json, temperature = 0.4, signal }) {
  trace(messages)
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${config.llm.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || config.llm.model,
      messages, temperature,
      ...(tools?.length ? { tools, tool_choice: toolChoice || 'auto', parallel_tool_calls: false } : {}),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  return data.choices[0].message
}

export async function chatJson(system, user, opts = {}) {
  const msg = await chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], json: true, ...opts })
  return JSON.parse(msg.content)
}

// Streams text deltas; resolves with {content, tool_calls}.
export async function chatStream({ messages, tools, model, onDelta, signal }) {
  trace(messages)
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${config.llm.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || config.llm.model, messages, stream: true, temperature: 0.5,
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    }),
  })
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`)
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
