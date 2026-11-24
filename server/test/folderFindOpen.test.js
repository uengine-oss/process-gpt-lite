// Finding and opening a shared folder's file from the chat (2026-11-23 사진: 「장진영 이력서를 열어줘」 →
// "찾지 못했습니다" until the 이력서 folder was attached, then "DOCX 는 바이너리라 열 수 없음").
//   - the folder search looks for each word on its own (장진영 in the file name, 이력서 in the folder name)
//   - nothing named: every folder the user may use, for the agent to judge
//   - documents are read with jszip (the server image has no unzip)
//   - folder_open hands back {file_url, file_name, open: true}: a file card that opens on the screen
// Run: node --test test/folderFindOpen.test.js  (the DB part needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import JSZip from 'jszip'
import { words, extract } from '../lib/folders/indexer.js'
import { documentFrom } from '../lib/office.js'

const docx = async (text) => {
  const z = new JSZip()
  z.file('[Content_Types].xml', '<Types/>')
  z.file('word/document.xml', `<w:document><w:body>${text.split('\n').map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)
  return z.generateAsync({ type: 'nodebuffer' })
}

test('검색 낱말: 띄어 쓴 낱말마다 따로, 한 글자는 더 긴 낱말이 없을 때만', () => {
  assert.deepEqual(words('장진영 이력서'), ['장진영', '이력서'])
  assert.deepEqual(words('장 이력서'), ['이력서'])
  assert.deepEqual(words('  계약서,  견적서 / 2026 '), ['계약서', '견적서', '2026'])
  assert.deepEqual(words('a'), ['a'])
  assert.deepEqual(words(''), [])
})

test('문서 본문: docx · pptx · hwpx · xlsx 를 unzip 없이 읽는다', async () => {
  const d = await extract('장진영_프로필.docx', await docx('장진영\n경력: 유엔진 솔루션즈 대표'))
  assert.match(d.text, /장진영/)
  assert.match(d.text, /유엔진 솔루션즈 대표/)
  const p = new JSZip()
  p.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:t>둘째 장</a:t></a:p></p:sld>')
  p.file('ppt/slides/slide10.xml', '<p:sld><a:p><a:t>열째 장</a:t></a:p></p:sld>')
  p.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:t>첫 장</a:t></a:p></p:sld>')
  const pp = await extract('발표.pptx', await p.generateAsync({ type: 'nodebuffer' }))
  assert.equal(pp.pages, 3)
  assert.ok(pp.text.indexOf('첫 장') < pp.text.indexOf('둘째 장') && pp.text.indexOf('둘째 장') < pp.text.indexOf('열째 장'), '장 순서대로')
  const h = new JSZip()
  h.file('Contents/section0.xml', '<hs:sec><hp:p><hp:t>한글 문서 본문</hp:t></hp:p></hs:sec>')
  assert.match((await extract('안내.hwpx', await h.generateAsync({ type: 'nodebuffer' }))).text, /한글 문서 본문/)
  const x = new JSZip()
  x.file('xl/sharedStrings.xml', '<sst><si><t>품목</t></si><si><t>단가</t></si></sst>')
  assert.match((await extract('견적.xlsx', await x.generateAsync({ type: 'nodebuffer' }))).text, /품목\s+단가/)
  // a broken package is no text, not an error
  assert.equal((await extract('깨짐.docx', Buffer.from('not a zip'))).text, '')
  // a small file that unpacks too far is not unpacked (its part is past the limit)
  const bomb = new JSZip()
  bomb.file('word/document.xml', '<w:p>' + ' '.repeat(33 * 1024 * 1024) + '</w:p>')
  const small = await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  assert.ok(small.length < 1024 * 1024, `${small.length}`)
  assert.equal((await extract('큰.docx', small)).text, '')
})

test('folder_open 의 결과는 파일 카드가 되고 open 을 가진다 · 다른 도구의 결과는 그대로', () => {
  const doc = documentFrom({ file_url: 'http://x/files/abc.docx', file_name: '장진영_프로필.docx', open: true, folder: '이력서' })
  assert.deepEqual(doc, { name: '장진영_프로필.docx', url: 'http://x/files/abc.docx', ext: 'docx', open: true })
  assert.equal(documentFrom({ file_url: 'http://x/files/abc.docx', file_name: '보고서.docx' }).open, undefined)
  assert.equal(documentFrom(JSON.stringify({ file_url: 'http://x/a.docx', file_name: 'a.docx', open: 'yes' })).open, undefined)
})

// ---------- on the local database: a folder 이력서 with 장진영_프로필.docx ----------
const { q, pool, admin } = await import('../lib/supa.js')
const db = await q('select 1 from pro_folder_files limit 1').then(() => true).catch(() => false)
const made = []
after(async () => {
  for (const f of made) {
    const keys = (await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/folders/${f.id}/`]).catch(() => [])).map((r) => r.name)
    if (keys.length) await admin.storage.from('files').remove(keys).catch(() => {})
    await q('delete from pro_folders where id=$1', [f.id]).catch(() => {})
    await fs.rm(f.repo_path, { recursive: true, force: true }).catch(() => {})
  }
  await pool.end()
})

