'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { normalize, candidates, check } = require('../src/server')

test('normalize: scheme, the app base from a copied page address, no credentials', () => {
  assert.equal(normalize('acme.process-gpt.io/lite'), 'https://acme.process-gpt.io/lite')
  assert.equal(normalize(' https://acme.process-gpt.io/lite/chat/c/abc?x=1#y '), 'https://acme.process-gpt.io/lite')
  assert.equal(normalize('https://acme.process-gpt.io/lite/routines/12'), 'https://acme.process-gpt.io/lite')
  assert.equal(normalize('localhost:18080'), 'http://localhost:18080')
  assert.equal(normalize('en.localhost:5180/login'), 'http://en.localhost:5180')
  assert.equal(normalize('192.168.0.10:18080/'), 'http://192.168.0.10:18080')
  assert.equal(normalize('http://localhost:18080/'), 'http://localhost:18080')
  assert.equal(normalize('ftp://x'), '')
  assert.equal(normalize('https://user:pw@acme.process-gpt.io'), '')
  assert.equal(normalize('   '), '')
})

test('candidates: a bare company domain also tries its /lite', () => {
  assert.deepEqual(candidates('acme.process-gpt.io'), ['https://acme.process-gpt.io', 'https://acme.process-gpt.io/lite'])
  assert.deepEqual(candidates('acme.process-gpt.io/lite'), ['https://acme.process-gpt.io/lite'])
})

const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
test('check: a Lite /api/config is found, with its Supabase sign-in origin', async () => {
  const seen = []
  const fetch = async (url) => {
    seen.push(url)
    if (url === 'https://acme.process-gpt.io/api/config') return { status: 200, ok: true, json: async () => { throw new Error('html') } }
    return json(200, { google: false, demoLogin: false, sso: { google: 'https://auth.process-gpt.io/auth/v1/authorize?provider=google' } })
  }
  const r = await check('acme.process-gpt.io', { fetch })
  assert.deepEqual(r, { ok: true, server: 'https://acme.process-gpt.io/lite', authOrigins: ['https://auth.process-gpt.io'] })
  assert.deepEqual(seen, ['https://acme.process-gpt.io/api/config', 'https://acme.process-gpt.io/lite/api/config'])
})

test('check: unreachable, a gate (401) with the basic-auth pair, not Lite', async () => {
  assert.equal((await check('localhost:1', { fetch: async () => { throw new Error('ECONNREFUSED') } })).reason, 'unreachable')
  assert.equal((await check('', { fetch: async () => json(200, {}) })).reason, 'empty')
  let auth = ''
  const gated = async (_u, o) => { auth = o.headers.Authorization || ''; return auth ? json(200, { demoLogin: true }) : json(401, null) }
  assert.equal((await check('x.trycloudflare.com', { fetch: gated })).reason, 'auth')
  const ok = await check('x.trycloudflare.com', { fetch: gated, user: 'u', pass: 'p' })
  assert.equal(ok.ok, true)
  assert.equal(auth, `Basic ${Buffer.from('u:p').toString('base64')}`)
  assert.equal((await check('example.com/lite', { fetch: async () => json(200, { hello: 1 }) })).reason, 'notLite')
})

test('주소에 https:// 가 두 번 들어가도(미리 채운 칸 뒤에 붙여 넣기) 하나로 읽는다', () => {
  const { normalize } = require('../src/server.js')
  assert.equal(normalize('https://https://acme.process-gpt.io/lite'), 'https://acme.process-gpt.io/lite')
  assert.equal(normalize('https:// https://acme.process-gpt.io/lite/chat'), 'https://acme.process-gpt.io/lite')
  assert.equal(normalize('http://localhost:18080'), 'http://localhost:18080')
})

test('잘못 넣기 쉬운 주소: 회사 이름만 · https 오타 · 빈칸 · .process-gpt 만 → 회사 주소로', () => {
  const { normalize } = require('../src/server.js')
  const cases = {
    acme: 'https://acme.process-gpt.io', ACME: 'https://acme.process-gpt.io', 'acme/lite': 'https://acme.process-gpt.io/lite', 'acme.': 'https://acme.process-gpt.io',
    'acme.process-gpt': 'https://acme.process-gpt.io', 'https//acme': 'https://acme.process-gpt.io', 'http;//acme': 'https://acme.process-gpt.io',
    'https:/acme.process-gpt.io/lite/chat': 'https://acme.process-gpt.io/lite', '  https:// acme . process-gpt.io / lite ': 'https://acme.process-gpt.io/lite',
    'http://acme.process-gpt.io/lite': 'https://acme.process-gpt.io/lite',
    // what is not a company name stays as it is
    'localhost:18080': 'http://localhost:18080', '192.168.0.5:8080': 'http://192.168.0.5:8080', 'myhost.local': 'http://myhost.local',
    'https://lite.example.com/lite': 'https://lite.example.com/lite', 'http://10.0.0.3:5390': 'http://10.0.0.3:5390',
  }
  for (const [input, want] of Object.entries(cases)) assert.equal(normalize(input), want, input)
  assert.equal(normalize(''), '')
})
