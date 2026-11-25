// What the live editor's edit tools did for a person (mcp/office.js passes every office_live_* call through, so it sees each
// result): an edit counts as done only when IeumOffice says it changed something — and, for a format edit, when the document
// shows what was asked. Production 2026-11-25:
//   - 06:57 the agent answered 「표 안 글씨의 세로 정렬을 중앙으로 맞췄습니다」 and the document had not changed — the editor had
//     reported the batch as valid with nothing changed, and the agent took that for done;
//   - 12:57 「@표 1 · 1~3행 1~4열 … 중앙정렬」: the editor reported 「setTableCellFormat: 10」, the review said 「편집기 확인 … ✓」,
//     and the labels still sat at the top of their cells (each label paragraph's space after filled its cell, so centring had
//     no room to move). An op count is not the document.
// Now
//   - a call that changed nothing goes back to the agent as an error that says so (it may try the right target, or say it
//     could not);
//   - a 워드 call's result carries what the document shows after it (office-host page-live.mjs formatFacts → `check`): every
//     format the batch asked for is compared with it — the cell's or paragraph's own value, and what is laid out (a cell's
//     background, a paragraph's alignment, where a cell's text sits for its vertical alignment). One that is not there makes
//     the call not applied: the agent gets an error naming the cells and what the document shows, and the turn does not end
//     on 「✓」;
//   - a turn whose edit calls all failed, changed nothing or did not show ends with that said plainly instead of the agent's
//     words (lib/agent.js delegate), and its review counts only edits the document confirmed (lib/review.js).
// Deterministic: IeumOffice's own report (isError, ok:false, mutated:false) and the document's own facts, never what the
// answer's words say.
import { L } from './lang.js'

const EDIT = /^office_live_(write|replace|apply_ops|hwp_table|hwp_text)$/
const textOf = (result) => (result?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
const opsOf = (args) => {
  const ops = args?.ops
  if (Array.isArray(ops)) return ops
  try { const v = JSON.parse(String(ops || '')); return Array.isArray(v) ? v : [] } catch { return [] }
}

/** null for a tool that does not edit; else { applied, summary?, why?, nothing?, verified?, unmet? } from the editor's own
 *  answer and, when it carries one, what the document shows (`check`) */
export function editOutcome(name, args, result) {
  if (!EDIT.test(String(name || ''))) return null
  // (the 한글 table tool also reads)
  if (/^office_live_hwp_/.test(name) && args?.action === 'read') return null
  const text = textOf(result)
  if (result?.isError) return { applied: false, why: text.slice(0, 300) || 'error' }
  let j = null
  try { j = JSON.parse(text) } catch { /* plain text: taken as done */ }
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    if (j.ok === false) return { applied: false, why: String(j.error || j.summary || '').slice(0, 300) }
    if (j.mutated === false) return { applied: false, nothing: true, why: String(j.summary || j.output || '').slice(0, 300) }
    // (office-host moved the spacing of the cells it aligned so their text sits where asked — page-live.mjs planCellAlign)
    const moved = Number(j.aligned?.cells) > 0 ? L(` · 칸 ${j.aligned.cells}개의 글 자리 맞춤`, ` · text placed in ${j.aligned.cells} cell${j.aligned.cells === 1 ? '' : 's'}`) : ''
    const summary = `${String(j.summary || '').slice(0, 300)}${moved}`
    if (Array.isArray(j.check)) {
      const { checked, unmet } = formatUnmet(opsOf(args), j.check)
      if (unmet.length) return { applied: false, unmet, summary, why: unmetText(unmet).slice(0, 400) }
      return { applied: true, summary, verified: checked > 0, checked }
    }
    return { applied: true, summary }
  }
  return { applied: true, summary: text.slice(0, 300) }
}

