// 사건 → 시작(design-v0.3 §12): 들어온 메일 · 채팅에 쓴 요청 · 채팅에 올린 파일이 회사의 어느 프로세스(들)의 일인가.
// 자동 · 제안인 프로세스를 모두(가장 큰 것 하나가 아니라) 이 사건에 견준다 — 프로세스마다 따로 「이 일을 이번에 해야 하나?」를 첫 토큰 확률로
// 읽으므로(steprule.js readYes, chooseEntry 가 단계마다 읽는 것과 같은 방식) 둘이 함께 「예」일 수 있고, 아무것도 아님도 답이다. 프로세스가
// 많으면 먼저 여러 개 중 고르기 한 번(덩어리마다)으로 후보를 몇 개로 줄이고 그것만 따로 읽는다. 문턱 · 물음은 스킬 규칙 events.
// 「예」인 프로세스마다 시작할 일(chooseEntry)을 고르고 — 자동인 프로세스는 메일이 오면 저절로 시작(건이 여럿일 수 있다), 제안인
// 프로세스는 채팅 카드로 묻는다(onto-entry, 여럿이면 한 카드에). 채팅 요청 · 파일은 사람이 한 일이라 늘 묻기만 한다.
import { q } from '../supa.js'
import { oddsOf } from '../decide.js'
import { mainThread, addMessage } from '../store.js'
import { rules as skillRules } from './discovery.js'
import { readGraph } from './store.js'
import { DECLINE_DEFAULTS, negativeText } from './declines.js'

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
export const KIND_KO = { mail: '메일', chat: '요청', file: '파일', timer: '타이머' }
const DEFAULTS = {
  yes: 0.7, prefilterAbove: 6, chunk: 20, shortlist: 4, shortlistMin: 0.05, maxReads: 6, maxAdopted: 6, maxStarts: 3, textChars: 1500, fileChars: 1200,
  question: '이 {what}이 회사에 해 달라고 하는 일(받아서 확인하는 것 말고 회사가 해 줘야 하는 일)이 다음 단계 중 하나인가: {steps}? (「{name}」 업무) 하나라도 해당하면 예, 아무것도 아니면 아니요.',
  // a request typed in chat (2026-11-28: 「Spec Kit 커리큘럼 설계」 read as 「요청 보고 · 구현」 — a generic process whose steps say 「만들기 · 보고」
  // takes every request to make something): only an instance of that process's own work
  chatQuestion: '이 채팅 요청이 「{name}」 업무의 한 건인가 — 그 업무가 늘 다루는 바로 그 일(같은 대상 · 같은 종류의 결과물)을 해 달라는 것인가?{about} 그 업무의 단계: {steps}. 무언가를 만들어 · 고쳐 · 정리해 · 보고해 달라는 것만으로는 아니다 — 단계 이름과 겹치는 말이 있어도 요청한 일의 종류가 그 업무와 다르면 아니요. 그 업무의 구체적인 일과 같은 종류일 때만 예.',
  pick: '이 {what}은 회사의 어느 업무 흐름(프로세스)의 일인가?',
  none: '어느 업무 흐름의 일도 아니다(질문 · 잡담 · 알림 · 다른 일)',
  // a chat request whose turn already did the work (files made, or the answer did what was asked) is not offered: the card would come under
  // a finished answer (2026-11-28) — read once, before the processes are
  done: {
    question: '이 답이 요청한 일을 이미 해 냈나 — 요청한 결과물을 만들었거나 처리를 끝냈나? 되묻기만 했거나, 하지 못했다고 했거나, 할 일을 말하기만 했으면 아니요.',
    min: 0.7, answerChars: 1500,
  },
  // what people said when they declined a chat card (declines.js): negative examples and resting processes
  declines: DECLINE_DEFAULTS,
}
export const EVENT_DEFAULTS = DEFAULTS
export const eventRules = async () => {
  const own = (await skillRules()).events || {}
  return { ...DEFAULTS, ...own, done: { ...DEFAULTS.done, ...(own.done || {}) }, declines: { ...DEFAULTS.declines, ...(own.declines || {}) } }
}
// a process as the model reads it: its name and its steps (a name alone misleads — 「강의계획서 작성 · 보고」 is named after its first step,
// and a request that needs only its later steps read as 13% for it)
export const stepsText = (p, n = 6) => (p.steps || p.tasks || []).slice(0, n).join(' · ')
export const procLabel = (p) => `${p.name} — 단계: ${stepsText(p, 5)}`
// the steps of a process in their usual order (from its main entry, the most likely next each time), then the rest
export function orderedSteps(p, edges = []) {
  const inP = new Set(p.tasks || []), seen = new Set(), out = []
  for (let x = (p.entries || []).find((k) => inP.has(k)); x && !seen.has(x);) {
    out.push(x); seen.add(x)
    x = edges.filter((e) => e.from === x && inP.has(e.to) && !seen.has(e.to) && e.status !== 'retired').sort((a, b) => (b.p || 0) - (a.p || 0))[0]?.to
  }
  return [...out, ...(p.tasks || []).filter((k) => !seen.has(k))]
}
const what = (ev) => KIND_KO[ev.kind] || '요청'

