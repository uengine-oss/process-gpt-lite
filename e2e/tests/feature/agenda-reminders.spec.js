// 약속 알림(2026-11-26 사용자: 「그 메일이나 그 톡에서 유입된 정보를 기반으로 어떤 일정이나 그런 맥락이 파악이 되면 … 해당 일정 때에 해당
// 담당자에게 알림을 … 오늘 모임은 어디에서 하기로 했어요 뭐 이런 식으로 노티가 들어온단 말이야 … 없으면 추가해줘.」, 스펙
// openspec/specs/agenda-reminders). 지어낸 사람: 정하윤 · 김서연 · 이지후(「시니어그룹」 방), 박도윤(방 밖의 팀원).
//   F-AG-01 방의 대화 「다음주 화요일 3시에 강남역 스타벅스에서 봐요」 → 방 사람의 Home 「다가오는 약속」(390 밝은 · 밤, 1280), 방 밖의 사람은 없음
//   F-AG-02 시계를 그날 아침 8시로 → 방 사람에게 알림: Home 카드와 휴대폰 푸시의 글에 곳(강남역 스타벅스), 방 밖의 사람은 없음 →
//           「열기」 → 그 메시지가 열리고, 메시지 아래 약속 표시
//   F-AG-03 「장소 바뀌었어요 역삼역으로」 → 약속이 바뀜(「바뀜」, 열어 둔 Home 의 카드도 다시 열지 않고) → 1시간 전 알림 · 푸시는 새 곳
//   F-AG-04 「모레 오전 10시에 회의실 A에서 견적 리뷰해요」 → 「리뷰 취소됐어요」 → 그때가 와도 알림 없음, 목록에서 빠짐
//   F-AG-05 메일(데모 메일함)의 모임 안내 → 메일함 주인만의 약속 · 알림, 「캘린더에 추가」(데모: 기록), 알림이 그 메일을 연다
//   F-AG-06 「이건 아니에요」 → 내 목록 · 알림에서만 빠지고 피드백이 남는다, 같은 방의 다른 사람에게는 남는다
//   F-AG-07 영어 화면 · 영어 알림(390 밤)
//   F-AG-08 설정 › 계정 › 연결 › 약속 알림: 끄면 알림이 거둬지고, 시작 전 알림의 때를 고른다
// 자기 스택(lib/localStack.js — 회사 agenda-ui, BFF 8983 · Vite 5383 부터 빈 포트, PRO_BACKGROUND=0). 모델은 이 파일의 가짜(OpenAI 호환: 판정의
// 첫 글자 확률 · 메일 비서 · 약속 읽기), 푸시 서비스는 server/test/fixtures/fakePush.mjs, 시계는 PRO_AGENDA_TEST_CLOCK=1 의 시험 전용 길
// (POST /api/agenda/test/tick — 운영은 이 변수를 두지 않는다). 실제 메일 · 실제 기기 · 실제 모델 없음.
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/agenda-reminders.spec.js
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { startStack, REPO, waitFor } from '../../lib/localStack.js'
import { startFakePush } from '../../../server/test/fixtures/fakePush.mjs'

test.describe.configure({ mode: 'serial' })
test.use({ channel: 'chromium' })
const SHOTS = path.join(REPO, 'openspec/specs/agenda-reminders/e2e/results')
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const DESK = { viewport: { width: 1280, height: 800 } }
const NOWHERE = 'http://127.0.0.1:9'
const TENANT = 'agenda-ui'

// ---- the clock: Seoul's calendar from today ----
const seoulDate = (plus) => new Date(Date.now() + 9 * 3600_000 + plus * 864e5).toISOString().slice(0, 10)
const kst = (date, time) => new Date(`${date}T${time}:00+09:00`)
const WD = '일월화수목금토'
const wd = (d) => WD[new Date(`${d}T00:00:00Z`).getUTCDay()]
// next week's Tuesday (weeks start on Monday), as the model counts it from the calendar it is given
const NEXT_TUE = (() => { const t = new Date(`${seoulDate(0)}T00:00:00Z`); const mon = new Date(t); mon.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 7); mon.setUTCDate(mon.getUTCDate() + 1); return mon.toISOString().slice(0, 10) })()
const DAYS_TO_TUE = Math.round((Date.parse(`${NEXT_TUE}T00:00:00Z`) - Date.parse(`${seoulDate(0)}T00:00:00Z`)) / 864e5)
const MORE = seoulDate(2)
const MAIL_DATE = seoulDate(6)
const md = (d) => { const [, m, day] = d.split('-').map(Number); return `${m}월 ${day}일` }
const MEETUP = { from: '시니어그룹 총무 <secretary@senior-group.example>', subject: '12월 정기 모임 안내',
  text: `회원 여러분 안녕하세요.\n이번 정기 모임은 ${md(MAIL_DATE)}(${wd(MAIL_DATE)}) 오후 6시 30분, 강남역 11번 출구 앞 한우정 식당에서 열립니다.\n회비 3만 원을 준비해 주세요.\n온라인으로 함께하실 분은 https://meet.senior-group.example/dec 로 들어오세요.\n\n총무 드림` }

