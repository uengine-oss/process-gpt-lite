// 메일에 답장만 하지 않는다 (2026-11-24 사용자, 휴대폰의 답장 시트 「답장 · … 협업 제안 확인 회신」을 보며: 「메일에 대해서 무조건 답장만 하지는
// 않는다. 그 회사에 대해서 추가적으로 알아볼 수 도 있고.. 기타 액션을 할 수 있어야 하는데... 채팅에 멘션해서 뭔가 후속 작업을 할 수 있어야하는디」).
// 스펙 openspec/specs/mail-card-actions 「메일 시트의 할 일 줄」 · 「이 회사 알아보기」.
//   followOfCard — GET /actions/:id/follow: the sheet's row of follow-up actions beside the reply — the fixed ones (이 회사 알아보기 · 채팅에서
//                  이어서) and a few the judge picks for this mail from the skill's catalog (skills/mail-card-actions rules.json follow.actions,
//                  prompts/suggest-follow.md: first-token odds over the catalog — lib/decide.js chooseSome — the likeliest at follow.minP or
//                  above, at most follow.max; JSON when the model gives no odds). Picked once and kept on the card (source.follow.suggest);
//                  a model that cannot be read gives none, and is asked again next time. Each action says what it will do (`says`).
//   runFollow    — POST /actions/:id/follow/:key: an agent action, pressed (이 회사 알아보기, or a picked one whose `do` is agent — 회의 잡기,
//                  제안서 초안 …). A normal agent turn (lib/agent.js delegate) with the mail as context, where the mail's work is:
//                    · the mail belongs to a process instance (lib/mailFlow.js): that instance's conversation, and the answer goes into its
//                      work folder (lib/mailWork.js addNote) — nothing in the main chat (spec mail-thread-flow)
//                    · otherwise: a conversation of its own in the main chat, pinned and filed in context_threads — the chat's 대화 list shows
//                      it and the context router can route later messages into it
//                  The card keeps where the result is (source.follow.runs.<key>): 「회사 알아본 결과 · 열기」 on the sheet and the Home card.
// Nothing runs or is sent before its button; the agent is told not to send mail or make events (the person does that on the sheet).
// Everything stays on the card (pro_actions.source.follow): no table of its own.
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { L, isEn } from './lang.js'
import { chooseSome } from './decide.js'
import { cardSkill } from './mailCard.js'
import { STAGES } from './mailFlow.js'
import * as MM from './mailMention.js'

const T = () => config.tenantId
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const round = (p) => (p == null ? null : Math.round(Number(p) * 1000) / 1000)
export const FOLLOW_DEFAULTS = { max: 3, minP: 0.15, judgeChars: 800, mentionChars: 4000, knownMails: 8, knownFiles: 5, knownCases: 5, personalDomains: [], actions: [] }
// a run left 「running」 longer than this (a server that stopped half way) may be pressed again
const STALE_MS = 20 * 60_000

// ---------- the catalog (pure) ----------
export const followRules = (sk) => ({ ...FOLLOW_DEFAULTS, ...(sk?.rules?.follow || {}) })
// one action of the catalog in the screen's language
export const inLang = (x, en = isEn()) => ({ key: x.key, do: x.do, icon: x.icon || null, fixed: !!x.fixed, prompt: x.prompt || null,
  label: (en && x.labelEn) || x.label || x.key, go: (en && x.goEn) || x.go || '', done: (en && x.doneEn) || x.done || '', says: (en && x.saysEn) || x.says || '', hint: x.hint || '' })
export const fill = (s, v) => String(s || '').replace(/\{(\w+)\}/g, (all, k) => (v[k] != null ? String(v[k]) : all))

// the process the map read this mail as the start of (the sheet's 「진행할까요?」), when it may still start one
export function flowTop(card) {
  const f = card?.source?.flow
  if (card?.source?.inst?.instId || !f || f.declined) return null
  return (f.matches || []).find((m) => STAGES.includes(m.stage) && m.task) || null
}
// which of the catalog's picks fit this card now: 프로세스 시작 needs a process the map read it as (and no instance yet), 폴더에 정리 needs
// attachments; the agent actions, 동료에게 공유 always
export function applicable(x, { card, atts = [] } = {}) {
  if (x.do === 'flow') return !!flowTop(card)
  // 폴더에 정리 · 이 첨부로 묻기 (lib/mailAttachments.js — the chat with the mail and its attachments as chips): only with attachments
  if (x.do === 'file' || x.do === 'askatt') return atts.length > 0
  return ['agent', 'share', 'chat'].includes(x.do)
}

