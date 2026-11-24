// The chat composer's voice dictation (src/useDictation.js — 2026-11-24 사용자: 「채팅 입력 부분의 음성입력 부분이 누른상태면 계속 입력
// 받는걸로 해.. 목소리 끊겼다고 자동 발송하지말고..」): on until the person turns it off, a pause starts the next session, final phrases
// are appended and the phrase being heard follows them, tap toggles and a hold listens until let go, errors stop with a reason — and
// nothing is ever sent. A fake recognizer and a fake clock; no browser. The screen: e2e/tests/feature/voice-dictation.spec.js.
//   cd server && node --test test/dictation.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDictation, joinSpeech, pressOutcome, recognizerOf, MESSAGES, HOLD_MS, DESKTOP_START_MS, ERROR_SHOW_MS, STOP_GRACE_MS } from '../../src/useDictation.js'

// timers that move only when told to
function fakeClock() {
  let t = 0, id = 0
  const q = []
  return {
    now: () => t,
    setTimeout(fn, ms = 0) { const h = ++id; q.push({ h, at: t + ms, fn }); return h },
    clearTimeout(h) { const i = q.findIndex((x) => x.h === h); if (i >= 0) q.splice(i, 1) },
    advance(ms = 0) {
      const end = t + ms
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.h - b.h)
        const n = q[0]
        if (!n || n.at > end) break
        q.shift(); t = n.at; n.fn()
      }
      t = end
    },
  }
}

// a recognizer the test speaks through: say(text, final) replaces the phrase being heard or adds a new one, like Chrome's result list
function fakeRecognition() {
  const made = []
  class Rec {
    constructor() { this.calls = []; this.results = []; made.push(this) }
    start() { this.calls.push('start') }
    stop() { this.calls.push('stop') }
    abort() { this.calls.push('abort') }
    begin() { this.onstart?.({}) }
    say(transcript, final = false) {
      const r = Object.assign([{ transcript }], { isFinal: final })
      const last = this.results.length - 1
      if (last >= 0 && !this.results[last].isFinal) this.results[last] = r
      else this.results.push(r)
      this.onresult?.({ results: this.results, resultIndex: Math.max(0, last) })
    }
    error(code) { this.onerror?.({ error: code }) }
    end() { this.onend?.({}) }
  }
  return { Rec, made, get last() { return made[made.length - 1] } }
}

function setup({ text = '', desktop = false } = {}) {
  const clock = fakeClock()
  const sr = fakeRecognition()
  const box = { v: text }
  const states = []
  // what a composer would hand it — and a send it must never reach for
  const used = new Set()
  const sent = []
  const opts = {
    Recognition: sr.Rec,
    read: () => { used.add('read'); return box.v },
    write: (v) => { used.add('write'); box.v = v },
    onChange: (s) => { used.add('onChange'); states.push(s) },
    send: (v) => sent.push(v), submit: (v) => sent.push(v),
    desktop, timers: clock, now: clock.now,
  }
  const d = createDictation(opts)
  return { d, clock, sr, box, states, used, sent }
}

test('DV-U-01 낱말 잇기 · 인식기 찾기 · 누르기 규칙', () => {
  assert.equal(joinSpeech('', '안녕하세요'), '안녕하세요')
  assert.equal(joinSpeech('회의록', '정리해 줘'), '회의록 정리해 줘')
  assert.equal(joinSpeech('회의록 ', '정리해 줘'), '회의록 정리해 줘')
  assert.equal(joinSpeech('회의록', ' 정리해 줘'), '회의록 정리해 줘')
  assert.equal(joinSpeech('first line\n', 'next'), 'first line\nnext')
  assert.equal(joinSpeech('abc', ''), 'abc')
  const A = function () {}, B = function () {}
  assert.equal(recognizerOf({ SpeechRecognition: A, webkitSpeechRecognition: B }), A)
  assert.equal(recognizerOf({ webkitSpeechRecognition: B }), B)
  assert.equal(recognizerOf({}), null)
  assert.equal(recognizerOf(null), null)
  // idle mic: a tap leaves it on, a hold (push to talk) turns it off when let go; a listening mic: any press turns it off
  assert.equal(HOLD_MS, 350)
  assert.equal(pressOutcome(false, 120), 'keep')
  assert.equal(pressOutcome(false, HOLD_MS - 1), 'keep')
  assert.equal(pressOutcome(false, HOLD_MS), 'stop')
  assert.equal(pressOutcome(false, 4000), 'stop')
  assert.equal(pressOutcome(true, 80), 'stop')
  assert.equal(pressOutcome(true, 2000), 'stop')
})

