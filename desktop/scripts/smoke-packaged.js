#!/usr/bin/env node
'use strict'
// A short check of a packed app (CI: .github/workflows/desktop.yml; by hand after npm run dist):
//   node scripts/smoke-packaged.js "release/mac-arm64/Process GPT Lite.app" arm64
//   node scripts/smoke-packaged.js release/win-unpacked x64
// What it checks, each with the app's own binary:
//   1. files   — node-pty unpacked for this system and arch (macOS: pty.node · spawn-helper executable and built for <arch>, as is the app;
//                Windows: conpty.node · pty.node), no debug symbols (.pdb), no other system's prebuilds
//      (then one untimed start: a binary's first start is slow once — the signature check, Rosetta for an Intel app on Apple Silicon)
//   2. hook    — `<app> --pgl-hook Stop <file>` (a Claude Code hook of a local run, runner/hook.js): the event is appended, no app starts
//   3. pty     — the app as Node (ELECTRON_RUN_AS_NODE) loads runner/runSettings.js (js-yaml in app.asar: a front matter's run keys left
//                off) and runner/pty.js from inside app.asar and node-pty with it (Windows: from
//                app.asar.unpacked; macOS: through the asar, its spawn-helper from app.asar.unpacked), and a terminal runs a program
//                (Windows: ConPTY, a batch file through cmd.exe with awkward arguments — clis.startSpec), then a long-running one is
//                stopped by kill
//   4. launch  — the app itself starts with a fresh profile, gets as far as its first window (desktop-settings.json written) and keeps
//                running; then it is stopped
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync, execFileSync } = require('node:child_process')

const [appArg, arch = process.arch] = process.argv.slice(2)
if (!appArg) { console.error('usage: node scripts/smoke-packaged.js <app or win-unpacked folder> [arch]'); process.exit(2) }
const WIN = process.platform === 'win32'
const MAC = process.platform === 'darwin'
const app = path.resolve(appArg)
const exe = MAC ? path.join(app, 'Contents', 'MacOS', 'Process GPT Lite') : WIN ? path.join(app, 'Process GPT Lite.exe') : path.join(app, 'process-gpt-lite-desktop')
const resources = MAC ? path.join(app, 'Contents', 'Resources') : path.join(app, 'resources')
const unpacked = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
const plat = `${process.platform}-${arch}`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl smoke '))
let failed = 0
const ok = (name, more = '') => console.log(`ok   ${name}${more ? ` — ${more}` : ''}`)
const bad = (name, why) => { failed++; console.log(`FAIL ${name} — ${why}`) }
const check = async (name, fn) => { try { const m = await fn(); ok(name, m) } catch (e) { bad(name, e.message) } }
const must = (cond, why) => { if (!cond) throw new Error(why) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const archsOf = (f) => execFileSync('lipo', ['-archs', f], { encoding: 'utf8' }).trim().split(/\s+/)
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))