// ---- the fake model ----
const calls = []
const NEW = /\[(새|new)\][^\n]*(스타벅스에서 봐요|장소 바뀌었어요|리뷰해요|취소됐어요|옥상 정원에서 봐요)|(제목|Subject): 12월 정기 모임/
function readPlans(input) {
  const day = (pick) => (input.calendar.find(pick) || '').split(' ')[0]
  const fresh = (input.messages || []).filter((m) => m.new)
  const said = (s) => fresh.find((m) => m.text.includes(s))
  const plan = (pred) => input.plans.find(pred)?.key
  if (input.where === 'mail') {
    return input.mail.subject.includes('정기 모임') ? [{ op: 'create', title: '12월 정기 모임', date: MAIL_DATE, start: '18:30', allDay: false, location: '강남역 11번 출구 앞 한우정', bring: '회비 3만 원', link: 'https://meet.senior-group.example/dec', for: 'all', message: '', basis: '오후 6시 30분' }] : []
  }
  const ops = []
  let m
  if ((m = said('스타벅스에서 봐요'))) ops.push({ op: 'create', title: '시니어그룹 모임', date: day((s) => s.includes('(화) · 다음 주')), start: '15:00', allDay: false, location: '강남역 스타벅스', for: 'all', message: m.key, basis: m.text })
  if ((m = said('장소 바뀌었어요'))) ops.push({ op: 'update', plan: plan((p) => p.location.includes('스타벅스')), location: '역삼역', message: m.key, basis: m.text })
  if ((m = said('리뷰해요'))) ops.push({ op: 'create', title: '견적 리뷰', date: day((s) => s.includes('· 모레')), start: '10:00', allDay: false, location: '회의실 A', for: 'all', message: m.key, basis: m.text })
  if ((m = said('취소됐어요'))) ops.push({ op: 'cancel', plan: plan((p) => p.title.includes('리뷰')), message: m.key, basis: m.text })
  if ((m = said('옥상 정원에서 봐요'))) ops.push({ op: 'create', title: '사진 촬영', date: day((s) => s.includes('· 모레')), start: '17:00', allDay: false, location: '옥상 정원', for: 'all', message: m.key, basis: m.text })
  return ops
}
async function startModel() {
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let b = {}
      try { b = JSON.parse(raw) } catch { /* none */ }
      const sys = String(b.messages?.[0]?.content || ''), user = String(b.messages?.[1]?.content || '')
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
      const answer = (o) => json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(o) }, finish_reason: 'stop' }] })
      // the first-token odds (lib/decide.js): A 있다 · B 없다
      if (b.max_tokens === 1 && b.logprobs) {
        const yes = NEW.test(sys)
        calls.push({ kind: 'gate', yes })
        const p = yes ? 0.95 : 0.03
        return json({ choices: [{ message: { content: yes ? 'A' : 'B' }, logprobs: { content: [{ token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(p) }, { token: 'B', logprob: Math.log(1 - p) }] }] } }] })
      }
      // the mail assistant (lib/mail.js): a calendar card for the meetup mail only
      if (sys.startsWith("You read a user's newest emails")) {
        const mails = JSON.parse(user || '[]')
        return answer({ actions: mails.filter((x) => String(x.subject).includes('정기 모임')).map((x) => ({ mail_id: x.id, verb: 'Add', kind: 'calendar', text: '12월 정기 모임을 캘린더에 추가합니다', icon_domain: '', due: null, prompt: '정기 모임 일정을 캘린더에 추가해 주세요.' })), brief: '', drafts: [] })
      }
      if (sys.startsWith('대화방의 새 메시지나 새 메일에서')) {
        const input = JSON.parse(user)
        const ops = readPlans(input)
        calls.push({ kind: 'read', where: input.where, ops })
        return answer({ ops })
      }
      answer({})
    })
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => new Promise((ok) => srv.close(ok)) }
}

