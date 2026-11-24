// Where the team messenger sits (2026-11-24 「대화방 위치를 끌어다가 다른 위치로 docking 할 수 있어야 대화하면서 작업공간을 나눠서
// 쓸 수 있음. 예를 들어 패널 영역으로」). Pure rules here — the state, what a window allows, the layout, the drop zones while the
// header is dragged and what this device remembers — tested without a browser (server/test/messengerDock.test.js); the messenger
// (components/team/Messenger.vue) carries them out.
//   float — the sheet over the page, as it always was (the default): opening a document puts it away
//   right — a column at the window's right edge; the page (and a document opened from it) shares the width
//   left  — the same at the left edge
//   panel — in the document panel: with a document open beside the page the messenger sits in that panel next to the document;
//           with none it is a column at the right like `right`
// A window narrower than DOCK_MIN_VIEW has no docking: the sheet floats (a phone keeps its full-screen sheet) and the choice
// is kept for a wider window.
export const DOCKS = ['float', 'right', 'left', 'panel']
export const DOCK_MIN_VIEW = 1000
export const MIN_W = 320
export const MAX_W = 720
export const DEFAULT_W = 400
// what a docked column leaves the page at least
export const PAGE_MIN = 560
// the space between a docked column and the window's edge
export const GUTTER = 12
// below this width a column shows the list or one conversation at a time (as on a phone)
export const TWO_COLUMNS_W = 600
export const KEY = 'pgl-messenger-dock'

export const canDock = (viewW) => Number(viewW) >= DOCK_MIN_VIEW

export function clampWidth(w, viewW) {
  const room = Number.isFinite(Number(viewW)) && Number(viewW) > 0 ? Number(viewW) - PAGE_MIN - GUTTER : Infinity
  const max = Math.max(MIN_W, Math.min(MAX_W, room))
  const n = Number(w)
  return Math.round(Math.min(max, Math.max(MIN_W, Number.isFinite(n) && n > 0 ? n : DEFAULT_W)))
}

// the state from what this device kept (anything unreadable: the default)
export function initial(saved) {
  const dock = DOCKS.includes(saved?.dock) ? saved.dock : 'float'
  return { dock, width: clampWidth(saved?.width) }
}

// actions: {type: 'dock', to} · {type: 'resize', width, viewW} · {type: 'reset'}
export function reduce(s, a) {
  switch (a?.type) {
    case 'dock': return DOCKS.includes(a.to) && a.to !== s.dock ? { ...s, dock: a.to } : s
    case 'resize': { const width = clampWidth(a.width, a.viewW); return width === s.width ? s : { ...s, width } }
    case 'reset': return initial(null)
    default: return s
  }
}

// the dock in effect on a window this wide
export const effective = (s, viewW) => (canDock(viewW) ? s.dock : 'float')

// Where the column is and what the page gives up for it. docBeside: a document is open beside the page (the office panel,
// not over it) — the panel dock then joins that panel and the page gives up nothing more than the document already takes.
export function layout(s, { viewW, docBeside = false } = {}) {
  const dock = effective(s, viewW)
  const width = clampWidth(s.width, viewW)
  const single = width < TWO_COLUMNS_W
  if (dock === 'float') return { dock, width, left: 0, right: 0, inPanel: false, single: false }
  if (dock === 'left') return { dock, width, left: width + GUTTER, right: 0, inPanel: false, single }
  if (dock === 'panel' && docBeside) return { dock, width, left: 0, right: 0, inPanel: true, single }
  return { dock, width, left: 0, right: width + GUTTER, inPanel: false, single }
}

// The drop zones shown while the header is dragged (the same rectangles the pointer is tested against): the left and right
// edges, and the document panel. Anywhere else: back to floating.
export const EDGE = 150
export const PANEL_TOP = 76
export function zones(viewW, viewH) {
  const h = viewH - 2 * GUTTER
  const panelX = Math.round(viewW * 0.45)
  return [
    { id: 'left', x: GUTTER, y: GUTTER, w: EDGE, h },
    { id: 'panel', x: panelX, y: PANEL_TOP, w: viewW - panelX - EDGE - 3 * GUTTER, h: viewH - PANEL_TOP - GUTTER },
    { id: 'right', x: viewW - EDGE - GUTTER, y: GUTTER, w: EDGE, h },
  ]
}
// the dock a drop at (x, y) asks for; null where the window has no docking (nothing changes)
export function zoneAt(x, y, viewW, viewH) {
  if (!canDock(viewW)) return null
  const z = zones(viewW, viewH).find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
  return z ? z.id : 'float'
}

// remembered per device (a private window or blocked storage: the default, and nothing is kept)
export function load(storage) {
  try { return initial(JSON.parse(storage?.getItem(KEY) || 'null')) } catch { return initial(null) }
}
export function save(storage, s) {
  try { storage?.setItem(KEY, JSON.stringify({ dock: s.dock, width: s.width })) } catch { /* not kept */ }
}
