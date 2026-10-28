// 팀 공유·이어서 작업 워크트리 — 실제 업무 그대로 Lite 화면에서.
//   홍길동(영업)이 에이전트와 대화해 솔잎책방 합정점 리모델링 견적서·요청 메모를 만들고, 견적서만 골라
//   이팀장(설계)·박대리(구매)에게 공유한다. 이팀장은 편집기에서 설계비를 고쳐 저장하고, 박대리는 '이어서 작업'으로
//   에이전트에게 자재 원가표를 만들게 한다. 홍길동은 두 갈래 결과를 읽기 전용으로 보고, 자기 공유에서 이어서
//   작업해 모은다. 두 사람이 요청 메모를 서로 다르게 고치면 홍길동이 다음 공유에서 한쪽을 고른다.
// 화면에 보이는 이름·파일·메모는 업무 문장 그대로(실행 번호를 붙이지 않는다). 실행 구분은 시작 시각으로 한다.
// 판정은 남는 결과(공유 행·브랜치·커밋·Storage 객체·작업 폴더 파일)로, DB 는 읽기만 한다.
// (server/lib/team/worktree.js · 설계 process-gpt/openspec/changes/pgpt-pro-share-worktree)
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { test, expect, api } from '../../lib/fixtures.js'
import { waitFor } from '../../lib/agent.js'

test.describe.configure({ mode: 'serial' })

const DEEPAGENTS_WS = process.env.DEEPAGENTS_WORKSPACE || path.resolve(process.cwd(), '../../process-gpt-deepagents/workspace')
const T = 'localhost'
const ESTIMATE = '솔잎책방_견적서.docx', MEMO = '솔잎책방_요청메모.docx'
const PEOPLE = { hong: '홍길동', lee: '이팀장', park: '박대리' }
const s = {} // shared across the serial steps

test.beforeEach(async () => {
  await expect.poll(async () => (await api.call(null, 'GET', '/config', null, { timeout: 5000 }).catch(() => ({ status: 0 }))).status, { timeout: 120_000, intervals: [3000] }).toBe(200)
})

// the people, signed in under their names, on the team (another run's teardown takes pro-rt-* accounts off it)
async function people(pageAs, ...who) {
  const out = []
  for (const k of who) {
    const p = await pageAs(`wt-${k}`)
    await p.user.post('/profile', { name: PEOPLE[k] })
    await p.user.get('/team')
    out.push(p)
  }
  return out
}

// --- what a person does on the screen ---
async function openMessenger(page) {
  if (!/\/(chat|projects)/.test(page.url())) await page.goto('/chat')
  await page.locator('.msg-btn').click()
  await expect(page.locator('.ms')).toBeVisible()
}
async function chatSend(page, text) {
  await page.locator('textarea').last().fill(text)
  await page.getByRole('button', { name: '보내기' }).last().click()
}
async function share(page, fileName, to, note) {
  await page.locator(`[aria-label="${fileName} 공유"]`).last().click()
  const sp = page.locator('.sp')
  for (const name of to) {
    await sp.locator('.find').fill(name)
    await sp.locator('.row', { hasText: name }).first().click()
  }
  await sp.locator('.find').fill('')
  await sp.locator('.note').fill(note)
  await sp.locator('.send').click()
  return sp
}
// the newest inbox item with this note
const inboxItem = (page, note) => page.locator('.mail', { hasText: note }).first()
async function openFromInbox(page, note) {
  await openMessenger(page)
  await inboxItem(page, note).getByRole('button', { name: '편집기에서 열기' }).click()
  await expect(page.locator('.sheet iframe')).toBeVisible({ timeout: 30_000 })
}
// the open Word document's page in the editor
const docPage = (page) => page.frameLocator('.sheet iframe').locator('.doc-page')
// types a line at the end of the open document and saves (⌘S): the editor uploads its edited copy
async function editAndSave(page, text) {
  const ed = docPage(page)
  await expect(ed).toBeVisible({ timeout: 60_000 })
  await ed.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(text)
  await page.keyboard.press('ControlOrMeta+s')
}
async function openDmWith(page, name) {
  await openMessenger(page)
  await page.locator('.tabs button', { hasText: '대화' }).click()
  await page.locator('.th', { hasText: name }).first().click()
}

