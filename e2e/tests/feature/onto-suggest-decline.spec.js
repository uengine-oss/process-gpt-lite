// 프로세스 제안을 거절한 까닭(스펙 openspec/specs/map-case-view 「채팅 요청의 프로세스 제안을 거절하면 까닭을 묻고 남긴다」, 화면 OntoEntryCard.vue,
// 서버 lib/ontology/declines.js · POST /api/ontology/entry/decline). 2026-11-28 녹화: 「Spec Kit 커리큘럼을 PMO 자료로 설계해 줘」 아래에
// 「이 요청은 「요청 보고 · 구현」 업무로 진행할 수 있어요」가 붙었다 — 「전혀 관계도 없는 거 자꾸 추천하기도 하고 … 내가 이거 안 하려고 이렇게 하면
// 아닌 이유를 좀 파악을 해야 될 것 같아」. 「아니요」는 이 기기에만 남던 것이 서버의 카드에 남고, 채팅 요청 카드는 한 줄로 왜 아닌지 묻는다.
//   F-OD-01 PC 1280(밝은): 「아니요」 → 「왜 아닌가요?」 한 줄과 칩 한 줄(이 일과 관계없어요 · 맞지만 이번엔 그냥 · 직접 적기, 넘어가기) · 키보드 초점 테두리 →
//           「이 일과 관계없어요」 → 초점이 남긴 줄(role=status)로 · 「관계없는 업무로 알아 둘게요」와 그 업무 이름 · 카드 메시지에 reason unrelated ·
//           다른 기기(새 브라우저 문맥, 이 기기 기록 없음)에서도 거절 · 까닭이 그대로
//   F-OD-02 휴대폰 390(밝은): 「직접 적기」 → 초점이 칸으로(이름표 · 16px) → 적은 말 → 「보내기」(모델 없음: 「다른 까닭」으로 남고 반례가 아님) → 다른 기기에서도
//           적은 말이 보임 · 가로 넘침 없음
//   F-OD-03 휴대폰 390(어두운): 「왜 아닌가요?」 줄이 어두운 화면에서 읽힘 → 「맞지만 이번엔 그냥」 → 「알겠어요 …」 · 새로 고쳐도 그대로
//   F-OD-04 PC: 「넘어가기」 → 묻는 줄이 사라지고 다시 열어도 묻지 않음(까닭 없이 거절만)
//   F-OD-05 메일 카드의 「아니요」도 서버에 남는다(다른 기기에서도 거절) — 까닭은 채팅 요청 카드에서만 묻는다
//   F-OD-06 서버가 거절을 받지 않음(409 — 다른 기기에서 이미 시작): 이 기기의 거절을 지우고 묻는 카드로 돌아가 「다른 기기에서 이미 시작했어요.」
//   F-OD-07 서버에 닿지 못함(오프라인): 이 기기에만 거절 · 까닭이 남고 「이 기기에만 남겼어요 …」 — 「다음 제안에 반영해요」라고 하지 않는다
// 자기 스택(lib/localStack.js: 회사 onto-decline-ui 의 BFF + Vite, 8921 · 5321 부터 빈 포트). 모델 · 지도 저장소는 부르지 않는다(닫힌 포트,
// PRO_ONTOLOGY_BOLT_URL=). 카드는 서버가 남기는 모양대로 DB 에 넣는다(events.js dispatch). 사람 · 회사는 지어낸 것이다(정하윤 · 가나정밀).
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/onto-suggest-decline.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO } from '../../lib/localStack.js'

const TENANT = 'onto-decline-ui'
const NOWHERE = 'http://127.0.0.1:9'
const SHOTS = path.join(REPO, 'openspec/specs/map-case-view/e2e/results')
const PC = { viewport: { width: 1280, height: 860 } }
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }
test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })

