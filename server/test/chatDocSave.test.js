// 채팅의 문서를 이음오피스에서 고쳐 저장하기 (2026-11-27 운영 녹화: 채팅이 만든 TXT 를 고치고 💾 를 눌렀더니 편집기 상태 줄이 「저장 중…」에서
// 멈췄고, 「다른 이름으로 저장…」은 아무 일도 하지 않았다). 스펙 openspec/specs/folder-edit-save 「채팅의 문서」.
//   - 막대의 저장 표시(src/officeSave.js saveBadge): 저장 안 됨 · 저장하는 중… · 저장했어요 · 시각 · 저장하지 못했어요 · 다시 시도 · 연결 끊김
//   - 「다른 이름으로 저장」의 이름: 형식(확장자)은 그대로, 경로 기호는 빠짐
//   - 편집기의 저장 · 다른 이름으로 저장 단추와 단축키를 알아보기(src/officeAutosave.js saveKindOf · saveKeyOf)
//   - 서버(lib/cardCopies.js, 실제 DB · 저장소): 새 이름의 카드는 같은 방 · 같은 대화, 원래 카드는 그대로; 판 지키기; 거절(다른 형식 · 다른 자리 · 폴더 · 비공개)
// 사람 · 내용은 지어낸 것이다(정하윤 · 김서연).
// Run: node --test test/chatDocSave.test.js   (서버 부분은 로컬 Supabase 가 있어야 함, 없으면 건너뜀)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { saveBadge, saveAsName, saveAsSuggestion, hhmm, KEEPALIVE_MS, SAVE_WAIT_MS } from '../../src/officeSave.js'
import { saveKindOf, saveKeyOf, editorClean, saveAsHideCss, EDITOR_CHROME } from '../../src/officeAutosave.js'

test('막대의 저장 표시: 고친 뒤 · 저장 중 · 저장함(시각) · 실패(까닭 · 다시 시도) · 연결 끊김', () => {
  assert.equal(saveBadge({ kind: 'idle' }), null)
  assert.deepEqual(saveBadge({ kind: 'idle' }, { edited: true }).text, '저장 안 됨')
  const saving = saveBadge({ kind: 'saving' }, { edited: true })
  assert.equal(saving.kind, 'saving')
  assert.equal(saving.text, '저장하는 중…')
  assert.equal(saving.action, null)
  const at = new Date(2026, 10, 27, 10, 42, 5).getTime()
  const saved = saveBadge({ kind: 'saved', at, where: '채팅의 파일 카드에서 이 버전이 열려요' })
  assert.equal(saved.text, '저장했어요 · 10:42')
  assert.equal(saved.short, '저장됨 10:42')
  assert.match(saved.title, /채팅의 파일 카드/)
  // a new edit after the save: not saved again yet
  assert.equal(saveBadge({ kind: 'saved', at }, { edited: true }).kind, 'edited')
  const failed = saveBadge({ kind: 'failed', why: '편집기가 30초 안에 저장을 마치지 못했어요' }, { edited: true })
  assert.equal(failed.kind, 'failed')
  assert.equal(failed.text, '저장하지 못했어요 · 다시 시도')
  assert.equal(failed.action, 'retry')
  assert.match(failed.title, /30초 안에/)
  // the editor's connection closed: whatever the state, saving cannot work — 다시 열기
  const gone = saveBadge({ kind: 'saving' }, { edited: true, gone: true })
  assert.equal(gone.kind, 'gone')
  assert.equal(gone.action, 'reopen')
  assert.equal(hhmm(new Date(2026, 0, 2, 7, 5)), '07:05')
  assert.equal(hhmm('nonsense'), '')
  // the connection is kept busy well inside Cloudflare's 100 s, and a save never waits for good
  assert.ok(KEEPALIVE_MS < 100_000)
  assert.ok(SAVE_WAIT_MS > 0 && SAVE_WAIT_MS <= 60_000)
})