let S, P, M, HY, SY, JH, DY, ROOM, FIRST
test.beforeAll(async () => {
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  P = await startFakePush()
  M = await startModel()
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8983, webFrom: Number(process.env.RT_WEB_FROM) || 5383,
    env: { PRO_LLM_BASE_URL: M.url, PRO_LLM_API_KEY: 'test', PRO_LLM_ODDS_MODEL: '', PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: '', PRO_JUDGE_URL: '',
      PRO_MEMENTO_URL: NOWHERE, PRO_ONTOLOGY_BOLT_URL: '', PRO_NOTIFY_FEED: '1', PRO_PUSH_ALLOW_ORIGINS: P.origin, PRO_VAPID_FILE: path.join(os.tmpdir(), `pgl-vapid-${TENANT}-${process.pid}.json`),
      PRO_AGENDA_TEST_CLOCK: '1', PRO_AGENDA_QUIET_MS: '700',
      // (next week's Tuesday is 8–9 days off on a Monday or a Tuesday run: the list then looks a little further)
      ...(DAYS_TO_TUE > 6 ? { PRO_AGENDA_UPCOMING_DAYS: '14' } : {}) } })
  HY = await S.person(`pro-rt-${TENANT}-a@people-mail.test`, '정하윤')
  SY = await S.person(`pro-rt-${TENANT}-b@people-mail.test`, '김서연')
  JH = await S.person(`pro-rt-${TENANT}-c@people-mail.test`, '이지후')
  DY = await S.person(`pro-rt-${TENANT}-d@people-mail.test`, '박도윤')
  for (const p of [HY, SY, JH, DY]) await S.join(p)
  // (the test clock answers an administrator only — routes/agenda.js)
  await S.q('update users set is_admin=true where id=$1 and tenant_id=$2', [HY.id, TENANT])
  await clean()
  for (const p of [HY, SY, JH, DY]) await S.api(p.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
  const sub = P.subscription('hy')
  await S.q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,'e2e phone')`, [sub.endpoint, HY.id, TENANT, sub.keys.p256dh, sub.keys.auth])
  const dy = P.subscription('dy')
  await S.q(`insert into pro_push_subscriptions(endpoint, user_id, tenant_id, p256dh, auth, ua) values ($1,$2,$3,$4,$5,'e2e phone')`, [dy.endpoint, DY.id, TENANT, dy.keys.p256dh, dy.keys.auth])
})
async function clean() {
  const ids = [HY, SY, JH, DY].filter(Boolean).map((p) => p.id)
  for (const sql of [`delete from notifications where tenant_id=$1`, `delete from notifications where url in (select '/chats?id=' || id from chat_rooms where tenant_id=$1)`,
    'delete from pro_push_subscriptions where tenant_id=$1', 'delete from pro_agenda_items where tenant_id=$1', 'delete from pro_agenda_rooms where tenant_id=$1',
    'delete from chats where tenant_id=$1', 'delete from pro_chat_reads where room_id in (select id from chat_rooms where tenant_id=$1)', 'delete from chat_rooms where tenant_id=$1']) await S.q(sql, [TENANT]).catch(() => {})
  for (const t of ['pro_actions', 'pro_demo_mail', 'pro_mail_seen', 'pro_mail_accounts']) await S.q(`delete from ${t} where user_id = any($1::uuid[])`, [ids]).catch(() => {})
  await S.q('delete from pro_mail_archive where tenant_id=$1', [TENANT]).catch(() => {})
  await S.q('update pro_profile set agenda = null where user_id = any($1::uuid[])', [ids]).catch(() => {})
}
test.afterAll(async () => {
  if (S) {
    await clean().catch(() => {})
    // (the test accounts leave this company's team, and their chats' lines — the mailbox connection's — go)
    const ids = [HY, SY, JH, DY].filter(Boolean).map((p) => p.id)
    await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id = any($1::uuid[]))', [ids]).catch(() => {})
    await S.q('delete from pro_team_members where tenant_id=$1', [TENANT]).catch(() => {})
    await S.q('update users set is_admin=false where tenant_id=$1', [TENANT]).catch(() => {})
    await S.stop()
  }
  await P?.close(); await M?.close()
})

async function open(browser, who, { opts = PHONE, theme = 'light', lang = 'ko' } = {}) {
  const ctx = await browser.newContext({ ...opts, locale: lang === 'en' ? 'en-US' : 'ko-KR', baseURL: S.web })
  await ctx.addInitScript(([s, th, lg]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
    localStorage.setItem('pgl-lang', lg)
    localStorage.setItem('pgl-install', JSON.stringify({ never: true }))
    if (window.PushManager) { PushManager.prototype.subscribe = () => Promise.reject(new Error('e2e: no push service')); PushManager.prototype.getSubscription = () => Promise.resolve(null) }
  }, [JSON.stringify(who.session), theme, lang])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (p, name) => { await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
async function home(p, { phone = true } = {}) {
  // (the page has booted once it asked for 「다가오는 약속」 — on a busy machine that can take longer than an assertion waits)
  const booted = p.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/agenda') && r.request().method() === 'GET', { timeout: 45000 }).catch(() => null)
  await p.goto('/chat')
  await booted
  if (phone) await p.locator('.seg button').filter({ hasText: /^(홈|Home)$/ }).click()
}
const say = (who, text) => S.api(who.token, `/team/threads/${ROOM}/messages`, { method: 'POST', body: { text } })
const agendaOf = (who) => S.api(who.token, '/agenda')
const tickAs = (who, now) => fetch(`http://127.0.0.1:${S.apiPort}/api/agenda/test/tick`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.token}` } : {}) }, body: JSON.stringify({ now: now.toISOString() }) })
const tick = async (now) => {
  const r = await tickAs(HY, now)
  if (!r.ok) throw new Error(`tick ${r.status} ${await r.text()}`)
  return (await r.json()).sent
}
const notices = (who) => S.q(`select title, description, url from notifications where tenant_id=$1 and type='agenda' and user_id=$2 order by time_stamp`, [TENANT, who.id])
const pushed = (who, pick, ms = 20000) => waitFor(async () => (await P.payloads(who, 1, 200)).find(pick), ms, 'a push')

