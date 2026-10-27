// Panel apps (패널 앱): a small data app on Home whose data source is a spreadsheet in a shared
// folder — hark's "새 패널 만들기 → 구글 시트" with the shared folder + IeumOffice instead.
//   <folder>/apps/<이름>.panel.json   the app definition (fields, computed columns, views, form)
//   <folder>/apps/<이름>.xlsx         the data (row 1 = labels, hidden column A = row ID)
// Files are the source of truth (pro_panel_apps only indexes them for Home); every write is a
// row-level read-modify-write on the folder's main, committed with its author. Who may see or
// change an app is the folder's membership (lib/folders/service.js access()).
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q, admin } from '../supa.js'
import { emit } from '../bus.js'
import { chatJson } from '../llm.js'
import * as S from '../folders/service.js'
import { reindex } from '../folders/indexer.js'
import * as X from './sheet.js'
import * as R from './rules.js'
import * as D from './db.js'
import * as E from './events.js'
import * as PV from './privacy.js'

const err = (status, message) => Object.assign(new Error(message), { status })
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// ---------- design ----------
const DESIGN = `너는 중소기업 팀이 함께 쓰는 작은 업무용 데이터 앱(Home 패널)을 설계한다. 데이터는 스프레드시트 한 장에 행으로 쌓인다.
JSON 으로만 답한다:
{"kind":"data","title":"짧은 한국어 앱 이름(예: 리드 관리, 휴가 일수 관리)","icon":"이모지 1개","description":"한 문장",
 "sheet":"시트 이름(짧게)",
 "fields":[{"key":"영문 소문자 snake_case","label":"한국어 머리글","type":"text|longtext|number|date|choice|checkbox|email|phone|person","required":true|false,"choices":["choice 일 때만"],"default":값(선택)}],
 "computed":[{"key":"영문","label":"한국어","expr":"number 필드 key 와 숫자, + - * / 괄호만"}],
 "views":{"list":{"title":"목록 제목으로 보일 key","subtitle":["부제로 보일 key 1~2개"],"value":"오른쪽에 크게 보일 key(선택)","valueSuffix":"단위(선택, 예: 일, 원)","badge":"상태 배지 key(선택, choice 필드)","sort":{"key":"key","dir":"asc|desc"}},
          "summary":[{"label":"요약 이름","agg":"count|sum|avg|count_where","field":"key(count 제외)","eq":"count_where 의 값","suffix":"단위"}]},
 "form":["입력 폼 순서의 key"],
 "rows":[{"key":값}],
 "kind":"list|events",
 "subject":"기록의 대상이 되는 person 필드 key(있으면)",
 "tier":"sheet|db",
 "access":{"read":[규칙],"create":[규칙],"update":[규칙],"delete":[규칙]},   (tier 가 db 일 때만)
 "fieldRules":{"필드 key":{"update":[규칙]}}}                              (tier 가 db 일 때만, 선택)
규칙 어휘(이것만 쓴다. 목록 안의 규칙은 '또는', 모든 규칙은 폴더 구성원일 때만 적용):
 "member"(구성원 모두) · "role>=viewer|runner|editor|owner"(폴더 권한 이상) · "owner_of_row"(그 행을 만든 사람) · "nobody"
 {"field_is_me":"person 필드 key"}(그 항목이 본인) · {"field_equals":{"field":"key","value":값}}(항목이 그 값) · {"all":[규칙,…]}(모두 만족)
tier 고르기:
- 혼자 쓰거나 팀이 함께 고치는 단순 목록(내 할일, 리드 관리, 휴가 일수 표) → "sheet" (access 없음)
- 행마다 주인이 있고 "각자 자기 것만 고친다", "비공개는 본인만 본다", "승인은 팀장만" 같은 규칙이 있거나, 공유 캘린더·신청서처럼 여럿이 각자 등록하는 앱 → "db" 와 access
- 예: 공유 캘린더(각자 자기 일정만 고침, 비공개는 본인만) → read:["owner_of_row",{"field_equals":{"field":"visibility","value":"공개"}}], create:["member"], update:["owner_of_row","role>=owner"], delete:["owner_of_row","role>=owner"], visibility 는 choice ["공개","비공개"] default "공개"
- 예: 휴가 신청(본인 것만 수정, 승인은 편집 권한 이상만) → update:["owner_of_row","role>=editor"], fieldRules:{"approved":{"update":["role>=editor"]}}
- 시각은 type "time"(14:30), 사람은 type "person"(db 앱에서는 구성원 중 한 명).
보안 기본값: 모든 필드에 "sensitivity":"public|internal|personal|sensitive" 를 붙인다. 연락처·이메일·주소·생년월일·사번은 personal, 급여·평가·건강·병가·휴가 사유·개인 사유·주민번호·계좌·가족·징계는 sensitive.
kind 고르기: 잔액·수량·포인트·예산·승인 흐름처럼 "쌓이고 빠지는" 것(휴가, 재고, 포인트, 예산, 비품 대여)은 kind "events"(이벤트 소싱) 로 설계한다. 그 외 단순 목록은 "list".
kind 가 events 이면 fields/computed/views/form/rows 대신 이 모양으로 답한다:
{"kind":"events","title","icon","description",
 "entity":{"key":"member","label":"팀원","type":"person|text"},
 "fields":[{"key","label","type","choices","sensitivity"}],                       (모든 기록의 내용 항목 목록)
 "events":[{"type":"grant","label":"휴가 부여","fields":["days","note"],"required":["days"],"manager":true},
           {"type":"request","label":"휴가 신청","fields":["start","end","days","reason"],"required":["start","days"]},
           {"type":"cancel","label":"휴가 취소","fields":[],"ref":{"types":["request"],"mode":"cancel","inherit":["days"]}}],
 "projections":[{"kind":"balance","key":"summary","label":"요약","columns":[{"key":"granted","label":"부여","terms":[{"event":"grant","field":"days","op":"sum","sign":1}]},{"key":"used","label":"사용","terms":[{"event":"request","field":"days","op":"sum","sign":1},{"event":"cancel","field":"days","op":"sum","sign":-1}]}],"computed":[{"key":"left","label":"남은 일수","expr":"granted - used"}]},
                {"kind":"open","key":"pending","label":"신청 현황","event":"request","closedBy":["cancel"]}],
 "views":{"main":"summary","value":"left","valueSuffix":"일"}}
 - 기록은 고치거나 지우지 않는다: 잘못된 기록은 ref 가 있는 취소·정정 이벤트로 바로잡는다(취소는 원래 기록의 숫자를 inherit 해서 sign -1 로 뺀다).
 - 관리자만 하는 이벤트(부여·승인)는 "manager":true. op 는 sum|count|min|max, sign 은 1|-1.
규칙:
- 사용자가 앱 이름을 말했으면(예: "휴가 일수 관리 패널") title 은 그 이름 그대로("패널"·"만들어줘" 같은 말만 뺌).
- 필드는 4~9개. 사람이 실제로 적는 항목만. 계산되는 값은 fields 가 아니라 computed 로.
- 단계·상태·구분처럼 정해진 값은 choice 와 choices. 날짜는 date. 금액·일수·수량은 number.
- summary 는 1~3개(전체 건수, 합계, 특정 단계 건수 등).
- 요청에 처음 넣을 데이터가 있으면 rows 에 넣고, 없으면 rows 는 빈 배열. 데이터를 지어내지 않는다.
- 요청이 주가·날씨·환율·뉴스처럼 외부의 실시간 데이터를 보여 주는 위젯이면 {"kind":"live"} 만 답한다.`

