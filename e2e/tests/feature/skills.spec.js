// 스킬 공유 — 내 스킬로 시작 → 전사 공유 → 동료가 변형으로 고침 → 반영 요청 → 작성자만 반영(403 그 밖) →
// 반영되면 설치본이 새 버전, 기여 기록. (spec pgpt-pro_skill-sharing · 영상 youtu.be/KKsUf4BGf7I)
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { test, expect, RUN } from '../../lib/fixtures.js'
import { removeFolder } from '../../lib/seed.js'
import { WORKSPACE, SKILLS_DIR } from '../../lib/env.js'

test.describe.configure({ mode: 'serial' })
const NAME = `rt-skill-${RUN}`
const ROOM = `rt-draft-${RUN}`
const MD = `---\nname: ${NAME}\ndescription: 회귀 시험용 — 주간 보고 글을 세 줄로 요약한다.\n---\n\n# 회귀 주간 보고 요약\n\n## 절차\n1. 끝낸 일과 진행 중인 일을 나눈다.\n2. 세 줄 요약을 쓴다.\n`
let slug, varId

test.beforeAll(async () => { test.skip(!fss.existsSync(WORKSPACE), `deepagents 작업 공간 없음: ${WORKSPACE}`) })

test.afterAll(async ({}, ) => {
  const db = await import('../../lib/db.js')
  if (!(await db.available())) return
  const { as } = await import('../../lib/api.js')
  const author = await as('sk-author')
  await author.del(`/skills/${NAME}`).catch(() => {})
  await db.q(`delete from notifications where tenant_id=$1 and title like $2`, [db.tenant, `%${NAME}%`]).catch(() => {})
  for (const t of ['pro_skill_visibility', 'tenant_skills', 'skill_contributions']) await db.q(`delete from ${t} where skill_name=$1`, [NAME]).catch(() => {})
  await db.q(`delete from resource_pull_requests where resource_id=$1`, [NAME]).catch(() => {})
  await db.q(`delete from pro_messages where kind='skill_draft' and content->>'name'=$1`, [NAME]).catch(() => {})
  if (slug) await removeFolder(db, slug)
  await fs.rm(path.join(WORKSPACE, '.bpmn', ROOM), { recursive: true, force: true })
  await fs.rm(path.join(SKILLS_DIR, NAME), { recursive: true, force: true })
  for (const d of await fs.readdir(path.join(WORKSPACE, '.pro-skills')).catch(() => [])) await fs.rm(path.join(WORKSPACE, '.pro-skills', d, NAME), { recursive: true, force: true })
  await db.end()
})

test('F-SK-01 새 스킬은 "내 스킬"(비공개)로 시작하고 공유 여부를 묻는다', async ({ as, db }) => {
  const author = await as('sk-author'), mate = await as('sk-mate')
  const dir = path.join(WORKSPACE, '.bpmn', ROOM, 'skills', NAME)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), MD)
  const th = await db.mainThreadId(author.id)
  const [m] = await db.addMessages(th, [{ role: 'agent', kind: 'skill_draft', content: { dir: `/workspace/.bpmn/${ROOM}/skills/${NAME}`, name: NAME, description: '회귀 시험용', state: 'draft', markdown: MD, steps: ['나눈다', '요약한다'], stepCount: 2 } }])
  const saved = await author.post(`/skill-drafts/${m.id}/save`, {})
  expect(saved.status, saved.text).toBe(200)
  const list = (await author.get('/folders/skills')).body
  const mine = list.find((s) => s.name === NAME)
  expect(mine).toMatchObject({ visibility: 'private', mine: true })
  slug = mine.folder.slug
  expect((await author.get(`/folders/${slug}/skill`)).body).toMatchObject({ visibility: 'private', mine: true, askShare: true, canMerge: true })
  // a private skill is not listed for, nor openable by, anyone else
  expect((await mate.get('/folders/skills')).body.some((s) => s.name === NAME)).toBe(false)
  expect((await mate.post(`/folders/skills/${NAME}/open`)).status).toBe(404)
  const card = (await author.get(`/threads/${th}/messages`)).body.find((x) => x.id === m.id)
  expect(card.content).toMatchObject({ state: 'saved', visibility: 'private' })
})

test('F-SK-02 작성자만 전사에 공유한다 (다른 사람 403)', async ({ as }) => {
  test.skip(!slug, '앞 단계 실패')
  const author = await as('sk-author'), mate = await as('sk-mate')
  expect((await mate.post(`/folders/${slug}/share`)).status).toBeGreaterThanOrEqual(403)
  const r = await author.post(`/folders/${slug}/share`)
  expect(r.status, r.text).toBe(200)
  expect((await author.get(`/folders/${slug}/skill`)).body.visibility).toBe('tenant')
  expect(fss.existsSync(path.join(SKILLS_DIR, NAME, 'SKILL.md')), '테넌트 스킬로 설치됨').toBe(true)
  expect((await mate.post(`/folders/skills/${NAME}/open`)).body.slug).toBe(slug)
})

