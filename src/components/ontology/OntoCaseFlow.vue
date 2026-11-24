<script setup>
// 건의 흐름도(server lib/ontology/mapengine.js flowOf): 남겨 둔 정의 없이, 볼 때마다 지도에서 그린다 — 지금 지도(또는 건을 시작한 날의 지도에
// 고정했으면 그 지도)를 건의 시작 일부터 펼치고, 단계마다 이 건이 닿은 상태(끝남 · 하는 중 · 사람 차례 · 기다림 · 건너뜀 · 다음 · 닫힘)를 칠한다.
// 그림은 BPMN(server lib/ontology/casebpmn.js — 스냅샷이 프로세스 정의를 만드는 규칙과 같은 레인 · 갈림 · 합류, 화면에서만 만들고 저장하지 않음)을
// 프로세스 정의와 같은 BpmnView 로 보인다: 좁은 곳(지도의 옆 패널 · 휴대폰)은 위에서 아래로, 넓은 곳과 「크게 보기」는 왼쪽에서 오른쪽으로. 새로 읽을 때 XML 이
// 그대로면 다시 그리지 않고 상태만 다시 칠한다. BPMN 이 없거나 그리지 못하면 예전처럼 지도와 같은 계층 배치(layout.js)로 그린다.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { api } from '../../api.js'
import BpmnView from '../BpmnView.vue'
import { layoutGraph } from './layout.js'
import { END, pct, dateTimeKo } from './fmt.js'
import { flowDir } from './caseView.js'

const props = defineProps({ caseId: { type: String, required: true }, tick: { type: Number, default: 0 } })
const flow = ref(null)
const err = ref('')
let timer = 0, alive = true
async function load() {
  try { flow.value = await api(`/ontology/cases/${encodeURIComponent(props.caseId)}/flow`); err.value = '' } catch (e) { err.value = e.message }
  clearTimeout(timer)
  if (alive) timer = setTimeout(load, flow.value?.status === 'running' ? 6000 : 30000)
}
watch(() => [props.caseId, props.tick], load, { immediate: true })
// a narrow place (the map's side panel, a sheet on a phone) draws the flow top to bottom; a wide one left to right
const host = ref(null)
const boxW = ref(0)
let ro = null
onMounted(() => { boxW.value = host.value?.clientWidth || 0; ro = new ResizeObserver(([e]) => { boxW.value = Math.round(e.contentRect.width) }); if (host.value) ro.observe(host.value) })
onBeforeUnmount(() => { alive = false; clearTimeout(timer); ro?.disconnect() })
const dir = computed(() => flowDir(boxW.value))
// 「크게 보기」 in the heading of a top-to-bottom drawing: the whole flowchart left to right over the page (BpmnView's own — its button
// sits at the box's bottom, out of sight under a tall drawing in the map's side panel or on a phone)
const bpmnRef = ref(null)
const openBig = () => bpmnRef.value?.toggleBig()

const STATE_KO = { done: '끝남', running: '하는 중', person: '사람 차례', waiting: '기다림', skipped: '건너뜀', next: '다음', closed: '닫힘' }
const title = computed(() => (flow.value?.pinned ? '시작한 날의 지도로 그린 흐름' : '지금 지도로 그린 흐름'))
const tip = (n) => `${n.key === END ? '끝' : n.key}${n.role ? ` · ${n.role}` : ''}${n.state ? ` · ${STATE_KO[n.state] || n.state}` : ''}${n.runs > 1 ? ` · ${n.runs}번 함` : ''}${n.inMap === false ? ' · 이 지도로 펼친 흐름 밖(옮기거나 되감아 간 일)' : ''}`

// ---------- BPMN ----------
const bp = computed(() => (flow.value?.bpmn?.xml ? flow.value.bpmn : null))
// the place decides the direction once it is measured (top to bottom until then: the side panel is the usual place)
const xml = computed(() => (bp.value ? (dir.value === 'LR' && bp.value.xmlWide) || bp.value.xml : null))
const failed = ref('')
const showBpmn = computed(() => !!xml.value && failed.value !== xml.value)
const idOf = (k) => (k === END ? 'end' : bp.value?.ids?.[k])
// each step's drawing carries what the old drawing's nodes did (recordings and e2e find steps by these) and a hover title
const attrs = computed(() => {
  const out = {}
  for (const n of flow.value?.nodes || []) {
    const id = idOf(n.key)
    if (id) out[id] = { 'data-testid': 'onto-case-flow-node', 'data-task': n.key, 'data-state': n.state || '', title: tip(n) }
  }
  return out
})
const markers = computed(() => bp.value?.states || {})
// tall top to bottom (the panel scrolls; the wheel stays the page's), at most a usual card's height left to right
const bpmnHeight = computed(() => (dir.value === 'TB' ? 1400 : 560))
const has = (s) => (flow.value?.nodes || []).some((n) => n.state === s)
const legend = computed(() => Object.keys(STATE_KO).filter((s) => ['done', 'running', 'waiting', 'skipped', 'next'].includes(s) || has(s)))
const ways = computed(() => new Set(Object.values(markers.value)))

