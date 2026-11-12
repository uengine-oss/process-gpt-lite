// 지난 메일 읽기(design-v0.1 ④, v0.2 §5.1): a mailbox's past mail → work events in pro_mail_history, through a funnel
// that spends the model only where it helps:
//   1 headers only (from · to · cc · subject · date · thread · attachment names · sent or received)
//   2 rules drop what is not work: a List-Unsubscribe header, no-reply senders, calendar invites
//   3 threads are cases; a forward that broke the thread is linked back by its subject (and attachments)
//   4 the model reads each thread once (the newly written part of each mail, personal data masked) and says, per mail,
//     whether it is work, which work (a short task name, matched to the company's names later) and what it does
// The mail itself is not kept: only who · to whom · which work · when · attachment names, and the mail's id so its
// owner can open it again. Outside people are kept as a masked id + domain + role.
// Sources: Gmail (read-only scope the mail connection already has), and the demo mailbox's past mail
// (server/scripts/fixtures/ax-demo-mailbox.json — fictional, reserved example domains).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { chatJson } from '../llm.js'
import { maskPii } from '../policy/pii.js'
import { googleAccessToken } from '../mail.js'
import { emit } from '../bus.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const T = () => config.tenantId
const DEMO_ARCHIVE = path.join(here, '..', '..', 'scripts', 'fixtures', 'ax-demo-mailbox.json')
const lower = (s) => String(s || '').trim().toLowerCase()
const addrOf = (s) => (String(s || '').match(/<([^>]+)>/)?.[1] || String(s || '')).trim().toLowerCase()
const domainOf = (a) => addrOf(a).split('@')[1] || ''

// ---------- 1 headers ----------
function demoArchive(email) {
  try {
    const a = JSON.parse(fs.readFileSync(DEMO_ARCHIVE, 'utf8'))
    return lower(a.owner) === lower(email) ? a : null
  } catch { return null }
}

