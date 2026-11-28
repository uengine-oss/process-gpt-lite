// Google Drive 찾기 · 읽기 (2026-11-28 휴대폰 녹화 20:49): 「구글 드라이브에서 PMO 협회 교육 자료」를 찾지 못해 다른 자료로
// 바꿔 만든 일. 찾기는 이름과 내용 · 공유받은 파일 · 공유 드라이브까지, 낱말마다 따로(모두 → 없으면 하나라도), 읽기는
// 슬라이드 · 문서의 글. Google 은 부르지 않는다 — fetch 를 가짜로 바꾸고 보낸 주소를 본다. DB 도 쓰지 않는다(토큰을 직접 준다).
//   cd server && node --test test/driveSearch.test.js
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import * as G from '../lib/google.js'

const TOKEN = { token: 'test-access-token' }
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// routes: [[test(url) → boolean, (url) → Response], …]; every call is kept
function stubFetch(routes) {
  const calls = []
  globalThis.fetch = async (input, opts = {}) => {
    const url = new URL(String(input))
    calls.push({ url, auth: opts.headers?.Authorization })
    for (const [when, reply] of routes) if (when(url)) return reply(url)
    return Response.json({ error: { message: `unexpected ${url.pathname}` } }, { status: 404 })
  }
  return calls
}
const isList = (u) => u.pathname === '/drive/v3/files'
const qOf = (u) => u.searchParams.get('q')
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

test('DS-01 낱말마다 이름 또는 내용 — 모두 있어야 하고, 휴지통은 빼고, 공유 드라이브 · 공유받은 파일까지', async () => {
  const calls = stubFetch([[isList, () => Response.json({ files: [{ id: 'f1', name: '가나정밀 교육과정 제안서.pptx', mimeType: PPTX, modifiedTime: '2026-11-13T09:00:00Z', webViewLink: 'https://docs.google.com/presentation/d/f1', owners: [{ displayName: '정하윤' }] }] })]])
  const r = await G.driveSearch('u1', { query: '  가나정밀   교육 자료 ' }, TOKEN)
  const list = calls.find((c) => isList(c.url)).url
  assert.equal(qOf(list), "(name contains '가나정밀' or fullText contains '가나정밀') and (name contains '교육' or fullText contains '교육') and (name contains '자료' or fullText contains '자료') and trashed = false")
  assert.equal(list.searchParams.get('corpora'), 'allDrives')
  assert.equal(list.searchParams.get('includeItemsFromAllDrives'), 'true')
  assert.equal(list.searchParams.get('supportsAllDrives'), 'true')
  assert.match(list.searchParams.get('fields'), /driveId/)
  assert.ok(calls.every((c) => c.auth === 'Bearer test-access-token'), '사람의 토큰으로')
  assert.equal(r.match, 'all_words')
  assert.deepEqual(r.words, ['가나정밀', '교육', '자료'])
  assert.equal(r.files[0].name, '가나정밀 교육과정 제안서.pptx')
  assert.equal(r.files[0].owner, '정하윤')
  assert.equal(r.files[0].words_in_name, 2)
  assert.ok(r.note)
})

test('DS-02 모두 든 파일이 없으면 하나라도 든 파일로 — 결과가 어느 쪽인지 말하고, 이름에 낱말이 많은 파일이 먼저', async () => {
  const calls = stubFetch([[isList, (u) => (/ or fullText contains '가나정밀'\) and/.test(qOf(u))
    ? Response.json({ files: [] })
    : Response.json({ files: [
      { id: 'a', name: '회의 자료 모음', mimeType: 'application/vnd.google-apps.document' },
      { id: 'b', name: '가나정밀 교육 일정.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { id: 'c', name: '가나정밀 안내', mimeType: 'application/pdf' },
    ] }))]])
  const r = await G.driveSearch('u1', { query: '가나정밀 교육 자료', max: 2 }, TOKEN)
  const lists = calls.filter((c) => isList(c.url)).map((c) => c.url)
  assert.equal(lists.length, 2, '처음은 모두, 다음은 하나라도')
  assert.equal(qOf(lists[1]), "((name contains '가나정밀' or fullText contains '가나정밀') or (name contains '교육' or fullText contains '교육') or (name contains '자료' or fullText contains '자료')) and trashed = false")
  assert.equal(lists[1].searchParams.get('corpora'), 'allDrives')
  assert.equal(lists[1].searchParams.get('pageSize'), String(G.DRIVE_SEARCH.fetch), '넓힐 때는 더 많이 받아 순서를 다시 정한다')
  assert.equal(r.match, 'any_word')
  assert.match(r.note, /하나라도|any of them/)
  assert.deepEqual(r.files.map((f) => f.id), ['b', 'a'], '이름에 낱말 둘 → 하나(앞선 것이 먼저), max 2')
})

