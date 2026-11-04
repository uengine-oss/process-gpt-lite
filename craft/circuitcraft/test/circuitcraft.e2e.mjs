// CircuitCraft end-to-end test against the built app. Run: node --test test/circuitcraft.e2e.mjs
//   CC_WEB_DIR   the build to serve (default: artcraft/web/circuitcraft, what build.sh writes)
//   CC_SHOTS     where the 1280x720 screenshots go (default: test/screenshots)
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { chromium } = await import(path.resolve(HERE, '../../../server/node_modules/playwright/index.mjs'))
const WEB = process.env.CC_WEB_DIR || path.resolve(HERE, '../../../../artcraft/web/circuitcraft')
const SHOTS = process.env.CC_SHOTS || path.join(HERE, 'screenshots')
const FIX = path.join(HERE, 'fixtures')
const PORT = Number(process.env.CC_PORT || 5281)
const APP = '/craft/circuitcraft/'
const URL_APP = `http://127.0.0.1:${PORT}${APP}`

const HOST_PAGE = `<!doctype html><title>host</title><body style="margin:0">
<iframe id="f" src="${URL_APP}?host=parent" style="width:1280px;height:720px;border:0"></iframe>
<script>
window.msgs = []
addEventListener('message', (e) => { if (e.source === document.getElementById('f').contentWindow) window.msgs.push(e.data) })
window.sendOpen = (name, bytes, files) => {
  const buf = new Uint8Array(bytes).buffer
  const fs = (files || []).map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes).buffer }))
  document.getElementById('f').contentWindow.postMessage({ type: 'circuitcraft:open', name, bytes: buf, files: fs }, '*', [buf, ...fs.map((f) => f.bytes)])
}
</script>`

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' }
let server, browser
const numbers = {}

before(async () => {
  fs.mkdirSync(SHOTS, { recursive: true })
  server = http.createServer((req, res) => {
    let u = decodeURIComponent(req.url.split('?')[0])
    if (u === '/host.html') { res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(HOST_PAGE) }
    // /proxy/... stands for a gateway in front of the Process GPT server (BASE in CraftEditorFrame)
    if (u.startsWith('/proxy/')) u = u.slice('/proxy'.length)
    if (!u.startsWith(APP)) { res.writeHead(404); return res.end() }
    u = u.slice(APP.length) || 'index.html'
    const file = path.join(WEB, u)
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
    const head = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }
    // the same choice as the /craft route in server/index.js
    if (file.endsWith('.js') && /gzip/.test(req.headers['accept-encoding'] || '') && fs.existsSync(file + '.gz')) {
      res.writeHead(200, { ...head, 'content-encoding': 'gzip', vary: 'Accept-Encoding' })
      return fs.createReadStream(file + '.gz').pipe(res)
    }
    res.writeHead(200, head)
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await new Promise((r) => server?.close(r))
  console.log('\nmeasured: ' + JSON.stringify(numbers, null, 1))
})

// ---------- helpers ----------

const fixture = (name) => [...fs.readFileSync(path.join(FIX, name))]
const fixtureText = (name) => fs.readFileSync(path.join(FIX, name), 'utf8')
const HS200_LIBS = ['hs200.lib', '1N4148.lib']

async function newPage(url = `${URL_APP}?host=parent`) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true })
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(e.message))
  page.problems = problems
  await page.goto(url)
  await page.waitForFunction(() => !!window.circuitcraft)
  return page
}

const openFixture = (page, name, libs = []) => page.evaluate(
  ([n, bytes, ls]) => window.circuitcraft.openFile(n, new Uint8Array(bytes), ls.map((l) => ({ name: l.name, bytes: new Uint8Array(l.bytes) }))),
  [name, fixture(name), libs.map((l) => ({ name: l, bytes: fixture(l) }))]
)
const openText = (page, name, text, libs = []) => page.evaluate(
  ([n, t, ls]) => window.circuitcraft.openFile(n, t, ls),
  [name, text, libs]
)
const runAll = (page) => page.evaluate(() => window.circuitcraft.runAll())
const result = (page, i) => page.evaluate((k) => window.circuitcraft.getResult(k), i)
const vector = (res, name) => res.vectors.find((v) => v.name.toLowerCase() === name)
const scale = (res) => res.vectors[0]

const plateauGain = (res, out, inp, t) => {
  const xs = scale(res).values
  const i = xs.findIndex((x) => x >= t)
  return vector(res, out).values[i] / vector(res, inp).values[i]
}
function acCorner(res, name) {
  const f = scale(res).re
  const v = vector(res, name)
  const mag = v.re.map((re, i) => Math.hypot(re, v.im[i]))
  const dc = mag[0]
  const target = dc / Math.SQRT2
  const k = mag.findIndex((m) => m < target)
  const r = (mag[k - 1] - target) / (mag[k - 1] - mag[k])
  return { dc, corner: 10 ** (Math.log10(f[k - 1]) + r * (Math.log10(f[k]) - Math.log10(f[k - 1]))) }
}
function digest(res) {
  return res.vectors.map((v) => {
    const a = v.values ?? v.re
    return [v.name, res.numPoints, a[0], a[Math.floor(a.length / 2)], a[a.length - 1]]
  })
}
const RF = { 'RF=10k': 10e3, 'RF=22k': 22e3, 'RF=47k': 47e3 }
const RIN = 1e3
const FC = 1 / (2 * Math.PI * 1.6e3 * 1e-9)

function checkFrontEndNumbers(state, results, rec) {
  let trans = 0, acs = 0
  state.runs.forEach((run, i) => {
    assert.equal(run.status, 'ok', `${run.label}: ${run.error}`)
    const theory = -RF[run.step] / RIN
    if (run.label.startsWith('TRAN')) {
      const gain = plateauGain(results[i], 'v(out)', 'v(in)', 200e-6)
      assert.ok(Math.abs(gain / theory - 1) < 0.01, `${run.label} gain ${gain} vs ${theory}`)
      if (rec) rec[run.label] = { gain, theory, errorPct: +(100 * Math.abs(gain / theory - 1)).toFixed(3) }
      trans++
    } else {
      const { corner, dc } = acCorner(results[i], 'v(adc)')
      assert.ok(Math.abs(corner / FC - 1) < 0.05, `${run.label} corner ${corner} vs ${FC}`)
      assert.ok(Math.abs(dc / Math.abs(theory) - 1) < 0.01, `${run.label} |gain| ${dc} vs ${-theory}`)
      if (rec) rec[run.label] = { cornerHz: corner, theoryHz: FC, errorPct: +(100 * Math.abs(corner / FC - 1)).toFixed(3) }
      acs++
    }
  })
  assert.equal(trans, 3)
  assert.equal(acs, 3)
}

