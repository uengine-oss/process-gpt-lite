// 사람이 단계 입력 화면에서 낸 것을 서버가 다시 본다 — 화면(브라우저)의 검사는 편의일 뿐이다. 기준은 저장해 둔 화면(createSurface):
//   - 누른 버튼: 그 화면에 있는 버튼의 이벤트여야 한다(surfaceId · sourceComponentId 도 맞아야).
//   - 값: 화면이 묶은 키(/form/<key>)만 읽는다(다른 키는 버린다). 입력마다 꼴(글 · 참거짓 · 보기 목록 · 날짜 · 숫자)과 보기에 있는 값인지,
//     글 길이 한도, 그리고 화면에 적힌 검사(@checks — required · length · numeric · email · and · or · not)를 기본 카탈로그와 같은 뜻으로 다시 셈한다.
// 그리고 다음 단계들이 읽는 글(result)을 라벨과 값으로 만든다 — 값을 늘어놓을 뿐 뜻을 읽지 않는다.
import { INPUTS } from './catalogInfo.js'
import { childIds } from './validate.js'

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })
export const DEFAULT_VALUE_LIMITS = { maxValueChars: 8000 }

const byIdOf = (cs) => new Map((cs.components || []).map((c) => [c.id, c]))
// the components in the order the screen shows them (root first, depth first)
export function inOrder(cs) {
  const byId = byIdOf(cs)
  const out = [], seen = new Set()
  const visit = (id) => {
    const c = byId.get(id)
    if (!c || seen.has(id)) return
    seen.add(id); out.push(c)
    for (const k of childIds(c)) visit(k)
  }
  visit('root')
  return out
}
const keyOf = (c) => /^\/form\/([A-Za-z][A-Za-z0-9_]*)$/.exec(c?.value?.['@path'] || '')?.[1] || null
export function inputsOf(cs) {
  return inOrder(cs).filter((c) => INPUTS[c.component] && keyOf(c)).map((c) => ({ c, key: keyOf(c) }))
}
export function buttonsOf(cs) {
  const byId = byIdOf(cs)
  return inOrder(cs).filter((c) => c.component === 'Button' && c.action?.event?.name)
    .map((c) => ({ c, id: c.id, name: c.action.event.name, primary: c.variant === 'primary', label: typeof byId.get(c.child)?.text === 'string' ? byId.get(c.child).text : c.action.event.name }))
}

// ---------- the basic catalog's check functions, as @a2ui/web_core 0.16 computes them ----------
const validOf = (v) => (v && typeof v === 'object' && 'valid' in v ? !!v.valid : undefined)
function truthy(v) {
  if (typeof v === 'boolean') return v
  const ok = validOf(v)
  if (ok !== undefined) return ok
  if (typeof v === 'string') return v.toLowerCase() === 'true'
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v)
  return false
}
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const FNS = {
  required: ({ value }) => ({ valid: !(value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) }),
  length: ({ value, min, max }) => {
    const n = typeof value === 'string' || Array.isArray(value) ? value.length : 0
    return { valid: !(min !== undefined && n < min) && !(max !== undefined && n > max) }
  },
  numeric: ({ value, min, max }) => {
    const n = Number(value)
    if (Number.isNaN(n)) return { valid: false }
    return { valid: !(min !== undefined && n < min) && !(max !== undefined && n > max) }
  },
  email: ({ value }) => ({ valid: typeof value === 'string' && EMAIL_RE.test(value) }),
  and: ({ values }) => (values || []).every(truthy),
  or: ({ values }) => (values || []).some(truthy),
  not: ({ value }) => !truthy(value),
}
// a dynamic value: a literal, a binding into the data model, or a call (the check functions above; a formatting call is not a check)
export function evalValue(v, model) {
  if (Array.isArray(v)) return v.map((x) => evalValue(x, model))
  if (v && typeof v === 'object') {
    if ('@path' in v) return String(v['@path']).split('/').slice(1).reduce((o, k) => (o == null ? undefined : o[k]), model)
    if ('@call' in v) {
      const fn = FNS[v['@call']]
      if (!fn) return undefined
      const args = Object.fromEntries(Object.entries(v.args || {}).map(([k, x]) => [k, evalValue(x, model)]))
      return fn(args)
    }
  }
  return v
}
// the failed checks of a component: [message]
export function failedChecks(c, model) {
  return (c['@checks'] || []).filter((r) => !truthy(evalValue(r.condition, model))).map((r) => String(r.message || 'check failed'))
}