test('F-AG-01 방의 대화에서 정한 약속이 방 사람의 「다가오는 약속」에 — 방 밖의 사람에게는 없음', async ({ browser }) => {
  ROOM = (await S.api(HY.token, '/team/threads', { method: 'POST', body: { members: [SY.id, JH.id], title: '시니어그룹' } })).id
  FIRST = (await say(SY, '다음주 화요일 3시에 강남역 스타벅스에서 봐요')).id
  await say(HY, '좋아요!')
  const item = await waitFor(async () => (await agendaOf(HY)).items.find((x) => x.title === '시니어그룹 모임'), 30000, 'the plan')
  expect(item.date).toBe(NEXT_TUE)
  expect(item.start).toBe('15:00')
  expect(item.location).toBe('강남역 스타벅스')
  expect(item.source).toMatchObject({ kind: 'room', title: '시니어그룹', roomId: ROOM, messageId: FIRST, label: '「시니어그룹」 대화' })
  // one gate and one reading for the burst of two messages
  expect(calls.filter((c) => c.kind === 'read').length).toBe(1)
  for (const who of [SY, JH]) expect((await agendaOf(who)).items.map((x) => x.title)).toContain('시니어그룹 모임')
  expect((await agendaOf(DY)).items).toEqual([])
  const [rem] = await S.q(`select count(*)::int n from pro_agenda_reminders r join pro_agenda_items i on i.id=r.item_id where i.tenant_id=$1`, [TENANT])
  expect(rem.n).toBe(6) // three people × (the morning · an hour before)

  for (const theme of ['light', 'dark']) {
    const p = await open(browser, HY, { theme })
    await home(p)
    const card = p.locator('[data-test="agenda-card"]')
    await expect(card).toContainText('다가오는 약속')
    const it = card.locator('[data-test="agenda-item"]').first()
    await expect(it.locator('[data-test="agenda-title"]')).toHaveText('시니어그룹 모임')
    await expect(it.locator('.day small')).toHaveText('화')
    await expect(it.locator('[data-test="agenda-when"]')).toContainText('강남역 스타벅스')
    await expect(it.locator('[data-test="agenda-when"]')).toContainText('오후 3:00')
    await expect(it.locator('[data-test="agenda-source"]')).toContainText('「시니어그룹」 대화')
    await expect(it.locator('[data-test="agenda-dismiss"]')).toHaveText('이건 아니에요')
    // no mailbox, no Google: no 「캘린더에 추가」
    await expect(it.locator('[data-test="agenda-calendar"]')).toHaveCount(0)
    expect(await noOverflow(p)).toBe(true)
    await shot(p, `f-ag-01-home-${theme}`)
    expect(p.errors).toEqual([])
    await p.context().close()
  }
  const d = await open(browser, HY, { opts: DESK })
  await home(d, { phone: false })
  await expect(d.locator('[data-test="agenda-card"]')).toContainText('시니어그룹 모임')
  await shot(d, 'f-ag-01-home-1280')
  await d.context().close()
  const out = await open(browser, DY)
  await home(out)
  await expect(out.locator('.dock')).toBeVisible()
  await expect(out.locator('[data-test="agenda-card"]')).toHaveCount(0)
  await out.context().close()
})

