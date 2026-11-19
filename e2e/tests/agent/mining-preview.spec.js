// 정식 등록 전 BPMN 미리보기 (2026-11-11, 화면 점검 mining-ui-ux-review-2026-11-10 5번).
//
// 실제 관리자가 하는 그대로: 프로세스 마이닝 화면에서 추천을 열고, 등록 막대의 미리보기(눈 아이콘)로
// 정식 등록하면 저장될 BPMN 을 본다. 정하지 않은 분기는 대화로 정하고, 미리보기가 그 내용을 따라 다시 그려진다.
// 그다음 정식 등록하고, 저장된 BPMN 이 마지막으로 본 미리보기와 같은지 본다.
//
// 미리보기는 등록과 같은 경로다: 마이너 재도출 → buildContract → process-gpt BPMN 생성기(save_generated.py PREVIEW_ONLY).
// 아무것도 저장하지 않는다. 등록은 미리보기의 지문(X-Preview-Token)과 같은 정의만 저장한다.
//
// 추천 셋 — 등록된 추천의 사례를 새 사례 id 로 복제해 '추천' 상태로 둔 것(업무 범주 "미리보기 시험 A·B·C",
// 메일 라우팅에 걸리지 않는다). 태스크·레인 구성이 서로 다르다:
//   A 설계 제안·견적 대응 (미리보기 시험)   7태스크 · 레인 6 · 정하지 않은 분기가 남아 있음(미리보기만, 등록하지 않음)
//   B 행사 견적·고객 회신 (미리보기 시험)   5태스크 · 레인 4 · '고객 회신'을 대화로 필수로 정한 뒤 등록
//   C 요청 메일·견적서 작성 (미리보기 시험) 4태스크 · 레인 4 · 바로 등록
//
// 로컬 Lite 를 ProcessGPT 게이트웨이 뒤(8088)에서 연다:
//   cd e2e && PGPT_URL=http://localhost:8088/lite npx playwright test tests/agent/mining-preview.spec.js --project=agent
// 관리자 계정: RT_MINING_ADMIN(기본 mining-admin = pro-rt-mining-admin@uengine.org). 관리자 지정은 시험 밖에서 한다.
// 시험 데이터(추천·등록된 정의·대화)는 지우지 않는다. 등록된 추천은 다시 돌리면 건너뛴다.
import fs from 'node:fs'
import { test, expect } from '../../lib/fixtures.js'

const A = '설계 제안·견적 대응 (미리보기 시험)'
const B = '행사 견적·고객 회신 (미리보기 시험)'
const C = '요청 메일·견적서 작성 (미리보기 시험)'
const ADMIN = process.env.RT_MINING_ADMIN || 'mining-admin'
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

// 화면이 받은 미리보기(XML·지문)를 차례로 모은다
function previews(page) {
  const got = []
  page.on('response', async (res) => {
    if (!/\/api\/mining\/suggestions\/[^/]+\/bpmn/.test(res.url()) || !res.ok()) return
    got.push({ xml: await res.text(), token: res.headers()['x-preview-token'] || '' })
  })
  return got
}
const names = (xml, tag) => [...xml.matchAll(new RegExp(`<bpmn:${tag} [^>]*name="([^"]*)"`, 'g'))].map((m) => m[1])

// 이 추천의 프로세스로 저장된 것: 정의·버전·양식
const savedOf = async (db, pid) => (await db.q(`select (select count(*)::int from proc_def where tenant_id=$1 and lower(id)=lower($2)) d,
  (select count(*)::int from proc_def_version where tenant_id=$1 and lower(proc_def_id)=lower($2)) v,
  (select count(*)::int from form_def where tenant_id=$1 and lower(proc_def_id)=lower($2)) f`, [db.tenant, pid]))[0]
const recOf = async (db, name) => (await db.q('select * from pro_mining_suggestions where tenant_id=$1 and name=$2', [db.tenant, name]))[0]

