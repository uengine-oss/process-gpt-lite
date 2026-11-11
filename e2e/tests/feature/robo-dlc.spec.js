// Robo-DLC Lite — AI-DLC 대시보드 패널: AI-DLC 저장소를 연결형 공유 폴더로 붙이면 폴더 구성원이 홈 패널로
// 작업 현황·사람 대기·볼트·품질·감사 기록·질문을 본다. 기록은 작업 사본에서 바로 읽고 패널은 20초마다 다시 그린다.
// (spec pgpt-pro_aidlc-dashboards · 설계 docs/robo-dlc/plan.md)
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect, RUN } from '../../lib/fixtures.js'

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
async function linkedRecord(owner, db, cleanup, name) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'aidlc-rt-'))
  await fs.cp(FIXTURE, repo, { recursive: true })
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
  test('F-RD-06 검토 보드: 역할 열로 나뉜 카드를 두 사람이 동시에 보고, 한 사람의 이의가 다른 사람 화면에 바로 「논의 필요」로 뜬다', async ({ pageAs, as, db, cleanup }) => {
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
    // the PO takes the recommendation on Q1; the architect objects, with a reason
    await pb.locator('[data-test=review-card][data-id=Q1]').click()
    await pb.locator('[data-test=review-agree]').click()
    await expect(pb.locator('[data-test=review-card][data-id=Q1]')).toHaveAttribute('data-state', 'decided')
    await ab.locator('[data-test=review-card][data-id=Q1]').click()
    await ab.locator('#note').fill('서버 저장이면 되돌리기도 서버 기록이 필요해요')
    await ab.locator('[data-test=review-object]').click()
    await expect(pb.locator('[data-test=review-card][data-id=Q1]')).toHaveAttribute('data-state', 'discuss', { timeout: 10_000 })
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

  test('F-RD-08 볼트 보드: 볼트 → 유닛 → 구축 단계, 유닛을 누르면 진척과 그 유닛의 산출물', async ({ pageAs, as, db, cleanup }) => {
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
    await expect(bb.locator('[data-test=bolts-bolt]')).toHaveCount(2, { timeout: 30_000 })
    await expect(bb.locator('[data-test=bolts-unit]')).toHaveCount(units.length)
    await bb.locator(`[data-test=bolts-unit][data-unit="${units[0]}"]`).click()
    await expect(bb.locator('[data-test=bolts-detail]')).toContainText(units[0])
    await expect(bb.locator('[data-test=bolts-detail] .stg .row')).toHaveCount(5)
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
