// 지도에서 바로 도는 건의 흐름도 BPMN(lib/ontology/casebpmn.js): 지도를 건의 시작 일부터 펼쳐 볼 때마다 만든다(저장 없음). 한 줄 흐름 · XOR 갈림(조건) ·
// AND 갈림과 합류 · 요청 접수 없음 · 역할마다 레인 · 상태의 id 가 XML 에 있음 · 맡은 사람 이름이 레인 이름에 · 중간 시작 · 지도에 없는 길 · 되감기.
// 모델 · DB 없이 손으로 만든 지도(view)로 — ontology-mapengine.test.js 와 같은 모양.
import test from 'node:test'
import assert from 'node:assert/strict'
import { caseBpmn, caseContract, createBpmnXml, laneLabel } from '../lib/ontology/casebpmn.js'
import { flowGraph } from '../lib/ontology/mapengine.js'
import { actId } from '../lib/ontology/run.js'
import { END } from '../lib/ontology/stats.js'

const task = (key, x = {}) => [key, { key, role: '담당', status: 'active', ...x }]
const view = (tasks, edges, proc = {}) => ({ proc: { key: 'p', name: '시험', theta: 0.05, entries: [tasks[0]?.[0] ?? tasks[0]], ...proc }, tasks: new Map(tasks.map((t) => (Array.isArray(t) ? t : task(t)))), edges })
const e = (from, to, p, x = {}) => ({ from, to, p, n: Math.round(p * 10), status: 'active', ...x })

// well-formed: a strict XML parser (saxes, the server's own through exceljs) when there is one, else tags in balance and nothing unescaped
async function wellFormed(xml) {
  const S = await import('saxes').catch(() => null)
  if (S?.SaxesParser) {
    const p = new S.SaxesParser({ xmlns: true })
    let error = null
    p.on('error', (x) => { error ||= x })
    p.write(xml).close()
    assert.equal(error, null, `XML 이 올바르지 않아요: ${error?.message}`)
    return
  }
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '')
  const stack = []
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g)) {
    if (m[5] != null) { assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(m[5]), `풀린 & : ${m[5]}`); continue }
    if (m[1]) assert.equal(stack.pop(), m[2])
    else if (!m[4]) stack.push(m[2])
  }
  assert.equal(stack.length, 0)
}
// bpmn-js's own reader (bpmn-moddle, the app's) when it is installed: the diagram imports with no warnings but the original's own attributes
async function readsAsBpmn(xml) {
  const M = await import('bpmn-moddle').catch(() => null)
  if (!M) return null
  const { rootElement, warnings } = await new (M.BpmnModdle || M.default)().fromXML(xml)
  assert.deepEqual(warnings.map((w) => w.message).filter((m) => !/unknown attribute <(megaProcessId|majorProcessId)>/.test(m)), [])
  return rootElement
}
const ofType = (xml, tag) => [...xml.matchAll(new RegExp(`<bpmn:${tag} ([^>]*?)/?>`, 'g'))].map((m) => Object.fromEntries([...m[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])))
const lanesOf = (xml) => [...xml.matchAll(/<bpmn:lane id="([^"]+)" name="([^"]*)">([\s\S]*?)<\/bpmn:lane>/g)].map((m) => ({ id: m[1], name: m[2], refs: [...m[3].matchAll(/<bpmn:flowNodeRef>([^<]+)</g)].map((r) => r[1]) }))
const flowOf = (xml, from, to) => ofType(xml, 'sequenceFlow').find((f) => f.sourceRef === from && f.targetRef === to)
async function checkXml(b) {
  for (const xml of [b.xml, b.xmlWide]) {
    await wellFormed(xml)
    await readsAsBpmn(xml)
    // every element and way the states name is in the diagram, with its shape or edge
    for (const id of Object.keys(b.states)) {
      assert.match(xml, new RegExp(`id="${id}"`), `상태의 ${id} 가 XML 에 없어요`)
      assert.match(xml, new RegExp(`bpmnElement="${id}"`), `${id} 의 그림(DI)이 없어요`)
    }
    for (const id of Object.values(b.ids)) assert.match(xml, new RegExp(`<bpmn:userTask id="${id}"`))
    // no 요청 접수 step: a map case's request is on its row
    assert.ok(!/id="intake"|name="요청 접수"/.test(xml))
  }
}

