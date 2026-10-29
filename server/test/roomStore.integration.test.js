// 에이전트 파드의 작업 폴더를 이 서버가 디스크로 볼 수 없을 때(운영 k8s), deepagents 가 턴 끝에 올린
// 방 폴더(files 버킷 skills/<테넌트>/<방>/…)를 그대로 내려받는다 — 실제 Storage 에서:
//   하위 폴더·한글 이름(deepagents 의 __u8__ 인코딩)까지 원래 이름으로 돌아오고, 다른 방 것은 섞이지 않는다.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { admin, pool } from '../lib/supa.js'
import { config } from '../config.js'
import { fetchRoomDir, rmRoomCopy, encodeSegment, roomPrefix } from '../lib/roomStore.js'

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

after(async () => {
  if (keys.length) await admin.storage.from('files').remove(keys)
  await pool.end()
})
