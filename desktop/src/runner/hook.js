'use strict'
// A Claude Code hook of an interactive session (session.js): appends one line "<Event> <the hook's JSON input>" to the session's hook file,
// which the session reads. Nothing in it talks to a network, and nothing needs a shell (no sh, cat, printf — Windows has none of them):
//   node hook.js <Event> <file>                      (plain Node: the tests, a runner hosted by Node)
//   <the app> [<app folder>] --pgl-hook <Event> <file>   (the desktop app: its own binary is the node — main.js takes --pgl-hook before
//                                                     anything of the app starts; no window, no single-instance lock)
// The settings register it in Claude Code's exec form ({command, args}: spawned directly, no shell), so paths with spaces, backslashes,
// quotes or $ stay as they are.
const fs = require('node:fs')

// all of stdin, synchronously (the app's main process must leave before its UI starts); a non-blocking pipe (EAGAIN) is waited on, a
// Windows pipe's end comes as EOF
function readStdin(limitMs = 10_000) {
  const chunks = []
  const buf = Buffer.alloc(64 * 1024)
  const until = Date.now() + limitMs
  const nap = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    let n = 0
    try { n = fs.readSync(0, buf, 0, buf.length, null) } catch (e) {
      if (e.code === 'EAGAIN' && Date.now() < until) { Atomics.wait(nap, 0, 0, 10); continue }
      if (e.code === 'EOF' || e.code === 'EAGAIN' || e.code === 'EBADF' || e.code === 'ENXIO') break
      throw e
    }
    if (!n) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

// one line per event (a JSON document has no raw line breaks inside its strings, so the ones around it go), written in one append
function write(event, file, input) {
  if (!/^\w+$/.test(String(event || '')) || !file) return false
  fs.appendFileSync(file, `${event} ${String(input || '').replace(/[\r\n]+/g, ' ').trim()}\n`)
  return true
}

function run(argv) {
  const [event, file] = argv
  let code = 0
  try { write(event, file, readStdin()) } catch { code = 1 }
  process.exit(code)
}

if (require.main === module) run(process.argv.slice(2))

module.exports = { run, write, readStdin }
