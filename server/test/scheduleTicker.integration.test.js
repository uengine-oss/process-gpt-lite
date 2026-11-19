// 서버가 예약 시계가 되는 경우(PRO_CRON_MODE=server) — 운영 Supabase 가 클러스터 밖이라 pg_cron 의
// 콜백이 Service 주소에 닿지 않는다. 실제 데이터베이스에서:
//   등록은 pg_cron 작업을 만들지 않고, 매 분 그 분을 가리키는 예약만 고르며, 멈춘 예약은 고르지 않는다.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_CRON_MODE = 'server'
const { pool, q } = await import('../lib/supa.js')
const S = await import('../lib/scheduler.js')

const KST = (s) => new Date(`${s}+09:00`)
const ids = []

test('KST 식이 가리키는 분만 맞다', () => {
  assert.equal(S.dueAt('0 8 * * *', KST('2026-10-30T08:00:00')), true)
  assert.equal(S.dueAt('0 8 * * *', KST('2026-10-30T08:01:00')), false)
  assert.equal(S.dueAt('0 8 * * *', new Date('2026-10-30T08:00:00Z')), false) // UTC 8시는 KST 17시
  assert.equal(S.dueAt('30 9 * * 1', KST('2026-11-02T09:30:00')), true) // 월요일
  assert.equal(S.dueAt('30 9 * * 1', KST('2026-11-03T09:30:00')), false)
  assert.equal(S.dueAt('*/15 * * * *', KST('2026-10-30T13:45:00')), true)
  assert.equal(S.nextRun('0 8 * * *', KST('2026-10-30T08:00:00')).getTime(), KST('2026-10-31T08:00:00').getTime())
})

test('서버 모드 등록은 pg_cron 작업 없이 남고, 그 분에만 골라진다', async () => {
  const user = crypto.randomUUID()
  const s = await S.createSchedule({ userId: user, name: '시계 시험', cron: '7 3 * * *', prompt: '시험', threadId: null })
  ids.push(s.id)
  assert.equal(s.job_name, null)
  const [row] = await q('select job_name from pro_schedules where id=$1', [s.id])
  assert.equal(row.job_name, null)
  assert.ok((await S.dueSchedules(KST('2026-10-30T03:07:00'))).includes(s.id))
  assert.ok(!(await S.dueSchedules(KST('2026-10-30T03:08:00'))).includes(s.id))
  await q('update pro_schedules set paused=true where id=$1', [s.id])
  assert.ok(!(await S.dueSchedules(KST('2026-10-30T03:07:00'))).includes(s.id))
})

test('"N분 뒤 한 번"은 KST 그 분을 가리키는 cron 이고, 한 번짜리로 저장된다', async () => {
  const cron = S.cronAfter(3, KST('2026-11-02T23:58:30'))
  assert.equal(cron, '2 0 3 11 *') // 올림한 분, 날짜가 넘어간다
  assert.equal(S.dueAt(cron, KST('2026-11-03T00:02:00')), true)
  const s = await S.createSchedule({ userId: crypto.randomUUID(), name: '한 번', cron, prompt: '시험', threadId: null, notify: 'always', once: true })
  ids.push(s.id)
  assert.equal(s.notify, 'always')
  assert.deepEqual(s.state, { once: true })
})

test('기본 예약은 지금처럼 바뀔 때만 알리고 한 번짜리가 아니다', async () => {
  const s = await S.createSchedule({ userId: crypto.randomUUID(), name: '감시', cron: '7 3 * * *', prompt: '시험', threadId: null })
  ids.push(s.id)
  assert.equal(s.notify, 'on_change')
  assert.equal(s.state?.once, undefined)
})

test('한 번짜리 예약은 실행되면 다시 골라지지 않는다', async () => {
  const { runMission } = await import('../lib/missions.js')
  const s = await S.createSchedule({ userId: crypto.randomUUID(), name: '한 번 실행', cron: '7 3 * * *', prompt: '시험', threadId: null, notify: 'always', once: true })
  ids.push(s.id)
  await runMission(s.id, 'cron') // 프로필이 없어 실행은 실패로 기록되지만, 다시 돌면 안 되는 것은 같다
  assert.ok(!(await S.dueSchedules(KST('2026-10-30T03:07:00'))).includes(s.id))
})

after(async () => {
  if (ids.length) await q('delete from pro_schedules where id = any($1::uuid[])', [ids])
  await pool.end()
})
