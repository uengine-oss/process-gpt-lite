// 들어온 문서를 공유 폴더에 정리하기 (2026-11-24 사용자: 「첨부한 파일을 폴더에 정리하는 기능도 만들긴 해야겠다… 주로 대화에서
// 문서가 유입되므로… 알아서 적정 폴더를 추천해주는 판정모델이 돌아서 추천해주면 좋다」).
// 문서가 들어오는 곳: 채팅에 붙인 파일 · 에이전트가 만든 파일 카드 · 팀원이 메신저로 보낸 파일(내 사본 카드) · 메일의 첨부(메일 시트).
// 그 카드에 「‘견적서’에 정리할까요? (확신 87%)」를 띄우고, 누르면 그 폴더 main 에 내 이름으로 커밋한다.
//   후보   — 내가 편집 이상인 관리형 폴더(연결형 · 스킬 폴더 · 보기/실행 권한은 아님). 일의 작업 폴더(settings.work)는 그 일의 문서일 때만
//   판정   — 스킬 folder-filing(skills/folder-filing, 회사가 고친 판이 있으면 그것)의 prompts/choose-folder.md 를 글자 보기로 묻고 첫 글자의
//            확률(decide.js oddsOf — ontology/streams.js sameWorkP 와 같은 길), 확률이 없는 모델이면 JSON. 하위 폴더로 나뉜 폴더는 하위 폴더도
//            같은 식으로. 맞는 폴더가 없으면(「새 폴더가 필요하다」가 가장 높거나 후보 없음) 새 폴더 이름을 짓는다. 뜻을 읽는 낱말 규칙은 없다.
//   보관   — 판정은 카드마다 한 번: pro_messages.content.filing, 메일 첨부는 pro_actions.source.filing[이름] (새 테이블 없음)
//   정리   — 폴더의 잠금(service.js serial) 안에서 파일을 쓰고 commitMainNow(내 이름), 같은 내용(같은 git blob)이 이미 있으면 쓰지 않고
//            그 자리를 알려 준다. 카드에 「‘<폴더>’에 정리했어요 · 열기」.
// 스펙 openspec/specs/messenger-drop-folder, 시험 test/filing.integration.test.js · e2e F-MD-*.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../config.js'
import { assertNoLink } from '../noLinks.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { L } from '../lang.js'
import { choose } from '../decide.js'
import { chatJson } from '../llm.js'
import { skillPack } from '../skillPack.js'
import * as S from './service.js'
import * as G from './git.js'
import * as REFS from './refs.js'
import { person } from '../people.js'

export const SKILL = 'folder-filing'
const T = () => config.tenantId
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const UUID = /^[0-9a-f-]{36}$/i
const NEW = '__new'
const ROOT = '__root'
const fail = (status, message) => Object.assign(new Error(message), { status })
const DEFAULTS = { maxFolders: 15, filesPerFolder: 6, textChars: 1200, contextLines: 6, timeoutMs: 8000, subfolders: { max: 8, min: 0.5 }, autoFile: { enabled: false, min: 0.9 } }

export async function filingSkill() {
  const s = await skillPack(SKILL)
  return { ...s, rules: { ...DEFAULTS, ...s.rules, subfolders: { ...DEFAULTS.subfolders, ...s.rules?.subfolders }, autoFile: { ...DEFAULTS.autoFile, ...s.rules?.autoFile } } }
}

