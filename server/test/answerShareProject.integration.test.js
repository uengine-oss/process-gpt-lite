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
//   (PR #118 검토) AP-U-01b 나가는 글에서 작업 공간 · 호스트 경로 · 서명된 · 저장소 주소는 이름만(보통 웹 주소는 그대로), 「## 」 머리 그대로, 12,000자 넘으면 잘렸다고 ·
//   AP-U-03b 팀에서 빠진 보낸 사람은 방 목록 · 보내기 403(1:1 을 만들지 않음) · AP-U-04b 「문서로 남기기」 둘이 동시에 → 카드 하나 · AP-U-05b 같은 답의
//   카드는 하나 · AP-U-06b 카드에서 고친 목적 · 만들 것 · 배경이 계획에, 「만들기」 둘이 동시에 → 하나만 · AP-U-07b 멈춘 「만들기」를 이어받기 · 「아니요」,
//   템플릿 작업 공간을 못 만들면 프로젝트도 남지 않음 · AP-U-09 말로: 다른 대화의 더 새 답(예약 실행)이 아니라 이 대화의 답 · 좁혀 본 대화의 답 · 카드는 대답 옆
//   (PR #118 후속 · PR #122 검토) AP-U-01c 줄 가운데 서명 조각은 값만 「…」 · 평범한 key 주소는 그대로 · 덧붙이기 직전에 다시 확인(한 문장) — AP-U-04c 문서 카드 ·
//   AP-U-05c 확인 카드 · AP-U-06c 「프로젝트로 옮겼어요」(대화가 그 사람 것이 아니게 되면 404, 이어받혔으면 그쪽 카드) · AP-U-07d 버리는 프로젝트의 작업 공간도 버림 ·
//   AP-U-04d 확인과 덧붙이기 사이에 대화가 사라지면 404(500 아님) · 답의 글은 행마다 한 번 · AP-U-05d 카드를 쓰는 동안 답이 사라지면 곧바로 404, 모델 한 번
//   (11-28 「다른 앱으로 보내기」 · 「글 복사」) AP-U-11 공유 시트에 넘길 글은 방과 같은 정리의 평문(12,000자에서 「…(이어짐)」), 복사할 글은 정리한 전체 Markdown ·
//   남의 답 404 · 답이 아닌 메시지 400
// Run: node --test --test-concurrency=1 test/answerShareProject.integration.test.js  (needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pgl-answer-project-'))
// (a company of this run's own: the lists — teammates, rooms — hold only what this run made, whatever an earlier run left behind)
const TENANT = `answer-project-test-${crypto.randomBytes(3).toString('hex')}`
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
process.env.PRO_PROJECT_OFFERS_PER_MIN = '200'
// (a 「만들기」 nobody refreshed for 1.5 s may be taken over — AP-U-07c holds one that long)
process.env.PRO_PROJECT_MAKING_STALE_MS = '1500'

const { config } = await import('../config.js')
const { q, pool, admin } = await import('../lib/supa.js')
const CV = await import('../lib/conversations.js')
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

