// 분기의 모든 흐름에 조건 — 관리자 대화로 고친 조건이 다른 정식 등록 프로세스에서도 새 버전으로 저장되고 실행된다
// (2026-11-11, openspec intent-and-admin-boundary 결정 9). A-MN-11 은 '교육 일정표'의 택일 갈래를 고친다.
// 이 시험은 구성이 다른 두 프로세스의 옵션 단계를 관리자가 대화로 고친다:
//   행사 견적             — 계약 검토를 언제 건너뛰는지 (계약서 요청 여부)
//   인테리어 설계 견적    — 재무 검토를 언제 건너뛰는지 (견적 합계 5천만 원)
// 업무의 뜻은 그대로 두고 같은 뜻의 다른 말로 고친다(다시 돌릴 때는 다른 쪽 말로 — 같은 말이면 시스템이 "이미 그
// 조건"이라고 답하는 것이 맞다). 고친 뒤 고객 메일 한 통씩이 그 새 버전으로 실행되고 조건대로 가는지 본다.
//
//   cd e2e && PGPT_URL=http://localhost:8088/lite npx playwright test tests/agent/mining-branch-admin-others.spec.js --project=agent
// 시험 데이터(대화·확정·인스턴스)는 지우지 않는다.
import fs from 'node:fs'
import { test, expect } from '../../lib/fixtures.js'
import { waitFor } from '../../lib/agent.js'

const SHOTS = process.env.RT_SHOTS || ''
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

const rec = async (db, name) => (await db.q(`select s.* from pro_mining_suggestions s where s.tenant_id=$1 and s.name=$2 and s.status='registered'
  and exists (select 1 from proc_def d where lower(d.id)=lower(s.proc_def_id) and d.tenant_id=s.tenant_id) order by s.updated_at desc nulls last`, [db.tenant, name]))[0]
const recById = async (db, id) => (await db.q('select * from pro_mining_suggestions where id=$1', [id]))[0]
const defOf = async (db, defId) => (await db.q('select definition from proc_def where lower(id)=lower($1) and tenant_id=$2', [defId, db.tenant]))[0]?.definition
const versionsOf = async (db, defId) => (await db.q('select version from proc_def_version where lower(proc_def_id)=lower($1) and tenant_id=$2', [defId, db.tenant])).length
const latestArcv = async (db, defId) => (await db.q(`select arcv_id from proc_def_version where lower(proc_def_id)=lower($1) and tenant_id=$2
  and not coalesce(is_draft,false) order by "timeStamp" desc limit 1`, [defId, db.tenant]))[0]?.arcv_id
const pinnedArcv = (db, inst) => waitFor(async () => (await db.q('select proc_def_version from bpm_proc_inst where proc_inst_id=$1', [inst]))[0]?.proc_def_version || null,
  { timeout: 5 * 60_000, every: 5000 })
const nameOf = (def, id) => (def.activities || []).find((a) => a.id === id)?.name || id
// 옵션 단계 앞 배타 분기의 두 흐름: 그 단계로 가는 흐름과 건너뛰는 흐름
function optionalSplit(def, step) {
  const target = (def.activities || []).find((a) => a.name === step)?.id
  for (const g of (def.gateways || []).filter((x) => /exclusive/i.test(x.type || ''))) {
    const o = (def.sequences || []).filter((s) => s.source === g.id)
    const keep = o.find((s) => s.target === target)
    if (keep && o.length === 2) return { keep, skip: o.find((s) => s !== keep) }
  }
  return null
}