// what the judge reads: the card, and the mail — its sender, subject, attachments and the start of its body (as data)
export function followState(card, mail, F = FOLLOW_DEFAULTS) {
  const who = MM.senderOf(mail?.from || card.source?.from)
  const atts = (mail?.attachments || []).map((a) => a?.name || String(a)).filter(Boolean)
  const body = clean(mail?.text || '').slice(0, F.judgeChars || 800)
  return [L('메일 카드:', 'The mail card:'), `- ${L('단추', 'Button')}: ${clean(card.verb)}`, `- ${L('카드 글', 'Card text')}: ${clean(card.text)}`,
    card.prompt ? `- ${L('누르면 할 일', 'What pressing it does')}: ${clean(card.prompt).slice(0, 400)}` : '',
    L('받은 메일:', 'The mail:'), `- ${L('보낸 사람', 'From')}: ${who.address ? `${who.name} <${who.address}>` : who.name}`,
    `- ${L('제목', 'Subject')}: ${clean(mail?.subject || card.source?.subject)}`, atts.length ? `- ${L('첨부', 'Attachments')}: ${atts.join(', ')}` : '',
    body ? `- ${L('본문 앞부분', 'Start of the body')}: "${body}"` : ''].filter(Boolean).join('\n')
}

// where the result of an agent action stays, in words (the action's `says`)
export const whereOf = (card) => (card?.source?.inst?.instId
  ? L(`루틴 「${card.source.inst.name || '진행 중인 일'}」의 대화와 작업 폴더`, `the conversation and work folder of the routine "${card.source.inst.name || 'the running work'}"`)
  : L('채팅의 새 대화', 'a new conversation in the chat'))
export const companyOf = (who) => (who.name && who.domain && who.name !== who.address ? `${who.name} · ${who.domain}` : who.domain || who.name || L('보낸 사람', 'the sender'))

// The row the sheet shows: the fixed actions first (이 회사 알아보기 · 채팅에서 이어서), then the picked ones that fit, each with what it says
// it will do, and its last run (where the result is). → [{key, do, icon, label, go, says, fixed, p?, proc?, task?, run?}]
export function rowOf(card, { catalog, picks = [], atts = [] }) {
  const who = MM.senderOf(card.source?.from)
  const top = flowTop(card)
  const vars = { company: companyOf(who), where: whereOf(card), proc: top?.name || '', task: top?.task || '', count: atts.length, names: atts.slice(0, 3).join(', ') + (atts.length > 3 ? ' …' : '') }
  const runs = card.source?.follow?.runs || {}
  const view = (x, p) => ({ key: x.key, do: x.do, icon: x.icon, label: x.do === 'flow' && top ? L(`‘${top.name}’ 시작`, `Start '${top.name}'`) : x.label, go: x.go, says: fill(x.says, vars),
    fixed: x.fixed, ...(p != null ? { p: round(p) } : {}), ...(x.do === 'flow' && top ? { proc: top.proc, task: top.task } : {}), ...(runs[x.key] ? { run: runs[x.key] } : {}) })
  const fixed = catalog.filter((x) => x.fixed && applicable(x, { card, atts })).map((x) => view(x))
  const picked = picks.map((pk) => [catalog.find((x) => x.key === pk.key && !x.fixed), pk.p]).filter(([x]) => x && applicable(x, { card, atts })).map(([x, p]) => view(x, p))
  // (an agent action run before stays on the row, so its result can be opened, even when the judge did not pick it)
  const ran = Object.keys(runs).map((k) => catalog.find((x) => x.key === k && !x.fixed)).filter((x) => x && !picked.some((y) => y.key === x.key)).map((x) => view(x))
  return [...fixed, ...picked, ...ran]
}

