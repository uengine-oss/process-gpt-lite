// Reads an AI-DLC (2.11.2) workspace record from a project folder on disk: the intents, the state
// file, the audit log, the question files, the reviews and the unit plan. Only reads, only inside
// <root>/aidlc, and every name that comes from a request is checked before it becomes a path.
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_FILE = 8 * 1024 * 1024
const SKIP_DIRS = new Set(['.aidlc-engine', '.aidlc-sensors', 'node_modules', '.git'])
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/
const err = (status, message) => Object.assign(new Error(message), { status })

export const safeName = (s) => { if (!NAME.test(String(s || ''))) throw err(400, 'bad name'); return String(s) }

async function readText(file) {
  const st = await fs.stat(file).catch(() => null)
  if (!st?.isFile()) return null
  if (st.size > MAX_FILE) throw err(413, 'file too large')
  return fs.readFile(file, 'utf8')
}
async function isDir(p) { return !!(await fs.stat(p).catch(() => null))?.isDirectory() }

export async function hasAidlc(root) { return isDir(path.join(root, 'aidlc', 'spaces')) }

// ---------- intents ----------
// intents.json is the engine's list; folders named like 261105-voice-parking are the fallback
export async function listIntents(root) {
  const spacesDir = path.join(root, 'aidlc', 'spaces')
  const spaces = (await fs.readdir(spacesDir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && NAME.test(d.name))
  const out = []
  for (const s of spaces) {
    const dir = path.join(spacesDir, s.name, 'intents')
    let list = []
    try { list = JSON.parse((await readText(path.join(dir, 'intents.json'))) || '[]') } catch { list = [] }
    if (!list.length) {
      const dirs = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && /^\d{6}-/.test(d.name))
      list = dirs.map((d) => ({ slug: d.name.replace(/^\d{6}-/, ''), dirName: d.name }))
    }
    for (const i of list) {
      if (!NAME.test(i.slug || '') || !NAME.test(i.dirName || '')) continue
      out.push({ space: s.name, slug: i.slug, dirName: i.dirName, scope: i.scope || null, status: i.status || null, archived: !!i.archived })
    }
  }
  return out
}

// the record folder of one intent, or a 404
export async function intentDir(root, space, slug) {
  safeName(space); safeName(slug)
  const hit = (await listIntents(root)).find((i) => i.space === space && i.slug === slug)
  if (!hit) throw err(404, 'intent not found')
  const dir = path.join(root, 'aidlc', 'spaces', space, 'intents', hit.dirName)
  if (!(await isDir(dir))) throw err(404, 'intent record not found')
  return { dir, intent: hit }
}

// ---------- aidlc-state.md ----------
const FIELD = /^- \*\*(.+?)\*\*:\s*(.*)$/
const STAGE_LINE = /^- \[([ x\-?RS])\] ([a-z0-9-]+)(?: — (.*))?$/
export function parseState(text) {
  const fields = {}
  const stages = []
  for (const line of String(text || '').split('\n')) {
    const f = line.match(FIELD)
    if (f && !(f[1] in fields)) fields[f[1]] = f[2].trim()
    const s = line.match(STAGE_LINE)
    if (s) stages.push({ slug: s[2], mark: s[1], decision: (s[3] || '').trim() })
  }
  return {
    project: fields.Project || '', scope: fields.Scope || '', depth: fields.Depth || '', testStrategy: fields['Test Strategy'] || '',
    currentStage: fields['Current Stage'] || '', nextStage: fields['Next Stage'] || '', status: fields.Status || '', nextAction: fields['Next Action'] || '',
    autonomy: fields['Construction Autonomy Mode'] || '', verificationCommand: fields['Construction Verification Command'] || '',
    stages,
  }
}
export async function readState(dir) {
  return parseState(await readText(path.join(dir, 'aidlc-state.md')))
}

