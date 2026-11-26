// The plans read from rooms and mail, and who is reminded of them when (sql/067_agenda.sql, spec openspec/specs/agenda-reminders):
//   itemOf       — a row → the plan as the rest reads it ({date, start} on its own wall clock)
//   livePlans    — the plans of one room or one mailbox still ahead (what a new reading may change or cancel)
//   applyOps     — the checked ops (lib/agenda/read.js checkOps) made rows: create · update (version + 1, reminders again) · cancel
//   arm · disarm — the reminders of a plan for its people (lib/agenda/remind.js slotsFor), and taking back the ones not sent
//   visible      — a plan as one person may see it: theirs (a participant who did not put it away) and still of the room they are in (a
//                  room's) or of their own mailbox (a mail's) — the one privacy rule of every read here (VISIBLE)
//   upcoming · dismiss · addToCalendar · prefsOf · savePrefs · markMessages — what the screens ask (routes/agenda.js)
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { L, isEn } from '../lang.js'
import { namesOf } from '../people.js'
import { addrOf } from '../mailSelf.js'
import * as E from '../calendarEvent.js'
import { slotsFor, isOver, startOf, leadOf, whenWords } from './remind.js'

const T = () => config.tenantId
const LIVE = `('active', 'changed')`
const COLS = `i.*, to_char(i.all_day_date, 'YYYY-MM-DD') as all_day`
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// one person may see a plan: theirs, not put away, and of the room they are in now (a room's) or of their own mailbox (a mail's)
// ($t: the tenant, $u: the person — parameter numbers)
export const VISIBLE = (t, u) => `i.tenant_id = ${t} and ${u}::uuid = any(i.participants) and not (${u}::uuid = any(i.dismissed_by))
  and ((i.source_kind = 'mail' and i.mail_owner = ${u}::uuid)
    or (i.source_kind = 'room' and exists (select 1 from chat_rooms r where r.id = i.room_id and r.tenant_id = i.tenant_id
          and r.participants @> jsonb_build_array(jsonb_build_object('id', ${u}::text)))))`

