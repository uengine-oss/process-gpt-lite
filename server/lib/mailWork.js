// 일 하나에 작업 폴더 하나 (2026-11-24 사용자 결정 — 「메일로 일이 시작되면 에이전트들이 그 일을 하는 폴더가 있어야 한다. 첫 메일부터 거기
// 담기고 결과물이 쌓이고, 그 맥락을 다음 단계의 에이전트들이 참고한다」; 이은 메일이 엔진 단계의 입력이 되는 것도 이 폴더로).
// 설계 docs/mail-work-folder/design.md, 스펙 openspec/specs/mail-work-folder.
//   onLinked     — lib/mailFlow.js linkCards: a mail that started an instance, or joined one, goes into the instance's work folder (made the
//                  first time: a shared folder owned by the person whose mail it is, named after the instance)
//   addMail      — the mail as it arrived: 메일/NN_<날짜>_<제목>.eml (the message) · .md (its headers and body, to read) · 메일/NN_첨부/<file>,
//                  one commit by that person in main; once the instance line is there it gets the mail too (folders/line.js syncLine)
//   recordDone   — what the instance's finished steps made: 산출물/NN_<단계>/ (its files and 결과.md with its values), one commit per step on
//                  the instance line (inst/<id> — the line folders/work.js chains an instance's agent steps on, '@previous')
//   stepContext  — what an agent step of the instance reads (ontology/run.js · mining/worker.js): the mails, first one first, and the outputs
//   tick         — folders/work.js stepTick: agent steps of other engines (deepagents · cli-agent) of these instances get the folder on the
//                  line, and finished steps are recorded
// The link is the folder's own (pro_folders.settings.work = {instId, instances, caseId, line, dirs, mails, recorded, …}): no table of its own.
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { q, admin } from './supa.js'
import { emit } from './bus.js'
import { addMessage } from './store.js'
import { L } from './lang.js'
import { jo } from './mailFlow.js'
import * as S from './folders/service.js'
import * as G from './folders/git.js'
import { lineOf, onLine, syncLine } from './folders/line.js'
import { statusSql, notCancelledSql } from './enums.js'

const T = () => config.tenantId
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const TZ = () => process.env.PRO_TZ || 'Asia/Seoul'
const when = (d) => { const t = d ? new Date(d) : new Date(); return Number.isNaN(t.getTime()) ? new Date() : t }
export const dayOf = (d) => when(d).toLocaleDateString('sv-SE', { timeZone: TZ() })
const minuteOf = (d) => when(d).toLocaleString('sv-SE', { timeZone: TZ(), hour12: false }).slice(0, 16)
export const pad = (n) => String(n).padStart(2, '0')
export { lineOf }

export const DEFAULTS = { mailChars: 1500, mailTotal: 5000, outputChars: 800, outputTotal: 2500, sweepSeconds: 20, fileMB: 25, shareWithRoles: false }
// who else gets the folder: no one unless the company turns it on (rules.mailWork.shareWithRoles) — the folder holds the mailbox
// owner's own mail, which stays theirs (the map keeps no sentence of it); the owner adds people on the folder page. On: the people the
// case's roles went to (not agents), as viewers
export const sharedWith = (bindings, ownerId, R = DEFAULTS) => (R?.shareWithRoles === true
  ? [...new Set((Array.isArray(bindings) ? bindings : []).filter((b) => b?.userId && b.from !== 'agent' && String(b.userId) !== String(ownerId)).map((b) => String(b.userId)))]
  : [])
// the skill's numbers (skills/process-discovery rules.json mailWork), the defaults when it cannot be read
async function workRules() {
  try { return { ...DEFAULTS, ...((await (await import('./ontology/discovery.js')).rules()).mailWork || {}) } } catch { return { ...DEFAULTS } }
}

