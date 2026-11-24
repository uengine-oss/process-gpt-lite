// 일 하나에 작업 폴더 하나 (lib/mailWork.js, 스펙 openspec/specs/mail-work-folder). 2026-11-24 사용자 결정: 메일로 일이 시작되면 그 일의
// 작업 폴더가 생기고, 첫 메일부터 이 일에 이어진 메일과 단계 결과가 거기 쌓이며, 다음 단계의 에이전트가 그것을 읽는다. 들어온 메일은 카드가
// 생기는 대로 회사 프로세스 지도와 견주고, 프로세스의 단계(자동 · 제안 · 관찰)대로 한다.
// 실제 DB · 실제 git · 로컬 Storage. 모델 · Gmail 은 가짜 fetch, 지도의 읽기 · 건 시작 · 판정은 대역(로컬 지도 엔진이 꺼져 있어도 돈다).
// Run: node --test --test-concurrency=1 test/mailWork.integration.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { simpleParser } from 'mailparser'
import MailComposer from 'nodemailer/lib/mail-composer'

process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:59996/v1'
process.env.PRO_ONTOLOGY_BOLT_URL = ''
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-mailwork-test-'))
const kek = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: kek.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(dir, 'keyring.json')
delete process.env.PRO_VAULT_KEK
// the work folders go to this test's own directory (removed with it)
process.env.PRO_FOLDERS_ROOT = path.join(dir, 'folders')

const { config } = await import('../config.js')
const { q, pool, admin } = await import('../lib/supa.js')
const vault = await import('../lib/vault.js')
const MF = await import('../lib/mailFlow.js')
const MW = await import('../lib/mailWork.js')
const S = await import('../lib/folders/service.js')
const G = await import('../lib/folders/git.js')
const { pollUser } = await import('../lib/mail.js')
const T = config.tenantId
const tag = () => crypto.randomBytes(3).toString('hex')

const users = []
const insts = []
const todos = []
const objects = []
const newUser = async (email = `mw-${tag()}@lite.example`, name = '홍길동') => {
  const u = crypto.randomUUID()
  users.push(u)
  await q('insert into pro_profile(user_id, email, name) values ($1,$2,$3)', [u, email, name])
  return { id: u, email, name }
}
after(async () => {
  if (todos.length) await q('delete from todolist where id = any($1::uuid[])', [todos]).catch(() => {})
  for (const u of users) {
    for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_mail_seen', 'pro_demo_mail', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_profile']) await q(`delete from ${t} where user_id=$1`, [u]).catch(() => {})
    await q('delete from pro_mail_archive where owner_id=$1', [u]).catch(() => {})
    await q('delete from notifications where user_id=$1', [u]).catch(() => {})
    await q('delete from pro_po_cases where started_by=$1', [u]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u])
    await q('delete from pro_threads where user_id=$1', [u])
  }
  await q('delete from pro_folders where created_by = any($1::uuid[])', [users]).catch(() => {})
  if (insts.length) await q('delete from bpm_proc_inst where proc_inst_id = any($1)', [insts])
  if (objects.length) await admin.storage.from('files').remove(objects).catch(() => {})
  await pool.end()
  fs.rmSync(dir, { recursive: true, force: true })
})

// a running instance of the company's process map that `user` started (as run.js startCase leaves one) — its name ends in a word
// without 받침, so the folder chip reads 「…를」
async function runningCase(user, { name = `견적 요청 ${tag()} · 한빛상사`, proc = 'p:quote', subject = '세미나 견적 부탁드립니다', from = '이수민 <sumin@hanbit.example>', body = '12월 세미나 30명 기준 견적을 부탁드립니다.' } = {}) {
  const instId = `mailwork-test.${crypto.randomUUID()}`
  insts.push(instId)
  await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, tenant_id, status, participants, start_date, updated_at) values ($1,$2,$3,'RUNNING',$4, now(), now())`, [instId, name, T, [user.id]])
  const [c] = await q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, request, status) values ($1,$2,'견적서 작성',$3,$4,$5,$6,'running') returning id::text as id`,
    [T, proc, user.id, { kind: 'mail', subject, from }, [instId], { subject, sender: from, body }])
  return { instId, caseId: c.id, name }
}
// a mail of a demo mailbox and the Home card the triage made from it
async function mailCard(user, { verb = 'Reply', text = '한빛상사 견적 요청에 회신', mailId = `demo-mw-${tag()}${tag()}`, sender = '이수민 <sumin@hanbit.example>',
  subject = '세미나 견적 부탁드립니다', body = '12월 세미나 30명 기준 견적을 부탁드립니다.\n\n이수민 드림' } = {}) {
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do nothing`, [user.id, user.email])
  await q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [user.id, mailId, sender, subject, body])
  const [a] = await q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,$2,$3,'',$4) returning *`, [user.id, verb, text, { mail_id: mailId, from: sender, subject }])
  return a
}
const instThread = async (userId, instId) => (await q(`select id from pro_threads where user_id=$1 and ref=$2`, [userId, instId]))[0]?.id
const msgs = async (threadId) => (threadId ? q(`select role, kind, content from pro_messages where thread_id=$1 order by created_at`, [threadId]) : [])
const card = async (id) => (await q('select * from pro_actions where id=$1', [id]))[0]
const files = async (f, ref = 'main') => (await G.lsTree(f.repo_path, ref)).map((x) => x.path).filter((p) => p !== '.gitattributes').sort()
const blob = async (f, ref, p) => (await G.show(f.repo_path, ref, p)).toString('utf8')
const today = () => MW.dayOf(new Date())
// until the poll's background reading (lib/mail.js → mailFlow.routeMailCards) is over
async function until(fn, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 100))
  }
}

