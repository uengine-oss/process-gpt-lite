// 프로세스 온톨로지 카드 · 패널 공용(지도 화면의 fmt.js 와 별개): 조사, 효력일, 이름표
import { ymd } from './fmt.js'

// 받침 있는 말 뒤엔 「으로」 · 「을」 · 「은」, 없으면 「로」 · 「를」 · 「는」 (ㄹ 받침은 「로」)
const jong = (w) => {
  const ch = String(w || '').trim().slice(-1)
  const code = ch.charCodeAt(0) - 0xac00
  if (code < 0 || code > 11171) return 0
  return code % 28
}
// 조사만: 「재무 검토」로 · 「견적서 작성」으로 — `「${w}」${RO(w)}`
export const RO = (w) => (jong(w) && jong(w) !== 8 ? '으로' : '로')
export const EUL = (w) => (jong(w) ? '을' : '를')
export const EUN = (w) => (jong(w) ? '은' : '는')

// 효력일: 오늘(또는 비어 있음)이면 「지금부터」(보내지 않음), 다른 날이면 그날 0시(이 기기 시간)
export const today = () => ymd(new Date())
export function validFromOf(date) {
  if (!date || date <= today()) return undefined
  const d = new Date(`${date}T00:00:00`)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}
export const dayKo = (date) => {
  if (!date) return ''
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00`)
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })
}

export const ACT_KO = { request: '요청', deliver: '전달', ask: '문의', confirm: '확인', other: '기타' }
export const KIND_KO = { retire: '은퇴 후보', firmed: '굳어짐', retired: '은퇴함', 'pin-skipped': '고정 건너뜀' }
export const DECISION_KO = { 'ontology.pin': '고정', 'ontology.unpin': '고정 풀기', 'ontology.retire': '은퇴', 'ontology.revive': '되살림', 'ontology.promote': '자동으로 승격', 'ontology.demote': '승격 낮춤', 'ontology.timer': '타이머 걸기', 'ontology.timer_on': '타이머 켬', 'ontology.timer_pause': '타이머 멈춤', 'ontology.timer_off': '타이머 지움' }
export const TODO_KO = { DONE: '끝남', IN_PROGRESS: '하는 중', TODO: '할 일', NEW: '할 일', SUBMITTED: '제출됨', PENDING: '기다림', CANCELLED: '취소됨' }
export const RUNNER_KO = { person: '사람', agent: '에이전트' }
export const AUTONOMY_KO = { draft: '초안까지', review: '검토 받고', auto: '알아서 끝까지', complete: '알아서 끝까지' }

// 카드의 로컬 상태(서버가 카드 내용을 바꾸지 않는 동안): 이 기기에서만, 없어도 화면은 그려진다
export const local = {
  get(k) { try { return JSON.parse(localStorage.getItem(`onto:${k}`) || 'null') } catch { return null } },
  set(k, v) { try { localStorage.setItem(`onto:${k}`, JSON.stringify(v)) } catch { /* private window */ } },
}
