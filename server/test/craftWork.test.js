// ArtCraft 앱의 MCP 가 에이전트와 디스크를 나누지 않는 설치(운영 k8s: deepagents 가 다른 파드)에서도 도는지 — 모델·DB·Storage 없이:
//   - /workspace 가 이 서버에 없으면 사람마다 대신 폴더(PRO_CRAFT_WORK_ROOT/<테넌트>/<사람>)가 그 자리를 맡는다
//   - 도구가 쓸 대화 폴더 파일은 그 폴더의 storage 사본에서, 내 첨부·카드는 storage 주소에서 가져다 둔다
//   - 도구가 대화 폴더에 쓴 파일은 그 폴더의 storage 사본(skills/<테넌트>/<방>/…)으로 올라간다
//   - 받기·올리기는 그 사람이 쓸 수 있는 대화 폴더만: 자기 대화, 구성원인 공유 폴더의 실행 방, 참여한 프로세스 인스턴스
//   - 채팅 카드는 그 사람의 대신 폴더에서 파일을 찾는다(documentsOfRun · publish)
//   - 경로는 /workspace 안에서만(그 밖의 절대 경로, 상위 폴더 조각 거절)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'craftwork-test-'))
// no deepagents workspace on this machine, and the stand-in in a folder of this test
process.env.PGPT_ROOT = path.join(tmp, 'no-process-gpt')
process.env.PRO_CRAFT_WORK_ROOT = path.join(tmp, 'work')
process.env.PRO_SUPABASE_URL = 'https://supa.example.test'
// (the client is made at import; nothing here reaches Supabase)
process.env.SERVICE_ROLE_KEY ||= 'test-service-key'
process.env.ANON_KEY ||= 'test-anon-key'
const { config } = await import('../config.js')
const W = await import('../lib/craftWork.js')
const { toHost } = await import('../mcp/craft.js')
const { documentsOfRun, publish } = await import('../lib/office.js')
const { admin } = await import('../lib/supa.js')
after(() => fs.rm(tmp, { recursive: true, force: true }))

const USER = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-2222-3333-4444-555555555555'
const ROOM = 'c0ffee00c0ffee00c0ffee00c0ffee00' // USER's conversation
const THEIRS = 'beef0000beef0000beef0000beef0000' // OTHER's conversation
const FOLDER_ROOM = 'f01de700f01de700f01de700f01de700' // a shared folder's run room; USER is a runner of that folder
// the existing lookups (lib/workroom.js ownsConversation · takesPartInInstance, lib/folders/work.js folderOfRoom,
// lib/folders/rooms.js folderRoomAccess) as this test's data
const asked = []
const RULES = W.roomRules({
  owns: async (userId, room) => (userId === USER && room === ROOM) || (userId === OTHER && room === THEIRS),
  folderOfRoom: async (room) => (room === FOLDER_ROOM ? 'folder-1' : null),
  folderAccess: async (user, r) => { asked.push(r); return r.folder === 'folder-1' && r.need === 'runner' && user.id === USER },
  takesPart: async () => false,
})
const gate = () => W.roomGate({ id: USER }, RULES)

test('workspace 가 이 서버에 없으면 그 사람의 대신 폴더, 있으면 그 폴더', async () => {
  const r = await W.craftRoot({ userId: USER })
  assert.equal(r.standIn, true)
  assert.equal(r.root, path.join(tmp, 'work', config.tenantId, USER))
  assert.ok((await fs.stat(r.root)).isDirectory())
  assert.notEqual((await W.craftRoot({ userId: OTHER })).root, r.root)
  const shared = await W.craftRoot({ userId: USER, shared: async () => '/srv/deepagents/workspace/t1' })
  assert.deepEqual(shared, { root: '/srv/deepagents/workspace/t1', standIn: false })
})

test('경로는 /workspace 안에서만: 그 밖의 절대 경로·상위 폴더 조각은 거절, 글자 속 점은 그대로', async () => {
  const { root } = await W.craftRoot({ userId: USER })
  assert.equal(await toHost(`/workspace/.bpmn/${ROOM}/평면도.dxf`, root), path.join(root, '.bpmn', ROOM, '평면도.dxf'))
  await assert.rejects(toHost('/etc/passwd', root), /only paths under \/workspace/)
  await assert.rejects(toHost({ params: { path: '../../data/x.json' } }, root), /go up a folder/)
  await assert.rejects(toHost('/workspace/../x.dxf', root), /go up a folder/)
  await assert.rejects(toHost('a\\..\\b.psd', root), /go up a folder/)
  assert.equal(await toHost('Loading... 1/2', root), 'Loading... 1/2')
  assert.equal(await toHost('plan.dxf', root), 'plan.dxf')
})

