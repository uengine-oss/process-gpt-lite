// Scenario 3 of the Agentic BPM PoC (pgpt-pro/docs/agentic-bpm/plan.md §6, 외부 메일·자료 공유): a mail the
// assistant sends for someone goes through the company's mail policies (lib/policy/catalog.js, mail-*) —
// everyone inside → it goes at once; someone outside → it goes, is recorded and can be recalled for 10 minutes;
// outside with personal data → the privacy officer approves first; 50+ personal data items → blocked; a
// confidential file outside → the security officer approves; past 20 outside mails a day → the team lead.
//
// Nothing is really e-mailed: a "sent" mail lands in a demo outbox (pro_outbox, sql/025_scenario_mail.sql), and
// the chat says so next to the policy card.
//
// The facts the policies read: a recipient whose domain is not the company's (PRO_COMPANY_DOMAINS, default
// uengine.org) is external; the subject, body and attachment text are searched by pattern for personal data
// (resident registration numbers, mobile numbers, e-mail addresses, bank-account-like numbers). Whether a mail going
// outside is confidential is a matter of meaning, so the model reads it (spec pgpt-pro_guardrail-reading); the marking
// words 기밀/대외비/confidential decide only when the model cannot answer. Personal data and confidentiality are
// different questions with different approvers, so a personal-data hit does not skip the reading. Facts carry counts,
// kinds and the reading's probability only — never the body, nor the personal data found — since the ledger keeps them.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { q } from '../supa.js'
import { config } from '../../config.js'
import { registerExecutor, guard } from '../policy/pep.js'
import { addMessage, mainThread } from '../store.js'
import { resolveMember } from '../team.js'
import { L } from '../lang.js'
import { oddsOf } from '../decide.js'
import { ADDR, findPii, maskPii } from '../policy/pii.js'

export { findPii, maskPii }

const T = () => config.tenantId
export const UNDO_MINUTES = 10
const bad = (m, status = 400) => Object.assign(new Error(m), { status })

// ── recipients
export const companyDomains = () => String(process.env.PRO_COMPANY_DOMAINS || 'uengine.org').split(',')
  .map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
const domainOf = (a) => String(a).split('@').pop().toLowerCase()
// a sub-domain of the company's (mail.uengine.org) is the company too
export const isInternal = (addr, domains = companyDomains()) => { const d = domainOf(addr); return domains.some((c) => d === c || d.endsWith(`.${c}`)) }

// "kim@globex.com, 김민지" / ["이도윤 <doyun@…>"] → addresses; a teammate's name or role resolves to their address
async function recipientsOf(to) {
  const said = [].concat(to || []).flatMap((x) => String(x).split(/[,;\n]/)).map((s) => s.trim()).filter(Boolean)
  const out = []
  for (const s of said) {
    const addr = s.match(ADDR)?.[0] || (await resolveMember(s).catch(() => null))?.email
    if (!addr) throw bad(L(`받는 사람 「${s}」의 메일 주소를 모르겠어요. 주소로 알려 주세요.`, `I don't know the address of "${s}". Please give me the e-mail address.`))
    if (!out.includes(addr.toLowerCase())) out.push(addr.toLowerCase())
  }
  return out
}

const CONFIDENTIAL = /기밀|대외비|confidential/i
export const CONFIDENTIAL_READING = { bar: 0.5, bodyChars: 800, fileChars: 800, marks: 3 }
export const CONFIDENTIAL_QUESTION = '이 메일을 회사 밖으로 보내기 전에 보안 담당자의 검토가 필요한가?'
export const CONFIDENTIAL_OPTIONS = [
  { key: 'confidential', label: '회사 밖으로 나가면 안 되는 기밀 자료다(미공개 실적·경영 계획·인수합병·원가와 마진·소스 코드·설계 문서·공개 전 로드맵 등)' },
  { key: 'general', label: '밖으로 보내도 되는 일반 자료다(공개 자료·안내문·일정 조율·그 고객을 위한 견적과 청구·서명할 빈 계약서 양식 등)' },
]
// what the model reads of a mail: the start of the body and of each file, plus any line further down carrying a marking
// word, so a long file's marking is still seen. Personal data is masked first.
export function mailExcerpt({ subject, body, attachments = [] }) {
  const { bodyChars, fileChars, marks } = CONFIDENTIAL_READING
  const parts = [`제목: ${subject || ''}`, `본문: ${String(body || '').slice(0, bodyChars)}`]
  for (const a of attachments) {
    const t = String(a.text || '')
    const later = t.slice(fileChars).split('\n').filter((l) => CONFIDENTIAL.test(l)).slice(0, marks).map((l) => l.slice(0, 160))
    parts.push(`첨부 ${a.name}: ${a.text == null ? '(내용을 읽을 수 없는 파일)' : t.slice(0, fileChars)}${later.length ? `\n…\n${later.join('\n')}` : ''}`)
  }
  return maskPii(parts.join('\n'))
}
// {confidential, source: logprob|regex, p, model}
export async function readConfidential(mail, { ask = oddsOf } = {}) {
  const d = await ask(mailExcerpt(mail), CONFIDENTIAL_QUESTION, CONFIDENTIAL_OPTIONS)
  if (!d) return { confidential: (mail.attachments || []).some((x) => CONFIDENTIAL.test(x.name) || CONFIDENTIAL.test(x.text || '')), source: 'regex', p: null, model: null }
  const p = Number(d.probabilities.confidential.toFixed(4))
  return { confidential: p >= CONFIDENTIAL_READING.bar, source: 'logprob', p, model: d.model }
}

