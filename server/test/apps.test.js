// Lite apps, contract v1 (docs/robo-dlc/plan-review.md): the manifests, the import boundary, the record
// readers the apps stand on, and each app's own logic — no database, no server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'
import { checkManifest, CAPABILITIES } from '../lib/apps/registry.js'
import * as R from '../lib/aidlc/record.js'
import { unitNow } from '../lib/aidlc/metrics.js'
import * as B from '../apps/review/board.js'
import { stageTimes, buildTree } from '../apps/bolts/tree.js'
import { renderDoc, findHeading } from '../apps/artifact/render.js'
import { appApiPath, navAllowed } from '../../src/apps/paths.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APPS = path.join(HERE, '../apps')
const P2 = path.join(HERE, 'fixtures/aidlc-p2/261109-team-todo-board')
const apps = fs.readdirSync(APPS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)

// ---------- the contract ----------
test('앱 규약: 들어 있는 앱의 매니페스트는 모두 규약 v1 을 지킨다', () => {
  assert.deepEqual(apps.sort(), ['artifact', 'bolts', 'review'])
  for (const id of apps) {
    const m = checkManifest(JSON.parse(fs.readFileSync(path.join(APPS, id, 'manifest.json'), 'utf8')), id)
    assert.equal(m.contract, 1)
    for (const c of m.capabilities) assert.ok(CAPABILITIES.includes(c), `${id}: ${c}`)
    assert.ok(fs.existsSync(path.join(APPS, id, 'ui', 'index.html')), `${id} has a page`)
  }
})

test('앱 규약: 잘못된 매니페스트는 무엇이 틀렸는지 말하고 거절된다', () => {
  const ok = { id: 'x-app', version: '1.0.0', contract: 1, name: { ko: '가', en: 'A' } }
  assert.equal(checkManifest(ok, 'x-app').id, 'x-app')
  assert.throws(() => checkManifest(ok, 'other'), /id must match/)
  assert.throws(() => checkManifest({ ...ok, contract: 2 }, 'x-app'), /contract 2/)
  assert.throws(() => checkManifest({ ...ok, capabilities: ['api', 'shell'] }, 'x-app'), /unknown shell/)
  assert.throws(() => checkManifest({ ...ok, handles: ['aidlc.everything'] }, 'x-app'), /unknown aidlc.everything/)
  assert.throws(() => checkManifest({ ...ok, name: { ko: '가' } }, 'x-app'), /name needs ko and en/)
})

// an app's server code reaches Lite only through ctx: its imports are its own files, node's, or a package
test('앱 규약: 앱 서버 코드는 호스트 모듈을 import 하지 않는다', () => {
  const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(HERE, '../package.json'), 'utf8')).dependencies)
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === 'ui' ? [] : walk(path.join(dir, d.name))) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []))
  for (const id of apps) {
    for (const file of walk(path.join(APPS, id))) {
      const src = fs.readFileSync(file, 'utf8')
      for (const m of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
        const spec = m[1] || m[2]
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(file), spec)
          assert.ok(target.startsWith(path.join(APPS, id) + path.sep), `${path.relative(APPS, file)} imports ${spec} outside its app`)
        } else {
          const name = spec.replace(/^node:/, '').split('/')[0]
          assert.ok(builtinModules.includes(name) || deps.includes(spec.split('/')[0]), `${path.relative(APPS, file)} imports ${spec}`)
        }
      }
    }
  }
})