// The one-call design is the biggest answer asked of the model (a record-keeping app especially). On a
// slow or stuck model it is cut off and done again in smaller steps: which kind of app, then only that
// kind's shape with the short prompt for it. Each call has its own limit and a token cap, so a model
// that runs on (JSON mode can pad with whitespace) cannot hold the request for minutes.
const DESIGN_MS = () => Number(process.env.PRO_PANEL_DESIGN_MS || 120000)
const KIND = `패널 앱 요청을 분류한다. JSON 으로만: {"kind":"live|events|data"}
- live: 주가·날씨·환율·뉴스처럼 외부 실시간 데이터를 보여 주는 위젯
- events: 잔액·수량·포인트·예산·장부·재고·휴가처럼 기록을 쌓아(배정·사용·취소) 계산하는 앱(이벤트 소싱)
- data: 그 밖의 목록·표(리드, 할 일, 일정, 신청서 …)`
const EVENTS_START = DESIGN.indexOf('kind 고르기:')
const EVENTS_PART = DESIGN.slice(DESIGN.indexOf('kind 가 events 이면'), DESIGN.indexOf('규칙:\n- 사용자가'))
const EVENTS_DESIGN = `너는 팀이 함께 쓰는 기록형(이벤트 소싱) 업무 앱을 설계한다. 모든 변경은 기록으로 쌓이고 잔액·현황은 기록에서 계산한다. JSON 으로만 답한다.
${EVENTS_PART.replace('kind 가 events 이면 fields/computed/views/form/rows 대신 이 모양으로 답한다:', '이 모양으로 답한다:')}
보안 기본값: 모든 필드에 "sensitivity":"public|internal|personal|sensitive" 를 붙인다(금액·수량은 internal, 사유·개인 정보는 personal 이상).
- 사용자가 앱 이름을 말했으면 title 은 그 이름 그대로. 필드는 3~7개, 이벤트는 2~4개, 프로젝션은 1~2개로 짧게.`
const LIST_DESIGN = DESIGN.slice(0, EVENTS_START) + DESIGN.slice(DESIGN.indexOf('규칙:\n- 사용자가'))
const looksEvents = (t) => /쌓|잔액|재고|포인트|예산|장부|부여|배정|지출|입출|대여|적립|차감|취소.*기록|기록.*취소/.test(t)

async function designInSteps(text) {
  const k = await chatJson(KIND, text, { temperature: 0, timeoutMs: 45000, maxTokens: 60 }).catch(() => null)
  const kind = ['live', 'events', 'data'].includes(k?.kind) ? k.kind : looksEvents(text) ? 'events' : 'data'
  if (kind === 'live') return { kind: 'live' }
  const out = await chatJson(kind === 'events' ? EVENTS_DESIGN : LIST_DESIGN, text, { temperature: 0.2, timeoutMs: DESIGN_MS(), maxTokens: 2500 })
  return kind === 'events' ? { ...out, kind: 'events' } : { ...out, kind: 'list' }
}

export async function design(description) {
  const text = String(description || '').slice(0, 2000)
  let out
  try {
    out = await chatJson(DESIGN, text, { temperature: 0.2, timeoutMs: DESIGN_MS(), maxTokens: 4000 })
  } catch (e) {
    console.warn('[panelApps] design:', e.message, '— trying the smaller design steps')
    try { out = await designInSteps(text) } catch (e2) {
      const slow = /abort|timeout|timed out/i.test(`${e.message} ${e2.message}`)
      throw err(503, slow ? '모델 응답이 늦어 패널 설계를 마치지 못했어요(시간 초과). 잠시 뒤 다시 요청해 주세요.' : `패널을 설계하지 못했어요: ${e2.message}`)
    }
  }
  if (out?.kind === 'live') return { kind: 'live' }
  // secure by default: sensitivity floor, database tier when something must stay hidden
  if (out?.kind === 'events') return { kind: 'data', def: E.normalizeEventsDef(out, { secure: true }), rows: [] }
  const def = X.normalizeDef(out, { secure: true })
  const rows = []
  for (const r of Array.isArray(out.rows) ? out.rows.slice(0, 50) : []) {
    try { rows.push(X.validate(def, r)) } catch { /* a seed row that does not fit is left out */ }
  }
  return { kind: 'data', def, rows }
}

// ---------- registry ----------
const fileSafe = (s) => String(s).replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '패널 앱'

async function pickFolder(user, text, title) {
  // a folder the request names and the person may edit
  const rows = await q(`select f.* from pro_folders f join pro_folder_members m on m.folder_id=f.id and m.principal_type='user' and m.principal_id=$2
                        where f.tenant_id=$1 and f.kind='managed' and m.role in ('owner','editor') order by length(f.name) desc`, [config.tenantId, String(user.id)])
  const named = rows.find((f) => text && f.name.length >= 2 && f.name !== title && (text.includes(`${f.name} 폴더`) || text.includes(`'${f.name}'`)))
  if (named) return named
  // folder names are unique in the tenant: someone else's '휴가 일수 관리' → '휴가 일수 관리 (박지수)'
  const taken = async (x) => (await q('select 1 from pro_folders where tenant_id=$1 and name=$2', [config.tenantId, x])).length
  let name = title
  if (await taken(name)) name = `${title} (${user.name})`
  for (let i = 2; await taken(name); i++) name = `${title} (${user.name}) ${i}`
  return S.createFolder(user, { name, description: `'${title}' 패널 앱의 데이터 폴더` })
}