test('한 줄 흐름: 시작 이벤트가 바로 시작 일로 · 일마다 userTask · 끝 · 상태(끝남 · 하는 중 · 다음)', async () => {
  const v = view([task('접수', { role: '영업' }), task('검토', { role: '영업' }), task('회신', { role: '영업' })], [e('접수', '검토', 1), e('검토', '회신', 1), e('회신', END, 1)])
  const rows = [{ task: '접수', show: 'done', via: { how: 'entry' } }, { task: '검토', show: 'running', via: { how: 'single', from: '접수' } }]
  const b = caseBpmn(v, { entry: '접수', rows })
  await checkXml(b)
  assert.deepEqual(ofType(b.xml, 'userTask').map((t) => t.name), ['접수', '검토', '회신'])
  assert.equal(ofType(b.xml, 'startEvent').length, 1)
  assert.equal(ofType(b.xml, 'endEvent').length, 1)
  assert.equal(ofType(b.xml, 'exclusiveGateway').length + ofType(b.xml, 'parallelGateway').length, 0)
  assert.ok(flowOf(b.xml, 'start', actId('접수')))
  assert.ok(flowOf(b.xml, actId('회신'), 'end'))
  assert.deepEqual(b.ids, { 접수: actId('접수'), 검토: actId('검토'), 회신: actId('회신') })
  assert.equal(b.states[actId('접수')], 'done')
  assert.equal(b.states[actId('검토')], 'running')
  assert.equal(b.states[actId('회신')], 'next')
  assert.equal(b.states.start, 'done')
  // the ways the case took
  assert.equal(b.states[`SequenceFlow_start_${actId('접수')}`], 'taken')
  assert.equal(b.states[`SequenceFlow_${actId('접수')}_${actId('검토')}`], 'taken')
  assert.equal(b.states[`SequenceFlow_${actId('검토')}_${actId('회신')}`], undefined)
  // one lane, the pool top to bottom (the side panel) and left to right (a wide place)
  assert.equal(lanesOf(b.xml).length, 1)
  assert.match(b.xml, /bpmnElement="Participant" isHorizontal="false"/)
  assert.match(b.xmlWide, /bpmnElement="Participant" isHorizontal="true"/)
  // the same input makes the same XML (the screen imports again only when it changes)
  assert.equal(caseBpmn(v, { entry: '접수', rows: [...rows, { task: '회신', show: 'person', via: { how: 'single', from: '검토' } }] }).xml, b.xml)
})

test('XOR 갈림: 갈래가 둘이면 배타 게이트웨이 · 배운 금액 조건과 글 조건은 연결의 조건 · 없으면 비율', async () => {
  const info = { attr: 'amount', threshold: 10_000_000 }
  const v = view([task('견적', { role: '영업' }), task('재무 검토', { role: '재무' }), task('발송', { role: '영업' })], [
    e('견적', '재무 검토', 0.3, { cond: '금액(amount)이 10,000,000원 이상', cond_cases: info }),
    e('견적', '발송', 0.7, { cond: '금액(amount)이 10,000,000원 미만', cond_cases: info }),
    e('재무 검토', '발송', 1), e('발송', END, 1),
  ])
  const b = caseBpmn(v, { entry: '견적', rows: [{ task: '견적', show: 'done', via: { how: 'entry' } }, { task: '재무 검토', show: 'person', via: { how: 'amount', from: '견적' } }] })
  await checkXml(b)
  const [gw] = ofType(b.xml, 'exclusiveGateway')
  assert.equal(gw.id, `g_${actId('견적')}`)
  assert.equal(gw.name, '금액 기준')
  assert.ok(flowOf(b.xml, actId('견적'), gw.id))
  const big = flowOf(b.xml, gw.id, actId('재무 검토')), small = flowOf(b.xml, gw.id, actId('발송'))
  assert.ok(big && small)
  // the condition: on the flow's name (shortened for the narrow panel — the two ways still differ) and whole in its uengine json, as
  // Process GPT saves it
  assert.equal(big.name, '10,000,000원 이상')
  assert.equal(small.name, '10,000,000원 미만')
  assert.match(b.xml, /"condition":"금액\(amount\)이 10,000,000원 이상"/)
  assert.match(b.xml, /"condition":"금액\(amount\)이 10,000,000원 미만","priority":0,"default":true/)
  assert.equal(b.states[gw.id], 'done')
  assert.equal(b.states[`SequenceFlow_${gw.id}_${actId('재무 검토')}`], 'taken')
  assert.equal(b.states[`SequenceFlow_${gw.id}_${actId('발송')}`], undefined)
  assert.equal(b.states[actId('재무 검토')], 'person')
  // a text condition read from the split's cases (conditions.js textConditions) · a split with none: the share of past cases
  const w = view(['문의', '견적', '안내'], [e('문의', '견적', 0.6), e('문의', '안내', 0.4), e('견적', END, 1), e('안내', END, 1)])
  const t = caseBpmn(w, { entry: '문의', texts: new Map([['문의\u0000견적', '고객이 가격을 물었다'], ['문의\u0000안내', '고객이 사용법을 물었다']]) })
  await checkXml(t)
  assert.equal(flowOf(t.xml, `g_${actId('문의')}`, actId('안내')).name, '고객이 사용법을 물었다')
  const n = caseBpmn(w, { entry: '문의' })
  assert.equal(flowOf(n.xml, `g_${actId('문의')}`, actId('견적')).name, '60%')
  assert.equal(ofType(n.xml, 'exclusiveGateway')[0].name, '')
})

