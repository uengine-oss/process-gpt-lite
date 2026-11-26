// Every /api answer is data, never a page that runs on this origin (2026-11-26 review): nosniff on all, and a sandboxed
// policy with no scripts unless it is a PDF or the route set its own. fetch · <img> · <video> are unaffected by these headers.
//   cd server && node --test test/apiHeaders.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { apiHeaders, API_CSP } from '../lib/apiHeaders.js'

async function serve() {
  const app = express()
  app.use('/api', apiHeaders)
  app.get('/api/xml', (req, res) => res.type('application/xml').send('<x:script xmlns:x="http://www.w3.org/1999/xhtml">1</x:script>'))
  app.get('/api/svg', (req, res) => { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end('<svg/>') })
  app.get('/api/pdf', (req, res) => res.type('application/pdf').send('%PDF-1.4'))
  app.get('/api/own', (req, res) => res.set('Content-Security-Policy', "sandbox allow-same-origin").type('text/html').send('<p>x</p>'))
  app.get('/api/json', (req, res) => res.json({ ok: true }))
  app.get('/other', (req, res) => res.type('text/html').send('<p>app page</p>'))
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

test('API answers: nosniff always, a no-script sandbox unless PDF or the route has its own policy', async () => {
  const s = await serve()
  try {
    const h = async (p) => (await fetch(s.base + p)).headers
    for (const p of ['/api/xml', '/api/svg', '/api/json']) {
      const r = await h(p)
      assert.equal(r.get('x-content-type-options'), 'nosniff', p)
      assert.equal(r.get('content-security-policy'), API_CSP, p)
    }
    const pdf = await h('/api/pdf')
    assert.equal(pdf.get('x-content-type-options'), 'nosniff')
    assert.equal(pdf.get('content-security-policy'), null, 'the PDF viewer needs it')
    assert.equal((await h('/api/own')).get('content-security-policy'), 'sandbox allow-same-origin', 'the route\'s own policy stays')
    const other = await h('/other')
    assert.equal(other.get('content-security-policy'), null, 'not an /api answer')
  } finally { s.close() }
})
