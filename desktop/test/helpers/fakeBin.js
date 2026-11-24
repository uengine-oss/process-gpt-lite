'use strict'
// A folder with `claude` and `codex` that are the fake CLIs — put first on the runner's search path. Headless calls (`claude -p`,
// `codex exec`, `--version`, `auth status`, `login status`) go to test/fixtures/fake-cli.js; the interactive CLI (in a PTY) to
// test/fixtures/fake-tui.js.
const fs = require('node:fs')
const path = require('node:path')

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-cli.js')
const TUI = path.join(__dirname, '..', 'fixtures', 'fake-tui.js')
function fakeBin(dir, { kinds = ['claude', 'codex'] } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  for (const k of kinds) {
    const p = path.join(dir, k)
    const headless = k === 'codex' ? '"$1" = exec -o "$1" = --version -o "$1" = login' : '"$1" = -p -o "$1" = --version -o "$1" = auth'
    fs.writeFileSync(p, `#!/bin/sh\nif [ ${headless} ]; then FAKE_CLI_KIND=${k} exec "${process.execPath}" "${FAKE}" "$@"; fi\nFAKE_CLI_KIND=${k} exec "${process.execPath}" "${TUI}" "$@"\n`, { mode: 0o755 })
  }
  return dir
}
module.exports = { fakeBin, FAKE, TUI }
