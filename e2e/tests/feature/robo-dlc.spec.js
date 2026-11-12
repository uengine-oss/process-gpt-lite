// Robo-DLC Lite — AI-DLC 대시보드 패널: AI-DLC 저장소를 연결형 공유 폴더로 붙이면 폴더 구성원이 홈 패널로
// 작업 현황·사람 대기·볼트·품질·감사 기록·질문을 본다. 기록은 작업 사본에서 바로 읽고 패널은 20초마다 다시 그린다.
// (spec pgpt-pro_aidlc-dashboards · 설계 docs/robo-dlc/plan.md)
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { test, expect, RUN, api } from '../../lib/fixtures.js'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../server/test/fixtures/aidlc-project')
const SCREEN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../server/test/fixtures/aidlc-screens/approval.txt')
// the team session's tmux (server/config.js aidlcTmuxSocket) and a stand-in for Claude Code in it:
// a prompt screen that records every key it gets (docs/robo-dlc/plan-team.md)
const tmux = (...a) => execFileSync('tmux', ['-L', process.env.PRO_AIDLC_TMUX_SOCKET || 'pgpt-aidlc', ...a], { encoding: 'utf8' })
async function fakeSession(repo, slug, cleanup) {
  const name = `aidlc-${process.env.PGPT_TENANT || 'localhost'}-${slug}`.replace(/[^A-Za-z0-9_-]/g, '_')
  const keys = path.join(repo, '.keys.log')
  const script = path.join(repo, '.fake-claude.sh')
  await fs.writeFile(script, `#!/bin/bash\ncat ${JSON.stringify(SCREEN)}\nwhile IFS= read -rsn1 k; do printf '%s' "$k" >> ${JSON.stringify(keys)}; done\n`, { mode: 0o755 })
  tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '48', script)
  cleanup(async () => { try { tmux('kill-session', '-t', name) } catch { /* gone */ } })
  return { name, keys }
}

// a fresh git repository holding the fixture record, linked as a shared folder by `owner`
async function linkedRecord(owner, db, cleanup, name, fixture = FIXTURE) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-rt-'))
  await fs.cp(fixture, repo, { recursive: true })
  const git = (...a) => execFileSync('git', ['-c', 'user.name=rt', '-c', 'user.email=rt@pgpt.test', ...a], { cwd: repo })
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'AI-DLC record')
  const r = await owner.post('/folders/link', { path: repo, name: `${name} ${RUN}` })
  expect(r.status, r.text).toBe(200)
  cleanup(async () => {
    await db.q('delete from pro_folder_members where folder_id in (select id from pro_folders where repo_path=$1)', [path.resolve(repo)])
    await db.q('delete from pro_folders where repo_path=$1', [path.resolve(repo)])
    await fs.rm(repo, { recursive: true, force: true })
  })
  return { repo, folder: r.body }
}

async function clearAidlcPanels(user, cleanup) {
  cleanup(async () => {
    for (const p of (await user.get('/panels')).body || []) if (p.spec?.aidlc) await user.del(`/panels/${p.id}`)
  })
}

