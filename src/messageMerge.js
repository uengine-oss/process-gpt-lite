// A conversation's messages merged with more of them, one per message id (stores/team.js): a newer copy replaces the one
// there (a meeting's card as it changes, an agent's reply updated with its files), a new one goes in by its time (one
// without a time, or as late as the last, at the end) — never twice. 2026-11-24 「나갔다 들어와야 업데이트됨」: what came
// live and what the conversation is asked for again are put together this way. Unit test: server/test/messageMerge.test.js
export function merged(list, more) {
  const out = [...(list || [])]
  for (const m of more || []) {
    if (!m?.id) continue
    const i = out.findIndex((x) => x.id === m.id)
    // (a message's live copy carries no reactions — they come on their own: the ones it had stay — src/roomReactions.js)
    if (i >= 0) { out[i] = m.reactions || !out[i]?.reactions ? m : { ...m, reactions: out[i].reactions }; continue }
    const j = m.at ? out.findIndex((x) => x.at && x.at > m.at) : -1
    if (j < 0) out.push(m)
    else out.splice(j, 0, m)
  }
  return out
}
