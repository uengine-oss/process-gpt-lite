// The stored BPMN, laid out by Process GPT vue3's automatic layout before a view shows it (./bpmn-auto-layout/index.js).
// Loaded on the first diagram, not with the app: the layout and bpmn-js's Modeler are a chunk of their own.
// Any failure (the chunk, the layout) shows the XML as stored.
let warned = false

export async function laidOutBpmn(xml, id = '') {
  try {
    const { layoutBpmnXml } = await import('./bpmn-auto-layout/index.js')
    return await layoutBpmnXml(xml, id)
  } catch (e) {
    if (!warned) { warned = true; console.warn('[bpmn-layout] 자동 레이아웃을 불러오지 못했어요 — 저장된 배치로 보여요', e?.message || e) }
    return xml
  }
}
