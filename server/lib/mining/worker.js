// Runs the agent steps of a process registered from mining (orchestration 'pgpt-pro-skill'): each
// step is the skill the ad-hoc drafts already used — CADCraft floor plan, the 한글 proposal filled by
// office-mcp (English mode: a Word proposal by the agent's docx skill), the Excel quote by the agent's
// xlsx skill. Same protocol as browserWorker.js (processgpt_agent_sdk): fetch_pending_task →
// record_events_bulk → save_task_result. A step runs in its owner's saved language (lib/lang.js).
import crypto from 'node:crypto'
import { admin, q, sessionFor } from '../supa.js'
import { config } from '../../config.js'
import { servesTenant, withTenant } from '../tenant.js'
import { addMessage } from '../store.js'
import { emit } from '../bus.js'
import { ORCH, stepOf } from './catalog.js'
import { L, langOf, withLang } from '../lang.js'
import { numberOf } from '../improve/analyze.js'

const CONSUMER = `pgpt-pro-skill-${process.pid}`
let busy = false

export async function events(list) {
  const { error } = await admin.rpc('record_events_bulk', { p_events: list })
  if (error) console.warn('[skill-worker] events', error.message)
}

export async function ownerOf(row) {
  const [t] = await q(`select user_id from todolist where proc_inst_id=$1 and coalesce(agent_orch,'') = '' order by start_date asc nulls last limit 1`, [row.proc_inst_id])
  return (t?.user_id || '').split(',')[0].trim() || null
}
export async function instanceThread(userId, instId) {
  let [t] = await q('select id from pro_threads where user_id=$1 and ref=$2', [userId, instId])
  if (!t) {
    const [i] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [instId])
    ;[t] = await q(`insert into pro_threads(user_id,kind,title,ref) values ($1,'process',$2,$3) returning id`, [userId, i?.proc_inst_name, instId])
  }
  return t.id
}
// values of the steps done so far in this instance, flat ({customer, subject, body, floor_plan, rooms, …})
export async function earlier(instId) {
  const rows = await q(`select output from todolist where proc_inst_id=$1 and status in ('DONE','SUBMITTED') order by end_date asc nulls last`, [instId])
  const out = {}
  for (const r of rows) for (const v of Object.values(r.output || {})) if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, v)
  return out
}
// the floor plan as a picture an agent can put in a document (lib/mail.js renders it the same way)
async function planPicture(dxfUrl) {
  const { planPicture: render } = await import('../mail.js')
  return render(dxfUrl)
}

export async function newFile(threadId, since, ext) {
  const [m] = await q(`select content from pro_messages where thread_id=$1 and kind='file' and created_at >= $2 and lower(content->>'name') like $3 order by created_at desc limit 1`,
    [threadId, since, `%.${ext}`])
  return m ? { name: m.content.name, url: m.content.url } : null
}