test('앱 규약: 한 앱이 깨져도 다른 앱은 올라온다', async () => {
  const { loadApps, list } = await import('../lib/apps/registry.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-apps-'))
  const mk = (id, server) => {
    fs.mkdirSync(path.join(dir, id))
    fs.writeFileSync(path.join(dir, id, 'manifest.json'), JSON.stringify({ id, version: '1.0.0', contract: 1, name: { ko: id, en: id }, capabilities: ['api'] }))
    fs.writeFileSync(path.join(dir, id, 'server.js'), server)
  }
  mk('good-app', 'export default (ctx) => ({ routes(r) { r.get("/x", () => ({ contract: ctx.contract })) } })')
  mk('bad-app', 'throw new Error("boom")')
  const loaded = await loadApps(dir)
  assert.deepEqual(loaded, ['good-app'])
  assert.deepEqual(list().map((m) => m.id), ['good-app'])
  await loadApps() // back to the real apps for the rest of the process
})

test('앱 브리지: 앱은 자기 경로만 부르고, 정해진 Lite 화면으로만 옮긴다', () => {
  assert.equal(appApiPath('review', 'folder-1/board'), '/apps/review/folder-1/board')
  assert.equal(appApiPath('review', '/folder-1/mark'), '/apps/review/folder-1/mark')
  assert.equal(appApiPath('artifact', 'folder-1/doc?path=inception%2Fdomain-design%2Fdecisions.md&focus=ADR-004'), '/apps/artifact/folder-1/doc?path=inception%2Fdomain-design%2Fdecisions.md&focus=ADR-004')
  for (const bad of ['../aidlc/x', 'a/../../b', 'a/%2e%2e/b', 'a%2fb', 'ui/index.html', '']) assert.throws(() => appApiPath('review', bad), /not allowed/, bad)
  assert.throws(() => appApiPath('../x', 'a'), /not allowed/)
  for (const ok of ['/workroom/aidlc/folder-1', '/aidlc/folder-1/decide', '/apps/artifact/folder-1?path=a.md', '/folders/folder-1']) assert.ok(navAllowed(ok), ok)
  for (const bad of ['https://evil.example', '/settings/admin', '//evil', '/workroom/folder/x', 'javascript:alert(1)']) assert.ok(!navAllowed(bad), bad)
})

// ---------- the record readers ----------
test('질문 파일: 역할 태그, 묻는 이유, AI-DLC 추천과 그 이유를 읽는다', async () => {
  const qs = (await R.listQuestions(P2)).find((f) => f.stage === 'requirements-analysis').questions
  const q1 = qs.find((x) => x.id === 'Q1')
  assert.equal(q1.tag, '제품 관리자')
  assert.match(q1.note, /로그인/)
  assert.equal(q1.recommended, 'A')
  assert.equal(q1.why, '이번 범위를 가장 작게 유지')
  assert.ok(q1.options.find((o) => o.key === 'A').rec)
  // "(권장)" without a reason, and a file that says "각 질문의 A가 권장안" recommends A where no option says so
  const fileRec = R.parseQuestions('각 질문의 A가 권장안입니다.\n\n## Q1. [개발] 무엇으로?\n이유 한 줄\n\nA. 하나\nB. 둘\n\n[Answer]: \n')
  assert.equal(fileRec[0].recommended, 'A')
  assert.equal(fileRec[0].note, '이유 한 줄')
  assert.equal(R.parseQuestions('## Q2. [제품] 몇 명?\n\nA. 한 명\nB. 여러 명 (Recommended: simpler later)\n\n[Answer]: \n')[0].recommended, 'B')
})

test('검토 파일: 지적의 위치·내용·고칠 일을 읽고, 위치를 기록 안 문서와 초점으로 바꾼다', async () => {
  const [rv] = await R.listReviews(P2)
  const r2 = rv.findings.find((f) => f.id === 'R-02')
  assert.match(r2.location, /decisions\.md > ADR-004, against requirements\.md FR7\.2/)
  assert.match(r2.finding, /FR7\.2/)
  assert.match(r2.action, /ADR-004/)
  const docs = await R.docList(P2)
  assert.deepEqual(R.resolveRefs(r2.location, docs, 'domain-design'), [
    { path: 'inception/domain-design/decisions.md', focus: 'ADR-004', label: 'decisions.md › ADR-004' },
    { path: 'inception/requirements-analysis/requirements.md', focus: 'FR7.2', label: 'requirements.md › FR7.2' },
  ])
  const r1 = R.resolveRefs(rv.findings.find((f) => f.id === 'R-01').location, docs, 'domain-design')
  assert.deepEqual(r1.map((x) => x.focus), ['ADR-002', '의도적 양방향 호출'])
  assert.deepEqual(R.resolveRefs('server/src/http/app.ts > jsonGate', docs), []) // code is not a record document
})

