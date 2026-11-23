// 대화 기록으로 프로세스 찾기(design-v0.3 §21): 회사 단체 대화방을 내보낸 파일(카카오톡 대화 내보내기 CSV · TXT, 날짜 · 보낸 사람 ·
// 메시지 열이 있는 CSV)을 올리면, 메일과 같은 모양(누가 · 누구에게 · 어떤 일 · 언제)으로 바꿔 같은 지도 셈에 넣는다.
//   1 메시지로 풀기(형식은 파일에서 알아본다) → 최근 rules.chat.days 일, 시스템 · 삭제 · 사진만 · 아주 짧은 말은 뺀다
//   2 하루치(길면 rules.chat.windowMessages 개씩)를 프로세스 찾기 스킬의 prompts/read-chat.md 로 한 번씩 읽는다 — 메시지마다
//     일 · 행위 · 대상(subject) · 받는 사람 · 보낸 사람의 역할 · 정해진 때
//   3 건: 같은 대상의 메시지 — 그 대상이 rules.chat.caseGapDays 일 넘게 조용하면 다음 건
//   4 사람: 대화방 이름(「정석진 전무」 · 「박용주이사」)을 메일 보관함의 보낸 사람 이름에 맞춰 회사 주소로 — 메일과 같은 사람이 된다
// 결과는 메일 이력(pro_mail_history)에 attrs.source 'chat' 으로 쌓인다(지도 셈 · 정해진 때 찾기가 그대로 읽는다). 대화 문장은 남기지 않는다.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { chatJson } from '../llm.js'
import { maskPii } from '../policy/pii.js'
import { prompt, rules as skillRules } from './discovery.js'
import { sayer } from './feed.js'
import { emit } from '../bus.js'

const T = () => config.tenantId
const sha = (s, n = 12) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n)
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const kst = (d) => new Date(d.getTime() + 9 * 3600_000).toISOString()

// ---------- 1 파일 → 메시지 ----------
// a CSV with quoted multi-line fields
export function csvRows(text) {
  const rows = []
  let row = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((x) => x !== ''))
}
const KST = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(Date.UTC(+y, +mo - 1, +d, +h - 9, +mi, +s))
const h24 = (ampm, h) => (/오후|PM/i.test(ampm || '') ? (+h % 12) + 12 : /오전|AM/i.test(ampm || '') ? +h % 12 : +h)
function dateOf(s) {
  const t = String(s || '').trim()
  let m = t.match(/^(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})\.?\s+(?:(오전|오후|AM|PM)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?/i)
  if (m) return KST(m[1], m[2], m[3], h24(m[4], m[5]), m[6], m[7] || 0)
  m = t.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(?:\S+요일\s*)?(오전|오후)?\s*(\d{1,2}):(\d{2})/)
  if (m) return KST(m[1], m[2], m[3], h24(m[4], m[5]), m[6])
  return null
}

// {kind, messages: [{at, from, text}]} or null when the file is not a chat
export function parseChat(name, text) {
  text = String(text || '').replace(/^\uFEFF/, '')
  const out = []
  // CSV: a header naming the date, the sender and the message (카카오톡: Date,User,Message)
  const head = text.slice(0, 400).split('\n')[0]
  if (/,/.test(head) && /date|날짜|일시|time|시간/i.test(head) && /user|name|sender|보낸|이름|작성자/i.test(head)) {
    const rows = csvRows(text)
    const h = rows[0].map((x) => x.trim().toLowerCase())
    const di = h.findIndex((x) => /date|날짜|일시|time|시간/.test(x)), ui = h.findIndex((x) => /user|name|sender|보낸|이름|작성자/.test(x))
    const mi = h.findIndex((x, i) => i !== di && i !== ui && /message|text|content|메시지|내용/.test(x))
    for (const r of rows.slice(1)) {
      const at = dateOf(r[di])
      if (!at || !clean(r[ui])) continue
      out.push({ at, from: clean(r[ui]), text: String(r[mi >= 0 ? mi : 2] || '').trim() })
    }
    return out.length ? { kind: 'csv', messages: out } : null
  }
  // TXT: 카카오톡 PC(「--- 2026년 11월 13일 금요일 ---」 + 「[이름] [오후 5:55] 메시지」), 모바일(「2026. 11. 13. 오후 5:55, 이름 : 메시지」)
  let day = null
  for (const line of text.split(/\r?\n/)) {
    let m = line.match(/^-+\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)
    if (m) { day = [m[1], m[2], m[3]]; continue }
    m = line.match(/^\[(.+?)\]\s*\[(오전|오후|AM|PM)\s*(\d{1,2}):(\d{2})\]\s?(.*)$/i)
    if (m && day) { out.push({ at: KST(day[0], day[1], day[2], h24(m[2], m[3]), m[4]), from: clean(m[1]), text: m[5] }); continue }
    m = line.match(/^(\d{4}[.년-]\s*\d{1,2}[.월-]\s*\d{1,2}[.일]?\.?\s*(?:\S+요일\s*)?(?:오전|오후|AM|PM)?\s*\d{1,2}:\d{2}),\s*(.+?)\s:\s(.*)$/i)
    if (m) { const at = dateOf(m[1].replace(/년|월/g, '.').replace(/일/, '.')); if (at) { out.push({ at, from: clean(m[2]), text: m[3] }); continue } }
    if (out.length && line.trim() && !/^\d{4}[.년]/.test(line) && !/^-+/.test(line)) out[out.length - 1].text += `\n${line}`
  }
  return out.length >= 5 ? { kind: 'txt', messages: out } : null
}
export const isChatExport = (name, buf) => /\.(csv|txt)$/i.test(name) && !!parseChat(name, buf.toString('utf8').slice(0, 200_000))

