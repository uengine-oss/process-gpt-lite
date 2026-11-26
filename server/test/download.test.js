// 「내려받기」 — 파일이 열린 곳마다 머리의 같은 단추(2026-11-26 사용자: 「파일을 열면 바로 열리는 건 좋은데 다운로드 받을 방법이 없네 …」, 스펙
// openspec/specs/file-download). 무엇을 어떤 이름으로 받는지(src/downloadPlan.js)와 브라우저에서 어떻게 받는지(src/download.js)를 화면 없이 본다.
//   FD-U-01~05 이름: 보이는 이름 그대로(한글 · 띄어쓰기 · 괄호, NFC), 확장자가 없으면 주소 · 저장된 형식에서, 주소가 다른 종류면 그 종류로
//   FD-U-06~09 주소: 저장소는 그 주소 그대로(자격 증명 없이), 이 서버의 경로는 그 서명 · 토큰 그대로(폴더 raw 는 download=1), 공개 주소를 만들지 않음
//   FD-U-10~14 받기: 가져와 blob 으로 <a download=이름>, 거절은 사람의 말로, 가져오지 못하면 새 탭(저장소는 ?download=이름), 막히면 누를 링크
import test from 'node:test'
import assert from 'node:assert/strict'
import { downloadName, addressExt, nameExt, downloadPlan, storageDownloadUrl, isStorage, doneNote, refusal, BLOB_MAX } from '../../src/downloadPlan.js'
import { saveFile } from '../../src/download.js'

const STORE = 'http://127.0.0.1:54321/storage/v1/object/public/files/pgpt-pro/7d3f0a52-0c1e-4c6b-9f5e-1a2b3c4d5e6f/att/0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d'
const PAGE = 'http://127.0.0.1:5367'

test('FD-U-01 보이는 이름 그대로 — 한글 · 띄어쓰기 · 괄호 · #, 맥의 풀어 쓴 한글은 모아 씀(NFC)', () => {
  assert.equal(downloadName('견적서 초안 (최종).docx', `${STORE}.docx`), '견적서 초안 (최종).docx')
  assert.equal(downloadName('Moonlight Coffee Store #2 proposal.docx', `${STORE}.docx`), 'Moonlight Coffee Store #2 proposal.docx')
  const nfd = '급여대장.xlsx'.normalize('NFD')
  assert.notEqual(nfd, '급여대장.xlsx')
  assert.equal(downloadName(nfd, `${STORE}.xlsx`), '급여대장.xlsx')
})

test('FD-U-02 파일 이름에 못 쓰는 글자만 _ 로 — 경로 구분자 · 제어 문자 · 앞의 점, 빈 이름은 주소의 이름', () => {
  assert.equal(downloadName('보고서/2026:11월*최종?.pdf', `${STORE}.pdf`), '보고서_2026_11월_최종_.pdf')
  assert.equal(downloadName('..\\비밀.txt\u0007', `${STORE}.txt`), '_비밀.txt')
  assert.equal(downloadName('', '/api/folders/f1/raw?ref=main&path=%EC%9D%B4%EB%A0%A5%EC%84%9C%2F%EC%9E%A5%EC%A7%84%EC%98%81_%ED%94%84%EB%A1%9C%ED%95%84.docx'), '장진영_프로필.docx')
  assert.equal(downloadName('   ', ''), 'download')
})

test('FD-U-03 이름에 확장자가 없으면 — 주소의 종류, 없으면 저장된 형식(MIME)에서', () => {
  // a site's 「download」 kept as audio/mp4 (the messenger's case) · a TIFF named without one
  assert.equal(downloadName('download', '/api/team/shares/5b1c/raw?u=1&exp=2&inline=1&sig=x', 'audio/mp4'), 'download.m4a')
  assert.equal(downloadName('팩스', `${STORE}.tif`), '팩스.tif')
  assert.equal(downloadName('회의록', `${STORE}.bin`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), '회의록.docx')
  // nothing known: as it is
  assert.equal(downloadName('메모', '/api/mail/attachments/a/0/raw?u=1&sig=x', ''), '메모')
  // "v1.2 보고서" has no extension of its own
  assert.equal(nameExt('v1.2 보고서'), '')
  assert.equal(downloadName('v1.2 보고서', `${STORE}.pdf`), 'v1.2 보고서.pdf')
})

