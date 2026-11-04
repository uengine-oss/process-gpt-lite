// --automation-read-root / --automation-write-root: which files a tool may touch. Checked on the
// real path, so a symlink inside the root cannot lead out of it.
import fs from 'node:fs'
import path from 'node:path'
import { ToolError } from './kernel.mjs'

/** the real path of the deepest part that exists, plus what is not there yet */
function realpathAllowingNew(target) {
  let existing = target
  const missing = []
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    missing.unshift(path.basename(existing))
    existing = parent
  }
  return path.join(fs.realpathSync(existing), ...missing)
}

export function confine(value, root, kind) {
  const raw = String(value ?? '')
  if (!raw || raw.includes('\0')) throw new ToolError(`bad ${kind} path`)
  const full = path.resolve(root || process.cwd(), raw)
  if (!root) return full
  const real = realpathAllowingNew(full)
  const realRoot = fs.realpathSync(root)
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new ToolError(`refused: ${raw} is outside the allowed ${kind} folder`)
  return real
}