test('내 첨부·카드의 storage 주소는 내려받아 /workspace/uploads/<나>/files/ 경로로, 남의 것은 그대로', async () => {
  const { root, standIn } = await W.craftRoot({ userId: USER })
  const got = []
  const io = { download: async (key) => { got.push(key); return Buffer.from('PNGDATA') }, fetchRoomFile: async () => null }
  const mine = `${config.supabaseUrl}/storage/v1/object/public/files/pgpt-pro/${USER}/att/abc.png`
  const theirs = `${config.supabaseUrl}/storage/v1/object/public/files/pgpt-pro/${OTHER}/att/x.png`
  const out = await W.prepareArgs({ path: mine, other: theirs, list: [mine] }, { root, standIn, userId: USER, gate: gate(), io })
  assert.equal(out.path, `/workspace/uploads/${USER}/files/abc.png`)
  assert.equal(out.list[0], out.path)
  assert.equal(out.other, theirs)
  assert.deepEqual(got, [`pgpt-pro/${USER}/att/abc.png`]) // once: the second mention finds it there
  assert.equal(await fs.readFile(path.join(root, 'uploads', USER, 'files', 'abc.png'), 'utf8'), 'PNGDATA')
  assert.equal(W.ownFileKey(`${config.supabaseUrl}/storage/v1/object/public/files/pgpt-pro/${USER}/../x/a.png`, USER), null)
})

test('내 대화 폴더: 없는 파일은 storage 사본에서 받고, 도구가 쓴 파일은 사본으로 올린다(이번 호출에 바뀐 것만, 숨은 파일 빼고)', async () => {
  const { root, standIn } = await W.craftRoot({ userId: USER })
  const fetched = []
  const io = { download: async () => { throw new Error('not used') }, fetchRoomFile: async (p) => { fetched.push(p); return { buf: Buffer.from('PSD') } } }
  const p = `/workspace/.bpmn/${ROOM}/사진.psd`
  await W.prepareArgs({ path: p }, { root, standIn, userId: USER, gate: gate(), io })
  assert.equal(await fs.readFile(path.join(root, '.bpmn', ROOM, '사진.psd'), 'utf8'), 'PSD')
  await W.prepareArgs({ path: p }, { root, standIn, userId: USER, gate: gate(), io })
  assert.deepEqual(fetched, [p]) // already here: not fetched again
  // a shared workspace is the truth: nothing is fetched into it
  const none = []
  await W.prepareArgs({ path: `/workspace/.bpmn/${ROOM}/없음.psd` }, { root, standIn: false, userId: USER, io: { ...io, fetchRoomFile: async (x) => { none.push(x); return null } } })
  assert.deepEqual(none, [])

  const dir = path.join(root, '.bpmn', ROOM)
  await fs.mkdir(path.join(dir, '도면'), { recursive: true })
  await fs.writeFile(path.join(dir, 'old.dxf'), 'old')
  const past = new Date(Date.now() - 3600_000)
  for (const f of ['old.dxf', '사진.psd']) await fs.utimes(path.join(dir, f), past, past)
  const since = Date.now()
  await fs.writeFile(path.join(dir, '도면', '평면도.dxf'), 'new')
  await fs.writeFile(path.join(dir, '.lock'), 'x')
  const up = []
  const pushed = await W.pushChanged({ root, rooms: W.roomsOf({ path: `/workspace/.bpmn/${ROOM}/도면/평면도.dxf` }), since, gate: gate(), io: { upload: async (key, buf) => up.push([key, String(buf)]) } })
  assert.deepEqual(pushed, [`/workspace/.bpmn/${ROOM}/도면/평면도.dxf`])
  assert.equal(up.length, 1)
  assert.match(up[0][0], new RegExp(`^skills/${config.tenantId}/${ROOM}/__u8__`)) // deepagents' key encoding (roomStore)
  assert.equal(up[0][1], 'new')
  // a later save without a path writes where the document came from: the session remembers its folders
  assert.deepEqual([...W.roomsWorked('cadcraft:u1', W.roomsOf({ path: `/workspace/.bpmn/${ROOM}/a.dxf` }))], [ROOM])
  assert.deepEqual([...W.roomsWorked('cadcraft:u1', new Set())], [ROOM])
})

test('다른 사람의 대화 폴더는 받지도 올리지도 않는다 — 도구는 그 자리에서 아무것도 찾지 못한다', async () => {
  const { root, standIn } = await W.craftRoot({ userId: USER })
  const g = gate()
  const fetched = []
  const io = { download: async () => { throw new Error('not used') }, fetchRoomFile: async (p) => { fetched.push(p); return { buf: Buffer.from('SECRET') } } }
  const p = `/workspace/.bpmn/${THEIRS}/계약서.psd`
  const out = await W.prepareArgs({ path: p }, { root, standIn, userId: USER, gate: g, io })
  assert.equal(out.path, p) // passed on as it is: the tool's own "not found"
  assert.deepEqual(fetched, [])
  assert.equal(await fs.stat(path.join(root, '.bpmn', THEIRS)).catch(() => null), null)
  // a save there is not given the folder, and nothing written there goes up
  const host = await toHost(`/workspace/.bpmn/${THEIRS}/새.dxf`, root, g)
  assert.equal(await fs.stat(path.dirname(host)).catch(() => null), null)
  await fs.mkdir(path.dirname(host), { recursive: true })
  await fs.writeFile(host, 'x')
  const up = []
  const pushed = await W.pushChanged({ root, rooms: new Set([THEIRS]), since: Date.now() - 5000, gate: g, io: { upload: async (key) => up.push(key) } })
  assert.deepEqual(pushed, [])
  assert.deepEqual(up, [])
  assert.deepEqual([...g.denied], [THEIRS]) // said once for the call, without a file name
  assert.deepEqual([...await g.filter(new Set([ROOM, THEIRS]))], [ROOM])
  // and the other person's own stand-in is not this person's
  assert.notEqual((await W.craftRoot({ userId: OTHER })).root, root)
})

