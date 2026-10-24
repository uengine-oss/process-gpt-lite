// Slack, GitHub and Notion with the user's own token from the vault.
//   slack : kind 'oauth' (OAuth user token) or 'apikey' (pasted token), site 'slack'
//   github: kind 'apikey', site 'github'   (personal access token)
//   notion: kind 'apikey', site 'notion'   (internal integration secret)
import { z } from 'zod'
import { getSecret } from '../../lib/vault.js'

async function token(userId, site) {
  const sec = (await getSecret(userId, 'oauth', site)) || (await getSecret(userId, 'apikey', site))
  return sec?.access_token || sec?.key || null
}

async function call(url, { tokenValue, method = 'GET', body, headers = {} }) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tokenValue}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const j = text ? JSON.parse(text) : {}
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${j.message || j.error || text.slice(0, 200)}`)
  return j
}

// ---------- Slack ----------
async function slack(userId, method, params = {}, post) {
  const t = await token(userId, 'slack')
  const url = `https://slack.com/api/${method}` + (post ? '' : `?${new URLSearchParams(params)}`)
  const j = await call(url, { tokenValue: t, method: post ? 'POST' : 'GET', body: post ? params : undefined })
  if (j.ok === false) throw new Error(`Slack: ${j.error}`)
  return j
}

export const slackConnector = {
  name: 'slack',
  title: 'Slack',
  connected: async (u) => !!(await token(u, 'slack')),
  tools: [
    {
      name: 'slack_list_channels',
      description: 'List Slack channels the user can see.',
      input: { limit: z.number().int().max(200).optional() },
      run: async (u, { limit = 100 }) => (await slack(u, 'conversations.list', { limit, types: 'public_channel,private_channel', exclude_archived: true })).channels.map((c) => ({ id: c.id, name: c.name, members: c.num_members })),
    },
    {
      name: 'slack_read_channel',
      description: 'Read recent messages of a channel (id or #name). oldest = unix seconds to only get newer messages.',
      input: { channel: z.string(), oldest: z.string().optional(), limit: z.number().int().max(200).optional() },
      run: async (u, { channel, oldest, limit = 50 }) => {
        let id = channel
        if (!/^[CG][A-Z0-9]+$/.test(channel)) {
          const name = channel.replace(/^#/, '')
          const list = await slack(u, 'conversations.list', { limit: 1000, types: 'public_channel,private_channel' })
          id = list.channels.find((c) => c.name === name)?.id
          if (!id) throw new Error(`channel ${channel} not found`)
        }
        const h = await slack(u, 'conversations.history', { channel: id, limit, ...(oldest && { oldest }) })
        return h.messages.map((m) => ({ ts: m.ts, user: m.user, text: m.text }))
      },
    },
    {
      name: 'slack_post_message',
      description: 'Post a message to a Slack channel as the user. Confirm with the user before posting to shared channels.',
      input: { channel: z.string(), text: z.string() },
      run: async (u, { channel, text }) => { const r = await slack(u, 'chat.postMessage', { channel, text }, true); return { ts: r.ts, channel: r.channel } },
    },
  ],
}

// ---------- GitHub ----------
const gh = async (u, p, opts = {}) => call(`https://api.github.com${p}`, { tokenValue: await token(u, 'github'), headers: { Accept: 'application/vnd.github+json' }, ...opts })

export const githubConnector = {
  name: 'github',
  title: 'GitHub',
  connected: async (u) => !!(await token(u, 'github')),
  tools: [
    {
      name: 'github_search_issues',
      description: 'Search GitHub issues and pull requests (GitHub search syntax, e.g. "repo:owner/name is:open label:bug").',
      input: { query: z.string(), max: z.number().int().max(50).optional() },
      run: async (u, { query, max = 20 }) => (await gh(u, `/search/issues?per_page=${max}&q=${encodeURIComponent(query)}`)).items.map((i) => ({ number: i.number, title: i.title, state: i.state, url: i.html_url, repo: i.repository_url.split('/repos/')[1], pr: !!i.pull_request, updated_at: i.updated_at })),
    },
    {
      name: 'github_list_prs',
      description: 'Open pull requests that involve the user (authored, assigned or review requested).',
      input: { max: z.number().int().max(50).optional() },
      run: async (u, { max = 20 }) => {
        const me = await gh(u, '/user')
        return (await gh(u, `/search/issues?per_page=${max}&q=${encodeURIComponent(`is:pr is:open involves:${me.login}`)}`)).items.map((i) => ({ number: i.number, title: i.title, url: i.html_url, repo: i.repository_url.split('/repos/')[1], updated_at: i.updated_at }))
      },
    },
    {
      name: 'github_create_issue',
      description: 'Create an issue in a repository (owner/name).',
      input: { repo: z.string(), title: z.string(), body: z.string().optional(), labels: z.array(z.string()).optional() },
      run: async (u, { repo, title, body, labels }) => { const i = await gh(u, `/repos/${repo}/issues`, { method: 'POST', body: { title, body, labels } }); return { number: i.number, url: i.html_url } },
    },
  ],
}

// ---------- Notion ----------
const NV = { 'Notion-Version': '2022-06-28' }
const notion = async (u, p, opts = {}) => call(`https://api.notion.com/v1${p}`, { tokenValue: await token(u, 'notion'), headers: NV, ...opts })
const plain = (rich = []) => rich.map((r) => r.plain_text).join('')
const titleOf = (page) => plain(Object.values(page.properties || {}).find((p) => p.type === 'title')?.title)

// markdown-ish text → Notion blocks (headings, bullets, paragraphs)
function toBlocks(md) {
  return String(md || '').split('\n').filter((l) => l.trim()).slice(0, 100).map((l) => {
    const text = (s) => [{ type: 'text', text: { content: s.slice(0, 2000) } }]
    const h = /^(#{1,3})\s+(.*)/.exec(l)
    if (h) { const t = `heading_${h[1].length}`; return { object: 'block', type: t, [t]: { rich_text: text(h[2]) } } }
    const b = /^\s*[-*]\s+(.*)/.exec(l)
    if (b) return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: text(b[1]) } }
    return { object: 'block', type: 'paragraph', paragraph: { rich_text: text(l) } }
  })
}