test('DV-U-02 켜면: 계속 듣기(continuous) · 들리는 중인 말도 · 한국어, 「마이크 켜는 중」 → 「듣는 중」', () => {
  const { d, sr, states } = setup()
  d.start()
  const r = sr.last
  assert.equal(r.continuous, true)
  assert.equal(r.interimResults, true)
  assert.equal(r.lang, 'ko-KR')
  assert.deepEqual(r.calls, ['start'])
  assert.deepEqual(states.at(-1), { on: true, phase: 'starting', error: '' })
  r.begin()
  assert.deepEqual(states.at(-1), { on: true, phase: 'listening', error: '' })
  assert.equal(d.on, true)
  // a second start while on does nothing
  d.start()
  assert.equal(sr.made.length, 1)
})

test('DV-U-03 글 합치기: 있던 글 뒤에 확정된 말이 붙고, 들리는 중인 말은 그 뒤에 보이다가 바뀐다', () => {
  const { d, sr, box } = setup({ text: '회의록' })
  d.start(); const r = sr.last; r.begin()
  r.say('정리')
  assert.equal(box.v, '회의록 정리')
  r.say('정리해 줘')
  assert.equal(box.v, '회의록 정리해 줘')
  r.say('정리해 줘', true)
  assert.equal(box.v, '회의록 정리해 줘')
  r.say(' 그리고 메일')
  assert.equal(box.v, '회의록 정리해 줘 그리고 메일')
  r.say(' 그리고 메일로 보내 줘', true)
  assert.equal(box.v, '회의록 정리해 줘 그리고 메일로 보내 줘')
  // a later phrase without a leading space still gets one
  r.say('고마워', true)
  assert.equal(box.v, '회의록 정리해 줘 그리고 메일로 보내 줘 고마워')
})

test('DV-U-04 말이 끊겨도(no-speech · 세션 끝) 멈추지 않는다: 다음 세션이 바로 시작되고, 글은 그대로 이어진다', () => {
  const { d, sr, box, clock, states } = setup()
  d.start(); let r = sr.last; r.begin()
  r.say('첫 문장입니다', true)
  clock.advance(9000)
  // Chrome after a silence: no-speech, then end
  r.error('no-speech'); r.end()
  clock.advance(0)
  assert.equal(sr.made.length, 2, 'a new session started')
  assert.deepEqual(sr.last.calls, ['start'])
  assert.equal(d.on, true)
  assert.ok(!states.some((s) => s.on === false), 'never turned off')
  assert.equal(box.v, '첫 문장입니다')
  r = sr.last; r.begin()
  r.say('두 번째')
  assert.equal(box.v, '첫 문장입니다 두 번째')
  // a session that ends with a phrase still being heard keeps it (Chrome does not always make it final first)
  clock.advance(60000); r.end(); clock.advance(0)
  assert.equal(sr.made.length, 3)
  assert.equal(box.v, '첫 문장입니다 두 번째')
  sr.last.begin(); sr.last.say('세 번째', true)
  assert.equal(box.v, '첫 문장입니다 두 번째 세 번째')
  // 'aborted' (something else took the mic) and a network hiccup keep going too
  clock.advance(5000); sr.last.error('aborted'); sr.last.end(); clock.advance(0)
  assert.equal(sr.made.length, 4)
  clock.advance(5000); sr.last.error('network'); sr.last.end(); clock.advance(0)
  assert.equal(sr.made.length, 5)
  assert.equal(d.on, true)
})

