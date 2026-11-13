// 규정 · 업무 정의서로 프로세스 찾기(design-v0.3 §17): 회사가 올린 문서(PDF · 한글 · 워드 · 파워포인트 · 엑셀 · 텍스트)가 말하는 절차를
// 회사 지도에 함께 둔다. 문서를 읽는 일은 process-gpt 의 문서 읽기(bpmn-extractor PDF2BPMN 의 EntityExtractor, bridge/extract_doc.py)가
// 하고 — 프로세스 · 일 · 역할 · 순서 · 조건 — 여기서는 그 결과를 메일 · 인계로 찾은 일의 이름에 맞춰 놓는다.
//   Document -[DESCRIBES]-> Procedure -[HAS_STEP]-> Step -[THEN {cond}]-> Step,  Step -[SAME_AS]-> Task (같은 일)
// 문서의 절차는 셈으로 찾은 Process 와 섞지 않는다(다시 셈해도 그대로 남는다). 화면은 절차마다 「문서대로 · 실제로」를 나란히 보여 준다:
// 문서의 단계 중 메일에서도 보이는 것, 문서에만 있는 것, 그 절차와 가장 많이 겹치는 실제 프로세스에서 문서에 없는 일.
import { spawn } from 'node:child_process'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { PGPT_ROOT } from '../paths.js'
import { extract, kindOf } from '../folders/indexer.js'
import { cypher, ensureGraph } from './store.js'
import { resolveLabels } from './names.js'
import { rules as skillRules } from './discovery.js'
import { sayer } from './feed.js'
import { emit } from '../bus.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const T = () => config.tenantId
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16)
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
export const KINDS = ['pdf', 'docx', 'hwpx', 'pptx', 'xlsx', 'txt', 'md', 'csv']

// the document's text in parts the reader takes at once (paragraphs kept whole)
export function chunksOf(text, size = 6000, max = 20) {
  const paras = String(text || '').replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const out = []
  let cur = ''
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) { out.push(cur); cur = '' }
    cur = cur ? `${cur}\n\n${p}` : p.slice(0, size * 2)
  }
  if (cur) out.push(cur)
  return out.slice(0, max)
}

// process-gpt's document reader on the chunks (Lite's own model endpoint), with each chunk's progress
export function readWithPdf2bpmn(chunks, existing, onChunk) {
  return new Promise((resolve, reject) => {
    const py = spawn(`${PGPT_ROOT}/services/deepagents/.venv/bin/python`, [path.join(here, '..', '..', 'bridge', 'extract_doc.py')], {
      env: { ...process.env, PGPT_ROOT, OPENAI_API_KEY: config.llm.apiKey || '', LLM_BASE_URL: config.llm.baseUrl || '', LLM_MODEL: config.llm.model || '' },
    })
    let out = '', err = ''
    py.stdout.on('data', (d) => { out += d })
    py.stderr.on('data', (d) => {
      err += d
      for (const m of String(d).matchAll(/chunk (\d+)\/(\d+)/g)) onChunk?.(Number(m[1]), Number(m[2]))
    })
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.split('\n').filter((l) => l && !/^\s*⏱️/.test(l)).slice(-3).join(' | ') || `exit ${code}`))
      try { resolve(JSON.parse(out.trim().split('\n').pop())) } catch { reject(new Error((out + err).slice(-400))) }
    })
    py.stdin.end(JSON.stringify({ chunks, existing }))
  })
}

