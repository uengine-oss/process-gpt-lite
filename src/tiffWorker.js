// The page's TIFF worker (src/tiff.js starts it the first time a TIFF is shown — neither it nor the decoder loads before). It keeps each
// opened file and hands back one page at a time as RGBA pixels: {op: 'open', doc, buffer} → {pages: [{width, height}]} (sizes as shown);
// {op: 'page', doc, page, maxWidth} → {width, height, rgba}; {op: 'close', doc}. The walk in tiffCore.js refuses a damaged or giant file
// before anything is decoded; the page stops this worker when a page takes too long (a damaged strip can make the decoder loop).
import './tiffPako.js'
import UTIF from 'utif'
import { scanTiff, decodePage, TiffError } from './tiffCore.js'

const docs = new Map()
self.onmessage = (e) => {
  const { id, op, doc } = e.data || {}
  try {
    if (op === 'open') {
      const scan = scanTiff(new Uint8Array(e.data.buffer))
      docs.set(doc, { buffer: e.data.buffer, scan })
      self.postMessage({ id, pages: scan.pages.map((p) => ({ width: p.shownWidth, height: p.shownHeight })) })
    } else if (op === 'page') {
      const d = docs.get(doc)
      if (!d) throw new TiffError('broken', 'not open')
      const p = decodePage(UTIF, d.buffer, d.scan, e.data.page, { maxWidth: e.data.maxWidth || 0 })
      self.postMessage({ id, width: p.width, height: p.height, rgba: p.rgba }, [p.rgba.buffer])
    } else if (op === 'close') {
      docs.delete(doc)
      self.postMessage({ id })
    }
  } catch (err) {
    self.postMessage({ id, error: { code: err?.code || 'broken', message: String(err?.message || err).slice(0, 200) } })
  }
}
