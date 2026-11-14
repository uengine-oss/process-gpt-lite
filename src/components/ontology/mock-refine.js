// 개발용 가짜 응답(?mock=…): 프로세스 다듬기 ① 바로잡기 · ② 단계 가르기 — /ontology/refine/:proc 의 GET · POST · DELETE.
// mock.js 가 부른다(개발 서버에서만 불러오므로 운영 빌드에는 들어가지 않는다).
//   「계약 · 시공 준비」(proc:계약 요청 접수): 손으로 만든 예. 순서가 뒤바뀐 곳 하나(착공 안내 → 자재 발주), 빠진 단계 하나
//     (계약 체결 뒤 계약금 입금 확인 — 처음부터 「제안대로 고침」을 눌러 둔 상태), 기록 탓 하나, 섞인 일 하나. 직접 고친 것 하나.
//   다른 프로세스: mock-map 의 그래프 그대로, AI는 아직 안 본 상태 — 「AI로 살펴보기」를 누르면 몇 초 뒤 간단한 판단이 나온다.
// 다듬은 그래프(refined)는 찾은 그래프(found)에 고침(corrections)을 차례로 적용해 만든다 — 서버가 할 일을 흉내 낸 것.
const END = '__end__'
const HAND = 'proc:계약 요청 접수'
const ME = '관리자'
const iso = (s) => new Date(s).toISOString()
const clone = (x) => JSON.parse(JSON.stringify(x))

