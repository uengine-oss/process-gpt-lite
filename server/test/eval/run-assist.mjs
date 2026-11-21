// Team assist and meeting helper against the evaluation sets (skill-routing-design §7, decision 2): the
// same code the room feed and the meeting run (team/assist.js classify, meetings/intent.js detect) with
// the judge LLM of server/.env, no database writes. The sets were written from the feature spec by
// someone who did not write the offer skills; dev is for improving the descriptions, holdout is looked
// at only as scores (never item by item when changing a description).
//   node test/eval/run-assist.mjs --set dev|holdout [--only team|meeting] [--repeat 3] [--out file.json]
// Reports: request recall, false offers on "none" items, work / process / material accuracy, by language,
// latency per message (p50/p95), model tokens per message and an estimated cost.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const SET = opt('--set', 'dev'), ONLY = opt('--only', null), REPEAT = Number(opt('--repeat', 1)), OUT = opt('--out', null), CONC = Number(opt('--concurrency', 6))
process.env.SERVICE_ROLE_KEY ||= 'unit-test'
process.env.PRO_JUDGE_URL ??= '' // no judge server in development: the LLM judges (production has none either)

// model tokens per call, read from the answers (lib/llm.js keeps only the message)
const usage = { calls: 0, prompt: 0, completion: 0 }
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const r = await realFetch(url, init)
  if (String(url).endsWith('/chat/completions') && r.ok) {
    const j = await r.clone().json().catch(() => null)
    if (j?.usage) { usage.calls++; usage.prompt += j.usage.prompt_tokens || 0; usage.completion += j.usage.completion_tokens || 0 }
  }
  return r
}
const { withLang } = await import('../../lib/lang.js')
const A = await import('../../lib/team/assist.js')
const I = await import('../../lib/meetings/intent.js')
const { offers } = await import('../../lib/offers.js')
const { config } = await import('../../config.js')
const WORK = { spreadsheet: 'CreateSpreadsheet', document: 'CreateDocument', summary: 'SummarizeChat', schedule: 'ScheduleRegistration', lookup: 'CompanyQuery', reply: 'DraftReply', start_process: 'StartProcessInstance', new_process: 'CreateProcessDefinition' }
const langOfItem = (it) => (it.lang === 'en' ? 'en' : 'ko') // the card's language: English for English writers, else Korean
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }
// an item whose model call failed (timeout, network) is tried once more at the end: a failure of the
// shared gateway is not a decision; what still fails is reported as an error
async function pool(items, fn) {
  const out = new Array(items.length)
  let i = 0
  const one = (k) => fn(items[k]).catch((e) => ({ id: items[k].id, error: e.message }))
  await Promise.all(Array.from({ length: CONC }, async () => { while (i < items.length) { const k = i++; out[k] = await one(k) } }))
  for (let k = 0; k < out.length; k++) if (out[k]?.error) out[k] = { ...(await one(k)), retried: true }
  return out
}

