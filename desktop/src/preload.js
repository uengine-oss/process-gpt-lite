'use strict'
// Runs in every page of the main window (sandboxed, isolated from the page's own scripts).
//   - marks the page: <html class="pgl-desktop pgl-os-<platform> [pgl-fullscreen]"> and the room the window's own
//     buttons take at its top (--pgl-tb-left: macOS traffic lights, --pgl-tb-right: Windows · Linux caption buttons).
//     The web app's src/styles/desktop.css only acts under html.pgl-desktop; in a browser nothing changes.
//   - tells the main process the web app's theme (light / dark) — the window background and caption buttons follow it
//   - window.pglDesktop: what the page may know about the app (read only)
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

contextBridge.exposeInMainWorld('pglDesktop', Object.freeze({ app: 'process-gpt-lite', version: arg('version'), platform: process.platform }))

if (local) {
  contextBridge.exposeInMainWorld('pglLocal', Object.freeze({
    state: () => ipcRenderer.invoke('pgl:state'),
    connect: (v) => ipcRenderer.invoke('pgl:connect', { url: String(v?.url || ''), user: String(v?.user || ''), pass: String(v?.pass || '') }),
    cancel: () => ipcRenderer.send('pgl:cancel'),
    retry: (quiet) => ipcRenderer.send('pgl:retry', !!quiet),
    changeServer: () => ipcRenderer.send('pgl:change-server'),
  }))
}
