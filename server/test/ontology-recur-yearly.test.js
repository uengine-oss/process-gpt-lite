// 해마다 하는 일(2026-11-24 녹화 — LG디스플레이 유지보수 견적은 해마다 같은 때 온다): 메일이 말한 주기에 「매년(그 달)」을 더한다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cronOfHint } from '../lib/ontology/mailbody.js'
import { cronKo } from '../lib/ontology/timers.js'
import { nextRun } from '../lib/scheduler.js'

test('매년: 그 달 1일(말한 날이 있으면 그날) — 한국어로 「매년 10월 1일 9시」', () => {
  assert.equal(cronOfHint({ every: 'year', month: 10 }), '0 9 1 10 *')
  assert.equal(cronOfHint({ every: 'year', month: 3, dom: 15, hour: 14 }), '0 14 15 3 *')
  assert.equal(cronOfHint({ every: 'year' }), null)
  assert.equal(cronKo('0 9 1 10 *'), '매년 10월 1일 9시')
  assert.equal(cronKo('0 9 5 * *'), '매월 5일 9시')
})

test('다음 실행: 매년 주기도 찾는다(32일 너머), 매일 · 매주 · 매월은 그대로', () => {
  const from = new Date('2026-11-24T00:00:00Z') // 2026-11-24 화 09:00 KST
  assert.equal(nextRun('0 9 1 10 *', from).toISOString(), '2027-10-01T00:00:00.000Z')
  assert.equal(nextRun('30 8 * * 1-5', from).toISOString(), '2026-11-24T23:30:00.000Z')
  assert.equal(nextRun('0 9 5 * *', from).toISOString(), '2026-12-05T00:00:00.000Z')
  assert.equal(nextRun('0 9 * * 1', from).toISOString(), '2026-11-30T00:00:00.000Z')
})
