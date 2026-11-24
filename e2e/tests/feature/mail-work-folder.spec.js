// 일 하나에 작업 폴더 하나 (2026-11-24 사용자 결정, 스펙 openspec/specs/mail-work-folder, 서버 lib/mailWork.js): 메일로 시작하거나 메일을 이은
// 일에는 작업 폴더가 하나 생기고, 첫 메일부터 이 일에 이어진 메일(메일/NN_<날짜>_<제목>.eml · .md · 첨부)과 단계 결과(인스턴스 라인의
// 산출물/NN_<단계>/)가 쌓인다. 인스턴스 화면의 「작업 폴더」, 폴더 탭의 「작업 폴더」 표시와 「루틴 · …」, 메일 시트의 「작업 폴더 · …」.
// 이 묶음의 서버는 PRO_LLM_BASE_URL 을 이 파일이 띄우는 가짜 모델(http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59998>/v1)로, 지도 엔진 없이
// (PRO_ONTOLOGY_BOLT_URL=) 띄운다. 메일함은 데모 메일함(실제 메일 없음). 지도가 「자동」으로 저절로 시작하는 것은 지도 엔진이 있어야 해서
// 서버 시험(server/test/mailWork.integration.test.js)이 대역으로 본다 — 여기서는 사람이 「잇기」로 메일을 일에 넣는 화면 흐름을 본다.
import http from 'node:http'
import crypto from 'node:crypto'
import { test, expect, RUN } from '../../lib/fixtures.js'
import { removeFolder } from '../../lib/seed.js'

const PHONE = { width: 390, height: 844 }
const PORT = Number(process.env.RT_FAKE_LLM_PORT || 59998)
const SAME = 0.9
const DRAFT = { subject: 'Re: 세미나 견적 부탁드립니다', body: '안녕하세요, 이수민 님.\n\n견적을 [날짜]까지 보내 드리겠습니다.\n\n홍길동 드림' }
const FIRST = { sender: '이수민 <sumin@hanbit.example>', subject: '세미나 견적 부탁드립니다', body: '홍길동 님, 12월 세미나 30명 기준 견적을 부탁드립니다.\n\n이수민 드림' }
const NEXT = { sender: '이수민 <sumin@hanbit.example>', subject: 'Re: 세미나 견적 부탁드립니다', body: '인원이 40명으로 늘었습니다. 날짜는 같습니다.\n\n이수민 드림' }
const QUOTE = { proc: 'p:mw-quote', name: '견적 요청 · 견적서 작성', stage: 'suggested', p: 0.91, task: '견적서 작성',
  choice: { task: '견적서 작성', p: 0.88, ask: true, suggest: true, measured: true, options: [{ task: '견적서 작성', p: 0.88 }], procName: '견적 요청 · 견적서 작성', procP: 0.91 } }

let fake
test.beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      // the judge (prompts/same-work.md): one token, its probabilities — A is 「같은 일」
      if (body.max_tokens === 1 && body.logprobs) {
        return res.end(JSON.stringify({ choices: [{ message: { content: 'A' }, logprobs: { content: [{ token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(SAME) }, { token: 'B', logprob: Math.log(1 - SAME) }] }] } }] }))
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(DRAFT) }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((ok, no) => fake.once('error', no).listen(PORT, '127.0.0.1', ok))
})
test.afterAll(async () => { await new Promise((ok) => fake?.close(ok)) })

const calm = (page) => page.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 3000)),
]))
const shot = async (page, name) => { await calm(page); await page.screenshot({ path: test.info().outputPath(name) }) }
const overflows = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
const insts = []
const sheetOf = (page) => page.locator('[data-test="mail-sheet"]')
const homeCard = (page, a) => page.locator(`[data-test="action-card"][data-action-id="${a.id}"]`)

