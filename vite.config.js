import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

// Reached through a public tunnel (Cloudflare quick tunnels have no auth of their own), every
// request that does not come from this machine needs the basic-auth pair in server/.public-access.
// Localhost is untouched. Terminals additionally need PRO_TERMINAL_KEY on the server.
function publicGate() {
  let pair = null
  try {
    const kv = Object.fromEntries(fs.readFileSync(new URL('./server/.public-access', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=').map((x) => x.trim())))
    pair = `${kv.NGROK_BASIC_USER}:${kv.NGROK_BASIC_PASS}`
  } catch { /* no file: no public access at all */ }
  // (*.localhost too: http://en.localhost:5180 is the English demo tenant — server/lib/tenant.js)
  const local = (h) => /^(([a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h || '')
  const ok = (auth) => {
    if (!pair || !/^Basic /.test(auth || '')) return false
    const got = Buffer.from(Buffer.from(auth.slice(6), 'base64').toString())
    const want = Buffer.from(pair)
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  }
  // after one basic-auth exchange a cookie carries the pass: API calls use Authorization for their
  // own bearer token, and browsers do not send basic credentials on websockets
  const pass = pair ? crypto.createHash('sha256').update(`pgpt-gate:${pair}`).digest('hex') : null
  const hasPass = (req) => !!pass && (req.headers.cookie || '').split(/;\s*/).includes(`pgpt_gate=${pass}`)
  const guard = (req) => local(req.headers.host) || hasPass(req) || ok(req.headers.authorization)
  return {
    name: 'public-gate',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!local(req.headers.host) && !hasPass(req) && ok(req.headers.authorization)) {
          res.setHeader('Set-Cookie', `pgpt_gate=${pass}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`)
        }
        if (guard(req)) return next()
        res.statusCode = 401
        res.setHeader('WWW-Authenticate', 'Basic realm="pgpt pro", charset="UTF-8"')
        res.end('authentication required')
      })
      // websocket upgrades (terminal, editor) bypass the middleware: close them here first
      server.httpServer?.prependListener('upgrade', (req, socket) => {
        if (!guard(req) && !/vite-hmr/.test(req.headers['sec-websocket-protocol'] || '')) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy() }
      })
    },
  }
}

// Link previews and the app's identity (2026-11-24). Crawlers (KakaoTalk, Slack, Facebook) read index.html without
// running it and need absolute addresses: __PGL_PUBLIC_URL__ there becomes the public origin + the base path —
// LITE_PUBLIC_ORIGIN, by default the main company's address (the picture and the words are the same for every
// company); the web image's nginx puts in each request's own host when it knows it (install/docker/nginx.conf).
// The manifest's id is resolved against the origin, so it carries the base path: written at build, the same
// address Chrome used as the id before (start_url), so installed copies stay the same app.
const PUBLIC_ORIGIN = (process.env.LITE_PUBLIC_ORIGIN || 'https://uengine.process-gpt.io').replace(/\/+$/, '')
function pageMeta() {
  let base = '/'
  let outDir = ''
  return {
    name: 'pgl-page-meta',
    configResolved(c) { base = c.base; outDir = c.command === 'build' ? path.resolve(c.root, c.build.outDir) : '' },
    transformIndexHtml: { order: 'pre', handler: (html) => html.replaceAll('__PGL_PUBLIC_URL__', PUBLIC_ORIGIN + base.replace(/\/$/, '')) },
    closeBundle() {
      const f = path.join(outDir, 'manifest.webmanifest')
      if (!outDir || !fs.existsSync(f)) return
      const m = JSON.parse(fs.readFileSync(f, 'utf8'))
      fs.writeFileSync(f, JSON.stringify({ id: `${base}chat`, ...m }, null, 2) + '\n')
    },
  }
}

export default defineConfig({
  // '/' for local and the Docker install; '/lite/' for the image behind the ProcessGPT gateway
  // (<tenant>.process-gpt.io/lite, which strips the prefix like its /wms route) — see src/base.js
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [vue(), publicGate(), pageMeta()],
  server: {
    port: 5180,
    strictPort: true,
    // reachable through an ngrok tunnel (README: 외부 접속)
    allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.ngrok.io', '.trycloudflare.com'],
    proxy: {
      // ws: the agent workroom terminal upgrades on /api/workroom/term
      // (PRO_API_TARGET: a second, development server on another port — PRO_BACKGROUND=0)
      '/api': { target: process.env.PRO_API_TARGET || 'http://127.0.0.1:8787', changeOrigin: false, ws: true },
      // IeumOffice editor (process-gpt office-host): page, __ipc socket and document bytes on this origin
      // (PRO_OFFICE_TARGET: another office host, e.g. a container of the production image on another port)
      '/office': { target: process.env.PRO_OFFICE_TARGET || 'http://127.0.0.1:5390', ws: true, changeOrigin: true },
      // ArtCraft web apps (CADCraft …), served by the pgpt-pro server
      '/craft': { target: process.env.PRO_API_TARGET || 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
})