// ---- a format asked for vs. what the document shows (office-host page-live.mjs formatFacts)
const hex = (v) => (v == null || v === '' ? null : String(v).replace(/^#/, '').toUpperCase())
const near = (a, b) => (a == null && b == null) || (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= 1)
// where a cell's text may sit and still be where it was asked: a few pixels, or a third of its lines' height (a font's own
// ascent and descent are not the same, so even a centred line is not exactly midway)
const slack = (s) => Math.max(4, 0.3 * (Number(s.lines) || 0))
const SHOWN_ALIGN = { left: ['left', 'start'], right: ['right', 'end'], center: ['center'], justify: ['justify'] }
const CELL_KEYS = ['vAlign', 'fill', 'borders']
const PARA_KEYS = ['align', 'lineSpacing', 'indentLeft', 'indentRight', 'indentFirstLine', 'spaceBefore', 'spaceAfter', 'shadingFill']
const SIDES = ['top', 'left', 'bottom', 'right']

/** a cell's border side as asked (null = none) vs. as the cell has it → true when it is there */
function borderMet(want, got) {
  const none = !got || got.style === 'none' || got.style === 'nil'
  if (want === null) return none
  if (none) return false
  if (want.style && want.style !== 'none' && got.style !== want.style) return false
  if (want.style === 'none') return none
  if (want.color && hex(want.color) !== hex(got.color)) return false
  return true
}

/** one cell's facts against one asked property → null when met, else what the document shows */
function cellMiss(key, op, cell) {
  const shown = cell.shown || {}
  if (key === 'vAlign') {
    const want = op.vAlign || 'top'
    if ((cell.vAlign || 'top') !== want) return { got: cell.vAlign || 'top' }
    if (typeof shown.above !== 'number' || typeof shown.below !== 'number') return null
    const off = want === 'center' ? Math.abs(shown.above - shown.below) : want === 'bottom' ? shown.below : shown.above
    return off <= slack(shown) ? null : { above: shown.above, below: shown.below, shown: true }
  }
  if (key === 'fill') {
    const want = hex(op.fill)
    if (hex(cell.fill) !== want) return { got: hex(cell.fill) }
    if (want && shown.background !== undefined && hex(shown.background) !== want) return { got: hex(shown.background), shown: true }
    return null
  }
  if (key === 'borders') {
    const b = cell.borders || {}
    if (op.borders === null) return SIDES.every((s) => borderMet(null, b[s])) ? null : { got: 'borders' }
    const spec = op.borders || {}
    for (const side of SIDES) {
      const want = spec[side] !== undefined ? spec[side] : spec.all
      if (want !== undefined && !borderMet(want, b[side])) return { side, got: b[side]?.style || null }
    }
    return null
  }
  return null
}

/** one paragraph's facts against one asked field → null when met, else what the document shows */
function paragraphMiss(key, op, p) {
  const want = op[key] ?? null
  const got = p.attrs?.[key] ?? null
  const same = key === 'shadingFill' ? hex(got) === hex(want) : typeof want === 'number' || typeof got === 'number' ? near(got, want) : got === want
  if (!same) return { got }
  if (key === 'align' && want && p.shown?.textAlign && !(SHOWN_ALIGN[want] || [want]).includes(p.shown.textAlign)) return { got: p.shown.textAlign, shown: true }
  return null
}

/** The formats a batch asked for that the document does not show. ops: the batch as sent, check: the result's facts.
 *  → { checked (properties compared), unmet: [{ op, name, key, want, table?, cells | paragraphs: n, of, first: {...}, got }] } */
export function formatUnmet(ops, check) {
  let checked = 0
  const unmet = []
  for (const fact of check || []) {
    const op = ops[fact?.op]
    if (!op || op.op !== fact.name) continue
    if (fact.name === 'setTableCellFormat') {
      const cells = fact.cells || []
      for (const key of CELL_KEYS.filter((k) => op[k] !== undefined)) {
        checked++
        if (!cells.length) { unmet.push({ op: fact.op, name: fact.name, key, want: op[key] ?? null, cells: 0, of: 0, none: true }); continue }
        const misses = cells.map((c) => [c, cellMiss(key, op, c)]).filter(([, m]) => m)
        if (misses.length) {
          const [c, m] = misses[0]
          unmet.push({ op: fact.op, name: fact.name, key, want: op[key] ?? (key === 'vAlign' ? 'top' : null), table: fact.table, cells: misses.length, of: cells.length,
            first: { row: c.row, col: c.col, text: c.text || '' }, ...m })
        }
      }
    } else if (fact.name === 'setParagraphFormat') {
      const ps = fact.paragraphs || []
      for (const key of PARA_KEYS.filter((k) => op[k] !== undefined)) {
        checked++
        if (!ps.length) { unmet.push({ op: fact.op, name: fact.name, key, want: op[key] ?? null, paragraphs: 0, of: 0, none: true }); continue }
        const misses = ps.map((p) => [p, paragraphMiss(key, op, p)]).filter(([, m]) => m)
        if (misses.length) {
          const [p, m] = misses[0]
          unmet.push({ op: fact.op, name: fact.name, key, want: op[key] ?? null, paragraphs: misses.length, of: ps.length, first: { text: p.text || '' }, ...m })
        }
      }
    }
  }
  return { checked, unmet }
}

const KEY_NAME = {
  vAlign: ['세로 정렬', 'vertical alignment'], fill: ['칸 색', 'cell colour'], borders: ['테두리', 'borders'], align: ['가로 정렬', 'alignment'],
  lineSpacing: ['줄 간격', 'line spacing'], spaceBefore: ['문단 위 간격', 'space before'], spaceAfter: ['문단 아래 간격', 'space after'],
  indentLeft: ['왼쪽 들여쓰기', 'left indent'], indentRight: ['오른쪽 들여쓰기', 'right indent'], indentFirstLine: ['첫 줄 들여쓰기', 'first-line indent'], shadingFill: ['문단 배경', 'paragraph shading'],
}
const V_NAME = { top: ['위', 'top'], center: ['가운데', 'centre'], bottom: ['아래', 'bottom'] }

/** one unmet format, in words: where, what was asked, what the document shows */
function unmetLine(u) {
  const [ko, en] = KEY_NAME[u.key] || [u.key, u.key]
  if (u.none) return L(`${ko}: 대상(${u.name === 'setTableCellFormat' ? '표' : '문단'})을 문서에서 찾지 못했어요`, `${en}: no matching ${u.name === 'setTableCellFormat' ? 'table' : 'paragraph'} in the document`)
  const where = u.cells != null
    ? L(`표 ${u.table ?? '?'} · ${u.first.row + 1}행 ${u.first.col + 1}열${u.first.text ? ` 「${u.first.text}」` : ''}${u.cells > 1 ? ` 등 ${u.cells}칸` : ''}`,
      `table ${u.table ?? '?'}, row ${u.first.row + 1} col ${u.first.col + 1}${u.first.text ? ` “${u.first.text}”` : ''}${u.cells > 1 ? ` and ${u.cells - 1} more cell${u.cells > 2 ? 's' : ''}` : ''}`)
    : L(`문단${u.first.text ? ` 「${u.first.text}」` : ''}${u.paragraphs > 1 ? ` 등 ${u.paragraphs}개` : ''}`, `paragraph${u.first.text ? ` “${u.first.text}”` : ''}${u.paragraphs > 1 ? ` and ${u.paragraphs - 1} more` : ''}`)
  if (u.key === 'vAlign' && u.shown) {
    const [vk, ve] = V_NAME[u.want] || [u.want, u.want]
    return L(`${where}: 세로 ${vk} 정렬이 문서에 보이지 않아요(글 위 ${Math.round(u.above)}px · 아래 ${Math.round(u.below)}px — 칸 안의 빈 문단이나 문단 간격이 칸을 채우고 있는지 보세요)`,
      `${where}: the ${ve} vertical alignment does not show in the document (${Math.round(u.above)}px above the text, ${Math.round(u.below)}px below — check for empty paragraphs or paragraph spacing filling the cell)`)
  }
  const want = u.want === null ? L('없음', 'none') : typeof u.want === 'object' ? JSON.stringify(u.want) : String(u.want)
  const got = u.got == null ? L('없음', 'none') : String(u.got)
  return u.shown
    ? L(`${where}: ${ko}이(가) ${want} 로 정해졌지만 화면에는 ${got}`, `${where}: ${en} is set to ${want} but shows as ${got}`)
    : L(`${where}: ${ko}이(가) ${want} 가 아니에요(지금 ${got})`, `${where}: ${en} is not ${want} (now ${got})`)
}
const unmetText = (unmet) => unmet.slice(0, 3).map(unmetLine).join(' · ')

/** what the agent gets back for an edit that changed nothing, or whose format the document does not show: an error that says
 *  so, with the editor's (or the document's) own words */
export function notAppliedResult(outcome) {
  if (outcome.unmet?.length) {
    return { isError: true, content: [{ type: 'text', text: L(
      `편집기는 이 편집을 받아들였지만 요청한 서식이 문서에 나타나지 않았어요 — ${outcome.why}. office_live_read 로 그 칸·문단의 지금 내용을 확인해 원인을 고쳐 다시 보내거나, 고치지 못했다고 그대로 알리세요. 했다고 답하지 마세요.`,
      `The editor accepted this edit, but the format asked for does not show in the document — ${outcome.why}. Check that cell or paragraph with office_live_read, fix the cause and send it again, or say plainly that you could not make the change. Do not say it was done.`) }] }
  }
  const said = outcome.why ? L(` 편집기의 답: ${outcome.why}`, ` The editor said: ${outcome.why}`) : ''
  return { isError: true, content: [{ type: 'text', text: L(
    `이 편집은 문서에 적용되지 않았어요 — 바뀐 곳이 없어요.${said} 대상(target·range·블록 번호)이 맞는지 office_live_read 로 다시 확인하고 고쳐 보내거나, 고치지 못했다고 그대로 알리세요. 했다고 답하지 마세요.`,
    `This edit was not applied to the document — nothing changed.${said} Check the target (target, range, block index) with office_live_read and send it again, or say plainly that you could not make the change. Do not say it was done.`) }] }
}

/** an applied edit's result as the agent reads it: the document's facts (`check`, long) become one line that says they were checked */
export function forAgent(result, outcome) {
  if (!outcome?.applied || !outcome.verified) return result
  const text = textOf(result)
  let j
  try { j = JSON.parse(text) } catch { return result }
  if (!j || !Array.isArray(j.check)) return result
  const { check, ...rest } = j
  return { ...result, content: [{ type: 'text', text: JSON.stringify({ ...rest, verified: L(`문서에서 확인함(서식 ${outcome.checked}건)`, `confirmed in the document (${outcome.checked} format${outcome.checked === 1 ? '' : 's'})`) }) }] }
}

// ---- per person: the edit calls since a turn began
const calls = new Map() // userId → [{ at, tool, applied, summary, why, verified, unmet }]
export function recordEdit(userId, tool, outcome) {
  if (!userId || !outcome) return
  const list = calls.get(userId) || []
  list.push({ at: Date.now(), tool, ...outcome })
  calls.set(userId, list.slice(-50))
}
/** the edit calls of this person since `since` (a turn's start) */
export function editsSince(userId, since) {
  return (calls.get(userId) || []).filter((c) => c.at >= since)
}

/** a turn's edits → 'applied' (at least one changed the document as asked), 'none' (some were made, none did), or null (no edit made) */
export function editVerdict(edits) {
  if (!edits?.length) return null
  return edits.some((e) => e.applied) ? 'applied' : 'none'
}

/** the answer a turn ends with when its edits did not take: said plainly, with the editor's (or the document's) reason */
export function notAppliedAnswer(edits, file) {
  const last = [...edits].reverse().find((e) => e.why) || {}
  const short = String(last.why || '').replace(/\s+/g, ' ').trim().slice(0, last.unmet?.length ? 300 : 160)
  if (last.unmet?.length) {
    return L(
      `요청한 수정이 ${file ? `'${file}' ` : ''}문서에 반영되지 않았어요. 편집기는 받아들였지만 문서에서 확인되지 않았어요${short ? ` (${short})` : ''}.`,
      `The change you asked for was not applied to ${file ? `'${file}'` : 'the document'}. The editor accepted it, but the document does not show it${short ? ` (${short})` : ''}.`)
  }
  return L(
    `요청한 수정이 ${file ? `'${file}' ` : ''}문서에 반영되지 않았어요. 편집기가 바뀐 곳이 없다고 알려 왔어요${short ? ` (${short})` : ''}. 고칠 부분을 문서에서 다시 골라 보내 주세요.`,
    `The change you asked for was not applied to ${file ? `'${file}'` : 'the document'}. The editor reported that nothing changed${short ? ` (${short})` : ''}. Select the part in the document again and send it once more.`)
}