// a demo mailbox and a mail that arrived in it, with the Home card the triage made (the map's reading already on it, as arrival leaves it)
async function mailCard(db, u, m, text) {
  const mailId = `demo-mw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await db.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo', address=$2`, [u.id, u.email])
  await db.q('insert into pro_demo_mail(user_id, mail_id, sender, subject, body) values ($1,$2,$3,$4,$5)', [u.id, mailId, m.sender, m.subject, m.body])
  const [a] = await db.q(`insert into pro_actions(user_id, verb, text, prompt, source) values ($1,'Reply',$2,'',$3) returning *`,
    [u.id, text, { mail_id: mailId, from: m.sender, subject: m.subject, flow: { at: new Date().toISOString(), matches: [QUOTE] } }])
  return a
}
// a running instance of the company map that I started (its name ends in a word without 받침: 「…를」)
async function running(db, u) {
  const instId = `mw-e2e.${crypto.randomUUID()}`
  const name = `세미나 견적 ${RUN.slice(-4)}${Math.random().toString(36).slice(2, 5)} · 한빛상사`
  insts.push(instId)
  await db.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, tenant_id, status, participants, start_date, updated_at) values ($1,$2,$3,'RUNNING',$4, now() at time zone 'Asia/Seoul', now())`, [instId, name, db.tenant, [u.id]])
  await db.q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, request, status) values ($1,'p:mw-quote','견적서 작성',$2,$3,$4,$5,'running')`,
    [db.tenant, u.id, { kind: 'mail', subject: FIRST.subject, from: FIRST.sender }, [instId], { subject: FIRST.subject, sender: FIRST.sender, body: FIRST.body }])
  return { instId, name }
}
async function setup(pageAs, db, area, opts = {}) {
  const page = await pageAs(area, opts)
  const u = page.user
  await db.clearMain(u.id)
  await cleanup(db, u)
  const run = await running(db, u)
  return { page, u, run }
}
async function cleanup(db, u) {
  for (const f of await db.q(`select slug from pro_folders where created_by=$1 and settings ? 'work'`, [u.id])) await removeFolder(db, f.slug)
  await db.q('delete from pro_actions where user_id=$1', [u.id])
  await db.q('delete from pro_demo_mail where user_id=$1', [u.id])
  await db.q('delete from pro_mail_accounts where user_id=$1', [u.id])
  await db.q('delete from notifications where user_id=$1', [u.id])
  await db.q(`delete from todolist where proc_inst_id in (select unnest(instances) from pro_po_cases where started_by=$1)`, [u.id])
  await db.q('delete from pro_po_cases where started_by=$1', [u.id])
  await db.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1 and kind='process' and ref like 'mw-e2e.%')`, [u.id])
  await db.q(`delete from pro_threads where user_id=$1 and kind='process' and ref like 'mw-e2e.%'`, [u.id])
}
test.afterAll(async () => {
  const db = await import('../../lib/db.js')
  if (!insts.length || !(await db.available())) return
  await db.q('delete from pro_messages where thread_id in (select id from pro_threads where ref = any($1))', [insts]).catch(() => {})
  await db.q('delete from pro_threads where ref = any($1)', [insts]).catch(() => {})
  await db.q('delete from bpm_proc_inst where proc_inst_id = any($1)', [insts]).catch(() => {})
})
// 잇기 in the mail's sheet: the instance page opens
async function joinFromSheet(page, a, run) {
  await homeCard(page, a).click()
  const sheet = sheetOf(page)
  await expect(sheet.locator('[data-test="flow-join"]')).toContainText('같은 일 90%')
  await sheet.locator('[data-test="flow-join"]').click()
  await page.waitForURL(`**/routines/${encodeURIComponent(run.instId)}`)
  await expect(sheet).toHaveCount(0)
}
const workFolderOf = async (db, instId) => (await db.q(`select * from pro_folders where settings->'work'->'instances' ? $1`, [instId]))[0]

test.describe('일의 작업 폴더 — 메일과 단계 결과가 한곳에', () => {
  test('F-MW-01 메일을 일에 이으면 작업 폴더가 생기고 첫 메일이 들어간다 — 인스턴스 화면의 「작업 폴더」 → 폴더(메일/01_….eml · .md) → 「루틴 · …」로 돌아온다 (PC)', async ({ pageAs, db }) => {
    const { page, u, run } = await setup(pageAs, db, 'mw-join')
    const a = await mailCard(db, u, FIRST, '한빛상사 세미나 견적 요청 회신')
    await page.goto('/chat')
    await joinFromSheet(page, a, run)
    const wf = page.locator('[data-test="work-folder"]')
    await expect(wf.locator('[data-test="work-folder-link"]')).toContainText(`작업 폴더${run.name}`)
    await expect(wf.locator('[data-test="work-folder-sub"]')).toHaveText('메일 1통· 단계 결과 0개')
    // the instance's conversation says where the mail went (not the main chat)
    const chip = page.locator('[data-test="folder-chip"]')
    await expect(chip).toContainText(`작업 폴더 ‘${run.name}’를 만들고 메일 01 「${FIRST.subject}」를 넣었어요`)
    await shot(page, 'f-mw-01a.png')
    const f = await workFolderOf(db, run.instId)
    expect([f.settings.work.owner, f.settings.work.mails.length, f.name]).toEqual([u.id, 1, run.name])
    const [card] = await db.q('select source from pro_actions where id=$1', [a.id])
    expect(card.source.inst.folder).toEqual({ slug: f.slug, name: f.name })
    await wf.locator('[data-test="work-folder-link"]').click()
    await page.waitForURL(`**/folders/${f.slug}`)
    await expect(page.locator('h1 .hn')).toHaveText(run.name)
    await expect(page.locator('[data-test="folder-work-badge"]')).toHaveText('작업 폴더')
    await expect(page.locator('[data-test="folder-work-inst"]')).toContainText(`루틴 · ${run.name}`)
    await expect(page.locator('.fr.dir', { hasText: '메일' })).toBeVisible()
    const stem = `01_${today()}_${FIRST.subject}`
    await expect(page.locator('.fr.file .nm', { hasText: `${stem}.eml` })).toBeVisible()
    await expect(page.locator('.fr.file .nm', { hasText: `${stem}.md` })).toBeVisible()
    await shot(page, 'f-mw-01b.png')
    // the mail, to read
    await page.locator('.fr.file .nm', { hasText: `${stem}.md` }).click()
    const pv = page.locator('.sheet.glass')
    await expect(pv).toContainText('보낸 사람: 이수민')
    await expect(pv).toContainText('sumin@hanbit.example')
    await expect(pv).toContainText('12월 세미나 30명 기준 견적을 부탁드립니다.')
    await shot(page, 'f-mw-01c.png')
    await page.keyboard.press('Escape')
    await page.locator('.veil').click({ position: { x: 5, y: 5 } }).catch(() => {})
    await expect(pv).toHaveCount(0)
    await page.locator('[data-test="folder-work-inst"]').click()
    await page.waitForURL(`**/routines/${encodeURIComponent(run.instId)}`)
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MW-02 휴대폰: 인스턴스 화면의 「작업 폴더」와 폴더 화면이 옆으로 넘치지 않는다', async ({ pageAs, db }) => {
    const { page, u, run } = await setup(pageAs, db, 'mw-phone', { viewport: PHONE, touch: true })
    const a = await mailCard(db, u, FIRST, '한빛상사 세미나 견적 요청 회신')
    await page.goto('/chat')
    await expect(homeCard(page, a)).toBeVisible()
    await joinFromSheet(page, a, run)
    const wf = page.locator('[data-test="work-folder"]')
    await expect(wf).toBeVisible()
    await expect(wf.locator('[data-test="work-folder-sub"]')).toHaveText('메일 1통· 단계 결과 0개')
    expect(await overflows(page)).toBe(false)
    const box = await wf.locator('[data-test="work-folder-link"]').boundingBox()
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width)
    await shot(page, 'f-mw-02a.png')
    await page.locator('[data-test="folder-chip"]').scrollIntoViewIfNeeded()
    await shot(page, 'f-mw-02b.png')
    await wf.locator('[data-test="work-folder-link"]').click()
    const f = await workFolderOf(db, run.instId)
    await page.waitForURL(`**/folders/${f.slug}`)
    await expect(page.locator('.fr.file .nm', { hasText: `01_${today()}_${FIRST.subject}.md` })).toBeVisible()
    await expect(page.locator('[data-test="folder-work-inst"]')).toBeVisible()
    expect(await overflows(page)).toBe(false)
    await shot(page, 'f-mw-02c.png')
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MW-03 다음 메일도 이으면 같은 폴더의 메일/02_…로 — 메일 시트의 「작업 폴더 · …」, 폴더 목록의 「작업 폴더」 표시', async ({ pageAs, db }) => {
    const { page, u, run } = await setup(pageAs, db, 'mw-next')
    const a = await mailCard(db, u, FIRST, '한빛상사 세미나 견적 요청 회신')
    const joined = await page.user.post(`/actions/${a.id}/flow/join`, { instId: run.instId })
    expect(joined.status, joined.text).toBe(200)
    const b = await mailCard(db, u, NEXT, '한빛상사 인원 변경(40명) 회신')
    await page.goto('/chat')
    await joinFromSheet(page, b, run)
    await expect(page.locator('[data-test="work-folder-sub"]')).toHaveText('메일 2통· 단계 결과 0개')
    await expect(page.locator('[data-test="folder-chip"]').last()).toContainText(`작업 폴더 ‘${run.name}’에 메일 02 「${NEXT.subject}」를 넣었어요`)
    const f = await workFolderOf(db, run.instId)
    // the mail's own sheet (its chip in the instance's conversation) leads to the folder too
    const said = page.locator('.row.k-text').filter({ hasText: `메일 「${NEXT.subject}」를 이 일에 이었어요.` })
    await said.locator('[data-test="mail-chip"]').click()
    const link = sheetOf(page).locator('[data-test="mail-folder"]')
    await expect(link).toContainText(`작업 폴더 · ${run.name}`)
    await shot(page, 'f-mw-03a.png')
    await link.click()
    await page.waitForURL(`**/folders/${f.slug}`)
    await expect(sheetOf(page)).toHaveCount(0)
    await page.goto('/folders')
    const row = page.locator('.row', { hasText: run.name })
    await expect(row.locator('[data-test="folder-work-badge"]')).toHaveText('작업 폴더')
    await shot(page, 'f-mw-03b.png')
    await row.click()
    await page.waitForURL(`**/folders/${f.slug}`)
    await expect(page.locator('.fr.file .nm', { hasText: `01_${today()}_${FIRST.subject}.md` })).toBeVisible()
    await expect(page.locator('.fr.file .nm', { hasText: `02_${today()}_Re ${FIRST.subject}.md` })).toBeVisible()
    await shot(page, 'f-mw-03c.png')
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })

  test('F-MW-04 끝난 단계의 결과는 인스턴스 라인의 산출물/NN_<단계>/ 로 — 인스턴스 화면 「단계 결과 보기」 → 그 변형(main 은 반영 전까지 그대로)', async ({ pageAs, db, lib }) => {
    const { page, u, run } = await setup(pageAs, db, 'mw-steps')
    const a = await mailCard(db, u, FIRST, '한빛상사 세미나 견적 요청 회신')
    expect((await page.user.post(`/actions/${a.id}/flow/join`, { instId: run.instId })).status).toBe(200)
    // a finished agent step of this instance (what ontology/run.js leaves on its work item)
    await db.q(`insert into todolist (id, tenant_id, proc_inst_id, activity_id, activity_name, status, output, user_id, agent_orch, agent_mode, start_date, end_date)
                values ($1,$2,$3,'t_quote','견적서 작성','DONE',$4,$5,'pgpt-pro-onto','COMPLETE', now() at time zone 'Asia/Seoul', now() at time zone 'Asia/Seoul')`,
    [crypto.randomUUID(), db.tenant, run.instId, { t_quote_form: { title: '한빛상사 세미나 견적', result: '30명 기준 견적이에요. 대관 · 다과 · 자료집, 합계 1,200,000원(가정).', summary: '견적 초안을 만들었어요.' } }, u.id])
    const MW = await lib('lib/mailWork.js')
    const f = await workFolderOf(db, run.instId)
    expect((await MW.recordDone(f)).length).toBe(1)
    await page.goto(`/routines/${encodeURIComponent(run.instId)}`)
    await expect(page.locator('[data-test="work-folder-sub"]')).toContainText('메일 1통· 단계 결과 1개')
    await shot(page, 'f-mw-04a.png')
    await page.locator('[data-test="work-folder-line"]').click()
    await page.waitForURL(`**/folders/${f.slug}/v/**`)
    await expect(page.locator('.ci', { hasText: '결과.md' })).toBeVisible()
    await expect(page.locator('.ci', { hasText: '결과.md' })).toContainText('산출물/01_견적서 작성')
    await shot(page, 'f-mw-04b.png')
    const main = await db.q(`select count(*)::int as n from pro_folder_files where folder_id=$1 and path like '산출물/%'`, [f.id])
    expect(main[0].n).toBe(0)
    expect(page.errors).toEqual([])
    await cleanup(db, u)
  })
})
