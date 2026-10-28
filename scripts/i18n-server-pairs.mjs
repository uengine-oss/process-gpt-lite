// The server writes its own English next to the Korean: L('한국어', 'English') (server/lib/lang.js).
// This copies every such pair into the web dictionary (src/i18n/ko-en.json) so the screen shows the
// server's English even when the Korean arrives anyway — a row stored before the switch, a server
// that runs older code — and the screens and the server use the same words.
//   ${…} parts become {0}, {1}… (the same expression → the same number in both languages);
//   a leading "1. " step number is also added without it (screens show the number apart).
// The server's English wins over an existing entry for the same Korean, except where the web app
// shows that Korean too (a button "저장" is "Save", the server's status "저장" may be "Saving"):
// i18n/strings.json (scripts/i18n-extract.py) tells which Korean the web app has. Run after server changes:
//   node scripts/i18n-server-pairs.mjs [--dry-run]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'package.json'))
const babel = require('@babel/parser')
const DICT = process.env.I18N_DICT || path.join(ROOT, 'src/i18n/ko-en.json')
const HANGUL = /[가-힣]/

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : files(p)
    return /\.(js|mjs)$/.test(e.name) ? [p] : []
  })
}

// a string or template literal as text with {n} slots; slots keyed by the expression's source
function text(node, src, slots) {
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral') {
    let s = ''
    node.quasis.forEach((q, i) => {
      s += q.value.cooked ?? q.value.raw
      if (i < node.expressions.length) {
        const e = node.expressions[i]
        const key = src.slice(e.start, e.end)
        if (!slots.has(key)) slots.set(key, slots.size)
        s += `{${slots.get(key)}}`
      }
    })
    return s
  }
  return null
}

const pairs = []
for (const f of [path.join(ROOT, 'server/index.js'), ...files(path.join(ROOT, 'server/lib')), ...files(path.join(ROOT, 'server/routes'))]) {
  const src = fs.readFileSync(f, 'utf8')
  if (!src.includes('L(')) continue
  let ast
  try { ast = babel.parse(src, { sourceType: 'module', errorRecovery: true, plugins: ['topLevelAwait'] }) } catch { continue }
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'L' && n.arguments.length >= 2) {
      const slots = new Map()
      const ko = text(n.arguments[0], src, slots)
      const before = slots.size
      const en = ko == null ? null : text(n.arguments[1], src, slots)
      // the English may not use a part the Korean does not have
      if (ko && en && HANGUL.test(ko) && slots.size === before) pairs.push([ko.trim(), en.trim(), `${path.relative(ROOT, f)}:${n.loc.start.line}`])
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue
      const v = n[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v.type === 'string') visit(v)
    }
  }
  visit(ast.program)
}

// also without a leading step number ("1. 찾기 — …" is shown as "찾기 — …" next to its number)
for (const [ko, en, at] of [...pairs]) {
  const k = ko.match(/^\d+\.\s+([\s\S]+)$/), e = en.match(/^\d+\.\s+([\s\S]+)$/)
  if (k && e) pairs.push([k[1], e[1], at])
}

const d = JSON.parse(fs.readFileSync(DICT, 'utf8'))
let web = new Set()
try {
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n/strings.json'), 'utf8'))
  web = new Set(st.strings.filter((e) => e.groups.includes('web')).map((e) => e.text))
} catch { /* no extraction yet: the server wins everywhere */ }
const pats = new Map(d.patterns)
let added = 0, changed = 0
for (const [ko, en] of pairs) {
  if (/\{\d+\}/.test(ko)) {
    if (pats.has(ko) && web.has(ko)) continue
    if (!pats.has(ko)) added++; else if (pats.get(ko) !== en) changed++
    pats.set(ko, en)
  } else {
    if (ko in d.exact && web.has(ko)) continue
    if (!(ko in d.exact)) added++; else if (d.exact[ko] !== en) changed++
    d.exact[ko] = en
  }
}
d.patterns = [...pats]
console.log(`${pairs.length} L(ko, en) pairs from server/: ${added} added, ${changed} changed`)
if (!process.argv.includes('--dry-run')) {
  const tmp = DICT + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1))
  fs.renameSync(tmp, DICT)
}
