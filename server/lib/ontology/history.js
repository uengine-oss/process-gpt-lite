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
import { partsOf, bodyOf, newPart, readFile, kindOf, formKey, b64u, gmailError, gmailBusy } from './mailbody.js'
import { prompt, rules as skillRules, defaultRules, discoverySkill, readVersion } from './discovery.js'
import { sayer } from './feed.js'
import { emit } from '../bus.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const T = () => config.tenantId
const DEMO_ARCHIVE = path.join(here, '..', '..', 'scripts', 'fixtures', 'ax-demo-mailbox.json')
const lower = (s) => String(s || '').trim().toLowerCase()
const addrOf = (s) => (String(s || '').match(/<([^>]+)>/)?.[1] || String(s || '')).trim().toLowerCase()
const domainOf = (a) => addrOf(a).split('@')[1] || ''
// 「장진영 <jyjang@uengine.org>」 → 장진영
const nameOf = (s) => String(s || '').match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim() || ''
// items through fn, n at a time, results in the items' order
async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }))
  return out
}

// ---------- 1 headers ----------
function demoArchive(email) {
  try {
    const a = JSON.parse(fs.readFileSync(DEMO_ARCHIVE, 'utf8'))
    return lower(a.owner) === lower(email) ? a : null
  } catch { return null }
}

