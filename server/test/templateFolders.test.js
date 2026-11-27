// Template folders (spec openspec/specs/template-folders, lib/folders/templates.js): a folder marked as a template; a project started from
// it works in its own workspace (a variation no one else sees, from the template's main at the start); outputs stay there; 「원본에 반영 요청」
// sends only the template files it fixed, as an ordinary variation of the template on its current main, which the owner merges; the next
// project starts from the improved main and sees nothing of the first.
//   TF-U-01 ~ 02  pure: TEMPLATE.md, the outputs folder, who sees a workspace
//   TF-U-03 ~ 10  with the local database and real git (made-up people 정하윤 · 김서연 · 박도윤, company 가나정밀)
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
const OLD = '- 주소: 예시시 가람구 옛길로 5'
const NEW = '- 주소: 예시시 나래구 새길로 7, 3층'
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
  await put(record, ha, '2026 납품 실적.md', '# 2026 납품 실적\n\n- 마바기계 — 설비 120대 연결\n')
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
  threadK = await TPL.startProject(ks, tpl, { title: '가나정밀 3분기 제안' })
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
  assert.ok(!(card.activity?.text || '').includes('가나정밀'))
  assert.equal((await S.variationFor(tpl, wsK.id, ks)).id, wsK.id)
  await assert.rejects(S.variationFor(tpl, wsK.id, ha), (e) => e.status === 404, '템플릿 주인에게도 없음')
  await assert.rejects(S.assertRefVisible(tpl, wsK.id, pd), (e) => e.status === 404)
  // the folders list has no folder for the project
  assert.ok(!(await S.listFolders(ks)).some((f) => f.name.includes('가나정밀')))
  // the workroom of its checkout: its person only
  const { folderRoomAccess } = await import('../lib/folders/rooms.js')
  const { folderRoom } = await import('../lib/folders/rooms.js')
  // (the room as the server makes it — read only or not, it is no one else's: not even the template's owner may look)
  for (const who of [ks, pd, ha]) {
    const room = await folderRoom('variation', wsK.id, who)
    assert.ok(room, 'room')
    assert.equal(await folderRoomAccess(who, room), who === ks, who.name)
  }
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
  await fs.writeFile(path.join(workK.dir, '산출물', '가나정밀 3분기 제안서 초안.md'), `# 가나정밀 3분기 제안서 (초안)\n${OLD}\n- 제조 고객사 42곳\n`)
  await fs.writeFile(path.join(workK.dir, '제안서 양식.md'), FORM.replace(OLD, NEW))
  const before = await G.head(tpl.repo_path, 'main')
  const r = await TF.finishProjectWork(workK, { stopped: true })
  assert.deepEqual(r.changed.map((c) => c.path).sort(), ['산출물/가나정밀 3분기 제안서 초안.md', '제안서 양식.md'])
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
  assert.deepEqual(c.outputs.map((f) => f.path), ['산출물/가나정밀 3분기 제안서 초안.md'])
  await assert.rejects(TPL.propose(tpl, ws, ks, { paths: ['산출물/가나정밀 3분기 제안서 초안.md'] }), (e) => e.code === 'tpl_not_template_file')
  await assert.rejects(TPL.propose(tpl, ws, pd, { paths: ['제안서 양식.md'] }), (e) => e.status === 404, '다른 사람은 보낼 수 없음')
  // meanwhile the owner changed another part of the same form in main: the request merges both (line changes three ways)
  await put(tpl, ha, '제안서 양식.md', FORM.replace('## 3. 제안 범위와 일정', '## 3. 제안 범위 · 일정 · 금액'))
  const out = await TPL.propose(tpl, ws, ks, { paths: ['제안서 양식.md'], title: '양식 주소 고침', note: '옛 주소였어요' })
  reqV = out.variation
  assert.deepEqual(out.files, ['제안서 양식.md'])
  // what the template's members get of it names neither the workspace nor the project's thread (review of #103)
  assert.deepEqual(Object.keys(reqV.source.request).sort(), ['note', 'paths'])
  const listedReq = (await S.variations(tpl)).find((v) => v.id === reqV.id)
  assert.ok(!JSON.stringify(listedReq.source).includes(wsK.id) && !JSON.stringify(listedReq.source).includes(threadK.id))
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
  const [t3] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','다라테크 4분기 제안') returning *`, [pd.id])
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
  const [named] = await q(`update pro_threads set title='다라테크 4분기 제안' where id=$1 returning *`, [t.id])
  assert.equal(await TF.retitleProject(named, draft), 1)
  const v1 = await S.variationById(v0.id)
  assert.equal(v1.title, '다라테크 4분기 제안')
  assert.match(v1.source.label, /「다라테크 4분기 제안」/)
  assert.equal(v1.source.template.commit, v0.source.template.commit, '다른 기록은 그대로')
  await q('update pro_folder_variations set title=$2 where id=$1', [v0.id, '내가 지은 이름'])
  assert.equal(await TF.retitleProject({ ...named, title: '또 다른 이름' }, '다라테크 4분기 제안'), 0)
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

// ---------- review of #103: no way around a workspace's privacy ----------
const wsHead = async () => G.head(tpl.repo_path, `refs/heads/${(await S.variationById(wsK.id)).branch}`)
const status = (n, code) => (e) => e.status === n && (!code || e.code === code)