test('F-SK-03 동료가 변형에서 고치고 반영 요청 → 작성자 Home 알림', async ({ as }) => {
  test.skip(!slug, '앞 단계 실패')
  const author = await as('sk-author'), mate = await as('sk-mate')
  const v = await mate.post(`/folders/${slug}/variations`, { title: '위험 이슈 단계 추가' })
  expect(v.status, v.text).toBe(200)
  varId = v.body.id
  expect((await mate.post(`/folders/${slug}/variations/${varId}/checkout`)).status).toBe(200)
  expect((await mate.put(`/workroom/variation/${varId}/file`, { path: 'SKILL.md', content: MD + '3. 위험·이슈를 따로 뽑는다.\n' })).status).toBe(200)
  expect((await mate.post(`/folders/${slug}/variations/${varId}/commit`, { release: true })).status).toBe(200)
  const pr = await mate.post(`/folders/${slug}/variations/${varId}/request`, { title: '위험 이슈 단계 추가' })
  expect(pr.status, pr.text).toBe(200)
  expect(pr.body.status).toBe('OPEN')
  await expect.poll(async () => (await author.get('/notifications')).body.some((n) => /반영 요청/.test(`${n.title} ${n.description}`) && JSON.stringify(n).includes(NAME)), { timeout: 30_000 }).toBe(true)
  const review = await mate.get(`/folders/${slug}/variations/${varId}/review`)
  expect(review.body.canMerge).toBe(false)
})

test('F-SK-04 작성자·에이전트 담당자가 아니면 반영은 서버가 거절(403)', async ({ as }) => {
  test.skip(!varId, '앞 단계 실패')
  const mate = await as('sk-mate')
  const r = await mate.post(`/folders/${slug}/merge`, { ids: [varId] })
  expect(r.status).toBe(403)
  expect(fss.readFileSync(path.join(SKILLS_DIR, NAME, 'SKILL.md'), 'utf8')).not.toContain('위험·이슈')
})

test('F-SK-06 에이전트 담당자가 되면 반영할 수 있다 (담당자 없는 에이전트는 누구나, 있으면 그 사람만 넘김)', async ({ as, db }) => {
  test.skip(!varId, '앞 단계 실패')
  const mate = await as('sk-mate'), out = await as('sk-out')
  const agent = (await db.q(`insert into users (id, tenant_id, username, email, is_agent, agent_type) values (gen_random_uuid(), $1, $2, $3, true, 'agent') returning id::text`, [db.tenant, `회귀 에이전트 ${RUN}`, `rt-agent-${RUN}@agents.local`]))[0].id
  try {
    await db.q('insert into agent_skills (user_id, tenant_id, skill_name) values ($1,$2,$3)', [agent, db.tenant, NAME])
    expect((await mate.get(`/folders/${slug}/variations/${varId}/review`)).body.canMerge).toBe(false)
    expect((await mate.post(`/folders/agents/${agent}/boss`, { owner: mate.id })).status).toBe(200)
    expect((await mate.get(`/folders/${slug}/variations/${varId}/review`)).body.canMerge).toBe(true)
    expect((await out.post(`/folders/agents/${agent}/boss`, { owner: out.id })).status, '담당자만 넘긴다').toBe(403)
    const info = (await mate.get(`/folders/${slug}/skill`)).body
    expect(info.agents.find((a) => a.id === agent)?.boss_id).toBe(mate.id)
  } finally {
    await db.q('delete from pro_agent_owners where agent_user_id=$1', [agent])
    await db.q('delete from users where id=$1', [agent])
  }
})

test('F-SK-05 작성자가 반영 → 설치된 스킬이 새 버전, 기여 기록에 동료', async ({ as }) => {
  test.skip(!varId, '앞 단계 실패')
  const author = await as('sk-author'), mate = await as('sk-mate')
  const r = await author.post(`/folders/${slug}/merge`, { ids: [varId] })
  expect(r.status, r.text).toBe(200)
  expect(r.body.status).toBe('done')
  await expect.poll(() => fss.readFileSync(path.join(SKILLS_DIR, NAME, 'SKILL.md'), 'utf8'), { timeout: 20_000 }).toContain('위험·이슈')
  const info = (await author.get(`/folders/${slug}/skill`)).body
  expect(info.contributions.some((c) => c.id === mate.id && c.type === 'PROPOSAL_APPROVED')).toBe(true)
  expect((await author.get(`/folders/${slug}/variations/${varId}/review`)).body.pr.status).toBe('MERGED')
})
