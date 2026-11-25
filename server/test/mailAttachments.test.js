// 메일 첨부를 그 자리에서 열고 채팅으로 묻는다 — 모델 · DB · 저장소 없이 (2026-11-25 「메일 첨부를 곧바로 이음오피스 등의 도구로 열어보거나
// 채팅으로 해당 메일에 대한 질의/액션을 취할 수 있는 뭔가 흐름이 있어야」). 스펙 openspec/specs/mail-attachments.
//   - 보관 열쇠: 비공개 버킷 안, ASCII, 사람 · 카드 · 첨부 번호 · 내용 해시로 — 파일 이름은 열쇠에 없음, 남의 것 · 위로 올라가는 경로는 거절
//   - 주소: 공개 주소(/object/public/)는 만들지 않음 · 서명 주소(sign · token)만, 편집기가 돌려주는 주소에서 버킷 · 열쇠 읽기
//   - 이 서버 경로의 서명: 회사 · 카드 · 첨부 번호 · 사람 · 대화방 · 만료 · inline 을 묶음, 바꾸면 bad · 지나면 expired · 너무 먼 만료 bad,
//     팀 공유 미디어 주소의 키로는 맞지 않음, 주소에 로그인 토큰 없음
//   - 무엇으로 여나: 문서 → 이음오피스, 그림 · 소리 · 영상 → 보기 화면, 그 밖(HTML 포함) → 내려받기
//   - 권한 상태: 주인 · 공유받음 · 요약 · 요청함 · 없어짐, 메시지에 남는 모양(주소 · 열쇠 없음)
//   - 화면 쪽: 끌기 내용(mailatt) · 놓는 곳의 말 · 비공개 카드는 서버가 서명한 주소로 연다(openPlan fetch)
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_BACKGROUND = '0'
const P = await import('../lib/privateStore.js')
const MA = await import('../lib/mailAttachments.js')
const { linkKey: shareLinkKey, LINK_TTL_S } = await import('../lib/team/mediaLink.js')
const { validItem, parsePayload, payload, same, zoneWords } = await import('../../src/fileDrag.js')
const { openPlan } = await import('../../src/openPlan.js')
const { normItem } = await import('../lib/fileRefs.js')

const U = 'a3b1c2d4-1111-4222-8333-944455566677'
const CARD = 'c0ffee00-2222-4333-8444-955566677788'
const OTHER = 'b0b0b0b0-3333-4444-8555-966677788899'
const SHA = crypto.createHash('sha256').update('payroll').digest('hex')

test('보관 열쇠: 비공개 버킷 · ASCII · 사람/카드/번호/해시, 파일 이름은 열쇠에 없음', () => {
  const k = P.mailKey({ tenant: 'uengine', userId: U, actionId: CARD, i: 0, sha: SHA }, '2026년 11월 정규직 급여대장.xlsx')
  assert.equal(k, `mail/uengine/${U}/${CARD}/0-${SHA.slice(0, 16)}/attachment.xlsx`)
  assert.match(k, /^[A-Za-z0-9._/-]+$/)
  assert.ok(!k.includes('급여'), '이름(한글)이 열쇠에 들어가지 않는다')
  assert.ok(P.safeKey(k))
  assert.equal(P.BUCKET, 'lite-private')
  assert.notEqual(P.BUCKET, 'files', '공개 버킷이 아니다')
  // the tenant's odd characters stay inside one segment
  assert.equal(P.mailKey({ tenant: 'a/../b', userId: U, actionId: CARD, i: 2, sha: SHA }, 'x.pdf').split('/')[1], 'a_.._b')
  assert.ok(P.mailKey({ tenant: '..', userId: U, actionId: CARD, i: 2, sha: SHA }, 'x.pdf').split('/').every((s) => s && s !== '.' && s !== '..'))
  assert.equal(P.mailKey({ tenant: 't', userId: U, actionId: CARD, i: 1, sha: SHA }, 'no-extension'), `mail/t/${U}/${CARD}/1-${SHA.slice(0, 16)}/attachment.bin`)
  assert.throws(() => P.mailDir({ tenant: 't', userId: 'not-a-person', actionId: CARD, i: 0, sha: SHA }))
  assert.throws(() => P.mailDir({ tenant: 't', userId: U, actionId: CARD, i: -1, sha: SHA }))
  assert.throws(() => P.mailDir({ tenant: 't', userId: U, actionId: CARD, i: 0, sha: 'short' }))
  assert.equal(P.folderKey({ tenant: 't', folderId: OTHER, sha: 'a'.repeat(40) }, '메일/01_첨부/급여대장.xlsx'), `folders/t/${OTHER}/${'a'.repeat(40)}.xlsx`)
  assert.throws(() => P.folderKey({ tenant: 't', folderId: OTHER, sha: 'not-a-blob' }, 'x.xlsx'))
  for (const bad of ['', 'a//b', 'a/../b', '../x', 'a/./b', 'a\\b', '급여/x', 'a b']) assert.equal(P.safeKey(bad), false, bad)
  // a person's own copies are under their own prefix only
  assert.ok(k.startsWith(P.mailPrefix({ tenant: 'uengine', userId: U, actionId: CARD, i: 0 })))
  assert.ok(!k.startsWith(P.mailPrefix({ tenant: 'uengine', userId: OTHER, actionId: CARD, i: 0 })))
  assert.ok(!k.startsWith(P.mailPrefix({ tenant: 'uengine', userId: U, actionId: CARD, i: 1 })))
})

