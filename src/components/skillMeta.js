// Connector tools a skill names, grouped by the service a person recognises.
const SERVICES = [
  [/^youtube_/, 'YouTube'], [/^calendar_/, '캘린더'], [/^gmail_/, 'Gmail'], [/^drive_/, 'Drive'],
  [/^slack_/, 'Slack'], [/^github_/, 'GitHub'], [/^notion_/, 'Notion'],
]
export function servicesOf(tools = []) {
  const found = []
  for (const t of tools) {
    const hit = SERVICES.find(([re]) => re.test(t))
    const label = hit ? hit[1] : null
    if (label && !found.includes(label)) found.push(label)
  }
  return found
}
