// Robo-DLC Lite P3: the bolt line (docs/robo-dlc/plan-intake.md §13). The fixture is the units, contracts and
// bolt plan of a real run (회의실 예약, classic scope, first release finished); the requests on top of it
// are what the intake's estimate returned for real requests against that record.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as R from '../lib/aidlc/record.js'
import { buildLine, checkMove, violations, dependents, discardKind, nextUp, edgesOf, laneOf } from '../lib/aidlc/line.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(HERE, 'fixtures', 'aidlc-line', 'aidlc', 'spaces', 'default', 'intents', '261111-room-booking')
const CASES = JSON.parse(await fs.readFile(path.join(HERE, 'aidlc-line-cases.json'), 'utf8'))

const units = await R.readUnits(DIR)
const names = units.map((u) => u.name)
const contracts = await R.readContracts(DIR, names)
const bolts = await R.readBolts(DIR, names)
const first = { dir: '261111-room-booking', slug: 'room-booking', scope: 'classic', done: true, units, contracts, bolts }
const req = (id, title, touched, more = {}) => ({ id, title, status: 'queued', scope: 'feature', at: `2026-11-12T0${id.length}:00:00Z`,
  estimate: { touches: { units: touched, contracts: more.contracts || [] }, newUnits: more.newUnits || [], reverts: more.reverts || [] }, ...more.row })
const key = (line, title, unit) => line.bolts.find((b) => b.title === title && b.unit === unit)?.key

test('계약 요약 읽기: 제공 유닛 → 소비 유닛, 유닛이 아닌 상대는 글로', () => {
  assert.deepEqual(contracts.map((c) => [c.id, c.provider, c.consumers.join('+')]), [
    ['C1', 'u3-identity', 'u6-web-ui'], ['C2', 'u4-booking', 'u6-web-ui'], ['C3', 'u2-booking-rules', 'u4-booking+u6-web-ui'],
    ['C4', 'u3-identity', 'u4-booking+u5-notification-worker'], ['C5', 'u4-booking', 'u5-notification-worker'],
    ['C6', 'u5-notification-worker', ''], ['C7', 'u1-walking-skeleton', 'u5-notification-worker']])
  assert.match(contracts[5].consumerText, /External/)
  // 유닛 이름 없이 코드만 쓴 표(다른 실제 기록의 모양), 제공자가 소비 칸에 다시 나와도 빼고 읽는다
  const other = R.parseContracts('| # | Provider Unit | Consumer | Mechanism | Owner |\n|---|---|---|---|---|\n| C4 | U1 u1-domain-core (DB 스키마) | U3, U4 (U1 경유) | 공유 DB 스키마 | U1 |\n| C5 | External: 회사 SSO | U3 u3-api-server | OIDC | 외부 |',
    ['u1-domain-core', 'u2-api-contract', 'u3-api-server', 'u4-reminder-worker'])
  assert.deepEqual(other.map((c) => [c.provider, c.consumers.join('+')]), [['u1-domain-core', 'u3-api-server+u4-reminder-worker'], [null, 'u3-api-server']])
})

test('의존: 계약이 있으면 계약 이름으로, 없으면 유닛 의존으로', () => {
  const e = edgesOf(first)
  assert.deepEqual(e.filter((x) => x.to === 'u6-web-ui').map((x) => `${x.from}:${x.via}`).sort(), ['u1-walking-skeleton:unit', 'u2-booking-rules:C3', 'u3-identity:C1', 'u4-booking:C2'])
  assert.equal(laneOf('u5-notification-worker'), 'notification-worker')
})

test('끝난 릴리스: 볼트 계획 순서로 여섯, 모두 출시 칸', () => {
  const line = buildLine({ intents: [first] })
  assert.deepEqual(line.bolts.map((b) => [b.n, b.unit, b.state, b.bucket]), names.map((u, i) => [i + 1, u, 'done', 'shipped']))
  assert.deepEqual(line.buckets.map((b) => [b.key, b.total, b.done]), [['shipped', 6, 6], ['now', 0, 0], ['next', 0, 0], ['tail', 0, 0]])
  assert.equal(line.bolts[5].deps.every((d) => d.met), true)
})

test('줄 끝에 쌓이기: 도는 버그 수정은 이번 릴리스, 승인한 요청은 줄 끝에 예상 볼트로', () => {
  const line = buildLine({
    intents: [first, { dir: '261112-dup-mail', slug: 'dup-mail', scope: 'bugfix', running: true }],
    requests: [{ id: 'a', title: '알림 메일 중복', status: 'started', intent: '261112-dup-mail', estimate: { touches: { units: ['u5-notification-worker'], contracts: ['C6'] } } },
      req('bb', '반복 예약', ['u6-web-ui', 'u2-booking-rules', 'u4-booking'], { contracts: ['C2', 'C3'] })],
  })
  const tail = line.bolts.filter((b) => b.bucket === 'tail')
  assert.deepEqual(line.bolts.filter((b) => b.bucket === 'now').map((b) => [b.n, b.lane, b.state, b.title]), [[7, 'notification-worker', 'running', '알림 메일 중복']])
  // 유닛은 의존 그래프 순서로: 규칙 → 예약 → 화면
  assert.deepEqual(tail.map((b) => [b.n, b.unit, b.state]), [[8, 'u2-booking-rules', 'estimated'], [9, 'u4-booking', 'estimated'], [10, 'u6-web-ui', 'estimated']])
  // 예상 볼트는 기록의 계약 그래프를 물려받는다
  assert.deepEqual(tail[1].deps.map((d) => [d.n, d.via, d.met]), [[8, 'C3', false]])
  assert.deepEqual(tail[2].deps.map((d) => `${d.n}:${d.via}`).sort(), ['8:C3', '9:C2'])
  assert.equal(nextUp(line), 'bb')
})

