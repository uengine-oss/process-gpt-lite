// The agent's workroom: the files a run leaves on disk (cli-agent's per-run workspace or worktree,
// deepagents' conversation folder), read and edited in place, a shell in that folder, Claude Code
// resumed on the run's own session to keep steering it, and live steering of a deepagents turn.
// Modelled on agent-share (PTY + xterm.js over one JSON websocket, scrollback replay, several
// viewers per session), inside pgpt-pro's auth.
import fs from 'node:fs/promises'
import { realpathSync, existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pty from 'node-pty'
import { WebSocketServer } from 'ws'
import { config } from '../config.js'
import { q, admin } from './supa.js'
import { workspaceHostPath } from './missions.js'
import { folderRoom, folderRoomAccess } from './folders/rooms.js'

const T = () => config.tenantId
const TEXT_MAX = 2 * 1024 * 1024
const SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.next', 'dist'])

// ---------- which folder ----------
// kind 'todo': a process step (cli-agent run = todo id; deepagents run = its instance folder)
// kind 'run':  a cli-agent chat run (conversation id)
// kind 'chat': a deepagents conversation (/workspace/.bpmn/<room>)
export async function resolveRoom(kind, id) {
  if (kind === 'todo') {
    const [t] = await q(`select t.id, t.activity_name, t.status, t.agent_orch, t.output, t.proc_inst_id, i.proc_inst_name
                         from todolist t left join bpm_proc_inst i on i.proc_inst_id=t.proc_inst_id where t.id::text=$1`, [id])
    if (!t) return null
    const out = t.output || {}
    if (t.agent_orch === 'cliagents') {
      const base = path.join(config.cliWorkspaceRoot, T(), t.id)
      return { kind, id, title: t.activity_name, sub: t.proc_inst_name, agent: 'claude-code', running: t.status === 'IN_PROGRESS',
        root: base, cwd: out.worktree?.worktree || base, session: out.cliagents_session_id || null, branch: out.worktree?.branch || null }
    }
    const root = await workspaceHostPath(`/workspace/.bpmn/${t.proc_inst_id}`).catch(() => null)
    return root && { kind, id, title: t.activity_name, sub: t.proc_inst_name, agent: 'deepagents', running: t.status === 'IN_PROGRESS', root, cwd: root, conversation: t.proc_inst_id }
  }
  if (kind === 'run') {
    const root = path.join(config.cliWorkspaceRoot, T(), id)
    return { kind, id, title: 'Claude Code 실행', agent: 'claude-code', root, cwd: root, session: null }
  }
  if (kind === 'chat') {
    const root = await workspaceHostPath(`/workspace/.bpmn/${id}`).catch(() => null)
    return root && { kind, id, title: '대화 작업 폴더', agent: 'deepagents', root, cwd: root, conversation: id }
  }
  // shared folders (lib/folders): 'folder' = a folder's main (id = slug), 'variation' = a person's
  // checkout of a variation (id = variation id, checked out by POST …/variations/:vid/checkout)
  if (kind === 'folder' || kind === 'variation') return folderRoom(kind, id)
  return null
}

// Who may open a room: a step's assignee or a participant of its process instance; for a chat or
// run folder, the person whose conversation it is; and the tenant's admins. Every route and every
// terminal checks this (the folder holds the agent's work, the terminal is a shell on this host).
export async function canAccess(user, room) {
  if (!user || !room) return false
  if (room.folder) return folderRoomAccess(user, room)
  const [me] = await q('select is_admin from users where id=$1', [user.id]).catch(() => [])
  if (me?.is_admin) return true
  if (room.kind === 'todo') {
    const [t] = await q(`select t.user_id, i.participants from todolist t left join bpm_proc_inst i on i.proc_inst_id=t.proc_inst_id where t.id::text=$1`, [room.id])
    if (!t) return false
    const assignees = String(t.user_id || '').split(',').map((x) => x.trim())
    return assignees.includes(user.id) || assignees.includes(user.email) || (t.participants || []).includes(user.id)
  }
  const [hit] = await q(`select 1 from context_threads where user_id=$1 and conversation_id=$2
                         union all select 1 from pro_threads where user_id=$1 and (id::text=$2 or conversation_id=$2) limit 1`, [user.id, String(room.id)])
  return !!hit
}

// A terminal is opened with a one-time ticket the page fetched (signed in, allowed in the room)
// a moment before; it never travels in a link and is spent on use.
const tickets = new Map() // ticket -> { userId, kind, id, mode, until }
export function issueTicket(user, room, mode) {
  for (const [k, v] of tickets) if (v.until < Date.now()) tickets.delete(k)
  const t = crypto.randomBytes(24).toString('base64url')
  tickets.set(t, { userId: user.id, kind: room.kind, id: room.id, mode: mode === 'claude' ? 'claude' : 'shell', until: Date.now() + 60_000 })
  return t
}
function spendTicket(t) {
  const v = tickets.get(t)
  tickets.delete(t)
  return v && v.until > Date.now() ? v : null
}

// An office document or ArtCraft file opened from the workroom: the editors load documents from
// storage (the office host only fetches allowed origins), so a copy goes to the files bucket under
// its content hash — opening the same bytes again reuses it.
const MIME = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pdf: 'application/pdf', hwpx: 'application/hwp+zip', hwp: 'application/x-hwp' }
export async function publishFile(room, rel, user) {
  const p = inside(room, rel)
  const buf = await fs.readFile(p)
  if (buf.length > 50 * 1024 * 1024) throw Object.assign(new Error('too large'), { status: 413 })
  const ext = (path.extname(p).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin')
  const key = `pgpt-pro/${user.id}/wr/${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`
  const { error } = await admin.storage.from('files').upload(key, buf, { contentType: MIME[ext] || 'application/octet-stream', upsert: true })
  if (error) throw error
  return { url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}`, name: path.basename(p) }
}

// A path from the browser, kept inside the room (no "..", symlinks may not lead out).
function inside(room, rel) {
  const p = path.resolve(room.root, String(rel || '').replace(/^\/+/, ''))
  if (p !== room.root && !p.startsWith(room.root + path.sep)) throw Object.assign(new Error('outside'), { status: 400 })
  let real
  try { real = realpathSync(p) } catch { return p } // not created yet (write)
  const rootReal = realpathSync(room.root)
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw Object.assign(new Error('outside'), { status: 400 })
  return p
}

export async function tree(room) {
  const out = []
  const walk = async (dir, depth) => {
    for (const e of (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (out.length >= 3000) return
      if (SKIP.has(e.name) || e.name.startsWith('.processgpt')) continue
      const p = path.join(dir, e.name)
      const rel = path.relative(room.root, p)
      if (e.isDirectory()) { out.push({ path: rel, dir: true, depth }); if (depth < 8) await walk(p, depth + 1) }
      else { const st = await fs.stat(p).catch(() => null); if (st) out.push({ path: rel, dir: false, depth, size: st.size, mtime: st.mtimeMs }) }
    }
  }
  await walk(room.root, 0)
  return out
}

const TEXTISH = /\.(md|markdown|txt|json|ya?ml|toml|ini|env\.example|csv|tsv|py|js|mjs|cjs|ts|tsx|jsx|vue|html?|css|scss|sh|bash|zsh|sql|xml|bpmn|dmn|form|java|kt|go|rs|rb|php|c|h|cpp|hpp|cs|swift|gitignore|log|conf|cfg)$/i
export async function readFile(room, rel) {
  const p = inside(room, rel)
  const st = await fs.stat(p)
  if (st.isDirectory()) throw Object.assign(new Error('directory'), { status: 400 })
  const buf = await fs.readFile(p)
  const text = TEXTISH.test(p) || (!buf.subarray(0, 4096).includes(0) && st.size <= TEXT_MAX)
  if (!text || st.size > TEXT_MAX) return { binary: true, size: st.size, mtime: st.mtimeMs }
  return { content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs }
}
export function rawPath(room, rel) { return inside(room, rel) }

// Code injected by a person: written in place, refused if the agent changed the file meanwhile.
export async function writeFile(room, rel, content, expectedMtime) {
  const p = inside(room, rel)
  const st = await fs.stat(p).catch(() => null)
  if (st && expectedMtime && Math.abs(st.mtimeMs - expectedMtime) > 1) throw Object.assign(new Error('changed'), { status: 409, mtime: st.mtimeMs })
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
  // a shared folder's main or a variation checkout: the edit becomes a commit
  if (room.afterWrite) await room.afterWrite(path.relative(room.root, p)).catch((e) => console.warn('[workroom] commit', e.message))
  return { mtime: (await fs.stat(p)).mtimeMs }
}

// Live steering of a deepagents turn (process-gpt SDK POST /chat/steer: applied before the next
// model call, never mid-tool).
export async function steer(room, user, text) {
  if (room.agent !== 'deepagents') return { ok: false, reason: 'claude-code' }
  const res = await fetch(`${config.deepagentsUrl}/chat/steer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: room.conversation, message: text, tenant_id: T(), user_uid: user.id, metadata: { source: 'pgpt-pro-workroom' } }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }))
  const body = await res.text()
  return { ok: res.ok, status: res.status, body: body.slice(0, 400) }
}

