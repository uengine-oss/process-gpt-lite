// The check of design 7.5: a skill description edited to fix failures must not borrow the failing items'
// words. Reports, per action skill description and the router's own rules, which character 4-grams it
// shares with the development set's failing items (from a result file) that the functional spec
// (eval/spec.md) does not also have — words the description could only have taken from the items.
//   cd server && node eval/overlap.mjs results/new-dev-….jsonl
import fs from 'node:fs'
import path from 'node:path'
import { readSet } from './check-sets.mjs'
import { loadSkills } from '../lib/skills/registry.js'
import { scoreSet } from './score.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const grams = (t) => { const s = String(t || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); const out = new Set(); for (let i = 0; i + 4 <= s.length; i++) out.add(s.slice(i, i + 4)); return out }
const results = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.set === 'dev')
const items = readSet(path.join(HERE, 'sets', 'dev.jsonl'))
const fails = scoreSet(items, results)._fails
const failG = new Set(fails.flatMap((f) => [...grams(f.text)]))
const specG = grams(fs.readFileSync(path.join(HERE, 'spec.md'), 'utf8'))
const router = fs.readFileSync(path.join(HERE, '../lib/skills/router.js'), 'utf8')
const texts = [...loadSkills().map((s) => [s.name, `${s.description}\n${s.body}`]), ['router rules', router.slice(router.indexOf('const RULES'), router.indexOf('const ACK'))]]
let worst = 0
for (const [name, t] of texts) {
  const g = grams(t)
  const borrowed = [...g].filter((x) => failG.has(x) && !specG.has(x))
  const share = borrowed.length / Math.max(1, g.size)
  worst = Math.max(worst, share)
  console.log(`${name}: ${borrowed.length}/${g.size} (${(share * 100).toFixed(1)}%)${borrowed.length ? ` — ${borrowed.slice(0, 30).join(' ')}` : ''}`)
}
console.log(`failing items: ${fails.length}; largest share ${(worst * 100).toFixed(1)}%`)
