// 모델이 만든 단계 입력 화면(A2UI v1.0 createSurface 메시지 하나)을 받기 전에 보는 것. 두 겹이다:
//   1. 공식 JSON Schema(a2ui/, draft 2020-12) — 카탈로그 자리(catalog.json)에 Lite 단계 카탈로그를 둔다: 카탈로그에 없는 컴포넌트 ·
//      함수, v0.9 꼴의 바인딩({"path": …}), theme, 모르는 속성은 여기서 걸린다.
//   2. 스키마가 못 보는 것(integrity): root 가 있는지, 없는 id 를 가리키는지, 고리 · 두 부모 · 떨어진 컴포넌트, 크기 · 개수 · 깊이 한도,
//      경로는 /form/<키> 만, 입력마다 키 하나(예약어 아님), 라벨 · 보기는 글자 그대로, 버튼은 이벤트만, 주소는 http(s) 만.
// 그리고 정리(normalize): 이름 · 판 · 카탈로그는 서버가 정한 것으로 덮고, 데이터 모델은 묶인 키만 각 입력의 꼴에 맞는 첫 값으로 채운다.
// 사람의 글을 뜻으로 거르지 않는다 — 비밀을 묻는 화면인지는 판정 모델이 본다(generate.js).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { CATALOG_ID, COMPONENTS, FUNCTIONS, INPUTS, RESERVED } from './catalogInfo.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'))
export const CATALOG = read('catalog.json')

export const DEFAULT_LIMITS = { maxComponents: 40, maxInputs: 10, maxButtons: 3, maxDepth: 8, maxBytes: 24000, maxStringChars: 2000, maxOptions: 30 }

let compiled = null
function schemas() {
  if (compiled) return compiled
  const Ajv2020 = require('ajv/dist/2020.js')
  const addFormats = require('ajv-formats')
  const ajv = new (Ajv2020.default || Ajv2020)({ strict: false, allErrors: true })
  ;(addFormats.default || addFormats)(ajv)
  ajv.addSchema(read('a2ui/common_types.json'))
  // the envelope refers to catalog.json next to it: Lite's step catalog stands there (the official test runner aliases the same way)
  ajv.addSchema({ ...CATALOG, $id: 'https://a2ui.org/specification/v1_0/catalog.json' })
  ajv.addSchema(read('a2ui/agent_to_renderer.json'))
  ajv.addSchema(read('a2ui/renderer_to_agent.json'))
  // one component on its own (the envelope's oneOf over every component says little about which part of which one is wrong)
  const one = new Map(COMPONENTS.map((n) => [n, ajv.compile({ allOf: [{ $ref: 'https://a2ui.org/specification/v1_0/common_types.json#/$defs/ComponentCommon' },
    { $ref: `https://a2ui.org/specification/v1_0/catalog.json#/components/${n}` }], unevaluatedProperties: false })]))
  compiled = {
    toRenderer: ajv.getSchema('https://a2ui.org/specification/v1_0/agent_to_renderer.json'),
    toAgent: ajv.getSchema('https://a2ui.org/specification/v1_0/renderer_to_agent.json'),
    one,
  }
  return compiled
}
const ajvErrors = (fn) => (fn.errors || []).slice(0, 6).map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : e.params?.unevaluatedProperty ? ` (${e.params.unevaluatedProperty})` : ''}`)

export const ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
export const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/
const FORM_PATH_RE = /^\/form\/([A-Za-z][A-Za-z0-9_]{0,47})$/
const EVENT_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
// a string that is a URL with a scheme: only http(s) may stand anywhere in a screen (this catalog has no URL property at all — media,
// links and openUrl are left out — so any other scheme is a sign of a screen that should not be shown)
const SCHEME_RE = /^\s*([A-Za-z][A-Za-z0-9+.-]*):(\/\/)?/
const BAD_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'filesystem', 'about', 'chrome', 'intent'])
function urlProblem(s) {
  const m = SCHEME_RE.exec(s)
  if (!m) return null
  const scheme = m[1].toLowerCase()
  if (BAD_SCHEMES.has(scheme)) return `a ${scheme}: address`
  if (m[2] && scheme !== 'http' && scheme !== 'https') return `a ${scheme}:// address`
  return null
}

