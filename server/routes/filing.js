// 폴더에 정리 (lib/folders/filing.js): the folder suggested for a document that came in (a file card of mine, a file a teammate sent
// me, a mail's attachment), the folders I may pick by hand, and filing it there. Every call is the caller's own: someone else's card,
// share or mail is "not found", a folder I do not edit is refused by the folder's own check (service.js access).
import express from 'express'
import * as F from '../lib/folders/filing.js'

const UUID = /^[0-9a-f-]{36}$/i
// {messageId} | {shareId} | {actionId, attachment}
export function refOf(b = {}) {
  if (b.messageId && UUID.test(String(b.messageId))) return { messageId: String(b.messageId) }
  if (b.shareId && UUID.test(String(b.shareId))) return { shareId: String(b.shareId) }
  if (b.actionId && UUID.test(String(b.actionId)) && b.attachment) return { actionId: String(b.actionId), attachment: String(b.attachment).slice(0, 200) }
  return {}
}

export function filingRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out) } catch (e) {
      if (!e.status) console.warn('[filing]', req.method, req.path, e.message)
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.status ? e.message : '처리하지 못했어요.' })
    }
  }
  // the suggestion, made once per document (kept on its card); refresh: ask again
  r.post('/filing/suggest', auth, h((req) => F.suggest(req.user, refOf(req.body), { refresh: req.body?.refresh === true })))
  // 다른 폴더 고르기
  r.get('/filing/folders', auth, h((req) => F.pickList(req.user, refOf(req.query))))
  // file it: {slug, sub} or {newFolder}
  r.post('/filing/file', auth, h((req) => F.file(req.user, refOf(req.body), {
    slug: req.body?.slug ? String(req.body.slug) : '', sub: req.body?.sub ? String(req.body.sub).slice(0, 200) : '', newFolder: req.body?.newFolder ? String(req.body.newFolder) : '',
  })))
  return r
}