// ---------- one input's value ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/
function cleanOne(c, v, L) {
  const label = typeof c.label === 'string' ? c.label : keyOf(c)
  const bad = (why) => { throw err(400, `「${label}」: ${why}`, { field: keyOf(c) }) }
  switch (c.component) {
    case 'CheckBox':
      if (v === undefined || v === null) return false
      if (typeof v !== 'boolean') bad('참 · 거짓이어야 해요')
      return v
    case 'ChoicePicker': {
      const a = v === undefined || v === null ? [] : v
      if (!Array.isArray(a) || a.some((x) => typeof x !== 'string')) bad('보기 목록이어야 해요')
      const ok = new Set((c.options || []).map((o) => o.value))
      if (a.some((x) => !ok.has(x))) bad('없는 보기를 골랐어요')
      if (c.variant !== 'multipleSelection' && a.length > 1) bad('하나만 고를 수 있어요')
      return [...new Set(a)]
    }
    case 'Slider': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
      if (typeof n !== 'number' || !Number.isFinite(n)) bad('숫자여야 해요')
      if (n < (Number.isFinite(c.min) ? c.min : 0) || n > c.max) bad('범위를 벗어났어요')
      return n
    }
    case 'DateTimeInput': {
      const s = v === undefined || v === null ? '' : v
      if (typeof s !== 'string') bad('날짜 · 시각 글이어야 해요')
      if (!s) return ''
      const ok = c.enableDate && c.enableTime ? DATETIME_RE.test(s) || DATE_RE.test(s) : c.enableDate ? DATE_RE.test(s) || DATETIME_RE.test(s) : TIME_RE.test(s)
      if (!ok || (s.includes('-') && Number.isNaN(Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s)))) bad('날짜 · 시각 꼴이 아니에요')
      if (typeof c.min === 'string' && c.min && s < c.min) bad(`${c.min} 이후여야 해요`)
      if (typeof c.max === 'string' && c.max && s > c.max) bad(`${c.max} 이전이어야 해요`)
      return s
    }
    default: { // TextField
      const s = v === undefined || v === null ? '' : typeof v === 'number' && Number.isFinite(v) ? String(v) : v
      if (typeof s !== 'string') bad('글이어야 해요')
      if (s.length > L.maxValueChars) bad(`${L.maxValueChars}자를 넘었어요`)
      if (c.variant === 'number' && s.trim() !== '' && !Number.isFinite(Number(s))) bad('숫자여야 해요')
      return s
    }
  }
}

// What a person handed in, read against the stored screen. body: {values (the data model's /form), action (the A2UI action)}
// → {values: {key: value} (only the screen's keys), button: {id, name, label, primary}} — or throws 400 with the first problem
export function readSubmit(msg, { values, action } = {}, limits = {}) {
  const L = { ...DEFAULT_VALUE_LIMITS, ...limits }
  const cs = msg?.createSurface
  if (!cs) throw err(500, '저장된 화면이 없어요.')
  if (!action || typeof action !== 'object' || typeof action.name !== 'string') throw err(400, '어떤 버튼을 눌렀는지 없어요.')
  if (action.surfaceId && action.surfaceId !== cs.surfaceId) throw err(400, '다른 화면의 버튼이에요.')
  const button = buttonsOf(cs).find((b) => b.name === action.name && (!action.sourceComponentId || action.sourceComponentId === b.id))
  if (!button) throw err(400, '이 화면에 없는 버튼이에요.')
  const given = values && typeof values === 'object' && !Array.isArray(values) ? values : {}
  const form = {}
  for (const { c, key } of inputsOf(cs)) form[key] = cleanOne(c, given[key], L)
  const model = { form }
  // the checks the screen carries: the pressed button's; sending the form (the primary button) also every input's — a second decision
  // (반려 …) needs only its own, as the renderer lets it go with only its own
  const failed = []
  if (button.primary) for (const { c } of inputsOf(cs)) failed.push(...failedChecks(c, model))
  failed.push(...failedChecks(button.c, model))
  if (failed.length) throw err(400, [...new Set(failed)].slice(0, 3).join(' · '), { checks: failed })
  return { values: form, button: { id: button.id, name: button.name, label: button.label, primary: button.primary } }
}

// The text the next steps read (runmode.js earlierOfCase reads `result`): the pressed button when the screen offered more than one,
// then each filled input as 「label: value」 — a long text on the lines below its label. Plain formatting, no reading of meaning.
export function resultText(msg, values, button, lang = 'ko') {
  const cs = msg.createSurface
  const en = lang === 'en'
  const lines = []
  if (buttonsOf(cs).length > 1 && button?.label) lines.push(`${en ? 'Decision' : '결정'}: ${button.label}`)
  for (const { c, key } of inputsOf(cs)) {
    const v = values[key]
    const label = typeof c.label === 'string' && c.label.trim() ? c.label.trim() : key
    let shown
    if (c.component === 'CheckBox') shown = v ? (en ? 'Yes' : '예') : (en ? 'No' : '아니요')
    else if (c.component === 'ChoicePicker') {
      if (!v?.length) continue
      const names = new Map((c.options || []).map((o) => [o.value, typeof o.label === 'string' ? o.label : o.value]))
      shown = v.map((x) => names.get(x) || x).join(', ')
    } else if (v === '' || v === undefined || v === null) continue
    else shown = String(v)
    lines.push(shown.includes('\n') ? `${label}:\n${shown}` : `${label}: ${shown}`)
  }
  return lines.join('\n')
}
