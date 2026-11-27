// Upload routes read their body after the sign-in check (auth, then express.raw — index.js /api/attachments, routes/team.js /team/uploads,
// routes/folders.js /folders/:slug/files, meetings · dictation · profile picture · ontology documents). The request's context that auth
// sets (the tenant, lib/tenant.js withTenant) must still be there when the handler runs after the body arrived in pieces.
//   node --test test/bodyAfterAuth.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

// a second company by host name, so the tenant auth sets differs from the server's own
process.env.PRO_TENANT_HOSTS = 'acme.localhost=body-after-auth-test'
const { withTenant } = await import('../lib/tenant.js')
const { config } = await import('../config.js')

test('a body read after auth keeps the tenant auth set, and an unsigned request is answered before its body comes', async () => {
  const app = express()
  const auth = (req, res, next) => (req.headers.authorization ? setTimeout(() => withTenant('body-after-auth-test', () => { req.seen = config.tenantId; next() }), 5) : res.status(401).json({ error: 'unauthorized' }))
  app.post('/up', auth, express.raw({ type: () => true, limit: '5mb' }), (req, res) => res.json({ tenant: config.tenantId, before: req.seen, n: req.body.length }))
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)) })
  try {
    const url = `http://127.0.0.1:${server.address().port}/up`
    // the body in pieces, a little late each
    const body = new ReadableStream({ async start(c) { for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 15)); c.enqueue(new Uint8Array(4096)) } c.close() } })
    const r = await fetch(url, { method: 'POST', body, duplex: 'half', headers: { Authorization: 'Bearer x' } })
    const j = await r.json()
    assert.equal(j.n, 6 * 4096)
    assert.equal(j.before, 'body-after-auth-test')
    assert.equal(j.tenant, 'body-after-auth-test')
    // not signed in: the answer does not wait for a body that never ends
    const t0 = Date.now()
    const never = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024)) } })
    const ctl = new AbortController()
    const r2 = await fetch(url, { method: 'POST', body: never, duplex: 'half', signal: ctl.signal })
    assert.equal(r2.status, 401)
    assert.ok(Date.now() - t0 < 2000)
    ctl.abort()
  } finally { server.closeAllConnections?.(); server.close() }
})