const PROCS = [
  {
    key: 'event', name: '행사 견적', step: '계약 검토',
    // 건너뛰는 조건 — 같은 뜻 두 말 (A-MN-10 이 보는 '계약서'는 남긴다)
    skips: ['고객이 메일에서 계약서를 요청하지 않았으면', '고객이 메일에서 계약서를 함께 보내 달라고 하지 않았으면'],
    word: /계약서/,
    mail: { from: '김다은 <daeun@hanbit-events.example>', subject: '송년회 다과 비용표와 계약서를 함께 보내 주세요',
      text: '안녕하세요, 한빛이벤트 김다은입니다. 12월 송년회(70명)에 쓸 다과·음료 비용을 품목별 수량과 단가, 합계가 보이는 엑셀 파일로 보내 주세요. 금액이 맞으면 바로 진행하려고 하니 용역 계약서도 함께 보내 주시면 좋겠습니다.' },
    after: '견적서 작성',
    expect: () => '계약 검토',
  },
  {
    key: 'design', name: '인테리어 설계 견적', step: '재무 검토',
    skips: ['견적 합계가 5천만 원 미만이면', '견적 합계가 5천만 원이 안 되면'],
    word: /5천만/,
    mail: { from: '한소율 <soyul.han@dalbit-coffee.example>', subject: '달빛커피 대형 매장 설계 제안 및 견적 요청',
      text: '안녕하세요, 달빛커피 운영팀 한소율입니다. 내년 봄 판교에 2개 층 대형 매장(층당 가로 28m × 세로 20m, 합계 약 1,120㎡)을 엽니다. 좌석 180석, 로스팅실, 원두 창고, 직원 휴게실, 화장실 3개가 필요하고 마감은 고급 원목으로 하려 합니다. 평면도와 설계 제안서, 인테리어 공사 견적서를 보내 주세요. 예산은 2억 5천만 원 규모입니다.' },
    after: '견적서 작성',
    // 기대 갈래는 그 인스턴스의 견적 합계와 저장된 기준(5천만 원)으로 정해진다
    expect: (amount) => (amount >= 50_000_000 ? '재무 검토' : '고객 회신'),
  },
]

