<script setup>
// 회사 프로세스 지도의 그림(SVG): 일은 둥근 상자(이름 · 역할 · 건수), 시작 일에는 「시작 n%」, 끝은 하나.
// 관계 굵기는 확률(p), 숫자는 p. 고리는 바깥으로 도는 곡선, 은퇴 후보는 주황 점선, 은퇴한 관계는 회색 점선,
// 고정은 핀, 관찰 적음(Wilson 구간 폭 > 0.3)은 흐리게, 후보 일은 흐리게. 배치는 layout.js.
// 넓은 화면은 왼→오, 폰은 위→아래. 끌어서 옮기고, 휠은 커서 자리를 중심으로, − / 맞춤 / + 로도 크기를 바꾼다.
// 사건 보기(events): 사건은 작은 원(메일 · 결과물 · 채팅)과 그 아래 이름. 일 → 사건(RAISES) · 사건 → 일(TRIGGERS) 관계를
// 그리고, 한 사건 뒤 여러 일이 함께 열리면(split and) 숫자 옆에 「함께」. 사건이나 그 관계를 누르면 select {kind: 'event'}.
// 프로세스 다듬기(OntoRefine): 일 · 관계에 added(다듬으며 더함, 파랑 점선 · 기록이 없으면 「더함」) · removed(다듬으며 뺌, 빨강 점선)가
// 있으면 그렇게 그린다. marks 는 AI 후보(high · mid · human)와 단계 가르기(gate · human · ai · drop · skipped)를 함께 칠한다.
// 출처(다듬은 흐름 · mapView.js): 사람이 정한 일 · 관계(decided)는 건수 · 이름표 옆에 작은 사람-확인 표시(「사람이 정했어요」),
// 정했지만 아직 본 적 없는 것(unseen, 0건)은 점선 · 흐리게 — 관계 이름표는 비율 대신 「정함」, 일의 건수 자리는 「아직 0건」.
// 미리 보기(diff): add = 초록 「더함」 · remove = 빨강 점선 + 이름에 줄 「뺌」 · change = 노랑 「바뀜」(change 글은 풍선 도움말).
// added · removed(다듬기 나란히 보기)와 따로 간다: decided 나 diff 가 있으면 그쪽으로 그린다.
// 의견(notes): 조용한 「의견 N」, 의견이 엇갈리면 「해소 필요」; onlyNotes 는 해소 필요가 없는 것을 흐리게.
// 여러 개 고르기(pickable): Shift · Cmd(Ctrl) + 누르기로 일 · 관계를 넣고 빼고, Shift + 끌기는 상자 안의 일과 고른 일 사이의
// 관계를 더한다 → pick {tasks, ways}. 그냥 끌기는 옮기기, 그냥 누르기는 select 그대로.
// 흐름 분석(OntoFlowPanel): marks 의 heat1~3(지금 쌓인 할 일의 많고 적음) · bott(병목) · agent(에이전트 구간) · out(바깥 대기)으로 칠하고,
// badges 는 일의 위 오른쪽 꼬리표(「할 일 7」 · 「병목 · 할 일 7」), hotWays 는 흔한 길(크리티컬 패스)의 관계를 굵게 · 나머지는 흐리게.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, useId } from 'vue'
import { layoutGraph } from './layout.js'
import { END, pct, taskName, SPLIT_KO, condText } from './fmt.js'
import { edgeId, EV } from './mapView.js'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  edges: { type: Array, default: () => [] },
  entries: { type: Array, default: () => [] },
  events: { type: Array, default: () => [] }, // 사건 보기: [{key: EV + event key, ev, label, and}]
  selected: { type: Object, default: null }, // {kind: 'edge'|'task'|'event', id}
  dir: { type: String, default: 'LR' },
  side: Boolean, // a side panel covers the right: keep room so the map can move out from under it
  scale: { type: Number, default: 1 }, // entry shares are of all cases; × this = of the shown proc's cases
  marks: { type: Map, default: () => new Map() }, // 일 → high · mid · human (AI 후보) | gate · human · ai · drop · skipped (단계 가르기) | req · opt · cond (단계 규칙) — 칠하고, 나머지는 흐리게
  whole: Boolean, // 전체 화면: the whole map on the screen, also after the map changes (smaller sizes allowed)
  picked: { type: Object, default: null }, // {tasks: [task key], ways: [edge id]} — outlined
  pickable: Boolean, // shift / cmd(ctrl) + click toggles, shift + drag picks a box → pick {tasks, ways}
  notes: { type: Object, default: null }, // 의견: {tasks: {[key]: {n, conflict}}, ways: {[edge id]: {n, conflict}}}
  onlyNotes: Boolean, // 해소 필요만: dim what has no conflict
  badges: { type: Map, default: () => new Map() }, // 흐름 분석: 일 → {text, kind: bott · hot · agent · out}
  hotWays: { type: Set, default: () => new Set() }, // 흐름 분석: 흔한 길의 관계(edge id)
})
const emit = defineEmits(['select', 'pick'])

// text width at a font size (Hangul a full em, digits and Latin narrower) — enough to wrap names and size labels
const em = (ch) => (/[가-힣ㄱ-ㆎ一-龥]/.test(ch) ? 1 : /[0-9]/.test(ch) ? 0.6 : ch === ' ' ? 0.3 : ch === '%' ? 0.85 : ch === '·' ? 0.4 : /[A-Z]/.test(ch) ? 0.68 : 0.56)
const textW = (s, size) => [...String(s)].reduce((a, c) => a + em(c) * size, 0)
const NAME = 14, SMALL = 11.5, LABEL = 11.5, EVS = 11, R = 13
function wrap(name, max, size = NAME) {
  const words = String(name).split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (textW(next, size) <= max || !cur) cur = next
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  const out = lines.slice(0, 2)
  if (lines.length > 2) out[1] = `${out[1]}…`
  // a single word longer than the box: cut by characters
  return out.map((l) => {
    if (textW(l, size) <= max) return l
    let s = ''
    for (const c of l) { if (textW(`${s}${c}…`, size) > max) return `${s}…`; s += c }
    return s
  })
}