// every part really painted: the canvas around its centre is not empty
const paintedAround = (page, x, y) => page.evaluate(([px, py]) => {
  const canvas = document.querySelector('.schematic-canvas')
  const ctx = canvas.getContext('2d')
  const p = window.circuitcraft.toScreen(px, py)
  const dpr = devicePixelRatio
  const data = ctx.getImageData(p.x * dpr - 22 * dpr, p.y * dpr - 22 * dpr, 44 * dpr, 44 * dpr).data
  let bright = 0
  for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) > 110) bright++
  return bright
}, [x, y])

const EXPECTED_NODES = {
  VCC: ['VCC', '0'], VEE: ['VEE', '0'], VIN: ['IN', '0'], XD1: ['IN', 'VCC'], XD2: ['VEE', 'IN'],
  R1: ['IN', 'INV'], R2: ['INV', 'OUT'], X1: ['0', 'INV', 'OUT', 'VCC', 'VEE'], R3: ['OUT', 'ADC'], C1: ['ADC', '0'], RADC: ['ADC', '0'],
}

// ---------- tests ----------

test('opens the fixture with its libraries: every element drawn, wired as the netlist says', async () => {
  const page = await newPage()
  const state = await openFixture(page, 'hs200_frontend.cir', HS200_LIBS)
  assert.deepEqual(state.elements.map((e) => e.ref).sort(), Object.keys(EXPECTED_NODES).sort())
  assert.deepEqual(state.unsupported, [])
  assert.deepEqual(state.labelledNets, [], 'no net had to fall back to labels')
  assert.deepEqual(state.runs.map((r) => r.label), ['TRAN RF=10k', 'AC RF=10k', 'TRAN RF=22k', 'AC RF=22k', 'TRAN RF=47k', 'AC RF=47k'])
  // the translator's warning is on the page, in Korean
  const notice = await page.locator('.notice.warn').first().textContent()
  assert.match(notice, /LIMIT/)
  assert.match(notice, /부드럽게/)

  const sheet = await page.evaluate(() => window.circuitcraft.getSchematic())
  for (const ref of Object.keys(EXPECTED_NODES)) {
    const comp = sheet.components.find((c) => c.attributes.InstName === ref)
    assert.ok(comp, `${ref} is on the sheet`)
    const bright = await paintedAround(page, comp.x, comp.y)
    assert.ok(bright > 30, `${ref} is painted (${bright} bright pixels)`)
  }
  const x1 = sheet.components.find((c) => c.attributes.InstName === 'X1')
  assert.equal(x1.type, 'generic')
  assert.deepEqual(x1.pins.map((p) => p.name), ['IN+', 'IN-', 'OUT', 'VCC', 'VEE'], 'the box has the subcircuit pin names')

  // the drawing, read back through its wires, is the netlist
  const written = await page.evaluate(() => window.circuitcraft.getWritten())
  const nodes = Object.fromEntries(written.map((w) => [w.ref, w.nodes]))
  assert.deepEqual(nodes, EXPECTED_NODES)

  // only what is used comes out of the library
  const translation = await page.evaluate(() => window.circuitcraft.docTranslation())
  for (const run of translation.runs) {
    assert.match(run.netlist, /\.SUBCKT HS200 IN_P IN_N/)
    assert.doesNotMatch(run.netlist, /BROKEN/)
  }
  await page.screenshot({ path: path.join(SHOTS, 'hs200-opened.png') })
  assert.deepEqual(page.problems, [])
  await page.context().close()
})

test('runs every run; gains and corner match theory; AC plots dB and phase on a log axis', async () => {
  const page = await newPage()
  await openFixture(page, 'hs200_frontend.cir', HS200_LIBS)
  const t0 = Date.now()
  const state = await runAll(page)
  numbers.runAllMs = Date.now() - t0
  const results = []
  for (let i = 0; i < state.runs.length; i++) results.push(await result(page, i))
  const rec = (numbers.frontEnd = {})
  checkFrontEndNumbers(state, results, rec)

  // .PROBE V(IN) V(OUT) V(ADC) picks the first plot
  assert.deepEqual([...state.selectedVectors].sort(), ['v(adc)', 'v(in)', 'v(out)'])
  await page.waitForTimeout(300)
  let plot = await page.evaluate(() => window.circuitcraft.getPlot())
  assert.equal(plot.xAxisType, 'time')
  assert.equal(plot.yLabel, 'Voltage (V)')
  await page.screenshot({ path: path.join(SHOTS, 'hs200-transient.png') })

  // the person picks AC, then a .STEP value, then a vector
  await page.getByRole('button', { name: 'AC', exact: true }).click()
  await page.getByRole('button', { name: /RF=22k/ }).click()
  let s = await page.evaluate(() => window.circuitcraft.getState())
  assert.equal(s.runs[s.selectedRun].label, 'AC RF=22k')
  plot = await page.evaluate(() => window.circuitcraft.getPlot())
  assert.equal(plot.xAxisType, 'frequency')
  assert.equal(plot.yLabel, 'Magnitude (dB)')
  assert.equal(plot.xLabel, 'Frequency (Hz)')
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(SHOTS, 'hs200-bode.png') })
  await page.getByRole('button', { name: 'Phase', exact: true }).click()
  plot = await page.evaluate(() => window.circuitcraft.getPlot())
  assert.equal(plot.yLabel, 'Phase (deg)')

  await page.locator('details.vectors summary').click()
  await page.locator('label.vector-item', { hasText: 'V(IN)' }).locator('input').uncheck()
  s = await page.evaluate(() => window.circuitcraft.getState())
  assert.ok(!s.selectedVectors.includes('v(in)'))
  plot = await page.evaluate(() => window.circuitcraft.getPlot())
  assert.equal(plot.traces.length, 2)
  await page.locator('details.vectors summary').click()

  // all steps together
  await page.getByRole('button', { name: 'All', exact: true }).click()
  plot = await page.evaluate(() => window.circuitcraft.getPlot())
  assert.equal(plot.traces.length, 6)
  assert.deepEqual(page.problems, [])
  await page.context().close()
})

