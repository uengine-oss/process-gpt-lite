// 분기의 모든 흐름에 조건 — 다른 정식 등록 프로세스에서도 엔진이 저장된 조건대로 갈래를 고른다 (2026-11-11,
// openspec intent-and-admin-boundary 결정 9·10). A-MN-11 은 '교육 일정표' 한 프로세스만 본다.
// 이 시험은 구성이 다른 두 프로세스를 같은 흐름으로 끝까지 돌린다:
//   행사 견적             — 견적서 작성 뒤 분기: 고객이 메일에서 계약서를 요청했는지 (메일 내용으로 정해짐)
//   인테리어 설계 견적    — 평면도·제안서·견적서 작성 뒤 분기: 견적 합계가 5천만 원 이상인지 (에이전트가 만든 합계로 정해짐)
// 갈래마다 고객 메일(데모 메일함) 한 통씩 보낸다. 메일의 업무 범주로 프로세스가 시작되고, 폴링 서비스가
// 에이전트 단계를 처리한 뒤 분기에서 참인 흐름 하나로 간다. 견적 합계 갈래의 기대값은 시험이 정하지 않는다
// — 그 인스턴스의 견적서 작성 결과(amount)와 저장된 기준으로 정해진다.
// 데모 메일함은 보내기가 없으므로 고객 회신은 시작됐는지만 본다.
//
//   cd e2e && PGPT_URL=http://localhost:8088/lite npx playwright test tests/agent/mining-branch-run-others.spec.js --project=agent
// 시험 데이터(인스턴스)는 지우지 않는다.
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

// 같은 이름이 둘 이상 등록돼 있을 수 있다 — 정의가 저장된 것(실제로 메일을 맡는 것)
const rec = async (db, name) => (await db.q(`select s.* from pro_mining_suggestions s where s.tenant_id=$1 and s.name=$2 and s.status='registered'
  and exists (select 1 from proc_def d where lower(d.id)=lower(s.proc_def_id) and d.tenant_id=s.tenant_id) order by s.updated_at desc nulls last`, [db.tenant, name]))[0]
const defOf = async (db, r) => (await db.q('select definition from proc_def where lower(id)=lower($1) and tenant_id=$2', [r.proc_def_id, db.tenant]))[0]?.definition
const props = (s) => { try { return JSON.parse(s.properties || '{}') } catch { return {} } }
const nameOf = (def, id) => (def.activities || []).find((a) => a.id === id)?.name || id
function splits(def) {
  const out = {}
  for (const g of (def.gateways || []).filter((x) => /exclusive/i.test(x.type || ''))) {
    const o = (def.sequences || []).filter((s) => s.source === g.id)
    if (o.length < 2) continue
    out[g.id] = o.map((s) => ({ to: nameOf(def, s.target), condition: s.condition || '', isDefault: props(s).default === true }))
  }
  return out
}

// 인스턴스가 시작 시점의 최신 저장 버전으로 도는지 — 엔진이 시작할 때 버전 하나를 찍어 두고 그 정의로 분기한다
// (version 이 텍스트라 '9.0' 을 최신으로 고르던 결함이 있었다: 관리자가 고친 조건이 실행에 쓰이지 않았다)
const latestArcv = async (db, defId) => (await db.q(`select arcv_id from proc_def_version where lower(proc_def_id)=lower($1) and tenant_id=$2
  and not coalesce(is_draft,false) order by "timeStamp" desc limit 1`, [defId, db.tenant]))[0]?.arcv_id
const pinnedArcv = (db, inst) => waitFor(async () => (await db.q('select proc_def_version from bpm_proc_inst where proc_inst_id=$1', [inst]))[0]?.proc_def_version || null,
  { timeout: 5 * 60_000, every: 5000 })

