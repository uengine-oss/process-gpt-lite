// 업무 흐름이 정하지 못한 분기는 관리자에게 묻고, 확정 전에는 정의에 저장되지 않는다 (2026-11-11, openspec
// intent-and-admin-boundary 결정 9, tasks 16.5).
//
// 실제 관리자가 일하는 그대로 사례를 쌓는다: 데모 메일함에 새 업무(사무실 이전 비용 견적) 메일 다섯 통이 온다.
// 메일마다 에이전트가 견적서 초안을 만들고, 담당자는 그중 몇 건만 재무 담당에게 검토를 부탁한 뒤(공유) 회신 카드를
// 실행한다. 어느 건을 검토에 돌릴지는 담당자가 그때그때 정한다 — 메일 내용만으로 다 설명되지 않는다.
// 사례가 쌓이면 프로세스 마이닝이 추천을 만들고, 검토 단계 앞 분기를 업무 흐름으로 판정한다. 모든 사례를
// 가르지 못하면 정하지 않은 분기로 남아 관리자에게 묻는다(초안이 있으면 맞은 건수와 함께, 없으면 "초안 없음").
// 관리자는 확인 필요에서 "초안대로" 한 번으로, 초안이 없으면 대화로 조건을 말해 확정한다.
//
//   cd e2e && PGPT_URL=http://localhost:8088/lite npx playwright test tests/agent/mining-undecided-admin.spec.js --project=agent
// 시험 데이터(메일·사례·추천·대화)는 지우지 않는다.
import fs from 'node:fs'
import { test, expect } from '../../lib/fixtures.js'
import { waitFor } from '../../lib/agent.js'

const SHOTS = process.env.RT_SHOTS || ''
// 검토 단계 이름은 공유한 문서가 정한다(견적서 → '견적서 검토', lib/mining/catalog.js docReview) — 사례에 기록된 이름을 쓴다
let STEP = ''
test.describe.configure({ mode: 'serial' })

