// Robo-DLC Lite: reading an AI-DLC record and the dashboard numbers. The fixture is a real run
// (AX School hands-on, classic scope, audit trimmed to the events the dashboards read) plus a poc
// run started headless and stopped at its first questions.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as R from '../lib/aidlc/record.js'
import * as M from '../lib/aidlc/metrics.js'
import { build } from '../lib/aidlc/service.js'
import { PRESETS, presetSpec } from '../lib/aidlc/presets.js'
import { aidlcApiPath } from '../../src/components/panelRuntime.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'aidlc-project')

async function load(slug) {
  const { dir, intent } = await R.intentDir(ROOT, 'default', slug)
  const [state, events, units, questions, reviews] = await Promise.all([R.readState(dir), R.readAudit(dir), R.readUnits(dir), R.listQuestions(dir), R.listReviews(dir)])
  return { meta: intent, state, events, units, questions, reviews }
}

test('작업 목록: intents.json 의 두 작업', async () => {
  assert.ok(await R.hasAidlc(ROOT))
  const list = await R.listIntents(ROOT)
  assert.deepEqual(list.map((i) => [i.slug, i.scope, i.status]), [['voice-parking', 'classic', 'complete'], ['todo-web-app', 'poc', 'in-flight']])
})

test('이름 검사: 폴더 밖으로 나가는 이름과 없는 작업은 거절', async () => {
  for (const bad of ['../x', 'a/b', '', '.hidden', 'x\\y']) assert.throws(() => R.safeName(bad))
  await assert.rejects(R.intentDir(ROOT, 'default', 'nope'), /intent not found/)
  await assert.rejects(R.intentDir(ROOT, '..', 'voice-parking'), /bad name/)
})

test('상태 파일: 범위·현재 단계·단계 레일', async () => {
  const { state } = await load('voice-parking')
  assert.equal(state.scope, 'classic')
  assert.equal(state.currentStage, 'build-and-test')
  assert.equal(state.status, 'Completed')
  const rail = M.rail(state)
  assert.equal(rail.length, 33)
  assert.equal(rail.find((r) => r.slug === 'domain-design').status, 'done')
  assert.equal(rail.find((r) => r.slug === 'market-research').status, 'skipped')
})

test('감사 기록: 승인 18 · 반려 3 · 체크포인트 검증', async () => {
  const { events } = await load('voice-parking')
  assert.ok(events.every((e, i) => i === 0 || events[i - 1].t <= e.t), 'time order')
  const c = M.counts(events)
  assert.equal(c.approvals, 18)
  assert.equal(c.rejections, 3)
  assert.equal(c.sensorsFailed, 7)
  assert.ok(c.checkpoints.ok >= 5 && c.checkpoints.failed >= 2, JSON.stringify(c.checkpoints))
})

test('설계 단계: AI 작업과 사람 대기, 반려', async () => {
  const { events } = await load('voice-parking')
  const by = Object.fromEntries(M.stageMetrics(events).map((s) => [s.slug, s]))
  // 4.85 min of AI work, 0.6 min of waiting (rounded to 0.1 min)
  assert.ok(Math.abs(by['practices-discovery'].aiMin - 4.85) <= 0.06, String(by['practices-discovery'].aiMin))
  assert.equal(by['practices-discovery'].humanMin, 0.6)
  assert.equal(by['practices-discovery'].role, '팀 리드')
  assert.equal(by['domain-design'].rejects, 1)
  assert.equal(by['domain-design'].state, 'done')
  assert.equal(by['contract-design'].rejects, 1)
  assert.equal(by['build-and-test'].rejects, 1)
  assert.ok(!by['functional-design'], 'unit stages are counted per unit, not as one stage')
})

test('유닛: 의존, 작업 시간, 검증 실패 재시도, 모두 완료', async () => {
  const { events, units } = await load('voice-parking')
  assert.equal(units.length, 5)
  const by = Object.fromEntries(M.unitMetrics(events, units).map((u) => [u.name, u]))
  assert.deepEqual(by['u2-reservation-service'].dependsOn, ['u1-search-service'])
  assert.ok(Object.values(by).every((u) => u.status === 'done'))
  assert.ok(by['u3-payment-service'].checks.failed >= 2)
  assert.equal(by['u1-search-service'].stages['infrastructure-design'], 'skipped')
  assert.ok(by['u1-search-service'].workMin > 30)
})

