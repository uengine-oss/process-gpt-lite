// An editor's own frame (IeumOffice /office/<editor>/, ArtCraft /craft/<app>/) is nested in its MCP App screen behind
// the sandbox proxy (docs/robo-dlc/plan-mcp-apps.md §5), so it is found by its address: its path and query (the
// origin is the sandbox's), '' while it is not there.
export function framePath(page, part) {
  const f = page.frames().find((x) => x.url().includes(part))
  if (!f) return ''
  const u = new URL(f.url())
  return u.pathname + u.search
}
