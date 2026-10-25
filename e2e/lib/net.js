// Low-level probes for the security fences: websocket upgrades with chosen Origin/ticket, the BFF's
// own listening ports (lsof), raw TCP connects.
import WebSocket from 'ws'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { API_URL } from './env.js'

const wsBase = () => API_URL.replace(/^http/, 'ws')
// resolves {status} for a refused upgrade, or {ws} once open
export function upgrade(path, { origin = API_URL, headers = {} } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase()}${path}`, { headers: { Origin: origin, ...headers } })
    ws.on('unexpected-response', (_req, res) => { resolve({ status: res.statusCode }); ws.terminate() })
    ws.on('open', () => resolve({ status: 101, ws }))
    ws.on('error', (e) => resolve({ status: 0, error: e.message }))
  })
}
export function nextMessage(ws, pred = () => true, ms = 15_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error('no message in time')) }, ms)
    const on = (raw) => { let m; try { m = JSON.parse(raw) } catch { return } if (pred(m)) { clearTimeout(t); ws.off('message', on); resolve(m) } }
    ws.on('message', on)
  })
}
// the BFF process (listening on API_URL's port) and its loopback listening ports
export function serverPid() {
  const port = new URL(API_URL).port || '80'
  try { return execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0] || null } catch { return null }
}
export function listeningPorts(pid) {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' })
    return new Set(out.split('\n').filter((l) => l.startsWith('n')).map((l) => Number(l.split(':').pop())))
  } catch { return new Set() }
}
// connect, write lines, collect what comes back until the peer closes (or ms passes)
export function talk(port, lines, ms = 6000) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port })
    let data = ''
    let closed = false
    const done = () => resolve({ data, closed })
    const t = setTimeout(() => { s.destroy(); done() }, ms)
    s.on('connect', () => s.write(lines.map((l) => JSON.stringify(l) + '\n').join('')))
    s.on('data', (d) => { data += d })
    s.on('close', () => { closed = true; clearTimeout(t); done() })
    s.on('error', () => {})
  })
}
