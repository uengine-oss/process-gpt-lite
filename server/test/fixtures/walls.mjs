// 브라우저 에이전트가 혼자 못 넘는 화면들과 헛도는 화면 — 시험용.
//   127.0.0.1 사이트: 새 탭을 여는 링크, 눌러도 아무 일 없는 단추, 검색 칸, 받을 오디오 파일(이름 없는 것도), 회원 전용 페이지, 사람 확인 페이지
//   로그인이 따로 있는 앱(브라우저 안에서 route 로 대신 답함, 밖으로 나가지 않음): studio.example 의 첫 화면 · 로그인한 화면,
//   id.example 의 로그인 · 거절 화면. 어느 회사의 주소도 흉내 내지 않는다 — 코드는 주소가 아니라 판정으로 벽을 알아본다.
// 화면이 무엇인지는 가짜 판정 서버(startJudge)가 제목으로 답한다: 판정 모델의 자리.
// 단추는 자리를 고정해 둔다(뷰포트 1280×800): 누른 자리 원(browser.click)과 사람의 직접 제어 클릭을 좌표로 맞춘다.
import http from 'node:http'

const box = (l, t, w, h) => `position:absolute;left:${l}px;top:${t}px;width:${w}px;height:${h}px;margin:0;padding:0;border:0;font-size:16px`
export const SPOTS = {
  newTab: { x: 200, y: 120 }, nothing: { x: 200, y: 220 }, search: { x: 250, y: 320 }, audio: { x: 200, y: 420 }, bare: { x: 500, y: 420 },
  appSignIn: { x: 1060, y: 40 }, idNext: { x: 640, y: 400 },
}
export const TITLES = {
  front: '스튜디오 — 시작하기', app: '스튜디오 — 내 문서', signIn: '로그인 - 아이디 서비스', refused: '로그인할 수 없음 - 아이디 서비스',
  members: '회원 전용', check: '잠시 확인', home: '시험 사이트', tab: '새 탭',
}

const HOME = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${TITLES.home}</title><body style="margin:0;height:800px">
<a id="newtab" href="/tab" target="_blank" style="${box(100, 100, 200, 40)};display:block;background:#def">새 탭 열기</a>
<button id="nothing" style="${box(100, 200, 200, 40)}">아무 일 없음</button>
<input id="q" aria-label="검색" placeholder="검색어" style="${box(100, 300, 300, 40)}">
<a id="audio" href="/podcast.mp3" download="팟캐스트.mp3" style="${box(100, 400, 200, 40)};display:block;background:#fed">오디오 받기</a>
<a id="bare" href="/media/download" download style="${box(400, 400, 200, 40)};display:block;background:#efd">이름 없는 파일 받기</a>
<input id="file" type="file" aria-label="파일 올리기" style="${box(100, 500, 300, 40)}" onchange="document.getElementById('src').textContent='소스 1개: '+this.files[0].name">
<div id="src" style="${box(100, 560, 300, 40)}">소스 0개</div>
</body></html>`
const TAB = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${TITLES.tab}</title><body style="margin:0">
<h1>새 탭 내용</h1><button id="close" onclick="window.close()" style="${box(100, 200, 200, 40)}">창 닫기</button></body></html>`
const MEMBERS = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${TITLES.members}</title><body>
<h1>회원 전용</h1><p>로그인이 필요합니다.</p><a href="/login">로그인</a></body></html>`
const CHECK = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${TITLES.check}</title><body>
<h1>잠시만 기다려 주세요</h1><label><input type="checkbox"> 확인</label></body></html>`

