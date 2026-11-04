// SolidCraft's bridge, a Chili3D plugin (plugins/plugins.json loads it at startup; Chili3D's source
// is untouched). window.solidcraft is the page API; with ?host=parent the same things go over
// postMessage as solidcraft:ready/open/dirty/save/failed, the way CraftEditorFrame.vue talks to apps.
const { CommandStore, EditableShapeNode, GroupNode, Material, PubSub, ShapeNode } = globalThis.Chili3dCore

const FORMAT_BY_EXT = { step: '.step', stp: '.step', iges: '.iges', igs: '.iges' }
const startQuery = globalThis.__solidcraftQuery || '' // index.template.html took it off the URL
const query = new URLSearchParams(startQuery)
const HOSTED = query.get('host') === 'parent'
const RENDER = query.has('render')

const state = { name: '', format: '.step', ready: false, lastError: null, dirty: false, doc: null }
let app = null

const extOf = (name) => String(name || '').toLowerCase().split('.').pop()
const stemOf = (name) => String(name || '').replace(/\.[^.]+$/, '') || 'Model'
const toBytes = (data) => {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  throw new Error('bytes must be a Uint8Array or an ArrayBuffer')
}
function normalizeFormat(format) {
  const found = FORMAT_BY_EXT[String(format || '').toLowerCase().replace(/^\./, '')]
  if (!found) throw new Error(`unknown format "${format}": use .step or .iges`)
  return found
}

function post(message, transfer) {
  if (!HOSTED || window.parent === window) return
  window.parent.postMessage(message, location.origin, transfer || [])
}
function fail(error) {
  state.lastError = String(error?.message || error)
  post({ type: 'solidcraft:failed', error: state.lastError })
  return new Error(state.lastError)
}
function setDirty(dirty) {
  if (state.dirty === dirty) return
  state.dirty = dirty
  post({ type: 'solidcraft:dirty', dirty })
}

function shapeNodes(root) {
  const found = []
  const visit = (node) => {
    if (node instanceof ShapeNode) found.push(node)
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child)
  }
  if (root) visit(root)
  return found
}
const activeDocument = () => app.activeView?.document ?? state.doc

// every edit in Chili3D commits to the document's history, and only edits do (not the camera)
function watchEdits(doc) {
  const { history } = doc
  for (const method of ['add', 'undo', 'redo']) {
    const original = history[method].bind(history)
    history[method] = (...args) => {
      const out = original(...args)
      if (!history.disabled) setDirty(true)
      return out
    }
  }
}

// Document.close() asks about saving with window.confirm; here the host owns the file
async function closeDocuments() {
  const realConfirm = window.confirm
  window.confirm = () => false
  try {
    for (const doc of [...app.documents]) await doc.close()
  } finally {
    window.confirm = realConfirm
  }
  state.doc = null
}

const nextFrame = () => new Promise((resolve) => {
  const done = setTimeout(resolve, 100) // a hidden frame gets no animation frames
  requestAnimationFrame(() => { clearTimeout(done); resolve() })
})

const VIEWS = {
  iso: { eye: [1, -1, 0.8], up: [0, 0, 1] },
  front: { eye: [0, -1, 0], up: [0, 0, 1] },
  back: { eye: [0, 1, 0], up: [0, 0, 1] },
  right: { eye: [1, 0, 0], up: [0, 0, 1] },
  left: { eye: [-1, 0, 0], up: [0, 0, 1] },
  top: { eye: [0, 0, 1], up: [0, 1, 0] },
  bottom: { eye: [0, 0, -1], up: [0, -1, 0] },
}
function setView(viewName = 'iso') {
  const preset = VIEWS[viewName]
  if (!preset) throw new Error(`unknown view "${viewName}": use ${Object.keys(VIEWS).join(', ')}`)
  const view = app.activeView
  if (!view) throw new Error('no document is open')
  const controller = view.cameraController
  controller.settle?.()
  const target = controller.cameraTarget
  const at = (v, k = 1000) => ({ x: target.x + v[0] * k, y: target.y + v[1] * k, z: target.z + v[2] * k })
  const up = { x: preset.up[0], y: preset.up[1], z: preset.up[2] }
  controller.lookAt(at(preset.eye), target, up, { duration: 0 })
  controller.fitContent({ duration: 0, scope: 'all' })
  view.update()
}

