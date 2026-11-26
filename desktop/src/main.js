'use strict'
// Process GPT Lite desktop: one window around a Lite server the person chooses once (a company address such as
// https://acme.process-gpt.io/lite, or a local install such as http://localhost:18080). Nothing of Lite is bundled:
// the window shows the server's own web app, signed in the web app's own way (email code, Google).
//
// The window has no title bar of its own, like our other desktop apps (Ontological Studio, Robo Architect), and no
// band either: the web app's sky runs up to the window's top edge (2026-11-24 decision — seamless first; a solid band
// in the sky's colour or a white/black one only as fallbacks). macOS keeps its traffic lights inside the app's top
// bar; Windows and Linux draw the caption buttons over its right end, on a transparent overlay ('seamless') or, with
// settings titleBar: 'sky', on the colour the page shows there. The preload marks the page (html.pgl-desktop + the
// room those buttons take) and the web app's src/styles/desktop.css makes its top bar the drag strip and steps around
// the buttons.

// A Claude Code hook of a local run (runner/session.js · runner/hook.js) runs this same binary as its node: `<app> --pgl-hook <Event> <file>`
// appends the event and quits here — before anything of the app (no window, no single-instance lock, so the running app never hears of it)
const HOOK_AT = process.argv.indexOf('--pgl-hook')
if (HOOK_AT > 0) require('./runner/hook').run(process.argv.slice(HOOK_AT + 1))

const { app, BrowserWindow, Menu, ipcMain, shell, session, net, screen, clipboard, desktopCapturer, safeStorage, dialog } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const settings = require('./settings')
const server = require('./server')
const policy = require('./policy')
const downloads = require('./downloads')
const menu = require('./menu')
const { createLocalRunner } = require('./runner')
const { uploadQuestion } = require('./runner/sync')
const CLIS = require('./runner/clis')
const { createBrowserHost } = require('./browser/host')
const { createTrayBadge } = require('./tray')

const MAC = process.platform === 'darwin'
const DEV = !app.isPackaged || process.env.PGL_DESKTOP_DEV === '1'
const PAGES = path.join(__dirname, 'pages')
const PAGES_URL = pathToFileURL(PAGES).href + '/'
// macOS: the traffic lights centred on the web app's 68px top bar; three 14px buttons 23px apart (macOS 26)
const LIGHTS = { x: 20, y: 27 }
const LIGHTS_END = LIGHTS.x + 60
// Windows · Linux: the caption buttons (three 46px) drawn over the page's top right
const CAPTION = { width: 138, height: 40 }
// before the page paints (no white flash): the top of the web app's sky, by the theme it last had (src/sky/palette.js)
const SKY_TOP = { dark: '#0a0f24', light: '#4670ad' }
const skyTop = () => SKY_TOP[settings.get().theme === 'light' ? 'light' : 'dark']
const SYMBOL = { dark: '#f5f5f7', light: '#1d1d1f' }

// a separate profile for tests and side-by-side runs (also keeps the single-instance lock apart)
if (process.env.PGL_DESKTOP_USER_DATA) app.setPath('userData', path.resolve(process.env.PGL_DESKTOP_USER_DATA))
// A plain Chrome user agent: Google refuses its sign-in page to agents that name an embedded framework
app.userAgentFallback = app.userAgentFallback
  .replace(/ Electron\/\S+/, '')
  .replace(new RegExp(` ${app.getName().replace(/[^\w.-]/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\S+`), '')
  .replace(/ process-gpt-lite-desktop\/\S+/i, '')

let win = null
let lastFailure = null // what the offline page shows
let trayBadge = null // the tray icon and the count of Home cards waiting (tray.js) — made in start()

// ---------- single instance ----------
// (a hook run — above — has left already; never ask for the lock from it: the running app would bring its window up)
if (HOOK_AT > 0) {
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.whenReady().then(start)
  app.on('window-all-closed', () => { if (!MAC) app.quit() })
  app.on('activate', () => { if (!win && app.isReady()) createWindow() })
}

