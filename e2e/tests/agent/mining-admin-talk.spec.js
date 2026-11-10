// 관리자가 대화로 프로세스 식별 결과를 확인하고 확정한다 (2026-11-10, intent-and-admin-boundary).
//
// 실제 관리자가 하는 그대로: 프로세스 마이닝 화면에서 추천을 열고, 대화 버튼을 눌러 왜 이렇게 묶였는지 묻고,
// 단계의 필수·옵션과 사례가 속한 프로세스를 말로 고친다. 그 사이 고객 메일(연습 메일)이 들어와 에이전트가
// 초안을 만들고, 업무가 끝나면 새 사례가 된다. 새 사례는 추천을 바꾸지 않고 제안으로 온다.
//
// 필수·옵션은 BPMN 의 뜻이다 — 옵션 = 정의에 건너뛰는 길(배타 게이트웨이 + 조건 흐름)이 있는 단계.
// 관리자가 언제 건너뛰는지 말하면 정식 등록된 정의가 새 버전으로 저장되고, 엔진이 그 조건대로 가른다.
//
// 단계 구성이 다른 정식 등록 프로세스 두 개 — 테넌트에 이미 있는 것을 쓴다(시험이 지어낸 추천이 아니다):
//   설계 제안·견적 대응  요청 메일 접수 → 평면도 → 제안서 → 견적서 → 재무 검토 → 고객 회신
//   행사 견적·고객 회신  요청 메일 접수 → 견적서 작성 → 계약 검토 → 고객 회신
// 그리고 제안·옮기기를 보는 추천 "요청 메일·견적서 작성"(교육 일정표).
//
// 로컬 Lite 를 ProcessGPT 게이트웨이 뒤(8088)에서 연다:
//   cd e2e && PGPT_URL=http://localhost:8088/lite npx playwright test tests/agent/mining-admin-talk.spec.js --project=agent
// 엔진 분기 확인은 process-gpt-completion 이 옆에 있을 때만 한다(PGPT_COMPLETION_DIR, 기본 ../../process-gpt-completion).
// 시험 데이터(사례·대화·확정)는 지우지 않는다. 다시 돌려도 성립하도록, 단계는 시작할 때 앱 API 로 필수로 되돌린다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../../lib/fixtures.js'
import { waitFor } from '../../lib/agent.js'

const DESIGN = '설계 제안·견적 대응'
const EDU = '요청 메일·견적서 작성'
const EVENT = '행사 견적·고객 회신'
const SHOTS = process.env.RT_SHOTS || ''
const here = path.dirname(fileURLToPath(import.meta.url))
const COMPLETION = process.env.PGPT_COMPLETION_DIR || path.resolve(here, '../../../../process-gpt-completion')
const ENGINE = path.join(COMPLETION, 'polling_service')
const CHECK = path.resolve(here, '../../../scripts/mining-engine-branch-check.py')

test.describe.configure({ mode: 'serial' })

async function shot(page, name) {
  // (the page fades in after a navigation: a picture taken mid-fade is unreadable)
  await page.waitForTimeout(1200)
  const body = await page.screenshot({ fullPage: false })
  await test.info().attach(name, { body, contentType: 'image/png' })
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(`${SHOTS}/${name}.png`, body) }
}

async function openRec(page, name) {
  await page.goto('/mining')
  await page.locator('.row', { hasText: name }).first().click()
  await expect(page.locator('.hero h1')).toHaveText(name, { timeout: 30_000 })
}

// 대화 버튼을 열고 한 마디 한다 → 시스템의 답
async function say(page, text) {
  if (await page.locator('.dial').isVisible()) await page.locator('.dial').click()
  const before = await page.locator('.talk .msg.agent').count()
  await page.locator('.talk .say input').fill(text)
  await page.locator('.talk .say input').press('Enter')
  await expect(page.locator('.talk .msg.agent:not(:has(.shimmer-text))')).toHaveCount(before + 1, { timeout: 180_000 })
  return (await page.locator('.talk .msg.agent').last().innerText()).trim()
}

const badge = (page, step) => page.locator('.flow .step', { hasText: step }).locator('.req').or(page.locator('.more .req', { hasText: step }))

async function rescan(page) {
  await page.goto('/mining')
  await page.getByRole('button', { name: /지금 다시 찾기/ }).click()
  await expect(page.getByRole('button', { name: /지금 다시 찾기/ })).toBeEnabled({ timeout: 300_000 })
  await expect(page.locator('.mv .err')).toHaveCount(0)
}

