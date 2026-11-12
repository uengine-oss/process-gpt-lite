// 프로세스 온톨로지의 셈(lib/ontology/stats.js) — DB 없이. 판단 사례는 ontology-cases.json(경계값 포함)에서 읽는다.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { toCases, transitions, graphOf, nextOf, split, fitness, kneeTheta, nextStepAccuracy, pickHalfLife, staleness,
  bundlesOf, clusterCases, calibrate, summaryTheta, autoValues, bandOf, wilson, END, DAY, THETAS } from '../lib/ontology/stats.js'

const CASES = JSON.parse(fs.readFileSync(new URL('./ontology-cases.json', import.meta.url), 'utf8'))
const T0 = Date.UTC(2026, 7, 12)
const ev = (c, task, day, extra = {}) => ({ case: c, task, at: T0 + day * DAY, ...extra })

test('판단 사례: 카탈로그의 모든 사례가 기대대로', () => {
  let n = 0
  for (const k of CASES) {
    let got
    if (k.kind === 'stale') {
      // the source task's ways out: `before` up to the edge's last use (the edge's own n among them), `after` since
      const L = T0 + 30 * DAY
      const times = [...Array(k.before).fill(L - DAY), ...Array(k.after).fill(L + DAY)]
      got = staleness({ to: 'x', n: k.edge.n, lastSeen: L }, times).stale
    } else if (k.kind === 'thin') got = wilson(k.k, k.n).width > 0.3
    else if (k.kind === 'knee') got = kneeTheta(k.curve.map((fitness, i) => ({ theta: THETAS[i], fitness })), k.held)
    else if (k.kind === 'band') got = bandOf({ measurable: k.measurable, accuracy: { top1: k.top1 } }, k.bar)
    else throw new Error(`unknown kind ${k.kind}`)
    assert.deepEqual(got, k.expect, `${k.id}: ${k.note}`)
    n++
  }
  assert.equal(n, CASES.length)
})

test('같은 일이 잇달아 나오면 한 단계로 묶는다', () => {
  const [c] = toCases([ev('c1', '견적서 작성', 0), ev('c1', '견적서 작성', 1), ev('c1', '고객 회신', 2)])
  assert.deepEqual(c.steps.map((s) => s.task), ['견적서 작성', '고객 회신'])
  assert.equal(c.steps[0].end, T0 + DAY)
  assert.deepEqual(transitions(c).map((x) => `${x.from}>${x.to}`), ['견적서 작성>고객 회신', `고객 회신>${END}`])
  assert.equal(transitions(c)[0].wait, DAY) // 마지막 견적 메일부터 회신까지
})

test('확률 · 시작/끝 비율 · 의존도', () => {
  const evs = []
  for (let i = 0; i < 8; i++) evs.push(ev(`a${i}`, '요청', i), ev(`a${i}`, '평면도', i + 0.5), ev(`a${i}`, '회신', i + 1))
  for (let i = 0; i < 2; i++) evs.push(ev(`b${i}`, '요청', 20 + i), ev(`b${i}`, '견적서', 20.5 + i), ev(`b${i}`, '회신', 21 + i))
  const g = graphOf(toCases(evs))
  const e = g.edges.get('요청\u0000평면도')
  assert.equal(e.n, 8)
  assert.equal(e.p, 0.8)
  assert.equal(g.tasks.get('요청').entryShare, 1)
  assert.equal(g.tasks.get('회신').exitShare, 1)
  assert.ok(e.dependency > 0.85)
  assert.deepEqual(nextOf(g, '요청').map((x) => x.to), ['평면도', '견적서'])
})

test('병렬로 일어나는 두 일은 의존도가 0 가까이', () => {
  const evs = []
  for (let i = 0; i < 6; i++) {
    const [x, y] = i % 2 ? ['자재 발주', '일정 조율'] : ['일정 조율', '자재 발주']
    evs.push(ev(`p${i}`, '계약', i), ev(`p${i}`, x, i + 0.2), ev(`p${i}`, y, i + 0.4), ev(`p${i}`, '착공 안내', i + 0.6))
  }
  const g = graphOf(toCases(evs))
  assert.ok(Math.abs(g.edges.get('자재 발주\u0000일정 조율').dependency) < 0.3)
})

test('θ 모델의 재생 적합도와 다음 일 맞히기', () => {
  const evs = []
  for (let i = 0; i < 20; i++) evs.push(ev(`a${i}`, '요청', i), ev(`a${i}`, i === 7 ? '법무 검토' : '견적서', i + 0.3), ev(`a${i}`, '회신', i + 0.6))
  const cases = toCases(evs)
  const { train, holdout } = split(cases)
  assert.equal(holdout.length, 4)
  const g = graphOf(train)
  assert.equal(fitness(g, holdout, 0), 1)
  const acc = nextStepAccuracy(g, holdout)
  assert.equal(acc.top1, 1)
  // 법무 검토(1/20)는 θ=0.1 모델 밖
  const all = graphOf(cases)
  assert.equal(fitness(all, cases, 0.1) < 1, true)
})

test('반감기: 최근 4주에 일하는 방식이 바뀌면 짧은 반감기가 더 잘 맞힌다', () => {
  const evs = []
  for (let d = 0; d < 90; d++) {
    const late = d >= 50
    evs.push(ev(`c${d}`, '요청', d), ev(`c${d}`, late ? '현장 실측' : '평면도', d + 0.2), ev(`c${d}`, '평면도', d + 0.4))
  }
  const r = pickHalfLife(toCases(evs), { now: T0 + 91 * DAY })
  assert.equal(r.start, false)
  assert.ok(r.halfLife <= 30, `got ${r.halfLife}`)
  // 바뀌지 않는 회사는 긴 반감기
  const same = []
  for (let d = 0; d < 90; d++) same.push(ev(`s${d}`, '요청', d), ev(`s${d}`, d % 3 ? '평면도' : '견적서', d + 0.2))
  assert.ok(pickHalfLife(toCases(same), { now: T0 + 91 * DAY }).halfLife >= 60)
})

