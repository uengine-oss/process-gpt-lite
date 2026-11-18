// Web Push without a package (lib/webpush.js, 2026-11-18): the message encryption is RFC 8291's own
// example byte for byte, the VAPID token verifies with the public key it names (RFC 8292), and a
// subscription that is not a push service's https endpoint with keys is refused.
// Run: node --test test/webpush.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

process.env.PRO_VAPID_FILE = path.join(os.tmpdir(), `pgl-vapid-test-${process.pid}.json`)
const W = await import('../lib/webpush.js')

test('암호화: RFC 8291 부록 A 의 예시와 바이트 단위로 같다', () => {
  const out = W.encrypt(Buffer.from('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', 'base64url'),
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' })
  assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN')
})

test('VAPID: 푸시 서비스 주소의 origin 에 대한 ES256 토큰, 함께 보낸 공개 키로 검증된다', () => {
  const h = W.vapidAuth('https://fcm.googleapis.com/fcm/send/abc', { subject: 'https://example.com/lite' })
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)
  assert.ok(m, h)
  const body = JSON.parse(Buffer.from(m[2], 'base64url'))
  assert.equal(body.aud, 'https://fcm.googleapis.com')
  assert.equal(body.sub, 'https://example.com/lite')
  assert.ok(body.exp > Date.now() / 1000 && body.exp <= Date.now() / 1000 + 24 * 3600)
  const pub = Buffer.from(m[4], 'base64url')
  assert.equal(pub.length, 65)
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') } })
  assert.equal(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')), true)
  // the same key on the next start (kept in the file)
  assert.equal(W.vapidKeys().publicKey, m[4])
})

test('구독: https 푸시 서비스 주소와 키가 없으면 받지 않는다', async () => {
  for (const sub of [null, { endpoint: 'http://push.example/x', keys: { p256dh: 'a', auth: 'b' } }, { endpoint: 'https://push.example/x', keys: {} }])
    await assert.rejects(W.subscribe({ id: '00000000-0000-0000-0000-000000000000' }, sub), (e) => e.status === 400)
})