test('TF-U-12 새 변형의 기준: main · 볼 수 있는 변형 · 읽을 수 있는 판만 — 작업 공간 · 가지 이름 · git 표현은 거절', { skip: !db }, async () => {
  const ws = await S.variationById(wsK.id)
  const main = await G.head(tpl.repo_path, 'main')
  assert.equal(await S.baseFor(tpl, undefined, pd), 'main')
  assert.equal(await S.baseFor(tpl, 'main', pd), 'main')
  assert.equal(await S.baseFor(tpl, main, pd), main)
  await assert.rejects(S.baseFor(tpl, wsK.id, pd), status(404), '남의 작업 공간 id')
  await assert.rejects(S.baseFor(tpl, wsK.id, ks), status(409), '내 작업 공간에서도 새 변형은 안 됨')
  for (const b of [ws.branch, `refs/heads/${ws.branch}`, ':/제안서', 'main~1', 'HEAD', `${ws.branch}^{commit}`]) await assert.rejects(S.baseFor(tpl, b, ks), status(400), b)
  const h = await wsHead()
  await assert.rejects(S.baseFor(tpl, h, pd), status(404), '작업 공간에만 있는 판')
  await assert.rejects(S.baseFor(tpl, h, ks), status(404), '내 작업 공간의 판에서도 새 변형은 안 됨')
  // the service itself never grows a variation out of a workspace, whatever a caller passes
  await assert.rejects(S.createVariation(tpl, { title: 'x', base: wsK.id, holder: { type: 'user', id: ks.id, name: ks.name } }), status(409))
  await assert.rejects(S.createVariation(tpl, { title: 'x', base: ws.branch, holder: { type: 'user', id: ks.id, name: ks.name } }), status(409))
})

test('TF-U-13 판(커밋)으로 읽기: 작업 공간에만 있는 판은 그 사람만 · 어느 가지에도 없는 판은 아무도', { skip: !db }, async () => {
  const h = await wsHead()
  const main = await G.head(tpl.repo_path, 'main')
  assert.ok(await S.commitVisible(tpl, h, ks))
  assert.ok(!(await S.commitVisible(tpl, h, pd)))
  assert.ok(!(await S.commitVisible(tpl, h, ha)), '템플릿 주인에게도')
  assert.equal(await S.assertRefVisible(tpl, main, pd), null)
  await assert.rejects(S.assertRefVisible(tpl, h, pd), status(404))
  assert.equal(await S.assertRefVisible(tpl, h, ks), null)
  assert.ok(!(await S.commitVisible(tpl, '0'.repeat(40), ks)))
  const tree = (await G.git(tpl.repo_path, ['rev-parse', `${h}^{tree}`])).trim()
  const dangling = (await G.git(tpl.repo_path, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'dangling'])).trim()
  assert.ok(!(await S.commitVisible(tpl, dangling, ks)), '어느 가지에도 없는 판')
})

test('TF-U-14 파일 멘션: 남의 작업 공간 · 그 판 · 그 블롭은 이름으로 받지 않고, 멘션 카드도 「없음」', { skip: !db }, async () => {
  const FR = await import('../lib/fileRefs.js')
  const draft = '산출물/가나정밀 3분기 제안서 초안.md'
  const h = await wsHead()
  const main = await G.head(tpl.repo_path, 'main')
  const draftBlob = await S.blobAt(tpl, h, draft)
  assert.ok(draftBlob)
  await assert.rejects(FR.folderRef(pd, { slug: tpl.slug, path: draft, variation: wsK.id }), status(404), '작업 공간의 변형 id')
  await assert.rejects(FR.folderRef(pd, { slug: tpl.slug, path: draft, commit: h }), status(404), '작업 공간의 판')
  await assert.rejects(FR.folderRef(pd, { slug: tpl.slug, path: draft, blob: draftBlob }), status(404), '작업 공간에만 있는 블롭')
  const r1 = await FR.folderRef(pd, { slug: tpl.slug, path: '제안서 양식.md', variation: wsK.id, commit: h })
  assert.equal(r1.variation, null)
  assert.equal(r1.commit, main, '이 파일의 지금 판(main)으로')
  // its person: her workspace's version
  const r2 = await FR.folderRef(ks, { slug: tpl.slug, path: draft, variation: wsK.id })
  assert.equal(r2.variation.id, wsK.id)
  assert.equal(r2.blob, draftBlob)
  // a mention that names the workspace (one she sent): for 박도윤 the file is not there, and nothing of the workspace is said
  const ref = { folderId: tpl.id, slug: tpl.slug, folder: tpl.name, path: draft, name: 'x.md', commit: h, blob: draftBlob, variation: { id: wsK.id, title: '가나정밀 3분기 제안', status: 'ready' } }
  const seen = await FR.decorate(pd, { refs: [ref] })
  assert.equal(seen.refs[0].state.card, 'gone')
  // (its name and path only — no folder id, slug, commit, blob or variation at the top either)
  assert.deepEqual(Object.keys(seen.refs[0]).sort(), ['name', 'path', 'state'])
  assert.deepEqual(Object.keys(seen.refs[0].state).sort(), ['card', 'gone'])
  // a mention by a commit only the workspace holds (no variation named): the same
  const byCommit = await FR.decorate(pd, { refs: [{ ...ref, variation: null }] })
  assert.deepEqual(Object.keys(byCommit.refs[0]).sort(), ['name', 'path', 'state'])
  const hers = await FR.decorate(ks, { refs: [ref] })
  assert.equal(hers.refs[0].state.card, 'open')
})

