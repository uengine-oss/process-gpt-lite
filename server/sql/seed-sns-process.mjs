// Daily SNS trend response, saved through process-gpt's own save path (save_contract + BPMN):
//   관찰 설정 → SNS 피드 스캔(브라우저) → 신호 분류(deepagents) ─ 무관 → 조용히 종료(알림 없음)
//                                                  └ 접목 ─┬─ 벤치마킹 분석 ─┐
//                                                          └─ 이슈·해결책 정리 ─┴→ 제품 책임자 결정(제품 책임자 역할 담당자에게 알림)
//     ─ 반영 → 제품 개선 구현(Claude Code, process-gpt 저장소 worktree 브랜치) → 전문가 연락 초안 ─┐
//     ─ 보류 ──────────────────────────────────────────────────────────────────────────────┴→ SNS 반응 확인 → 마케팅 초안 → 마케터 승인
// Code lands on an agent branch only after a person decides to act on it; merging stays with people.
// Outbound actions stay drafts: expert messages and posts go out only after a person approves.
// Run: node sql/seed-sns-process.mjs
import { q, pool } from '../lib/supa.js'
import { config } from '../config.js'
import { saveGenerated } from '../lib/generated.js'
import { PGPT_ROOT } from '../lib/paths.js'

const T = config.tenantId
const PID = 'pro_sns_trend_response'
const BROWSER = '5b7c1d2e-9a8b-4c3d-8e7f-6a5b4c3d2e1f'
const ANALYST = '7c1e2d3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f'
const BUILDER = '8d2f3e4a-5b6c-4d7e-8f90-1b2c3d4e5f60'
const form = (key) => `${PID}_${key}_form`
const REPO = PGPT_ROOT
const PRODUCT = 'Process GPT — 대화로 업무 프로세스를 만들고 AI 에이전트가 실행하는 에이전틱 BPM 플랫폼(pgpt pro 업무 비서 포함)'

const fields = {
  setup: [
    { key: 'sources', text: '관찰할 SNS·커뮤니티', type: 'textarea' },
    { key: 'topics', text: '관심 주제', type: 'textarea' },
    { key: 'our_product', text: '우리 제품', type: 'textarea' },
  ],
  scan: [
    { key: 'feed_report', text: '피드 스캔 보고서', type: 'report' },
    { key: 'top_item_title', text: '가장 주목할 게시물', type: 'text' },
    { key: 'top_item_url', text: '게시물 URL', type: 'text' },
  ],
  classify: [
    { key: 'fit', text: 'Process GPT 접목 여부', type: 'select', items: [{ 접목: '접목할 만함 — 우리 제품에 반영하거나 대응할 거리' }, { 무관: '무관 — 알릴 필요 없음' }] },
    { key: 'fit_reason', text: '접목 방안', type: 'textarea' },
    { key: 'signal_type', text: '신호 유형', type: 'select', items: [{ 벤치마킹: '벤치마킹 — 찬사받는 참신한 솔루션' }, { '이슈 대응': '이슈 대응 — 보안 등 문제와 전문가 해결책' }] },
    { key: 'rationale', text: '판단 근거', type: 'textarea' },
  ],
  benchmark: [
    { key: 'benchmark_report', text: '벤치마킹 분석', type: 'report' },
    { key: 'recommendation', text: '권고', type: 'select', items: [{ 보완: '기존 제품 보완' }, { 피버팅: '피버팅 검토' }, { 관망: '관망' }] },
  ],
  review: [
    { key: 'decision', text: '결정', type: 'radio', items: [{ 반영: '제품에 반영 — 구현 시도' }, { 보류: '보류' }] },
    { key: 'scope', text: '구현할 개선 범위', type: 'textarea' },
  ],
  brief: [
    { key: 'issue_brief', text: '이슈·전문가 해결책 정리', type: 'report' },
    { key: 'experts', text: '연락할 전문가', type: 'textarea' },
  ],
  implement: [
    { key: 'implementation_report', text: '대응 구현 보고서', type: 'report' },
    { key: 'files', text: '만든 파일', type: 'textarea' },
  ],
  demo: [
    { key: 'demo_report', text: '시연 영상 보고', type: 'report' },
  ],
  outreach: [
    { key: 'outreach_drafts', text: '전문가 연락 초안', type: 'report' },
  ],
  reaction: [
    { key: 'reaction_report', text: 'SNS 반응 보고서', type: 'report' },
    { key: 'sentiment', text: '전반적 반응', type: 'select', items: [{ 긍정: '긍정' }, { 중립: '중립' }, { 부정: '부정' }] },
  ],
  marketing: [
    { key: 'marketing_copy', text: '마케팅 콘텐츠 초안', type: 'report' },
  ],
  approve: [
    { key: 'approval', text: '게시 승인', type: 'radio', items: [{ 승인: '승인' }, { 수정: '수정 요청' }] },
    { key: 'comment', text: '의견', type: 'textarea' },
  ],
}
const tag = { text: 'text-field', number: 'text-field', select: 'select-field', radio: 'radio-field', textarea: 'textarea-field', report: 'report-field' }
const html = (id, alias, fs) => `<section>\n${fs.map((f) => {
  const t = tag[f.type]
  const items = f.items ? ` is_dynamic_load='fixed' items='${JSON.stringify(f.items)}'` : ''
  const type = t === 'text-field' ? ` type='${f.type === 'number' ? 'number' : 'text'}'` : ''
  return `  <row-layout name="${id}" alias="${alias}" is_multidata_mode="false" v-model="formValues" v-slot="slotProps"><div class="row"><div class="col-sm-12"><${t} name='${f.key}' alias='${f.text}'${type}${items} disabled='false' readonly='false' v-model="slotProps.modelValue['${f.key}']"></${t}></div></div></row-layout>`
}).join('\n')}\n</section>`