// ── attachments: a file of the demo folder, a file attached in this chat, or text
const DEMO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/agentic-mail')
const TEXTLIKE = /\.(csv|tsv|txt|md|json|html?|xml|eml)$/i
const MAX_TEXT = 200000
export function demoFiles() {
  try {
    return fs.readdirSync(DEMO_DIR).filter((n) => !n.startsWith('.')).map((n) => n.normalize('NFC'))
  } catch { return [] }
}
const norm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '').replace(/[\s_\-·.()[\]]/g, '')
// the file a spoken name means: the same name, else the one whose name holds what was said (or the other way)
function pick(names, said) {
  const k = norm(said)
  if (k.length < 2) return null
  return names.find((n) => norm(n) === k) || names.filter((n) => norm(n).includes(k) || k.includes(norm(n))).sort((a, b) => a.length - b.length)[0] || null
}

// a file the request itself names ("고객명단 전체 파일 보내줘") while the model left the attachment out: a mail
// the person meant to carry a file must not leave without it, nor be judged without it. Only when the request
// speaks of attaching a file at all (a mail that merely mentions the list must not pick it up), and the words
// of the file's name (numbers aside: "60명", "2027") are there — half of them, at least three letters' worth.
const ATTACH_WORDS = /첨부|파일|attach|\bfiles?\b/i
export function mentionedFile(request, names) {
  if (!ATTACH_WORDS.test(request || '')) return null
  const said = norm(request)
  const hits = names.map((n) => {
    const words = n.normalize('NFC').replace(/\.[a-z0-9]{1,5}$/i, '').split(/[\s_\-·()[\]]+/).filter((w) => w.length >= 2 && !/\d/.test(w)).map(norm)
    const found = words.filter((w) => said.includes(w))
    return { n, ok: words.length > 0 && found.length >= Math.ceil(words.length / 2) && found.join('').length >= 3, score: found.join('').length }
  }).filter((h) => h.ok).sort((a, b) => b.score - a.score)
  return hits[0]?.n || null
}

async function attachmentOf(a, files = []) {
  if (a && typeof a === 'object' && a.text != null) return { name: String(a.name || L('첨부.txt', 'attachment.txt')).slice(0, 160), size: Buffer.byteLength(String(a.text)), source: 'inline', text: String(a.text).slice(0, MAX_TEXT) }
  const said = String(a?.name || a || '').trim()
  if (!said) return null
  const chat = pick(files.map((f) => f.name), said)
  if (chat) {
    const f = files.find((x) => x.name === chat)
    // (lib/missions.js on demand: the facts alone need none of what it loads)
    const host = TEXTLIKE.test(f.name) ? await import('../missions.js').then((m) => m.workspaceHostPath(f.path)).catch(() => null) : null
    const text = host ? await fsp.readFile(host, 'utf8').catch(() => null) : null
    return { name: f.name, size: f.size || (text ? Buffer.byteLength(text) : 0), source: 'chat', text: text == null ? null : text.slice(0, MAX_TEXT) }
  }
  const demo = pick(demoFiles(), said)
  if (demo) {
    const text = TEXTLIKE.test(demo) ? fs.readFileSync(path.join(DEMO_DIR, demo), 'utf8') : null
    return { name: demo, size: fs.statSync(path.join(DEMO_DIR, demo)).size, source: 'demo', text: text == null ? null : text.slice(0, MAX_TEXT) }
  }
  // not a file anyone has: the words themselves are what is attached
  return { name: L('첨부.txt', 'attachment.txt'), size: Buffer.byteLength(said), source: 'inline', text: said.slice(0, MAX_TEXT) }
}

// the facts lib/policy/catalog.js documents for mail.send (counts and kinds only)
export function factsOf({ from = null, to, subject, body, attachments, reading = null }) {
  const domains = companyDomains()
  const outside = to.filter((a) => !isInternal(a, domains))
  const text = [subject, body, ...attachments.map((x) => x.text || '')].join('\n')
  const pii = findPii(text, { except: [...to, from].filter(Boolean) })
  // (a mail staying inside is not read: no policy looks at its classification)
  const confidential = reading ? reading.confidential : attachments.some((x) => CONFIDENTIAL.test(x.name) || CONFIDENTIAL.test(x.text || ''))
  return {
    recipients: [...new Set(to.map(domainOf))],           // domains, not addresses
    recipient_count: to.length,
    external: outside.length > 0,
    external_count: outside.length,
    pii_count: pii.count,
    pii_kinds: pii.kinds,
    pii_by_kind: pii.byKind,
    classification: confidential ? 'confidential' : 'general',
    classification_source: reading?.source || 'regex',
    classification_p: reading?.p ?? null,
    attachments: attachments.map((x) => ({ name: x.name, size: x.size, source: x.source, ...(x.text == null ? { scanned: false } : {}), ...(/\.(csv|tsv)$/i.test(x.name) && x.text ? { rows: x.text.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length - 1 } : {}) })),
  }
}

