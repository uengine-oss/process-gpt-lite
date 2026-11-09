// AI-DLC 2.11.2 stages (from its compiled stage-graph.json) and the human role that answers and
// approves each one. The agent is the stage's lead; the role is the person who works with it.
import { L } from '../lang.js'

// [number, slug, phase, lead agent]
const RAW = [
  ['0.1', 'workspace-scaffold', 'initialization', 'orchestrator'],
  ['0.2', 'workspace-detection', 'initialization', 'orchestrator'],
  ['0.3', 'state-init', 'initialization', 'orchestrator'],
  ['1.1', 'intent-capture', 'ideation', 'product'],
  ['1.2', 'market-research', 'ideation', 'product'],
  ['1.3', 'feasibility', 'ideation', 'architect'],
  ['1.4', 'scope-definition', 'ideation', 'product'],
  ['1.5', 'team-formation', 'ideation', 'delivery'],
  ['1.6', 'rough-mockups', 'ideation', 'design'],
  ['1.7', 'approval-handoff', 'ideation', 'delivery'],
  ['2.1', 'reverse-engineering', 'inception', 'developer'],
  ['2.2', 'practices-discovery', 'inception', 'pipeline-deploy'],
  ['2.3', 'requirements-analysis', 'inception', 'product'],
  ['2.4', 'user-stories', 'inception', 'product'],
  ['2.5', 'refined-mockups', 'inception', 'design'],
  ['2.6', 'domain-design', 'inception', 'architect'],
  ['2.7', 'units-generation', 'inception', 'architect'],
  ['2.8', 'contract-design', 'inception', 'architect'],
  ['2.9', 'delivery-planning', 'inception', 'delivery'],
  ['3.1', 'functional-design', 'construction', 'architect'],
  ['3.2', 'nfr-requirements', 'construction', 'architect'],
  ['3.3', 'nfr-design', 'construction', 'architect'],
  ['3.4', 'infrastructure-design', 'construction', 'aws-platform'],
  ['3.5', 'code-generation', 'construction', 'developer'],
  ['3.6', 'build-and-test', 'construction', 'quality'],
  ['3.7', 'ci-pipeline', 'construction', 'pipeline-deploy'],
  ['4.1', 'deployment-pipeline', 'operation', 'pipeline-deploy'],
  ['4.2', 'environment-provisioning', 'operation', 'aws-platform'],
  ['4.3', 'deployment-execution', 'operation', 'pipeline-deploy'],
  ['4.4', 'observability-setup', 'operation', 'operations'],
  ['4.5', 'incident-response', 'operation', 'operations'],
  ['4.6', 'performance-validation', 'operation', 'quality'],
  ['4.7', 'feedback-optimization', 'operation', 'operations'],
]

// the person who works with each lead agent (practices-discovery is answered by the team lead)
const ROLE = {
  orchestrator: ['AI-DLC', 'AI-DLC'],
  product: ['PO·기획', 'PO / planner'],
  design: ['디자이너', 'Designer'],
  architect: ['아키텍트', 'Architect'],
  delivery: ['딜리버리 리드', 'Delivery lead'],
  developer: ['개발자', 'Developer'],
  quality: ['QA', 'QA'],
  devsecops: ['보안', 'Security'],
  compliance: ['컴플라이언스', 'Compliance'],
  'aws-platform': ['플랫폼', 'Platform'],
  'pipeline-deploy': ['배포', 'Release'],
  operations: ['운영', 'Operations'],
  'team-lead': ['팀 리드', 'Team lead'],
}
const ROLE_OF_STAGE = { 'practices-discovery': 'team-lead' }

const NAME = {
  'workspace-scaffold': ['작업 공간 준비', 'Workspace scaffold'], 'workspace-detection': ['작업 공간 살피기', 'Workspace detection'],
  'state-init': ['상태 만들기', 'State init'], 'intent-capture': ['의도 정리', 'Intent capture'], 'market-research': ['시장 조사', 'Market research'],
  feasibility: ['실현 가능성', 'Feasibility'], 'scope-definition': ['범위 정하기', 'Scope definition'], 'team-formation': ['팀 구성', 'Team formation'],
  'rough-mockups': ['화면 초안', 'Rough mockups'], 'approval-handoff': ['승인과 넘김', 'Approval & handoff'],
  'reverse-engineering': ['기존 코드 분석', 'Reverse engineering'], 'practices-discovery': ['팀 규칙', 'Team practices'],
  'requirements-analysis': ['요구사항', 'Requirements'], 'user-stories': ['유저 스토리', 'User stories'], 'refined-mockups': ['화면', 'Refined mockups'],
  'domain-design': ['도메인 설계', 'Domain design'], 'units-generation': ['유닛', 'Units'], 'contract-design': ['API 계약', 'Contracts'],
  'delivery-planning': ['볼트 계획', 'Bolt plan'], 'functional-design': ['기능 설계', 'Functional design'], 'nfr-requirements': ['품질 요구', 'NFR requirements'],
  'nfr-design': ['품질 설계', 'NFR design'], 'infrastructure-design': ['인프라 설계', 'Infrastructure design'], 'code-generation': ['코드 생성', 'Code generation'],
  'build-and-test': ['빌드·테스트', 'Build & test'], 'ci-pipeline': ['CI', 'CI pipeline'], 'deployment-pipeline': ['배포 파이프라인', 'Deployment pipeline'],
  'environment-provisioning': ['환경 준비', 'Environment provisioning'], 'deployment-execution': ['배포', 'Deployment'],
  'observability-setup': ['관측 설정', 'Observability'], 'incident-response': ['사고 대응', 'Incident response'],
  'performance-validation': ['성능 검증', 'Performance validation'], 'feedback-optimization': ['피드백 반영', 'Feedback & optimization'],
}

export const STAGES = RAW.map(([number, slug, phase, agent]) => ({ number, slug, phase, agent, roleKey: ROLE_OF_STAGE[slug] || agent }))
export const stageBySlug = new Map(STAGES.map((s) => [s.slug, s]))

export const stageName = (slug) => { const n = NAME[slug]; return n ? L(n[0], n[1]) : slug }
export const roleName = (key) => { const r = ROLE[key]; return r ? L(r[0], r[1]) : key }

// the stage as the API returns it (names in the current language)
export function describeStage(slug) {
  const s = stageBySlug.get(slug)
  if (!s) return { slug, number: null, phase: null, name: slug, role: null, roleKey: null }
  return { slug, number: s.number, phase: s.phase, name: stageName(slug), role: roleName(s.roleKey), roleKey: s.roleKey }
}
