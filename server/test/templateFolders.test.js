// Template folders (spec openspec/specs/template-folders, lib/folders/templates.js): a folder marked as a template; a project started from
// it works in its own workspace (a variation no one else sees, from the template's main at the start); outputs stay there; 「원본에 반영 요청」
// sends only the template files it fixed, as an ordinary variation of the template on its current main, which the owner merges; the next
// project starts from the improved main and sees nothing of the first.
//   TF-U-01 ~ 02  pure: TEMPLATE.md, the outputs folder, who sees a workspace
//   TF-U-03 ~ 10  with the local database and real git (made-up people 정하윤 · 김서연 · 박도윤, company 에이스정밀)
// Run: node --test test/templateFolders.test.js  (folders in a temporary directory, rows in the tenant "template-folders-test", all removed
// afterwards — the workspace's room in storage too)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-templates-'))
const TENANT = 'template-folders-test'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:9/v1'
process.env.PRO_TENANT_HOSTS = ''
const TPL = await import('../lib/folders/templates.js')

// ---------- pure ----------
test('TF-U-01 TEMPLATE.md: 머리말의 description · outputs, 없으면 본문 첫 줄과 「산출물」, 바깥으로 나가는 경로는 기본값', () => {
  const a = TPL.parseTemplateFile('---\ndescription: 제안서를 쓸 때 시작해요\noutputs: 결과/제안/\n---\n# 제안서 템플릿\n')
  assert.deepEqual(a, { description: '제안서를 쓸 때 시작해요', outputs: '결과/제안' })
  assert.deepEqual(TPL.parseTemplateFile('# 템플릿\n\n견적서를 만들 때 써요.\n'), { description: '견적서를 만들 때 써요.', outputs: '산출물' })
  assert.deepEqual(TPL.parseTemplateFile('---\ndescription: >\n  두 줄로\n  적은 설명\n---\n'), { description: '두 줄로 적은 설명', outputs: '산출물' })
  for (const bad of ['../밖', '.git/x', '', '/']) assert.equal(TPL.outputsOf(bad), '산출물', bad)
  assert.equal(TPL.outputsOf('./out'), 'out')
})
test('TF-U-02 작업 공간은 그 프로젝트의 사람만 본다 · 일반 변형은 누구나', () => {
  const ws = { source: { template: { commit: 'x' } }, holder_type: 'user', holder_id: 'u1' }
  assert.ok(TPL.isWorkspace(ws))
  assert.ok(TPL.mayView(ws, { id: 'u1' }))
  assert.ok(!TPL.mayView(ws, { id: 'u2' }))
  assert.ok(!TPL.mayView(ws, null))
  assert.ok(TPL.mayView({ source: {} }, { id: 'u2' }))
  assert.ok(!TPL.isTemplate({ kind: 'linked', settings: { template: {} } }), '연결형은 템플릿이 아님')
  assert.ok(TPL.isTemplate({ kind: 'managed', settings: { template: { at: 'now' } } }))
})

// ---------- with the database ----------
const { q, pool, admin } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const db = await q('select 1 from pro_folder_refs limit 1').then(() => true).catch(() => false)
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const M = await import('../lib/folders/merge.js')
const REFS = await import('../lib/folders/refs.js')
const TF = await import('../lib/folders/threadFolders.js')
const { reindex } = await import('../lib/folders/indexer.js')
const ha = { id: crypto.randomUUID(), name: '정하윤', email: 'tpl-ha@example.test' }   // owns the template and the two folders it references
const ks = { id: crypto.randomUUID(), name: '김서연', email: 'tpl-ks@example.test' }   // a runner of the template, viewer of the two sources
const pd = { id: crypto.randomUUID(), name: '박도윤', email: 'tpl-pd@example.test' }   // the same, the next project
const rooms = []
after(async () => {
  if (db) {
    const ids = [ha.id, ks.id, pd.id]
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id = any($1::uuid[]))', [ids]).catch(() => {})
    await q('delete from pro_thread_folders where thread_id in (select id from pro_threads where user_id = any($1::uuid[]))', [ids]).catch(() => {})
    await q('delete from pro_threads where user_id = any($1::uuid[])', [ids]).catch(() => {})
    await q('delete from pro_folder_ref_events where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from pro_folders where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from tenants where id=$1', [TENANT]).catch(() => {})
    for (const room of rooms) {
      const keys = (await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`skills/${TENANT}/${room}/`]).catch(() => [])).map((r) => r.name)
      if (keys.length) await admin.storage.from('files').remove(keys).catch(() => {})
    }
    await fs.rm(S.workspaceDir(), { recursive: true, force: true }).catch(() => {})
  }
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
})
const enc = (s) => Buffer.from(s)
const put = async (f, who, p, body) => { await S.upload(f, who, p, enc(body)); await reindex(await S.folderById(f.id), { cards: false }) }
const OLD = '- 주소: 서울시 구로구 디지털로 26길 5'
const NEW = '- 주소: 서울시 금천구 가산디지털1로 168, 7층'
const FORM = `# 제안서 양식\n\n- 제안사: 우리 회사\n${OLD}\n\n## 1. 회사 소개\n\n## 2. 비슷한 납품 실적\n\n## 3. 제안 범위와 일정\n`
let intro, record, tpl, threadK, wsK, workK, reqV