// a request → the mail and its facts, ready for the policies
export async function prepare(me, input, { files = [] } = {}) {
  const to = await recipientsOf(input.to)
  if (!to.length) throw bad(L('받는 사람이 없어요.', 'There is no recipient.'))
  const subject = String(input.subject || '').trim().slice(0, 300) || L('(제목 없음)', '(no subject)')
  const body = String(input.body || '').slice(0, 50000)
  const attachments = []
  const asked = [].concat(input.attachments || [], input.attachment ? [input.attachment] : [])
  // (request: the person's own words, from the chat)
  const named = !asked.length && input.request ? mentionedFile(input.request, [...files.map((f) => f.name), ...demoFiles()]) : null
  for (const a of named ? [named] : asked) {
    const x = await attachmentOf(a, files)
    if (x) attachments.push(x)
  }
  const reading = to.some((a) => !isInternal(a)) ? await readConfidential({ subject, body, attachments }) : null
  const facts = factsOf({ from: me?.email, to, subject, body, attachments, reading })
  // (the recipient is named — the ledger says where it went; what the mail itself says is masked)
  const who = to.length > 1 ? L(`${to[0]} 외 ${to.length - 1}명`, `${to[0]} and ${to.length - 1} more`) : to[0]
  const names = maskPii(attachments.map((x) => x.name).join(', '))
  const att = attachments.length ? L(` · 첨부 ${names}`, ` · attached ${names}`) : ''
  const line = L(`${who}에게 메일 「${maskPii(subject)}」${att}`, `Mail to ${who} "${maskPii(subject)}"${att}`).slice(0, 400)
  return { to, subject, body, attachments, facts, line }
}

// what the chat says under the card: this outbox is a demonstration
const honest = (status) => (status === 'executed' ? L('시연용 보낸편지함에 넣었어요 · 실제 메일은 나가지 않아요', 'Put in the demo outbox · no real e-mail goes out')
  : status === 'pending' ? L('승인되면 시연용 보낸편지함에 들어가요 · 실제 메일은 나가지 않아요', 'Goes to the demo outbox once approved · no real e-mail goes out') : null)

// one mail through the policies (the chat's send_mail tool and POST /api/scenarios/mail/send). card: false keeps
// the chat out of it (the caller shows the outcome); files: the chat's attachments of this turn
export async function sendMail(me, input, { threadId = null, card = true, files = [] } = {}) {
  const m = await prepare(me, input, { files })
  const thread = card ? threadId || (await mainThread(me.id)).id : null
  const out = await guard({
    me, kind: 'mail.send', subject: m.line, facts: m.facts, executor: 'mail.send',
    payload: { from: me?.email || null, to: m.to, subject: m.subject, body: m.body, attachments: m.attachments },
    card: card ? { userId: me.id, threadId: thread } : null,
  })
  const say = card && honest(out.status)
  if (say) await addMessage(me.id, thread, 'agent', 'chip', { icon: 'check', text: say, demo: true })
  return { ...out, facts: m.facts, threadId: thread }
}

// the demo outbox: "sending" writes a row; recalling (undo, while the 10-minute window is open) marks it
registerExecutor('mail.send', {
  undoMinutes: UNDO_MINUTES,
  async run(p, ctx) {
    const [row] = await q(`insert into pro_outbox(tenant_id, user_id, recipients, subject, body, attachments, decision_id)
      values ($1,$2,$3,$4,$5,$6,$7) returning id, created_at`,
    [ctx.tenant || T(), ctx.userId || null, JSON.stringify(p.to || []), p.subject, p.body, JSON.stringify(p.attachments || []), ctx.decisionId])
    return { outboxId: row.id, demo: true, recipients: (p.to || []).length, sentAt: row.created_at }
  },
  async undo(p, result, ctx) {
    const rows = await q(`update pro_outbox set status='recalled', recalled_at=now() where status='sent' and (id=$1 or decision_id=$2) returning id`,
      [result?.outboxId || null, ctx.decisionId])
    if (!rows.length) throw bad(L('회수할 메일이 없어요 (이미 회수했어요).', 'Nothing to recall (already recalled).'), 409)
  },
})

// my demo outbox (newest first); an attachment's text stays out of the list
export async function outboxOf(me, { limit = 50 } = {}) {
  return q(`select id, recipients, subject, left(body, 300) as body, (select coalesce(jsonb_agg(a - 'text'), '[]'::jsonb) from jsonb_array_elements(attachments) a) as attachments,
      status, decision_id, created_at, recalled_at from pro_outbox where tenant_id=$1 and user_id=$2 order by created_at desc limit $3`,
  [T(), me.id, Math.min(Number(limit) || 50, 200)])
}
