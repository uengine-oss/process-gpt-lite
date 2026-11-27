'use strict'
// Runs in every page of the main window (sandboxed, isolated from the page's own scripts).
//   - marks the page: <html class="pgl-desktop pgl-os-<platform> [pgl-fullscreen]"> and the room the window's own
//     buttons take at its top (--pgl-tb-left: macOS traffic lights, --pgl-tb-right: Windows · Linux caption buttons).
//     The web app's src/styles/desktop.css only acts under html.pgl-desktop; in a browser nothing changes.
//   - tells the main process the web app's theme (light / dark) — the window background and caption buttons follow it
//   - window.pglDesktop: what the page may know about the app (read only), and the count of Home cards for the Dock · tray, and its
//     sign-in, which the app keeps sealed (session)
//   - window.pglLocal: only on the app's own local pages (setup, offline)
const { contextBridge, ipcRenderer } = require('electron')

const arg = (k) => {
  const p = `--pgl-${k}=`
  const a = process.argv.find((x) => x.startsWith(p))
  return a ? a.slice(p.length) : ''
}
const [left = 0, right = 0] = arg('insets').split(',').map((n) => Number(n) || 0)
const local = location.protocol === 'file:'
let full = false

function mark() {
  const el = document.documentElement
  if (!el) return false
  el.classList.add('pgl-desktop', `pgl-os-${process.platform}`)
  el.classList.toggle('pgl-fullscreen', full)
  // full screen on macOS hides the traffic lights
  el.style.setProperty('--pgl-tb-left', `${full ? 0 : left}px`)
  el.style.setProperty('--pgl-tb-right', `${right}px`)
  return true
}

let lastTheme = ''
function sendTheme() {
  const t = document.documentElement?.dataset.theme
  if ((t === 'light' || t === 'dark') && t !== lastTheme) { lastTheme = t; ipcRenderer.send('pgl:theme', t) }
}

function ready() {
  if (!mark()) return false
  if (!local) {
    sendTheme()
    new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  }
  return true
}
// the preload can run before <html> exists: mark it the moment it is inserted (before the first paint)
if (!ready()) {
  const mo = new MutationObserver(() => { if (ready()) mo.disconnect() })
  mo.observe(document, { childList: true })
}
ipcRenderer.on('pgl:fullscreen', (_e, on) => { full = !!on; mark() })

