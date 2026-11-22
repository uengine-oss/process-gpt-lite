// 방 판정과 규칙 받아 적기(lib/roomRules.js), 대신하기 판단(lib/turns.js) — DB·모델 없이. spec pgpt-pro_room-rules
//   · 판정은 가짜 판정 서버(PRO_JUDGE_URL — 확률 JSON 을 돌려주는 작은 HTTP 서버), 받아 적기는 가짜 모델 서버
//   · 브라우저 스킬은 시험용 폴더의 가짜 스킬(PRO_BROWSER_SKILLS_DIR): 이름·설명만 모델에게 보이고 본문은 안 보인다
// 말의 뜻을 코드가 맞히지 않는다(2026-11-21): 여기 사례는 확률 → 결정, 보기, 구조적 정책만 다룬다.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)) })
const body = (req) => new Promise((r) => { let raw = ''; req.on('data', (c) => { raw += c }); req.on('end', () => r(JSON.parse(raw || '{}'))) })
const reply = (res, v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }

// ---- a judge server that answers what the test scripted ----
const judged = [] // probabilities, in order (default: other)
const judgeCalls = []
let judgeDown = false
const judgeServer = await listen(async (req, res) => {
  const b = await body(req)
  judgeCalls.push(b)
  if (judgeDown) return reply(res, { error: 'down' }, 503)
  reply(res, { probabilities: judged.shift() || { other: 1 }, model: 'scripted' })
})
// ---- a model that answers the rule's write-down ----
const answers = [] // message contents, in order
const llmCalls = []
const llmServer = await listen(async (req, res) => {
  const b = await body(req)
  llmCalls.push(b)
  reply(res, { choices: [{ message: { role: 'assistant', content: answers.shift() ?? '{}' }, finish_reason: 'stop' }] })
})
// ---- a browser skill of its own (no real site) ----
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-rules-skills-'))
fs.mkdirSync(path.join(skillsDir, 'fake-notes'))
fs.writeFileSync(path.join(skillsDir, 'fake-notes', 'SKILL.md'), `---
name: fake-notes
description: 시험용 노트 사이트에서 링크로 요약 카드를 만든다.
metadata:
  runs_in: browser
  start_url: https://notes.example/
---
BODY-ONLY-WHEN-USED: 이 줄은 작업이 스킬을 쓸 때만 읽힌다.
`)

