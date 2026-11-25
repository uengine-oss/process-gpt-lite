// A JSON answer that came wrapped in one Markdown fence ("```json\n{…}\n```") → the JSON inside it.
// Claude has no counterpart to response_format json_object (it needs a schema), so depending on the prompt it fences the
// object. Only a reply that is exactly one fenced block whose inside parses as JSON is unwrapped; anything else
// (prose around it, another language tag, a broken inside) comes back as null and the caller keeps the text as it was.
export function unfenceJson(text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (t.length < 6 || !t.startsWith('```') || !t.endsWith('```')) return null
  const inner = t.slice(3, -3)
  const nl = inner.indexOf('\n')
  if (nl < 0) return null
  const tag = inner.slice(0, nl).trim().toLowerCase()
  if (tag !== '' && tag !== 'json') return null
  const body = inner.slice(nl + 1).trim()
  try { JSON.parse(body) } catch { return null }
  return body
}
