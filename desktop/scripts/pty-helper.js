// node-pty's prebuilt spawn-helper (macOS) comes out of npm without its execute bit (node-pty 1.1.0): without it every terminal fails
// with "posix_spawnp failed". Run after install (package.json postinstall); electron-builder then packs it as it is (asarUnpack).
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
let n = 0
try {
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, 'spawn-helper')
    if (fs.existsSync(f)) { fs.chmodSync(f, 0o755); n++ }
  }
} catch { /* no prebuilds (built from source): nothing to do */ }
if (n) console.log(`node-pty: spawn-helper executable (${n})`)