test('A-MN-13 관리자가 대화로 행사 견적·설계 제안의 옵션 조건을 고치면 새 버전으로 저장되고, 다음 메일이 그 버전으로 조건대로 간다', async ({ pageAs, db }) => {
  test.setTimeout(150 * 60_000)
  const page = await pageAs('mining-admin')
  const u = page.user
  await db.q('update users set is_admin=true where id=$1 and tenant_id=$2', [u.id, db.tenant])
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
  const fixture = JSON.parse(fs.readFileSync(new URL('../../../server/fixtures/demo-mail.json', import.meta.url), 'utf8'))
  for (const m of fixture) await db.q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [u.id, m.id])
  const recs = {}
  for (const p of PROCS) {
    recs[p.key] = await rec(db, p.name)
    expect(recs[p.key]?.proc_def_id, `이 테넌트에 정의가 저장된 '${p.name}' 가 있어야 함`).toBeTruthy()
  }

  for (const p of PROCS) {
    await test.step(`인수조건 3·6: ${p.name} — 관리자가 대화로 ${p.step} 조건을 고치고, 새 버전으로 저장된다`, async () => {
      const r0 = recs[p.key], defId = r0.proc_def_id
      const v0 = await versionsOf(db, defId)
      const was = optionalSplit(await defOf(db, defId), p.step)
      expect(was, `${p.name} 에 ${p.step} 앞 분기가 있음`).toBeTruthy()
      const SKIP = p.skips.find((x) => x !== was.skip.condition)
      await openRec(page, p.name)
      const now = await say(page, `${p.step}는 지금 언제 건너뛰어?`)
      expect(now).toContain(p.step)
      await shot(page, `${p.key}-1-조건-물음`)
      const done = await say(page, `${p.step}는 ${SKIP} 건너뛰도록 조건을 바꿔 줘`)
      test.info().annotations.push({ type: `${p.name} 답`, description: done.slice(0, 300) })
      expect(done).toMatch(new RegExp(`${p.step}[\\s\\S]*(배타 게이트웨이|조건을 확정|새 버전)`))
      const sp = optionalSplit(await defOf(db, defId), p.step)
      expect(sp.skip.condition, '건너뛰는 흐름은 관리자가 말한 조건').toMatch(p.word)
      expect(sp.skip.condition, '관리자가 말한 조건으로 바뀜').not.toBe(was.skip.condition)
      expect(sp.keep.condition.trim(), `${p.step} 로 가는 흐름에도 조건`).not.toBe('')
      expect(sp.keep.condition, '반대 조건은 업무 말 (감싼 꼴이 아님)').not.toMatch(/^다음에 해당하지 않으면/)
      expect(await versionsOf(db, defId), '새 버전 하나').toBe(v0 + 1)
      const r = await recById(db, r0.id)
      expect(r.confirmed[p.step]).toMatchObject({ kind: 'optional', by: 'admin' })
      p.saved = sp.skip.condition
      test.info().annotations.push({ type: `${p.name} 조건`, description: `건너뜀: ${sp.skip.condition} · ${p.step}: ${sp.keep.condition}` })
      await page.reload()
      await page.locator('.reg .bpmn').scrollIntoViewIfNeeded().catch(() => {})
      await shot(page, `${p.key}-2-조건-고침-정의`)
    })
  }

  // 고친 뒤 고객 메일 한 통씩 → 범주로 시작 → 관리자가 고친 새 버전으로 실행 → 조건대로
  const runs = []
  await test.step('인수조건 5: 고친 뒤 들어온 메일이 그 새 버전으로 실행된다', async () => {
    for (const p of PROCS) {
      const t0 = new Date()
      const r = await u.post('/mail/demo-arrive', p.mail, { timeout: 300_000 })
      expect(r.status, r.text).toBe(200)
      const run = await waitFor(async () => (await db.q(`select * from pro_mining_runs where created_at >= $1 and mail->>'subject' = $2`, [t0, p.mail.subject]))[0],
        { timeout: 10 * 60_000, every: 5000 })
      expect(run, `'${p.mail.subject}' 메일로 인스턴스가 시작됨`).toBeTruthy()
      expect(run.suggestion_id).toBe(recs[p.key].id)
      expect(await pinnedArcv(db, run.proc_inst_id), `${p.name}: 관리자가 고친 최신 버전으로 실행`).toBe(await latestArcv(db, recs[p.key].proc_def_id))
      runs.push({ p, inst: run.proc_inst_id })
      test.info().annotations.push({ type: `${p.name} 인스턴스`, description: run.proc_inst_id })
    }
  })

  const items = (inst) => db.q(`select activity_id, activity_name, status, output, gateway_decisions from todolist where proc_inst_id=$1 order by start_date`, [inst])
  const started = (x) => x && x.status !== 'TODO'
  const amountOf = (x) => Number(String(Object.values(x?.output || {})[0]?.amount ?? '').replace(/[^\d.]/g, '')) || null
  const branchTaken = (inst, before) => waitFor(async () => {
    const xs = await items(inst)
    const at = xs.find((x) => x.activity_name === before)
    const d = Object.values(at?.gateway_decisions || {})[0]
    if (!d?.selected?.length) return null
    const def = await defOf(db, inst.split('.')[0])
    const target = d.sequences[d.selected[0]]?.target
    return started(xs.find((x) => x.activity_id === target)) ? { step: nameOf(def, target), decision: d, amount: amountOf(at) } : null
  }, { timeout: 120 * 60_000, every: 15_000 })

  await test.step('인수조건 5: 엔진이 관리자가 고친 조건으로 참인 흐름 하나로 간다', async () => {
    const got = await Promise.all(runs.map((r) => branchTaken(r.inst, r.p.after)))
    got.forEach((g, i) => {
      const { p, inst } = runs[i]
      const why = Object.values(g?.decision?.sequences || {}).map((x) => `${x.eval ? '참' : '거짓'}: ${x.condition}`).join(' / ')
      test.info().annotations.push({ type: `엔진 분기(${p.name})`, description: `${g?.step} · 견적 합계 ${g?.amount ?? '-'} · ${why}` })
      expect(g, `${p.name}: 갈래가 정해짐 (${inst})`).toBeTruthy()
      expect(g.step).toBe(p.expect(g.amount))
      expect(Object.values(g.decision.sequences).filter((x) => x.eval).length, '참인 흐름은 하나').toBe(1)
      // 판정에 쓰인 조건이 관리자가 방금 고쳐 저장한 그 문장이다
      expect(Object.values(g.decision.sequences).map((x) => x.condition), '관리자가 고친 조건으로 판정').toContain(p.saved)
    })
  })
})
