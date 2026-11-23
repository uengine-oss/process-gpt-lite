// Lite: lays a stored BPMN out before a view shows it, with Process GPT vue3's own automatic layout.
//
// The files next to this one are copied from process-gpt/services/frontend/src/components/autoLayout @ 0e85995b
// (bpmn-auto-layout.js and what it needs). vue3 runs it on its Modeler as
//   window.BpmnAutoLayout.applyAutoLayout(modeler, { horizontal: participant.di.isHorizontal })
// (BpmnUengine.vue / customPalette/PaletteProvider.js applyAutoLayout), with customSequenceFlowFinalModule and
// sequenceFlowManualCropSkipModule registered on the modeler. Here the same call runs on one offscreen Modeler:
// import the XML, lay it out (lanes kept, horizontal unless the pool says otherwise), export the XML, and the view
// imports that into its own NavigatedViewer.
//
// The result is kept per (definition id, XML hash), so reopening a diagram is instant. When the layout throws, the
// original XML is shown and the failure is logged once for that diagram.
//
// This module and bpmn-js's Modeler load on first use (BpmnView / HeatBpmn import it dynamically).

// order matters: graph-algorithm sets window.GraphAlgorithm, which enhancedSugiyamaLayout reads when it loads
import './graph-algorithm.js'
import './enhancedSugiyamaLayout.js'
import './edge-router-orthogonal.js'
import './bpmn-waypoints-refresh.js'
import './bpmn-auto-layout.js'
import customSequenceFlowFinalModule from './custom-sequence-flow-final-module.js'
import sequenceFlowManualCropSkipModule from './sequence-flow-manual-crop-skip-module.js'
import Modeler from 'bpmn-js/lib/Modeler'

const CACHE_MAX = 60
const cache = new Map() // key → Promise<string>
const warned = new Set()
let modeler = null
let host = null
let queue = Promise.resolve()

// cyrb53: a quick 53-bit string hash (the XML can be tens of KB; a crypto digest would need async + TextEncoder)
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

// one Modeler, kept off screen (attached, so bpmn-js can measure label text), reused for every layout
function getModeler() {
  if (modeler) return modeler
  host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.dataset.bpmnLayoutHost = ''
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1600px;height:1000px;overflow:hidden;opacity:0;pointer-events:none;contain:strict'
  document.body.appendChild(host)
  modeler = new Modeler({ container: host, additionalModules: [customSequenceFlowFinalModule, sequenceFlowManualCropSkipModule] })
  return modeler
}

// the layout narrates every step with console.log; keep the console readable (warnings and errors still show)
function quietly(fn) {
  const { log, info, debug } = console
  console.log = console.info = console.debug = () => {}
  try { return fn() } finally { Object.assign(console, { log, info, debug }) }
}

// A node no lane lists (the generator writes gateways without a role, so no flowNodeRef) would be laid out in whatever
// lane its stored position falls in — the first one, far from its task. Put it in its neighbour's lane first: a split
// goes with the step before it, a join with the step after it. Only this offscreen copy changes.
function adoptLanelessNodes(reg) {
  const lanes = reg.filter((e) => e.type === 'bpmn:Lane' && e.businessObject)
  if (!lanes.length) return
  const laneOf = new Map()
  for (const l of lanes) for (const bo of l.businessObject.get('flowNodeRef')) laneOf.set(bo.id, l)
  let pending = reg.filter((e) => e.type !== 'label' && !e.waypoints && e.businessObject?.$instanceOf?.('bpmn:FlowNode') &&
    /^bpmn:(Participant|Lane|Process)$/.test(e.parent?.type || '') && !laneOf.has(e.businessObject.id))
  for (let pass = 0; pass < 4 && pending.length; pass++) {
    pending = pending.filter((el) => {
      const flows = (list) => (list || []).filter((c) => c.type === 'bpmn:SequenceFlow')
      const ins = flows(el.incoming).map((c) => laneOf.get(c.source?.businessObject?.id)).filter(Boolean)
      const outs = flows(el.outgoing).map((c) => laneOf.get(c.target?.businessObject?.id)).filter(Boolean)
      const joins = flows(el.incoming).length > 1 && flows(el.outgoing).length === 1
      const lane = (joins ? outs[0] || ins[0] : ins[0] || outs[0]) || null
      if (!lane) return true
      lane.businessObject.get('flowNodeRef').push(el.businessObject)
      laneOf.set(el.businessObject.id, lane)
      return false
    })
  }
}

async function run(xml) {
  const m = getModeler()
  await m.importXML(xml)
  const reg = m.get('elementRegistry')
  adoptLanelessNodes(reg)
  const pools = reg.filter((e) => e.type === 'bpmn:Participant')
  const nodes = reg.filter((e) => e.businessObject && /Task|Event|Gateway|SubProcess|CallActivity/.test(e.type) && e.type !== 'label')
  if (!nodes.length) return xml
  // vue3: horizontal = participant[0].di.isHorizontal (a pool without the attribute is horizontal in BPMN DI)
  const horizontal = pools.length ? pools[0].di?.isHorizontal !== false : true
  quietly(() => window.BpmnAutoLayout.applyAutoLayout(m, { horizontal }))
  const { xml: out } = await m.saveXML({ format: false })
  return out
}

/**
 * The XML laid out by Process GPT's automatic layout (cached per id + XML), or the XML as given when the layout fails.
 * @param {string} xml   BPMN 2.0 XML with DI
 * @param {string} [id]  definition id (and version) — part of the cache key
 * @returns {Promise<string>}
 */
export function layoutBpmnXml(xml, id = '') {
  if (!xml || typeof document === 'undefined') return Promise.resolve(xml)
  const key = `${id}|${hash(xml)}`
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit }
  // one layout at a time: the layout keeps state on window (isHorizontalLayout, the obstacle index) and shares the Modeler
  const p = (queue = queue.then(() => run(xml)).catch((e) => {
    if (!warned.has(key)) { warned.add(key); console.warn('[bpmn-layout] 자동 레이아웃 실패 — 저장된 배치로 보여요', id, e?.message || e) }
    return xml
  }))
  cache.set(key, p)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return p
}

export default layoutBpmnXml