// the event as the model reads it: what came in, its subject, a file's name and the start of its text, the words with it
export function eventState(ev, R = DEFAULTS) {
  return [
    `회사에 들어온 ${what(ev)}`,
    ev.subject ? `제목: ${String(ev.subject).slice(0, 200)}` : '',
    ev.from ? `보낸 사람: ${String(ev.from).slice(0, 120)}` : '',
    ev.file ? `파일: ${ev.file.name}${ev.file.type ? ` (${ev.file.type})` : ''}` : '',
    ev.file?.excerpt ? `파일 내용 앞부분:\n${String(ev.file.excerpt).slice(0, R.fileChars ?? 1200)}` : '',
    ev.text ? `${ev.kind === 'file' ? '함께 쓴 말' : '내용'}: ${String(ev.text).slice(0, R.textChars ?? 1500)}` : '',
  ].filter(Boolean).join('\n')
}

// the processes an event is read against: every adopted and suggested flow (not a routine), adopted first, then the most cases
export const candidatesOf = (processes = []) => processes.filter((b) => b.kind !== 'routine' && ['adopted', 'suggested'].includes(b.status))
  .sort((a, b) => (a.status === 'adopted' ? 0 : 1) - (b.status === 'adopted' ? 0 : 1) || (b.cases || 0) - (a.cases || 0))

// many processes: one pick per chunk (letters, with 「none」) keeps the likely ones; a chunk that cannot be read keeps its first ones
export async function shortlist(state, procs, R = DEFAULTS, read = oddsOf) {
  const size = Math.max(2, Math.min(24, R.chunk ?? 20))
  const scored = []
  let readings = 0
  for (let i = 0; i < procs.length; i += size) {
    const part = procs.slice(i, i + size)
    const options = [...part.map((p, j) => ({ key: `p${j}`, label: procLabel(p) })), { key: 'none', label: R.none || DEFAULTS.none }]
    const r = await read(state, fill(R.pick, { what: R.what || '요청' }), options).catch(() => null)
    readings++
    part.forEach((p, j) => scored.push({ p, s: r?.probabilities ? r.probabilities[`p${j}`] || 0 : null, none: r?.probabilities?.none ?? null }))
  }
  const min = R.shortlistMin ?? 0.05
  const keep = scored.filter((x) => x.s == null || x.s >= min).sort((a, b) => (b.s ?? -1) - (a.s ?? -1)).slice(0, R.shortlist ?? 4)
  return { keep: keep.map((x) => x.p), scores: scored.map((x) => ({ proc: x.p.key, s: x.s == null ? null : +x.s.toFixed(3) })), readings }
}

