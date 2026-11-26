// Plans read from a room's new messages or a new mail — the model reads, this module asks and checks (skill agenda-reminders):
//   inputFor   — what the model is shown: today and its time zone, a calendar of the coming weeks (dates · weekdays · this/next week),
//                the plans already made there (short keys P1 …), the room's people (M1 …) and messages (#1 …, the new ones marked), or the mail
//   gate       — the cheap first question (prompts/gate.md): is there anything about a plan here? first-token odds over two options
//                (lib/decide.js choose — JSON when the model gives no odds); below rules.gateMin nothing more is asked
//   extract    — the reading itself (prompts/read-plans.md): {ops: [create | update | cancel]} against the plans there
//   checkOps   — the answer checked as data (lib/calendarEvent.js normalizeEvent): a date that exists, a 24-hour time or all day, not past,
//                not too far, an update or a cancel only of a plan of this room or mailbox, people only of this room — keys mapped back to ids
// Nothing here reads meaning from words: the model did; this only checks the shape of what it answered (test/agenda-read.test.js).
import { chatJson } from '../llm.js'
import { choose } from '../decide.js'
import { L } from '../lang.js'
import { skillPack } from '../skillPack.js'
import * as E from '../calendarEvent.js'
import { startOf } from './remind.js'

export const SKILL = 'agenda-reminders'
export const DEFAULTS = { timezone: E.DEFAULT_TZ, rooms: true, mail: true, gateMin: 0.3, timeoutMs: 8000, readTimeoutMs: 60000, quietMs: 90000,
  newMessages: 30, contextMessages: 8, textChars: 4000, mailChars: 6000, defaultDurationMin: 60, horizonDays: 366, calendarDays: 21,
  upcomingDays: 7, leadMin: 60, dayAt: '08:00', leadChoices: [15, 30, 60, 120, 180] }
export const MAX_OPS = 6

export async function agendaSkill() {
  const s = await skillPack(SKILL)
  return { ...s, rules: { ...DEFAULTS, ...s.rules } }
}

const clean = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const KO_DAY = '일월화수목금토'
const dayWord = (date) => KO_DAY[new Date(`${date}T00:00:00Z`).getUTCDay()]
const WEEK = ['이번 주', '다음 주', '다다음 주']

// 「2026-11-26 (목) · 이번 주 · 오늘」 … — weeks start on Monday; days from today
export function calendarOf(now, tz, days = 21) {
  const today = E.localParts(new Date(now), tz).date
  const monday = (d) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.getTime() }
  const out = []
  for (let i = 0, d = today; i < days; i++, d = E.nextDay(d)) {
    const w = Math.round((monday(d) - monday(today)) / (7 * 864e5))
    out.push(`${d} (${dayWord(d)}) · ${WEEK[w] || `${w}주 뒤`}${i === 0 ? ' · 오늘' : i === 1 ? ' · 내일' : i === 2 ? ' · 모레' : ''}`)
  }
  return out
}
// an instant as the model reads it: 「2026-11-26 (목) 14:05」
export const stamp = (at, tz) => { const p = E.localParts(new Date(at), tz); return `${p.date} (${dayWord(p.date)}) ${p.time}` }
// a plan as the model reads it: 「2026-12-01 (화) 15:00」 · 「2026-12-01 (화) 종일」
export const planWhen = (item) => (item.allDay ? `${item.date} (${dayWord(item.date)}) 종일` : `${item.date} (${dayWord(item.date)}) ${item.start}`)

// where: 'room' | 'mail'; plans: items (lib/agenda/store.js itemOf); members: [{id, name}]; messages: [{uuid, who, at, text, fresh}];
// mail: {from, subject, date, text}. → {input, keys: {plans, members, messages}}
export function inputFor({ where, now = new Date(), tz, plans = [], members = [], messages = [], mail = null, rules = DEFAULTS }) {
  const zone = E.validTz(tz) || E.DEFAULT_TZ
  const today = E.localParts(new Date(now), zone).date
  const keys = { plans: new Map(), members: new Map(), messages: new Map() }
  const memberKey = new Map()
  members.forEach((m, i) => { keys.members.set(`M${i + 1}`, m); memberKey.set(String(m.id), `M${i + 1}`) })
  const input = {
    where, today: `${today} (${dayWord(today)})`, timezone: zone, calendar: calendarOf(now, zone, rules.calendarDays || 21),
    plans: plans.map((p, i) => {
      keys.plans.set(`P${i + 1}`, p)
      const who = p.audience === 'people' ? p.participants.map((id) => memberKey.get(String(id))).filter(Boolean) : null
      // (the same names as the ops' fields: a model copies them — 「place」 here once made it answer {place} instead of {location})
      return { key: `P${i + 1}`, title: p.title, when: planWhen(p), location: p.location || '', ...(p.bring ? { bring: p.bring } : {}), for: who?.length ? who : 'all' }
    }),
  }
  if (where === 'room') {
    input.members = members.map((m, i) => ({ key: `M${i + 1}`, name: m.name }))
    input.messages = messages.map((m, i) => {
      keys.messages.set(`#${i + 1}`, m)
      return { key: `#${i + 1}`, who: m.who, at: stamp(m.at, zone), text: String(m.text || '').slice(0, rules.textChars || 4000), ...(m.fresh ? { new: true } : {}) }
    })
  } else {
    input.mail = { from: clean(mail?.from, 200), received: stamp(mail?.date || now, zone), subject: clean(mail?.subject, 300),
      text: String(mail?.text || '').slice(0, rules.mailChars || 6000) }
  }
  return { input, keys }
}

