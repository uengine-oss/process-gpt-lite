// Saving a document open in IeumOffice that the person saves (a chat's document — a shared folder's saves by itself, src/officeAutosave.js):
// what the sheet's bar says about it, how long a save may take, and the name 「다른 이름으로 저장」 gives the copy. No browser state here:
// tested in server/test/officeSave.test.js (spec openspec/specs/folder-edit-save 「채팅의 문서」).
//
// 2026-11-27 production recording: a chat's TXT edited in the editor, 저장 pressed — the editor's own status bar said 「저장 중…」 for good
// and nothing else said anything. The editor talks to its host over one WebSocket (/lite/office/__ipc); in production Cloudflare closes a
// WebSocket that carries nothing for about 100 s (measured: closed after 125 s with 1006, kept open with a frame every 40 s), and the
// editor's page then sends its save into the closed socket, where it is dropped without an answer.

// the editor connection is kept busy this often (Cloudflare's idle limit is 100 s)
export const KEEPALIVE_MS = 30_000
// a save that has not answered by then has failed (the editor uploads a document of a few MB well within it)
export const SAVE_WAIT_MS = 30_000

const two = (n) => String(n).padStart(2, '0')
/** 24-hour 「10:42」 of a time (ms or Date) */
export function hhmm(t) {
  const d = new Date(t)
  return Number.isFinite(d.getTime()) ? `${two(d.getHours())}:${two(d.getMinutes())}` : ''
}

/**
 * What the bar's save badge says.
 * state: {kind: 'idle'|'saving'|'saved'|'failed', at?, why?}; edited: an edit not saved yet; gone: the editor's connection closed.
 * → null (nothing to say) | {kind, text, short, title, action}
 *   kind: 'edited' | 'saving' | 'saved' | 'failed' | 'gone' — action: what pressing it does ('retry' | 'reopen' | null)
 */
export function saveBadge(state = {}, { edited = false, gone = false } = {}) {
  const k = state?.kind || 'idle'
  if (gone) {
    return { kind: 'gone', text: '연결 끊김 · 다시 열기', short: '연결 끊김', action: 'reopen',
      title: '편집기와 연결이 끊겨 지금은 저장할 수 없어요. 고친 내용을 복사해 두고 눌러서 다시 여세요.' }
  }
  if (k === 'saving') return { kind: 'saving', text: '저장하는 중…', short: '저장 중…', action: null, title: '편집기가 저장 중이에요' }
  if (k === 'failed') {
    const why = String(state.why || '').trim()
    return { kind: 'failed', text: '저장하지 못했어요 · 다시 시도', short: '저장 실패', action: 'retry', title: why ? `저장하지 못했어요 — ${why} · 눌러서 다시 시도` : '저장하지 못했어요 · 눌러서 다시 시도' }
  }
  if (edited) return { kind: 'edited', text: '저장 안 됨', short: '저장 안 됨', action: null, title: '고친 내용을 아직 저장하지 않았어요 — 💾 저장 또는 ⌘S' }
  if (k === 'saved') {
    const at = hhmm(state.at)
    return { kind: 'saved', text: at ? `저장했어요 · ${at}` : '저장했어요', short: at ? `저장됨 ${at}` : '저장됨', action: null, title: state.where ? `저장했어요 — ${state.where}` : '저장했어요' }
  }
  return null
}

const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1] : '' }
const stemOf = (name) => String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, '')

/** the name 「다른 이름으로 저장」 offers first: 「<이름> 사본.<확장자>」 (english: 「<name> copy.<ext>」) */
export function saveAsSuggestion(original, { english = false } = {}) {
  const ext = extOf(original)
  const stem = stemOf(original) || (english ? 'Document' : '문서')
  return `${stem}${english ? ' copy' : ' 사본'}${ext ? `.${ext}` : ''}`
}

/**
 * The name typed for 「다른 이름으로 저장」 → the file's name, or null when there is none. The format stays the document's (the editor
 * saves in it): a name without that extension gets it. Path signs and control characters go; at most 120 characters before it.
 */
export function saveAsName(input, original) {
  const ext = extOf(original)
  // (a path's 「..」 · 「.」 parts go with its separators)
  let n = String(input ?? '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').split(/\s+/).filter((t) => t && !/^\.+$/.test(t)).join(' ')
  if (ext && n.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) n = n.slice(0, -(ext.length + 1)).trim()
  n = n.replace(/^\.+/, '').slice(0, 120).trim()
  if (!n) return null
  return ext ? `${n}.${ext}` : n
}
