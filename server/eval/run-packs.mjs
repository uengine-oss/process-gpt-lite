// Evaluates the three model decisions that replaced the word rules of the business-pack work
// (spec-packs.md): A) which pack skills a mail's drafts use (lib/mail.js triage → draftItems), B) whether a
// request about a picture edits the picture itself (routes/officePicture.js), C) which review kind a share
// asks for (lib/mining/recorder.js judgeReview). The same code the server runs, against the real model.
//   node server/eval/run-packs.mjs [--task mail|picture|review] [--set dev|holdout|both] [--repeat 3] [--quiet]
// --quiet prints scores and per-category counts only (no item text, no item ids): for the holdout set,
// whose items the person improving the skill descriptions does not read (design 7.5).
// Writes server/eval/results/packs-<task>-<set>.json (scores only when --quiet).
process.env.DOTENV_CONFIG_QUIET = 'true'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const QUIET = process.argv.includes('--quiet')
const TASKS = arg('--task', 'mail,picture,review').split(',')
const SETS = arg('--set', 'both') === 'both' ? ['dev', 'holdout'] : [arg('--set')]
const REPEAT = Number(arg('--repeat', 1))
const LIMIT = Number(arg('--limit', 0))
const OFFSET = Number(arg('--offset', 0))
const TAG = arg('--tag', '')

const { config } = await import('../config.js')
await import('../lib/systems.js')
const { withLang } = await import('../lib/lang.js')
const { setEnabledPacks } = await import('../lib/skillInstallCatalog.js')
const mail = await import('../lib/mail.js')
const { chatJson } = await import('../lib/llm.js')
const { pictureIntent } = await import('../routes/officePicture.js')
const { judgeReview } = await import('../lib/mining/recorder.js')
const { roleReviews } = await import('../lib/mining/catalog.js')
const { pool } = await import('../lib/supa.js')

const PACK_SKILLS = ['cadcraft-floor-plan', 'store-design-proposal', 'quote-xlsx']
// a call that failed (network, gateway) is tried again twice; one that still fails is counted, never scored as an answer
let ERRORS = 0
async function tried(fn) {
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= 2) { ERRORS++; console.warn('[eval] call failed:', e.message); return { failed: true } }
      await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)))
    }
  }
}
const load = (task, set) => JSON.parse(fs.readFileSync(path.join(HERE, 'sets', `packs-${task}.${set}.json`), 'utf8'))
const by = (items, key) => items.reduce((o, x) => { const k = key(x); (o[k] ||= []).push(x); return o }, {})
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null)
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))

// ---------- A: mail drafts ----------
async function mailOnce(it, packOn) {
  setEnabledPacks(config.tenantId, packOn ? ['store-design'] : [])
  return withLang(it.mode === 'en' ? 'en' : 'ko', () => tried(async () => {
    const m = { id: 'm1', from: it.mail.from, subject: it.mail.subject, date: '2026-11-21', text: it.mail.text }
    const r = await chatJson(mail.triagePrompt(), mail.triageInput([m]))
    const d = (r.drafts || []).find((x) => x.mail_id === 'm1' && x.items?.length)
    const items = d ? mail.draftItems(d) : []
    return { documents: !!d, skills: items.filter((i) => i.skill).map((i) => i.skill.name).sort(), raw: d?.items?.map((i) => i.skill || '') || [] }
  }).then((r) => (r.failed ? { failed: true, documents: null, skills: [] } : r)))
}
function scoreMail(items, runs) {
  const per = Object.fromEntries(PACK_SKILLS.map((s) => [s, { tp: 0, fp: 0, fn: 0 }]))
  let exact = 0, docs = 0
  const cat = {}, lang = {}, misses = []
  items.forEach((it, i) => {
    const got = runs[0][i]
    const ok = got.documents === it.expect.documents && sameSet(got.skills, it.expect.skills)
    if (ok) exact++
    if (got.documents === it.expect.documents) docs++
    for (const s of PACK_SKILLS) {
      const e = it.expect.skills.includes(s), g = got.skills.includes(s)
      if (e && g) per[s].tp++; else if (g) per[s].fp++; else if (e) per[s].fn++
    }
    ;(cat[it.category] ||= { n: 0, ok: 0 }).n++; if (ok) cat[it.category].ok++
    const lg = it.axis?.lang || 'ko'; (lang[lg] ||= { n: 0, ok: 0 }).n++; if (ok) lang[lg].ok++
    if (!ok) misses.push({ id: it.id, expect: it.expect, got: { documents: got.documents, skills: got.skills } })
  })
  const f1 = Object.fromEntries(Object.entries(per).map(([s, c]) => { const p = c.tp / ((c.tp + c.fp) || 1), r = c.tp / ((c.tp + c.fn) || 1); return [s, { precision: pct(p * 100, 100), recall: pct(r * 100, 100), f1: pct((2 * p * r) / ((p + r) || 1) * 100, 100) }] }))
  const macro = pct(Object.values(f1).reduce((a, x) => a + x.f1, 0), Object.keys(f1).length * 100) * 100 / 100
  const flips = runs.length > 1 ? items.filter((_, i) => runs.some((r) => !sameSet(r[i].skills, runs[0][i].skills) || r[i].documents !== runs[0][i].documents)).length : null
  return { n: items.length, exact: pct(exact, items.length), documents: pct(docs, items.length), macro_f1: macro, per_skill: f1, by_category: cat, by_lang: lang, flips: flips == null ? null : pct(flips, items.length), misses }
}

