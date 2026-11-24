// BPMN 흐름도의 화살촉 — 흐름마다 끝에 화살촉이 보인다(밝은 · 밤 테마). 사용자 보고(2026-11-25, 인스턴스 화면의 다이어그램 · 밤 테마):
// 「마커 촉이 어디로 날라갔니?」 — 흐름이 모두 촉 없는 선으로 보였다.
// 까닭: bpmn-js 는 흐름마다 화살촉(<marker>)을 그 흐름의 그림 안 <defs> 에 자기 기본색(거의 검정 hsl(225,10%,15%))으로 그린다. 화면의
// 테마 CSS(BpmnView · HeatBpmn)는 선(.djs-visual > path)만 칠해서, 밤 테마의 어두운 칸에서는 검은 촉이 보이지 않았다. 이제 bpmn-js 의 기본색이
// CSS 변수(src/lib/bpmnInk.js)라 촉이 그 흐름의 선과 같은 잉크로, 테마가 바뀌면 바로 따라간다.
//   F-BA-01 정의가 있는 인스턴스(담당자 · 고객 · 프로젝트 관리 · 주임 레인, 「… 다음」 배타 갈림, 병렬 갈림, 끝): 밝은 테마와 밤 테마에서
//           모든 순서 흐름의 marker-end 가 같은 문서의 <marker> 하나를 가리키고, 그 촉이 선과 같은 잉크(밝은 화면엔 어둡게, 밤엔 밝게)
//   F-BA-02 메시지 흐름(시작 동그라미 · 끝 화살촉) · 연관(방향) · 데이터 연관 · 조건 흐름 · 기본 흐름: 촉이 모두 보임, 두 테마
//   F-BA-03 지도에서 바로 도는 건(OntoCaseFlow → BpmnView): 건이 간 굵은 선의 촉도 그 선의 잉크, 「크게 보기」에서도
//   F-BA-04 프로세스 개선의 크리티컬 패스(HeatBpmn): 주황 선의 촉은 주황, 나머지 흐름의 촉도 보임
// 스택은 따로 띄운다(lib/localStack.js: 테넌트 bpmnarrow-ui 의 BFF 와 Vite, 8910 · 5310 부터 빈 포트). 모델 · 공유 서비스 없음. 사람은 지어낸 이름.
//   cd e2e && npx playwright test --project=feature tests/feature/bpmn-arrowheads.spec.js
// 스펙 openspec/specs/map-case-view 「흐름도의 흐름은 화살촉으로 끝난다」
import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { startStack, REPO, SERVER } from '../../lib/localStack.js'

const TENANT = 'bpmnarrow-ui'
test.describe.configure({ mode: 'serial' })
const SHOTS = process.env.BA_SHOTS || path.join(REPO, 'openspec/specs/map-case-view/e2e/results')
const DESK = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
const RUN = crypto.randomBytes(3).toString('hex')
const actId = (task) => `t_${crypto.createHash('sha1').update(String(task)).digest('hex').slice(0, 10)}`
const lib = (rel) => import(path.join(SERVER, rel))
let S, ME

async function page(browser, who, { theme = 'light' } = {}) {
  const ctx = await browser.newContext({ ...DESK, baseURL: S.web })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const calm = (p) => p.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 3000)),
]))
const shot = async (p, name, loc) => {
  await calm(p)
  fs.mkdirSync(SHOTS, { recursive: true })
  await loc.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}
// the app's own theme switch (stores/sky.js applyTheme — the sky flips it at dusk without a reload)
const setTheme = async (p, t) => { await p.evaluate((x) => { document.documentElement.dataset.theme = x }, t); await p.waitForTimeout(300) }

