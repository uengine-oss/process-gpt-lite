'use strict'
// node-pty for the interactive CLI sessions (session.js). Its N-API prebuilds load in Node and in Electron alike (desktop/package.json
// postinstall makes their spawn-helper executable; electron-builder unpacks it from the asar). A build where it does not load runs
// steps headless instead (clis.command — the fallback), and says so in its capabilities.
// In the packed app node-pty is loaded from app.asar.unpacked (electron-builder asarUnpack), not through the asar: its Windows half starts
// a worker thread from a script file and forks a helper that lists the console's processes, and on macOS it runs spawn-helper — all of
// them want real files on disk.
const path = require('node:path')
let mod = null
let why = ''
function where() {
  try {
    const pkg = require.resolve('node-pty/package.json')
    const packed = `${path.sep}app.asar${path.sep}`
    return pkg.includes(packed) ? path.dirname(pkg.replace(packed, `${path.sep}app.asar.unpacked${path.sep}`)) : 'node-pty'
  } catch { return 'node-pty' }
}
function load() {
  if (mod || why) return mod
  try { mod = require(where()) } catch (e) { why = e.message.split('\n')[0] }
  return mod
}
module.exports = { load, where, why: () => why }
