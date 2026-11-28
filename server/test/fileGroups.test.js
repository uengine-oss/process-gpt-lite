// One turn's many files as one card, and same-named files told apart by their folder (src/fileGroups.js — spec
// openspec/specs/chat-artifacts 「한 턴의 많은 파일은 카드 하나」 · 「목록은 작업 폴더 · 버전으로 묶고 같은 이름은 폴더로 가른다」).
// No database, no browser.
//   cd server && node --test test/fileGroups.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { relPath, dirOf, fileRuns, fileTree, folderHints, workFolderOf, artifactSections, shownRows, groupable, GROUP_FROM, TURN_GAP_MS } from '../../src/fileGroups.js'
import { filterArtifacts } from '../../src/artifactScope.js'

const t0 = Date.parse('2026-11-28T11:49:00Z')
const ROOM = '/workspace/.bpmn/convA'
let n = 0
const file = (rel, { sec = n, role = 'agent', base = ROOM, ...c } = {}) => ({ id: `f${++n}`, role, kind: 'file', created_at: new Date(t0 + sec * 1000).toISOString(),
  content: { name: rel.split('/').pop(), path: `${base}/${rel}`, ...c } })
const text = (id, role, sec) => ({ id, role, kind: 'text', created_at: new Date(t0 + sec * 1000).toISOString(), content: { text: id } })
// the recording's turn: 21 files in folders, README.md four times, curriculum.md twice
const TURN = ['README.md', 'constitution.md', 'spec.md', 'scenario.md', 'prompts.md',
  'adr/ADR-001.md', 'adr/ADR-002.md', 'adr/ADR-003.md', 'adr/ADR-004.md', 'adr/README.md',
  'curriculum/README.md', 'curriculum/curriculum.md', 'syllabus/curriculum.md', 'syllabus/week-1.md',
  'starter/README.md', 'starter/css/tokens.css', 'starter/css/base.css', 'starter/request.html', 'starter/index.html', 'starter/app.js', 'starter/notes.txt']

test('FG-U-01 where a card\'s file sits: its conversation folder, a project\'s working copy, uploads, the top — a card with no path is its name', () => {
  assert.equal(relPath({ name: 'a.md', path: '/workspace/.bpmn/c1/커리큘럼/v2/README.md' }), '커리큘럼/v2/README.md')
  assert.equal(relPath({ name: 'x', path: '/workspace/.bpmn/c1/folders/edu-course/syllabus/week-1.md' }), 'syllabus/week-1.md')
  assert.equal(relPath({ name: 'x', path: '/workspace/uploads/u1/받은/견적.xlsx' }), '받은/견적.xlsx')
  assert.equal(relPath({ name: 'x', path: '/workspace/메모.txt' }), '메모.txt')
  assert.equal(relPath({ name: '보고서.hwpx', url: 'https://x/보고서.hwpx' }), '보고서.hwpx')
  assert.equal(relPath(null), '')
  assert.equal(dirOf('커리큘럼/v2/README.md'), '커리큘럼/v2')
  assert.equal(dirOf('README.md'), '')
})