const act = (id, name, role, key, extra = {}) => ({ elementType: 'Activity', id, name, role, type: 'UserActivity', tool: `formHandler:${form(key)}`, duration: 1, inputData: [], outputData: [name], checkpoints: [], agentMode: 'none', ...extra })
const agentAct = (id, name, role, key, agent, orchestration, instruction, extra = {}) =>
  act(id, name, role, key, { agent, agentMode: 'complete', orchestration, duration: 3, description: instruction.split('.')[0], instruction, ...extra })
const seq = (s, t, cond, field = 'signal_type') => ({ elementType: 'Sequence', id: `seq_${s}_${t}`, source: s, target: t, condition: cond || '',
  ...(cond ? { name: cond, properties: JSON.stringify({ conditionFunction: `${field} == '${cond}'`, condition: cond }) } : {}) })

const elements = [
  { elementType: 'Event', id: 'start_event', name: '데일리 관찰 시작', role: '마케팅 담당자', type: 'StartEvent' },
  act('watch_setup', '관찰 설정', '마케팅 담당자', 'setup', { description: '관찰할 SNS·주제·우리 제품을 정한다(예약 실행 시 저장된 값으로 채워진다).' }),
  agentAct('scan_feed', 'SNS 피드 스캔', 'SNS 리서치 에이전트', 'scan', BROWSER, 'browser-automation-agent',
    '관찰 설정의 SNS 를 돌며 오늘 주목받는 게시물을 찾는다. facebook.com 은 보관함에 로그인 정보가 있을 때만 로그인해서 피드를 보고, 없으면 Facebook 피드 사본 http://localhost:5180/demo-feed/index.html 를 Facebook 피드로 본다. 관심 주제와 관련해 반응(좋아요·댓글·공유)이 많은 게시물을 제목·작성자·URL·반응 수·한 줄 요지로 note 에 남기고, 가장 주목할 게시물 하나를 골라 그 본문 요지를 자세히 기록한다. 사이트에 보이는 사실만 기록한다.'),
  agentAct('classify_signal', '신호 분류', '분석 에이전트', 'classify', ANALYST, 'deepagents',
    `피드 스캔 보고서에서 가장 주목할 게시물을 판단한다. 먼저 우리 제품(${PRODUCT})에 접목할 만한지 본다 — 우리 제품에 기능·템플릿·스킬로 반영하거나 대응할 거리가 있으면 fit 을 "접목", 우리 제품과 관계없는 화제면 "무관" 으로 쓴다. "접목" 이면 fit_reason 에 Process GPT 의 어디에 어떻게 접목할지를 한두 문장으로 쓴다(제품 책임자가 이 한 줄을 보고 결정한다). 이어 새 제품·기능·UI/UX 가 찬사받으며 공유되고 있으면 signal_type 을 "벤치마킹", 보안 사고·장애·규제 같은 문제가 생겼고 전문가들이 해결책을 내놓고 있으면 "이슈 대응" 으로 정확히 쓰고 rationale 에 근거를 두세 문장으로 쓴다.`),
  { elementType: 'Gateway', id: 'gw_fit', name: '접목 여부', type: 'ExclusiveGateway', conditionData: [`${form('classify')}.fit`] },
  { elementType: 'Event', id: 'end_quiet', name: '접목할 건 없음', role: '마케팅 담당자', type: 'EndEvent' },
  { elementType: 'Gateway', id: 'gw_signal', name: '신호 유형', type: 'ExclusiveGateway', conditionData: [`${form('classify')}.signal_type`] },
  agentAct('benchmark_analysis', '벤치마킹 분석', '분석 에이전트', 'benchmark', ANALYST, 'deepagents',
    `찬사받는 솔루션을 벤치마킹한다. 게시물과 원문을 근거로 UI/UX, 핵심 기능, 차별성, 사용자 반응 포인트를 정리하고, 관찰 설정의 우리 제품(비어 있으면 ${PRODUCT})과 비교해 보완할 점(구체적 기능·화면 단위)과 피버팅이 필요한지 판단한다. 지어내지 말고 출처 URL 을 단다. recommendation 은 보완·피버팅·관망 중 하나.`),
  
  agentAct('solution_brief', '이슈·해결책 정리', '분석 에이전트', 'brief', ANALYST, 'deepagents',
    `발생한 이슈와 전문가들이 제시한 해결책을 정리한다. 무엇이 문제인지, 영향 범위, 전문가별 해결책(이름·소속·출처 URL)을 표로 정리하고, 관찰 설정의 우리 제품(비어 있으면 ${PRODUCT})이 이미 막는 것·못 막는 것을 구분한다. experts 에는 연락할 전문가와 공개된 연락 경로만 적는다.`),
  agentAct('implement_cover', '제품 개선 구현', '구현 에이전트', 'implement', BUILDER, 'cliagents',
    '제품 책임자가 반영하기로 한 개선 범위를 우리 제품 Process GPT 저장소에 구현한다. 결정에 개선 범위가 비어 있으면(홈 카드에서 반영만 눌러 결정한 경우) 신호 분류의 접목 방안과 벤치마킹 분석·이슈 정리의 보완 제안 가운데 이 저장소에서 가장 작게 끝낼 수 있는 하나를 골라 구현하고, 무엇을 골랐는지 보고서 첫 줄에 쓴다. 작업 디렉터리는 그 저장소의 worktree 브랜치다. 먼저 README 와 디렉터리 구조를 읽고 가장 맞는 위치를 고른다. 단계형 업무(예: 보안 프레임워크 절차)라면 기존 스킬·프로세스 템플릿 형식을 따라 추가하고, 기능이라면 해당 서비스 코드에 최소한으로 바꾼다. 바꾼 이유와 쓰는 법을 문서로 남긴다. 실제 시스템에 배포하거나 외부로 전송하지 않는다. implementation_report 에 변경 요약·설계·남은 일을, files 에 바꾼 파일 경로를 쓴다.'),
  agentAct('demo_video', '구현 시연 영상', '구현 에이전트', 'demo', BUILDER, 'cliagents',
    '직전 단계 제품 개선 구현이 만든 브랜치가 작업 디렉터리에 체크아웃돼 있다. ../.claude/skills/demo-video-maker/SKILL.md 를 읽고 그 절차대로, 구현 결과를 보여 주는 1~2분 나레이션 시연 영상을 .pgpt-demo/demo.mp4 로 만든다(스크립트는 ../.claude/skills/demo-video-maker/scripts/). 저장소에 있는 검사·테스트 스크립트를 실제로 돌려 그 출력을 장면에 넣는다. 셸 명령은 작업 디렉터리에서 한 번에 하나씩 실행하고 cd 나 && 로 잇지 않는다. 저장소 코드는 고치지 않는다. demo_report 에 영상 길이, 장면 목록, 검증 결과를 쓴다.'),
  agentAct('expert_outreach', '전문가 연락 초안', '분석 에이전트', 'outreach', ANALYST, 'deepagents',
    '게시물 작성자와 분석에 나온 전문가들에게 보낼 연락 초안을 쓴다. 상대마다 정중한 한국어 메시지(우리 제품 개선 구현 요약과 브랜치, 의견 요청, 협업 제안)를 쓰되, 실제로 보내지 않고 초안으로만 남긴다. 발송은 사람이 승인한 뒤에 한다.'),
  { elementType: 'Gateway', id: 'gw_join', name: '분석 합류', type: 'ExclusiveGateway' },
  act('product_review', '제품 책임자 결정', '제품 책임자', 'review', { description: 'Process GPT 에 접목할 만한 SNS 이슈가 올라왔다. 접목 방안과 분석을 보고 우리 제품에 반영할지와 구현할 개선 범위를 정한다(제품 책임자 역할 담당자에게 알림).' }),
  { elementType: 'Gateway', id: 'gw_review', name: '반영 여부', type: 'ExclusiveGateway', conditionData: [`${form('review')}.decision`] },
  { elementType: 'Gateway', id: 'gw_done', name: '대응 합류', type: 'ExclusiveGateway' },
  agentAct('monitor_reaction', 'SNS 반응 확인', 'SNS 리서치 에이전트', 'reaction', BROWSER, 'browser-automation-agent',
    '피드 스캔에서 고른 게시물 URL 을 다시 열어 댓글·반응을 살핀다. 사람들이 무엇을 칭찬하거나 걱정하는지, 우리 제품이 끼어들 만한 질문이 있는지 note 로 정리하고 전반적 반응을 긍정·중립·부정 중 하나로 정한다. 보이는 사실만 기록한다.'),
  agentAct('marketing_content', '마케팅 콘텐츠 초안', '분석 에이전트', 'marketing', ANALYST, 'deepagents',
    '지금까지의 분석·구현·반응을 바탕으로 우리 제품 마케팅 콘텐츠 초안을 쓴다. LinkedIn·Facebook 게시글 1개(300자 안팎), X 게시글 1개(140자), 블로그 요약 3문단, 해시태그 5개. 사실과 다른 주장이나 경쟁사 비방은 쓰지 않는다. 게시는 마케터 승인 뒤에 사람이 한다.'),
  act('marketing_approval', '마케터 승인', '마케팅 담당자', 'approve', { description: '콘텐츠 초안을 보고 게시를 승인하거나 수정을 요청한다.' }),
  { elementType: 'Event', id: 'end_event', name: '오늘 대응 완료', role: '마케팅 담당자', type: 'EndEvent' },
  seq('start_event', 'watch_setup'), seq('watch_setup', 'scan_feed'), seq('scan_feed', 'classify_signal'), seq('classify_signal', 'gw_fit'),
  seq('gw_fit', 'gw_signal', '접목', 'fit'), seq('gw_fit', 'end_quiet', '무관', 'fit'),
  seq('gw_signal', 'benchmark_analysis', '벤치마킹'), seq('benchmark_analysis', 'gw_join'),
  seq('gw_signal', 'solution_brief', '이슈 대응'), seq('solution_brief', 'gw_join'),
  seq('gw_join', 'product_review'), seq('product_review', 'gw_review'),
  seq('gw_review', 'implement_cover', '반영', 'decision'), seq('implement_cover', 'demo_video'), seq('demo_video', 'expert_outreach'), seq('expert_outreach', 'gw_done'),
  seq('gw_review', 'gw_done', '보류', 'decision'),
  seq('gw_done', 'monitor_reaction'), seq('monitor_reaction', 'marketing_content'), seq('marketing_content', 'marketing_approval'), seq('marketing_approval', 'end_event'),
]