function start() {
  settings.init(app.getPath('userData'), safeStorage)
  if (!settings.get().lang) settings.set({ lang: /^ko\b/i.test(app.getLocale()) ? 'ko' : 'en' })
  app.setAboutPanelOptions({ applicationName: 'Process GPT Lite', applicationVersion: app.getVersion(), copyright: '© uEngine' })
  if (MAC && !app.isPackaged) { try { app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png')) } catch { /* no icon yet */ } }
  setupSession(session.defaultSession)
  buildMenu()
  createWindow()
  startTray()
  startRunner()
  // the server's Supabase sign-in address may change (or was never read): ask again quietly
  const s = settings.get().server
  if (s) server.check(s, { fetch: net.fetch, ...(settings.gate() || {}) }).then((r) => { if (r.ok && r.server === s) settings.set({ authOrigins: r.authOrigins }) }).catch(() => {})
}

// ---------- the window ----------
function insets() {
  // [left, right]: the room the window's own buttons take at the top of the page
  return MAC ? [LIGHTS_END, 0] : [0, CAPTION.width]
}

function mainPrefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: DEV,
    spellcheck: true,
    additionalArguments: [`--pgl-insets=${insets().join(',')}`, `--pgl-version=${app.getVersion()}`],
  }
}
// windows the page opens on its own address (a file it shows, 원본 받기): an ordinary framed window, no preload
const childPrefs = () => ({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: DEV })

function restoreBounds(saved) {
  const def = { width: 1280, height: 820 }
  if (!saved || !(saved.width > 0) || !(saved.height > 0)) return def
  const b = { x: saved.x, y: saved.y, width: Math.max(400, saved.width), height: Math.max(560, saved.height) }
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return { width: b.width, height: b.height }
  // only where a screen still is (a monitor unplugged since): at least 100×60 of it on some display
  const seen = screen.getAllDisplays().some(({ workArea: a }) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) >= 100 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >= 60)
  return seen ? b : { width: b.width, height: b.height }
}

function createWindow() {
  const saved = settings.get().window
  win = new BrowserWindow({
    ...restoreBounds(saved),
    minWidth: 400,
    minHeight: 560,
    show: false,
    title: 'Process GPT Lite',
    backgroundColor: skyTop(),
    titleBarStyle: 'hidden',
    ...(MAC
      ? { trafficLightPosition: LIGHTS }
      : { titleBarOverlay: overlay(settings.get().theme) }),
    webPreferences: mainPrefs(),
  })
  if (saved?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())
  // Windows: the taskbar button's count goes on once the button is there (a window made again on macOS: the same count)
  win.on('show', () => trayBadge?.refresh())
  // (a page that never gets ready — a server that does not answer at all — still shows the window)
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show() }, 4000)

  const wc = win.webContents
  guard(wc)
  for (const [ev, on] of [['enter-full-screen', true], ['leave-full-screen', false]]) win.on(ev, () => wc.send('pgl:fullscreen', on))
  wc.on('did-finish-load', () => {
    if (win.isFullScreen()) wc.send('pgl:fullscreen', true)
    if (isServerPage(wc.getURL())) readLang(wc)
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3: a navigation replaced by another (not a failure)
    if (!isMainFrame || code === -3 || url.startsWith(PAGES_URL)) return
    showOffline({ url, code, desc })
  })
  wc.on('did-navigate', (_e, url, status, statusText) => {
    // a gateway in front of the server answering for it (502 · 503 · 504), or a tunnel's gate refusing
    if (isServerPage(url) && (status >= 500 || status === 401)) showOffline({ url, code: status, desc: statusText, http: true })
  })

  let timer = null
  const remember = () => { clearTimeout(timer); timer = setTimeout(saveWindow, 400) }
  win.on('resize', remember)
  win.on('move', remember)
  win.on('close', saveWindow)
  win.on('closed', () => {
    win = null
    // (the browser on this PC keeps hidden windows of its own: they do not hold the app open — browser/host.js)
    if (!MAC && BrowserWindow.getAllWindows().every((w) => w.pglBrowser)) app.quit()
  })

  if (settings.get().server) loadServer()
  else showSetup()
  return win
}

function saveWindow() {
  if (!win || win.isDestroyed()) return
  const b = win.isFullScreen() ? (settings.get().window || {}) : win.getNormalBounds()
  settings.set({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() } })
}

const serverUrl = () => settings.get().server || ''
const ctx = () => ({ server: serverUrl(), authOrigins: settings.get().authOrigins || [] })
const isServerPage = (url) => !!serverUrl() && policy.kind(url, ctx()) === 'app' && !String(url).startsWith('about:')