test('사례: 릴리스 옮기기 · 의존을 거스르면 막고 함께 옮길 묶음을 알려 준다', () => {
  const line = buildLine({ intents: [first], requests: [req('bb', '반복 예약', ['u2-booking-rules', 'u4-booking', 'u6-web-ui'], { contracts: ['C2', 'C3'] }), req('ccc', '문구 수정', ['u6-web-ui'])] })
  assert.equal(CASES.moves.length >= 6, true)
  for (const c of CASES.moves) {
    const r = checkMove(line, key(line, c.title, c.unit), c.to)
    assert.equal(r.ok, c.ok, c.name)
    assert.deepEqual(r.blockers.map((b) => `${b.unit}:${b.why}`).sort(), [...c.blockers].sort(), c.name)
    assert.equal(r.together.length, c.together, c.name)
    if (r.together.length) assert.deepEqual(violations(line, Object.fromEntries(r.together.map((k) => [k, c.to]))), [], `${c.name}: 함께 옮기면 줄이 선다`)
  }
  // 혼자 옮기면 깨진다
  assert.equal(violations(line, { [key(line, '반복 예약', 'u6-web-ui')]: 'now' }).length, 2)
})

test('같은 유닛은 차례로, 다른 일의 계약을 건드리는 앞 볼트를 기다린다', () => {
  const line = buildLine({ intents: [first], requests: [req('bb', '반복 예약', ['u4-booking'], { contracts: ['C2'] }), req('ccc', '문구 수정', ['u6-web-ui']), req('dddd', '예약 취소 사유', ['u4-booking'])] })
  const word = line.bolts.find((b) => b.title === '문구 수정')
  const why = line.bolts.find((b) => b.title === '예약 취소 사유')
  // 문구 수정(u6)은 C2 를 고치는 앞 볼트(u4)를 기다린다 · 취소 사유(u4)는 같은 칸의 앞 볼트 뒤
  assert.deepEqual(word.deps.map((d) => d.via), ['C2'])
  assert.deepEqual(why.deps.map((d) => d.via), ['lane'])
  assert.deepEqual(dependents(line, line.bolts.find((b) => b.title === '반복 예약').key).length, 2)
})

test('버리기: 상태에 따라 · 버린 볼트는 의존에서 빠지고, 끝난 볼트는 되돌리는 볼트가 맨 앞', () => {
  const requests = [req('bb', '슬랙 알림으로 교체', ['u5-notification-worker'], { reverts: ['u5-notification-worker'], contracts: ['C6'] })]
  const intents = [first, { dir: '261112-dup-mail', slug: 'dup-mail', scope: 'bugfix', running: true }]
  const started = { id: 'a', title: '알림 메일 중복', status: 'started', intent: '261112-dup-mail', estimate: { touches: { units: ['u5-notification-worker'] } } }
  const line = buildLine({ intents, requests: [started, ...requests] })
  const running = line.bolts.find((b) => b.state === 'running')
  assert.deepEqual([discardKind(line.bolts[0]), discardKind(running), discardKind(line.bolts.at(-1))], ['revert', 'stop', 'drop'])
  const mine = line.bolts.filter((b) => b.request === 'bb')
  assert.deepEqual(mine.map((b) => [b.revert, b.unit]), [[true, 'u5-notification-worker']])
  assert.deepEqual(mine[0].deps.map((d) => d.via), ['lane'])
  // 도는 볼트를 버리면 뒤 볼트는 더 기다리지 않는다
  const after = buildLine({ intents, requests: [started, ...requests], marks: { [running.key]: { discarded_at: '2026-11-12T01:00:00Z', discard_reason: '방향이 바뀜', discarded_for: 'bb' } } })
  assert.equal(after.bolts.find((b) => b.key === running.key).discarded.reason, '방향이 바뀜')
  assert.deepEqual(after.bolts.find((b) => b.request === 'bb').deps, [])
  assert.equal(after.buckets.find((b) => b.key === 'now').total, 0)
})