async function admin(pageAs, db) {
  const page = await pageAs(ADMIN)
  const [u] = await db.q('select is_admin from users where id=$1 and tenant_id=$2', [page.user.id, db.tenant])
  test.skip(!u?.is_admin, `${page.user.email} 는 이 테넌트의 관리자가 아님`)
  return page
}

// 미리보기를 열고 그림이 그려질 때까지 — 그 미리보기를 돌려준다
async function openPreview(page, got) {
  const n = got.length
  await page.getByRole('button', { name: 'BPMN 미리보기' }).click()
  await expect(page.locator('.preview')).toBeVisible()
  await expect.poll(() => got.length, { timeout: 120_000 }).toBeGreaterThan(n)
  await expect(page.locator('.preview .djs-element[data-element-id^="activity"]').first()).toBeVisible({ timeout: 30_000 })
  return got.at(-1)
}

// 정식 등록 → 저장된 BPMN 이 마지막 미리보기와 같다. 미리보기 뒤 정의가 바뀌었으면(분 단위 찾기가 사례 조건을 채움)
// 등록은 거절되고 바뀐 미리보기가 그려진다 — 그것을 보고 다시 등록한다.
async function register(page, db, r, got) {
  for (let i = 0; i < 3; i++) {
    const seen = got.at(-1)
    const n = got.length
    await page.locator('.decide .go').click()
    const done = page.locator('.hero .st.registered')
    const stale = page.locator('.err', { hasText: '미리보기를 본 뒤 정의가 바뀌었어요' })
    await expect(done.or(stale)).toBeVisible({ timeout: 600_000 })
    if (await done.isVisible()) {
      const [row] = await db.q('select bpmn from proc_def where tenant_id=$1 and lower(id)=lower($2)', [db.tenant, r.process_id])
      return { seen, saved: row?.bpmn || '' }
    }
    await expect.poll(() => got.length, { timeout: 120_000 }).toBeGreaterThan(n)
  }
  throw new Error('정의가 계속 바뀌어 등록하지 못함')
}

test('A-MN-20 미리보기는 저장하지 않는다 · 정하지 않은 분기는 조건 없이 그려진다 (A)', async ({ pageAs, db }) => {
  test.setTimeout(10 * 60_000)
  const page = await admin(pageAs, db)
  const r = await recOf(db, A)
  test.skip(!r || r.status !== 'suggested', `등록 전 추천 '${A}' 가 없음`)
  const got = previews(page)
  await openRec(page, A)
  const before = await savedOf(db, r.process_id)
  expect(before, '등록 전에는 이 프로세스로 저장된 것이 없다').toEqual({ d: 0, v: 0, f: 0 })
  const open = await page.locator('.undecided .urow').count()
  expect(open, '정하지 않은 분기가 있는 추천').toBeGreaterThan(0)
  const p = await openPreview(page, got)
  await expect(page.locator('.preview h2 small')).toContainText(`정하지 않은 분기 ${open}개는 조건 없이 그려져요`)
  // 그림은 정의의 태스크·레인 그대로
  const def = (await recOf(db, A)).definition
  expect(new Set(names(p.xml, 'userTask'))).toEqual(new Set(def.activities.map((a) => a.name)))
  for (const t of def.activities) await expect(page.locator('.preview .djs-element text', { hasText: t.name }).first()).toBeAttached()
  await shot(page, 'A-1-미리보기-정하지-않은-분기')
  // 크게 보기
  await page.locator('.preview .tools button', { hasText: '크게 보기' }).click()
  await shot(page, 'A-2-미리보기-크게')
  await page.locator('.bpmn.big .tools button', { hasText: '닫기' }).click()
  // 연 것만으로는 아무것도 저장되지 않는다
  expect(await savedOf(db, r.process_id)).toEqual(before)
  expect((await recOf(db, A)).status).toBe('suggested')
})