async function main() {
  console.log(`smoke: ${exe} (${plat})`)
  await check('files', () => {
    must(fs.existsSync(exe), `no ${exe}`)
    must(fs.existsSync(path.join(resources, 'app.asar')), 'no app.asar')
    const pre = path.join(unpacked, 'prebuilds', plat)
    must(fs.existsSync(path.join(pre, 'pty.node')), `no ${pre}/pty.node`)
    const all = walk(path.join(unpacked, 'prebuilds')).map((f) => path.relative(path.join(unpacked, 'prebuilds'), f))
    must(!all.some((f) => f.endsWith('.pdb')), `debug symbols packed: ${all.filter((f) => f.endsWith('.pdb')).join(', ')}`)
    const others = all.filter((f) => !f.startsWith(`${process.platform}-`))
    must(!others.length, `other systems' prebuilds packed: ${others.join(', ')}`)
    if (MAC) {
      const helper = path.join(pre, 'spawn-helper')
      must(fs.existsSync(helper), 'no spawn-helper')
      must((fs.statSync(helper).mode & 0o111) !== 0, 'spawn-helper is not executable')
      const want = arch === 'x64' ? 'x86_64' : arch
      for (const f of [exe, path.join(pre, 'pty.node'), helper]) must(archsOf(f).includes(want), `${path.basename(f)} is ${archsOf(f).join('/')}, not ${want}`)
      return `${all.length} prebuild files, app · pty.node · spawn-helper are ${want}`
    }
    if (WIN) must(fs.existsSync(path.join(pre, 'conpty.node')), 'no conpty.node')
    return `${all.length} prebuild files`
  })

  // the fuses the build flips (scripts/adhoc-sign.js FUSES — 0.2.6): cookies on disk sealed with the system's keychain
  await check('fuses', async () => {
    const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses')
    const wire = await getCurrentFuseWire(MAC ? app : exe)
    // (the wire's bytes: '1' on, '0' off)
    const on = wire[FuseV1Options.EnableCookieEncryption] === '1'.charCodeAt(0)
    must(on, `EnableCookieEncryption is ${String.fromCharCode(wire[FuseV1Options.EnableCookieEncryption])} — cookies on disk are not sealed`)
    return 'EnableCookieEncryption on'
  })

  // the first start of a binary is slow once (macOS checks its signature; on Apple Silicon, Rosetta translates an Intel app — over a
  // minute on a CI runner): it is done here, untimed, so the checks below measure the app
  await check('warm-up (first start)', () => {
    const t = Date.now()
    const r = spawnSync(exe, ['-e', '0'], { timeout: 600_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    must(!r.error && r.status === 0, `exit ${r.status} ${r.error || ''} ${String(r.stderr || '').slice(0, 300)}`)
    return `${Date.now() - t} ms`
  })

  await check('hook (--pgl-hook)', () => {
    const file = path.join(tmp, 'hooks dir', 'hooks.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const input = JSON.stringify({ session_id: 's1', last_assistant_message: '요약\n둘째 줄' })
    const t = Date.now()
    // (the variable removed, not emptied: on Windows an empty ELECTRON_RUN_AS_NODE still makes the app a plain Node — the runner's
    // cliEnv removes it the same way)
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[k]
    const r = spawnSync(exe, ['--pgl-hook', 'Stop', file], { input, timeout: 60_000, env })
    must(!r.error, String(r.error))
    must(r.status === 0, `exit ${r.status} ${r.signal || ''}: ${String(r.stderr).slice(0, 400)}`)
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    must(text === `Stop ${input}\n`, `hook file: ${JSON.stringify(text)}`)
    return `${Date.now() - t} ms`
  })

  await check('pty (node-pty in the packed app)', () => {
    const script = path.join(tmp, 'pty-check.js')
    const echoJs = path.join(tmp, 'echo-args.js')
    const argsOut = path.join(tmp, 'args.json')
    fs.writeFileSync(echoJs, `require('node:fs').writeFileSync(${JSON.stringify(argsOut)}, JSON.stringify(process.argv.slice(2)))\n`)
    const shim = path.join(tmp, 'echo args.cmd')
    if (WIN) fs.writeFileSync(shim, `@echo off\r\nsetlocal\r\n"${exe}" "${echoJs}" %*\r\n`)
    const NASTY = ['C:\\Users\\Kim Lee (dev)\\x.json', `projects.${JSON.stringify('C:\\work dir\\x')}.trust_level="trusted"`, 'a&b|c', '100%', 'say "hi"', '이 폴더']
    fs.writeFileSync(script, `
const path = require('node:path'); const fs = require('node:fs')
const R = ${JSON.stringify(path.join(resources, 'app.asar', 'src', 'runner'))}
const P = require(path.join(R, 'pty.js')); const C = require(path.join(R, 'clis.js'))
// (runSettings.js — js-yaml packed with it: a template's run settings left off for a person who may not edit the folder)
const RS = require(path.join(R, 'runSettings.js'))
const left = RS.stripFront('---\\nname: x\\nhooks: {}\\n---\\nbody\\n')
if (!left || left.text !== '---\\nname: x\\n---\\nbody\\n') { console.error('runSettings.js: ' + JSON.stringify(left)); process.exit(8) }
const pty = P.load()
if (!pty) { console.error('node-pty did not load: ' + P.why()); process.exit(3) }
if (process.platform === 'win32' && !P.where().includes('app.asar.unpacked')) { console.error('node-pty not from app.asar.unpacked: ' + P.where()); process.exit(4) }
const WIN = process.platform === 'win32'
const s = WIN ? C.startSpec(${JSON.stringify(shim)}, ${JSON.stringify(NASTY)}) : { file: '/bin/echo', args: ['pty says hi'], verbatim: false }
const p = pty.spawn(s.file, s.verbatim ? s.args.join(' ') : s.args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: ${JSON.stringify(tmp)}, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
let out = ''
p.onData((d) => { out += d })
p.onExit(({ exitCode }) => {
  if (exitCode !== 0) { console.error('exit ' + exitCode + ': ' + JSON.stringify(out.slice(-300))); process.exit(5) }
  if (WIN) { const got = fs.readFileSync(${JSON.stringify(argsOut)}, 'utf8'); if (got !== JSON.stringify(${JSON.stringify(NASTY)})) { console.error('arguments: ' + got); process.exit(6) } }
  else if (!out.includes('pty says hi')) { console.error('output: ' + JSON.stringify(out)); process.exit(6) }
  // a program that runs until it is stopped: kill() ends it (Windows: the console's processes, through node-pty's helper)
  const q = WIN ? pty.spawn('cmd.exe', ['/d', '/k'], { cols: 80, rows: 24, cwd: ${JSON.stringify(tmp)}, env: process.env }) : pty.spawn('/bin/sh', [], { cols: 80, rows: 24, cwd: ${JSON.stringify(tmp)}, env: process.env })
  const t = setTimeout(() => { console.error('kill did not end it'); process.exit(7) }, 20000)
  q.onExit(() => { clearTimeout(t); console.log('PTY-OK'); process.exit(0) })
  setTimeout(() => q.kill(), 1500)
})
`)
    const r = spawnSync(exe, [script], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    must(!r.error, String(r.error))
    must(r.status === 0 && r.stdout.includes('PTY-OK'), `exit ${r.status}: ${(r.stderr || '').slice(0, 600)} ${(r.stdout || '').slice(0, 300)}`)
    return WIN ? 'ConPTY: a batch file through cmd.exe got its arguments whole; kill ended a running cmd.exe' : 'a terminal ran /bin/echo; kill ended a shell'
  })

  await check('launch', async () => {
    const profile = path.join(tmp, 'profile')
    const settings = path.join(profile, 'desktop-settings.json')
    const env = { ...process.env, PGL_DESKTOP_USER_DATA: profile }
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[k]
    const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    let exited = null
    child.on('exit', (code, sig) => { exited = `${code ?? sig}` })
    try {
      const t = Date.now()
      while (!fs.existsSync(settings) && exited === null && Date.now() - t < 90_000) await sleep(250)
      must(fs.existsSync(settings), exited !== null ? `the app exited (${exited}) before it was ready: ${log.slice(-600)}` : `not ready in 90 s: ${log.slice(-600)}`)
      const lang = JSON.parse(fs.readFileSync(settings, 'utf8')).lang
      await sleep(5000)
      must(exited === null, `the app exited (${exited}) after it started: ${log.slice(-600)}`)
      return `ready in ${Date.now() - t - 5000} ms (lang ${lang}), still running 5 s later`
    } finally {
      if (exited === null) {
        if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
        else child.kill('SIGTERM')
        const t = Date.now()
        while (exited === null && Date.now() - t < 15_000) await sleep(200)
        if (exited === null) child.kill('SIGKILL')
      }
    }
  })

  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows: a file still held for a moment */ }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
