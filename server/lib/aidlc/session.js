// An AI-DLC team session: one interactive Claude Code per linked AI-DLC folder, kept in tmux on a
// socket of its own so it outlives the browser tabs watching it (and this server's restarts). The
// team watches it through the workroom terminal; the server reads its screen to see when it waits on
// a person (a selection prompt: how to answer the questions, the summary, a stage approval, a tool
// permission) and types the number a person chose on a Home card — into the same prompt, so AI-DLC
// records the person's own answer and its human-presence guard holds.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { ENGLISH_NOTE } from '../lang.js'

const run = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const err = (status, message) => Object.assign(new Error(message), { status })

// nothing of the server's own context goes in: no secrets, no CLAUDE* markers, no PRO_* settings
// (the same rule as the workroom terminal); the aidlc CLI's folder in front of PATH
export function cleanEnv(base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('PRO_') && !k.startsWith('GIT_CONFIG_') && !/KEY|SECRET|TOKEN|PASSWORD/.test(k)))
  if (config.aidlcPath) env.PATH = `${config.aidlcPath}:${env.PATH || ''}`
  return Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' })
}
const tmux = (...args) => run('tmux', ['-L', config.aidlcTmuxSocket, ...args], { timeout: 10000, env: cleanEnv(), maxBuffer: 4 * 1024 * 1024 })