test('DS-03 낱말 하나는 넓히지 않고, 아무것도 없으면 그렇게 말한다', async () => {
  const calls = stubFetch([[isList, () => Response.json({ files: [] })]])
  const r = await G.driveSearch('u1', { query: '가나정밀' }, TOKEN)
  assert.equal(calls.length, 1)
  assert.equal(r.match, 'none')
  assert.deepEqual(r.files, [])
  assert.match(r.note, /공유 드라이브|shared drives/)
  await assert.rejects(G.driveSearch('u1', { query: '   ' }, TOKEN))
})

test('DS-04 따옴표 · 역슬래시는 Drive 질의 안에서 이스케이프된다', async () => {
  assert.equal(G.driveQuoted("O'Neil"), "'O\\'Neil'")
  assert.equal(G.driveQuoted('a\\b'), "'a\\\\b'")
  assert.equal(G.driveQuoted("x\\'y"), "'x\\\\\\'y'")
  const calls = stubFetch([[isList, () => Response.json({ files: [] })]])
  await G.driveSearch('u1', { query: "O'Neil's 보고서" }, TOKEN)
  const q = qOf(calls[0].url)
  assert.ok(q.startsWith("(name contains 'O\\'Neil\\'s' or fullText contains 'O\\'Neil\\'s') and"), q)
  // the words never close the quote: every quote in q is either escaped or one of ours around a word
  assert.equal(q.replace(/\\'/g, '').split("'").length - 1, 4 * 2)
})

test('DS-05 공유 드라이브 이름 · 상위 폴더 이름 · 개수 제한', async () => {
  const calls = stubFetch([
    [isList, () => Response.json({ incompleteSearch: true, files: [
      { id: 's1', name: '교육 과정 설계.pptx', mimeType: PPTX, driveId: 'D1', parents: ['P1'], size: '1234' },
      { id: 'm1', name: '교육 메모', mimeType: 'application/vnd.google-apps.document', owners: [{ displayName: '정하윤' }], parents: ['P2'] },
    ] })],
    [(u) => u.pathname === '/drive/v3/drives/D1', () => Response.json({ name: '가나정밀 공유 드라이브' })],
    [(u) => u.pathname === '/drive/v3/files/P1', () => Response.json({ name: '2026 교육' })],
    [(u) => u.pathname === '/drive/v3/files/P2', () => Response.json({ error: { message: 'not found' } }, { status: 404 })],
  ])
  const r = await G.driveSearch('u1', { query: '교육', max: 99 }, TOKEN)
  assert.equal(calls.find((c) => isList(c.url)).url.searchParams.get('pageSize'), String(Math.min(G.DRIVE_SEARCH.fetch, G.DRIVE_SEARCH.maxResults * 3)), 'max 는 30 까지')
  assert.equal(calls.find((c) => c.url.pathname === '/drive/v3/files/P1').url.searchParams.get('supportsAllDrives'), 'true')
  assert.equal(r.incomplete, true)
  assert.deepEqual(r.files[0], { id: 's1', name: '교육 과정 설계.pptx', mimeType: PPTX, modifiedTime: undefined, webViewLink: undefined, size: 1234, drive: '가나정밀 공유 드라이브', folder: '2026 교육', words_in_name: 1 })
  assert.equal(r.files[1].owner, '정하윤')
  assert.equal(r.files[1].folder, undefined, '못 찾은 폴더 이름은 빼고 결과는 그대로')
})

// a small deck made here: two slides, the second one listed first in the package
async function deck(slides) {
  const z = new JSZip()
  z.file('[Content_Types].xml', '<Types/>')
  slides.forEach((s, i) => z.file(`ppt/slides/slide${slides.length - i}.xml`, `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${slides[slides.length - 1 - i]}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`))
  return z.generateAsync({ type: 'nodebuffer' })
}

test('DS-06 슬라이드 파일(.pptx)을 내려받아 장 순서대로 글을 돌려준다 (공유 드라이브 파일도)', async () => {
  const buf = await deck(['가나정밀 교육 과정 — 1일차: 헌법(constitution) 쓰기', '2일차: 스펙 · 계획 · 점검'])
  const calls = stubFetch([
    [(u) => u.pathname === '/drive/v3/files/deck1' && !u.searchParams.has('alt'), () => Response.json({ id: 'deck1', name: '가나정밀 교육과정 제안서.pptx', mimeType: PPTX, size: String(buf.length), webViewLink: 'https://docs.google.com/presentation/d/deck1' })],
    [(u) => u.pathname === '/drive/v3/files/deck1' && u.searchParams.get('alt') === 'media', () => new Response(buf, { headers: { 'content-type': PPTX } })],
  ])
  const r = await G.driveRead('u1', { fileId: 'deck1' }, TOKEN)
  assert.ok(calls.every((c) => c.url.searchParams.get('supportsAllDrives') === 'true'), '메타 · 내려받기 모두 supportsAllDrives')
  assert.equal(r.name, '가나정밀 교육과정 제안서.pptx')
  assert.equal(r.pages, 2)
  assert.match(r.text, /1일차: 헌법\(constitution\) 쓰기/)
  assert.ok(r.text.indexOf('1일차') < r.text.indexOf('2일차'), '장 순서대로')
  assert.equal(r.too_big, undefined)
  assert.notEqual(r.text, '(binary file)')
})

test('DS-07 너무 큰 파일은 내려받지 않고, 크기를 모를 때는 받다가 멈춘다 · 글이 없으면 그렇게 말한다', async () => {
  const big = stubFetch([[(u) => !u.searchParams.has('alt'), () => Response.json({ id: 'x', name: '큰 발표.pptx', mimeType: PPTX, size: String(G.DRIVE_READ.maxBytes + 1), webViewLink: 'https://drive.google.com/file/d/x' })]])
  const r1 = await G.driveRead('u1', { fileId: 'x' }, TOKEN)
  assert.equal(r1.too_big, true)
  assert.match(r1.note, /너무 커서|too large/)
  assert.ok(!big.some((c) => c.url.searchParams.get('alt') === 'media'), '내려받지 않음')

  const cap = G.DRIVE_READ.maxBytes
  G.DRIVE_READ.maxBytes = 1000
  try {
    stubFetch([
      [(u) => !u.searchParams.has('alt'), () => Response.json({ id: 'y', name: '크기 모름.pdf', mimeType: 'application/pdf' })],
      [(u) => u.searchParams.get('alt') === 'media', () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(400)) } }))],
    ])
    const r2 = await G.driveRead('u1', { fileId: 'y' }, TOKEN)
    assert.equal(r2.too_big, true, '끝없이 오는 본문도 한도에서 멈춘다')
  } finally { G.DRIVE_READ.maxBytes = cap }

  const empty = await deck([''])
  stubFetch([
    [(u) => !u.searchParams.has('alt'), () => Response.json({ id: 'z', name: '그림만.pptx', mimeType: PPTX, size: String(empty.length) })],
    [(u) => u.searchParams.get('alt') === 'media', () => new Response(empty)],
  ])
  const r3 = await G.driveRead('u1', { fileId: 'z' }, TOKEN)
  assert.equal(r3.no_text, true)
  assert.match(r3.note, /글을 찾지 못했어요|No text/)

  stubFetch([[(u) => !u.searchParams.has('alt'), () => Response.json({ id: 'i', name: '사진.png', mimeType: 'image/png', size: '10' })]])
  const r4 = await G.driveRead('u1', { fileId: 'i' }, TOKEN)
  assert.equal(r4.no_text, true)
  assert.match(r4.note, /image\/png/)
})