const W = computed(() => (props.dir === 'LR' ? 126 : 128))
const nodeDefs = computed(() => {
  const list = props.tasks.map((t) => {
    const lines = wrap(t.name || t.key, W.value - 22)
    return { key: t.key, w: W.value, h: lines.length > 1 ? 74 : 58, lines, t }
  })
  // an event: a small circle, its name under it (LR) or beside it (TB); edges meet the circle (port), not the box
  for (const e of props.events) {
    const LR = props.dir === 'LR'
    const lines = wrap(e.label, LR ? 100 : 90, EVS)
    const lw = Math.ceil(Math.max(...lines.map((l) => textW(l, EVS))))
    if (LR) list.push({ key: e.key, ev: e, lines, w: Math.max(2 * R + 8, lw + 8), h: 2 * R + 2 * (lines.length * 13 + 5), port: R })
    else list.push({ key: e.key, ev: e, lines, w: 2 * R + 2 * (lw + 10), h: Math.max(2 * R + 6, lines.length * 13 + 6), port: R })
  }
  if (props.edges.some((e) => e.to === END)) list.push({ key: END, w: 58, h: 36, end: true })
  return list
})
const stale = (e) => e.stale && e.status !== 'retired'
const isAnd = (e) => e.kind === 'trigger' && e.split === 'and'
// a role routine's step: how many people of the role do it
const people = (e) => (e.kind === 'trigger' && String(e.scope || '').startsWith('role:') ? `${e.people || 0}명` : '')
const DIFF_KO = { add: '더함', remove: '뺌', change: '바뀜' }
const DECIDED = '사람이 정했어요', UNSEEN = '정했지만 아직 본 적 없어요'
const isWay = (e) => !e.kind || e.kind === 'next'
// 다듬으며 더한 관계는 아직 지나간 건이 없으면 비율 대신 「더함」 · 정했지만 아직 본 적 없는 관계는 「정함」 · 미리 보기는 더함 · 뺌 · 바뀜
function head(e) {
  if (e.diff === 'remove') return DIFF_KO.remove
  if (e.diff === 'add' && !(e.n > 0)) return DIFF_KO.add
  const h = e.unseen ? '정함' : e.added && !e.decided && !e.n ? '더함' : pct(e.p)
  return DIFF_KO[e.diff] ? `${h} · ${DIFF_KO[e.diff]}` : h
}
// 의견 on a way / a task: 「의견 N」, or 「해소 필요」 when opinions conflict
const wayNote = (e) => (isWay(e) ? props.notes?.ways?.[edgeId(e)] : null) || null
const taskNote = (key) => props.notes?.tasks?.[key] || null
const noteText = (x) => (!x ? '' : x.conflict ? '해소 필요' : `의견 ${x.n || 0}`)
// small glyphs before a label's text: pin (고정), person-check (사람이 정했어요 — an unseen way says 「정함」 instead)
const icons = (e) => [e.pinned && 'pin', e.decided && !e.unseen && 'dec'].filter(Boolean)
// one id per map: two maps on a page (프로세스 다듬기 나란히 보기) must not share the clip
const clipId = `pm-node-clip-${useId()}`
// the short form (when the long one fits nowhere, e.g. between two tasks side by side): no 「은퇴 후보」, the note as a bubble
const BUBBLE = 16
function labelW(e, short) {
  const nt = noteText(wayNote(e))
  const text = `${head(e)}${stale(e) && !short ? ' · 은퇴 후보' : ''}${isAnd(e) ? ` · ${SPLIT_KO.and}` : ''}${people(e) ? ` · ${people(e)}` : ''}${nt && !short ? ` · ${nt}` : ''}`
  return Math.ceil(textW(text, LABEL) + 14 + 13 * icons(e).length + (!nt ? 0 : short ? BUBBLE : wayNote(e)?.conflict ? 4 : 0))
}
const hasShort = (e) => stale(e) || !!wayNote(e)
const width = (e) => 1.2 + 4.6 * Math.min(1, Math.max(0, e.p || 0))
const tipLen = (e) => 7 + width(e) * 1.4

const L = computed(() => layoutGraph({
  nodes: nodeDefs.value.map(({ key, w, h, port }) => ({ key, w, h, port })),
  edges: props.edges.map((e) => ({ id: edgeId(e), from: e.from, to: e.to, p: e.p || 0 })),
  entries: props.entries,
  dir: props.dir,
  gapRank: props.dir === 'LR' ? 52 : 46,
  gapOrder: props.dir === 'LR' ? 30 : 22,
  labelSize: (x) => { const e = props.edges.find((y) => edgeId(y) === x.id) || x; return { w: labelW(e), ws: hasShort(e) ? labelW(e, true) : 0, h: 18 } },
}))
const nodeBy = computed(() => new Map(nodeDefs.value.map((n) => [n.key, n])))
const nameOf = (key) => nodeBy.value.get(key)?.ev?.ev?.name || taskName(key)
const selKey = computed(() => (props.selected?.kind === 'event' ? EV + props.selected.id : props.selected?.kind === 'task' ? props.selected.id : null))
const edgeBy = computed(() => new Map(props.edges.map((e) => [edgeId(e), e])))
const entryShare = computed(() => new Map(props.tasks.filter((t) => props.entries.includes(t.key)).map((t) => [t.key, Math.min(1, (t.entry_share || 0) * props.scale)])))

