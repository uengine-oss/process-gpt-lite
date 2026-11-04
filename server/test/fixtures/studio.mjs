// 오래 걸려 만들어지는 파일을 받는 작은 사이트: 생성을 누르면 몇 초 뒤 다운로드가 생긴다. 파일 올리기 칸도 있다. 시험용.
import http from 'node:http'

const PAGE = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>스튜디오</title><body>
<h1>스튜디오</h1>
<div id="src">소스 0개</div>
<input id="file" type="file" aria-label="파일 업로드" onchange="document.getElementById('src').textContent='소스 1개: '+this.files[0].name">
<button id="pick" onclick="document.getElementById('file').click()">파일 고르기</button>
<button id="go" onclick="start()">생성</button>
<div id="state">대기</div><div id="done"></div>
<script>
function start(){ const s=document.getElementById('state'); s.textContent='생성 중'; const wait=Number(new URLSearchParams(location.search).get('ms')||1000);
  setTimeout(()=>{ s.textContent='완료'; document.getElementById('done').innerHTML='<a id="dl" href="/report.pdf" download="오디오 보고서.pdf">다운로드</a>' }, wait) }
</script></body></html>`

export async function startStudio() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/report.pdf')) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment' }); return res.end('%PDF-1.4 studio test') }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) }
}
