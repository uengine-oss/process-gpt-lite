// 모델이 단계 입력 화면을 만든다(프로세스 찾기 스킬의 step-ui 프롬프트 + Lite 단계 카탈로그의 지침 · 컴포넌트 목록).
// 어떤 칸이 필요한지는 모델이 정한다(규칙 · 낱말 목록으로 정하지 않는다). 받은 것은 validate.js 로 보고, 걸리면 그 까닭을 붙여 한 번 더
// 묻는다. 그래도 걸리면 null — 부르는 쪽은 지금의 글 한 칸(결과)으로 둔다. 비밀 · 결제 정보를 묻는 화면인지는 판정 모델의 첫 글자 확률로
// 보고(decide.js oddsOf), 그렇다고 읽히면 쓰지 않는다(읽을 수 없으면 구조 검사만으로 — 이 카탈로그엔 비밀번호 칸 · 바깥 주소가 없다).
import { chat } from '../llm.js'
import { config } from '../../config.js'
import { prompt as skillPrompt } from '../ontology/discovery.js'
import { CATALOG, normalize, checkSurface } from './validate.js'
import { inputsOf, buttonsOf, inOrder } from './values.js'

// A short reference of the catalog for the prompt, made from catalog.json itself (it cannot drift from what is validated)
let brief = null
export function catalogBrief() {
  if (brief) return brief
  const kind = (s) => {
    const r = s?.$ref || ''
    if (r.endsWith('DynamicString')) return 'text'
    if (r.endsWith('DynamicBoolean')) return 'bool'
    if (r.endsWith('DynamicNumber')) return 'number'
    if (r.endsWith('DynamicStringList')) return 'list'
    if (r.endsWith('/Child')) return 'id'
    if (r.endsWith('ChildList')) return '[id…]'
    if (r.endsWith('/Action')) return 'action'
    if (r.endsWith('Weight')) return null
    if (s?.enum) return s.enum.join('|')
    if (s?.type === 'array') return 'array'
    return s?.type || 'value'
  }
  const lines = []
  for (const [name, def] of Object.entries(CATALOG.components)) {
    const parts = [def, ...(def.allOf || [])]
    const props = Object.assign({}, ...parts.map((p) => p.properties || {}))
    const req = new Set(parts.flatMap((p) => p.required || []))
    const checks = parts.some((p) => String(p.$ref || '').endsWith('Checkable'))
    const ps = Object.entries(props).filter(([k]) => k !== 'component').map(([k, s]) => [k, kind(s)]).filter(([, t]) => t).map(([k, t]) => `${k}${req.has(k) ? '*' : ''}: ${t}`)
    lines.push(`- ${name}: ${ps.join(', ')}${checks ? ', @checks' : ''}`)
  }
  const fns = Object.entries(CATALOG.functions).map(([n, f]) => `${n}(${Object.keys(f.properties?.args?.properties || {}).join(', ')})`)
  brief = `Components (* = required):\n${lines.join('\n')}\nFunctions: ${fns.join(', ')}`
  return brief
}

export async function systemPrompt() {
  return `${await skillPrompt('step-ui')}\n\n# Catalog ${CATALOG.catalogId}\n\n${CATALOG.instructions}\n\n${catalogBrief()}`
}

// A miscounted bracket (measured: an `and` check closed with one } too few, the same way twice) is mended where the parser stops: a
// } or ] put in, or the character there taken out — whichever lets the parser get further — a few times at most. Only the JSON's
// punctuation is touched; what comes out is checked like any answer (schema, the server's checks).
const POS = /position (\d+)/
export function parseLoose(text, rounds = 4) {
  let s = text
  for (let i = 0; ; i++) {
    try { return JSON.parse(s) } catch (e) {
      const at = Number(POS.exec(e.message)?.[1])
      if (i >= rounds || !Number.isFinite(at)) throw e
      const reach = (t) => { try { JSON.parse(t); return Infinity } catch (x) { return Number(POS.exec(x.message)?.[1]) || -1 } }
      const next = [s.slice(0, at) + '}' + s.slice(at), s.slice(0, at) + ']' + s.slice(at), s.slice(0, at) + s.slice(at + 1)]
        .map((t) => ({ t, r: reach(t) })).sort((a, b) => b.r - a.r)[0]
      if (!(next.r > at)) throw e
      s = next.t
    }
  }
}
// the message in the answer: as it is, or between a code fence or the first { and the last } (a sentence around it)
const parse = (text) => {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  const body = a >= 0 && b > a ? s.slice(a, b + 1) : s
  try { return JSON.parse(body) } catch { return parseLoose(body) }
}