// ---------- names (pure) ----------
// a part of a file name: no path separators, reserved or control characters, at most `max` characters
export function safeName(s, max = 40, empty = '') {
  const t = String(s ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^\.+/, '').slice(0, max).trim().replace(/[. ]+$/, '')
  return t || empty
}
// the folder's directories, in the language it was made in (kept on the folder: a later mail goes where the first one went)
export const DIRS = () => ({ mail: L('메일', 'Mail'), attach: L('첨부', 'attachments'), outputs: L('산출물', 'Outputs'), result: L('결과.md', 'result.md') })
export const dirsOf = (work) => ({ ...DIRS(), ...(work?.dirs || {}) })
// mail n's files: 01_2026-11-24_세미나 견적 부탁드립니다.eml · .md
export const mailStem = (n, date, subject) => `${pad(n)}_${dayOf(date)}_${safeName(subject, 40, L('제목 없음', 'no subject'))}`
// the next number of a directory whose entries are NN_…
export function nextNumber(paths, dir) {
  const head = `${dir}/`
  let max = 0
  for (const p of paths || []) {
    if (!String(p).startsWith(head)) continue
    const n = parseInt(String(p).slice(head.length), 10)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return max + 1
}
// a name not yet taken in `taken` (a Set it is added to): 견적서.xlsx, 견적서 (2).xlsx …
export function uniqueName(name, taken) {
  const ext = path.posix.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let n = name
  for (let i = 2; taken.has(n); i++) n = `${stem} (${i})${ext}`
  taken.add(n)
  return n
}
const who = (a) => (a?.name ? `${a.name} <${a.address}>` : a?.address || '')
// the mail to read: its headers as a list, then its body
export function mailMarkdown(m, { attachments = [] } = {}) {
  const list = (xs) => (xs || []).map(who).filter(Boolean).join(', ')
  const rows = [
    [L('보낸 사람', 'From'), who(m.from)],
    [L('받는 사람', 'To'), list(m.to)],
    [L('참조', 'Cc'), list(m.cc)],
    [L('날짜', 'Date'), m.date ? minuteOf(m.date) : ''],
    [L('첨부', 'Attachments'), attachments.map((a) => `${a.name} (${a.path})`).join(', ')],
  ].filter(([, v]) => v)
  // (a line break of the mail stays one where the .md is shown as Markdown: two spaces before it)
  const body = String(m.text || '').replace(/\r\n?/g, '\n').trim().split('\n').map((l, i, all) => (l && all[i + 1] ? `${l.trimEnd()}  ` : l.trimEnd())).join('\n')
  return [`# ${clean(m.subject) || L('(제목 없음)', '(no subject)')}`, '', ...rows.map(([k, v]) => `- ${k}: ${v}`), '', '---', '', body, ''].join('\n')
}
// what is under a mail's header in its .md (the mail's own text)
export const bodyOfMd = (md) => { const s = String(md || ''); const i = s.indexOf('\n---\n'); return (i < 0 ? s : s.slice(i + 5)).replace(/ {2}\n/g, '\n').trim() }

// what a finished step left (todolist.output {formId: {field: value}}, sometimes flat): its files ({url, name}) and its other values
export function outputsOf(row) {
  const all = row?.output && typeof row.output === 'object' ? row.output : {}
  const { worktree: _w, media: _m, cliagents_session_id: _s, replay_limited: _r, lite_cancelled: _c, text, ...rest } = all
  const forms = Object.keys(rest).length && Object.values(rest).every((v) => v && typeof v === 'object' && !Array.isArray(v)) ? rest : { _: { ...rest, ...(text ? { text } : {}) } }
  const files = [], fields = []
  for (const vals of Object.values(forms)) {
    for (const [k, v] of Object.entries(vals || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && v.url) files.push({ key: k, name: String(v.name || k), url: String(v.url) })
      else if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) fields.push({ key: k, value: v })
    }
  }
  if (row?.output_url) files.push({ key: 'output_url', name: path.posix.basename(String(row.output_url).split('?')[0]) || 'result', url: String(row.output_url) })
  return { files, fields }
}
const valueText = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v)
  : Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'checkpoint' in x) ? v.map((x) => `- ${x.ok === true ? '✓' : x.ok === false ? '✗' : '·'} ${x.checkpoint}${x.note ? ` — ${x.note}` : ''}`).join('\n')
    : `\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``)
// a step's 결과.md: who did it and when, its files, its values
export function resultMarkdown(row, out, copied, by, { inst = '' } = {}) {
  // (end_at: the work item's end as the engine keeps it — Korean time without a zone, see ontology/mapengine.js NOW_KST)
  const lines = [`# ${row.activity_name || L('단계', 'Step')}`, '', `- ${L('한 사람', 'Done by')}: ${by.name}${row.end_at ? ` · ${row.end_at}` : ''}`]
  if (inst) lines.push(`- ${L('일', 'Work')}: ${inst}`)
  if (copied.length) {
    lines.push('', `## ${L('파일', 'Files')}`, '')
    for (const f of copied) lines.push(f.path ? `- ${f.name} (${path.posix.basename(f.path)})` : `- ${f.name} — ${f.url}`)
  }
  for (const f of out.fields) lines.push('', `## ${f.key}`, '', valueText(f.value))
  return `${lines.join('\n')}\n`
}

