// 에이전트 작업실 — 파일 보기·사람이 직접 고쳐 넣기(공유 폴더면 커밋)·동시 수정 충돌·공개·터미널(같은 폴더의 셸)
// 그리고 터미널 환경에 서버의 비밀이 새지 않는다. (spec pgpt-pro_agent-workroom · 영상 youtu.be/jDbjGIMrc5o, ppLKYAAGf78)
import { test, expect, uniq } from '../../lib/fixtures.js'
import { removeFolder } from '../../lib/seed.js'
import { upgrade } from '../../lib/net.js'

async function folderRoom(u, db, cleanup) {
  const f = await u.post('/folders', { name: uniq('회귀 작업실') })
  cleanup(() => removeFolder(db, f.body.slug))
  await u.post(`/folders/${f.body.slug}/files?path=rules.md`, new TextEncoder().encode('# 규칙\n\n- R1: 부정 반응 급증 → 알림\n'), { headers: { 'Content-Type': 'text/markdown' } })
  return f.body.slug
}

test('F-WR-01 사람이 규칙을 고쳐 넣으면 저장(커밋)되고, 그 사이 바뀐 파일은 덮어쓰지 않는다', async ({ as, db, cleanup }) => {
  const u = await as('wr-user')
  const slug = await folderRoom(u, db, cleanup)
  const room = (await u.get(`/workroom/folder/${slug}`)).body
  expect(room.files.map((f) => f.path || f.name)).toEqual(expect.arrayContaining(['rules.md']))
  const f = (await u.get(`/workroom/folder/${slug}/file?path=rules.md`)).body
  expect(f.content).toContain('R1')
  const w = await u.put(`/workroom/folder/${slug}/file`, { path: 'rules.md', content: f.content + '- R2: 긍정 반응 폭증 → 즉시 대응\n', mtime: f.mtime })
  expect(w.status, w.text).toBe(200)
  expect((await u.put(`/workroom/folder/${slug}/file`, { path: 'rules.md', content: 'stale', mtime: f.mtime })).status).toBe(409)
  expect((await u.get(`/folders/${slug}/raw?path=rules.md`)).text).toContain('R2')
  const hist = (await u.get(`/folders/${slug}`)).body.history
  expect(JSON.stringify(hist)).toContain('작업실에서 고침')
  const pub = await u.post(`/workroom/folder/${slug}/publish`, { path: 'rules.md' })
  expect(pub.status, pub.text).toBe(200)
})

test('F-WR-02 터미널: 같은 폴더에서 셸이 열리고, 서버의 키·비밀 환경 변수는 보이지 않는다', async ({ as, db, cleanup }) => {
  const u = await as('wr-user')
  const slug = await folderRoom(u, db, cleanup)
  const t = (await u.post(`/workroom/folder/${slug}/ticket`, { mode: 'shell' })).body.ticket
  const { ws, status } = await upgrade(`/api/workroom/term?ticket=${t}`)
  expect(status).toBe(101)
  let out = ''
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'output') out += m.data })
  const mark = `rt-${Date.now().toString(36)}`
  ws.send(JSON.stringify({ type: 'input', data: `ls; echo ${mark}-n=$(env | grep -cE 'KEY|SECRET|TOKEN|PASSWORD|^PRO_'); exit\r` }))
  await expect.poll(() => out, { timeout: 20_000 }).toMatch(new RegExp(`${mark}-n=\\d+`))
  expect(out).toContain('rules.md')
  expect(new RegExp(`${mark}-n=(\\d+)`).exec(out)[1]).toBe('0')
  ws.close()
})

test('F-WR-03 화면: 작업실 파일 패널에서 파일을 누르면 터미널 자리에서 열리고 마크다운은 미리보기', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('wr-user')
  const slug = await folderRoom(page.user, db, cleanup)
  await page.goto(`/workroom/folder/${slug}`)
  await expect(page.locator('.wr .hd')).toBeVisible()
  if (!(await page.locator('.wr .body.side').count())) await page.locator('.wr .hb', { hasText: '파일' }).click()
  await page.getByText('rules.md').first().click()
  await expect(page.locator('.wr .fbox')).toBeVisible()
  await expect(page.locator('.wr .fbox')).toContainText('R1')
  expect(page.errors).toEqual([])
})