test.describe('Robo-DLC Lite · AI-DLC 대시보드', () => {
  test('F-RD-01 폴더의 띠에서 「홈에 대시보드 추가」 → 홈에 패널 6개, 작업 현황에 실제 수치', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('rd-owner')
    const o = page.user
    const { folder } = await linkedRecord(o, db, cleanup, 'AI-DLC 회귀')
    await clearAidlcPanels(o, cleanup)
    await page.goto(`/folders/${folder.slug}`)
    const banner = page.locator('[data-test="aidlc-banner"]')
    await expect(banner).toContainText('AI-DLC 기록이 있어요')
    await expect(banner).toContainText('작업 2개')
    await banner.locator('select').selectOption('default/voice-parking')
    await banner.getByRole('button', { name: '홈에 대시보드 추가' }).click()
    await expect(page.getByText('홈에 AI-DLC 대시보드 6개를 추가했어요.')).toBeVisible()
    const panels = (await o.get('/panels')).body.filter((p) => p.spec?.aidlc)
    expect(panels.map((p) => p.spec.aidlc).sort()).toEqual(['bolts', 'quality', 'questions', 'status', 'timeline', 'wait'])
    await page.goto('/')
    const status = page.locator('.panel', { hasText: 'AI-DLC 작업 현황' }).first()
    await expect(status).toBeVisible({ timeout: 30_000 })
    const frame = status.frameLocator('iframe')
    await expect(frame.locator('#cur')).toHaveText('빌드·테스트', { timeout: 30_000 })
    await expect(frame.locator('#na')).toHaveText('18')
    await expect(frame.locator('#nr')).toHaveText('3')
    const bolts = page.locator('.panel', { hasText: '볼트 보드' }).first().frameLocator('iframe')
    await expect(bolts.locator('#list')).toContainText('u3-payment-service')
    expect(page.errors).toEqual([])
  })

  test('F-RD-02 폴더 구성원이 아니면 프로젝트도 요약도 보이지 않는다', async ({ as, db, cleanup }) => {
    const o = await as('rd-owner')
    const out = await as('rd-out')
    const { folder } = await linkedRecord(o, db, cleanup, 'AI-DLC 권한')
    expect((await o.get('/aidlc/projects')).body.some((p) => p.folder === folder.slug)).toBe(true)
    expect((await out.get('/aidlc/projects')).body.some((p) => p.folder === folder.slug)).toBe(false)
    expect((await out.get(`/aidlc/${folder.slug}/intents/default/voice-parking/summary`)).status).toBe(403)
    expect((await out.post(`/aidlc/${folder.slug}/panels`, { space: 'default', slug: 'voice-parking' })).status).toBe(403)
  })

  test('F-RD-03 작업 사본에 승인 대기가 생기면 패널이 스스로 다시 그린다', async ({ pageAs, db, cleanup }) => {
    test.setTimeout(120_000)
    const page = await pageAs('rd-live')
    const o = page.user
    const { repo, folder } = await linkedRecord(o, db, cleanup, 'AI-DLC 실시간')
    await clearAidlcPanels(o, cleanup)
    const r = await o.post(`/aidlc/${folder.slug}/panels`, { space: 'default', slug: 'todo-web-app', kinds: ['status'] })
    expect(r.status, r.text).toBe(200)
    await page.goto('/')
    const frame = page.locator('.panel', { hasText: 'AI-DLC 작업 현황' }).first().frameLocator('iframe')
    await expect(frame.locator('#wait')).toContainText('기다리는 승인이 없어요', { timeout: 30_000 })
    const dir = path.join(repo, 'aidlc/spaces/default/intents/261109-todo-web-app/audit')
    const [shard] = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'))
    await fs.appendFile(path.join(dir, shard), `\n---\n\n## Stage Awaiting Approval\n**Timestamp**: ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}\n**Event**: STAGE_AWAITING_APPROVAL\n**Stage**: requirements-analysis\n`)
    await expect(frame.locator('#wait')).toContainText('요구사항', { timeout: 40_000 })
    await expect(frame.locator('#wait')).toContainText('PO·기획')
  })

  test('F-RD-04 팀 세션: 역할을 맡기면 세션의 승인 창이 PO 카드로 오고, 결정 화면의 「Approve」가 세션에 1 로 들어간다', async ({ pageAs, as, db, cleanup }) => {
    test.setTimeout(120_000)
    const lead = await as('rd-lead')
    const page = await pageAs('rd-po')
    const po = page.user
    const { repo, folder } = await linkedRecord(lead, db, cleanup, 'AI-DLC 팀')
    cleanup(async () => {
      const [f] = await db.q('select id from pro_folders where repo_path=$1', [path.resolve(repo)])
      if (f) for (const t of ['pro_aidlc_roles', 'pro_aidlc_decisions', 'pro_aidlc_waits']) await db.q(`delete from ${t} where folder_id=$1`, [f.id])
      await db.q(`update notifications set is_checked=true where type='aidlc' and url like $1`, [`/aidlc/${folder.slug}/%`])
    })
    expect((await lead.post(`/folders/${folder.slug}/members`, { type: 'user', id: po.id, role: 'editor' })).status).toBe(200)
    // the role is set on the folder screen's role sheet
    const lp = await pageAs('rd-lead')
    await lp.goto(`/folders/${folder.slug}`)
    await lp.locator('[data-test="aidlc-team"]').getByRole('button', { name: '역할' }).click()
    const sheet = lp.locator('[data-test="aidlc-role-sheet"]')
    await sheet.locator('.role-row', { hasText: 'PO·기획' }).getByRole('button', { name: po.name || /rd-po/ }).click()
    await expect(sheet.locator('.role-row', { hasText: 'PO·기획' }).locator('.chip.on')).toHaveCount(1)
    const { keys } = await fakeSession(repo, folder.slug, cleanup)
    // the watcher's card on the PO's Home opens the decision page (made within a scan or two; a development
    // server without the notification feed only shows it on the next load, so the page opens once it is there)
    await expect.poll(async () => ((await po.get('/notifications')).body || []).some((n) => n.type === 'aidlc' && /승인/.test(n.title) && String(n.url).startsWith(`/aidlc/${folder.slug}/`)), { timeout: 45_000 }).toBe(true)
    await page.goto('/')
    const card = page.locator('.nc.aidlc', { hasText: '승인' }).first()
    await expect(card).toBeVisible({ timeout: 45_000 })
    await card.getByRole('button', { name: '결정하기' }).click()
    await expect(page).toHaveURL(new RegExp(`/aidlc/${folder.slug}/decide`))
    const prompt = page.locator('[data-test="aidlc-prompt"]')
    await expect(prompt).toContainText('어떻게 진행할까요')
    await prompt.locator('[data-test="opt-1"]').click()
    await expect(page.getByText('세션에 「Approve」를 넣었어요.')).toBeVisible()
    await expect.poll(() => fs.readFile(keys, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('1')
    expect(page.errors).toEqual([])
  })

  test('F-RD-05 팀 세션은 폴더 구성원이 같이 보고, 보기 권한이면 읽기만 한다', async ({ pageAs, as, db, cleanup }) => {
    const lead = await as('rd-lead')
    const page = await pageAs('rd-viewer')
    const { repo, folder } = await linkedRecord(lead, db, cleanup, 'AI-DLC 관전')
    expect((await lead.post(`/folders/${folder.slug}/members`, { type: 'user', id: page.user.id, role: 'viewer' })).status).toBe(200)
    await fakeSession(repo, folder.slug, cleanup)
    await page.goto(`/workroom/aidlc/${folder.slug}`)
    await expect(page.locator('[data-test="aidlc-readonly"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.xterm-rows')).toContainText('Approve', { timeout: 20_000 })
    // a viewer cannot start, stop or decide
    expect((await page.user.post(`/aidlc/${folder.slug}/session`)).status).toBe(403)
    expect((await page.user.post(`/aidlc/${folder.slug}/decide`, { option: 1 })).status).toBe(403)
  })
})

// ---------- P2: the review board, the document viewer, the bolt board (spec pgpt-pro_aidlc-review · docs/robo-dlc/plan-review.md) ----------
const INTENT = 'aidlc/spaces/default/intents/261109-todo-web-app'
const QUESTIONS = `# Requirements Analysis — Questions

## Q1. [제품] 완료한 할 일을 다시 미완료로 되돌릴 수 있어야 하나요?

완료 표시가 토글인지 일방향인지에 따라 화면과 저장이 달라집니다.

- A. 다시 누르면 미완료로 돌아간다 (권장: 실수로 누른 것을 되돌릴 수 있음)
- B. 한 번 완료하면 되돌릴 수 없다
- X. Other (please specify)

[Answer]:

## Q2. [아키텍트] 할 일은 어디에 저장할까요?

새로고침 뒤에도 남아야 합니다.

- A. 브라우저 localStorage (권장: 서버 없이 가장 단순)
- B. 서버의 SQLite 파일
- X. Other (please specify)

[Answer]:
`
const REQUIREMENTS = '# 요구사항 — 할 일 앱\n\n## FR1 할 일 추가\n\n- FR1.1 제목을 적고 Enter 를 누르면 목록 끝에 추가된다.\n\n## FR2 완료 표시\n\n- FR2.1 완료한 할 일을 다시 누르면 미완료로 되돌린다.\n\n## NFR 저장\n\n- 새로고침 뒤에도 남는다.\n'
const REVIEW = `## Review\n\n**Verdict:** READY\n\n### Findings\n\n| ID | Severity | Location | Finding | Required action | Status |\n|---|---|---|---|---|---|\n| R-01 | Minor | ${INTENT}/inception/requirements-analysis/requirements.md > FR2 완료 표시 | 되돌리기의 키보드 동작이 없다. | FR2 에 한 줄 더한다. | New |\n| R-02 | Minor | requirements.md > NFR 저장 | 용량을 넘을 때가 없다. | 넘으면 알린다. | New |\n`
async function boardFolder({ as, db, cleanup }, name, { review = false } = {}) {
  const lead = await as('rd-lead')
  const { repo, folder } = await linkedRecord(lead, db, cleanup, name)
  const ra = path.join(repo, INTENT, 'inception/requirements-analysis')
  await fs.writeFile(path.join(ra, 'requirements-analysis-questions.md'), QUESTIONS)
  await fs.writeFile(path.join(ra, 'requirements.md'), REQUIREMENTS)
  if (review) { await fs.mkdir(path.join(ra, 'reviews'), { recursive: true }); await fs.writeFile(path.join(ra, 'reviews/review-01.md'), REVIEW) }
  cleanup(async () => {
    const [f] = await db.q('select id from pro_folders where repo_path=$1', [path.resolve(repo)])
    if (f) for (const t of ['pro_aidlc_roles', 'pro_aidlc_decisions', 'pro_aidlc_waits', 'app_review_marks', 'app_review_comments']) await db.q(`delete from ${t} where folder_id=$1`, [f.id])
    await db.q(`update notifications set is_checked=true where type='aidlc' and (url like $1 or url like $2)`, [`/aidlc/${folder.slug}/%`, `/apps/%/${folder.slug}%`])
  })
  return { lead, repo, folder }
}

test.describe('Robo-DLC Lite · 검토 보드 · 볼트 보드 · 산출물 보기', () => {
  test('F-RD-06 검토 보드 · 함께 고르기: 두 사람이 동시에 보고, 남의 선택은 내가 고른 뒤에 보이며, 고른 답이 다르면 두 화면에 바로 「의견 갈림」', async ({ pageAs, as, db, cleanup }) => {
    test.setTimeout(120_000)
    const { lead, folder } = await boardFolder({ as, db, cleanup }, '검토 보드 회귀')
    const po = await pageAs('rd-po')
    const arch = await pageAs('rd-arch')
    for (const [p, role] of [[po, 'product'], [arch, 'architect']]) {
      expect((await lead.post(`/folders/${folder.slug}/members`, { type: 'user', id: p.user.id, role: 'editor' })).status).toBe(200)
      expect((await lead.put(`/aidlc/${folder.slug}/roles`, { roleKey: role, userIds: [p.user.id] })).status).toBe(200)
    }
    // the folder screen has the apps' buttons
    await po.goto(`/folders/${folder.slug}`)
    await expect(po.locator('[data-test="aidlc-apps"]')).toContainText('검토 보드')
    await po.locator('[data-test="app-btn-review"]').click()
    await expect(po).toHaveURL(new RegExp(`/apps/review/${folder.slug}`))
    await arch.goto(`/apps/review/${folder.slug}`)
    const pb = po.frameLocator('iframe[data-test=app-review]'), ab = arch.frameLocator('iframe[data-test=app-review]')
    await expect(pb.locator('[data-test=review-lane]')).toHaveCount(2, { timeout: 30_000 })
    await expect(pb.locator('[data-test=review-card][data-id=Q1]')).toContainText('AI 추천 A')
    // the architect looks at Q2: the PO sees who
    await ab.locator('[data-test=review-card][data-id=Q2]').click()
    await expect(pb.locator('[data-test=review-card][data-id=Q2] .watch .av')).toHaveCount(1, { timeout: 20_000 })
    // 함께 고르기 (the default): the PO picks Q1 first — the architect sees that one has picked, not what
    await pb.locator('[data-test=review-card][data-id=Q1]').click()
    await pb.locator('[data-test=review-agree]').click()
    await expect(pb.locator('[data-test=review-card][data-id=Q1]')).toHaveAttribute('data-state', 'voting')
    await expect(ab.locator('[data-test=review-card][data-id=Q1] [data-test=review-hidden]')).toContainText('1명 골랐어요', { timeout: 10_000 })
    await ab.locator('[data-test=review-card][data-id=Q1]').click()
    await expect(ab.locator('[data-test=review-drawer] [data-test=review-hidden]')).toBeVisible()
    // the architect picks B, with a reason: both screens show the split at once — who picked what, and why
    await ab.locator('#note').fill('서버 저장이면 되돌리기도 서버 기록이 필요해요')
    await ab.locator('[data-test=review-drawer] [data-act=choose][data-choice=B]').click()
    for (const b of [pb, ab]) {
      await expect(b.locator('[data-test=review-card][data-id=Q1]')).toHaveAttribute('data-state', 'split', { timeout: 10_000 })
      await expect(b.locator('[data-test=review-card][data-id=Q1] [data-test=review-group]')).toHaveCount(2)
    }
    await expect(pb.locator('[data-test=review-drawer]')).toContainText('서버 저장이면 되돌리기도')
    expect(po.errors).toEqual([])
    expect(arch.errors).toEqual([])
  })

  test('F-RD-07 산출물 보기: 지적 카드의 「원본 보기」가 문서 전체를 옆 시트에 열고 그 절에 띠를 두른다', async ({ pageAs, as, db, cleanup }) => {
    test.setTimeout(120_000)
    const { lead, repo, folder } = await boardFolder({ as, db, cleanup }, '산출물 회귀', { review: true })
    const po = await pageAs('rd-po')
    expect((await lead.post(`/folders/${folder.slug}/members`, { type: 'user', id: po.user.id, role: 'editor' })).status).toBe(200)
    expect((await lead.put(`/aidlc/${folder.slug}/roles`, { roleKey: 'product', userIds: [po.user.id] })).status).toBe(200)
    await fakeSession(repo, folder.slug, cleanup)
    await po.goto(`/apps/review/${folder.slug}`)
    const b = po.frameLocator('iframe[data-test=app-review]')
    await b.locator('[data-test=review-card][data-id=R-01]').click({ timeout: 30_000 })
    await b.locator('[data-test=review-ref]').first().click()
    const sheet = po.frameLocator('[data-test=app-sheet] iframe')
    await expect(sheet.locator('[data-test=artifact-focus]')).toContainText('FR2 완료 표시', { timeout: 20_000 })
    await expect(sheet.locator('[data-test=artifact-focus]')).not.toContainText('FR1 할 일 추가')
    await expect(sheet.locator('[data-test=artifact-doc]')).toContainText('FR1 할 일 추가')   // the whole document
    expect(po.errors).toEqual([])
  })

  test('F-RD-08 볼트 보드: 의도 → 유닛 → 볼트(코드 생성 한 번 = 볼트 하나), 볼트 계획은 묶음 표시, 유닛을 누르면 진척과 산출물', async ({ pageAs, as, db, cleanup }) => {
    test.setTimeout(90_000)
    const lead = await as('rd-lead')
    const { repo, folder } = await linkedRecord(lead, db, cleanup, '볼트 회귀')
    // only the finished classic run (voice-parking) in this record, with a bolt plan over its units
    const intents = path.join(repo, 'aidlc/spaces/default/intents')
    await fs.rm(path.join(intents, '261109-todo-web-app'), { recursive: true, force: true })
    const list = JSON.parse(await fs.readFile(path.join(intents, 'intents.json'), 'utf8')).filter((i) => i.slug === 'voice-parking')
    await fs.writeFile(path.join(intents, 'intents.json'), JSON.stringify(list))
    const vp = path.join(intents, '261105-voice-parking')
    const units = [...(await fs.readFile(path.join(vp, 'inception/units-generation/unit-of-work-dependency.md'), 'utf8')).matchAll(/^\s*-\s+name:\s*(\S+)/gm)].map((m) => m[1])
    await fs.mkdir(path.join(vp, 'inception/delivery-planning'), { recursive: true })
    await fs.writeFile(path.join(vp, 'inception/delivery-planning/bolt-plan.md'), `# Bolt 계획\n\n## Bolt 1 — 서비스 (\`bolt-1\`)\n\n| 항목 | 내용 |\n|---|---|\n| 포함 단위 | ${units.slice(0, 3).map((u) => `\`${u}\``).join(', ')} |\n\n## Bolt 2 — 화면 (\`bolt-2\`)\n\n| 항목 | 내용 |\n|---|---|\n| 포함 단위 | ${units.slice(3).map((u) => `\`${u}\``).join(', ')} |\n| 앞선 Bolt | Bolt 1 |\n`)
    const page = await pageAs('rd-lead')
    await page.goto(`/apps/bolts/${folder.slug}`)
    const bb = page.frameLocator('iframe[data-test=app-bolts]')
    await expect(bb.locator('[data-test=bolts-unit]')).toHaveCount(units.length, { timeout: 30_000 })
    // every unit of this finished run was built in one bolt (repeated checks inside it, nothing sent back)
    await expect(bb.locator('#tree [data-test=bolts-bolt]')).toHaveCount(units.length)
    await expect(bb.locator('#tree [data-test=bolts-bolt].accepted')).toHaveCount(units.length)
    // the bolt plan's groups are labels on the units, not their parents
    await expect(bb.locator(`[data-test=bolts-unit][data-unit="${units[0]}"] .grp`)).toHaveText('묶음 B1')
    await expect(bb.locator(`[data-test=bolts-unit][data-unit="${units.at(-1)}"] .grp`)).toHaveText('묶음 B2')
    await bb.locator(`[data-test=bolts-unit][data-unit="${units[0]}"]`).click()
    await expect(bb.locator('[data-test=bolts-detail]')).toContainText(units[0])
    await expect(bb.locator('[data-test=bolts-detail] .stg .row')).toHaveCount(5)
    await expect(bb.locator('[data-test=bolts-detail] [data-test=bolts-bolt]')).toHaveCount(1)
    const doc = bb.locator('[data-test=bolts-detail] [data-doc]').first()
    if (await doc.count()) {
      await doc.click()
      await expect(page.frameLocator('[data-test=app-sheet] iframe').locator('[data-test=artifact-doc]')).toBeVisible({ timeout: 20_000 })
    }
    expect(page.errors).toEqual([])
  })
})

