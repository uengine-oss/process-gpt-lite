import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { googleAuthUrl, googleExchange } from '../lib/mail.js'

test('login requests identity only and binds authorization to PKCE', () => {
  const url = new URL(googleAuthUrl('state', { verifier: 'verifier' }))
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  assert.equal(url.searchParams.get('state'), 'state')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), crypto.createHash('sha256').update('verifier').digest('base64url'))
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5180/api/auth/google/callback')
  assert.equal(url.searchParams.has('access_type'), false)
})

test('mail connection explicitly requests offline Gmail access', () => {
  const params = new URL(googleAuthUrl('state', { connectMail: true })).searchParams
  assert.ok(params.get('scope').includes('https://www.googleapis.com/auth/gmail.readonly'))
  assert.equal(params.get('access_type'), 'offline')
  assert.equal(params.get('prompt'), 'consent')
})

test('code exchange rejects unverified identity and forwards PKCE verifier', async () => {
  const original = globalThis.fetch
  try {
    let calls = 0
    globalThis.fetch = async (url, options) => {
      if (calls++ === 0) {
        assert.equal(options.body.get('code_verifier'), 'verifier')
        return Response.json({ access_token: 'test-token' })
      }
      return Response.json({ sub: 'id', email: 'test@example.com', email_verified: false })
    }
    await assert.rejects(googleExchange('code', 'verifier'), /확인된 이메일/)
    globalThis.fetch = async () => Response.json({ error: 'invalid_grant' }, { status: 400 })
    await assert.rejects(googleExchange('bad-code', 'verifier'), /인증 코드를/)
  } finally { globalThis.fetch = original }
})