test('FG-U-02 a turn\'s run: more than three documents are one card — three or fewer keep their cards; pictures keep theirs; another turn, conversation or a pause breaks it', () => {
  const docs = TURN.map((r, i) => file(r, { sec: 10 + i }))
  const list = [text('u1', 'user', 0), text('a1', 'agent', 9), ...docs, text('u2', 'user', 100)]
  const { lead, member } = fileRuns(list)
  assert.deepEqual([...lead.keys()], [docs[0].id])
  assert.equal(lead.get(docs[0].id).length, 21)
  assert.equal(member.size, 20)
  assert.ok(!member.has(docs[0].id))
  // three: their own cards
  const three = [text('a2', 'agent', 0), file('a.md', { sec: 1 }), file('b.md', { sec: 2 }), file('c.md', { sec: 3 })]
  assert.equal(fileRuns(three).lead.size, 0)
  assert.equal(GROUP_FROM, 4)
  // four documents and two pictures in one turn: the documents are the card, the pictures keep theirs where they are
  const pic = file('banner.png', { sec: 2, type: 'image/png' })
  const mixed = [file('a.md', { sec: 1 }), pic, file('b.md', { sec: 3 }), file('c.docx', { sec: 4 }), file('voice.wav', { sec: 4 }), file('d.xlsx', { sec: 5 })]
  const r = fileRuns(mixed)
  assert.deepEqual(r.lead.get(mixed[0].id).map((m) => m.content.name), ['a.md', 'b.md', 'c.docx', 'd.xlsx'])
  assert.ok(!r.member.has(pic.id) && !groupable(pic) && !groupable(mixed[4]))
  // a pause longer than a turn's posting, another conversation (a project's sub-topic), a teammate's share, a user's attachment: not one run
  const pause = [file('a.md', { sec: 0 }), file('b.md', { sec: 1 }), file('c.md', { sec: 2 }), file('d.md', { sec: 2 + TURN_GAP_MS / 1000 + 1 })]
  assert.equal(fileRuns(pause).lead.size, 0)
  const convs = [file('a.md', { sec: 0, conv: 'x' }), file('b.md', { sec: 1, conv: 'x' }), file('c.md', { sec: 2, conv: 'x' }), file('d.md', { sec: 3, conv: 'y' })]
  assert.equal(fileRuns(convs).lead.size, 0)
  const shared = [file('a.md', { sec: 0 }), file('b.md', { sec: 1 }), file('c.md', { sec: 2 }), file('d.md', { sec: 3, shared: { by: '정하윤' } })]
  assert.equal(fileRuns(shared).lead.size, 0)
  const users = ['a.md', 'b.md', 'c.md', 'd.md'].map((x, i) => file(x, { sec: i, role: 'user' }))
  assert.equal(fileRuns(users).lead.size, 0)
  // (an old chat's messages, never changed: the same rule reads them)
  assert.equal(fileRuns([]).lead.size, 0)
  assert.equal(fileRuns(null).member.size, 0)
})

test('FG-U-03 a run\'s tree: 「파일 21개 · 폴더 n개」, the top first, then the folders by path, names in number order, same names with their folder', () => {
  const docs = TURN.map((r, i) => file(r, { sec: i }))
  const t = fileTree(docs)
  assert.equal(t.files, 21)
  assert.equal(t.common, '')
  assert.equal(t.work, null)
  assert.deepEqual(t.sections.map((s) => s.dir), ['', 'adr', 'curriculum', 'starter', 'starter/css', 'syllabus'])
  assert.equal(t.folders, 5)
  assert.deepEqual(t.sections[1].rows.map((r) => r.name), ['ADR-001.md', 'ADR-002.md', 'ADR-003.md', 'ADR-004.md', 'README.md'])
  const hint = (dir, name) => t.sections.find((s) => s.dir === dir).rows.find((r) => r.name === name).hint
  assert.equal(hint('', 'README.md'), '')
  assert.equal(hint('starter', 'README.md'), 'starter/')
  assert.equal(hint('adr', 'README.md'), 'adr/')
  assert.equal(hint('curriculum', 'curriculum.md'), 'curriculum/')
  assert.equal(hint('syllabus', 'curriculum.md'), 'syllabus/')
  assert.equal(hint('', 'spec.md'), null)
  // (ADR-2 before ADR-10)
  const nums = fileTree(['ADR-10.md', 'ADR-2.md', 'ADR-1.md', 'b.md'].map((x) => file(`adr/${x}`)))
  assert.deepEqual(nums.sections[0].rows.map((r) => r.name), ['ADR-1.md', 'ADR-2.md', 'ADR-10.md', 'b.md'])
})

test('FG-U-04 all in one work folder: the tree starts inside it and the head names its folder and version — a project\'s working copy the same', () => {
  const docs = ['README.md', 'syllabus/week-1.md', 'syllabus/week-2.md', 'starter/README.md'].map((r) => file(`커리큘럼/v2/${r}`))
  const t = fileTree(docs)
  assert.equal(t.common, '커리큘럼/v2')
  assert.deepEqual(t.work, { folder: '커리큘럼', version: 2, key: '커리큘럼/v2' })
  assert.deepEqual(t.sections.map((s) => s.dir), ['', 'starter', 'syllabus'])
  assert.equal(t.folders, 2)
  // (inside the card's folder: README.md at its top, the other in starter/)
  assert.equal(t.sections[0].rows[0].hint, '')
  assert.equal(t.sections[1].rows[0].hint, 'starter/')
  const proj = ['a.md', 'b.md', 'c.md', 'd.md'].map((x) => file(`커리큘럼/v1/${x}`, { base: '/workspace/.bpmn/p1/folders/edu' }))
  assert.equal(fileTree(proj).work.version, 1)
  assert.deepEqual(fileTree(proj).sections.map((s) => s.dir), [''])
  // a common folder that is not a version: its path, no work
  const plain = fileTree(['a.md', 'b.md'].map((x) => file(`docs/${x}`)))
  assert.equal(plain.common, 'docs')
  assert.equal(plain.work, null)
})

