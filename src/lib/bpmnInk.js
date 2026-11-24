// The colours bpmn-js paints with when the diagram names none (its renderer's defaultStrokeColor · defaultFillColor), as CSS variables,
// for every viewer of ours (BpmnView · improve/HeatBpmn): new NavigatedViewer({ …, bpmnRenderer: bpmnInk }).
//
// The views' stylesheets repaint lines and shapes for the theme, but a flow's ends are out of their reach: bpmn-js draws each flow's
// arrowhead (and a message flow's circle, an association's open head, a conditional flow's diamond, a default flow's slash) as a <marker>
// in a <defs> inside that flow's own drawing, painted inline. With bpmn-js's own near-black they vanished on the dark theme (2026-11-25,
// 「마커 촉이 어디로 날라갔니?」). With these variables a head takes --bpmn-ink / --bpmn-paper from its flow's group — the views set them to
// the line's ink (a step stronger on a faint line; a state's colour — a case's way taken, a critical edge — as is) — and follows a theme
// switch without drawing again.
// (The fallbacks are bpmn-js's own colours, for a diagram outside our views.)
export const bpmnInk = {
  defaultStrokeColor: 'var(--bpmn-ink, hsl(225, 10%, 15%))',
  defaultFillColor: 'var(--bpmn-paper, white)',
}