// the line stops short of the node so the arrowhead (drawn on its own) has a clean tip
function trimmed(g) {
  const e = edgeBy.value.get(g.id)
  const m = /C([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)$/.exec(g.d)
  if (!m) return { d: g.d, tip: null }
  let [cx, cy, x, y] = [+m[3], +m[4], +m[5], +m[6]]
  let dx = x - cx, dy = y - cy
  if (Math.hypot(dx, dy) < 0.5) { dx = x - +m[1]; dy = y - +m[2] }
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len, uy = dy / len, k = tipLen(e) * 0.8
  const d = g.d.slice(0, m.index) + `C${m[1]},${m[2]} ${(cx - ux * k).toFixed(1)},${(cy - uy * k).toFixed(1)} ${(x - ux * k).toFixed(1)},${(y - uy * k).toFixed(1)}`
  return { d, tip: { x, y, a: (Math.atan2(uy, ux) * 180) / Math.PI } }
}
const pickedT = computed(() => new Set(props.picked?.tasks || []))
const pickedW = computed(() => new Set(props.picked?.ways || []))
const drawn = computed(() => L.value.edges.map((g) => {
  const e = edgeBy.value.get(g.id)
  const { d, tip } = trimmed(g)
  const retired = e.status === 'retired'
  const nt = wayNote(e)
  const tips = [e.unseen ? `${nameOf(e.from)} → ${nameOf(e.to)}` : `${nameOf(e.from)} → ${nameOf(e.to)} · ${pct(e.p)} · ${e.n ?? 0}건`]
  if (e.decided) tips.push(e.unseen ? UNSEEN : DECIDED)
  if (DIFF_KO[e.diff]) tips.push(DIFF_KO[e.diff])
  if (e.change) tips.push(e.change)
  if (isAnd(e)) tips.push('여러 일이 함께 열려요')
  if (e.parallel && !isAnd(e)) tips.push('나란히')
  if (people(e)) tips.push(`같은 역할 ${people(e)}`)
  if (e.cond) tips.push(`조건: ${condText(e.cond)}`)
  if (e.pinned) tips.push('고정')
  if (e.stale) tips.push('은퇴 후보')
  if (retired) tips.push('은퇴함')
  if (e.thin) tips.push('관찰 적음')
  if (!e.kind && !e.decided && (e.people ?? 2) <= 1) tips.push('한 사람 기준')
  if (e.added && !e.decided) tips.push('다듬으며 더함')
  if (e.removed) tips.push('다듬으며 뺌')
  if (nt) tips.push(`의견 ${nt.n || 0}${nt.conflict ? ' · 해소 필요' : ''}`)
  return {
    id: g.id, d, tip, e, back: g.back, label: g.label, w: width(e), tl: tipLen(e), title: tips.join(' · '),
    head: head(e), ics: icons(e), note: nt && { text: noteText(nt), n: nt.n || 0, conflict: !!nt.conflict },
    cls: { stale: stale(e), retired, thin: e.thin, back: g.back, and: isAnd(e), evt: e.kind === 'raise' || e.kind === 'trigger',
      added: !!e.added && !e.decided && !e.diff, removed: !!e.removed && !e.diff, decided: !!e.decided && !e.unseen, unseen: !!e.unseen,
      [`df-${e.diff}`]: !!DIFF_KO[e.diff], picked: isWay(e) && pickedW.value.has(g.id), nconf: !!nt?.conflict, nd: props.onlyNotes && !nt?.conflict,
      sel: props.selected?.kind === 'edge' && props.selected.id === g.id, near: !!selKey.value && (e.from === selKey.value || e.to === selKey.value),
      hot: props.hotWays.has(g.id), cool: props.hotWays.size > 0 && !props.hotWays.has(g.id) && isWay(e) },
  }
}))

// a task's bottom row: role (· AI when an agent runs it) on the left, the count on the right, the person-check before the count
function ctText(t) {
  if (t.kind === 'habit' && !t.n_cases) return '루틴'
  if (t.unseen) return '아직 0건'
  if (t.added && !t.decided && !t.n_cases) return '더함'
  return `${t.n_cases ?? 0}건`
}
function clip(s, max, size) {
  if (textW(s, size) <= max) return s
  let out = ''
  for (const c of s) { if (textW(`${out}${c}…`, size) > max) return out ? `${out}…` : ''; out += c }
  return out
}
function foot(n) {
  const t = n.t, ct = ctText(t), cw = textW(ct, SMALL)
  // an unseen task says it with its dashed border and 「아직 0건」 (as an unseen way says 「정함」)
  const gx = t.decided && !t.unseen ? n.w - 11 - cw - 16 : null
  const ai = t.runner === 'agent' ? (t.role ? ' · AI' : 'AI') : ''
  const room = (gx ?? n.w - 11 - cw) - 11 - 6 - textW(ai, SMALL)
  return { ct, gx, ai, role: clip(String(t.role || ''), room, SMALL) }
}
function nodeTip(t) {
  const out = [t.name || t.key]
  if (t.role) out.push(t.role)
  out.push(t.unseen ? '아직 0건' : `${t.n_cases ?? 0}건`)
  if (t.candidate) out.push('후보')
  if (t.runner === 'agent') out.push('AI 에이전트가 해요')
  if (t.decided) out.push(t.unseen ? UNSEEN : DECIDED)
  else if (t.added) out.push('다듬으며 더함')
  if (t.removed) out.push('다듬으며 뺌')
  if (DIFF_KO[t.diff]) out.push(DIFF_KO[t.diff])
  if (t.change) out.push(t.change)
  if (t.was && t.was !== t.key && !String(t.change || '').includes(t.was)) out.push(`전에는 「${t.was}」`)
  const nt = taskNote(t.key)
  if (nt) out.push(`의견 ${nt.n || 0}${nt.conflict ? ' · 해소 필요' : ''}`)
  return out.join(' · ')
}
const tagW = (text, size = 10.5, pad = 16) => Math.ceil(textW(text, size) + pad)
const nodes = computed(() => L.value.nodes.map((n) => {
  const def = nodeBy.value.get(n.key)
  const x = { ...n, ...def, x0: n.x - n.w / 2, y0: n.y - n.h / 2, share: entryShare.value.get(n.key) }
  if (!x.t) return x
  const t = x.t, mk = props.marks.get(n.key), nt = taskNote(n.key), diff = DIFF_KO[t.diff] ? t.diff : ''
  x.tip = nodeTip(t)
  x.foot = foot(x)
  x.strike = mk === 'drop' || (t.removed && !diff) || diff === 'remove'
  x.dtag = diff && { text: DIFF_KO[diff], w: tagW(DIFF_KO[diff]) }
  x.ntag = nt && { text: noteText(nt), w: tagW(noteText(nt), 10, nt.conflict ? 17 : 14), conflict: !!nt.conflict }
  const bd = props.badges.get(n.key)
  x.btag = !x.dtag && bd?.text ? { text: bd.text, w: tagW(bd.text), kind: bd.kind || 'hot' } : null
  x.picked = pickedT.value.has(n.key)
  x.cls = {
    [`mk-${mk}`]: props.marks.has(n.key), dim: props.marks.size && !props.marks.has(n.key), cand: t.candidate,
    sel: props.selected?.kind === 'task' && props.selected.id === n.key, entry: x.share, habit: t.kind === 'habit',
    added: t.added && !t.decided && !diff, removed: t.removed && !diff, decided: t.decided, unseen: t.unseen && !diff,
    [`df-${diff}`]: !!diff, picked: x.picked, nd: props.onlyNotes && !nt?.conflict,
  }
  return x
}))
const entryTag = (n) => {
  const text = `시작 ${pct(n.share)}`
  const w = Math.ceil(textW(text, 10.5) + 22)
  return { text, w, x: props.dir === 'LR' ? n.x0 + 6 : n.x0 - 4, y: n.y0 - 12 }
}

// ---------- zoom · pan ----------
const vp = ref(null)
const zoom = ref(1)
const fitMode = ref('auto') // auto: readable size, scroll if larger · all: the whole map · manual: − / +
const minZoom = () => (props.whole ? 0.08 : 0.3)
function apply() {
  const el = vp.value
  if (!el || !L.value.width) return
  const cw = el.clientWidth - 12 - (props.side && props.dir === 'LR' ? 360 : 0), ch = el.clientHeight - 58
  const all = Math.min(cw / L.value.width, ch / L.value.height, 1.05)
  if (fitMode.value === 'all') zoom.value = Math.max(minZoom(), all)
  else if (fitMode.value === 'auto') zoom.value = props.dir === 'TB' ? Math.max(0.78, Math.min(1.05, cw / L.value.width)) : Math.max(0.8, all)
}
// start where the work starts: the main entry in view (LR: from the left edge, TB: centred across)
function home() {
  const el = vp.value, svg = el?.querySelector('svg.map')
  if (!el) return
  el.scrollLeft = 0; el.scrollTop = 0
  const n = L.value.nodes.find((x) => x.key === props.entries[0])
  if (!n || !svg) return
  const a = svg.getBoundingClientRect(), b = el.getBoundingClientRect()
  const px = a.left - b.left + n.x * zoom.value, py = a.top - b.top + n.y * zoom.value
  if (props.dir === 'TB') el.scrollLeft = Math.max(0, px - el.clientWidth / 2)
  else el.scrollTop = Math.max(0, py - el.clientHeight / 2)
}
function fit() {
  fitMode.value = 'all'
  apply()
  nextTick(home)
}
// back to the readable size (leaving 전체 화면)
function reset() { fitMode.value = 'auto'; apply(); nextTick(home) }
watch(() => props.whole, (w) => nextTick(w ? fit : reset))
const step = (k) => { zoom.value = Math.min(2, Math.max(minZoom(), +(zoom.value * k).toFixed(3))); fitMode.value = 'manual' }
watch(() => [L.value.width, L.value.height, props.dir], () => {
  fitMode.value = props.whole ? 'all' : 'auto'
  nextTick(() => { apply(); nextTick(home) })
})
// a selection made elsewhere (the task panel's lists, the labels drawer) or under the side panel: bring it into view
watch(() => props.selected, async (s) => {
  if (!s) return
  await nextTick()
  const el = vp.value, svg = el?.querySelector('svg.map')
  if (!el || !svg) return
  const n = s.kind === 'task' || s.kind === 'event' ? L.value.nodes.find((x) => x.key === (s.kind === 'event' ? EV + s.id : s.id)) : null
  const g = s.kind === 'edge' ? L.value.edges.find((x) => x.id === s.id) : null
  const pt = n ? { x: n.x, y: n.y } : g ? { x: g.label.x, y: g.label.y } : null
  if (!pt) return
  const a = svg.getBoundingClientRect(), b = el.getBoundingClientRect()
  const px = a.left - b.left + el.scrollLeft + pt.x * zoom.value, py = a.top - b.top + el.scrollTop + pt.y * zoom.value
  const visW = props.dir === 'LR' ? el.clientWidth - 370 : el.clientWidth
  const visH = props.dir === 'LR' ? el.clientHeight : el.clientHeight * 0.45
  const left = px < el.scrollLeft + 40 || px > el.scrollLeft + visW - 40 ? px - visW / 2 : el.scrollLeft
  const top = py < el.scrollTop + 40 || py > el.scrollTop + visH - 40 ? py - visH / 2 : el.scrollTop
  el.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: 'smooth' })
  // phone: the panel is a sheet over the lower half — bring the map's top under the bar
  if (props.dir === 'TB') el.scrollIntoView({ block: 'start', behavior: 'smooth' })
})
let ro
onMounted(() => {
  apply()
  nextTick(home)
  ro = new ResizeObserver(() => { if (fitMode.value !== 'manual') apply() })
  if (vp.value) ro.observe(vp.value)
})
onBeforeUnmount(() => ro?.disconnect())