// ---------- 손으로 만든 예 ----------
const HAND_FOUND = {
  tasks: [
    { key: '계약 요청 접수', role: '영업', n: 38 },
    { key: '계약서 작성', role: '영업', n: 34 },
    { key: '법무 검토', role: '법무', n: 19 },
    { key: '계약 체결', role: '대표', n: 34 },
    { key: '공정표 작성', role: '현장 관리', n: 20 },
    { key: '자재 발주', role: '구매', n: 28 },
    { key: '협력사 배정', role: '현장 관리', n: 25 },
    { key: '착공 안내', role: '영업', n: 33 },
  ],
  edges: [
    { from: '계약 요청 접수', to: '계약서 작성', n: 34, p: 0.89 },
    { from: '계약 요청 접수', to: END, n: 4, p: 0.11 },
    { from: '계약서 작성', to: '법무 검토', n: 19, p: 0.56 },
    { from: '계약서 작성', to: '계약 체결', n: 15, p: 0.44 },
    { from: '법무 검토', to: '계약 체결', n: 14, p: 0.82 },
    { from: '법무 검토', to: '계약서 작성', n: 3, p: 0.18 },
    { from: '계약 체결', to: '공정표 작성', n: 17, p: 0.5 },
    { from: '계약 체결', to: '자재 발주', n: 17, p: 0.5 },
    { from: '공정표 작성', to: '자재 발주', n: 11, p: 0.55 },
    { from: '공정표 작성', to: '협력사 배정', n: 9, p: 0.45 },
    { from: '자재 발주', to: '공정표 작성', n: 5, p: 0.18 },
    { from: '자재 발주', to: '협력사 배정', n: 19, p: 0.68 },
    { from: '자재 발주', to: '착공 안내', n: 4, p: 0.14 },
    { from: '협력사 배정', to: '착공 안내', n: 25, p: 1 },
    { from: '착공 안내', to: END, n: 27, p: 0.82 },
    { from: '착공 안내', to: '자재 발주', n: 6, p: 0.18 },
  ],
}
const HAND_ISSUES = [
  {
    id: 'i1', kind: 'order', title: '「착공 안내」 뒤에 「자재 발주」가 와요',
    why: '착공을 알린 뒤에 자재를 주문하는 것은 거꾸로예요. 자재가 들어올 날을 보고 착공일을 알려요. 6건은 착공 안내 메일에 발주 확인을 덧붙여 보낸 것이에요.',
    evidence: [
      { at: '2026-10-28T01:20:00Z', said: '고객님, 착공일은 11월 3일로 확정되었습니다. 자재는 내일 발주 넣겠습니다.' },
      { at: '2026-10-09T05:02:00Z', said: '착공 공지 드렸고요, 타일 자재는 오늘 오후에 주문합니다.' },
    ],
    fix: { op: 'reverse_edge', args: { from: '착공 안내', to: '자재 발주' }, label: '화살표를 뒤집어 「자재 발주 → 착공 안내」로' },
  },
  {
    id: 'i2', kind: 'missing', title: '계약금 확인 없이 발주로 가요',
    why: '「계약 체결」 뒤 바로 「자재 발주」로 가는 건이 17건이에요. 메일에는 「입금 확인되면 발주」라는 말이 자주 보이는데, 입금 확인은 은행 알림이라 기록에 남지 않았어요.',
    evidence: [
      { at: '2026-10-30T07:11:00Z', said: '계약금 입금 확인되는 대로 자재 발주 넣겠습니다.' },
      { at: '2026-10-14T00:45:00Z', said: '재무팀, 오늘 들어온 계약금 확인 부탁드려요. 확인되면 발주 진행할게요.' },
    ],
    fix: { op: 'add_task', args: { name: '계약금 입금 확인', role: '재무', after: '계약 체결', before: '자재 발주' }, label: '「계약 체결」과 「자재 발주」 사이에 「계약금 입금 확인」 더하기' },
  },
  {
    id: 'i3', kind: 'artifact', title: '「자재 발주 → 공정표 작성」은 기록 탓이에요',
    why: '발주한 뒤에 공정표를 고쳐 다시 보낸 메일 5건이 순서로 잡혔어요. 공정표는 발주 전에 나와요.',
    evidence: [{ at: '2026-10-22T08:30:00Z', said: '발주 일정 반영해서 공정표 수정본 다시 보내드려요.' }],
    fix: { op: 'remove_edge', args: { from: '자재 발주', to: '공정표 작성' }, label: '「자재 발주 → 공정표 작성」 화살표 끊기' },
  },
  {
    id: 'i4', kind: 'mixed', title: '「착공 안내」에 두 가지 일이 섞여 있어요',
    why: '고객에게 착공일을 알리는 메일과 협력사에 작업을 지시하는 메일이 한 이름으로 묶였어요. 받는 사람과 하는 일이 달라요. 나누는 방법은 아직 손으로 정해 주세요.',
    evidence: [
      { at: '2026-11-01T00:10:00Z', said: '고객님, 착공일은 11월 3일입니다. 당일 오전 현장에 방문드려요.' },
      { at: '2026-11-01T00:25:00Z', said: '반장님, 3일 오전 8시 현장 투입 부탁드립니다. 도면 첨부해요.' },
    ],
    fix: null,
  },
]
const HAND_PROPOSED = {
  steps: [
    { task: '계약 요청 접수', role: '영업' }, { task: '계약서 작성', role: '영업' }, { task: '법무 검토', role: '법무' },
    { task: '계약 체결', role: '대표' }, { task: '계약금 입금 확인', role: '재무' }, { task: '공정표 작성', role: '현장 관리' },
    { task: '자재 발주', role: '구매' }, { task: '협력사 배정', role: '현장 관리' }, { task: '착공 안내', role: '영업' },
  ],
  flows: [
    { from: '계약 요청 접수', to: '계약서 작성' }, { from: '계약서 작성', to: '법무 검토' }, { from: '법무 검토', to: '계약 체결' },
    { from: '계약 체결', to: '계약금 입금 확인' }, { from: '계약금 입금 확인', to: '공정표 작성' }, { from: '공정표 작성', to: '자재 발주' },
    { from: '자재 발주', to: '협력사 배정' }, { from: '협력사 배정', to: '착공 안내' }, { from: '착공 안내', to: END },
  ],
}
const HAND_SUMMARY = '여덟 단계 가운데 순서가 뒤바뀐 곳 하나, 기록 때문에 잘못 읽은 순서 하나, 빠진 단계 하나, 한 이름에 섞인 일 하나를 찾았어요. 계약금 확인을 더하고 착공 안내를 맨 끝으로 두면 실제로 일하는 순서에 가까워져요.'
const HAND_CLASSES = {
  '계약 요청 접수': { class: 'human', why: '고객과 조건을 직접 이야기하는 일이에요.', by: 'ai', decided: false },
  '계약서 작성': { class: 'ai', why: '표준 계약서 양식에 견적 내용을 채우는 일이라 AI가 초안을 만들 수 있어요.', by: 'ai', decided: false },
  '법무 검토': { class: 'skipped', why: '44%(15건)가 법무 검토 없이 체결로 갔어요. 계약 위험을 거르는 확인이라 관문으로 올리길 권해요.', by: 'ai', decided: false },
  '계약 체결': { class: 'gate', why: '대표 날인이에요. 돈과 법이 걸린 승인이라 건너뛸 수 없어요.', by: 'ai', decided: true }, // AI 제안대로 정함
  '계약금 입금 확인': { class: 'gate', why: '돈이 걸린 확인이에요. 입금 전에 발주하면 손실이 날 수 있어요.', by: 'ai', decided: false },
  '공정표 작성': { class: 'human', why: '현장 여건과 협력사 일정을 보고 정하는 판단이 필요해요.', by: 'ai', decided: false },
  '자재 발주': { class: 'ai', why: '공정표와 자재 목록으로 발주서를 만드는 일이에요. 금액이 크면 사람이 확인해요.', by: 'ai', decided: false },
  '협력사 배정': { class: 'human', why: '협력사와 일정 · 단가를 직접 맞추는 일이에요.', by: 'ai', decided: false },
  '착공 안내': { class: 'drop', why: '착공일이 정해지면 고객 안내는 저절로 보낼 수 있고, 협력사는 배정할 때 이미 일정을 받아요(대신 받는 곳: 고객은 자동 안내, 협력사는 배정 메일).', by: 'ai', decided: false },
}

