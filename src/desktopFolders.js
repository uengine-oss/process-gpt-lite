// 「내 PC 폴더 올리기」 (champion folders — spec openspec/specs/champion-folders): in the desktop app the page asks the app
// (window.pglDesktop.folders, desktop/src/preload.js) to let the person pick a folder of this computer, shows the app's preview of it,
// makes a Lite folder and binds the two; the app asks the person once more in a system dialog before anything goes up. The page never
// sends or receives a path — only the folder's name on this computer (label). In a browser there is no bridge: the screen says where
// this can be done instead.
import { reactive } from 'vue'

export const bridge = () => (typeof window !== 'undefined' ? window.pglDesktop?.folders || null : null)
export async function available() {
  const b = bridge()
  if (!b || typeof b.available !== 'function') return false
  try { return !!(await b.available()) } catch { return false }
}

// what this computer uploads (list() — {folderId, label, state, lastPushedAt, why}), kept fresh while a screen shows it
export const pcFolders = reactive({ list: [], ready: false })
let watching = false
export async function refreshPcFolders() {
  const b = bridge()
  if (!b?.list) return []
  try { pcFolders.list = (await b.list()) || [] } catch { pcFolders.list = [] }
  pcFolders.ready = true
  if (!watching && typeof b.onState === 'function') {
    watching = true
    try { b.onState(() => { refreshPcFolders() }) } catch { watching = false }
  }
  return pcFolders.list
}
export const pcFolderOf = (folderId) => pcFolders.list.find((x) => String(x.folderId) === String(folderId)) || null

