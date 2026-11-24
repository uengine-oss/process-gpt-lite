// What a mail's Home card is for, and the calendar card's event. 2026-11-24 운영(「캘린더에 추가를 눌렀더니 왠 답장하기가 열리는...」):
// the brief's chip 「Add · 내일 오후 3시 UiPath 웨비나를 캘린더에 추가합니다」 opened the mail sheet on its reply composer — the sheet
// showed 답장 for every card, and the card's own task was only 「에이전트에게 맡기기」 at its bottom. Now the sheet's main action follows
// the card, and still nothing is sent or made before the person presses its button (D-1123-02).
//   kindOf      — the card's kind as known: 'reply' (the triage's 「Reply」, or a card that came with the documents made for the mail —
//                 lib/mailReply.js isReplyCard), else what the triage or the judge said (source.kind), else null (not decided yet)
//   kindOfCard  — GET /actions/:id/kind: decided once by the judge for a card the triage made before it said the kind (skill
//                 mail-card-actions, prompts/choose-kind.md — first-token odds over calendar · reply · task, lib/decide.js choose; JSON
//                 when the model gives no odds; below rules.minConfidence → task) and kept on the card (pro_actions.source.kind). When
//                 the model cannot be read the answer is the fallback (task), not kept — asked again next time.
//   eventOfCard — GET /actions/:id/event: the calendar card's event, read once by the model from the mail and the card
//                 (prompts/read-event.md), checked and normalized (lib/calendarEvent.js), kept on the card (source.event_draft)
//   addEvent    — POST /actions/:id/event (「캘린더에 추가」): the event as the person left it; the same event already in their Google
//                 Calendar is said (「이미 캘린더에 있어요」), not made twice; else made (lib/google.js calendarCreate). A demo mailbox
//                 records it only. The card is done and keeps the event (source.event).
// No new table: everything stays on the card (pro_actions.source jsonb).
import { config } from '../config.js'
import { q } from './supa.js'
import { chatJson } from './llm.js'
import { choose } from './decide.js'
import { getSecret } from './vault.js'
import { emit } from './bus.js'
import { mainThread, addMessage } from './store.js'
import { L, isEn } from './lang.js'
import { skillPack } from './skillPack.js'
import { isReplyCard, originalOf, formatAddress } from './mailReply.js'
import * as E from './calendarEvent.js'

export const SKILL = 'mail-card-actions'
export const KINDS = ['calendar', 'reply', 'task']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULTS = { timezone: E.DEFAULT_TZ, minConfidence: 0.6, timeoutMs: 8000, textChars: 6000, defaultDurationMin: 60 }
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

export async function cardSkill() {
  const s = await skillPack(SKILL)
  return { ...s, rules: { ...DEFAULTS, ...s.rules } }
}

export function kindOf(a) {
  if (!a?.source?.mail_id) return null
  if (isReplyCard(a)) return 'reply'
  return KINDS.includes(a.source.kind) ? a.source.kind : null
}

// the card by its id: someone else's card is refused (403), not read
async function cardFor(userId, id) {
  const [a] = UUID.test(String(id)) ? await q('select * from pro_actions where id=$1', [String(id)]) : []
  if (!a) throw fail(404, L('카드를 찾지 못했어요.', "This card couldn't be found."))
  if (a.user_id !== userId) throw fail(403, L('다른 사람의 카드예요.', "This card belongs to someone else."), 'not_yours')
  if (!a.source?.mail_id) throw fail(400, L('메일에서 온 카드가 아니에요.', "This card didn't come from a mail."))
  return a
}
async function providerOf(userId) {
  const [acc] = await q('select provider, address from pro_mail_accounts where user_id=$1', [userId])
  if (!acc) throw fail(409, L('연결된 메일함이 없어요. 설정에서 메일을 연결해 주세요.', 'No mailbox is connected. Connect your mail in Settings.'))
  return acc
}