test('반감기: 잴 이동이 10개 미만이면 시작값', () => {
  const r = pickHalfLife(toCases([ev('a', '요청', 0), ev('a', '회신', 1)]), { now: T0 + 2 * DAY })
  assert.equal(r.start, true)
  assert.equal(r.halfLife, 60)
})

test('묶음: 서로 이어지지 않는 일들은 다른 묶음', () => {
  const g = graphOf(toCases([ev('a', '요청', 0), ev('a', '견적서', 1), ev('b', '계약', 0), ev('b', '발주', 1)]))
  const b = bundlesOf(g)
  assert.equal(b.length, 2)
  assert.deepEqual(b.map((x) => x.tasks).sort(), [['견적서', '요청'], ['계약', '발주']])
})

test('받아들일 확률 보정: 20건 미만이면 없음, 있으면 p가 높을수록 받아들인다', () => {
  assert.equal(calibrate([{ p: 0.9, accepted: true }]), null)
  const rec = []
  for (let i = 0; i < 40; i++) { const p = i / 40; rec.push({ p, accepted: p > 0.5 }) }
  const c = calibrate(rec)
  assert.ok(c.accept(0.9) > 0.5)
  assert.ok(c.accept(0.1) < 0.5)
})

test('요약 보기 θ는 일이 12개 이하로 남는 가장 작은 값', () => {
  const evs = []
  for (let i = 0; i < 30; i++) evs.push(ev(`m${i}`, '요청', i), ev(`m${i}`, `드문 일 ${i % 15}`, i + 0.3), ev(`m${i}`, '회신', i + 0.6))
  const g = graphOf(toCases(evs))
  const th = summaryTheta(g, 12)
  assert.ok(th > 0)
  assert.equal(summaryTheta(g, 100), 0)
})

test('자동 값: 측정할 수 없으면 시작값과 지켜보기', () => {
  const v = autoValues(toCases([ev('a', '요청', 0), ev('a', '회신', 1), ev('b', '요청', 2), ev('b', '회신', 3)]))
  assert.equal(v.measurable, false)
  assert.equal(v.thetaStart, true)
  assert.equal(bandOf(v), 'watch')
})

test('조건 문턱: 금액으로 두 갈래를 가르면 1천만 원 같은 사람이 쓰는 문턱', async () => {
  const { learnThreshold } = await import('../lib/ontology/stats.js')
  const rows = [3e6, 4.5e6, 6e6, 8.2e6, 9.1e6].map((x) => ({ x, y: '고객 회신' })).concat([10.4e6, 12.4e6, 18e6, 25e6, 40e6].map((x) => ({ x, y: '재무 검토' })))
  const c = learnThreshold(rows)
  assert.equal(c.high, '재무 검토')
  assert.equal(c.low, '고객 회신')
  assert.equal(c.threshold, 10_000_000)
  assert.equal(c.accuracy, 1)
  // 금액과 상관없이 갈리면 조건 글을 쓰지 않는다
  const noise = [3e6, 5e6, 8e6, 12e6, 20e6, 30e6, 4e6, 25e6].map((x, i) => ({ x, y: i % 2 ? '고객 회신' : '재무 검토' })) // 금액 순서로 번갈아
  assert.equal(learnThreshold(noise), null)
  assert.equal(learnThreshold(rows.slice(0, 3)), null)
})

test('묶음: 공통 일(요청·회신)이 있어도 핵심 흐름이 다르면 다른 묶음, 일부만 있는 건(견적만 다시)은 같은 묶음', () => {
  const evs = []
  const add = (id, tasks, d) => tasks.forEach((t, i) => evs.push(ev(id, t, d + i * 0.1)))
  for (let i = 0; i < 10; i++) add(`a${i}`, ['요청', '실측', '평면도', '제안서', '견적서', '회신'], i)
  for (let i = 0; i < 3; i++) add(`r${i}`, ['요청', '견적서', '회신'], 20 + i)
  for (let i = 0; i < 4; i++) add(`b${i}`, ['요청', '계약', '발주', '일정', '회신'], 30 + i)
  for (let i = 0; i < 3; i++) add(`c${i}`, ['요청', '실측', '하자 보수', '회신'], 40 + i) // 다른 흐름: 핵심의 절반이 안 됨
  for (let i = 0; i < 2; i++) add(`x${i}`, ['요청', '실측', '평면도', '팀장 의견', '제안서', '견적서', '회신'], 50 + i) // 흐름 + 엉뚱한 한 단계
  const groups = clusterCases(toCases(evs))
  assert.equal(groups.length, 3)
  const A = groups.find((g) => g.tasks.includes('견적서'))
  assert.equal(A.caseIds.length, 15)
  assert.ok(!A.tasks.includes('계약') && !A.tasks.includes('하자 보수'))
})

test('은퇴 후보의 「최근 N일」: 마지막으로 쓰인 뒤 그 일이 계속 쓰인 날 수', () => {
  const DAY = 86_400_000, L = Date.UTC(2026, 7, 31)
  const times = [...Array(10).fill(L - DAY), ...Array(40).fill(L + 5 * DAY), L + 72 * DAY]
  const s = staleness({ to: 'x', n: 5, lastSeen: L }, times)
  assert.equal(s.stale, true)
  assert.equal(Math.round(s.gapDays), 72)
})
