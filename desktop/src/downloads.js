'use strict'
// Where a file the page saves lands (its 「내려받기」 — openspec/specs/file-download): the Downloads folder, under the name the page gave
// (Korean as it is), with " (1)", " (2)" … before the extension when that name is taken there — as a browser does, never a save dialog.
// Only the app's own downloads go there by themselves — the page's 「내려받기」 (a blob: of the chosen server) and that server's own routes
// (policy.js 'app'); a download any other page or frame starts (an office editor's, a site's) keeps Electron's save dialog.
// No Electron here: unit-tested in test/downloads.test.js; main.js sets it on the session's will-download.
const path = require('node:path')
const policy = require('./policy')

// url: the download's (item.getURL()); ctx: {server, authOrigins} as main.js gives policy.kind
const quietSave = (url, ctx) => policy.kind(String(url || ''), ctx) === 'app' && String(url || '') !== 'about:blank'

function savePathFor(dir, name, exists) {
  const safe = String(name || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '').trim() || 'download'
  const ext = path.extname(safe)
  const stem = ext ? safe.slice(0, -ext.length) : safe
  for (let n = 0; n < 1000; n++) {
    const p = path.join(dir, n ? `${stem} (${n})${ext}` : safe)
    if (!exists(p)) return p
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`)
}

module.exports = { savePathFor, quietSave }
