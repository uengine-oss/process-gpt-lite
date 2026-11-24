// 오늘의 배경 사진: 그날(calendar.js 의 dayOf)과 주제표(skills/daily-background/rules.json)로 그날 찾을 주제의 차례를 정한다.
// 정해진 계산이다 — 같은 날 같은 조건이면 늘 같은 차례다(날짜에서 만든 씨앗).
//   차례(무드 없음): 절기 ① · 시간대 · 날씨 · 절기 ② · 계절 · 오늘의 사진 · 멋진 풍경 한 장
//   무드를 고르면: 그 무드의 주제 둘이 맨 앞, 그다음 그 무드가 붙은 주제, 나머지(오늘의 사진 · 멋진 풍경은 늘 끝)
export const MOODS = ['calm', 'warm', 'cool', 'lively']

// FNV-1a: a small stable number from a string (the day's order, the pick in a theme's results)
export function seedOf(s) {
  let h = 0x811c9dc5
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

const fill = (s, day, en) => String(s || '')
  .replace(/\{season\}/g, en ? day.season.en : day.season.ko)
  .replace(/\{word\}/g, day.season.word)
  .replace(/\{term\}/g, en ? day.term.en : day.term.ko)
  .replace(/\s+/g, ' ').trim()
// a theme of the plan: the label the screen shows under the photo and what is searched for it
function theme(kind, key, v, day, en) {
  const label = fill(en ? (v.label_en || v.label) : v.label, day, en)
  return {
    key, kind, label: en ? label.charAt(0).toUpperCase() + label.slice(1) : label,
    q: fill(v.q, day, en), cats: Array.isArray(v.cats) ? v.cats : [], keywords: fill(v.keywords || v.q || 'landscape', day, en),
    moods: (v.moods || []).filter((m) => MOODS.includes(m)), random: !!v.random,
  }
}

export function planDay(day, rules, { mood = null, en = false } = {}) {
  const seed = seedOf(day.date)
  const termVs = rules.terms?.[day.term.key] || []
  // two of the term's variants, the day's turn first
  const term = [0, 1].slice(0, Math.min(2, termVs.length)).map((k) => (seed + k) % termVs.length)
    .map((i) => theme('term', `term:${day.term.key}:${i}`, termVs[i], day, en))
  const part = rules.parts?.[day.part] ? theme('part', `part:${day.season.key}:${day.part}`, rules.parts[day.part], day, en) : null
  const wx = day.weather && rules.weather?.[day.weather] ? theme('weather', `weather:${day.weather}:${day.season.word}`, rules.weather[day.weather], day, en) : null
  const seasonVs = rules.seasons?.[day.season.key] || []
  const season = seasonVs.length ? theme('season', `season:${day.season.key}:${seed % seasonVs.length}`, seasonVs[seed % seasonVs.length], day, en) : null
  let themes = [term[0], part, wx, term[1], season].filter(Boolean)
  if (mood && MOODS.includes(mood) && rules.moods?.[mood]) {
    const own = rules.moods[mood].map((v, i) => theme('mood', `mood:${mood}:${i}:${day.season.word}`, v, day, en))
    themes = [...own, ...themes.filter((t) => t.moods.includes(mood)), ...themes.filter((t) => !t.moods.includes(mood))]
  }
  if (rules.potd) themes.push({ key: 'potd', kind: 'potd', label: en ? rules.potd.label_en || rules.potd.label : rules.potd.label, olderLabel: en ? rules.potd.olderLabel_en || rules.potd.olderLabel : rules.potd.olderLabel, moods: [] })
  if (rules.landscape) themes.push({ ...theme('landscape', 'landscape', rules.landscape, day, en), random: true })
  return themes
}