// Every flow in the diagram under `scope`: its line's ink and each end it has (marker-start · marker-end) — the <marker> it points to in this
// document (how many elements carry that id, is it a <marker> in the same <svg>) and the ink the head is painted with.
function readHeads(p, scope) {
  return p.evaluate((sel) => {
    const rgba = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c || '')
      if (!m) return null
      const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      return { r, g, b, a, lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 }
    }
    const out = []
    for (const root of document.querySelectorAll(sel)) {
      for (const g of root.querySelectorAll('.djs-connection')) {
        const line = g.querySelector('.djs-visual > path')
        if (!line) continue
        const ls = getComputedStyle(line)
        const end = (prop) => {
          const v = ls.getPropertyValue(prop)
          const ref = /url\(\s*["']?#([^"')]+)["']?\s*\)/.exec(v)?.[1]
          if (!ref) return { ref: null, raw: v }
          const all = document.querySelectorAll(`[id="${CSS.escape(ref)}"]`)
          const mk = all[0]
          const head = mk?.firstElementChild
          const hs = head && getComputedStyle(head)
          return { ref, count: all.length, tag: mk?.tagName, sameSvg: !!mk && mk.ownerSVGElement === line.ownerSVGElement,
            fill: hs?.fill, stroke: hs?.stroke, fillC: rgba(hs?.fill), strokeC: rgba(hs?.stroke), opacity: hs ? Number(hs.opacity) : null }
        }
        out.push({ id: g.dataset.elementId, cls: g.getAttribute('class'), line: ls.stroke, lineC: rgba(ls.stroke), start: end('marker-start'), end: end('marker-end') })
      }
    }
    return out
  }, scope)
}
// a head a person can see: one <marker> with that id in the same drawing, painted (not none · not transparent); a grey ink is light on the
// dark theme and dark on the light one (a state's colour — the critical path's orange — is checked against its line instead)
const grey = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 24
const sunk = (c, theme) => grey(c) && (theme === 'dark' ? c.lum < 0.5 : c.lum > 0.5)
function visibleHead(h, theme, { filled = true } = {}) {
  const why = []
  if (!h?.ref) return [`끝 표시가 없음(${h?.raw})`]
  if (h.count !== 1) why.push(`id ${h.ref} 가 ${h.count}개`)
  if (h.tag !== 'marker') why.push(`${h.ref} 는 <marker> 가 아님(${h.tag})`)
  if (!h.sameSvg) why.push('다른 그림의 marker')
  const ink = h.strokeC
  if (!ink || ink.a < 0.15) why.push(`촉의 선이 보이지 않음(${h.stroke})`)
  else if (sunk(ink, theme)) why.push(`촉의 잉크 ${h.stroke} 가 ${theme} 테마의 바탕에 묻힘`)
  if (filled) {
    const f = h.fillC
    if (!f || f.a < 0.15) why.push(`촉이 칠해지지 않음(${h.fill})`)
    else if (sunk(f, theme)) why.push(`촉의 칠 ${h.fill} 가 ${theme} 테마의 바탕에 묻힘`)
  }
  return why
}
// the head is its line's ink (the same colour), at least as strong (a faint line's head is a step stronger)
const inkOfLine = (head, line) => !!head && !!line && head.r === line.r && head.g === line.g && head.b === line.b && head.a >= line.a - 0.02
// each sequence flow ends in a visible head of its own line's ink
function expectSequenceHeads(flows, theme, what) {
  const seq = flows.filter((f) => /^(SequenceFlow|seq_|s_)/.test(f.id))
  expect(seq.length, `${what}: 순서 흐름이 그려짐`).toBeGreaterThan(3)
  const bad = []
  for (const f of seq) {
    const why = visibleHead(f.end, theme)
    if (f.end?.ref && !inkOfLine(f.end.strokeC, f.lineC)) why.push(`촉 ${f.end.stroke} ≠ 선 ${f.line}`)
    if (why.length) bad.push(`${f.id}: ${why.join(' · ')}`)
  }
  // (soft: both themes are read and pictured before the test fails)
  expect.soft(bad, `${what} (${theme}) — 화살촉 없는 흐름`).toEqual([])
  return seq.length
}

