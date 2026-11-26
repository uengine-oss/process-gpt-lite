// When a plan read from a mail or a room is said again to the people it is for, and in what words — fixed arithmetic on its
// time, no model and no database (test/agenda.test.js). The plan itself was read by the model (lib/agenda/read.js).
//   slotsFor     — {slot: 'day' | 'before', dueAt} for one person: the morning of the day (dayAt, the person's wall clock) and
//                  leadMin before a timed start. A slot already past is left out; a morning too close to the start (within
//                  closeMin of the 'before' one) is left out; an all-day plan has its morning only.
//   startOf · endOf · isOver — the instants a plan starts and ends (an all-day plan: its whole day in its time zone)
//   whenWords    — 「오늘 오후 3:00」 / 「내일 오전 10:30」 / 「12월 1일 (화) 오후 3:00」 · "Today, 3:00 PM" …
//   leadWords    — 「1시간 뒤」 · 「30분 뒤」 / "in 1 hr" · "in 30 min" (how long until it starts)
//   reminderText — the notice's title and text: what was agreed (time · place · who · what to bring), and where it was said; a mail's
//                  link is left out (the card shows it with its domain and sender)
// An item here: {title, date, start, allDay, tz, durationMin, location, link, bring, notes} — date and start on the plan's own wall clock.
import { zonedToUtc, localParts, nextDay, whenText, DEFAULT_TZ } from '../calendarEvent.js'
import { eunNeun, iga } from '../josa.js'

export const DEFAULTS = { leadMin: 60, dayAt: '08:00', closeMin: 30 }
export const SLOTS = ['day', 'before']

const hhmm = (s, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '')) ? String(s) : d)
export const leadOf = (prefs = {}) => Math.max(5, Math.min(24 * 60, Number(prefs.leadMin) || DEFAULTS.leadMin))

export function startOf(item) {
  const tz = item.tz || DEFAULT_TZ
  return item.allDay ? zonedToUtc(item.date, '00:00', tz) : zonedToUtc(item.date, item.start, tz)
}
export function endOf(item) {
  const tz = item.tz || DEFAULT_TZ
  return item.allDay ? zonedToUtc(nextDay(item.date), '00:00', tz) : new Date(startOf(item).getTime() + (Number(item.durationMin) || 60) * 60000)
}
export const isOver = (item, now = new Date()) => endOf(item).getTime() <= new Date(now).getTime()

// prefs: {on, leadMin, dayAt}; tz: the person's (the plan's own when unknown)
export function slotsFor(item, { now = new Date(), prefs = {}, tz = null } = {}) {
  if (!item?.date || (!item.allDay && !item.start) || prefs.on === false) return []
  const zone = tz || item.tz || DEFAULT_TZ
  const dayAt = hhmm(prefs.dayAt, DEFAULTS.dayAt)
  const t = new Date(now).getTime()
  const start = startOf(item).getTime()
  // the morning of the plan's day, as the person's clock reads it
  const day = item.allDay ? item.date : localParts(new Date(start), zone).date
  const morning = zonedToUtc(day, dayAt, zone).getTime()
  if (item.allDay) return morning > t ? [{ slot: 'day', dueAt: new Date(morning) }] : []
  const out = []
  const before = start - leadOf(prefs) * 60000
  if (morning > t && morning < before - DEFAULTS.closeMin * 60000) out.push({ slot: 'day', dueAt: new Date(morning) })
  if (before > t) out.push({ slot: 'before', dueAt: new Date(before) })
  return out
}

const timeWords = (t, lang) => {
  const h = Number(t.slice(0, 2)), m = t.slice(3, 5)
  return lang === 'en' ? `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}` : `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${m}`
}
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5)

// the plan's time on the reader's clock (tz), today and tomorrow said as such
export function whenWords(item, { now = new Date(), tz = null, lang = 'ko' } = {}) {
  const zone = tz || item.tz || DEFAULT_TZ
  const local = item.allDay ? { date: item.date, time: null } : localParts(startOf(item), zone)
  const d = dayDiff(local.date, localParts(new Date(now), zone).date)
  const start = item.allDay ? null : local.time
  if (d === 0 || d === 1) {
    const word = lang === 'en' ? (d === 0 ? 'Today' : 'Tomorrow') : (d === 0 ? '오늘' : '내일')
    if (!start) return lang === 'en' ? `${word} (all day)` : `${word} 종일`
    return lang === 'en' ? `${word}, ${timeWords(start, lang)}` : `${word} ${timeWords(start, lang)}`
  }
  return whenText({ date: local.date, start }, lang)
}