function loadServer(sub = '/chat') {
  if (!win) return
  const s = serverUrl()
  if (!s) return showSetup()
  lastFailure = null
  win.loadURL(s + sub).catch(() => { /* did-fail-load shows the offline page */ })
}
// the local pages draw the same sky as the web app, in the theme it last had
const pageQuery = () => ({ query: { theme: settings.get().theme === 'light' ? 'light' : 'dark', lang: settings.get().lang === 'en' ? 'en' : 'ko' } })
function showSetup() { if (win) win.loadFile(path.join(PAGES, 'setup.html'), pageQuery()) }
function showOffline(f) {
  lastFailure = { url: f.url || serverUrl(), code: f.code, desc: f.desc || '', http: !!f.http }
  if (win) win.loadFile(path.join(PAGES, 'offline.html'), pageQuery())
}

// the web app's language (html lang) for the menu
function readLang(wc) {
  wc.executeJavaScript('document.documentElement.lang', true).then((l) => {
    const lang = l === 'en' ? 'en' : 'ko'
    if (lang !== settings.get().lang) { settings.set({ lang }); buildMenu() }
  }).catch(() => {})
}

// ---------- where pages may go ----------
function openExternal(url) {
  if (!policy.openable(url)) return
  // tests: record instead of opening a browser
  if (process.env.PGL_DESKTOP_EXTERNAL === 'log') { (global.__pglExternal ||= []).push(url); return }
  shell.openExternal(url).catch(() => {})
}

function guard(wc) {
  const onNav = (e, url, _inPlace, isMainFrame) => {
    // (frames inside the page — the office editor, an embedded video — go where they go)
    if (e?.isMainFrame === false || isMainFrame === false) return
    const target = e?.url || url
    const k = policy.kind(target, ctx())
    // the app's own local pages (setup, offline) are loaded by this process, never by a page
    if (k === 'app' || k === 'auth') return
    e.preventDefault()
    if (k === 'external') openExternal(target)
  }
  wc.on('will-navigate', onNav)
  wc.on('will-redirect', onNav)
  wc.on('will-attach-webview', (e) => e.preventDefault())
  wc.setWindowOpenHandler(({ url }) => {
    const k = policy.kind(url, ctx())
    if (k === 'app' && url !== 'about:blank') {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 800, backgroundColor: '#ffffff', autoHideMenuBar: true, webPreferences: childPrefs() } }
    }
    if (k === 'external' || k === 'auth') openExternal(url)
    return { action: 'deny' }
  })
  wc.on('did-create-window', (child) => guard(child.webContents))
  wc.on('context-menu', (_e, p) => contextMenu(wc, p))
}

// what a right click offers where the page does not handle it: editing, copying, a link
function contextMenu(wc, p) {
  const t = menu.strings(settings.get().lang)
  const items = []
  if (p.isEditable) {
    items.push({ label: t.undo, role: 'undo', enabled: p.editFlags.canUndo }, { label: t.redo, role: 'redo', enabled: p.editFlags.canRedo }, { type: 'separator' },
      { label: t.cut, role: 'cut', enabled: p.editFlags.canCut }, { label: t.copy, role: 'copy', enabled: p.editFlags.canCopy },
      { label: t.paste, role: 'paste', enabled: p.editFlags.canPaste }, { label: t.selectAll, role: 'selectAll' })
  } else if (p.selectionText) {
    items.push({ label: t.copy, role: 'copy' })
  }
  if (p.linkURL && /^https?:/i.test(p.linkURL)) {
    if (items.length) items.push({ type: 'separator' })
    const ko = settings.get().lang !== 'en'
    items.push({ label: ko ? '링크를 브라우저에서 열기' : 'Open Link in Browser', click: () => openExternal(p.linkURL) },
      { label: ko ? '링크 주소 복사' : 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) })
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) || undefined })
}