export async function createApp(user, { description, def, rows = [], folderHint = '' }) {
  const folder = await pickFolder(user, `${folderHint} ${description || ''}`, def.title)
  const base = fileSafe(def.title)
  let defPath = `apps/${base}.panel.json`, sheetPath = `apps/${base}.xlsx`
  for (let i = 2; await fs.stat(path.join(folder.repo_path, defPath)).catch(() => null); i++) { defPath = `apps/${base} ${i}.panel.json`; sheetPath = `apps/${base} ${i}.xlsx` }
  await fs.mkdir(path.join(folder.repo_path, 'apps'), { recursive: true })
  const defText = defFileText(def, sheetPath)
  await fs.writeFile(path.join(folder.repo_path, defPath), defText)
  // tier db: the data lives in the database; the folder keeps the definition (and later snapshots)
  if (def.tier !== 'db') await fs.writeFile(path.join(folder.repo_path, sheetPath), await X.bookBuffer(def.kind === 'events' ? await E.eventsBook(def, []) : await X.newBook(def, rows)))
  await S.commitMain(folder, { name: user.name, email: user.email }, `패널 앱 만들기: ${def.title}${def.tier === 'db' ? ' (데이터베이스·행 단위 권한)' : ''}`)
  await reindex(folder, { cards: false }).catch((e) => console.warn('[panelApps] index', e.message))
  // privacy_ack false: the creator reviews the 보안·개인정보 기본값 card before sharing
  let [app] = await q(`insert into pro_panel_apps (folder_id, title, icon, def_path, sheet_path, def, def_sha, created_by, tier, kind, privacy_ack)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) returning *`, [folder.id, def.title, def.icon, defPath, sheetPath, def, sha1(defText), user.id, def.tier || 'sheet', def.kind || 'list'])
  if (def.tier === 'db') {
    try { await (def.kind === 'events' ? D.createEventsTable(app, folder.id, user) : D.createTable(app, folder.id, user)) } catch (e) { await q('delete from pro_panel_apps where id=$1', [app.id]); throw e }
    for (const r of rows) await D.insert(user, app, await personIds(folder, app.def, r)).catch((e) => console.warn('[panelApps] seed', e.message))
    ;[app] = await q('select * from pro_panel_apps where id=$1', [app.id])
  }
  const out = await summary(app, folder, 'owner')
  emit(user.id, 'panelapp', out)
  return out
}

async function summary(app, folder, role) {
  folder = folder || await S.folderById(app.folder_id)
  return { id: app.id, title: app.title, icon: app.icon, def: app.def, role, ...facts(app), folder: { slug: folder.slug, name: folder.name }, sheetPath: app.sheet_path, defPath: app.def_path, updated_at: app.updated_at }
}

// apps of every folder the person is a member of (unless they hid it from Home)
export async function listApps(user, { all = false } = {}) {
  const rows = await q(`select a.*, m.role, f.slug, f.name as folder_name, f.repo_path, coalesce(p.hidden,false) as hidden,
      (select count(*) from pro_folder_members x where x.folder_id=f.id and x.principal_type='user')::int as people
      from pro_panel_apps a join pro_folders f on f.id=a.folder_id
      join pro_folder_members m on m.folder_id=f.id and m.principal_type='user' and m.principal_id=$2
      left join pro_panel_app_prefs p on p.app_id=a.id and p.user_id=$3
      where f.tenant_id=$1 order by coalesce(p.sort, 100), a.created_at`, [config.tenantId, String(user.id), user.id])
  const out = []
  for (const a of rows) {
    if (a.hidden && !all) continue
    await refreshDef(a, { repo_path: a.repo_path }).catch(() => {})
    out.push({ id: a.id, title: a.title, icon: a.icon, def: a.def, role: a.role, hidden: a.hidden, people: a.people, ...facts(a), folder: { slug: a.slug, name: a.folder_name }, sheetPath: a.sheet_path, defPath: a.def_path, updated_at: a.updated_at })
  }
  return out
}

// the definition file may have been changed in the folder (workroom, upload, a merged variation)
async function refreshDef(app, folder) {
  // a db app's rules are guarded: the database copy is authoritative and changes only through
  // setRules/changeFields (folder owner). The file in the folder is the server's versioned copy.
  if (app.tier === 'db') return app
  const text = await fs.readFile(path.join(folder.repo_path, app.def_path), 'utf8').catch(() => null)
  if (!text) return app
  const sha = sha1(text)
  if (sha === app.def_sha) return app
  try {
    const def = X.normalizeDef(JSON.parse(text))
    await q('update pro_panel_apps set def=$2, def_sha=$3, title=$4, icon=$5, updated_at=now() where id=$1', [app.id, def, sha, def.title, def.icon])
    Object.assign(app, { def, def_sha: sha, title: def.title, icon: def.icon })
  } catch (e) { console.warn('[panelApps] definition', app.def_path, e.message) }
  return app
}

// the app, refused unless the person holds `need` in its folder
export async function appFor(user, id, need = 'viewer') {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) throw err(404, '패널 앱을 찾지 못했어요.')
  const [app] = await q('select * from pro_panel_apps where id=$1', [id])
  if (!app) throw err(404, '패널 앱을 찾지 못했어요.')
  const f = await S.folderById(app.folder_id)
  const { folder, role } = await S.access(f.slug, user, need)
  await refreshDef(app, folder)
  return { app, folder, role }
}

// an app the person names in chat ("휴가 일수 관리에 … 추가해줘")
export async function appNamed(user, text) {
  const apps = await listApps(user, { all: true })
  const t = String(text || '').replace(/\s+/g, '')
  return apps.filter((a) => t.includes(a.title.replace(/\s+/g, ''))).sort((a, b) => b.title.length - a.title.length)[0] || null
}

// ---------- rows ----------
const sheetFile = (folder, app) => path.join(folder.repo_path, app.sheet_path)
async function readSheet(folder, app) {
  const buf = await fs.readFile(sheetFile(folder, app)).catch(() => { throw err(404, '데이터 시트가 폴더에 없어요.') })
  return { buf, sha: sha1(buf), wb: await X.readBook(buf) }
}

export async function rows(user, id) {
  const { app, folder, role } = await appFor(user, id)
  if (app.kind === 'events') return eventRows(user, app, folder, role)
  if (app.tier === 'db') {
    const me = { id: user.id, rank: S.RANK[role] }
    const list = (await D.rows(user, app)).map((r) => ({ ...r, _can: R.rowCan(app.def, r, me) }))
    const access = R.validateAccess(app.def, app.def, { strict: false })
    return { app: await summary(app, folder, role), rows: list, people: await peopleOf(folder), canCreate: R.allows(access.access.create, null, me), me: user.id }
  }
  const { wb, sha } = await readSheet(folder, app)
  return { app: await summary(app, folder, role), rows: X.readRows(wb, app.def), sha }
}

// one write at a time per app (this server is the only writer of panel changes)
const queues = new Map()
function serial(key, fn) {
  const prev = queues.get(key) || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  const tail = next.catch(() => {}).finally(() => { if (queues.get(key) === tail) queues.delete(key) })
  queues.set(key, tail)
  return next
}

async function members(folder) {
  return (await q(`select principal_id from pro_folder_members where folder_id=$1 and principal_type='user'`, [folder.id])).map((r) => r.principal_id)
}
async function broadcast(app, folder, by) {
  for (const uid of await members(folder)) emit(uid, 'panelapp.rows', { id: app.id, by: by?.name || null })
}

const titleOf = (def, vals) => String(vals?.[def.views.list.title] ?? '').slice(0, 30)

