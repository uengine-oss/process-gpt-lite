// The runtime an app's screen loads (contract v2 = MCP Apps): a thin layer over the standard App of
// @modelcontextprotocol/ext-apps, so a screen speaks MCP Apps to whatever host shows it — Lite, or any
// MCP Apps host. In Lite the host also passes live events for the folder (Lite's extension notification).
//   await lite.ready                    connected; lite.params holds the entry tool's arguments, lite.initial its result
//   lite.tool(name, args)               a tool of this app's server (as the person); throws Error{status} on an error
//   lite.on(type, fn)                   live events: 'params', 'result', and what the app's server published to the folder
//   lite.openLink(url)                  an outside link, or a Lite screen ("/apps/<id>/<folder>?…", "/workroom/…")
//   lite.openApp(id, params)            another app beside this one (it knows the other only by id): a Lite link
//   lite.say(text)                      a message to the chat (ui/message)
//   lite.provide(name, fn)              a tool of this screen the host may call (tools/call host → screen); fn(args) → value
//   lite.notify(type, data)             tell the host something (Lite's extension notification, the other way round)
//   lite.download(name, bytes, type)    hand a file to the host (ui/download-file); Lite keeps it (an edited copy, an export)
import { App, PostMessageTransport } from './ext-apps.js'

const handlers = {}
const fire = (type, data) => [...(handlers[type] || []), ...(handlers['*'] || [])].forEach((fn) => { try { fn(data, type) } catch (e) { console.error(e) } })
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const LIVE = 'notifications/io.uengine.lite/event'

// the screen's own tools (lite.provide): declared before the handshake, answered here
const provided = {}
const app = new App({ name: document.title || 'lite-app', version: '2.0.0' }, { tools: { listChanged: true } }, { autoResize: true })
app.oncalltool = async ({ name, arguments: args }) => {
  if (!provided[name]) return { isError: true, content: [{ type: 'text', text: `no tool ${name}` }] }
  try {
    const value = await provided[name](args || {})
    return { content: [{ type: 'text', text: JSON.stringify(value ?? null).slice(0, 1000) }], structuredContent: { value: value ?? null } }
  } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }], structuredContent: { error: e.message } } }
}
app.onlisttools = async () => ({ tools: Object.keys(provided).map((name) => ({ name, inputSchema: { type: 'object' } })) })
const b64 = (bytes) => { const u = new Uint8Array(bytes); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s) }
let gotInput, gotResult
const inputP = new Promise((r) => { gotInput = r })
const resultP = new Promise((r) => { gotResult = r })
app.ontoolinput = (p) => { Object.assign(lite.params, p?.arguments || {}); gotInput(); fire('params', lite.params) }
app.ontoolresult = (r) => { lite.initial = r?.structuredContent?.value ?? r?.structuredContent ?? null; gotResult(); fire('result', lite.initial) }
const theme = (c) => { if (c?.theme) document.documentElement.dataset.theme = c.theme; if (c?.locale) lite.lang = /^en/.test(c.locale) ? 'en' : 'ko'; document.documentElement.lang = lite.lang }
app.onhostcontextchanged = (c) => { theme(c); fire('context', c) }
// Lite's extension: what the app's server published to this folder, passed on by the host
app.fallbackNotificationHandler = async (n) => { if (n?.method === LIVE) fire(n.params?.type, n.params?.data) }

const lite = {
  contract: 2, app, params: {}, initial: null, lang: 'ko',
  t: (ko, en) => (lite.lang === 'en' ? en : ko),
  async tool(name, args = {}) {
    const r = await app.callServerTool({ name, arguments: args })
    if (r.isError) throw Object.assign(new Error(r.structuredContent?.error || r.content?.[0]?.text || 'error'), { status: r.structuredContent?.status })
    return r.structuredContent?.value ?? r.structuredContent ?? null
  },
  on(type, fn) { (handlers[type] = handlers[type] || []).push(fn) },
  openLink: (url) => app.openLink({ url }),
  openApp: (id, p = {}) => app.openLink({ url: `/apps/${id}/${encodeURIComponent(lite.params.folder || '')}?${new URLSearchParams({ ...p, sheet: '1' })}` }),
  navigate: (url) => app.openLink({ url }),
  say: (text) => app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }),
  provide(name, fn) { provided[name] = fn },
  notify: (type, data) => app.notification({ method: LIVE, params: { type, data: data ?? {} } }),
  async download(name, bytes, mimeType = 'application/octet-stream') {
    const buf = bytes instanceof Blob ? await bytes.arrayBuffer() : bytes
    return app.downloadFile({ contents: [{ type: 'resource', resource: { uri: `file:///${encodeURIComponent(name)}`, mimeType, blob: b64(buf) } }] })
  },
  b64,
  unb64: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  // small helpers every app wants
  esc,
  $: (s, el = document) => el.querySelector(s),
  $$: (s, el = document) => [...el.querySelectorAll(s)],
  ago(d) { const s = (Date.now() - new Date(d)) / 1000; return s < 60 ? lite.t('방금', 'just now') : s < 3600 ? Math.floor(s / 60) + lite.t('분 전', 'm ago') : s < 86400 ? Math.floor(s / 3600) + lite.t('시간 전', 'h ago') : Math.floor(s / 86400) + lite.t('일 전', 'd ago') },
  // a person's round initial in a colour of their own (the same name, the same colour everywhere)
  avatar(name, { size = 22, ring = false } = {}) {
    const n = String(name || '?'); let h = 0
    for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360
    return `<span class="av${ring ? ' ring' : ''}" title="${esc(n)}" style="--av:hsl(${h} 62% 52%);width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px">${esc(n.trim().slice(0, 1))}</span>`
  },
}
window.lite = lite
lite.ready = (async () => {
  await app.connect(new PostMessageTransport(window.parent, window.parent))
  theme(app.getHostContext())
  // the host sends the entry tool's input and result right after the handshake
  await Promise.race([Promise.all([inputP, resultP]), new Promise((r) => setTimeout(r, 4000))])
  return lite
})()
export default lite
