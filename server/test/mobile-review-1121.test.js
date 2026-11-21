// 2026-11-21 phone review: the pure pieces behind the fixes (no database, no model).
import test from 'node:test'
import assert from 'node:assert/strict'
import { marked } from 'marked'
import { noticeText } from '../../src/noticeText.js'
import { installCjkMarkdown } from '../../src/markdownCjk.js'
import { createTrail, hostsIn, trailEntry } from '../lib/workTrail.js'
import { decide, choiceDecision } from '../lib/skills/router.js'
import { loadSkills } from '../lib/skills/registry.js'
import { recentScheduleIds } from '../lib/skills/facts.js'
import { sendsToTelegram, channelsOf } from '../lib/missions.js'

// the notice from the recording: an agent answer with its ```json block copied into the title
const LEAVE = '휴가 신청이 성공적으로 완료되었습니다. 이번 주 목요일(12월 28일)부터 금요일(12월 29일)까지 휴가를 신청하셨습니다. 상사와 인사팀의 승인을 기다리시면 됩니다. 추가로 궁금한 점이 있거나 다른 요청이 있으시면 언제든지 말씀해 주세요! 😊 ```json { "action": "process_executed", "status": "success", "message": "휴가 신청이 성공적으로 완료되었습니다.", "data": { "instance_id": "leave_request_and_approval_process.ae1d7b9d-41d2-4209-b919-d8285a0f13d3" }, "next_actions": ["휴가 신청 상태 확인", "다른 프로세스 실행"] } ```'

test('R-1121-01 a notice title drops the JSON an agent answer carried, and stays short', () => {
  const t = noticeText(LEAVE, 160)
  assert.ok(!t.includes('{') && !t.includes('instance_id') && !t.includes('```'), t)
  assert.ok(t.startsWith('휴가 신청이 성공적으로 완료되었습니다.'))
  assert.ok(t.length <= 160)
  assert.ok(t.endsWith('말씀해 주세요! 😊'), t)
  assert.ok(noticeText(LEAVE.repeat(3).replace(/```json[^`]*```/g, ''), 160).endsWith('…'))
})

test('R-1121-02 a cut-off fence, a bare JSON tail and markdown marks', () => {
  assert.equal(noticeText('완료했어요. ```json {"a": 1, "b": "x'), '완료했어요.')
  assert.equal(noticeText('완료했어요. {"status": "success", "id": "p.1"}'), '완료했어요.')
  assert.equal(noticeText('**견적서** 를 [열어](https://x.y/z) 보세요\n\n# 제목'), '견적서 를 열어 보세요 제목')
  assert.equal(noticeText(''), '')
  assert.equal(noticeText('평범한 제목'), '평범한 제목')
  // a brace in the middle of a sentence is not a JSON tail
  assert.equal(noticeText('집합 {a, b} 를 비교했어요'), '집합 {a, b} 를 비교했어요')
})

test('R-1121-03 **bold** closes before a Korean particle', () => {
  installCjkMarkdown()
  assert.match(marked.parse('**AST모바일(096540)**은 조회 데이터에서'), /<strong>AST모바일\(096540\)<\/strong>은/)
  assert.match(marked.parse('**코스피**가 올랐어요'), /<strong>코스피<\/strong>가/)
  assert.match(marked.parse('- **KOSPI**: 현재 4,869.96'), /<li><strong>KOSPI<\/strong>: 현재/)
  // what CommonMark already did stays the same
  assert.match(marked.parse('a **b** c'), /a <strong>b<\/strong> c/)
  assert.match(marked.parse('`**code**`'), /<code>\*\*code\*\*<\/code>/)
  assert.match(marked.parse('** 띄움 **'), /\*\* 띄움 \*\*/)
})

// What a message means is the router's (lib/skills/router.js, model + skills/actions); these check what the
// server does with its answer — the ids it accepts, the asks it makes — with a scripted model. Whether the
// model reads a message right is measured by the evaluation sets (server/eval, design 7), not here.
const SKILLS = loadSkills()
const FACTS = {
  schedules: [{ id: 'a1111111', name: '환율 감시', paused: false }, { id: 'b2222222', name: '아침 브리핑', paused: false }, { id: 'c3333333', name: '지난 작업', paused: true }],
  recentSchedules: [], telegram: { connected: false, linked: false, bot: null }, apps: [], folders: [], attachedFolder: null,
  processes: [], improvable: [], team: [], agentSkills: [], mySkills: [], files: [], openDoc: null, generation: null, noFolder: false,
}
// a model that answers with these function calls, in order, and records what it was asked
function scripted(...calls) {
  const seen = []
  const llm = async (req) => { seen.push(req); const c = calls[Math.min(seen.length - 1, calls.length - 1)]; return { content: '', tool_calls: c ? [{ id: 'x', type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1]) } }] : [] } }
  return { llm, seen }
}
const run = (facts, ...calls) => { const m = scripted(...calls); return decide({ messages: [{ role: 'user', content: '…' }], facts, skills: SKILLS, llm: m.llm }).then((d) => ({ d, seen: m.seen })) }

