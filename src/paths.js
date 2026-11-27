// Agents report where they saved a file ("**File:** `/workspace/.bpmn/<room>/quote.xlsx`"): a sandbox
// or host path means nothing to the person, and the file itself already comes as a card under the
// answer. On screen such a path reads as the file's name, a folder path as "the output folder". The
// stored answer keeps the path (the server finds the run's documents by it: lib/office.js documentsOfRun).
import { isEnglish } from './i18n/lang.js'

const folderWord = () => (isEnglish ? 'the output folder' : '산출물 폴더')

// ---- the path rules: the same text in src/paths.js and server/lib/hidePaths.js (server/test/hidePaths.test.js holds them to the same answers)
const B = '`'
// where the agents' files live: the sandbox (/workspace), the host (/Users/…, /home/…, /private/…, /tmp/…, a temporary folder — macOS's
// /var/folders/… (os.tmpdir()), /var/tmp/…)
const ROOT = String.raw`(?:/workspace|/Users/[^/\s` + B + String.raw`'"<>()]+|/home/[^/\s` + B + String.raw`'"<>()]+|/private/(?:tmp|var)|/tmp|/var/(?:folders|tmp))(?=/|\b)`
// a Windows path: a drive (C:\… or C:/…) or a share (\\server\share\…) — what is not a word or a slash before it (not a URL's scheme)
const WIN = String.raw`(?:(?<![\w\\/])[A-Za-z]:[\\/](?![\\/])|(?<![\w\\])\\\\[\w.$-]+\\)`
const WIN_REST = String.raw`[^\s` + B + String.raw`'"<>()|*?]*`
// a path in backticks may hold spaces ("Moonlight Coffee quote.xlsx"); a bare one ends at a space
const QUOTED = new RegExp(B + '((?:' + ROOT + '|' + WIN + ')[^' + B + '\\n]*)' + B, 'g')
// a markdown link to a sandbox or host file goes nowhere: its label stays (the address may be wrapped in <…>, after a space)
const LINKED = new RegExp(String.raw`\[([^\]\n]+)\]\(\s*(?:<\s*(?:sandbox:|file://)?(?:` + ROOT + '|' + WIN + String.raw`)[^>\n]*>|(?:sandbox:|file://)?(?:` + ROOT + '|' + WIN + String.raw`)[^)\n]*)\s*\)`, 'g')
const BARE_WIN = new RegExp(WIN + WIN_REST, 'g')
// (after a colon too — 「경로:/workspace/…」 — but never inside an address: a word, a slash or a dot before it)
const BARE = new RegExp(String.raw`(?<![\w/.~-])(?:sandbox:|file://)?` + ROOT + String.raw`(?:/[^\s` + B + String.raw`'"<>()\[\]*,;]*)*`, 'g')
// a file has an extension; a folder (or a run room id) does not
const fileName = (p) => {
  const s = String(p).replace(/^(?:sandbox:|file:\/\/)/i, '')
  const last = s.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  return /\.[A-Za-z0-9]{1,8}$/.test(last) && !/[\\/]$/.test(s) ? last : null
}
const trailOf = (m) => /[.:!?]+$/.exec(m)?.[0] || ''

export function hidePaths(text) {
  let t = String(text ?? '')
  if (!/\/(workspace|Users|home|private|tmp|var)\b|[A-Za-z]:[\\/]|\\\\[\w.$-]+\\/.test(t)) return t
  // (a file address of this computer: file://localhost/… is file:///…, and a drive's file:///C:/… is the drive's path)
  t = t.replace(/file:\/\/localhost(?=\/)/gi, 'file://').replace(/file:\/\/\/?(?=[A-Za-z]:[\\/])/gi, '')
  return t
    .replace(LINKED, (m, label) => label)
    .replace(QUOTED, (m, p) => { const f = fileName(p.trim()); return f ? B + f + B : folderWord() })
    .replace(BARE_WIN, (m) => { const trail = trailOf(m); return (fileName(m.slice(0, m.length - trail.length)) || folderWord()) + trail })
    .replace(BARE, (m) => { const trail = trailOf(m); return (fileName(m.slice(0, m.length - trail.length)) || folderWord()) + trail })
}
// ---- end of the path rules
