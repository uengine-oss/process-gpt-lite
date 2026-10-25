// 예약 작업·미션 — 스킬을 주기로 실행하는 예약(pg_cron), 일시정지·실행 에이전트 바꾸기·실행 기록, KST→GMT 변환,
// 콜백 비밀 확인. (영상 외부 연동·스킬·예약 미션 youtu.be/yVHodTrDwHg)
import { test, expect, api, uniq } from '../../lib/fixtures.js'

const NEVER = '0 0 31 2 *' // 2월 31일: 등록은 되지만 실제로 돌지 않는다

test('F-SC-01 미션 만들기 → 목록·다음 실행·pg_cron 등록 → 일시정지·에이전트 바꾸기 → 지우면 cron 도 해제', async ({ as, db, cleanup }) => {
  const u = await as('sc-user')
  const skill = (await u.get('/skills')).body[0]?.name
  test.skip(!skill, '테넌트 스킬이 없음')
  const name = uniq('회귀 미션')
  const m = await u.post('/missions', { name, cron: NEVER, skill, params: { 회귀: true } })
  expect(m.status, m.text).toBe(200)
  cleanup(() => u.del(`/schedules/${m.body.id}`))
  const jobs = m.body.job_name.split(',')
  expect((await db.q('select count(*)::int as n from cron.job where jobname = any($1)', [jobs]))[0].n).toBe(jobs.length)
  const row = (await u.get('/schedules')).body.find((s) => s.id === m.body.id)
  expect(row).toMatchObject({ name, skill, cron: NEVER })
  expect((await u.get('/skills')).body.find((s) => s.name === skill).missions.some((x) => x.id === m.body.id)).toBe(true)
  expect((await u.post(`/missions/${m.body.id}/pause`, { paused: true })).body.paused).toBe(true)
  expect((await u.get('/schedules')).body.find((s) => s.id === m.body.id).next_run).toBeNull()
  expect((await u.post(`/missions/${m.body.id}/agent`, { agent: 'claude-code' })).body.agent).toMatchObject({ orch: 'cliagents', cli: 'claude-code' })
  expect((await u.post(`/missions/${m.body.id}/agent`, { agent: 'gpt-rogue' })).status).toBe(400)
  expect(Array.isArray((await u.get(`/missions/${m.body.id}/runs`)).body)).toBe(true)
  // someone else cannot touch it
  const other = await as('sc-other')
  expect((await other.post(`/missions/${m.body.id}/pause`, { paused: false })).status).toBe(404)
  expect((await other.post(`/missions/${m.body.id}/run`)).status).toBe(404)
  await u.del(`/schedules/${m.body.id}`)
  expect((await db.q('select count(*)::int as n from cron.job where jobname = any($1)', [jobs]))[0].n).toBe(0)
  expect((await u.get('/schedules')).body.some((s) => s.id === m.body.id)).toBe(false)
})

test('F-SC-02 cron 콜백은 비밀값이 맞아야 한다', async () => {
  expect((await api.call(null, 'POST', '/cron/fire', { id: '00000000-0000-0000-0000-000000000000', secret: 'wrong' })).status).toBe(403)
})

test('F-SC-03 KST 예약식 → pg_cron(GMT) 변환과 다음 실행 시각', async ({ lib }) => {
  const S = await lib('lib/scheduler.js')
  expect(S.kstToGmt('0 9 * * 1-5')).toEqual(['0 0 * * 1-5'])
  expect(S.kstToGmt('30 8 * * *')).toEqual(['30 23 * * *'])
  expect(S.kstToGmt('*/1 * * * *')).toEqual(['*/1 * * * *'])
  const next = S.nextRun('0 9 * * *', new Date('2026-01-01T00:30:00Z')) // 09:30 KST → tomorrow 09:00 KST
  expect(next.toISOString()).toBe('2026-01-02T00:00:00.000Z')
  expect(S.nextRun(NEVER)).toBeNull()
})
