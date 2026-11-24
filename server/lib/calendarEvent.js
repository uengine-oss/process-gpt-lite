// An event to put on a calendar, as read by the model from a mail (lib/mailCard.js) or as the person edited it — checked and
// normalized here, without a model and without the database (test/mailCard.test.js):
//   localParts    — an instant in a time zone: its date, 24-hour time and weekday
//   zonedToUtc    — a wall-clock date and time in a time zone → the instant (daylight saving included)
//   normalizeEvent — the model's (or the form's) JSON → {title, date, start, durationMin, allDay, tz, location, link, description,
//                   basis, missing, warnings}: a date that exists, a 24-hour time, a duration in minutes, an http(s) link; a time
//                   read in another time zone is moved to the person's; no time and not all-day → `missing: ['start']` (asked)
//   eventWindow · findSame — where to look for the same event already in the calendar, and whether one there is it
//   whenText      — 「11월 25일 (수) 오후 3:00」 / "Wed, Nov 25, 3:00 PM"
// Nothing here decides what a person's words mean: the model read them; this only checks the shape of what it answered.

export const DEFAULT_TZ = 'Asia/Seoul'
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

export function validTz(tz) {
  const t = clean(tz)
  if (!t || t.length > 64) return null
  try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return t } catch { return null }
}

// "2026-11-25" that exists on the calendar (not 2026-02-30), years 2000–2100
export function validDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(v))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 2000 || y > 2100) return null
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null
}

// "15:00", "9:05", "15:00:00" → "HH:MM" (24 hours)
export function validTime(v) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(clean(v))
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null
}

export function validLink(v) {
  const s = clean(v)
  if (!s || s.length > 2000) return ''
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '' } catch { return '' }
}

const parts = (instant, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
}).formatToParts(instant).map((x) => [x.type, x.value]))
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
export const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// → {date: 'YYYY-MM-DD', time: 'HH:MM', weekday: 0–6}
export function localParts(instant, tz = DEFAULT_TZ) {
  const p = parts(new Date(instant), validTz(tz) || DEFAULT_TZ)
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, weekday: WEEKDAY[p.weekday] }
}

// minutes the zone is ahead of UTC at that instant
function offsetMin(tz, ms) {
  const p = parts(new Date(ms), tz)
  return Math.round((Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - ms) / 60000)
}

// the instant a wall-clock time in a zone names. Next to a daylight-saving change: a time that happens twice is the first one, a
// time the clocks skip is read with the offset before the change (02:30 on a spring-forward night → 03:30), as calendars do.
export function zonedToUtc(date, time, tz = DEFAULT_TZ) {
  const z = validTz(tz) || DEFAULT_TZ
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = (time || '00:00').split(':').map(Number)
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  const before = wall - offsetMin(z, wall - 864e5) * 60000
  const after = wall - offsetMin(z, wall + 864e5) * 60000
  const is = (t) => { const p = localParts(t, z); return p.date === date && p.time === `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` }
  const ok = [before, after].filter(is).sort((a, b) => a - b)
  return new Date(ok.length ? ok[0] : before)
}

// the day after a date (an all-day event ends the next day, exclusive)
export const nextDay = (date) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }

const minutes = (v) => {
  const n = typeof v === 'string' ? Number(clean(v)) : v
  return Number.isFinite(n) && n >= 5 && n <= 24 * 60 ? Math.round(n) : null
}

