// How Lite itself runs a business pack's skill (pack.json "runner"), the same way for a mail's drafts
// (lib/mail.js) and for a step of a process registered from mining (worker.js):
//   floor-plan     the drawing in CADCraft through its MCP (lib/floorPlan.js), laid out by the skill's rules
//   hwpx-template  the company's Hangul template filled by office-mcp generate_hwpx with the skill's wording
//   agent          the agent (deepagents) with the skill pinned (`/<skill>` first in the message)
// What a step needs to know comes as facts — the request mail, what earlier steps left (by their form
// field names), the file to make, the result line the system reads. What to do with them is the skill's
// (SKILL.md, references/). No trade wording lives here.
import { q, sessionFor } from '../supa.js'
import { addMessage } from '../store.js'
import { L, isEn } from '../lang.js'
import { referenceText, section, fill, outputOf, runnerOf } from '../skillInstallCatalog.js'
import { numberOf } from '../improve/analyze.js'

export const extOf = (n) => String(n || '').toLowerCase().split('.').pop()
const oneLine = (v) => String(v ?? '').split('\n').map((x) => x.trim()).filter(Boolean).join(' / ')

// the newest file card of that format since then (a mail's draft: only cards marked with that mail)
export async function newFile(threadId, since, ext, mailId = null) {
  const [m] = await q(`select content from pro_messages where thread_id=$1 and kind='file' and created_at >= $2 and lower(content->>'name') like $3
                       and ($4::text is null or content->>'mail_id' = $4) order by created_at desc limit 1`,
    [threadId, since, `%.${ext}`, mailId ? String(mailId) : null])
  return m ? { name: m.content.name, url: m.content.url } : null
}

