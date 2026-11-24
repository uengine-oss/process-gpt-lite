// 파일 멘션 · 메신저의 @AI (2026-11-24 사용자: 「폴더내의 파일을 드래그앤드롭하면 멘션이 이루어져서 대화방에 공유됨 (파일첨부가 아닌 링크로)」 ·
// 「"@"하여 AI 를 지칭하여 … "장진영 이력서 첨부해" … 이는 회의실내에서도 AI 에게 도움을 요청하는 액션들과 동일함」 · 「모두 멘션」).
// Without a database or a model: the drag payload (src/fileDrag.js), the server's item check and the mention card's states
// (lib/fileRefs.js), what @AI is asked for and which file it picks (lib/assistHelp.js with a fake judge — the meeting calls the same).
// Run: node --test test/fileMention.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
process.env.SERVICE_ROLE_KEY ||= 'unit-test'
const D = await import('../../src/fileDrag.js')
const FR = await import('../lib/fileRefs.js')
const H = await import('../lib/assistHelp.js')
const { readSkillDir, bundledDir } = await import('../lib/skillPack.js')
const { withLang } = await import('../lib/lang.js')
const ko = (fn) => withLang('ko', fn)
const SHA = 'a'.repeat(40)
const ID = '11111111-2222-4333-8444-555555555555'

// ---------- the drag payload ----------
test('끌기 내용: 우리 것만 읽고, 항목마다 모양을 확인한다', () => {
  const folder = { src: 'folder', slug: 'cv-1a2b', folder: '이력서', path: '2026/차은솔_이력서.docx', commit: SHA }
  const items = D.parsePayload(JSON.stringify({ v: 1, items: [folder, { src: 'card', id: ID, name: '견적서.xlsx', as: 'share' }, { src: 'share', shareId: ID, name: '받은.pdf' },
    { src: 'ref', messageId: ID, index: 1, name: '안내문.hwpx' }] }))
  assert.deepEqual(items.map((x) => x.src), ['folder', 'card', 'share', 'ref'])
  assert.deepEqual(items[0], { src: 'folder', slug: 'cv-1a2b', folder: '이력서', path: '2026/차은솔_이력서.docx', name: '차은솔_이력서.docx', commit: SHA, as: 'link' })
  assert.equal(items[1].as, 'share')
  assert.equal(items[2].as, 'share')
  assert.equal(items[3].as, 'link')
  // a bare list is read too; the same file twice is one
  assert.equal(D.parsePayload(JSON.stringify([folder, folder])).length, 1)
  // not ours, broken, or hand-made with a path out of the folder / an id that is not one: nothing
  for (const bad of ['', 'not json', '{"v":2,"items":[]}', JSON.stringify({ v: 1, items: [{ src: 'folder', slug: 'x', path: '../../etc/passwd' }] }),
    JSON.stringify({ v: 1, items: [{ src: 'card', id: '1; drop table' }] }), JSON.stringify({ v: 1, items: [{ src: 'ref', messageId: ID, index: -1 }] }),
    JSON.stringify({ v: 1, items: [{ src: 'folder', slug: 'x', path: 'a.md', commit: 'HEAD' }] })]) {
    const got = D.parsePayload(bad)
    assert.ok(!got.length || !got[0].commit, bad)
    if (!bad.includes('a.md')) assert.deepEqual(got, [], bad)
  }
  // at most ten
  assert.equal(D.parsePayload(JSON.stringify(Array.from({ length: 14 }, (_, i) => ({ src: 'folder', slug: 's', path: `${i}.md` })))).length, D.MAX)
})

test('끌기 종류: 앱의 파일 · 컴퓨터의 파일 · 그 밖 — 놓는 자리마다 말', () => {
  assert.equal(D.dragKind([D.DRAG_TYPE, 'text/plain']), 'pgl')
  assert.equal(D.dragKind(['Files']), 'files')
  assert.equal(D.dragKind(['text/plain']), null)
  assert.equal(D.zoneWords('messenger', [{ as: 'link' }]), '여기에 놓으면 링크로 멘션해요')
  assert.equal(D.zoneWords('messenger', [{ as: 'share' }]), '여기에 놓으면 공유해요')
  assert.equal(D.zoneWords('messenger', [{ as: 'link' }, { as: 'share' }]), '여기에 놓으면 링크로 멘션하거나 공유해요')
  assert.equal(D.zoneWords('messenger', null), '여기에 놓으면 링크로 멘션해요', '다른 창에서 온 끌기(내용을 미리 못 읽음)')
  assert.equal(D.zoneWords('chat'), 'AI에게 이 파일로 묻기')
  assert.equal(D.zoneWords('folder'), '이 폴더에 넣기')
})

