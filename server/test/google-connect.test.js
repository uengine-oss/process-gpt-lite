// Google 연결 (2026-11-22): the company's own OAuth client in the vault, the address a connection
// starts from and comes back to, and the state that ties a callback to the browser that started it.
//   node --test test/google-connect.test.js   (needs the local database)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { q, pool } from '../lib/supa.js'
import * as gc from '../lib/googleConnect.js'
import { companySubject, clientFor, clientInfo, saveClient, removeClient, clientById } from '../lib/googleClient.js'

const TENANT = 'pro-gc-unit'
const subject = companySubject(TENANT)
const saved = { publicUrl: config.publicUrl, gateway: config.tenantFromHeader, id: config.google.clientId, secret: config.google.clientSecret }
const restore = () => Object.assign(config, { publicUrl: saved.publicUrl, tenantFromHeader: saved.gateway }) && Object.assign(config.google, { clientId: saved.id, clientSecret: saved.secret })

after(async () => {
  restore()
  await q('delete from pro_vault_items where user_id=$1', [subject])
  await q('delete from pro_vault_keys where user_id=$1', [subject])
  await q('delete from pro_vault_audit where user_id=$1', [subject])
  await pool.end()
})

test('회사 주체: 테넌트마다 다르고 늘 같은 UUID, 사람의 v4 UUID 와 겹치지 않는 v5 꼴', () => {
  assert.equal(companySubject(TENANT), companySubject(TENANT))
  assert.notEqual(companySubject(TENANT), companySubject('uengine'))
  assert.match(subject, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('게이트웨이: 회사 주소에서만 시작하고, 리디렉션·쿠키 경로는 공개 경로(/lite) 기준', () => {
  Object.assign(config, { tenantFromHeader: true, publicUrl: 'https://www.process-gpt.io/lite' })
  try {
    assert.equal(gc.pageBase('https://uengine.process-gpt.io'), 'https://uengine.process-gpt.io/lite')
    assert.equal(gc.redirectUriOf(gc.pageBase('https://uengine.process-gpt.io')), 'https://uengine.process-gpt.io/lite/api/auth/google/callback')
    assert.equal(gc.cookiePath(), '/lite/api/auth/google')
    assert.equal(gc.pageBase('https://evil.example.com'), null)
    assert.equal(gc.pageBase('https://uengine.process-gpt.io.evil.com'), null)
    assert.equal(gc.pageBase('javascript:alert(1)'), null)
    assert.equal(gc.pageBase(''), null)
    const c = gc.cookieFor('https://uengine.process-gpt.io/lite', 'S', 'phone')
    assert.deepEqual([c.domain, c.path, c.secure, c.httpOnly, c.sameSite], ['uengine.process-gpt.io', '/lite/api/auth/google', true, true, 'Lax'])
  } finally { restore() }
})

test('설치형: 페이지 주소와 상관없이 이 설치의 주소(PRO_PUBLIC_URL)', () => {
  Object.assign(config, { tenantFromHeader: false, publicUrl: 'http://localhost:5180' })
  try {
    assert.equal(gc.pageBase('https://elsewhere.example.com'), 'http://localhost:5180')
    assert.equal(gc.cookiePath(), '/api/auth/google')
  } finally { restore() }
})

test('상태: 같은 브라우저의 쿠키와 같은 테넌트일 때 한 번만 쓰인다', () => {
  const { state } = gc.newState({ mode: 'phone', userId: 'u1', tenant: 't1', base: 'https://a.example.com/lite', lang: 'ko' })
  const cookie = `x=1; ${gc.STATE_COOKIE}=${state}; y=2`
  // someone else's browser (no cookie, another value): refused, and the state is not spent by it
  assert.throws(() => gc.takeState(state, '', 't1'), (e) => e instanceof gc.ConnectError && e.st === null)
  assert.throws(() => gc.takeState(state, `${gc.STATE_COOKIE}=other`, 't1'), (e) => e.st === null)
  const st = gc.takeState(state, cookie, 't1')
  assert.equal(st.userId, 'u1')
  assert.equal(st.redirectUri, 'https://a.example.com/lite/api/auth/google/callback')
  assert.ok(st.verifier.length >= 43)
  assert.throws(() => gc.takeState(state, cookie, 't1'), gc.ConnectError) // used once
  const other = gc.newState({ mode: 'phone', userId: 'u1', tenant: 't1', base: 'https://a.example.com/lite' })
  assert.throws(() => gc.takeState(other.state, `${gc.STATE_COOKIE}=${other.state}`, 't2'), (e) => e.st?.userId === 'u1')
})

test('회사 클라이언트: 보관함에 봉투 암호화, 비밀값은 화면에도 DB 행에도 없고, 회사 값 → env 순서', async () => {
  Object.assign(config.google, { clientId: 'env-client', clientSecret: 'env-secret' })
  try {
    assert.equal((await clientFor(TENANT)).source, 'env')
    const secret = `cs-${Math.random().toString(36).slice(2)}-${Date.now()}`
    const info = await saveClient(TENANT, { clientId: ' company-client.apps.googleusercontent.com ', clientSecret: secret }, 'admin-1')
    assert.deepEqual([info.using, info.company.clientId, info.env], ['company', 'company-client.apps.googleusercontent.com', true])
    assert.ok(!JSON.stringify(info).includes(secret))
    const c = await clientFor(TENANT)
    assert.deepEqual([c.source, c.clientId, c.clientSecret], ['company', 'company-client.apps.googleusercontent.com', secret])
    const rows = await q('select * from pro_vault_items where user_id=$1', [subject])
    assert.equal(rows.length, 1)
    assert.ok(!JSON.stringify(rows).includes(secret) && !JSON.stringify(rows).includes(Buffer.from(secret).toString('base64')))
    // the id alone can change; the secret stays
    await saveClient(TENANT, { clientId: 'second.apps.googleusercontent.com', clientSecret: '' })
    assert.equal((await clientFor(TENANT)).clientSecret, secret)
    // another company sees its own (none) → the install's
    assert.equal((await clientFor('pro-gc-unit-other')).source, 'env')
    // a token issued by the env client is refreshed with that one
    assert.equal((await clientById(TENANT, 'env-client')).source, 'env')
    assert.equal(await clientById(TENANT, 'gone-client'), null)
    await assert.rejects(saveClient(TENANT, { clientId: 'has space', clientSecret: 'x' }), /Client ID/)
    const audit = await q('select action, actor, detail from pro_vault_audit where user_id=$1 order by id', [subject])
    assert.deepEqual(audit.map((a) => [a.action, a.actor]), [['create', 'admin'], ['update', 'admin']])
    assert.equal(audit[0].detail.by, 'admin-1')
    const gone = await removeClient(TENANT)
    assert.deepEqual([gone.company, gone.using], [null, 'env'])
    Object.assign(config.google, { clientId: '', clientSecret: '' })
    assert.equal(await clientFor(TENANT), null)
    assert.equal((await clientInfo(TENANT)).using, null)
  } finally { restore() }
})