test('DS-08 Google 슬라이드는 글로 내보내고, 바로 가기는 원본을 읽고, 긴 글은 잘렸다고 말한다', async () => {
  const calls = stubFetch([
    [(u) => u.pathname === '/drive/v3/files/sc', () => Response.json({ id: 'sc', name: '바로 가기', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'gs', targetMimeType: 'application/vnd.google-apps.presentation' } })],
    [(u) => u.pathname === '/drive/v3/files/gs', () => Response.json({ id: 'gs', name: '가나정밀 교육', mimeType: 'application/vnd.google-apps.presentation' })],
    [(u) => u.pathname === '/drive/v3/files/gs/export', () => new Response('가'.repeat(G.DRIVE_READ.maxChars + 5), { headers: { 'content-type': 'text/plain' } })],
  ])
  const r = await G.driveRead('u1', { fileId: 'sc' }, TOKEN)
  assert.equal(calls.find((c) => c.url.pathname.endsWith('/export')).url.searchParams.get('mimeType'), 'text/plain')
  assert.equal(r.id, 'gs')
  assert.equal(r.text.length, G.DRIVE_READ.maxChars)
  assert.equal(r.truncated, true)
  assert.equal(r.chars, G.DRIVE_READ.maxChars + 5)
  // a refusal from Drive keeps its message
  stubFetch([
    [(u) => !u.pathname.endsWith('/export'), () => Response.json({ id: 'gd', name: '큰 문서', mimeType: 'application/vnd.google-apps.document' })],
    [(u) => u.pathname.endsWith('/export'), () => Response.json({ error: { message: 'This file is too large to be exported.' } }, { status: 403 })],
  ])
  await assert.rejects(G.driveRead('u1', { fileId: 'gd' }, TOKEN), /Drive 403: This file is too large to be exported/)
})
