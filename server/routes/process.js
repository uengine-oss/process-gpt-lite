// HTTP routes for process definitions, instances, work items and files.
import express from 'express'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q, admin } from '../lib/supa.js'
import * as proc from '../lib/processes.js'
import { hiddenTodos, hideTodo } from '../lib/homeCards.js'
import * as engine from '../lib/engine.js'
import { updateMessage } from '../lib/store.js'
import { saveGenerated, installGeneratedSkills } from '../lib/generated.js'
import { markOpened } from '../lib/improve/signal.js'
import { retryNow } from '../lib/stepRetry.js'
import { linkInstance } from '../lib/folders/threadFolders.js'

export function processRoutes(auth) {
  const r = express.Router()

  r.get('/processes', auth, async (req, res) => res.json(await proc.listDefinitions(req.query.q)))
  r.get('/processes/:id', auth, async (req, res) => {
    const d = await proc.getDefinition(req.params.id)
    return d ? res.json(d) : res.status(404).end()
  })
  r.get('/processes/:id/bpmn', auth, async (req, res) => {
    const xml = await proc.getBpmn(req.params.id)
    return xml ? res.type('application/xml').send(xml) : res.status(404).end()
  })
  r.post('/processes/:id/start', auth, async (req, res) => {
    try {
      const out = await engine.startProcess({ me: req.user, session: req.session, defId: req.params.id, values: req.body.values || {}, messageId: req.body.messageId })
      // started from a project with a folder: its agent steps work on the project's variation (lib/folders/threadFolders.js)
      await linkInstance(req.user.id, req.body.messageId, out?.instId).catch((e) => console.warn('[start] project folder', e.message))
      res.json(out)
    } catch (e) { console.warn('[start]', e.message); res.status(500).json({ error: e.message }) }
  })

  r.get('/instances', auth, async (req, res) => res.json(await proc.listInstances({ userEmail: req.user.email, userId: req.user.id, status: req.query.status })))
  r.get('/instances/:id', auth, async (req, res) => {
    if (!(await proc.canSeeInstance(req.params.id, req.user))) return res.status(403).json({ error: '이 프로세스를 볼 권한이 없어요.' })
    const d = await proc.getInstance(req.params.id, req.user)
    if (!d) return res.status(404).end()
    // one conversation per instance and person, created on first view (or by a mail / schedule that started it)
    res.json({ ...d, threadId: await engine.instanceThread(req.user.id, req.params.id, d.inst.proc_inst_name || d.def?.name) })
  })

  // (a work item put away from Home is marked, not left out: Home hides it, everything else still lists it)
  r.get('/todos', auth, async (req, res) => {
    const [list, hidden] = await Promise.all([proc.myTodos(req.user), hiddenTodos(req.user.id)])
    res.json(list.map((t) => (hidden.has(String(t.id)) ? { ...t, home_hidden: true } : t)))
  })
  // Home is notifications: a work item's card can be put away; the work item stays mine (루틴 lists it)
  r.post('/todos/:id/dismiss', auth, async (req, res) => {
    const t = (await proc.myTodos(req.user)).find((x) => String(x.id) === String(req.params.id))
    if (!t) return res.status(404).end()
    await hideTodo(req.user.id, t.id, t.activity_name)
    res.json({ ok: true })
  })
  r.get('/todos/:id', auth, async (req, res) => {
    const d = await proc.getTodo(req.params.id)
    if (!d) return res.status(404).end()
    // the assignee opening the item is when the person started on it (lib/improve/signal.js)
    markOpened(d.todo, req.user).catch((e) => console.warn('[improve] opened', e.message))
    res.json(d)
  })
  // save a generated definition (deepagents process_result) the way the process-gpt UI's save button does
  r.post('/drafts/:msgId/save', auth, async (req, res) => {
    const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2 and m.kind='process_draft'`, [req.params.msgId, req.user.id])
    if (!m) return res.status(404).end()
    try {
      const saved = await saveGenerated(m.content.contract, m.content.workDir)
      // the generation's own skills, so its agent steps find them (lib/generated.js)
      saved.skills_installed = await installGeneratedSkills(m.content.workDir, { jwt: req.session?.access_token, ownerId: req.user.id }).catch((e) => { console.warn('[save-generated] skills', e.message); return [] })
      await updateMessage(req.user.id, m.id, { state: 'saved', defId: saved.proc_def_id, saved })
      res.json(saved)
    } catch (e) {
      console.warn('[save-generated]', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  // Home action → the instance page, where the form is (no card in the chat)
  r.post('/todos/:id/open', auth, async (req, res) => {
    const d = await proc.getTodo(req.params.id)
    if (!d) return res.status(404).end()
    res.json({ instId: d.todo.proc_inst_id })
  })
  // What an agent did on a step: process-gpt's events log (tool calls, shell commands, notices).
  r.get('/todos/:id/events', auth, async (req, res) => {
    const rows = await q(`select timestamp, event_type, crew_type, data from events where todo_id=$1 order by timestamp asc, id asc limit 800`, [req.params.id])
    res.json(rows)
  })

  // 「다시 시도」 on an agent step that stopped on an error (lib/stepRetry.js)
  r.post('/todos/:id/retry', auth, async (req, res) => {
    try { res.json(await retryNow(req.user, req.params.id, proc.canSeeInstance)) }
    catch (e) { res.status(e.status || 500).json({ error: e.message }) }
  })

  r.post('/todos/:id/submit', auth, async (req, res) => {
    try { res.json(await engine.submitTodo({ me: req.user, session: req.session, todoId: req.params.id, values: req.body.values || {}, messageId: req.body.messageId })) }
    catch (e) { console.warn('[submit]', e.message); res.status(500).json({ error: e.message }) }
  })

  // form file fields: data URL in, public storage URL out
  r.post('/files', auth, async (req, res) => {
    const { name, type, data } = req.body
    const buf = Buffer.from(String(data).split(',')[1] || '', 'base64')
    if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'too large' })
    const key = `${config.tenantId}/pgpt-pro/${req.user.id}/${crypto.randomUUID()}-${name.replace(/[^\w.\-가-힣]/g, '_')}`
    const { error } = await admin.storage.from('files').upload(key, buf, { contentType: type || 'application/octet-stream' })
    if (error) return res.status(500).json({ error: error.message })
    const { data: pub } = admin.storage.from('files').getPublicUrl(key)
    res.json({ name, url: pub.publicUrl, path: key, size: buf.length, type })
  })

  return r
}