// what the judge reads to tell whether a screen asks for a secret: its words only (labels, options, texts, buttons)
export function screenWords(msg) {
  const out = []
  for (const c of inOrder(msg.createSurface)) {
    for (const k of ['label', 'placeholder', 'text']) if (typeof c[k] === 'string') out.push(c[k])
    for (const o of c.options || []) if (typeof o.label === 'string') out.push(`- ${o.label}`)
  }
  return out.join('\n').slice(0, 3000)
}

// input: {lang, today, step, role, definition, request, earlier, draft} → {msg, tries, ms, model, errors} (msg null: not usable)
export async function makeSurface(input, { surfaceId, R = {}, chatFn = chat, odds = null } = {}) {
  const t0 = Date.now()
  const model = R.model || config.llm.model
  const limits = R.limits || {}
  const system = await systemPrompt()
  const user = JSON.stringify({ ...input, surfaceId })
  const base = [{ role: 'system', content: system }, { role: 'user', content: user }]
  let messages = base
  let errors = [], tries = 0
  const retried = [] // what the earlier tries were refused for (diagnostics: logs, the eval script)
  let lastRaw = '' // the last refused answer's start (the eval script; not stored)
  let fresh = false // this try asks afresh after an answer that was not one JSON message
  const maxTries = 1 + Math.max(0, Number(R.retries ?? 1))
  while (tries < maxTries) {
    tries++
    let msg = null, raw = '', unreadable = false
    lastRaw = ''
    try {
      // (no JSON mode by default: a gateway's guided JSON decoding can run on in whitespace until the token limit — measured on
      // frentis-ai-model; the prompt asks for JSON only and the answer is parsed here)
      // (asked again after an answer that was not JSON: a little warmer — at 0.2 the same broken answer came back word for word)
      const m = await chatFn({ messages, json: R.jsonMode === true, temperature: fresh ? (R.retryTemperature ?? 0.6) : 0.2, timeoutMs: R.timeoutMs || 45000, model, maxTokens: R.maxTokens || 6000,
        ...(R.effort ? { effort: R.effort } : {}), ...(R.think === false ? { think: false } : {}) })
      raw = String(m.content || '')
      if (m.finish === 'length') throw new Error(`the answer was cut off at the token limit (${raw.length} characters)`)
      msg = normalize(parse(raw), { surfaceId })
    } catch (e) {
      unreadable = true
      errors = [`not a JSON message: ${e.message.slice(0, 160)}`]
      // a timeout or a gateway error is not fixed by asking again in the same breath
      if (/abort|timeout|LLM \d{3}/i.test(e.message)) break
    }
    if (msg) {
      const r = checkSurface(msg, { surfaceId, limits })
      if (r.ok) {
        if (odds && R.secretCheck !== false) {
          const words = screenWords(msg)
          const d = await odds(`입력 화면의 글:\n${words}`, '이 화면이 사람에게 비밀번호 · 인증 코드 · API 키 · 카드 번호 같은 비밀이나 결제 정보를 입력하라고 하나?',
            [{ key: 'no', label: '아니요 — 업무 내용만 묻는다' }, { key: 'yes', label: '예 — 비밀이나 결제 정보를 묻는다' }]).catch(() => null)
          if (d?.probabilities?.yes >= (R.secretMax ?? 0.5)) return { msg: null, tries, ms: Date.now() - t0, model, errors: [`the screen asks for a secret or payment data (${Math.round(d.probabilities.yes * 100)}%)`], retried, refused: true }
        }
        return { msg, tries, ms: Date.now() - t0, model, errors: [], retried, inputs: inputsOf(msg.createSurface).length, buttons: buttonsOf(msg.createSurface).length }
      }
      errors = r.errors
    }
    retried.push(errors)
    lastRaw = raw
    if (tries < maxTries) {
      // an answer that was not one JSON message is not shown back (it may be a cut-off run of nothing): asked afresh, with a word on
      // the form; a screen the checks refused is shown back with what to fix
      fresh = unreadable
      messages = unreadable
        ? [...base, { role: 'user', content: `Your earlier answer was not one complete JSON message (${errors[0].slice(0, 120)}). Answer with ONE compact JSON message only — no text around it, no runs of blank lines or spaces.` }]
        : [...messages, { role: 'assistant', content: raw.slice(0, 20000) || '{}' }, { role: 'user', content: `The host refused that screen:\n- ${errors.join('\n- ')}\nFix these and answer again with the whole corrected message (JSON only).` }]
    }
  }
  return { msg: null, tries, ms: Date.now() - t0, model, errors, retried, lastAnswer: lastRaw.slice(0, 4000) }
}
