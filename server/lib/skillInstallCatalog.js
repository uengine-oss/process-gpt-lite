// 업무 팩(skills/packs/<팩>/): 한 업종의 업무 지식을 스킬로 묶은 것. 기본 설치에는 없고 회사가 고를 때만
// 그 회사(테넌트)에 설치한다(lib/skillInstall.js, 설계 docs/mobile-review-1121/skill-routing-design.md 4.5).
//
//   skills/packs/<팩>/pack.json                 이름·버전·제목, 스킬마다 Lite 가 돌리는 법(output·runner·requires …),
//                                              프로세스 마이닝이 기록하는 단계·에이전트(mining)
//   skills/packs/<팩>/<스킬>/SKILL.md           deepagents 형식(name·description·metadata) + 절차
//   skills/packs/<팩>/<스킬>/references/*.md    필요할 때만 읽는 자세한 지식(에이전트도, Lite 서버 프롬프트도)
//
// 이 파일은 팩 파일을 읽기만 한다(데이터베이스 없음). 어느 회사가 어느 팩을 켰는지는 pro_skill_packs 가
// 사실이고, 여기 있는 캐시(enabledPacks)는 그 값을 테넌트마다 잠깐 들고 있는다 — 단계 목록을 동기로 찾는
// 곳(lib/mining/catalog.js stepOf …)이 있어서다. 비동기 입구는 먼저 `await packsReady()` 를 부른다.
// 코드에는 업종 문장이 없다: 팩이 꺼진 회사에서는 여기서 아무것도 나오지 않는다.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { q } from './supa.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const packsDir = () => process.env.PRO_SKILL_PACKS_DIR || path.join(here, '..', '..', 'skills', 'packs')

// ---------- 파일 형식 (우리가 정한 형식만 읽는다) ----------
const unquote = (s) => {
  const t = String(s).trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}
// SKILL.md 앞머리: 한 줄짜리 `키: 값` 과 한 단 들여 쓴 `metadata:` 아래의 `키: 값` 만 쓴다(팩의 구조화 데이터는
// pack.json 에 있다). deepagents 는 같은 앞머리를 YAML 로 읽는다.
export function frontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(md || ''))
  if (!m) return { meta: {}, body: String(md || '') }
  const meta = {}
  let block = null
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue
    const kv = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, indent, key, value] = kv
    if (!indent && value === '') { block = meta[key] = {}; continue }
    if (indent && block) block[key] = unquote(value)
    else { block = null; meta[key] = unquote(value) }
  }
  return { meta, body: String(md).slice(m[0].length) }
}
// "## <이름>" 제목 아래 글(다음 제목 전까지) — references 파일의 언어별 묶음
export function section(md, name) {
  const lines = String(md || '').split('\n')
  const at = lines.findIndex((l) => l.trim() === `## ${name}`)
  if (at < 0) return ''
  const end = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l))
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim()
}
// "{이름}" 자리를 값으로 (없는 이름은 빈칸)
export const fill = (text, values = {}) => String(text || '').replace(/\{([a-z_]+)\}/g, (_, k) => (values[k] == null ? '' : String(values[k])))

