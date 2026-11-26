// Reactions on a room's messages (2026-11-26 사용자 「다른 사람 말풍선에 좋아요 확인했음 사랑해 웃음 등을 붙힐 수 있게」, 스펙 openspec/specs/room-reactions).
// Process GPT's chat (chats · chat_rooms) has no reactions, so they are rows of their own (sql/062_room_reactions.sql): who put which of a short
// fixed set on which message. A person may put several kinds on one message, each once; asking again takes theirs off.
//   · only on someone else's bubble — a teammate's message or an agent's (the user's words: 「다른 사람 말풍선에」); never on my own message, a
//     room's system line (who invited whom, a rename) or a meeting's card
//   · everyone in the room sees the chips at once (the room's live channel, 'team' · 'reactions'), each with their own 「mine」
//   · quiet: no notification row, no Home card, no push, no unread count — a reaction is not a message
// Pure helpers (no database) are exported for server/test/roomReactions.test.js.
import { config } from '../../config.js'
import { q, pool } from '../supa.js'
import { emit } from '../bus.js'
import { L } from '../lang.js'
import { TeamError } from './access.js'
import { people as resolvePeople } from '../people.js'

const T = () => config.tenantId
// the set, in the order the chips and the bar show it (the screen's emoji and words: src/roomReactions.js)
export const KEYS = ['like', 'check', 'love', 'laugh', 'wow', 'thanks']
export const isKey = (k) => KEYS.includes(String(k || ''))
const MSG = /^[\w.:-]{1,120}$/

// A message's reaction rows → its chips as one viewer sees them: [{key, count, mine, people: [{id, name}]}], in the set's order, the
// people in the order they reacted. rows: [{user_id, reaction, created_at}] · nameOf(id) → the name every screen uses.
export function summarize(rows, viewerId, nameOf = () => '') {
  const by = new Map()
  for (const r of [...(rows || [])].sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))) {
    if (!isKey(r.reaction)) continue
    const list = by.get(r.reaction) || []
    if (!list.some((p) => p.id === String(r.user_id))) list.push({ id: String(r.user_id), name: nameOf(String(r.user_id)) || '' })
    by.set(r.reaction, list)
  }
  return KEYS.filter((k) => by.get(k)?.length).map((k) => {
    const ps = by.get(k)
    return { key: k, count: ps.length, mine: !!viewerId && ps.some((p) => p.id === String(viewerId)), people: ps }
  })
}

// Who may react to a chats row: not its writer (a person's own message), not a system line, not a meeting's card, not a hidden row.
// → null when allowed, else why (for the 400)
export function refusal(row, me) {
  const m = row?.messages || {}
  const g = m.pgpt || {}
  if (m.__hidden === true || m.__hidden === 'true') return 'hidden'
  if (m.role === 'system' || g.kind === 'invite' || g.kind === 'rename') return 'system'
  if (String(g.kind || '').startsWith('meeting')) return 'meeting'
  const agent = m.role === 'assistant' || String(m.email || '').startsWith('agent:')
  if (!agent && ((m.userId && String(m.userId) === String(me.id)) || (m.email && me.email && String(m.email).toLowerCase() === String(me.email).toLowerCase()))) return 'own'
  return null
}

// a few toggles a second are a person; hundreds a minute are not (shares and messages have their own budget — lib/team/access.js)
const LIMIT = 90
const recent = new Map() // userId → [timestamps]
function budget(userId) {
  const now = Date.now()
  const list = (recent.get(userId) || []).filter((t) => now - t < 60000)
  if (list.length >= LIMIT) throw new TeamError(429, L('잠시 뒤에 다시 눌러 주세요.', 'Please try again in a moment.'))
  list.push(now)
  recent.set(userId, list)
}

async function namesFor(ids) {
  const by = await resolvePeople([...new Set(ids.map(String))])
  return (id) => by.get(String(id))?.name || ''
}

// The reactions of a room's messages, for one viewer: Map chats uuid → chips (lib/team/messenger.js messages)
// Whether this database has reactions yet (sql/062): asked once, again every minute while it has not — the room says so with its
// messages, and the screen offers no reactions until then (2026-11-26 운영: 「반응은 곧 쓸 수 있어요.라고 나오고 좋아요 붙힌게 유지되지
// 않는…」 — every tap was put on, refused and taken back off)
let avail = { on: null, at: 0 }
export async function available({ now = Date.now(), query = q } = {}) {
  if (avail.on === true || (avail.on === false && now - avail.at < 60_000)) return avail.on
  const [r] = await query(`select to_regclass('pro_chat_reactions') is not null as on`).catch(() => [{ on: false }])
  avail = { on: !!r?.on, at: now }
  return avail.on
}
export const forgetAvailable = () => { avail = { on: null, at: 0 } }

