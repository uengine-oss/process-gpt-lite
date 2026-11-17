// A thread's folder (lib/folders/threadFolders.js): which turns change files and where, and — on the
// local database, without an agent — a project's own variation: made on the first turn, checked out
// in the project's conversation folder, the agent's change committed to it, main untouched.
// Run: PRO_TENANT_ID=en-demo node --test test/threadFolders.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { asksChange, folderTarget, chipState } from '../lib/folders/threadFolders.js'

test('바꿔 달라는 말만 변경으로 본다', () => {
  for (const t of ['안내문 고쳐줘', '일정표에 3일 추가해 줘', '오타 수정해 주세요', '첫 줄 지워 줘', '폴더에 회의록 만들어 줘', '요약을 작성해서 폴더에 저장해 줘',
    'Fix the typo in notice.md', 'Add a line to the notice', 'Please update the schedule', 'Write the minutes into the folder'])
    assert.ok(asksChange(t), t)
  for (const t of ['안내문에 뭐라고 써 있어?', '바뀐 게 뭐야?', '어디를 고쳐야 할까?', '이 폴더 내용으로 보고서 작성해 줘', '변경된 내용 알려줘', '파일 몇 개야?',
    'What changed in the folder?', 'Which file should I fix?', 'Summarize the notice'])
    assert.ok(!asksChange(t), t)
})

test('붙인 폴더: 이름을 안 적은 변경 요청이 그 폴더로, 읽기는 아니고, 이름을 적은 폴더가 먼저', () => {
  const link = { mode: 'ref', folder_id: 'f1', slug: 'seminar', name: '세미나' }
  assert.deepEqual(folderTarget({ link, named: null, text: '안내문 고쳐줘', canChange: true }), { id: 'f1', slug: 'seminar', name: '세미나', attached: true })
  assert.equal(folderTarget({ link, named: null, text: '안내문에 뭐라고 써 있어?', canChange: true }), null)
  // a viewer only reads it
  assert.equal(folderTarget({ link, named: null, text: '안내문 고쳐줘', canChange: false }), null)
  // a Home card answering a mail, an app record, attached files: never a folder edit
  assert.equal(folderTarget({ link, named: null, text: '안내문 고쳐줘', canChange: true, blocked: true }), null)
  const other = { id: 'f2', name: '예산' }
  assert.equal(folderTarget({ link, named: other, text: '예산 폴더의 표 고쳐줘', canChange: true }), other)
  assert.equal(folderTarget({ link: null, named: null, text: '안내문 고쳐줘', canChange: true }), null)
})

test('프로젝트의 폴더는 짧은 변형으로 가지 않는다(프로젝트 변형에서 바뀜), 다른 폴더는 그대로', () => {
  const link = { mode: 'project', folder_id: 'f1', slug: 'seminar', name: '세미나' }
  assert.equal(folderTarget({ link, named: { id: 'f1' }, text: '세미나 폴더의 안내문 고쳐줘', canChange: true }), null)
  assert.equal(folderTarget({ link, named: null, text: '안내문 고쳐줘', canChange: true }), null)
  const other = { id: 'f2' }
  assert.equal(folderTarget({ link, named: other, text: '예산 폴더 고쳐줘', canChange: true }), other)
})

test('칩: 참고 · 변형 작업 중 · 프로젝트', () => {
  assert.equal(chipState({ mode: 'ref', working: false }), 'ref')
  assert.equal(chipState({ mode: 'ref', working: true }), 'working')
  assert.equal(chipState({ mode: 'project', working: true }), 'project')
  assert.equal(chipState(null), null)
})

// ---------- the project's variation on the local database (no agent) ----------
const { q, pool, admin } = await import('../lib/supa.js')
const db = await q('select 1 from pro_thread_folders limit 1').then(() => true).catch(() => false)
const { config } = await import('../config.js')
let user, folder, thread, work
const made = { users: [], folders: [], threads: [], rooms: [] }
after(async () => {
  for (const t of made.threads) await q('delete from pro_threads where id=$1', [t]).catch(() => {})
  const S = await import('../lib/folders/service.js')
  for (const f of made.folders) {
    await q('delete from pro_folders where id=$1', [f.id]).catch(() => {})
    await fs.rm(f.repo_path, { recursive: true, force: true }).catch(() => {})
  }
  for (const room of made.rooms) {
    const keys = (await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`skills/${config.tenantId}/${room}/`]).catch(() => [])).map((r) => r.name)
    if (keys.length) await admin.storage.from('files').remove(keys).catch(() => {})
    await fs.rm(path.join(S.workspaceDir(), '.bpmn', room), { recursive: true, force: true }).catch(() => {})
  }
  await pool.end()
})