// ---------- B: picture ----------
async function pictureOnce(it) { return withLang(it.mode === 'en' ? 'en' : 'ko', async () => { const r = await tried(() => pictureIntent(it.text, it.picture, { throws: true })); return r.failed ? 'failed' : r.edit }) }
function scoreLabels(items, runs, labels) {
  let ok = 0
  const conf = {}, cat = {}, lang = {}, misses = []
  items.forEach((it, i) => {
    const got = runs[0][i]
    const hit = got === it.expect
    if (hit) ok++
    ;(conf[it.expect] ||= {})[got] = (conf[it.expect][got] || 0) + 1
    ;(cat[it.category] ||= { n: 0, ok: 0 }).n++; if (hit) cat[it.category].ok++
    const lg = it.axis?.lang || 'ko'; (lang[lg] ||= { n: 0, ok: 0 }).n++; if (hit) lang[lg].ok++
    if (!hit) misses.push({ id: it.id, expect: it.expect, got })
  })
  const f1s = labels.map((l) => {
    const tp = items.filter((it, i) => it.expect === l && runs[0][i] === l).length
    const fp = items.filter((it, i) => it.expect !== l && runs[0][i] === l).length
    const fn = items.filter((it, i) => it.expect === l && runs[0][i] !== l).length
    const p = tp / ((tp + fp) || 1), r = tp / ((tp + fn) || 1)
    return [l, (2 * p * r) / ((p + r) || 1)]
  })
  const flips = runs.length > 1 ? items.filter((_, i) => runs.some((r) => r[i] !== runs[0][i])).length : null
  return { n: items.length, accuracy: pct(ok, items.length), macro_f1: pct(f1s.reduce((a, [, f]) => a + f, 0) * 100, f1s.length * 100) * 100 / 100, per_label_f1: Object.fromEntries(f1s.map(([l, f]) => [l, pct(f * 100, 100)])), confusion: conf, by_category: cat, by_lang: lang, flips: flips == null ? null : pct(flips, items.length), misses }
}

// ---------- C: review ----------
async function reviewOnce(it) {
  setEnabledPacks(config.tenantId, ['store-design'])
  const l = it.mode === 'en' ? 'en' : 'ko'
  return withLang(l, async () => { const r = await tried(async () => ({ k: await judgeReview(roleReviews(l), it.roles || [], it.note || '', l, { throws: true }) })); return r.failed ? 'failed' : r.k?.key || 'none' })
}

const out = {}
try {
  for (const task of TASKS) {
    for (const set of SETS) {
      const all = load(task, set)
      const items = LIMIT ? all.slice(OFFSET, OFFSET + LIMIT) : all.slice(OFFSET)
      // the model must answer before a set is scored (a gateway outage would score as wrong answers)
      await chatJson('Answer JSON {"ok":true}', 'ping', { model: config.llm.fastModel, temperature: 0 })
      ERRORS = 0
      const runs = []
      const control = []
      for (let k = 0; k < REPEAT; k++) {
        const run = []
        for (const it of items) run.push(task === 'mail' ? await mailOnce(it, true) : task === 'picture' ? await pictureOnce(it) : await reviewOnce(it))
        runs.push(run)
      }
      let score = task === 'mail' ? scoreMail(items, runs) : task === 'picture' ? scoreLabels(items, runs, ['image', 'document']) : scoreLabels(items, runs, ['finance', 'design', 'contract', 'proposal_review', 'none'])
      if (task === 'mail') {
        // the same mails in a company without the pack: never a pack skill; documents still found
        for (const it of items) control.push(await mailOnce(it, false))
        score.without_pack = { pack_skill_picked: control.filter((c) => c.skills.length).length, documents: pct(control.filter((c, i) => c.documents === items[i].expect.documents).length, items.length) }
      }
      score.failed_calls = ERRORS
      if (QUIET) { delete score.misses }
      out[`${task}.${set}`] = score
      fs.mkdirSync(path.join(HERE, 'results'), { recursive: true })
      fs.writeFileSync(path.join(HERE, 'results', `packs-${task}-${set}${TAG ? `-${TAG}` : ''}.json`), JSON.stringify(score, null, 1))
      // the raw answers too (merge.mjs adds parts of one set together)
      fs.writeFileSync(path.join(HERE, 'results', `packs-${task}-${set}${TAG ? `-${TAG}` : ''}.runs.json`), JSON.stringify({ ids: items.map((x) => x.id), runs, control }, null, 0))
      const head = task === 'mail' ? `exact ${score.exact}% · documents ${score.documents}% · macro F1 ${score.macro_f1}` : `accuracy ${score.accuracy}% · macro F1 ${score.macro_f1}`
      console.log(`${task}.${set} n=${score.n} failed calls ${score.failed_calls} · ${head}${score.flips != null ? ` · flips ${score.flips}%` : ''}${score.without_pack ? ` · without pack: pack skills ${score.without_pack.pack_skill_picked}, documents ${score.without_pack.documents}%` : ''}`)
    }
    if (out[`${task}.dev`] && out[`${task}.holdout`]) {
      const k = task === 'mail' ? 'exact' : 'accuracy'
      console.log(`${task}: dev–holdout gap ${Math.round((out[`${task}.dev`][k] - out[`${task}.holdout`][k]) * 10) / 10} points`)
    }
  }
} finally { await pool.end() }
