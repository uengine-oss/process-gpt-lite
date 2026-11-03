// 가드레일이 글을 읽는 품질을 잰다(spec pgpt-pro_guardrail-reading). 실제 코드(readContext, readConfidential)를 실제 모델로 돌리고, 같은 글에 다른 구성도 견준다.
// 쓰임: node scripts/eval-guard.mjs <context|mail> <dev|test|all> [결과.json]
//   사례는 test/guard-eval/*.json. dev 는 질문 문구를 다듬을 때, test 는 문구를 고정한 뒤 결과를 재는 데만 쓴다(갈림은 id 해시라 언제나 같다).
import crypto from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { oddsOf, readingStatus } from '../lib/decide.js'
import { compileTopics, topicHit, formatHit, contextText, readContext, readingState, sensitiveOptions, SENSITIVE_QUESTION, NAME_QUESTION, READING } from '../lib/context/sensitive.js'
import { CONFIDENTIAL_OPTIONS, CONFIDENTIAL_QUESTION, CONFIDENTIAL_READING, mailExcerpt, readConfidential } from '../lib/scenarios/mail.js'

const [set = 'context', split = 'dev', out] = process.argv.slice(2)
const load = (f) => JSON.parse(readFileSync(new URL(`../test/guard-eval/${f}`, import.meta.url)))
const splitOf = (id) => (crypto.createHash('sha1').update(String(id)).digest()[0] % 2 ? 'test' : 'dev')
const pick = (rows) => rows.filter((r) => split === 'all' || splitOf(r.id) === split)
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-')
function score(rows, f) {
  const c = { tp: 0, fn: 0, fp: 0, tn: 0 }
  for (const r of rows) { const v = f(r); if (r.label) c[v ? 'tp' : 'fn']++; else c[v ? 'fp' : 'tn']++ }
  return { ...c, recall: pct(c.tp, c.tp + c.fn), fp_rate: pct(c.fp, c.fp + c.tn), accuracy: pct(c.tp + c.tn, rows.length) }
}
const line = (name, s) => console.log(`${name.padEnd(30)} 잡음 ${s.tp}/${s.tp + s.fn} (${s.recall})  오탐 ${s.fp}/${s.fp + s.tn} (${s.fp_rate})  정확도 ${s.accuracy}`)
const sweep = (rows) => { for (const t of [0.1, 0.2, 0.3, 0.5, 0.7, 0.9]) line(`  확률 ${t} 기준`, score(rows, (r) => r.p >= t)) }
const report = { set, split, at: new Date().toISOString(), rows: [], scores: {} }

if (set === 'context') {
  const rules = compileTopics()
  const rows = pick(load('context-cases.json'))
  for (const c of rows) {
    const raw = await oddsOf(readingState(c), SENSITIVE_QUESTION, sensitiveOptions(rules))
    if (!raw) throw new Error(`모델이 답하지 않음: ${JSON.stringify(readingStatus())}`)
    // 실제 코드로 판단(주제 이름 묻기는 빼고 — 이 평가는 판별만 잰다)
    const ask = async (s, q) => (q === NAME_QUESTION ? null : raw)
    const r = await readContext(c, { rules, ask })
    report.rows.push({ id: c.id, bucket: c.bucket, lang: c.lang, label: c.label, short: !c.purpose && !c.summary, p: raw.probabilities.sensitive, format: !!formatHit(contextText(c)), word: !!topicHit(rules, c.title, c.purpose, c.summary), hit: !!r.topic, source: r.source, text: contextText(c).slice(0, 80) })
  }
  const all = report.rows, scored = all.filter((r) => r.bucket !== 'ambiguous')
  const cfg = { '구현(주민번호 → 모델)': (r) => r.hit, '낱말만(전)': (r) => r.word || r.format, '낱말 먼저 → 모델': (r) => r.word || r.format || r.p >= READING.bar, '형식 셋 먼저 → 모델': (r) => r.format || r.p >= READING.bar, '모델만': (r) => r.p >= READING.bar }
  console.log(`## 맥락 ${split} ${scored.length}건(모호 ${all.length - scored.length}건 제외, 민감 ${scored.filter((r) => r.label).length} · 일반 ${scored.filter((r) => !r.label).length})`)
  for (const [k, f] of Object.entries(cfg)) { report.scores[k] = score(scored, f); line(k, report.scores[k]) }
  console.log('## 묶음별(구현)')
  for (const b of [...new Set(all.map((r) => r.bucket))]) { const x = all.filter((r) => r.bucket === b); report.scores[`bucket:${b}`] = score(x, (r) => r.hit); line(b, report.scores[`bucket:${b}`]) }
  for (const [k, x] of [['제목만', scored.filter((r) => r.short)], ['목적·요약 있음', scored.filter((r) => !r.short)], ['영어', scored.filter((r) => r.lang === 'en')], ['한국어', scored.filter((r) => r.lang !== 'en')]]) { report.scores[`group:${k}`] = score(x, (r) => r.hit); line(k, report.scores[`group:${k}`]) }
  console.log('## 기준 바꿔 보기(형식 빼고 모델만)'); sweep(scored)
  const wrong = all.filter((r) => r.label !== (r.hit ? 1 : 0))
  console.log(`## 틀린 사례 ${wrong.length}건`)
  for (const r of wrong) console.log(`${r.label ? '놓침' : '오탐'} ${r.bucket} ${r.source} p=${r.p.toFixed(3)} ${r.text.replace(/\n/g, ' / ')}`)
}
if (set === 'mail') {
  const rows = pick(load('mail-cases.json'))
  const WORD = /기밀|대외비|confidential/i
  for (const c of rows) {
    const raw = await oddsOf(mailExcerpt(c), CONFIDENTIAL_QUESTION, CONFIDENTIAL_OPTIONS)
    if (!raw) throw new Error(`모델이 답하지 않음: ${JSON.stringify(readingStatus())}`)
    const r = await readConfidential(c, { ask: async () => raw })
    report.rows.push({ id: c.id, bucket: c.bucket, label: c.label, p: raw.probabilities.confidential, hit: r.confidential, word: (c.attachments || []).some((x) => WORD.test(x.name) || WORD.test(x.text || '')), text: `${c.subject} / ${(c.attachments || []).map((a) => a.name).join(', ')}`.slice(0, 80) })
  }
  const all = report.rows
  console.log(`## 메일 ${split} ${all.length}건(기밀 ${all.filter((r) => r.label).length} · 일반 ${all.filter((r) => !r.label).length})`)
  for (const [k, f] of Object.entries({ '구현(모델)': (r) => r.hit, '표시 낱말만(전)': (r) => r.word, '낱말 먼저 → 모델': (r) => r.word || r.hit })) { report.scores[k] = score(all, f); line(k, report.scores[k]) }
  for (const b of [...new Set(all.map((r) => r.bucket))]) { const x = all.filter((r) => r.bucket === b); report.scores[`bucket:${b}`] = score(x, (r) => r.hit); line(b, report.scores[`bucket:${b}`]) }
  console.log('## 기준 바꿔 보기'); sweep(all)
  const wrong = all.filter((r) => r.label !== (r.hit ? 1 : 0))
  console.log(`## 틀린 사례 ${wrong.length}건`)
  for (const r of wrong) console.log(`${r.label ? '놓침' : '오탐'} ${r.bucket} p=${r.p.toFixed(3)} ${r.text}`)
}
if (out) writeFileSync(out, JSON.stringify(report, null, 1))
process.exit(0)
