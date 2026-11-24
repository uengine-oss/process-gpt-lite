'use strict'
// A CLI session's own records, as the conversation the run card shows (design docs/local-agents/design.md §5.11): the entries of Claude
// Code's session jsonl (<config>/projects/<folder>/<session>.jsonl) and of Codex's rollout (<CODEX_HOME>/sessions/…/rollout-*.jsonl),
// each turned into a few small items — never read off the screen. What they show is what the terminal shows (the same exposure): the
// person's prompts, the agent's words, its tool calls and their results, its thinking. Paths inside the work folder read as the folder's
// own (rel); long texts are clipped so one record never floods the link.
//   { id, t, at, … }
//   user      {text, cmd?}                              a message the CLI took (a prompt, a steer, a slash command)
//   text      {text}                                    what the agent said (markdown)
//   thinking  {text}                                    its thinking (the view folds it)
//   tool      {call, name, input:{path, command, …}}    a tool call
//   result    {call, ok, out?, patch?, answers?, kind?} what came back for that call
//   note      {kind, text}                              interrupted · error · local command output
// (the session adds turn · ask · ask-done items from its hooks — session.js)

const TEXT_MAX = 12_000
const OUT_MAX = 4_000
const EDIT_MAX = 8_000
const PATCH_LINES = 400
const clip = (v, n) => { const s = String(v ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s }
const keep = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''))

// the parts of a tool's input the view shows (by the input's own fields; paths made the folder's own)
function inputOf(name, input = {}, rel = (s) => s) {
  const i = input && typeof input === 'object' ? input : {}
  const r = (v) => (v == null ? v : rel(String(v)))
  const out = {
    path: r(i.file_path || i.notebook_path || i.path),
    command: i.command != null ? clip(rel(Array.isArray(i.command) ? i.command.join(' ') : i.command), 2000) : undefined,
    description: i.description ? clip(i.description, 300) : undefined,
    pattern: i.pattern ? clip(i.pattern, 300) : undefined,
    skill: i.skill ? clip(i.skill, 120) : undefined,
    url: i.url ? clip(i.url, 500) : undefined,
    query: i.query ? clip(i.query, 300) : undefined,
    old: i.old_string != null ? clip(i.old_string, EDIT_MAX) : undefined,
    new: i.new_string != null ? clip(i.new_string, EDIT_MAX) : undefined,
    content: i.content != null && typeof i.content === 'string' ? clip(i.content, EDIT_MAX) : undefined,
    edits: Array.isArray(i.edits) ? i.edits.slice(0, 20).map((e) => ({ old: clip(e?.old_string, 2000), new: clip(e?.new_string, 2000) })) : undefined,
    todos: Array.isArray(i.todos) ? i.todos.slice(0, 30).map((t) => keep({ text: clip(t?.content || t?.step || '', 200), state: t?.status || undefined })) : undefined,
    questions: Array.isArray(i.questions) ? i.questions.slice(0, 4).map(questionOf) : undefined,
    prompt: i.prompt && name !== 'Skill' ? clip(i.prompt, 1000) : undefined,
  }
  return keep(out)
}
const questionOf = (q) => keep({ question: clip(q?.question, 500), header: clip(q?.header, 60), multi: q?.multiSelect ? true : undefined,
  options: (Array.isArray(q?.options) ? q.options : []).slice(0, 8).map((o) => keep({ label: clip(o?.label, 120), description: clip(o?.description, 300) })) })

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? b.text || '' : b?.type === 'image' ? '[이미지]' : b?.type === 'tool_reference' ? b.tool_name || '' : '')).filter(Boolean).join('\n') : '')
// a structured patch (Claude Code's toolUseResult.structuredPatch) → [{a, b, lines}]
function patchOf(sp) {
  if (!Array.isArray(sp) || !sp.length) return undefined
  let n = 0
  const out = []
  for (const h of sp.slice(0, 40)) {
    const lines = (Array.isArray(h?.lines) ? h.lines : []).slice(0, Math.max(0, PATCH_LINES - n)).map((l) => clip(l, 400))
    n += lines.length
    out.push({ a: Number(h?.oldStart) || 0, b: Number(h?.newStart) || 0, lines })
    if (n >= PATCH_LINES) break
  }
  return out
}
// Codex's apply_patch text → its files and +/- lines
function codexPatch(text = '') {
  const files = []
  let cur = null
  for (const l of String(text).split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(l)
    if (m) { cur = { op: m[1].toLowerCase(), path: m[2].trim(), lines: [] }; files.push(cur); continue }
    if (!cur || /^\*\*\* (Begin|End) Patch/.test(l) || /^\*\*\* Move to:/.test(l)) continue
    if (l.startsWith('@@')) { cur.lines.push(l); continue }
    if (/^[+\- ]/.test(l) && cur.lines.length < PATCH_LINES) cur.lines.push(clip(l, 400))
  }
  return files
}

