// Plans in a new mail (spec openspec/specs/agenda-reminders 「메일에서 정한 약속」): read where the mail assistant reads new mail
// (lib/mail.js pollUser — not the person's own mail, not the demo mailbox's sample mails), for the mailbox's owner only. The owner's plans
// from mail still ahead go with it, so a later mail can move or cancel one (「장소가 바뀌었습니다」). The gate first (most mail ends there),
// then the reading, then the ops made rows (lib/agenda/read.js · store.js). A model that could not be read leaves the mail unread for plans.
import * as R from './read.js'
import * as S from './store.js'
import { config } from '../../config.js'

export const stats = { read: 0, gated: 0, made: 0, failed: 0 }

// mail: {id, from, subject, date, text}; actionId: the Home card the mail made (its sheet is where the reminder opens the mail)
export async function fromMail(userId, mail, { actionId = null, deps = {} } = {}) {
  if (process.env.PRO_AGENDA_MAIL === '0' || !mail?.id || mail.fixture) return { skipped: 'off' }
  const sk = await R.agendaSkill()
  if (!sk.rules.mail) return { skipped: 'off' }
  const now = deps.now || new Date()
  const tz = sk.rules.timezone
  const plans = await S.livePlans({ kind: 'mail', owner: userId }, { now })
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
  const applied = await S.applyOps({ kind: 'mail', owner: userId, mail: { id: mail.id, subject: mail.subject || '', from: mail.from || '', actionId } }, ops,
    { now, model: { model: config.llm.model, skill: sk.version, gate: g } })
  stats.made += applied.length
  if (applied.length) console.log(`[agenda] mail ${String(mail.id).slice(0, 12)}: ${applied.map((a) => `${a.op} 「${a.item.title}」`).join(', ')}`)
  return { gate: g, ops: applied, skipped }
}
