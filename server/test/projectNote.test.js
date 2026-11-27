// 프로젝트 계획(lib/projectNote.js · 방 판정 lib/roomRules.js · 앞단 계획 lib/turnPlan.js) — DB · 모델 없이. 스펙 openspec/specs/project-room
// 「프로젝트 계획」 · room-rules 「계획에 넣는 말은 규칙을 덮어쓰지 않는다」, 설계 turnplan §4 · P2.
//   PP-U-01 모양: 길이 · 개수 · 종류, 등록되지 않은 ref 는 비움, 등록된 스킬의 이름 · 표시 이름 그대로면 그 스킬
//   PP-U-02 고정한 항목은 모델이 고치거나 빼도 낱말 그대로 제자리에
//   PP-U-03 1,200자를 넘으면 고정하지 않은 가장 오래된 「정한 것」부터 빠지고 고정한 것은 남음
//   PP-U-04 바뀐 것(diff) · 칩의 글 · 되돌리기(undoOn)
//   PP-U-05 사람이 고친 항목은 고정, 그대로 둔 것은 표시를 그대로
//   PP-U-06 방 판정: 보기에 「계획에 넣기」(plan), 상태에 계획의 목적 · 지킬 것과 지금 규칙, plan 은 0.7 에서 따른다
//   PP-U-07 규칙 받아 적기는 계획과 최근 대화를 함께 읽는다(한 문장만이 아니라)
//   PP-U-08 규칙 실행의 할 일에 계획이 붙는다
//   PP-U-09 앞단 계획: 프로젝트 방이면 계획을 배경으로 받고 memory 를 답한다, 아니면 예전 그대로
//   PP-U-10 판단 코드에 사이트 이름 · 낱말 목록이 없고, 질문 · 보기 · 프롬프트는 스킬 파일에 한국어 · 영어로 있다
//   cd server && node --test test/projectNote.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)) })
const body = (req) => new Promise((r) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => r(JSON.parse(raw || '{}'))) })
const reply = (res, v) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }
const judged = []
const judgeCalls = []
const judgeServer = await listen(async (req, res) => { const b = await body(req); judgeCalls.push(b); reply(res, { probabilities: judged.shift() || { other: 1 }, model: 'scripted' }) })
const answers = []
const llmCalls = []
const llmServer = await listen(async (req, res) => { const b = await body(req); llmCalls.push(b); reply(res, { choices: [{ message: { role: 'assistant', content: answers.shift() ?? '{}' }, finish_reason: 'stop' }] }) })
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-plan-skills-'))
fs.mkdirSync(path.join(skillsDir, 'fake-notes'))
fs.writeFileSync(path.join(skillsDir, 'fake-notes', 'SKILL.md'), `---
name: fake-notes
description: 시험용 노트 사이트에서 링크로 요약 카드와 오디오를 만든다.
metadata:
  runs_in: browser
  label: Fake Notes
  start_url: https://notes.example/
---
본문.
`)
process.env.PRO_JUDGE_URL = `http://127.0.0.1:${judgeServer.address().port}/judge`
process.env.PRO_JUDGE_LLM = '0'
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llmServer.address().port}`
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_BROWSER_SKILLS_DIR = skillsDir
const N = await import('../lib/projectNote.js')
const R = await import('../lib/roomRules.js')
const TP = await import('../lib/turnPlan.js')
const { withLang } = await import('../lib/lang.js')
const { pool } = await import('../lib/supa.js')
after(async () => {
  judgeServer.close(); llmServer.close()
  fs.rmSync(skillsDir, { recursive: true, force: true })
  await pool.end().catch(() => {})
})

const long = (c, n) => c.repeat(n)

test('PP-U-01 모양: 길이 · 개수 · 종류 — 등록되지 않은 ref 는 비우고, 등록된 스킬의 이름이나 표시 이름 그대로면 그 스킬', () => {
  const n = N.normalize({
    intent: long('가', 300),
    deliverables: ['슬라이드', '슬라이드', '팟캐스트', 'a', 'b', 'c', 'd'],
    tools: [{ name: 'Fake Notes', kind: 'service', ref: '', how: long('나', 200) }, { name: '외부 서비스', kind: 'browser_skill', ref: 'no-such-skill' }, { name: 'fake-notes' }, { name: '' },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `도구${i}` }))],
    constraints: [long('다', 200)], decisions: 'not a list',
  })
  assert.equal(n.intent.length, 200)
  assert.deepEqual(n.deliverables.map((x) => x.text), ['팟캐스트', 'a', 'b', 'c', 'd'], '같은 항목은 한 번, 5개까지(오래된 것부터 빠짐)')
  assert.equal(n.tools.length, 8)
  assert.equal(N.normalize({ tools: Array.from({ length: 10 }, (_, i) => ({ name: `도구${i}` })) }).tools[0].name, '도구2', '8개를 넘으면 오래된 것부터')
  assert.deepEqual(n.tools[0], { name: 'Fake Notes', kind: 'browser_skill', ref: 'fake-notes', how: long('나', 120) }, '표시 이름 그대로 → 그 스킬, how 120자')
  assert.deepEqual(n.tools[1], { name: '외부 서비스', kind: 'browser_skill', ref: '', how: '' }, '등록되지 않은 ref 는 비움')
  assert.equal(n.tools[2].ref, 'fake-notes')
  assert.equal(n.constraints[0].text.length, 120)
  assert.deepEqual(n.decisions, [])
  assert.equal(N.skillLabel('fake-notes'), 'Fake Notes')
  assert.ok(N.isEmpty(N.normalize(null)))
})

test('PP-U-02 고정한 항목은 모델이 고치거나 빼도 낱말 그대로 제자리에 남는다', () => {
  const prev = N.normalize({ intent: '링크를 노트 사이트 오디오로', intentPinned: true,
    constraints: [{ text: 'A 사이트의 글은 내 계정으로 인쇄해 PDF 로 넣는다', pinned: true }, { text: '오래된 조건' }],
    tools: [{ name: 'Fake Notes', ref: 'fake-notes', how: '서버 브라우저로', pinned: true }] })
  const model = N.normalize({ intent: '다른 목적', constraints: ['A 사이트의 글은 PDF 로 (고쳐 씀)', '새 조건'], tools: [{ name: 'Fake Notes', ref: 'fake-notes', how: '바뀐 쓰임' }, { name: '새 도구' }] })
  const next = N.keepPinned(model, prev)
  assert.equal(next.intent, '링크를 노트 사이트 오디오로')
  assert.equal(next.intentPinned, true)
  assert.deepEqual(next.constraints, [{ text: 'A 사이트의 글은 내 계정으로 인쇄해 PDF 로 넣는다', pinned: true }, { text: 'A 사이트의 글은 PDF 로 (고쳐 씀)' }, { text: '새 조건' }])
  assert.deepEqual(next.tools[0], { name: 'Fake Notes', kind: 'browser_skill', ref: 'fake-notes', how: '서버 브라우저로', pinned: true })
  assert.equal(next.tools[1].name, '새 도구')
  // (the marks the model was shown are not kept as words)
  const echoed = N.keepPinned(N.normalize({ constraints: ['A 사이트의 글은 내 계정으로 인쇄해 PDF 로 넣는다 (고정)'] }), prev)
  assert.equal(echoed.constraints.filter((x) => x.text.startsWith('A 사이트')).length, 1)
  assert.ok(N.noteForModel(prev).includes('(고정)'))
})

test('PP-U-03 1,200자를 넘으면(프롬프트에 넣을 때만) 고정하지 않은 가장 오래된 「정한 것」부터 빠지고 고정한 항목은 남는다', () => {
  const note = N.normalize({ intent: '목적', constraints: Array.from({ length: 6 }, (_, i) => ({ text: `지킬 것 ${i} ${long('라', 100)}`, pinned: i === 0 })),
    decisions: Array.from({ length: 6 }, (_, i) => ({ text: `정한 것 ${i} ${long('마', 100)}`, pinned: i === 0 })) })
  const fitted = N.fit(note, 1200)
  const text = N.noteText(note)
  assert.ok(text.length <= 1200, `${text.length}`)
  assert.ok(text.includes('정한 것 0'), '고정한 정한 것은 남는다')
  assert.ok(text.includes('지킬 것 0'), '고정한 지킬 것은 남는다')
  assert.ok(!text.includes('정한 것 1 '), '가장 오래된 고정 안 한 정한 것이 먼저 빠진다')
  assert.ok(fitted.decisions.length < 6)
  assert.equal(fitted.decisions[0].text.startsWith('정한 것 0'), true)
  // a short note is not cut at all
  assert.equal(N.fit(N.normalize({ intent: '짧음', decisions: ['하나'] })).decisions.length, 1)
  assert.equal(N.noteText(N.emptyNote()), '', '빈 계획은 아무 글도 붙이지 않는다')
})

test('PP-U-04 바뀐 것 · 칩의 글 · 되돌리기', () => {
  const a = N.normalize({ intent: '목적', constraints: ['하나'] })
  const b = N.normalize({ intent: '목적', constraints: ['하나', '둘'], tools: [{ name: 'Fake Notes', ref: 'fake-notes', how: '서버 브라우저로 오디오를 만든다' }] })
  const d = N.diff(a, b)
  assert.ok(N.changed(d))
  assert.deepEqual(d.added.constraints, ['둘'])
  assert.equal(d.added.tools[0].name, 'Fake Notes')
  assert.equal(N.changeText(d), '계획에 넣었어요: 둘 외 1개')
  assert.equal(N.changeText(N.diff(a, N.normalize({ intent: '새 목적', constraints: ['하나'] }))), '계획의 목적을 바꿨어요: 새 목적')
  assert.equal(N.changeText(N.diff(b, a)), '계획에서 뺐어요: 둘 외 1개')
  assert.equal(N.changeText(N.diff(N.normalize({ tools: b.tools }), N.emptyNote())), '계획에서 뺐어요: Fake Notes — 서버 브라우저로 오디오를 만든다')
  assert.equal(withLang('en', () => N.changeText(d)), 'Added to the plan: 둘 and 1 more')
  assert.ok(!N.changed(N.diff(a, N.normalize({ intent: ' 목적 ', constraints: ['하나'] }))))
  // undone on a note that changed since: only what that change did is taken back
  const later = N.normalize({ ...b, decisions: ['나중에 정한 것'] })
  const u = N.undoOn(later, d)
  assert.deepEqual(u.constraints.map((x) => x.text), ['하나'])
  assert.deepEqual(u.tools, [])
  assert.deepEqual(u.decisions.map((x) => x.text), ['나중에 정한 것'])
  const back = N.undoOn(N.normalize({ intent: '새 목적' }), N.diff(N.normalize({ intent: '목적', constraints: ['빠진 것'] }), N.normalize({ intent: '새 목적' })))
  assert.equal(back.intent, '목적')
  assert.deepEqual(back.constraints.map((x) => x.text), ['빠진 것'])
})

test('PP-U-05 사람이 고친 항목은 고정되고, 그대로 둔 항목은 표시가 그대로', () => {
  const prev = N.normalize({ intent: '목적', constraints: ['그대로 둘 것', { text: '이미 고정', pinned: true }], tools: [{ name: 'Fake Notes', ref: 'fake-notes', how: '쓰임' }] })
  const edited = N.markEdited(N.normalize({ intent: '목적', constraints: ['그대로 둘 것', '이미 고정', '사람이 쓴 것'], tools: [{ name: 'Fake Notes', ref: 'fake-notes', how: '바꾼 쓰임' }] }), prev)
  assert.equal(edited.intentPinned, undefined, '목적은 그대로 → 고정 아님')
  assert.deepEqual(edited.constraints, [{ text: '그대로 둘 것' }, { text: '이미 고정', pinned: true }, { text: '사람이 쓴 것', pinned: true }])
  assert.equal(edited.tools[0].pinned, true)
  assert.equal(N.markEdited(N.normalize({ intent: '바꾼 목적' }), prev).intentPinned, true)
})

const RULE = { id: 'm1', said: '…', action: '이 링크나 파일로 노트 사이트 요약 카드를 만든다', skill: 'fake-notes', runs: 0 }
const PLAN = N.normalize({ intent: '링크 · 파일을 노트 사이트의 요약 카드와 오디오로', constraints: ['A 사이트의 글은 내 계정으로 인쇄해 PDF 로 넣는다'], decisions: ['오디오는 한국어'] })

test('PP-U-06 방 판정: 보기에 「계획에 넣기」, 상태에 계획의 목적 · 지킬 것과 지금 규칙 — plan 은 0.7 에서 따른다', async () => {
  assert.deepEqual(R.roomOptions(RULE, { plan: true }).map((o) => o.key), ['set_rule', 'plan', 'run_rule', 'other'])
  assert.deepEqual(R.roomOptions(null, { plan: true, tasks: true }).map((o) => o.key), ['set_rule', 'plan', 'steer', 'other'])
  assert.deepEqual(R.roomOptions(RULE).map((o) => o.key), ['set_rule', 'run_rule', 'other'], '계획 없이 읽으면 예전 보기')
  const labels = Object.fromEntries(R.roomOptions(RULE, { plan: true }).map((o) => [o.key, o.label]))
  assert.match(labels.plan, /계획에 넣기/)
  assert.match(labels.set_rule, /통째로/)
  assert.match(withLang('en', () => R.roomOptions(RULE, { plan: true }).find((o) => o.key === 'plan').label), /into the plan/)
  const s = R.roomState({ rule: RULE, text: '이번 말', plan: PLAN })
  assert.ok(s.includes(PLAN.intent), '계획의 목적')
  assert.ok(s.includes(PLAN.constraints[0].text), '계획의 지킬 것')
  assert.ok(s.includes(RULE.action), '지금 규칙')
  assert.ok(!s.includes('오디오는 한국어'), '정한 것은 판정에 넣지 않는다(목적 · 지킬 것만)')
  assert.match(R.roomState({ rule: null, text: 'x', plan: null }), /아직 계획이 없다/)
  assert.ok(!R.roomState({ rule: null, text: 'x' }).includes('계획'), '계획 없이 읽으면 예전 상태')
  assert.equal(R.roomPick({ plan: 0.7, set_rule: 0.2 }, { rule: RULE, plan: true }), 'plan')
  assert.equal(R.roomPick({ plan: 0.69, set_rule: 0.2 }, { rule: RULE, plan: true }), 'other')
  assert.equal(R.roomPick({ plan: 0.9 }, { rule: RULE }), 'other', '보기에 없던 plan 은 따르지 않는다')
  assert.equal(R.roomPick({ set_rule: 0.8, plan: 0.1 }, { rule: RULE, plan: true, tasks: true }), 'other', '작업 중에는 규칙을 0.85 에서만')

  judged.push({ set_rule: 0.04, plan: 0.91, run_rule: 0.03, other: 0.02 })
  const n = judgeCalls.length
  const r = await R.readRoom({ rule: RULE, text: 'A 사이트의 글은 앞으로 내 계정으로 인쇄해 PDF 로 넣어야 해', plan: PLAN })
  assert.equal(judgeCalls.length, n + 1, '판정은 한 번')
  assert.equal(r.pick, 'plan')
  const call = judgeCalls.at(-1)
  assert.deepEqual(call.options.map((o) => o.key), ['set_rule', 'plan', 'run_rule', 'other'])
  assert.ok(call.state.includes(PLAN.intent) && call.state.includes(RULE.action))
  assert.equal(call.question, R.ROOM_QUESTION())
})

test('PP-U-07 규칙 받아 적기는 계획과 최근 대화를 함께 읽는다 — 앞서 이름을 댄 도구를 이 문장이 빼먹어도', async () => {
  answers.push(JSON.stringify({ action: '이 링크로 노트 사이트에서 요약 카드와 오디오를 만든다', skill: 'fake-notes' }))
  const n = llmCalls.length
  const a = await R.ruleAction({ text: '앞으로 여기 주는 링크는 다 그렇게 해 줘', note: PLAN, recent: ['사람: 노트 사이트로 오디오 만들어 줘', '비서: 서버 브라우저에서 노트 사이트로 만들었어요.'] })
  assert.equal(llmCalls.length, n + 1, '모델 호출은 한 번')
  assert.deepEqual(a, { action: '이 링크로 노트 사이트에서 요약 카드와 오디오를 만든다', skill: 'fake-notes' })
  const sys = llmCalls.at(-1).messages[0].content, user = llmCalls.at(-1).messages[1].content
  assert.match(sys, /그 대화에서 읽는다/)
  assert.ok(user.startsWith('정한 말: 앞으로 여기 주는 링크는 다 그렇게 해 줘'))
  assert.ok(user.includes('[프로젝트 계획]') && user.includes(PLAN.intent))
  assert.ok(user.includes('최근 대화(오래된 것부터)') && user.includes('사람: 노트 사이트로 오디오 만들어 줘'))
  // (one sentence alone: as before — the sentence is the whole message)
  answers.push(JSON.stringify({ action: '이 파일을 요약한다', skill: '' }))
  await R.ruleAction('올리는 파일은 요약해 줘')
  assert.equal(llmCalls.at(-1).messages[1].content, '올리는 파일은 요약해 줘')
})

test('PP-U-08 규칙 실행의 할 일: 규칙의 일 + 준 것 + 첨부 — 계획은 할 일에 섞이지 않는다(배경으로 따로)', () => {
  const plan = N.noteText(PLAN)
  const g = R.roomGoal(RULE.action, 'https://a.example/x', [{ name: '메모.pdf' }])
  assert.deepEqual(g.split('\n'), [RULE.action, '사용자가 이 방에 준 것: https://a.example/x', '첨부 파일: 메모.pdf'])
  assert.ok(!g.includes('[프로젝트 계획]'))
  assert.ok(plan.startsWith('[프로젝트 계획]') && plan.includes('지킬 것:\n- A 사이트의 글은'))
  assert.equal(R.roomGoal(RULE.action, 'https://a.example/y').split('\n').length, 2)
})

test('PP-U-09 앞단 계획: 프로젝트 방은 계획을 배경으로 받고 memory 를 답한다 — 아니면 예전 그대로', () => {
  const plain = TP.frontMessages({ text: 'https://a.example/x' })
  assert.ok(!plain[0].content.includes('memory'), '프로젝트가 아니면 memory 를 묻지 않는다')
  const note = N.noteText(PLAN)
  const m = TP.frontMessages({ text: 'https://a.example/x', project: true, note })
  assert.match(m[0].content, /"memory": true\|false/)
  assert.match(m[0].content, /The project plan, when given, is background/)
  assert.ok(m[1].content.startsWith(note), '계획이 메시지 앞에')
  assert.ok(m[1].content.includes('The message now:\nhttps://a.example/x'))
  assert.equal(TP.readPlan({ understood: '알겠어요', steps: ['a', 'b'], memory: true }).memory, true)
  assert.equal(TP.readPlan({ understood: '알겠어요', steps: ['a', 'b'], memory: 'yes' }).memory, undefined)
})

test('PP-U-10 판단 코드에 사이트 이름 · 낱말 목록이 없고, 질문 · 보기 · 프롬프트는 스킬 파일에 한국어 · 영어로 있다', async () => {
  for (const f of ['../lib/projectNote.js', '../lib/roomRules.js', '../routes/projectNote.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
    const hit = src.match(/notebook|노트북|youtu|유튜브|medium|미디엄|powerpoint|파워포인트/i)
    assert.ok(!hit, `${f}: '${hit?.[0]}'`)
    assert.ok(!src.includes('https?:\\/\\/'), `${f}: 링크를 정규식으로 찾지 않는다`)
  }
  const sk = await N.planSkill()
  assert.equal(sk.name, 'project-plan')
  for (const p of ['update', 'update-en', 'backfill', 'backfill-en', 'add', 'add-en']) assert.ok(sk.prompts[p]?.length > 100, p)
  for (const lang of ['ko', 'en']) {
    for (const k of ['set_rule', 'plan', 'run_rule', 'steer', 'other']) assert.ok(sk.rules.room.options[lang][k], `${lang}.${k}`)
    assert.ok(sk.rules.room.question[lang])
  }
  // (the bundled labels of the options that were in the code before are kept word for word)
  assert.equal(sk.rules.room.options.ko.run_rule, '이 방의 규칙대로 처리하라고 건넨 것이다(규칙의 대상인 링크나 파일)')
  assert.equal(N.promptOf(sk, 'add'), sk.prompts.add)
  assert.equal(withLang('en', () => N.promptOf(sk, 'add')), sk.prompts['add-en'])
})

test('PP-U-11 바뀐 기록의 한 줄: 무엇이(글) · 누가 · 종류 · 보낸 메시지 · 바뀐 항목(되돌리기가 쓰는 것)', () => {
  const d = N.diff(N.normalize({ constraints: ['하나'] }), N.normalize({ constraints: ['하나', '둘'], deliverables: ['MP3'] }))
  const c = N.changeOf(d, { kind: 'add', by: 'person', from: { messageId: '11111111-1111-4111-8111-111111111111', text: '앞으로 둘도 지키자' }, prevId: 'p1' })
  assert.equal(c.kind, 'add')
  assert.equal(c.by, 'person')
  assert.ok(!Number.isNaN(new Date(c.at).getTime()), '언제')
  assert.equal(c.text, '계획에 넣었어요: MP3 외 1개')
  assert.deepEqual(c.from, { messageId: '11111111-1111-4111-8111-111111111111', text: '앞으로 둘도 지키자' })
  assert.deepEqual(c.added, { deliverables: ['MP3'], constraints: ['둘'] })
  assert.equal(c.prevId, 'p1')
  assert.equal(N.changeOf(d, { kind: 'edit', by: 'person' }).text, '직접 고쳤어요: MP3 외 1개')
  assert.equal(N.changeOf(d, { kind: 'edit', by: 'person' }).from, undefined, '직접 고친 것은 보낸 메시지가 없다')
  assert.equal(N.changeOf(N.diff(null, N.normalize({ intent: '목적' })), { kind: 'backfill', by: 'assistant' }).text, '프로젝트 계획을 채웠어요: 목적')
  // what a revert takes back is the change itself: the plan without it, later changes kept
  const later = N.normalize({ constraints: ['하나', '둘', '셋'], deliverables: ['MP3'] })
  assert.deepEqual(N.undoOn(later, c).constraints.map((x) => x.text), ['하나', '셋'])
  assert.deepEqual(N.undoOn(later, c).deliverables, [])
})

test('PP-U-12 (검토 #10) 고정한 항목은 1,200자를 넘어도 프롬프트에서 잘리지 않는다 — 고정하지 않은 것을 먼저 줄이고 뺀다', () => {
  const pinnedOnes = Array.from({ length: 6 }, (_, i) => ({ text: `고정한 정한 것 ${i} ${long('바', 100)}`, pinned: true }))
  const note = N.normalize({ intent: long('목', 180), constraints: pinnedOnes.map((x) => ({ ...x, text: x.text.replace('정한', '지킬') })), decisions: pinnedOnes,
    tools: [{ name: '긴 도구', how: long('쓰', 120) }] })
  const t = N.noteText(note)
  for (const x of [...note.constraints, ...note.decisions]) assert.ok(t.includes(x.text), '고정한 항목은 모두 그대로')
  assert.ok(t.length > 1200, '고정한 것만으로 넘으면 넘긴 채로(잘라 내지 않는다)')
  assert.ok(!t.includes('긴 도구'), '고정하지 않은 도구는 먼저 빠진다')
  assert.ok(!t.endsWith('…') || t.includes('목목'), '끝을 잘라 내지 않는다')
})

test('PP-U-13 (검토 #3 · #10) 모델의 답: 고정 표시는 받지 않고, 빠뜨린 칸은 그대로, 한꺼번에 여럿을 지우는 답은 받지 않는다 · 다른 변경 위에 얹기', () => {
  const a = N.fromModel({ intent: '목적', intentPinned: true, pinned: true, constraints: [{ text: '하나', pinned: true }, '둘'], tools: [{ name: 'X', pinned: true }] })
  assert.equal(a.intentPinned, undefined)
  assert.deepEqual(a.constraints, [{ text: '하나' }, '둘'])
  assert.deepEqual(a.tools, [{ name: 'X' }])
  assert.equal(N.normalize(a).intentPinned, undefined)
  assert.ok(N.normalize(a).constraints.every((x) => !x.pinned), '처음 채우기(앞 계획 없음)에서도 모델은 고정하지 못한다')
  const prev = N.normalize({ intent: '원래 목적', constraints: ['가', '나', '다'], decisions: ['라'] })
  // {intent} only: the lists stay as they were
  const kept = N.normalize(N.keepMissing({ intent: '새 목적' }, prev))
  assert.equal(kept.intent, '새 목적')
  assert.deepEqual(kept.constraints.map((x) => x.text), ['가', '나', '다'])
  assert.deepEqual(kept.decisions.map((x) => x.text), ['라'])
  // three of four items out at once: not taken; one out: taken
  assert.equal(N.dropsTooMuch(prev, N.diff(prev, N.normalize({ intent: '원래 목적', constraints: [] }))), true)
  assert.equal(N.dropsTooMuch(prev, N.diff(prev, N.normalize({ intent: '원래 목적', constraints: ['가', '나'], decisions: ['라'] }))), false)
  // a change put onto a plan that moved on: what it added comes in, what came meanwhile stays
  const d = N.diff(prev, N.normalize({ ...prev, tools: [{ name: 'Fake Notes', ref: 'fake-notes' }] }))
  const meanwhile = N.normalize({ ...prev, decisions: ['라', '사람이 그사이 더한 것'] })
  const on = N.applyOn(meanwhile, d)
  assert.deepEqual(on.decisions.map((x) => x.text), ['라', '사람이 그사이 더한 것'])
  assert.equal(on.tools[0].ref, 'fake-notes')
  assert.equal(N.applyOn(prev, N.diff(prev, N.normalize({ ...prev, intent: '바꾼 목적' })), { pin: true }).intentPinned, true)
})

test('PP-U-14 (검토 #1) 브라우저 작업의 계획은 배경 — 구매를 말하는 계획이어도 할 일(goal)의 구매 판단은 할 일만 본다', async () => {
  const B = await import('../lib/browser.js')
  const goal = '이 링크로 노트 사이트에서 요약 카드를 만든다\n사용자가 이 방에 준 것: https://a.example/x'
  const plan = N.noteText(N.normalize({ intent: '필요한 소모품을 바로 구매하고 정기 구독까지 해 두는 프로젝트', constraints: ['결제까지 해 줘'] }))
  assert.equal(B.asksToBuy(goal), false)
  assert.equal(B.asksToBuy(`${goal}\n\n${plan}`), true, '예전처럼 할 일에 계획을 붙이면 구매로 읽혔다')
  // the background note says it is context only and asks nothing — and it is never what asksToBuy reads
  const bg = B.backgroundNote(plan)
  assert.match(bg, /not part of the goal/)
  assert.ok(bg.includes('필요한 소모품을 바로 구매'))
})

test('PP-U-15 (2차 B · E) 구매 단추는 사람이 시킨 말이 정한다 · 두 항목짜리 계획을 다 지우는 답은 받지 않는다 · 브라우저 배경은 고정 항목을 자르지 않는다', async () => {
  const B = await import('../lib/browser.js')
  const goal = '이 링크의 소모품을 장바구니에 담아 구매한다'
  // the person's words do not ask to buy (a bare link, a rule that said 「정리해 줘」): any purchase control needs approval
  assert.equal(B.purchaseGate({ goal, said: ['https://shop.example/x', '여기 올리는 링크는 다 정리해 줘'] }, '바로 구매'), 'approve')
  assert.equal(B.purchaseGate({ goal, said: [''] }, '구독하기'), 'approve', '파일만 보낸 말도(말이 없음) 구매를 시킨 것이 아니다')
  // the person asked to buy: a buy control is pressed, a payment still asks
  assert.equal(B.purchaseGate({ goal, said: ['이거 사 줘 https://shop.example/x'] }, '바로 구매'), 'ok')
  assert.equal(B.purchaseGate({ goal, said: ['이거 사 줘'] }, '결제하기'), 'approve')
  // what they told it while it ran counts as theirs
  assert.equal(B.purchaseGate({ goal, said: ['https://shop.example/x'], heard: ['이거 구매해 줘'] }, '바로 구매'), 'ok')
  // the goal does not ask to buy: refused whatever was said
  assert.equal(B.purchaseGate({ goal: '이 링크를 요약한다', said: ['사 줘'] }, '바로 구매'), 'refuse')
  // no person's words started it (a schedule, a process step): the goal they set up decides, as before
  assert.equal(B.purchaseGate({ goal }, '바로 구매'), 'ok')
  assert.equal(B.personWords({ goal }), null)
  // a 2-item plan wiped by an answer: not taken
  const small = N.normalize({ intent: '목적', constraints: ['가'], decisions: ['나'] })
  assert.equal(N.dropsTooMuch(small, N.diff(small, N.normalize({ intent: '목적' }))), true)
  assert.equal(N.dropsTooMuch(small, N.diff(small, N.normalize({ intent: '목적', decisions: ['나'] }))), false, '하나를 빼는 것은 받는다')
  // the browser's background keeps every pinned item (they can pass 1,500 characters)
  const pin = (w) => Array.from({ length: 6 }, (_, i) => ({ text: `${w} ${i} ${'가'.repeat(110)}`, pinned: true }))
  const big = N.normalize({ intent: '목적', constraints: pin('지킬 것'), decisions: pin('정한 것') })
  const bg = B.backgroundNote(N.noteText(big))
  assert.ok(N.noteText(big).length > 1500)
  for (const x of [...big.constraints, ...big.decisions]) assert.ok(bg.includes(x.text), '고정 항목은 모두')
})

