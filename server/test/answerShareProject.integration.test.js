// 답을 공유 · 대화를 프로젝트로 — 실제 DB · 실제 Express 라우트(로그인만 헤더 대역) · 실제 git 템플릿 폴더 · 실제 저장소(로컬 Supabase), 모델은 가짜 fetch
// (첫 글자 확률 길 · 카드 JSON). 스펙 openspec/specs/answer-share · openspec/specs/chat-to-project. 2026-11-27 22:33 휴대폰 녹화.
// 사람 · 회사 · 메일은 지어낸 것이다(정하윤 · 김서연 · 박도윤 · 최유나, 가나정밀 이준호).
//   AP-U-01 순수: 답의 제목 · 문서 이름 · 문서 글 · 방 순서 · 카드의 모양(모르는 템플릿 key 는 버림) · 추천(판정의 고른 것, 까닭) · 판정이 읽는 템플릿 · 계획
//   AP-U-02 방 고르기: 내 대화방(이 대화의 답을 올린 방이 먼저) · 대화가 없는 팀원 · 남의 답 404 · 답이 아닌 메시지 400
//   AP-U-03 방에 보내기: 방에 'answer' 메시지(제목 · 글 · 한마디, 작업 공간 경로 없음) · 방 사람들의 알림 · 답에 남은 기록 · 팀원에게 바로(1:1 을 만듦) ·
//           팀원이 아닌 사람 · 나 자신 403 · 내가 없는 방 404 · 팀에서 빠진 사람이 있는 방 403(아무것도 올라가지 않음)
//   AP-U-04 문서로 남기기: Markdown 파일 카드(한 번만), 답에 기록 · 남의 답 404
//   AP-U-05 「프로젝트로 시작」 카드: 판정이 고른 템플릿만(까닭 한 줄) · 실행 권한이 없는 템플릿은 후보에도 없음 · 출처 메일 · 아직 아무것도 만들지 않음
//   AP-U-06 「만들기」(템플릿): 템플릿 작업 공간 · 계획(목적 · 만들 것 · 배경 · 출처) · 첫 문서 · 채팅의 「프로젝트로 옮겼어요」 · 원래 대화 그대로 · 두 번째 409
//   AP-U-07 빈 프로젝트 · 「아니요」 · 실행 권한 없는 템플릿 403(프로젝트 안 생김) · 남의 카드 404
//   AP-U-08 템플릿이 하나도 없으면 판정 모델을 부르지 않고 추천도 없음
// Run: node --test --test-concurrency=1 test/answerShareProject.integration.test.js  (needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-answer-project-'))
const TENANT = 'answer-project-test'
delete process.env.PRO_TENANT_FROM_HEADER
process.env.PRO_BACKGROUND = '0'
process.env.PRO_TENANT_ID = TENANT
process.env.PRO_TENANT_HOSTS = ''
process.env.PRO_FOLDERS_ROOT = path.join(ROOT, 'folders')
process.env.PRO_ONTOLOGY_BOLT_URL = ''
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_MEMENTO_URL = 'http://127.0.0.1:9'
process.env.PRO_JUDGE_URL = ''
process.env.PRO_DEEPAGENTS_URL = 'https://deepagents.fake.example'
process.env.PRO_LLM_BASE_URL = 'https://llm.fake.example/v1'
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_LLM_KEYS = 'off'
process.env.PRO_LLM_MODEL = 'fake'
process.env.PRO_LLM_FAST_MODEL = 'fake'

const { config } = await import('../config.js')
const { q, pool, admin } = await import('../lib/supa.js')
const AS = await import('../lib/answerShare.js')
const CP = await import('../lib/chatProject.js')
const db = await q('select 1 from pro_folder_refs limit 1').then(() => true, () => false)

