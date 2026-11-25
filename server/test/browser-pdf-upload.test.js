// PDF 로 저장하고 다른 사이트에 올리기(2026-11-25 녹화: Medium 글이 NotebookLM 의 웹사이트 소스로 들어가지 않고 「소스 0개」에서 2분을
// 기다렸다 — 사용자 「내 계정으로 접근해서 인쇄시킨 후, pdf 등으로 만든후에 노트북엘엠에 넣어야 해」). 브라우저 · DB · 모델 없이, 가짜 페이지와
// 가짜 파일 선택 창으로:
//   BQ-T-01 save_pdf(lib/browser.js pagePdf): 페이지를 인쇄한 PDF 가 파일 카드가 되고 이 작업의 파일이 된다(attach_file 이 쓰는 이름)
//   BQ-T-02 인쇄하지 못하는 브라우저(사람 PC 의 브라우저) · 시간 안에 못 찍은 페이지 → 그렇다고 돌려준다
//   BQ-T-03 업로드(ServerDriver.attach): 파일 칸이면 그 칸에, 아니면 그 단추가 여는 파일 선택 창에
//   BQ-T-04 NotebookLM 스킬이 웹사이트 소스가 안 들어갈 때의 길(열기 → PDF 저장 → 파일 업로드)과 Medium 은 바로 PDF 를 말한다
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { pagePdf } = await import('../lib/browser.js')
const { ServerDriver } = await import('../lib/browserServer.js')
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')

test('BQ-T-01 save_pdf: 지금 화면을 인쇄한 PDF 가 파일 카드가 되고 이 작업의 파일이 된다', async () => {
  const kept = [], posted = []
  const d = { pdf: async () => PDF, title: async () => 'Agentic AI in practice | Medium' }
  const task = { userId: 'u1', threadId: 't1', id: 'task1', files: [{ name: '메모.pdf', url: 'https://files.example/m.pdf' }] }
  const out = await pagePdf(d, task, '', {
    keep: async (user, name, type, buf) => { kept.push({ user, name, type, buf }); return { name, size: buf.length, url: `https://files.example/${encodeURIComponent(name)}`, key: `pgpt-pro/u1/att/x.pdf` } },
    post: async (...a) => { posted.push(a) },
  })
  assert.equal(kept.length, 1)
  assert.equal(kept[0].name, 'Agentic AI in practice Medium.pdf', '이름은 페이지 제목에서(파일 이름에 못 쓰는 글자는 뺀다)')
  assert.equal(kept[0].type, 'application/pdf')
  assert.ok(kept[0].buf.subarray(0, 5).equals(Buffer.from('%PDF-')))
  assert.deepEqual(kept[0].user, { id: 'u1' })
  assert.deepEqual(posted[0].slice(0, 4), ['u1', 't1', 'agent', 'file'])
  assert.equal(posted[0][4].taskId, 'task1')
  assert.equal(posted[0][4].type, 'application/pdf')
  assert.deepEqual(task.files.map((f) => f.name), ['메모.pdf', 'Agentic AI in practice Medium.pdf'], '이 작업의 파일 — attach_file 이 이 이름으로 쓴다')
  assert.match(out, /^saved Agentic AI in practice Medium\.pdf \(1 KB\) — one of this task's files now: give it to a site with attach_file name "Agentic AI in practice Medium\.pdf"$/)
  // a name given by the agent wins; the same name again replaces, not doubles
  await pagePdf(d, task, 'medium-article.pdf', { keep: async (u, name, type, buf) => ({ name, size: buf.length, url: 'u' }), post: async () => {} })
  await pagePdf(d, task, 'medium-article', { keep: async (u, name, type, buf) => ({ name, size: buf.length, url: 'u2' }), post: async () => {} })
  assert.deepEqual(task.files.map((f) => f.name), ['메모.pdf', 'Agentic AI in practice Medium.pdf', 'medium-article.pdf'])
  assert.equal(task.files.at(-1).url, 'u2')
})

test('BQ-T-02 인쇄하지 못하는 브라우저 · 시간 안에 못 찍은 페이지는 그렇다고 돌려주고, 아무것도 남기지 않는다', async () => {
  const none = async () => { throw new Error('should not keep') }
  assert.match(await pagePdf({ title: async () => '' }, { files: [] }, 'x', { keep: none, post: none }), /^error: this browser \(the one on the person's PC\) cannot save a page as PDF/)
  assert.match(await pagePdf({ pdf: async () => null }, { files: [] }, 'x', { keep: none, post: none }), /^error: the page could not be printed as PDF within the time/)
})

// ---- the upload: a fake Playwright page (its element by number, its file chooser) under the server's driver ----
function fakePage({ input }) {
  const calls = []
  const el = {
    evaluate: async (fn) => fn({ tagName: input ? 'INPUT' : 'BUTTON', type: input ? 'file' : 'button' }),
    setInputFiles: async (f) => { calls.push(['setInputFiles', f]) },
    click: async () => { calls.push(['click']); setTimeout(() => chooser.resolve?.(), 5) },
    first() { return this },
  }
  const chooser = {}
  const page = {
    locator: (sel) => { calls.push(['locator', sel]); return el },
    waitForEvent: (name) => { calls.push(['waitForEvent', name]); return new Promise((r) => { chooser.resolve = () => r({ setFiles: async (f) => { calls.push(['chooser.setFiles', f]) } }) }) },
    pdf: async (opts) => { calls.push(['pdf', opts]); return PDF },
  }
  return { page, calls }
}
const driverOn = (page) => { const d = new ServerDriver('u-fake'); d.page = page; d.frameOf = new Map(); return d }

test('BQ-T-03 업로드: 파일 칸이면 그 칸에 바로, 아니면 그 단추를 눌러 열린 파일 선택 창에 — 인쇄는 A4 · 배경 포함', async () => {
  const a = fakePage({ input: true })
  await driverOn(a.page).attach(7, '/tmp/medium-article.pdf')
  assert.deepEqual(a.calls, [['locator', '[data-pro-idx="7"]'], ['locator', '[data-pro-idx="7"]'], ['setInputFiles', '/tmp/medium-article.pdf']])
  const b = fakePage({ input: false })
  await driverOn(b.page).attach(3, '/tmp/medium-article.pdf')
  assert.deepEqual(b.calls.filter((c) => c[0] !== 'locator'), [['waitForEvent', 'filechooser'], ['click'], ['chooser.setFiles', '/tmp/medium-article.pdf']])
  const c = fakePage({ input: true })
  const buf = await driverOn(c.page).pdf()
  assert.ok(buf.equals(PDF))
  assert.deepEqual(c.calls, [['pdf', { format: 'A4', printBackground: true }]])
})

test('BQ-T-04 NotebookLM 스킬: 웹사이트 소스가 「소스 0개」에 머물면 스스로 — 글 열기 → save_pdf → 「파일 업로드」 attach_file, Medium 은 바로 PDF', () => {
  const md = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'notebooklm', 'SKILL.md'), 'utf8')
  const part = md.split('## 웹사이트 소스가 들어가지 않을 때')[1]?.split('\n## ')[0] || ''
  assert.ok(part, '스킬에 그 절이 있다')
  for (const w of ['소스 0개', 'save_pdf', '파일 업로드', 'attach_file', 'Medium']) assert.ok(part.includes(w), w)
  assert.ok(part.indexOf('save_pdf') < part.indexOf('attach_file'), '저장한 다음 올린다')
})
