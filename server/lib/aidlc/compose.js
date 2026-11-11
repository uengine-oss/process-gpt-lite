// What a new request would mean for an AI-DLC project, before anything is started (docs/robo-dlc/plan-intake.md
// §2–§3): Claude Code reads the project's own record and code without writing a thing (headless, read-only
// tools, the project's hooks off so the audit log stays untouched) and scores the request with the rubric
// AI-DLC's composer uses; the AI-DLC engine turns the five scores into its index and nearest scopes; then
// every name the model gave is checked against the record — a unit, contract or file that is not there is
// dropped and shown as dropped, never passed on.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../../config.js'
import { cleanEnv } from './session.js'

const SCORE = { type: 'object', required: ['score', 'why'], properties: { score: { type: 'number' }, why: { type: 'string' } } }
const NAMES = { type: 'array', items: { type: 'string' } }
export const KINDS = ['bug', 'feature', 'change', 'security', 'refactor', 'question']
export const COMPONENTS = ['iae', 'csu', 've', 'r', 'ua']
export const SCHEMA = {
  type: 'object', required: ['title', 'kind', 'scores', 'touches', 'summary'],
  properties: {
    title: { type: 'string' }, kind: { type: 'string', enum: KINDS },
    scores: { type: 'object', required: COMPONENTS, properties: Object.fromEntries(COMPONENTS.map((k) => [k, SCORE])) },
    touches: { type: 'object', properties: { units: NAMES, contracts: NAMES, requirements: NAMES, paths: NAMES } },
    newUnits: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, why: { type: 'string' } } } },
    conflicts: { type: 'array', items: { type: 'object', properties: { bolt: { type: 'string' }, requestQuote: { type: 'string' }, recordQuote: { type: 'string' }, compatible: { type: 'boolean' }, why: { type: 'string' } } } },
    summary: { type: 'string' },
  },
}

export function promptFor({ request, lineText, lang = 'ko' }) {
  return `You estimate, read-only, how a new request should enter this AI-DLC project. Do not modify any file and do not start or continue a workflow.

1. Read \`.claude/agents/aidlc-composer-agent.md\`, Step 2 (2.1–2.2): that is the rubric. Score the five ARS components for the request in [0.00, 1.00], two decimals, each with ONE sentence of evidence naming what you looked at (a file, a requirement ID, the words of the request).
2. Read the project's AI-DLC record to see what the request touches: \`aidlc/spaces/*/intents/intents.json\`; for each intent \`inception/units-generation/unit-of-work-dependency.md\`, \`inception/contract-design/contract-summary.md\`, \`inception/requirements-analysis/*.md\`, \`inception/delivery-planning/bolt-plan.md\`; and the code only as far as needed. In \`touches\` give exact names as they appear in the record: units (e.g. u5-notification-worker), contracts (e.g. C6), requirement IDs, code paths (at most 6).
3. \`newUnits\`: only if the request needs a unit of work that does not exist yet.
4. \`conflicts\`: for each bolt in LINE below that this request contradicts or makes obsolete, give the bolt key exactly as written there, a short quote from the request, a short quote from that bolt's request or record, whether both can stand (\`compatible\`), and why in one sentence. Empty when nothing conflicts. Do not invent conflicts.
5. \`kind\`: bug | feature | change | security | refactor | question. \`title\`: 30 characters at most. \`summary\`: two sentences at most on what would be done.

${lang === 'en' ? 'Write every sentence in English.' : 'Write every sentence in Korean (polite 해요체).'} Return the JSON only.

LINE:
${lineText || '(empty)'}

REQUEST:
${request}
`
}

// the work a new request could collide with, as the prompt's LINE: every bolt not released yet
export function lineText(line, requests = []) {
  const body = (b) => String(requests.find((r) => r.id === b.request)?.body || '').replace(/\s+/g, ' ').slice(0, 240)
  return (line?.bolts || []).filter((b) => b.bucket !== 'shipped' && !b.discarded)
    .map((b) => `- ${b.key} [${b.state}] unit=${b.unit} — ${b.title}${body(b) ? `: "${body(b)}"` : ''}`).join('\n')
}