test('「다른 이름으로 저장」의 이름: 형식은 그대로, 경로 기호 없이', () => {
  const orig = '답장초안_정하윤_김서연.txt'
  assert.equal(saveAsSuggestion(orig), '답장초안_정하윤_김서연 사본.txt')
  assert.equal(saveAsSuggestion(orig, { english: true }), '답장초안_정하윤_김서연 copy.txt')
  assert.equal(saveAsName('김서연 회신', orig), '김서연 회신.txt')
  assert.equal(saveAsName('김서연 회신.txt', orig), '김서연 회신.txt')
  assert.equal(saveAsName('김서연 회신.TXT', orig), '김서연 회신.txt')
  // another format is not this editor's: the document's own extension goes on
  assert.equal(saveAsName('김서연 회신.md', orig), '김서연 회신.md.txt')
  assert.equal(saveAsName('../../etc/passwd', orig), 'etc passwd.txt')
  assert.equal(saveAsName('  ', orig), null)
  assert.equal(saveAsName('.txt', orig), null)
  assert.equal(saveAsName('a'.repeat(300), orig).length, 124)
  // a name that reads other than it is (direction controls) loses them
  assert.equal(saveAsName('김서연\u202e회신', orig), '김서연 회신.txt')
  assert.equal(saveAsName('\u2066김서연\u2069 회신', orig), '김서연 회신.txt')
})

// a stand-in for an editor control
const el = ({ cls = [], aria = null, title = null, tip = null, text = '', cmd = null, disabled = false } = {}) => ({
  classList: { contains: (c) => cls.includes(c) },
  getAttribute: (n) => ({ 'aria-label': aria, title, 'data-tip': tip, 'data-cmd': cmd })[n] ?? null,
  textContent: text,
  disabled,
})
test('편집기의 저장 · 다른 이름으로 저장을 알아본다(편집기 자신의 이름표로)', () => {
  assert.equal(saveKindOf(el({ cls: ['qa-btn'], aria: '저장 (⌘S)' })), 'save')
  assert.equal(saveKindOf(el({ cls: ['qa-btn'], aria: 'Save (Ctrl+S)' })), 'save')
  assert.equal(saveKindOf(el({ cls: ['qa-btn', 'qa-save-as'], aria: '다른 이름으로 저장…', text: '다른 이름으로 저장…' })), 'saveAs')
  assert.equal(saveKindOf(el({ text: '다른 이름으로 저장…' })), 'saveAs')
  assert.equal(saveKindOf(el({ aria: 'Save As…' })), 'saveAs')
  // 저장 only by its name: a button whose words merely start with 저장 is something else
  assert.equal(saveKindOf(el({ text: '저장 위치 바꾸기' })), null)
  assert.equal(saveKindOf(el({ aria: '저장소' })), null)
  assert.equal(saveKindOf(el({ aria: '실행 취소' })), null)
  assert.equal(saveKindOf(null), null)
  // the 한글 editor's studio menu names its entries by command
  assert.equal(saveKindOf(el({ cmd: 'file:save', text: '저장' })), 'save')
  assert.equal(saveKindOf(el({ cmd: 'file:save-as', text: '다른 이름으로 저장(A)...' })), 'saveAs')
  assert.equal(saveKindOf(el({ cmd: 'file:save-as-hwpx', text: 'HWPX 형식으로 저장...' })), 'saveAs')
  assert.equal(saveKindOf(el({ cmd: 'file:print', text: '인쇄' })), null)
  // the editor's 저장 switched off says there is nothing to save; no such button says nothing
  const doc = (btn) => ({ querySelectorAll: () => (btn ? [btn] : []) })
  assert.equal(editorClean(doc(el({ cls: ['qa-btn'], aria: '저장 (⌘S)', disabled: true }))), true)
  assert.equal(editorClean(doc(el({ cls: ['qa-btn'], aria: '저장 (⌘S)' }))), false)
  assert.equal(editorClean(doc(null)), null)
  // hidden: never the other-format entries; 「다른 이름으로 저장」 too where the sheet does not take it
  assert.match(saveAsHideCss({ saveAs: true }), /file:save-as-hwpx/)
  assert.doesNotMatch(saveAsHideCss({ saveAs: true }), /qa-save-as|"file:save-as"\]/)
  assert.match(saveAsHideCss({ saveAs: false }), /\.qa-save-as/)
  assert.match(saveAsHideCss({ saveAs: false }), /data-cmd="file:save-as"\]/)
  // the editor's own controls are not edits — but the 한글 studio's style bar (font, size, style) changes the document
  assert.match(EDITOR_CHROME, /\.find-panel/)
  assert.doesNotMatch(EDITOR_CHROME, /style-bar/)
  const key = (o) => ({ code: 'KeyS', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, ...o })
  assert.equal(saveKeyOf(key({ metaKey: true })), 'save')
  assert.equal(saveKeyOf(key({ ctrlKey: true })), 'save')
  assert.equal(saveKeyOf(key({ metaKey: true, shiftKey: true })), 'saveAs')
  assert.equal(saveKeyOf(key({})), null)
  assert.equal(saveKeyOf(key({ metaKey: true, altKey: true })), null)
  assert.equal(saveKeyOf(key({ metaKey: true, repeat: true })), null)
  assert.equal(saveKeyOf(key({ metaKey: true, code: 'KeyP' })), null)
})