// ---------- Claude Code: one jsonl entry → items ----------
// (only the conversation's own entries; the many bookkeeping ones — api-request, mode, file-history-snapshot, attachments other than a
// queued message, system — and a subagent's sidechain are not part of it)
function fromClaude(e, { rel = (s) => s } = {}) {
  if (!e || typeof e !== 'object' || e.isSidechain) return []
  const at = e.timestamp || new Date().toISOString()
  const base = String(e.uuid || e.promptId || `${at}-${Math.random().toString(36).slice(2, 8)}`)
  const content = e.message?.content
  const out = []
  if (e.type === 'user') {
    if (e.isMeta) return []
    const tur = e.toolUseResult
    if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) {
      for (const [i, b] of content.entries()) {
        if (b?.type !== 'tool_result') continue
        const res = { id: `${base}:${i}`, t: 'result', at, call: String(b.tool_use_id || ''), ok: !b.is_error }
        const t = tur && typeof tur === 'object' ? tur : null
        if (t?.structuredPatch) res.patch = patchOf(t.structuredPatch)
        if (t?.type === 'create' || t?.type === 'update') res.kind = t.type
        if (t && 'stdout' in t) res.out = clip(rel([t.stdout, t.stderr].filter(Boolean).join('\n')), OUT_MAX)
        else if (t?.file && typeof t.file === 'object') res.out = `${t.file.numLines ?? ''}`
        else if (t?.answers && typeof t.answers === 'object') res.answers = Object.fromEntries(Object.entries(t.answers).slice(0, 8).map(([k, v]) => [clip(k, 300), clip(v, 300)]))
        else res.out = clip(rel(textOf(b.content)), OUT_MAX)
        out.push(keep(res))
      }
      return out
    }
    const text = textOf(content)
    if (!text.trim()) return []
    // (written by the CLI itself, not by a person: the turn was stopped — Esc, or a tool use refused)
    if (e.rowSource === 'harness' || /^\[Request interrupted by user/.test(text)) return [{ id: base, t: 'note', at, kind: 'interrupted', text: clip(text, 300) }]
    const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text)
    if (cmd) { const args = /<command-args>([^<]*)<\/command-args>/.exec(text); return [{ id: base, t: 'user', at, text: clip(`${cmd[1]}${args?.[1] ? ` ${args[1]}` : ''}`, 500), cmd: true }] }
    const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)
    if (stdout) return stdout[1].trim() ? [{ id: base, t: 'note', at, kind: 'command', text: clip(stdout[1].trim(), OUT_MAX) }] : []
    return [{ id: base, t: 'user', at, text: clip(text, TEXT_MAX) }]
  }
  if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
    const p = e.attachment.prompt
    const text = typeof p === 'string' ? p : textOf(p)
    return text.trim() ? [{ id: base, t: 'user', at, text: clip(text, TEXT_MAX) }] : []
  }
  if (e.type === 'assistant' && Array.isArray(content)) {
    for (const [i, b] of content.entries()) {
      const id = `${base}:${i}`
      if (b?.type === 'text' && b.text?.trim()) out.push({ id, t: 'text', at, text: clip(b.text.trim(), TEXT_MAX) })
      else if (b?.type === 'thinking' && b.thinking?.trim()) out.push({ id, t: 'thinking', at, text: clip(b.thinking.trim(), TEXT_MAX) })
      else if (b?.type === 'tool_use') out.push({ id, t: 'tool', at, call: String(b.id || id), name: String(b.name || 'tool').slice(0, 80), input: inputOf(b.name, b.input, rel) })
    }
    return out
  }
  return []
}

