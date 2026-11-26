'use strict'
// Where a file the page saves lands (its 「내려받기」 — openspec/specs/file-download): the Downloads folder, under the name the page gave
// (Korean as it is), with " (1)", " (2)" … before the extension when that name is taken there — as a browser does, never a save dialog.
// No Electron here: unit-tested in test/downloads.test.js; main.js sets it on the session's will-download.
const path = require('node:path')

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

module.exports = { savePathFor }
