// 메일로 온 인증 코드 (lib/mailCode.js): the code out of a mail by rule, which mail is the site's, which one is picked.
// The extraction cases are data (mail-code-cases.json): a format a site sends that is read wrong is one more line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extractCode, registrable, namesOf, fromSite, pickCode, mailboxOf, senderOf, noteSignInMail, signInMailSince, forgetSignInMails, SIGN_IN_MS, linksIn } from '../lib/mailCode.js'

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

// ---- this installation's own sign-in mail: never a task's code (noteSignInMail · signInMailSince · ownSenders) ----
test('one mailbox however its address is written: case, +tag, Gmail dots and googlemail.com', () => {
  assert.equal(mailboxOf('Kim.Lee+lite@Example.COM'), 'kim.lee@example.com')
  assert.equal(mailboxOf('kim.lee+x@googlemail.com'), 'kimlee@gmail.com')
  assert.equal(mailboxOf('KIMLEE@gmail.com.'), 'kimlee@gmail.com')
  assert.equal(mailboxOf('not an address'), '')
  assert.equal(senderOf('Process GPT Lite <NoReply@Lite.Example>'), 'noreply@lite.example')
  assert.equal(senderOf('"noreply@lite.example" <someone@other.example>'), 'someone@other.example')
  assert.equal(senderOf('noreply@lite.example'), 'noreply@lite.example')
})

const t1 = Date.parse('2026-11-01T02:00:00Z')
const at1 = (s) => new Date(t1 + s * 1000).toISOString()
const liteMail = { id: 'lite', from: 'Process GPT Lite <noreply@lite.example>', subject: '[Process GPT] 로그인 코드', text: '로그인 코드는 555555 입니다', date: at1(5) }
const shopMail = (id, s, code) => ({ id, from: 'no-reply@shop.example', subject: '인증 코드', text: `인증 코드는 ${code} 입니다`, date: at1(s) })
const shop = { site: 'login.shop.example', names: ['테스트 상점'], since: t1 - 600000 }

test('a mail that came after this installation mailed a sign-in code to that mailbox is not taken; one before it is', () => {
  forgetSignInMails()
  noteSignInMail('kim@example.com', t1)
  const ownSince = signInMailSince(['Kim@Example.com'], t1 + 10000)
  assert.equal(ownSince, t1 - 60000, 'from a minute before the send (clocks)')
  assert.equal(pickCode([shopMail('after', 5, '666666')], { ...shop, ownSince }), null)
  assert.equal(pickCode([shopMail('during-slack', -30, '666666')], { ...shop, ownSince }), null)
  assert.equal(pickCode([{ ...shopMail('no-date', 0, '666666'), date: null }], { ...shop, ownSince }), null)
  assert.equal(pickCode([shopMail('before', -300, '777777'), shopMail('after', 5, '666666')], { ...shop, ownSince }).code, '777777')
  // without the sign-in send the same mail is taken
  assert.equal(pickCode([shopMail('after', 5, '666666')], shop).code, '666666')
})

test('the sign-in send is found whichever way the address was written (+tag, Gmail dots, googlemail.com)', () => {
  forgetSignInMails()
  noteSignInMail('Kim.Lee+work@gmail.com', t1)
  for (const addr of ['kimlee@gmail.com', 'kim.lee@googlemail.com', 'KIM.LEE+other@gmail.com']) {
    const ownSince = signInMailSince([addr], t1 + 1000)
    assert.equal(ownSince, t1 - 60000, addr)
    assert.equal(pickCode([shopMail('after', 5, '666666')], { ...shop, ownSince }), null, addr)
  }
  noteSignInMail('ann+lite@example.com', t1)
  assert.equal(signInMailSince(['ann@example.com'], t1 + 1000), t1 - 60000)
  assert.equal(signInMailSince(['kimlee@example.com', 'someone@gmail.com'], t1 + 1000), null, 'other mailboxes: none')
  // a non-Gmail address keeps its dots
  assert.equal(signInMailSince(['an.n@example.com'], t1 + 1000), null)
})

