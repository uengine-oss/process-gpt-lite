// 한 사람의 세션을 동시에 여러 번 만들 때(같은 분에 시작하는 루틴 둘): 새 로그인 링크가 앞 링크를 무효로 해
// 하나가 otp_expired 로 실패하던 것(운영 11-22 08:00 · 09:00). 실제 로컬 Supabase 로 원인과 고침을 본다.
//   cd server && node --test test/session-mint.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const { sessionFor, admin, q, pool } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const EMAIL = `pro-mint-race-${Date.now()}@uengine.org`

after(async () => {
  const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 }).catch(() => ({ data: { users: [] } }))
  for (const u of listed.data?.users || []) if (u.email === EMAIL) {
    await q('delete from users where id=$1', [u.id]).catch(() => {})
    await admin.auth.admin.deleteUser(u.id).catch(() => {})
  }
  await pool.end().catch(() => {})
})

const verify = async (hash) => (await fetch(`${config.supabaseUrl}/auth/v1/verify`, {
  method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: hash }),
})).json()

test('원인: 같은 사람의 로그인 링크를 둘 만들면 앞의 것은 otp_expired', async () => {
  await sessionFor(EMAIL, '시험') // (사람을 만든다)
  const a = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
  const b = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
  const first = await verify(a.data.properties.hashed_token)
  assert.equal(first.error_code, 'otp_expired', JSON.stringify(first).slice(0, 120))
  assert.ok((await verify(b.data.properties.hashed_token)).access_token)
})

test('고침: 같은 사람의 세션을 동시에 다섯 번 만들어도 모두 받는다(각자 다른 세션)', async () => {
  const got = await Promise.all(Array.from({ length: 5 }, () => sessionFor(EMAIL, '시험')))
  assert.ok(got.every((g) => g.session.access_token), '모두 세션을 받았다')
  assert.equal(new Set(got.map((g) => g.session.refresh_token)).size, 5, '세션은 각자의 것(갱신 토큰을 나누지 않는다)')
})