// --- judgement (DB read only) ---
const head = async (db, room) => (await db.q(`select b.*, c.tree, c.reason from artifact_branches b join artifact_commits c on c.id=b.head_commit_id where b.room_id=$1`, [room]))[0]
const commits = (db, room) => db.q('select reason from artifact_commits where room_id=$1 order by created_at', [room])
// the text of a Word document (word/document.xml without tags)
const docxText = async (buf) => {
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string')
  return xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')
}
const urlText = async (url) => docxText(Buffer.from(await (await fetch(url)).arrayBuffer()))
const objectText = (sha) => urlText(`http://127.0.0.1:54321/storage/v1/object/public/files/artifacts/${T}/objects/${sha}`)
const agentIdle = async (db, thread) => (await db.q('select status from pro_threads where id=$1', [thread]))[0]?.status == null
const cardsOf = (db, thread, name) => db.q(`select * from pro_messages where thread_id=$1 and kind='file' and content->>'name'=$2 order by created_at`, [thread, name])

test('W-00 홍길동이 에이전트와 대화해 견적서와 요청 메모를 만든다', async ({ pageAs, db }) => {
  test.setTimeout(20 * 60_000)
  const [hong, lee, park] = await people(pageAs, 'hong', 'lee', 'park')
  Object.assign(s, { hongId: hong.user.id, leeId: lee.user.id, parkId: park.user.id })
  s.hongMain = await db.clearMain(hong.user.id)
  await hong.goto('/chat')
  await chatSend(hong, `솔잎책방 합정점 리모델링 건으로 워드(docx) 문서 두 개를 작업 폴더에 만들어 줘.
1) ${ESTIMATE}: 견적서. 항목은 설계비 500,000원, 목공 3,200,000원, 전기 800,000원이고 합계 4,500,000원.
2) ${MEMO}: 고객 요청 메모. 서가 높이를 낮추고 창가에 열람석을 두고 싶다는 요청.
두 파일을 만들고 짧게 답해 줘.`)
  await waitFor(async () => (await cardsOf(db, s.hongMain, ESTIMATE)).length && (await cardsOf(db, s.hongMain, MEMO)).length && agentIdle(db, s.hongMain), { timeout: 15 * 60_000 })
  await expect(hong.locator(`[aria-label="${ESTIMATE} 공유"]`).last()).toBeVisible({ timeout: 30_000 })
})

test('W-01 견적서만 골라 이팀장·박대리에게 공유하면 둘 다 공유 시점 내용으로 열리고, 내용은 한 벌·사본 0개·같은 기준 커밋', async ({ pageAs, db }) => {
  const [hong, lee, park] = await people(pageAs, 'hong', 'lee', 'park')
  await hong.goto('/chat')
  s.note1 = '견적 금액 검토 부탁드려요. 이팀장님은 설계비, 박대리님은 자재 원가를 봐 주세요.'
  const t1 = new Date()
  await share(hong, ESTIMATE, [PEOPLE.lee, PEOPLE.park], s.note1)
  await expect(hong.locator('.sp')).toBeHidden({ timeout: 60_000 })

  const rows = await db.q(`select * from pro_shares where owner_id=$1 and name=$2 and created_at >= $3 order by created_at`, [s.hongId, ESTIMATE, t1])
  expect(rows.length).toBe(2)
  expect(new Set(rows.map((r) => r.batch_id)).size, '한 묶음').toBe(1)
  // every branch splits from the same sender commit (picked files only: create_branch makes each
  // recipient a commit whose one parent is that commit — the same rule as process-gpt's handover)
  expect(new Set(rows.map((r) => r.base_commit_id)).size, '같은 기준 커밋').toBe(1)
  const starts = await db.q('select parents from artifact_commits where id = any($1::uuid[])', [rows.map((r) => r.start_commit_id)])
  expect(starts.every((c) => c.parents.length === 1 && c.parents[0] === rows[0].base_commit_id), '시작 커밋의 부모 = 기준 커밋').toBe(true)
  s.leeRoom = rows.find((r) => r.recipient_id === s.leeId).branch_room_id
  s.parkRoom = rows.find((r) => r.recipient_id === s.parkId).branch_room_id
  s.parkStart = rows.find((r) => r.recipient_id === s.parkId).start_commit_id
  s.hongRoom = rows[0].source_room_id
  const lh = await head(db, s.leeRoom)
  expect(Object.keys(lh.tree), '고르지 않은 요청 메모는 넘어가지 않는다').toEqual([ESTIMATE])
  s.sha0 = lh.tree[ESTIMATE].sha256
  expect((await db.q(`select count(*)::int n from storage.objects where bucket_id='files' and name=$1`, [`artifacts/${T}/objects/${s.sha0}`]))[0].n, '내용 객체 한 벌').toBe(1)

  for (const p of [lee, park]) {
    await openFromInbox(p, s.note1)
    await expect(p.locator('.sheet iframe')).toHaveAttribute('src', new RegExp(`objects%2F${s.sha0}`))
    await expect(docPage(p)).toContainText('설계비', { timeout: 60_000 })
    await p.goto('/chat')
  }
  const copies = await db.q(`select count(*)::int n from storage.objects where bucket_id='files' and created_at >= $1 and (name like $2 or name like $3)`,
    [t1, `pgpt-pro/${s.leeId}/%`, `pgpt-pro/${s.parkId}/%`])
  expect(copies[0].n, 'Storage 사본 0개').toBe(0)
})

