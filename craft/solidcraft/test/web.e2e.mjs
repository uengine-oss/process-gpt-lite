// The built app, as Process GPT hosts it: same origin, in an iframe, ?host=parent, files by postMessage.
// Run with: node --test craft/solidcraft/test/web.e2e.mjs   (uses port 5282; build with build.sh first)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(path.join(HERE, '../../solidcraft-cli/package.json'))('playwright-core')
const WEB = process.env.SOLIDCRAFT_WEB_DIR || path.join(HERE, '../../../../artcraft/web/solidcraft')
const FIXTURES = path.join(HERE, 'fixtures')
const OUT = process.env.SOLIDCRAFT_TEST_OUT || path.join(HERE, 'out')
const PYTHON = path.join(HERE, '.venv/bin/python')
const PORT = 5282
const ORIGIN = `http://127.0.0.1:${PORT}`
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.jpg': 'image/jpeg' }

const HOST_PAGE = `<!doctype html><title>host</title><body style="margin:0">
<iframe id="app" src="/craft/solidcraft/?host=parent" style="border:0;width:1280px;height:720px"></iframe>
<script>
  window.messages = []
  addEventListener('message', (event) => {
    if (event.source !== document.getElementById('app').contentWindow) return
    const { bytes, ...rest } = event.data
    window.messages.push({ ...rest, origin: event.origin, size: bytes ? bytes.byteLength : undefined, bytes: bytes ? Array.from(new Uint8Array(bytes.buffer || bytes)) : undefined })
  })
  // as CraftEditorFrame.vue does: an ArrayBuffer, transferred
  window.sendFile = (name, data) => {
    const bytes = new Uint8Array(data).buffer
    document.getElementById('app').contentWindow.postMessage({ type: 'solidcraft:open', name, bytes }, location.origin, [bytes])
  }
</script>`

// the way server/index.js serves /craft: the .gz next to a .js or .wasm when the browser takes gzip
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, ORIGIN).pathname)
  if (url === '/host.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(HOST_PAGE) }
  const prefix = ['/craft/solidcraft/', '/under/a/base/craft/solidcraft/'].find((p) => url.startsWith(p))
  if (!prefix) { res.writeHead(404); return res.end() }
  const rel = url.slice(prefix.length) || 'index.html'
  const file = path.join(WEB, rel)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end() }
  const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }
  const gz = `${file}.gz`
  if (/\.(js|wasm)$/.test(file) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && fs.existsSync(gz)) {
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' })
    return fs.createReadStream(gz).pipe(res)
  }
  res.writeHead(200, headers)
  fs.createReadStream(file).pipe(res)
})

let browser
let page
let frame
let tmp
const requests = []
const failures = []
const leftThePage = [] // what got past the page's own policy on its way out

