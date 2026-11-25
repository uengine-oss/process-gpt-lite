// 브라우저 작업이 이 대화의 파일을 쓴다(2026-11-25 운영: 「AI 로 만든 문서나 대화창에 올려진 파일 내용을 브라우저 쪽으로 업로드를 못시키네」).
// lib/browserFiles.js — 후보 모으기와 권한(실제 DB), 고르기는 가짜 판정 서버(PRO_JUDGE_URL)로. 브라우저 · 모델 없이.
//   BQ-F-01 후보: 이 방의 파일 카드(AI 가 만든 것 · 채팅에 올린 것), 연결된 폴더(구성원일 때만), 받은 공유 — 남의 방 카드는 없다
//   BQ-F-02 판정: 하나가 확실하면 그것, 여럿이 그럴듯하면 카드에 올릴 것들, 맞는 것이 없으면 없음 — 판정이 읽는 것
//   BQ-F-03 폴더 파일 · 공유는 그 사람으로 읽고(접근이 없으면 읽지 않음), 방의 카드는 여기서 읽지 않는다(작업 공간 · 비공개 저장소 경로)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'

const asked = []
const answers = []
const judgeServer = await new Promise((r) => {
  const s = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const b = JSON.parse(raw)
      asked.push(b)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ probabilities: answers.shift() || { none: 1 }, model: 'scripted' }))
    })
  })
  s.listen(0, '127.0.0.1', () => r(s))
})
process.env.PRO_JUDGE_URL = `http://127.0.0.1:${judgeServer.address().port}/judge`
process.env.PRO_JUDGE_LLM = '0'
const BF = await import('../lib/browserFiles.js')
const { q, pool } = await import('../lib/supa.js')
const up = await q('select 1').then(() => true, () => false)

const me = { id: crypto.randomUUID() }, other = { id: crypto.randomUUID() }
const threads = []
async function room(user) {
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','파일 방') returning id`, [user.id])
  threads.push(t.id)
  return t.id
}
const card = (tid, role, content) => q(`insert into pro_messages(thread_id,role,kind,content) values ($1,$2,'file',$3)`, [tid, role, content])
const noFolder = { link: null, shares: [] }
after(async () => {
  judgeServer.close()
  if (up && threads.length) await q('delete from pro_threads where id = any($1)', [threads])
  await pool.end()
})

test('BQ-F-01 후보: 이 방의 파일 카드(AI 가 만든 것 · 채팅에 올린 것) · 연결된 폴더(구성원만) · 받은 공유, 남의 방은 없다', { skip: !up }, async () => {
  const tid = await room(me)
  await card(tid, 'user', { name: '메모.docx', url: 'https://storage.example/public/files/k1', size: 2048, attached: true })
  await card(tid, 'agent', { name: '통신망 장애 온톨로지 보고서.pdf', path: '/workspace/.bpmn/c1/report.pdf', size: 820000 })
  await card(tid, 'agent', { name: '통신망 장애 온톨로지 보고서.pdf', path: '/workspace/.bpmn/c1/report.pdf', size: 820000 }) // the same file shown twice: once
  const folders = {
    access: async (slug, user) => { if (user.id !== me.id) throw Object.assign(new Error('no'), { status: 403 }); return { folder: { slug } } },
    tree: async () => [{ path: 'docs/표준 조사.pdf', kind: 'blob', size: 3000 }, { path: 'docs', kind: 'tree' }],
  }
  const list = await BF.fileCandidates(me, tid, { deps: { folders, link: { slug: 'team-docs' }, shares: [{ id: 's1', name: '동료가 준 표.xlsx' }] } })
  assert.deepEqual(list.map((c) => [c.name, c.kind, c.from]), [
    ['통신망 장애 온톨로지 보고서.pdf', 'pdf', 'artifact'], ['메모.docx', 'docx', 'chat'], ['표준 조사.pdf', 'pdf', 'folder'], ['동료가 준 표.xlsx', 'xlsx', 'share']])
  assert.deepEqual(list[0].src, { card: list[0].src.card, path: '/workspace/.bpmn/c1/report.pdf', url: '', key: '' })
  // someone else asking about this room gets none of its cards, and no folder they are not a member of
  assert.deepEqual((await BF.fileCandidates(other, tid, { deps: { folders, link: { slug: 'team-docs' }, shares: [] } })).map((c) => c.name), [])
  // as a task's file: where its bytes are, never a page's address for a folder file or a share
  assert.deepEqual(BF.asTaskFile(list[2]), { name: '표준 조사.pdf', cid: 'folder:team-docs:docs/표준 조사.pdf', size: 3000, from: 'folder', path: 'docs/표준 조사.pdf', folder: { slug: 'team-docs', path: 'docs/표준 조사.pdf' } })
  assert.deepEqual(BF.asTaskFile(list[3]), { name: '동료가 준 표.xlsx', cid: 'share:s1', from: 'share', share: 's1' })
})

