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
const { app, BrowserWindow, Menu, ipcMain, shell, session, net, screen, clipboard, desktopCapturer, safeStorage } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const settings = require('./settings')
const server = require('./server')
const policy = require('./policy')
const menu = require('./menu')

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

// ---------- single instance ----------
if (!app.requestSingleInstanceLock()) {
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
  win.on('closed', () => { win = null })

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
  ses.on('will-download', (_e, _item, wc) => {
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
app.on('login', (e, _wc, details, info, cb) => {
  if (info.isProxy || !serverUrl() || policy.originOf(details.url) !== policy.originOf(serverUrl())) return
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
  buildMenu()
  loadServer()
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