// ---------- the card ----------
async function cardFor(userId, id) {
  const [a] = UUID.test(String(id)) ? await q('select * from pro_actions where id=$1', [String(id)]) : []
  if (!a) throw fail(404, L('카드를 찾지 못했어요.', "This card couldn't be found."))
  if (a.user_id !== userId) throw fail(403, L('다른 사람의 카드예요.', 'This card belongs to someone else.'), 'not_yours')
  if (!a.source?.mail_id) throw fail(400, L('메일에서 온 카드가 아니에요.', "This card didn't come from a mail."))
  return a
}
const catalogOf = (F) => (F.actions || []).filter((x) => x?.key && x?.do).map((x) => inLang(x))

// ---------- the judge ----------
// → {picks: [{key, p}], by, model, skill} or null (the model could not be read)
export async function decideFollow(card, mail, { skill, judges = {} } = {}) {
  const sk = skill || await cardSkill()
  const F = followRules(sk)
  const atts = (mail?.attachments || []).map((a) => a?.name || String(a)).filter(Boolean)
  const cands = catalogOf(F).filter((x) => !x.fixed && applicable(x, { card, atts }))
  if (!cands.length) return { picks: [], by: 'none', model: null, skill: sk.version }
  const options = [...cands.map((x) => ({ key: x.key, label: x.hint ? `${x.label} — ${x.hint}` : x.label })), { key: 'none', label: L('그 밖 — 위 어느 것도 아님', 'Something else — none of these') }]
  const r = await chooseSome(followState(card, mail, F), sk.prompts['suggest-follow'], options,
    { ...judges, answerJson: sk.prompts['answer-many-json'], timeoutMs: sk.rules.timeoutMs, max: F.max, min: F.minP })
  if (!r) return null
  return { picks: r.picks.filter((x) => x.key !== 'none').map((x) => ({ key: x.key, p: round(x.p) })), by: r.strategy, model: r.model || null, skill: sk.version }
}

const deciding = new Map()
// GET /actions/:id/follow → {actions, read}
export async function followOfCard(user, actionId, deps = {}) {
  let a = await cardFor(user.id, actionId)
  const sk = deps.skill || await cardSkill()
  const F = followRules(sk)
  const catalog = catalogOf(F)
  const kept = a.source.follow
  if (Array.isArray(kept?.suggest)) return { actions: rowOf(a, { catalog, picks: kept.suggest, atts: kept.atts || [] }), read: kept.read || null }
  const key = `${T()}:${a.id}`
  if (!deciding.has(key)) {
    deciding.set(key, (async () => {
      const mail = deps.mail || await MM.readMail(user.id, a)
      const atts = (mail.attachments || []).map((x) => x?.name || String(x)).filter(Boolean).slice(0, 20)
      const d = await decideFollow(a, mail, { skill: sk, judges: deps.judges }).catch((e) => { console.warn('[mail follow] judge', e.message); return null })
      // the model could not be read: the fixed actions only, asked again next time
      if (!d) return { picks: [], atts, read: { by: 'fallback' } }
      // the mailbox could not be read this time (no body, no attachments): what was picked is shown, not kept — asked again next time
      if (mail.failed) return { picks: d.picks, atts, read: { by: 'partial' } }
      const read = { by: d.by, model: d.model, skill: d.skill, at: new Date().toISOString() }
      const [row] = await q(`update pro_actions set source = jsonb_set(source, '{follow}', coalesce(source->'follow', '{}'::jsonb) || jsonb_build_object('suggest', $2::jsonb, 'read', $3::jsonb, 'atts', $4::jsonb))
                             where id=$1 and not (coalesce(source->'follow', '{}'::jsonb) ? 'suggest') returning *`, [a.id, JSON.stringify(d.picks), read, JSON.stringify(atts)])
      if (row) emit(user.id, 'action', row)
      return { picks: d.picks, atts, read, row }
    })().finally(() => deciding.delete(key)))
  }
  const got = await deciding.get(key)
  if (got.row) a = got.row
  else if (!['fallback', 'partial'].includes(got.read.by)) a = (await q('select * from pro_actions where id=$1', [a.id]))[0] || a
  return { actions: rowOf(a, { catalog, picks: a.source.follow?.suggest || got.picks, atts: a.source.follow?.atts || got.atts }), read: a.source.follow?.read || got.read }
}

