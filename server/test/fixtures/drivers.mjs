// 두 페이지 드라이버(서버의 Chromium · 사람 PC 의 브라우저)를 같은 시험으로 돌리는 시험 사이트(test/browserDriver.test.js · browser-local.test.js).
// 가게 · 이름 · 계정은 모두 지어낸 것이다. 밖으로 나가는 요청은 없다.
//   /shop       검색 칸 · 「검색」(결과: 「찾은 것: <검색어>」), 비밀번호 칸, 다른 출처(localhost)의 iframe 안에 「안쪽 단추」, 날짜 칸, 큰 글 상자
//   /long       아래로 긴 페이지(맨 아래에 「맨 아래 줄」), 스크롤 상자 안의 목록
//   /file       파일 칸(고르면 「받은 파일: <이름> <크기>」) · 파일 고르개를 여는 단추
//   /tabs       새 탭을 여는 링크 둘(긴 페이지 · 스스로 닫히는 창 /closer)
//   /download   「보고서 받기」 → /dl/report.txt (attachment) · /downloads 크기를 말하지 않는 3MB(/dl/big) · 새 탭으로 받는 링크
//   /dialog     confirm · alert 를 띄우는 「지우기」 · /korean 한글 40만 자 · /busy 열리고 1.5초 뒤 스크립트가 9초 붙잡는 페이지(비밀번호 칸)
//   /selfclose  스스로 닫는 창 · /popups 창 열두 개를 여는 단추
//   /unload     칸에 입력하면 beforeunload 로 「떠날까요?」를 거는 페이지 · /framedialog 스크립트가 만든 빈 iframe 의 alert · frames[0] 의 confirm
//   /net        이 사이트(127.0.0.1)로 fetch · 그림 · 폼 · 새 창, 이름(localtest.me — 공개 DNS 가 127.0.0.1 로 푸는 이름)으로 fetch — /probe 가 받은
//               요청은 site.probes 에 남는다
//   /never      문서는 오지만 'load' 가 오지 않는 페이지(끝나지 않는 그림)
//   /login      아이디 · 비밀번호 · 「로그인」 → /welcome (비밀번호가 PASSWORD 일 때만 「환영합니다, <아이디>」, 아니면 「비밀번호가 틀렸어요」)
//   /keys       같은 로그인 폼(Enter 로 보냄), 칸마다 받은 글자 키를 센다(「keys u=<n> p=<n>」)
//   /inner      iframe 안쪽(다른 출처)
import http from 'node:http'