const PROCS = [
  {
    name: '행사 견적', key: 'event', after: '견적서 작성',
    mails: [
      { tag: '계약서 요청', expect: () => '계약 검토', from: '김다은 <daeun@hanbit-events.example>',
        subject: '송년회 다과 비용표와 계약서 함께 부탁드립니다',
        text: '안녕하세요, 한빛이벤트 김다은입니다. 12월 송년회(80명)에 쓸 다과·음료 비용을 품목별 수량과 단가, 합계가 보이는 엑셀 파일로 보내 주세요. 금액이 맞으면 바로 진행하려고 하니 용역 계약서도 함께 보내 주시면 좋겠습니다.' },
      { tag: '계약서 요청 없음', expect: () => '고객 회신', from: '김다은 <daeun@hanbit-events.example>',
        subject: '신년회 다과 비용표 부탁드립니다',
        text: '안녕하세요, 한빛이벤트 김다은입니다. 1월 신년회(60명)에 쓸 다과·음료 비용을 품목별 수량과 단가, 합계가 보이는 엑셀 파일로 보내 주실 수 있을까요? 다음 주 수요일까지 받으면 좋겠습니다.' },
    ],
  },
  {
    name: '인테리어 설계 견적', key: 'design', after: '견적서 작성',
    // 저장된 조건(견적 합계가 5천만 원 이상이면 재무 검토)과 그 인스턴스의 견적 합계로 기대 갈래가 정해진다
    mails: [
      { tag: '작은 매장', expect: (amount) => (amount >= 50_000_000 ? '재무 검토' : '고객 회신'), from: '한소율 <soyul.han@dalbit-coffee.example>',
        subject: '달빛커피 테이크아웃 키오스크 매장 설계 제안 및 견적 요청',
        text: '안녕하세요, 달빛커피 운영팀 한소율입니다. 지하철역 안에 테이크아웃 전용 소형 매장(가로 4m × 세로 3m, 약 12㎡)을 내려고 합니다. 주문·제조 바와 작은 원두 보관장만 있으면 됩니다. 평면도와 설계 제안서, 인테리어 공사 견적서를 보내 주세요. 예산은 2천만 원 안쪽으로 생각하고 있습니다.' },
      { tag: '큰 매장', expect: (amount) => (amount >= 50_000_000 ? '재무 검토' : '고객 회신'), from: '한소율 <soyul.han@dalbit-coffee.example>',
        subject: '달빛커피 플래그십 매장 설계 제안 및 견적 요청',
        text: '안녕하세요, 달빛커피 운영팀 한소율입니다. 내년 하반기 강남에 2개 층 플래그십 매장(층당 가로 30m × 세로 22m, 합계 약 1,320㎡)을 엽니다. 좌석 220석, 로스팅실, 교육장, 원두 창고, 직원 휴게실, 화장실 4개가 필요하고 마감은 고급 원목·석재로 하려 합니다. 평면도와 설계 제안서, 인테리어 공사 견적서를 보내 주세요. 예산은 3억 원 규모입니다.' },
    ],
  },
]