// ---------- what Lite already knows (the research's input) ----------
const likeOf = (w) => `%${String(w).toLowerCase().replace(/[%_\\]/g, (c) => '\\' + c)}%`
const day = (d) => { const t = d ? new Date(d) : null; return t && !Number.isNaN(t.getTime()) ? t.toLocaleDateString('sv-SE', { timeZone: process.env.PRO_TZ || 'Asia/Seoul' }) : '' }
// Earlier mails with the sender's domain (this person's cards and mail archive), files of the shared folders they can read that name the
// company or the sender, and the company process map's cases that came from that domain — only what this person may see.
// A personal mailbox's domain (skill rules follow.personalDomains — gmail.com, naver.com …) says nothing about a company: only the sender's
// own address is looked up then, and the folders are searched by their name only (PR #49 review).
export async function knownAbout(user, card, who, F = FOLLOW_DEFAULTS) {
  const mails = [], files = [], cases = []
  const personal = !!who.domain && (F.personalDomains || []).includes(who.domain)
  if (who.domain) {
    const like = likeOf(personal ? who.address : `@${who.domain}`)
    const cards = await q(`select created_at as at, source->>'subject' as subject, source->>'from' as "from", status, source->'inst'->>'name' as inst, source->>'mail_id' as mail_id
                           from pro_actions where user_id=$1 and id <> $2 and source ? 'mail_id' and lower(source->>'from') like $3 escape '\\'
                           order by created_at desc limit $4`, [user.id, card.id, like, F.knownMails]).catch(() => [])
    const arch = await q(`select occurred_at as at, from_addr as "from", subject, ('SENT' = any(labels)) as sent, mail_id from pro_mail_archive
                          where tenant_id=$1 and owner_id=$2 and mail_id <> $5 and (lower(coalesce(from_addr, '')) like $3 escape '\\' or exists (select 1 from unnest(to_addrs) t where lower(t) like $3 escape '\\'))
                          order by occurred_at desc nulls last limit $4`, [T(), user.id, like, F.knownMails, String(card.source.mail_id || '')]).catch(() => [])
    const seen = new Set([String(card.source.mail_id || '')])
    for (const m of [...cards, ...arch].sort((x, y) => new Date(y.at || 0) - new Date(x.at || 0))) {
      if (m.mail_id && seen.has(m.mail_id)) continue
      if (m.mail_id) seen.add(m.mail_id)
      mails.push(`- ${[day(m.at), m.sent ? L('보낸 메일', 'sent') : L('받은 메일', 'received'), `「${clean(m.subject) || L('(제목 없음)', '(no subject)')}」`,
        m.inst ? L(`루틴 「${m.inst}」`, `routine "${m.inst}"`) : ''].filter(Boolean).join(' · ')}`)
      if (mails.length >= F.knownMails) break
    }
    const proc = await q(`select c.bundle as proc, c.status, coalesce(c.trigger->>'subject', c.request->>'subject', '') as subject, c.updated_at as at,
                                 (select proc_inst_name from bpm_proc_inst where proc_inst_id = c.instances[array_length(c.instances, 1)]) as inst
                          from pro_po_cases c where c.tenant_id=$1 and c.started_by=$2 and lower(coalesce(c.trigger->>'from', c.request->>'sender', '')) like $3 escape '\\'
                          order by c.updated_at desc limit $4`, [T(), user.id, like, F.knownCases]).catch(() => [])
    for (const c of proc) cases.push(`- ${[c.inst || c.proc, c.status, c.subject ? `「${clean(c.subject)}」` : '', day(c.at)].filter(Boolean).join(' · ')}`)
  }
  // (the words: the domain's first part and the sender's name — the folder index matches any of them)
  const query = [who.domain && !personal ? who.domain.split('.')[0] : '', who.name && who.name !== who.address ? who.name : ''].filter((w) => w && w.length >= 2).join(' ')
  if (query) {
    const { search } = await import('./folders/indexer.js')
    for (const h of (await search(user.id, query, 20).catch(() => [])).filter((x) => x.type === 'file').slice(0, F.knownFiles)) {
      files.push(`- ${h.folder.name} › ${h.file.path}${h.file.card?.abstract ? ` — ${clean(h.file.card.abstract).slice(0, 120)}` : ''}`)
    }
  }
  const top = flowTop(card)
  if (top) cases.unshift(L(`- 이 메일은 ‘${top.name}’의 시작으로 보여요(확신 ${Math.round((top.p || 0) * 100)}%)`, `- This mail reads as the start of '${top.name}' (${Math.round((top.p || 0) * 100)}% sure)`))
  if (card.source.inst?.instId) cases.unshift(L(`- 이 메일은 루틴 「${card.source.inst.name || card.source.inst.instId}」에 이어져 있어요`, `- This mail is part of the routine "${card.source.inst.name || card.source.inst.instId}"`))
  const none = L('(아직 없음)', '(nothing yet)')
  return [L('[Lite 가 아는 것 — 이 사람의 메일함 · 공유 폴더 · 회사 프로세스 지도에서, 이 사람이 볼 수 있는 것만]', '[What Lite already knows — from this person\'s mailbox, shared folders and the company process map, only what they may see]'),
    personal ? L(`보낸 사람(${who.address})과 주고받은 이전 메일 — 개인 메일 주소라 회사는 본문과 서명으로 알아봐야 해요:`, `Earlier mails with the sender (${who.address}) — a personal address: the company is in the body and signature:`)
      : L(`그 도메인(${who.domain || '없음'})과 주고받은 이전 메일:`, `Earlier mails with that domain (${who.domain || 'none'}):`), ...(mails.length ? mails : [none]),
    L('공유 폴더의 관련 파일:', 'Related files in shared folders:'), ...(files.length ? files : [none]),
    L('회사 프로세스 지도:', 'The company process map:'), ...(cases.length ? cases : [none])].join('\n')
}

