// The selection in the open IeumOffice document, as the chat carries it (no browser state here: tested in server/test/docSelection.test.js).
// The editor page tells what is selected as it changes (office-host page-live.mjs {type:'selection'}: where it is — `label`, the
// top-level `blockIndex`, in a table the cells' grid `range` as the table ops count it — and the selected `text`); the composer
// shows it as a chip (Composer.vue) that goes with the next message, and the agent edits exactly that place through the live
// editor tools (server lib/craftLive.js liveHint). Removing the chip (✕) or sending it puts that selection away until it changes.

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }

/** the selection as the page told it, kept small and with the file it is in — or null */
export function docSelectionOf(sel, file) {
  if (!sel || typeof sel !== 'object' || !sel.label) return null
  const text = String(sel.text || '').slice(0, 2000)
  if (!text && sel.kind !== 'image') return null
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined)
  const range = sel.range && typeof sel.range === 'object'
    ? { row: n(sel.range.row), col: n(sel.range.col), rowEnd: n(sel.range.rowEnd), colEnd: n(sel.range.colEnd) } : undefined
  return {
    editor: String(sel.editor || ''), kind: String(sel.kind || 'text'), label: String(sel.label).slice(0, 80), text, file: String(file || sel.file || '').slice(0, 200),
    ...(n(sel.blockIndex) != null ? { blockIndex: sel.blockIndex } : {}), ...(n(sel.blockEnd) != null ? { blockEnd: sel.blockEnd } : {}),
    ...(n(sel.table) != null ? { table: sel.table } : {}), ...(range && range.row != null ? { range } : {}), ...(n(sel.image) != null ? { image: sel.image } : {}),
    ...(n(sel.from) != null && n(sel.to) != null ? { from: sel.from, to: sel.to } : {}),
  }
}

/** the same selection (a chip put away stays away until the selection changes) */
export const docSelectionKey = (s) => (s ? JSON.stringify([s.file, s.from, s.to, s.text]) : '')

/** the chip and the mention the next message carries: where it is and the selected words */
export function selectionMention(s) {
  if (!s) return null
  const quote = clip(s.text, 24)
  return { ...s, kind: 'selection', where: s.kind, label: quote ? `${s.label} "${quote}"` : s.label }
}

/** what the agent reads about a mention (stores/app.js send): a selection says what was selected, and where, for the live tools */
export function mentionContext(mentions, en = false) {
  const sel = mentions.filter((m) => m.kind === 'selection')
  const pointed = mentions.filter((m) => m.kind !== 'selection')
  const json = (m) => JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'label')))
  const out = []
  if (pointed.length) out.push(en ? `(What the person pointed at in the open document: ${pointed.map((m) => `@${m.label} = ${JSON.stringify(m)}`).join(' ; ')})` : `(사용자가 열린 문서에서 가리킨 대상: ${pointed.map((m) => `@${m.label} = ${JSON.stringify(m)}`).join(' ; ')})`)
  for (const m of sel) {
    out.push(en
      ? `(The person selected this in the open document '${m.file}' — the request is about exactly this part: @${m.label} = ${json(m)})`
      : `(사용자가 열린 문서 '${m.file}' 에서 골라 둔 부분이에요 — 요청은 바로 이 부분에 대한 것이에요: @${m.label} = ${json(m)})`)
  }
  return out.join('\n')
}

/**
 * The conversation a message about the open document goes to: the one the document's card is in (or the one its first message
 * went to), so the context router does not file it under a new topic. Only for the main chat, and not when the person is
 * already inside a conversation of their choosing. → { id, title } or null
 */
export function docConversation({ doc, threadId, mainId, convOf = {}, convList = [], chosen = null }) {
  if (!doc || doc.readOnly || chosen || !mainId || threadId !== mainId) return null
  const id = doc.conv || (doc.msgId ? convOf[doc.msgId] : null)
  if (!id) return null
  return { id, title: convList.find((c) => c.id === id)?.title || '' }
}
