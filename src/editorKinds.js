// Which in-app editor a file opens in, by its extension — IeumOffice (docs, sheets, slides, pdf, markdown, html, mindmap, 한글)
// or an ArtCraft web app. Kept apart from officeEditor.js (which reads the session and the install's config) so the
// decision can be tested without a browser (server/test/openPlan.test.js).
export const EDITOR_BY_EXT = {
  docx: 'docs', odt: 'docs', xlsx: 'sheets', xlsm: 'sheets', xls: 'sheets', csv: 'sheets', pptx: 'slides',
  pdf: 'pdf', md: 'markdown', markdown: 'markdown', txt: 'markdown', html: 'html', htm: 'html', xmind: 'mindmap', hwp: 'hwp', hwpx: 'hwp',
  // ArtCraft web apps, not IeumOffice (CraftEditorFrame.vue)
  dxf: 'cadcraft', dwg: 'cadcraft',
  svg: 'vectorcraft', vectorcraft: 'vectorcraft',
  psd: 'photocraft', psb: 'photocraft', pcraft: 'photocraft', photocraft: 'photocraft', png: 'photocraft', jpg: 'photocraft', jpeg: 'photocraft', webp: 'photocraft',
  wav: 'soundcraft', mp3: 'soundcraft', flac: 'soundcraft', ogg: 'soundcraft', soundcraft: 'soundcraft', scraftz: 'soundcraft',
  mp4: 'filmcraft', mov: 'filmcraft', webm: 'filmcraft', fcproj: 'filmcraft', filmcraft: 'filmcraft',
}
export const CRAFT_APPS = new Set(['cadcraft', 'vectorcraft', 'photocraft', 'soundcraft', 'filmcraft'])
export const CRAFT_NAMES = { cadcraft: 'CADCraft', vectorcraft: 'VectorCraft', photocraft: 'PhotoCraft', soundcraft: 'SoundCraft', filmcraft: 'FilmCraft' }

export function extOf(nameOrUrl) {
  // a URL loses its query and fragment; a file name keeps "#" ("Moonlight Coffee Store #2 proposal.docx")
  const s = String(nameOrUrl || '')
  const clean = /^[a-z][a-z0-9+.-]*:|^\//i.test(s) ? s.split('?')[0].split('#')[0] : s
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : ''
}

/** the editor for this file name (or URL); null when it cannot be edited */
export function officeEditorFor(nameOrUrl) { return EDITOR_BY_EXT[extOf(nameOrUrl)] || null }
