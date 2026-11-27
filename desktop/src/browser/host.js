'use strict'
// The browser on this PC that the server's browser agent drives (desktop 0.2.3 — design: openspec/specs/browser-handoff, 「브라우저 작업은
// 내 PC에서」). Electron's own Chromium, in windows hidden by default (one per tab), each driven through its webContents.debugger
// (cdp.js) — no debugging port, no extra browser to install, and nothing that marks it as automated. Its session is the person's own
// partition (persist:pgl-browser-<person>): sign-ins made here stay on this PC and are there for the next task, apart from the app's
// own window (it shows the Lite web app, in the default session).
//   · 「이 PC에서 보기」: the tab's window shows on this PC (show); the person can work it directly — that is takeover on the PC. Closing it
//     hides it again.
//   · The live view: the tab's screencast, at most one frame per live.minMs, to the server (browser-frame) → every viewer's card.
//   · Masking before anything leaves the PC: pageScripts.js (looks, words, the model's picture, dots in the live view).
//   · Downloads land in a temporary folder here and go to the server (browser-event download), which posts them as the server's own.
//   · Pages go only to web addresses (http · https · about:blank): never this PC's files or the app's own pages. A task nobody watches
//     (a process step, a scheduled run — begin({ noPrivate })) does not reach this PC's own network either (localhost, 10/8, 192.168/16 …).
//   · Never the Lite app this browser is part of, nor its sign-in (desktop 0.2.6 — policy.js agentMay: the server the app is connected to
//     and its Supabase sign-in, appServer()): no page, redirect, popup, frame or request of this session goes there, for the agent or for
//     the person working a window shown here (who is told why — notice). A server on this PC is the same server by any name that resolves
//     to this PC. Every request of this session carries AGENT_HEADER, and the Lite server refuses its API and sign-in to such a request
//     (server lib/agentBrowserGuard.js). What a Lite page left in this session before 0.2.6 is cleared once (clearAppStorage).
//   · Between tasks (idle) it sends nothing: no frames, no downloads; the page is cleared (a vault value typed into it goes too).
//   · A page's own alert · confirm · prompt never opens a box here (answered as nobody watching would, kept for the next look); no
//     fullscreen, no sound while hidden, no paste from this PC's clipboard, at most POPUPS new windows a task.
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { Cdp, withTimeout } = require('./cdp')
const P = require('./pageScripts')
const { agentMay, appNames, nameToCheck, hereAddress } = require('../policy')

const VIEW = { width: 1280, height: 800 }
const MAX_DOWNLOAD = Number(process.env.PGL_BROWSER_MAX_DOWNLOAD) > 0 ? Number(process.env.PGL_BROWSER_MAX_DOWNLOAD) : 50 * 1024 * 1024 // (tests make it small)
const MAX_WORDS = 200_000 // characters of a page's words to the server (a long Korean page is three bytes a letter)
const POPUPS = 10 // new windows a page may open in one task (Electron has no popup blocker of its own)
const MAX_TABS = 8
const KEYS = {
  Enter: [13, '\r'], Tab: [9, ''], Escape: [27, ''], Backspace: [8, ''], Delete: [46, ''], ArrowLeft: [37, ''], ArrowUp: [38, ''], ArrowRight: [39, ''], ArrowDown: [40, ''],
  Home: [36, ''], End: [35, ''], PageUp: [33, ''], PageDown: [34, ''], ' ': [32, ' '], Space: [32, ' '],
}
const MAC = process.platform === 'darwin'
const webAddress = (u) => /^(https?:|about:blank$)/i.test(String(u || ''))
// An address on this PC or its own network, by its name or number (server lib/browserRemote.js privateAddress — the same rules):
// localhost (and *.localhost), a name of one label (intranet — the network's own search domain), *.local · *.lan · *.internal ·
// *.intranet · *.localdomain · *.home.arpa, a trailing dot (localhost.), 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local),
// 100.64/10, 0/8, ::, ::1, fc00::/7, fe80::/10 and IPv4 inside IPv6 (::ffff:7f00:1 — what the URL parser makes of [::ffff:127.0.0.1]).
// A public name that resolves to such an address (127.0.0.1.nip.io, localtest.me) is caught by resolving it (privateByName).
const NET_SUFFIX = /\.(localhost|local|lan|internal|intranet|localdomain|home\.arpa)$/
function privateV4(a, b) {
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}
function privateIp(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) return privateV4(Number(m[1]), Number(m[2]))
  if (!h.includes(':')) return null
  if (h === '::' || h === '::1') return true
  if (/^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)) return true
  // IPv4 inside IPv6 — mapped (::ffff:a.b.c.d · ::ffff:7f00:1) or the old compatible form (::a.b.c.d · ::7f00:1)
  const v4 = /^::(?:ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h)
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]))
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (hex) { const hi = parseInt(hex[1], 16); return privateV4(hi >> 8, hi & 255) }
  return false
}
function privateHost(u) {
  let h
  try { h = new URL(String(u)).hostname.toLowerCase() } catch { return false }
  h = h.replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!h) return false
  const ip = privateIp(h)
  if (ip !== null) return ip
  return h === 'localhost' || !h.includes('.') || NET_SUFFIX.test(h)
}
// (the scheme too: http and https of the same name are not the same site)
const originOf = (u) => { try { const x = new URL(u); return x.origin === 'null' ? x.protocol : x.origin } catch { return '' } }
// what this browser's session does with a request (webRequest.onBeforeRequest — every page, its pictures and scripts, a fetch, a form, a
// socket, a popup's first page): 'app' — the Lite app or its sign-in (refused, always); 'private' — this PC's network while a task nobody
// watches holds the browser (refused); 'name' — a name to resolve first (that task too); null — it goes
function requestVerdict(url, { app = {}, noPrivate = false } = {}) {
  const u = String(url || '')
  if (!/^(https?|wss?):/i.test(u)) return null
  if (!agentMay(u, app)) return 'app'
  if (!noPrivate) return null
  return privateHost(u) ? 'private' : 'name'
}
// what the agent is told when the app's own address is refused (its next look says it too)
const APP_REFUSED = 'this browser does not open the Process GPT Lite app or its sign-in page — the person uses it in the app\'s own window'
// the mark on every request of this browser's session (server lib/agentBrowserGuard.js AGENT_BROWSER_HEADER)
const AGENT_HEADER = 'X-PGL-Agent-Browser'
// a box on a window shown here at most this often (the agent's answer and its next look say it every time)
const NOTICE_MS = 10_000
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

// This PC's own addresses and names (policy.js agentMay: a Lite server on this PC answers by any of them) — read again after a minute
let selfAt = 0, selfList = []
function selfHosts() {
  if (Date.now() - selfAt < 60_000) return selfList
  selfAt = Date.now()
  const out = new Set()
  try { for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a?.address) out.add(String(a.address).toLowerCase().replace(/%.*$/, '')) } catch { /* none */ }
  try { const h = os.hostname().toLowerCase().replace(/\.$/, ''); if (h) { out.add(h); out.add(`${h.replace(/\.local$/, '')}.local`) } } catch { /* none */ }
  selfList = [...out]
  return selfList
}

