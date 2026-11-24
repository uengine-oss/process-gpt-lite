'use strict'
// Windows' fake claude.cmd · codex.cmd (test/helpers/fakeBin.js) run this, the way npm's shims run their CLI: `node fake-entry.js %*` —
// a shim never reads %1 itself. It picks the headless stand-in (fake-cli.js) or the interactive one (fake-tui.js) by the first argument,
// as the sh scripts on macOS do.
const kind = process.env.FAKE_CLI_KIND || 'claude'
const headless = kind === 'codex' ? ['exec', '--version', 'login'] : ['-p', '--version', 'auth']
require(headless.includes(process.argv[2]) ? './fake-cli.js' : './fake-tui.js')