// ---------- Codex: one rollout entry → items ----------
// (the person's and the agent's words from its event messages; its tool calls and their outputs from its response items — a response
// item's message repeats an event message, so it is skipped)
function parseArgs(v) { if (v && typeof v === 'object') return v; try { return JSON.parse(String(v || '{}')) } catch { return { input: String(v || '') } } }
function shellCommand(a) {
  const c = a.command ?? a.cmd
  if (Array.isArray(c)) return c[0] === 'bash' && c[1] === '-lc' ? c.slice(2).join(' ') : c.join(' ')
  return c == null ? '' : String(c)
}
function codexOutput(raw) {
  const s = String(raw ?? '')
  try { const o = JSON.parse(s); if (o && typeof o === 'object' && 'output' in o) return { out: String(o.output ?? ''), ok: o.metadata?.exit_code == null ? true : o.metadata.exit_code === 0 } } catch { /* plain */ }
  const m = /Process exited with code (\d+)/.exec(s)
  return { out: s, ok: m ? m[1] === '0' : true }
}
function fromCodex(e, { rel = (s) => s } = {}) {
  const p = e?.payload
  if (!p || typeof p !== 'object') return []
  const at = e.timestamp || new Date().toISOString()
  const id = `${at}-${p.call_id || p.type || ''}-${Math.random().toString(36).slice(2, 7)}`
  if (e.type === 'event_msg') {
    if (p.type === 'user_message' && String(p.message || '').trim()) return [{ id, t: 'user', at, text: clip(p.message, TEXT_MAX) }]
    if (p.type === 'agent_message' && String(p.message || '').trim()) return [{ id, t: 'text', at, text: clip(p.message, TEXT_MAX) }]
    if (p.type === 'agent_reasoning' && String(p.text || '').trim()) return [{ id, t: 'thinking', at, text: clip(p.text, TEXT_MAX) }]
    if (p.type === 'turn_aborted') return [{ id, t: 'note', at, kind: 'interrupted', text: clip(p.reason || 'interrupted', 300) }]
    if ((p.type === 'error' || p.type === 'stream_error') && p.message) return [{ id, t: 'note', at, kind: 'error', text: clip(p.message, 600) }]
    return []
  }
  if (e.type !== 'response_item') return []
  if (p.type === 'function_call' || p.type === 'local_shell_call') {
    const a = p.type === 'local_shell_call' ? (p.action || {}) : parseArgs(p.arguments)
    const name = String(p.name || (p.type === 'local_shell_call' ? 'shell' : 'tool')).slice(0, 80)
    const call = String(p.call_id || p.id || id)
    if (name === 'apply_patch') return [codexPatchItem(id, at, call, a.input || '', rel)]
    if (name === 'update_plan') return [{ id, t: 'tool', at, call, name, input: inputOf(name, { todos: (a.plan || []).map((x) => ({ content: x.step, status: x.status })) }) }]
    const command = shellCommand(a)
    return [{ id, t: 'tool', at, call, name, input: command ? keep({ command: clip(rel(command), 2000), description: a.justification ? clip(a.justification, 300) : undefined }) : inputOf(name, a, rel) }]
  }
  if (p.type === 'custom_tool_call') {
    const call = String(p.call_id || p.id || id)
    if (p.name === 'apply_patch') return [codexPatchItem(id, at, call, p.input || '', rel)]
    return [{ id, t: 'tool', at, call, name: String(p.name || 'tool').slice(0, 80), input: keep({ content: clip(p.input, EDIT_MAX) }) }]
  }
  if (p.type === 'web_search_call') return [{ id, t: 'tool', at, call: String(p.id || id), name: 'web_search', input: keep({ query: clip(p.action?.query || '', 300) }) }]
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    const o = codexOutput(typeof p.output === 'object' && p.output ? p.output.content ?? JSON.stringify(p.output) : p.output)
    return [{ id, t: 'result', at, call: String(p.call_id || ''), ok: o.ok, out: clip(rel(o.out), OUT_MAX) }]
  }
  return []
}
function codexPatchItem(id, at, call, text, rel) {
  const files = codexPatch(text)
  const f = files[0]
  return { id, t: 'tool', at, call, name: 'apply_patch', input: keep({ path: f ? rel(f.path) : undefined, op: f?.op, files: files.length > 1 ? files.slice(0, 10).map((x) => rel(x.path)) : undefined }),
    ...(f ? { patch: [{ a: 0, b: 0, lines: files.flatMap((x) => (files.length > 1 ? [`@@ ${rel(x.path)}`, ...x.lines] : x.lines)).slice(0, PATCH_LINES) }] } : {}) }
}

module.exports = { fromClaude, fromCodex, inputOf, patchOf, codexPatch, clip, LIMITS: { TEXT_MAX, OUT_MAX, EDIT_MAX, PATCH_LINES } }