test('A-MN-21 대화로 분기를 정하면 미리보기가 따라가고, 정식 등록된 BPMN 이 마지막 미리보기와 같다 (B)', async ({ pageAs, db }) => {
  test.setTimeout(30 * 60_000)
  const page = await admin(pageAs, db)
  const r = await recOf(db, B)
  test.skip(!r || r.status !== 'suggested', `등록 전 추천 '${B}' 가 없음`)
  const got = previews(page)
  await openRec(page, B)
  const p0 = await openPreview(page, got)
  await shot(page, 'B-1-미리보기-고객회신-미정')
  expect(await savedOf(db, r.process_id)).toEqual({ d: 0, v: 0, f: 0 })
  // 정하지 않은 분기: 대화로 정한다 (초안이 있으면 초안대로, 건너뛰는 분기에 초안이 없으면 필수로)
  const rows = page.locator('.undecided .urow')
  for (let k = 0; k < 6 && await rows.count(); k++) {
    const step = (await rows.first().locator('b').innerText()).trim()
    const draft = !(await rows.first().locator('.draft.none').count())
    const n = got.length
    const answer = await say(page, draft ? `'${step}' 분기는 초안대로 정해 줘` : `'${step}'는 필수 단계로 해 줘`)
    expect(answer.length).toBeGreaterThan(0)
    await expect(page.locator('.undecided .urow b', { hasText: new RegExp(`^${step}$`) })).toHaveCount(0, { timeout: 60_000 })
    // 미리보기가 정한 내용을 따라 다시 그려진다
    await expect.poll(() => got.length, { timeout: 120_000 }).toBeGreaterThan(n)
  }
  await expect(rows).toHaveCount(0)
  const p1 = got.at(-1)
  expect(p1.token, '정의가 바뀌었으니 미리보기도 바뀐다').not.toBe(p0.token)
  expect(p1.xml).not.toBe(p0.xml)
  await expect(page.locator('.preview h2 small')).toHaveText('정식 등록하면 이대로 저장돼요')
  await page.locator('.talk .x').click()
  await shot(page, 'B-2-대화로-정한-뒤-미리보기')
  expect(await savedOf(db, r.process_id), '대화로 정해도 등록 전에는 저장되지 않는다').toEqual({ d: 0, v: 0, f: 0 })
  const { seen, saved } = await register(page, db, r, got)
  expect(saved, '정식 등록된 BPMN = 마지막으로 본 미리보기').toBe(seen.xml)
  await expect(page.locator('.reg .bpmn .djs-element[data-element-id^="activity"]').first()).toBeVisible({ timeout: 60_000 })
  await page.locator('.reg').scrollIntoViewIfNeeded()
  await shot(page, 'B-3-정식-등록된-BPMN')
})

test('A-MN-22 태스크·레인 구성이 다른 추천도 정식 등록된 BPMN 이 미리보기와 같다 (C)', async ({ pageAs, db }) => {
  test.setTimeout(20 * 60_000)
  const page = await admin(pageAs, db)
  const r = await recOf(db, C)
  test.skip(!r || r.status !== 'suggested', `등록 전 추천 '${C}' 가 없음`)
  const got = previews(page)
  await openRec(page, C)
  await expect(page.locator('.undecided .urow')).toHaveCount(0)
  const p = await openPreview(page, got)
  // B 와 구성이 다르다 (B 가 이미 등록됐으면 그 저장본과 비교)
  const [b] = await db.q('select bpmn from proc_def where tenant_id=$1 and lower(id)=lower($2)', [db.tenant, (await recOf(db, B))?.process_id || ''])
  if (b?.bpmn) {
    expect(names(p.xml, 'lane').sort()).not.toEqual(names(b.bpmn, 'lane').sort())
    expect(names(p.xml, 'userTask').sort()).not.toEqual(names(b.bpmn, 'userTask').sort())
  }
  await shot(page, 'C-1-미리보기')
  expect(await savedOf(db, r.process_id)).toEqual({ d: 0, v: 0, f: 0 })
  const { seen, saved } = await register(page, db, r, got)
  expect(saved, '정식 등록된 BPMN = 마지막으로 본 미리보기').toBe(seen.xml)
  await page.locator('.reg').scrollIntoViewIfNeeded()
  await shot(page, 'C-2-정식-등록된-BPMN')
})
