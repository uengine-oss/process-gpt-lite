// What the team session tells this server itself, the moment it happens: Claude Code hooks (passed with
// --settings when the session starts) post the session's events here — it stopped and handed the turn back
// (Stop, with the words it ended on), a person sent it something (UserPromptSubmit), it shows a notice
// (Notification: a permission, or the prompt idle for a minute), its turn ended on an error instead
// (StopFailure: not logged in, a usage limit, the API failing). The watcher (lib/aidlc/watch.js) still
// reads the screen every few seconds; an event only makes it look at once, and tells it what was asked in
// plain words — an approval asked in the chat instead of a selection prompt has nothing else to find it by.
//
// The settings file and the key that signs each session's calls live outside every project
// (~/.pgpt-lite/aidlc-hooks, or PRO_AIDLC_HOOK_DIR): a session keeps its hooks across this server's
// restarts, and nothing is written into the team's repository.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../../config.js'

const EVENTS = ['Stop', 'StopFailure', 'UserPromptSubmit', 'Notification']
export const dir = () => config.aidlcHookDir || path.join(os.homedir(), '.pgpt-lite', 'aidlc-hooks')

let key = null
function secret() {
  if (key) return key
  const file = path.join(dir(), 'hook.key')
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  try { key = fs.readFileSync(file, 'utf8').trim() } catch {}
  if (!key) { key = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(file, key, { mode: 0o600 }) }
  return key
}
export const token = (name) => crypto.createHmac('sha256', secret()).update(String(name)).digest('hex').slice(0, 40)
export function verify(name, given) {
  const want = Buffer.from(token(name)), got = Buffer.from(String(given || ''))
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

// the shell command a hook runs: its event (JSON on stdin) to this server, never holding the session up
export function command(name, port = config.port) {
  const url = `http://127.0.0.1:${port}/api/aidlc/hook/${encodeURIComponent(name)}`
  return `curl -s -m 3 -o /dev/null -X POST -H 'content-type: application/json' -H 'x-lite-hook: ${token(name)}' --data-binary @- '${url}' || true`
}
export function settings(name, port) {
  const hook = [{ hooks: [{ type: 'command', command: command(name, port), timeout: 5 }] }]
  return { hooks: Object.fromEntries(EVENTS.map((e) => [e, hook])) }
}
// → the settings file for `claude --settings` (its own file per session: the command carries that session's token)
export function settingsFile(name, port) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const file = path.join(dir(), `${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  fs.writeFileSync(file, JSON.stringify(settings(name, port), null, 1), { mode: 0o600 })
  return file
}

// ---------- what each session said last ----------
// name -> { turn: 'idle' | 'busy' | 'failed', at, message, error, notice } — whose turn it is: the person's once
// the session stopped (with the words it stopped on), the session's once a person sent it something; 'failed'
// when the turn ended on an error (its kind, Claude Code's own: authentication_failed, rate_limit, …). A notice
// leaves the turn as it was. (This process only: after a restart the screen is read as before.)
const last = new Map()
export function receive(name, body = {}) {
  const event = String(body.hook_event_name || '')
  if (!EVENTS.includes(event)) return null
  const now = { ...(last.get(name) || {}) }
  if (event === 'Stop') Object.assign(now, { turn: 'idle', at: Date.now(), message: String(body.last_assistant_message || '').slice(-6000), error: '' })
  if (event === 'StopFailure') Object.assign(now, { turn: 'failed', at: Date.now(), error: String(body.error || 'unknown'), message: String(body.error_details || body.last_assistant_message || '').slice(-600) })
  if (event === 'UserPromptSubmit') Object.assign(now, { turn: 'busy', at: Date.now(), message: '', error: '' })
  if (event === 'Notification') Object.assign(now, { notice: String(body.message || '').slice(0, 300), noticeKind: String(body.notification_type || ''), noticeAt: Date.now() })
  last.set(name, now)
  return now
}
export const lastOf = (name) => last.get(name) || null
export const forget = (name) => last.delete(name)
