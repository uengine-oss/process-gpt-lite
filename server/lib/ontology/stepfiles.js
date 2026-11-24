// 사람 단계의 결과 파일(「지도에서 바로」 건 — mapengine.js): 파일 칸이 있는지는 그 단계의 일 정의가 정한다(outputs 의 형식이 파일이면
// 그 이름으로 칸 하나). 파일은 입력 폼의 파일 칸으로도, 채팅에 올려서도 낸다 — 둘 다 채팅 첨부와 같은 곳(attachments.js: 에이전트 작업 공간 +
// 저장소)에 같은 모양 {name, size, type, path, url} 으로 남고, 단계 결과의 같은 칸(files · files_2 …)에 들어간다. 뒤 단계(에이전트 · 간선
// 규칙 · 문서 초안)는 runmode.js earlierOfCase 로 그 파일의 글을 읽는다.
//
// 채팅에서 파일을 올리며 어느 단계 것인지 말하면(단계 이름), 그 사람이 맡아 기다리는 그 단계로 바로 낸다 — 새 건 시작은 묻지 않는다.
// 이름을 말하지 않았거나 같은 이름의 단계가 여러 건에 있으면 내기 전에 묻는다(카드 kind 'step-file-ask'). 기다리는 파일 단계와 상관없는
// 파일(모델이 그렇게 읽음)은 예전처럼 간다(events.js onFile).
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { addMessage, updateMessage } from '../store.js'
import { chatJson } from '../llm.js'
import { prompt } from './discovery.js'

const err = (status, message) => Object.assign(new Error(message), { status })
const squash = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()

// ---------- 일 정의 → 파일 칸 ----------
// outputs 의 형식이 파일인 것(문서 · 표 · 그림 · 압축 · 「파일」): 글 · 메일 · 메시지로 넘기는 것은 칸이 아니다
const FILE_FORMAT = /^(file|파일|증빙|첨부|pdf|jpe?g|png|gif|webp|heic|image|이미지|사진|xlsx?|csv|docx?|pptx?|hwpx?|txt|md|zip)$/i
export function fileOutputs(outputs) {
  return (Array.isArray(outputs) ? outputs : [])
    .filter((o) => o && typeof o === 'object' && FILE_FORMAT.test(String(o.format || '').trim().replace(/^\./, '')))
    .map((o) => ({ name: String(o.name || '파일').slice(0, 60), format: String(o.format).trim().replace(/^\./, '').toLowerCase() }))
}
export const fileKey = (i) => (i ? `files_${i + 1}` : 'files')
const FILE_KEY = /^files(_\d+)?$/
// the work item's file fields (mapengine.js todoView): one per file output, several files each, uploaded where the agent reads them
export const fileFields = (files) => (files || []).map((f, i) => ({ key: fileKey(i), text: f.name, type: 'file', multiple: true, upload: 'attachment', format: f.format }))

// a file as kept in a step's result: what was uploaded, nothing else
const isFile = (x) => x && typeof x === 'object' && x.name && (x.url || x.path)
const asFile = (x) => ({ name: String(x.name).slice(0, 160), url: x.url || '', path: x.path || '', type: x.type || '', size: Number(x.size) || 0 })
// the files a person handed in with a step (its values' file fields), in order
export function filesOf(values) {
  const out = []
  for (const [k, v] of Object.entries(values || {})) {
    if (!FILE_KEY.test(k)) continue
    for (const x of Array.isArray(v) ? v : [v]) if (isFile(x)) out.push(asFile(x))
  }
  return out
}

// ---------- 파일의 글 ----------
// what a later step reads of a file: its text (events.js readUpload — xlsx · docx · pptx · hwpx · csv · txt · md · json), kept for a while
// by path (an upload never changes). A file whose text cannot be read is passed by name and path (the agent can open it in its workspace).
const texts = new Map()
export async function fileText(f, chars = 3000) {
  const k = f.path || f.url
  if (!k) return ''
  if (!texts.has(k)) {
    const { readUpload } = await import('./events.js')
    texts.set(k, String(await readUpload(f).catch(() => '') || '').replace(/\s+\n/g, '\n').trim())
    if (texts.size > 200) texts.delete(texts.keys().next().value)
  }
  return texts.get(k).slice(0, chars)
}
export async function withText(files, chars) {
  return Promise.all((files || []).map(async (f) => ({ name: f.name, path: f.path || '', text: await fileText(f, chars) })))
}

