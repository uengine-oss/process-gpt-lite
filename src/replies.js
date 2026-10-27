// Quick replies: the short options an agent's question ends with ("- 네, 이대로 진행 (설명)")
// become tappable buttons (components/Message.vue). A report that merely has bullet lines — "카드
// •••• 4242를 자동으로 선택·입력했습니다" — is not a question and keeps its list.
//
// Buttons only when all of these hold:
//   - the answer ends with the list (nothing after it but blank lines), or with the list and one
//     short question line after it ("어느 쪽으로 할까요?")
//   - the question is asked right there: the line just before the list (or the one after it) ends
//     with "?" or asks to choose ("골라 주세요", "선택해 주세요", "알려 주세요")
//   - 2–4 options, each short (≤ 40 characters before an optional "(설명)") and not a finished
//     statement ("…했습니다", "…했어요")
const ASK = /([?？]\s*\**\s*$)|(골라|선택해|알려|정해)\s*주(세요|실래요|시겠어요)|중(에서)?\s*(무엇|어느|어떤)/
const STATEMENT = /(습니다|었어요|았어요|였어요|했어요|됐어요|돼요|입니다|이에요|예요)[.!。]?\s*$/
const MAX_LABEL = 40

export function parseReplies(text) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n')
  const isOpt = (l) => /^\s*[-*•]\s+\S/.test(l)
  let end = lines.length
  // one short question line may follow the list
  let after = null
  if (end && !isOpt(lines[end - 1]) && lines[end - 1].trim()) {
    after = lines[end - 1].trim()
    end--
  }
  if (!end || !isOpt(lines[end - 1])) return null
  let start = end
  while (start > 0 && isOpt(lines[start - 1])) start--
  const opts = lines.slice(start, end).map((l) => l.trim().replace(/^[-*•]\s+/, ''))
  if (opts.length < 2 || opts.length > 4) return null
  if (after && (after.length > 80 || !ASK.test(after))) return null
  let k = start - 1
  while (k >= 0 && !lines[k].trim()) k--
  const before = k >= 0 ? lines[k].trim() : ''
  if (!ASK.test(after || '') && !ASK.test(before)) return null
  const options = []
  for (const o of opts) {
    const m = /^(.+?)\s*\((.+)\)\s*$/.exec(o)
    const label = (m ? m[1] : o).replace(/\*\*/g, '').trim()
    if (!label || label.length > MAX_LABEL || STATEMENT.test(label)) return null
    options.push({ label, hint: m?.[2] })
  }
  return { body: [...lines.slice(0, start), ...(after ? [after] : [])].join('\n').trim(), options }
}