// every value in a JSON tree, with its path (for the walks below)
function* walk(x, at = '') {
  yield [x, at]
  if (Array.isArray(x)) for (let i = 0; i < x.length; i++) yield* walk(x[i], `${at}/${i}`)
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) yield* walk(v, `${at}/${k}`)
}
const literal = (v) => typeof v === 'string'

// the ids a component points at (this catalog: Card · Button child, Row · Column children)
export function childIds(c) {
  if (typeof c.child === 'string') return [c.child]
  if (Array.isArray(c.children)) return c.children
  return []
}

// The server's own fields over whatever the model wrote, and the data model as the bound inputs need it. → a new message
export function normalize(msg, { surfaceId }) {
  const cs = msg?.createSurface && typeof msg.createSurface === 'object' ? msg.createSurface : msg && typeof msg === 'object' && Array.isArray(msg.components) ? msg : {}
  const out = { version: '1.0', createSurface: { ...cs, surfaceId, catalogId: CATALOG_ID, sendDataModel: true } }
  const comps = Array.isArray(cs.components) ? cs.components : []
  const form = cs.dataModel?.form && typeof cs.dataModel.form === 'object' && !Array.isArray(cs.dataModel.form) ? cs.dataModel.form : {}
  const fixed = {}
  for (const c of comps) {
    const key = INPUTS[c?.component] ? FORM_PATH_RE.exec(c?.value?.['@path'] || '')?.[1] : null
    if (!key || key in fixed) continue
    fixed[key] = firstValue(c, form[key])
  }
  out.createSurface.dataModel = { form: fixed }
  return out
}
// an input's starting value: what the model put there when it has the input's type, else the empty value
function firstValue(c, v) {
  switch (INPUTS[c.component]) {
    case 'boolean': return typeof v === 'boolean' ? v : false
    case 'number': {
      const min = Number.isFinite(c.min) ? c.min : 0
      return typeof v === 'number' && Number.isFinite(v) ? v : min
    }
    case 'list': {
      const ok = new Set((c.options || []).map((o) => o?.value))
      const a = Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []
      const picked = [...new Set(a.filter((x) => typeof x === 'string' && ok.has(x)))]
      return c.variant === 'multipleSelection' ? picked : picked.slice(0, 1)
    }
    default: return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
  }
}

