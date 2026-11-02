// 에이전트 파드의 작업 폴더를 이 서버가 디스크로 볼 수 없을 때(운영 k8s), deepagents 가 턴 끝에 올린
// 방 폴더(files 버킷 skills/<테넌트>/<방>/…)를 그대로 내려받는다 — 실제 Storage 에서:
//   하위 폴더·한글 이름(deepagents 의 __u8__ 인코딩)까지 원래 이름으로 돌아오고, 다른 방 것은 섞이지 않는다.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { admin, pool } from '../lib/supa.js'
import { config } from '../config.js'
import { fetchRoomDir, fetchRoomFile, rmRoomCopy, encodeSegment, roomPrefix, pushRoomDir, pullRoomChanges } from '../lib/roomStore.js'

const room = crypto.randomUUID().replace(/-/g, '')
const other = crypto.randomUUID().replace(/-/g, '')
const keys = []
const put = async (r, rel, body) => {
  const key = `skills/${config.tenantId}/${r}/${rel.split('/').map(encodeSegment).join('/')}`
  const { error } = await admin.storage.from('files').upload(key, Buffer.from(body), { upsert: true, contentType: 'text/plain' })
  if (error) throw error
  keys.push(key)
}

test('deepagents 와 같은 인코딩: 쓸 수 없는 글자가 있는 조각만 __u8__', () => {
  assert.equal(encodeSegment('SKILL.md'), 'SKILL.md')
  assert.equal(encodeSegment('견적서_한빛상사.docx'), '__u8__6rKs7KCB7IScX-2VnOu5m-yDgeyCrC5kb2N4') // Python 쪽 결과 그대로
  assert.equal(roomPrefix('/workspace/uploads/x'), null)
})

test('방 폴더의 스킬 초안이 하위 폴더·한글 이름까지 그대로 내려온다', async () => {
  await put(room, 'skills/견적-정리/SKILL.md', '---\nname: 견적-정리\n---\n')
  await put(room, 'skills/견적-정리/references/단가표.txt', '단가')
  await put(room, 'skills/다른-스킬/SKILL.md', 'x')
  await put(other, 'skills/견적-정리/SKILL.md', '다른 방')
  const local = await fetchRoomDir(`/workspace/.bpmn/${room}/skills/견적-정리`)
  try {
    assert.equal(path.basename(local), '견적-정리')
    assert.equal(await fs.readFile(path.join(local, 'SKILL.md'), 'utf8'), '---\nname: 견적-정리\n---\n')
    assert.equal(await fs.readFile(path.join(local, 'references', '단가표.txt'), 'utf8'), '단가')
    assert.deepEqual((await fs.readdir(local)).sort(), ['SKILL.md', 'references'])
  } finally { await rmRoomCopy(local) }
  assert.equal(await fetchRoomDir(`/workspace/.bpmn/${room}/skills/없는-스킬`), null)
})

test('작업실에만 있는 카드 파일 하나도 방 폴더 사본에서 읽는다(공유 커밋용)', async () => {
  await put(room, '견적서_한빛상사.docx', '견적 본문')
  const got = await fetchRoomFile(`/workspace/.bpmn/${room}/견적서_한빛상사.docx`)
  assert.equal(got.buf.toString('utf8'), '견적 본문')
  assert.equal(await fetchRoomFile(`/workspace/.bpmn/${room}/없는파일.docx`), null)
  assert.equal(await fetchRoomFile(`/workspace/.bpmn/${room}`), null) // 방 폴더 자체는 파일이 아니다
})

test('공유 폴더 체크아웃을 Storage 로 넘기고, 다른 파드의 에이전트가 고친 것만 돌려받는다', async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-worktree-'))
  await fs.writeFile(path.join(worktree, '.git'), 'gitdir: /here/only')
  await fs.mkdir(path.join(worktree, '문서'))
  await fs.writeFile(path.join(worktree, '문서', '견적 조건.md'), '원본')
  await fs.writeFile(path.join(worktree, '그대로.md'), '그대로')
  await fs.writeFile(path.join(worktree, '지운파일.md'), '여기서 지움')
  const pod = crypto.randomUUID().replace(/-/g, '')
  const dir = `/workspace/.bpmn/${pod}/folders/seminar`
  const seeded = await pushRoomDir(worktree, dir)
  keys.push(...(await pool.query("select name from storage.objects where bucket_id='files' and starts_with(name, $1)", [`${roomPrefix(dir)}/`])).rows.map((r) => r.name))
  // 하위 폴더 파일도 키 한 조각이라 deepagents 가 폴더 목록을 걷지 않고 찾는다
  assert.ok(keys.every((k) => !k.startsWith(roomPrefix(dir)) || !k.slice(roomPrefix(dir).length + 1).includes('/')))

  // 에이전트 파드가 받는 것: 파일은 있고 .git 포인터는 없다
  const hydrated = await fetchRoomDir(dir)
  assert.equal(await fs.readFile(path.join(hydrated, '문서', '견적 조건.md'), 'utf8'), '원본')
  await assert.rejects(fs.stat(path.join(hydrated, '.git')))
  await rmRoomCopy(hydrated)

  // 공유 디스크에서 사람이 지운 파일은 Storage 사본으로 되살아나지 않는다
  await fs.rm(path.join(worktree, '지운파일.md'))
  // 답이 끝난 뒤 deepagents 가 모든 파일을 다시 올린다
  const late = (async () => {
    await new Promise((r) => setTimeout(r, 300))
    await put(pod, 'folders/seminar/문서/견적 조건.md', '검토 메모 추가')
    await put(pod, 'folders/seminar/그대로.md', '그대로')
    await put(pod, 'folders/seminar/지운파일.md', '여기서 지움')
    await put(pod, 'folders/seminar/새 문서.md', '새로 만듦')
  })()
  const changed = await pullRoomChanges(dir, seeded, worktree, { timeoutMs: 20000, everyMs: 200 })
  await late
  assert.deepEqual(changed.sort(), ['문서/견적 조건.md', '새 문서.md'].sort())
  assert.equal(await fs.readFile(path.join(worktree, '문서', '견적 조건.md'), 'utf8'), '검토 메모 추가')
  assert.equal(await fs.readFile(path.join(worktree, '.git'), 'utf8'), 'gitdir: /here/only')
  await assert.rejects(fs.stat(path.join(worktree, '지운파일.md')))
  await fs.rm(worktree, { recursive: true })
})

after(async () => {
  if (keys.length) await admin.storage.from('files').remove(keys)
  await pool.end()
})
