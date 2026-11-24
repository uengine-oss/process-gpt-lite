'use strict'
// The desktop app's browser on its own, for tests (server/test/browserDriver.test.js · browser-local.test.js): an Electron main process
// with the app's local runner — its link to a test server, with this PC's browser (src/browser/host.js) — and no window of the app.
//   env -u ELECTRON_RUN_AS_NODE desktop/node_modules/.bin/electron desktop/test/helpers/browser-host.js
//   PGL_TEST_SERVER   the server's address (http://127.0.0.1:<port>) · PGL_TEST_TOKEN  a device token it issued
//   PGL_DESKTOP_USER_DATA  a folder of its own (the browser's profile lives there) · PGL_TEST_DEVICE  the device's name
//   PGL_TEST_BROWSER_PREF  this PC's browser setting ('own' · 'all' · 'off') · PGL_BROWSER_MAX_DOWNLOAD  a smaller download cap (bytes)
//   PGL_TEST_DOWNLOADS  the folder standing in for this PC's Downloads
// It prints 「ready <user id>」 once the server welcomed it, and quits when its parent goes (stdin closes).
const { app } = require('electron')
const path = require('node:path')
const { createLocalRunner } = require('../../src/runner')
const { createBrowserHost } = require('../../src/browser/host')

if (process.env.PGL_DESKTOP_USER_DATA) app.setPath('userData', path.resolve(process.env.PGL_DESKTOP_USER_DATA))
// (a download the person starts in the shown window between tasks goes to this folder — never the real Downloads in a test)
if (process.env.PGL_TEST_DOWNLOADS) app.setPath('downloads', path.resolve(process.env.PGL_TEST_DOWNLOADS))
// (as the app: no "Electron" in the user agent — src/main.js)
app.userAgentFallback = app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(/ process-gpt-lite-desktop\/\S+/i, '')
app.on('window-all-closed', () => {})
const log = process.env.PGL_TEST_LOG === '1' ? (...a) => console.log(...a) : () => {}

app.whenReady().then(async () => {
  try { app.dock?.hide() } catch { /* not a Mac */ }
  const host = createBrowserHost({ electron: require('electron'), log })
  const r = createLocalRunner({
    server: process.env.PGL_TEST_SERVER, token: process.env.PGL_TEST_TOKEN, dataDir: path.join(app.getPath('userData'), 'local-agents'),
    device: { name: process.env.PGL_TEST_DEVICE || 'Test PC', platform: process.platform, appVersion: '0.2.3' },
    // (runs no CLI job — none is ever sent in these tests; PGL_TEST_BROWSER_PREF: this PC's 「브라우저 작업은 내 PC에서」, 'own' by default)
    prefs: () => ({ enabled: true, ask: false, browser: process.env.PGL_TEST_BROWSER_PREF || 'own' }), ask: async () => false, log, mode: 'headless', browser: host,
  })
  let said = false
  r.link.on('welcome', (m) => { if (!said) { said = true; console.log(`ready ${m.user?.id || ''}`) } })
  r.link.on('refused', (x) => console.log(`refused ${x.code}`))
  await r.start()
  // (the shown window — 「이 PC에서 보기」 — tells the test it is there)
  global.__pglHost = host
})
process.stdin.on('end', () => app.exit(0))
process.stdin.resume()
