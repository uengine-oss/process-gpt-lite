// A JSON answer whose work (model calls) can take longer than the proxy in front waits for a response: Cloudflare answers 524
// when no response headers come within 100 s. Done within `quiet` ms, the answer goes out as usual (status, body). Past that, a
// 200 application/json with X-Long-Json: 1 is committed and a space is written every `every` ms (JSON allows whitespace before
// a value), then the body — an error as {"error": message, "status": code}. src/api.js reads such a body with an error and a
// status of 400 or more as the failure it is. (lib/sse.js does the same for event streams.)
export const LONG_HEADER = 'X-Long-Json'

// e → {status, body} the way the routes answer an error (an error without a status is logged and not shown)
export const defaultFail = (e) => ({ status: e?.status || 500, body: { error: e?.status ? e.message : '처리하지 못했어요.' } })

export function longJson(res, work, { quiet = 15000, every = 15000, fail = defaultFail, onQuick } = {}) {
  let committed = false, ping = null
  const stop = () => { clearTimeout(timer); clearInterval(ping) }
  const timer = setTimeout(() => {
    if (res.headersSent || res.writableEnded) return
    committed = true
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', [LONG_HEADER]: '1' })
    res.write(' ')
    ping = setInterval(() => { if (!res.writableEnded) res.write(' ') }, every)
  }, quiet)
  res.on('close', stop)
  return Promise.resolve().then(work).then((body) => ({ ok: true, body }), (e) => ({ ok: false, ...fail(e) })).then((r) => {
    stop()
    if (res.writableEnded || res.destroyed) return
    if (!committed) {
      onQuick?.(res)
      return r.ok ? res.json(r.body) : res.status(r.status).json(r.body)
    }
    res.end(JSON.stringify(r.ok ? (r.body === undefined ? null : r.body) : { ...r.body, status: r.status }))
  })
}