test('DV-U-05 듣는 동안 사람이 고친 글은 남고, 다음 말은 그 뒤에 붙는다', () => {
  const { d, sr, box } = setup()
  d.start(); const r = sr.last; r.begin()
  r.say('견적서 보내', true)
  box.v = '견적서 보내 (가온상사)'      // typed into the box
  r.say('주세요')
  assert.equal(box.v, '견적서 보내 (가온상사) 주세요')
  r.say('주세요', true)
  assert.equal(box.v, '견적서 보내 (가온상사) 주세요')
  // typed while a phrase is being heard: what was shown is kept once, not twice when it turns final
  r.say('감사')
  box.v = box.v + '!'
  r.say('감사합니다', true)
  assert.equal(box.v, '견적서 보내 (가온상사) 주세요 감사!')
  r.say('끝', true)
  assert.equal(box.v, '견적서 보내 (가온상사) 주세요 감사! 끝')
})

test('DV-U-06 사람이 끄면(마이크 다시): 꺼지고, 마지막 말은 남고, 다시 켜지지 않는다', () => {
  const { d, sr, box, clock, states } = setup()
  d.start(); const r = sr.last; r.begin()
  r.say('오늘 일정')
  d.stop()
  assert.equal(d.on, false)
  assert.deepEqual(r.calls, ['start', 'stop'])
  assert.equal(states.at(-1).on, false)
  // the last phrase still comes, and is kept
  r.say('오늘 일정 알려 줘', true)
  assert.equal(box.v, '오늘 일정 알려 줘')
  r.end(); clock.advance(10000)
  assert.equal(sr.made.length, 1, 'no new session')
  assert.deepEqual(states.at(-1), { on: false, phase: 'off', error: '' })
  // a recognizer that never ends after stop: let go of after the grace time
  d.start(); const r2 = sr.last; r2.begin(); d.stop()
  clock.advance(STOP_GRACE_MS)
  assert.deepEqual(r2.calls, ['start', 'stop', 'abort'])
  assert.equal(states.at(-1).phase, 'off')
  // stop during the gap between two sessions: no session starts
  d.start(); const r3 = sr.last; r3.begin(); clock.advance(5000); r3.end()
  d.stop(); clock.advance(1000)
  assert.equal(sr.made.length, 3)
  assert.equal(states.at(-1).phase, 'off')
})

test('DV-U-07 보내기(cancel): 바로 꺼지고, 그 뒤에 들린 말은 비운 입력창에 돌아오지 않는다', () => {
  const { d, sr, box, clock } = setup()
  d.start(); const r = sr.last; r.begin()
  r.say('보고서 초안')
  // the composer sends what is shown, then empties the box
  d.cancel()
  box.v = ''
  assert.equal(d.on, false)
  assert.deepEqual(r.calls, ['start', 'abort'])
  r.say('보고서 초안 써 줘', true)
  r.end(); clock.advance(5000)
  assert.equal(box.v, '')
  assert.equal(sr.made.length, 1)
})

test('DV-U-08 누르기: 짧게 누르면 켜진 채, 길게 누르면 떼는 순간 꺼짐, 켜진 마이크는 누르면 꺼짐', () => {
  const { d, sr, clock } = setup()
  // tap
  d.press(); assert.equal(d.on, true, 'on as the finger goes down (push to talk hears the first word)')
  clock.advance(120); d.release()
  assert.equal(d.on, true)
  sr.last.begin()
  clock.advance(3000); sr.last.end(); clock.advance(0)
  assert.equal(d.on, true, 'a tap keeps it on across a pause')
  // tap again: off
  d.press(); clock.advance(90); d.release()
  assert.equal(d.on, false)
  // hold: on while held, off when let go
  d.press(); assert.equal(d.on, true)
  const held = sr.last; held.begin(); held.say('잠깐 메모')
  clock.advance(1500)
  assert.equal(d.on, true)
  d.release()
  assert.equal(d.on, false)
  assert.ok(held.calls.includes('stop'))
  // a release without a press (pointer up that started elsewhere) does nothing
  d.release()
  assert.equal(d.on, false)
  // keyboard: toggle
  d.toggle(); assert.equal(d.on, true)
  d.toggle(); assert.equal(d.on, false)
})

