// 팀 활동 화면들이 함께 쓰는 표기: 깊이 이름, 작업 유형 색, 시각, 비용
export const DEPTH = { title: '제목', summary: '요약', content: '원문' }
export const KIND_COLOR = { 조사: '#4C8DF6', '문서 작성': '#9B6BF2', '분석·계산': '#F2A33A', 코드: '#3BB98A', '회의 준비': '#E8618C', '메일·연락': '#39B6C8', 기타: '#9AA0A6' }
export const kindColor = (k) => KIND_COLOR[k] || '#9AA0A6'

export function ago(t) {
  if (!t) return ''
  const d = new Date(t), s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  if (s < 2 * 86400) return '어제'
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}일 전`
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })
}
export const stamp = (t) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
export const credits = (c) => (c ? `${Number(c.credits || 0).toLocaleString('ko-KR')} 크레딧` : '')