export async function write(user, id, op) {
  const { app: a0 } = await appFor(user, id, 'viewer')
  if (a0.kind === 'events') throw err(400, "이 앱은 기록을 쌓는 앱이에요. '기록 더하기'로 부여·신청·취소 같은 기록을 더해 주세요.")
  if (a0.tier === 'db') return writeDb(user, id, op)
  const { app, folder } = await appFor(user, id, 'editor')
  return serial(app.id, async () => {
    const { wb } = await readSheet(folder, app)
    let message
    if (op.add) { op = { add: X.validate(app.def, op.add) }; message = `패널: ${app.title} 행 추가 — ${titleOf(app.def, op.add)}` }
    else if (op.update) {
      op = { update: { ...op.update, vals: X.validate(app.def, op.update.vals, { partial: true }) } }
      message = `패널: ${app.title} 행 고침`
    } else if (op.remove) message = `패널: ${app.title} 행 지움`
    const res = X.applyOp(wb, app.def, op)
    await fs.writeFile(sheetFile(folder, app), await X.bookBuffer(wb))
    const after = X.readRows(wb, app.def)
    const row = after.find((r) => r._id === res.id) || null
    if (op.update && row) message += ` — ${titleOf(app.def, row)}`
    await S.commitMain(folder, { name: user.name, email: user.email }, message)
    await q('update pro_panel_apps set updated_at=now() where id=$1', [app.id])
    reindex(folder, { cards: false }).catch(() => {})
    await broadcast(app, folder, user)
    return { row, rows: after }
  })
}

// ---------- the sheet in IeumOffice ----------
// the editor loads documents only from storage: a content-addressed copy of the current file
export async function sheetCopy(user, id) {
  const { app, folder, role } = await appFor(user, id)
  if (app.kind === 'events') return eventsSheetCopy(user, app, folder, role)
  if (app.tier === 'db') return sheetSnapshotCopy(user, app, folder, role)
  const { buf, sha } = await readSheet(folder, app)
  const key = `pgpt-pro/panel-apps/${app.id}/${sha}.xlsx`
  const { error } = await admin.storage.from('files').upload(key, buf, { contentType: XLSX_MIME, upsert: true })
  if (error) throw err(500, `시트를 열 준비를 못 했어요: ${error.message}`)
  return { url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}`, name: path.posix.basename(app.sheet_path), sha, readOnly: S.RANK[role] < S.RANK.editor }
}

// the editor saved an edited copy to storage: it becomes the folder's file (unless the panel
// changed the file since the editor opened it — then nothing is overwritten)
async function fetchSaved(url) {
  const u = new URL(String(url || ''))
  const base = new URL(config.supabaseUrl)
  if (!u.pathname.startsWith('/storage/v1/object/') || (u.host !== base.host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.host))) throw err(400, '저장한 시트 주소가 올바르지 않아요.')
  const fetchFrom = u.host === base.host ? u : new URL(u.pathname + u.search, base)
  const res = await fetch(fetchFrom)
  if (!res.ok) throw err(502, `저장한 시트를 받지 못했어요(${res.status}).`)
  return Buffer.from(await res.arrayBuffer())
}

export async function sheetSaved(user, id, { url, sha }) {
  const { app: a0 } = await appFor(user, id, 'viewer')
  if (a0.kind === 'events') return eventsSheetSaved(user, id, { url, sha })
  if (a0.tier === 'db') return sheetSavedDb(user, id, { url, sha })
  const { app, folder } = await appFor(user, id, 'editor')
  const buf = await fetchSaved(url)
  return serial(app.id, async () => {
    const cur = await readSheet(folder, app)
    if (sha && cur.sha !== sha && cur.sha !== sha1(buf)) throw err(409, '시트를 연 뒤 패널에서 데이터가 바뀌었어요. 시트를 다시 열어 고쳐 주세요.')
    const wb = await X.readBook(buf)
    const before = X.readRows(cur.wb, app.def)
    const after = X.readRows(wb, app.def)
    await fs.writeFile(sheetFile(folder, app), buf)
    const commit = await S.commitMain(folder, { name: user.name, email: user.email }, `시트에서 고침: ${app.title}`)
    await q('update pro_panel_apps set updated_at=now() where id=$1', [app.id])
    reindex(folder, { cards: false }).catch(() => {})
    await broadcast(app, folder, user)
    return { ok: true, commit, sha: sha1(buf), rows: after.length, changed: diffCount(app.def, before, after) }
  })
}
function diffCount(def, a, b) {
  const key = (r) => JSON.stringify(def.fields.map((f) => r[f.key] ?? ''))
  const A = new Set(a.map(key))
  return b.filter((r) => !A.has(key(r))).length + Math.max(0, a.length - b.length)
}

// ---------- home & lifecycle ----------
export async function hide(user, id, hidden = true) {
  const { app } = await appFor(user, id)
  await q(`insert into pro_panel_app_prefs (user_id, app_id, hidden) values ($1,$2,$3) on conflict (user_id, app_id) do update set hidden=$3`, [user.id, app.id, hidden])
  return { ok: true }
}

export async function remove(user, id) {
  const { app, folder } = await appFor(user, id, 'owner')
  const ids = await members(folder)
  await fs.rm(path.join(folder.repo_path, app.def_path), { force: true })
  await fs.rm(path.join(folder.repo_path, app.sheet_path), { force: true })
  await S.commitMain(folder, { name: user.name, email: user.email }, `패널 앱 지우기: ${app.title}`)
  if (app.tier === 'db') await D.logMigration(app, 'drop', await D.dropTable(app), { destructive: true, user })
  await q('delete from pro_panel_apps where id=$1', [app.id])
  reindex(folder, { cards: false }).catch(() => {})
  for (const uid of ids) emit(uid, 'panelapp.deleted', { id: app.id })
  return { ok: true }
}

// someone was added to (or removed from) the folder: their Home picks the app up
export async function announce(folderSlug) {
  const folder = await S.folderBySlug(folderSlug)
  if (!folder) return
  for (const uid of await members(folder)) emit(uid, 'panelapp.changed', { folder: folder.slug })
}

// chat-facing text: the app's fields in words, for the router and answers
export function describe(def) {
  if (def.kind === 'events') return `기록 종류: ${def.events.map((e) => e.label).join(', ')} · 대상: ${def.entity.label} · 보기: ${def.projections.map((p) => p.label).join(', ')}`
  const f = def.fields.map((x) => `${x.label}${x.type === 'choice' ? `(${x.choices.join('/')})` : x.type === 'number' ? '(숫자)' : x.type === 'date' ? '(날짜)' : ''}${x.required ? '*' : ''}`)
  const c = def.computed.map((x) => `${x.label}=${x.expr.replace(/[a-z_][a-z0-9_]*/g, (k) => def.fields.find((y) => y.key === k)?.label || k)}`)
  return `${f.join(', ')}${c.length ? ` · 계산: ${c.join(', ')}` : ''}`
}

// ---------- tier db ----------
const defFileText = (def, sheetPath) => JSON.stringify({ ...def, sheetFile: path.posix.basename(sheetPath) }, null, 2)

async function peopleOf(folder) {
  return q(`select m.principal_id as id, coalesce(p.name, u.username, m.principal_id) as name, m.role
            from pro_folder_members m left join users u on u.id::text = m.principal_id and u.tenant_id=$2
            left join pro_profile p on p.user_id::text = m.principal_id
            where m.folder_id=$1 and m.principal_type='user'`, [folder.id, config.tenantId])
}
// person fields hold a member's user id; people (and the model) write names or e-mails
async function personIds(folder, def, vals) {
  const pf = def.fields.filter((f) => f.type === 'person' && vals[f.key])
  if (!pf.length) return vals
  const people = await peopleOf(folder)
  const out = { ...vals }
  for (const f of pf) {
    const v = String(vals[f.key]).trim()
    const p = people.find((x) => x.id === v || x.name === v || x.name?.replace(/\s/g, '') === v.replace(/\s/g, ''))
    if (!p) throw Object.assign(err(422, `'${f.label}'에는 이 폴더 구성원만 넣을 수 있어요: ${v}`), { problems: [] })
    out[f.key] = p.id
  }
  return out
}

async function writeDb(user, id, op) {
  const { app, folder } = await appFor(user, id, 'viewer')
  let row = null
  if (op.add) row = await D.insert(user, app, await personIds(folder, app.def, X.validate(app.def, op.add)))
  else if (op.update) row = await D.update(user, app, op.update.id, op.update.v, await personIds(folder, app.def, X.validate(app.def, op.update.vals, { partial: true })))
  else if (op.remove) await D.remove(user, app, op.remove.id, op.remove.v)
  await q('update pro_panel_apps set updated_at=now() where id=$1', [app.id])
  await broadcast(app, folder, user)
  const all = await D.rows(user, app)
  return { row, rows: all }
}

// The sheet of a db app is a view: a snapshot of what THIS person may read (RLS applied), under an
// unguessable storage key. Saving it back applies the differences row by row as that person.
const snapshots = new Map() // token -> {appId, userId, rows, at}
async function sheetSnapshotCopy(user, app, folder, role) {
  const people = await peopleOf(folder)
  const name = (id) => people.find((p) => p.id === id)?.name || id
  const rows = await D.rows(user, app)
  const shown = rows.map((r) => { const o = { ...r }; for (const f of app.def.fields) if (f.type === 'person' && o[f.key]) o[f.key] = name(o[f.key]); return o })
  const buf = await X.bookBuffer(await X.newBook(app.def, shown))
  const token = crypto.randomBytes(16).toString('hex')
  snapshots.set(token, { appId: app.id, userId: user.id, rows, at: Date.now() })
  for (const [k, v] of snapshots) if (Date.now() - v.at > 6 * 3600e3) snapshots.delete(k)
  const key = `pgpt-pro/panel-apps/${app.id}/v/${token}.xlsx`
  const { error } = await admin.storage.from('files').upload(key, buf, { contentType: XLSX_MIME, upsert: true })
  if (error) throw err(500, `시트를 열 준비를 못 했어요: ${error.message}`)
  return { url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}`, name: `${fileSafe(app.title)} (보기).xlsx`, sha: token, readOnly: false, snapshot: true, count: rows.length }
}

