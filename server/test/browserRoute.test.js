// Where a browser task runs, the part that needs no browser (lib/browserRemote.js liteOwnPage · routeOf startUrl): a task that
// starts on a page of this Lite server itself stays in this server's browser ('lite-page') — the PC's agent browser does not open
// the Lite it is linked to (desktop/src/policy.js agentMay). The rest of routeOf is in browserDriver.test.js (with a real browser).
//   cd server && node --test test/browserRoute.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

// (this server's addresses for routeOf's defaults, before config.js is read)
process.env.PRO_PUBLIC_URL = 'https://lite.example.com'
process.env.PRO_TENANT_FROM_HEADER = '0'
process.env.PRO_TENANT_HOSTS = ''
const { liteOwnPage, routeOf } = await import('../lib/browserRemote.js')

test('this Lite server\'s own page: the same host on the same port as its public or tenant address', () => {
  const at = { publicUrl: 'https://lite.example.com', tenantUrl: 'https://en.lite.example.com', gateway: false }
  for (const u of ['https://lite.example.com/s/abc', 'https://LITE.example.com./', 'http://lite.example.com/share', 'https://lite.example.com:443/x',
    'wss://lite.example.com/api/workroom/term', 'https://en.lite.example.com/chat']) assert.equal(liteOwnPage(u, at), true, u)
  for (const u of ['https://lite.example.com:8443/', 'https://other.example.com/', 'https://shop.lite.example.com.evil.example/', 'https://example.com/',
    'ftp://lite.example.com/', 'file:///etc/hosts', 'javascript:alert(1)', 'not a url', '', null]) assert.equal(liteOwnPage(u, at), false, String(u))
  // a public address on a port of its own: that port, by either scheme
  const dev = { publicUrl: 'http://lite.test:5180', tenantUrl: null, gateway: false }
  assert.equal(liteOwnPage('https://lite.test:5180/x', dev), true)
  assert.equal(liteOwnPage('http://lite.test/x', dev), false)
  assert.equal(liteOwnPage('http://lite.test:8787/x', dev), false)
})

test('behind the ProcessGPT gateway: the public host\'s siblings under the same parent domain too', () => {
  const gw = { publicUrl: 'https://uengine.process-gpt.io/lite', tenantUrl: null, gateway: true }
  assert.equal(liteOwnPage('https://ohsy.process-gpt.io/lite/s/1', gw), true)
  assert.equal(liteOwnPage('https://uengine.process-gpt.io/lite', gw), true)
  assert.equal(liteOwnPage('https://process-gpt.io.evil.example/', gw), false)
  assert.equal(liteOwnPage('https://ohsy.process-gpt.io:8443/', gw), false)
  assert.equal(liteOwnPage('https://ohsy.process-gpt.io/lite/s/1', { ...gw, gateway: false }), false, 'only behind the gateway')
  // a parent of one label is not a company's address
  assert.equal(liteOwnPage('https://b.example/', { publicUrl: 'https://a.example', gateway: true }), false)
})

test('a server on this machine: any loopback name on the same port', () => {
  const local = { publicUrl: 'http://localhost:5180', tenantUrl: null, gateway: false }
  for (const u of ['http://127.0.0.1:5180/s/1', 'http://[::1]:5180/', 'http://en.localhost:5180/', 'https://localhost:5180/', 'http://127.1.2.3:5180/',
    'http://[::ffff:127.0.0.1]:5180/', 'http://localhost.:5180/']) assert.equal(liteOwnPage(u, local), true, u)
  for (const u of ['http://127.0.0.1:5181/', 'http://localhost/', 'http://10.0.0.5:5180/', 'http://lite.example.com:5180/']) assert.equal(liteOwnPage(u, local), false, u)
  // a public address that is not loopback does not take loopback names
  assert.equal(liteOwnPage('http://127.0.0.1/', { publicUrl: 'https://lite.example.com', gateway: false }), false)
})

test('routeOf: a task that starts on this Lite server\'s own page runs in this server\'s browser (lite-page)', () => {
  const pc = { id: 'pc1', name: 'PC', since: 1, caps: { browser: true }, prefs: { browser: 'all' } }
  assert.deepEqual(routeOf({ links: [pc], own: true, startUrl: 'https://lite.example.com/s/abc' }), { kind: 'server', why: 'lite-page' })
  assert.deepEqual(routeOf({ links: [pc], own: false, startUrl: 'http://lite.example.com/x' }), { kind: 'server', why: 'lite-page' })
  assert.equal(routeOf({ links: [pc], own: true, startUrl: 'https://shop.example/' }).kind, 'local')
  assert.equal(routeOf({ links: [pc], own: true }).kind, 'local')
  // a task the PC would not take anyway keeps its own reason
  assert.deepEqual(routeOf({ links: [], startUrl: 'https://lite.example.com/s/abc' }), { kind: 'server', why: 'no-desktop' })
  assert.deepEqual(routeOf({ links: [{ ...pc, prefs: { browser: 'off' } }], startUrl: 'https://lite.example.com/' }), { kind: 'server', why: 'off' })
})