function run(cmd, args, { cwd, input, timeout }) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', errText = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(cmd)} timed out`)) }, timeout)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { errText += d })
    p.on('error', (e) => { clearTimeout(timer); reject(e) })
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${errText.slice(-300)}`)) })
    p.stdin.end(input || '')
  })
}

// The stand-in for tests (PRO_AIDLC_COMPOSE_STUB: a JSON file [{ match, estimate }]): the first entry whose
// `match` (a regular expression) the request meets. No model is called.
async function stubFor(request) {
  const list = JSON.parse(await fs.readFile(config.aidlcComposeStub, 'utf8'))
  const hit = list.find((x) => new RegExp(x.match).test(request))
  if (!hit) throw new Error('no stub for this request')
  return { raw: hit.estimate, cost: { ms: 0, usd: 0, turns: 0, stub: true } }
}

async function ask({ root, request, lineText: text, lang }) {
  if (config.aidlcComposeStub) return stubFor(request)
  const args = ['-p', '--setting-sources', 'user', '--allowedTools', 'Read', 'Grep', 'Glob', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA)]
  if (config.aidlcComposeModel) args.push('--model', config.aidlcComposeModel)
  const out = JSON.parse(await run(config.claudeBin, args, { cwd: root, input: promptFor({ request, lineText: text, lang }), timeout: 8 * 60 * 1000 }))
  if (out.is_error || !out.structured_output) throw new Error(`estimate failed: ${String(out.result || out.subtype || '').slice(0, 200)}`)
  return { raw: out.structured_output, cost: { ms: out.duration_ms, usd: out.total_cost_usd, turns: out.num_turns } }
}

// the engine's reading of the five scores (null when this server has no AI-DLC engine)
export async function ars(root, scores) {
  const args = ['engine', 'graph', 'ars', ...COMPONENTS.flatMap((k) => [`--${k}`, scores[k].toFixed(2)]), '--method', 'fallback', '--project-type', 'brownfield']
  try {
    const d = JSON.parse(await run('aidlc', args, { cwd: root, timeout: 30000 }))
    return {
      total: d.composite.total, label: d.composite.label, shape: d.composite.shape,
      bands: Object.fromEntries(COMPONENTS.map((k) => [k, d.components?.[k]?.band || null])),
      nearest: (d.nearestScopes || []).slice(0, 4).map((s) => ({ scope: s.scope, diff: s.diff })),
      stages: Object.values(d.screenGrid || {}).filter((v) => v === 'EXECUTE').length,
    }
  } catch (e) {
    console.warn('[aidlc compose] engine ars', e.message)
    return null
  }
}

// the scopes this project has (.claude/scopes/aidlc-<name>.md): [{ name, depth, description, existingCode }]
export async function scopes(root) {
  const dir = path.join(root, '.claude', 'scopes')
  const out = []
  for (const f of (await fs.readdir(dir).catch(() => [])).filter((x) => /^aidlc-[a-z0-9-]+\.md$/.test(x)).sort()) {
    const head = (await fs.readFile(path.join(dir, f), 'utf8')).split(/^---\s*$/m)[1] || ''
    const get = (k) => (head.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] || '').trim().replace(/^"|"$/g, '')
    out.push({ name: get('name') || f.slice(6, -3), depth: get('depth'), description: get('description'), existingCode: get('existing_code') === 'true' })
  }
  return out
}

// Which scope to suggest. The kind of request first — AI-DLC has a scope made for a bug, a security fix and
// a clean-up of existing code; otherwise by size: something small in one unit takes the lightest run, the
// rest the feature lifecycle. The engine's nearest scopes compare stage lists only and are shown beside it.
export function suggestScope(est, available = []) {
  const has = (n) => !available.length || available.some((s) => s.name === n)
  const byKind = { bug: 'bugfix', security: 'security-patch', refactor: 'refactor' }[est.kind]
  if (byKind && has(byKind)) return { scope: byKind, why: 'kind' }
  const small = (est.ars ? est.ars.total <= 40 : true) && (est.touches.units.length <= 1) && !est.newUnits.length
  if (small && has('express')) return { scope: 'express', why: 'small' }
  if (has('feature')) return { scope: 'feature', why: 'size' }
  return { scope: est.ars?.nearest?.[0]?.scope || available[0]?.name || 'classic', why: 'nearest' }
}

const clamp = (n) => Math.round(Math.min(1, Math.max(0, Number(n) || 0)) * 100) / 100
const uniq = (list) => [...new Set((list || []).map((x) => String(x).trim()).filter(Boolean))]

// Keep only what the record has. → the estimate, with `dropped` naming what was left out.
// known: { units: [name], contracts: [id], requirements: <text of the requirement files>, lineKeys: [key], paths: (p) => exists }
export async function verify(raw, known) {
  const dropped = { units: [], contracts: [], requirements: [], paths: [], conflicts: [] }
  const keep = (list, ok, bin) => uniq(list).filter((x) => (ok(x) ? true : (bin.push(x), false)))
  const t = raw.touches || {}
  const unitName = (x) => known.units.find((u) => u === x || u.replace(/^u\d+-/, '') === x) || null
  const units = uniq(keep(t.units, (x) => !!unitName(x), dropped.units).map(unitName))
  const contracts = keep((t.contracts || []).map((c) => String(c).toUpperCase()), (x) => known.contracts.includes(x), dropped.contracts)
  const requirements = keep(t.requirements, (x) => new RegExp(`(^|[^A-Za-z0-9.])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9.])`).test(known.requirements || ''), dropped.requirements)
  const paths = []
  for (const p of uniq(t.paths).slice(0, 8)) (await known.paths(p)) ? paths.push(p) : dropped.paths.push(p)
  const newUnits = (raw.newUnits || []).filter((u) => u?.name && !unitName(u.name)).map((u) => ({ name: String(u.name).trim().slice(0, 60), why: String(u.why || '') }))
  const conflicts = []
  for (const c of raw.conflicts || []) {
    const key = known.lineKeys.find((k) => k === c.bolt) || known.lineKeys.find((k) => String(c.bolt || '').includes(k))
    key ? conflicts.push({ bolt: key, requestQuote: String(c.requestQuote || ''), recordQuote: String(c.recordQuote || ''), compatible: !!c.compatible, why: String(c.why || '') }) : dropped.conflicts.push(String(c.bolt || ''))
  }
  return {
    title: String(raw.title || '').trim().slice(0, 60), kind: KINDS.includes(raw.kind) ? raw.kind : 'change',
    scores: Object.fromEntries(COMPONENTS.map((k) => [k, { score: clamp(raw.scores?.[k]?.score), why: String(raw.scores?.[k]?.why || '') }])),
    touches: { units, contracts, requirements, paths: paths.slice(0, 6) }, newUnits, conflicts, summary: String(raw.summary || ''), dropped,
  }
}

// → { title, kind, scores, ars, touches, newUnits, conflicts, summary, dropped, scope, scopeWhy, scopes, cost }
export async function estimate({ root, request, line, requests = [], known, lang = 'ko' }) {
  const { raw, cost } = await ask({ root, request, lineText: lineText(line, requests), lang })
  const exists = (p) => (path.isAbsolute(p) || p.split(/[\\/]/).includes('..') ? false : fs.stat(path.join(root, p)).then(() => true, () => false))
  const est = await verify(raw, { ...known, lineKeys: (line?.bolts || []).map((b) => b.key), paths: exists })
  est.ars = await ars(root, Object.fromEntries(COMPONENTS.map((k) => [k, est.scores[k].score])))
  est.scopes = await scopes(root)
  const s = suggestScope(est, est.scopes)
  return { ...est, scope: s.scope, scopeWhy: s.why, cost }
}
