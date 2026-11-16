// 개발용 가짜 응답(?mock=…): 말로 프로세스 지도 고치기 · 더하기 · 의견 — /ontology/edit/* · /ontology/said/:proc · /ontology/opinions* ·
// /ontology/processes/:proc/opinions(…/resolve). mock.js 가 부른다(개발 서버에서만 불러오므로 운영 빌드에는 들어가지 않는다).
//   지도(liveMap): 「설계 제안 · 견적」에 다듬은 흐름 — 사람이 정한 관계(고객 회신 → 계약 의사 확인) · 사람이 더한 단계(대표 승인,
//     재무 검토 뒤 · 할인율 10% 이상) · 에이전트가 하는 「견적서 작성」 — 과 말로 만든 프로세스 「샘플 자재 요청」(said:…)을 더한다.
//   POST /ontology/edit/plan: 말에서 단계 이름을 찾아 그럴듯한 계획(새 프로세스 · 이 프로세스 · 고른 범위). 범위를 보내면
//     「범위 밖이라 하지 않았어요」 하나, 말에 「?」가 있으면 되묻기 하나(answer 와 함께 다시 보내면 없음).
//   적용 · 의견 해소는 지도를 그 자리에서 바꾼다(다음 /ontology/map 에 보인다). 「설계 제안 · 견적」에는 엇갈린 의견 둘(재무 검토를
//     에이전트가 · 사람이) · 다른 의견 하나 · 닫힌 의견 둘이 있다. ?mock=member 면 관리자가 아니다(적용 · 해소 403).
import { END, condText } from './fmt.js'

const clone = (x) => JSON.parse(JSON.stringify(x))
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))
const wid = (f, t) => `${f}\u0000${t}`
const nm = (k) => (k === END ? '끝' : k)
const fail = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }) }
// 을 · 를 by the last syllable
const eul = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 ? ((c - 0xac00) % 28 ? '을' : '를') : '을(를)' }
const eun = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 ? ((c - 0xac00) % 28 ? '은' : '는') : '은(는)' }
const DESIGN = 'proc:요청 메일 접수'
const SAMPLE = 'said:샘플 자재 요청'
const OUT = '범위 밖이라 하지 않았어요'
const WHYNOT = '적용은 관리자만 할 수 있어요 — 의견으로 남길 수 있어요'
const ROLES = ['영업', '설계', '재무', '대표', '구매', '디자이너', '법무', '현장 관리']

// ---------- ops (the same args the server's refine.js knows, plus set_runner · new_process) ----------
const addTaskOp = (name, role, after) => ({ op: 'add_task', args: { name, role, after }, label: `「${nm(after)}」 뒤에 「${name}」${role ? `(${role})` : ''} 더하기` })
const runnerOp = (task, runner) => ({ op: 'set_runner', args: { task, runner }, label: `「${task}」${eun(task)} ${runner === 'agent' ? '에이전트가' : '사람이'} 해요` })
const sameOps = (a, b) => JSON.stringify((a || []).map((o) => [o.op, o.args])) === JSON.stringify((b || []).map((o) => [o.op, o.args]))

// ---------- flows ----------
function foundFlow(m, key) {
  const p = m.processes.find((x) => x.key === key)
  const keys = new Set(p?.tasks || [])
  return {
    tasks: m.tasks.filter((t) => keys.has(t.key) && t.kind !== 'said').map((t) => ({ key: t.key, role: t.role || '', n: t.n_cases ?? t.n ?? 0, origin: t.key })),
    edges: m.edges.filter((e) => keys.has(e.from) && (e.to === END || keys.has(e.to))).map((e) => ({ from: e.from, to: e.to, n: e.n, p: e.p })),
    entries: (p?.entries || []).slice(),
  }
}
// the process's current decided flow, all of it (the refined one when there is one)
function flowOf(m, key) {
  const F = m.refined?.[key]
  if (!F) return foundFlow(m, key)
  return { tasks: clone(F.tasks || []), edges: clone(F.edges || []), entries: (F.entries || []).slice() }
}
// what a preview draws: decided ways and ways as common as θ, from the starts on
function trim(F, th) {
  const edges = F.edges.filter((e) => e.decided || e.added || (e.p || 0) >= th - 1e-9)
  const keys = new Set(F.tasks.map((t) => t.key))
  const out = new Map()
  for (const e of edges) if (e.to !== END) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e.to)
  const seen = new Set(F.entries.filter((k) => keys.has(k))), st = [...seen]
  if (!seen.size && F.tasks.length) { seen.add(F.tasks[0].key); st.push(F.tasks[0].key) }
  while (st.length) for (const n of out.get(st.pop()) || []) if (!seen.has(n)) { seen.add(n); st.push(n) }
  return {
    tasks: F.tasks.filter((t) => seen.has(t.key)),
    edges: edges.filter((e) => seen.has(e.from) && (e.to === END || seen.has(e.to))),
    entries: F.entries.filter((k) => seen.has(k)),
  }
}
const thOf = (m, key) => Number(m.processes.find((x) => x.key === key)?.summary_theta) || 0

