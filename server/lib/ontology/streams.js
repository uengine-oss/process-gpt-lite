// 건 이어 묶기(design-v0.3 §22): 메일 스레드 하나 · 대화 대상 하나가 한 「건」이라, 같은 고객 · 프로젝트의 일이 여러 건으로 끊기고
// 지도에는 일 하나짜리 흐름이 많이 남는다. 건마다 대상(메일 제목 · 대화 대상) · 상대 회사 도메인 · 사람의 역할 · 일 · 첨부 종류 · 기간을
// 모아, 프로세스 찾기 스킬의 prompts/link-cases.md 로 같은 일의 줄기(같은 고객 · 프로젝트 · 목적)를 정한다. 정기 보고 · 뉴스레터 같은
// 루틴은 묶지 않는다. 줄기 안에서 rules.streams.gapDays 일 넘게 끊기면 다음 덩어리.
// 결과는 pro_case_links(sql/037)에 — 지도 셈(build.js loadEvents)이 건 id 를 덩어리 id 로 바꿔 센다. 다시 셀 때는 새 건(또는 다른 판으로
// 읽은 건)만 모델이 본다.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { chatJson } from '../llm.js'
import { maskPii } from '../policy/pii.js'
import { prompt, rules as skillRules, discoverySkill } from './discovery.js'

const T = () => config.tenantId
const sha = (s, n = 12) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n)
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const day = (d) => new Date(d).toISOString().slice(0, 10)
const domainOf = (a) => String(a || '').toLowerCase().match(/@([^>\s]+)>?\s*$/)?.[1] || ''

// the case → its chunk, for the map (loadEvents): only chunks that join more than one case change anything
export async function caseLinks() {
  const rows = await q(`select case_id, stream_id from pro_case_links l where tenant_id=$1 and stream_id is not null
                          and (select count(*) from pro_case_links x where x.tenant_id=l.tenant_id and x.stream_id=l.stream_id) > 1`, [T()]).catch(() => [])
  return new Map(rows.map((r) => [r.case_id, r.stream_id]))
}

// every case with what tells cases apart: its subjects, the outside domains, the roles, the work, the files, the time
export async function caseCatalog({ companyDomains = [] } = {}) {
  const labels = new Map((await q(`select raw, task from pro_onto_labels where tenant_id=$1 and task <> ''`, [T()])).map((r) => [r.raw, r.task]))
  const mh = await q(`select h.case_id, h.occurred_at, h.from_addr, h.to_addrs, h.from_role, h.to_role, h.activity_label, h.artifacts, h.attrs, a.subject
                        from pro_mail_history h left join pro_mail_archive a on a.tenant_id=h.tenant_id and a.owner_id=h.owner_id and a.mail_id=h.mail_id
                       where h.tenant_id=$1 order by h.occurred_at`, [T()])
  const ho = await q(`select case_id, occurred_at, from_role, to_role, coalesce(nullif(activity_label,''), instruction) as raw, instruction from handover_events where tenant_id=$1 order by occurred_at`, [T()]).catch(() => [])
  const own = new Set(companyDomains.map((d) => d.toLowerCase()))
  const by = new Map()
  const at = (id) => { if (!by.has(id)) by.set(id, { id, from: null, to: null, n: 0, tasks: [], subjects: new Set(), partners: new Set(), roles: new Set(), files: new Set(), sources: new Set() }); return by.get(id) }
  const add = (c, when, task, roles, subject, partners = [], files = [], source) => {
    const t = new Date(when).getTime()
    c.from = c.from == null ? t : Math.min(c.from, t); c.to = c.to == null ? t : Math.max(c.to, t); c.n++
    if (task && c.tasks.at(-1) !== task) c.tasks.push(task)
    for (const r of roles) if (r && r !== '담당자') c.roles.add(r)
    if (subject) c.subjects.add(maskPii(clean(subject).replace(/^((re|fw|fwd|회신|답장|전달)\s*[:：]\s*)+/i, '')).slice(0, 80))
    for (const p of partners) if (p && !own.has(p)) c.partners.add(p)
    for (const f of files) if (f) c.files.add(f)
    c.sources.add(source)
  }
  for (const r of mh) {
    const chat = r.attrs?.source === 'chat'
    add(at(r.case_id), r.occurred_at, labels.get(r.activity_label) || r.activity_label, [r.from_role, r.to_role], chat ? r.attrs?.subject : r.subject,
      chat ? [] : [domainOf(r.from_addr), ...(r.to_addrs || []).map(domainOf)], (r.artifacts || []).map((f) => f?.type || ''), chat ? 'chat' : 'mail')
  }
  for (const r of ho) add(at(r.case_id), r.occurred_at, labels.get(clean(r.raw)) || clean(r.raw).slice(0, 30), [r.from_role, r.to_role], r.instruction, [], [], 'handover')
  return [...by.values()].sort((a, b) => a.from - b.from)
}

// a chunk: the cases of one stream, until it has been quiet for gapDays
export function chunksOf(assigned, gapDays = 45) {
  const by = new Map()
  for (const a of assigned) { if (!a.stream) continue; if (!by.has(a.stream)) by.set(a.stream, []); by.get(a.stream).push(a) }
  const out = new Map()
  for (const [name, cs] of by) {
    cs.sort((x, y) => x.from - y.from)
    let id = null, last = -Infinity
    for (const c of cs) {
      if (!id || c.from - last > gapDays * 86_400_000) id = `stream:${sha(name)}:${day(c.from)}`
      last = Math.max(last, c.to)
      out.set(c.id, id)
    }
  }
  return out
}