const rec = async (db, name) => (await db.q(`select * from pro_mining_suggestions where tenant_id=$1 and name=$2`, [db.tenant, name]))[0]
const defOf = async (db, r) => (await db.q('select definition from proc_def where lower(id)=lower($1) and tenant_id=$2', [r.proc_def_id, db.tenant]))[0]?.definition
const versionsOf = async (db, r) => (await db.q('select version from proc_def_version where lower(proc_def_id)=lower($1) and tenant_id=$2', [r.proc_def_id, db.tenant])).length

// 정의에서 그 단계를 건너뛰는 흐름(앞 배타 게이트웨이의 다른 갈래)과 그 조건
function skipOf(def, step) {
  const a = (def?.activities || []).find((x) => x.name === step)
  if (!a) return null
  const gws = new Set((def.gateways || []).filter((g) => /exclusive/i.test(g.type || '')).map((g) => g.id))
  const into = (def.sequences || []).find((x) => x.target === a.id && gws.has(x.source))
  if (!into) return null
  const skip = (def.sequences || []).find((x) => x.source === into.source && x.target !== a.id)
  return skip ? { gateway: into.source, condition: skip.condition, keepDefault: JSON.parse(into.properties || '{}').default === true } : null
}

// ProcessGPT 엔진 코드로: 저장된 정의에서 `after` 가 `data` 로 끝나면 다음 단계는?
function engineNext(def, after, data) {
  const file = path.join(os.tmpdir(), `mining-def-${process.pid}.json`)
  fs.writeFileSync(file, JSON.stringify(def))
  const out = execFileSync(path.join(ENGINE, '.venv/bin/python'), [CHECK, '--def', file, '--after', after, '--data', JSON.stringify(data)], { cwd: ENGINE, encoding: 'utf8', timeout: 180_000 })
  return JSON.parse(out.split('\n').filter((l) => l.startsWith('{"after"')).pop())
}
const engineHere = () => fs.existsSync(path.join(ENGINE, '.venv/bin/python'))

