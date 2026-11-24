// 메일 한 통이 일의 어디에 있나 (lib/mailFlow.js, 스펙 openspec/specs/mail-thread-flow). 2026-11-24 운영 화면: 채팅의 「모닝 브리프」는
// 요약만 있고 그 메일 · Home 카드로 가는 길이 없었다. 고친 뒤: 브리프는 그 메일 카드들의 칩을 달고, 메일은 진행 중인 인스턴스의 것인지
// (Gmail 스레드 먼저, 그다음 판정 모델) · 회사 프로세스 지도의 어느 프로세스를 시작하는지 시트가 묻고, 시작하거나 이으면 메일이 그
// 인스턴스의 대화에 들어가고 카드 · 칩이 그 인스턴스를 가리킨다. 실제 DB, 모델 · Gmail 은 가짜 fetch, 지도의 읽기 · 시작은 대역.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// no real model and no graph engine: every model call goes to the fake below, the map's reading and start are stand-ins
process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:59997/v1'
process.env.PRO_ONTOLOGY_BOLT_URL = ''
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-mailflow-test-'))
const kek = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: kek.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(dir, 'keyring.json')
delete process.env.PRO_VAULT_KEK

const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const vault = await import('../lib/vault.js')
const MF = await import('../lib/mailFlow.js')
const R = await import('../lib/mailReply.js')
const { pollUser } = await import('../lib/mail.js')
const T = config.tenantId

const users = []
const insts = []
const newUser = async (email = 'me@lite.example', name = '홍길동') => {
  const u = crypto.randomUUID()
  users.push(u)
  await q('insert into pro_profile(user_id, email, name) values ($1,$2,$3)', [u, email, name])
  return { id: u, email, name }
}
after(async () => {
  for (const u of users) {
    for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_mail_seen', 'pro_demo_mail', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_profile']) await q(`delete from ${t} where user_id=$1`, [u]).catch(() => {})
    await q('delete from pro_mail_archive where owner_id=$1', [u]).catch(() => {})
    await q('delete from notifications where user_id=$1', [u]).catch(() => {})
    await q('delete from pro_po_cases where started_by=$1', [u]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u])
    await q('delete from pro_threads where user_id=$1', [u])
  }
  if (insts.length) await q('delete from bpm_proc_inst where proc_inst_id = any($1)', [insts])
  await pool.end()
  fs.rmSync(dir, { recursive: true, force: true })
})

// a running instance of the company's process map (as run.js startCase · mapengine.js startMapCase leave one), started by `user`
async function runningCase(user, { name = '견적 요청 · 견적서 작성 · 한빛상사', proc = 'p:quote', subject = '세미나 견적 부탁드립니다', from = '이수민 <sumin@hanbit.example>', status = 'RUNNING', body = '12월 세미나 30명 기준 견적을 부탁드립니다.' } = {}) {
  const instId = `mailflow-test.${crypto.randomUUID()}`
  insts.push(instId)
  await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, tenant_id, status, participants, start_date, updated_at) values ($1,$2,$3,$4,$5, now(), now())`, [instId, name, T, status, [user.id]])
  const [c] = await q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, request, status) values ($1,$2,'견적서 작성',$3,$4,$5,$6,'running') returning id::text as id`,
    [T, proc, user.id, { kind: 'mail', subject, from }, [instId], { subject, sender: from, body }])
  return { instId, caseId: c.id, name }
}
// a Home card the triage made from a mail of a demo mailbox
async function mailCard(user, { verb = 'Reply', text = '한빛상사 견적 요청에 회신', mailId = `demo-mf-${crypto.randomBytes(4).toString('hex')}`, sender = '이수민 <sumin@hanbit.example>',
  subject = 'Re: 세미나 견적 부탁드립니다', body = '지난번 견적에서 인원을 40명으로 바꿔 다시 부탁드립니다.', thread = null, demo = true } = {}) {
  if (demo) {
    await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do nothing`, [user.id, user.email])
    await q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [user.id, mailId, sender, subject, body])
  }
  const [a] = await q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,$2,$3,'',$4) returning *`, [user.id, verb, text, { mail_id: mailId, from: sender, subject, ...(thread ? { thread_id: thread } : {}) }])
  return a
}
const mainId = async (userId) => (await q(`select id from pro_threads where user_id=$1 and kind='chat' order by created_at limit 1`, [userId]))[0]?.id
const instThread = async (userId, instId) => (await q(`select id from pro_threads where user_id=$1 and ref=$2`, [userId, instId]))[0]?.id
const msgs = async (threadId) => (threadId ? q(`select role, kind, content from pro_messages where thread_id=$1 order by created_at`, [threadId]) : [])
const card = async (id) => (await q('select * from pro_actions where id=$1', [id]))[0]

