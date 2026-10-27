// 개선안 → 새 프로세스 정의(flattened proc_def.definition). what-if 계산과 「개선안 적용」이 같은 변환을 쓴다.
//   automate  {step}                    사람 단계 → 에이전트 단계 (agentMode complete, orchestration deepagents)
//   predraft  {step, saving}            사람 단계 앞에 에이전트 사전 초안 (process-gpt HITL agentMode draft) — 사람은 확인만
//   skip      {step, field, threshold}  금액 등이 기준 미만이면 그 단계를 건너뜀 (배타 게이트웨이를 앞에 넣음)
//   parallel  {step}                    바로 앞 단계와 동시에 (병렬 게이트웨이로 감쌈)
//   capacity  {step, add}               그 단계 담당 인원 추가 — 정의는 그대로(팀·역할에서 배정)
//   rework    {step, factor}            보완 요청(루프) 비율 줄이기 — 정의는 그대로(앞 단계 점검표·지시 보강)

export const CHANGE_TYPES = {
  automate: '에이전트로 자동화',
  predraft: '에이전트 사전 초안(사람은 확인만)',
  skip: '기준 미만이면 건너뛰기',
  parallel: '앞 단계와 동시에',
  capacity: '담당 인원 추가',
  rework: '보완 요청 줄이기',
}

const clone = (x) => JSON.parse(JSON.stringify(x))
const err = (m) => Object.assign(new Error(m), { status: 400 })

export function describeChange(c, def) {
  const a = (def.activities || []).find((x) => x.id === c.step)
  const nm = a?.name || c.step
  switch (c.type) {
    case 'automate': return `${nm} — 에이전트로 자동화`
    case 'predraft': return `${nm} — 에이전트가 먼저 초안을 만들고 사람은 확인만 (작업 ${Math.round((c.saving ?? 0.5) * 100)}% 절감 가정)`
    case 'skip': return `${nm} — ${c.label || c.field} ${fmtNum(c.threshold)} 미만이면 건너뜀`
    case 'parallel': return `${nm} — 바로 앞 단계와 동시에`
    case 'capacity': return `${nm} — 담당 ${c.add ?? 1}명 추가`
    case 'rework': return `${nm} — 보완 요청 ${Math.round((1 - (c.factor ?? 0.5)) * 100)}% 줄이기`
    default: return `${nm} — ${c.type}`
  }
}
export const fmtNum = (v) => (v >= 1e8 ? `${+(v / 1e8).toFixed(2)}억` : v >= 1e4 ? `${Math.round(v / 1e4).toLocaleString('ko-KR')}만` : String(v))