async function team(items) {
  return pool(items, async (it) => withLang(langOfItem(it), async () => {
    const procs = (it.processes || []).map((name) => ({ id: name, name }))
    const list = offers('team').filter((o) => o.key !== 'StartProcessInstance' || procs.length)
    const u0 = { ...usage }, t0 = Date.now()
    const r = await A.classify([...(it.context || []), `${it.author}: ${it.text}`], it.text, { offers: list, processes: async () => procs })
    const got = r.none ? 'none' : r.work
    const want = it.expect === 'none' ? 'none' : WORK[it.expect]
    return { id: it.id, lang: it.lang, axis: it.axis, expect: it.expect, want, got, why: r.why, p: r.p, title: r.title, proc: r.proc?.name || null, wantProc: it.process,
      ms: Date.now() - t0, calls: usage.calls - u0.calls, prompt: usage.prompt - u0.prompt, completion: usage.completion - u0.completion }
  }))
}
async function meeting(items) {
  return pool(items, async (it) => withLang(langOfItem(it), async () => {
    const candidates = it.candidates.map((c, i) => ({ kind: c.kind, id: `c${i}`, title: c.title, folderFile: c.kind === 'folder' }))
    const speaker = it.speaker
    const prev = (it.prev || []).map((l) => { const k = l.indexOf(': '); return { speaker: l.slice(0, k), text: l.slice(k + 2) } })
    const u0 = { ...usage }, t0 = Date.now()
    const r = await I.detect({ speaker, text: it.text }, { roomId: 'eval', speaker: { id: 'eval', name: speaker }, prev, shown: new Set(), lastMinute: 0, candidates })
    const got = !r ? 'none' : r.request ? 'request' : 'material'
    return { id: it.id, lang: it.lang, axis: it.axis, expect: it.expect, got, work: r?.request?.work || null, wantWork: it.work ? WORK[it.work] : null,
      pick: r?.material?.title || null, notFound: !!r?.notFound, wantPick: it.pick, open: r?.material ? !!r.open : null, wantOpen: it.open, addressed: r?.addressed ?? null, wantAddressed: it.addressed,
      ms: Date.now() - t0, calls: usage.calls - u0.calls, prompt: usage.prompt - u0.prompt, completion: usage.completion - u0.completion }
  }))
}

// what a run says: recall of requests, false offers on none, accuracies, by language; latency and tokens
function scoreTeam(rows) {
  const ok = rows.filter((r) => !r.error)
  const req = ok.filter((r) => r.want !== 'none'), none = ok.filter((r) => r.want === 'none')
  const hit = req.filter((r) => r.got !== 'none')
  const byLang = {}
  for (const r of ok) { const b = (byLang[r.lang] ||= { n: 0, req: 0, hit: 0, none: 0, false: 0 }); b.n++; if (r.want === 'none') { b.none++; if (r.got !== 'none') b.false++ } else { b.req++; if (r.got !== 'none') b.hit++ } }
  const procItems = req.filter((r) => r.expect === 'start_process')
  return {
    n: rows.length, errors: rows.filter((r) => r.error).length,
    recall: req.length ? hit.length / req.length : null, falseOffer: none.length ? none.filter((r) => r.got !== 'none').length / none.length : null,
    workAccuracy: hit.length ? hit.filter((r) => r.got === r.want).length / hit.length : null,
    processAccuracy: procItems.length ? procItems.filter((r) => r.proc === r.wantProc).length / procItems.length : null,
    byLang: Object.fromEntries(Object.entries(byLang).map(([k, b]) => [k, { n: b.n, recall: b.req ? +(b.hit / b.req).toFixed(3) : null, falseOffer: b.none ? +(b.false / b.none).toFixed(3) : null }])),
    ...cost(ok),
  }
}
function scoreMeeting(rows) {
  const ok = rows.filter((r) => !r.error)
  const req = ok.filter((r) => r.expect !== 'none'), none = ok.filter((r) => r.expect === 'none')
  const mats = ok.filter((r) => r.expect === 'material'), asks = ok.filter((r) => r.expect === 'request')
  const byLang = {}
  for (const r of ok) { const b = (byLang[r.lang] ||= { n: 0, req: 0, hit: 0, none: 0, false: 0 }); b.n++; if (r.expect === 'none') { b.none++; if (r.got !== 'none') b.false++ } else { b.req++; if (r.got !== 'none') b.hit++ } }
  return {
    n: rows.length, errors: rows.filter((r) => r.error).length,
    recall: req.length ? req.filter((r) => r.got !== 'none').length / req.length : null,
    falseOffer: none.length ? none.filter((r) => r.got !== 'none').length / none.length : null,
    kindAccuracy: req.length ? req.filter((r) => r.got === r.expect).length / req.length : null,
    pickAccuracy: mats.length ? mats.filter((r) => (r.wantPick ? r.pick === r.wantPick : r.notFound)).length / mats.length : null,
    openAccuracy: mats.filter((r) => r.pick).length ? mats.filter((r) => r.pick && r.open === r.wantOpen).length / mats.filter((r) => r.pick).length : null,
    workAccuracy: asks.filter((r) => r.got === 'request').length ? asks.filter((r) => r.got === 'request' && r.work === r.wantWork).length / asks.filter((r) => r.got === 'request').length : null,
    byLang: Object.fromEntries(Object.entries(byLang).map(([k, b]) => [k, { n: b.n, recall: b.req ? +(b.hit / b.req).toFixed(3) : null, falseOffer: b.none ? +(b.false / b.none).toFixed(3) : null }])),
    ...cost(ok),
  }
}
// cost per message at gpt-4.1-mini list prices ($0.40 / 1M input, $1.60 / 1M output) — the dev gateway's
// own model is self-hosted; the token counts are what carries over
// (tokens from the run's totals: items run side by side, so a per-item difference would mix them)
let partUsage = null
function cost(rows) {
  const { calls, prompt: p, completion: c } = partUsage
  const per = rows.length || 1
  return { msP50: pct(rows.map((r) => r.ms), 0.5), msP95: pct(rows.map((r) => r.ms), 0.95), callsPerMessage: +(calls / per).toFixed(2),
    promptTokensPerMessage: Math.round(p / per), completionTokensPerMessage: Math.round(c / per), usdPer1000Messages: +(((p * 0.4 + c * 1.6) / 1e6) * (1000 / per)).toFixed(3) }
}