// the company map's reading of a mail (ontology/events.js identify's shape): one suggested process, read sure
const QUOTE = { proc: 'p:quote', name: '견적 요청 · 견적서 작성', status: 'suggested', p: 0.91, measured: true,
  choice: { task: '견적서 작성', p: 0.88, ask: true, suggest: true, measured: true, options: [{ task: '견적서 작성', p: 0.88 }, { task: '요청 확인', p: 0.08 }], procName: '견적 요청 · 견적서 작성', procP: 0.91 } }
const routeTo = (...matches) => { const calls = []; const fn = async (ev) => { calls.push(ev); return { none: !matches.length, matches, reads: [] } }; fn.calls = calls; return fn }
const judgeSays = (p) => { const calls = []; const fn = async (inst, mail) => { calls.push({ inst, mail }); return typeof p === 'function' ? p(inst) : p }; fn.calls = calls; return fn }
// a stand-in for run.js startCase: the instance and the case, as a start leaves them (no graph, no engine)
const fakeStart = (name = '견적 요청 · 견적서 작성 · 한빛상사') => {
  const calls = []
  const fn = async (me, args) => {
    calls.push({ me, args })
    const instId = `mailflow-test.${crypto.randomUUID()}`
    insts.push(instId)
    await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, tenant_id, status, participants, start_date, updated_at) values ($1,$2,$3,'RUNNING',$4, now(), now())`, [instId, name, T, [me.id]])
    const [c] = await q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, request, status) values ($1,$2,$3,$4,$5,$6,$7,'running') returning id::text as id`,
      [T, args.procKey, args.entry, me.id, { kind: args.kind, subject: args.subject, from: args.from }, [instId], { subject: args.subject, sender: args.from, body: args.body }])
    return { caseId: c.id, instId, instName: name, snapshot: { skipped: [], nodes: [] } }
  }
  fn.calls = calls
  return fn
}

// ---------- fake model (and Gmail) ----------
const real = globalThis.fetch
let triage = { actions: [], brief: '' }
const gmail = { messages: [] } // [{id, threadId, from, subject, text}]
let odds = 0.9 // the judge's first-token probability of 「같은 일」
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u === `${config.llm.baseUrl}/chat/completions`) {
    const body = JSON.parse(init.body || '{}')
    if (body.max_tokens === 1 && body.logprobs) {
      return Response.json({ choices: [{ message: { content: 'A' }, logprobs: { content: [{ token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(odds) }, { token: 'B', logprob: Math.log(1 - odds) }] }] } }] })
    }
    const sys = String(body.messages?.[0]?.content || '')
    const answer = sys.startsWith("You read a user's newest emails") ? triage : {}
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }] })
  }
  if (u.startsWith(config.google.gmailUrl)) {
    if (u.includes('/messages?')) return Response.json({ messages: gmail.messages.map((m) => ({ id: m.id, threadId: m.threadId })) })
    const m = gmail.messages.find((x) => u.includes(`/messages/${x.id}?format=full`))
    if (m) {
      return Response.json({ id: m.id, threadId: m.threadId, labelIds: ['INBOX'], snippet: m.text,
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: m.from }, { name: 'To', value: 'me@lite.example' }, { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date().toUTCString() }],
          body: { data: Buffer.from(m.text).toString('base64url') } } })
    }
    return Response.json({ error: { message: 'not found' } }, { status: 404 })
  }
  return real(url, init)
}

