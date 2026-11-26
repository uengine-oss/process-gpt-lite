// Folder references, P0 (spec openspec/specs/folder-refs): a managed folder holds slots that point at another folder, a sub-folder of
// it or one file; the server resolves every read with the reader's role in the source, now.
//   RF-U-01 ~ 03  pure: slots, overlaps
//   RF-U-04 ~ 15  with the local database and real git: the resolver per reader (ok · locked · dangling; the slot wins over a later file), sub-path and single
//                 file, depth 1, the locked shape, the tenant guard in code and in the database (trigger, RLS), writes refused, an agent's
//                 writes at a slot not kept (and said), the tree and the agent's view, membership taken away, no gitlink in any repository
// Run: node --test test/folderRefs.test.js  (folders go to a temporary directory, rows in the tenants "folder-refs-test" and
// "folder-refs-other", everything is removed afterwards)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-folderrefs-'))
const TENANT = 'folder-refs-test'
const OTHER = 'folder-refs-other'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
process.env.PRO_TENANT_HOSTS = ''
const R = await import('../lib/folders/refs.js')

// ---------- pure ----------
test('RF-U-01 자리 찾기: 자리 그 자체와 그 아래만, 이름이 겹쳐 시작하는 옆 경로는 아님', () => {
  const rows = [{ id: 1, slot: '폴더1' }, { id: 2, slot: '자료/가격표.xlsx' }]
  assert.equal(R.slotOf(rows, '폴더1')?.id, 1)
  assert.equal(R.slotOf(rows, '폴더1/가격 정책.docx')?.id, 1)
  assert.equal(R.slotOf(rows, '폴더10/a.md'), null)
  assert.equal(R.slotOf(rows, '자료/가격표.xlsx')?.id, 2)
  assert.equal(R.slotOf(rows, '자료/다른.md'), null)
  assert.equal(R.slotOf(rows, '제안서 초안.docx'), null)
})
test('RF-U-02 겹침: 같은 경로, 한쪽이 다른 쪽 안 — 둘 다 겹침, 옆 경로는 아님', () => {
  assert.ok(R.overlaps('a', 'a'))
  assert.ok(R.overlaps('a', 'a/b'))
  assert.ok(R.overlaps('a/b', 'a'))
  assert.ok(!R.overlaps('a', 'ab'))
  assert.ok(!R.overlaps('a/b', 'a/c'))
})
test('RF-U-03 거절 말: 잠김은 403 ref_locked, 끊어짐은 404 ref_dangling, 정상 · 자리 밖은 없음', () => {
  assert.equal(R.refusal({ state: 'locked' }).status, 403)
  assert.equal(R.refusal({ state: 'locked' }).code, 'ref_locked')
  assert.equal(R.refusal({ state: 'dangling' }).code, 'ref_dangling')
  assert.equal(R.refusal({ state: 'ok' }), null)
  assert.equal(R.refusal(null), null)
})

// ---------- with the database ----------
const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_folder_refs limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const { reindex } = await import('../lib/folders/indexer.js')
const enc = (s) => Buffer.from(s)
const owner = { id: crypto.randomUUID(), name: '한서연', email: 'refs-owner@example.test' }   // composes 「제안 준비」, owns every source
const mate = { id: crypto.randomUUID(), name: '오지후', email: 'refs-mate@example.test' }     // a member of 「제안 준비」 and 「영업 자료」 only
after(async () => {
  if (db) {
    await q('delete from pro_folder_ref_events where tenant_id = any($1)', [[TENANT, OTHER]]).catch(() => {})
    await q('delete from pro_folders where tenant_id = any($1)', [[TENANT, OTHER]]).catch(() => {})
    await q("delete from pro_messages where thread_id in (select id from pro_threads where user_id = any($1::uuid[]))", [[owner.id, mate.id]]).catch(() => {})
    await q('delete from pro_threads where user_id = any($1::uuid[])', [[owner.id, mate.id]]).catch(() => {})
  }
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
})
const put = async (f, p, body) => { await S.upload(f, owner, p, enc(body)); await reindex(await S.folderById(f.id), { cards: false }) }
let W // the world: folders of the sketch
async function world() {
  if (W) return W
  const sales = await S.createFolder(owner, { name: `영업 자료 ${crypto.randomBytes(2).toString('hex')}` })
  const rules = await S.createFolder(owner, { name: `규정집 ${crypto.randomBytes(2).toString('hex')}` })
  const deep = await S.createFolder(owner, { name: `깊은 원본 ${crypto.randomBytes(2).toString('hex')}` })
  const comp = await S.createFolder(owner, { name: `제안 준비 ${crypto.randomBytes(2).toString('hex')}` })
  await put(sales, '가격 정책.docx', '가격 정책 — 대량 구매 10% 할인')
  await put(sales, '가격표.xlsx', 'PK 가격표 2026')
  await put(sales, '안내/소개.md', '# 소개\n달빛 커피는 원두를 직접 볶아요.\n')
  await put(rules, '인사/휴가.md', '# 휴가 규정\n연차는 15일\n')
  await put(rules, '보안/비밀.md', '# 보안 규정\n외부 반출 금지\n')
  await put(deep, '깊은.md', '# 깊은 원본\n')
  await put(comp, '제안서 초안.docx', '제안서 초안')
  // mate: in the composing folder and in 영업 자료, not in 규정집
  await S.setMember(comp, owner, { type: 'user', id: mate.id, role: 'viewer' })
  await S.setMember(sales, owner, { type: 'user', id: mate.id, role: 'viewer' })
  W = { sales, rules, deep, comp }
  return W
}
const role = (f, u) => S.roleOf(f, u)

test('RF-U-04 더하기: 폴더 전체 · 하위 폴더 · 파일 하나 — 이름은 원본 이름, 종류는 원본에서, 기본은 main 따라가기', { skip: !db && 'no database' }, async () => {
  const { sales, rules, comp } = await world()
  const a = await R.add(comp, 'owner', owner, { source: sales.slug, slot: '폴더1' })
  assert.equal(a.state, 'ok'); assert.equal(a.type, 'folder'); assert.equal(a.track, 'main'); assert.equal(a.from.slug, sales.slug)
  const b = await R.add(comp, 'owner', owner, { source: rules.id, path: '인사', slot: '폴더2' })
  assert.equal(b.type, 'dir'); assert.equal(b.from.path, '인사')
  // (a file's slot keeps the file's kind)
  // (the extension only when asked for — keepExt — or typed)
  const c = await R.add(comp, 'owner', owner, { source: sales.slug, path: '가격표.xlsx', slot: '가격표', keepExt: true })
  assert.equal(c.type, 'file'); assert.equal(c.slot, '가격표.xlsx'); assert.equal(c.label, '가격표')
  const d = await R.add(comp, 'owner', owner, { source: rules.slug, path: '보안/비밀.md', slot: '비밀.md' })
  assert.equal(d.slot, '비밀.md')
  await R.remove(comp, 'owner', owner, d.id)
  const rows = await q('select * from pro_folder_refs where folder_id=$1', [comp.id])
  assert.deepEqual(rows.map((x) => x.slot).sort(), ['가격표.xlsx', '폴더1', '폴더2'])
  assert.ok(rows.every((x) => x.tenant_id === TENANT && x.track === 'main' && !x.pinned_commit))
})