const bytesOf = (file) => [...fs.readFileSync(path.join(FIXTURES, file))]
const witness = (name, bytes) => {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, Buffer.from(bytes))
  return JSON.parse(execFileSync(PYTHON, [path.join(HERE, 'check_geometry.py'), file], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
}
const messages = (type) => page.evaluate((t) => window.messages.filter((m) => m.type === t).map(({ bytes, ...m }) => m), type)
async function waitFor(type, count = 1) {
  try {
    await page.waitForFunction(([t, n]) => window.messages.filter((m) => m.type === t).length >= n, [type, count], { timeout: 20_000 })
  } catch {
    const seen = await page.evaluate(() => window.messages.map(({ bytes, ...m }) => m))
    throw new Error(`no ${type} after 20 s; messages: ${JSON.stringify(seen)}; state: ${JSON.stringify(await state())}; failures: ${JSON.stringify(failures)}`)
  }
}
const clearMessages = () => page.evaluate(() => { window.messages.length = 0 })
const state = () => frame.evaluate(() => window.solidcraft.getState())
async function openByMessage(name, file = name) {
  const data = bytesOf(file)
  await clearMessages()
  await page.evaluate(([n, d]) => window.sendFile(n, d), [name, data])
  await frame.waitForFunction((n) => window.solidcraft.getState().name === n && window.solidcraft.getState().nodes > 0, name, { timeout: 60_000 })
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solidcraft-web-'))
  fs.mkdirSync(OUT, { recursive: true })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve) })
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'light' })
  page = await context.newPage()
  page.on('request', (request) => requests.push(request.url()))
  page.on('requestfailed', (request) => failures.push(`failed ${request.url()}`))
  page.on('response', (response) => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`) })
  page.on('pageerror', (error) => failures.push(`pageerror ${error.message}`))
  page.on('dialog', (dialog) => { failures.push(`dialog ${dialog.message()}`); dialog.dismiss() })
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(ORIGIN)) return route.continue()
    leftThePage.push(route.request().url())
    return route.abort()
  })
  await page.goto(`${ORIGIN}/host.html`)
  await waitFor('solidcraft:ready')
  frame = page.frames().find((f) => f.url().includes('/craft/solidcraft/'))
})
after(async () => {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the bridge starts by itself, posts ready and keeps ?host=parent', async () => {
  assert.equal(new URL(frame.url()).search, '?host=parent')
  assert.deepEqual(await state(), { name: '', nodes: 0, ready: true, lastError: null })
  // nothing but the editor while the file is on its way
  assert.equal(await frame.evaluate(() => { const home = document.querySelector('chili-home'); return home ? getComputedStyle(home).display : 'none' }), 'none')
  const [ready] = await messages('solidcraft:ready')
  assert.equal(ready.origin, ORIGIN)
})

test('opening over postMessage shows the model fitted, with no welcome screen and no assistant', async () => {
  await openByMessage('C_0603_1608Metric.step')
  assert.deepEqual(await state(), { name: 'C_0603_1608Metric.step', nodes: 1, ready: true, lastError: null })
  await page.waitForTimeout(800)
  const view = await frame.evaluate(() => {
    const canvases = [...document.querySelectorAll('chili-uiview canvas')].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width - a.width)
    const rect = canvases[0]
    const { activeView } = globalThis.app
    const node = activeView.document.modelManager.rootNode.firstChild.firstChild
    const box = node.boundingBox()
    const corners = []
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(activeView.worldToScreen({ x, y, z }))
    return {
      rect: { width: rect.width, height: rect.height }, corners,
      size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
      home: !document.querySelector('chili-home') || getComputedStyle(document.querySelector('chili-home')).display === 'none',
      assistant: !!document.querySelector('chili-ai-chat')?.isConnected,
      notice: document.getElementById('sc-notice')?.textContent,
      github: !!document.querySelector('chili-ribbon a[href*="xiangechen/chili3d"]'),
    }
  })
  assert.ok(view.home, 'no welcome screen')
  assert.ok(!view.assistant, 'the assistant dock is closed')
  assert.match(view.notice, /Chili3D 0\.8\.0 \(AGPL-3\.0\)/)
  assert.ok(view.github, 'Chili3D\'s own link stays on the ribbon')
  const xs = view.corners.map((p) => p.x)
  const ys = view.corners.map((p) => p.y)
  assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) <= view.rect.width && Math.min(...ys) >= 0 && Math.max(...ys) <= view.rect.height, `model inside the view: ${JSON.stringify({ xs, ys, rect: view.rect })}`)
  assert.ok(Math.max(...xs) - Math.min(...xs) > view.rect.width / 4 || Math.max(...ys) - Math.min(...ys) > view.rect.height / 4, 'and fills a good part of it')
  assert.ok(Math.abs(view.size[0] - 1.6) < 0.01 && Math.abs(view.size[1] - 0.8) < 0.01, `the part is its real size: ${view.size}`)
  // the viewport really shows something (not just a coloured rectangle)
  const shot = await page.locator('#app').screenshot({ path: path.join(OUT, 'app-1280x720.png') })
  assert.ok(shot.length > 20_000, `screenshot has content: ${shot.length} bytes`)
})

test('an edit posts dirty; ⌘S and Ctrl+S post the file back in the format it came in', async () => {
  await openByMessage('sample_part.stp')
  const base = witness('sample_before.stp', bytesOf('sample_part.stp')).volume
  const nodesBefore = (await state()).nodes // this file has a solid and 16 construction curves and points
  await clearMessages()
  // an edit the way the app's commands make one: in a transaction
  await frame.evaluate(() => {
    const { Transaction, EditableShapeNode, Plane } = globalThis.Chili3dCore
    const doc = globalThis.app.activeView.document
    const shape = globalThis.shapeFactory.box(Plane.XY, 10, 10, 10)
    Transaction.execute(doc, 'add a box', () => doc.modelManager.addNode(new EditableShapeNode({ document: doc, name: 'added', shape })))
  })
  await waitFor('solidcraft:dirty')
  assert.deepEqual((await messages('solidcraft:dirty')).map((m) => m.dirty), [true])
  assert.equal((await state()).nodes, nodesBefore + 1)
  // the shortcut in the frame, not in a script: the keyboard goes to the focused iframe
  await page.locator('#app').click({ position: { x: 700, y: 400 } })
  await page.keyboard.press('Meta+s')
  await waitFor('solidcraft:save')
  const saved = await page.evaluate(() => window.messages.find((m) => m.type === 'solidcraft:save'))
  assert.equal(saved.name, 'sample_part.stp')
  assert.ok(Buffer.from(saved.bytes.slice(0, 12)).toString().startsWith('ISO-10303'), 'a .stp comes back as STEP')
  const seen = witness('saved.stp', saved.bytes)
  assert.equal(seen.solids, 2, 'the edit is in the saved file')
  assert.ok(Math.abs(seen.volume - (base + 1000)) < 0.01 * base, `saved volume ${seen.volume}, expected ${base + 1000}`)
  // after a save the next edit says dirty again
  await clearMessages()
  await frame.evaluate(() => {
    const { Transaction } = globalThis.Chili3dCore
    const doc = globalThis.app.activeView.document
    Transaction.execute(doc, 'rename', () => { doc.modelManager.rootNode.firstChild.visible = false })
    Transaction.execute(doc, 'rename', () => { doc.modelManager.rootNode.firstChild.visible = true })
  })
  await waitFor('solidcraft:dirty')
  await clearMessages()
  await page.keyboard.press('Control+s')
  await waitFor('solidcraft:save')
  // the ribbon's save button goes to the host too, not to the browser's own store
  await clearMessages()
  await frame.evaluate(() => globalThis.Chili3dCore.PubSub.default.pub('executeCommand', 'doc.save'))
  await waitFor('solidcraft:save')
  assert.equal((await messages('solidcraft:save'))[0].name, 'sample_part.stp')
})

test('.step .stp .igs .iges open, export to both formats and read back', async () => {
  const report = []
  for (const [name, file] of [['C_0603_1608Metric.step', 'C_0603_1608Metric.step'], ['sample_part.stp', 'sample_part.stp'], ['surf114.igs', 'surf114.igs'], ['surf114_copy.iges', 'surf114.igs'], ['curve_geom_plate.igs', 'curve_geom_plate.igs']]) {
    await openByMessage(name, file)
    const original = witness(`orig-${name}`, bytesOf(file))
    const exported = await frame.evaluate(async () => {
      const [step, iges] = [await window.solidcraft.exportFile('.step'), await window.solidcraft.exportFile('.iges')]
      return { step: Array.from(step), iges: Array.from(iges), isBytes: step instanceof Uint8Array && iges instanceof Uint8Array }
    })
    assert.ok(exported.isBytes, 'exportFile gives a Uint8Array')
    const fromStep = witness(`${name}.out.step`, exported.step)
    const fromIges = witness(`${name}.out.iges`, exported.iges)
    assert.equal(fromStep.solids, original.solids, `${name}: STEP keeps the solids`)
    if (original.solids) assert.ok(Math.abs(fromStep.volume - original.volume) < 1e-3 * original.volume, `${name}: volume through STEP ${fromStep.volume} vs ${original.volume}`)
    assert.equal(fromIges.solids, 0, `${name}: IGES has surfaces only`)
    assert.ok(fromIges.faces >= original.faces, `${name}: every face comes through IGES (${fromIges.faces} of ${original.faces})`)
    for (let i = 0; i < 3; i++) {
      for (const [label, seen] of [['STEP', fromStep], ['IGES', fromIges]]) assert.ok(Math.abs(seen.bbox.size[i] - original.bbox.size[i]) < 0.01 * Math.max(...original.bbox.size), `${name} ${label} size[${i}]: ${seen.bbox.size[i]} vs ${original.bbox.size[i]}`)
    }
    // and the app reads its own output
    for (const [outName, bytes] of [['back.step', exported.step], ['back.iges', exported.iges]]) {
      const back = await frame.evaluate(async ([n, b]) => window.solidcraft.openFile(n, new Uint8Array(b)), [outName, bytes])
      assert.ok(back.nodes >= 1 && !back.lastError, `${name} -> ${outName}: ${JSON.stringify(back)}`)
    }
    report.push(`${name}: solids ${original.solids}, faces ${original.faces} -> STEP ${fromStep.solids}/${fromStep.faces}, IGES ${fromIges.solids}/${fromIges.faces}`)
  }
  console.log(`  ${report.join('\n  ')}`)
})

test('a bad file reports failed and the app keeps working', async () => {
  await openByMessage('C_0603_1608Metric.step')
  await clearMessages()
  await page.evaluate(() => window.sendFile('broken.step', new TextEncoder().encode('not a STEP file')))
  await waitFor('solidcraft:failed')
  const [failed] = await messages('solidcraft:failed')
  assert.match(failed.error, /broken\.step/)
  assert.match((await state()).lastError, /broken\.step/)
  await clearMessages()
  await page.evaluate(() => window.sendFile('notes.txt', new TextEncoder().encode('hello')))
  await waitFor('solidcraft:failed')
  assert.match((await messages('solidcraft:failed'))[0].error, /not a STEP/)
  await openByMessage('C_0603_1608Metric.step')
  assert.equal((await state()).lastError, null)
  await assert.rejects(frame.evaluate(() => window.solidcraft.exportFile('.dxf')), /unknown format/)
})

test('a message from another window or origin does nothing', async () => {
  const before = await state()
  await frame.evaluate(() => window.postMessage({ type: 'solidcraft:open', name: 'self.step', bytes: new ArrayBuffer(4) }, '*'))
  await page.waitForTimeout(300)
  assert.deepEqual(await state(), before)
})

test('hosted: one file per frame, and the assistant stays quiet when it is opened', async () => {
  const shown = await frame.evaluate(() => {
    const visible = (icon) => [...document.querySelectorAll('chili-ribbon svg')].filter((svg) => svg.querySelector('use')?.getAttribute('xlink:href') === icon && getComputedStyle(svg).display !== 'none').length
    return { plus: visible('#icon-plus'), close: visible('#icon-times') }
  })
  assert.deepEqual(shown, { plus: 0, close: 0 })
  const before = requests.length
  await frame.evaluate(() => globalThis.Chili3dCore.PubSub.default.pub('toggleChatPanel'))
  await frame.waitForSelector('chili-ai-chat')
  await page.waitForTimeout(500)
  assert.ok(await frame.evaluate(() => document.querySelector('chili-ai-chat').isConnected), 'the panel can be opened')
  assert.deepEqual(requests.slice(before).filter((url) => !url.startsWith(ORIGIN)), [], 'and calls nobody')
  await frame.evaluate(() => globalThis.Chili3dCore.PubSub.default.pub('toggleChatPanel'))
})

test('this page cannot load a third-party script or call out, whatever asks it to', async () => {
  const other = await page.context().newPage()
  await other.goto(`${ORIGIN}/craft/solidcraft/`)
  await other.waitForFunction(() => window.solidcraft?.getState().ready, null, { timeout: 60_000 })
  // from a script of the page's own, not page.evaluate, which the browser lets past the page's policy.
  // What the Text tool does on first use, and what a configured assistant would do.
  const attempts = await other.evaluate(() => new Promise((resolve) => {
    const blocked = []
    document.addEventListener('securitypolicyviolation', (event) => blocked.push(event.blockedURI))
    window.__finish = (out) => setTimeout(() => resolve({ ...out, blocked }), 200) // violations arrive a moment later
    const script = document.createElement('script')
    script.type = 'module'
    script.textContent = `
      const out = {}
      try { await import('https://cdn.jsdelivr.net/npm/opentype.js@2.0.0/dist/opentype.min.mjs'); out.script = 'loaded' } catch { out.script = 'blocked' }
      try { await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' }); out.fetch = 'sent' } catch { out.fetch = 'blocked' }
      window.__finish(out)`
    document.head.append(script)
  }))
  assert.equal(attempts.script, 'blocked')
  assert.equal(attempts.fetch, 'blocked')
  assert.ok(attempts.blocked.some((url) => url.includes('cdn.jsdelivr.net')) && attempts.blocked.some((url) => url.includes('api.anthropic.com')), `the policy stopped both: ${attempts.blocked}`)
  assert.deepEqual(leftThePage, [], 'neither left the page')
  // the standalone page still has Chili3D's own welcome screen and notices
  assert.ok(await other.evaluate(() => getComputedStyle(document.querySelector('chili-home')).display !== 'none'))
  await other.close()
})

test('startup parameters cannot pull anything in; the build also runs under a base path', async () => {
  const other = await page.context().newPage()
  const seen = []
  other.on('request', (request) => seen.push(request.url()))
  const evil = 'https://evil.example'
  await other.goto(`${ORIGIN}/under/a/base/craft/solidcraft/?host=parent&plugin=${evil}/x&url=${evil}/a.step&model=${evil}/b.step&bridge=9999`)
  await other.waitForFunction(() => window.solidcraft?.getState().ready, null, { timeout: 60_000 })
  await other.waitForTimeout(1000)
  assert.deepEqual(seen.filter((u) => !u.startsWith(ORIGIN)), [], 'nothing outside the origin')
  assert.ok(seen.every((u) => new URL(u).pathname.startsWith('/under/a/base/')), `all assets under the base path: ${seen.filter((u) => !new URL(u).pathname.startsWith('/under/a/base/'))}`)
  assert.equal(new URL(other.url()).search, '?host=parent')
  await other.close()
})

test('the network log: same origin only, nothing missing, no prompts', async () => {
  const external = requests.filter((url) => !url.startsWith(ORIGIN))
  assert.deepEqual(external, [], 'no remote service, analytics or LLM was called')
  assert.ok(!requests.some((url) => /videos\.json/.test(url)), 'the welcome screen\'s video list was not asked for')
  assert.deepEqual(failures, [], 'no failed request, page error or dialog')
  console.log(`  ${requests.length} requests, all to ${ORIGIN}`)
})