test('칩: 카드의 id · 메일 id · 동사 · 글, 인스턴스에 이어졌으면 그 인스턴스 — 조사는 받침에 따라', () => {
  assert.deepEqual(MF.refOf({ id: 'a1', verb: 'Sign', text: '참가 동의서 서명', source: { mail_id: 'm1' } }), { actionId: 'a1', mailId: 'm1', verb: 'Sign', text: '참가 동의서 서명' })
  assert.deepEqual(MF.refOf({ id: 'a1', verb: 'Reply', text: 't', source: { mail_id: 'm1', inst: { instId: 'i1', name: '견적', via: 'start' } } }).inst, { instId: 'i1', name: '견적' })
  assert.equal(MF.nameOf('"이수민" <sumin@hanbit.example>'), '이수민')
  assert.equal(MF.nameOf('sumin@hanbit.example'), 'sumin@hanbit.example')
  assert.equal(MF.jo('견적', '을/를'), '을')
  assert.equal(MF.jo('세미나', '을/를'), '를')
  assert.equal(MF.jo('견적 요청', '으로/로'), '으로')
  assert.equal(MF.jo('견적서 작성 메일', '으로/로'), '로', 'ㄹ 받침은 「로」')
  // the judge sees the running instance as 「이미 묶인 건」 and the mail as 「새 건」 (the link-cases judge's own question)
  const s = MF.sameState({ name: '견적 · 한빛상사', subject: '세미나 견적', from: '이수민 <s@h.example>', about: '30명' }, { subject: 'Re: 세미나 견적', from: '이수민 <s@h.example>', text: '40명으로' })
  assert.match(s, /^이미 묶인 건:\n- 견적 · 한빛상사 · 제목 세미나 견적 · 상대 이수민 · 내용 "30명"\n\n새 건:\n- 메일 · 제목 Re: 세미나 견적 · 보낸 사람 이수민 · 내용 "40명으로"$/)
  // the router's matches as a card keeps them: a match with no start task is not one to offer
  assert.deepEqual(MF.matchesOf({ matches: [QUOTE, { proc: 'p:x', name: 'x', status: 'suggested', p: 0.8, choice: null }] }).map((m) => [m.proc, m.stage, m.task]), [['p:quote', 'suggested', '견적서 작성']])
})

