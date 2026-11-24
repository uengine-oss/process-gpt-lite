// 대화방에서 문서를 누르면 반응이 없던 것(2026-11-24 「대화방에서 문서 클릭시 반응없음 (이음오피스 열려야)」): 파일 카드를 어떻게
// 여는지 — src/openPlan.js. 문서는 앱 안의 문서 패널(이음오피스 · ArtCraft)로, 볼 수 없는 형식은 이유와 링크로, 아무 말 없이 끝나지 않는다.
// 띄워 둔 메신저만 문서가 열리면 비켜 주고, 붙여 둔 메신저는 그 옆에 남는다. 화면 없이.
// 그리고 2026-11-25 「대화창안에서 기본적인 음성 / 이미지가 미리보기 등의 출력이 안되다니.. 포토크래프트등의 편집기는 편집의 의도가
// 있을따만 시도하는 것이고.」: 그림 · 소리 · 영상은 앱의 보기 화면에서 보고 듣는다(src/mediaKind.js). ArtCraft 편집기는 사람이 「… 로
// 편집」을 눌렀을 때만, 그 설치에 그 앱이 있을 때만.
import test from 'node:test'
import assert from 'node:assert/strict'
import { openPlan, closesMessenger, isDrive } from '../../src/openPlan.js'
import { officeEditorFor } from '../../src/editorKinds.js'
import { mediaKindOf } from '../../src/mediaKind.js'

const S = 'http://127.0.0.1:54321/storage/v1/object/public/files/pgpt-pro/u1/att/'

test('문서는 문서 패널에서: PDF · 워드 · 엑셀 · PPT · 한글 · 마크다운 (보낸 사람의 원본 · 받은 사람의 사본이 같은 길)', () => {
  for (const [name, editor] of [['한빛상사_제안서_v2.pdf', 'pdf'], ['계약서.docx', 'docs'], ['견적.xlsx', 'sheets'], ['소개.pptx', 'slides'], ['공문.hwpx', 'hwp'], ['회의록.md', 'markdown']]) {
    assert.deepEqual(openPlan({ name, url: `${S}${encodeURIComponent(name)}` }), { how: 'office', editor }, name)
  }
  // the name decides (the editor's address goes by it too); no name: the URL's, without its query
  assert.equal(openPlan({ url: `${S}a1b2.pdf?download=1` }).how, 'office')
  assert.equal(openPlan({ name: '제안서', url: `${S}a1b2.pdf` }).how, 'link')
  assert.equal(officeEditorFor('Moonlight Coffee Store #2 proposal.docx'), 'docs')
})

test('앱 안에서 볼 수 없는 파일: 이유와 링크 — 편집기 앱이 없는 설치의 PSD · 도면도', () => {
  const zip = openPlan({ name: '자료 묶음.zip', url: `${S}x.zip` })
  assert.equal(zip.how, 'link')
  assert.equal(zip.url, `${S}x.zip`)
  assert.match(zip.reason, /앱 안에서 열 수 없는 형식/)
  // a format the browser cannot show (PSD) still needs its app; without it, the reason names the app
  const psd = { name: '포스터.psd', url: `${S}y.psd` }
  assert.deepEqual(openPlan(psd), { how: 'office', editor: 'photocraft' })
  const noCraft = openPlan(psd, { craftMissing: (ed) => ed === 'photocraft' })
  assert.equal(noCraft.how, 'link')
  assert.match(noCraft.reason, /PhotoCraft/)
  // a drawing (DXF · DWG) has no picture of its own here: CADCraft opens it, as before
  assert.deepEqual(openPlan({ name: '평면도.dxf', url: `${S}z.dxf` }), { how: 'office', editor: 'cadcraft' })
  assert.match(openPlan({ name: '평면도.dwg', url: `${S}z.dwg` }, { craftMissing: () => true }).reason, /CADCraft/)
})

test('그림 · 소리 · 영상인지: 저장된 형식(MIME)이 있으면 그것으로, 없으면 확장자로', () => {
  for (const n of ['사진.png', 'a.JPG', 'b.jpeg', '움짤.gif', 'c.webp', '로고.svg', 'd.avif']) assert.equal(mediaKindOf({ name: n }), 'image', n)
  for (const n of ['download.m4a', 'e.mp3', 'f.wav', 'g.aac', 'h.ogg', 'i.opus', 'j.flac', 'k.oga']) assert.equal(mediaKindOf({ name: n }), 'audio', n)
  for (const n of ['영상 개요.mp4', 'l.mov', 'm.webm', 'n.m4v']) assert.equal(mediaKindOf({ name: n }), 'video', n)
  for (const n of ['제안서.pdf', '견적.xlsx', '포스터.psd', '평면도.dxf', '묶음.zip', 'README', '']) assert.equal(mediaKindOf({ name: n }), '', n)
  // the stored type wins: a site's 「download」 kept as audio/mp4, a picture named without an extension
  assert.equal(mediaKindOf({ name: 'download', type: 'audio/mp4' }), 'audio')
  assert.equal(mediaKindOf({ name: 'image', type: 'image/png' }), 'image')
  assert.equal(mediaKindOf({ name: 'clip', type: 'video/quicktime; codecs=avc1' }), 'video')
  assert.equal(mediaKindOf({ name: '사진.png', type: 'application/pdf' }), '', 'a type that says otherwise is believed')
  // a picture type a browser does not draw is not a picture to show
  assert.equal(mediaKindOf({ name: 'scan.tif', type: 'image/tiff' }), '')
  assert.equal(mediaKindOf({ name: 'p.psd', type: 'image/vnd.adobe.photoshop' }), '')
  // a type that says nothing: the name (or the address, when the name has no extension)
  assert.equal(mediaKindOf({ name: 'download.m4a', type: 'application/octet-stream' }), 'audio')
  assert.equal(mediaKindOf({ name: 'download', url: `${S}k1.m4a?x=1` }), 'audio')
  assert.equal(mediaKindOf(null), '')
})