// the extractor's entities as procedures: [{name, description, trigger, steps:[{name, role, order, description, evidence}], then:[{from, to, cond}]}]
export function proceduresOf(ent, docName) {
  const lc = (s) => clean(s).toLowerCase()
  const procs = new Map()
  const procOf = (name) => {
    const k = lc(name)
    if (!procs.has(k)) procs.set(k, { name: clean(name), description: '', trigger: '', steps: new Map(), then: [] })
    return procs.get(k)
  }
  for (const p of ent.processes || []) if (clean(p.name)) Object.assign(procOf(p.name), { description: clean(p.description).slice(0, 400) })
  const roleOf = new Map((ent.task_role_mappings || []).map((m) => [lc(m.task_name), clean(m.role_name)]))
  const inProc = new Map((ent.task_process_mappings || []).map((m) => [lc(m.task_name), clean(m.process_name)]))
  const only = procs.size === 1 ? [...procs.values()][0].name : ''
  const homeless = `${docName.replace(/\.[^.]+$/, '')}의 절차`
  const where = new Map()
  for (const t of ent.tasks || []) {
    const n = clean(t.name)
    if (!n) continue
    const p = procOf(inProc.get(lc(n)) || clean(t.parent_process) || only || homeless)
    if (!p.steps.has(lc(n))) {
      p.steps.set(lc(n), { name: n.slice(0, 40), role: (roleOf.get(lc(n)) || clean(t.role) || '').slice(0, 30), order: Number(t.order) || p.steps.size + 1,
        description: clean(t.description).slice(0, 300), evidence: clean(t.evidence).slice(0, 240) })
    }
    where.set(lc(n), p)
  }
  // flows: a gateway between two steps is passed through (its condition stays on the flow out of it)
  const flows = (ent.sequence_flows || []).map((f) => ({ from: lc(f.from_task), to: lc(f.to_task), cond: clean(f.condition).slice(0, 80) })).filter((f) => f.from && f.to)
  const into = (x) => flows.filter((f) => f.to === x)
  const stepsFrom = (x, seen = new Set()) => {
    if (where.has(x)) return [x]
    if (seen.has(x)) return []
    seen.add(x)
    return into(x).flatMap((f) => stepsFrom(f.from, seen))
  }
  for (const f of flows) {
    if (!where.has(f.to)) continue
    const p = where.get(f.to)
    for (const a of stepsFrom(f.from)) {
      if (a === f.to || where.get(a) !== p) continue
      const s = p.steps.get(a).name, t = p.steps.get(f.to).name
      if (!p.then.some((x) => x.from === s && x.to === t)) p.then.push({ from: s, to: t, cond: f.cond })
    }
  }
  for (const e of ent.events || []) {
    const kind = lc(e.event_type || e.type)
    if (!/start/.test(kind) || !clean(e.name)) continue
    const p = procs.size === 1 ? [...procs.values()][0] : null
    if (p && !p.trigger) p.trigger = clean(e.description || e.name).slice(0, 120)
  }
  return [...procs.values()].filter((p) => p.steps.size).map((p) => ({ ...p, steps: [...p.steps.values()].sort((a, b) => a.order - b.order) }))
}

async function putNode(label, key, props, w) {
  const [have] = await cypher(`MATCH (x:${label} {key:$key}) RETURN x.key AS key`, { key })
  const names = Object.keys(props)
  if (have) { if (names.length) await cypher(`MATCH (x:${label} {key:$key}) SET ${names.map((k) => `x.${k}=$${k}`).join(', ')} RETURN x.key AS key`, { key, ...props }, w); return }
  await cypher(`CREATE (x:${label} {key:$key${names.map((k) => `, ${k}:$${k}`).join('')}}) RETURN x.key AS key`, { key, ...props }, w)
}
async function link(rel, [a, from], [b, to], props, w) {
  const names = Object.keys(props || {})
  const [have] = await cypher(`MATCH (a:${a} {key:$from})-[r:${rel}]->(b:${b} {key:$to}) RETURN a.key AS key`, { from, to })
  if (have) { if (names.length) await cypher(`MATCH (a:${a} {key:$from})-[r:${rel}]->(b:${b} {key:$to}) SET ${names.map((k) => `r.${k}=$${k}`).join(', ')} RETURN a.key AS key`, { from, to, ...props }, w); return }
  await cypher(`MATCH (a:${a} {key:$from}), (b:${b} {key:$to}) CREATE (a)-[r:${rel}${names.length ? ` {${names.map((k) => `${k}:$${k}`).join(', ')}}` : ''}]->(b) RETURN a.key AS key`, { from, to, ...props }, w)
}

