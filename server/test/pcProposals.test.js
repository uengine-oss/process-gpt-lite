// 「스킬을 등록할까요?」 · 「폴더를 올릴까요?」 — a person's own CLI proposes a skill or a folder of their PC (lib/localAgents/pcTools.js,
// spec openspec/specs/local-agents 「채팅에서 내 PC 의 스킬 · 폴더를 등록 제안」 · champion-folders 「채팅으로 폴더 올리기 제안」), with fake
// desktop links (what a link is sent is recorded), the database and a stand-in deepagents (its skill upload — 회사 스킬):
//   PT-01 the run's tool token: signed, scoped (person · device · job), expires; forged · another kind · expired → nothing
//   PT-02 a chat run gets a token only on a desktop with the tools (0.2.8); an older one gets the note in its prompt and the picker says so
//   PT-03 the token works only while that chat run is on, on that device, for that person (revoked device · run over → 403)
//   PT-04 a skill's files are checked again here: paths, secret names, sure key shapes, git control files, SKILL.md, size, name taken;
//         its run settings are read here (whatever the app said)
//   PT-05 the card: only its person sees it (404); 「등록」 needs the confirmation of what was shown; → a private skill of theirs (listed),
//         the staged files go; a second press 409
//   PT-06 「회사 스킬」 by the skill folder's own rule (its author may share it — not only an administrator); with run settings one more
//         check (409 runs_confirm) → installed (deepagents)
//   PT-07 after an hour: expired — 409 on 「등록」, the staged files go
//   PT-08 a folder: only a desktop that can upload folders; 「올리기」 → the Lite folder (champion), the PC is asked (tools:upload with its own
//         pick id, never a path); its answer finishes the card — done, or (nothing went up) the folder goes and the card can be pressed again;
//         a pick the PC lost → failed; the PC off → 409
//   PT-09 the read-only lists; at most 10 proposals wait at once (429)
// Run: node --test --test-concurrency=1 test/pcProposals.test.js  (the local database with sql/068; tenant "pctools-test")
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'

const TENANT = 'pctools-test'
const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'pgl-pctools-'))
// a stand-in deepagents: the skill upload 「회사 스킬」 sends (folders/skills.js share)
const uploads = []
const dagents = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => { uploads.push({ url: req.url, bytes: Buffer.concat(chunks).length }); res.setHeader('content-type', 'application/json'); res.end('{}') })
})
await new Promise((r) => dagents.listen(0, '127.0.0.1', r))
// (the skills a person registers are kept under process-gpt's folders — PGPT_ROOT: a temporary one here; its secrets are read from the
// real checkout's .env as config.js would, into this process only)
{
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
  const real = [path.join(repo, 'backends', 'process-gpt'), path.join(os.homedir(), 'process-gpt')].find((p) => fs.existsSync(path.join(p, 'services')))
  const env = real && fs.existsSync(path.join(real, '.env')) ? (await import('dotenv')).parse(fs.readFileSync(path.join(real, '.env'))) : {}
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v
}
Object.assign(process.env, { PRO_TENANT_ID: TENANT, PRO_TENANT_HOSTS: '', PRO_FOLDERS_ROOT: path.join(ROOT, 'folders'), PGPT_ROOT: path.join(ROOT, 'pgpt'),
  PRO_LLM_BASE_URL: 'http://127.0.0.1:9/v1', PRO_DEEPAGENTS_URL: `http://127.0.0.1:${dagents.address().port}`, PRO_DESKTOP_LATEST: '0.2.8' })
await fsp.mkdir(path.join(ROOT, 'pgpt', 'services'), { recursive: true })
const { q, pool } = await import('../lib/supa.js')
const D = await import('../lib/localAgents/devices.js')
const H = await import('../lib/localAgents/hub.js')
const ST = await import('../lib/localAgents/steps.js')
const CH = await import('../lib/localAgents/chat.js')
const PT = await import('../lib/localAgents/pcTools.js')
const SK = await import('../lib/folders/skills.js')
const S = await import('../lib/folders/service.js')
const { withLang } = await import('../lib/lang.js')
const db = await q(`select 1 from pro_pc_proposals limit 1`).then(() => true).catch(() => false)
if (db) await q('insert into tenants (id) values ($1) on conflict do nothing', [TENANT])

