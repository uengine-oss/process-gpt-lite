// Quick replies: the choices an answer offers, as the server stored them with the message (content.choices
// — the router's question, the agent's own question with its options, a process draft's "go ahead"). Read
// as fields, never off the answer's words: a report's bullet lines are never buttons
// (docs/mobile-review-1121/skill-routing-design.md 5.4). Tapping one sends its label with
// { reply: { messageId, index } } (src/stores/app.js send), and the server acts on the stored choice.
export function choicesOf(msg) {
  const c = msg?.content || {}
  if (msg?.role !== 'agent' || c.stopped || !Array.isArray(c.choices)) return null
  const options = c.choices.map((o, index) => ({ label: String(o?.label || '').trim(), hint: o?.hint || undefined, index })).filter((o) => o.label)
  return options.length ? options : null
}
