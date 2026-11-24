// 오늘의 배경 사진(lib/background): Home 의 날짜 · 날씨 패널이 묻는 그날의 후보, 한 사람의 선택, 회사 관리자의 스위치와 사진 사이트 키.
import express from 'express'
import { config } from '../config.js'
import { L, isEn } from '../lib/lang.js'
import * as team from '../lib/team.js'
import { candidatesFor, enabledFor, setEnabled, keyInfo, saveKey, pingDownload, KEYED } from '../lib/background/service.js'
import { loadPref, savePref, prefOf, activePhoto, PrefError } from '../lib/background/prefs.js'
import { parseDate, kstDate, addDays, fmtDate } from '../lib/background/calendar.js'
import { MOODS } from '../lib/background/themes.js'

// the person's date: a calendar date within a day of now anywhere on Earth (UTC−12 … UTC+14), else Korea's today
export function personDate(raw, now = Date.now()) {
  const utc = fmtDate(now)
  const s = String(raw || '')
  return parseDate(s) && [addDays(utc, -1), utc, addDays(utc, 1)].includes(s) ? s : kstDate(now)
}
const num = (v, lo, hi) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : null }
// what the screen says about the day of a candidate list, in its language
const dayView = (day, en) => ({
  date: day.date,
  term: { key: day.term.key, name: en ? day.term.en : day.term.ko, start: day.term.start, today: day.term.today, next: { name: en ? day.term.next.en : day.term.next.ko, start: day.term.next.start } },
  season: { key: day.season.key, name: en ? day.season.en : day.season.ko },
  part: day.part, weather: day.weather,
})

export function backgroundRoutes(auth) {
  const r = express.Router()
  const fail = (res, e, what) => {
    if (e instanceof PrefError || e.status) return res.status(e.status || 400).json({ error: e.message })
    console.warn(`[background] ${what}`, e.message)
    res.status(500).json({ error: L('배경을 처리하지 못했어요.', "Couldn't handle the background.") })
  }

  // the day's candidates (photos only — the screen puts the sky first) and my saved choice
  r.get('/background/today', auth, async (req, res) => {
    try {
      const date = personDate(req.query.date)
      const hour = num(req.query.hour, 0, 23.99) ?? 12
      const alt = num(req.query.alt, -90, 90)
      const wx = num(req.query.wx, 0, 99)
      const mood = MOODS.includes(String(req.query.mood || '')) ? String(req.query.mood) : null
      const en = isEn()
      const pref = await loadPref(req.user.id)
      if (!(await enabledFor())) {
        const { dayOf } = await import('../lib/background/calendar.js')
        return res.json({ enabled: false, day: dayView(dayOf({ date, hour, alt, wx }), en), candidates: [], pref })
      }
      const out = await candidatesFor({ tenant: config.tenantId, date, hour: Math.floor(hour), alt: alt == null ? null : Math.round(alt), wx: wx == null ? null : Math.round(wx), mood, en })
      // (never kept by the browser: the company switch and my choice in this answer must be today's — the photo sites' answers are
      // what the server keeps)
      res.set('Cache-Control', 'no-store').json({ enabled: true, day: dayView(out.day, en), mood, candidates: out.photos, pref })
    } catch (e) { fail(res, e, 'today') }
  })

  // my choice: {pref, active (the photo shown on that date, null = the sky), enabled}
  r.get('/background', auth, async (req, res) => {
    try {
      const pref = await loadPref(req.user.id)
      const on = await enabledFor()
      res.json({ enabled: on, pref, active: on ? activePhoto(pref, personDate(req.query.date)) : null })
    } catch (e) { fail(res, e, 'load') }
  })
  // choose a photo: {photo, keep: 'today'|'always', date}
  r.put('/background', auth, async (req, res) => {
    try {
      if (!(await enabledFor())) return res.status(403).json({ error: L('회사에서 인터넷 배경 사진을 껐어요.', 'Internet background photos are turned off for this company.') })
      const pref = prefOf({ photo: req.body?.photo, keep: req.body?.keep || 'today', day: personDate(req.body?.date) })
      await savePref(req.user, pref)
      // Unsplash: its download endpoint when one of its photos is used
      pingDownload(config.tenantId, pref.photo).catch(() => {})
      res.json({ pref })
    } catch (e) { fail(res, e, 'save') }
  })
  // back to the sky
  r.delete('/background', auth, async (req, res) => {
    try { await savePref(req.user, null); res.json({ pref: null }) } catch (e) { fail(res, e, 'clear') }
  })

  // the company: Settings › 시스템 설정 (administrators)
  const adminOnly = async (req, res, next) => (await team.isAdmin(req.user)) ? next() : res.status(403).json({ error: L('회사 관리자만 바꿀 수 있어요.', 'Only a company administrator can change this.') })
  r.get('/admin/background', auth, adminOnly, async (req, res) => {
    try { res.json({ enabled: await enabledFor(config.tenantId), keys: await keyInfo(config.tenantId) }) } catch (e) { fail(res, e, 'admin') }
  })
  r.put('/admin/background', auth, adminOnly, async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: L('켜기 · 끄기 중 하나를 골라 주세요.', 'Choose on or off.') })
    try { res.json(await setEnabled(config.tenantId, req.body.enabled, req.user.id)) } catch (e) { fail(res, e, 'switch') }
  })
  // a photo site's key (empty = remove it). Never sent back.
  r.put('/admin/background/keys/:provider', auth, adminOnly, async (req, res) => {
    if (!KEYED.includes(req.params.provider)) return res.status(404).json({ error: L('없는 사진 사이트예요.', 'No such photo site.') })
    try { res.json({ keys: await saveKey(config.tenantId, req.params.provider, req.body?.key, req.user.id) }) } catch (e) { fail(res, e, 'key') }
  })
  return r
}