test('문서: 기록 안의 .md 만, 질문 밖 경로는 404', async () => {
  const d = await R.readDoc(P2, 'inception/domain-design/decisions.md')
  assert.equal(d.stage, 'domain-design')
  assert.match(d.text, /ADR-004/)
  for (const bad of ['../../../../etc/hosts', 'inception/domain-design/../../x.md', '/etc/hosts', 'audit/x.md']) await assert.rejects(R.readDoc(P2, bad), { status: 404 }, bad)
})

test('볼트 계획: 볼트마다 포함 유닛과 앞선 볼트', async () => {
  const units = (await R.readUnits(P2)).map((u) => u.name)
  assert.deepEqual(units, ['u1-todo-api', 'u2-board-web'])
  assert.deepEqual(await R.readBolts(P2, units), [
    { n: 1, name: '할 일 API', id: 'bolt-1-todo-api', units: ['u1-todo-api'], after: [] },
    { n: 2, name: '보드 화면', id: 'bolt-2-board-web', units: ['u2-board-web'], after: [1] },
  ])
  assert.deepEqual(R.parseBolts('## Bolt 1 — API (`b1`)\n\n| Item | Detail |\n|---|---|\n| Units | U1 `u1-api` |\n'), [{ n: 1, name: 'API', id: 'b1', units: ['u1-api'], after: [] }])
})

// the code plan waits on the developer: the stage comes from the unit's events, not the state file
test('지금 유닛 단계: 유닛 사건이 단계를 정하고, 유닛이 끝난 뒤 전체 단계 사건이 오면 끝난다', () => {
  const e = (event, stage, unit = '') => ({ event, stage, unit })
  const run = [e('UNIT_STARTED', 'functional-design', 'u1'), e('UNIT_COMPLETED', 'functional-design', 'u1'), e('UNIT_STARTED', 'code-generation', 'u1')]
  assert.deepEqual(unitNow(run), { unit: 'u1', stage: 'code-generation', open: true, at: undefined })
  // the code plan for u2 is asked before u2's code-generation starts: PLAN_APPROVAL_* names it
  const plan = [...run, e('UNIT_COMPLETED', 'code-generation', 'u1'), e('UNIT_COMPLETED', 'infrastructure-design', 'u2'), e('PLAN_APPROVAL_BLOCKED', 'code-generation', 'u2')]
  assert.equal(unitNow(plan).stage, 'code-generation')
  assert.equal(unitNow(plan).unit, 'u2')
  // after the units: the whole-intent gates (no unit) and build-and-test
  assert.equal(unitNow([...plan, e('GATE_APPROVED', 'code-generation', 'u2'), e('STAGE_AWAITING_APPROVAL', 'functional-design')]), null)
  assert.equal(unitNow([...plan, e('STAGE_STARTED', 'build-and-test')]), null)
  assert.equal(unitNow([e('UNIT_STARTED', 'code-generation', '(missing marker)')]), null)
})

// ---------- the review board ----------
test('검토 보드: 질문 태그가 역할이 된다(실제 실행에서 본 태그)', () => {
  const want = { '제품': 'product', '제품 관리자': 'product', '제품 책임자': 'product', '아키텍트': 'architect', '아키텍처': 'architect', '개발': 'developer', '개발자': 'developer', '개발 리드': 'developer',
    '디자이너': 'design', '디자인': 'design', '품질': 'quality', '품질 엔지니어': 'quality', '딜리버리 리드': 'delivery', '운영': 'operations', '릴리스 엔지니어': 'pipeline-deploy', '': null, '기타': null }
  for (const [tag, role] of Object.entries(want)) assert.equal(B.roleOfTag(tag), role, tag)
})

