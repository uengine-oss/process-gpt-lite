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
after(() => fs.rm(tmp, { recursive: true, force: true }))

const ROOM = 'c0ffee11c0ffee11c0ffee11c0ffee11'
const host = path.join(tmp, 'services/deepagents/workspace/.bpmn', ROOM)
const put = async (rel, mtime = null) => {
  const at = path.join(host, rel)
  await fs.mkdir(path.dirname(at), { recursive: true })
  await fs.writeFile(at, `# ${rel}\n`)
  if (mtime) await fs.utimes(at, mtime, mtime)
}

test('WD-U-01 a work folder\'s subfolders are walked (four folders down); process · skill folders two as before; no dot folders, no node_modules, only this turn\'s', async () => {
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
  const docs = (await documentsOfRun({ text: '만들었어요.', dirs: [`/workspace/.bpmn/${ROOM}`], since })).map((p) => p.replace(`/workspace/.bpmn/${ROOM}/`, '')).sort()
  assert.equal(RUN_DEPTH, 4)
  assert.deepEqual(docs, ['교육-과정/v1/README.md', '교육-과정/v1/syllabus/week-1.md', '교육-과정/v1/syllabus/week-1/notes.md', 'process-abc/forms/a.html'].sort())
})