test('프로젝트 변형: 첫 턴에 만들고 대화 폴더에 꺼내고, 에이전트가 바꾼 것은 변형에만 · main 그대로', { skip: !db }, async () => {
  const TF = await import('../lib/folders/threadFolders.js')
  const S = await import('../lib/folders/service.js')
  const G = await import('../lib/folders/git.js')
  const stamp = Date.now()
  user = { id: (await q('select gen_random_uuid()::text as id'))[0].id, name: '폴더시험', email: `tf-${stamp}@pgpt.test` }
  folder = await S.createFolder(user, { name: `프로젝트 폴더 시험 ${stamp}` })
  made.folders.push(folder)
  await S.upload(folder, user, 'notice.md', Buffer.from('# 안내문\n첫 줄\n'))
  const mainBefore = await G.head(folder.repo_path, 'main')
  ;[thread] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','세미나 준비') returning *`, [user.id])
  made.threads.push(thread.id)
  const p = await TF.linkProject(user, thread, folder)
  assert.equal(p.mode, 'project')
  assert.equal(p.variation, null, '변형은 첫 턴에')

  work = await TF.prepareProjectWork({ user, thread })
  made.rooms.push(work.conv)
  assert.ok(work.conv, '대화 id 를 미리 줌')
  assert.equal((await q('select conversation_id from pro_threads where id=$1', [thread.id]))[0].conversation_id, work.conv)
  assert.match(work.v.branch, /^var\/p\//)
  assert.equal(work.v.title, '세미나 준비')
  assert.match(work.note, /프로젝트의 변형/)
  assert.ok(work.note.includes(work.container))
  assert.ok(work.note.includes('notice.md'))
  // the agent (shared disk) edits the checkout
  await fs.writeFile(path.join(work.dir, 'notice.md'), '# 안내문\n첫 줄\n확인함\n')
  const r = await TF.finishProjectWork(work, { stopped: true })
  assert.deepEqual(r.changed.map((c) => c.path), ['notice.md'])
  assert.equal(r.variation.status, 'ready')
  assert.equal(r.variation.worktree_path, null, '체크아웃은 턴이 끝나면 내려 놓음')
  assert.equal(await G.head(folder.repo_path, 'main'), mainBefore, 'main 은 그대로')
  assert.equal(String(await S.readBlob(folder, 'main', 'notice.md')), '# 안내문\n첫 줄\n')
  assert.equal(String(await G.show(folder.repo_path, r.variation.branch, 'notice.md')), '# 안내문\n첫 줄\n확인함\n')
  const chip = (await q(`select content from pro_messages where thread_id=$1 and kind='chip'`, [thread.id]))[0]
  assert.match(chip.content.text, /프로젝트 변형에 담았어요/)
  const pay = await TF.folderPayload(thread.id)
  assert.equal(pay.variation.id, work.v.id)
  assert.equal(pay.variation.ahead, 1)

  // the next turn: the same variation, checked out again with the change in it
  const w2 = await TF.prepareProjectWork({ user, thread: { ...thread, conversation_id: work.conv } })
  assert.equal(w2.v.id, work.v.id)
  assert.equal(await fs.readFile(path.join(w2.dir, 'notice.md'), 'utf8'), '# 안내문\n첫 줄\n확인함\n')
  const r2 = await TF.finishProjectWork(w2, { stopped: true })
  assert.equal(r2.changed.length, 0)
  assert.equal(r2.variation.status, 'ready', '바뀐 것이 없어도 프로젝트 변형은 남음')

  // after 반영 (merged) the project goes on in a new variation from main
  await S.setStatus(r2.variation, 'merged')
  const w3 = await TF.prepareProjectWork({ user, thread: { ...thread, conversation_id: work.conv } })
  assert.notEqual(w3.v.id, work.v.id)
  assert.match(w3.v.branch, /-2$/)
  await TF.finishProjectWork(w3, { stopped: true })
})

test('붙인 폴더 참고 힌트: 폴더 이름·읽는 도구·파일 목록, 고치지 말라는 말', { skip: !db }, async () => {
  const TF = await import('../lib/folders/threadFolders.js')
  const [chatT] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','채팅') returning *`, [user.id])
  made.threads.push(chatT.id)
  const p = await TF.attach(user, chatT, folder.slug)
  assert.equal(p.mode, 'ref')
  assert.equal(p.working, false)
  const hint = await TF.refHint(await TF.linkOf(chatT.id))
  assert.ok(hint.includes(folder.name) && hint.includes('folder_files') && hint.includes(folder.slug))
  assert.match(hint, /고치거나 그 안에 저장하지 마세요/)
  // a project's own folder can't be swapped for a reference
  await assert.rejects(TF.attach(user, thread, folder.slug), /이미 폴더에서 작업/)
  await TF.detach(user, chatT)
  assert.equal(await TF.linkOf(chatT.id), null)
})

test('프로젝트에서 시작한 인스턴스: 에이전트 단계에 프로젝트 폴더와 기준을 넣음', { skip: !db }, async () => {
  const TF = await import('../lib/folders/threadFolders.js')
  const [m] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','process','{}') returning id`, [thread.id])
  const inst = `tf-test.${Date.now()}`
  await TF.linkInstance(user.id, m.id, inst)
  await TF.linkInstance(user.id, m.id, inst)
  assert.deepEqual((await TF.linkOf(thread.id)).instances, [inst], '한 번만')
  const id = (await q('select gen_random_uuid() as id'))[0].id
  await q(`insert into todolist (id, user_id, activity_id, activity_name, status, tenant_id, proc_inst_id, root_proc_inst_id, agent_orch, agent_config, updated_at)
           values ($1,$2,'a1','초안 쓰기','TODO',$3,$4,$4,'deepagents','{}'::jsonb, now())`, [id, user.email, config.tenantId, inst])
  try {
    await TF.projectStepFolders()
    const [row] = await q('select agent_config from todolist where id=$1', [id])
    assert.equal(row.agent_config.folder, folder.id)
    assert.match(row.agent_config.base_ref, /^var:var\/p\/|^main$/)
  } finally { await q('delete from todolist where id=$1', [id]) }
})