// ---------- server: lib/cardCopies.js against the local DB and storage ----------
process.env.PRO_BACKGROUND = '0'
const { q, pool, admin } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const C = await import('../lib/cardCopies.js')
const db = await q('select 1').then(() => true, () => false)
const store = db && (await admin.storage.from('files').list('pgpt-pro', { limit: 1 }).then((r) => !r.error, () => false))

const me = { id: crypto.randomUUID() }
const other = { id: crypto.randomUUID() }
const threads = []
const keys = []
const url = (k) => `${config.supabaseUrl}/storage/v1/object/public/files/${k}`
async function put(k, text) {
  const { error } = await admin.storage.from('files').upload(k, Buffer.from(text), { contentType: 'text/plain; charset=utf-8', upsert: true })
  if (error) throw error
  keys.push(k)
  return url(k)
}
const read = async (u) => (await fetch(u)).text()
async function room(user) {
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','채팅 문서 저장') returning id`, [user.id])
  threads.push(t.id)
  return t.id
}
const card = async (tid, content) => (await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2) returning *`, [tid, content]))[0]
after(async () => {
  if (!db) return
  const made = await q(`select content->>'url' as url from pro_messages where thread_id = any($1::uuid[])`, [threads])
  for (const m of made) { const k = /\/object\/public\/files\/(.+)$/.exec(m.url || '')?.[1]; if (k) keys.push(decodeURIComponent(k)) }
  for (const dir of [`pgpt-pro/${me.id}/copies`, `pgpt-pro/${other.id}/copies`]) {
    const l = await admin.storage.from('files').list(dir, { limit: 1000 }).catch(() => ({ data: [] }))
    for (const o of l.data || []) keys.push(`${dir}/${o.name}`)
  }
  if (keys.length) await admin.storage.from('files').remove([...new Set(keys)]).catch(() => {})
  await q('delete from pro_messages where thread_id = any($1::uuid[])', [threads])
  await q('delete from pro_threads where id = any($1::uuid[])', [threads])
  await pool.end()
})

const copiesOf = (user) => url(`pgpt-pro/${user.id}/copies/`)

test('다른 이름으로 저장: 편집기가 막 저장한 사본이 같은 방 · 같은 대화의 새 카드가 되고(내 자리의 사본), 원래 카드는 그대로', { skip: !store && '로컬 Supabase 없음' }, async () => {
  const dir = `pgpt-pro/${me.id}/att`
  const id = crypto.randomUUID()
  const orig = await put(`${dir}/${id}.txt`, '김서연 님께\n일정 확인했습니다.\n')
  const edited = await put(`${dir}/edited-${id}_20261127104200.txt`, '김서연 님께\n일정 확인했습니다.\n장소: 본사 3층\n')
  const tid = await room(me)
  // the conversation the card is in (a routed answer in my chat)
  await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2)`, [tid, { text: '초안을 만들었어요', context: { conversationId: 'cs-conv-1', action: 'new', title: '회신 초안' } }])
  const c = await card(tid, { name: '답장초안_김서연.txt', url: orig, type: 'text/plain' })
  const m = await C.saveCardAs(me, c.id, { url: edited, name: '김서연 회신.txt', conversationId: 'cs-conv-1' })
  assert.equal(m.thread_id, tid)
  assert.equal(m.kind, 'file')
  assert.equal(m.role, 'agent')
  assert.equal(m.content.name, '김서연 회신.txt')
  assert.equal(m.content.ext, 'txt')
  assert.deepEqual(m.content.savedAs, { from: c.id, name: '답장초안_김서연.txt' })
  assert.deepEqual(m.content.context, { conversationId: 'cs-conv-1', action: 'aside' })
  // a copy of its own under my prefix (not the editor's copy, which the editor may write again)
  assert.ok(m.content.url.startsWith(copiesOf(me)), m.content.url)
  assert.match(await read(m.content.url), /장소: 본사 3층/)
  // the card I saved from stays as it was
  const [still] = await q('select content from pro_messages where id=$1', [c.id])
  assert.equal(still.content.url, orig)
  assert.doesNotMatch(await read(orig), /장소/)
  // a conversation that is not mine is not taken
  const m2 = await C.saveCardAs(me, c.id, { url: edited, name: '김서연 회신 2.txt', conversationId: 'someone-elses' })
  assert.equal(m2.content.context, undefined)
  // without an address: the card's own version
  const m3 = await C.saveCardAs(me, c.id, { name: '원본 사본.txt' })
  assert.doesNotMatch(await read(m3.content.url), /장소/)
})

