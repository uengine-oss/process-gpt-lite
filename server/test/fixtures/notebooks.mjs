// A small site for the browser queue tests (2026-11-25 recordings, project room 「링크 슬라이드 팟캐스트」) — made up, no real service:
//   /notebooks?n=20          a list of notebooks like NotebookLM's 「제목 없는 노트북」 rows: each row's 「more_vert」 opens a menu with
//                            「delete 삭제」, which asks 「삭제」 in a dialog, which removes that row (one notebook fewer each round)
//   /notebooks?n=5&broken=1  the same, but 「삭제」 only closes the dialog: the same rounds on a list that never changes
//   /ask                     a plain page to wait on
//   /nb                      a NotebookLM-like notebook: 「웹사이트」 takes an address and adds it as a source — an address on the
//                            blocked host stays 「소스 0개」 for ever (the site will not let it be read); 「파일 업로드」 takes a file
//                            (a file chooser) and shows 「소스 1개: <name>」
//   /article                 a long article page (the PDF route reads it), its host is the blocked one
import http from 'node:http'

const page = (title, body, script = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:24px} .row{display:flex;gap:16px;align-items:center;padding:8px 0;border-bottom:1px solid #ddd}
[role=menu],[role=dialog]{position:fixed;top:120px;left:200px;background:#fff;border:1px solid #999;padding:16px;display:flex;gap:8px}</style></head>
<body>${body}<script>${script}</script></body></html>`

const DAYS = Array.from({ length: 200 }, (_, i) => `2026. ${9 + Math.floor(i / 28)}. ${1 + (i % 28)}.`)

function notebooks(n, broken) {
  const rows = Array.from({ length: n }, (_, i) => `<div class="row" data-i="${i}"><span>제목 없는 노트북</span><span>소스 0개</span><span>${DAYS[i]}</span><button class="mv">more_vert</button></div>`).join('')
  return page('Gemini Notebook', `<h1>노트북</h1><p id="count">노트북 ${n}개</p><div id="list">${rows}</div>`, `
let target = null
const close = () => document.querySelectorAll('[role=menu],[role=dialog]').forEach((e) => e.remove())
document.addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  if (b.classList.contains('mv')) { close(); target = b.closest('.row'); const m = document.createElement('div'); m.setAttribute('role', 'menu')
    m.innerHTML = '<button class="del">delete 삭제</button><button>edit 이름 바꾸기</button>'; document.body.append(m); return }
  if (b.classList.contains('del')) { close(); const d = document.createElement('div'); d.setAttribute('role', 'dialog')
    d.innerHTML = '<span>노트북을 삭제할까요?</span><button class="no">취소</button><button class="yes">삭제</button>'; document.body.append(d); return }
  if (b.classList.contains('yes')) { close(); if (!${broken ? 'true' : 'false'} && target) { target.remove(); document.getElementById('count').textContent = '노트북 ' + document.querySelectorAll('.row').length + '개' } target = null; return }
  if (b.classList.contains('no')) close()
})`)
}

function notebook() {
  return page('새 노트북 - NotebookLM', `<h1>새 노트북</h1><p id="src">소스 0개</p>
<div><button id="web">웹사이트</button> <button id="up">파일 업로드</button></div>
<div id="webbox" hidden><input id="url" placeholder="URL 붙여넣기"> <button id="ins">삽입</button></div>
<div id="upbox" hidden><input id="file" type="file" accept="application/pdf"></div>
<ul id="list"></ul>`, `
const src = document.getElementById('src')
document.getElementById('web').onclick = () => { document.getElementById('webbox').hidden = false }
document.getElementById('up').onclick = () => { document.getElementById('upbox').hidden = false }
document.getElementById('ins').onclick = () => {
  const u = document.getElementById('url').value
  const li = document.createElement('li'); li.textContent = '가져오는 중: ' + u; document.getElementById('list').append(li)
  // the blocked host is never read: the source stays at 0 (as Medium does to NotebookLM)
  if (!/blocked/.test(u)) setTimeout(() => { src.textContent = '소스 1개: ' + u; li.textContent = u }, 300)
}
document.getElementById('file').onchange = (e) => {
  const f = e.target.files[0]
  if (!f) return
  f.arrayBuffer().then((b) => { const ok = new TextDecoder().decode(new Uint8Array(b).slice(0, 5)) === '%PDF-'
    src.textContent = ok ? '소스 1개: ' + f.name : '소스 0개 (PDF 가 아님)'; const li = document.createElement('li'); li.textContent = f.name + ' (' + b.byteLength + ' bytes)'; document.getElementById('list').append(li) })
}`)
}

const ARTICLE = page('Agentic AI in practice — blocked.example', `<article><h1>Agentic AI in practice</h1>
${Array.from({ length: 12 }, (_, i) => `<p>문단 ${i + 1}. 에이전트가 일하는 방식에 대한 긴 글의 한 부분입니다. 이 글은 시험용으로 지어낸 것입니다.</p>`).join('')}</article>`)

export async function startNotebooks(port = 0) {
  const hits = []
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    hits.push(u.pathname)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (u.pathname === '/notebooks') return res.end(notebooks(Math.min(200, Number(u.searchParams.get('n') || 20)), u.searchParams.get('broken') === '1'))
    if (u.pathname === '/ask') return res.end(page('노트 사이트', '<h1>노트 사이트</h1><p>여기서 노트북을 고르거나 새로 만들 수 있어요.</p><button>새 노트북</button>'))
    if (u.pathname === '/nb') return res.end(notebook())
    if (u.pathname === '/article') return res.end(ARTICLE)
    res.statusCode = 404
    res.end('no')
  })
  await new Promise((r) => srv.listen(port, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`
  return { url, hits, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) }) }
}