test('FD-U-04 주소가 다른 종류면 그 종류로(바이트가 그 형식) — 같은 종류의 다른 표기는 이름 그대로', () => {
  // a 한글 card whose saved copy is .hwpx; a PhotoCraft save of a .png card
  assert.equal(downloadName('견적서.hwp', 'http://127.0.0.1:54321/storage/v1/object/public/files/pgpt-pro/u/att/edited-x_20261126101010.hwpx'), '견적서.hwpx')
  assert.equal(downloadName('현장 사진.png', `${STORE}.pcraft`), '현장 사진.pcraft')
  // jpg/jpeg · tif/tiff · htm/html: the name's own spelling
  assert.equal(downloadName('사진.jpeg', `${STORE}.jpg`), '사진.jpeg')
  assert.equal(downloadName('팩스.tiff', `${STORE}.tif`), '팩스.tiff')
  // a storage key's generic .bin says nothing
  assert.equal(downloadName('도면.dxf', `${STORE}.bin`), '도면.dxf')
  // a route tells its kind by ?path=
  assert.equal(addressExt('/api/workroom/chat/r1/raw?path=out%2F%EB%B3%B4%EA%B3%A0%EC%84%9C.pptx&token=t'), 'pptx')
  assert.equal(addressExt('/api/mail/attachments/a/0/raw?u=1&sig=x'), '')
})

test('FD-U-05 긴 이름은 확장자를 남기고 줄임(120자)', () => {
  const long = `${'아주 긴 회의 자료 제목 '.repeat(20)}.pptx`
  const n = downloadName(long, `${STORE}.pptx`)
  assert.ok(n.length <= 120, n.length)
  assert.ok(n.endsWith('.pptx'))
})

test('FD-U-06 저장소 주소는 그대로, 자격 증명 없이(CORS) — 대체 길은 ?download=이름(한글은 인코딩)', () => {
  const p = downloadPlan(`${STORE}.docx`, { origin: PAGE, name: '견적서 초안.docx' })
  assert.equal(p.how, 'fetch')
  assert.equal(p.url, `${STORE}.docx`)
  assert.equal(p.credentials, 'omit')
  assert.equal(p.same, false)
  const fb = new URL(p.fallback)
  assert.equal(fb.searchParams.get('download'), '견적서 초안.docx')
  assert.match(p.fallback, /download=%EA%B2%AC/)
  // a signed address keeps its token; download is added beside it
  const signed = 'http://127.0.0.1:54321/storage/v1/object/sign/lite-private/mail/t/u/a/0-abc/attachment.xlsx?token=eyJabc'
  assert.equal(isStorage(signed), true)
  const s = new URL(storageDownloadUrl(signed, '급여대장.xlsx'))
  assert.equal(s.searchParams.get('token'), 'eyJabc')
  assert.equal(s.searchParams.get('download'), '급여대장.xlsx')
})

test('FD-U-07 이 서버의 경로는 그 주소 그대로(서명 · 토큰) — 같은 출처, 폴더 raw 는 download=1', () => {
  const mail = '/api/mail/attachments/0f7c9a1e-2b3d-4c5e-8f9a-0b1c2d3e4f5a/1/raw?u=7d3f0a52-0c1e-4c6b-9f5e-1a2b3c4d5e6f&exp=1764000000&inline=1&sig=AbCdEf'
  const p = downloadPlan(mail, { origin: PAGE })
  assert.equal(p.url, mail)
  assert.equal(p.same, true)
  assert.equal(p.credentials, 'same-origin')
  const folder = downloadPlan('/api/folders/f-1/raw?ref=main&path=a.docx&token=t1', { origin: PAGE })
  assert.match(folder.url, /^\/api\/folders\/f-1\/raw\?ref=main&path=a\.docx&token=t1&download=1$/)
  // already asked for: not twice
  assert.equal(downloadPlan('/api/folders/f-1/raw?path=a.docx&download=1', { origin: PAGE }).url, '/api/folders/f-1/raw?path=a.docx&download=1')
  // behind the gateway (/lite): the same origin, its path kept
  assert.equal(downloadPlan(`${PAGE}/lite/api/team/shares/s1/raw?u=1&sig=x`, { origin: PAGE }).url, '/lite/api/team/shares/s1/raw?u=1&sig=x')
})

test('FD-U-08 받을 것이 없으면 none — 빈 주소 · 다른 scheme', () => {
  assert.equal(downloadPlan('', { origin: PAGE }).how, 'none')
  assert.equal(downloadPlan('javascript:alert(1)', { origin: PAGE }).how, 'none')
  assert.equal(downloadPlan('file:///etc/passwd', { origin: PAGE }).how, 'none')
})

test('FD-U-09 말: 어느 판을 받았는지 · 거절은 서버의 말, 없으면 사람의 말', () => {
  assert.equal(doneNote({ name: '견적서.docx' }), '내려받았어요 · 견적서.docx')
  assert.equal(doneNote({ version: 'saved', name: '견적서.docx' }), '방금 저장한 판을 내려받았어요 · 견적서.docx')
  assert.match(doneNote({ version: 'last', name: '견적서.docx' }), /^마지막으로 저장된 판을 내려받았어요 — 방금 고친 내용은 들어 있지 않아요 · 견적서\.docx$/)
  assert.equal(refusal(401), '주소가 만료됐어요. 다시 열어 주세요.')
  assert.equal(refusal(404), '파일을 찾지 못했어요.')
  assert.equal(refusal(403, '첨부를 찾지 못했어요.'), '첨부를 찾지 못했어요.')
})