test('판 지키기: 카드가 이번 편집의 사본(edited-…)에 서 있으면 내 자리의 사본으로 옮겨 둔다(지킬 편집본이 없으면 거절)', { skip: !store && '로컬 Supabase 없음' }, async () => {
  const dir = `pgpt-pro/${me.id}/att`
  const id = crypto.randomUUID()
  const orig = await put(`${dir}/${id}.txt`, '처음 판\n')
  const session = await put(`${dir}/edited-${id}_20261127104500.txt`, '처음 판\n저장한 고침\n')
  const tid = await room(me)
  const c = await card(tid, { name: '회의 메모.txt', url: session, versions: [orig] })
  const kept = await C.keepVersion(me, c.id)
  assert.notEqual(kept.content.url, session)
  assert.ok(kept.content.url.startsWith(copiesOf(me)))
  assert.deepEqual(kept.content.versions, [orig])
  // the editor writes the new name's content into its copy now — still beside a version the card stood on
  await put(`${dir}/edited-${id}_20261127104500.txt`, '처음 판\n저장한 고침\n새 이름으로만 간 고침\n')
  const m = await C.saveCardAs(me, c.id, { url: session, name: '회의 메모 정리.txt' })
  assert.match(await read(m.content.url), /새 이름으로만 간 고침/)
  // the card keeps the version it was last saved as
  assert.equal(await read(kept.content.url), '처음 판\n저장한 고침\n')
  // nothing to keep: a card that stands on its own file (not the editor's copy of this opening)
  const plain = await card(tid, { name: '메모.txt', url: orig })
  await assert.rejects(C.keepVersion(me, plain.id), (e) => e.status === 400)
})