// the company map's reading of a mail (ontology/events.js identify's shape)
const QUOTE = { proc: 'p:quote', name: '견적 요청 · 견적서 작성', status: 'suggested', p: 0.91, measured: true,
  choice: { task: '견적서 작성', p: 0.88, ask: true, suggest: true, measured: true, options: [{ task: '견적서 작성', p: 0.88 }], procName: '견적 요청 · 견적서 작성', procP: 0.91 } }
const AUTO = { ...QUOTE, status: 'adopted', choice: { ...QUOTE.choice, ask: false, suggest: undefined } }
const routeTo = (...matches) => { const calls = []; const fn = async (ev) => { calls.push(ev); return { none: !matches.length, matches, reads: [] } }; fn.calls = calls; return fn }
const judgeSays = (p) => { const calls = []; const fn = async (inst, mail) => { calls.push({ inst, mail }); return typeof p === 'function' ? p(inst) : p }; fn.calls = calls; return fn }
// a stand-in for run.js startCase: the instance and the case as a start leaves them, with who does each role (bindings.js)
const fakeStart = (name = `견적 요청 · 견적서 작성 ${tag()} · 한빛상사`, { bindings = [] } = {}) => {
  const calls = []
  const fn = async (me, args) => {
    calls.push({ me, args })
    const instId = `mailwork-test.${crypto.randomUUID()}`
    insts.push(instId)
    await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, tenant_id, status, participants, start_date, updated_at) values ($1,$2,$3,'RUNNING',$4, now(), now())`, [instId, name, T, [me.id]])
    const [c] = await q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, request, status, bindings) values ($1,$2,$3,$4,$5,$6,$7,'running',$8) returning id::text as id`,
      [T, args.procKey, args.entry, me.id, { kind: args.kind, subject: args.subject, from: args.from }, [instId], { subject: args.subject, sender: args.from, body: args.body }, JSON.stringify(bindings)])
    return { caseId: c.id, instId, instName: name, snapshot: { skipped: [], nodes: [] } }
  }
  fn.calls = calls
  fn.name_ = name
  return fn
}

// ---------- fake model and Gmail ----------
const real = globalThis.fetch
let triage = { actions: [], brief: '' }
const drafts = [] // what the draft-step prompt was given
const gmail = { messages: [] } // [{id, threadId, raw}]
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u === `${config.llm.baseUrl}/chat/completions`) {
    const body = JSON.parse(init.body || '{}')
    if (body.max_tokens === 1 && body.logprobs) {
      return Response.json({ choices: [{ message: { content: 'A' }, logprobs: { content: [{ token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(0.5) }, { token: 'B', logprob: Math.log(0.5) }] }] } }] })
    }
    const sys = String(body.messages?.[0]?.content || '')
    let answer = {}
    if (sys.includes("You read a user's newest emails")) answer = triage
    else if (sys.includes('이 단계에서 나올 결과물을 글로 만듭니다')) {
      drafts.push(JSON.parse(body.messages.at(-1).content))
      answer = { title: '회신', text: '40명 기준 견적을 보내 드립니다.', summary: '회신 초안을 만들었어요.', subject: 'Re: 세미나 견적' }
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] })
  }
  if (u.startsWith(config.google.gmailUrl)) {
    if (u.includes('/messages?')) return Response.json({ messages: gmail.messages.map((m) => ({ id: m.id, threadId: m.threadId })) })
    const m = gmail.messages.find((x) => u.includes(`/messages/${x.id}?`))
    if (m && u.includes('format=raw')) return Response.json({ id: m.id, threadId: m.threadId, raw: m.raw.toString('base64url') })
    if (m) {
      return Response.json({ id: m.id, threadId: m.threadId, labelIds: ['INBOX'], snippet: m.text,
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: m.from }, { name: 'To', value: m.to }, { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date().toUTCString() }],
          body: { data: Buffer.from(m.text).toString('base64url') } } })
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 })
  }
  return real(url, init)
}
const gmailMessage = async ({ threadId, from, to, subject, text, attachments = [] }) => {
  const raw = await new MailComposer({ from, to, subject, text, attachments }).compile().build()
  return { id: `g-${tag()}${tag()}`, threadId, from, to, subject, text, raw }
}