// ---- a definition like the one the user looked at: lanes 담당자 · 고객 · 프로젝트 관리 · 주임, XOR gateways 「… 다음」, a parallel split and join, 끝
const ROLES = ['담당자', '고객', '프로젝트 관리', '주임']
function contractModel(defId) {
  const A = (id, name, role) => ({ elementType: 'Activity', id, name, role, type: 'UserActivity' })
  const X = (id, name, role) => ({ elementType: 'Gateway', id, name, role, type: 'ExclusiveGateway', gateWayType: 'bpmn:exclusiveGateway' })
  const P = (id, role) => ({ elementType: 'Gateway', id, name: '', role, type: 'ParallelGateway', gateWayType: 'bpmn:parallelGateway' })
  const F = (source, target, condition = '') => ({ elementType: 'Sequence', id: `s_${source}_${target}`, source, target, condition })
  return {
    processDefinitionId: defId, processDefinitionName: `계약 요청 처리 ${RUN}`,
    roles: ROLES.map((name) => ({ name, endpoint: '' })),
    elements: [
      { elementType: 'Event', id: 'start', name: '요청 도착', role: '담당자', type: 'StartEvent' },
      A('a_req', '요청 접수', '담당자'), X('g_req', '요청 접수 다음', '담당자'),
      A('a_need', '요구 사항 확인', '고객'), A('a_scope', '범위 검토', '프로젝트 관리'), P('g_par', '프로젝트 관리'),
      A('a_draft', '계약서 초안 작성', '주임'), A('a_plan', '일정 계획', '프로젝트 관리'), P('g_join', '프로젝트 관리'),
      A('a_review', '계약 검토', '고객'), X('g_rev', '계약 검토 다음', '고객'), A('a_sign', '계약 체결', '담당자'),
      { elementType: 'Event', id: 'end', name: '끝', role: '담당자', type: 'EndEvent' },
      F('start', 'a_req'), F('a_req', 'g_req'), F('g_req', 'a_need', '추가 확인 필요'), F('g_req', 'a_scope', '바로 진행'), F('a_need', 'a_scope'),
      F('a_scope', 'g_par'), F('g_par', 'a_draft'), F('g_par', 'a_plan'), F('a_draft', 'g_join'), F('a_plan', 'g_join'), F('g_join', 'a_review'),
      F('a_review', 'g_rev'), F('g_rev', 'a_draft', '고칠 곳 있음'), F('g_rev', 'a_sign', '승인'), F('a_sign', 'end'),
    ],
  }
}
const definitionJson = (pd) => {
  const els = (t) => pd.elements.filter((e) => e.elementType === t)
  return {
    processDefinitionId: pd.processDefinitionId, processDefinitionName: pd.processDefinitionName, roles: pd.roles,
    activities: els('Activity').map((e) => ({ id: e.id, name: e.name, type: 'userTask', role: e.role, agentMode: 'none' })),
    gateways: els('Gateway').map((e) => ({ id: e.id, name: e.name, type: e.type === 'ParallelGateway' ? 'parallelGateway' : 'exclusiveGateway' })),
    events: els('Event').map((e) => ({ id: e.id, name: e.name, type: e.type === 'StartEvent' ? 'startEvent' : 'endEvent' })),
    sequences: els('Sequence').map((e) => ({ id: e.id, source: e.source, target: e.target })),
  }
}

