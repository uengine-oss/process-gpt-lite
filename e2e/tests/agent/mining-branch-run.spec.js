// 분기의 모든 흐름에 조건 — 관리자가 대화로 갈래 조건을 고치고, 다음 메일이 그 조건대로 실행된다 (2026-11-11,
// openspec intent-and-admin-boundary 결정 9·10).
//
// 실제 관리자가 하는 그대로: 프로세스 마이닝 화면에서 정식 등록된 "요청 메일·견적서 작성"을 연다. 택일 분기의
// 제안서 작성 갈래는 업무 흐름(사례의 요청 메일)이 정한 조건이고, 견적서 작성 갈래는 그 반대("…요청하지
// 않았으면")라 무엇을 요청했을 때 가는지 읽히지 않는다. 관리자가 대화로 견적서 작성 갈래의 조건을 말한다.
// 그다음 고객 메일(연습 메일) 두 통이 들어오면 메일의 업무 범주로 이 프로세스가 시작되고, ProcessGPT 엔진
// (폴링 서비스)이 저장된 조건대로 갈래를 고른다:
//   교육 일정표 메일 → 견적서 작성,  온보딩 안내서 메일 → 제안서 작성
// 데모 메일함은 보내기가 없으므로 고객 회신까지는 보지 않는다.
//
// 로컬 Lite 를 ProcessGPT 게이트웨이 뒤(8088)에서, 폴링 서비스를 띄운 채로:
//   cd e2e && PGPT_URL=http://localhost:8088/lite npx playwright test tests/agent/mining-branch-run.spec.js --project=agent
// 시험 데이터(대화·확정·인스턴스)는 지우지 않는다.
import fs from 'node:fs'
import { test, expect } from '../../lib/fixtures.js'
import { waitFor } from '../../lib/agent.js'

const EDU = '요청 메일·견적서 작성'
const SHOTS = process.env.RT_SHOTS || ''
// 관리자가 말하는 조건 (같은 뜻 두 가지: 다시 돌릴 때 이미 그 조건이면 다른 말로 고친다 — 같은 말이면 시스템이
// "이미 그 조건"이라고 답하고 아무것도 바꾸지 않는 것이 맞다)
const QUOTE_WHENS = ['고객이 메일에서 교육 일정표를 엑셀 파일로 요청했으면', '고객이 메일에서 교육 일정표를 엑셀로 정리해 달라고 했으면']

test.describe.configure({ mode: 'serial' })

