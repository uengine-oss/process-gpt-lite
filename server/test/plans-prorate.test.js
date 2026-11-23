// A month that changed plans is billed by days (lib/plans/catalog.js monthlyBill with history segments).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthlyBill, poolUsd } from '../lib/plans/catalog.js'

const from = new Date(Date.UTC(2026, 9, 1)), mid = new Date(Date.UTC(2026, 9, 15)), to = new Date(Date.UTC(2026, 10, 1))
const span = (a, b) => ({ from: a, to: b, frac: (b - a) / (to - from), days: (b - a) / 864e5 })

test('Team → Business on the 15th: 14 days of Team seats, 17 of Business, then VAT', () => {
  const segments = [{ catalog: 'uengine', plan: 'team', billing: 'month', ...span(from, mid) }, { catalog: 'uengine', plan: 'business', billing: 'month', ...span(mid, to) }]
  const b = monthlyBill({ plan: 'business', seats: ['business', 'business', 'business'], name: 'uengine', segments })
  const seats = b.lines.filter((l) => l.kind === 'seat')
  assert.deepEqual(seats.map((l) => [l.name, l.count, l.days]), [['Team', 3, 14], ['Business', 3, 17]])
  assert.equal(seats[0].amount, Math.round(3 * 19000 * 14 / 31))
  assert.equal(seats[1].amount, Math.round(3 * 39000 * 17 / 31))
  const vat = b.lines.find((l) => l.kind === 'vat')
  assert.equal(vat.amount, Math.round((seats[0].amount + seats[1].amount) * 0.1))
  assert.equal(b.total, seats[0].amount + seats[1].amount + vat.amount)
})

test('a whole month on one plan has no day ranges', () => {
  const b = monthlyBill({ plan: 'team', seats: ['team', 'team'], name: 'uengine' })
  assert.equal(b.lines[0].amount, 38000)
  assert.equal(b.lines[0].from, undefined)
})

test('the pool of a changed month is each plan\'s share of it', () => {
  const team = poolUsd('team', ['team', 'team'], 'uengine'), business = poolUsd('business', ['business', 'business'], 'uengine')
  const mixed = team * (14 / 31) + business * (17 / 31)
  assert.ok(mixed > team && mixed < business)
})