test('W-02 이팀장이 편집기에서 설계비를 고쳐 저장하면 이팀장 브랜치에만 커밋, 박대리·홍길동 원본은 그대로, 홍길동은 "1개 고침"을 본다', async ({ pageAs, db }) => {
  const [lee, hong] = await people(pageAs, 'lee', 'hong')
  await openFromInbox(lee, s.note1)
  await editAndSave(lee, '설계비는 현장 실측이 추가되어 600,000원으로 조정합니다.')
  await waitFor(async () => (await head(db, s.leeRoom)).reason === 'edit', { timeout: 60_000, every: 1000 })
  const lh = await head(db, s.leeRoom)
  expect(await objectText(lh.tree[ESTIMATE].sha256)).toContain('600,000원으로 조정')
  s.leeSha = lh.tree[ESTIMATE].sha256
  expect((await head(db, s.parkRoom)).head_commit_id, '박대리 갈래는 그대로').toBe(s.parkStart)
  const [orig] = await cardsOf(db, s.hongMain, ESTIMATE)
  expect(await urlText(orig.content.url), '홍길동 원본 그대로').not.toContain('600,000원으로 조정')
  // reopened later, the edit is there
  await lee.goto('/chat')
  await openFromInbox(lee, s.note1)
  await expect(docPage(lee)).toContainText('600,000원으로 조정', { timeout: 60_000 })

  await openDmWith(hong, PEOPLE.lee)
  await expect(hong.locator(`.br[data-room="${s.leeRoom}"]`)).toContainText('1개 고침', { timeout: 20_000 })
})

