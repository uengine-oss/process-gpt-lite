// The review board's own logic, without a database or a server (test/apps.test.js):
// which role a question or a finding belongs to, the items of the stage, an item's state from
// people's stances, the one decision a set of findings becomes, and where the evidence is.
import crypto from 'node:crypto'

// AI-DLC writes the role into the question: "## Q1. [제품 관리자] …" (tags seen in our runs)
const TAGS = [
  [/제품|기획|product|\bpo\b|pm\b/i, 'product'],
  [/아키텍|architect/i, 'architect'],
  [/디자인|디자이너|화면|ux|ui\b|design/i, 'design'],
  [/품질|qa\b|테스트|quality|test/i, 'quality'],
  [/딜리버리|delivery|일정/i, 'delivery'],
  [/보안|security|devsecops/i, 'devsecops'],
  [/컴플라이언스|compliance/i, 'compliance'],
  [/릴리스|배포|release|deploy|pipeline/i, 'pipeline-deploy'],
  [/플랫폼|인프라|platform|infra/i, 'aws-platform'],
  [/운영|operations|ops\b/i, 'operations'],
  [/팀\s*리드|team lead/i, 'team-lead'],
  [/개발|developer|engineer|dev\b/i, 'developer'],
]
export function roleOfTag(tag) {
  for (const [re, key] of TAGS) if (re.test(String(tag || ''))) return key
  return null
}

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8)
export const questionKey = (path, q) => `q:${path}#${q.id}@${hash(q.text)}`
export const findingKey = (path, f) => `r:${path}#${f.id}`

const QUESTION_DECISION = new Set(['agree', 'choose'])
const FINDING_DECISION = new Set(['accept', 'fix', 'reject'])
const DOUBT = new Set(['object', 'ask'])

// An item's state from the stances on it: sent (in the file / the session) > discuss (a doubt newer
// than the reviewer's decision) > decided > open. A reviewer deciding again after a doubt settles it.
export function itemState(item, marks, reviewerIds) {
  if (item.sent) return { state: 'sent', decision: null, doubts: [] }
  const mine = marks.filter((m) => m.item_key === item.key)
  const isDecision = item.kind === 'question' ? QUESTION_DECISION : FINDING_DECISION
  const decisions = mine.filter((m) => isDecision.has(m.stance) && reviewerIds.has(m.user_id)).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
  const decision = decisions[0] || null
  const doubts = mine.filter((m) => DOUBT.has(m.stance) && (!decision || new Date(m.updated_at) > new Date(decision.updated_at)))
  return { state: doubts.length ? 'discuss' : decision ? 'decided' : 'open', decision, doubts }
}

// the answer a question's decision writes: an option key, or "X. <text>" for one of the team's own
export function answerOf(item, decision, { useRecommended = false } = {}) {
  if (decision) {
    if (decision.stance === 'agree') return item.recommended || null
    if (decision.choice === 'X') return decision.note ? `X. ${decision.note}` : null
    return decision.choice || null
  }
  return useRecommended ? item.recommended || null : null
}

// The findings of an approval as the one decision the session's prompt takes (AI-DLC: "Approve accepts the
// open review findings … as risk; you can also approve and ask for one to be fixed, or reject one as not
// applying, saying why"): any to fix → Request Changes with each one and why; only "does not apply" →
// Approve with the reasons; all accepted → Approve.
export function composeApproval(items, states, { lang = 'ko' } = {}) {
  const fix = [], reject = []
  for (const it of items) {
    const d = states.get(it.key)?.decision
    if (d?.stance === 'fix') fix.push(`${it.id}${d.note ? ` — ${d.note}` : ''}`)
    if (d?.stance === 'reject') reject.push(`${it.id}${d.note ? ` — ${d.note}` : ''}`)
  }
  const ko = lang !== 'en'
  if (fix.length) {
    const parts = [`${ko ? '고쳐 주세요' : 'Please fix'}: ${fix.join('; ')}`]
    if (reject.length) parts.push(`${ko ? '해당 없음' : 'Does not apply'}: ${reject.join('; ')}`)
    return { action: 'request-changes', text: `Request Changes: ${parts.join('. ')}` }
  }
  if (reject.length) return { action: 'approve-with-notes', text: `Approve. ${ko ? '나머지는 위험으로 받아들이고, 다음은 해당 없음' : 'The rest accepted as risk; these do not apply'}: ${reject.join('; ')}` }
  return { action: 'approve', text: '' }
}

// ---------- evidence ----------
// the words a question or a finding is about (no model): nouns and IDs, not the asking words
const STOP = new Set(['어떻게', '무엇을', '무엇', '어떤', '할까요', '할까', '될까요', '있나요', '인가요', '하나요', '까지', '정도', '경우', '위한', '대한', '그리고', '또는', '이번', '지금', '같은', '것을', '것이', '하는', '있는', '없는', '으로', '에서', '에게', '합니다', '입니다', 'the', 'and', 'for', 'with', 'what', 'how', 'should', 'which', 'this', 'that', 'other', 'please', 'specify'])
export function termsOf(text) {
  const out = []
  for (let w of String(text || '').toLowerCase().split(/[^0-9a-z가-힣._-]+/)) {
    w = w.replace(/^[._-]+|[._-]+$/g, '').replace(/(은|는|이|가|을|를|의|에|로|으로|와|과|도|만|까지|부터|에서|에게)$/, '')
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue
    if (!out.includes(w)) out.push(w)
  }
  return out.slice(0, 24)
}

// lines of the record's documents that hold most of the terms, each with the heading it is under
export function searchDocs(docs, terms, { limit = 5, skip = () => false } = {}) {
  if (!terms.length) return []
  const hits = []
  for (const d of docs) {
    if (skip(d.path)) continue
    let heading = ''
    for (const line of String(d.text || '').split('\n')) {
      const h = line.match(/^#{1,4}\s+(.+)$/)
      if (h) { heading = h[1].replace(/[`*_]/g, '').trim(); continue }
      const low = line.toLowerCase()
      const n = terms.filter((t) => low.includes(t)).length
      if (n < Math.min(2, terms.length)) continue
      hits.push({ path: d.path, focus: heading, label: `${d.path.split('/').pop()}${heading ? ` › ${heading}` : ''}`, snippet: line.replace(/^[\s>*|-]+/, '').replace(/\*\*/g, '').trim().slice(0, 220), score: n + (heading && terms.some((t) => heading.toLowerCase().includes(t)) ? 1 : 0) })
    }
  }
  hits.sort((a, b) => b.score - a.score)
  const seen = new Set()
  return hits.filter((h) => { const k = h.path + '#' + h.focus; if (seen.has(k)) return false; seen.add(k); return true }).slice(0, limit)
}