test('a fatal netlist shows the error, and the next run works on a new engine', async () => {
  const page = await newPage()
  await openFixture(page, 'hs200_frontend.cir', HS200_LIBS)
  const before1 = await runAll(page)
  const res0 = await result(page, 0)
  const recoveriesBefore = before1.recoveries

  const fatal = '* broken expression\nV1 A 0 DC 1\nE1 B 0 VALUE={LIMIT(V(A),\nR1 B 0 1k\n.TRAN 1u 1m\n.END\n'
  await openText(page, 'fatal.cir', fatal)
  await page.evaluate(() => window.circuitcraft.setRunTimeout(45000))
  const t0 = Date.now()
  const failed = await runAll(page)
  numbers.fatalDetectedMs = Date.now() - t0
  assert.equal(failed.runs[0].status, 'failed')
  assert.match(failed.lastError, /limit|parse|syntax/i)
  assert.ok(failed.recoveries > recoveriesBefore, 'the worker was replaced')
  assert.ok(numbers.fatalDetectedMs < 20000, `recognised without waiting for the timeout (${numbers.fatalDetectedMs} ms)`)
  // the person can read it
  const shown = await page.locator('.notice.error').first().textContent()
  assert.match(shown, /limit|parse|syntax/i)
  assert.match(await page.locator('.run-error').textContent(), /limit|parse|syntax/i)
  await page.screenshot({ path: path.join(SHOTS, 'fatal-error.png') })

  // the same document that worked before gives the same numbers
  await openFixture(page, 'hs200_frontend.cir', HS200_LIBS)
  const again = await runAll(page)
  assert.equal(again.lastError, null)
  assert.ok(again.runs.every((r) => r.status === 'ok'))
  const res1 = await result(page, 0)
  assert.deepEqual(digest(res1), digest(res0))
  assert.deepEqual(page.problems, [])
  await page.context().close()
})

test('a run that fails after a good one does not show the good one\'s numbers', async () => {
  const page = await newPage()
  await openText(page, 'rc.cir', '* rc\nV1 A 0 PULSE(0 1 0 1n 1n 1m 2m)\nR1 A B 1k\nC1 B 0 1u\n.TRAN 10u 2m\n.END\n')
  let s = await runAll(page)
  assert.equal(s.runs[0].status, 'ok')
  // the translator lets these through and ngspice answers without dying, with no data or with a
  // line it "ignores": a wrong number of subcircuit pins, a model of an unknown kind, a line short of a node
  for (const [name, text] of [
    ['pins.cir', '* t\nV1 A 0 1\nX1 A 0 B S\n.SUBCKT S P Q\nR1 P Q 1k\n.ENDS\n.TRAN 10u 2m\n.END\n'],
    ['kind.cir', '* t\nV1 A 0 1\nD1 A 0 DX\n.MODEL DX NOSUCH(IS=1)\n.TRAN 10u 2m\n.END\n'],
    ['badline.cir', '* t\nV1 A 0 1\nR1 A\n.TRAN 10u 2m\n.END\n'],
  ]) {
    await openText(page, name, text)
    s = await runAll(page)
    assert.equal(s.runs[0].status, 'failed', `${name}: ${JSON.stringify(s.runs[0])}`)
    assert.equal(s.runs[0].numPoints, 0, `${name} kept no data`)
    assert.ok(s.lastError, name)
  }
  await page.context().close()
})

test('a run that hangs is stopped by the timeout; the page stays responsive; the Stop button works', async () => {
  const page = await newPage()
  const heavy = '* heavy\nV1 A 0 SIN(0 1 1G)\nR1 A B 1k\nC1 B 0 1p\n.TRAN 1p 10\n.END\n'
  await openText(page, 'heavy.cir', heavy)
  await page.evaluate(() => {
    window.__gaps = []
    let last = performance.now()
    window.__tick = setInterval(() => { const n = performance.now(); window.__gaps.push(n - last); last = n }, 20)
    window.circuitcraft.setRunTimeout(2500)
  })
  const t0 = Date.now()
  const s = await runAll(page)
  numbers.timeoutMs = Date.now() - t0
  const maxGap = await page.evaluate(() => { clearInterval(window.__tick); return Math.max(...window.__gaps) })
  numbers.maxMainThreadGapMs = Math.round(maxGap)
  assert.equal(s.runs[0].status, 'failed')
  assert.match(s.runs[0].error, /No answer after 2\.5 s/)
  assert.ok(numbers.timeoutMs < 8000, `gave up in time (${numbers.timeoutMs} ms)`)
  assert.ok(maxGap < 400, `the page kept running (longest gap ${maxGap} ms)`)

  // the same heavy run, stopped by hand
  await page.evaluate(() => { window.circuitcraft.setRunTimeout(60000); window.__running = window.circuitcraft.runAll() })
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.waitForFunction(() => !window.circuitcraft.getState().busy)
  const after1 = await page.evaluate(() => window.circuitcraft.getState())
  assert.notEqual(after1.runs[0].status, 'ok')

  await openFixture(page, 'hs200_frontend.cir', HS200_LIBS)
  const good = await runAll(page)
  assert.ok(good.runs.every((r) => r.status === 'ok'), JSON.stringify(good.runs.map((r) => [r.label, r.status, r.error])))
  await page.context().close()
})