let S = null
let HY = null
let THREAD = null
test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  S = await startStack({ tenant: TENANT, apiFrom: 8921, webFrom: 5321, env: {
    PRO_LLM_BASE_URL: NOWHERE + '/v1', PRO_LLM_API_KEY: 'fake', PRO_LLM_KEYS: 'off',
    PRO_DEEPAGENTS_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: '', PRO_COMPLETION_URL: NOWHERE, PRO_JUDGE_URL: NOWHERE, PRO_JUDGE_LLM: '0', PRO_EMBED_URL: '',
    PRO_MEMENTO_URL: NOWHERE, PRO_ONTOLOGY_BOLT_URL: '',
  } })
  console.log(`[onto-decline] stack on BFF ${S.apiPort} · web ${S.webPort}`)
  HY = await S.person(`pro-rt-${TENANT}-a@uengine.org`, '정하윤')
  await S.join(HY)
  await S.api(HY.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
  await S.api(HY.token, '/threads')
  ;[{ id: THREAD }] = await S.q(`select id from pro_threads where user_id=$1 and kind='chat' order by created_at limit 1`, [HY.id])
})
test.afterAll(async () => {
  if (!S) return
  fs.mkdirSync(path.join(REPO, 'e2e/reports'), { recursive: true })
  fs.writeFileSync(path.join(REPO, 'e2e/reports', `bff-${TENANT}.log`), S.logs.join(''))
  if (HY) {
    await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [HY.id]).catch(() => {})
    await S.q('delete from pro_threads where user_id=$1', [HY.id]).catch(() => {})
    await S.q('delete from pro_profile where user_id=$1', [HY.id]).catch(() => {})
  }
  await S.q('delete from notifications where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('delete from tenants where id=$1', [TENANT]).catch(() => {})
  await S.stop()
})

const GEN = { proc: 'p:od-gen', procName: '요청 보고 · 구현', task: '요청방향 보고', p: 0.44, measured: true, suggest: true, ask: true, procP: 0.74,
  options: [{ task: '요청방향 보고', p: 0.44 }, { task: '구현', p: 0.23 }, { task: '결과 보고', p: 0.09 }] }
// one turn as the chat keeps it: the request, the answer, and the card the server posted after it (events.js dispatch, source chat)
async function seedTurn(request, { source = 'chat' } = {}) {
  await S.q('delete from pro_messages where thread_id=$1', [THREAD])
  let t = Date.now() - 5000
  const add = async (role, kind, content) => (await S.q(`insert into pro_messages(thread_id, role, kind, content, created_at) values ($1,$2,$3,$4, to_timestamp($5/1000.0)) returning id::text as id`,
    [THREAD, role, kind, content, t += 1000]))[0].id
  if (source === 'chat') {
    await add('user', 'text', { text: request })
    await add('agent', 'text', { text: '커리큘럼 초안을 정리했어요. 1주차는 Spec Kit 소개와 constitution 쓰기, 2주차는 spec · plan · tasks 순서로 실습해요.' })
  }
  return add('agent', 'onto-entry', { state: 'ask', ...(source === 'chat' ? { source: 'chat', conv: '' } : {}), customer: source === 'mail' ? '가나정밀' : '',
    mail: source === 'chat' ? { from: '', subject: request.split('\n')[0].slice(0, 80), text: request } : { from: '가나정밀 교육팀 <edu@example.test>', subject: request, text: '교육 과정 견적을 부탁드립니다.' },
    choice: GEN, suggest: true })
}
const contentOf = async (id) => (await S.q('select content from pro_messages where id=$1', [id]))[0]?.content