process.env.PRO_JUDGE_URL = `http://127.0.0.1:${judgeServer.address().port}/judge`
process.env.PRO_JUDGE_LLM = '0'
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llmServer.address().port}`
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_BROWSER_SKILLS_DIR = skillsDir
const R = await import('../lib/roomRules.js')
const T = await import('../lib/turns.js')
const { pool } = await import('../lib/supa.js')

after(async () => {
  judgeServer.close(); llmServer.close()
  fs.rmSync(skillsDir, { recursive: true, force: true })
  await pool.end().catch(() => {})
})

const RULE = { id: 'm1', said: '…', action: '이 링크나 파일로 요약 카드를 만든다', skill: 'fake-notes', runs: 0 }
const CASES = JSON.parse(fs.readFileSync(new URL('./room-rules-cases.json', import.meta.url)))
const RUN = {
  pick: (c) => R.roomPick(c.probabilities, { rule: c.rule ? RULE : null }),
  options: (c) => R.roomOptions(c.rule ? RULE : null).map((o) => o.key),
  replace: (c) => T.replaceRule({ room: c.room, ahead: Array.from({ length: c.ahead }, () => ({})) }),
}
for (const c of CASES) test(c.name, () => assert.deepEqual(RUN[c.kind](c), c.expect))

test('판정이 보는 상태: 방의 규칙(있으면 할 일), 메시지 원문 그대로, 첨부 파일이 있는가', () => {
  const text = '이것도 https://a.example/x?si=1 부탁해요'
  const s1 = R.roomState({ rule: RULE, text, files: [{ name: '보고서.pdf' }] })
  assert.ok(s1.includes(RULE.action))
  assert.ok(s1.includes(text), '원문이 그대로(링크를 뽑아내지 않는다)')
  assert.match(s1, /첨부한 파일: 1개 \(보고서\.pdf\)/)
  const s2 = R.roomState({ rule: null, text: '안녕하세요' })
  assert.match(s2, /아직 규칙이 없다/)
  assert.match(s2, /첨부한 파일: 없음/)
})

test('규칙을 실행할 때의 할 일: 규칙의 일 + 사람이 준 메시지 원문 + 첨부 파일 이름', () => {
  const g = R.roomGoal(RULE.action, 'https://a.example/x 이것도요', [{ name: '보고서.pdf' }, { name: '표.xlsx' }])
  const lines = g.split('\n')
  assert.equal(lines[0], RULE.action)
  assert.equal(lines[1], '사용자가 이 방에 준 것: https://a.example/x 이것도요')
  assert.equal(lines[2], '첨부 파일: 보고서.pdf, 표.xlsx')
  assert.equal(R.roomGoal(RULE.action, 'https://a.example/y').split('\n').length, 2)
})

test('방 판정은 판정 서버에 한 번 묻고, 규칙이 없으면 run_rule 은 보기에 없다', async () => {
  judged.push({ set_rule: 0.91, other: 0.09 })
  const n = judgeCalls.length
  const r = await R.readRoom({ text: '여기 올리는 건 앞으로 다 요약 카드로', files: [] })
  assert.equal(judgeCalls.length, n + 1)
  assert.equal(r.pick, 'set_rule')
  assert.equal(r.via, 'server')
  assert.ok(Number.isFinite(r.ms))
  const call = judgeCalls.at(-1)
  assert.deepEqual(call.options.map((o) => o.key), ['set_rule', 'other'])
  assert.ok(call.state.includes('여기 올리는 건 앞으로 다 요약 카드로'))
  assert.equal(call.question, R.ROOM_QUESTION())

  judged.push({ set_rule: 0.05, run_rule: 0.9, other: 0.05 })
  const r2 = await R.readRoom({ rule: RULE, text: 'https://a.example/z', files: [{ name: 'a.pdf' }] })
  assert.equal(r2.pick, 'run_rule')
  assert.deepEqual(judgeCalls.at(-1).options.map((o) => o.key), ['set_rule', 'run_rule', 'other'])
  assert.ok(judgeCalls.at(-1).state.includes(RULE.action))
})

test('받아 적기: 한 번의 모델 호출로 {action, skill} — 스킬 목록은 이름·설명만, 본문은 보이지 않는다', async () => {
  answers.push(JSON.stringify({ action: '이 링크로 시험용 노트 사이트에서 요약 카드를 만든다', skill: 'fake-notes' }))
  const n = llmCalls.length
  const a = await R.ruleAction('여기에 주는 링크는 노트 사이트에서 요약 카드로 만들어 줘')
  assert.equal(llmCalls.length, n + 1, '모델 호출은 한 번')
  assert.deepEqual(a, { action: '이 링크로 시험용 노트 사이트에서 요약 카드를 만든다', skill: 'fake-notes' })
  const sys = llmCalls.at(-1).messages[0].content
  assert.match(sys, /- fake-notes: 시험용 노트 사이트에서 링크로 요약 카드를 만든다\./)
  assert.ok(!sys.includes('BODY-ONLY-WHEN-USED'), '스킬 본문은 받아 적기에 보이지 않는다')
  assert.equal(llmCalls.at(-1).messages[1].content, '여기에 주는 링크는 노트 사이트에서 요약 카드로 만들어 줘')
})

test('받아 적기: 없는 스킬 이름은 버리고, 모델이 JSON 을 못 주면 한 말을 그대로 할 일로', async () => {
  answers.push(JSON.stringify({ action: '이 파일을 영어로 번역한다', skill: 'no-such-skill' }))
  assert.deepEqual(await R.ruleAction('올리는 파일은 영어로 번역해 줘'), { action: '이 파일을 영어로 번역한다', skill: '' })
  answers.push(JSON.stringify({ action: '이 파일을 요약한다', skill: '' }))
  assert.deepEqual(await R.ruleAction('올리는 파일은 요약해 줘'), { action: '이 파일을 요약한다', skill: '' })
  answers.push('그냥 말로 답함')
  assert.deepEqual(await R.ruleAction('올리는 링크는 요약해 줘'), { action: '올리는 링크는 요약해 줘', skill: '' })
})

test('판단 코드에 사이트 이름·낱말 목록이 없다(사이트 지식은 브라우저 스킬 모듈에만)', () => {
  for (const f of ['../lib/roomRules.js', '../lib/turns.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
    const hit = src.match(/notebook|노트북|youtu|유튜브|powerpoint|파워포인트/i)
    assert.ok(!hit, `${f}: '${hit?.[0]}'`)
    assert.ok(!src.includes('https?:\\/\\/'), `${f}: 링크를 정규식으로 찾지 않는다`)
  }
})

// (last: a judge server that failed is not asked again for a minute)
test('판정 서버가 답하지 못하면 그 밖의 말로 두고(다른 길로 간다) 오류를 내지 않는다', async () => {
  judgeDown = true
  const r = await R.readRoom({ rule: RULE, text: 'https://a.example/x' })
  assert.equal(r.pick, 'other')
  assert.ok(r.error)
})
