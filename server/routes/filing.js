// 폴더에 정리 (lib/folders/filing.js): the folder suggested for a document that came in (a file card of mine, a file a teammate sent
// me, a mail's attachment), the folders I may pick by hand, and filing it there. Every call is the caller's own: someone else's card,
// share or mail is "not found", a folder I do not edit is refused by the folder's own check (service.js access).
import express from 'express'
import * as F from '../lib/folders/filing.js'
// a file dragged anywhere (lib/fileRefs.js): what it is, and putting it into a folder
import * as FR from '../lib/fileRefs.js'

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
  // a dropped file (src/fileDrag.js items) → a link (a shared folder's file) or a share (an artifact of mine), or why it is refused —
  // the messenger's and the AI chat's chips
  r.post('/files/resolve', auth, h(async (req) => ({ items: await FR.resolve(req.user, req.body?.items) })))
  // files dropped on a folder (its file list, or its row in the list): each becomes a file of that folder — editor of the folder,
  // a commit in my name, the same content not twice (filing.js file). dir: a sub-folder of it
  r.post('/folders/:slug/drop', auth, h(async (req) => ({ items: await FR.dropInto(req.user, String(req.params.slug), req.body?.items, { dir: req.body?.dir ? String(req.body.dir).slice(0, 200) : '' }) })))
  return r
}
