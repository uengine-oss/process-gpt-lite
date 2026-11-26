// authEmailOf (lib/supa.js): the auth server's own address for an account, cached for a few minutes.
// supabase-js answers an outage with { error } instead of throwing — that must not be cached, or notices
// addressed by email are dropped for minutes after the auth server is back (re-review of #89, 2026-11-26).
// Run: node --test test/authEmailOf.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { admin, authEmailOf } from '../lib/supa.js'

test('AE-01 an outage answer is not cached; the next real answer is used at once, and then cached', async () => {
  const real = admin.auth.admin.getUserById
  const id = '00000000-0000-4000-8000-0000000000ae'
  let calls = 0
  let mode = 'down'
  admin.auth.admin.getUserById = async () => {
    calls++
    if (mode === 'down') return { data: { user: null }, error: new Error('auth server unavailable') }
    if (mode === 'throw') throw new Error('socket hang up')
    return { data: { user: { id, email: 'Person@Example.TEST' } }, error: null }
  }
  try {
    assert.equal(await authEmailOf(id), null, 'no address while the auth server is down')
    mode = 'throw'
    assert.equal(await authEmailOf(id), null, 'a thrown error is no answer either')
    mode = 'up'
    assert.equal(await authEmailOf(id), 'person@example.test', 'asked again once it is back — not a cached null')
    assert.equal(calls, 3)
    mode = 'down'
    assert.equal(await authEmailOf(id), 'person@example.test', 'a real answer is cached')
    assert.equal(calls, 3)
  } finally {
    admin.auth.admin.getUserById = real
  }
})
