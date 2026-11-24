// 데스크톱 앱의 브라우저(Electron — desktop/src/browser/host.js)를 시험에서 띄운다: 앱의 로컬 러너가 이 시험 서버의 링크(hub.js)에 기기
// 토큰으로 붙고, 서버의 브라우저 에이전트가 그 브라우저를 움직인다(lib/browserRemote.js). desktop/ 에서 npm ci 가 되어 있어야 한다.
//   const pc = await startDesktopBrowser({ server: 'http://127.0.0.1:1234', token, userData })   → pc.ready (사람 id) · pc.kill() · pc.stop()
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const ELECTRON = path.join(root, 'desktop', 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
const MAIN = path.join(root, 'desktop', 'test', 'helpers', 'browser-host.js')
export const haveElectron = () => fs.existsSync(ELECTRON)

// env: more for the app (PGL_TEST_BROWSER_PREF — this PC's browser setting, PGL_BROWSER_MAX_DOWNLOAD …)
export function startDesktopBrowser({ server, token, userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-pc-')), device = '시험 PC', log = process.env.PGL_TEST_LOG === '1', env: more = {} } = {}) {
  const env = { ...process.env, PGL_TEST_SERVER: server, PGL_TEST_TOKEN: token, PGL_DESKTOP_USER_DATA: userData, PGL_TEST_DEVICE: device, PGL_TEST_LOG: log ? '1' : '0', ...more }
  delete env.ELECTRON_RUN_AS_NODE
  const proc = spawn(ELECTRON, [MAIN], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the desktop browser did not link within 40 s:\n${out.slice(-2000)}`)), 40_000)
    proc.stdout.on('data', (d) => {
      out += d
      if (log) process.stdout.write(`[pc] ${d}`)
      const m = /ready (\S*)/.exec(out)
      if (m) { clearTimeout(t); resolve(m[1]) }
      if (/refused (\d+)/.test(out)) { clearTimeout(t); reject(new Error(`refused: ${out}`)) }
    })
    proc.stderr.on('data', (d) => { out += d; if (log) process.stderr.write(`[pc!] ${d}`) })
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`the desktop browser quit (${code}):\n${out.slice(-2000)}`)) })
  })
  ready.catch(() => {})
  // (ended — by itself, or by a signal: then exitCode stays null)
  const gone = () => proc.exitCode !== null || proc.signalCode !== null
  return {
    proc, ready, userData,
    output: () => out,
    // the PC goes off at once (no goodbye on its link)
    kill: () => new Promise((r) => { if (gone()) return r(); proc.once('exit', r); proc.kill('SIGKILL') }),
    stop: () => new Promise((r) => { if (gone()) return r(); proc.once('exit', r); proc.stdin.end(); setTimeout(() => proc.kill('SIGKILL'), 3000).unref() }),
  }
}