async function shot(page, name) {
  await page.waitForTimeout(1200)
  const body = await page.screenshot({ fullPage: false })
  await test.info().attach(name, { body, contentType: 'image/png' })
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(`${SHOTS}/${name}.png`, body) }
}
async function say(page, text) {
  if (await page.locator('.dial').isVisible()) await page.locator('.dial').click()
  const before = await page.locator('.talk .msg.agent').count()
  await page.locator('.talk .say input').fill(text)
  await page.locator('.talk .say input').press('Enter')
  await expect(page.locator('.talk .msg.agent:not(:has(.shimmer-text))')).toHaveCount(before + 1, { timeout: 180_000 })
  return (await page.locator('.talk .msg.agent').last().innerText()).trim()
}
// 저장될 정의에서 그 단계 앞 배타 분기의 흐름들 — 정식 등록 전 미리보기(GET /mining/suggestions/:id/bpmn)가 돌려주는
// BPMN 은 등록 때 저장될 그대로다(관리자 확정과 업무 흐름 조건이 적용됨, 아무것도 저장하지 않음)
const attrs = (t) => Object.fromEntries([...t.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
function bpmnSplit(xml, step) {
  const id = [...xml.matchAll(/<bpmn:(\w+) ([^>]*)>/g)].map((m) => attrs(m[2])).find((a) => a.name === step && a.id)?.id
  const flows = [...xml.matchAll(/<bpmn:sequenceFlow ([^>]*?)(?:\/>|>([\s\S]*?)<\/bpmn:sequenceFlow>)/g)].map((m) => {
    const a = attrs(m[1]); let cond = a.name || ''
    try { cond = JSON.parse((m[2] || '').match(/<uengine:json>([\s\S]*?)<\/uengine:json>/)?.[1] || '{}').condition ?? cond } catch { /* name 만 */ }
    return { source: a.sourceRef, target: a.targetRef, condition: cond || '' }
  })
  const gw = flows.find((f) => f.target === id && /gw|gateway/i.test(f.source))?.source
  if (!gw) return null
  return flows.filter((f) => f.source === gw).map((f) => ({ to: f.target === id ? step : f.target, condition: f.condition }))
}

// 한결물류 사무실 이전 — 직원 수가 다른 다섯 건. 검토에 돌린 건은 담당자의 그때 판단
const FROM = '정하린 <harin@hangyeol-logis.example>'
const MAILS = [
  { n: 12, review: true }, { n: 25, review: true }, { n: 40, review: false }, { n: 60, review: true }, { n: 90, review: false },
].map((x, i) => ({
  ...x,
  subject: `[한결물류] ${['성수', '문정', '가산', '판교', '마곡'][i]} 사무실 이전 비용 견적 요청 (직원 ${x.n}명)`,
  text: `안녕하세요, 한결물류 총무팀 정하린입니다. ${['성수', '문정', '가산', '판교', '마곡'][i]} 사무실(직원 ${x.n}명)을 다음 달에 옮기려 합니다. 사무 가구·PC·서류함 운반과 포장, 새 사무실 배치까지 포함한 이전 비용을 품목별 수량·단가·합계가 보이는 엑셀 견적서로 보내 주세요.`,
}))

test('A-MN-14 업무 흐름이 정하지 못한 분기는 관리자에게 묻고, 확정 전에는 정의에 없으며, 초안대로 또는 대화로 확정된다', async ({ pageAs, as, db }) => {
  test.setTimeout(150 * 60_000)
  const page = await pageAs('mining-admin')
  const u = page.user
  const fin = await as('mining-finance')
  await u.get('/team'); await fin.get('/team')
  await db.q('update users set is_admin=true where id=$1 and tenant_id=$2', [u.id, db.tenant])
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo'`, [u.id, u.email])
  const fixture = JSON.parse(fs.readFileSync(new URL('../../../server/fixtures/demo-mail.json', import.meta.url), 'utf8'))
  for (const m of fixture) await db.q('insert into pro_mail_seen values ($1,$2) on conflict do nothing', [u.id, m.id])
  const th = await db.mainThreadId(u.id)

  // 사례 하나: 메일 → 견적서 초안 → (검토 공유) → 회신 카드 실행 → 사례가 닫히고 업무 범주가 정해진다
  const cases = []
  await test.step('사례 다섯 건: 메일마다 초안 → 일부만 검토 공유 → 회신', async () => {
    for (const m of MAILS) {
      // 앞선 실행이 이미 닫은 같은 사례는 이어서 쓴다(시험 데이터를 지우지 않으므로 같은 메일을 또 보내지 않는다)
      const [prev] = await db.q(`select c.case_id from pro_mining_cases c where c.user_id=$1 and c.subject=$2 and c.category is not null
        and exists (select 1 from handover_events h where h.case_id=c.case_id and h.norm_activity_label='고객 회신') order by c.created_at desc limit 1`, [u.id, m.subject])
      if (prev) {
        const steps = (await db.q(`select norm_activity_label l from handover_events where case_id=$1 order by occurred_at`, [prev.case_id])).map((x) => x.l)
        cases.push({ ...m, caseId: prev.case_id, steps })
        test.info().annotations.push({ type: `사례 직원 ${m.n}명 (이어 씀)`, description: steps.join(' → ') })
        continue
      }
      const t0 = new Date()
      const r = await u.post('/mail/demo-arrive', { from: FROM, subject: m.subject, text: m.text }, { timeout: 300_000 })
      expect(r.status, r.text).toBe(200)
      const mail = await waitFor(async () => (await db.q('select mail_id from pro_demo_mail where user_id=$1 and subject=$2 and created_at >= $3', [u.id, m.subject, t0]))[0], { timeout: 60_000, every: 2000 })
      const files = await waitFor(async () => {
        const xs = await db.q(`select id, content->>'name' as name from pro_messages where thread_id=$1 and kind='file' and content->>'mail_id'=$2`, [th, mail.mail_id])
        return xs.length ? xs : null
      }, { timeout: 15 * 60_000, every: 10_000 })
      expect(files, `${m.subject}: 견적서 초안`).toBeTruthy()
      if (m.review) {
        const s = await u.post('/team/share', { to: [{ type: 'user', id: fin.id }], messageIds: files.map((f) => f.id), note: '재무 검토 부탁드립니다. 단가와 합계 확인해 주세요.' })
        expect(s.status, s.text).toBe(200)
      }
      const [action] = await db.q(`select id from pro_actions where user_id=$1 and verb='Review' and source->>'mail_id'=$2`, [u.id, mail.mail_id])
      expect(action, `${m.subject}: 회신 카드`).toBeTruthy()
      expect((await u.post(`/actions/${action.id}/run`)).status).toBe(200)
      const caseId = await waitFor(async () => (await db.q(`select c.case_id from pro_mining_cases c where c.mail_id=$1 and c.category is not null
        and exists (select 1 from handover_events h where h.case_id=c.case_id and h.norm_activity_label='고객 회신')`, [mail.mail_id]))[0]?.case_id, { timeout: 15 * 60_000, every: 10_000 })
      expect(caseId, `${m.subject}: 사례가 닫힘`).toBeTruthy()
      const steps = (await db.q(`select norm_activity_label l from handover_events where case_id=$1 order by occurred_at`, [caseId])).map((x) => x.l)
      cases.push({ ...m, caseId, steps })
      test.info().annotations.push({ type: `사례 직원 ${m.n}명`, description: steps.join(' → ') })
    }
    // 검토를 돌린 사례에 기록된 검토 단계 — 돌리지 않은 사례에는 없다
    const reviewed = cases.filter((c) => c.review).map((c) => c.steps.find((l) => /검토$/.test(l)))
    STEP = reviewed[0]
    expect(STEP, '검토 단계가 기록됨').toBeTruthy()
    expect(reviewed.every((l) => l === STEP)).toBe(true)
    for (const c of cases.filter((x) => !x.review)) expect(c.steps).not.toContain(STEP)
    test.info().annotations.push({ type: '검토 단계', description: STEP })
    const [c] = await db.q('select category from pro_mining_cases where case_id=$1', [cases[0].caseId])
    test.info().annotations.push({ type: '업무 범주', description: c.category })
  })

  // 프로세스 마이닝이 그 사례들로 추천을 만들고, 검토 단계 앞 분기를 판정한다
  let s
  await test.step('추천이 생기고, 업무 흐름이 정하지 못한 검토 분기가 확인 필요로 남는다', async () => {
    const ids = cases.map((c) => c.caseId)
    const row = await waitFor(async () => (await db.q(`select id from pro_mining_suggestions where tenant_id=$1 and status='suggested'
      and (pattern->'case_ids') ?| $2::text[]`, [db.tenant, ids]))[0], { timeout: 20 * 60_000, every: 15_000 })
    expect(row, '사례들로 추천이 생김').toBeTruthy()
    s = await waitFor(async () => {
      const x = (await u.get(`/mining/suggestions/${row.id}`)).body
      return (x?.undecided || []).some((d) => d.step === STEP) || ['cases', 'admin'].includes(x?.confirmed?.[STEP]?.by) ? x : null
    }, { timeout: 10 * 60_000, every: 15_000 })
    expect(s, `${STEP} 분기가 판정됨`).toBeTruthy()
    test.info().annotations.push({ type: '추천', description: `${s.name} · ${row.id}` })
    // 업무 흐름이 모든 사례를 갈랐다면 관리자에게 묻지 않는다 — 이 시험이 볼 분기가 아니다
    test.skip(s.confirmed?.[STEP]?.by === 'cases', `업무 흐름이 ${STEP}를 모든 사례로 갈랐다: ${s.confirmed?.[STEP]?.skip_when || ''}`)
  })

  // 앞선 실행(같은 사례)이 이미 관리자 확정까지 했으면 확정 전 상태는 다시 만들 수 없다 — 확정 뒤 상태만 본다
  const already = s.confirmed?.[STEP]?.by === 'admin'
  if (already) test.info().annotations.push({ type: '앞선 실행에서 확정됨', description: JSON.stringify(s.confirmed[STEP]) })
  const ask = () => s.undecided.find((d) => d.step === STEP)
  if (!already) await test.step('확인 필요에 질문과 초안(맞은 건수) 또는 "초안 없음"이 보이고, 확정 전에는 정의에 조건이 없다', async () => {
    const x = ask()
    test.info().annotations.push({ type: '질문', description: JSON.stringify(x) })
    expect(x.need).toBe('skip')
    // 확정 전: 관리자 확정이 없고, 그려질 정의의 검토 분기에 조건 없는 흐름이 남아 있다
    expect(s.confirmed?.[STEP]?.by).not.toBe('admin')
    const pv = await u.get(`/mining/suggestions/${s.id}/bpmn`)
    expect(pv.status, '미리보기').toBe(200)
    const sp = bpmnSplit(String(pv.text || pv.body || ''), STEP)
    expect(sp, `${STEP} 앞 분기`).toBeTruthy()
    expect(sp.some((f) => !f.condition.trim()), '확정 전에는 조건 없는 흐름이 남음').toBe(true)
    test.info().annotations.push({ type: '확정 전 분기', description: sp.map((f) => `→ ${f.to}: ${f.condition || '(조건 없음)'}`).join(' / ') })
    await page.goto(`/mining/${s.id}`)
    await expect(page.locator('.hero h1')).toHaveText(s.name, { timeout: 30_000 })
    const rowEl = page.locator('.undecided .urow', { hasText: STEP })
    await expect(rowEl).toBeVisible()
    await expect(rowEl).toContainText('언제 건너뛰나요')
    if (x.draft) {
      await expect(rowEl).toContainText(`초안: ${x.draft}`)
      await expect(rowEl).toContainText(`사례 ${x.total}건 중 ${x.matched}건 맞음`)
      await expect(rowEl.getByRole('button', { name: '초안대로' })).toBeVisible()
    } else {
      await expect(rowEl).toContainText('초안 없음')
      await expect(rowEl.getByRole('button', { name: '초안대로' })).toHaveCount(0)
    }
    await expect(page.locator('.decide .go')).toBeDisabled()
    await rowEl.scrollIntoViewIfNeeded()
    await shot(page, '1-확인-필요-질문')
  })

  await test.step('관리자가 확정한다 — 초안이 있으면 "초안대로" 한 번, 없으면 대화로 — 그때 정의에 들어간다', async () => {
    const x = already ? { draft: null } : ask()
    const rowEl = page.locator('.undecided .urow', { hasText: STEP })
    let said
    if (already) {
      await page.goto(`/mining/${s.id}`)
      await expect(page.locator('.hero h1')).toHaveText(s.name, { timeout: 30_000 })
    } else if (x.draft) {
      await rowEl.getByRole('button', { name: '초안대로' }).click()
      said = x.draft
    } else {
      // 관리자의 판단: 이 업무에서 검토를 언제 건너뛰는지
      said = '직원이 30명 미만인 사무실 이전이면'
      const done = await say(page, `${STEP}는 ${said} 건너뛰어`)
      test.info().annotations.push({ type: '대화 답', description: done.slice(0, 300) })
    }
    s = await waitFor(async () => {
      const y = (await u.get(`/mining/suggestions/${s.id}`)).body
      return y?.confirmed?.[STEP]?.by === 'admin' ? y : null
    }, { timeout: 5 * 60_000, every: 3000 })
    expect(s, '관리자 확정으로 저장').toBeTruthy()
    expect(s.confirmed[STEP]).toMatchObject({ kind: 'optional', by: 'admin' })
    if (x.draft) expect(s.confirmed[STEP].skip_when).toBe(x.draft)
    expect((s.undecided || []).some((d) => d.step === STEP), '확인 필요에서 빠짐').toBe(false)
    // 정의: 모든 흐름에 조건, 기본 흐름 없음, 반대쪽은 업무 말
    const pv = await u.get(`/mining/suggestions/${s.id}/bpmn`)
    expect(pv.status, '미리보기').toBe(200)
    const sp = bpmnSplit(String(pv.text || pv.body || ''), STEP)
    expect(sp, `${STEP} 앞 분기`).toBeTruthy()
    for (const f of sp) {
      expect(f.condition.trim(), `→ ${f.to} 조건`).not.toBe('')
      expect(f.condition).not.toMatch(/^다음에 해당하지 않으면/)
    }
    test.info().annotations.push({ type: '확정된 분기', description: sp.map((f) => `→ ${f.to}: ${f.condition}`).join(' / ') })
    await page.reload()
    await expect(page.locator('.undecided .urow', { hasText: STEP })).toHaveCount(0)
    await shot(page, '2-확정-뒤')
  })
})