// Which processes this event is the work of → {matches: [{proc, name, status, p, measured, choice}], reads, prefilter, none}.
// read: a pick among options (decide.js oddsOf) · yes(state, question): {p, measured} (steprule.js readYes) · entryOf: the start task (run.js chooseEntry)
// An adopted process (it starts by itself) is always read on its own; the pick only narrows the suggested ones — a pick among many
// names leans to a generic one (「요청 접수 · 확인」 took 88% of a lecture request, the lecture process under 3%, measured on jy-mail).
// declines (chat requests only — declines.js forMatching): {negatives: proc → [{request, note}], resting: proc → {until, count}}. A resting
// process (declined as unrelated restAfter times lately) is not read at all; the others are read with their 「관계없어요」 requests after the event.
export async function identify(ev, { procs, R = DEFAULTS, read = oddsOf, yes, entryOf, declines = null } = {}) {
  const state = eventState(ev, R)
  const resting = declines?.resting instanceof Map ? declines.resting : new Map()
  const rested = (procs || []).filter((p) => resting.has(p.key)).map((p) => ({ proc: p.key, name: p.name, ...resting.get(p.key) }))
  const live = (procs || []).filter((p) => !resting.has(p.key))
  const adopted = live.filter((p) => p.status === 'adopted').slice(0, R.maxAdopted ?? 6)
  let rest = live.filter((p) => p.status !== 'adopted')
  let prefilter = null
  if (rest.length > (R.prefilterAbove ?? 6)) {
    prefilter = await shortlist(state, rest, { ...R, what: what(ev) }, read)
    rest = prefilter.keep
  }
  // a chat request is read against a process's own work (chatQuestion), not against its step names
  const question = (ev.kind === 'chat' && R.chatQuestion) || R.question
  const reads = []
  for (const p of [...adopted, ...rest.slice(0, R.maxReads ?? 6)]) {
    const neg = declines?.negatives instanceof Map ? declines.negatives.get(p.key) || [] : []
    const st = neg.length ? `${state}\n\n${negativeText(p, neg, R)}` : state
    const about = clean(p.summary) ? ` 업무 설명: ${clean(p.summary).slice(0, 300)}` : ''
    const r = await yes(st, fill(question, { what: what(ev), name: p.name, steps: stepsText(p), summary: clean(p.summary), about })).catch(() => ({ p: null, measured: false }))
    reads.push({ proc: p.key, name: p.name, status: p.status, p: r?.p ?? null, measured: r?.measured !== false, ...(neg.length ? { negatives: neg.length } : {}) })
  }
  const hits = reads.filter((r) => r.p != null && r.p >= (R.yes ?? 0.6)).sort((a, b) => b.p - a.p)
  const matches = []
  for (const h of hits) {
    const choice = await entryOf({ subject: ev.subject || '', text: [ev.text, ev.file?.excerpt ? `(파일 ${ev.file.name}) ${ev.file.excerpt}` : ''].filter(Boolean).join('\n'), procKey: h.proc }).catch(() => null)
    if (!choice) continue
    const suggested = h.status !== 'adopted'
    matches.push({ ...h, choice: { ...choice, procName: h.name, procP: h.p, ...(suggested ? { suggest: true, ask: true } : {}) } })
  }
  return { state, reads, prefilter, matches, none: !matches.length, ...(rested.length ? { rested } : {}) }
}

// what to do with the matches: an adopted process starts by itself on a mail or a timer (when its start task is sure); everything else is
// offered — a request typed in chat or a file someone attached is a person's own act, never started for them
export function planStarts(matches = [], kind = 'mail', { maxStarts = 3 } = {}) {
  const auto = kind === 'mail' || kind === 'timer'
  const start = [], offer = []
  for (const m of matches) {
    if (auto && m.status === 'adopted' && m.choice && !m.choice.ask && start.length < maxStarts) start.push(m)
    else offer.push(m)
  }
  return { start, offer }
}

// the processes with their steps: an adopted one as a case runs it (refined: its corrections laid on — run.js procGraph), the others as found
async function processes() {
  const g = await readGraph({}).catch(() => null)
  const list = candidatesOf(g?.processes || []).map((p) => ({ ...p, steps: orderedSteps(p, g.edges) }))
  const { procGraph } = await import('./run.js')
  for (const p of list.filter((x) => x.status === 'adopted').slice(0, DEFAULTS.maxAdopted)) {
    const v = await procGraph(p.key).catch(() => null)
    if (v) p.steps = orderedSteps({ ...v.proc, tasks: [...v.tasks.keys()], entries: [...new Set([...(v.proc.entries || []), ...v.tasks.keys()])] }, v.edges)
  }
  return list
}
// procs: the processes when the caller already read them (onChat) · user: whose chat request it is — it is read with that person's own
// declines of each process (declines.js, per person: nobody else's requests or words go into it)
// deps (tests): processes · rules · yes · read · entryOf · declinesOf(userId, R)
export async function routeEvent(ev, { procs: given = null, user = null } = {}, deps = {}) {
  const procs = given || await (deps.processes || processes)()
  if (!procs.length) return { none: true, matches: [], reads: [], prefilter: null, procs: 0 }
  const R = await (deps.rules || eventRules)()
  let SRR = null
  const yes = deps.yes || (async (state, question) => (await import('./steprule.js')).readYes(state, question, SRR ??= (await skillRules()).stepRules || {}))
  const entryOf = deps.entryOf || (async (x) => (await import('./run.js')).chooseEntry(x))
  const declinesOf = deps.declinesOf || (async (uid, rules) => (await import('./declines.js')).forMatching(uid, rules))
  const declines = ev.kind === 'chat' && user?.id ? await declinesOf(user.id, R).catch((e) => { console.warn('[events] declines', e.message); return null }) : null
  const r = await identify(ev, { procs, R, read: deps.read || oddsOf, yes, entryOf, declines })
  console.log(`[events] ${what(ev)} 「${clean(ev.subject || ev.file?.name || ev.text).slice(0, 40)}」: 프로세스 ${procs.length}개${r.rested ? ` · 쉼 ${r.rested.map((x) => `${x.name}(관계없음 ${x.count}번)`).join(', ')}` : ''}${r.prefilter ? ` → 후보 ${r.prefilter.keep.length}개(고르기 ${r.prefilter.readings}번)` : ''} · 읽음 ${r.reads.map((x) => `${x.name} ${x.p == null ? '?' : Math.round(x.p * 100)}%${x.negatives ? `(반례 ${x.negatives})` : ''}`).join(', ') || '-'} → ${r.none ? '없음' : r.matches.map((m) => `${m.name}(${m.status === 'adopted' ? '자동' : '제안'}) 「${m.choice.task}」`).join(' · ')}`)
  return { ...r, procs: procs.length }
}

