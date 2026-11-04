// 시작품 요청 메일 하나로 초안 일체: 고객이 보낸 PSpice 회로를 돌리고(CircuitCraft), 외함을 모델링하고(SolidCraft),
// 같은 치수로 2D 도면을 그리고(CADCraft), 그 숫자로 제안서와 견적서를 쓴다(에이전트). 사람은 검토하고 보낸다.
// 값은 모두 도구가 낸 것이다. 메일에 없어 가정한 값은 가정이라고 말한다.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { chatJson } from './llm.js'
import { addMessage } from './store.js'
import { emit } from './bus.js'
import { callCraft, craftAvailable } from '../mcp/craft.js'
import { publish } from './office.js'
import { workspaceHostPath } from './missions.js'
import { drawEnclosure } from './enclosureDrawing.js'
import { L } from './lang.js'
import { eng } from './prototypeUnits.js'

export const CIRCUIT_EXT = /\.(cir|net|ckt|sp|dsn)$/i
export const SOLID_EXT = /\.(step|stp|igs|iges)$/i
const ASK = /시작품|시제품|프로토타입|prototype/i
export const isPrototypeRequest = (mail, attachments = []) => ASK.test(`${mail.subject} ${mail.text}`) || attachments.some((a) => CIRCUIT_EXT.test(a.name) || SOLID_EXT.test(a.name))

const SPEC = `You read a customer's mail asking for a prototype of an electronic product and return its mechanical facts as JSON:
{"product","quantity","material","enclosure":{"width","depth","height","wall","corner_radius"},"standoffs":{"count","diameter","height","hole_diameter"},"front_hole":{"diameter"},"pcb":{"width","depth","thickness"},"part_numbers":[{"role","part"}],"due","assumed":[...]}
Sizes in mm as numbers. A screw size means the tapped hole: M3 is hole_diameter 2.5, M2.5 is 2.05, M4 is 3.3. part_numbers lists every manufacturer part number the mail names, role being what the mail says it is for. Write product and material in the language of the mail. Use only what the mail says; leave a field null when the mail does not say it. "assumed" stays [].`

// 메일의 숫자만 쓴다. 없는 값은 기본값으로 채우고 가정이라고 적는다.
export function normalizeSpec(raw = {}) {
  const assumed = []
  const pick = (v, d, label) => { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; assumed.push(`${label} ${d}`); return d }
  const e = raw.enclosure || {}, s = raw.standoffs || {}
  const width = pick(e.width, 100, L('외함 가로', 'enclosure width')), depth = pick(e.depth, 70, L('외함 세로', 'enclosure depth')), height = pick(e.height, 30, L('외함 높이', 'enclosure height'))
  const wall = pick(e.wall, 2, L('벽 두께', 'wall'))
  if (width <= wall * 4 || depth <= wall * 4 || height <= wall * 2) throw new Error(L(`외함 치수가 맞지 않아요: ${width} × ${depth} × ${height}, 벽 ${wall}`, `The enclosure size does not work: ${width} × ${depth} × ${height}, wall ${wall}`))
  const count = Math.round(Number(s.count)) || 0
  const d = count ? pick(s.diameter, 6, L('보스 지름', 'boss diameter')) : 0
  const bh = count ? pick(s.height, 5, L('보스 높이', 'boss height')) : 0, hd = count ? pick(s.hole_diameter, 2.5, L('보스 구멍', 'boss hole')) : 0
  const inset = wall + d / 2 + 3
  const corners = [[inset, inset], [width - inset, inset], [inset, depth - inset], [width - inset, depth - inset]]
  const standoffs = corners.slice(0, Math.min(count, 4)).map(([x, y]) => ({ x, y, diameter: d, height: bh, hole_diameter: hd }))
  const holes = Number(raw.front_hole?.diameter) > 0 ? [{ face: 'front', x: width / 2, y: height / 2, diameter: Number(raw.front_hole.diameter) }] : []
  return {
    product: String(raw.product || L('시작품', 'Prototype')).slice(0, 60), quantity: Math.max(1, Math.round(Number(raw.quantity)) || 1), material: raw.material || L('알루미늄', 'Aluminum'),
    enclosure: { width, depth, height, wall, corner_radius: Number(e.corner_radius) > 0 ? Number(e.corner_radius) : 0 }, standoffs, holes, due: raw.due || '', assumed,
    part_numbers: (Array.isArray(raw.part_numbers) ? raw.part_numbers : []).filter((p) => p?.part).map((p) => ({ role: String(p.role || ''), part: String(p.part) })),
  }
}

