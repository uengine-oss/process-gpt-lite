// A direct call to process-gpt's office-mcp (generate_hwpx …) for work this server starts on its
// own (lib/mail.js drafts). Filling a template takes minutes, past fetch's 5-minute header wait, so
// the streamable-HTTP exchange is done over node:http without a deadline of its own.
import http from 'node:http'
import { config } from '../config.js'

function post(url, body, session) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: 20 * 60_000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) } }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        // an SSE stream ("data: {…}") or plain JSON
        const json = data.includes('data:') ? data.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop() : data
        let parsed = null
        try { parsed = json ? JSON.parse(json) : null } catch { /* notifications answer with nothing */ }
        resolve({ status: res.statusCode, session: res.headers['mcp-session-id'], body: parsed })
      })
    })
    req.on('timeout', () => req.destroy(new Error('office-mcp: no answer in 20 minutes')))
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

export async function callOfficeMcp(tool, args) {
  const url = `${config.officeMcpUrl.replace(/\/$/, '')}/mcp`
  const init = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pgpt-pro', version: '1.0.0' } } })
  if (init.status >= 400) throw new Error(`office-mcp initialize ${init.status}`)
  await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.session)
  const r = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }, init.session)
  const result = r.body?.result
  if (!result || result.isError) throw new Error(`office-mcp ${tool}: ${JSON.stringify(r.body?.error || result?.content || r.status).slice(0, 300)}`)
  const sc = result.structuredContent
  if (sc) return sc.result ?? sc
  const text = (result.content || []).find((c) => c.type === 'text')?.text
  try { return JSON.parse(text) } catch { return { text } }
}