test('FG-U-05 a section shows a few rows, the rest behind 「n개 더 보기」 — all of them when only a few more', () => {
  assert.equal(shownRows(5), 5)
  assert.equal(shownRows(8), 8)
  assert.equal(shownRows(21), 6)
  assert.equal(shownRows(21, true), 21)
})

test('FG-U-06 same-named files: the shortest end of their folder that differs, the top as \'\', a name alone nothing', () => {
  const h = folderHints([{ id: 1, name: 'README.md', dir: '커리큘럼/v1' }, { id: 2, name: 'README.md', dir: '커리큘럼/v2' }, { id: 3, name: 'README.md', dir: '' },
    { id: 4, name: 'a.md', dir: 'x/docs' }, { id: 5, name: 'a.md', dir: 'y/docs' }, { id: 6, name: 'b.md', dir: 'z' }])
  assert.equal(h.get(1), 'v1/')
  assert.equal(h.get(2), 'v2/')
  assert.equal(h.get(3), '')
  assert.equal(h.get(4), 'x/docs/')
  assert.equal(h.get(5), 'y/docs/')
  assert.equal(h.has(6), false)
  // (one name in NFD and NFC is the same name)
  assert.equal(folderHints([{ id: 1, name: '회의록.md'.normalize('NFD'), dir: 'a' }, { id: 2, name: '회의록.md', dir: 'b' }]).get(1), 'a/')
})

test('FG-U-07 a file\'s work folder and version: the folder before a version folder (inside a template\'s outputs too), else its first folder', () => {
  assert.deepEqual(workFolderOf('커리큘럼/v2/README.md'), { folder: '커리큘럼', version: 2, key: '커리큘럼/v2' })
  assert.deepEqual(workFolderOf('outputs/커리큘럼/v1/adr/ADR-001.md'), { folder: '커리큘럼', version: 1, key: 'outputs/커리큘럼/v1' })
  assert.deepEqual(workFolderOf('starter/css/base.css'), { folder: 'starter', version: null, key: 'starter' })
  assert.equal(workFolderOf('README.md'), null)
  // (a folder named like a version at the top is just a folder)
  assert.deepEqual(workFolderOf('v1/a.md'), { folder: 'v1', version: null, key: 'v1' })
})

test('FG-U-08 the list in sections: one work folder and version together at its newest file\'s place, older versions folded, same names with their folder; search finds a folder', () => {
  const x = (rel, sec, conv = null) => ({ msg: file(rel, { sec }), conv, convTitle: conv ? '교육 과정' : '' })
  const items = [x('커리큘럼/v2/starter/README.md', 51), x('커리큘럼/v2/README.md', 50), x('커리큘럼/v2/week-1.md', 49), x('notes.md', 40), x('커리큘럼/v1/README.md', 30), x('커리큘럼/v1/week-1.md', 29), x('README.md', 20)]
  const s = artifactSections(items)
  assert.deepEqual(s.map((sec) => [sec.folder, sec.version, sec.items.length, sec.older]), [['커리큘럼', 2, 3, false], [null, null, 1, false], ['커리큘럼', 1, 2, true], [null, null, 1, false]])
  // inside a section: its own same names by their folder there ('' — the section's top); one name once in its section needs none
  assert.deepEqual(s[0].items.map((r) => [r.msg.content.name, r.hint]), [['README.md', 'starter/'], ['README.md', ''], ['week-1.md', null]])
  assert.deepEqual(s[2].items.map((r) => r.hint), [null, null])
  // a file in no folder: among the whole list (README.md is elsewhere too — this one is at the top)
  assert.equal(s[3].items[0].hint, '')
  assert.equal(s[1].items[0].hint, null)
  // one folder name in two conversations of the chat: two works
  const two = artifactSections([x('과정/v1/a.md', 2, 'c1'), x('과정/v1/b.md', 1, 'c2')])
  assert.equal(two.length, 2)
  // the search box reads the folder too
  assert.deepEqual(filterArtifacts(items, 'v1').map((y) => y.msg.content.path.split('/').slice(-2).join('/')), ['v1/README.md', 'v1/week-1.md'])
  assert.equal(filterArtifacts(items, '커리큘럼 week').length, 2)
})