// ---------- session: permissions, downloads, screen sharing ----------
const ALLOWED = new Set(['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'speaker-selection'])
function setupSession(ses) {
  const fromServer = (url) => !!url && policy.kind(url, ctx()) === 'app'
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    // a mail or phone link the navigation guard did not see: handed to the system here, never by Chromium itself
    if (permission === 'openExternal') { if (fromServer(details.requestingUrl)) openExternal(details.externalURL); return cb(false) }
    cb(ALLOWED.has(permission) && fromServer(details.requestingUrl))
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED.has(permission) && fromServer(origin))
  // a window opened only to download a file (원본 받기) stays empty: close it once the download starts
  ses.on('will-download', (_e, item, wc) => {
    // the page's 「내려받기」 (spec file-download): straight into Downloads under the page's name, as a browser does — Electron would ask
    // with a save dialog; on a Mac the Downloads stack in the Dock bounces when it is there. Only the chosen server's own (a blob: it made,
    // its routes): anything else keeps the dialog
    if (!item.getSavePath() && downloads.quietSave(item.getURL(), ctx())) {
      try { item.setSavePath(downloads.savePathFor(app.getPath('downloads'), item.getFilename(), require('node:fs').existsSync)) } catch { /* the system's dialog then */ }
      item.once('done', (_ev, state) => { if (state === 'completed' && process.platform === 'darwin') try { app.dock?.downloadFinished?.(item.getSavePath()) } catch { /* no Dock */ } })
    }
    const w = wc && BrowserWindow.fromWebContents(wc)
    if (w && w !== win && (!wc.getURL() || wc.getURL() === 'about:blank')) setTimeout(() => { if (!w.isDestroyed()) w.close() }, 200)
  })
  // meetings' 화면 공유 (getDisplayMedia): the system's own picker where there is one (macOS 15+), else the first screen
  ses.setDisplayMediaRequestHandler((request, cb) => {
    if (!fromServer(request.securityOrigin || request.frame?.url)) return cb({})
    desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb(s[0] ? { video: s[0] } : {})).catch(() => cb({}))
  }, { useSystemPicker: true })
}

// a server behind a basic-auth gate (a tunnel): answered from the setup page's pair, once per request
app.on('login', (e, wc, details, info, cb) => {
  // (only the app's own window: the browser the server's agent drives here has a session of its own and never gets the pair)
  const mainSession = !!wc && !wc.isDestroyed?.() && wc.session === session.defaultSession
  if (!policy.answersGate({ mainSession, isProxy: info.isProxy, url: details.url, server: serverUrl() })) return
  const g = settings.gate()
  e.preventDefault()
  if (g && !(details.firstAuthAttempt === false)) cb(g.user, g.pass)
  else cb()
})

// ---------- menu ----------
function buildMenu() {
  const nav = (fn) => () => { const wc = win?.webContents; if (wc) fn(wc) }
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu.template({
    lang: settings.get().lang,
    mac: MAC,
    dev: DEV,
    server: serverUrl(),
    h: {
      changeServer: () => { if (!win) createWindow(); showSetup() },
      // on the offline page a reload is a retry
      reload: nav((wc) => (wc.getURL().startsWith(PAGES_URL) ? (lastFailure ? loadServer() : wc.reload()) : wc.reload())),
      forceReload: nav((wc) => (wc.getURL().startsWith(PAGES_URL) ? (lastFailure ? loadServer() : wc.reload()) : wc.reloadIgnoringCache())),
      back: nav((wc) => { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack() }),
      forward: nav((wc) => { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward() }),
      open: (sub) => { if (!win) createWindow(); else loadServer(sub) },
      openInBrowser: nav((wc) => openExternal(isServerPage(wc.getURL()) ? wc.getURL() : serverUrl())),
    },
  })))
  // (the tray's words follow the same language)
  trayBadge?.refresh()
}

// ---------- the local pages (setup, offline) ----------
const fromLocalPage = (e) => String(e.senderFrame?.url || '').startsWith(PAGES_URL)

ipcMain.handle('pgl:state', (e) => {
  if (!fromLocalPage(e)) return null
  const s = settings.get()
  const g = settings.gate()
  return {
    lang: s.lang || 'ko',
    platform: process.platform,
    version: app.getVersion(),
    server: s.server || '',
    recent: s.recent || [],
    gateUser: g?.user || '',
    hasGatePass: !!g?.pass,
    failure: lastFailure,
    localDefault: 'http://localhost:18080',
  }
})

ipcMain.handle('pgl:connect', async (e, v) => {
  if (!fromLocalPage(e)) return { ok: false, reason: 'denied' }
  const input = String(v?.url || '').slice(0, 2000)
  const user = String(v?.user || '').slice(0, 200)
  // an empty password with the same user keeps the one saved before
  const old = settings.gate()
  const pass = v?.pass ? String(v.pass).slice(0, 500) : (old && old.user === user ? old.pass : '')
  const r = await server.check(input, { fetch: net.fetch, user, pass })
  if (!r.ok) return r
  settings.useServer(r.server, r.authOrigins)
  settings.setGate(user, pass)
  // the count was the last server's (its page sends its own once it loads)
  trayBadge?.set(0)
  buildMenu()
  loadServer()
  // the local runner follows the server (a pairing is per server)
  startRunner()
  return r
})