test('AP-U-01b 나가는 글: 작업 공간 · 호스트 경로와 서명된 · 저장소 주소는 이름만, 보통 웹 주소는 그대로 · 「## 」 머리 · 12,000자', () => {
  const host = new URL(config.supabaseUrl).host
  const raw = ['# 결과', '',
    '초안: `/workspace/.bpmn/conv-1/초안.docx`, 원본은 /Users/someone/Downloads/견적.xlsx 에 있어요.',
    '링크: [첨부 보기]( </workspace/.bpmn/conv-1/첨부 1.pdf> ) · [로컬](file:///Users/someone/a.md)',
    `메일 첨부(30분): https://${host}/storage/v1/object/sign/private/pgpt-pro/u/att/abc/견적서.pdf?token=eyJhbGci.x.y`,
    '공유: https://lite.example/api/team/shares/123/raw?sig=abcd&u=x&exp=1',
    '[서명된 파일](https://bucket.s3.amazonaws.com/a/report.pdf?X-Amz-Signature=deadbeef&X-Amz-Credential=c)',
    '<https://cdn.example/storage/v1/object/public/files/pgpt-pro/u/0f8fad5b-d9cb-469f-a165-70867728950e.md>',
    '참고: https://www.example.com/guide?page=2 와 [안내](https://docs.example.org/a)'].join('\n')
  const out = AS.answerText({ kind: 'doc', content: { text: raw } })
  for (const bad of ['/workspace', '/Users/', 'file://', 'token=', 'sig=', 'X-Amz', host, '/storage/v1/', 'eyJhbGci']) assert.ok(!out.includes(bad), `남은 것: ${bad}\n${out}`)
  assert.ok(out.includes('`초안.docx`') && out.includes('견적.xlsx') && out.includes('첨부 보기') && out.includes('로컬'), out)
  assert.ok(out.includes('메일 첨부(30분): 견적서.pdf') && out.includes('서명된 파일') && out.includes('공유: 비공개 주소') && out.includes('비공개 주소'), out)
  assert.ok(out.includes('https://www.example.com/guide?page=2') && out.includes('[안내](https://docs.example.org/a)'), '보통 웹 주소는 그대로')
  // the title, the sheet's preview, the document, the room's text — the same words
  assert.equal(AS.titleOf({ kind: 'text', content: { text: '/workspace/.bpmn/c/보고서.md 를 정리했어요' } }), '보고서.md 를 정리했어요')
  assert.ok(!AS.docBody({ kind: 'doc', content: { text: raw } }).includes('token='))
  assert.ok(!AS.previewOf({ kind: 'doc', content: { text: raw } }).includes('/workspace'))
  assert.ok(!AS.sharedText({ kind: 'doc', content: { text: raw } }).includes('sig='))
  // a document answer that starts with a heading of another level keeps it
  assert.ok(AS.docBody({ kind: 'doc', content: { text: '## 회의록\n\n내용' } }).startsWith('## 회의록\n'))
  assert.ok(AS.docBody({ kind: 'doc', content: { text: '회의록\n\n내용' } }).startsWith('# 회의록\n'))
  // over the limit: cut, and said so
  const long = { kind: 'text', content: { text: '가'.repeat(AS.LIMITS.text + 10) } }
  assert.equal(AS.sharedText(long).length, AS.LIMITS.text)
  assert.equal(AS.truncated(long), true)
  assert.equal(AS.truncated({ kind: 'text', content: { text: '짧은 답' } }), false)
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

test('AP-U-03b 비공개 주소가 든 답 · 잘린 답을 방에 보낸다 — 방 · 알림 · 고르는 화면에 주소 없음, 잘렸다고 · 팀에서 빠진 보낸 사람은 403(1:1 을 만들지 않음)', { skip: !db && 'no database' }, async () => {
  const { me, k, grp, chat } = await setup()
  const host = new URL(config.supabaseUrl).host
  const text = `# /workspace/.bpmn/c/견적비교.md 정리\n\n첨부는 https://${host}/storage/v1/object/sign/private/a/견적서.pdf?token=SECRET 에 있어요.\n${'가'.repeat(AS.LIMITS.text)}`
  const [a] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2) returning *`, [chat.id, { text }])
  const pick = await call(me, 'GET', `/messages/${a.id}/share/rooms`)
  assert.equal(pick.status, 200, pick.text)
  assert.equal(pick.body.answer.title, '견적비교.md 정리')
  assert.ok(pick.body.answer.preview.includes('견적서.pdf') && !pick.body.answer.preview.includes('SECRET'))
  assert.equal(pick.body.answer.truncated, true)
  const r = await call(me, 'POST', `/messages/${a.id}/share/room`, { room: grp })
  assert.equal(r.status, 200, r.text)
  const seen = (await roomMsgs(k, grp)).find((m) => m.id === r.body.message)
  assert.ok(!JSON.stringify(seen).includes('SECRET') && !JSON.stringify(seen).includes('/workspace/'), '방에 주소 없음')
  assert.equal(seen.answer.truncated, true)
  const [row] = await q(`select messages from chats where uuid=$1`, [r.body.message])
  assert.ok(!JSON.stringify(row.messages).includes('SECRET'), '저장된 행에도 없음')
  const notes = await q(`select title, description from notifications where tenant_id=$1 and type='team' and url like $2`, [TENANT, `%${r.body.message}`])
  assert.ok(notes.length && notes.every((n) => !`${n.title} ${n.description}`.includes('/workspace/') && !`${n.title} ${n.description}`.includes('SECRET')))
  // the sender taken off the team: no list, no send — and no conversation of two made for it
  const x = await person('한지우')
  const pairs = async () => (await q(`select count(*)::int n from chat_rooms where tenant_id=$1 and participants @> $2::jsonb and participants @> $3::jsonb`, [TENANT, JSON.stringify([{ id: me.id }]), JSON.stringify([{ id: x.id }])]))[0].n
  await q('delete from pro_team_members where tenant_id=$1 and user_id=$2', [TENANT, me.id])
  try {
    assert.equal((await call(me, 'GET', `/messages/${a.id}/share/rooms`)).status, 403)
    assert.equal((await call(me, 'POST', `/messages/${a.id}/share/room`, { person: x.id })).status, 403)
    assert.equal(await pairs(), 0, '1:1 을 만들지 않음')
  } finally { await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$2) on conflict do nothing`, [TENANT, me.id]) }
})

test('AP-U-04b 「문서로 남기기」 둘이 동시에 → 카드 하나', { skip: !db && 'no database' }, async () => {
  const { me } = await setup()
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','동시에 남기기') returning *`, [me.id])
  const [a] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','doc',$2) returning *`, [t.id, { text: '## 회의록\n\n두 화면에서 동시에 누른 답이에요.' }])
  const [x, y] = await Promise.all([call(me, 'POST', `/messages/${a.id}/share/doc`), call(me, 'POST', `/messages/${a.id}/share/doc`)])
  assert.equal(x.status, 200, x.text); assert.equal(y.status, 200, y.text)
  assert.equal(x.body.message.id, y.body.message.id)
  assert.deepEqual([x.body.existing, y.body.existing].sort(), [false, true])
  assert.equal((await msgs(t.id)).filter((m) => m.kind === 'file').length, 1)
  assert.ok((await (await real(x.body.message.content.url)).text()).startsWith('## 회의록'), '「## 」 머리 그대로')
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
  // AP-U-05b the same answer again (the button twice, the words after the button): the same card — no second card, no second question
  const n = { judges: llm.judges, drafts: llm.drafts.length }
  const again = await call(me, 'POST', `/messages/${answer.id}/project-offer`)
  assert.equal(again.status, 200, again.text)
  assert.equal(again.body.offer.id, offerId)
  assert.deepEqual({ judges: llm.judges, drafts: llm.drafts.length }, n)
  assert.equal((await msgs(chat.id)).filter((m) => m.kind === 'project_offer').length, 1)
})

// ---------- AP-U-06 make, from the template ----------
test('AP-U-06 「만들기」(템플릿): 작업 공간 · 계획 · 첫 문서 · 「프로젝트로 옮겼어요」 · 원래 대화 그대로 · 두 번째 409', { skip: !db && 'no database' }, async () => {
  const { me, chat } = await setup()
  const T = await templates()
  const before = await msgs(chat.id)
  // what the person saw and changed on the card (AP-U-06b): the purpose, one deliverable taken out, the background — two screens press 「만들기」 at once
  const body = { title: '가나정밀 1차 교육', template: T.course.slug, intent: '1차 교육 3일 과정의 교안을 만든다', deliverables: ['일차별 교안', ''], background: '채팅의 조사에서 이어 온 일' }
  const both = await Promise.all([call(me, 'POST', `/project-offers/${offerId}/make`, body), call(me, 'POST', `/project-offers/${offerId}/make`, body)])
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409], both.map((x) => x.text).join(' | '))
  const r = both.find((x) => x.status === 200)
  assert.equal((await q(`select count(*)::int n from pro_threads where user_id=$1 and kind='project' and title=$2`, [me.id, '가나정밀 1차 교육']))[0].n, 1, '프로젝트는 하나')
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
  assert.equal(note.note.intent, '1차 교육 3일 과정의 교안을 만든다', '카드에서 고친 목적')
  assert.deepEqual(note.note.deliverables.map((x) => x.text), ['일차별 교안'], '뺀 것은 들어가지 않음')
  assert.deepEqual(note.note.decisions, [{ text: '채팅의 조사에서 이어 온 일' }, { text: '출처: 받은 메일 「1차 교육 과정 요청드립니다」 · 이준호', pinned: true }])
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
  assert.deepEqual([offer.content.intent, offer.content.deliverables, offer.content.background], ['1차 교육 3일 과정의 교안을 만든다', ['일차별 교안'], '채팅의 조사에서 이어 온 일'], '카드는 확인한 그대로')
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

