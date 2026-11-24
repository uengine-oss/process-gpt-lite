// What a mail's Home card is for, as the screen knows it (server lib/mailCard.js kindOf), and the card's button word in the
// person's language. The stored verb stays the triage's English word (Reply, Add, Pay …); the screen shows 「답장」 · 「추가」 …,
// and 「일정 추가」 for a card that puts an event on the calendar — the Home card, the chat's mail chip, the mail sheet, the inbox.
import { isEnglish } from './i18n/lang.js'

export const KINDS = ['calendar', 'reply', 'task']

// 'reply' | 'calendar' | 'task', or null when not decided yet (the mail sheet asks the server, which asks the judge once)
export function cardKind(a) {
  const s = a?.source
  if (!s?.mail_id) return null
  if (a.verb === 'Reply' || s.drafts?.length || s.kind === 'reply') return 'reply'
  return KINDS.includes(s.kind) ? s.kind : null
}

const KO = {
  Reply: '답장', Pay: '납부', Release: '처리', Remind: '알림', Add: '추가', Review: '검토', Call: '전화', Book: '예약', Sign: '서명',
  Confirm: '확인', Check: '확인', Send: '보내기', Submit: '제출', Approve: '승인', Attend: '참석', Schedule: '일정', Join: '참석',
}

// the button word: 「일정 추가」 / "Add to calendar" for a calendar card, else the verb in the screen's language
export function verbLabel(a, kind = cardKind(a)) {
  if (kind === 'calendar') return isEnglish ? 'Add to calendar' : '일정 추가'
  const v = String(a?.verb || '').trim()
  return isEnglish ? v : KO[v] || v
}
