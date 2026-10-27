// Process-improvement tools for agents at /mcp/improve (registered like /mcp/folders: a tenant MCP entry
// and an mcp-hub server bound for everyone). Every number comes from the deterministic analysis in
// lib/improve (lead-time decomposition, value stream, constraint, CPM, what-if); the model only explains.
// The caller's JWT decides what it may see: processes it took part in (or all, for an admin).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { userFromJwt, q } from '../lib/supa.js'
import { config } from '../config.js'
import * as S from '../lib/improve/service.js'
import { dur } from '../lib/improve/focus.js'

const P = { process: { type: 'string', description: '프로세스 이름 또는 id (예: 달빛커피 제안)' } }
const CHANGE = {
  type: 'array', description: '바꿀 것들. type: automate(에이전트로 자동화) | predraft(에이전트 사전 초안, saving 0~0.9) | skip(field 값이 threshold 미만이면 건너뜀) | parallel(바로 앞 단계와 동시에) | capacity(담당 add 명 추가) | rework(보완 요청 비율 × factor)',
  items: { type: 'object', properties: { type: { type: 'string' }, step: { type: 'string', description: '단계 id 또는 이름' }, field: { type: 'string' }, threshold: { type: 'number' }, saving: { type: 'number' }, add: { type: 'number' }, factor: { type: 'number' } }, required: ['type', 'step'] },
}
const TOOLS = [
  { name: 'improve_processes', description: '[프로세스 개선] 실행 기록이 있어 병목·제약 분석을 할 수 있는 프로세스 목록(완료 건수, 마지막으로 찾은 제약).', inputSchema: { type: 'object', properties: {} } },
  { name: 'improve_bottlenecks', description: '[프로세스 개선] 한 프로세스의 단계별 병목: 실행 횟수, 소요시간(중앙값·p80), 대기/작업, 검토 대기·큐 대기 합, 재작업률, 병목 점수. 리드타임 중앙값과 흐름 효율도. "어디가 병목이야?" 에 먼저 쓰세요.', inputSchema: { type: 'object', properties: P, required: ['process'] } },
  { name: 'improve_value_stream', description: '[프로세스 개선] 가치 흐름 지도: 단계 순서대로 작업 시간 vs 대기 시간, 단계 리드타임, 첫 통과율·재작업률, 담당(역할·사람·에이전트), 흐름 효율 = Σ작업 / 리드타임.', inputSchema: { type: 'object', properties: P, required: ['process'] } },
  { name: 'improve_constraint', description: '[프로세스 개선] 제약 이론: 자원별 도착(수요)·처리 능력·가동률·대기 건수(WIP)와 추세로 찾은 제약, 그리고 5단계(찾기→최대 활용→종속→강화→반복)별 할 일과 what-if 로 미리 계산한 효과. "어떻게 줄여?" 에 쓰세요.', inputSchema: { type: 'object', properties: P, required: ['process'] } },
  { name: 'improve_critical_path', description: '[프로세스 개선] 크리티컬 패스(CPM): 잰 단계 시간(대기 포함, median 또는 p80)으로 ES/EF/LS/LF/여유 시간, 대표 경로와 확률, 진행 중 인스턴스의 남은 크리티컬 패스와 예상 완료.', inputSchema: { type: 'object', properties: { ...P, basis: { type: 'string', enum: ['median', 'p80'] } }, required: ['process'] } },
  { name: 'improve_what_if', description: '[프로세스 개선] 개선안을 미리 계산: 바꾸기 전/후 기대 리드타임, 크리티컬 패스, 흐름 효율, 제약 가동률. 적용(새 버전)은 사람이 개선 화면에서 확인한 뒤에만 합니다.', inputSchema: { type: 'object', properties: { ...P, changes: CHANGE, basis: { type: 'string', enum: ['median', 'p80'] } }, required: ['process', 'changes'] } },
]

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }] })

async function processOf(args) {
  const p = await S.resolveProcess(args.process)
  if (!p) throw new Error(`'${args.process}' 프로세스를 찾지 못했어요(실행 기록이 있는 프로세스만 분석할 수 있어요).`)
  return p
}

