// More than one tenant on one server (lib/tenant.js): the host before sign-in, the person's tenant after,
// config.tenantId following the request or job. No database needed.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.PRO_TENANT_ID = 'localhost'
process.env.PRO_TENANT_HOSTS = 'en.localhost=en-demo, bad host=, x.localhost=no spaces allowed'
const { config } = await import('../config.js')
const T = await import('../lib/tenant.js')
const { withLang } = await import('../lib/lang.js')

test('the hosts listed, nothing else', () => {
  assert.deepEqual(T.tenants(), ['localhost', 'en-demo'])
  assert.equal(T.multiTenant(), true)
  const req = (host, xfh) => ({ headers: { host, ...(xfh ? { 'x-forwarded-host': xfh } : {}) } })
  assert.equal(T.hostTenant(req('en.localhost:5180')), 'en-demo')
  assert.equal(T.hostTenant(req('EN.localhost')), 'en-demo')
  assert.equal(T.hostTenant(req('localhost:5180')), 'localhost')
  assert.equal(T.hostTenant(req('127.0.0.1:8787')), 'localhost')
  assert.equal(T.hostTenant(req('x.localhost:5180')), 'localhost') // an invalid tenant name is ignored
  assert.equal(T.hostTenant(req('127.0.0.1:8787', 'en.localhost:5180')), 'en-demo')
  assert.equal(T.urlOf('en-demo'), new URL(config.publicUrl).origin.replace(new URL(config.publicUrl).hostname, 'en.localhost'))
})

test('config.tenantId is the tenant of the work in progress', async () => {
  assert.equal(config.tenantId, 'localhost')
  await T.withTenant('en-demo', async () => {
    assert.equal(config.tenantId, 'en-demo')
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(config.tenantId, 'en-demo') // across awaits and timers
    await withLang('en', async () => assert.equal(config.tenantId, 'en-demo')) // the language is its own context
  })
  assert.equal(config.tenantId, 'localhost')
  await T.withTenant('survey-a', async () => assert.equal(config.tenantId, 'localhost')) // not served: the default
  const seen = []
  await T.forEachTenant(async () => { seen.push(config.tenantId) })
  assert.deepEqual(seen, ['localhost', 'en-demo'])
})

test("a person's tenant: app_metadata when served, else the default", () => {
  assert.equal(T.tenantOfAuthUser({ app_metadata: { tenant_id: 'en-demo' } }), 'en-demo')
  assert.equal(T.tenantOfAuthUser({ raw_app_meta_data: { tenant_id: 'en-demo' } }), 'en-demo')
  assert.equal(T.tenantOfAuthUser({ app_metadata: { tenant_id: 'survey-a' } }), 'localhost')
  assert.equal(T.tenantOfAuthUser({ app_metadata: {}, user_metadata: { tenant_id: 'en-demo' } }), 'localhost') // user_metadata is the user's to write
  assert.equal(T.tenantOfAuthUser(null), 'localhost')
})

test('the token subject picks the tenant, unchecked', () => {
  const tok = (p) => `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`
  assert.equal(T.jwtSubject(tok({ sub: '0b532d43-11bd-4981-8540-34124240365b' })), '0b532d43-11bd-4981-8540-34124240365b')
  assert.equal(T.jwtSubject('not a token'), null)
  assert.equal(T.jwtSubject(''), null)
})

test('the sign-in refusal names the other address, in the language of the request', () => {
  const e = new T.TenantMismatch('en-demo')
  assert.equal(e.status, 403)
  assert.match(e.message, /en-demo/)
  withLang('en', () => assert.match(new T.TenantMismatch('en-demo').message, /^This account belongs to another workspace \(en-demo\)\. Please sign in at http:\/\/en\.localhost/))
})