const users = []
async function person(name, { admin = false } = {}) {
  const u = { id: crypto.randomUUID(), name, email: `${crypto.randomBytes(3).toString('hex')}@pctools.test` }
  users.push(u.id)
  await q(`insert into pro_profile (user_id, name, email) values ($1,$2,$3) on conflict (user_id) do update set name=$2`, [u.id, name, u.email])
  await q(`insert into users (id, email, username, tenant_id, is_admin) values ($1,$2,$3,$4,$5)`, [u.id, u.email, name, TENANT, admin])
  return u
}
// a desktop as the hub sees it (what it is sent is recorded)
async function desktop(user, { tools = true, folders = true } = {}) {
  const { token, device } = await D.issue(user, { name: `${user.name}의 맥`, platform: 'darwin', appVersion: tools ? '0.2.8' : '0.2.7' })
  const got = []
  const transport = { send: (t) => got.push(JSON.parse(t)), close: (code) => got.push({ type: 'closed', code }) }
  const link = await H.open(transport, { type: 'hello', token, device: { name: `${user.name}의 맥`, appVersion: tools ? '0.2.8' : '0.2.7' },
    caps: { clis: { 'claude-code': { installed: true, version: '2.1.331' } }, maxJobs: 2, terminal: true, conversation: true, chat: true, leaveOffSettings: true, folders,
      ...(tools ? { liteTools: true, liteFolders: folders } : {}) }, prefs: { enabled: true }, active: [] })
  assert.ok(!link.error, link.error)
  return { link, got, device, jobs: () => got.filter((m) => m.type === 'job').map((m) => m.job) }
}
const threadOf = async (user) => (await q(`insert into pro_threads (user_id, kind, title) values ($1,'chat','채팅') returning *`, [user.id]))[0]
// a chat message to his Claude Code: the run goes to his desktop (offered) → {job (the row), payload (what the desktop got), ctx}
async function chatRun(user, pc, thread = null) {
  const t = thread || await threadOf(user)
  const r = await CH.send({ user, thread: t, text: '내 PC 의 스킬을 등록해 줘', agent: 'claude-code' })
  const [job] = await q('select * from pro_local_jobs where id=$1', [r.jobId])
  const payload = pc.jobs().find((j) => j.id === job.id)
  return { job, payload, thread: t }
}
const ctxOf = async (payload) => withLang('ko', async () => PT.access(PT.verifyToken(payload.tools.token)))
const b64 = (s) => Buffer.from(s).toString('base64')
const SKILL_MD = (name, extra = '') => `---\nname: ${name}\ndescription: 견적서를 회사 양식으로 쓰는 법\n${extra}---\n# ${name}\n견적서는 부가세를 따로 적어요.\n`
const skillBody = (name, { extra = '', files = [] } = {}) => ({ name, description: '견적서를 회사 양식으로 쓰는 법', scope: 'mine', source: { where: 'claude', label: name },
  files: [{ path: 'SKILL.md', data: b64(SKILL_MD(name, extra)) }, { path: 'templates/견적서.md', data: b64('| 품목 | 금액 |\n') }, ...files],
  summary: { excluded: [{ group: 'secret', count: 1, samples: ['.env'] }], flagged: 0, runs: [] } })
const cardOf = async (id) => (await q(`select * from pro_messages where kind='pc_proposal' and content->'pc'->>'id'=$1`, [id]))[0]
const staged = (id) => path.join(ROOT, 'folders', TENANT, '.pc-proposals', id)
const code = async (p) => { try { await p; return 200 } catch (e) { return `${e.status}${e.code ? ` ${e.code}` : ''}` } }