// the gate's state: the plans there and the new words, short (the first token is all that is read)
export function gateState(input) {
  const plans = input.plans.length ? input.plans.map((p) => `- ${p.key} ${p.title} · ${p.when}${p.location ? ` · ${p.location}` : ''}`).join('\n') : L('- 없음', '- none')
  const words = input.where === 'room'
    ? input.messages.map((m) => `${m.key}${m.new ? L(' [새]', ' [new]') : ''} ${m.who} (${m.at}): ${String(m.text).slice(0, 600)}`).join('\n')
    : `${L('보낸 사람', 'From')}: ${input.mail.from}\n${L('받은 때', 'Received')}: ${input.mail.received}\n${L('제목', 'Subject')}: ${input.mail.subject}\n${String(input.mail.text).slice(0, 1500)}`
  return [`${L('오늘', 'Today')}: ${input.today} (${input.timezone})`, L('정해 둔 약속:', 'Plans already made:'), plans,
    input.where === 'room' ? L('대화방의 대화:', 'The conversation:') : L('받은 메일:', 'The mail:'), words].join('\n')
}
export const gateOptions = () => [
  { key: 'plan', label: L('있다 — 약속을 정하거나, 정해 둔 약속의 때 · 곳 · 사람을 바꾸거나 취소하는 말이 있다', 'Yes — words that make a plan, or change or cancel a plan already made') },
  { key: 'none', label: L('없다 — 약속에 관한 말이 없다', 'No — nothing about a plan') },
]

// → {pass, p, by, model} or null (the model could not be read)
export async function gate(input, { skill, decide = choose } = {}) {
  const sk = skill || await agendaSkill()
  const r = await decide(gateState(input), sk.prompts.gate, gateOptions(), { answerJson: sk.prompts['answer-json'], timeoutMs: sk.rules.timeoutMs })
  if (!r) return null
  const p = r.probabilities?.plan ?? (r.choice === 'plan' ? r.confidence : 1 - (r.confidence ?? 0))
  return { pass: p >= (sk.rules.gateMin ?? 0.3), p: Math.round(p * 1000) / 1000, by: r.strategy, model: r.model || null }
}

// → the model's ops (raw), or throws when it could not be read
export async function extract(input, { skill, json = chatJson } = {}) {
  const sk = skill || await agendaSkill()
  const raw = await json(sk.prompts['read-plans'], JSON.stringify(input), { timeoutMs: sk.rules.readTimeoutMs || 60000, temperature: 0 })
  return Array.isArray(raw?.ops) ? raw.ops : Array.isArray(raw) ? raw : []
}

const given = (v) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim())
const sameTitle = (a, b) => clean(a).normalize('NFC').toLowerCase() === clean(b).normalize('NFC').toLowerCase()
const sameTime = (a, b) => !!a.allDay === !!b.allDay && a.date === b.date && (a.allDay || a.start === b.start)