// ---------- the fake model: the judge picks the template whose label holds `pick`; the card's JSON names a template and why ----------
const llm = { pick: '교육 과정 만들기', p: 0.82, judges: 0, drafts: [], draft: null, states: [] }
const real = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.startsWith(config.llm.baseUrl)) {
    const b = JSON.parse(init.body || '{}')
    const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    if (b.logprobs) {
      llm.judges++
      llm.states.push(text)
      const options = [...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
      const hit = options.find((o) => o.label.includes(`「${llm.pick}`)) || options.at(-1)
      const other = options.find((o) => o.letter !== hit.letter) || { letter: 'Z' }
      return Response.json({ choices: [{ message: { content: hit.letter }, logprobs: { content: [{ token: hit.letter, top_logprobs: [{ token: hit.letter, logprob: Math.log(llm.p) }, { token: other.letter, logprob: Math.log(1 - llm.p) }] }] } }] })
    }
    const sys = String(b.messages?.[0]?.content || '')
    if (sys.startsWith('너는 채팅에서 하던 이야기를')) {
      llm.drafts.push(String(b.messages?.[1]?.content || ''))
      return Response.json({ choices: [{ message: { content: JSON.stringify(llm.draft || {}) }, finish_reason: 'stop' }] })
    }
    return Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
  }
  if (/\/servers$|\/bindings$/.test(u)) return Response.json([])
  return real(url, init)
}