// ---------- the folder of an instance ----------
// by the instance; else the folder of its case (a case moved on: run.js moveCase starts a new instance of the same work), which then
// knows this instance too
export async function workFolderOf(instId) {
  if (!instId) return null
  const [f] = await q(`select * from pro_folders where tenant_id=$1 and settings ? 'work' and (settings->'work'->'instances') ? $2 order by created_at limit 1`, [T(), String(instId)])
  if (f) return f
  const [c] = await q(`select id::text as id from pro_po_cases where tenant_id=$1 and $2 = any(instances) limit 1`, [T(), String(instId)]).catch(() => [])
  if (!c) return null
  const [g] = await q(`update pro_folders set settings = jsonb_set(settings, '{work,instances}', coalesce(settings->'work'->'instances', '[]'::jsonb) || to_jsonb($3::text))
                       where id = (select id from pro_folders where tenant_id=$1 and settings->'work'->>'caseId' = $2 order by created_at limit 1) returning *`, [T(), c.id, String(instId)])
  return g || null
}

async function personOf(userId) {
  const [p] = await q('select email, name from pro_profile where user_id=$1', [userId])
  return { id: userId, email: p?.email || 'folders@pgpt-pro.local', name: p?.name || p?.email || L('나', 'me') }
}

// The instance's folder, made once (two links of one instance at once make one folder): a shared folder owned by the person, named after
// the instance; shared with no one else unless the company says so (sharedWith); the instance's conversation has it attached for reference, so what
// is asked there reads the mails (threadFolders.js refHint)
const making = new Map()
export async function ensureWorkFolder(userId, inst) {
  const have = await workFolderOf(inst.instId)
  if (have) return have
  const key = `${T()}:${inst.instId}`
  if (!making.has(key)) making.set(key, makeFolder(userId, inst).finally(() => making.delete(key)))
  return making.get(key)
}
async function makeFolder(userId, inst) {
  const again = await workFolderOf(inst.instId)
  if (again) return again
  const me = await personOf(userId)
  const [c] = await q(`select id::text as id, bundle, bindings from pro_po_cases where tenant_id=$1 and $2 = any(instances) limit 1`, [T(), String(inst.instId)]).catch(() => [])
  const iname = inst.name || (await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [inst.instId]))[0]?.proc_inst_name || ''
  const base = safeName(iname || inst.procName, 60, L('메일로 시작한 일', 'Work from a mail'))
  let name = base
  for (let n = 2; (await q('select 1 from pro_folders where tenant_id=$1 and name=$2', [T(), name])).length; n++) name = `${base} (${n})`
  const f = await S.createFolder(me, { name, slug: `work-${String(inst.instId).replace(/[^A-Za-z0-9]/g, '').slice(-12).toLowerCase()}`,
    description: L(`「${iname || name}」의 작업 폴더 — 메일과 단계 결과가 모여요`, `Work folder of "${iname || name}" — its mails and step results gather here`) })
  const work = { instId: String(inst.instId), instances: [String(inst.instId)], caseId: c?.id || inst.caseId || null, inst: iname, proc: inst.proc || c?.bundle || null,
    procName: inst.procName || null, owner: String(userId), line: lineOf(inst.instId), dirs: DIRS(), mails: [], recorded: [], at: new Date().toISOString() }
  const [row] = await q(`update pro_folders set settings = settings || jsonb_build_object('work', $2::jsonb) where id=$1 returning *`, [f.id, JSON.stringify(work)])
  for (const id of sharedWith(c?.bindings, userId, await workRules())) await S.setMember(row, me, { id, role: 'viewer' }).catch(() => {})
  const { instanceThread } = await import('./engine.js')
  const th = await instanceThread(userId, inst.instId, iname || undefined)
  await q(`insert into pro_thread_folders (thread_id, user_id, folder_id, mode) values ($1,$2,$3,'ref') on conflict (thread_id) do nothing`, [th, userId, row.id]).catch((e) => console.warn('[mail work] attach', e.message))
  return row
}