test('TF-U-15 git 으로: 어느 토큰에도 작업 공간 가지(var/t/…)가 보이지 않고, 그 사람의 데스크톱 일에만 그 가지 하나', { skip: !db }, async () => {
  const H = await import('../lib/folders/gitHttp.js')
  const express = (await import('express')).default
  const { execFile } = await import('node:child_process')
  const app = express()
  app.use('/api/git', H.gitRoutes())
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const lsRemote = (url, token) => new Promise((resolve) => execFile('git', ['-c', 'credential.helper=', '-c', `http.extraHeader=Authorization: Bearer ${token}`, 'ls-remote', url],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, errOut) => resolve({ code: e ? 1 : 0, out: String(out), err: String(errOut) })))
  try {
    const ws = await S.variationById(wsK.id)
    assert.ok(await G.branchExists(tpl.repo_path, ws.branch))
    const a = await lsRemote(`${base}/api/git/${tpl.id}.git`, H.mintToken({ tenant: TENANT, folderId: tpl.id }))
    assert.equal(a.code, 0, a.err)
    assert.match(a.out, /refs\/heads\/main/)
    assert.doesNotMatch(a.out, /refs\/heads\/var\/t\//, '작업 공간 가지는 광고하지 않음')
    assert.ok(!a.out.includes(await wsHead()), '그 판도 없음')
  } finally { await new Promise((r) => server.close(r)) }
  // a desktop's job: the workspace's own person, in that project → that one branch shown again; anyone else's job → hidden
  assert.deepEqual(await H.workspaceHidden(tpl, null), ['refs/heads/var/t/'])
  const job = async (who) => (await q(`insert into pro_local_jobs (tenant_id, user_id, todo_id, agent, folder_id, chat) values ($1,$2,$3,'claude',$4,$5) returning id::text as id`,
    [TENANT, who.id, `tf-${crypto.randomUUID()}`, tpl.id, { mode: 'project', variation: wsK.id, folderId: tpl.id }]))[0].id
  let mine, theirs
  try {
    mine = await job(ks); theirs = await job(pd)
    const ws = await S.variationById(wsK.id)
    assert.deepEqual(await H.workspaceHidden(tpl, { scope: 'device', job: mine }), ['refs/heads/var/t/', `!refs/heads/${ws.branch}`])
    assert.deepEqual(await H.workspaceHidden(tpl, { scope: 'device', job: theirs }), ['refs/heads/var/t/'])
    assert.deepEqual(await H.workspaceHidden(intro, { scope: 'device', job: mine }), ['refs/heads/var/t/'], '다른 폴더의 토큰')
  } finally { await q('delete from pro_local_jobs where id = any($1::uuid[])', [[mine, theirs].filter(Boolean)]).catch(() => {}) }
})

