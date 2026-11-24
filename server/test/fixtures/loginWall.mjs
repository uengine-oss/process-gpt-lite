// A made-up site with a sign-in host of its own, answered inside the browser (ctx.route — nothing leaves it), for the
// vault at a login wall (browser-wall-vault.e2e.mjs): a task for app.fixture.test lands on login.fixture.test, as a
// booking site sends people to its company's sign-in page; a sign-in that goes through shows the app's page. Names on
// the reserved .test domain (RFC 6761): no company's address or page is copied — the code tells a sign-in page by a
// judgment, not by its address.
//   state.password   the password the site accepts
//   state.after      what comes after the right password: 'ok' (signed in) · 'check' (a human check on the sign-in form,
//                    with the password asked again) · 'code' (a one-time code, state.code)
//   state.logins     what each sign-in sent: the username, whether the password was right, how many keys each field
//                    got (fill() sends none), and how many times a field held a value while not masked on screen
// The username field is drawn large (OCR of the live view frames can tell a masked field from one in clear), next to
// a control word in the same type that is always in clear.
export const LW = { login: 'login.fixture.test', app: 'app.fixture.test', username: 'VAULTUSER7Q', password: 'Vault-Pass-93kq', wrong: 'Wrong-Pass-11zx', code: '482913', control: 'CONTROL4K' }
export const LW_TITLES = { signIn: '로그인 · 픽스처 아이디', bad: '로그인 실패 · 픽스처 아이디', check: '추가 확인 · 픽스처 아이디', code: '인증 코드 · 픽스처 아이디', app: '내 예약 · 픽스처' }
// where the person presses on the check page (viewport 1280×800)
export const LW_SPOTS = { checkDone: { x: 640, y: 560 } }

const BIG = 'font:600 34px/1.2 ui-monospace,Menlo,monospace;letter-spacing:2px'
const head = (title) => `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;font:16px system-ui;background:#fff}main{position:absolute;left:340px;top:60px;width:600px}
input{display:block;box-sizing:border-box;width:600px;height:64px;margin:6px 0 14px;padding:0 14px;border:2px solid #888;border-radius:10px;${BIG}}
label{font-size:15px;color:#444}.ctl{${BIG};margin:0 0 16px}.err{color:#c00;font-size:18px;margin:0 0 10px}
button{width:600px;height:56px;font-size:20px;border:0;border-radius:10px;background:#1d1d1f;color:#fff}</style>`

// counts the keys each field gets and every moment a field holds a value without being masked on screen
const WATCH = `<script>
const keys = {}, unmasked = { n: 0 }
for (const el of document.querySelectorAll('input[data-watch]')) {
  keys[el.name] = 0
  el.addEventListener('keydown', () => { keys[el.name]++ })
  el.addEventListener('input', () => {
    const masked = el.type === 'password' || getComputedStyle(el).webkitTextSecurity === 'disc'
    if (el.value && !masked) unmasked.n++
  })
}
document.querySelector('form').addEventListener('submit', () => {
  document.querySelector('input[name=keys]').value = JSON.stringify(keys)
  document.querySelector('input[name=unmasked]').value = String(unmasked.n)
})
</script>`

const signIn = (err = '') => `${head(err ? LW_TITLES.bad : LW_TITLES.signIn)}<body><main>
<h1>픽스처 아이디 로그인</h1><p class="ctl">${LW.control}</p>${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="https://${LW.login}/session">
<label for="uid">아이디</label><input id="uid" name="uid" type="text" autocomplete="username" data-watch>
<label for="upw">비밀번호</label><input id="upw" name="upw" type="password" autocomplete="current-password" data-watch>
<input type="hidden" name="keys"><input type="hidden" name="unmasked">
<button type="submit">로그인</button></form></main>${WATCH}</body></html>`

// a human check on the sign-in form, the password asked again beside it (as some sites do after a sign-in they doubt)
const check = () => `${head(LW_TITLES.check)}<body><main>
<h1>로그인 추가 확인</h1><p>사람인지 확인한 뒤 다시 로그인해 주세요.</p>
<form method="post" action="https://${LW.login}/check">
<label for="upw">비밀번호</label><input id="upw" name="upw" type="password" autocomplete="current-password" data-watch>
<label><input type="checkbox" name="human" style="width:auto;height:auto;display:inline"> 사람입니다</label>
<input type="hidden" name="keys"><input type="hidden" name="unmasked">
<button type="submit" style="position:absolute;left:0;top:${LW_SPOTS.checkDone.y - 60 - 28}px">확인</button></form></main>${WATCH}</body></html>`

const code = (err = '') => `${head(LW_TITLES.code)}<body><main>
<h1>인증 코드 확인</h1><p>휴대폰으로 받은 6자리 인증 코드를 입력하세요.</p>${err ? `<p class="err">${err}</p>` : ''}
<form method="post" action="https://${LW.login}/code"><label for="code">인증 코드</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"><button type="submit">확인</button></form></main></body></html>`

const app = () => `${head(LW_TITLES.app)}<body><main><h1>내 예약</h1><p>12월 18일 가상시 숙소 1박 · 12월 24일 저녁 2인</p></main></body></html>`

export async function routeLoginWall(ctx, state) {
  state.logins ||= []
  state.checks ||= []
  state.codes ||= []
  const html = (route, body) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body })
  await ctx.route(new RegExp(`^https://${LW.app.replace(/\./g, '\\.')}/`), (route) => html(route, app()))
  await ctx.route(new RegExp(`^https://${LW.login.replace(/\./g, '\\.')}/`), (route) => {
    const r = route.request()
    const p = new URL(r.url()).pathname
    const f = new URLSearchParams(r.postData() || '')
    const sent = () => ({ keys: JSON.parse(f.get('keys') || '{}'), unmasked: Number(f.get('unmasked') || 0) })
    if (r.method() === 'POST' && p === '/session') {
      const ok = f.get('upw') === state.password
      state.logins.push({ username: f.get('uid'), ok, ...sent() })
      if (!ok) return html(route, signIn('아이디 또는 비밀번호가 맞지 않아요.'))
      if (state.after === 'check') return html(route, check())
      if (state.after === 'code') return html(route, code())
      state.signedIn = true
      return html(route, app())
    }
    if (r.method() === 'POST' && p === '/check') {
      const ok = f.get('upw') === state.password
      state.checks.push({ ok, ...sent() })
      if (!ok) return html(route, check())
      state.signedIn = true
      return html(route, app())
    }
    if (r.method() === 'POST' && p === '/code') {
      const ok = f.get('code') === LW.code
      state.codes.push(ok)
      if (!ok) return html(route, code('인증 코드가 맞지 않아요.'))
      state.signedIn = true
      return html(route, app())
    }
    return html(route, signIn())
  })
}
