'use strict'
// A folder with `claude` and `codex` that are the fake CLIs — put first on the runner's search path. Headless calls (`claude -p`,
// `codex exec`, `--version`, `auth status`, `login status`) go to test/fixtures/fake-cli.js; the interactive CLI (in a PTY) to
// test/fixtures/fake-tui.js.
//   macOS · Linux: a sh script each (claude, codex)
//   Windows: claude.cmd · codex.cmd — batch files like the shims npm writes (`"node" "<script>" %*`, nothing else read from the
//   arguments — test/fixtures/fake-entry.js picks the stand-in), so the runner's road for them (cmd.exe /d /s /c, every argument escaped
//   twice — src/runner/clis.js startSpec) is what the tests go through
const fs = require('node:fs')
const path = require('node:path')

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-cli.js')
const TUI = path.join(__dirname, '..', 'fixtures', 'fake-tui.js')
const ENTRY = path.join(__dirname, '..', 'fixtures', 'fake-entry.js')
const HEADLESS = { claude: ['-p', '--version', 'auth'], codex: ['exec', '--version', 'login'] }

function fakeBin(dir, { kinds = ['claude', 'codex'], platform = process.platform } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  for (const k of kinds) {
    if (platform === 'win32') {
      fs.writeFileSync(path.join(dir, `${k}.cmd`), ['@echo off', 'setlocal', `set "FAKE_CLI_KIND=${k}"`, `"${process.execPath}" "${ENTRY}" %*`, ''].join('\r\n'))
      continue
    }
    const p = path.join(dir, k)
    const headless = HEADLESS[k].map((a) => `"$1" = ${a}`).join(' -o ')
    fs.writeFileSync(p, `#!/bin/sh\nif [ ${headless} ]; then FAKE_CLI_KIND=${k} exec "${process.execPath}" "${FAKE}" "$@"; fi\nFAKE_CLI_KIND=${k} exec "${process.execPath}" "${TUI}" "$@"\n`, { mode: 0o755 })
  }
  return dir
}

// the system folders a CLI's PATH needs besides the fake ones (the tests give the runner a search path of their own)
const systemPath = () => (process.platform === 'win32'
  ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows']
  : ['/usr/bin', '/bin'])

module.exports = { fakeBin, systemPath, FAKE, TUI }
