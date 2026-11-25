// 사람 이름 규칙(lib/people.js)의 검토 뒤 회귀(2026-11-25, 커밋 e98078b 검토): 화면이 부르는 이름은 화면에만 쓰고, Process GPT 의 행에는
// Process GPT 의 이름(users.username)을 그대로 쓴다. 지어낸 사람(이름 · 주소)으로 로컬 Supabase 에 대고 돈다.
//   PP-I-01 메신저: 방의 참여자 · 메시지의 mentionedUsers 는 users.username, 화면(구성원 · 보낸 사람)은 화면 이름
//   PP-I-02 폴더 변형 인계: todolist.username · handover_events.to_user_name · 받는 방의 참여자 · 변형의 holder_name 은 받는 사람의
//           users.username — 화면이 보낸 이름(아무 글)은 쓰지 않음, 에이전트 여부도 users 행이 정함, 없는 사람은 404
//   PP-I-03 팀원에게 보내기: 받는 사람의 name 은 화면 이름, username 은 Process GPT 의 것(공유 기록 handover_events 가 쓰는 것)
//   PP-I-04 이름 일부로 팀원 찾기: 화면 이름이 영문이어도 Process GPT 의 username 일부로 찾는다
//   PP-I-05 로그인 주소의 대소문자: 「PP-Case@People.Test」 는 pp-case@people.test 계정, 행에도 소문자
//   PP-I-06 폴더 목록: 여러 폴더의 구성원 이름을 한 번에 찾는다(폴더마다 따로 찾지 않음)
// Run: node --test --test-concurrency=1 test/people.integration.test.js  (로컬 Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-int-'))
process.env.PRO_FOLDERS_ROOT ||= path.join(root, 'folders')
const { q, pool, admin, ensureUser } = await import('../lib/supa.js')
const { config } = await import('../config.js')
const db = await q('select 1 from users limit 1').then(() => true).catch(() => false)
const T = config.tenantId
const stamp = Date.now().toString(36)
const made = { users: [], rooms: [], folders: [], auth: [], todos: [] }

// a person of this tenant on the team: Process GPT's username, Lite's profile name (undefined: no profile)
async function person(username, profileName, email = `pp-${crypto.randomBytes(4).toString('hex')}-${stamp}@people.test`) {
  const id = crypto.randomUUID()
  await q('insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)', [id, email, username, T])
  if (profileName !== undefined) await q('insert into pro_profile (user_id, name, email) values ($1,$2,$3)', [id, profileName, email])
  await q('insert into pro_team_members (tenant_id, user_id, added_by) values ($1,$2,$2) on conflict do nothing', [T, id])
  made.users.push(id)
  return { id, email, username, name: profileName ?? username }
}
let HY, YB, CD
const local = (e) => e.split('@')[0]
async function people() {
  if (HY) return
  const e = `pp-hayoon-${stamp}@people.test`
  HY = await person(local(e), '정하윤', e)                 // Process GPT holds her address's local part
  YB = await person(`봉여울${stamp}`, 'Yeoul Bong')        // Lite calls her by an English name, Process GPT by her Korean one
  CD = await person(`최도현${stamp}`)                       // never opened Lite
}