test('TF-U-16 템플릿 프로젝트에서 시작한 프로세스의 단계는 작업 공간을 받지 않는다(실행 변형 · 인스턴스 라인 · cli-agent 클론 없음)', { skip: !db }, async () => {
  const W = await import('../lib/folders/work.js')
  const ws = await S.variationById(wsK.id)
  const before = (await q('select count(*)::int n from pro_folder_variations where folder_id=$1', [tpl.id]))[0].n
  for (const orch of ['deepagents', 'cliagents']) {
    await W.stepOne({ id: crypto.randomUUID(), status: 'IN_PROGRESS', agent_orch: orch, agent_config: { folder: tpl.id, base_ref: `var:${ws.branch}` }, proc_inst_id: 'tf.x', root_proc_inst_id: 'tf.x', activity_name: '단계', query: '', output: {} })
  }
  assert.equal((await q('select count(*)::int n from pro_folder_variations where folder_id=$1', [tpl.id]))[0].n, before, '변형이 생기지 않음')
  // projectStepFolders: the agent step of an instance started in the template project gets no folder
  const inst = `tf_proc.${crypto.randomUUID()}`
  await q(`update pro_thread_folders set instances = array_append(coalesce(instances, '{}'), $2) where thread_id=$1`, [threadK.id, inst])
  let todo = null
  try {
    ;[todo] = await q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, activity_id, activity_name, status, agent_mode, agent_orch, agent_config, start_date)
                       values (gen_random_uuid(), $1, $2, $3, $3, 'a1', '정리', 'IN_PROGRESS', 'COMPLETE', 'deepagents', '{}'::jsonb, now()) returning id::text as id`, [TENANT, ks.id, inst])
  } catch (e) { console.log('(todolist row not made here:', e.message.slice(0, 120), ')') }
  if (todo) {
    try {
      await TF.projectStepFolders()
      const [row] = await q('select agent_config from todolist where id=$1', [todo.id])
      assert.ok(!('folder' in (row.agent_config || {})), JSON.stringify(row.agent_config))
    } finally { await q('delete from todolist where id=$1', [todo.id]).catch(() => {}) }
  }
})

test('TF-U-17 보내는 파일은 보통 파일만 · 줄바꿈이 든 이름도 한 항목 · merge-file 은 종료 상태로', { skip: !db }, async () => {
  // merge-file: 0 clean, >0 conflicts, anything else a failure
  const dir = await fs.mkdtemp(path.join(ROOT, 'mf-'))
  const w = (n, t) => fs.writeFile(path.join(dir, n), t)
  await w('base', 'a\nb\nc\nd\ne\n'); await w('ours', 'A\nb\nc\nd\ne\n'); await w('theirs', 'a\nb\nc\nd\nE\n'); await w('clash', 'X\nb\nc\nd\ne\n')
  const clean = await TPL.mergeFile(dir, [path.join(dir, 'ours'), path.join(dir, 'base'), path.join(dir, 'theirs')])
  assert.equal(clean.status, 'clean')
  assert.equal(clean.out.toString(), 'A\nb\nc\nd\nE\n')
  assert.equal((await TPL.mergeFile(dir, [path.join(dir, 'ours'), path.join(dir, 'base'), path.join(dir, 'clash')])).status, 'conflict')
  await assert.rejects(TPL.mergeFile(dir, [path.join(dir, 'none'), path.join(dir, 'base'), path.join(dir, 'theirs')]))
  // a template file turned into a link in a workspace: refused (plain files only)
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','링크 시험') returning *`, [ks.id])
  await TF.linkProject(ks, t, tpl)
  const ws = await S.variationById((await TF.folderPayload(t.id)).variation.id)
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') }
  const link = (await G.git(tpl.repo_path, ['hash-object', '-w', '--stdin'], { input: '../../etc/hosts' })).trim()
  await G.git(tpl.repo_path, ['read-tree', ws.branch], { env })
  await G.git(tpl.repo_path, ['update-index', '--cacheinfo', `120000,${link},제안서 양식.md`], { env })
  const tree = (await G.git(tpl.repo_path, ['write-tree'], { env })).trim()
  const c = (await G.git(tpl.repo_path, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', ws.branch, '-m', 'link'])).trim()
  await G.git(tpl.repo_path, ['update-ref', `refs/heads/${ws.branch}`, c])
  await assert.rejects(TPL.propose(tpl, await S.variationById(ws.id), ks, { paths: ['제안서 양식.md'] }), (e) => e.code === 'tpl_not_plain')
  // a template file whose name holds a line break: sent as one entry (update-index -z)
  const odd = '메모\n둘째 줄.md'
  await S.upload(tpl, ha, odd, enc('# 메모\n'))
  const [t2] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','줄바꿈 시험') returning *`, [ks.id])
  await TF.linkProject(ks, t2, tpl)
  const ws2 = await S.variationById((await TF.folderPayload(t2.id)).variation.id)
  const d2 = path.join(ROOT, 'ws-odd')
  await S.checkout(tpl, ws2, d2)
  await fs.writeFile(path.join(d2, odd), '# 메모\n고침\n')
  await S.commitVariation(tpl, await S.variationById(ws2.id), ks, '메모 고침')
  await S.release(tpl, await S.variationById(ws2.id))
  const out = await TPL.propose(tpl, await S.variationById(ws2.id), ks, { paths: [odd] })
  assert.deepEqual(out.files, [odd])
  assert.equal(String(await G.show(tpl.repo_path, out.variation.branch, odd)), '# 메모\n고침\n')
  assert.deepEqual((await S.variationDetail(tpl, out.variation)).changes.map((x) => x.path), [odd])
})

test('TF-U-18 작업 공간 가지는 프로젝트 id 전체로 — 앞 8자가 같은 프로젝트 · 남아 있던 가지를 넘겨받지 않음', { skip: !db }, async () => {
  const mk = async (id, title) => (await q(`insert into pro_threads(id,user_id,kind,title) values ($1,$2,'project',$3) returning *`, [id, pd.id, title]))[0]
  const a = await mk('abcdef12-0000-4000-8000-000000000001', '같은 앞자리 1')
  const b = await mk('abcdef12-0000-4000-8000-000000000002', '같은 앞자리 2')
  await TF.linkProject(pd, a, tpl)
  await TF.linkProject(pd, b, tpl)
  const va = await S.variationById((await TF.folderPayload(a.id)).variation.id)
  const vb = await S.variationById((await TF.folderPayload(b.id)).variation.id)
  assert.equal(va.branch, `var/t/${a.id.replace(/-/g, '')}`)
  assert.notEqual(va.branch, vb.branch)
  assert.equal(vb.source.thread_id, b.id)
  // a branch left behind under the next project's name is not taken over
  const c = await mk('abcdef12-0000-4000-8000-000000000003', '남은 가지')
  await G.git(tpl.repo_path, ['branch', `var/t/${c.id.replace(/-/g, '')}`, (await S.variationById(wsK.id)).branch])
  await TF.linkProject(pd, c, tpl)
  const vc = await S.variationById((await TF.folderPayload(c.id)).variation.id)
  assert.equal(vc.branch, `var/t/${c.id.replace(/-/g, '')}-2`)
  assert.equal(vc.base_commit, await G.head(tpl.repo_path, 'main'), '템플릿 main 에서 시작(남은 가지의 내용이 아님)')
})

test('TF-U-19 템플릿 지정은 관리형 폴더만 — 작업 폴더 · 연결형은 거절 · 참조 자리 검사는 남의 작업 공간을 들여다보거나 이름을 대지 않음', { skip: !db }, async () => {
  const work = await S.createFolder(ha, { name: '메일 작업 폴더' })
  await q(`update pro_folders set settings = settings || '{"work": {"instId": "x"}}'::jsonb where id=$1`, [work.id])
  await assert.rejects(TPL.setTemplate(await S.folderById(work.id), ha, true), status(400))
  await assert.rejects(TPL.setTemplate({ ...work, kind: 'linked', settings: {} }, ha, true), status(400))
  // a slot over a path 김서연's workspace has (산출물/…): added — the workspace is not looked into, its project not named
  const r = await REFS.add(tpl, 'owner', ha, { source: record.slug, slot: '산출물', label: '산출물' })
  assert.equal(r.slot, '산출물')
  await REFS.remove(tpl, 'owner', ha, r.id)
})


// ---------- review 2 of #103 ----------
const runBranch = (tag) => `pgpt-agent/local-${crypto.randomBytes(4).toString('hex')}-${tag}`

test('TF-U-20 내 PC 실행 가지(pgpt-agent/local-…)에만 있는 판은 행이 없으니 아무도 못 읽는다 — REST · 기준 · 멘션 블롭 (허용 목록)', { skip: !db }, async () => {
  const FR = await import('../lib/fileRefs.js')
  const h = await wsHead()
  // what a desktop's run for the workspace leaves: a branch holding the workspace's commits, and a new commit on top
  const run = runBranch('a')
  await G.git(tpl.repo_path, ['branch', run, h])
  const tree = (await G.git(tpl.repo_path, ['rev-parse', `${h}^{tree}`])).trim()
  const onTop = (await G.git(tpl.repo_path, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', h, '-m', 'run'])).trim()
  await G.git(tpl.repo_path, ['update-ref', `refs/heads/${run}`, onTop])
  try {
    for (const who of [pd, ha]) {
      assert.ok(!(await S.commitVisible(tpl, onTop, who)), '실행 가지에만 있는 판')
      assert.ok(!(await S.commitVisible(tpl, h, who)), '작업 공간 판(실행 가지에도 있음)')
      await assert.rejects(S.assertRefVisible(tpl, onTop, who), status(404))
      await assert.rejects(S.baseFor(tpl, onTop, who), status(404))
    }
    assert.ok(!(await S.sharedCommit(tpl, onTop)) && !(await S.sharedCommit(tpl, h)))
    assert.ok(await S.commitVisible(tpl, h, ks), '그 사람에게는 작업 공간의 판')
    assert.ok(!(await S.commitVisible(tpl, onTop, ks)), '행이 없는 가지의 판은 그 사람에게도 아님(가져온 뒤에만 작업 공간에)')
    const draftBlob = await S.blobAt(tpl, h, '산출물/가나정밀 3분기 제안서 초안.md')
    await assert.rejects(FR.folderRef(pd, { slug: tpl.slug, path: '산출물/가나정밀 3분기 제안서 초안.md', blob: draftBlob }), status(404))
    // a base in another spelling of a workspace branch: not an exact branch name — refused
    const ws = await S.variationById(wsK.id)
    for (const b of [`heads/${ws.branch}`, `${ws.branch}^0`, `${run}`, `refs/heads/${run}`]) await assert.rejects(S.baseFor(tpl, b, ks), status(400), b)
    await assert.rejects(S.createVariation(tpl, { title: 'x', base: `heads/${ws.branch}`, holder: { type: 'user', id: ks.id, name: ks.name } }), status(400))
    await assert.rejects(S.createVariation(tpl, { title: 'x', base: `${ws.branch}^0`, holder: { type: 'user', id: ks.id, name: ks.name } }), status(400))
    assert.ok(S.isWorkspaceBranch(`heads/${ws.branch}`) && S.isWorkspaceBranch(`refs/heads/${ws.branch}`))
    assert.ok(!(await G.branchExists(tpl.repo_path, `${ws.branch}^0`)) && !(await G.branchExists(tpl.repo_path, `heads/${ws.branch}`)) && await G.branchExists(tpl.repo_path, ws.branch))
  } finally { await G.git(tpl.repo_path, ['branch', '-D', run], { check: false }) }
})

test('TF-U-21 작업 공간 · 공유되지 않은 판의 사본은 비공개 저장소의 서명 주소로만(공개 주소 아님)', { skip: !db }, async () => {
  const PS = await import('../lib/privateStore.js')
  const draft = '산출물/가나정밀 3분기 제안서 초안.md'
  assert.equal(await S.privateRef(tpl, 'main'), false)
  assert.equal(await S.privateRef(tpl, wsK.id), true)
  assert.equal(await S.privateRef(tpl, await wsHead()), true)
  assert.equal(await S.privateRef(tpl, await G.head(tpl.repo_path, 'main')), false)
  const pub = await S.publishFile(tpl, draft, wsK.id)
  assert.ok(pub.private && PS.isSignedUrl(pub.url) && !PS.isPublicUrl(pub.url), pub.url.replace(/token=.*/, 'token=…'))
  assert.ok(!pub.url.includes(`/object/public/files/pgpt-pro/folders/${tpl.id}/`))
  const open = await S.publishFile(tpl, '제안서 양식.md', 'main')
  assert.ok(PS.isPublicUrl(open.url), 'main 의 파일은 예전처럼')
})

test('TF-U-22 git: 다른 토큰에는 실행 가지가 보이지 않고 판으로도 받지 못함 · 남의 판을 가리키는 밀어 넣기는 거절 · 숨은 판 위에 쌓은 밀어 넣기는 되돌림', { skip: !db }, async () => {
  const H = await import('../lib/folders/gitHttp.js')
  const express = (await import('express')).default
  const zlib = await import('node:zlib')
  const { execFile } = await import('node:child_process')
  const app = express()
  app.use('/api/git', H.gitRoutes())
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const url = `${base}/api/git/${tpl.id}.git`
  const token = H.mintToken({ tenant: TENANT, folderId: tpl.id })
  const gitc = (args, cwd) => new Promise((resolve) => execFile('git', ['-c', 'credential.helper=', '-c', `http.extraHeader=Authorization: Bearer ${token}`, ...args],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, errOut) => resolve({ code: e ? 1 : 0, out: String(out), err: String(errOut) })))
  const h = await wsHead()
  const run = runBranch('b')
  await G.git(tpl.repo_path, ['branch', run, h])
  const pkt = (str) => { const b = Buffer.from(str); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]) }
  const pack = (objects) => {
    const head = Buffer.alloc(12); head.write('PACK'); head.writeUInt32BE(2, 4); head.writeUInt32BE(objects.length, 8)
    const parts = [head]
    for (const { type, body } of objects) {
      let size = body.length
      const bytes = [((type & 7) << 4) | (size & 15)]; size >>= 4
      while (size) { bytes[bytes.length - 1] |= 0x80; bytes.push(size & 0x7f); size >>= 7 }
      parts.push(Buffer.from(bytes), zlib.deflateSync(body))
    }
    const all = Buffer.concat(parts)
    return Buffer.concat([all, crypto.createHash('sha1').update(all).digest()])
  }
  const push = (ref, sha, objects = []) => fetch(`${url}/git-receive-pack`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-git-receive-pack-request' },
    body: Buffer.concat([pkt(`${'0'.repeat(40)} ${sha} ${ref}\0report-status\n`), Buffer.from('0000'), pack(objects)]) }).then(async (r) => ({ status: r.status, text: await r.text() }))
  try {
    const ls = await gitc(['ls-remote', url])
    assert.equal(ls.code, 0, ls.err)
    assert.doesNotMatch(ls.out, /pgpt-agent\/local-|refs\/heads\/var\/t\//, '실행 가지 · 작업 공간 가지는 광고하지 않음')
    // a fetch by the commit's id: not one this token is served (protocol v0 serves the advertised tips only)
    const dir = await fs.mkdtemp(path.join(ROOT, 'clone-'))
    await gitc(['init', '-q'], dir)
    const f = await gitc(['fetch', '-q', url, h], dir)
    assert.notEqual(f.code, 0, '판으로 받기')
    // a push that points a branch of its own at that commit, with no pack: refused before git sees it
    const r1 = await push('refs/heads/pgpt-agent/steal-1', h)
    assert.match(r1.text, /ng refs\/heads\/pgpt-agent\/steal-1 .*not one this token may read/)
    assert.ok(!(await G.branchExists(tpl.repo_path, 'pgpt-agent/steal-1')))
    // a new commit made on top of it (its parent only hidden refs hold): taken, then put back before the client is let go
    const tree = (await G.git(tpl.repo_path, ['rev-parse', 'main^{tree}'])).trim()
    const body = Buffer.from(`tree ${tree}\nparent ${h}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\n\nsteal\n`)
    const sha = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`commit ${body.length}\0`), body])).digest('hex')
    const r2 = await push('refs/heads/pgpt-agent/steal-2', sha, [{ type: 1, body }])
    assert.equal(r2.status, 200, r2.text)
    assert.ok(!(await G.branchExists(tpl.repo_path, 'pgpt-agent/steal-2')), '되돌림')
    // an ordinary push of its own (a new commit on main) still stands
    const body3 = Buffer.from(`tree ${tree}\nparent ${await G.head(tpl.repo_path, 'main')}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\n\nfine\n`)
    const sha3 = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`commit ${body3.length}\0`), body3])).digest('hex')
    const r3 = await push('refs/heads/pgpt-agent/fine-1', sha3, [{ type: 1, body: body3 }])
    assert.match(r3.text, /ok refs\/heads\/pgpt-agent\/fine-1/)
    assert.ok(await G.branchExists(tpl.repo_path, 'pgpt-agent/fine-1'))
  } finally {
    await new Promise((r) => server.close(r))
    for (const b of [run, 'pgpt-agent/steal-1', 'pgpt-agent/steal-2', 'pgpt-agent/fine-1']) await G.git(tpl.repo_path, ['branch', '-D', b], { check: false })
  }
  // the hidden-ref rule as git reads it, and a desktop job's own run branches
  assert.ok(H.hiddenBy('refs/heads/var/t/abc', ['refs/heads/var/t/']))
  assert.ok(!H.hiddenBy('refs/heads/var/t/abc', ['refs/heads/var/t/', '!refs/heads/var/t/abc']))
  assert.ok(!H.hiddenBy('refs/heads/var/tx', ['refs/heads/var/t/']))
  const r0 = runBranch('c'), r1b = `${r0.slice(0, r0.lastIndexOf('-'))}-d`
  await G.git(tpl.repo_path, ['branch', r0, 'main']); await G.git(tpl.repo_path, ['branch', r1b, 'main'])
  const other = runBranch('e'); await G.git(tpl.repo_path, ['branch', other, 'main'])
  try {
    const own = r0.slice(0, r0.lastIndexOf('-') + 1)
    const hid = await H.runHidden(tpl, { scope: 'device', job: 'x', push: own })
    assert.ok(hid.includes(`refs/heads/${other}`) && !hid.includes(`refs/heads/${r0}`) && !hid.includes(`refs/heads/${r1b}`))
    assert.ok((await H.runHidden(tpl, null)).includes(`refs/heads/${r0}`), '클러스터 토큰에는 모두 숨김')
  } finally { for (const b of [r0, r1b, other]) await G.git(tpl.repo_path, ['branch', '-D', b], { check: false }) }
})

