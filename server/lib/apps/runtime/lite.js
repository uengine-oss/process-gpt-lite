// The runtime an app's page loads (contract v1, lib/apps/registry.js): window.lite. The page runs in a
// sandboxed iframe with no origin of its own; everything it needs from Lite goes through the host
// (src/apps/bridge.js), which allows only the calls the app's manifest lists.
//   lite.api(path, {method, body})  this app's own server routes (/api/apps/<id>/<path>), as the person
//   lite.on(type, fn)               live events the app's server sent to this folder ('*' for all)
//   lite.navigate(url)              a Lite screen (the shared terminal, the decision page, another app)
//   lite.openApp(id, params)        another app beside this one (it knows the other only by id)
//   lite.open(url)                  an outside link in a new tab
//   lite.me()                       who is looking: { id, name }
(() => {
  const pending = {}
  let seq = 0
  const handlers = {}
  const call = (type, payload) => new Promise((resolve, reject) => {
    const id = ++seq
    pending[id] = { resolve, reject }
    parent.postMessage({ __app: 1, id, type, payload }, '*')
  })
  const fire = (type, data) => [...(handlers[type] || []), ...(handlers['*'] || [])].forEach((fn) => { try { fn(data, type) } catch (e) { console.error(e) } })
  addEventListener('message', (e) => {
    if (e.source !== parent) return
    const m = e.data || {}
    if (m.__reply && pending[m.id]) {
      if (m.error) pending[m.id].reject(Object.assign(new Error(m.error), { status: m.status }))
      else pending[m.id].resolve(m.result)
      delete pending[m.id]
    }
    if (m.__theme) document.documentElement.dataset.theme = m.__theme
    if (m.__event) fire(m.type, m.data)
    if (m.__params) { Object.assign(lite.params, m.__params); fire('params', lite.params) }
  })
  const params = Object.fromEntries(new URLSearchParams(location.search))
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const lite = {
    contract: 1, params, lang: params.lang === 'en' ? 'en' : 'ko',
    t: (ko, en) => (lite.lang === 'en' ? en : ko),
    call,
    api: (path, opts = {}) => call('api', { path, method: opts.method || 'GET', body: opts.body }),
    on(type, fn) { (handlers[type] = handlers[type] || []).push(fn) },
    me: () => call('me'),
    navigate: (url) => call('navigate', url),
    openApp: (id, p) => call('openApp', { id, params: p || {} }),
    open: (url) => call('open', url),
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
  document.documentElement.dataset.theme = params.theme === 'dark' ? 'dark' : 'light'
  document.documentElement.lang = lite.lang
  window.lite = lite
})()
