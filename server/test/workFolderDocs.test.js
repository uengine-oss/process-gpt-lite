// A turn's documents found in its conversation folder (lib/office.js documentsOfRun — the files an agent's own script wrote, with no
// file_artifact event) reach a work folder's subfolders (PR #135 review: the line says 「하위 폴더로 나누고」, the walk went two folders down):
// <folder>/v1/syllabus/week-1/notes.md is found; a process generation's or a skill's own folder is still walked two levels down; never a dot
// folder or node_modules; only what changed since the turn began. The deepagents workspace is a folder of this test (PGPT_ROOT).
//   cd server && node --test test/workFolderDocs.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-docs-'))
process.env.PGPT_ROOT = tmp
process.env.PRO_CRAFT_WORK_ROOT = path.join(tmp, 'work')
process.env.PRO_SUPABASE_URL ||= 'https://supa.example.test'
process.env.SERVICE_ROLE_KEY ||= 'test-service-key'
process.env.ANON_KEY ||= 'test-anon-key'
const { documentsOfRun, RUN_DEPTH } = await import('../lib/office.js')
const { dropScaffolding, SCRIPT } = await import('../lib/provenance.js')
after(() => fs.rm(tmp, { recursive: true, force: true }))

const ROOM = 'c0ffee11c0ffee11c0ffee11c0ffee11'
const host = path.join(tmp, 'services/deepagents/workspace/.bpmn', ROOM)
const put = async (rel, mtime = null) => {
  const at = path.join(host, rel)
  await fs.mkdir(path.dirname(at), { recursive: true })
  await fs.writeFile(at, `# ${rel}\n`)
  if (mtime) await fs.utimes(at, mtime, mtime)
}

test('WD-U-01 a work folder\'s subfolders are walked (four folders down); process · skill folders and a project\'s working copy two as before; no dot folders, no node_modules, only this turn\'s', async () => {
  const since = Date.now() - 1000
  const old = new Date(Date.now() - 3600_000)
  await put('교육-과정/v1/README.md')
  await put('교육-과정/v1/syllabus/week-1.md')
  await put('교육-과정/v1/syllabus/week-1/notes.md')
  await put('교육-과정/v1/a/b/c/too-deep.md')
  await put('교육-과정/v1/.drafts/hidden.md')
  await put('교육-과정/v1/node_modules/pkg/readme.md')
  await put('교육-과정/v1/syllabus/old.md', old)
  await put('process-abc/forms/a.html')
  await put('process-abc/skills/x/assets/deep.md')
  await put('skills/my-skill/refs/deep.md')
  // (PR #135 confirmation review) a project's shared-folder working copy: its checkout rewrites every file's time each run — deeper files of
  // the team's folder are not this turn's (the agent's own come as file_artifact events); its top two levels as before
  await put('folders/edu/docs/a/b/plan.docx')
  await put('folders/edu/docs/notes.docx')
  await put('folders/edu/top.docx')
  const docs = (await documentsOfRun({ text: '만들었어요.', dirs: [`/workspace/.bpmn/${ROOM}`], since })).map((p) => p.replace(`/workspace/.bpmn/${ROOM}/`, '')).sort()
  assert.equal(RUN_DEPTH, 4)
  assert.deepEqual(docs, ['교육-과정/v1/README.md', '교육-과정/v1/syllabus/week-1.md', '교육-과정/v1/syllabus/week-1/notes.md', 'process-abc/forms/a.html', 'folders/edu/top.docx'].sort())
})

// (PR #135 demo) a course's starter/app.js never became a card: every script was dropped as soon as the turn left any document — its
// Markdown included. A script is scaffolding only beside a file the agent did not write itself (a program built it); beside the agent's own
// writing it is one of the files asked for. Stopped turns, node_modules, dot folders and build output stay out.
test('WD-U-02 scripts: beside the agent\'s own files they are cards (a web page\'s app.js); beside a built document, a stopped turn, node_modules · dot folders · dist/ · build/ they are not', () => {
  const R = '/workspace/.bpmn/c0ffee'
  const f = (rel, extra = {}) => ({ name: rel.split('/').pop(), path: `${R}/${rel}`, ...extra })
  const names = (list) => list.map((x) => x.path.slice(R.length + 1))
  // a small web page in a work folder, every file the agent's own writing
  const page = ['작은-웹-페이지/v1/index.html', '작은-웹-페이지/v1/app.js', '작은-웹-페이지/v1/style.css', '작은-웹-페이지/v1/README.md'].map((r) => f(r))
  const written = new Set(page.map((x) => x.path))
  assert.deepEqual(names(dropScaffolding(page, { written })), names(page))
  // the demo's course: Markdown, HTML, CSS and starter/app.js
  const course = ['과정/v1/README.md', '과정/v1/starter/index.html', '과정/v1/starter/app.js', '과정/v1/starter/tokens.css'].map((r) => f(r))
  assert.ok(names(dropScaffolding(course, { written: new Set(course.map((x) => x.path)) })).includes('과정/v1/starter/app.js'))
  // a script that built a document: the workbook came from the folder or from deepagents' storage (not the agent's own writing) — the
  // script is not a card, the workbook and the agent's notes are
  const built = [f('make_report.py'), f('build.js'), f('notes.md'), f('정산표.xlsx', { src: 'https://x/정산표.xlsx' })]
  assert.deepEqual(names(dropScaffolding(built, { written: new Set([`${R}/make_report.py`, `${R}/build.js`, `${R}/notes.md`]) })), ['notes.md', '정산표.xlsx'])
  // a document a tool published (no path): built too
  assert.deepEqual(dropScaffolding([f('a.py'), { name: '보고서.hwpx', url: 'https://x/r.hwpx' }], { written: new Set([`${R}/a.py`]) }).map((x) => x.name), ['보고서.hwpx'])
  // a shared folder's file the person asked to open (folder_open) is not something the turn built
  assert.deepEqual(dropScaffolding([f('app.js'), { name: '이력서.docx', url: 'https://x/c.docx', open: true }], { written: new Set([`${R}/app.js`]) }).map((x) => x.name), ['app.js', '이력서.docx'])
  // a stopped turn: no half-run script
  assert.deepEqual(names(dropScaffolding(page, { written, ended: true })), ['작은-웹-페이지/v1/index.html', '작은-웹-페이지/v1/style.css', '작은-웹-페이지/v1/README.md'])
  // what an install or a build left, a dot folder's helper: never cards (the conversation's own .bpmn/<room>/ is not such a folder)
  const left = ['site/v1/node_modules/left-pad/index.js', 'site/v1/dist/bundle.js', 'site/v1/build/out.js', '.cache/check.py', 'site/v1/.tmp/run.sh'].map((r) => f(r))
  const all = [...page, ...left]
  assert.deepEqual(names(dropScaffolding(all, { written: new Set(all.map((x) => x.path)) })), names(page))
  // a script the agent did not write this turn (deepagents collected a path the answer named): not a card
  assert.deepEqual(names(dropScaffolding([f('README.md'), f('helper.py', { src: 'https://x/h.py' })], { written: new Set([`${R}/README.md`]) })), ['README.md'])
  // the kinds read as scripts; a page's other files are not
  for (const n of ['a.py', 'a.js', 'a.mjs', 'a.cjs', 'a.ts', 'a.sh', 'A.JS']) assert.ok(SCRIPT.test(n), n)
  for (const n of ['a.json', 'a.css', 'a.html', 'a.md', 'a.tsx.md']) assert.ok(!SCRIPT.test(n), n)
  assert.deepEqual(dropScaffolding(null), [])
})