async function sheetSavedDb(user, id, { url, sha }) {
  const { app, folder } = await appFor(user, id, 'viewer')
  const snap = snapshots.get(String(sha || ''))
  if (!snap || snap.appId !== app.id || snap.userId !== user.id) throw err(409, '이 시트 보기는 만료됐어요. "시트 열기"로 다시 열어 고쳐 주세요.')
  const wb = await X.readBook(await fetchSaved(url))
  const saved = X.readRows(wb, app.def)
  const before = new Map(snap.rows.map((r) => [r._id, r]))
  const people = await peopleOf(folder)
  const norm = (f, v) => (f.type === 'person' ? (people.find((p) => p.name === v || p.id === v)?.id || v) : v)
  const titleOfRow = (r) => String(r?.[app.def.views.list.title] ?? '').slice(0, 30) || '(이름 없음)'
  const result = { applied: 0, rejected: [] }
  const seen = new Set()
  for (const r of saved) {
    const old = before.get(r._id)
    const vals = Object.fromEntries(app.def.fields.map((f) => [f.key, norm(f, r[f.key])]))
    try {
      if (!old) { await D.insert(user, app, X.validate(app.def, vals)); result.applied++; continue }
      seen.add(r._id)
      const changed = Object.fromEntries(app.def.fields.filter((f) => String(vals[f.key] ?? '') !== String(old[f.key] ?? '')).map((f) => [f.key, vals[f.key]]))
      if (!Object.keys(changed).length) continue
      await D.update(user, app, old._id, old._v, X.validate(app.def, changed, { partial: true }))
      result.applied++
    } catch (e) { result.rejected.push({ row: titleOfRow(r), reason: e.message }) }
  }
  for (const old of snap.rows) {
    if (seen.has(old._id)) continue
    try { await D.remove(user, app, old._id, old._v); result.applied++ } catch (e) { result.rejected.push({ row: titleOfRow(old), reason: `지우기: ${e.message}` }) }
  }
  // the editor stays open: the next save is compared with what this person sees now
  snapshots.set(String(sha), { ...snap, rows: await D.rows(user, app), at: Date.now() })
  if (result.applied) { await q('update pro_panel_apps set updated_at=now() where id=$1', [app.id]); await broadcast(app, folder, user) }
  return { ok: true, sha, changed: result.applied, rejected: result.rejected }
}

// owner: change the rules. A sheet app becomes a db app here (its rows are imported; their author is
// the person who last changed that row in the folder history when known, else the app's owner).
export async function setRules(user, id, { access, fieldRules }) {
  const { app, folder } = await appFor(user, id, 'owner')
  const def = X.normalizeDef({ ...app.def, tier: 'db', access, fieldRules }, { strict: true })
  if (app.tier !== 'db') {
    const { wb } = await readSheet(folder, app)
    const rowsNow = X.readRows(wb, app.def)
    const authors = await rowAuthors(folder, app, rowsNow)
    await q('update pro_panel_apps set def=$2 where id=$1', [app.id, def])
    const next = { ...app, def }
    await D.createTable(next, folder.id, user)
    const st = await D.importRows(next, rowsNow.map((r) => ({ ...r, _author: authors.get(r._id) || app.created_by })), app.created_by)
    await D.logMigration(next, 'upgrade', st, { user, note: `시트 ${rowsNow.length}행을 데이터베이스로 옮김` })
    await saveDefFile(user, folder, next, def, `패널 앱 권한 규칙: ${app.title} — 시트에서 데이터베이스로 옮김(행 ${rowsNow.length}개)`)
  } else {
    const st = R.rulesSql(def, app.id, folder.id)
    await D.asOwner(st)
    await D.logMigration(app, 'rules', st, { user })
    await saveDefFile(user, folder, app, def, `패널 앱 권한 규칙: ${app.title}`)
  }
  await audit(app, user, 'rules', { access: def.access, fieldRules: def.fieldRules })
  await announce(folder.slug)
  return rows(user, id)
}

