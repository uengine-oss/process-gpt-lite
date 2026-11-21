// 브라우저 에이전트가 혼자 못 넘는 화면들과 헛도는 화면 — 시험용.
//   127.0.0.1 사이트: 새 탭을 여는 링크, 눌러도 아무 일 없는 단추, 검색 칸, 받을 오디오 파일, 로그인을 요구하는 회원 전용 페이지
//   구글 흉내(브라우저 안에서 route 로 대신 답함): NotebookLM 첫 화면 · 로그인한 화면, accounts.google.com 의 로그인 · 거절 화면
// 단추는 자리를 고정해 둔다(뷰포트 1280×800): 누른 자리 원(browser.click)과 사람의 직접 제어 클릭을 좌표로 맞춘다.
import http from 'node:http'

const box = (l, t, w, h) => `position:absolute;left:${l}px;top:${t}px;width:${w}px;height:${h}px;margin:0;padding:0;border:0;font-size:16px`
export const SPOTS = {
  newTab: { x: 200, y: 120 }, nothing: { x: 200, y: 220 }, search: { x: 250, y: 320 }, audio: { x: 200, y: 420 },
  nbSignIn: { x: 1060, y: 40 }, accountsNext: { x: 640, y: 400 },
}

const HOME = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>시험 사이트</title><body style="margin:0;height:800px">
<a id="newtab" href="/tab" target="_blank" style="${box(100, 100, 200, 40)};display:block;background:#def">새 탭 열기</a>
<button id="nothing" style="${box(100, 200, 200, 40)}">아무 일 없음</button>
<input id="q" aria-label="검색" placeholder="검색어" style="${box(100, 300, 300, 40)}">
<a id="audio" href="/podcast.mp3" download="팟캐스트.mp3" style="${box(100, 400, 200, 40)};display:block;background:#fed">오디오 받기</a>
<input id="file" type="file" aria-label="파일 올리기" style="${box(100, 500, 300, 40)}" onchange="document.getElementById('src').textContent='소스 1개: '+this.files[0].name">
<div id="src" style="${box(100, 560, 300, 40)}">소스 0개</div>
</body></html>`
const TAB = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>새 탭</title><body style="margin:0">
<h1>새 탭 내용</h1><button id="close" onclick="window.close()" style="${box(100, 200, 200, 40)}">창 닫기</button></body></html>`
const MEMBERS = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>회원 전용</title><body>
<h1>회원 전용</h1><p>로그인이 필요합니다.</p><a href="/login">로그인</a></body></html>`

// NotebookLM 첫 화면(로그인 안 됨): 실제 화면처럼 「로그인」, 「Gemini Notebook에 로그인」만 있다
export const NB_FRONT = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Gemini Notebook</title><body style="margin:0;height:800px">
<a href="https://accounts.google.com/v3/signin/identifier?continue=https://notebook.google.com/" style="${box(1000, 20, 120, 40)};display:block;background:#cde">로그인</a>
<h1 style="margin-top:120px">무엇이든 이해할 수 있습니다</h1>
<a href="https://accounts.google.com/v3/signin/identifier?continue=https://notebook.google.com/">Gemini Notebook에 로그인</a></body></html>`
export const NB_APP = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Gemini Notebook</title><body>
<h1>최근 노트북</h1><button>새 노트북</button><button aria-label="Google 계정: 시험 사용자">시</button></body></html>`
export const ACCOUNTS = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>로그인 - Google 계정</title><body style="margin:0;height:800px">
<h1>로그인</h1><p>Google 계정 사용</p>
<button id="next" onclick="location.href='https://accounts.google.com/continue'" style="${box(540, 380, 200, 40)}">다음</button></body></html>`
export const REFUSED = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>로그인 - Google 계정</title><body>
<h1>로그인할 수 없음</h1><p>이 브라우저 또는 앱은 안전하지 않을 수 있습니다. 다른 브라우저를 사용해 보세요.</p></body></html>`

export async function startWalls() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/podcast.mp3') { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Disposition': 'attachment; filename="podcast.mp3"' }); return res.end(Buffer.from('ID3 test audio')) }
    const page = { '/': HOME, '/tab': TAB, '/members': MEMBERS }[u.pathname]
    res.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page || 'not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

// The Google look-alikes, answered inside the browser (nothing reaches Google). state.signedIn: the
// person finished signing in; state.refuse: Google turns the sign-in down.
export async function routeGoogle(ctx, state) {
  const html = (route, body) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body })
  await ctx.route(/^https:\/\/(notebook|notebooklm)\.google\.com\//, (route) => html(route, state.signedIn ? NB_APP : NB_FRONT))
  await ctx.route(/^https:\/\/accounts\.google\.com\//, (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/continue') {
      if (state.refuse) return html(route, REFUSED)
      state.signedIn = true
      return html(route, '<!doctype html><meta charset="utf-8"><script>location.replace("https://notebook.google.com/")</script>')
    }
    return html(route, ACCOUNTS)
  })
}