test('RF-U-05 resolve: 원본의 구성원에게는 원본의 그 판 · 그 경로, 구성원이 아니면 잠김(원본 정보 없음)', { skip: !db && 'no database' }, async () => {
  const { sales, rules, comp } = await world()
  const o1 = await R.resolve(comp, '폴더1/가격 정책.docx', owner)
  assert.equal(o1.state, 'ok'); assert.equal(o1.source.id, sales.id); assert.equal(o1.path, '가격 정책.docx')
  assert.equal(o1.rev, await G.head(sales.repo_path, 'main'))
  assert.equal((await S.readBlob(o1.source, o1.rev, o1.path)).toString(), '가격 정책 — 대량 구매 10% 할인')
  // a sub-folder: the slot's path inside it
  const o2 = await R.resolve(comp, '폴더2/휴가.md', owner)
  assert.equal(o2.path, '인사/휴가.md'); assert.equal(o2.source.id, rules.id)
  // one file: the slot itself, nothing under it
  const o3 = await R.resolve(comp, '가격표.xlsx', owner)
  assert.equal(o3.path, '가격표.xlsx'); assert.equal(o3.type, 'file')
  assert.equal((await R.resolve(comp, '가격표.xlsx/x', owner)).path, null)
  // not under a slot: the folder's own file
  assert.equal(await R.resolve(comp, '제안서 초안.docx', owner), null)
  // the mate: 영업 자료 yes, 규정집 no
  assert.equal((await R.resolve(comp, '폴더1/가격 정책.docx', mate)).state, 'ok')
  const locked = await R.resolve(comp, '폴더2/휴가.md', mate)
  assert.deepEqual(Object.keys(locked).sort(), ['ref', 'state'])
  assert.equal(locked.state, 'locked')
})

test('RF-U-06 잠긴 자리의 모양: 이름표 · 상태 · 더한 사람 · 요청 여부뿐 — 원본의 id · slug · 이름 · 경로 · 판 · 수는 없다', { skip: !db && 'no database' }, async () => {
  const { rules, comp } = await world()
  const list = await R.list(comp, mate)
  const two = list.find((x) => x.slot === '폴더2')
  assert.deepEqual(Object.keys(two).sort(), ['by', 'id', 'label', 'requested', 'slot', 'state'])
  assert.equal(two.state, 'locked'); assert.equal(two.requested, false)
  const json = JSON.stringify(two)
  for (const secret of [rules.id, rules.slug, rules.name, '인사', await G.head(rules.repo_path, 'main')]) assert.ok(!json.includes(secret), secret)
  // the tree and the agent's view carry no file of it, the hint only its name
  const tree = await R.treeRows(comp, mate)
  assert.ok(tree.some((f) => f.path === '폴더1/가격 정책.docx'))
  assert.ok(!tree.some((f) => f.path.startsWith('폴더2')))
  const av = await R.agentView(comp, mate)
  assert.ok(!JSON.stringify(av).includes(rules.name) && !JSON.stringify(av).includes('휴가'))
  assert.deepEqual(av.refs.find((x) => x.slot === '폴더2'), { name: '폴더2', slot: '폴더2', state: 'locked' })
  const h = await R.hint({ mode: 'ref', folder_id: comp.id, slug: comp.slug }, mate)
  assert.ok(h.includes('폴더2') && h.includes('볼 수 없는') && !h.includes(rules.name))
  const ho = await R.hint({ mode: 'ref', folder_id: comp.id, slug: comp.slug }, owner)
  assert.ok(ho.includes(rules.name))
})

test('RF-U-07 깊이 1: 참조된 폴더가 다시 참조를 가져도 그 자리는 따라가지 않는다', { skip: !db && 'no database' }, async () => {
  const { sales, deep, comp } = await world()
  // 영업 자료 itself references 깊은 원본 at '깊은'
  await R.add(sales, 'owner', owner, { source: deep.slug, slot: '깊은' })
  assert.equal((await R.resolve(sales, '깊은/깊은.md', owner)).state, 'ok')
  // through 제안 준비's slot 폴더1 (= 영업 자료) the nested slot is not there
  const r = await R.resolve(comp, '폴더1/깊은/깊은.md', owner)
  assert.equal(r.state, 'ok')
  await assert.rejects(S.readBlob(r.source, r.rev, r.path), (e) => e.status === 404)
  assert.ok(!(await R.treeRows(comp, owner)).some((f) => f.path.includes('깊은')))
  // and a folder cannot reference itself
  await assert.rejects(R.add(comp, 'owner', owner, { source: comp.slug, slot: '나' }), (e) => e.status === 400)
})

test('RF-U-08 더하기 거절: 편집자가 아님 · 원본의 구성원이 아님 · 스킬 폴더 · 자리에 파일 · 자리 겹침 · 원본에 없는 경로', { skip: !db && 'no database' }, async () => {
  const { sales, rules, comp } = await world()
  await assert.rejects(R.add(comp, 'viewer', mate, { source: sales.slug, slot: 'x' }), (e) => e.status === 403)
  await S.setMember(comp, owner, { type: 'user', id: mate.id, role: 'editor' })
  try {
    await assert.rejects(R.add(comp, 'editor', mate, { source: rules.slug, slot: '몰래' }), (e) => e.status === 404)
  } finally { await S.setMember(comp, owner, { type: 'user', id: mate.id, role: 'viewer' }) }
  const [sk] = await q(`insert into pro_folders (tenant_id, slug, name, kind, repo_path, settings) values ($1,$2,$3,'skill',$4,$5) returning *`,
    [TENANT, `skill-${crypto.randomBytes(3).toString('hex')}`, '스킬 x', path.join(ROOT, 'nope'), { skill_name: 'x' }])
  await assert.rejects(R.add(comp, 'owner', owner, { source: sk.slug, slot: 's' }), (e) => e.status === 400)
  await assert.rejects(R.add(comp, 'owner', owner, { source: sales.slug, slot: '제안서 초안.docx' }), (e) => e.status === 409 && e.code === 'ref_taken')
  await assert.rejects(R.add(comp, 'owner', owner, { source: sales.slug, slot: '폴더1/안' }), (e) => e.status === 409)
  await assert.rejects(R.add(comp, 'owner', owner, { source: sales.slug, path: '없는/경로.md', slot: 'y' }), (e) => e.status === 404)
  await assert.rejects(R.add(comp, 'owner', owner, { source: sales.slug, slot: '../밖' }), (e) => e.status === 400)
  await assert.rejects(R.add(comp, 'owner', owner, { source: sales.slug, slot: 'a/.git/b' }), (e) => e.status === 400)
})

