// 공유 폴더 화면이 쓰는 작은 도우미: 파일 종류, 크기 표기, 줄 단위 차이, 코드 강조.
export const ext = (p) => String(p || '').split('?')[0].split('.').pop().toLowerCase()
export const baseName = (p) => String(p || '').split('/').pop()
export const dirName = (p) => (String(p).includes('/') ? String(p).slice(0, String(p).lastIndexOf('/')) : '')

// 채팅 파일 카드(Message.vue)와 같은 색 구분
const KIND = { hwp: 'hwp', hwpx: 'hwp', docx: 'doc', odt: 'doc', xlsx: 'xls', xls: 'xls', csv: 'xls', pptx: 'ppt', pdf: 'pdf', dxf: 'cad', dwg: 'cad', svg: 'vec', psd: 'img', png: 'img', jpg: 'img', jpeg: 'img', webp: 'img', gif: 'img', wav: 'snd', mp3: 'snd', flac: 'snd', mp4: 'vid', mov: 'vid', webm: 'vid', md: 'md', markdown: 'md', py: 'code', js: 'code', ts: 'code', vue: 'code', json: 'code', sh: 'code', yaml: 'code', yml: 'code', txt: 'txt' }
export const kindOf = (p) => KIND[ext(p)] || 'etc'
export const kindLabel = { hwp: '한글', doc: 'DOC', xls: 'XLS', ppt: 'PPT', pdf: 'PDF', cad: 'CAD', vec: 'SVG', img: 'IMG', snd: 'AUD', vid: 'VID', md: 'MD', code: '</>', txt: 'TXT', etc: 'FILE' }

// 미리보기 방식
export function viewOf(p) {
  const e = ext(p)
  if (['md', 'markdown'].includes(e)) return 'markdown'
  if (e === 'csv') return 'csv'
  if (['py', 'js', 'ts', 'vue', 'json', 'sh', 'yaml', 'yml'].includes(e)) return 'code'
  if (e === 'txt') return 'text'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(e)) return 'image'
  if (['mp4', 'mov', 'webm'].includes(e)) return 'video'
  if (['wav', 'mp3', 'flac', 'ogg'].includes(e)) return 'audio'
  // PDF 도 이음오피스 PDF 편집기(읽기 전용)로 연다 — 브라우저 내장 뷰어보다 화면이 한결같다
  if (['docx', 'xlsx', 'pptx', 'hwp', 'hwpx', 'odt', 'xls', 'pdf'].includes(e)) return 'office'
  if (['dxf', 'dwg', 'psd', 'psb'].includes(e)) return 'craft'
  return 'none'
}
// 미리보기 옆 "편집기로 열기" 가 여는 앱 이름
export function editorName(p) {
  const e = ext(p)
  if (['docx', 'odt'].includes(e)) return '이음오피스 문서'
  if (['xlsx', 'xls', 'csv'].includes(e)) return '이음오피스 시트'
  if (e === 'pptx') return '이음오피스 슬라이드'
  if (['hwp', 'hwpx'].includes(e)) return '이음오피스 한글'
  if (e === 'pdf') return '이음오피스 PDF'
  if (['dxf', 'dwg'].includes(e)) return 'CADCraft'
  if (e === 'svg') return 'VectorCraft'
  if (['psd', 'png', 'jpg', 'jpeg', 'webp'].includes(e)) return 'PhotoCraft'
  if (['wav', 'mp3', 'flac'].includes(e)) return 'SoundCraft'
  if (['mp4', 'mov', 'webm'].includes(e)) return 'FilmCraft'
  return ''
}

export function fmtSize(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// 줄 단위 차이(LCS). 작은 파일용.
export function lineDiff(a, b) {
  const A = String(a || '').replace(/\n$/, '').split('\n')
  const B = String(b || '').replace(/\n$/, '').split('\n')
  const n = A.length, m = B.length
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', a: i + 1, b: j + 1, s: A[i] }); i++; j++ }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ t: '-', a: i + 1, s: A[i] }); i++ }
    else { out.push({ t: '+', b: j + 1, s: B[j] }); j++ }
  }
  while (i < n) { out.push({ t: '-', a: i + 1, s: A[i] }); i++ }
  while (j < m) { out.push({ t: '+', b: j + 1, s: B[j] }); j++ }
  return out
}

// 아주 작은 코드 강조(파이썬·자바스크립트 정도). HTML 이스케이프 후 토큰을 감싼다.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const KW = /\b(def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|raise|None|True|False|const|let|var|function|async|await|export|new|this)\b/g
export function highlight(line) {
  const parts = []
  let rest = line
  // 주석
  const c = rest.search(/(#|\/\/)(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/)
  let comment = ''
  if (c >= 0) { comment = rest.slice(c); rest = rest.slice(0, c) }
  // 문자열
  const re = /(f?"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g
  let last = 0, m
  while ((m = re.exec(rest))) {
    parts.push(esc(rest.slice(last, m.index)).replace(KW, '<i class="k">$1</i>').replace(/\b(\d+)\b/g, '<i class="n">$1</i>'))
    parts.push(`<i class="s">${esc(m[0])}</i>`)
    last = m.index + m[0].length
  }
  parts.push(esc(rest.slice(last)).replace(KW, '<i class="k">$1</i>').replace(/\b(\d+)\b/g, '<i class="n">$1</i>'))
  if (comment) parts.push(`<i class="c">${esc(comment)}</i>`)
  return parts.join('')
}

export const parseCsv = (t) => String(t || '').trim().split('\n').map((r) => r.split(','))
