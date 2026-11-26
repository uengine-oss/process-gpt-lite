// Every /api answer is data, never a page that runs on this origin: the browser does not guess its type
// (nosniff) and, unless it is a PDF (the browser's own viewer needs it), it opens sandboxed with no scripts,
// so a stored XML · SVG · HTML reached by a link shows as an inert document. fetch · <img> · <video> are
// not affected by these headers. A route that sets its own policy (the workroom's raw files) keeps it.
export const API_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"

const typeIn = (res, args) => {
  for (const a of args) if (a && typeof a === 'object') for (const [k, v] of Object.entries(a)) if (k.toLowerCase() === 'content-type') return String(v)
  return String(res.getHeader('content-type') || '')
}
const hasOwnPolicy = (res, args) => !!res.getHeader('content-security-policy') ||
  args.some((a) => a && typeof a === 'object' && Object.keys(a).some((k) => k.toLowerCase() === 'content-security-policy'))

export function apiHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const writeHead = res.writeHead
  res.writeHead = function (...args) {
    if (!/^application\/pdf\b/i.test(typeIn(this, args)) && !hasOwnPolicy(this, args)) this.setHeader('Content-Security-Policy', API_CSP)
    return writeHead.apply(this, args)
  }
  next()
}