// ---- every other kind of end bpmn-js draws: a message flow (circle at its start, open head at its end), a directed association, a data
// association, a conditional flow out of a task (diamond at its start), a gateway's default flow (slash at its start)
const MIXED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="Defs_mixed" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="Collaboration_1">
    <bpmn:participant id="Participant_1" name="우리 회사" processRef="Process_1" />
    <bpmn:participant id="Participant_2" name="고객사" />
    <bpmn:messageFlow id="MessageFlow_send" sourceRef="Task_send" targetRef="Participant_2" />
    <bpmn:messageFlow id="MessageFlow_reply" sourceRef="Participant_2" targetRef="Task_ready" />
  </bpmn:collaboration>
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="Start_1" name="요청 도착"><bpmn:outgoing>SequenceFlow_1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:userTask id="Task_quote" name="견적 작성"><bpmn:incoming>SequenceFlow_1</bpmn:incoming><bpmn:outgoing>SequenceFlow_2</bpmn:outgoing>
      <bpmn:dataOutputAssociation id="DataOutputAssociation_1"><bpmn:targetRef>Data_1</bpmn:targetRef></bpmn:dataOutputAssociation></bpmn:userTask>
    <bpmn:dataObjectReference id="Data_1" name="견적서" dataObjectRef="DataObject_1" />
    <bpmn:dataObject id="DataObject_1" />
    <bpmn:userTask id="Task_send" name="견적 보내기"><bpmn:incoming>SequenceFlow_2</bpmn:incoming><bpmn:outgoing>SequenceFlow_3</bpmn:outgoing></bpmn:userTask>
    <bpmn:exclusiveGateway id="Gateway_1" name="회신 다음" default="SequenceFlow_4"><bpmn:incoming>SequenceFlow_3</bpmn:incoming><bpmn:outgoing>SequenceFlow_4</bpmn:outgoing><bpmn:outgoing>SequenceFlow_5</bpmn:outgoing></bpmn:exclusiveGateway>
    <bpmn:userTask id="Task_ready" name="계약 준비"><bpmn:incoming>SequenceFlow_4</bpmn:incoming><bpmn:outgoing>SequenceFlow_6</bpmn:outgoing></bpmn:userTask>
    <bpmn:userTask id="Task_again" name="다시 견적"><bpmn:incoming>SequenceFlow_5</bpmn:incoming><bpmn:outgoing>SequenceFlow_7</bpmn:outgoing></bpmn:userTask>
    <bpmn:endEvent id="End_1" name="끝"><bpmn:incoming>SequenceFlow_6</bpmn:incoming><bpmn:incoming>SequenceFlow_7</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="SequenceFlow_1" sourceRef="Start_1" targetRef="Task_quote" />
    <bpmn:sequenceFlow id="SequenceFlow_2" name="금액 확정" sourceRef="Task_quote" targetRef="Task_send"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">amount &gt; 0</bpmn:conditionExpression></bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="SequenceFlow_3" sourceRef="Task_send" targetRef="Gateway_1" />
    <bpmn:sequenceFlow id="SequenceFlow_4" sourceRef="Gateway_1" targetRef="Task_ready" />
    <bpmn:sequenceFlow id="SequenceFlow_5" name="고쳐 달라" sourceRef="Gateway_1" targetRef="Task_again"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">again</bpmn:conditionExpression></bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="SequenceFlow_6" sourceRef="Task_ready" targetRef="End_1" />
    <bpmn:sequenceFlow id="SequenceFlow_7" sourceRef="Task_again" targetRef="End_1" />
    <bpmn:textAnnotation id="Note_1"><bpmn:text>고객사 담당: 가상의 담당자</bpmn:text></bpmn:textAnnotation>
    <bpmn:association id="Association_1" associationDirection="One" sourceRef="Task_send" targetRef="Note_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1">
      <bpmndi:BPMNShape id="Participant_1_di" bpmnElement="Participant_1" isHorizontal="true"><dc:Bounds x="100" y="200" width="900" height="300" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Participant_2_di" bpmnElement="Participant_2" isHorizontal="true"><dc:Bounds x="100" y="40" width="900" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1"><dc:Bounds x="160" y="332" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_quote_di" bpmnElement="Task_quote"><dc:Bounds x="240" y="310" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Data_1_di" bpmnElement="Data_1"><dc:Bounds x="272" y="420" width="36" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_send_di" bpmnElement="Task_send"><dc:Bounds x="400" y="310" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Note_1_di" bpmnElement="Note_1"><dc:Bounds x="520" y="220" width="160" height="40" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Gateway_1_di" bpmnElement="Gateway_1" isMarkerVisible="true"><dc:Bounds x="560" y="325" width="50" height="50" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_ready_di" bpmnElement="Task_ready"><dc:Bounds x="680" y="310" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_again_di" bpmnElement="Task_again"><dc:Bounds x="680" y="410" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="End_1_di" bpmnElement="End_1"><dc:Bounds x="862" y="332" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="SequenceFlow_1_di" bpmnElement="SequenceFlow_1"><di:waypoint x="196" y="350" /><di:waypoint x="240" y="350" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="SequenceFlow_2_di" bpmnElement="SequenceFlow_2"><di:waypoint x="340" y="350" /><di:waypoint x="400" y="350" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="SequenceFlow_3_di" bpmnElement="SequenceFlow_3"><di:waypoint x="500" y="350" /><di:waypoint x="560" y="350" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="SequenceFlow_4_di" bpmnElement="SequenceFlow_4"><di:waypoint x="610" y="350" /><di:waypoint x="680" y="350" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="SequenceFlow_5_di" bpmnElement="SequenceFlow_5"><di:waypoint x="585" y="375" /><di:waypoint x="585" y="450" /><di:waypoint x="680" y="450" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="SequenceFlow_6_di" bpmnElement="SequenceFlow_6"><di:waypoint x="780" y="350" /><di:waypoint x="862" y="350" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="SequenceFlow_7_di" bpmnElement="SequenceFlow_7"><di:waypoint x="780" y="450" /><di:waypoint x="880" y="450" /><di:waypoint x="880" y="368" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="DataOutputAssociation_1_di" bpmnElement="DataOutputAssociation_1"><di:waypoint x="290" y="390" /><di:waypoint x="290" y="420" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Association_1_di" bpmnElement="Association_1"><di:waypoint x="490" y="310" /><di:waypoint x="540" y="260" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="MessageFlow_send_di" bpmnElement="MessageFlow_send"><di:waypoint x="450" y="310" /><di:waypoint x="450" y="120" /></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="MessageFlow_reply_di" bpmnElement="MessageFlow_reply"><di:waypoint x="730" y="120" /><di:waypoint x="730" y="310" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`

// a classic instance of a definition (its own BPMN), the first steps done
async function seedClassic(name, xml, definition, done = []) {
  const def = `rt_ba_${RUN}_${crypto.randomBytes(2).toString('hex')}`
  const inst = `${def}.${crypto.randomUUID()}`
  await S.q(`insert into proc_def (id, name, definition, bpmn, type, tenant_id, owner, isdeleted) values ($1,$2,$3,$4,'bpmn',$5,$6,false)`,
    [def, name, { ...definition, processDefinitionId: def }, xml, S.tenant, ME.id])
  await S.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, tenant_id, status, start_date, participants, current_activity_ids, updated_at)
             values ($1,$2,$3,$4,'RUNNING',now() - interval '1 hour',$5,$6,now())`, [inst, `${name} · 가상 고객`, def, S.tenant, [ME.id], []])
  let i = 0
  for (const [id, label] of done) {
    await S.q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, proc_def_id, activity_id, activity_name, status, start_date, end_date)
               values (gen_random_uuid(),$1,$2,$3,$3,$4,$5,$6,'DONE', now() - make_interval(mins => $7), now() - make_interval(mins => $8))`,
    [S.tenant, ME.id, inst, def, id, label, 50 - i * 10, 45 - i * 10])
    i++
  }
  return { def, inst }
}
async function openDiagram(p, inst) {
  await p.goto(`/routines/${encodeURIComponent(inst)}`)
  const card = p.locator('[data-test="instance-card"]')
  await expect(card).toBeVisible({ timeout: 20000 })
  await card.locator('.seg button[data-view="bpmn"]').click()
  await expect(card.locator('.bpmn').first()).toHaveAttribute('data-ready', '1', { timeout: 30000 })
  await expect(card.locator('.djs-connection').first()).toBeAttached()
  return card
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  S = await startStack({ tenant: TENANT, apiFrom: 8910, webFrom: 5310, env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE } })
  ME = await S.person('pro-rt-bpmnarrow-ui-h@uengine.org', '정하윤')
  await S.join(ME)
})
const cleanups = []
test.afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch((e) => console.warn('[cleanup]', e.message))
  if (S) {
    await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [ME?.id]).catch(() => {})
    await S.q(`delete from pro_threads where user_id=$1 and kind='process'`, [ME?.id]).catch(() => {})
    await S.stop()
  }
})

test('F-BA-01 정의가 있는 인스턴스의 다이어그램: 모든 순서 흐름이 화살촉으로 끝난다 — 밝은 테마와 밤 테마(테마를 바꾸면 바로)', async ({ browser }) => {
  const CB = await lib('lib/ontology/casebpmn.js')
  const pd = contractModel('rt_ba_contract')
  const k = await seedClassic(pd.processDefinitionName, CB.createBpmnXml(pd, true), definitionJson(pd), [['a_req', '요청 접수'], ['a_need', '요구 사항 확인']])
  const p = await page(browser, ME, { theme: 'light' })
  const card = await openDiagram(p, k.inst)
  // (the steps are painted: the diagram is the instance's)
  await expect(card.locator('.djs-element[data-element-id="a_req"]')).toHaveClass(/st-done/, { timeout: 20000 })
  const counts = {}
  for (const theme of ['light', 'dark']) {
    await setTheme(p, theme)
    await shot(p, `f-ba-01-${theme}`, card)
    counts[theme] = expectSequenceHeads(await readHeads(p, '[data-test="instance-card"]'), theme, '정의의 BPMN')
  }
  expect(counts.dark).toBe(counts.light)
  expect(counts.light, '정의의 순서 흐름 15개').toBe(15)
  // the same diagram opened straight in the dark theme (the stored preference — not a switch after drawing)
  const d = await page(browser, ME, { theme: 'dark' })
  await openDiagram(d, k.inst)
  expect(await d.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  expectSequenceHeads(await readHeads(d, '[data-test="instance-card"]'), 'dark', '밤 테마로 연 정의의 BPMN')
  expect(p.errors).toEqual([])
  expect(d.errors).toEqual([])
  await p.context().close(); await d.context().close()
})

test('F-BA-02 메시지 흐름 · 연관 · 데이터 연관 · 조건 흐름 · 기본 흐름도 끝 표시가 보인다 — 두 테마', async ({ browser }) => {
  const k = await seedClassic(`견적 회신 ${RUN}`, MIXED_XML, { activities: [{ id: 'Task_quote', name: '견적 작성', type: 'userTask' }, { id: 'Task_send', name: '견적 보내기', type: 'userTask' },
    { id: 'Task_ready', name: '계약 준비', type: 'userTask' }, { id: 'Task_again', name: '다시 견적', type: 'userTask' }] }, [['Task_quote', '견적 작성']])
  const p = await page(browser, ME, { theme: 'dark' })
  const card = await openDiagram(p, k.inst)
  for (const theme of ['dark', 'light']) {
    await setTheme(p, theme)
    await shot(p, `f-ba-02-${theme}`, card)
    const flows = await readHeads(p, '[data-test="instance-card"]')
    const by = Object.fromEntries(flows.map((f) => [f.id, f]))
    expectSequenceHeads(flows, theme, '여러 흐름의 BPMN')
    const bad = []
    const need = (id, endName, opts) => { const why = visibleHead(by[id]?.[endName], theme, opts); if (why.length) bad.push(`${id} ${endName}: ${why.join(' · ')}`) }
    // a message flow: a circle at its start and a head at its end, both outlined in the line's ink (filled with the diagram's paper)
    for (const id of ['MessageFlow_send', 'MessageFlow_reply']) { need(id, 'start', { filled: false }); need(id, 'end', { filled: false }) }
    // a directed association and a data association: an open head
    need('Association_1', 'end', { filled: false })
    need('DataOutputAssociation_1', 'end', { filled: false })
    // a conditional flow out of a task: a diamond at its start; a gateway's default flow: a slash at its start
    need('SequenceFlow_2', 'start', { filled: false })
    need('SequenceFlow_4', 'start', { filled: false })
    expect.soft(bad, `끝 표시가 보이지 않는 흐름 (${theme})`).toEqual([])
  }
  expect(p.errors).toEqual([])
  await p.context().close()
})

// ---- a case run straight from the map (as mapengine.js leaves one — like map-case-view.spec.js): its flowchart from the server's own code
async function seedMapCase() {
  const { PROC, STEPS, REQUEST } = await import(path.join(SERVER, 'test/fixtures/map-case-view.mjs'))
  const instId = `onto-map.${crypto.randomUUID()}`
  const bindings = [{ role: '영업', userId: ME.id, name: ME.name, from: 'settings' }, { role: '설계', userId: ME.id, name: ME.name, from: 'settings' },
    { role: '업무 에이전트', userId: null, name: null, from: 'agent' }]
  const [c] = await S.q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, engine, request, run_mode, bindings, status)
                         values ($1,$2,'요청 검토',$3,$4,$5,'map',$6,'hitl',$7,'running') returning id::text as id`,
  [S.tenant, PROC.key, ME.id, { kind: 'mail', subject: REQUEST.subject, from: REQUEST.sender }, [instId], REQUEST, JSON.stringify(bindings)])
  cleanups.push(async () => {
    await S.q('delete from pro_step_ui where proc_inst_id=$1', [instId]).catch(() => {})
    await S.q(`delete from notifications where url in (select '/todolist/' || id::text from todolist where proc_inst_id=$1)`, [instId]).catch(() => {})
    await S.q('delete from pro_case_runs where case_id=$1', [c.id]).catch(() => {})
    await S.q('delete from pro_case_steps where case_id=$1', [c.id])
    await S.q('delete from pro_po_cases where id=$1', [c.id])
  })
  await S.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, tenant_id, status, start_date, participants, current_activity_ids, updated_at)
             values ($1,$2,null,$3,'RUNNING',now() - interval '2 hours',$4,$5,now())`, [instId, `${PROC.name} · ${REQUEST.subject}`, S.tenant, [ME.id], [actId('견적서 작성')]])
  let i = 0
  const todos = {}
  for (const s of STEPS) {
    const agent = s.kind === 'agent'
    const aid = actId(s.task), formId = `onto-map_${aid}_form`
    const done = s.status === 'DONE'
    const [t] = await S.q(`insert into todolist (id, tenant_id, user_id, username, proc_inst_id, root_proc_inst_id, activity_id, activity_name, status, tool, description,
                             agent_orch, agent_mode, output, start_date, end_date)
                           values (gen_random_uuid(),$1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() - make_interval(mins => $13), $14) returning id::text as id`,
    [S.tenant, agent ? 'pgpt-pro-onto-agent' : ME.id, agent ? '업무 에이전트' : ME.name, instId, aid, s.task, s.status, `formHandler:${formId}`, `${s.task} 단계`,
      agent ? 'pgpt-pro-onto' : null, agent ? 'COMPLETE' : null, done ? { [formId]: { result: `${s.task} 끝냈어요` } } : null, 100 - i * 20, done ? new Date(Date.now() - (90 - i * 20) * 60_000) : null])
    todos[s.task] = t.id
    const act = { id: aid, name: s.task, role: agent ? '업무 에이전트' : s.task === '현장 실측' ? '설계' : '영업', runner: agent ? 'agent' : 'person', agentMode: agent ? 'complete' : 'none' }
    await S.q(`insert into pro_case_steps (tenant_id, case_id, proc_inst_id, todo_id, task, kind, mode, state, act, via, created_at)
               values ($1,$2,$3,$4,$5,$6,'hitl','released',$7,$8, now() - make_interval(mins => $9))`,
    [S.tenant, c.id, instId, t.id, s.task, s.kind, act, s.via, 100 - i * 20])
    i++
  }
  await S.q(`insert into pro_step_ui (todo_id, tenant_id, proc_inst_id, status) values ($1,$2,$3,'fallback') on conflict (todo_id) do nothing`, [todos['견적서 작성'], S.tenant, instId])
  const R = await lib('lib/ontology/run.js')
  const M = await lib('lib/ontology/mapengine.js')
  const { quoteView } = await import(path.join(SERVER, 'test/fixtures/map-case-view.mjs'))
  // (the server code runs in this process for the stack's tenant — as a request of that tenant would, not by changing this worker's env)
  const { tenantStore } = await lib('lib/tenantStore.js')
  const flow = await tenantStore.run({ tenant: S.tenant }, async () => M.flowFor(await R.getCase(c.id), quoteView()))
  return { caseId: c.id, instId, flow }
}

test('F-BA-03 지도에서 바로 도는 건의 흐름도: 건이 간 굵은 선 · 나머지 선 모두 같은 잉크의 화살촉, 「크게 보기」에서도 — 두 테마', async ({ browser }) => {
  const k = await seedMapCase()
  expect(k.flow.bpmn?.xml, '서버 코드가 이 건의 BPMN 을 만든다').toBeTruthy()
  const p = await page(browser, ME, { theme: 'light' })
  await p.route(`**/api/ontology/cases/${k.caseId}/flow`, (route) => route.fulfill({ json: k.flow }))
  await p.goto(`/routines/${encodeURIComponent(k.instId)}`)
  const card = p.locator('[data-test="map-case-card"]')
  const box = card.locator('[data-testid="onto-case-flow"]')
  await expect(box).toHaveAttribute('data-bpmn', '1', { timeout: 30000 })
  await expect(box.locator('.bpmn').first()).toHaveAttribute('data-ready', '1', { timeout: 30000 })
  for (const theme of ['light', 'dark']) {
    await setTheme(p, theme)
    await shot(p, `f-ba-03-${theme}`, card)
    const flows = await readHeads(p, '[data-test="map-case-card"]')
    expectSequenceHeads(flows, theme, '건의 흐름도')
    // the way the case went (thick, the primary ink) and the rest (thin): each head the ink of its own line
    const taken = flows.filter((f) => /\bcs-taken\b/.test(f.cls))
    expect(taken.length, '건이 간 길').toBeGreaterThan(2)
    const plain = flows.filter((f) => !/\bcs-/.test(f.cls) && /^SequenceFlow/.test(f.id))
    expect(plain.length, '가지 않은 길').toBeGreaterThan(0)
    expect.soft(taken[0].end.strokeC?.a, '건이 간 길의 촉은 진한 잉크, 가지 않은 길의 촉은 흐린 잉크').toBeGreaterThan(plain[0].end.strokeC?.a + 0.3)
  }
  // 크게 보기 (the diagram moves over the page — Teleport — and is drawn left to right again)
  await box.locator('[data-testid="bpmn-big"]').click()
  const big = p.locator('.bpmn.big')
  await expect(big).toHaveAttribute('data-ready', '1', { timeout: 30000 })
  await shot(p, 'f-ba-03-big-dark', big)
  expectSequenceHeads(await readHeads(p, '.bpmn.big'), 'dark', '크게 보기의 흐름도')
  await big.getByTestId('bpmn-big').click()
  await expect(big).toHaveCount(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

// ---- 프로세스 개선 (ImproveView → improve/HeatBpmn): the version's BPMN with the bottleneck heat and the critical path; its history the fixed
// simulation (lib/improve/demoProcess.js) written the way the engine leaves it (shape.js), as improve.spec.js does
test('F-BA-04 프로세스 개선 화면의 BPMN(병목 열지도 · 크리티컬 패스): 모든 흐름에 화살촉, 크리티컬 패스의 주황 선은 주황 촉 — 두 테마', async ({ browser }) => {
  const { simulate, contract } = await lib('lib/improve/demoProcess.js')
  const { writeInstance, flatDefinition } = await lib('lib/improve/shape.js')
  const CB = await lib('lib/ontology/casebpmn.js')
  const DEF = `rt_ba_improve_${RUN}`
  const people = { jang: ME.id, minji: ME.id, seoyeon: ME.id }
  const names = { jang: ME.name, minji: ME.name, seoyeon: ME.name }
  const c = contract(people)
  c.processDefinition.processDefinitionId = DEF
  const def = flatDefinition(c)
  const xml = CB.createBpmnXml(c.processDefinition, true)
  cleanups.push(async () => {
    const insts = (await S.q('select proc_inst_id from bpm_proc_inst where proc_def_id=$1', [DEF])).map((r) => r.proc_inst_id)
    await S.q('delete from events where proc_inst_id = any($1)', [insts]).catch(() => {})
    await S.q('delete from todolist_status_history where proc_inst_id = any($1)', [insts]).catch(() => {})
    await S.q('delete from task_execution_properties where proc_inst_id = any($1)', [insts]).catch(() => {})
    await S.q('delete from proc_def_version where proc_def_id=$1', [DEF])
    await S.q('delete from pro_improve_state where proc_def_id=$1', [DEF]).catch(() => {})
    await S.q('delete from pro_improve_runs where proc_def_id=$1', [DEF]).catch(() => {})
  })
  await S.q(`insert into proc_def (id, name, definition, bpmn, type, tenant_id, owner, isdeleted) values ($1,$2,$3,$4,'bpmn',$5,$6,false)`, [DEF, `개선 화살촉 ${RUN}`, def, xml, S.tenant, ME.id])
  await S.q(`insert into proc_def_version (arcv_id, proc_def_id, version, version_tag, "timeStamp", definition, snapshot, message, tenant_id, is_draft) values ($1,$2,'1.0','major',now(),$3,$4,'v1',$5,false)`,
    [`${DEF}_1.0`, DEF, def, xml, S.tenant])
  const now = Date.now()
  for (const sim of simulate({ people, names, from: now - 20 * 86400_000, to: now - 3600_000, seed: 7, defId: DEF })) {
    await writeInstance(S.q, { tenant: S.tenant, defId: DEF, sim, arcv: `${DEF}_1.0`, version: '1.0', roles: def.roles })
  }
  const p = await page(browser, ME, { theme: 'dark' })
  await p.goto(`/improve/${DEF}?version=1.0`)
  await expect(p.getByRole('heading', { name: `개선 화살촉 ${RUN}` })).toBeVisible({ timeout: 30000 })
  const hb = p.locator('.hb').first()
  await expect(hb.locator('.djs-connection').first()).toBeAttached({ timeout: 30000 })
  for (const theme of ['dark', 'light']) {
    await setTheme(p, theme)
    await shot(p, `f-ba-04-heat-${theme}`, hb)
    expectSequenceHeads(await readHeads(p, '.hb'), theme, '병목 열지도의 BPMN')
  }
  await p.getByRole('button', { name: '크리티컬 패스' }).click()
  await expect(p.locator('.hb .djs-connection.crit-edge').first()).toBeAttached({ timeout: 30000 })
  const path = p.locator('.hb').first()
  for (const theme of ['light', 'dark']) {
    await setTheme(p, theme)
    await shot(p, `f-ba-04-path-${theme}`, path)
    const flows = await readHeads(p, '.hb')
    expectSequenceHeads(flows, theme, '크리티컬 패스의 BPMN')
    // the critical edges: thick orange lines with orange heads (#e0613f)
    const crit = flows.filter((f) => /\bcrit-edge\b/.test(f.cls))
    expect(crit.length, '크리티컬 패스의 흐름').toBeGreaterThan(1)
    for (const f of crit) expect.soft(f.end.stroke, `${f.id} 의 촉`).toBe('rgb(224, 97, 63)')
  }
  expect(p.errors).toEqual([])
  await p.context().close()
})
