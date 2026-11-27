// A messenger request the AI sent for someone (lib/askTeammate.js — chats.messages.pgpt.ask) as one person in the room sees it: the
// asked teammate gets the small form while the request is open; both see the items and, once answered, the values (the room is the
// two of them). Pure — no database (lib/team/messenger.js view imports it; it cannot import askTeammate.js, which imports the messenger).
export const OPEN = ['asked', 'late']

export function askView(viewerId, ask) {
  if (!ask || typeof ask !== 'object') return null
  const me = String(viewerId || '')
  const forMe = String(ask.member || '') === me
  const state = String(ask.state || 'asked')
  const open = OPEN.includes(state)
  const fields = (Array.isArray(ask.fields) ? ask.fields : []).map((f) => ({ key: String(f.key), label: String(f.label || '') }))
  return {
    state, forMe, mine: String(ask.owner || '') === me, fields,
    ownerName: String(ask.ownerName || ''), memberName: String(ask.memberName || ''),
    ...(forMe && open && ask.surface ? { surface: ask.surface } : {}),
    ...(state === 'answered' ? { values: ask.values || {}, answeredAt: ask.answeredAt || null } : {}),
    ...(state === 'unknown' ? { note: String(ask.note || ''), answeredAt: ask.answeredAt || null } : {}),
  }
}