// ---------- names (pure) ----------
test('이름: 메일은 「번호_날짜_제목」, 쓸 수 없는 글자는 빼고, 다음 번호는 폴더에 있는 것 다음 · 결과의 파일과 값', () => {
  assert.equal(MW.safeName('a/b:c*?"<>|d'), 'a b c d')
  assert.equal(MW.safeName('   ', 40, '제목 없음'), '제목 없음')
  assert.equal(MW.safeName('..숨김'), '숨김')
  assert.equal(MW.safeName('가'.repeat(60), 40).length, 40)
  assert.equal(MW.mailStem(1, '2026-11-24T01:00:00Z', 'Re: 세미나/견적'), '01_2026-11-24_Re 세미나 견적')
  assert.equal(MW.mailStem(12, '2026-11-24T16:30:00Z', ''), '12_2026-11-25_제목 없음', '날짜는 한국 시간')
  assert.equal(MW.nextNumber(['메일/01_a.eml', '메일/02_b.md', '메일/02_첨부/x.pdf', '산출물/07_x/결과.md', '메일.md'], '메일'), 3)
  assert.equal(MW.nextNumber([], '메일'), 1)
  const taken = new Set()
  assert.deepEqual([MW.uniqueName('a.xlsx', taken), MW.uniqueName('a.xlsx', taken), MW.uniqueName('a.xlsx', taken)], ['a.xlsx', 'a (2).xlsx', 'a (3).xlsx'])
  const md = MW.mailMarkdown({ from: { name: '이수민', address: 'sumin@hanbit.example' }, to: [{ name: '', address: 'me@lite.example' }], cc: [], subject: '세미나 견적', date: '2026-11-24T01:05:00Z', text: '30명 견적 부탁드립니다.\r\n이수민 드림\n' },
    { attachments: [{ name: '요청.xlsx', path: '메일/01_첨부/요청.xlsx' }] })
  assert.equal(md, '# 세미나 견적\n\n- 보낸 사람: 이수민 <sumin@hanbit.example>\n- 받는 사람: me@lite.example\n- 날짜: 2026-11-24 10:05\n- 첨부: 요청.xlsx (메일/01_첨부/요청.xlsx)\n\n---\n\n30명 견적 부탁드립니다.  \n이수민 드림\n')
  assert.equal(MW.bodyOfMd(md), '30명 견적 부탁드립니다.\n이수민 드림')
  assert.equal(MW.lineOf('mailwork-test.123e4567-e89b-12d3-a456-426614174000'), 'inst/426614174000', 'work.js 의 인스턴스 라인과 같은 이름')
  const o = MW.outputsOf({ output: { f1: { result: '견적 본문', document: { name: '견적서.xlsx', url: 'http://h/storage/v1/object/public/files/k.xlsx' }, checkpoints: [], amount: 1200 } } })
  assert.deepEqual([o.files.map((x) => x.name), o.fields.map((x) => x.key)], [['견적서.xlsx'], ['result', 'amount']])
  assert.deepEqual(MW.outputsOf({ output: { text: '답', worktree: { branch: 'b' } } }).fields, [{ key: 'text', value: '답' }])
  assert.match(MW.resultMarkdown({ activity_name: '견적서 작성' }, { fields: [{ key: 'checkpoints', value: [{ checkpoint: '합계', ok: true, note: '있음' }] }] }, [{ name: '견적서.xlsx', path: '산출물/01_견적서 작성/견적서.xlsx' }], { name: '업무 에이전트' }),
    /^# 견적서 작성\n\n- 한 사람: 업무 에이전트\n\n## 파일\n\n- 견적서.xlsx \(견적서.xlsx\)\n\n## checkpoints\n\n- ✓ 합계 — 있음\n$/)
})

// ---------- the folder ----------
test('새로 시작: 일의 작업 폴더가 생긴다(주인은 나, 이름은 인스턴스, 역할을 맡은 동료에게는 기본으로 나누지 않음) — 첫 메일이 메일/01_… .eml · .md 로, 내가 넣은 것으로', async () => {
  const me = await newUser(undefined, '홍길동')
  const mate = await newUser(undefined, '김동료')
  const stranger = await newUser(undefined, '남')
  const a = await mailCard(me)
  await MF.flowOfCard(me, a.id, { route: routeTo(QUOTE), judge: judgeSays(null) })
  const start = fakeStart(undefined, { bindings: [{ role: '검토자', userId: mate.id, name: '김동료', from: 'settings' }, { role: '업무 에이전트', userId: null, from: 'agent' }] })
  const r = await MF.startFromCard(me, a.id, { proc: 'p:quote' }, { start })
  const f = await MW.workFolderOf(r.instId)
  assert.ok(f, '작업 폴더')
  assert.equal(f.name, start.name_)
  assert.match(f.slug, /^work-[0-9a-f]{12}$/)
  assert.deepEqual([f.settings.work.instId, f.settings.work.owner, f.settings.work.line, f.settings.work.proc], [r.instId, me.id, MW.lineOf(r.instId), 'p:quote'])
  const roles = Object.fromEntries((await S.members(f.id)).map((m) => [m.id, m.role]))
  assert.deepEqual(roles, { [me.id]: 'owner' }) // the owner's own mail: shared with no one unless the company turns it on
  const stem = `메일/01_${today()}_세미나 견적 부탁드립니다`
  assert.deepEqual(await files(f), [`${stem}.eml`, `${stem}.md`])
  // the message itself: any mail program opens it
  const eml = await simpleParser(await G.show(f.repo_path, 'main', `${stem}.eml`))
  assert.deepEqual([eml.subject, eml.from.value[0].address, eml.to.value[0].address], ['세미나 견적 부탁드립니다', 'sumin@hanbit.example', me.email])
  assert.match(eml.text, /30명 기준 견적/)
  const md = await blob(f, 'main', `${stem}.md`)
  assert.match(md, /^# 세미나 견적 부탁드립니다\n\n- 보낸 사람: 이수민 <sumin@hanbit.example>\n- 받는 사람: .+\n- 날짜: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\n---\n\n12월 세미나 30명 기준 견적을 부탁드립니다.\n\n이수민 드림\n$/)
  const [c] = await G.log(f.repo_path, 'main', 1)
  assert.deepEqual([c.name, c.email, c.msg], ['홍길동', me.email, '메일 01 · 세미나 견적 부탁드립니다'])
  // the card and the start's answer know the folder; the instance's conversation says it (not the main chat)
  assert.deepEqual((await card(a.id)).source.inst.folder, { slug: f.slug, name: f.name })
  assert.deepEqual(r.inst.folder, { slug: f.slug, name: f.name })
  const im = await msgs(await instThread(me.id, r.instId))
  const chip = im.find((x) => x.kind === 'chip')
  assert.deepEqual([chip.content.folder, chip.content.icon], [f.slug, 'folder'])
  assert.equal(chip.content.text, `작업 폴더 ‘${f.name}’를 만들고 메일 01 「세미나 견적 부탁드립니다」를 넣었어요`)
  // what is asked in the instance's conversation reads it (attached for reference)
  const [link] = await q(`select mode, folder_id from pro_thread_folders where thread_id=$1`, [await instThread(me.id, r.instId)])
  assert.deepEqual([link.mode, link.folder_id], ['ref', f.id])
  // the instance page's 「작업 폴더」: for those who may open the folder
  assert.deepEqual(await MW.folderView(r.instId, me), { slug: f.slug, name: f.name, role: 'owner', mails: 1, outputs: 0, line: null })
  assert.equal(await MW.folderView(r.instId, mate), null)
  assert.equal(await MW.folderView(r.instId, stranger), null)
})

test('나누기 규칙(mailWork.shareWithRoles): 켜면 역할을 맡은 사람(에이전트 · 주인 · 겹침 제외)만 보기로, 기본은 아무도', () => {
  const b = [{ userId: 'u2', from: 'settings' }, { userId: 'u2', from: 'habit' }, { userId: null, from: 'agent' }, { userId: 'u3', from: 'agent' }, { userId: 'u1', from: 'settings' }]
  assert.deepEqual(MW.sharedWith(b, 'u1'), [])
  assert.deepEqual(MW.sharedWith(b, 'u1', { shareWithRoles: true }), ['u2'])
})

test('잇기: 다른 메일이 이 일에 이어지면 같은 폴더의 메일/02_…로(넣은 사람의 커밋), 같은 메일은 두 번 들어가지 않는다 — 폴더 없던 일은 이을 때 생긴다', async () => {
  const me = await newUser(undefined, '홍길동')
  const run = await runningCase(me)
  const a = await mailCard(me, { subject: '세미나 견적 부탁드립니다' })
  await MF.joinFromCard(me, a.id, { instId: run.instId })
  const f = await MW.workFolderOf(run.instId)
  assert.equal(f.name, run.name)
  const b = await mailCard(me, { subject: 'Re: 세미나 견적 부탁드립니다', body: '인원이 40명으로 늘었습니다.' })
  await MF.joinFromCard(me, b.id, { instId: run.instId })
  const now = await S.folderById(f.id)
  assert.deepEqual(now.settings.work.mails.map((m) => [m.n, m.subject, m.via]), [[1, '세미나 견적 부탁드립니다', 'join'], [2, 'Re: 세미나 견적 부탁드립니다', 'join']])
  assert.deepEqual((await files(now)).filter((p) => p.endsWith('.md')), [`메일/01_${today()}_세미나 견적 부탁드립니다.md`, `메일/02_${today()}_Re 세미나 견적 부탁드립니다.md`])
  assert.deepEqual((await G.log(now.repo_path, 'main', 2)).map((x) => [x.name, x.msg]), [['홍길동', '메일 02 · Re: 세미나 견적 부탁드립니다'], ['홍길동', '메일 01 · 세미나 견적 부탁드립니다']])
  assert.equal(await MW.addMail(me.id, now, await card(b.id)), null, '이미 있는 메일')
  assert.equal((await S.folderById(f.id)).settings.work.mails.length, 2)
  const im = await msgs(await instThread(me.id, run.instId))
  assert.deepEqual(im.filter((x) => x.kind === 'chip').map((x) => x.content.text), [
    `작업 폴더 ‘${run.name}’를 만들고 메일 01 「세미나 견적 부탁드립니다」를 넣었어요`, `작업 폴더 ‘${run.name}’에 메일 02 「Re: 세미나 견적 부탁드립니다」를 넣었어요`])
})

// ---------- at arrival ----------
test('들어올 때(Gmail · 자동): 지도가 「자동」의 시작으로 읽은 메일은 저절로 시작하고 원문(.eml) · 첨부가 폴더로 — 같은 스레드의 다음 메일은 모델 없이 그 일로 이어진다(새 건 없음)', async () => {
  const user = await newUser(undefined, '홍길동')
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'gmail',$2)`, [user.id, user.email])
  await vault.putItem(user.id, 'oauth', 'google', { username: user.email, access_token: 'at-test', refresh_token: 'rt-test', expires_at: Date.now() + 3600_000, scope: 'openid', client_id: 'cid' }, { actor: 'mail' })
  const thread = `thr-${tag()}`
  const first = await gmailMessage({ threadId: thread, from: '이수민 <sumin@hanbit.example>', to: user.email, subject: '세미나 견적 요청', text: '첨부한 요청서대로 30명 견적 부탁드립니다.',
    attachments: [{ filename: '견적 요청서.xlsx', content: Buffer.from('xlsx-request') }, { filename: '약도.pdf', content: Buffer.from('%PDF-1.4 test') }] })
  gmail.messages = [first]
  triage = { actions: [{ mail_id: first.id, verb: 'Reply', text: '한빛상사 세미나 견적 요청', prompt: '' }], brief: '', drafts: [] }
  const route = routeTo(AUTO)
  const start = fakeStart()
  await pollUser(user.id, { deps: { route, start, judge: judgeSays(null) } })
  const a = await until(async () => { const [x] = await q(`select * from pro_actions where user_id=$1 and source->>'mail_id'=$2 and source->'inst' ? 'folder'`, [user.id, first.id]); return x })
  assert.ok(a, '카드가 인스턴스와 폴더를 가리킨다')
  assert.deepEqual([a.source.inst.via, start.calls.length, route.calls.length], ['auto', 1, 1])
  assert.equal(route.calls[0].subject, '세미나 견적 요청', '문서를 요청하지 않는 메일도 들어올 때 지도와 견준다')
  const f = await MW.workFolderOf(a.source.inst.instId)
  const stem = `메일/01_${today()}_세미나 견적 요청`
  assert.deepEqual(await files(f), [`${stem}.eml`, `${stem}.md`, '메일/01_첨부/견적 요청서.xlsx', '메일/01_첨부/약도.pdf'].sort())
  assert.equal(await blob(f, 'main', '메일/01_첨부/견적 요청서.xlsx'), 'xlsx-request')
  assert.ok((await G.show(f.repo_path, 'main', `${stem}.eml`)).equals(first.raw), '메일함이 지닌 원문 그대로')
  assert.match(await blob(f, 'main', `${stem}.md`), /- 첨부: 견적 요청서.xlsx \(메일\/01_첨부\/견적 요청서.xlsx\), 약도.pdf \(메일\/01_첨부\/약도.pdf\)/)
  const [n] = await q(`select type, url from notifications where user_id=$1`, [user.id])
  assert.deepEqual([n.type, n.url], ['process_started', `/routines/${a.source.inst.instId}`])
  // the customer writes again in the same thread: it joins, nothing starts, the map is not read again
  const second = await gmailMessage({ threadId: thread, from: '이수민 <sumin@hanbit.example>', to: user.email, subject: 'Re: 세미나 견적 요청', text: '인원이 40명으로 늘었습니다.' })
  gmail.messages = [first, second]
  triage = { actions: [{ mail_id: second.id, verb: 'Reply', text: '한빛상사 인원 변경 회신', prompt: '' }], brief: '', drafts: [] }
  await pollUser(user.id, { deps: { route, start, judge: judgeSays(null) } })
  const b = await until(async () => { const [x] = await q(`select * from pro_actions where user_id=$1 and source->>'mail_id'=$2 and source->'inst' ? 'folder'`, [user.id, second.id]); return x })
  assert.deepEqual([b.source.inst.instId, b.source.inst.via], [a.source.inst.instId, 'thread'])
  assert.deepEqual([start.calls.length, route.calls.length], [1, 1])
  const now = await S.folderById(f.id)
  assert.deepEqual(now.settings.work.mails.map((m) => [m.n, m.via, m.attachments.length]), [[1, 'auto', 2], [2, 'thread', 0]])
  assert.ok((await G.show(f.repo_path, 'main', `메일/02_${today()}_Re 세미나 견적 요청.eml`)).equals(second.raw))
})

test('들어올 때(데모 메일함): 카드가 생긴 메일은 바로 지도와 견준다 — 제안은 시작하지 않고 카드가 묻고(시트는 지도를 다시 읽지 않는다), 관찰(읽히지 않음)은 아무것도 하지 않는다', async () => {
  const user = await newUser()
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2)`, [user.id, user.email])
  await q(`insert into pro_mail_seen(user_id, mail_id) select $1, x->>'id' from jsonb_array_elements($2::jsonb) x`, [user.id, JSON.stringify(JSON.parse(fs.readFileSync(new URL('../fixtures/demo-mail.json', import.meta.url), 'utf8')))])
  const arrive = async (subject, matches) => {
    const id = `demo-mw-${tag()}${tag()}`
    await q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [user.id, id, '이수민 <sumin@hanbit.example>', subject, '본문'])
    triage = { actions: [{ mail_id: id, verb: 'Reply', text: subject, prompt: '' }], brief: '', drafts: [] }
    const route = routeTo(...matches)
    const start = fakeStart()
    await pollUser(user.id, { deps: { route, start } })
    const a = await until(async () => { const [x] = await q(`select * from pro_actions where user_id=$1 and source->>'mail_id'=$2 and source->'flow' ? 'at'`, [user.id, id]); return x })
    return { a, route, start }
  }
  // 제안
  const s = await arrive('세미나 견적 부탁드립니다', [QUOTE])
  assert.equal(s.route.calls.length, 1)
  assert.deepEqual([s.start.calls.length, s.a.source.inst, s.a.source.flow.matches[0].stage], [0, undefined, 'suggested'])
  const never = routeTo(AUTO)
  const sheet = await MF.flowOfCard(user, s.a.id, { route: never, judge: judgeSays(null) })
  assert.deepEqual([sheet.matches[0].proc, never.calls.length], ['p:quote', 0], '시트는 카드에 남은 읽음을 쓴다')
  // 관찰: an observed process is never read — the router finds nothing; nothing starts, and the card says it was read
  const o = await arrive('견적서 잘 받았습니다', [])
  assert.deepEqual([o.route.calls.length, o.start.calls.length, o.a.source.inst, o.a.source.flow.matches], [1, 0, undefined, []])
  assert.equal(await MW.workFolderOf('nothing'), null)
})