// ops on a Flow → the after with diff marks (removed things stay, marked 'remove') and the plain list of changes
function applyOps(before, ops) {
  const A = clone(before)
  const changes = []
  const T = (k) => A.tasks.find((t) => t.key === k && t.diff !== 'remove')
  const E = (f, t) => A.edges.find((e) => e.from === f && e.to === t && e.diff !== 'remove')
  const link = (f, t, extra = {}) => E(f, t) || (A.edges.push({ from: f, to: t, n: 0, p: 0, added: true, decided: true, unseen: true, diff: 'add', ...extra }), A.edges[A.edges.length - 1])
  const cut = (e) => { if (!e) return; if (e.diff === 'add') A.edges.splice(A.edges.indexOf(e), 1); else e.diff = 'remove' }
  // the way the work mostly goes on from a step (a decided one first)
  const main = (k) => A.edges.filter((e) => e.from === k && e.diff !== 'remove').sort((a, b) => (!!b.decided - !!a.decided) || (b.p || 0) - (a.p || 0))[0] || null
  for (const o of ops || []) {
    const a = o.args || {}
    if (o.op === 'add_task') {
      if (!a.name || T(a.name)) continue
      A.tasks.push({ key: a.name, role: a.role || '', n: 0, origin: null, added: true, decided: true, unseen: true, diff: 'add', ...(a.runner ? { runner: a.runner } : {}) })
      if (a.after && a.before) { cut(E(a.after, a.before)); link(a.after, a.name); link(a.name, a.before) }
      else if (a.after) { const w = main(a.after); cut(w); link(a.after, a.name); link(a.name, w ? w.to : END) }
      else if (a.before) { for (const e of A.edges.filter((x) => x.to === a.before && x.diff !== 'remove')) { cut(e); link(e.from, a.name) } link(a.name, a.before) }
      else { A.entries.push(a.name); link(a.name, END) }
      changes.push({ kind: 'add', text: o.label })
    } else if (o.op === 'add_edge') {
      if (!a.from || !a.to) continue
      link(a.from, a.to, a.cond ? { cond: a.cond } : {})
      changes.push({ kind: 'add', text: o.label })
    } else if (o.op === 'remove_edge') {
      const e = E(a.from, a.to)
      if (!e) continue
      cut(e)
      changes.push({ kind: 'remove', text: o.label })
    } else if (o.op === 'remove_task') {
      const t = T(a.task)
      if (!t) continue
      const ins = A.edges.filter((e) => e.to === a.task && e.from !== a.task && e.diff !== 'remove')
      const outs = A.edges.filter((e) => e.from === a.task && e.to !== a.task && e.diff !== 'remove')
      for (const e of [...ins, ...outs]) cut(e)
      if (t.diff === 'add') A.tasks.splice(A.tasks.indexOf(t), 1); else t.diff = 'remove'
      for (const i of ins) for (const x of outs) if (i.from !== x.to) link(i.from, x.to)
      changes.push({ kind: 'remove', text: o.label })
    } else if (o.op === 'set_runner' || o.op === 'set_role') {
      const t = T(a.task)
      if (!t) continue
      const text = o.op === 'set_runner' ? (a.runner === 'agent' ? '에이전트가 해요' : '사람이 해요') : `맡는 역할 「${t.role || '없음'}」 → 「${a.role}」`
      if (o.op === 'set_runner') t.runner = a.runner; else t.role = a.role
      t.decided = true
      if (t.diff !== 'add') { t.diff = 'change'; t.change = text }
      changes.push({ kind: 'change', text: o.label })
    }
  }
  return { after: A, changes }
}
// a preview's after as a decided Flow (removed things gone, kept in removed)
function strip(after) {
  const removed = { tasks: [], edges: [] }
  const tasks = [], edges = []
  for (const t of after.tasks) {
    if (t.diff === 'remove') { if (t.origin) removed.tasks.push(t.key); continue }
    const { diff, change, was, ...rest } = t
    tasks.push(rest)
  }
  for (const e of after.edges) {
    if (e.diff === 'remove') { if (!e.added) removed.edges.push({ from: e.from, to: e.to }); continue }
    const { diff, change, ...rest } = e
    edges.push(rest)
  }
  return { tasks, edges, entries: after.entries.filter((k) => tasks.some((t) => t.key === k)), removed }
}

