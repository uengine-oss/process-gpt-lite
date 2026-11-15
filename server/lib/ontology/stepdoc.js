// 문서를 만드는 단계(run.js runStep): 이 일이 쓰는 양식(formats.js chosenForm)에 메일에서 남겨 둔 파일이 있으면 그 파일을 복사해 이 건으로
// 채우고(엑셀: mining/worker.js 의 셀 채우기, 워드 · 파워포인트 · 한글: docfill.js 의 문단 채우기 — 둘 다 도구 없이), 없으면 doc-draft 가 쓴
// 글을 워드 파일로 만든다 — 어느 쪽이든 이음오피스에서 열 수 있는 파일이 단계 결과에 남는다. 결과에는 쓴 양식(이름 · 누가 정했는지), 양식에서
// 바꾼 것 한 줄, 형식 규칙 점검(꼭 지킬 것마다 ok · 까닭)이 함께 남는다. 양식은 출발점이고 내용은 이 건의 요청대로 바꾼다.
// 초안(사람 단계의 준비 · 되돌릴 수 없는 단계의 초안)도 같은 길이라 무엇도 보내거나 예약하지 않는다 — 파일만 만든다.
import { chatJson } from '../llm.js'
import { prompt, rules } from './discovery.js'

const DOC = ['docx', 'xlsx', 'pptx', 'hwpx']
export const outputFormat = (act) => (act?.outputs || []).map((o) => String(o?.format || '').toLowerCase().replace(/^\./, '')).find((f) => DOC.includes(f)) || ''
const extOf = (p) => String(p || '').split('.').pop().toLowerCase()
const stem = (n) => String(n || '').replace(/\.[a-z0-9]+$/i, '')
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()

async function caseOf(row) {
  const RM = await import('./runmode.js')
  const { caseIntake } = await import('./run.js')
  const c = await RM.caseOfInstance(row.proc_inst_id)
  const intake = c ? await caseIntake(c) : {}
  const earlier = c ? await RM.earlierOfCase(c) : []
  return { c, intake, earlier }
}

// what a form · its checks record on the step's result
export async function markForm(values, { task, form, buf = null }) {
  const F = await import('./formats.js')
  const doc = values.document || values.quote || values.proposal || null
  const rules = doc ? await F.checkFile(task, form.name, { name: doc.name, buf, url: doc.url, ofTask: form.ofTask || null }) : []
  return { ...values, form: { name: form.name, chosenBy: form.chosenBy || null, label: F.CHOSEN_KO[form.chosenBy] || '' }, ...(rules.length ? { formatRules: rules } : {}) }
}

// the work's form filled for this case → {values:{document, form, formatRules, changedFromForm, result, …}}
export async function formStep({ row, act, owner, threadId, status, form, extra = '' }) {
  const kind = extOf(form.path)
  const task = row.activity_name
  const W = await import('../mining/worker.js')
  if (kind === 'xlsx') {
    const r = await W.SKILLS['form-fill']({ owner, threadId, prev: await W.earlier(row.proc_inst_id), status, extra, template: form, step: task })
    const v = await markForm(r.values, { task, form })
    return { values: { ...v, changedFromForm: `칸 ${r.values.cells || 0}개를 이 건의 값으로 바꿨어요${r.values.assumptions ? ` · 가정: ${String(r.values.assumptions).split('\n')[0].slice(0, 80)}` : ''}`,
      result: v.result || `${form.name} 양식으로 만든 ${v.document?.name || '파일'}${r.values.assumptions ? `\n${r.values.assumptions}` : ''}` }, say: null }
  }
  const DF = await import('./docfill.js')
  const F = await import('./formats.js')
  if (!DF.fillable(kind)) throw new Error(`이 양식(${kind})은 채우지 못해요`)
  status(`회사 양식 「${form.name}」으로 만드는 중`)
  const { c, intake, earlier } = await caseOf(row)
  const fr = await F.formatOf(task, form.name, form.ofTask || null)
  const keep = (fr?.items || []).filter((x) => x.mandatory && !['image', 'filename'].includes(x.kind)).flatMap((x) => (x.fixed?.length ? x.fixed : [x.text]))
  const input = { form: form.name, step: task, today: new Date().toLocaleDateString('sv-SE', { timeZone: process.env.PRO_TZ || 'Asia/Seoul' }),
    case: { subject: intake.subject || c?.trigger?.subject || '', body: String(intake.body || '').slice(0, 3000), customer: intake.customer || c?.trigger?.customer || '' },
    definition: { description: act.description || '', instruction: String(act.instruction || '').slice(0, 2000), checkpoints: act.checkpoints || [], extra: String(extra || '').slice(0, 1500) },
    earlier: earlier.slice(-4).map((x) => ({ step: x.task, text: String(x.text || '').slice(0, 1200) })) }
  const R = (await rules()).formats || {}
  const out = await DF.fillDocument({ template: form, kind, input, keep, max: R.fillParagraphs || 260, chars: R.fillChars || 240,
    ask: async (inp) => chatJson(await prompt('fill-document'), JSON.stringify(inp), { timeoutMs: R.fillTimeoutMs || 300000, temperature: 0, ...(R.fillEffort ? { effort: R.fillEffort } : {}) }) })
  const who = safe(intake.customer || c?.trigger?.customer || '')
  const file = await DF.keepFile(owner, threadId, `${who ? `${who} ` : ''}${stem(form.name)}.${kind}`, out.buf)
  // what the next steps read of it: the filled document's own text
  const facts = await F.docFacts(file.name, out.buf).catch(() => null)
  const text = facts ? facts.body.join('\n').slice(0, 4000) : ''
  const v = await markForm({ document: file, title: out.title || stem(form.name), summary: out.summary || `${form.name} 양식으로 만들었어요.`, result: text, assumptions: out.assumptions.join('\n') }, { task, form, buf: out.buf })
  return { values: { ...v, changedFromForm: out.summary || `문단 ${out.changed}개를 바꾸고 ${out.added}개를 더했어요`, paragraphs: { changed: out.changed, added: out.added, keptFixed: out.kept } }, say: null }
}

