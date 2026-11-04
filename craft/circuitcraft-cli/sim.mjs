// PSpice 문서를 돌린다: 옮기고(toNgspice), 한 건씩 자식 프로세스로 돌려 결과를 모은다
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { toNgspice, read, mergeSweeps } from '../pspice/pspice.mjs'

const WORKER = fileURLToPath(new URL('./sim-worker.mjs', import.meta.url))
export const RUN_TIMEOUT_MS = Number(process.env.CIRCUITCRAFT_RUN_TIMEOUT_MS || 60000)

const judge = (r) => {
  const parseFailed = r.errors.some((e) => /circuit not parsed|interrupted due to error|Error on line|Fatal error|doAnalyses/i.test(e))
  if (parseFailed || !r.data.length) return { ok: false, error: r.errors.join(' ').replace(/\s+/g, ' ').slice(0, 400) || '결과가 없어요' }
  return { ok: true, ...r }
}
export function runMany(netlists, { timeoutMs = RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--max-old-space-size=2048', WORKER], { stdio: ['pipe', 'pipe', 'pipe'] })
    const results = new Array(netlists.length).fill(null)
    let buf = '', err = '', timedOut = false, tail = ''
    const take = (line) => {
      const m = /^RESULT (\d+) ([\s\S]*)$/.exec(line)
      if (m) results[Number(m[1])] = judge(JSON.parse(m[2]))
      else if (/error/i.test(line) && !/^\s*at /.test(line)) tail += ` ${line.trim()}`
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1) } })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', () => {
      clearTimeout(timer)
      take(buf)
      const why = timedOut ? `${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았어요` : (tail + ' ' + err.split('\n').filter((l) => /error/i.test(l) && !/^\s*at /.test(l)).slice(0, 3).join(' / ')).trim().slice(0, 400) || '시뮬레이터가 답 없이 끝났어요'
      resolve(results.map((r) => r || { ok: false, error: why }))
    })
    child.stdin.end(JSON.stringify({ netlists }))
  })
}
export const runNetlist = (netlist, opts) => runMany([netlist], opts).then((r) => r[0])

// neighbours of the document: .lib/.inc beside it can be asked for by name
export function companionFiles(file, extra = []) {
  const files = {}
  const dir = path.dirname(file)
  for (const n of fs.readdirSync(dir)) if (/\.(lib|inc|mod|sub|cir|net|als)$/i.test(n)) { try { files[n.toLowerCase()] = fs.readFileSync(path.join(dir, n), 'latin1') } catch { /* unreadable */ } }
  for (const p of extra) files[path.basename(p).toLowerCase()] = fs.readFileSync(p, 'latin1')
  return files
}
export const magnitude = (v) => (v && typeof v === 'object' ? Math.hypot(v.real, v.img) : v)
export async function simulateText(text, { files } = {}) {
  const t = toNgspice(text, { files })
  if (t.unsupported.length) return { ok: false, title: t.title, warnings: t.warnings, unsupported: t.unsupported, runs: [] }
  const raw = []
  // 스윕의 점들은 한 엔진에서 이어서, 나머지는 한 건씩(치명 오류가 다음 건을 끌고 가지 않게)
  for (let i = 0; i < t.runs.length;) {
    const r = t.runs[i]
    let j = i + 1
    if (r.sweep) while (j < t.runs.length && t.runs[j].sweep && t.runs[j].label === r.label) j++
    const batch = t.runs.slice(i, j), started = Date.now()
    const res = await runMany(batch.map((x) => x.netlist), { timeoutMs: RUN_TIMEOUT_MS * Math.max(1, Math.ceil(batch.length / 50)) })
    batch.forEach((x, k) => raw.push({ label: x.label, analysis: x.analysis, step: x.step, sweep: x.sweep, ms: k === 0 ? Date.now() - started : 0, ...res[k] }))
    i = j
  }
  const runs = mergeSweeps(raw)
  return { ok: runs.every((r) => r.ok), title: t.title, warnings: t.warnings, unsupported: [], runs }
}
export { read, toNgspice }