test('AND 갈림: 나란히 하는 두 일은 병렬 게이트웨이로 갈라 합류 뒤 다음 일 — 둘 사이 연결은 없다(스냅샷과 같다)', async () => {
  const v = view(['준비', '계획서', '보고', '회신'], [
    e('준비', '계획서', 0.5), e('준비', '보고', 0.5), e('계획서', '보고', 0.4, { parallel: true }), e('계획서', '회신', 0.6), e('보고', '회신', 0.7), e('회신', END, 1),
  ])
  const rows = [{ task: '준비', show: 'done', via: { how: 'entry' } },
    { task: '계획서', show: 'done', via: { how: 'parallel', from: '준비' } }, { task: '보고', show: 'done', via: { how: 'parallel', from: '준비' } },
    { task: '회신', show: 'running', via: { how: 'join', from: '보고', after: ['계획서', '보고'] } }]
  const b = caseBpmn(v, { entry: '준비', rows })
  await checkXml(b)
  const g = `g_and_${actId('준비')}`, j = `j_and_${actId('준비')}`
  assert.deepEqual(ofType(b.xml, 'parallelGateway').map((x) => x.id).sort(), [g, j].sort())
  for (const s of ['계획서', '보고']) {
    assert.ok(flowOf(b.xml, g, actId(s)))
    assert.ok(flowOf(b.xml, actId(s), j))
    assert.equal(b.states[`SequenceFlow_${g}_${actId(s)}`], 'taken')
    assert.equal(b.states[`SequenceFlow_${actId(s)}_${j}`], 'taken')
  }
  assert.ok(flowOf(b.xml, actId('준비'), g))
  assert.ok(flowOf(b.xml, j, actId('회신')))
  assert.ok(!flowOf(b.xml, actId('계획서'), actId('보고')))
  assert.ok(!flowOf(b.xml, actId('계획서'), actId('회신')))
  assert.equal(b.states[g], 'done')
  assert.equal(b.states[j], 'done')
  assert.equal(b.states[`SequenceFlow_${j}_${actId('회신')}`], 'taken')
  // each gateway sits in a lane (the split with the step before it, the join with the step after it)
  const refs = lanesOf(b.xml).flatMap((l) => l.refs)
  for (const id of [g, j, 'start', 'end', ...Object.values(b.ids)]) assert.ok(refs.includes(id), `${id} 가 어느 레인에도 없어요`)
})