// ---------- the drawing without BPMN (as before) ----------
const FS = 12.5
const em = (c) => (/[ㄱ-힝]/.test(c) ? 1 : /[A-Z0-9]/.test(c) ? 0.62 : 0.55)
const textW = (s) => [...String(s)].reduce((a, c) => a + em(c) * FS, 0)
const nodeW = (n) => (n.key === END ? 30 : Math.ceil(Math.min(170, Math.max(64, textW(n.key) + 24))))
const L = computed(() => {
  const f = flow.value
  if (showBpmn.value || !f?.nodes?.length) return null
  return layoutGraph({
    nodes: f.nodes.map((n) => ({ key: n.key, w: nodeW(n), h: n.key === END ? 30 : 38 })),
    edges: f.flows.map((e, i) => ({ id: `${i}`, from: e.from, to: e.to, p: e.taken ? 1 + (e.p || 0) : e.p || 0 })),
    entries: [f.entry], dir: dir.value, gapRank: dir.value === 'TB' ? 30 : 46, gapOrder: dir.value === 'TB' ? 18 : 22, margin: 14,
    labelSize: () => ({ w: 34, h: 16 }),
  })
})
const nodes = computed(() => (L.value?.nodes || []).map((n) => ({ ...n, ...(flow.value.nodes.find((x) => x.key === n.key) || {}) })))
const edges = computed(() => (L.value?.edges || []).map((g) => ({ ...g, e: flow.value.flows[Number(g.id)] })))
// a way a person decided in 다듬기 has no past cases (p 0): no share to show
const label = (e) => (e.and ? '함께' : e.skipped || !e.p ? '' : pct(e.p))
</script>