// ---------- terminal ----------
// One PTY per (room, mode); every viewer of it sees the same screen. A session nobody watches
// is ended after a grace period.
const sessions = new Map()
const SCROLLBACK = 400 * 1024
const GRACE_MS = 15 * 60 * 1000

function spawn(room, mode) {
  // nothing of the server's own context leaks in: no secrets, and no CLAUDE* markers (a resumed
  // Claude Code would otherwise think it is a child session and stop saving its transcript)
  // (GIT_CONFIG_* travel as a numbered set — dropping only the *_KEY_n ones breaks every git call)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('PRO_') && !k.startsWith('GIT_CONFIG_') && !/KEY|SECRET|TOKEN|PASSWORD/.test(k)))
  Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'ko_KR.UTF-8' })
  // the login shell, else the first one this machine has (the Docker image has bash, not zsh)
  const shell = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].find((x) => x && existsSync(x)) || '/bin/sh'
  let file = shell, args = ['-i']
  if (mode === 'claude') {
    file = config.claudeBin
    args = room.session ? ['--resume', room.session] : []
  }
  return pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 32, cwd: room.cwd, env })
}

function sessionFor(room, mode) {
  const key = `${room.kind}:${room.id}:${mode}`
  let s = sessions.get(key)
  if (s && !s.exited) return s
  const p = spawn(room, mode)
  s = { key, pty: p, buf: '', viewers: new Set(), exited: false, timer: null, mode }
  p.onData((d) => {
    s.buf = (s.buf + d).slice(-SCROLLBACK)
    for (const ws of s.viewers) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data: d }))
  })
  p.onExit(({ exitCode }) => {
    s.exited = true
    for (const ws of s.viewers) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode }))
    sessions.delete(key)
  })
  sessions.set(key, s)
  return s
}