async function gmailHeaders(userId, days, onPage) {
  const at = await googleAccessToken(userId)
  const api = (p) => fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${p}`, { headers: { Authorization: `Bearer ${at}` } }).then((r) => r.json())
  const out = []
  let page = ''
  do {
    const list = await api(`messages?maxResults=100&q=${encodeURIComponent(`newer_than:${days}d`)}${page ? `&pageToken=${page}` : ''}`)
    for (const m of list.messages || []) {
      const full = await api(`messages/${m.id}?format=full`)
      const h = Object.fromEntries((full.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]))
      const files = []
      const walk = (p) => { if (!p) return; if (p.filename) files.push({ name: p.filename, type: p.filename.split('.').pop().toLowerCase(), size: p.body?.size || 0 }); (p.parts || []).forEach(walk) }
      walk(full.payload)
      out.push({ id: m.id, thread: full.threadId, date: new Date(Number(full.internalDate)).toISOString(), from: h.from, to: String(h.to || '').split(',').map(addrOf).filter(Boolean),
        cc: String(h.cc || '').split(',').map(addrOf).filter(Boolean), subject: h.subject || '', text: full.snippet || '', attachments: files,
        labels: full.labelIds || [], headers: h['list-unsubscribe'] ? { 'list-unsubscribe': h['list-unsubscribe'] } : {} })
    }
    page = list.nextPageToken || ''
    if (onPage) await onPage(out.length)
  } while (page)
  return out
}

// ---------- 2 rules ----------
export function notWork(m) {
  if (m.headers && Object.keys(m.headers).some((k) => lower(k) === 'list-unsubscribe')) return 'newsletter'
  if (/(^|[^a-z])(no-?reply|do-?not-?reply|mailer-daemon|notifications?)@/i.test(addrOf(m.from))) return 'noreply'
  if (/^\s*(초대|업데이트된 초대|invitation|updated invitation)\s*[:：]/i.test(m.subject || '') || (m.attachments || []).some((f) => /\.ics$/i.test(f.name))) return 'invite'
  return null
}

// ---------- 3 threads ----------
export const baseSubject = (s) => String(s || '').replace(/^\s*((re|fw|fwd|회신|답장|전달)\s*[:：]\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase()
export function threadsOf(mails) {
  const by = new Map()
  for (const m of [...mails].sort((a, b) => new Date(a.date) - new Date(b.date))) {
    if (!by.has(m.thread)) by.set(m.thread, [])
    by.get(m.thread).push(m)
  }
  // a thread that starts with a forward joins an earlier thread with the same subject (or a shared attachment) within 21 days
  const threads = [...by.entries()].map(([id, ms]) => ({ id, mails: ms, start: new Date(ms[0].date).getTime() }))
  const merged = new Map(threads.map((t) => [t.id, t.id]))
  for (const t of threads) {
    if (!/^\s*(fw|fwd|전달)\s*[:：]/i.test(t.mails[0].subject || '')) continue
    const subj = baseSubject(t.mails[0].subject)
    const files = new Set(t.mails.flatMap((m) => (m.attachments || []).map((f) => lower(f.name))))
    const host = threads.filter((o) => o !== t && o.start <= t.start && t.start - o.start < 21 * 86_400_000)
      .find((o) => baseSubject(o.mails[0].subject) === subj || o.mails.some((m) => (m.attachments || []).some((f) => files.has(lower(f.name)))))
    if (host) merged.set(t.id, merged.get(host.id))
  }
  const out = new Map()
  for (const t of threads) {
    const id = merged.get(t.id)
    if (!out.has(id)) out.set(id, [])
    out.get(id).push(...t.mails)
  }
  return [...out.entries()].map(([id, ms]) => ({ id, mails: ms.sort((a, b) => new Date(a.date) - new Date(b.date)) }))
}

// the total a mail states ("합계 12,400,000원", "1,240만 원") — a fact a learned condition can use; null when none
export function amountOf(text) {
  const s = String(text || '')
  let best = null
  for (const m of s.matchAll(/(합계|총액|견적\s*금액|금액|총)\s*[:：]?\s*([0-9][0-9,]{3,})\s*원/g)) best = Math.max(best || 0, Number(m[2].replace(/,/g, '')))
  if (best == null) for (const m of s.matchAll(/([0-9][0-9,]*)\s*만\s*원/g)) best = Math.max(best || 0, Number(m[1].replace(/,/g, '')) * 10000)
  if (best == null) for (const m of s.matchAll(/([0-9]{1,3}(?:,[0-9]{3}){2,})\s*원/g)) best = Math.max(best || 0, Number(m[1].replace(/,/g, '')))
  return best
}

// ---------- 4 the model, once per thread ----------
const READ = `회사 메일함의 스레드 하나를 읽고, 메일마다 그 메일이 회사 업무에서 무슨 일인지 적습니다.
JSON {"mails":[{"i":번호,"work":true|false,"task":"일 이름","act":"request|deliver|approve|notify"}]} 로만 답하세요.
- task: 그 메일로 진행된 업무 한 가지를 「명사 + 동작」 4~10자로(예: "요청 메일 접수", "현장 실측", "평면도 작성", "제안서 작성", "견적서 작성", "재무 검토", "고객 회신", "자재 발주").
  이미 쓰는 일 이름(known_tasks)과 같은 일이면 그 이름을 그대로 쓴다.
- 결과물(첨부 파일·완료 보고)을 건네는 메일은 보낸 사람이 해 낸 일의 이름으로 적는다. 다음 사람에게 검토·승인을 부탁하며 결과물을 붙였어도 그렇다
  (예: 견적서를 붙여 재무 검토를 부탁 → "견적서 작성", act deliver). 결과물 없이 일을 맡기기만 하는 메일은 맡긴 일의 이름(act request), 검토한 쪽의 답은 그 검토의 이름(act approve).
- 고객이 처음 일을 맡기는 메일은 "요청 메일 접수", 고객에게 결과를 보내는 메일은 "고객 회신"처럼 그 일의 이름으로 적는다.
- 고객이 진행 중인 일을 고쳐 달라고 하는 메일은 따로 일을 만들지 말고 그 메일로 다시 하게 되는 우리 일의 이름(예: 제안서를 고쳐 달라면 "제안서 작성")으로 적고 act 는 request.
- act: 일을 맡기면 request, 해 둔 일·결과를 건네면 deliver, 승인이면 approve, 그 밖의 알림이면 notify.
- 인사·감사·일정 잡기만 있는 메일도 그 업무 흐름의 한 단계면 그 단계의 이름으로 적고, 업무와 무관하면 work 를 false 로.`

function personOf(addr, inside) {
  const a = addrOf(addr)
  if (inside.has(a)) return { addr: a, role: inside.get(a).role, inside: true }
  const d = domainOf(a)
  return { addr: `${crypto.createHash('sha1').update(a).digest('hex').slice(0, 10)}@${d}`, role: '고객', inside: false }
}

async function readThread(t, inside, known) {
  const mails = t.mails.map((m, i) => ({
    i, date: m.date.slice(0, 10),
    from: personOf(m.from, inside).inside ? inside.get(addrOf(m.from)).label : `고객(${domainOf(m.from)})`,
    to: [...(m.to || [])].map((x) => (inside.has(addrOf(x)) ? inside.get(addrOf(x)).label : `고객(${domainOf(x)})`)),
    subject: maskPii(m.subject).slice(0, 200), text: maskPii(m.text).slice(0, 700), files: (m.attachments || []).map((f) => f.name),
  }))
  try {
    const r = await chatJson(READ, JSON.stringify({ known_tasks: known, thread: mails }), { timeoutMs: 90000, temperature: 0 })
    return Array.isArray(r?.mails) ? r.mails : []
  } catch (e) { console.warn('[ontology] read thread', e.message); return [] }
}

// people inside the company: their address → {role, label}
async function insidePeople() {
  const rows = await q(`select u.id::text as id, lower(u.email) as email, coalesce(u.username, u.email) as name,
                               (select role from pro_role_assignments r where r.tenant_id=u.tenant_id and r.user_id::text=u.id::text and r.proc_def_id='*' limit 1) as role
                          from users u where u.tenant_id=$1 and not coalesce(u.is_agent,false)`, [T()])
  return new Map(rows.map((r) => [r.email, { id: r.id, role: r.role || '담당자', label: `${r.name}(${r.role || '담당자'})` }]))
}

// Read `days` of one person's mailbox into pro_mail_history, with progress in pro_onto_jobs. Returns the job id at once.
export async function startMailHistory(me, { days = 90 } = {}) {
  const [running] = await q(`select id from pro_onto_jobs where tenant_id=$1 and user_id=$2 and kind='mail_history' and status='running' and started_at > now() - interval '1 hour'`, [T(), me.id])
  if (running) return { job: running.id, already: true }
  const [job] = await q(`insert into pro_onto_jobs (tenant_id, user_id, kind, detail) values ($1,$2,'mail_history',$3) returning id`, [T(), me.id, { days }])
  const tenant = T()
  runMailHistory(me, job.id, days).catch(async (e) => {
    console.warn('[ontology] mail history', e.message)
    await q(`update pro_onto_jobs set status='failed', error=$2, finished_at=now() where id=$1`, [job.id, String(e.message).slice(0, 500)]).catch(() => {})
  }).finally(() => emit(me.id, 'ontology', { job: job.id, tenant }))
  return { job: job.id }
}

// a mail thread's case: the same id the recorder gives the chat handovers about that mail's work
export const caseIdOf = (threadId) => `mail:${T()}:${threadId}`

export async function runMailHistory(me, jobId, days) {
  const [acc] = await q('select provider from pro_mail_accounts where user_id=$1', [me.id])
  let mails = []
  if (acc?.provider === 'gmail') mails = await gmailHeaders(me.id, days)
  else if (acc?.provider === 'demo' || !acc) {
    const a = demoArchive(me.email)
    if (!a) throw new Error('이 메일함에는 읽을 지난 메일이 없어요.')
    const cut = new Date(a.today || Date.now()).getTime() - days * 86_400_000
    mails = a.mails.filter((m) => new Date(m.date).getTime() >= cut)
  } else throw new Error('IMAP 지난 메일 읽기는 아직 준비 중이에요.')
  const update = (set, args) => q(`update pro_onto_jobs set ${set} where id=$1`, [jobId, ...args])
  await update('total=$2', [mails.length])
  const kept = mails.filter((m) => !notWork(m))
  const threads = threadsOf(kept)
  const inside = await insidePeople()
  // the names the company already uses: the chat handovers are matched first, so the mail speaks the same words
  const chat = await q(`select coalesce(nullif(activity_label,''), nullif(next_activity_label,''), instruction) as raw from handover_events where tenant_id=$1`, [T()])
  if (chat.length) await (await import('./names.js')).resolveLabels(chat.map((r) => ({ raw: r.raw }))).catch((e) => console.warn('[ontology] chat names', e.message))
  const known = (await q(`select distinct task from pro_onto_labels where tenant_id=$1 and task <> ''`, [T()])).map((r) => r.task)
  let done = mails.length - kept.length, work = 0
  const found = new Set(known)
  await update('done=$2', [done])
  // four threads at a time (one model call each); progress moves as each finishes
  const readOne = async (t) => {
    // a single plain mail with no attachment and no reply is not a flow: it costs no model call
    const one = t.mails.length === 1 && !(t.mails[0].attachments || []).length
    const read = one ? [] : await readThread(t, inside, [...found])
    for (const r of read) {
      const m = t.mails[Number(r.i)]
      if (!m || !r.work || !String(r.task || '').trim()) continue
      const from = personOf(m.from, inside)
      const to = (m.to || []).map((x) => personOf(x, inside))
      const act = ['request', 'deliver', 'approve', 'notify'].includes(r.act) ? r.act : 'notify'
      const amount = amountOf(`${m.subject || ''}\n${m.text || ''}`)
      await q(`insert into pro_mail_history (tenant_id, owner_id, mail_id, case_id, occurred_at, from_addr, to_addrs, from_role, to_role, activity_label, act, artifacts, subject_hash, attrs)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
               on conflict (tenant_id, mail_id) do update set case_id=excluded.case_id, activity_label=excluded.activity_label, act=excluded.act, from_role=excluded.from_role, to_role=excluded.to_role, attrs=excluded.attrs`, [
        T(), me.id, m.id, caseIdOf(t.id), m.date, from.addr, to.map((x) => x.addr), from.role, to[0]?.role || null, String(r.task).trim().slice(0, 40), act,
        JSON.stringify((m.attachments || []).map((f) => ({ name: f.name, type: f.type || String(f.name).split('.').pop() }))), crypto.createHash('sha1').update(baseSubject(m.subject)).digest('hex').slice(0, 16),
        JSON.stringify(amount ? { amount } : {})])
      work++
      found.add(String(r.task).trim())
    }
    done += t.mails.length
    await update('done=$2, kept=$3, found=$4, cursor=$5', [done, work, found.size, t.id])
    emit(me.id, 'ontology', { job: jobId, done, total: mails.length, kept: work, found: found.size })
  }
  const queue = [...threads]
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await readOne(queue.shift()) }))
  await update(`status='done', finished_at=now()`, [])
  return { total: mails.length, kept: work, found: found.size }
}

export async function jobOf(id) {
  const [j] = await q('select * from pro_onto_jobs where id=$1 and tenant_id=$2', [id, T()])
  return j || null
}
export async function latestJob(kind) {
  const [j] = await q(`select * from pro_onto_jobs where tenant_id=$1 and kind=$2 order by started_at desc limit 1`, [T(), kind])
  return j || null
}
