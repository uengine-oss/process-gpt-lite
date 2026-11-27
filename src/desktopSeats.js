// 「이 PC 에서 작업」 (작업본은 한 곳에 P1 — spec openspec/specs/variation-seats): in the desktop app (0.2.6) a variation's working copy can
// be on this very computer. The page asks the server for the seat (POST …/seat {to:'device', deviceId} — the server tells the app over its
// link to fetch the variation and make the working copy in the app's data folder), then waits on the app (window.pglDesktop.seats,
// desktop/src/preload.js) until it holds it. The page never sends or receives a path — only the variation's id: 「폴더 열기」 · 「터미널
// 열기」 · 「지금 올리기」 · 「돌려놓기」 are the app's own (main.js opens Finder · the system terminal at the working copy).
// In a browser (or an app without working copies) there is no bridge: the 작업실 sheet says where this can be done instead.
import { reactive } from 'vue'

export const bridge = () => (typeof window !== 'undefined' ? window.pglDesktop?.seats || null : null)
// the desktop app at all (an older one — 0.2.5 and before — has no working copies: the sheet asks for the new one)
export const inDesktop = () => typeof window !== 'undefined' && !!window.pglDesktop?.app
export const oldDesktop = () => inDesktop() && !bridge()

// what this computer holds (list() — {variationId, folderId, title, state, why, dirty, ahead, branchOk, flagged, pushedAt, autoSave, busy}),
// kept fresh while a screen shows it
export const pcSeats = reactive({ list: [], ready: false })
let watching = false
export async function refreshPcSeats() {
  const b = bridge()
  if (!b?.list) return []
  try { pcSeats.list = (await b.list()) || [] } catch { pcSeats.list = [] }
  pcSeats.ready = true
  if (!watching && typeof b.onState === 'function') {
    watching = true
    try { b.onState((list) => { pcSeats.list = Array.isArray(list) ? list : pcSeats.list; pcSeats.ready = true }) } catch { watching = false }
  }
  return pcSeats.list
}
export const pcSeatOf = (vid) => pcSeats.list.find((x) => String(x.variationId) === String(vid)) || null

// this app's own device (the runner's pairing) and whether it is on the server now → {deviceId, connected} | null
export async function thisDevice() {
  const r = typeof window !== 'undefined' ? window.pglDesktop?.localRunner : null
  if (!r?.status) return null
  try { const s = await r.status(); return s?.paired && s.deviceId ? { deviceId: s.deviceId, connected: !!s.connected } : { deviceId: null, connected: false } } catch { return null }
}

// why the app could not hold it (open() · the server's refusal), in words
const WHY = {
  timeout: '이 PC 가 받는 데 너무 오래 걸려요 — 잠시 뒤에 다시 해 주세요.',
  failed: '이 PC 에 받지 못했어요 — 네트워크나 git 을 확인해 주세요.',
  leftover: '이 PC 에 같은 변형의 남은 변경이 있어요 — 그것을 먼저 올리거나 치워 주세요.',
  stale: '그사이 작업본이 다른 곳으로 옮겨졌어요 — 새로 고쳐 보고 다시 해 주세요.',
  not_here: '그사이 작업본이 다른 곳으로 옮겨졌어요 — 새로 고쳐 보고 다시 해 주세요.',
  not_linked: '이 PC 가 서버에 이어져 있지 않아요 — 설정 › 내 컴퓨터의 에이전트에서 연결해 주세요.',
  offline: '이 PC 가 서버에 이어져 있지 않아요 — 다시 이어지면 해 주세요.',
  branch: '작업본이 다른 가지로 바뀌어 있어요 — 터미널에서 원래 가지로 돌아간 뒤에 해 주세요.',
  diverged: '작업본의 이력이 바뀌어 이 변형에 이어 붙일 수 없어요 — 돌려놓으면 새 변형으로 올라가요.',
  secret: '비밀로 보이는 내용이 있어 올리지 않았어요 — 그 파일을 고친 뒤 다시 올려 주세요.',
  structure: '링크 · 안의 저장소 · git 제어 파일은 올리지 않아요 — 그 파일을 빼 주세요.',
  too_big: '한 번에 올리기에 너무 커요 — 큰 파일을 빼 주세요.',
  other_user: '이 앱에는 다른 사람이 로그인해 있어요.',
  remove: '돌려놓았지만 이 PC 의 작업본을 옮기지 못했어요 — 터미널 · 편집기를 닫은 뒤 「남은 변경」에서 다시 해 주세요.',
  busy: '서버가 이 변형을 옮기거나 저장하는 중이에요 — 잠시 뒤에 다시 해 주세요.',
  in_use: '이 작업본 폴더에서 터미널이나 프로그램이 열려 있어요. 닫은 뒤 다시 시도해 주세요.',
  missing: '이 PC의 작업본 폴더가 없어져서 이 변형을 보관 중 상태로 바꿨어요. 다시 「이 PC 에서 작업」을 누르면 새로 받아요.',
  moved: '그사이 이 변형이 바뀌었어요. 다시 확인한 뒤에 받아요.',
  in_progress: '병합 중이라 올리지 않았어요 — 터미널에서 병합(cherry-pick · revert · rebase)을 마치거나 취소하면 다시 올라가요.',
  config: '작업본의 git 설정에 앱이 쓰지 않는 항목(프록시 · 주소 바꾸기 · 설정 불러오기 같은 것)이 있어 올리지 않았어요 — 터미널에서 그 설정을 지운 뒤 다시 올려 주세요.',
  cancelled: '취소했어요.',
}
// what a file of a variation runs by itself on a computer (server lib/folders/seatTrust.js reasons)
export const TRUST = {
  hooks: 'Claude Code 훅 — 명령을 실행해요',
  mcp: 'MCP 서버 — 프로그램을 실행해요',
  envrc: 'direnv — 폴더에 들어가면 실행돼요',
  tasks: 'VS Code 작업 — 명령을 실행해요',
  shell: 'Windows 바로 가기 · 폴더 설정',
  claude: 'Claude Code 설정 — 명령 실행 · 환경 변수 · 플러그인 · 권한 · MCP 서버를 미리 설정해요',
  codex: 'Codex 설정 — 명령 · MCP 서버를 실행할 수 있어요',
  vscode: 'VS Code 설정 · 실행 구성 — 명령을 실행할 수 있어요',
  tools: '도구 버전 설정(mise · asdf) — 폴더에 들어가면 도구를 받거나 실행해요',
  run: '폴더 맨 위의 실행 파일 — Windows 터미널에서 같은 이름의 명령 대신 실행될 수 있어요',
}
export const seatWhy = (w) => WHY[w] || '지금은 할 수 없어요 — 잠시 뒤에 다시 해 주세요.'
