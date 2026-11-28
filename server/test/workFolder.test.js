// 작업 폴더 · 버전 (lib/workFolder.js — spec openspec/specs/chat-artifacts 「한 턴의 결과물은 작업 폴더와 버전에」): the work folders read from
// earlier file cards' paths, where a turn's work goes (new → v1, redo → the next version and the earlier one kept, revise → the latest edited
// in place), the line the agent is told, and the fallback (no model, unsure, a light one-off — no line). The model is a fake; no database.
//   cd server && node --test test/workFolder.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { workFolders, placeOf, noteOf, cleanName, nextVersion, askMessages, turnNote, under, MIN_CONFIDENCE } from '../lib/workFolder.js'

const ROOM = '/workspace/.bpmn/conv1'
const p = (rel) => `${ROOM}/${rel}`
const quiet = { log() {}, warn() {} }
const ans = (o) => ({ files: 'several', mode: 'new', folder: '', name: '', confidence: 0.9, ...o })

test('WF-U-01 work folders from earlier file paths: versions, the latest, its files, files in no folder — not dot folders, not other rooms', () => {
  const paths = [
    p('커리큘럼/v1/README.md'), p('커리큘럼/v1/curriculum.md'), p('커리큘럼/v2/README.md'), p('커리큘럼/v2/adr/ADR-001.md'),
    p('starter/README.md'), p('starter/css/tokens.css'),
    p('constitution.md'), p('.skill-evals/x/out.md'), p('process-x/.hidden/a.md'),
    '/workspace/.bpmn/other/커리큘럼/v9/README.md', '/workspace/top.md',
  ]
  const l = workFolders(paths, ROOM)
  assert.deepEqual(l.folders.map((f) => [f.name, f.versions, f.latest]), [['커리큘럼', [1, 2], 2], ['starter', [], 0]])
  assert.deepEqual(l.folders[0].files, ['README.md', 'adr/ADR-001.md'])
  assert.deepEqual(l.folders[1].files, ['README.md', 'css/tokens.css'])
  assert.deepEqual(l.loose, ['constitution.md'])
  assert.equal(under(p('a/b.md'), `${ROOM}/`), 'a/b.md')
  assert.equal(under('/workspace/.bpmn/conv10/a.md', ROOM), null)
  assert.deepEqual(workFolders(paths, null), { folders: [], loose: [] })
  assert.equal(nextVersion({ latest: 2 }), 3)
  assert.equal(nextVersion({ latest: 0 }), 2)
})

test('WF-U-02 new work: <folder>/v1 — a name of the request\'s language, cleaned; one new file, no file, unsure, a field not ours: no folder', () => {
  const empty = { folders: [], loose: [] }
  assert.deepEqual(placeOf(ans({ name: '스펙킷 교육 과정' }), empty), { folder: '스펙킷-교육-과정', mode: 'new', version: 1, dir: '스펙킷-교육-과정/v1', prev: null, confidence: 0.9 })
  assert.equal(placeOf(ans({ files: 'one', name: '견적서' }), empty), null)
  assert.equal(placeOf(ans({ files: 'none', name: '요약' }), empty), null)
  assert.equal(placeOf(ans({ name: '요약', confidence: MIN_CONFIDENCE - 0.01 }), empty), null)
  assert.equal(placeOf(ans({ name: '요약', confidence: 'high' }), empty), null)
  assert.equal(placeOf(ans({ mode: 'rewrite', name: '요약' }), empty), null)
  assert.equal(placeOf(ans({ name: '' }), empty), null)
  assert.equal(placeOf(null, empty), null)
  assert.equal(placeOf('new', empty), null)
})

