// 일 정의(design-v0.2 §6): a task's definition is a SKILL.md-shaped document (front matter + body) kept on the task node —
// what the step does, what it hands over (output format and the template it follows) and what it must keep (checkpoints);
// the skills it points to do the "how". `kind: task` tells it apart from an ordinary skill. Its draft comes from the
// template the company's mail shows for that work (an xlsx quote form: its fields become checkpoints).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { chatJson } from '../llm.js'
import { cypher, parseTask } from './store.js'
import { formFields, readFile, formKey } from './mailbody.js'
import { prompt, rules as skillRules } from './discovery.js'
import { formsDirOf } from './history.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, '..', '..', 'scripts', 'fixtures')
const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })

// ---------- the front matter (a small YAML subset: scalars, [a, b], "- item" lists, lists of maps) ----------
const unq = (s) => String(s).trim().replace(/^["']|["']$/g, '')
const scalar = (v) => {
  const s = String(v).replace(/\s+#.*$/, '').trim()
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map(unq).filter(Boolean)
  if (s === 'true' || s === 'false') return s === 'true'
  return unq(s)
}
export function parseDefinition(md) {
  const m = String(md || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { front: {}, body: String(md || '') }
  const front = {}
  let key = null, list = null, item = null
  for (const line of m[1].split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (top) {
      key = top[1]; item = null
      if (top[2].replace(/\s+#.*$/, '').trim()) { front[key] = scalar(top[2]); list = null } else { front[key] = list = [] }
      continue
    }
    const li = line.match(/^\s+-\s+(.*)$/)
    if (li && list) {
      const kv = li[1].match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
      if (kv) { item = { [kv[1]]: scalar(kv[2]) }; list.push(item) } else { item = null; list.push(scalar(li[1])) }
      continue
    }
    const sub = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/)
    if (sub && item) item[sub[1]] = scalar(sub[2])
  }
  return { front, body: m[2] }
}
const y = (v) => (/[:#\[\]{}]|^\s|\s$/.test(String(v)) ? JSON.stringify(String(v)) : String(v))
export function toDefinition(front, body = '') {
  const out = ['---']
  for (const [k, v] of Object.entries(front)) {
    if (Array.isArray(v) && v.every((x) => typeof x !== 'object')) {
      if (k === 'skills') out.push(`${k}: [${v.join(', ')}]`)
      else { out.push(`${k}:`); for (const x of v) out.push(`  - ${y(x)}`) }
    } else if (Array.isArray(v)) {
      out.push(`${k}:`)
      for (const o of v) { const [first, ...rest] = Object.entries(o); out.push(`  - ${first[0]}: ${y(first[1])}`); for (const [a, b] of rest) out.push(`    ${a}: ${y(b)}`) }
    } else out.push(`${k}: ${y(v)}`)
  }
  out.push('---', '', String(body || '').trim(), '')
  return out.join('\n')
}

// what a snapshot needs from a task (defaults when it has no definition yet: a person's step)
export async function taskDefinition(key, task) {
  const { front, body } = parseDefinition(task?.definition_md || '')
  return {
    runner: front.runner === 'agent' ? 'agent' : 'person',
    skills: Array.isArray(front.skills) ? front.skills : [],
    checkpoints: Array.isArray(front.checkpoints) ? front.checkpoints.map(String) : [],
    outputs: Array.isArray(front.outputs) ? front.outputs : [],
    autonomy: front.autonomy || 'draft',
    description: front.description || '',
    instruction: String(body || '').trim().slice(0, 4000),
  }
}

export async function getTask(key) {
  const [r] = await cypher('MATCH (t:Task {key:$key}) RETURN t', { key })
  if (!r) throw err(404, '일을 찾지 못했어요.')
  const t = parseTask(r.t)
  const raws = await q(`select raw, act, how from pro_onto_labels where tenant_id=$1 and task=$2 and coalesce(act,'') <> 'habit' order by length(raw) desc limit 12`, [T(), key])
  return { task: t, definition: t.definition_md || '', parsed: await taskDefinition(key, t), labels: raws, templates: await templatesOf(key) }
}

// the attachments the company's mail shows for this work (most frequent first) and whether a template file is at hand.
// One form is the attachments that hold the same thing: the same template file, the same name before the customer part
// (「견적서_달빛커피.xlsx」 → 견적서), or — a real mailbox names files by customer first (「바이켐_AI 도입_제안서.docx」) —
// mostly the same labels (rules.forms.sameLabels). A form whose name is not a kind of document is named by the model
// from its file names and labels (the skill's prompts/name-form.md).
export async function templatesOf(key) {
  const forms = (await skillRules()).forms
  const raws = (await q(`select raw from pro_onto_labels where tenant_id=$1 and task=$2`, [T(), key])).map((r) => r.raw)
  const rows = await q(`select artifacts from pro_mail_history where tenant_id=$1 and (activity_label = $2 or activity_label = any($3))`, [T(), key, raws])
  const items = []
  for (const r of rows) for (const f of r.artifacts || []) {
    const kind = String(f.type || '').toLowerCase()
    if (!['xlsx', 'docx', 'hwpx', 'pptx'].includes(kind)) continue
    const file = f.file || templateFile(f.name)
    const stem = String(f.name).split(/[_\s(]/)[0].replace(/\.[a-z0-9]+$/i, '')
    items.push({ f, kind, file, stem, key: (file && !file.startsWith('forms/') && file) || `${stem}.${kind}`, labels: new Set(f.fields || []) })
  }
  // the same form: the same key, or (same kind) most of the labels shared
  const group = items.map((_, i) => i)
  const root = (i) => (group[i] === i ? i : (group[i] = root(group[i])))
  const same = forms.sameLabels ?? 0.5
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j]
    if (a.kind !== b.kind) continue
    const both = [...a.labels].filter((l) => b.labels.has(l)).length
    const jac = a.labels.size && b.labels.size ? both / (a.labels.size + b.labels.size - both) : 0
    if (a.key === b.key || jac >= same) group[root(i)] = root(j)
  }
  const by = new Map()
  for (const [i, it] of items.entries()) { const g = root(i); if (!by.has(g)) by.set(g, []); by.get(g).push(it) }
  const out = []
  for (const its of by.values()) {
    const stems = new Map()
    for (const it of its) stems.set(it.key, (stems.get(it.key) || 0) + 1)
    const top = [...stems].sort((a, b) => b[1] - a[1])[0][0]
    const lead = its.find((it) => it.key === top)
    const fixture = its.find((it) => it.file && !it.file.startsWith('forms/'))
    const kept = its.filter((it) => it.file).at(-1)
    const fields = formFields(its.filter((it) => it.labels.size).map((it) => [...it.labels]), forms)
    const name = fixture ? path.basename(fixture.file) : DOC_KIND.test(lead.stem) ? `${lead.stem}.${lead.kind}` : `${await formName(its, fields)}.${lead.kind}`
    // the template file: one of these mails kept it, else the latest file of that form kept from another mail (forms/<key>)
    const kept1 = kept?.file || its.map((it) => `forms/${formKey(it.f.name)}`).find((rel) => fs.existsSync(path.join(formsDirOf(), rel.slice(6)))) || null
    // groups the model named alike (a customer's file without labels beside the company's) are one form
    const same1 = out.find((x) => x.name === name)
    if (same1) { same1.seen += its.length; same1.fileNames += new Set(its.map((it) => it.f.name)).size; same1.file ||= kept1; if (fields.length > same1.fields.length) same1.fields = fields; continue }
    out.push({ name, type: lead.kind, seen: its.length, file: kept1, example: lead.f.name, fileNames: new Set(its.map((it) => it.f.name)).size, fields })
  }
  return out.sort((a, b) => b.seen - a.seen)
}
// a file name that already says what kind of document it is (「견적서_…」 · 「과거력조사_…」)
const DOC_KIND = /(서|표|록|안|조사|양식|보고|계획|명세|내역|현황|목록|대장|일지|리포트|report|proposal|quote|invoice|form)$/i
const formNames = new Map()
async function formName(its, fields) {
  const names = [...new Set(its.map((it) => it.f.name))].slice(0, 6)
  const k = names.slice().sort().join('|')
  if (formNames.has(k)) return formNames.get(k)
  let n = ''
  try {
    const r = await chatJson(await prompt('name-form'), JSON.stringify({ file_names: names, labels: (fields.length ? fields : [...its[0].labels]).slice(0, 24) }), { timeoutMs: 90000, temperature: 0 })
    n = String(r?.name || '').replace(/[\\/:*?"<>|.]/g, ' ').trim().slice(0, 20)
  } catch (e) { console.warn('[ontology] form name', e.message) }
  n ||= its[0].stem
  formNames.set(k, n)
  return n
}

// the template file behind an attachment name: the demo mailbox's archive names it (fixtures/ax-demo-templates);
// a real mailbox would open the example mail's attachment with its owner's token (not done here)
function templateFile(attachmentName) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'ax-demo-mailbox.json'), 'utf8'))
    for (const m of a.mails) for (const f of m.attachments || []) if (f.name === attachmentName && f.file) {
      const p = path.join(FIXTURES, f.file)
      if (fs.existsSync(p)) return f.file
    }
  } catch {}
  return null
}

// a cell as the text a person sees: rich-text runs joined (LibreOffice saves a mixed-font cell that way), a formula by
// its last result, a date as its day
export function cellText(v) {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v !== 'object') return String(v)
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text || '').join('')
  if (v.text != null) return cellText(v.text)
  if (v.result != null) return cellText(v.result)
  if (v.formula || v.sharedFormula) return `=${v.formula || v.sharedFormula}`
  return ''
}
// a workbook as lines of cells (a merged range's repeated value once)
export function sheetText(wb) {
  const lines = []
  wb.eachSheet((ws) => ws.eachRow((row) => {
    const cells = []
    row.eachCell((c) => { if (c.isMerged && c.master.address !== c.address) return; const t = cellText(c.value).trim(); if (t) cells.push(t) })
    if (cells.length) lines.push(cells.join(' | '))
  }))
  return lines.join('\n')
}

// a template's text: the demo's fixture files, or the latest file of a form the company sent from a real mailbox (forms/…)
export function templatePath(rel) {
  return String(rel).startsWith('forms/') ? path.join(formsDirOf(), String(rel).slice('forms/'.length)) : path.join(FIXTURES, rel)
}
export async function templateText(rel) {
  const p = templatePath(rel)
  if (!/\.xlsx$/i.test(p)) return (await readFile(path.basename(p), fs.readFileSync(p))).text.slice(0, 4000)
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(p)
  return sheetText(wb).slice(0, 4000)
}

// prompt: the process-discovery skill's prompts/draft-task-definition.md

export async function draftDefinition(key, { template } = {}) {
  const { task, templates } = await getTask(key)
  const t = template ? templates.find((x) => x.name === template) : templates.find((x) => x.file)
  const text = t?.file ? await templateText(t.file).catch(() => '') : ''
  const [nexts] = [await cypher('MATCH (a:Task {key:$key})-[e:NEXT]->(b:Task) RETURN b.key AS to, e.p AS p', { key })]
  const [prevs] = [await cypher('MATCH (a:Task)-[e:NEXT]->(b:Task {key:$key}) RETURN a.key AS from, e.p AS p', { key })]
  const r = await chatJson(await prompt('draft-task-definition'), JSON.stringify({ task: key, role: task.role, before: prevs.map((x) => x.from), after: nexts.map((x) => x.to), template: t ? { name: t.name, seen_in_mails: t.seen, fields: text || (t.fields || []).join(' | ') } : null }), { temperature: 0, timeoutMs: 60000 })
  const front = {
    name: key, description: String(r.description || ''), kind: 'task', role: task.role || '',
    runner: r.runner === 'agent' ? 'agent' : 'person', skills: (r.skills || []).map(String),
    outputs: (r.outputs || []).map((o) => ({ name: String(o.name || key), format: String(o.format || t?.type || ''), ...(t?.file ? { template: t.name } : {}) })),
    checkpoints: (r.checkpoints || []).map(String).slice(0, 8), autonomy: 'draft',
  }
  return { definition: toDefinition(front, String(r.body || '')), template: t || null, fields: text }
}

export async function saveDefinition(me, key, md) {
  const { front } = parseDefinition(md)
  if (front.kind && front.kind !== 'task') throw err(400, '일 정의는 kind: task 여야 해요.')
  const d = await taskDefinition(key, { definition_md: md })
  await cypher(`MATCH (t:Task {key:$key}) SET t.definition_md=$md, t.skills=$skills, t.checkpoints=$cp, t.outputs=$outs, t.autonomy=$aut`,
    { key, md, skills: d.skills, cp: JSON.stringify(d.checkpoints), outs: JSON.stringify(d.outputs), aut: d.autonomy },
    { actor: me.email || String(me.id), reason: '일 정의 저장' })
  return getTask(key)
}