// Every frame is an MCP App now (docs/robo-dlc/plan-mcp-apps.md): a Home panel too — the built-in panels app
// hands the screen the panel's own html, script and data; panel.save is that app's tool, as the panel's owner.
test.describe('Robo-DLC Lite · MCP Apps 호스트', () => {
  test('F-RD-09 홈 패널도 MCP App: 패널 코드가 격리된 틀에서 돌고, 저장은 주인의 데이터로, 틀 높이는 내용을 따른다', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('rd-panel')
    const o = page.user
    const spec = { html: '<div style="height:260px"><b id="n"></b> <button id="add">하나 더</button></div>', script: '$("#n").textContent = panel.data.n\n$("#add").onclick = async () => { await panel.save({ n: panel.data.n + 1 }); $("#n").textContent = panel.data.n }' }
    const [p] = await db.q(`insert into pro_panels(user_id, title, icon, spec, data) values ($1, $2, '🧪', $3, '{"n":1}') returning id`, [o.id, `MCP 패널 ${RUN}`, spec])
    cleanup(() => db.q('delete from pro_panels where id=$1', [p.id]))
    await page.goto('/')
    const box = page.locator('.panel', { hasText: `MCP 패널 ${RUN}` })
    const frame = box.frameLocator('iframe[data-test=app-panels]')
    await expect(frame.locator('#n')).toHaveText('1', { timeout: 30_000 })
    // the frame has no origin of its own: scripts only, no same-origin
    await expect(box.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox')
    await frame.locator('#add').click()
    await expect(frame.locator('#n')).toHaveText('2')
    await expect.poll(async () => (await db.q('select data from pro_panels where id=$1', [p.id]))[0].data.n).toBe(2)
    // the frame grows to its content (ui/notifications/size-changed)
    await expect.poll(async () => (await box.locator('.body').boundingBox())?.height || 0).toBeGreaterThan(250)
    await page.reload()
    await expect(page.locator('.panel', { hasText: `MCP 패널 ${RUN}` }).frameLocator('iframe').locator('#n')).toHaveText('2', { timeout: 30_000 })
    expect(page.errors).toEqual([])
  })
})