// owner: add / change / remove fields of a db app. Dropping a column needs confirmDrop.
export async function changeFields(user, id, { fields, confirmDrop = false }) {
  const { app, folder } = await appFor(user, id, 'owner')
  if (app.tier !== 'db') throw err(400, '시트 앱의 항목은 시트에서 열을 고쳐 주세요.')
  const def = X.normalizeDef({ ...app.def, fields, form: undefined, tier: 'db' }, { strict: true })
  const { statements, destructive } = R.alterSql(app.def, def, app.id, folder.id)
  if (destructive.length && !confirmDrop) {
    const gone = app.def.fields.filter((f) => !def.fields.some((x) => x.key === f.key)).map((f) => f.label)
    throw Object.assign(err(409, `항목을 지우면 그 열의 데이터가 사라져요: ${gone.join(', ')}. 확인 후 다시 저장해 주세요.`), { problems: gone, needConfirm: true })
  }
  const all = [...destructive, ...statements]
  await D.asOwner(all)
  await D.logMigration(app, 'alter', all, { destructive: destructive.length > 0, user })
  await saveDefFile(user, folder, app, def, `패널 앱 항목 변경: ${app.title}`)
  await announce(folder.slug)
  return rows(user, id)
}

async function saveDefFile(user, folder, app, def, message) {
  const text = defFileText(def, app.sheet_path)
  await fs.mkdir(path.join(folder.repo_path, path.posix.dirname(app.def_path)), { recursive: true })
  await fs.writeFile(path.join(folder.repo_path, app.def_path), text)
  await q('update pro_panel_apps set def=$2, def_sha=$3, title=$4, icon=$5, tier=$6, updated_at=now() where id=$1', [app.id, def, sha1(text), def.title, def.icon, def.tier || 'sheet'])
  await S.commitMain(folder, { name: user.name, email: user.email }, message)
  reindex(folder, { cards: false }).catch(() => {})
}

// who last touched each row of a sheet app, from the folder history ("패널: … 행 추가 — <제목>"
// commits name the row by its title); unknown rows go to the app's owner
async function rowAuthors(folder, app, rowsNow) {
  const out = new Map()
  const people = await peopleOf(folder)
  const log = await S.history(folder, 400)
  for (const r of rowsNow) {
    const t = String(r[app.def.views.list.title] ?? '')
    const c = t && log.find((x) => x.msg.startsWith(`패널: ${app.title} 행 추가 — ${t}`))
    const p = c && people.find((x) => x.name === c.name)
    if (p) out.set(r._id, p.id)
  }
  return out
}

// editor+: save what any member may read (rules evaluated for a plain member who wrote none of the
// rows) to the folder as <앱>.xlsx — a backup that never carries a private row
export async function snapshot(user, id) {
  const { app, folder } = await appFor(user, id, 'editor')
  if (app.tier !== 'db') throw err(400, '시트 앱은 폴더의 시트가 곧 원본이에요.')
  if (app.kind === 'events') return eventsSnapshot(user, app, folder)
  const access = R.validateAccess(app.def, app.def, { strict: false }).access
  const everyone = { id: '00000000-0000-0000-0000-000000000000', rank: 1 }
  const all = await D.allRowsAsOwner(app)
  const visible = all.filter((r) => R.allows(access.read, r, everyone))
  const people = await peopleOf(folder)
  // personal / sensitive values never go into the folder (a member can open the file; the index reads it)
  const shown = visible.map((r) => { const o = { ...r }; for (const f of app.def.fields) { if (PV.restricted(f)) o[f.key] = '비공개'; else if (f.type === 'person' && o[f.key]) o[f.key] = people.find((p) => p.id === o[f.key])?.name || o[f.key] } return o })
  await fs.writeFile(sheetFile(folder, app), await X.bookBuffer(await X.newBook(app.def, shown)))
  const commit = await S.commitMain(folder, { name: user.name, email: user.email }, `스냅샷: ${app.title} (${visible.length}/${all.length}행, 구성원 모두가 볼 수 있는 행만)`)
  reindex(folder, { cards: false }).catch(() => {})
  return { ok: true, commit, rows: visible.length, hidden: all.length - visible.length, path: app.sheet_path }
}

export async function migrations(user, id) {
  const { app } = await appFor(user, id, 'owner')
  return q('select version, kind, destructive, applied_at, note, statements from pro_panel_app_migrations where app_id=$1 order by version', [app.id])
}

// ---------- facts shown with every app ----------
function facts(app) {
  const def = app.def
  const db = app.tier === 'db'
  return {
    tier: app.tier || 'sheet', kind: app.kind || def.kind || 'list',
    rules: db && def.kind !== 'events' ? R.describeRules(def) : null,
    eventRules: def.kind === 'events' ? E.describeEvents(def) : null,
    privacy: db || def.kind === 'events' ? PV.describePrivacy(def) : [{ kind: 'who', text: '폴더 구성원만 볼 수 있어요. 구성원은 모든 항목을 봐요(숨길 항목이 없는 시트 앱).' }],
    privacyAck: app.privacy_ack !== false,
  }
}

// ---------- audit ----------
export async function audit(app, user, action, detail = {}) {
  await q('insert into pro_panel_app_audit (app_id, user_id, action, detail) values ($1,$2,$3,$4)', [app.id, user?.id || null, action, detail]).catch((e) => console.warn('[panelApps] audit', e.message))
}
const sensitiveReads = new Map() // user:app -> last logged (a manager's reads are logged at most every 10 minutes)
async function auditSensitiveRead(app, user, n) {
  const k = `${user.id}:${app.id}`
  if (!n || Date.now() - (sensitiveReads.get(k) || 0) < 600000) return
  sensitiveReads.set(k, Date.now())
  await audit(app, user, 'read_sensitive', { records: n })
}

// ---------- kind events ----------
const nameOf = (people) => (id) => people.find((p) => p.id === id)?.name || id
const idOf = (people) => (v) => people.find((p) => p.name === v || p.id === v || p.name?.replace(/\s/g, '') === String(v).replace(/\s/g, ''))?.id || v

async function sheetLog(folder, app, people) {
  const { wb } = await readSheet(folder, app)
  return E.readLog(wb, app.def, { ids: idOf(people) })
}
const eventLog = async (user, app, folder, people) => (app.tier === 'db' ? D.events(user, app) : sheetLog(folder, app, people))