test('save keeps the document as it came; value edits go back in; reopening gives the same numbers', async () => {
  const page = await newPage(URL_APP)
  // not in host mode: the landing page first, then the file picker with the libraries beside the circuit
  await page.waitForSelector('.landing-page')
  await page.setInputFiles('#cc-file-input', ['hs200_frontend.cir', 'hs200.lib', '1N4148.lib'].map((f) => path.join(FIX, f)))
  await page.waitForFunction(() => window.circuitcraft.getState().elements.length === 11)
  assert.equal(await page.locator('.landing-page').count(), 0)
  let state = await runAll(page)
  const before2 = []
  for (let i = 0; i < state.runs.length; i++) before2.push(await result(page, i))

  // Save with nothing edited: byte for byte the file that was opened, through a real download
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save .cir' }).click()])
  assert.equal(dl.suggestedFilename(), 'hs200_frontend.cir')
  const saved = fs.readFileSync(await dl.path())
  assert.deepEqual([...saved], fixture('hs200_frontend.cir'))
  numbers.savedBytesIdentical = saved.length

  // CSV of what is on screen
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()])
  assert.match(csvDl.suggestedFilename(), /hs200_frontend_TRAN_RF=10k\.csv/)
  const csv = fs.readFileSync(await csvDl.path(), 'utf8').trim().split('\n')
  assert.equal(csv[0], 'time,V(IN),V(OUT),V(ADC)')
  assert.equal(csv.length - 1, state.runs[0].numPoints)
  const row = csv[Math.floor(csv.length / 2)].split(',').map(Number)
  const res0 = before2[0]
  const mid = res0.vectors[0].values.findIndex((t) => t === row[0])
  assert.ok(mid >= 0)
  assert.equal(row[2], vector(res0, 'v(out)').values[mid])

  // Reopen what was saved: same numbers
  await page.evaluate(([bytes, libs]) => window.circuitcraft.openFile('copy.cir', new Uint8Array(bytes), libs.map((l) => ({ name: l.name, bytes: new Uint8Array(l.bytes) }))),
    [[...saved], HS200_LIBS.map((n) => ({ name: n, bytes: fixture(n) }))])
  state = await runAll(page)
  for (let i = 0; i < state.runs.length; i++) assert.deepEqual(digest(await result(page, i)), digest(before2[i]), state.runs[i].label)

  // Edit a value on the schematic: double-click the part, type, save
  const sheet = await page.evaluate(() => window.circuitcraft.getSchematic())
  const r3 = sheet.components.find((c) => c.attributes.InstName === 'R3')
  const at = await page.evaluate(([x, y]) => window.circuitcraft.toScreen(x, y), [r3.x, r3.y])
  const box = await page.locator('.schematic-canvas').boundingBox()
  await page.mouse.dblclick(box.x + at.x, box.y + at.y)
  await page.locator('#comp-value').fill('3.2k')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => window.circuitcraft.getState().text.includes('R3 OUT ADC 3.2k'))
  const edited = await page.evaluate(() => window.circuitcraft.getState().text)
  const a = fixtureText('hs200_frontend.cir').split('\n')
  const b = edited.split('\n')
  assert.equal(a.length, b.length)
  const changed = a.filter((l, i) => l !== b[i])
  assert.deepEqual(changed, ['R3 OUT ADC {RAA}'], 'only that line changed, comments and order stay')

  // It simulates as edited, and survives a save and reopen
  state = await runAll(page)
  const fc2 = FC / 2
  const c2 = acCorner(await result(page, 1), 'v(adc)').corner
  numbers.editedCorner = { cornerHz: c2, theoryHz: fc2 }
  assert.ok(Math.abs(c2 / fc2 - 1) < 0.05, `corner after edit ${c2} vs ${fc2}`)
  const digestEdited = digest(await result(page, 1))
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save .cir' }).click()])
  const saved2 = fs.readFileSync(await dl2.path())
  await page.evaluate(([bytes, libs]) => window.circuitcraft.openFile('copy2.cir', new Uint8Array(bytes), libs.map((l) => ({ name: l.name, bytes: new Uint8Array(l.bytes) }))),
    [[...saved2], HS200_LIBS.map((n) => ({ name: n, bytes: fixture(n) }))])
  await runAll(page)
  assert.deepEqual(digest(await result(page, 1)), digestEdited)
  assert.deepEqual(page.problems, [])
  await page.context().close()
})

test('Windows line ends and old code pages survive the round trip', async () => {
  const page = await newPage()
  // EUC-KR comments ("* 회로", "; 부하"), CRLF line ends
  const korean = [
    0x2a, 0x20, 0xc8, 0xb8, 0xb7, 0xce, 0x0d, 0x0a,
    ...Buffer.from('V1 A 0 DC 1\r\nR1 A B 1k ; ', 'ascii'), 0xba, 0xce, 0xc7, 0xcf, 0x0d, 0x0a,
    ...Buffer.from('R2 B 0 1k\r\n.OP\r\n.END\r\n', 'ascii'),
  ]
  const state = await page.evaluate((b) => window.circuitcraft.openFile('win.cir', new Uint8Array(b)), korean)
  assert.equal(state.elements.length, 3)
  await page.waitForTimeout(600)
  assert.equal(await page.evaluate(() => window.circuitcraft.getState().dirty), false, 'opening is not an edit')
  assert.deepEqual(await page.evaluate(() => window.circuitcraft.getBytes()), korean)
  const text = await page.evaluate(() => window.circuitcraft.getState().text)
  assert.match(text, /^\* 회로\r\n/)
  assert.match(text, /; 부하\r\n/)
  await page.evaluate(() => window.circuitcraft.editValue('R2', '2k'))
  const out = Buffer.from(await page.evaluate(() => window.circuitcraft.getBytes()))
  const lines = []
  for (let i = 0, start = 0; i < out.length; i++) if (out[i] === 0x0a) { lines.push(out.subarray(start, i)); start = i + 1 }
  assert.equal(lines[3].toString('ascii'), 'R2 B 0 2k\r')
  assert.deepEqual([...lines[2].subarray(-5)], [0xba, 0xce, 0xc7, 0xcf, 0x0d], 'a line that was not edited keeps its comment bytes')
  assert.deepEqual([...out.subarray(0, 8)], korean.slice(0, 8))

  // bytes that are neither UTF-8 nor EUC-KR (micro sign, the windows-1252 euro): still byte for byte
  const western = [0x2a, 0x20, 0xb5, 0x46, 0x20, 0x80, 0x20, 0x0a, ...Buffer.from('V1 A 0 DC 1\nR1 A 0 1k\n.OP\n.END\n', 'ascii')]
  await page.evaluate((b) => window.circuitcraft.openFile('west.cir', new Uint8Array(b)), western)
  assert.deepEqual(await page.evaluate(() => window.circuitcraft.getBytes()), western)
  await page.context().close()
})

