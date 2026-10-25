// 기동·인증 — 서버가 살아 있고, 데모 로그인·세션 갱신·거절이 맞게 동작한다.
import { test, expect, api } from '../../lib/fixtures.js'
import { API_URL, PGPT_URL } from '../../lib/env.js'

test.describe('기동과 인증', () => {
  test('S-01 /api/config 는 비밀 없이 기능 플래그와 보관함 키 식별만 준다', async () => {
    const r = await api.call(null, 'GET', '/config')
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('demoLogin')
    expect(r.body.vault).toMatchObject({ algorithm: expect.stringContaining('AES-256-GCM') })
    expect(r.text).not.toMatch(/"kek"\s*:\s*"[A-Za-z0-9+/=]{40,}"/)
  })

  test('S-02 웹 앱(SPA)이 뜬다', async ({ request }) => {
    const r = await request.get(`${PGPT_URL}/`)
    expect(r.status()).toBe(200)
    expect(await r.text()).toContain('<div id="app"')
  })

  test('S-03 데모 로그인 → /api/me, 토큰 없거나 틀리면 401', async () => {
    const s = await api.login('smoke', { fresh: true })
    expect(s.session.access_token).toBeTruthy()
    const me = await api.call(s.session.access_token, 'GET', '/me')
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe('pro-rt-smoke@uengine.org')
    expect((await api.call(null, 'GET', '/me')).status).toBe(401)
    expect((await api.call('not-a-jwt', 'GET', '/me')).status).toBe(401)
  })

  test('S-04 틀린 로그인 코드는 거절', async () => {
    const r = await api.call(null, 'POST', '/auth/email/verify', { email: 'pro-rt-smoke@uengine.org', code: '123456' })
    expect(r.status).toBe(400)
  })

  test('S-05 세션 갱신(refresh) 으로 새 토큰을 받고 그 토큰이 통한다', async () => {
    const s = await api.login('smoke')
    const r = await api.call(null, 'POST', '/auth/refresh', { refresh_token: s.session.refresh_token })
    expect(r.status).toBe(200)
    expect(r.body.access_token).toBeTruthy()
    expect((await api.call(r.body.access_token, 'GET', '/me')).status).toBe(200)
  })

  test('S-06 실시간 이벤트(SSE) 가 hello 를 보낸다', async () => {
    const s = await api.login('smoke')
    const ctl = new AbortController()
    const r = await fetch(`${API_URL}/api/events?token=${encodeURIComponent(s.session.access_token)}`, { signal: ctl.signal })
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    const reader = r.body.getReader()
    let got = ''
    const t0 = Date.now()
    while (!got.includes('event: hello') && Date.now() - t0 < 8000) got += new TextDecoder().decode((await reader.read()).value || new Uint8Array())
    ctl.abort()
    expect(got).toContain('event: hello')
  })

  test('S-07 SSE 를 못 쓰는 경로용 롱폴링(/api/events/poll)', async () => {
    const s = await api.login('smoke')
    // after=0 returns at once when there are newer events, otherwise waits (≤25 s) and returns empty
    const r = await api.call(s.session.access_token, 'GET', '/events/poll?after=0', null, { timeout: 40_000 })
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('seq')
    expect(Array.isArray(r.body.events)).toBe(true)
  })
})
