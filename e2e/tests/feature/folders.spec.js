// 공유 폴더 — 만들기·권한·드라이브처럼 파일·변형·비교·일괄 반영(충돌이면 멈춤)·충돌 해결·인계·색인 검색.
// (spec pgpt-pro_shared-folders · 영상 공유 폴더 youtu.be/uam0ffMMu7U)
import { test, expect, uniq, api } from '../../lib/fixtures.js'
import { removeFolder } from '../../lib/seed.js'

const enc = (s) => new TextEncoder().encode(s)
const NOTICE = '# 고객 세미나 안내\n\n일시: 11월 20일\n신청: 현장 접수\n문의: 고객경험팀\n'

async function seedFolder(owner, db, cleanup, label = '회귀 세미나') {
  const f = await owner.post('/folders', { name: uniq(label), description: '회귀 시험 폴더' })
  expect(f.status, f.text).toBe(200)
  cleanup(() => removeFolder(db, f.body.slug))
  const up = await owner.post(`/folders/${f.body.slug}/files?path=${encodeURIComponent('안내문/안내문.md')}`, enc(NOTICE), { headers: { 'Content-Type': 'text/markdown' } })
  expect(up.status, up.text).toBe(200)
  return f.body.slug
}
// a person's variation with one file changed (checkout → workroom save = commit → ready)
async function variationWith(u, slug, title, content) {
  const v = await u.post(`/folders/${slug}/variations`, { title })
  expect(v.status, v.text).toBe(200)
  const co = await u.post(`/folders/${slug}/variations/${v.body.id}/checkout`)
  expect(co.status, co.text).toBe(200)
  const w = await u.put(`/workroom/variation/${v.body.id}/file`, { path: '안내문/안내문.md', content })
  expect(w.status, w.text).toBe(200)
  const c = await u.post(`/folders/${slug}/variations/${v.body.id}/commit`, { message: title, release: true })
  expect(c.status, c.text).toBe(200)
  const d = await u.get(`/folders/${slug}/variations/${v.body.id}`)
  expect(d.body.status).toBe('ready')
  return v.body.id
}
const mainText = async (u, slug) => (await u.get(`/folders/${slug}/raw?path=${encodeURIComponent('안내문/안내문.md')}`)).text