test('host bridge: ready, open, dirty, Ctrl+S save, no landing page, other origins ignored', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${PORT}/host.html`)
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'circuitcraft:ready'))
  const frame = page.frames().find((f) => f.url().includes('host=parent'))
  assert.equal(await frame.locator('.landing-page').count(), 0, 'host mode skips the landing page')

  await page.evaluate(([bytes, files]) => window.sendOpen('hs200_frontend.cir', bytes, files),
    [fixture('hs200_frontend.cir'), HS200_LIBS.map((n) => ({ name: n, bytes: fixture(n) }))])
  await frame.waitForFunction(() => window.circuitcraft.getState().elements.length === 11)
  const state = await frame.evaluate(() => window.circuitcraft.runAll())
  const results = []
  for (let i = 0; i < state.runs.length; i++) results.push(await frame.evaluate((k) => window.circuitcraft.getResult(k), i))
  checkFrontEndNumbers(state, results)

  // Ctrl+S with the focus in the frame
  await frame.locator('.schematic-canvas').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'circuitcraft:save'))
  let saves = await page.evaluate(() => window.msgs.filter((m) => m.type === 'circuitcraft:save').map((m) => ({ name: m.name, bytes: [...new Uint8Array(m.bytes)] })))
  assert.equal(saves[0].name, 'hs200_frontend.cir')
  assert.deepEqual(saves[0].bytes, fixture('hs200_frontend.cir'))

  // an edit says dirty, a save says clean, and the saved bytes hold the edit
  await frame.evaluate(() => window.circuitcraft.editValue('R3', '3.2k'))
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'circuitcraft:dirty' && m.dirty === true))
  await page.keyboard.press('Meta+s')
  await page.waitForFunction(() => window.msgs.filter((m) => m.type === 'circuitcraft:save').length === 2)
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'circuitcraft:dirty' && m.dirty === false))
  saves = await page.evaluate(() => window.msgs.filter((m) => m.type === 'circuitcraft:save').map((m) => ({ name: m.name, bytes: [...new Uint8Array(m.bytes)] })))
  assert.match(Buffer.from(saves[1].bytes).toString(), /^R3 OUT ADC 3\.2k$/m)

  // what the host stored opens again through the host, with the same numbers
  await frame.evaluate(() => window.circuitcraft.runAll())
  const edited = await frame.evaluate(() => window.circuitcraft.getResult(1))
  await page.evaluate(([bytes, files]) => window.sendOpen('hs200_frontend.cir', bytes, files),
    [saves[1].bytes, HS200_LIBS.map((n) => ({ name: n, bytes: fixture(n) }))])
  await frame.waitForFunction(() => window.circuitcraft.getState().text.includes('3.2k') && !window.circuitcraft.getState().dirty)
  await frame.evaluate(() => window.circuitcraft.runAll())
  assert.deepEqual(digest(await frame.evaluate(() => window.circuitcraft.getResult(1))), digest(edited))

  // CSV in host mode comes back to the host, not as a stray download
  await frame.locator('button', { hasText: 'Export CSV' }).click()
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'circuitcraft:save' && /\.csv$/.test(m.name)))
  await context.close()

  // a page on another origin gets nothing, and cannot open files
  const other = await browser.newContext()
  const p2 = await other.newPage()
  await p2.goto(`http://localhost:${PORT}/host.html`)
  const frame2 = p2.frames().find((f) => f.url().includes('host=parent')) ?? (await p2.waitForEvent('frameattached'))
  await frame2.waitForFunction(() => !!window.circuitcraft)
  await p2.waitForTimeout(300)
  assert.equal((await p2.evaluate(() => window.msgs.length)), 0)
  await p2.evaluate(([bytes]) => window.sendOpen('x.cir', bytes, []), [fixture('hs200_frontend.cir')])
  await p2.waitForTimeout(500)
  assert.equal(await frame2.evaluate(() => window.circuitcraft.getState().elements.length), 0)
  await other.close()
})