// Opening a terminal takes a ticket from POST /api/workroom/:kind/:id/ticket (signed in and allowed
// in that room) and a page on one of this app's own origins (no cross-site websocket).
// (the ticket is the lock — only this app's page can fetch one with the stored sign-in token; the
// origin check is a second fence. Behind the dev proxy and a public tunnel the Host is rewritten,
// so the forwarded host and this app's tunnel domains count as the same site.)
const TUNNEL = /\.(trycloudflare\.com|ngrok-free\.app|ngrok\.app|ngrok\.io)$/
export function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return false
  let host
  try { host = new URL(origin).host } catch { return false }
  const mine = [req.headers.host, req.headers['x-forwarded-host'], (() => { try { return new URL(config.publicUrl).host } catch { return '' } })()]
  return mine.includes(host) || TUNNEL.test(host.split(':')[0])
}
export function attachTerminal(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== '/api/workroom/term') return
    const deny = (code) => { socket.write(`HTTP/1.1 ${code} No\r\n\r\n`); socket.destroy() }
    if (!sameOrigin(req)) return deny(403)
    const ticket = spendTicket(String(url.searchParams.get('ticket') || ''))
    if (!ticket) return deny(401)
    const room = await resolveRoom(ticket.kind, ticket.id).catch(() => null)
    if (!room || !(await fs.stat(room.cwd).catch(() => null))) return deny(404)
    const mode = ticket.mode
    wss.handleUpgrade(req, socket, head, (ws) => {
      let s
      try { s = sessionFor(room, mode) } catch (e) { ws.send(JSON.stringify({ type: 'error', message: e.message })); return ws.close() }
      clearTimeout(s.timer)
      s.viewers.add(ws)
      ws.send(JSON.stringify({ type: 'session', mode, cwd: room.cwd, session: room.session || null }))
      if (s.buf) ws.send(JSON.stringify({ type: 'output', data: s.buf, replay: true }))
      ws.on('message', (raw) => {
        let m
        try { m = JSON.parse(raw) } catch { return }
        if (m.type === 'input' && typeof m.data === 'string') s.pty.write(m.data)
        else if (m.type === 'resize' && m.cols > 0 && m.rows > 0 && m.cols < 1000 && m.rows < 500) s.pty.resize(m.cols | 0, m.rows | 0)
      })
      ws.on('close', () => {
        s.viewers.delete(ws)
        if (!s.viewers.size && !s.exited) s.timer = setTimeout(() => { if (!s.viewers.size) s.pty.kill() }, GRACE_MS)
      })
    })
  })
}