test('모닝 브리프는 그 메일들의 Home 카드 칩을 단다 — 요약만 남지 않는다', async () => {
  const user = await newUser()
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2)`, [user.id, user.email])
  const mailId = `demo-mf-brief-${crypto.randomBytes(4).toString('hex')}`
  await q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [user.id, mailId, '행사 사무국 <desk@event.example>', '참가 동의서 서명 요청', '12월 12-13일 행사 전까지 참가 동의서에 서명해 주세요.'])
  triage = { actions: [{ mail_id: mailId, verb: 'Sign', text: '행사 참가 동의서를 서명해 주세요', icon_domain: '', due: null, prompt: '동의서 서명' }], brief: '행사 참가 동의서를 서명해야 해요. 12월 12-13일 행사 전까지 처리하면 됩니다.' }
  await pollUser(user.id)
  const [a] = await q(`select * from pro_actions where user_id=$1 and source->>'mail_id'=$2`, [user.id, mailId])
  assert.ok(a, '카드가 생긴다')
  const m = await msgs(await mainId(user.id))
  const divider = m.find((x) => x.kind === 'divider')
  assert.match(divider.content.text, /브리프/)
  const brief = m.find((x) => x.kind === 'text' && x.content.text === triage.brief)
  assert.deepEqual(brief.content.mails, [{ actionId: a.id, mailId, verb: 'Sign', text: '행사 참가 동의서를 서명해 주세요' }])
  // the chip names the card: the server finds it by its id, or by its mail
  assert.equal((await MF.cardByRef(user.id, { action: a.id })).id, a.id)
  assert.equal((await MF.cardByRef(user.id, { mail: mailId })).id, a.id)
  await assert.rejects(MF.cardByRef(user.id, { action: crypto.randomUUID() }), (e) => e.status === 404)
  const other = await newUser('other@lite.example', '김다른')
  await assert.rejects(MF.cardByRef(other.id, { action: a.id }), (e) => e.status === 404, '남의 카드는 찾지 못한다')
})

test('시트: 지도가 「제안」 프로세스의 시작으로 읽고, 판정 모델이 같은 일이라 한 진행 중인 인스턴스를 「잇기」로 권한다 — 한 번 읽은 것은 카드에 남는다', async () => {
  const user = await newUser()
  const run = await runningCase(user)
  const other = await runningCase(user, { name: '교육 일정 조율 · 바깥 기관', proc: 'p:edu', subject: '교육 일정 안내', from: '교육팀 <edu@school.example>' })
  const a = await mailCard(user)
  const route = routeTo(QUOTE, { ...QUOTE, proc: 'p:watch', name: '관찰 중인 일', status: 'paused' })
  const judge = judgeSays((inst) => (inst.instId === run.instId ? 0.93 : 0.04))
  const f = await MF.flowOfCard(user, a.id, { route, judge })
  assert.equal(f.linked, null)
  assert.deepEqual(f.matches.map((m) => [m.proc, m.stage, m.task]), [['p:quote', 'suggested', '견적서 작성']], '관찰 단계 프로세스는 권하지 않는다')
  assert.deepEqual(f.joins.map((j) => [j.instId, j.by, j.p]), [[run.instId, 'judge', 0.93]], '다른 일(4%)은 권하지 않는다')
  // the judge read the mail as it arrived, against each running instance (the matched process's first)
  assert.equal(route.calls.length, 1)
  assert.match(route.calls[0].text, /40명으로 바꿔/)
  assert.deepEqual(judge.calls.map((c) => c.inst.instId), [run.instId, other.instId])
  assert.equal(judge.calls[0].mail.subject, 'Re: 세미나 견적 부탁드립니다')
  const kept = (await card(a.id)).source.flow
  assert.equal(kept.matches[0].proc, 'p:quote')
  assert.equal(kept.same[run.instId], 0.93)
  // opened again: nothing is read again
  const again = await MF.flowOfCard(user, a.id, { route, judge })
  assert.deepEqual(again.joins.map((j) => j.instId), [run.instId])
  assert.equal(route.calls.length, 1)
  assert.equal(judge.calls.length, 2)
})

test('같은 Gmail 스레드의 앞 메일이 진행 중인 인스턴스에 이어져 있으면 모델 없이 그 인스턴스가 먼저 — 끝난 인스턴스는 아니다', async () => {
  const user = await newUser()
  const run = await runningCase(user)
  const first = await mailCard(user, { thread: 'thr-quote', text: '첫 견적 요청' })
  await MF.linkCards(user.id, first, { instId: run.instId, caseId: run.caseId, name: run.name, via: 'start' }, { quiet: true })
  const next = await mailCard(user, { thread: 'thr-quote', text: '수정 요청' })
  const judge = judgeSays(0.1)
  const f = await MF.flowOfCard(user, next.id, { route: routeTo(), judge })
  assert.deepEqual(f.joins.map((j) => [j.instId, j.by, j.p]), [[run.instId, 'thread', 1]])
  assert.equal(judge.calls.filter((c) => c.inst.instId === run.instId).length, 0, '스레드로 이어진 인스턴스는 판정하지 않는다')
  // the instance ended: the thread no longer leads anywhere
  await q(`update bpm_proc_inst set status='COMPLETED' where proc_inst_id=$1`, [run.instId])
  assert.equal(await MF.threadLink(user.id, 'thr-quote', next.id), null)
})

test('새로 시작: 그 프로세스의 건을 메일의 시작 일부터 열고, 메일이 인스턴스 대화의 첫 사건, 카드와 브리프 칩이 인스턴스를 가리킨다 — 두 번은 안 된다', async () => {
  const user = await newUser()
  const a = await mailCard(user)
  const main = (await q(`insert into pro_threads(user_id, kind, title) values ($1,'chat','채팅') returning id`, [user.id]))[0].id
  await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'agent','text',$2)`, [main, { text: '한빛상사가 견적을 다시 부탁했어요.', mails: [MF.refOf(a), { actionId: crypto.randomUUID(), mailId: 'x', verb: 'Review', text: '다른 메일' }] }])
  await MF.flowOfCard(user, a.id, { route: routeTo(QUOTE), judge: judgeSays(null) })
  const start = fakeStart()
  // only a process the map read for this mail
  await assert.rejects(MF.startFromCard(user, a.id, { proc: 'p:other' }, { start }), (e) => e.status === 400)
  const r = await MF.startFromCard(user, a.id, { proc: 'p:quote' }, { start })
  assert.equal(start.calls.length, 1)
  const args = start.calls[0].args
  assert.deepEqual([args.procKey, args.entry, args.kind, args.subject, args.customer], ['p:quote', '견적서 작성', 'mail', 'Re: 세미나 견적 부탁드립니다', '이수민'])
  assert.match(args.body, /40명으로 바꿔/, '메일 본문이 건의 요청')
  const row = await card(a.id)
  assert.deepEqual([row.source.inst.instId, row.source.inst.via, row.source.inst.procName], [r.instId, 'start', '견적 요청 · 견적서 작성'])
  // the brief's chip of this card now opens the instance; the other chip is untouched
  const [b] = await msgs(main)
  assert.deepEqual(b.content.mails[0].inst, { instId: r.instId, name: '견적 요청 · 견적서 작성 · 한빛상사' })
  assert.equal(b.content.mails[1].inst, undefined)
  // the mail is the instance's first event, in its conversation (not the main chat)
  const im = await msgs(await instThread(user.id, r.instId))
  assert.deepEqual(im.map((x) => x.kind), ['divider', 'text'])
  assert.equal(im[0].content.text, '메일 · Re: 세미나 견적 부탁드립니다')
  assert.equal(im[1].content.text, '이수민님의 메일 「Re: 세미나 견적 부탁드립니다」로 ‘견적 요청 · 견적서 작성’을 시작했어요. 「견적서 작성」부터 해요.')
  assert.deepEqual([im[1].content.mail.actionId, im[1].content.mailEvent], [a.id, 'start'])
  assert.equal((await msgs(main)).length, 1, '메인 채팅에는 덧붙이지 않는다')
  // the sheet now says where the mail is; a second answer is refused
  assert.equal((await MF.flowOfCard(user, a.id)).linked.instId, r.instId)
  await assert.rejects(MF.startFromCard(user, a.id, { proc: 'p:quote' }, { start }), (e) => e.status === 409)
  await assert.rejects(MF.joinFromCard(user, a.id, { instId: r.instId }), (e) => e.status === 409)
  assert.equal(start.calls.length, 1)
})

