// A response that streams server-sent events while the work behind it may take minutes. The first
// word of an agent's answer can come after more than 100 s, and a proxy in front (Cloudflare) cuts
// a response that has sent nothing for that long (524). So the headers and a comment go at once,
// and a comment every `every` ms after that; clients skip comment lines.
export function openStream(res, { every = 20000 } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' })
  res.write(': ok\n\n')
  const ping = setInterval(() => res.write(': ping\n\n'), every)
  res.on('close', () => clearInterval(ping))
  return {
    send: (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
    end: () => { clearInterval(ping); res.end() },
  }
}