// ---------- what the card is for ----------
const kindOptions = () => [
  { key: 'calendar', label: L('일정 — 그 사람의 캘린더에 일정을 넣는 일', "Calendar — put an event on the person's calendar") },
  { key: 'reply', label: L('답장 — 메일을 보낸 사람에게 답장을 쓰는 일', 'Reply — write the sender a reply mail') },
  { key: 'task', label: L('그 밖의 일 — 확인 · 검토 · 납부 · 처리 등', 'Something else — check, review, pay, handle …') },
]
// what the judge reads: the card (its button, its words, what pressing it does) and the mail it came from
export const kindState = (a) => [L('메일 카드:', 'The mail card:'),
  `- ${L('단추', 'Button')}: ${clean(a.verb)}`, `- ${L('카드 글', 'Card text')}: ${clean(a.text)}`,
  a.prompt ? `- ${L('누르면 할 일', 'What pressing it does')}: ${clean(a.prompt).slice(0, 600)}` : '',
  L('받은 메일:', 'The mail:'), `- ${L('보낸 사람', 'From')}: ${clean(a.source?.from)}`, `- ${L('제목', 'Subject')}: ${clean(a.source?.subject)}`,
].filter(Boolean).join('\n')

// → {kind, p, by: 'logprob'|'json', model, unsure?} or null (the model could not be read)
export async function decideKind(a, { judges = {}, skill } = {}) {
  const sk = skill || await cardSkill()
  const r = await choose(kindState(a), sk.prompts['choose-kind'], kindOptions(), { ...judges, answerJson: sk.prompts['answer-json'], timeoutMs: sk.rules.timeoutMs })
  if (!r) return null
  const sure = r.confidence >= (sk.rules.minConfidence ?? 0.6)
  return { kind: sure ? r.choice : 'task', p: r.confidence, by: r.strategy, model: r.model || null, ...(sure ? {} : { unsure: r.choice }), skill: sk.version }
}

const deciding = new Map()
// GET /actions/:id/kind → {kind, by, p}
export async function kindOfCard(user, actionId, deps = {}) {
  const a = await cardFor(user.id, actionId)
  const known = kindOf(a)
  if (known) return { kind: known, by: a.source.kind_read?.by || (isReplyCard(a) ? 'card' : 'triage'), p: a.source.kind_read?.p ?? null }
  const key = `${config.tenantId}:${a.id}`
  if (!deciding.has(key)) {
    deciding.set(key, (async () => {
      const d = await decideKind(a, deps).catch((e) => { console.warn('[mail card] kind', e.message); return null })
      // the model could not be read: the card's own task, asked again next time
      if (!d) return { kind: 'task', by: 'fallback', p: null }
      const read = { by: d.by, p: d.p, model: d.model, skill: d.skill, at: new Date().toISOString(), ...(d.unsure ? { unsure: d.unsure } : {}) }
      // (a kind the triage or another screen said meanwhile is kept)
      const [row] = await q(`update pro_actions set source = source || jsonb_build_object('kind', $2::text, 'kind_read', $3::jsonb)
                             where id=$1 and not (source ? 'kind') returning *`, [a.id, d.kind, read])
      if (row) emit(user.id, 'action', row)
      return { kind: row ? d.kind : kindOf((await q('select * from pro_actions where id=$1', [a.id]))[0]) || d.kind, by: d.by, p: d.p }
    })().finally(() => deciding.delete(key)))
  }
  return deciding.get(key)
}

// ---------- the calendar ----------
// how an event is made: in the person's Google Calendar (a Google connection allowed to write events), recorded only (the demo
// mailbox), or not (no Google connection — 'none'; one without calendar permission — 'scope')
const CAL_SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.events.owned']
export async function calendarMode(userId, provider) {
  if (provider === 'demo') return 'demo'
  const sec = await getSecret(userId, 'oauth', config.google.vaultSite)
  if (!sec) return 'none'
  return String(sec.scope || '').split(/\s+/).some((s) => CAL_SCOPES.includes(s)) ? 'google' : 'scope'
}
const modeError = (mode) => mode === 'scope'
  ? fail(403, L('Google 캘린더에 일정을 넣을 권한이 없어요. 설정에서 Google을 다시 연결해 주세요.', "Google hasn't allowed adding calendar events. Connect Google again in Settings."), 'calendar_scope')
  : fail(403, L('Google 캘린더가 연결되어 있지 않아요. 설정에서 Google을 연결해 주세요.', "Google Calendar isn't connected. Connect Google in Settings."), 'calendar_none')