after(async () => {
  for (const id of made.rooms) {
    await q('delete from chats where id=$1', [id]).catch(() => {})
    await q('delete from pro_chat_reads where room_id=$1', [id]).catch(() => {})
    await q('delete from chat_rooms where id=$1', [id]).catch(() => {})
  }
  for (const id of made.todos) await q('delete from todolist where id=$1', [id]).catch(() => {})
  for (const f of made.folders) {
    await q('delete from handover_events where tenant_id=$1 and artifact_refs::text like $2', [T, `%${f.id}%`]).catch(() => {})
    await q('delete from pro_folders where id=$1', [f.id]).catch(() => {})
  }
  for (const id of made.users) {
    await q('delete from notifications where user_id=$1', [id]).catch(() => {})
    await q('delete from pro_team_members where user_id=$1', [id]).catch(() => {})
    await q('delete from pro_profile where user_id=$1', [id]).catch(() => {})
    await q('delete from users where id=$1', [id]).catch(() => {})
  }
  for (const id of made.auth) {
    await q('delete from users where id=$1', [id]).catch(() => {})
    await q('delete from pro_profile where user_id=$1', [id]).catch(() => {})
    await admin.auth.admin.deleteUser(id).catch(() => {})
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  await pool.end()
})

test('PP-I-01 메신저: 방의 참여자 · mentionedUsers 는 Process GPT 의 username, 화면은 화면 이름', { skip: !db }, async () => {
  await people()
  const M = await import('../lib/team/messenger.js')
  const me = { id: HY.id, email: HY.email, name: '정하윤' }
  const g = await M.groupThread(me, [YB.id, CD.id], '')
  made.rooms.push(g.id)
  const [room] = await q('select participants from chat_rooms where id=$1', [g.id])
  // (in the order they were chosen, the starter first)
  assert.deepEqual(room.participants.map((p) => [p.id, p.username]), [[HY.id, local(HY.email)], [YB.id, YB.username], [CD.id, CD.username]])
  const d = await M.directThread(me, YB.id)
  made.rooms.push(d.id)
  const [dr] = await q('select participants from chat_rooms where id=$1', [d.id])
  assert.deepEqual(dr.participants.map((p) => p.username).sort(), [local(HY.email), YB.username].sort())
  // a mention: Process GPT's resolveMentions matches what was typed against mentionedUsers[].username
  const m = await M.post(me, g.id, { body: `@${YB.username} 견적 봐 주세요`, mentions: [YB.id] })
  const [row] = await q('select messages from chats where uuid=$1', [m.id])
  assert.deepEqual(row.messages.mentionedUsers, [{ id: YB.id, email: YB.email, username: YB.username }])
  // the screens: the names every screen uses
  const ms = await M.membersOf(g.id)
  assert.deepEqual(ms.map((x) => x.name), ['정하윤', 'Yeoul Bong', CD.username])
  const view = await M.messages(me, g.id)
  assert.deepEqual(view.thread.members.map((x) => x.name), ['정하윤', 'Yeoul Bong', CD.username])
  assert.equal(JSON.stringify(view.thread.members).includes(local(HY.email)), false)
})

test('PP-I-02 변형 인계: Process GPT 의 행에는 받는 사람의 users.username — 화면이 보낸 이름은 쓰지 않는다', { skip: !db }, async () => {
  await people()
  const S = await import('../lib/folders/service.js')
  const H = await import('../lib/folders/handover.js')
  const owner = { id: HY.id, email: HY.email, name: '정하윤' }
  const f = await S.createFolder(owner, { name: `인계 시험 ${stamp}` })
  made.folders.push(f)
  const v = await S.createVariation(f, { title: '견적 정리', kind: 'person', holder: { type: 'user', id: HY.id, name: local(HY.email) }, createdBy: HY.id })
  // the page names her anything, and calls her an agent: neither is taken
  const r = await H.handover(f, v, owner, { to: { id: YB.id, name: '<b>아무 글</b>', isAgent: true, email: 'x@evil.test' }, next: '숫자 확인', grant: true })
  made.rooms.push(r.toRoomId)
  made.todos.push(r.toTaskId)
  const [todo] = await q('select username, user_id from todolist where id=$1', [r.toTaskId])
  assert.deepEqual(todo, { username: YB.username, user_id: YB.id })
  const [ev] = await q('select to_user_name, to_is_agent from handover_events where to_task_id=$1', [r.toTaskId])
  assert.deepEqual(ev, { to_user_name: YB.username, to_is_agent: false })
  const [room] = await q('select participants from chat_rooms where id=$1', [r.toRoomId])
  assert.deepEqual(room.participants, [{ id: YB.id, name: YB.username, email: YB.email, isAgent: false }])
  const [held] = await q('select holder_name, holder_type from pro_folder_variations where id=$1', [v.id])
  assert.deepEqual(held, { holder_name: YB.username, holder_type: 'user' })
  // the receiver Process GPT has, by id alone
  assert.deepEqual(await H.receiverOf(YB.id), { id: YB.id, name: YB.username, email: YB.email, isAgent: false, description: '' })
  assert.equal(await H.receiverOf(crypto.randomUUID()), null)
  await assert.rejects(H.handover(f, await S.variationById(v.id), owner, { to: { id: crypto.randomUUID(), name: '누구' }, next: 'x', grant: true }), (e) => e.status === 404)
})

test('PP-I-03 팀원에게 보내기: name 은 화면 이름, username 은 Process GPT 의 것', { skip: !db }, async () => {
  await people()
  const { resolveRecipients } = await import('../lib/team/access.js')
  const got = await resolveRecipients({ id: HY.id }, [{ type: 'user', id: YB.id }, { type: 'user', id: CD.id }])
  const by = Object.fromEntries(got.map((p) => [p.id, { name: p.name, username: p.username }]))
  assert.deepEqual(by[YB.id], { name: 'Yeoul Bong', username: YB.username })
  assert.deepEqual(by[CD.id], { name: CD.username, username: CD.username })
})

test('PP-I-04 이름 일부로 팀원 찾기: 화면 이름이 영문이어도 Process GPT 의 username 일부로', { skip: !db }, async () => {
  await people()
  const { resolveMember } = await import('../lib/team.js')
  const part = `여울${stamp}`
  for (const s of [part, `${part}님`, `${part}님께`.replace(/께$/, '')]) {
    const m = await resolveMember(s)
    assert.equal(m?.id, YB.id, s)
    assert.equal(m.name, 'Yeoul Bong')
    assert.equal('username' in m, false)
  }
  assert.equal((await resolveMember('Yeoul Bong'))?.id, YB.id)
})

test('PP-I-05 로그인 주소의 대소문자: 같은 계정, 행에는 소문자', { skip: !db }, async () => {
  const lower = `pp-case-${stamp}@people.test`
  const u1 = await ensureUser(`PP-Case-${stamp}@People.Test`, null)
  made.auth.push(u1.id)
  assert.equal(u1.email, lower)
  const [row] = await q('select email, username from users where id=$1 and tenant_id=$2', [u1.id, T])
  assert.deepEqual(row, { email: lower, username: `pp-case-${stamp}` })
  // the same account however it is typed (no "already been registered")
  assert.equal((await ensureUser(lower, null)).id, u1.id)
  assert.equal((await ensureUser(`  ${lower.toUpperCase()} `, null)).id, u1.id)
  const { normEmail } = await import('../lib/supa.js')
  assert.equal(normEmail(' Kim@Corp.COM '), 'kim@corp.com')
})

test('PP-I-06 폴더 목록: 여러 폴더의 구성원 이름을 한 번에 찾는다', { skip: !db }, async () => {
  await people()
  const S = await import('../lib/folders/service.js')
  const ids = []
  for (let i = 0; i < 3; i++) {
    const [f] = await q(`insert into pro_folders (tenant_id, slug, name, kind, repo_path, created_by) values ($1,$2,$3,'managed','/nonexistent',$4) returning id::text as id`,
      [T, `pp-list-${stamp}-${i}`, `목록 시험 ${stamp} ${i}`, HY.id])
    made.folders.push(f)
    ids.push(f.id)
    await q(`insert into pro_folder_members (folder_id, principal_type, principal_id, role) values ($1,'user',$2,'owner'), ($1,'user',$3,'viewer'), ($1,'agent','agent-${i}','runner')`, [f.id, HY.id, YB.id])
  }
  const calls = []
  const { people: resolve } = await import('../lib/people.js')
  const spy = (list) => { calls.push(list); return resolve(list) }
  const all = await S.membersOfFolders(ids, { resolve: spy })
  assert.equal(calls.length, 1)
  assert.deepEqual([...calls[0]].sort(), [HY.id, YB.id].sort())
  // each folder's own members, in role order (owner · runner · viewer): people by the screens' name, an agent by its own
  for (const [i, id] of ids.entries()) assert.deepEqual(all.get(id).map((m) => [m.type, m.name]), [['user', '정하윤'], ['agent', `agent-${i}`], ['user', 'Yeoul Bong']])
  // one folder alone, and the list a person sees: the same members
  assert.deepEqual((await S.members(ids[0])).map((m) => m.name), all.get(ids[0]).map((m) => m.name))
  const mine = (await S.listFolders({ id: HY.id })).filter((f) => ids.includes(String(f.id)))
  assert.equal(mine.length, 3)
  for (const f of mine) assert.deepEqual(f.members.filter((m) => m.type === 'user').map((m) => m.name).sort(), ['Yeoul Bong', '정하윤'].sort())
})