// → {ok, errors: [short English lines for the model's second try], inputs, buttons}
export function checkSurface(msg, { surfaceId = null, limits = {} } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits }
  const errors = []
  const bytes = Buffer.byteLength(JSON.stringify(msg ?? null))
  if (bytes > L.maxBytes) return { ok: false, errors: [`the message is ${bytes} bytes; the limit is ${L.maxBytes}`] }
  const S = schemas()
  if (!msg?.createSurface || typeof msg.createSurface !== 'object') return { ok: false, errors: ['expected one createSurface message ({"version": "1.0", "createSurface": {…}})'] }
  if (!S.toRenderer(msg)) {
    // which component is wrong, and how — else what is wrong with the message itself
    const list = Array.isArray(msg.createSurface.components) ? msg.createSurface.components : []
    const each = []
    list.forEach((c, i) => {
      const fn = S.one.get(c?.component)
      if (!fn) each.push(`components/${i} (${String(c?.id || '?').slice(0, 40)}): unknown component ${String(c?.component).slice(0, 40)} — use only ${COMPONENTS.join(', ')}`)
      else if (!fn(c)) each.push(...ajvErrors(fn).map((e) => `components/${i} (${String(c.id).slice(0, 40)}) ${c.component}: ${e}`))
    })
    const top = ajvErrors(S.toRenderer).filter((e) => !e.startsWith('/createSurface/components') && !/must have required property '(updateComponents|updateDataModel|deleteSurface|callFunction|functionResponse)'|must NOT have additional properties \(createSurface\)|must match exactly one schema/.test(e))
    return { ok: false, errors: [...each, ...top].slice(0, 12).map((e) => `schema: ${e}`) }
  }
  const cs = msg.createSurface
  if (surfaceId && cs.surfaceId !== surfaceId) errors.push(`surfaceId must be ${surfaceId}`)
  if (cs.catalogId !== CATALOG_ID) errors.push(`catalogId must be ${CATALOG_ID}`)
  const comps = cs.components || []
  if (!comps.length) return { ok: false, errors: ['no components'] }
  if (comps.length > L.maxComponents) errors.push(`${comps.length} components; at most ${L.maxComponents}`)
  for (const [v, at] of walk(cs)) {
    if (typeof v === 'string') {
      if (v.length > L.maxStringChars) errors.push(`${at}: a string longer than ${L.maxStringChars} characters`)
      if (!at.startsWith('/dataModel/')) { const p = urlProblem(v); if (p) errors.push(`${at}: ${p} is not allowed (only http(s))`) }
    }
  }
  const byId = new Map()
  for (const c of comps) {
    if (!ID_RE.test(c.id)) errors.push(`component id "${String(c.id).slice(0, 40)}" must be letters, digits and _ (a letter or _ first)`)
    if (byId.has(c.id)) errors.push(`component id "${c.id}" is used twice`)
    byId.set(c.id, c)
    if (c['@catalogId'] !== undefined) errors.push(`${c.id}: @catalogId is not allowed (one catalog)`)
    if (!COMPONENTS.includes(c.component)) errors.push(`${c.id}: unknown component ${c.component}`)
  }
  const root = byId.get('root')
  if (!root) errors.push('no component with id "root"')
  else if (!['Card', 'Column'].includes(root.component)) errors.push('root must be a Card or a Column')
  // the tree: every reference resolves, one parent each, no cycle, everything reachable from root, not too deep
  const parent = new Map()
  for (const c of comps) {
    if (c.children && !Array.isArray(c.children)) errors.push(`${c.id}: children must be a list of ids (no templates)`)
    for (const k of childIds(c)) {
      if (!byId.has(k)) errors.push(`${c.id} refers to "${k}", which does not exist`)
      else if (parent.has(k)) errors.push(`"${k}" has two parents (${parent.get(k)} and ${c.id})`)
      else parent.set(k, c.id)
      if (k === c.id) errors.push(`${c.id} contains itself`)
    }
  }
  const order = []
  if (root) {
    const seen = new Set()
    const visit = (id, depth, stack) => {
      if (stack.has(id)) { errors.push(`a cycle through "${id}"`); return }
      if (seen.has(id) || !byId.has(id)) return
      if (depth > L.maxDepth) { errors.push(`nesting deeper than ${L.maxDepth} at "${id}"`); return }
      seen.add(id); order.push(id)
      stack.add(id)
      for (const k of childIds(byId.get(id))) visit(k, depth + 1, stack)
      stack.delete(id)
    }
    visit('root', 1, new Set())
    if (parent.has('root')) errors.push('root cannot be a child')
    for (const c of comps) if (!seen.has(c.id) && !errors.some((e) => e.includes('cycle'))) errors.push(`"${c.id}" is not reachable from root`)
  }
  // bindings: /form/<key> only; formatString placeholders too
  for (const [v, at] of walk(comps)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('@path' in v && !FORM_PATH_RE.test(String(v['@path']))) errors.push(`${at}: path "${String(v['@path']).slice(0, 60)}" must be /form/<key>`)
      if ('@call' in v && !FUNCTIONS.includes(v['@call'])) errors.push(`${at}: unknown function ${v['@call']}`)
      if (v['@call'] === 'formatString' && typeof v.args?.value === 'string') {
        for (const m of v.args.value.matchAll(/\$\{([^}]*)\}/g)) if (!FORM_PATH_RE.test(m[1].trim())) errors.push(`${at}: formatString placeholder \${${m[1].slice(0, 40)}} must be \${/form/<key>}`)
      }
    }
  }
  // inputs: one key each, labels and options written out
  const inputs = [], buttons = []
  const keys = new Set()
  for (const id of order) {
    const c = byId.get(id)
    if (INPUTS[c.component]) {
      const key = FORM_PATH_RE.exec(c.value?.['@path'] || '')?.[1]
      if (!key) { errors.push(`${id}: value must be {"@path": "/form/<key>"}`); continue }
      if (RESERVED.includes(key)) errors.push(`${id}: the key "${key}" is reserved (${RESERVED.join(', ')})`)
      if (keys.has(key)) errors.push(`${id}: the key "${key}" is bound by another input`)
      keys.add(key)
      if (c.label !== undefined && !literal(c.label)) errors.push(`${id}: label must be plain text`)
      if (['TextField', 'CheckBox'].includes(c.component) && !literal(c.label)) errors.push(`${id}: needs a label`)
      if (c.component === 'ChoicePicker') {
        const opts = c.options || []
        if (!opts.length || opts.length > L.maxOptions) errors.push(`${id}: 1 to ${L.maxOptions} options`)
        if (new Set(opts.map((o) => o.value)).size !== opts.length) errors.push(`${id}: option values must differ`)
        if (opts.some((o) => !literal(o.label))) errors.push(`${id}: option labels must be plain text`)
      }
      if (c.component === 'Slider' && !(Number(c.max) > Number(c.min ?? 0))) errors.push(`${id}: max must be above min`)
      if (c.component === 'DateTimeInput' && !c.enableDate && !c.enableTime) errors.push(`${id}: enableDate or enableTime`)
      inputs.push({ id, key, component: c.component })
    }
    if (c.component === 'Button') {
      const ev = c.action?.event
      if (!ev) { errors.push(`${id}: a Button sends an event ({"event": {"name": …}}), not a function call`); continue }
      if (!EVENT_RE.test(ev.name || '')) errors.push(`${id}: event name must be letters, digits and _`)
      if (buttons.some((b) => b.name === ev.name)) errors.push(`${id}: two buttons send "${ev.name}"`)
      const label = byId.get(c.child)
      if (label?.component !== 'Text' || !literal(label.text)) errors.push(`${id}: its child must be a Text with plain words`)
      buttons.push({ id, name: ev.name, variant: c.variant || 'default' })
    }
  }
  // numeric over a text: the renderer reads a number field's text as not a number (@a2ui/web_core 0.16) — the field itself takes numbers
  // only, and the server checks it; numeric is for a Slider
  const kindOfKey = new Map(inputs.map((i) => [i.key, i.component]))
  for (const [v, at] of walk(comps)) {
    if (v?.['@call'] !== 'numeric') continue
    const k = FORM_PATH_RE.exec(v.args?.value?.['@path'] || '')?.[1]
    if (k && kindOfKey.get(k) !== 'Slider') errors.push(`${at}: numeric is for a Slider's value only — a TextField with variant "number" already takes numbers`)
  }
  if (inputs.length > L.maxInputs) errors.push(`${inputs.length} inputs; at most ${L.maxInputs}`)
  if (!buttons.length) errors.push('no Button sends the form')
  if (buttons.length > L.maxButtons) errors.push(`${buttons.length} buttons; at most ${L.maxButtons}`)
  if (buttons.length && buttons.filter((b) => b.variant === 'primary').length !== 1) errors.push('exactly one Button has variant "primary"')
  const dm = cs.dataModel
  if (dm !== undefined) {
    const extra = Object.keys(dm || {}).filter((k) => k !== 'form')
    if (extra.length) errors.push(`dataModel may hold only "form" (found ${extra.slice(0, 3).join(', ')})`)
  }
  return { ok: !errors.length, errors: [...new Set(errors)].slice(0, 12), inputs, buttons }
}

// a renderer → agent message (the action a button sent) as the schema has it
export function checkAction(msg) {
  const S = schemas()
  return S.toAgent(msg) ? { ok: true, errors: [] } : { ok: false, errors: ajvErrors(S.toAgent) }
}
