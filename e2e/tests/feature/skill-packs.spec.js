// 업무 팩(skills/packs/<팩>/, server/lib/skillInstall.js): 업종 지식은 기본 설치에 없고 관리자가 회사에 켤 때만
// 설치된다(2026-11-21 결정 3). 화면은 서버의 구조화 필드만 읽는다 — 오류 문구·단계 이름·알림 제목을 읽지 않는다.
//   F-PK-01 일반 사용자는 팩 목록을 보기만 하고 켜지 못한다(403 · code ADMIN_ONLY)
//   F-PK-02 설정 › 스킬 화면의 「업무 팩」 줄 — 관리자가 아니면 켜고 끄는 단추가 없다
//   F-PK-03 홈의 할 일 카드 동사는 폼의 사실(decides)로 — /todos 가 그 필드를 준다
//   F-PK-04 문서 그림 요청: 그림 자체를 고치는지는 서버의 판정(구조화 답 edit)
//   F-PK-05 (RT_PACK_INSTALL=1 일 때만) 관리자가 켜면 설치·끄면 지움 — 공용 deepagents 의 이 테넌트 스킬을 실제로 바꾼다
import { test, expect } from '../../lib/fixtures.js'

test.describe('업무 팩', () => {
  test('F-PK-01 일반 사용자: 팩 목록은 보이고, 켜기는 403 · ADMIN_ONLY', async ({ as }) => {
    const u = await as('pack-user')
    const r = await u.get('/packs')
    expect(r.status, r.text).toBe(200)
    expect(r.body.admin).toBe(false)
    const p = r.body.packs.find((x) => x.name === 'store-design')
    expect(p, 'store-design 팩이 설치판에 있다').toBeTruthy()
    expect(p.title.ko).toBeTruthy()
    expect(p.skills.map((s) => s.name).sort()).toEqual(['cadcraft-floor-plan', 'quote-xlsx', 'store-design-proposal'])
    const put = await u.put('/packs/store-design', { enabled: true })
    expect(put.status).toBe(403)
    expect(put.body.code).toBe('ADMIN_ONLY')
    expect((await u.put('/packs/no-such-pack', { enabled: true })).status, '없는 팩도 관리자 확인이 먼저').toBe(403)
  })

  test('F-PK-02 설정 › 스킬: 업무 팩 줄이 보이고, 관리자가 아니면 단추 없이 상태만', async ({ pageAs }) => {
    const page = await pageAs('pack-user')
    await page.goto('/settings/skills')
    const sec = page.locator('[data-test="skill-packs"]')
    await expect(sec).toBeVisible({ timeout: 30_000 })
    const row = sec.locator('[data-test="pack-store-design"]')
    await expect(row).toBeVisible()
    await expect(row.locator('[data-test="pack-toggle"]')).toHaveCount(0)
    await expect(row.locator('.tag').last()).toHaveText(/꺼짐|켜짐|Off|On/)
    expect(page.errors).toEqual([])
  })

  test('F-PK-03 /todos 의 할 일마다 decides(폼에 고를 칸이 있는가)가 있다 — 카드 동사는 그 사실로', async ({ as }) => {
    const u = await as('pack-user')
    const r = await u.get('/todos')
    expect(r.status).toBe(200)
    for (const t of r.body) expect(typeof t.decides, t.activity_name).toBe('boolean')
  })

  test('F-PK-04 그림 요청 판정: 구조화 답 edit 만 돌려준다 (빈 요청은 문서에 남는다)', async ({ as }) => {
    const u = await as('pack-user')
    const empty = await u.post('/office/picture-intent', { text: '', picture: '그림 1' })
    expect(empty.body).toMatchObject({ edit: 'document' })
    const r = await u.post('/office/picture-intent', { text: '사진 속 하늘을 노을빛으로 칠해 줘', picture: '그림 1' })
    expect(r.status).toBe(200)
    expect(['image', 'document']).toContain(r.body.edit)
  })

  test('F-PK-05 관리자가 켜면 팩의 스킬이 회사에 설치되고, 끄면 우리가 올린 그대로인 사본만 지워진다', async ({ as, db, cleanup }) => {
    test.skip(process.env.RT_PACK_INSTALL !== '1', '공용 deepagents 의 테넌트 스킬을 실제로 바꾼다 — RT_PACK_INSTALL=1 일 때만')
    const a = await as('pack-admin')
    await db.q('update users set is_admin=true where id::text=$1', [a.id])
    cleanup(() => db.q('update users set is_admin=false where id::text=$1', [a.id]))
    const before = (await a.get('/packs')).body.packs.find((x) => x.name === 'store-design')
    cleanup(async () => { if (!before.enabled) await a.put('/packs/store-design', { enabled: false }) })
    const on = await a.put('/packs/store-design', { enabled: true }, { timeout: 120_000 })
    expect(on.status, on.text).toBe(200)
    expect(Object.values(on.body.skills).every((s) => ['installed', 'conflict', 'diverged'].includes(s)), JSON.stringify(on.body.skills)).toBe(true)
    const names = (await a.get('/skills')).body.map((s) => s.name)
    for (const [k, s] of Object.entries(on.body.skills)) if (s === 'installed') expect(names, k).toContain(k)
    if (!before.enabled) {
      const off = await a.put('/packs/store-design', { enabled: false }, { timeout: 120_000 })
      expect(off.status).toBe(200)
      const after = (await a.get('/skills')).body.map((s) => s.name)
      for (const [k, s] of Object.entries(off.body.skills)) if (s === 'disabled') expect(after, k).not.toContain(k)
    }
  })
})