// 휠 · 트랙패드: 커서 자리를 중심으로 키우고 줄인다 — 커서 밑의 일이 그 자리에 그대로 있다. 옆으로 미는 두 손가락은 옆으로 옮기기.
// 폰 모양(TB)에서는 페이지가 스크롤돼야 해서 Ctrl(트랙패드 핀치)만 크기를 바꾼다. 여러 이벤트는 한 프레임에 모아 한 번에.
let wheelK = 1, wheelAt = null, wheelRaf = 0
function onWheel(ev) {
  const el = vp.value
  if (!el || !L.value.width) return
  if (!ev.ctrlKey && Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) { ev.preventDefault(); el.scrollLeft += ev.deltaX; return }
  if (props.dir === 'TB' && !ev.ctrlKey) return
  ev.preventDefault()
  const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1
  wheelK *= Math.exp(-ev.deltaY * unit * (ev.ctrlKey ? 0.01 : 0.0015))
  wheelAt = { x: ev.clientX, y: ev.clientY }
  if (!wheelRaf) wheelRaf = requestAnimationFrame(zoomAtCursor)
}
async function zoomAtCursor() {
  wheelRaf = 0
  const k = wheelK
  wheelK = 1
  const el = vp.value, svg = el?.querySelector('svg.map')
  if (!el || !svg || !wheelAt) return
  const z0 = zoom.value, z1 = Math.min(2, Math.max(minZoom(), +(z0 * k).toFixed(4)))
  if (z1 === z0) return
  const at = wheelAt, a = svg.getBoundingClientRect()
  const ux = (at.x - a.left) / z0, uy = (at.y - a.top) / z0 // the map point under the cursor
  zoom.value = z1
  fitMode.value = 'manual'
  await nextTick()
  const b = svg.getBoundingClientRect()
  el.scrollLeft += b.left + ux * z1 - at.x
  el.scrollTop += b.top + uy * z1 - at.y
}
onBeforeUnmount(() => cancelAnimationFrame(wheelRaf))

// 끌기: 그냥 끌면 지도를 옮기고, 고를 수 있을 때 Shift + 끌기는 고르는 상자(지도 좌표 — 크기 · 스크롤과 상관없이)
let drag = null, moved = false
const band = ref(null) // {x0, y0, x1, y1} in map units while a box is drawn
const svgEl = () => vp.value?.querySelector('svg.map')
function mapPt(ev) {
  const a = svgEl().getBoundingClientRect()
  return { x: (ev.clientX - a.left) / zoom.value, y: (ev.clientY - a.top) / zoom.value }
}
function down(ev) {
  if (ev.pointerType !== 'mouse' || ev.button !== 0) return
  moved = false
  if (props.pickable && ev.shiftKey && svgEl()) { drag = { box: true, id: ev.pointerId, x: ev.clientX, y: ev.clientY, at: mapPt(ev) }; return }
  drag = { x: ev.clientX, y: ev.clientY, l: vp.value.scrollLeft, t: vp.value.scrollTop }
}
function move(ev) {
  if (!drag) return
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y
  if (!moved && Math.abs(dx) + Math.abs(dy) > 4) {
    moved = true
    // the box goes on outside the map; the click that ends it lands on the map, not on a node
    if (drag.box) try { vp.value.setPointerCapture(drag.id) } catch { /* pointer gone */ }
  }
  if (!moved) return
  if (drag.box) {
    const p = mapPt(ev), a = drag.at
    band.value = { x0: Math.min(a.x, p.x), y0: Math.min(a.y, p.y), x1: Math.max(a.x, p.x), y1: Math.max(a.y, p.y) }
    return
  }
  vp.value.scrollLeft = drag.l - dx; vp.value.scrollTop = drag.t - dy
}
function up() {
  if (drag?.box && band.value) pickBox(band.value)
  band.value = null
  drag = null
}
function cancel() { band.value = null; drag = null }
function choose(kind, id) {
  if (moved) { moved = false; return }
  emit('select', kind ? { kind, id } : null)
}

// ---------- 여러 개 고르기 ----------
const toggleKey = (ev) => props.pickable && (ev.shiftKey || ev.metaKey || ev.ctrlKey)
const pickNow = () => ({ tasks: [...(props.picked?.tasks || [])], ways: [...(props.picked?.ways || [])] })
function toggle(kind, id) {
  const cur = pickNow(), list = kind === 'task' ? cur.tasks : cur.ways
  const i = list.indexOf(id)
  if (i >= 0) list.splice(i, 1); else list.push(id)
  emit('pick', cur)
}
// the tasks whose centre is in the box join the pick, then the ways between picked tasks (to 「끝」 when it is in the box too)
function pickBox(b) {
  const inBox = (n) => n.x >= b.x0 && n.x <= b.x1 && n.y >= b.y0 && n.y <= b.y1
  const hit = nodes.value.filter((n) => n.t && inBox(n)).map((n) => n.key)
  if (!hit.length) return
  const cur = pickNow()
  const tasks = new Set([...cur.tasks, ...hit])
  const endIn = nodes.value.some((n) => n.end && inBox(n))
  const ways = new Set(cur.ways)
  for (const e of props.edges) if (isWay(e) && tasks.has(e.from) && (tasks.has(e.to) || (e.to === END && endIn))) ways.add(edgeId(e))
  emit('pick', { tasks: [...tasks], ways: [...ways] })
}
function onTask(ev, key) {
  if (moved) { moved = false; return }
  if (toggleKey(ev)) return toggle('task', key)
  emit('select', { kind: 'task', id: key })
}
// in the events view a line into or out of an event opens that event (its panel lists what it opens and what raises it)
function pickEdge(x, ev) {
  if (x.e.event) return choose('event', x.e.event)
  if (moved) { moved = false; return }
  if (ev && toggleKey(ev) && isWay(x.e)) return toggle('way', x.id)
  emit('select', { kind: 'edge', id: x.id })
}
const evTitle = (n) => `${n.ev.ev.name} · ${n.ev.ev.n || 0}번${n.ev.and ? ' · 여러 일이 함께 열려요' : ''}`
</script>

