// What every Lite request to the company's agent (deepagents /chat/stream — a chat turn lib/agent.js, a scheduled skill lib/missions.js,
// a shared folder's run lib/folders/runner.js, and any new call site) carries in its metadata besides its own: the tools and tool servers
// that request must not get. One helper, so no call site sends a request without them (config.hiddenTools · hiddenServers).
import { config } from '../config.js'

export const hiddenMeta = () => ({
  ...(config.hiddenTools.length ? { hidden_tools: [...config.hiddenTools] } : {}),
  ...(config.hiddenServers.length ? { hidden_tool_servers: [...config.hiddenServers] } : {}),
})
// metadata for an agent request: the call site's own fields, then the hidden lists (a call site cannot leave them out)
export const agentMetadata = (own = {}) => ({ ...own, ...hiddenMeta() })

// A tool name as the agent reports it: the name itself, or with its server's name in front (`gmail-mcp_send_email`,
// `server__send_email`, `server.send_email`) — the same tool (deepagents core/llm/mcp.py is_hidden_name reads it the same way)
const SEPARATORS = ['_', '.', '-', '/', ':']
export function isHiddenTool(name, hidden = config.hiddenTools) {
  const n = String(name || '')
  if (!n) return false
  return hidden.some((h) => n === h || SEPARATORS.some((s) => n.endsWith(s + h)))
}