// a new document with its history off: opening a file is not an edit, and there is nothing to undo
async function withNewDocument(name, fill) {
  await closeDocuments()
  const doc = await app.newDocument(name)
  doc.history.disabled = true
  try {
    await fill(doc)
  } catch (error) {
    await closeDocuments()
    throw error
  }
  doc.history.disabled = false
  watchEdits(doc)
  state.doc = doc
  state.lastError = null
  state.dirty = false
  await nextFrame() // the viewport has its size by now
  // parts here can be a millimetre long: at the default perspective they look badly out of true
  app.activeView.cameraController.cameraType = 'orthographic'
  setView('iso')
  return doc
}

async function openFile(name, bytes) {
  try {
    const format = FORMAT_BY_EXT[extOf(name)]
    if (!format) throw new Error(`${name}: not a STEP (.step .stp) or IGES (.iges .igs) file`)
    const data = toBytes(bytes)
    await withNewDocument(stemOf(name), (doc) => {
      const read = format === '.step' ? shapeConverter.convertFromSTEP(doc, data) : shapeConverter.convertFromIGES(doc, data)
      if (!read.isOk) throw new Error(`${name}: could not read it as ${format === '.step' ? 'STEP' : 'IGES'} (${read.error})`)
      read.value.name = name
      if (!shapeNodes(read.value).length) throw new Error(`${name}: the file holds no geometry`)
      doc.modelManager.addNode(read.value)
      doc.visual.update()
    })
    state.name = name
    state.format = format
    post({ type: 'solidcraft:dirty', dirty: false })
    return getState()
  } catch (error) {
    throw fail(error)
  }
}

async function exportFile(format, doc = activeDocument()) {
  const wanted = normalizeFormat(format ?? state.format)
  const nodes = shapeNodes(doc?.modelManager.rootNode)
  if (!nodes.length) throw new Error('nothing to export: the model is empty')
  const parts = await app.dataExchange.export(wanted, nodes)
  if (!parts?.length) throw new Error(`could not export ${wanted}`)
  return new TextEncoder().encode(parts.join(''))
}

async function saveToHost() {
  try {
    const bytes = await exportFile(state.format, state.doc)
    post({ type: 'solidcraft:save', name: state.name, bytes }, [bytes.buffer])
    state.dirty = false // the next edit says so again; the host clears its own badge when the upload lands
  } catch (error) {
    throw fail(error)
  }
}

// solidcraft-cli's render: the model's parts as BREP (exact, with their names and colours)
async function loadParts(parts, { name = 'Model' } = {}) {
  await withNewDocument(name, (doc) => {
    const group = new GroupNode({ document: doc, name })
    for (const part of parts) {
      const shape = shapeConverter.convertFromBrep(part.brep)
      if (!shape.isOk) throw new Error(`${part.name}: ${shape.error}`)
      const material = new Material({ document: doc, name: part.name, color: part.color || '#c4c8cc' })
      doc.modelManager.materials.push(material)
      group.add(new EditableShapeNode({ document: doc, name: part.name, shape: shape.value, materialId: material.id }))
    }
    doc.modelManager.addNode(group)
    doc.visual.update()
  })
  state.name = name
  return getState()
}

// fitContent frames the bounding sphere, which leaves a box small in a wide picture. An orthographic
// view scales with the camera's distance, so this moves it until the box's corners nearly reach the edge.
function fillFrame(view, width, height) {
  const nodes = shapeNodes(view.document.modelManager.rootNode).filter((node) => node.visible !== false)
  const boxes = nodes.map((node) => node.boundingBox()).filter(Boolean)
  if (!boxes.length) return
  const low = (axis) => Math.min(...boxes.map((box) => box.min[axis]))
  const high = (axis) => Math.max(...boxes.map((box) => box.max[axis]))
  const corners = []
  for (const x of [low('x'), high('x')]) for (const y of [low('y'), high('y')]) for (const z of [low('z'), high('z')]) corners.push({ x, y, z })
  const controller = view.cameraController
  for (let round = 0; round < 2; round++) {
    const points = corners.map((corner) => view.worldToScreen(corner))
    const fill = Math.max(...points.map((p) => Math.max(Math.abs(p.x - width / 2) / (width / 2), Math.abs(p.y - height / 2) / (height / 2))))
    if (!(fill > 0)) return
    const scale = fill / 0.9
    const { cameraPosition: eye, cameraTarget: target, cameraUp: up } = controller
    controller.lookAt({ x: target.x + (eye.x - target.x) * scale, y: target.y + (eye.y - target.y) * scale, z: target.z + (eye.z - target.z) * scale }, target, up, { duration: 0 })
  }
}

