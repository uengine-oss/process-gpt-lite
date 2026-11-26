// A push service of its own for the tests (no real push service, no real device is ever reached): an http server on this machine that
// takes what lib/webpush.js sends — the VAPID Authorization, the aes128gcm body (RFC 8291 / RFC 8188) — and reads it back with the
// subscription's own private key, as a browser would. Used by server/test/pushHitl.integration.test.js and
// e2e/tests/feature/push-hitl.spec.js.
//   const P = await startFakePush(); const sub = P.subscription('a')   // {endpoint, keys: {p256dh, auth}}
//   … the server pushes … → P.received: [{ who: 'a', payload: {…}, headers }]
import http from 'node:http'
import crypto from 'node:crypto'

const hkdf = (ikm, salt, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n))

/** one aes128gcm record (RFC 8188) for the subscription whose private key is `ecdh` and auth secret `auth` → the plaintext */
export function decryptPush(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const ct = body.subarray(21 + idlen)
  const uaPublic = ecdh.getPublicKey()
  const ikm = hkdf(ecdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  let end = pt.length - 1
  while (end >= 0 && pt[end] === 0) end--
  // the last record ends with the delimiter 2
  if (pt[end] !== 2) throw new Error('no record delimiter')
  return pt.subarray(0, end)
}

export async function startFakePush({ host = '127.0.0.1' } = {}) {
  const subs = new Map() // who → {ecdh, auth}
  const received = []
  const waiters = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const who = decodeURIComponent(String(req.url || '').replace(/^\/push\//, ''))
      const s = subs.get(who)
      if (!s) { res.writeHead(410); return res.end() }
      try {
        const payload = JSON.parse(decryptPush(Buffer.concat(chunks), s).toString('utf8'))
        received.push({ who, payload, headers: req.headers })
        for (const w of waiters.splice(0)) w()
        res.writeHead(201); res.end()
      } catch (e) { res.writeHead(400); res.end(String(e.message)) }
    })
  })
  await new Promise((ok) => server.listen(0, host, ok))
  const base = `http://${host}:${server.address().port}`
  return {
    received,
    /** a subscription as a browser would give it, for `who` (its endpoint is this server) */
    subscription(who) {
      const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys()
      const auth = crypto.randomBytes(16)
      subs.set(who, { ecdh, auth })
      return { endpoint: `${base}/push/${encodeURIComponent(who)}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }
    },
    /** what `who` has received, waiting up to ms for at least n */
    async payloads(who, n = 1, ms = 15000) {
      const end = Date.now() + ms
      for (;;) {
        const got = received.filter((r) => r.who === who).map((r) => r.payload)
        if (got.length >= n || Date.now() > end) return got
        await new Promise((ok) => { waiters.push(ok); setTimeout(ok, 200) })
      }
    },
    close: () => new Promise((ok) => server.close(ok)),
  }
}
