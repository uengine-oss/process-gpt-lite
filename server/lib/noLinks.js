// Writing into a work tree that people and runs fill: no part of the path may be a symbolic link. A link
// that came in with a folder's files (a push, a merge, an archive) would send a write, a removal or a copy
// somewhere else — the repository's own data, another folder, the server's files. The server's git checks
// links out as small plain files (core.symlinks=false, folders/git.js); this guards what is already there.
import fs from 'node:fs/promises'
import path from 'node:path'

const parts = (rel) => String(rel || '').split(/[\\/]+/).filter((s) => s && s !== '.')

// the first part of root/rel that is a symbolic link, or null (parts that don't exist yet end the walk)
export async function linkOnPath(root, rel) {
  let cur = path.resolve(root)
  for (const seg of parts(rel)) {
    cur = path.join(cur, seg)
    const st = await fs.lstat(cur).catch(() => null)
    if (!st) return null
    if (st.isSymbolicLink()) return cur
  }
  return null
}
export async function assertNoLink(root, rel) {
  if (await linkOnPath(root, rel)) throw Object.assign(new Error('not a document path'), { status: 400 })
}
// remove every symbolic link under dir (a freshly extracted archive), so nothing follows one later
export async function dropLinks(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    if (e.isSymbolicLink()) await fs.rm(p, { force: true })
    else if (e.isDirectory()) await dropLinks(p)
  }
}