// ---------- P3: work intake and the bolt line (docs/robo-dlc/plan-intake.md · spec pgpt-pro_aidlc-intake) ----------
// A project with one finished piece of work (room booking, six units). The plan for a request is the stand-in
// file the server reads (PRO_AIDLC_COMPOSE_STUB, the same path here and on the server): without it these are skipped.
const LINE_FIXTURE = path.join(path.dirname(FIXTURE), 'aidlc-line')
const SCREENS = path.dirname(SCREEN)
const STUB = process.env.PRO_AIDLC_COMPOSE_STUB || ''
const U2 = 'u2-booking-rules', U4 = 'u4-booking', U5 = 'u5-notification-worker', U6 = 'u6-web-ui'
const sc = (...n) => Object.fromEntries(['iae', 'csu', 've', 'r', 'ua'].map((k, i) => [k, { score: n[i], why: '대역' }]))
const STUBS = [
  { match: '문구', estimate: { title: '예약 버튼 문구', kind: 'change', scores: sc(0.1, 0.1, 0.1, 0.1, 0.1), touches: { units: [U6], contracts: [], requirements: [], paths: [] }, newUnits: [], conflicts: [], summary: '예약 화면의 버튼 문구를 바꿔요.' } },
  { match: '두 번', estimate: { title: '알림 메일 중복 발송', kind: 'bug', scores: sc(0.2, 0.2, 0.3, 0.3, 0.2), touches: { units: [U5], contracts: ['C6'], requirements: ['FR6.4'], paths: ['packages/worker/src/mail.ts'] }, newUnits: [], conflicts: [], summary: '알림 작업자가 같은 예약에 메일을 두 번 보내는 까닭을 찾아 고쳐요.' } },
  { match: '반복 예약', estimate: { title: '반복 예약', kind: 'feature', scores: sc(0.6, 0.6, 0.5, 0.4, 0.4), touches: { units: [U2, U4, U6], contracts: ['C2', 'C3'], requirements: ['FR3.1'], paths: [] }, newUnits: [], conflicts: [], summary: '매주 같은 시간에 되풀이되는 예약을 규칙·API·화면에 더해요.' } },
]
// an app's tool as the person, the way its screen calls it (MCP over HTTP; the endpoint keeps no session)
async function appTool(who, app, name, args) {
  const r = await api.mcp(`/api/apps/${app}/mcp`, 'tools/call', { name, arguments: args }, who.token())
  const res = r.body?.result
  if (!res || res.isError) throw new Error(`${name}: ${res?.structuredContent?.error || res?.content?.[0]?.text || r.text}`)
  return res.structuredContent?.value
}
async function lineFolder({ as, db, cleanup }, name) {
  const lead = await as('rd-lead')
  const { repo, folder } = await linkedRecord(lead, db, cleanup, name, LINE_FIXTURE)
  await fs.writeFile(STUB, JSON.stringify(STUBS, null, 2))
  cleanup(async () => {
    const [f] = await db.q('select id from pro_folders where repo_path=$1', [path.resolve(repo)])
    if (f) for (const t of ['pro_aidlc_roles', 'pro_aidlc_requests', 'pro_aidlc_line', 'pro_aidlc_decisions', 'pro_aidlc_waits']) await db.q(`delete from ${t} where folder_id=$1`, [f.id])
    await db.q(`update notifications set is_checked=true where type='aidlc' and (url like $1 or url like $2)`, [`/aidlc/${folder.slug}/%`, `/apps/%/${folder.slug}%`])
  })
  const join = async (who, roleKey) => {
    if (who.id !== lead.id) expect((await lead.post(`/folders/${folder.slug}/members`, { type: 'user', id: who.id, role: 'editor' })).status).toBe(200)
    expect((await lead.put(`/aidlc/${folder.slug}/roles`, { roleKey, userIds: [who.id] })).status).toBe(200)
  }
  await join(lead, 'team-lead')
  // ask for work and wait for its plan
  const ask = async (who, body) => {
    const r = await appTool(who, 'intake', 'intake_propose', { folder: folder.slug, body })
    return api.until(async () => { const x = (await appTool(who, 'intake', 'intake_open', { folder: folder.slug })).requests.find((y) => y.id === r.id); return x.status !== 'estimating' && x }, { timeout: 30_000, every: 700 })
  }
  return { lead, repo, folder, join, ask }
}
// the stand-in session for a folder Claude Code opens for the first time: its "is this folder trusted?" screen
// (the cursor on "No, exit"; Down moves it to Yes, Enter there goes on), then an idle prompt where every key goes
// to a file outside the project
async function trustSession(slug, cleanup) {
  const name = `aidlc-${process.env.PGPT_TENANT || 'localhost'}-${slug}`.replace(/[^A-Za-z0-9_-]/g, '_')
  const side = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-rt-side-'))
  const keys = path.join(side, 'keys.log')
  const script = path.join(side, 'fake-claude.sh')
  const show = (n) => `printf '\\033[2J\\033[H'; cat ${JSON.stringify(path.join(SCREENS, `${n}.txt`))}`
  await fs.writeFile(script, `#!/bin/bash\ncat ${JSON.stringify(path.join(SCREENS, 'trust.txt'))}\nat=no\nwhile IFS= read -rsn1 k; do
  if [ "$at" != done ]; then
    if [ "$k" = B ]; then at=yes; ${show('trust-yes')}
    elif [ -z "$k" ] && [ "$at" = yes ]; then at=done; ${show('idle')}
    elif [ -z "$k" ]; then exit 0; fi
    continue
  fi
  printf '%s' "$k" >> ${JSON.stringify(keys)}\ndone\n`, { mode: 0o755 })
  tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '48', script)
  cleanup(async () => { try { tmux('kill-session', '-t', name) } catch { /* gone */ } await fs.rm(side, { recursive: true, force: true }) })
  return { name, typed: () => fs.readFile(keys, 'utf8').catch(() => '') }
}
// what the engine writes when the session starts an intent
async function writeIntent(repo, dir, { scope, project, stage }) {
  const intents = path.join(repo, 'aidlc/spaces/default/intents')
  const list = JSON.parse(await fs.readFile(path.join(intents, 'intents.json'), 'utf8'))
  list.push({ uuid: randomUUID(), slug: dir.replace(/^\d{6}-/, ''), dirName: dir, scope, status: 'active', request: 'rt' })
  await fs.mkdir(path.join(intents, dir, 'audit'), { recursive: true })
  await fs.writeFile(path.join(intents, dir, 'aidlc-state.md'), `# AI-DLC State Tracking\n\n## Project Information\n- **Project**: ${project}\n- **Scope**: ${scope}\n\n## Current Status\n- **Current Stage**: ${stage}\n- **Status**: In Progress\n`)
  await fs.writeFile(path.join(intents, 'intents.json'), JSON.stringify(list, null, 2))
  await fs.writeFile(path.join(intents, 'active-intent'), dir)
}