test('편집본: 같은 폴더의 edited-… 만, 더 깊거나 다른 폴더 · 다른 이름은 아님', () => {
  const dir = P.mailDir({ tenant: 't', userId: U, actionId: CARD, i: 0, sha: SHA })
  assert.ok(P.editedIn(dir, `${dir}/edited-attachment_20261125093000.xlsx`))
  assert.equal(P.editedIn(dir, `${dir}/attachment.xlsx`), false)
  assert.equal(P.editedIn(dir, `${dir}/x/edited-attachment_20261125093000.xlsx`), false)
  assert.equal(P.editedIn(dir, `${dir.replace(U, OTHER)}/edited-attachment_20261125093000.xlsx`), false)
  assert.equal(P.editedIn(dir, `${dir}/edited-../../x.xlsx`), false)
  assert.equal(P.dirOf(`${dir}/attachment.xlsx`), dir)
})

test('주소: 공개 주소는 만들지 않고, 편집기가 돌려준 주소(공개 · 서명 꼴)에서 버킷과 열쇠를 읽는다 — 다른 호스트는 아님', () => {
  const base = 'http://127.0.0.1:54321'
  const key = `mail/t/${U}/${CARD}/0-${SHA.slice(0, 16)}/edited-attachment_20261125093000.xlsx`
  assert.deepEqual(P.objectOfUrl(`${base}/storage/v1/object/public/lite-private/${key}`, base), { bucket: 'lite-private', key })
  assert.deepEqual(P.objectOfUrl(`http://localhost:54321/storage/v1/object/sign/lite-private/${key}?token=abc`, base), { bucket: 'lite-private', key })
  assert.deepEqual(P.objectOfUrl(`${base}/storage/v1/object/files/pgpt-pro/x.xlsx`, base), { bucket: 'files', key: 'pgpt-pro/x.xlsx' })
  assert.equal(P.objectOfUrl(`https://evil.example/storage/v1/object/public/lite-private/${key}`, base), null)
  // (a URL's own dot segments are resolved by the URL itself: nothing climbs out of the bucket; an encoded slash is refused)
  assert.deepEqual(P.objectOfUrl(`${base}/storage/v1/object/public/lite-private/a/../b.xlsx`, base), { bucket: 'lite-private', key: 'b.xlsx' })
  assert.equal(P.objectOfUrl(`${base}/storage/v1/object/public/lite-private/a%2F..%2F..%2Fb.xlsx`, base), null)
  assert.equal(P.objectOfUrl(`${base}/storage/v1/object/public/lite-private/%EA%B8%89.xlsx`, base), null, 'ASCII 열쇠만')
  assert.equal(P.objectOfUrl('javascript:alert(1)', base), null)
  assert.ok(P.isSignedUrl(`${base}/storage/v1/object/sign/lite-private/${key}?token=eyJx`))
  assert.equal(P.isSignedUrl(`${base}/storage/v1/object/public/lite-private/${key}`), false)
  assert.ok(P.isPublicUrl(`${base}/storage/v1/object/public/files/x`))
})

