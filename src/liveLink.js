// The page's half of live co-editing (server/lib/craftLive.js): a websocket (one-time ticket, same
// origin) that tells the server what is open here. For an ArtCraft app the agent's control
// requests come back over it as {type:'call'} and `onCall` runs them on the app in the iframe; for
// IeumOffice it only says what is open (office-host has its own live sessions). Reconnects while
// `alive()`; `close()` ends it for good.
// Joined is the server's {type:'live'}, not the socket opening (a gateway in front opens it and closes
// it with 1002 when the server refused). An attempt that does not get there in CONNECT_MS counts as
// failed; after MAX_FAILS in a row it stops and `onFail(reason)` says why — `retry()` starts again.
// A link that was joined and then dropped (the server restarting for a deploy — production 2026-11-25: the
// badge went 「연결 안 됨」 a minute into a turn, the Lite server pod being replaced; the network) is not a
// failure to set up: it keeps joining again by itself while the page is open, `onRetrying(true)` meanwhile,
// sooner when the browser is back online or the tab is shown again.
import { api } from './api.js'
import { BASE } from './base.js'

const MAX_FAILS = 3
const CONNECT_MS = 10_000
// joining again after a drop: soon, then less often (a server restart takes 30–90 s)
const REJOIN_MS = [1000, 2000, 3000, 5000, 8000, 10_000]
const TIMEOUT_WHY = '서버가 연결에 응답하지 않아요 — 서버 앞단(게이트웨이)이 웹소켓을 넘겨 주는지 확인이 필요해요'

export function openLiveLink({ app, file, editor, onCall, onState, onFail, onRetrying, alive = () => true }) {
  let ws = null
  let again = null
  let closed = false
  let name = file
  let fails = 0
  let why = ''
  let joinedOnce = false
  let rejoins = 0
  function failed(reason, final = false) {
    why = reason || why || TIMEOUT_WHY
    if (closed || !alive()) return
    // a link that worked before: joined again by itself, however long the server is away (a refusal still stops it)
    if (joinedOnce && !final) { rejoin(); return }
    // (a page with nowhere to show the failure — an ArtCraft frame — keeps trying, more slowly)
    if ((final || ++fails >= MAX_FAILS) && onFail) { onRetrying?.(false); onFail(why); return }
    again = setTimeout(connect, Math.min(30_000, 3000 + fails * 2000))
  }
  function rejoin() {
    onRetrying?.(true)
    clearTimeout(again)
    again = setTimeout(connect, REJOIN_MS[Math.min(rejoins++, REJOIN_MS.length - 1)])
  }
  // back online, or the tab shown again: try now rather than at the next turn of the wait
  const soon = () => { if (!closed && !ws && joinedOnce && alive() && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) { clearTimeout(again); connect() } }
  if (typeof window !== 'undefined') { window.addEventListener('online', soon); document.addEventListener('visibilitychange', soon) }
  let asking = false
  async function connect() {
    if (closed || ws || asking || !alive()) return
    clearTimeout(again)
    let ticket
    asking = true
    try { ticket = (await api('/craft/live/ticket', { method: 'POST' })).ticket } catch (e) { return failed(`연결 표를 받지 못했어요 (${e.status || e.message})`) } finally { asking = false }
    if (closed) return
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE}/api/craft/live?ticket=${encodeURIComponent(ticket)}`)
    ws = sock
    let joined = false, denied = ''
    const timer = setTimeout(() => { if (ws === sock && !joined) { ws = null; sock.close(); onState?.(false); failed(TIMEOUT_WHY) } }, CONNECT_MS)
    sock.onopen = () => sock.send(JSON.stringify({ type: 'open', app, file: name, editor }))
    sock.onmessage = async (e) => {
      let m
      try { m = JSON.parse(e.data) } catch { return }
      if (m.type === 'live') { joined = true; joinedOnce = true; rejoins = 0; clearTimeout(timer); fails = 0; why = ''; onRetrying?.(false); onState?.(true) }
      // refused by the server (4401 ticket, 4403 origin), with its reason
      if (m.type === 'denied' || m.type === 'error') denied = m.reason || m.message || denied
      if (m.type !== 'call' || !onCall) return
      try {
        const result = await onCall(m.method, m.params || {})
        sock.readyState === 1 && sock.send(JSON.stringify({ type: 'reply', id: m.id, result: result ?? null }))
      } catch (err) {
        sock.readyState === 1 && sock.send(JSON.stringify({ type: 'reply', id: m.id, error: String(err?.message || err) }))
      }
    }
    sock.onclose = (e) => {
      clearTimeout(timer)
      if (ws !== sock) return
      ws = null
      onState?.(false)
      if (closed || !alive()) return
      // it was joined: the link dropped (server restart, network) — join again, by itself
      if (joined) { rejoin(); return }
      failed(denied || (e.code === 1002 || e.code === 1006 ? '서버가 연결을 받지 않았어요' : `연결이 끊겼어요 (${e.code})`), !!denied && e.code !== 4401)
    }
  }
  connect()
  return {
    // the file now open (after a save the card points at the edited copy)
    rename(file) { name = file; ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'file', file })) },
    close() {
      closed = true; clearTimeout(again); const s = ws; ws = null; s?.close()
      if (typeof window !== 'undefined') { window.removeEventListener('online', soon); document.removeEventListener('visibilitychange', soon) }
    },
    retry() { if (closed) return; clearTimeout(again); fails = 0; rejoins = 0; why = ''; const s = ws; ws = null; s?.close(); connect() },
    get open() { return !!ws && ws.readyState === 1 },
  }
}