test('시작이 실패하면 카드는 묶이지 않고 다시 누를 수 있다', async () => {
  const user = await newUser()
  const a = await mailCard(user)
  await MF.flowOfCard(user, a.id, { route: routeTo(QUOTE), judge: judgeSays(null) })
  await assert.rejects(MF.startFromCard(user, a.id, { proc: 'p:quote' }, { start: async () => { throw Object.assign(new Error('지도 엔진에 닿지 않아요'), { status: 503 }) } }), /지도 엔진/)
  const row = await card(a.id)
  assert.equal(row.source.inst, undefined)
  assert.equal(row.source.linking, undefined, '잡아 둔 것을 풀었다')
  const r = await MF.startFromCard(user, a.id, { proc: 'p:quote' }, { start: fakeStart() })
  assert.ok(r.instId)
})

test('잇기: 진행 중인 인스턴스에 메일을 잇는다 — 판정으로 권한 것은 그 확률과 함께, 끝난 인스턴스 · 볼 수 없는 인스턴스는 안 된다', async () => {
  const user = await newUser()
  const run = await runningCase(user)
  const a = await mailCard(user)
  await MF.flowOfCard(user, a.id, { route: routeTo(QUOTE), judge: judgeSays(0.87) })
  const stranger = await newUser('stranger@lite.example', '남')
  const theirs = await runningCase(stranger, { name: '남의 일' })
  await assert.rejects(MF.joinFromCard(user, a.id, { instId: theirs.instId }), (e) => e.status === 403)
  const r = await MF.joinFromCard(user, a.id, { instId: run.instId })
  const row = await card(a.id)
  assert.deepEqual([row.source.inst.instId, row.source.inst.via, row.source.inst.by, row.source.inst.p, row.source.inst.caseId], [run.instId, 'join', 'judge', 0.87, run.caseId])
  const im = await msgs(await instThread(user.id, r.instId))
  assert.equal(im.at(-1).content.text, '이수민님의 메일 「Re: 세미나 견적 부탁드립니다」를 이 일에 이었어요.')
  assert.equal(im.at(-1).content.mailEvent, 'join')
  // an ended instance takes no mail
  const done = await runningCase(user, { status: 'COMPLETED' })
  const b = await mailCard(user)
  await assert.rejects(MF.joinFromCard(user, b.id, { instId: done.instId }), (e) => e.status === 409 && e.code === 'ended')
})

