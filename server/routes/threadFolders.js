// A thread's folder (lib/folders/threadFolders.js): 📎 폴더 붙이기 in chat attaches one for reference, the
// chip's × takes it off. A project's own folder is chosen when the project is made (POST /api/threads).
import express from 'express'
import { getThread } from '../lib/store.js'
import * as TF from '../lib/folders/threadFolders.js'

export function threadFolderRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try {
      const t = await getThread(req.user.id, req.params.id)
      if (!t || !['chat', 'project'].includes(t.kind)) return res.status(404).json({ error: 'thread not found' })
      res.json({ folder: await fn(req, t) })
    } catch (e) {
      if (!e.status) console.warn('[thread folders]', req.method, req.path, e.message)
      res.status(e.status || 500).json({ error: e.message })
    }
  }
  r.get('/threads/:id/folder', auth, h((req, t) => TF.folderPayload(t.id)))
  r.post('/threads/:id/folder', auth, h((req, t) => TF.attach({ id: req.user.id, name: req.user.name, email: req.user.email }, t, req.body?.folder)))
  r.delete('/threads/:id/folder', auth, h((req, t) => TF.detach(req.user, t)))
  return r
}