test('A-MN-10 관리자가 대화로 근거를 확인하고 필수·옵션(BPMN)과 사례의 소속을 확정한다 · 새 사례는 제안으로 온다', async ({ pageAs, db }) => {
  test.setTimeout(60 * 60_000)
  const page = await pageAs('mining-admin')
  const u = page.user
  // 준비: 이 시험 계정을 관리자로, 데모 메일함을 연결한다 (화면 밖의 계정 설정)
  await db.q('update users set is_admin=true where id=$1 and tenant_id=$2', [u.id, db.tenant])
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
  const fixture = JSON.parse(fs.readFileSync(new URL('../../../server/fixtures/demo-mail.json', import.meta.url), 'utf8'))
  for (const m of fixture) await db.q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [u.id, m.id])
  const design0 = await rec(db, DESIGN), edu0 = await rec(db, EDU), event0 = await rec(db, EVENT)
  test.skip(!design0?.proc_def_id || !event0?.proc_def_id || !edu0, `이 테넌트에 정식 등록된 '${DESIGN}'·'${EVENT}' 와 추천 '${EDU}' 가 있어야 함`)
  // 준비: 지난 실행이 남긴 옵션을 앱 API 로 필수로 되돌린다 (같은 시작점에서 보기 위해)
  for (const [r, step] of [[design0, '재무 검토'], [event0, '계약 검토']]) {
    if (!skipOf(await defOf(db, r), step)) continue
    const back = await u.post(`/mining/suggestions/${r.id}/talk`, { text: `${step}는 필수 단계로 해 줘` }, { timeout: 180_000 })
    expect(back.status, back.text).toBe(200)
    expect(skipOf(await defOf(db, r), step), `${step} 를 필수로 되돌림`).toBeNull()
  }

  await test.step('인수조건 1·4: 정식 등록 "설계 제안·견적 대응"(6단계)의 근거를 묻고, 재무 검토를 조건과 함께 옵션으로 확정한다', async () => {
    await openRec(page, DESIGN)
    const why = await say(page, '왜 이 사례들이 한 프로세스로 묶였어? 단계별 근거도 알려줘')
    // 근거는 저장된 값으로: 업무 범주와 단계별 빈도
    expect(why).toContain(design0.pattern.category)
    expect(why).toMatch(new RegExp(`재무 검토[^\\n]*${design0.pattern.frequency['재무 검토']}\\s*/\\s*${design0.pattern.case_count}`))
    await expect(badge(page, '재무 검토')).toHaveText(/필수/)
    await shot(page, '1-설계-근거')
    // 조건 없이 옵션이라고만 하면 언제 건너뛰는지 묻고, 정의는 그대로다
    const v0 = await versionsOf(db, design0)
    const asked = await say(page, '재무 검토는 옵션 단계로 해 줘')
    expect(asked).toMatch(/언제 건너뛰/)
    expect(skipOf(await defOf(db, design0), '재무 검토')).toBeNull()
    expect(await versionsOf(db, design0)).toBe(v0)
    await shot(page, '2-설계-조건-되물음')
    const done = await say(page, '견적 합계가 5천만 원 미만이면 건너뛰어')
    expect(done).toMatch(/배타 게이트웨이/)
    // 정의: 재무 검토 앞 배타 게이트웨이, 건너뛰는 흐름에 관리자의 조건, 재무 검토로 가는 흐름이 기본
    const skip = skipOf(await defOf(db, design0), '재무 검토')
    expect(skip?.condition).toMatch(/5천만/)
    expect(skip?.keepDefault).toBe(true)
    expect(await versionsOf(db, design0)).toBe(v0 + 1)
    // 화면이 받는 BPMN 도 게이트웨이와 조건이 든 최신 버전이다
    const xml = (await u.get(`/processes/${encodeURIComponent(design0.proc_def_id)}/bpmn`)).text
    expect(xml).toMatch(/exclusiveGateway id="gw_opt_/)
    expect(xml).toContain('5천만')
    await page.reload()
    await expect(badge(page, '재무 검토')).toHaveText(/옵션/)
    await expect(badge(page, '재무 검토')).toHaveClass(/admin/)
    await page.locator('.reg .bpmn').scrollIntoViewIfNeeded()
    await shot(page, '3-설계-등록-BPMN-게이트웨이')
  })

  await test.step('인수조건 2: 엔진이 저장된 정의대로 견적 합계에 따라 재무 검토를 건너뛰거나 거친다', async () => {
    test.skip(!engineHere(), `ProcessGPT 엔진(process-gpt-completion/polling_service)이 없음: ${ENGINE}`)
    const def = { ...(await defOf(db, design0)), processDefinitionId: design0.proc_def_id }
    const low = engineNext(def, '견적서 작성', { '견적 합계': 30_000_000 })
    const high = engineNext(def, '견적서 작성', { '견적 합계': 80_000_000 })
    test.info().annotations.push({ type: '엔진 분기', description: `3천만 → ${low.next.join(',')} · 8천만 → ${high.next.join(',')}` })
    expect(low.next).toEqual(['고객 회신'])
    expect(high.next).toEqual(['재무 검토'])
  })

  await test.step('인수조건 1·4: 단계 구성이 다른 정식 등록 "행사 견적·고객 회신"(4단계)에서 계약 검토를 옵션으로 확정한다', async () => {
    await openRec(page, EVENT)
    const v0 = await versionsOf(db, event0)
    const done = await say(page, '계약 검토는 옵션이야. 고객이 메일에서 계약서를 요청하지 않았으면 건너뛰어')
    expect(done).toMatch(/계약 검토[\s\S]*배타 게이트웨이/)
    const skip = skipOf(await defOf(db, event0), '계약 검토')
    expect(skip?.condition).toMatch(/계약서/)
    expect(await versionsOf(db, event0)).toBe(v0 + 1)
    const xml = (await u.get(`/processes/${encodeURIComponent(event0.proc_def_id)}/bpmn`)).text
    expect(xml).toMatch(/exclusiveGateway id="gw_opt_/)
    await page.reload()
    await expect(badge(page, '계약 검토')).toHaveText(/옵션/)
    await page.locator('.reg .bpmn').scrollIntoViewIfNeeded()
    await shot(page, '4-행사-등록-BPMN-게이트웨이')
    if (engineHere()) {
      const def = { ...(await defOf(db, event0)), processDefinitionId: event0.proc_def_id }
      const no = engineNext(def, '견적서 작성', { '고객 요청': '견적서만 요청했고 계약서는 요청하지 않음' })
      const yes = engineNext(def, '견적서 작성', { '고객 요청': '견적서와 함께 계약서 초안도 요청함' })
      test.info().annotations.push({ type: '엔진 분기', description: `계약서 요청 없음 → ${no.next.join(',')} · 요청 → ${yes.next.join(',')}` })
      expect(no.next).toEqual(['고객 회신'])
      expect(yes.next).toEqual(['계약 검토'])
    }
  })

  await test.step('인수조건 2·3: 다시 찾아도 정의와 확정이 그대로이고, 추천의 근거가 바뀌지 않는다', async () => {
    const vd = await versionsOf(db, design0), ve = await versionsOf(db, event0)
    await rescan(page)
    const design = await rec(db, DESIGN), event = await rec(db, EVENT), edu = await rec(db, EDU)
    expect(skipOf(await defOf(db, design0), '재무 검토')?.condition).toMatch(/5천만/)
    expect(skipOf(await defOf(db, event0), '계약 검토')?.condition).toMatch(/계약서/)
    expect([await versionsOf(db, design0), await versionsOf(db, event0)]).toEqual([vd, ve])
    // 이후 사례를 붙일 때 쓰는 필수 단계도 정의의 필수 단계다 (옵션이 된 단계는 빠진다)
    expect(design.pattern.core_activities).not.toContain('재무 검토')
    expect(event.pattern.core_activities).not.toContain('계약 검토')
    expect(design.pattern.case_ids).toEqual(design0.pattern.case_ids)
    expect(edu.pattern.case_ids).toEqual(edu0.pattern.case_ids)
    await openRec(page, DESIGN)
    await expect(badge(page, '재무 검토')).toHaveText(/옵션/)
  })

  await test.step('인수조건 3: 추천 "요청 메일·견적서 작성"에서 묻기만 한 말은 아무것도 바꾸지 않는다', async () => {
    await openRec(page, EDU)
    const before = await rec(db, EDU)
    const why = await say(page, '이 추천은 왜 하나로 묶였어?')
    expect(why).toContain(edu0.pattern.category)
    const after = await rec(db, EDU)
    expect([after.pattern.case_ids, after.confirmed, after.excluded]).toEqual([before.pattern.case_ids, before.confirmed, before.excluded])
  })

  // 고객 메일이 들어온다 — 같은 일(교육 일정표)과 비슷한 고객의 다른 문서(온보딩 안내서)
  const arrive = async (template, subject) => {
    const t0 = new Date()
    const r = await u.post('/mail/demo-arrive', { template }, { timeout: 300_000 })
    expect(r.status, r.text).toBe(200)
    // 에이전트가 초안을 만들고(단계 둘 이상), 업무가 끝나 업무 범주가 정해질 때까지
    const c = await waitFor(async () => {
      await u.post('/mining/scan', {}, { timeout: 300_000 })
      return (await db.q(`select * from pro_mining_cases where user_id=$1 and subject=$2 and created_at >= $3 and category is not null`, [u.id, subject, t0]))[0]
    }, { timeout: 25 * 60_000, every: 20_000 })
    expect(c, `${subject} 사례가 끝나 업무 범주가 정해짐`).toBeTruthy()
    return c
  }
  let schedule, onboarding
  await test.step('메일 두 통이 들어와 에이전트가 초안을 만들고 사례가 된다', async () => {
    ;[schedule, onboarding] = await Promise.all([
      arrive('saebom-edu-schedule', '입사자 교육 일정표 부탁드립니다'),
      arrive('saebom-edu-onboarding', '신입 사원 온보딩 안내서 한 부 부탁드립니다'),
    ])
    test.info().annotations.push({ type: '업무 범주', description: `교육 일정표 메일: ${schedule.category} · 온보딩 메일: ${onboarding.category}` })
  })

  // 새 사례가 추천에 저절로 들어가지 않고 관리자에게 오는 두 길: 제안(정의의 필수 단계를 거침) 또는 확인 필요(안 거침)
  const waiting = async (caseId) => {
    const edu = await rec(db, EDU)
    if ((edu.proposal?.case_ids || []).includes(caseId)) return 'proposal'
    const [c] = await db.q('select category_ask from pro_mining_cases where case_id=$1', [caseId])
    return c?.category_ask ? `ask:${c.category_ask}` : 'none'
  }

  await test.step('인수조건 2·3: 같은 업무의 새 사례는 추천을 바꾸지 않고, 정의의 필수 단계로 판정해 제안이나 확인 필요로 온다', async () => {
    await rescan(page)
    const edu = await rec(db, EDU)
    expect(edu.pattern.case_ids, '추천의 근거는 그대로').toEqual(edu0.pattern.case_ids)
    const where = await waiting(schedule.case_id)
    test.info().annotations.push({ type: '교육 일정표 새 사례', description: `${where} · 정의의 필수 단계: ${(edu.pattern.core_activities || []).join(', ')}` })
    expect(where, '관리자에게 온다(제안 또는 확인 필요)').not.toBe('none')
    await page.goto('/mining')
    await shot(page, '5-목록-새-사례')
    await openRec(page, EDU)
    await expect(page.locator('.stats')).toContainText(`${edu0.pattern.case_count}건 반복`)
    await shot(page, '6-교육-정의와-새-사례')
    const before = await rec(db, EDU)
    const what = await say(page, '새로 온 교육 일정표 사례는 왜 이 프로세스에 바로 안 들어왔어?')
    expect(what.length).toBeGreaterThan(10)
    expect((await rec(db, EDU)).pattern.case_ids, '묻기만 해서는 바뀌지 않음').toEqual(before.pattern.case_ids)
    // 정식 등록한 다른 프로세스도 그대로다
    expect((await rec(db, DESIGN)).pattern.case_ids).toEqual(design0.pattern.case_ids)
    expect((await rec(db, EVENT)).pattern.case_ids).toEqual(event0.pattern.case_ids)
  })

  await test.step('인수조건 1: 관리자가 대화로 새 사례들을 이 프로세스로 옮긴다', async () => {
    const moved = await say(page, '새봄교육 온보딩 안내서 요청 사례도 같은 교육 업무야. 이 프로세스로 넣어 줘')
    expect(moved).toMatch(/온보딩 안내서.*옮겼어요/)
    let edu = await rec(db, EDU)
    expect(edu.pattern.case_ids).toContain(onboarding.case_id)
    const [c] = await db.q('select category, category_by from pro_mining_cases where case_id=$1', [onboarding.case_id])
    expect(c).toEqual({ category: edu.pattern.category, category_by: 'admin' })
    if (!edu.pattern.case_ids.includes(schedule.case_id)) {
      const took = (await waiting(schedule.case_id)) === 'proposal'
        ? await say(page, '제안된 새 사례도 이 프로세스에 넣어 줘')
        : await say(page, '새로 온 새봄교육 입사자 교육 일정표 요청 사례도 이 프로세스로 넣어 줘')
      // 같은 요청이 여러 건이면 시스템이 되묻는다 — 관리자는 모두 넣으라고 답한다
      const done = /근거에 넣었어요|옮겼어요/.test(took) ? took : await say(page, '둘 다 이 프로세스로 넣어 줘')
      expect(done).toMatch(/근거에 넣었어요|옮겼어요/)
    }
    edu = await rec(db, EDU)
    expect(edu.pattern.case_ids).toEqual(expect.arrayContaining([...edu0.pattern.case_ids, schedule.case_id, onboarding.case_id]))
    await expect(page.locator('.stats')).toContainText(`${edu.pattern.case_ids.length}건 반복`)
    await shot(page, '7-교육-옮기기')
  })

  await test.step('인수조건 2: 다음에 들어온 온보딩 안내서 메일은 관리자의 판단(범주)대로 판단되고, 저절로 들어가지 않는다', async () => {
    const next = await arrive('saebom-edu-onboarding', '신입 사원 온보딩 안내서 한 부 부탁드립니다')
    const edu = await rec(db, EDU)
    expect(next.category, '관리자가 정한 범주를 예로 판단').toBe(edu.pattern.category)
    await rescan(page)
    const after = await rec(db, EDU)
    expect(after.pattern.case_ids, '근거는 관리자가 넣은 그대로').toEqual(edu.pattern.case_ids)
    const where = await waiting(next.case_id)
    test.info().annotations.push({ type: '다음 온보딩 사례', description: where })
    expect(where).not.toBe('none')
    await page.goto('/mining')
    await shot(page, '8-다음-온보딩')
  })

  await test.step('대화는 다시 열어도 남는다', async () => {
    await openRec(page, EDU)
    await page.reload()
    await page.locator('.dial').click()
    await expect(page.locator('.talk .msg.admin', { hasText: '이 프로세스로 넣어 줘' }).last()).toBeVisible()
    await shot(page, '9-대화-기록')
  })
})