test('a schematic drawn from scratch saves as a .cir that reopens with the same numbers', async () => {
  const page = await newPage(URL_APP)
  await page.getByRole('button', { name: 'New Project' }).click()
  await page.keyboard.press('Escape')
  const close = page.locator('button[aria-label="Close help"]')
  if (await close.count()) await close.click()
  const canvas = page.locator('.schematic-canvas')
  await canvas.waitFor()
  const box = await canvas.boundingBox()
  const at = async (x, y) => {
    const p = await page.evaluate(([a, b]) => window.circuitcraft.toScreen(a, b), [x, y])
    return { x: box.x + p.x, y: box.y + p.y }
  }
  const moveTo = async (x, y) => { const p = await at(x, y); await page.mouse.move(p.x, p.y); return p }
  const click = async (x, y) => { const p = await moveTo(x, y); await page.mouse.click(p.x, p.y) }
  await click(150, 100) // focus the canvas
  const place = async (key, x, y) => { await page.keyboard.press(key); await moveTo(x, y); await click(x, y); await page.keyboard.press('Escape') }
  const wire = async (...pts) => {
    await page.keyboard.press('3')
    for (const [x, y] of pts) await click(x, y)
    await page.keyboard.press('Escape')
  }
  // V1 and an RC ladder, placed with the keyboard shortcuts and the mouse, the way a person draws it
  await place('v', -100, 0)    // pins (-100,-40) (-100,40)
  await place('r', 0, -70)     // pins (0,-100) (0,-40)
  await place('c', 0, 10)      // pins (0,-20) (0,40)
  await place('g', -100, 50)   // pin (-100,40)
  await place('g', 0, 50)      // pin (0,40)
  await wire([-100, -40], [-100, -100], [0, -100])
  await wire([0, -40], [0, -20])

  // a double-click on R1 sets its value in the dialog
  const r1 = await at(0, -70)
  await page.mouse.dblclick(r1.x, r1.y)
  await page.locator('#comp-value').fill('2k')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.evaluate(() => window.circuitcraft.editValue('V1', 'PULSE(0 5 0 1n 1n 5m 10m)'))

  let state = await page.evaluate(() => window.circuitcraft.getState())
  assert.deepEqual(state.elements.map((e) => e.ref).sort(), ['C1', 'R1', 'V1'])
  assert.match(state.text, /^R1 \S+ \S+ 2k$/m)
  state = await runAll(page)
  assert.equal(state.runs[0].status, 'ok', state.lastError)
  const res = await result(page, 0)
  // RC = 2k x 1u = 2 ms: 63.2% of 5 V after 2 ms
  const out = res.vectors.find((v) => v.type === 'voltage' && /^v\(/.test(v.name) && v.values[0] < 0.01 && v.values.at(-1) > 1 && v.name !== 'v(n1)')
  const series = state.elements.find((e) => e.ref === 'C1').nodes[0]
  const vOut = vector(res, `v(${series.toLowerCase()})`)
  const i2ms = res.vectors[0].values.findIndex((t) => t >= 2e-3)
  numbers.scratchRC = { at2ms: vOut.values[i2ms], theory: 5 * (1 - Math.exp(-1)) }
  assert.ok(Math.abs(vOut.values[i2ms] / (5 * (1 - Math.exp(-1))) - 1) < 0.02, `V(C) at 2 ms = ${vOut.values[i2ms]}`)
  await page.screenshot({ path: path.join(SHOTS, 'scratch-drawn.png') })
  assert.ok(out || vOut)

  // Saved through a real download, opened again (a new layout, the same circuit)
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save .cir' }).click()])
  assert.equal(dl.suggestedFilename(), 'untitled.cir')
  const saved = fs.readFileSync(await dl.path())
  const reopened = await page.evaluate((b) => window.circuitcraft.openFile('untitled.cir', new Uint8Array(b)), [...saved])
  assert.deepEqual(reopened.elements.map((e) => e.ref).sort(), ['C1', 'R1', 'V1'])
  await runAll(page)
  assert.deepEqual(digest(await result(page, 0)), digest(res))
  // and unedited, that document is untouched
  assert.deepEqual(Buffer.from(await page.evaluate(() => window.circuitcraft.getBytes())), saved)
  assert.deepEqual(page.problems, [])
  await page.context().close()
})

test('devices without a symbol are labelled boxes with named pins, wired right, and they simulate', async () => {
  const page = await newPage()
  const state = await openFixture(page, 'all_devices.cir', ['hs200.lib'])
  const by = Object.fromEntries(state.elements.map((e) => [e.ref, e]))
  const boxes = {
    EAMP: ['N+', 'N-', 'NC+', 'NC-'], GAMP: ['N+', 'N-', 'NC+', 'NC-'], FMIR: ['N+', 'N-'], HZ: ['N+', 'N-'], EVAL: ['N+', 'N-'], BLOG: ['N+', 'N-'],
    S1: ['N+', 'N-', 'C+', 'C-'], W1: ['N+', 'N-'], T1: ['A+', 'A-', 'B+', 'B-'], J1: ['D', 'G', 'S'], Q2: ['C', 'B', 'E', 'S'], M2: ['D', 'G', 'S', 'B'],
    X1: ['IN+', 'IN-', 'OUT', 'VCC', 'VEE'], K1: [],
  }
  for (const [ref, pins] of Object.entries(boxes)) {
    assert.equal(by[ref]?.symbol, 'generic', ref)
    assert.deepEqual(by[ref].pins, pins, ref)
  }
  assert.equal(by.Q1.symbol, 'npn')
  assert.equal(by.M1.symbol, 'nmos', 'bulk tied to source: the symbol is enough')
  assert.equal(by.D1.symbol, 'diode')
  // F, H and W have two nodes; the rest of the line is their control
  assert.deepEqual(by.FMIR.nodes, ['0', 'F1'])
  assert.equal(by.FMIR.value, 'VSENSE 2')
  assert.deepEqual(by.W1.nodes, ['IN', 'W1O'])
  assert.equal(by.W1.value, 'VSENSE SWI')

  // nothing was dropped and the wiring reads back as the document says
  const written = await page.evaluate(() => window.circuitcraft.getWritten())
  assert.equal(written.length, state.elements.length)
  for (const w of written) {
    const e = by[w.ref]
    const nodes = e.symbol === 'nmos' ? [...e.nodes, e.nodes[2]] : e.nodes
    assert.deepEqual(w.nodes, nodes, w.ref)
  }
  // ... so saving changes nothing
  assert.deepEqual(await page.evaluate(() => window.circuitcraft.getBytes()), fixture('all_devices.cir'))

  const done = await runAll(page)
  assert.deepEqual(done.runs.map((r) => [r.label, r.status]), [['TRAN', 'ok'], ['OP', 'ok']], done.lastError)
  // the .OP run is a table: V1 = 2*V(A)+1
  await page.evaluate(() => window.circuitcraft.selectRun(1))
  assert.ok(await page.locator('.op-table').isVisible())
  const op = await result(page, 1)
  const va = vector(op, 'v(a)').values[0]
  assert.ok(Math.abs(vector(op, 'v(v1)').values[0] - (2 * va + 1)) < 1e-6)
  assert.ok(Math.abs(vector(op, 'v(e1)').values[0] - 2 * va) < 1e-6)
  numbers.allDevicesLabelledNets = done.labelledNets
  await page.screenshot({ path: path.join(SHOTS, 'all-devices.png') })
  await page.context().close()
})

test('what cannot be simulated says so: unsupported items, a library, a missing library', async () => {
  const page = await newPage()
  const text = '* laplace\nV1 A 0 AC 1\nE1 B 0 LAPLACE {V(A)} = {1/(1+s)}\nR1 B 0 1k\n.AC DEC 5 1 1k\n.END\n'
  let state = await openText(page, 'laplace.cir', text)
  assert.ok(state.unsupported.length > 0)
  assert.match(state.blockedReason, /Cannot run/)
  assert.match(await page.locator('.run-reason').textContent(), /LAPLACE/)
  assert.match(await page.locator('.notice.error').first().textContent(), /LAPLACE/)
  assert.ok(state.elements.some((e) => e.ref === 'E1'), 'still drawn')
  await page.screenshot({ path: path.join(SHOTS, 'unsupported.png') })
  state = await runAll(page)
  assert.ok(state.runs.every((r) => r.status === 'idle'), 'nothing was run')
  assert.match(state.lastError, /Cannot run/)

  // A library on its own: read, drawn, not run, saved as it came
  state = await openFixture(page, 'hs200.lib')
  assert.equal(state.isLibrary, true)
  assert.deepEqual(state.libraryParts, ['HS200', 'HS200_BROKEN'])
  assert.deepEqual(state.elements.map((e) => e.ref), ['RIN', 'CIN', 'GM', 'RP', 'CP', 'EOUT', 'RO', 'IQ'])
  assert.match(state.blockedReason, /library/)
  assert.deepEqual(await page.evaluate(() => window.circuitcraft.getBytes()), fixture('hs200.lib'))
  await page.screenshot({ path: path.join(SHOTS, 'library.png') })

  // A vendor library with its .MODEL on line one keeps it
  state = await openFixture(page, '1N4148.lib')
  assert.equal(state.isLibrary, true)
  assert.deepEqual(state.libraryParts, ['1N4148'])

  // A circuit whose library was not handed over: told what is missing, and adding it fixes it
  state = await openFixture(page, 'hs200_frontend.cir')
  assert.ok(state.warnings.some((w) => /hs200\.lib/.test(w)))
  assert.ok(state.unsupported.some((u) => /HS200/.test(u)), 'the part is named')
  assert.match(await page.locator('.notices').textContent(), /HS200/)
  state = await runAll(page)
  assert.ok(state.runs.every((r) => r.status !== 'ok'), 'nothing ran')
  await page.setInputFiles('#cc-file-input', HS200_LIBS.map((f) => path.join(FIX, f)))
  await page.waitForFunction(() => window.circuitcraft.getState().warnings.every((w) => !/hs200\.lib/.test(w)))
  state = await runAll(page)
  assert.ok(state.runs.every((r) => r.status === 'ok'), state.lastError)
  await page.context().close()
})

test('drag and drop, .INC sub-sheets, and typing in the netlist', async () => {
  const page = await newPage()
  // drop the circuit with its include file
  await page.evaluate(([main, inc]) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(main)], 'sheet_main.cir'))
    dt.items.add(new File([new Uint8Array(inc)], 'sheet_stage.inc'))
    const app = document.querySelector('.app')
    app.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    app.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, [fixture('sheet_main.cir'), fixture('sheet_stage.inc')])
  await page.waitForFunction(() => window.circuitcraft.getState().name === 'sheet_main.cir' && window.circuitcraft.getState().elements.length === 3)
  let state = await page.evaluate(() => window.circuitcraft.getState())
  assert.equal(state.elements.find((e) => e.ref === 'R2').external, 'sheet_stage.inc')
  state = await runAll(page)
  assert.equal(state.runs[0].status, 'ok', state.lastError)
  assert.ok(Math.abs(vector(await result(page, 0), 'v(mid)').values[0] - 1) < 1e-9, 'the divider includes R2 from the include file')
  // saving leaves the include line alone and does not pull R2 into the document
  assert.deepEqual(await page.evaluate(() => window.circuitcraft.getBytes()), fixture('sheet_main.cir'))

  // typing a value: the part keeps its place; typing a new element: it appears
  await openText(page, 'typed.cir', '* typed\nV1 A 0 DC 2\nR1 A B 1k\nR2 B 0 1k\n.OP\n.END\n')
  const placeBefore = await page.evaluate(() => window.circuitcraft.getSchematic().components.find((c) => c.attributes.InstName === 'R1'))
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Meta+a')
  await page.keyboard.insertText('* typed\nV1 A 0 DC 2\nR1 A B 3k\nR2 B 0 1k\n.OP\n.END\n')
  await page.waitForFunction(() => window.circuitcraft.getSchematic().components.find((c) => c.attributes.InstName === 'R1')?.attributes.Value === '3k')
  const placeAfter = await page.evaluate(() => window.circuitcraft.getSchematic().components.find((c) => c.attributes.InstName === 'R1'))
  assert.deepEqual([placeAfter.x, placeAfter.y], [placeBefore.x, placeBefore.y])
  state = await runAll(page)
  assert.ok(Math.abs(vector(await result(page, 0), 'v(b)').values[0] - 0.5) < 1e-9, 'typed value simulated')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Meta+a')
  await page.keyboard.insertText('* typed\nV1 A 0 DC 2\nR1 A B 3k\nR2 B 0 1k\nR3 B 0 1k\n.OP\n.END\n')
  await page.waitForFunction(() => window.circuitcraft.getState().elements.some((e) => e.ref === 'R3'))
  await page.context().close()
})