ipcMain.on('pgl:cancel', (e) => { if (fromLocalPage(e) && serverUrl()) loadServer() })
ipcMain.on('pgl:retry', async (e, quiet) => {
  if (!fromLocalPage(e)) return
  if (quiet && !(await server.check(serverUrl(), { fetch: net.fetch, timeout: 5000, ...(settings.gate() || {}) })).ok) return
  // back where it failed (a page of the app), else the chat
  const u = lastFailure?.url
  if (u && isServerPage(u) && win) { lastFailure = null; win.loadURL(u).catch(() => {}) } else loadServer()
})
ipcMain.on('pgl:change-server', (e) => { if (fromLocalPage(e)) showSetup() })

// the web app's theme (light by day, dark by night — src/stores/sky.js): remembered for the next start's background,
// and on Windows · Linux the caption buttons' symbols follow it
function overlay(theme, color) {
  const t = theme === 'light' ? 'light' : 'dark'
  return { color: color || '#00000000', symbolColor: SYMBOL[t], height: CAPTION.height }
}
ipcMain.on('pgl:theme', (e, theme) => {
  if (!win || e.sender !== win.webContents || !['light', 'dark'].includes(theme)) return
  if (theme !== settings.get().theme) settings.set({ theme })
  win.setBackgroundColor(skyTop())
  if (!MAC) paintOverlay()
})
// 'seamless' (default): a transparent overlay, the sky shows through. 'sky' (desktop-settings.json titleBar: "sky", where an
// overlay cannot be transparent): a solid band in the colour the page shows beside the buttons, read every minute
let sampler = null
function paintOverlay() {
  if (!win || win.isDestroyed()) return
  const theme = settings.get().theme
  if (settings.get().titleBar !== 'sky') { try { win.setTitleBarOverlay(overlay(theme)) } catch { /* not this platform */ } return }
  const [w] = win.getContentSize()
  win.webContents.capturePage({ x: Math.max(0, w - CAPTION.width - 6), y: 4, width: 2, height: 2 }).then((img) => {
    const b = img.toBitmap() // BGRA
    const hex = b.length >= 4 ? '#' + [b[2], b[1], b[0]].map((v) => v.toString(16).padStart(2, '0')).join('') : skyTop()
    try { win.setTitleBarOverlay(overlay(theme, hex)) } catch { /* not this platform */ }
  }).catch(() => {})
  if (!sampler) sampler = setInterval(paintOverlay, 60000)
}