test('AND 의 한쪽 일에서 시작한 건: 그 일은 합류에서 멈추지 않고 제 길로 간다(지도 엔진처럼)', async () => {
  const v = view(['준비', '계획서', '보고', '회신'], [
    e('준비', '계획서', 0.5), e('준비', '보고', 0.5), e('계획서', '보고', 0.4, { parallel: true }), e('계획서', '회신', 0.6), e('보고', '회신', 0.7),
    e('회신', '준비', 0.3), e('회신', END, 0.7),
  ])
  const b = caseBpmn(v, { entry: '계획서', rows: [{ task: '계획서', show: 'running', via: { how: 'entry' } }] })
  await checkXml(b)
  const gx = `g_${actId('계획서')}`
  assert.ok(flowOf(b.xml, actId('계획서'), gx), '시작 일 다음에 갈림길이 있어요')
  assert.ok(flowOf(b.xml, gx, actId('회신')) && flowOf(b.xml, gx, actId('보고')))
  assert.ok(flowOf(b.xml, actId('보고'), actId('회신')))
  assert.deepEqual(Object.keys(b.ids).sort(), ['계획서', '보고', '준비', '회신'].sort())
  // and the AND split later in the flow still waits for both
  assert.ok(flowOf(b.xml, `g_and_${actId('준비')}`, actId('계획서')) && flowOf(b.xml, actId('계획서'), `j_and_${actId('준비')}`))
})

test('레인: 역할마다 하나(에이전트가 하는 일은 「업무 에이전트」) · 건이 정한 사람 이름은 「역할 · 이름」 · bindings 가 없어도 된다', async () => {
  const agent = '---\nrunner: agent\nskills: [doc-draft]\n---\n초안을 쓴다'
  const v = view([task('접수', { role: '영업' }), task('초안', { role: '영업', definition_md: agent }), task('승인', { role: '재무' })], [e('접수', '초안', 1), e('초안', '승인', 1), e('승인', END, 1)])
  const bindings = [{ role: '영업', userId: 'u1', name: '김민지', from: 'settings' }, { role: '재무', userId: null, name: null, from: 'none' }, { role: '없는 역할', userId: 'u9', name: '아무개', from: 'picked' }]
  const b = caseBpmn(v, { entry: '접수', bindings })
  await checkXml(b)
  const lanes = lanesOf(b.xml)
  assert.deepEqual(lanes.map((l) => l.name), ['영업 · 김민지', '업무 에이전트', '재무'])
  assert.ok(lanes[0].refs.includes(actId('접수')))
  assert.ok(lanes[1].refs.includes(actId('초안')))
  assert.ok(lanes[2].refs.includes(actId('승인')))
  assert.match(b.xml, /<bpmn:lane id="Lane_0" name="영업 · 김민지">/)
  for (const none of [null, undefined, 'x', {}]) assert.deepEqual(lanesOf(caseBpmn(v, { entry: '접수', bindings: none }).xml).map((l) => l.name), ['영업', '업무 에이전트', '재무'])
  assert.equal(laneLabel(' 영업 ', [{ role: '영업', name: '김민지' }, { role: '영업', name: '이서연' }]), ' 영업  · 이서연')
  // a lane per role: a DI shape per lane
  for (const l of lanes) assert.match(b.xml, new RegExp(`bpmnElement="${l.id}"`))
})

test('중간 시작 · 지도에 없는 길 · 되감기: 건너뛴 일은 시작 앞에, 건이 간 길은 그대로 그린다', async () => {
  const v = view(['요청', '계획서', '자료', '회신'], [e('요청', '계획서', 1), e('계획서', '자료', 0.9), e('계획서', END, 0.1), e('자료', '회신', 1), e('회신', END, 1)], { entries: ['요청'] })
  const rows = [{ task: '자료', show: 'done', via: { how: 'entry' } }, { task: '회신', show: 'done', via: { how: 'single', from: '자료' } },
    { task: '자료', show: 'running', via: { how: 'rewound', from: '회신' } }]
  const b = caseBpmn(v, { entry: '자료', rows, before: ['요청', '계획서'] })
  await checkXml(b)
  // the steps passed over come first, skipped, and their ways too
  assert.deepEqual(ofType(b.xml, 'userTask').map((t) => t.name), ['요청', '계획서', '자료', '회신'])
  assert.equal(b.states[actId('요청')], 'skipped')
  assert.equal(b.states[`SequenceFlow_start_${actId('요청')}`], 'skipped')
  assert.equal(b.states[`SequenceFlow_${actId('계획서')}_${actId('자료')}`], 'skipped')
  // a rewind is a way of its own
  assert.equal(b.states[`SequenceFlow_${actId('회신')}_${actId('자료')}`], 'rewound')
  assert.equal(b.states[actId('자료')], 'running')
  // a step the case was moved to that this map does not reach from its start: drawn, joined by the way the case went
  const w = view(['A', 'B', 'C', 'D'], [e('A', 'B', 1), e('B', END, 1), e('C', 'D', 1), e('D', END, 1)])
  const m = caseBpmn(w, { entry: 'A', rows: [{ task: 'A', show: 'done', via: { how: 'entry' } }, { task: 'C', show: 'person', via: { how: 'moved', from: 'A' } }] })
  await checkXml(m)
  assert.equal(m.states[`SequenceFlow_${actId('A')}_${actId('C')}`], 'extra')
  assert.ok(m.ids.C)
  assert.ok(!m.ids.D, '건이 가지 않은, 시작에서 닿지 않는 일은 빼요')
})