// ---------- people, rooms, folders, the routes ----------
const users = [], rooms = [], closers = []
after(async () => {
  for (const c of closers) c()
  if (db) {
    for (const r of await q(`select id from chat_rooms where tenant_id=$1`, [TENANT]).catch(() => [])) {
      await q('delete from chats where id=$1', [r.id]).catch(() => {})
      await q('delete from pro_chat_reads where room_id=$1', [r.id]).catch(() => {})
      await q('delete from chat_rooms where id=$1', [r.id]).catch(() => {})
    }
    for (const u of users) {
      await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
      await q('delete from pro_thread_folders where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
      await q('delete from pro_threads where user_id=$1', [u.id]).catch(() => {})
      await q('delete from pro_actions where user_id=$1', [u.id]).catch(() => {})
      await q('delete from pro_team_members where user_id=$1', [u.id]).catch(() => {})
      await q('delete from pro_profile where user_id=$1', [u.id]).catch(() => {})
      const keys = (await q(`select name from storage.objects where bucket_id='files' and starts_with(name, $1)`, [`pgpt-pro/${u.id}/`]).catch(() => [])).map((r) => r.name)
      if (keys.length) await admin.storage.from('files').remove(keys).catch(() => {})
      await q('delete from users where id=$1', [u.id]).catch(() => {})
    }
    await q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from pro_folders where tenant_id=$1', [TENANT]).catch(() => {})
    await q('delete from tenants where id=$1', [TENANT]).catch(() => {})
    const S = await import('../lib/folders/service.js')
    await fs.rm(S.workspaceDir(), { recursive: true, force: true }).catch(() => {})
  }
  await pool.end()
  await fs.rm(ROOT, { recursive: true, force: true })
  globalThis.fetch = real
})

async function person(name, { team = true } = {}) {
  const id = crypto.randomUUID()
  const u = { id, email: `ap-${id.slice(0, 8)}@lite.example`, name }
  users.push(u)
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,$4)`, [id, u.email, `pgpt-${id.slice(0, 6)}`, TENANT])
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [id, name, u.email])
  if (team) await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$2) on conflict do nothing`, [TENANT, id])
  return u
}
let base = null
async function call(u, method, p, body) {
  if (!base) {
    const express = (await import('express')).default
    const { teamRoutes } = await import('../routes/team.js')
    const { answerRoutes } = await import('../routes/answers.js')
    const app = express()
    app.use(express.json())
    const auth = (req, res, next) => {
      const me = users.find((x) => x.id === req.headers['x-test-user'])
      if (!me) return res.status(401).json({ error: 'unauthorized' })
      req.user = { id: me.id, email: me.email, name: me.name }; req.session = { access_token: 'test' }; next()
    }
    app.use('/api', teamRoutes(auth))
    app.use('/api', answerRoutes(auth))
    const s = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)) })
    closers.push(() => s.close())
    base = `http://127.0.0.1:${s.address().port}/api`
  }
  const r = await real(`${base}${p}`, { method, headers: { 'x-test-user': u.id, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, body: json, text }
}
const msgs = (tid) => q('select id, role, kind, content from pro_messages where thread_id=$1 order by created_at', [tid])
const roomMsgs = async (u, room) => (await call(u, 'GET', `/team/threads/${room}/messages`)).body.messages

const ANSWER = '# 데이터 분석 실무 교육안\n\n요청 메일을 기준으로 3일 과정을 정리했어요.\n\n1. **1일차** — 스프레드시트 기초\n2. **2일차** — 대시보드 만들기 실습\n3. **3일차** — 발표와 피드백\n\n초안 파일: [교육안.md](</workspace/.bpmn/conv-1/교육안.md>)'
const JUNHO = '이준호 <junho@gana-precision.example>'
let cast = null
async function setup() {
  if (cast) return cast
  const { ensureTenantRow } = await import('../lib/tenant.js')
  await ensureTenantRow(TENANT).catch(() => {})
  const me = await person('정하윤'), k = await person('김서연'), p = await person('박도윤'), c = await person('최유나'), out = await person('외부 사람', { team: false })
  const grp = await call(me, 'POST', '/team/threads', { members: [k.id, c.id], title: '가나정밀 교육 준비' })
  const dm = await call(me, 'POST', '/team/threads', { members: [k.id] })
  const theirs = await call(k, 'POST', '/team/threads', { members: [p.id], title: '다른 사람들의 방' })
  for (const x of [grp, dm, theirs]) { assert.equal(x.status, 200, x.text); rooms.push(x.body.id) }
  // my chat: the mail's card, my question, the answer (a document answer), a short acknowledgement
  const [card] = await q(`insert into pro_actions(user_id,verb,text,source) values ($1,'Review',$2,$3) returning *`, [me.id, '1차 교육 요청', { mail_id: 'demo-ap-1', from: JUNHO, subject: '1차 교육 과정 요청드립니다' }])
  const [chat] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','채팅') returning *`, [me.id])
  const ins = async (role, kind, content) => (await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,$2,$3,$4) returning *`, [chat.id, role, kind, content]))[0]
  await ins('user', 'text', { text: '받은 메일의 1차 교육 요청 내용 조사해 줘', refs: [{ as: 'mail', actionId: card.id, name: '1차 교육 과정 요청드립니다', from: '이준호' }] })
  const answer = await ins('agent', 'doc', { text: ANSWER, context: { conversationId: 'conv-ap-1', action: 'new', title: '교육 요청 조사' } })
  const ack = await ins('agent', 'text', { text: '네, 처리할게요.' })
  const question = await ins('user', 'text', { text: '이 내용을 기반으로 프로젝트를 하나 만들자' })
  // someone else's chat and answer
  const [kChat] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','채팅') returning *`, [k.id])
  const [kAnswer] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2) returning *`, [kChat.id, { text: '김서연의 답이에요. '.repeat(10) }])
  cast = { me, k, p, c, out, grp: grp.body.id, dm: dm.body.id, theirs: theirs.body.id, card, chat, answer, ack, question, kAnswer }
  return cast
}

// ---------- the template folders ----------
let tpl = null
async function templates() {
  if (tpl) return tpl
  const { me, p } = await setup()
  const S = await import('../lib/folders/service.js')
  const TPL = await import('../lib/folders/templates.js')
  const { reindex } = await import('../lib/folders/indexer.js')
  const put = async (f, who, rel, body) => { await S.upload(f, who, rel, Buffer.from(body)); await reindex(await S.folderById(f.id), { cards: false }).catch(() => {}) }
  const course = await S.createFolder(me, { name: '교육 과정 만들기 템플릿', description: '교육 과정을 설계할 때 쓰는 폴더' })
  await put(course, me, 'TEMPLATE.md', '---\ndescription: 교육 과정을 설계하고 교안과 일정표를 만들 때 시작해요\noutputs: 산출물/\n---\n# 교육 과정 템플릿\n')
  await put(course, me, '교안 양식.md', '# 교안 양식\n\n## 과정 개요\n## 일차별 목표\n')
  await put(course, me, '.claude/skills/curriculum-builder/SKILL.md', '---\nname: curriculum-builder\ndescription: 일차별 교안과 실습 목록을 만들어요\n---\n1. 양식대로\n')
  await TPL.setTemplate(await S.folderById(course.id), me, true)
  const proposal = await S.createFolder(me, { name: '제안서 템플릿', description: '제안서를 쓸 때 쓰는 폴더' })
  await put(proposal, me, 'TEMPLATE.md', '---\ndescription: 제안서를 쓸 때 시작해요\n---\n')
  await TPL.setTemplate(await S.folderById(proposal.id), me, true)
  // 박도윤's template: 정하윤 is no member — never a candidate; and one where 정하윤 only views — not one to start from
  const hidden = await S.createFolder(p, { name: '교육 과정 비공개 템플릿' })
  await put(hidden, p, 'TEMPLATE.md', '---\ndescription: 교육 과정 템플릿(비공개)\n---\n')
  await TPL.setTemplate(await S.folderById(hidden.id), p, true)
  const viewOnly = await S.createFolder(p, { name: '교육 과정 보기 전용 템플릿' })
  await put(viewOnly, p, 'TEMPLATE.md', '---\ndescription: 교육 과정 템플릿(보기만)\n---\n')
  await TPL.setTemplate(await S.folderById(viewOnly.id), p, true)
  await S.setMember(await S.folderById(viewOnly.id), p, { id: me.id, role: 'viewer' })
  tpl = { course: await S.folderById(course.id), proposal: await S.folderById(proposal.id), hidden: await S.folderById(hidden.id), viewOnly: await S.folderById(viewOnly.id) }
  return tpl
}

// ---------- AP-U-01 pure ----------
test('AP-U-01 순수: 제목 · 문서 이름 · 문서 글 · 방 순서 · 카드 모양 · 추천 · 판정이 읽는 템플릿 · 계획', () => {
  const doc = { kind: 'doc', content: { text: ANSWER } }
  assert.equal(AS.titleOf(doc), '데이터 분석 실무 교육안')
  assert.equal(AS.docName(doc), '데이터 분석 실무 교육안.md')
  assert.ok(AS.docBody(doc).startsWith('# 데이터 분석 실무 교육안\n'))
  assert.ok(!AS.sharedText(doc).includes('/workspace/'), '작업 공간 링크는 이름만')
  assert.ok(AS.sharedText(doc).includes('초안 파일: 교육안.md'))
  const text = { kind: 'text', content: { text: '**요약**: 세 가지예요.\n- 하나\n- 둘' } }
  assert.equal(AS.titleOf(text), '요약: 세 가지예요.')
  assert.ok(AS.docBody(text).startsWith('# 요약: 세 가지예요.\n\n**요약**'))
  assert.equal(AS.docName({ kind: 'text', content: { text: 'a/b: c?*' } }), 'a b c.md')
  const ranked = AS.rankRooms([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }], ['r3'])
  assert.deepEqual(ranked.map((r) => [r.id, r.suggested]), [['r3', true], ['r1', false], ['r2', false]])
  assert.equal(ranked[0].why[0].text, '지난번에도 이 대화의 답을 공유한 대화방')
  const d = CP.draftOf({ title: '사내 교육 준비', intent: '3일 과정 교안을 만든다', templates: [{ key: 'a', why: '교안 양식이 있어요' }, { key: 'nope', why: 'x' }], deliverables: ['교안', { text: '일정표' }, '', 'x', 'y'] }, { keys: ['a', 'b'] })
  assert.deepEqual(d.why, { a: '교안 양식이 있어요' }, '모르는 key 는 버림')
  assert.deepEqual(d.deliverables, ['교안', '일정표', 'x'])
  assert.equal(CP.draftOf(null, { fallbackTitle: '데이터 분석 실무 교육안' }).title, '데이터 분석 실무 교육안')
  const T = [{ slug: 'a', name: '교육 과정', description: '교육 과정 설계' }, { slug: 'b', name: '제안서', description: '' }]
  assert.deepEqual(CP.recommend(T, { picks: [{ key: 'a', p: 0.8123 }], why: { a: '교안 양식이 있어요' } }), [{ slug: 'a', name: '교육 과정', description: '교육 과정 설계', why: '교안 양식이 있어요', p: 0.812 }])
  assert.equal(CP.recommend(T, { picks: [{ key: 'b', p: 0.5 }] })[0].why, '이 일과 관련된 템플릿이에요', '까닭이 없으면 기본 문장')
  assert.deepEqual(CP.recommend(T, { picks: null, why: { b: '제안서 양식' } }).map((x) => [x.slug, x.p]), [['b', null]], '판정을 못 읽으면 모델이 고른 것')
  assert.deepEqual(CP.recommend(T, { picks: [] }), [], '판정이 아무것도 고르지 않음')
  const label = CP.templateLabel({ name: '교육 과정', description: '교육 과정 설계', templateMd: '교안을 만들 때', kit: [{ type: 'skill', name: 'curriculum-builder', description: '교안을 만들어요' }] })
  assert.ok(label.includes('「교육 과정」') && label.includes('TEMPLATE.md: 교안을 만들 때') && label.includes('스킬 curriculum-builder(교안을 만들어요)'))
  const plan = CP.planOf({ intent: '교안을 만든다', deliverables: ['교안'], background: '채팅의 조사에서 시작', source: { mail: { subject: '1차 교육 요청', from: '이준호' } } })
  assert.deepEqual(plan.decisions, [{ text: '채팅의 조사에서 시작' }, { text: '출처: 받은 메일 「1차 교육 요청」 · 이준호', pinned: true }])
  assert.deepEqual(plan.deliverables, [{ text: '교안' }])
})

// ---------- AP-U-02 the picker ----------
test('AP-U-02 방 고르기: 내 대화방 · 대화가 없는 팀원 · 남의 답 404 · 답이 아닌 메시지 400', { skip: !db && 'no database' }, async () => {
  const { me, k, p, grp, dm, theirs, answer, question, kAnswer } = await setup()
  const r = await call(me, 'GET', `/messages/${answer.id}/share/rooms`)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.answer.title, '데이터 분석 실무 교육안')
  const ids = r.body.rooms.map((x) => x.id)
  assert.ok(ids.includes(grp) && ids.includes(dm), '내 방 둘')
  assert.ok(!ids.includes(theirs), '내가 없는 방은 없음')
  // (1:1 이 없는 팀원만: 박도윤, 그룹방에만 있는 최유나 — 1:1 이 있는 김서연과 나는 없다, 팀원이 아닌 사람도 없다)
  assert.deepEqual(r.body.people.map((x) => x.name).sort(), ['박도윤', '최유나'].sort())
  assert.ok(!r.body.people.some((x) => x.id === me.id || x.id === k.id), '나 · 1:1 이 있는 김서연은 없음')
  assert.ok(r.body.people.some((x) => x.id === p.id))
  assert.equal((await call(me, 'GET', `/messages/${kAnswer.id}/share/rooms`)).status, 404, '남의 답')
  assert.equal((await call(me, 'GET', `/messages/${question.id}/share/rooms`)).status, 400, '내 말은 답이 아님')
  assert.equal((await call(me, 'GET', '/messages/not-an-id/share/rooms')).status, 404)
})

// ---------- AP-U-03 sharing ----------
test('AP-U-03 방에 보내기 · 팀원에게 바로 · 거절(팀원이 아님 · 나 · 내가 없는 방 · 팀에서 빠진 사람)', { skip: !db && 'no database' }, async () => {
  const { me, k, p, c, out, grp, theirs, answer } = await setup()
  const r = await call(me, 'POST', `/messages/${answer.id}/share/room`, { room: grp, note: '교육안 초안이에요. 일정 봐 주세요' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.room.id, grp)
  assert.equal(r.body.room.title, '가나정밀 교육 준비')
  // what 김서연 sees in the room: the note and the answer's title and words — no workspace address
  const seen = (await roomMsgs(k, grp)).find((m) => m.id === r.body.message)
  assert.equal(seen.kind, 'answer')
  assert.equal(seen.body, '교육안 초안이에요. 일정 봐 주세요')
  assert.equal(seen.answer.title, '데이터 분석 실무 교육안')
  assert.ok(seen.answer.text.includes('2일차') && !seen.answer.text.includes('/workspace/'))
  assert.equal(seen.sender.name, '정하윤')
  // their notices
  const notes = await q(`select user_id, title from notifications where tenant_id=$1 and type='team' and from_user_id=$2`, [TENANT, me.email])
  for (const who of [k, c]) assert.ok(notes.some((n) => n.user_id === who.id && n.title === '정하윤님이 AI 답 「데이터 분석 실무 교육안」을 공유했어요'), who.name)
  // the answer remembers where it went; the picker puts that room first next time
  const [row] = await q('select content from pro_messages where id=$1', [answer.id])
  assert.ok(row.content.answerShares[grp]?.message === r.body.message)
  assert.equal((await call(me, 'GET', `/messages/${answer.id}/share/rooms`)).body.rooms[0].id, grp)
  // a teammate with no conversation of two: made now — without a word, the card says the title
  const d = await call(me, 'POST', `/messages/${answer.id}/share/room`, { person: p.id })
  assert.equal(d.status, 200, d.text)
  const pm = (await roomMsgs(p, d.body.room.id)).find((m) => m.id === d.body.message)
  assert.equal(pm.body, '', '말 없이 보내면 줄은 비우고 카드가 제목을 말함')
  assert.equal(pm.answer.title, '데이터 분석 실무 교육안')
  rooms.push(d.body.room.id)
  // refused
  assert.equal((await call(me, 'POST', `/messages/${answer.id}/share/room`, { person: out.id })).status, 403, '팀원이 아닌 사람')
  assert.equal((await call(me, 'POST', `/messages/${answer.id}/share/room`, { person: me.id })).status, 403, '나 자신')
  assert.equal((await call(me, 'POST', `/messages/${answer.id}/share/room`, { room: theirs })).status, 404, '내가 없는 방')
  assert.equal((await call(k, 'POST', `/messages/${answer.id}/share/room`, { room: grp })).status, 404, '남의 답은 보낼 수 없음')
  // someone in the room left the team: nothing is posted
  const before = (await roomMsgs(me, grp)).length
  await q('delete from pro_team_members where tenant_id=$1 and user_id=$2', [TENANT, c.id])
  const off = await call(me, 'POST', `/messages/${answer.id}/share/room`, { room: grp })
  assert.equal(off.status, 403, off.text)
  assert.equal((await roomMsgs(me, grp)).length, before, '아무것도 올라가지 않음')
  await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$2) on conflict do nothing`, [TENANT, c.id])
})

