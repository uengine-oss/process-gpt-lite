// English mode loader: the dictionary, the layout fixes for longer English and the runtime
// translator — loaded (as a separate chunk) only when lang.js chose 'en', before the app mounts.
import dict from './ko-en.json'
import './en.css'
import { start } from './translate.js'

export function installEnglish() {
  start(window, dict)
}