test('이번엔 안 해요: 시트가 더 묻지 않고, 다시 묻기로 되돌린다', async () => {
  const user = await newUser()
  const a = await mailCard(user)
  const route = routeTo(QUOTE)
  await MF.flowOfCard(user, a.id, { route, judge: judgeSays(null) })
  await MF.declineFlow(user, a.id)
  const f = await MF.flowOfCard(user, a.id, { route, judge: judgeSays(null) })
  assert.deepEqual([f.declined, f.matches.length, f.joins.length], [true, 0, 0])
  await MF.declineFlow(user, a.id, { undo: true })
  const g = await MF.flowOfCard(user, a.id, { route, judge: judgeSays(null) })
  assert.deepEqual([g.declined, g.matches[0].proc], [false, 'p:quote'])
  assert.equal(route.calls.length, 1, '되돌려도 지도는 다시 읽지 않는다(카드에 남은 것)')
})

test('판정 모델: 같은 일 확률을 첫 토큰으로 읽는다(prompts/same-work.md) — 문턱(joinMin) 아래면 권하지 않는다', async () => {
  const user = await newUser()
  const run = await runningCase(user)
  const a = await mailCard(user)
  odds = 0.82
  const f = await MF.flowOfCard(user, a.id, { route: routeTo() })
  assert.deepEqual(f.joins.map((j) => [j.instId, j.p]), [[run.instId, 0.82]])
  const b = await mailCard(user, { text: '다른 메일' })
  odds = 0.4
  const g = await MF.flowOfCard(user, b.id, { route: routeTo() })
  assert.deepEqual(g.joins, [])
  odds = 0.9
})

test('답장: 인스턴스에 이어진 메일의 답장은 그 인스턴스 대화에 남고, 메인 채팅에는 덧붙이지 않는다', async () => {
  const user = await newUser()
  const run = await runningCase(user)
  const a = await mailCard(user)
  await MF.linkCards(user.id, a, { instId: run.instId, caseId: run.caseId, name: run.name, via: 'join' }, { quiet: true })
  const r = await R.sendReply(user, a.id, { to: '이수민 <sumin@hanbit.example>', subject: 'Re: 세미나 견적 부탁드립니다', body: '40명 기준으로 다시 보내 드리겠습니다.' })
  assert.equal(r.sent.via, 'demo')
  assert.deepEqual(r.inst, { instId: run.instId, name: run.name })
  const im = await msgs(await instThread(user.id, run.instId))
  const said = im.find((x) => x.content.sent_mail)
  assert.match(said.content.text, /데모 메일함이라 이수민에게 보낼 답장/)
  assert.deepEqual([said.content.mailEvent, said.content.mail.actionId], ['reply', a.id])
  assert.equal((await msgs(await mainId(user.id))).filter((x) => x.content.sent_mail).length, 0)
  // a mail that belongs to no instance: as before, in the main chat — with its chip
  const b = await mailCard(user, { text: '다른 메일' })
  await R.sendReply(user, b.id, { to: '이수민 <sumin@hanbit.example>', subject: 'Re: 다른 메일', body: '확인했습니다.' })
  const [m] = (await msgs(await mainId(user.id))).filter((x) => x.content.sent_mail)
  assert.equal(m.content.mail.actionId, b.id)
  assert.equal(m.content.mailEvent, undefined)
})

