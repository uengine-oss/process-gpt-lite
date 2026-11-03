// 후행 습관의 판정 품질: test/followup-eval/*.json 사례를 지금 쓰는 모델로 읽어 표로 낸다. 문구는 dev 로만 고치고 기준은 test 전에 정한다.
//   node scripts/eval-followups.mjs <followup|same_action|fits|answer|explicit|all> <dev|test|all> [out.json]
import crypto from 'node:crypto'
import fs from 'node:fs'
import { oddsOf } from '../lib/decide.js'
import * as F from '../lib/followups.js'

const args = process.argv.slice(2)
const CHECK = args.includes('--check')
const [which = 'all', split = 'dev', out] = args.filter((a) => a !== '--check')
const FLOOR = { followup: 0.85, same_action: 0.8, fits: 0.75, answer: 0.8, explicit: 0.8, explicit_event: 0.8 }
const below = []
const load = (n) => JSON.parse(fs.readFileSync(new URL(`../test/followup-eval/${n}.json`, import.meta.url)))
const inSplit = (c) => split === 'all' || (crypto.createHash('sha1').update(c.id).digest()[0] % 2 === 0 ? 'dev' : 'test') === split
const read = (state, q, o) => oddsOf(state, q, o, { timeoutMs: 20000 })
// each set: the model's probability that the label `pos` holds
const SETS = {
  followup: { pos: 'followup', read: async (c) => (await read(F.followupState({ request: c.prev_request, files: c.prev_files }, c.text), F.FOLLOWUP_QUESTION(), F.FOLLOWUP_OPTIONS()))?.probabilities.followup },
  same_action: { pos: 'same', read: async (c) => (await read(F.sameState(c.a), F.SAME_QUESTION(), F.sameOptions([c.b])))?.probabilities.h0 },
  fits: { pos: 'fits', read: async (c) => {
    const cls = Object.keys(F.CLASSES).find((k) => c.habit_event.includes(F.CLASSES[k].ko)) || 'slides'
    return (await read(F.fitsState(cls, c.habit_action, c.request, c.files), F.FITS_QUESTION(), F.FITS_OPTIONS()))?.probabilities.fits
  } },
  answer: { multi: true, read: async (c) => (await read(F.answerState(c.question, c.text), F.ANSWER_QUESTION(), F.ANSWER_OPTIONS()))?.probabilities },
  explicit: { pos: 'rule', read: async (c) => (F.maybeRule(c.text) ? (await read(F.ruleState(c.text), F.RULE_QUESTION(), F.RULE_OPTIONS()))?.probabilities.rule : 0) },
}
async function pool(items, fn, n = 4) {
  const res = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]) } }))
  return res
}
const pct = (x) => (x * 100).toFixed(0).padStart(3) + '%'
const results = {}
for (const name of which === 'all' ? Object.keys(SETS) : [which]) {
  const S = SETS[name]
  const cases = load(name).filter(inSplit)
  const vals = await pool(cases, (c) => S.read(c).catch(() => null))
  const unread = vals.filter((v) => v == null).length
  if (S.multi) {
    const rows = cases.map((c, i) => ({ id: c.id, label: c.label, p: vals[i], text: c.text }))
    const pick = (p, bar) => { if (!p) return 'other'; const [k, v] = Object.entries(p).sort((a, b) => b[1] - a[1])[0]; return v >= bar ? k : 'other' }
    const ok = rows.filter((r) => pick(r.p, 0.5) === r.label).length
    console.log(`\n${name} (${split}) ${rows.length}건, 못 읽음 ${unread} · 정확도 ${pct(ok / rows.length)}`)
    if (ok / rows.length < FLOOR[name]) below.push(`${name} ${pct(ok / rows.length)} < ${pct(FLOOR[name])}`)
    for (const r of rows) if (pick(r.p, 0.5) !== r.label) console.log(`  틀림 ${r.id} 정답 ${r.label} 읽음 ${pick(r.p, 0.5)} ${JSON.stringify(r.p && Object.fromEntries(Object.entries(r.p).map(([k, v]) => [k, +v.toFixed(2)])))} ${r.text}`)
    results[name] = rows
    continue
  }
  const rows = cases.map((c, i) => ({ id: c.id, label: c.label, p: vals[i], text: c.text || c.request || c.a, b: c.b, action: c.habit_action }))
  console.log(`\n${name} (${split}) ${rows.length}건, 못 읽음 ${unread}`)
  const BAR = { followup: F.HABIT.learnBar, same_action: F.HABIT.sameBar, fits: F.HABIT.fitsBar, explicit: F.HABIT.bar }[name]
  {
    const ok = rows.filter((r) => ((r.p ?? 0) >= BAR) === (r.label === S.pos)).length
    console.log(`  쓰는 기준 ${BAR}: 정확도 ${pct(ok / (rows.length || 1))}`)
    if (ok / (rows.length || 1) < FLOOR[name]) below.push(`${name} ${pct(ok / rows.length)} < ${pct(FLOOR[name])}`)
  }
  for (const bar of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const pos = rows.filter((r) => r.label === S.pos), neg = rows.filter((r) => r.label !== S.pos)
    const tp = pos.filter((r) => (r.p ?? 0) >= bar).length, fp = neg.filter((r) => (r.p ?? 0) >= bar).length
    console.log(`  기준 ${bar}: 잡음 ${tp}/${pos.length}(${pct(tp / (pos.length || 1))}) · 잘못 잡음 ${fp}/${neg.length}(${pct(fp / (neg.length || 1))}) · 정확도 ${pct((tp + neg.length - fp) / (rows.length || 1))}`)
  }
  if (name === 'explicit') {
    const KO = Object.fromEntries(Object.entries(F.CLASSES).map(([k, v]) => [k, v.ko]))
    const rules = cases.filter((c) => c.label === 'rule')
    const parts = await pool(rules, (c) => F.ruleParts(c.text).catch(() => null))
    const good = rules.filter((c, i) => KO[parts[i]?.event] === c.event).length
    console.log(`  결과물 종류를 맞게 꺼냄 ${good}/${rules.length}`)
    rules.forEach((c, i) => { if (KO[parts[i]?.event] !== c.event) console.log(`  틀림 ${c.id} 정답 ${c.event} 꺼냄 ${parts[i]?.event} ${c.text}`) })
    if (good / (rules.length || 1) < FLOOR.explicit_event) below.push(`explicit_event ${good}/${rules.length}`)
    console.log(`  꺼낸 말 예: ${rules.slice(0, 3).map((c, i) => `${c.text} → ${parts[i]?.action}`).join(' | ')}`)
  }
  for (const r of rows) if (((r.p ?? 0) >= BAR) !== (r.label === S.pos)) console.log(`  틀림 ${r.id} 정답 ${r.label} p=${r.p == null ? '-' : r.p.toFixed(2)} ${r.text}${r.b ? ` / ${r.b}` : ''}${r.action ? ` ← ${r.action}` : ''}`)
  results[name] = rows
}
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1))
if (CHECK && below.length) { console.log(`\n하한 미달: ${below.join(', ')}`); process.exit(1) }
if (CHECK) console.log('\n하한 통과')
process.exit(0)