export const notionConnector = {
  name: 'notion',
  title: 'Notion',
  connected: async (u) => !!(await token(u, 'notion')),
  tools: [
    {
      name: 'notion_search',
      description: 'Search Notion pages shared with the integration.',
      input: { query: z.string() },
      run: async (u, { query }) => (await notion(u, '/search', { method: 'POST', body: { query, page_size: 20 } })).results.map((r) => ({ id: r.id, type: r.object, title: r.object === 'page' ? titleOf(r) : plain(r.title), url: r.url })),
    },
    {
      name: 'notion_read_page',
      description: 'Read the text of a Notion page.',
      input: { pageId: z.string() },
      run: async (u, { pageId }) => {
        const page = await notion(u, `/pages/${pageId}`)
        const blocks = await notion(u, `/blocks/${pageId}/children?page_size=100`)
        return { title: titleOf(page), url: page.url, text: blocks.results.map((b) => plain(b[b.type]?.rich_text)).filter(Boolean).join('\n') }
      },
    },
    {
      name: 'notion_create_page',
      description: 'Create a page under a parent page id with a title and markdown-like content.',
      input: { parentPageId: z.string(), title: z.string(), markdown: z.string().optional() },
      run: async (u, { parentPageId, title, markdown }) => {
        const p = await notion(u, '/pages', { method: 'POST', body: { parent: { page_id: parentPageId }, properties: { title: { title: [{ text: { content: title } }] } }, children: toBlocks(markdown) } })
        return { id: p.id, url: p.url }
      },
    },
    {
      name: 'notion_append_to_page',
      description: 'Append markdown-like content to the end of a page.',
      input: { pageId: z.string(), markdown: z.string() },
      run: async (u, { pageId, markdown }) => { await notion(u, `/blocks/${pageId}/children`, { method: 'PATCH', body: { children: toBlocks(markdown) } }); return { ok: true } },
    },
  ],
}
