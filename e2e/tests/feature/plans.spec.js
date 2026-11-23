// 요금제 화면 — Hark 의 구독 화면처럼 탭 하나에 요금제 하나: 큰 가격, 사용량 배지, 그 요금제로 할 수 있는 일
// (품의서·회의록·프로세스·사과 메일을 실제로 시켜 보고 잰 비용으로 센 수: server lib/plans/equivalents.js ·
// jobs.json), 맨 아래 "모든 요금제에 무엇이 들어 있나". 사용량 한도를 켠 서버(PRO_LLM_KEYS=litellm)에서만 돈다.
import { test, expect } from '../../lib/fixtures.js'

const n = (v) => Number(v).toLocaleString('ko-KR')

test('F-PL-01 요금제 탭: 지금 요금제의 다음 것을 먼저, 할 수 있는 일은 서버가 잰 값 그대로, 팀원은 바꿔 달라고 요청', async ({ as, pageAs }) => {
  const u = await as('plan-member')
  const b = (await u.get('/billing')).body
  test.skip(!b?.enabled, '사용량 한도를 끈 서버 (PRO_LLM_KEYS=litellm 으로 켭니다)')
  test.skip(b.admin, '이 시험은 팀원 화면')
  const plans = b.catalog.plans
  const i = plans.findIndex((p) => p.code === b.subscription.plan)
  const next = plans[i + 1] || plans[i]
  const page = await pageAs('plan-member')
  await page.goto('/settings/usage')

  await expect(page.locator('.tiers button')).toHaveCount(plans.length)
  await expect(page.locator('.tiers button.on')).toContainText(next.name)
  await expect(page.locator('.tiers button', { hasText: plans[i].name }).locator('.now')).toHaveCount(1)
  const hero = page.locator('.hero')
  await expect(hero.locator('.brand em')).toHaveText(next.name.toLowerCase())
  // the line says the server's counts (or, pay-as-you-go, each job's price), every one of them
  for (const j of next.wit.jobs.filter((x) => next.wit.per !== 'usage' || x.key !== 'apology')) {
    await expect(hero.locator('.wit')).toContainText(next.wit.per === 'usage' ? (j.krw != null ? `₩${n(j.krw)}` : `$${j.usd}`) : n(j.n))
  }
  await expect(hero.locator('.witsrc')).toContainText(b.catalog.wit.measured)
  await expect(hero.locator('.cta')).toContainText('요청')
  await expect(page.locator('.up .foot')).toContainText('모든 요금제')

  // my own plan: nothing to ask for
  await page.locator('.tiers button', { hasText: plans[i].name }).click()
  await expect(hero.locator('.cta')).toHaveText('지금 요금제')
  await expect(hero.locator('.cta')).toBeDisabled()

  // a usage-based plan has nothing to divide: what each job costs instead
  const usage = plans.find((p) => p.wit?.per === 'usage')
  if (usage) {
    await page.locator('.tiers button', { hasText: usage.name }).click()
    await expect(hero.locator('.wit')).toContainText('쓴 만큼')
    const first = usage.wit.jobs[0]
    await expect(hero.locator('.wit')).toContainText(first.krw != null ? `₩${n(first.krw)}` : `$${first.usd}`)
  }
  expect(page.errors).toEqual([])
})