test('유닛 상태: 아직 시작 전이면 의존이 풀린 것만 「시작 가능」', () => {
  const u = M.unitMetrics([], [{ name: 'a', kind: 'service', dependsOn: [] }, { name: 'b', kind: 'service', dependsOn: ['a'] }])
  assert.deepEqual(u.map((x) => [x.name, x.status]), [['a', 'ready'], ['b', 'blocked']])
})

test('유닛 표시가 없는 사건은 유닛이 아니고, 감사 기록의 \\n 은 띄어 쓴다', () => {
  const ev = (event, fields) => ({ t: 1, ts: '2026-11-05T00:00:00Z', event, title: '', stage: 'code-generation', unit: fields.Unit || '', fields })
  const u = M.unitMetrics([ev('SENSOR_FIRED', { Unit: '(missing marker)' })], [{ name: 'a', kind: 'service', dependsOn: [] }])
  assert.deepEqual(u.map((x) => x.name), ['a'])
  const [t] = M.timeline([ev('GATE_REJECTED', { Feedback: '끄지 마세요.\\n다른 작업' })])
  assert.equal(t.detail, 'Feedback: 끄지 마세요. 다른 작업')
})

test('질문: 답을 다 적은 뒤 엔진이 붙이는 요약 확인도 열린 질문', () => {
  const md = ['## Q1. [제품] 누가 쓰나요?', '', '- A. 나 혼자', '- B. 팀', '', '[Answer]: A', '', '## Consolidated Summary Confirmation', '',
    'Does this all look correct before I generate the artifact?', '', '- Looks correct', '- Request changes', '', '[Answer]:', '', '## Notes', '', '- not an option'].join('\n')
  const qs = R.parseQuestions(md)
  assert.deepEqual(qs.map((q) => [q.id, q.answer]), [['Q1', 'A'], ['summary', '']])
  assert.equal(qs[1].text, 'Does this all look correct before I generate the artifact?')
  assert.deepEqual(qs[1].options.map((o) => [o.key, o.text]), [['', 'Looks correct'], ['', 'Request changes']])
  assert.equal(R.parseQuestions(md.replace(/\[Answer\]:$/m, '[Answer]: Looks correct'))[1].answer, 'Looks correct')
})

test('승인 대기: 기다린 시간은 지금까지', () => {
  const t0 = Date.parse('2026-11-09T00:00:00Z')
  const ev = [
    { t: t0, event: 'STAGE_STARTED', stage: 'domain-design', unit: '', fields: {} },
    { t: t0 + 5 * 60000, event: 'STAGE_AWAITING_APPROVAL', stage: 'domain-design', unit: '', fields: {} },
  ]
  const [s] = M.stageMetrics(ev, t0 + 65 * 60000)
  assert.equal(s.state, 'waiting')
  assert.equal(s.aiMin, 5)
  assert.equal(s.waitingMin, 60)
  assert.equal(s.role, '아키텍트')
})

test('검토: 단계별 마지막 판정과 회차', async () => {
  const { reviews } = await load('voice-parking')
  const sum = M.reviewSummary(reviews)
  const dd = sum.find((r) => r.slug === 'domain-design' && !r.unit)
  assert.equal(dd.rounds, 2)
  assert.equal(dd.verdict, 'READY')
  const u4 = sum.find((r) => r.unit === 'u4-web-ui')
  assert.equal(u4.rounds, 2)
  assert.ok(reviews.find((r) => r.unit === 'u4-web-ui' && r.path.endsWith('review-01.md')).verdict === 'NOT-READY')
})

test('질문: 진행 중인 작업의 열린 질문', async () => {
  const d = await load('todo-web-app')
  const req = d.questions.find((f) => f.stage === 'requirements-analysis')
  assert.equal(req.open, req.questions.length)
  assert.ok(req.questions.length >= 1 && req.questions[0].options.length >= 2)
  const intent = d.questions.find((f) => f.stage === 'intent-capture')
  assert.equal(intent.open, 0)
  const s = build({ folder: 'demo', ...d })
  assert.equal(s.current.slug, 'requirements-analysis')
  assert.equal(s.runStatus, 'Running')
  assert.equal(s.questions.open, req.questions.length)
  assert.equal(s.waiting.length, 0)
})

test('요약: 끝난 작업은 기다리는 승인이 없고 다음 단계가 없다', async () => {
  const s = build({ folder: 'demo', ...(await load('voice-parking')) })
  assert.equal(s.waiting.length, 0)
  assert.equal(s.next, null)
  assert.equal(s.units.length, 5)
  assert.ok(s.quality.reviews.length >= 2)
  assert.equal(s.quality.sensorFailures.length, 7)
})

