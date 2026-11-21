// What an action skill does (its metadata.handler): the server's own functions, unchanged in what they
// do — they only take the router's checked arguments (ids from the facts) instead of reading the
// person's words themselves. ctx: { user, session, threadId, text, onDelta, facts, noAgentTurn }.
import { config } from '../../config.js'
import { chat } from '../llm.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { addMessage, history } from '../store.js'
import { L, isEn, locale, langOf, withLang } from '../lang.js'
import { createSchedule as newSchedule, nextRun, cronAfter, dueAt, listSchedules } from '../scheduler.js'
import { createMission, createProcessSchedule, channelsOf } from '../missions.js'
import { runBrowserTask } from '../browser.js'
import { generatePanel } from '../panels.js'
import * as PanelApps from '../panelApps/service.js'
import { valuesFromText } from '../panelApps/sheet.js'
import { getDefinition } from '../processes.js'
import { listAssignments } from '../team.js'
import { notifyMember as notify } from '../notify.js'
import { brief as improveBrief } from '../improve/service.js'
import * as S from '../folders/service.js'
import * as SK from '../folders/skills.js'
import * as A from '../agent.js'

const say = async (ctx, t) => { const m = await addMessage(ctx.user.id, ctx.threadId, 'agent', 'text', { text: t }); return m }
const scheduleOf = async (ctx, id8) => (id8 ? (await listSchedules(ctx.user.id)).find((s) => s.id.startsWith(id8)) || null : null)

