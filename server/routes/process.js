// HTTP routes for process definitions, instances, work items and files.
import express from 'express'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q, admin } from '../lib/supa.js'
import * as proc from '../lib/processes.js'
import * as engine from '../lib/engine.js'
import { mainThread, addMessage, updateMessage } from '../lib/store.js'
import { saveGenerated } from '../lib/generated.js'
import { markOpened } from '../lib/improve/signal.js'

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
    try { res.json(await engine.startProcess({ me: req.user, session: req.session, defId: req.params.id, values: req.body.values || {}, messageId: req.body.messageId })) }
    catch (e) { console.warn('[start]', e.message); res.status(500).json({ error: e.message }) }
  })

  r.get('/instances', auth, async (req, res) => res.json(await proc.listInstances({ userEmail: req.user.email, userId: req.user.id, status: req.query.status })))
  r.get('/instances/:id', auth, async (req, res) => {
    if (!(await proc.canSeeInstance(req.params.id, req.user))) return res.status(403).json({ error: '이 프로세스를 볼 권한이 없어요.' })
    const d = await proc.getInstance(req.params.id, req.user)
    if (!d) return res.status(404).end()
    // one conversation per instance, created on first view
    let [t] = await q(`select id from pro_threads where user_id=$1 and ref=$2`, [req.user.id, req.params.id])
    if (!t) [t] = await q(`insert into pro_threads(user_id,kind,title,ref) values ($1,'process',$2,$3) returning id`, [req.user.id, d.inst.proc_inst_name || d.def?.name, req.params.id])
    res.json({ ...d, threadId: t.id })
  })

  r.get('/todos', auth, async (req, res) => res.json(await proc.myTodos(req.user)))
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
      await updateMessage(req.user.id, m.id, { state: 'saved', defId: saved.proc_def_id, saved })
      res.json(saved)
    } catch (e) {
      console.warn('[save-generated]', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  // Home action → the form opens in the main chat
  r.post('/todos/:id/open', auth, async (req, res) => {
    const d = await proc.getTodo(req.params.id)
    if (!d) return res.status(404).end()
    const t = await mainThread(req.user.id)
    const m = await addMessage(req.user.id, t.id, 'agent', 'todo', { todoId: d.todo.id, name: d.todo.activity_name, inst: d.instName })
    res.json(m)
  })
  // What an agent did on a step: process-gpt's events log (tool calls, shell commands, notices).
  r.get('/todos/:id/events', auth, async (req, res) => {
    const rows = await q(`select timestamp, event_type, crew_type, data from events where todo_id=$1 order by timestamp asc, id asc limit 800`, [req.params.id])
    res.json(rows)
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