test('the fork still does its own job: a JSON example runs through the same PSpice path', async () => {
  const page = await newPage(URL_APP)
  await page.locator('.example-card', { hasText: 'RC Low-Pass Filter (AC)' }).click()
  await page.waitForFunction(() => window.circuitcraft.getState().elements.length >= 3)
  const state = await runAll(page)
  assert.equal(state.runs[0].status, 'ok', state.lastError)
  assert.match(state.text, /\.ac dec 1000 10 10k/i)
  const res = await result(page, 0)
  const out = res.vectors.find((v) => /^v\(/.test(v.name) && Math.hypot(v.re.at(-1), v.im.at(-1)) < 0.5)
  const { corner } = acCorner(res, out.name)
  numbers.jsonExampleCornerHz = corner
  assert.ok(Math.abs(corner / 159.15 - 1) < 0.05, `corner ${corner}`)
  await page.context().close()
})

test('editing an opened circuit on the sheet: delete, add, rewire; the text follows, the rest stays', async () => {
  const page = await newPage()
  await openFixture(page, 'hs200_frontend.cir', HS200_LIBS)
  const canvas = await page.locator('.schematic-canvas').boundingBox()
  const at = async (x, y) => { const p = await page.evaluate(([a, b]) => window.circuitcraft.toScreen(a, b), [x, y]); return { x: canvas.x + p.x, y: canvas.y + p.y } }
  const click = async (x, y) => { const p = await at(x, y); await page.mouse.move(p.x, p.y); await page.mouse.click(p.x, p.y) }
  const comp = (ref) => page.evaluate((r) => window.circuitcraft.getSchematic().components.find((c) => c.attributes.InstName === r), ref)
  const original = fixtureText('hs200_frontend.cir').split('\n')

  // delete RADC in delete mode: its line goes, nothing else moves
  const radc = await comp('RADC')
  await click(radc.x, radc.y)
  await page.keyboard.press('5')
  await click(radc.x, radc.y)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !window.circuitcraft.getState().text.includes('RADC'))
  let text = await page.evaluate(() => window.circuitcraft.getState().text)
  assert.deepEqual(text.split('\n'), original.filter((l) => !l.startsWith('RADC')))

  // put a new resistor down on the free space, touching the ADC net's C1 pin through a wire
  const sheet = await page.evaluate(() => window.circuitcraft.getSchematic())
  const c1 = sheet.components.find((c) => c.attributes.InstName === 'C1')
  const maxX = Math.max(...sheet.components.map((c) => c.x))
  const nx = Math.ceil((maxX + 100) / 10) * 10
  const ny = c1.y
  await page.keyboard.press('r')
  await click(nx, ny)
  await page.keyboard.press('Escape')
  await page.keyboard.press('g')
  await click(nx, ny + 40)
  await page.keyboard.press('Escape')
  // pin 1 of the new R is at (nx, ny-30); C1's upper pin at (c1.x, c1.y-30)
  await page.keyboard.press('3')
  await click(nx, ny - 30)
  await click(c1.x, c1.y - 30)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => /^R\d+ ADC 0 1k$/m.test(window.circuitcraft.getState().text))
  text = await page.evaluate(() => window.circuitcraft.getState().text)
  const newLine = text.split('\n').find((l) => /^R\d+ ADC 0 1k$/.test(l))
  assert.ok(newLine)
  assert.match(newLine, /^R(?!1 |2 |3 )/, 'a free number, not one of the document\'s')
  assert.deepEqual(text.split('\n').filter((l) => l !== newLine), original.filter((l) => !l.startsWith('RADC')), 'the rest of the document is untouched')
  let state = await runAll(page)
  assert.ok(state.runs.every((r) => r.status === 'ok'), state.lastError)
  // a 1k load on the filter divides the stage's output: 1k/(1k+1.6k)
  const gain = plateauGain(await result(page, 0), 'v(adc)', 'v(in)', 200e-6)
  numbers.editedLoadGain = gain
  assert.ok(Math.abs(gain / (-10 * 1 / 2.6) - 1) < 0.01, `gain ${gain}`)

  // Directives dialog: a third analysis lands in the document and runs
  await page.getByRole('button', { name: 'Directives' }).click()
  await page.getByRole('button', { name: 'Simulation', exact: true }).click()
  const box = page.locator('textarea.sim-input')
  assert.match(await box.inputValue(), /\.TRAN[\s\S]*\.AC/)
  await box.fill(`${await box.inputValue()}\n.OP`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForFunction(() => window.circuitcraft.getState().runs.some((r) => r.label.startsWith('OP')))
  text = await page.evaluate(() => window.circuitcraft.getState().text)
  assert.match(text, /^\.OP$/m)
  assert.match(text, /^\.TRAN 0\.1u 300u 0 0\.2u$/m)
  assert.ok(text.indexOf('.OP') < text.indexOf('.END'))
  await page.context().close()
})

