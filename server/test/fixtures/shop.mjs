// A tiny shop for vault tests: login (+ one-time code) and a card checkout.
// It records whether what the browser submitted matched, so a test can prove the vault value
// reached the site while never having been shown to the model.
//   node test/fixtures/shop.mjs 8799     (stand-alone, for the UI E2E)
import http from 'node:http'

export const SHOP = { username: 'demo@shop.test', password: 'Correct-Horse-42', otp: '246810' }

const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0;background:#f6f6f8}main{position:absolute;left:80px;top:60px;width:420px}
h1{font-size:24px;margin:0 0 20px}label{display:block;margin:12px 0 4px;font-size:14px;color:#555}
input{width:100%;box-sizing:border-box;height:40px;font-size:16px;padding:0 10px;border:1px solid #bbb;border-radius:8px}
button{margin-top:18px;height:42px;width:100%;font-size:16px;border:0;border-radius:8px;background:#1d1d1f;color:#fff}
.err{color:#c00;margin:10px 0}.box{background:#fff;padding:16px;border-radius:12px}</style></head><body><main>${body}</main></body></html>`

const loginPage = (err = '') => page('로그인 · 테스트 상점', `<h1>테스트 상점 로그인</h1>${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="/login">
<label for="username">이메일</label><input id="username" name="username" type="email" autocomplete="username">
<label for="password">비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password">
<button type="submit">로그인</button></form>`)

const otpPage = (err = '') => page('인증 코드 · 테스트 상점', `<h1>인증 코드 확인</h1><p>휴대폰으로 받은 6자리 인증 코드를 입력하세요.</p>${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="/otp"><label for="code">인증 코드</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code">
<button type="submit">확인</button></form>`)

const checkoutPage = (err = '') => page('결제 · 테스트 상점', `<h1>결제</h1><div class="box">무선 이어폰 1개 · <b>89,000원</b></div>${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="/pay">
<label for="cc-name">카드 소유자</label><input id="cc-name" name="ccname" autocomplete="cc-name">
<label for="cc-number">카드 번호</label><input id="cc-number" name="cardnumber" inputmode="numeric" autocomplete="cc-number">
<label for="cc-exp">만료일 (MM/YY)</label><input id="cc-exp" name="ccexp" autocomplete="cc-exp">
<label for="cc-csc">CVC</label><input id="cc-csc" name="cvc" inputmode="numeric" autocomplete="cc-csc">
<button type="submit">89,000원 결제하기</button></form>`)

function body(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))))
  })
}

export function startShop(port = 0, { cards = [] } = {}) {
  const state = { logins: [], otps: [], payments: [], sessions: new Set() }
  const server = http.createServer(async (req, res) => {
    const sid = /sid=(\w+)/.exec(req.headers.cookie || '')?.[1]
    const html = (h, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(h) }
    const go = (to, headers = {}) => { res.writeHead(303, { Location: to, ...headers }); res.end() }
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) return html(loginPage())
    if (req.method === 'POST' && url.pathname === '/login') {
      const f = await body(req)
      const ok = f.username === SHOP.username && f.password === SHOP.password
      state.logins.push({ username: f.username, passwordOk: ok, at: Date.now() })
      if (!ok) return html(loginPage('이메일 또는 비밀번호가 올바르지 않습니다.'))
      const id = Math.random().toString(36).slice(2)
      return go('/otp', { 'Set-Cookie': `pre=${id}; Path=/` })
    }
    if (req.method === 'GET' && url.pathname === '/otp') return html(otpPage())
    if (req.method === 'POST' && url.pathname === '/otp') {
      const f = await body(req)
      const ok = f.code === SHOP.otp
      state.otps.push({ ok, at: Date.now() })
      if (!ok) return html(otpPage('인증 코드가 올바르지 않습니다.'))
      const id = Math.random().toString(36).slice(2)
      state.sessions.add(id)
      return go('/account', { 'Set-Cookie': `sid=${id}; Path=/` })
    }
    if (req.method === 'GET' && url.pathname === '/account') {
      if (!state.sessions.has(sid)) return go('/login')
      return html(page('내 계정 · 테스트 상점', `<h1>내 계정</h1><div class="box"><p>${SHOP.username} 님, 환영합니다.</p>
<p>최근 주문: <b>주문 #A-1001 무선 이어폰 89,000원 (배송 중)</b></p><p><a href="/checkout">다시 주문하기</a></p></div>`))
    }
    if (req.method === 'GET' && url.pathname === '/checkout') return html(checkoutPage())
    if (req.method === 'POST' && url.pathname === '/pay') {
      const f = await body(req)
      const number = String(f.cardnumber || '').replace(/\D/g, '')
      const expected = cards.find((c) => c.number === number)
      const ok = !!expected && f.ccexp === expected.exp && f.cvc === expected.cvv
      state.payments.push({ last4: number.slice(-4), ok, at: Date.now() })
      if (!ok) return html(checkoutPage('카드 정보를 확인해 주세요.'))
      return html(page('결제 완료 · 테스트 상점', `<h1>결제 완료</h1><div class="box">카드 •••• ${number.slice(-4)} 로 89,000원을 결제했어요. 주문 번호 #A-2002</div>`))
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
  const shop = await startShop(port, { cards: [{ number: '4242424242424242', exp: '12/30', cvv: '123' }] })
  console.log(`test shop on ${shop.url}  (login ${SHOP.username} / otp ${SHOP.otp})`)
  setInterval(() => {
    const last = [...shop.state.logins, ...shop.state.otps, ...shop.state.payments].sort((a, b) => b.at - a.at)[0]
    if (last && Date.now() - last.at < 2000) console.log(JSON.stringify({ logins: shop.state.logins, otps: shop.state.otps, payments: shop.state.payments }))
  }, 2000)
}