test('자동이라도 진행 중인 같은 일의 다음 메일로 읽히면(판정 모델, 스레드 없음) 저절로 시작하지 않고 카드가 잇기를 묻는다 — 다른 일이면 시작한다', async () => {
  const user = await newUser()
  const run = await runningCase(user)
  const a = await mailCard(user, { subject: '세미나 견적 다시 부탁드립니다', body: '인원을 40명으로 바꿔 주세요.' })
  const start = fakeStart()
  const judge = judgeSays(0.92)
  const r = await MF.routeMailCards(user.id, { from: a.source.from, subject: a.source.subject, text: '인원을 40명으로 바꿔 주세요.' }, [a], { route: routeTo(AUTO), start, judge, rules: { maxStarts: 3 } })
  assert.deepEqual([r.held, r.started.length, start.calls.length], ['same-work', 0, 0])
  assert.equal(judge.calls[0].inst.instId, run.instId)
  assert.equal((await card(a.id)).source.flow.same[run.instId], 0.92)
  const sheet = await MF.flowOfCard(user, a.id, { judge: judgeSays(() => { throw new Error('not again') }) })
  assert.deepEqual(sheet.joins.map((j) => [j.instId, j.by, j.p]), [[run.instId, 'judge', 0.92]])
  // another work: starts, with its own folder
  const b = await mailCard(user, { subject: '워크숍 장소 문의' })
  const r2 = await MF.routeMailCards(user.id, { from: b.source.from, subject: b.source.subject, text: '워크숍 장소를 알려 주세요.' }, [b], { route: routeTo(AUTO), start, judge: judgeSays(0.1), rules: { maxStarts: 3 } })
  assert.deepEqual([r2.started.length, start.calls.length], [1, 1])
  assert.ok(await MW.workFolderOf(r2.instId))
})