async function open(browser, opts, { theme = 'light' } = {}) {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', 'ko')
    localStorage.setItem('pgl-install', JSON.stringify({ never: true }))
  }, [JSON.stringify(HY.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
// the chat with the card (a phone opens on Home: its 채팅 tab)
async function chat(p, subject) {
  await p.goto('/chat')
  const card = p.getByTestId('onto-entry-card').filter({ hasText: subject })
  const phone = (p.viewportSize()?.width || 1280) < 600
  if (phone) {
    const tab = p.locator('.seg button').filter({ hasText: '채팅' }).first()
    await tab.waitFor({ timeout: 30000 })
    if (!(await card.isVisible().catch(() => false))) await tab.click()
  }
  await expect(card).toBeVisible({ timeout: 30000 })
  await card.scrollIntoViewIfNeeded()
  return card
}
const calm = (p) => p.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))), new Promise((ok) => setTimeout(ok, 1500))]))
async function shot(p, name, loc = null) { await calm(p); await (loc || p).screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const chipRows = (row) => row.locator('.chip').evaluateAll((bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size)

const REQ1 = '가나정밀 교육 과정을 Spec Kit 기반으로 커리큘럼 설계해 줘'
test('F-OD-01 PC 1280(밝은): 「아니요」 → 왜 아닌지 한 줄 → 「이 일과 관계없어요」 → 서버의 카드에 남고 다른 기기에서도 그대로', async ({ browser }) => {
  const id = await seedTurn(`${REQ1}\n드라이브의 PMO 교육 자료를 참고해서`)
  const p = await open(browser, PC)
  const card = await chat(p, REQ1)
  await expect(card.getByTestId('onto-entry-suggest')).toContainText('「요청 보고 · 구현」 업무로 진행할 수 있어요')
  await card.getByTestId('onto-entry-decline').click()
  await expect(card).toHaveAttribute('data-state', 'declined')
  await expect(card.getByTestId('onto-entry-declined')).toHaveText('이번 요청은 프로세스 없이 진행해요.')
  // one line: the question, three chips and 넘어가기
  const row = card.getByTestId('onto-entry-why')
  await expect(row).toBeVisible()
  await expect(row).toContainText('왜 아닌가요?')
  for (const t of ['onto-entry-why-unrelated', 'onto-entry-why-notnow', 'onto-entry-why-text', 'onto-entry-why-skip']) await expect(row.getByTestId(t)).toBeVisible()
  expect(await chipRows(row), '칩은 한 줄').toBe(1)
  // keyboard: a visible focus ring on the chips
  await row.getByTestId('onto-entry-why-skip').focus()
  await p.keyboard.press('Tab')
  await expect(row.getByTestId('onto-entry-why-unrelated')).toBeFocused()
  expect(await row.getByTestId('onto-entry-why-unrelated').evaluate((b) => [getComputedStyle(b).outlineStyle, parseFloat(getComputedStyle(b).outlineWidth)])).toEqual(['solid', 2])
  // the decline is on the server before any reason
  await expect.poll(async () => (await contentOf(id))?.state).toBe('declined')
  expect((await contentOf(id)).declined.procs).toEqual([{ proc: GEN.proc, name: GEN.procName }])
  await shot(p, 'f-od-01-why-pc', card)
  await row.getByTestId('onto-entry-why-unrelated').click()
  const saved = card.getByTestId('onto-entry-why-saved')
  await expect(saved).toHaveAttribute('data-reason', 'unrelated')
  await expect(saved).toContainText('이런 요청과 관계없는 업무로 알아 둘게요. 다음 제안에 반영해요.')
  await expect(card.getByTestId('onto-entry-why-procs')).toHaveText('「요청 보고 · 구현」')
  await expect(saved).toHaveAttribute('role', 'status')
  await expect(saved, '누른 칩이 사라진 자리: 초점은 남긴 줄로').toBeFocused()
  await expect(row).toHaveCount(0)
  const c = await contentOf(id)
  expect(c.declined.reason).toBe('unrelated')
  expect(c.declined.by).toBe(HY.id)
  await shot(p, 'f-od-01-saved-pc', card)
  // another device: nothing of this one's local copy — the card's own message says it
  const other = await open(browser, PC)
  const card2 = await chat(other, REQ1)
  await expect(card2).toHaveAttribute('data-state', 'declined')
  await expect(card2.getByTestId('onto-entry-why-saved')).toHaveAttribute('data-reason', 'unrelated')
  await expect(card2.getByTestId('onto-entry-why')).toHaveCount(0)
  expect(await other.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('onto:entry:')))).toEqual([])
  await shot(other, 'f-od-01-other-device-pc')
  expect(p.errors).toEqual([])
  expect(other.errors).toEqual([])
  await p.context().close(); await other.context().close()
})

