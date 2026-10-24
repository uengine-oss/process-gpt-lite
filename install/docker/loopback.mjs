// Loopback forward for images without socat (office-host): LOOPBACK_FORWARD="18080=web:80" makes
// http://localhost:18080 inside this container reach the web gateway, so the public URL that
// documents carry works from here too. Started before the service, then imports nothing else.
import net from 'node:net'
const spec = process.env.LOOPBACK_FORWARD || ''
if (spec.includes('=')) {
  const [port, target] = spec.split('=')
  const [host, tport] = target.split(':')
  net.createServer((c) => {
    const s = net.connect(Number(tport || 80), host)
    c.pipe(s).pipe(c)
    c.on('error', () => s.destroy()); s.on('error', () => c.destroy())
  }).listen(Number(port), '127.0.0.1')
}