// ---------- the steps ----------
test('단계 결과: 끝난 단계가 만든 파일과 값이 인스턴스 라인의 산출물/NN_<단계>/ 로 — 뒤에 온 메일도 라인에, 다음 단계는 메일과 결과를 읽는다', async () => {
  const me = await newUser(undefined, '홍길동')
  const run = await runningCase(me)
  const a = await mailCard(me, { subject: '세미나 견적 부탁드립니다' })
  await MF.joinFromCard(me, a.id, { instId: run.instId })
  const f = await MW.workFolderOf(run.instId)
  // a file the step made, in this server's storage
  const key = `pgpt-pro/${me.id}/mw-test-${tag()}.xlsx`
  objects.push(key)
  const { error } = await admin.storage.from('files').upload(key, Buffer.from('xlsx-quote'), { contentType: 'application/octet-stream', upsert: true })
  assert.ifError(error)
  const url = `${config.supabaseUrl}/storage/v1/object/public/files/${key}`
  const todo = async (cols) => {
    const id = crypto.randomUUID()
    todos.push(id)
    await q(`insert into todolist (id, tenant_id, proc_inst_id, activity_id, activity_name, status, output, user_id, agent_orch, agent_mode, agent_config, end_date, start_date)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() at time zone 'Asia/Seoul', now() at time zone 'Asia/Seoul')`,
    [id, T, run.instId, cols.activity_id || `t_${tag()}`, cols.name, cols.status || 'DONE', cols.output, cols.user_id || me.id, cols.orch || null, cols.mode || null, cols.config || null])
    return id
  }
  const intake = await todo({ activity_id: 'intake', name: '요청 접수', output: { intake_form: { subject: '세미나 견적 부탁드립니다' } } })
  const step = await todo({ name: '견적서 작성', orch: 'pgpt-pro-onto', mode: 'COMPLETE', output: { t_q_form: { result: '30명 기준 견적: 합계 1,200,000원', document: { name: '한빛상사 견적서.xlsx', url }, checkpoints: [{ checkpoint: '합계', ok: true, note: '있음' }] } } })
  const cancelled = await todo({ name: '취소된 단계', output: { t_c_form: { result: 'x' }, lite_cancelled: true } })
  const own = await todo({ name: '폴더에서 한 단계', orch: 'deepagents', config: { folder: f.id }, output: { t_d_form: { result: 'y' } } })
  const done = await MW.recordDone(f)
  assert.deepEqual(done.sort(), [intake, step].sort())
  const line = MW.lineOf(run.instId)
  const out = '산출물/01_견적서 작성'
  assert.deepEqual((await files(f, line)).filter((p) => p.startsWith('산출물/')), [`${out}/결과.md`, `${out}/한빛상사 견적서.xlsx`])
  assert.deepEqual((await files(f)).filter((p) => p.startsWith('산출물/')), [], 'main 은 사람이 반영할 때까지 그대로')
  assert.equal(await blob(f, line, `${out}/한빛상사 견적서.xlsx`), 'xlsx-quote')
  const result = await blob(f, line, `${out}/결과.md`)
  assert.match(result, /^# 견적서 작성\n\n- 한 사람: 업무 에이전트 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n- 일: .+\n\n## 파일\n\n- 한빛상사 견적서.xlsx \(한빛상사 견적서.xlsx\)\n\n## result\n\n30명 기준 견적: 합계 1,200,000원\n\n## checkpoints\n\n- ✓ 합계 — 있음\n$/)
  assert.equal((await G.log(f.repo_path, line, 1))[0].name, '업무 에이전트')
  const [v] = await q(`select kind, status, head_commit from pro_folder_variations where folder_id=$1 and branch=$2`, [f.id, line])
  assert.deepEqual([v.kind, v.status, v.head_commit], ['instance', 'ready', await G.head(f.repo_path, `refs/heads/${line}`)])
  assert.deepEqual(await MW.recordDone(f), [], '한 번만')
  assert.ok(!(await S.folderById(f.id)).settings.work.recorded.includes(cancelled) && !(await S.folderById(f.id)).settings.work.recorded.includes(own))
  // a mail that comes after the first step: in main, and on the line the next step starts from
  const b = await mailCard(me, { subject: 'Re: 세미나 견적 부탁드립니다', body: '인원이 40명으로 늘었습니다. 날짜는 같습니다.' })
  await MF.joinFromCard(me, b.id, { instId: run.instId })
  assert.ok((await files(f, line)).includes(`메일/02_${today()}_Re 세미나 견적 부탁드립니다.md`))
  assert.ok((await files(f, line)).includes(`${out}/결과.md`))
  // what the next agent step reads
  const ctx = await MW.stepContext(run.instId)
  assert.deepEqual(ctx.mails.map((m) => [m.n, m.subject, m.text]), [[1, '세미나 견적 부탁드립니다', '12월 세미나 30명 기준 견적을 부탁드립니다.\n\n이수민 드림'], [2, 'Re: 세미나 견적 부탁드립니다', '인원이 40명으로 늘었습니다. 날짜는 같습니다.']])
  assert.deepEqual(ctx.outputs.map((o) => o.path), [`${out}/결과.md`, `${out}/한빛상사 견적서.xlsx`])
  assert.match(ctx.outputs[0].text, /합계 1,200,000원/)
  assert.match(ctx.note, /^\n\n\[작업 폴더\] 이 일에는 작업 폴더 「.+」\(공유 폴더 work-[0-9a-f]+\)가 있어요/)
  assert.match(ctx.note, /\[01\] \d{4}-\d{2}-\d{2} · 이수민 <sumin@hanbit.example> · 「세미나 견적 부탁드립니다」/)
  assert.match(ctx.note, /\[02\] .+「Re: 세미나 견적 부탁드립니다」[^\n]*\n인원이 40명으로 늘었습니다/)
  assert.match(ctx.note, /- 산출물\/01_견적서 작성\/결과.md:\n# 견적서 작성/)
  assert.deepEqual(await MW.folderView(run.instId, me), { slug: f.slug, name: f.name, role: 'owner', mails: 2, outputs: 1, line: { id: (await q(`select id from pro_folder_variations where folder_id=$1 and branch=$2`, [f.id, line]))[0].id, branch: line } })
  // the doc-draft skill (ontology/run.js) is given the work folder too
  const { ONTO_SKILLS } = await import('../lib/ontology/run.js')
  drafts.length = 0
  await ONTO_SKILLS['doc-draft']({ row: { proc_inst_id: run.instId, activity_name: '회신 메일' }, act: {}, kind: 'message', work: ctx })
  assert.equal(drafts.length, 1)
  assert.deepEqual(drafts[0].work.mails.map((m) => m.subject), ['세미나 견적 부탁드립니다', 'Re: 세미나 견적 부탁드립니다'])
  assert.equal(drafts[0].work.outputs[0].path, `${out}/결과.md`)
})

test('다른 엔진(deepagents · cli-agent)의 에이전트 단계는 그 일의 작업 폴더에서 인스턴스 라인부터(@previous) — Lite 의 단계 일꾼(pgpt-pro-*)은 읽기만', async () => {
  const me = await newUser()
  const run = await runningCase(me)
  await MF.joinFromCard(me, (await mailCard(me)).id, { instId: run.instId })
  const f = await MW.workFolderOf(run.instId)
  const ids = { deep: crypto.randomUUID(), onto: crypto.randomUUID(), done: crypto.randomUUID() }
  todos.push(...Object.values(ids))
  // (TODO with no agent mode: no step worker can take these rows)
  for (const [k, orch, status] of [['deep', 'deepagents', 'TODO'], ['onto', 'pgpt-pro-onto', 'TODO'], ['done', 'cliagents', 'DONE']]) {
    await q(`insert into todolist (id, tenant_id, proc_inst_id, activity_id, activity_name, status, agent_orch, start_date) values ($1,$2,$3,$4,$5,$6,$7, now())`, [ids[k], T, run.instId, `t_${k}`, k, status, orch])
  }
  assert.ok(await MW.stepFolders() >= 1)
  const cfg = Object.fromEntries((await q('select id::text, agent_config from todolist where id = any($1::uuid[])', [Object.values(ids)])).map((r) => [r.id, r.agent_config]))
  assert.deepEqual(cfg[ids.deep], { folder: f.id, base_ref: '@previous' })
  assert.equal(cfg[ids.onto], null)
  assert.equal(cfg[ids.done], null)
})

test('deepagents 단계: 체크아웃이 Storage 의 방 폴더로 가고, 다른 파드의 에이전트가 거기 남긴 것(고침 · 새 파일 · 지움)이 커밋에 들어온다', async () => {
  const W = await import('../lib/folders/work.js')
  const { roomPrefix } = await import('../lib/roomStore.js')
  const me = await newUser()
  const f = await S.createFolder(me, { name: `mw-room-${tag()}` })
  await S.upload(f, me, 'a.md', Buffer.from('원래 a'))
  await S.upload(f, me, '자료/b.md', Buffer.from('원래 b'))
  const v = await S.createVariation(f, { title: '단계', kind: 'run', holder: { type: 'agent', id: 'deepagents', name: '에이전트' }, source: { todo_id: crypto.randomUUID() } })
  const room = `mwtest${crypto.randomUUID().replace(/-/g, '')}`
  const local = path.join(dir, 'room-checkout')
  await S.checkout(f, v, local)
  await W.seedStep(f, v, room, local)
  const container = S.runCheckoutContainer(room, f)
  const prefix = roomPrefix(container)
  const listed = async () => (await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`${prefix}/`])).map((r) => r.name)
  const pushed = await listed()
  objects.push(...pushed)
  assert.ok(pushed.includes(`${prefix}/a.md`), pushed.join(','))
  const cur = await S.variationById(v.id)
  assert.equal(cur.source.room_store.container, container)
  assert.ok(cur.source.room_store.hashes['a.md'] && cur.source.room_store.hashes['자료/b.md'])
  // the agent's pod (no disk in common): a.md changed, c.md new, 자료/b.md deleted — in storage only
  const put = async (rel, body) => { const k = `${prefix}/${rel}`; objects.push(k); const { error } = await admin.storage.from('files').upload(k, Buffer.from(body), { upsert: true, contentType: 'text/plain' }); assert.ifError(error) }
  await put('a.md', '에이전트가 고친 a')
  await put('c.md', '새 c')
  await admin.storage.from('files').remove(pushed.filter((k) => !k.endsWith('/a.md') && !k.endsWith('/.gitattributes')))
  assert.equal(fs.readFileSync(path.join(local, 'a.md'), 'utf8'), '원래 a', '이 서버의 체크아웃은 그대로')
  const changed = await W.pullStep(cur)
  assert.deepEqual(changed.sort(), ['a.md', 'c.md', '자료/b.md'])
  await S.commitVariation(f, cur, { name: '에이전트', email: 'agent@pgpt-pro.local' }, '단계 결과')
  assert.deepEqual(await files(f, v.branch), ['a.md', 'c.md'])
  assert.equal(await blob(f, v.branch, 'a.md'), '에이전트가 고친 a')
  await S.release(f, await S.variationById(v.id))
})
