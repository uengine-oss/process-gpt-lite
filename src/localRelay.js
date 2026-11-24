// One connection of a run card to its relayed CLI session (server lib/localAgents/relay.js — agent-share's protocol): a one-time ticket,
// then the WebSocket. It carries the terminal's bytes ('term' — LocalTerminal.vue) and the conversation ('tx' — LocalConversation.vue);
// a view asks for its stream when it shows (subscribe — the server sends that stream from the start). The card opens it as soon as the
// run is sent to a desktop that runs steps in a terminal — before the terminal is open (the server holds the viewer until it is), so
// the screen is there the moment the CLI starts.
//   state: connecting (the ticket, the socket, or the terminal not open yet) · live · detached (its desktop's link dropped) · ended · failed
import { reactive } from 'vue'
import { api } from './api.js'
import { BASE } from './base.js'

export function openRelay(jobId, { streams = ['term'] } = {}) {
  const st = reactive({ state: 'connecting', waiting: false, owner: false, why: '', cols: 80, rows: 28, agent: null, device: null })
  const want = new Set(streams)
  const handlers = new Map()
  let ws = null
  let timer = null
  let closed = false
  let retry = 0
  const emit = (type, m) => { for (const fn of handlers.get(type) || []) { try { fn(m) } catch (e) { console.warn('[relay]', type, e) } } }
  const set = (s, why = '') => { st.state = s; st.why = why }

  async function connect() {
    clearTimeout(timer)
    let t
    try { t = await api(`/local-agents/jobs/${encodeURIComponent(jobId)}/term`, { method: 'POST' }) } catch (e) {
      if (e.status === 403 || e.status === 404) return set('failed', e.message)
      return again()
    }
    if (closed) return
    st.owner = !!t.owner
    st.waiting = !!t.waiting
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}/api/local-agents/term?ticket=${encodeURIComponent(t.ticket)}&streams=${[...want].join(',')}`)
    ws = sock
    let denied = ''
    sock.onmessage = (e) => {
      let m
      try { m = JSON.parse(e.data) } catch { return }
      if (m.type === 'session') {
        retry = 0
        Object.assign(st, { owner: !!m.owner, cols: m.cols || st.cols, rows: m.rows || st.rows, agent: m.agent || st.agent, device: m.device || st.device, waiting: false })
        set(m.live === false ? 'ended' : m.detached ? 'detached' : 'live')
      } else if (m.type === 'waiting') st.waiting = true
      else if (m.type === 'exit') set('ended')
      else if (m.type === 'detached') set('detached')
      else if (m.type === 'attached') { if (st.state === 'detached') set('live') }
      else if (m.type === 'denied') denied = m.reason || ''
      emit(m.type, m)
    }
    sock.onclose = () => {
      if (closed || ws !== sock) return
      ws = null
      if (denied) return set('failed', denied)
      if (st.state !== 'ended') again()
    }
  }
  function again() { if (closed) return; set('connecting'); timer = setTimeout(connect, Math.min(15000, 800 * 2 ** retry++)) }
  const send = (m) => { if (ws?.readyState === 1) { ws.send(JSON.stringify(m)); return true } return false }

  connect()
  return {
    st,
    on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => handlers.get(type)?.delete(fn) },
    // a view that shows now: its stream from the start (replay — a view mounted again gets it again)
    subscribe(list, { replay = false } = {}) {
      const fresh = list.filter((x) => !want.has(x))
      for (const x of list) want.add(x)
      if (fresh.length || replay) send({ type: 'subscribe', streams: list, replay })
    },
    send,
    close() { closed = true; clearTimeout(timer); try { ws?.close() } catch { /* gone */ } ws = null },
  }
}