<template>
  <div class="mg">
  <div ref="vp" class="vp" :class="{ dragging: moved, boxing: !!band, side: side && dir === 'LR' }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointerleave="up" @pointercancel="cancel" @wheel="onWheel" @click.self="choose(null)">
    <svg v-if="L.width" class="map" :class="{ only: onlyNotes }" :width="L.width * zoom" :height="L.height * zoom" :viewBox="`0 0 ${L.width} ${L.height}`" role="img" aria-label="회사 프로세스 지도" @click.self="choose(null)">
      <defs><clipPath :id="clipId"><rect x="4" y="0" :width="W - 8" height="90" /></clipPath></defs>
      <g class="edges">
        <g v-for="x in drawn" :key="x.id" class="edge" :class="x.cls" :data-way="x.cls.picked ? 'picked' : null" @click.stop="pickEdge(x, $event)">
          <title>{{ x.title }}</title>
          <path class="hit" :d="x.d" />
          <path v-if="x.cls.picked" class="halo" :d="x.d" :stroke-width="x.w + 7" />
          <path class="line" :d="x.d" :stroke-width="x.w" />
          <path v-if="x.tip" class="tip" :d="`M0,0 L${-x.tl},${-x.tl * 0.55} L${-x.tl * 0.78},0 L${-x.tl},${x.tl * 0.55} Z`" :transform="`translate(${x.tip.x},${x.tip.y}) rotate(${x.tip.a})`" />
        </g>
      </g>
      <g class="nodes">
        <g v-for="n in nodes.filter((x) => x.ev)" :key="n.key" class="node ev" :class="[n.ev.ev.kind, { sel: selKey === n.key, and: n.ev.and }]"
          :transform="`translate(${n.x0},${n.y0})`" tabindex="0" role="button" data-testid="onto-event-node" :data-event="n.ev.ev.key"
          @click.stop="choose('event', n.ev.ev.key)" @keydown.enter.prevent="choose('event', n.ev.ev.key)">
          <title>{{ evTitle(n) }}</title>
          <g :transform="`translate(${n.w / 2},${n.h / 2})`">
            <circle class="hit" :r="R + 6" />
            <circle class="disc" :r="R" />
            <path v-if="n.ev.ev.kind === 'mail'" class="glyph" d="M-6,-4.5 H6 V4.5 H-6 Z M-6,-4.5 L0,0.8 L6,-4.5" />
            <path v-else-if="n.ev.ev.kind === 'message'" class="glyph" d="M-6,-5 H6 V3 H-1 L-4.5,6 V3 H-6 Z" />
            <path v-else-if="n.ev.ev.kind === 'link'" class="glyph" d="M-1.5,1.5 L1.5,-1.5 M-1,-3.5 L1,-5.5 A2.8,2.8 0 0 1 5,-1.5 L3,0.5 M1,3.5 L-1,5.5 A2.8,2.8 0 0 1 -5,1.5 L-3,-0.5" />
            <path v-else-if="n.ev.ev.kind === 'time' || n.ev.ev.kind === 'timer'" class="glyph" d="M0,-5.5 A5.5,5.5 0 1 1 -0.01,-5.5 M0,-3 V0 L2.5,1.5" />
            <path v-else-if="n.ev.ev.kind === 'done'" class="glyph" d="M-4.5,0 L-1.2,3.2 L4.8,-3.4" />
            <path v-else class="glyph" d="M-4.5,-6 H1.5 L4.5,-3 V6 H-4.5 Z M1.5,-6 V-3 H4.5" />
          </g>
          <text v-if="dir === 'LR'" class="evl" text-anchor="middle"><tspan v-for="(l, i) in n.lines" :key="i" :x="n.w / 2" :y="n.h / 2 + R + 13 + i * 13">{{ l }}</tspan></text>
          <text v-else class="evl"><tspan v-for="(l, i) in n.lines" :key="i" :x="n.w / 2 + R + 7" :y="n.h / 2 + 4 - ((n.lines.length - 1) * 13) / 2 + i * 13">{{ l }}</tspan></text>
        </g>
        <g v-for="n in nodes.filter((x) => !x.ev)" :key="n.key" class="node" :class="n.end ? { end: true, nd: onlyNotes } : n.cls"
          :transform="`translate(${n.x0},${n.y0})`" :tabindex="n.end ? -1 : 0" :role="n.end ? null : 'button'" :data-task="n.end ? null : n.key" :data-picked="n.picked ? 'true' : null"
          @click.stop="!n.end && onTask($event, n.key)" @keydown.enter.prevent="!n.end && onTask($event, n.key)">
          <title v-if="!n.end">{{ n.tip }}</title>
          <template v-if="n.end">
            <rect :width="n.w" :height="n.h" :rx="n.h / 2" />
            <text class="endt" :x="n.w / 2" :y="n.h / 2 + 5" text-anchor="middle">끝</text>
          </template>
          <template v-else>
            <g v-if="n.picked" class="pk"><rect x="-4.5" y="-4.5" :width="n.w + 9" :height="n.h + 9" rx="16" /></g>
            <rect :width="n.w" :height="n.h" rx="13" />
            <text class="nm" :clip-path="`url(#${clipId})`"><tspan v-for="(l, i) in n.lines" :key="i" x="11" :y="22 + i * 17">{{ l }}</tspan></text>
            <!-- 걷어냄(단계 가르기) · 미리 보기에서 뺌: 이름에 줄 -->
            <template v-if="n.strike"><line v-for="(l, i) in n.lines" :key="`x${i}`" class="strike" x1="10" :x2="Math.min(n.w - 10, 12 + textW(l, NAME))" :y1="17 + i * 17" :y2="17 + i * 17" /></template>
            <!-- 단계 규칙: 꼭 하는 단계는 자물쇠 -->
            <path v-if="marks.get(n.key) === 'req'" class="lock" :transform="`translate(${n.w - 21},6)`" d="M3 6V4a3 3 0 0 1 6 0v2h1.5v8h-9V6zm1.5 0h3V4a1.5 1.5 0 0 0-3 0z" />
            <text class="sm" x="11" :y="n.h - 11" :clip-path="`url(#${clipId})`">{{ n.foot.role }}<tspan v-if="n.foot.ai" class="ai">{{ n.foot.ai }}</tspan></text>
            <!-- 사람이 정했어요: 건수 앞에 사람-확인 -->
            <g v-if="n.foot.gx != null" class="dec" :transform="`translate(${n.foot.gx},${n.h - 21.5})`"><circle cx="3.6" cy="2.8" r="2.3" /><path d="M0.5,10.2 C0.5,7.1 2,5.7 3.6,5.7 C5.2,5.7 6.7,7.1 6.7,10.2" /><path d="M8,6.6 L9.8,8.5 L13,4.6" /></g>
            <text class="sm ct" :x="n.w - 11" :y="n.h - 11" text-anchor="end">{{ n.foot.ct }}</text>
            <!-- 미리 보기: 더함 · 뺌 · 바뀜 (위 오른쪽) -->
            <g v-if="n.dtag" class="dtag" :transform="`translate(${n.w - n.dtag.w - 6},-12)`"><rect :width="n.dtag.w" height="18" rx="9" /><text :x="n.dtag.w / 2" y="13" text-anchor="middle">{{ n.dtag.text }}</text></g>
            <!-- 흐름 분석: 지금 쌓인 할 일 · 병목 (위 오른쪽) -->
            <g v-if="n.btag" class="btag" :class="n.btag.kind" :transform="`translate(${n.w - n.btag.w - 6},-12)`" data-testid="onto-flow-badge" :data-kind="n.btag.kind"><rect :width="n.btag.w" height="18" rx="9" /><text :x="n.btag.w / 2" y="13" text-anchor="middle">{{ n.btag.text }}</text></g>
            <!-- 의견 N · 해소 필요 (아래 오른쪽, 테두리에 걸쳐) -->
            <g v-if="n.ntag" class="ntag" :class="{ conf: n.ntag.conflict }" :transform="`translate(${n.w - n.ntag.w - 8},${n.h - 6})`"><rect :width="n.ntag.w" height="16" rx="8" /><text :x="n.ntag.w / 2" y="11.5" text-anchor="middle">{{ n.ntag.text }}</text></g>
          </template>
        </g>
        <g v-for="n in nodes.filter((x) => x.share)" :key="`s-${n.key}`" class="etag" :class="{ nd: n.cls?.nd }" :transform="`translate(${entryTag(n).x},${entryTag(n).y})`">
          <rect :width="entryTag(n).w" height="18" rx="9" />
          <path d="M8,5 L13,9 L8,13 Z" />
          <text x="16" y="13">{{ entryTag(n).text }}</text>
        </g>
      </g>
      <g class="labels">
        <g v-for="x in drawn" :key="`l-${x.id}`" class="lbl" :class="x.cls" :transform="`translate(${x.label.x},${x.label.y})`" tabindex="0" role="button"
          @click.stop="pickEdge(x, $event)" @keydown.enter.prevent="pickEdge(x, $event)">
          <title>{{ x.title }}</title>
          <rect :x="-x.label.w / 2" y="-9" :width="x.label.w" height="18" rx="9" />
          <g v-for="(ic, i) in x.ics" :key="ic" :class="ic" :transform="`translate(${-x.label.w / 2 + 6 + i * 13},${ic === 'pin' ? -6 : -5.4})`">
            <path v-if="ic === 'pin'" d="M3.2,0.6 H8.8 L8,4.6 L10.2,6.8 H1.8 L4,4.6 Z M6,6.8 V11.6" />
            <template v-else><circle cx="3.6" cy="2.8" r="2.3" /><path d="M0.5,10.2 C0.5,7.1 2,5.7 3.6,5.7 C5.2,5.7 6.7,7.1 6.7,10.2" /><path d="M8,6.6 L9.8,8.5 L13,4.6" /></template>
          </g>
          <text :x="(x.ics.length * 13 - (x.note && x.label.short ? BUBBLE : 0)) / 2" y="4" text-anchor="middle">{{ x.head }}<tspan v-if="x.cls.stale && !x.label.short" class="hint"> · 은퇴 후보</tspan><tspan v-if="x.cls.and" class="and"> · {{ SPLIT_KO.and }}</tspan><tspan v-if="people(x.e)" class="ppl"> · {{ people(x.e) }}</tspan><tspan v-if="x.note && !x.label.short" class="note" :class="{ conf: x.note.conflict }"> · {{ x.note.text }}</tspan></text>
          <!-- 짧은 꼴: 의견 수 · 해소 필요(!)를 작은 원으로 -->
          <g v-if="x.note && x.label.short" class="nb" :class="{ conf: x.note.conflict }" :transform="`translate(${x.label.w / 2 - 10},0)`"><circle r="7" /><text y="3.3" text-anchor="middle">{{ x.note.conflict ? '!' : x.note.n }}</text></g>
        </g>
      </g>
      <rect v-if="band" class="band" :x="band.x0" :y="band.y0" :width="band.x1 - band.x0" :height="band.y1 - band.y0" rx="4" />
    </svg>
  </div>
  <div class="zoom glass-thin">
    <button aria-label="작게" @click="step(1 / 1.2)">−</button>
    <button class="fit" :class="{ on: fitMode === 'all' }" title="지도 전체를 한 화면에" @click="fit">맞춤</button>
    <button aria-label="크게" @click="step(1.2)">+</button>
  </div>
  </div>
