// Documents an agent produced (한글·Word·PowerPoint·Excel·PDF) open in the IeumOffice editor
// (process-gpt office-host, proxied at /office) instead of being downloaded. The editor loads a
// document by URL from Supabase storage and saves the edited copy next to it, so every card needs
// a public storage URL: office-mcp results already carry one; files the agent wrote in its sandbox
// are published to the `files` bucket first.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { admin } from './supa.js'
import { workspaceHostPath } from './missions.js'
import { isEn } from './lang.js'

// same table as process-gpt's src/utils/officeEditor.js EDITOR_BY_EXT
export const EDITOR_BY_EXT = {
  docx: 'docs', odt: 'docs', xlsx: 'sheets', xlsm: 'sheets', xls: 'sheets', csv: 'sheets', pptx: 'slides',
  pdf: 'pdf', hwp: 'hwp', hwpx: 'hwp',
  // ArtCraft web apps (src/craftEditor.js)
  dxf: 'cadcraft', dwg: 'cadcraft',
  svg: 'vectorcraft', vectorcraft: 'vectorcraft',
  psd: 'photocraft', psb: 'photocraft', pcraft: 'photocraft', png: 'photocraft', jpg: 'photocraft', jpeg: 'photocraft', webp: 'photocraft',
  wav: 'soundcraft', mp3: 'soundcraft', flac: 'soundcraft', soundcraft: 'soundcraft', scraftz: 'soundcraft',
  mp4: 'filmcraft', mov: 'filmcraft', webm: 'filmcraft', fcproj: 'filmcraft',
}
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf', hwpx: 'application/hwp+zip', hwp: 'application/x-hwp', csv: 'text/csv',
  dxf: 'image/vnd.dxf', dwg: 'image/vnd.dwg', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  psd: 'image/vnd.adobe.photoshop', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
}
export const extOf = (name) => String(name || '').split('?')[0].split('.').pop().toLowerCase()
export const editable = (name) => !!EDITOR_BY_EXT[extOf(name)]

