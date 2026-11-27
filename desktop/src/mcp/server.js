#!/usr/bin/env node
'use strict'
// The stdio MCP server the desktop app gives its person's CLI in a chat run (design docs/local-agents/design.md §13): the CLI starts it
// as one of its MCP servers (Claude Code: --mcp-config · Codex: -c mcp_servers.…), with the desktop app's own binary as its node
// (ELECTRON_RUN_AS_NODE — no window, no app; plain Node in the tests). It is only a front: it tells the CLI the tools (mcp/tools.js) and
// hands each call to the app (runner/tools.js) over the app's own local channel — a unix socket in a temporary folder only this user can
// open, or a named pipe on Windows (which any local program can open) — always with the key of this one run (32 random bytes: the call's
// only way in). It never talks to the server, holds no server token and reads no file itself.
// Why ELECTRON_RUN_AS_NODE, not an app flag like the hooks' --pgl-hook: this server lives as long as the CLI's session and answers over stdio;
// as the app's browser process (measured 2026-11-28, Electron 45.3.2 on macOS) it worked but registered with LaunchServices as a UI element,
// started 3 processes and ~215 MB (node mode: 1 process, ~56 MB) per chat run, and a Windows GUI-subsystem main process writing stdout to a
// pipe was not verified — the hook only reads stdin and leaves.
//   node server.js --config <file>    the file (0600, in the run's own state folder): {ipc, key, lang}
// MCP over stdio: JSON-RPC 2.0, one message per line (initialize · tools/list · tools/call · ping).
const fs = require('node:fs')
const net = require('node:net')
const readline = require('node:readline')
const T = require('./tools')

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const CALL_MS = 10 * 60_000

function readConfig(argv) {
  const i = argv.indexOf('--config')
  const file = i >= 0 ? argv[i + 1] : null
  if (!file) throw new Error('no --config')
  const c = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!c?.ipc || !c?.key) throw new Error('the config names no channel')
  return c
}

// one call to the app: a line out, the answer's line back → {text, isError}
function ask(conf, tool, args, { ms = CALL_MS } = {}) {
  return new Promise((resolve) => {
    let buf = ''
    let done = false
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy() } catch { /* gone */ } resolve(r) }
    const sock = net.createConnection(conf.ipc)
    const timer = setTimeout(() => finish({ text: 'The desktop app did not answer in time.', isError: true }), ms)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 1, key: conf.key, tool, args: args || {} })}\n`))
    sock.on('data', (d) => {
      buf += d
      const n = buf.indexOf('\n')
      if (n < 0) return
      let m = null
      try { m = JSON.parse(buf.slice(0, n)) } catch { /* broken */ }
      finish(m ? { text: String(m.text ?? ''), isError: !!m.isError } : { text: 'The desktop app answered something unreadable.', isError: true })
    })
    sock.on('error', () => finish({ text: 'The Process GPT Lite desktop app is not reachable (it was closed, or this run ended).', isError: true }))
    sock.on('close', () => finish({ text: 'The desktop app closed the call.', isError: true }))
  })
}

function serve({ input = process.stdin, output = process.stdout, conf }) {
  const out = (m) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
  const rl = readline.createInterface({ input })
  rl.on('line', async (line) => {
    if (!line.trim()) return
    let m
    try { m = JSON.parse(line) } catch { return out({ id: null, error: { code: -32700, message: 'parse error' } }) }
    const { id, method, params } = m || {}
    // (a notification — no id — is never answered)
    const reply = (x) => { if (id !== undefined && id !== null) out({ id, ...x }) }
    try {
      if (method === 'initialize') {
        const want = params?.protocolVersion
        return reply({ result: { protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: T.SERVER_NAME, title: 'Process GPT Lite', version: T.VERSION },
          instructions: 'Tools of the Process GPT Lite desktop app: list this computer\'s skills, and propose a skill or a folder of this computer to the person\'s Process GPT Lite server. A proposal only shows a confirmation card in the chat; the person presses its button to register or upload.' } })
      }
      if (method === 'ping') return reply({ result: {} })
      if (method === 'tools/list') return reply({ result: { tools: T.TOOLS } })
      if (method === 'tools/call') {
        const name = String(params?.name || '')
        if (!T.NAMES.includes(name)) return reply({ result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true } })
        const r = await ask(conf, name, params?.arguments || {})
        return reply({ result: { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) } })
      }
      if (typeof method === 'string' && method.startsWith('notifications/')) return
      reply({ error: { code: -32601, message: `method not found: ${method}` } })
    } catch (e) { reply({ error: { code: -32603, message: String(e?.message || e) } }) }
  })
  return rl
}

if (require.main === module) {
  let conf
  try { conf = readConfig(process.argv.slice(2)) } catch (e) { process.stderr.write(`process-gpt-lite tools: ${e.message}\n`); process.exit(2) }
  serve({ conf })
}

module.exports = { serve, ask, readConfig, PROTOCOLS }