const j = (s) => { try { return JSON.parse(s) } catch { return s } }
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\n]/g, '_').trim()
const DENSITY = { al: 2.7 } // g/cm³

// the customer's files, where the tools and the agent's sandbox both see them
async function saveAttachments(dir, attachments) {
  const host = path.join(await workspaceHostPath('/workspace'), dir.replace(/^\/workspace\/?/, '')) // (workspaceHostPath wants a path that exists)
  await fs.mkdir(host, { recursive: true })
  const out = []
  for (const a of attachments) {
    const name = safeName(path.basename(a.name))
    await fs.writeFile(path.join(host, name), a.bytes)
    out.push({ name, path: `${dir}/${name}` })
  }
  return out
}

// 회로: 열고, 돌리고, 잰다. 못 돌린 것은 못 돌렸다고 말한다.
export async function reviewCircuit(userId, doc, dir, base) {
  const call = async (tool, args) => j(await callCraft(userId, 'circuitcraft', tool, args))
  const opened = await call('open', { path: doc.path })
  const result = { title: opened.title, warnings: opened.warnings, unsupported: opened.unsupported, runs: [], plots: [], bom: null, parts: opened.parts, cir: null, converted: opened.converted_from }
  if (opened.unsupported?.length) return result
  const sim = await call('simulate', {})
  const ok = sim.runs.filter((r) => r.ok)
  result.failed = sim.runs.filter((r) => !r.ok).map((r) => ({ label: r.label, error: r.error }))
  const pick = (r) => (r.vectors.find((v) => /^v\(flt\)$/i.test(v.name)) || r.vectors.find((v) => /^v\(out\)$/i.test(v.name)) || r.vectors.at(-1))?.name
  for (const r of ok) {
    const vector = pick(r)
    if (!vector) continue
    const row = { label: r.label, vector }
    if (r.complex) {
      const bw = await call('measure', { run: r.label, vector, what: 'bandwidth' })
      Object.assign(row, { gain: bw.low_frequency_gain ?? null, gain_db: bw.low_frequency_gain ? +(20 * Math.log10(bw.low_frequency_gain)).toFixed(1) : null, bandwidth_hz: bw.value ?? null, bandwidth: bw.text ?? bw.note })
    } else {
      const pp = await call('measure', { run: r.label, vector, what: 'pp' })
      Object.assign(row, { peak_to_peak_v: pp.value })
    }
    result.runs.push(row)
  }
  const group = (test) => ok.filter(test)
  const plot = async (runs, vector, name, title) => {
    if (!runs.length) return
    const p = `${dir}/${safeName(name)}.png`
    await call('plot', { path: p, runs: runs.map((r) => r.label), vectors: [vector], title })
    result.plots.push(p)
  }
  const ac = group((r) => r.complex), tran = group((r) => !r.complex && /^TRAN/.test(r.label))
  if (ac[0]) await plot(ac, pick(ac[0]), `${base} 주파수 응답`, L(`${base} 주파수 응답`, `${base} frequency response`))
  if (tran[0]) await plot(tran, pick(tran[0]), `${base} 시간 응답`, L(`${base} 시간 응답`, `${base} transient response`))
  result.bom = await call('bom', {})
  if (!doc.name.match(/\.cir$/i) || opened.converted_from) {
    result.cir = `${dir}/${safeName(base)} 회로.cir`
    await call('save', { path: result.cir })
  }
  return result
}

