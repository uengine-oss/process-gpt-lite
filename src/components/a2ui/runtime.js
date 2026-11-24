// The A2UI renderer for a step's input screen, loaded only when one is shown (A2uiSurface.vue import()) — it stays out of the main
// chunk. Official Lit web components (@a2ui/lit 0.16.0 · @a2ui/web_core 0.16.1, pinned: the SDK changes often): <a2ui-surface> draws
// a surface model the MessageProcessor builds from the server's createSurface message (A2UI v1.0); the basic catalog's components are
// light-DOM custom elements, so the page's CSS (theme tokens → --a2ui-* variables) reaches them.
import '@a2ui/lit'
import { MessageProcessor } from '@a2ui/web_core'
import { basicCatalog, setMarkdownRenderer } from '@a2ui/web_core/catalogs/basic/v1'
import { CATALOG_ID, COMPONENTS, FUNCTIONS } from './catalogIds.js'

// Text is plain text here: no Markdown (no links, no pictures from elsewhere) — the words escaped, line breaks kept
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
setMarkdownRenderer((text) => esc(text).replace(/\n/g, '<br>'))

// Lite's step catalog: the basic catalog's components and functions of that name, under Lite's catalog id (the server validates
// against the same subset — server/lib/stepUi/catalog.json)
export const stepCatalog = basicCatalog.derive({ catalogId: CATALOG_ID, components: COMPONENTS, functions: FUNCTIONS })

// one screen: its processor (one per shown screen — a surface id is unique per processor) and its surface model
export function openSurface(message, onAction) {
  const processor = new MessageProcessor([stepCatalog], onAction)
  processor.processMessages([message])
  const surface = processor.model.getSurface(message.createSurface.surfaceId)
  if (!surface) throw new Error('surface not created')
  return { processor, surface }
}

const childIds = (c) => (typeof c.child === 'string' ? [c.child] : Array.isArray(c.children) ? c.children : [])
// A handed-in screen to look at: its buttons (and their words) left out, a row with nothing left goes too, the handed-in values as
// its data model (only the keys the screen binds)
export function readonlyMessage(message, values = {}) {
  const cs = message.createSurface
  const comps = cs.components || []
  const byId = new Map(comps.map((c) => [c.id, c]))
  const drop = new Set()
  for (const c of comps) if (c.component === 'Button') { drop.add(c.id); if (byId.get(c.child)?.component === 'Text') drop.add(c.child) }
  let changed = true
  while (changed) {
    changed = false
    for (const c of comps) {
      if (drop.has(c.id) || !Array.isArray(c.children)) continue
      if (c.id !== 'root' && c.children.length && c.children.every((k) => drop.has(k))) { drop.add(c.id); changed = true }
    }
  }
  const kept = comps.filter((c) => !drop.has(c.id)).map((c) => (Array.isArray(c.children) ? { ...c, children: c.children.filter((k) => !drop.has(k)) } : c))
  const form = { ...(cs.dataModel?.form || {}) }
  for (const k of Object.keys(form)) if (values && k in values) form[k] = values[k]
  return { version: '1.0', createSurface: { ...cs, components: kept, dataModel: { form } } }
}
export { childIds }