test('합류 뒤로 버려진 갈래(스냅샷처럼): 시작에서 닿지 않는 섬은 건이 가지 않았으면 빠진다 · flowGraph 를 넘겨도 같다', async () => {
  // 강의계획서 작성 · 보고 (a real map's shape): two splits over the same pair, a sibling's other ways lead to an island
  const v = view(['교육', '작성', '보고', '준비', '자료'], [
    e('교육', '작성', 0.5), e('교육', '보고', 0.5), e('작성', '보고', 0.22, { parallel: true }), e('작성', '준비', 0.11, { parallel: true }), e('작성', '자료', 0.11),
    e('준비', '작성', 0.5, { parallel: true }), e('준비', '보고', 0.5), e('자료', '준비', 0.33), e('작성', END, 0.45), e('보고', END, 0.26), e('자료', END, 0.67), e('교육', END, 0.5),
  ])
  const rows = [{ task: '교육', show: 'done', via: { how: 'entry' } }]
  const graph = flowGraph(v, { entry: '교육', rows })
  const b = caseBpmn(v, { entry: '교육', rows, graph })
  await checkXml(b)
  assert.deepEqual(Object.keys(b.ids).sort(), ['교육', '보고', '작성'].sort())
  // one split and its own join only (the island's split is gone, and so is its join)
  assert.deepEqual(ofType(b.xml, 'parallelGateway').map((x) => x.id).sort(), [`g_and_${actId('교육')}`, `j_and_${actId('교육')}`].sort())
  assert.deepEqual(caseBpmn(v, { entry: '교육', rows }).xml, b.xml)
  // the contract on its own: elements and ways, as Process GPT's generation contract has them
  const { processDefinition: pd } = caseContract(v, { entry: '교육', rows })
  assert.ok(pd.elements.every((x) => ['Event', 'Activity', 'Gateway', 'Sequence'].includes(x.elementType)))
  assert.ok(pd.roles.length >= 1)
})

test('XML 변환(createBpmnXml): 이름의 특수 문자는 이스케이프 · XML 이 담지 못하는 문자는 뺀다 · 끝으로 가는 길이 없으면 잇는다', async () => {
  const xml = createBpmnXml({ processDefinitionId: 'x', processDefinitionName: '견적 <긴급> & "확인"', roles: [{ name: 'R&D' }], elements: [
    { elementType: 'Event', id: 'start', name: '시작', role: 'R&D', type: 'StartEvent' },
    { elementType: 'Activity', id: 'a', name: 'A & B <1>\u0007', role: 'R&D', type: 'UserActivity', description: '설명 "따옴표"' },
    { elementType: 'Event', id: 'end', name: '끝', role: 'R&D', type: 'EndEvent' },
    { elementType: 'Sequence', id: 's1', source: 'start', target: 'a', condition: '' },
  ] }, false)
  await wellFormed(xml)
  await readsAsBpmn(xml)
  assert.match(xml, /name="A &amp; B &lt;1&gt;"/)
  assert.match(xml, /name="R&amp;D"/)
  // _ensure_start_end_connectivity: the end gets the last step that leads nowhere
  assert.match(xml, /<bpmn:sequenceFlow id="SequenceFlow_a_end" sourceRef="a" targetRef="end"\/>/)
})