// ---------- in a stand-in browser: what is fetched, what the link says ----------
function browser({ open = true } = {}) {
  const clicks = []
  const opened = []
  const doc = {
    body: { appendChild() {} },
    createElement: () => { const a = { style: {}, click() { clicks.push({ href: a.href, download: a.download }) }, remove() {} }; return a },
  }
  const win = {
    location: { origin: PAGE },
    document: doc,
    open: () => (open ? { set opener(_) {}, location: { set href(u) { opened.push(u) } } } : null),
  }
  return { win, clicks, opened }
}
const realFetch = globalThis.fetch
function serve(fn) { const calls = []; globalThis.fetch = async (u, o) => { calls.push({ u, o }); return fn(u, o) }; return calls }
test.afterEach(() => { globalThis.fetch = realFetch })

test('FD-U-10 저장소의 파일: 가져와 blob 으로, 보이는 이름으로 <a download>', async () => {
  const calls = serve(() => new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { 'content-type': 'application/zip', 'content-length': '4' } }))
  const b = browser()
  const r = await saveFile({ url: `${STORE}.docx`, name: '견적서 초안 (최종).docx' }, { win: b.win })
  assert.deepEqual(r, { how: 'saved', name: '견적서 초안 (최종).docx', size: 4 })
  assert.equal(calls[0].u, `${STORE}.docx`)
  assert.equal(calls[0].o.credentials, 'omit')
  assert.equal(b.clicks.length, 1)
  assert.match(b.clicks[0].href, /^blob:/)
  assert.equal(b.clicks[0].download, '견적서 초안 (최종).docx')
})

test('FD-U-11 서버가 거절하면 그 말로(던짐, status) — 아무것도 받지 않음', async () => {
  serve(() => new Response(JSON.stringify({ error: '주소가 만료됐어요. 다시 열어 주세요.' }), { status: 401, headers: { 'content-type': 'application/json' } }))
  const b = browser()
  await assert.rejects(saveFile({ url: '/api/mail/attachments/a/0/raw?u=1&sig=x', name: '급여대장.xlsx' }, { win: b.win }), (e) => e.status === 401 && e.message === '주소가 만료됐어요. 다시 열어 주세요.')
  serve(() => new Response('nope', { status: 404 }))
  await assert.rejects(saveFile({ url: `${STORE}.pdf`, name: '계약서.pdf' }, { win: b.win }), /파일을 찾지 못했어요/)
  assert.equal(b.clicks.length, 0)
})

test('FD-U-12 가져오지 못하면(CORS · 네트워크) 새 탭 — 저장소는 ?download=이름, 탭이 막히면 누를 링크', async () => {
  serve(() => { throw new TypeError('Failed to fetch') })
  const b = browser()
  const r = await saveFile({ url: `${STORE}.pdf`, name: '계약서.pdf' }, { win: b.win })
  assert.equal(r.how, 'opened')
  assert.equal(new URL(b.opened[0]).searchParams.get('download'), '계약서.pdf')
  const blocked = browser({ open: false })
  const r2 = await saveFile({ url: `${STORE}.pdf`, name: '계약서.pdf' }, { win: blocked.win })
  assert.equal(r2.how, 'link')
  assert.equal(new URL(r2.href).searchParams.get('download'), '계약서.pdf')
})

test('FD-U-13 너무 큰 파일은 메모리에 두지 않음 — 이 서버의 경로는 그 주소로 <a download>, 저장소는 새 탭', async () => {
  serve(() => new Response('x', { status: 200, headers: { 'content-length': String(BLOB_MAX + 1) } }))
  const b = browser()
  const r = await saveFile({ url: '/api/folders/f-1/raw?path=%EC%98%81%EC%83%81.mp4&token=t', name: '영상.mp4' }, { win: b.win })
  assert.equal(r.how, 'saved')
  assert.equal(b.clicks[0].href, '/api/folders/f-1/raw?path=%EC%98%81%EC%83%81.mp4&token=t&download=1')
  assert.equal(b.clicks[0].download, '영상.mp4')
  const c = browser()
  assert.equal((await saveFile({ url: `${STORE}.mp4`, name: '영상.mp4' }, { win: c.win })).how, 'opened')
})

test('FD-U-14 받을 주소가 없으면 말로', async () => {
  await assert.rejects(saveFile({ url: '', name: 'x.pdf' }, { win: browser().win }), /내려받을 주소가 없어요/)
})