test('panel.aidlc 경로: /api/aidlc 아래 읽기 경로만', () => {
  assert.equal(aidlcApiPath('demo/intents/default/voice-parking/summary'), '/aidlc/demo/intents/default/voice-parking/summary')
  assert.equal(aidlcApiPath('demo/intents/default/x/timeline?limit=400'), '/aidlc/demo/intents/default/x/timeline?limit=400')
  for (const bad of ['../panels', 'demo/../../panels/1', 'demo/%2e%2e/x', 'demo%2fx', 'http://evil', '/abs', 'a b', 'demo/./x', '..']) {
    assert.throws(() => aidlcApiPath(bad), /not allowed/, bad)
  }
})

test('프리셋 패널: 여섯 개 모두 실제 요약으로 그려진다', async () => {
  const d = await load('voice-parking')
  const summary = build({ folder: 'demo', ...d })
  const timeline = M.timeline(d.events, { limit: 400 })
  const questions = (await load('todo-web-app')).questions.map((f) => ({ ...f, stageName: f.stage, role: '' }))
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  assert.equal(PRESETS.length, 6)
  for (const p of PRESETS) {
    const spec = presetSpec(p.kind, { folder: 'demo', space: 'default', slug: 'voice-parking' })
    const els = {}
    const $ = (sel) => (els[sel] ??= { textContent: '', innerHTML: '' })
    const panel = {
      data: spec.data,
      aidlc: async (pth) => {
        assert.ok(aidlcApiPath(pth))
        return pth.endsWith('/summary') ? summary : pth.includes('/timeline') ? timeline : questions
      },
    }
    const ui = { ago: () => '방금' }
    const document = { body: { innerHTML: '' } }
    const timers = []
    await new AsyncFunction('$', 'panel', 'ui', 'document', 'setInterval', spec.spec.script)($, panel, ui, document, (fn, ms) => timers.push(ms))
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(timers, [20000], `${p.kind} refreshes every 20 s`)
    assert.equal(document.body.innerHTML, '', `${p.kind} failed: ${document.body.innerHTML}`)
    const html = Object.values(els).map((e) => e.innerHTML + e.textContent).join('')
    assert.ok(html.length > 20, `${p.kind} drew nothing`)
    // ids used in the script exist in the html
    for (const id of new Set([...spec.spec.script.matchAll(/\$\('#([a-z0-9]+)'\)/g)].map((m) => m[1]))) assert.match(spec.spec.html, new RegExp(`id="${id}"`), `${p.kind} #${id}`)
    // the project line is its first sentence, not cut inside a word
    if (p.kind === 'status') assert.match(els['#proj'].textContent, /VoiceParking 프로토타입을 만들어 줘\. · classic$/)
  }
  // the first load failing says why (a refresh failing later keeps the last view)
  const s = presetSpec('status', { folder: 'demo', space: 'default', slug: 'voice-parking' })
  const document = { body: { innerHTML: '' } }
  await new AsyncFunction('$', 'panel', 'ui', 'document', 'setInterval', s.spec.script)(() => ({}), { data: s.data, aidlc: async () => { throw new Error('403 not a member') } }, {}, document, () => 0)
  await new Promise((r) => setTimeout(r, 30))
  assert.match(document.body.innerHTML, /불러오지 못했어요.*403 not a member/)
  const q = presetSpec('questions', { folder: 'demo', space: 'default', slug: 'todo-web-app' })
  assert.equal(q.data.slug, 'todo-web-app')
  assert.throws(() => presetSpec('nope', { folder: 'a', space: 'b', slug: 'c' }), /unknown/)
})

// judgement cases (aidlc-cases.json): what a panel script may reach, and what names may become paths
const CASES = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'aidlc-cases.json'), 'utf8'))
test('사례: panel.aidlc 경로', () => {
  for (const c of CASES.panelPath) {
    if (c.ok) assert.equal(aidlcApiPath(c.path), `/aidlc/${c.path}`, c.why)
    else assert.throws(() => aidlcApiPath(c.path), /not allowed/, `${c.path} (${c.why})`)
  }
  assert.equal(CASES.panelPath.length, CASES.panelPath.filter((c) => c.ok).length + CASES.panelPath.filter((c) => !c.ok).length)
})
test('사례: 기록 이름', () => {
  for (const c of CASES.recordName) {
    if (c.ok) assert.equal(R.safeName(c.name), c.name)
    else assert.throws(() => R.safeName(c.name), /bad name/, c.name)
  }
})