test('a mail from the address this installation sends its sign-in mail from is never taken', () => {
  forgetSignInMails()
  const site = { site: 'lite.example', names: [], since: t1 - 600000 }
  assert.equal(pickCode([liteMail], site).code, '555555', 'without the setting it would be')
  assert.equal(pickCode([liteMail], { ...site, ownSenders: ['NOREPLY@lite.example'] }), null)
  const long = { ...site, since: t1 - 6 * 3600000 }
  assert.equal(pickCode([{ ...liteMail, date: at1(-3 * 3600) }], long).code, '555555')
  assert.equal(pickCode([{ ...liteMail, date: at1(-3 * 3600) }], { ...long, ownSenders: ['noreply@lite.example'] }), null, 'at any time')
  // other senders on the same site are not affected
  assert.equal(pickCode([{ ...liteMail, id: 'x', from: 'help@lite.example' }], { ...site, ownSenders: ['noreply@lite.example'] }).code, '555555')
})

test('BT-C-01 a mail that links to a step of this app\'s own sign-in (its auth server\'s verify link) is never taken', () => {
  forgetSignInMails()
  const places = { hosts: ['auth.lite.example', 'lite.example'], parents: [], prefixes: ['/lite'] }
  assert.deepEqual(linksIn('확인 <https://auth.lite.example/auth/v1/verify?token=x&type=magiclink>\n(https://lite.example/chat) ftp://x'),
    ['https://auth.lite.example/auth/v1/verify?token=x&type=magiclink', 'https://lite.example/chat'])
  const site = { site: 'lite.example', names: [], since: t1 - 600000, places }
  const own = { ...liteMail, id: 'own', from: 'Auth <mailer@other-sender.example>', text: `${liteMail.text}\n로그인: https://auth.lite.example/auth/v1/verify?token=abc&type=magiclink&redirect_to=https://lite.example/` }
  assert.equal(pickCode([own], site), null)
  // a mail that only links to the app's ordinary pages is a site's mail as any other
  assert.equal(pickCode([{ ...own, id: 'plain', text: `${liteMail.text}\nhttps://lite.example/chat` }], site).code, '555555')
})

test("other sites' mails are unaffected by this installation's sign-in record and sender", () => {
  forgetSignInMails()
  noteSignInMail('ann@example.com', t1)
  const opts = { ...shop, ownSince: signInMailSince(['bob@example.com'], t1 + 1000), ownSenders: ['noreply@lite.example'] }
  assert.equal(opts.ownSince, null)
  assert.deepEqual(pickCode([shopMail('shop', 5, '888888')], opts), { id: 'shop', code: '888888', how: 'domain', from: 'shop.example', at: at1(5) })
})

test('the sign-in record lasts 15 minutes — after that a site\'s mailed code is entered again', () => {
  assert.equal(SIGN_IN_MS, 15 * 60000)
  forgetSignInMails()
  noteSignInMail('kim@example.com', t1)
  assert.equal(signInMailSince(['kim@example.com'], t1 + 14 * 60000), t1 - 60000)
  assert.equal(signInMailSince(['kim@example.com'], t1 + 16 * 60000), null)
  // the first send still within the 15 minutes counts
  noteSignInMail('kim@example.com', t1)
  noteSignInMail('kim@example.com', t1 + 10 * 60000)
  assert.equal(signInMailSince(['kim@example.com'], t1 + 12 * 60000), t1 - 60000)
  assert.equal(signInMailSince(['kim@example.com'], t1 + 20 * 60000), t1 + 10 * 60000 - 60000)
  // a site's code that came 16 minutes after this installation's sign-in mail is taken again
  forgetSignInMails()
  noteSignInMail('kim@example.com', t1)
  const later = { id: 'later', from: 'no-reply@shop.example', subject: '인증 코드', text: '인증 코드는 909090 입니다', date: new Date(t1 + 16 * 60000).toISOString() }
  const soon = { ...later, id: 'soon', date: new Date(t1 + 5 * 60000).toISOString() }
  assert.equal(pickCode([soon], { site: 'shop.example', since: t1 - 60000, ownSince: signInMailSince(['kim@example.com'], t1 + 6 * 60000) }), null, '15분 안에는 넣지 않는다')
  assert.equal(pickCode([later], { site: 'shop.example', since: t1 - 60000, ownSince: signInMailSince(['kim@example.com'], t1 + 16 * 60000) })?.code, '909090')
  forgetSignInMails()
})

test('index.js: 로그인 코드를 보내 달라고 하기 바로 전에(같은 회사 주소일 때만) 그 주소를 적어 둔다', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const route = src.indexOf("app.post('/api/auth/email/start'")
  const check = src.indexOf('tenantEmail(req.body.email)', route)
  const note = src.indexOf('noteSignInMail(req.body.email)', route)
  const otp = src.indexOf('/auth/v1/otp', route)
  assert.ok(route > 0 && check > route && note > check && otp > note)
})
