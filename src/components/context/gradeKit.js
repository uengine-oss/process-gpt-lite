// 공개 등급 화면(등급 고르기 · 공유와 허락 · 맥락 보기)이 함께 쓰는 이름표와 도우미. 서버의 lib/context/visibility.js 와 같은 말을 쓴다.
import { Marked } from 'marked'

export const GRADES = ['private', 'listed', 'summary', 'open']
export const GRADE = { private: '비공개', listed: '제목 공개', summary: '요약 공개', open: '전체 공개' }
export const REACH = { team: '팀', department: '부서', company: '회사' }
export const DEPTH = { none: '없음', title: '제목', summary: '요약', content: '원문' }
export const DURATION = { task: '이 작업 동안', '7d': '7일', forever: '회수할 때까지' }
// 등급마다 한 줄 설명(무엇이 누구에게 보이나)
export const INFO = {
  private: '나만 봅니다 · 다른 사람에게는 존재도 숨김',
  listed: '회사 전체가 제목만 · 내용은 요청하면 봅니다',
  summary: '범위 안은 요약까지 · 원문은 요청하면 봅니다',
  open: '범위 안은 원문까지 봅니다',
}
export const wide = (v) => v === 'summary' || v === 'open'
export const gradeLabel = (v, r) => (wide(v) ? `${GRADE[v]} · ${REACH[r] || REACH.team}` : GRADE[v] || GRADE.private)
const ORDER = ['none', 'title', 'summary', 'content']
export const atLeast = (d, need) => ORDER.indexOf(d) >= ORDER.indexOf(need)

// 「으로/로」(받침 없음·ㄹ 받침은 로) — 서버 grade.js 의 ro 와 같다
export function ro(word) {
  const s = String(word || '').replace(/[\s\p{P}\p{S}]+$/u, '')
  const c = s.charCodeAt(s.length - 1) - 0xac00
  if (!(c >= 0 && c < 11172)) return '로'
  const j = c % 28
  return j && j !== 8 ? '으로' : '로'
}

export function ago(t) {
  if (!t) return ''
  const d = new Date(t), mins = Math.round((Date.now() - d) / 60000)
  if (mins < 1) return '방금'
  if (mins < 60) return `${mins}분 전`
  if (mins < 1440) return `${Math.round(mins / 60)}시간 전`
  if (mins < 1440 * 7) return `${Math.round(mins / 1440)}일 전`
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })
}
export const when = (t) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')

// 남의 답 원문을 그릴 때: 마크다운(표·목록)은 살리고 날 HTML·스크립트 주소는 버린다
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const safe = new Marked({ gfm: true, breaks: true })
safe.use({ renderer: {
  html: () => '',
  link(t) { return /^(https?:|mailto:|\/)/i.test(t.href || '') ? false : esc(t.text) },
  image(t) { return esc(t.text || '') },
} })
export const md = (t) => safe.parse(String(t || ''))
