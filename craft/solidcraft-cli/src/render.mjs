// render: the real app in headless Chromium, started on first use and closed when idle. The app is
// served from the same folder /craft/solidcraft/ is, on a private local port; nothing else is reachable.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolError } from './kernel.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.jpg': 'image/jpeg', '.png': 'image/png' }
const IDLE_MS = Number(process.env.SOLIDCRAFT_RENDER_IDLE_MS) || 60_000
const PREFIX = '/craft/solidcraft/'
export const WIDTH = 1600
export const HEIGHT = 1000

export function findWebRoot(given) {
  const candidates = [given, process.env.SOLIDCRAFT_WEB_ROOT, process.env.PRO_CRAFT_WEB_ROOT && path.join(process.env.PRO_CRAFT_WEB_ROOT, 'solidcraft'), path.join(HERE, '../../../artcraft/web/solidcraft'), path.join(HERE, '../../../../artcraft/web/solidcraft')].filter(Boolean)
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || null
}

export class Renderer {
  constructor({ webRoot } = {}) { this.webRoot = findWebRoot(webRoot) }

  async page() {
    if (this.current) return this.current
    if (!this.webRoot) throw new ToolError('render needs the SolidCraft web build; run craft/solidcraft/build.sh')
    const { chromium } = await import('playwright-core')
    this.server = http.createServer((req, res) => this.serve(req, res))
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${this.server.address().port}`
    try {
      this.browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
    } catch (error) {
      this.server.close()
      throw new ToolError(`render could not start Chromium (npx playwright-core install chromium-headless-shell installs it): ${String(error.message).split('\n')[0]}`)
    }
    const page = await this.browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: 'light' })
    await page.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()))
    await page.goto(`${base}${PREFIX}?render=1`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.solidcraft?.getState().ready, null, { timeout: 60_000 })
    this.current = page
    return page
  }

  serve(req, res) {
    const url = decodeURIComponent(new URL(req.url, 'http://local').pathname)
    if (!url.startsWith(PREFIX)) { res.writeHead(404); return res.end() }
    const file = path.join(this.webRoot, path.normalize(url.slice(PREFIX.length)) === '.' ? 'index.html' : path.normalize(url.slice(PREFIX.length)))
    if (!file.startsWith(this.webRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  }

  /** parts: [{name, brep, color}]; the PNG's bytes */
  async render({ parts, name, view }) {
    clearTimeout(this.idle)
    try {
      const page = await this.page()
      const { dataUrl, foreground } = await page.evaluate(async ({ parts, name, view, width, height }) => {
        await window.solidcraft.loadParts(parts, { name })
        return window.solidcraft.renderImage({ view, width, height })
      }, { parts, name, view, width: WIDTH, height: HEIGHT })
      if (!(foreground > 0)) throw new ToolError('the picture came out blank: nothing was drawn')
      return { png: Buffer.from(dataUrl.split(',')[1], 'base64'), foreground }
    } finally {
      this.idle = setTimeout(() => this.close(), IDLE_MS)
      this.idle.unref()
    }
  }

  async close() {
    clearTimeout(this.idle)
    const { browser, server } = this
    this.current = this.browser = this.server = null
    await browser?.close().catch(() => {})
    server?.close()
  }
}
