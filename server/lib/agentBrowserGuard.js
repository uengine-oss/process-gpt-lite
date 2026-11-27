// The browser the agent drives on the person's PC (desktop app, desktop/src/browser) marks every request it makes with
// X-PGL-Agent-Browser. This server serves none of them: not its API, not its sign-in, not its MCP endpoints, not the ArtCraft
// apps, not its live links (websockets) —
// a task works on other sites in that browser, never in Lite as the person. Lite itself is used in the app's own window or
// a web browser. (A task that starts on a page of this server runs in this server's browser instead: lib/browserRemote.js
// liteOwnPage.)
import { resolveLang, withLang, L } from './lang.js'

// (Node gives header names in lower case)
export const AGENT_BROWSER_HEADER = 'x-pgl-agent-browser'
export const fromAgentBrowser = (req) => {
  const v = req?.headers?.[AGENT_BROWSER_HEADER]
  return v != null && String(v).trim() !== ''
}

const refusal = () => ({
  error: L('에이전트 브라우저에서 온 요청은 받지 않아요. Process GPT Lite 는 앱 창이나 웹 브라우저에서 쓰세요.',
    "Requests from the agent's browser are not accepted. Use Process GPT Lite in the app's window or a web browser."),
  code: 'agent_browser',
})
// the request's language: its X-PGL-Lang header, or ?lang= (a websocket or an EventSource sends no header of its own)
const langOf = (req) => {
  let q
  try { q = new URL(req.url || '/', 'http://x').searchParams.get('lang') } catch {}
  return resolveLang({ header: req.headers['x-pgl-lang'] || q || undefined })
}

// every route (index.js mounts it ahead of all of them): a marked request gets 403 { error, code: 'agent_browser' } and goes no further
export function refuseAgentBrowser(req, res, next) {
  if (!fromAgentBrowser(req)) return next()
  withLang(langOf(req), () => res.status(403).set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).json(refusal()))
}

// Websockets come to the server, not to Express: a marked upgrade is answered 403 and closed before any upgrade listener
// (the workroom's terminals, the desktops' links, ArtCraft live, meeting voice) is called.
export function guardUpgrades(server) {
  const emit = server.emit
  server.emit = function (event, req, socket, ...rest) {
    if (event !== 'upgrade' || !fromAgentBrowser(req)) return emit.call(this, event, req, socket, ...rest)
    const body = JSON.stringify(withLang(langOf(req), refusal))
    socket.on('error', () => {})
    socket.once('finish', () => socket.destroy())
    socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    return true
  }
  return server
}
