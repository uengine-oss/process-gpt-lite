#!/usr/bin/env node
// Keeps natural-language rules out of the code (2026-11-21, docs: skill-routing-design §6 P7).
// What a person, an agent answer, a notice title or an error message *means* is decided by a model that
// read skill descriptions, or by a structured field — never by a regular expression, a keyword list or a
// word dictionary in the code. Format parsing (URLs, markdown, JSON, tokens, numbers, file extensions,
// character ranges, our own output contracts) stays, and every such expression that looks like words is
// listed, with its reason, in scripts/format-rules-allowlist.json.
//
//   node scripts/check-nl-rules.mjs            fails (exit 1) on an expression that is not on the list
//   node scripts/check-nl-rules.mjs --list     prints every candidate (to review or add to the list)
//
// A candidate is a regex literal, a `new RegExp('…')` string, or an `.includes('…')` / `===` / array of
// strings compared with what came in, whose text holds Hangul syllables, or a word alternation (a|b|c with
// three or more letter-only alternatives). Tests, e2e, i18n dictionaries, seeds and scripts are not scanned.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(ROOT, 'package.json'))
const babel = require('@babel/parser')
const sfc = require('@vue/compiler-sfc')

const SCAN = ['server/lib', 'server/routes', 'server/mcp', 'server/index.js', 'src']
const SKIP = [/\/test\//, /\.test\.js$/, /\/i18n\//, /\/scripts\//, /\/sql\//, /\/fixtures\//, /node_modules/, /\/eval\//]
const ALLOW_FILE = path.join(ROOT, 'scripts/format-rules-allowlist.json')

const HANGUL = /[가-힣]/
// "a|b|c" of letter-only words, three or more (character classes and escapes removed first)
function wordAlternation(src) {
  const bare = src.replace(/\\./g, ' ').replace(/\[[^\]]*\]/g, ' ')
  for (const group of bare.split(/[()]/)) {
    const parts = group.split('|').map((p) => p.replace(/[?:!=<>^$*+{}\d,\s]/g, ''))
    if (parts.filter((p) => /^[A-Za-z가-힣]{2,}$/.test(p)).length >= 3) return true
  }
  return false
}
const looksLikeWords = (text) => HANGUL.test(text.replace(/가-힣/g, '')) || wordAlternation(text)

function files(dir) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) return [dir]
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    if (SKIP.some((re) => re.test(`/${rel}`))) return []
    if (e.isDirectory()) return files(rel)
    return /\.(js|mjs|vue)$/.test(e.name) ? [rel] : []
  })
}

function scripts(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  if (!file.endsWith('.vue')) return [{ code: src, offset: 0 }]
  const { descriptor } = sfc.parse(src)
  return [descriptor.script, descriptor.scriptSetup].filter(Boolean).map((b) => ({ code: b.content, offset: src.slice(0, b.loc.start.offset).split('\n').length - 1 }))
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
  if (typeof node.type === 'string') visit(node)
  for (const k of Object.keys(node)) if (k !== 'loc' && k !== 'start' && k !== 'end' && k !== 'extra') walk(node[k], visit)
}

const id = (file, text) => `${file}#${crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)}`

export function candidates() {
  const out = []
  for (const file of SCAN.flatMap(files)) {
    for (const { code, offset } of scripts(file)) {
      let ast
      try { ast = babel.parse(code, { sourceType: 'module', errorRecovery: true, plugins: ['topLevelAwait'] }) } catch { continue }
      walk(ast, (n) => {
        let text = null, kind = null
        if (n.type === 'RegExpLiteral') { text = n.pattern; kind = 'regex' }
        else if (n.type === 'NewExpression' && n.callee?.name === 'RegExp' && n.arguments?.[0]?.type === 'StringLiteral') { text = n.arguments[0].value; kind = 'regex' }
        else if (n.type === 'CallExpression' && n.callee?.property?.name === 'includes' && n.arguments?.[0]?.type === 'StringLiteral') { text = n.arguments[0].value; kind = 'includes' }
        else if (n.type === 'ArrayExpression' && n.elements.length >= 3 && n.elements.every((e) => e?.type === 'StringLiteral') && n.elements.filter((e) => HANGUL.test(e.value)).length >= 3) { text = n.elements.map((e) => e.value).join('|'); kind = 'word-list' }
        if (text == null || !looksLikeWords(text)) return
        // a sentence the program writes (a reply, a label) is not a rule: only what is matched against input
        if (kind === 'includes' && text.length > 40) return
        out.push({ id: id(file, `${kind}:${text}`), file, line: (n.loc?.start.line || 0) + offset, kind, text: text.slice(0, 160) })
      })
    }
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = candidates()
  if (process.argv.includes('--list')) {
    for (const c of found) console.log(`${c.file}:${c.line}  [${c.kind}]  ${c.text}   (${c.id})`)
    console.log(`${found.length} candidates`)
    process.exit(0)
  }
  const allow = fs.existsSync(ALLOW_FILE) ? JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')) : []
  const ok = new Map(allow.map((a) => [a.id, a]))
  const bad = found.filter((c) => !ok.has(c.id))
  const stale = allow.filter((a) => !found.some((c) => c.id === a.id))
  for (const c of bad) console.log(`✗ ${c.file}:${c.line}  [${c.kind}]  ${c.text}\n    → 사람 말을 읽는 규칙이면 스킬·구조화 필드로 바꾸고, 형식 해석이면 ${path.relative(ROOT, ALLOW_FILE)} 에 이유와 함께(${c.id})`)
  for (const a of stale) console.log(`· 목록에만 있는 항목(지워도 됨): ${a.id}`)
  console.log(`${found.length} candidates · ${found.length - bad.length} allowed (format) · ${bad.length} not allowed`)
  process.exit(bad.length ? 1 : 0)
}