before(async () => { if (!db) return; ST.wire(); CH.wireChat() })
after(async () => {
  if (db) {
    for (const t of ['pro_pc_proposals', 'pro_local_jobs', 'pro_local_devices', 'pro_chat_agents', 'pro_folders', 'pro_skill_visibility']) await q(`delete from ${t} where tenant_id=$1`, [TENANT]).catch(() => {})
    await q(`delete from pro_folder_sources where tenant_id=$1`, [TENANT]).catch(() => {})
    for (const u of users) {
      await q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [u]).catch(() => {})
      await q(`delete from pro_thread_folders where user_id=$1`, [u]).catch(() => {})
      await q(`delete from pro_threads where user_id=$1`, [u]).catch(() => {})
      await q(`delete from pro_profile where user_id=$1`, [u]).catch(() => {})
      await q(`delete from users where id=$1`, [u]).catch(() => {})
    }
  }
  H.reset()
  dagents.close()
  await pool.end()
  await fsp.rm(ROOT, { recursive: true, force: true })
})

test('PT-01 실행의 도구 토큰: 서명 · 범위(사람 · 기기 · 일) · 만료 — 위조 · 다른 종류 · 지난 것은 없는 것', () => {
  const [u, d, j] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const t = PT.mintToken({ tenant: TENANT, user: u, device: d, job: j })
  assert.match(t, /^plt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  const c = PT.verifyToken(t)
  assert.deepEqual([c.tenant, c.user, c.device, c.job, c.scope], [TENANT, u, d, j, 'pc-tools'])
  const [, body, sig] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ ...c, user: crypto.randomUUID() })).toString('base64url')
  assert.equal(PT.verifyToken(`plt1.${forged}.${sig}`), null, 'another person in the body')
  assert.equal(PT.verifyToken(`pgf1.${body}.${sig}`), null, 'another kind of token')
  assert.equal(PT.verifyToken(PT.mintToken({ tenant: TENANT, user: u, device: d, job: j, now: Date.now() - 2 * 3600_000 })), null, 'past its time')
  assert.ok(PT.verifyToken(t, { now: Date.now() + 89 * 60_000 }) && !PT.verifyToken(t, { now: Date.now() + 91 * 60_000 }), '90 minutes')
  assert.throws(() => PT.mintToken({ user: 'x', device: d, job: j }))
})