// a text-only step (doc-draft · a draft): a document step makes a file — from the form when there is one, else the text as Word; a
// message or a note stays text, with the form filled beside it when the work hands over a document
export async function draftStep({ row, act, kind, owner, threadId, status, form, draftText, extra = '' }) {
  const fmt = outputFormat(act)
  const makesDoc = kind === 'document' || !!fmt
  if (form && makesDoc) {
    try {
      if (kind === 'document') return await formStep({ row, act, owner, threadId, status, form, extra })
      const t = await draftText(kind)
      const f = await formStep({ row, act, owner, threadId, status, form, extra })
      const { result, title, summary, ...doc } = f.values
      return { values: { ...t.values, ...doc }, say: null }
    } catch (e) {
      console.warn('[onto-step] form', form.name, e.message)
      const t = await draftText(kind)
      return kind === 'document' ? asWord(t, { owner, threadId, note: `양식 「${form.name}」으로 채우지 못해(${String(e.message).slice(0, 60)}) 글로 쓴 초안을 워드 파일로 만들었어요`, form }) : t
    }
  }
  const t = await draftText(kind)
  return kind === 'document' ? asWord(t, { owner, threadId, note: '이 일에는 메일에서 남겨 둔 양식 파일이 없어 글로 쓴 초안을 워드 파일로 만들었어요' }) : t
}
// the files a case's steps made (지켜보기): the file, the form it came from and its format check, per work item — a draft too
export async function stepFiles(caseId) {
  const { getCase } = await import('./run.js')
  const { q } = await import('../supa.js')
  const c = await getCase(caseId)
  const rows = c.instances?.length ? await q(`select id::text as id, output, draft from todolist where proc_inst_id = any($1)`, [c.instances]) : []
  const first = (o) => Object.values(o || {}).find((x) => x && typeof x === 'object') || {}
  const steps = {}
  for (const r of rows) {
    const v = first(r.output), d = first(r.draft)
    const x = Object.keys(v).length ? v : d
    const f = x.document || x.quote || x.proposal || x.floor_plan || null
    if (!f?.url && !x.form) continue
    steps[r.id] = { file: f?.url ? { name: f.name, url: f.url } : null, form: x.form && typeof x.form === 'object' ? x.form : x.form ? { name: String(x.form), chosenBy: null } : null,
      formatRules: Array.isArray(x.formatRules) ? x.formatRules : [], changed: x.changedFromForm || '', draft: !Object.keys(v).length }
  }
  return { caseId, steps }
}

async function asWord(t, { owner, threadId, note, form = null }) {
  const DF = await import('./docfill.js')
  try {
    const buf = await DF.textDocx({ title: t.values.title, text: t.values.result })
    const file = await DF.keepFile(owner, threadId, `${safe(t.values.title) || '초안'}.docx`, buf)
    return { values: { ...t.values, document: file, form: form ? { name: form.name, chosenBy: form.chosenBy || null, failed: true } : null, changedFromForm: note }, say: t.say }
  } catch (e) { console.warn('[onto-step] docx', e.message); return t }
}