test('카드가 말하는 종류: 폴더에서 연 파일 · 프로젝트 폴더의 파일은 링크, 내 산출물은 공유', () => {
  assert.equal(D.cardItem({ id: ID, content: { name: 'a.docx', url: 'http://x/a.docx', folder: { slug: 'cv', name: '이력서', path: 'a.docx' } } }).as, 'link')
  assert.equal(D.cardItem({ id: ID, content: { name: '강의준비안.md', path: '/workspace/.bpmn/abc123/folders/cloudike/강의준비안.md' } }).as, 'link')
  assert.equal(D.cardItem({ id: ID, content: { name: '견적서.xlsx', url: 'http://x/files/a.xlsx' } }).as, 'share')
  assert.deepEqual(FR.projectPath('/workspace/.bpmn/abc123/folders/cloudike/docs/강의준비안.md'), { slug: 'cloudike', path: 'docs/강의준비안.md' })
  assert.equal(FR.projectPath('/workspace/.bpmn/abc/folders/x/../../etc'), null)
  assert.equal(FR.projectPath('/workspace/uploads/u/a.md'), null)
})

test('다른 창에서 끈 폴더 링크(text/uri-list) → 폴더 파일', () => {
  const o = 'http://localhost:5279'
  assert.deepEqual(D.itemFromUrl(`${o}/folders/cv-1a2b?file=${encodeURIComponent('2026/차은솔.docx')}`, o), { src: 'folder', slug: 'cv-1a2b', folder: '', path: '2026/차은솔.docx', name: '차은솔.docx', as: 'link' })
  assert.equal(D.itemFromUrl(`${o}/folders/cv?file=a.docx&ref=${SHA}`, o).commit, SHA)
  assert.equal(D.itemFromUrl(`${o}/folders/cv?file=a.docx&ref=${ID}`, o).variation, ID)
  assert.equal(D.itemFromUrl('https://evil.example/folders/cv?file=a.docx', o), null, '다른 사이트')
  assert.equal(D.itemFromUrl(`${o}/chat`, o), null)
})

test('서버의 항목 확인: 페이지가 보낸 것을 그대로 믿지 않는다', () => {
  assert.deepEqual(FR.normItem({ src: 'folder', slug: 'cv', path: 'a.docx', commit: 'zz', variation: { id: ID } }), { src: 'folder', slug: 'cv', path: 'a.docx', commit: null, blob: null, variation: ID, name: 'a.docx' })
  assert.equal(FR.normItem({ src: 'card', id: 'x' }), null)
  assert.equal(FR.normItem({ src: 'ref', messageId: ID, index: 10 }), null)
  // (a mail is an item now — spec mail-card-actions, test/mailFollow.test.js; a kind the server does not know still is not)
  assert.equal(FR.normItem({ src: 'calendar', id: ID }), null)
  assert.equal(FR.normItem({ src: 'mail', id: 'not-a-card-id' }), null)
  assert.equal(FR.normItems(Array.from({ length: 30 }, () => ({ src: 'card', id: ID }))).length, FR.MAX)
})

// ---------- the mention card ----------
test('멘션 카드의 상태: 권한 없음 → 권한 요청 → 요청함, 열림 · 바뀜(최신 열기) · 지워짐', () => {
  assert.equal(FR.cardState({ access: 'none' }), 'noaccess')
  assert.equal(FR.cardState({}), 'noaccess', '알 수 없으면 권한 없음으로')
  assert.equal(FR.cardState({ access: 'none', requested: true }), 'requested')
  assert.equal(FR.cardState({ access: 'read' }), 'open')
  assert.equal(FR.cardState({ access: 'edit', changed: true }), 'changed')
  assert.equal(FR.cardState({ access: 'read', gone: true, changed: true }), 'gone', '지워진 파일은 바뀐 것보다 먼저')
  // a viewer without access learns nothing more from the state than that
  assert.equal(FR.cardState({ access: 'none', changed: true, gone: true }), 'noaccess')
  assert.equal(FR.requestUrl('cv-1a2b', ID), `/folders/cv-1a2b?share=${ID}`)
})