test('카드의 저장(POST /api/messages/:id/file)이 받는 주소: 카드 옆의 편집본(edited-…) 또는 내 파일만', { skip: !store && '로컬 Supabase 없음' }, async () => {
  const theirs = `pgpt-pro/${other.id}/att`
  const id = crypto.randomUUID()
  const c = { content: { name: '보고서.docx', url: url(`${theirs}/${id}.docx`), versions: [] } }
  assert.equal(C.savedCopyOk(me, c, url(`${theirs}/edited-${id}_20261127110000.docx`)), true)
  // beside it, but not the editor's copy: another file of that folder
  assert.equal(C.savedCopyOk(me, c, url(`${theirs}/${crypto.randomUUID()}.docx`)), false)
  // somewhere else, or not storage at all
  assert.equal(C.savedCopyOk(me, c, url(`pgpt-pro/${crypto.randomUUID()}/att/edited-x_20261127110000.docx`)), false)
  assert.equal(C.savedCopyOk(me, c, 'https://example.com/file.docx'), false)
  // a file of mine (an ArtCraft app's save goes up as my attachment)
  assert.equal(C.savedCopyOk(me, c, url(`pgpt-pro/${me.id}/att/${crypto.randomUUID()}.docx`)), true)
  assert.equal(C.savedCopyOk(me, c, url(`pgpt-pro/${me.id}/../${other.id}/att/x.docx`)), false)
  // the address the office host hands out for its own documents, when it is another one (PRO_SUPABASE_PUBLIC_URL): the same object
  const pub = 'https://files.example.test'
  const onPub = (k) => `${pub}/storage/v1/object/public/files/${k}`
  const agentDoc = { content: { name: '안내문.docx', url: onPub(`agent-docs/${id}.docx`), versions: [] } }
  assert.equal(C.savedCopyOk(me, agentDoc, onPub(`agent-docs/edited-${id}_20261127110000.docx`)), false)
  config.supabasePublicUrl = pub
  try {
    assert.equal(C.savedCopyOk(me, agentDoc, onPub(`agent-docs/edited-${id}_20261127110000.docx`)), true)
    assert.equal(C.savedCopyOk(me, agentDoc, onPub(`agent-docs/${crypto.randomUUID()}.docx`)), false)
    assert.equal(C.savedCopyOk(me, agentDoc, `https://elsewhere.example.test/storage/v1/object/public/files/agent-docs/edited-${id}_20261127110000.docx`), false)
  } finally { config.supabasePublicUrl = '' }
})

test('거절: 다른 형식의 이름 · 카드 옆이 아닌 사본 · 남의 카드 · 폴더 · 비공개 · 받은 공유 · 형식이 다른 원본', { skip: !store && '로컬 Supabase 없음' }, async () => {
  const dir = `pgpt-pro/${me.id}/att`
  const id = crypto.randomUUID()
  const orig = await put(`${dir}/${id}.txt`, '본문\n')
  const elsewhere = await put(`pgpt-pro/${other.id}/att/edited-${crypto.randomUUID()}_20261127110000.txt`, '남의 것\n')
  const notEdited = await put(`${dir}/${crypto.randomUUID()}.txt`, '다른 파일\n')
  const tid = await room(me)
  const c = await card(tid, { name: '메모.txt', url: orig })
  await assert.rejects(C.saveCardAs(me, c.id, { name: '메모.docx' }), (e) => e.status === 400 && /같은 형식\(\.txt\)/.test(e.message))
  await assert.rejects(C.saveCardAs(me, c.id, { name: '' }), (e) => e.status === 400)
  await assert.rejects(C.saveCardAs(me, c.id, { url: elsewhere, name: '메모2.txt' }), (e) => e.status === 400)
  // (a file of mine is mine to copy — a different one of the same format is still the person's own)
  const mine = await C.saveCardAs(me, c.id, { url: notEdited, name: '메모3.txt' })
  assert.ok(mine.content.url.startsWith(copiesOf(me)))
  await assert.rejects(C.saveCardAs(other, c.id, { name: '메모2.txt' }), (e) => e.status === 404)
  await assert.rejects(C.keepVersion(other, c.id), (e) => e.status === 404)
  const f = await card(tid, { name: '보고서.txt', url: orig, folder: { slug: 'f-1', path: '보고서.txt', sha: 'x', editable: true } })
  await assert.rejects(C.saveCardAs(me, f.id, { name: '보고서 2.txt' }), (e) => e.status === 400)
  const p = await card(tid, { name: '첨부.txt', private: { key: 'k' } })
  await assert.rejects(C.saveCardAs(me, p.id, { name: '첨부 2.txt' }), (e) => e.status === 400)
  await assert.rejects(C.keepVersion(me, p.id), (e) => e.status === 400)
  const b = await card(tid, { name: '받은.txt', url: orig, branch: 'share/x' })
  await assert.rejects(C.saveCardAs(me, b.id, { name: '받은 2.txt' }), (e) => e.status === 400)
  // the card says .txt but stands on a .docx: not copied as a .txt
  const docx = await put(`${dir}/${crypto.randomUUID()}.docx`, 'PK')
  const odd = await card(tid, { name: '이상한.txt', url: docx })
  await assert.rejects(C.saveCardAs(me, odd.id, { name: '이상한 2.txt' }), (e) => e.status === 400)
  // a name that reads other than it is
  assert.equal(C.copyName('메모\u202e.txt', '메모.txt'), '메모 .txt')
  assert.equal(C.copyName('메모.txt\u2066', '메모.txt'), '메모.txt')
})