// ---------- audit ----------
// blocks separated by "---": "## Title" then "**Key**: value" lines
const KV = /^\*\*(.+?)\*\*:\s?(.*)$/
export function parseAudit(text) {
  const events = []
  for (const block of String(text || '').split(/\n---\n/)) {
    const fields = {}
    let title = ''
    for (const line of block.split('\n')) {
      if (!title && line.startsWith('## ')) title = line.slice(3).trim()
      const m = line.match(KV)
      if (m && !(m[1] in fields)) fields[m[1]] = m[2]
    }
    if (!fields.Event || !fields.Timestamp) continue
    const t = Date.parse(fields.Timestamp)
    if (Number.isNaN(t)) continue
    events.push({ t, ts: fields.Timestamp, event: fields.Event, title, stage: fields.Stage || fields['Stage slug'] || '', unit: fields.Unit || '', fields })
  }
  return events
}
// a file is parsed again only when its size or mtime changed (dashboards refresh every 20 s and an
// audit log of a long run is a few thousand events)
const parsed = new Map() // file -> { key, value }
async function parsedFile(file, parse) {
  const st = await fs.stat(file).catch(() => null)
  if (!st?.isFile()) return null
  const key = `${st.size}:${st.mtimeMs}`
  const hit = parsed.get(file)
  if (hit?.key === key) return hit.value
  const value = parse(await readText(file))
  if (parsed.size > 500) parsed.clear()
  parsed.set(file, { key, value })
  return value
}
const auditOf = async (file) => (await parsedFile(file, parseAudit)) || []

// every clone writes its own shard; merged in time order (stable within a shard)
export async function readAudit(dir) {
  const adir = path.join(dir, 'audit')
  const files = (await fs.readdir(adir).catch(() => [])).filter((f) => f.endsWith('.md') && NAME.test(f)).sort()
  const all = []
  for (const f of files) (await auditOf(path.join(adir, f))).forEach((e, i) => all.push({ ...e, shard: f, i }))
  return all.sort((a, b) => a.t - b.t || (a.shard === b.shard ? a.i - b.i : a.shard.localeCompare(b.shard)))
}

// ---------- walking the record ----------
// the question and review files of a record: one walk, reused for 15 s (a new stage's files show up
// on the next refresh; answers written into an existing file are seen at once through its mtime)
const WALK_TTL = 15000
const walks = new Map() // dir -> { at, files }
async function recordFiles(dir) {
  const hit = walks.get(dir)
  if (hit && Date.now() - hit.at < WALK_TTL) return hit.files
  const files = (await walk(dir, (r) => /(^|\/)[a-z0-9-]+-questions\.md$/.test(r) || /\/reviews\/review-\d+\.md$/.test(r))).sort()
  if (walks.size > 200) walks.clear()
  walks.set(dir, { at: Date.now(), files })
  return files
}
async function walk(dir, pick, rel = '', depth = 0, out = []) {
  if (depth > 6) return out
  for (const d of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue
    const r = rel ? `${rel}/${d.name}` : d.name
    if (d.isDirectory()) await walk(dir, pick, r, depth + 1, out)
    else if (pick(r)) out.push(r)
  }
  return out
}
// phase/stage or phase/unit/stage → { phase, stage, unit }
function where(rel) {
  const parts = rel.split('/')
  const phase = parts[0]
  if (phase === 'construction' && parts.length >= 4) return { phase, unit: parts[1], stage: parts[2] }
  return { phase, stage: parts[1] || '', unit: '' }
}

// ---------- question files ----------
const Q_HEAD = /^## (Q\d+)\.\s*(?:\[([^\]]+)\]\s*)?(\((?:후속|follow-?up)\)\s*)?(.*)$/i
const OPTION = /^- ([A-Z])\.\s+(.*)$/
const ANSWER = /^\[Answer\]:\s*(.*)$/
// after the answers the engine adds one section asking the person to confirm its summary before it
// writes the artifact ("Does this all look correct …?" with plain "- Looks correct" options)
const SUMMARY = /^## (?:Consolidated )?Summary Confirmation\s*$/i
export function parseQuestions(text) {
  const qs = []
  let cur = null
  for (const line of String(text || '').split('\n')) {
    const h = line.match(Q_HEAD)
    if (h) { cur = { id: h[1], tag: h[2] || '', followup: !!h[3], text: h[4].trim(), options: [], answer: '' }; qs.push(cur); continue }
    if (SUMMARY.test(line)) { cur = { id: 'summary', tag: '', followup: false, summary: true, text: '', options: [], answer: '' }; qs.push(cur); continue }
    if (line.startsWith('## ')) { cur = null; continue }
    if (!cur) continue
    const o = line.match(OPTION) || (cur.summary && line.match(/^- ()(.+)$/))
    if (o) { cur.options.push({ key: o[1], text: o[2].trim() }); continue }
    const a = line.match(ANSWER)
    if (a) { cur.answer = a[1].trim(); continue }
    if (cur.summary && !cur.text && line.trim()) cur.text = line.trim()
  }
  return qs
}
export async function listQuestions(dir) {
  const files = (await recordFiles(dir)).filter((r) => r.endsWith('-questions.md'))
  const out = []
  for (const rel of files) {
    const questions = (await parsedFile(path.join(dir, rel), parseQuestions)) || []
    if (!questions.length) continue
    out.push({ path: rel, ...where(rel), questions, open: questions.filter((q) => !q.answer).length })
  }
  return out
}