// ---------- AP-U-04 a document ----------
test('AP-U-04 문서로 남기기: Markdown 파일 카드(한 번만) · 남의 답 404', { skip: !db && 'no database' }, async () => {
  const { me, k, chat, answer } = await setup()
  const r = await call(me, 'POST', `/messages/${answer.id}/share/doc`)
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.existing, false)
  const card = r.body.message
  assert.equal(card.kind, 'file')
  assert.equal(card.thread_id, chat.id)
  assert.equal(card.content.name, '데이터 분석 실무 교육안.md')
  assert.equal(card.content.fromAnswer, answer.id)
  assert.deepEqual(card.content.context, { conversationId: 'conv-ap-1', action: 'aside' }, '답의 대화에 함께')
  const got = await real(card.content.url)
  assert.equal(got.status, 200)
  const body = await got.text()
  assert.ok(body.startsWith('# 데이터 분석 실무 교육안') && body.includes('3일차'))
  const again = await call(me, 'POST', `/messages/${answer.id}/share/doc`)
  assert.equal(again.body.existing, true)
  assert.equal(again.body.message.id, card.id, '두 번 눌러도 한 장')
  assert.equal((await call(k, 'POST', `/messages/${answer.id}/share/doc`)).status, 404)
})

// ---------- AP-U-05 the card ----------
let offerId = null
test('AP-U-05 「프로젝트로 시작」 카드: 판정이 고른 템플릿만(까닭) · 실행 권한 없는 템플릿은 후보에도 없음 · 출처 메일 · 아직 아무것도 만들지 않음', { skip: !db && 'no database' }, async () => {
  const { me, chat, answer, card } = await setup()
  const T = await templates()
  llm.draft = { title: '가나정밀 데이터 분석 교육', intent: '1차 교육 3일 과정의 교안과 실습 목록을 만든다', background: '받은 메일의 교육 요청을 채팅에서 조사한 내용에서 시작했어요',
    deliverables: ['일차별 교안', '실습 목록'], templates: [{ key: T.course.slug, why: '교안 양식과 교안 스킬이 있어요' }, { key: T.proposal.slug, why: '제안서를 쓸 때' }, { key: T.hidden.slug, why: '숨은 것' }] }
  const projectsBefore = (await q(`select count(*)::int n from pro_threads where user_id=$1 and kind='project'`, [me.id]))[0].n
  const judges = llm.judges
  const r = await call(me, 'POST', `/messages/${answer.id}/project-offer`)
  assert.equal(r.status, 200, r.text)
  const o = r.body.offer
  offerId = o.id
  assert.equal(o.kind, 'project_offer')
  assert.equal(o.thread_id, chat.id)
  assert.equal(o.content.state, 'offered')
  assert.equal(o.content.title, '가나정밀 데이터 분석 교육')
  assert.equal(o.content.intent, '1차 교육 3일 과정의 교안과 실습 목록을 만든다')
  assert.deepEqual(o.content.source.answer, { messageId: answer.id, title: '데이터 분석 실무 교육안' })
  assert.deepEqual(o.content.source.mail, { actionId: card.id, subject: '1차 교육 과정 요청드립니다', from: '이준호' })
  assert.deepEqual(o.content.context, { conversationId: 'conv-ap-1', action: 'aside' })
  // the judge picked one; the model's other lines (one it may not start from) are not recommendations
  assert.equal(llm.judges, judges + 1, '판정 한 번')
  assert.deepEqual(o.content.templates.map((t) => [t.slug, t.why, t.p]), [[T.course.slug, '교안 양식과 교안 스킬이 있어요', 0.82]])
  assert.equal(o.content.hasTemplates, true)
  assert.equal(o.content.read.by, 'logprob')
  // what the judge read: my two templates — not 박도윤's, not the one I only view — each with TEMPLATE.md and its assets
  const state = llm.states.at(-1)
  assert.ok(state.includes('「교육 과정 만들기 템플릿」') && state.includes('「제안서 템플릿」'))
  assert.ok(!state.includes('비공개 템플릿') && !state.includes('보기 전용 템플릿'))
  assert.ok(state.includes('TEMPLATE.md: 교육 과정을 설계하고 교안과 일정표를 만들 때 시작해요'))
  // what the card was written from: the conversation, the answer, the source mail
  const drafted = llm.drafts.at(-1)
  assert.ok(drafted.includes('받은 메일의 1차 교육 요청 내용 조사해 줘') && drafted.includes('2일차') && drafted.includes('1차 교육 과정 요청드립니다'))
  assert.equal((await q(`select count(*)::int n from pro_threads where user_id=$1 and kind='project'`, [me.id]))[0].n, projectsBefore, '아직 만들지 않음')
  assert.equal((await msgs(chat.id)).filter((m) => m.kind === 'project_offer').length, 1)
})