// what a message carries that is not words: a photo, a file (its name), a link
function kindOf(text) {
  const t = String(text || '').trim()
  if (/^(사진|동영상|이모티콘|사진 \d+장)$/.test(t)) return 'media'
  const f = t.match(/^(?:파일|File)\s*:\s*(.+)$/i)
  if (f) return 'file'
  return /https?:\/\//.test(t) ? 'link' : 'text'
}

// ---------- 4 사람 ----------
// a chat name's company address: the sender names in the owner's mail archive (「정석진 <…@uengine.org>」), titles and numbers
// after the name dropped (「정석진 전무」 · 「박용주이사」 · 「장재형2」)
const TITLE = /\s*(대표이사|대표|부사장|전무|상무|이사|본부장|실장|부장|차장|과장|대리|주임|사원|팀장|책임|선임|수석|연구원|님|\d+)$/
export const baseName = (n) => { let s = clean(n); for (let i = 0; i < 3; i++) s = s.replace(TITLE, '').trim(); return s }
async function addressBook(ownerId) {
  const rows = await q(`select from_addr, count(*)::int n from pro_mail_archive where tenant_id=$1 and owner_id=$2 and from_addr like '%<%@%>%' group by 1 order by 2 desc`, [T(), ownerId]).catch(() => [])
  const book = new Map()
  for (const r of rows) {
    const m = String(r.from_addr).match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>/)
    if (!m) continue
    const k = baseName(m[1])
    if (k && !book.has(k)) book.set(k, m[2].toLowerCase())
  }
  return book
}

// ---------- 2 · 3 읽기 ----------
export async function startChatHistory(me, { name, buf }) {
  const [job] = await q(`insert into pro_onto_jobs (tenant_id, user_id, kind, detail) values ($1,$2,'chat_history',$3) returning id`, [T(), me.id, { name }])
  const tenant = T()
  runChatHistory(me, job.id, name, buf).then(async () => {
    const { startBuild } = await import('./service.js')
    await startBuild(me, `대화 기록 「${name}」 읽기 뒤 다시 셈하기`)
  }).catch(async (e) => {
    console.warn('[ontology] chat history', e.message)
    await q(`update pro_onto_jobs set status='failed', error=$2, finished_at=now() where id=$1`, [job.id, String(e.message).slice(0, 500)]).catch(() => {})
  }).finally(() => emit(me.id, 'ontology', { job: job.id, tenant }))
  return { job: job.id, kind: 'chat' }
}

// a chat's items into cases: the same subject, until it has been quiet for gapDays
export function casesOf(items, gapDays = 2) {
  const by = new Map()
  for (const it of [...items].sort((a, b) => a.at - b.at)) {
    const k = clean(it.subject).toLowerCase() || `(${it.task})`
    const c = by.get(k)
    if (!c || it.at - c.last > gapDays * 86_400_000) by.set(k, { id: `${sha(k)}:${kst(it.at).slice(0, 10)}`, last: it.at })
    else c.last = it.at
    it.caseKey = by.get(k).id
  }
  return items
}

