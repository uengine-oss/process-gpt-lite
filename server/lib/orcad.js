// OrCAD Capture .dsn 를 PSpice 넷리스트로(craft/orcad). 임시 파일은 요청이 끝나면 지운다.
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { L } from './lang.js'

const CLI = process.env.PRO_DSN2CIR || fileURLToPath(new URL('../../craft/orcad/dsn2cir', import.meta.url))
const fail = (message, status) => Object.assign(new Error(message), { status })

export async function dsnToCir(bytes) {
  // OLE 복합 파일 머리: 아니면 OrCAD 파일이 아니다
  if (!Buffer.isBuffer(bytes) || bytes.subarray(0, 4).toString('hex') !== 'd0cf11e0') throw fail(L('OrCAD .dsn 파일이 아니에요', 'This is not an OrCAD .dsn file'), 400)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsn-'))
  try {
    const file = path.join(dir, 'design.dsn')
    await fs.writeFile(file, bytes)
    const { stdout, stderr } = await new Promise((resolve, reject) => execFile(CLI, [file], { timeout: 120000, maxBuffer: 64 << 20 }, (e, so, se) => {
      if (e?.code === 'ENOENT') return reject(fail(L('이 설치에는 OrCAD 변환 도구가 없어요', 'This install has no OrCAD converter'), 501))
      if (e) return reject(fail(L(`OrCAD 파일을 읽지 못했어요: ${String(se || e.message).split('\n')[0].slice(0, 200)}`, `Could not read the OrCAD file: ${String(se || e.message).split('\n')[0].slice(0, 200)}`), 422))
      resolve({ stdout: so, stderr: se })
    }))
    return { text: stdout, warnings: stderr.split('\n').filter((l) => /^warning:/.test(l)).map((l) => l.replace(/^warning:\s*/, '')) }
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