// 3D: 외함을 짓고 고객의 부품을 앉히고, 쓴다. 치수·부피는 형상에서 잰 값이다.
export async function buildEnclosure(userId, spec, parts, dir, base) {
  const call = async (tool, args) => j(await callCraft(userId, 'solidcraft', tool, args))
  await call('new', { name: spec.product })
  const built = await call('build_enclosure', { ...spec.enclosure, standoffs: spec.standoffs, holes: spec.holes })
  const placed = []
  const boss = spec.standoffs[0]
  for (const p of parts) {
    const z = spec.enclosure.wall + (boss?.height || 0)
    const r = await call('import', { path: p.path, at: [spec.enclosure.width / 2, spec.enclosure.depth / 2, z], name: p.name, center_xy: true })
    placed.push({ name: p.name, ...r })
  }
  const inspect = await call('inspect', {})
  const step = `${dir}/${safeName(base)} 외함.step`, iges = `${dir}/${safeName(base)} 외함.igs`, png = `${dir}/${safeName(base)} 외함.png`, inside = `${dir}/${safeName(base)} 외함 내부.png`
  await call('export', { path: step, format: '.step' })
  await call('export', { path: iges, format: '.iges' })
  await call('render', { path: png, view: 'iso' })
  // 뚜껑을 뺀 그림: 안에 앉은 PCB 가 보인다
  const lid = (built.parts || []).find((p) => /lid/i.test(p.name))?.name
  await call('render', { path: inside, view: 'iso', ...(lid ? { hide: [lid] } : {}) })
  // 재료 무게는 고객 부품을 뺀 외함(몸체와 뚜껑)만
  const volume_mm3 = (built.parts || []).reduce((a, p) => a + (Number(p.volume_mm3) || 0), 0)
  return { built, inspect, placed, step, iges, png, inside, volume_mm3 }
}

const fmtHz = (hz) => (hz ? eng(hz, 'Hz') : '-')
export function circuitSummary(c) {
  const ac = c.runs.filter((r) => r.gain != null)
  if (!ac.length) return L('이득을 잴 수 있는 해석이 없었어요.', 'There was no analysis to measure the gain from.')
  return ac.map((r) => L(`${r.label.replace(/^AC ?/, '') || '기본'}: 이득 ${r.gain_db} dB(${+r.gain.toPrecision(3)}배), 대역폭 ${fmtHz(r.bandwidth_hz)}`, `${r.label.replace(/^AC ?/, '') || 'base'}: gain ${r.gain_db} dB (×${+r.gain.toPrecision(3)}), bandwidth ${fmtHz(r.bandwidth_hz)}`)).join(L(' / ', ' / '))
}
export const bomLines = (bom) => (bom?.rows || []).map((r) => `${r.refs.join(',')} | ${r.kind} | ${r.value} | ${r.quantity}`).join('\n')