async function callTool(user, name, args = {}) {
  if (name === 'improve_processes') {
    const admin = await S.isAdmin(user)
    const rows = await q(`select d.id, d.name, count(i.*) filter (where i.status='COMPLETED')::int as completed, s.step_name, s.resource_name, s.rho
                          from proc_def d join bpm_proc_inst i on lower(i.proc_def_id)=lower(d.id) and i.tenant_id=d.tenant_id
                          left join pro_improve_state s on s.tenant_id=d.tenant_id and s.proc_def_id=d.id
                          where d.tenant_id=$1 and ($2 or d.owner=$3 or exists (select 1 from todolist t where t.proc_inst_id=i.proc_inst_id and (t.user_id like '%'||$3||'%' or t.user_id like '%'||$4||'%')))
                          group by d.id, d.name, s.step_name, s.resource_name, s.rho order by 3 desc limit 30`, [config.tenantId, admin, String(user.id), user.email || '(none)'])
    return text(rows.map((r) => ({ id: r.id, name: r.name, completed: r.completed, constraint: r.step_name ? `${r.step_name}(${r.resource_name}, 가동률 ${Math.round(r.rho * 100)}%)` : null })))
  }
  const p = await processOf(args)
  const b = await S.brief(user, p.id, { basis: args.basis || 'median' })
  if (name === 'improve_bottlenecks') return text({ process: b.process, completed: b.completed, lead_time: b.lead_time, flow_efficiency: b.flow_efficiency, bottlenecks: b.bottlenecks, link: b.link })
  if (name === 'improve_value_stream') {
    const o = await S.overview(user, p.id)
    return text({ process: o.def.name, lead_time_mean: dur(o.vsm.leadMean), work_mean: dur(o.vsm.workMean), wait_mean: dur(o.vsm.waitMean), flow_efficiency: b.flow_efficiency, rolled_yield: `${Math.round(o.vsm.rolledYield * 100)}%`,
      steps: o.vsm.steps.map((s) => ({ step: s.name, who: s.people.map((x) => x.name).join(', ') || s.role, kind: s.kind === 'human' ? '사람' : '에이전트', work: dur(s.work), wait: dur(s.wait), lead: dur(s.lead), first_pass_yield: s.fpy != null ? `${Math.round(s.fpy * 100)}%` : null, rework_rate: `${s.reworkRate.toFixed(1)}%` })), link: b.link })
  }
  if (name === 'improve_constraint') return text({ process: b.process, constraint: b.constraint, five_focusing_steps: b.five_focusing_steps, link: b.link })
  if (name === 'improve_critical_path') return text({ process: b.process, critical_path: b.critical_path, running_instances: b.running_instances, link: b.link })
  if (name === 'improve_what_if') {
    const o = await S.overview(user, p.id)
    const byName = (s) => o.steps.find((x) => x.id === s || x.name === s || x.name.includes(s) || String(s).includes(x.name))?.id || s
    const changes = (args.changes || []).map((c) => ({ ...c, step: byName(c.step), ...(c.type === 'skip' && !c.field && o.suggestedThreshold ? { field: o.suggestedThreshold.field, threshold: c.threshold ?? o.suggestedThreshold.threshold } : {}) }))
    const r = await S.simulateChanges(user, p.id, { changes, basis: args.basis })
    const v = (e) => ({ lead_time: dur(e.leadSec), flow_efficiency: e.flowEfficiency != null ? `${(e.flowEfficiency * 100).toFixed(1)}%` : null, critical_path: e.pathNames, constraint: e.constraint ? `${e.constraint.name} ${Math.round(e.constraint.rho * 100)}%` : null })
    return text({ process: o.def.name, changes: r.changes.map((c) => c.text), before: v(r.before), after: v(r.after), notes: r.notes, apply_here: b.link })
  }
  return { isError: true, ...text(`unknown tool ${name}`) }
}

function buildServer(user) {
  const server = new Server({ name: 'pgpt-improve', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!user) return { isError: true, ...text('unauthorized: call with the user JWT (Authorization: Bearer {{user_jwt}})') }
    try {
      console.log(`[mcp] improve.${params.name} user=${user.id.slice(0, 8)}`)
      return await callTool(user, params.name, params.arguments || {})
    } catch (e) { return { isError: true, ...text(e.message) } }
  })
  return server
}

export const IMPROVE_TOOLS = TOOLS
export { callTool as callImproveTool }

// mounted before the generic /mcp/:connector route
export function mountImprove(app) {
  app.post('/mcp/improve', async (req, res) => {
    let jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (/^\{\{\s*user_jwt\s*\}\}$/.test(jwt)) jwt = ''
    const u = jwt ? await userFromJwt(jwt) : null
    if (jwt && !u) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: invalid or expired user JWT' }, id: null })
    let user = null
    if (u) {
      const [p] = await q('select name from pro_profile where user_id=$1', [u.id])
      user = { id: u.id, email: u.email, name: p?.name || u.user_metadata?.name || u.email.split('@')[0] }
    }
    const server = buildServer(user)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
}
