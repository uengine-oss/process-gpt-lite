// The built-in browser (lib/browser.js) as an agent tool server (pgpt-browser at /mcp/browser — mcp/toolServers.js): the agent asks for work
// inside a website in the middle of its turn, and the task shows up in the person's chat at once — its live screen, its steps, its questions
// (lib/agentBrowser.js). It runs as the person the agent works for (the caller's JWT) and fills logins from that person's vault on the
// server (the model never sees them). The agent's conversation (X-Conversation-Id: {{conversation_id}}, filled by deepagents) says which
// chat it belongs in: when that is a live turn answering the person's own message, the task is theirs — attended, their words from that
// turn decide what it may do, and payments, sending and deleting still wait for their approval on the card. A run nobody watches (a
// scheduled run, a routine, no live turn) only reads, as before.
import { z } from 'zod'
import { L, langOf, withLang } from '../../lib/lang.js'
import { browserSkills } from '../../lib/browserSkills.js'
import { signedIn } from '../../lib/people.js'
import { allowedHere } from '../../lib/privateNet.js'
import { hostRefusal } from '../../lib/linkPreview.js'
import * as AB from '../../lib/agentBrowser.js'

// a public web address: not this machine, the cluster or a private network — the same rule the link preview keeps (lib/linkPreview.js
// hostRefusal: a name of one label or one that only means something inside a network, a non-public address, a trailing dot as without it)
export function publicAddress(u) {
  let url
  try { url = new URL(u) } catch { return false }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false
  return !hostRefusal(url.hostname)
}

// The browser skills this server has (skills/<name>/SKILL.md with metadata.runs_in: browser — lib/browserSkills.js): data, not rules
const skillLines = () => browserSkills().map((s) => `- ${s.name}${s.label ? ` (${s.label})` : ''}: ${String(s.description || '').replace(/\s+/g, ' ').slice(0, 240)}`)

export const TASK_DESCRIPTION = () => [
  'Do work inside a website in the built-in browser, as the person you work for — signed in with their own account (saved logins are filled on the server; you never see them).',
  'Use it when the work has to happen on a site that has no API tool here (NotebookLM, for instance), or when the person named the site to do it on: create, upload, generate and download there instead of rebuilding the result yourself.',
  'The task shows up in the person\'s chat at once as a task card with its live screen and steps; when the site needs them (a choice, a sign-in, an approval for a payment, a sending or a deletion) the card asks them.',
  'Give the goal in plain words with everything the site work needs (links, names, what to make and what to download). Returns within about 4 minutes: the result, or how it stands (state running · waiting_for_person · queued, with task_id and its last steps) — then call browser_task_wait with the task_id.',
  'Anything with an effect outside the person\'s own workspace on the site (sending, posting, sharing, deleting, changing settings) waits for the person\'s approval on the card unless their own words asked for it.',
  'In a run nobody watches (a schedule, a routine) it only reads public pages: it does not sign in with saved logins, and it creates, sends or changes nothing.',
  ...(skillLines().length ? ['Browser skills (pass the name as skill when one is for the site):', ...skillLines()] : []),
].join('\n')
export const WAIT_DESCRIPTION = () => [
  'Wait for a browser task started with browser_task (its task_id), up to `seconds` (at most 240). Returns as soon as it is over (state done · failed · needs_review · cancelled, with summary, notes, url, page_text and the files it downloaded) or as soon as it starts asking the person something new; else, when the time is up, how it stands.',
  'While it is waiting_for_person the person is being asked on the browser card in the chat: keep calling this, or tell them in one line that the card needs them — do not ask them the same thing again yourself.',
].join('\n')
export const SAY_DESCRIPTION = () => 'Pass words on to a running browser task you started in this conversation (its task_id): a correction or a detail it needs ("use the notebook named …"). The task reads them on its next look at the page. They are your words, not the person\'s: they never approve a payment, a sending or a deletion, they do not count as what the person asked for, and they do not answer a question the task asked the person — that stays on their card.'

const skillInput = () => {
  const names = browserSkills().map((s) => s.name)
  return names.length ? z.enum(names).optional().describe('The browser skill for the site, if one is for it') : z.string().optional()
}

// (the agent calls this without the page's language: the person's saved language decides — as mcp/mail.js)
const inTheirLang = async (userId, fn) => withLang(await langOf(userId).catch(() => 'ko'), fn)
// the result goes back on a call that is still open: only then does the agent have it (no handback for it)
const answered = (rec, out, ctx) => { if (!ctx.signal?.aborted) AB.markDelivered(rec, out); return out }
const mine = async (userId, taskId) => {
  const rec = await AB.ownTask(userId, taskId)
  if (!rec) throw new Error(L('이 사람의 브라우저 작업에서 그 task_id 를 찾지 못했어요.', "No browser task of this person's has that task_id."))
  return rec
}

export const browserConnector = {
  name: 'browser',
  title: '내장 브라우저',
  connected: async () => process.env.PRO_BROWSER_TOOL !== '0',
  tools: [
    {
      name: 'browser_task',
      description: TASK_DESCRIPTION,
      input: () => ({ goal: z.string().describe('What to do on the site, in plain words, with everything it needs'), start_url: z.string().optional().describe('Where to start (a public web address)'), skill: skillInput() }),
      // ctx: {conv, jwt, user} — the call's conversation and token (mcp/connectors.js)
      run: (userId, { goal, start_url, skill }, ctx = {}) => inTheirLang(userId, async () => {
        // (or one the company lets its tasks open on its own network — PRO_BROWSER_PRIVATE_ALLOW, lib/privateNet.js)
        if (start_url && !publicAddress(start_url) && !allowedHere(start_url)) throw new Error(L(`공개 웹 주소만 열 수 있어요: ${start_url}`, `Only public web addresses can be opened: ${start_url}`))
        if (!String(goal || '').trim()) throw new Error(L('할 일(goal)이 비어 있어요.', 'The goal is empty.'))
        const u = ctx.user || { id: userId }
        const name = u.email ? (await signedIn(u).catch(() => null))?.name || '' : ''
        const rec = await AB.startTask({ user: { id: userId, email: u.email || '', name }, conv: ctx.conv || null, jwt: ctx.jwt || '', goal: String(goal).trim(), startUrl: start_url || '', skill: skill || '' })
        return answered(rec, await AB.follow(rec, AB.WAIT_MS(), { signal: ctx.signal }), ctx)
      }),
    },
    {
      name: 'browser_task_wait',
      description: WAIT_DESCRIPTION,
      input: () => ({ task_id: z.string(), seconds: z.number().optional().describe('How long to wait, at most 240') }),
      run: (userId, { task_id, seconds }, ctx = {}) => inTheirLang(userId, async () => {
        const rec = await mine(userId, task_id)
        const s = Number(seconds)
        return answered(rec, await AB.follow(rec, Number.isFinite(s) && s > 0 ? Math.min(s, 240) * 1000 : AB.WAIT_MS(), { signal: ctx.signal }), ctx)
      }),
    },
    {
      name: 'browser_task_say',
      description: SAY_DESCRIPTION,
      input: () => ({ task_id: z.string(), text: z.string() }),
      // (only a task the agent started in this conversation — never one the person started in the chat)
      run: (userId, { task_id, text }, ctx = {}) => inTheirLang(userId, async () => {
        const rec = AB.agentTask(userId, task_id, ctx.conv || null)
        if (!rec) throw new Error(L('이 대화에서 에이전트가 시작한 브라우저 작업에서 그 task_id 를 찾지 못했어요.', 'No browser task the agent started in this conversation has that task_id.'))
        return AB.say(rec, text)
      }),
    },
  ],
}