// ---------- a mail into the folder ----------
// the mail as the mailbox keeps it (lib/mailReply.js sourceOf); a mailbox that no longer has it: what its card knows, as a message
async function messageOf(userId, card) {
  const R = await import('./mailReply.js')
  const [acc] = await q('select provider, address from pro_mail_accounts where user_id=$1', [userId])
  if (acc) {
    try { return await R.sourceOf(userId, acc.provider, card.source.mail_id, { to: acc.address || '' }) } catch (e) { console.warn('[mail work] original', e.message) }
  }
  const MailComposer = (await import('nodemailer/lib/mail-composer')).default
  const date = card.created_at ? new Date(card.created_at) : new Date()
  const raw = await new MailComposer({ from: card.source.from || '', subject: card.source.subject || '', text: card.text || '', date }).compile().build()
  return { raw, from: R.addresses(card.source.from)[0] || null, to: [], cc: [], subject: card.source.subject || '', date: date.toISOString(), text: card.text || '', attachments: [], partial: true }
}

async function write(root, rel, buf) {
  const p = S.safeRel(rel)
  const host = path.join(root, p)
  await fs.mkdir(path.dirname(host), { recursive: true })
  await fs.writeFile(host, buf)
  return p
}

// → the mail's entry ({mailId, n, eml, md, …}), or null when the folder has it already
export async function addMail(userId, folder, card, { via = null } = {}) {
  const mailId = String(card?.source?.mail_id || '')
  if (!mailId) return null
  if ((folder.settings?.work?.mails || []).some((m) => m.mailId === mailId)) return null
  const me = await personOf(userId)
  // (read before the folder is locked — a mailbox may be slow; its number and files are decided in the lock)
  const src = await messageOf(userId, card)
  const entry = await S.serial(folder.id, async () => {
    const f = await S.folderById(folder.id)
    const work = f.settings?.work || {}
    if ((work.mails || []).some((m) => m.mailId === mailId)) return null
    const dirs = dirsOf(work)
    const n = nextNumber((await G.lsTree(f.repo_path, f.default_branch)).map((x) => x.path), dirs.mail)
    const stem = mailStem(n, src.date, src.subject)
    const taken = new Set()
    const atts = []
    for (const a of src.attachments || []) {
      const name = uniqueName(safeName(a.name, 80, 'file'), taken)
      atts.push({ name, path: await write(f.repo_path, `${dirs.mail}/${pad(n)}_${dirs.attach}/${name}`, a.content) })
    }
    const eml = await write(f.repo_path, `${dirs.mail}/${stem}.eml`, src.raw)
    const md = await write(f.repo_path, `${dirs.mail}/${stem}.md`, Buffer.from(mailMarkdown(src, { attachments: atts })))
    const subject = clean(src.subject) || L('(제목 없음)', '(no subject)')
    const commit = await S.commitMainNow(f, { name: me.name, email: me.email }, L(`메일 ${pad(n)} · ${subject}`, `Mail ${pad(n)} · ${subject}`))
    const e = { mailId, n, eml, md, subject: src.subject || '', from: who(src.from), date: src.date || null, attachments: atts.map((a) => a.name), via, by: String(userId),
      at: new Date().toISOString(), commit, ...(src.partial ? { partial: true } : {}) }
    await q(`update pro_folders set settings = jsonb_set(settings, '{work,mails}', coalesce(settings->'work'->'mails', '[]'::jsonb) || $2::jsonb) where id=$1`, [f.id, JSON.stringify([e])])
    return e
  })
  if (!entry) return null
  const now = await S.folderById(folder.id)
  // the steps after this start from the line: the mail goes there too
  await syncLine(now, now.settings.work.line, { instId: now.settings.work.instId, name: now.settings.work.inst }).catch((e) => console.warn('[mail work] line', e.message))
  import('./folders/indexer.js').then((x) => x.reindex(now)).catch((e) => console.warn('[mail work] index', e.message))
  return entry
}