test.describe('Robo-DLC Lite · 작업 접수 · 볼트 줄', () => {
  test.skip(!STUB, 'PRO_AIDLC_COMPOSE_STUB (the stand-in plan file the server reads) is not set')

  test('F-RD-10 채팅으로 접수: 접수 권한이 없는 사람이 「작업 접수: …」 라고 하면 계획안이 대화에 카드로 오고, 접수 담당에게 알림이 간다', async ({ pageAs, as, db, cleanup }) => {
    test.setTimeout(150_000)
    const { lead, folder, join } = await lineFolder({ as, db, cleanup }, '접수 채팅 회귀')
    const page = await pageAs('rd-dev')
    const dev = page.user
    await join(dev, 'developer')
    const thread = (await dev.get('/threads')).body[0].id
    const said = async (text) => {
      const before = (await dev.get(`/threads/${thread}/messages`)).body.length
      await api.sendChat(dev.token(), thread, text)
      return (await dev.get(`/threads/${thread}/messages`)).body.slice(before).filter((m) => m.role === 'agent')
    }
    let got = await said('작업 접수: 예약 화면의 "예약하기" 버튼 문구를 "회의실 잡기"로 바꿔 주세요')
    // (someone who is in more than one project is asked which: its name is the answer)
    if (!got.some((m) => m.kind === 'app')) got = await said(folder.name)
    const text = got.find((m) => m.kind === 'text').content.text
    expect(text).toMatch(/작업 요청으로 넣었어요/)
    expect(text).toContain(`접수 권한이 있는 회귀-rd-lead 님께 알려요`)
    const card = got.find((m) => m.kind === 'app').content
    expect([card.app, card.folder, card.folderName]).toEqual(['intake', folder.slug, folder.name])
    // the conversation shows the app's own screen as a card: the plan, and that it waits for who takes in work
    await page.goto('/chat')
    const box = page.locator('[data-test=app-card][data-app=intake]').last()
    await expect(box).toContainText(folder.name, { timeout: 30_000 })
    const plan = box.frameLocator('iframe')
    await expect(plan.locator('[data-test=plan-title]')).toHaveText('예약 버튼 문구', { timeout: 40_000 })
    await expect(plan.locator('[data-test=plan-scope]')).toHaveText('express')
    await expect(plan.locator('[data-test=plan-unit]')).toHaveText([U6])
    await expect(plan.locator('[data-test=plan-waiting]')).toContainText('접수를 기다리고 있어요. 회귀-rd-lead 님이')
    await expect(plan.locator('[data-test=plan-approve]')).toHaveCount(0)
    // the team lead is told, with the way to that plan
    const url = `/apps/intake/${folder.slug}?r=${card.params.r}`
    await expect.poll(async () => ((await lead.get('/notifications')).body || []).find((n) => n.type === 'aidlc' && n.url === url)?.title || '', { timeout: 20_000 }).toMatch(/접수를 기다려요/)
    // the same screen, large
    await box.locator('[data-test=app-card-open]').click()
    const sheet = page.frameLocator('[data-test=app-sheet] iframe')
    await expect(sheet.locator('[data-test=intake-req][data-status=inbox]')).toHaveCount(1, { timeout: 30_000 })
    await expect(sheet.locator('[data-test=plan-title]')).toHaveText('예약 버튼 문구')
    expect(page.errors).toEqual([])
  })

  test('F-RD-11 작업 접수: 하고 싶은 일을 적으면 계획안(범위·건드리는 유닛·ARS) → 「지금 시작」 → 처음 여는 폴더는 믿을지 사람에게 묻고 → 세션에 /aidlc 가 들어간다', async ({ pageAs, as, db, cleanup }) => {
    test.setTimeout(150_000)
    const { folder } = await lineFolder({ as, db, cleanup }, '작업 접수 회귀')
    const session = await trustSession(folder.slug, cleanup)
    const page = await pageAs('rd-lead')
    await page.goto(`/apps/intake/${folder.slug}`)
    const f = page.frameLocator('iframe[data-test=app-intake]')
    await f.locator('[data-test=intake-body]').fill('예약 알림 메일이 두 번 와요. 같은 예약인데 10분 전 알림이 두 통씩 옵니다.', { timeout: 30_000 })
    await f.locator('[data-test=intake-send]').click()
    // the plan: the scope by what kind of work it is, the units it touches (checked against the record), the score
    await expect(f.locator('[data-test=plan-title]')).toHaveText('알림 메일 중복 발송', { timeout: 40_000 })
    await expect(f.locator('[data-test=plan-scope]')).toHaveText('bugfix')
    await expect(f.locator('[data-test=plan-unit]')).toHaveText([U5])
    await expect(f.locator('[data-test=plan-ars]')).toHaveText(/^\d+$/)
    // nothing is in flight: it cannot be folded into anything
    await expect(f.locator('[data-test=plan-mode-merge]')).toBeDisabled()
    await f.locator('[data-test=plan-mode-now]').click()
    await f.locator('[data-test=plan-approve]').click()
    // Claude Code asks whether the folder is trusted: nothing is typed over it — the person is asked, with what
    // the folder's settings pre-approve
    await expect(f.locator('[data-test=dialog]')).toContainText('이 폴더를 믿고 시작할까요?', { timeout: 20_000 })
    await expect(f.locator('[data-test=trust-pre]')).toContainText('도구 132개')
    expect(await session.typed()).toBe('')
    await f.locator('[data-test=dialog-ok]').click()
    await expect(f.getByText('세션에 넘겼어요')).toBeVisible({ timeout: 20_000 })
    await expect.poll(session.typed, { timeout: 15_000 }).toContain('/aidlc bugfix "예약 알림 메일이 두 번 와요. 같은 예약인데 10분 전 알림이 두 통씩 옵니다."')
    await expect(f.locator('[data-test=intake-req][data-status=started]')).toHaveCount(1)
    await expect(f.locator('[data-test=plan-outcome]')).toContainText('회귀-rd-lead 님이 시작했어요')
    // the bolt line has it at the head, running
    await f.locator('[data-test=intake-to-line]').click()
    const line = page.frameLocator('[data-test=app-sheet] iframe')
    await expect(line.locator(`[data-test=line-bolt][data-state=running][data-unit="${U5}"]`)).toHaveCount(1, { timeout: 30_000 })
    await expect(line.locator('[data-test=line-bolt][data-bucket=shipped]')).toHaveCount(6)
    // who answered the trust question is in the ledger
    await expect(line.locator('[data-test=line-ledger]')).toContainText('믿고 진행')
    await expect(line.locator('[data-test=line-ledger]')).toContainText('미리 허용한 도구 132개')
    expect(page.errors).toEqual([])
  })

  test('F-RD-12 볼트 줄: 줄 끝에 세운 요청의 볼트 셋 · 의존을 깨는 이동은 막고 함께 옮길 볼트를 알려 주며 · 「함께 옮기기」 로 셋이 다음 릴리스로', async ({ pageAs, as, db, cleanup }) => {
    test.setTimeout(150_000)
    const { lead, folder, ask } = await lineFolder({ as, db, cleanup }, '볼트 줄 회귀')
    const recur = await ask(lead, '반복 예약을 넣어 주세요. 매주 같은 시간에 되풀이되는 예약이요.')
    expect([recur.status, recur.estimate.scope]).toEqual(['proposed', 'feature'])
    expect(await appTool(lead, 'intake', 'intake_approve', { folder: folder.slug, id: recur.id, mode: 'after' })).toEqual({ status: 'queued', scope: 'feature' })
    const k = (u) => `r:${recur.id}:${u}`
    const page = await pageAs('rd-lead')
    await page.goto(`/apps/line/${folder.slug}`)
    const f = page.frameLocator('iframe[data-test=app-line]')
    const bolt = (u) => f.locator(`[data-test=line-bolt][data-bolt="${k(u)}"]`)
    // the finished work is released; the request's expected bolts stand at the tail, one per unit
    await expect(f.locator('[data-test=line-bolt][data-bucket=shipped]')).toHaveCount(6, { timeout: 30_000 })
    for (const u of [U2, U4, U6]) await expect(bolt(u)).toHaveAttribute('data-bucket', 'tail')
    await expect(bolt(U6)).toHaveAttribute('data-state', 'estimated')
    // the screen bolt waits for the API bolt (C2) and the rules bolt (C3): alone it may not go to the next release
    await bolt(U6).click()
    await expect(f.locator('[data-test=picked-deps]')).toContainText('C2')
    await f.locator('[data-test=picked-move-next]').click()
    await expect(f.locator('[data-test=move-blocked]')).toBeVisible({ timeout: 15_000 })
    await expect(f.locator('[data-test=move-blocker]')).toHaveCount(2)
    await expect(bolt(U6)).toHaveAttribute('data-bucket', 'tail')
    await f.locator('[data-test=move-together]').click()
    await expect(f.getByText('볼트 3개를')).toBeVisible({ timeout: 15_000 })
    for (const u of [U2, U4, U6]) await expect(bolt(u)).toHaveAttribute('data-bucket', 'next')
    // it is in the ledger, with how many went together
    await expect(f.locator('[data-test=line-ledger]')).toContainText('줄 끝 → 다음 릴리스')
    await expect(f.locator('[data-test=line-ledger]')).toContainText('3개를 함께')
    // nothing is in flight: the head offers the next work to a person who may start it
    await expect(f.locator('[data-test=line-start]')).toBeVisible()
    expect(page.errors).toEqual([])
  })

  test('F-RD-13 보안 멈춤과 폐기: 누구든 보안 사유로 멈추면 세션에 바로 Esc · 팀 리드가 까닭을 적어 폐기하면 바뀐 파일이 시작 전으로, 줄에는 폐기된 볼트로 남는다', async ({ pageAs, as, db, cleanup }) => {
    test.setTimeout(200_000)
    const { lead, repo, folder, join, ask } = await lineFolder({ as, db, cleanup }, '보안 멈춤 회귀')
    const session = await trustSession(folder.slug, cleanup)
    const devPage = await pageAs('rd-dev')
    await join(devPage.user, 'developer')
    // the team lead starts the bug fix (the folder is trusted); the record gets the intent, as the engine writes it
    const bug = await ask(lead, '예약 알림 메일이 두 번 와요. 같은 예약인데 10분 전 알림이 두 통씩 옵니다.')
    expect((await appTool(lead, 'intake', 'intake_approve', { folder: folder.slug, id: bug.id, mode: 'now' })).status).toBe('trust')
    expect(await appTool(lead, 'intake', 'intake_approve', { folder: folder.slug, id: bug.id, mode: 'now', trust: true })).toEqual({ status: 'started', scope: 'bugfix' })
    await expect.poll(session.typed, { timeout: 15_000 }).toContain('/aidlc bugfix')
    const BUG = '261112-double-mail', key = `i:${BUG}:${U5}`
    await writeIntent(repo, BUG, { scope: 'bugfix', project: '예약 알림 메일이 두 번 와요', stage: 'code-generation' })
    await expect.poll(async () => (await appTool(lead, 'line', 'line_open', { folder: folder.slug })).requests.find((r) => r.id === bug.id).intent, { timeout: 40_000 }).toBe(BUG)
    // the session "worked": a file changed
    const mail = path.join(repo, 'packages/worker/src/mail.ts')
    const before = await fs.readFile(mail, 'utf8')
    await fs.writeFile(mail, `${before}\nconsole.log('SMTP_PASSWORD', process.env.SMTP_PASSWORD)\n`)

    // a developer (who may not stop or discard) sees a secret in the log: a security stop pauses the session at once
    await devPage.goto(`/apps/line/${folder.slug}`)
    const d = devPage.frameLocator('iframe[data-test=app-line]')
    await d.locator(`[data-test=line-bolt][data-bolt="${key}"]`).click({ timeout: 30_000 })
    await expect(d.locator('[data-test=picked-discard]')).toHaveCount(0)
    const mark = (await session.typed()).length
    await d.locator('[data-test=picked-ask-stop]').click()
    await d.locator('[data-test=stop-security]').check()
    await d.locator('[data-test=dialog-reason]').fill('SMTP 비밀번호가 로그에 찍혀요')
    await d.locator('[data-test=dialog-ok]').click()
    await expect(d.getByText('세션을 바로 멈추고 알렸어요')).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => (await session.typed()).slice(mark), { timeout: 10_000 }).toBe('\x1b')
    await expect(d.locator(`[data-test=line-bolt][data-bolt="${key}"]`)).toHaveAttribute('data-hold', /.+/)
    // the team lead gets the card, straight to that bolt
    const url = `/apps/line/${folder.slug}?b=${encodeURIComponent(key)}`
    await expect.poll(async () => ((await lead.get('/notifications')).body || []).find((n) => n.type === 'aidlc' && n.url === url)?.title || '', { timeout: 20_000 }).toMatch(/보안 사유로 작업을 멈췄어요/)

    // the team lead looks at what discarding means, gives the reason, and discards
    const page = await pageAs('rd-lead')
    await page.goto(url)
    const f = page.frameLocator('iframe[data-test=app-line]')
    await expect(f.locator('[data-test=picked-stop]')).toContainText('SMTP 비밀번호가 로그에 찍혀요', { timeout: 30_000 })
    await f.locator('[data-test=picked-discard]').click()
    await expect(f.locator('[data-test=discard-kind]')).toHaveAttribute('data-kind', 'stop', { timeout: 20_000 })
    await expect(f.locator('[data-test=discard-files]')).toContainText('되돌릴 파일 1개')
    await f.locator('[data-test=dialog-ok]').click()   // no reason yet: refused
    await expect(f.getByText('폐기하는 까닭을 적어 주세요')).toBeVisible()
    await f.locator('[data-test=dialog-reason]').fill('비밀번호를 로그에 남기는 코드예요. 처음부터 다시 해요')
    await f.locator('[data-test=dialog-ok]').click()
    await expect(f.getByText('멈추고 폐기했어요')).toBeVisible({ timeout: 30_000 })
    await expect(f.locator('[data-test=picked-discarded]')).toContainText('비밀번호를 로그에 남기는 코드예요')
    await expect(f.locator(`[data-test=line-bolt][data-bolt="${key}"]`)).toHaveAttribute('data-gone', /.+/)
    // the file is as it was when the bolt started; the session was told; the ledger has who and why
    expect(await fs.readFile(mail, 'utf8')).toBe(before)
    await expect.poll(session.typed, { timeout: 15_000 }).toContain('[Lite] 이 작업은 폐기하기로 했어요')
    await expect(f.locator('[data-test=line-ledger]')).toContainText('멈추고 폐기')
    const v = await appTool(lead, 'line', 'line_open', { folder: folder.slug })
    expect(v.head.busy).toBe(false)
    expect([page.errors, devPage.errors]).toEqual([[], []])
  })
})