async function eventRows(user, app, folder, role) {
  const def = app.def
  const me = { id: user.id, rank: S.RANK[role] }
  const people = await peopleOf(folder)
  const log = await eventLog(user, app, folder, people)
  const { projections, closedBy } = E.replay(def, log)
  // restricted numbers: per person only for that person (and the folder owner); a team total only
  // when at least K_ANON people contribute (computed over the whole log by the server)
  const needsFull = def.projections.some((p) => p.kind === 'balance' && p.columns.some((c) => c.terms.some((t) => t.field && PV.restricted(def.fields.find((f) => f.key === t.field)))))
  const full = needsFull ? E.replay(def, app.tier === 'db' ? await D.eventsAsOwner(app) : log) : null
  const totals = E.maskBalances(def, projections, full?.projections, me)
  // what this person may append: about themselves, about others, and amendments of which events
  const types = def.events.map((e) => ({
    type: e.type, label: e.label, ref: e.ref || null, fields: e.fields, required: e.required,
    self: R.allows(e.who, { _subject: me.id, _created_by: me.id }, me),
    others: R.allows(e.who, { _subject: '(someone)', _created_by: me.id }, me),
  }))
  const history = log.map((e) => {
    const closer = closedBy[e.id]
    const amend = def.events.filter((t) => t.ref?.types.includes(e.type) && R.allows(t.who, { _ref_by: e.by, _subject: e.entity }, me)).map((t) => t.type)
    return { ...e, closedBy: closer || null, amend: closer ? [] : amend }
  })
  if (me.rank >= 4) {
    const sens = new Set(def.fields.filter((f) => PV.levelOf(f) === 'sensitive').map((f) => f.key))
    await auditSensitiveRead(app, user, log.filter((e) => e.entity !== me.id && [...sens].some((k) => e[k] !== '' && e[k] != null && !(e._hidden || []).includes(k))).length)
  }
  return { app: await summary(app, folder, role), kind: 'events', events: history, projections, totals, types, people, me: user.id }
}

export async function appendEvent(user, id, input) {
  const { app, folder, role } = await appFor(user, id, 'viewer')
  if (app.kind !== 'events') throw err(400, '기록을 쌓는 앱이 아니에요.')
  const def = app.def
  const people = await peopleOf(folder)
  const toId = idOf(people)
  const log = await eventLog(user, app, folder, people)
  const refEvent = input.ref ? log.find((e) => e.id === input.ref) : null
  if (input.ref && !refEvent) throw err(404, '대상 기록이 없거나 볼 수 없어요.')
  const entityIn = input.entity ?? input.values?.[def.entity.key] ?? input.values?.[def.entity.label]
  const ev = E.validateEvent(def, { ...input, entity: def.entity.type === 'person' && entityIn ? toId(String(entityIn)) : entityIn }, { refEvent })
  if (def.entity.type === 'person' && !refEvent && !people.some((p) => p.id === ev.entity)) throw err(422, `'${def.entity.label}'에는 이 폴더 구성원만 넣을 수 있어요.`)
  const t = def.events.find((x) => x.type === ev.type)
  let made
  if (app.tier === 'db') made = await D.append(user, app, ev)
  else {
    // sheet tier: the server is the only writer; the same rule terms are checked here
    const me = { id: user.id, rank: S.RANK[role] }
    if (!R.allows(t.who, { _subject: ev.entity, _created_by: user.id, _ref_by: refEvent?.by }, me)) throw err(403, `'${t.label}'을(를) 기록할 권한이 없어요.`)
    made = await serial(app.id, async () => {
      const cur = await sheetLog(folder, app, people)
      if (ev.ref && E.replay(def, cur).closedBy[ev.ref]) throw err(409, '이미 취소(또는 처리)된 기록이에요.')
      const e = { seq: (cur.at(-1)?.seq || 1) + 1, id: E.newEventId(), at: new Date().toISOString(), by: user.id, type: ev.type, entity: ev.entity, ref: ev.ref, ...ev.values }
      await fs.writeFile(sheetFile(folder, app), await X.bookBuffer(await E.eventsBook(def, [...cur, e], { names: nameOf(people) })))
      await S.commitMain(folder, { name: user.name, email: user.email }, `기록: ${t.label} — ${def.entity.type === 'person' ? nameOf(people)(ev.entity) : ev.entity}`)
      reindex(folder, { cards: false }).catch(() => {})
      return e
    })
  }
  await q('update pro_panel_apps set updated_at=now() where id=$1', [app.id])
  await broadcast(app, folder, user)
  return { event: made, ...(await eventRows(user, app, folder, role)) }
}