test('빠른 칸 · 릴리스 지정 · 보류: 다음에 시작할 요청', () => {
  const requests = [req('bb', '반복 예약', ['u4-booking']), req('ccc', '문구 수정', ['u6-web-ui']), req('dddd', '비밀번호 로그 가리기', ['u3-identity'], { row: { fast: true, scope: 'security-patch' } })]
  let line = buildLine({ intents: [first], requests })
  assert.equal(nextUp(line), 'dddd')
  assert.equal(line.bolts.find((b) => b.request === 'dddd').fast, true)
  line = buildLine({ intents: [first], requests: requests.slice(0, 2), marks: { 'r:ccc:u6-web-ui': { bucket: 'now' } } })
  assert.equal(nextUp(line), 'ccc')
  assert.deepEqual(line.buckets.map((b) => b.total), [6, 1, 0, 1])
  line = buildLine({ intents: [first], requests: requests.slice(0, 2), marks: { 'r:bb:u4-booking': { hold: true } } })
  assert.equal(nextUp(line), 'ccc')
  // 건드리는 유닛을 못 찾은 요청도 볼트 하나로 줄에 선다
  line = buildLine({ intents: [first], requests: [req('bb', '무엇인지 모를 일', [])] })
  assert.deepEqual(line.bolts.at(-1).deps, [])
  assert.equal(line.lanes.at(-1), '')
})

test('유닛으로 나뉜 진행 중 인텐트: 유닛 상태가 볼트 상태', () => {
  const second = { ...first, dir: '261113-recurring', slug: 'recurring', scope: 'feature', done: false,
    metrics: { 'u1-walking-skeleton': { status: 'done' }, 'u2-booking-rules': { status: 'waiting' }, 'u4-booking': { status: 'blocked' } } }
  const line = buildLine({ intents: [first, second] })
  const mine = line.bolts.filter((b) => b.intent === second.dir)
  assert.deepEqual(mine.map((b) => b.state), ['done', 'running', 'planned', 'planned', 'planned', 'planned'])
  assert.equal(mine.every((b) => b.bucket === 'now'), true)
  assert.deepEqual(mine[3].deps.filter((d) => !d.met).map((d) => d.via).sort(), ['C3', 'C4'])
  // 이번 릴리스에서 다음 릴리스로: 소비하는 볼트가 따라와야 한다
  const r = checkMove(line, mine[3].key, 'next')
  assert.deepEqual(r.blockers.map((b) => `${b.unit}:${b.why}`).sort(), ['u5-notification-worker:consumer', 'u6-web-ui:consumer'])
  // 출시된 볼트는 못 옮긴다
  assert.equal(checkMove(line, line.bolts[0].key, 'next').error, 'shipped')
})

test('아무도 놓지 않은 볼트는 기다리는 볼트보다 앞 릴리스에 서지 않는다 · 사람이 놓은 자리는 그대로', () => {
  // 시작한 작업(인텐트는 아직 없음): 규칙·예약을 다음 릴리스로 옮겨 둔 채 시작했다 — 화면 볼트도 다음 릴리스로 따라간다
  const started = { id: 'bb', title: '반복 예약', status: 'started', scope: 'feature', at: '2026-11-12T02:00:00Z',
    estimate: { touches: { units: ['u2-booking-rules', 'u4-booking', 'u6-web-ui'], contracts: ['C2', 'C3'] } } }
  const marks = { 'r:bb:u2-booking-rules': { bucket: 'next' }, 'r:bb:u4-booking': { bucket: 'next' } }
  let line = buildLine({ intents: [first], requests: [started], marks })
  assert.deepEqual(line.bolts.filter((b) => b.request === 'bb').map((b) => [b.unit, b.state, b.bucket]),
    [['u2-booking-rules', 'running', 'next'], ['u4-booking', 'planned', 'next'], ['u6-web-ui', 'planned', 'next']])
  assert.deepEqual(violations(line), [])
  // 사람이 화면 볼트를 이번 릴리스에 놓았다면 그대로 두고, 어긋남으로 알린다
  line = buildLine({ intents: [first], requests: [started], marks: { ...marks, 'r:bb:u6-web-ui': { bucket: 'now' } } })
  assert.equal(line.bolts.find((b) => b.key === 'r:bb:u6-web-ui').bucket, 'now')
  assert.equal(violations(line).length, 2)
})

test('폐기할 때 함께 정할 볼트: 만든 것을 쓰는 볼트만 — 같은 유닛에서 뒤에 설 뿐인 볼트는 아니다', () => {
  const line = buildLine({ intents: [first], requests: [req('bb', '반복 예약', ['u2-booking-rules', 'u4-booking', 'u6-web-ui'], { contracts: ['C2', 'C3'] }), req('ccc', '예약 길이 규칙', ['u2-booking-rules'])] })
  const k = (id, u) => `r:${id}:${u}`
  assert.deepEqual(line.bolts.find((b) => b.key === k('ccc', 'u2-booking-rules')).deps.map((d) => d.via), ['lane'])
  assert.deepEqual(dependents(line, k('bb', 'u2-booking-rules'), true), [k('bb', 'u4-booking'), k('bb', 'u6-web-ui'), k('ccc', 'u2-booking-rules')])
  assert.deepEqual(dependents(line, k('bb', 'u2-booking-rules'), true, true), [k('bb', 'u4-booking'), k('bb', 'u6-web-ui')])
  assert.deepEqual(dependents(line, k('bb', 'u6-web-ui'), true, true), [])
})
