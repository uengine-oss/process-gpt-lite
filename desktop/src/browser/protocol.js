'use strict'
// The browser on this PC as the server's browser agent sees it (desktop 0.2.3; server lib/browserRemote.js · lib/localAgents/browserLink.js):
// operations by name over the app's one link — {type:'browser', id, op, args} in, {type:'browser-reply', id, ok, value | error, at} out,
// the live view as {type:'browser-frame'} and what happens on its own (a download, a new tab) as {type:'browser-event'}. A message
// over WHOLE bytes goes in pieces of PART bytes of its UTF-8 ({type:'browser-part', mid, n, of, b} — b: base64): the server's link takes
// 1 MB a message, counted in bytes (a page's Korean text is three bytes a letter).
//
// Only these operations, each one this app's own code (host.js); the server names one, it never sends code to run. Only for the person
// this desktop is signed in as (open names them). Nothing of an operation's arguments is logged — a vault value for one fill is among
// them (fillSecret), typed into its field and kept nowhere.
const crypto = require('node:crypto')

const WHOLE = 900 * 1024
const PART = 600 * 1024
const MAX_MESSAGE = 72 * 1024 * 1024
const MAX_PARTS = Math.ceil(MAX_MESSAGE / PART)
const OPEN = 2
// begin · idle: a task takes this browser and gives it back (host.js: frames and downloads only in between, the page cleared after)
const OPS = new Set(['open', 'begin', 'idle', 'healthy', 'closeTabs', 'navigate', 'look', 'describe', 'isSecret', 'box', 'click', 'fill', 'fillSecret', 'press', 'scroll',
  'shot', 'frameShot', 'words', 'text', 'stop', 'attach', 'input', 'show', 'close'])

// a message out, in pieces when it is long → false when the link would not take it
function sendBig(send, msg) {
  const text = JSON.stringify(msg)
  if (Buffer.byteLength(text) <= WHOLE) return send(msg)
  const buf = Buffer.from(text)
  const mid = crypto.randomBytes(8).toString('hex')
  const of = Math.ceil(buf.length / PART)
  for (let n = 0; n < of; n++) if (!send({ type: 'browser-part', mid, n, of, b: buf.subarray(n * PART, (n + 1) * PART).toString('base64') })) return false
  return true
}

// pieces in → the whole message once all have come (or null); at most OPEN messages at once and MAX_MESSAGE bytes in all; a message
// that never completes is dropped after a while
class Parts {
  constructor(ms = 120_000) { this.ms = ms; this.open = new Map(); this.size = 0 }
  drop(mid) { const b = this.open.get(mid); if (!b) return; clearTimeout(b.timer); this.size -= b.size; this.open.delete(mid) }
  take(msg) {
    const mid = String(msg.mid || '').slice(0, 40)
    const of = Number(msg.of) | 0, n = Number(msg.n) | 0
    if (!mid || of < 1 || of > MAX_PARTS || n < 0 || n >= of || typeof msg.b !== 'string' || msg.b.length > Math.ceil(PART / 3) * 4 + 4) return null
    let b = this.open.get(mid)
    if (!b) {
      if (this.open.size >= OPEN) return null
      b = { got: new Array(of), have: 0, size: 0, of }
      b.timer = setTimeout(() => this.drop(mid), this.ms)
      b.timer.unref?.()
      this.open.set(mid, b)
    }
    if (b.of !== of || b.got[n] !== undefined) return null
    const bytes = Buffer.from(msg.b, 'base64')
    b.got[n] = bytes
    b.have++
    b.size += bytes.length
    this.size += bytes.length
    if (this.size > MAX_MESSAGE) { this.drop(mid); return null }
    if (b.have < b.of) return null
    const whole = Buffer.concat(b.got)
    this.drop(mid)
    try { return JSON.parse(whole.toString('utf8')) } catch { return null }
  }
  clear() { for (const b of this.open.values()) clearTimeout(b.timer); this.open.clear(); this.size = 0 }
}

class BrowserService {
  // driver: the browser (host.js createBrowserHost — or a test's) with one method per operation and at() (where its page is now);
  // send(msg): out over the link · user(): the person this desktop is signed in as ({id}) or null before the server welcomed it
  constructor({ driver, send, user = () => null, log = () => {} }) {
    this.driver = driver
    this.sendRaw = send
    this.user = user
    this.log = log
    this.parts = new Parts()
    this.queue = Promise.resolve()
    driver.emit = (msg) => sendBig(this.sendRaw, msg)
  }
  handles(msg) { return msg?.type === 'browser' || msg?.type === 'browser-part' }

  async handle(msg) {
    if (msg?.type === 'browser-part') {
      const inner = this.parts.take(msg)
      if (inner?.type === 'browser') return this.handle(inner)
      return
    }
    if (msg?.type !== 'browser') return
    const id = String(msg.id || '').slice(0, 80)
    const op = String(msg.op || '')
    // (a few run beside the one under way: stopping a page, a takeover key, showing the window — they must not wait behind a long step)
    const t0 = Date.now()
    const run = () => {
      const t1 = Date.now()
      return this.run(op, msg.args && typeof msg.args === 'object' ? msg.args : {})
        .then((value) => this.reply(id, true, value), (e) => this.reply(id, false, null, e))
        .finally(() => { if (process.env.PGL_BROWSER_TRACE === '1') console.log(`[browser] ${op} waited ${t1 - t0}ms ran ${Date.now() - t1}ms`) })
    }
    if (['stop', 'input', 'show', 'frameShot', 'close'].includes(op)) return run()
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  async run(op, args) {
    if (!OPS.has(op) || typeof this.driver[op] !== 'function') throw new Error(`unknown operation: ${op.slice(0, 40)}`)
    this.driver.awake?.()
    if (op === 'open') {
      // only the person this desktop is signed in as: their browser, their session partition
      const me = this.user()
      if (!me?.id || String(args.user || '') !== String(me.id)) throw Object.assign(new Error('this desktop is signed in as someone else'), { code: 'person' })
    } else if (!this.driver.opened?.()) {
      throw Object.assign(new Error('the browser is not open on this PC'), { code: 'closed' })
    }
    // (the page closed its own last window: a new tab — the work goes on there, it is not a PC that went off. Inside the operation's
    // time; the host makes one tab however many operations ask at once)
    const tab = op !== 'open' && !['close', 'show', 'idle'].includes(op)
    // (each has an end: an operation stuck in a page that never answers must not hold the ones after it)
    const ms = op === 'attach' ? 90_000 : op === 'fillSecret' ? 15_000 + String(args.value || '').length * 150 : 45_000
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${op} did not finish within ${Math.round(ms / 1000)} s on this PC`)), ms)
      Promise.resolve().then(() => (tab ? this.driver.ensureTab?.() : null)).then(() => this.driver[op](args))
        .then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
    })
  }

  reply(id, ok, value, err) {
    let at = null
    try { at = this.driver.at?.() || null } catch { /* the page is going away */ }
    const msg = ok ? { type: 'browser-reply', id, ok: true, value: value === undefined ? null : value, at }
      : { type: 'browser-reply', id, ok: false, error: String(err?.message || err || 'failed').split('\n')[0].slice(0, 300), code: err?.code || null, at }
    if (!sendBig(this.sendRaw, msg)) this.log('[browser] a reply could not be sent (the link is down)')
  }

  stop() { this.parts.clear(); try { this.driver.close?.({}) } catch { /* gone */ } }
}

module.exports = { BrowserService, Parts, sendBig, PART, WHOLE, MAX_PARTS, OPEN, OPS }
