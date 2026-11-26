// 약속 알림 (lib/agenda/*, spec openspec/specs/agenda-reminders): Home's 「다가오는 약속」, 「이건 아니에요」, 「캘린더에 추가」, and the person's
// 약속 알림 settings. Every plan is read through the one privacy rule (lib/agenda/store.js VISIBLE): mine, of a room I am in now, or of my
// own mailbox — anything else is 404.
//   GET  /agenda                → {items, calendar, prefs}   (items: the next rules.upcomingDays days, soonest first)
//   POST /agenda/:id/dismiss    → {ok, status}
//   POST /agenda/:id/calendar   → {ok, plan, already?}
//   GET  /agenda/prefs · PUT /agenda/prefs {on, leadMin} → {on, leadMin, choices}
//   POST /agenda/test/tick {now} — a test stack's clock: the due reminders as of that moment are sent now (lib/agenda/fire.js fireDue).
//        Only with PRO_AGENDA_TEST_CLOCK=1 (production never sets it; otherwise there is no such path — 404), from this machine with no
//        proxy or tunnel in between (X-Forwarded-For · Forwarded · CF-Connecting-IP — a tunnel on the same host looks like this machine:
//        403), signed in (401) as an administrator of the company (403). Review #6.
import express from 'express'
import { L } from '../lib/lang.js'
import { q } from '../lib/supa.js'
import * as S from '../lib/agenda/store.js'
import { agendaSkill } from '../lib/agenda/read.js'
import { fireDue } from '../lib/agenda/fire.js'
import { isAdmin as teamAdmin } from '../lib/team.js'

const LOCAL = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
const PROXIED = ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'x-real-ip']

// deps (tests): {isAdmin, fire}
export function agendaRoutes(auth, { isAdmin = teamAdmin, fire = fireDue } = {}) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)) } catch (e) {
      if (!e.status) console.warn('[agenda]', req.method, req.path, e.message)
      res.status(e.status || 500).json({ error: e.status ? e.message : L('처리하지 못했어요.', "I couldn't do that."), ...(e.code ? { code: e.code } : {}) })
    }
  }
  const calendarOf = async (user) => {
    const [acc] = await q('select provider from pro_mail_accounts where user_id=$1', [user.id])
    return (await import('../lib/mailCard.js')).calendarMode(user.id, acc?.provider).catch(() => 'none')
  }
  r.get('/agenda', auth, h(async (req) => {
    const sk = await agendaSkill()
    const [items, calendar, prefs] = await Promise.all([S.upcoming(req.user, { days: Number(process.env.PRO_AGENDA_UPCOMING_DAYS) || sk.rules.upcomingDays || 7 }), calendarOf(req.user), S.prefsOf(req.user.id)])
    return { items, calendar, prefs: { on: prefs.on, leadMin: prefs.leadMin } }
  }))
  r.post('/agenda/:id/dismiss', auth, h((req) => S.dismiss(req.user, req.params.id)))
  r.post('/agenda/:id/calendar', auth, h((req) => S.addToCalendar(req.user, req.params.id)))
  r.get('/agenda/prefs', auth, h(async (req) => {
    const [p, sk] = await Promise.all([S.prefsOf(req.user.id), agendaSkill()])
    return { on: p.on, leadMin: p.leadMin, choices: sk.rules.leadChoices }
  }))
  r.put('/agenda/prefs', auth, h(async (req) => {
    const sk = await agendaSkill()
    const p = await S.savePrefs(req.user, { on: req.body?.on, leadMin: req.body?.leadMin }, { choices: sk.rules.leadChoices })
    return { ...p, choices: sk.rules.leadChoices }
  }))
  r.post('/agenda/test/tick', (req, res, next) => (process.env.PRO_AGENDA_TEST_CLOCK === '1' ? next() : res.status(404).end()), auth, async (req, res) => {
    if (!LOCAL.includes(req.socket.remoteAddress) || PROXIED.some((h) => req.headers[h] != null)) return res.status(403).json({ error: 'this machine only' })
    if (!(await isAdmin(req.user).catch(() => false))) return res.status(403).json({ error: 'administrators only' })
    const now = new Date(req.body?.now || Date.now())
    if (Number.isNaN(now.getTime())) return res.status(400).json({ error: 'now' })
    res.json({ sent: await fire({ now }) })
  })
  return r
}