// A tool result in any of the shapes deepagents streams it (object, JSON, `content='{…}'`,
// `content=[{'type':'text','text':'{…}'}]`) → the object inside, like process-gpt's parseMcpToolOutput.
export function parseToolOutput(raw) {
  if (raw && typeof raw === 'object') return Array.isArray(raw) ? parseToolOutput(raw[0]?.text ?? raw[0]) : raw
  const s = String(raw || '')
  const tries = [s, s.match(/'text':\s*'(\{.*\})'/s)?.[1], s.match(/"text":\s*"(\{.*\})"/s)?.[1]?.replace(/\\"/g, '"'), s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)]
  for (const t of tries) {
    if (!t) continue
    try { const v = JSON.parse(t); if (v && typeof v === 'object') return v } catch { /* next shape */ }
    try { const v = JSON.parse(t.replace(/'/g, '"')); if (v && typeof v === 'object') return v } catch { /* next shape */ }
  }
  return null
}

// office-mcp (generate_hwpx / generate_docx / store_and_render_hwpx) and the IeumOffice MCP both
// answer with {file_url, file_name}.
export function documentFrom(output) {
  const o = parseToolOutput(output)
  const url = o?.file_url || o?.fileUrl
  const name = o?.file_name || o?.fileName || (url ? decodeURIComponent(url.split('?')[0].split('/').pop()) : '')
  return url && editable(name) ? { name: name.replace(/^[0-9a-f-]{36}_/, ''), url, ext: extOf(name) } : null
}

// A sandbox file → a public URL the editor can load.
export async function publish(userId, sandboxPath) {
  const host = await workspaceHostPath(sandboxPath)
  const buf = await fs.readFile(host)
  const name = path.basename(sandboxPath)
  // storage keys must be ASCII; the name the user sees travels with the card
  const key = `pgpt-pro/${userId}/${crypto.randomUUID()}.${extOf(name)}`
  const { error } = await admin.storage.from('files').upload(key, buf, { contentType: MIME[extOf(name)] || 'application/octet-stream', upsert: false })
  if (error) throw error
  return { name, url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}`, ext: extOf(name) }
}

// Documents the agent wrote with its own scripts (docx/pptx/xlsx skills) never show up as
// file_artifact events: look for them in the paths the answer names and in the run's folder.
const EXT = '(?:docx|pptx|xlsx|xls|csv|pdf|hwpx|hwp|dxf|dwg|svg|vectorcraft|psd|psb|pcraft|png|jpe?g|webp|wav|mp3|flac|soundcraft|scraftz|mp4|mov|webm|fcproj)'
// a quoted path may hold spaces ("/workspace/11월 고객 세미나 예산표.xlsx"); a bare one may not
const QUOTED_RE = new RegExp(`[\`*"'](\\/workspace\\/[^\`*"'\\n]+?\\.${EXT})[\`*"']`, 'g')
const BARE_RE = new RegExp(`\\/workspace\\/[^\\s"'\`)\\]]+?\\.${EXT}\\b`, 'g')
export async function documentsOfRun({ text, dirs, since }) {
  const t = String(text || '')
  // a markdown link carries the path URL-encoded ("견적서%20초안.xlsx"); the file on disk is not
  const decode = (p) => { try { return decodeURIComponent(p) } catch { return p } }
  const found = new Set([...[...t.matchAll(QUOTED_RE)].map((m) => m[1]), ...(t.match(BARE_RE) || [])].map(decode))
  // the top of the tenant workspace, where an agent sometimes saves without a run folder. Every
  // user's runs share it, so a new file there counts only when this answer names it (by file
  // name); otherwise another person's document saved meanwhile would turn up in this chat.
  for (const dir of ['/workspace', ...dirs]) {
    const host = await workspaceHostPath(dir).catch(() => null)
    if (!host) continue
    const walk = async (d, depth) => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name)
        if (e.isDirectory() && dir !== '/workspace' && depth < 2 && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(p, depth + 1)
        else if (e.isFile() && editable(e.name) && (dir !== '/workspace' || t.includes(e.name)) && (await fs.stat(p)).mtimeMs >= since) found.add(path.join(dir, path.relative(host, p)))
      }
    }
    await walk(host, 0)
  }
  // a path the answer only mentions is not a document unless it is on disk
  const real = []
  for (const p of found) if (await workspaceHostPath(p).then((h) => fs.stat(h)).catch(() => null)) real.push(p)
  return real
}

// ArtCraft apps (mcp/craft.js): which ones a message asks to make or edit something with. The
// hints below and the per-user tool activation both go by this, so "summarise this YouTube video"
// brings in neither the hint nor FilmCraft's tools.
const MAKE = '(만들|그려|제작|편집|합성|디자인|자르|잘라|붙여|합쳐|이어|믹스|보정|바꿔|넣어|고쳐|내보내|작곡|녹음해|입혀|깔아)'
const CRAFT_ASKS = {
  cadcraft: /도면|캐드|\bcad\b|dxf|dwg|평면도|설계도|배치도/i,
  vectorcraft: '(벡터|로고|아이콘|배너|일러스트|svg|도형 그림|포스터 디자인)',
  photocraft: '(사진|이미지|psd|포토샵|썸네일|합성|레이어)',
  soundcraft: '(오디오|음악|음원|효과음|배경음|알림음|멜로디|징글|bgm|사운드|녹음|wav|mp3|믹스)',
  filmcraft: '(영상|동영상|비디오|클립|mp4|숏폼|쇼츠)',
}
// the same asks in English ("draw a floor plan", "make a logo", "trim the video") — whatever the mode,
// since a person may write either way
const MAKE_EN = '\\b(make|draw|create|design|edit|cut|trim|crop|merge|combine|join|mix|retouch|change|put|add|fix|export|compose|record|render|turn)'
const CRAFT_ASKS_EN = {
  cadcraft: /floor\s*plan|\bcad\b|\bdxf\b|\bdwg\b|blueprint|layout drawing|site plan|technical drawing/i,
  vectorcraft: '\\b(vector|logo|icon|banner|illustration|svg|poster design)',
  photocraft: '\\b(photo|image|picture|psd|photoshop|thumbnail|layers?)\\b',
  soundcraft: '\\b(audio|music|track|sound effect|background music|jingle|melody|bgm|sound|wav|mp3|ringtone|chime)\\b',
  filmcraft: '\\b(video|clip|mp4|footage|short-form|shorts|reel)\\b',
}
// naming the app is enough ("open it in PhotoCraft", "CADCraft로 그려 줘"): the names say what is wanted
// in either language, without a verb from MAKE — VectorCraft already worked that way by its "vector"
const CRAFT_NAMES = {
  cadcraft: /cad\s*-?craft|캐드\s*크래프트/i,
  vectorcraft: /vector\s*-?craft|벡터\s*크래프트/i,
  photocraft: /photo\s*-?craft|포토\s*크래프트/i,
  soundcraft: /sound\s*-?craft|사운드\s*크래프트/i,
  filmcraft: /film\s*-?craft|필름\s*크래프트/i,
}
export function craftAppsFor(text) {
  const t = String(text || '')
  const asks = (table, make) => Object.entries(table).filter(([, what]) => what instanceof RegExp
    ? what.test(t)
    : new RegExp(`${what}[^.?!\n]{0,40}${make}|${make}[^.?!\n]{0,40}${what}`, 'i').test(t)).map(([app]) => app)
  const named = Object.entries(CRAFT_NAMES).filter(([, re]) => re.test(t)).map(([app]) => app)
  return [...new Set([...named, ...asks(CRAFT_ASKS, MAKE), ...asks(CRAFT_ASKS_EN, MAKE_EN)])]
}
const CRAFT_HINTS = {
  cadcraft: '도면(CAD)은 CADCraft 도구(cadcraft_command_line·cadcraft_script·cadcraft_execute·cadcraft_inspect_drawing·cadcraft_render·cadcraft_save)로 그리세요. 단위는 미터(1 = 1m)로 하고, 치수를 넣기 전에 반드시 cadcraft_execute {"command":"dimstyle","params":{"name":"M","current":true,"DIMTXT":0.2,"DIMASZ":0.15,"DIMEXO":0.1,"DIMEXE":0.1,"DIMGAP":0.05,"DIMSCALE":1,"DIMDEC":2}} 로 치수 스타일을 만드세요(기본 스타일은 미터 도면에 글자가 너무 큽니다). 방 이름 글자 높이는 0.3, 문·창 표시는 0.2, 치수선은 벽에서 0.8m 바깥에 두세요. 그린 뒤 cadcraft_render 로 직접 보고 겹치는 글자·치수가 있으면 고친 다음, cadcraft_save 로 이 대화 전용 산출물 폴더(📁 섹션의 base, /workspace/.bpmn/<대화>/) 아래 .dxf 파일(예: <base>/평면도.dxf)에 저장하고 답에 그 경로를 적으세요.',
  vectorcraft: '벡터 그림(로고·배너·아이콘·SVG)은 VectorCraft 도구(vectorcraft_draw_shape·vectorcraft_add_text·vectorcraft_set_paint·vectorcraft_transform·vectorcraft_command_run·vectorcraft_render_preview·vectorcraft_save_file)로 만드세요. 글자는 웹 편집기에도 있는 NanumGothic 글꼴로 쓰고, 필요하면 vectorcraft_command_run 으로 대지 크기부터 맞추고, vectorcraft_render_preview 로 직접 본 뒤 vectorcraft_save_file 로 이 대화 전용 산출물 폴더(📁 섹션의 base, /workspace/.bpmn/<대화>/) 아래 .svg(예: <base>/배너.svg)에 저장하고 답에 그 경로를 적으세요.',
  photocraft: '사진·이미지 편집(레이어·보정·합성·글자)은 PhotoCraft 도구(photocraft_doc_new·photocraft_doc_open·photocraft_doc_place·photocraft_command_run·photocraft_doc_render_preview·photocraft_doc_save)로 하세요(VectorCraft 로 만들지 마세요). 글자는 웹 편집기에도 있는 NanumGothic 글꼴로 쓰세요. 첨부 이미지는 photocraft_doc_open 으로 열고, 결과는 photocraft_doc_save 로 이 대화 전용 산출물 폴더(📁 섹션의 base, /workspace/.bpmn/<대화>/) 아래 .psd(레이어 유지, 예: <base>/썸네일.psd)에 저장한 뒤 답에 그 경로를 적으세요.',
  soundcraft: '오디오(트랙 배치·자르기·믹스다운)는 SoundCraft 도구(soundcraft_new_session·soundcraft_import_audio·soundcraft_execute·soundcraft_batch·soundcraft_inspect_session·soundcraft_bounce_mix)로 하세요. 결과는 soundcraft_bounce_mix 로 이 대화 전용 산출물 폴더(📁 섹션의 base, /workspace/.bpmn/<대화>/) 아래 .wav(예: <base>/배경음.wav)로 내보내고 답에 그 경로를 적으세요.',
  filmcraft: '영상 편집은 FilmCraft 도구(filmcraft_command_run·filmcraft_media_import·filmcraft_project_inspect·filmcraft_sequence_inspect·filmcraft_render_frame)로 하세요: file.newProject → 소재 가져오기(사용자 파일은 /workspace 경로로 filmcraft_media_import, 풍경 데모 영상은 filmcraft_command_run file.importDemoFootage {scene: OceanSunset|Aurora|CityNight|Dunes|Plasma|Forest}) → file.newSequenceFromClip(1920x1080 데모 클립이면 그대로 꽉 참), 자르기·자막·효과는 filmcraft_command_list 의 명령으로. filmcraft_render_frame 으로 장면을 확인한 뒤 filmcraft_command_run file.exportMedia {path:<base>/<이름>.mp4, format:"h264"}(<base> = 이 대화 전용 산출물 폴더(📁 섹션의 base, /workspace/.bpmn/<대화>/)) 로 내보내고 답에 그 경로를 적으세요.',
}

// English mode: the same instructions, with English example file names (the agent names its files after them)
const CRAFT_HINTS_EN = {
  cadcraft: 'Draw drawings (CAD) with the CADCraft tools (cadcraft_command_line · cadcraft_script · cadcraft_execute · cadcraft_inspect_drawing · cadcraft_render · cadcraft_save). Use metres (1 = 1 m), and before adding dimensions always create a dimension style with cadcraft_execute {"command":"dimstyle","params":{"name":"M","current":true,"DIMTXT":0.2,"DIMASZ":0.15,"DIMEXO":0.1,"DIMEXE":0.1,"DIMGAP":0.05,"DIMSCALE":1,"DIMDEC":2}} (the default style makes text far too large in a metre drawing). Room name text height 0.3, door/window marks 0.2, dimension lines 0.8 m outside the walls. Write room names and labels in English. After drawing, look at it with cadcraft_render, fix overlapping text or dimensions, then save it with cadcraft_save as a .dxf file under this conversation\'s own output folder (the base in the 📁 section, /workspace/.bpmn/<conversation>/), e.g. <base>/floor-plan.dxf, and give that path in your answer.',
  vectorcraft: 'Make vector pictures (logos, banners, icons, SVG) with the VectorCraft tools (vectorcraft_draw_shape · vectorcraft_add_text · vectorcraft_set_paint · vectorcraft_transform · vectorcraft_command_run · vectorcraft_render_preview · vectorcraft_save_file). Use the NanumGothic font, which the web editor also has; set the artboard size first with vectorcraft_command_run if needed, look at it with vectorcraft_render_preview, then save it with vectorcraft_save_file as .svg under this conversation\'s own output folder (the base in the 📁 section, /workspace/.bpmn/<conversation>/), e.g. <base>/banner.svg, and give that path in your answer.',
  photocraft: 'Edit photos and images (layers, adjustments, compositing, text) with the PhotoCraft tools (photocraft_doc_new · photocraft_doc_open · photocraft_doc_place · photocraft_command_run · photocraft_doc_render_preview · photocraft_doc_save) — not with VectorCraft. Use the NanumGothic font, which the web editor also has. Open attached images with photocraft_doc_open, and save the result with photocraft_doc_save as .psd (keeps the layers) under this conversation\'s own output folder (the base in the 📁 section, /workspace/.bpmn/<conversation>/), e.g. <base>/thumbnail.psd, then give that path in your answer.',
  soundcraft: 'Work on audio (placing tracks, trimming, mixdown) with the SoundCraft tools (soundcraft_new_session · soundcraft_import_audio · soundcraft_execute · soundcraft_batch · soundcraft_inspect_session · soundcraft_bounce_mix). Export the result with soundcraft_bounce_mix as .wav under this conversation\'s own output folder (the base in the 📁 section, /workspace/.bpmn/<conversation>/), e.g. <base>/background-music.wav, and give that path in your answer.',
  filmcraft: 'Edit video with the FilmCraft tools (filmcraft_command_run · filmcraft_media_import · filmcraft_project_inspect · filmcraft_sequence_inspect · filmcraft_render_frame): file.newProject → bring in footage (the user\'s files by their /workspace path with filmcraft_media_import, scenic demo footage with filmcraft_command_run file.importDemoFootage {scene: OceanSunset|Aurora|CityNight|Dunes|Plasma|Forest}) → file.newSequenceFromClip (a 1920x1080 demo clip fills it as it is); trimming, captions and effects with the commands in filmcraft_command_list. Check scenes with filmcraft_render_frame, then export with filmcraft_command_run file.exportMedia {path:<base>/<name>.mp4, format:"h264"} (<base> = this conversation\'s own output folder, the base in the 📁 section, /workspace/.bpmn/<conversation>/), with an English file name, and give that path in your answer.',
}

// A hint for requests that ask for a document, so the agent reaches for the office tools.
export function officeHint(text, templateUrl) {
  if (isEn()) return officeHintEn(text, templateUrl)
  const hints = []
  if (/한글|hwpx|\bhwp\b|아래아/i.test(text) && templateUrl) {
    const inSandbox = templateUrl.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/])/, '//host.docker.internal')
    hints.push(`한글(hwpx)은 한국 표준 문서 형식입니다. 도구 목록에 generate_hwpx 가 있으면 그것을 호출하고(template_url="${templateUrl}", report_topic 에 문서 제목, report_description 에 넣을 내용 전부), 없으면 샌드박스에서 템플릿을 ${inSandbox} 로 받아 이 대화 전용 산출물 폴더(📁 섹션의 base, /workspace/.bpmn/<대화>/)에 .hwpx 파일로 만든 뒤 답에 그 경로를 적으세요. 도구가 있는지 없는지는 답에 쓰지 마세요.`)
  }
  if (/워드|word|docx|파워\s*포인트|ppt|발표\s*자료|슬라이드|엑셀|excel|xlsx|스프레드시트|pdf/i.test(text)) {
    hints.push('Word·PowerPoint·Excel·PDF 문서는 해당 스킬(docx/pptx/xlsx/pdf)로 이 대화 전용 산출물 폴더(📁 섹션의 base, /workspace/.bpmn/<대화>/)에 파일을 만들고, 답에 그 파일 경로를 적으세요.')
  }
  for (const app of craftAppsFor(text)) hints.push(CRAFT_HINTS[app])
  return hints.length ? `\n\n(${hints.join(' ')})` : ''
}
function officeHintEn(text, templateUrl) {
  const hints = []
  if (/한글|hwpx|\bhwp\b|아래아|hangul/i.test(text) && templateUrl) {
    const inSandbox = templateUrl.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/])/, '//host.docker.internal')
    hints.push(`Hangul (hwpx) is the Korean standard document format. If generate_hwpx is in your tool list, call it (template_url="${templateUrl}", report_topic = the document title, report_description = everything that goes in it, and say it must be written in English); otherwise download the template in the sandbox from ${inSandbox} and make a .hwpx file in this conversation's own output folder (the base in the 📁 section, /workspace/.bpmn/<conversation>/), then give its path in your answer. Don't mention in your answer whether the tool was there.`)
  }
  if (/워드|word|docx|파워\s*포인트|power\s*point|ppt|발표\s*자료|presentation|slides?|deck|슬라이드|엑셀|excel|xlsx|spreadsheet|스프레드시트|pdf|proposal|quote|quotation|estimate|report|document/i.test(text)) {
    hints.push('Make Word, PowerPoint, Excel and PDF documents with the matching skill (docx/pptx/xlsx/pdf) in this conversation\'s own output folder (the base in the 📁 section, /workspace/.bpmn/<conversation>/), with English file names and English text inside, and give the file path in your answer.')
  }
  for (const app of craftAppsFor(text)) hints.push(CRAFT_HINTS_EN[app])
  return hints.length ? `\n\n(${hints.join(' ')})` : ''
}

// office-mcp republishes a sandbox document under an ASCII-only name ("edited--_-2026-10-30_…");
// the name the agent gave it is in its answer.
export function displayName(doc, answer) {
  if (!/^edited-|--_|^[0-9a-f]{32}_/.test(doc.name)) return doc.name
  const t = String(answer || '')
  // a quoted name may hold spaces ("**11월 고객 세미나 안내문.hwpx**"); a bare one may not
  const quoted = [...t.matchAll(new RegExp(`[\`*"'](?:[^\`*"'\\n]*\\/)?([^\`*"'\\n/]+\\.${doc.ext})[\`*"']`, 'g'))].map((m) => m[1].trim())
  const bare = [...t.matchAll(new RegExp(`([^\\s*\`/'"()\\[\\]]+\\.${doc.ext})\\b`, 'g'))].map((m) => m[1])
  return [...quoted, ...bare].find((n) => !/^edited-/.test(n)) || doc.name
}
