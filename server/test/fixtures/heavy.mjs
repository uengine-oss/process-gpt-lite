// 무거운 사이트와 끝나지 않는 페이지 — 서버 브라우저가 멈춘 것처럼 보이던 일(2026-11-24 「계룡대 인근 숙소 검색」)을 재현하는 시험용.
// 숙소 이름은 모두 지어낸 것이다(실제 사이트·회사를 흉내 내지 않음). 밖으로 나가는 요청은 없다.
//   /never-idle  문서는 바로 오지만 'load' 가 오지 않는 페이지(끝나지 않는 그림 하나) + 0.1초마다 새 요청(networkidle 없음)
//   /slow-doc    문서의 앞부분만 오고 끝나지 않는 페이지(DOMContentLoaded 가 오지 않음)
//   /slow?ms=    응답이 ms 뒤에야 시작되는 주소
//   /huge?n=     링크 n개(기본 20000)와 글 상자 수천 개, 맨 위 검색 칸, 내리면 더 붙는(무한 스크롤) 목록
//   /stay        숙소 찾기: 검색 칸 · 검색 단추 → 결과(지어낸 숙소 3곳과 1박 가격) + 아래에 카드 1500장, 계속 새 요청
//   /stuck       「멈추기 시험」을 누르면 페이지의 스크립트가 끝나지 않는다(렌더러가 답하지 않음)
//   /pay         「결제하기」 단추 하나(승인을 기다리는 동안은 동작의 한도에 들지 않는다는 시험)
//   /picker      날짜를 고르고 「검색」을 누르면 처음 화면으로 돌아가는 고르개(되풀이 시험)
//   /framed      검색 결과가 다른 출처의 iframe(localhost) 안에 있는 지도 같은 페이지: 카페 3곳과 「더 보기」 단추
import http from 'node:http'

