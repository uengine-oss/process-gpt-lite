// Robo-DLC Lite: a session that waits on a person without a selection prompt (lib/aidlc/ask.js), and the hooks
// that tell this server at once (lib/aidlc/hooks.js). The cases are the words a real classic run (「비품 대여」,
// 2026-11-11~14) stopped on — three of them approvals asked in the chat that no card ever showed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
config.aidlcHookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-hooks-'))
const ASK = await import('../lib/aidlc/ask.js')
const AS = await import('../lib/aidlc/session.js')
const HK = await import('../lib/aidlc/hooks.js')
const CASES = JSON.parse(fs.readFileSync(path.join(here, 'aidlc-ask-cases.json'), 'utf8'))

for (const c of CASES) {
  test(`대화로 물은 것: ${c.name}`, () => {
    const got = ASK.askOptions(c.message)
    assert.equal(got.kind, c.kind, `kind for ${c.at}`)
    assert.deepEqual(got.options.map((o) => o.label), c.options)
    assert.deepEqual(got.options.filter((o) => o.text).map((o) => o.label), c.needsText)
  })
}

// ---------- the screen ----------
const RULE = '─'.repeat(60)
const idle = (box = '', said = ['⏺ Bash(npm run verify)', '  ⎿  ok', '', '⏺ Build and Test를 승인할까요?', '', '  1. Approve', '  2. Request Changes: 바꿀 점을 알려 주세요.']) =>
  [...said, '', RULE, `❯ ${box}`, RULE, '  ⏸ manual mode on'].join('\n')
const working = ['⏺ 코드 생성을 시작합니다.', '', '✻ Generating… (12s · esc to interrupt)', '', RULE, '❯ ', RULE].join('\n')

test('화면: 입력창이 비었고 일하지 않으면 기다리는 중, 마지막 말은 도구 줄이 아닌 마지막 ⏺ 덩어리', () => {
  const s = idle()
  assert.ok(AS.atPrompt(s))
  assert.equal(AS.busy(s), false)
  assert.equal(AS.draft(s), '')
  assert.equal(AS.lastMessage(s), 'Build and Test를 승인할까요?\n\n1. Approve\n2. Request Changes: 바꿀 점을 알려 주세요.')
  assert.equal(ASK.askOptions(AS.lastMessage(s)).kind, 'approval')
})
test('화면: 일하는 중(esc to interrupt), 누가 입력창에 적는 중, 마지막이 도구 줄이면 말이 없다', () => {
  assert.ok(AS.busy(working))
  assert.equal(AS.draft(idle('커밋해 줘')), '커밋해 줘')
  assert.equal(AS.draft(idle('Try "how do I log an error?"')), '', 'a fresh session\'s suggestion is not a draft')
  assert.equal(AS.lastMessage(idle('', ['⏺ 확인합니다.', '⏺ Read 3 files (ctrl+o to expand)'])), '')
})

test('화면(녹화한 실제 화면): 도는 중 스피너·백그라운드 대기는 일하는 중, 끝난 턴의 요약 줄은 아니다', () => {
  const screen = (f) => fs.readFileSync(path.join(here, 'fixtures', 'aidlc-screens', `${f}.txt`), 'utf8')
  assert.equal(AS.busy(screen('working')), true, '✶ Razzle-dazzling… (14s · ↓ 1.0k tokens)')
  assert.equal(AS.busy(screen('permission')), true, '✻ Waiting for 1 background agent to finish')
  assert.equal(AS.busy(screen('idle')), false)
  const ask = screen('ask')
  assert.equal(AS.busy(ask), false, '✻ Worked for 3m 12s · done')
  assert.ok(AS.atPrompt(ask))
  assert.match(AS.lastMessage(ask), /^9개가 Unverified입니다[\s\S]*2\. Request Changes$/)
  assert.deepEqual(ASK.askOptions(AS.lastMessage(ask)).options.map((o) => o.label), ['Approve', 'Request Changes'])
})