test('판 지키기를 다시 불러도(다른 이름으로 저장의 다시 시도) 이미 자기 사본에 선 카드는 그대로', { skip: !store && '로컬 Supabase 없음' }, async () => {
  const dir = `pgpt-pro/${me.id}/att`
  const id = crypto.randomUUID()
  await put(`${dir}/${id}.txt`, '처음 판\n')
  const session = await put(`${dir}/edited-${id}_20261128010000.txt`, '처음 판\n저장한 고침\n')
  const tid = await room(me)
  const c = await card(tid, { name: '메모 다시.txt', url: session })
  const kept = await C.keepVersion(me, c.id)
  assert.ok(kept.content.url.startsWith(copiesOf(me)))
  const again = await C.keepVersion(me, c.id)
  assert.equal(again.content.url, kept.content.url)
})

test('아무것도 가리키지 않는 사본은 한 달 뒤 지운다 — 카드의 주소 · 이전 판이 가리키면 남긴다', { skip: !store && '로컬 Supabase 없음' }, async () => {
  const prefix = `pgpt-pro/${me.id}/copies/`
  const keyOf = (u) => decodeURIComponent(/\/object\/public\/files\/(.+)$/.exec(u)[1])
  const tid = await room(me)
  const onCard = await put(`${prefix}${crypto.randomUUID()}.txt`, '카드가 선 판\n')
  const inVersions = await put(`${prefix}${crypto.randomUUID()}.txt`, '이전 판\n')
  const orphan = await put(`${prefix}${crypto.randomUUID()}.txt`, '아무도 안 가리킴\n')
  const fresh = await put(`${prefix}${crypto.randomUUID()}.txt`, '아직 새것\n')
  await card(tid, { name: '정리 시험.txt', url: onCard, versions: [inVersions] })
  // a month and more ago — all but the fresh one
  await q(`update storage.objects set created_at = now() - interval '40 days' where bucket_id='files' and name = any($1::text[])`, [[onCard, inVersions, orphan].map(keyOf)])
  const unused = await C.unusedCopies({ prefix })
  assert.deepEqual(unused, [keyOf(orphan)])
  assert.equal(await C.cleanCopies({ prefix }), 1)
  assert.equal((await fetch(orphan)).status >= 400, true)
  assert.equal(await read(onCard), '카드가 선 판\n')
  assert.equal(await read(inVersions), '이전 판\n')
  assert.equal(await read(fresh), '아직 새것\n')
})
