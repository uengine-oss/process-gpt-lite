// 메일로 온 인증 코드 (lib/mailCode.js): the code out of a mail by rule, which mail is the site's, which one is picked.
// The extraction cases are data (mail-code-cases.json): a format a site sends that is read wrong is one more line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extractCode, registrable, namesOf, fromSite, pickCode } from '../lib/mailCode.js'

const CASES = JSON.parse(fs.readFileSync(new URL('./mail-code-cases.json', import.meta.url), 'utf8'))
for (const c of CASES) test(`code: ${c.name}`, () => assert.equal(extractCode(c.text), c.expect))

test('the part of a host a company owns', () => {
  assert.equal(registrable('accounts.shop.example'), 'shop.example')
  assert.equal(registrable('nid.naver.co.kr'), 'naver.co.kr')
  assert.equal(registrable('www.example.com:8443'), 'example.com')
  assert.equal(registrable('127.0.0.1'), '127.0.0.1')
})

test("the site's names from its page title, not the page's purpose", () => {
  assert.deepEqual(namesOf('인증 코드 · 테스트 상점'), ['테스트 상점'])
  assert.deepEqual(namesOf('Sign in · Test Shop'), ['Test Shop'])
  assert.deepEqual(namesOf('로그인'), [])
})

test("a mail is the site's by its sender's domain, or by naming the site", () => {
  const shop = { from: '테스트 상점 <no-reply@accounts.shop.example>', subject: '[테스트 상점] 로그인 인증 코드', text: '' }
  assert.equal(fromSite(shop, { site: 'shop.example' }), 'domain')
  assert.equal(fromSite(shop, { site: '127.0.0.1', names: ['테스트 상점'] }), 'name')
  assert.equal(fromSite({ from: 'no-reply@other.example', subject: '[다른 상점] 인증 코드', text: '' }, { site: '127.0.0.1', names: ['테스트 상점'] }), null)
  // an address site never matches by domain (every local test site would)
  assert.equal(fromSite({ from: 'x@127.0.0.1', subject: '', text: '' }, { site: '127.0.0.1' }), 'name')
  assert.equal(fromSite({ from: 'x@other.example', subject: 'code 123456', text: '' }, { site: '127.0.0.1' }), null)
})

test("the code from the newest fitting mail: not before the request, not used, the site's sender first", () => {
  const t0 = Date.parse('2026-11-01T01:00:00Z')
  const at = (s) => new Date(t0 + s * 1000).toISOString()
  const mails = [
    { id: 'old', from: 'no-reply@shop.example', subject: '인증 코드', text: '인증 코드는 111111 입니다', date: at(-400) },
    { id: 'named', from: 'alerts@mailer.example', subject: '[테스트 상점] 알림', text: '인증 코드 222222', date: at(30) },
    { id: 'site', from: 'no-reply@shop.example', subject: '인증 코드', text: '인증 코드는 333333 입니다', date: at(20) },
    { id: 'other', from: 'no-reply@bank.example', subject: '인증 코드', text: '인증 코드는 444444 입니다', date: at(40) },
  ]
  const opts = { site: 'login.shop.example', names: ['테스트 상점'], since: t0 - 180000 }
  assert.deepEqual(pickCode(mails, opts), { id: 'site', code: '333333', how: 'domain', from: 'shop.example', at: at(20) })
  assert.equal(pickCode(mails, { ...opts, used: new Set(['site']) }).code, '222222')
  assert.equal(pickCode(mails, { ...opts, used: new Set(['site', 'named']) }), null)
  assert.equal(pickCode([], opts), null)
})
