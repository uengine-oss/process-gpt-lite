// 다른 사람 파일이 내 대화에 카드로 붙지 않게 (tutorial-findings #6·#39): 이번 턴의 산출물만 파일 카드가 된다.
// lib/provenance.js — 모델·DB 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isOutput, keepToolDoc, roomOf, slug, sourcesOf, workspaceHint, workspacePaths } from '../lib/provenance.js'

const ROOM = roomOf('12593ce0fd6d474482650bc294f7a3eb')
const OLD = Date.parse('2026-10-20T00:00:00Z')
const START = Date.parse('2026-10-27T06:00:00Z')
// on disk: someone else's memo at the top of the workspace (old), a file this turn's script made (new)
const disk = { '/workspace/달빛커피_2호점_첫_미팅_메모.hwpx': OLD, '/workspace/팀 워크숍 계획서.hwpx': OLD, '/workspace/new-quote.xlsx': START + 5000 }
const ctx = { rooms: [ROOM], written: new Set(['/workspace/script-made.md']), since: START, mtime: async (p) => disk[p] ?? null }

test('대화 폴더 경로는 deepagents 와 같은 규칙(.bpmn/<대화 id>)', () => {
  assert.equal(ROOM, '/workspace/.bpmn/12593ce0fd6d474482650bc294f7a3eb')
  assert.equal(slug('a b/c'), 'a_b_c')
  assert.equal(roomOf(''), null)
})

test('작업 공간 경로 찾기: 따옴표 안 공백 경로, JSON 인자, 맨 경로', () => {
  assert.deepEqual(workspacePaths('`/workspace/11월 고객 세미나 예산표.xlsx` 를 만들었어요'), ['/workspace/11월 고객 세미나 예산표.xlsx'])
  assert.deepEqual(workspacePaths({ file_path: '/workspace/팀 워크숍 계획서.hwpx' }), ['/workspace/팀 워크숍 계획서.hwpx'])
  assert.ok(workspacePaths('ls\n/workspace/a.hwpx\n/workspace/.bpmn/x/b.docx').includes('/workspace/.bpmn/x/b.docx'))
})

test('이번 턴 산출물: 이번에 쓴 파일, 이 대화 폴더, 턴이 시작된 뒤 바뀐 파일 — 남의 오래된 파일은 아님', async () => {
  assert.equal(await isOutput('/workspace/script-made.md', ctx), true)
  assert.equal(await isOutput(`${ROOM}/견적서.xlsx`, ctx), true)
  assert.equal(await isOutput('/workspace/new-quote.xlsx', ctx), true)
  assert.equal(await isOutput('/workspace/달빛커피_2호점_첫_미팅_메모.hwpx', ctx), false)
  assert.equal(await isOutput('/workspace/.bpmn/other-room/x.hwpx', ctx), false)
  assert.equal(await isOutput('/workspace/uploads/someone-else/a/b.hwpx', ctx), false)
})

test('deepagents 가 끝에 다시 올린 hwpx(edited-<ascii>_<시각>.hwpx)는 원본 경로로 판단', async () => {
  const seen = new Set(['/workspace/달빛커피_2호점_첫_미팅_메모.hwpx', `${ROOM}/meeting-memo.hwpx`])
  assert.deepEqual(sourcesOf('edited-meeting-memo_20261027_061500.hwpx', seen), [`${ROOM}/meeting-memo.hwpx`])
  // someone else's memo, only listed by the agent: not shown
  const foreign = await keepToolDoc({ name: `edited-${'달빛커피_2호점_첫_미팅_메모.hwpx'.replace(/[^0-9A-Za-z._-]+/g, '_').replace(/^_+|_+$/g, '').replace(/\.hwpx$/, '')}_20261027_061500.hwpx`, tool: '' }, seen, ctx)
  assert.equal(foreign.keep, false, '남의 메모는 카드가 되지 않음')
  const mine = await keepToolDoc({ name: 'edited-meeting-memo_20261027_061501.hwpx', tool: '' }, seen, ctx)
  assert.deepEqual(mine, { keep: true, src: `${ROOM}/meeting-memo.hwpx` }, '내 대화 폴더의 문서는 원래 이름으로')
  // a republished copy nobody can place is not shown
  assert.equal((await keepToolDoc({ name: 'edited-unknown_20261027_061500.hwpx', tool: '' }, seen, ctx)).keep, false)
})

test('이름이 모두 한글이라 여러 경로가 맞으면, 모두 이번 턴 산출물일 때만', async () => {
  const seen = new Set(['/workspace/팀 워크숍 계획서.hwpx', `${ROOM}/견적 메모.hwpx`])
  assert.equal(sourcesOf('edited-_20261027_061500.hwpx', seen).length, 2)
  assert.equal((await keepToolDoc({ name: 'edited-_20261027_061500.hwpx', tool: '' }, seen, ctx)).keep, false)
})

test('도구가 만든 새 문서(템플릿 채우기)는 붙고, 남의 파일을 열어 올린 결과는 안 붙음', async () => {
  const seen = new Set()
  assert.deepEqual(await keepToolDoc({ name: '4c0d…_보고서.hwpx', tool: 'generate_hwpx', input: { template_url: 'http://127.0.0.1:54321/storage/v1/object/public/files/t.hwpx' } }, seen, ctx), { keep: true, src: null })
  const opened = await keepToolDoc({ name: '팀_워크숍.hwpx', tool: 'render_hwpx', input: { file_path: '/workspace/팀 워크숍 계획서.hwpx' } }, seen, ctx)
  assert.equal(opened.keep, false)
  assert.equal(opened.src, '/workspace/팀 워크숍 계획서.hwpx')
  assert.equal((await keepToolDoc({ name: 'x.hwpx', tool: 'render_hwpx', input: { file_path: `${ROOM}/x.hwpx` } }, seen, ctx)).keep, true)
})

test('에이전트에게: 새 파일은 이 대화 폴더에, 참고는 내 첨부·공유 폴더에서만', () => {
  const h = workspaceHint({ id: 'u-1' }, '12593ce0fd6d474482650bc294f7a3eb')
  assert.match(h, /\/workspace\/\.bpmn\/12593ce0fd6d474482650bc294f7a3eb\//)
  assert.match(h, /\/workspace\/uploads\/u-1\//)
  assert.match(h, /다른 사람/)
})