// ---------- AP-U-07b a 「만들기」 that stopped half way ----------
test('AP-U-07b 멈춘 「만들기」: 오래된 잡음은 이어받고(만든 프로젝트가 있으면 그것), 「아니요」도 되고, 템플릿 작업 공간을 못 만들면 프로젝트도 남지 않음', { skip: !db && 'no database' }, async () => {
  const { me } = await setup()
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','멈춘 만들기') returning *`, [me.id])
  const card = async (extra = {}) => (await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','project_offer',$2) returning *`,
    [t.id, { text: '이 대화로 프로젝트를 시작할까요?', title: '멈춘 카드', intent: '멈춘 일을 이어 간다', deliverables: [], background: '', source: { threadId: t.id }, templates: [], state: 'offered', ...extra }]))[0]
  const old = new Date(Date.now() - CP.MAKING_STALE_MS - 5000).toISOString()
  const count = async (title) => (await q(`select count(*)::int n from pro_threads where user_id=$1 and kind='project' and title=$2`, [me.id, title]))[0].n
  // a fresh claim is someone's: refused
  const busy = await card({ state: 'making', making_at: new Date().toISOString() })
  assert.equal((await call(me, 'POST', `/project-offers/${busy.id}/make`, { title: '지금 만드는 중' })).status, 409)
  assert.equal((await call(me, 'POST', `/project-offers/${busy.id}/decline`)).status, 409)
  // a stale claim with nothing made: taken over
  const stale = await card({ state: 'making', making_at: old })
  const r = await call(me, 'POST', `/project-offers/${stale.id}/make`, { title: '이어받은 프로젝트' })
  assert.equal(r.status, 200, r.text)
  assert.equal(await count('이어받은 프로젝트'), 1)
  // a stale claim that had made its project: that project, not a second one
  const [p0] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','먼저 만든 프로젝트') returning *`, [me.id])
  const half = await card({ state: 'making', making_at: old, project: { id: p0.id, title: '먼저 만든 프로젝트' } })
  const r2 = await call(me, 'POST', `/project-offers/${half.id}/make`, { title: '두 번째가 되면 안 됨' })
  assert.equal(r2.status, 200, r2.text)
  assert.equal(r2.body.project.id, p0.id)
  assert.equal(await count('두 번째가 되면 안 됨'), 0)
  // a stale claim can be closed
  const gone = await card({ state: 'making', making_at: old })
  const no = await call(me, 'POST', `/project-offers/${gone.id}/decline`)
  assert.equal(no.status, 200, no.text)
  assert.equal(no.body.offer.content.state, 'declined')
  // a template whose workspace cannot be made: no project is left behind, the card waits again
  const S = await import('../lib/folders/service.js')
  const TPL = await import('../lib/folders/templates.js')
  const broken = await S.createFolder(me, { name: '깨진 템플릿' })
  await S.upload(broken, me, 'TEMPLATE.md', Buffer.from('---\ndescription: 깨진 템플릿\n---\n'))
  await TPL.setTemplate(await S.folderById(broken.id), me, true)
  await q('update pro_folders set repo_path=$2 where id=$1', [broken.id, path.join(ROOT, 'no-such-repo')])
  const c3 = await card()
  const bad = await call(me, 'POST', `/project-offers/${c3.id}/make`, { title: '남으면 안 되는 프로젝트', template: broken.slug })
  assert.ok(bad.status >= 400, bad.text)
  assert.equal(await count('남으면 안 되는 프로젝트'), 0, '고아 프로젝트 없음')
  assert.equal((await q(`select content->>'state' s from pro_messages where id=$1`, [c3.id]))[0].s, 'offered')
})

