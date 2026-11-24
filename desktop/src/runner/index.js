'use strict'
// The local runner as the desktop app holds it (design docs/local-agents/design.md): one link to the server, the CLIs this computer has,
// and the runner that does the jobs. main.js makes one per paired server; the page sees only status() through the preload bridge.
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { Link } = require('./link')
const { Runner } = require('./runner')
const C = require('./clis')

// mode: 'auto' (the CLI in a terminal when node-pty loads) | 'headless' · sessionEnv: extra environment for the CLIs (tests: their config folders)
function createLocalRunner({ server, token, dataDir, device = {}, prefs, ask, log = () => {}, searchPath = C.augmentedPath(), WS, maxJobs = 2, runMs, mode, sessionEnv, settleMs } = {}) {
  const ev = new EventEmitter()
  let caps = {}
  let state = { connected: false, refused: null, user: null, device: null }
  const runner = new Runner({ dataDir, server, prefs, ask, searchPath, maxJobs, log, runMs, caps, ...(mode ? { mode } : {}), ...(sessionEnv ? { sessionEnv } : {}), ...(settleMs ? { settleMs } : {}) })
  const hello = () => ({
    device: { name: device.name || os.hostname().replace(/\.local$/, ''), platform: device.platform || process.platform, appVersion: device.appVersion || '' },
    // terminal: steps run in the person's interactive CLI (else headless — node-pty did not load here)
    caps: { clis: Object.fromEntries(Object.entries(caps).map(([k, c]) => [k, { installed: c.installed, version: c.version, loggedIn: c.loggedIn, runnable: c.runnable }])), maxJobs, terminal: runner.interactive() },
    prefs: prefs(),
    active: runner.activeIds(),
  })
  const link = new Link({ server, token, hello, WS, log })
  runner.setLink(link)
  const changed = () => ev.emit('state', status())
  link.on('welcome', (m) => { state = { ...state, connected: true, refused: null, user: m.user || null, device: m.device || null }; runner.welcome(m); changed() })
  link.on('down', () => { state = { ...state, connected: false }; changed() })
  link.on('refused', (r) => { state = { ...state, connected: false, refused: r }; changed() })
  link.on('message', (m) => { runner.handle(m).catch((e) => log('[runner]', e.message)) })
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
    ev, runner, link, status, detect,
    async start() { await detect(); link.start(); changed(); return this },
    stop() { runner.stop(); link.stop() },
    // the person turned local runs on/off or asking first: the server knows at once (it stops sending, or sends again)
    prefsChanged() { link.send({ type: 'caps', caps: hello().caps, prefs: prefs(), active: runner.activeIds() }); changed() },
  }
}

module.exports = { createLocalRunner }
