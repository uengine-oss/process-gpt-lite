// The plan screen's line — what a plan's usage buys in measured jobs (lib/plans/equivalents.js, jobs.json).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MEASURED, ORDER, roundDown, amountOf, equivalentsOf } from '../lib/plans/equivalents.js'
import { CATALOGS, usdPerCredit, creditsOf } from '../lib/plans/catalog.js'

test('every job on the line was measured: real runs, a model, an answer', () => {
  for (const k of ORDER) {
    const j = MEASURED.jobs[k]
    assert.ok(j, `${k} measured`)
    assert.ok(j.usd > 0 && j.runs >= 3 && j.models?.length && j.answer > 0, `${k}: ${JSON.stringify(j)}`)
  }
  assert.match(MEASURED.measured, /^\d{4}-\d\d-\d\d$/)
})

test('counts round down to two figures and never claim more than the plan holds', () => {
  assert.deepEqual([0.4, 1, 87.9, 100, 1234, 56789].map(roundDown), [0, 1, 87, 100, 1200, 56000])
  for (const plan of ['free', 'team', 'business']) {
    const a = amountOf(plan, 'uengine')
    for (const j of equivalentsOf(plan, 'uengine').jobs) {
      assert.ok(j.n * MEASURED.jobs[j.key].usd <= a.usd + 1e-9, `${plan} ${j.key}: ${j.n}`)
      assert.ok(j.n > 0)
    }
  }
})

test('Process GPT: Free is the company\'s month, Team and Business a seat\'s, Business holds 4,000 / 1,500 of Team', () => {
  const free = equivalentsOf('free', 'uengine'), team = equivalentsOf('team', 'uengine'), biz = equivalentsOf('business', 'uengine')
  assert.equal(free.per, 'company'); assert.equal(free.credits, 1000)
  assert.equal(team.per, 'seat'); assert.equal(team.credits, 1500)
  assert.equal(biz.credits, 4000)
  assert.deepEqual(biz.jobs.map((j) => j.key), ORDER)
  for (const j of biz.jobs) {
    const t = team.jobs.find((x) => x.key === j.key)
    const exact = (4000 * usdPerCredit()) / MEASURED.jobs[j.key].usd
    assert.equal(j.n, roundDown(exact))
    assert.ok(j.n >= t.n * 2, `${j.key}: ${j.n} vs ${t.n}`)
  }
})

test('Enterprise has no amount to divide: each job\'s price, in credits and won', () => {
  const e = equivalentsOf('enterprise', 'uengine')
  assert.equal(e.per, 'usage')
  for (const j of e.jobs) {
    assert.equal(j.credits, Math.max(1, creditsOf(MEASURED.jobs[j.key].usd)))
    assert.equal(j.krw, j.credits * 10)
  }
})

test('catalogs in windows: Claude Free a session, paid plans a week; Hark a month', () => {
  assert.equal(equivalentsOf('free', 'claude').per, 'session')
  assert.equal(equivalentsOf('pro', 'claude').per, 'week')
  assert.equal(equivalentsOf('max20', 'claude').jobs[0].n > equivalentsOf('pro', 'claude').jobs[0].n, true)
  assert.equal(equivalentsOf('pro10', 'hark').per, 'month')
  assert.equal(equivalentsOf('enterprise', 'claude').per, 'usage')
  assert.ok(equivalentsOf('enterprise', 'claude').jobs.every((j) => j.usd > 0 && j.krw == null))
})

test('every plan of every catalog gets a line, and an unknown plan none', () => {
  for (const [name, c] of Object.entries(CATALOGS)) for (const code of Object.keys(c.plans)) assert.ok(equivalentsOf(code, name)?.jobs.length, `${name}/${code}`)
  assert.equal(equivalentsOf('nope', 'uengine'), null)
})