// ---------- 고침 적용(서버 흉내) ----------
export function applyCorrections(found, corrections) {
  let tasks = clone(found.tasks)
  let edges = clone(found.edges)
  const removed = { tasks: [], edges: [] }
  const find = (f, t) => edges.find((e) => e.from === f && e.to === t)
  const cut = (f, t) => {
    const e = find(f, t)
    if (!e) return null
    edges = edges.filter((x) => x !== e)
    if (!e.added) removed.edges.push({ from: f, to: t })
    return e
  }
  const link = (f, t, n = 0, p = 0) => { const e = find(f, t); if (e) e.n += n; else if (f !== t) edges.push({ from: f, to: t, n, p, added: true }) }
  for (const { op, args: a } of corrections) {
    if (op === 'reverse_edge') { const e = cut(a.from, a.to); if (e) link(a.to, a.from, e.n, e.p) }
    else if (op === 'remove_edge') cut(a.from, a.to)
    else if (op === 'add_edge') link(a.from, a.to)
    else if (op === 'rename_task') {
      if (!a.name || tasks.some((t) => t.key === a.name)) continue
      for (const t of tasks) if (t.key === a.task) t.key = a.name
      for (const e of edges) { if (e.from === a.task) e.from = a.name; if (e.to === a.task) e.to = a.name }
    } else if (op === 'merge_task') {
      const t = tasks.find((x) => x.key === a.task), into = tasks.find((x) => x.key === a.into)
      if (!t || !into || t === into) continue
      into.n = (into.n || 0) + (t.n || 0)
      tasks = tasks.filter((x) => x !== t)
      removed.tasks.push(a.task)
      for (const e of edges.filter((x) => x.from === a.task || x.to === a.task)) {
        edges = edges.filter((x) => x !== e)
        const f = e.from === a.task ? a.into : e.from, to = e.to === a.task ? a.into : e.to
        if (f !== to) { const same = find(f, to); if (same) same.n += e.n; else edges.push({ ...e, from: f, to }) }
      }
    } else if (op === 'add_task') {
      if (!a.name || tasks.some((t) => t.key === a.name)) continue
      tasks.push({ key: a.name, role: a.role || '', n: 0, added: true })
      // between two tasks: the flow goes through the new one
      const was = a.after && a.before ? cut(a.after, a.before) : null
      if (a.after) link(a.after, a.name, was?.n || 0, was?.p || 0)
      if (a.before) link(a.name, a.before, was?.n || 0, was ? 1 : 0)
    } else if (op === 'remove_task') {
      const preds = edges.filter((e) => e.to === a.task && e.from !== a.task).map((e) => e.from)
      const succs = edges.filter((e) => e.from === a.task && e.to !== a.task).map((e) => e.to)
      if (!tasks.some((t) => t.key === a.task)) continue
      tasks = tasks.filter((t) => t.key !== a.task)
      edges = edges.filter((e) => e.from !== a.task && e.to !== a.task)
      removed.tasks.push(a.task)
      for (const p of preds) for (const s of succs) if (!find(p, s)) link(p, s)
    }
  }
  return { tasks, edges, removed }
}

