// 회사 프로세스 지도 공용: 비율 · 날짜 · 대기 시간 표기, 출처 이름, 띠 이름
export const END = '__end__'
export const THETAS = [0, 0.01, 0.02, 0.05, 0.1, 0.2]

// 35% · 4% · 0.5% (작은 값은 소수 한 자리)
export const pct = (x) => {
  if (x == null || Number.isNaN(x)) return '–'
  const v = x * 100
  return `${v > 0 && v < 1 ? v.toFixed(1) : Math.round(v)}%`
}
const D = (t) => (t instanceof Date ? t : new Date(t))
// 「11월 12일」 · 「11월 12일 14:05」 — 손으로 짠다(영어 모드 사전이 이 모양을 옮긴다)
export const dateKo = (t) => (t ? `${D(t).getMonth() + 1}월 ${D(t).getDate()}일` : '')
export const dateTimeKo = (t) => (t ? `${dateKo(t)} ${String(D(t).getHours()).padStart(2, '0')}:${String(D(t).getMinutes()).padStart(2, '0')}` : '')
// YYYY-MM-DD in local time (the date control's value)
export const ymd = (t) => {
  const d = D(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// 평균 대기: 시간 → 「40분」 · 「5시간」 · 「1.5일」
export function waitText(h) {
  if (h == null || Number.isNaN(h)) return '–'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}분`
  if (h < 24) return `${h < 10 ? +h.toFixed(1) : Math.round(h)}시간`
  const d = h / 24
  return `${d < 10 ? +d.toFixed(1) : Math.round(d)}일`
}
export const SOURCE_KO = { mail_history: '메일', chat_handover: '채팅', agent_delegation: '위임', todolist: '실행' }
export const BAND = { paved: '굳은 길', open: '열린 일', watch: '지켜보기' }
export const HOW_KO = { same: '같은 이름', alias: '다른 이름으로 맞춤', model: '새 이름', candidate: '후보', none: '일 아님' }
export const taskName = (key) => (key === END ? '끝' : key)
// v0.3 사건 · 역할 · 습관
export const CLS_KO = { slides: '슬라이드', doc: '문서', sheet: '표', pdf: 'PDF', audio: '오디오', image: '그림', video: '영상', drawing: '도면', link: '링크 · 파일' }
export const EVENT_KO = { mail: '메일', artifact: '결과물', message: '채팅', link: '링크', time: '정한 시각', timer: '타이머', done: '일이 끝남' }
export const TRIG_SOURCE_KO = { mined: '메일 · 인계에서', habit: '개인 습관', told: '직접 말함', rule: '방 규칙', timer: '예약(타이머)' }
export const SPLIT_KO = { and: '함께', xor: '하나만' }
export const HABIT_MODE_KO = { threshold: '기준 이상만', all: '모두(이름 없이)', off: '끄기' }
// 「role:영업」 → 「영업」
export const scopeRole = (scope) => (String(scope || '').startsWith('role:') ? String(scope).slice(5) : '')

// a learned condition as people read it: 「금액(amount)이 …」 keeps the field name for the engine, the screen drops it
export const condText = (s) => String(s || '').replace(/\s*\([a-z_][a-z0-9_]*\)/gi, '')
