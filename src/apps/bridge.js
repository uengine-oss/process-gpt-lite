// The host side of every sandboxed frame — Home panels and Lite apps (docs/robo-dlc/plan-review.md §2):
// one table of what a frame may ask the host to do. A panel gets the panel set; an app gets what its
// manifest lists (server/apps/<id>/manifest.json "capabilities"), checked here on every call.
import { api } from '../api.js'
import { aidlcApiPath } from '../components/panelRuntime.js'
import { appApiPath, navAllowed } from './paths.js'

export const PANEL_CAPS = ['save', 'fetch', 'ask', 'open', 'chat', 'aidlc']

const external = (url) => { const u = new URL(String(url)); if (!/^https?:$/.test(u.protocol)) throw new Error('http(s) only'); return u.href }

const HANDLERS = {
  // ---- panels ----
  save: (c, p) => api(`/panels/${c.panelId}/data`, { method: 'PUT', body: p }),
  fetch: (c, url) => api(`/panel-proxy?url=${encodeURIComponent(url)}`),
  ask: async (c, prompt) => (await api('/panel-ask', { method: 'POST', body: { prompt } })).text,
  chat: (c, text) => { c.app.send(text, c.app.mainThread.id); return true },
  aidlc: (c, p) => api(aidlcApiPath(p)),
  // ---- both ----
  open: (c, url) => { window.open(external(url), '_blank', 'noopener'); return true },
  // ---- apps ----
  api: (c, { path, method = 'GET', body } = {}) => {
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new Error('method not allowed')
    return api(appApiPath(c.appId, path), { method, body })
  },
  navigate: (c, url) => { if (!navAllowed(url)) throw new Error('navigate: not allowed'); c.router.push(url); return true },
  openApp: (c, { id, params } = {}) => { c.openApp(String(id), params || {}); return true },
  me: (c) => ({ id: c.app.me?.user?.id || null, name: c.app.me?.user?.name || '' }),
}

// a message listener for one frame: answers only that frame, only for the capabilities it was given
export function bridge(getFrame, allowed, ctx) {
  const can = new Set(allowed)
  return async (e) => {
    const win = getFrame()?.contentWindow
    if (!win || e.source !== win) return
    const m = e.data
    if (!m || !(m.__panel || m.__app)) return
    if (m.type === 'height' || m.type === 'error') return ctx.onFrame?.(m.type, m.payload)
    const reply = (result, error, status) => win.postMessage({ __reply: 1, id: m.id, result, error, status }, '*')
    if (!can.has(m.type) || !HANDLERS[m.type]) return reply(null, `not allowed: ${m.type}`, 403)
    try { reply(await HANDLERS[m.type](ctx, m.payload)) } catch (err) { reply(null, err.message, err.status) }
  }
}