test('무엇으로 여나: 문서는 이음오피스, 그림 · 소리 · 영상(팩스 TIFF 포함)은 보기 화면, 그 밖(HTML · zip)은 내려받기', () => {
  assert.deepEqual(MA.kindOf({ name: '2026년 11월 정규직 급여대장.xlsx' }), { kind: 'office', editor: 'sheets' })
  assert.deepEqual(MA.kindOf({ name: '계약서.docx' }), { kind: 'office', editor: 'docs' })
  assert.deepEqual(MA.kindOf({ name: '제안.hwp' }), { kind: 'office', editor: 'hwp' })
  assert.deepEqual(MA.kindOf({ name: '안내.pdf', type: 'application/pdf' }), { kind: 'office', editor: 'pdf' })
  assert.deepEqual(MA.kindOf({ name: 'README.md' }), { kind: 'office', editor: 'markdown' })
  assert.deepEqual(MA.kindOf({ name: '공지.html', type: 'text/html' }), { kind: 'file' }, '남의 HTML 은 이 출처에서 그리지 않는다')
  assert.deepEqual(MA.kindOf({ name: '현장.jpg', type: 'image/jpeg' }), { kind: 'media', media: 'image' })
  assert.deepEqual(MA.kindOf({ name: 'scan.png', type: 'application/octet-stream' }), { kind: 'media', media: 'image' })
  assert.deepEqual(MA.kindOf({ name: '녹음', type: 'audio/mp4' }), { kind: 'media', media: 'audio' })
  assert.deepEqual(MA.kindOf({ name: 'clip.mp4' }), { kind: 'media', media: 'video' })
  // (a TIFF — a fax — is drawn by the app itself since 11-25: src/tiff.js)
  assert.deepEqual(MA.kindOf({ name: '도면.tif', type: 'image/tiff' }), { kind: 'media', media: 'image' })
  assert.deepEqual(MA.kindOf({ name: '자료.zip', type: 'application/zip' }), { kind: 'file' })
  assert.equal(MA.rawType('a.m4a', 'application/octet-stream'), 'audio/mp4')
  assert.equal(MA.rawType('a.xlsx', ''), 'application/octet-stream')
  assert.equal(MA.attIndex('3'), 3)
  for (const bad of ['-1', '1.5', 'x', '100', null]) assert.equal(MA.attIndex(bad), null, String(bad))
})

