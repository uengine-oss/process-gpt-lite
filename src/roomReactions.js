// Reactions on a room's messages (2026-11-26 사용자 「다른 사람 말풍선에 좋아요 확인했음 사랑해 웃음 등을 붙힐 수 있게」, 스펙 room-reactions):
// the short fixed set the bar offers and the chips show — the server keeps the same keys (server/lib/team/reactions.js KEYS) — and the
// rules the screen needs without a server. Unit test: server/test/roomReactions.test.js
//   chips: [{key, count, mine, people: [{id, name}]}] (the server's summarize, for one viewer)
export const REACTIONS = [
  { key: 'like', emoji: '👍', label: '좋아요' },
  { key: 'check', emoji: '✅', label: '확인했음' },
  { key: 'love', emoji: '❤️', label: '사랑해' },
  { key: 'laugh', emoji: '😂', label: '웃음' },
  { key: 'wow', emoji: '😮', label: '놀람' },
  { key: 'thanks', emoji: '🙏', label: '감사' },
]
export const reactionOf = (key) => REACTIONS.find((r) => r.key === key) || null

// Whose bubble takes a reaction from me: someone else's — a teammate's message or an agent's — never my own, a room's system line (who
// invited whom, a rename) or a meeting's card (the server says the same: reactions.js refusal)
export function canReact(m) {
  if (!m?.id || m.mine) return false
  const k = String(m.kind || '')
  return k !== 'invite' && k !== 'rename' && !k.startsWith('meeting')
}

// The chips once my reaction is put on (on = true) or taken off (false), before the server answers — the same shape and order as its
// own: the set's order, me last among the people (I reacted last), a chip with nobody left gone.
export function toggled(chips, key, me, on) {
  const meId = String(me?.id || '')
  const by = new Map((chips || []).map((c) => [c.key, { ...c, people: [...(c.people || [])] }]))
  const c = by.get(key) || { key, count: 0, mine: false, people: [] }
  const has = c.people.some((p) => String(p.id) === meId)
  if (on && !has) c.people.push({ id: meId, name: me?.name || '' })
  if (!on && has) c.people = c.people.filter((p) => String(p.id) !== meId)
  c.count = c.people.length
  c.mine = c.people.some((p) => String(p.id) === meId)
  by.set(key, c)
  return REACTIONS.map((r) => by.get(r.key)).filter((x) => x && x.count > 0)
}

// who put a chip on, as the chip's long press / hover says it: 「김서연, 박도윤」 (my own name stays a name: it is who I am to the others too)
export const whoLine = (chip) => (chip?.people || []).map((p) => p.name).filter(Boolean).join(', ')