test('붙이지 않아도 찾고, 읽고, 연다 (이력서 폴더의 장진영_프로필.docx)', { skip: !db }, async () => {
  const S = await import('../lib/folders/service.js')
  const { reindex } = await import('../lib/folders/indexer.js')
  const { callTool } = await import('../mcp/folders.js')
  const stamp = Date.now()
  const user = { id: (await q('select gen_random_uuid()::text as id'))[0].id, name: '폴더 찾기 시험', email: `ffo-${stamp}@pgpt.test` }
  const cv = await S.createFolder(user, { name: `이력서 ${stamp}` })
  const hr = await S.createFolder(user, { name: `인사 자료 ${stamp}` })
  made.push(cv, hr)
  await S.upload(cv, user, '장진영_프로필.docx', await docx('장진영\n경력: 유엔진 솔루션즈 대표'))
  await S.upload(cv, user, '김민수_프로필.docx', await docx('김민수\n경력: 개발자'))
  await S.upload(hr, user, '휴가 규정.md', Buffer.from('# 휴가 규정\n연차는 15일\n'))
  await reindex(cv, { cards: false })
  await reindex(hr, { cards: false })
  const out = (r) => JSON.parse(r.content[0].text)

  // the words found apart: the folder 이력서 first, 장진영 (two words) above 김민수 (one)
  const cat = out(await callTool(user, 'folder_catalog', { query: `장진영 이력서 ${stamp}` })).filter((f) => f.slug === cv.slug || f.slug === hr.slug)
  assert.equal(cat[0].slug, cv.slug)
  assert.equal(cat[0].files[0].path, '장진영_프로필.docx')
  assert.ok(cat[0].files[0].matched > cat[0].files[1].matched, JSON.stringify(cat[0].files))

  // words nothing holds: every folder, for the agent to choose from (이력서 may be named 프로필)
  const none = out(await callTool(user, 'folder_catalog', { query: `resume-${stamp}` }))
  assert.match(none.note, /전체/)
  assert.ok(none.folders.some((f) => f.slug === cv.slug && f.files.some((x) => x.path === '장진영_프로필.docx')))

  // read: the document's text, not "binary"
  const read = out(await callTool(user, 'folder_read', { folder: cv.name, path: '장진영_프로필.docx' }))
  assert.equal(read.binary, false)
  assert.match(read.text, /유엔진 솔루션즈 대표/)

  // open: a storage copy the editor loads, marked to open on the screen
  const open = out(await callTool(user, 'folder_open', { folder: cv.name, path: '장진영_프로필.docx' }))
  assert.equal(open.file_name, '장진영_프로필.docx')
  assert.equal(open.open, true)
  assert.match(open.file_url, new RegExp(`/storage/v1/object/public/files/pgpt-pro/folders/${cv.id}/[0-9a-f]{40}\\.docx$`))
  const got = await fetch(open.file_url)
  assert.equal(got.status, 200)
  assert.match((await extract('x.docx', Buffer.from(await got.arrayBuffer()))).text, /장진영/)
  const doc = documentFrom(open)
  assert.equal(doc.open, true)
  assert.equal(doc.name, '장진영_프로필.docx')
  // the same version again: the same copy (content-addressed)
  assert.equal(out(await callTool(user, 'folder_open', { folder: cv.slug, path: '장진영_프로필.docx' })).file_url, open.file_url)

  // a folder that matches by its name keeps all its files (the ones that matched first)
  const byName = out(await callTool(user, 'folder_catalog', { query: `이력서 ${stamp}` })).find((f) => f.slug === cv.slug)
  assert.deepEqual(byName.files.map((x) => x.path).sort(), ['김민수_프로필.docx', '장진영_프로필.docx'])

  // a name two folders hold (not a slug, not a whole name): none is picked, both are shown
  const cv2 = await S.createFolder(user, { name: `이력서 보관 ${stamp}` })
  made.push(cv2)
  const twice = JSON.parse((await callTool(user, 'folder_open', { folder: '이력서', path: '장진영_프로필.docx' })).content[0].text)
  assert.match(twice.error, /여럿/)
  assert.deepEqual(twice.folders.map((x) => x.slug).sort(), [cv.slug, cv2.slug].sort())

  // only folders the user is a member of
  const other = { id: (await q('select gen_random_uuid()::text as id'))[0].id, name: '다른 사람', email: `ffo2-${stamp}@pgpt.test` }
  assert.match((await callTool(other, 'folder_open', { folder: cv.name, path: '장진영_프로필.docx' })).content[0].text, /찾지 못했어요/)
})