test('TF-U-23 내 PC 에이전트의 일이 작업 공간에 들어오면 그 실행 가지는 지우고, 「반영하면」 카드 없이 파일 카드는 비공개 주소로', { skip: !db }, async () => {
  const CH = await import('../lib/localAgents/chat.js')
  const PS = await import('../lib/privateStore.js')
  const ws = await S.variationById(wsK.id)
  const [job] = await q(`insert into pro_local_jobs (tenant_id, user_id, todo_id, kind, thread_id, agent, folder_id, chat) values ($1,$2,$3,'chat',$4,'claude',$5,$6) returning *`,
    [TENANT, ks.id, `tf-${crypto.randomUUID()}`, threadK.id, tpl.id, { mode: 'project', variation: ws.id, folderId: tpl.id, line: ws.branch, title: '내 PC 시험' }])
  const run = `pgpt-agent/local-${String(job.id).slice(0, 8)}-1`
  try {
    // what the desktop pushed: one new file on top of the workspace
    const dir = await fs.mkdtemp(path.join(ROOT, 'run-'))
    await G.git(tpl.repo_path, ['worktree', 'add', '-q', '--detach', dir, ws.branch])
    await fs.writeFile(path.join(dir, '산출물', '내PC 메모.md'), '# 내 PC 에서\n')
    await G.git(dir, ['add', '-A']); await G.git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'run'])
    const head = await G.head(dir)
    await G.git(tpl.repo_path, ['worktree', 'remove', '--force', dir])
    await G.git(tpl.repo_path, ['branch', run, head])
    await q('update pro_folder_variations set change_card=null where id=$1', [ws.id])
    await CH.reply(job, { turn: 1, text: '메모를 남겼어요', branch: run, pushed: true, files: ['산출물/내PC 메모.md'] })
    assert.ok(!(await G.branchExists(tpl.repo_path, run)), '실행 가지는 지움')
    assert.equal(await G.head(tpl.repo_path, `refs/heads/${ws.branch}`), head, '작업 공간에 들어옴')
    await new Promise((ok) => setTimeout(ok, 300))
    assert.equal((await S.variationById(ws.id)).change_card, null, '「반영하면」 카드 없음')
    const [card] = await q(`select content from pro_messages where thread_id=$1 and kind='file' and content->'localRun'->>'jobId'=$2`, [threadK.id, job.id])
    assert.ok(card && PS.isSignedUrl(card.content.url) && !PS.isPublicUrl(card.content.url), '파일 카드는 비공개 서명 주소')
  } finally {
    await G.git(tpl.repo_path, ['branch', '-D', run], { check: false })
    await q('delete from pro_local_jobs where id=$1', [job.id]).catch(() => {})
  }
})