// ---------- 채팅에서 낸 파일 ----------
// the person's open steps of map cases that take files (their form has a file field): what a file in chat could be for
export async function openFileSteps(userId) {
  const rows = await q(`select t.id::text as id, t.activity_name as task, t.proc_inst_id, t.user_id, s.act, c.id::text as case_id, c.trigger, c.request, c.created_at
                        from todolist t join pro_case_steps s on s.todo_id = t.id join pro_po_cases c on c.id = s.case_id
                        where t.proc_inst_id like 'onto-map.%' and t.status::text = 'IN_PROGRESS' and s.kind in ('person','draft')
                          and $1 = any(string_to_array(replace(t.user_id, ' ', ''), ',')) and c.status = 'running'
                        order by t.start_date desc limit 30`, [String(userId)])
  return rows.filter((r) => (r.act?.files || []).length).map((r) => ({
    todoId: r.id, task: r.task, caseId: r.case_id, instId: r.proc_inst_id,
    subject: String(r.trigger?.subject || r.request?.subject || r.task).slice(0, 120), kind: r.trigger?.kind || '', fields: fileFields(r.act.files),
  }))
}

// which waiting step the words name: every step whose name is said; of those, the ones whose case the words also point at (its subject's
// words) when that leaves fewer
export function namedSteps(said, steps) {
  const s = squash(said)
  const named = steps.filter((x) => s.includes(squash(x.task)))
  if (named.length < 2) return named
  const words = (x) => [...new Set(String(x.subject).split(/[\s·,.()\[\]「」'"]+/).filter((w) => w.length >= 2))]
  const hit = named.filter((x) => words(x).some((w) => s.includes(squash(w))))
  return hit.length && hit.length < named.length ? hit : named
}

// is the file the result of one of the waiting steps (the model reads the words and the file names)? null: something else (a new
// request, a question about the file) — the turn goes on as before
async function forWaitingStep(said, files, steps) {
  const input = { said: String(said || '').slice(0, 600), files: files.map((f) => f.name), waiting: steps.map((x, i) => ({ n: i + 1, step: x.task, case: x.subject })) }
  const r = await chatJson(await prompt('step-file'), JSON.stringify(input), { temperature: 0, timeoutMs: 30000 }).catch((e) => { console.warn('[step-files] read', e.message); return null })
  if (!r?.for_step) return null
  const n = Number(r.pick)
  return { pick: Number.isInteger(n) && n >= 1 && n <= steps.length ? steps[n - 1] : null }
}

// a file attached in chat (lib/agent.js handleTurn, before the file event): handed in to the step it names, or asked about first.
// → null (not for a waiting step: the turn goes on) · {message} (said here; the turn ends)
export async function fromChat({ user, threadId, said, files }) {
  const ups = (files || []).filter(isFile).map(asFile)
  if (!ups.length) return null
  const steps = await openFileSteps(user.id)
  if (!steps.length) return null
  const named = namedSteps(said, steps)
  if (named.length === 1) {
    const r = await submitFiles({ me: user, todoId: named[0].todoId, files: ups, said, threadId })
    return { message: r.message }
  }
  let options = named
  if (!named.length) {
    const read = await forWaitingStep(said, ups, steps)
    if (!read) return null
    options = read.pick ? [read.pick, ...steps.filter((x) => x.todoId !== read.pick.todoId)] : steps
  }
  const text = named.length
    ? `「${named[0].task}」 단계가 ${named.length}건에서 기다리고 있어요. 어느 건의 결과로 낼까요?`
    : '이 파일을 어느 단계의 결과로 낼까요? 기다리는 단계의 결과가 아니면 「새 요청으로」를 눌러 주세요.'
  const message = await addMessage(user.id, threadId, 'agent', 'step-file-ask', {
    text, said: String(said || '').slice(0, 600), files: ups, state: 'asking',
    options: options.slice(0, 6).map((x) => ({ todoId: x.todoId, task: x.task, subject: x.subject, caseId: x.caseId })),
  })
  return { message }
}

// hand a step in with files (the chat's direct hand-in, or the ask card's choice): the person must hold the step and it must be open;
// the files go in the step's first file field next to what is there (its draft · an earlier upload), the words typed with them are the
// step's result when it has none
export async function submitFiles({ me, todoId, files, said = '', threadId = null, messageId = null }) {
  const ups = (files || []).filter(isFile).map(asFile)
  if (!ups.length) throw err(400, '낼 파일이 없어요.')
  const [t] = await q(`select t.*, t.status::text as status, s.act, c.trigger, c.id::text as case_id from todolist t join pro_case_steps s on s.todo_id = t.id
                       join pro_po_cases c on c.id = s.case_id where t.id::text = $1`, [String(todoId)])
  if (!t) throw err(404, '그 단계를 찾지 못했어요.')
  const holders = String(t.user_id || '').split(',').map((x) => x.trim())
  if (!holders.includes(String(me.id))) throw err(403, '내가 맡은 단계가 아니에요.')
  if (t.status !== 'IN_PROGRESS') throw err(409, t.status === 'TODO' ? '아직 이 단계를 할 차례가 아니에요.' : '이미 닫힌 단계예요.')
  const fields = fileFields(t.act?.files)
  if (!fields.length) throw err(400, `「${t.activity_name}」에는 파일 칸이 없어요.`)
  const formId = String(t.act?.tool || '').startsWith('formHandler:') ? t.act.tool.slice(12) : `${t.activity_id}_form`
  const now = { ...((t.draft || {})[formId] || {}), ...((t.output || {})[formId] || {}) }
  const key = fields[0].key
  const kept = filesOf({ [key]: now[key] })
  const seen = new Set(kept.map((f) => f.path || f.url))
  const values = { ...now, result: String(now.result || '').trim() || String(said || '').trim(), [key]: [...kept, ...ups.filter((f) => !seen.has(f.path || f.url))], via: 'chat' }
  const { submitTodo } = await import('../engine.js')
  await submitTodo({ me, todoId: t.id, values })
  // the step's own card in chat (toPerson's 'todo') shows it handed in
  for (const m of await q(`select id from pro_messages where kind='todo' and content->>'todoId'=$1`, [String(t.id)])) await updateMessage(me.id, m.id, { state: 'submitted' })
  if (messageId) await updateMessage(me.id, messageId, { state: 'submitted', todoId: String(t.id), task: t.activity_name })
  const subject = String(t.trigger?.subject || '').slice(0, 80)
  const text = `「${t.activity_name}」 결과로 냈어요${subject ? ` — ${subject}` : ''}. 파일: ${ups.map((f) => f.name).join(', ')}. 지도가 다음 단계를 정해요.`
  const message = threadId ? await addMessage(me.id, threadId, 'agent', 'text', { text, stepFiles: { todoId: String(t.id), caseId: t.case_id, task: t.activity_name } }) : null
  emit(me.id, 'process', { instId: t.proc_inst_id, type: 'submitted' })
  console.log(`[step-files] 「${t.activity_name}」: ${me.email || me.id} 채팅으로 파일 ${ups.length}개를 냈어요`)
  return { ok: true, todoId: String(t.id), task: t.activity_name, caseId: t.case_id, message, text }
}

// the ask card's answer (POST /ontology/step-files): a step chosen, or 「새 요청으로」 — the file goes on as a file event (offered, never started)
export async function answerAsk(me, messageId, { todoId = '', none = false } = {}) {
  const [m] = await q(`select m.*, t.user_id from pro_messages m join pro_threads t on t.id = m.thread_id where m.id::text = $1 and m.kind = 'step-file-ask'`, [String(messageId)])
  if (!m || String(m.user_id) !== String(me.id)) throw err(404, '그 물음을 찾지 못했어요.')
  if (m.content?.state !== 'asking') throw err(409, '이미 답한 물음이에요.')
  if (none) {
    await updateMessage(me.id, m.id, { state: 'new' })
    const { onFile } = await import('./events.js')
    await onFile({ user: me, threadId: m.thread_id, files: m.content.files || [], said: m.content.said || '' }).catch((e) => console.warn('[step-files] file event', e.message))
    return { ok: true, state: 'new' }
  }
  if (!(m.content.options || []).some((o) => o.todoId === String(todoId))) throw err(400, '물음에 없던 단계예요.')
  const r = await submitFiles({ me, todoId, files: m.content.files, said: m.content.said, threadId: m.thread_id, messageId: m.id })
  return { ok: true, state: 'submitted', todoId: r.todoId, task: r.task }
}