const html = (title, body, head = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`
const POLL = '<script>setInterval(() => fetch("/tick?" + Math.random()).catch(() => {}), 100)</script>'

export const CAFES = ['가상동 달빛 카페', '가상동 소나무 커피', '가상동 역전 다방']

export const STAYS = [
  { name: '가상시 솔숲 게스트하우스', price: '1박 68,000원' },
  { name: '가상시 호수뷰 호텔', price: '1박 112,000원' },
  { name: '가상시 역앞 비즈니스 모텔', price: '1박 54,000원' },
]

const HUGE = (n) => html('아주 큰 페이지', `
<input id="q" placeholder="여행지 검색" aria-label="여행지 검색" style="font-size:18px">
<button id="go">찾기</button>
<div id="list"></div>
<script>
  const list = document.getElementById('list')
  const add = (from, count) => { const f = document.createDocumentFragment(); for (let i = from; i < from + count; i++) { const d = document.createElement('div'); d.innerHTML = '<a href="#a' + i + '">링크 ' + i + '</a> <span>설명 ' + i + ' 가상 상품 소개 문장</span>'; f.appendChild(d) } list.appendChild(f) }
  add(0, ${n})
  let more = ${n}
  addEventListener('scroll', () => { if (innerHeight + scrollY > document.body.scrollHeight - 2000) { add(more, 500); more += 500 } })
</script>${POLL}`)

const STAY = html('가상 숙소 찾기', `
<header style="height:60px;background:#eef"><a href="#">홈</a> <a href="#">국내</a> <a href="#">해외</a></header>
<form id="f" onsubmit="event.preventDefault(); show()">
  <input id="where" placeholder="어디로 떠나시나요?" aria-label="여행지" style="font-size:18px">
  <button id="search" type="submit">검색</button>
</form>
<section id="results"></section>
<div id="cards"></div>
<img src="/hang.png" alt="" width="1" height="1">
<script>
  const STAYS = ${JSON.stringify(STAYS)}
  function show() {
    const where = document.getElementById('where').value
    setTimeout(() => {
      document.getElementById('results').innerHTML = '<h2>' + where + ' 숙소 ' + STAYS.length + '곳</h2>' + STAYS.map((s) => '<div class="stay"><b>' + s.name + '</b> <span>' + s.price + '</span></div>').join('')
    }, 300)
  }
  const cards = document.getElementById('cards')
  for (let i = 0; i < 1500; i++) { const d = document.createElement('div'); d.innerHTML = '<a href="#c' + i + '">추천 코스 ' + i + '</a><p>지어낸 여행 코스 설명 ' + i + '</p>'; cards.appendChild(d) }
</script>${POLL}`)

const STUCK = html('멈추는 페이지', `<h1>멈추는 페이지</h1><button id="freeze" onclick="setTimeout(() => { for (;;) {} }, 50)">멈추기 시험</button><p>이 단추를 누르면 페이지가 답하지 않아요.</p>`)

export async function startHeavy() {
  const held = new Set()
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const send = (body, type = 'text/html; charset=utf-8') => { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body) }
    if (u.pathname === '/tick') return send('ok', 'text/plain')
    // never answered: a picture that never finishes keeps 'load' from coming
    if (u.pathname === '/hang.png' || u.pathname === '/hang.js') { held.add(res); res.on('close', () => held.delete(res)); return }
    if (u.pathname === '/never-idle') return send(html('끝나지 않는 페이지', `<h1>끝나지 않는 페이지</h1><p>이 페이지는 계속 불러와요.</p><img src="/hang.png" alt="" width="1" height="1">${POLL}`))
    if (u.pathname === '/slow-doc') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.write('<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>반쯤 온 문서</title></head><body><h1>반쯤 온 문서</h1><script src="/hang.js"></script>')
      held.add(res)
      res.on('close', () => held.delete(res))
      return
    }
    if (u.pathname === '/slow') {
      const t = setTimeout(() => send(html('느린 응답', '<h1>느린 응답</h1>')), Number(u.searchParams.get('ms') || 10000))
      res.on('close', () => clearTimeout(t))
      return
    }
    if (u.pathname === '/huge') return send(HUGE(Number(u.searchParams.get('n') || 20000)))
    if (u.pathname === '/stay') return send(STAY)
    if (u.pathname === '/stuck') return send(STUCK)
    if (u.pathname === '/framed') {
      const port = server.address().port
      return send(html('가상 지도', `<input placeholder="장소 검색" aria-label="장소 검색"><div style="display:flex"><iframe id="list" src="http://localhost:${port}/inner" style="width:420px;height:500px;border:0"></iframe><div style="width:800px;height:500px;background:#dde">지도</div></div><iframe src="http://localhost:${port}/pixel" width="1" height="1"></iframe>`))
    }
    if (u.pathname === '/pay') return send(html('가상 상점 결제', `<h1>가상 상품 1개 · 9,900원</h1><button onclick="document.getElementById('done').textContent = '결제 완료'">결제하기</button><p id="done"></p>`))
    if (u.pathname === '/picker') return send(html('가상 날짜 고르기', `<h1>가상 날짜 고르기</h1><div id="sel">선택: 없음</div><button onclick="pick('18')">18</button> <button onclick="pick('20')">20</button> <button onclick="a = []; show()">검색</button><script>let a = []; const show = () => { document.getElementById('sel').textContent = '선택: ' + (a.join('~') || '없음') }; function pick(d) { a.push(d); show() }</script>`))
    if (u.pathname === '/inner') return send(html('검색 결과', `<ul id="r">${CAFES.map((c) => `<li><a href="#">${c}</a> 대전 가상구</li>`).join('')}</ul><button onclick="this.insertAdjacentHTML('beforebegin', '<p>가상동 넷째 카페</p>')">더 보기</button><div style="height:2400px"></div><p>목록 맨 아래: 가상동 끝집 카페</p>`))
    if (u.pathname === '/pixel') return send(html('추적', '<a href="#">숨은 링크</a>'))
    send(html('시험 사이트', '<h1>시험 사이트</h1>'))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { for (const res of held) res.destroy(); server.closeAllConnections?.(); server.close(r) }),
  }
}