test('서버 경로의 서명: 바꾸면 bad · 지나면 expired · 먼 만료 bad · 팀 공유 키로는 아님 · 주소에 토큰 없음', () => {
  const key = MA.linkKeyOf('service-key-of-this-server')
  const now = Date.UTC(2026, 10, 25, 1, 0, 0)
  const s = MA.signAtt({ key, tenant: 'uengine', actionId: CARD, i: 0, userId: U, inline: true, now })
  assert.ok(s.exp - now / 1000 >= LINK_TTL_S && s.exp - now / 1000 < LINK_TTL_S + 300, '15분(5분 눈금으로 올림)')
  const p = MA.attPath(CARD, 0, s)
  assert.match(p, new RegExp(`^/mail/attachments/${CARD}/0/raw\\?u=${U}&exp=\\d+&inline=1&sig=[A-Za-z0-9_-]{43}$`))
  assert.doesNotMatch(p, /token=|eyJ|object\/public/)
  const ok = { key, tenant: 'uengine', actionId: CARD, i: 0, u: U, exp: s.exp, sig: s.sig, inline: true, now }
  assert.equal(MA.verifyAtt(ok), 'ok')
  assert.equal(MA.verifyAtt({ ...ok, u: OTHER }), 'bad', '다른 사람')
  assert.equal(MA.verifyAtt({ ...ok, i: 1 }), 'bad', '다른 첨부')
  assert.equal(MA.verifyAtt({ ...ok, actionId: OTHER }), 'bad', '다른 카드')
  assert.equal(MA.verifyAtt({ ...ok, tenant: 'other' }), 'bad', '다른 회사')
  assert.equal(MA.verifyAtt({ ...ok, inline: false }), 'bad', 'inline 을 뺌')
  assert.equal(MA.verifyAtt({ ...ok, r: 'room-1' }), 'bad', '대화방을 붙임')
  assert.equal(MA.verifyAtt({ ...ok, exp: s.exp + 300 }), 'bad', '만료를 늘림')
  assert.equal(MA.verifyAtt({ ...ok, now: (s.exp + 1) * 1000 }), 'expired')
  assert.equal(MA.verifyAtt({ ...ok, key: MA.linkKeyOf('another-server') }), 'bad')
  // a team share's media key (lib/team/mediaLink.js) is not this one
  assert.equal(MA.verifyAtt({ ...ok, key: shareLinkKey('service-key-of-this-server') }), 'bad')
  const far = MA.signAtt({ key, tenant: 'uengine', actionId: CARD, i: 0, userId: U, now, exp: Math.floor(now / 1000) + 24 * 3600 })
  assert.equal(MA.verifyAtt({ ...ok, exp: far.exp, sig: far.sig }), 'bad', '하루짜리는 우리 것이 아니다')
  // a colleague's address names the room it was shared with
  const r = MA.signAtt({ key, tenant: 'uengine', actionId: CARD, i: 0, userId: OTHER, room: 'room-7f3', now })
  assert.match(MA.attPath(CARD, 0, r), /&r=room-7f3&sig=/)
  assert.equal(MA.verifyAtt({ key, tenant: 'uengine', actionId: CARD, i: 0, u: OTHER, r: 'room-7f3', exp: r.exp, sig: r.sig, now }), 'ok')
  assert.equal(MA.verifyAtt({ key, tenant: 'uengine', actionId: CARD, i: 0, u: OTHER, r: 'room-8aa', exp: r.exp, sig: r.sig, now }), 'bad')
  assert.throws(() => MA.signAtt({ key, tenant: 't', actionId: CARD, i: 0, userId: U, room: 'bad room/../x' }))
})

test('권한 상태 · 메시지에 남는 모양(주소 · 열쇠 없음)', () => {
  assert.equal(MA.attRefState({ mine: true }), 'mine')
  assert.equal(MA.attRefState({ share: 'room' }), 'shared')
  assert.equal(MA.attRefState({}), 'summary')
  assert.equal(MA.attRefState({ requested: true }), 'requested')
  assert.equal(MA.attRefState({ gone: true, mine: true }), 'gone')
  const card = { source: { att_share: { 0: { 'room-1': { at: 'x' } } } } }
  assert.equal(MA.attSharedWith(card, 0, 'room-1'), true)
  assert.equal(MA.attSharedWith(card, 1, 'room-1'), false, '다른 첨부는 아님')
  assert.equal(MA.attSharedWith(card, 0, 'room-2'), false, '다른 방은 아님')
  const kept = MA.publicAttRef({ type: 'mailatt', actionId: CARD, i: 0, owner: U, name: '급여대장.xlsx', size: 1234, subject: '11월 급여대장', from: '오가람 세무', key: 'mail/x', url: 'http://x/storage/v1/object/public/y', share: 'yes' })
  assert.deepEqual(Object.keys(kept).sort(), ['actionId', 'date', 'domain', 'from', 'i', 'name', 'owner', 'ownerName', 'share', 'size', 'subject', 'type'])
  assert.equal(kept.share, null)
})

