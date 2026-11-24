// 대화방에서 문서를 누르면 반응이 없던 것(2026-11-24 「대화방에서 문서 클릭시 반응없음 (이음오피스 열려야)」): 파일 카드를 어떻게
// 여는지 — src/openPlan.js. 문서는 앱 안의 문서 패널(이음오피스 · ArtCraft)로, 볼 수 없는 형식은 이유와 링크로, 아무 말 없이 끝나지 않는다.
// 띄워 둔 메신저만 문서가 열리면 비켜 주고, 붙여 둔 메신저는 그 옆에 남는다. 화면 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { openPlan, closesMessenger, isDrive } from '../../src/openPlan.js'
import { officeEditorFor } from '../../src/editorKinds.js'

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

test('앱 안에서 볼 수 없는 파일: 이유와 링크 — 그림 앱이 없는 설치의 그림도', () => {
  const zip = openPlan({ name: '자료 묶음.zip', url: `${S}x.zip` })
  assert.equal(zip.how, 'link')
  assert.equal(zip.url, `${S}x.zip`)
  assert.match(zip.reason, /앱 안에서 열 수 없는 형식/)
  const png = { name: '도면.png', url: `${S}y.png` }
  assert.equal(openPlan(png).how, 'office', 'PhotoCraft 가 있으면 앱 안에서')
  const noCraft = openPlan(png, { craftMissing: (ed) => ed === 'photocraft' })
  assert.equal(noCraft.how, 'link')
  assert.match(noCraft.reason, /PhotoCraft/)
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
  assert.equal(closesMessenger({ how: 'none' }, 'float'), false)
})