// raw: the model's JSON (or the form): {title, date, start, end?, durationMin, allDay, timezone, location, link, description, basis}
// ctx: {tz — the person's time zone, now, fallbackTitle, defaultDurationMin}
export function normalizeEvent(raw, { tz = DEFAULT_TZ, now = new Date(), fallbackTitle = '', defaultDurationMin = 60 } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const zone = validTz(tz) || DEFAULT_TZ
  const title = clean(r.title).slice(0, 200) || clean(fallbackTitle).slice(0, 200)
  let date = validDate(r.date)
  let start = date ? validTime(r.start) : null
  const allDay = !!date && !start && r.allDay === true
  let durationMin = minutes(r.durationMin)
  // an end time instead of a length
  if (!durationMin && start) {
    const end = validTime(r.end)
    if (end) {
      const d = (Number(end.slice(0, 2)) * 60 + Number(end.slice(3))) - (Number(start.slice(0, 2)) * 60 + Number(start.slice(3)))
      durationMin = minutes(d > 0 ? d : d + 24 * 60)
    }
  }
  durationMin = durationMin || minutes(defaultDurationMin) || 60
  // a time the mail gave in another zone (「3 PM ET」): the person's own wall clock
  let from = null
  const said = validTz(r.timezone)
  if (date && start && said && said !== zone) {
    const local = localParts(zonedToUtc(date, start, said), zone)
    from = { date, start, tz: said }
    date = local.date
    start = local.time
  }
  let link = validLink(r.link)
  let location = clean(r.location).slice(0, 300)
  // an online meeting's address given as its place
  if (!link && validLink(location)) { link = validLink(location); location = '' }
  const ev = {
    title, date, start, durationMin, allDay, tz: zone, location, link,
    description: String(r.description ?? '').trim().slice(0, 1000), basis: clean(r.basis).slice(0, 200),
    ...(from ? { from } : {}), missing: [], warnings: [],
  }
  if (!title) ev.missing.push('title')
  if (!date) ev.missing.push('date')
  else if (!start && !allDay) ev.missing.push('start')
  if (date && (start || allDay) && eventEnd(ev).getTime() < new Date(now).getTime()) ev.warnings.push('past')
  return ev
}

export const ready = (ev) => !!ev && !!ev.title && !!ev.date && (!!ev.start || !!ev.allDay)

export function eventStart(ev) { return ev.allDay ? zonedToUtc(ev.date, '00:00', ev.tz) : zonedToUtc(ev.date, ev.start, ev.tz) }
export function eventEnd(ev) {
  return ev.allDay ? zonedToUtc(nextDay(ev.date), '00:00', ev.tz) : new Date(eventStart(ev).getTime() + (ev.durationMin || 60) * 60000)
}

// where the same event would be (Google events.list timeMin · timeMax): around its start, or its whole day
export function eventWindow(ev) {
  if (ev.allDay) return { timeMin: eventStart(ev), timeMax: eventEnd(ev) }
  const s = eventStart(ev).getTime()
  return { timeMin: new Date(s - 60000), timeMax: new Date(s + 60000) }
}

const sameTitle = (a, b) => clean(a).normalize('NFC').toLowerCase() === clean(b).normalize('NFC').toLowerCase()
// an event of the calendar ({summary, start: dateTime | date}) that is this one: the same title, and the same start (a timed one) or
// the same day (an all-day one)
export function findSame(items, ev) {
  if (!Array.isArray(items) || !ready(ev)) return null
  const dayOf = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? String(s) : localParts(new Date(s), ev.tz).date)
  const at = ev.allDay ? null : eventStart(ev).getTime()
  return items.find((x) => x && x.start && sameTitle(x.summary, ev.title) && (ev.allDay
    ? dayOf(x.start) === ev.date
    : !/^\d{4}-\d{2}-\d{2}$/.test(String(x.start)) && Math.abs(new Date(x.start).getTime() - at) < 60000)) || null
}

const KO_DAY = '일월화수목금토'
const EN_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay()
// 「11월 25일 (수) 오후 3:00」 · 「11월 25일 (수) 종일」 · "Wed, Nov 25, 3:00 PM" · "Wed, Nov 25 (all day)"
export function whenText(ev, lang = 'ko') {
  if (!ev?.date) return ''
  const [, mo, d] = ev.date.split('-').map(Number)
  const wd = weekdayOf(ev.date)
  const h = ev.start ? Number(ev.start.slice(0, 2)) : 0
  const mm = ev.start ? ev.start.slice(3, 5) : '00'
  if (lang === 'en') {
    const day = `${WEEKDAY_EN[wd]}, ${EN_MONTH[mo - 1]} ${d}`
    return ev.start ? `${day}, ${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}` : `${day} (all day)`
  }
  const day = `${mo}월 ${d}일 (${KO_DAY[wd]})`
  return ev.start ? `${day} ${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${mm}` : `${day} 종일`
}