test('TF-U-24 가져오기는 연결형 폴더의 pgpt-agent/ 가지만, 정확한 이름으로 · 라벨 없는 작업 공간의 이름 바꾸기는 출처를 지우지 않음 · 작업실의 관리자 예외 없음', { skip: !db }, async () => {
  await assert.rejects(S.importBranches(tpl, ha, ['pgpt-agent/x']), status(400), '관리형 폴더는 가져오지 않음')
  const dir = path.join(ROOT, 'linked-repo')
  await fs.mkdir(dir, { recursive: true })
  const g = (...a) => G.git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  await g('init', '-q', '-b', 'main'); await fs.writeFile(path.join(dir, 'a.md'), 'a\n'); await g('add', '-A'); await g('commit', '-qm', 'a')
  for (const b of ['pgpt-agent/ok', 'var/t/abcdef', 'other']) await g('branch', b)
  const linked = await S.registerLinked(ha, dir, { name: '연결형 시험' })
  try {
    const out = await S.importBranches(linked, ha, ['pgpt-agent/ok', 'pgpt-agent/ok^0', 'var/t/abcdef', 'other', 'pgpt-agent/../var/t/abcdef', ':/a', 'pgpt-agent/none'])
    assert.deepEqual(out.map((v) => v.branch), ['pgpt-agent/ok'])
  } finally { await q('delete from pro_folders where id=$1', [linked.id]).catch(() => {}) }
  // retitle: a source with no label keeps its template mark
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','라벨 시험') returning *`, [pd.id])
  await TF.linkProject(pd, t, tpl)
  const v = await S.variationById((await TF.folderPayload(t.id)).variation.id)
  await q(`update pro_folder_variations set source = source - 'label' where id=$1`, [v.id])
  const [named] = await q(`update pro_threads set title='새 이름' where id=$1 returning *`, [t.id])
  await TF.retitleProject(named, '라벨 시험')
  const after = await S.variationById(v.id)
  assert.equal(after.title, '새 이름')
  assert.ok(after.source?.template?.commit, '출처(템플릿 표시)는 그대로')
  // the workroom: a conversation room with a template's checkout in it is no administrator's to open
  const { holdsWorkspace } = await import('../lib/workroom.js')
  const room = path.join(ROOT, 'room-1')
  await fs.mkdir(path.join(room, 'folders', tpl.slug), { recursive: true })
  assert.equal(await holdsWorkspace({ kind: 'chat', root: room }), true)
  const room2 = path.join(ROOT, 'room-2')
  await fs.mkdir(path.join(room2, 'folders', intro.slug), { recursive: true })
  assert.equal(await holdsWorkspace({ kind: 'chat', root: room2 }), false)
  assert.equal(await holdsWorkspace({ kind: 'chat', root: path.join(ROOT, 'room-none') }), false)
  assert.equal(await holdsWorkspace({ kind: 'todo', root: room }), false)
})