test('화면 쪽: 끌기 내용(mailatt) · 같은 첨부는 한 번 · 놓는 곳의 말 · 서버 normItem', () => {
  const it = { src: 'mailatt', id: CARD, i: 0, name: '급여대장.xlsx', subject: '11월 급여대장 확인', as: 'mailatt' }
  assert.deepEqual(validItem(it), it)
  assert.equal(validItem({ ...it, i: -1 }), null)
  assert.equal(validItem({ ...it, i: 1.5 }), null)
  assert.equal(validItem({ ...it, id: 'x' }), null)
  assert.equal(validItem({ ...it, name: '' }), null)
  assert.deepEqual(parsePayload(payload([it, { ...it }, { ...it, i: 1, name: '증빙.png' }])).map((x) => x.i), [0, 1])
  assert.equal(same(it, { ...it, i: 1 }), false)
  assert.equal(zoneWords('chat', [it]), 'AI에게 이 첨부로 묻기')
  assert.equal(zoneWords('chat', [{ src: 'mail', id: CARD }, it]), 'AI에게 이 첨부로 묻기')
  assert.equal(zoneWords('messenger', [it]), '여기에 놓으면 첨부를 멘션해요 · 동료에게는 이름만 보여요')
  assert.equal(zoneWords('folder', [it]), '메일 첨부는 메일 시트에서 정리해요')
  assert.equal(zoneWords('messenger', [{ src: 'mail', id: CARD }]), '여기에 놓으면 메일을 멘션해요', 'PR #49 그대로')
  assert.deepEqual(normItem(it), { src: 'mailatt', id: CARD, i: 0, name: '급여대장.xlsx' })
  assert.equal(normItem({ ...it, i: 'x' }), null)
})

test('비공개 카드(편집본)는 서버가 서명한 주소로 연다 — 주소가 없다고 작업실로 가지 않는다', () => {
  assert.deepEqual(openPlan({ name: '급여대장.xlsx', private: { key: 'mail/x/attachment.xlsx' }, edited: true }), { how: 'fetch' })
  assert.deepEqual(openPlan({ name: '급여대장.xlsx', private: { key: 'k' }, url: 'http://127.0.0.1:54321/storage/v1/object/sign/lite-private/k?token=t' }), { how: 'office', editor: 'sheets' })
})

// ---------- review 11-25 ----------
const A = await import('../lib/agent.js')
const fsp = await import('node:fs/promises')
const os = await import('node:os')
const nodePath = await import('node:path')

test('MA-R4 이름: 겹친 빈칸 · NBSP · U+3000 · 끝 빈칸 · 폭 없는 글자 · 잘린 긴 이름도 같은 첨부, 다른 이름은 아님', () => {
  const raw = '2026년  11월 하늘테크　정규직 급여대장 .xlsx'
  assert.equal(MA.normName(raw), '2026년 11월 하늘테크 정규직 급여대장 .xlsx')
  assert.ok(MA.sameName(raw, '2026년 11월 하늘테크 정규직 급여대장 .xlsx'))
  assert.ok(MA.sameName(' 급여​대장.xlsx ', '급여 대장.xlsx'))
  const long = `${'아주 긴 첨부 이름 '.repeat(30)}.pdf`
  assert.ok(long.length > 200)
  assert.ok(MA.sameName(long, long.trim().slice(0, 200)), '칩이 200자로 자른 이름')
  assert.equal(MA.sameName('급여대장.xlsx', '급여대장 (2).xlsx'), false)
  assert.equal(MA.sameName('a.xlsx', 'a.xls'), false, '짧은 앞부분만 같은 것은 아님')
  assert.equal(MA.sameName('', ''), false)
  // what the card knows of attachment n: the sheet's list, else the copy, else the row's names — never the mailbox
  assert.deepEqual(MA.knownOf({ source: { att_meta: [{ name: 'a.xlsx', size: 3, type: 't' }], att_copies: { 0: { name: 'b' } } } }, 0), { name: 'a.xlsx', size: 3, type: 't' })
  assert.deepEqual(MA.knownOf({ source: { att_copies: { 1: { name: 'b.png', size: 9, type: 'image/png' } } } }, 1), { name: 'b.png', size: 9, type: 'image/png' })
  assert.deepEqual(MA.knownOf({ source: { follow: { atts: ['x', 'c.zip'] } } }, 1), { name: 'c.zip', size: 0, type: '' })
  assert.equal(MA.knownOf({ source: {} }, 0), null)
})

