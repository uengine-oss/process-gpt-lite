// The body of one request of a folder going up (POST /api/folders/:slug/files/batch — src/folderDrop.js batchBody makes it): read as it
// arrives, every limit checked before more is read, so nothing is held that is not allowed.
//   "PGLB1\n" · u32 meta length · meta (JSON: {count, label, part, parts, session}) · count × (u16 path length · path (UTF-8) · u32 size · bytes)
// limits (secrets.js BATCH): count ≤ files, meta ≤ metaBytes, a path ≤ pathBytes, a file ≤ largeFileBytes, the files together ≤ bytes;
// nothing after the last file. → {meta, items: [{path, buf}]} · throws an error with status 400 (not this shape) or 413 (over a limit)
export const MAGIC = Buffer.from('PGLB1\n')

const fail = (status, code, message) => Object.assign(new Error(message), { status, code })

export async function readBatch(stream, limits) {
  const it = stream[Symbol.asyncIterator]()
  let left = Buffer.alloc(0) // what came in and is not read yet
  let ended = false
  // the next chunk, or null at the end
  const pull = async () => {
    if (ended) return null
    const r = await it.next()
    if (r.done) { ended = true; return null }
    return Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value)
  }
  // exactly n bytes (small: the header parts)
  const bytes = async (n) => {
    while (left.length < n) {
      const c = await pull()
      if (!c) throw fail(400, 'short', 'the upload ended early')
      left = left.length ? Buffer.concat([left, c]) : c
    }
    const out = left.subarray(0, n)
    left = left.subarray(n)
    return out
  }
  // a file's n bytes, gathered once (n is already allowed)
  const payload = async (n) => {
    const parts = []
    let got = 0
    if (left.length) { const a = left.subarray(0, n); parts.push(a); got += a.length; left = left.subarray(a.length) }
    while (got < n) {
      const c = await pull()
      if (!c) throw fail(400, 'short', 'the upload ended early')
      const need = n - got
      if (c.length > need) { parts.push(c.subarray(0, need)); left = c.subarray(need); got = n } else { parts.push(c); got += c.length }
    }
    return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts, n)
  }

  if (!(await bytes(MAGIC.length)).equals(MAGIC)) throw fail(400, 'shape', 'not a folder upload')
  const metaLen = (await bytes(4)).readUInt32BE(0)
  if (metaLen > limits.metaBytes) throw fail(413, 'too_big', 'the upload description is too long')
  let meta
  try { meta = JSON.parse((await bytes(metaLen)).toString('utf8')) } catch (e) { if (e.status) throw e; throw fail(400, 'shape', 'not a folder upload') }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw fail(400, 'shape', 'not a folder upload')
  const count = Number(meta.count)
  if (!Number.isInteger(count) || count < 1) throw fail(400, 'shape', 'no files')
  if (count > limits.files) throw fail(413, 'too_many', 'too many files in one request')
  const items = []
  let total = 0
  for (let i = 0; i < count; i++) {
    const plen = (await bytes(2)).readUInt16BE(0)
    if (!plen || plen > limits.pathBytes) throw fail(400, 'shape', 'a path is empty or too long')
    const path = (await bytes(plen)).toString('utf8')
    const size = (await bytes(4)).readUInt32BE(0)
    if (size > limits.largeFileBytes) throw fail(413, 'too_big', 'a file is over the size limit')
    total += size
    if (total > limits.bytes) throw fail(413, 'too_big', 'the files of one request are over the size limit')
    items.push({ path, buf: await payload(size) })
  }
  if (left.length || (await pull())) throw fail(400, 'shape', 'more than the upload said')
  return { meta, items }
}
