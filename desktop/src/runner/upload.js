'use strict'
// The push engine the app's two ways of sending a folder's work to the server share (design: 작업을 내 PC 에서 §4.2 「엔진은 하나, 바깥은 둘」):
//   - 챔피언 폴더 (sync.js): a folder the person picked, uploaded through a shadow repository of the app's own (main's line)
//   - 변형의 작업본 (seats.js): a variation's working copy in the app's data folder (that variation's branch)
// Both go the same round — watch → quiet → token over the link (1 h) → push → the server takes it in its folder lock → state — so the
// parts of it live here once:
//   ask(msg, types)  a message over the link and its answer for the same key (folderId · variation) — one of `types` or <prefix>refused —
//                    or {why: 'timeout' | 'offline' | 'stopped'}; answer(msg) hands the server's messages to whoever waits
//   locked(key, fn)  one thing at a time per key
//   log(…)           every token this engine was given is cut out of what it logs
//   urlOf(t)         the folder's git address from a token answer (a path on this server, or a full address) — http(s) only
//   watch(key, dir)  the folder's files watched: each change restarts a quiet timer; onQuiet once it has been quiet for quietMs. .git is
//                    never looked at. The watcher is injectable (tests) — fs.watch(recursive) by default
//   later(key)       a round that could not go (offline) — drained on the next link up
// What a round does with the files is each side's own (sync.js: only the shadow repository is written; seats.js: the working copy).
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const G = require('./git')

const ASK_MS = 30_000

// the default watcher: every change below `dir` (recursive — macOS, Windows, and Linux on Node 20+) → cb(eventType, relative name)
function fsWatch(dir, cb) {
  const w = fs.watch(dir, { recursive: true }, (type, name) => cb(type, name == null ? '' : String(name)))
  return w
}
// a change inside git's own place (the repository folder, or a worktree's .git file) is not a change of the folder's files
const inGit = (name) => { const first = String(name || '').replace(/\\/g, '/').split('/')[0]; return first === '.git' }

class Uploader extends EventEmitter {
  // prefix: the link messages' prefix ('sync:' · 'seat:') · key: the field that names what a message is about ('folderId' · 'variation')
  // send(msg) → whether it went out · watchFn(dir, cb) → {close()} (tests)
  constructor({ server = '', send = () => false, log = () => {}, prefix = 'sync:', key = 'folderId', askMs = ASK_MS, watchFn = fsWatch } = {}) {
    super()
    this.server = String(server || '').replace(/\/+$/, '')
    this.sendFn = send
    this.logFn = log
    this.prefix = prefix
    this.keyField = key
    this.askMs = askMs
    this.watchFn = watchFn
    this.waiters = new Set()
    this.locks = new Map()
    this.secrets = new Set()
    this.watchers = new Map() // key → {w, timer, quietMs, onQuiet, onChange}
    this.pending = new Set()
    this.connected = false
    this.stopped = false
  }

  log(...a) { let s = a.join(' '); for (const t of this.secrets) if (t) s = s.split(t).join('***'); this.logFn(s) }
  secret(token) { if (token) this.secrets.add(String(token)) }
  handles(msg) { return typeof msg?.type === 'string' && msg.type.startsWith(this.prefix) }
  keyOf(msg) { return String(msg?.[this.keyField] || '') }
  send(msg) { return !this.stopped && !!this.sendFn(msg) }

  linkUp() { this.connected = true }
  linkDown() {
    this.connected = false
    for (const w of [...this.waiters]) w.done({ why: 'offline' })
  }
  stop() {
    this.stopped = true
    this.connected = false
    for (const w of [...this.waiters]) w.done({ why: 'stopped' })
    for (const k of [...this.watchers.keys()]) this.unwatch(k)
    this.pending.clear()
  }

  // one thing at a time per key
  locked(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve()
    const run = prev.catch(() => {}).then(fn)
    const tail = run.catch(() => {})
    this.locks.set(key, tail)
    tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key) })
    return run
  }
  // a message to the server and its answer (one of `types`, or <prefix>refused) for the same key. A refusal that names the message it
  // answers (re — the server's seat:refused does) ends only the wait for that message: a refused status report never ends a release's wait
  ask(msg, types, ms = this.askMs) {
    return new Promise((resolve) => {
      const w = { key: this.keyOf(msg), asked: String(msg?.type || ''), types: new Set([...types, `${this.prefix}refused`]) }
      w.done = (m) => { clearTimeout(w.timer); this.waiters.delete(w); resolve(m) }
      w.timer = setTimeout(() => w.done({ why: 'timeout' }), ms)
      this.waiters.add(w)
      if (this.stopped || !this.sendFn(msg)) w.done({ why: this.stopped ? 'stopped' : 'offline' })
    })
  }
  // a message from the server that someone waits for → true (it was taken), else false (the caller handles it as the server's own word)
  answer(msg) {
    const k = this.keyOf(msg)
    const refusal = msg?.type === `${this.prefix}refused`
    for (const w of this.waiters) {
      if (w.key !== k || !w.types.has(msg.type)) continue
      if (refusal && msg.re && w.asked && msg.re !== w.asked) continue
      w.done(msg)
      return true
    }
    return false
  }
  // the folder's git address from a token answer: a path on this server, or a full address
  urlOf(t) {
    const u = String(t?.url || t?.path || '')
    return G.checkUrl(u.startsWith('/') ? `${this.server}${u}` : u)
  }

  // ---------- watching ----------
  // dir's files watched under `key`: onChange(name) on every change (not .git), onQuiet() once nothing changed for quietMs
  watch(key, dir, { quietMs = 60_000, onQuiet = () => {}, onChange = () => {} } = {}) {
    this.unwatch(key)
    const entry = { w: null, timer: null, quietMs, onQuiet, onChange }
    try {
      entry.w = this.watchFn(dir, (type, name) => this.touched(key, name))
      entry.w?.on?.('error', (e) => { this.log(`[watch] ${String(key).slice(0, 8)}: ${e.message}`); this.unwatch(key) })
    } catch (e) { this.log(`[watch] ${String(key).slice(0, 8)}: ${e.message}`) }
    this.watchers.set(key, entry)
    return () => this.unwatch(key)
  }
  // a change below the watched folder (the watcher's, or a caller's). (Not `changed` — the two sides use that name for their own 'state'.)
  touched(key, name = '') {
    const e = this.watchers.get(key)
    if (!e || inGit(name)) return false
    try { e.onChange(name) } catch (err) { this.log(`[watch] ${err.message}`) }
    clearTimeout(e.timer)
    e.timer = setTimeout(() => { e.timer = null; if (this.watchers.get(key) === e) { try { e.onQuiet() } catch (err) { this.log(`[watch] ${err.message}`) } } }, e.quietMs)
    e.timer.unref?.()
    return true
  }
  quietPending(key) { return !!this.watchers.get(key)?.timer }
  unwatch(key) {
    const e = this.watchers.get(key)
    if (!e) return
    clearTimeout(e.timer)
    try { e.w?.close?.() } catch { /* gone */ }
    this.watchers.delete(key)
  }

  // ---------- rounds that could not go ----------
  later(key) { this.pending.add(String(key)) }
  drain() { const out = [...this.pending]; this.pending.clear(); return out }
}

module.exports = { Uploader, fsWatch, inGit, ASK_MS }