// Gmail: every mail of `days` (received and sent — Gmail's search leaves out only spam and trash) with its whole body, the
// newly written part of it, and its attachments. The company's own attachments (sent by someone inside) are opened: their
// labels make the form a reply uses (templatesOf), and the latest file of each form is kept as that form's template.
export const gmailApi = () => process.env.PRO_GMAIL_API || 'https://gmail.googleapis.com/gmail/v1/users/me'
export async function gmailMails(token, days, { inside = new Map(), onPage, onBusy, formsDir = null, archived = null, forms = defaultRules().forms, fetchAtOnce = 4 } = {}) {
  const OFFICE = new Set(forms.openKinds)
  // Gmail's per-minute quota per person: a refusal for it is waited out (longer each time), not a failed read
  const api = async (p) => {
    for (let i = 0; ; i++) {
      const r = await fetch(`${gmailApi()}/${p}`, { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json().catch(() => ({}))
      if (r.ok) return j
      if (!gmailBusy(r.status, j) || i >= 8) throw gmailError(r.status, j)
      await onBusy?.(i)
      await new Promise((ok) => setTimeout(ok, Math.min(60_000, 2_000 * 2 ** i) + Math.random() * 1000))
    }
  }
  const out = []
  const latest = new Map()
  let page = ''
  do {
    const list = await api(`messages?maxResults=100&q=${encodeURIComponent(`newer_than:${days}d`)}${page ? `&pageToken=${page}` : ''}`)
    // a mail already in the owner's mail archive (lib/mailArchive.js) is taken from there, not fetched again
    const kept = archived ? await archived(list.messages?.map((x) => x.id) || []) : new Map()
    // several mails of a page at a time (Gmail allows ~50 reads a second per person); the page keeps its order
    const page1 = await pool(list.messages || [], fetchAtOnce, async (m) => {
      if (kept.has(m.id)) return { ...kept.get(m.id), archived: true }
      const full = await api(`messages/${m.id}?format=full`)
      const h = Object.fromEntries((full.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]))
      const parts = partsOf(full.payload)
      const date = new Date(Number(full.internalDate)).toISOString()
      const ours = inside.has(addrOf(h.from))
      const attachments = []
      for (const f of parts.attachments) {
        const a = { name: f.name, type: kindOf(f.name), size: f.size, ...(f.attachmentId ? { attachmentId: f.attachmentId } : {}) }
        if (ours && OFFICE.has(a.type) && (f.attachmentId || f.data)) {
          try {
            const buf = f.data ? b64u(f.data) : b64u((await api(`messages/${m.id}/attachments/${f.attachmentId}`)).data)
            const r = await readFile(f.name, buf)
            a.fields = r.labels.slice(0, forms.labelsPerFile).map((l) => maskPii(l))
            if (formsDir && (!latest.has(formKey(f.name)) || latest.get(formKey(f.name)) < date)) {
              latest.set(formKey(f.name), date)
              fs.mkdirSync(formsDir, { recursive: true })
              fs.writeFileSync(path.join(formsDir, formKey(f.name)), buf)
              a.file = `forms/${formKey(f.name)}`
            }
          } catch (e) { console.warn('[ontology] attachment', f.name, e.message) }
        }
        attachments.push(a)
      }
      const body = bodyOf(parts)
      return { id: m.id, thread: full.threadId, date, from: h.from, to: String(h.to || '').split(',').map(addrOf).filter(Boolean),
        cc: String(h.cc || '').split(',').map(addrOf).filter(Boolean), subject: h.subject || '', body, text: newPart(body) || full.snippet || '', attachments,
        labels: full.labelIds || [], headers: h['list-unsubscribe'] ? { 'list-unsubscribe': h['list-unsubscribe'] } : {} }
    })
    out.push(...page1)
    page = list.nextPageToken || ''
    if (onPage) await onPage(out.length)
  } while (page)
  return out
}
export const formsDirOf = (tenant = T()) => path.join(process.env.PRO_FORMS_DIR || path.join(here, '..', '..', '.forms'), tenant)

// the demo mailbox: its attachments name the template files they were made from (fixtures/ax-demo-templates) — the
// company's own are opened the same way as Gmail's
async function demoFields(mails, inside, forms = defaultRules().forms) {
  const OFFICE = new Set(forms.openKinds)
  for (const m of mails) {
    if (!inside.has(addrOf(m.from))) continue
    for (const f of m.attachments || []) {
      if (!f.file || !OFFICE.has(kindOf(f.name)) || f.fields) continue
      const p = path.join(path.dirname(DEMO_ARCHIVE), f.file)
      if (fs.existsSync(p)) f.fields = (await readFile(f.name, fs.readFileSync(p))).labels.slice(0, forms.labelsPerFile)
    }
  }
  return mails
}

// ---------- 2 rules ----------
export function notWork(m, f = defaultRules().filters) {
  const heads = Object.keys(m.headers || {}).map(lower)
  if ((f.newsletterHeaders || []).some((h) => heads.includes(lower(h)))) return 'newsletter'
  if (f.noReplySender && new RegExp(f.noReplySender, 'i').test(addrOf(m.from))) return 'noreply'
  if ((f.inviteSubject && new RegExp(f.inviteSubject, 'i').test(m.subject || '')) || (f.inviteAttachment && (m.attachments || []).some((x) => new RegExp(f.inviteAttachment, 'i').test(x.name)))) return 'invite'
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
// the reading prompt is the process-discovery skill's prompts/read-thread.md (discovery.js)

function personOf(addr, inside) {
  const a = addrOf(addr)
  if (inside.has(a)) return { addr: a, role: inside.get(a).role, inside: true }
  const d = domainOf(a)
  return { addr: `${crypto.createHash('sha1').update(a).digest('hex').slice(0, 10)}@${d}`, role: '고객', inside: false }
}

async function readThread(t, inside, known, chars = defaultRules().mailbox.historyTextChars) {
  const mails = t.mails.map((m, i) => ({
    i, date: m.date.slice(0, 10),
    from: personOf(m.from, inside).inside ? inside.get(addrOf(m.from)).label : `고객(${domainOf(m.from)})`,
    to: [...(m.to || [])].map((x) => (inside.has(addrOf(x)) ? inside.get(addrOf(x)).label : `고객(${domainOf(x)})`)),
    subject: maskPii(m.subject).slice(0, 200), text: maskPii(m.text).slice(0, chars), files: (m.attachments || []).map((f) => (f.fields?.length ? { name: f.name, fields: f.fields.slice(0, 16) } : f.name)),
  }))
  try {
    const r = await chatJson(await prompt('read-thread'), JSON.stringify({ known_tasks: known, thread: mails }), { timeoutMs: 90000, temperature: 0 })
    return Array.isArray(r?.mails) ? r.mails : []
  } catch (e) { console.warn('[ontology] read thread', e.message); return [] }
}

// people inside the company: address → {id, role, label}. Its members, and — while the rest have not joined yet — anyone
// writing from the company's own mail domain (the members' domains that are not public mail services): a colleague is
// labeled by the name in their mail and the role the mail shows (votes from the read, see roleOf); else rules.company.colleagueRole.
export async function insidePeople(ownerEmail = '', company = defaultRules().company) {
  const rows = await q(`select u.id::text as id, lower(u.email) as email, coalesce(u.username, u.email) as name,
                               (select role from pro_role_assignments r where r.tenant_id=u.tenant_id and r.user_id::text=u.id::text and r.proc_def_id='*' limit 1) as role
                          from users u where u.tenant_id=$1 and not coalesce(u.is_agent,false)`, [T()])
  return insideOf(rows, ownerEmail, company)
}
export function insideOf(rows, ownerEmail = '', company = defaultRules().company) {
  const members = new Map(rows.map((r) => [r.email, { id: r.id, role: r.role || '', name: r.name }]))
  const pub = new Set((company?.publicDomains || []).map(lower))
  const domains = new Set([...members.keys(), lower(ownerEmail)].map(domainOf).filter((d) => d && !pub.has(d)))
  const fallback = company?.colleagueRole || '담당자'
  const names = new Map(), votes = new Map()
  const roleOf = (a) => {
    const v = votes.get(a)
    if (v?.size) return [...v].sort((x, y) => y[1] - x[1])[0][0]
    return members.get(a)?.role || (members.has(a) ? '담당자' : fallback)
  }
  return {
    domains, names,
    has: (a) => members.has(lower(a)) || domains.has(domainOf(a)),
    get(a) {
      a = lower(a)
      if (!this.has(a)) return undefined
      const m = members.get(a), role = m?.role || roleOf(a)
      const name = m?.name && !m.name.includes('@') ? m.name : names.get(a) || m?.name || a.split('@')[0]
      return { id: m?.id || null, role, label: `${name}(${role})`, guessed: !m?.role }
    },
    // the read says what a colleague without an assigned role does (their signature, what they hand over)
    vote(a, role) {
      a = lower(a); role = String(role || '').trim().slice(0, 12)
      if (!role || members.get(a)?.role || !this.has(a)) return
      if (!votes.has(a)) votes.set(a, new Map())
      votes.get(a).set(role, (votes.get(a).get(role) || 0) + 1)
    },
    voted: () => [...votes.keys()].map((a) => [a, roleOf(a)]),
    learnNames(mails) { for (const m of mails) { const a = addrOf(m.from), n = nameOf(m.from); if (n && this.has(a) && !names.has(a)) names.set(a, n) } },
  }
}

// Read `days` of one person's mailbox into pro_mail_history, with progress in pro_onto_jobs. Returns the job id at once.
export async function startMailHistory(me, { days = 90 } = {}) {
  const [running] = await q(`select id from pro_onto_jobs where tenant_id=$1 and user_id=$2 and kind='mail_history' and status='running' and started_at > now() - interval '12 hours'`, [T(), me.id])
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
  const { archiveMails, archivedOf, mailOf } = await import('../mailArchive.js')
  // the company's process-discovery skill (rules · prompts), recorded with the job
  const skill = await discoverySkill()
  const R = skill.rules
  const inside = await insidePeople(me.email, R.company)
  const say = sayer(jobId)
  const update = (set, args) => q(`update pro_onto_jobs set ${set} where id=$1`, [jobId, ...args])
  await say(skill.source === 'bundled' ? '기본 「프로세스 찾기」 스킬로 읽어요.' : `회사가 고친 「프로세스 찾기」 스킬(${skill.version})로 읽어요.`)
  await q(`update pro_onto_jobs set detail=coalesce(detail,'{}'::jsonb) || $2::jsonb where id=$1`, [jobId, { skill: { source: skill.source, version: skill.version } }])
  if (acc?.provider === 'gmail') mails = await gmailMails(await googleAccessToken(me.id), days, { inside, formsDir: formsDirOf(), forms: R.forms, fetchAtOnce: R.mailbox.fetchAtOnce,
    archived: async (ids) => new Map([...(await archivedOf(me.id, ids))].map(([k, r]) => [k, mailOf(r)])),
    onBusy: async (i) => { if (i === 0) await say('Gmail 이 1분에 받을 수 있는 양을 넘었어요. 잠깐 쉬었다가 이어서 받아요.', 'busy') },
    onPage: async (n) => { await update('total=$2', [n]); if (n % 1000 < 100) await say(`메일 ${n.toLocaleString('ko-KR')}통째 받는 중이에요.`, 'fetch') } })
  else if (acc?.provider === 'demo' || !acc) {
    const a = demoArchive(me.email)
    if (!a) throw new Error('이 메일함에는 읽을 지난 메일이 없어요.')
    const cut = new Date(a.today || Date.now()).getTime() - days * 86_400_000
    mails = await demoFields(a.mails.filter((m) => new Date(m.date).getTime() >= cut), inside, R.forms)
  } else throw new Error('IMAP 지난 메일 읽기는 아직 준비 중이에요.')
  // every mail read is kept in its owner's mail archive (the demo mailbox's whole text is its new part and the quoted mail)
  await archiveMails(me.id, acc?.provider || 'demo', mails.filter((m) => !m.archived).map((m) => (m.body != null ? m : { ...m, body: [m.text, m.quoted].filter(Boolean).join('\n\n') })), 'history')
    .catch((e) => console.warn('[ontology] mail archive', e.message))
  await update('total=$2', [mails.length])
  inside.learnNames(mails)
  const colleagues = new Set(mails.flatMap((m) => [addrOf(m.from), ...(m.to || [])].map(addrOf)).filter((a) => inside.has(a) && a !== lower(me.email)))
  await say(`메일 ${mails.length.toLocaleString('ko-KR')}통을 가져왔어요${mails.some((m) => m.archived) ? ` (보관함에 있던 ${mails.filter((m) => m.archived).length.toLocaleString('ko-KR')}통은 다시 받지 않았어요)` : ''}.`)
  const kept = mails.filter((m) => !notWork(m, R.filters))
  const threads = threadsOf(kept)
  if (inside.domains.size) await say(`${[...inside.domains].join(' · ')} 주소는 회사 사람으로 봐요 — 메일에 나온 동료 ${colleagues.size}명.`)
  await say(`뉴스레터 · 자동 알림 · 일정 초대 ${(mails.length - kept.length).toLocaleString('ko-KR')}통은 규칙으로 걸렀어요. 남은 메일은 스레드 ${threads.length.toLocaleString('ko-KR')}개(건)로 묶었어요.`)
  // the names the company already uses: the chat handovers are matched first, so the mail speaks the same words
  // (the filtered mails count as read at once; the screen says what is going on while the chat names are matched)
  let done = mails.length - kept.length, work = 0
  const chat = await q(`select coalesce(nullif(activity_label,''), nullif(next_activity_label,''), instruction) as raw from handover_events where tenant_id=$1`, [T()])
  await update(`done=$2, detail=coalesce(detail,'{}'::jsonb) || $3::jsonb`, [done, { stage: 'chat', chat: chat.length }])
  if (chat.length) await (await import('./names.js')).resolveLabels(chat.map((r) => ({ raw: r.raw }))).catch((e) => console.warn('[ontology] chat names', e.message))
  if (chat.length) await say(`채팅 인계 기록 ${chat.length}건의 일 이름을 먼저 맞췄어요. 메일도 그 이름으로 읽어요.`)
  const known = (await q(`select distinct task from pro_onto_labels where tenant_id=$1 and task <> ''`, [T()])).map((r) => r.task)
  const found = new Set(known)
  await update(`found=$2, detail=coalesce(detail,'{}'::jsonb) || $3::jsonb`, [found.size, { stage: 'mail' }])
  // four threads at a time (one model call each); progress moves as each finishes
  const readAlone = new RegExp(R.readAlone, 'i')
  const readOne = async (t) => {
    // a single plain mail with no attachment and no reply is not a flow: it costs no model call
    const one = t.mails.length === 1 && !(t.mails[0].attachments || []).length && !readAlone.test(`${t.mails[0].subject || ''}\n${t.mails[0].text || ''}`)
    const read = one ? [] : await readThread(t, inside, [...found], R.mailbox.historyTextChars)
    for (const r of read) {
      const m = t.mails[Number(r.i)]
      if (m && r.from_role) inside.vote(addrOf(m.from), r.from_role)
      if (!m || !r.work || !String(r.task || '').trim()) continue
      const from = personOf(m.from, inside)
      const to = (m.to || []).map((x) => personOf(x, inside))
      const act = ['request', 'deliver', 'approve', 'notify'].includes(r.act) ? r.act : 'notify'
      const amount = amountOf(`${m.subject || ''}\n${m.text || ''}`)
      await q(`insert into pro_mail_history (tenant_id, owner_id, mail_id, case_id, occurred_at, from_addr, to_addrs, from_role, to_role, activity_label, act, artifacts, subject_hash, attrs)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
               on conflict (tenant_id, mail_id) do update set case_id=excluded.case_id, activity_label=excluded.activity_label, act=excluded.act, from_role=excluded.from_role, to_role=excluded.to_role, attrs=excluded.attrs`, [
        T(), me.id, m.id, caseIdOf(t.id), m.date, from.addr, to.map((x) => x.addr), from.role, to[0]?.role || null, String(r.task).trim().slice(0, 40), act,
        JSON.stringify((m.attachments || []).map((f) => ({ name: f.name, type: f.type || String(f.name).split('.').pop(), ...(f.fields?.length ? { fields: f.fields } : {}), ...(f.file?.startsWith('forms/') ? { file: f.file } : {}) }))), crypto.createHash('sha1').update(baseSubject(m.subject)).digest('hex').slice(0, 16),
        JSON.stringify({ ...(amount ? { amount } : {}), ...(r.recur?.every ? { recur: r.recur } : {}) })])
      work++
      const task = String(r.task).trim()
      if (!found.has(task)) await say(`새 일 「${task}」을 찾았어요 — ${act === 'deliver' ? '결과물을 건네는 메일' : act === 'request' ? '일을 맡기는 메일' : act === 'approve' ? '승인하는 메일' : '알리는 메일'}에서.`, 'task')
      if (r.recur?.every && r.recur.says) await say(`정해진 때마다 하는 일 같아요: “${String(r.recur.says).slice(0, 40)}” → 「${String(r.recur.task || task).slice(0, 30)}」`, 'recur')
      for (const f of m.attachments || []) if (f.fields?.length) await say(`보낸 첨부에서 「${formKey(f.name)}」 양식의 칸 ${f.fields.length}개를 읽었어요.`, 'form')
      found.add(task)
    }
    done += t.mails.length
    await q(`insert into pro_mail_reads (tenant_id, owner_id, thread_id, mail_ids, skill_version) values ($1,$2,$3,$4,$5)
             on conflict (tenant_id, owner_id, thread_id) do update set mail_ids=excluded.mail_ids, skill_version=excluded.skill_version, read_at=now()`,
      [T(), me.id, String(t.id), t.mails.map((m) => String(m.id)), rv])
    await update('done=$2, kept=$3, found=$4, cursor=$5', [done, work, found.size, t.id])
    emit(me.id, 'ontology', { job: jobId, done, total: mails.length, kept: work, found: found.size })
  }
  // read again (a second onboarding): a thread read before by this version of the skill, with no mail since, is not read again
  const before = new Map((await q(`select thread_id, mail_ids, skill_version from pro_mail_reads where tenant_id=$1 and owner_id=$2`, [T(), me.id])).map((r) => [r.thread_id, r]))
  const rv = readVersion(skill)
  const unchanged = (t) => { const b = before.get(String(t.id)); return b && b.skill_version === rv && t.mails.every((m) => b.mail_ids.includes(String(m.id))) }
  const queue = threads.filter((t) => !unchanged(t))
  if (queue.length < threads.length) {
    const skip = threads.filter(unchanged)
    done += skip.reduce((n, t) => n + t.mails.length, 0)
    await update('done=$2', [done])
    await say(`전에 읽은 스레드 ${skip.length.toLocaleString('ko-KR')}개는 그대로라 건너뛰어요 — 새 메일이 붙었거나 읽는 규칙이 바뀐 ${queue.length.toLocaleString('ko-KR')}개만 읽어요.`)
  }
  await Promise.all(Array.from({ length: R.mailbox.threadsAtOnce || 4 }, async () => { while (queue.length) await readOne(queue.shift()) }))
  // a colleague's role: what most of their mails showed (rows read before the votes came in are rewritten)
  const voted = inside.voted()
  for (const [a, role] of voted) {
    await q(`update pro_mail_history set from_role=$3 where tenant_id=$1 and owner_id=$4 and from_addr=$2`, [T(), a, role, me.id])
    await q(`update pro_mail_history set to_role=$3 where tenant_id=$1 and owner_id=$4 and to_addrs[1]=$2`, [T(), a, role, me.id])
  }
  if (voted.length) {
    const byRole = new Map()
    for (const [a, role] of voted) byRole.set(role, [...(byRole.get(role) || []), (inside.names.get(a) || a.split('@')[0])])
    await say(`메일로 본 동료의 역할: ${[...byRole].sort((x, y) => y[1].length - x[1].length).slice(0, 6).map(([r, ns]) => `${r} ${ns.length}명`).join(' · ')}.`)
  }
  await say(`메일 ${work.toLocaleString('ko-KR')}통이 일로 읽혔고, 일 이름 ${found.size}개를 찾았어요. 이제 흐름을 셉니다.`)
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