// link the cases not linked yet (by this version of the skill's prompt): returns {cases, read, chunks, joined, top}
export async function linkCases({ say = async () => {}, companyDomains = [] } = {}) {
  const R = (await skillRules()).streams || {}
  if (R.enabled === false) return null
  const skill = await discoverySkill()
  const version = sha(`${skill.prompts['link-cases'] || ''}|${R.gapDays}`, 10)
  const all = await caseCatalog({ companyDomains })
  const done = new Map((await q(`select case_id, stream, version from pro_case_links where tenant_id=$1`, [T()])).map((r) => [r.case_id, r]))
  const todo = all.filter((c) => done.get(c.id)?.version !== version)
  const singles = all.filter((c) => c.tasks.length <= 1).length
  if (!todo.length) return { cases: all.length, read: 0 }
  await say(`건 ${all.length.toLocaleString('ko-KR')}개 중 일 하나짜리 건이 ${singles.toLocaleString('ko-KR')}개예요 — 같은 고객 · 프로젝트의 일인지 AI 로 견줘 이어 묶어요(${todo.length.toLocaleString('ko-KR')}개).`)
  const streams = new Map() // name → purpose (the vocabulary the later parts reuse)
  for (const r of done.values()) if (r.stream && r.version === version) streams.set(r.stream, '')
  const per = R.batch || 40
  const answers = new Map(), whys = new Map()
  for (let i = 0; i < todo.length; i += per) {
    const part = todo.slice(i, i + per)
    const input = part.map((c, n) => ({ i: n, from: day(c.from), to: day(c.to), source: [...c.sources].join('+'), tasks: c.tasks.slice(0, 6), subjects: [...c.subjects].slice(0, 3),
      partners: [...c.partners].slice(0, 3), roles: [...c.roles].slice(0, 4), files: [...c.files].slice(0, 4) }))
    let r = null
    for (let tries = 0; tries < 2 && !r; tries++) {
      try {
        r = await chatJson(await prompt('link-cases'), JSON.stringify({ known_streams: [...streams].slice(-80).map(([name, purpose]) => ({ name, purpose })), cases: input }), { timeoutMs: R.timeoutMs || 180000, temperature: 0 })
      } catch (e) { console.warn('[ontology] link cases', e.message) }
    }
    for (const s of r?.streams || []) if (clean(s.name)) streams.set(clean(s.name).slice(0, 60), clean(s.purpose).slice(0, 60))
    for (const x of r?.cases || []) {
      const c = part[Number(x.i)]
      if (!c) continue
      answers.set(c.id, x.routine ? null : clean(x.stream).slice(0, 60) || null)
      whys.set(c.id, clean(x.why).slice(0, 60))
    }
    await say(`${Math.min(i + per, todo.length).toLocaleString('ko-KR')}/${todo.length.toLocaleString('ko-KR')}개 견줬어요 — 줄기 ${streams.size}개.`, 'link')
  }
  // chunks over every case (the earlier ones too, so a new case can join an old chunk)
  const assigned = all.map((c) => ({ id: c.id, from: c.from, to: c.to, stream: answers.has(c.id) ? answers.get(c.id) : done.get(c.id)?.stream || null }))
  const chunk = chunksOf(assigned, R.gapDays ?? 45)
  for (let i = 0; i < assigned.length; i += 300) {
    const part = assigned.slice(i, i + 300)
    // a case the model answered carries this version; one it did not (a failed part) is asked again next time
    await q(`insert into pro_case_links (tenant_id, case_id, stream_id, stream, why, version)
             select $1, x->>'id', x->>'chunk', x->>'stream', x->>'why', x->>'version' from jsonb_array_elements($2::jsonb) x
             on conflict (tenant_id, case_id) do update set stream_id=excluded.stream_id, stream=excluded.stream,
               why=coalesce(excluded.why, pro_case_links.why), version=case when excluded.version = '' then pro_case_links.version else excluded.version end, made_at=now()`,
    [T(), JSON.stringify(part.map((a) => ({ id: a.id, chunk: chunk.get(a.id) || null, stream: a.stream, why: whys.get(a.id) ?? null,
      version: answers.has(a.id) ? version : (done.get(a.id)?.version || '') })))])
  }
  // what joined: chunks of more than one case
  const size = new Map()
  for (const id of chunk.values()) size.set(id, (size.get(id) || 0) + 1)
  const joinedIds = [...chunk].filter(([, id]) => size.get(id) > 1)
  const byChunk = new Map()
  for (const [cid, id] of joinedIds) { if (!byChunk.has(id)) byChunk.set(id, []); byChunk.get(id).push(all.find((c) => c.id === cid)) }
  const top = [...byChunk.values()].map((cs) => ({ name: assigned.find((a) => a.id === cs[0].id).stream, cases: cs.length,
    mail: cs.filter((c) => c.sources.has('mail')).length, chat: cs.filter((c) => c.sources.has('chat')).length }))
    .sort((a, b) => b.cases - a.cases)
  await say(`건 ${joinedIds.length.toLocaleString('ko-KR')}개를 덩어리 ${byChunk.size}개로 이어 묶었어요: ${top.slice(0, 3).map((t) => `「${t.name}」(건 ${t.cases}${t.mail && t.chat ? ` · 메일 ${t.mail} · 대화 ${t.chat}` : ''})`).join(' · ')}`)
  return { cases: all.length, read: todo.length, chunks: byChunk.size, joined: joinedIds.length, top }
}

// the chunks and their cases, for the screen
export async function streamList() {
  const rows = await q(`select stream_id, stream, count(*)::int n, array_agg(case_id order by case_id) as cases, array_agg(why) as whys
                          from pro_case_links where tenant_id=$1 and stream_id is not null group by 1,2 having count(*) > 1 order by n desc`, [T()])
  return rows
}