test('TF-U-03 준비: 원본 두 폴더 · 템플릿(양식 · 스킬 · TEMPLATE.md · 참조 자리 둘) · 구성원', { skip: !db }, async () => {
  // (the owner's notice needs this company's row — lib/tenant.js)
  const { ensureTenantRow } = await import('../lib/tenant.js')
  await ensureTenantRow(TENANT).catch(() => {})
  intro = await S.createFolder(ha, { name: '회사 소개 자료' })
  record = await S.createFolder(ha, { name: '납품 실적' })
  tpl = await S.createFolder(ha, { name: '제안서 템플릿' })
  await put(intro, ha, '회사 개요.md', '# 회사 개요\n\n- 제조 고객사 42곳이 써요.\n')
  await put(record, ha, '2026 납품 실적.md', '# 2026 납품 실적\n\n- 한빛기계 — 설비 120대 연결\n')
  await put(tpl, ha, '제안서 양식.md', FORM)
  await put(tpl, ha, '.claude/skills/proposal-writer/SKILL.md', '---\nname: proposal-writer\ndescription: 제안서 초안을 써요\n---\n1. 참조에서 사실만\n')
  await put(tpl, ha, 'TEMPLATE.md', '---\ndescription: 제안서를 쓸 때 시작하는 템플릿\noutputs: 산출물/\n---\n')
  tpl = await S.folderById(tpl.id)
  await REFS.add(tpl, 'owner', ha, { source: intro.slug, label: '회사 소개 자료' })
  await REFS.add(tpl, 'owner', ha, { source: record.slug, label: '납품 실적' })
  for (const who of [ks, pd]) {
    await S.setMember(tpl, ha, { id: who.id, role: 'runner' })
    for (const f of [intro, record]) await S.setMember(f, ha, { id: who.id, role: 'viewer' })
  }
  assert.equal((await REFS.list(tpl, ks)).filter((r) => r.state === 'ok').length, 2)
})

test('TF-U-04 템플릿 지정: 소유자의 설정 · TEMPLATE.md 의 설명과 결과물 자리 · 일반 폴더는 null', { skip: !db }, async () => {
  assert.equal(await TPL.infoOf(tpl), null, '지정 전에는 템플릿이 아님')
  await TPL.setTemplate(tpl, ha, true)
  tpl = await S.folderById(tpl.id)
  const info = await TPL.infoOf(tpl)
  assert.equal(info.description, '제안서를 쓸 때 시작하는 템플릿')
  assert.equal(info.outputs, '산출물')
  assert.equal(info.file, true)
  await assert.rejects(TPL.startProject(ks, intro, { title: 'x' }), /템플릿으로 지정된 폴더/)
})