test('RF-U-09 회사 경계: 다른 회사의 폴더는 서비스가 찾지 못하고, 트리거가 행을 거절하며, 풀 때도 다시 찾지 않는다 · RLS 는 켜져 있다', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  const dir = path.join(ROOT, 'other')
  await fs.mkdir(dir, { recursive: true })
  await G.git(dir, ['init', '-q', '-b', 'main'])
  await fs.writeFile(path.join(dir, '남의.md'), '다른 회사의 자료\n')
  await G.commitAll(dir, 'x', { name: 'o', email: 'o@example.test' })
  const [foreign] = await q(`insert into pro_folders (tenant_id, slug, name, kind, repo_path) values ($1,$2,'다른 회사 폴더','managed',$3) returning *`, [OTHER, `other-${crypto.randomBytes(3).toString('hex')}`, dir])
  await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,'owner')`, [foreign.id, owner.id])
  // the service: by id and by slug, never another company's
  await assert.rejects(R.add(comp, 'owner', owner, { source: foreign.id, slot: '남의' }), (e) => e.status === 404)
  await assert.rejects(R.add(comp, 'owner', owner, { source: foreign.slug, slot: '남의' }), (e) => e.status === 404)
  // the database: a row whose source (or folder) is of another company is refused
  await assert.rejects(q(`insert into pro_folder_refs (tenant_id, folder_id, slot, label, source_folder_id, source_type) values ($1,$2,'남의','남의',$3,'folder')`, [TENANT, comp.id, foreign.id]),
    (e) => e.code === '23514')
  await assert.rejects(q(`insert into pro_folder_refs (tenant_id, folder_id, slot, label, source_folder_id, source_type) values ($1,$2,'남의','남의',null,'folder')`, [OTHER, comp.id]), (e) => e.code === '23514')
  const [mine] = await q(`select id from pro_folder_refs where folder_id=$1 and slot='폴더1'`, [comp.id])
  await assert.rejects(q('update pro_folder_refs set source_folder_id=$2 where id=$1', [mine.id, foreign.id]), (e) => e.code === '23514')
  // resolving finds the source again in this company only: a row that points elsewhere (put in past the trigger — this session only,
  // as a restore would) gives nothing
  let sneaked
  const raw = await pool.connect()
  try {
    await raw.query('begin')
    await raw.query("set local session_replication_role = 'replica'")
    ;[sneaked] = (await raw.query(`insert into pro_folder_refs (tenant_id, folder_id, slot, label, source_folder_id, source_type) values ($1,$2,'남의','남의',$3,'folder') returning *`, [TENANT, comp.id, foreign.id])).rows
    await raw.query('commit')
  } catch (e) { await raw.query('rollback').catch(() => {}); throw e } finally { raw.release() }
  try {
    const r = await R.resolve(comp, '남의/남의.md', owner)
    assert.equal(r.state, 'dangling')
    assert.ok(!(await R.treeRows(comp, owner)).some((f) => f.path.startsWith('남의')))
    assert.ok(!JSON.stringify(await R.list(comp, owner)).includes('다른 회사'))
  } finally { await q('delete from pro_folder_refs where id=$1', [sneaked.id]) }
  // RLS: on, and no policy — the API roles read nothing
  const [{ rls }] = await q(`select relrowsecurity as rls from pg_class where oid='public.pro_folder_refs'::regclass`)
  assert.equal(rls, true)
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('set local role authenticated')
    const { rows } = await c.query('select count(*)::int as n from pro_folder_refs')
    assert.equal(rows[0].n, 0)
    await c.query('rollback')
  } finally { c.release() }
})

test('RF-U-10 구성하는 폴더에서는 읽기만: 올리기 · 지우기 · 이음오피스 저장 · 작업실 쓰기 · 폴더에 넣기는 자리에서 거절, 옆 경로는 그대로', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  await assert.rejects(S.upload(comp, owner, '폴더1/새 파일.md', enc('x')), (e) => e.status === 409 && e.code === 'ref_readonly')
  await assert.rejects(S.upload(comp, owner, '가격표.xlsx', enc('x')), (e) => e.status === 409)
  await assert.rejects(S.removeFile(comp, owner, '폴더2/휴가.md'), (e) => e.status === 409)
  await assert.rejects(S.saveOfficeEdit(comp, owner, { path: '가격표.xlsx', url: 'http://x/y' }), (e) => e.status === 409)
  await S.upload(comp, owner, '폴더10/옆.md', enc('옆 경로는 괜찮아요'))
  const W2 = await import('../lib/workroom.js')
  const room = { kind: 'folder', id: comp.slug, folder: comp.id, root: comp.repo_path, cwd: comp.repo_path }
  await assert.rejects(W2.writeFile(room, '폴더1/메모.md', 'x'), (e) => e.status === 409)
  assert.equal(await fs.stat(path.join(comp.repo_path, '폴더1')).catch(() => null), null)
  // filing picks a name beside a file slot
  const F = await import('../lib/folders/filing.js')
  assert.equal(F.freePath('가격표.xlsx', new Set(['가격표.xlsx'])), '가격표 (2).xlsx')
  assert.deepEqual((await R.slotPaths(comp)).sort(), ['가격표.xlsx', '폴더1', '폴더2'])
})

test('RF-U-11 실행이 자리에 쓴 것은 담지 않고, 그 대화에 알린다 — 자기 파일은 그대로 커밋', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  const [th] = await q(`insert into pro_threads (user_id, kind, title) values ($1,'chat','참조 시험') returning id`, [owner.id])
  const v = await S.createVariation(comp, { title: '에이전트 작업', kind: 'chat', holder: { type: 'user', id: owner.id, name: owner.name }, source: { thread_id: th.id } })
  const dir = path.join(ROOT, 'run', v.id)
  await S.checkout(comp, v, dir)
  await fs.mkdir(path.join(dir, '폴더1'), { recursive: true })
  await fs.writeFile(path.join(dir, '폴더1', '가격 정책.docx'), '에이전트가 고친 가격')
  await fs.writeFile(path.join(dir, '가격표.xlsx'), '에이전트가 만든 표')
  await fs.writeFile(path.join(dir, '개요.md'), '# 제안서 개요\n')
  await G.git(dir, ['add', '-A']) // (even staged)
  const sha = await S.commitVariation(comp, await S.variationById(v.id), { name: 'agent', email: 'agent@example.test' }, '작업')
  assert.ok(sha)
  const files = (await G.lsTree(comp.repo_path, v.branch)).map((f) => f.path)
  assert.ok(files.includes('개요.md'))
  assert.ok(!files.some((p) => p.startsWith('폴더1/') || p === '가격표.xlsx'))
  const [note] = await q(`select content from pro_messages where thread_id=$1 and kind='chip'`, [th.id])
  assert.ok(note?.content?.text?.includes('읽기 전용'))
  assert.deepEqual(note.content.refsReadOnly.sort(), ['가격표.xlsx', '폴더1/가격 정책.docx'])
  await S.release(comp, await S.variationById(v.id))
})

test('RF-U-12 끊어짐 · 자리가 이김: 원본 경로가 없어지면 「찾을 수 없음」, 원본 폴더가 지워지면 끊어진 자리, 서버의 커밋은 자리 경로를 담지 않는다', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  const tmp = await S.createFolder(owner, { name: `잠깐 원본 ${crypto.randomBytes(2).toString('hex')}` })
  await put(tmp, '안내.md', '# 잠깐\n')
  await put(tmp, '곧 지움.md', '# 곧 지움\n')
  const a = await R.add(comp, 'owner', owner, { source: tmp.slug, path: '곧 지움.md', slot: '곧지움', keepExt: true })
  const b = await R.add(comp, 'owner', owner, { source: tmp.slug, slot: '잠깐' })
  assert.equal((await R.resolve(comp, '곧지움.md', owner)).state, 'ok')
  await S.removeFile(tmp, owner, '곧 지움.md')
  // (a read finds the path gone — 404; the list says why)
  const gonePath = await R.resolve(comp, '곧지움.md', owner)
  await assert.rejects(S.readBlob(gonePath.source, gonePath.rev, gonePath.path), (e) => e.status === 404)
  assert.equal((await R.list(comp, owner)).find((x) => x.id === a.id).state, 'dangling')
  // the source folder goes: the row stays, its source is cleared
  await q('delete from pro_folders where id=$1', [tmp.id])
  const [row] = await q('select source_folder_id from pro_folder_refs where id=$1', [b.id])
  assert.equal(row.source_folder_id, null)
  const gone = (await R.list(comp, owner)).find((x) => x.id === b.id)
  assert.deepEqual(Object.keys(gone).sort(), ['by', 'id', 'label', 'slot', 'state'])
  assert.equal(gone.state, 'dangling')
  // a file written at a slot in main's working tree (a shell): a commit of this server leaves it out — the slot keeps reading the original
  const c = await R.add(comp, 'owner', owner, { source: sales.slug, path: '안내', slot: '겹침' })
  await fs.mkdir(path.join(comp.repo_path, '겹침'), { recursive: true })
  await fs.writeFile(path.join(comp.repo_path, '겹침', '진짜.md'), '이 폴더의 진짜 파일\n')
  await S.commitMain(comp, owner, '작업실에서 고침')
  assert.ok(!(await G.lsTree(comp.repo_path, 'main')).some((f) => f.path.startsWith('겹침/')))
  assert.equal((await R.resolve(comp, '겹침/소개.md', owner)).state, 'ok')
  assert.equal((await R.list(comp, owner)).find((x) => x.id === c.id).state, 'ok')
  await assert.rejects(S.upload(comp, owner, '겹침/진짜.md', enc('고쳐도 돼요')), (e) => e.status === 409)
  await fs.rm(path.join(comp.repo_path, '겹침'), { recursive: true, force: true })
  for (const id of [a.id, b.id, c.id]) await R.remove(comp, 'owner', owner, id)
})

test('RF-U-13 원본 구성원에서 빠지면 다음 읽기부터 잠긴 자리 · 다시 들어오면 열린다', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  assert.equal((await R.resolve(comp, '폴더1/가격 정책.docx', mate)).state, 'ok')
  await S.removeMember(sales, { type: 'user', id: mate.id })
  try {
    assert.equal((await R.resolve(comp, '폴더1/가격 정책.docx', mate)).state, 'locked')
    assert.equal(await role(sales, mate), null)
  } finally { await S.setMember(sales, owner, { type: 'user', id: mate.id, role: 'viewer' }) }
  assert.equal((await R.resolve(comp, '폴더1/가격 정책.docx', mate)).state, 'ok')
})

test('RF-U-14 접근 요청: 잠긴 자리의 사람만 — 기록이 남고, 답에는 원본 이야기가 없으며, 하루에 한 번', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  const two = (await R.list(comp, mate)).find((x) => x.slot === '폴더2')
  const r1 = await R.requestAccess(comp, mate, two.id)
  assert.deepEqual(r1, { requested: true })
  assert.equal((await R.list(comp, mate)).find((x) => x.slot === '폴더2').requested, true)
  assert.deepEqual(await R.requestAccess(comp, mate, two.id), { requested: true })
  const [{ n }] = await q(`select count(*)::int as n from pro_folder_ref_events where ref_id=$1 and kind='access_requested'`, [two.id])
  assert.equal(n, 1)
  // a reader of the source asks nothing
  const one = (await R.list(comp, mate)).find((x) => x.slot === '폴더1')
  assert.deepEqual(await R.requestAccess(comp, mate, one.id), { requested: false, access: true })
})

test('RF-U-15 폴더 저장소에는 참조가 들어가지 않는다: gitlink · .gitmodules 없음, main 의 파일은 자기 것뿐', { skip: !db && 'no database' }, async () => {
  const { comp, sales } = await world()
  for (const f of [comp, sales]) {
    const all = await G.git(f.repo_path, ['ls-tree', '-r', '--full-tree', 'main'])
    assert.ok(!/^160000 /m.test(all), `${f.slug} has a gitlink`)
    assert.ok(!all.includes('.gitmodules'))
    assert.equal(await fs.stat(path.join(f.repo_path, '.gitmodules')).catch(() => null), null)
  }
  const own = (await G.lsTree(comp.repo_path, 'main')).map((x) => x.path)
  const slotted = (p) => p.startsWith('폴더1/') || p.startsWith('폴더2/') || p === '가격표.xlsx'
  assert.ok(!own.some(slotted))
  // the index of the composing folder holds only its own files (no content of a source is copied in)
  const idx = (await q('select path from pro_folder_files where folder_id=$1', [comp.id])).map((x) => x.path)
  assert.ok(!idx.some(slotted))
})

test('RF-U-16 구성하는 폴더와 원본을 한 번에 지워도 된다(원본이 비워지는 기록이 회사 확인에 걸리지 않음)', { skip: !db && 'no database' }, async () => {
  const src = await S.createFolder(owner, { name: `한꺼번에 원본 ${crypto.randomBytes(2).toString('hex')}` })
  const comp = await S.createFolder(owner, { name: `한꺼번에 구성 ${crypto.randomBytes(2).toString('hex')}` })
  await put(src, '자료.md', '# 자료\n')
  const r = await R.add(comp, 'owner', owner, { source: src.slug, slot: '자료' })
  await q('delete from pro_folders where id = any($1::uuid[])', [[src.id, comp.id]])
  assert.equal((await q('select 1 from pro_folder_refs where id=$1', [r.id])).length, 0)
  assert.equal((await q('select 1 from pro_folders where id = any($1::uuid[])', [[src.id, comp.id]])).length, 0)
})

test('RF-U-17 이름에 「tree」 · 「blob」이 든 경로: 없는 경로는 없다고, 빈 자리는 비었다고 읽는다', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  const t = await R.typesAt(comp.repo_path, 'main', ['Family tree', 'Data blob', 'a/Org tree', '제안서 초안.docx'])
  assert.deepEqual([...t.values()], [null, null, null, 'blob'])
  const r = await R.add(comp, 'owner', owner, { source: sales.slug, slot: 'Family tree' })
  assert.equal(r.state, 'ok')
  await assert.rejects(R.add(comp, 'owner', owner, { source: sales.slug, path: 'a/Org tree', slot: 'z' }), (e) => e.status === 404)
  await R.remove(comp, 'owner', owner, r.id)
})

// ---------- review of PR #92 (each written first against the code before its fix) ----------
test('RF-U-18 이름을 주지 않으면 자리 이름은 「참조 N」 — 원본 폴더 이름 · 파일 이름은 동료에게 가지 않고, 확장자는 적었거나 붙이기로 했을 때만', { skip: !db && 'no database' }, async () => {
  const { rules, comp } = await world()
  const a = await R.add(comp, 'owner', owner, { source: rules.slug })
  const b = await R.add(comp, 'owner', owner, { source: rules.slug, path: '보안/비밀.md' })
  assert.equal(a.label, '참조 1'); assert.equal(a.slot, '참조 1')
  assert.equal(b.label, '참조 2'); assert.equal(b.slot, '참조 2')
  const c = await R.add(comp, 'owner', owner, { source: rules.slug, path: '보안/비밀.md', slot: 'x/innocuous' })
  assert.equal(c.slot, 'x/innocuous')
  const d = await R.add(comp, 'owner', owner, { source: rules.slug, path: '보안/비밀.md', slot: 'y/innocuous', keepExt: true })
  assert.equal(d.slot, 'y/innocuous.md')
  const e = await R.add(comp, 'owner', owner, { source: rules.slug, path: '보안/비밀.md', slot: 'z/메모.txt' })
  assert.equal(e.slot, 'z/메모.txt')
  try {
    // the mate cannot read 규정집: nothing of its names reaches them, their agent or its note
    const seen = JSON.stringify([await R.list(comp, mate), await R.agentView(comp, mate), await R.hint({ mode: 'ref', folder_id: comp.id, slug: comp.slug }, mate)])
    for (const x of [rules.name, '비밀', '보안', '인사']) assert.ok(!seen.includes(x), x)
    // a file slot without the extension still reads, for a reader of the source
    assert.equal((await R.resolve(comp, 'x/innocuous', owner)).path, '보안/비밀.md')
  } finally { for (const x of [a, b, c, d, e]) await R.remove(comp, 'owner', owner, x.id) }
})

test('RF-U-19 원본 경로 끝의 「/」: 하위 폴더 · 파일로 그대로 읽힌다(맞춘 경로로 저장)', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  const a = await R.add(comp, 'owner', owner, { source: sales.slug, path: '안내/', slot: 's1' })
  const b = await R.add(comp, 'owner', owner, { source: sales.slug, path: '/가격표.xlsx/', slot: 's2.xlsx' })
  try {
    assert.equal(a.type, 'dir'); assert.equal(a.from.path, '안내')
    assert.equal(b.type, 'file'); assert.equal(b.from.path, '가격표.xlsx')
    const [row] = await q('select source_path from pro_folder_refs where id=$1', [a.id])
    assert.equal(row.source_path, '안내')
    assert.ok((await R.treeRows(comp, owner)).some((f) => f.path === 's1/소개.md'))
  } finally { await R.remove(comp, 'owner', owner, a.id); await R.remove(comp, 'owner', owner, b.id) }
})

test('RF-U-20 main 의 작업 트리에서 자리에 놓인 파일은 다른 저장이 커밋해도 담기지 않고, 지워지지 않고 보관 자리로 옮겨진다', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  const fake = path.join(comp.repo_path, '폴더1', 'fake.md')
  await fs.mkdir(path.dirname(fake), { recursive: true })
  await fs.writeFile(fake, 'FAKE')
  try {
    await S.upload(comp, owner, '옆/other.md', enc('다른 파일'))
    const files = (await G.lsTree(comp.repo_path, 'main')).map((f) => f.path)
    assert.ok(files.includes('옆/other.md'))
    assert.ok(!files.includes('폴더1/fake.md'))
    const kept = path.join(comp.repo_path, '.slot-leftover')
    const stamps = await fs.readdir(kept)
    assert.ok(stamps.some((x) => fsSync.existsSync(path.join(kept, x, '폴더1', 'fake.md'))))
    assert.equal(await fs.stat(fake).catch(() => null), null)
    assert.equal((await R.resolve(comp, '폴더1/가격 정책.docx', owner)).state, 'ok')
  } finally {
    await fs.rm(path.join(comp.repo_path, '폴더1'), { recursive: true, force: true })
    await fs.rm(path.join(comp.repo_path, '.slot-leftover'), { recursive: true, force: true })
  }
})

test('RF-U-21 자리를 확인하지 못하면(데이터베이스 오류) 커밋하지 않는다 — 알아들을 말과 함께', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  const keep = R.guardDeps.q
  R.guardDeps.q = async () => { throw Object.assign(new Error('terminating connection'), { code: '57P01' }) }
  try {
    await assert.rejects(S.upload(comp, owner, '옆/other2.md', enc('x')), (e) => e.status === 503 && /참조/.test(e.message))
  } finally { R.guardDeps.q = keep }
  assert.ok(!(await G.lsTree(comp.repo_path, 'main')).some((f) => f.path === '옆/other2.md'))
  await fs.rm(path.join(comp.repo_path, '옆', 'other2.md'), { force: true })
})

test('RF-U-22 자리 쓰기는 지우지 않는다 · 열린 변형에 그 경로가 있으면 그 자리에 참조를 더하지 않는다', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  const [th] = await q(`insert into pro_threads (user_id, kind, title) values ($1,'chat','남겨 두기') returning id`, [owner.id])
  const v = await S.createVariation(comp, { title: '동료의 변형', kind: 'chat', holder: { type: 'user', id: owner.id, name: owner.name }, source: { thread_id: th.id } })
  const dir = path.join(ROOT, 'keep', v.id)
  await S.checkout(comp, v, dir)
  try {
    await fs.mkdir(path.join(dir, 'a'), { recursive: true })
    await fs.writeFile(path.join(dir, 'a', 'notes.md'), '아직 저장하지 않은 메모')
    await assert.rejects(R.add(comp, 'owner', owner, { source: sales.slug, slot: 'a' }), (e) => e.status === 409 && e.message.includes('동료의 변형'))
    await fs.mkdir(path.join(dir, '폴더1'), { recursive: true })
    await fs.writeFile(path.join(dir, '폴더1', 'x.md'), '에이전트가 쓴 것')
    await S.commitVariation(comp, await S.variationById(v.id), { name: 'agent', email: 'agent@example.test' }, '작업')
    const files = (await G.lsTree(comp.repo_path, v.branch)).map((f) => f.path)
    assert.ok(files.includes('a/notes.md'))
    assert.ok(!files.includes('폴더1/x.md'))
    assert.equal(await fs.readFile(path.join(dir, '폴더1', 'x.md'), 'utf8'), '에이전트가 쓴 것')
    const [note] = await q(`select content from pro_messages where thread_id=$1 and kind='chip'`, [th.id])
    assert.ok(note.content.text.includes('지우지 않았어요'))
  } finally { await S.release(comp, await S.variationById(v.id)) }
})

test('RF-U-23 자리를 만든 뒤 서버 밖에서 들어온 커밋(내 PC · push)이 자리 경로에 파일을 넣어도 자리가 이긴다 — 가려진 파일 수를 알린다', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  await fs.mkdir(path.join(comp.repo_path, '폴더1'), { recursive: true })
  await fs.writeFile(path.join(comp.repo_path, '폴더1', '몰래.md'), '나중에 들어온 파일')
  await G.git(comp.repo_path, ['add', '--', '폴더1/몰래.md'])
  await G.git(comp.repo_path, [...G.who('pc', 'pc@example.test'), 'commit', '-q', '-m', '내 PC 에서 반영'])
  await reindex(await S.folderById(comp.id), { cards: false })
  try {
    const ok = await R.resolve(comp, '폴더1/가격 정책.docx', owner)
    assert.equal(ok.state, 'ok')
    const one = (await R.list(comp, owner)).find((x) => x.slot === '폴더1')
    assert.equal(one.state, 'ok'); assert.equal(one.hidden, 1)
    assert.ok(!(await R.ownRows(comp, await S.tree(comp))).some((f) => f.path === '폴더1/몰래.md'))
    await assert.rejects(R.assertWritable(comp, '폴더1/몰래.md'), (e) => e.status === 409)
  } finally {
    await G.git(comp.repo_path, ['rm', '-q', '--', '폴더1/몰래.md'])
    await G.git(comp.repo_path, [...G.who('pc', 'pc@example.test'), 'commit', '-q', '-m', '되돌림'])
    await reindex(await S.folderById(comp.id), { cards: false })
  }
})

test('RF-U-24 성능: 원본마다 한 번 · 동시에 넷까지 · 목록에 상한(더 있음 표시) · 폴더 찾기에서는 자리 상태를 세지 않는다', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  // at most four at once
  let now = 0, top = 0
  await R.eachLimit([...Array(12).keys()], 4, async () => { now++; top = Math.max(top, now); await new Promise((r) => setTimeout(r, 5)); now-- })
  assert.equal(top, 4)
  // twenty slots of one source: a constant number of git runs, not one per slot
  const made = []
  for (let i = 0; i < 20; i++) made.push(await R.add(comp, 'owner', owner, { source: sales.slug, path: '안내', slot: `묶음/${i}` }))
  try {
    const before = G.stats.spawns
    await R.list(comp, owner)
    // (two sources in this folder: a head and a cat-file each — not one per slot)
    assert.ok(G.stats.spawns - before <= 6, `git runs: ${G.stats.spawns - before}`)
    // caps, with what is left said
    const rows = await R.treeRows(comp, owner, { slotMax: 1, totalMax: 3 })
    assert.equal(rows.length, 3)
    const one = (await R.list(comp, owner)).find((x) => x.slot === '폴더1')
    assert.ok(one.count >= 3)
    const av = await R.agentView(comp, owner, { totalMax: 2 })
    assert.equal(av.files.length, 2); assert.ok(av.more > 0)
  } finally { for (const x of made) await R.remove(comp, 'owner', owner, x.id) }
  // the catalog a folder is found by carries no slot states; the agent's catalog does
  const { catalog } = await import('../lib/folders/indexer.js')
  assert.equal((await catalog(owner.id, '')).find((f) => f.slug === comp.slug).refs, undefined)
  assert.ok((await catalog(owner.id, '', { refs: true })).find((f) => f.slug === comp.slug).refs.length > 0)
})

test('RF-U-25 자잘한 것: 자리로 연 파일 카드는 읽기 전용 · 접근 요청의 하루 한 번은 동시에도 · 500 은 내부 글을 내보내지 않음 · 폴더를 지우면 기록도 · 트리거의 search_path', { skip: !db && 'no database' }, async () => {
  const { rules, comp } = await world()
  const { callTool } = await import('../mcp/folders.js')
  const open = JSON.parse((await callTool(owner, 'folder_open', { folder: comp.slug, path: '가격표.xlsx' })).content[0].text)
  assert.equal(open.folder_ref.editable, false)
  const r = await R.add(comp, 'owner', owner, { source: rules.slug, path: '인사', slot: '동시' })
  await Promise.all([R.requestAccess(comp, mate, r.id), R.requestAccess(comp, mate, r.id), R.requestAccess(comp, mate, r.id)])
  const [{ n }] = await q(`select count(*)::int as n from pro_folder_ref_events where ref_id=$1 and kind='access_requested'`, [r.id])
  assert.equal(n, 1)
  assert.deepEqual(R.answerOf(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' })), { status: 500, body: { error: R.answerOf({}).body.error } })
  assert.ok(!R.answerOf(new Error('relation "x" does not exist')).body.error.includes('relation'))
  assert.deepEqual(R.answerOf(Object.assign(new Error('잠겼어요'), { status: 403, code: 'ref_locked' })), { status: 403, body: { error: '잠겼어요', code: 'ref_locked' } })
  // a folder that goes takes its reference records with it
  const gone = await S.createFolder(owner, { name: `곧 지울 구성 ${crypto.randomBytes(2).toString('hex')}` })
  const g1 = await R.add(gone, 'owner', owner, { source: rules.slug, slot: '잠깐' })
  await q('delete from pro_folders where id=$1', [gone.id])
  assert.equal((await q('select count(*)::int as n from pro_folder_ref_events where folder_id=$1', [gone.id]))[0].n, 0)
  assert.ok(g1.id)
  const [fn] = await q(`select proconfig from pg_proc where proname='pro_folder_refs_same_tenant'`)
  assert.ok((fn.proconfig || []).some((x) => x.startsWith('search_path=')))
  await R.remove(comp, 'owner', owner, r.id)
})

// ---------- second review of PR #92 (each written first against 9a23dc1, before its fix) ----------
const commitOutside = async (repo, rel, body) => {
  await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true })
  await fs.writeFile(path.join(repo, rel), body)
  await G.git(repo, ['add', '--', rel])
  await G.git(repo, [...G.who('pc', 'pc@example.test'), 'commit', '-q', '-m', '서버 밖의 커밋'])
}
const statusOf = async (repo) => (await G.git(repo, ['status', '--porcelain', '--untracked-files=all'])).trim()

test('RF-U-26 자리의 부모가 링크여도 다른 저장은 커밋된다(링크 너머의 경로는 빼는 목록에서 뺀다)', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  const r = await R.add(comp, 'owner', owner, { source: sales.slug, path: '안내', slot: 'p/q' })
  const outside = await fs.mkdtemp(path.join(ROOT, 'link-target-'))
  await fs.symlink(outside, path.join(comp.repo_path, 'p'))
  try {
    await S.upload(comp, owner, '옆/after-link.md', enc('링크 뒤의 저장'))
    assert.ok((await G.lsTree(comp.repo_path, 'main')).some((f) => f.path === '옆/after-link.md'))
    assert.deepEqual(await fs.readdir(outside), [])
  } finally {
    await fs.rm(path.join(comp.repo_path, 'p'), { force: true })
    await R.remove(comp, 'owner', owner, r.id)
  }
})

test('RF-U-27 변형의 커밋에서 자리를 확인하지 못하면 거절이 그대로 올라가고, 변형은 「반영 대기」가 되지 않으며 작업은 남는다', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  const v = await S.createVariation(comp, { title: '확인 못 함', kind: 'person', holder: { type: 'user', id: owner.id, name: owner.name } })
  const dir = path.join(ROOT, 'unchecked', v.id)
  await S.checkout(comp, v, dir)
  await fs.writeFile(path.join(dir, 'mine.md'), '아직 담지 못한 작업')
  const keep = R.guardDeps.q
  R.guardDeps.q = async () => { throw Object.assign(new Error('terminating connection'), { code: '57P01' }) }
  try {
    await assert.rejects(S.commitVariation(comp, await S.variationById(v.id), { name: 'o', email: 'o@example.test' }, '작업'), (e) => e.code === 'ref_unchecked' && e.status === 503)
  } finally { R.guardDeps.q = keep }
  try {
    assert.equal((await S.variationById(v.id)).status, 'open')
    assert.ok(!(await G.lsTree(comp.repo_path, `refs/heads/${v.branch}`)).some((f) => f.path === 'mine.md'))
    assert.equal(await fs.readFile(path.join(dir, 'mine.md'), 'utf8'), '아직 담지 못한 작업')
  } finally { await S.release(comp, await S.variationById(v.id)) }
})

test('RF-U-28 main 의 자리에 놓인 파일은 보관 자리(.slot-leftover)로 옮겨 main 을 깨끗이 두고 편집자에게 한 번 알린다 · 자리를 뺄 때도 먼저 옮긴다', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  const r = await R.add(comp, 'owner', owner, { source: sales.slug, path: '안내', slot: '남김' })
  await commitOutside(comp.repo_path, '남김/own.md', '서버 밖에서 들어온 원래 내용')
  await fs.writeFile(path.join(comp.repo_path, '남김', 'own.md'), '제자리에서 고친 내용')
  await fs.writeFile(path.join(comp.repo_path, '남김', 'fake.md'), '셸로 놓은 파일')
  const before = new Date()
  await S.upload(comp, owner, '옆/clean.md', enc('다른 저장'))
  assert.equal((await G.show(comp.repo_path, 'main', '남김/own.md')).toString(), '서버 밖에서 들어온 원래 내용')
  assert.ok(!(await G.lsTree(comp.repo_path, 'main')).some((f) => f.path === '남김/fake.md'))
  assert.equal(await statusOf(comp.repo_path), '')
  const kept = path.join(comp.repo_path, '.slot-leftover')
  const stamp = (await fs.readdir(kept)).find((x) => fsSync.existsSync(path.join(kept, x, '남김')))
  assert.equal(await fs.readFile(path.join(kept, stamp, '남김', 'fake.md'), 'utf8'), '셸로 놓은 파일')
  assert.equal(await fs.readFile(path.join(kept, stamp, '남김', 'own.md'), 'utf8'), '제자리에서 고친 내용')
  // (the editors' notice is checked where the company has its row — RF-E-06; this tenant has none, so it is not written here)
  void before
  // removing a slot moves what lies there first: the next commit sweeps nothing in
  await fs.writeFile(path.join(comp.repo_path, '남김', 'late.md'), '자리를 빼기 직전에 놓인 파일')
  await R.remove(comp, 'owner', owner, r.id)
  await S.upload(comp, owner, '옆/after-remove.md', enc('뺀 뒤의 저장'))
  assert.ok(!(await G.lsTree(comp.repo_path, 'main')).some((f) => f.path === '남김/late.md'))
  assert.equal(await statusOf(comp.repo_path), '')
  const stamps = await fs.readdir(kept)
  assert.ok(stamps.some((s) => fsSync.existsSync(path.join(kept, s, '남김', 'late.md'))))
  await G.git(comp.repo_path, ['rm', '-q', '-r', '--', '남김'])
  await G.git(comp.repo_path, [...G.who('t', 't@example.test'), 'commit', '-q', '-m', '정리'])
  await fs.rm(kept, { recursive: true, force: true })
})

test('RF-U-29 가려진 파일은 채팅 안내 · 폴더 정리 판단 · 회의 자료 후보에도 나오지 않는다', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  await commitOutside(comp.repo_path, '폴더1/숨김-자료.md', '가려질 파일')
  await reindex(await S.folderById(comp.id), { cards: false })
  try {
    const TF = await import('../lib/folders/threadFolders.js')
    const hint = await TF.refHint({ mode: 'ref', folder_id: comp.id, slug: comp.slug, name: comp.name }, owner)
    assert.ok(!hint.includes('숨김-자료'))
    const FI = await import('../lib/folders/filing.js')
    const [desc] = await FI.describeFolders([await S.folderById(comp.id)])
    assert.ok(!JSON.stringify(desc).includes('숨김-자료'))
    const MM = await import('../lib/meetings/materials.js')
    const cands = await MM.candidates('folder', { speaker: owner })
    assert.ok(!cands.some((c) => String(c.ref?.path || '').includes('숨김-자료')))
  } finally {
    await G.git(comp.repo_path, ['rm', '-q', '--', '폴더1/숨김-자료.md'])
    await G.git(comp.repo_path, [...G.who('t', 't@example.test'), 'commit', '-q', '-m', '정리'])
    await reindex(await S.folderById(comp.id), { cards: false })
  }
})

test('RF-U-30 유니코드 정규화: Mac 의 NFD 경로도 NFC 자리와 같은 자리로 읽고 막는다 · 자리는 NFC 로 저장한다', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  const nfc = 'éclair'.normalize('NFC'), nfd = nfc.normalize('NFD')
  assert.notEqual(nfc, nfd)
  const r = await R.add(comp, 'owner', owner, { source: sales.slug, slot: nfd })
  try {
    assert.equal(r.slot, nfc)
    assert.ok(R.underSlot([nfc], `${nfd}/x.md`))
    await assert.rejects(R.assertWritable(comp, `${nfd}/x.md`), (e) => e.status === 409)
    const res = await R.resolve(comp, `${nfd}/가격 정책.docx`, owner)
    assert.equal(res?.state, 'ok'); assert.equal(res.path, '가격 정책.docx')
  } finally { await R.remove(comp, 'owner', owner, r.id) }
})

test('RF-U-31 접근 요청의 「하루」는 회사의 날짜(기본 Asia/Seoul)로 센다', () => {
  assert.equal(R.dayOf(new Date('2026-11-26T16:30:00Z')), '2026-11-27')
  assert.equal(R.dayOf(new Date('2026-11-26T14:59:00Z')), '2026-11-26')
})

// ---------- follow-up of PR #92 (each written first against ce72e8d, before its fix) ----------
test('RF-U-32 제자리에서 고친 main 의 파일은 먼저 통째로 옮긴 뒤 main 의 내용으로 되돌린다 — 쓰던 셸이 끝까지 쓴 내용이 보관 자리에 남는다', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  const r = await R.add(comp, 'owner', owner, { source: sales.slug, path: '안내', slot: '쓰는중' })
  await commitOutside(comp.repo_path, '쓰는중/log.md', '원래 내용\n')
  const host = path.join(comp.repo_path, '쓰는중', 'log.md')
  const fh = await fs.open(host, 'w')
  try {
    await fh.write('셸이 쓰는 첫 줄\n')
    await S.upload(comp, owner, '옆/while-writing.md', enc('다른 저장'))
    await fh.write('셸이 이어 쓴 끝 줄\n')
  } finally { await fh.close() }
  try {
    assert.equal(await fs.readFile(host, 'utf8'), '원래 내용\n')
    const kept = path.join(comp.repo_path, '.slot-leftover')
    const stamp = (await fs.readdir(kept)).find((x) => fsSync.existsSync(path.join(kept, x, '쓰는중', 'log.md')))
    assert.equal(await fs.readFile(path.join(kept, stamp, '쓰는중', 'log.md'), 'utf8'), '셸이 쓰는 첫 줄\n셸이 이어 쓴 끝 줄\n')
  } finally {
    await R.remove(comp, 'owner', owner, r.id)
    await G.git(comp.repo_path, ['rm', '-q', '-r', '--', '쓰는중'])
    await G.git(comp.repo_path, [...G.who('t', 't@example.test'), 'commit', '-q', '-m', '정리'])
    await fs.rm(path.join(comp.repo_path, '.slot-leftover'), { recursive: true, force: true })
  }
})

test('RF-U-33 두 정리가 동시에 돌아도 실패하지 않는다 — 이미 옮겨진 파일은 건너뛰고, 파일은 한 곳에만 있다', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  const r = await R.add(comp, 'owner', owner, { source: sales.slug, path: '안내', slot: '동시정리' })
  const names = [...Array(40).keys()].map((i) => `f${i}.md`)
  await fs.mkdir(path.join(comp.repo_path, '동시정리'), { recursive: true })
  for (const n of names) await fs.writeFile(path.join(comp.repo_path, '동시정리', n), n)
  try {
    const both = await Promise.allSettled([R.sweepLeftovers(comp, ['동시정리']), R.sweepLeftovers(comp, ['동시정리'])])
    assert.deepEqual(both.map((x) => x.status), ['fulfilled', 'fulfilled'], JSON.stringify(both.map((x) => x.reason?.message)))
    const kept = path.join(comp.repo_path, '.slot-leftover')
    const found = []
    for (const s of await fs.readdir(kept)) for (const n of await fs.readdir(path.join(kept, s, '동시정리')).catch(() => [])) found.push(n)
    assert.deepEqual(found.sort(), [...names].sort())
    assert.deepEqual(await fs.readdir(path.join(comp.repo_path, '동시정리')).catch(() => []), [])
  } finally {
    await R.remove(comp, 'owner', owner, r.id)
    await fs.rm(path.join(comp.repo_path, '동시정리'), { recursive: true, force: true })
    await fs.rm(path.join(comp.repo_path, '.slot-leftover'), { recursive: true, force: true })
  }
})

test('RF-U-34 변형의 「담지 않았어요」 칩은 파일마다 한 번 — 같은 파일이 남아 있는 다음 커밋에는 다시 올리지 않는다', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  const [th] = await q(`insert into pro_threads (user_id, kind, title) values ($1,'chat','칩 한 번') returning id`, [owner.id])
  const v = await S.createVariation(comp, { title: '칩 한 번', kind: 'chat', holder: { type: 'user', id: owner.id, name: owner.name }, source: { thread_id: th.id } })
  const dir = path.join(ROOT, 'chip-once', v.id)
  await S.checkout(comp, v, dir)
  try {
    await fs.mkdir(path.join(dir, '폴더1'), { recursive: true })
    await fs.writeFile(path.join(dir, '폴더1', 'a.md'), 'a')
    const commit = async (name) => { await fs.writeFile(path.join(dir, name), name); await S.commitVariation(comp, await S.variationById(v.id), { name: 'agent', email: 'agent@example.test' }, name) }
    await commit('one.md')
    await commit('two.md')
    let chips = await q(`select content from pro_messages where thread_id=$1 and kind='chip' order by created_at`, [th.id])
    assert.equal(chips.length, 1)
    await fs.writeFile(path.join(dir, '폴더1', 'b.md'), 'b')
    await commit('three.md')
    chips = await q(`select content from pro_messages where thread_id=$1 and kind='chip' order by created_at`, [th.id])
    assert.equal(chips.length, 2)
    assert.deepEqual(chips[1].content.refsReadOnly, ['폴더1/b.md'])
  } finally { await S.release(comp, await S.variationById(v.id)) }
})

test('RF-U-35 「이 폴더의 파일 N개를 가림」은 NFD 경로도 센다', { skip: !db && 'no database' }, async () => {
  const { sales, comp } = await world()
  const nfc = 'résumé'.normalize('NFC'), nfd = nfc.normalize('NFD')
  const r = await R.add(comp, 'owner', owner, { source: sales.slug, slot: nfc })
  await q(`insert into pro_folder_files (folder_id, path, kind, size) values ($1,$2,'md',1)`, [comp.id, `${nfd}/nfd.md`])
  try {
    assert.equal((await R.list(comp, owner)).find((x) => x.id === r.id).hidden, 1)
  } finally {
    await q('delete from pro_folder_files where folder_id=$1 and path=$2', [comp.id, `${nfd}/nfd.md`])
    await R.remove(comp, 'owner', owner, r.id)
  }
})

test('RF-U-36 보관 자리는 30일이 지나면 비운다(커밋할 때) · 알림이 그렇게 말한다', { skip: !db && 'no database' }, async () => {
  const { comp } = await world()
  const kept = path.join(comp.repo_path, '.slot-leftover')
  const old = '2025-01-01T00-00-00-000Z'
  const fresh = new Date(Date.now() - 2 * 86400_000).toISOString().replace(/[:.]/g, '-')
  for (const s of [old, fresh]) { await fs.mkdir(path.join(kept, s, '폴더1'), { recursive: true }); await fs.writeFile(path.join(kept, s, '폴더1', 'x.md'), s) }
  try {
    await S.upload(comp, owner, '옆/expire.md', enc('커밋 하나'))
    const left = await fs.readdir(kept)
    assert.ok(!left.includes(old), 'the old one is gone')
    assert.ok(left.includes(fresh), 'the recent one stays')
    const n = R.leftoverNotice(comp, ['폴더1/x.md'], fresh)
    assert.ok(n.description.includes('30일'))
  } finally { await fs.rm(kept, { recursive: true, force: true }) }
})