// Read one uploaded document into the map (pro_onto_jobs kind 'document', progress lines in its feed). Returns the job id at once.
export async function startDocument(me, { name, buf }) {
  const kind = kindOf(name)
  if (!KINDS.includes(kind)) throw Object.assign(new Error(`${KINDS.join(' · ')} 문서만 읽을 수 있어요.`), { status: 400 })
  if (!buf?.length) throw Object.assign(new Error('빈 파일이에요.'), { status: 400 })
  const [job] = await q(`insert into pro_onto_jobs (tenant_id, user_id, kind, detail) values ($1,$2,'document',$3) returning id`, [T(), me.id, { name }])
  const tenant = T()
  readDocument(me, job.id, name, buf).catch(async (e) => {
    console.warn('[ontology] document', e.message)
    await q(`update pro_onto_jobs set status='failed', error=$2, finished_at=now() where id=$1`, [job.id, String(e.message).slice(0, 500)]).catch(() => {})
  }).finally(() => emit(me.id, 'ontology', { job: job.id, tenant }))
  return { job: job.id }
}

export async function readDocument(me, jobId, name, buf) {
  const say = sayer(jobId, 30)
  const update = (set, args) => q(`update pro_onto_jobs set ${set} where id=$1`, [jobId, ...args])
  const R = (await skillRules()).documents || {}
  await ensureGraph()
  const { text, pages } = await extract(name, buf)
  if (!clean(text)) throw new Error('문서에서 글자를 읽지 못했어요(스캔한 그림만 있는 PDF 일 수 있어요).')
  const chunks = chunksOf(text, R.chunkChars || 6000, R.maxChunks || 20)
  await update('total=$2', [chunks.length])
  await say(`「${name}」을 펼쳤어요 — ${pages}쪽, 글자 ${text.length.toLocaleString('ko-KR')}자를 ${chunks.length}부분으로 나눠 읽어요.`)
  // the company's words first: the work and roles the map already has, so the document speaks the same names
  const existing = {
    processes: (await cypher(`MATCH (p:Process) WHERE p.status <> 'gone' RETURN p.name AS n`).catch(() => [])).map((r) => r.n).filter(Boolean),
    roles: (await cypher('MATCH (r:Role) RETURN r.name AS n').catch(() => [])).map((r) => r.n).filter(Boolean),
    tasks: (await cypher('MATCH (t:Task) RETURN t.name AS n, t.role AS role').catch(() => [])).map((r) => ({ name: r.n, role: r.role || '' })).filter((t) => t.name),
  }
  if (existing.tasks.length) await say(`지도에 있는 일 ${existing.tasks.length}개 · 역할 ${existing.roles.length}개의 이름을 함께 넘겨, 같은 일이면 같은 이름으로 읽게 해요.`)
  const ent = await readWithPdf2bpmn(chunks, existing, (i, n) => {
    update('done=$2', [i - 1]).catch(() => {})
    say(`${n}부분 중 ${i}번째를 읽는 중이에요 — process-gpt 의 문서 읽기(PDF2BPMN).`, 'chunk')
  })
  await update('done=$2', [chunks.length])
  const procs = proceduresOf(ent, name)
  if (!procs.length) throw new Error('문서에서 업무 절차를 찾지 못했어요.')
  await say(`프로세스 ${procs.length}개, 단계 ${procs.reduce((n, p) => n + p.steps.length, 0)}개, 역할 ${new Set(procs.flatMap((p) => p.steps.map((s) => s.role).filter(Boolean))).size}개를 찾았어요.`)

  // each step under the company's name for that work (the same naming the mail and the chat handovers go through)
  const named = await resolveLabels(procs.flatMap((p) => p.steps.map((s) => ({ raw: s.name, hint: 'deliver' }))))
  const tasks = new Map((await cypher('MATCH (t:Task) RETURN t.key AS key, t.name AS name, t.n_cases AS n').catch(() => [])).map((r) => [r.name || r.key, { key: r.key, n: r.n || 0 }]))
  const mined = (await cypher(`MATCH (p:Process) WHERE p.status <> 'gone' RETURN p.key AS key, p.name AS name, p.tasks AS tasks, p.cases AS cases`).catch(() => []))
    .map((p) => ({ ...p, tasks: p.tasks || [] }))

  const w = { actor: me.email || me.id, reason: `문서 「${name}」` }
  const docKey = `doc:${sha(name)}`
  await putNode('Document', docKey, { name, kind: kindOf(name), pages, chars: text.length, by: me.email || '', at: new Date().toISOString() }, w)
  const out = []
  for (const p of procs) {
    const key = `procedure:${sha(`${docKey}|${p.name}`)}`
    const steps = p.steps.map((s) => {
      const task = named.get(clean(s.name))?.task || ''
      return { ...s, task, seen: !!(task && tasks.has(task)) }
    })
    const stepTasks = new Set(steps.filter((s) => s.seen).map((s) => s.task))
    const best = mined.map((m) => ({ ...m, hit: m.tasks.filter((t) => stepTasks.has(t)).length })).sort((a, b) => b.hit - a.hit || (b.cases || 0) - (a.cases || 0))[0]
    const match = best?.hit ? { process: best.key, name: best.name, coverage: Math.round((best.hit / steps.length) * 100) / 100, onlyMail: best.tasks.filter((t) => !steps.some((s) => s.task === t)) } : null
    await putNode('Procedure', key, { name: p.name, description: p.description, trigger: p.trigger, doc: name, steps: steps.length, seen: steps.filter((s) => s.seen).length,
      process: match?.process || '', process_name: match?.name || '', coverage: match?.coverage || 0, only_mail: match?.onlyMail || [] }, w)
    await link('DESCRIBES', ['Document', docKey], ['Procedure', key], {}, w)
    for (const s of steps) {
      const sk = `step:${sha(`${key}|${s.name}`)}`
      await putNode('Step', sk, { name: s.name, role: s.role, order: s.order, description: s.description, evidence: s.evidence, task: s.task, proc: key }, w)
      await link('HAS_STEP', ['Procedure', key], ['Step', sk], { order: s.order }, w)
      if (s.seen) await link('SAME_AS', ['Step', sk], ['Task', tasks.get(s.task).key], {}, w)
    }
    for (const f of p.then) await link('THEN', ['Step', `step:${sha(`${key}|${f.from}`)}`], ['Step', `step:${sha(`${key}|${f.to}`)}`], { cond: f.cond }, w)
    const seen = steps.filter((s) => s.seen).length
    await say(match
      ? `「${p.name}」 — 문서의 단계 ${steps.length}개 중 ${seen}개가 메일 · 인계에서도 보여요. 가장 닮은 실제 흐름은 「${match.name}」${match.onlyMail.length ? `, 문서에 없는 일 ${match.onlyMail.length}개` : ''}.`
      : `「${p.name}」 — 단계 ${steps.length}개. 메일 · 인계에서 아직 같은 일을 찾지 못했어요.`, 'procedure')
    out.push({ key, name: p.name, steps: steps.length, seen, match })
  }
  await say('문서를 지도에 함께 두었어요. 「문서」 탭에서 문서대로와 실제를 나란히 볼 수 있어요.')
  await update(`status='done', finished_at=now(), detail=coalesce(detail,'{}'::jsonb) || $2::jsonb`, [{ procedures: out.map(({ key, name, steps, seen }) => ({ key, name, steps, seen })) }])
  return out
}