// ---------- names (pure) ----------
// a file or folder name: no path separators, reserved or control characters
export function safeName(s, max = 120, empty = 'file') {
  const t = String(s ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^\.+/, '').slice(0, max).trim().replace(/[. ]+$/, '')
  return t || empty
}
// 견적서.xlsx, 견적서 (2).xlsx … — the first not in `taken`
export function freePath(p, taken) {
  if (!taken.has(p)) return p
  const ext = path.posix.extname(p)
  const stem = p.slice(0, p.length - ext.length)
  for (let i = 2; ; i++) if (!taken.has(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`
}
// the git blob id of some bytes (what `git ls-tree` lists): the same content already in a folder is found by it
export const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')

// a work folder takes only the documents of its own work: the instance (its conversation, its mail card) or one of its mails
export function ofWork(work, doc = {}) {
  if (!work) return true
  const insts = new Set([work.instId, ...(work.instances || [])].filter(Boolean).map(String))
  const mails = new Set((work.mails || []).map((m) => String(m?.mailId || '')).filter(Boolean))
  return (doc.instIds || []).some((i) => insts.has(String(i))) || (doc.mailIds || []).some((m) => mails.has(String(m)))
}

// ---------- the document ----------
// ref: {messageId} — a file card of mine (any of my conversations) | {shareId} — a file a teammate sent me (my copy's card) |
// {actionId, attachment} — the attachment of a mail card of mine, by name. → the document with how to read it and where its verdict is kept.
// deps.mailSource(user, action) → the mail with its attachments ({subject, from, text, attachments: [{name, type, content}]}) — tests
export async function docOf(user, ref = {}, deps = {}) {
  if (ref.shareId) return cardDoc(user, await cardOfShare(user, String(ref.shareId)))
  if (ref.messageId) {
    if (!UUID.test(String(ref.messageId))) throw fail(404, L('문서를 찾지 못했어요.', "I couldn't find the document."))
    const [m] = await q(`select m.*, t.kind as thread_kind, t.ref as thread_ref, t.title as thread_title, t.share_ref from pro_messages m join pro_threads t on t.id=m.thread_id
                         where m.id=$1 and t.user_id=$2 and m.kind='file'`, [String(ref.messageId), user.id])
    if (!m) throw fail(404, L('문서를 찾지 못했어요.', "I couldn't find the document."))
    return cardDoc(user, m)
  }
  if (ref.actionId && ref.attachment) return mailDoc(user, String(ref.actionId), String(ref.attachment), deps)
  if (ref.folderFile) return folderDoc(user, ref.folderFile)
  throw fail(400, L('정리할 문서를 알려 주세요.', 'Say which document to file.'))
}

// {folderFile: {slug, path, commit?, blob?, variation?}} — a shared folder's file dropped on another folder (lib/fileRefs.js dropInto):
// its content at the version named, read with my own access to that folder; where it came from goes in the commit message
async function folderDoc(user, it) {
  const { folderRef } = await import('../fileRefs.js')
  const r = await folderRef(user, it)
  const src = await S.folderById(r.folderId)
  return {
    key: `folder:${r.folderId}:${r.blob}`, kind: 'folder', name: safeName(r.name), instIds: [], mailIds: [], filing: null,
    bytes: async () => ({ buf: await G.git(src.repo_path, ['cat-file', 'blob', r.blob], { buffer: true }), type: '' }),
    context: async () => L(`공유 폴더 「${r.folder}」의 ${r.path}`, `${r.path} in the shared folder "${r.folder}"`),
    source: L(`출처: 공유 폴더 「${r.folder}」 ${r.path}${r.variation ? ` (변형 「${r.variation.title}」)` : ''} @ ${String(r.commit || '').slice(0, 12)}`,
      `Source: shared folder "${r.folder}" ${r.path}${r.variation ? ` (variation "${r.variation.title}")` : ''} @ ${String(r.commit || '').slice(0, 12)}`),
    save: async () => null,
  }
}

async function cardOfShare(user, shareId) {
  if (!UUID.test(shareId)) throw fail(404, L('받은 파일을 찾지 못했어요.', "I couldn't find that file."))
  const [s] = await q('select * from pro_shares where id=$1 and tenant_id=$2 and recipient_id=$3 and revoked_at is null', [shareId, T(), user.id])
  if (!s) throw fail(404, L('받은 파일을 찾지 못했어요.', "I couldn't find that file."))
  const own = async (id) => (id ? (await q(`select m.*, t.kind as thread_kind, t.ref as thread_ref, t.title as thread_title, t.share_ref from pro_messages m join pro_threads t on t.id=m.thread_id
                                              where m.id=$1 and t.user_id=$2 and m.kind='file'`, [id, user.id]))[0] : null)
  const have = await own(s.copy_message_id)
  if (have) return have
  // A share without a branch (a database without the worktree tables) has no card of mine until it is opened — and opening puts
  // one in the main chat. Read for a suggestion, its copy goes into my 「received files」 conversation instead (no list shows it),
  // and becomes the share's copy: opening it later reuses that card (shares.js openCopy), nothing is added to the main chat.
  const { bytes } = await import('../team/shares.js')
  const { saveAttachment } = await import('../attachments.js')
  const { filesThread, RECEIVED_REF } = await import('../team/uploads.js')
  const got = await bytes(user, shareId)
  const saved = await saveAttachment(user, got.name, got.type, got.buf)
  const owner = await person(s.owner_id)
  const t = await filesThread(user.id, RECEIVED_REF)
  const [m] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'agent','file',$2) returning id`,
    [t.id, { name: saved.name, url: saved.url, ...(saved.path ? { path: saved.path } : {}), shared: { by: owner?.name || L('팀원', 'Teammate'), shareId } }])
  // (only when no copy was made meanwhile)
  const [set] = await q('update pro_shares set copy_message_id=$2 where id=$1 and copy_message_id is null returning id', [shareId, m.id])
  if (!set) {
    await q('delete from pro_messages where id=$1', [m.id])
    const [again] = await q('select copy_message_id from pro_shares where id=$1', [shareId])
    return (await own(again?.copy_message_id)) || fail404()
  }
  return own(m.id)
}
const fail404 = () => { throw fail(404, L('받은 파일을 찾지 못했어요.', "I couldn't find that file.")) }

async function cardDoc(user, m) {
  const c = m.content || {}
  if (!c.url && !c.path) throw fail(400, L('내용이 없는 카드예요.', 'This card has no file behind it.'))
  return {
    key: `card:${m.id}`, kind: 'card', messageId: m.id, threadId: m.thread_id, name: safeName(c.name || path.posix.basename(String(c.path || c.url || '')) || 'file'),
    instIds: [m.thread_kind === 'process' ? m.thread_ref : null, c.inst?.instId, c.instId].filter(Boolean).map(String),
    mailIds: [c.mail_id].filter(Boolean).map(String),
    filing: c.filing || null,
    bytes: async () => (await import('../team/worktree.js')).cardBytes(m),
    context: () => cardContext(user, m),
    save: async (filing) => {
      const [row] = await q(`update pro_messages set content = content || jsonb_build_object('filing', $2::jsonb) where id=$1 returning *`, [m.id, JSON.stringify(filing)])
      if (row) emit(user.id, 'message', row)
      return row
    },
  }
}

// what the conversation said around the card: its title, the person's and the agent's last words before it, who sent the file
async function cardContext(user, m, R = DEFAULTS) {
  const c = m.content || {}
  const lines = []
  if (c.shared?.shareId || c.shared?.by) {
    const [s0] = c.shared?.shareId ? await q(`select s.note, s.owner_id from pro_shares s where s.id=$1 and s.recipient_id=$2`, [c.shared.shareId, user.id]).catch(() => []) : []
    const s = s0 && { ...s0, owner: (await person(s0.owner_id))?.name || null }
    lines.push(L(`팀원 ${s?.owner || c.shared.by || ''}님이 메신저로 보낸 파일${s?.note ? `: "${clean(s.note).slice(0, 300)}"` : ''}`, `A file teammate ${s?.owner || c.shared.by || ''} sent in a message${s?.note ? `: "${clean(s.note).slice(0, 300)}"` : ''}`))
  } else if (m.role === 'user') lines.push(L('사람이 대화에 붙인 파일', 'A file the person attached in the conversation'))
  else lines.push(L('에이전트가 대화에서 만든 파일', 'A file the agent made in the conversation'))
  if (m.thread_title && m.thread_kind !== 'chat') lines.push(L(`대화: ${clean(m.thread_title).slice(0, 80)}`, `Conversation: ${clean(m.thread_title).slice(0, 80)}`))
  const said = await q(`select role, kind, content from pro_messages where thread_id=$1 and created_at <= $2 and kind in ('text','doc') and id <> $3
                        order by created_at desc limit $4`, [m.thread_id, m.created_at, m.id, R.contextLines || 6])
  for (const x of said.reverse()) {
    const t = clean(x.content?.text).slice(0, 220)
    if (t) lines.push(`${x.role === 'user' ? L('사람', 'Person') : L('AI', 'AI')}: ${t}`)
  }
  return lines.join('\n')
}

async function mailDoc(user, actionId, name, deps) {
  if (!UUID.test(actionId)) throw fail(404, L('메일을 찾지 못했어요.', "I couldn't find the mail."))
  const [a] = await q('select * from pro_actions where id=$1 and user_id=$2', [actionId, user.id])
  if (!a?.source?.mail_id) throw fail(404, L('메일을 찾지 못했어요.', "I couldn't find the mail."))
  let mail = null
  const source = deps.mailSource || (async (u, act) => {
    const [acc] = await q('select provider, address from pro_mail_accounts where user_id=$1', [u.id])
    if (!acc) throw fail(409, L('연결된 메일함이 없어요.', 'No mailbox is connected.'))
    return (await import('../mailReply.js')).sourceOf(u.id, acc.provider, act.source.mail_id, { to: acc.address || '' })
  })
  const read = async () => (mail ||= await source(user, a))
  const att = async () => {
    const x = ((await read()).attachments || []).find((f) => String(f.name) === name)
    if (!x) throw fail(404, L('메일에서 이 첨부를 찾지 못했어요.', "I couldn't find this attachment in the mail."))
    return x
  }
  return {
    key: `mail:${a.id}:${name}`, kind: 'mail', actionId: a.id, name: safeName(name),
    instIds: [a.source.inst?.instId].filter(Boolean).map(String), mailIds: [String(a.source.mail_id)],
    filing: a.source.filing?.[name] || null,
    bytes: async () => { const x = await att(); return { buf: Buffer.isBuffer(x.content) ? x.content : Buffer.from(x.content || ''), type: x.type || '' } },
    context: async () => {
      const m = await read().catch(() => null)
      return [L(`메일의 첨부: 「${clean(m?.subject || a.source.subject)}」`, `An attachment of the mail "${clean(m?.subject || a.source.subject)}"`),
        L(`보낸 사람: ${clean(a.source.from || '')}`, `From: ${clean(a.source.from || '')}`),
        m?.text ? L(`본문: ${clean(m.text).slice(0, 500)}`, `Body: ${clean(m.text).slice(0, 500)}`) : ''].filter(Boolean).join('\n')
    },
    save: async (filing) => {
      const [row] = await q(`update pro_actions set source = jsonb_set(source, '{filing}', coalesce(source->'filing', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)) where id=$1 returning *`,
        [a.id, name, JSON.stringify(filing)])
      if (row) emit(user.id, 'action', row)
      return row
    },
  }
}

// ---------- the folders it may go to ----------
// the managed folders I edit (owner · editor), newest first; a work folder only for a document of its work
export async function candidates(user, doc = {}) {
  const rows = await q(`select f.*, m.role from pro_folders f join pro_folder_members m on m.folder_id=f.id and m.principal_type='user' and m.principal_id=$2
                        where f.tenant_id=$1 and f.kind='managed' and m.role in ('owner','editor') order by f.updated_at desc`, [T(), String(user.id)])
  return rows.filter((f) => ofWork(f.settings?.work, doc))
}

// each folder as the judge reads it: name · description · its sub-folders · its newest files with their card's summary
export async function describeFolders(folders, R = DEFAULTS) {
  const out = []
  // (a file under a folder's reference slot is not one of its files while the slot is there — folders/refs.js)
  const slots = await REFS.slotsOf(folders.map((f) => f.id)).catch(() => new Map())
  for (const f of folders) {
    const files = (await q(`select path, card from pro_folder_files where folder_id=$1 and path <> '.gitattributes' order by mtime desc nulls last, path limit 300`, [f.id]))
      .filter((x) => !REFS.underSlot(slots.get(String(f.id)), x.path))
    const dirs = new Map()
    for (const x of files) { const i = x.path.indexOf('/'); if (i > 0) { const d = x.path.slice(0, i); if (!dirs.has(d)) dirs.set(d, []); dirs.get(d).push(x) } }
    out.push({ id: f.id, slug: f.slug, name: f.name, description: clean(f.description).slice(0, 160), work: !!f.settings?.work, count: files.length,
      dirs: [...dirs].map(([d, xs]) => ({ name: d, count: xs.length, files: xs.slice(0, 3).map((x) => x.path.slice(d.length + 1)) })),
      files: files.slice(0, R.filesPerFolder || 6).map((x) => ({ path: x.path, summary: clean(x.card?.abstract).slice(0, 140) || null })) })
  }
  return out
}

const folderLines = (f) => [`「${f.name}」${f.work ? L(' (작업 폴더)', ' (work folder)') : ''}${f.description ? ` — ${f.description}` : ''}`,
  f.dirs.length ? `  ${L('하위 폴더', 'Sub-folders')}: ${f.dirs.map((d) => `${d.name}(${d.count})`).join(', ')}` : '',
  f.files.length ? `  ${L('최근 파일', 'Newest files')}: ${f.files.map((x) => `${x.path}${x.summary ? ` — ${x.summary}` : ''}`).join(' / ')}` : `  ${L('아직 파일 없음', 'No files yet')}`,
].filter(Boolean).join('\n')

// what the judge reads: the document (name, the start of its text, the conversation it came in) and the folders
export const docLines = (doc) => [L('들어온 문서:', 'The incoming document:'), `- ${L('이름', 'Name')}: ${doc.name}`,
  doc.text ? `- ${L('내용 앞부분', 'Start of its text')}: "${clean(doc.text)}"` : `- ${L('내용: 읽을 수 있는 글이 없음', 'Text: none readable')}`,
  doc.context ? `- ${L('오간 곳', 'Where it came in')}:\n${doc.context.split('\n').map((l) => `  ${l}`).join('\n')}` : ''].filter(Boolean).join('\n')
export const stateOf = (doc, folders) => [docLines(doc), '', L('공유 폴더:', 'Shared folders:'), ...(folders.length ? folders.map(folderLines) : [L('(없음)', '(none)')])].join('\n')

// ---------- the judge ----------
// one choice among options by the first token's probability; a model without log-probabilities answers in JSON
// → {choice, probabilities, confidence, strategy} or null when nothing could be read (lib/decide.js — mail cards use it too)
export { choose }

const pct = (p) => Math.round((p || 0) * 100)

// The folder for a document: → {folder: {slug, name} | null, sub, confidence, alternatives, newFolder: {name, why} | null, strategy}
// doc: {name, text, context, instIds, mailIds}; folders: candidates (rows); judges: {odds, json} (tests pass fakes)
export async function suggestFolder(doc, folders, { skill, judges = {} } = {}) {
  const sk = skill || await filingSkill()
  const R = sk.rules
  const P = sk.prompts
  const pick = folders.slice(0, R.maxFolders || 15)
  const described = await describeFolders(pick, R)
  const state = stateOf(doc, described)
  const out = { v: 1, at: new Date().toISOString(), skill: sk.version, folder: null, sub: '', confidence: null, alternatives: [], newFolder: null, strategy: null, candidates: pick.length }
  let r = null
  if (pick.length) {
    const options = [...described.map((f) => ({ key: f.slug, label: L(`「${f.name}」 폴더`, `the "${f.name}" folder`) })),
      { key: NEW, label: L('어느 폴더에도 맞지 않는다 — 새 폴더가 필요하다', 'None of them fits — a new folder is needed') }]
    r = await choose(state, P['choose-folder'], options, { ...judges, answerJson: P['answer-json'], timeoutMs: R.timeoutMs })
    if (!r) return { ...out, strategy: 'none' }
    out.strategy = r.strategy
    out.model = r.model || null
    out.alternatives = described.filter((f) => f.slug !== r.choice).map((f) => ({ slug: f.slug, name: f.name, p: r.probabilities[f.slug] ?? null }))
      .filter((x) => x.p != null && x.p >= 0.03).sort((a, b) => b.p - a.p).slice(0, 3)
  }
  const chosen = r && r.choice !== NEW ? described.find((f) => f.slug === r.choice) : null
  if (chosen) {
    out.folder = { slug: chosen.slug, name: chosen.name }
    out.confidence = r.confidence
    // a folder split into sub-folders: which one, the same way (only when it is clear)
    const dirs = chosen.dirs.slice(0, R.subfolders.max || 8)
    if (dirs.length >= 2) {
      const subState = [docLines(doc), '', L(`「${chosen.name}」의 하위 폴더:`, `Sub-folders of "${chosen.name}":`),
        ...dirs.map((d) => `「${d.name}」 — ${d.files.join(', ')}${d.count > d.files.length ? ` … (${d.count})` : ''}`)].join('\n')
      const subOptions = [...dirs.map((d) => ({ key: d.name, label: `「${d.name}」` })), { key: ROOT, label: L('폴더 맨 위', 'The top of the folder') }]
      const s = await choose(subState, String(P['choose-subfolder'] || '').replaceAll('{folder}', chosen.name), subOptions, { ...judges, answerJson: P['answer-json'], timeoutMs: R.timeoutMs })
      if (s && s.choice !== ROOT && s.confidence >= (R.subfolders.min ?? 0.5)) out.sub = s.choice
    }
    return out
  }
  // nothing fits (or there is nothing to choose from): a name for a new folder
  out.confidence = r ? r.confidence : null
  const taken = new Set(folders.map((f) => String(f.name).toLowerCase()))
  try {
    const j = await (judges.json || chatJson)(P['name-folder'], `${state}\n\n${L('이미 있는 폴더', 'Folders that exist')}: ${folders.map((f) => f.name).join(', ') || L('없음', 'none')}`, { timeoutMs: 30000, temperature: 0.2 })
    let name = safeName(j?.name, 40, '')
    if (name) {
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${safeName(j.name, 36, '')} ${i}`
      out.newFolder = { name, why: clean(j.why).slice(0, 160) || null }
    }
  } catch (e) { console.warn('[filing] name', e.message) }
  if (!out.strategy) out.strategy = out.newFolder ? 'name' : 'none'
  return out
}

// ---------- suggest (once per card) ----------
const pending = new Map()
const view = (doc, f) => ({ key: doc.key, name: doc.name, suggestion: f?.suggestion || null, filed: f?.filed || null })

// the verdict for a document: kept on its card, made once (a second screen asking at the same moment waits for the first)
// refresh: ask again (the suggested folder is gone, or the person asked)
export async function suggest(user, ref, { refresh = false, deps = {} } = {}) {
  const doc = await docOf(user, ref, deps)
  if (doc.filing?.filed && !refresh) return view(doc, doc.filing)
  const folders = await candidates(user, doc)
  const kept = doc.filing?.suggestion
  const usable = kept && (kept.folder ? folders.some((f) => f.slug === kept.folder.slug) : kept.newFolder)
  if (usable && !refresh) return view(doc, doc.filing)
  const key = `${T()}:${doc.key}`
  if (!pending.has(key)) {
    pending.set(key, (async () => {
      const skill = await filingSkill()
      // (a document whose file is gone is said so — nothing to file)
      const { buf } = await doc.bytes()
      const text = (await (await import('./indexer.js')).extract(doc.name, buf).catch(() => ({ text: '' }))).text || ''
      const context = await doc.context().catch(() => '')
      const suggestion = await suggestFolder({ ...doc, text: clean(text).slice(0, skill.rules.textChars || 1200), context }, folders, { skill, judges: deps.judges })
      const filing = { ...(doc.filing || {}), suggestion }
      await doc.save(filing)
      // the company turned on filing by itself above a threshold (rules.autoFile, off by default)
      const A = skill.rules.autoFile
      if (A?.enabled && suggestion.folder && suggestion.confidence >= (A.min ?? 0.9)) {
        const done = await file(user, ref, { slug: suggestion.folder.slug, sub: suggestion.sub, by: 'auto', deps }).catch((e) => { console.warn('[filing] auto', e.message); return null })
        if (done) return done
      }
      return view(doc, filing)
    })().finally(() => pending.delete(key)))
  }
  return pending.get(key)
}

// what the person may pick by hand (다른 폴더 고르기): the same candidates
export async function pickList(user, ref, deps = {}) {
  const doc = ref && (ref.messageId || ref.shareId || ref.actionId) ? await docOf(user, ref, deps) : {}
  return (await candidates(user, doc)).map((f) => ({ slug: f.slug, name: f.name, description: f.description || '', work: !!f.settings?.work }))
}

// ---------- filing ----------
// into an existing folder I edit (slug, an optional sub-folder) or a new one (newFolder: its name) → the card's view with filed
export async function file(user, ref, { slug, sub = '', newFolder = '', by = 'person', deps = {} } = {}) {
  const doc = await docOf(user, ref, deps)
  let folder
  let made = false
  if (newFolder) {
    const name = safeName(newFolder, 40, '')
    if (!name) throw fail(400, L('새 폴더 이름을 적어 주세요.', 'Please name the new folder.'))
    const [same] = await q('select * from pro_folders where tenant_id=$1 and name=$2', [T(), name])
    if (same) {
      folder = (await S.access(same.slug, user, 'editor').catch((e) => {
        throw e.status === 403 ? fail(409, L(`같은 이름의 폴더 ‘${name}’가 이미 있어요. 다른 이름을 적어 주세요.`, `A folder named ‘${name}’ already exists. Please choose another name.`)) : e
      })).folder
    }
    else {
      folder = await S.createFolder({ id: user.id, name: user.name, email: user.email }, { name, description: L(`「${doc.name}」를 정리하며 만든 폴더`, `Made while filing "${doc.name}"`) })
      made = true
    }
  } else {
    if (!slug) throw fail(400, L('정리할 폴더를 골라 주세요.', 'Please choose a folder.'))
    folder = (await S.access(String(slug), user, 'editor')).folder
  }
  if (folder.kind !== 'managed') throw fail(400, L('이 폴더에는 정리할 수 없어요(연결형 · 스킬 폴더).', "Documents can't be filed into this folder (linked or skill folder)."))
  if (!ofWork(folder.settings?.work, doc)) throw fail(400, L('일의 작업 폴더에는 그 일의 문서만 정리해요.', "A work folder takes only its own work's documents."))
  const dir = clean(sub) ? S.safeRel(clean(sub)) : ''
  const { buf } = await doc.bytes()
  if (!buf?.length) throw fail(400, L('빈 파일은 정리하지 않아요.', "An empty file isn't filed."))
  const blob = blobSha(buf)
  const author = { name: user.name, email: user.email }
  const out = await S.serial(folder.id, async () => {
    const list = await G.lsTree(folder.repo_path, folder.default_branch)
    const there = list.find((x) => x.sha === blob)
    if (there) return { path: there.path, already: true, commit: null }
    // (a new file takes a name beside the reference slots, never one of them)
    const rel = freePath(dir ? `${dir}/${doc.name}` : doc.name, new Set([...list.map((x) => x.path), ...(await REFS.slotPaths(folder))]))
    const p = S.safeRel(rel)
    // (a reference slot is read only here: nothing is put into one — folders/refs.js)
    await REFS.assertWritable(folder, p)
    await assertNoLink(folder.repo_path, p)
    const host = path.join(folder.repo_path, p)
    await fs.mkdir(path.dirname(host), { recursive: true })
    await fs.writeFile(host, buf)
    const commit = await S.commitMainNow(folder, author, `${L(`정리: ${p}`, `Filed: ${p}`)}${doc.source ? `\n\n${doc.source}` : ''}`)
    return { path: p, already: false, commit }
  })
  if (!out.already || made) (await import('./indexer.js')).reindex(await S.folderById(folder.id)).catch((e) => console.warn('[filing] index', e.message))
  const filed = { slug: folder.slug, name: folder.name, path: out.path, already: out.already, made, commit: out.commit, by, at: new Date().toISOString() }
  // (read again: a suggestion made meanwhile stays with it)
  const now = await docOf(user, ref, deps).catch(() => doc)
  const filing = { ...(now.filing || doc.filing || {}), filed }
  await doc.save(filing)
  emit(user.id, 'folders', { slug: folder.slug })
  return view(doc, filing)
}

// the words of a verdict, for logs and tests: ‘견적서’에 정리할까요? (확신 87%)
export const sayOf = (s) => (s?.folder ? L(`‘${s.folder.name}${s.sub ? `/${s.sub}` : ''}’에 정리할까요? (확신 ${pct(s.confidence)}%)`, `File it in ‘${s.folder.name}${s.sub ? `/${s.sub}` : ''}’? (${pct(s.confidence)}% sure)`)
  : s?.newFolder ? L(`새 폴더 만들기: ${s.newFolder.name}`, `New folder: ${s.newFolder.name}`) : '')