const keyOf = { watch_setup: 'setup', scan_feed: 'scan', classify_signal: 'classify', benchmark_analysis: 'benchmark', product_review: 'review', solution_brief: 'brief', implement_cover: 'implement', demo_video: 'demo', expert_outreach: 'outreach', monitor_reaction: 'reaction', marketing_content: 'marketing', marketing_approval: 'approve' }
const contract = {
  type: 'process-definition-result',
  processDefinition: {
    processDefinitionId: PID,
    processDefinitionName: 'SNS 트렌드 데일리 대응',
    description: '매일 SNS 를 살펴 찬사받는 솔루션은 벤치마킹해 제품 보완·피버팅을 제안하고, 보안 같은 이슈는 전문가 해결책을 정리해 우리 제품의 대응 구현체를 만들고 전문가 연락 초안을 쓴다. 이어 SNS 반응을 살피고 마케팅 콘텐츠 초안을 만들어 사람이 승인한다.',
    isHorizontal: true,
    roles: [
      { name: '마케팅 담당자', endpoint: '', default: '', resolutionRule: '', origin: 'created' },
      { name: '제품 책임자', endpoint: '', default: '', resolutionRule: '', origin: 'created' },
      { name: 'SNS 리서치 에이전트', endpoint: BROWSER, default: BROWSER, resolutionRule: '', origin: 'used' },
      { name: '분석 에이전트', endpoint: ANALYST, default: ANALYST, resolutionRule: '', origin: 'used' },
      { name: '구현 에이전트', endpoint: BUILDER, default: BUILDER, resolutionRule: '', origin: 'used' },
    ],
    data: [],
    elements,
  },
  forms: Object.entries(keyOf).map(([aid, key]) => ({ activity_id: aid, form_id: form(key), html: html(form(key), elements.find((e) => e.id === aid).name, fields[key]) })),
  agents: [{ id: BROWSER, skills: [] }, { id: ANALYST, skills: [] }, { id: BUILDER, skills: [] }],
  skills: [],
}

