// The built-in browser (lib/browser.js) as an agent tool, so a run that has no API for a site —
// a scheduled run above all, which never passes the chat router — can still read it. It runs as the
// person the agent works for (the caller's JWT), fills logins from that person's vault on the server
// (the model never sees them) and only reads: it runs unattended, so nobody is there to approve a
// payment, a message or a deletion, and those are refused.
import { z } from 'zod'
import { q } from '../../lib/supa.js'
import { runBrowserTask } from '../../lib/browser.js'
import { mainThread, setThreadStatus } from '../../lib/store.js'
import { L } from '../../lib/lang.js'

// the agent's MCP call waits at most a few minutes for the answer (its read timeout is 5)
const WAIT_MS = Number(process.env.PRO_BROWSER_TOOL_MS || 240000)

// a public web address: not this machine, the cluster or a private network
export function publicAddress(u) {
  let url
  try { url = new URL(u) } catch { return false }
  if (!/^https?:$/.test(url.protocol)) return false
  const h = url.hostname.toLowerCase()
  if (!h.includes('.') || h.startsWith('[') || /(^|\.)(localhost|local|internal|svc|cluster\.local)$/.test(h)) return false
  return !/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)
}

export const browserConnector = {
  name: 'browser',
  title: '내장 브라우저',
  connected: async () => process.env.PRO_BROWSER_TOOL !== '0',
  tools: [
    {
      name: 'browser_task',
      description: 'Read a web page in the built-in browser as the user — also pages behind a login: saved logins are filled from the user\'s vault on the server. Read-only: it never posts, sends, deletes, buys, books or changes settings. Use it only after the connector/API tools and plain public fetches (RSS, public pages) did not work. Takes a few minutes; returns the result, notes and the last page\'s text.',
      input: { goal: z.string(), start_url: z.string().optional() },
      run: async (userId, { goal, start_url }) => {
        if (start_url && !publicAddress(start_url)) throw new Error(L(`공개 웹 주소만 열 수 있어요: ${start_url}`, `Only public web addresses can be opened: ${start_url}`))
        // the card goes into the conversation the agent is answering in (a scheduled run's too)
        const [busy] = await q(`select id from pro_threads where user_id=$1 and status='working' order by updated_at desc limit 1`, [userId])
        const threadId = busy?.id || (await mainThread(userId)).id
        const task = runBrowserTask({ userId, threadId, goal: `${goal}${L('\n\n(읽기만 하세요. 글을 올리거나 메시지를 보내거나 지우거나 사거나 예약하거나 설정을 바꾸지 마세요.)', '\n\n(Read only. Do not post, send messages, delete, buy, book or change settings.)')}`, startUrl: start_url, unattended: true })
        let timer
        const r = await Promise.race([task, new Promise((done) => { timer = setTimeout(() => done(null), WAIT_MS) })]).finally(() => clearTimeout(timer))
        // the browser task clears the conversation's "working" state; the agent is still answering
        if (busy) await setThreadStatus(userId, threadId, 'working').catch(() => {})
        if (!r) return { state: 'running', summary: L('브라우저 작업이 아직 끝나지 않았어요. 채팅의 작업 카드에 결과가 남아요.', 'The browser task has not finished yet. Its result will be on the task card in the chat.') }
        return { state: r.state, summary: r.summary, notes: r.notes || [], url: r.url, page_text: String(r.pageText || '').slice(0, 4000) }
      },
    },
  ],
}