// how long until it starts, rounded to five minutes: 「1시간 뒤」 · 「1시간 30분 뒤」 · 「25분 뒤」 / "in 1 hr" · "in 25 min"
export function leadWords(item, { now = new Date(), lang = 'ko' } = {}) {
  const min = Math.max(5, Math.round((startOf(item).getTime() - new Date(now).getTime()) / 300000) * 5)
  const h = Math.floor(min / 60), m = min % 60
  if (lang === 'en') return `in ${h ? `${h} hr${h > 1 ? 's' : ''}` : ''}${h && m ? ' ' : ''}${m ? `${m} min` : ''}`
  return `${h ? `${h}시간` : ''}${h && m ? ' ' : ''}${m ? `${m}분` : ''} 뒤`
}

const clean = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
// an http(s) address in a text → 「(링크: evil.example)」 / "(link: evil.example)" — the shape of an address, not its meaning
const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+/gi
export function hideUrls(text, lang = 'ko') {
  return String(text ?? '').replace(URL_RE, (u) => {
    let host = ''
    try { host = new URL(u).hostname } catch { host = '' }
    return lang === 'en' ? `(link${host ? `: ${host}` : ''})` : `(링크${host ? `: ${host}` : ''})`
  })
}

// where it was said: {kind: 'room', title} | {kind: 'mail', subject}
export function sourceWords(src, lang = 'ko') {
  if (src?.kind === 'room') {
    const t = clean(src.title, 40)
    return lang === 'en' ? (t ? `Agreed in the “${t}” conversation.` : 'Agreed in a team conversation.') : (t ? `「${t}」 대화에서 정했어요.` : '팀 대화에서 정했어요.')
  }
  const subj = clean(src?.subject, 50)
  return lang === 'en' ? (subj ? `From the mail “${subj}”.` : 'From a mail.') : (subj ? `메일 「${subj}」에서 읽었어요.` : '메일에서 읽었어요.')
}

// slot: 'day' | 'before'; people: the names of who it is for, when it is only some of a room
export function reminderText(item, slot, { now = new Date(), tz = null, lang = 'ko', source = null, people = [] } = {}) {
  const when = whenWords(item, { now, tz, lang })
  // an address written into a mail plan's title, place, what to bring or notes is said by its domain only (re-review #3); the card
  // shows the words as they are
  const fromMailSrc = (source || item.source)?.kind === 'mail'
  const hide = (t) => (fromMailSrc ? hideUrls(t, lang) : t)
  const title = clean(hide(item.title), 80)
  const place = clean(hide(item.location), 120)
  const bring = clean(hide(item.bring), 120)
  const notes = clean(hide(item.notes), 200)
  // a mail's link is the sender's own word: it is not put in the notice (the phone's push, Home's notice) — the plan's card shows its domain and
  // who gave it (review #1); a room's link is the team's
  const fromMail = (source || item.source)?.kind === 'mail'
  const link = fromMail ? '' : clean(item.link, 300)
  const who = people.map((p) => clean(p, 30)).filter(Boolean).join(', ')
  const head = slot === 'before' && !item.allDay ? leadWords(item, { now, lang }) : when
  const en = lang === 'en'
  const said = en
    ? (place ? `${when}: ${title} is at ${place}, as agreed.` : `${when}: ${title}, as agreed.`)
    : (place ? `${when} ${eunNeun(title)} ${place}에서 하기로 했어요.` : `${when} ${iga(title)} 있어요.`)
  const lines = [said,
    who ? (en ? `With: ${who}` : `함께: ${who}`) : '',
    bring ? (en ? `Bring: ${bring}` : `챙길 것: ${bring}`) : '',
    link ? (en ? `Join: ${link}` : `참여 주소: ${link}`) : '',
    notes,
    sourceWords(source || item.source, lang)]
  return { title: `${head} · ${title}`.slice(0, 200), text: lines.filter(Boolean).join('\n').slice(0, 600) }
}