// the local CLI agents (main's runner/, design docs/local-agents/design.md): the signed-in page pairs this computer with a device token it got
// from its server, sees the runner's state and sets the person's switches. main answers only the chosen server's own pages.
const localRunner = local ? undefined : Object.freeze({
  status: () => ipcRenderer.invoke('pgl:runner:status'),
  mayPair: (userId) => ipcRenderer.invoke('pgl:runner:may-pair', String(userId || '')),
  pair: (v) => ipcRenderer.invoke('pgl:runner:pair', { token: String(v?.token || ''), deviceId: String(v?.deviceId || ''), userId: String(v?.userId || ''), userName: String(v?.userName || '') }),
  forget: (v) => ipcRenderer.invoke('pgl:runner:forget', { optOut: !!v?.optOut }),
  setPrefs: (p) => ipcRenderer.invoke('pgl:runner:prefs', { enabled: p?.enabled !== false, ask: p?.ask === true, finishMinutes: Number(p?.finishMinutes) || 5, browser: p?.browser == null ? undefined : String(p.browser) }),
  detect: () => ipcRenderer.invoke('pgl:runner:detect'),
  onState: (cb) => {
    const h = (_e, st) => { try { cb(st) } catch { /* the page's own */ } }
    ipcRenderer.on('pgl:runner:state', h)
    return () => ipcRenderer.removeListener('pgl:runner:state', h)
  },
})
// 챔피언 폴더 (0.2.5 — main's runner/sync.js): a folder of this computer kept as a Lite folder. The page never sends or receives a path —
// main picks the folder in the system's dialog (pick → {pickId, label, preview} | null), shows what would go up (preview), and asks the
// person once more in a system dialog before the first upload (bind). Paths in include/exclude are inside the picked folder.
const relPaths = (a) => (Array.isArray(a) ? a.slice(0, 500).map((x) => String(x || '')) : [])
const folders = local ? undefined : Object.freeze({
  available: () => true,
  pick: () => ipcRenderer.invoke('pgl:folders:pick'),
  preview: (pickId, o) => ipcRenderer.invoke('pgl:folders:preview', String(pickId || ''), { include: relPaths(o?.include), exclude: relPaths(o?.exclude) }),
  bind: (v) => ipcRenderer.invoke('pgl:folders:bind', { pickId: String(v?.pickId || ''), folderId: String(v?.folderId || ''), folderName: String(v?.folderName || ''),
    include: relPaths(v?.include), exclude: relPaths(v?.exclude) }),
  list: () => ipcRenderer.invoke('pgl:folders:list'),
  syncNow: (folderId) => ipcRenderer.invoke('pgl:folders:sync-now', String(folderId || '')),
  unbind: (folderId) => ipcRenderer.invoke('pgl:folders:unbind', String(folderId || '')),
  reveal: (folderId) => ipcRenderer.invoke('pgl:folders:reveal', String(folderId || '')),
  onState: (cb) => {
    const h = (_e, list) => { try { cb(list) } catch { /* the page's own */ } }
    ipcRenderer.on('pgl:folders:state', h)
    return () => ipcRenderer.removeListener('pgl:folders:state', h)
  },
})
// 작업본 (0.2.7 — main's runner/seats.js): a variation's working copy on this computer. The page never sends or receives a path — only the
// variation's id. It asks the server for the seat itself (POST …/seat {to:'device'}); open(id) waits until this computer holds it (main
// fetches and adds the working copy when the server says so over the link). reveal · openTerminal open the working copy in Finder ·
// Explorer or the system's terminal; saveNow · release (돌려놓기) · setAuto (자동으로 올리기); leftovers · dropLeft (asks in a system dialog).
const sid = (v) => String(v || '').slice(0, 36)
const seats = local ? undefined : Object.freeze({
  available: () => true,
  list: () => ipcRenderer.invoke('pgl:seats:list'),
  open: (id) => ipcRenderer.invoke('pgl:seats:open', sid(id)),
  reveal: (id) => ipcRenderer.invoke('pgl:seats:reveal', sid(id)),
  openTerminal: (id) => ipcRenderer.invoke('pgl:seats:terminal', sid(id)),
  saveNow: (id) => ipcRenderer.invoke('pgl:seats:save-now', sid(id)),
  release: (id) => ipcRenderer.invoke('pgl:seats:release', sid(id)),
  setAuto: (id, on) => ipcRenderer.invoke('pgl:seats:auto', sid(id), on === true),
  leftovers: () => ipcRenderer.invoke('pgl:seats:leftovers'),
  // (commits only this PC had of a working copy that went — kept in the app's repository 30 days: variation · title · ref name · when, no path)
  kept: (folderId) => ipcRenderer.invoke('pgl:seats:kept', sid(folderId)),
  dropLeft: (id) => ipcRenderer.invoke('pgl:seats:drop-left', sid(id)),
  // (the app's trash for working copies, in Finder · Explorer — no path to the page)
  openTrash: () => ipcRenderer.invoke('pgl:seats:open-trash'),
  onState: (cb) => {
    const h = (_e, list) => { try { cb(list) } catch { /* the page's own */ } }
    ipcRenderer.on('pgl:seats:state', h)
    return () => ipcRenderer.removeListener('pgl:seats:state', h)
  },
})
// the count of Home cards waiting (the web app's src/browserNotify.js setBadge): main's Dock · taskbar · tray (src/tray.js), a whole
// number 0…9999 — main checks it again. onOpenHome: the tray's 「알림 N개 — 열기」 asks the page for its Home. onNavigate: a link to one of
// the web app's screens that would open a new window shows it here (main.js showInWindow — the path under the app's address).
// openOutside: a panel app's link goes to the system browser.
const badge = local ? {} : {
  setBadge: (n) => { const v = Math.floor(Number(n)); ipcRenderer.send('pgl:badge', v > 0 ? Math.min(v, 9999) : 0) },
  onOpenHome: (cb) => {
    const h = () => { try { cb() } catch { /* the page's own */ } }
    ipcRenderer.on('pgl:open-home', h)
    return () => ipcRenderer.removeListener('pgl:open-home', h)
  },
  // (main holds a screen asked for before this listens, and gives it now: the router listens from here on)
  onNavigate: (cb) => {
    const h = (_e, to) => { try { cb(String(to || '')) } catch { /* the page's own */ } }
    ipcRenderer.on('pgl:navigate', h)
    ipcRenderer.send('pgl:navigate:listening')
    return () => ipcRenderer.removeListener('pgl:navigate', h)
  },
  openOutside: (url) => ipcRenderer.send('pgl:open-outside', String(url || '')),
}
// the web app's sign-in (0.2.6 — src/sessionStore.js): kept by main, sealed with the system's keychain, not in the page's localStorage.
// Read from main once a page, when the page first asks (main answers only the chosen server's own pages), and held here; set · clear
// wait for main to have kept it. sealed() false: it cannot be sealed on this computer — the page keeps it itself, as a browser does.
// keptBefore(): the app has kept this server's sign-in before — a copy in the page's storage is then not taken.
let held // undefined: not asked yet · null: main does not keep it for this page · {sealed, value}
const heldNow = () => {
  if (held === undefined) { try { held = ipcRenderer.sendSync('pgl:session:get') || null } catch { held = null } }
  return held
}
const session = local ? undefined : Object.freeze({
  sealed: () => heldNow()?.sealed === true,
  keptBefore: () => heldNow()?.sealed === true && heldNow().kept === true,
  get: () => (heldNow()?.sealed ? heldNow().value ?? null : null),
  // (kept for this page even when main could not keep it — the keychain said no: signed in until the window loads again)
  set: (v) => {
    const h = heldNow()
    if (!h?.sealed) return false
    h.value = String(v ?? '')
    try { return ipcRenderer.sendSync('pgl:session:set', h.value) === true } catch { return false }
  },
  clear: () => {
    const h = heldNow()
    if (!h?.sealed) return false
    h.value = null
    try { return ipcRenderer.sendSync('pgl:session:clear') === true } catch { return false }
  },
})
contextBridge.exposeInMainWorld('pglDesktop', Object.freeze({ app: 'process-gpt-lite', version: arg('version'), platform: process.platform, ...badge, ...(localRunner ? { localRunner } : {}),
  ...(folders ? { folders } : {}), ...(seats ? { seats } : {}), ...(session ? { session } : {}) }))

if (local) {
  contextBridge.exposeInMainWorld('pglLocal', Object.freeze({
    state: () => ipcRenderer.invoke('pgl:state'),
    connect: (v) => ipcRenderer.invoke('pgl:connect', { url: String(v?.url || ''), user: String(v?.user || ''), pass: String(v?.pass || '') }),
    cancel: () => ipcRenderer.send('pgl:cancel'),
    retry: (quiet) => ipcRenderer.send('pgl:retry', !!quiet),
    changeServer: () => ipcRenderer.send('pgl:change-server'),
  }))
}
