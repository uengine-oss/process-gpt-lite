// Plans in a new mail (spec openspec/specs/agenda-reminders 「메일에서 정한 약속」): read where the mail assistant reads new mail
// (lib/mail.js pollUser — not the person's own mail, not the demo mailbox's sample mails), for the mailbox's owner only, and only while the
// owner has 약속 알림 on (review #3). The owner's mail plans still ahead from the same sender or the same thread go with it, so a later mail
// of that conversation can move or cancel one (「장소가 바뀌었습니다」) — a mail from anyone else neither sees nor changes them (review #1).
// The gate first (most mail ends there), then the reading, then the ops made rows (lib/agenda/read.js · store.js). A model that could not
// be read leaves the mail unread for plans. One owner's mails are read one after another (review #2: two read at once both saw no plan
// yet and both made it).
import * as R from './read.js'
import * as S from './store.js'
import { config } from '../../config.js'
import { addrOf } from '../mailSelf.js'

export const stats = { read: 0, gated: 0, made: 0, failed: 0, off: 0 }

// An address many people write from — a mailing list or group (Gmail rewrites From to the group's, and keeps the writer in X-Original-Sender),
// a platform's automatic sender — is not one person: its mails change a plan only in that plan's own thread (re-review #2). Told by the
// mail's headers only, never by words in the address: List-Id, List-Unsubscribe, Precedence: bulk · list · junk, Auto-Submitted other than
// 「no」, an X-Original-Sender other than From. → the reason, or null
export function sharedSender(mail = {}) {
  const v = (x) => String(x ?? '').trim()
  if (v(mail.listId)) return 'list-id'
  if (v(mail.listUnsubscribe)) return 'list-unsubscribe'
  if (['bulk', 'list', 'junk'].includes(v(mail.precedence).toLowerCase())) return 'precedence'
  const auto = v(mail.autoSubmitted).toLowerCase()
  if (auto && auto !== 'no') return 'auto-submitted'
  const original = addrOf(mail.xOriginalSender)
  if (original && original !== addrOf(mail.from)) return 'rewritten-from'
  return null
}

// one owner's readings run one after another — in this server process (two servers each keep their own line)
const queues = new Map() // tenant:owner → the tail of that owner's readings
// mail: {id, from, subject, date, text, thread}; actionId: the Home card the mail made (its sheet is where the reminder opens the mail)
export function fromMail(userId, mail, opts = {}) {
  const key = `${config.tenantId}:${userId}`
  const run = (queues.get(key) || Promise.resolve()).then(() => readMail(userId, mail, opts))
  const tail = run.catch(() => {})
  queues.set(key, tail)
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return run
}
// a poll's mails, one after another: [{mail, actionId}]
export async function fromMails(userId, list) {
  const out = []
  for (const { mail, actionId } of list) out.push(await fromMail(userId, mail, { actionId }).catch((e) => { console.warn('[agenda] mail', e.message); return { error: e.message } }))
  return out
}

async function readMail(userId, mail, { actionId = null, deps = {} } = {}) {
  if (process.env.PRO_AGENDA_MAIL === '0' || !mail?.id || mail.fixture) return { skipped: 'off' }
  const sk = await R.agendaSkill()
  if (!sk.rules.mail) return { skipped: 'off' }
  // (the owner turned 약속 알림 off: their mail is not sent to the model for plans)
  if (!(await S.prefsOf(userId)).on) { stats.off++; return { skipped: 'off' } }
  const now = deps.now || new Date()
  const tz = sk.rules.timezone
  const sender = addrOf(mail.from)
  const scope = { kind: 'mail', owner: userId, mail: { id: mail.id, subject: mail.subject || '', from: mail.from || '', sender, thread: mail.thread || null, actionId,
    ...(sharedSender(mail) ? { shared: true } : {}) } }
  const plans = await S.livePlans(scope, { now })
  const { input, keys } = R.inputFor({ where: 'mail', now, tz, plans, mail, rules: sk.rules })
  stats.read++
  const g = await R.gate(input, { skill: sk, ...(deps.decide ? { decide: deps.decide } : {}) })
  if (!g) { stats.failed++; return { skipped: 'gate_unreadable' } }
  if (!g.pass) { stats.gated++; return { gate: g, ops: [] } }
  let raw
  try { raw = await R.extract(input, { skill: sk, ...(deps.json ? { json: deps.json } : {}) }) } catch (e) {
    stats.failed++
    console.warn('[agenda] read mail', e.message)
    return { skipped: 'read_failed', gate: g }
  }
  const { ops, skipped } = R.checkOps(raw, { where: 'mail', now, tz, keys, rules: sk.rules })
  const applied = await S.applyOps(scope, ops, { now, model: { model: config.llm.model, skill: sk.version, gate: g } })
  stats.made += applied.length
  if (applied.length) console.log(`[agenda] mail ${String(mail.id).slice(0, 12)}: ${applied.map((a) => `${a.op} 「${a.item.title}」`).join(', ')}`)
  return { gate: g, ops: applied, skipped }
}
