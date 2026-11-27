// 「내 계정으로 보내기」 for agents at /mcp/mail (pgpt-mail — a built-in tool server like /mcp/folders: process-gpt's common MCP list
// gives it to every company's agent, mcp/toolServers.js). Its one tool never sends: it puts a 「보낼 메일」 card in the chat of the
// agent turn that called it (lib/mailOut.js), and the mail leaves from the person's own connected mailbox when they press 보내기.
// The caller's JWT (Authorization: Bearer {{user_jwt}}) says whose mail it is; nothing here takes a sender from the arguments.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { userFromJwt } from '../lib/supa.js'
import { signedIn } from '../lib/people.js'
import { propose, toolResult } from '../lib/mailOut.js'
import { L, isEn, langOf, withLang } from '../lib/lang.js'

export const MAIL_TOOL = 'send_mail_as_me'
const schema = (en) => ({
  type: 'object',
  properties: {
    to: { type: 'array', items: { type: 'string' }, description: en ? 'Recipients ("Name <address>" or an address). For a reply you may leave it empty: it then goes where the mail asks replies to go.' : '받는 사람("이름 <주소>" 또는 주소). 받은 메일에 대한 답장이면 비워도 된다 — 그 메일의 Reply-To(없으면 보낸 사람)로 간다.' },
    cc: { type: 'array', items: { type: 'string' }, description: en ? 'Cc' : '참조' },
    subject: { type: 'string', description: en ? 'Subject. A reply keeps the original subject with "Re: " in front.' : '제목. 답장이면 원래 제목 앞에 "Re: "를 붙인 그대로.' },
    body: { type: 'string', description: en ? 'The whole body, plain text, exactly as it should go — with every correction the person asked for in this conversation applied.' : '보낼 본문 전체(일반 텍스트). 이 대화에서 사람이 고쳐 달라고 한 것을 모두 반영한 최종본 그대로.' },
    reply_to: {
      type: 'object', description: en ? 'The mail this answers, if it answers one: its id when you know it (a Home card or mail chip id), and its subject.' : '받은 메일에 대한 답장이면 그 메일: 알면 id(Home 카드 · 메일 칩의 id)와 원래 제목.',
      properties: { mail_id: { type: 'string' }, subject: { type: 'string' } },
    },
    attachments: { type: 'array', items: { type: 'string' }, description: en ? 'File names to attach — files in this chat (a document made here, a file put here).' : '첨부할 파일 이름 — 이 채팅의 파일(여기서 만든 문서, 여기에 올린 파일).' },
  },
  required: ['subject', 'body'],
})
const TOOLS = [{
  name: MAIL_TOOL,
  description: '사람을 대신해 메일을 보낼 때 쓰는 도구. 그 사람이 연결한 자기 메일 계정에서, 받은 메일에 대한 답장이면 그 메일의 스레드 안에서 나간다. '
    + '이 도구는 스스로 보내지 않는다: 채팅에 「보낼 메일」 카드(보낸 사람 · 받는 사람 · 제목 · 스레드 · 본문 · 첨부)를 띄우고, 사람이 카드에서 「보내기」를 눌러야 나간다. '
    + '사람이 「보내」라고 말해도 이 카드를 띄우는 데까지만 한다. 본문에는 이 대화에서 사람이 준 내용과 고쳐 달라고 한 것을 모두 반영한다. 결과를 받은 뒤 보냈다고 말하지 말 것.',
  inputSchema: schema(false),
}]
const TOOLS_EN = [{
  name: MAIL_TOOL,
  description: "The tool for sending a mail on the person's behalf. It goes out from the mailbox the person connected, and a reply goes in the thread of the mail it answers. "
    + 'It never sends by itself: it shows a "Mail to send" card in the chat (from, to, subject, thread, body, files), and the mail leaves only when the person presses Send on the card. '
    + 'Even when the person says "send it", this only shows the card. Put everything the person gave and every correction they asked for in this conversation into the body. Never say it was sent.',
  inputSchema: schema(true),
}]

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }] })

export async function callMailTool(user, name, args = {}) {
  if (name !== MAIL_TOOL) return { isError: true, ...text(`unknown tool ${name}`) }
  const { view } = await propose(user, args)
  return text(toolResult(view))
}

function buildServer(user) {
  const server = new Server({ name: 'pgpt-mail', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: isEn() ? TOOLS_EN : TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!user) return { isError: true, ...text('unauthorized: call with the user JWT (Authorization: Bearer {{user_jwt}})') }
    try {
      console.log(`[mcp] mail.${params.name} user=${user.id.slice(0, 8)}`)
      return await callMailTool(user, params.name, params.arguments || {})
    } catch (e) {
      if (!e.status) console.warn('[mcp] mail', e.message)
      return { isError: true, ...text(e.status ? e.message : L('보낼 메일 카드를 띄우지 못했어요.', "Couldn't show the mail card.")) }
    }
  })
  return server
}

// mounted before the generic /mcp/:connector route
export function mountMail(app) {
  app.post('/mcp/mail', async (req, res) => {
    let jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (/^\{\{\s*user_jwt\s*\}\}$/.test(jwt)) jwt = ''
    const u = jwt ? await userFromJwt(jwt) : null
    if (jwt && !u) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: invalid or expired user JWT' }, id: null })
    const user = u ? { id: u.id, email: u.email, name: (await signedIn(u)).name } : null
    // an agent calls this without the page's X-PGL-Lang: the caller's saved language decides
    await withLang(isEn() ? 'en' : user ? await langOf(user.id) : 'ko', async () => {
      const server = buildServer(user)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => { transport.close(); server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    })
  })
}