// ---------- @AI: what is asked, which file (a fake judge — the same functions the meeting's helper calls) ----------
const skill = () => ({ name: 'assist-help', source: 'bundled', ...readSkillDir(bundledDir('assist-help')), rules: { maxCandidates: 12, minAction: 0.45, minPick: 0.4, alsoPick: 0.25, maxPicks: 4, contextLines: 4, timeoutMs: 1000, ...readSkillDir(bundledDir('assist-help')).rules } })
// a judge that gives `p` to the option whose label holds `want`, the rest spread
const judgeFor = (want, p = 0.9, seen = []) => ({
  odds: async (state, question, options) => {
    seen.push({ state, question, options })
    const hit = options.find((o) => o.label.includes(want)) || options.at(-1)
    const rest = (1 - p) / Math.max(1, options.length - 1)
    const probabilities = Object.fromEntries(options.map((o) => [o.key, o.key === hit.key ? p : rest]))
    return { choice: hit.key, probabilities, confidence: p, model: 'fake' }
  },
})

test('@AI 가 받은 부탁: 판정 모델이 고른 일(자료 · 맡기기 · 답), 확신이 낮으면 짧은 답, 판정이 없으면 null', () => ko(async () => {
  const sk = skill()
  const seen = []
  const r = await H.askedFor({ said: '차은솔 이력서 첨부해', prev: ['서하린: 다음 주 면접 일정 잡아야 해요'] }, { skill: sk, judges: judgeFor('이미 있는 파일', 0.86, seen) })
  assert.equal(r.action, 'material')
  assert.equal(r.p, 0.86)
  // the judge read the skill's question and the request on its own line, after the room's line
  assert.match(seen[0].question, /무엇을 해 달라는/)
  assert.match(seen[0].state, /앞선 대화:\n서하린: 다음 주 면접 일정 잡아야 해요\n\n방금 AI 에게 한 부탁:\n차은솔 이력서 첨부해/)
  assert.deepEqual(seen[0].options.map((o) => o.key), ['material', 'work', 'answer'])
  assert.equal((await H.askedFor({ said: '견적서 5% 낮춰서 다시 만들어 줘' }, { skill: sk, judges: judgeFor('새로 만들거나', 0.8) })).action, 'work')
  assert.equal((await H.askedFor({ said: '고마워' }, { skill: sk, judges: judgeFor('짧게 답하면', 0.95) })).action, 'answer')
  assert.equal((await H.askedFor({ said: '음' }, { skill: sk, judges: judgeFor('이미 있는 파일', 0.4) })).action, 'answer', '확신이 낮으면 짧게 답한다')
  assert.equal((await H.askedFor({ said: 'x' }, { skill: sk, judges: { odds: async () => null, json: async () => { throw new Error('down') } } })).action, null)
}))

