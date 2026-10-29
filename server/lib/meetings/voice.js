// The interpreter's voice channel (회의 통역): one websocket per listener, /api/meetings/voice?ticket=…,
// carrying the interpretation of the other speakers in the listener's main language as 24 kHz PCM16
// frames (lib/meetings/pcm.js frame) plus small JSON notes (start / end of a piece, status).
// A ticket (POST /api/meetings/:id/voice/ticket, signed in, in the meeting) is spent on use and lives a
// minute; the socket is let in only from this app's own pages (sameOrigin, like the workroom terminal).
// Nothing comes from the listener on this channel — speech still goes up as spoken pieces (POST …/audio).
import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'
import { sameOrigin } from '../workroom.js'
import * as IP from './interpret.js'

const tickets = new Map() // ticket -> {userId, meetingId, tenant, until}
export function issueTicket(userId, meetingId, tenant) {
  for (const [k, v] of tickets) if (v.until < Date.now()) tickets.delete(k)
  const t = crypto.randomBytes(24).toString('base64url')
  tickets.set(t, { userId, meetingId, tenant, until: Date.now() + 60_000 })
  return t
}
function spend(t) {
  const v = tickets.get(t)
  tickets.delete(t)
  return v && v.until > Date.now() ? v : null
}

let hooks = { open: () => {}, close: () => {} }
// the service hears who opened or closed their channel (to plan voice only for people who can hear it)
export function onChannel(h) { hooks = { ...hooks, ...h } }

export function attachVoice(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== '/api/meetings/voice') return
    const deny = (code) => { socket.write(`HTTP/1.1 ${code} No\r\n\r\n`); socket.destroy() }
    if (!sameOrigin(req)) return deny(403)
    const t = spend(String(url.searchParams.get('ticket') || ''))
    if (!t) return deny(401)
    wss.handleUpgrade(req, socket, head, (ws) => {
      IP.addChannel(t.meetingId, t.userId, ws)
      hooks.open(t)
      ws.send(JSON.stringify({ type: 'hello', meetingId: t.meetingId }))
      const ping = setInterval(() => { if (ws.readyState === 1) ws.ping() }, 25_000)
      ws.on('message', () => {})
      ws.on('close', () => { clearInterval(ping); IP.removeChannel(t.meetingId, t.userId, ws); hooks.close(t) })
    })
  })
}