test('WF-U-03 redo: the next version, the earlier one named to be kept — a folder without versions holds the first; work made before folders gets a folder at v2', () => {
  const l = workFolders([p('커리큘럼/v1/README.md'), p('커리큘럼/v2/README.md'), p('starter/README.md'), p('constitution.md'), p('spec.md')], ROOM)
  assert.deepEqual(placeOf(ans({ mode: 'redo', folder: '커리큘럼', name: '커리큘럼' }), l), { folder: '커리큘럼', mode: 'redo', version: 3, dir: '커리큘럼/v3', prev: '커리큘럼/v2', confidence: 0.9 })
  // (the model's own version number is not used — the code counts)
  assert.equal(placeOf(ans({ mode: 'redo', folder: '커리큘럼', version: 7 }), l).version, 3)
  assert.deepEqual(placeOf(ans({ mode: 'redo', folder: 'STARTER' }), l), { folder: 'starter', mode: 'redo', version: 2, dir: 'starter/v2', prev: 'starter', confidence: 0.9 })
  // the recording's case: 21 files in no folder, then 「다시 만들어 줘」
  assert.deepEqual(placeOf(ans({ mode: 'redo', folder: '', name: '교육 과정' }), l), { folder: '교육-과정', mode: 'redo', version: 2, dir: '교육-과정/v2', prev: '', confidence: 0.9 })
  // a redo of a folder this conversation does not have, with nothing in no folder either: new work
  assert.deepEqual(placeOf(ans({ mode: 'redo', folder: '없는폴더', name: '새 과정' }), { folders: [], loose: [] })?.dir, '새-과정/v1')
})

test('WF-U-04 revise: the latest version edited in place — a folder without versions in place, files in no folder in place with no folder named', () => {
  const l = workFolders([p('커리큘럼/v1/README.md'), p('커리큘럼/v2/README.md'), p('starter/README.md'), p('spec.md')], ROOM)
  assert.deepEqual(placeOf(ans({ mode: 'revise', folder: '커리큘럼' }), l), { folder: '커리큘럼', mode: 'revise', version: 2, dir: '커리큘럼/v2', prev: null, confidence: 0.9 })
  assert.deepEqual(placeOf(ans({ mode: 'revise', folder: 'starter' }), l), { folder: 'starter', mode: 'revise', version: null, dir: 'starter', prev: null, confidence: 0.9 })
  // (a revision of one file is placed too)
  assert.equal(placeOf(ans({ files: 'one', mode: 'revise', folder: '커리큘럼' }), l).dir, '커리큘럼/v2')
  assert.deepEqual(placeOf(ans({ mode: 'revise', folder: '' }), l), { folder: '', mode: 'revise', version: null, dir: '', prev: null, confidence: 0.9 })
  assert.equal(placeOf(ans({ mode: 'revise', folder: '모르는폴더' }), l).dir, '')
})

test('WF-U-05 new work whose name is taken: a versioned folder gets its next version, a plain folder or a file of that name a name of its own', () => {
  const l = workFolders([p('커리큘럼/v1/README.md'), p('starter/README.md'), p('starter-2/a.md'), p('notes')], ROOM)
  assert.deepEqual(placeOf(ans({ name: '커리큘럼' }), l)?.dir, '커리큘럼/v2')
  assert.deepEqual(placeOf(ans({ name: 'starter' }), l)?.dir, 'starter-3/v1')
  assert.deepEqual(placeOf(ans({ name: 'notes' }), l)?.dir, 'notes-2/v1')
})

