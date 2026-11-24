'use strict'
// node-pty for the interactive CLI sessions (session.js). Its N-API prebuilds load in Node and in Electron alike (desktop/package.json
// postinstall makes their spawn-helper executable; electron-builder unpacks it from the asar). A build where it does not load runs
// steps headless instead (clis.command — the fallback), and says so in its capabilities.
// Windows, in the packed app: node-pty is loaded from app.asar.unpacked (electron-builder asarUnpack), not through the asar — its ConPTY
// half starts a worker thread from a script file (it maps only node_modules.asar to its unpacked twin, not app.asar) and forks a helper
// that lists the console's processes; both want real files on disk. macOS loads it through the asar as usual: node-pty itself turns its
// spawn-helper's app.asar path into app.asar.unpacked (from the unpacked path that would become app.asar.unpacked.unpacked).
const path = require('node:path')
let mod = null
let why = ''
function where(platform = process.platform) {
  if (platform !== 'win32') return 'node-pty'
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
