// Google sign-in behind the ProcessGPT gateway through its Supabase project (2026-11-18), without a network:
//   - /api/config says sso.google only behind the gateway and only when the project's Google provider is on
//   - the page takes the session from the fragment Supabase comes back with, or its error
import test from 'node:test'
import assert from 'node:assert/strict'

const { config } = await import('../config.js')
const { refreshSso, ssoInfo } = await import('../lib/sso.js')
const { sessionFromFragment } = await import('../../src/authFragment.js')

const settings = (google) => async (url, opts) => {
  assert.match(url, /\/auth\/v1\/settings$/)
  assert.equal(opts.headers.apikey, 'anon-test')
  return { ok: true, json: async () => ({ external: { email: true, google } }) }
}

test('sso: Google through the project only behind the gateway and when its provider is on', async () => {
  const was = [config.tenantFromHeader, config.supabaseUrl, config.anonKey]
  try {
    config.supabaseUrl = 'https://proj.supabase.co/'; config.anonKey = 'anon-test'
    config.tenantFromHeader = false
    assert.equal(await refreshSso(settings(true)), false)
    assert.equal(ssoInfo(), null)
    config.tenantFromHeader = true
    assert.equal(await refreshSso(settings(false)), false)
    assert.equal(ssoInfo(), null)
    assert.equal(await refreshSso(settings(true)), true)
    assert.deepEqual(ssoInfo(), { google: 'https://proj.supabase.co/auth/v1/authorize?provider=google' })
    // a settings call that fails keeps what was known
    assert.equal(await refreshSso(async () => { throw new Error('down') }), true)
  } finally { [config.tenantFromHeader, config.supabaseUrl, config.anonKey] = was }
})

test('sso: the session from the fragment Supabase comes back with', () => {
  assert.deepEqual(sessionFromFragment('#access_token=a.b.c&expires_at=1794975108&expires_in=3600&provider_token=g&refresh_token=r1&token_type=bearer'),
    { session: { access_token: 'a.b.c', refresh_token: 'r1', expires_at: 1794975108 }, sso: true })
  assert.deepEqual(sessionFromFragment('#error=access_denied&error_code=403&error_description=Signups+not+allowed'), { error: 'Signups not allowed' })
  assert.equal(sessionFromFragment('#access_token=only'), null)
  assert.equal(sessionFromFragment(''), null)
  // Lite's own Google sign-in through the server: #<encoded JSON>
  const own = { user: { id: 'u' }, session: { access_token: 'x', refresh_token: 'y' } }
  assert.deepEqual(sessionFromFragment('#' + encodeURIComponent(JSON.stringify(own))), own)
})