test('WF-U-06 the line the agent gets: where (inside the output folder, or the working copy\'s path), the version, keep the earlier one, no copies', () => {
  const nw = noteOf({ mode: 'new', dir: '커리큘럼/v1', version: 1 })
  assert.match(nw, /^\n\n\(작업 폴더: /)
  assert.match(nw, /산출물 폴더 안의 '커리큘럼\/v1\/'/)
  assert.match(nw, /버전 1/)
  const redo = noteOf({ mode: 'redo', dir: '커리큘럼/v3', prev: '커리큘럼/v2', version: 3 }, { base: '/workspace/.bpmn/c/folders/edu/' })
  assert.match(redo, /'\/workspace\/\.bpmn\/c\/folders\/edu\/커리큘럼\/v3\/'/)
  assert.match(redo, /이전 버전 '\/workspace\/\.bpmn\/c\/folders\/edu\/커리큘럼\/v2\/' 의 파일은 고치거나 지우지 말고 그대로/)
  assert.match(noteOf({ mode: 'redo', dir: '과정/v2', prev: '', version: 2 }), /이전 결과물\(폴더 밖의 파일\)은 고치거나 지우지 말고/)
  const rev = noteOf({ mode: 'revise', dir: '커리큘럼/v2', version: 2 })
  assert.match(rev, /'커리큘럼\/v2\/' 의 파일을 고치는 일/)
  assert.match(rev, /사본/)
  assert.match(noteOf({ mode: 'revise', dir: '' }), /그 자리에서 고치고/)
  assert.equal(noteOf(null), '')
  // (one line of structure, the size of the workspace note — not a page of rules)
  for (const t of [nw, redo, rev]) assert.ok(t.length < 260, t.length)
})

test('WF-U-07 a folder name: one path segment — no slashes, dots at the ends, control characters; spaces become hyphens; 40 characters', () => {
  assert.equal(cleanName(' 스펙킷  교육/과정 '), '스펙킷-교육-과정')
  assert.equal(cleanName('../../etc'), 'etc')
  assert.equal(cleanName('.git'), 'git')
  assert.equal(cleanName('a\u0000b:c'), 'a-b-c')
  assert.equal(cleanName(null), '')
  assert.equal(cleanName('가'.repeat(60)).length, 40)
})

test('WF-U-08 the model is shown the request, what was understood and the folders with their versions', () => {
  const l = workFolders([p('커리큘럼/v1/README.md'), p('커리큘럼/v2/README.md'), p('spec.md')], ROOM)
  const { system, user } = askMessages({ request: '커리큘럼 다시 짜 줘', understood: '커리큘럼을 새로 짜 달라는 요청', listing: l })
  assert.match(system, /JSON only/)
  assert.match(user, /커리큘럼 다시 짜 줘/)
  assert.match(user, /What the assistant understood: 커리큘럼을 새로 짜 달라는 요청/)
  assert.match(user, /- 커리큘럼: versions v1, v2 \(latest v2: README\.md\)/)
  assert.match(user, /Files in no folder: spec\.md/)
  assert.match(askMessages({ request: 'x', listing: { folders: [], loose: [] } }).user, /\(none\)/)
})

test('WF-U-09 a turn: earlier cards read, the model asked once, the line — a light plan asks nothing, no model or a refusal is no line', async () => {
  const asked = []
  const call = async (system, user, opts) => { asked.push({ system, user, opts }); return ans({ mode: 'redo', folder: '커리큘럼' }) }
  const query = async (sql, [thread, prefix]) => {
    assert.equal(thread, 't1')
    assert.equal(prefix, `${ROOM}/`)
    return [{ path: p('커리큘럼/v1/README.md') }, { path: p('커리큘럼/v1/curriculum.md') }]
  }
  const front = { source: 'front', tier: 'standard', understood: '커리큘럼을 다른 방식으로 다시 만들어 달라는 요청' }
  const line = await turnNote({ threadId: 't1', conv: 'conv1', request: '커리큘럼 처음부터 다시', plan: front, call, query, log: quiet })
  assert.match(line, /새 버전 산출물 폴더 안의 '커리큘럼\/v2\/'/)
  assert.match(line, /이전 버전 산출물 폴더 안의 '커리큘럼\/v1\/'/)
  assert.equal(asked.length, 1)
  assert.match(asked[0].user, /What the assistant understood: 커리큘럼을 다른 방식으로/)
  assert.equal(asked[0].opts.temperature, 0)
  // a light one-off (the front plan's tier): nothing asked, no line
  assert.equal(await turnNote({ threadId: 't1', conv: 'conv1', request: '오늘 날씨?', plan: { ...front, tier: 'light' }, call, query, log: quiet }), '')
  assert.equal(asked.length, 1)
  // a stand-in plan (the front call failed) is not read as light, and its words are not "understood"
  await turnNote({ threadId: 't1', conv: 'conv1', request: '정리해 줘', plan: { source: 'fallback', tier: 'light', understood: '요청을 받았어요' }, call, query, log: quiet })
  assert.equal(asked.length, 2)
  assert.doesNotMatch(asked[1].user, /understood/)
  // the model unreachable, an answer that is not JSON, unsure: no line — the turn goes as before
  const fails = [async () => { throw new Error('fetch failed') }, async () => { throw new Error("the model's answer is not JSON") }, async () => ans({ name: '과정', confidence: 0.4 })]
  for (const f of fails) assert.equal(await turnNote({ threadId: 't1', conv: 'conv1', request: '만들어 줘', call: f, query, log: quiet }), '')
  // the database down: no line either
  assert.equal(await turnNote({ threadId: 't1', conv: 'conv1', request: '만들어 줘', call, query: async () => { throw new Error('db') }, log: quiet }), '')
  // no conversation yet: no folders to read, the model still places new work
  const fresh = await turnNote({ threadId: 't1', conv: null, request: '교육 과정 자료 만들어 줘', call: async () => ans({ name: '교육 과정' }), query: async () => { throw new Error('not asked') }, log: quiet })
  assert.match(fresh, /산출물 폴더 안의 '교육-과정\/v1\/'/)
  // turned off
  process.env.PRO_WORK_FOLDERS = '0'
  try { assert.equal(await turnNote({ threadId: 't1', conv: 'conv1', request: '만들어 줘', call, query, log: quiet }), '') } finally { delete process.env.PRO_WORK_FOLDERS }
})

test('WF-U-10 a project with a shared folder: the work folder is inside its working copy (a template\'s workspace: inside its outputs folder)', async () => {
  const container = '/workspace/.bpmn/pconv/folders/edu-course'
  const query = async (sql, [, prefix]) => { assert.equal(prefix, `${container}/`); return [{ path: `${container}/커리큘럼/v1/README.md` }] }
  const call = async (s, user) => { assert.match(user, /- 커리큘럼: versions v1/); return ans({ mode: 'revise', folder: '커리큘럼' }) }
  const line = await turnNote({ threadId: 't2', conv: 'pconv', projectWork: { container, dir: null, v: { source: {} } }, request: '1주차만 고쳐 줘', call, query, log: quiet })
  assert.match(line, /'\/workspace\/\.bpmn\/pconv\/folders\/edu-course\/커리큘럼\/v1\/' 의 파일을 고치는 일/)
  const tq = async (sql, [, prefix]) => { assert.equal(prefix, `${container}/outputs/`); return [] }
  const tline = await turnNote({ threadId: 't3', conv: 'pconv', projectWork: { container, dir: null, v: { source: { template: { outputs: 'outputs' } } } }, request: '자료 만들어 줘', call: async () => ans({ name: '1차 자료' }), query: tq, log: quiet })
  assert.match(tline, /'\/workspace\/\.bpmn\/pconv\/folders\/edu-course\/outputs\/1차-자료\/v1\/'/)
})

test('WF-U-11 the reading runs while the front plan is still coming — the turn waits for the slower, not both; a light plan that comes later drops it', async () => {
  const events = []
  let resolvePlan
  const planP = new Promise((r) => { resolvePlan = r })
  const call = async () => { events.push('model'); return ans({ name: '교육 과정' }) }
  const query = async () => []
  const p = turnNote({ threadId: 't9', conv: 'c9', request: '교육 과정 자료 여러 개 만들어 줘', plan: planP, call, query, log: { log() {}, warn() {} } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(events, ['model'], 'the model was asked before the plan came')
  resolvePlan({ source: 'front', tier: 'standard', understood: '교육 과정 자료를 만들어 드릴게요.' })
  assert.match(await p, /교육-과정\/v1\//)
  // the plan comes back light: no line (the reading is dropped, nothing thrown)
  let late
  const lp = turnNote({ threadId: 't9', conv: 'c9', request: '오늘 날씨?', plan: new Promise((r) => { late = r }), call, query, log: { log() {}, warn() {} } })
  late({ source: 'front', tier: 'light', understood: '날씨' })
  assert.equal(await lp, '')
})
