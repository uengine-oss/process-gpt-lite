// The IeumOffice screen (an MCP App behind the sandbox proxy): the editor (/office/<editor>/ on this screen's own
// origin) in a frame, and a relay of the editor's message protocol — what the editor says (source 'ieum-office':
// ready, saved, agent, mention, reply …) goes to the page as Lite's notification 'office'; what the page says
// (context, mention-mode, picture requests) comes in through office_post. Bytes (a picture) cross as base64.
// The page's old reach into the editor's document is here: fold the ribbon (Ctrl+F1) or the 한글 tool box, hide the AI dock.
import lite from '../../_runtime/lite.js'

const frame = document.getElementById('office')
const win = () => frame.contentWindow

// the page hands the editor's address (with the person's token, which the editor shows office-host) and the ribbon to fold
lite.provide('office_load', ({ src, ribbonKey }) => {
  // the editor remembers each app's ribbon in localStorage on this origin: start folded, the document gets the room
  if (ribbonKey) try { localStorage.setItem(ribbonKey, '1') } catch { /* private mode: it opens unfolded */ }
  const url = new URL(String(src || ''), self.origin)
  if (url.origin !== self.origin || !/\/office\/[a-z]+\//.test(url.pathname)) throw new Error('not an editor address')
  frame.src = url.href
  return true
})
lite.provide('office_post', ({ msg }) => {
  if (!win()) throw new Error('the editor is not open')
  win().postMessage({ ...lite.unpack(msg || {}), source: 'process-gpt' }, self.origin)
  return true
})
window.addEventListener('message', (e) => {
  if (e.source !== win() || e.data?.source !== 'ieum-office') return
  lite.notify('office', lite.pack(e.data))
})

// the 한글 editor's tool box toggle, inside its studio frame
const hwpToggle = () => frame.contentDocument?.querySelector('iframe')?.contentDocument?.getElementById('toolbox-basic-toggle') || null
lite.provide('office_fold_hwp', async () => {
  for (let i = 0; i < 40; i++) {
    const t = hwpToggle()
    if (t) { if (t.classList.contains('active')) t.click(); return { open: false } }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
})
// the ribbon: the 한글 tool box by its button, the others on their own shortcut (Ctrl+F1, heard by the document)
lite.provide('office_ribbon', ({ editor }) => {
  if (editor === 'hwp') { const t = hwpToggle(); t?.click(); return { open: !!t?.classList.contains('active') } }
  const w = win()
  if (w) w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'F1', code: 'F1', ctrlKey: true, bubbles: true }))
  return null
})
// a read-only preview is for looking: the editor's AI dock stays out of the way
lite.provide('office_hide_ai', async () => {
  for (let i = 0; i < 20; i++) {
    const doc = frame.contentDocument
    if (doc?.head) {
      if (!doc.getElementById('pgpt-hide-ai')) {
        const st = doc.createElement('style')
        st.id = 'pgpt-hide-ai'
        st.textContent = '.ai-dock, .copilot, .ai-panel-resizer { display: none !important; }'
        doc.head.appendChild(st)
      }
      return true
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
})
await lite.ready