// 로그인하지 않은 앱의 첫 화면: 로그인 단추만 있다. 이름은 페이지 자신이 말한다(og:site_name)
const FRONT = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta property="og:site_name" content="스튜디오"><title>${TITLES.front}</title><body style="margin:0;height:800px">
<a href="https://id.example/signin?continue=https://studio.example/" style="${box(1000, 20, 120, 40)};display:block;background:#cde">로그인</a>
<h1 style="margin-top:120px">무엇이든 만들 수 있습니다</h1>
<a href="https://id.example/signin?continue=https://studio.example/">스튜디오에 로그인</a></body></html>`
const APP = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta property="og:site_name" content="스튜디오"><title>${TITLES.app}</title><body>
<h1>최근 문서</h1><button>새 문서</button><button aria-label="계정: 시험 사용자">시</button></body></html>`
const SIGN_IN = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="application-name" content="아이디 서비스"><title>${TITLES.signIn}</title><body style="margin:0;height:800px">
<h1>로그인</h1><p>계정을 사용하세요</p><input type="email" autocomplete="username" aria-label="이메일" style="${box(540, 300, 200, 40)}">
<button id="next" onclick="location.href='https://id.example/continue'" style="${box(540, 380, 200, 40)}">다음</button></body></html>`
const REFUSED = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="application-name" content="아이디 서비스"><title>${TITLES.refused}</title><body>
<h1>로그인할 수 없음</h1><p>이 브라우저에서는 로그인할 수 없어요. 다른 브라우저를 사용해 보세요.</p></body></html>`

export async function startWalls() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    // NotebookLM's audio overview: no file name, no type — only the bytes say it is M4A (2026-11-22)
    if (u.pathname === '/media/download') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A ', 'latin1'), Buffer.alloc(4), Buffer.from('isommp42 test audio', 'latin1')])) }
    if (u.pathname === '/podcast.mp3') { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Disposition': 'attachment; filename="podcast.mp3"' }); return res.end(Buffer.from('ID3 test audio')) }
    const page = { '/': HOME, '/tab': TAB, '/members': MEMBERS, '/check': CHECK }[u.pathname]
    res.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page || 'not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

// The app with a separate sign-in, answered inside the browser (nothing leaves it). state.signedIn: the
// person finished signing in; state.refuse: the sign-in service turns this browser down.
export async function routeApp(ctx, state) {
  const html = (route, body) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body })
  await ctx.route(/^https:\/\/studio\.example\//, (route) => html(route, state.signedIn ? APP : FRONT))
  await ctx.route(/^https:\/\/id\.example\//, (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/continue') {
      if (state.refuse) return html(route, REFUSED)
      state.signedIn = true
      return html(route, '<!doctype html><meta charset="utf-8"><script>location.replace("https://studio.example/")</script>')
    }
    return html(route, SIGN_IN)
  })
}

// The judge model's stand-in (context-router's POST /judge shape): probabilities by the page title in the
// state it is sent. verdicts[title] = {key: p} or 'down'; calls counts what was asked, by title.
export async function startJudge(verdicts) {
  const calls = {}
  const states = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const { state } = JSON.parse(raw)
      states.push(state)
      const title = /^Page title: (.*)$/m.exec(state)?.[1] || ''
      calls[title] = (calls[title] || 0) + 1
      const v = verdicts[title]
      if (v === 'down') { res.writeHead(500); return res.end('{}') }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ probabilities: v || { login_needed: 0.05, refused: 0.02, human_check: 0.03, ok: 0.9 }, model: 'fake-judge', ms: 1 }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/judge`, calls, states, close: () => new Promise((r) => server.close(r)) }
}

// What a test's made-up user left in storage and the workspace (downloaded files, attached files).
export async function dropFiles(userId) {
  const { admin } = await import('../../lib/supa.js')
  const { workspaceHostPath } = await import('../../lib/missions.js')
  const dir = `pgpt-pro/${userId}/att`
  const { data } = await admin.storage.from('files').list(dir, { limit: 1000 }).catch(() => ({ data: [] }))
  if (data?.length) await admin.storage.from('files').remove(data.map((f) => `${dir}/${f.name}`)).catch(() => {})
  const root = await workspaceHostPath('/workspace').catch(() => null)
  if (root) await (await import('node:fs/promises')).rm(`${root}/uploads/${userId}`, { recursive: true, force: true }).catch(() => {})
}
