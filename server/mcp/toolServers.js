// The built-in tool servers every Lite agent gets, with no account to connect: this server answers each at /mcp/<path>,
// and mcp-hub, the tenant MCP list and process-gpt's common MCP list (deepagents COMMON_MCP_SERVERS, GET /mcp/common) all
// call it pgpt-<path>. One list, so the hub binding (mcp/connectors.js), the wiring check (lib/agentTools.js → /api/config
// agentTools) and the common list cannot drift apart. No imports on purpose: mcp/craft.js · mcp/office.js sit in an import
// cycle with connectors.js (through lib/missions.js); test/agentTools.test.js checks the names against theirs.
export const CRAFT_APP_NAMES = ['cadcraft', 'vectorcraft', 'photocraft', 'soundcraft', 'filmcraft']
// mcp/office.js OFFICE_MCP (long on purpose — see there); /mcp/office is the short alias of the same tools
export const OFFICE_SERVER_PATH = 'ieumoffice-live-editor'

// key: where it shows in /api/config agentTools ('craft.<app>' → agentTools.craft[app]); paths: every /mcp/<path> this
// server answers the same tools at; server: the name the hub and the common list use
export const LITE_TOOL_SERVERS = [
  { key: 'folders', paths: ['folders'] },
  { key: 'panelapps', paths: ['panelapps'] },
  { key: 'improve', paths: ['improve'] },
  ...CRAFT_APP_NAMES.map((app) => ({ key: `craft.${app}`, paths: [app] })),
  { key: 'office', paths: [OFFICE_SERVER_PATH, 'office'] },
].map((s) => ({ ...s, server: `pgpt-${s.paths[0]}` }))

export const LITE_TOOL_SERVER_NAMES = LITE_TOOL_SERVERS.map((s) => s.server)