test('TF-U-25 보내는 파일: 이름에 pathspec 기호가 있어도 그 파일 · 작업 공간이 바꾼 실행 권한은 합친 결과에도 · PATCH 와 같은 지정 규칙', { skip: !db }, async () => {
  const odd = ':(icase)별표*.md'
  await S.upload(tpl, ha, odd, enc('# 별표\n첫 줄\n\n\n\n둘째\n'))
  await S.upload(tpl, ha, 'run.sh', enc('echo 1\n\n\n\n\necho 2\n'))
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','기호 시험') returning *`, [ks.id])
  await TF.linkProject(ks, t, tpl)
  const ws = await S.variationById((await TF.folderPayload(t.id)).variation.id)
  const d = path.join(ROOT, 'ws-sym')
  await S.checkout(tpl, ws, d)
  await fs.writeFile(path.join(d, odd), '# 별표\n고침\n\n\n\n둘째\n')
  await fs.writeFile(path.join(d, 'run.sh'), 'echo 0\n\n\n\n\necho 2\n')
  await fs.chmod(path.join(d, 'run.sh'), 0o755)
  await S.commitVariation(tpl, await S.variationById(ws.id), ks, '기호 · 실행 권한')
  await S.release(tpl, await S.variationById(ws.id))
  // meanwhile main changed run.sh's last line: the merge keeps both, and the workspace's +x
  await S.upload(tpl, ha, 'run.sh', enc('echo 1\n\n\n\n\necho 3\n'))
  const out = await TPL.propose(tpl, await S.variationById(ws.id), ks, { paths: [odd, 'run.sh'] })
  assert.deepEqual(out.files.sort(), [odd, 'run.sh'].sort())
  assert.equal(String(await G.show(tpl.repo_path, out.variation.branch, odd)), '# 별표\n고침\n\n\n\n둘째\n')
  assert.equal(String(await G.show(tpl.repo_path, out.variation.branch, 'run.sh')), 'echo 0\n\n\n\n\necho 3\n')
  assert.match(await G.git(tpl.repo_path, ['ls-tree', out.variation.branch, '--', 'run.sh']), /^100755 /)
  // the PATCH route's rule is TPL.templateSettings: kept mark, refusals
  const kept = TPL.templateSettings(tpl, pd, true)
  assert.equal(kept.template.by, tpl.settings.template.by, '이미 지정된 표시는 그대로')
  assert.equal(TPL.templateSettings(tpl, pd, false).template, undefined)
  assert.throws(() => TPL.templateSettings({ ...tpl, settings: { work: {} } }, ha, true), status(400))
  assert.throws(() => TPL.templateSettings({ ...tpl, kind: 'linked' }, ha, true), status(400))
})