export const sessionName = (tenant, slug) => `aidlc-${tenant}-${slug}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
export const attachArgs = (name, readOnly) => ['-L', config.aidlcTmuxSocket, 'attach', ...(readOnly ? ['-r'] : []), '-t', name]

export async function has(name) {
  return tmux('has-session', '-t', name).then(() => true, () => false)
}

// Claude Code in the folder's working copy. Default permission mode: a tool outside the project's
// allow list stops at a permission prompt a person answers (auto mode's classifier would decide
// those itself, and it refused AI-DLC's reviewer subagents in our runs).
export async function start({ name, cwd, lang = 'ko' }) {
  if (await has(name)) return { name, started: false }
  const args = [config.claudeBin, '--permission-mode', config.aidlcPermissionMode]
  if (config.aidlcEffort) args.push('--effort', config.aidlcEffort)
  if (lang === 'en') args.push('--append-system-prompt', ENGLISH_NOTE)
  await tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '48', '-c', cwd, ...args)
  // every client sees the latest size (one person's small window does not shrink everyone's)
  await tmux('set-option', '-t', name, 'window-size', 'latest').catch(() => {})
  // no tmux status line: the screen is Claude Code's alone
  await tmux('set-option', '-t', name, 'status', 'off').catch(() => {})
  return { name, started: true }
}

export async function stop(name) {
  await tmux('kill-session', '-t', name).catch(() => {})
}

// the visible screen as text (wrapped lines joined)
export async function screen(name) {
  const { stdout } = await tmux('capture-pane', '-p', '-J', '-t', name)
  return stdout.replace(/[ \t]+$/gm, '')
}

export async function sendText(name, text) {
  await tmux('send-keys', '-t', name, '-l', String(text))
  await sleep(300)
  await tmux('send-keys', '-t', name, 'Enter')
}
export async function sendKey(name, key) {
  await tmux('send-keys', '-t', name, key)
}

// Claude Code's first question in a folder it has not opened before: is this workspace trusted ("❯ No, exit /
// Yes, I trust this folder", the cursor on No). It has no numbers, so it is no selection prompt — and anything
// typed there followed by Enter answers "No, exit". A person answers it; trust() presses what they chose.
export function parseTrust(text) {
  if (!/Yes, I trust this folder/.test(text) || !/No, exit/.test(text)) return null
  const cursor = String(text).split('\n').find((l) => /^\s*❯/.test(l)) || ''
  const pre = /pre-approves (\d+) tool permissions/.exec(text)
  return { onYes: /Yes, I trust/.test(cursor), preApproved: pre ? Number(pre[1]) : 0 }
}
export async function trust(name) {
  for (let i = 0; i < 6; i++) {
    const t = parseTrust(await screen(name))
    if (!t) return true
    await sendKey(name, t.onYes ? 'Enter' : 'Down')
    await sleep(t.onYes ? 1200 : 300)
  }
  return !parseTrust(await screen(name))
}
// the input box is drawn: a "❯" line between two rules (a menu's cursor line is a "❯" line too, but not there)
export function atPrompt(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.some((l, i) => /^[❯>]/.test(l) && RULE.test(lines[i - 1] || '') && RULE.test(lines[i + 1] || ''))
}

// ---------- reading a selection prompt off the screen ----------
// Claude Code draws a prompt at the bottom: a header chip ("☐ Approval") or a tool box, the question,
// numbered options ("❯ 1. Approve" with the cursor on one, a hint line under each), and a footer
// ("Enter to select · ↑/↓ to navigate · Esc to cancel"). Nothing on screen like that: null.
const OPTION = /^\s*(❯\s*)?(\d{1,2})\.\s+(.+?)\s*$/
const FOOTER = /Enter to select|Esc to cancel|to navigate/
const RULE = /^[─━-]{10,}$/
const FREE_TEXT = /^(Type something\.?|Type here)/i
const CHAT = /^Chat about this/i
// switching the shared session to auto mode is not one person's call from a card (the shell still has it)
const AUTO = /switch to auto mode/i
export function parseChoice(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+$/, ''))
  let end = lines.length - 1
  while (end >= 0 && !lines[end].trim()) end--
  const near = lines.slice(Math.max(0, end - 3), end + 1).findIndex((l) => FOOTER.test(l))
  if (near < 0) return null
  const footer = Math.max(0, end - 3) + near
  // the block above the footer: options, the hint lines indented under them, rules, blanks
  let top = -1
  for (let i = footer - 1; i >= 0 && i > footer - 40; i--) {
    const l = lines[i]
    if (OPTION.test(l)) { top = i; continue }
    if (!l.trim() || RULE.test(l.trim()) || (/^\s{3,}\S/.test(l) && top >= 0)) continue
    break
  }
  if (top < 0) return null
  const options = []
  for (let i = top; i < footer; i++) {
    const l = lines[i]
    const o = l.match(OPTION)
    if (o) options.push({ n: Number(o[2]), label: o[3].trim(), hint: '' })
    else if (/^\s{3,}\S/.test(l) && options.length) options.at(-1).hint = [options.at(-1).hint, l.trim()].filter(Boolean).join(' ')
  }
  if (!options.length || options[0].n !== 1) return null
  const q = []
  let title = ''
  // the question just above the options; past a blank line only the header chip still belongs to it —
  // or, for a tool permission, the box from the rule above: the tool, what it is for, the command
  let gap = false, ruleAt = -1
  for (let j = top - 1; j >= 0 && j > top - 12; j--) {
    const l = lines[j].trim()
    if (!l) { if (q.length) gap = true; continue }
    if (RULE.test(l)) break
    const chip = l.match(/^☐\s+(.+)$/)
    if (chip) { title = chip[1].trim(); break }
    if (gap) {
      // a tool box above: up to its top rule, at most a screenful
      for (let k = j; k >= 0 && k > j - 20; k--) if (RULE.test(lines[k].trim())) { ruleAt = k; break }
      break
    }
    q.unshift(l.replace(/^│\s?/, ''))
  }
  const detail = []
  if (ruleAt >= 0) {
    for (let k = ruleAt + 1; k < top; k++) {
      const l = lines[k].trim()
      if (!l || /^╌{5,}$/.test(l) || /^Tip:/.test(l) || q.includes(l)) continue
      detail.push(l)
    }
    if (detail.length) title = detail.shift()
  }
  const opts = options.filter((o) => !CHAT.test(o.label) && !AUTO.test(o.label))
  return {
    title, question: q.join('\n').replace(/\n{2,}/g, '\n').trim(), detail: detail.join('\n'),
    options: opts.map((o) => ({ n: o.n, label: o.label, hint: o.hint, freeText: FREE_TEXT.test(o.label) })),
    // (the command too: two tool permissions one after the other differ only in what they would run)
    fingerprint: crypto.createHash('sha1').update(JSON.stringify([title, q, opts.map((o) => o.label), detail])).digest('hex').slice(0, 16),
  }
}

// Type a person's choice into the prompt on screen, only if it is still the prompt they saw.
export async function answer(name, { fingerprint, option, text }) {
  const now = parseChoice(await screen(name))
  if (!now) throw err(409, 'no prompt on screen')
  if (fingerprint && now.fingerprint !== fingerprint) throw err(409, 'the prompt changed')
  const o = now.options.find((x) => x.n === Number(option))
  if (!o) throw err(400, 'no such option')
  await sendKey(name, String(o.n))
  if (o.freeText) {
    if (!String(text || '').trim()) throw err(400, 'text needed')
    await sleep(400)
    await tmux('send-keys', '-t', name, '-l', String(text).replace(/\s*\n\s*/g, ' ').slice(0, 2000))
    await sleep(300)
    await tmux('send-keys', '-t', name, 'Enter')
  }
  // (a written answer is what the person wrote, not the option's "Type something.")
  return { answered: o.freeText ? String(text).replace(/\s*\n\s*/g, ' ').slice(0, 120) : o.label }
}