// the documents and their procedures, each next to what the mail and the chat showed
export async function documents() {
  const docs = await cypher('MATCH (d:Document) RETURN d').catch(() => [])
  const procs = await cypher('MATCH (d:Document)-[:DESCRIBES]->(p:Procedure) RETURN d.key AS doc, p').catch(() => [])
  const steps = await cypher('MATCH (p:Procedure)-[h:HAS_STEP]->(s:Step) RETURN p.key AS proc, s').catch(() => [])
  const then = await cypher('MATCH (p:Procedure)-[:HAS_STEP]->(a:Step)-[r:THEN]->(b:Step) RETURN p.key AS proc, a.name AS from, b.name AS to, r.cond AS cond').catch(() => [])
  const taskN = new Map((await cypher('MATCH (t:Task) RETURN t.name AS name, t.n_cases AS n').catch(() => [])).map((r) => [r.name, r.n || 0]))
  return {
    documents: docs.map((r) => r.d).sort((a, b) => String(b.at).localeCompare(String(a.at))),
    procedures: procs.map(({ doc, p }) => ({
      ...p, doc_key: doc, only_mail: p.only_mail || [],
      steps: steps.filter((s) => s.proc === p.key).map((s) => ({ ...s.s, seen: !!(s.s.task && taskN.has(s.s.task)), n_cases: taskN.get(s.s.task) || 0 })).sort((a, b) => a.order - b.order),
      then: then.filter((t) => t.proc === p.key).map(({ from, to, cond }) => ({ from, to, cond: cond || '' })),
    })),
  }
}