export const PASSWORD = 'pl-Secret-7731!'
export const REPORT = '가상 보고서\n1분기 매출 1,234\n'
const html = (title, body, head = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title><meta property="og:site_name" content="가상 상점">${head}</head><body style="margin:0;font:16px sans-serif">${body}</body></html>`

const page = (origin2) => ({
  '/shop': html('가상 상점', `
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = '찾은 것: ' + document.getElementById('q').value" style="padding:12px">
  <input id="q" name="q" placeholder="검색어" aria-label="검색어" style="font-size:18px">
  <button id="go" type="submit">검색</button>
</form>
<p id="out">아직 찾지 않음</p>
<label style="display:block;padding:8px">비밀번호 <input id="pw" name="password" type="password" aria-label="비밀번호"></label>
<label style="display:block;padding:8px">날짜 <input id="d" type="date" aria-label="날짜"></label>
<button id="count" onclick="this.textContent = '눌림 ' + (Number(this.dataset.n = (Number(this.dataset.n) || 0) + 1))" style="margin:8px">세기</button>
<iframe id="fr" src="${origin2}/inner" style="width:420px;height:160px;border:0;display:block;margin:8px"></iframe>
<textarea id="memo" aria-label="메모" style="width:300px;height:60px"></textarea>`),
  '/inner': html('안쪽', `<div style="padding:10px"><p id="msg">안쪽 글</p><button id="ib" onclick="document.getElementById('msg').textContent = '안쪽 눌림'">안쪽 단추</button>
<input id="iq" aria-label="안쪽 칸" placeholder="안쪽 칸"></div>`),
  '/long': html('긴 페이지', `<h1 style="padding:10px">긴 페이지 맨 위</h1>${Array.from({ length: 120 }, (_, i) => `<p style="height:40px;margin:0;padding:0 10px">줄 ${i + 1}</p>`).join('')}<p id="bottom">맨 아래 줄</p>`),
  '/file': html('파일 올리기', `<div style="padding:12px"><input id="up" type="file" aria-label="파일" onchange="document.getElementById('got').textContent = '받은 파일: ' + this.files[0].name + ' ' + this.files[0].size">
<p id="got">아직 없음</p>
<input id="hidden" type="file" style="display:none" onchange="document.getElementById('got2').textContent = '고른 파일: ' + this.files[0].name">
<button id="pick" onclick="document.getElementById('hidden').click()">파일 고르기</button><p id="got2">아직 안 고름</p></div>`),
  // a link that opens a new tab, and a popup that closes itself (the work goes back to the page that opened it)
  '/tabs': html('탭', `<p style="padding:12px"><a href="/long" target="_blank">새 탭으로 긴 페이지</a></p>
<p style="padding:12px"><a href="/closer" target="_blank">닫히는 창 열기</a></p>`),
  '/closer': html('닫히는 창', `<p style="padding:12px"><button onclick="window.close()">창 닫기</button></p>`),
  // a page's own dialogs: confirm (cancelled where nobody watches) then alert
  '/dialog': html('대화 상자', `<p style="padding:12px"><button onclick="const ok = confirm('정말 지울까요?'); document.getElementById('r').textContent = ok ? '지움' : '안 지움'; alert('끝났어요')">지우기</button></p><p id="r">아직</p>`),
  // a long Korean page: 400,000 letters (1.2 MB in UTF-8 — more than the link takes whole)
  '/korean': html('긴 한국어', `<p id="k" style="padding:12px">${'가나다라마바사아자차'.repeat(40_000)}</p>`),
  // a page whose own script holds it for 9 s, 1.5 s after it loads (nothing is drawn meanwhile)
  '/busy': html('바쁜 페이지', `<p style="padding:12px">바쁘다</p><input type="password" aria-label="비밀번호"><script>setTimeout(() => { const t = Date.now(); while (Date.now() - t < 9000) {} }, 1500)</script>`),
  // the only window closes itself
  '/selfclose': html('스스로 닫는 창', `<p style="padding:12px"><button onclick="window.close()">이 창 닫기</button></p>`),
  // a page that opens twelve windows at once
  '/popups': html('창 열기', `<p style="padding:12px"><button onclick="for (let k = 0; k < 12; k++) window.open('/long?w=' + k, '_blank')">창 열두 개</button></p>`),
  // a form that, once something is typed into it, asks 「leave this page?」 (beforeunload)
  '/unload': html('떠나기 확인', `<p style="padding:12px"><input name="memo" aria-label="메모" oninput="window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = '' }"></p>`),
  // dialogs from frames the page made itself (about:blank — no new document there for a guard to start in)
  '/framedialog': html('프레임 대화 상자', `<p style="padding:12px"><button onclick="const f = document.createElement('iframe'); f.style.display = 'none'; document.body.appendChild(f); f.contentWindow.alert('안쪽 알림'); document.getElementById('r').textContent = '알림 뒤'">안쪽 알림</button>
<button onclick="const f = document.createElement('iframe'); f.style.display = 'none'; document.body.appendChild(f); const ok = frames[frames.length - 1].confirm('안쪽 확인'); document.getElementById('r').textContent = ok ? '확인함' : '확인 안 함'">프레임 확인</button></p><p id="r">아직</p>`),
  // requests a page makes to this PC's own network after it loaded: fetch, a picture, a form, a new window — and by a public name
  // (localtest.me) that resolves to 127.0.0.1
  '/net': html('내부망 요청', `<p style="padding:12px">
<button onclick="fetch('/probe?fetch').then(() => r.textContent = '가져옴', () => r.textContent = '못 가져옴')">가져오기</button>
<button onclick="const i = new Image(); i.onload = i.onerror = () => r.textContent = '그림 끝'; i.src = '/probe?img'">그림</button>
<button onclick="fetch('http://localtest.me:' + location.port + '/probe?name', { mode: 'no-cors' }).then(() => r.textContent = '이름 가져옴', () => r.textContent = '이름 못 가져옴')">이름으로</button>
<button onclick="window.open('/probe?popup', '_blank')">새 창</button></p>
<form action="/probe?form" method="post"><input name="q" value="x" aria-label="폼 칸"><button type="submit">폼 보내기</button></form><p id="r">아직</p>`),
  // downloads: one with no size given that is bigger than a small cap, one from a link that opens a new tab
  '/downloads': html('받기 둘', `<p style="padding:12px"><a href="/dl/big">큰 파일</a> <a href="/dl/report.txt" target="_blank">새 탭으로 받기</a></p>`),
  '/download': html('받기', `<p style="padding:12px"><a id="dl" href="/dl/report.txt">보고서 받기</a></p>`),
  '/never': html('끝나지 않는 페이지', `<p style="padding:12px">본문은 왔어요</p><img src="/hang.png" alt="">`),
  // keys a page sees (a character typed: keydown with a one-character key), per field — sign-in pages that read them
  '/keys': html('키 세는 로그인', `
<form action="/welcome" method="post" style="padding:12px">
  <input name="username" aria-label="아이디" placeholder="아이디" onkeydown="if (event.key.length === 1) count('u')">
  <input name="password" type="password" aria-label="비밀번호" placeholder="비밀번호" onkeydown="if (event.key.length === 1) count('p')">
  <button type="submit">보내기</button>
</form>
<p id="k">keys u=0 p=0</p>
<script>const n = { u: 0, p: 0 }; function count(k) { n[k]++; document.getElementById('k').textContent = 'keys u=' + n.u + ' p=' + n.p }</script>`),
  '/login': html('가상 상점 로그인', `
<form action="/welcome" method="post" style="padding:12px">
  <input name="username" autocomplete="username" aria-label="아이디" placeholder="아이디">
  <input name="password" type="password" autocomplete="current-password" aria-label="비밀번호" placeholder="비밀번호">
  <button type="submit">로그인</button>
</form>`),
})

export async function startDriverSite() {
  const hung = new Set()
  const probes = []
  let origin2 = ''
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/hang.png') { hung.add(res); req.on('close', () => hung.delete(res)); return }
    if (u.pathname === '/probe') {
      probes.push(u.search.slice(1) || '-')
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Access-Control-Allow-Origin': '*' })
      return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'))
    }
    if (u.pathname === '/dl/big') {
      // 3 MB in chunks, no Content-Length: the size is known only as it comes
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="big.bin"', 'Transfer-Encoding': 'chunked' })
      const chunk = Buffer.alloc(256 * 1024, 7)
      let n = 0
      const more = () => { if (n++ >= 12) return res.end(); res.write(chunk, () => setTimeout(more, 5)) }
      return more()
    }
    if (u.pathname === '/dl/report.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="report.txt"' })
      return res.end(REPORT)
    }
    if (u.pathname === '/welcome' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const f = new URLSearchParams(raw)
        const ok = f.get('password') === PASSWORD
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html(ok ? '환영' : '로그인 실패', `<p id="hi" style="padding:12px">${ok ? `환영합니다, ${String(f.get('username') || '').replace(/[<>&"]/g, '')}` : '비밀번호가 틀렸어요'}</p>`))
      })
      return
    }
    const p = page(origin2)[u.pathname]
    if (!p) { res.writeHead(404); return res.end('없음') }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(p)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  origin2 = `http://localhost:${port}`
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    origin2,
    probes,
    close: () => { for (const r of hung) r.destroy(); server.closeAllConnections?.(); return new Promise((r) => server.close(r)) },
  }
}