export async function forMessages(viewerId, roomId, uuids) {
  const ids = (uuids || []).filter((u) => MSG.test(String(u)))
  if (!ids.length) return new Map()
  const rows = await q('select chat_uuid, user_id::text as user_id, reaction, created_at from pro_chat_reactions where tenant_id=$1 and room_id=$2 and chat_uuid = any($3)',
    [T(), roomId, ids]).catch((e) => { if (e.code === '42P01') return []; throw e }) // (a database without 062: no reactions yet)
  if (!rows.length) return new Map()
  const nameOf = await namesFor(rows.map((r) => r.user_id))
  const by = new Map()
  for (const r of rows) (by.get(r.chat_uuid) || by.set(r.chat_uuid, []).get(r.chat_uuid)).push(r)
  return new Map([...by].map(([u, list]) => [u, summarize(list, viewerId, nameOf)]))
}

// Put or take off one reaction of mine. on: true puts it, false takes it off, undefined turns it over (a second tap). The room's people
// hear of the message's chips at once, each with their own 「mine」. → {messageId, threadId, reactions} as I see them.
// memberThread / membersOf come from lib/team/messenger.js (passed in: the two modules would import each other)
export async function react(me, messageId, key, on, { memberThread, membersOf }) {
  if (!isKey(key)) throw new TeamError(400, L('고를 수 없는 반응이에요.', "That reaction isn't one of the choices."))
  if (!MSG.test(String(messageId || ''))) throw new TeamError(404, L('메시지를 찾지 못했어요.', "I couldn't find that message."))
  const [row] = await q('select uuid, id, messages from chats where uuid=$1 and tenant_id=$2', [String(messageId), T()])
  // a message of a room I am not in (or of another company) is "not found", as for every room route
  if (!row || !(await memberThread(me, row.id))) throw new TeamError(404, L('메시지를 찾지 못했어요.', "I couldn't find that message."))
  const why = refusal(row, me)
  if (why) throw new TeamError(400, why === 'own' ? L('내 메시지에는 반응을 붙이지 않아요.', "You can't react to your own message.") : L('이 메시지에는 반응을 붙일 수 없어요.', "You can't react to this message."))
  budget(me.id)
  const c = await pool.connect()
  let rows
  try {
    await c.query('begin')
    // (one person's taps in a row are put in order: the second sees the first's row)
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`rx:${row.uuid}:${me.id}`])
    const { rows: [has] } = await c.query('select 1 from pro_chat_reactions where chat_uuid=$1 and user_id=$2 and reaction=$3', [row.uuid, me.id, key])
    const want = on === undefined || on === null ? !has : !!on
    if (want && !has) await c.query('insert into pro_chat_reactions(tenant_id, room_id, chat_uuid, user_id, reaction) values ($1,$2,$3,$4,$5) on conflict do nothing', [T(), row.id, row.uuid, me.id, key])
    if (!want && has) await c.query('delete from pro_chat_reactions where chat_uuid=$1 and user_id=$2 and reaction=$3', [row.uuid, me.id, key])
    ;({ rows } = await c.query('select user_id::text as user_id, reaction, created_at from pro_chat_reactions where chat_uuid=$1', [row.uuid]))
    await c.query('commit')
  } catch (e) {
    await c.query('rollback').catch(() => {})
    // a database without 062 yet: say so plainly (the screen puts the chip back)
    if (e.code === '42P01') { avail = { on: false, at: Date.now() }; throw Object.assign(new TeamError(503, L('반응은 곧 쓸 수 있어요.', 'Reactions will be available soon.')), { code: 'reactions_off' }) }
    throw e
  } finally { c.release() }
  const members = await membersOf(row.id)
  const nameOf = await namesFor([...rows.map((r) => r.user_id), ...members.map((m) => m.id)])
  // the room's live channel — the same 'team' stream the messages come on; nothing else (no notice, no push, no unread)
  for (const m of members) emit(m.id, 'team', { type: 'reactions', threadId: row.id, messageId: row.uuid, reactions: summarize(rows, m.id, nameOf) })
  return { messageId: row.uuid, threadId: row.id, reactions: summarize(rows, me.id, nameOf) }
}
