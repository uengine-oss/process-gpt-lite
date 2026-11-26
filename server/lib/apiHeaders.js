// Every /api answer is data, never a page that runs on this origin: the browser does not guess its type
// (nosniff) and it opens sandboxed with no scripts, so a stored XML · SVG · HTML reached by a link shows as an
// inert document. Left out: a PDF (the browser's own viewer needs it) and a picture (not SVG), sound or video —
// with nosniff these cannot run script, and a sandbox would stop a video or a song opened in its own tab from
// playing (media-src falls back to default-src 'none'; 2026-11-26). fetch · <img> · <video> in the app are not
// affected by these headers. A route that sets its own policy (the workroom's raw files) keeps it.
export const API_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"

const typeIn = (res, args) => {
  for (const a of args) if (a && typeof a === 'object') for (const [k, v] of Object.entries(a)) if (k.toLowerCase() === 'content-type') return String(v)
  return String(res.getHeader('content-type') || '')
}
// a type the browser shows by itself and never runs: PDF, audio, video, and pictures other than SVG
export const inertType = (type) => /^(application\/pdf|audio\/|video\/|image\/(?!svg))/i.test(String(type || '').trim())
const hasOwnPolicy = (res, args) => !!res.getHeader('content-security-policy') ||
  args.some((a) => a && typeof a === 'object' && Object.keys(a).some((k) => k.toLowerCase() === 'content-security-policy'))

export function apiHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const writeHead = res.writeHead
  res.writeHead = function (...args) {
    if (!inertType(typeIn(this, args)) && !hasOwnPolicy(this, args)) this.setHeader('Content-Security-Policy', API_CSP)
    return writeHead.apply(this, args)
  }
  next()
}