// what was left out, by group (the app's preview: excluded[].group)
export const GROUP = {
  gitignore: '이 폴더가 빼 둔 것(.gitignore)',
  secret: '비밀로 보여 뺐어요',
  personal: '내 PC 에만 두는 설정',
  rebuildable: '다시 만들 수 있는 것',
  large: '큰 파일 — 올리지 않음',
  structure: '따로 관리되는 폴더 · 폴더 밖을 가리키는 링크',
}
// groups whose files the person may still put back in (never a secret: the server refuses those anyway)
export const INCLUDABLE = new Set(['gitignore', 'personal'])
// why a file needs a look (flagged[].reason · a refusal's paths[].reason): the shape of a key or token — never its value
export const REASON = {
  name: '비밀 파일의 이름',
  private_key: '개인 열쇠(PEM)',
  aws_access_key: 'AWS 접근 키 ID',
  github_token: 'GitHub 토큰',
  github_pat: 'GitHub 토큰',
  gitlab_token: 'GitLab 토큰',
  slack_token: 'Slack 토큰',
  slack_webhook: 'Slack 웹훅 주소',
  anthropic_key: 'Anthropic API 키',
  openai_key: 'OpenAI API 키',
  google_api_key: 'Google API 키',
  google_oauth_secret: 'Google OAuth 비밀',
  stripe_key: 'Stripe 키',
  npm_token: 'npm 토큰',
  pypi_token: 'PyPI 토큰',
  huggingface_token: 'Hugging Face 토큰',
  lite_folder_token: 'Process GPT Lite 폴더 토큰',
  lite_device_token: 'Process GPT Lite 기기 토큰',
  signed_token: '서명된 토큰(JWT)',
  url_credentials: '주소에 든 아이디 · 비밀번호',
  env_assignment: '길고 무작위인 값',
  runs_config: '실행되는 설정(MCP 서버)',
}
export const reasonText = (r) => REASON[r] || '확인이 필요해요'
// the preview's warnings
export const WARNING = {
  own_git: '이 폴더의 git 이력은 올리지 않아요 — 지금 파일만 올라가요',
  empty: '올릴 파일이 없어요',
  too_big: '한 번에 올릴 수 있는 크기(200 MB)를 넘어요 — 큰 폴더는 빼 주세요',
}
// why an upload did not happen, or stopped (bind · syncNow · list().why — the app's and the server's codes)
export const WHY = {
  cancelled: '올리지 않았어요',
  not_editor: '이 폴더에 올릴 권한이 없어요',
  secret: '비밀로 보이는 파일이 있어 서버가 받지 않았어요',
  too_big: '한 번에 올릴 수 있는 크기(200 MB)를 넘었어요',
  conflict: '서버 쪽이 바뀌어 맞추지 못했어요',
  behind: '서버 쪽에도 바뀐 것이 있어요',
  paused: '멈춰 두었어요',
  source_removed: '웹에서 연결을 뺐어요',
  device_revoked: '이 PC 의 연결이 끊겼어요',
  no_folder: '폴더를 찾지 못했어요',
  not_managed: '이 폴더는 PC 에서 올릴 수 없어요',
  folder_missing: 'PC 에서 폴더를 찾을 수 없어요',
  offline: '서버와 연결되어 있지 않아요',
  timeout: '서버가 제때 답하지 않았어요',
  empty: '올릴 파일이 없어요',
  already_bound: '이미 올리고 있는 폴더예요',
  other_user: '이 PC 에 다른 사람이 로그인해 있어요',
  failed: '올리지 못했어요',
}
export const whyText = (w) => (w ? WHY[w] || '올리지 못했어요' : '')
// why a folder could not be picked (pick() → {error})
export const PICK_ERROR = {
  not_linked: '이 PC 가 아직 Lite 와 연결되지 않았어요 — 설정 › 계정 › 「내 컴퓨터의 에이전트」에서 연결해 주세요',
  system_folder: '디스크 전체나 시스템 폴더는 고를 수 없어요',
  home_folder: '홈 폴더 전체는 고를 수 없어요 — 그 안의 폴더를 골라 주세요',
  app_folder: '이 앱의 데이터가 든 폴더는 고를 수 없어요',
  not_found: '그 폴더를 찾을 수 없어요',
  not_folder: '폴더가 아니에요',
  not_readable: '그 폴더를 읽을 수 없어요',
  other_user: '이 PC 에 다른 사람이 로그인해 있어요',
}
export const pickErrorText = (e) => PICK_ERROR[e] || '그 폴더를 고를 수 없어요'
// a computer's state (list().state · the server's source state)
export const STATE = { synced: '올려 둠', idle: '올려 둠', active: '올려 둠', pushing: '올리는 중', scanning: '훑는 중', behind: '서버 쪽이 앞서 있어요', paused: '멈춤', blocked: '멈춤', missing: '폴더 없음' }
export const stateText = (s) => STATE[s] || '멈춤'
export const stopped = (s) => ['paused', 'blocked', 'missing'].includes(s)

export const fmtBytes = (n) => {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`
  if (v < 1024 ** 3) return `${(v / 1024 / 1024).toFixed(v < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(v / 1024 ** 3).toFixed(1)} GB`
}

// the agent platforms and their kinds of assets (server lib/folders/kit-places.json)
export const PLATFORM = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini CLI', copilot: 'GitHub Copilot', spec: '스펙' }
export const PLATFORM_HINT = {
  claude: '이 폴더에서 일하면 Claude Code 가 저절로 읽어요',
  codex: '이 폴더에서 일하면 Codex 가 저절로 읽어요',
  cursor: '이 폴더를 Cursor 로 열면 규칙이 적용돼요',
  gemini: '이 폴더에서 일하면 Gemini CLI 가 저절로 읽어요',
  copilot: '이 폴더에서 GitHub Copilot 이 읽는 지침이에요',
  spec: '이 폴더에서 일할 때 따를 스펙이에요',
}
export const KIND = { skill: '스킬', command: '명령', agent: '하위 에이전트', prompt: '프롬프트', rules: '규칙', instructions: '지침', settings: '실행 설정', mcp: 'MCP 서버', spec: '스펙', change: '진행 중 변경' }
// 「스킬 6 · 명령 4 · 스펙 12」 from {type: count}
export function kitLine(counts) {
  if (!counts) return ''
  return Object.keys(KIND).filter((t) => counts[t]).map((t) => `${KIND[t]} ${counts[t]}`).join(' · ')
}
