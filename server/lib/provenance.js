// Which files a finished agent turn may hand to the person as file cards.
//
// The deepagents sandbox is shared by the whole tenant: /workspace is one folder for every user,
// each conversation has its own folder under /workspace/.bpmn/<conversation>, uploads are under
// /workspace/uploads/<user>. An agent that opens someone else's document for reference (a .hwpx
// at the top of /workspace) gets it published to storage by office-mcp, and deepagents itself
// republishes every /workspace/*.hwpx path it sees in a tool result at the end of a chat turn —
// that used to put other people's documents into this person's chat as their own.
//
// A file is this turn's output when the agent wrote it in this turn (file_artifact), it is in this
// conversation's own folder, or it was created/changed on disk since the turn started. Everything
// else the agent only looked at.
import fs from 'node:fs/promises'
import { workspaceHostPath } from './missions.js'

// deepagents core/skills/tools.py _conv_slug / bpmn_container_base
export const slug = (conv) => String(conv || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
export const roomOf = (conv) => (slug(conv) ? `/workspace/.bpmn/${slug(conv)}` : null)

const DOC = '(?:docx|pptx|xlsx|xls|csv|pdf|hwpx|hwp|dxf|dwg|svg|vectorcraft|psd|psb|pcraft|png|jpe?g|webp|wav|mp3|flac|soundcraft|scraftz|mp4|mov|webm|fcproj)'
// a quoted path may hold spaces ("/workspace/11월 고객 세미나 예산표.xlsx", JSON tool arguments); a bare one may not
const QUOTED = new RegExp(`[\`*"'](\\/workspace\\/[^\`*"'\\n]+?\\.${DOC})[\`*"'\\\\]`, 'gi')
const BARE = new RegExp(`\\/workspace\\/[^\\s"'\`)\\]\\\\]+?\\.${DOC}\\b`, 'gi')
export function workspacePaths(text) {
  const t = typeof text === 'string' ? text : JSON.stringify(text ?? '')
  return [...new Set([...[...t.matchAll(QUOTED)].map((m) => m[1]), ...(t.match(BARE) || [])])]
}

// office-mcp's store_and_render_hwpx names its copy edited-<ascii name>_<YYYYMMDD_HHMMSS>.hwpx
// (_safe_storage_name: every run of non [0-9A-Za-z._-] becomes "_")
// (an all-Korean name leaves nothing: "edited-_<stamp>.hwpx" — then several paths can fit one copy)
const ascii = (name) => String(name).replace(/[^0-9A-Za-z._-]+/g, '_').replace(/^_+|_+$/g, '') || 'output.hwpx'
export function sourcesOf(fileName, paths) {
  const raw = String(fileName || '').split('?')[0]
  const base = (p) => p.split('/').pop()
  const exact = [...paths].filter((p) => base(p) === raw)
  if (exact.length) return exact
  const m = /^edited-(.*)_\d{8}_\d{6}\.hwpx$/i.exec(raw)
  if (!m) return []
  return [...paths].filter((p) => /\.hwpx$/i.test(p) && ascii(base(p)).replace(/\.hwpx$/i, '') === m[1])
}
export const sourceOf = (fileName, paths) => sourcesOf(fileName, paths)[0] || null

const inside = (p, dir) => !!dir && (p === dir || p.startsWith(dir.replace(/\/$/, '') + '/'))
const mtimeOf = async (p) => { try { return (await fs.stat(await workspaceHostPath(p))).mtimeMs } catch { return null } }

// ctx: { rooms: [this conversation's folder, folders the turn wrote in], written: Set of paths
// written this turn, since: turn start (ms), mtime?: (path) => ms|null for tests }
export async function isOutput(p, { rooms = [], written = new Set(), since = 0, mtime = mtimeOf } = {}) {
  if (!p) return false
  if (written.has(p) || rooms.some((r) => inside(p, r))) return true
  const t = await mtime(p)
  return t != null && t >= since
}

// A document a tool result carried (storage URL): the turn's output, or a file it only opened?
// tool '' = deepagents' own end-of-turn republish of a hwpx path; input = that tool call's arguments.
export async function keepToolDoc({ name, tool, input }, paths, ctx) {
  const srcs = sourcesOf(name, paths)
  // several files fit the copy's name: shown only when every one of them is this turn's (the
  // turn's own document still comes as a card from its folder — documentsOfRun)
  if (srcs.length) {
    for (const p of srcs) if (!(await isOutput(p, ctx))) return { keep: false, src: p }
    return { keep: true, src: srcs.length === 1 ? srcs[0] : null }
  }
  // republished from a path we cannot place: not shown (it may be anyone's)
  if (!tool) return { keep: false, src: null }
  // a generator (generate_hwpx from a template, a live editor save): new document — unless the
  // call worked on a workspace file that is not this turn's (opening a reference to look at it)
  for (const p of workspacePaths(input)) if (!(await isOutput(p, ctx))) return { keep: false, src: p }
  return { keep: true, src: null }
}

// What the agent is told about where files go and what it may read.
export function workspaceHint(user, conv) {
  const room = roomOf(conv)
  return `\n\n(파일 위치 규칙: 새로 만드는 파일은 이 대화 전용 산출물 폴더${room ? `(${room}/)` : '(📁 섹션의 base 폴더)'} 아래에 저장하세요. 참고 자료는 사용자가 첨부했거나 공유받은 파일(/workspace/uploads/${user.id}/ 아래), 이 대화 폴더, 사용자에게 공유된 폴더(folder_ 도구)에서만 찾으세요. /workspace 최상위·다른 대화 폴더·다른 사람의 uploads 에 있는 파일은 같은 회사 다른 사람의 것이니 열거나 근거로 쓰지 말고, 목록을 훑지도 마세요.)`
}