const agents = [
  [BROWSER, '브라우저 에이전트', 'browser-automation-agent', 'agent', '웹 브라우저로 외부 사이트에 접속해 정보를 찾고 업무 화면을 조작한다.', '사이트에 보이는 사실만 기록하고, 결제·전송 전에는 사람의 승인을 받는다.'],
  [ANALYST, 'SNS 분석 에이전트', 'sns-analyst', 'deepagents', 'SNS 신호를 분석해 벤치마킹·이슈 대응·마케팅 콘텐츠를 만든다.', '출처를 달고 지어내지 않는다. 외부로 보내는 일은 초안까지만 한다.'],
  [BUILDER, '대응 구현 에이전트', 'cover-builder', 'cliagents', 'Claude Code 로 이슈를 커버하는 최소 구현체(코드·README·테스트)를 만든다.', '작업 디렉터리 안에서만 만들고 배포·전송하지 않는다.'],
]
for (const [id, name, alias, type, goal, persona] of agents) {
  await q(`insert into users (id, username, email, tenant_id, is_agent, is_admin, is_draft, agent_type, alias, goal, persona, permission_ids)
           values ($1,$2,$3,$4,true,false,false,$5,$6,$7,$8,'{}')
           on conflict (id, tenant_id) do update set username=$2, agent_type=$5, alias=$6, goal=$7, persona=$8`,
  [id, name, `${alias}@${T}`, T, type, alias, goal, persona])
}

