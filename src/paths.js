// Agents report where they saved a file ("**File:** `/workspace/.bpmn/<room>/quote.xlsx`"): a sandbox
// or host path means nothing to the person, and the file itself already comes as a card under the
// answer. On screen such a path reads as the file's name, a folder path as "the output folder". The
// stored answer keeps the path (the server finds the run's documents by it: lib/office.js documentsOfRun).
import { isEnglish } from './i18n/lang.js'

const B = '`'
// where the agents' files live: the sandbox (/workspace), the host (/Users/…, /home/…, /private/…, /tmp/…)
const ROOT = String.raw`(?:/workspace|/Users/[^/\s` + B + String.raw`'"<>()]+|/home/[^/\s` + B + String.raw`'"<>()]+|/private/(?:tmp|var)|/tmp)(?=/|\b)`
// a path in backticks may hold spaces ("Moonlight Coffee quote.xlsx"); a bare one ends at a space
const QUOTED = new RegExp(B + '(' + ROOT + '[^' + B + '\\n]*)' + B, 'g')
// a markdown link to a sandbox file goes nowhere: its label stays
const LINKED = new RegExp(String.raw`\[([^\]\n]+)\]\(\s*(?:sandbox:|file://)?` + ROOT + String.raw`[^)\n]*\)`, 'g')
const BARE = new RegExp(String.raw`(?<![\w/.:~-])(?:sandbox:)?` + ROOT + String.raw`(?:/[^\s` + B + String.raw`'"<>()\[\]*,;]*)*`, 'g')

const folderWord = () => (isEnglish ? 'the output folder' : '산출물 폴더')
// a file has an extension; a folder (or a run room id) does not
const fileName = (p) => {
  const last = String(p).replace(/\/+$/, '').split('/').pop() || ''
  return /\.[A-Za-z0-9]{1,8}$/.test(last) && !String(p).endsWith('/') ? last : null
}

export function hidePaths(text) {
  const t = String(text ?? '')
  if (!/\/(workspace|Users|home|private|tmp)\b/.test(t)) return t
  return t
    .replace(LINKED, (m, label) => label)
    .replace(QUOTED, (m, p) => { const f = fileName(p.trim()); return f ? B + f + B : folderWord() })
    .replace(BARE, (m) => {
      const trail = /[.:!?]+$/.exec(m)?.[0] || ''
      return (fileName(m.slice(0, m.length - trail.length)) || folderWord()) + trail
    })
}
