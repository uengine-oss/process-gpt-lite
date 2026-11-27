// What a variation brings onto a computer that runs things there (작업본은 한 곳에 P1 — spec variation-seats 「PC 로 받기 전에 저절로 실행되는
// 설정 파일을 알린다」, reviews 11-26 #13 and 2nd #3). A working copy holds files other members of the folder wrote, and its person opens it in
// their own terminal and runs Claude Code · Codex · an editor there: some files make those programs run commands by themselves — Claude
// Code's settings (.claude/settings*.json — `hooks`; and commands it runs or permissions it gives ahead: statusLine · apiKeyHelper ·
// awsAuthRefresh · awsCredentialExport · otelHeadersHelper · permissions.allow · defaultMode · enableAllProjectMcpServers), MCP servers
// (.mcp.json), Codex's project settings (.codex/config.toml), direnv (.envrc), VS Code's tasks, launch configurations and settings
// (.vscode/tasks.json · launch.json · settings.json), tool versions mise · asdf install or run (mise.toml · .tool-versions), Windows shell
// files that point elsewhere or change what Explorer does (.url · .lnk · .library-ms · desktop.ini), and programs at the folder's top that a
// Windows terminal opened there would run instead of a command of the same name (.bat · .cmd · .exe · .com · .ps1). Before 「이 PC 에서 작업」
// the sheet lists every one of them on the variation's branch and the person goes on with 「그래도 열기」 — nothing is blocked, nothing is
// changed. Who changed a file is not known for sure: a commit's author is whatever the committer wrote (a desktop, an agent, anyone with
// a push), so the name is given only as the commit says it (author) and the list is shown whoever it names (verified: false). Paths and
// names only — never a file's content.
import * as G from './git.js'

const MAX_SETTINGS = 256 * 1024 // a settings file bigger than this is listed without being read
const MAX_READ = 100 // settings files read at most, in one batch
const MAX_LIST = 50
// path → reason ('settings' — a Claude Code settings file — needs its content looked at: hooksIn)
export function reasonOf(p) {
  const low = String(p).toLowerCase()
  const base = low.split('/').pop()
  if (/(^|\/)\.claude\/settings[^/]*\.json$/.test(low)) return 'settings'
  if (base === '.mcp.json') return 'mcp'
  if (/(^|\/)\.codex\/config\.toml$/.test(low)) return 'codex'
  if (base === '.envrc') return 'envrc'
  if (/(^|\/)\.vscode\/tasks\.json$/.test(low)) return 'tasks'
  if (/(^|\/)\.vscode\/(launch|settings)\.json$/.test(low)) return 'vscode'
  if (['mise.toml', '.mise.toml', 'mise.local.toml', '.mise.local.toml', '.tool-versions'].includes(base) || /(^|\/)\.?mise\/config(\.local)?\.toml$/.test(low)) return 'tools'
  if (base === 'desktop.ini' || /\.(url|lnk|library-ms)$/.test(base)) return 'shell'
  if (!low.includes('/') && /\.(bat|cmd|exe|com|ps1)$/.test(base)) return 'run'
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
  if (cmdOf(j.statusLine) || ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'].some((k) => cmdOf(j[k]))
    || (Array.isArray(p.allow) && p.allow.length > 0) || (mode != null && !ASK_MODES.has(String(mode))) || j.enableAllProjectMcpServers === true) return 'claude'
  return null
}

// → {files: [{path, reason, author, at}], more, warn, verified: false, head} — warn whenever one is there. head: the commit looked at (「이 PC
// 에서 작업」 sends it back — the server refuses when the variation moved since: what comes to the PC is what was shown)
export async function trustOf(folder, v) {
  const head = await G.head(folder.repo_path, `refs/heads/${v.branch}`)
  if (!head) return { files: [], more: 0, warn: false, verified: false, head: null }
  const listed = (await G.lsTree(folder.repo_path, head)).map((f) => ({ ...f, reason: reasonOf(f.path) })).filter((f) => f.reason)
  // (Claude Code settings: only those that do something by themselves — read in one batch, the small ones and only so many; one too big,
  // past the cap, or unreadable is listed as one with hooks)
  const settings = listed.filter((f) => f.reason === 'settings')
  const readable = settings.filter((f) => f.size <= MAX_SETTINGS).slice(0, MAX_READ)
  const risk = new Map(settings.filter((f) => !readable.includes(f)).map((f) => [f.sha, 'hooks']))
  try { await G.catBatch(folder.repo_path, [...new Set(readable.map((f) => f.sha))], (sha, body) => { const r = settingsRisk(body); if (r) risk.set(sha, r) }) } catch { for (const f of readable) risk.set(f.sha, 'hooks') }
  const files = listed.filter((f) => f.reason !== 'settings' || risk.has(f.sha)).map((f) => (f.reason === 'settings' ? { ...f, reason: risk.get(f.sha) } : f))
  if (!files.length) return { files: [], more: 0, warn: false, verified: false, head }
  const touched = await G.lastTouch(folder.repo_path, head, 2000)
  const out = files.slice(0, MAX_LIST).map((f) => { const t = touched.get(f.path); return { path: f.path, reason: f.reason, author: t?.name || null, at: t?.at || null } })
  return { files: out, more: Math.max(0, files.length - MAX_LIST), warn: true, verified: false, head }
}