export async function prototypeDrafts(userId, t, mail, d, attachments, { delegateTurn }) {
  const status = (text) => emit(userId, 'status', { threadId: t.id, text })
  const say = (text) => addMessage(userId, t.id, 'agent', 'text', { text })
  const card = async (sandboxPath, extra = {}) => { const doc = await publish(userId, sandboxPath); await addMessage(userId, t.id, 'agent', 'file', { ...doc, path: sandboxPath, draft: true, ...extra }); return doc }
  const spec = normalizeSpec(await chatJson(SPEC, `${mail.subject}\n\n${String(mail.text || '').slice(0, 4000)}`))
  const base = safeName(spec.product)
  const dir = `/workspace/prototype-${crypto.randomBytes(3).toString('hex')}`
  const saved = await saveAttachments(dir, attachments)
  if (saved.length) await say(L(`첨부 ${saved.length}개를 받았어요: ${saved.map((s) => s.name).join(', ')}`, `I got ${saved.length} attachments: ${saved.map((s) => s.name).join(', ')}`))
  const missing = []

  // 1) 회로
  let circuit = null
  const doc = saved.find((s) => CIRCUIT_EXT.test(s.name))
  if (!doc) missing.push(L('첨부에 회로 파일이 없어 회로 검토는 건너뛰었어요', 'No circuit file was attached, so I skipped the circuit review'))
  else if (!craftAvailable('circuitcraft')) missing.push(L('이 설치에는 CircuitCraft 가 없어 회로 검토는 건너뛰었어요', 'This install has no CircuitCraft, so I skipped the circuit review'))
  else {
    status(L('회로 돌리는 중', 'Simulating the circuit'))
    try {
      circuit = await reviewCircuit(userId, doc, dir, base)
      // 회로 카드를 열 때 라이브러리도 함께 건넨다(CraftEditorFrame)
      const companions = []
      for (const lib of saved.filter((x) => /\.(lib|mod|inc)$/i.test(x.name))) { const up = await publish(userId, lib.path); companions.push({ name: up.name, url: up.url }) }
      await card(doc.path, companions.length ? { companions } : {})
      if (circuit.cir) await card(circuit.cir)
      for (const p of circuit.plots) await card(p)
      if (circuit.unsupported?.length) await say(L(`이 회로는 돌리지 못했어요: ${circuit.unsupported.join(', ')}`, `I could not simulate this circuit: ${circuit.unsupported.join(', ')}`))
      else await say([L(`PSpice 회로를 돌렸어요. ${circuitSummary(circuit)}`, `I simulated the PSpice circuit. ${circuitSummary(circuit)}`),
        circuit.warnings?.length ? L(`확인해 주세요: ${circuit.warnings.join(' ')}`, `Please check: ${circuit.warnings.join(' ')}`) : '',
        circuit.failed?.length ? L(`실패한 해석: ${circuit.failed.map((f) => `${f.label}(${f.error})`).join(', ')}`, `Failed runs: ${circuit.failed.map((f) => `${f.label} (${f.error})`).join(', ')}`) : ''].filter(Boolean).join('\n'))
    } catch (e) { console.warn('[prototype] circuit', e.message); missing.push(L(`회로를 돌리지 못했어요: ${e.message}`, `I could not simulate the circuit: ${e.message}`)) } finally { status(null) }
  }

  // 2) 3D
  let solid = null
  if (!craftAvailable('solidcraft')) missing.push(L('이 설치에는 SolidCraft 가 없어 3D 모델은 건너뛰었어요', 'This install has no SolidCraft, so I skipped the 3D model'))
  else {
    status(L('외함 3D 모델링하는 중', 'Modeling the enclosure in 3D'))
    try {
      solid = await buildEnclosure(userId, spec, saved.filter((s) => SOLID_EXT.test(s.name)), dir, base)
      await card(solid.step); await card(solid.iges); await card(solid.inside)
      solid.mass_g = solid.volume_mm3 ? +(solid.volume_mm3 / 1000 * DENSITY.al).toFixed(0) : null
      await say(L(`외함을 ${spec.enclosure.width} × ${spec.enclosure.depth} × ${spec.enclosure.height} mm 로 모델링해 STEP 과 IGES 로 저장했어요.${solid.placed.length ? ` 보내 주신 ${solid.placed.map((p) => p.name).join(', ')} 도 안에 넣었어요.` : ''}${solid.mass_g ? ` 재료 무게는 약 ${solid.mass_g} g 이에요.` : ''}`,
        `I modeled the enclosure at ${spec.enclosure.width} × ${spec.enclosure.depth} × ${spec.enclosure.height} mm and saved it as STEP and IGES.${solid.placed.length ? ` Your ${solid.placed.map((p) => p.name).join(', ')} sits inside it.` : ''}${solid.mass_g ? ` It takes about ${solid.mass_g} g of material.` : ''}`))
    } catch (e) { console.warn('[prototype] solid', e.message); missing.push(L(`3D 모델을 만들지 못했어요: ${e.message}`, `I could not make the 3D model: ${e.message}`)) } finally { status(null) }
  }

  // 3) 2D
  let drawing = null, drawingPng = null
  if (!craftAvailable('cadcraft')) missing.push(L('이 설치에는 CADCraft 가 없어 2D 도면은 건너뛰었어요', 'This install has no CADCraft, so I skipped the 2D drawing'))
  else {
    try {
      drawing = await drawEnclosure(userId, spec, `${dir}/${base} 외함 도면.dxf`, (s) => status(L(`캐드크래프트로 도면 그리는 중 · ${s}`, `Drawing in CADCraft · ${s}`)))
      const dxf = await card(drawing)
      const { planPicture } = await import('./mail.js')
      drawingPng = await planPicture(dxf.url).catch((e) => { console.warn('[prototype] drawing picture', e.message); return null })
      await say(L('같은 치수로 2D 도면(윗면·앞면·오른쪽면)을 그렸어요.', 'I drew the 2D drawing (top, front, right) from the same dimensions.'))
    } catch (e) { console.warn('[prototype] drawing', e.message); missing.push(L(`2D 도면을 그리지 못했어요: ${e.message}`, `I could not draw the 2D drawing: ${e.message}`)) } finally { status(null) }
  }

  // 4) 제안서·견적서: 위의 값으로 에이전트가 쓴다
  // 그림마다 무엇인지 함께 준다: 모델에게 맡기면 없는 말을 지어낸다("임펄스 응답", "배치도")
  const captioned = [
    ...(circuit?.plots || []).map((p) => [p, /주파수/.test(p) ? L('주파수 응답: 시뮬레이션', 'Frequency response: simulation') : L('시간 응답(사인파 입력): 시뮬레이션', 'Transient response (sine input): simulation')]),
    ...(solid?.png ? [[solid.png, L('외함 3D 모델', 'Enclosure 3D model')]] : []),
    ...(solid?.inside ? [[solid.inside, L('뚜껑을 뺀 모습: 안에 고객 PCB', 'With the lid off: the customer PCB inside')]] : []),
    ...(drawingPng ? [[drawingPng, L('외함 2D 도면(윗면·앞면·오른쪽면)', 'Enclosure 2D drawing (top, front, right)')]] : []),
  ]
  const pictures = captioned.map(([p, c]) => `${p} (${L('설명', 'caption')}: ${c})`)
  const facts = [
    L(`제품: ${spec.product}, 수량 ${spec.quantity}대, 재질 ${spec.material}`, `Product: ${spec.product}, quantity ${spec.quantity}, material ${spec.material}`),
    L(`외함: ${spec.enclosure.width} × ${spec.enclosure.depth} × ${spec.enclosure.height} mm, 벽 ${spec.enclosure.wall} mm${solid?.mass_g ? `, 재료 ${solid.mass_g} g` : ''}`, `Enclosure: ${spec.enclosure.width} × ${spec.enclosure.depth} × ${spec.enclosure.height} mm, wall ${spec.enclosure.wall} mm${solid?.mass_g ? `, ${solid.mass_g} g of material` : ''}`),
    circuit ? L(`회로 검토(고객이 보낸 회로를 우리가 CircuitCraft 로 시뮬레이션해 잰 값): ${circuitSummary(circuit)}`, `Circuit review (we simulated the customer's circuit in CircuitCraft and measured): ${circuitSummary(circuit)}`) : '',
    spec.part_numbers.length ? L(`메일이 지정한 부품 번호(견적서의 해당 부품 줄 규격에 그대로 적으세요): ${spec.part_numbers.map((x) => `${x.role} = ${x.part}`).join(', ')}`, `Part numbers the mail names (put each in the spec column of its line in the quote): ${spec.part_numbers.map((x) => `${x.role} = ${x.part}`).join(', ')}`) : '',
    circuit?.bom ? L(`회로 부품표(참조|종류|값|수량):\n${bomLines(circuit.bom)}`, `Circuit parts (refs|kind|value|qty):\n${bomLines(circuit.bom)}`) : '',
    spec.assumed.length ? L(`메일에 없어 가정한 값: ${spec.assumed.join(', ')}`, `Assumed because the mail did not say: ${spec.assumed.join(', ')}`) : '',
    missing.length ? L(`만들지 못한 것: ${missing.join('. ')}`, `Not made: ${missing.join('. ')}`) : '',
  ].filter(Boolean).join('\n')
  const items = (d.items || []).filter((i) => i.format === 'xlsx' || i.format === 'docx' || i.format === 'hwpx')
  const docs = items.length ? items : [{ kind: L('제안서', 'proposal'), format: 'docx', name: `${base} ${L('제작 제안서', 'proposal')}.docx` }, { kind: L('견적서', 'quote'), format: 'xlsx', name: `${base} ${L('견적서', 'quote')}.xlsx` }]
  const body = String(mail.text || '').slice(0, 2500)
  const jobs = docs.map((i, k) => `${k + 1}) ${i.kind}, ${dir}/${safeName(i.name.replace(/\.hwpx$/i, '.docx'))}. ${/xlsx/.test(i.format)
    ? L(`엑셀(xlsx) 스킬로 만드세요. 위에 제목·수신·발신·견적일·유효기간, 품목 표(구분·품목·규격·수량·단가·금액, 금액은 =수량*단가 엑셀 수식이어야 하고 값을 직접 쓰지 마세요). 품목: 회로 부품표의 부품(1대 기준 수량에 대수를 곱함, 메일에 나온 부품 번호를 규격에 그대로), PCB 제작·조립, 외함 재료(무게 기준)·CNC 가공·표면 처리, 시험·검사. 아래에 공급가액·부가세(10%)·합계 수식. 단가는 합리적인 가정값이고, 아래쪽에 "단가는 가정값입니다. 확정 전 공급사 견적이 필요합니다"라고 적으세요.`,
      `Use the Excel (xlsx) skill. At the top the title, to, from, date and validity; an item table (category, item, spec, quantity, unit price, amount, amount as a =quantity*unit formula). Items: the circuit's parts (per-unit quantity × units; part numbers from the mail in the spec column), PCB and assembly, enclosure material (by mass), CNC machining and finish, test. Below: subtotal, VAT 10%, total as formulas. Unit prices are reasonable assumptions: say below the table that they are assumptions and need supplier quotes.`)
    : L(`워드(docx) 스킬로 만드세요. 표지(고객·제목·날짜), 요청 내용, 회로 검토 결과(위 값 그대로, 표로), 기구 설계(치수·재질), 일정, 제작 범위. 그림을 설명 그대로 넣으세요: ${pictures.join(', ') || '(없음)'}. 숫자는 위 값만 쓰고 지어내지 마세요. 메일에 없는 제작 조건(표면 처리 방법, 일정 등)은 정해진 것처럼 쓰지 말고 "가정"이라고 적으세요.`,
      `Use the Word (docx) skill. A cover (customer, title, date), the request, the circuit review (the values above, as a table), the mechanical design (sizes, material), schedule, scope. Put these pictures in with their captions: ${pictures.join(', ') || '(none)'}. Use only the values above; do not make up numbers. Conditions the mail does not give (finish, schedule) are assumptions: say so rather than stating them as decided.`)}`).join('\n')
  await say(L('이 값들로 제안서와 견적서를 쓸게요.', "I'll write the proposal and the quote from these values."))
  await delegateTurn(L(`같은 고객 메일(${mail.subject})에 회신할 문서 초안을 만드세요.\n\n${facts}\n\n메일 본문: ${body}\n\n${jobs}\n\n(회로, 3D, 2D 도면은 이미 만들었으니 다시 만들지 마세요.) 다 만들면 파일 이름과 가정한 단가를 두세 줄로 적으세요. 진행 설명과 답은 모두 한국어(해요체)로 쓰세요.`,
    `Make draft documents to answer the same customer mail (${mail.subject}).\n\n${facts}\n\nMail body: ${body}\n\n${jobs}\n\n(The circuit, 3D model and 2D drawing are already made: do not make them again.) When done, give the file names and the unit prices you assumed in two or three lines. Write the progress notes and the answer in English.`))
  if (missing.length) await say(L(`다음은 사람이 봐 주세요. ${missing.join('. ')}.`, `These need a person. ${missing.join('. ')}.`))
  return { spec, circuit, solid, drawing, missing }
}