// The event the card means, read by the model from the mail and the card. mail: {from, subject, date, text} (or null when the mail
// is gone: the card alone). → normalized event + read: 'model' | 'failed'
export async function readEvent({ card, mail, tz, now = new Date() }, { skill, json = chatJson } = {}) {
  const sk = skill || await cardSkill()
  const zone = E.validTz(tz) || E.validTz(sk.rules.timezone) || E.DEFAULT_TZ
  const got = E.localParts(mail?.date ? new Date(mail.date) : now, zone)
  const today = E.localParts(now, zone)
  const input = {
    today: `${today.date} (${E.WEEKDAY_EN[today.weekday]})`, timezone: zone,
    mailReceived: `${got.date} (${E.WEEKDAY_EN[got.weekday]}) ${got.time}`,
    card: { button: card.verb, text: card.text, todo: card.prompt || '' },
    mail: mail ? { from: mail.from ? formatAddress(mail.from) : card.source?.from || '', subject: mail.subject || '', text: String(mail.text || '').slice(0, sk.rules.textChars || 6000) }
      : { from: card.source?.from || '', subject: card.source?.subject || '', text: '' },
  }
  let raw = null, why = null
  try { raw = await json(sk.prompts['read-event'], JSON.stringify(input), { timeoutMs: 45000, temperature: 0 }) } catch (e) { why = e.message }
  const usable = raw && typeof raw === 'object' && !Array.isArray(raw)
  const ev = E.normalizeEvent(usable ? raw : {}, { tz: zone, now, fallbackTitle: input.mail.subject || card.text, defaultDurationMin: sk.rules.defaultDurationMin })
  return { ...ev, read: usable ? 'model' : 'failed', ...(why ? { why: why.slice(0, 200) } : {}), at: new Date().toISOString(), skill: sk.version }
}

const reading = new Map()
// GET /actions/:id/event?tz= → {mode, draft, event?}
export async function eventOfCard(user, actionId, { tz } = {}, deps = {}) {
  const a = await cardFor(user.id, actionId)
  if (kindOf(a) !== 'calendar') throw fail(400, L('일정을 넣는 카드가 아니에요.', "This card isn't one that adds an event."), 'not_calendar')
  const acc = await providerOf(user.id)
  const mode = await calendarMode(user.id, acc.provider)
  if (a.source.event || a.source.event_draft) return { mode, draft: a.source.event_draft || null, ...(a.source.event ? { event: a.source.event } : {}) }
  const key = `${config.tenantId}:${a.id}`
  if (!reading.has(key)) {
    reading.set(key, (async () => {
      // (a mail no longer in the mailbox: the card's own words)
      const mail = await originalOf(user.id, acc.provider, a.source.mail_id).catch(() => null)
      const draft = await readEvent({ card: a, mail, tz, now: deps.now }, { json: deps.json })
      const [row] = await q(`update pro_actions set source = source || jsonb_build_object('event_draft', $2::jsonb) where id=$1 returning *`, [a.id, draft])
      if (row) emit(user.id, 'action', row)
      return draft
    })().finally(() => reading.delete(key)))
  }
  return { mode, draft: await reading.get(key) }
}

