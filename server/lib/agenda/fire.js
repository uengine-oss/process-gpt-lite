// Reminders that are due, sent (spec openspec/specs/agenda-reminders 「그때가 되면 알린다」):
//   fireDue — claims the due reminders of this tenant in one statement (`update … where sent_at is null … for update skip locked returning`:
//             two servers never take the same one), then for each looks again: the plan still on and still this person's (a room's: they
//             are still in the room; a mail's: their own mailbox — lib/agenda/store.js VISIBLE), the person still an approved member of the
//             company (lib/webpush.js memberHere), their 약속 알림 on, the plan not started yet (a morning one: not over). Then one notice
//             (lib/notify.js notifyUser, type 'agenda') in the person's language — Home and the phone's push carry it — whose link opens
//             where it was agreed. outcome: sent · skipped:<why>
//   startAgendaTicker — every minute in each tenant (index.js: the background block, or PRO_AGENDA_TICK_MS on a test stack)
// now: the clock (a test stack's clock override — routes/agenda.js, PRO_AGENDA_TEST_CLOCK=1).
import { config } from '../../config.js'
import { q } from '../supa.js'
import { langOf, withLang } from '../lang.js'
import { namesOf } from '../people.js'
import { isOver, startOf, reminderText } from './remind.js'
import { itemOf, prefsOf, sourceUrl, VISIBLE } from './store.js'

const T = () => config.tenantId
const COLS = `i.*, to_char(i.all_day_date, 'YYYY-MM-DD') as all_day`

export async function fireDue({ now = new Date(), limit = 50, deps = {} } = {}) {
  const claimed = await q(`update pro_agenda_reminders r set sent_at = now()
                           where r.id in (select r2.id from pro_agenda_reminders r2 join pro_agenda_items i on i.id = r2.item_id and i.tenant_id = r2.tenant_id
                                          where r2.tenant_id = $1 and r2.sent_at is null and r2.cancelled_at is null and r2.due_at <= $2
                                            and r2.version = i.version and i.status in ('active', 'changed')
                                          order by r2.due_at limit $3 for update of r2 skip locked)
                             and r.sent_at is null returning r.*`, [T(), new Date(now), limit])
  const out = []
  for (const r of claimed) {
    const outcome = await deliver(r, now, deps).catch((e) => { console.warn('[agenda] remind', e.message); return `error:${String(e.message).slice(0, 60)}` })
    await q('update pro_agenda_reminders set outcome=$2 where id=$1', [r.id, outcome])
    out.push({ id: r.id, item: r.item_id, user: r.user_id, slot: r.slot, outcome })
  }
  return out
}

async function deliver(r, now, deps) {
  const [row] = await q(`select ${COLS} from pro_agenda_items i where i.id=$1 and ${VISIBLE('$2', '$3')}`, [r.item_id, T(), r.user_id])
  if (!row) return 'skipped:not_visible'
  const item = itemOf(row)
  const member = deps.memberHere || (await import('../webpush.js')).memberHere
  if (!(await member(r.user_id))) return 'skipped:not_member'
  const prefs = await prefsOf(r.user_id)
  if (!prefs.on) return 'skipped:off'
  // late (the server was down, or the reminder was taken back and forth): what has started is not announced as coming
  if (r.slot === 'before' ? startOf(item).getTime() <= new Date(now).getTime() : isOver(item, now)) return 'skipped:late'
  const lang = await langOf(r.user_id)
  const names = item.audience === 'people' ? await namesOf(item.participants).catch(() => ({})) : {}
  const people = item.audience === 'people' ? item.participants.filter((id) => id !== String(r.user_id)).map((id) => names[id]).filter(Boolean) : []
  const source = item.kind === 'room' ? { kind: 'room', title: await roomTitle(item, r.user_id) } : { kind: 'mail', subject: item.source.subject }
  const { title, text } = withLang(lang, () => reminderText(item, r.slot, { now, tz: prefs.tz || item.tz, lang, source, people }))
  const notify = deps.notifyUser || (await import('../notify.js')).notifyUser
  await notify(r.user_id, { type: 'agenda', title, text, url: sourceUrl(item) })
  return 'sent'
}

// the room as this person calls it (its name, else the others in it)
async function roomTitle(item, userId) {
  const [room] = await q('select name, participants from chat_rooms where id=$1 and tenant_id=$2', [item.roomId, T()])
  if (room?.name) return room.name
  const others = (Array.isArray(room?.participants) ? room.participants : []).filter((p) => p && !p.is_agent && p.id && String(p.id) !== String(userId) && p.id !== 'system_id')
  const names = await namesOf(others.map((p) => p.id)).catch(() => ({}))
  return others.map((p) => names[p.id] || p.username || '').filter(Boolean).join(', ') || item.source.title || ''
}

let ticker = null
export function startAgendaTicker(forEachTenant, { everyMs = Number(process.env.PRO_AGENDA_TICK_MS) || 60_000 } = {}) {
  if (ticker) return ticker
  ticker = setInterval(() => forEachTenant(() => fireDue().then((sent) => sent.length && console.log(`[agenda] reminders: ${sent.map((s) => s.outcome).join(', ')}`)), 'agenda'), everyMs)
  return ticker
}
