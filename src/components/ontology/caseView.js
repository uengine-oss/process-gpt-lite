// How a process instance is seen (pure — server/test/map-case-view.test.js).
// A case run straight from the company's process map (지도에서 바로 — server lib/ontology/mapengine.js) has no process definition: its
// instance page draws the case's own BPMN (server casebpmn.js — the same lanes, splits and joins as a snapshot's) with each step's state,
// and opens on that diagram; a definition's instance (classic, or a map snapshot) draws its definition and opens on the list as before.
// The company's map is a link from the page (「회사 지도에서 이 건 보기」), not where the instance opens (2026-11-24: 「프로세스 지도 자체는
// 가독성이 많이 떨어지기 때문에 … BPMN 스냅샷을 보여줘야 됩니다」).

// the map case an instance page is about (GET /instances/:id → mapCase), or null
export const mapCaseOf = (data) => (data?.mapCase?.id ? data.mapCase : null)

// the case on the company's map (ProcessMapView with its case panel)
export const mapCaseLink = (mc) => (mc?.id ? `/process-map?proc=${encodeURIComponent(mc.proc || '')}&case=${encodeURIComponent(mc.id)}` : '/process-map')

// what the instance page shows: kind (map | definition), the diagram it draws and the view it opens on (bpmn | list)
export function instanceViewOf(data) {
  const mc = mapCaseOf(data)
  if (mc) return { kind: 'map', diagram: 'case-bpmn', view: 'bpmn', caseId: mc.id, mapLink: mapCaseLink(mc) }
  return { kind: 'definition', diagram: 'definition-bpmn', view: 'list', defId: data?.inst?.proc_def_id || null, mapLink: null }
}

// where a routine in the list opens (RoutineList): every instance on its own page — except a map snapshot's case (engine bpm), whose
// gates and 「지금 스냅샷」 live in the case view on the map
export function routineTarget(i) {
  if (i?.case_id && i.engine !== 'map') return mapCaseLink({ id: i.case_id, proc: i.case_proc })
  return `/routines/${encodeURIComponent(i?.proc_inst_id || '')}`
}

// the case's flowchart runs top to bottom in a narrow place (a phone, the map's side panel), left to right where it has room
export const flowDir = (width) => (width && width < 640 ? 'TB' : 'LR')

// the diagram's card on a wide instance page: wider than the 512px conversation column (centred over it) when the page has room, so the
// flowchart can run left to right — the room the column's scroller has, less a gutter, at most 1040px; null: the column's own width
export function wideCardWidth(room, { column = 512, gutter = 48, max = 1040 } = {}) {
  const w = Math.min(max, Math.round((room || 0) - gutter))
  return w > column + 40 ? w : null
}

// the instance's question context for the agent (MainView onSend): what it is and where each step is
export function instanceContext(i) {
  const what = i?.def?.name || (mapCaseOf(i) ? '지도에서 바로 도는 건' : '')
  return `[프로세스 인스턴스: ${i?.inst?.proc_inst_name || ''} / ${what} / 상태 ${i?.inst?.status || ''}]\n단계: ${(i?.steps || []).map((s) => `${s.name}(${s.state})`).join(', ')}\n산출물: ${(i?.artifacts || []).map((a) => a.field || a.name).join(', ')}`
}
