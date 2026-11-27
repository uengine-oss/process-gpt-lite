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
import { saveKindOf, saveKeyOf } from '../../src/officeAutosave.js'

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
})

// a stand-in for an editor control
const el = ({ cls = [], aria = null, title = null, tip = null, text = '' } = {}) => ({
  classList: { contains: (c) => cls.includes(c) },
  getAttribute: (n) => ({ 'aria-label': aria, title, 'data-tip': tip })[n] ?? null,
  textContent: text,
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
  if (keys.length) await admin.storage.from('files').remove([...new Set(keys)]).catch(() => {})
  await q('delete from pro_messages where thread_id = any($1::uuid[])', [threads])
  await q('delete from pro_threads where id = any($1::uuid[])', [threads])
  await pool.end()
})

test('다른 이름으로 저장: 편집기가 막 저장한 사본이 같은 방 · 같은 대화의 새 카드가 되고, 원래 카드는 그대로', { skip: !store && '로컬 Supabase 없음' }, async () => {
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
  assert.equal(m.content.name, '김서연 회신.txt')
  assert.equal(m.content.ext, 'txt')
  assert.deepEqual(m.content.savedAs, { from: c.id, name: '답장초안_김서연.txt' })
  assert.deepEqual(m.content.context, { conversationId: 'cs-conv-1', action: 'aside' })
  // its own copy beside the original (not the editor's copy, which the editor may write again)
  assert.notEqual(m.content.url, edited)
  assert.ok(m.content.url.startsWith(url(`${dir}/`)))
  assert.match(await read(m.content.url), /장소: 본사 3층/)
  // the card I saved from stays as it was
  const [still] = await q('select content from pro_messages where id=$1', [c.id])
  assert.equal(still.content.url, orig)
  assert.doesNotMatch(await read(orig), /장소/)
  // a conversation that is not mine is not taken
  const m2 = await C.saveCardAs(me, c.id, { url: edited, name: '김서연 회신 2.txt', conversationId: 'someone-elses' })
  assert.equal(m2.content.context, undefined)
  // without an address: the card's own version
  const m3 = await C.saveCardAs(me, c.id, { name: '원본 사본' + '.txt' })
  assert.doesNotMatch(await read(m3.content.url), /장소/)
})

test('판 지키기: 카드가 이번 편집의 사본에 서 있으면 자기 사본으로 옮겨 둔다(편집기가 그 사본에 새 이름의 내용을 쓰기 전)', { skip: !store && '로컬 Supabase 없음' }, async () => {
  const dir = `pgpt-pro/${me.id}/att`
  const id = crypto.randomUUID()
  const orig = await put(`${dir}/${id}.txt`, '처음 판\n')
  const session = await put(`${dir}/edited-${id}_20261127104500.txt`, '처음 판\n저장한 고침\n')
  const tid = await room(me)
  const c = await card(tid, { name: '회의 메모.txt', url: session, versions: [orig] })
  const kept = await C.keepVersion(me, c.id)
  assert.notEqual(kept.content.url, session)
  assert.ok(kept.content.url.startsWith(url(`${dir}/`)))
  assert.deepEqual(kept.content.versions, [orig])
  // the editor writes the new name's content into its copy now
  await put(`${dir}/edited-${id}_20261127104500.txt`, '처음 판\n저장한 고침\n새 이름으로만 간 고침\n')
  const m = await C.saveCardAs(me, c.id, { url: session, name: '회의 메모 정리.txt' })
  assert.match(await read(m.content.url), /새 이름으로만 간 고침/)
  // the card keeps the version it was last saved as
  assert.equal(await read(kept.content.url), '처음 판\n저장한 고침\n')
})

test('거절: 다른 형식의 이름 · 카드 옆이 아닌 사본 · 남의 카드 · 폴더 · 비공개 카드', { skip: !store && '로컬 Supabase 없음' }, async () => {
  const dir = `pgpt-pro/${me.id}/att`
  const id = crypto.randomUUID()
  const orig = await put(`${dir}/${id}.txt`, '본문\n')
  const elsewhere = await put(`pgpt-pro/${other.id}/att/${crypto.randomUUID()}.txt`, '남의 것\n')
  const tid = await room(me)
  const c = await card(tid, { name: '메모.txt', url: orig })
  await assert.rejects(C.saveCardAs(me, c.id, { name: '메모.docx' }), (e) => e.status === 400 && /같은 형식\(\.txt\)/.test(e.message))
  await assert.rejects(C.saveCardAs(me, c.id, { name: '' }), (e) => e.status === 400)
  await assert.rejects(C.saveCardAs(me, c.id, { url: elsewhere, name: '메모2.txt' }), (e) => e.status === 400)
  await assert.rejects(C.saveCardAs(other, c.id, { name: '메모2.txt' }), (e) => e.status === 404)
  await assert.rejects(C.keepVersion(other, c.id), (e) => e.status === 404)
  const f = await card(tid, { name: '보고서.txt', url: orig, folder: { slug: 'f-1', path: '보고서.txt', sha: 'x', editable: true } })
  await assert.rejects(C.saveCardAs(me, f.id, { name: '보고서 2.txt' }), (e) => e.status === 400)
  const p = await card(tid, { name: '첨부.txt', private: { key: 'k' } })
  await assert.rejects(C.saveCardAs(me, p.id, { name: '첨부 2.txt' }), (e) => e.status === 400)
  await assert.rejects(C.keepVersion(me, p.id), (e) => e.status === 400)
  const b = await card(tid, { name: '받은.txt', url: orig, branch: 'share/x' })
  await assert.rejects(C.saveCardAs(me, b.id, { name: '받은 2.txt' }), (e) => e.status === 400)
})
