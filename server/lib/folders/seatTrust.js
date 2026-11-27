// What a variation brings onto a computer that runs things there (작업본은 한 곳에 P1 — spec variation-seats 「PC 로 받기 전에 저절로 실행되는
// 설정 파일을 알린다」, reviews 11-26 #13 and 2nd #3, #112). A working copy holds files other members of the folder wrote, and its person opens
// it in their own terminal and runs Claude Code · Codex · an editor there: some files make those programs run commands by themselves —
// Claude Code's settings (.claude/settings*.json — `hooks`; and commands it runs, permissions, plugins, marketplaces or variables it gives
// ahead: statusLine · fileSuggestion · apiKeyHelper · awsAuthRefresh · awsCredentialExport · otelHeadersHelper · env · permissions.allow ·
// defaultMode · enableAllProjectMcpServers · enabledPlugins · extraKnownMarketplaces), hooks in a skill's or an agent's front matter
// (.claude/skills/**/SKILL.md · .claude/agents/**.md), MCP servers (.mcp.json · .vscode/mcp.json), Codex's project settings
// (.codex/config.toml), direnv (.envrc), VS Code's tasks, launch configurations, settings and workspaces (.vscode/tasks.json · launch.json ·
// settings.json · *.code-workspace), tool versions mise · asdf install or run (mise.toml · .tool-versions), Windows shell files that point
// elsewhere or change what Explorer does (.url · .lnk · .library-ms · .scf · .searchConnector-ms · desktop.ini), and programs at the
// folder's top that a Windows terminal opened there would run instead of a command of the same name (every type Windows runs by its name:
// .bat · .cmd · .exe · .com · .ps1 · .vbs · .vbe · .js · .jse · .wsf · .wsh · .msc). Before 「이 PC 에서 작업」 the sheet lists every one of
// them on the variation's branch and the person goes on with 「그래도 열기」 — nothing is blocked, nothing is changed. Who changed a file is
// not known for sure: a commit's author is whatever the committer wrote (a desktop, an agent, anyone with a push), so the name is given only
// as the commit says it (author) and the list is shown whoever it names (verified: false). Paths and names only — never a file's content.
// The list fails closed: a tree git could not list (an error, out of time) is said as such (503 — the sheet says it could not check), never
// taken for 「nothing there」.
import * as G from './git.js'
import { L } from '../lang.js'

const MAX_SETTINGS = 256 * 1024 // a settings file bigger than this is listed without being read
const MAX_READ = 100 // settings files read at most, in one batch
const MAX_LIST = 50
// path → reason ('settings' — a Claude Code settings file — and 'front' — a skill's or an agent's file — need their content looked at)
export function reasonOf(p) {
  const low = String(p).toLowerCase()
  const base = low.split('/').pop()
  if (/(^|\/)\.claude\/settings[^/]*\.json$/.test(low)) return 'settings'
  if (/(^|\/)\.claude\/skills\/(.+\/)?skill\.md$/.test(low) || /(^|\/)\.claude\/agents\/(.+\/)?[^/]+\.md$/.test(low)) return 'front'
  if (base === '.mcp.json' || /(^|\/)\.vscode\/mcp\.json$/.test(low)) return 'mcp'
  if (/(^|\/)\.codex\/config\.toml$/.test(low)) return 'codex'
  if (base === '.envrc') return 'envrc'
  if (/(^|\/)\.vscode\/tasks\.json$/.test(low)) return 'tasks'
  if (/(^|\/)\.vscode\/(launch|settings)\.json$/.test(low) || base.endsWith('.code-workspace')) return 'vscode'
  if (['mise.toml', '.mise.toml', 'mise.local.toml', '.mise.local.toml', '.tool-versions'].includes(base) || /(^|\/)\.?mise\/config(\.local)?\.toml$/.test(low)) return 'tools'
  if (base === 'desktop.ini' || /\.(url|lnk|library-ms|scf|searchconnector-ms)$/.test(base)) return 'shell'
  // (Windows' PATHEXT and PowerShell: what a command name finds in the current folder first)
  if (!low.includes('/') && /\.(bat|cmd|exe|com|ps1|vbs|vbe|js|jse|wsf|wsh|msc)$/.test(base)) return 'run'
  return null
}
// what a Claude Code settings file does by itself → 'hooks' (commands at its events) · 'claude' (a command it runs, or permissions and MCP
// servers it allows ahead) · null (nothing of these). Unreadable: 'hooks' — never taken for nothing
const ASK_MODES = new Set(['default', 'plan'])
const cmdOf = (x) => !!x && (typeof x === 'string' ? x.trim().length > 0 : typeof x === 'object' && (x.type === 'command' || !!x.command))
export function settingsRisk(buf) {
  let j
  try { j = JSON.parse(buf.toString('utf8')) } catch { return 'hooks' }
  if (!j || typeof j !== 'object') return null
  if (j.hooks && typeof j.hooks === 'object' && Object.keys(j.hooks).length > 0) return 'hooks'
  const p = j.permissions && typeof j.permissions === 'object' ? j.permissions : {}
  const mode = p.defaultMode ?? j.defaultMode
  const filled = (x) => (Array.isArray(x) ? x.length > 0 : !!x && typeof x === 'object' ? Object.keys(x).length > 0 : !!x)
  if (cmdOf(j.statusLine) || cmdOf(j.fileSuggestion) || ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'].some((k) => cmdOf(j[k]))
    || (Array.isArray(p.allow) && p.allow.length > 0) || (mode != null && !ASK_MODES.has(String(mode))) || j.enableAllProjectMcpServers === true
    || ['env', 'enabledPlugins', 'extraKnownMarketplaces'].some((k) => j[k] != null && filled(j[k]))) return 'claude'
  return null
}
// A skill's (SKILL.md) or an agent's (.claude/agents/*.md) front matter — the block between a first line `---` and the next — read as a
// mapping: its top-level keys are the lines that start at the first column with `key:` (a key may be quoted); a top-level `hooks` with
// anything under it or after it makes 'hooks'. A file with no front matter (or one never closed — Claude Code reads none then) is nothing.
// → 'hooks' | null
export function frontRisk(buf) {
  const lines = buf.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l))
  if (close < 0) return null
  const block = lines.slice(1, close)
  for (let i = 0; i < block.length; i++) {
    const m = /^(?:"([^"]*)"|'([^']*)'|([^\s#:'"][^:]*?))\s*:(?:\s+(.*)|$)/.exec(block[i])
    if (!m) continue
    if ((m[1] ?? m[2] ?? m[3]) !== 'hooks') continue
    const inline = String(m[4] || '').replace(/\s+#.*$/, '').trim()
    if (inline && !['~', 'null', '{}', '[]', "''", '""'].includes(inline.toLowerCase())) return 'hooks'
    // (its value on the lines under it: anything indented before the next top-level key)
    for (let k = i + 1; k < block.length && !/^\S/.test(block[k]); k++) if (block[k].trim() && !block[k].trim().startsWith('#')) return 'hooks'
    return null
  }
  return null
}