test('TF-U-05 템플릿으로 시작: 프로젝트 + 전용 작업 공간(지금 main 에서) — 폴더 목록 · 변형 목록 · 다른 사람에게 없음', { skip: !db }, async () => {
  const main = await G.head(tpl.repo_path, 'main')
  threadK = await TPL.startProject(ks, tpl, { title: '에이스정밀 3분기 제안' })
  const pay = await TF.folderPayload(threadK.id)
  assert.equal(pay.mode, 'project')
  assert.equal(pay.template.name, '제안서 템플릿')
  assert.equal(pay.template.outputs, '산출물')
  assert.match(pay.variation.branch, /^var\/t\//)
  wsK = await S.variationById(pay.variation.id)
  assert.equal(wsK.source.template.commit, main, '시작 커밋을 적어 둠')
  assert.equal(wsK.status, 'ready')
  assert.equal(wsK.holder_id, ks.id)
  // in no list of the template, on no card; only its person may read it
  assert.ok(!(await S.variations(tpl)).some((v) => v.id === wsK.id))
  const card = (await S.listFolders(ha)).find((f) => f.id === tpl.id)
  assert.equal(card.live, 0)
  assert.ok(!(card.activity?.text || '').includes('에이스정밀'))
  assert.equal((await S.variationFor(tpl, wsK.id, ks)).id, wsK.id)
  await assert.rejects(S.variationFor(tpl, wsK.id, ha), (e) => e.status === 404, '템플릿 주인에게도 없음')
  await assert.rejects(S.assertRefVisible(tpl, wsK.id, pd), (e) => e.status === 404)
  // the folders list has no folder for the project
  assert.ok(!(await S.listFolders(ks)).some((f) => f.name.includes('에이스정밀')))
  // the workroom of its checkout: its person only
  const { folderRoomAccess } = await import('../lib/folders/rooms.js')
  const room = { folder: tpl.id, need: 'runner', workspaceOf: { holder_type: 'user', holder_id: ks.id, source: { template: true } } }
  assert.ok(await folderRoomAccess(ks, room))
  assert.ok(!(await folderRoomAccess(pd, room)))
})

test('TF-U-06 프로젝트 턴: 에이전트에게 작업 공간 · 결과물 자리 · 참조 자리를 알리고, 결과물과 양식 고침은 작업 공간에만', { skip: !db }, async () => {
  workK = await TF.prepareProjectWork({ user: ks, thread: threadK })
  rooms.push(workK.conv)
  assert.equal(workK.v.id, wsK.id)
  assert.match(workK.note, /템플릿 '제안서 템플릿' 에서 시작했어요/)
  assert.match(workK.note, /'산출물\/' 아래에 새 파일로/)
  assert.match(workK.note, /원본에 반영 요청/)
  assert.match(workK.note, /참조 자리/, '참조 자리를 알림(폴더 도구로 읽음)')
  assert.ok(workK.note.includes('회사 소개 자료/') && workK.note.includes('납품 실적/'))
  await fs.mkdir(path.join(workK.dir, '산출물'), { recursive: true })
  await fs.writeFile(path.join(workK.dir, '산출물', '에이스정밀 3분기 제안서 초안.md'), `# 에이스정밀 3분기 제안서 (초안)\n${OLD}\n- 제조 고객사 42곳\n`)
  await fs.writeFile(path.join(workK.dir, '제안서 양식.md'), FORM.replace(OLD, NEW))
  const before = await G.head(tpl.repo_path, 'main')
  const r = await TF.finishProjectWork(workK, { stopped: true })
  assert.deepEqual(r.changed.map((c) => c.path).sort(), ['산출물/에이스정밀 3분기 제안서 초안.md', '제안서 양식.md'])
  assert.equal(await G.head(tpl.repo_path, 'main'), before, '템플릿 main 은 그대로')
  const chip = (await q(`select content from pro_messages where thread_id=$1 and kind='chip'`, [threadK.id]))[0]
  assert.match(chip.content.text, /이 프로젝트 작업 공간에 담았어요/)
  // a slot's file read the way the agent's tools do — through the template, with 김서연's own role
  const res = await REFS.resolve(tpl, '회사 소개 자료/회사 개요.md', ks)
  assert.equal(res.state, 'ok')
  assert.match(String(await S.readBlob(res.source, res.rev, res.path)), /42곳/)
})

test('TF-U-07 작업 공간은 통째로 반영되지 않는다(일괄 반영 거절 · 템플릿 주인이라도)', { skip: !db }, async () => {
  await assert.rejects(M.start(tpl, ha, [wsK.id]), (e) => e.status === 404, '템플릿 주인에게는 없는 변형')
  await assert.rejects(M.start(tpl, ks, [wsK.id]), (e) => e.status === 409 && /통째로 반영하지 않아요/.test(e.message))
  const files = (await G.lsTree(tpl.repo_path, 'main')).map((f) => f.path)
  assert.ok(!files.some((p) => p.startsWith('산출물/')))
})

test('TF-U-08 원본에 반영 요청: 템플릿에서 온 파일만 고를 수 있고, 지금 main 위의 새 변형에는 그 파일만', { skip: !db }, async () => {
  const ws = await S.variationById(wsK.id)
  const c = await TPL.candidates(tpl, ws)
  assert.deepEqual(c.files.map((f) => `${f.change} ${f.path}`), ['M 제안서 양식.md'])
  assert.deepEqual(c.outputs.map((f) => f.path), ['산출물/에이스정밀 3분기 제안서 초안.md'])
  await assert.rejects(TPL.propose(tpl, ws, ks, { paths: ['산출물/에이스정밀 3분기 제안서 초안.md'] }), (e) => e.code === 'tpl_not_template_file')
  await assert.rejects(TPL.propose(tpl, ws, pd, { paths: ['제안서 양식.md'] }), (e) => e.status === 404, '다른 사람은 보낼 수 없음')
  // meanwhile the owner changed another part of the same form in main: the request merges both (line changes three ways)
  await put(tpl, ha, '제안서 양식.md', FORM.replace('## 3. 제안 범위와 일정', '## 3. 제안 범위 · 일정 · 금액'))
  const out = await TPL.propose(tpl, ws, ks, { paths: ['제안서 양식.md'], title: '양식 주소 고침', note: '옛 주소였어요' })
  reqV = out.variation
  assert.deepEqual(out.files, ['제안서 양식.md'])
  assert.equal(reqV.status, 'ready')
  assert.ok(!reqV.source.template, '보통 변형')
  assert.ok((await S.variations(tpl)).some((v) => v.id === reqV.id), '템플릿의 변형 목록에 보임')
  const d = await S.variationDetail(tpl, reqV)
  assert.deepEqual(d.changes.map((x) => x.path), ['제안서 양식.md'])
  const sent = String(await G.show(tpl.repo_path, reqV.branch, '제안서 양식.md'))
  assert.ok(sent.includes(NEW) && sent.includes('제안 범위 · 일정 · 금액'), sent)
  assert.ok(!(await G.lsTree(tpl.repo_path, reqV.branch)).some((f) => f.path.startsWith('산출물/')), '결과물은 따라가지 않음')
  assert.equal((await S.variationFor(tpl, reqV.id, ha)).id, reqV.id, '템플릿 주인이 열 수 있음')
  const [n] = await q(`select title, url from notifications where tenant_id=$1 and user_id=$2 and type='folder_request'`, [TENANT, ha.id])
  assert.match(n.title, /김서연님이 템플릿 「제안서 템플릿」에 반영을 요청했어요/)
  assert.equal(n.url, `/folders/${tpl.slug}/v/${reqV.id}`)
  assert.equal((await S.variationById(ws.id)).source.requests.length, 1)
  assert.equal((await TF.folderPayload(threadK.id)).template.requests, 1)
})

test('TF-U-09 같은 줄을 템플릿도 고쳤으면 보내지 않고 알린다', { skip: !db }, async () => {
  const [t2] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','충돌 시험') returning *`, [ks.id])
  await TF.linkProject(ks, t2, tpl)
  const ws2 = await S.variationById((await TF.folderPayload(t2.id)).variation.id)
  const dir = path.join(ROOT, 'ws2')
  await S.checkout(tpl, ws2, dir)
  const now = String(await S.readBlob(tpl, 'main', '제안서 양식.md'))
  await fs.writeFile(path.join(dir, '제안서 양식.md'), now.replace('- 제안사: 우리 회사', '- 제안사: 우리 회사(주)'))
  await S.commitVariation(tpl, await S.variationById(ws2.id), ks, '제안사 이름')
  await S.release(tpl, await S.variationById(ws2.id))
  await put(tpl, ha, '제안서 양식.md', now.replace('- 제안사: 우리 회사', '- 제안사: 우리 회사 주식회사'))
  await assert.rejects(TPL.propose(tpl, await S.variationById(ws2.id), ks, { paths: ['제안서 양식.md'] }), (e) => e.code === 'tpl_conflict')
  // (the form back as it was before this case)
  await put(tpl, ha, '제안서 양식.md', now)
})

test('TF-U-10 템플릿 주인이 반영 → main 이 바뀜 · 다음 프로젝트(박도윤)는 고친 main 에서, 앞 프로젝트는 보이지 않음', { skip: !db }, async () => {
  const r = await M.start(tpl, ha, [reqV.id])
  assert.equal(r.status, 'done')
  const form = String(await S.readBlob(tpl, 'main', '제안서 양식.md'))
  assert.ok(form.includes(NEW))
  assert.ok(!(await G.lsTree(tpl.repo_path, 'main')).some((f) => f.path.startsWith('산출물/')), '템플릿에 결과물 없음')
  // 새 프로젝트 with the template chosen (POST /threads): the workspace is made at once
  const [t3] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','한결테크 4분기 제안') returning *`, [pd.id])
  const pay = await TF.linkProject(pd, t3, tpl)
  assert.ok(pay.template && pay.variation, '작업 공간이 바로 생김')
  const wsP = await S.variationById(pay.variation.id)
  assert.equal(wsP.source.template.commit, await G.head(tpl.repo_path, 'main'))
  assert.ok(String(await G.show(tpl.repo_path, wsP.branch, '제안서 양식.md')).includes(NEW), '고친 양식에서 시작')
  assert.ok(!(await G.lsTree(tpl.repo_path, wsP.branch)).some((f) => f.path.startsWith('산출물/')), '앞 프로젝트의 결과물 없음')
  await assert.rejects(S.variationFor(tpl, wsK.id, pd), (e) => e.status === 404, '앞 프로젝트의 작업 공간은 없음')
  const listed = (await S.variations(tpl)).map((v) => v.id)
  assert.ok(!listed.includes(wsK.id) && !listed.includes(wsP.id))
  // the slots are the template's, read with 박도윤's own role
  assert.match(await REFS.hint({ mode: 'project', folder_id: tpl.id, slug: tpl.slug }, pd), /회사 소개 자료\/ — 원본: 「회사 소개 자료」 폴더 전체/)
})

test('TF-U-11 모델이 프로젝트 이름을 지으면 작업 공간도 그 이름 · 사람이 바꾼 이름은 그대로 · 작업 공간에는 「반영하면」 카드를 만들지 않음', { skip: !db }, async () => {
  const draft = '템플릿의 참조 자료를 읽고 한결'
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning *`, [pd.id, draft])
  await TF.linkProject(pd, t, tpl)
  const v0 = await S.variationById((await TF.folderPayload(t.id)).variation.id)
  assert.equal(v0.title, draft)
  const [named] = await q(`update pro_threads set title='한결테크 4분기 제안' where id=$1 returning *`, [t.id])
  assert.equal(await TF.retitleProject(named, draft), 1)
  const v1 = await S.variationById(v0.id)
  assert.equal(v1.title, '한결테크 4분기 제안')
  assert.match(v1.source.label, /「한결테크 4분기 제안」/)
  assert.equal(v1.source.template.commit, v0.source.template.commit, '다른 기록은 그대로')
  await q('update pro_folder_variations set title=$2 where id=$1', [v0.id, '내가 지은 이름'])
  assert.equal(await TF.retitleProject({ ...named, title: '또 다른 이름' }, '한결테크 4분기 제안'), 0)
  // the workspace's turn leaves no change card (its 「반영하면 …」 would mislead)
  const w = await TF.prepareProjectWork({ user: pd, thread: t })
  rooms.push(w.conv)
  await fs.mkdir(path.join(w.dir, '산출물'), { recursive: true })
  await fs.writeFile(path.join(w.dir, '산출물', '메모.md'), '# 메모\n')
  const r = await TF.finishProjectWork(w, { stopped: true })
  assert.equal(r.changed.length, 1)
  await new Promise((ok) => setTimeout(ok, 300))
  assert.equal((await S.variationById(v0.id)).change_card, null)
})