// the sheet of an event app: the 이벤트 tab (what this person may read, masked) + replayed tabs.
// Saving appends the rows added at the bottom of 이벤트 as this person; changed or removed events
// are not applied (append-only) and are reported.
async function eventsSheetCopy(user, app, folder, role) {
  const people = await peopleOf(folder)
  const log = await eventLog(user, app, folder, people)
  const buf = await X.bookBuffer(await E.eventsBook(app.def, log, { names: nameOf(people) }))
  const token = crypto.randomBytes(16).toString('hex')
  snapshots.set(token, { appId: app.id, userId: user.id, log, at: Date.now() })
  const key = `pgpt-pro/panel-apps/${app.id}/v/${token}.xlsx`
  const { error } = await admin.storage.from('files').upload(key, buf, { contentType: XLSX_MIME, upsert: true })
  if (error) throw err(500, `시트를 열 준비를 못 했어요: ${error.message}`)
  return { url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}`, name: `${fileSafe(app.title)}${app.tier === 'db' ? ' (보기)' : ''}.xlsx`, sha: token, readOnly: false, snapshot: true, count: log.length }
}

async function eventsSheetSaved(user, id, { url, sha }) {
  const { app, folder } = await appFor(user, id, 'viewer')
  const snap = snapshots.get(String(sha || ''))
  if (!snap || snap.appId !== app.id || snap.userId !== user.id) throw err(409, '이 시트 보기는 만료됐어요. "시트 열기"로 다시 열어 주세요.')
  const people = await peopleOf(folder)
  const saved = E.readLog(await X.readBook(await fetchSaved(url)), app.def, { ids: idOf(people) })
  const { added, rejected } = E.diffLog(app.def, snap.log, saved, { names: nameOf(people) })
  let appended = 0
  for (const a of added) {
    const t = app.def.events.find((x) => x.type === a.type)
    try {
      await appendEvent(user, id, { type: a.type, entity: a.entity, ref: a.ref, values: Object.fromEntries((t?.fields || []).map((k) => [k, a[k]])) })
      appended++
    } catch (e) { rejected.push({ row: `${t?.label || a.type} · ${nameOf(people)(a.entity) || ''}`, reason: e.message }) }
  }
  // sheet tier: the folder file is rewritten from the log, so edits of old rows are undone there too
  if (app.tier !== 'db' && rejected.length && !appended) {
    const cur = await sheetLog(folder, app, people)
    await fs.writeFile(sheetFile(folder, app), await X.bookBuffer(await E.eventsBook(app.def, cur, { names: nameOf(people) })))
  }
  snapshots.set(String(sha), { ...snap, log: await eventLog(user, app, folder, people), at: Date.now() })
  return { ok: true, sha, changed: appended, rejected: rejected.map((r) => ({ row: r.row, reason: r.reason })) }
}

// ---------- privacy controls ----------
export async function privacyAck(user, id) {
  const { app } = await appFor(user, id, 'owner')
  await q('update pro_panel_apps set privacy_ack=true where id=$1', [app.id])
  await audit(app, user, 'privacy_ack', { lines: facts(app).privacy.map((l) => l.text) })
  return { ok: true }
}

// owner: change a field's sensitivity. Lowering personal/sensitive needs confirm and is logged.
export async function setSensitivity(user, id, { field, level, confirm = false }) {
  const { app, folder } = await appFor(user, id, 'owner')
  if (app.tier !== 'db') throw err(400, '시트 앱은 모든 구성원이 모든 항목을 봐요. 숨기려면 행 단위 권한을 켜 주세요.')
  const f = app.def.fields.find((x) => x.key === field)
  if (!f || !PV.LEVELS.includes(level)) throw err(400, '항목이나 수준이 올바르지 않아요.')
  const RANKL = Object.fromEntries(PV.LEVELS.map((l, i) => [l, i]))
  const before = PV.levelOf(f)
  const loosen = RANKL[level] < RANKL[before] && RANKL[before] >= RANKL.personal
  if (loosen && !confirm) throw Object.assign(err(409, `'${f.label}'을(를) ${before === 'sensitive' ? '민감 정보' : '개인정보'}에서 낮추면 더 많은 구성원이 보게 돼요. 확인 후 다시 저장해 주세요.`), { needConfirm: true })
  const def = { ...app.def, fields: app.def.fields.map((x) => (x.key === field ? { ...x, sensitivity: level } : x)) }
  const st = def.kind === 'events' ? E.eventsPolicySql(def, app.id, folder.id) : R.rulesSql(def, app.id, folder.id)
  await D.asOwner(st)
  await D.logMigration(app, 'rules', st, { user, note: `${f.label}: ${before} → ${level}` })
  await audit(app, user, loosen ? 'loosen' : 'sensitivity', { field, from: before, to: level })
  await saveDefFile(user, folder, app, def, `패널 앱 보안 수준: ${app.title} — ${f.label} ${before} → ${level}`)
  return rows(user, id)
}

// owner: who may append each event type / read the log (event apps)
export async function setEventRules(user, id, { events = {}, read }) {
  const { app, folder } = await appFor(user, id, 'owner')
  if (app.kind !== 'events') throw err(400, '이벤트 앱이 아니에요.')
  const def = E.normalizeEventsDef({ ...app.def, tier: app.tier, events: app.def.events.map((e) => ({ ...e, who: events[e.type] ?? e.who })), access: { read: read ?? app.def.access.read } }, { strict: true })
  if (app.tier === 'db') {
    const st = E.eventsPolicySql(def, app.id, folder.id)
    await D.asOwner(st)
    await D.logMigration(app, 'rules', st, { user })
  }
  await audit(app, user, 'rules', { events: Object.fromEntries(def.events.map((e) => [e.type, e.who])), read: def.access.read })
  await saveDefFile(user, folder, app, def, `패널 앱 권한 규칙: ${app.title}`)
  await announce(folder.slug)
  return rows(user, id)
}

// ---------- a list app becomes an event app (e.g. the phase-1 휴가 일수 표) ----------
// mapping (declarative): {entity: oldKey, events: [{type, from: {payloadKey: oldKey}}]} — each row gives
// one event per mapping entry whose numbers are non-zero; they are marked as migrated in history.
export async function convertToEvents(user, id, { def: rawDef, mapping }) {
  const { app, folder } = await appFor(user, id, 'owner')
  if (app.kind === 'events') throw err(400, '이미 기록을 쌓는 앱이에요.')
  const def = E.normalizeEventsDef({ ...rawDef, title: app.title, icon: app.icon }, { secure: true, strict: true })
  const people = await peopleOf(folder)
  const old = app.tier === 'db' ? await D.allRowsAsOwner(app) : X.readRows((await readSheet(folder, app)).wb, app.def)
  const evs = migrateRows(def, old, mapping, { owner: app.created_by, toId: idOf(people) })
  if (def.tier === 'db') {
    const next = { ...app, id: app.id, def }
    if (app.tier === 'db') await D.asOwner(await D.dropTable(app).then(() => []))
    await q('update pro_panel_apps set def=$2 where id=$1', [app.id, def])
    await D.createEventsTable(next, folder.id, user)
    await D.importEvents(next, evs)
    await D.logMigration(next, 'upgrade', [`-- ${old.length} rows → ${evs.length} events (migrated)`], { user })
  } else {
    await fs.writeFile(sheetFile(folder, app), await X.bookBuffer(await E.eventsBook(def, evs, { names: nameOf(people) })))
  }
  await q('update pro_panel_apps set kind=$2, tier=$3 where id=$1', [app.id, 'events', def.tier])
  await saveDefFile(user, folder, { ...app }, def, `패널 앱을 기록(이벤트) 방식으로 바꿈: ${app.title} — 행 ${old.length}개 → 기록 ${evs.length}개`)
  await audit(app, user, 'convert', { rows: old.length, events: evs.length })
  await announce(folder.slug)
  return rows(user, id)
}
export function migrateRows(def, rows, mapping, { owner, toId = (x) => x, at = new Date().toISOString() }) {
  const out = []
  let seq = 1
  for (const r of rows) {
    const entity = toId(String(r[mapping.entity] ?? '').trim())
    if (!entity) continue
    for (const m of mapping.events || []) {
      const t = def.events.find((e) => e.type === m.type)
      if (!t || t.ref) continue
      const vals = Object.fromEntries(Object.entries(m.from || {}).filter(([k]) => t.fields.includes(k)).map(([k, ok]) => [k, r[ok]]))
      if (!Object.values(vals).some((v) => v !== '' && v != null && Number(v) !== 0)) continue
      out.push({ seq: seq++, id: E.newEventId(), at, by: r._created_by || owner, type: t.type, entity, ref: null, ...vals, _migrated: true })
    }
  }
  return out
}

async function eventsSnapshot(user, app, folder) {
  const people = await peopleOf(folder)
  const everyone = { id: '00000000-0000-0000-0000-000000000000', rank: 1 }
  const all = await D.eventsAsOwner(app)
  const visible = all.filter((e) => R.allows(app.def.access.read, { _created_by: e.by, _by: e.by, _subject: e.entity }, everyone))
    .map((e) => { const o = { ...e }; for (const f of app.def.fields) if (PV.restricted(f)) o[f.key] = '비공개'; return o })
  // replayed tabs only from what may be shown: restricted numbers are blanked above
  await fs.writeFile(sheetFile(folder, app), await X.bookBuffer(await E.eventsBook(app.def, visible, { names: nameOf(people) })))
  const commit = await S.commitMain(folder, { name: user.name, email: user.email }, `스냅샷: ${app.title} (기록 ${visible.length}/${all.length}개, 개인정보·민감 항목은 비공개)`)
  reindex(folder, { cards: false }).catch(() => {})
  await audit(app, user, 'snapshot', { events: visible.length })
  return { ok: true, commit, rows: visible.length, hidden: all.length - visible.length, path: app.sheet_path }
}
