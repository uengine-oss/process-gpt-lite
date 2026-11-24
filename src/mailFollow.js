// A mail's follow-up actions as the screen knows them (server lib/mailFollow.js): the runs an agent action left on the card
// (source.follow.runs — 이 회사 알아보기, 제안서 초안 …) and where their result is: the mail's own conversation of the chat (/chat/c/<conv>),
// or the instance the mail belongs to (/routines/<instId>, whose work folder has it too).

// the run to say on the Home card: one still running, else the newest finished one
export function latestRun(card) {
  const runs = Object.values(card?.source?.follow?.runs || {}).filter((r) => r && r.status)
  const going = runs.find((r) => r.status === 'running')
  if (going) return going
  return runs.filter((r) => r.status === 'done').sort((a, b) => String(b.endedAt || b.at).localeCompare(String(a.endedAt || a.at)))[0] || null
}
// a run's line: 「회사 알아본 결과 · 열기」, 「이 회사 알아보기 · 하는 중…」, 「… · 하지 못했어요」
export const runLine = (r) => (r.status === 'done' ? `${r.done || r.label} · 열기` : r.status === 'running' ? `${r.label} · 하는 중…` : `${r.label} · 하지 못했어요`)
// where its result is
export const runPath = (r) => (r?.inst?.instId ? `/routines/${encodeURIComponent(r.inst.instId)}` : r?.conv ? `/chat/c/${encodeURIComponent(r.conv)}` : '/chat')
// (phone: the chat tab is shown, not Home over it)
export function openRun(app, router, r, { phone = false } = {}) {
  if (!r) return
  if (!r.inst?.instId && phone) app.dockOpen = false
  return router.push(runPath(r))
}