// started cases and offered processes, as cards in the person's chat (one card per started case, one card for all offered)
async function dispatch({ me, ev, r, threadId, extra = {} }) {
  const R = await eventRules()
  const { start, offer } = planStarts(r.matches, ev.kind, R)
  const { startCase } = await import('./run.js')
  const customer = ev.kind === 'mail' ? String(ev.from || '').split('<')[0].trim() || '고객' : ''
  const body = [ev.text, ev.file?.excerpt ? `[첨부 파일 ${ev.file.name}]\n${ev.file.excerpt}` : ''].filter(Boolean).join('\n\n')
  const mail = { from: ev.from || '', subject: ev.subject || '', text: String(body).slice(0, 1500) }
  const started = []
  for (const m of start) {
    const c = await startCase(me, { procKey: m.proc, entry: m.choice.task, subject: ev.subject || '', body, from: ev.from || '', customer, odds: m.choice, kind: ev.kind })
    await addMessage(me.id, threadId, 'agent', 'onto-entry', { state: 'started', ...(ev.kind === 'mail' ? {} : { source: ev.kind }), mail: { from: mail.from, subject: mail.subject }, customer, choice: m.choice,
      caseId: c.caseId, instId: c.instId, skipped: c.snapshot.skipped, nodes: c.snapshot.nodes, procDefId: c.snapshot.procDefId, engine: c.engine || 'bpm',
      // who does each role (bindings.js) — the card shows them with 「바꾸기」, so a wrong person is caught now, not handed over later
      bindings: c.bindings || null, ...extra })
    if (c.snapshot.procDefId) await addMessage(me.id, threadId, 'agent', 'process', { defId: c.snapshot.procDefId, name: c.instName, state: 'started', instId: c.instId, instName: c.instName })
    started.push({ caseId: c.caseId, instId: c.instId, proc: m.proc, task: m.choice.task, engine: c.engine || 'bpm' })
  }
  let asked = null
  if (offer.length) {
    asked = await addMessage(me.id, threadId, 'agent', 'onto-entry', { state: 'ask', ...(ev.kind === 'mail' ? {} : { source: ev.kind }), mail, customer,
      choice: offer[0].choice, ...(offer.length > 1 ? { choices: offer.map((o) => o.choice) } : {}), ...(offer.every((o) => o.choice.suggest) ? { suggest: true } : {}),
      ...(ev.file ? { file: { name: ev.file.name, type: ev.file.type || '', url: ev.file.url || '' } } : {}),
      // the same event already started an adopted process: the card says so (its own card is just above)
      ...(started.length ? { startedAlso: start.map((m, i) => ({ proc: m.proc, procName: m.name, task: m.choice.task, caseId: started[i].caseId })) } : {}), ...extra })
  }
  return { ...(started[0] || {}), started, offered: offer.map((o) => ({ proc: o.proc, name: o.name, task: o.choice.task, status: o.status })), asked: !!asked, messageId: asked?.id || null,
    reads: r.reads, prefilter: r.prefilter ? { kept: r.prefilter.keep.map((p) => p.key), readings: r.prefilter.readings } : null }
}

