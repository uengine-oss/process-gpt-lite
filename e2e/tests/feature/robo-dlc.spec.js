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
})