// ---------- with variation seats (#86): a workspace's seat is its person's only ----------
test('TF-U-26 작업본 자리: 작업 공간은 그 사람의 작업실 · 에이전트 · PC 에만 — 폴더 주인도 돌려 달라고 하거나 가져가지 못하고, 작업실 목록 · 남은 변경도 그 사람에게만', { skip: !db }, async () => {
  const SE = await import('../lib/folders/seats.js')
  const ws = await S.variationById(wsK.id)
  const on = SE.seatsOn ? (await SE.seatOf(ws.id, { v: ws })) !== undefined : false
  if (!on) { console.log('(no seat table here — sql/063)'); return }
  // its person opens it in the server workroom
  await SE.openServer(tpl, ws, { user: ks, run: 'workroom', dir: S.personCheckoutDir(ks, ws) })
  try {
    const seat = await SE.seatOf(ws.id, { v: await S.variationById(ws.id) })
    assert.equal(seat.place, 'server'); assert.equal(String(seat.user_id), ks.id)
    // the folder's owner: no 「돌려 달라고 하기」, no take — not even past a day
    const viewOwner = await SE.viewOf({ ...seat, recall: { by: ha.id, at: new Date(Date.now() - 2 * SE.RECALL_WAIT_MS).toISOString() } }, await S.variationById(ws.id), { me: ha, role: 'owner' })
    assert.equal(viewOwner.can.take, false)
    assert.equal(viewOwner.can.recall, false)
    await assert.rejects(SE.recall(tpl, await S.variationById(ws.id), ha, { role: 'owner' }), status(404))
    await assert.rejects(SE.take(tpl, await S.variationById(ws.id), ha, { role: 'owner' }), status(404))
    // the template's 「작업실」 sheet: never its person's workspace (it is opened from the project)
    const sheet = await SE.workroomChoices(tpl, ks, 'runner')
    assert.ok(!sheet.mine.some((x) => x.id === ws.id))
  } finally { await SE.closeServer(tpl, await S.variationById(ws.id), { by: ks.id, me: ks }).catch(() => {}) }
  // what a place that lost the workspace's seat left: as private as the workspace (its person's, hidden branch space, in no list)
  const cur = await S.variationById(ws.id)
  const tree = (await G.git(tpl.repo_path, ['rev-parse', `${cur.branch}^{tree}`])).trim()
  const extra = (await G.git(tpl.repo_path, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-p', cur.branch, '-m', 'left on a PC'])).trim()
  const left = await SE.leftover(tpl, cur, extra, { user: ks.id, where: '김서연의 PC' })
  assert.ok(left.source.template && left.branch.startsWith('var/t/'), left.branch)
  assert.equal(String(left.holder_id), ks.id)
  assert.ok(!(await S.variations(tpl)).some((v) => v.id === left.id), '목록에 없음')
  await assert.rejects(S.variationFor(tpl, left.id, ha), status(404))
  assert.ok(!(await S.commitVisible(tpl, extra, pd)) && await S.commitVisible(tpl, extra, ks))
})