// ---------- AP-U-09 by words: this conversation's answer ----------
test('AP-U-09 말로: 다른 대화의 더 새 답(예약 실행)이 아니라 이 대화의 답 · 좁혀 본 대화의 답과 줄만 · 카드는 대답처럼 따로 묶지 않음', { skip: !db && 'no database' }, async () => {
  const { me } = await setup()
  const chatOf = async (title) => (await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat',$2) returning *`, [me.id, title]))[0]
  const put = async (t, role, kind, content, at) => (await q(`insert into pro_messages(thread_id,role,kind,content,created_at) values ($1,$2,$3,$4, now() - make_interval(secs => $5)) returning *`, [t.id, role, kind, content, at]))[0]
  const long = (s) => `${s} ${'자세한 내용이에요. '.repeat(12)}`
  // a scheduled run (filed aside, its own conversation) came after the answer the person was talking about
  const w1 = await chatOf('말로 1')
  await put(w1, 'user', 'text', { text: '가나정밀 교육 요청 정리해 줘' }, 50)
  const a1 = await put(w1, 'agent', 'doc', { text: `# 교육 요청 정리\n\n${long('정리한 교육 요청이에요.')}`, conv: 'conv-w1', context: { conversationId: 'conv-w1', action: 'new', title: '교육 요청' } }, 40)
  await put(w1, 'agent', 'text', { text: long('주간 시장 동향 예약 실행 결과예요.'), conv: 'sched-w1', context: { conversationId: 'sched-w1', action: 'aside' } }, 30)
  const said1 = await put(w1, 'user', 'text', { text: '이 내용으로 프로젝트 하나 만들자' }, 20)
  await put(w1, 'agent', 'text', { text: '아래 카드를 준비했어요.' }, 10)
  const o1 = await CP.offer(me, { threadId: w1.id, said: '이 내용으로 프로젝트 하나 만들자', before: said1.id, via: 'words' }, { templates: async () => [] })
  assert.equal(o1.content.source.answer.messageId, a1.id, '이 대화의 답')
  assert.deepEqual(o1.content.context, { conversationId: 'conv-w1', action: 'aside' }, '카드는 처음부터 그 대화에 따로 묶임(사람이 이어 말해도)')
  assert.ok(!llm.drafts.at(-1).includes('시장 동향'), '예약 실행의 글은 자료가 아님')
  // two conversations: the page narrowed to the older one — its answer and its lines only; not narrowed — the newer one (the chat is in it)
  const w2 = await chatOf('말로 2')
  await put(w2, 'user', 'text', { text: 'A 고객 교육안 써 줘' }, 60)
  const aA = await put(w2, 'agent', 'doc', { text: `# A 교육안\n\n${long('A 고객 교육안이에요.')}`, conv: 'conv-a', context: { conversationId: 'conv-a', action: 'new' } }, 50)
  await put(w2, 'user', 'text', { text: 'B 고객 견적 비교해 줘' }, 40)
  const aB = await put(w2, 'agent', 'text', { text: long('B 고객 견적 비교예요.'), conv: 'conv-b', context: { conversationId: 'conv-b', action: 'new' } }, 30)
  const said2 = await put(w2, 'user', 'text', { text: '이걸로 프로젝트 시작하자' }, 20)
  const narrowed = await CP.offer(me, { threadId: w2.id, before: said2.id, via: 'words', conversationId: 'conv-a' }, { templates: async () => [] })
  assert.equal(narrowed.content.source.answer.messageId, aA.id)
  const lines = llm.drafts.at(-1)
  assert.ok(lines.includes('A 고객 교육안 써 줘') && !lines.includes('B 고객 견적'), '좁혀 본 대화의 줄만')
  await q(`update pro_messages set content = content || '{"state":"declined"}'::jsonb where id=$1`, [narrowed.id])
  const plain = await CP.offer(me, { threadId: w2.id, before: said2.id, via: 'words' }, { templates: async () => [] })
  assert.equal(plain.content.source.answer.messageId, aB.id, '좁히지 않았으면 채팅이 있던 대화(가장 최근 답의 대화)')
  assert.deepEqual(plain.content.context, { conversationId: 'conv-b', action: 'aside' })
  // a 「stay」 answer does not move the chat, a card filed aside does not either (src/convOf.js): still conv-w3's answer
  const w3 = await chatOf('말로 3')
  await put(w3, 'user', 'text', { text: 'C 고객 일정표 만들어 줘' }, 60)
  const a3 = await put(w3, 'agent', 'doc', { text: `# C 일정표\n\n${long('C 고객 일정표예요.')}`, context: { conversationId: 'conv-w3', action: 'new' } }, 50)
  // (a short 「stay」 line — no answer to carry on; read as moving the chat, it would leave conv-w3 with no answer)
  await put(w3, 'agent', 'text', { text: '네, 확인했어요.', context: { conversationId: 'conv-other', action: 'stay' } }, 40)
  await put(w3, 'agent', 'project_offer', { text: '카드', state: 'declined', context: { conversationId: 'conv-other', action: 'aside' } }, 35)
  const said3 = await put(w3, 'user', 'text', { text: '이걸로 프로젝트 만들자' }, 20)
  const o3 = await CP.offer(me, { threadId: w3.id, before: said3.id, via: 'words' }, { templates: async () => [] })
  assert.equal(o3.content.source.answer.messageId, a3.id)
  assert.deepEqual(o3.content.context, { conversationId: 'conv-w3', action: 'aside' })
  // the person goes on talking before 「만들기」: the card stays filed where it is (the page's rule reads it so)
  const after = await q(`select id, role, kind, content, created_at from pro_messages where thread_id=$1 order by created_at, id`, [w3.id])
  await put(w3, 'agent', 'text', { text: long('새 대화의 답이에요.'), context: { conversationId: 'conv-new', action: 'new' } }, 0)
  const all = await q(`select id, role, kind, content, created_at from pro_messages where thread_id=$1 order by created_at, id`, [w3.id])
  assert.equal(CV.convOf(after)[o3.id], 'conv-w3')
  assert.equal(CV.convOf(all)[o3.id], 'conv-w3')
})

// ---------- AP-U-10 many at once: one card, one document, and the server's pool stays free ----------
test('AP-U-10 12개가 동시에 「문서로 남기기」 · 「프로젝트로 시작」 → 문서 하나 · 카드 하나, 그 뒤 데이터베이스가 바로 답함', { skip: !db && 'no database' }, async () => {
  const { me } = await setup()
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','동시에 열두 번') returning *`, [me.id])
  const [a] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','doc',$2) returning *`, [t.id, { text: `# 열두 번 누른 답\n\n${'열두 화면에서 동시에 누른 답이에요. '.repeat(8)}`, context: { conversationId: 'conv-12', action: 'new' } }])
  const drafts = llm.drafts.length
  const docs = Array.from({ length: 12 }, () => call(me, 'POST', `/messages/${a.id}/share/doc`))
  const offers = Array.from({ length: 12 }, () => call(me, 'POST', `/messages/${a.id}/project-offer`))
  const done = await Promise.race([Promise.all([...docs, ...offers]), new Promise((ok) => setTimeout(() => ok(null), 60_000))])
  assert.ok(done, '24개가 모두 끝남(멈춤 없음)')
  const t0 = Date.now()
  await Promise.race([q('select 1'), new Promise((_, no) => setTimeout(() => no(new Error('pool stuck')), 2000))])
  assert.ok(Date.now() - t0 < 2000, 'select 1 이 2초 안에')
  const d = done.slice(0, 12), o = done.slice(12)
  for (const r of [...d, ...o]) assert.equal(r.status, 200, r.text)
  assert.equal(new Set(d.map((r) => r.body.message.id)).size, 1, '문서 카드 하나')
  assert.equal(d.filter((r) => !r.body.existing).length, 1)
  assert.equal(new Set(o.map((r) => r.body.offer.id)).size, 1, '확인 카드 하나')
  assert.equal(llm.drafts.length - drafts, 1, '카드를 쓰는 모델은 한 번')
  const rows = await msgs(t.id)
  assert.equal(rows.filter((m) => m.kind === 'file').length, 1)
  assert.equal(rows.filter((m) => m.kind === 'project_offer').length, 1)
})

// ---------- AP-U-07c a slow 「만들기」 and its takeover ----------
test('AP-U-07c 느린 「만들기」와 그 사이 이어받기 → 프로젝트는 하나(만든 뒤 가리키기 전에 멈춤 · 가리킨 뒤에 멈춤), 남은 단계는 한 번씩', { skip: !db && 'no database' }, async () => {
  const { me } = await setup()
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','느린 만들기') returning *`, [me.id])
  const card = async () => (await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','project_offer',$2) returning *`,
    [t.id, { text: '이 대화로 프로젝트를 시작할까요?', title: '느린 카드', intent: '느린 일을 이어 간다', deliverables: ['결과'], background: '', source: { threadId: t.id }, templates: [], state: 'offered' }]))[0]
  const count = async (title) => (await q(`select count(*)::int n from pro_threads where user_id=$1 and kind='project' and title=$2`, [me.id, title]))[0].n
  const gate = () => { let open; const p = new Promise((ok) => { open = ok }); return { p, open } }
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))
  for (const at of ['created', 'finish']) {
    const c = await card()
    const g = gate()
    const title = `느린 프로젝트 ${at}`
    const slow = CP.make(me, c.id, { title }, { hold: async (step) => { if (step === at) await g.p } }).then((r) => ({ ok: r }), (e) => ({ err: e }))
    await wait(CP.MAKING_STALE_MS + 600)
    const takeover = await CP.make(me, c.id, { title })
    g.open()
    const first = await slow
    assert.equal(first.err?.code, 'taken', `${at}: 먼저 누른 쪽은 이어받혔다고`)
    assert.equal(await count(title), 1, `${at}: 프로젝트는 하나`)
    const pid = takeover.project.id
    const inP = await msgs(pid)
    assert.equal(inP.filter((m) => m.kind === 'chip' && m.content.fromChat).length, 1, `${at}: 원래 대화 칩 하나`)
    assert.equal(inP.filter((m) => m.kind === 'chip' && m.content.planChange?.backfill).length, 1, `${at}: 계획 칩 하나`)
    assert.equal((await q(`select count(*)::int n from pro_messages where thread_id=$1 and kind='chip' and content->'project'->>'id' = $2`, [t.id, pid]))[0].n, 1, `${at}: 옮겼어요 한 줄`)
    const [now] = await q('select content from pro_messages where id=$1', [c.id])
    assert.equal(now.content.state, 'made')
    assert.equal(now.content.project.id, pid)
  }
})