// electron: the electron module (main.js passes its own) · emit(msg): out to the server (protocol.js sets it) · log
// appServer(): {server, authOrigins} — the Lite server the app is connected to and its sign-in origin(s) (main.js; the test host: its
// server) · notice({origin, win}): a window shown on this PC did not open one of them — main tells the person why
function createBrowserHost({ electron, log = () => {}, tmp = path.join(os.tmpdir(), 'pgl-browser'), appServer = () => null, notice = () => {} } = {}) {
  const { BrowserWindow, session: electronSession } = electron
  const state = { user: null, partition: null, tabs: [], active: null, live: { minMs: 333, width: 1024, height: 640 }, snap: { maxEls: 120, maxText: 3000, budgetMs: 1500 },
    step: { navMs: 20000, settleMs: 1500, snapMs: 6000, shotMs: 6000 }, frameOf: new Map(), shown: false, seq: 0, quitting: false, files: new Set(),
    busy: false, noPrivate: false, popups: 0, coming: 0, dialogs: [], refused: [], toldAt: 0, ensuring: null, replacing: null, names: new Map(), here: new Map() }
  // (this PC's names: its own, and the names resolved to it a moment ago — here)
  const hereNames = () => { const now = Date.now(), out = []; for (const [h, x] of state.here) if (x.here && x.until > now) out.push(h); return out }
  const appCtx = () => { let a = null; try { a = appServer() } catch { /* none */ } return { server: String(a?.server || ''), authOrigins: Array.isArray(a?.authOrigins) ? a.authOrigins : [], selfHosts: [...selfHosts(), ...hereNames()] } }
  // the Lite app or its sign-in: never in this browser
  const mayGo = (u) => agentMay(u, appCtx())
  // where a page may go now: a web address, not the Lite app; for a task nobody watches, not this PC's own network
  const allowed = (u) => webAddress(u) && mayGo(u) && !(state.noPrivate && privateHost(u))
  // the app's address refused: the agent's next look says so, and a window shown on this PC tells the person (once in a while per address)
  function refusedApp(u, win = null) {
    const origin = originOf(u)
    log(`[browser] refused (the Lite app or its sign-in): ${origin}`)
    state.refused.push(`${origin}: ${APP_REFUSED}`)
    if (state.refused.length > 5) state.refused.shift()
    const w = win && !win.isDestroyed?.() ? win : null
    if (!state.shown || !w?.isVisible?.()) return
    if (Date.now() - state.toldAt < NOTICE_MS) return
    state.toldAt = Date.now()
    try { notice({ origin, win: w }) } catch { /* the app's own */ }
  }
  // Whether a name resolves to this PC, by this session's resolver, for a minute (at most 500 names kept). fail: what a name that does not
  // resolve counts as — a request's name is refused (nothing to reach anyway), the app's own name is not taken as this PC's.
  async function resolvesHere(ses, h, { fail = true } = {}) {
    const had = state.here.get(h)
    if (had && had.until > Date.now()) return had.here
    let here = fail
    if (typeof ses?.resolveHost === 'function') {
      try {
        const ends = (await withTimeout(ses.resolveHost(h), 3000, 'resolving'))?.endpoints || []
        here = ends.length ? ends.some((e) => hereAddress(String(e.address || ''), selfHosts())) : fail
      } catch { here = fail }
    }
    state.here.delete(h)
    state.here.set(h, { here, until: Date.now() + 60_000 })
    if (state.here.size > 500) state.here.delete(state.here.keys().next().value)
    return here
  }
  // What this session does with a request or an address: 'app' — the Lite app or its sign-in, by its address or by a name that resolves to
  // the app's server on this PC (the server's own name is resolved first: a server by a name of this PC is on this PC); 'private' — this
  // PC's network while a task nobody watches holds the browser; null — it goes
  async function verdictOf(ses, u) {
    const v = requestVerdict(u, { app: appCtx(), noPrivate: state.noPrivate })
    if (v === 'app' || v === 'private' || !/^(https?|wss?):/i.test(u)) return v
    for (const h of appNames(appCtx())) await resolvesHere(ses, h, { fail: false })
    const ctx = appCtx()
    if (!agentMay(u, ctx)) return 'app'
    const name = nameToCheck(u, ctx)
    if (name && await resolvesHere(ses, name)) return 'app'
    if (v === 'name') return (await privateByName(ses, u)) ? 'private' : null
    return null
  }
  // ... nor a public name that resolves to it here (127.0.0.1.nip.io, localtest.me): what this session's resolver says, a minute at a
  // time. A name that does not resolve is refused too (nothing to reach anyway). A name that resolves to a public address now and to a
  // private one when the page connects (DNS rebinding) is not caught — the address is not seen at connect time.
  async function privateByName(ses, u) {
    if (privateHost(u)) return true
    let h
    try { h = new URL(String(u)).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '') } catch { return false }
    if (!h || privateIp(h) !== null) return false
    const had = state.names.get(h)
    if (had && had.until > Date.now()) return had.private
    let priv = true
    try {
      const r = await withTimeout(ses.resolveHost(h), 3000, 'resolving')
      const ends = r?.endpoints || []
      priv = !ends.length || ends.some((e) => privateIp(String(e.address || '').toLowerCase()) !== false)
    } catch { priv = true }
    state.names.set(h, { private: priv, until: Date.now() + 60_000 })
    if (state.names.size > 500) state.names.delete(state.names.keys().next().value)
    return priv
  }
  // Every request of this person's session — the page, its pictures and scripts, a fetch, a form, a socket, a popup's first page — is
  // checked first (the navigation checks below see only navigations, and a popup's first request can come before them): never the Lite
  // app or its sign-in; while a task nobody watches holds the browser, not this PC's network either (state.noPrivate).
  function guardRequests(ses) {
    if (!ses?.webRequest) return
    ses.webRequest.onBeforeRequest((d, cb) => {
      const u = String(d.url || '')
      verdictOf(ses, u).then((v) => {
        if (!v) return cb({})
        if (v === 'app') {
          let w = null
          try { w = d.webContents && d.resourceType === 'mainFrame' ? BrowserWindow.fromWebContents(d.webContents) : null } catch { /* gone */ }
          if (d.resourceType === 'mainFrame') refusedApp(u, w)
          else log(`[browser] refused (the Lite app or its sign-in): ${d.resourceType}`)
          return cb({ cancel: true })
        }
        log(`[browser] refused (a task nobody watches, this PC's network): ${d.resourceType}`)
        cb({ cancel: true })
      }, () => cb({ cancel: true }))
    })
    // (every request says it is this browser's: the Lite server refuses its API and sign-in to it, by any address it is reached at)
    ses.webRequest.onBeforeSendHeaders?.((d, cb) => cb({ requestHeaders: { ...d.requestHeaders, [AGENT_HEADER]: '1' } }))
  }
  // What a Lite page kept in this person's session before 0.2.6 (its storage, cookies, service workers — a page opened here then): cleared
  // once for each of the app's origins, and noted in <userData>/browser-cleared.json so it is not done again
  async function clearAppStorage(ses) {
    if (typeof ses?.clearStorageData !== 'function' || !state.partition) return
    const { server, authOrigins } = appCtx()
    const out = new Set(authOrigins.map(originOf).filter((o) => /^https?:/.test(o)))
    try {
      const s = new URL(server)
      out.add(s.origin)
      // (a server on this PC, by the names it is opened at)
      if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(s.hostname)) for (const h of ['localhost', '127.0.0.1', '[::1]']) out.add(`${s.protocol}//${h}${s.port ? `:${s.port}` : ''}`)
    } catch { /* no server yet */ }
    let file = '', done = {}
    try { file = path.join(electron.app.getPath('userData'), 'browser-cleared.json'); done = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch { /* none yet */ }
    if (!file) return
    const had = new Set(Array.isArray(done[state.partition]) ? done[state.partition] : [])
    const todo = [...out].filter((o) => !had.has(o))
    if (!todo.length) return
    for (const origin of todo) {
      try { await withTimeout(ses.clearStorageData({ origin }), 5000, 'clearing'); had.add(origin) } catch (e) { log('[browser] clearing', origin, e.message) }
    }
    done[state.partition] = [...had].slice(-50)
    try { fs.writeFileSync(file, JSON.stringify(done), { mode: 0o600 }) } catch (e) { log('[browser] clearing', e.message) }
  }
  const host = { emit: () => false }
  // While the server drives this browser, the app is not put to sleep: macOS naps an app whose windows are all hidden (its timers and
  // drawing slow to a crawl — the live view and the pictures would wait for seconds). Released two minutes after the last operation.
  let blocker = null, blockerTimer = null
  host.awake = () => {
    try { if (blocker === null || !electron.powerSaveBlocker.isStarted(blocker)) blocker = electron.powerSaveBlocker.start('prevent-app-suspension') } catch { /* not here */ }
    clearTimeout(blockerTimer)
    blockerTimer = setTimeout(() => { try { electron.powerSaveBlocker.stop(blocker) } catch { /* gone */ } blocker = null }, 120_000)
    blockerTimer.unref?.()
  }

  // ---- tabs ----
  const prefs = () => ({ partition: state.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: true,
    spellcheck: false, devTools: false, safeDialogs: true, autoplayPolicy: 'user-gesture-required' })
  const windowOptions = () => ({ show: false, width: VIEW.width, height: VIEW.height, useContentSize: true, paintWhenInitiallyHidden: true, fullscreenable: false,
    autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: prefs() })
  function windowFor() {
    return new BrowserWindow({ ...windowOptions(), title: 'Process GPT Lite — 브라우저' })
  }
  async function addTab(win, opener = null) {
    win.pglBrowser = true // (main.js: windows of this browser do not keep the app open on Windows · Linux)
    const wc = win.webContents
    const tab = { id: ++state.seq, win, wc, opener, cdp: null, cast: null }
    // (the first tab, shown on this PC and closed by the person: hidden — the task goes on. A popup closes as it would in Chrome, and the
    // work goes back to the page that opened it)
    win.on('close', (e) => { if (!state.quitting && !tab.dropping && state.shown && tab === state.tabs[0]) { e.preventDefault(); show({ on: false }) } })
    win.on('closed', () => dropTab(tab))
    // (shown on this PC: the title says which site it is — a page's own title can claim anything; no fullscreen; no sound while hidden)
    const title = (t = wc.getTitle()) => { try { win.setTitle(`${originOf(wc.getURL()) || 'about:blank'} — ${String(t || '').slice(0, 80)}`) } catch { /* gone */ } }
    win.on('page-title-updated', (e, t) => { e.preventDefault(); title(t) })
    wc.on('did-navigate', () => title())
    wc.on('enter-html-full-screen', () => { try { win.setFullScreen(false) } catch { /* gone */ } })
    wc.setAudioMuted(!state.shown)
    // a page that asks 「leave this page?」 (beforeunload — a form with something typed in it): it is left. Electron's own answer is to
    // stay, which kept the agent's next address and the blank page after a task (with a vault value typed into it) from loading
    wc.on('will-prevent-unload', (e) => e.preventDefault())
    // pages go only to web addresses, never the Lite app (for a task nobody watches, not this PC's own network)
    const refuse = (e, url) => {
      if (allowed(url)) return
      e.preventDefault()
      if (webAddress(url) && !mayGo(url) && e.isMainFrame !== false) refusedApp(url, win)
    }
    wc.on('will-navigate', (e) => refuse(e, e.url))
    wc.on('will-redirect', (e) => refuse(e, e.url))
    wc.on('will-frame-navigate', (e) => refuse(e, e.url))
    wc.on('will-attach-webview', (e) => e.preventDefault())
    // a link that opens a new tab, a sign-in popup: a tab of its own (hidden), and the work goes there — back when it closes
    // (at most POPUPS a task and MAX_TABS at once: a page opening window after window is refused)
    wc.setWindowOpenHandler(({ url }) => {
      // (windows on their way count too: twelve window.open() in one click come before the first tab is made)
      if (url && webAddress(url) && !mayGo(url)) { refusedApp(url, win); return { action: 'deny' } }
      if ((url && !allowed(url)) || state.popups >= POPUPS || state.tabs.length + state.coming >= MAX_TABS) return { action: 'deny' }
      state.popups++
      state.coming++
      return { action: 'allow', overrideBrowserWindowOptions: windowOptions() }
    })
    wc.on('did-create-window', (child) => {
      addTab(child, tab).then((t) => follow(t)).catch((e) => log('[browser] new tab', e.message)).finally(() => { state.coming = Math.max(0, state.coming - 1) })
    })
    // (a first tab gets a document to attach to; a popup is on its way to its own address — it is not sent elsewhere)
    if (!opener && !wc.getURL()) await wc.loadURL('about:blank').catch(() => {})
    tab.cdp = new Cdp(wc.debugger, { guard: String(P.GUARD_JS) })
    tab.cdp.on('event', (method, p, sid) => {
      if (method === 'Page.fileChooserOpened' && tab.chooser) tab.chooser({ ...p, session: sid })
      // the page closed its own window (pageScripts GUARD_JS window.close): this tab goes, the work goes back to the page that opened it
      if (method === 'Runtime.consoleAPICalled' && !sid && p.type === 'debug' && p.args?.[0]?.value === '__pgl_close_tab__') {
        log('[browser] the page closed its own window')
        tab.dropping = true
        setImmediate(() => { try { win.destroy() } catch { /* gone */ } })
      }
      // a dialog that got past the page guard (one before it ran, a beforeunload): answered at once — never a box on this PC
      if (method === 'Page.javascriptDialogOpening') {
        keepDialog(`${p.type}: ${p.message || ''}`)
        tab.cdp.send('Page.handleJavaScriptDialog', { accept: p.type === 'beforeunload' }, sid).catch(() => {})
      }
    })
    tab.cdp.on('navigated', () => { if (tab === state.active) host.emit({ type: 'browser-event', kind: 'navigated', at: at() }) })
    try { await tab.cdp.start() } catch {
      // (a popup with no renderer yet: once its document is there)
      await new Promise((r) => { const done = () => r(); wc.once('dom-ready', done); setTimeout(done, 3000) })
      await tab.cdp.start()
    }
    state.tabs.push(tab)
    return tab
  }
  function keepDialog(line) { state.dialogs.push(String(line).slice(0, 220)); if (state.dialogs.length > 5) state.dialogs.shift() }
  function dropTab(tab) {
    const i = state.tabs.indexOf(tab)
    if (i < 0) return
    state.tabs.splice(i, 1)
    stopLive(tab)
    try { tab.cdp?.close() } catch { /* gone */ }
    if (state.active === tab) {
      const back = state.tabs.includes(tab.opener) ? tab.opener : state.tabs.at(-1) || null
      state.active = null
      if (back) follow(back).catch(() => {})
      else if (!state.quitting) log('[browser] the last tab closed (a new one opens with the next task)')
    }
  }
  async function follow(tab) {
    if (state.active === tab) return
    // (a tab whose window was shown on this PC and hidden since: a fresh one at its address takes its place first)
    if (tab.shownOnce && !state.shown && !tab.win.isDestroyed()) tab = await refresh(tab)
    const was = state.active
    if (was) stopLive(was)
    state.active = tab
    state.frameOf = new Map()
    if (state.shown) { try { tab.win.show(); tab.shownOnce = true; was?.win.hide() } catch { /* gone */ } }
    await startLive(tab).catch((e) => log('[browser] live view', e.message))
    host.emit({ type: 'browser-event', kind: 'moved', at: at() })
  }
  // the tab the work is in: the active one, else (it went — a page closed it, a crash) the newest tab still there, which becomes active
  const alive = (t) => !!t && !t.win.isDestroyed()
  function liveTab() {
    if (alive(state.active)) return state.active
    const t = state.tabs.filter(alive).at(-1) || null
    if (t) { state.active = null; follow(t).catch(() => {}) }
    return t
  }
  const tab = () => {
    const t = liveTab()
    if (!t) throw Object.assign(new Error('the browser is not open on this PC'), { code: 'closed' })
    return t
  }
  // (a page that closed its own last window: a new tab — the work goes on there)
  async function ensureTab() {
    if (state.replacing) await state.replacing.catch(() => {})
    if (liveTab() || !state.partition) return
    // (operations that run beside the queued one — stop, a takeover key, a frame — ask at the same moment: one new tab for all of them)
    if (!state.ensuring) {
      log('[browser] no tab left: a new one')
      state.ensuring = (async () => { await follow(await addTab(windowFor())) })().finally(() => { state.ensuring = null })
    }
    return state.ensuring
  }

  // ---- the screen: the tab's screencast, 1280×800 at most (the server's own browser's size) ----
  // Every picture comes from it — the live view (to the server, at most one per live.minMs, always the newest, made 1024×640) and the
  // model's picture (the next frame after the page changed). Never a capture: a capture of a hidden window leaves it hidden after, and
  // a hidden window draws nothing — scrolls then waited 1.2 s each and the live view stopped (measured 2026-11-24). Each frame is
  // acknowledged once, at most ten a second (the screencast sends the next frame only after that).
  const ACK_MS = 100
  async function startLive(t) {
    stopLive(t)
    let lastSent = 0, lastAck = 0, timer = null, ackTimer = null, unacked = []
    const ackAll = () => { ackTimer = null; lastAck = Date.now(); for (const f of unacked.splice(0)) t.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}) }
    const send = () => {
      timer = null
      const f = t.latest
      if (!f || f.sent || state.active !== t || !state.busy) return
      f.sent = true
      lastSent = Date.now()
      host.emit({ type: 'browser-frame', data: smaller(f.data), url: t.wc.getURL() })
    }
    const onFrame = (method, p) => {
      if (method !== 'Page.screencastFrame') return
      t.latest = { data: p.data, ts: (p.metadata?.timestamp || 0) * 1000, at: Date.now(), seq: (t.latest?.seq || 0) + 1 }
      for (const w of t.waiters.splice(0)) w(t.latest)
      unacked.push(p)
      // (a picture is wanted now: no holding back — the next frame is the one it waits for)
      const ackIn = t.waiters.length ? 0 : lastAck + ACK_MS - Date.now()
      if (ackIn <= 0) { clearTimeout(ackTimer); ackAll() } else if (!ackTimer) ackTimer = setTimeout(ackAll, ackIn)
      const sendIn = lastSent + state.live.minMs - Date.now()
      if (sendIn <= 0) { clearTimeout(timer); send() } else if (!timer) timer = setTimeout(send, sendIn)
    }
    t.waiters ||= []
    t.cdp.on('event', onFrame)
    t.cast = { stop: () => { clearTimeout(timer); clearTimeout(ackTimer); ackAll(); t.cdp.off('event', onFrame); t.cdp.send('Page.stopScreencast').catch(() => {}) } }
    await t.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 })
  }
  function stopLive(t) { if (t?.cast) { t.cast.stop(); t.cast = null } }
  // the live view's size (1024×640 at quality 50 — the server's own)
  function smaller(b64) {
    try {
      const img = electron.nativeImage.createFromBuffer(Buffer.from(b64, 'base64'))
      const { width, height } = img.getSize()
      if (width <= state.live.width) return b64
      return img.resize({ width: state.live.width, height: Math.round(height * state.live.width / width), quality: 'good' }).toJPEG(50).toString('base64')
    } catch { return b64 }
  }
  // A frame drawn after now: the page is made to draw for a few frames (a pixel in a corner, all but transparent, changes at each) and
  // the picture is the first frame swapped after the second of them began — by then what changed before (masks on the secret fields)
  // is in every frame drawn. The newest frame there is when none comes in time (a page that does not draw at all).
  // strict: a picture drawn after the change or none (the model's picture: never one from before the secret fields were painted over)
  async function freshFrame(ms, { strict = false } = {}) {
    const t = tab()
    const waitFor = (since) => new Promise((resolve) => {
      const on = (f) => { if (f.ts ? f.ts > since : f.at > since + 16) resolve(f); else t.waiters.push(on) }
      t.waiters.push(on)
    })
    const since = await t.cdp.call(t.cdp.main, () => new Promise((resolve) => {
      let d = document.getElementById('__pro_tick')
      if (!d) { d = document.createElement('div'); d.id = '__pro_tick'; d.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none;opacity:.02'; (document.body || document.documentElement).appendChild(d) }
      // (it draws until the picture is taken — __proTickUntil — at most 2 s)
      window.__proTickUntil = Date.now() + 2000
      let n = 0
      const step = () => {
        d.style.background = n % 2 ? '#000' : '#fff'
        if (++n === 2) resolve(performance.timeOrigin + performance.now())
        if (Date.now() < window.__proTickUntil) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }), [], { ms: 1500 }).catch(() => null)
    const t0 = Date.now()
    const f = since ? await withTimeout(waitFor(since), ms, 'the picture').catch(() => (strict ? null : t.latest)) : strict ? null : t.latest
    t.cdp.call(t.cdp.main, () => { window.__proTickUntil = 0 }, [], { ms: 1000 }).catch(() => {})
    if (process.env.PGL_BROWSER_TRACE === '1') console.log(`[browser] picture ${since ? `drawn ${Math.round(f?.ts - since)} ms after the change` : 'as it was'}, waited ${Date.now() - t0} ms`)
    if (!f) throw new Error(strict ? 'no picture drawn after the page changed' : 'no picture of the page yet')
    return f.data
  }
  // ---- where things are ----
  const viewport = () => { try { const [width, height] = tab().win.getContentSize(); return { width, height } } catch { return { ...VIEW } } }
  function at() {
    const t = state.active
    if (!t || t.win.isDestroyed()) return null
    return { url: t.wc.getURL(), title: t.wc.getTitle(), vp: viewport(), tab: t.id, tabs: state.tabs.length }
  }
  // element i of the last look: its frame, its box on the tab's screen (scrolled into view first) and whether a press lands on it
  async function element(i, { scroll = true } = {}) {
    const t = tab()
    const fid = state.frameOf.get(Number(i)) || t.cdp.main
    const e = await t.cdp.call(fid, P.ELEMENT_JS, [Number(i), scroll], { ms: 3000 })
    if (!e) throw Object.assign(new Error('this element is no longer on the page (the page changed since the last look)'), { code: 'gone' })
    const off = await t.cdp.offsetOf(fid).catch(() => null)
    if (!off) throw new Error('the frame of this element is not on the screen')
    return { fid, ...e, cx: off.x + e.x + e.width / 2, cy: off.y + e.y + e.height / 2, x: off.x + e.x, y: off.y + e.y }
  }
  // a field typed into (not one that takes its value directly — a date, a colour, a range — nor a select or a checkbox)
  const typable = (e) => (e.tag === 'INPUT' ? !['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week', 'checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'hidden'].includes(String(e.type || 'text').toLowerCase())
    : e.tag === 'TEXTAREA' || e.editable)
  async function mouse(type, x, y, extra = {}) {
    await tab().cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' || type === 'mouseWheel' ? 'none' : 'left', clickCount: type === 'mouseMoved' || type === 'mouseWheel' ? 0 : 1, ...extra })
  }
  async function press(key) {
    const t = tab()
    const m = /^(ControlOrMeta|Control|Meta|Alt|Shift)\+(.+)$/.exec(String(key || ''))
    const base = m ? m[2] : String(key || '')
    const mod = m ? (m[1] === 'ControlOrMeta' ? (MAC ? 4 : 2) : { Alt: 1, Control: 2, Meta: 4, Shift: 8 }[m[1]]) : 0
    // (pasting would put this PC's clipboard into the page — a viewer's text comes as text, typed as it is)
    if (mod && mod !== 8 && base.toLowerCase() === 'v') throw new Error('pasting from this PC\'s clipboard is not allowed: send the text instead')
    const k = KEYS[base] || (base.length === 1 ? [base.toUpperCase().charCodeAt(0), base] : null)
    if (!k) throw new Error(`Unknown key: "${base.slice(0, 20)}"`)
    const [code, text] = k
    // (⌘A on a Mac is an editing command, not a character)
    const commands = mod === 4 && MAC ? ({ a: ['selectAll'], c: ['copy'], x: ['cut'], z: ['undo'] }[base.toLowerCase()] || []) : []
    const common = { key: base === 'Space' ? ' ' : base, code: base.length === 1 ? `Key${base.toUpperCase()}` : base, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: mod }
    await t.cdp.send('Input.dispatchKeyEvent', { type: text && !mod ? 'keyDown' : 'rawKeyDown', ...common, ...(text && !mod ? { text, unmodifiedText: text } : {}), ...(commands.length ? { commands } : {}) })
    await t.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  }
  // one character as a key a person presses (keydown · keypress · input · keyup — what the page sees when someone types it)
  async function typeKey(ch) {
    const t = tab()
    const up = ch.toUpperCase()
    const letter = /^[a-z]$/i.test(ch), digit = /^[0-9]$/.test(ch)
    const code = letter ? `Key${up}` : digit ? `Digit${ch}` : ch === ' ' ? 'Space' : ''
    const vk = letter || digit ? up.charCodeAt(0) : ch === ' ' ? 32 : 0
    const mods = letter && ch !== ch.toLowerCase() ? 8 : 0
    const base = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods }
    await t.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: ch })
    await t.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }
  // after a press: a moment for the page to react, then the new document when it navigated (bounded) — in the tab that was pressed (a
  // press that opened a new tab has moved the work there; that tab is not waited on)
  async function settle(t = state.active) {
    await pause(500)
    if (!t || state.active !== t) return
    await t.cdp.waitStage('DOMContentLoaded', 5000).catch(() => {})
  }
  // a press at element i, once it is where a press lands on it (as Playwright's: it waits a while for what covers it to go)
  async function pressAt(i, ms = 8000) {
    const end = Date.now() + ms
    let e = await element(i)
    while (!e.hit && Date.now() < end) { await pause(250); e = await element(i) }
    if (!e.hit) throw new Error('another element is over this one and would receive the click')
    await mouse('mouseMoved', e.cx, e.cy)
    await mouse('mousePressed', e.cx, e.cy)
    await mouse('mouseReleased', e.cx, e.cy)
    return e
  }
  async function eachFrame(fn) {
    const t = tab()
    const out = []
    for (const fid of [...t.cdp.contexts.keys()]) out.push(await t.cdp.call(fid, fn, [P.SECRET_SELECTOR], { ms: 1500 }).catch(() => null))
    return out
  }
  async function show({ on = true } = {}) {
    if (state.replacing) await state.replacing.catch(() => {})
    const t = state.active
    state.shown = !!on
    if (!t || t.win.isDestroyed()) return false
    for (const x of state.tabs) { try { x.wc.setAudioMuted(!on) } catch { /* gone */ } }
    if (on) { t.win.show(); t.win.focus(); t.shownOnce = true } else {
      t.win.hide()
      // A window shown here and hidden again draws no new document in Electron: the next page the agent opened in it answered
      // nothing (no picture, no look, 5 s a click — measured 2026-11-25). The work goes on in a fresh hidden tab at the same address;
      // the one the person closed goes. (What was typed into that page and not sent is not carried over.)
      state.replacing = refresh(t).then((f) => follow(f)).finally(() => { state.replacing = null })
      await state.replacing.catch((e) => log('[browser] a fresh tab after hiding', e.message))
    }
    host.emit({ type: 'browser-event', kind: on ? 'shown' : 'hidden' })
    return true
  }
  // a fresh hidden tab in t's place (its order — the first tab stays first — its opener, the tabs it opened) at t's address; t goes
  async function refresh(t) {
    const url = t.win.isDestroyed() ? '' : t.wc.getURL()
    const fresh = await addTab(windowFor(), t.opener)
    state.tabs.splice(state.tabs.indexOf(fresh), 1)
    const i = state.tabs.indexOf(t)
    state.tabs.splice(i < 0 ? state.tabs.length : i, 0, fresh)
    for (const x of state.tabs) if (x.opener === t) x.opener = fresh
    if (/^https?:/i.test(url)) {
      const r = await withTimeout(fresh.cdp.send('Page.navigate', { url }), state.step.navMs, 'reopening').catch(() => null)
      if (r?.loaderId) await fresh.cdp.waitStage('DOMContentLoaded', state.step.navMs, r.loaderId).catch(() => {})
    }
    if (state.active === t) { stopLive(t); state.active = null }
    t.dropping = true
    try { t.win.destroy() } catch { /* gone */ }
    return fresh
  }
  function downloadsDir() { try { return electron.app?.getPath('downloads') || null } catch { return null } }
  // name.ext, else name (2).ext …
  function freeName(dir, name) {
    const clean = path.basename(String(name || 'download')).replace(/[\\/:*?"<>|]/g, '_') || 'download'
    const ext = path.extname(clean), stem = clean.slice(0, clean.length - ext.length)
    for (let n = 1; n < 1000; n++) {
      const f = path.join(dir, n === 1 ? clean : `${stem} (${n})${ext}`)
      if (!fs.existsSync(f)) return f
    }
    return path.join(dir, `${stem}-${Date.now()}${ext}`)
  }
  async function writeTemp(name, data) {
    const dir = await fs.promises.mkdtemp(path.join(tmp, 'f-')).catch(async () => { await fs.promises.mkdir(tmp, { recursive: true }); return fs.promises.mkdtemp(path.join(tmp, 'f-')) })
    const file = path.join(dir, path.basename(String(name || 'file')).replace(/[\\/:*?"<>|]/g, '_') || 'file')
    await fs.promises.writeFile(file, data)
    state.files.add(dir)
    // (the page reads the file when it uploads it — kept a while, and gone when the browser closes)
    setTimeout(() => { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); state.files.delete(dir) }, 10 * 60_000).unref?.()
    return file
  }

  // This person's session: no site gets the camera, the microphone, the screen, the location or notifications (nobody is there to be
  // asked — as in the server's headless browser); downloads go into a temporary folder, then to the server (a file card there).
  function prepare(ses) {
    if (ses.__pglDownloads) return
    ses.__pglDownloads = true
    guardRequests(ses)
    const ALLOW = new Set(['clipboard-sanitized-write'])
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOW.has(permission)))
    ses.setPermissionCheckHandler((_wc, permission) => ALLOW.has(permission))
    try { ses.setDisplayMediaRequestHandler((_r, cb) => cb({})) } catch { /* older Electron */ }
    // Every download of this session is this browser's (no other window uses it): it is never left to the system's Save box — a path of
    // its own, or cancelled. Only while a task holds the browser; at most MAX_DOWNLOAD bytes, whether or not the site says its size.
    ses.on('will-download', (_e, item, wc) => {
      const name = item.getFilename() || 'download'
      if (!state.busy) {
        // (shown on this PC, nobody's task holds it: the person's own download — to this PC's Downloads folder, never to the server)
        if (state.shown) {
          const dir = downloadsDir()
          if (dir) { item.setSavePath(freeName(dir, name)); return }
        }
        item.cancel()
        return
      }
      if (item.getTotalBytes() > MAX_DOWNLOAD) { item.cancel(); host.emit({ type: 'browser-event', kind: 'download', name, error: `it is over ${Math.round(MAX_DOWNLOAD / 1048576)} MB`, status: 413 }); return }
      fs.mkdirSync(tmp, { recursive: true })
      const dir = fs.mkdtempSync(path.join(tmp, 'd-'))
      const file = path.join(dir, name.replace(/[\\/:*?"<>|]/g, '_'))
      item.setSavePath(file)
      let over = false
      item.on('updated', () => { if (!over && item.getReceivedBytes() > MAX_DOWNLOAD) { over = true; item.cancel() } })
      item.once('done', async (_ev, st) => {
        try {
          if (over) { host.emit({ type: 'browser-event', kind: 'download', name, error: `it is over ${Math.round(MAX_DOWNLOAD / 1048576)} MB`, status: 413 }); return }
          if (st !== 'completed') { host.emit({ type: 'browser-event', kind: 'download', name, error: `the download ${st}` }); return }
          const size = (await fs.promises.stat(file)).size
          if (size > MAX_DOWNLOAD) { host.emit({ type: 'browser-event', kind: 'download', name, error: `it is over ${Math.round(MAX_DOWNLOAD / 1048576)} MB`, status: 413 }); return }
          const data = await fs.promises.readFile(file)
          host.emit({ type: 'browser-event', kind: 'download', name, size: data.length, data: data.toString('base64') })
        } catch (e) { host.emit({ type: 'browser-event', kind: 'download', name, error: e.message.slice(0, 80) }) } finally {
          fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
          // a tab that opened only to download (no page of its own) closes, as Chrome does, and the work goes back — also one whose
          // download was over before it became a tab here (a quick file: the window is still on its way — 2026-11-25 review)
          const blank = (w) => !w.isDestroyed() && (!w.getURL() || w.getURL() === 'about:blank')
          const from = state.tabs.find((t) => t.wc === wc)
          if (from && from !== state.tabs[0] && blank(from.wc)) { from.dropping = true; try { from.win.destroy() } catch { /* gone */ } }
          else if (!from && wc && blank(wc)) {
            const w = BrowserWindow.fromWebContents(wc)
            if (w && !state.tabs.some((t) => t.win === w)) { try { w.destroy() } catch { /* gone */ } }
          }
        }
      })
    })
  }

  // ---- the operations (protocol.js names them; the server's lib/browserRemote.js calls them) ----
  Object.assign(host, {
    // (the person's browser was opened on this PC: its operations are taken — one with no tab left gets a new tab first)
    opened: () => !!state.partition,
    ensureTab,
    at,
    async open({ user, live, snap, step } = {}) {
      if (live) state.live = { minMs: Math.max(100, Number(live.minMs) || 333), width: Number(live.width) || 1024, height: Number(live.height) || 640 }
      if (snap) state.snap = { ...state.snap, ...snap }
      if (step) state.step = { ...state.step, ...step }
      const partition = `persist:pgl-browser-${String(user).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64)}`
      // the same person's browser stays (a link that came back finds its page); another person's goes first
      if (state.partition && state.partition !== partition) await host.close()
      state.user = user
      state.partition = partition
      prepare(electronSession.fromPartition(partition))
      await clearAppStorage(electronSession.fromPartition(partition)).catch((e) => log('[browser] clearing', e.message))
      if (!liveTab()) {
        const t = await addTab(windowFor())
        await follow(t)
      } else await startLive(state.active).catch(() => {})
      return { shown: state.shown }
    },
    // a task takes this browser: frames and downloads go to the server from now; noPrivate — a task nobody watches: not this PC's network
    async begin({ noPrivate = false } = {}) {
      state.busy = true
      state.noPrivate = !!noPrivate
      state.popups = 0
      state.dialogs = []
      state.refused = []
      await ensureTab()
      if (state.active && !state.active.cast) await startLive(state.active).catch(() => {})
      return true
    },
    // the task is over: nothing more goes to the server, the page is cleared (what was typed into it — a vault value — goes with it), the
    // window hides and makes no sound. The page stays when it is shown on this PC (the person is using it), and when the task ended
    // needing the person (keep: 「이 PC에서 보기」 opens it here — the server says so on the card)
    async idle({ keep = false } = {}) {
      state.busy = false
      state.noPrivate = false
      const t = liveTab()
      if (!t) return true
      stopLive(t)
      if (!state.shown && !keep) {
        await withTimeout(t.cdp.send('Page.navigate', { url: 'about:blank' }), 3000, 'clearing the page').catch(() => {})
        // (the answer says where the page is: once the blank page is in — Electron's URL follows CDP's a moment later)
        for (const end = Date.now() + 2000; !t.win.isDestroyed() && t.wc.getURL() !== 'about:blank' && Date.now() < end;) await new Promise((r) => setTimeout(r, 30))
      }
      return true
    },
    async healthy() {
      // (no tab left: a new one)
      if (!liveTab()) { await ensureTab(); return true }
      const t = tab()
      const ok = await t.cdp.call(t.cdp.main, () => 1, [], { ms: 3000 }).then(() => true, () => false)
      if (ok) return true
      // a page whose script never returns: its renderer ends and a fresh tab takes the work (the stuck one closes)
      log('[browser] the page stopped answering: a fresh tab')
      try { t.wc.forcefullyCrashRenderer() } catch { /* gone */ }
      const fresh = await addTab(windowFor())
      await follow(fresh)
      t.dropping = true
      try { t.win.destroy() } catch { /* gone */ }
      return true
    },
    // after a task: the tabs it opened go — not the one the work ended in, nor the pages that opened it (a window a page opened
    // closes with its opener: closing those closed the work's own tab — measured 2026-11-25, a lodging site's results in a new tab)
    async closeTabs() {
      const keep = new Set()
      for (let t = state.active; t && !keep.has(t); t = t.opener) keep.add(t)
      for (const t of [...state.tabs]) if (!keep.has(t)) { t.dropping = true; try { t.win.destroy() } catch { /* gone */ } }
      return true
    },
    async navigate({ url }) {
      const t = tab()
      const t0 = Date.now()
      if (!webAddress(url)) return { ok: false, partial: false, ms: 0, error: 'only web addresses (http · https) open in this browser' }
      if (!mayGo(url) || await verdictOf(electronSession.fromPartition(state.partition), url) === 'app') { refusedApp(url, t.win); return { ok: false, partial: false, ms: Date.now() - t0, error: APP_REFUSED } }
      const own = 'a task nobody watches does not open addresses on this PC\'s own network'
      if (!allowed(url)) return { ok: false, partial: false, ms: 0, error: own }
      if (state.noPrivate && await privateByName(electronSession.fromPartition(state.partition), url)) return { ok: false, partial: false, ms: Date.now() - t0, error: own }
      const { navMs, settleMs } = state.step
      let committed = false, error = null, loader = null
      try {
        const r = await withTimeout(t.cdp.send('Page.navigate', { url }), navMs + 1000, 'open')
        if (r.errorText) throw new Error(`net::${r.errorText.replace(/^net::/, '')}`)
        committed = true
        loader = r.loaderId || null // (none: the same document — a jump to an anchor)
        await t.cdp.waitStage('DOMContentLoaded', Math.max(1000, navMs - (Date.now() - t0)), loader)
      } catch (e) { error = e }
      if (!error) await t.cdp.waitStage('load', settleMs, loader).catch(() => {})
      // (still loading, or a navigation that never got an answer: stopped, and what is there is what the agent gets)
      if (error) await t.cdp.send('Page.stopLoading').catch(() => {})
      const ms = Date.now() - t0
      if (committed) return { ok: true, partial: !!error, ms, error: '' }
      return { ok: false, partial: false, ms, error: String(error?.message || error || 'not opened').split('\n')[0].slice(0, 160) }
    },
    // the agent's view (as the server's lookAll): the main frame, then the frames on the screen big enough to hold content, numbered on
    async look() {
      const t = tab()
      const { maxEls, maxText, budgetMs } = state.snap
      const t0 = Date.now()
      const left = () => state.step.snapMs - (Date.now() - t0)
      const main = await t.cdp.call(t.cdp.main, P.SNAPSHOT_JS, [{ maxEls, maxText, budgetMs }], { ms: state.step.snapMs })
      if (!main) return null
      const frameOf = new Map()
      let n = main.els.length
      const extra = []
      const vp = viewport()
      for (const [fid, f] of t.cdp.frames) {
        if (fid === t.cdp.main || n >= maxEls || left() < 500 || !t.cdp.contexts.has(fid) || !f.parentId) continue
        const box = await withTimeout(t.cdp.offsetOf(fid), Math.min(1000, left()), 'frame').catch(() => null)
        if (!box || box.width < 120 || box.height < 60 || box.y >= vp.height || box.y + box.height <= 0 || box.x >= vp.width || box.x + box.width <= 0) continue
        const sub = await t.cdp.call(fid, P.SNAPSHOT_JS, [{ maxEls: maxEls - n, maxText: Math.max(500, Math.floor(maxText / 2)), budgetMs: Math.min(budgetMs, 800), base: n }], { ms: Math.min(3000, left()) }).catch(() => null)
        if (!sub || (!sub.els.length && !sub.text)) continue
        for (const e of sub.els) frameOf.set(e.i, fid)
        main.els.push(...sub.els)
        n += sub.els.length
        main.fields = { password: main.fields.password || sub.fields.password, signIn: main.fields.signIn || sub.fields.signIn }
        let host = ''
        try { host = new URL(sub.url).host } catch { /* about:blank, srcdoc */ }
        if (sub.text) extra.push(`[frame${host ? ` ${host}` : ''}]\n${sub.text}`)
      }
      if (extra.length) main.text = [main.text, ...extra].join('\n').slice(0, maxText + 1500)
      // a page's alert · confirm · prompt since the last look (answered already — the agent learns what it said)
      const said = [...state.dialogs.splice(0)]
      for (const fid of [...t.cdp.contexts.keys()]) said.push(...((await t.cdp.call(fid, P.DIALOGS_JS, [], { ms: 1000 }).catch(() => null)) || []))
      if (said.length) main.text += `\n${said.slice(-5).map((d) => `[dialog] ${d}`).join('\n')}`
      // an address of the Lite app a page went for since the last look (not opened)
      const refused = [...new Set(state.refused.splice(0))]
      if (refused.length) main.text += `\n${refused.map((r) => `[not opened] ${r}`).join('\n')}`
      state.frameOf = frameOf
      return main
    },
    async describe({ i, ms = 1500 }) {
      const t = tab()
      const fid = state.frameOf.get(Number(i)) || t.cdp.main
      return t.cdp.call(fid, `(i) => { const e = document.querySelector('[data-pro-idx="' + i + '"]'); if (!e) throw new Error('gone'); return (${P.DESCRIBE_JS})(e) }`, [Number(i)], { ms })
    },
    async isSecret({ i }) {
      const t = tab()
      const fid = state.frameOf.get(Number(i)) || t.cdp.main
      return t.cdp.call(fid, `(i, sel) => { const e = document.querySelector('[data-pro-idx="' + i + '"]'); if (!e) throw new Error('this element is no longer on the page'); return (${P.IS_SECRET_JS})(e, sel) }`, [Number(i), P.SECRET_SELECTOR], { ms: 3000 })
    },
    async box({ i }) {
      const e = await element(i)
      const vp = viewport()
      return { x: Math.round(e.cx), y: Math.round(e.cy), w: vp.width, h: vp.height }
    },
    async click({ i }) {
      const t = tab()
      await withTimeout(pressAt(i), 9000, 'the click')
      await settle(t)
      return true
    },
    async fill({ i, text = '', enter = false }) {
      const t = tab()
      const e = await element(i)
      // (a press first: the field gets the focus a person's press gives it, in whatever frame it is — not a field that takes its value
      // directly: a press there opens its picker, a window of its own)
      if (e.hit && typable(e)) { await mouse('mouseMoved', e.cx, e.cy); await mouse('mousePressed', e.cx, e.cy); await mouse('mouseReleased', e.cx, e.cy) }
      const how = await t.cdp.call(e.fid, P.FOCUS_JS, [Number(i), String(text)], { ms: 3000 })
      if (how === 'type') {
        if (text) await t.cdp.send('Input.insertText', { text: String(text) })
        else await press('Delete')
      }
      if (enter) { await press('Enter'); await settle() }
      return true
    },
    // a vault value: its field marked first (masked from now on — the live view never shows it), then typed in — at once, or key by
    // key as a person types (keys: sign-in pages that read the keys their fields get); never kept here, never logged
    async fillSecret({ i, value = '', keys = false }) {
      const t = tab()
      const e = await element(i)
      await t.cdp.call(e.fid, P.MARK_SECRET_JS, [Number(i)], { ms: 2000 }).catch(() => {})
      if (e.hit && typable(e)) { await mouse('mouseMoved', e.cx, e.cy); await mouse('mousePressed', e.cx, e.cy); await mouse('mouseReleased', e.cx, e.cy) }
      const how = await t.cdp.call(e.fid, P.FOCUS_JS, [Number(i), ''], { ms: 3000 })
      if (how !== 'type') await t.cdp.call(e.fid, P.FOCUS_JS, [Number(i), String(value)], { ms: 3000 })
      else if (!keys) await t.cdp.send('Input.insertText', { text: String(value) })
      else {
        await press('Delete')
        for (const ch of String(value)) { await typeKey(ch); await pause(40 + Math.floor(Math.random() * 60)) }
      }
      return true
    },
    // a key on element i (Enter sends a sign-in form), then the page's answer
    async press({ i, key }) {
      const t = tab()
      const e = await element(i, { scroll: false })
      await t.cdp.call(e.fid, (n) => { const x = document.querySelector(`[data-pro-idx="${n}"]`); if (x && document.activeElement !== x) x.focus() }, [Number(i)], { ms: 2000 })
      await press(key)
      await settle()
      return true
    },
    async scroll({ i = null, dy = 600 }) {
      let x, y
      if (i != null && i !== '') { const e = await element(i, { scroll: false }).catch(() => null); if (e) { x = e.cx; y = e.cy } }
      if (x == null) { const vp = viewport(); x = vp.width / 2; y = vp.height / 2 }
      await mouse('mouseMoved', x, y)
      await mouse('mouseWheel', x, y, { deltaX: 0, deltaY: Number(dy) || 600 })
      return true
    },
    // the model's picture: secret fields painted over in every frame first, and taken off after
    async shot() {
      await eachFrame(P.MASK_ON_JS)
      try { return await freshFrame(state.step.shotMs, { strict: true }) } finally { await eachFrame(P.MASK_OFF_JS) }
    },
    frameShot: async () => smaller(await freshFrame(Math.min(2000, state.step.shotMs))),
    words: async () => { const w = await tab().cdp.call(tab().cdp.main, P.PAGE_WORDS_JS, [], { ms: 5000 }); return typeof w === 'string' ? w.slice(0, MAX_WORDS) : w },
    text: () => tab().cdp.call(tab().cdp.main, () => (document.body ? document.body.innerText.slice(0, 6000) : ''), [], { ms: state.step.snapMs }),
    async stop() { await tab().cdp.send('Page.stopLoading').catch(() => {}); return true },
    // a file the task was given, into the page's file field — or through the file picker the control opens
    async attach({ i, name, data }) {
      const t = tab()
      const file = await writeTemp(name, Buffer.from(String(data || ''), 'base64'))
      const e = await element(i)
      if (await t.cdp.call(e.fid, P.IS_FILE_JS, [Number(i)], { ms: 3000 })) {
        const { objectId, session } = await t.cdp.call(e.fid, P.ELEMENT_AT_JS, [Number(i)], { ms: 3000, byValue: false })
        await t.cdp.send('DOM.setFileInputFiles', { files: [file], objectId }, session)
        return true
      }
      const sessions = [...t.cdp.sessions]
      await Promise.all(sessions.map((s) => t.cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, s).catch(() => {})))
      try {
        const opened = new Promise((resolve) => { t.chooser = resolve })
        await pressAt(i)
        const c = await withTimeout(opened, 8000, 'the file picker')
        await t.cdp.send('DOM.setFileInputFiles', { files: [file], backendNodeId: c.backendNodeId }, c.session || '')
        return true
      } finally {
        t.chooser = null
        await Promise.all(sessions.map((s) => t.cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }, s).catch(() => {})))
      }
    },
    // takeover from a viewer's card (web, phone): their clicks and keys, as fractions of the screen
    async input(ev = {}) {
      const vp = viewport()
      if (ev.type === 'click') { const x = Number(ev.x) * vp.width, y = Number(ev.y) * vp.height; await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y) }
      if (ev.type === 'key') await press(ev.key)
      if (ev.type === 'text') await tab().cdp.send('Input.insertText', { text: String(ev.text || '').slice(0, 2000) })
      if (ev.type === 'scroll') await mouse('mouseWheel', vp.width / 2, vp.height / 2, { deltaX: 0, deltaY: Number(ev.dy) || 0 })
      return true
    },
    show: (a = {}) => show({ on: a.on !== false }),
    // (runner/index.js: the link to the server went down — nothing is sent and nothing is guarded for a task that is not here; the page
    // stays, for the task to find when the same PC is back)
    linkDown() {
      state.busy = false
      state.noPrivate = false
      if (state.active && !state.active.win.isDestroyed()) stopLive(state.active)
      return true
    },
    async close() {
      state.quitting = true
      for (const t of [...state.tabs]) { t.dropping = true; try { t.win.destroy() } catch { /* gone */ } }
      state.tabs = []
      state.active = null
      state.quitting = false
      // (the next open names the person again: no partition is kept from this one)
      state.partition = null
      state.user = null
      state.busy = false
      state.noPrivate = false
      for (const d of state.files) fs.promises.rm(d, { recursive: true, force: true }).catch(() => {})
      state.files.clear()
      return true
    },
    // (main.js: the app is quitting — windows close for real)
    quit() { state.quitting = true; for (const t of [...state.tabs]) { try { t.win.destroy() } catch { /* gone */ } } },
    state,
  })
  return host
}

module.exports = { createBrowserHost, webAddress, privateHost, privateIp, requestVerdict, APP_REFUSED, AGENT_HEADER, NOTICE_MS, VIEW, POPUPS, MAX_WORDS }