test('A-MN-12 다른 정식 등록 프로세스(행사 견적·설계 제안)도 메일 범주로 시작되고, 엔진이 저장된 조건대로 갈래를 고른다', async ({ pageAs, db }) => {
  test.setTimeout(240 * 60_000)
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

  await test.step('인수조건 1: 두 프로세스 정의의 모든 분기 흐름에 조건이 있고 기본 흐름이 없다', async () => {
    for (const p of PROCS) {
      const def = await defOf(db, recs[p.key])
      const sp = splits(def)
      expect(Object.keys(sp).length, `${p.name} 에 분기가 있음`).toBeGreaterThan(0)
      for (const [g, fl] of Object.entries(sp)) {
        test.info().annotations.push({ type: `${p.name} 분기`, description: fl.map((f) => `→ ${f.to}: ${f.condition}`).join(' / ') })
        for (const f of fl) {
          expect(f.condition.trim(), `${p.name} ${g} → ${f.to} 조건`).not.toBe('')
          expect(f.isDefault, `${p.name} ${g} → ${f.to} 기본 흐름 아님`).toBe(false)
        }
      }
      await page.goto('/mining')
      await page.locator('.row', { hasText: p.name }).first().click()
      await expect(page.locator('.hero h1')).toHaveText(p.name, { timeout: 30_000 })
      await page.locator('.reg .bpmn').scrollIntoViewIfNeeded().catch(() => {})
      await shot(page, `1-${p.key}-정의-분기-조건`)
    }
  })

  // 고객 메일이 도착 → 메일의 업무 범주로 그 프로세스가 시작된다 (도착은 차례로: 같은 메일함을 한 번에 여러 번 읽지 않게)
  const runs = []
  await test.step('인수조건 4: 갈래마다 보낸 메일이 업무 범주로 그 프로세스를 시작한다', async () => {
    for (const p of PROCS) for (const m of p.mails) {
      const t0 = new Date()
      const r = await u.post('/mail/demo-arrive', { from: m.from, subject: m.subject, text: m.text }, { timeout: 300_000 })
      expect(r.status, r.text).toBe(200)
      const run = await waitFor(async () => (await db.q(`select * from pro_mining_runs where created_at >= $1 and mail->>'subject' = $2`, [t0, m.subject]))[0],
        { timeout: 10 * 60_000, every: 5000 })
      expect(run, `'${m.subject}' 메일로 인스턴스가 시작됨`).toBeTruthy()
      const [s] = await db.q('select name from pro_mining_suggestions where id=$1', [run.suggestion_id])
      expect(s?.name, `'${m.subject}' 는 '${p.name}' 로 시작됨`).toBe(p.name)
      runs.push({ p, m, inst: run.proc_inst_id })
      expect(await pinnedArcv(db, run.proc_inst_id), `${p.name} · ${m.tag}: 최신 저장 버전으로 실행`).toBe(await latestArcv(db, recs[p.key].proc_def_id))
      test.info().annotations.push({ type: '인스턴스', description: `${p.name} · ${m.tag}: ${run.proc_inst_id}` })
    }
    await page.goto('/chat')
    await shot(page, '2-메일-프로세스-시작')
  })

  // 엔진이 단계마다 워크아이템을 대기(TODO)로 미리 만들어 두므로, 갈래는 분기 앞 단계에 남은 판정과 실제로 시작된 단계로 본다
  const items = (inst) => db.q(`select activity_id, activity_name, status, draft_status, output, gateway_decisions from todolist where proc_inst_id=$1 order by start_date`, [inst])
  const started = (x) => x && x.status !== 'TODO'
  const amountOf = (x) => Number(String(Object.values(x?.output || {})[0]?.amount ?? '').replace(/[^\d.]/g, '')) || null
  const branchTaken = (inst, before) => waitFor(async () => {
    const xs = await items(inst)
    const at = xs.find((x) => x.activity_name === before)
    const d = Object.values(at?.gateway_decisions || {})[0]
    if (!d?.selected?.length) return null
    const def = await defOf(db, { proc_def_id: inst.split('.')[0] })
    const target = d.sequences[d.selected[0]]?.target
    const step = xs.find((x) => x.activity_id === target)
    return started(step) ? { step: nameOf(def, target), decision: d, amount: amountOf(at), xs } : null
  }, { timeout: 200 * 60_000, every: 15_000 })

  await test.step('인수조건 2: 에이전트 단계가 끝나고, 엔진이 저장된 조건대로 참인 흐름 하나로 간다', async () => {
    const got = await Promise.all(runs.map((r) => branchTaken(r.inst, r.p.after)))
    const sides = {}
    got.forEach((g, i) => {
      const { p, m, inst } = runs[i]
      const why = Object.values(g?.decision?.sequences || {}).map((x) => `${x.eval ? '참' : '거짓'}: ${x.condition} (${x.reason || ''})`).join(' / ')
      test.info().annotations.push({ type: `엔진 분기(${p.name} · ${m.tag})`, description: `${g?.step} · 견적 합계 ${g?.amount ?? '-'} · ${why}` })
      expect(g, `${p.name} · ${m.tag}: ${p.after} 뒤 갈래가 정해짐 (${inst})`).toBeTruthy()
      expect(g.step, `${p.name} · ${m.tag}`).toBe(m.expect(g.amount))
      expect(Object.values(g.decision.sequences).filter((x) => x.eval).length, '참인 흐름은 하나').toBe(1)
      // 고르지 않은 갈래의 단계는 시작되지 않는다
      for (const s of Object.values(g.decision.sequences).filter((x) => !x.eval)) {
        expect(started(g.xs.find((x) => x.activity_id === s.target)), `${p.name} · ${m.tag}: 고르지 않은 갈래`).toBeFalsy()
      }
      ;(sides[p.key] ||= new Set()).add(g.step)
    })
    // 두 갈래를 모두 지났는지 (견적 합계 갈래는 에이전트가 만든 합계에 달렸으므로 기록만 엄격히 하지 않는다)
    for (const p of PROCS) {
      test.info().annotations.push({ type: `${p.name} 지난 갈래`, description: [...(sides[p.key] || [])].join(', ') })
      expect.soft(sides[p.key]?.size, `${p.name} 의 두 갈래를 모두 지남`).toBe(2)
    }
    await page.goto('/chat')
    await shot(page, '3-인스턴스-갈래-진행')
  })
})