// The app's own capture at a fixed size, flattened onto a light background, without the world axes.
// foreground: the share of pixels that are not background, so a blank picture can be told from a model.
async function renderImage({ view = 'iso', width = 1600, height = 1000, background = [244, 246, 248] } = {}) {
  const active = app.activeView
  if (!active) throw new Error('no document is open')
  for (const helper of active.content?.scene?.children ?? []) if (helper.type === 'AxesHelper') helper.visible = false
  const restore = active.beginImageCapture?.(width, height)
  try {
    setView(view)
    active.cameraController.fitContent({ duration: 0, scope: 'all', aspect: width / height })
    fillFrame(active, width, height)
    const frame = active.toImage({ width, height })
    const image = new Image()
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('capture failed')); image.src = frame })
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.fillStyle = `rgb(${background.join(',')})`
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, width, height)
    let drawn = 0
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - background[0]) + Math.abs(data[i + 1] - background[1]) + Math.abs(data[i + 2] - background[2]) > 12) drawn++
    }
    return { dataUrl: canvas.toDataURL('image/png'), foreground: drawn / (width * height) }
  } finally {
    restore?.()
  }
}

function getState() {
  return { name: state.name, nodes: shapeNodes(activeDocument()?.modelManager.rootNode).length, ready: state.ready, lastError: state.lastError }
}

// the assistant dock stays closed: Process GPT's chat is the assistant here. Its toggle stays on the
// ribbon; it sends nothing without a key, and this page's CSP stops it reaching a provider even with one.
function closeAssistant() {
  document.querySelector('chili-ai-chat')?.onClose?.()
}

// the "based on" line; the ribbon's GitHub link is Chili3D's own and stays
function addNotice() {
  const version = document.querySelector('meta[name="chili3d-version"]')?.content || ''
  const link = document.createElement('a')
  link.href = 'NOTICE.txt'
  link.target = '_blank'
  link.rel = 'noopener'
  link.textContent = `SolidCraft · Chili3D ${version} (AGPL-3.0) · OCCT (LGPL)`
  link.id = 'sc-notice'
  link.style.cssText = 'margin: 0 8px; font-size: 11px; color: inherit; opacity: .7; white-space: nowrap; text-decoration: none;'
  const bar = document.querySelector('chili-statusbar')
  ;(bar?.lastElementChild || document.body).prepend(link)
}

// hosted: the ribbon's save button and ⌘S both hand the file to the page
function routeSaveToHost() {
  const data = CommandStore.getComandData('doc.save')
  class SaveToHost { async execute() { await saveToHost() } }
  CommandStore.registerCommand(SaveToHost, { ...data, key: 'doc.save' })
  window.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 's') return
    event.preventDefault()
    event.stopImmediatePropagation()
    saveToHost().catch(() => {})
  }, true)
  // the viewport cancels the mouse's default action, which would have focused this frame: without
  // this, ⌘S after a click on the model goes to the page around it (the browser's Save dialog)
  window.addEventListener('pointerdown', () => window.focus(), true)
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== location.origin) return
    const message = event.data || {}
    if (message.type !== 'solidcraft:open') return
    openFile(message.name, message.bytes).catch(() => {})
  })
  // the page has its own "unsaved changes" guard; a second prompt from the frame would just confuse
  window.onbeforeunload = null
}

const Bridge = {
  register(application) { app = application },
  start() {
    history.replaceState(null, '', location.pathname + startQuery + location.hash)
    // a dropped .chiliplugin would run its code on the product's origin
    app.pluginManager.loadFromFile = async () => { PubSub.default.pub('showToast', 'error.default:{0}', 'plugins are disabled in SolidCraft') }
    closeAssistant()
    addNotice()
    window.solidcraft = { openFile, exportFile: (format) => exportFile(format), getState, setView, loadParts, renderImage }
    if (HOSTED) routeSaveToHost()
    state.ready = true
    // once the app has finished its own startup, or the host's first message could beat it
    setTimeout(() => post({ type: 'solidcraft:ready' }), 0)
  },
  stop() {},
}

export default { services: [Bridge] }