// a mail that came in (lib/mail.js · the simulated mail of routes/ontology.js): false when no process takes it (process mining's flows then may)
export async function onMail(userId, mail) {
  const [p] = await q('select email, name from pro_profile where user_id=$1', [userId])
  if (!p?.email) return false
  const ev = { kind: 'mail', subject: mail.subject || '', text: mail.text || '', from: mail.from || '' }
  const r = await routeEvent(ev)
  if (r.none) return false
  const t = await mainThread(userId)
  return dispatch({ me: { id: userId, email: p.email }, ev, r, threadId: t.id })
}

// Did the turn already carry the request out? → {done, why, p}. A turn that made files did (counted, no model); otherwise the model reads
// the request and the start of the answer (done.question, yes at done.min). Nothing read: not done — the usual path (the card is offered).
export async function turnDidWork({ said = '', answer = '', made = 0 } = {}, R = DEFAULTS, yes = null) {
  if (Number(made) > 0) return { done: true, why: 'made', p: null }
  const text = clean(answer)
  if (!text) return { done: false, why: 'no-answer', p: null }
  const D = { ...DEFAULTS.done, ...(R.done || {}) }
  const read = yes || (async (state, question) => (await import('./steprule.js')).readYes(state, question, (await skillRules()).stepRules || {}))
  const state = [`채팅에 쓴 요청: ${String(said).slice(0, R.textChars ?? 1500)}`, `그 요청에 한 답(앞부분): ${text.slice(0, D.answerChars ?? 1500)}`].join('\n\n')
  const r = await read(state, D.question).catch(() => null)
  const p = r?.p ?? null
  return { done: p != null && p >= (D.min ?? 0.7), why: 'read', p }
}

// a new request typed in chat (run.js chatSuggest: once per conversation, after the turn): offered only — and not when the turn already did it
// (answer: the turn's saved answer · made: how many file cards the turn posted). deps (tests): processes · rules · didWork · route · post
export async function onChat({ user, threadId, said, conv, answer = '', made = 0 }, deps = {}) {
  const ev = { kind: 'chat', subject: String(said).split('\n')[0].slice(0, 80), text: String(said || '') }
  if (Number(made) > 0) { console.log(`[events] 요청 「${clean(ev.subject).slice(0, 40)}」: 이 턴이 파일 ${made}개를 만들었어요 — 권하지 않음`); return null }
  const procs = await (deps.processes || processes)()
  if (!procs.length) return null
  const R = await (deps.rules || eventRules)()
  const did = await (deps.didWork || turnDidWork)({ said, answer, made }, R)
  if (did.done) { console.log(`[events] 요청 「${clean(ev.subject).slice(0, 40)}」: 답이 이미 해 냄(${Math.round((did.p || 0) * 100)}%) — 권하지 않음`); return null }
  const r = await (deps.route || routeEvent)(ev, { procs, user })
  if (r.none) return null
  return (deps.post || dispatch)({ me: user, ev, r, threadId, extra: { conv: conv || '' } })
}

// a file attached in chat (lib/agent.js, as the message arrives; or POST /ontology/events/file with an upload): its name, type, the start
// of its text (mailbody.js readFile — xlsx · docx · pptx · hwpx · csv · txt; md · json as text) and the words typed with it. Offered only.
export async function readUpload(file) {
  const fs = await import('node:fs/promises')
  const { workspaceHostPath } = await import('../missions.js')
  const { readFile } = await import('./mailbody.js')
  const root = await workspaceHostPath('/workspace')
  const rel = String(file.path || '')
  if (!rel.startsWith('/workspace/')) return ''
  const buf = await fs.readFile(root + rel.slice('/workspace'.length)).catch(() => null)
  if (!buf) return ''
  if (/\.(md|json|log|text)$/i.test(file.name || '')) return buf.toString('utf8')
  const r = await readFile(file.name || rel.split('/').pop(), buf)
  return String(r.text || (r.labels || []).join(' | ') || '')
}
export async function onFile({ user, threadId, files = [], said = '' }) {
  const f = (files || []).find((x) => x?.name)
  if (!f) return null
  const R = await eventRules()
  const excerpt = clean(await readUpload(f).catch(() => '')).slice(0, R.fileChars ?? 1200)
  const others = files.filter((x) => x !== f && x?.name).map((x) => x.name)
  const ev = { kind: 'file', subject: f.name, text: [said, others.length ? `(함께 올린 파일: ${others.join(', ')})` : ''].filter(Boolean).join('\n'), file: { name: f.name, type: f.type || '', url: f.url || '', excerpt } }
  const r = await routeEvent(ev)
  if (r.none) return { none: true, reads: r.reads }
  return dispatch({ me: user, ev, r, threadId: threadId || (await mainThread(user.id)).id })
}
