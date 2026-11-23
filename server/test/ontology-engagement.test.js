// 받기만 한 메일 거르기 · 전달 메일 잇기(2026-11-24 휴대폰 녹화 「교육 안내 · 견적」): 회사가 답장 · 전달한 적 없는 바깥 메일은 일이
// 아니고, 전달 메일은 같은 제목이거나 같은 파일(이름 + 크기)일 때만 앞 스레드에 잇는다. 모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { engagementOf, engagedCase } from '../lib/ontology/engagement.js'
import { threadsOf, splitQuiet } from '../lib/ontology/history.js'

const inside = (a) => a.endsWith('@acme.example')
const mail = (id, thread, from, to = ['me@acme.example'], extra = {}) => ({ id, thread, from, to, cc: [], date: '2026-10-01T00:00:00Z', subject: '', attachments: [], ...extra })

test('스레드 안에 회사 사람이 쓴 메일이 있으면 일, 아무도 답하지 않은 바깥 메일은 일이 아니다', () => {
  const { threads } = engagementOf([
    mail('1', 'q', '"고객" <buyer@hanbit-display.example>'), mail('2', 'q', '대표 <ceo@acme.example>', ['buyer@hanbit-display.example']),
    mail('3', 'n', '"센터" <info@center.example>'),
  ], inside)
  assert.equal(threads.get('q'), 'inside')
  assert.equal(threads.get('n'), null)
})

test('회사가 메일을 보낸 적이 있는 상대(주소, 공용 메일이 아니면 그 도메인)가 새로 보낸 메일은 일', () => {
  const { threads, correspondents } = engagementOf([
    mail('1', 'a', 'me@acme.example', ['pm@hanbit-display.example', 'friend@gmail.com']),
    mail('2', 'b', 'other@hanbit-display.example'), // same company as someone we wrote to
    mail('3', 'c', 'friend@gmail.com'), // the very address we wrote to
    mail('4', 'd', 'stranger@gmail.com'), // a public mail domain: the address must match
  ], inside, { publicDomains: ['gmail.com'] })
  assert.ok(correspondents.has('@hanbit-display.example'))
  assert.equal(correspondents.has('@gmail.com'), false)
  assert.equal(threads.get('b'), 'correspondent')
  assert.equal(threads.get('c'), 'correspondent')
  assert.equal(threads.get('d'), null)
})

test('건은 그 스레드 중 하나라도 일이면 일, 보관함이 모르는 스레드는 그대로 둔다', () => {
  const threads = new Map([['x', null], ['y', 'inside']])
  assert.equal(engagedCase(['x'], threads), false)
  assert.equal(engagedCase(['x', 'y'], threads), true)
  assert.equal(engagedCase(['z'], threads), true)
})

test('전달 메일은 같은 파일(이름 + 크기)일 때만 앞 스레드에 잇는다 — 붙여 넣은 그림 image.png 이름만 같으면 잇지 않는다', () => {
  const at = (d) => `2026-10-${d}T01:00:00Z`
  const ms = [
    mail('n1', 'notice', 'info@center.example', ['me@acme.example'], { date: at('01'), subject: '[센터] 실무교육 안내', attachments: [{ name: 'image.png', size: 48211 }] }),
    mail('f1', 'fwd', 'pm@acme.example', ['me@acme.example'], { date: at('20'), subject: 'Fwd: 한빛디스플레이 27년 유지보수 견적 요청', attachments: [{ name: 'image.png', size: 9120 }] }),
    mail('p1', 'deck', 'buyer@hanbit.example', ['me@acme.example'], { date: at('02'), subject: '제안 요청', attachments: [{ name: 'RFP.pdf', size: 120334 }] }),
    mail('f2', 'fwd2', 'me@acme.example', ['pm@acme.example'], { date: at('05'), subject: 'Fwd: 자료 송부', attachments: [{ name: 'RFP.pdf', size: 120334 }] }),
  ]
  const ts = threadsOf(ms)
  const caseOf = (id) => ts.find((t) => t.mails.some((m) => m.id === id)).id
  assert.notEqual(caseOf('f1'), caseOf('n1'))
  assert.equal(caseOf('f2'), caseOf('p1'))
})

test('splitQuiet: 답 없는 스레드는 quiet — 규칙(engagement.enabled=false)으로 끌 수 있다', () => {
  const ms = [mail('1', 'q', 'buyer@hanbit-display.example'), mail('2', 'q', 'me@acme.example', ['buyer@hanbit-display.example']), mail('3', 'n', 'info@center.example')]
  const ts = threadsOf(ms)
  const who = { has: inside }
  const on = splitQuiet(ts, ms, who, { engagement: { enabled: true }, company: {} })
  assert.deepEqual(on.quiet.map((t) => t.id), ['n'])
  assert.deepEqual(on.work.map((t) => t.id), ['q'])
  const off = splitQuiet(ts, ms, who, { engagement: { enabled: false }, company: {} })
  assert.equal(off.quiet.length, 0)
})