// raw ops → checked ops. ctx: {where, now, tz, keys (inputFor), rules, lastMessage (uuid — the newest new message)}
// → {ops: [{op: 'create', item, people, message, basis} | {op: 'update', id, item, changed, people?, message, basis} | {op: 'cancel', id, message, basis}],
//    skipped: [{op, why}]}
export function checkOps(raw, { where, now = new Date(), tz, keys, rules = DEFAULTS, lastMessage = null }) {
  const zone = E.validTz(tz) || E.DEFAULT_TZ
  const list = (Array.isArray(raw) ? raw : []).filter((o) => o && typeof o === 'object' && !Array.isArray(o)).slice(0, MAX_OPS)
  const ops = [], skipped = []
  const horizon = new Date(now).getTime() + (rules.horizonDays || 366) * 864e5
  const messageOf = (k) => (where === 'room' ? keys.messages.get(String(k || '').trim())?.uuid || lastMessage : null)
  // people of this room only (a key the model made up is no one)
  const peopleOf = (o) => {
    if (where !== 'room' || o.for !== 'some') return null
    const ids = [...new Set((Array.isArray(o.people) ? o.people : []).map((k) => keys.members.get(String(k).trim())?.id).filter(Boolean).map(String))]
    return ids.length ? ids : null
  }
  const event = (r) => E.normalizeEvent(r, { tz: zone, now, defaultDurationMin: rules.defaultDurationMin || 60 })
  const usable = (ev) => (!E.ready(ev) ? 'incomplete' : ev.warnings.includes('past') ? 'past' : startOf(ev).getTime() > horizon ? 'too_far' : null)
  const extra = (o, cur = {}) => ({ bring: given(o.bring) ? clean(o.bring, 200) : cur.bring || '', notes: given(o.notes) ? clean(o.notes, 300) : cur.notes || '' })
  const made = []
  for (const o0 of list) {
    // (a field under another name the model may use for it: place → location)
    const o = !given(o0.location) && given(o0.place) ? { ...o0, location: o0.place } : o0
    const op = String(o.op || '').trim().toLowerCase()
    const basis = clean(o.basis, 200)
    if (op === 'create') {
      const ev = event({ title: o.title, date: o.date, start: o.start, end: o.end, durationMin: o.durationMin, allDay: o.allDay === true, timezone: o.timezone, location: o.location, link: o.link })
      const why = usable(ev)
      if (why) { skipped.push({ op, why, title: clean(o.title, 80) }); continue }
      const item = { title: ev.title, date: ev.date, start: ev.start, allDay: ev.allDay, tz: ev.tz, durationMin: ev.durationMin, location: ev.location, link: ev.link, ...extra(o) }
      // said again: a plan of the same name at the same time is the one already there
      if ([...keys.plans.values(), ...made].some((p) => sameTitle(p.title, item.title) && sameTime(p, item))) { skipped.push({ op, why: 'same', title: item.title }); continue }
      made.push(item)
      ops.push({ op, item, people: peopleOf(o), message: messageOf(o.message), basis })
    } else if (op === 'update' || op === 'cancel') {
      const cur = keys.plans.get(String(o.plan || '').trim())
      if (!cur) { skipped.push({ op, why: 'no_plan', plan: clean(o.plan, 20) }); continue }
      if (op === 'cancel') { ops.push({ op, id: cur.id, message: messageOf(o.message), basis }); continue }
      // only what was given changes: a date alone keeps the time, a time alone keeps the date
      const allDay = given(o.start) ? false : typeof o.allDay === 'boolean' ? o.allDay : !!cur.allDay
      const ev = event({
        title: given(o.title) ? o.title : cur.title, date: given(o.date) ? o.date : cur.date,
        start: allDay ? null : given(o.start) ? o.start : cur.start, allDay,
        durationMin: given(o.durationMin) ? o.durationMin : cur.durationMin, end: o.end,
        timezone: given(o.timezone) ? o.timezone : cur.tz, location: given(o.location) ? o.location : cur.location, link: given(o.link) ? o.link : cur.link,
      })
      const why = usable(ev)
      if (why) { skipped.push({ op, why, plan: cur.id }); continue }
      const item = { title: ev.title, date: ev.date, start: ev.start, allDay: ev.allDay, tz: ev.tz, durationMin: ev.durationMin, location: ev.location, link: ev.link, ...extra(o, cur) }
      const people = peopleOf(o)
      const changed = ['title', 'date', 'start', 'allDay', 'location', 'link', 'bring', 'notes', 'durationMin'].filter((k) => (item[k] ?? null) !== (cur[k] ?? null))
      const peopleChanged = !!people && [...people].sort().join() !== [...(cur.participants || [])].map(String).sort().join()
      if (!changed.length && !peopleChanged) { skipped.push({ op, why: 'same', plan: cur.id }); continue }
      ops.push({ op, id: cur.id, item, changed: [...changed, ...(peopleChanged ? ['people'] : [])], ...(peopleChanged ? { people } : {}), message: messageOf(o.message), basis })
    } else skipped.push({ op: op || '?', why: 'unknown' })
  }
  return { ops, skipped }
}