test('F-AG-02 그날 아침 8시: Home 카드와 푸시의 글에 곳, 「열기」는 그 메시지를 연다', async ({ browser }) => {
  // (the test clock: not without a sign-in, not for someone who is not an administrator — review #6)
  expect((await tickAs(null, kst(NEXT_TUE, '08:00'))).status).toBe(401)
  expect((await tickAs(SY, kst(NEXT_TUE, '08:00'))).status).toBe(403)
  const sent = await tick(kst(NEXT_TUE, '08:00'))
  expect(sent.map((x) => x.outcome)).toEqual(['sent', 'sent', 'sent'])
  const [n] = await notices(HY)
  expect(n.title).toBe('오늘 오후 3:00 · 시니어그룹 모임')
  expect(n.description).toContain('오늘 오후 3:00 시니어그룹 모임은 강남역 스타벅스에서 하기로 했어요.')
  expect(n.description).toContain('「시니어그룹」 대화에서 정했어요.')
  expect(n.url).toBe(`/pro/team/${ROOM}/${FIRST}`)
  const push = await pushed('hy', (x) => x.type === 'agenda')
  expect(push.title).toBe('오늘 오후 3:00 · 시니어그룹 모임')
  expect(push.body).toContain('강남역 스타벅스에서 하기로 했어요')
  expect(push.url).toBe(`/pro/team/${ROOM}/${FIRST}`)
  expect(await notices(DY)).toEqual([])
  expect((await P.payloads('dy', 1, 300)).filter((x) => x.type === 'agenda')).toEqual([])

  const p = await open(browser, HY)
  await home(p)
  const card = p.locator('[data-test="notice-card"]').filter({ hasText: '시니어그룹 모임' })
  await expect(card).toContainText('약속')
  await expect(card).toContainText('강남역 스타벅스에서 하기로 했어요')
  await expect(card).toContainText('약속 알림')
  await shot(p, 'f-ag-02-notice')
  await card.locator('button').filter({ hasText: '열기' }).click()
  const msgr = p.locator('[data-test="messenger"]')
  await expect(msgr).toBeVisible()
  const bubble = msgr.locator(`.msg[data-id="${FIRST}"]`)
  await expect(bubble).toContainText('강남역 스타벅스에서 봐요')
  await expect(msgr.locator('[data-test="agenda-mark"]').first()).toContainText('시니어그룹 모임')
  await shot(p, 'f-ag-02-opened-message')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-AG-03 「장소 바뀌었어요 역삼역으로」 → 약속이 바뀌고(열어 둔 Home 의 카드도 그 자리에서), 1시간 전 알림은 새 곳으로', async ({ browser }) => {
  // 정하윤's Home is open while the change is read: the card changes in place, without opening Home again (the 'agenda' event —
  // 11-27, found recording the feature video: the page did not listen for it, so a new · changed plan showed only after a reload)
  const p = await open(browser, HY)
  await home(p)
  const it = p.locator('[data-test="agenda-item"]').filter({ hasText: '시니어그룹 모임' })
  await expect(it).toContainText('강남역 스타벅스')
  const changed = (await say(SY, '장소 바뀌었어요 역삼역으로')).id
  const item = await waitFor(async () => (await agendaOf(HY)).items.find((x) => x.title === '시니어그룹 모임' && x.location === '역삼역'), 30000, 'the change')
  expect(item.changed).toBe(true)
  expect(item.start).toBe('15:00')
  expect(item.source.messageId).toBe(changed)
  await expect(it).toContainText('역삼역', { timeout: 15_000 })
  await expect(it).toContainText('바뀜')
  await shot(p, 'f-ag-03-changed')
  await p.context().close()
  const sent = await tick(kst(NEXT_TUE, '14:00'))
  expect(sent.map((x) => `${x.slot}:${x.outcome}`)).toEqual(['before:sent', 'before:sent', 'before:sent'])
  const last = (await notices(SY)).at(-1)
  expect(last.title).toBe('1시간 뒤 · 시니어그룹 모임')
  expect(last.description).toContain('역삼역에서 하기로 했어요')
  expect(last.description).not.toContain('스타벅스')
  const push = await pushed('hy', (x) => x.type === 'agenda' && x.title.startsWith('1시간 뒤'))
  expect(push.body).toContain('역삼역에서 하기로 했어요')
  expect(push.url).toBe(`/pro/team/${ROOM}/${changed}`)
})

