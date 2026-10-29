// 프로세스 마이닝 → 정식 등록 → 메일 라우팅, 그리고 검토 카드의 앞 단계 산출물 칩.
// 반복된 메일 업무의 인계 기록(handover_events)을 process-miner 가 패턴으로 묶고(관리자 추천), 정식 등록하면
// process-gpt 정의(save_contract)가 되고 다음 비슷한 메일이 그 프로세스로 간다. 검토자는 앞 단계 산출물을 연다.
// (server/lib/mining/*, routes/mining.js, MiningView.vue, StepOutputs.vue · process-miner :8014 필요한 시험은 없으면 건너뜀)
import { test, expect, api, RUN } from '../../lib/fixtures.js'
import { lock as lockDb } from '../../lib/db.js'
import { retireInstance, XLSX, MIME } from '../../lib/seed.js'
import { LOCAL_API, PGPT_URL, TENANT } from '../../lib/env.js'

const MINER = (process.env.MINER_URL || (LOCAL_API ? 'http://127.0.0.1:8014' : '')).replace(/\/$/, '')
const minerUp = async () => !!MINER && fetch(`${MINER}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false)

test.describe('프로세스 마이닝 (lib/mining)', () => {
  test('F-MN-01 추천·등록·보류는 관리자만 (일반 사용자 403), /mining/me 는 관리자 여부만', async ({ as }) => {
    const u = await as('mn-user')
    expect((await u.get('/mining/me')).body).toEqual({ admin: false })
    expect((await u.get('/mining/suggestions')).status).toBe(403)
    expect((await u.post('/mining/scan')).status).toBe(403)
    const id = '00000000-0000-4000-8000-000000000000'
    expect((await u.get(`/mining/suggestions/${id}`)).status).toBe(403)
    expect((await u.post(`/mining/suggestions/${id}/register`)).status).toBe(403)
    expect((await u.post(`/mining/suggestions/${id}/hold`)).status).toBe(403)
  })

  test('F-MN-01b 관리자가 아니면 화면에 "관리자만 볼 수 있어요" — 영어에서도(거절은 메시지 글이 아니라 403 으로 알아봄)', async ({ browser }) => {
    // (the English demo tenant: English only; an English account is pro-en-fix-*, a Korean one pro-rt-fix-*)
    for (const lang of TENANT === 'en-demo' ? ['en'] : ['ko', 'en']) {
      const u = api.client(await api.login(lang === 'en' ? `pro-en-fix-mining-${TENANT === 'en-demo' ? 'en' : 'local'}@uengine.org` : 'pro-rt-fix-mining-viewer@uengine.org'))
      await u.post('/profile', { name: lang === 'en' ? 'Alex Kim' : '김알렉스', birth: '1990-01-01', onboarded: true })
      expect((await u.put('/me/lang', { lang })).status).toBe(200)
      // the refusal the page reads is in the account's language: no "관리자" in the English one
      const r = await u.get('/mining/suggestions')
      expect(r.status).toBe(403)
      if (lang === 'en') expect(r.body.error).not.toMatch(/관리자/)
      const ctx = await browser.newContext({ locale: lang === 'en' ? 'en-US' : 'ko-KR', baseURL: PGPT_URL })
      await ctx.addInitScript(([s, l]) => { if (window.top === window) { localStorage.setItem('pgpt-pro-session', s); localStorage.setItem('pgl-lang', l) } }, [JSON.stringify(u.s), lang])
      const page = await ctx.newPage()
      try {
        await page.goto('/mining')
        await expect(page.locator('.mv .first')).toHaveText(lang === 'en' ? 'Only admins can see this.' : '관리자만 볼 수 있어요.', { timeout: 30_000 })
        // not the empty list a non-admin used to get in English
        await expect(page.locator('.mv h1')).toHaveCount(0)
      } finally { await ctx.close() }
    }
  })

  test('F-MN-02 인계 기록 4건 → process-miner 가 한 패턴으로 묶고 순서대로 도출 → 정식 등록 계약(단계·폼·에이전트)', async ({ db, lib, cleanup }) => {
    test.skip(!(await minerUp()), `process-miner 에 닿지 않음 (${MINER || 'MINER_URL 없음'}) — 설치 번들은 mining 프로필에서만 띄움`)
    // labels unique to this run: the pattern never merges with the tenant's real cases, and with no
    // pro_mining_cases rows the server's own scan never turns it into a recommendation
    const L = (s) => `회귀${RUN} ${s}`
    const steps = [[L('접수'), false], [L('초안 작성'), true], [L('검토'), false], [L('회신'), false]]
    const cases = [0, 1, 2, 3].map((i) => `rt-mining:${RUN}:${i}`)
    cleanup(() => db.q('delete from handover_events where tenant_id=$1 and case_id = any($2)', [db.tenant, cases]))
    const t0 = Date.now() - 3 * 3600_000
    for (const [ci, c] of cases.entries()) {
      for (const [si, [label, agent]] of steps.entries()) {
        await db.q(`insert into handover_events (tenant_id, case_id, origin_room_id, source, is_explicit, to_user_id, to_user_name, to_is_agent,
                     activity_label, next_activity_label, norm_activity_label, occurred_at)
                    values ($1,$2,$2,$3,$4,$5,$6,$7,$8,$8,$8,$9)`,
        [db.tenant, c, agent ? 'agent_delegation' : 'chat_handover', !agent, agent ? 'rt-agent' : 'rt-person', agent ? '회귀 에이전트' : '회귀 담당', agent,
          label, new Date(t0 + ci * 600_000 + si * 60_000).toISOString()])
      }
    }
    const pats = await (await fetch(`${MINER}/patterns?tenant_id=${encodeURIComponent(db.tenant)}&min_cases=4`)).json()
    const p = pats.patterns.find((x) => x.case_ids.some((id) => cases.includes(id)))
    expect(p, '패턴').toBeTruthy()
    expect([...p.case_ids].sort()).toEqual([...cases].sort())
    expect(p.main_variant).toEqual(steps.map(([l]) => l))
    const disc = await fetch(`${MINER}/discover`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_id: db.tenant, process_id: `rt_mined_${RUN}`, name: '회귀 마이닝', case_ids: p.case_ids }) })
    expect(disc.status).toBe(200)
    const { definition } = await disc.json()
    expect(definition.activities.map((a) => a.name)).toEqual(steps.map(([l]) => l))
    // what 정식 등록 hands to process-gpt's save_contract (no save here)
    const { buildContract } = await lib('lib/mining/service.js')
    const c = buildContract({ process_id: `rt_mined_${RUN}`, name: '회귀 마이닝', summary: '', definition, pattern: p })
    expect(c.type).toBe('process-definition-result')
    const acts = c.processDefinition.elements.filter((e) => e.elementType === 'Activity')
    expect(acts.map((a) => a.name)).toEqual(steps.map(([l]) => l))
    expect(c.forms).toHaveLength(acts.length)
    expect(c.processDefinition.elements.filter((e) => e.elementType === 'Event').map((e) => e.type).sort()).toEqual(['EndEvent', 'StartEvent'])
    expect(c.processDefinition.elements.filter((e) => e.elementType === 'Sequence').length).toBeGreaterThanOrEqual(acts.length + 1)
  })

  test('F-MN-03 등록된 프로세스의 라우팅 기준: 형식 2개 이상 일치 또는 낱말 2개 이상일 때만', async ({ lib }) => {
    // the rule routeMail applies to the next mail (lib/mining/service.js)
    const { matches } = await lib('lib/mining/service.js')
    const m = { formats: ['dxf', 'hwpx', 'xlsx'], keywords: ['인테리어', '설계', '제안서', '견적서'] }
    expect(matches(m, { subject: '카페 인테리어 설계 제안서 요청', text: '' }, { items: [{ format: 'hwpx' }] })).toBe(true)
    expect(matches(m, { subject: '행사 다과 단가', text: '엑셀로 주세요' }, { items: [{ format: 'xlsx' }] })).toBe(false)
    expect(matches(m, { subject: '자료', text: '평면도와 함께 보내 주세요' }, { items: [{ format: 'hwpx' }] }), '평면도 낱말은 dxf 로 셈').toBe(true)
    expect(matches(null, { subject: '인테리어 설계', text: '' }, {})).toBe(false)
  })
})

test.describe('검토 카드의 앞 단계 산출물 (StepOutputs · GET /todos/:id/outputs)', () => {
  const DEF = 'doc_ai_draft_approval'
  test('F-PR-03 담당자는 앞 단계 산출물을 보고 자기 카드로 연다, 참여하지 않은 사람은 403', async ({ as, db, cleanup }) => {
    test.setTimeout(300_000)
    const a = await as('so-owner'), mate = await as('so-mate'), out = await as('so-outsider')
    test.skip((await a.get(`/processes/${DEF}`)).status !== 200, `프로세스 정의 ${DEF} 가 없음 — lite 프로필에는 프로세스 엔진과 예제 정의가 없음 (full 프로필에서 확인)`)
    await a.get('/team'); await mate.get('/team')
    const release = await lockDb('role:doc_ai_draft_approval:기안자')
    cleanup(release)
    cleanup(() => a.put('/roles', { defId: DEF, role: '기안자', userId: null }))
    expect((await a.put('/roles', { defId: DEF, role: '기안자', userId: mate.id })).status).toBe(200)
    const st = await a.post(`/processes/${DEF}/start`, { values: {} }, { timeout: 180_000 })
    expect(st.status, st.text).toBe(200)
    const inst = st.body.instId
    cleanup(() => retireInstance(inst))
    let todo
    await expect.poll(async () => { todo = (await mate.get('/todos')).body.find((t) => t.proc_inst_id === inst); return !!todo }, { timeout: 120_000, intervals: [3000] }).toBe(true)
    // the finished first step left a file (what an agent step's form file / output_url looks like)
    const up = await api.upload(a.token(), '기안 근거.xlsx', MIME.xlsx, await XLSX([['항목', '금액'], ['대관', 1]]))
    await expect.poll(async () => (await db.q(`update todolist set output_url=$2 where proc_inst_id=$1 and status='DONE' returning id`, [inst, up.url])).length, { timeout: 60_000, intervals: [2000] }).toBeGreaterThan(0)
    const o = await mate.get(`/todos/${todo.id}/outputs`)
    expect(o.status, o.text).toBe(200)
    expect(o.body.files.map((f) => f.url)).toContain(up.url)
    expect((await out.get(`/todos/${todo.id}/outputs`)).status).toBe(403)
    expect((await out.post(`/todos/${todo.id}/outputs/open`, { url: up.url })).status).toBe(403)
    expect((await mate.post(`/todos/${todo.id}/outputs/open`, { url: 'https://example.com/x.xlsx' })).status).toBe(404)
    // open: the reviewer's own file card (source_url), the same one on the second open
    const c1 = await mate.post(`/todos/${todo.id}/outputs/open`, { url: up.url })
    expect(c1.status, c1.text).toBe(200)
    expect(c1.body).toMatchObject({ kind: 'file', content: { source_url: up.url } })
    expect((await mate.post(`/todos/${todo.id}/outputs/open`, { url: up.url })).body.id).toBe(c1.body.id)
    expect((await mate.get('/todos/00000000-0000-4000-8000-000000000000/outputs')).status).toBe(404)
  })
})