<template>
  <div ref="host" class="cf" data-testid="onto-case-flow" :data-pinned="flow?.pinned ? '1' : '0'" :data-nodes="flow?.nodes?.length || 0" :data-bpmn="showBpmn ? '1' : null" :data-dir="dir">
    <div class="hd">
      <b data-testid="onto-case-flow-title">{{ title }}</b>
      <small v-if="flow" class="when">{{ flow.pinned ? `${dateTimeKo(flow.mapAt)} 지도` : '볼 때마다 지도에서 다시 그려요' }}</small>
      <!-- (top to bottom — the map's side panel, a phone — the drawing is tall and the box's own buttons sit far below; left to right it fits) -->
      <button v-if="showBpmn && dir === 'TB'" class="bigbtn press" data-testid="onto-case-flow-big" @click="openBig">크게 보기</button>
    </div>
    <p v-if="!flow && !err" class="muted pulse">흐름을 그리는 중…</p>
    <div v-if="showBpmn" class="dg">
      <BpmnView ref="bpmnRef" :xml="xml" :big-xml="bp.xmlWide || null" :markers="markers" :attrs="attrs" :height="bpmnHeight" :wheel="false" empty-text="흐름도를 그리지 못했어요." @failed="failed = xml" />
    </div>
    <div v-else-if="L" class="box scroll">
      <svg :width="L.width" :height="L.height" :data-dir="dir" :viewBox="`0 0 ${L.width} ${L.height}`" role="img" :aria-label="title">
        <defs>
          <marker id="cf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="tip" /></marker>
          <marker id="cf-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="tip on" /></marker>
        </defs>
        <g v-for="g in edges" :key="g.id" class="edge" :class="{ taken: g.e.taken, and: g.e.and, back: g.back, extra: g.e.extra, skp: g.e.skipped }" :data-from="g.e.from" :data-to="g.e.to" :data-taken="g.e.taken ? '1' : '0'">
          <title>{{ g.e.from }} → {{ g.e.to === END ? '끝' : g.e.to }}{{ g.e.p ? ` · ${pct(g.e.p)}` : '' }}{{ g.e.cond ? ` · ${g.e.cond}` : '' }}{{ g.e.taken ? ' · 이 건이 간 길' : '' }}{{ g.e.extra ? ' · 지금 지도에는 없는 길' : '' }}{{ g.e.skipped ? ' · 이 건은 여기서부터 시작해 건너뜀' : '' }}</title>
          <path :d="g.d" :marker-end="g.e.taken ? 'url(#cf-arrow-on)' : 'url(#cf-arrow)'" />
          <text v-if="label(g.e)" :x="g.label.x" :y="g.label.y + 4" text-anchor="middle" class="lbl">{{ label(g.e) }}</text>
        </g>
        <g v-for="n in nodes" :key="n.key" class="node" :class="[n.state || 'none', { end: n.key === END, entry: n.entry, off: n.inMap === false }]" data-testid="onto-case-flow-node" :data-task="n.key" :data-state="n.state || ''">
          <title>{{ tip(n) }}</title>
          <circle v-if="n.key === END" :cx="n.x" :cy="n.y" r="12" />
          <rect v-else :x="n.x - n.w / 2" :y="n.y - n.h / 2" :width="n.w" :height="n.h" rx="11" />
          <text :x="n.x" :y="n.y + 4.5" text-anchor="middle">{{ n.key === END ? '끝' : n.key.length > 13 ? `${n.key.slice(0, 12)}…` : n.key }}</text>
          <text v-if="n.runs > 1" :x="n.x + n.w / 2 - 4" :y="n.y - n.h / 2 + 2" text-anchor="end" class="runs">×{{ n.runs }}</text>
        </g>
      </svg>
    </div>
    <div v-if="flow" class="legend" data-testid="onto-case-flow-legend">
      <span v-for="s in legend" :key="s"><i :class="s" />{{ STATE_KO[s] }}</span>
      <span class="sp" /><small>굵은 선 · 이 건이 간 길</small>
      <small v-if="showBpmn && ways.has('extra')">점선 · 지금 지도에는 없는 길</small>
      <small v-if="showBpmn && ways.has('rewound')">주황 점선 · 되감은 길</small>
    </div>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.cf { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.hd { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.hd b { font-size: 13.5px; font-weight: 600; }
.when { font-size: 12px; color: var(--text-tertiary); }
.bigbtn { margin-left: auto; height: 28px; padding: 0 12px; border-radius: 9999px; font-size: 12.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.muted { margin: 0; font-size: 13px; color: var(--text-secondary); }
.dg { margin: 0 -4px; }
.box { overflow-x: auto; overflow-y: hidden; border-radius: 12px; background: var(--field-bg); padding: 2px; }
svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.edge path { fill: none; stroke: var(--text-tertiary); stroke-width: 1.4; opacity: .55; }
.edge.taken path { stroke: var(--text-primary); stroke-width: 2.6; opacity: .9; }
.edge.and path { stroke-dasharray: 2 0; }
.edge.back path { stroke-dasharray: 4 3; }
.edge.extra path { stroke-dasharray: 5 3; }
.edge.skp path { stroke-dasharray: 2 4; opacity: .4; }
.tip { fill: var(--text-tertiary); opacity: .7; }
.tip.on { fill: var(--text-primary); opacity: 1; }
.lbl { font-size: 10.5px; fill: var(--text-secondary); paint-order: stroke; stroke: var(--field-bg); stroke-width: 3px; }
.node rect, .node circle { fill: var(--cell-bg); stroke: var(--hairline); stroke-width: 1.2; }
.node text { font-size: 12.5px; fill: var(--text-primary); }
.node .runs { font-size: 10px; fill: var(--text-secondary); }
.node.done rect, .node.done circle { fill: color-mix(in srgb, var(--color-success) 20%, var(--cell-bg)); stroke: color-mix(in srgb, var(--color-success) 60%, transparent); }
.node.running rect, .node.person rect { fill: color-mix(in srgb, var(--color-info) 20%, var(--cell-bg)); stroke: var(--color-info); stroke-width: 2; }
.node.waiting rect { fill: color-mix(in srgb, var(--color-warning, #b26a00) 20%, var(--cell-bg)); stroke: var(--color-warning, #b26a00); stroke-width: 2; }
.node.skipped rect { fill: transparent; stroke-dasharray: 4 3; }
.node.skipped text { fill: var(--text-secondary); text-decoration: line-through; }
.node.next rect { fill: transparent; stroke: var(--color-info); stroke-dasharray: 4 3; }
.node.closed rect { fill: transparent; opacity: .6; }
.node.none text, .node.off text { fill: var(--text-secondary); }
.node.end text { font-size: 11px; fill: var(--text-secondary); }
.node.entry rect { stroke-width: 2; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 11.5px; color: var(--text-secondary); }
.legend span { display: inline-flex; align-items: center; gap: 4px; }
.legend i { width: 10px; height: 10px; border-radius: 3px; background: var(--cell-bg); box-shadow: inset 0 0 0 1px var(--hairline); }
.legend i.done { background: color-mix(in srgb, var(--color-success) 35%, transparent); }
.legend i.running { background: color-mix(in srgb, var(--color-info) 35%, transparent); }
.legend i.person { background: color-mix(in srgb, var(--color-info) 14%, transparent); box-shadow: inset 0 0 0 1.5px var(--color-info); }
.legend i.waiting { background: color-mix(in srgb, var(--color-warning, #b26a00) 35%, transparent); }
.legend i.skipped { background: transparent; box-shadow: inset 0 0 0 1px var(--text-tertiary); }
.legend i.next { background: transparent; box-shadow: inset 0 0 0 1.5px var(--color-info); }
.legend i.closed { background: var(--cell-bg); opacity: .5; }
.legend .sp { flex: 1; }
.legend small { font-size: 11.5px; color: var(--text-tertiary); }
.err { font-size: 12.5px; color: var(--color-error); }
</style>
