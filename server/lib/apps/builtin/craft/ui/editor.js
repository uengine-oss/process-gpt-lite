// The ArtCraft screen (an MCP App behind the sandbox proxy): the app's self-hosted web build in a frame of this
// screen's own origin, so the screen can reach into it the way the page used to (src/components/CraftEditorFrame.vue
// keeps the toolbar):
// - CADCraft has a postMessage bridge (?host=parent): cadcraft:ready → we send cadcraft:open{name, bytes};
//   SAVE comes back as cadcraft:save{name, bytes}; cadcraft:dirty{dirty}; cadcraft:failed{error}.
// - The others take the file through their page API (window.vectorcraft.openFile, window.filmcraft.importFiles)
//   or a file dropped on the canvas, and save as browser downloads, which we catch inside the frame (the blob behind
//   the download link) instead of letting them go.
// The page hands the file in (craft_file), gets saves and exports back as ui/download-file, hears the state as Lite's
// notification 'craft' ({state: open | dirty | failed}), and runs live requests on the app (craft_request, craft_snapshot).
import lite from '../../_runtime/lite.js'

const frame = document.getElementById('craft')

function drop(w, file) {
  const canvas = w.document.querySelector('canvas')
  const r = canvas.getBoundingClientRect()
  const dt = new w.DataTransfer()
  dt.items.add(file)
  for (const type of ['dragenter', 'dragover', 'drop']) {
    canvas.dispatchEvent(new w.DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.width / 2, clientY: r.height / 2 }))
  }
}
// query: how each app starts (empty, no demo); ready: the frame can take a file; open: hand it over
const APPS = {
  cadcraft: { query: () => '?host=parent', bridge: true },
  // the app's own language switch follows the screen's; the others follow the browser's
  vectorcraft: { query: (lang) => `?lang=${lang}`, ready: (w) => !!w.vectorcraft, open: (w, file, bytes) => w.vectorcraft.openFile(file.name, new Uint8Array(bytes)) },
  photocraft: { query: () => '', ready: (w) => !w.document.getElementById('photocraft_loading'), open: (w, file) => drop(w, file) },
  soundcraft: { query: () => '?empty', ready: (w) => !w.document.getElementById('soundcraft_loading'), open: (w, file) => drop(w, file) },
  filmcraft: {
    query: () => '?empty&fresh', ready: (w) => !!w.filmcraft,
    // imported clips only land in the bin: put them on a timeline of their own, ready to cut
    open: async (w, file) => {
      const r = await w.filmcraft.importFiles([file])
      if (r?.items?.length) await w.filmcraft.execute('file.newSequenceFromClip', { items: r.items })
    },
  },
}

// the file, when the page hands it in
let gotFile
const fileP = new Promise((r) => { gotFile = r })
lite.provide('craft_file', ({ name, base64 }) => { gotFile({ name: name || 'file', bytes: lite.unb64(base64 || '').buffer }); return true })

await lite.ready
const { app, lang } = lite.initial || {}
const a = APPS[app]
const state = (s, extra = {}) => lite.notify('craft', { state: s, ...extra })
const win = () => frame.contentWindow
const canLive = () => typeof win()?.[app]?.request === 'function'
lite.provide('craft_request', async ({ method, params }) => {
  if (!canLive()) throw new Error('the app is not running in the screen')
  return win()[app].request(method, params || {})
})
// the open document as PNG (PhotoCraft renders it for ui.screenshot on the web)
lite.provide('craft_snapshot', async () => {
  if (!canLive()) throw new Error('the app is not running in the screen')
  const r = await win()[app].request('ui.screenshot', {})
  const b64 = r?.base64 || r?.png_base64 || r?.pngBase64
  if (!b64) throw new Error('no image came back')
  return b64
})

const save = (name, bytes) => lite.download(name, bytes)
function catchDownloads(w) {
  const blobs = new Map()
  const create = w.URL.createObjectURL.bind(w.URL)
  w.URL.createObjectURL = (obj) => { const url = create(obj); if (obj instanceof w.Blob) blobs.set(url, obj); return url }
  const click = w.HTMLAnchorElement.prototype.click
  w.HTMLAnchorElement.prototype.click = function () {
    const blob = blobs.get(this.href)
    if (!this.download || !blob) return click.call(this)
    blob.arrayBuffer().then((bytes) => save(this.download, bytes))
  }
}

if (!a) state('failed', { error: `unknown app ${app}` })
else if (a.bridge) {
  // CADCraft asks for the drawing; the rest of its messages are its state and its saves. (This page is about:srcdoc:
  // location.origin is "null" here, self.origin is the origin it really has — the app's.)
  window.addEventListener('message', async (e) => {
    if (e.source !== win() || e.origin !== self.origin) return
    const m = e.data || {}
    const kind = String(m.type || '').split(':')[1]
    if (!kind || m.type !== `${app}:${kind}`) return
    if (kind === 'ready') {
      const f = await fileP
      win().postMessage({ type: `${app}:open`, name: f.name, bytes: f.bytes }, self.origin, [f.bytes])
      state('open', { live: canLive() })
    } else if (kind === 'save') save(m.name, m.bytes)
    else if (kind === 'dirty') state('dirty', { dirty: !!m.dirty })
    else if (kind === 'failed') state('failed', { error: m.error || '' })
  })
} else {
  // the others: wait until the app runs, then hand the file over and catch its downloads
  frame.addEventListener('load', () => {
    const w = win()
    let tries = 0
    const poll = async () => {
      try {
        if (w?.document.querySelector('canvas') && a.ready(w)) {
          catchDownloads(w)
          // a moment for the first frames, or a dropped file lands before the canvas listens
          await new Promise((r) => setTimeout(r, 1500))
          const f = await fileP
          await a.open(w, new w.File([f.bytes], f.name), f.bytes)
          state('open', { live: canLive() })
          return
        }
      } catch (e) { state('failed', { error: e.message }); return }
      if (++tries < 240) setTimeout(poll, 500)
      else state('failed', { error: 'the editor did not start' })
    }
    poll()
  }, { once: true })
}
if (a) frame.src = new URL(`../../../../craft/${app}/${a.query(lang || 'ko')}`, document.baseURI).href
