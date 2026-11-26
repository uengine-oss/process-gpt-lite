// Plans in a team room's conversation (spec openspec/specs/agenda-reminders 「대화방에서 정한 약속」):
//   mark     — a person wrote in a room (lib/team/messenger.js post — this server — and the room feed's rows from anywhere: watch). The room is
//              read once it has been quiet for rules.quietMs (one reading for a burst of messages, not one per message).
//   readRoom — the room's messages after where it was read last (pro_agenda_rooms.read_upto), with a few before them as context and the
//              room's plans still ahead: the gate (most conversations end there), then the reading, then the ops made rows
//              (lib/agenda/read.js · store.js). Where it was read moves on only after the reading — a model that could not be read is
//              asked again with the next message (three failures in a row: moved on anyway).
//              Two servers never read the same messages: the room is taken for a while (reader · reading_at) in one statement first.
//              A room whose 「AI 제안」 is off is not read (its place moves to now — turning it on later does not read the past), nor a room of
//              fewer than two people. One room asks the model at most rules.roomHourly times an hour; the rest is read together later.
//              Anything unexpected counts as a failure, so three in a row move past those messages too.
// The model sees the people as names with short keys (M1 …); the people a plan is for are only ever this room's (read.js checkOps).
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { withTenant } from '../tenant.js'
import * as R from './read.js'
import * as S from './store.js'

