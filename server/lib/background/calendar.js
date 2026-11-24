// 오늘의 배경 사진(lib/background): 날짜 · 시각 · 날씨를 계절 · 24절기 · 시간대 · 날씨 무리로 옮기는 정해진 계산.
// 사람의 글을 읽는 일이 아니라 달력과 날씨 코드의 표 계산이라 모델을 쓰지 않는다.
//   - 24절기: 태양의 겉보기 황경이 15°의 배수를 지나는 날(한국 표준시). 황경은 Meeus 의 간단식(오차 0.01° 안팎 — 15분 정도).
//     그날 24:00(KST)까지 지난 마디가 그날의 절기다. 춘분(0°)부터 15°마다 청명 · 곡우 … 경칩.
//   - 계절: 입춘 · 입하 · 입추 · 입동에서 시작하고, 절기 둘씩 묶어 이른/한창/늦은 때로 나눈다(초겨울 = 입동 · 소설).
//   - 시간대: 해의 고도(화면의 하늘이 이미 계산한 값)가 있으면 그것으로, 없으면 시각으로.
//   - 날씨: Open-Meteo 의 WMO 날씨 코드(화면의 하늘이 쓰는 그 값)를 맑음 · 구름 · 흐림 · 안개 · 비 · 눈 · 뇌우로.

export const TERMS = [
  // index 0 = 춘분(황경 0°). key 는 로마자, en 은 흔히 쓰는 영어 이름
  { key: 'chunbun', ko: '춘분', en: 'Spring Equinox' },
  { key: 'cheongmyeong', ko: '청명', en: 'Pure Brightness' },
  { key: 'gogu', ko: '곡우', en: 'Grain Rain' },
  { key: 'ipha', ko: '입하', en: 'Start of Summer' },
  { key: 'soman', ko: '소만', en: 'Grain Buds' },
  { key: 'mangjong', ko: '망종', en: 'Grain in Ear' },
  { key: 'haji', ko: '하지', en: 'Summer Solstice' },
  { key: 'soseo', ko: '소서', en: 'Minor Heat' },
  { key: 'daeseo', ko: '대서', en: 'Major Heat' },
  { key: 'ipchu', ko: '입추', en: 'Start of Autumn' },
  { key: 'cheoseo', ko: '처서', en: 'End of Heat' },
  { key: 'baengno', ko: '백로', en: 'White Dew' },
  { key: 'chubun', ko: '추분', en: 'Autumn Equinox' },
  { key: 'hallo', ko: '한로', en: 'Cold Dew' },
  { key: 'sanggang', ko: '상강', en: "Frost's Descent" },
  { key: 'ipdong', ko: '입동', en: 'Start of Winter' },
  { key: 'soseol', ko: '소설', en: 'Minor Snow' },
  { key: 'daeseol', ko: '대설', en: 'Major Snow' },
  { key: 'dongji', ko: '동지', en: 'Winter Solstice' },
  { key: 'sohan', ko: '소한', en: 'Minor Cold' },
  { key: 'daehan', ko: '대한', en: 'Major Cold' },
  { key: 'ipchun', ko: '입춘', en: 'Start of Spring' },
  { key: 'usu', ko: '우수', en: 'Rain Water' },
  { key: 'gyeongchip', ko: '경칩', en: 'Awakening of Insects' },
]