test.describe('공유 폴더', () => {
  test('F-FO-01 관리형 폴더 만들기 → 만든 사람이 소유자, 목록·트리에 파일', async ({ as, db, cleanup }) => {
    const o = await as('fo-owner')
    const slug = await seedFolder(o, db, cleanup)
    const d = await o.get(`/folders/${slug}`)
    expect(d.body.role).toBe('owner')
    expect((await o.get('/folders')).body.some((x) => x.slug === slug)).toBe(true)
    expect(JSON.stringify((await o.get(`/folders/${slug}/tree`)).body)).toContain('안내문.md')
    expect(await mainText(o, slug)).toContain('현장 접수')
  })

  test('F-FO-02 git 저장소가 아닌 경로 등록은 거절', async ({ as }) => {
    const o = await as('fo-owner')
    const r = await o.post('/folders/link', { path: '/tmp', name: uniq('회귀 링크') })
    expect(r.status).toBe(400)
  })

  test('F-FO-03 구성원이 아니면 403, 보기 권한으로 올리기는 403', async ({ as, db, cleanup }) => {
    const o = await as('fo-owner'), viewer = await as('fo-viewer'), out = await as('fo-out')
    const slug = await seedFolder(o, db, cleanup)
    expect((await out.get(`/folders/${slug}`)).status).toBe(403)
    expect((await out.get(`/folders/${slug}/raw?path=${encodeURIComponent('안내문/안내문.md')}`)).status).toBe(403)
    expect((await o.post(`/folders/${slug}/members`, { type: 'user', id: viewer.id, role: 'viewer' })).status).toBe(200)
    expect((await viewer.get(`/folders/${slug}`)).body.role).toBe('viewer')
    const up = await viewer.post(`/folders/${slug}/files?path=x.md`, enc('x'), { headers: { 'Content-Type': 'text/markdown' } })
    expect(up.status).toBe(403)
    expect((await viewer.post(`/folders/${slug}/variations`, { title: 'x' })).status).toBe(403)
    // the last owner cannot be removed
    expect((await o.del(`/folders/${slug}/members/user/${o.id}`)).status).toBe(400)
  })

  test('F-FO-04 변형 두 갈래 → 비교(diff) → 충돌 없는 일괄 반영', async ({ as, db, cleanup }) => {
    const o = await as('fo-owner')
    const slug = await seedFolder(o, db, cleanup)
    const a = await variationWith(o, slug, '마감일 추가', NOTICE.replace('일시: 11월 20일\n', '일시: 11월 20일\n신청 마감: 11월 14일\n'))
    const b = await variationWith(o, slug, '문의처 바꾸기', NOTICE.replace('문의: 고객경험팀', '문의: cx@example.com'))
    const diff = await o.get(`/folders/${slug}/variations/${a}/diff?path=${encodeURIComponent('안내문/안내문.md')}`)
    expect(diff.body.binary).toBe(false)
    expect(diff.body.base).not.toContain('신청 마감')
    expect(diff.body.head).toContain('신청 마감: 11월 14일')
    expect(await mainText(o, slug)).not.toContain('신청 마감') // main untouched until merged
    const m = await o.post(`/folders/${slug}/merge`, { ids: [a, b], policy: 'stop' })
    expect(m.status, m.text).toBe(200)
    expect(m.body.status).toBe('done')
    const txt = await mainText(o, slug)
    expect(txt).toContain('신청 마감: 11월 14일')
    expect(txt).toContain('cx@example.com')
    for (const id of [a, b]) expect((await o.get(`/folders/${slug}/variations/${id}`)).body.status).toBe('merged')
  })

  test('F-FO-05 같은 줄을 다르게 고친 두 변형 → 반영이 멈추고 main 은 그대로 → 한쪽을 골라 끝낸다', async ({ as, db, cleanup }) => {
    const o = await as('fo-owner')
    const slug = await seedFolder(o, db, cleanup)
    const a = await variationWith(o, slug, '사전 신청', NOTICE.replace('신청: 현장 접수', '신청: 사전 신청 필수'))
    const b = await variationWith(o, slug, '온라인 신청', NOTICE.replace('신청: 현장 접수', '신청: https://example.com/seminar'))
    const before = await mainText(o, slug)
    const m = await o.post(`/folders/${slug}/merge`, { ids: [a, b], policy: 'stop' })
    expect(m.body.status).toBe('conflicted')
    expect(m.body.conflicts.map((c) => c.path)).toEqual(['안내문/안내문.md'])
    expect(await mainText(o, slug)).toBe(before)
    // another merge cannot start while this one waits
    expect((await o.post(`/folders/${slug}/merge`, { ids: [a] })).status).toBe(409)
    const sides = await o.get(`/folders/${slug}/merge/${m.body.id}/sides?path=${encodeURIComponent('안내문/안내문.md')}`)
    expect(sides.body.ours).toContain('사전 신청 필수')
    expect(sides.body.theirs).toContain('https://example.com/seminar')
    const done = await o.post(`/folders/${slug}/merge/${m.body.id}/choose`, { choices: { '안내문/안내문.md': 'ours' } })
    expect(done.status, done.text).toBe(200)
    expect(done.body.status).toBe('done')
    expect(await mainText(o, slug)).toContain('사전 신청 필수')
  })

  test('F-FO-06 셋 중 하나만 골라 반영하면 나머지는 그대로 남는다', async ({ as, db, cleanup }) => {
    const o = await as('fo-owner')
    const slug = await seedFolder(o, db, cleanup)
    const ids = []
    for (const [i, t] of ['A', 'B', 'C'].entries()) ids.push(await variationWith(o, slug, `갈래 ${t}`, NOTICE + `\n추가 ${t}${i}\n`))
    const m = await o.post(`/folders/${slug}/merge`, { ids: [ids[1]] })
    expect(m.body.status).toBe('done')
    const vs = (await o.get(`/folders/${slug}`)).body.variations
    expect(vs.find((v) => v.id === ids[1]).status).toBe('merged')
    expect(vs.find((v) => v.id === ids[0]).status).toBe('ready')
    expect(vs.find((v) => v.id === ids[2]).status).toBe('ready')
  })

  test('F-FO-07 인계: 구성원이 아닌 사람에게는 권한을 함께 주지 않으면 거절', async ({ as, db, cleanup }) => {
    const o = await as('fo-owner'), out = await as('fo-out')
    const slug = await seedFolder(o, db, cleanup)
    const v = await variationWith(o, slug, '인계할 변형', NOTICE + '\n인계 메모\n')
    const r = await o.post(`/folders/${slug}/variations/${v}/handover`, { to: { id: out.id, name: '외부인' }, next: '마무리해 주세요' })
    expect(r.status).toBe(403)
    expect((await o.post(`/folders/${slug}/variations/${v}/handover`, { to: { id: out.id, name: '외부인' } })).status).toBe(400)
  })

  test('F-FO-08 버린 변형은 다시 열 수 없다 · 반영한 변형도', async ({ as, db, cleanup }) => {
    const o = await as('fo-owner')
    const slug = await seedFolder(o, db, cleanup)
    const v = await variationWith(o, slug, '버릴 변형', NOTICE + '\nx\n')
    expect((await o.post(`/folders/${slug}/variations/${v}/discard`)).status).toBe(200)
    expect((await o.post(`/folders/${slug}/variations/${v}/checkout`)).status).toBe(409)
    expect((await o.post(`/folders/${slug}/merge`, { ids: [v] })).status).toBe(409)
  })

  test('F-FO-09 색인으로 찾는다: 파일 이름·(전문 색인 켜면) 본문, 구성원이 아닌 폴더는 안 보임', async ({ as, db, cleanup }) => {
    const o = await as('fo-owner'), out = await as('fo-out')
    const slug = await seedFolder(o, db, cleanup)
    const word = `회귀단어${Date.now().toString(36)}`
    await o.post(`/folders/${slug}/files?path=${encodeURIComponent(`메모/${word}.md`)}`, enc(`# 메모\n\n본문 키워드 본문전용${word}\n`), { headers: { 'Content-Type': 'text/markdown' } })
    const byName = await o.get(`/folders/search?q=${encodeURIComponent(word)}`)
    expect(byName.body.some((h) => h.type === 'file' && h.file.path.includes(word))).toBe(true)
    expect((await out.get(`/folders/search?q=${encodeURIComponent(word)}`)).body).toEqual([])
    expect((await o.patch(`/folders/${slug}`, { fulltext: true })).status).toBe(200)
    await expect.poll(async () => (await o.get(`/folders/search?q=${encodeURIComponent(`본문전용${word}`)}`)).body.some((h) => h.by === 'text' || h.snippet), { timeout: 90_000, intervals: [2000] }).toBe(true)
    // the agent's catalog tool sees the same
    const c = await api.mcp('/mcp/folders', 'tools/call', { name: 'folder_catalog', arguments: { query: word } }, o.token())
    expect(api.toolText(c)).toContain(word)
    const c2 = await api.mcp('/mcp/folders', 'tools/call', { name: 'folder_catalog', arguments: { query: word } }, out.token())
    expect(api.toolText(c2)).not.toContain(`메모/${word}.md`)
  })

  test('F-FO-10 화면: 폴더 목록 → 폴더 → 파일 미리보기 → 변형 목록', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('fo-owner')
    const o = page.user
    const slug = await seedFolder(o, db, cleanup, '회귀 화면 폴더')
    await variationWith(o, slug, '화면용 변형', NOTICE + '\n화면\n')
    await o.post(`/folders/${slug}/files?path=${encodeURIComponent('루트 안내.md')}`, enc(NOTICE), { headers: { 'Content-Type': 'text/markdown' } })
    const name = (await o.get(`/folders/${slug}`)).body.name
    await page.goto('/folders')
    await page.locator('button.row', { hasText: name }).click()
    await expect(page).toHaveURL(new RegExp(`/folders/${slug}`))
    await expect(page.locator('.fd')).toBeVisible()
    await page.locator('.fn', { hasText: '루트 안내.md' }).first().click()
    await expect(page.locator('.veil')).toContainText('현장 접수', { timeout: 15_000 })
    await page.locator('.veil .tb.ic[title="닫기"]').click()
    await expect(page.locator('.vl')).toContainText('화면용 변형')
    expect(page.errors).toEqual([])
  })
})