const POOL = [
  { kind: 'folder', id: 'f1:차은솔_이력서.docx', title: '차은솔_이력서.docx', folderFile: true, where: '이력서', keywords: ['백엔드', '경력 7년'], ref: { slug: 'cv', path: '차은솔_이력서.docx' } },
  { kind: 'folder', id: 'f1:민도현_이력서.pptx', title: '민도현_이력서.pptx', folderFile: true, where: '이력서', keywords: [], ref: { slug: 'cv', path: '민도현_이력서.pptx' } },
  { kind: 'file', id: 'm1', title: '면접_일정.xlsx', ref: { sourceId: 'm1', ownerId: 'u1' } },
  { kind: 'process', id: 'p1', title: '채용 요청', ref: { instId: 'p1' } },
]
test('어느 파일인지: 후보는 이름 · 있는 곳 · 키워드로 보이고, 판정 모델이 고른다(맞는 것 없음 · 낮은 확신이면 못 찾음)', () => ko(async () => {
  const sk = skill()
  const seen = []
  const r = await H.findMaterials({ said: '차은솔 이력서 첨부해', roomId: 'r', asker: { id: 'u1' } }, { skill: sk, judges: judgeFor('차은솔', 0.9, seen), pool: async () => POOL })
  assert.deepEqual(r.picks.map((x) => x.title), ['차은솔_이력서.docx'])
  assert.equal(r.judge.p, 0.9)
  const labels = seen[0].options.map((o) => o.label)
  assert.equal(labels[0], '차은솔_이력서.docx — 공유 폴더 「이력서」 — 백엔드, 경력 7년')
  assert.equal(labels.at(-1), '어느 것도 아니다 — 맞는 자료가 없다')
  assert.match(seen[0].question, /가리키는 자료는/)
  // the messenger attaches files only: a process is not offered to the judge
  const files = (c) => c.kind === 'file' || c.folderFile
  const seen2 = []
  await H.findMaterials({ said: '이력서', roomId: 'r', asker: { id: 'u1' }, kinds: files }, { skill: sk, judges: judgeFor('차은솔', 0.9, seen2), pool: async () => POOL })
  assert.ok(!seen2[0].options.some((o) => o.label.includes('채용 요청')))
  // two asked for at once: the second one the judge gave a good share to comes along
  const two = { odds: async (s, q, options) => ({ choice: 'c0', probabilities: { c0: 0.5, c1: 0.42, c2: 0.04, c3: 0.02, none: 0.02 }, confidence: 0.5, model: 'fake' }) }
  assert.deepEqual((await H.findMaterials({ said: '두 사람 이력서 다 붙여 줘', asker: { id: 'u1' } }, { skill: sk, judges: two, pool: async () => POOL })).picks.map((x) => x.title), ['차은솔_이력서.docx', '민도현_이력서.pptx'])
  // none of them, unsure, or nothing the asker may see: not found
  assert.equal((await H.findMaterials({ said: '달빛커피 계약서', asker: { id: 'u1' } }, { skill: sk, judges: judgeFor('어느 것도 아니다', 0.8), pool: async () => POOL })).notFound, true)
  assert.equal((await H.findMaterials({ said: '그거', asker: { id: 'u1' } }, { skill: sk, judges: judgeFor('차은솔', 0.3), pool: async () => POOL })).notFound, true)
  // no judge answered: said so (not 「찾지 못했어요」)
  const down = await H.findMaterials({ said: '차은솔 이력서', asker: { id: 'u1' } }, { skill: sk, judges: { odds: async () => null, json: async () => { throw new Error('down') } }, pool: async () => POOL })
  assert.equal(down.failed, true)
  assert.equal(down.notFound, undefined)
  let judged = 0
  const none = await H.findMaterials({ said: '차은솔 이력서', asker: { id: 'u1' } }, { skill: sk, judges: { odds: async () => { judged++; return null } }, pool: async () => [] })
  assert.equal(none.notFound, true)
  assert.equal(judged, 0, '후보가 없으면 판정 모델을 부르지 않는다')
}))

test('일의 종류: 회의와 @AI 가 같은 질문 · 같은 보기로 묻는다', async () => {
  let asked = null
  const w = await H.workOf('state', { ask: async (state, question, options) => { asked = { question, options }; return { probabilities: { CreateDocument: 0.2, CreateSpreadsheet: 0.7 }, ms: 12, model: 'm' } } })
  assert.deepEqual(w, { work: 'CreateSpreadsheet', p: 0.7, ms: 12, model: 'm' })
  assert.equal(asked.question, H.WORK_QUESTION)
  assert.ok(!asked.options.some((o) => ['StartProcessInstance', 'CreateProcessDefinition'].includes(o.key)))
  assert.ok(asked.options.some((o) => o.key === 'SummarizeChat'))
})

test('@AI 말머리: 화면이 붙인 「@AI 」만 떼어 낸다', async () => {
  const { requestOf } = await import('../lib/team/aiHelp.js')
  assert.equal(requestOf('@AI 차은솔 이력서 첨부해'), '차은솔 이력서 첨부해')
  assert.equal(requestOf('@ai   견적서 보여 줘'), '견적서 보여 줘')
  assert.equal(requestOf('이 @AI 는 가운데'), '이 @AI 는 가운데')
})

test('리뷰 10: 한마디에서 더 고른 자료도 분당 띄우는 한도 안에서만', async () => {
  const I = await import('../lib/meetings/intent.js')
  assert.equal(I.extraBudget(0), I.PER_MIN - 1, '첫 자료를 빼고 남은 만큼')
  assert.equal(I.extraBudget(I.PER_MIN - 1), 0)
  assert.equal(I.extraBudget(I.PER_MIN + 3), 0)
  assert.equal(I.extraBudget(undefined), I.PER_MIN - 1)
})