const OP_LABEL = {
  reverse_edge: (a) => `화살표를 뒤집어 「${name(a.to)} → ${name(a.from)}」로`,
  remove_edge: (a) => `「${name(a.from)} → ${name(a.to)}」 화살표 끊기`,
  add_edge: (a) => `「${name(a.from)} → ${name(a.to)}」 화살표 잇기`,
  rename_task: (a) => `「${a.task}」 이름을 「${a.name}」(으)로`,
  merge_task: (a) => `「${a.task}」을(를) 「${a.into}」에 합치기`,
  add_task: (a) => `「${a.name}」 더하기${a.after ? ` · 「${a.after}」 뒤` : ''}${a.before ? ` · 「${a.before}」 앞` : ''}`,
  remove_task: (a) => `「${a.task}」 빼기`,
}
const name = (k) => (k === END ? '끝' : k)
const CLASS_KO = { gate: '꼭 하는 관문', human: '사람이 꼭', ai: 'AI가 맡음', drop: '걷어냄', skipped: '건너뛰었지만 해야 함', none: '그 밖' }

// ---------- 다른 프로세스: 간단한 판단 ----------
function guessClass(key) {
  if (/검토|승인|체결|검수|결재/.test(key)) return { class: 'gate', why: '확인 · 승인 단계라 건너뛰면 안 돼요.' }
  if (/전달|취합|팩스|재촉|옮겨/.test(key)) return { class: 'drop', why: '사람이 손으로 옮기던 일이라 AI가 맡으면 사라져요(대신 받는 곳: 다음 단계 담당자).' }
  if (/작성|정리|발송|회신|접수/.test(key)) return { class: 'ai', why: '글 · 양식을 만드는 일이라 AI가 초안을 만들 수 있어요.' }
  return { class: 'human', why: '사람의 판단이나 대면이 필요한 일로 보여요.' }
}
function orderOf(g) {
  const ins = new Set(g.edges.filter((e) => e.from !== e.to).map((e) => e.to))
  const start = g.tasks.filter((t) => !ins.has(t.key)).map((t) => t.key)
  const seen = new Set(), out = [], q = start.length ? start : g.tasks.slice(0, 1).map((t) => t.key)
  while (q.length) {
    const k = q.shift()
    if (seen.has(k) || k === END) continue
    seen.add(k); out.push(k)
    for (const e of [...g.edges].filter((x) => x.from === k).sort((a, b) => (b.p || 0) - (a.p || 0))) q.push(e.to)
  }
  for (const t of g.tasks) if (!seen.has(t.key)) out.push(t.key)
  return out
}

const FEED = ['찾은 흐름을 읽고 있어요', '순서가 상식과 맞는지 보고 있어요', '한 이름에 섞인 일이 있는지 보고 있어요', '기록 때문에 잘못 읽은 곳을 찾고 있어요', '빠진 단계를 찾고 있어요', '단계마다 다섯 가지로 나누고 있어요', '정리하고 있어요']

