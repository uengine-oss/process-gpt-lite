// The worker thread lib/tiff.js tiffToPngs starts for one TIFF: walk it (tiffCore.js scanTiff — refuses loops and giant pages before any
// decoding), decode its first pages with UTIF.js and write each as a PNG. Its caller stops it after a time limit, whatever the decoder does.
import { parentPort, workerData } from 'node:worker_threads'
import { scanTiff, decodePage, LIMITS } from './tiffCore.js'
import { encodePng } from './tiff.js'

try {
  let UTIF
  try { UTIF = (await import('utif')).default } catch { throw Object.assign(new Error('no TIFF decoder installed'), { code: 'unavailable' }) }
  const { buffer, maxPages } = workerData
  const scan = scanTiff(new Uint8Array(buffer), { ...LIMITS, ...(workerData.limits || {}) })
  const pages = []
  for (let i = 0; i < Math.min(scan.pages.length, maxPages); i++) {
    const p = decodePage(UTIF, buffer, scan, i)
    pages.push({ png: new Uint8Array(encodePng(p)), width: p.width, height: p.height })
  }
  parentPort.postMessage({ total: scan.pages.length, pages })
} catch (e) {
  parentPort.postMessage({ error: { code: e?.code || 'broken', message: String(e?.message || e).slice(0, 200) } })
}