// 폴더의 파일들(상대 경로순). 내용 해시는 파일 경로와 내용으로만 정한다 — 압축 파일의 시각이 달라도 같은 묶음
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, base, out)
    else out.push({ path: path.relative(base, p).split(path.sep).join('/'), data: fs.readFileSync(p) })
  }
  return out
}
export const dirFiles = (dir) => walk(dir)
export function contentHash(files) {
  const h = crypto.createHash('sha256')
  for (const f of [...files].filter((x) => !x.path.split('/').some((s) => s.startsWith('.'))).sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${f.path}\n${crypto.createHash('sha256').update(f.data).digest('hex')}\n`)
  }
  return h.digest('hex')
}

// ---------- 팩 읽기 ----------
const cache = new Map() // dir → pack
export function readPack(name, { dir = packsDir(), fresh = false } = {}) {
  const root = path.join(dir, name)
  const key = root
  if (!fresh && cache.has(key)) return cache.get(key)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pack.json'), 'utf8'))
  const skills = Object.entries(manifest.skills || {}).map(([skill, lite]) => {
    const sdir = path.join(root, skill)
    const files = dirFiles(sdir)
    const md = files.find((f) => f.path === 'SKILL.md')?.data.toString('utf8') || ''
    const { meta, body } = frontmatter(md)
    if (meta.name !== skill) throw new Error(`pack ${name}: ${skill}/SKILL.md name is '${meta.name}'`)
    if (!String(meta.description || '').trim()) throw new Error(`pack ${name}: ${skill}/SKILL.md has no description`)
    return { name: skill, pack: name, dir: sdir, description: meta.description, metadata: meta.metadata || {}, body, lite: lite || {}, files, sha256: contentHash(files) }
  })
  const pack = { ...manifest, name: manifest.name || name, dir: root, skills, sha256: contentHash(skills.map((s) => ({ path: s.name, data: Buffer.from(s.sha256) }))) }
  cache.set(key, pack)
  return pack
}
export function packNames({ dir = packsDir() } = {}) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'pack.json'))).map((e) => e.name).sort()
  } catch { return [] }
}
export const allPacks = (opts) => packNames(opts).map((n) => readPack(n, opts))

// a pack skill's reference file, without its front matter
export function referenceText(skill, rel) {
  try {
    const md = fs.readFileSync(path.join(skill.dir, rel), 'utf8')
    return rel.endsWith('.md') ? frontmatter(md).body.trim() : md
  } catch { return '' }
}
export const referenceJson = (skill, rel) => { try { return JSON.parse(referenceText(skill, rel)) } catch { return null } }

// ---------- 이 회사가 켠 팩 ----------
const enabled = new Map() // tenant → { names: Set, at }
const TTL = Number(process.env.PRO_SKILL_PACKS_TTL_MS || 30_000)
// (tests pin a tenant's packs without a database; the server remembers what it just read or changed)
export function setEnabledPacks(tenant, names, { pinned = true } = {}) { enabled.set(tenant, { names: new Set(names), at: Date.now(), pinned }) }
export function forgetEnabledPacks(tenant) { enabled.delete(tenant) }
export async function enabledPacks(tenant = config.tenantId) {
  const c = enabled.get(tenant)
  if (c && (c.pinned || Date.now() - c.at < TTL)) return c.names
  const rows = await q('select pack from pro_skill_packs where tenant_id=$1 and enabled', [tenant]).catch((e) => { console.warn('[packs] state', e.message); return null })
  if (!rows) return c?.names || new Set()
  const names = new Set(rows.map((r) => r.pack).filter((n) => packNames().includes(n)))
  enabled.set(tenant, { names, at: Date.now() })
  return names
}
export const packsReady = (tenant) => enabledPacks(tenant)
// (sync: what the last packsReady() read for this tenant; nothing before it)
export const enabledNow = (tenant = config.tenantId) => enabled.get(tenant)?.names || new Set()
export const activePacks = (tenant = config.tenantId) => [...enabledNow(tenant)].map((n) => { try { return readPack(n) } catch (e) { console.warn('[packs]', n, e.message); return null } }).filter(Boolean)

// a skill of an enabled pack by its name or one of its old names (pack.json aliases)
export function packSkill(name, tenant = config.tenantId) {
  if (!name) return null
  for (const p of activePacks(tenant)) {
    const s = p.skills.find((x) => x.name === name || (x.lite.aliases || []).includes(name))
    if (s) return s
  }
  return null
}
// the format a pack skill makes in a language (pack.json output)
export const outputOf = (skill, l) => (skill?.lite?.output ? skill.lite.output[l] || skill.lite.output.ko || Object.values(skill.lite.output)[0] : skill?.metadata?.output || '')
// how Lite runs a pack skill for a format (pack.json runner): floor-plan · hwpx-template · agent
export const runnerOf = (skill, format) => (skill?.lite?.runner ? skill.lite.runner[format] || null : null)
// the document skills a mail's triage may pick (name, what it does, the format it makes)
export function documentSkills(l, tenant = config.tenantId) {
  return activePacks(tenant).flatMap((p) => p.skills.map((s) => ({ name: s.name, description: s.description, output: outputOf(s, l) })))
}
