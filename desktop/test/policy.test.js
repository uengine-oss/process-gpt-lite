'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { kind, openable } = require('../src/policy')

const company = { server: 'https://acme.process-gpt.io/lite', authOrigins: ['https://auth.process-gpt.io'] }
const local = { server: 'http://localhost:18080', authOrigins: [] }

test('the server origin opens in the window — the whole origin (ProcessGPT shares it behind the gateway)', () => {
  assert.equal(kind('https://acme.process-gpt.io/lite/chat', company), 'app')
  assert.equal(kind('https://acme.process-gpt.io/', company), 'app')
  assert.equal(kind('http://localhost:18080/folders', local), 'app')
  assert.equal(kind('about:blank', local), 'app')
  assert.equal(kind('blob:http://localhost:18080/5b1c', local), 'app')
})

test('sign-in pages: the Supabase origin from /api/config and Google accounts, https only', () => {
  assert.equal(kind('https://auth.process-gpt.io/auth/v1/authorize?provider=google', company), 'auth')
  assert.equal(kind('https://accounts.google.com/o/oauth2/v2/auth?client_id=x', company), 'auth')
  assert.equal(kind('https://accounts.google.co.kr/accounts/SetSID', company), 'auth')
  assert.equal(kind('https://accounts.youtube.com/accounts/SetSID', local), 'auth')
  assert.equal(kind('http://accounts.google.com/', company), 'external')
})

test('other sites and mail open outside; other schemes nowhere', () => {
  assert.equal(kind('https://other.process-gpt.io/lite', company), 'external')
  assert.equal(kind('https://www.youtube.com/watch?v=x', company), 'external')
  assert.equal(kind('https://drive.google.com/file/d/1', company), 'external')
  assert.equal(kind('http://localhost:5180/chat', local), 'external')
  assert.equal(kind('mailto:a@example.com', company), 'external')
  assert.equal(kind('file:///etc/passwd', company), 'blocked')
  assert.equal(kind('javascript:alert(1)', company), 'blocked')
  assert.equal(kind('blob:https://evil.example/1', company), 'blocked')
  assert.equal(kind('not a url', company), 'blocked')
})

test('only web, mail and phone addresses are handed to the system', () => {
  assert.ok(openable('https://example.com'))
  assert.ok(openable('mailto:a@example.com'))
  assert.ok(!openable('file:///Applications/Calculator.app'))
  assert.ok(!openable('smb://host/share'))
})