test('들어올 때(자동): 지도가 「자동」 프로세스의 확실한 시작으로 읽으면 저절로 시작하고, 카드가 그 인스턴스를 가리키며 Home 알림 — 메인 채팅엔 없다', async () => {
  const user = await newUser()
  const a = await mailCard(user)
  const auto = { ...QUOTE, status: 'adopted', choice: { ...QUOTE.choice, ask: false, suggest: undefined } }
  const start = fakeStart()
  const r = await MF.routeMailCards(user.id, { from: a.source.from, subject: a.source.subject, text: '지난번 견적에서 인원을 40명으로 바꿔 다시 부탁드립니다.' }, [a], { route: routeTo(auto), start, rules: { maxStarts: 3 } })
  assert.equal(r.started.length, 1)
  const row = await card(a.id)
  assert.deepEqual([row.source.inst.instId, row.source.inst.via], [r.instId, 'auto'])
  assert.equal(row.source.flow.matches[0].stage, 'adopted')
  const im = await msgs(await instThread(user.id, r.instId))
  assert.match(im.at(-1).content.text, /저절로 시작됐어요\(자동 단계\)/)
  const [n] = await q(`select title, url, type from notifications where user_id=$1`, [user.id])
  assert.deepEqual([n.url, n.type], [`/routines/${r.instId}`, 'process_started'])
  assert.equal(await mainId(user.id), undefined, '메인 채팅에는 아무것도 없다')
  // a suggested process is not started: the card keeps it, its sheet asks
  const b = await mailCard(user)
  const s = await MF.routeMailCards(user.id, { from: b.source.from, subject: b.source.subject, text: '...' }, [b], { route: routeTo(QUOTE), start, rules: { maxStarts: 3 } })
  assert.deepEqual([s.started.length, s.offered[0].proc], [0, 'p:quote'])
  assert.equal(start.calls.length, 1)
  assert.equal((await card(b.id)).source.inst, undefined)
  assert.equal((await card(b.id)).source.flow.matches[0].proc, 'p:quote')
  // nothing for the map: the old paths take it (process mining, the ad-hoc drafts)
  const c = await mailCard(user)
  assert.equal(await MF.routeMailCards(user.id, { subject: 'x', text: 'y', from: 'z' }, [c], { route: routeTo(), start }), false)
})

test('들어올 때(스레드): Gmail 스레드의 새 메일은 모델 없이 진행 중인 인스턴스로 — 인스턴스 대화 · Home 알림, 브리프 칩도 그 인스턴스', async () => {
  const user = await newUser()
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'gmail',$2)`, [user.id, user.email])
  await vault.putItem(user.id, 'oauth', 'google', { username: user.email, access_token: 'at-test', refresh_token: 'rt-test', expires_at: Date.now() + 3600_000, scope: 'openid', client_id: 'cid' }, { actor: 'mail' })
  gmail.messages = [{ id: `g-${crypto.randomBytes(3).toString('hex')}`, threadId: 'thr-9', from: '이수민 <sumin@hanbit.example>', subject: '세미나 견적 부탁드립니다', text: '12월 세미나 30명 견적 부탁드립니다.' }]
  triage = { actions: [{ mail_id: gmail.messages[0].id, verb: 'Reply', text: '한빛상사 세미나 견적 요청', prompt: '' }], brief: '한빛상사가 세미나 견적을 부탁했어요.' }
  await pollUser(user.id)
  const [first] = await q(`select * from pro_actions where user_id=$1`, [user.id])
  assert.equal(first.source.thread_id, 'thr-9', '카드가 메일의 Gmail 스레드를 지닌다')
  const run = await runningCase(user)
  await MF.linkCards(user.id, first, { instId: run.instId, caseId: run.caseId, name: run.name, via: 'start' }, { quiet: true })
  // the customer writes again in the same thread
  gmail.messages = [...gmail.messages, { id: `g-${crypto.randomBytes(3).toString('hex')}`, threadId: 'thr-9', from: '이수민 <sumin@hanbit.example>', subject: 'Re: 세미나 견적 부탁드립니다', text: '인원이 40명으로 늘었습니다.' }]
  triage = { actions: [{ mail_id: gmail.messages[1].id, verb: 'Reply', text: '한빛상사 인원 변경 회신', prompt: '' }], brief: '한빛상사가 인원을 40명으로 바꿨어요.' }
  await pollUser(user.id)
  const [next] = await q(`select * from pro_actions where user_id=$1 and source->>'mail_id'=$2`, [user.id, gmail.messages[1].id])
  assert.deepEqual([next.source.inst.instId, next.source.inst.via], [run.instId, 'thread'])
  const im = await msgs(await instThread(user.id, run.instId))
  assert.equal(im.at(-1).content.text, '같은 메일 스레드로 이수민님의 새 메일 「Re: 세미나 견적 부탁드립니다」가 왔어요.')
  const [n] = await q(`select title, url, type from notifications where user_id=$1`, [user.id])
  assert.deepEqual([n.url, n.type], [`/routines/${run.instId}`, 'process_mail'])
  assert.match(n.title, /^메일이 이어졌어요 · /)
  const brief = (await msgs(await mainId(user.id))).find((x) => x.content.text === '한빛상사가 인원을 40명으로 바꿨어요.')
  assert.deepEqual(brief.content.mails[0].inst, { instId: run.instId, name: run.name })
})