// ---------- the local CLI agents (runner/, design docs/local-agents/design.md) ----------
// This computer's Claude Code · Codex run the signed-in person's process steps when an activity names them. main keeps one outgoing link
// to the server (runner/link.js); the page only pairs it (a device token it got from the server, through the bridge below — main never
// reads the page's cookies or storage), sees its state and sets the person's two switches (local runs on/off, ask before each run).
let runner = null
let cliCache = null
// The browser on this PC that the server's browser agent drives when the person's browser tasks run here (browser/host.js — 0.2.3): made
// once, kept across the runner's restarts (its windows are hidden until 「이 PC에서 보기」). PGL_DESKTOP_BROWSER=0: none (an older app's way).
let browserHost = null
const localBrowser = () => {
  if (process.env.PGL_DESKTOP_BROWSER === '0') return null
  browserHost ||= createBrowserHost({ electron: require('electron'), log: (...a) => runnerLog(a.join(' ')) })
  return browserHost
}
const runnerLog = (s) => { if (DEV || process.env.PGL_RUNNER_LOG === '1') console.log(s) }
// (PGL_RUNNER_DEVICE_NAME: a name of one's own — the tests' screenshots carry no machine name)
const deviceName = () => (process.env.PGL_RUNNER_DEVICE_NAME || require('node:os').hostname().replace(/\.local$/i, '')).slice(0, 60) || 'Desktop'
function stopRunner() { if (runner) { try { runner.stop() } catch { /* gone */ } runner = null; sendFolderState() } }
function startRunner() {
  stopRunner()
  const s = serverUrl()
  const p = s && settings.pairing(s)
  if (!p) return sendRunnerState()
  runner = createLocalRunner({
    server: s, token: p.token, dataDir: path.join(app.getPath('userData'), 'local-agents'),
    device: { name: deviceName(), platform: process.platform, appVersion: app.getVersion() },
    prefs: () => settings.runnerPrefs(), ask: askRun, log: runnerLog, browser: localBrowser(),
    // (the folders of this computer kept as Lite folders: this person's on this server — another person signed in here has their own)
    folders: settings.folderStore(s, p.userId), userId: p.userId,
    // tests: the fake CLIs' folder first (PGL_RUNNER_PATH)
    ...(process.env.PGL_RUNNER_PATH ? { searchPath: `${process.env.PGL_RUNNER_PATH}${path.delimiter}${CLIS.augmentedPath()}` } : {}),
  })
  runner.ev.on('state', sendRunnerState)
  runner.ev.on('folders', sendFolderState)
  // someone suggested a prompt for a run of this computer: a system notification (tests: global.__pglNotices)
  runner.ev.on('notice', (n) => {
    const ko = settings.get().lang !== 'en'
    const who = n.by || (ko ? '다른 사람' : 'Someone')
    const c = who.trim().slice(-1).charCodeAt(0)
    const ga = c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? '이' : '가'
    // (attention: the CLI in the step's terminal waits for its person — a permission prompt, idle — its own Notification hook)
    const title = n.kind === 'steer' ? (ko ? `${who}${ga} 「${n.activity}」의 방향을 바꿨어요` : `${who} steered "${n.activity}"`)
      : n.kind === 'attention' ? (ko ? `「${n.activity}」 — 터미널에서 답을 기다려요` : `"${n.activity}" waits for you in its terminal`)
        : (ko ? `${who}의 제안 · 「${n.activity}」 — 입력란에서 골라 입력하세요` : `${who} suggested a prompt for "${n.activity}" — pick it at the input`)
    ;(global.__pglNotices ||= []).push({ ...n, title })
    try { const { Notification } = require('electron'); if (Notification.isSupported()) new Notification({ title, body: n.text || '' }).show() } catch { /* no notifications here */ }
  })
  runner.start().catch((e) => runnerLog(`[runner] ${e.message}`))
}
function runnerStatus() {
  const s = serverUrl()
  const p = s ? settings.pairing(s) : null
  const base = { paired: !!p, deviceId: p?.deviceId || null, userId: p?.userId || null, deviceName: deviceName(), platform: process.platform, prefs: settings.runnerPrefs() }
  if (runner) return { ...base, ...runner.status() }
  return { ...base, connected: false, clis: cliCache || {}, running: [] }
}
function sendRunnerState() {
  const wc = win?.webContents
  if (wc && !wc.isDestroyed() && isServerPage(wc.getURL())) wc.send('pgl:runner:state', runnerStatus())
  // the Dock shows that an agent works on this computer (● — a count of Home cards waiting comes first: tray.js)
  if (trayBadge) trayBadge.dock()
  else if (MAC && app.dock) { try { app.dock.setBadge(localRunning() ? '●' : '') } catch { /* no dock */ } }
}
const localRunning = () => (runner?.runner?.jobs?.size || 0) > 0
// the person's yes before a run (their setting 「실행 전에 묻기」)
async function askRun(job) {
  const ko = settings.get().lang !== 'en'
  if (process.env.PGL_RUNNER_ASK === 'yes') return true
  if (process.env.PGL_RUNNER_ASK === 'no') return false
  if (win) { if (win.isMinimized()) win.restore(); win.show() }
  const r = await dialog.showMessageBox(win || undefined, {
    type: 'question', buttons: ko ? ['이 컴퓨터에서 실행', '이번에는 하지 않기'] : ['Run on this computer', 'Not this time'], defaultId: 0, cancelId: 1,
    message: ko ? `${job.label || job.agent}(으)로 「${job.activity}」 단계를 이 컴퓨터에서 실행할까요?` : `Run the step "${job.activity}" with ${job.label || job.agent} on this computer?`,
    detail: `${job.instName || ''}\n${ko ? '작업 폴더' : 'Work folder'}: ${job.git?.folder?.name || ''}`,
  })
  return r.response === 0
}
// only the chosen server's own pages, in the main window
const fromServerPage = (e) => !!win && e.sender === win.webContents && isServerPage(String(e.senderFrame?.url || ''))
const TOKEN = /^pld1_[A-Za-z0-9_-]{43}$/
const ID = /^[0-9a-f-]{36}$/i
ipcMain.handle('pgl:runner:status', async (e) => {
  if (!fromServerPage(e)) return null
  if (!runner && !cliCache) cliCache = await CLIS.detect().catch(() => ({}))
  return runnerStatus()
})
ipcMain.handle('pgl:runner:may-pair', (e, userId) => (fromServerPage(e) ? !settings.optedOut(serverUrl(), String(userId || '')) : false))
ipcMain.handle('pgl:runner:pair', (e, v) => {
  if (!fromServerPage(e)) return { ok: false, reason: 'denied' }
  const token = String(v?.token || '')
  if (!TOKEN.test(token) || !ID.test(String(v?.deviceId || '')) || !ID.test(String(v?.userId || ''))) return { ok: false, reason: 'invalid' }
  settings.setPairing(serverUrl(), { token, deviceId: String(v.deviceId), userId: String(v.userId), userName: String(v?.userName || '').slice(0, 80) })
  startRunner()
  return { ok: true }
})
ipcMain.handle('pgl:runner:forget', (e, v) => {
  if (!fromServerPage(e)) return { ok: false }
  stopRunner()
  settings.forgetPairing(serverUrl(), { optOut: !!v?.optOut })
  sendRunnerState()
  return { ok: true }
})
ipcMain.handle('pgl:runner:prefs', (e, v) => {
  if (!fromServerPage(e)) return null
  settings.set({ runnerPrefs: { enabled: v?.enabled !== false, ask: v?.ask === true, finishMinutes: settings.finishMinutesOf(v?.finishMinutes), browser: settings.browserPrefOf(v?.browser ?? settings.runnerPrefs().browser) } })
  runner?.prefsChanged()
  sendRunnerState()
  return settings.runnerPrefs()
})
ipcMain.handle('pgl:runner:detect', async (e) => {
  if (!fromServerPage(e)) return null
  if (runner) await runner.detect()
  else cliCache = await CLIS.detect().catch(() => ({}))
  sendRunnerState()
  return runnerStatus()
})