test('BQ-F-02 고르기: 확실한 하나(0.6)는 그대로, 여럿이 그럴듯하면 카드에 올릴 것들, 없으면 없음 — 판정은 이름 · 형식 · 크기 · 어디서 온 것과 할 일을 읽는다', { skip: !up }, async () => {
  const tid = await room(me)
  await card(tid, 'agent', { name: '통신망 장애 온톨로지 보고서.pdf', path: '/workspace/.bpmn/c2/a.pdf', size: 820000 })
  await card(tid, 'agent', { name: '광선로 단선 진단 해외 사례.pdf', path: '/workspace/.bpmn/c2/b.pdf', size: 410000 })
  await card(tid, 'user', { name: '회의 메모.txt', url: 'u', size: 900 })
  const list = await BF.fileCandidates(me, tid, { deps: noFolder })
  assert.deepEqual(list.map((c) => c.name), ['회의 메모.txt', '광선로 단선 진단 해외 사례.pdf', '통신망 장애 온톨로지 보고서.pdf'], '새것부터')
  answers.push({ f0: 0.02, f1: 0.88, f2: 0.05, none: 0.05 })
  const sure = await BF.readFile(list, '이 PDF 로 NotebookLM 에서 팟캐스트를 만든다 — 광선로 단선 진단 사례')
  assert.equal(sure.pick.name, '광선로 단선 진단 해외 사례.pdf')
  const a = asked.at(-1)
  assert.match(a.state, /작업: 이 PDF 로 NotebookLM 에서 팟캐스트를 만든다/)
  assert.deepEqual(a.options.map((o) => o.key), ['f0', 'f1', 'f2', 'none'])
  assert.equal(a.options[1].label, '광선로 단선 진단 해외 사례.pdf · pdf · 400 KB · 이 방에서 AI 가 만든 파일')
  assert.equal(a.options[0].label, '회의 메모.txt · txt · 1 KB · 채팅에 올린 파일')
  answers.push({ f0: 0.03, f1: 0.45, f2: 0.42, none: 0.1 })
  const two = await BF.readFile(list, '그 PDF 로 팟캐스트', { want: 'PDF 보고서' })
  assert.equal(two.pick, null)
  assert.deepEqual(two.maybe.map((c) => c.kind), ['pdf', 'pdf'])
  assert.match(asked.at(-1).state, /찾는 파일: PDF 보고서/)
  answers.push({ f0: 0.05, f1: 0.05, f2: 0.05, none: 0.85 })
  const none = await BF.readFile(list, '유튜브 링크로 노트북 만들기')
  assert.equal(none.pick, null)
  assert.deepEqual(none.maybe, [])
  assert.deepEqual(await BF.readFile([], 'x'), { pick: null, maybe: [], probabilities: {}, ms: 0 }, '후보가 없으면 묻지 않는다')
  // a sure one with a close second is not sure
  assert.equal(BF.filePick({ f1: 0.62, f2: 0.3 }, list).pick, null)
  assert.equal(BF.filePick({ f1: 0.7, f2: 0.1 }, list).pick.name, list[1].name)
})

test('BQ-F-03 폴더 파일 · 공유는 그 사람으로 읽고, 방의 카드는 여기서 읽지 않는다', async () => {
  const folders = { access: async (slug, user) => { if (user.id !== me.id) throw Object.assign(new Error('not a member'), { status: 403 }); return { folder: { slug } } }, readBlob: async (folder, ref, p) => Buffer.from(`${folder.slug}:${ref}:${p}`) }
  const shares = { bytes: async (user, id) => { if (user.id !== me.id) throw new Error('404'); return { buf: Buffer.from(`share:${id}`) } } }
  assert.equal(String(await BF.bytesOf(me, { folder: { slug: 'team-docs', path: 'docs/a.pdf' } }, { deps: { folders } })), 'team-docs:main:docs/a.pdf')
  await assert.rejects(BF.bytesOf(other, { folder: { slug: 'team-docs', path: 'docs/a.pdf' } }, { deps: { folders } }), /not a member/)
  assert.equal(String(await BF.bytesOf(me, { share: 's1' }, { deps: { shares } })), 'share:s1')
  await assert.rejects(BF.bytesOf(other, { share: 's1' }, { deps: { shares } }))
  assert.equal(await BF.bytesOf(me, { name: 'a.pdf', path: '/workspace/.bpmn/c/a.pdf' }), null)
})