test('W-03 박대리가 이어서 작업하면 전용 작업 대화에서 넘겨받은 견적서로 원가표를 만들고(턴 끝 커밋), 질문만 하면 커밋 없음', async ({ pageAs, db }) => {
  test.setTimeout(30 * 60_000)
  const [park, hong] = await people(pageAs, 'park', 'hong')
  await openMessenger(park)
  await inboxItem(park, s.note1).getByRole('button', { name: '이어서 작업' }).click()
  await park.waitForURL(/\/projects\/[0-9a-f-]{36}/, { timeout: 30_000 })
  const thread = /projects\/([0-9a-f-]{36})/.exec(park.url())[1]
  expect(`pro:${thread}`, '공유의 작업 대화 = 박대리 브랜치 방').toBe(s.parkRoom)
  await waitFor(async () => (await agentIdle(db, thread)) &&
    (await db.q(`select count(*)::int n from pro_messages where thread_id=$1 and role='agent' and kind in ('text','doc')`, [thread]))[0].n >= 2, { timeout: 15 * 60_000 })

  await chatSend(park, '받은 견적서의 목공·전기 항목에 들어갈 자재 원가표를 워드 문서 솔잎책방_원가표.docx 로 만들어 줘. 파일만 만들고 짧게 답해 줘.')
  await waitFor(async () => Object.keys((await head(db, s.parkRoom)).tree).some((p) => /원가표/.test(p)), { timeout: 15 * 60_000 })
  const ph = await head(db, s.parkRoom)
  expect(ph.reason).toBe('agent_turn')
  s.costPath = Object.keys(ph.tree).find((p) => /원가표/.test(p))
  expect(await objectText(ph.tree[s.costPath].sha256)).toMatch(/목공|전기/)
  await waitFor(() => agentIdle(db, thread), { timeout: 5 * 60_000 })

  const n1 = (await commits(db, s.parkRoom)).length
  const t1 = new Date()
  await chatSend(park, '견적서 합계 금액이 얼마예요? 파일은 고치지 말고 금액만 알려 주세요.')
  await waitFor(async () => (await db.q(`select 1 from pro_messages where thread_id=$1 and role='agent' and kind in ('text','doc') and created_at > $2`, [thread, t1])).length > 0 && agentIdle(db, thread), { timeout: 10 * 60_000 })
  const [ans] = await db.q(`select content from pro_messages where thread_id=$1 and role='agent' and kind in ('text','doc') and created_at > $2 order by created_at desc limit 1`, [thread, t1])
  expect(ans.content.text, '넘겨받은 견적서로 답한다').toMatch(/4,?500,?000|450만/)
  expect((await commits(db, s.parkRoom)).length, '바뀐 것이 없으면 커밋 없음').toBe(n1)

  // the sender sees the new file and opens it read-only
  await openDmWith(hong, PEOPLE.park)
  const br = hong.locator(`.br[data-room="${s.parkRoom}"]`)
  await expect(br).toContainText('1개 추가', { timeout: 20_000 })
  await br.locator('.art', { hasText: '원가표' }).click()
  await expect(hong.locator('.sheet iframe')).toHaveAttribute('src', /readonly=1/)

  // a teammate outside the share cannot see the branches
  const out = await api.as('wt-outsider')
  await out.get('/team')
  const [m] = await db.q('select chat_uuid from pro_shares where branch_room_id=$1 limit 1', [s.parkRoom])
  expect((await out.get(`/team/messages/${m.chat_uuid}/branches`)).status).toBe(403)
  expect((await out.get(`/team/branches/file?room=${encodeURIComponent(s.parkRoom)}&path=${encodeURIComponent(s.costPath)}`)).status).toBe(403)
})

test('W-04 홍길동이 자기 공유에서 이어서 작업하면 고친 견적서와 새 원가표가 모두 작업 폴더에 있다', async ({ pageAs, db }) => {
  test.setTimeout(30 * 60_000)
  const [hong] = await people(pageAs, 'hong')
  await openDmWith(hong, PEOPLE.lee)
  await hong.locator('.msg.mine', { hasText: s.note1 }).last().getByRole('button', { name: '이어서 작업' }).click()
  await hong.waitForURL(/\/projects\/[0-9a-f-]{36}/, { timeout: 60_000 })
  const thread = /projects\/([0-9a-f-]{36})/.exec(hong.url())[1]
  const ch = await head(db, `pro:${thread}`)
  expect(ch.tree[ESTIMATE].sha256, '이팀장이 고친 견적서').toBe(s.leeSha)
  expect(ch.tree[s.costPath], '박대리가 만든 원가표').toBeTruthy()
  const [merge] = await db.q(`select parents from artifact_commits where room_id=$1 and reason='merge' order by created_at desc limit 1`, [s.hongRoom])
  expect(merge.parents.length, '합류 커밋은 내 대화 + 두 갈래').toBe(3)
  const dir = path.join(DEEPAGENTS_WS, T, '.bpmn', `pro_${thread}`)
  await waitFor(async () => fs.existsSync(path.join(dir, ESTIMATE)) && fs.existsSync(path.join(dir, s.costPath)), { timeout: 10 * 60_000 })
  expect(await docxText(fs.readFileSync(path.join(dir, ESTIMATE)))).toContain('600,000원으로 조정')
})

