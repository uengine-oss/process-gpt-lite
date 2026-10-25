// Registers each connector in process-gpt's own registries, so the rest of process-gpt sees them:
//   systems              — the business-system registry (process generator's "외부 시스템 가이드",
//                          system map). One row per connector, id `<tenant>__pgpt-<name>`.
//   mcp-hub mcp_server   — how the system is reached. One server per connector (/mcp/<name>),
//                          tagged `system:<systems.id>` to link the two.
//   external_api_health  — connection health shown next to the system.
import { config } from '../config.js'
import { q } from './supa.js'
import { CONNECTORS, hubServerName } from '../mcp/connectors.js'
import { CRAFT_APPS } from '../mcp/craft.js'
import { OFFICE_MCP } from '../mcp/office.js'

const HUB = process.env.PRO_MCP_HUB_URL || 'http://127.0.0.1:8500'
// mcp-hub validates from inside its container; the engines (deepagents) may run on the host.
const VALIDATE_BASE = process.env.PRO_MCP_VALIDATE_BASE || 'http://host.docker.internal:8787'
const RUNTIME_BASE = process.env.PRO_MCP_RUNTIME_BASE || 'http://localhost:8787'

const META = {
  google: { name: 'Google Workspace', category: '협업·문서', link: 'https://workspace.google.com', desc: '사용자 본인 계정의 Gmail·Google 캘린더·Drive. 일정 조회·등록, 메일 검색·초안, 문서 검색·읽기.' },
  youtube: { name: 'YouTube', category: '외부 정보원', link: 'https://www.youtube.com', desc: '채널의 최근 영상 목록, 영상 정보, 자막 트랜스크립트(공개 데이터).' },
  slack: { name: 'Slack', category: '협업·메신저', link: 'https://slack.com', desc: '채널 목록, 채널 메시지 읽기, 메시지 보내기(사용자 토큰).' },
  github: { name: 'GitHub', category: '개발', link: 'https://github.com', desc: '이슈·PR 검색, 내 PR 목록, 이슈 생성(사용자 토큰).' },
  notion: { name: 'Notion', category: '협업·문서', link: 'https://www.notion.so', desc: '페이지 검색·읽기·작성(통합 토큰).' },
  vectorcraft: { name: 'VectorCraft', category: '디자인·그래픽', link: 'https://getartcraft.com/apps/vectorcraft', desc: 'SVG·PDF 벡터 그림(로고·도형·글자·그래프) 만들기·편집·내보내기(VectorCraft 오픈소스, 계정 불필요). 편집은 채팅 카드에서 웹 VectorCraft로.' },
  photocraft: { name: 'PhotoCraft', category: '디자인·그래픽', link: 'https://getartcraft.com/apps/photocraft', desc: 'PSD 레이어 이미지·사진 편집·합성·내보내기(PhotoCraft 오픈소스, 계정 불필요). 편집은 채팅 카드에서 웹 PhotoCraft로.' },
  soundcraft: { name: 'SoundCraft', category: '오디오', link: 'https://getartcraft.com/apps/soundcraft', desc: '멀티트랙 오디오 세션 만들기·가져오기·믹스다운(SoundCraft 오픈소스, 계정 불필요). 편집은 채팅 카드에서 웹 SoundCraft로.' },
  filmcraft: { name: 'FilmCraft', category: '영상', link: 'https://getartcraft.com/apps/filmcraft', desc: '영상 편집 프로젝트·클립 가져오기·자르기·프레임 렌더(FilmCraft 오픈소스, 계정 불필요). 편집은 채팅 카드에서 웹 FilmCraft로.' },
  folders: { name: '공유 폴더', category: '협업·문서', link: 'http://localhost:5180/folders', desc: '여럿이 함께 쓰는 공유 폴더(드라이브)와 그 색인. 폴더·파일·문서 카드 요약 찾기(folder_catalog, folder_files). 사용자가 구성원인 폴더만 보임.' },
  panelapps: { name: '패널 앱', category: '협업·문서', link: 'http://localhost:5180/', desc: '공유 폴더의 스프레드시트를 데이터 원본으로 쓰는 Home 패널 앱(리드 관리·휴가 일수 관리 등). 앱 목록·만들기·행 조회·추가·수정(panel_app_list, panel_app_create, panel_app_rows, panel_app_add_row, panel_app_update_row). 폴더 구성원 권한을 따름.' },
  'ieumoffice-live-editor': { name: '이음오피스', category: '협업·문서', link: 'http://localhost:5180/', desc: '채팅 옆 이음오피스 편집기에 열린 워드·엑셀 문서를 사람이 보는 앞에서 읽고 고치기(office_live_*). 문서가 열려 있을 때만 도구가 보임. 새 문서 만들기는 office-mcp.' },
  cadcraft: { name: 'CADCraft', category: '설계·도면', link: 'https://getartcraft.com/apps/cadcraft', desc: 'DXF·DWG 도면 그리기·조회·렌더링(CADCraft 오픈소스 CAD, 계정 불필요). 편집은 채팅의 도면 카드에서 웹 CADCraft로.' },
}
// servers that are not account connectors (mcp/craft.js), registered the same way
const REGISTERED = [...CONNECTORS, ...Object.keys(CRAFT_APPS).map((name) => ({ name, title: name })), { name: 'folders', title: '공유 폴더' }, { name: 'panelapps', title: '패널 앱' }, { name: OFFICE_MCP, title: '이음오피스' }]

const hub = (path, opts = {}) => fetch(`${HUB}${path}`, {
  ...opts, headers: { 'X-Tenant-Id': config.tenantId, 'Content-Type': 'application/json', ...(opts.headers || {}) },
}).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }))