export async function runChatHistory(me, jobId, name, buf) {
  const say = sayer(jobId)
  const update = (set, args) => q(`update pro_onto_jobs set ${set} where id=$1`, [jobId, ...args])
  const R = (await skillRules()).chat || {}
  const parsed = parseChat(name, buf.toString('utf8'))
  if (!parsed) throw new Error('대화 기록 형식을 알아보지 못했어요(날짜 · 보낸 사람 · 메시지가 있는 CSV 나 카카오톡 내보내기 TXT).')
  const all = parsed.messages
  const people = new Set(all.map((m) => m.from))
  await say(`「${name}」을 펼쳤어요 — 메시지 ${all.length.toLocaleString('ko-KR')}개 · ${people.size}명 · ${kst(all[0].at).slice(0, 10)} ~ ${kst(all.at(-1).at).slice(0, 10)}.`)
  const since = all.at(-1).at.getTime() - (R.days || 90) * 86_400_000
  const skip = new RegExp(R.skip || '^(메시지가 삭제되었습니다\\.?|삭제된 메시지입니다\\.?|.{0,1})$')
  const recent = all.filter((m) => m.at.getTime() >= since)
  const kept = recent.filter((m) => !skip.test(String(m.text).trim()) && !(kindOf(m.text) === 'media' && !R.keepMedia))
  await say(`최근 ${R.days || 90}일 메시지 ${recent.length.toLocaleString('ko-KR')}개 중 삭제 · 사진만 · 빈 말 ${(recent.length - kept.length).toLocaleString('ko-KR')}개는 빼요.`)
  // the people: chat names → company addresses through the owner's mail
  const book = await addressBook(me.id)
  const addrOf = new Map([...people].map((n) => [n, book.get(baseName(n)) || null]))
  const matched = [...addrOf.values()].filter(Boolean).length
  if (matched) await say(`대화방 ${people.size}명 중 ${matched}명은 메일의 보낸 사람과 같은 사람이에요 — 메일과 대화의 일이 한 사람에게 모여요.`)
  // windows: a day at a time, a long day in parts
  const days = new Map()
  for (const m of kept) { const d = kst(m.at).slice(0, 10); if (!days.has(d)) days.set(d, []); days.get(d).push(m) }
  const per = R.windowMessages || 60
  const windows = [...days.entries()].flatMap(([d, ms]) => Array.from({ length: Math.ceil(ms.length / per) }, (_, i) => ({ day: d, ms: ms.slice(i * per, (i + 1) * per) })))
  await update('total=$2, done=0', [windows.length])
  await say(`${days.size}일치 대화를 ${windows.length}번에 나눠 읽어요 — 하루씩 「프로세스 찾기」 스킬의 대화 읽기로.`)
  const known = new Set((await q(`select distinct task from pro_onto_labels where tenant_id=$1 and task <> ''`, [T()])).map((r) => r.task))
  const subjects = []
  const votes = new Map()
  const items = []
  const found = new Set()
  let done = 0, unread = 0
  const readOne = async (w) => {
    const msgs = w.ms.map((m, i) => ({ i, time: kst(m.at).slice(11, 16), from: m.from, text: maskPii(String(m.text)).slice(0, R.textChars || 500) }))
    // a slow answer is asked once more (the model gateway under four readers at once)
    let r = null
    for (let tries = 0; tries < 2 && !r; tries++) {
      try {
        r = await chatJson(await prompt('read-chat'), JSON.stringify({ date: w.day, known_tasks: [...known].slice(-80), known_subjects: subjects.slice(-40), messages: msgs }), { timeoutMs: R.timeoutMs || 240000, temperature: 0 })
      } catch (e) { console.warn('[ontology] read chat', e.message) }
    }
    if (!r) unread++
    for (const x of r?.items || []) {
      const m = w.ms[Number(x.i)]
      const task = clean(x.task).slice(0, 40)
      if (!m || !x.work || !task) continue
      if (x.from_role) { if (!votes.has(m.from)) votes.set(m.from, new Map()); const v = votes.get(m.from); v.set(clean(x.from_role).slice(0, 12), (v.get(clean(x.from_role).slice(0, 12)) || 0) + 1) }
      const subject = clean(x.subject).slice(0, 60)
      if (subject && !subjects.includes(subject)) subjects.push(subject)
      const act = ['request', 'deliver', 'approve', 'notify'].includes(x.act) ? x.act : 'notify'
      const k = kindOf(m.text)
      items.push({ at: m.at, from: m.from, to: x.to ? clean(x.to).replace(/^@/, '') : null, task, act, subject, recur: x.recur?.every ? x.recur : null, text: String(m.text),
        file: k === 'file' ? String(m.text).replace(/^(?:파일|File)\s*:\s*/i, '').trim() : null, key: sha(`${m.at.toISOString()}|${m.from}|${m.text}`, 16) })
      if (!found.has(task) && !known.has(task)) await say(`새 일 「${task}」을 찾았어요 — ${m.from}의 ${act === 'request' ? '부탁' : act === 'deliver' ? '결과 공유' : act === 'approve' ? '확인' : '알림'}에서.`, 'task')
      if (x.recur?.every && x.recur.says) await say(`정해진 때마다 하는 일 같아요: “${String(x.recur.says).slice(0, 40)}” → 「${String(x.recur.task || task).slice(0, 30)}」`, 'recur')
      found.add(task)
    }
    done++
    await update('done=$2, found=$3', [done, found.size])
  }
  const queue = [...windows]
  await Promise.all(Array.from({ length: (await skillRules()).mailbox?.threadsAtOnce || 4 }, async () => { while (queue.length) await readOne(queue.shift()) }))
  if (unread) await say(`${windows.length}번 중 ${unread}번은 모델이 답하지 않아 읽지 못했어요 — 다시 올리면 그 날들만 다시 읽어요.`)
  casesOf(items, R.caseGapDays ?? 2)
  // a speaker's role: what most of their messages showed; a company address keeps the role its mail showed
  const roleOf = (n) => { const v = votes.get(n); return v?.size ? [...v].sort((a, b) => b[1] - a[1])[0][0] : ((R.colleagueRole || '동료')) }
  const mailRoles = new Map((await q(`select from_addr, mode() within group (order by from_role) as role from pro_mail_history where tenant_id=$1 and coalesce(attrs->>'source','mail') <> 'chat' group by 1`, [T()]).catch(() => [])).map((r) => [r.from_addr, r.role]))
  const who = (n) => { const a = addrOf.get(n) || [...addrOf].find(([k]) => baseName(k) === baseName(n || ''))?.[1] || null; return { addr: a || `chat:${baseName(n)}`, role: (a && mailRoles.get(a) && mailRoles.get(a) !== '동료' ? mailRoles.get(a) : roleOf(n)) } }
  for (let i = 0; i < items.length; i += 200) {
    const part = items.slice(i, i + 200)
    await q(`insert into pro_mail_history (tenant_id, owner_id, mail_id, case_id, occurred_at, from_addr, to_addrs, from_role, to_role, activity_label, act, artifacts, subject_hash, attrs)
             select $1, $2, x->>'id', x->>'case', (x->>'at')::timestamptz, x->>'from', array(select jsonb_array_elements_text(x->'to')), x->>'from_role', x->>'to_role', x->>'task', x->>'act',
                    coalesce(x->'files','[]'::jsonb), x->>'subject_hash', x->'attrs'
               from jsonb_array_elements($3::jsonb) x
             on conflict (tenant_id, mail_id) do update set case_id=excluded.case_id, activity_label=excluded.activity_label, act=excluded.act, from_role=excluded.from_role, to_role=excluded.to_role, attrs=excluded.attrs`,
    [T(), me.id, JSON.stringify(part.map((it) => {
      const f = who(it.from), t = it.to ? who(it.to) : null
      return { id: `chat:${it.key}`, case: `chat:${T()}:${it.caseKey}`, at: it.at.toISOString(), from: f.addr, to: t ? [t.addr] : [], from_role: f.role, to_role: t?.role || null, task: it.task, act: it.act,
        files: it.file ? [{ name: it.file.slice(0, 120), type: String(it.file).split('.').pop().toLowerCase().slice(0, 6) }] : [], subject_hash: sha(it.subject),
        attrs: { source: 'chat', export: name, subject: it.subject, ...(it.recur ? { recur: it.recur } : {}) } }
    }))])
  }
  // the messages read as work, kept in their uploader's archive (owner only, like mail) — the map's 근거 shows them to the owner
  await (await import('../mailArchive.js')).archiveMails(me.id, 'chat', items.map((it) => ({ id: `chat:${it.key}`, thread: `chat:${T()}:${it.caseKey}`, date: it.at.toISOString(),
    from: it.from, to: it.to ? [it.to] : [], subject: it.subject, body: it.text, text: it.text, labels: ['CHAT'] })), 'chat').catch((e) => console.warn('[ontology] chat archive', e.message))
  const cases = new Set(items.map((it) => it.caseKey)).size
  const byRole = new Map()
  for (const n of people) { const r = who(n).role; byRole.set(r, (byRole.get(r) || 0) + 1) }
  await say(`대화에서 일 ${items.length.toLocaleString('ko-KR')}건을 읽었어요 — 대상 ${subjects.length}개 · 건 ${cases}개 · 일 이름 ${found.size}개. 역할: ${[...byRole].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, n]) => `${r} ${n}명`).join(' · ')}. 이제 흐름을 셉니다.`)
  await update(`status='done', finished_at=now(), detail=coalesce(detail,'{}'::jsonb) || $2::jsonb`, [{ messages: kept.length, items: items.length, cases, subjects: subjects.length }])
  return { items: items.length, cases }
}
