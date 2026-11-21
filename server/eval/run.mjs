// Runs an evaluation set through a router with the real model (config.llm.fastModel = PRO_LLM_FAST_MODEL)
// and writes one result line per item and run.
//   cd server && node eval/run.mjs --impl new --set dev [--runs 3] [--conc 6] [--limit 50] [--only dev-0001,dev-0002]
//   --impl new     the skill router (lib/skills/router.js decide)
//   --impl legacy  the old routing of main 84bd318 (eval/legacy.mjs)
// The result file is printed at the end; eval/score.mjs reads it.
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { withLang } from '../lib/lang.js'
import { decide } from '../lib/skills/router.js'
import { loadSkills } from '../lib/skills/registry.js'
import { readSet, stateOf } from './check-sets.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const impl = arg('impl', 'new')
const set = arg('set', 'dev')
const runs = Number(arg('runs', 1))
const conc = Number(arg('conc', 6))
const limit = Number(arg('limit', 0))
const only = arg('only', '') ? new Set(arg('only').split(',')) : null
const out = arg('out', path.join(HERE, 'results', `${impl}-${set}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`))

// the model's token counts, per item (the gateway's usage field)
const meter = new AsyncLocalStorage()
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  const res = await realFetch(url, opts)
  const m = meter.getStore()
  if (m && String(url).endsWith('/chat/completions') && res.ok) {
    m.calls += 1
    res.clone().json().then((j) => { m.in += j.usage?.prompt_tokens || 0; m.out += j.usage?.completion_tokens || 0 }).catch(() => {})
  }
  return res
}

// the facts a state gives the router (lib/skills/facts.js gatherFacts shape)
function factsOf(state) {
  return {
    schedules: state.schedules, recentSchedules: state.recentSchedules || [], telegram: state.telegram, apps: state.apps,
    folders: state.folders, attachedFolder: state.attachedFolder, processes: state.processes, improvable: state.improvable,
    team: state.team, agentSkills: state.agentSkills, mySkills: state.mySkills, files: state.files || [], openDoc: state.openDoc,
    generation: state.generation, noFolder: !!state.noFolder,
  }
}
// the conversation the router reads (lib/agent.js toLlmHistory: text messages only, no chips)
function messagesOf(state, item, { legacy = false } = {}) {
  const rows = [...(state.history || []), ...(item.history || [])].filter((r) => !r.kind || r.kind === 'text')
  const files = state.files || []
  // the old turn added "(첨부: …)" to the message for the router (agent.js:216 of main)
  const last = legacy && files.length ? `${item.text}\n\n(첨부: ${files.map((f) => f.name).join(', ')})` : item.text
  return [...rows.map((r) => ({ role: r.role === 'user' ? 'user' : 'assistant', content: r.text })), { role: 'user', content: last }]
}

const skills = loadSkills()
const legacy = impl === 'legacy' ? (await import('./legacy.mjs')).legacyDecide : null
const files = set === 'both' ? ['dev', 'holdout'] : [set]
let items = files.flatMap((s) => readSet(path.join(HERE, 'sets', `${s}.jsonl`)).map((it) => ({ ...it, _set: s })))
if (only) items = items.filter((it) => only.has(it.id))
if (limit) items = items.slice(0, limit)
const jobs = []
for (let r = 0; r < runs; r++) for (const it of items) jobs.push({ it, r })

fs.mkdirSync(path.dirname(out), { recursive: true })
const w = fs.createWriteStream(out)
let done = 0
async function one({ it, r }) {
  const state = stateOf(it.state)
  const facts = factsOf(state)
  const m = { calls: 0, in: 0, out: 0 }
  const t0 = Date.now()
  let ackAt = null
  const rec = { id: it.id, set: it._set, run: r, impl }
  try {
    // a network failure is not a decision: the item is tried again (an error's code, not its wording)
    let d
    for (let attempt = 0; ; attempt++) {
      try {
        d = await meter.run(m, () => withLang(it.mode === 'en' ? 'en' : 'ko', () => (legacy
          ? legacy({ text: it.text, messages: messagesOf(state, it, { legacy: true }), facts })
          : decide({ messages: messagesOf(state, it), facts, skills, onAck: () => { ackAt = Date.now() - t0 } }))))
        break
      } catch (e) {
        if (attempt >= 4 || !/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|LLM 5\d\d/.test(`${e.message} ${e.cause?.code || ''}`)) throw e
        await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)))
      }
    }
    const total = Date.now() - t0
    Object.assign(rec, { route: d.route === 'skill' ? d.skill : d.route, args: d.args || {}, via: d.via, delegate_skill: d.route === 'delegate' ? d.skill || null : undefined,
      first_ms: ackAt ?? d.timings?.stage1 ?? total, total_ms: total, stage2: !!d.stage2, calls: m.calls })
  } catch (e) {
    Object.assign(rec, { route: 'error', error: String(e.message).slice(0, 200), total_ms: Date.now() - t0 })
  }
  await new Promise((res) => setTimeout(res, 50)) // the usage of the last call is read asynchronously
  rec.tokens = { in: m.in, out: m.out }
  w.write(JSON.stringify(rec) + '\n')
  done += 1
  if (done % 25 === 0) console.log(`${done}/${jobs.length}`)
}
const queue = [...jobs]
await Promise.all(Array.from({ length: conc }, async () => { while (queue.length) await one(queue.shift()) }))
await new Promise((res) => w.end(res))
console.log(out)
process.exit(0)