// lib/mailFlow.js linkCards: the mail's instance has its folder, the mail is in it, the cards know the folder, and the instance's
// conversation says so (2026-11-18: an instance's work is said on its page). → {folder, added, made}
export async function onLinked(userId, card, inst) {
  if (!inst?.instId || !card?.source?.mail_id) return null
  const made = !(await workFolderOf(inst.instId))
  const folder = await ensureWorkFolder(userId, inst)
  const added = await addMail(userId, folder, card, { via: inst.via || null })
  const ref = { slug: folder.slug, name: folder.name }
  const rows = await q(`update pro_actions set source = jsonb_set(source, '{inst,folder}', $3::jsonb) where user_id=$1 and source->'inst'->>'instId' = $2
                        and not (source->'inst' ? 'folder') returning *`, [userId, String(inst.instId), JSON.stringify(ref)])
  for (const r of rows) emit(userId, 'action', r)
  if (added) {
    const { instanceThread } = await import('./engine.js')
    const th = await instanceThread(userId, inst.instId, inst.name || undefined)
    const nn = pad(added.n)
    const s = clean(added.subject) || L('(제목 없음)', '(no subject)')
    await addMessage(userId, th, 'agent', 'chip', { icon: 'folder', folder: folder.slug, folderName: folder.name, mailNo: added.n,
      text: made
        ? L(`작업 폴더 ‘${folder.name}’${jo(folder.name, '을/를')} 만들고 메일 ${nn} 「${s}」${jo(s, '을/를')} 넣었어요`, `Made the work folder ‘${folder.name}’ and put mail ${nn} "${s}" in it`)
        : L(`작업 폴더 ‘${folder.name}’에 메일 ${nn} 「${s}」${jo(s, '을/를')} 넣었어요`, `Put mail ${nn} "${s}" in the work folder ‘${folder.name}’`) })
  }
  emit(userId, 'folders', { slug: folder.slug })
  return { folder: ref, added, made }
}

// ---------- what the steps made ----------
// a file a step made, from this server's own storage (a link elsewhere is only named in 결과.md)
async function fileBytes(url, maxMB) {
  const { storageKey } = await import('./mailReply.js')
  const key = storageKey(url)
  if (!key) return null
  const { data, error } = await admin.storage.from('files').download(key)
  if (error || !data) return null
  const buf = Buffer.from(await data.arrayBuffer())
  return buf.length <= maxMB * 1024 * 1024 ? buf : null
}
async function actorOf(row) {
  if (row.agent_orch && String(row.agent_mode || '').toUpperCase() !== 'DRAFT') return { name: L('업무 에이전트', 'Business agent'), email: 'agent@pgpt-pro.local' }
  const id = String(row.user_id || '').split(',')[0].trim()
  const [p] = id ? await q('select name, email from pro_profile where user_id::text=$1 or email=$1 limit 1', [id]).catch(() => []) : []
  return { name: p?.name || p?.email || id || L('담당자', 'Assignee'), email: p?.email || 'folders@pgpt-pro.local' }
}