const REQ2 = '정하윤 팀 실습 과정 목차를 다시 짜 줘'
test('F-OD-02 휴대폰 390(밝은): 「직접 적기」 → 적은 말 → 보내기 — 모델이 없으면 「다른 까닭」으로 남고, 다른 기기에서도 적은 말이 보인다', async ({ browser }) => {
  const id = await seedTurn(REQ2)
  const p = await open(browser, PHONE)
  const card = await chat(p, REQ2)
  await card.getByTestId('onto-entry-decline').click()
  await expect(card.getByTestId('onto-entry-why')).toBeVisible()
  expect(await noOverflow(p), '가로 넘침 없음').toBe(true)
  expect(await chipRows(card.getByTestId('onto-entry-why')), '휴대폰에서도 칩은 한 줄').toBe(1)
  await shot(p, 'f-od-02-why-phone')
  await card.getByTestId('onto-entry-why-text').click()
  const input = card.getByTestId('onto-entry-why-input')
  await expect(input).toBeVisible()
  await expect(input, '「직접 적기」는 칸으로 초점을 옮긴다').toBeFocused()
  await expect(input).toHaveAttribute('aria-label', '아닌 까닭')
  expect(await input.evaluate((el) => getComputedStyle(el).fontSize), 'iOS 가 확대하지 않는 글자 크기').toBe('16px')
  await expect(card.getByTestId('onto-entry-why-send')).toBeDisabled()
  await input.fill('교육 과정 설계라서 요청 보고 업무가 아니에요')
  await shot(p, 'f-od-02-typing-phone')
  await card.getByTestId('onto-entry-why-send').click()
  const saved = card.getByTestId('onto-entry-why-saved')
  await expect(saved).toBeVisible({ timeout: 30000 })
  // no model here: the words are kept, read as no reason the matching uses
  await expect(saved).toHaveAttribute('data-reason', 'other')
  await expect(saved).toBeFocused()
  await expect(card.getByTestId('onto-entry-why-note')).toHaveText('「교육 과정 설계라서 요청 보고 업무가 아니에요」')
  const c = await contentOf(id)
  expect(c.declined.reason).toBe('other')
  expect(c.declined.note).toBe('교육 과정 설계라서 요청 보고 업무가 아니에요')
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'f-od-02-saved-phone')
  const other = await open(browser, PHONE)
  const card2 = await chat(other, REQ2)
  await expect(card2.getByTestId('onto-entry-why-note')).toHaveText('「교육 과정 설계라서 요청 보고 업무가 아니에요」')
  expect(p.errors).toEqual([])
  expect(other.errors).toEqual([])
  await p.context().close(); await other.context().close()
})

const REQ3 = '가나정밀 신입 교육 일정표 만들어 줘'
test('F-OD-03 휴대폰 390(어두운): 왜 아닌지 묻는 줄이 어두운 화면에서 읽힘 → 「맞지만 이번엔 그냥」 → 새로 고쳐도 그대로', async ({ browser }) => {
  const id = await seedTurn(REQ3)
  const p = await open(browser, PHONE, { theme: 'dark' })
  const card = await chat(p, REQ3)
  await card.getByTestId('onto-entry-decline').click()
  const row = card.getByTestId('onto-entry-why')
  await expect(row).toBeVisible()
  // readable on the dark screen: the chip's text is light on a dark chip
  const [fg, bg] = await row.getByTestId('onto-entry-why-notnow').evaluate((b) => [getComputedStyle(b).color, getComputedStyle(b).backgroundColor])
  const lum = (c) => { const [r, g, b] = (c.match(/[\d.]+/g) || []).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  expect(lum(fg), `글자 ${fg} · 바탕 ${bg}`).toBeGreaterThan(150)
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'f-od-03-why-phone-dark')
  await row.getByTestId('onto-entry-why-notnow').click()
  await expect(card.getByTestId('onto-entry-why-saved')).toHaveAttribute('data-reason', 'not-now')
  await expect(card.getByTestId('onto-entry-why-saved')).toContainText('알겠어요. 맞는 요청이면 다음에도 권할게요.')
  expect((await contentOf(id)).declined.reason).toBe('not-now')
  await p.reload()
  const again = await chat(p, REQ3)
  await expect(again.getByTestId('onto-entry-why-saved')).toHaveAttribute('data-reason', 'not-now')
  await shot(p, 'f-od-03-saved-phone-dark')
  expect(p.errors).toEqual([])
  await p.context().close()
})

const REQ4 = '사내 위키 목차를 다시 정리해 줘'
test('F-OD-04 PC: 「넘어가기」 → 묻는 줄이 사라지고, 다시 열어도 묻지 않는다(까닭 없이 거절만)', async ({ browser }) => {
  const id = await seedTurn(REQ4)
  const p = await open(browser, PC)
  const card = await chat(p, REQ4)
  await card.getByTestId('onto-entry-decline').click()
  await card.getByTestId('onto-entry-why-skip').click()
  await expect(card.getByTestId('onto-entry-why')).toHaveCount(0)
  await expect(card.getByTestId('onto-entry-why-saved')).toHaveCount(0)
  await expect(card.getByTestId('onto-entry-declined'), '초점은 거절 줄로').toBeFocused()
  await expect.poll(async () => (await contentOf(id))?.declined?.skipped).toBe(true)
  expect((await contentOf(id)).declined.reason).toBeUndefined()
  const other = await open(browser, PC)
  const card2 = await chat(other, REQ4)
  await expect(card2.getByTestId('onto-entry-declined')).toBeVisible()
  await expect(card2.getByTestId('onto-entry-why')).toHaveCount(0)
  expect(p.errors).toEqual([])
  await p.context().close(); await other.context().close()
})