test('W-05 두 사람이 요청 메모를 서로 다르게 고치면 홍길동이 다음 공유에서 한쪽을 골라야 보내지고, 고른 쪽이 간다', async ({ pageAs, db }) => {
  const [hong, lee, park] = await people(pageAs, 'hong', 'lee', 'park')
  await hong.goto('/chat')
  s.note2 = '고객 요청 메모예요. 각자 확인한 내용을 덧붙여 주세요.'
  const t1 = new Date()
  await share(hong, MEMO, [PEOPLE.lee, PEOPLE.park], s.note2)
  await expect(hong.locator('.sp')).toBeHidden({ timeout: 60_000 })
  const rows = await db.q(`select * from pro_shares where owner_id=$1 and name=$2 and created_at >= $3`, [s.hongId, MEMO, t1])
  const roomOf = (id) => rows.find((r) => r.recipient_id === id).branch_room_id
  for (const [p, text] of [[lee, '설계: 서가 높이는 1.2m 로 맞춥니다.'], [park, '구매: 열람석 의자는 기존 재고 6개를 씁니다.']]) {
    await openFromInbox(p, s.note2)
    await editAndSave(p, text)
    await waitFor(async () => (await head(db, roomOf(p.user.id))).reason === 'edit', { timeout: 60_000, every: 1000 })
  }
  const parkSha = (await head(db, roomOf(s.parkId))).tree[MEMO].sha256

  await hong.goto('/chat')
  const t2 = new Date()
  const sp = await share(hong, MEMO, [PEOPLE.lee], '요청 메모 최종본이에요. 이걸로 도면 작업해 주세요.')
  const cc = sp.locator('.cc')
  await expect(cc).toContainText(MEMO, { timeout: 30_000 })
  await expect(sp.locator('.send')).toBeDisabled()
  await cc.locator('.side', { hasText: PEOPLE.park }).click()
  await cc.getByRole('button', { name: '고른 쪽으로' }).click()
  await expect(sp).toBeHidden({ timeout: 60_000 })
  const [last] = await db.q(`select branch_room_id from pro_shares where owner_id=$1 and name=$2 and created_at >= $3`, [s.hongId, MEMO, t2])
  expect((await head(db, last.branch_room_id)).tree[MEMO].sha256, '고른 쪽(박대리)').toBe(parkSha)
})

// The one step that cannot be a real flow: a share made before this change. It is sent on the screen,
// then its rows are put back the way the copy-style share wrote them (no branch).
test('W-06 이 변경 전에 받은 사본 공유는 예전처럼 받는 사람의 사본으로 열린다', async ({ pageAs, db }) => {
  const [hong, lee] = await people(pageAs, 'hong', 'lee')
  await hong.goto('/chat')
  const note = '지난번 견적서 다시 보내요.'
  const t1 = new Date()
  await share(hong, ESTIMATE, [PEOPLE.lee], note)
  await expect(hong.locator('.sp')).toBeHidden({ timeout: 60_000 })
  const [orig] = await cardsOf(db, s.hongMain, ESTIMATE)
  const key = decodeURIComponent(/\/public\/files\/(.+)$/.exec(orig.content.url)[1])
  await db.q(`update pro_shares set branch_room_id=null, source_room_id=null, path=null, base_commit_id=null, start_commit_id=null, batch_id=null, copy_message_id=null, object_key=$2
              where owner_id=$1 and created_at >= $3`, [s.hongId, key, t1])
  await openFromInbox(lee, note)
  const main = await db.mainThreadId(s.leeId)
  const [copy] = await db.q(`select content from pro_messages where thread_id=$1 and kind='file' and content->>'name'=$2 and created_at >= $3`, [main, ESTIMATE, t1])
  expect(copy?.content?.shared?.shareId, '받는 사람 기본 대화의 사본 카드').toBeTruthy()
  expect(copy.content.url).not.toBe(orig.content.url)
})