test('검토 보드: 담당의 결정, 그 뒤의 이의, 다시 정하면 풀린다', () => {
  const it = { key: 'q:a#Q1@x', kind: 'question', recommended: 'A' }
  const at = (s) => new Date(Date.UTC(2026, 10, 11, 10, s)).toISOString()
  const reviewers = new Set(['po'])
  const m = (user_id, stance, s, extra = {}) => ({ item_key: it.key, user_id, stance, updated_at: at(s), ...extra })
  assert.equal(B.itemState(it, [], reviewers).state, 'open')
  assert.equal(B.itemState(it, [m('dev', 'agree', 1)], reviewers).state, 'open', 'not the reviewer: no decision')
  assert.equal(B.itemState(it, [m('po', 'agree', 1)], reviewers).state, 'decided')
  assert.equal(B.itemState(it, [m('po', 'agree', 1), m('arch', 'object', 2, { note: '왜' })], reviewers).state, 'discuss')
  assert.equal(B.itemState(it, [m('arch', 'object', 1, { note: '왜' }), m('po', 'choose', 3, { choice: 'B' })], reviewers).state, 'decided')
  assert.equal(B.itemState({ ...it, sent: true }, [m('arch', 'object', 1)], reviewers).state, 'sent')
  assert.equal(B.answerOf(it, { stance: 'agree' }), 'A')
  assert.equal(B.answerOf(it, { stance: 'choose', choice: 'C' }), 'C')
  assert.equal(B.answerOf(it, { stance: 'choose', choice: 'X', note: '회의실은 10개까지' }), 'X. 회의실은 10개까지')
  assert.equal(B.answerOf(it, null), null)
  assert.equal(B.answerOf(it, null, { useRecommended: true }), 'A')
})

test('검토 보드: 지적들의 결정이 승인 창의 답 하나가 된다', () => {
  const f = (id, stance, note) => ({ key: id, id, kind: 'finding', decision: stance && { stance, note } })
  const states = (list) => new Map(list.map((x) => [x.key, { decision: x.decision }]))
  const all = [f('R-01', 'accept'), f('R-02', 'accept')]
  assert.deepEqual(B.composeApproval(all, states(all)), { action: 'approve', text: '' })
  const rej = [f('R-01', 'accept'), f('R-03', 'reject', '계약 설계에서 다룸')]
  assert.equal(B.composeApproval(rej, states(rej)).action, 'approve-with-notes')
  assert.match(B.composeApproval(rej, states(rej)).text, /^Approve\. .*R-03 — 계약 설계에서 다룸/)
  const fix = [f('R-01', 'accept'), f('R-02', 'fix', 'FR7.2 를 칸 단위로 고쳐 적어 주세요'), f('R-03', 'reject', '해당 단계 아님')]
  const d = B.composeApproval(fix, states(fix))
  assert.equal(d.action, 'request-changes')
  assert.equal(d.text, 'Request Changes: 고쳐 주세요: R-02 — FR7.2 를 칸 단위로 고쳐 적어 주세요. 해당 없음: R-03 — 해당 단계 아님')
})

