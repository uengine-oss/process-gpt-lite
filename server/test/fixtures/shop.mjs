// A tiny shop for vault tests: login (+ one-time code) and a card checkout.
// It records whether what the browser submitted matched, so a test can prove the vault value
// reached the site while never having been shown to the model.
//   node test/fixtures/shop.mjs 8799     (stand-alone, for the UI E2E)
// In English (the English tutorial and videos): `?lang=en` on any page (remembered in a cookie for
// the redirects that follow), `startShop(port, { lang: 'en' })`, or SHOP_LANG=en for the stand-alone shop.
import http from 'node:http'

export const SHOP = { username: 'demo@shop.test', password: 'Correct-Horse-42', otp: '246810' }

const T = {
  ko: {
    login: '로그인 · 테스트 상점', loginH: '테스트 상점 로그인', email: '이메일', password: '비밀번호', loginBtn: '로그인',
    badLogin: '이메일 또는 비밀번호가 올바르지 않습니다.',
    otp: '인증 코드 · 테스트 상점', otpH: '인증 코드 확인', otpP: '휴대폰으로 받은 6자리 인증 코드를 입력하세요.', code: '인증 코드', otpBtn: '확인',
    badOtp: '인증 코드가 올바르지 않습니다.',
    account: '내 계정 · 테스트 상점', accountH: '내 계정', welcome: (u) => `${u} 님, 환영합니다.`,
    lastOrder: '최근 주문: <b>주문 #A-1001 무선 이어폰 89,000원 (배송 중)</b>', again: '다시 주문하기',
    checkout: '결제 · 테스트 상점', checkoutH: '결제', item: '무선 이어폰 1개 · <b>89,000원</b>',
    ccName: '카드 소유자', ccNumber: '카드 번호', ccExp: '만료일 (MM/YY)', cvc: 'CVC', payBtn: '89,000원 결제하기', badCard: '카드 정보를 확인해 주세요.',
    paid: '결제 완료 · 테스트 상점', paidH: '결제 완료', paidP: (l4) => `카드 •••• ${l4} 로 89,000원을 결제했어요. 주문 번호 #A-2002`,
  },
  en: {
    login: 'Sign in · Test Shop', loginH: 'Sign in to Test Shop', email: 'Email', password: 'Password', loginBtn: 'Sign in',
    badLogin: 'The email or password is incorrect.',
    otp: 'Verification code · Test Shop', otpH: 'Verify it’s you', otpP: 'Enter the 6-digit verification code sent to your phone.', code: 'Verification code', otpBtn: 'Verify',
    badOtp: 'That verification code is incorrect.',
    account: 'My account · Test Shop', accountH: 'My account', welcome: (u) => `Welcome, ${u}.`,
    lastOrder: 'Latest order: <b>Order #A-1001 Wireless earbuds ₩89,000 (Shipping)</b>', again: 'Order again',
    checkout: 'Checkout · Test Shop', checkoutH: 'Checkout', item: 'Wireless earbuds × 1 · <b>₩89,000</b>',
    ccName: 'Cardholder name', ccNumber: 'Card number', ccExp: 'Expiry (MM/YY)', cvc: 'CVC', payBtn: 'Pay ₩89,000', badCard: 'Please check your card details.',
    paid: 'Payment complete · Test Shop', paidH: 'Payment complete', paidP: (l4) => `You paid ₩89,000 with the card •••• ${l4}. Order #A-2002`,
  },
}

const page = (lang, title, body) => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0;background:#f6f6f8}main{position:absolute;left:80px;top:60px;width:420px}
h1{font-size:24px;margin:0 0 20px}label{display:block;margin:12px 0 4px;font-size:14px;color:#555}
input{width:100%;box-sizing:border-box;height:40px;font-size:16px;padding:0 10px;border:1px solid #bbb;border-radius:8px}
button{margin-top:18px;height:42px;width:100%;font-size:16px;border:0;border-radius:8px;background:#1d1d1f;color:#fff}
.err{color:#c00;margin:10px 0}.box{background:#fff;padding:16px;border-radius:12px}</style></head><body><main>${body}</main></body></html>`

const loginPage = (l, err = '') => page(l, T[l].login, `<h1>${T[l].loginH}</h1>${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="/login">
<label for="username">${T[l].email}</label><input id="username" name="username" type="email" autocomplete="username">
<label for="password">${T[l].password}</label><input id="password" name="password" type="password" autocomplete="current-password">
<button type="submit">${T[l].loginBtn}</button></form>`)

const otpPage = (l, err = '') => page(l, T[l].otp, `<h1>${T[l].otpH}</h1><p>${T[l].otpP}</p>${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="/otp"><label for="code">${T[l].code}</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code">
<button type="submit">${T[l].otpBtn}</button></form>`)

const checkoutPage = (l, err = '') => page(l, T[l].checkout, `<h1>${T[l].checkoutH}</h1><div class="box">${T[l].item}</div>${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="/pay">
<label for="cc-name">${T[l].ccName}</label><input id="cc-name" name="ccname" autocomplete="cc-name">
<label for="cc-number">${T[l].ccNumber}</label><input id="cc-number" name="cardnumber" inputmode="numeric" autocomplete="cc-number">
<label for="cc-exp">${T[l].ccExp}</label><input id="cc-exp" name="ccexp" autocomplete="cc-exp">
<label for="cc-csc">${T[l].cvc}</label><input id="cc-csc" name="cvc" inputmode="numeric" autocomplete="cc-csc">
<button type="submit">${T[l].payBtn}</button></form>`)

function body(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))))
  })
}