test('구성원인 공유 폴더의 실행 방은 쓸 수 있다(실행 권한 이상), 아니면 안 된다', async () => {
  const { root, standIn } = await W.craftRoot({ userId: USER })
  const fetched = []
  const io = { download: async () => { throw new Error('not used') }, fetchRoomFile: async (p) => { fetched.push(p); return { buf: Buffer.from('DXF') } } }
  const p = `/workspace/.bpmn/${FOLDER_ROOM}/folders/sales/도면.dxf`
  await W.prepareArgs({ path: p }, { root, standIn, userId: USER, gate: gate(), io })
  assert.deepEqual(fetched, [p])
  assert.deepEqual(asked.at(-1), { folder: 'folder-1', need: 'runner' })
  const up = []
  await fs.writeFile(path.join(root, '.bpmn', FOLDER_ROOM, 'folders', 'sales', '도면.dxf'), 'edited')
  await W.pushChanged({ root, rooms: new Set([FOLDER_ROOM]), since: Date.now() - 5000, gate: gate(), io: { upload: async (key) => up.push(key) } })
  assert.equal(up.length, 1)
  // a person who is not a member of that folder
  assert.equal(await W.mayUseRoom({ id: OTHER }, FOLDER_ROOM, RULES), false)
  assert.equal(await W.mayUseRoom({ id: USER }, '..', RULES), false)
})

test('채팅 카드: 그 사람의 대신 폴더에서 답에 적힌 경로·대화 폴더의 파일을 찾고, 그 바이트를 올린다', async () => {
  const { root } = await W.craftRoot({ userId: USER })
  const since = Date.now() - 1000
  await fs.mkdir(path.join(root, '.bpmn', ROOM), { recursive: true })
  await fs.writeFile(path.join(root, '.bpmn', ROOM, '배너.svg'), '<svg/>')
  const docs = await documentsOfRun({ text: `저장했어요: /workspace/.bpmn/${ROOM}/배너.svg`, dirs: [`/workspace/.bpmn/${ROOM}`], since, userId: USER })
  assert.ok(docs.includes(`/workspace/.bpmn/${ROOM}/배너.svg`), JSON.stringify(docs))
  // another person's turn does not find it
  assert.deepEqual(await documentsOfRun({ text: `/workspace/.bpmn/${ROOM}/배너.svg`, dirs: [`/workspace/.bpmn/${ROOM}`], since, userId: OTHER }), [])
  assert.equal(await W.standInPath(`/workspace/.bpmn/${ROOM}/없는.svg`, { userId: USER }), null)
  assert.equal(await W.standInPath(`/workspace/.bpmn/${ROOM}/배너.svg`, { userId: USER, shared: async () => '/elsewhere' }), null)
  // publish reads the person's stand-in (no deepagents copy, no room copy needed)
  const uploads = []
  Object.defineProperty(admin, 'storage', { configurable: true, value: { from: () => ({ upload: async (key, buf) => { uploads.push([key, String(buf)]); return { error: null } } }) } })
  try {
    const card = await publish(USER, `/workspace/.bpmn/${ROOM}/배너.svg`)
    assert.equal(card.name, '배너.svg')
    assert.equal(uploads[0][1], '<svg/>')
    assert.match(uploads[0][0], new RegExp(`^pgpt-pro/${USER}/.+\\.svg$`))
  } finally { delete admin.storage }
})

test('하루 지난 파일과 빈 폴더는 치우고 테넌트·사람 폴더는 남긴다', async () => {
  const base = path.join(tmp, 'sweep')
  const person = path.join(base, 't1', 'u1')
  const room = path.join(person, '.bpmn', 'r1')
  await fs.mkdir(room, { recursive: true })
  await fs.mkdir(path.join(base, 't1', 'u2'), { recursive: true })
  await fs.writeFile(path.join(room, 'old.wav'), 'x')
  await fs.writeFile(path.join(person, 'new.svg'), 'y')
  const old = new Date(Date.now() - 2 * 86400_000)
  await fs.utimes(path.join(room, 'old.wav'), old, old)
  for (const d of [room, path.dirname(room), path.join(base, 't1', 'u2')]) await fs.utimes(d, old, old)
  await W.sweep(base)
  assert.equal(await fs.stat(path.join(room, 'old.wav')).catch(() => null), null)
  assert.equal(await fs.stat(room).catch(() => null), null)
  assert.ok(await fs.stat(path.join(person, 'new.svg')))
  assert.ok(await fs.stat(path.join(base, 't1', 'u2'))) // an empty person's folder stays
})