// ---------- running an agent action ----------
// (only while the card still has this run — `at`: a run pressed again after STALE_MS is a new run, and the old one's late end must not
// overwrite it — PR #49 review)
export async function setRun(userId, id, key, run) {
  const [row] = await q(`update pro_actions set source = jsonb_set(jsonb_set(source, '{follow}', coalesce(source->'follow', '{}'::jsonb)), '{follow,runs}',
                           coalesce(source->'follow'->'runs', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb))
                         where id=$1 and coalesce(source->'follow'->'runs'->$2->>'at', '') = $4 returning *`, [id, key, run, String(run.at || '')])
  if (row) emit(userId, 'action', row)
  return row
}

// POST /actions/:id/follow/:key {again?} → {run, already?}. deps: delegate (tests), wait (tests: answer once the turn is over)
export async function runFollow(user, session, actionId, key, { again = false } = {}, deps = {}) {
  const a = await cardFor(user.id, actionId)
  const sk = deps.skill || await cardSkill()
  const F = followRules(sk)
  const def = catalogOf(F).find((x) => x.key === String(key) && x.do === 'agent')
  if (!def || !sk.prompts[def.prompt]) throw fail(400, L('이 메일로 할 수 있는 일이 아니에요.', "That isn't something to do with this mail."), 'not_follow')
  const prev = a.source.follow?.runs?.[def.key]
  const stale = prev?.status === 'running' && Date.now() - Date.parse(prev.at || 0) > STALE_MS
  if (prev?.status === 'running' && !stale) return { run: prev, already: true }
  if (prev?.status === 'done' && !again) return { run: prev, already: true }
  const inst = a.source.inst?.instId ? { instId: a.source.inst.instId, name: a.source.inst.name || '' } : null
  const mail = deps.mail || await MM.readMail(user.id, a)
  const who = MM.senderOf(mail.from || a.source.from)
  const subject = clean(mail.subject || a.source.subject) || L('(제목 없음)', '(no subject)')
  const personal = !!who.domain && (F.personalDomains || []).includes(who.domain)
  const about = (personal ? who.name : who.domain) || who.name || who.address
  const title = def.key === 'research' ? L(`${about} 알아보기`, `About ${about}`) : `${def.label} · ${subject.slice(0, 40)}`
  const { instanceThread } = await import('./engine.js')
  const { mainThread } = await import('./store.js')
  const threadId = inst ? await instanceThread(user.id, inst.instId, inst.name || undefined) : (await mainThread(user.id)).id
  // (a conversation of its own in the main chat; an instance's conversation is its own already)
  const conv = inst ? null : `mail-${def.key}-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  const run = { key: def.key, label: def.label, done: def.done, status: 'running', at: new Date().toISOString(), threadId, ...(conv ? { conv, title } : {}), ...(inst ? { inst } : {}) }
  // one run at a time per action, even when two presses arrive together
  const [claimed] = await q(`update pro_actions set source = jsonb_set(jsonb_set(source, '{follow}', coalesce(source->'follow', '{}'::jsonb)), '{follow,runs}',
                               coalesce(source->'follow'->'runs', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb))
                             where id=$1 and user_id=$4 and (coalesce(source->'follow'->'runs'->$2->>'status', '') <> 'running'
                               or (source->'follow'->'runs'->$2->>'at')::timestamptz < now() - interval '20 minutes') returning *`, [a.id, def.key, run, user.id])
  if (!claimed) {
    const [now] = await q('select source from pro_actions where id=$1', [a.id])
    return { run: now?.source?.follow?.runs?.[def.key] || run, already: true }
  }
  emit(user.id, 'action', claimed)
  const job = (async () => {
    const A = await import('./agent.js')
    const { addMessage } = await import('./store.js')
    const known = def.key === 'research' ? await knownAbout(user, a, who, F).catch((e) => { console.warn('[mail follow] known', e.message); return '' }) : ''
    const prompt = fill(sk.prompts[def.prompt], { company: companyOf(who), domain: who.domain || L('(없음)', '(none)'), subject })
    const context = MM.mailContextText(mail, { chars: F.mentionChars, link: MM.threadLinkOf(mail), inst })
    const said = `${def.label} — ${companyOf(who)}`
    // the person's request as it is shown (with the mail's chip), then the agent in that conversation
    await addMessage(user.id, threadId, 'user', 'text', { text: said, refs: [{ as: 'mail', name: subject, from: who.name, actionId: a.id }], follow: { actionId: a.id, key: def.key } })
    if (conv) await A.fileConversation(user, { conversationId: conv, title }, said)
    let msg = null, why = ''
    try {
      msg = await (deps.delegate || A.delegate)({ user, session, threadId, text: [prompt, context, known].filter(Boolean).join('\n\n'), background: true, ...(conv ? { pin: { conversationId: conv, title } } : {}) })
    } catch (e) { why = e.message; console.warn('[mail follow] turn', e.message) }
    const answer = String(msg?.content?.text || '')
    const ok = !!msg && !msg.content?.stopped && !msg.content?.failed && !!answer.trim() && ![A.EMPTY_TEXT, A.EMPTY_TEXT_EN].includes(answer)
    if (conv && ok) await A.fileConversation(user, { conversationId: conv, title }, said, answer)
    // an instance's mail: the result goes into the work's folder too, where the next steps read it
    let folder = null
    if (inst && ok) folder = await (await import('./mailWork.js')).addNote(user.id, inst, { title, text: answer, mail: { subject, from: who.name } }).catch((e) => { console.warn('[mail follow] work folder', e.message); return null })
    await setRun(user.id, a.id, def.key, { ...run, status: ok ? 'done' : 'failed', msgId: msg?.id || null, endedAt: new Date().toISOString(),
      ...(folder ? { folder } : {}), ...(ok ? {} : { error: (why || answer || L('답을 받지 못했어요.', 'No answer came back.')).slice(0, 200) }) })
  })().catch((e) => { console.warn('[mail follow]', e.message); return setRun(user.id, a.id, def.key, { ...run, status: 'failed', error: String(e.message).slice(0, 200), endedAt: new Date().toISOString() }).catch(() => {}) })
  if (deps.wait) await job
  return { run }
}