test('예전 이미지가 읽지 못한 문서는 시작할 때 카드를 다시 만든다', { skip: !db }, async () => {
  const S = await import('../lib/folders/service.js')
  const { reindex, retryUnreadCards } = await import('../lib/folders/indexer.js')
  const stamp = Date.now()
  const user = { id: (await q('select gen_random_uuid()::text as id'))[0].id, name: '카드 다시', email: `ffo3-${stamp}@pgpt.test` }
  const f = await S.createFolder(user, { name: `카드 다시 ${stamp}` })
  made.push(f)
  await S.upload(f, user, '장진영_프로필.docx', await docx('장진영\n경력: 유엔진 솔루션즈 대표'))
  await reindex(f, { cards: false })
  // what production holds: tried once, "couldn't read", not tried again while the file is the same
  await q(`update pro_folder_files set card=null, card_sha=sha, card_error='본문을 읽지 못했어요' where folder_id=$1`, [f.id])
  assert.ok(await retryUnreadCards() >= 1)
  // read again now (the card itself needs the model: made, or the model's own error — not "couldn't read")
  let row
  for (let i = 0; i < 60; i++) {
    ;[row] = await q('select card, card_sha, sha, card_error from pro_folder_files where folder_id=$1', [f.id])
    if (row.card_sha === row.sha) break
    await new Promise((r) => setTimeout(r, 500))
  }
  assert.equal(row.card_sha, row.sha)
  assert.notEqual(row.card_error, '본문을 읽지 못했어요', JSON.stringify(row))
})

// 2026-11-24 운영: 「장진영 이력서를 열어줘」에 folder_open 이 불렸는데 카드가 오지 않았다. deepagents 는 도구 결과를
// 파이썬 str() 로 흘려보내(줄바꿈이 \n 글자로) 들여 쓴 JSON 을 읽지 못했다. deepagents 가 실제로 보내는 두 모양 그대로.
test('deepagents 가 흘려보내는 도구 결과(파이썬 str, 줄바꿈이 \\n 글자)에서도 folder_open 카드를 읽는다', () => {
  const o = { file_url: 'https://x.supabase.co/storage/v1/object/public/files/pgpt-pro/folders/f/abc.docx', file_name: '장진영_프로필.docx', open: true,
    folder: '이력서', path: '장진영_프로필.docx', folder_ref: { slug: 'folder-x', name: '이력서', path: '장진영_프로필.docx', sha: 'abc', editable: true } }
  const pretty = JSON.stringify(o, null, 1).replace(/\n/g, '\\n') // Python's repr of the line breaks
  for (const s of [`content='${pretty}' name='folder_open' tool_call_id='call_1'`,
    `content=[{'type': 'text', 'text': '${pretty}'}] name='folder_open' tool_call_id='call_1'`,
    `content='${JSON.stringify(o)}' name='folder_open' tool_call_id='call_1'`]) {
    const doc = documentFrom(s)
    assert.ok(doc, s.slice(0, 60))
    assert.deepEqual([doc.name, doc.open, doc.folder.slug, doc.folder.editable], ['장진영_프로필.docx', true, 'folder-x', true])
  }
  // a value that itself holds an escaped quote or line break survives the reading back
  const tricky = { file_url: 'https://x/files/a.docx', file_name: 'a.docx', note: 'say "hi"\nthen' }
  const repr = `content='${JSON.stringify(tricky, null, 1).replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}'`
  assert.equal(documentFrom(repr)?.url, 'https://x/files/a.docx')
})