// ---------- is it waiting? ----------
const cur = { status: 'in-flight', state: { status: 'Active' }, stage: { slug: 'build-and-test', name: '빌드와 테스트', roleKey: 'qa' } }
test('훅 없이: 같은 빈 화면이 몇 초 서 있어야 기다림으로 본다', async () => {
  const name = 'aidlc-test-steady'
  const s = idle()
  assert.equal(await ASK.askOf(cur, name, s, 1000), null, 'first sight')
  assert.equal(await ASK.askOf(cur, name, s, 3000), null, 'two seconds later')
  const a = await ASK.askOf(cur, name, s, 8000)
  assert.equal(a.kind, 'ask'); assert.equal(a.askKind, 'approval'); assert.equal(a.roleKey, 'qa')
  assert.equal(a.title, '빌드와 테스트 승인을 기다려요')
  assert.match(a.key, /^ask:[0-9a-f]{16}$/)
  assert.equal(await ASK.askOf(cur, name, working, 9000), null, 'working again')
})
test('훅이 멈췄다고 하면 바로, 그 말 그대로 — 사람이 보내면(UserPromptSubmit) 다시 화면을 기다린다', async () => {
  const name = 'aidlc-test-hook'
  const said = CASES.find((c) => c.at === '2026-11-13T21:27:04.716Z').message
  HK.receive(name, { hook_event_name: 'Stop', last_assistant_message: said })
  const a = await ASK.askOf(cur, name, idle(), 1000)
  assert.equal(a.message, said)
  assert.deepEqual(a.options.map((o) => o.label), ['Approve Plan', 'Request Changes', "I'll edit the files", 'Other'])
  HK.receive(name, { hook_event_name: 'Notification', message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  assert.equal(HK.lastOf(name).turn, 'idle', 'a notice leaves the turn as it was')
  HK.receive(name, { hook_event_name: 'UserPromptSubmit', prompt: 'Approve Plan' })
  assert.equal(await ASK.askOf(cur, name, idle(), 2000), null, 'the screen has to stand again')
})
test('끝난 작업, 선택 창이 떠 있는 화면은 대화로 묻는 것이 아니다', async () => {
  HK.receive('aidlc-test-done', { hook_event_name: 'Stop', last_assistant_message: '커밋하실 때 말씀해 주세요.' })
  assert.equal(await ASK.askOf({ ...cur, status: 'complete' }, 'aidlc-test-done', idle(), 1000), null)
  const prompt = ['☐ Approval', 'Approve the code plan?', '', '❯ 1. Approve Plan', '  2. Request Changes', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n')
  assert.equal(await ASK.askOf(cur, 'aidlc-test-done', prompt, 1000), null)
})

// ---------- the hooks ----------
test('훅 설정: 세션마다 서명이 다르고, 설정 파일은 프로젝트 밖에 600 으로', () => {
  const file = HK.settingsFile('aidlc-localhost-demo', 8798)
  assert.ok(file.startsWith(config.aidlcHookDir))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const s = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(s.hooks).sort(), ['Notification', 'Stop', 'UserPromptSubmit'])
  const cmd = s.hooks.Stop[0].hooks[0].command
  assert.match(cmd, /http:\/\/127\.0\.0\.1:8798\/api\/aidlc\/hook\/aidlc-localhost-demo/)
  assert.match(cmd, /\|\| true$/, 'a hook never holds the session up')
  assert.ok(HK.verify('aidlc-localhost-demo', HK.token('aidlc-localhost-demo')))
  assert.equal(HK.verify('aidlc-localhost-other', HK.token('aidlc-localhost-demo')), false)
  assert.equal(HK.verify('aidlc-localhost-demo', ''), false)
  assert.equal(HK.receive('x', { hook_event_name: 'PreToolUse' }), null, 'only the three events')
})