const systemId = (connector) => `${config.tenantId}__pgpt-${connector}`
const connection = (base, connector) => ({ transport: 'streamable-http', url: `${base}/mcp/${connector}`, headers: { Authorization: 'Bearer {{user_jwt}}' } })

async function ensureSystemRow(c) {
  const m = META[c.name] || { name: c.title, category: '외부 SaaS', desc: c.title }
  await q(`insert into systems (id, tenant_id, name, system_type, category, description, shortcut_link, is_active, registration_status, created_by, created_by_display)
           values ($1,$2,$3,'SaaS',$4,$5,$6,1,'active','pgpt-pro','pgpt-pro 커넥터')
           on conflict (id) do update set name=$3, category=$4, description=$5, shortcut_link=$6, updated_at=now(), deleted_at=null`,
  [systemId(c.name), config.tenantId, m.name, m.category, m.desc, m.link])
  return { id: systemId(c.name), ...m }
}

async function ensureHubServer(c, sys) {
  const name = hubServerName(c.name)
  const list = await hub('/servers')
  let srv = (Array.isArray(list.body) ? list.body : []).find((x) => x.name === name)
  if (!srv) {
    // validate against the URL the hub container can reach (fills the tool catalog), then
    // switch the active version to the URL the engines use when the two differ
    const created = await hub('/servers', { method: 'POST', body: JSON.stringify({
      name, display_name: `${sys.name} (pgpt-pro 커넥터)`, description: sys.desc, category: '외부 SaaS',
      tags: ['pgpt-pro', 'per-user', `system:${sys.id}`], connection: connection(VALIDATE_BASE, c.name), validate_on_create: true,
    }) })
    srv = created.body
    if (!srv?.id) throw new Error(`hub create ${name}: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`)
    if (srv.status !== 'active') await hub(`/servers/${srv.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) })
    if (RUNTIME_BASE !== VALIDATE_BASE) {
      const v = await hub(`/servers/${srv.id}/versions`, { method: 'POST', body: JSON.stringify({
        connection: connection(RUNTIME_BASE, c.name), change_note: '엔진 실행 주소(로컬: deepagents가 호스트에서 실행)',
      }) })
      if (v.body?.version) await hub(`/servers/${srv.id}/versions/${v.body.version}/activate`, { method: 'POST' })
    }
  } else if (!(srv.tags || []).includes(`system:${sys.id}`)) {
    await hub(`/servers/${srv.id}`, { method: 'PATCH', body: JSON.stringify({ tags: [...new Set([...(srv.tags || []), `system:${sys.id}`])] }) })
  }
  return srv
}

// health = the connector endpoint answers tools/list (anonymous catalog)
async function checkHealth(c, sys) {
  const url = `${RUNTIME_BASE}/mcp/${c.name}`
  let ok = false, err = null
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    const j = await r.json()
    ok = r.ok && Array.isArray(j.result?.tools) && j.result.tools.length > 0
    if (!ok) err = `HTTP ${r.status}`
  } catch (e) { err = e.message }
  const [row] = await q('select id from external_api_health where tenant_id=$1 and integration_target_name=$2', [config.tenantId, sys.name])
  if (row) {
    await q(`update external_api_health set call_address=$2, health_status=$3, error_message_log=$4, last_check_time=now(), updated_at=now() where id=$1`,
      [row.id, url, ok ? '정상' : '비정상', err])
  } else {
    await q(`insert into external_api_health (tenant_id, integration_target_name, call_address, health_status, error_message_log) values ($1,$2,$3,$4,$5)`,
      [config.tenantId, sys.name, url, ok ? '정상' : '비정상', err])
  }
}

export async function syncSystemRegistry() {
  const out = []
  for (const c of REGISTERED) {
    try {
      const sys = await ensureSystemRow(c)
      const srv = await ensureHubServer(c, sys)
      await checkHealth(c, sys)
      out.push({ connector: c.name, system: sys.id, hubServer: srv.id })
    } catch (e) {
      out.push({ connector: c.name, error: e.message })
    }
  }
  return out
}

export function startSystemRegistry() {
  const run = () => syncSystemRegistry().then((r) => {
    const bad = r.filter((x) => x.error)
    if (bad.length) console.warn('[systems]', bad)
  }).catch((e) => console.warn('[systems]', e.message))
  setTimeout(run, 3000)
  setInterval(() => REGISTERED.forEach(async (c) => checkHealth(c, { name: META[c.name]?.name || c.title }).catch(() => {})), 5 * 60000)
}

// The same guide the process-gpt frontend builds from getSystemList/getSystem: each registered
// system with the MCP tools that reach it, for prompts that design processes.
export async function systemGuide() {
  const rows = await q(`select id, name, category, description from systems where tenant_id=$1 and is_active=1 and deleted_at is null order by name`, [config.tenantId])
  if (!rows.length) return ''
  const servers = (await hub('/servers')).body
  const lines = []
  for (const r of rows) {
    const srv = (Array.isArray(servers) ? servers : []).find((x) => (x.tags || []).includes(`system:${r.id}`))
    let tools = []
    if (srv) {
      const t = (await hub(`/tools?server_id=${srv.id}`)).body
      tools = (Array.isArray(t) ? t : t.tools || []).map((x) => x.tool_name)
    }
    lines.push(`- ${r.name} (${r.category || '기타'}): ${r.description || ''}${srv ? ` — MCP 서버 ${srv.name}, 도구: ${tools.join(', ')}` : ''}`)
  }
  return lines.join('\n')
}