// "TOTAL: 51,216,000" on its own line (the result line the runner asks for; a model that wrote the key in
// Korean is read too) → the number, and the answer without that line
export function quoteTotal(answer) {
  const lines = String(answer || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*[*_`]*\s*(?:TOTAL|Total|합계)\s*[:：]\s*[*_`]*\s*(?:₩|KRW\s*)?([^*_`]+?)\s*(?:원|KRW|won)?\s*[*_`]*\s*$/.exec(lines[i])
    if (!m) continue
    const total = numberOf(m[1].replace(/\s+/g, ''))
    if (total != null) return { total, rest: [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n') }
  }
  return { total: null, rest: String(answer || '') }
}

// a step's form keys: where its file and its text go (the pack step's fields)
const keysOf = (step) => ({
  file: step?.fields?.find((f) => f.type === 'file')?.key || 'document',
  text: step?.fields?.find((f) => f.type === 'textarea')?.key || null,
})
// what earlier steps left, as lines a person (and the agent) reads: "<field text>: <value>"
function earlierLines(prev, labels) {
  const out = []
  for (const [k, v] of Object.entries(prev || {})) {
    if (['customer', 'sender', 'subject', 'body', 'requested'].includes(k) || v == null || v === '') continue
    const name = labels[k] || k
    if (v && typeof v === 'object' && v.name) out.push(`${name}: ${v.name}`)
    else if (typeof v === 'string' || typeof v === 'number') out.push(`${name}: ${oneLine(v)}`)
  }
  return out
}
const madeFiles = (prev) => Object.values(prev || {}).filter((v) => v && typeof v === 'object' && v.name && v.url).map((v) => v.name)

// ---------- floor-plan ----------
async function floorPlan({ skill, step, owner, threadId, prev, name, status, fileTag }) {
  const { layoutFromBrief, drawFloorPlan } = await import('../floorPlan.js')
  const { publish } = await import('../office.js')
  status(L('도면 배치 정하는 중', 'Laying out the drawing'))
  const layout = await layoutFromBrief({ subject: prev.subject, text: prev.body }, skill)
  let drawn
  try {
    drawn = await drawFloorPlan(owner, layout, name, (s) => status(L(`캐드크래프트로 도면 그리는 중 · ${s}`, `Drawing in CADCraft · ${s}`)))
  } finally { status(null) }
  const doc = await publish(owner, drawn.path)
  await addMessage(owner, threadId, 'agent', 'file', { ...doc, path: drawn.path, ...(fileTag || {}) })
  const k = keysOf(step)
  const rooms = drawn.rooms.map((r) => `${r.name} | ${r.area}㎡ | ${r.use}`).join('\n')
  return {
    values: { [k.file]: { name: doc.name, url: doc.url }, ...(k.text ? { [k.text]: rooms } : {}) },
    files: [{ name: doc.name, url: doc.url }],
    say: L(`캐드크래프트로 도면(${drawn.width}m × ${drawn.depth}m)을 그렸어요. 실별 면적은 ${drawn.rooms.map((r) => `${r.name} ${r.area}㎡`).join(', ')}이에요.`,
      `I drew it in CADCraft (${drawn.width} m × ${drawn.depth} m). Room areas: ${drawn.rooms.map((r) => `${r.name} ${r.area} ㎡`).join(', ')}.`),
  }
}

// ---------- hwpx-template ----------
async function hwpxTemplate({ skill, step, owner, threadId, prev, name, kind, status, fileTag }) {
  const mail = await import('../mail.js')
  const l = isEn() ? 'en' : 'ko'
  const ref = referenceText(skill, 'references/hwpx-template.md')
  // the drawing an earlier step made goes into the template's picture (pack.json "picture": that field)
  const pic = skill.lite?.picture && prev[skill.lite.picture]?.url ? prev[skill.lite.picture] : null
  let templateUrl
  if (pic) {
    status(L('양식에 그림 넣는 중', 'Putting the picture into the template'))
    templateUrl = await mail.designTemplate(owner, pic.url).catch((e) => { console.warn('[runner] template picture', e.message); return undefined })
  }
  status(L('한글 문서 채우는 중', 'Filling in the Hangul document'))
  const values = Object.fromEntries(Object.entries(prev || {}).map(([k, v]) => [k, v && typeof v === 'object' ? v.name || '' : oneLine(v)]))
  Object.assign(values, { customer: prev.customer || L('고객', 'the customer'), kind, request: String(prev.body || '').slice(0, 1500) })
  const description = [fill(section(ref, `${l} base`), values), pic ? fill(section(ref, `${l} picture`), values) : ''].filter(Boolean).join(' ')
  const since = new Date()
  try {
    await mail.hwpxDraft(owner, threadId, { from: prev.sender, subject: prev.subject, text: prev.body, id: fileTag?.mail_id }, { name, description, templateUrl })
  } finally { status(null) }
  const f = await newFile(threadId, since, 'hwpx', fileTag?.mail_id)
  if (!f) throw new Error(L(`${name} 파일을 찾지 못했어요`, `I couldn't find ${name}`))
  return { values: { [keysOf(step).file]: f }, files: [f], say: L(`양식을 채운 한글 문서(${f.name})를 만들었어요.`, `I filled in the Hangul document (${f.name}).`) }
}

// ---------- agent ----------
// One agent turn for one or more documents (a mail's drafts that need the agent go together, the way a
// person asks for them at once). One document: its skill pinned. Several: each names its skill.
// The agent's request (pure): the facts and the documents to make. What to do with them — which rows a
// document has when an earlier step left room areas and which when it did not — is the pinned skill's,
// never this text's. pictures: {itemName: sandbox path of the earlier drawing as a picture}
export function agentRequest({ items, prev = {}, labels = {}, intro = '', pictures = {} }) {
  const lines = items.map((it, k) => {
    const picField = it.skill?.lite?.picture
    const picture = pictures[it.name]
    return [`${items.length > 1 ? `${k + 1}) ` : ''}${it.kind} — /workspace/${it.name}`,
      it.skill && items.length > 1 ? L(`스킬 ${it.skill.name}`, `skill ${it.skill.name}`) : '',
      picture ? L(`${labels[picField] || picField} 그림: ${picture}`, `${labels[picField] || picField} picture: ${picture}`) : ''].filter(Boolean).join(' · ')
  })
  const totals = items.filter((it) => it.step?.total_field)
  const made = madeFiles(prev)
  const facts = [
    L(`고객: ${prev.customer || ''}`, `Customer: ${prev.customer || ''}`),
    L(`메일 — 보낸 사람: ${prev.sender || ''} · 제목: ${prev.subject || ''}`, `Mail — from: ${prev.sender || ''} · subject: ${prev.subject || ''}`),
    L(`메일 본문: ${String(prev.body || '').slice(0, 2500)}`, `Mail body: ${String(prev.body || '').slice(0, 2500)}`),
    ...earlierLines(prev, labels),
  ]
  const total = totals[0]?.step?.total_field
  return [
    items.length === 1 && items[0].skill ? `/${items[0].skill.name}` : '',
    intro,
    facts.join('\n'),
    L(`만들 문서:\n${lines.join('\n')}`, `Documents to make:\n${lines.join('\n')}`),
    made.length ? L(`(${made.join(', ')} 는 이미 만들었으니 다시 만들지 마세요.)`, `(${made.join(', ')} ${made.length > 1 ? 'are' : 'is'} already made — do not make ${made.length > 1 ? 'them' : 'it'} again.)`) : '',
    L('다 만들면 파일 이름과 검토할 점(가정한 값 등)을 두세 줄로 적으세요.', 'When they are done, give the file names and what to check (the values you assumed) in two or three lines.'),
    total ? L(`그리고 맨 마지막 줄에 ${labels[total] || total} 을 숫자만 "TOTAL: 51216000" 처럼 한 줄로 쓰세요.`,
      `On the very last line write the ${labels[total] || total} as a plain number, like "TOTAL: 51216000".`) : '',
  ].filter(Boolean).join('\n\n')
}

async function agentTurn({ items, owner, threadId, prev, labels = {}, intro, fileTag, status }) {
  const { delegate } = await import('../agent.js')
  const [p] = await q('select email, name from pro_profile where user_id=$1', [owner])
  const { user, session } = await sessionFor(p.email, p.name)
  const { planPicture } = await import('../mail.js')
  // a skill that takes an earlier drawing as a picture (pack.json "picture"): rendered where the sandbox sees it
  const pictures = {}
  for (const it of items) {
    const f = it.skill?.lite?.picture ? prev[it.skill.lite.picture] : null
    if (f?.url && extOf(it.name) !== 'hwpx') pictures[it.name] = await planPicture(f.url).catch((e) => { console.warn('[runner] picture', e.message); return null })
  }
  const text = agentRequest({ items, prev, labels, intro, pictures })
  const since = new Date()
  status(L('에이전트가 문서 만드는 중', 'The agent is making the documents'))
  let msg
  try { msg = await delegate({ user, session, threadId, silent: true, ...(fileTag ? { fileTag } : {}), text }) } finally { status(null) }
  // the agent's answer streams its progress first; its last paragraphs are the summary (files, assumptions),
  // its last line the total. A sandbox path keeps only the file name.
  const plain = String(msg?.content?.text || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(?:sandbox:)?\/workspace\/(?:[^\n/]*\/)*/g, '')
  const { total, rest } = quoteTotal(plain)
  const summary = rest.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).slice(-3).join('\n\n').slice(0, 1500)
  const out = { values: {}, files: [] }
  for (const it of items) {
    const f = await newFile(threadId, since, extOf(it.name), fileTag?.mail_id)
    const k = keysOf(it.step)
    if (f) { out.values[k.file] = f; out.files.push(f) }
    if (it.step?.total_field && total != null) out.values[it.step.total_field] = String(total)
    if (k.text) out.values[k.text] = summary
  }
  return out
}

// One pack skill (or a plain document when skill is null) for a format: its runner's result
// {values (by the step's form fields), files, say}. items share one agent turn (runAgentItems).
export function runnerFor(skill, format) {
  if (!skill) return 'agent'
  return runnerOf(skill, format) || null
}
export async function runSkill({ skill, step, format, owner, threadId, prev, name, kind, labels = {}, intro = '', fileTag, status = () => {} }) {
  const fmt = format || outputOf(skill, isEn() ? 'en' : 'ko') || extOf(name)
  const runner = runnerFor(skill, fmt)
  if (runner === 'floor-plan') return floorPlan({ skill, step, owner, threadId, prev, name, status, fileTag })
  if (runner === 'hwpx-template') return hwpxTemplate({ skill, step, owner, threadId, prev, name, kind, status, fileTag })
  if (runner === 'agent') return agentTurn({ items: [{ skill, step, name, kind }], owner, threadId, prev, labels, intro, fileTag, status })
  throw new Error(L(`이 스킬을 돌리는 방법이 없어요: ${skill?.name || '(없음)'} · ${fmt}`, `No way to run this skill: ${skill?.name || '(none)'} · ${fmt}`))
}
export const runAgentItems = (opts) => agentTurn(opts)
// the field texts of steps (for the facts' names): {key: text}
export const fieldLabels = (steps) => Object.fromEntries(steps.flatMap((s) => (s?.fields || []).map((f) => [f.key, f.text])))