export function refineMock(map) {
  const states = new Map()
  const fresh = (key) => {
    const p = (map.processes || []).find((x) => x.key === key)
    if (key === HAND) {
      const s = { proc: { key, name: p?.name || '계약 · 시공 준비' }, found: clone(HAND_FOUND), issues: clone(HAND_ISSUES), proposed: clone(HAND_PROPOSED),
        summary: HAND_SUMMARY, made_at: iso('2026-11-14T05:20:00Z'), reviewed: true, classes: clone(HAND_CLASSES), corrections: [], job: null, seq: 0 }
      // 빠진 단계는 이미 「제안대로 고침」, 요청만 받고 끝난 문의는 사람이 직접 끊음
      s.issues[1].status = 'accepted'
      s.corrections.push({ id: 'c1', op: s.issues[1].fix.op, args: s.issues[1].fix.args, label: s.issues[1].fix.label, why: s.issues[1].title, source: 'ai', by: ME, at: iso('2026-11-14T05:31:00Z'), issue: 'i2' })
      s.corrections.push({ id: 'c2', op: 'remove_edge', args: { from: '계약 요청 접수', to: END }, label: OP_LABEL.remove_edge({ from: '계약 요청 접수', to: END }), why: '계약까지 가지 않은 문의라 이 프로세스가 아니에요.', source: 'person', by: '김민지', at: iso('2026-11-14T05:40:00Z') })
      for (const i of s.issues) i.status ||= 'open'
      s.seq = 2
      return s
    }
    const keys = new Set(p?.tasks || [])
    const found = {
      tasks: (map.tasks || []).filter((t) => keys.has(t.key)).map((t) => ({ key: t.key, role: t.role, n: t.n_cases })),
      edges: (map.edges || []).filter((e) => keys.has(e.from) && (e.to === END || keys.has(e.to))).map((e) => ({ from: e.from, to: e.to, n: e.n, p: e.p })),
    }
    return { proc: { key, name: p?.name || key }, found, issues: [], proposed: null, summary: '', made_at: null, reviewed: false, classes: {}, corrections: [], job: null, seq: 0 }
  }
  const stateOf = (key) => states.get(key) || states.set(key, fresh(key)).get(key)

  // the review job: a feed line every second or so, done after about six seconds
  function tick(s) {
    const j = s.job
    if (!j || j.status !== 'running') return
    const sec = (Date.now() - j.t0) / 1000
    j.detail.feed = FEED.slice(0, Math.min(FEED.length, 1 + Math.floor(sec / 0.9))).map((text, i) => ({ at: iso(j.t0 + i * 900), text }))
    if (sec < 6.5) return
    j.status = 'done'
    s.reviewed = true
    s.made_at = new Date().toISOString()
    if (s.proc.key === HAND) {
      // 다시 살펴봐도 같은 판단 — 이미 정한 문제는 그대로
      const was = new Map(s.issues.map((i) => [i.id, i.status]))
      s.issues = clone(HAND_ISSUES).map((i) => ({ ...i, status: was.get(i.id) || 'open' }))
      s.summary = HAND_SUMMARY
      s.proposed = clone(HAND_PROPOSED)
      for (const [k, c] of Object.entries(HAND_CLASSES)) if (!s.classes[k]?.decided) s.classes[k] = clone(c)
    } else {
      const g = applyCorrections(s.found, s.corrections)
      const order = orderOf(g)
      const role = new Map(g.tasks.map((t) => [t.key, t.role]))
      s.summary = '순서에 크게 어긋난 곳은 보이지 않았어요. 드물게 지나간 화살표는 그대로 두었어요.'
      s.issues = []
      s.proposed = { steps: order.map((task) => ({ task, role: role.get(task) || '' })), flows: order.slice(1).map((to, i) => ({ from: order[i], to })) }
      for (const k of order) if (!s.classes[k]?.decided) s.classes[k] = { ...guessClass(k), by: 'ai', decided: false }
    }
  }

  const view = (s) => {
    tick(s)
    const refined = applyCorrections(s.found, s.corrections)
    return {
      proc: s.proc,
      found: clone(s.found),
      refined,
      review: s.reviewed ? { summary: s.summary, issues: clone(s.issues), proposed: clone(s.proposed), model: 'Fable', made_at: s.made_at } : null,
      classes: Object.fromEntries(Object.entries(s.classes).map(([k, { ai, ...c }]) => [k, clone(c)])),
      corrections: s.corrections.map(({ issue, ...c }) => clone(c)),
      job: s.job ? clone({ id: s.job.id, status: s.job.status, detail: s.job.detail }) : null,
    }
  }

  // → the response, or undefined when the path is not ours
  return function refine(path, method, body = {}) {
    const m = /^\/ontology\/refine\/([^/]+)(?:\/(review|issues|corrections|classes)(?:\/([^/]+))?)?$/.exec(path)
    if (!m) return undefined
    const s = stateOf(decodeURIComponent(m[1]))
    const [, , what, id] = m
    const fail = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }) }
    if (!what && method === 'GET') return view(s)
    if (what === 'review' && method === 'POST') {
      if (s.job?.status === 'running') fail('이미 살펴보고 있어요.', 409)
      s.job = { id: `mock-refine-${Date.now()}`, status: 'running', t0: Date.now(), detail: { feed: [] } }
      return { job: { id: s.job.id, status: 'running', detail: s.job.detail } }
    }
    if (what === 'issues' && method === 'POST') {
      const i = s.issues.find((x) => x.id === decodeURIComponent(id || ''))
      if (!i) fail('그런 문제가 없어요.', 404)
      if (body.action === 'accept') {
        if (!i.fix) fail('제안한 고침이 없어요.')
        if (i.status !== 'accepted') s.corrections.push({ id: `c${++s.seq}`, op: i.fix.op, args: clone(i.fix.args), label: i.fix.label, why: i.title, source: 'ai', by: ME, at: new Date().toISOString(), issue: i.id })
        i.status = 'accepted'
      } else if (body.action === 'dismiss') i.status = 'dismissed'
      else fail('action 은 accept · dismiss 예요.')
      return view(s)
    }
    if (what === 'corrections' && method === 'POST') {
      if (!OP_LABEL[body.op]) fail('모르는 고침이에요.')
      s.corrections.push({ id: `c${++s.seq}`, op: body.op, args: clone(body.args || {}), label: OP_LABEL[body.op](body.args || {}), why: body.why || '', source: 'person', by: ME, at: new Date().toISOString() })
      return view(s)
    }
    if (what === 'corrections' && method === 'DELETE') {
      const c = s.corrections.find((x) => x.id === decodeURIComponent(id || ''))
      if (!c) fail('그런 고침이 없어요.', 404)
      s.corrections = s.corrections.filter((x) => x !== c)
      if (c.issue) { const i = s.issues.find((x) => x.id === c.issue); if (i) i.status = 'open' }
      return view(s)
    }
    if (what === 'classes' && method === 'POST') {
      // like the server: the AI's own suggestion is kept; class null goes back to it
      const prev = s.classes[body.task] || {}
      const ai = prev.ai || (prev.class && prev.by === 'ai' ? { class: prev.class, why: prev.why } : null)
      if (body.class == null) { if (ai) s.classes[body.task] = { ...ai, by: 'ai', decided: false, ai }; else delete s.classes[body.task] }
      else s.classes[body.task] = { class: body.class, why: ai?.class === body.class ? ai.why : `사람이 「${CLASS_KO[body.class] || body.class}」(으)로 정했어요.`, by: ai?.class === body.class ? 'ai' : 'person', decided: true, ai }
      return view(s)
    }
    fail(`mock: ${method} ${path}`, 404)
  }
}
