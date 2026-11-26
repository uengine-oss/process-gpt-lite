// What the sender's card says about each person a file went to (2026-11-26, the user's phone — a group room's 「보냄 · 공유」 card listed
// 「… 아직 그대로」 for someone who said he had opened it: 「아직그대로는 뭔가? 혹시 확인여부 ㅡ 파일을 열어서 봤는지라면 좋은데 ○○○께서
// 열어보셨다는데 아직그대로로 표시된」. That line only said their copy had not changed). Now, in this order:
//   their copy changed          「2개 고침 · 1개 추가 · 3분 전」   (what the line said before, when it changed)
//   they opened it              「열어 봄 · 3분 전」 — the first time; of a few files only some: 「파일 3개 중 1개 열어 봄 · 3분 전」
//   they have not opened it     「안 열어 봄」
// r: one person as GET /team/threads/:id/receipts gives it ({files, opened, openedAt, lastOpenedAt, branch}); when: how a time reads
// (the messenger's 「3분 전」). No page, no network: team/Messenger.vue and server/test/shareReceipts.test.js use it.

export function receiptOf(r, when = (d) => String(d)) {
  const b = r?.branch
  const parts = b ? [
    b.modified?.length && `${b.modified.length}개 고침`,
    b.added?.length && `${b.added.length}개 추가`,
    b.removed?.length && `${b.removed.length}개 지움`,
  ].filter(Boolean) : []
  if (parts.length && b.at) return { state: 'changed', text: `${parts.join(' · ')} · ${when(b.at)}` }
  const files = Number(r?.files) || 0
  const opened = Number(r?.opened) || 0
  if (opened > 0 && r?.openedAt) {
    const what = files > 1 && opened < files ? `파일 ${files}개 중 ${opened}개 열어 봄` : '열어 봄'
    return { state: 'opened', text: `${what} · ${when(r.openedAt)}` }
  }
  return { state: 'unopened', text: '안 열어 봄' }
}

// the line's hint: when they last opened it, if that was after the first time
export function receiptHint(r, when = (d) => String(d)) {
  if (!r?.openedAt || !r?.lastOpenedAt) return ''
  return new Date(r.lastOpenedAt) - new Date(r.openedAt) > 1000 ? `마지막으로 연 때 ${when(r.lastOpenedAt)}` : ''
}
