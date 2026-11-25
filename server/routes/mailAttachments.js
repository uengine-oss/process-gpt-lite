// HTTP routes for a mail's attachments (lib/mailAttachments.js) — the owner opens one where it belongs (IeumOffice · the viewer · a
// download), saves an edited copy as their own private file card, and this server streams the bytes to whoever may read them now.
//   POST /mail/attachments/:card/:n/open   {name, download?} → {how: office|view|download, url, name, …}   the owner only (else 404)
//   POST /mail/attachments/:card/:n/saved  {session} → {message, where}                          the editor saved a copy (not in a folder)
//   GET  /mail/attachments/:card/:n/raw    ?u&exp[&r][&inline]&sig  (or signed in: the owner)    the bytes — checked again every time
//   GET  /mail/attachments/:card/shares    → {shares: [{i, name, room, title, at}]}                   the rooms the owner shares them with
//   POST /mail/attachments/:card/:n/unshare {room} → {shares}                                       the owner stops one (in that room or not)
// No address handed out here is a public storage address; nothing here writes an attachment's name or bytes to the log.
import express from 'express'
import * as MA from '../lib/mailAttachments.js'
import * as P from '../lib/privateStore.js'
import { asTenantOf } from '../lib/tenant.js'
import { L } from '../lib/lang.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  // (no message: it may name the attachment — only what kind of failure it was)
  if (!e.status) console.warn('[mail-att]', e.code || e.name || 'error')
  res.status(e.status || 500).json({ error: e.status ? e.message : L('첨부를 열지 못했어요. 잠시 후 다시 시도해 주세요.', "Couldn't open the attachment. Please try again in a moment."), ...(e.code && { code: e.code }) })
})

export function mailAttachmentRoutes(auth) {
  const r = express.Router()
  r.post('/mail/attachments/:id/:i/open', auth, (req, res) => send(res, MA.open(req.user, req.params.id, req.params.i, { name: req.body?.name, download: req.body?.download === true })))
  r.post('/mail/attachments/:id/:i/saved', auth, (req, res) => send(res, MA.saved(req.user, req.params.id, req.params.i, { session: req.body?.session })))
  // the rooms this mail's attachments are shared with, and 「끄기」 — the owner only, in a room or not (any more)
  r.get('/mail/attachments/:id/shares', auth, (req, res) => send(res, MA.sharesOf(req.user, req.params.id)))
  r.post('/mail/attachments/:id/:i/unshare', auth, (req, res) => send(res, MA.unshare(req.user, req.params.id, req.params.i, String(req.body?.room || ''))))
  r.get('/mail/attachments/:id/:i/raw', (req, res, next) => {
    // a signed address (the viewer, 「내려받기」, a colleague's link): it names the person (and the room) instead of a token. A valid
    // signature only says who asks — the access check follows (MA.rawOf). Expired: 401 (the page asks again); altered: 403.
    if (!req.headers.authorization && req.query.sig) {
      const u = String(req.query.u || '')
      return asTenantOf(u, () => {
        let v = 'bad'
        try { v = MA.checkLink({ actionId: req.params.id, i: req.params.i, u, r: req.query.r ? String(req.query.r) : '', exp: req.query.exp, sig: req.query.sig, inline: req.query.inline }) } catch { /* no key: refused */ }
        if (v !== 'ok') return res.status(v === 'expired' ? 401 : 403).json({ error: v === 'expired' ? L('주소가 만료됐어요. 다시 열어 주세요.', 'This address has expired. Please open it again.') : L('주소가 맞지 않아요.', "This address isn't valid.") })
        req.user = { id: u.toLowerCase() }
        req.attRoom = req.query.r ? String(req.query.r) : ''
        next('route')
      })
    }
    next()
  }, auth, (req, res, next) => next('route'))
  r.get('/mail/attachments/:id/:i/raw', async (req, res) => {
    try {
      const f = await MA.rawOf(req.user, req.params.id, req.params.i, { room: req.attRoom || '' })
      const s = await P.stream(f.key, req.headers.range)
      res.status(s.status)
      for (const k of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (s.headers.get(k)) res.setHeader(k, s.headers.get(k))
      res.setHeader('Content-Type', f.type)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      // nothing in it runs on this origin (an SVG opened by itself draws, its script does not)
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
      // inline=1: a picture · sound · video shown in place; anything else is a download
      const inline = req.query.inline === '1' && /^(image|audio|video)\//i.test(f.type)
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      res.setHeader('Cache-Control', 'private, max-age=60')
      res.setHeader('Referrer-Policy', 'no-referrer')
      if (!s.body) return void res.end()
      const { Readable } = await import('node:stream')
      await new Promise((ok) => { const x = Readable.fromWeb(s.body); x.on('error', () => { res.destroy(); ok() }); res.on('close', () => { x.destroy(); ok() }); x.pipe(res) })
    } catch (e) {
      if (!e.status) console.warn('[mail-att] raw', e.code || e.name || 'error')
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.status ? e.message : L('첨부를 가져오지 못했어요.', "Couldn't fetch the attachment.") })
      else res.destroy()
    }
  })
  return r
}