// ---------- 챔피언 폴더: a folder of this computer kept as a Lite folder (runner/sync.js — desktop 0.2.5) ----------
// The page asks (pglDesktop.folders); main picks the folder in the system's own dialog, and asks the person once more in a system dialog
// before the first upload — the page's click alone uploads nothing. The page never sends or receives a path: it gets a pick id, a label
// (the folder's name) and what would go up. The folders are the paired person's on this server (the runner's — runner/index.js): when
// another person signs in here, or on sign-out, theirs stop with the runner.
const folderSync = () => runner?.folders || null
// tests only — an app that is not packaged (`electron .` under Playwright): main's own global stands in for the two system dialogs
// ({pick: <folder> | null, confirm: 'yes' | 'no'}); a packaged app never reads it
const testDialogs = () => (!app.isPackaged && global.__pglTestFolders) || null
const relList = (a) => (Array.isArray(a) ? a.slice(0, 500).map((x) => String(x || '').slice(0, 1000)) : [])
const folderWords = () => settings.get().lang !== 'en'
function sendFolderState() {
  const wc = win?.webContents
  if (wc && !wc.isDestroyed() && isServerPage(wc.getURL())) wc.send('pgl:folders:state', folderSync()?.list() || [])
}
async function pickFolder() {
  const t = testDialogs()
  if (t && 'pick' in t) return t.pick ? String(t.pick) : null
  const ko = folderWords()
  if (win) { if (win.isMinimized()) win.restore(); win.show() }
  const r = await dialog.showOpenDialog(win || undefined, {
    title: ko ? '올릴 폴더 고르기' : 'Choose a folder to upload', buttonLabel: ko ? '이 폴더 고르기' : 'Choose', properties: ['openDirectory', 'dontAddToRecent'],
  })
  return r.canceled ? null : r.filePaths[0] || null
}
// the person's yes before the first upload: what goes up, where (and how many flagged files stay here, how many go with it) — in a
// system dialog
async function confirmUpload({ files, bytes, folderName, report, flaggedIn, flaggedOut }) {
  let host = ''
  try { host = new URL(serverUrl()).host } catch { /* none */ }
  const ko = folderWords()
  const { message, detail } = uploadQuestion({ files, bytes, folderName, host, report, flaggedIn, flaggedOut, lang: ko ? 'ko' : 'en' })
  const t = testDialogs()
  if (t) { (global.__pglFolderDialogs ||= []).push({ message, detail }); return t.confirm === 'yes' }
  if (win) { if (win.isMinimized()) win.restore(); win.show() }
  const r = await dialog.showMessageBox(win || undefined, {
    type: flaggedIn ? 'warning' : 'question', buttons: ko ? ['올리기', '취소'] : ['Upload', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true, message, detail,
  })
  return r.response === 0
}
ipcMain.handle('pgl:folders:pick', async (e) => {
  if (!fromServerPage(e)) return null
  const f = folderSync()
  if (!f) return { error: 'not_linked' }
  const dir = await pickFolder()
  if (!dir) return null
  return f.pick(dir)
})
ipcMain.handle('pgl:folders:preview', async (e, pickId, v) => {
  if (!fromServerPage(e)) return null
  const f = folderSync()
  if (!f) return { error: 'not_linked' }
  return f.preview(String(pickId || ''), { include: relList(v?.include), exclude: relList(v?.exclude) })
})
ipcMain.handle('pgl:folders:bind', async (e, v) => {
  if (!fromServerPage(e)) return { ok: false, why: 'denied' }
  const f = folderSync()
  if (!f) return { ok: false, why: 'not_linked' }
  return f.bind({ pickId: String(v?.pickId || ''), folderId: String(v?.folderId || ''), folderName: String(v?.folderName || '').slice(0, 120),
    include: relList(v?.include), exclude: relList(v?.exclude) }, { confirm: confirmUpload })
})
ipcMain.handle('pgl:folders:list', (e) => (fromServerPage(e) ? folderSync()?.list() || [] : []))
ipcMain.handle('pgl:folders:sync-now', async (e, id) => {
  if (!fromServerPage(e)) return { ok: false, why: 'denied' }
  const f = folderSync()
  return f ? f.syncNow(String(id || '')) : { ok: false, why: 'not_linked' }
})
ipcMain.handle('pgl:folders:unbind', async (e, id) => {
  if (!fromServerPage(e)) return { ok: false, why: 'denied' }
  const f = folderSync()
  return f ? f.unbind(String(id || '')) : { ok: false, why: 'not_linked' }
})
// the picked folder in Finder · Explorer (main opens it; the page never learns where it is)
ipcMain.handle('pgl:folders:reveal', async (e, id) => {
  if (!fromServerPage(e)) return { ok: false, why: 'denied' }
  const dir = folderSync()?.pathOf(String(id || ''))
  if (!dir) return { ok: false, why: 'not_bound' }
  if (process.env.PGL_DESKTOP_EXTERNAL === 'log') { (global.__pglRevealed ||= []).push(dir); return { ok: true } }
  const err = await shell.openPath(dir).catch((x) => x.message)
  return err ? { ok: false, why: 'folder_missing' } : { ok: true }
})

// ---------- the tray icon and the count of Home cards waiting (tray.js · badge.js) ----------
// The web app counts the cards (src/browserNotify.js setBadge) and sends the number over the preload's bridge (pglDesktop.setBadge):
// the Dock (macOS) or the launcher (Linux, where it has one), the taskbar button's overlay (Windows), and the tray icon everywhere —
// the number beside the menu bar icon on macOS, a red badge on the icon on Windows · Linux. Its click brings the window up; its menu:
// 열기 · 알림 N개 — 열기 (Home) · 종료.
// Closing the window is as before (not changed with the tray): Windows · Linux quit (the tray icon goes with the app), macOS keeps
// running in the Dock and the menu bar — the tray's click or 열기 makes the window again.
function startTray() {
  try {
    trayBadge = createTrayBadge({
      electron: require('electron'), iconDir: path.join(__dirname, '..', 'resources', 'tray'),
      lang: () => settings.get().lang, mainWindow: () => win, dockMark: () => (localRunning() ? '●' : ''),
      show: showWindow, openHome, quit: () => app.quit(), log: runnerLog,
    })
  } catch (e) { console.warn(`[tray] ${e.message}`) }
  // tests (e2e D-12): the tray's state and menu, from the main process
  global.__pglTray = trayBadge
}
function showWindow() {
  if (!win) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  // (a click on the menu bar does not make the app the active one)
  if (MAC) app.focus({ steal: true })
}
// 「알림 N개 — 열기」: Home — the chat with its dock open (the web app's src/main.js answers pglDesktop.onOpenHome)
function openHome() {
  const had = !!win
  showWindow()
  // (a window made just now opens the chat, Home with it)
  if (!had || !win) return
  const wc = win.webContents
  if (isServerPage(wc.getURL())) wc.send('pgl:open-home')
  else if (serverUrl()) loadServer('/chat')
}
// only the chosen server's own pages, in the main window, say the count
ipcMain.on('pgl:badge', (e, n) => { if (fromServerPage(e)) trayBadge?.set(n) })

app.on('before-quit', () => { browserHost?.quit(); stopRunner(); trayBadge?.destroy() })
