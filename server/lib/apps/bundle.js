// One self-contained HTML per screen (docs/robo-dlc/plan-mcp-apps.md §6). An MCP Apps host other than Lite (Claude,
// the reference host) loads a ui:// resource's text as it is — no <base>, nothing beside it — so the screen's
// stylesheets go in as <style> and its module script, Lite's runtime and the MCP Apps SDK as one inline module.
// Built with rolldown (the bundler Vite ships) and kept until a file of the screen changes.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const RUNTIME = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime')
const EXT_APPS = createRequire(import.meta.url).resolve('@modelcontextprotocol/ext-apps/app-with-deps')
const built = new Map() // file -> { stamp, html: Promise<html> }

// an address in the screen (as Lite serves it at /api/apps/<id>/ui/) → the file on disk
const fileOf = (uiDir, href) => (/(^|\/)_runtime\//.test(href) ? path.join(RUNTIME, href.replace(/^.*_runtime\//, '')) : path.join(uiDir, href))

async function bundleScript(uiDir, src) {
  const { rolldown } = await import('rolldown')
  const bundle = await rolldown({
    input: fileOf(uiDir, src),
    logLevel: 'silent',
    plugins: [{
      name: 'lite-runtime',
      resolveId(id, importer) {
        if (/(^|\/)_runtime\/lite\.js$/.test(id)) return path.join(RUNTIME, 'lite.js')
        if (id === './ext-apps.js' && importer === path.join(RUNTIME, 'lite.js')) return EXT_APPS
        return null
      },
    }],
  })
  try {
    const { output } = await bundle.generate({ format: 'esm', minify: true })
    return output[0].code
  } finally { await bundle.close() }
}

async function build(uiDir, file) {
  let html = fs.readFileSync(path.join(uiDir, file), 'utf8')
  // stylesheets beside the page (not the ones from a CDN) → inline
  html = html.replace(/<link\s+rel="stylesheet"\s+href="(?!https?:)([^"]+)"\s*\/?>/g, (m, href) => `<style>${fs.readFileSync(fileOf(uiDir, href), 'utf8')}</style>`)
  // module scripts beside the page → one inline module each (the runtime and the SDK inside)
  const scripts = [...html.matchAll(/<script\s+type="module"\s+src="(?!https?:)([^"]+)"\s*><\/script>/g)]
  for (const m of scripts) {
    const code = (await bundleScript(uiDir, m[1])).replace(/<\/script/gi, '<\\/script')
    html = html.replace(m[0], () => `<script type="module">${code}</script>`)
  }
  return html
}

// what the screen is made of, as of now: built again when a file of the screen or the runtime changes
const stamp = (uiDir) => [uiDir, RUNTIME].flatMap((d) => fs.readdirSync(d).map((f) => { try { return `${f}:${fs.statSync(path.join(d, f)).mtimeMs}` } catch { return f } })).join('|')

// the screen `file` of the app whose screen files are in uiDir, as one HTML; if bundling fails, the page as it is
// (Lite's own host still loads it through <base>)
export function screenHtml(uiDir, file = 'index.html') {
  const key = path.join(uiDir, file)
  const now = stamp(uiDir)
  const hit = built.get(key)
  if (!hit || hit.stamp !== now) {
    const html = build(uiDir, file).catch((e) => {
      console.warn('[apps] screen not bundled:', key, e.message)
      built.delete(key)
      return fs.readFileSync(key, 'utf8')
    })
    built.set(key, { stamp: now, html })
  }
  return built.get(key).html
}
