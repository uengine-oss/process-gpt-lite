'use strict'
// The local runner as the desktop app holds it (design docs/local-agents/design.md): one link to the server, the CLIs this computer has,
// and the runner that does the jobs. main.js makes one per paired server; the page sees only status() through the preload bridge.
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { Link } = require('./link')
const { Runner } = require('./runner')
const C = require('./clis')
const { BrowserService } = require('../browser/protocol')
const { FolderSync } = require('./sync')
const { WorkingCopies } = require('./seats')

// mode: 'auto' (the CLI in a terminal when node-pty loads) | 'headless' · sessionEnv: extra environment for the CLIs (tests: their config folders)
// browser: this PC's browser the server's browser agent may drive (../browser/host.js — the app's main process makes it; none in a plain
// Node runner) — it says so in its caps (browser: true, desktop 0.2.3) and takes the server's browser operations over this same link
// folders: the person's folders of this computer kept as Lite folders (챔피언 폴더 — ./sync.js; 0.2.5): the app's record of them for this
// server and person (settings.folderStore) — their messages (sync:*) go over this same link, for the person the pairing is for (userId)
// seats: the variations' working copies this computer holds (작업본 — ./seats.js; 0.2.6): the app's record of them for this server and person
// (settings.seatStore) — their messages (seat:*) go over this same link too · seatOpts: the engine's timings (tests)
function createLocalRunner({ server, token, dataDir, device = {}, prefs, ask, log = () => {}, searchPath = C.augmentedPath(), WS, maxJobs = 2, runMs, mode, sessionEnv, settleMs, browser = null,
  folders: folderStore = null, seats: seatStore = null, seatOpts = {}, userId = '' } = {}) {
  const ev = new EventEmitter()
  let caps = {}
  let state = { connected: false, refused: null, user: null, device: null }
  const runner = new Runner({ dataDir, server, prefs, ask, searchPath, maxJobs, log, runMs, caps, ...(mode ? { mode } : {}), ...(sessionEnv ? { sessionEnv } : {}), ...(settleMs ? { settleMs } : {}) })
  const hello = () => ({
    device: { name: device.name || os.hostname().replace(/\.local$/, ''), platform: device.platform || process.platform, appVersion: device.appVersion || '' },
    // terminal: steps run in the person's interactive CLI (else headless — node-pty did not load here) · conversation: it relays the CLI's
    // records as the run card's 「대화」 (0.2.1 — an older desktop shows only the terminal) · chat: it runs chat messages for its person's
    // CLI (0.2.2 — the composer's agent picker; only in a terminal)
    caps: { clis: Object.fromEntries(Object.entries(caps).map(([k, c]) => [k, { installed: c.installed, version: c.version, loggedIn: c.loggedIn, runnable: c.runnable }])), maxJobs, terminal: runner.interactive(), conversation: runner.interactive(), chat: runner.interactive(),
      // (0.2.3: browser tasks may run in this PC's browser — the server's 「브라우저 작업은 내 PC에서」 · 0.2.5: folders of this PC kept
      // as Lite folders — 「내 PC 폴더 올리기」)
      // (0.2.6: a variation's working copy on this PC — 「이 PC 에서 작업」)
      browser: !!browser, folders: !!folderStore, seats: !!seatStore },
    prefs: prefs(),
    active: runner.activeIds(),
  })
  const link = new Link({ server, token, hello, WS, log })
  runner.setLink(link)
  // the browser on this PC, for the person this desktop is signed in as (the server's welcome names them)
  const web = browser ? new BrowserService({ driver: browser, send: (m) => link.send(m), user: () => state.user, log }) : null
  const folders = folderStore ? new FolderSync({ dataDir, server, userId, store: folderStore, send: (m) => link.send(m), device, user: () => state.user, log }) : null
  if (folders) folders.on('state', (list) => ev.emit('folders', list))
  const seats = seatStore ? new WorkingCopies({ dataDir, server, userId, store: seatStore, send: (m) => link.send(m), device, user: () => state.user, log, ...seatOpts }) : null
  if (seats) {
    seats.on('state', (list) => ev.emit('seats', list))
    // (the server or the work itself has something to tell the person: main shows a notification)
    for (const k of ['recall', 'left', 'released', 'trashed']) seats.on(k, (n) => ev.emit('seat-notice', { kind: k, ...n }))
  }
  const changed = () => ev.emit('state', status())
  link.on('welcome', (m) => { state = { ...state, connected: true, refused: null, user: m.user || null, device: m.device || null }; runner.welcome(m); folders?.linkUp(m.user); seats?.linkUp(m.user); changed() })
  link.on('down', () => {
    state = { ...state, connected: false }
    folders?.linkDown()
    seats?.linkDown()
    // (no task holds this PC's browser while the link is down: nothing more is sent or guarded for one — the page stays, for the same
    // task to find when the link is back — 2026-11-25 re-review)
    if (web) { web.parts.clear(); try { browser.linkDown?.() } catch (e) { log('[browser] link down', e.message) } }
    changed()
  })
  link.on('refused', (r) => { state = { ...state, connected: false, refused: r }; folders?.linkDown(); seats?.linkDown(); changed() })
  link.on('message', (m) => {
    if (web?.handles(m)) { web.handle(m).catch((e) => log('[browser]', e.message)); return }
    if (folders?.handles(m)) { folders.handle(m); return }
    if (seats?.handles(m)) { seats.handle(m); return }
    runner.handle(m).catch((e) => log('[runner]', e.message))
  })
  runner.on('state', changed)
  runner.on('finished', (f) => ev.emit('finished', f))
  // someone suggested a prompt for a run of this computer (main shows a notification)
  runner.on('notice', (n) => ev.emit('notice', n))

  function status() {
    return {
      server, connected: state.connected, refused: state.refused ? { code: state.refused.code, reason: state.refused.reason || '' } : null,
      user: state.user, device: state.device, prefs: prefs(),
      clis: Object.fromEntries(Object.entries(caps).map(([k, c]) => [k, { label: C.CLIS[k].label, installed: c.installed, version: c.version, loggedIn: c.loggedIn, runnable: c.runnable }])),
      running: runner.status(), terminal: runner.interactive(),
    }
  }
  async function detect() {
    caps = await C.detect({ searchPath }).catch(() => ({}))
    runner.caps = caps
    link.send({ type: 'caps', caps: hello().caps, prefs: prefs(), active: runner.activeIds() })
    changed()
    return caps
  }
  return {
    ev, runner, link, status, detect, browser: web, folders, seats,
    async start() { await detect(); link.start(); changed(); return this },
    stop() { runner.stop(); web?.stop(); folders?.stop(); seats?.stop(); link.stop() },
    // the person turned local runs on/off or asking first: the server knows at once (it stops sending, or sends again)
    prefsChanged() { link.send({ type: 'caps', caps: hello().caps, prefs: prefs(), active: runner.activeIds() }); changed() },
  }
}

module.exports = { createLocalRunner }
