'use strict'
// Claude Code's lost Enter (src/runner/session.js resubmit — spec local-agents LA-TERM-ENTER): when Enter is pressed again, and when not.
// The session's own state with a stand-in terminal (what it is sent is recorded) — no CLI is started:
//   · the input box's line holds the paste placeholder, nothing came back: Enter again, 3 times at most
//   · not while a question is open · not once UserPromptSubmit came (late too) · not after the turn ended (Stop)
//   · not for a message given while the CLI works (a steer during a busy turn) · not when the placeholder is only further up the screen
// Run: cd desktop && node --test test/resubmit.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { CliSession, inputLine } = require('../src/runner/session')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-resubmit-'))
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
const HELD = '\x1b[1m✻ Claude Code\x1b[0m\r\n\x1b[2m────────\x1b[0m\r\n\x1b[1m❯\x1b[0m [Pasted text #1 +9 lines]\x1b[7m \x1b[0m\r\n\x1b[2m────────\x1b[0m\r\n  ⏵⏵ accept edits on (shift+tab to cycle)'
function session() {
  const S = new CliSession({ agent: 'claude-code', cwd: ROOT, stateDir: path.join(ROOT, 'state'), pty: {} })
  const sent = []
  S.p = { write: (d) => { sent.push(d); return true } }
  S.ready = true
  S.buf = HELD
  return { S, sent, enters: () => sent.filter((d) => d === '\r').length, due: () => { if (S.unsent) S.unsent.at = Date.now() - 10_000 } }
}

test('입력란의 줄: 마지막 프롬프트 줄의 글 — 위쪽 기록에 남은 자리표시는 아니다', () => {
  assert.equal(inputLine('❯ [Pasted text #1 +9 lines]'), '[Pasted text #1 +9 lines]')
  assert.equal(inputLine('│ > [Pasted text #2 +3 lines]   │'), '[Pasted text #2 +3 lines]')
  assert.equal(inputLine('❯ [Pasted text #1 +9 lines]\n● 읽었어요\n❯ '), '')
  assert.equal(inputLine('아무 프롬프트도 없음'), null)
})

test('자리표시가 입력란에 남고 아무 신호가 없으면 Enter 를 다시 — 3번까지만', () => {
  const { S, enters, due } = session()
  S.unsent = { at: 0, tries: 0 }
  for (let i = 0; i < 6; i++) { due(); S.resubmit() }
  assert.equal(enters(), 3)
  assert.equal(S.unsent, null, '3번 뒤에는 그만')
})

test('묻는 것이 열려 있으면 누르지 않는다(그 Enter 는 답이 된다)', () => {
  const { S, enters, due } = session()
  S.unsent = { at: 0, tries: 0 }
  S.asks.set('a1', { id: 'a1', kind: 'permission', choices: ['yes', 'no'] })
  due(); S.resubmit()
  assert.equal(enters(), 0)
})

test('UserPromptSubmit 이 늦게 와도 그 뒤로는 누르지 않고, 턴이 끝나면(Stop) 기다림도 없다', () => {
  const { S, enters, due } = session()
  S.unsent = { at: 0, tries: 0 }
  due(); S.resubmit()
  assert.equal(enters(), 1)
  S.onHook({ event: 'UserPromptSubmit', data: { prompt: 'x' } })
  due(); S.resubmit()
  assert.equal(enters(), 1, '늦게 온 UserPromptSubmit')
  assert.equal(S.unsent, null)
  const b = session()
  b.S.unsent = { at: 0, tries: 0 }
  b.S.onHook({ event: 'Stop', data: {} })
  b.due(); b.S.resubmit()
  assert.equal(b.enters(), 0, 'Stop')
})

test('자리표시가 입력란이 아니라 위쪽에만 있으면 누르지 않는다', () => {
  const { S, enters, due } = session()
  S.buf = `${HELD}\r\n● 첫 메시지를 받았어요\r\n\x1b[1m❯\x1b[0m `
  S.unsent = { at: 0, tries: 0 }
  due(); S.resubmit()
  assert.equal(enters(), 0)
})

test('CLI 가 일하는 중에 넣은 말(조종)은 확인 대상이 아니다 — Enter 를 더 누르지 않는다', async () => {
  const { S, enters, due } = session()
  S.busy = true
  S.submit('표지는 보라색으로')
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(enters(), 1, '붙여 넣기 뒤의 Enter 한 번')
  assert.equal(S.unsent ?? null, null)
  due(); S.resubmit()
  assert.equal(enters(), 1)
  S.stopTimers()
})