// ---------- schedule-create ----------
async function createSchedule(ctx, args) {
  const { user, session, threadId, text } = ctx
  const userId = user.id
  // the ack is already in the chat: a schedule that cannot be made has to say so
  try {
    const cron = args.in_minutes ? cronAfter(args.in_minutes) : args.cron
    dueAt(cron, new Date()) // throws on an expression that is not a cron
    const proc = args.process ? await getDefinition(args.process) : null
    const skill = !proc && args.skill ? args.skill : null
    // the person's own words go with every kind of task, so a run can recover what the instruction missed
    const s = proc
      ? await createProcessSchedule({ userId, name: args.name, cron, processId: proc.id, params: { ...(args.params || {}), request: text }, threadId })
      : skill
      ? await createMission({ userId, name: args.name, cron, skill, params: { ...(args.params || {}), request: text } })
      : await newSchedule({ userId, name: args.name, cron, prompt: args.prompt, threadId, notify: args.notify === 'on_change' ? 'on_change' : 'always', once: !!(args.in_minutes || args.once) })
    if (!proc && !skill) await q(`update pro_schedules set params = coalesce(params,'{}'::jsonb) || $2::jsonb where id=$1`, [s.id, JSON.stringify({ request: text })]).catch((e) => console.warn('[schedule] request', e.message))
    void session
    const next = nextRun(s.cron)
    const when = next ? next.toLocaleString(locale(), { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''
    await addMessage(userId, threadId, 'agent', 'chip', { icon: 'clock', text: L(`예약됨 · ${s.name}${skill ? ` · 스킬 ${skill}` : proc ? ` · 프로세스 ${proc.name}` : ''}${when ? ` · 다음 실행 ${when}` : ''}`,
      `Scheduled · ${s.name}${skill ? ` · skill ${skill}` : proc ? ` · process ${proc.name}` : ''}${when ? ` · next run ${when}` : ''}`), cron: s.cron, scheduleId: s.id })
  } catch (e) {
    console.warn('[schedule]', e.message)
    await say(ctx, L('예약을 걸지 못했어요. 시각을 다시 알려 주세요.', "I couldn't set that schedule. Please tell me the time again."))
  }
  return null
}

// ---------- schedule-run-now ----------
async function runScheduleNow(ctx, args) {
  const s = await scheduleOf(ctx, args.schedule)
  if (!s) return say(ctx, L('지금 실행할 예약 작업이 없어요. 무엇을 언제 확인할지 먼저 말해 주세요.', "There's no scheduled task to run. Tell me what to check and when first."))
  return A.runScheduleNowTurn({ userId: ctx.user.id, threadId: ctx.threadId, s, onDelta: ctx.onDelta, acked: !!ctx.acked })
}

// ---------- telegram-delivery ----------
// where a task's results go besides the chat (pro_schedules.state.channels)
async function setChannel(s, channel, on) {
  const next = [...new Set([...channelsOf(s).filter((c) => c !== channel), ...(on ? [channel] : [])])]
  await q(`update pro_schedules set state = jsonb_set(coalesce(state,'{}'::jsonb), '{channels}', $2::jsonb) where id=$1 and user_id=$3`, [s.id, JSON.stringify(next), s.user_id])
  return next
}
// Telegram (lib/telegram.js): a task's alerts there too, the last answer sent there now, or connecting the
// person's bot. Not connected yet: a card in the chat connects it (src/components/TelegramConnect.vue), and
// a task already marked sends there from its next result on.
async function telegram(ctx, args) {
  const { user, threadId } = ctx
  const userId = user.id
  const tg = await import('../telegram.js')
  const status = await tg.telegramStatus(userId).catch(() => ({ connected: false, linked: false }))
  const ready = status.connected && status.linked
  const tell = (t) => say(ctx, t)
  const card = (s) => addMessage(userId, threadId, 'agent', 'telegram_connect', { scheduleId: s?.id || null, scheduleName: s?.name || '' })
  const chip = (t, s) => addMessage(userId, threadId, 'agent', 'chip', { icon: 'bell', text: t, ...(s ? { scheduleId: s.id } : {}) })
  if (args.action === 'connect') {
    if (ready) return tell(L(`텔레그램 봇 @${status.bot} 이 이미 연결돼 있어요.`, `Your Telegram bot @${status.bot} is already connected.`))
    const m = await tell(L('아래 카드 순서대로 하면 1분이면 돼요.', 'Follow the card below — it takes about a minute.'))
    await card(null)
    return m
  }
  if (args.action === 'alerts_on' || args.action === 'alerts_off') {
    const s = await scheduleOf(ctx, args.schedule)
    if (!s) return tell(L('텔레그램으로 알려 드릴 예약 작업이 아직 없어요. 무엇을 언제 확인할지 먼저 말해 주세요.', "There's no scheduled task to alert you about yet. Tell me what to check and when first."))
    if (args.action === 'alerts_off') {
      await setChannel(s, 'telegram', false)
      const m = await tell(L(`「${s.name}」 결과는 이제 텔레그램으로 보내지 않아요.`, `"${s.name}" results won't go to Telegram any more.`))
      await chip(L(`텔레그램 알림 끔 · ${s.name}`, `Telegram alerts off · ${s.name}`), s)
      return m
    }
    await setChannel(s, 'telegram', true)
    if (ready) {
      const m = await tell(L(`「${s.name}」에서 알릴 일이 생기면 채팅과 함께 텔레그램(@${status.bot})으로도 보내 드릴게요.`,
        `When "${s.name}" has something to tell you, it goes to Telegram (@${status.bot}) as well as this chat.`))
      await chip(L(`텔레그램 알림 켬 · ${s.name}`, `Telegram alerts on · ${s.name}`), s)
      return m
    }
    const m = await tell(L(`「${s.name}」 알림을 텔레그램으로도 보내도록 해 둘게요. 먼저 내 텔레그램 봇을 연결해 주세요 — 아래 카드에서 1분이면 돼요. 연결되면 다음 알림부터 텔레그램으로 가요.`,
      `I've set "${s.name}" to alert you on Telegram too. First connect your Telegram bot with the card below — about a minute. Alerts go there from the next one on.`))
    await card(s)
    return m
  }
  // send_last_answer: the last answer of this conversation, now
  const rows = await history(threadId, 14)
  const last = [...rows].reverse().find((r) => r.role === 'agent' && (r.kind === 'text' || r.kind === 'doc') && r.content?.text && r.content.text !== ctx.ackText)
  if (!last) return tell(L('텔레그램으로 보낼 답을 찾지 못했어요. 보낼 내용을 알려 주세요.', "I couldn't find an answer to send to Telegram. Tell me what to send."))
  if (!ready) {
    const m = await tell(L('먼저 내 텔레그램 봇을 연결해 주세요. 연결하면 바로 보낼 수 있어요.', 'Connect your Telegram bot first — then I can send it right away.'))
    await card(null)
    return m
  }
  try {
    await tg.sendTelegram(userId, last.content.text)
    return tell(L(`텔레그램(@${status.bot})으로 보냈어요.`, `Sent to Telegram (@${status.bot}).`))
  } catch (e) {
    return tell(L(`텔레그램으로 보내지 못했어요: ${e.message}`, `I couldn't send it to Telegram: ${e.message}`))
  }
}

// ---------- panel-create ----------
// A data app (records kept in a shared folder's spreadsheet) or, for live widgets, a generated panel.
export async function makePanel({ user, threadId, description }) {
  const userId = user.id
  const status = (t) => emit(userId, 'status', { threadId, text: t })
  status(L('패널 설계하는 중', 'Designing the panel'))
  try {
    const d = await PanelApps.design(description)
    if (d.kind === 'live') {
      status(L('패널 만드는 중', 'Making the panel'))
      const p = await generatePanel({ userId, description })
      await addMessage(userId, threadId, 'agent', 'chip', { icon: 'panel', text: L(`'${p.title}' 패널이 Home에 올라갔어요`, `'${p.title}' is now on Home`), panelId: p.id })
      return
    }
    status(L('시트 만드는 중', 'Making the sheet'))
    const app = await PanelApps.createApp(user, { description, def: d.def, rows: d.rows, folderHint: description })
    const n = d.rows.length
    const where = isEn() ? whereEn(app) : app.kind === 'events' ? `모든 변경은 기록(${app.def.events.map((e) => e.label).join('·')})으로 쌓이고, ${app.def.projections.map((p) => p.label).join('·')}은(는) 기록을 다시 계산해 보여 줘요. ${app.tier === 'db' ? '데이터는 데이터베이스에 저장돼요.' : `기록은 '${app.folder.name}' 폴더의 ${app.sheetPath.split('/').pop()} '이벤트' 탭에 쌓여요.`}` : app.tier === 'db' ? `데이터는 데이터베이스에 행 단위 권한으로 저장돼요(정의는 '${app.folder.name}' 폴더의 ${app.defPath.split('/').pop()}).\n권한: ${app.rules.map((r) => `${r.label} — ${r.text}`).join(' / ')}` : `데이터는 '${app.folder.name}' 폴더의 ${app.sheetPath.split('/').pop()} 시트에 쌓여요.`
    await addMessage(userId, threadId, 'agent', 'text', { text: L(`'${app.title}' 패널을 Home에 올렸어요. ${where}\n항목: ${PanelApps.describe(app.def)}${n ? `\n말씀하신 ${n}건을 먼저 넣어 두었어요.` : ''}\n패널에서 바로 등록하거나 "시트 열기"로 스프레드시트에서 고칠 수 있고, 패널 메뉴의 "공유하기"로 팀원과 함께 쓸 수 있어요.`,
      `I put the '${app.title}' panel on Home. ${where}\nFields: ${PanelApps.describe(app.def)}${n ? `\nI added the ${n} you mentioned first.` : ''}\nYou can add records right in the panel or edit them in the spreadsheet with "Open sheet", and use them with teammates through "Share" in the panel menu.`) })
    // secure by default: the defaults in words, before anyone else is invited
    await addMessage(userId, threadId, 'agent', 'text', { text: L(`보안·개인정보 기본값\n${app.privacy.map((l) => `• ${l.text}`).join('\n')}\nHome 패널 위의 카드에서 확인하거나 "권한 규칙"에서 조정할 수 있어요.`,
      `Security & privacy defaults\n${app.privacy.map((l) => `• ${l.text}`).join('\n')}\nYou can check them on the card above the panel on Home or adjust them in "Access rules".`) })
    await addMessage(userId, threadId, 'agent', 'chip', { icon: 'panel', text: L(`'${app.title}' 패널이 Home에 올라갔어요 · ${app.folder.name} 폴더`, `'${app.title}' is now on Home · ${app.folder.name} folder`), panelAppId: app.id })
  } catch (e) {
    console.warn('[panelApps] create', e.message)
    await addMessage(userId, threadId, 'agent', 'text', { text: L(`패널을 만들지 못했어요: ${e.message}`, `I couldn't make the panel: ${e.message}`) })
  } finally { status(null) }
}
// where a new app keeps its data, in English (makePanel)
function whereEn(app) {
  if (app.kind === 'events') return `Every change is kept as a record (${app.def.events.map((e) => e.label).join(' · ')}), and ${app.def.projections.map((p) => p.label).join(' · ')} ${app.def.projections.length > 1 ? 'are' : 'is'} recalculated from the records. ${app.tier === 'db' ? 'The data is stored in the database.' : `The records go to the 'Events' tab of ${app.sheetPath.split('/').pop()} in the '${app.folder.name}' folder.`}`
  if (app.tier === 'db') return `The data is stored in the database with row-level access (the definition is ${app.defPath.split('/').pop()} in the '${app.folder.name}' folder).\nAccess: ${app.rules.map((r) => `${r.label} — ${r.text}`).join(' / ')}`
  return `The data goes to the ${app.sheetPath.split('/').pop()} sheet in the '${app.folder.name}' folder.`
}
async function panelCreate(ctx, args) {
  await makePanel({ user: { ...ctx.user, jwt: ctx.session?.access_token }, threadId: ctx.threadId, description: args.description || ctx.text })
  return null
}

// ---------- panel-record ----------
async function panelRecord(ctx, args) {
  const user = { ...ctx.user, jwt: ctx.session?.access_token }
  const userId = user.id
  const threadId = ctx.threadId
  const tell = (t) => say(ctx, t)
  const full = ctx.facts.apps.find((a) => a.id === args.app)?.full
  const app = full ? (await PanelApps.listApps(user, { all: true })).find((a) => a.id === full) : null
  if (!app) return tell(L('그 패널 앱을 찾지 못했어요.', "I couldn't find that panel app."))
  const def = app.def
  if (app.kind === 'events') return panelEvent({ user, threadId, args, app, tell })
  // each column once (a list whose title is also a subtitle would name the customer twice)
  const fmt = (r) => [...new Set([def.views.list.title, ...def.views.list.subtitle, def.views.list.value].filter(Boolean))].map((k) => [...def.fields, ...def.computed].find((f) => f.key === k)).filter(Boolean).map((f) => `${f.label} ${r[f.key] === '' ? '-' : typeof r[f.key] === 'number' ? r[f.key].toLocaleString(locale()) : r[f.key]}`).join(' · ')
  emit(userId, 'status', { threadId, text: L('시트 고치는 중', 'Updating the sheet') })
  try {
    if (args.action === 'list') {
      const { rows } = await PanelApps.rows(user, app.id)
      return tell(rows.length ? L(`${app.title} — ${rows.length}건\n${rows.slice(0, 20).map((r) => `• ${fmt(r)}`).join('\n')}`, `${app.title} — ${rows.length}\n${rows.slice(0, 20).map((r) => `• ${fmt(r)}`).join('\n')}`) : L(`${app.title}에 아직 행이 없어요.`, `${app.title} has no rows yet.`))
    }
    // a number or date the model left out of its arguments is read from the request itself (a number's or
    // a date's format, lib/panelApps/sheet.js valuesFromText)
    const fromText = () => { const given = args.values || {}; const t = valuesFromText(def, ctx.text); for (const f of def.fields) if (Object.keys(given).some((k) => k === f.key || k.replace(/\s|\*|\([^)]*\)/g, '').toLowerCase() === String(f.label).replace(/\s/g, '').toLowerCase())) delete t[f.key]; return { ...t, ...given } }
    if (args.action === 'add') {
      const r = await PanelApps.write(user, app.id, { add: fromText() })
      return tell(L(`${app.title}에 넣었어요: ${fmt(r.row)} (모두 ${r.rows.length}건)`, `Added to ${app.title}: ${fmt(r.row)} (${r.rows.length} in all)`))
    }
    const { rows } = await PanelApps.rows(user, app.id)
    const m = String(args.match || '').trim()
    // the rows whose values hold what the router gave as the row's key (a search in the data)
    const hits = rows.filter((r) => m && def.fields.some((f) => String(r[f.key]).includes(m)))
    if (hits.length !== 1) return tell(hits.length ? L(`'${m}'에 맞는 행이 ${hits.length}개예요. 더 구체적으로 말씀해 주세요.`, `${hits.length} rows match '${m}'. Please be more specific.`) : L(`'${m}'에 맞는 행을 찾지 못했어요.`, `I couldn't find a row matching '${m}'.`))
    const r = await PanelApps.write(user, app.id, { update: { id: hits[0]._id, v: hits[0]._v, vals: args.values || {} } })
    return tell(L(`${app.title}에서 고쳤어요: ${fmt(r.row)}`, `Updated in ${app.title}: ${fmt(r.row)}`))
  } catch (e) {
    return tell(e.status === 403 ? (app.tier === 'db' ? `${e.message.replace(/\.$/, '')} — ${L(`'${app.title}'의 권한 규칙`, `access rule of '${app.title}'`)}: ${(app.rules || []).find((r) => r.action === (args.action === 'add' ? 'create' : 'update'))?.text || ''}` : L(`'${app.title}'은(는) 보기 권한만 있어서 고칠 수 없어요.`, `You can only view '${app.title}', so I can't change it.`)) : L(`고치지 못했어요: ${e.message}`, `I couldn't change it: ${e.message}`))
  } finally { emit(userId, 'status', { threadId, text: null }) }
}

// record-keeping (event) apps: every change is a new record; a cancellation points at the original
async function panelEvent({ user, threadId, args, app, tell }) {
  const def = app.def
  const userId = user.id
  emit(userId, 'status', { threadId, text: L('기록 더하는 중', 'Adding the record') })
  try {
    const r = await PanelApps.rows(user, app.id)
    const nm = (id) => r.people.find((p) => p.id === id)?.name || id
    const main = def.projections.find((p) => p.key === def.views.main)
    if (args.action === 'list' || !args.event) {
      const lines = main ? r.projections[main.key].map((x) => `• ${nm(x.entity)}: ${[...main.columns, ...main.computed].map((c) => `${c.label} ${x[c.key] === null ? L('비공개', 'Private') : x[c.key]}`).join(' · ')}`) : []
      return tell(L(`${app.title} — 기록 ${r.events.length}개\n${lines.join('\n') || '아직 기록이 없어요.'}`, `${app.title} — ${r.events.length} records\n${lines.join('\n') || 'No records yet.'}`))
    }
    // the kind of record the router named, as the app names it (its label or type)
    const t = def.events.find((e) => e.label === args.event || e.type === args.event)
    if (!t) return tell(L(`'${app.title}'에는 ${def.events.map((e) => e.label).join(', ')} 기록만 있어요.`, `'${app.title}' only has these records: ${def.events.map((e) => e.label).join(', ')}.`))
    const vals = Object.fromEntries(def.fields.filter((f) => t.fields.includes(f.key)).map((f) => [f.key, args.values?.[f.label] ?? args.values?.[f.key]]).filter(([, v]) => v !== undefined))
    let ref = null, entity = args.values?.[def.entity.label] ?? args.values?.[def.entity.key] ?? null
    if (t.ref) {
      const m = String(args.match || entity || '').trim()
      const open = r.events.filter((e) => t.ref.types.includes(e.type) && !e.closedBy && e.amend.includes(t.type))
      const hits = open.filter((e) => !m || nm(e.entity).includes(m) || def.fields.some((f) => String(e[f.key] ?? '').includes(m)))
      if (hits.length !== 1) return tell(hits.length ? L(`'${m}'에 맞는 기록이 ${hits.length}개예요. 더 구체적으로 말씀해 주세요.`, `${hits.length} records match '${m}'. Please be more specific.`) : L(`'${t.label}'할 수 있는 기록을 찾지 못했어요.`, `I couldn't find a record that '${t.label}' applies to.`))
      ref = hits[0].id
    } else if (!entity && t.who.includes('subject_is_me')) entity = user.id
    const out = await PanelApps.appendEvent(user, app.id, { type: t.type, entity, ref, values: vals })
    const row = main ? out.projections[main.key].find((x) => x.entity === out.event.entity) : null
    const rowText = row ? ` — ${nm(row.entity)}: ${[...main.columns, ...main.computed].map((c) => `${c.label} ${row[c.key] === null ? L('비공개', 'Private') : row[c.key]}`).join(' · ')}` : ''
    return tell(L(`${app.title}에 '${t.label}' 기록을 더했어요${rowText}. 이전 기록은 그대로 남아요.`, `Added a '${t.label}' record to ${app.title}${rowText}. Earlier records stay as they were.`))
  } catch (e) {
    return tell(e.status === 403 ? `${e.message.replace(/\.$/, '')} — ${L(`'${app.title}'의 기록 권한`, `record permissions of '${app.title}'`)}: ${(app.eventRules || []).map((x) => `${x.label}: ${x.who}`).join(' / ')}` : L(`기록하지 못했어요: ${e.message}`, `I couldn't record it: ${e.message}`))
  } finally { emit(userId, 'status', { threadId, text: null }) }
}

// ---------- folder-change ----------
async function folderChange(ctx, args) {
  const { user } = ctx
  let folder = null
  if (args.folder === 'attached') folder = ctx.facts.attachedFolder?.canChange ? await S.folderById(ctx.facts.attachedFolder.folderId) : null
  else if (String(args.folder).startsWith('skill:')) folder = await SK.ensureSkillFolder(String(args.folder).slice(6))
  else folder = await S.folderBySlug(args.folder)
  const role = folder ? await S.roleOf(folder, user).catch(() => null) : null
  if (!folder || !role || S.RANK[role] < S.RANK.runner) {
    ctx.noAgentTurn()
    return say(ctx, L('그 폴더에는 변경을 제안할 권한이 없어요.', "You can't propose changes to that folder."))
  }
  return A.folderTurn({ user, session: ctx.session, threadId: ctx.threadId, text: ctx.text, onDelta: ctx.onDelta, folder })
}

// ---------- process-work ----------
async function processWork(ctx, args) {
  if (args.intent !== 'create') ctx.noAgentTurn()
  await A.processTurn(ctx.user.id, ctx.threadId, args)
  return null
}

// ---------- process-improve-explain ----------
const IMPROVE_PROMPT_EN = `You are a business process improvement consultant. Answer the user's question in English, using only the 'analysis result (JSON)' below.
Rules:
- Copy numbers exactly as they are in the JSON. Do not calculate new ones or make any up. Do not mention numbers the JSON does not have.
- Order: (1) where the bottleneck/constraint is (step, owner, utilization, share of lead time spent waiting) (2) why (arrivals per day vs capacity, trend of items waiting) (3) how to reduce it — the 2-3 actions from five_focusing_steps that cut lead time the most, each with before → after numbers (4) a last line: on the Improve screen you can try changes and preview them, and create a new version with "Apply proposal".
- 8-12 lines. Lists with '- '. Don't blame people; explain it through the flow of work.`
const IMPROVE_PROMPT = `너는 업무 프로세스 개선 컨설턴트야. 사용자의 질문에 아래 '계산 결과(JSON)'만 근거로 한국어 해요체로 답해.
규칙:
- 숫자는 JSON 에 있는 값을 그대로 옮겨 써. 새로 계산하거나 지어내지 마. JSON 에 없는 숫자는 말하지 마.
- 순서: ① 병목·제약이 어디인지(단계·담당·가동률·리드타임 중 대기 비중) ② 왜 그런지(하루 도착 건수 vs 처리 능력, 대기 건수 추세) ③ 어떻게 줄일지 — five_focusing_steps 의 행동 중 리드타임을 가장 많이 줄이는 2~3개를 전→후 숫자와 함께 ④ 마지막 한 줄: 개선 화면에서 바꿔 보며 미리 계산하고 「개선안 적용」으로 새 버전을 만들 수 있다고 안내.
- 8~12줄. 목록은 '- ' 로. 사람을 탓하지 말고 일의 흐름으로 설명해.`

// the explanation without a model (the model is down or slow): the same facts, in a fixed shape
export function improveTemplate(b) {
  const c = b.constraint
  const acts = b.five_focusing_steps.flatMap((s) => s.actions || []).filter((x) => x.lead_time).slice(0, 3)
  if (isEn()) return [
    `The ${b.process} process (${b.completed} completed) has a median lead time of ${b.lead_time.median} and a flow efficiency of ${b.flow_efficiency}.`,
    c ? `The bottleneck is the ${c.step} step (${c.who}). Utilization is ${c.utilization} (${c.arrivals_per_day} arriving a day, capacity ${c.capacity_per_day ?? '-'} a day), and waiting before this step takes ${c.wait_share_of_lead_time} of the lead time.` : '',
    ...acts.map((x) => `- ${x.title}: lead time ${x.lead_time}`),
    '',
    'On the Improve screen you can try changes and preview them, then create a new version with "Apply proposal".',
  ].filter((x) => x != null).join('\n')
  return [
    `${b.process} 프로세스(완료 ${b.completed}건)의 리드타임 중앙값은 ${b.lead_time.median}, 흐름 효율은 ${b.flow_efficiency}예요.`,
    c ? `병목은 ${c.step}(${c.who}) 단계예요. 가동률 ${c.utilization}(하루 ${c.arrivals_per_day}건 도착, 처리 능력 ${c.capacity_per_day ?? '-'}건)이고, 이 단계 앞 대기가 리드타임의 ${c.wait_share_of_lead_time}를 차지해요.` : '',
    ...acts.map((x) => `- ${x.title}: 리드타임 ${x.lead_time}`),
    '',
    '개선 화면에서 바꿔 보며 미리 계산하고, 「개선안 적용」으로 새 버전을 만들 수 있어요.',
  ].filter((x) => x != null).join('\n')
}

async function improveExplain(ctx, args) {
  const { user, threadId, text, onDelta } = ctx
  const proc = ctx.facts.improvable.find((p) => p.id === args.process)
  if (!proc) return say(ctx, L('실행 기록이 있는 프로세스만 분석할 수 있어요.', 'Only processes with a run history can be analysed.'))
  let b
  try { b = await improveBrief(user, proc.id) } catch (e) {
    const t = e.status === 403 ? L(`${proc.name} 프로세스는 참여한 사람과 관리자만 분석을 볼 수 있어요.`, `Only the people who took part in the ${proc.name} process and administrators can see its analysis.`) : L(`${proc.name} 프로세스를 분석하지 못했어요: ${e.message}`, `I couldn't analyze the ${proc.name} process: ${e.message}`)
    onDelta?.(t)
    return say(ctx, t)
  }
  let out = ''
  try {
    // a slow or absent model must not hold the answer: after 25 s the same facts go out in a fixed shape
    const r = await chat({ model: config.llm.fastModel, temperature: 0.2, signal: AbortSignal.timeout(Number(process.env.PRO_IMPROVE_EXPLAIN_MS || 25000)),
      messages: isEn() ? [{ role: 'system', content: IMPROVE_PROMPT_EN }, { role: 'user', content: `Question: ${text}\n\nAnalysis result (JSON):\n${JSON.stringify(b)}` }]
        : [{ role: 'system', content: IMPROVE_PROMPT }, { role: 'user', content: `질문: ${text}\n\n계산 결과(JSON):\n${JSON.stringify(b)}` }] })
    out = String(r.content || '').trim()
  } catch (e) { console.warn('[improve] explain', e.message) }
  if (!out) out = improveTemplate(b)
  onDelta?.(out)
  const m = await say(ctx, out)
  const acts = b.five_focusing_steps.flatMap((s) => (s.actions || []).map((x) => ({ ...x, stage: s.stage }))).filter((x) => x.lead_time).slice(0, 3)
  await addMessage(user.id, threadId, 'agent', 'improve', { defId: b.id, name: b.process, url: b.link, completed: b.completed, lead: b.lead_time, flow: b.flow_efficiency, constraint: b.constraint,
    path: b.critical_path.path, actions: acts.map((x) => ({ title: x.title, lead: x.lead_time, flow: x.flow_efficiency })) })
  return m
}

// ---------- browser-task ----------
async function browserTask(ctx, args) {
  const { user, threadId } = ctx
  // the address the person gave (a URL's format), when the router did not copy it
  const startUrl = args.start_url || /https?:\/\/[^\s)'"]+/i.exec(ctx.text)?.[0] || undefined
  runBrowserTask({ userId: user.id, threadId, goal: args.goal || ctx.text, startUrl })
    .then((r) => r.summary && addMessage(user.id, threadId, 'agent', 'text', { text: r.summary }))
    .catch((e) => { console.warn('[browser]', e.message); addMessage(user.id, threadId, 'agent', 'text', { text: L('브라우저 작업을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.', "I couldn't start the browser task. Please try again in a moment.") }) })
  return null
}

// ---------- teammate-notify ----------
// the teammate the router named: a teammate's name or e-mail, or a role someone holds for every process
async function memberOf(ctx, key) {
  const team = ctx.facts.team
  const hit = team.find((m) => m.name === key || m.email === key)
  if (hit) return { id: hit.id, name: hit.name, email: hit.email, via: 'name' }
  const roles = await listAssignments(null).catch(() => [])
  const a = roles.find((r) => r.proc_def_id === '*' && r.role === key)
  const holder = a ? team.find((m) => m.id === a.user_id) : null
  return holder ? { id: holder.id, name: holder.name, email: holder.email, via: 'role', role: a.role } : null
}
async function notifyMember(ctx, args) {
  const { user, threadId, text } = ctx
  const member = args.member ? await memberOf(ctx, args.member) : null
  if (!member || member.id === user.id) {
    return say(ctx, member ? L('본인에게는 알림을 보내지 않아요.', "I don't send notifications to yourself.") : L(`'${args.member || ''}' 팀원을 찾지 못했어요. 설정 → 팀·역할에서 팀원을 추가해 주세요.`, `I couldn't find a teammate called '${args.member || ''}'. Add them in Settings → Team & roles.`))
  }
  // the teammate never saw this chat: what was said just before the request goes along
  // (earlier "알려줘" exchanges — a request followed by its bell chip — are not context)
  const rows = await history(threadId, 12)
  const pinged = new Set()
  rows.forEach((r, i) => { if (r.kind === 'chip' && r.content?.icon === 'bell') { pinged.add(i - 1); pinged.add(i - 2) } })
  // the excerpt's labels are in the teammate's language (they read it), the excerpt itself as it was said
  const theirs = await langOf(member.id).catch(() => 'ko')
  const T = (ko, en) => (theirs === 'en' ? en : ko)
  const said = [...new Set(rows.filter((r, i) => ['text', 'doc'].includes(r.kind) && r.content?.text && r.content.text !== text && r.content.text !== ctx.ackText && !pinged.has(i))
    .slice(-3).map((r) => `${r.role === 'user' ? user.name || T('요청자', 'Requester') : T('비서', 'Assistant')}: ${r.content.text.replace(/\s+/g, ' ').slice(0, 220)}`))]
  const title = args.title || L('확인 부탁', 'Please take a look')
  await withLang(theirs, () => notify(user, member, { title, text: [String(args.message || text).trim(), said.length ? `${T('— 대화 발췌 —', '— Conversation excerpt —')}\n${said.join('\n')}` : ''].filter(Boolean).join('\n\n') }))
  await addMessage(user.id, threadId, 'agent', 'chip', { icon: 'bell', text: L(`${member.name}님께 알림 보냄${member.via === 'role' ? ` · ${member.role}` : ''} · ${title}`, `Notified ${member.name}${member.via === 'role' ? ` · ${member.role}` : ''} · ${title}`) })
  return null
}

// ---------- home-action-add ----------
async function addAction(ctx, args) {
  const [a] = await q(`insert into pro_actions(user_id,verb,text,due,prompt) values ($1,$2,$3,$4,$5) returning *`, [ctx.user.id, args.verb, args.text, args.due || null, args.text])
  emit(ctx.user.id, 'action', a)
  return null
}

export const HANDLERS = { createSchedule, runScheduleNow, telegram, panelCreate, panelRecord, folderChange, processWork, improveExplain, browserTask, notifyMember, addAction }