test('PT-02 도구가 있는 데스크톱(0.2.8)의 채팅 실행에만 토큰 — 옛 앱은 프롬프트에 안내, 고르기에 「올리면」', { skip: !db }, async () => {
  const a = await person('윤태호')
  const pc = await desktop(a)
  const { payload } = await chatRun(a, pc)
  assert.ok(payload.tools?.token, 'a tool token in the job')
  assert.equal(PT.verifyToken(payload.tools.token).device, pc.device.id)
  assert.doesNotMatch(payload.prompt, /0\.2\.8 이상/)
  await H.gone(pc.link)
  const b = await person('서하린')
  const old = await desktop(b, { tools: false })
  const r2 = await chatRun(b, old)
  assert.equal(r2.payload.tools, undefined, 'no token for an app without the tools')
  assert.match(r2.payload.prompt, /0\.2\.8 이상으로 업데이트하면/, 'its CLI is told what to say when asked')
  assert.match(r2.payload.prompt, /processgptlite\.html#desktop/)
  const av = await CH.availability(b)
  const cc = av.agents.find((x) => x.id === 'claude-code')
  assert.equal(cc.available, true)
  assert.equal(cc.update, true)
  assert.match(cc.note, /0\.2\.8 이상으로 업데이트하면/)
  await H.gone(old.link)
})

test('PT-03 토큰은 그 사람 · 그 기기 · 켜져 있는 그 채팅 실행에만 — 연결 끊은 기기 · 끝난 실행은 403', { skip: !db }, async () => {
  const a = await person('김서연')
  const pc = await desktop(a)
  const { job, payload } = await chatRun(a, pc)
  const ctx = await ctxOf(payload)
  assert.equal(ctx.user.id, a.id)
  assert.equal(ctx.user.name, '김서연')
  assert.equal(ctx.job.id, job.id)
  await q(`update pro_local_jobs set state='done' where id=$1`, [job.id])
  assert.equal(await code(ctxOf(payload)), '403 job_over')
  await q(`update pro_local_jobs set state='running' where id=$1`, [job.id])
  await D.revoke(a, pc.device.id)
  assert.equal(await code(ctxOf(payload)), '403 device')
  await H.gone(pc.link)
})

let mine // {a, pc, run, ctx}
test('PT-04 스킬의 파일은 서버가 다시 본다 — 경로 · 비밀 이름 · 확실한 열쇠 · git 제어 파일 · SKILL.md · 크기 · 같은 이름, 실행 설정은 서버가 읽는다', { skip: !db }, async () => {
  const a = await person('정하윤')
  const pc = await desktop(a)
  const run = await chatRun(a, pc)
  const ctx = await ctxOf(run.payload)
  const propose = (body) => withLang('ko', () => PT.proposeSkill(ctx, body))
  for (const p of ['../밖.md', '/etc/passwd', 'a/../../b', '.git/config', 'a\\b.md', 'x//y.md']) assert.equal(await code(propose(skillBody('견적-규칙', { files: [{ path: p, data: b64('x') }] }))), '400 bad_path', p)
  assert.equal(await code(propose(skillBody('견적-규칙', { files: [{ path: '.env', data: b64('A=1') }] }))), '422 refused', 'a secret by its name')
  assert.equal(await code(propose(skillBody('견적-규칙', { files: [{ path: 'notes.md', data: b64(`token: ghp_${'a1B2'.repeat(9)}`) }] }))), '422 refused', 'a key of a sure shape')
  assert.equal(await code(propose(skillBody('견적-규칙', { files: [{ path: '.gitmodules', data: b64('[submodule]') }] }))), '422 refused', 'git control file')
  assert.equal(await code(propose({ ...skillBody('견적-규칙'), files: [{ path: 'README.md', data: b64('# x') }] })), '400 no_skill_md')
  assert.equal(await code(propose({ ...skillBody('견적-규칙'), files: Array.from({ length: 301 }, (_, i) => ({ path: `f${i}.md`, data: b64('x') })) })), '413 too_many')
  assert.equal(await code(propose(skillBody('../x'))), '400 bad_name')
  // a skill already there by that name
  await q(`insert into pro_skill_visibility (tenant_id, skill_name, visibility, author_id) values ($1,'있는-스킬','private',$2)`, [TENANT, a.id])
  assert.equal(await code(propose(skillBody('있는-스킬'))), '409 name_taken')
  // a good one, whose front matter runs things although the app said none
  const out = await propose(skillBody('견적-규칙', { extra: 'allowed-tools: Bash\nhooks:\n  PreToolUse: []\n' }))
  assert.equal(out.name, '견적-규칙')
  assert.equal(out.expiresInMinutes, 60)
  const [row] = await q('select * from pro_pc_proposals where id=$1', [out.id])
  assert.deepEqual(row.summary.runs.sort(), ['allowed-tools', 'hooks'], 'read here')
  assert.equal(row.summary.files, 2)
  assert.equal(row.summary.source.where, 'claude')
  assert.ok(fs.existsSync(path.join(staged(out.id), 'templates', '견적서.md')), 'its files wait in a place of the server')
  const card = await cardOf(out.id)
  assert.equal(card.thread_id, run.thread.id, 'in the chat of the run')
  assert.equal(card.role, 'agent')
  assert.equal(card.content.owner, a.id)
  assert.equal(card.content.text, '스킬을 등록할까요? · 견적-규칙')
  mine = { a, pc, run, ctx, id: out.id }
})

test('PT-05 카드: 그 사람만 본다 · 보인 그대로의 확인 · 「등록」 → 그 사람의 스킬(목록에), 기다리던 파일은 지움 · 두 번 누르면 409', { skip: !db }, async () => {
  const { a, id } = mine
  const b = await person('김서연')
  assert.equal(await code(PT.view(b, id)), '404', 'someone else')
  assert.equal(await code(PT.register(b, id, { confirm: 'x' })), '404')
  const v = await withLang('ko', () => PT.view(a, id))
  assert.equal(v.state, 'pending')
  assert.equal(v.kind, 'skill')
  assert.equal(v.options.company, true, 'not an administrator, yet the author of what she registers — 「전사에 공유」 is the author\'s')
  assert.deepEqual(v.runs.sort(), ['allowed-tools', 'hooks'])
  assert.ok(v.confirm)
  assert.equal(await code(withLang('ko', () => PT.register(a, id, { confirm: `${Date.now()}.forged` }))), '409 stale')
  const done = await withLang('ko', () => PT.register(a, id, { scope: 'mine', confirm: v.confirm }))
  assert.equal(done.state, 'done')
  assert.equal(done.result.visibility, 'private')
  assert.equal(done.result.name, '견적-규칙')
  const vis = await SK.visibility('견적-규칙')
  assert.equal(vis.visibility, 'private')
  assert.equal(String(vis.author_id), a.id)
  const listed = await SK.listSkills(a)
  assert.ok(listed.some((s) => s.name === '견적-규칙' && s.mine), 'in their skills')
  assert.ok(!(await SK.listSkills(b)).some((s) => s.name === '견적-규칙'), 'not in anyone else\'s')
  const f = await SK.skillFolder('견적-규칙')
  assert.match(fs.readFileSync(path.join(f.repo_path, 'templates', '견적서.md'), 'utf8'), /품목/)
  assert.ok(!fs.existsSync(staged(id)), 'the waiting files are gone')
  assert.equal((await cardOf(id)).content.pc.state, 'done')
  assert.equal(await code(withLang('ko', () => PT.register(a, id, { confirm: v.confirm }))), '409 closed', 'a second press')
})

test('PT-06 「회사 스킬」은 스킬 폴더의 「전사에 공유」와 같은 규칙(작성자 — 관리자가 아니어도) · 실행 설정이 있으면 한 번 더 확인 → 회사에 설치', { skip: !db }, async () => {
  const boss = await person('한서윤')
  const pc = await desktop(boss)
  const run = await chatRun(boss, pc)
  const ctx = await ctxOf(run.payload)
  const out = await withLang('ko', () => PT.proposeSkill(ctx, skillBody('회의록-정리', { extra: 'hooks:\n  Stop: []\n' })))
  const v = await withLang('ko', () => PT.view(boss, out.id))
  assert.equal(v.options.company, true)
  assert.equal(await code(withLang('ko', () => PT.register(boss, out.id, { scope: 'company', confirm: v.confirm }))), '409 runs_confirm')
  const before = uploads.length
  const done = await withLang('ko', () => PT.register(boss, out.id, { scope: 'company', runsOk: true, confirm: v.confirm, jwt: 'jwt-of-the-person' }))
  assert.equal(done.result.visibility, 'tenant')
  assert.equal(uploads.length, before + 1, 'deepagents got the skill')
  assert.match(uploads.at(-1).url, /\/skills\/upload/)
  assert.equal((await SK.visibility('회의록-정리')).visibility, 'tenant')
  await H.gone(pc.link)
})

test('PT-07 한 시간이 지나면 끝 — 「등록」은 409 expired, 기다리던 파일은 지움', { skip: !db }, async () => {
  const { a, ctx } = mine
  const out = await withLang('ko', () => PT.proposeSkill(ctx, skillBody('지난-스킬')))
  const v = await withLang('ko', () => PT.view(a, out.id))
  await q(`update pro_pc_proposals set expires_at = now() - interval '1 minute' where id=$1`, [out.id])
  assert.equal((await withLang('ko', () => PT.view(a, out.id))).state, 'expired')
  assert.equal(await code(withLang('ko', () => PT.register(a, out.id, { confirm: v.confirm }))), '409 expired')
  assert.ok(!fs.existsSync(staged(out.id)))
  assert.equal((await cardOf(out.id)).content.pc.state, 'expired')
  // 「그만두기」
  const out2 = await withLang('ko', () => PT.proposeSkill(ctx, skillBody('그만둔-스킬')))
  assert.equal((await withLang('ko', () => PT.drop(a, out2.id))).state, 'dropped')
  assert.ok(!fs.existsSync(staged(out2.id)))
})

test('PT-08 폴더: 미리 보기만 오고(경로 없음) 「올리기」 → 챔피언 폴더 · 그 PC 가 자기 pick 으로 올림 → 끝 · 아무것도 안 올라가면 폴더는 지우고 다시 누를 수 있게', { skip: !db }, async () => {
  const a = await person('오지민')
  const noFolders = await desktop(a, { folders: false })
  let run = await chatRun(a, noFolders)
  const preview = { files: 3, bytes: 2048, top: [{ path: 'docs/', files: 2, bytes: 1500 }, { path: 'README.md', files: 1, bytes: 548 }],
    excluded: [{ group: 'secret', count: 1, samples: ['.env'] }, { group: 'nonsense', count: 9 }], flagged: [{ path: 'conf.sh', line: 3, reason: 'env_assignment', level: 'check' }],
    kit: [{ platform: 'claude', type: 'skill', path: '.claude/skills/x/SKILL.md', name: 'x', description: '', runs: false }], warnings: ['own_git', 'weird'] }
  assert.equal(await code(withLang('ko', async () => PT.proposeFolder(await ctxOf(run.payload), { pickId: crypto.randomUUID(), label: '영업 키트', preview }))), '409 folders_off')
  await H.gone(noFolders.link)
  const pc = await desktop(a)
  run = await chatRun(a, pc)
  const ctx = await ctxOf(run.payload)
  const pickId = crypto.randomUUID()
  assert.equal(await code(withLang('ko', () => PT.proposeFolder(ctx, { pickId, label: '영업 키트', preview: { ...preview, warnings: ['too_big'] } }))), '413 too_big')
  assert.equal(await code(withLang('ko', () => PT.proposeFolder(ctx, { pickId, label: '빈 폴더', preview: { files: 0, warnings: ['empty'] } }))), '400 empty')
  const out = await withLang('ko', () => PT.proposeFolder(ctx, { pickId, label: '영업 키트', preview }))
  const [row] = await q('select * from pro_pc_proposals where id=$1', [out.id])
  assert.equal(row.pick_id, pickId)
  assert.deepEqual(row.summary.preview.excluded.map((g) => g.group), ['secret'], 'only the known groups')
  assert.deepEqual(row.summary.preview.warnings, ['own_git'])
  assert.ok(!JSON.stringify(row.summary).includes('/Users/'), 'no path of the PC')
  assert.equal((await cardOf(out.id)).content.text, '폴더를 올릴까요? · 영업 키트')
  let v = await withLang('ko', () => PT.view(a, out.id))
  assert.equal(v.pcOnline, true)
  assert.equal(v.preview.kit.length, 1)
  // 「올리기」: the folder is made, the PC is asked with its own pick
  v = await withLang('ko', () => PT.upload(a, out.id, { confirm: v.confirm }))
  assert.equal(v.state, 'working')
  const ask = pc.got.filter((m) => m.type === 'tools:upload').at(-1)
  assert.deepEqual(Object.keys(ask).sort(), ['folderId', 'folderName', 'pickId', 'proposalId', 'type'], 'ids and a name — never a path')
  assert.equal(ask.pickId, pickId)
  assert.equal(ask.folderName, '영업 키트')
  const f = await S.folderById(ask.folderId)
  assert.ok(f.settings.champion, 'made as the page makes a champion folder')
  // nothing went up (the PC said why): the empty folder goes, the card can be pressed again
  await H.receive(pc.link, { type: 'tools:uploaded', proposalId: out.id, ok: false, why: 'offline' })
  v = await withLang('ko', () => PT.view(a, out.id))
  assert.equal(v.state, 'pending')
  assert.equal(v.error, 'offline')
  assert.equal(await S.folderById(ask.folderId).catch(() => null), null, 'the empty folder went away')
  // again — this time it went up
  v = await withLang('ko', () => PT.upload(a, out.id, { confirm: v.confirm, name: '영업 키트 2026' }))
  const ask2 = pc.got.filter((m) => m.type === 'tools:upload').at(-1)
  assert.equal(ask2.folderName, '영업 키트 2026')
  // (someone else's link saying so changes nothing)
  const other = await desktop(await person('남궁민'))
  await H.receive(other.link, { type: 'tools:uploaded', proposalId: out.id, ok: true })
  assert.equal((await withLang('ko', () => PT.view(a, out.id))).state, 'working')
  await H.receive(pc.link, { type: 'tools:uploaded', proposalId: out.id, ok: true, pushed: { files: 3, bytes: 2048 } })
  v = await withLang('ko', () => PT.view(a, out.id))
  assert.equal(v.state, 'done')
  assert.equal(v.result.slug, (await S.folderById(ask2.folderId)).slug)
  assert.equal(v.result.pushed.files, 3)
  assert.equal((await cardOf(out.id)).content.pc.state, 'done')
  // a pick the PC no longer has (it restarted): failed, a new proposal is needed
  const out2 = await withLang('ko', () => PT.proposeFolder(ctx, { pickId: crypto.randomUUID(), label: '견적 양식', preview }))
  let v2 = await withLang('ko', () => PT.view(a, out2.id))
  await withLang('ko', () => PT.upload(a, out2.id, { confirm: v2.confirm }))
  await H.receive(pc.link, { type: 'tools:uploaded', proposalId: out2.id, ok: false, why: 'no_pick' })
  v2 = await withLang('ko', () => PT.view(a, out2.id))
  assert.equal(v2.state, 'failed')
  // the PC off: 「올리기」 waits for it
  const out3 = await withLang('ko', () => PT.proposeFolder(ctx, { pickId: crypto.randomUUID(), label: '회의 자료', preview }))
  const v3 = await withLang('ko', () => PT.view(a, out3.id))
  await H.gone(pc.link)
  assert.equal((await withLang('ko', () => PT.view(a, out3.id))).pcOnline, false)
  assert.equal(await code(withLang('ko', () => PT.upload(a, out3.id, { confirm: v3.confirm }))), '409 pc_offline')
  await H.gone(other.link)
})

test('PT-09 읽기만 하는 목록 · 기다리는 제안은 한 번에 10개까지(429)', { skip: !db }, async () => {
  const a = await person('윤가온')
  const pc = await desktop(a)
  const run = await chatRun(a, pc)
  const ctx = await ctxOf(run.payload)
  await S.createFolder({ ...a }, { name: `윤가온의 자료 ${crypto.randomBytes(2).toString('hex')}` })
  const folders = await PT.myFolders(ctx)
  assert.ok(folders.folders.some((f) => f.name.startsWith('윤가온의 자료') && f.role === 'owner'))
  const skills = await PT.mySkills(ctx)
  assert.ok(Array.isArray(skills.skills))
  for (let i = 0; i < 10; i++) await withLang('ko', () => PT.proposeSkill(ctx, skillBody(`많은-스킬-${i}`)))
  assert.equal(await code(withLang('ko', () => PT.proposeSkill(ctx, skillBody('열한-번째')))), '429 too_many_pending')
  await H.gone(pc.link)
})