// POST /actions/:id/event {title, date, start, durationMin, allDay, location, link, description, tz}
// deps.google: {calendarList, calendarCreate} (tests); deps.now
export async function addEvent(user, actionId, input = {}, deps = {}) {
  const a = await cardFor(user.id, actionId)
  if (kindOf(a) !== 'calendar') throw fail(400, L('일정을 넣는 카드가 아니에요.', "This card isn't one that adds an event."), 'not_calendar')
  // pressed a second time (another screen, an old page): it is there already
  if (a.source.event) return { ok: true, already: true, event: a.source.event, action: a }
  const sk = await cardSkill()
  const tz = E.validTz(input.tz) || a.source.event_draft?.tz || E.validTz(sk.rules.timezone) || E.DEFAULT_TZ
  // the form is in the person's own zone: its time is taken as it is
  const ev = E.normalizeEvent({ ...input, timezone: tz }, { tz, now: deps.now || new Date(), defaultDurationMin: sk.rules.defaultDurationMin })
  if (ev.missing.includes('title')) throw fail(400, L('일정 제목을 적어 주세요.', 'Give the event a title.'), 'event_title')
  if (ev.missing.includes('date')) throw fail(400, L('날짜를 넣어 주세요.', 'Add the date.'), 'event_date')
  if (ev.missing.includes('start')) throw fail(400, L('시작 시각을 넣거나 종일로 두세요.', 'Add a start time, or make it all day.'), 'event_start')
  const acc = await providerOf(user.id)
  const mode = await calendarMode(user.id, acc.provider)
  if (mode === 'none' || mode === 'scope') throw modeError(mode)
  // one event per card, even when two presses arrive together: the card is claimed first, and the claim is lifted only when
  // Google refused (nothing was made)
  const [claimed] = await q(`update pro_actions set source = source || jsonb_build_object('adding', now()) where id=$1 and user_id=$2
                             and not (source ? 'event') and not (source ? 'adding') returning id`, [a.id, user.id])
  if (!claimed) throw fail(409, L('이 일정은 이미 캘린더에 넣는 중이거나 넣었어요.', 'This event is already being added, or was added.'), 'event_busy')
  let made = null, existing = null
  try {
    if (mode === 'google') {
      const G = deps.google || await import('./google.js')
      const w = E.eventWindow(ev)
      existing = E.findSame(await G.calendarList(user.id, { timeMin: w.timeMin, timeMax: w.timeMax }), ev)
      if (!existing) {
        const description = [ev.description, ev.link && ev.link !== ev.location ? ev.link : '',
          L(`메일: ${a.source.subject || ''} — ${a.source.from || ''}`, `Mail: ${a.source.subject || ''} — ${a.source.from || ''}`)].filter(Boolean).join('\n\n')
        made = await G.calendarCreate(user.id, {
          summary: ev.title, start: ev.allDay ? ev.date : E.eventStart(ev).toISOString(), durationMin: ev.durationMin,
          description, location: ev.location || ev.link || undefined, timeZone: ev.tz,
        })
      }
    }
  } catch (e) {
    await q(`update pro_actions set source = source - 'adding' where id=$1`, [a.id]).catch(() => {})
    console.warn('[mail card] calendar', e.message)
    throw fail(502, L(`Google 캘린더가 요청을 받지 않았어요 (${String(e.message).slice(0, 160)}).`, `Google Calendar didn't accept the request (${String(e.message).slice(0, 160)}).`), 'calendar_error')
  }
  const got = existing || made
  const event = {
    // (the event's page in Google Calendar — an http(s) address only: it becomes a link on the sheet)
    via: mode, existing: !!existing, id: got?.id || null, htmlLink: E.validLink(got?.htmlLink) || null,
    title: ev.title, date: ev.date, start: ev.start, durationMin: ev.durationMin, allDay: ev.allDay, tz: ev.tz,
    location: ev.location, link: ev.link, when: E.whenText(ev, isEn() ? 'en' : 'ko'), at: new Date().toISOString(),
  }
  let row
  for (let i = 0; !row; i++) {
    try {
      ;[row] = await q(`update pro_actions set status='done', source = (source - 'adding') || jsonb_build_object('event', $2::jsonb) where id=$1 returning *`, [a.id, event])
    } catch (e) {
      if (i >= 2) { console.warn('[mail card] event made but not recorded', a.id, e.message); throw fail(500, L('일정은 넣었지만 기록하지 못했어요. 다시 누르지 말고 캘린더를 확인해 주세요.', "The event was added but couldn't be recorded. Don't press again — check your calendar.")) }
      await new Promise((ok) => setTimeout(ok, 500 * (i + 1)))
    }
  }
  emit(user.id, 'action', row)
  // said where the mail's work is (its instance, else the main chat), with the mail's chip — as a sent reply is (lib/mailReply.js)
  const inst = row.source?.inst?.instId ? row.source.inst : null
  const { instanceThread } = await import('./engine.js')
  const where = inst ? await instanceThread(user.id, inst.instId, inst.name) : (await mainThread(user.id)).id
  await addMessage(user.id, where, 'agent', 'text', {
    text: event.via === 'demo'
      ? L(`데모 메일함이라 「${event.title}」(${event.when})을 실제 캘린더에 넣지 않고 기록만 했어요.`, `This is the demo mailbox, so "${event.title}" (${event.when}) was recorded, not added to a real calendar.`)
      : event.existing
        ? L(`「${event.title}」은 이미 캘린더에 있어요 · ${event.when}`, `"${event.title}" is already on your calendar · ${event.when}`)
        : L(`캘린더에 「${event.title}」을 넣었어요 · ${event.when}`, `I added "${event.title}" to your calendar · ${event.when}`),
    calendar_event: { title: event.title, when: event.when, via: event.via, existing: event.existing, link: event.htmlLink },
    mail: { from: a.source.from || '', subject: a.source.subject || '', actionId: a.id, mailId: a.source.mail_id, ...(inst ? { inst: { instId: inst.instId, name: inst.name || '' } } : {}) },
    ...(inst ? { mailEvent: 'calendar' } : {}),
  })
  return { ok: true, event, action: row }
}