const out = { set: SET, model: config.llm.fastModel, at: new Date().toISOString(), runs: [] }
for (let k = 0; k < REPEAT; k++) {
  const run = {}
  const part = async (name, fn, score) => {
    const items = JSON.parse(fs.readFileSync(path.join(here, `${name}.${SET}.json`), 'utf8'))
    const u0 = { ...usage }
    run[name] = await fn(items)
    partUsage = { calls: usage.calls - u0.calls, prompt: usage.prompt - u0.prompt, completion: usage.completion - u0.completion }
    run[`${name}Score`] = score(run[name])
  }
  if (!ONLY || ONLY === 'team') await part('team', team, scoreTeam)
  if (!ONLY || ONLY === 'meeting') await part('meeting', meeting, scoreMeeting)
  out.runs.push(run)
  const f = (x) => (x == null ? '-' : typeof x === 'number' && x <= 1 ? x.toFixed(3) : x)
  if (run.teamScore) { const s = run.teamScore; console.log(`[team ${SET} #${k + 1}] n=${s.n} err=${s.errors} recall=${f(s.recall)} falseOffer=${f(s.falseOffer)} work=${f(s.workAccuracy)} process=${f(s.processAccuracy)} p50=${s.msP50}ms p95=${s.msP95}ms calls/msg=${s.callsPerMessage} tokens/msg=${s.promptTokensPerMessage}+${s.completionTokensPerMessage} $/1k=${s.usdPer1000Messages}`); console.log('  byLang', JSON.stringify(s.byLang)) }
  if (run.meetingScore) { const s = run.meetingScore; console.log(`[meeting ${SET} #${k + 1}] n=${s.n} err=${s.errors} recall=${f(s.recall)} falseOffer=${f(s.falseOffer)} kind=${f(s.kindAccuracy)} pick=${f(s.pickAccuracy)} open=${f(s.openAccuracy)} work=${f(s.workAccuracy)} p50=${s.msP50}ms p95=${s.msP95}ms calls/msg=${s.callsPerMessage} tokens/msg=${s.promptTokensPerMessage}+${s.completionTokensPerMessage} $/1k=${s.usdPer1000Messages}`); console.log('  byLang', JSON.stringify(s.byLang)) }
}
// flips: the same item decided differently across repeats
if (REPEAT > 1) {
  for (const part of ['team', 'meeting']) {
    if (!out.runs[0][part]) continue
    const n = out.runs[0][part].length
    let flips = 0
    for (let i = 0; i < n; i++) if (new Set(out.runs.map((r) => r[part][i]?.got)).size > 1) flips++
    out[`${part}Flips`] = flips / n
    console.log(`[${part} ${SET}] flip rate over ${REPEAT} runs: ${(flips / n).toFixed(3)}`)
  }
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
process.exit(0)