// ---------- AP-U-06 make, from the template ----------
test('AP-U-06 「만들기」(템플릿): 작업 공간 · 계획 · 첫 문서 · 「프로젝트로 옮겼어요」 · 원래 대화 그대로 · 두 번째 409', { skip: !db && 'no database' }, async () => {
  const { me, chat } = await setup()
  const T = await templates()
  const before = await msgs(chat.id)
  const r = await call(me, 'POST', `/project-offers/${offerId}/make`, { title: '가나정밀 1차 교육', template: T.course.slug })
  assert.equal(r.status, 200, r.text)
  const pid = r.body.project.id
  assert.equal(r.body.project.title, '가나정밀 1차 교육')
  assert.deepEqual(r.body.project.template, { slug: T.course.slug, name: '교육 과정 만들기 템플릿' })
  const [t] = await q('select * from pro_threads where id=$1', [pid])
  assert.equal(t.kind, 'project')
  assert.equal(t.user_id, me.id)
  // the template's own 「템플릿으로 시작」: a workspace of the template, held by 정하윤
  const [link] = await q(`select l.mode, v.source, v.holder_id from pro_thread_folders l join pro_folder_variations v on v.id=l.variation_id where l.thread_id=$1`, [pid])
  assert.equal(link.mode, 'project')
  assert.equal(link.source.template.slug, T.course.slug)
  assert.equal(String(link.holder_id), me.id)
  // the plan
  const PN = await import('../lib/projectNote.js')
  const note = await PN.noteRow(me.id, pid)
  assert.equal(note.note.intent, '1차 교육 3일 과정의 교안과 실습 목록을 만든다')
  assert.deepEqual(note.note.deliverables.map((x) => x.text), ['일차별 교안', '실습 목록'])
  assert.deepEqual(note.note.decisions, [{ text: '받은 메일의 교육 요청을 채팅에서 조사한 내용에서 시작했어요' }, { text: '출처: 받은 메일 「1차 교육 과정 요청드립니다」 · 이준호', pinned: true }])
  assert.equal(note.change.kind, 'backfill')
  // the project's room: the plan's chip, 「채팅에서 이어 온 프로젝트예요」, the first document
  const inProject = await msgs(pid)
  assert.ok(inProject.some((m) => m.kind === 'chip' && m.content.planChange?.backfill))
  const from = inProject.find((m) => m.kind === 'chip' && m.content.fromChat)
  assert.equal(from.content.fromChat.conversationId, 'conv-ap-1')
  const doc = inProject.find((m) => m.kind === 'file')
  assert.equal(doc.content.name, '데이터 분석 실무 교육안.md')
  assert.ok((await (await real(doc.content.url)).text()).includes('1일차'))
  // the chat: the card says made, one line 「프로젝트로 옮겼어요」 — everything that was there is still there
  const after = await msgs(chat.id)
  const offer = after.find((m) => m.id === offerId)
  assert.equal(offer.content.state, 'made')
  assert.deepEqual(offer.content.project, { id: pid, title: '가나정밀 1차 교육' })
  const moved = after.find((m) => m.kind === 'chip' && m.content.project)
  assert.equal(moved.content.text, '프로젝트로 옮겼어요 · 가나정밀 1차 교육')
  assert.equal(moved.content.project.id, pid)
  for (const m of before) assert.ok(after.some((x) => x.id === m.id), '원래 대화는 그대로')
  // twice: refused, no second project
  const twice = await call(me, 'POST', `/project-offers/${offerId}/make`, { title: '또' })
  assert.equal(twice.status, 409)
  assert.equal((await q(`select count(*)::int n from pro_threads where user_id=$1 and kind='project' and title='또'`, [me.id]))[0].n, 0)
})

