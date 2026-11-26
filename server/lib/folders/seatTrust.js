// What a variation brings onto a computer that runs things there (작업본은 한 곳에 P1 — spec variation-seats 「PC 로 받기 전에 실행되는
// 설정 파일을 알린다」, review 11-26 #13). A working copy holds files other members of the folder wrote, and its person opens it in their own
// terminal and runs Claude Code · Codex · an editor there: some files make those programs run commands by themselves — Claude Code's hooks
// (.claude/settings*.json with `hooks`), MCP servers (.mcp.json), direnv (.envrc), VS Code's tasks (.vscode/tasks.json), and Windows shell
// files that point elsewhere or change what Explorer does (.url · .lnk · .library-ms · desktop.ini). Before 「이 PC 에서 작업」 the sheet lists
// those of the variation's branch with who changed each last; it warns when someone else did, and the person goes on with 「그래도 열기」 —
// nothing is blocked, nothing is changed. Paths and names only — never a file's content.
import * as G from './git.js'

const MAX_SETTINGS = 256 * 1024
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
// a Claude Code settings file runs something only when it has hooks (or cannot be read — then it is listed)
async function hasHooks(repo, ref, file) {
  if (file.size > MAX_SETTINGS) return true
  try {
    const o = JSON.parse((await G.show(repo, ref, file.path)).toString('utf8'))
    const h = o?.hooks
    return !!h && typeof h === 'object' && Object.keys(h).length > 0
  } catch { return true }
}

// → {files: [{path, reason, by: {name}, at, mine}], warn} — warn: one of them was last changed by someone other than `me`
export async function trustOf(folder, v, me) {
  const ref = `refs/heads/${v.branch}`
  const listed = (await G.lsTree(folder.repo_path, ref)).map((f) => ({ ...f, reason: reasonOf(f.path) })).filter((f) => f.reason)
  const files = []
  for (const f of listed) if (f.reason !== 'hooks' || await hasHooks(folder.repo_path, ref, f)) files.push(f)
  if (!files.length) return { files: [], warn: false }
  const touched = await G.lastTouch(folder.repo_path, ref, 2000)
  const email = String(me?.email || '').toLowerCase()
  const out = files.slice(0, 50).map((f) => {
    const t = touched.get(f.path)
    const mine = !!t && !!email && String(t.email || '').toLowerCase() === email
    return { path: f.path, reason: f.reason, by: t ? { name: t.name || '' } : null, at: t?.at || null, mine }
  })
  return { files: out, warn: out.some((f) => !f.mine) }
}
