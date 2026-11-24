'use strict'
// node-pty for the interactive CLI sessions (session.js). Its N-API prebuilds load in Node and in Electron alike (desktop/package.json
// postinstall makes their spawn-helper executable; electron-builder unpacks it from the asar). A build where it does not load runs
// steps headless instead (clis.command — the fallback), and says so in its capabilities.
let mod = null
let why = ''
function load() {
  if (mod || why) return mod
  try { mod = require('node-pty') } catch (e) { why = e.message.split('\n')[0] }
  return mod
}
module.exports = { load, why: () => why }
