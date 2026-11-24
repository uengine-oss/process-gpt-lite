'use strict'
// One tab's Chrome DevTools Protocol, over Electron's own debugger for its webContents (webContents.debugger — no debugging port
// opens on this PC). Frames from other sites run in processes of their own (site isolation): they attach as child sessions
// (Target.setAutoAttach, flatten) and each gets the same setup. What a tab needs to be driven: its frames (which session runs each, its
// parent), each frame's page context to run this app's scripts in (pageScripts.js), the main frame's load stages, and where a frame
// sits on the screen (its iframe element's box, up to the top).
const { EventEmitter } = require('node:events')

const withTimeout = (p, ms, what = 'step') => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`), { timeout: true })), ms)
  Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
})

class Cdp extends EventEmitter {
  // dbg: webContents.debugger · guard: a script run in every document from its start (pageScripts GUARD_JS, as source)
  constructor(dbg, { guard = '' } = {}) {
    super()
    this.dbg = dbg
    this.guard = guard
    this.frames = new Map() // frameId → { parentId, session ('' = this tab's own), url }
    this.contexts = new Map() // frameId → { id, session }
    this.sessions = new Set([''])
    this.main = null // the main frame's id
    this.loader = { id: null, seen: new Set() } // the main frame's current document and its load stages so far
    this.closed = false
    this.onMessage = (_e, method, params, sessionId) => { try { this.event(method, params || {}, sessionId || '') } catch (err) { this.emit('error', err) } }
    dbg.on('message', this.onMessage)
    dbg.on('detach', () => { this.closed = true; this.emit('detach') })
  }

  send(method, params = {}, session = '') {
    if (this.closed) return Promise.reject(new Error('the tab is closed'))
    return session ? this.dbg.sendCommand(method, params, session) : this.dbg.sendCommand(method, params)
  }

  async start() {
    if (!this.dbg.isAttached()) this.dbg.attach('1.3')
    await this.setup('')
    const { frameTree } = await this.send('Page.getFrameTree')
    this.tree(frameTree, null, '')
    // (a document that was loading before this attached — a popup — has passed stages this never heard of: read from the page)
    if (frameTree?.frame?.loaderId && this.loader.id !== frameTree.frame.loaderId) this.loader = { id: frameTree.frame.loaderId, seen: new Set() }
    const ready = await this.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).then((r) => r.result?.value, () => null)
    if (ready === 'interactive' || ready === 'complete') this.loader.seen.add('DOMContentLoaded')
    if (ready === 'complete') this.loader.seen.add('load')
    // (the document already there — a popup that loaded before this attached — gets the guard too)
    if (this.guard) await this.send('Runtime.evaluate', { expression: `(${this.guard})()` }).catch(() => {})
  }
  // the same for this tab and for each frame that attaches as a session of its own
  async setup(session) {
    await Promise.all([this.send('Page.enable', {}, session), this.send('Runtime.enable', {}, session)])
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true }, session).catch(() => {})
    if (this.guard) await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${this.guard})()`, runImmediately: true }, session).catch(() => {})
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session).catch(() => {})
  }
  tree(node, parentId, session) {
    if (!node?.frame) return
    const f = node.frame
    this.frames.set(f.id, { parentId: f.parentId || parentId || null, session, url: f.url || '' })
    if (!f.parentId && !parentId && !session) this.main = f.id
    for (const c of node.childFrames || []) this.tree(c, f.id, session)
  }

  event(method, p, session) {
    switch (method) {
      case 'Target.attachedToTarget': {
        const sid = p.sessionId
        const info = p.targetInfo || {}
        if (info.type !== 'iframe') { this.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {}); return }
        this.sessions.add(sid)
        const f = this.frames.get(info.targetId) || { parentId: null, url: info.url || '' }
        this.frames.set(info.targetId, { ...f, session: sid })
        this.setup(sid)
          .then(() => this.send('Page.getFrameTree', {}, sid)).then(({ frameTree }) => {
            const root = frameTree?.frame
            if (root?.parentId) this.frames.set(root.id, { ...(this.frames.get(root.id) || {}), parentId: root.parentId, session: sid, url: root.url || '' })
            for (const c of frameTree?.childFrames || []) this.tree(c, root?.id, sid)
          })
          .catch(() => {})
          .finally(() => this.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {}))
        return
      }
      case 'Target.detachedFromTarget': {
        this.sessions.delete(p.sessionId)
        for (const [id, c] of this.contexts) if (c.session === p.sessionId) this.contexts.delete(id)
        return
      }
      case 'Page.frameAttached': {
        const had = this.frames.get(p.frameId)
        this.frames.set(p.frameId, { parentId: p.parentFrameId || null, session: had?.session ?? session, url: had?.url || '' })
        return
      }
      case 'Page.frameNavigated': {
        const f = p.frame || {}
        const had = this.frames.get(f.id)
        // (a frame that moved to a process of its own keeps its session: its old one reports it navigated too)
        this.frames.set(f.id, { parentId: f.parentId || had?.parentId || null, session: had && had.session !== session && !session ? had.session : session, url: f.url || '' })
        if (!f.parentId && !session) {
          this.main = f.id
          if (f.loaderId && f.loaderId !== this.loader.id) this.loader = { id: f.loaderId, seen: new Set() }
          this.emit('navigated', f.url)
        }
        return
      }
      case 'Page.frameDetached': {
        // ('swap': it went on in a process of its own — the frame is still there)
        if (p.reason === 'swap') return
        const f = this.frames.get(p.frameId)
        if (f && f.session === session) { this.frames.delete(p.frameId); this.contexts.delete(p.frameId) }
        return
      }
      case 'Page.lifecycleEvent': {
        if (p.frameId !== this.main || session) return
        if (p.name === 'init' && p.loaderId !== this.loader.id) this.loader = { id: p.loaderId, seen: new Set() }
        if (p.loaderId === this.loader.id) { this.loader.seen.add(p.name); this.emit('lifecycle', p.name, p.loaderId) }
        return
      }
      case 'Runtime.executionContextCreated': {
        const c = p.context || {}
        const fid = c.auxData?.frameId
        if (fid && c.auxData?.isDefault) {
          this.contexts.set(fid, { id: c.id, session })
          // (a frame whose document the guard did not start in — an about:blank iframe a script made, reached through window.frames:
          // the guard now. It does nothing in a document that has it already)
          if (this.guard) this.send('Runtime.evaluate', { expression: `(${this.guard})()`, contextId: c.id }, session).catch(() => {})
          this.emit('context', fid)
        }
        return
      }
      case 'Runtime.executionContextDestroyed': {
        for (const [fid, c] of this.contexts) if (c.id === p.executionContextId && c.session === session) this.contexts.delete(fid)
        return
      }
      case 'Runtime.executionContextsCleared': {
        for (const [fid, c] of this.contexts) if (c.session === session) this.contexts.delete(fid)
        return
      }
      default:
        this.emit('event', method, p, session)
    }
  }

  // the frame's page context (waits a moment for one being made — a document that is just starting)
  async context(fid, ms = 1500) {
    const have = this.contexts.get(fid)
    if (have) return have
    let on
    return withTimeout(new Promise((resolve) => {
      on = (id) => { if (id === fid) resolve(this.contexts.get(fid)) }
      this.on('context', on)
    }), ms, 'the page context').finally(() => this.off('context', on))
  }
  // fn (one of this app's page scripts) called in frame fid with args → its value
  async call(fid, fn, args = [], { ms = 6000, byValue = true } = {}) {
    const frame = fid || this.main
    const run = async () => {
      const c = await this.context(frame, Math.min(1500, ms))
      try {
        const out = await withTimeout(this.send('Runtime.callFunctionOn', { functionDeclaration: String(fn), executionContextId: c.id, arguments: args.map((value) => ({ value })),
          returnByValue: byValue, awaitPromise: true }, c.session), ms, 'the page')
        return { ...out, session: c.session }
      } catch (e) {
        // (the document went away just now — its context is not told gone yet): the next one
        if (/Cannot find context|Execution context was destroyed/.test(e.message) && this.contexts.get(frame) === c) this.contexts.delete(frame)
        throw e
      }
    }
    const r = await run().catch((e) => (/Cannot find context|Execution context was destroyed/.test(e.message) ? run() : Promise.reject(e)))
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(String(d.exception?.description || d.exception?.value || d.text || 'the page script failed').split('\n')[0].slice(0, 200))
    }
    return byValue ? r.result?.value : { objectId: r.result?.objectId, session: r.session }
  }
  sessionOf(fid) { return this.frames.get(fid || this.main)?.session || '' }

  // Where frame fid's page starts on the tab's screen: the sum of its iframe elements' content boxes up to the main frame (each one
  // asked of the frame that holds it — DOM.getFrameOwner, which works across sites). → {x, y, width, height} of the frame, or null
  async offsetOf(fid, depth = 0) {
    if (!fid || fid === this.main) return { x: 0, y: 0, width: Infinity, height: Infinity }
    const f = this.frames.get(fid)
    if (!f?.parentId || depth > 8) return null
    const parent = this.frames.get(f.parentId)
    const session = f.parentId === this.main ? '' : (parent?.session || '')
    const { backendNodeId } = await this.send('DOM.getFrameOwner', { frameId: fid }, session)
    const pc = await this.context(f.parentId)
    const { object } = await this.send('DOM.resolveNode', { backendNodeId, executionContextId: pc.id }, pc.session)
    const r = await this.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: String(require('./pageScripts').OWNER_BOX_JS), returnByValue: true }, pc.session)
    this.send('Runtime.releaseObject', { objectId: object.objectId }, pc.session).catch(() => {})
    const box = r.result?.value
    if (!box) return null
    const up = await this.offsetOf(f.parentId, depth + 1)
    if (!up) return null
    return { x: box.x + up.x, y: box.y + up.y, width: box.width, height: box.height }
  }

  // the main document has reached load stage name ('DOMContentLoaded' · 'load') — now or within ms. loader: that document (a navigation's
  // own — the one before it has reached every stage already); else the document the frame has now
  waitStage(name, ms, loader = null) {
    if ((!loader || this.loader.id === loader) && this.loader.seen.has(name)) return Promise.resolve(true)
    let on
    return withTimeout(new Promise((resolve) => {
      on = (n, id) => { if (n === name && (loader ? id === loader : id === this.loader.id)) resolve(true) }
      this.on('lifecycle', on)
    }), ms, name).finally(() => this.off('lifecycle', on))
  }

  close() {
    this.closed = true
    this.dbg.removeListener('message', this.onMessage)
    try { if (this.dbg.isAttached()) this.dbg.detach() } catch { /* gone */ }
  }
}

module.exports = { Cdp, withTimeout }