export function itemOf(r) {
  const tz = E.validTz(r.tz) || E.DEFAULT_TZ
  const timed = r.starts_at ? E.localParts(new Date(r.starts_at), tz) : null
  return {
    id: r.id, tenantId: r.tenant_id, kind: r.source_kind, roomId: r.room_id || null, messageIds: r.message_ids || [], mailOwner: r.mail_owner || null,
    mailId: r.mail_id || null, source: { ...(r.source || {}), kind: r.source_kind },
    title: r.title, date: timed ? timed.date : r.all_day, start: timed ? timed.time : null, allDay: !r.starts_at, tz, durationMin: r.duration_min || null,
    location: r.location || '', link: r.link || '', bring: r.bring || '', notes: r.notes || '',
    audience: r.audience, participants: (r.participants || []).map(String), dismissedBy: (r.dismissed_by || []).map(String),
    status: r.status, version: r.version, calendar: r.calendar || {}, history: r.history || [], model: r.created_by_model || {},
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}
const whenCols = (it) => (it.allDay ? [null, it.date] : [E.zonedToUtc(it.date, it.start, it.tz).toISOString(), null])
const snap = (it) => ({ title: it.title, date: it.date, start: it.start, allDay: !!it.allDay, location: it.location || '', link: it.link || '', bring: it.bring || '', notes: it.notes || '' })

// scope: {kind: 'room', roomId} | {kind: 'mail', owner, mail: {sender, thread}} — a mail sees only its owner's plans from the same sender or
// the same thread (review #1: an outsider's mail could move or cancel a plan someone else's mail made, or put its own link on it)
export async function livePlans(scope, { now = new Date() } = {}) {
  const rows = await q(`select ${COLS} from pro_agenda_items i where i.tenant_id=$1 and ${scopeSql(scope, 2, 3)} and i.status in ${LIVE}
                        order by coalesce(i.starts_at, i.all_day_date::timestamptz) limit 40`, [T(), scopeKey(scope), ...scopeArgs(scope)])
  return rows.map(itemOf).filter((x) => !isOver(x, now))
}

// ---------- the person's settings (설정 › 계정 › 연결 › 약속 알림) ----------
export async function prefsOf(userId) {
  const [p] = await q('select agenda from pro_profile where user_id=$1', [userId]).catch(() => [])
  const a = p?.agenda || {}
  return { on: a.on !== false, leadMin: leadOf(a), ...(E.validTz(a.tz) ? { tz: a.tz } : {}) }
}

// ---------- reminders ----------
// the reminders of a plan for its people (only: some of them), on its current version — one per slot, never twice (the unique key).
// A slot already sent at that very moment (an earlier version's morning, when only the place changed) is not armed again: the same
// reminder is never sent twice; a new time or a new day is.
export async function arm(item, { now = new Date(), only = null } = {}) {
  if (!['active', 'changed'].includes(item.status)) return 0
  let n = 0
  for (const uid of item.participants) {
    if (item.dismissedBy.includes(uid) || (only && !only.includes(uid))) continue
    const prefs = await prefsOf(uid)
    for (const s of slotsFor(item, { now, prefs, tz: prefs.tz || item.tz })) {
      const r = await q(`insert into pro_agenda_reminders (tenant_id, item_id, user_id, slot, version, due_at)
                         select $1,$2,$3,$4,$5,$6 where not exists (select 1 from pro_agenda_reminders s where s.item_id=$2 and s.user_id=$3 and s.slot=$4
                           and s.sent_at is not null and s.due_at=$6)
                         on conflict (item_id, user_id, slot, version) do nothing returning id`, [item.tenantId || T(), item.id, uid, s.slot, item.version, s.dueAt])
      n += r.length
    }
  }
  return n
}
// the reminders not sent yet, taken back (userId: one person's; below: of the versions before it)
export async function disarm(itemId, { userId = null, below = null, why = 'cancelled' } = {}) {
  const r = await q(`update pro_agenda_reminders set cancelled_at = now(), outcome = $5 where tenant_id=$1 and item_id=$2 and sent_at is null and cancelled_at is null
                     and ($3::uuid is null or user_id = $3) and ($4::int is null or version < $4) returning id`, [T(), itemId, userId, below, why])
  return r.length
}

// ---------- what a reading does ----------
// scope: {kind: 'room', roomId, roomTitle, members: [{id}]} | {kind: 'mail', owner, mail: {id, subject, from, actionId}}
// meta: {now, model: {model, skill, gate: {p, by}}}
export async function applyOps(scope, ops, { now = new Date(), model = {} } = {}) {
  const done = []
  for (const o of ops) {
    const item = o.op === 'create' ? await create(scope, o, { now, model }) : o.op === 'update' ? await change(scope, o, { now }) : o.op === 'cancel' ? await cancel(scope, o) : null
    if (item) done.push({ op: o.op, item })
  }
  for (const uid of new Set(done.flatMap((d) => d.item.participants))) emit(uid, 'agenda', {})
  return done
}

const at = () => new Date().toISOString()
// the plans one reading may see and change (n: the room or owner's parameter, m: a mail's sender · thread): a room's, or a mailbox owner's from
// the same sender or the same thread — the sender and thread the plan was first read from (never overwritten by a later mail)
const scopeSql = (scope, n, m) => (scope.kind === 'room' ? `source_kind='room' and room_id=$${n}`
  : `source_kind='mail' and mail_owner=$${n}::uuid and (source->>'sender' = nullif($${m}::text, '') or (source->>'thread' = nullif($${m + 1}::text, '')))`)
const scopeKey = (scope) => (scope.kind === 'room' ? scope.roomId : scope.owner)
const scopeArgs = (scope) => (scope.kind === 'room' ? [] : [String(scope.mail?.sender || '').toLowerCase(), String(scope.mail?.thread || '')])

async function create(scope, o, { now, model }) {
  const room = scope.kind === 'room'
  const everyone = room ? (scope.members || []).map((m) => String(m.id)) : [String(scope.owner)]
  const people = room && o.people?.length ? o.people.filter((id) => everyone.includes(id)) : everyone
  if (!people.length) return null
  const [startsAt, allDayDate] = whenCols(o.item)
  const m = scope.mail || {}
  const source = room ? { title: scope.roomTitle || null }
    : { subject: m.subject || '', from: m.from || '', ...(m.sender ? { sender: String(m.sender).toLowerCase() } : {}), ...(m.thread ? { thread: String(m.thread) } : {}),
      ...(m.actionId ? { actionId: m.actionId } : {}) }
  const history = [{ at: at(), op: 'create', by: 'model', ...(o.message ? { message: o.message } : {}), ...(room ? {} : { mail: scope.mail?.id }), basis: o.basis || '', item: snap(o.item) }]
  const [row] = await q(`insert into pro_agenda_items (tenant_id, source_kind, room_id, message_ids, mail_owner, mail_id, source, title, starts_at, all_day_date, tz,
                           duration_min, location, link, bring, notes, audience, participants, created_by_model, history)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning ${COLS.replace(/i\./g, '')}`,
  [T(), scope.kind, room ? scope.roomId : null, o.message ? [o.message] : [], room ? null : scope.owner, room ? null : String(scope.mail?.id || ''), source,
    o.item.title, startsAt, allDayDate, o.item.tz, o.item.durationMin || null, o.item.location || '', o.item.link || '', o.item.bring || '', o.item.notes || '',
    room ? (o.people?.length ? 'people' : 'room') : 'owner', people, { ...model, at: at() }, JSON.stringify(history)])
  const item = itemOf(row)
  await arm(item, { now })
  return item
}

async function change(scope, o, { now }) {
  const [startsAt, allDayDate] = whenCols(o.item)
  const entry = { at: at(), op: 'update', by: 'model', ...(o.message ? { message: o.message } : {}), ...(scope.kind === 'mail' ? { mail: scope.mail?.id } : {}),
    basis: o.basis || '', changed: o.changed, item: snap(o.item) }
  const [row] = await q(`update pro_agenda_items i set title=$4, starts_at=$5, all_day_date=$6, tz=$7, duration_min=$8, location=$9, link=$10, bring=$11, notes=$12,
                           participants = coalesce($13::uuid[], participants), audience = case when $13::uuid[] is null then audience else 'people' end,
                           message_ids = case when $14::text is null or $14::text = any(message_ids) then message_ids else message_ids || $14::text end,
                           mail_id = coalesce($15, mail_id), source = case when source_kind = 'mail' then (source - 'actionId') || $16::jsonb else source end,
                           status='changed', version = version + 1, history = history || $17::jsonb, updated_at = now()
                         where i.id=$1 and i.tenant_id=$2 and ${scopeSql(scope, 3, 18)} and i.status in ${LIVE} returning ${COLS}`,
  [o.id, T(), scopeKey(scope), o.item.title, startsAt, allDayDate, o.item.tz, o.item.durationMin || null, o.item.location || '', o.item.link || '',
    o.item.bring || '', o.item.notes || '', o.people || null, o.message || null, scope.kind === 'mail' ? String(scope.mail?.id || '') || null : null,
    // (a later mail: the plan's subject · sender line · Home card are that mail's — its own card or none; who may change it stays the first's)
    scope.kind === 'mail' ? { subject: scope.mail?.subject || '', from: scope.mail?.from || '', ...(scope.mail?.actionId ? { actionId: scope.mail.actionId } : {}) } : {},
    JSON.stringify([entry]), ...scopeArgs(scope)])
  if (!row) return null
  const item = itemOf(row)
  // what was not sent goes; the new time (or place) is reminded on its own version — a slot already past is not
  await disarm(item.id, { below: item.version, why: 'changed' })
  await arm(item, { now })
  return item
}

async function cancel(scope, o) {
  const entry = { at: at(), op: 'cancel', by: 'model', ...(o.message ? { message: o.message } : {}), ...(scope.kind === 'mail' ? { mail: scope.mail?.id } : {}), basis: o.basis || '' }
  const [row] = await q(`update pro_agenda_items i set status='cancelled', history = history || $4::jsonb,
                           message_ids = case when $5::text is null or $5::text = any(message_ids) then message_ids else message_ids || $5::text end, updated_at = now()
                         where i.id=$1 and i.tenant_id=$2 and ${scopeSql(scope, 3, 6)} and i.status in ${LIVE} returning ${COLS}`,
  [o.id, T(), scopeKey(scope), JSON.stringify([entry]), o.message || null, ...scopeArgs(scope)])
  if (!row) return null
  await disarm(row.id, { why: 'cancelled' })
  return itemOf(row)
}

// ---------- what the screens ask ----------
export async function visible(userId, id) {
  if (!UUID.test(String(id)) || !UUID.test(String(userId))) return null
  const [r] = await q(`select ${COLS} from pro_agenda_items i where i.id=$1 and ${VISIBLE('$2', '$3')}`, [String(id), T(), String(userId)])
  return r ? itemOf(r) : null
}

// a room as one person calls it: its name, else the other people in it (a 1:1 room is the other person)
async function roomTitles(roomIds, viewerId) {
  if (!roomIds.length) return new Map()
  const rows = await q('select id, name, participants from chat_rooms where id = any($1) and tenant_id=$2', [roomIds, T()])
  const humans = (r) => (Array.isArray(r.participants) ? r.participants : []).filter((p) => p && !p.is_agent && UUID.test(String(p.id || '')))
  const names = await namesOf(rows.flatMap((r) => humans(r).map((p) => p.id))).catch(() => ({}))
  return new Map(rows.map((r) => [r.id, r.name || humans(r).filter((p) => String(p.id) !== String(viewerId)).map((p) => names[p.id] || p.username || '').filter(Boolean).join(', ')]))
}

// where the plan was said, as a link: the room at the message that made (or last changed) it, the mail's sheet
export function sourceUrl(item) {
  if (item.kind === 'room') { const m = item.messageIds[item.messageIds.length - 1]; return m ? `/pro/team/${item.roomId}/${m}` : `/chats?id=${item.roomId}` }
  return `/pro/mail/${encodeURIComponent(item.mailId)}`
}

const KO_DAY = '일월화수목금토'
const hostOf = (u) => { try { return new URL(u).hostname } catch { return '' } }
const badgeOf = (date) => {
  if (!date) return null
  const [, m, d] = date.split('-').map(Number)
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
  return { d: `${m}/${d}`, w: L(KO_DAY[wd], E.WEEKDAY_EN[wd]) }
}
// a plan for one viewer (in the request's language)
export async function viewOf(item, viewer, { now = new Date(), titles = null } = {}) {
  const lang = isEn() ? 'en' : 'ko'
  const names = item.audience === 'people' ? await namesOf(item.participants).catch(() => ({})) : {}
  const roomTitle = item.kind === 'room' ? (titles || await roomTitles([item.roomId], viewer.id)).get(item.roomId) || item.source.title || '' : ''
  const mine = item.calendar?.[viewer.id]
  return {
    id: item.id, title: item.title, when: whenWords(item, { now, lang }), date: item.date, start: item.start, allDay: item.allDay, tz: item.tz,
    // the card's day badge 「12/1 · 화」 / 「12/1 · Tue」
    badge: badgeOf(item.date),
    location: item.location, link: item.link, bring: item.bring, notes: item.notes, status: item.status, changed: item.status === 'changed',
    // a link shown by its domain — a mail's marked with who sent it (review #1: it is the sender's word, not Lite's)
    ...(item.link ? { linkHost: hostOf(item.link), ...(item.kind === 'mail' ? { linkFrom: item.source.sender || addrOf(item.source.from) || '' } : {}) } : {}),
    audience: item.audience, ...(item.audience === 'people' ? { people: item.participants.map((id) => names[id]).filter(Boolean) } : {}),
    // (the lines the card shows as they are, in the reader's language: 「「시니어그룹」 대화」 · 「메일 · 12월 정기 모임 안내」 · 「함께: 김서연, 박도윤」)
    ...(item.audience === 'people' ? { peopleLine: L(`함께: ${item.participants.map((id) => names[id]).filter(Boolean).join(', ')}`, `With: ${item.participants.map((id) => names[id]).filter(Boolean).join(', ')}`) } : {}),
    source: item.kind === 'room'
      ? { kind: 'room', title: roomTitle, label: roomTitle ? L(`「${roomTitle}」 대화`, `“${roomTitle}” conversation`) : L('팀 대화', 'Team conversation'),
        roomId: item.roomId, messageId: item.messageIds[item.messageIds.length - 1] || null, url: sourceUrl(item) }
      : { kind: 'mail', subject: item.source.subject || '', from: item.source.from || '', label: L(`메일 · ${item.source.subject || '(제목 없음)'}`, `Mail · ${item.source.subject || '(no subject)'}`),
        mailId: item.mailId, actionId: item.source.actionId || null, url: sourceUrl(item) },
    calendar: mine?.via ? { via: mine.via, existing: !!mine.existing, link: mine.htmlLink || null } : null,
  }
}

// 다가오는 약속: my plans from now to `days` ahead (one going on now too), soonest first
export async function upcoming(viewer, { now = new Date(), days = 7 } = {}) {
  const until = new Date(new Date(now).getTime() + days * 864e5)
  const rows = await q(`select ${COLS} from pro_agenda_items i where ${VISIBLE('$1', '$2')} and i.status in ${LIVE}
                          and coalesce(i.starts_at, i.all_day_date::timestamptz - interval '14 hours') < $3
                          and coalesce(i.starts_at + make_interval(mins => coalesce(i.duration_min, 60)), i.all_day_date::timestamptz + interval '2 days') > $4
                        order by coalesce(i.starts_at, i.all_day_date::timestamptz) limit 30`, [T(), viewer.id, until, new Date(now)])
  const items = rows.map(itemOf).filter((x) => !isOver(x, now) && startOf(x).getTime() < until.getTime())
  const titles = await roomTitles([...new Set(items.filter((x) => x.kind === 'room').map((x) => x.roomId))], viewer.id)
  return Promise.all(items.map((x) => viewOf(x, viewer, { now, titles })))
}

// 「이건 아니에요」: not mine — no reminders for me, off my list, and the reading recorded as wrong (feedback). The plan stays for the others
// in the room; when everyone it is for has put it away it is dismissed.
export async function dismiss(viewer, id) {
  const it = await visible(viewer.id, id)
  if (!it) throw fail(404, L('약속을 찾지 못했어요.', "That plan couldn't be found."))
  const entry = { at: at(), op: 'dismiss', by: viewer.id }
  const [row] = await q(`update pro_agenda_items i set dismissed_by = case when $3::uuid = any(dismissed_by) then dismissed_by else dismissed_by || $3::uuid end,
                           history = history || $4::jsonb, updated_at = now(),
                           status = case when (select bool_and(p = any(dismissed_by || $3::uuid)) from unnest(participants) p) then 'dismissed' else status end
                         where i.id=$1 and i.tenant_id=$2 returning ${COLS}`, [it.id, T(), viewer.id, JSON.stringify([entry])])
  await q(`insert into pro_agenda_feedback (tenant_id, item_id, user_id, verdict, item) values ($1,$2,$3,'not_a_plan',$4)`,
    [T(), it.id, viewer.id, { ...snap(it), source: it.source, kind: it.kind, history: it.history.filter((h) => h.op !== 'dismiss').slice(-3), model: it.model }])
  await disarm(it.id, { userId: viewer.id, why: 'dismissed' })
  emit(viewer.id, 'agenda', {})
  return { ok: true, status: row?.status || it.status }
}

// 「캘린더에 추가」: the plan in my Google Calendar (lib/mailCard.js toGoogleCalendar — the same event there is said, not made twice); a
// demo mailbox records it only. One event per person per plan, even when two presses arrive together.
export async function addToCalendar(viewer, id, deps = {}) {
  const it = await visible(viewer.id, id)
  if (!it || !['active', 'changed'].includes(it.status)) throw fail(404, L('약속을 찾지 못했어요.', "That plan couldn't be found."))
  const done = it.calendar?.[viewer.id]
  if (done?.via) return { ok: true, already: true, plan: await viewOf(it, viewer) }
  const MC = await import('../mailCard.js')
  const [acc] = await q('select provider from pro_mail_accounts where user_id=$1', [viewer.id])
  const mode = await MC.calendarMode(viewer.id, acc?.provider)
  if (mode === 'none' || mode === 'scope') throw MC.modeError(mode)
  const [claimed] = await q(`update pro_agenda_items set calendar = calendar || jsonb_build_object($2::text, jsonb_build_object('adding', now()))
                             where id=$1 and (not (calendar ? $2::text) or (calendar->$2::text->>'via' is null
                               and coalesce((calendar->$2::text->>'adding')::timestamptz, 'epoch'::timestamptz) < now() - interval '5 minutes')) returning id`, [it.id, viewer.id])
  if (!claimed) throw fail(409, L('이 약속은 캘린더에 넣는 중이거나 이미 넣었어요.', 'This plan is already being added, or was added.'), 'event_busy')
  const ev = { title: it.title, date: it.date, start: it.start, allDay: it.allDay, tz: it.tz, durationMin: it.durationMin || 60, location: it.location, link: it.link,
    description: [it.bring ? L(`챙길 것: ${it.bring}`, `Bring: ${it.bring}`) : '', it.notes].filter(Boolean).join('\n') }
  let got = null, existing = false
  try {
    if (mode === 'google') {
      const where = it.kind === 'room' ? L('Lite 팀 대화에서 정한 약속', 'A plan agreed in a Lite team conversation') : L(`메일: ${it.source.subject || ''} — ${it.source.from || ''}`, `Mail: ${it.source.subject || ''} — ${it.source.from || ''}`)
      const r = await MC.toGoogleCalendar(viewer.id, ev, where, deps)
      got = r.existing || r.made
      existing = !!r.existing
    }
  } catch (e) {
    await q(`update pro_agenda_items set calendar = calendar - $2::text where id=$1`, [it.id, viewer.id]).catch(() => {})
    throw fail(502, L(`Google 캘린더가 요청을 받지 않았어요 (${String(e.message).slice(0, 160)}).`, `Google Calendar didn't accept the request (${String(e.message).slice(0, 160)}).`), 'calendar_error')
  }
  const rec = { via: mode, existing, id: got?.id || null, htmlLink: E.validLink(got?.htmlLink) || null, at: at() }
  const [row] = await q(`update pro_agenda_items set calendar = calendar || jsonb_build_object($2::text, $3::jsonb), updated_at = now() where id=$1 returning ${COLS.replace(/i\./g, '')}`,
    [it.id, viewer.id, rec])
  emit(viewer.id, 'agenda', {})
  return { ok: true, plan: await viewOf(itemOf(row), viewer) }
}

// my settings changed: my reminders not sent yet go and come back with the new lead (none when off)
export async function savePrefs(viewer, { on, leadMin } = {}, { now = new Date(), choices = [15, 30, 60, 120, 180] } = {}) {
  const cur = await prefsOf(viewer.id)
  const next = { on: on === undefined ? cur.on : on !== false, leadMin: choices.includes(Number(leadMin)) ? Number(leadMin) : cur.leadMin }
  await q('insert into pro_profile (user_id, email) values ($1,$2) on conflict (user_id) do nothing', [viewer.id, viewer.email || null])
  await q('update pro_profile set agenda = $2 where user_id=$1', [viewer.id, next])
  await q(`delete from pro_agenda_reminders r using pro_agenda_items i where r.item_id = i.id and r.tenant_id = i.tenant_id and i.tenant_id=$1 and r.user_id=$2
           and r.sent_at is null and r.cancelled_at is null`, [T(), viewer.id])
  if (next.on) {
    const rows = await q(`select ${COLS} from pro_agenda_items i where ${VISIBLE('$1', '$2')} and i.status in ${LIVE}`, [T(), viewer.id])
    for (const it of rows.map(itemOf)) if (!isOver(it, now)) await arm(it, { now, only: [viewer.id] })
  }
  return next
}

// a room's messages that made or changed a plan of mine there: a small mark under each (components/team/Messenger.vue)
export async function markMessages(viewer, roomId, messages) {
  if (!messages?.length) return messages
  const rows = await q(`select ${COLS} from pro_agenda_items i where ${VISIBLE('$1', '$2')} and i.room_id=$3 and i.status in ${LIVE} and i.message_ids && $4::text[]`,
    [T(), viewer.id, roomId, messages.map((m) => String(m.id))]).catch(() => [])
  const lang = isEn() ? 'en' : 'ko'
  for (const it of rows.map(itemOf)) {
    if (isOver(it)) continue
    for (const m of messages) if (it.messageIds.includes(String(m.id))) (m.agenda ||= []).push({ id: it.id, title: it.title, when: whenWords(it, { lang }), location: it.location })
  }
  return messages
}
