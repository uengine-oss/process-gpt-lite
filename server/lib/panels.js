// Panel = a small vibe-coded app on Home. The model writes HTML + a script against a
// tiny runtime that the client injects into a sandboxed iframe:
//   panel.data           persisted JSON state      panel.save(obj)
//   panel.fetch(url)     GET a public JSON API through the server proxy
//   panel.ask(prompt)    one-shot LLM answer (string)
//   panel.open(url)      open link in a new tab    panel.chat(text)  send text to the chat
//   ui.spark(values,{labels})  -> SVG line chart;  ui.money(n), ui.ago(date)
// CSS classes available: .p-row .p-cell .p-k .p-v .p-big .p-sub .p-list .p-item .p-btn .p-muted .p-nav
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatJson } from './llm.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { isEn } from './lang.js'
import { frontmatter } from './skillInstallCatalog.js'

// The panel runtime and its rules (system facts). Which outside services hold live values, and how to
// read them, is knowledge: the panel skill's references (skills/actions/panel-create/references/*.md),
// read only when a panel needs them — the model asks for one by name, or the caller already knows the
// panel shows live outside values (routes/panelApps.js: the design said 'live').
const SYSTEM = `You build small Home "panels" (mini-apps) for a personal work assistant UI.
Return JSON: {"title": "짧은 한국어 제목", "icon": "single emoji", "html": "...", "script": "...", "data": {...}}
Rules:
- html is a body fragment only. Use the provided CSS classes; no <style>, no external CSS/JS.
  .p-row (flex row gap 8) .p-cell (rounded tile) .p-k (small label) .p-v (value 28px) .p-big (36px number)
  .p-sub (secondary text) .p-list/.p-item (list rows) .p-btn (full-width pill button) .p-muted .p-nav (prev/title/next header)
- script is plain JS run after html loads. Available globals: $(selector) -> element, panel {data, save(obj), fetch(url)->Promise<json>, ask(prompt)->Promise<string>, open(url), chat(text)}, ui {spark(values,{labels}), days(timestamps), money(n), ago(date)}.
- Live outside data comes from free public JSON APIs through panel.fetch (public HTTPS JSON only).
- Personal data the user types (to-dos, logs, goals) lives in panel.data and is saved with panel.save.
- Korean UI text. Keep it compact: the panel is 356px wide. Handle loading/error states quietly.
- Chart x labels must be short (weekday like Mon/Tue): use ui.days(timestamps) for labels, at most 7.
- Never request passwords or payment info.`

// English mode (lib/lang.js): the same prompt asking for an English title and English UI text
const system = () => (isEn()
  ? SYSTEM.replace('"title": "짧은 한국어 제목"', '"title": "short English title"').replace('- Korean UI text.', '- English UI text (labels, buttons, messages, dates in en-US).')
  : SYSTEM)

const here = path.dirname(fileURLToPath(import.meta.url))
const REF_DIR = () => process.env.PRO_PANEL_REFERENCES_DIR || path.join(here, '..', '..', 'skills', 'actions', 'panel-create', 'references')
// the references there: {name, description, body} (front matter name·description, our own file format)
export function panelReferences() {
  let files = []
  try { files = fs.readdirSync(REF_DIR()).filter((f) => f.endsWith('.md')).sort() } catch { return [] }
  return files.map((f) => {
    const { meta, body } = frontmatter(fs.readFileSync(path.join(REF_DIR(), f), 'utf8'))
    return { name: meta.name || f.replace(/\.md$/, ''), description: meta.description || '', body: body.trim() }
  }).filter((r) => r.description)
}
// the prompt: the references not loaded are listed by name and what they hold; the loaded ones follow in full
export function panelPrompt(loaded = []) {
  const refs = panelReferences()
  const index = refs.filter((r) => !loaded.includes(r.name))
  return [system(),
    index.length ? `References you can ask for (answer only {"need_reference":"<name>"} to get one before you build, when the panel needs it):\n${index.map((r) => `- ${r.name}: ${r.description}`).join('\n')}` : '',
    ...refs.filter((r) => loaded.includes(r.name)).map((r) => `Reference ${r.name}:\n${r.body}`)].filter(Boolean).join('\n\n')
}
// one model answer that is a panel: a reference it asked for is read and the call made once more
async function design(user, loaded = []) {
  let spec = await chatJson(panelPrompt(loaded), user)
  const want = String(spec?.need_reference || '')
  if (want && !loaded.includes(want) && panelReferences().some((r) => r.name === want)) spec = await chatJson(panelPrompt([...loaded, want]), user)
  return spec
}

// live: the caller already knows the panel shows live outside values (every reference is loaded up front)
export async function generatePanel({ userId, description, live = false }) {
  const spec = await design(description, live ? panelReferences().map((r) => r.name) : [])
  const [p] = await q(
    `insert into pro_panels(user_id,title,icon,spec,data) values ($1,$2,$3,$4,$5) returning *`,
    [userId, spec.title, spec.icon, { html: spec.html, script: spec.script, description }, spec.data || {}])
  emit(userId, 'panel', p)
  return p
}

export async function revisePanel({ userId, id, instruction }) {
  const [p] = await q('select * from pro_panels where id=$1 and user_id=$2', [id, userId])
  if (!p) throw new Error('panel not found')
  const spec = await design(`Current panel JSON:\n${JSON.stringify({ title: p.title, icon: p.icon, html: p.spec.html, script: p.spec.script, data: p.data })}\n\nChange request: ${instruction}`)
  const [n] = await q(`update pro_panels set title=$3, icon=$4, spec=$5, updated_at=now() where id=$1 and user_id=$2 returning *`,
    [id, userId, spec.title, spec.icon, { ...p.spec, html: spec.html, script: spec.script }])
  emit(userId, 'panel', n)
  return n
}

export async function savePanelData(userId, id, data) {
  const [p] = await q('update pro_panels set data=$3, updated_at=now() where id=$1 and user_id=$2 returning id', [id, userId, data])
  return p
}

// Server-side GET proxy for panel scripts (public JSON only, no cookies, small bodies).
export async function proxyFetch(url) {
  const u = new URL(url)
  if (!/^https:$/.test(u.protocol)) throw new Error('https only')
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(u.hostname)) throw new Error('private address')
  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 pgpt-pro-panel' }, redirect: 'follow' })
  const text = await res.text()
  if (text.length > 2_000_000) throw new Error('too large')
  try { return JSON.parse(text) } catch { return { text: text.slice(0, 20000) } }
}
