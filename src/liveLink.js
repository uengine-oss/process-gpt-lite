// The page's half of live co-editing (server/lib/craftLive.js): a websocket (one-time ticket, same
// origin) that tells the server what is open here. For an ArtCraft app the agent's control
// requests come back over it as {type:'call'} and `onCall` runs them on the app in the iframe; for
// IeumOffice it only says what is open (office-host has its own live sessions). Reconnects while
// `alive()`; `close()` ends it for good.
import { api } from './api.js'

export function openLiveLink({ app, file, editor, onCall, onState, alive = () => true }) {
  let ws = null
  let retry = null
  let closed = false
  let name = file
  async function connect() {
    if (closed || ws || !alive()) return
    clearTimeout(retry)
    let ticket
    try { ticket = (await api('/craft/live/ticket', { method: 'POST' })).ticket } catch { retry = setTimeout(connect, 5000); return }
    if (closed) return
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/craft/live?ticket=${encodeURIComponent(ticket)}`)
    ws = sock
    sock.onopen = () => sock.send(JSON.stringify({ type: 'open', app, file: name, editor }))
    sock.onmessage = async (e) => {
      let m
      try { m = JSON.parse(e.data) } catch { return }
      if (m.type === 'live') onState?.(true)
      if (m.type !== 'call' || !onCall) return
      try {
        const result = await onCall(m.method, m.params || {})
        sock.readyState === 1 && sock.send(JSON.stringify({ type: 'reply', id: m.id, result: result ?? null }))
      } catch (err) {
        sock.readyState === 1 && sock.send(JSON.stringify({ type: 'reply', id: m.id, error: String(err?.message || err) }))
      }
    }
    sock.onclose = () => {
      if (ws === sock) ws = null
      onState?.(false)
      if (!closed && alive()) retry = setTimeout(connect, 3000)
    }
  }
  connect()
  return {
    // the file now open (after a save the card points at the edited copy)
    rename(file) { name = file; ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'file', file })) },
    close() { closed = true; clearTimeout(retry); const s = ws; ws = null; s?.close() },
    get open() { return !!ws && ws.readyState === 1 },
  }
}
