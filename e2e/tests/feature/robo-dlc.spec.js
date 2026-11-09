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
