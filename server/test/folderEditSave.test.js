// An IeumOffice edit of a shared folder's file goes back into the folder (2026-11-24 휴대폰 녹화: 폴더의
// 장진영_프로필.docx 를 고쳤는데 닫으니 「그냥 바로 사라지고 있습니다」 · 「저장이 되어야죠」).
//   - only the editor's copy of this folder's file is taken (another storage object, another folder: refused)
//   - the copy becomes main's file with its author; one editing session is one 이력 entry (later saves fold in)
//   - main changed since the editor opened it: the edit is kept beside it as "… (이름 수정본)"
//   - folder_open's card carries the folder and the version, so the chat's editor saves back too
// Run: node --test test/folderEditSave.test.js  (the DB part needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import JSZip from 'jszip'
import { editingKey, saveButton } from '../../src/officeAutosave.js'
import { documentFrom } from '../lib/office.js'

const docx = async (text) => {
  const z = new JSZip()
  z.file('[Content_Types].xml', '<Types/>')
  z.file('word/document.xml', `<w:document><w:body>${text.split('\n').map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`)
  return z.generateAsync({ type: 'nodebuffer' })
}

test('편집으로 치는 키: 글자 · 지우기 · 줄바꿈 · 한글 입력(조합 중)은 편집, 이동 · 단축키는 아니다', () => {
  for (const k of ['a', '가', ' ', 'Backspace', 'Delete', 'Enter', 'Tab']) assert.equal(editingKey({ key: k }), true, k)
  assert.equal(editingKey({ key: 'Process', keyCode: 229 }), true)
  assert.equal(editingKey({ key: 'Unidentified', isComposing: true }), true)
  for (const k of ['ArrowLeft', 'End', 'PageDown', 'Shift', 'Escape', 'F1']) assert.equal(editingKey({ key: k }), false, k)
  assert.equal(editingKey({ key: 's', ctrlKey: true }), false)
  assert.equal(editingKey({ key: 'c', metaKey: true }), false)
  assert.equal(editingKey(null), false)
})

test('편집기의 저장 단추: 「저장 (⌘S)」 · 「Save」, 「다른 이름으로 저장」 · 「Save As」는 아니다', () => {
  const btn = (label) => ({ getAttribute: (a) => (a === 'aria-label' ? label : null), label })
  const doc = (labels) => ({ querySelectorAll: () => labels.map(btn) })
  assert.equal(saveButton(doc(['다른 이름으로 저장 (⇧⌘S)', '저장 (⌘S)', '실행 취소'])).label, '저장 (⌘S)')
  assert.equal(saveButton(doc(['저장(⌘S)'])).label, '저장(⌘S)')
  assert.equal(saveButton(doc(['Save As (Shift+Ctrl+S)', 'Save (Ctrl+S)'])).label, 'Save (Ctrl+S)')
  assert.equal(saveButton(doc(['실행 취소', '다시 실행'])), null)
  assert.equal(saveButton(null), null)
})

test('folder_open 의 카드는 폴더와 연 버전을 갖고 다닌다', () => {
  const d = documentFrom({ file_url: 'http://x/a.docx', file_name: 'a.docx', open: true, folder_ref: { slug: 'cv', name: '이력서', path: 'a.docx', sha: 'abc' } })
  assert.deepEqual(d.folder, { slug: 'cv', name: '이력서', path: 'a.docx', sha: 'abc' })
  assert.equal(documentFrom({ file_url: 'http://x/a.docx', file_name: 'a.docx', folder_ref: { slug: 1 } }).folder, undefined)
  assert.equal(documentFrom({ file_url: 'http://x/a.docx', file_name: 'a.docx' }).folder, undefined)
})

// ---------- on the local database and storage ----------
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