test('그림 · 소리 · 영상은 보기 화면에서 — PhotoCraft · SoundCraft · FilmCraft 가 저절로 열리지 않는다', () => {
  // the two files of the recording: image.png (a PhotoCraft-less install) and download.m4a — no warning, a view
  const img = openPlan({ name: 'image.png', url: `${S}i.png` }, { craftMissing: () => true })
  assert.deepEqual(img, { how: 'view', media: 'image', url: `${S}i.png` })
  assert.equal(img.reason, undefined)
  const m4a = openPlan({ name: 'download.m4a', url: `${S}d.m4a`, type: 'audio/mp4' })
  assert.deepEqual(m4a, { how: 'view', media: 'audio', url: `${S}d.m4a` }, 'no editor for m4a: nothing to edit with')
  // with the app installed: still the viewer — the app is only named, for the person's 「… 로 편집」
  assert.deepEqual(openPlan({ name: '도면.png', url: `${S}y.png` }), { how: 'view', media: 'image', url: `${S}y.png`, editWith: 'photocraft' })
  assert.deepEqual(openPlan({ name: '알림음.wav', url: `${S}w.wav` }), { how: 'view', media: 'audio', url: `${S}w.wav`, editWith: 'soundcraft' })
  assert.deepEqual(openPlan({ name: '티저.mp4', url: `${S}t.mp4` }), { how: 'view', media: 'video', url: `${S}t.mp4`, editWith: 'filmcraft' })
  assert.deepEqual(openPlan({ name: '배너.svg', url: `${S}b.svg` }), { how: 'view', media: 'image', url: `${S}b.svg`, editWith: 'vectorcraft' })
  // each app named only where this install serves it
  const onlyPhoto = (ed) => ed !== 'photocraft'
  assert.equal(openPlan({ name: '도면.png', url: `${S}y.png` }, { craftMissing: onlyPhoto }).editWith, 'photocraft')
  assert.equal(openPlan({ name: '티저.mp4', url: `${S}t.mp4` }, { craftMissing: onlyPhoto }).editWith, undefined)
  assert.equal(openPlan({ name: '움짤.gif', url: `${S}g.gif` }).editWith, undefined, 'a GIF has no editor here')
})

test('「… 로 편집」(edit) 일 때만 ArtCraft 편집기 — 앱이 없으면 이유와 링크', () => {
  const png = { name: '도면.png', url: `${S}y.png` }
  assert.deepEqual(openPlan(png, { edit: true }), { how: 'office', editor: 'photocraft' })
  assert.deepEqual(openPlan({ name: '알림음.wav', url: `${S}w.wav` }, { edit: true }), { how: 'office', editor: 'soundcraft' })
  assert.deepEqual(openPlan({ name: '배너.svg', url: `${S}b.svg` }, { edit: true }), { how: 'office', editor: 'vectorcraft' })
  const missing = openPlan(png, { edit: true, craftMissing: () => true })
  assert.equal(missing.how, 'link')
  assert.match(missing.reason, /PhotoCraft/)
  // documents are the same either way
  assert.deepEqual(openPlan({ name: '계약서.docx', url: `${S}c.docx` }, { edit: true }), { how: 'office', editor: 'docs' })
  // a file the agent left loose is published first, then decided again (a picture: the viewer)
  assert.deepEqual(openPlan({ name: '사진.png', path: '/workspace/사진.png' }), { how: 'fetch' })
})

test('주소 없는 카드: 작업 공간 파일은 서버가 사본을 만든 뒤, 대화 작업실 파일은 그 작업실로, 아무것도 없으면 이유', () => {
  assert.deepEqual(openPlan({ name: '메모.txt', path: '/workspace/메모.txt' }), { how: 'fetch' })
  assert.deepEqual(openPlan({ name: 'plan.md', path: '/workspace/.bpmn/room-1/out/plan.md' }), { how: 'workroom', room: 'room-1', file: 'out/plan.md' })
  const none = openPlan({ name: '사라진.pdf' })
  assert.equal(none.how, 'none')
  assert.ok(none.reason)
  assert.equal(openPlan(null).how, 'none')
})

test('Google Drive · Docs 링크는 회사 연결로 받아 패널에서', () => {
  const u = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit'
  assert.equal(isDrive(u), true)
  assert.deepEqual(openPlan({ name: '제안서', url: u }), { how: 'drive' })
  assert.equal(isDrive('https://docs.google.com/document/u/0/'), false)
})

test('메신저는 떠 있을 때만, 그리고 문서가 열렸을 때만 비켜 준다', () => {
  const office = { how: 'office' }
  assert.equal(closesMessenger(office, 'float'), true)
  for (const d of ['right', 'left', 'panel']) assert.equal(closesMessenger(office, d), false, d)
  assert.equal(closesMessenger({ how: 'workroom' }, 'float'), true)
  assert.equal(closesMessenger({ how: 'drive' }, 'float'), true)
  // 열지 못한 파일은 이유가 메신저에 보여야 하니 그대로
  assert.equal(closesMessenger({ how: 'link' }, 'float'), false)
  // 그림 · 소리 · 영상의 보기 화면은 모든 것 위에 뜨고, 닫으면 그 대화로 돌아온다: 메신저는 그대로
  assert.equal(closesMessenger({ how: 'view', media: 'image' }, 'float'), false)
  assert.equal(closesMessenger({ how: 'none' }, 'float'), false)
})