test('DV-U-09 오류: 마이크 권한 · 마이크 없음 · 계속되는 네트워크 · 자꾸 끊김 · 데스크톱 — 꺼지고 까닭을 말한다, 잠시 뒤 지워짐', () => {
  {
    const { d, sr, states, clock } = setup()
    d.start(); sr.last.error('not-allowed'); sr.last.end()
    assert.deepEqual(states.at(-1), { on: false, phase: 'off', error: MESSAGES.permission })
    assert.ok(sr.last.calls.includes('abort'))
    clock.advance(1000)
    assert.equal(sr.made.length, 1, 'not retried')
    clock.advance(ERROR_SHOW_MS)
    assert.equal(states.at(-1).error, '')
    // starting again clears a reason still shown
    d.start(); sr.last.error('audio-capture')
    assert.equal(states.at(-1).error, MESSAGES.noMic)
    d.start()
    assert.equal(states.at(-1).error, '')
  }
  {
    // a browser: two network errors are hiccups, the third stops
    const { d, sr, states, clock } = setup()
    d.start()
    for (let i = 0; i < 2; i++) { sr.last.error('network'); sr.last.end(); clock.advance(2000) }
    assert.equal(d.on, true)
    assert.equal(sr.made.length, 3)
    sr.last.error('network')
    assert.deepEqual(states.at(-1), { on: false, phase: 'off', error: MESSAGES.network })
  }
  {
    // sessions that end at once without a word, three in a row: not a loop
    const { d, sr, states, clock } = setup()
    d.start()
    for (let i = 0; i < 3; i++) { sr.last.begin(); clock.advance(100); sr.last.end(); clock.advance(1000) }
    assert.equal(d.on, false)
    assert.equal(states.at(-1).error, MESSAGES.stuck)
    assert.equal(sr.made.length, 3)
  }
  {
    // the desktop app (html.pgl-desktop): its Chromium has no speech service — the first network error says so
    const { d, sr, states } = setup({ desktop: () => true })
    d.start(); sr.last.error('network')
    assert.deepEqual(states.at(-1), { on: false, phase: 'off', error: MESSAGES.desktop })
  }
  {
    // the desktop app: nothing at all (no start) — not left looking stuck
    const { d, states, clock } = setup({ desktop: true })
    d.start()
    clock.advance(DESKTOP_START_MS - 1)
    assert.equal(d.on, true)
    clock.advance(1)
    assert.deepEqual(states.at(-1), { on: false, phase: 'off', error: MESSAGES.desktop })
  }
  {
    // a browser waiting on its permission prompt is not cut off
    const { d, clock } = setup()
    d.start(); clock.advance(60000)
    assert.equal(d.on, true)
  }
  {
    // a recognizer that throws on start
    const clock = fakeClock()
    const states = []
    class Bad { start() { throw new Error('InvalidStateError') } abort() {} }
    const d = createDictation({ Recognition: Bad, read: () => '', write: () => {}, onChange: (s) => states.push(s), timers: clock, now: clock.now })
    d.start()
    assert.deepEqual(states.at(-1), { on: false, phase: 'off', error: MESSAGES.service })
  }
})

test('DV-U-10 받아쓰기는 보내지 않는다: 켜기 · 말 · 끊김 · 끄기 · 길게 누르기 · 오류를 모두 거쳐도 읽기 · 쓰기 · 상태 알림만', () => {
  const { d, sr, clock, used, sent, box } = setup({ text: '메모:' })
  d.press(); clock.advance(100); d.release()
  sr.last.begin(); sr.last.say('내일 회의', true)
  clock.advance(8000); sr.last.error('no-speech'); sr.last.end(); clock.advance(0)
  sr.last.begin(); sr.last.say('열 시에')
  d.toggle()
  sr.last.say('열 시에 시작', true); sr.last.end()
  d.press(); clock.advance(900); sr.last.begin(); sr.last.say('장소는 3층', true); d.release(); sr.last.end()
  d.start(); sr.last.error('not-allowed')
  clock.advance(60000)
  assert.equal(box.v, '메모: 내일 회의 열 시에 시작 장소는 3층')
  assert.deepEqual(sent, [])
  assert.deepEqual([...used].sort(), ['onChange', 'read', 'write'])
})