test('probing the sheet adds what was clicked to the plot', async () => {
  const page = await newPage()
  await openFixture(page, 'hs200_frontend.cir', HS200_LIBS)
  await runAll(page)
  const canvas = await page.locator('.schematic-canvas').boundingBox()
  const sheet = await page.evaluate(() => window.circuitcraft.getSchematic())
  const at = async (x, y) => { const p = await page.evaluate(([a, b]) => window.circuitcraft.toScreen(a, b), [x, y]); return { x: canvas.x + p.x, y: canvas.y + p.y } }
  await page.evaluate(() => window.circuitcraft.setVectors(['v(out)']))
  // a wire of the INV net: the net that carries V(INV)
  const conn = await page.evaluate(() => window.circuitcraft.getConnectivity())
  const r1 = sheet.components.find((c) => c.attributes.InstName === 'R1')
  const r2 = sheet.components.find((c) => c.attributes.InstName === 'R2')
  assert.equal(conn.find((c) => c.ref === 'R2' && c.pin === '1').net, 'INV')
  const onWire = sheet.wires.find((w) => w.y1 === w.y2 && w.y1 === r1.y && Math.min(w.x1, w.x2) >= r1.x + 30 && Math.max(w.x1, w.x2) <= r2.x - 30)
  assert.ok(onWire, 'a straight wire between R1 and R2')
  const pos = await at((onWire.x1 + onWire.x2) / 2, onWire.y1)
  await page.mouse.click(pos.x, pos.y) // focus
  await page.keyboard.press('p')
  await page.mouse.move(pos.x, pos.y)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForFunction(() => window.circuitcraft.getState().selectedVectors.includes('v(inv)'))
  // a click on a resistor gives its current, worked out from the step's own value of RF
  const r2p = await at(r2.x, r2.y)
  await page.mouse.move(r2p.x, r2p.y)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForFunction(() => window.circuitcraft.getState().selectedVectors.includes('i(r2)'))
  const plot = await page.evaluate(() => window.circuitcraft.getPlot())
  assert.ok(plot.traces.some((t) => t.name === 'I(R2)' && t.type === 'current'), JSON.stringify(plot.traces))
  await page.context().close()
})

test('nets the router cannot finish become net labels: still exact, still saved as they came', async () => {
  const page = await newPage()
  await page.evaluate(() => window.circuitcraft.setRouteBudget(-1))
  const state = await openFixture(page, 'hs200_frontend.cir', HS200_LIBS)
  assert.ok(state.labelledNets.length >= 4, `labelled: ${state.labelledNets}`)
  const sheet = await page.evaluate(() => window.circuitcraft.getSchematic())
  assert.ok(sheet.components.some((c) => c.type === 'netflag' && c.attributes.Value === 'INV'))
  const written = await page.evaluate(() => window.circuitcraft.getWritten())
  assert.deepEqual(Object.fromEntries(written.map((w) => [w.ref, w.nodes])), EXPECTED_NODES)
  assert.deepEqual(await page.evaluate(() => window.circuitcraft.getBytes()), fixture('hs200_frontend.cir'))
  await page.context().close()
})

test('a run asked for during an open waits for that open', async () => {
  const page = await newPage()
  const state = await page.evaluate(([bytes, libs]) => {
    window.circuitcraft.openFile('hs200_frontend.cir', new Uint8Array(bytes), libs.map((l) => ({ name: l.name, bytes: new Uint8Array(l.bytes) })))
    return window.circuitcraft.runAll()
  }, [fixture('hs200_frontend.cir'), HS200_LIBS.map((n) => ({ name: n, bytes: fixture(n) }))])
  assert.equal(state.name, 'hs200_frontend.cir')
  assert.deepEqual(state.runs.map((r) => r.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
  await page.context().close()
})

test('works under a proxy prefix, and from the gzipped engine the server route sends', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  const failedRequests = []
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(r.url()) })
  await page.goto(`http://127.0.0.1:${PORT}/proxy${APP}?host=parent`)
  await page.waitForFunction(() => !!window.circuitcraft)
  await openFixture(page, 'hs200_frontend.cir', HS200_LIBS)
  const state = await runAll(page)
  assert.ok(state.runs.every((r) => r.status === 'ok'), state.lastError)
  assert.deepEqual(failedRequests, [])
  await context.close()
})