const REQ5 = '[교육 문의] 신입 사원 교육 과정 견적 부탁드립니다'
test('F-OD-05 메일 카드의 「아니요」도 서버에 남아 다른 기기에서도 거절 — 까닭은 채팅 요청 카드에서만 묻는다', async ({ browser }) => {
  const id = await seedTurn(REQ5, { source: 'mail' })
  const p = await open(browser, PC)
  const card = await chat(p, REQ5)
  await card.getByTestId('onto-entry-decline').click()
  await expect(card.getByTestId('onto-entry-declined')).toBeVisible()
  await expect(card.getByTestId('onto-entry-why')).toHaveCount(0)
  await expect.poll(async () => (await contentOf(id))?.state).toBe('declined')
  const other = await open(browser, PC)
  const card2 = await chat(other, REQ5)
  await expect(card2).toHaveAttribute('data-state', 'declined')
  expect(p.errors).toEqual([])
  await p.context().close(); await other.context().close()
})

const REQ6 = '가나정밀 교육 만족도 설문 정리해 줘'
test('F-OD-06 서버가 받지 않음(409 — 다른 기기에서 이미 시작): 이 기기의 거절을 지우고 묻는 카드로, 「다른 기기에서 이미 시작했어요.」', async ({ browser }) => {
  const id = await seedTurn(REQ6)
  const p = await open(browser, PC)
  const card = await chat(p, REQ6)
  await expect(card).toHaveAttribute('data-state', 'ask')
  // another device pressed 「진행」 meanwhile (this screen has not heard of it)
  await S.q(`update pro_messages set content = content || $2::jsonb where id=$1`, [id, { state: 'started', picked: true, caseId: 'case-od-06' }])
  await card.getByTestId('onto-entry-decline').click()
  const error = card.getByTestId('onto-entry-error')
  await expect(error).toHaveText('다른 기기에서 이미 시작했어요.')
  await expect(error).toHaveAttribute('role', 'alert')
  await expect(card).not.toHaveAttribute('data-state', 'declined')
  await expect(card.getByTestId('onto-entry-why')).toHaveCount(0)
  expect(await p.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').state || null, `onto:entry:${id}`), '이 기기의 거절은 지운다').toBe(null)
  const c = await contentOf(id)
  expect([c.state, c.caseId, c.declined]).toEqual(['started', 'case-od-06', undefined])
  await shot(p, 'f-od-06-refused-pc', card)
  expect(p.errors).toEqual([])
  await p.context().close()
})

const REQ7 = '가나정밀 강사 섭외 목록 만들어 줘'
test('F-OD-07 서버에 닿지 못함(오프라인, 휴대폰): 이 기기에만 남고 「이 기기에만 남겼어요 …」 — 「다음 제안에 반영해요」라고 하지 않는다', async ({ browser }) => {
  const id = await seedTurn(REQ7)
  const p = await open(browser, PHONE)
  const card = await chat(p, REQ7)
  await p.route('**/api/ontology/entry/decline', (r) => r.abort('internetdisconnected'))
  await card.getByTestId('onto-entry-decline').click()
  await expect(card).toHaveAttribute('data-state', 'declined')
  await card.getByTestId('onto-entry-why-unrelated').click()
  const saved = card.getByTestId('onto-entry-why-saved')
  await expect(saved).toHaveAttribute('data-local', '1')
  await expect(saved).toHaveText('이 기기에만 남겼어요 — 서버에 닿지 못해 다음 제안에는 쓰이지 않아요.')
  await expect(saved).not.toContainText('다음 제안에 반영해요')
  await expect(card.getByTestId('onto-entry-error')).toHaveCount(0)
  expect((await contentOf(id)).state, '서버의 카드는 그대로').toBe('ask')
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'f-od-07-offline-phone')
  expect(p.errors).toEqual([])
  await p.context().close()
})