test('검토 보드: 근거 찾기는 질문의 낱말이 든 기록의 줄을 그 절과 함께 찾는다', async () => {
  const q = (await R.listQuestions(P2)).find((f) => f.stage === 'requirements-analysis').questions.find((x) => x.id === 'Q2')
  const terms = B.termsOf(`${q.text} ${q.note}`)
  assert.ok(terms.includes('담당자'), terms.join(','))
  assert.ok(!terms.includes('어떻게'))
  const docs = await Promise.all((await R.docList(P2)).filter((d) => !/-questions\.md$|\/reviews\//.test(d.path)).map((d) => R.readDoc(P2, d.path)))
  const hits = B.searchDocs(docs, terms)
  assert.ok(hits.length > 0)
  assert.ok(hits.every((h) => h.snippet && h.path.endsWith('.md') && h.label.includes(h.path.split('/').pop())))
  assert.ok(hits.some((h) => h.path === 'inception/requirements-analysis/requirements.md'))
})

// ---------- the bolt board ----------
test('볼트 보드: 볼트 → 유닛 → 구축 단계, 지금 도는 단계와 각 단계 시간', () => {
  const t0 = Date.UTC(2026, 10, 11, 9, 0)
  const ev = (min, event, stage, unit) => ({ t: t0 + min * 60000, event, stage, unit })
  const events = [ev(0, 'UNIT_STARTED', 'functional-design', 'u1'), ev(12, 'UNIT_COMPLETED', 'functional-design', 'u1'), ev(12, 'UNIT_STARTED', 'code-generation', 'u1')]
  const times = stageTimes(events, t0 + 30 * 60000)
  assert.equal(times.get('u1').get('functional-design').min, 12)
  assert.equal(times.get('u1').get('code-generation').min, 18)
  const units = [{ name: 'u1', kind: 'service', status: 'working', stages: { 'functional-design': 'done', 'code-generation': 'working' } }, { name: 'u2', kind: 'ui', status: 'blocked', stages: {} }, { name: 'u3', kind: 'worker', status: 'ready', stages: {} }]
  const tree = buildTree({ bolts: [{ n: 1, name: 'API', id: 'b1', units: ['u1'], after: [] }, { n: 2, name: '화면', id: 'b2', units: ['u2'], after: [1] }], units, times, now: { unit: 'u1', stage: 'code-generation', open: true } })
  assert.deepEqual(tree.map((b) => [b.id, b.status, b.units.map((u) => u.name)]), [['b1', 'working', ['u1']], ['b2', 'blocked', ['u2']], ['units', 'pending', ['u3']]])
  const u1 = tree[0].units[0]
  assert.ok(u1.running)
  assert.deepEqual(u1.stages.map((s) => s.state), ['done', 'pending', 'pending', 'pending', 'working'])
  assert.ok(u1.stages[4].now)
})

// ---------- the document viewer ----------
test('산출물 보기: 원문 HTML 은 글자로, 링크는 스스로 열리지 않고, 절마다 id, 초점 절을 이름으로 찾는다', () => {
  const r = renderDoc('# 결정\n\n## ADR-004: 바뀐 칸만 저장\n\n## Status: Accepted\n\n본문 <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[나쁜](javascript:alert(1)) [좋은](https://example.com)\n\n## ADR-005: 다음\n')
  assert.ok(!r.html.includes('<script>') && !r.html.includes('<img'))
  assert.ok(!/\shref=/.test(r.html), 'no live links')
  assert.match(r.html, /data-href="https:\/\/example.com"/)
  assert.match(r.html, /data-ref="javascript:alert\(1\)"/)
  assert.deepEqual(r.headings.map((h) => h.text), ['결정', 'ADR-004: 바뀐 칸만 저장', 'Status: Accepted', 'ADR-005: 다음'])
  assert.equal(findHeading(r.headings, 'ADR-004').text, 'ADR-004: 바뀐 칸만 저장')
  assert.equal(findHeading(r.headings, 'adr 005').text, 'ADR-005: 다음')
  assert.equal(findHeading(r.headings, 'FR7.2'), null)
  // a focus that says more than the heading: its leading words
  assert.equal(findHeading(r.headings, 'ADR-004 Decision 1단계').text, 'ADR-004: 바뀐 칸만 저장')
  assert.equal(findHeading(r.headings, '"결정" 아래 문단').text, '결정')
  assert.equal(r.title, '결정')
})