// ---------- PR #118 후속 ----------
test('AP-U-01c 나가는 글: 줄 가운데 서명 조각은 값만 「…」(코드 · 예시는 그대로), 지도 · 검색 · 문서의 평범한 key 주소는 그대로', () => {
  // (values built when the test runs — nothing in this public file reads as a real key)
  const rep = (seed, n) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n)
  const jwt = ['ey' + 'J' + rep('hbGci0iJ', 18), 'ey' + 'J' + rep('zdW1i0iI', 22), rep('Sf1KxwRJ', 32)].join('.')
  const hex = rep('9f86d081', 32), gkey = 'AI' + 'za' + rep('Sy9-k2Lm', 33)
  const raw = ['# 링크 안내', '',
    `주소가 길어 나눠 적어요: https://files.example/a/견적서.pdf ?token=${jwt}`,
    `서명은 &sig=${hex}&exp=1767225600 을 뒤에 붙여요.`,
    `\`?X-Amz-Signature=${hex}&X-Amz-Credential=${rep('AKQ7', 20)}\` 은 30분 뒤 만료돼요.`,
    '예시: `GET /api/raw?path=a.md&token=YOUR_TOKEN`',
    '지도: https://maps.example/embed?key=seoul-office&zoom=3 · 문서: [안내](https://docs.example.org/view?key=intro)',
    '검색: https://search.example/?key=교육과정',
    `API: https://maps.example/api/js?key=${gkey}`].join('\n')
  const msg = { kind: 'doc', content: { text: raw } }
  for (const out of [AS.answerText(msg), AS.docBody(msg), AS.sharedText(msg), AS.previewOf(msg, 2000)]) {
    for (const bad of [jwt.slice(0, 12), hex.slice(0, 12), gkey.slice(0, 12), 'AKQ7AKQ7']) assert.ok(!out.includes(bad), `남은 것: ${bad}\n${out}`)
  }
  const out = AS.answerText(msg)
  assert.ok(out.includes('주소가 길어 나눠 적어요: 견적서.pdf') && out.includes('서명은 &sig=…&exp=1767225600 을') && out.includes('`?X-Amz-Signature=…&X-Amz-Credential=…` 은 30분'), out)
  assert.ok(out.includes('`GET /api/raw?path=a.md&token=YOUR_TOKEN`'), '자리만 말한 예시는 그대로')
  assert.ok(out.includes('https://maps.example/embed?key=seoul-office&zoom=3') && out.includes('[안내](https://docs.example.org/view?key=intro)') && out.includes('https://search.example/?key=교육과정'), '평범한 key 는 그대로')
  assert.ok(out.includes('API: 비공개 주소'), out)
})