// (also run by the process ontology's step worker, lib/ontology/run.js)
export const SKILLS = {
  // 회사 양식 채우기(design-v0.3 §22): the latest file of the form this work uses, kept from the company's own mail
  // (lib/ontology/history.js), copied into the agent's workspace and filled for this case — the same sheets, labels,
  // layout, formatting and formulas; this case's values. Any office kind (xlsx · docx · pptx · hwpx).
  async 'form-fill'({ owner, threadId, prev, status, extra = '', template, step = '' }) {
    if (!template?.path) throw new Error(L('이 일의 회사 양식 파일이 없어요', 'This work has no company form file'))
    const kind = String(template.path).split('.').pop().toLowerCase()
    // an Excel form is filled here, cell by cell, in the company's own file — its formatting, formulas and layout untouched
    if (kind === 'xlsx') return fillXlsx({ owner, threadId, prev, status, extra, template, step })
    const fsp = await import('node:fs/promises')
    const { delegate } = await import('../agent.js')
    const { saveAttachment } = await import('../attachments.js')
    const [p] = await q('select email, name from pro_profile where user_id=$1', [owner])
    const { user, session } = await sessionFor(p.email, p.name)
    const src = await saveAttachment(user, `양식_${template.name}`, '', await fsp.readFile(template.path))
    const who = String(prev.customer || '').replace(/[\\/:*?"<>|]/g, ' ').trim()
    const out = `${who ? `${who} ` : ''}${template.name.replace(/\.[a-z0-9]+$/i, '')}.${kind}`
    status(L(`회사 양식 「${template.name}」으로 만드는 중`, `Filling the company form ${template.name}`))
    const since = new Date()
    const msg = await delegate({ user, session, threadId, silent: true,
      text: L(`프로세스의 '${step}' 단계예요. 회사가 메일로 주고받아 온 양식 「${template.name}」의 가장 최근 파일이 ${src.path} 에 있어요. ` +
        `이 파일을 복사해 /workspace/${out} 를 만들고 이 건에 맞게 채우세요 — 시트 · 머리 칸 · 표의 열 이름 · 서식 · 수식 · 안내 문구는 그대로 두고, ` +
        `지난 건의 고객 · 날짜 · 금액 · 품목 · 사람 같은 값만 이 건의 것으로 바꾸세요. 이 건에서 알 수 없는 값은 합리적인 가정값으로 채우고 무엇을 가정했는지 적으세요. ` +
        `새로 그리지 말고 원본 파일을 고쳐 쓰세요(엑셀은 openpyxl 로 같은 칸에 값만, 워드 · 한글 · 파워포인트는 같은 문단 · 표 · 슬라이드에 글만).\n\n` +
        `이 건: ${prev.subject || ''}\n${String(prev.body || '').slice(0, 2500)}\n\n${extra ? `${extra}\n\n` : ''}` +
        `다 만들면 파일 이름과 바꾼 값 · 가정한 값을 서너 줄로 적으세요. 합계 금액이 있는 양식이면 맨 마지막 줄에 "TOTAL: 12400000" 처럼 원 단위 숫자를 한 줄로 쓰세요. 모두 한국어(해요체)로.`,
        `This is the '${step}' step of a process. The latest file of the company's form ${template.name} (from its mail) is at ${src.path}. ` +
        `Copy it to /workspace/${out} and fill it for this case — keep its sheets, labels, column names, formatting, formulas and notes; replace only the ` +
        `previous case's values (customer, dates, amounts, items, people) with this case's. Unknown values: reasonable assumptions, and say which. ` +
        `Edit the original file, do not draw a new one.\n\nThis case: ${prev.subject || ''}\n${String(prev.body || '').slice(0, 2500)}\n\n${extra ? `${extra}\n\n` : ''}` +
        `When done, write the file name and the values you changed or assumed in three or four lines; if the form has a total, end with a line like "TOTAL: 12400000".`) })
    const f = await newFile(threadId, since, kind)
    if (!f) throw new Error(L('양식으로 만든 파일을 찾지 못했어요', "I couldn't find the filled form"))
    const plain = String(msg?.content?.text || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    const { total, rest } = quoteTotal(plain)
    const text = rest.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).slice(-3).join('\n\n').slice(0, 1500)
    return { values: { document: f, form: template.name, ...(total != null ? { amount: String(total) } : {}), assumptions: text }, say: null }
  },
  // CADCraft through its MCP (lib/floorPlan.js), the same drawing the mail drafts make
  async 'cadcraft-floor-plan'({ owner, threadId, prev, status }) {
    const { layoutFromMail, drawFloorPlan } = await import('../floorPlan.js')
    const { publish } = await import('../office.js')
    const mail = { subject: prev.subject, text: prev.body }
    status(L('도면 배치 정하는 중', 'Laying out the floor plan'))
    const layout = await layoutFromMail(mail)
    const drawn = await drawFloorPlan(owner, layout, L(`${prev.customer || '고객'} 평면도.dxf`, `${prev.customer || 'Customer'} floor plan.dxf`), (step) => status(L(`캐드크래프트로 도면 그리는 중 · ${step}`, `Drawing in CADCraft · ${step}`)))
    const doc = await publish(owner, drawn.path)
    await addMessage(owner, threadId, 'agent', 'file', { ...doc, path: drawn.path })
    const rooms = drawn.rooms.map((r) => `${r.name} | ${r.area}㎡ | ${r.use}`).join('\n')
    return { values: { floor_plan: { name: doc.name, url: doc.url }, rooms }, say: L(`캐드크래프트로 평면도(${drawn.width}m × ${drawn.depth}m)를 그렸어요. ${drawn.rooms.map((r) => `${r.name} ${r.area}㎡`).join(', ')}.`,
      `I drew the floor plan (${drawn.width} m × ${drawn.depth} m) in CADCraft: ${drawn.rooms.map((r) => `${r.name} ${r.area} ㎡`).join(', ')}.`) }
  },
  // the proposal template with the drawing in its picture, filled by office-mcp generate_hwpx
  async 'hwpx-proposal'({ owner, threadId, prev, status }) {
    const mail = await import('../mail.js')
    const since = new Date()
    let templateUrl
    if (prev.floor_plan?.url) { status(L('제안서 양식에 평면도 넣는 중', 'Putting the floor plan into the proposal form')); templateUrl = await mail.designTemplate(owner, prev.floor_plan.url).catch(() => undefined) }
    status(L('아래아한글 제안서 채우는 중', 'Filling in the Hangul proposal'))
    const rooms = String(prev.rooms || '').split('\n').join(' / ')
    await mail.hwpxDraft(owner, threadId, { from: prev.sender, subject: prev.subject, text: prev.body }, { kind: L('제안서', 'proposal'), name: L(`${prev.customer || '고객'} 제안서.hwpx`, `${prev.customer || 'Customer'} proposal.hwpx`) }, prev.customer,
      { templateUrl, extra: rooms ? L(`평면도(${prev.floor_plan?.name || ''})를 2번 '설계 평면도' 그림으로 그대로 두고, '공간 구성' 표는 평면도의 실별 면적으로 채우세요: ${rooms}`,
        `Keep the floor plan (${prev.floor_plan?.name || ''}) as the design floor plan picture and fill the space plan table with the room areas from the floor plan: ${rooms}. Write every text in English.`) : '' })
    const f = await newFile(threadId, since, 'hwpx')
    if (!f) throw new Error(L('제안서 파일을 찾지 못했어요', "I couldn't find the proposal file"))
    return { values: { proposal: f }, say: L(`평면도를 넣은 아래아한글 제안서(${f.name})를 채웠어요.`, `I filled in the Hangul proposal (${f.name}) with the floor plan in it.`) }
  },
  // English mode: the design proposal as a Word document by the agent's docx skill, the floor plan in it
  async 'docx-proposal'({ owner, threadId, prev, status }) {
    const { delegate } = await import('../agent.js')
    const [p] = await q('select email, name from pro_profile where user_id=$1', [owner])
    const { user, session } = await sessionFor(p.email, p.name)
    const customer = prev.customer || L('고객', 'Customer')
    const name = L(`${customer} 제안서.docx`, `${customer} proposal.docx`)
    let picture = null
    if (prev.floor_plan?.url) {
      status(L('제안서에 넣을 평면도 그림 만드는 중', 'Rendering the floor plan for the proposal'))
      picture = await planPicture(prev.floor_plan.url).catch((e) => { console.warn('[skill-worker] plan picture', e.message); return null })
    }
    const rooms = String(prev.rooms || '').split('\n').join(' / ')
    const since = new Date()
    status(L('워드 제안서 쓰는 중', 'Writing the Word proposal'))
    await delegate({ user, session, threadId, silent: true,
      text: L(`프로세스 '제안서 작성' 단계예요. 고객 메일(${prev.subject})에 회신할 매장 설계 제안서를 워드(docx) 스킬로 /workspace/${name} 에 만드세요. 표지(고객·제목·날짜), 설계 콘셉트, 공간 구성 표(실 이름·면적·용도: ${rooms}), ${picture ? `평면도 그림(${picture}, 쪽 너비에 맞춰), ` : ''}일정, 다음 단계 순서로 쓰세요.\n메일 본문: ${String(prev.body || '').slice(0, 2000)}\n\n(평면도와 견적서는 다른 단계가 만드니 만들지 마세요.) 다 만들면 파일 이름만 짧게 알리세요.`,
        `This is the 'Write proposal' step of a process. With the Word (docx) skill, create the store design proposal that answers the customer mail (${prev.subject}) at /workspace/${name}: a cover (customer, title, date), the design concept, a space plan table (room, area, use: ${rooms}), ${picture ? `the floor plan picture (${picture}, fitted to the page width), ` : ''}the schedule and next steps, in that order.\nMail body: ${String(prev.body || '').slice(0, 2000)}\n\n(Other steps make the floor plan and the quote — do not make them.) When it is done, just give the file name.`) })  // (delegate adds the language instruction)
    const f = await newFile(threadId, since, 'docx')
    if (!f) throw new Error(L('제안서 파일을 찾지 못했어요', "I couldn't find the proposal file"))
    return { values: { proposal: f }, say: L(`평면도를 넣은 워드 제안서(${f.name})를 썼어요.`, `I wrote the Word proposal (${f.name}) with the floor plan in it.`) }
  },
  // the agent's xlsx skill (deepagents), in the instance's conversation
  // extra: what the process ontology's task definition adds (its form and checkpoints, lib/ontology/run.js)
  async xlsx({ owner, threadId, prev, status, extra = '' }) {
    const { delegate } = await import('../agent.js')
    const [p] = await q('select email, name from pro_profile where user_id=$1', [owner])
    const { user, session } = await sessionFor(p.email, p.name)
    const name = L(`${prev.customer || '고객'} 견적서.xlsx`, `${prev.customer || 'Customer'} quote.xlsx`)
    const since = new Date()
    status(L('엑셀 견적서 만드는 중', 'Building the Excel quote'))
    const msg = await delegate({ user, session, threadId, silent: true,
      text: L(`프로세스 '견적서 작성' 단계예요. 고객 메일(${prev.subject})에 회신할 견적서를 만드세요. 평면도의 실별 면적: ${String(prev.rooms || '').split('\n').join(' / ')}\n메일 본문: ${String(prev.body || '').slice(0, 2000)}\n\n` +
        `엑셀(xlsx) 스킬로 /workspace/${name} 를 만드세요: 위에 제목·수신·발신·견적일·유효기간, 품목 표(구분·품목·수량·단위·단가·금액, 금액은 =수량*단가 수식) — 설계비(평면·마감 설계, 1식), 실별 인테리어 공사(면적 ㎡ × ㎡당 단가, 실마다 한 줄), 가구·집기(좌석 수 기준), 전기·설비(1식), 그 아래 공급가액 소계·부가세(10%)·합계 행(모두 수식), 천 단위 쉼표, 머리글 색 구분. 단가는 합리적인 가정값.\n\n${extra ? `${extra}\n\n` : ''}` +
        `(평면도와 제안서는 앞 단계에서 이미 만들었으니 만들지 마세요.) 같은 이름의 파일이 이미 있어도 이 건을 위해 처음부터 새로 만들어 덮어쓰세요 — 이전 파일을 그대로 쓰지 마세요. 다 만들면 파일 이름과 가정한 단가를 두세 줄로 적고, 맨 마지막 줄에 부가세 포함 합계를 원 단위 숫자로 "TOTAL: 51216000" 처럼 한 줄로 쓰세요. 모두 한국어(해요체)로 쓰세요.`,
      `This is the 'Prepare quote' step of a process. Build the quote that answers the customer mail (${prev.subject}). Room areas from the floor plan: ${String(prev.rooms || '').split('\n').join(' / ')}\nMail body: ${String(prev.body || '').slice(0, 2000)}\n\n` +
        `With the Excel (xlsx) skill, create /workspace/${name}: at the top the title, to, from, quote date and validity; an item table (category, item, quantity, unit, unit price, amount — amount as the formula =quantity*unit price) with the design fee (floor plan and finishing design, 1 lot), interior work per room (area in ㎡ × price per ㎡, one row per room), furniture and fixtures (by the number of seats), and electrical and equipment (1 lot); below it subtotal, VAT (10%) and total rows (all formulas), thousands separators, colored header row. Use reasonable assumed unit prices in KRW (₩).\n\n${extra ? `${extra}\n\n` : ''}` +
        `(The floor plan and the proposal were made in earlier steps — do not make them.) Even if a file with that name already exists, build it anew for this case and overwrite it — do not reuse the earlier file. When it is done, give the file name and the unit prices you assumed in two or three lines, and on the very last line the total incl. VAT in won as a plain number, like "TOTAL: 51216000". Write everything in English.`) })  // (delegate adds the language instruction)
    const f = await newFile(threadId, since, 'xlsx')
    if (!f) throw new Error(L('견적서 파일을 찾지 못했어요', "I couldn't find the quote file"))
    // the agent's answer streams its progress first; the last paragraphs are the summary (file, assumed
    // prices), its last line the total — the amount a mined review's skip rule reads (service.js reviewRule)
    // the file itself is the step's quote value: its link would show raw on the next step's card
    const plain = String(msg?.content?.text || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    const { total, rest } = quoteTotal(plain)
    const text = rest.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).slice(-3).join('\n\n').slice(0, 1500)
    return { values: { quote: f, ...(total != null ? { amount: String(total) } : {}), assumptions: text }, say: null }
  },
}

// 회사 엑셀 양식 채우기: the cells of the company's latest file (labels, last case's values, formulas) and this case go to the
// model (the skill's prompts/fill-form.md), which names the cells to change; only those cells are rewritten in the file's own
// XML — every other part (styles, formulas, merged cells, comments, links) stays byte for byte as the company made it, and the
// workbook is marked to recalculate its formulas when opened
const xmlEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const xmlText = (t) => String(t).replace(/<[^>]+>/g, '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const CELL = /<c r="([A-Z]{1,3}\d{1,7})"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
export async function xlsxSheets(buf) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buf)
  const read = async (p) => (zip.file(p) ? zip.file(p).async('string') : '')
  const rels = await read('xl/_rels/workbook.xml.rels')
  const target = (id) => { const t = rels.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))?.[1] || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${id}"`))?.[1] || ''; return t.startsWith('/') ? t.slice(1) : `xl/${t}` }
  const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]))
  const sheets = []
  for (const m of (await read('xl/workbook.xml')).matchAll(/<sheet\b[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    const file = target(m[2])
    const xml = await read(file)
    const cells = []
    for (const c of xml.matchAll(CELL)) {
      const [, ref, attrs, inner = ''] = c
      const t = attrs.match(/\bt="([^"]+)"/)?.[1] || ''
      const f = inner.match(/<f[^>]*>([\s\S]*?)<\/f>/)?.[1]
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      const value = f != null ? `=${xmlText(f)}` : t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? xmlText(inner.match(/<is>([\s\S]*?)<\/is>/)?.[1] || '') : xmlText(v ?? '')
      if (String(value).trim()) cells.push({ cell: ref, value: String(value).trim().slice(0, 200) })
    }
    sheets.push({ name: xmlText(m[1]), file, cells })
  }
  return { zip, sheets }
}
const excelDay = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000)
async function fillXlsx({ owner, threadId, prev, status, extra = '', template, step = '' }) {
  const fsp = await import('node:fs/promises')
  const path = await import('node:path')
  const { chatJson } = await import('../llm.js')
  const { prompt } = await import('../ontology/discovery.js')
  const { workspaceHostPath } = await import('../missions.js')
  const { publish } = await import('../office.js')
  const { zip, sheets } = await xlsxSheets(await fsp.readFile(template.path))
  const cells = sheets.flatMap((sh) => sh.cells.map((c) => ({ sheet: sh.name, ...c })))
  status(L(`회사 양식 「${template.name}」의 칸 ${cells.length}개를 이 건으로 채우는 중`, `Filling ${cells.length} cells of the company form ${template.name}`))
  const r = await chatJson(await prompt('fill-form'), JSON.stringify({ form: template.name, step, case: { subject: prev.subject || '', body: String(prev.body || '').slice(0, 3000), customer: prev.customer || '' },
    definition: extra.slice(0, 3000), cells: cells.slice(0, 600) }), { timeoutMs: 180000, temperature: 0 })
  const formula = new Set(cells.filter((c) => c.value.startsWith('=')).map((c) => `${c.sheet}!${c.cell}`))
  let changed = 0
  for (const sh of sheets) {
    const want = new Map((r?.cells || []).filter((x) => (String(x.sheet || sheets[0].name) === sh.name) && /^[A-Z]{1,3}\d{1,7}$/.test(String(x.cell || '')) && !formula.has(`${sh.name}!${x.cell}`)).map((x) => [String(x.cell), x.value]))
    if (!want.size) continue
    let xml = await zip.file(sh.file).async('string')
    xml = xml.replace(CELL, (all, ref, attrs) => {
      if (!want.has(ref)) return all
      const v = want.get(ref)
      const style = attrs.match(/\bs="(\d+)"/)?.[0] || ''
      let t = String(v ?? '').trim()
      changed++
      if (t === '') return `<c r="${ref}"${style ? ` ${style}` : ''}/>`
      // a cell that held text keeps text (a date written 「2027/01/01」 keeps that shape); one that held a number keeps a number
      const was = sh.cells.find((c) => c.cell === ref)?.value || ''
      if (/\bt="(s|inlineStr|str)"/.test(attrs)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(t) && /^\d{4}[./]\d{2}[./]\d{2}$/.test(was)) t = t.replace(/-/g, was[4])
        return `<c r="${ref}"${style ? ` ${style}` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(t)}</t></is></c>`
      }
      if (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(t.replace(/,/g, ''))) return `<c r="${ref}"${style ? ` ${style}` : ''}><v>${Number(t.replace(/,/g, ''))}</v></c>`
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return `<c r="${ref}"${style ? ` ${style}` : ''}><v>${excelDay(t)}</v></c>`
      return `<c r="${ref}"${style ? ` ${style}` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(t)}</t></is></c>`
    })
    zip.file(sh.file, xml)
  }
  if (!changed) throw new Error(L('양식에서 바꿀 칸을 정하지 못했어요', "Couldn't decide which cells of the form to fill"))
  // formulas keep their last results until recalculated: the file asks to be recalculated when it is opened
  const wbXml = await zip.file('xl/workbook.xml').async('string')
  zip.file('xl/workbook.xml', /<calcPr\b/.test(wbXml) ? wbXml.replace(/<calcPr\b(?![^>]*fullCalcOnLoad)/, '<calcPr fullCalcOnLoad="1"') : wbXml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>'))
  const who = String(prev.customer || '').replace(/[\\/:*?"<>|]/g, ' ').trim()
  const name = `${who ? `${who} ` : ''}${template.name.replace(/\.[a-z0-9]+$/i, '')}.xlsx`
  const rel = `/workspace/forms-out/${Date.now().toString(36)}/${name}`
  const host = await workspaceHostPath('/workspace') + rel.slice('/workspace'.length)
  await fsp.mkdir(path.dirname(host), { recursive: true })
  await fsp.writeFile(host, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const doc = await publish(owner, rel)
  await addMessage(owner, threadId, 'agent', 'file', { ...doc, path: rel })
  const assumed = (r.assumptions || []).map(String).slice(0, 8)
  const total = Number(r.total) > 0 ? Number(r.total) : null
  return { values: { document: { name: doc.name, url: doc.url }, form: template.name, cells: changed, ...(total ? { amount: String(total) } : {}),
    assumptions: assumed.join('\n') }, say: null }
}

// "TOTAL: 51,216,000" (or "합계: 5,121만 6천 원" read by improve's numberOf) on its own line → the number,
// and the answer without that line
export function quoteTotal(answer) {
  const lines = String(answer || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*[*_`]*\s*(?:TOTAL|Total|합계)\s*[:：]\s*[*_`]*\s*(?:₩|KRW\s*)?([^*_`]+?)\s*(?:원|KRW|won)?\s*[*_`]*\s*$/.exec(lines[i])
    if (!m) continue
    const total = numberOf(m[1].replace(/\s+/g, ''))
    if (total != null) return { total, rest: [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n') }
  }
  return { total: null, rest: String(answer || '') }
}

// a step runs in the language of the person it acts for (their saved language)
async function handle(row) {
  const owner = await ownerOf(row)
  return withLang(await langOf(owner), () => handleIn(row))
}
async function handleIn(row) {
  const job = crypto.randomUUID()
  const base = { job_id: job, todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: ORCH }
  const [a] = await q(`select a as act from proc_def, jsonb_array_elements(definition->'activities') a where id=$1 and tenant_id=$2 and a->>'id'=$3`, [row.proc_def_id, row.tenant_id, row.activity_id])
  const act = a?.act || {}
  const skill = (act.skills || []).find((k) => SKILLS[k]) || stepOf(act.name || row.activity_name)?.skill
  if (!SKILLS[skill]) throw new Error(L(`이 단계의 스킬을 찾지 못했어요: ${skill || '(없음)'}`, `I couldn't find this step's skill: ${skill || '(none)'}`))
  const owner = await ownerOf(row)
  if (!owner) throw new Error('no human participant to act for')
  const threadId = await instanceThread(owner, row.proc_inst_id)
  const status = (text) => emit(owner, 'status', { threadId, text })
  await events([{ ...base, event_type: 'task_started', data: { goal: L(`${row.activity_name} — 스킬 ${skill}`, `${row.activity_name} — skill ${skill}`), name: act.role || row.activity_name, role: row.activity_name } }])
  await events([{ ...base, event_type: 'tool_usage_started', data: { tool: skill, tool_name: skill, args: { step: row.activity_name } } }])
  let r
  try { r = await SKILLS[skill]({ owner, threadId, prev: await earlier(row.proc_inst_id), status }) } finally { status(null) }
  await events([{ ...base, event_type: 'tool_usage_finished', data: { tool: skill, tool_name: skill, result: JSON.stringify(r.values).slice(0, 500) } }])
  const formId = (act.tool || '').startsWith('formHandler:') ? act.tool.slice(12) : `${row.activity_id}_form`
  const payload = { [formId]: r.values }
  const { error } = await admin.rpc('save_task_result', { p_todo_id: row.id, p_payload: payload, p_final: true })
  if (error) throw new Error('save_task_result: ' + error.message)
  await events([
    { ...base, crew_type: 'result', event_type: 'task_completed', data: payload },
    { job_id: 'CREW_FINISHED', todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: 'crew', event_type: 'crew_completed', data: 'Task completed successfully' },
  ])
  if (r.say) await addMessage(owner, threadId, 'agent', 'text', { text: `${act.role || L('에이전트', 'Agent')} · ${row.activity_name}: ${r.say}` })
  emit(owner, 'process', { instId: row.proc_inst_id, type: 'changed' })
}

// A person's step keeps its skill too: the reply step (skill mail-reply) opens with a draft written
// from the earlier steps, which the person edits and sends.
const drafting = new Set()
async function draftReplies() {
  const rows = await q(`select t.id, t.proc_inst_id, t.user_id, a->>'tool' as tool from todolist t
                        join proc_def d on d.id=t.proc_def_id and d.tenant_id=t.tenant_id
                        join jsonb_array_elements(d.definition->'activities') a on a->>'id' = t.activity_id
                        where t.tenant_id=$1 and t.status='IN_PROGRESS' and t.agent_orch is null and t.draft is null
                          and a->'skills' ? 'mail-reply' limit 3`, [config.tenantId])
  for (const r of rows) {
    if (drafting.has(r.id)) continue
    drafting.add(r.id)
    try {
      const p = await earlier(r.proc_inst_id)
      const { chat } = await import('../llm.js')
      // in the language of the person who sends it (English mode: an English reply signed by the
      // English cast's proposal team lead)
      const who = String(r.user_id || '').split(',')[0].trim()
      const en = (await langOf(who)) === 'en'
      const out = await withLang(en ? 'en' : 'ko', () => chat({ messages: en ? [
        { role: 'system', content: 'You write the body of an English e-mail replying to a customer\'s request. Polite and professional, at most 8 lines, in this order: greeting, the attachments (proposal and quote), what the finance review changed if anything, and asking them to reply. Sign it "Best regards,\nJinyoung Jang". Write the body only.' },
        { role: 'user', content: JSON.stringify({ customer: p.customer, sender: p.sender, subject: p.subject, request: String(p.body || '').slice(0, 800), attachments: [p.floor_plan?.name, p.proposal?.name, p.quote?.name].filter(Boolean), finance_review: p.decision, review_comment: p.comment || '' }) },
      ] : [
        { role: 'system', content: '고객 요청 메일에 회신하는 한국어 메일 본문을 씁니다. 정중한 존댓말(습니다체), 8줄 이내, 인사·첨부 안내(제안서·견적서)·검토 의견 반영·회신 요청 순서. 서명은 "김지수 드림". 본문만 쓰세요.' },
        { role: 'user', content: JSON.stringify({ 고객: p.customer, 보낸사람: p.sender, 제목: p.subject, 요청: String(p.body || '').slice(0, 800), 첨부: [p.floor_plan?.name, p.proposal?.name, p.quote?.name].filter(Boolean), 재무검토: p.decision, 검토의견: p.comment || '' }) },
      ] }))
      const text = String(out?.choices?.[0]?.message?.content || out?.content || out || '').trim()
      const formId = (r.tool || '').startsWith('formHandler:') ? r.tool.slice(12) : 'defaultform'
      if (text) await q('update todolist set draft=$2 where id=$1 and draft is null', [r.id, { [formId]: { reply: text } }])
    } catch (e) { console.warn('[skill-worker] reply draft', e.message) } finally { drafting.delete(r.id) }
  }
}

async function tick() {
  draftReplies().catch((e) => console.warn('[skill-worker] drafts', e.message))
  if (busy) return
  busy = true
  try {
    const { data, error } = await admin.rpc('fetch_pending_task', { p_agent_orch: ORCH, p_consumer: CONSUMER, p_limit: 1, p_env: 'dev' })
    if (error) throw new Error(error.message)
    const row = data?.[0]
    if (!row) return
    // one install serves one tenant; behind the ProcessGPT gateway a step runs as the tenant it belongs to
    if (!servesTenant(row.tenant_id)) {
      await admin.from('todolist').update({ draft_status: null, consumer: null }).eq('id', row.id)
      return
    }
    console.log('[skill-worker] claimed', row.id, row.activity_name)
    try { await withTenant(row.tenant_id, () => handle(row)) } catch (e) {
      console.warn('[skill-worker] failed', e.message)
      await admin.from('todolist').update({ draft_status: 'FAILED', consumer: null }).eq('id', row.id)
      await events([{ job_id: crypto.randomUUID(), todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: ORCH, event_type: 'error', data: { message: e.message } }])
    }
  } catch (e) { console.warn('[skill-worker]', e.message) } finally { busy = false }
}

export async function startSkillWorker() {
  const freed = await q(`update todolist set consumer=null, draft_status=null
                         where agent_orch=$1 and status='IN_PROGRESS' and consumer like 'pgpt-pro-skill-%' and consumer <> $2 returning id, activity_name`, [ORCH, CONSUMER]).catch(() => [])
  for (const r of freed) console.log('[skill-worker] released', r.id, r.activity_name)
  setInterval(tick, 4000)
  console.log(`[skill-worker] polling agent_orch=${ORCH} as ${CONSUMER}`)
}