async function shot(page, name) {
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
async function say(page, text) {
  if (await page.locator('.dial').isVisible()) await page.locator('.dial').click()
  const before = await page.locator('.talk .msg.agent').count()
  await page.locator('.talk .say input').fill(text)
  await page.locator('.talk .say input').press('Enter')
  await expect(page.locator('.talk .msg.agent:not(:has(.shimmer-text))')).toHaveCount(before + 1, { timeout: 180_000 })
  return (await page.locator('.talk .msg.agent').last().innerText()).trim()
}

const rec = async (db, name) => (await db.q(`select * from pro_mining_suggestions where tenant_id=$1 and name=$2 and status='registered'`, [db.tenant, name]))[0]
const defOf = async (db, r) => (await db.q('select definition from proc_def where lower(id)=lower($1) and tenant_id=$2', [r.proc_def_id, db.tenant]))[0]?.definition
const versionsOf = async (db, r) => (await db.q('select version from proc_def_version where lower(proc_def_id)=lower($1) and tenant_id=$2', [r.proc_def_id, db.tenant])).length
const props = (s) => { try { return JSON.parse(s.properties || '{}') } catch { return {} } }
// 정의의 배타 분기마다 흐름 → { 단계(없으면 대상 id): 조건, 기본 흐름 여부 }
function splits(def) {
  const name = (id) => (def.activities || []).find((a) => a.id === id)?.name || id
  const out = {}
  for (const g of (def.gateways || []).filter((x) => /exclusive/i.test(x.type || ''))) {
    const o = (def.sequences || []).filter((s) => s.source === g.id)
    if (o.length < 2) continue
    out[g.id] = o.map((s) => ({ to: name(s.target), condition: s.condition || '', isDefault: props(s).default === true }))
  }
  return out
}
// 갈래를 고르는 분기(요청 메일 접수 바로 뒤)
const choiceOf = (def) => Object.values(splits(def)).find((fl) => fl.some((f) => f.to === '견적서 작성') && fl.some((f) => f.to === '제안서 작성'))

// 인스턴스가 시작 시점의 최신 저장 버전으로 도는지 — 엔진이 시작할 때 버전 하나를 찍어 두고 그 정의로 분기한다
// (version 이 텍스트라 '9.0' 을 최신으로 고르던 결함이 있었다: 관리자가 고친 조건이 실행에 쓰이지 않았다)
const latestArcv = async (db, defId) => (await db.q(`select arcv_id from proc_def_version where lower(proc_def_id)=lower($1) and tenant_id=$2
  and not coalesce(is_draft,false) order by "timeStamp" desc limit 1`, [defId, db.tenant]))[0]?.arcv_id
const pinnedArcv = (db, inst) => waitFor(async () => (await db.q('select proc_def_version from bpm_proc_inst where proc_inst_id=$1', [inst]))[0]?.proc_def_version || null,
  { timeout: 5 * 60_000, every: 5000 })

test('A-MN-11 관리자가 대화로 갈래 조건을 고치면, 다음 메일이 업무 범주로 등록 프로세스를 시작하고 엔진이 그 조건대로 간다', async ({ pageAs, db }) => {
  test.setTimeout(150 * 60_000)
  const page = await pageAs('mining-admin')
  const u = page.user
  // 준비: 이 시험 계정을 관리자로, 데모 메일함을 연결한다 (화면 밖의 계정 설정 — A-MN-10 과 같다)
  await db.q('update users set is_admin=true where id=$1 and tenant_id=$2', [u.id, db.tenant])
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
  const fixture = JSON.parse(fs.readFileSync(new URL('../../../server/fixtures/demo-mail.json', import.meta.url), 'utf8'))
  for (const m of fixture) await db.q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [u.id, m.id])
  const edu0 = await rec(db, EDU)
  test.skip(!edu0?.proc_def_id, `이 테넌트에 정식 등록된 '${EDU}' 가 있어야 함`)

  await test.step('인수조건 1: 정식 등록된 정의의 모든 분기 흐름에 조건이 있고 기본 흐름이 없다', async () => {
    const def = await defOf(db, edu0)
    for (const [g, fl] of Object.entries(splits(def))) {
      for (const f of fl) {
        expect(f.condition.trim(), `${g} → ${f.to} 조건`).not.toBe('')
        expect(f.isDefault, `${g} → ${f.to} 기본 흐름 아님`).toBe(false)
      }
    }
    await openRec(page, EDU)
    await shot(page, '1-교육-정의-분기-조건')
  })

  await test.step('인수조건 3: 관리자가 대화로 견적서 작성 갈래의 조건을 고치고, 새 버전으로 저장된다', async () => {
    const v0 = await versionsOf(db, edu0)
    const was = choiceOf(await defOf(db, edu0)).find((f) => f.to === '견적서 작성')?.condition || ''
    const QUOTE_WHEN = QUOTE_WHENS.find((x) => x !== was)
    const now = await say(page, '견적서 작성 갈래는 지금 어떤 조건이야?')
    expect(now).toMatch(/견적서 작성/)
    await shot(page, '2-교육-갈래-조건-물음')
    const done = await say(page, `견적서 작성 갈래는 ${QUOTE_WHEN} 가도록 조건을 바꿔 줘`)
    expect(done).toMatch(/견적서 작성[\s\S]*조건을 확정/)
    const choice = choiceOf(await defOf(db, edu0))
    const quote = choice.find((f) => f.to === '견적서 작성'), proposal = choice.find((f) => f.to === '제안서 작성')
    expect(quote.condition).toContain('교육 일정표')
    expect(quote.condition, '관리자의 말이 조건이다 (감싼 반대 조건이 아님)').not.toMatch(/^다음에 해당하지 않으면/)
    expect(proposal.condition.trim(), '제안서 작성 갈래에도 조건').not.toBe('')
    expect(await versionsOf(db, edu0)).toBe(v0 + 1)
    const r = await rec(db, EDU)
    expect(r.confirmed['견적서 작성']).toMatchObject({ kind: 'choice', by: 'admin' })
    test.info().annotations.push({ type: '갈래 조건', description: `견적서 작성: ${quote.condition} · 제안서 작성: ${proposal.condition}` })
    await page.reload()
    await page.locator('.reg .bpmn').scrollIntoViewIfNeeded().catch(() => {})
    await shot(page, '3-교육-갈래-조건-고침')
  })

  // 고객 메일이 들어온다 → 메일의 업무 범주로 등록 프로세스가 시작된다
  const arrive = async (template, subject) => {
    const t0 = new Date()
    const r = await u.post('/mail/demo-arrive', { template }, { timeout: 300_000 })
    expect(r.status, r.text).toBe(200)
    const run = await waitFor(async () => (await db.q(`select * from pro_mining_runs where suggestion_id=$1 and created_at >= $2 and mail->>'subject' = $3`, [edu0.id, t0, subject]))[0],
      { timeout: 10 * 60_000, every: 5000 })
    expect(run, `${subject} 메일로 '${EDU}' 인스턴스가 시작됨`).toBeTruthy()
    return run
  }
  let schedule, onboarding
  await test.step('인수조건 4: 교육 일정표·온보딩 안내서 메일이 업무 범주로 이 프로세스를 시작한다 (견적서·단가 같은 낱말이 없어도)', async () => {
    ;[schedule, onboarding] = await Promise.all([
      arrive('saebom-edu-schedule', '입사자 교육 일정표 부탁드립니다'),
      arrive('saebom-edu-onboarding', '신입 사원 온보딩 안내서 한 부 부탁드립니다'),
    ])
    test.info().annotations.push({ type: '인스턴스', description: `교육 일정표: ${schedule.proc_inst_id} · 온보딩: ${onboarding.proc_inst_id}` })
    // 관리자가 방금 고친 조건이 든 버전(최신 저장 버전)으로 돈다
    const latest = await latestArcv(db, edu0.proc_def_id)
    for (const r of [schedule, onboarding]) expect(await pinnedArcv(db, r.proc_inst_id), '관리자가 고친 최신 버전으로 실행').toBe(latest)
    test.info().annotations.push({ type: '실행 버전', description: latest })
    await page.goto('/chat')
    await shot(page, '4-메일-프로세스-시작')
  })

  // 폴링 서비스가 워크아이템을 처리한다. 엔진은 인스턴스를 만들 때 단계마다 워크아이템을 대기(TODO)로 미리 만들어
  // 두므로, 어느 갈래로 갔는지는 요청 메일 접수에 남은 분기 판정(gateway_decisions)과 실제로 시작된 단계로 본다
  const items = (inst) => db.q(`select activity_id, activity_name, status, user_id, gateway_decisions, start_date, end_date from todolist where proc_inst_id=$1 order by start_date`, [inst])
  const started = (x) => x && x.status !== 'TODO'
  const branchTaken = async (inst) => waitFor(async () => {
    const xs = await items(inst)
    const intake = xs.find((x) => x.activity_name === '요청 메일 접수')
    const d = Object.values(intake?.gateway_decisions || {})[0]
    if (!d?.selected?.length) return null
    const target = d.sequences[d.selected[0]]?.target
    const step = xs.find((x) => x.activity_id === target)
    return started(step) ? { step: step.activity_name, decision: d } : null
  }, { timeout: 20 * 60_000, every: 10_000 })

  await test.step('인수조건 2: 엔진(폴링 서비스)이 저장된 조건대로 갈래를 고른다 — 교육 일정표는 견적서 작성, 온보딩 안내서는 제안서 작성', async () => {
    const [a, b] = await Promise.all([branchTaken(schedule.proc_inst_id), branchTaken(onboarding.proc_inst_id)])
    const why = (r) => Object.values(r?.decision?.sequences || {}).map((x) => `${x.eval ? '참' : '거짓'}: ${x.condition} (${x.reason || ''})`).join(' / ')
    test.info().annotations.push({ type: '엔진 분기(교육 일정표)', description: `${a?.step} · ${why(a)}` })
    test.info().annotations.push({ type: '엔진 분기(온보딩)', description: `${b?.step} · ${why(b)}` })
    expect(a?.step).toBe('견적서 작성')
    expect(b?.step).toBe('제안서 작성')
    // 한 흐름만 참이고, 고르지 않은 갈래의 단계는 시작되지 않는다
    for (const r of [a, b]) expect(Object.values(r.decision.sequences).filter((x) => x.eval).length).toBe(1)
    expect(started((await items(schedule.proc_inst_id)).find((x) => x.activity_name === '제안서 작성'))).toBe(false)
    expect(started((await items(onboarding.proc_inst_id)).find((x) => x.activity_name === '견적서 작성'))).toBe(false)
  })

  await test.step('갈래의 에이전트 단계가 끝나고 인스턴스가 다음으로 나아간다 (견적서 작성 뒤 견적서 검토 분기 포함)', async () => {
    // 그 단계가 끝난 뒤: 인스턴스가 끝났거나, 다른 단계가 시작됐거나, 그 단계에 다음 분기 판정이 남았다
    const settled = async (inst, step) => waitFor(async () => {
      const xs = await items(inst)
      const s = xs.find((x) => x.activity_name === step)
      if (s?.status !== 'DONE') return null
      const [pi] = await db.q('select status from bpm_proc_inst where proc_inst_id=$1', [inst])
      const after = xs.filter((x) => x !== s && x.activity_name !== '요청 메일 접수' && started(x))
      const decided = s.gateway_decisions && Object.keys(s.gateway_decisions).length
      return pi?.status === 'COMPLETED' || after.length || decided ? { status: pi?.status, after: after.map((x) => `${x.activity_name}:${x.status}`), decisions: s.gateway_decisions } : null
    }, { timeout: 110 * 60_000, every: 15_000 })
    const [qa, pb] = await Promise.all([settled(schedule.proc_inst_id, '견적서 작성'), settled(onboarding.proc_inst_id, '제안서 작성')])
    test.info().annotations.push({ type: '교육 일정표 인스턴스', description: `${qa?.status} · 다음: ${(qa?.after || []).join(', ') || '없음'} · 판정: ${JSON.stringify(qa?.decisions || {}).slice(0, 600)}` })
    test.info().annotations.push({ type: '온보딩 인스턴스', description: `${pb?.status} · 다음: ${(pb?.after || []).join(', ') || '없음'}` })
    expect(qa, '견적서 작성이 끝나고 인스턴스가 다음 단계나 끝으로 감').toBeTruthy()
    expect(pb, '제안서 작성이 끝나고 인스턴스가 다음 단계나 끝으로 감').toBeTruthy()
    await page.goto('/chat')
    await shot(page, '5-인스턴스-진행')
  })
})