// ---------- AP-U-07 an empty project, 아니요, refusals ----------
test('AP-U-07 빈 프로젝트 · 「아니요」 · 실행 권한 없는 템플릿 403(프로젝트 안 생김) · 남의 카드 404', { skip: !db && 'no database' }, async () => {
  const { me, k, answer } = await setup()
  const T = await templates()
  const o1 = (await call(me, 'POST', `/messages/${answer.id}/project-offer`)).body.offer
  const count = async () => (await q(`select count(*)::int n from pro_threads where user_id=$1 and kind='project'`, [me.id]))[0].n
  const n0 = await count()
  assert.equal((await call(me, 'POST', `/project-offers/${o1.id}/make`, { title: '보기만 하는 템플릿', template: T.viewOnly.slug })).status, 403, '보기 권한')
  assert.equal((await call(me, 'POST', `/project-offers/${o1.id}/make`, { title: '남의 템플릿', template: T.hidden.slug })).status, 403, '구성원이 아님')
  assert.equal(await count(), n0, '거절하면 프로젝트가 생기지 않음')
  assert.equal((await q('select content->>\'state\' s from pro_messages where id=$1', [o1.id]))[0].s, 'offered', '카드는 그대로')
  assert.equal((await call(k, 'POST', `/project-offers/${o1.id}/make`, { title: 'x' })).status, 404, '남의 카드')
  const r = await call(me, 'POST', `/project-offers/${o1.id}/make`, { title: '빈 교육 프로젝트' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.body.project.template, undefined)
  assert.equal((await q('select count(*)::int n from pro_thread_folders where thread_id=$1', [r.body.project.id]))[0].n, 0, '빈 프로젝트는 폴더 없음')
  assert.equal(await count(), n0 + 1)
  const o2 = (await call(me, 'POST', `/messages/${answer.id}/project-offer`)).body.offer
  const no = await call(me, 'POST', `/project-offers/${o2.id}/decline`)
  assert.equal(no.status, 200)
  assert.equal(no.body.offer.content.state, 'declined')
  assert.equal((await call(me, 'POST', `/project-offers/${o2.id}/make`, { title: 'x' })).status, 409, '닫은 카드')
  assert.equal(await count(), n0 + 1)
})

// ---------- AP-U-08 no template ----------
test('AP-U-08 템플릿이 하나도 없으면 판정 모델을 부르지 않고 추천도 없음', { skip: !db && 'no database' }, async () => {
  const { me, answer } = await setup()
  const judges = llm.judges
  const o = await CP.offer(me, { threadId: answer.thread_id, messageId: answer.id }, { templates: async () => [] })
  assert.equal(llm.judges, judges, '판정 없음')
  assert.deepEqual(o.content.templates, [])
  assert.equal(o.content.hasTemplates, false)
  assert.equal(o.content.read.by, 'none')
})
