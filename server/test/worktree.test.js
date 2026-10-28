// 공유 워크트리의 tree 규칙(lib/team/worktree.js) — process-gpt-vue3 src/utils/artifactWorktree.test.js 와
// 같은 사례로, 두 화면의 합류 결과가 같은지 지킨다. 그리고 Lite 쪽 규칙: 카드의 tree 경로.
import test from 'node:test'
import assert from 'node:assert/strict'
// the module pulls in the DB client through its imports; a checkout without server/.env still runs these
process.env.SERVICE_ROLE_KEY ||= 'unit-test'
const { diffTrees, pickTree, rebaseChanges, mergeTrees, sideTree, pathOf, roomOf, threadOfRoom } = await import('../lib/team/worktree.js')

const e = (h) => ({ sha256: h.repeat(64).slice(0, 64), size: 1, content_type: 'text/plain' })

test('diffTrees 는 추가·변경·삭제를 나눈다', () => {
  assert.deepEqual(diffTrees({ a: e('1'), b: e('2'), c: e('3') }, { a: e('1'), b: e('9'), d: e('4') }), { added: ['d'], modified: ['b'], removed: ['c'] })
})

test('pickTree 는 고른 경로만 남긴다', () => {
  assert.deepEqual(Object.keys(pickTree({ a: e('1'), b: e('2'), c: e('3') }, ['a', 'c', 'x'])), ['a', 'c'])
})

test('rebaseChanges 는 내가 바꾼 경로만 새 head 위에 얹는다', () => {
  assert.deepEqual(rebaseChanges({ a: e('1'), b: e('2') }, { a: e('5'), c: e('6') }, { a: e('1'), b: e('2'), d: e('7') }), { a: e('5'), c: e('6'), d: e('7') })
})

test('mergeTrees: 한쪽만 바꾼 경로는 그 내용, 같은 내용이면 충돌 아님', () => {
  const base = { 견적서: e('1'), 원가표: e('2') }
  const { tree, conflicts } = mergeTrees(base, [
    { key: 'me', tree: base },
    { key: 'lee', tree: { 견적서: e('3'), 원가표: e('2') } },
    { key: 'park', tree: { 견적서: e('1'), 원가표: e('4'), 신규: e('5') } },
    { key: 'kim', tree: { 견적서: e('3'), 원가표: e('2') } },
  ])
  assert.equal(conflicts.length, 0)
  assert.deepEqual(tree, { 견적서: e('3'), 원가표: e('4'), 신규: e('5') })
})

test('mergeTrees: 서로 다르게 바꾼 경로는 충돌이고, 고르면 그 쪽', () => {
  const base = { 견적서: e('1') }
  const sides = [{ key: 'me', tree: base }, { key: 'lee', tree: { 견적서: e('3') } }, { key: 'park', tree: { 견적서: e('4') } }]
  assert.deepEqual(mergeTrees(base, sides).conflicts.map((c) => [c.path, c.sides.map((s) => s.key)]), [['견적서', ['lee', 'park']]])
  assert.deepEqual(mergeTrees(base, sides, { 견적서: 'park' }), { tree: { 견적서: e('4') }, conflicts: [] })
})

test('mergeTrees: 한 갈래가 지우고 다른 갈래가 고치면 충돌', () => {
  const sides = [{ key: 'x', tree: {} }, { key: 'y', tree: { a: e('2') } }]
  assert.equal(mergeTrees({ a: e('1') }, sides).conflicts.length, 1)
  assert.deepEqual(mergeTrees({ a: e('1') }, sides, { a: 'x' }).tree, {})
})

test('sideTree: 일부만 받은 갈래는 받지 않은 파일을 지운 것이 아니다', () => {
  const base = { 견적서: e('1'), 원가표: e('2'), 메모: e('3') }
  const head = { 견적서: e('5'), 검토의견: e('6') }
  assert.deepEqual(sideTree(base, { 견적서: e('1') }, head), { 견적서: e('5'), 원가표: e('2'), 메모: e('3'), 검토의견: e('6') })
  const merged = mergeTrees(base, [
    { key: 'me', tree: base },
    { key: 'lee', tree: sideTree(base, { 견적서: e('1') }, head) },
    { key: 'park', tree: sideTree(base, { 원가표: e('2') }, { 원가표: e('7') }) },
  ])
  assert.deepEqual(merged.tree, { 견적서: e('5'), 원가표: e('7'), 메모: e('3'), 검토의견: e('6') })
  assert.equal(merged.conflicts.length, 0)
})

test('Lite 방 id 는 pro:<대화 id> 이고 거꾸로 대화 id 를 돌려준다', () => {
  const id = '0b7c2a3e-1111-4222-8333-944455556666'
  assert.equal(roomOf(id), `pro:${id}`)
  assert.equal(threadOfRoom(roomOf(id)), id)
  assert.equal(threadOfRoom('8a1f-room'), null) // process-gpt 대화방은 Lite 대화가 아니다
})

test('pathOf: 이 방 작업 폴더의 카드는 상대 경로, 그 밖은 파일 이름', () => {
  const room = 'pro:0b7c2a3e-1111-4222-8333-944455556666'
  const slug = 'pro_0b7c2a3e-1111-4222-8333-944455556666' // deepagents _conv_slug
  assert.equal(pathOf({ content: { name: '원가표.xlsx', path: `/workspace/.bpmn/${slug}/out/원가표.xlsx` } }, room), 'out/원가표.xlsx')
  assert.equal(pathOf({ content: { name: '견적서.xlsx', path: '/workspace/.bpmn/other-room/견적서.xlsx' } }, room), '견적서.xlsx')
  assert.equal(pathOf({ content: { name: 'a/b.txt', url: 'http://x' } }, room), 'a_b.txt')
})