// Answers agreed by the team written into a question file: the first `[Answer]:` line of each
// `## Qn.` section (and of the summary confirmation, key 'summary'). Only a question file of this
// record (the walk above), only questions that are there; returns what was written.
export async function writeAnswers(dir, rel, answers) {
  const files = await recordFiles(dir)
  if (!files.includes(rel) || !rel.endsWith('-questions.md')) throw err(404, 'questions file not found')
  const file = path.join(dir, rel)
  const lines = String(await readText(file)).split('\n')
  const written = {}
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(Q_HEAD)
    if (h) { cur = h[1]; continue }
    if (SUMMARY.test(lines[i])) { cur = 'summary'; continue }
    if (lines[i].startsWith('## ')) { cur = null; continue }
    if (cur && ANSWER.test(lines[i]) && cur in answers && !(cur in written)) {
      const a = String(answers[cur] ?? '').replace(/\s*\n\s*/g, ' ').trim().slice(0, 500)
      if (a) { lines[i] = `[Answer]: ${a}`; written[cur] = a }
    }
  }
  if (!Object.keys(written).length) throw err(400, 'nothing to write')
  await fs.writeFile(file, lines.join('\n'))
  return written
}

// ---------- reviews ----------
const VERDICT = /^\*\*Verdict:\*\*\s*(\S+)/m
const META = (k) => new RegExp(`^\\*\\*${k}:\\*\\*\\s*(.+)$`, 'm')
export function parseReview(text) {
  text = String(text || '')
  const findings = []
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length > 4 && /^R-\d+$/.test(cells[1])) findings.push({ id: cells[1], severity: cells[2], status: cells[cells.length - 2] || '' })
  }
  return {
    verdict: (text.match(VERDICT) || [])[1] || '', reviewer: (text.match(META('Reviewer')) || [])[1] || '',
    date: (text.match(META('Date')) || [])[1] || '', iteration: Number((text.match(META('Iteration')) || [])[1]) || null, findings,
  }
}
export async function listReviews(dir) {
  const files = (await recordFiles(dir)).filter((r) => /\/reviews\/review-\d+\.md$/.test(r))
  const out = []
  for (const rel of files) {
    const r = await parsedFile(path.join(dir, rel), parseReview)
    if (!r) continue
    out.push({ path: rel, ...where(rel), ...r, major: r.findings.filter((f) => /major/i.test(f.severity)).length, minor: r.findings.filter((f) => /minor/i.test(f.severity)).length })
  }
  return out
}

// ---------- units ----------
// the fenced yaml block of unit-of-work-dependency.md: units: - name / kind / depends_on: [a, b]
export function parseUnits(text) {
  const block = (String(text || '').match(/```ya?ml\s*\n([\s\S]*?)```/) || [])[1]
  if (!block || !/^units:/m.test(block)) return []
  const units = []
  let cur = null
  for (const line of block.split('\n')) {
    let m
    if ((m = line.match(/^\s*-\s+name:\s*(.+)$/))) { cur = { name: m[1].trim(), kind: '', dependsOn: [] }; units.push(cur) } else if (cur && (m = line.match(/^\s+kind:\s*(.+)$/))) cur.kind = m[1].trim()
    else if (cur && (m = line.match(/^\s+depends_on:\s*\[(.*)\]\s*$/))) cur.dependsOn = m[1].split(',').map((s) => s.trim()).filter(Boolean)
  }
  return units
}
export async function readUnits(dir) {
  return parseUnits(await readText(path.join(dir, 'inception', 'units-generation', 'unit-of-work-dependency.md')))
}