test('R-1121-04 run now: an id from the facts runs that task once — the router never makes a new schedule for it', async () => {
  const { d, seen } = await run(FACTS, ['schedule_run_now', { schedule: 'a1111111', ack: '지금 한 번 돌려 볼게요.' }])
  assert.equal(d.route, 'skill')
  assert.equal(d.skill, 'schedule-run-now')
  assert.deepEqual(d.args, { schedule: 'a1111111' })
  assert.equal(d.stage2, false, 'an inline skill answers in one call')
  assert.equal(seen.length, 1)
  // the first call offers run-now with the tasks' ids, and the facts name them
  const tool = seen[0].tools.find((t) => t.function.name === 'schedule_run_now')
  assert.deepEqual(tool.function.parameters.properties.schedule.enum, ['a1111111', 'b2222222', 'c3333333'])
  assert.match(seen[0].messages[0].content, /a1111111 환율 감시/)
})

test('R-1121-05 an id that is not one of the tasks: its skill is read once more, then the server asks which task', async () => {
  const { d, seen } = await run(FACTS, ['schedule_run_now', { schedule: 'zzz', ack: '…' }], ['schedule_run_now', { schedule: 'still-wrong' }])
  assert.equal(seen.length, 2, 'stage 2 read the skill body')
  assert.match(seen[1].messages[0].content, /# schedule-run-now/)
  assert.equal(d.route, 'ask')
  // the active tasks to choose from, each choice the action with its id
  assert.deepEqual(d.choices.map((c) => [c.label, c.skill, c.args.schedule]), [['환율 감시', 'schedule-run-now', 'a1111111'], ['아침 브리핑', 'schedule-run-now', 'b2222222']])
  // only one active task: that one
  const one = await run({ ...FACTS, schedules: [FACTS.schedules[0], FACTS.schedules[2]] }, ['schedule_run_now', { ack: '…' }])
  assert.deepEqual([one.d.route, one.d.args.schedule], ['skill', 'a1111111'])
  // no task at all: run-now is not offered, and an empty router answer is the agent's
  const none = await run({ ...FACTS, schedules: [] }, null)
  assert.ok(!none.seen[0].tools.some((t) => t.function.name === 'schedule_run_now'))
  assert.equal(none.d.route, 'delegate')
})

test('R-1121-06 Telegram: alerts for which task — asked when it is not clear; connecting needs no task', async () => {
  const a = await run(FACTS, ['telegram_delivery', { action: 'alerts_on', ack: '…' }])
  assert.equal(a.d.route, 'ask')
  assert.deepEqual(a.d.choices.map((c) => c.args), [{ action: 'alerts_on', schedule: 'a1111111' }, { action: 'alerts_on', schedule: 'b2222222' }])
  const c = await run(FACTS, ['telegram_delivery', { action: 'connect', ack: '…' }])
  assert.deepEqual([c.d.route, c.d.args], ['skill', { action: 'connect' }])
  // the choice tapped later runs only while it is still right
  assert.equal(choiceDecision(a.d.choices[0], FACTS).skill, 'telegram-delivery')
  assert.equal(choiceDecision(a.d.choices[0], { ...FACTS, schedules: [] }), null)
  // which task a conversation just made or ran: its chips' ids, newest first
  const rows = [{ kind: 'chip', content: { scheduleId: 'b2' } }, { kind: 'text', content: { text: '…' } }, { kind: 'chip', content: { scheduleId: 'a1' } }]
  assert.deepEqual(recentScheduleIds(rows), ['a1', 'b2'])
  assert.equal(sendsToTelegram({ state: { channels: ['telegram'] } }), true)
  assert.equal(sendsToTelegram({ state: {} }), false)
  assert.deepEqual(channelsOf({ state: { channels: 'x' } }), [])
})

test('R-1121-08 the router asks only to pick a target of an action that has one; any other question is not its to ask', async () => {
  // an ask about an action without targets (a new schedule) is not offered as an ask: the action runs
  const s = await run(FACTS, ['ask', { skill: 'schedule-create', question: '몇 시에요?' }])
  assert.notEqual(s.d.route, 'ask')
  const ask = s.seen[0].tools.find((t) => t.function.name === 'ask')
  assert.ok(!ask.function.parameters.properties.skill.enum.includes('schedule-create'))
  assert.ok(ask.function.parameters.properties.skill.enum.includes('schedule-run-now'))
  // an ask with ids the facts do not have lists the real candidates
  const r = await run(FACTS, ['ask', { skill: 'schedule-run-now', question: '어느 것?', options: ['nope'] }])
  assert.deepEqual(r.d.choices.map((c) => c.args.schedule), ['a1111111', 'b2222222'])
  // one named target: no question, the action with it
  const one = await run(FACTS, ['ask', { skill: 'schedule-run-now', question: '?', options: ['b2222222'] }])
  assert.deepEqual([one.d.route, one.d.args.schedule], ['skill', 'b2222222'])
})

test('R-1121-07 the work trail names steps and sites, never a command or a key', () => {
  const tr = createTrail()
  tr.add('execute', { command: 'curl -H "User-Agent: Mozilla/5.0" "https://ac.stock.naver.com/ac?q=AST&target=stock&key=SECRET123"' }, '실행하는 중')
  tr.add('execute', { command: 'curl https://api.stock.naver.com/chart/foreign/item/ASTS.O/day' }, '실행하는 중')
  tr.add('web_search', { query: 'AST SpaceMobile 주가' }, '찾아보는 중')
  tr.add('read_file', { file_path: '/workspace/x/report.md' }, '파일 살펴보는 중')
  tr.add('write_todos', { todos: [] }, '할 일 정리하는 중')
  const list = tr.list()
  const text = JSON.stringify(list)
  assert.ok(!text.includes('SECRET123') && !text.includes('curl') && !text.includes('User-Agent'), text)
  assert.deepEqual(tr.hosts(), ['ac.stock.naver.com', 'api.stock.naver.com'])
  assert.equal(list.find((e) => e.query)?.query, 'AST SpaceMobile 주가')
  assert.equal(list.find((e) => e.file)?.file, 'report.md')
  assert.equal(list.some((e) => e.tool === 'write_todos'), false)
  assert.deepEqual(hostsIn('http://localhost:8787/x https://www.youtube.com/watch?v=1'), ['youtube.com'])
  assert.deepEqual(trailEntry('fetch', '{"url":"https://m.stock.naver.com/api"}', '찾아보는 중').hosts, ['m.stock.naver.com'])
})

test('R-1121-13 a sentence after an inline JSON snippet is not cut from a notice', () => {
  assert.equal(noticeText('설정 {"a":1} 을 저장했고 결과는 목록 [1]'), '설정 {"a":1} 을 저장했고 결과는 목록 [1]')
})