/** ctx: { p: {edgeId: share}, share: {step: skipShare}, agentFor(step) → {id, name} } */
export function transformDefinition(def0, changes = [], ctx = {}) {
  const def = clone(def0)
  def.activities ||= []; def.gateways ||= []; def.sequences ||= []; def.roles ||= []
  const edgeP = {}
  const notes = []
  const act = (id) => def.activities.find((a) => a.id === id) || (() => { throw err(`단계 '${id}' 를 찾지 못했어요.`) })()
  const outOf = (id) => def.sequences.filter((s) => s.source === id)
  const inOf = (id) => def.sequences.filter((s) => s.target === id)
  const gw = (id) => def.gateways.find((g) => g.id === id)
  for (const c of changes) {
    const a = act(c.step)
    if (c.type === 'automate') {
      const agent = ctx.agentFor?.(c.step) || null
      a.agentMode = 'complete'
      a.orchestration = 'deepagents'
      a.type = 'userTask'
      const role = `${a.name} 에이전트`
      if (agent) {
        a.agent = agent.id
        if (!def.roles.some((r) => r.name === role)) def.roles.push({ name: role, endpoint: agent.id, default: agent.id, resolutionRule: '개선 적용: 에이전트로 자동화', origin: 'used' })
        a.role = role
      }
      a.instruction = [a.instruction, `(개선) 이 단계는 에이전트가 처리합니다. 앞 단계 산출물로 '${a.name}' 양식을 채우세요.`].filter(Boolean).join('\n')
    } else if (c.type === 'predraft') {
      a.agentMode = 'draft'
      a.orchestration = 'deepagents'
      a.instruction = [a.instruction, `(개선) 에이전트가 먼저 '${a.name}' 초안을 채우고, 담당자는 확인·수정만 합니다.`].filter(Boolean).join('\n')
    } else if (c.type === 'skip') {
      if (c.threshold == null || !c.field) throw err('건너뛰기 기준(항목과 금액)이 필요해요.')
      const id = `gw_skip_${c.step}`
      if (gw(id)) continue
      const outs = outOf(c.step)
      if (outs.length !== 1) throw err(`'${a.name}' 뒤 흐름이 하나가 아니라 건너뛰기를 넣을 수 없어요.`)
      let target = outs[0].target
      const next = gw(target)
      if (next && next.type === 'exclusiveGateway' && outOf(next.id).length > 1) {
        // the review's own decision: skipping it takes its usual forward branch (승인)
        const fwd = outOf(next.id).filter((s) => !ctx.back?.has(s.id))
        fwd.sort((x, y) => (ctx.p?.[y.id] ?? 0) - (ctx.p?.[x.id] ?? 0))
        if (fwd[0]) target = fwd[0].target
      }
      for (const s of inOf(c.step)) s.target = id
      const label = c.label || c.field
      def.gateways.push({ id, name: `${label} 기준`, type: 'exclusiveGateway', role: a.role, conditionData: [], properties: '{}', description: `${label} ${fmtNum(c.threshold)} 미만이면 '${a.name}' 을(를) 건너뜀` })
      def.sequences.push({ id: `seq_skip_${c.step}_keep`, name: `${fmtNum(c.threshold)} 이상`, source: id, target: c.step, condition: `${label}(${c.field}) 이(가) ${c.threshold} 이상`, properties: '{}' })
      def.sequences.push({ id: `seq_skip_${c.step}_skip`, name: `${fmtNum(c.threshold)} 미만 · 건너뜀`, source: id, target, condition: `${label}(${c.field}) 이(가) ${c.threshold} 미만`, properties: '{}' })
      const share = ctx.share?.[c.step] ?? c.share ?? 0
      edgeP[`seq_skip_${c.step}_keep`] = 1 - share
      edgeP[`seq_skip_${c.step}_skip`] = share
    } else if (c.type === 'parallel') {
      const ins = inOf(c.step)
      const prev = ins.length === 1 ? def.activities.find((x) => x.id === ins[0].source) : null
      if (!prev) throw err(`'${a.name}' 바로 앞이 단계 하나가 아니라 동시에 하도록 바꿀 수 없어요.`)
      const outs = outOf(c.step)
      if (outs.length !== 1 || outOf(prev.id).length !== 1) throw err(`'${a.name}' 앞뒤 흐름이 하나씩이 아니라 동시에 하도록 바꿀 수 없어요.`)
      const split = `gw_par_${c.step}_split`, join = `gw_par_${c.step}_join`
      for (const s of inOf(prev.id)) s.target = split
      const after = outs[0].target
      def.sequences = def.sequences.filter((s) => s !== ins[0] && s !== outs[0])
      def.gateways.push({ id: split, name: '', type: 'parallelGateway', role: a.role, conditionData: [], properties: '{}', description: `${prev.name} ∥ ${a.name}` })
      def.gateways.push({ id: join, name: '', type: 'parallelGateway', role: a.role, conditionData: [], properties: '{}', description: '' })
      def.sequences.push({ id: `seq_par_${c.step}_a`, name: '', source: split, target: prev.id, condition: '', properties: '{}' })
      def.sequences.push({ id: `seq_par_${c.step}_b`, name: '', source: split, target: c.step, condition: '', properties: '{}' })
      def.sequences.push({ id: `seq_par_${c.step}_c`, name: '', source: prev.id, target: join, condition: '', properties: '{}' })
      def.sequences.push({ id: `seq_par_${c.step}_d`, name: '', source: c.step, target: join, condition: '', properties: '{}' })
      def.sequences.push({ id: `seq_par_${c.step}_e`, name: '', source: join, target: after, condition: '', properties: '{}' })
    } else if (c.type === 'capacity') {
      notes.push(`${a.name}: 담당 ${c.add ?? 1}명 추가는 정의를 바꾸지 않아요 — 설정 → 팀·역할에서 '${a.role}' 역할에 사람을 더 배정하세요.`)
    } else if (c.type === 'rework') {
      notes.push(`${a.name}: 보완 요청 줄이기는 정의를 바꾸지 않아요 — 앞 단계 지시에 자주 나온 보완 사유를 점검표로 넣으세요.`)
    } else throw err(`알 수 없는 개선 종류: ${c.type}`)
  }
  return { def, edgeP, notes }
}

export const changesDefinition = (changes) => changes.some((c) => !['capacity', 'rework'].includes(c.type))
