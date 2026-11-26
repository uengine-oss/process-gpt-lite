// What a variation brings onto a computer that runs things there (작업본은 한 곳에 P1 — spec variation-seats 「PC 로 받기 전에 저절로 실행되는
// 설정 파일을 알린다」, reviews 11-26 #13 and 2nd #3). A working copy holds files other members of the folder wrote, and its person opens it in
// their own terminal and runs Claude Code · Codex · an editor there: some files make those programs run commands by themselves — Claude
// Code's hooks (.claude/settings*.json with `hooks`), MCP servers (.mcp.json), direnv (.envrc), VS Code's tasks (.vscode/tasks.json), and
// Windows shell files that point elsewhere or change what Explorer does (.url · .lnk · .library-ms · desktop.ini). Before 「이 PC 에서 작업」
// the sheet lists every one of them on the variation's branch and the person goes on with 「그래도 열기」 — nothing is blocked, nothing is
// changed. Who changed a file is not known for sure: a commit's author is whatever the committer wrote (a desktop, an agent, anyone with
// a push), so the name is given only as the commit says it (author) and the list is shown whoever it names (verified: false). Paths and
// names only — never a file's content.
import * as G from './git.js'

const MAX_SETTINGS = 256 * 1024 // a settings file bigger than this is listed without being read
const MAX_READ = 100 // settings files read at most, in one batch
const MAX_LIST = 50
// path → reason ('hooks' needs its content looked at)
function reasonOf(p) {
  const low = String(p).toLowerCase()
  const base = low.split('/').pop()
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(low)) return 'hooks'
  if (base === '.mcp.json') return 'mcp'
  if (base === '.envrc') return 'envrc'
  if (/(^|\/)\.vscode\/tasks\.json$/.test(low)) return 'tasks'
  if (base === 'desktop.ini' || /\.(url|lnk|library-ms)$/.test(base)) return 'shell'
  return null
}
const hooksIn = (buf) => {
  try { const h = JSON.parse(buf.toString('utf8'))?.hooks; return !!h && typeof h === 'object' && Object.keys(h).length > 0 } catch { return true }
}

// → {files: [{path, reason, author, at}], more, warn, verified: false} — warn whenever one is there
export async function trustOf(folder, v) {
  const ref = `refs/heads/${v.branch}`
  const listed = (await G.lsTree(folder.repo_path, ref)).map((f) => ({ ...f, reason: reasonOf(f.path) })).filter((f) => f.reason)
  // (Claude Code settings: only those with hooks — read in one batch, the small ones and only so many; one too big, past the cap, or
  // unreadable is listed as it is)
  const settings = listed.filter((f) => f.reason === 'hooks')
  const readable = settings.filter((f) => f.size <= MAX_SETTINGS).slice(0, MAX_READ)
  const hooked = new Set(settings.filter((f) => !readable.includes(f)).map((f) => f.sha))
  const read = new Map()
  try { await G.catBatch(folder.repo_path, [...new Set(readable.map((f) => f.sha))], (sha, body) => read.set(sha, hooksIn(body))) } catch { for (const f of readable) read.set(f.sha, true) }
  for (const [sha, yes] of read) if (yes) hooked.add(sha)
  const files = listed.filter((f) => f.reason !== 'hooks' || hooked.has(f.sha))
  if (!files.length) return { files: [], more: 0, warn: false, verified: false }
  const touched = await G.lastTouch(folder.repo_path, ref, 2000)
  const out = files.slice(0, MAX_LIST).map((f) => { const t = touched.get(f.path); return { path: f.path, reason: f.reason, author: t?.name || null, at: t?.at || null } })
  return { files: out, more: Math.max(0, files.length - MAX_LIST), warn: true, verified: false }
}