// ---------- the map ----------
function addSaid(m, key, name, F) {
  for (const ft of F.tasks) {
    const node = m.tasks.find((t) => t.key === (ft.origin || ft.key))
    if (node) node.procs = [...new Set([...(Array.isArray(node.procs) ? node.procs : node.proc ? [node.proc] : []), key])]
    else m.tasks.push({ key: ft.key, name: ft.key, role: ft.role || '', proc: key, procs: [key], n: 0, n_cases: 0, entry_share: 0, exit_share: 0, kind: 'said', status: 'active', candidate: false, pinned: false, people: 0, aliases: [], sources: {} })
    ft.origin = ft.origin || ft.key
  }
  m.processes.push({ key, name, said: true, kind: 'flow', band: 'said', bandName: '말로 정함', status: 'suggested', cases: 0, tasks: F.tasks.map((t) => t.origin || t.key),
    entries: F.entries.slice(), theta: 0, summary_theta: 0, curve: [], hl_scores: [], summary: '말로 그린 프로세스예요. 아직 지나간 건이 없어요.', opinions: { open: 0, conflicts: 0 } })
  m.refined[key] = { tasks: F.tasks, edges: F.edges, entries: F.entries, removed: { tasks: [], edges: [] }, corrections: 1, said: true }
}
function removeSaid(m, key) {
  m.processes = m.processes.filter((p) => p.key !== key)
  m.tasks = m.tasks.filter((t) => {
    if (!Array.isArray(t.procs) || !t.procs.includes(key)) return true
    t.procs = t.procs.filter((k) => k !== key)
    return t.procs.length > 0 || t.kind !== 'said'
  })
  delete m.refined[key]
}
// the map the page sees (a copy of mock-map's now with these additions); the mock changes it in place
export function liveMap(now) {
  const m = clone(now)
  m.refined = {}
  const F = foundFlow(m, DESIGN)
  const way = F.edges.find((e) => e.from === '고객 회신' && e.to === '계약 의사 확인')
  if (way) way.decided = true
  const quote = F.tasks.find((t) => t.key === '견적서 작성')
  if (quote) Object.assign(quote, { runner: 'agent', decided: true })
  F.tasks.push({ key: '대표 승인', role: '대표', n: 0, origin: null, added: true, decided: true, unseen: true })
  F.edges.push({ from: '재무 검토', to: '대표 승인', n: 0, p: 0, added: true, decided: true, unseen: true, cond: '할인율(discount)이 10% 이상' })
  F.edges.push({ from: '대표 승인', to: '고객 회신', n: 0, p: 0, added: true, decided: true, unseen: true })
  m.refined[DESIGN] = { ...F, entries: ['요청 메일 접수'], removed: { tasks: [], edges: [] }, corrections: 3, said: false }
  const said = (k, role) => ({ key: k, role, n: 0, origin: null, said: true, decided: true, unseen: true })
  const way0 = (f, t) => ({ from: f, to: t, n: 0, p: 0, decided: true, unseen: true })
  addSaid(m, SAMPLE, '샘플 자재 요청', {
    tasks: [said('샘플 요청 접수', '영업'), said('자재 샘플 발송', '구매'), said('고객 확인 전화', '영업')],
    edges: [way0('샘플 요청 접수', '자재 샘플 발송'), way0('자재 샘플 발송', '고객 확인 전화'), way0('고객 확인 전화', END)],
    entries: ['샘플 요청 접수'],
  })
  for (const p of m.processes) p.opinions ||= { open: 0, conflicts: 0 }
  return m
}