export function startShop(port = 0, { cards = [], lang: shopLang = 'ko' } = {}) {
  const state = { logins: [], otps: [], payments: [], sessions: new Set() }
  const server = http.createServer(async (req, res) => {
    const sid = /sid=(\w+)/.exec(req.headers.cookie || '')?.[1]
    const url = new URL(req.url, 'http://x')
    // the page language: ?lang= (kept in a cookie for the redirects after a form), else the shop's own
    const asked = /^(en|ko)$/.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : null
    const l = asked || /(?:^|;\s*)lang=(en|ko)/.exec(req.headers.cookie || '')?.[1] || (shopLang === 'en' ? 'en' : 'ko')
    const langCookie = asked ? { 'Set-Cookie': `lang=${asked}; Path=/` } : {}
    const cookies = (more) => (more ? (asked ? [langCookie['Set-Cookie'], more] : more) : langCookie['Set-Cookie'])
    const html = (h, status = 200, headers = {}) => { const c = cookies(headers['Set-Cookie']); res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers, ...(c ? { 'Set-Cookie': c } : {}) }); res.end(h) }
    const go = (to, headers = {}) => { const c = cookies(headers['Set-Cookie']); res.writeHead(303, { Location: to, ...headers, ...(c ? { 'Set-Cookie': c } : {}) }); res.end() }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) return html(loginPage(l))
    if (req.method === 'POST' && url.pathname === '/login') {
      const f = await body(req)
      const ok = f.username === SHOP.username && f.password === SHOP.password
      state.logins.push({ username: f.username, passwordOk: ok, at: Date.now() })
      if (!ok) return html(loginPage(l, T[l].badLogin))
      const id = Math.random().toString(36).slice(2)
      return go('/otp', { 'Set-Cookie': `pre=${id}; Path=/` })
    }
    if (req.method === 'GET' && url.pathname === '/otp') return html(otpPage(l))
    if (req.method === 'POST' && url.pathname === '/otp') {
      const f = await body(req)
      const ok = f.code === SHOP.otp
      state.otps.push({ ok, at: Date.now() })
      if (!ok) return html(otpPage(l, T[l].badOtp))
      const id = Math.random().toString(36).slice(2)
      state.sessions.add(id)
      return go('/account', { 'Set-Cookie': `sid=${id}; Path=/` })
    }
    if (req.method === 'GET' && url.pathname === '/account') {
      if (!state.sessions.has(sid)) return go('/login')
      return html(page(l, T[l].account, `<h1>${T[l].accountH}</h1><div class="box"><p>${T[l].welcome(SHOP.username)}</p>
<p>${T[l].lastOrder}</p><p><a href="/checkout">${T[l].again}</a></p></div>`))
    }
    if (req.method === 'GET' && url.pathname === '/checkout') return html(checkoutPage(l))
    if (req.method === 'POST' && url.pathname === '/pay') {
      const f = await body(req)
      const number = String(f.cardnumber || '').replace(/\D/g, '')
      const expected = cards.find((c) => c.number === number)
      const ok = !!expected && f.ccexp === expected.exp && f.cvc === expected.cvv
      state.payments.push({ last4: number.slice(-4), ok, at: Date.now() })
      if (!ok) return html(checkoutPage(l, T[l].badCard))
      return html(page(l, T[l].paid, `<h1>${T[l].paidH}</h1><div class="box">${T[l].paidP(number.slice(-4))}</div>`))
    }
    html('not found', 404)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, state, cards,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }),
  })))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8799)
  // the demo card the UI E2E saves (Stripe's public test number)
  const shop = await startShop(port, { cards: [{ number: '4242424242424242', exp: '12/30', cvv: '123' }], lang: process.env.SHOP_LANG === 'en' ? 'en' : 'ko' })
  console.log(`test shop on ${shop.url}  (login ${SHOP.username} / otp ${SHOP.otp}${process.env.SHOP_LANG === 'en' ? ', English' : ''}; ?lang=en|ko per visit)`)
  setInterval(() => {
    const last = [...shop.state.logins, ...shop.state.otps, ...shop.state.payments].sort((a, b) => b.at - a.at)[0]
    if (last && Date.now() - last.at < 2000) console.log(JSON.stringify({ logins: shop.state.logins, otps: shop.state.otps, payments: shop.state.payments }))
  }, 2000)
}