console.log(await saveGenerated(contract))
// cli-agent reads these from the work item: run Claude Code on a worktree branch of our product repository
await q(`update proc_def set definition = jsonb_set(definition, '{activities}', (
          select jsonb_agg(case when a->>'id' = 'implement_cover'
            then a || jsonb_build_object('agentConfig', $3::jsonb) else a end)
          from jsonb_array_elements(definition->'activities') a)) where id=$1 and tenant_id=$2`,
[PID, T, JSON.stringify({ project_repo: REPO, base_ref: 'origin/main', agent_cli: 'claude-code', agent_permission: 'workspace_write',
  // edits stay inside the worktree; beyond that, only running its own checks
  allowed_tools: ['Bash(python3 -m pytest:*)', 'Bash(python3 -m py_compile:*)', 'Bash(python3 skills/:*)', 'Bash(ls:*)'] })])
// the demo video continues the implementation branch and may run its own tools (record, TTS, ffmpeg)
await q(`update proc_def set definition = jsonb_set(definition, '{activities}', (
          select jsonb_agg(case when a->>'id' = 'demo_video'
            then a || jsonb_build_object('agentConfig', $3::jsonb) else a end)
          from jsonb_array_elements(definition->'activities') a)) where id=$1 and tenant_id=$2`,
[PID, T, JSON.stringify({ project_repo: REPO, base_ref: '@previous', agent_cli: 'claude-code', agent_permission: 'workspace_write',
  // edits stay inside the worktree; beyond that, only running its own checks
  allowed_tools: ['Bash(python3:*)', 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(ls:*)', 'Bash(mkdir:*)'] })])
const [d] = await q(`select id, length(bpmn) as bpmn_len from proc_def where id=$1 and tenant_id=$2`, [PID, T])
console.log(d)
const [def] = await q(`select definition from proc_def where id=$1 and tenant_id=$2`, [PID, T])
console.log('activities', def.definition.activities.map((a) => `${a.id}:${a.orchestration || '-'}:${a.agentConfig ? JSON.stringify(a.agentConfig) : ''}`).join(' '))
console.log('gateways', JSON.stringify(def.definition.gateways))
console.log('cond seqs', JSON.stringify(def.definition.sequences.filter((s) => s.properties)))
console.log(await q(`select id, jsonb_array_length(fields_json) as n from form_def where proc_def_id=$1 and tenant_id=$2 order by id`, [PID, T]))
await pool.end()