// The instance's finished steps (done or submitted, not cancelled, with an output; a step that already works in the folder — work.js, or a
// local CLI agent on the assignee's desktop (lib/localAgents, agent_config.local) — leaves its result there itself) go onto the line, one commit per step. → the ids recorded now
const recording = new Map()
export function recordDone(folder) {
  if (!recording.has(folder.id)) recording.set(folder.id, recordIn(folder.id).finally(() => recording.delete(folder.id)))
  return recording.get(folder.id)
}
async function recordIn(folderId) {
  const folder = await S.folderById(folderId)
  const work = folder?.settings?.work
  if (!work?.instances?.length) return []
  const rows = await q(`select t.id::text as id, t.proc_inst_id, t.activity_id, t.activity_name, ${statusSql('t.')} as status, t.output, t.output_url, t.user_id,
                               t.agent_orch::text as agent_orch, t.agent_mode::text as agent_mode, to_char(t.end_date, 'YYYY-MM-DD HH24:MI') as end_at
                        from todolist t where t.proc_inst_id = any($1) and t.status::text in ('DONE','SUBMITTED') and ${notCancelledSql('t.')} and t.output is not null
                          and not (t.id::text = any($2::text[])) and not (coalesce(t.agent_config, '{}'::jsonb) ? 'folder') and not (coalesce(t.agent_config, '{}'::jsonb) ? 'local')
                        order by t.end_date nulls last, t.start_date nulls last`, [work.instances, (work.recorded || []).map(String)])
  if (!rows.length) return []
  const R = await workRules()
  const dirs = dirsOf(work)
  const done = []
  const head = await onLine(folder, work.line, async (dir) => {
    for (const row of rows) {
      const out = outputsOf(row)
      // (the request's own step — 요청 접수 — is the first mail, already in the folder)
      if (row.activity_id === 'intake' || (!out.files.length && !out.fields.length)) { done.push(row.id); continue }
      const nn = pad(nextNumber((await G.lsTree(dir, 'HEAD')).map((x) => x.path), dirs.outputs))
      const base = `${dirs.outputs}/${nn}_${safeName(row.activity_name, 40, L('단계', 'step'))}`
      const taken = new Set([dirs.result])
      const copied = []
      for (const f of out.files) {
        const buf = await fileBytes(f.url, R.fileMB).catch(() => null)
        copied.push({ ...f, path: buf ? await write(dir, `${base}/${uniqueName(safeName(f.name, 80, 'file'), taken)}`, buf) : null })
      }
      const by = await actorOf(row)
      await write(dir, `${base}/${dirs.result}`, Buffer.from(resultMarkdown(row, out, copied, by, { inst: work.inst })))
      await G.commitAll(dir, L(`단계 결과 · ${row.activity_name}`, `Step result · ${row.activity_name}`), by)
      done.push(row.id)
    }
  }, { instId: work.instId, name: work.inst })
  if (done.length) await q(`update pro_folders set settings = jsonb_set(settings, '{work,recorded}', coalesce(settings->'work'->'recorded', '[]'::jsonb) || $2::jsonb) where id=$1`, [folder.id, JSON.stringify(done)])
  if (head) emit(work.owner, 'folders', { slug: folder.slug })
  return done
}

// ---------- what a step reads ----------
// the instance's mails (first one first, each body cut to the skill's length) and the outputs on the line, and the note an agent step is
// given (the skill's prompt work-folder) → null when the instance has no work folder
export async function stepContext(instId) {
  const found = await workFolderOf(instId)
  if (!found) return null
  await recordDone(found).catch((e) => console.warn('[mail work] record', e.message))
  const folder = await S.folderById(found.id)
  const work = folder.settings.work
  const R = await workRules()
  const dirs = dirsOf(work)
  const line = work.line && await G.branchExists(folder.repo_path, work.line) ? work.line : null
  const ref = line || folder.default_branch
  const mails = []
  let used = 0
  for (const m of work.mails || []) {
    const body = bodyOfMd((await G.show(folder.repo_path, folder.default_branch, m.md).catch(() => null))?.toString('utf8') || '')
    const text = body.slice(0, Math.max(0, Math.min(R.mailChars, R.mailTotal - used)))
    used += text.length
    mails.push({ n: m.n, date: m.date ? dayOf(m.date) : '', from: m.from || '', subject: m.subject || '', attachments: m.attachments || [], text, cut: text.length < body.length, path: m.md })
  }
  const files = (await G.lsTree(folder.repo_path, ref)).map((x) => x.path).filter((p) => p.startsWith(`${dirs.outputs}/`))
  const outputs = []
  let out = 0
  for (const p of files) {
    const o = { path: p }
    if (path.posix.basename(p) === dirs.result) {
      const t = (await G.show(folder.repo_path, ref, p).catch(() => null))?.toString('utf8') || ''
      o.text = t.slice(0, Math.max(0, Math.min(R.outputChars, R.outputTotal - out)))
      out += o.text.length
    }
    outputs.push(o)
  }
  const mailText = mails.map((m) => [`[${pad(m.n)}] ${[m.date, m.from, `「${m.subject}」`, m.attachments.length ? `${L('첨부', 'attached')} ${m.attachments.join(', ')}` : ''].filter(Boolean).join(' · ')} (${m.path})`,
    m.text + (m.cut ? ' …' : '')].join('\n')).join('\n\n')
  const outText = outputs.map((o) => (o.text ? `- ${o.path}:\n${o.text}` : `- ${o.path}`)).join('\n')
  let tpl = ''
  try { tpl = await (await import('./ontology/discovery.js')).prompt('work-folder') } catch { /* the bundled skill has it */ }
  const fill = (s, v) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '')
  const note = `\n\n${fill(tpl || '[작업 폴더] {name} ({slug})\n{mails}\n{outputs}', { name: folder.name, slug: folder.slug,
    mails: mailText || L('(없음)', '(none)'), outputs: outText || L('(아직 없음)', '(none yet)') })}`
  return { folder: { id: folder.id, slug: folder.slug, name: folder.name }, ref, line, mails, outputs, note }
}