test('편집본이 폴더 main 의 파일이 된다: 한 편집은 이력 한 줄, 먼저 고친 사람이 있으면 수정본으로', { skip: !db }, async () => {
  const S = await import('../lib/folders/service.js')
  const G = await import('../lib/folders/git.js')
  const { extract } = await import('../lib/folders/indexer.js')
  const stamp = Date.now()
  const user = { id: (await q('select gen_random_uuid()::text as id'))[0].id, name: '편집 시험', email: `fes-${stamp}@pgpt.test` }
  const other = { id: (await q('select gen_random_uuid()::text as id'))[0].id, name: '다른 편집자', email: `fes2-${stamp}@pgpt.test` }
  const f = await S.createFolder(user, { name: `이력서 편집 ${stamp}` })
  made.push(f)
  await S.upload(f, user, '장진영_프로필.docx', await docx('장진영\n경력: 유엔진 솔루션즈 대표'))
  const opened = await S.publishFile(f, '장진영_프로필.docx')
  assert.match(opened.sha, /^[0-9a-f]{40}$/)
  // what the editor would save: a copy beside the published one (office-host editedObjectPath)
  const edited = async (text, n = 1) => {
    const key = `pgpt-pro/folders/${f.id}/edited-${opened.sha}_2026112400000${n}.docx`
    const { error } = await admin.storage.from('files').upload(key, Buffer.isBuffer(text) ? text : await docx(text), { upsert: true, contentType: 'application/octet-stream' })
    assert.ifError(error)
    return opened.url.replace(/[^/]+$/, key.split('/').pop())
  }
  const text = async (p) => (await extract('x.docx', await S.readBlob(f, 'main', p))).text
  const entries = async () => (await S.history(f)).filter((c) => c.msg.startsWith('이음오피스에서 고침'))

  // refused: another folder's object, an object that is not an editor's copy, a format IeumOffice does not save
  await assert.rejects(S.saveOfficeEdit(f, user, { path: '장진영_프로필.docx', base: opened.sha, url: opened.url.replace(f.id, '00000000-0000-4000-8000-000000000000').replace(/[^/]+$/, 'edited-x_1.docx'), session: 's1' }), /편집본/)
  await assert.rejects(S.saveOfficeEdit(f, user, { path: '장진영_프로필.docx', base: opened.sha, url: opened.url, session: 's1' }), /편집본/)
  await assert.rejects(S.saveOfficeEdit(f, user, { path: '안내.md', base: opened.sha, url: await edited('x'), session: 's1' }), /형식/)
  assert.equal(S.editedObject(f, 'not a url'), null)
  assert.equal(S.editedObject(f, `http://x/storage/v1/object/public/files/pgpt-pro/folders/${f.id}/sub/edited-a.docx`), null)

  // first save: a commit by the person, main's file is the edit
  const r1 = await S.saveOfficeEdit(f, user, { path: '장진영_프로필.docx', base: opened.sha, url: await edited('장진영\n첫 수정', 1), session: 's1' })
  assert.equal(r1.copied, false)
  assert.equal(r1.folded, false)
  assert.match(await text('장진영_프로필.docx'), /첫 수정/)
  const h1 = await S.history(f)
  assert.equal(h1[0].email, user.email)
  // the same session again: folded into its entry
  const second = await docx('장진영\n첫 수정\n둘째 수정')
  const r2 = await S.saveOfficeEdit(f, user, { path: '장진영_프로필.docx', base: r1.sha, url: await edited(second, 2), session: 's1' })
  assert.equal(r2.folded, true)
  assert.equal((await entries()).length, 1)
  assert.equal((await S.history(f)).length, h1.length)
  assert.match(await text('장진영_프로필.docx'), /둘째 수정/)
  // nothing changed: no commit
  const r3 = await S.saveOfficeEdit(f, user, { path: '장진영_프로필.docx', base: r2.sha, url: await edited(second, 3), session: 's1' })
  assert.equal(r3.commit, null)
  // another session: its own entry
  await S.saveOfficeEdit(f, user, { path: '장진영_프로필.docx', base: r2.sha, url: await edited('장진영\n셋째 수정', 4), session: 's2' })
  assert.equal((await entries()).length, 2)
  // a variation made from main: the next save does not fold into a commit something stands on
  const head = await G.head(f.repo_path, f.default_branch)
  await G.git(f.repo_path, ['branch', `var/test-${stamp}`, head])
  const r5 = await S.saveOfficeEdit(f, user, { path: '장진영_프로필.docx', base: (await S.publishFile(f, '장진영_프로필.docx')).sha, url: await edited('장진영\n넷째 수정', 5), session: 's2' })
  assert.equal(r5.folded, false)

  // someone else saved after this editor opened it: kept beside, theirs untouched
  await S.upload(f, other, '장진영_프로필.docx', await docx('장진영\n다른 사람이 먼저'))
  const r6 = await S.saveOfficeEdit(f, user, { path: '장진영_프로필.docx', base: r5.sha, url: await edited('장진영\n내 수정', 6), session: 's3' })
  assert.equal(r6.copied, true)
  assert.equal(r6.path, '장진영_프로필 (편집 시험 수정본).docx')
  assert.match(await text('장진영_프로필.docx'), /다른 사람이 먼저/)
  assert.match(await text(r6.path), /내 수정/)
  // the next copy of the same kind gets a number
  const r7 = await S.saveOfficeEdit(f, user, { path: '장진영_프로필.docx', base: r5.sha, url: await edited('장진영\n또 수정', 7), session: 's4' })
  assert.equal(r7.path, '장진영_프로필 (편집 시험 수정본 2).docx')
})