// The files of a tree that run things by themselves, listed strictly: git that could not list the tree (an error, out of time) throws — a 503
// the sheet says as 「확인하지 못했어요」
const LIST_MS = 30_000
async function listStrict(folder, commit) {
  let out
  try { out = await G.git(folder.repo_path, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], { timeout: LIST_MS }) } catch (e) {
    throw Object.assign(new Error(L('이 변형의 파일을 확인하지 못했어요. 잠시 뒤에 다시 시도해 주세요.', "Couldn't check this variation's files. Try again in a moment.")), { status: 503, why: 'unchecked', cause: e })
  }
  return out.split('\0').filter(Boolean).map((line) => {
    const [meta, p] = line.split('\t')
    const [, type, sha, size] = meta.split(/\s+/)
    return type === 'blob' ? { path: p, sha, size: Number(size) || 0 } : null
  }).filter(Boolean)
}
// → {files: [{path, reason, author, at}], more, warn, verified: false, head} at one commit — warn whenever one is there
export async function trustAt(folder, head) {
  if (!head) return { files: [], more: 0, warn: false, verified: false, head: null }
  const listed = (await listStrict(folder, head)).map((f) => ({ ...f, reason: reasonOf(f.path) })).filter((f) => f.reason)
  // (Claude Code settings and skill · agent files: only those that do something by themselves — read in one batch, the small ones and only
  // so many; one too big, past the cap, or unreadable is listed as one with hooks)
  const looked = listed.filter((f) => f.reason === 'settings' || f.reason === 'front')
  const readable = looked.filter((f) => f.size <= MAX_SETTINGS).slice(0, MAX_READ)
  const risk = new Map(looked.filter((f) => !readable.includes(f)).map((f) => [`${f.reason}:${f.sha}`, 'hooks']))
  const kinds = new Map()
  for (const f of readable) kinds.set(f.sha, new Set([...(kinds.get(f.sha) || []), f.reason]))
  try {
    await G.catBatch(folder.repo_path, [...kinds.keys()], (sha, body) => {
      for (const k of kinds.get(sha) || []) { const r = k === 'settings' ? settingsRisk(body) : frontRisk(body); if (r) risk.set(`${k}:${sha}`, r) }
    })
  } catch { for (const f of readable) risk.set(`${f.reason}:${f.sha}`, 'hooks') }
  const files = listed.filter((f) => !['settings', 'front'].includes(f.reason) || risk.has(`${f.reason}:${f.sha}`))
    .map((f) => (['settings', 'front'].includes(f.reason) ? { ...f, reason: risk.get(`${f.reason}:${f.sha}`) } : f))
  if (!files.length) return { files: [], more: 0, warn: false, verified: false, head }
  const touched = await G.lastTouch(folder.repo_path, head, 2000)
  const out = files.slice(0, MAX_LIST).map((f) => { const t = touched.get(f.path); return { path: f.path, reason: f.reason, author: t?.name || null, at: t?.at || null } })
  return { files: out, more: Math.max(0, files.length - MAX_LIST), warn: true, verified: false, head }
}
// …of the variation's branch now. head: the commit looked at (「이 PC 에서 작업」 sends it back — the server refuses when the variation moved
// since: what comes to the PC is what was shown)
export async function trustOf(folder, v) {
  return trustAt(folder, await G.head(folder.repo_path, `refs/heads/${v.branch}`))
}
// what of `now` the person was not shown at `was` (a file, or a reason a file has, that is new) → [{path, reason}]
export async function trustAdded(folder, was, now) {
  if (!now || was === now) return []
  const [a, b] = await Promise.all([trustAt(folder, was), trustAt(folder, now)])
  const seen = new Set(a.files.map((f) => `${f.path}\0${f.reason}`))
  // (a list past its cap may hide one: more there now than shown then counts as new)
  const added = b.files.filter((f) => !seen.has(`${f.path}\0${f.reason}`)).map((f) => ({ path: f.path, reason: f.reason }))
  return added.length || b.more > a.more ? (added.length ? added : [{ path: '', reason: 'more' }]) : []
}