// the instance page's 「작업 폴더」 (routes/process.js): the folder when the person may open it, its mail count, its steps' results
export async function folderView(instId, user) {
  const f = await workFolderOf(instId)
  if (!f) return null
  const role = await S.roleOf(f, user)
  if (!role) return null
  const work = f.settings.work
  const [v] = await q(`select id from pro_folder_variations where folder_id=$1 and branch=$2 and status in ('open','ready','conflicted')`, [f.id, work.line])
  const ref = v ? work.line : f.default_branch
  const steps = new Set((await G.lsTree(f.repo_path, ref)).map((x) => x.path.split('/')).filter((p) => p.length > 2 && p[0] === dirsOf(work).outputs).map((p) => p[1]))
  return { slug: f.slug, name: f.name, role, mails: (work.mails || []).length, outputs: steps.size, line: v ? { id: v.id, branch: work.line } : null }
}

// ---------- background (folders/work.js stepTick) ----------
// agent steps of other engines (deepagents · cli-agent) of an instance with a work folder run on it, from the line (work.js stepOne);
// Lite's own step workers (pgpt-pro-*) read it through stepContext instead
export async function stepFolders() {
  const rows = await q(`select t.id, f.id as folder_id
                        from todolist t join pro_folders f on f.tenant_id=$1 and f.settings ? 'work' and (f.settings->'work'->'instances') ? coalesce(t.root_proc_inst_id, t.proc_inst_id)
                        where t.tenant_id=$1 and t.agent_orch is not null and t.agent_orch::text not like 'pgpt-pro-%'
                          and not (coalesce(t.agent_config, '{}'::jsonb) ? 'folder') and t.status::text not in ('DONE','SUBMITTED','COMPLETED','CANCELLED')
                          and t.updated_at > now() - interval '2 days'`, [T()])
  for (const r of rows) {
    await q(`update todolist set agent_config = coalesce(agent_config, '{}'::jsonb) || $2 where id=$1 and not (coalesce(agent_config, '{}'::jsonb) ? 'folder')`,
      [r.id, { folder: r.folder_id, base_ref: '@previous' }]).catch((e) => console.warn('[mail work] step', r.id, e.message))
  }
  return rows.length
}
// work folders with a finished step not yet recorded
export async function sweep() {
  const rows = await q(`select f.id from pro_folders f where f.tenant_id=$1 and f.settings ? 'work' and exists (
                          select 1 from todolist t where t.proc_inst_id in (select jsonb_array_elements_text(f.settings->'work'->'instances'))
                            and t.status::text in ('DONE','SUBMITTED') and t.output is not null and not (coalesce(f.settings->'work'->'recorded', '[]'::jsonb) ? t.id::text)
                            and not (coalesce(t.agent_config, '{}'::jsonb) ? 'folder') and not (coalesce(t.agent_config, '{}'::jsonb) ? 'local') and t.updated_at > now() - interval '14 days')
                        order by f.updated_at desc limit 20`, [T()])
  for (const r of rows) await recordDone({ id: r.id }).catch((e) => console.warn('[mail work] record', r.id, e.message))
  return rows.length
}
const swept = new Map() // tenant → when
export async function tick() {
  await stepFolders()
  const R = await workRules()
  if (Date.now() - (swept.get(T()) || 0) < R.sweepSeconds * 1000) return
  swept.set(T(), Date.now())
  await sweep()
}