test('MA-R2 저장 갈래: 비공개 카드는 비공개 버킷의 편집본만, 다른 주소는 거절(주소를 붙이지 않음) · 보통 카드는 예전대로', () => {
  const base = 'http://127.0.0.1:54321'
  const priv = { content: { private: { key: `folders/t/${OTHER}/${'a'.repeat(40)}.xlsx` }, folder: { slug: 's' } } }
  const link = { content: { url: `${base}/storage/v1/object/public/files/pgpt-pro/folders/x/${'a'.repeat(40)}.xlsx`, folder: { slug: 's' } } }
  const inPrivate = `${base}/storage/v1/object/public/lite-private/folders/t/${OTHER}/edited-x_20261125093000.xlsx`
  const inFiles = `${base}/storage/v1/object/public/files/pgpt-pro/folders/x/edited-x_20261125093000.xlsx`
  assert.equal(MA.saveKindOf(priv, inPrivate), 'private')
  assert.equal(MA.saveKindOf(priv, inFiles), 'refuse')
  assert.equal(MA.saveKindOf(link, inFiles), 'public')
  assert.equal(MA.saveKindOf(link, inPrivate), 'public')
})

test('MA-R1 턴의 끝: 업로드 · 넘겨준 메일 첨부(내용이 같으면 이름 · 자리가 달라도)는 카드가 되지 않고, 로그에 그 이름이 없다', async () => {
  const buf = Buffer.from('payroll-bytes')
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  const handed = A.privatePaths([{ path: `/workspace/uploads/${U}/mail/x/급여대장.xlsx`, sha256: sha }, { path: null, sha256: 'not-a-hash' }])
  assert.deepEqual([handed.paths.size, handed.hashes.size], [1, 1])
  let reads = 0
  const bytes = async (f) => { reads++; return f.path?.includes('copy') ? buf : Buffer.from('another document') }
  assert.equal(await A.privateCandidate({ path: `/workspace/uploads/${U}/mail/x/급여대장.xlsx` }, handed, U, { bytes }), 'an upload')
  assert.equal(await A.privateCandidate({ path: `/workspace/uploads/${U}/abc/다른 첨부.pdf` }, A.privatePaths([]), U, { bytes }), 'an upload', '업로드 폴더는 늘')
  assert.equal(await A.privateCandidate({ path: '/workspace/.bpmn/conv/급여 copy.xlsx' }, handed, U, { bytes }), 'a mail attachment handed over this turn')
  assert.equal(await A.privateCandidate({ name: 'x.xlsx', url: 'http://s/copy.xlsx' }, handed, U, { bytes: async () => buf }), 'a mail attachment handed over this turn', '도구가 올린 사본도')
  assert.equal(await A.privateCandidate({ path: '/workspace/.bpmn/conv/보고서.xlsx' }, handed, U, { bytes }), null)
  const before = reads
  assert.equal(await A.privateCandidate({ path: '/workspace/.bpmn/conv/보고서.xlsx' }, A.privatePaths([]), U, { bytes }), null)
  assert.equal(reads, before, '넘겨준 첨부가 없는 턴은 파일을 읽지 않는다')
  assert.equal(A.logPath(`/workspace/uploads/${U}/mail/x/급여대장.xlsx`, handed), '/workspace/uploads/…')
  assert.equal(A.logPath('/workspace/.bpmn/c/a.xlsx', handed), '/workspace/.bpmn/c/a.xlsx')
  assert.equal(A.logName('급여대장.xlsx', handed), '(a document)')
  assert.equal(A.uploadsPath('/workspace/uploadsX/a'), false)
})

