'use strict'
// The desktop's one link to its Lite server (design docs/local-agents/design.md §3): an outgoing WebSocket to
// <server>/api/local-agents/link — no port opens on this computer. The first message is the hello with the device token (never in the
// address, so no proxy log holds it); then presence (what this computer can run), the jobs the server sends, and what the runner says
// back. A link that drops comes back by itself (1 s, doubling to 30 s); a token the server refuses (revoked) stops it.
const { EventEmitter } = require('node:events')

const linkUrl = (server) => {
  const u = new URL(String(server).replace(/\/+$/, '') + '/api/local-agents/link')
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.href
}

class Link extends EventEmitter {
  // hello(): {device, caps, prefs, active} at each (re)connect · WS: a WebSocket class (the runtime's own)
  constructor({ server, token, hello, WS = globalThis.WebSocket, log = () => {} }) {
    super()
    this.url = linkUrl(server)
    this.token = token
    this.helloFn = hello
    this.WS = WS
    this.log = log
    this.ws = null
    this.wait = 1000
    this.stopped = false
    this.ready = false
    this.timer = null
  }

  start() { this.stopped = false; this.connect(); return this }
  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    const ws = this.ws
    this.ws = null
    this.ready = false
    try { ws?.close(1000, 'bye') } catch { /* gone */ }
  }

  connect() {
    if (this.stopped) return
    let ws
    try { ws = new this.WS(this.url) } catch (e) { this.log('[link]', e.message); return this.later() }
    this.ws = ws
    ws.onopen = () => {
      const h = this.helloFn() || {}
      ws.send(JSON.stringify({ type: 'hello', token: this.token, protocol: 1, ...h }))
    }
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')) } catch { return }
      if (msg.type === 'ping') return this.send({ type: 'pong', at: msg.at })
      if (msg.type === 'welcome') { this.ready = true; this.wait = 1000; this.emit('welcome', msg); return }
      if (msg.type === 'denied') { this.denied = msg; this.emit('denied', msg); return }
      this.emit('message', msg)
    }
    ws.onclose = (e) => {
      const was = this.ready
      this.ready = false
      if (this.ws === ws) this.ws = null
      if (was) this.emit('down', { code: e.code })
      // refused (a revoked or unknown token, another company): not again until it is paired anew
      if (e.code === 4401 || e.code === 4403) { this.stopped = true; this.emit('refused', { code: e.code, reason: this.denied?.reason || e.reason }); return }
      this.later()
    }
    ws.onerror = () => { /* onclose follows */ }
  }
  later() {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.connect(), this.wait)
    this.wait = Math.min(this.wait * 2, 30_000)
  }
  send(msg) {
    if (!this.ws || this.ws.readyState !== 1) return false
    try { this.ws.send(JSON.stringify(msg)); return true } catch { return false }
  }
}

module.exports = { Link, linkUrl }