</template>

<style scoped>
.mg { position: absolute; inset: 0; }
.vp { position: absolute; inset: 0; overflow: auto; display: flex; padding: 6px 6px 52px; cursor: grab; scrollbar-width: thin; touch-action: pan-x pan-y; }
.vp.dragging { cursor: grabbing; }
.vp.side { padding-right: 366px; }
.map { margin: auto; flex: none; display: block; user-select: none; -webkit-user-select: none; }
.map { --edge: color-mix(in srgb, var(--text-primary) 52%, transparent); --stale: #F0883E; --sel: #e0613f; }
/* 사람이 정함(청록) · 고른 것(남색) · 해소 필요(주홍) · 미리 보기 더함(초록) · 뺌(빨강) · 바뀜(노랑) — MapLegend.vue 와 같은 색 */
.map { --dec: #17979a; --pick: #5468ff; --conf: #e8590c; --d-add: #2f9e6e; --d-rm: var(--color-error); --d-ch: #c98a0c; }
.vp { user-select: none; -webkit-user-select: none; }
.vp.boxing { cursor: crosshair; }

.edge { cursor: pointer; }
.edge .hit { fill: none; stroke: transparent; stroke-width: 14; }
.edge .line { fill: none; stroke: var(--edge); stroke-linecap: round; transition: stroke .2s, opacity .2s; }
.edge .tip { fill: var(--edge); transition: fill .2s; }
.edge.thin .line, .edge.thin .tip { opacity: .45; }
.edge.stale .line { stroke: var(--stale); stroke-dasharray: 7 5; stroke-linecap: butt; }
.edge.stale .tip { fill: var(--stale); }
.edge.retired .line { stroke: var(--text-tertiary); stroke-dasharray: 3 5; stroke-linecap: butt; }
.edge.retired .tip { fill: var(--text-tertiary); }
.edge:hover .line, .edge.near .line { stroke: var(--text-primary); opacity: 1; }
.edge:hover .tip, .edge.near .tip { fill: var(--text-primary); opacity: 1; }
.edge.sel .line { stroke: var(--sel); opacity: 1; }
.edge.sel .tip { fill: var(--sel); opacity: 1; }

.node { cursor: pointer; outline: none; }
.node:focus-visible > rect { stroke: var(--sel); stroke-width: 2; }
.node > rect { fill: var(--regular-solid-bg); stroke: var(--hairline); stroke-width: 1; transition: stroke .2s; }
.node.entry > rect { stroke: color-mix(in srgb, var(--text-primary) 28%, transparent); }
.node:hover > rect { stroke: var(--text-secondary); }
.node.sel > rect { stroke: var(--sel); stroke-width: 2; }
.node.cand { opacity: .5; }
.node.dim { opacity: .28; }
.node.mk-high > rect { fill: color-mix(in srgb, #2f9e6e 34%, var(--regular-solid-bg)); stroke: #2f9e6e; stroke-width: 2.5; }
.node.mk-mid > rect { fill: color-mix(in srgb, #2f9e6e 14%, var(--regular-solid-bg)); stroke: #2f9e6e; stroke-width: 1.5; stroke-dasharray: 5 3; }
.node.mk-human > rect { fill: color-mix(in srgb, #d9822b 26%, var(--regular-solid-bg)); stroke: #d9822b; stroke-width: 2.5; }
.node.cand > rect { stroke-dasharray: 4 3; stroke: var(--text-secondary); }
/* 단계 가르기(프로세스 다듬기 ②): 꼭 하는 관문 = 주황 굵게 · 사람이 꼭 = 주황(mk-human) · AI가 맡음 = 초록 · 걷어냄 = 회색 줄 · 건너뛰었지만 해야 함 = 주황 점선 */
.node.mk-gate > rect { fill: color-mix(in srgb, #d9822b 40%, var(--regular-solid-bg)); stroke: #d9822b; stroke-width: 4.5; }
.node.mk-gate .nm { font-weight: 800; }
.node.mk-ai > rect { fill: color-mix(in srgb, #2f9e6e 30%, var(--regular-solid-bg)); stroke: #2f9e6e; stroke-width: 2.5; }
.node.mk-drop > rect { fill: color-mix(in srgb, var(--text-primary) 5%, var(--regular-solid-bg)); stroke: var(--text-tertiary); stroke-width: 1.5; }
.node.mk-drop .nm, .node.mk-drop .sm { fill: var(--text-tertiary); }
.node.mk-skipped > rect { fill: color-mix(in srgb, #d9822b 10%, var(--regular-solid-bg)); stroke: #d9822b; stroke-width: 2.2; stroke-dasharray: 6 4; }
.node .strike { stroke: var(--text-secondary); stroke-width: 1.6; stroke-linecap: round; pointer-events: none; }
/* 단계 규칙(steprule): 꼭 하는 단계 = 보라 굵게 + 자물쇠 · 해도 되는 단계 = 파랑 점선 · 사안에 따라 = 파랑 잔 점선 */
.node.mk-req > rect { fill: color-mix(in srgb, #7a4fd0 16%, var(--regular-solid-bg)); stroke: #7a4fd0; stroke-width: 3; }
.node .lock { fill: #7a4fd0; pointer-events: none; }
.node.mk-opt > rect { fill: color-mix(in srgb, #2b7fbf 8%, var(--regular-solid-bg)); stroke: #2b7fbf; stroke-width: 2; stroke-dasharray: 6 4; }
.node.mk-heat1 > rect { fill: color-mix(in srgb, #e8590c 9%, var(--regular-solid-bg)); stroke: #e8590c; stroke-width: 1.6; }
.node.mk-heat2 > rect { fill: color-mix(in srgb, #e8590c 20%, var(--regular-solid-bg)); stroke: #e8590c; stroke-width: 2.2; }
.node.mk-heat3 > rect { fill: color-mix(in srgb, #e8590c 32%, var(--regular-solid-bg)); stroke: #e8590c; stroke-width: 2.8; }
.node.mk-bott > rect { fill: color-mix(in srgb, #d6336c 30%, var(--regular-solid-bg)); stroke: #d6336c; stroke-width: 4.5; }
.node.mk-bott .nm { font-weight: 800; }
.node.mk-agent > rect { fill: color-mix(in srgb, #2f9e6e 14%, var(--regular-solid-bg)); stroke: #2f9e6e; stroke-width: 1.8; stroke-dasharray: 5 3; }
.node.mk-out > rect { fill: color-mix(in srgb, var(--text-primary) 4%, var(--regular-solid-bg)); stroke: var(--text-tertiary); stroke-width: 1.5; stroke-dasharray: 2 3; }
.node.mk-calm > rect { stroke-width: 1.2; }
.edge.hot .line { stroke: #d6336c; opacity: 1; }
.edge.hot .tip { fill: #d6336c; opacity: 1; }
.edge.cool { opacity: .32; }
.lbl.cool { opacity: .45; }
.lbl.hot rect { stroke: #d6336c; stroke-width: 1.5; }
.btag { pointer-events: none; }
.btag rect { fill: #e8590c; }
.btag.bott rect { fill: #d6336c; }
.btag.agent rect { fill: #2f9e6e; }
.btag.out rect { fill: var(--text-tertiary); }
.btag text { font-size: 10.5px; font-weight: 700; fill: #fff; }
.node.mk-cond > rect { stroke: #2b7fbf; stroke-width: 2; stroke-dasharray: 1.5 3; stroke-linecap: round; }
/* 프로세스 다듬기 ①: 더한 일 · 관계는 파랑 점선, 뺀 것(찾은 대로 쪽)은 빨강 점선 */
.node.added > rect { stroke: var(--color-info); stroke-width: 2.2; stroke-dasharray: 6 3; }
.node.added .ct { fill: var(--color-info); font-weight: 600; }
.node.removed { opacity: .62; }
.node.removed > rect { stroke: var(--color-error); stroke-width: 1.6; stroke-dasharray: 3 3; }
.node.removed .strike { stroke: var(--color-error); }
.edge.added .line { stroke: var(--color-info); stroke-dasharray: 7 4; stroke-linecap: butt; }
.edge.added .tip { fill: var(--color-info); }
.edge.removed .line { stroke: var(--color-error); stroke-dasharray: 3 4; stroke-linecap: butt; opacity: .75; }
.edge.removed .tip { fill: var(--color-error); opacity: .75; }
/* a coloured node keeps its colour when picked: a glow shows the pick */
.node.sel[class*='mk-'] > rect, .node.sel.added > rect, .node.sel.removed > rect { filter: drop-shadow(0 0 3px var(--sel)) drop-shadow(0 0 1px var(--sel)); }
.node.end { cursor: default; }
.node.end > rect { fill: var(--ink); stroke: none; }
.endt { fill: var(--text-primary-on); font-size: 13.5px; font-weight: 600; }
.nm { fill: var(--text-primary); font-size: 14px; font-weight: 600; letter-spacing: -0.02em; }
.sm { fill: var(--text-secondary); font-size: 11.5px; }
.ct { font-variant-numeric: tabular-nums; }
.etag { pointer-events: none; }
.etag rect { fill: var(--color-success); }
.etag path { fill: #0b2a17; }
.etag text { fill: #0b2a17; font-size: 10.5px; font-weight: 600; }

.node.habit > rect { stroke-dasharray: 5 3; stroke: color-mix(in srgb, var(--color-info) 60%, transparent); }
.node.ev { --evc: var(--text-secondary); }
.node.ev.mail { --evc: var(--color-info); }
.node.ev.artifact { --evc: var(--color-success); }
.node.ev.message { --evc: #a78bfa; }
.node.ev .hit { fill: transparent; }
.node.ev .disc { fill: var(--regular-solid-bg); stroke: var(--evc); stroke-width: 1.6; transition: stroke .2s; }
.node.ev .glyph { fill: none; stroke: var(--evc); stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
.node.ev:hover .disc { stroke: var(--text-primary); }
.node.ev:focus-visible .disc, .node.ev.sel .disc { stroke: var(--sel); stroke-width: 2.4; }
.node.ev .evl { fill: var(--text-secondary); font-size: 11px; font-weight: 500; letter-spacing: -0.01em; }
.node.ev.sel .evl { fill: var(--text-primary); }
.lbl .and { fill: var(--color-info); font-weight: 600; }
.lbl .ppl { fill: var(--text-secondary); }

.lbl { cursor: pointer; outline: none; }
.lbl:focus-visible rect { stroke: var(--sel); stroke-width: 1.5; }
.lbl rect { fill: var(--regular-solid-bg); stroke: var(--hairline); }
.lbl text { fill: var(--text-primary); font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums; }
.lbl.thin text { fill: var(--text-secondary); }
.lbl.stale rect { stroke: var(--stale); }
.lbl .hint, .lbl.stale text { fill: var(--stale); }
.lbl.retired text { fill: var(--text-tertiary); }
.lbl.sel rect { stroke: var(--sel); stroke-width: 1.5; }
.lbl.added rect { stroke: var(--color-info); }
.lbl.added text { fill: var(--color-info); }
.lbl.removed rect { stroke: var(--color-error); }
.lbl.removed text { fill: var(--color-error); text-decoration: line-through; }
.pin path { fill: none; stroke: var(--text-primary); stroke-width: 1.4; stroke-linejoin: round; }

/* 출처: 사람이 정했어요 = 사람-확인(청록) · 정했지만 아직 본 적 없어요 = 점선 · 흐리게 + 「정함」 · 「아직 0건」 */
.dec circle, .dec path { fill: none; stroke: var(--dec); stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
.node .ai { fill: var(--color-info); font-weight: 600; }
.node.unseen:not([class*='mk-']) > rect { stroke: color-mix(in srgb, var(--text-primary) 38%, transparent); stroke-width: 1.4; stroke-dasharray: 5 3.5; fill: color-mix(in srgb, var(--regular-solid-bg) 70%, transparent); }
.node.unseen .nm { opacity: .72; }
.node.unseen .ct { fill: var(--dec); }
.node.unseen.sel > rect { stroke: var(--sel); stroke-width: 2; }
.edge.unseen .line { stroke-dasharray: 6 4; stroke-linecap: butt; opacity: .55; }
.edge.unseen .tip { opacity: .55; }
.edge.unseen:hover .line, .edge.unseen.near .line, .edge.unseen.sel .line { opacity: 1; }
.lbl.unseen rect { stroke: color-mix(in srgb, var(--dec) 70%, transparent); stroke-dasharray: 3 2.5; }
.lbl.unseen text { fill: var(--dec); font-weight: 600; }
.lbl.unseen.sel rect { stroke: var(--sel); stroke-dasharray: none; }

/* 미리 보기: 더함 = 초록 · 뺌 = 빨강 점선 + 이름에 줄 · 바뀜 = 노랑 (출처 표시 위에 그린다) */
.node.df-add > rect { stroke: var(--d-add); stroke-width: 2.4; fill: color-mix(in srgb, var(--d-add) 10%, var(--regular-solid-bg)); }
.node.df-remove { opacity: .7; }
.node.df-remove > rect { stroke: var(--d-rm); stroke-width: 1.8; stroke-dasharray: 4 3; }
.node.df-remove .strike { stroke: var(--d-rm); }
.node.df-change > rect { stroke: var(--d-ch); stroke-width: 2.4; fill: color-mix(in srgb, var(--d-ch) 10%, var(--regular-solid-bg)); }
.node.sel[class*='df-'] > rect { filter: drop-shadow(0 0 3px var(--sel)) drop-shadow(0 0 1px var(--sel)); }
.dtag { pointer-events: none; }
.dtag text { font-size: 10.5px; font-weight: 700; fill: #fff; }
.df-add .dtag rect { fill: var(--d-add); }
.df-remove .dtag rect { fill: var(--d-rm); }
.df-change .dtag rect { fill: var(--d-ch); }
.edge.df-add .line { stroke: var(--d-add); opacity: 1; }
.edge.df-add .tip { fill: var(--d-add); opacity: 1; }
.edge.df-remove .line { stroke: var(--d-rm); stroke-dasharray: 3 4; stroke-linecap: butt; opacity: .8; }
.edge.df-remove .tip { fill: var(--d-rm); opacity: .8; }
.edge.df-change .line { stroke: var(--d-ch); opacity: 1; }
.edge.df-change .tip { fill: var(--d-ch); opacity: 1; }
.lbl.df-add rect { stroke: var(--d-add); stroke-width: 1.4; }
.lbl.df-add text { fill: var(--d-add); font-weight: 600; }
.lbl.df-remove rect { stroke: var(--d-rm); stroke-dasharray: 3 2; }
.lbl.df-remove text { fill: var(--d-rm); font-weight: 600; }
.lbl.df-change rect { stroke: var(--d-ch); stroke-width: 1.4; }
.lbl.df-change text { fill: var(--d-ch); font-weight: 600; }

/* 여러 개 고르기: 바깥 테두리(고른 것) — 누른 것(sel)과 따로 */
.pk rect { fill: color-mix(in srgb, var(--pick) 12%, transparent); stroke: var(--pick); stroke-width: 2.2; pointer-events: none; }
.edge .halo { fill: none; stroke: var(--pick); stroke-linecap: round; opacity: .32; pointer-events: none; }
.lbl.picked rect { stroke: var(--pick); stroke-width: 2; }
.band { fill: color-mix(in srgb, var(--pick) 10%, transparent); stroke: var(--pick); stroke-width: 1.2; stroke-dasharray: 5 3; pointer-events: none; }

/* 의견: 조용한 「의견 N」 · 엇갈리면 「해소 필요」(주홍) · 해소 필요만이면 나머지를 흐리게 */
.ntag { pointer-events: none; }
.ntag rect { fill: var(--regular-solid-bg); stroke: color-mix(in srgb, var(--text-primary) 22%, transparent); }
.ntag text { font-size: 10px; font-weight: 500; fill: var(--text-secondary); }
.ntag.conf rect { fill: var(--conf); stroke: none; }
.ntag.conf text { fill: #fff; font-weight: 700; }
.lbl .note { fill: var(--text-secondary); font-weight: 500; }
.lbl .note.conf { fill: var(--conf); font-weight: 700; }
.lbl.nconf rect { stroke: var(--conf); stroke-width: 1.5; }
.lbl .nb circle { fill: none; stroke: color-mix(in srgb, var(--text-primary) 35%, transparent); stroke-width: 1; }
.lbl .nb text { font-size: 9.5px; font-weight: 700; fill: var(--text-secondary); }
.lbl .nb.conf circle { fill: var(--conf); stroke: none; }
.lbl .nb.conf text { fill: #fff; }
.node.nd { opacity: .25; }
.edge.nd .line, .edge.nd .tip { opacity: .18; }
.edge.nd .halo { opacity: .12; }
.lbl.nd, .etag.nd { opacity: .3; }

.zoom { position: absolute; z-index: 2; right: 12px; bottom: 12px; display: flex; gap: 2px; padding: 3px; border-radius: 9999px; }
.zoom button { min-width: 34px; height: 32px; border-radius: 9999px; font-size: 17px; color: var(--text-secondary); }
.zoom button.fit { font-size: 13px; padding: 0 10px; }
.zoom button:hover, .zoom button.on { color: var(--text-primary); background: var(--button-bg); }
</style>