test('MA-R6 작업 공간에 쓰기: 쓸 때마다 무작위 폴더, 미리 깔아 둔 링크는 따라가지 않음(밖에 아무것도 생기지 않음), 0600', async () => {
  const ws = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'ma-ws-'))
  const outside = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'ma-out-'))
  try {
    const copy = { name: '2026년 11월 급여대장.xlsx', buf: Buffer.from('xlsx-bytes'), key: 'unused' }
    const user = { id: U }
    const a = await MA.toWorkspace(user, copy, { workspace: async () => ws })
    const b = await MA.toWorkspace(user, copy, { workspace: async () => ws })
    assert.match(a, new RegExp(`^/workspace/uploads/${U}/mail/[0-9a-f-]{36}/2026년 11월 급여대장\\.xlsx$`))
    assert.notEqual(a.split('/')[5], b.split('/')[5], '쓸 때마다 다른 폴더')
    const host = nodePath.join(ws, a.slice('/workspace'.length))
    assert.ok((await fsp.readFile(host)).equals(copy.buf))
    assert.equal((await fsp.stat(host)).mode & 0o777, 0o600)
    // a link laid where the folders are (the sandbox can write there): refused, nothing written through it
    const other = U.replace(/^a/, 'b')
    await fsp.mkdir(nodePath.join(ws, 'uploads', other), { recursive: true })
    await fsp.symlink(outside, nodePath.join(ws, 'uploads', other, 'mail'))
    await assert.rejects(MA.toWorkspace({ id: other }, copy, { workspace: async () => ws }), (e) => e.code === 'ENOTDIR')
    assert.deepEqual(await fsp.readdir(outside), [], '링크 너머에 아무것도 생기지 않는다')
    // a link instead of the person's own folder: the same
    const third = U.replace(/^a/, 'c')
    await fsp.symlink(outside, nodePath.join(ws, 'uploads', third))
    await assert.rejects(MA.toWorkspace({ id: third }, copy, { workspace: async () => ws }), (e) => e.code === 'ENOTDIR')
    assert.deepEqual(await fsp.readdir(outside), [])
  } finally {
    await fsp.rm(ws, { recursive: true, force: true })
    await fsp.rm(outside, { recursive: true, force: true })
  }
})

test('MA-R3 한 첨부는 한 번에 한 번만 받고, 너무 큰 메일 · 느린 메일함은 몇 분 기억해 다시 받지 않는다', async () => {
  MA.forgetFailures()
  const card = { id: CARD, source: { mail_id: 'm-1' } }
  // two opens at once while the mailbox is slow: one read; both get its answer (here: the mailbox did not answer in time)
  let reads = 0
  let release
  const slow = { source: async () => { reads++; await new Promise((r) => { release = r }); throw Object.assign(new Error('메일함이 제때 답하지 않았어요.'), { status: 504, code: 'mail_timeout' }) } }
  const p1 = MA.ensureCopy(U, card, 0, 'a.xlsx', slow)
  const p2 = MA.ensureCopy(U, card, 0, 'a.xlsx', slow)
  await new Promise((r) => setTimeout(r, 20))
  release()
  const [r1, r2] = await Promise.allSettled([p1, p2])
  assert.deepEqual([r1.status, r2.status, r1.reason?.status, r2.reason?.status], ['rejected', 'rejected', 504, 504])
  assert.equal(reads, 1, '한 번만 읽는다')
  // remembered: the next press does not read again
  await assert.rejects(MA.ensureCopy(U, card, 0, 'a.xlsx', slow), (e) => e.status === 504)
  assert.equal(reads, 1)
  // a mail too large: the same (another attachment of another card)
  const card2 = { id: OTHER, source: { mail_id: 'm-2' } }
  let big = 0
  const huge = { source: async () => { big++; throw Object.assign(new Error('너무 커요'), { status: 413, code: 'mail_too_large' }) } }
  await assert.rejects(MA.ensureCopy(U, card2, 1, '', huge), (e) => e.status === 413)
  await assert.rejects(MA.ensureCopy(U, card2, 1, '', huge), (e) => e.status === 413)
  assert.equal(big, 1)
  // a not-found is not remembered (the mail may come back)
  let nf = 0
  const gone = { source: async () => { nf++; throw Object.assign(new Error('없음'), { status: 404 }) } }
  await assert.rejects(MA.ensureCopy(U, card2, 2, '', gone), (e) => e.status === 404)
  await assert.rejects(MA.ensureCopy(U, card2, 2, '', gone), (e) => e.status === 404)
  assert.equal(nf, 2)
  MA.forgetFailures()
  await assert.rejects(MA.ensureCopy(U, card2, 1, '', huge), (e) => e.status === 413)
  assert.equal(big, 2, '잊은 뒤에는 다시 받아 본다')
  assert.ok(MA.FAILURE_TTL_MS >= 60_000 && MA.FAILURE_TTL_MS <= 15 * 60_000)
  assert.ok(MA.MAX_RAW_BYTES > MA.MAX_BYTES * 1.33, '50MB 첨부가 든 메일(base64) 은 받는다')
})