test('F-AG-04 「리뷰 취소됐어요」 → 그 약속은 목록에서 빠지고, 그때가 와도 알리지 않는다', async () => {
  await say(JH, '모레 오전 10시에 회의실 A에서 견적 리뷰해요')
  const item = await waitFor(async () => (await agendaOf(HY)).items.find((x) => x.title === '견적 리뷰'), 30000, 'the review')
  expect([item.date, item.start, item.location]).toEqual([MORE, '10:00', '회의실 A'])
  await say(JH, '리뷰 취소됐어요')
  await waitFor(async () => !(await agendaOf(HY)).items.some((x) => x.title === '견적 리뷰'), 30000, 'the cancel')
  const [row] = await S.q(`select status, history from pro_agenda_items where tenant_id=$1 and title='견적 리뷰'`, [TENANT])
  expect(row.status).toBe('cancelled')
  expect(row.history.map((h) => h.op)).toEqual(['create', 'cancel'])
  const before = (await notices(HY)).length
  expect(await tick(kst(MORE, '08:00'))).toEqual([])
  expect(await tick(kst(MORE, '09:00'))).toEqual([])
  expect((await notices(HY)).length).toBe(before)
})

test('F-AG-05 메일의 모임 안내 → 메일함 주인만의 약속 · 알림, 캘린더에 기록, 알림이 그 메일을 연다', async ({ browser }) => {
  await S.api(HY.token, '/mail/connect', { method: 'POST', body: { provider: 'demo' } })
  await S.api(HY.token, '/mail/demo-arrive', { method: 'POST', body: MEETUP })
  const item = await waitFor(async () => (await agendaOf(HY)).items.find((x) => x.title === '12월 정기 모임'), 30000, 'the mail plan')
  expect([item.date, item.start, item.location, item.bring]).toEqual([MAIL_DATE, '18:30', '강남역 11번 출구 앞 한우정', '회비 3만 원'])
  expect(item.source).toMatchObject({ kind: 'mail', subject: '12월 정기 모임 안내', label: '메일 · 12월 정기 모임 안내' })
  expect(item.source.actionId).toBeTruthy()
  for (const who of [SY, JH, DY]) expect((await agendaOf(who)).items.some((x) => x.title === '12월 정기 모임')).toBe(false)
  const sent = await tick(kst(MAIL_DATE, '08:00'))
  expect(sent.map((x) => `${x.user === HY.id ? 'HY' : 'other'}:${x.outcome}`)).toEqual(['HY:sent'])
  const n = (await notices(HY)).at(-1)
  expect(n.title).toBe('오늘 오후 6:30 · 12월 정기 모임')
  expect(n.description).toContain('강남역 11번 출구 앞 한우정에서 하기로 했어요')
  expect(n.description).toContain('챙길 것: 회비 3만 원')
  expect(n.description).toContain('메일 「12월 정기 모임 안내」에서 읽었어요.')
  expect(n.url).toMatch(/^\/pro\/mail\//)
  // the mail's link is the sender's word: not in the notice (Home · push) — review #1
  expect(n.description).not.toContain('meet.senior-group.example')
  for (const who of [SY, JH, DY]) expect((await notices(who)).some((x) => x.title.includes('정기 모임'))).toBe(false)

  const p = await open(browser, HY)
  await home(p)
  const it = p.locator('[data-test="agenda-item"]').filter({ hasText: '12월 정기 모임' })
  await expect(it).toContainText('챙길 것')
  await expect(it.locator('[data-test="agenda-source"]')).toContainText('메일 · 12월 정기 모임 안내')
  // …but on the card, by its domain and with who sent it
  await expect(it.locator('[data-test="agenda-link"]')).toContainText('링크 · meet.senior-group.example')
  await expect(it.locator('[data-test="agenda-link-from"]')).toHaveText('secretary@senior-group.example')
  // a demo mailbox: 「캘린더에 추가」 records it
  await it.locator('[data-test="agenda-calendar"]').click()
  await expect(it.locator('[data-test="agenda-in-calendar"]')).toHaveText('캘린더에 기록했어요')
  await shot(p, 'f-ag-05-mail-plan')
  // the reminder opens its mail
  await p.locator('[data-test="notice-card"]').filter({ hasText: '12월 정기 모임' }).locator('button').filter({ hasText: '열기' }).click()
  await expect(p.locator('[data-test="mail-sheet"]')).toBeVisible()
  await expect(p.locator('[data-test="mail-sheet"]')).toContainText('12월 정기 모임 안내')
  await shot(p, 'f-ag-05-mail-opened')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-AG-06 「이건 아니에요」 → 내 목록과 알림에서만 빠지고 피드백이 남는다', async ({ browser }) => {
  const p = await open(browser, HY)
  await home(p)
  const mine = (await agendaOf(HY)).items
  const mail = mine.find((x) => x.title === '12월 정기 모임')
  const room = mine.find((x) => x.title === '시니어그룹 모임')
  // the mail's plan (mine alone): off my list, its reminders taken back, the reading recorded as wrong
  await p.locator(`[data-test="agenda-item"][data-id="${mail.id}"] [data-test="agenda-dismiss"]`).click()
  await expect(p.locator(`[data-test="agenda-item"][data-id="${mail.id}"]`)).toHaveCount(0)
  // (the card goes at once; the server's answer follows)
  const fb = await waitFor(async () => (await S.q('select verdict, item from pro_agenda_feedback where item_id=$1 and user_id=$2', [mail.id, HY.id]))[0], 10000, 'the feedback')
  expect(fb.verdict).toBe('not_a_plan')
  expect(fb.item.title).toBe('12월 정기 모임')
  const [st] = await S.q('select status from pro_agenda_items where id=$1', [mail.id])
  expect(st.status).toBe('dismissed')
  const rs = await S.q(`select outcome from pro_agenda_reminders where item_id=$1 and sent_at is null`, [mail.id])
  expect(rs.length && rs.every((x) => x.outcome === 'dismissed')).toBeTruthy()
  expect(await tick(kst(MAIL_DATE, '17:30'))).toEqual([])
  // the room's plan put away by one: the others in the room keep it
  await p.locator(`[data-test="agenda-item"][data-id="${room.id}"] [data-test="agenda-dismiss"]`).click()
  await expect(p.locator(`[data-test="agenda-item"][data-id="${room.id}"]`)).toHaveCount(0)
  await waitFor(async () => (await S.q('select 1 from pro_agenda_feedback where item_id=$1 and user_id=$2', [room.id, HY.id])).length, 10000, 'the second feedback')
  expect((await agendaOf(SY)).items.some((x) => x.id === room.id)).toBe(true)
  expect((await agendaOf(HY)).items.some((x) => x.id === room.id)).toBe(false)
  await shot(p, 'f-ag-06-dismissed')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-AG-07 영어 화면 · 영어 알림', async ({ browser }) => {
  await S.api(SY.token, '/me/lang', { method: 'PUT', body: { lang: 'en' } })
  await say(JH, '모레 오전 10시에 회의실 A에서 견적 리뷰해요')
  const item = await waitFor(async () => (await S.api(SY.token, '/agenda')).items.find((x) => x.title === '견적 리뷰'), 30000, 'the review again')
  const p = await open(browser, SY, { theme: 'dark', lang: 'en' })
  await home(p)
  const card = p.locator('[data-test="agenda-card"]')
  await expect(card).toContainText('Upcoming plans')
  const it = card.locator(`[data-test="agenda-item"][data-id="${item.id}"]`)
  await expect(it.locator('[data-test="agenda-dismiss"]')).toHaveText('Not a plan')
  await expect(it.locator('.day small')).toHaveText(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${MORE}T00:00:00Z`).getUTCDay()])
  await expect(it.locator('[data-test="agenda-when"]')).toContainText('10:00 AM')
  await expect(it.locator('[data-test="agenda-source"]')).toContainText('“시니어그룹” conversation')
  expect(await noOverflow(p)).toBe(true)
  await shot(p, 'f-ag-07-home-en-dark')
  const morning = await tick(kst(MORE, '08:00'))
  expect(morning.filter((x) => x.user === SY.id).map((x) => `${x.slot}:${x.outcome}`)).toEqual(['day:sent'])
  // (the clock is that morning: 「Today」)
  expect((await notices(SY)).at(-1).title).toBe('Today, 10:00 AM · 견적 리뷰')
  const sent = await tick(kst(MORE, '09:00'))
  expect(sent.filter((x) => x.user === SY.id).map((x) => `${x.slot}:${x.outcome}`)).toEqual(['before:sent'])
  const n = (await notices(SY)).at(-1)
  expect(n.title).toBe('in 1 hr · 견적 리뷰')
  expect(n.description).toContain('견적 리뷰 is at 회의실 A, as agreed.')
  expect(n.description).toContain('Agreed in the “시니어그룹” conversation.')
  await p.reload()
  await home(p)
  const notice = p.locator('[data-test="notice-card"].agenda').filter({ hasText: 'in 1 hr · 견적 리뷰' })
  await expect(notice).toContainText('as agreed')
  await expect(notice).toContainText('Plan reminders')
  await notice.scrollIntoViewIfNeeded()
  await shot(p, 'f-ag-07-notice-en-dark')
  await p.context().close()
  await S.api(SY.token, '/me/lang', { method: 'PUT', body: { lang: 'ko' } })
})

test('F-AG-08 설정 › 계정 › 연결 › 약속 알림: 끄면 알림이 거둬지고, 시작 전 알림의 때를 고른다', async ({ browser }) => {
  await say(SY, '모레 오후 5시에 옥상 정원에서 봐요, 단체 사진 찍어요')
  await waitFor(async () => (await agendaOf(JH)).items.some((x) => x.title === '사진 촬영'), 30000, 'a plan of 이지후')
  const pending = async () => (await S.q(`select r.slot, r.due_at from pro_agenda_reminders r where r.user_id=$1 and r.sent_at is null and r.cancelled_at is null`, [JH.id]))
  for (const theme of ['light', 'dark']) {
    const p = await open(browser, JH, { theme })
    await p.goto('/settings/accounts')
    const row = p.locator('[data-test="agenda-settings"]')
    await expect(row).toContainText('약속 알림 · 켜짐')
    await expect(row).toContainText('그날 아침 8시와 시작 전에')
    await expect(row.locator('[data-test="agenda-lead"]')).toHaveValue('60')
    expect(await noOverflow(p)).toBe(true)
    await row.scrollIntoViewIfNeeded()
    await shot(p, `f-ag-08-settings-${theme}`)
    await p.context().close()
  }
  const p = await open(browser, JH)
  await p.goto('/settings/accounts')
  const row = p.locator('[data-test="agenda-settings"]')
  const before = (await pending()).find((x) => x.slot === 'before')
  await row.locator('[data-test="agenda-lead"]').selectOption('30')
  await expect.poll(async () => (await S.api(JH.token, '/agenda/prefs')).leadMin).toBe(30)
  // (the reminder is armed again once the save is done)
  const moved = await waitFor(async () => (await pending()).find((x) => x.slot === 'before'), 10000, 'the moved reminder')
  expect(moved.due_at.getTime() - before.due_at.getTime()).toBe(30 * 60000)
  await row.locator('[data-test="agenda-switch"]').click()
  await expect(row).toHaveAttribute('data-on', '0')
  await expect(row).toContainText('약속 알림 · 꺼짐')
  expect(await pending()).toEqual([])
  await row.locator('[data-test="agenda-switch"]').click()
  await expect(row).toHaveAttribute('data-on', '1')
  expect((await pending()).length).toBeGreaterThan(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})