// 계절의 세 때: 절기 두 개씩. word 는 사진 검색에 쓰는 영어 계절 낱말
export const SEASONS = [
  { key: 'early-spring', ko: '이른 봄', en: 'early spring', word: 'spring', terms: ['ipchun', 'usu'] },
  { key: 'spring', ko: '봄', en: 'spring', word: 'spring', terms: ['gyeongchip', 'chunbun'] },
  { key: 'late-spring', ko: '늦봄', en: 'late spring', word: 'spring', terms: ['cheongmyeong', 'gogu'] },
  { key: 'early-summer', ko: '초여름', en: 'early summer', word: 'summer', terms: ['ipha', 'soman'] },
  { key: 'summer', ko: '여름', en: 'summer', word: 'summer', terms: ['mangjong', 'haji'] },
  { key: 'midsummer', ko: '한여름', en: 'midsummer', word: 'summer', terms: ['soseo', 'daeseo'] },
  { key: 'early-autumn', ko: '초가을', en: 'early autumn', word: 'autumn', terms: ['ipchu', 'cheoseo'] },
  { key: 'autumn', ko: '가을', en: 'autumn', word: 'autumn', terms: ['baengno', 'chubun'] },
  { key: 'late-autumn', ko: '늦가을', en: 'late autumn', word: 'autumn', terms: ['hallo', 'sanggang'] },
  { key: 'early-winter', ko: '초겨울', en: 'early winter', word: 'winter', terms: ['ipdong', 'soseol'] },
  { key: 'winter', ko: '겨울', en: 'winter', word: 'winter', terms: ['daeseol', 'dongji'] },
  { key: 'midwinter', ko: '한겨울', en: 'midwinter', word: 'winter', terms: ['sohan', 'daehan'] },
]

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const pad = (n) => String(n).padStart(2, '0')
// 'YYYY-MM-DD' → {y, m, d} (null when it is not a real calendar date)
export function parseDate(s) {
  const m = DATE.exec(String(s || ''))
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null
  return { y, m: mo, d }
}
export const fmtDate = (ms) => { const t = new Date(ms); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` }
export const addDays = (s, n) => { const p = parseDate(s); return fmtDate(Date.UTC(p.y, p.m - 1, p.d + n)) }
// the calendar date in Korea at this moment
export const kstDate = (ms = Date.now()) => fmtDate(ms + 9 * 3600_000)
// the end of a KST calendar day (24:00 KST = 15:00 UTC of the same date)
const endOfKstDay = (s) => { const p = parseDate(s); return Date.UTC(p.y, p.m - 1, p.d, 15, 0, 0) }

// The sun's apparent ecliptic longitude in degrees (0..360) at this instant (Meeus, Astronomical Algorithms ch. 25, low accuracy).
export function sunLongitude(ms) {
  const T = (ms / 86400000 + 2440587.5 - 2451545.0) / 36525
  const r = Math.PI / 180
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M * r) + (0.019993 - 0.000101 * T) * Math.sin(2 * M * r) + 0.000289 * Math.sin(3 * M * r)
  const omega = 125.04 - 1934.136 * T
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * r)
  return ((lambda % 360) + 360) % 360
}
const termIndexAt = (ms) => Math.floor(sunLongitude(ms) / 15) % 24

// The solar term of a KST calendar date: {key, ko, en, index, start (the date it began), today (it begins this date), next {…, start}}
export function solarTerm(date) {
  if (!parseDate(date)) throw new Error(`not a date: ${date}`)
  const index = termIndexAt(endOfKstDay(date))
  let start = date
  for (let i = 0; i < 20 && termIndexAt(endOfKstDay(addDays(start, -1))) === index; i++) start = addDays(start, -1)
  let next = addDays(date, 1)
  for (let i = 0; i < 20 && termIndexAt(endOfKstDay(next)) === index; i++) next = addDays(next, 1)
  const n = TERMS[(index + 1) % 24]
  return { ...TERMS[index], index, start, today: start === date, next: { ...n, start: next } }
}

export function seasonOf(termKey) {
  return SEASONS.find((s) => s.terms.includes(termKey)) || SEASONS[0]
}

// The part of the day: dawn · morning · day · evening · night. alt: the sun's altitude in degrees (the screen's sky has it), when known.
export const PARTS = {
  dawn: { ko: '새벽', en: 'dawn' }, morning: { ko: '아침', en: 'morning' }, day: { ko: '한낮', en: 'daytime' },
  evening: { ko: '해 질 녘', en: 'dusk' }, night: { ko: '밤', en: 'night' },
}
export function partOfDay(hour, alt = null) {
  const h = Number.isFinite(Number(hour)) ? ((Number(hour) % 24) + 24) % 24 : 12
  if (alt != null && Number.isFinite(Number(alt))) {
    const a = Number(alt)
    if (a < -8) return 'night'
    if (a < 8) return h < 12 ? 'dawn' : 'evening'
    return h < 11 ? 'morning' : 'day'
  }
  if (h >= 5 && h < 7) return 'dawn'
  if (h >= 7 && h < 11) return 'morning'
  if (h >= 11 && h < 17) return 'day'
  if (h >= 17 && h < 19) return 'evening'
  return 'night'
}

// WMO weather code (Open-Meteo) → the group a photo theme is picked for
export const WEATHER = {
  clear: { ko: '맑음', en: 'clear' }, partly: { ko: '구름 조금', en: 'partly cloudy' }, cloudy: { ko: '흐림', en: 'overcast' },
  fog: { ko: '안개', en: 'fog' }, rain: { ko: '비', en: 'rain' }, snow: { ko: '눈', en: 'snow' }, storm: { ko: '뇌우', en: 'thunderstorm' },
}
export function weatherGroup(code) {
  if (code == null || code === '' || !Number.isFinite(Number(code))) return null
  const c = Number(code)
  if (c === 0 || c === 1) return 'clear'
  if (c === 2) return 'partly'
  if (c === 3) return 'cloudy'
  if (c === 45 || c === 48) return 'fog'
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain'
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow'
  if (c >= 95) return 'storm'
  return 'cloudy'
}

// Everything about the day a theme is picked from.
export function dayOf({ date, hour = 12, alt = null, wx = null }) {
  const term = solarTerm(date)
  const season = seasonOf(term.key)
  return { date, term, season, part: partOfDay(hour, alt), weather: weatherGroup(wx) }
}