// 대화에 메시지를 덧붙이기 직전에 다시 확인(한 문장): 그 대화가 여전히 그 사람 것이고, 아직 이 요청이 처리 중인지
const myChat = async (u, title) => (await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat',$2) returning *`, [u.id, title]))[0]
const myAnswer = async (t, text, extra = {}) => (await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','doc',$2) returning *`, [t.id, { text, ...extra }]))[0]
const settle = (p) => p.then((ok) => ({ ok }), (err) => ({ err }))

test('AP-U-04c 「문서로 남기기」: 올리는 동안 대화가 그 사람 것이 아니게 되면 카드 없이 404, 다른 요청이 이어받았으면 두 번째 카드 없이 그쪽 카드', { skip: !db && 'no database' }, async () => {
  const { me, k } = await setup()
  // (1) the conversation is no longer mine while the file goes up
  const t1 = await myChat(me, '올리는 동안 넘어간 대화')
  const a1 = await myAnswer(t1, `# 넘어간 답\n\n${'올리는 동안 대화가 넘어갔어요. '.repeat(6)}`)
  const r1 = await settle(AS.saveDoc(me, a1.id, { publish: async (uid, name) => {
    await q('update pro_threads set user_id=$2 where id=$1', [t1.id, k.id])
    return { name, url: 'https://files.example/u/넘어간 답.md' }
  } }))
  assert.equal(r1.err?.status, 404, r1.err?.message || 'ok')
  assert.equal((await msgs(t1.id)).filter((m) => m.kind === 'file').length, 0, '카드를 덧붙이지 않음')
  assert.equal((await q(`select content ? 'answerDoc' as has from pro_messages where id=$1`, [a1.id]))[0].has, false, '잡은 것을 놓음')
  // (2) another request took the claim over while the file went up (the first one's went stale): no second card — the other's
  const t2 = await myChat(me, '올리는 동안 이어받힌 답')
  const a2 = await myAnswer(t2, `# 이어받힌 답\n\n${'올리는 동안 다른 요청이 이어받았어요. '.repeat(6)}`)
  let theirs = null
  const r2 = await AS.saveDoc(me, a2.id, { publish: async (uid, name) => {
    await q(`update pro_messages set content = jsonb_set(content, '{answerDoc}', jsonb_build_object('pending', 'other', 'at', now())) where id=$1`, [a2.id])
    setTimeout(async () => {
      ;[theirs] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2) returning *`, [t2.id, { name: '이어받힌 답.md', url: 'https://files.example/u/other.md', fromAnswer: a2.id }])
      await q(`update pro_messages set content = jsonb_set(content, '{answerDoc}', $2::jsonb) where id=$1`, [a2.id, JSON.stringify({ messageId: theirs.id, name: '이어받힌 답.md', at: new Date().toISOString() })])
    }, 300)
    return { name, url: 'https://files.example/u/mine.md' }
  } })
  assert.equal(r2.existing, true)
  assert.equal(r2.message.id, theirs.id)
  assert.equal((await msgs(t2.id)).filter((m) => m.kind === 'file').length, 1, '카드 하나(이어받은 쪽)')
})

test('AP-U-05c 「프로젝트로 시작」 카드: 모델이 카드를 쓰는 동안 대화가 그 사람 것이 아니게 되면 카드 없이 404, 다른 요청이 이어받았으면 그쪽 카드', { skip: !db && 'no database' }, async () => {
  const { me, k } = await setup()
  const offers = async (t) => (await msgs(t.id)).filter((m) => m.kind === 'project_offer')
  // (1) a button on an answer: the conversation goes to someone else while the model writes the card
  const t1 = await myChat(me, '카드를 쓰는 동안 넘어간 대화')
  const a1 = await myAnswer(t1, `# 넘어간 교육안\n\n${'카드를 쓰는 동안 대화가 넘어갔어요. '.repeat(6)}`)
  const r1 = await settle(CP.offer(me, { threadId: t1.id, messageId: a1.id }, { templates: async () => [], call: async () => {
    await q('update pro_threads set user_id=$2 where id=$1', [t1.id, k.id])
    return { title: '넘어간 프로젝트' }
  } }))
  assert.equal(r1.err?.status, 404, r1.err?.message || 'ok')
  assert.equal((await offers(t1)).length, 0, '카드를 덧붙이지 않음')
  assert.equal((await q(`select content ? 'offering' as has from pro_messages where id=$1`, [a1.id]))[0].has, false, '잡은 것을 놓음')
  // (2) by words, with no answer to carry on: the conversation goes meanwhile — no card either
  const t2 = await myChat(me, '말로 · 답 없음')
  const said = (await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'user','text',$2) returning *`, [t2.id, { text: '프로젝트 하나 만들자' }]))[0]
  const r2 = await settle(CP.offer(me, { threadId: t2.id, before: said.id, via: 'words', said: '프로젝트 하나 만들자' }, { templates: async () => [], call: async () => {
    await q('update pro_threads set user_id=$2 where id=$1', [t2.id, k.id])
    return { title: '답 없는 프로젝트' }
  } }))
  assert.equal(r2.err?.status, 404, r2.err?.message || 'ok')
  assert.equal((await offers(t2)).length, 0)
  // (3) another request took the answer's claim over while the model wrote (the first one's went stale): no second card — the other's
  const t3 = await myChat(me, '카드를 쓰는 동안 이어받힌 답')
  const a3 = await myAnswer(t3, `# 이어받힌 교육안\n\n${'카드를 쓰는 동안 다른 요청이 이어받았어요. '.repeat(6)}`)
  let theirs = null
  const r3 = await CP.offer(me, { threadId: t3.id, messageId: a3.id }, { templates: async () => [], call: async () => {
    await q(`update pro_messages set content = jsonb_set(content, '{offering}', jsonb_build_object('token', 'other', 'at', now())) where id=$1`, [a3.id])
    setTimeout(async () => {
      ;[theirs] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','project_offer',$2) returning *`,
        [t3.id, { text: '이 대화로 프로젝트를 시작할까요?', title: '이어받은 카드', state: 'offered', source: { threadId: t3.id, answer: { messageId: a3.id, title: '이어받힌 교육안' } }, templates: [] }])
      await q(`update pro_messages set content = jsonb_set(content, '{offering,offerId}', to_jsonb($2::text)) where id=$1`, [a3.id, theirs.id])
    }, 300)
    return { title: '내가 쓴 카드' }
  } })
  assert.equal(r3.id, theirs.id)
  assert.equal((await offers(t3)).length, 1, '카드 하나(이어받은 쪽)')
})

test('AP-U-06c 「만들기」: 마치기 전에 카드의 대화가 그 사람 것이 아니게 되면 404, 그 대화에 「프로젝트로 옮겼어요」를 덧붙이지 않고 카드도 「만들었어요」가 되지 않음', { skip: !db && 'no database' }, async () => {
  const { me, k } = await setup()
  const t = await myChat(me, '만드는 동안 넘어간 대화')
  const [c] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','project_offer',$2) returning *`,
    [t.id, { text: '이 대화로 프로젝트를 시작할까요?', title: '넘어간 카드', intent: '넘어간 일', deliverables: [], background: '', source: { threadId: t.id }, templates: [], state: 'offered' }])
  const r = await settle(CP.make(me, c.id, { title: '넘어간 카드의 프로젝트' }, { hold: async (step) => { if (step === 'finish') await q('update pro_threads set user_id=$2 where id=$1', [t.id, k.id]) } }))
  assert.equal(r.err?.status, 404, r.err?.message || 'ok')
  assert.equal(r.err?.code, 'gone')
  const rows = await msgs(t.id)
  assert.equal(rows.filter((m) => m.kind === 'chip' && m.content.project).length, 0, '「프로젝트로 옮겼어요」 없음')
  assert.notEqual(rows.find((m) => m.id === c.id).content.state, 'made')
})

test('AP-U-07d 경쟁에 져서 버리는 프로젝트는 그 프로젝트를 위해 만든 템플릿 작업 공간도 함께 버린다', { skip: !db && 'no database' }, async () => {
  const { me } = await setup()
  const T = await templates()
  const t = await myChat(me, '느린 템플릿 만들기')
  const [c] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','project_offer',$2) returning *`,
    [t.id, { text: '이 대화로 프로젝트를 시작할까요?', title: '느린 템플릿 카드', intent: '템플릿으로 이어 간다', deliverables: [], background: '', source: { threadId: t.id }, templates: [], state: 'offered' }])
  const title = '느린 템플릿 프로젝트'
  let open
  const gate = new Promise((ok) => { open = ok })
  const slow = settle(CP.make(me, c.id, { title, template: T.course.slug }, { hold: async (step) => { if (step === 'created') await gate } }))
  await new Promise((ok) => setTimeout(ok, CP.MAKING_STALE_MS + 600))
  const takeover = await CP.make(me, c.id, { title, template: T.course.slug })
  open()
  const first = await slow
  assert.equal(first.err?.code, 'taken')
  assert.equal((await q(`select count(*)::int n from pro_threads where user_id=$1 and kind='project' and title=$2`, [me.id, title]))[0].n, 1, '프로젝트는 하나')
  // the two workspaces made under this name: the taker's is live, the dropped project's is discarded with it
  const ws = await q(`select source->>'thread_id' as tid, status from pro_folder_variations where folder_id=$1 and title=$2 and source ? 'template'`, [T.course.id, title])
  assert.equal(ws.length, 2, JSON.stringify(ws))
  assert.deepEqual(ws.filter((v) => v.status !== 'discarded').map((v) => v.tid), [String(takeover.project.id)], '남은 작업 공간은 이어받은 프로젝트의 것')
  assert.equal(ws.filter((v) => v.status === 'discarded').length, 1, '버린 프로젝트의 작업 공간도 버림')
})

// ---------- PR #122 review ----------
test('AP-U-04d 대화가 다시 확인한 뒤 · 덧붙이기 전에 사라지면(데이터베이스가 거절) 500 이 아니라 404 · 답의 글은 한 번만 다듬음', { skip: !db && 'no database' }, async () => {
  const { me } = await setup()
  const gone = await settle(AS.addInto(me.id, crypto.randomUUID(), 'agent', 'file', { name: 'x.md' }))
  assert.equal(gone.err?.status, 404, gone.err?.message || 'ok')
  assert.equal(gone.err?.code, 'gone')
  // the picker asks the answer's title, words, preview and length: its text is cleaned once per row (the same object)
  const msg = { kind: 'doc', content: { text: `# 한 번\n\n${'?a=1 '.repeat(2000)}` } }
  const first = AS.answerText(msg)
  assert.equal(AS.answerText(msg), first)
  assert.ok(AS.cleanedOnce(msg), '같은 행은 한 번')
  msg.content.text = '# 바뀐 글'
  assert.equal(AS.answerText(msg), '# 바뀐 글', '글이 바뀌면 다시')
})

test('AP-U-05d 「프로젝트로 시작」: 모델이 카드를 쓰는 동안 답이 사라지면 곧바로 404(세 번 돌고 409 가 아님), 모델은 한 번', { skip: !db && 'no database' }, async () => {
  const { me } = await setup()
  const t = await myChat(me, '카드를 쓰는 동안 사라진 답')
  const a = await myAnswer(t, `# 사라진 답\n\n${'카드를 쓰는 동안 답이 지워졌어요. '.repeat(6)}`)
  let calls = 0
  const t0 = Date.now()
  const r = await settle(CP.offer(me, { threadId: t.id, messageId: a.id }, { templates: async () => [], call: async () => {
    calls++
    await q('delete from pro_messages where id=$1', [a.id])
    return { title: '사라진 답의 프로젝트' }
  } }))
  assert.equal(r.err?.status, 404, r.err?.message || 'ok')
  assert.equal(calls, 1, '모델은 한 번')
  assert.ok(Date.now() - t0 < 10_000, `기다리지 않음: ${Date.now() - t0} ms`)
  assert.equal((await msgs(t.id)).filter((m) => m.kind === 'project_offer').length, 0)
})

// ---------- AP-U-11 to another app · the clipboard (「다른 앱으로 보내기」 — the phone's share sheet, 「글 복사」, 2026-11-28) ----------
test('AP-U-11 다른 앱으로 보낼 글 · 복사할 글: 방과 같은 정리(경로 · 비공개 주소 없음) · 보낼 글은 평문 · 12,000자에서 「…(이어짐)」 · 복사는 전체 Markdown · 남의 답 404 · 답이 아닌 메시지 400', { skip: !db && 'no database' }, async () => {
  const { me, chat, answer, question, kAnswer } = await setup()
  // (pure: Markdown's marks off — a link keeps its address only when the cleaning left one; a cut one says so at its end, in the request's language)
  const { withLang } = await import('../lib/lang.js')
  const md = { kind: 'text', content: { text: ['# 결과 요약', '', '**납기**: 2주 이내 · `견적서.xlsx` 참고', '- 첫째 항목', '1. 번호 항목',
    '[견적 안내](https://www.example.com/quote) · [서명된 견적](https://bucket.s3.amazonaws.com/a/q.pdf?X-Amz-Signature=deadbeef&X-Amz-Credential=c)',
    '', '| 품목 | 수량 |', '|---|---|', '| 센서 키트 | 3 |'].join('\n') } }
  const plain = AS.outText(md)
  for (const mark of ['# ', '**', '`', '|', '](', 'X-Amz', 'bucket.s3']) assert.ok(!plain.includes(mark), `${mark} left in:\n${plain}`)
  for (const kept of ['결과 요약\n', '납기: 2주 이내 · 견적서.xlsx 참고', '• 첫째 항목', '1. 번호 항목', '견적 안내 (https://www.example.com/quote) · 서명된 견적\n', '품목 · 수량\n센서 키트 · 3']) {
    assert.ok(plain.includes(kept), `missing 「${kept}」:\n${plain}`)
  }
  const long = { kind: 'text', content: { text: `# 결과\n\n${'가'.repeat(AS.LIMITS.text)}\n끝 문장` } }
  assert.equal(AS.outText(long), `결과\n\n${'가'.repeat(AS.LIMITS.text - '# 결과\n\n'.length)}\n\n…(이어짐)`)
  assert.ok(!AS.outText(long).includes('끝 문장'))
  assert.ok(withLang('en', () => AS.outText(long)).endsWith('\n\n…(continued)'))
  assert.equal(AS.outText({ kind: 'text', content: { text: '짧은 답이에요.' } }), '짧은 답이에요.')
  // (a run of 「[a](」 with no 「)」 — the plain-text reading once froze on it: the room's 12,000 characters at once)
  for (const unit of ['[a](', '![a](', '**a ', '[']) {
    const bad = { kind: 'text', content: { text: unit.repeat(Math.ceil(AS.LIMITS.text / unit.length)) } }
    const t0 = performance.now()
    AS.outText(bad)
    assert.ok(performance.now() - t0 < 200, `${unit}: ${Math.round(performance.now() - t0)} ms`)
  }
  // the document answer: its title, the whole cleaned answer to copy (Markdown), the plain words to send — the workspace link only its label
  const r = await call(me, 'GET', `/messages/${answer.id}/share/text`)
  assert.equal(r.status, 200, r.text)
  const [row] = await q('select * from pro_messages where id=$1', [answer.id])
  assert.deepEqual(r.body, { title: '데이터 분석 실무 교육안', text: AS.answerText(row), plain: AS.outText(row), truncated: false, limit: AS.LIMITS.text })
  assert.ok(r.body.text.startsWith('# 데이터 분석 실무 교육안') && r.body.text.includes('**1일차**'), '복사할 글은 Markdown 그대로')
  assert.ok(r.body.plain.startsWith('데이터 분석 실무 교육안\n') && r.body.plain.includes('1. 1일차 — 스프레드시트 기초') && !r.body.plain.includes('**'), r.body.plain)
  for (const t of [r.body.text, r.body.plain]) assert.ok(!t.includes('/workspace/') && t.includes('초안 파일: 교육안.md'), t)
  // a long answer with a path and a signed address: the same cleaning as the room in both; the plain words cut, said so at their end — the copy whole
  const host = new URL(config.supabaseUrl).host
  const text = `# /workspace/.bpmn/c/견적비교.md 정리\n\n원본: /Users/someone/Downloads/요청서.pdf\n첨부는 https://${host}/storage/v1/object/sign/private/a/견적서.pdf?token=SECRET 에 있어요.\n${'나'.repeat(AS.LIMITS.text)}\n마지막 줄`
  const [a] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','text',$2) returning *`, [chat.id, { text }])
  const o = await call(me, 'GET', `/messages/${a.id}/share/text`)
  assert.equal(o.status, 200, o.text)
  assert.equal(o.body.title, '견적비교.md 정리')
  for (const t of [o.body.text, o.body.plain]) {
    for (const bad of ['SECRET', 'token=', '/workspace/', '/Users/', '/storage/v1/', host]) assert.ok(!t.includes(bad), `남은 것: ${bad}`)
    assert.ok(t.includes('원본: 요청서.pdf') && t.includes('첨부는 견적서.pdf 에 있어요.'), t.slice(0, 200))
  }
  assert.equal(o.body.truncated, true)
  assert.ok(o.body.plain.endsWith('\n\n…(이어짐)') && !o.body.plain.includes('마지막 줄'))
  assert.equal(o.body.plain, `${(await import('../lib/telegram.js')).toPlain(AS.sharedText(a))}\n\n…(이어짐)`, '방에 가는 글의 평문 + 이어짐 표시')
  assert.ok(o.body.text.endsWith('마지막 줄') && o.body.text.length > AS.LIMITS.text, '복사할 글은 자르지 않음')
  // only one's own answer in words
  assert.equal((await call(me, 'GET', `/messages/${kAnswer.id}/share/text`)).status, 404, '남의 답')
  assert.equal((await call(me, 'GET', `/messages/${question.id}/share/text`)).status, 400, '내 말은 답이 아님')
  assert.equal((await call(me, 'GET', '/messages/not-an-id/share/text')).status, 404)
  // (nothing goes to a teammate from here — the person's own phone or clipboard takes it: their own answer, whether or not still on the team)
  await q('delete from pro_team_members where tenant_id=$1 and user_id=$2', [TENANT, me.id])
  try {
    assert.equal((await call(me, 'GET', `/messages/${answer.id}/share/text`)).status, 200)
  } finally { await q(`insert into pro_team_members(tenant_id,user_id,added_by) values ($1,$2,$2) on conflict do nothing`, [TENANT, me.id]) }
})
