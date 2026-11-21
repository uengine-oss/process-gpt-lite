// Chat words about a scheduled task that already exists (2026-11-21 phone review):
//   "곧바로 하나 정도 한번 실행해 봐" — run it now, once. The router read it as a new schedule one
//   minute later (in_minutes: 1) and made a second task.
//   "급등락이 감지되면 내 텔레그램 봇으로 알려줘" — send that task's alerts to Telegram too.
// Pure: which words mean which, and which of the person's tasks they are about.

// a delay or a time of day makes it a new schedule, not "now" ("10분 뒤에 한 번 실행해 줘", "내일 9시에")
const LATER = /\d+\s*(초|분|시간|일)\s*(뒤|후|있다가|이따)|내일|모레|다음\s*주|오전|오후|\d+\s*시(?!간)|매일|매주|매달|마다|\b(in \d+|tomorrow|at \d|every)\b/i
const RUN_NOW = [
  // 지금 · 곧바로 · 바로 · 당장 · 먼저 · 일단 · 테스트로 … 실행/돌려 (해 봐 · 해 줘)
  /(지금|곧바로|바로|당장|먼저|일단|우선|시험\s*삼아|테스트\s*(로|삼아)?|시험\s*으?로)[^.?!\n]{0,16}(실행|돌려|돌리|run)/i,
  // 한 번(하나) 실행해 봐 — a try of what was just set up
  /(한\s*번|한번|하나)[^.?!\n]{0,10}(실행|돌려)\s*(해\s*)?(봐|보자|볼래|줘|주세요|줄래)/i,
  /\b(run|try) (it|this|that|the (task|schedule|job))( once)? (now|right now|once)\b|\brun (it )?now\b/i,
]
// something else to run ("휴가 신청 프로세스 바로 실행해줘", "이 스크립트 먼저 실행해 봐")
const OTHER_TARGET = /프로세스|스크립트|코드|스킬|명령|파일|프로그램|앱|테스트\s*케이스|브라우저|\b(process|script|code|skill|command|file|app)\b/i
export function wantsRunNow(text) {
  const t = String(text || '')
  if (t.length > 160 || LATER.test(t) || OTHER_TARGET.test(t)) return false
  return RUN_NOW.some((re) => re.test(t))
}

// Telegram: off · alerts (a task's results) · send (this answer, now)
// (null — the router's: "텔레그램 봇 만드는 방법 알려줘" is a question, "매일 아침 텔레그램 채널 요약해서 알려줘" a new schedule)
const HOW_TO = /방법|어떻게|뭐야|무엇|란\s|이란|\bhow\b|\bwhat\b/i
const NEW_JOB = /매일|매주|매달|매시|마다|정기|아침|저녁|\d+\s*시(?!간)|\b(every|daily|weekly)\b/i
export function telegramIntent(text) {
  const t = String(text || '')
  if (!/텔레그램|telegram|텔레\s*봇/i.test(t)) return null
  if (HOW_TO.test(t) || /채널|그룹|channel|group/i.test(t)) return null
  if (/(알림|보내|알려)[^.?!\n]{0,12}(끄|꺼|그만|멈춰|해제|중지|말아)|\b(stop|turn off|disable)\b/i.test(t)) return 'off'
  if (/연결|등록|붙여|설정|\bconnect\b|\bset ?up\b/i.test(t) && !/(알려|보내)/.test(t)) return 'connect'
  if (/(이거|이것|방금|위|이\s*결과|결과|답|내용)[^.?!\n]{0,12}(보내|전달|공유)|\b(send|forward) (this|it|that)\b/i.test(t)) return 'send'
  if (NEW_JOB.test(t)) return null
  // a condition on a task's result, said with "tell me / send me": that task's alerts ("감지되면 … 알려줘")
  const tell = /(알려|알림|보내|받|전달)|\b(notify|alert|send|tell)\b/i.test(t)
  if (tell && (/(되면|하면|있으면|생기면|오면|넘으면|때마다|때는|경우|감지|급등|급락|변동|알림)/.test(t) || /\b(when|whenever|if)\b/i.test(t))) return 'alerts'
  if (tell && /(으로|로)\s*(도\s*)?(알려|보내|받)/.test(t)) return 'alerts'
  return null
}

// the scheduled task a message is about: one it names, else the one this conversation set up or ran
// last (a 「예약됨」 chip or a run's divider carries its id), else (only = true) the only one the person has.
// "바로 실행해 줘" may be about a process to start: running a task takes its name or a recent mention.
export function pickSchedule(schedules, text, recentIds = [], { only = true } = {}) {
  const list = (schedules || []).filter((s) => s && s.id)
  if (!list.length) return null
  const t = String(text || '').replace(/\s+/g, '')
  const named = list.filter((s) => s.name && s.name.replace(/\s+/g, '').length >= 4 && t.includes(s.name.replace(/\s+/g, '')))
  if (named.length) return named[0]
  for (const id of recentIds) {
    const s = list.find((x) => x.id === id)
    if (s) return s
  }
  if (!only) return null
  const active = list.filter((s) => !s.paused)
  return active.length === 1 ? active[0] : null
}

// schedule ids in a conversation's rows, newest first (store.history rows: { kind, content })
export function recentScheduleIds(rows) {
  const ids = []
  for (const r of [...(rows || [])].reverse()) {
    const id = r?.content?.scheduleId
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

// where a task's results go besides the chat (pro_schedules.state.channels)
export const channelsOf = (s) => (Array.isArray(s?.state?.channels) ? s.state.channels : [])
export const sendsToTelegram = (s) => channelsOf(s).includes('telegram')