const T = () => config.tenantId
const ME = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`
const LEASE = `interval '3 minutes'`
const on = () => process.env.PRO_AGENDA_ROOMS !== '0'
const timers = new Map()
export const stats = { marked: 0, read: 0, gated: 0, made: 0, failed: 0, busy: 0, off: 0 }

const ROLE_SKIP = new Set(['assist', 'invite', 'rename'])
// a person's own message (not an agent's, a system line, a suggestion card or a hidden row)
export const personRow = (row, humans) => {
  const m = row?.messages || {}
  if (m.role !== 'user' || m.__hidden === true || m.__hidden === 'true' || ROLE_SKIP.has(m.pgpt?.kind)) return null
  return humans.find((h) => String(h.id) === String(m.userId) || (h.email && h.email === m.email)) || null
}

export async function mark(roomId, { delayMs = null } = {}) {
  if (!on() || !roomId) return
  const sk = await R.agendaSkill().catch(() => null)
  if (!sk?.rules.rooms) return
  const tenant = T()
  const key = `${tenant}:${roomId}`
  stats.marked++
  clearTimeout(timers.get(key))
  const ms = delayMs ?? (Number(process.env.PRO_AGENDA_QUIET_MS) || sk.rules.quietMs || 90_000)
  const timer = setTimeout(() => {
    timers.delete(key)
    withTenant(tenant, () => readRoom(roomId)).catch((e) => { stats.failed++; console.warn('[agenda] room', e.message) })
  }, ms)
  // (a waiting reading does not keep a process alive — a script or a test that posted a message ends when it is done)
  timer.unref?.()
  timers.set(key, timer)
}

// every row the room feed hears (written anywhere — Process GPT's screens too): a person's message marks its room
export function watch() {
  if (watch.on) return
  watch.on = true
  // (a room of fewer than two people — Process GPT's person-and-agent rooms — is not a team conversation: review #9)
  import('../team/messenger.js').then((M) => M.onChat((row, humans) => { if (humans.length >= 2 && personRow(row, humans)) mark(row.id) }))
}

// deps (tests): {now, decide, json}
// The room's place (pro_agenda_rooms): read_upto — the newest message time read; seen — the messages read lately. Message times are the
// writer's clock (chats has no order of its own), so each reading looks back OVERLAP before read_upto too and leaves out what it has seen
// (review #4: a message from a clock running behind fell before the place and was never read).
const OVERLAP = `interval '10 minutes'`
const SEEN_MAX = 500
const readings = new Map() // tenant:room → the times (ms) this server asked the model about the room in the last hour (review #9)
const humansOf = (participants) => (Array.isArray(participants) ? participants : []).filter((p) => p && !p.is_agent && /^[0-9a-f-]{36}$/i.test(String(p.id || '')))
export async function readRoom(roomId, deps = {}) {
  const now = deps.now || new Date()
  const sk = await R.agendaSkill()
  const [room] = await q('select id, tenant_id, name, participants, context from chat_rooms where id=$1 and tenant_id=$2', [roomId, T()])
  if (!room) return { skipped: 'no_room' }
  await q(`insert into pro_agenda_rooms (room_id, tenant_id, read_upto) values ($1, $2, now() - interval '10 minutes') on conflict (room_id) do nothing`, [roomId, T()])
  const [claim] = await q(`update pro_agenda_rooms set reader=$2, reading_at=now() where room_id=$1 and tenant_id=$3 and (reader is null or reading_at < now() - ${LEASE})
                           returning read_upto, fails, seen`, [roomId, ME, T()])
  if (!claim) { stats.busy++; mark(roomId); return { skipped: 'busy' } }
  // upto: a time, 'now' (the database's), or null (stays); seen: the messages read up to it; failed: one more failure; keep: the failures as they are
  const done = async (upto, last, { failed = false, seen = null, keep = false } = {}) => {
    await q(`update pro_agenda_rooms set read_upto = greatest(read_upto, case when $6 then now() else coalesce($3::timestamptz, read_upto) end), reader=null, reading_at=null,
             fails = case when $7 then fails when $4 then fails + 1 else 0 end, last_read = coalesce($5::jsonb, last_read), seen = coalesce($8::text[], seen), updated_at = now()
             where room_id=$1 and reader=$2`,
    [roomId, ME, upto === 'now' ? null : upto, failed, last ? JSON.stringify(last) : null, upto === 'now', keep, seen])
  }
  let rows = [], newest = null
  const seenWith = (list) => [...(claim.seen || []), ...list.map((r) => r.uuid)].slice(-SEEN_MAX)
  try {
    // a person-to-agent room of Process GPT (fewer than two people) is not a team conversation (review #9)
    if (humansOf(room.participants).length < 2) { await done('now', { at: now, notTeam: true }); return { skipped: 'not_team_room' } }
    rows = await q(`select uuid, messages, public.pro_chat_ts(messages) as ts from chats where id=$1 and coalesce(messages->>'__hidden','false') <> 'true'
                    and public.pro_chat_ts(messages) > $2::timestamptz - ${OVERLAP} and not (uuid = any($4::text[]))
                    order by public.pro_chat_ts(messages) asc limit $3`, [roomId, claim.read_upto, sk.rules.newMessages || 30, claim.seen || []])
    newest = rows.reduce((t, r) => (r.ts && (!t || r.ts > t) ? r.ts : t), null)
    // the room's 「AI 제안」 off: nothing in it is read, and its place moves to now (decision D-AG-03)
    if (room.context?.pgpt?.assist === false) { stats.off++; await done('now', { at: now, off: true }, { seen: seenWith(rows) }); return { skipped: 'room_off' } }
    const members = await (await import('../team/messenger.js')).membersOf(roomId)
    const humans = members.map((m) => ({ id: m.id, email: m.email }))
    const fresh = rows.filter((r) => personRow(r, humans))
    if (!fresh.length) { await done(newest, null, { seen: seenWith(rows) }); return { skipped: 'nothing_new' } }
    // one room asks the model at most rules.roomHourly times an hour: the rest waits and is read together later (review #9)
    const key = `${T()}:${roomId}`
    const hour = (readings.get(key) || []).filter((t) => Date.now() - t < 3600_000)
    readings.set(key, hour)
    if (hour.length >= (sk.rules.roomHourly || 6)) {
      await done(null, { at: now, rate: true }, { keep: true })
      mark(roomId, { delayMs: Math.max(60_000, hour[0] + 3600_000 - Date.now()) })
      return { skipped: 'room_rate' }
    }
    const freshIds = new Set(fresh.map((r) => r.uuid))
    const before = (await q(`select uuid, messages, public.pro_chat_ts(messages) as ts from chats where id=$1 and coalesce(messages->>'__hidden','false') <> 'true'
                             and (public.pro_chat_ts(messages) <= $2 or uuid = any($4::text[])) order by public.pro_chat_ts(messages) desc limit $3`,
    [roomId, claim.read_upto, (sk.rules.contextMessages || 8) + fresh.length, claim.seen || []]))
      .filter((r) => !freshIds.has(r.uuid)).slice(0, sk.rules.contextMessages || 8).reverse().filter((r) => personRow(r, humans))
    const nameOf = (r) => { const h = personRow(r, humans); return members.find((m) => m.id === h?.id)?.name || r.messages.userName || r.messages.name || '' }
    const messages = [...before.map((r) => ({ r, fresh: false })), ...fresh.map((r) => ({ r, fresh: true }))]
      .map(({ r, fresh: f }) => ({ uuid: r.uuid, who: nameOf(r), at: r.ts, text: String(r.messages.content || ''), fresh: f }))
    const plans = await S.livePlans({ kind: 'room', roomId }, { now })
    const tz = sk.rules.timezone
    const { input, keys } = R.inputFor({ where: 'room', now, tz, plans, members, messages, rules: sk.rules })
    stats.read++
    hour.push(Date.now())
    const g = await R.gate(input, { skill: sk, ...(deps.decide ? { decide: deps.decide } : {}) })
    if (!g) {
      stats.failed++
      // (a model that could not be read: asked again next time — but not forever)
      await done(claim.fails >= 2 ? newest : null, { at: now, gate: null }, { failed: claim.fails < 2, seen: claim.fails >= 2 ? seenWith(rows) : null })
      return { skipped: 'gate_unreadable' }
    }
    if (!g.pass) { stats.gated++; await done(newest, { at: now, gate: g }, { seen: seenWith(rows) }); return { gate: g, ops: [] } }
    let raw
    try { raw = await R.extract(input, { skill: sk, ...(deps.json ? { json: deps.json } : {}) }) } catch (e) {
      stats.failed++
      console.warn('[agenda] read room', e.message)
      await done(claim.fails >= 2 ? newest : null, { at: now, gate: g, error: String(e.message).slice(0, 120) }, { failed: claim.fails < 2, seen: claim.fails >= 2 ? seenWith(rows) : null })
      return { skipped: 'read_failed', gate: g }
    }
    const { ops, skipped } = R.checkOps(raw, { where: 'room', now, tz, keys, rules: sk.rules, lastMessage: fresh[fresh.length - 1].uuid })
    const roomTitle = room.name || members.map((m) => m.name).join(', ')
    const applied = await S.applyOps({ kind: 'room', roomId, roomTitle, members }, ops, { now, model: { model: config.llm.model, skill: sk.version, gate: g } })
    stats.made += applied.length
    await done(newest, { at: now, gate: g, ops: applied.map((a) => ({ op: a.op, id: a.item.id })), skipped }, { seen: seenWith(rows) })
    if (applied.length) console.log(`[agenda] room ${roomId.slice(0, 8)}: ${applied.map((a) => `${a.op} 「${a.item.title}」`).join(', ')}`)
    // (more came than one reading takes: the rest soon)
    if (rows.length >= (sk.rules.newMessages || 30)) mark(roomId, { delayMs: 1000 })
    return { gate: g, ops: applied, skipped }
  } catch (e) {
    // anything unexpected counts as a failure too: the third in a row moves past these messages, so the room is never stuck (review #5)
    await done(claim.fails >= 2 ? (newest || 'now') : null, { at: now, error: String(e.message).slice(0, 120) },
      { failed: claim.fails < 2, seen: claim.fails >= 2 ? seenWith(rows) : null }).catch(() => {})
    throw e
  }
}