// ---------- 말로 고치기 ----------
function newPlan(m, words, answer, ask, admin) {
  let name = '견적 요청 · 대표 승인'
  for (let i = 2; m.processes.some((p) => p.name === name); i++) name = `견적 요청 · 대표 승인 ${i}`
  const steps = [{ key: '견적 요청 접수', role: '영업' }, { key: '견적서 작성', role: '영업', origin: '견적서 작성' }, { key: '대표 승인', role: '대표' }, { key: '고객에게 발송', role: '영업' }]
  const ways = [['견적 요청 접수', '견적서 작성'], ['견적서 작성', '대표 승인', '금액(amount)이 500만 원 이상'], ['견적서 작성', '고객에게 발송', '금액(amount)이 500만 원 미만'], ['대표 승인', '고객에게 발송'], ['고객에게 발송', END]]
  const after = {
    tasks: steps.map((s) => ({ key: s.key, role: s.role, n: 0, origin: s.origin || null, said: true, decided: true, ...(s.origin ? {} : { unseen: true }), diff: 'add' })),
    edges: ways.map(([from, to, cond]) => ({ from, to, n: 0, p: 0, added: true, decided: true, unseen: true, diff: 'add', ...(cond ? { cond } : {}) })),
    entries: ['견적 요청 접수'],
  }
  const ops = [
    { op: 'new_process', args: { name }, label: `새 프로세스 「${name}」 만들기` },
    ...steps.map((s) => ({ op: 'add_task', args: { name: s.key, role: s.role }, label: `「${s.key}」(${s.role}) 더하기` })),
    ...ways.map(([from, to, cond]) => ({ op: 'add_edge', args: { from, to, ...(cond ? { cond } : {}) }, label: `「${from} → ${nm(to)}」 잇기${cond ? ` · ${condText(cond)}일 때` : ''}` })),
  ]
  return {
    scope: 'new', proc: null, words, range: null, name, ops, refused: [],
    matched: [{ said: '견적서 만들기', task: '견적서 작성' }],
    question: ask ? '대표 승인은 금액만 보고 정하나요, 할인율도 보나요?' : '',
    note: answer ? `답한 대로 정했어요 — ${answer}` : '',
    before: null, after,
    changes: [
      { kind: 'add', text: '「견적 요청 접수」(영업)에서 시작해요' },
      { kind: 'add', text: '「견적서 작성」(영업) — 회사에 이미 있는 일로 맞췄어요' },
      { kind: 'add', text: '500만 원 이상이면 「대표 승인」(대표)을 거쳐요' },
      { kind: 'add', text: '「고객에게 발송」(영업)으로 끝나요' },
    ],
    model: 'mock', ms: 1500, canApply: admin, whyNot: admin ? '' : WHYNOT, canVoice: false,
  }
}
function procPlan(m, body, words, answer, ask, admin) {
  const p = m.processes.find((x) => x.key === body.proc) || fail('그런 프로세스가 없어요.', 404)
  const before = trim(flowOf(m, p.key), thOf(m, p.key))
  const keys = before.tasks.map((t) => t.key)
  const range = body.scope && ((body.scope.tasks || []).length || (body.scope.ways || []).length)
    ? { tasks: (body.scope.tasks || []).slice(), ways: (body.scope.ways || []).map((w) => ({ from: w.from, to: w.to })) } : null
  const inRange = (k) => !range || range.tasks.includes(k) || range.ways.some((w) => w.from === k || w.to === k)
  const named = [...keys].sort((a, b) => b.length - a.length).filter((k) => words.includes(k))
  const roleOf = (k) => before.tasks.find((t) => t.key === k)?.role || ''
  const said = ROLES.find((r) => (answer || words).includes(r)) || ''
  const ops = [], refused = []
  const put = (op, k) => (inRange(k) ? ops.push(op) : refused.push({ ...op, why: OUT }))
  let question = ''
  if (/에이전트|AI|자동으로/.test(words)) {
    const targets = range ? range.tasks.filter((k) => keys.includes(k)) : named.slice(0, 1)
    for (const k of targets) put(runnerOp(k, 'agent'), k)
    if (!targets.length) question = '어느 단계를 에이전트가 할까요? 지도에서 단계를 골라 주세요.'
  } else if (/사람이/.test(words)) {
    const targets = range ? range.tasks.filter((k) => keys.includes(k)) : named.slice(0, 1)
    for (const k of targets) put(runnerOp(k, 'person'), k)
  } else if (/빼|없애|지워/.test(words) && (named.length || range?.tasks.length)) {
    const k = named[0] || range.tasks[0]
    put({ op: 'remove_task', args: { task: k }, label: `「${k}」${eul(k)} 이 프로세스에서 빼기` }, k)
  } else {
    // 「X 뒤에 Y를 넣어 줘」
    const mm = /(?:뒤에|다음에|후에)\s*(.+?)\s*(?:을|를)?\s*(?:넣|더하|더해|추가)/.exec(words)
    const name = (mm?.[1] || '결과 보고').replace(/[「」"'.,]/g, '').trim().slice(0, 24) || '결과 보고'
    const after = named.find((k) => !mm || words.indexOf(k) < mm.index + 1) || range?.tasks[0] || keys[keys.length - 1]
    put(addTaskOp(name, said || roleOf(after), after), after)
    if (ask) question = `「${name}」${eun(name)} 누가 맡나요? 정해 주면 그대로 넣을게요.`
  }
  if (ask && !question) question = '지금 말씀대로라면 진행 중인 건은 그대로 두고 새 건부터 바꿔요. 그렇게 할까요?'
  // a range: one thing out of it stays undone (the plausible slip of a model)
  if (range) {
    const outside = keys.find((k) => !inRange(k))
    if (outside) refused.push({ op: 'set_role', args: { task: outside, role: '영업' }, label: `「${outside}」의 맡는 역할 바꾸기`, why: OUT })
  }
  const { after, changes } = applyOps(before, ops)
  return {
    scope: range ? 'range' : 'process', proc: { key: p.key, name: p.name }, words, range, name: '', ops, refused,
    matched: named.length && /만들기|쓰기/.test(words) ? [{ said: named[0].replace('작성', '만들기'), task: named[0] }] : [],
    question, note: answer ? `답한 대로 정했어요 — ${answer}` : '',
    before, after, changes, model: 'mock', ms: 1500,
    canApply: admin && ops.length > 0, whyNot: !admin ? WHYNOT : ops.length ? '' : '지도에서 바꿀 것이 없어요.', canVoice: ops.length > 0,
  }
}

// ---------- 의견 ----------
const at = (s) => new Date(s).toISOString()
function seedOpinions() {
  const base = { proc: DESIGN, caseId: null, task: null, note: '', state: 'open', range: null }
  return [
    { ...base, id: 'op1', words: '재무 검토는 에이전트가 하게 해 주세요. 견적 금액이랑 할인율만 맞춰 보는 일이라서요.', ops: [runnerOp('재무 검토', 'agent')],
      who: { id: 'u-kim', name: '김민지', role: '영업' }, source: 'map', at: at('2026-11-14T02:10:00Z'), agree: 2, agreeWho: ['김민지', '이준호'], range: { tasks: ['재무 검토'], ways: [] } },
    { ...base, id: 'op2', words: '재무 검토는 사람이 꼭 봐야 해요. 할인 조건은 고객마다 달라서 기계로 맞추면 놓쳐요.', ops: [runnerOp('재무 검토', 'person')],
      who: { id: 'u-park', name: '박서연', role: '재무' }, source: 'step', caseId: 'case-0412', task: '재무 검토', at: at('2026-11-15T06:40:00Z'), agree: 1, agreeWho: ['박서연'] },
    { ...base, id: 'op3', words: '고객 회신 뒤에 결과 보고를 넣어 주세요. 팀장님께 매번 따로 알리고 있어요.', ops: [addTaskOp('결과 보고', '영업', '고객 회신')],
      who: { id: 'u-lee', name: '이수진', role: '설계' }, source: 'chat', at: at('2026-11-15T09:05:00Z'), agree: 1, agreeWho: ['이수진'] },
    { ...base, id: 'op4', words: '견적서 작성은 AI가 초안을 써 주면 좋겠어요.', ops: [runnerOp('견적서 작성', 'agent')], state: 'applied', note: '좋아요. 초안은 에이전트가 쓰고, 보내기 전에 영업이 봐요.',
      who: { id: 'u-choi', name: '최도윤', role: '영업' }, source: 'map', at: at('2026-11-08T03:00:00Z'), agree: 3, agreeWho: ['최도윤', '김민지', '이준호'], closedAt: at('2026-11-09T01:00:00Z') },
    { ...base, id: 'op5', words: '팩스 견적 발송은 이제 빼 주세요.', ops: [{ op: 'remove_task', args: { task: '팩스 견적 발송' }, label: '「팩스 견적 발송」을 이 프로세스에서 빼기' }], state: 'declined',
      note: '아직 팩스로만 받는 고객이 있어요. 연말에 다시 봐요.', who: { id: 'u-jung', name: '정하늘', role: '영업' }, source: 'chat', at: at('2026-11-05T05:00:00Z'), agree: 1, agreeWho: ['정하늘'], closedAt: at('2026-11-06T00:30:00Z') },
  ]
}
const GROUPS = [{ id: 'cf1', proc: DESIGN, kinds: ['runner'], why: ['한 사람은 에이전트가, 다른 사람은 사람이 하자고 해요.'], members: ['op1', 'op2'],
  decided: [{ kind: 'requirement', label: '「재무 검토」는 꼭 하는 단계', by: '관리자', why: '돈이 걸린 확인이라 건너뛰지 않아요.', at: at('2026-11-10T01:00:00Z') }] }]

export function editMock(m, { admin = true, record = () => {} } = {}) {
  const opinions = seedOpinions()
  const groups = clone(GROUPS)
  let seq = 0
  const pub = ({ proc, closedAt, ...o }) => clone(o)
  const find = (id) => opinions.find((o) => o.id === id) || fail('그런 의견이 없어요.', 404)
  const close = (o, state, note) => { if (!o || o.state !== 'open') return; o.state = state; o.note = note || ''; o.closedAt = new Date().toISOString() }
  function view(key) {
    const p = m.processes.find((x) => x.key === key)
    const mine = opinions.filter((o) => o.proc === key)
    const open = mine.filter((o) => o.state === 'open')
    const conflicts = groups.filter((g) => g.proc === key).map((g) => ({ g, list: open.filter((o) => g.members.includes(o.id)) })).filter((x) => x.list.length >= 2)
      .map(({ g, list }) => ({ id: g.id, kinds: g.kinds.slice(), why: g.why.slice(), opinions: list.map(pub), decided: clone(g.decided) }))
    const inConf = new Set(conflicts.flatMap((c) => c.opinions.map((o) => o.id)))
    const marks = { tasks: {}, ways: {} }
    const bump = (box, k, conflict) => { const x = box[k] || (box[k] = { n: 0, conflict: false }); x.n += 1; x.conflict ||= conflict }
    for (const o of open) {
      const ts = new Set(), ws = new Set()
      for (const { args: a = {} } of o.ops) {
        const k = a.task || a.after || a.before
        if (k) ts.add(k)
        if (a.from && a.to) ws.add(wid(a.from, a.to))
      }
      for (const k of ts) bump(marks.tasks, k, inConf.has(o.id))
      for (const k of ws) bump(marks.ways, k, inConf.has(o.id))
    }
    const counts = { open: open.length, conflicts: conflicts.length }
    if (p) p.opinions = { ...counts }
    return {
      proc: { key, name: p?.name || key }, admin, conflicts, open: open.filter((o) => !inConf.has(o.id)).map(pub),
      closed: mine.filter((o) => o.state !== 'open').sort((a, b) => String(b.closedAt || b.at).localeCompare(String(a.closedAt || a.at))).map(pub),
      marks, counts,
    }
  }
  // apply ops to a process's whole decided flow (not the trimmed preview) and keep it as the refined flow
  function commit(key, ops) {
    const prev = m.refined[key]
    const { after } = applyOps(flowOf(m, key), ops)
    const F = strip(after)
    m.refined[key] = {
      tasks: F.tasks, edges: F.edges, entries: F.entries.length ? F.entries : prev?.entries || [],
      removed: { tasks: [...(prev?.removed?.tasks || []), ...F.removed.tasks], edges: [...(prev?.removed?.edges || []), ...F.removed.edges] },
      corrections: (prev?.corrections || 0) + ops.length, said: !!prev?.said,
    }
    record(key, ops)
  }
  for (const p of m.processes) view(p.key) // the chips' counts

  // → the response (or a promise of it), or undefined when the path is not ours
  return function edit(path, method, body = {}) {
    if (path === '/ontology/edit/plan' && method === 'POST') {
      const words = String(body.words || '').trim()
      if (!words) fail('무엇을 고칠지 말해 주세요.')
      const answer = String(body.answer || '').trim()
      const ask = /[?？]/.test(words) && !answer
      const plan = body.proc ? procPlan(m, body, words, answer, ask, admin) : newPlan(m, words, answer, ask, admin)
      return wait(1500).then(() => plan)
    }
    if (path === '/ontology/edit/apply' && method === 'POST') {
      if (!admin) fail('적용은 관리자만 할 수 있어요.', 403)
      const ops = body.ops || []
      let proc
      if (!body.proc) {
        const plan = newPlan(m, String(body.words || ''), '', false, true)
        const name = ops.find((o) => o.op === 'new_process')?.args?.name || plan.name
        const key = `said:${name}`
        if (m.processes.some((p) => p.key === key)) fail('같은 이름의 프로세스가 이미 있어요.', 409)
        const F = strip(plan.after)
        addSaid(m, key, name, { tasks: F.tasks, edges: F.edges, entries: F.entries })
        proc = { key, name }
      } else {
        const p = m.processes.find((x) => x.key === body.proc) || fail('그런 프로세스가 없어요.', 404)
        commit(p.key, ops)
        proc = { key: p.key, name: p.name }
      }
      for (const id of body.resolve?.opinions || []) close(opinions.find((o) => o.id === id), 'merged', body.resolve.note)
      view(proc.key)
      return { proc, applied: ops.map((o) => ({ id: `e${++seq}`, op: o.op, label: o.label })), refused: [], said: proc.key.startsWith('said:') }
    }
    let r = /^\/ontology\/said\/([^/]+)$/.exec(path)
    if (r && method === 'DELETE') {
      if (!admin) fail('지우기는 관리자만 할 수 있어요.', 403)
      const key = decodeURIComponent(r[1])
      if (!m.processes.some((p) => p.key === key && p.said)) fail('말로 만든 프로세스가 아니에요.', 404)
      removeSaid(m, key)
      return { removed: key }
    }
    if (path === '/ontology/opinions' && method === 'POST') {
      const words = String(body.words || '').trim()
      if (!body.proc || !words) fail('프로세스와 의견을 함께 보내 주세요.')
      const same = opinions.find((o) => o.proc === body.proc && o.state === 'open' && sameOps(o.ops, body.ops))
      if (same) {
        if (!same.agreeWho.includes('나')) { same.agree += 1; same.agreeWho.push('나') }
        view(body.proc)
        return { opinion: pub(same), agree: same.agree }
      }
      const o = { id: `op${100 + ++seq}`, proc: body.proc, words, ops: clone(body.ops || []), who: { id: 'me', name: admin ? '관리자' : '나', role: admin ? '관리' : '영업' },
        source: body.source || 'map', caseId: body.caseId || null, task: body.task || null, at: new Date().toISOString(), agree: 1, agreeWho: ['나'], state: 'open', note: '', range: body.scope || null }
      opinions.push(o)
      view(body.proc)
      return { opinion: pub(o), agree: 1 }
    }
    r = /^\/ontology\/opinions\/([^/]+)\/preview$/.exec(path)
    if (r && method === 'GET') {
      const o = find(decodeURIComponent(r[1]))
      const before = trim(flowOf(m, o.proc), thOf(m, o.proc))
      const { after, changes } = applyOps(before, o.ops)
      return { before, after, changes, ops: clone(o.ops), refused: [] }
    }
    r = /^\/ontology\/processes\/([^/]+)\/opinions(\/resolve)?$/.exec(path)
    if (r && !r[2] && method === 'GET') return view(decodeURIComponent(r[1]))
    if (r && r[2] && method === 'POST') {
      if (!admin) fail('의견을 정하는 것은 관리자만 할 수 있어요.', 403)
      const key = decodeURIComponent(r[1])
      const note = String(body.note || '').trim()
      if (body.action === 'apply') {
        const o = find(body.opinion)
        if (o.state !== 'open') fail('이미 닫힌 의견이에요.', 409)
        commit(key, o.ops)
        close(o, 'applied', note)
        for (const id of body.opinions || []) if (id !== o.id) close(opinions.find((x) => x.id === id), 'superseded', note)
      } else if (body.action === 'decline') {
        if (!note) fail('거절할 때는 까닭을 적어 주세요.')
        close(find(body.opinion), 'declined', note)
      } else if (body.action === 'keep') {
        if (!note) fail('그대로 둘 때는 까닭을 적어 주세요.')
        for (const id of body.opinions || []) close(opinions.find((x) => x.id === id), 'declined', note)
      } else fail('action 은 apply · decline · keep 이에요.')
      return view(key)
    }
    return undefined
  }
}
