// 프로세스 개선 화면 공용: 시간·비율 표기, 리드타임 구간 색(process-gpt LeadTimeBreakdownBar 와 같은 색: 행위자 기준)
export function dur(sec, { short = false } = {}) {
  if (sec == null || Number.isNaN(sec)) return '–'
  const s = Math.abs(sec)
  if (s >= 86400) return `${(sec / 86400).toFixed(1)}일`
  if (s >= 3600) return `${(sec / 3600).toFixed(1)}${short ? 'h' : '시간'}`
  if (s >= 60) return `${Math.round(sec / 60)}분`
  return `${Math.round(sec)}초`
}
export const pct = (x, d = 0) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`)
export const won = (v) => (v >= 1e8 ? `${+(v / 1e8).toFixed(2)}억` : v >= 1e4 ? `${Math.round(v / 1e4).toLocaleString('ko-KR')}만` : String(v))
export const day = (t) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')

export const SEG = [
  { key: 'queue_wait', label: '큐 대기', color: '#8A8A8A' },
  { key: 'review_wait', label: '검토 대기', color: '#B08900' },
  { key: 'human_work', label: '사람 판단', color: '#C2410C' },
  { key: 'agent_work', label: '에이전트 수행', color: '#1D6F8B' },
  { key: 'rework', label: '재작업', color: '#7C3AED' },
  { key: 'idle_gap', label: '유휴', color: '#C9C9C9' },
]
export const SEG_BY = Object.fromEntries(SEG.map((s) => [s.key, s]))

// process-gpt BottleneckAnalysis 의 지표 정의(공식 포함)
export const METRICS = {
  duration: { label: '소요시간', unit: '중앙값', formula: '단계에 도달한 때부터 끝날 때까지(대기 포함)의 중앙값', value: (s) => s.medianDuration, show: (s) => dur(s.medianDuration) },
  frequency: { label: '실행 횟수', unit: '회', formula: '이 단계를 거친 건수(보완으로 다시 거친 것 포함)', value: (s) => s.frequency, show: (s) => `${s.frequency}회` },
  bottleneck: { label: '병목 점수', unit: '%', formula: '실행 횟수 × 평균 소요시간 — 전체 합 대비 몫(합이 100%)', value: (s) => s.normalizedBottleneck, show: (s) => `${Math.round(s.normalizedBottleneck)}%` },
  rework: { label: '재작업률', unit: '%', formula: '(반복 건수 ÷ 전체 건수) × 100 — 같은 건에서 두 번 이상 실행된 비율', value: (s) => s.reworkRate, show: (s) => `${s.reworkRate.toFixed(1)}%` },
  waiting: { label: '대기 시간', unit: '중앙값', formula: '도달 → 착수(큐 대기 + 검토 대기)의 중앙값', value: (s) => s.medianWait, show: (s) => dur(s.medianWait) },
}

export const CHANGE_LABEL = {
  predraft: '에이전트 사전 초안(사람은 확인만)', skip: '기준 미만이면 건너뛰기', automate: '에이전트로 자동화',
  parallel: '앞 단계와 동시에', capacity: '담당 인원 추가', rework: '보완 요청 줄이기',
}
